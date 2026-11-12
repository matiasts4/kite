export const WHISPER_SILENCE_HALLUCINATIONS = [
  'gracias',
  'muchas gracias',
  'gracias por ver',
  'gracias por su atención',
  'gracias por su atencion',
  'gracias por escuchar',
  'thank you',
  'thanks',
  'thank you for watching',
  'thanks for watching',
  "i'm sorry",
  'im sorry',
  'subtítulos por la comunidad de amara.org',
  'subtítulos realizados por la comunidad de amara.org',
  'subtitulos por la comunidad de amara.org',
  'subtítulos por',
  'subtitulos por',
  'ご視聴ありがとうございました',
  'ご視聴ありがとう',
  'ありがとうございました',
  'チャンネル登録',
  'おやすみなさい',
  'bye bye',
  'bye',
];

export const CJK_REGEX = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f]/;

/**
 * Cleans Whisper / STT silence and non-speech hallucinations
 * so short silence does not become a fake phrase.
 */
export function cleanTranscriptionText(text: string, durationSecs: number = 0): string {
  let normalized = (text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';

  // In Spanish/English dictation mode, any CJK output from Whisper is guaranteed to be a silence hallucination
  if (CJK_REGEX.test(normalized)) {
    return '';
  }

  const lowered = normalized.toLowerCase().replace(/^[.,!?:;¡!¿?"'`[\]()]*(.*?)[.,!?:;¡!¿?"'`[\]()]*$/, '$1').trim();

  // If text matches any Whisper silence hallucination, drop it immediately
  if (WHISPER_SILENCE_HALLUCINATIONS.some((h) => lowered === h || lowered.startsWith(h) || lowered.endsWith(h))) {
    return '';
  }

  // Check if string is a repetitive loop hallucination like "I'm sorry, I'm sorry, I'm sorry..."
  const words = normalized.split(/\s+/);
  if (words.length >= 6) {
    const firstTwo = `${words[0]} ${words[1]}`.toLowerCase();
    const secondTwo = `${words[2]} ${words[3]}`.toLowerCase();
    const thirdTwo = `${words[4]} ${words[5]}`.toLowerCase();
    if (firstTwo === secondTwo && secondTwo === thirdTwo) {
      return '';
    }
  }

  // Strip gratitude suffixes or prefixes if present on medium-length recordings
  if (durationSecs <= 10.0) {
    for (const phrase of WHISPER_SILENCE_HALLUCINATIONS) {
      const prefixRegex = new RegExp(`^\\s*${phrase}[\\s.,;:!\\?¡¿-]+`, 'i');
      const suffixRegex = new RegExp(`[\\s.,;:!\\?¡¿-]+${phrase}\\s*$`, 'i');
      normalized = normalized.replace(prefixRegex, '').replace(suffixRegex, '').trim();
    }
  }

  // Strip leading hesitation filler words in spoken Spanish (e.g. "Eh, ", "Em, ", "Este, ", "Ah, ")
  normalized = normalized.replace(/^(?:eh|em|este|ah|bueno|oye)[,.\s]+/i, '').trim();

  return normalized;
}

/**
 * Converts a Blob to a base64 string using fast native FileReader or chunked fallback.
 */
export async function blobToBase64(blob: Blob): Promise<string> {
  if (typeof FileReader !== 'undefined') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const dataUrl = reader.result as string;
        const comma = dataUrl.indexOf(',');
        resolve(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl);
      };
      reader.onerror = () => reject(new Error('Fallo al leer datos de audio'));
      reader.readAsDataURL(blob);
    });
  }
  const arrayBuffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return btoa(binary);
}

/**
 * Encodes an array of Float32 PCM sample chunks into a valid standard 16-bit PCM WAV Blob.
 * Includes DC offset removal, peak normalization, and 16 kHz mono linear downsampling.
 */
export function encodeWavBlob(
  samples: Float32Array[],
  sampleRate: number,
  targetRate: number = 16000
): Blob {
  let totalLength = 0;
  for (const chunk of samples) {
    totalLength += chunk.length;
  }
  const merged = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of samples) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  // Downsample to 16kHz if needed (Whisper standard, cuts payload size ~3x)
  let pcmData = merged;
  let finalRate = sampleRate;
  if (sampleRate > targetRate && targetRate > 0 && merged.length > 0) {
    const ratio = sampleRate / targetRate;
    const newLen = Math.round(merged.length / ratio);
    const downsampled = new Float32Array(newLen);
    for (let i = 0; i < newLen; i++) {
      const pos = i * ratio;
      const index = Math.floor(pos);
      const frac = pos - index;
      const next = index + 1 < merged.length ? merged[index + 1] : merged[merged.length - 1];
      downsampled[i] = merged[index] * (1 - frac) + next * frac;
    }
    pcmData = downsampled;
    finalRate = targetRate;
  }

  // Pre-processing:
  // 1. Remove DC offset
  let sum = 0;
  for (let i = 0; i < pcmData.length; i++) {
    sum += pcmData[i];
  }
  const mean = pcmData.length > 0 ? sum / pcmData.length : 0;
  for (let i = 0; i < pcmData.length; i++) {
    pcmData[i] -= mean;
  }

  // 2. Peak normalization (boosts low-volume mic levels cleanly to ~0.95)
  let peak = 0;
  for (let i = 0; i < pcmData.length; i++) {
    const abs = Math.abs(pcmData[i]);
    if (abs > peak) peak = abs;
  }
  if (peak > 0.005) {
    const scale = 0.95 / peak;
    for (let i = 0; i < pcmData.length; i++) {
      pcmData[i] *= scale;
    }
  }

  const dataSize = pcmData.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  // 'RIFF' chunk descriptor
  view.setUint32(0, 0x52494646, false); // 'RIFF'
  view.setUint32(4, 36 + dataSize, true);
  view.setUint32(8, 0x57415645, false); // 'WAVE'

  // 'fmt ' sub-chunk
  view.setUint32(12, 0x666d7420, false); // 'fmt '
  view.setUint32(16, 16, true); // 16 for PCM
  view.setUint16(20, 1, true); // Linear PCM
  view.setUint16(22, 1, true); // Mono (1 channel)
  view.setUint32(24, finalRate, true);
  view.setUint32(28, finalRate * 2, true); // Byte rate (finalRate * 1 * 16/8)
  view.setUint16(32, 2, true); // Block align (1 * 16/8)
  view.setUint16(34, 16, true); // Bits per sample

  // 'data' sub-chunk
  view.setUint32(36, 0x64617461, false); // 'data'
  view.setUint32(40, dataSize, true);

  // Convert float PCM samples [-1.0, 1.0] to 16-bit signed integers
  let pcmOffset = 44;
  for (let i = 0; i < pcmData.length; i++) {
    const s = Math.max(-1, Math.min(1, pcmData[i]));
    const val = s < 0 ? s * 0x8000 : s * 0x7fff;
    view.setInt16(pcmOffset, val, true);
    pcmOffset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}
