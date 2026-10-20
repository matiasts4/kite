/**
 * WebGL2 Volumetric Plasma & Glass Refraction OrbRenderer
 * High-performance WebGL2 shader implementation for Kite Code Zed Assistant Orb.
 */

const VERTEX_SHADER_SOURCE = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER_SOURCE = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

uniform float u_time;
uniform float u_level;
uniform float u_reactivity;
uniform float u_thinking;
uniform float u_idle;
uniform vec2  u_tilt;
uniform vec3  u_primary;
uniform vec3  u_secondary;
uniform vec3  u_accent;
uniform float u_dpr;
uniform vec2  u_resolution;

vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 10.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3  ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.5 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 105.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}

float fbm(vec3 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 3; i++) {
    v += a * snoise(p);
    p = p * 2.03 + vec3(17.1, 31.7, 11.3);
    a *= 0.5;
  }
  return v;
}

mat3 rotY(float a) {
  float c = cos(a), s = sin(a);
  return mat3(c,0.0,s, 0.0,1.0,0.0, -s,0.0,c);
}
mat3 rotX(float a) {
  float c = cos(a), s = sin(a);
  return mat3(1.0,0.0,0.0, 0.0,c,-s, 0.0,s,c);
}

void main() {
  vec2 p = (v_uv - 0.5) * 2.0;

  float t = u_time;
  float lvl = clamp(u_level, 0.0, 1.0);
  float react = clamp(u_reactivity, 0.0, 1.0);
  float think = clamp(u_thinking, 0.0, 1.0);

  vec2 c = p - u_tilt * 0.06;
  float r = length(c);

  float baseRadius = 0.72 + lvl * 0.015 * react;
  float angle = atan(c.y, c.x);
  // Gentle, calm organic drift rather than high-frequency jitter
  float dispA = snoise(vec3(cos(angle) * 1.4, sin(angle) * 1.4, t * 0.22)) * 0.005;
  float radius = baseRadius + dispA * react;

  float edgeDist = r - radius;
  float px = 2.0 / max(u_resolution.x, 1.0);

  float sphereMask = 1.0 - smoothstep(-px * 1.5, px * 1.5, edgeDist);

  vec2 sn = c / max(radius, 0.0001);
  float zSq = max(0.0, 1.0 - dot(sn, sn));
  float z = sqrt(zSq);
  vec3 N = normalize(vec3(sn.x, sn.y, z + 0.0001));

  vec3 R = reflect(vec3(0.0, 0.0, -1.0), N);
  float ior = 1.28;
  vec3 T = refract(vec3(0.0, 0.0, -1.0), N, 1.0 / ior);

  // Smooth, relaxed rotation speed
  float spinSpeed = mix(0.10, 0.26, max(think * 0.7, lvl * 0.35));
  mat3 spin = rotY(t * spinSpeed + u_tilt.x * 0.35) * rotX(sin(t * 0.14) * 0.18 - u_tilt.y * 0.35);

  vec3 accum = vec3(0.0);
  float densityAccum = 0.0;
  const int STEPS = 5;
  for (int i = 0; i < STEPS; i++) {
    float fi = float(i) / float(STEPS - 1);
    float depth = mix(0.18, 0.92, fi);
    vec3 samplePos = vec3(sn * (1.0 - depth * 0.35), z * depth);
    samplePos += T * depth * 0.35;
    samplePos = spin * samplePos;

    vec3 warp = vec3(
      snoise(samplePos * 1.5 + vec3(0.0, 0.0, t * 0.18)),
      snoise(samplePos * 1.5 + vec3(5.2, 1.3, t * 0.18)),
      snoise(samplePos * 1.5 + vec3(2.8, 7.1, t * 0.18))
    );
    float f = fbm(samplePos * 1.9 + warp * (0.45 + lvl * 0.35));

    float ribbon = smoothstep(-0.15, 0.55, f);
    float coreWeight = exp(-dot(samplePos, samplePos) * 1.35);

    vec3 layerCol = mix(u_secondary, u_primary, smoothstep(-0.2, 0.5, f));
    layerCol = mix(layerCol, u_accent, pow( clamp(f + 0.35, 0.0, 1.0), 3.0 ) * (0.45 + lvl * 0.45));

    // Calm harmonic breathing
    float pulse = 0.92 + 0.16 * sin(t * 0.85 + fi * 1.8) * lvl;
    float w = ribbon * (0.35 + 0.65 * coreWeight) * pulse;
    accum += layerCol * w;
    densityAccum += w;
  }
  vec3 plasma = accum / max(densityAccum, 0.001);
  plasma *= (0.75 + 0.55 * (densityAccum / float(STEPS)));

  float coreDist = length(sn - vec2(-0.08, 0.1) + u_tilt * 0.08);
  float core = exp(-coreDist * coreDist * (3.2 - lvl * 0.8));
  vec3 coreCol = mix(u_primary, u_accent, 0.55 + 0.25 * sin(t * 0.65));
  plasma += coreCol * core * (0.65 + lvl * 0.5);

  vec3 deepBase = u_secondary * 0.22;
  vec3 interior = mix(deepBase, plasma, clamp(densityAccum * 0.55, 0.0, 1.0));
  interior += plasma * 0.42;

  float fresnel = pow(1.0 - z, 2.6);
  float iridShift = sin(angle * 1.5 + t * 0.25 + r * 3.0) * 0.5 + 0.5;
  vec3 rimCol = mix(u_primary, u_accent, iridShift);
  interior = mix(interior, rimCol * 1.35, fresnel * 0.62);

  float innerShadow = smoothstep(0.0, 0.55, z);
  interior *= mix(0.62, 1.05, innerShadow);

  vec3 L1 = normalize(vec3(-0.48, 0.58, 0.66));
  vec3 H1 = normalize(L1 + vec3(0.0, 0.0, 1.0));
  float spec1 = pow(max(dot(N, H1), 0.0), 48.0);
  float spec1Soft = pow(max(dot(N, H1), 0.0), 10.0);

  vec3 L2 = normalize(vec3(0.55, -0.52, 0.65));
  vec3 H2 = normalize(L2 + vec3(0.0, 0.0, 1.0));
  float spec2 = pow(max(dot(N, H2), 0.0), 22.0);

  interior += vec3(1.0, 0.98, 0.95) * spec1 * 0.85;
  interior += u_accent * spec1Soft * 0.22;
  interior += u_primary * spec2 * 0.35;

  float sheen = smoothstep(0.15, 0.85, sn.y * 0.7 - sn.x * 0.3 + 0.35) * (1.0 - smoothstep(0.0, 0.65, abs(sn.x)));
  interior += vec3(1.0) * sheen * 0.10 * z;

  float haloDist = max(edgeDist, 0.0);
  float halo1 = exp(-haloDist * 14.0) * (0.32 + lvl * 0.25 + think * 0.1);
  float halo2 = exp(-haloDist * 4.8)  * (0.12 + lvl * 0.18);
  float haloWave = 0.5 + 0.5 * snoise(vec3(cos(angle) * 1.5, sin(angle) * 1.5, t * 0.35));
  vec3 haloCol = mix(u_primary, u_accent, haloWave * 0.5);
  vec3 halo = haloCol * (halo1 + halo2);

  // Calm ethereal aura wave instead of rapid concentric rings
  float ringRadius = radius + 0.05 + fract(t * 0.12) * 0.16;
  float ringFade = (1.0 - fract(t * 0.12));
  float ring = exp(-pow((r - ringRadius) * 26.0, 2.0)) * ringFade * lvl * 0.22;
  halo += u_accent * ring;

  float idleDim = mix(1.0, 0.88, u_idle);
  interior *= idleDim;
  halo *= mix(1.0, 0.55, u_idle);

  vec3 col = interior * sphereMask + halo * (1.0 - sphereMask * 0.65);
  float alpha = clamp(sphereMask + (halo1 * 0.85 + halo2 * 0.65 + ring) * (1.0 - sphereMask), 0.0, 1.0);

  col = col / (1.0 + col * 0.28);
  col = pow(max(col, vec3(0.0)), vec3(1.0 / 1.08));

  fragColor = vec4(col * alpha, alpha);
}
`;

export interface OrbPalette {
  primary: [number, number, number];
  secondary: [number, number, number];
  accent: [number, number, number];
}

export const ORB_PALETTES: Record<string, OrbPalette> = {
  connected: {
    primary: [1, 0.64, 0.22], // Warm golden amber
    secondary: [0.62, 0.2, 0.08],
    accent: [1, 0.88, 0.58],
  },
  listening: {
    primary: [0.12, 0.85, 1.0], // Vibrant glowing electric cyan when recording!
    secondary: [0.05, 0.35, 0.78],
    accent: [0.65, 0.98, 1.0],
  },
  thinking: {
    primary: [0.82, 0.45, 1.0], // Deep violet plasma while processing
    secondary: [0.38, 0.12, 0.68],
    accent: [0.95, 0.78, 1.0],
  },
  speaking: {
    primary: [0.25, 0.95, 0.82], // Radiant emerald/cyan while speaking TTS
    secondary: [0.08, 0.45, 0.38],
    accent: [0.72, 1.0, 0.92],
  },
  connecting: {
    primary: [0.96, 0.62, 0.18],
    secondary: [0.48, 0.22, 0.06],
    accent: [1, 0.84, 0.5],
  },
  error: {
    primary: [0.96, 0.28, 0.26], // Crimson red on error
    secondary: [0.48, 0.08, 0.1],
    accent: [1, 0.62, 0.55],
  },
  idle: {
    primary: [0.78, 0.56, 0.36],
    secondary: [0.32, 0.2, 0.14],
    accent: [0.98, 0.82, 0.6],
  },
};

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('createShader returned null');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader) ?? 'unknown shader error';
    gl.deleteShader(shader);
    throw new Error(`Orb shader compile failed: ${info}`);
  }
  return shader;
}

function lerp3(
  a: [number, number, number],
  b: [number, number, number],
  t: number
): [number, number, number] {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

export interface OrbRenderParams {
  time: number;
  level: number;
  reactivity: number;
  thinking: number;
  idle: number;
  tiltX: number;
  tiltY: number;
  paletteKey: string;
}

export class OrbRenderer {
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private vbo: WebGLBuffer | null = null;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private currentPrimary: [number, number, number] = [...ORB_PALETTES.connected.primary];
  private currentSecondary: [number, number, number] = [...ORB_PALETTES.connected.secondary];
  private currentAccent: [number, number, number] = [...ORB_PALETTES.connected.accent];
  private width = 0;
  private height = 0;
  private dpr = 1;
  private lost = false;
  private canvas: HTMLCanvasElement;

  private readonly onContextLost = (e: Event) => {
    e.preventDefault();
    this.lost = true;
  };

  private readonly onContextRestored = () => {
    this.lost = false;
    this.initPipeline();
  };

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    canvas.addEventListener('webglcontextlost', this.onContextLost, false);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored, false);
    this.initPipeline();
  }

  public isReady(): boolean {
    return this.gl !== null && this.program !== null && !this.lost;
  }

  private initPipeline(): void {
    const gl = this.canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: true,
      powerPreference: 'low-power',
      preserveDrawingBuffer: false,
    });
    if (!gl) {
      this.gl = null;
      return;
    }
    this.gl = gl;

    try {
      const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER_SOURCE);
      const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SOURCE);
      const program = gl.createProgram();
      if (!program) throw new Error('createProgram returned null');
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);

      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const info = gl.getProgramInfoLog(program) ?? 'unknown link error';
        gl.deleteProgram(program);
        throw new Error(`Orb program link failed: ${info}`);
      }
      this.program = program;

      const vao = gl.createVertexArray();
      const vbo = gl.createBuffer();
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      const vertices = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);
      gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
      const aPos = gl.getAttribLocation(program, 'a_pos');
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
      this.vao = vao;
      this.vbo = vbo;

      const uniformNames = [
        'u_time',
        'u_level',
        'u_reactivity',
        'u_thinking',
        'u_idle',
        'u_tilt',
        'u_primary',
        'u_secondary',
        'u_accent',
        'u_dpr',
        'u_resolution',
      ];
      for (const name of uniformNames) {
        this.uniforms[name] = gl.getUniformLocation(program, name);
      }

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    } catch (err) {
      console.warn('[ZedOrb] WebGL2 pipeline fallback:', err);
      this.program = null;
    }
  }

  public resize(cssWidth: number, cssHeight: number, dpr = window.devicePixelRatio || 1): void {
    const gl = this.gl;
    if (!gl) return;
    // Cap DPR to 1.5 max: prevents high-resolution canvas overdraw on 4K/Retina displays
    const clampedDpr = Math.min(Math.max(dpr, 1), 1.5);
    const w = Math.max(1, Math.round(cssWidth * clampedDpr));
    const h = Math.max(1, Math.round(cssHeight * clampedDpr));
    if (w === this.width && h === this.height && clampedDpr === this.dpr) return;
    this.width = w;
    this.height = h;
    this.dpr = clampedDpr;
    this.canvas.width = w;
    this.canvas.height = h;
    gl.viewport(0, 0, w, h);
  }

  public render(params: OrbRenderParams): void {
    const gl = this.gl;
    const program = this.program;
    if (!gl || !program || this.lost) return;

    const palette = ORB_PALETTES[params.paletteKey] ?? ORB_PALETTES.connected;
    this.currentPrimary = lerp3(this.currentPrimary, palette.primary, 0.08);
    this.currentSecondary = lerp3(this.currentSecondary, palette.secondary, 0.08);
    this.currentAccent = lerp3(this.currentAccent, palette.accent, 0.08);

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(program);

    const u = this.uniforms;
    gl.uniform1f(u.u_time, params.time);
    gl.uniform1f(u.u_level, params.level);
    gl.uniform1f(u.u_reactivity, params.reactivity);
    gl.uniform1f(u.u_thinking, params.thinking);
    gl.uniform1f(u.u_idle, params.idle);
    gl.uniform2f(u.u_tilt, params.tiltX, params.tiltY);
    gl.uniform3fv(u.u_primary, this.currentPrimary);
    gl.uniform3fv(u.u_secondary, this.currentSecondary);
    gl.uniform3fv(u.u_accent, this.currentAccent);
    gl.uniform1f(u.u_dpr, this.dpr);
    gl.uniform2f(u.u_resolution, this.width, this.height);

    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
  }

  public dispose(): void {
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    const gl = this.gl;
    if (!gl) return;
    if (this.program) gl.deleteProgram(this.program);
    if (this.vbo) gl.deleteBuffer(this.vbo);
    if (this.vao) gl.deleteVertexArray(this.vao);
    this.program = null;
    this.vbo = null;
    this.vao = null;
    this.gl = null;
  }
}
