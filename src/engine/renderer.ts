// GPU compositor: turns the timeline at time t into a frame.
// Pipeline per layer: source → fit/crop → effects → grade → transform+blend.

import { GL, Target, parseCube } from "./gl";
import {
  FS_FIT, FS_COPY, FS_SOLID, FS_GRADIENT, FS_GRADE, BLEND_FUNCS, compositeFS, EFFECTS, effectFS,
  TRANSITIONS, transitionFS, motionFS,
} from "./shaders";
import { Clip, Project, Track, clipEnd, prop, hexToRgb, mediaOf, Grade } from "../model";
import { store } from "../store";
import { pool, drawText, videoSourceTime } from "./sources";
import { getModule, paramUniforms, paramValues, defaultsOf, pendingModules, UserModule } from "./modules";
import { kit } from "../kit/kit";
import { fs } from "../ipc";
import { htmlFrames } from "./html";

const PX_PARAMS = new Set(["radius", "length", "size", "x", "y", "blur"]);

export interface Layer { clip: Clip; track: Track; lt: number }

/**
 * Live preview plan: HTML layers play as real DOM (iframes) over/under the
 * WebGL canvas instead of screenshots. `null` when the frame can't be split
 * (e.g. video both above and below HTML) → exact compositor path.
 */
export interface LivePlan {
  html: { layer: Layer; from?: Layer; z: number }[];
  overlays: { layer: Layer; z: number }[];   // adjustment layers above HTML → CSS approximations
  skip: Set<string>;                          // clip ids the canvas must not draw
  canvasOnTop: boolean;
}

export class Renderer {
  gl: GL;
  W = 1920; H = 1080; scale = 0.5;
  private accA!: Target; private accB!: Target; private empty!: Target;
  private texCache = new WeakMap<object, WebGLTexture>();
  private canvases = new Map<string, HTMLCanvasElement>();
  private luts = new Map<string, { tex: WebGLTexture; size: number } | "loading" | "error">();
  private exporting = false;
  /** true while an export / frame grab owns the GL context */
  locked = 0;
  /** export: decoded frames keyed by clip id (bottom-up RGBA) */
  rawFrames = new Map<string, { data: Uint8Array; w: number; h: number }>();
  /** exact renders: the HTML frame prepare() received, immune to cache-key races */
  htmlReady = new Map<string, ImageBitmap>();
  private rawTex = new Map<string, WebGLTexture>();
  lastError = "";

  constructor(public canvas: HTMLCanvasElement) {
    this.gl = new GL(canvas);
  }

  get tw() { return Math.max(2, Math.round(this.W * this.scale / 2) * 2); }
  get th() { return Math.max(2, Math.round(this.H * this.scale / 2) * 2); }

  configure(p: Project, scale: number) {
    const { width, height } = p.settings;
    if (width !== this.W || height !== this.H || scale !== this.scale || !this.accA) {
      this.W = width; this.H = height; this.scale = scale;
      this.gl.clearPool();
      if (this.accA) { this.gl.gl.deleteTexture(this.accA.tex); this.gl.gl.deleteTexture(this.accB.tex); }
      this.accA = this.gl.createTarget(this.tw, this.th);
      this.accB = this.gl.createTarget(this.tw, this.th);
      if (this.empty) this.gl.gl.deleteTexture(this.empty.tex);
      this.empty = this.gl.createTarget(this.tw, this.th);
      this.gl.clear(this.empty);
      this.canvas.width = this.tw;
      this.canvas.height = this.th;
    }
  }

  live: LivePlan | null = null;

