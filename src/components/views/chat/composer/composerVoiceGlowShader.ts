export interface VoiceGlowPalette {
  deep: [number, number, number];
  core: [number, number, number];
  glint: [number, number, number];
}

export const DEFAULT_VOICE_GLOW_PALETTE: VoiceGlowPalette = {
  deep: [0.16, 0.25, 0.72],
  core: [0.36, 0.56, 1.0],
  glint: [0.68, 0.84, 1.0],
};

const VERTEX_SHADER_SOURCE = `attribute vec2 aPos;varying vec2 vUv;void main(){vUv=aPos*0.5+0.5;gl_Position=vec4(aPos,0.0,1.0);}`;

const FRAGMENT_SHADER_SOURCE = `
precision highp float;
varying vec2 vUv;
uniform vec2 uRes;
uniform float uDpr,uTime,uLevel,uActivity,uMix,uPresence,uDark;
uniform vec3 uAgentDeep,uAgentCore,uAgentGlint;

float hash21(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
float noise2(vec2 p){
  vec2 i=floor(p),f=fract(p),u=f*f*(3.0-2.0*f);
  return mix(mix(hash21(i),hash21(i+vec2(1.0,0.0)),u.x),mix(hash21(i+vec2(0.0,1.0)),hash21(i+vec2(1.0,1.0)),u.x),u.y);
}
float fbm(vec2 p){
  float sum=0.0,amp=0.5;mat2 rot=mat2(0.80,-0.60,0.60,0.80);
  for(int i=0;i<4;i++){sum+=amp*noise2(p);p=rot*p*2.03+vec2(17.1,31.7);amp*=0.5;}
  return sum;
}
float lobe(vec2 p,vec2 c,vec2 r){vec2 d=(p-c)/max(r,vec2(0.01));return exp(-dot(d,d));}
void main(){
  vec2 uv=vec2(vUv.x,clamp(1.0-vUv.y,0.0,1.0)),p=vec2((vUv.x-0.5)*2.0,vUv.y);
  float lvl=clamp(uLevel,0.0,1.0),act=clamp(uActivity,0.0,1.0),mixV=clamp(uMix,0.0,1.0),pres=clamp(uPresence,0.0,1.0),dm=clamp(uDark,0.0,1.0),lean=mix(-0.55,0.55,mixV);
  vec2 warp=vec2(fbm(p*vec2(1.8,2.4)+vec2(uTime*0.14,uTime*0.09))-0.5,fbm(p*vec2(2.1,1.9)+vec2(-uTime*0.11,uTime*0.13)+5.2)-0.5)*(0.20+lvl*0.18);
  vec2 wp=p+warp;
  float f=lobe(wp,vec2(lean*0.58+sin(uTime*0.37)*0.08,0.28+lvl*0.07),vec2(0.42+lvl*0.12,0.22+lvl*0.08))*0.42
    +lobe(wp,vec2(lean*0.82-0.24+cos(uTime*0.29)*0.10,0.23+lvl*0.05),vec2(0.36+act*0.10,0.19+lvl*0.06))*0.28
    +lobe(wp,vec2(lean*0.35+0.28+sin(uTime*0.43+1.4)*0.11,0.25+lvl*0.06),vec2(0.38+act*0.08,0.20+lvl*0.06))*0.26
    +lobe(wp,vec2(lean*0.48+cos(uTime*0.23+2.1)*0.14,0.38+lvl*0.08),vec2(0.50+lvl*0.10,0.25+act*0.07))*0.24
    +lobe(wp,vec2(lean*0.22+sin(uTime*0.19+0.7)*0.09,0.18),vec2(0.68,0.17+lvl*0.05))*0.30;
  float crest=exp(-pow((uv.y-(0.32+0.09*sin(uv.x*5.4-uTime*1.35+act*1.8)+0.07*lvl))*4.3,2.0));
  float lf=clamp(f*(0.76+lvl*0.46+act*0.28)+crest*(0.20+0.28*act+0.16*lvl),0.0,1.0);
  vec3 deepC=mix(vec3(0.05,0.40,0.58),uAgentDeep,mixV),coreC=mix(vec3(0.14,0.76,0.96),uAgentCore,mixV),glintC=mix(vec3(0.62,0.96,1.00),uAgentGlint,mixV);
  vec3 s0=mix(deepC*0.58,deepC*0.36,dm),s1=mix(mix(deepC,vec3(0.92,0.96,1.0),0.18),deepC,dm),s2=mix(mix(coreC,vec3(0.95,0.98,1.0),0.14),coreC,dm),s3=mix(mix(glintC,vec3(1.0),0.20),glintC,dm);
  vec3 col=mix(mix(mix(s0,s1,smoothstep(0.0,0.30,lf)),s2,smoothstep(0.30,0.66,lf)),s3,smoothstep(0.66,1.0,lf));
  col+=glintC*crest*(0.24+0.38*act)*mix(0.55,0.90,dm);
  vec2 res=uRes/max(uDpr,1.0);float persp=1.0/(0.55+uv.y);vec2 g=vec2(res.x*(uv.x-0.5)*persp,res.y*log(0.55+uv.y));
  float dotMask=1.0-smoothstep(0.16,0.32,length(fract(g/10.0)-0.5));
  float gridPulse=0.65+0.35*sin(g.x*0.05-uTime*1.8);
  col+=glintC*dotMask*gridPulse*smoothstep(0.05,0.54,lf)*(0.20+0.52*act)*mix(0.24,0.36,dm);
  col=clamp(col+(hash21(gl_FragCoord.xy+fract(uTime*17.3)*100.0)-0.5)*0.025*lf,0.0,1.0);
  float feather=smoothstep(0.01,0.16,vUv.x)*(1.0-smoothstep(0.84,0.99,vUv.x))*(1.0-smoothstep(0.64,0.99,vUv.y))*smoothstep(0.0,0.10,vUv.y);
  float alpha=clamp(lf*feather*pres*mix(0.76,0.96,dm),0.0,1.0);
  gl_FragColor=vec4(col*alpha,alpha);
}`;

