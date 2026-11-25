use crate::audio_ducking::{probe_microphone_privacy_status, MicrophoneAccessDiagnostic};
use crate::voice_audio::resampler::{encode_pcm16_wav, resample_f32_to_pcm16_mono};
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

#[derive(Debug)]
pub struct SpeechTurnBuffer {
    pub ring_buffer: Pcm16RingBuffer,
    pub speech_pcm: Vec<i16>,
    pub speech_open: bool,
    pub sample_rate: u32,
}

impl SpeechTurnBuffer {
    pub fn new(sample_rate: u32) -> Self {
        let safe_rate = if sample_rate == 24000 { 24000 } else { 16000 };
        Self {
            ring_buffer: Pcm16RingBuffer::new(safe_rate, 30),
            speech_pcm: Vec::new(),
            speech_open: false,
            sample_rate: safe_rate,
        }
    }

    pub fn record_incoming(&mut self, pcm16: &[i16], muted: bool) {
        if muted || pcm16.is_empty() {
            return;
        }
        self.ring_buffer.push_slice(pcm16);
        if self.speech_open {
            let max_samples = (self.sample_rate as usize) * 60;
            if self.speech_pcm.len() < max_samples {
                let take = pcm16.len().min(max_samples - self.speech_pcm.len());
                self.speech_pcm.extend_from_slice(&pcm16[..take]);
            }
        }
    }

    pub fn mark_speech_start(&mut self, pre_roll_ms: u32) -> Vec<i16> {
        if self.speech_open {
            return Vec::new();
        }
        self.speech_open = true;
        self.speech_pcm.clear();
        let clamped_ms = pre_roll_ms.clamp(100, 2000);
        let pre_roll = self.ring_buffer.peek_last_ms(clamped_ms);
        self.speech_pcm.extend_from_slice(&pre_roll);
        pre_roll
    }

    pub fn reset_turn(&mut self, clear_ring: bool) {
        self.speech_open = false;
        self.speech_pcm.clear();
        if clear_ring {
            self.ring_buffer.clear();
        }
    }

    pub fn finish_turn(
        &mut self,
        discard: bool,
        trim_trailing_ms: u32,
        fallback_ring_when_unopened: bool,
    ) -> Option<Vec<i16>> {
        let was_open = self.speech_open;
        self.speech_open = false;
        let mut samples = std::mem::take(&mut self.speech_pcm);
        if discard {
            return None;
        }
        if samples.is_empty() && (!was_open && fallback_ring_when_unopened) {
            samples = self.ring_buffer.drain_all();
        } else {
            self.ring_buffer.clear();
        }
        if samples.is_empty() {
            return None;
        }
        if trim_trailing_ms > 0 {
            let trim_samples = ((self.sample_rate as u64 * trim_trailing_ms as u64) / 1000) as usize;
            let min_keep = ((self.sample_rate as usize * 300) / 1000).min(samples.len());
            if samples.len() > min_keep {
                let max_removable = samples.len() - min_keep;
                let remove = trim_samples.min(max_removable);
                samples.truncate(samples.len() - remove);
            }
        }
        Some(samples)
    }
}

struct CaptureControl {
    stop_flag: Arc<AtomicBool>,
    muted: Arc<AtomicBool>,
    turn_buffer: Arc<Mutex<SpeechTurnBuffer>>,
    frame_tx: broadcast::Sender<Vec<i16>>,
    device_name: Arc<Mutex<Option<String>>>,
    device_pref: Option<String>,
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
    muted: Arc<AtomicBool>,
    turn_buffer: Arc<Mutex<SpeechTurnBuffer>>,
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

    let emit_acc = Arc::new(Mutex::new((Instant::now() - Duration::from_millis(40), 0.0f64, 0usize)));

