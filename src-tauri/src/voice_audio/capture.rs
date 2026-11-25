use crate::audio_ducking::{probe_microphone_privacy_status, MicrophoneAccessDiagnostic};
use crate::voice_audio::resampler::{
    compute_pcm16_rms, encode_pcm16_wav, resample_f32_to_pcm16_mono,
};
use crate::voice_audio::ring_buffer::Pcm16RingBuffer;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::Emitter;
use tokio::sync::broadcast;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAudioInputDevice {
    pub id: String,
    pub name: String,
    pub is_default: bool,
    pub sample_rate: u32,
    pub channels: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCaptureStatus {
    pub active: bool,
    pub device_name: Option<String>,
    pub sample_rate: u32,
    pub buffered_samples: usize,
    pub level: f32,
    pub privacy: MicrophoneAccessDiagnostic,
}

struct CaptureControl {
    stop_flag: Arc<AtomicBool>,
    ring_buffer: Arc<Mutex<Pcm16RingBuffer>>,
    frame_tx: broadcast::Sender<Vec<i16>>,
    device_name: Arc<Mutex<Option<String>>>,
    target_sample_rate: u32,
    last_level_bits: Arc<AtomicU32>,
    join_handle: Option<std::thread::JoinHandle<()>>,
}

static ACTIVE_CAPTURE: OnceLock<Mutex<Option<CaptureControl>>> = OnceLock::new();

fn capture_slot() -> &'static Mutex<Option<CaptureControl>> {
    ACTIVE_CAPTURE.get_or_init(|| Mutex::new(None))
}

pub fn list_input_devices() -> Vec<NativeAudioInputDevice> {
    let host = cpal::default_host();
    let default_name = host
        .default_input_device()
        .and_then(|d| d.name().ok());
    let Ok(devices) = host.input_devices() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (idx, dev) in devices.enumerate() {
        let name = dev
            .name()
            .unwrap_or_else(|_| format!("Microphone {}", idx + 1));
        let is_default = default_name.as_deref() == Some(name.as_str());
        let (sample_rate, channels) = dev
            .default_input_config()
            .map(|c| (c.sample_rate().0, c.channels()))
            .unwrap_or((16000, 1));
        out.push(NativeAudioInputDevice {
            id: format!("wasapi:{}", name),
            name,
            is_default,
            sample_rate,
            channels,
        });
    }
    out
}

fn select_cpal_input_device(preferred_id: Option<&str>) -> Result<cpal::Device, String> {
    let host = cpal::default_host();
    if let Some(pref) = preferred_id.map(str::trim).filter(|s| !s.is_empty() && *s != "automatic" && *s != "default") {
        let clean = pref.strip_prefix("wasapi:").unwrap_or(pref);
        if let Ok(mut devices) = host.input_devices() {
            if let Some(found) = devices.find(|d| {
                d.name()
                    .map(|n| n == clean || n.eq_ignore_ascii_case(clean))
                    .unwrap_or(false)
            }) {
                return Ok(found);
            }
        }
    }
    host.default_input_device()
        .ok_or_else(|| "No default audio input device available.".to_string())
}

