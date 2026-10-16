// Live HTML preview: HTML compositions play as real DOM inside the viewer
// (one iframe per clip, stacked in track order over/under the WebGL canvas),
// driven frame-by-frame over postMessage by the shdw runtime. Sharp at any
// viewer size and real-time; export and /frame still use the exact
// headless-renderer path.

import { store } from "../store";
import { Clip, clipEnd, prop } from "../model";
import { norm } from "../ipc";
import { htmlFrames } from "./html";
import { Renderer, Layer, LivePlan } from "./renderer";

const PRELOAD = 2.5;     // seconds ahead to load upcoming compositions
const MAX_FRAMES = 16;

const liveUrl = (abs: string) => "http://media.localhost/live/" + norm(abs).split("/").map(encodeURIComponent).join("/");

const CSS_BLENDS = new Set(["multiply", "screen", "overlay", "darken", "lighten", "colorDodge", "colorBurn", "hardLight", "softLight", "difference", "exclusion", "hue", "saturation", "color", "luminosity"]);
const kebab = (s: string) => s.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
const eio = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

interface Frame { el: HTMLIFrameElement; prev?: HTMLIFrameElement; key: string; clip: Clip; loaded: boolean; drawn: boolean; lastT: number }

let grainUrl = "";
function grain() {
  if (grainUrl) return grainUrl;
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(256, 256);
  for (let i = 0; i < img.data.length; i += 4) { const v = Math.random() * 255; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255; }
  ctx.putImageData(img, 0, 0);
  return (grainUrl = c.toDataURL());
}

class LiveHtml {
  box = document.createElement("div");
  private inner = document.createElement("div");
  private frames = new Map<string, Frame>();
  private overlays = new Map<string, HTMLDivElement>();
  private stage: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  active = false;

  constructor() {
    Object.assign(this.box.style, { position: "absolute", overflow: "hidden", pointerEvents: "none", zIndex: "1", left: "0", top: "0", width: "0", height: "0" });
    Object.assign(this.inner.style, { position: "absolute", left: "0", top: "0", transformOrigin: "0 0" });
    this.box.appendChild(this.inner);
    window.addEventListener("message", (e) => {
      if (e.data?.shdw !== "drawn") return;
      for (const f of this.frames.values()) if (f.el.contentWindow === e.source) { f.drawn = true; f.prev?.remove(); f.prev = undefined; store.emit("frame-ready"); }
    });
  }

  attach(stage: HTMLElement, canvas: HTMLCanvasElement) {
    this.stage = stage; this.canvas = canvas;
    if (this.box.parentElement !== stage) stage.appendChild(this.box);
  }

  private key(c: Clip) {
    const s: any = c.source;
    return `${store.dir}|${s.module}|${htmlFrames.version(s.module)}|${JSON.stringify(s.params ?? {})}|${c.duration}`;
  }

  private ensure(c: Clip, W: number, H: number): Frame {
    const key = this.key(c);
    let f = this.frames.get(c.id);
    if (f && f.key === key) { f.clip = c; return f; }
    const prev = f ? (f.drawn ? f.el : f.prev) : undefined;
    if (f && prev !== f.el) f.el.remove();
    if (f && f.prev && f.prev !== prev) f.prev.remove();
    const el = document.createElement("iframe");
    el.setAttribute("scrolling", "no");
    Object.assign(el.style, { position: "absolute", left: "0", top: "0", width: W + "px", height: H + "px", border: "0", background: "transparent", colorScheme: "normal", opacity: "0", pointerEvents: "none" });
    const nf: Frame = { el, prev, key, clip: c, loaded: false, drawn: false, lastT: -1 };
    el.addEventListener("load", () => { nf.loaded = true; store.emit("frame-ready"); });
    el.src = `${liveUrl(store.abs((c.source as any).module))}?w=${W}&h=${H}`;
    this.inner.appendChild(el);
    this.frames.set(c.id, nf);
    return nf;
  }

  private post(f: Frame, t: number, force = false) {
    if (!f.loaded || (!force && Math.abs(t - f.lastT) < 1e-4)) return;
    f.lastT = t;
    const s: any = f.clip.source;
    f.el.contentWindow?.postMessage({ shdw: "frame", t, params: s.params ?? {}, duration: f.clip.duration, playing: store.playing }, "*");
  }

