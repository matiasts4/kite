// Canonical Argos voice engine module — re-exports zedVoice with Argos-first aliases.

export * from './zedVoice';

export {
  startOperatorListening as startArgosListening,
  stopOperatorListening as stopArgosListening,
  releaseOperatorCapture as releaseArgosCapture,
  setOperatorMicMuted as setArgosMicMuted,
  isOperatorMicMuted as isArgosMicMuted,
} from './zedVoice';
