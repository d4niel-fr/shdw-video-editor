// Thin WebGL2 wrapper: programs, render targets, uploads, draws.

import { VS } from "./shaders";

export interface Target { fb: WebGLFramebuffer; tex: WebGLTexture; w: number; h: number }
export type Uniforms = Record<string, number | number[] | Float32Array | boolean>;

interface Prog { p: WebGLProgram; loc: Map<string, WebGLUniformLocation | null>; types: Map<string, number> }

export class GL {
  gl: WebGL2RenderingContext;
  float: boolean;
  private progs = new Map<string, Prog>();
  private vao: WebGLVertexArrayObject;
  private pool: Target[] = [];

  constructor(public canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, alpha: false, preserveDrawingBuffer: true, antialias: false })!;
    if (!gl) throw new Error("WebGL2 not available");
    this.gl = gl;
    this.float = !!gl.getExtension("EXT_color_buffer_float");
    gl.getExtension("OES_texture_float_linear");
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.disable(gl.BLEND);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  }

  /** Compile (cached by key). Throws with readable log on error. */
  program(key: string, fs: string): Prog {
    const hit = this.progs.get(key);
    if (hit) return hit;
    const gl = this.gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(s) ?? "";
        gl.deleteShader(s);
        throw new Error(prettyLog(log, src));
      }
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, "a_pos");
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link failed");
    const types = new Map<string, number>();
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i)!;
      types.set(info.name.replace(/\[0\]$/, ""), info.type);
    }
    const prog = { p, loc: new Map(), types };
    this.progs.set(key, prog);
    return prog;
  }

  hasProgram(key: string) { return this.progs.has(key); }
  dropPrograms(prefix: string) {
    for (const k of [...this.progs.keys()]) if (k.startsWith(prefix)) { this.gl.deleteProgram(this.progs.get(k)!.p); this.progs.delete(k); }
  }

  texture(): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  upload(tex: WebGLTexture, src: TexImageSource) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
  }

  /** Upload raw bottom-up RGBA bytes (already oriented for GL). */
  uploadRaw(tex: WebGLTexture, w: number, h: number, data: Uint8Array) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  }

  createTarget(w: number, h: number): Target {
    const gl = this.gl;
    const tex = this.texture();
    if (this.float) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { fb, tex, w, h };
  }

  /** Borrow a scratch target of the given size (return with release). */
  acquire(w: number, h: number): Target {
    const i = this.pool.findIndex((t) => t.w === w && t.h === h);
    if (i >= 0) return this.pool.splice(i, 1)[0];
    return this.createTarget(w, h);
  }
  release(t: Target) {
    this.pool.push(t);
    if (this.pool.length > 24) {
      const old = this.pool.shift()!;
      this.gl.deleteFramebuffer(old.fb); this.gl.deleteTexture(old.tex);
    }
  }
  clearPool() { for (const t of this.pool) { this.gl.deleteFramebuffer(t.fb); this.gl.deleteTexture(t.tex); } this.pool = []; }

  clear(t: Target | null, r = 0, g = 0, b = 0, a = 0) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fb : null);
    gl.viewport(0, 0, t ? t.w : this.canvas.width, t ? t.h : this.canvas.height);
    gl.clearColor(r, g, b, a);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /** Run a fullscreen pass. textures: uniform name -> texture (2D) or {tex3d}. */
  draw(prog: Prog, target: Target | null, uniforms: Uniforms, textures: Record<string, WebGLTexture | { tex3d: WebGLTexture }> = {}) {
    const gl = this.gl;
    gl.useProgram(prog.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
    gl.viewport(0, 0, target ? target.w : this.canvas.width, target ? target.h : this.canvas.height);
    let unit = 0;
    for (const [name, tex] of Object.entries(textures)) {
      const loc = this.loc(prog, name);
      if (loc == null) continue;
      gl.activeTexture(gl.TEXTURE0 + unit);
      if ((tex as any).tex3d) gl.bindTexture(gl.TEXTURE_3D, (tex as any).tex3d);
      else gl.bindTexture(gl.TEXTURE_2D, tex as WebGLTexture);
      gl.uniform1i(loc, unit++);
    }
    for (const [name, v] of Object.entries(uniforms)) {
      const loc = this.loc(prog, name);
      if (loc == null) continue;
      const type = prog.types.get(name);
      const arr = typeof v === "boolean" ? [v ? 1 : 0] : typeof v === "number" ? [v] : Array.from(v as number[]);
      switch (type) {
        case gl.FLOAT: gl.uniform1f(loc, arr[0] ?? 0); break;
        case gl.FLOAT_VEC2: gl.uniform2fv(loc, pad(arr, 2)); break;
        case gl.FLOAT_VEC3: gl.uniform3fv(loc, arr.length > 3 ? arr : pad(arr, 3)); break;
        case gl.FLOAT_VEC4: gl.uniform4fv(loc, pad(arr, 4)); break;
        case gl.INT: case gl.BOOL: gl.uniform1i(loc, Math.round(arr[0] ?? 0)); break;
        case gl.FLOAT_MAT3: gl.uniformMatrix3fv(loc, false, arr); break;
        case gl.FLOAT_MAT4: gl.uniformMatrix4fv(loc, false, arr); break;
        default: if (arr.length === 1) gl.uniform1f(loc, arr[0]);
      }
    }
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  private loc(prog: Prog, name: string) {
    if (!prog.loc.has(name)) prog.loc.set(name, this.gl.getUniformLocation(prog.p, name));
    return prog.loc.get(name)!;
  }

  /** Build a 3D LUT texture from a parsed .cube. */
  lut3d(size: number, data: Float32Array) {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_3D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, size, size, size, 0, gl.RGB, gl.FLOAT, data);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, p, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return t;
  }

  read(t: Target | null, w: number, h: number, out?: Uint8Array) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fb : null);
    const buf = out ?? new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return buf;
  }
}

const pad = (a: number[], n: number) => { const o = a.slice(0, n); while (o.length < n) o.push(0); return o; };

function prettyLog(log: string, src: string) {
  const lines = src.split("\n");
  return log.replace(/ERROR: 0:(\d+): /g, (_m, ln) => `line ${ln}: «${(lines[+ln - 1] ?? "").trim().slice(0, 80)}» `).trim();
}

export function parseCube(text: string) {
  let size = 0;
  const vals: number[] = [];
  let min = [0, 0, 0], max = [1, 1, 1];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("LUT_3D_SIZE")) { size = parseInt(line.split(/\s+/)[1]); continue; }
    if (line.startsWith("DOMAIN_MIN")) { min = line.split(/\s+/).slice(1).map(Number); continue; }
    if (line.startsWith("DOMAIN_MAX")) { max = line.split(/\s+/).slice(1).map(Number); continue; }
    if (/^[A-Z_]/.test(line)) continue;
    const p = line.split(/\s+/).map(Number);
    if (p.length >= 3) vals.push((p[0] - min[0]) / (max[0] - min[0]), (p[1] - min[1]) / (max[1] - min[1]), (p[2] - min[2]) / (max[2] - min[2]));
  }
  if (!size || vals.length < size * size * size * 3) throw new Error("invalid .cube LUT");
  return { size, data: new Float32Array(vals.slice(0, size * size * size * 3)) };
}
