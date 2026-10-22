//! Audio ducking and Zen sound cues for Kite Code Assistant.
//! - Smooth Windows master audio ducking via WASAPI (Core Audio Endpoints) to 20%
//! - Ethereal singing bowl Zen chime on recording start and end via PlaySoundW

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

#[cfg(windows)]
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
#[cfg(windows)]
use windows::Win32::Media::Audio::{
    eMultimedia, eRender, IMMDeviceEnumerator, MMDeviceEnumerator,
};
#[cfg(windows)]
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
};

#[cfg(windows)]
#[link(name = "winmm")]
extern "system" {
    fn PlaySoundW(psz_sound: *const u8, hmod: isize, fdw_sound: u32) -> i32;
}

#[cfg(windows)]
const SND_ASYNC: u32 = 0x0001;
#[cfg(windows)]
const SND_NODEFAULT: u32 = 0x0002;
#[cfg(windows)]
const SND_MEMORY: u32 = 0x0004;

static IS_DUCKED: AtomicBool = AtomicBool::new(false);
static ORIGINAL_VOLUME: Mutex<Option<f32>> = Mutex::new(None);
static TRANSITION_GEN: AtomicU32 = AtomicU32::new(0);
static LAST_RECORDING_STATE: AtomicBool = AtomicBool::new(false);

static CUE_CACHE: Mutex<Option<HashMap<bool, Vec<u8>>>> = Mutex::new(None);

/// Builds a standard 44-byte WAV container around 16-bit mono PCM samples.
fn pcm_to_wav(pcm_samples: &[i16], sample_rate: u32) -> Vec<u8> {
    let subchunk2_size = (pcm_samples.len() * 2) as u32;
    let chunk_size = 36 + subchunk2_size;
    let mut wav = Vec::with_capacity(44 + subchunk2_size as usize);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&chunk_size.to_le_bytes());
    wav.extend_from_slice(b"WAVE");
    wav.extend_from_slice(b"fmt ");
    wav.extend_from_slice(&16u32.to_le_bytes()); // PCM chunk size
    wav.extend_from_slice(&1u16.to_le_bytes());  // Audio format 1 = PCM
    wav.extend_from_slice(&1u16.to_le_bytes());  // Mono (1 channel)
    wav.extend_from_slice(&sample_rate.to_le_bytes());
    let byte_rate = sample_rate * 2;
    wav.extend_from_slice(&byte_rate.to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());  // Block align (channels * 2)
    wav.extend_from_slice(&16u16.to_le_bytes()); // Bits per sample
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&subchunk2_size.to_le_bytes());
    for s in pcm_samples {
        wav.extend_from_slice(&s.to_le_bytes());
    }
    wav
}

/// Generates the ethereal singing bowl "Zen" sound cues.
/// Start cue: F4 (349.23 Hz) + C5 (523.25 Hz)
/// Stop cue: G4 (392.00 Hz) + D5 (587.33 Hz)
pub fn generate_zen_wav(start_cue: bool) -> Vec<u8> {
    let sample_rate = 44100u32;
    let duration_secs = 0.22f32;
    let num_samples = (sample_rate as f32 * duration_secs) as usize;
    let mut samples = Vec::with_capacity(num_samples);

    let (f1, f2) = if start_cue {
        (349.23f32, 523.25f32) // F4 + C5
    } else {
        (392.00f32, 587.33f32) // G4 + D5
    };

    for i in 0..num_samples {
        let t = i as f32 / sample_rate as f32;
        let attack = (t / 0.025f32).min(1.0);
        let decay = (-t * 12.0f32).exp();
        let tone = (2.0f32 * std::f32::consts::PI * f1 * t).sin()
            + 0.5f32 * (2.0f32 * std::f32::consts::PI * f2 * t).sin();
        let amp = 0.16f32 * attack * decay * tone;
        samples.push((amp * 32767.0f32).clamp(-32768.0, 32767.0) as i16);
    }

    pcm_to_wav(&samples, sample_rate)
}