  /** Called every rendered viewer frame. plan = null → hide (exact compositor path). */
  sync(r: Renderer, plan: LivePlan | null, t: number) {
    const p = store.project, W = p.settings.width, H = p.settings.height;
    this.active = !!plan;
    this.layout(W, H, !!plan?.canvasOnTop);
    const shown = new Set<string>();
    if (plan) {
      for (const { layer, from, z } of plan.html) {
        const pr = from ? clamp01(layer.lt / Math.max(1e-3, layer.clip.transition!.duration)) : 1;
        if (from) this.show(r, from, z, shown, W, H, { progress: pr, role: "from", type: layer.clip.transition!.type });
        this.show(r, layer, z, shown, W, H, from ? { progress: pr, role: "to", type: layer.clip.transition!.type } : undefined);
      }
    }
    // preload upcoming compositions so they're drawn before they start
    const want = new Set(shown);
    if (store.liveHtml) {
      const tracks = new Set(p.tracks.filter((tr) => tr.kind === "video" && !tr.hidden).map((tr) => tr.id));
      const next = p.clips
        .filter((c) => c.source.type === "html" && c.enabled !== false && tracks.has(c.track) && !shown.has(c.id) && clipEnd(c) > t && c.start < t + PRELOAD)
        .sort((a, b) => a.start - b.start);
      for (const c of next) {
        if (want.size >= MAX_FRAMES) break;
        want.add(c.id);
        const f = this.ensure(c, W, H);
        f.el.style.opacity = "0";
        this.post(f, Math.max(0, t - c.start));
      }
    }
    for (const [id, f] of this.frames) if (!want.has(id)) { f.el.remove(); f.prev?.remove(); this.frames.delete(id); }
    for (const f of this.frames.values()) if (!shown.has(f.clip.id)) f.el.style.opacity = "0";
    this.syncOverlays(r, plan, t, W, H);
  }

  private show(r: Renderer, l: Layer, z: number, shown: Set<string>, W: number, H: number, tr?: { progress: number; role: "from" | "to"; type: string }) {
    const c = l.clip;
    const f = this.ensure(c, W, H);
    shown.add(c.id);
    this.post(f, l.lt);
    const st = f.el.style;
    let op = r.opacityAt(c, l.lt);
    const T = c.transform ?? {};
    const P = (k: string, d: number) => prop(c, `transform.${k}`, l.lt, (T as any)[k] ?? d);
    const s = P("scale", 1);
    let tx = P("x", 0), ty = P("y", 0), clip = "";
    if (tr) {
      const pr = tr.progress, e = eio(pr), to = tr.role === "to";
      const ty_ = tr.type;
      if (ty_.startsWith("wipe")) {
        if (to) {
          const k = (1 - pr) * 100;
          clip = ty_ === "wipeLeft" ? `inset(0 0 0 ${k}%)` : ty_ === "wipeRight" ? `inset(0 ${k}% 0 0)` : ty_ === "wipeUp" ? `inset(${k}% 0 0 0)` : `inset(0 0 ${k}% 0)`;
        }
      } else if (ty_.startsWith("slide") || ty_.startsWith("push")) {
        const dir = /Left$/.test(ty_) ? [-1, 0] : /Right$/.test(ty_) ? [1, 0] : /Up$/.test(ty_) ? [0, -1] : [0, 1];
        if (to) { tx += -dir[0] * (1 - e) * W; ty += -dir[1] * (1 - e) * H; }
        else if (ty_.startsWith("push")) { tx += dir[0] * e * W; ty += dir[1] * e * H; }
      } else {
        op *= to ? pr : 1 - pr; // cross dissolve (approximation for shader transitions)
      }
    }
    const ax = P("anchorX", 0.5) * 100, ay = P("anchorY", 0.5) * 100;
    st.transformOrigin = `${ax}% ${ay}%`;
    st.transform = `translate(${tx}px, ${ty}px) rotate(${P("rotation", 0)}deg) scale(${s * P("scaleX", 1) * (T.flipH ? -1 : 1)}, ${s * P("scaleY", 1) * (T.flipV ? -1 : 1)})`;
    st.zIndex = String(z);
    st.clipPath = clip;
    st.mixBlendMode = c.blend && CSS_BLENDS.has(c.blend) ? kebab(c.blend) : "";
    st.filter = this.cssEffects(c, l.lt);
    st.opacity = f.drawn ? String(op) : "0";
    if (f.prev) { const ps = f.prev.style; ps.transform = st.transform; ps.transformOrigin = st.transformOrigin; ps.zIndex = st.zIndex; ps.opacity = String(op); }
  }

