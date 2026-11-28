// Kite Code — Curated Voice Preset Catalog & 3-Stop Accent Palettes
// Supplies distinct color signatures (deep / core / glint) for ComposerVoiceGlow & VoicePickerModal
// alongside multi-provider Realtime voice hints across xAI, Google Gemini Live, and OpenAI.

export type RgbTriplet = [number, number, number];

export interface VoiceRgbPalette {
  deep: RgbTriplet;
  core: RgbTriplet;
  glint: RgbTriplet;
}

export interface VoiceProviderHints {
  xai: string;
  geminiLive: string;
  openai: string;
}

export interface VoicePreset {
  id: string;
  name: string;
  toneEs: string;
  palette: VoiceRgbPalette;
  providerHints: VoiceProviderHints;
}

export const VOICE_PRESETS: readonly VoicePreset[] = [
  {
    id: 'ara',
    name: 'Ara',
    toneEs: 'Clara y cercana',
    palette: {
      deep: [44, 58, 168],
      core: [96, 132, 255],
      glint: [186, 214, 255],
    },
    providerHints: {
      xai: 'Ara',
      geminiLive: 'Aoede',
      openai: 'alloy',
    },
  },
  {
    id: 'vega',
    name: 'Vega',
    toneEs: 'Serena y precisa',
    palette: {
      deep: [18, 92, 98],
      core: [48, 178, 168],
      glint: [164, 240, 226],
    },
    providerHints: {
      xai: 'Eve',
      geminiLive: 'Kore',
      openai: 'sage',
    },
  },
  {
    id: 'orion',
    name: 'Orion',
    toneEs: 'Firme y natural',
    palette: {
      deep: [48, 36, 128],
      core: [108, 92, 232],
      glint: [198, 192, 255],
    },
    providerHints: {
      xai: 'Leo',
      geminiLive: 'Orus',
      openai: 'ash',
    },
  },
  {
    id: 'lyra',
    name: 'Lyra',
    toneEs: 'Cálida y expresiva',
    palette: {
      deep: [152, 54, 48],
      core: [236, 118, 86],
      glint: [255, 204, 178],
    },
    providerHints: {
      xai: 'Ara',
      geminiLive: 'Leda',
      openai: 'coral',
    },
  },
  {
    id: 'nova',
    name: 'Nova',
    toneEs: 'Ágil y luminosa',
    palette: {
      deep: [148, 86, 24],
      core: [242, 166, 58],
      glint: [255, 230, 164],
    },
    providerHints: {
      xai: 'Rex',
      geminiLive: 'Zephyr',
      openai: 'shimmer',
    },
  },
  {
    id: 'cael',
    name: 'Cael',
    toneEs: 'Profunda y calma',
    palette: {
      deep: [24, 52, 112],
      core: [62, 116, 204],
      glint: [158, 202, 250],
    },
    providerHints: {
      xai: 'Sal',
      geminiLive: 'Charon',
      openai: 'echo',
    },
  },
  {
    id: 'sora',
    name: 'Sora',
    toneEs: 'Ligera y directa',
    palette: {
      deep: [22, 88, 138],
      core: [58, 162, 232],
      glint: [176, 228, 255],
    },
    providerHints: {
      xai: 'Eve',
      geminiLive: 'Puck',
      openai: 'verse',
    },
  },
  {
    id: 'taro',
    name: 'Taro',
    toneEs: 'Equilibrada y sobria',
    palette: {
      deep: [92, 44, 118],
      core: [166, 98, 202],
      glint: [228, 192, 248],
    },
    providerHints: {
      xai: 'Leo',
      geminiLive: 'Fenrir',
      openai: 'ballad',
    },
  },
  {
    id: 'luma',
    name: 'Luma',
    toneEs: 'Clara y amable',
    palette: {
      deep: [138, 42, 88],
      core: [224, 96, 152],
      glint: [255, 196, 224],
    },
    providerHints: {
      xai: 'Ara',
      geminiLive: 'Aoede',
      openai: 'coral',
    },
  },
] as const;

const VOICE_PRESET_INDEX = new Map<string, VoicePreset>(
  VOICE_PRESETS.flatMap((preset) => [
    [preset.id.toLowerCase(), preset],
    [preset.name.toLowerCase(), preset],
  ])
);

function normalizeVoiceKey(name?: string | null): string {
  return (name ?? '').trim().toLowerCase();
}

export function isKnownVoicePreset(name?: string | null): boolean {
  const key = normalizeVoiceKey(name);
  return key.length > 0 && VOICE_PRESET_INDEX.has(key);
}

export function getVoicePalette(voiceName?: string | null): VoicePreset {
  const key = normalizeVoiceKey(voiceName);
  if (key) {
    const found = VOICE_PRESET_INDEX.get(key);
    if (found) return found;
  }
  return VOICE_PRESETS[0];
}

function normalizeChannel(channel: number): number {
  if (!Number.isFinite(channel)) return 0;
  return Math.min(1, Math.max(0, channel / 255));
}

function normalizeTriplet(triplet: RgbTriplet): RgbTriplet {
  return [
    normalizeChannel(triplet[0]),
    normalizeChannel(triplet[1]),
    normalizeChannel(triplet[2]),
  ];
}

/**
 * Converts a 0..255 RGB palette into clamped 0..1 floats suitable for WebGL shader uniforms.
 */
export function normalizeVoiceRgb(palette: VoiceRgbPalette): VoiceRgbPalette {
  return {
    deep: normalizeTriplet(palette.deep),
    core: normalizeTriplet(palette.core),
    glint: normalizeTriplet(palette.glint),
  };
}