const UNIFORM_KEYS = [
  'uRes', 'uDpr', 'uTime', 'uLevel', 'uActivity', 'uMix',
  'uPresence', 'uDark', 'uAgentDeep', 'uAgentCore', 'uAgentGlint',
] as const;
type UniformKey = (typeof UNIFORM_KEYS)[number];

/**
 * WebGL framebuffer renderer for the composer's ambient multi-lobe voice horizon shader.
 */
export class VoiceGlowWebGLRenderer {
  private gl: WebGLRenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private vbo: WebGLBuffer | null = null;
  private uniforms: Record<UniformKey, WebGLUniformLocation | null> | null = null;
  private width = 0;
  private height = 0;
  private dpr = 1;
  private lost = false;

  private readonly onContextLost = (e: Event) => {
    e.preventDefault();
    this.lost = true;
  };
  private readonly onContextRestored = () => {
    this.lost = false;
    this.initPipeline();
  };

  constructor(private readonly canvas: HTMLCanvasElement) {
    canvas.addEventListener('webglcontextlost', this.onContextLost, false);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored, false);
    this.initPipeline();
  }

  public isReady(): boolean {
    return this.gl !== null && this.program !== null && !this.lost;
  }

  private compileShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
    const shader = gl.createShader(type);
    if (!shader) throw new Error('WebGL createShader returned null');
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(shader) ?? 'unknown shader compile error';
      gl.deleteShader(shader);
      throw new Error(info);
    }
    return shader;
  }

  private initPipeline(): void {
    const attrs: WebGLContextAttributes = {
      alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: 'low-power',
    };
    let gl: WebGLRenderingContext | null = null;
    try {
      gl =
        (this.canvas.getContext('webgl2', attrs) as WebGLRenderingContext | null) ??
        (this.canvas.getContext('webgl', attrs) as WebGLRenderingContext | null);
    } catch (err) {
      console.warn('[ComposerVoiceGlow] WebGL context acquisition failed, using fallback:', err);
      gl = null;
    }
    if (!gl) {
      this.gl = null;
      this.program = null;
      return;
    }

    let vs: WebGLShader | null = null;
    let fs: WebGLShader | null = null;
    let program: WebGLProgram | null = null;
    try {
      vs = this.compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER_SOURCE);
      fs = this.compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SOURCE);
      program = gl.createProgram();
      if (!program) throw new Error('WebGL createProgram returned null');
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      vs = null;
      fs = null;
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(program) ?? 'unknown program link error');
      }
      const vbo = gl.createBuffer();
      if (!vbo) throw new Error('WebGL createBuffer returned null');
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
      const aPos = gl.getAttribLocation(program, 'aPos');
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

      const uniforms = {} as Record<UniformKey, WebGLUniformLocation | null>;
      for (const key of UNIFORM_KEYS) uniforms[key] = gl.getUniformLocation(program, key);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      this.gl = gl;
      this.program = program;
      this.vbo = vbo;
      this.uniforms = uniforms;
    } catch (err) {
      console.warn('[ComposerVoiceGlow] WebGL shader setup failed, using CSS fallback:', err);
      if (vs) gl.deleteShader(vs);
      if (fs) gl.deleteShader(fs);
      if (program) gl.deleteProgram(program);
      this.gl = null;
      this.program = null;
      this.vbo = null;
      this.uniforms = null;
    }
  }

  public resize(cssWidth: number, cssHeight: number, rawDpr = window.devicePixelRatio || 1): void {
    const gl = this.gl;
    if (!gl) return;
    const clampedDpr = Math.min(Math.max(rawDpr || 1, 1), 2);
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

  public render(params: {
    time: number; level: number; activity: number; mix: number; presence: number; dark: number; palette: VoiceGlowPalette;
  }): void {
    const gl = this.gl, program = this.program, u = this.uniforms;
    if (!gl || !program || !u || this.lost) return;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(program);
    gl.uniform2f(u.uRes, this.width, this.height);
    gl.uniform1f(u.uDpr, this.dpr);
    gl.uniform1f(u.uTime, params.time);
    gl.uniform1f(u.uLevel, params.level);
    gl.uniform1f(u.uActivity, params.activity);
    gl.uniform1f(u.uMix, params.mix);
    gl.uniform1f(u.uPresence, params.presence);
    gl.uniform1f(u.uDark, params.dark);
    gl.uniform3fv(u.uAgentDeep, params.palette.deep);
    gl.uniform3fv(u.uAgentCore, params.palette.core);
    gl.uniform3fv(u.uAgentGlint, params.palette.glint);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  public dispose(): void {
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    if (this.gl) {
      if (this.vbo) this.gl.deleteBuffer(this.vbo);
      if (this.program) this.gl.deleteProgram(this.program);
    }
    this.vbo = null;
    this.program = null;
    this.uniforms = null;
    this.gl = null;
  }
}
