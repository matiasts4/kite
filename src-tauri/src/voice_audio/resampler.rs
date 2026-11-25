/// Downmixes interleaved multi-channel `f32` audio into mono `f32`.
pub fn downmix_to_mono_f32(samples: &[f32], channels: u16) -> Vec<f32> {
    let ch = channels.max(1) as usize;
    if ch == 1 {
        return samples.to_vec();
    }
    let frames = samples.len() / ch;
    let mut mono = Vec::with_capacity(frames);
    let inv = 1.0f32 / ch as f32;
    for frame in samples.chunks_exact(ch) {
        let sum: f32 = frame.iter().copied().sum();
        mono.push(sum * inv);
    }
    mono
}

/// Resamples interleaved `f32` audio to mono PCM16 at `dst_rate` using linear interpolation.
pub fn resample_f32_to_pcm16_mono(
    samples: &[f32],
    src_rate: u32,
    src_channels: u16,
    dst_rate: u32,
) -> Vec<i16> {
    if samples.is_empty() {
        return Vec::new();
    }
    let mono = downmix_to_mono_f32(samples, src_channels);
    if mono.is_empty() {
        return Vec::new();
    }
    let safe_src = src_rate.max(8000);
    let safe_dst = dst_rate.max(8000);
    if safe_src == safe_dst {
        return mono
            .into_iter()
            .map(|s| (s.clamp(-1.0, 1.0) * 32767.0).round() as i16)
            .collect();
    }

    let ratio = safe_src as f64 / safe_dst as f64;
    let out_len = ((mono.len() as f64) / ratio).round().max(1.0) as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let pos = i as f64 * ratio;
        let idx = pos.floor() as usize;
        let frac = (pos - idx as f64) as f32;
        let s0 = mono.get(idx).copied().unwrap_or(0.0);
        let s1 = mono.get(idx + 1).copied().unwrap_or(s0);
        let interpolated = s0 + (s1 - s0) * frac;
        out.push((interpolated.clamp(-1.0, 1.0) * 32767.0).round() as i16);
    }
    out
}

/// Computes normalized RMS energy `[0.0, 1.0]` for PCM16 samples.
pub fn compute_pcm16_rms(samples: &[i16]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum_sq: f64 = samples
        .iter()
        .map(|&s| {
            let norm = s as f64 / 32768.0;
            norm * norm
        })
        .sum();
    ((sum_sq / samples.len() as f64).sqrt() as f32).clamp(0.0, 1.0)
}

/// Encodes mono 16-bit PCM samples into a 44-byte RIFF/WAVE container.
pub fn encode_pcm16_wav(samples: &[i16], sample_rate: u32) -> Vec<u8> {
    let safe_rate = sample_rate.max(8000);
    let data_bytes = (samples.len() * 2) as u32;
    let chunk_size = 36 + data_bytes;
    let mut wav = Vec::with_capacity(44 + data_bytes as usize);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&chunk_size.to_le_bytes());
    wav.extend_from_slice(b"WAVE");
    wav.extend_from_slice(b"fmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes()); // PCM
    wav.extend_from_slice(&1u16.to_le_bytes()); // Mono
    wav.extend_from_slice(&safe_rate.to_le_bytes());
    wav.extend_from_slice(&(safe_rate * 2).to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_bytes.to_le_bytes());
    for &s in samples {
        wav.extend_from_slice(&s.to_le_bytes());
    }
    wav
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downsamples_stereo_48k_to_mono_16k_and_encodes_wav() {
        let mut stereo_48k = Vec::with_capacity(48000 * 2);
        for i in 0..48000 {
            let sample = ((i as f32 / 48000.0) * 440.0 * std::f32::consts::TAU).sin() * 0.5;
            stereo_48k.push(sample);
            stereo_48k.push(sample);
        }
        let pcm16 = resample_f32_to_pcm16_mono(&stereo_48k, 48000, 2, 16000);
        assert!((pcm16.len() as i32 - 16000).abs() <= 2);

        let rms = compute_pcm16_rms(&pcm16);
        assert!(rms > 0.25 && rms < 0.45);

        let wav = encode_pcm16_wav(&pcm16, 16000);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(wav.len(), 44 + pcm16.len() * 2);
    }
}