fn build_device_stream(
    device: &cpal::Device,
    target_rate: u32,
    ring_buffer: Arc<Mutex<Pcm16RingBuffer>>,
    frame_tx: broadcast::Sender<Vec<i16>>,
    last_level_bits: Arc<AtomicU32>,
    lost_flag: Arc<AtomicBool>,
) -> Result<(cpal::Stream, String), String> {
    let dev_name = device.name().unwrap_or_else(|_| "Default Microphone".to_string());
    let supported = device
        .default_input_config()
        .map_err(|e| format!("Failed to read input config: {e}"))?;
    let src_rate = supported.sample_rate().0;
    let src_channels = supported.channels();
    let sample_format = supported.sample_format();
    let stream_config: cpal::StreamConfig = supported.into();

    let last_emit = Arc::new(Mutex::new(Instant::now() - Duration::from_millis(100)));

    let emit_samples = {
        let ring_buffer = Arc::clone(&ring_buffer);
        let frame_tx = frame_tx.clone();
        let last_level_bits = Arc::clone(&last_level_bits);
        let last_emit = Arc::clone(&last_emit);
        move |mono_f32: &[f32]| {
            let pcm16 = resample_f32_to_pcm16_mono(mono_f32, src_rate, src_channels, target_rate);
            if pcm16.is_empty() {
                return;
            }
            let rms = compute_pcm16_rms(&pcm16);
            let level = (rms * 3.5).clamp(0.0, 1.0);
            last_level_bits.store(level.to_bits(), Ordering::Relaxed);

            if let Ok(mut rb) = ring_buffer.lock() {
                rb.push_slice(&pcm16);
            }
            let _ = frame_tx.send(pcm16);

            let should_emit = if let Ok(mut ts) = last_emit.lock() {
                if ts.elapsed() >= Duration::from_millis(33) {
                    *ts = Instant::now();
                    true
                } else {
                    false
                }
            } else {
                false
            };

            if should_emit {
                if let Some(handle) = crate::get_app_handle() {
                    let _ = handle.emit(
                        "voice:audio-level",
                        serde_json::json!({
                            "level": level,
                            "rms": rms,
                            "sampleRate": target_rate
                        }),
                    );
                }
            }
        }
    };

    let err_flag = Arc::clone(&lost_flag);
    let err_cb = move |err: cpal::StreamError| {
        eprintln!("[voice_audio] Capture stream error (hot-swap check): {err}");
        err_flag.store(true, Ordering::SeqCst);
        if let Some(handle) = crate::get_app_handle() {
            let _ = handle.emit("voice:device-lost", serde_json::json!({ "error": err.to_string() }));
        }
    };

    let stream = match sample_format {
        cpal::SampleFormat::F32 => device
            .build_input_stream(
                &stream_config,
                move |data: &[f32], _| emit_samples(data),
                err_cb,
                None,
            )
            .map_err(|e| format!("build_input_stream(f32) failed: {e}"))?,
        cpal::SampleFormat::I16 => device
            .build_input_stream(
                &stream_config,
                move |data: &[i16], _| {
                    let converted: Vec<f32> = data.iter().map(|&s| s as f32 / 32768.0).collect();
                    emit_samples(&converted);
                },
                err_cb,
                None,
            )
            .map_err(|e| format!("build_input_stream(i16) failed: {e}"))?,
        cpal::SampleFormat::U16 => device
            .build_input_stream(
                &stream_config,
                move |data: &[u16], _| {
                    let converted: Vec<f32> =
                        data.iter().map(|&s| (s as f32 - 32768.0) / 32768.0).collect();
                    emit_samples(&converted);
                },
                err_cb,
                None,
            )
            .map_err(|e| format!("build_input_stream(u16) failed: {e}"))?,
        other => {
            return Err(format!("Unsupported capture sample format: {other:?}"));
        }
    };

    stream
        .play()
        .map_err(|e| format!("Failed to start capture stream: {e}"))?;
    Ok((stream, dev_name))
}

