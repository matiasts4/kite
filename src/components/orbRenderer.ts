/**
 * WebGL2 Studio-Grade Interactive Multi-Mode Living Orb Renderer
 * Single low-overhead WebGL2 pipeline supporting 8 sculptural interactive 3D forms:
 *   0 = plasma-orb      (Volumetric liquid plasma & glass refraction)
 *   1 = ferrofluid      (100% solid sculpted magnetic liquid sphere — zero holes)
 *   2 = frosted-sphere  (Minimalist frosted satin glass with internal diffused light)
 *   3 = eclipse-halo    (Solid obsidian ceramic core with directional luminous corona)
 *   4 = silk-wave       (Crystal glass sphere enclosing fluid silk light ribbons)
 *   5 = crystal-prism   (Smoothly beveled 3D rounded gem with analytical SDF normals)
 *   6 = orbital-gyro    (Solid inner glass sphere with true 3D Z-occluded thin rings)
 *   7 = chromatic-pearl (Solid glossy pearl with physical thin-film iridescence)
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
uniform float u_hover;
uniform float u_ripple;
uniform float u_mode;
uniform vec2  u_tilt;
uniform vec2  u_ripple_origin;
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

float fbm2(vec3 p) {
  float v = 0.62 * snoise(p);
  v += 0.38 * snoise(p * 2.06 + vec3(13.4, 27.2, 9.1));
  return v;
}

vec3 fastWarp(vec3 p, float t) {
  return vec3(
    sin(p.y * 2.2 + t * 0.72),
    cos(p.z * 2.1 - t * 0.58),
    sin(p.x * 2.3 + t * 0.64)
  ) * 0.42;
}

mat3 rotY(float a) {
  float c = cos(a), s = sin(a);
  return mat3(c,0.0,s, 0.0,1.0,0.0, -s,0.0,c);
}

mat3 rotX(float a) {
  float c = cos(a), s = sin(a);
  return mat3(1.0,0.0,0.0, 0.0,c,-s, 0.0,s,c);
}

mat3 rotZ(float a) {
  float c = cos(a), s = sin(a);
  return mat3(c,-s,0.0, s,c,0.0, 0.0,0.0,1.0);
}

float safeAtan(float y, float x) {
  return (abs(x) + abs(y) < 1e-5) ? 0.0 : atan(y, x);
}

// Cohesive photographic studio environment reflection (softbox key + rim fill + subtle floor)
vec3 studioEnv(vec3 R, vec3 primary, vec3 secondary, vec3 accent, vec2 tilt) {
  float up = clamp(R.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 baseGrad = mix(secondary * 0.42, primary * 0.58 + vec3(0.08), smoothstep(0.15, 0.85, up));

  vec3 keyDir = normalize(vec3(-0.36 + tilt.x * 0.35, 0.72 - tilt.y * 0.25, 0.62));
  float keyBox = smoothstep(0.68, 0.96, dot(R, keyDir));
  float keyHalo = pow(max(dot(R, keyDir), 0.0), 10.0);

  vec3 fillDir = normalize(vec3(0.68, -0.28, 0.52));
  float fillStrip = smoothstep(0.62, 0.94, dot(R, fillDir));

  vec3 rimDir = normalize(vec3(0.18, -0.78, 0.48));
  float rimBounce = pow(max(dot(R, rimDir), 0.0), 5.0);

  vec3 col = baseGrad;
  col += vec3(1.0, 0.99, 0.97) * keyBox * 0.92;
  col += mix(vec3(1.0), accent, 0.45) * keyHalo * 0.42;
  col += accent * fillStrip * 0.48;
  col += primary * rimBounce * 0.38;
  return col;
}

// Interactive tactile ripple ring emanating smoothly from click/tap origin
float computeRipple(vec2 p, vec2 origin, float phase) {
  if (phase <= 0.001 || phase >= 0.999) return 0.0;
  float d = length(p - origin * 0.52);
  float targetR = phase * 1.16;
  float fade = (1.0 - phase) * (1.0 - phase);
  float rd = (d - targetR) * 16.0;
  return exp(-rd * rd) * fade;
}

// ── Mode 0: Orbe Plasma (Classic Glass-Refracted Volumetric Plasma) ─────────
vec4 renderPlasmaOrb(vec2 p, float t, float lvl, float react, float think, float hover, float rippleRing, float px) {
  vec2 c = p - u_tilt * (0.06 + hover * 0.025);
  float r = length(c);
  float angle = safeAtan(c.y, c.x);

  float baseRadius = 0.72 + lvl * 0.022 * react + hover * 0.018 + rippleRing * 0.02;
  float dispA = sin(angle * 3.0 + t * 0.9) * 0.004 + cos(angle * 2.0 - t * 0.65) * 0.003;
  float radius = baseRadius + dispA * (react + hover * 0.35);
  float edgeDist = r - radius;
  float sphereMask = 1.0 - smoothstep(-px * 1.5, px * 1.5, edgeDist);

  vec2 sn = c / max(radius, 0.0001);
  float z = sqrt(max(0.0, 1.0 - dot(sn, sn)));
  vec3 N = normalize(vec3(sn.x, sn.y, z + 0.0001));
  vec3 T = refract(vec3(0.0, 0.0, -1.0), N, 1.0 / 1.28);

  float spinSpeed = mix(0.12, 0.34, max(think * 0.75, max(lvl * 0.45, hover * 0.32)));
  mat3 spin = rotY(t * spinSpeed + u_tilt.x * 0.55) * rotX(sin(t * 0.16) * 0.18 - u_tilt.y * 0.55);

  vec3 accum = vec3(0.0);
  float densityAccum = 0.0;
  const int STEPS = 3;
  for (int i = 0; i < STEPS; i++) {
    float fi = float(i) / float(STEPS - 1);
    float depth = mix(0.22, 0.88, fi);
    vec3 samplePos = vec3(sn * (1.0 - depth * 0.34), z * depth) + T * depth * 0.34;
    samplePos = spin * samplePos;

    vec3 warp = fastWarp(samplePos * 1.35, t * (0.55 + think * 0.6));
    float f = fbm2(samplePos * 1.85 + warp * (0.52 + lvl * 0.42 + hover * 0.18));

    float ribbon = smoothstep(-0.18, 0.58, f);
    float coreWeight = exp(-dot(samplePos, samplePos) * 1.28);

    vec3 layerCol = mix(u_secondary, u_primary, smoothstep(-0.22, 0.48, f));
    layerCol = mix(layerCol, u_accent, pow(clamp(f + 0.38, 0.0, 1.0), 2.8) * (0.48 + lvl * 0.45 + hover * 0.2));

    float pulse = 0.94 + 0.16 * sin(t * 0.95 + fi * 2.1) * (lvl + hover * 0.25);
    float w = ribbon * (0.38 + 0.62 * coreWeight) * pulse;
    accum += layerCol * w;
    densityAccum += w;
  }

  vec3 plasma = accum / max(densityAccum, 0.001);
  plasma *= (0.80 + 0.50 * (densityAccum / float(STEPS)));

  float coreDist = length(sn - u_tilt * 0.18 - vec2(-0.05, 0.08));
  float core = exp(-coreDist * coreDist * (3.1 - lvl * 0.85 - hover * 0.35));
  vec3 coreCol = mix(u_primary, u_accent, 0.56 + 0.24 * sin(t * 0.72));
  plasma += coreCol * core * (0.68 + lvl * 0.52 + hover * 0.28);

  vec3 interior = mix(u_secondary * 0.22, plasma, clamp(densityAccum * 0.65, 0.0, 1.0));
  interior += plasma * 0.40;

  float fresnel = pow(1.0 - z, 2.5);
  float iridShift = sin(angle * 1.8 + t * 0.35 + r * 3.0) * 0.5 + 0.5;
  vec3 rimCol = mix(u_primary, u_accent, iridShift);
  interior = mix(interior, rimCol * (1.38 + hover * 0.32), fresnel * (0.62 + hover * 0.2));
  interior += u_accent * rippleRing * 0.82;

  interior *= mix(0.64, 1.06, smoothstep(0.0, 0.55, z));

  vec3 L1 = normalize(vec3(-0.46 + u_tilt.x * 0.28, 0.58 - u_tilt.y * 0.28, 0.68));
  vec3 H1 = normalize(L1 + vec3(0.0, 0.0, 1.0));
  float spec1 = pow(max(dot(N, H1), 0.0), 46.0);
  float spec1Soft = pow(max(dot(N, H1), 0.0), 10.0);
  vec3 L2 = normalize(vec3(0.55, -0.52, 0.65));
  vec3 H2 = normalize(L2 + vec3(0.0, 0.0, 1.0));
  float spec2 = pow(max(dot(N, H2), 0.0), 22.0);

  interior += vec3(1.0, 0.98, 0.95) * spec1 * (0.85 + hover * 0.2);
  interior += u_accent * spec1Soft * 0.24;
  interior += u_primary * spec2 * 0.35;

  float haloDist = max(edgeDist, 0.0);
  float halo1 = exp(-haloDist * 13.5) * (0.32 + lvl * 0.26 + hover * 0.2 + think * 0.1);
  float halo2 = exp(-haloDist * 4.8)  * (0.11 + lvl * 0.16 + hover * 0.09);
  vec3 halo = mix(u_primary, u_accent, 0.45 + 0.3 * sin(angle * 2.0 + t * 0.4)) * (halo1 + halo2);
  halo += u_accent * rippleRing * 0.52;

  vec3 col = interior * sphereMask + halo * (1.0 - sphereMask * 0.62);
  float alpha = clamp(sphereMask + (halo1 * 0.85 + halo2 * 0.62 + rippleRing * 0.48) * (1.0 - sphereMask), 0.0, 1.0);
  return vec4(col, alpha);
}

// ── Mode 1: Ferrofluido Sólido (100% Solid Sculpted Liquid Metal Sphere) ────
float sdSolidFerro(vec3 q, float t, float lvl, float react, float think, float hover, vec2 tilt) {
  float r = length(q);
  vec3 nq = q / max(r, 0.0001);
  float speed = t * (1.05 + think * 1.15);

  // Smooth continuous 3D spherical-harmonic organic liquid waves (zero holes or discontinuities)
  float harmonic =
    sin(nq.x * 3.4 + speed) * cos(nq.y * 3.2 - speed * 0.85) * 0.52 +
    sin(nq.z * 3.8 + speed * 0.72) * cos(nq.x * 2.6 + nq.y * 2.4) * 0.48;
  float micro = sin(nq.x * 5.8 - speed * 1.2) * sin(nq.y * 5.4 + speed * 0.9) * 0.25;

  // Magnetic attraction smoothly stretches the liquid toward cursor direction
  vec3 pullDir = normalize(vec3(tilt.x, tilt.y, 0.45));
  float magPull = max(0.0, dot(nq, pullDir)) * length(tilt) * (0.065 + hover * 0.045);

  float amp = 0.032 + lvl * 0.062 * react + hover * 0.024;
  float targetR = 0.72 + magPull + (harmonic + micro * (0.4 + lvl)) * amp;
  return (r - targetR) * 0.78;
}

vec3 calcFerroNormal(vec3 q, float t, float lvl, float react, float think, float hover, vec2 tilt) {
  const vec2 e = vec2(0.006, -0.006);
  return normalize(
    e.xyy * sdSolidFerro(q + e.xyy, t, lvl, react, think, hover, tilt) +
    e.yyx * sdSolidFerro(q + e.yyx, t, lvl, react, think, hover, tilt) +
    e.yxy * sdSolidFerro(q + e.yxy, t, lvl, react, think, hover, tilt) +
    e.xxx * sdSolidFerro(q + e.xxx, t, lvl, react, think, hover, tilt)
  );
}

vec4 renderFerrofluid(vec2 p, float t, float lvl, float react, float think, float hover, float rippleRing, float px) {
  vec2 c = p - u_tilt * (0.045 + hover * 0.02);
  vec3 ro = vec3(c, 2.0);
  vec3 rd = normalize(vec3(c * 0.14, -1.0));

  float dist = 0.0;
  float minD = 10.0;
  bool hit = false;
  vec3 hitPos = vec3(0.0);

  for (int i = 0; i < 20; i++) {
    vec3 q = ro + rd * dist;
    float d = sdSolidFerro(q, t, lvl, react, think, hover, u_tilt);
    minD = min(minD, d);
    if (d < 0.0025) {
      hit = true;
      hitPos = q;
      break;
    }
    dist += d;
    if (dist > 3.2) break;
  }

  vec3 col = vec3(0.0);
  float alpha = 0.0;

  if (hit) {
    vec3 N = calcFerroNormal(hitPos, t, lvl, react, think, hover, u_tilt);
    vec3 V = -rd;
    vec3 R = reflect(-V, N);
    float ndotv = clamp(dot(N, V), 0.0, 1.0);
    float fresnel = pow(1.0 - ndotv, 2.8);

    // 100% solid, continuous sculptural tinted-liquid albedo (ZERO holes or blotches)
    vec3 L1 = normalize(vec3(-0.42 + u_tilt.x * 0.45, 0.64 - u_tilt.y * 0.38, 0.72));
    vec3 L2 = normalize(vec3(0.62, -0.42, 0.56));
    float wrapDiff = clamp((dot(N, L1) + 0.42) / 1.42, 0.0, 1.0);
    float fillDiff = clamp(dot(N, L2), 0.0, 1.0);

    vec3 solidBody = mix(u_secondary * 0.78, u_primary * 0.96, wrapDiff);
    solidBody += u_accent * fillDiff * 0.22;

    // Studio liquid-metal reflection blended smoothly over the solid body
    vec3 env = studioEnv(R, u_primary, u_secondary, u_accent, u_tilt);
    vec3 H1 = normalize(L1 + V);
    float specCrisp = pow(max(dot(N, H1), 0.0), 64.0);
    float specBroad = pow(max(dot(N, H1), 0.0), 14.0);

    col = mix(solidBody, env * 1.12, 0.42 + fresnel * 0.45);
    col += mix(u_primary, u_accent, 0.65) * fresnel * (0.58 + hover * 0.34 + lvl * 0.22);
    col += vec3(1.0, 0.99, 0.97) * specCrisp * (0.95 + hover * 0.2);
    col += u_accent * specBroad * 0.26;
    col += u_accent * rippleRing * 0.72;
    alpha = 1.0;
  }

  // Smooth anti-aliased edge + restrained studio halo
  float haloDist = max(minD, 0.0);
  float halo1 = exp(-haloDist * 14.5) * (0.28 + lvl * 0.24 + hover * 0.2);
  float halo2 = exp(-haloDist * 5.2)  * (0.10 + lvl * 0.14);
  vec3 haloCol = mix(u_primary, u_accent, 0.48) * (halo1 + halo2) + u_accent * rippleRing * 0.45;

  if (!hit) {
    col = haloCol;
    alpha = clamp(halo1 * 0.85 + halo2 * 0.58 + rippleRing * 0.45, 0.0, 1.0);
  }
  float edgeAA = smoothstep(px * 2.0, -px * 1.2, minD);
  alpha = max(alpha, edgeAA);
  return vec4(col, alpha);
}

// ── Mode 2: Vidrio Satinado (Minimalist Frosted Glass with Internal Glow) ───
vec4 renderFrostedSphere(vec2 p, float t, float lvl, float react, float think, float hover, float rippleRing, float px) {
  vec2 c = p - u_tilt * (0.045 + hover * 0.02);
  float r = length(c);
  float radius = 0.73 + lvl * 0.02 * react + hover * 0.015 + rippleRing * 0.015;
  float edgeDist = r - radius;
  float mask = 1.0 - smoothstep(-px * 1.5, px * 1.5, edgeDist);

  vec2 sn = c / max(radius, 0.0001);
  float z = sqrt(max(0.0, 1.0 - dot(sn, sn)));
  vec3 N = normalize(vec3(sn.x, sn.y, z + 0.0001));
  vec3 V = vec3(0.0, 0.0, 1.0);

  // Frosted satin polycarbonate shell (soft gradient from cool pearl top to deep satin base)
  vec3 L1 = normalize(vec3(-0.35 + u_tilt.x * 0.25, 0.68 - u_tilt.y * 0.25, 0.68));
  float satinDiff = clamp((dot(N, L1) + 0.55) / 1.55, 0.0, 1.0);
  vec3 shellBase = mix(u_secondary * 0.52 + vec3(0.06, 0.07, 0.10), mix(u_primary, vec3(0.92, 0.94, 0.98), 0.34), satinDiff * 0.72);

  // Diffused internal light floating smoothly behind frosted glass, following cursor
  vec2 innerTarget = u_tilt * 0.26 + vec2(sin(t * 0.55), cos(t * 0.48)) * (0.05 + think * 0.08);
  float dCore = length(sn - innerTarget);
  float subGlowWide = exp(-dCore * dCore * (2.3 - lvl * 0.55 - hover * 0.25));
  float subGlowCore = exp(-dCore * dCore * (5.6 - lvl * 1.0));

  vec3 innerLight = u_primary * subGlowWide * (0.56 + lvl * 0.38 + hover * 0.18);
  innerLight += mix(u_accent, vec3(1.0), 0.22) * subGlowCore * (0.46 + lvl * 0.4 + hover * 0.2);

  // Broad velvety frosted highlight (low specular exponent = realistic matte satin finish)
  vec3 H1 = normalize(L1 + V);
  float frostedSheen = pow(max(dot(N, H1), 0.0), 7.5);
  float crispEdgeRim = pow(1.0 - z, 3.2);

  vec3 interior = shellBase * 0.76 + innerLight;
  interior += vec3(1.0, 0.99, 0.98) * frostedSheen * (0.24 + hover * 0.1);
  interior += mix(vec3(1.0), u_accent, 0.56) * crispEdgeRim * (0.76 + hover * 0.28 + lvl * 0.18);
  interior += u_accent * rippleRing * 0.68;

  // Delicate ambient glow outside the frosted glass
  float haloDist = max(edgeDist, 0.0);
  float halo1 = exp(-haloDist * 13.0) * (0.26 + lvl * 0.24 + hover * 0.18);
  float halo2 = exp(-haloDist * 4.6)  * (0.09 + lvl * 0.14);
  vec3 halo = mix(u_primary, u_accent, 0.5) * (halo1 + halo2) + u_accent * rippleRing * 0.45;

  vec3 col = interior * mask + halo * (1.0 - mask * 0.7);
  float alpha = clamp(mask + (halo1 * 0.8 + halo2 * 0.55 + rippleRing * 0.42) * (1.0 - mask), 0.0, 1.0);
  return vec4(col, alpha);
}

// ── Mode 3: Eclipse (Solid Ceramic Obsidian Core + Directional Solar Corona) ──
vec4 renderEclipseHalo(vec2 p, float t, float lvl, float react, float think, float hover, float rippleRing, float px) {
  vec2 c = p - u_tilt * (0.04 + hover * 0.02);
  float r = length(c);
  float angle = safeAtan(c.y, c.x);

  float coreR = 0.61 + lvl * 0.012 * react;
  float edgeDist = r - coreR;
  float coreMask = 1.0 - smoothstep(-px * 1.5, px * 1.5, edgeDist);

  // Crescent focus angle smoothly follows cursor (or orbits gently when idle)
  float tiltLen = length(u_tilt);
  vec2 dir = c / max(r, 0.0001);
  vec2 orbitDir = vec2(cos(t * (0.38 + think * 1.0)), sin(t * (0.38 + think * 1.0)));
  vec2 cursorDir = tiltLen > 0.04 ? normalize(u_tilt) : orbitDir;
  vec2 crownDir = normalize(mix(orbitDir, cursorDir, clamp(tiltLen * 1.4 + hover * 0.65, 0.0, 1.0)));

  float align = clamp(dot(dir, crownDir) * 0.5 + 0.5, 0.0, 1.0);
  float crescent = 0.32 + 0.68 * pow(align, 2.2);
  float diamondGlint = pow(max(0.0, dot(dir, crownDir)), 14.0);

  // Sleek polished dark ceramic core (subtle reflection so it feels 3D and substantial; zero center pinch)
  vec2 sn = c / max(coreR, 0.0001);
  float z = sqrt(max(0.0, 1.0 - dot(sn, sn)));
  vec3 N = normalize(vec3(sn.x, sn.y, z + 0.0001));
  vec3 R = reflect(vec3(0.0, 0.0, -1.0), N);
  float limbMask = smoothstep(0.55, 0.99, length(sn));
  float rim = pow(1.0 - z, 4.2) * limbMask;

  vec3 ceramicCore = mix(vec3(0.025, 0.03, 0.048), u_secondary * 0.2, 0.38) * (0.75 + 0.35 * z);
  ceramicCore += studioEnv(R, u_primary, u_secondary, u_accent, u_tilt) * (0.11 + hover * 0.06) * smoothstep(0.0, 0.6, z);
  // Crisp corona light wrap strictly along the outer limb (eliminates center cone artifact)
  ceramicCore += mix(u_primary, u_accent, align) * rim * (0.68 + crescent * 0.95 + lvl * 0.45);
  ceramicCore += u_accent * rippleRing * 0.45;

  // Razor-crisp corona right outside the limb + soft atmospheric bloom
  float outD = max(edgeDist, 0.0);
  float coronaTight = exp(-outD * (22.0 - lvl * 5.0 - hover * 3.0));
  float coronaMid   = exp(-outD * (8.5 - lvl * 2.0));
  float coronaSoft  = exp(-outD * 3.8);
  float shimmer = 0.92 + 0.08 * sin(angle * 6.0 - t * 1.6);

  vec3 coronaCol = mix(u_primary, u_accent, coronaTight * 0.65 + diamondGlint * 0.55) * shimmer;
  vec3 halo = coronaCol * (
    coronaTight * (1.28 + lvl * 0.55 + hover * 0.35) * crescent +
    coronaMid   * (0.46 + lvl * 0.38 + hover * 0.22) * crescent +
    coronaSoft  * (0.16 + lvl * 0.18)
  );
  halo += vec3(1.0, 0.98, 0.95) * coronaTight * diamondGlint * (0.85 + lvl * 0.6 + hover * 0.4);
  halo += u_accent * rippleRing * 0.68;

  vec3 col = ceramicCore * coreMask + halo * (1.0 - coreMask);
  float haloAlpha = clamp((coronaTight * 1.15 + coronaMid * 0.65 + coronaSoft * 0.4) * crescent + rippleRing * 0.5, 0.0, 1.0);
  float alpha = clamp(coreMask + haloAlpha * (1.0 - coreMask), 0.0, 1.0);
  return vec4(col, alpha);
}

// ── Mode 4: Seda Líquida (Glass Globe with Smooth Layered Silk Light Waves) ──
vec4 renderSilkWave(vec2 p, float t, float lvl, float react, float think, float hover, float rippleRing, float px) {
  vec2 c = p - u_tilt * (0.05 + hover * 0.02);
  float r = length(c);
  float radius = 0.73 + lvl * 0.018 * react + hover * 0.016 + rippleRing * 0.016;
  float edgeDist = r - radius;
  float mask = 1.0 - smoothstep(-px * 1.5, px * 1.5, edgeDist);

  vec2 sn = c / max(radius, 0.0001);
  float z = sqrt(max(0.0, 1.0 - dot(sn, sn)));
  vec3 N = normalize(vec3(sn.x, sn.y, z + 0.0001));

  // Tilt the internal silk ribbons gently in 2D/3D with the cursor
  float tiltRot = u_tilt.x * 0.32;
  float cr = cos(tiltRot), sr = sin(tiltRot);
  vec2 wp = vec2(sn.x * cr - sn.y * sr, sn.x * sr + sn.y * cr);
  wp.y -= u_tilt.y * 0.14;

  // Deep translucent glass interior
  vec3 interior = mix(u_secondary * 0.24, vec3(0.04, 0.05, 0.09), 0.58) * (0.75 + 0.4 * z);

  // 3 Silky translucent ribbon layers harmonizing smoothly with voice level
  float speed = t * (0.95 + think * 1.35 + lvl * 0.45);
  float amp = 0.12 + lvl * 0.22 * react + hover * 0.05 + rippleRing * 0.08;
  float envelope = clamp(1.0 - wp.x * wp.x * 0.85, 0.0, 1.0);
  float sphereFade = smoothstep(0.02, 0.48, z);

  vec3 ribbons = vec3(0.0);
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float freq = 2.4 + fi * 1.15;
    float phase = speed * (0.85 + fi * 0.28) + fi * 2.05;
    float waveY = sin(wp.x * freq + phase) * amp * envelope + (fi - 1.0) * 0.09;
    float dWave = abs(wp.y - waveY);
    float ribbonBand = exp(-dWave * (10.5 - fi * 1.2)) * sphereFade;
    float ribbonCrest = exp(-dWave * 28.0) * sphereFade * z;

    vec3 bandCol = i == 0
      ? mix(u_secondary, u_primary, 0.75)
      : (i == 1 ? mix(u_primary, u_accent, 0.45) : u_accent);
    ribbons += bandCol * ribbonBand * (0.58 + lvl * 0.42 + hover * 0.18);
    ribbons += mix(bandCol, vec3(1.0), 0.45) * ribbonCrest * (0.48 + lvl * 0.35);
  }

  interior += ribbons;

  // Clean optical glass sphere coating & studio speculars
  vec3 R = reflect(vec3(0.0, 0.0, -1.0), N);
  float fresnel = pow(1.0 - z, 2.8);
  vec3 L1 = normalize(vec3(-0.45 + u_tilt.x * 0.3, 0.62 - u_tilt.y * 0.3, 0.7));
  vec3 H1 = normalize(L1 + vec3(0.0, 0.0, 1.0));
  float spec = pow(max(dot(N, H1), 0.0), 54.0);

  interior += studioEnv(R, u_primary, u_secondary, u_accent, u_tilt) * (0.18 + fresnel * 0.58 + hover * 0.14);
  interior += vec3(1.0, 0.99, 0.97) * spec * (0.82 + hover * 0.2);
  interior += u_accent * rippleRing * 0.72;

  float haloDist = max(edgeDist, 0.0);
  float halo1 = exp(-haloDist * 14.0) * (0.28 + lvl * 0.24 + hover * 0.18);
  float halo2 = exp(-haloDist * 4.8)  * (0.10 + lvl * 0.14);
  vec3 halo = mix(u_primary, u_accent, 0.52) * (halo1 + halo2) + u_accent * rippleRing * 0.48;

  vec3 col = interior * mask + halo * (1.0 - mask * 0.65);
  float alpha = clamp(mask + (halo1 * 0.8 + halo2 * 0.55 + rippleRing * 0.45) * (1.0 - mask), 0.0, 1.0);
  return vec4(col, alpha);
}

// ── Mode 5: Gema Esculpida (Smoothly Beveled 3D Rounded Gem with True Normals)
float sdRoundedGem(vec3 q, float s, float bevel) {
  vec3 a = abs(q);
  float m = a.x + a.y + a.z - s;
  // Exact bounded octahedron SDF minus smooth bevel radius -> sleek sculptural facets
  return m * 0.57735027 - bevel;
}

vec3 calcGemNormal(vec3 q, float s, float bevel) {
  const vec2 e = vec2(0.005, -0.005);
  return normalize(
    e.xyy * sdRoundedGem(q + e.xyy, s, bevel) +
    e.yyx * sdRoundedGem(q + e.yyx, s, bevel) +
    e.yxy * sdRoundedGem(q + e.yxy, s, bevel) +
    e.xxx * sdRoundedGem(q + e.xxx, s, bevel)
  );
}

vec4 renderCrystalPrism(vec2 p, float t, float lvl, float react, float think, float hover, float rippleRing, float px) {
  vec2 c = p - u_tilt * (0.045 + hover * 0.02);
  float spinSpeed = mix(0.28, 0.85, max(think * 0.8, hover * 0.35));
  mat3 rot = rotY(t * spinSpeed + u_tilt.x * 0.95) * rotX(0.32 - u_tilt.y * 0.82 + sin(t * 0.28) * 0.1);

  float gemSize = 0.76 + lvl * 0.028 * react + hover * 0.022 + rippleRing * 0.018;
  float bevel = 0.075;
  vec3 ro = vec3(c, 2.0);
  vec3 rd = normalize(vec3(c * 0.16, -1.0));

  float dist = 0.0;
  float minD = 10.0;
  bool hit = false;
  vec3 hitLocal = vec3(0.0);

  for (int i = 0; i < 20; i++) {
    vec3 q = rot * (ro + rd * dist);
    float d = sdRoundedGem(q, gemSize, bevel);
    minD = min(minD, d);
    if (d < 0.0025) {
      hit = true;
      hitLocal = q;
      break;
    }
    dist += d;
    if (dist > 3.2) break;
  }

  vec3 col = vec3(0.0);
  float alpha = 0.0;

  if (hit) {
    vec3 localN = calcGemNormal(hitLocal, gemSize, bevel);
    vec3 N = normalize(transpose(rot) * localN);
    vec3 V = -rd;
    vec3 R = reflect(-V, N);
    float ndotv = clamp(dot(N, V), 0.0, 1.0);
    float fresnel = pow(1.0 - ndotv, 2.4);

    // Subtle smooth bevel edge catchlight without jagged sign() artifacts
    float edgeSoft = 1.0 - smoothstep(0.02, 0.22, min(abs(hitLocal.x), min(abs(hitLocal.y), abs(hitLocal.z))));

    // Rich optical facet shading: distinct dark-to-bright planes + smooth bevel catchlights
    vec3 L1 = normalize(vec3(-0.48 + u_tilt.x * 0.45, 0.65 - u_tilt.y * 0.4, 0.68));
    vec3 H1 = normalize(L1 + V);
    float facetLight = clamp(dot(N, L1), 0.0, 1.0);
    float spec = pow(max(dot(N, H1), 0.0), 64.0);

    vec3 prismShift = 0.5 + 0.5 * cos(6.28318 * (fresnel * 0.85 + vec3(0.0, 0.28, 0.58)));
    vec3 glassBody = mix(u_secondary * 0.36, u_primary * 0.92, 0.18 + 0.82 * facetLight);
    glassBody = mix(glassBody, mix(u_accent, prismShift, 0.32), fresnel * 0.48);

    // Calm glowing inner heart suspended inside the crystal
    float heart = exp(-length(c) * (4.4 - lvl * 1.15 - hover * 0.45));
    vec3 heartCol = mix(u_primary, u_accent, 0.62) * heart * (0.62 + lvl * 0.55 + hover * 0.24);

    vec3 env = studioEnv(R, u_primary, u_secondary, u_accent, u_tilt);

    col = mix(glassBody, env * 1.08, 0.28 + fresnel * 0.46) + heartCol;
    col += mix(vec3(1.0), u_accent, 0.55) * edgeSoft * (0.24 + hover * 0.2 + lvl * 0.16);
    col += vec3(1.0, 0.99, 0.97) * spec * (0.95 + hover * 0.22);
    col += u_accent * rippleRing * 0.85;
    alpha = 0.99;
  }

  float haloDist = max(minD, 0.0);
  float aura = exp(-haloDist * 13.5) * (0.34 + lvl * 0.26 + hover * 0.2 + think * 0.1);
  float outerGlow = exp(-haloDist * 4.8) * (0.11 + lvl * 0.15);
  vec3 haloCol = mix(u_primary, u_accent, 0.52) * (aura + outerGlow) + u_accent * rippleRing * 0.52;

  if (!hit) {
    col = haloCol;
    alpha = clamp(aura * 0.85 + outerGlow * 0.6 + rippleRing * 0.48, 0.0, 1.0);
  }
  float edgeAA = smoothstep(px * 2.0, -px * 1.2, minD);
  alpha = max(alpha, edgeAA * 0.98);
  return vec4(col, alpha);
}

// ── Mode 6: Esfera Orbital (Solid Inner Sphere + True 3D Z-Occluded Rings) ──
float sdTorusThin(vec3 q, float majorR, float minorR) {
  vec2 d = vec2(length(q.xz) - majorR, q.y);
  return length(d) - minorR;
}

vec4 renderOrbitalGyro(vec2 p, float t, float lvl, float react, float think, float hover, float rippleRing, float px) {
  vec2 c = p - u_tilt * (0.04 + hover * 0.02);
  vec3 ro = vec3(c, 2.2);
  vec3 rd = normalize(vec3(c * 0.14, -1.0));

  float coreR = 0.46 + lvl * 0.022 * react + hover * 0.016;
  float speed = t * (0.55 + think * 1.1 + hover * 0.25);

  mat3 ringRotA = rotX(1.12 - u_tilt.y * 0.55) * rotZ(0.42 + u_tilt.x * 0.45) * rotY(speed * 0.65);
  mat3 ringRotB = rotX(1.18 + u_tilt.y * 0.45) * rotZ(-0.58 + u_tilt.x * 0.4) * rotY(-speed * 0.52 + 1.4);

  float majorA = 0.74 + lvl * 0.018 * react + rippleRing * 0.02;
  float majorB = 0.83 + lvl * 0.024 * react + rippleRing * 0.025;
  float minorR = 0.028 + hover * 0.004;

  float dist = 0.0;
  float minCoreD = 10.0;
  float minRingD = 10.0;
  int hitKind = 0; // 1 = core sphere, 2 = ring A, 3 = ring B
  vec3 hitPos = vec3(0.0);

  for (int i = 0; i < 22; i++) {
    vec3 q = ro + rd * dist;
    float dCore = length(q) - coreR;
    float dRingA = sdTorusThin(ringRotA * q, majorA, minorR);
    float dRingB = sdTorusThin(ringRotB * q, majorB, minorR * 0.85);
    minCoreD = min(minCoreD, dCore);
    minRingD = min(minRingD, min(dRingA, dRingB));

    float d = min(dCore, min(dRingA, dRingB));
    if (d < 0.0025) {
      hitPos = q;
      if (dCore <= dRingA && dCore <= dRingB) {
        hitKind = 1;
      } else if (dRingA <= dRingB) {
        hitKind = 2;
      } else {
        hitKind = 3;
      }
      break;
    }
    dist += d;
    if (dist > 3.5) break;
  }

  vec3 col = vec3(0.0);
  float alpha = 0.0;

  if (hitKind == 1) {
    vec3 N = normalize(hitPos);
    vec3 V = -rd;
    vec3 R = reflect(-V, N);
    float ndotv = clamp(dot(N, V), 0.0, 1.0);
    float fresnel = pow(1.0 - ndotv, 2.6);

    vec3 L1 = normalize(vec3(-0.42 + u_tilt.x * 0.35, 0.64 - u_tilt.y * 0.35, 0.7));
    vec3 H1 = normalize(L1 + V);
    float diff = clamp((dot(N, L1) + 0.38) / 1.38, 0.0, 1.0);
    float spec = pow(max(dot(N, H1), 0.0), 58.0);

    vec3 coreSolid = mix(u_secondary * 0.65, u_primary * 0.95, diff);
    col = mix(coreSolid, studioEnv(R, u_primary, u_secondary, u_accent, u_tilt) * 1.05, 0.36 + fresnel * 0.45);
    col += mix(u_primary, u_accent, 0.6) * fresnel * (0.55 + hover * 0.35 + lvl * 0.25);
    col += vec3(1.0, 0.99, 0.97) * spec * 0.9;
    col += u_accent * rippleRing * 0.72;
    alpha = 1.0;
  } else if (hitKind == 2 || hitKind == 3) {
    vec3 localQ = (hitKind == 2 ? ringRotA : ringRotB) * hitPos;
    float rAngle = safeAtan(localQ.z, localQ.x);
    float pulseWave = 0.55 + 0.45 * sin(rAngle * 2.0 - speed * 2.4 + (hitKind == 3 ? 1.8 : 0.0));
    float depthShade = clamp(0.62 + hitPos.z * 0.48, 0.35, 1.15);

    vec3 ringCol = mix(u_primary, u_accent, pulseWave * 0.75 + (hitKind == 3 ? 0.2 : 0.0));
    col = ringCol * (1.05 + lvl * 0.45 + hover * 0.28) * depthShade;
    col += vec3(1.0, 0.99, 0.97) * pow(pulseWave, 4.0) * 0.42 * depthShade;
    col += u_accent * rippleRing * 0.8;
    alpha = 0.98;
  }

  float ringGlow = exp(-max(minRingD, 0.0) * 20.0) * (0.45 + lvl * 0.32 + hover * 0.24);
  float coreGlow = exp(-max(minCoreD, 0.0) * 11.0) * (0.32 + lvl * 0.24 + hover * 0.16);
  vec3 glowCol = mix(u_primary, u_accent, 0.55) * (ringGlow + coreGlow) + u_accent * rippleRing * 0.48;

  if (hitKind == 0) {
    col = glowCol;
    alpha = clamp(ringGlow * 0.9 + coreGlow * 0.75 + rippleRing * 0.45, 0.0, 1.0);
  } else {
    col += glowCol * 0.18;
  }

  float minAll = min(minCoreD, minRingD);
  float edgeAA = smoothstep(px * 2.0, -px * 1.2, minAll);
  alpha = max(alpha, edgeAA * 0.96);
  return vec4(col, alpha);
}

// ── Mode 7: Perla Iridiscente (Solid Glossy Thin-Film Interference Pearl) ───
vec4 renderChromaticPearl(vec2 p, float t, float lvl, float react, float think, float hover, float rippleRing, float px) {
  vec2 c = p - u_tilt * (0.05 + hover * 0.022);
  float r = length(c);
  float radius = 0.73 + lvl * 0.02 * react + hover * 0.016 + rippleRing * 0.016;
  float edgeDist = r - radius;
  float mask = 1.0 - smoothstep(-px * 1.5, px * 1.5, edgeDist);

  vec2 sn = c / max(radius, 0.0001);
  float z = sqrt(max(0.0, 1.0 - dot(sn, sn)));
  vec3 N = normalize(vec3(sn.x, sn.y, z + 0.0001));
  vec3 V = vec3(0.0, 0.0, 1.0);
  vec3 R = reflect(-V, N);
  float fresnel = pow(1.0 - z, 2.5);

  // Physical thin-film iridescent interference driven by viewing angle + cursor tilt + subtle liquid breath
  float filmShift =
    (1.0 - z) * 1.45 +
    dot(sn, u_tilt) * 0.42 +
    sin(sn.x * 2.4 + sn.y * 1.8 + t * (0.45 + think * 0.7)) * (0.08 + lvl * 0.14) +
    rippleRing * 0.55;
  vec3 thinFilm = 0.56 + 0.44 * cos(6.28318 * (filmShift * 0.65 + vec3(0.0, 0.28, 0.58)));

  // Solid creamy-satin pearl body harmonized with active state palette
  vec3 L1 = normalize(vec3(-0.42 + u_tilt.x * 0.38, 0.66 - u_tilt.y * 0.34, 0.72));
  vec3 H1 = normalize(L1 + V);
  float diff = clamp((dot(N, L1) + 0.48) / 1.48, 0.0, 1.0);
  float specSharp = pow(max(dot(N, H1), 0.0), 68.0);
  float specSoft = pow(max(dot(N, H1), 0.0), 12.0);

  vec3 pearlAlbedo = mix(u_secondary * 0.45 + vec3(0.18, 0.19, 0.24), mix(vec3(0.95, 0.96, 0.99), u_accent, 0.35), diff);
  vec3 iridTint = mix(u_primary, thinFilm, 0.62);
  vec3 interior = mix(pearlAlbedo, iridTint, 0.36 + fresnel * 0.48 + hover * 0.12);

  vec3 env = studioEnv(R, u_primary, u_secondary, u_accent, u_tilt);
  interior = mix(interior, env * 1.08, 0.22 + fresnel * 0.35);
  interior += vec3(1.0, 0.99, 0.98) * specSharp * (0.95 + hover * 0.18);
  interior += mix(u_accent, thinFilm, 0.5) * specSoft * 0.28;
  interior += mix(u_accent, vec3(1.0), 0.35) * rippleRing * 0.72;

  float haloDist = max(edgeDist, 0.0);
  float halo1 = exp(-haloDist * 14.0) * (0.26 + lvl * 0.24 + hover * 0.18);
  float halo2 = exp(-haloDist * 4.8)  * (0.09 + lvl * 0.14);
  vec3 halo = mix(u_primary, u_accent, 0.58) * (halo1 + halo2) + u_accent * rippleRing * 0.46;

  vec3 col = interior * mask + halo * (1.0 - mask * 0.68);
  float alpha = clamp(mask + (halo1 * 0.8 + halo2 * 0.55 + rippleRing * 0.44) * (1.0 - mask), 0.0, 1.0);
  return vec4(col, alpha);
}

void main() {
  vec2 p = (v_uv - 0.5) * 2.0;

  float t = u_time;
  float lvl = clamp(u_level, 0.0, 1.0);
  float react = clamp(u_reactivity, 0.0, 1.0);
  float think = clamp(u_thinking, 0.0, 1.0);
  float hover = clamp(u_hover, 0.0, 1.0);
  float px = 2.0 / max(u_resolution.x, 1.0);
  float rippleRing = computeRipple(p, u_ripple_origin, u_ripple);

  vec4 res;
  if (u_mode < 0.5) {
    res = renderPlasmaOrb(p, t, lvl, react, think, hover, rippleRing, px);
  } else if (u_mode < 1.5) {
    res = renderFerrofluid(p, t, lvl, react, think, hover, rippleRing, px);
  } else if (u_mode < 2.5) {
    res = renderFrostedSphere(p, t, lvl, react, think, hover, rippleRing, px);
  } else if (u_mode < 3.5) {
    res = renderEclipseHalo(p, t, lvl, react, think, hover, rippleRing, px);
  } else if (u_mode < 4.5) {
    res = renderSilkWave(p, t, lvl, react, think, hover, rippleRing, px);
  } else if (u_mode < 5.5) {
    res = renderCrystalPrism(p, t, lvl, react, think, hover, rippleRing, px);
  } else if (u_mode < 6.5) {
    res = renderOrbitalGyro(p, t, lvl, react, think, hover, rippleRing, px);
  } else {
    res = renderChromaticPearl(p, t, lvl, react, think, hover, rippleRing, px);
  }

  float idleDim = mix(1.0, 0.9, u_idle * (1.0 - hover * 0.65));
  vec3 col = res.rgb * idleDim;
  float alpha = clamp(res.a, 0.0, 1.0);

  // Filmic tone-mapping & crisp gamma polish
  col = col / (1.0 + col * 0.25);
  col = pow(max(col, vec3(0.0)), vec3(1.0 / 1.06));

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
    primary: [0.12, 0.85, 1.0], // Vibrant glowing electric cyan when recording
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
  hover?: number;
  ripple?: number;
  rippleOriginX?: number;
  rippleOriginY?: number;
  mode?: number;
  tiltX: number;
  tiltY: number;
  paletteKey: string;
  /** Snap palette immediately without lerp (used for 1-frame offscreen thumbnails). */
  snapPalette?: boolean;
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
  private preserveDrawingBuffer: boolean;

  private readonly onContextLost = (e: Event) => {
    e.preventDefault();
    this.lost = true;
  };

  private readonly onContextRestored = () => {
    this.lost = false;
    this.initPipeline();
  };

  constructor(canvas: HTMLCanvasElement, options?: { preserveDrawingBuffer?: boolean }) {
    this.canvas = canvas;
    this.preserveDrawingBuffer = Boolean(options?.preserveDrawingBuffer);
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
      preserveDrawingBuffer: this.preserveDrawingBuffer,
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
        'u_hover',
        'u_ripple',
        'u_mode',
        'u_tilt',
        'u_ripple_origin',
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
    if (params.snapPalette) {
      this.currentPrimary = [...palette.primary];
      this.currentSecondary = [...palette.secondary];
      this.currentAccent = [...palette.accent];
    } else {
      this.currentPrimary = lerp3(this.currentPrimary, palette.primary, 0.1);
      this.currentSecondary = lerp3(this.currentSecondary, palette.secondary, 0.1);
      this.currentAccent = lerp3(this.currentAccent, palette.accent, 0.1);
    }

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(program);

    const u = this.uniforms;
    gl.uniform1f(u.u_time, params.time);
    gl.uniform1f(u.u_level, params.level);
    gl.uniform1f(u.u_reactivity, params.reactivity);
    gl.uniform1f(u.u_thinking, params.thinking);
    gl.uniform1f(u.u_idle, params.idle);
    gl.uniform1f(u.u_hover, params.hover ?? 0);
    gl.uniform1f(u.u_ripple, params.ripple ?? 0);
    gl.uniform1f(u.u_mode, params.mode ?? 0);
    gl.uniform2f(u.u_tilt, params.tiltX, params.tiltY);
    gl.uniform2f(u.u_ripple_origin, params.rippleOriginX ?? 0, params.rippleOriginY ?? 0);
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

/**
 * Generates crisp static PNG thumbnails of every shader mode using ONE temporary offscreen
 * WebGL2 context that is disposed immediately — zero live WebGL contexts in Settings grids!
 */
let cachedThumbnails: Record<number, string> | null = null;

export function getOrbModeThumbnails(
  modes: readonly number[],
  paletteKey: string = 'listening'
): Record<number, string> {
  if (cachedThumbnails && modes.every((m) => Boolean(cachedThumbnails?.[m]))) {
    return cachedThumbnails;
  }
  if (typeof document === 'undefined') return {};

  const out: Record<number, string> = {};
  const canvas = document.createElement('canvas');
  const renderer = new OrbRenderer(canvas, { preserveDrawingBuffer: true });
  if (!renderer.isReady()) {
    renderer.dispose();
    return out;
  }

  try {
    renderer.resize(84, 84, 1.5);
    for (const mode of modes) {
      renderer.render({
        time: 2.35,
        level: 0.24,
        reactivity: 0.85,
        thinking: 0.0,
        idle: 0.0,
        hover: 0.28,
        ripple: 0.0,
        mode,
        tiltX: 0.26,
        tiltY: -0.22,
        paletteKey,
        snapPalette: true,
      });
      const url = canvas.toDataURL('image/png');
      if (url && url.startsWith('data:image/png')) {
        out[mode] = url;
      }
    }
    if (Object.keys(out).length > 0) {
      cachedThumbnails = { ...(cachedThumbnails ?? {}), ...out };
    }
  } catch {
    // Graceful fallback to CSS previews in non-WebGL environments
  } finally {
    renderer.dispose();
  }
  return cachedThumbnails ?? out;
}

export function clearOrbThumbnailCacheForTest(): void {
  cachedThumbnails = null;
}