  private cssEffects(c: Clip, lt: number) {
    const out: string[] = [];
    (c.effects ?? []).forEach((e, idx) => {
      if (e.enabled === false) return;
      const v = (k: string, d: number) => +prop(c, `effects.${idx}.${k}`, lt, e.params?.[k] ?? d);
      if (e.type === "gaussianBlur") out.push(`blur(${v("radius", 12) / 2}px)`);
      else if (e.type === "blackWhite") out.push(`grayscale(1) contrast(${v("contrast", 1.1)})`);
      else if (e.type === "sepia") out.push(`sepia(${v("amount", 1)})`);
      else if (e.type === "invert") out.push("invert(1)");
      else if (e.type === "hueShift") out.push(`hue-rotate(${v("degrees", 90)}deg)`);
    });
    return out.join(" ");
  }

  /** Adjustment layers above live HTML: vignette, grain and blur as CSS overlays. */
  private syncOverlays(r: Renderer, plan: LivePlan | null, t: number, W: number, H: number) {
    const keep = new Set<string>();
    for (const { layer, z } of plan?.overlays ?? []) {
      const c = layer.clip;
      const op = r.opacityAt(c, layer.lt);
      (c.effects ?? []).forEach((e, idx) => {
        if (e.enabled === false) return;
        const id = c.id + ":" + idx + ":" + e.type;
        const v = (k: string, d: number) => +prop(c, `effects.${idx}.${k}`, layer.lt, e.params?.[k] ?? d);
        let css: Partial<CSSStyleDeclaration> | null = null;
        if (e.type === "vignette") {
          const a = v("amount", 0.5), soft = v("softness", 0.45);
          const r0 = Math.max(0, (0.85 - soft) / 1.2) * H, r1 = (0.85 / 1.2) * H;
          css = { background: `radial-gradient(circle at 50% 50%, transparent ${r0}px, rgba(0,0,0,${a}) ${r1}px)` };
        } else if (e.type === "filmGrain") {
          const sz = 256 * v("size", 1.5);
          css = { backgroundImage: `url(${grain()})`, backgroundSize: `${sz}px ${sz}px`, mixBlendMode: "overlay", opacity: String(Math.min(1, v("amount", 0.12) * 2.2) * op),
            backgroundPosition: `${Math.floor(Math.random() * sz)}px ${Math.floor(Math.random() * sz)}px` };
        } else if (e.type === "gaussianBlur") {
          css = { backdropFilter: `blur(${v("radius", 12) / 2}px)` };
        }
        if (!css) return;
        keep.add(id);
        let d = this.overlays.get(id);
        if (!d) { d = document.createElement("div"); this.inner.appendChild(d); this.overlays.set(id, d); }
        Object.assign(d.style, { position: "absolute", left: "0", top: "0", width: W + "px", height: H + "px", zIndex: String(z), opacity: String(op) }, css);
      });
    }
    for (const [id, d] of this.overlays) if (!keep.has(id)) { d.remove(); this.overlays.delete(id); }
  }

  private layout(W: number, H: number, canvasOnTop: boolean) {
    const cv = this.canvas, stage = this.stage;
    if (!cv || !stage || cv.parentElement !== stage) { this.box.style.display = "none"; return; }
    this.box.style.display = this.active ? "block" : "none";
    if (!this.active) { cv.style.position = cv.style.zIndex = cv.style.background = ""; return; }
    const r = cv.getBoundingClientRect(), sr = stage.getBoundingClientRect();
    Object.assign(this.box.style, { left: r.left - sr.left + "px", top: r.top - sr.top + "px", width: r.width + "px", height: r.height + "px", background: canvasOnTop ? store.project.settings.background ?? "#000" : "transparent" });
    Object.assign(this.inner.style, { width: W + "px", height: H + "px", transform: `scale(${r.width / W})` });
    cv.style.position = canvasOnTop ? "relative" : "";
    cv.style.zIndex = canvasOnTop ? "2" : "";
    cv.style.background = canvasOnTop ? "transparent" : "";
  }

  clear() {
    for (const f of this.frames.values()) { f.el.remove(); f.prev?.remove(); }
    this.frames.clear();
    for (const d of this.overlays.values()) d.remove();
    this.overlays.clear();
  }
}

export const liveHtml = new LiveHtml();