pub fn start_capture(
    device_id: Option<String>,
    target_sample_rate: u32,
) -> Result<broadcast::Receiver<Vec<i16>>, String> {
    let privacy = probe_microphone_privacy_status();
    if !privacy.available {
        return Err(privacy.message_es);
    }

    stop_capture();

    let safe_rate = if target_sample_rate == 24000 { 24000 } else { 16000 };
    let ring_buffer = Arc::new(Mutex::new(Pcm16RingBuffer::new(safe_rate, 30)));
    let (frame_tx, frame_rx) = broadcast::channel::<Vec<i16>>(128);
    let stop_flag = Arc::new(AtomicBool::new(false));
    let device_name = Arc::new(Mutex::new(None));
    let last_level_bits = Arc::new(AtomicU32::new(0.0f32.to_bits()));

    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();

    let thread_stop = Arc::clone(&stop_flag);
    let thread_rb = Arc::clone(&ring_buffer);
    let thread_tx = frame_tx.clone();
    let thread_dev_name = Arc::clone(&device_name);
    let thread_level = Arc::clone(&last_level_bits);
    let preferred = device_id.clone();

    let join_handle = std::thread::Builder::new()
        .name("kite-voice-capture".to_string())
        .spawn(move || {
            let lost_flag = Arc::new(AtomicBool::new(false));
            let initial_dev = match select_cpal_input_device(preferred.as_deref()) {
                Ok(d) => d,
                Err(err) => {
                    let _ = ready_tx.send(Err(err));
                    return;
                }
            };
            let (mut _stream, name) = match build_device_stream(
                &initial_dev,
                safe_rate,
                Arc::clone(&thread_rb),
                thread_tx.clone(),
                Arc::clone(&thread_level),
                Arc::clone(&lost_flag),
            ) {
                Ok(res) => res,
                Err(err) => {
                    let _ = ready_tx.send(Err(err));
                    return;
                }
            };
            if let Ok(mut guard) = thread_dev_name.lock() {
                *guard = Some(name);
            }
            let _ = ready_tx.send(Ok(()));

            while !thread_stop.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_millis(50));
                if lost_flag.swap(false, Ordering::SeqCst) && !thread_stop.load(Ordering::Relaxed) {
                    // Attempt hot-swap recovery to default input device
                    if let Ok(fallback_dev) = select_cpal_input_device(None) {
                        if let Ok((new_stream, new_name)) = build_device_stream(
                            &fallback_dev,
                            safe_rate,
                            Arc::clone(&thread_rb),
                            thread_tx.clone(),
                            Arc::clone(&thread_level),
                            Arc::clone(&lost_flag),
                        ) {
                            _stream = new_stream;
                            if let Ok(mut guard) = thread_dev_name.lock() {
                                *guard = Some(new_name);
                            }
                        }
                    }
                }
            }
        })
        .map_err(|e| format!("Failed to spawn capture thread: {e}"))?;

    match ready_rx.recv_timeout(Duration::from_secs(3)) {
        Ok(Ok(())) => {}
        Ok(Err(err)) => {
            stop_flag.store(true, Ordering::SeqCst);
            let _ = join_handle.join();
            return Err(err);
        }
        Err(_) => {
            stop_flag.store(true, Ordering::SeqCst);
            let _ = join_handle.join();
            return Err("Timed out initializing native audio capture.".to_string());
        }
    }

    let mut slot = capture_slot().lock().unwrap();
    *slot = Some(CaptureControl {
        stop_flag,
        ring_buffer,
        frame_tx,
        device_name,
        target_sample_rate: safe_rate,
        last_level_bits,
        join_handle: Some(join_handle),
    });

    Ok(frame_rx)
}

pub fn subscribe_capture_frames() -> Option<broadcast::Receiver<Vec<i16>>> {
    let slot = capture_slot().lock().unwrap();
    slot.as_ref().map(|c| c.frame_tx.subscribe())
}

pub fn drain_captured_pcm16() -> (Vec<i16>, u32) {
    let slot = capture_slot().lock().unwrap();
    if let Some(ctrl) = slot.as_ref() {
        let samples = ctrl
            .ring_buffer
            .lock()
            .map(|mut rb| rb.drain_all())
            .unwrap_or_default();
        return (samples, ctrl.target_sample_rate);
    }
    (Vec::new(), 16000)
}

pub fn stop_capture_and_export_wav() -> Option<Vec<u8>> {
    let mut ctrl = {
        let mut slot = capture_slot().lock().unwrap();
        slot.take()
    }?;
    ctrl.stop_flag.store(true, Ordering::SeqCst);
    if let Some(handle) = ctrl.join_handle.take() {
        let _ = handle.join();
    }
    let samples = ctrl
        .ring_buffer
        .lock()
        .map(|mut rb| rb.drain_all())
        .unwrap_or_default();
    if samples.is_empty() {
        return None;
    }
    Some(encode_pcm16_wav(&samples, ctrl.target_sample_rate))
}

pub fn stop_capture() {
    let _ = stop_capture_and_export_wav();
}

pub fn get_capture_status() -> NativeCaptureStatus {
    let privacy = probe_microphone_privacy_status();
    let slot = capture_slot().lock().unwrap();
    if let Some(ctrl) = slot.as_ref() {
        let buffered = ctrl.ring_buffer.lock().map(|rb| rb.len()).unwrap_or(0);
        let device_name = ctrl.device_name.lock().ok().and_then(|g| g.clone());
        let level = f32::from_bits(ctrl.last_level_bits.load(Ordering::Relaxed));
        NativeCaptureStatus {
            active: true,
            device_name,
            sample_rate: ctrl.target_sample_rate,
            buffered_samples: buffered,
            level,
            privacy,
        }
    } else {
        NativeCaptureStatus {
            active: false,
            device_name: None,
            sample_rate: 16000,
            buffered_samples: 0,
            level: 0.0,
            privacy,
        }
    }
}