  livePlan(p: Project, t: number): LivePlan | null {
    const entries = this.layersAt(p, t);
    const isHtml = (l?: Layer) => l?.clip.source.type === "html";
    const idx: number[] = [];
    for (let i = 0; i < entries.length; i++) {
      const { layer, from } = entries[i];
      if (isHtml(layer) || isHtml(from)) {
        if (from && isHtml(layer) !== isHtml(from)) return null; // html <-> video transition: exact path
        idx.push(i);
      }
    }
    if (!idx.length) return null;
    const first = idx[0], last = idx[idx.length - 1];
    let below = false, above = false;
    for (let i = 0; i < entries.length; i++) {
      if (idx.includes(i) || entries[i].layer.clip.source.type === "adjustment") continue;
      if (i < first) below = true; else if (i > last) above = true; else return null;
    }
    if (below && above) return null;
    const plan: LivePlan = { html: [], overlays: [], skip: new Set(), canvasOnTop: above };
    entries.forEach((e, i) => {
      if (idx.includes(i)) {
        plan.html.push({ ...e, z: i + 1 });
        plan.skip.add(e.layer.clip.id); if (e.from) plan.skip.add(e.from.clip.id);
      } else if (e.layer.clip.source.type === "adjustment" && (above || i > first)) {
        plan.overlays.push({ layer: e.layer, z: i + 1 });
        plan.skip.add(e.layer.clip.id);
      }
    });
    return plan;
  }

  // ---------- layer discovery ----------
  layersAt(p: Project, t: number): { layer: Layer; from?: Layer }[] {
    const vTracks = p.tracks.filter((tr) => tr.kind === "video" || tr.kind === "subtitle");
    const ordered = [...vTracks.filter((tr) => tr.kind === "video"), ...vTracks.filter((tr) => tr.kind === "subtitle")];
    const solo = ordered.some((tr) => tr.solo);
    const out: { layer: Layer; from?: Layer }[] = [];
    for (const track of ordered) {
      if (track.hidden || (solo && !track.solo)) continue;
      const clips = p.clips.filter((c) => c.track === track.id && c.enabled !== false && t >= c.start && t < clipEnd(c));
      for (const clip of clips.sort((a, b) => a.start - b.start)) {
        if (mediaOf(p, clip)?.kind === "audio") continue;
        const entry: { layer: Layer; from?: Layer } = { layer: { clip, track, lt: t - clip.start } };
        const tr = clip.transition;
        if (tr && tr.duration > 0 && t < clip.start + tr.duration) {
          const prev = p.clips.find((o) => o.track === track.id && o.id !== clip.id && o.enabled !== false && Math.abs(clipEnd(o) - clip.start) < 1.5 / p.settings.fps);
          if (prev) entry.from = { clip: prev, track, lt: t - prev.start };
        }
        out.push(entry);
      }
    }
    return out;
  }

  /** Make sure everything needed for an exact frame at t is decoded/loaded. */
  /** Never let a stuck source wedge the editor: cap preparation at 75s. */
  async prepare(p: Project, t: number, rawVideo = false) {
    this.htmlReady.clear();
    let timer = 0;
    await Promise.race([
      this.prepareInner(p, t, rawVideo),
      new Promise<void>((res) => { timer = window.setTimeout(() => { store.error("render", `frame ${t.toFixed(2)}s: sources not ready after 75s — rendering anyway`); res(); }, 75000); }),
    ]);
    clearTimeout(timer);
  }

  private async prepareInner(p: Project, t: number, rawVideo = false) {
    for (let i = 0; i < 100 && pendingModules() > 0; i++) await new Promise((r) => setTimeout(r, 20));
    const fps = p.settings.fps;
    const jobs: Promise<void>[] = [];
    for (const { layer, from } of this.layersAt(p, t)) {
      for (const l of from ? [layer, from] : [layer]) {
        const m = mediaOf(p, l.clip);
        if (m?.kind === "video" && rawVideo && this.rawFrames.has(l.clip.id)) { /* decoded by ffmpeg */ }
        else if (m?.kind === "video") {
          const el = pool.video(l.clip, m);
          if (!el.paused) el.pause();
          jobs.push(pool.seekExact(el, videoSourceTime(l.clip, l.lt, m), fps));
        } else if (m?.kind === "image") pool.image(store.abs(m.path));
        if (l.clip.source.type === "motion") getModule((l.clip.source as any).module);
        if (l.clip.source.type === "html") { const id = l.clip.id; jobs.push(htmlFrames.request(l.clip, l.lt, this.scale, 0).then((b) => { if (b) this.htmlReady.set(id, b); })); }
        for (const e of l.clip.effects ?? []) if (e.type.includes("/")) getModule(e.type);
        if (l.clip.blend?.includes("/")) getModule(l.clip.blend);
        if (l.clip.transition?.type.includes("/")) getModule(l.clip.transition.type);
      }
    }
    await Promise.all(jobs);
    await document.fonts.ready;
    for (let i = 0; i < 200 && (pool.imagesPending() > 0 || pendingModules() > 0); i++) await new Promise((r) => setTimeout(r, 15));
  }

