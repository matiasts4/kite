import React, { useState, useEffect, useRef } from 'react';
import { invokeCommand } from '../../../../lib/ipc';
import { MicIcon, StopIcon } from '../ChatIcons';

export interface ComposerDictationButtonProps {
  running: boolean;
  prompt: string;
  onChangePrompt: (val: string) => void;
  voice: {
    pauseForDictation: () => void;
    resumeFromDictation: () => void;
  };
}

export const ComposerDictationButton: React.FC<ComposerDictationButtonProps> = ({
  running,
  prompt,
  onChangePrompt,
  voice,
}) => {
  const [dictationAvailability, setDictationAvailability] = useState<{
    canStart: boolean;
    canRequestPermission: boolean;
    guidance: string;
  } | null>(null);
  const [dictationState, setDictationState] = useState<'idle' | 'starting' | 'recording' | 'transcribing'>('idle');
  const [dictationError, setDictationError] = useState<string | null>(null);
  const dictationReqIdRef = useRef<string | null>(null);
  const dictationPollRef = useRef<number | null>(null);
  const promptRef = useRef(prompt);
  useEffect(() => {
    promptRef.current = prompt;
  }, [prompt]);

  // Load dictation availability on mount
  useEffect(() => {
    let isMounted = true;
    invokeCommand<any>('read_dictation_availability', { supportedSchemaVersion: 1 })
      .then((avail) => {
        if (isMounted && avail) {
          setDictationAvailability({
            canStart: Boolean(avail.canStart),
            canRequestPermission: Boolean(avail.canRequestPermission),
            guidance: avail.guidance || '',
          });
        }
      })
      .catch(() => {
        if (isMounted) {
          setDictationAvailability({
            canStart: false,
            canRequestPermission: false,
            guidance: 'Dictation is unavailable on this computer.',
          });
        }
      });

    return () => {
      isMounted = false;
      if (dictationPollRef.current) {
        window.clearInterval(dictationPollRef.current);
        dictationPollRef.current = null;
      }
      if (dictationReqIdRef.current) {
        invokeCommand('cancel_dictation', {
          id: dictationReqIdRef.current,
          supportedSchemaVersion: 1,
        }).catch(() => undefined);
        dictationReqIdRef.current = null;
        voice.resumeFromDictation();
      }
    };
  }, []);

  const toggleDictation = async () => {
    if (running) return;
    setDictationError(null);

    if (dictationState === 'recording' || dictationState === 'starting') {
      const id = dictationReqIdRef.current;
      if (!id) return;
      setDictationState('transcribing');
      try {
        await invokeCommand('stop_dictation', { id, supportedSchemaVersion: 1 });
      } catch (err: any) {
        setDictationError(err?.message || 'Error stopping dictation.');
        setDictationState('idle');
        dictationReqIdRef.current = null;
        voice.resumeFromDictation();
      }
      return;
    }

    if (dictationState !== 'idle') return;

    const id = crypto.randomUUID();
    dictationReqIdRef.current = id;
    setDictationState('starting');
    voice.pauseForDictation();

    try {
      await invokeCommand('start_dictation', { id, supportedSchemaVersion: 1 });
      setDictationState('recording');

      dictationPollRef.current = window.setInterval(async () => {
        if (dictationReqIdRef.current !== id) {
          if (dictationPollRef.current) window.clearInterval(dictationPollRef.current);
          return;
        }
        try {
          const take = await invokeCommand<any>('read_dictation', { id, supportedSchemaVersion: 1 });
          if (!take) return;
          if (take.phase === 'recording') {
            setDictationState('recording');
          } else if (take.phase === 'transcribing') {
            setDictationState('transcribing');
          } else if (take.phase === 'done') {
            if (dictationPollRef.current) {
              window.clearInterval(dictationPollRef.current);
              dictationPollRef.current = null;
            }
            dictationReqIdRef.current = null;
            setDictationState('idle');
            voice.resumeFromDictation();
            const transcript = (take.transcript || '').trim();
            if (transcript) {
              const currentPrompt = promptRef.current;
              onChangePrompt(currentPrompt.trim() ? `${currentPrompt.trimEnd()} ${transcript}` : transcript);
            }
          } else if (take.phase === 'error' || take.phase === 'cancelled') {
            if (dictationPollRef.current) {
              window.clearInterval(dictationPollRef.current);
              dictationPollRef.current = null;
            }
            dictationReqIdRef.current = null;
            setDictationState('idle');
            voice.resumeFromDictation();
            if (take.error?.message) {
              setDictationError(take.error.message);
            } else if (take.message) {
              setDictationError(take.message);
            }
          }
        } catch {
          // Keep polling
        }
      }, 250);
    } catch (err: any) {
      dictationReqIdRef.current = null;
      setDictationState('idle');
      voice.resumeFromDictation();
      setDictationError(err?.message || 'Dictation could not start.');
    }
  };

  return (
    <button
      type="button"
      disabled={
        running ||
        (dictationAvailability !== null &&
          !dictationAvailability.canStart &&
          !dictationAvailability.canRequestPermission)
      }
      onClick={toggleDictation}
      title={
        dictationState === 'recording'
          ? 'Finish dictation'
          : dictationState === 'transcribing'
          ? 'Transcribing…'
          : dictationError || 'Dictate message'
      }
      aria-label={dictationState === 'recording' ? 'Finish dictation' : 'Dictate message'}
      className={`chat-dictate-control size-8 rounded-control ${
        dictationState === 'recording' ? 'chat-dictate-control--recording' : ''
      }`}
    >
      {dictationState === 'recording' ? (
        <StopIcon size={14} />
      ) : dictationState === 'transcribing' ? (
        <svg
          className="chat-dictate-glyph animate-spin"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path d="M12 4a8 8 0 1 1-6.32 3.1" />
        </svg>
      ) : (
        <MicIcon size={14} />
      )}
    </button>
  );
};
