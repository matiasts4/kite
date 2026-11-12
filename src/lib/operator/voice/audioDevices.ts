export interface AudioInputDeviceInfo {
  deviceId: string;
  label: string;
  groupId?: string;
}

export interface MicrophoneTester {
  stop: () => void;
}

const capturedStreams = new Set<MediaStream>();

export function rememberStream(stream: MediaStream): MediaStream {
  capturedStreams.add(stream);
  return stream;
}

export function stopCapturedStreams(): void {
  for (const stream of capturedStreams) {
    try {
      stream.getTracks().forEach((track) => track.stop());
    } catch {
      // ignore
    }
  }
  capturedStreams.clear();
}

export function describeMicrophoneError(err: unknown): string {
  const name = (err as { name?: string } | null)?.name || '';
  const message = String((err as { message?: string } | null)?.message || err || '');
  if (name === 'NotAllowedError' || /permission|denied|permiso/i.test(message)) {
    return 'Permiso de micrófono denegado en Windows.';
  }
  if (name === 'NotFoundError') {
    return 'No se detectó ningún micrófono conectado.';
  }
  if (
    name === 'NotReadableError' ||
    /device in use|in use|busy|could not start audio/i.test(message)
  ) {
    return 'El micrófono está ocupado. Solté la captura de Zed; si sigue así, cierra la otra ventana de Kite que lo tenga abierto.';
  }
  return 'No pude abrir el micrófono.';
}

export function isDeviceInUse(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name || '';
  const message = String((err as { message?: string } | null)?.message || err || '');
  return name === 'NotReadableError' || /device in use|in use|could not start audio/i.test(message);
}

export async function openMicrophone(constraints: MediaStreamConstraints): Promise<MediaStream> {
  try {
    return rememberStream(await navigator.mediaDevices.getUserMedia(constraints));
  } catch (err) {
    if (!isDeviceInUse(err)) throw err;
    stopCapturedStreams();
    await new Promise((resolve) => setTimeout(resolve, 180));
    try {
      return rememberStream(await navigator.mediaDevices.getUserMedia(constraints));
    } catch (retryErr) {
      throw new Error(describeMicrophoneError(retryErr));
    }
  }
}

/**
 * Gets audio input stream with default microphone auto-detection.
 */
export async function getAudioInputStream(preferredDeviceId?: string | null): Promise<MediaStream> {
  if (typeof navigator === 'undefined' || typeof navigator.mediaDevices?.getUserMedia !== 'function') {
    throw new Error('El acceso al micrófono no está soportado en este entorno.');
  }

  let deviceIdToUse = preferredDeviceId;
  try {
    if (!deviceIdToUse && typeof localStorage !== 'undefined') {
      deviceIdToUse = localStorage.getItem('kite_selected_mic_device_id') || null;
    }
  } catch {}

  // 1. Try with preferred deviceId if provided
  if (deviceIdToUse && deviceIdToUse !== 'automatic' && deviceIdToUse !== 'default') {
    try {
      return await openMicrophone({
        audio: {
          deviceId: { ideal: deviceIdToUse },
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (e) {
      console.warn('[ZedVoice] Fallo con dispositivo específico, usando micrófono predeterminado:', e);
    }
  }

  // 2. Default system microphone with clean voice processing
  try {
    return await openMicrophone({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (e) {
    if (isDeviceInUse(e) || (e instanceof Error && /micrófono está ocupado/i.test(e.message))) {
      throw e instanceof Error ? e : new Error(describeMicrophoneError(e));
    }
    return await openMicrophone({ audio: true });
  }
}

/**
 * Enumerate connected audio input devices (microphones)
 */
export async function listAudioInputDevices(): Promise<AudioInputDeviceInfo[]> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
    return [];
  }
  try {
    let devices = await navigator.mediaDevices.enumerateDevices();
    let audioInputs = devices.filter((d) => d.kind === 'audioinput');

    // If permission has not been requested yet in this window session,
    // device labels will be empty strings. In that case, request a temporary
    // stream to unlock hardware labels, then stop it immediately.
    const hasMissingLabels = audioInputs.length > 0 && !audioInputs[0].label;
    if (hasMissingLabels && typeof navigator.mediaDevices.getUserMedia === 'function') {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());
        devices = await navigator.mediaDevices.enumerateDevices();
        audioInputs = devices.filter((d) => d.kind === 'audioinput');
      } catch (err) {
        console.warn('[ZedVoice] No se pudo obtener permiso temporal para etiquetas:', err);
      }
    }

    return audioInputs.map((d, idx) => ({
      deviceId: d.deviceId,
      label: d.label || `Micrófono ${idx + 1}`,
      groupId: d.groupId,
    }));
  } catch (err) {
    console.warn('[ZedVoice] Error al enumerar micrófonos:', err);
    return [];
  }
}

/**
 * Starts a live microphone test that reads real-time volume levels (0 to 1)
 * from the selected device, perfect for VU meters in Settings.
 */
export async function startMicrophoneTest(
  deviceId: string | null,
  onLevel: (level: number) => void
): Promise<MicrophoneTester> {
  const stream = await getAudioInputStream(deviceId);
  const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
  if (!AudioContextClass) {
    return {
      stop: () => {
        stream.getTracks().forEach((t) => t.stop());
        onLevel(0);
      },
    };
  }

  const audioCtx = new AudioContextClass();
  if (audioCtx.state === 'suspended') {
    try {
      await audioCtx.resume();
    } catch {}
  }
  const source = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 64;
  analyser.smoothingTimeConstant = 0.3;
  source.connect(analyser);

  let active = true;
  let rafId: number | null = null;
  const buffer = new Uint8Array(analyser.frequencyBinCount);

  const loop = () => {
    if (!active) return;
    analyser.getByteFrequencyData(buffer);
    let sum = 0;
    for (let i = 0; i < buffer.length; i++) {
      sum += buffer[i];
    }
    const avg = sum / buffer.length / 255;
    const level = Math.min(1, avg * 2.5);
    onLevel(level);
    rafId = requestAnimationFrame(loop);
  };
  rafId = requestAnimationFrame(loop);

  return {
    stop: () => {
      active = false;
      if (rafId) cancelAnimationFrame(rafId);
      try {
        source.disconnect();
        analyser.disconnect();
        audioCtx.close();
      } catch {}
      try {
        stream.getTracks().forEach((t) => t.stop());
      } catch {}
      onLevel(0);
    },
  };
}