/// Plays the Zen audio cue asynchronously without blocking the caller.
pub fn play_cue_sound(start: bool) {
    #[cfg(windows)]
    {
        let mut cache_guard = CUE_CACHE.lock().unwrap();
        if cache_guard.is_none() {
            *cache_guard = Some(HashMap::new());
        }

        let map = cache_guard.as_mut().unwrap();
        if !map.contains_key(&start) {
            let wav = generate_zen_wav(start);
            map.insert(start, wav);
        }

        if let Some(bytes) = map.get(&start) {
            unsafe {
                PlaySoundW(
                    bytes.as_ptr(),
                    0,
                    SND_MEMORY | SND_ASYNC | SND_NODEFAULT,
                );
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = start;
    }
}

#[cfg(windows)]
unsafe fn get_master_endpoint_volume() -> Result<IAudioEndpointVolume, String> {
    let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    let enumerator: IMMDeviceEnumerator =
        CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
            .map_err(|e| format!("IMMDeviceEnumerator failed: {e}"))?;
    let device = enumerator
        .GetDefaultAudioEndpoint(eRender, eMultimedia)
        .map_err(|e| format!("GetDefaultAudioEndpoint failed: {e}"))?;
    let endpoint_volume: IAudioEndpointVolume = device
        .Activate(CLSCTX_ALL, None)
        .map_err(|e| format!("Activate IAudioEndpointVolume failed: {e}"))?;
    Ok(endpoint_volume)
}

/// Smoothly ducks master volume down to `target_ratio` (0.20 by default)
/// over approximately 90ms.
pub fn duck_audio(target_ratio: f32) {
    #[cfg(windows)]
    {
        let gen = TRANSITION_GEN.fetch_add(1, Ordering::SeqCst) + 1;

        thread::spawn(move || {
            unsafe {
                let endpoint_volume = match get_master_endpoint_volume() {
                    Ok(ep) => ep,
                    Err(err) => {
                        eprintln!("[audio_ducking] duck_audio failed: {err}");
                        return;
                    }
                };

                let current_vol = match endpoint_volume.GetMasterVolumeLevelScalar() {
                    Ok(v) => v,
                    Err(err) => {
                        eprintln!("[audio_ducking] GetMasterVolumeLevelScalar failed: {err}");
                        return;
                    }
                };

                let stored_now = {
                    let mut orig_lock = ORIGINAL_VOLUME.lock().unwrap();
                    if orig_lock.is_none() {
                        // Already near silence and we never saved a level: don't invent one.
                        if current_vol <= 0.05 {
                            return;
                        }
                        *orig_lock = Some(current_vol);
                        true
                    } else {
                        false
                    }
                };

                // A restore can win before we write a lower volume. Abort without ducking.
                if TRANSITION_GEN.load(Ordering::SeqCst) != gen {
                    if stored_now {
                        let mut orig_lock = ORIGINAL_VOLUME.lock().unwrap();
                        if *orig_lock == Some(current_vol) {
                            *orig_lock = None;
                        }
                    }
                    return;
                }

                let base_vol = {
                    let orig_lock = ORIGINAL_VOLUME.lock().unwrap();
                    orig_lock.unwrap_or(current_vol)
                };

                IS_DUCKED.store(true, Ordering::SeqCst);

                let target_vol = (base_vol * target_ratio).clamp(0.0, 1.0);
                let steps = 6;
                let step_delay = Duration::from_millis(15);

                for i in 1..=steps {
                    if TRANSITION_GEN.load(Ordering::SeqCst) != gen {
                        break;
                    }
                    let t = i as f32 / steps as f32;
                    let v = current_vol + (target_vol - current_vol) * t;
                    let _ = endpoint_volume.SetMasterVolumeLevelScalar(v, std::ptr::null());
                    thread::sleep(step_delay);
                }

                CoUninitialize();
            }
        });
    }
    #[cfg(not(windows))]
    {
        let _ = target_ratio;
    }
}

/// Smoothly restores master volume back to original level over approximately 90ms.
pub fn restore_audio() {
    #[cfg(windows)]
    {
        let gen = TRANSITION_GEN.fetch_add(1, Ordering::SeqCst) + 1;

        thread::spawn(move || {
            unsafe {
                let orig_vol = {
                    let mut orig_lock = ORIGINAL_VOLUME.lock().unwrap();
                    orig_lock.take()
                };

                let target_vol = match orig_vol {
                    Some(v) => v,
                    None => {
                        IS_DUCKED.store(false, Ordering::SeqCst);
                        return;
                    }
                };

                let endpoint_volume = match get_master_endpoint_volume() {
                    Ok(ep) => ep,
                    Err(err) => {
                        eprintln!("[audio_ducking] restore_audio failed: {err}");
                        IS_DUCKED.store(false, Ordering::SeqCst);
                        return;
                    }
                };

                let current_vol = match endpoint_volume.GetMasterVolumeLevelScalar() {
                    Ok(v) => v,
                    Err(_) => target_vol,
                };

                let steps = 6;
                let step_delay = Duration::from_millis(15);

                for i in 1..=steps {
                    if TRANSITION_GEN.load(Ordering::SeqCst) != gen {
                        break;
                    }
                    let t = i as f32 / steps as f32;
                    let v = current_vol + (target_vol - current_vol) * t;
                    let _ = endpoint_volume.SetMasterVolumeLevelScalar(v, std::ptr::null());
                    thread::sleep(step_delay);
                }

                if TRANSITION_GEN.load(Ordering::SeqCst) == gen {
                    let _ = endpoint_volume.SetMasterVolumeLevelScalar(target_vol, std::ptr::null());
                }

                IS_DUCKED.store(false, Ordering::SeqCst);
                CoUninitialize();
            }
        });
    }
}

/// Immediately restores original volume without smooth transition (used on app exit).
pub fn restore_audio_immediate() {
    #[cfg(windows)]
    {
        TRANSITION_GEN.fetch_add(1, Ordering::SeqCst);
        unsafe {
            let orig_vol = {
                let mut orig_lock = ORIGINAL_VOLUME.lock().unwrap();
                orig_lock.take()
            };
            if let Some(target_vol) = orig_vol {
                if let Ok(endpoint_volume) = get_master_endpoint_volume() {
                    let _ = endpoint_volume.SetMasterVolumeLevelScalar(target_vol, std::ptr::null());
                }
            }
            IS_DUCKED.store(false, Ordering::SeqCst);
            CoUninitialize();
        }
    }
}

/// Central dispatcher called whenever recording state changes.
pub fn on_recording_state_change(recording: bool) {
    let prev = LAST_RECORDING_STATE.swap(recording, Ordering::SeqCst);
    if prev == recording {
        return;
    }

    if recording {
        // Start recording: play Zen start chime & duck system audio
        thread::spawn(|| {
            play_cue_sound(true);
        });
        duck_audio(0.20);
    } else {
        // Stop recording: restore volume, wait 60ms for volume curve, play Zen stop chime
        restore_audio();
        thread::spawn(|| {
            thread::sleep(Duration::from_millis(60));
            play_cue_sound(false);
        });
    }
}

#[tauri::command]
pub fn operator_duck_audio(ratio: Option<f64>) -> bool {
    let r = ratio.unwrap_or(0.20) as f32;
    duck_audio(r);
    true
}

#[tauri::command]
pub fn operator_restore_audio() -> bool {
    restore_audio();
    true
}

#[tauri::command]
pub fn operator_play_cue_sound(start: bool) -> bool {
    play_cue_sound(start);
    true
}

#[tauri::command]
pub fn operator_on_recording_state_change(recording: bool) -> bool {
    on_recording_state_change(recording);
    true
}