    let emit_samples = {
        let muted = Arc::clone(&muted);
        let turn_buffer = Arc::clone(&turn_buffer);
        let frame_tx = frame_tx.clone();
        let last_level_bits = Arc::clone(&last_level_bits);
        let emit_acc = Arc::clone(&emit_acc);
        move |mono_f32: &[f32]| {
            let is_muted = muted.load(Ordering::Relaxed);
            if is_muted {
                last_level_bits.store(0.0f32.to_bits(), Ordering::Relaxed);
                return;
            }
            let pcm16 = resample_f32_to_pcm16_mono(mono_f32, src_rate, src_channels, target_rate);
            if pcm16.is_empty() {
                return;
            }
            if let Ok(mut tb) = turn_buffer.lock() {
                tb.record_incoming(&pcm16, false);
            }
            let _ = frame_tx.send(pcm16.clone());

            let emit_payload = if let Ok(mut acc) = emit_acc.lock() {
                for &s in &pcm16 {
                    let norm = s as f64 / 32768.0;
                    acc.1 += norm * norm;
                }
                acc.2 += pcm16.len();
                let elapsed_ms = acc.0.elapsed().as_millis() as u64;
                if elapsed_ms >= 33 && acc.2 > 0 {
                    let rms = ((acc.1 / acc.2 as f64).sqrt() as f32).clamp(0.0, 1.0);
                    let level = (rms * 3.5).clamp(0.0, 1.0);
                    last_level_bits.store(level.to_bits(), Ordering::Relaxed);
                    acc.0 = Instant::now();
                    acc.1 = 0.0;
                    acc.2 = 0;
                    Some((level, rms, elapsed_ms.clamp(10, 200)))
                } else {
                    None
                }
            } else {
                None
            };

            if let Some((level, rms, duration_ms)) = emit_payload {
                if let Some(handle) = crate::get_app_handle() {
                    let _ = handle.emit(
                        "voice:audio-level",
                        serde_json::json!({
                            "level": level,
                            "rms": rms,
                            "durationMs": duration_ms,
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
    let turn_buffer = Arc::new(Mutex::new(SpeechTurnBuffer::new(safe_rate)));
    let (frame_tx, frame_rx) = broadcast::channel::<Vec<i16>>(128);
    let stop_flag = Arc::new(AtomicBool::new(false));
    let muted = Arc::new(AtomicBool::new(false));
    let device_name = Arc::new(Mutex::new(None));
    let last_level_bits = Arc::new(AtomicU32::new(0.0f32.to_bits()));

    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();

    let thread_stop = Arc::clone(&stop_flag);
    let thread_muted = Arc::clone(&muted);
    let thread_tb = Arc::clone(&turn_buffer);
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
                Arc::clone(&thread_muted),
                Arc::clone(&thread_tb),
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
                    if let Ok(fallback_dev) = select_cpal_input_device(None) {
                        if let Ok((new_stream, new_name)) = build_device_stream(
                            &fallback_dev,
                            safe_rate,
                            Arc::clone(&thread_muted),
                            Arc::clone(&thread_tb),
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
        muted,
        turn_buffer,
        frame_tx,
        device_name,
        device_pref: device_id,
        target_sample_rate: safe_rate,
        last_level_bits,
        join_handle: Some(join_handle),
    });

    Ok(frame_rx)
}

pub fn ensure_capture_started(
    device_id: Option<String>,
    target_sample_rate: u32,
    keep_existing: bool,
    from_barge_in: bool,
) -> Result<(broadcast::Receiver<Vec<i16>>, Vec<i16>), String> {
    let safe_rate = if target_sample_rate == 24000 { 24000 } else { 16000 };
    if keep_existing {
        let slot = capture_slot().lock().unwrap();
        if let Some(ctrl) = slot.as_ref() {
            let same_rate = ctrl.target_sample_rate == safe_rate;
            let same_pref = match (&device_id, &ctrl.device_pref) {
                (None, _) => true,
                (Some(req), _) if req == "automatic" || req == "default" => true,
                (Some(req), Some(cur)) => req.eq_ignore_ascii_case(cur),
                _ => false,
            };
            if same_rate && same_pref && !ctrl.stop_flag.load(Ordering::Relaxed) {
                ctrl.muted.store(false, Ordering::SeqCst);
                let pre_roll = if let Ok(mut tb) = ctrl.turn_buffer.lock() {
                    tb.reset_turn(false);
                    if from_barge_in {
                        tb.mark_speech_start(400)
                    } else {
                        Vec::new()
                    }
                } else {
                    Vec::new()
                };
                return Ok((ctrl.frame_tx.subscribe(), pre_roll));
            }
        }
    }

    let rx = start_capture(device_id, safe_rate)?;
    let pre_roll = if from_barge_in {
        mark_speech_start(400)
    } else {
        Vec::new()
    };
    Ok((rx, pre_roll))
}

pub fn mark_speech_start(pre_roll_ms: u32) -> Vec<i16> {
    let slot = capture_slot().lock().unwrap();
    let Some(ctrl) = slot.as_ref() else {
        return Vec::new();
    };
    let out = if let Ok(mut tb) = ctrl.turn_buffer.lock() {
        tb.mark_speech_start(pre_roll_ms)
    } else {
        Vec::new()
    };
    out
}

pub fn set_capture_muted(muted: bool) {
    let slot = capture_slot().lock().unwrap();
    if let Some(ctrl) = slot.as_ref() {
        ctrl.muted.store(muted, Ordering::SeqCst);
        if muted {
            ctrl.last_level_bits.store(0.0f32.to_bits(), Ordering::Relaxed);
        } else if let Ok(mut tb) = ctrl.turn_buffer.lock() {
            tb.reset_turn(true);
        }
    }
}

pub fn subscribe_capture_frames() -> Option<broadcast::Receiver<Vec<i16>>> {
    let slot = capture_slot().lock().unwrap();
    slot.as_ref().map(|c| c.frame_tx.subscribe())
}

pub fn drain_captured_pcm16() -> (Vec<i16>, u32) {
    let slot = capture_slot().lock().unwrap();
    if let Some(ctrl) = slot.as_ref() {
        let samples = ctrl
            .turn_buffer
            .lock()
            .map(|mut tb| tb.ring_buffer.drain_all())
            .unwrap_or_default();
        return (samples, ctrl.target_sample_rate);
    }
    (Vec::new(), 16000)
}

pub fn finish_capture_turn(keep_alive: bool, discard: bool, trim_trailing_ms: u32) -> Option<Vec<u8>> {
    if !keep_alive {
        let mut ctrl = {
            let mut slot = capture_slot().lock().unwrap();
            slot.take()
        }?;
        ctrl.stop_flag.store(true, Ordering::SeqCst);
        if let Some(handle) = ctrl.join_handle.take() {
            let _ = handle.join();
        }
        let samples = ctrl
            .turn_buffer
            .lock()
            .ok()
            .and_then(|mut tb| tb.finish_turn(discard, trim_trailing_ms, true))?;
        return Some(encode_pcm16_wav(&samples, ctrl.target_sample_rate));
    }

    let slot = capture_slot().lock().unwrap();
    let ctrl = slot.as_ref()?;
    let samples = ctrl
        .turn_buffer
        .lock()
        .ok()
        .and_then(|mut tb| tb.finish_turn(discard, trim_trailing_ms, false))?;
    Some(encode_pcm16_wav(&samples, ctrl.target_sample_rate))
}

pub fn stop_capture_and_export_wav() -> Option<Vec<u8>> {
    finish_capture_turn(false, false, 0)
}

pub fn stop_capture() {
    let _ = finish_capture_turn(false, true, 0);
}

pub fn get_capture_status() -> NativeCaptureStatus {
    let privacy = probe_microphone_privacy_status();
    let slot = capture_slot().lock().unwrap();
    if let Some(ctrl) = slot.as_ref() {
        let buffered = ctrl
            .turn_buffer
            .lock()
            .map(|tb| tb.speech_pcm.len().max(tb.ring_buffer.len()))
            .unwrap_or(0);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn speech_turn_buffer_extracts_preroll_respects_mute_and_trims_trailing() {
        let mut tb = SpeechTurnBuffer::new(16000);
        // Push 1s of ambient noise while speech gate is closed
        let ambient: Vec<i16> = (0..16000).map(|i| (i % 10) as i16).collect();
        tb.record_incoming(&ambient, false);
        assert!(!tb.speech_open);
        assert!(tb.speech_pcm.is_empty());

        // Muted frames must be ignored
        tb.record_incoming(&[999, 888, 777], true);
        assert_eq!(tb.ring_buffer.peek_last_samples(1)[0], 9);

        // Open speech gate -> 400ms (6400 samples) pre-roll captured into speech_pcm
        let pre_roll = tb.mark_speech_start(400);
        assert_eq!(pre_roll.len(), 6400);
        assert_eq!(tb.speech_pcm.len(), 6400);

        // Record 1s of speech
        let speech = vec![1200i16; 16000];
        tb.record_incoming(&speech, false);
        assert_eq!(tb.speech_pcm.len(), 22400);

        // Trim 500ms (8000 samples) trailing endpointing silence
        let finished = tb.finish_turn(false, 500, false).expect("wav samples");
        assert_eq!(finished.len(), 14400);
        assert!(!tb.speech_open);
        assert!(tb.speech_pcm.is_empty());
    }

    #[test]
    fn speech_turn_buffer_discard_returns_none_and_resets_state() {
        let mut tb = SpeechTurnBuffer::new(16000);
        tb.record_incoming(&vec![50i16; 8000], false);
        let _ = tb.mark_speech_start(200);
        tb.record_incoming(&vec![500i16; 4000], false);
        assert!(tb.finish_turn(true, 0, true).is_none());
        assert!(!tb.speech_open);
        assert!(tb.speech_pcm.is_empty());
    }
}