  // ---------- main entry ----------
  render(p: Project, t: number, exporting = false) {
    this.exporting = exporting;
    const g = this.gl;
    const bg = hexToRgb(p.settings.background ?? "#000");
    const live = exporting ? null : this.live;
    if (live?.canvasOnTop) g.clear(this.accA, 0, 0, 0, 0);
    else g.clear(this.accA, bg[0] / 255, bg[1] / 255, bg[2] / 255, 1);
    for (const { layer, from } of this.layersAt(p, t)) {
      if (live?.skip.has(layer.clip.id)) continue;
      try {
        if (layer.clip.source.type === "adjustment") { this.applyAdjustment(layer); continue; }
        if (from) this.compositeTransition(p, from, layer);
        else {
          const L = this.renderLayer(p, layer);
          if (!L) continue;
          this.composite(L, layer.clip, layer.lt);
          g.release(L);
        }
      } catch (e: any) {
        store.error(layer.clip.name ?? layer.clip.id, e?.message ?? String(e));
      }
    }
    g.draw(g.program("copy", FS_COPY), null, { uOpacity: 1 }, { src: this.accA.tex });
  }

  /** Render one clip's pixels (fit, effects, grade) into a pooled comp-size target. */
  private renderLayer(p: Project, l: Layer): Target | null {
    const g = this.gl;
    const L = g.acquire(this.tw, this.th);
    g.clear(L);
    const ok = this.drawSource(p, l, L);
    if (!ok) { g.release(L); return null; }
    let cur = this.applyEffects(l.clip, l.lt, L);
    cur = this.applyGrade(l.clip, l.lt, cur);
    return cur;
  }

