import { loadOperatorConfig } from '../operatorConfig';

export interface VoiceEngineStatus {
  available: boolean;
  engine: 'grok-cloud' | 'cloudflare-cloud' | 'browser' | 'none';
  label: string;
  detail: string;
  hasGrokApiKey: boolean;
}

export function getSpeechRecognitionImpl(): any {
  if (typeof window === 'undefined') return null;
  return (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition || null;
}

export function isVoiceRecognitionSupported(): boolean {
  if (typeof window === 'undefined') return false;
  const hasMediaDevices = Boolean(
    typeof navigator !== 'undefined' &&
    navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === 'function'
  );
  return hasMediaDevices || getSpeechRecognitionImpl() !== null;
}

export function getVoiceEngineStatus(): VoiceEngineStatus {
  let grokKey = '';
  try {
    const config = loadOperatorConfig();
    grokKey = config.grokTranscriptionApiKey || config.grokApiKey || '';
    if (!grokKey && typeof localStorage !== 'undefined') {
      grokKey = localStorage.getItem('kite_grok_transcription_api_key') || '';
    }
  } catch {
    // ignore
  }

  const hasGrokApiKey = Boolean(grokKey && grokKey.trim().length > 0);

  if (hasGrokApiKey) {
    return {
      available: true,
      engine: 'grok-cloud',
      label: 'Grok Cloud Speech (xAI / Nube)',
      detail: 'Transcripción ultrarrápida en la nube con modelos Grok Whisper de alta fidelidad.',
      hasGrokApiKey: true,
    };
  }

  let hasCloudflare = false;
  try {
    const config = loadOperatorConfig();
    hasCloudflare = Boolean(config.cloudflareAccountId?.trim() && config.cloudflareApiToken?.trim());
  } catch {
    hasCloudflare = false;
  }

  if (hasCloudflare) {
    return {
      available: true,
      engine: 'cloudflare-cloud',
      label: 'Cloud Whisper (Cloudflare)',
      detail: 'Transcripción en la nube con la cuenta de Cloudflare guardada en Ajustes.',
      hasGrokApiKey: false,
    };
  }

  return {
    available: false,
    engine: 'none',
    label: 'Sin clave de transcripción',
    detail: 'Falta el token de Cloudflare o la clave de Grok en Ajustes de Zed. No hay una clave escrita en el programa.',
    hasGrokApiKey: false,
  };
}
