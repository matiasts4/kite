# Arquitectura de Síntesis de Voz (TTS) y Manejo de Interrupciones

Este documento describe la arquitectura del motor de síntesis de voz ([`ttsNarrator.ts`](file:///E:/kite/src/lib/operator/ttsNarrator.ts)), el sistema de streaming neural con ElevenLabs, el mecanismo de cancelación con latencia cero y cómo se evita que la voz robótica nativa del navegador se dispare al interrumpir al asistente.

---

## 1. Motores Soportados

El Asistente Zed soporta dos motores de síntesis:
1. **ElevenLabs Streaming TTS (Neural de Alta Fidelidad):**  
   - Modelos recomendados: `eleven_v4_turbo` o `eleven_flash_v2_5`.  
   - Conexión vía HTTP streaming (`output_format=mp3_44100_128`).  
   - Control de latencia ultra baja, personalidades de voz (Ara, Rex, Eve, Leo, Sal) y cancelación instantánea.
2. **Web Speech API del Navegador (Fallback Nativo):**  
   - Voces locales instaladas en el sistema operativo (Microsoft Helena, Google español, etc.).  
   - Sirve como respaldo cuando no hay conexión a internet o no se ha configurado clave de ElevenLabs.

---

## 2. El Problema de la Interrupción y la Voz Local Duplicada

### Síntoma
Cuando el asistente estaba hablando con la voz de ElevenLabs y el usuario lo interrumpía (pulsando el botón de voz para hablar de nuevo o iniciando una orden por voz), el asistente cancelaba ElevenLabs, pero **inmediatamente la voz robótica local repetía la frase en segundo plano**.

### Diagnóstico de la Causa Raíz
1. Al interrumpir, [`ZedStrip.tsx`](file:///E:/kite/src/components/ZedStrip.tsx) llamaba a `ttsNarrator.stop()`.
2. `stop()` pausaba el elemento de audio activo y vaciaba su fuente (`audio.src = ''`).
3. Al vaciar la fuente de un audio en reproducción, el navegador web emite un evento `audio.onerror` (o un rechazo en la promesa de `audio.play()`).
4. El manejador de ElevenLabs rechazaba la promesa hacia el método `speak()`.
5. El bloque `catch` de `speak()` comprobaba únicamente:
   ```ts
   if (err?.name === 'AbortError') {
     return;
   }
   ```
6. Como `audio.onerror` pasa un `Event` (donde `err.name` es `undefined`), el `catch` creía que ElevenLabs había fallado por un error técnico de red y ejecutaba el fallback:
   ```ts
   return this.speakBrowser(textToSpeak, options); // Disparaba la voz nativa
   ```

---

## 3. Solución Implementada: Sistema de Épocas / Generaciones

Para garantizar que una interrupción signifique **silencio absoluto**, se implementó un control de generación (`generation`) en [`TTSNarrator`](file:///E:/kite/src/lib/operator/ttsNarrator.ts#L213-L350):

```typescript
class TTSNarrator {
  private generation = 0;

  public stop(): void {
    // 1. Cada stop() avanza la época del narrador
    this.generation++;

    // 2. Aborta cualquier fetch HTTP en vuelo
    if (this.activeAbortController) {
      try { this.activeAbortController.abort(); } catch {}
      this.activeAbortController = null;
    }

    // 3. Detiene y limpia el elemento de audio
    if (this.activeAudio) {
      try {
        this.activeAudio.pause();
        this.activeAudio.currentTime = 0;
        this.activeAudio.src = '';
      } catch {}
      this.activeAudio = null;
    }

    // 4. Cancela la síntesis del navegador si estuviera activa
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try { window.speechSynthesis.cancel(); } catch {}
    }
  }
```

### Reglas de Bloqueo en `speak()`
1. Al iniciar `speak()`, se captura `const myGen = this.generation;`.
2. Si durante la llamada a ElevenLabs o al reproducir el audio se invoca `stop()`, `this.generation` se incrementa.
3. El bloque `catch` y los eventos `audio.onerror` y `audio.play().catch` verifican:
   ```typescript
   if (this.generation !== myGen || controller.signal.aborted) {
     return; // Retorna en silencio absoluto sin activar fallback
   }
   ```
4. Antes de que `speakBrowser()` pueda ejecutarse, se comprueba una vez más:
   ```typescript
   if (this.generation !== myGen) {
     return; // Impedir que la voz local arranque si hubo interrupción
   }
   ```

---

## 4. Detención Incondicional al Escuchar (Barge-In)

En [`useOperatorVoice.ts`](file:///E:/kite/src/lib/operator/hooks/useOperatorVoice.ts#L95-L105):
```typescript
const startListening = useCallback(async () => {
  // Silencia de forma inmediata cualquier audio o síntesis en progreso
  ttsNarrator.stop();
  ...
```

En [`ZedStrip.tsx`](file:///E:/kite/src/components/ZedStrip.tsx#L200-L215):
```typescript
const handleToggleVoice = useCallback(async () => {
  // Detención incondicional de TTS
  ttsNarrator.stop();
  setSpeakingTts(false);
  ...
```

Esto garantiza que tan pronto como el usuario active el micrófono o use atajos de teclado (`Ctrl+Shift+V` / `Esc`), el sistema detiene inmediatamente cualquier sonido sin fugas hacia la voz local.