  private drawSource(p: Project, l: Layer, L: Target): boolean {
    const g = this.gl, c = l.clip, src: any = c.source;
    const tr = c.transform ?? {};
    const fitUniforms = (sw: number, sh: number, fill = 0) => ({
      uSrcSize: [sw, sh], uDstSize: [this.tw, this.th], uFill: fill,
      uCrop: [prop(c, "transform.cropLeft", l.lt, tr.cropLeft ?? 0), prop(c, "transform.cropRight", l.lt, tr.cropRight ?? 0),
        prop(c, "transform.cropTop", l.lt, tr.cropTop ?? 0), prop(c, "transform.cropBottom", l.lt, tr.cropBottom ?? 0)],
      uFlip: [tr.flipH ? 1 : 0, tr.flipV ? 1 : 0],
    });
    switch (src.type) {
      case "media": {
        const m = mediaOf(p, c);
        if (!m) return false;
        if (m.kind === "image") {
          const img = pool.image(store.abs(m.path));
          if (!img) return false;
          g.draw(g.program("fit", FS_FIT), L, fitUniforms(img.naturalWidth, img.naturalHeight), { src: this.tex(img, !this.texCache.has(img)) });
          return true;
        }
        const raw = this.exporting ? this.rawFrames.get(c.id) : undefined;
        if (raw) {
          let tx = this.rawTex.get(c.id);
          if (!tx) { tx = g.texture(); this.rawTex.set(c.id, tx); }
          g.uploadRaw(tx, raw.w, raw.h, raw.data);
          g.draw(g.program("fit", FS_FIT), L, fitUniforms(raw.w, raw.h), { src: tx });
          return true;
        }
        const el = pool.video(c, m);
        if (!this.exporting && !store.playing) {
          const want = videoSourceTime(c, l.lt, m);
          if (Math.abs(el.currentTime - want) > 0.5 / p.settings.fps && !el.seeking) el.currentTime = want;
        }
        if (!pool.ready(el)) return false;
        g.draw(g.program("fit", FS_FIT), L, fitUniforms(el.videoWidth, el.videoHeight), { src: this.tex(el, true) });
        return true;
      }
      case "solid": {
        const [r, gg, b] = hexToRgb(prop(c, "params.color", l.lt, src.color ?? "#000"));
        g.draw(g.program("solid", FS_SOLID), L, { uColor: [r / 255, gg / 255, b / 255, 1] });
        return true;
      }
      case "gradient": {
        const cols = (src.colors?.length ? src.colors : ["#000", "#fff"]).slice(0, 8);
        const flat: number[] = [];
        for (let i = 0; i < 8; i++) flat.push(...hexToRgb(cols[Math.min(i, cols.length - 1)]).map((v) => v / 255));
        g.draw(g.program("gradient", FS_GRADIENT), L, { uColors: flat, uCount: cols.length, uAngle: prop(c, "params.angle", l.lt, src.angle ?? 180), uRadial: src.radial ? 1 : 0, uSize: [this.tw, this.th] });
        return true;
      }
      case "text": case "subtitle": {
        const cv = this.canvas2d(c.id);
        const ctx = cv.getContext("2d")!;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, cv.width, cv.height);
        ctx.scale(this.scale, this.scale);
        if (src.type === "text") {
          const style: any = { ...src };
          for (const k of ["size", "color", "tracking", "weight"]) style[k] = prop(c, `params.${k}`, l.lt, src[k]);
          drawText(ctx, this.W, this.H, prop(c, "params.text", l.lt, src.text ?? ""), style, l.lt, c.duration, src.animDuration ?? 0.6);
        } else {
          const st = { size: 54, weight: 600, color: "#fff", ...(l.track.style ?? {}), animation: "none" };
          drawText(ctx, this.W, this.H, src.text ?? "", st, l.lt, c.duration, 0.2, this.H * (st.y ?? 0.88));
        }
        g.draw(g.program("fit", FS_FIT), L, fitUniforms(cv.width, cv.height), { src: this.tex(cv, true) });
        return true;
      }
      case "html": {
        const fps = p.settings.fps;
        const key = htmlFrames.key(c, l.lt, this.scale, fps);
        let bmp = this.exporting ? this.htmlReady.get(c.id) ?? htmlFrames.get(key, c.id) : htmlFrames.get(key, c.id);
        if (!bmp && !this.exporting) {
          if (!htmlFrames.cached(key)) void htmlFrames.request(c, l.lt, this.scale, store.playing ? 1 : 0);
          bmp = htmlFrames.fallback(c.id);
        }
        if (store.playing) for (let i = 1; i <= 12; i++) htmlFrames.warm(c, l.lt + i / fps, this.scale);
        if (!bmp) return false;
        let tx = this.rawTex.get("html:" + c.id);
        if (!tx) { tx = g.texture(); this.rawTex.set("html:" + c.id, tx); }
        if ((tx as any).__bmp !== bmp) {
          g.gl.bindTexture(g.gl.TEXTURE_2D, tx);
          g.gl.texImage2D(g.gl.TEXTURE_2D, 0, g.gl.RGBA, g.gl.RGBA, g.gl.UNSIGNED_BYTE, bmp);
          (tx as any).__bmp = bmp;
        }
        g.draw(g.program("fit", FS_FIT), L, fitUniforms(bmp.width, bmp.height, 1), { src: tx });
        return true;
      }
      case "motion": {
        const mod = getModule(src.module);
        if (!mod) return false;
        const params = { ...defaultsOf(mod.params), ...(src.params ?? {}) };
        for (const k of Object.keys(params)) params[k] = prop(c, `params.${k}`, l.lt, params[k]);
        const fps = p.settings.fps;
        if (mod.fragment) {
          const key = `motion:${mod.__path}:${mod.__version}`;
          const prog = g.program(key, motionFS(mod.fragment, paramUniforms(mod.params, params)));
          g.draw(prog, L, { iResolution: [this.tw, this.th, 1], iTime: l.lt, iProgress: l.lt / c.duration, iDuration: c.duration, iFrame: Math.round(l.lt * fps), ...paramValues(mod.params, params) });
          return true;
        }
        const cv = this.canvas2d(c.id);
        const ctx = cv.getContext("2d")!;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1; ctx.filter = "none"; ctx.shadowBlur = 0; ctx.globalCompositeOperation = "source-over";
        ctx.clearRect(0, 0, cv.width, cv.height);
        ctx.scale(this.scale, this.scale);
        try {
          ctx.save();
          mod.render!(ctx, l.lt, this.motionApi(mod, c, l.lt, params, fps));
          ctx.restore();
          store.clearErrors(mod.__path + "#render");
        } catch (e: any) {
          store.error(mod.__path + "#render", e?.message ?? String(e));
        }
        g.draw(g.program("fit", FS_FIT), L, fitUniforms(cv.width, cv.height), { src: this.tex(cv, true) });
        return true;
      }
    }
    return false;
  }

  private motionApi(mod: UserModule, c: Clip, lt: number, params: any, fps: number) {
    return {
      width: this.W, height: this.H, fps, duration: c.duration, frame: Math.round(lt * fps), progress: lt / c.duration, time: lt,
      params, kit, clip: c,
      image: (path: string) => pool.image(store.abs(path)),
      scale: this.scale, module: mod.__path,
    };
  }

  private canvas2d(id: string) {
    let cv = this.canvases.get(id);
    if (!cv) { cv = document.createElement("canvas"); this.canvases.set(id, cv); }
    if (cv.width !== this.tw || cv.height !== this.th) { cv.width = this.tw; cv.height = this.th; }
    return cv;
  }

  private tex(src: TexImageSource & object, upload: boolean) {
    let t = this.texCache.get(src);
    if (!t) { t = this.gl.texture(); this.texCache.set(src, t); }
    if (upload) this.gl.upload(t, src);
    return t;
  }

  // ---------- effects ----------
  private applyEffects(c: Clip, lt: number, input: Target): Target {
    const effects = (c.effects ?? []).filter((e) => e.enabled !== false);
    if (!effects.length) return input;
    const g = this.gl;
    let cur = input;
    effects.forEach((e, idx) => {
      const values: Record<string, any> = { ...(e.params ?? {}) };
      let glsl: string, specs: any, passes: Record<string, any>[] = [{}], key: string;
      const builtin = EFFECTS[e.type];
      if (builtin) {
        glsl = builtin.glsl; specs = builtin.params; passes = builtin.passes ?? [{}]; key = `fx:${e.type}`;
      } else {
        const mod = getModule(e.type);
        if (!mod?.fragment) return;
        glsl = mod.fragment; specs = mod.params; key = `fx:${mod.__path}:${mod.__version}`;
      }
      for (const k of Object.keys({ ...defaultsOf(specs), ...values })) {
        let v = prop(c, `effects.${idx}.${k}`, lt, values[k] ?? specs?.[k]?.default);
        if (builtin && PX_PARAMS.has(k) && typeof v === "number") v *= this.scale;
        values[k] = v;
      }
      const prog = g.program(key, effectFS(glsl, paramUniforms(specs, values)));
      const effOrig = cur;
      let passIn = cur;
      for (const pass of passes) {
        const out = g.acquire(this.tw, this.th);
        g.draw(prog, out, { iResolution: [this.tw, this.th, 1], iTime: lt, ...paramValues(specs, values), ...pass }, { src: passIn.tex, orig: effOrig.tex });
        if (passIn !== effOrig) g.release(passIn);
        passIn = out;
      }
      if (passIn !== effOrig) { g.release(effOrig); cur = passIn; }
    });
    return cur;
  }

  private gradeActive(gr?: Grade) {
    if (!gr) return false;
    const z = (a?: number[]) => !a || a.every((v) => Math.abs(v) < 1e-4);
    return !!gr.lut || Math.abs(gr.exposure ?? 0) > 1e-4 || Math.abs((gr.contrast ?? 1) - 1) > 1e-4 || Math.abs((gr.saturation ?? 1) - 1) > 1e-4 ||
      Math.abs(gr.temperature ?? 0) > 1e-4 || Math.abs(gr.tint ?? 0) > 1e-4 || !z(gr.lift) || !z(gr.gamma) || !z(gr.gain) || !z(gr.offset) ||
      Math.abs(gr.hue ?? 0) > 1e-4 || Math.abs(gr.vibrance ?? 0) > 1e-4 || Math.abs(gr.highlights ?? 0) > 1e-4 || Math.abs(gr.shadows ?? 0) > 1e-4;
  }

  private applyGrade(c: Clip, lt: number, input: Target): Target {
    const gr = c.grade;
    if (!this.gradeActive(gr)) return input;
    const g = this.gl;
    const v = (k: string, d: any) => prop(c, `grade.${k}`, lt, (gr as any)[k] ?? d);
    let lut: { tex: WebGLTexture; size: number } | null = null;
    if (gr!.lut) lut = this.lut(gr!.lut);
    const out = g.acquire(this.tw, this.th);
    g.draw(g.program("grade", FS_GRADE), out, {
      uExposure: v("exposure", 0), uContrast: v("contrast", 1), uPivot: v("pivot", 0.435), uSaturation: v("saturation", 1),
      uTemp: v("temperature", 0), uTint: v("tint", 0), uHue: v("hue", 0), uVibrance: v("vibrance", 0),
      uHigh: v("highlights", 0), uShadow: v("shadows", 0),
      uLift: v("lift", [0, 0, 0]), uGamma: v("gamma", [0, 0, 0]), uGain: v("gain", [0, 0, 0]), uOffset: v("offset", [0, 0, 0]),
      uHasLut: lut ? 1 : 0, uLutMix: v("lutMix", 1), uLutSize: lut?.size ?? 2,
    }, { src: input.tex, uLut: { tex3d: lut?.tex ?? this.dummyLut() } });
    g.release(input);
    return out;
  }

  private _dummyLut: WebGLTexture | null = null;
  /** sampler3D must never share a unit with a sampler2D — bind an identity 2³ LUT when none. */
  private dummyLut() {
    if (!this._dummyLut) {
      const d: number[] = [];
      for (let b = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) d.push(r, g, b);
      this._dummyLut = this.gl.lut3d(2, new Float32Array(d));
    }
    return this._dummyLut;
  }

  private lut(path: string) {
    const hit = this.luts.get(path);
    if (hit && hit !== "loading" && hit !== "error") return hit;
    if (!hit) {
      this.luts.set(path, "loading");
      fs.readText(store.abs(path)).then((txt) => {
        const { size, data } = parseCube(txt);
        this.luts.set(path, { tex: this.gl.lut3d(size, data), size });
        store.emit("frame-ready");
      }).catch((e) => { this.luts.set(path, "error"); store.error(path, String(e)); });
    }
    return null;
  }

  // ---------- compositing ----------
  private transformMatrix(c: Clip, lt: number) {
    const tr = c.transform ?? {};
    const P = (k: string, d: number) => prop(c, `transform.${k}`, lt, (tr as any)[k] ?? d);
    const W = this.tw, H = this.th;
    const ax = P("anchorX", 0.5) * W, ay = (1 - P("anchorY", 0.5)) * H;
    const tx = P("x", 0) * this.scale, ty = -P("y", 0) * this.scale;
    const s = P("scale", 1);
    const sx = (s * P("scaleX", 1)) || 1e-4, sy = (s * P("scaleY", 1)) || 1e-4;
    const phi = (P("rotation", 0) * Math.PI) / 180; // inverse of clockwise rotation
    const cs = Math.cos(phi), sn = Math.sin(phi);
    const m00 = cs / sx, m01 = -sn / sx, m10 = sn / sy, m11 = cs / sy;
    const px = ax + tx, py = ay + ty;
    const bx = ax - (m00 * px + m01 * py), by = ay - (m10 * px + m11 * py);
    return [m00, m10, 0, m01, m11, 0, bx, by, 1];
  }

  opacityAt(c: Clip, lt: number) {
    let o = prop(c, "opacity", lt, c.opacity ?? 1);
    if (c.fadeIn) o *= kit.clamp(lt / c.fadeIn);
    if (c.fadeOut) o *= kit.clamp((c.duration - lt) / c.fadeOut);
    return Math.max(0, Math.min(1, o));
  }

  private blendProgram(name = "normal") {
    const g = this.gl;
    if (BLEND_FUNCS[name]) return g.program(`blend:${name}`, compositeFS(BLEND_FUNCS[name]));
    const mod = getModule(name);
    if (mod?.fragment) return g.program(`blend:${mod.__path}:${mod.__version}`, compositeFS(mod.fragment, true));
    return g.program("blend:normal", compositeFS(BLEND_FUNCS.normal));
  }

  private composite(L: Target, c: Clip, lt: number, identity = false, opacity?: number) {
    const g = this.gl;
    g.draw(this.blendProgram(c.blend), this.accB, {
      uInv: identity ? [1, 0, 0, 0, 1, 0, 0, 0, 1] : this.transformMatrix(c, lt),
      uSize: [this.tw, this.th], uOpacity: opacity ?? this.opacityAt(c, lt),
    }, { uBase: this.accA.tex, uLayer: L.tex });
    [this.accA, this.accB] = [this.accB, this.accA];
  }

  /** Layer placed with its own transform/opacity onto a transparent buffer. */
  private positioned(p: Project, l: Layer): Target | null {
    const L = this.renderLayer(p, l);
    if (!L) return null;
    const g = this.gl;
    const out = g.acquire(this.tw, this.th);
    g.draw(this.blendProgram("normal"), out, { uInv: this.transformMatrix(l.clip, l.lt), uSize: [this.tw, this.th], uOpacity: this.opacityAt(l.clip, l.lt) }, { uBase: this.empty.tex, uLayer: L.tex });
    g.release(L);
    return out;
  }

  private compositeTransition(p: Project, from: Layer, to: Layer) {
    const g = this.gl;
    const tr = to.clip.transition!;
    const progress = kit.clamp(to.lt / tr.duration);
    const A = this.positioned(p, from), B = this.positioned(p, to);
    const empty = () => { const e = g.acquire(this.tw, this.th); g.clear(e); return e; };
    const fa = A ?? empty(), fb = B ?? empty();
    let glsl: string, specs: any = undefined, key: string;
    const values = tr.params ?? {};
    if (TRANSITIONS[tr.type]) { glsl = TRANSITIONS[tr.type].glsl; key = `tr:${tr.type}`; }
    else {
      const mod = getModule(tr.type);
      if (mod?.fragment) { glsl = mod.fragment; specs = mod.params; key = `tr:${mod.__path}:${mod.__version}`; }
      else { glsl = TRANSITIONS.crossDissolve.glsl; key = "tr:crossDissolve"; }
    }
    const R = g.acquire(this.tw, this.th);
    g.draw(g.program(key, transitionFS(glsl, paramUniforms(specs, values))), R,
      { progress, ratio: this.tw / this.th, iTime: to.lt, iResolution: [this.tw, this.th, 1], ...paramValues(specs, values) },
      { uFrom: fa.tex, uTo: fb.tex });
    this.composite(R, to.clip, to.lt, true, 1);
    g.release(fa); g.release(fb); g.release(R);
  }

  private applyAdjustment(l: Layer) {
    const g = this.gl;
    const L = g.acquire(this.tw, this.th);
    g.draw(g.program("copy", FS_COPY), L, { uOpacity: 1 }, { src: this.accA.tex });
    let cur = this.applyEffects(l.clip, l.lt, L);
    cur = this.applyGrade(l.clip, l.lt, cur);
    this.composite(cur, l.clip, l.lt, true);
    g.release(cur);
  }

  /** Read final frame (bottom-up RGBA). */
  readFrame(out?: Uint8Array) { return this.gl.read(null, this.tw, this.th, out); }

  /** Downsampled final frame for scopes (top-down). */
  async snapshotPNG(): Promise<Uint8Array> {
    const blob: Blob = await new Promise((r) => this.canvas.toBlob((b) => r(b!), "image/png"));
    return new Uint8Array(await blob.arrayBuffer());
  }

  dropClipCanvas(id: string) { this.canvases.delete(id); }
}
