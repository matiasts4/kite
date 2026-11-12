# ElevenLabs Streaming TTS Provider for Zed

Objective: Integrar ElevenLabs Streaming Text-to-Speech (utilizando la arquitectura de última generación `eleven_v4_turbo`) como proveedor de voz hiperrealista para el asistente Zed en Kite Code, con conmutación fluida entre el motor nativo del navegador y ElevenLabs, control de interrupción instantánea (*barge-in*), y configuración accesible tanto desde los ajustes de Zed como desde la pestaña de Voz.

Branch: `feat/ui-composer`. Sin cambios de rama disruptivos; respetando el flujo de trabajo concurrente.

Delivery strategy: `ask-on-risk`. Los cambios son aditivos y modulares, protegiendo el fallback a `SpeechSynthesis` para garantizar disponibilidad continua.

Test runner: `npm test` (`vitest run`) y `npx tsc --noEmit`.

---

## 1. Especificaciones de Diseño

### S1. Configuración de Operador en `src/lib/operator/operatorConfig.ts`
El registro de configuración del operador se expande con los siguientes campos tipados:

```typescript
export type TTSEngineType = 'browser' | 'elevenlabs';

// En OperatorProviderConfig:
ttsEngine: TTSEngineType;
elevenlabsApiKey: string;
elevenlabsModel: string; // Predeterminado: 'eleven_v4_turbo'
elevenlabsVoiceId: string; // Predeterminado: '21m00Tcm4TlvDq8ikWAM' (Rachel)
elevenlabsStability: number; // 0.0 - 1.0 (predeterminado: 0.5)
elevenlabsSimilarity: number; // 0.0 - 1.0 (predeterminado: 0.8)
```

Valores predeterminados en `DEFAULT_OPERATOR_CONFIG`:
- `ttsEngine: 'browser'` (mantiene compatibilidad inmediata out-of-the-box sin requerir clave).
- `elevenlabsApiKey: ''`
- `elevenlabsModel: 'eleven_v4_turbo'` (latencia ~100ms, optimizado para tiempo real).
- `elevenlabsVoiceId: '21m00Tcm4TlvDq8ikWAM'` (Voz neutra/profesional).

### S2. Catálogo de Voces Curadas y Modelos
Se definen constantes accesibles para la UI:
- **Modelos:**
  - `eleven_v4_turbo`: "Eleven v4 Turbo — Ultrarrápido (~100ms, agentes conversacionales)"
  - `eleven_flash_v2_5`: "Eleven Flash v2.5 — Mínima latencia (~75ms)"
  - `eleven_v4`: "Eleven v4 — Máxima fidelidad expresiva (narración)"
- **Voces Curadas Iniciales:**
  - `21m00Tcm4TlvDq8ikWAM`: "Rachel — Serena y profesional"
  - `pNInz6obpgDQGcFmaJgB`: "Adam — Firme y claro"
  - `ErXwobaYiN019PkySvjV`: "Antoni — Expresivo y dinámico"
  - `IKne3meq5aSn9XLyUdCD`: "Charlie — Técnico y directo"
  - `JBFqnCBsd6RMkjVDRZzb`: "George — Cálido y reflexivo"
  - `EXAVITQu4vr4xnSDxMaL`: "Sarah — Ágil y conversacional"
  - `custom`: "ID de voz personalizado..."

### S3. Motor de Síntesis en `src/lib/operator/ttsNarrator.ts`
- `TTSNarrator` se dota de soporte para ElevenLabs Streaming:
  1. Si `ttsEngine === 'elevenlabs'` y existe `elevenlabsApiKey`:
     - Realiza `fetch` hacia `POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream?output_format=mp3_44100_128`.
     - Utiliza un `AbortController` asociado a la llamada activa.
     - Reproduce el stream de audio mediante `Audio` o `AudioContext` en el cliente.
     - Al invocar `ttsNarrator.stop()`, se llama inmediatamente a `abortController.abort()` y se detiene la reproducción de audio.
  2. **Degradación Elegante (Fallback Automático):**
     - Si la llamada a ElevenLabs falla (error de red, 401 clave inválida, 429 cuota superada):
     - Emite un aviso en consola y ejecuta inmediatamente la síntesis de respaldo con el `SpeechSynthesisUtterance` del navegador sin interrumpir al usuario.
  3. **Optimización de Créditos:**
     - Aplica `cleanTextForSpeech()` antes de enviar el payload a ElevenLabs, eliminando bloques de código markdown, enlaces y signos sintácticos redundantes para no gastar caracteres innecesarios.

### S4. Interfaz de Configuración en Ajustes

#### Ubicación A: Pestaña "Asistente Zed" (`ZedPersonaSection.tsx` / `ZedTab.tsx`)
En la tarjeta de "Identidad y Comportamiento de Zed":
- Selector de **Motor de Síntesis**:
  - `Nativo del Sistema (Web Speech API)`
  - `ElevenLabs Neural Streaming (v4 Turbo)`
- Cuando ElevenLabs está activo:
  - Campo de API Key con botón para alternar visibilidad (ojito) y persistencia segura.
  - Selector de Modelo (`eleven_v4_turbo` recomendado).
  - Selector de Voz (lista de voces curadas o campo para ingresar Voice ID propio).
  - Botón "Probar voz" funcional que reproduce una frase de prueba con ElevenLabs en streaming.

#### Ubicación B: Pestaña "Voz" (`VoiceTab.tsx`)
- Se añade una tarjeta informativa y de acceso rápido a la síntesis de Zed con el estado actual del motor (Nativo o ElevenLabs) para que los desarrolladores que buscan ajustes de audio encuentren la configuración sin fricción.

---

## 2. Criterios de Aceptación (Testing)

- [ ] **AC1:** `operatorConfig.ts` serializa y deserializa correctamente los nuevos campos de ElevenLabs sin alterar la compatibilidad hacia atrás.
- [ ] **AC2:** `ttsNarrator.speak()` transmite a ElevenLabs cuando `ttsEngine === 'elevenlabs'` y `elevenlabsApiKey` está presente.
- [ ] **AC3:** `ttsNarrator.speak()` conmuta a `SpeechSynthesis` si `ttsEngine === 'browser'` o si la petición a ElevenLabs falla con error 401/429/red.
- [ ] **AC4:** `ttsNarrator.stop()` detiene el audio y cancela el `AbortController` en curso inmediatamente.
- [ ] **AC5:** El componente `ZedPersonaSection` renderiza los controles de ElevenLabs y permite probar la voz con feedback visual.
- [ ] **AC6:** Pasan todas las pruebas automatizadas (`vitest run`) y la verificación de tipos (`tsc --noEmit`).
