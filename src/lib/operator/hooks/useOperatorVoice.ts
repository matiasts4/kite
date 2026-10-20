import { useState, useCallback, useRef, useEffect } from 'react';
import {
  startOperatorListening,
  stopOperatorListening,
  getCurrentAudioLevel,
  isVoiceRecognitionSupported,
  getVoiceEngineStatus,
  type VoiceEngineStatus,
} from '../voice/zedVoice';

export interface UseOperatorVoiceOptions {
  onFinalTranscript?: (transcript: string) => void;
  language?: string;
}

export interface UseOperatorVoiceResult {
  isListening: boolean;
  transcript: string;
  interimTranscript: string;
  audioLevel: number;
  error: string | null;
  engineStatus: VoiceEngineStatus;
  startListening: () => Promise<void>;
  stopListening: () => void;
  toggleListening: () => Promise<void>;
  clearTranscript: () => void;
  clearError: () => void;
}

export function useOperatorVoice({
  onFinalTranscript,
  language = 'es-ES',
}: UseOperatorVoiceOptions = {}): UseOperatorVoiceResult {
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [interimTranscript, setInterimTranscript] = useState('');
  const [audioLevel, setAudioLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const levelRafRef = useRef<number | null>(null);
  const isListeningRef = useRef(false);
  const errorTimerRef = useRef<number | null>(null);
  const onFinalTranscriptRef = useRef(onFinalTranscript);
  onFinalTranscriptRef.current = onFinalTranscript;

  const engineStatus = getVoiceEngineStatus();

  const clearError = useCallback(() => {
    if (errorTimerRef.current) {
      window.clearTimeout(errorTimerRef.current);
      errorTimerRef.current = null;
    }
    setError(null);
  }, []);

  const setErrorWithAutoClear = useCallback((msg: string | null) => {
    if (errorTimerRef.current) {
      window.clearTimeout(errorTimerRef.current);
      errorTimerRef.current = null;
    }
    setError(msg);
    if (msg) {
      errorTimerRef.current = window.setTimeout(() => {
        setError(null);
        errorTimerRef.current = null;
      }, 4000);
    }
  }, []);

  // Audio level monitoring RAF loop while listening
  const monitorAudio = useCallback(() => {
    if (!isListeningRef.current) return;
    const current = getCurrentAudioLevel();
    setAudioLevel(current);
    levelRafRef.current = requestAnimationFrame(monitorAudio);
  }, []);

  const stopListening = useCallback(() => {
    setIsListening(false);
    isListeningRef.current = false;
    if (levelRafRef.current) {
      cancelAnimationFrame(levelRafRef.current);
      levelRafRef.current = null;
    }
    setAudioLevel(0);
    stopOperatorListening();
  }, []);

  const startListening = useCallback(async () => {
    if (!isVoiceRecognitionSupported()) {
      setErrorWithAutoClear('El reconocimiento de voz no está disponible en este entorno.');
      return;
    }

    clearError();
    setTranscript('');
    setInterimTranscript('');
    setIsListening(true);
    isListeningRef.current = true;

    // Start audio level visual feedback
    levelRafRef.current = requestAnimationFrame(monitorAudio);

    try {
      const finalResult = await startOperatorListening({
        language,
        onInterim: (partial) => {
          setInterimTranscript(partial);
        },
        onTranscribing: () => {
          setIsListening(false);
          isListeningRef.current = false;
          if (levelRafRef.current) {
            cancelAnimationFrame(levelRafRef.current);
            levelRafRef.current = null;
          }
          setAudioLevel(0);
        },
        onError: (err) => {
          setErrorWithAutoClear(err);
        },
      });

      setTranscript(finalResult);
      setInterimTranscript('');
      setIsListening(false);
      isListeningRef.current = false;

      if (levelRafRef.current) {
        cancelAnimationFrame(levelRafRef.current);
        levelRafRef.current = null;
      }
      setAudioLevel(0);

      if (finalResult && finalResult.trim().length > 0) {
        onFinalTranscriptRef.current?.(finalResult.trim());
      }
    } catch (err: any) {
      console.warn('[useOperatorVoice] Error capturando voz:', err);
      setErrorWithAutoClear(err?.message || 'Error al capturar voz');
      setIsListening(false);
      isListeningRef.current = false;
      if (levelRafRef.current) {
        cancelAnimationFrame(levelRafRef.current);
        levelRafRef.current = null;
      }
      setAudioLevel(0);
    }
  }, [clearError, language, monitorAudio, setErrorWithAutoClear]);

  const toggleListening = useCallback(async () => {
    if (isListeningRef.current) {
      stopListening();
    } else {
      await startListening();
    }
  }, [startListening, stopListening]);

  const clearTranscript = useCallback(() => {
    setTranscript('');
    setInterimTranscript('');
  }, []);

  useEffect(() => {
    return () => {
      if (levelRafRef.current) {
        cancelAnimationFrame(levelRafRef.current);
      }
      if (errorTimerRef.current) {
        window.clearTimeout(errorTimerRef.current);
      }
      stopOperatorListening();
    };
  }, []);

  return {
    isListening,
    transcript,
    interimTranscript,
    audioLevel,
    error,
    engineStatus,
    startListening,
    stopListening,
    toggleListening,
    clearTranscript,
    clearError,
  };
}
