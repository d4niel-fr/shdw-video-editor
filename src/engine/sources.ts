// Media element pool (video/image), frame-accurate seeking for export, and
// 2D rasterizers for text + subtitle clips.

import { Clip, Media, Project, TextStyle, mediaOf } from "../model";
import { mediaUrl } from "../ipc";
import { store } from "../store";
import { kit } from "../kit/kit";

interface VEntry { el: HTMLVideoElement; media: string; used: number; seeking: boolean }

class MediaPool {
  private videos = new Map<string, VEntry>();
  private images = new Map<string, HTMLImageElement>();
  private pendingImages = new Set<string>();

  srcOf(m: Media) { return mediaUrl(store.abs(m.proxy ?? m.path)); }

  video(c: Clip, m: Media): HTMLVideoElement {
    let e = this.videos.get(c.id);
    const src = this.srcOf(m);
    if (e && e.el.dataset.src !== src) { this.drop(c.id); e = undefined; }
    if (!e) {
      const el = document.createElement("video");
      el.crossOrigin = "anonymous";
      el.muted = true;
      el.preload = "auto";
      el.playsInline = true;
      el.dataset.src = src;
      el.src = src;
      el.addEventListener("seeked", () => store.emit("frame-ready"));
      el.addEventListener("loadeddata", () => store.emit("frame-ready"));
      el.addEventListener("error", () => store.error(m.name, `cannot decode ${m.name} — try "Generate optimized media" in the media pool`));
      e = { el, media: m.id, used: performance.now(), seeking: false };
      this.videos.set(c.id, e);
      this.gc();
    }
    e.used = performance.now();
    return e.el;
  }

  /** Is the clip's video element ready to upload a frame? */
  ready(el: HTMLVideoElement) { return el.readyState >= 2 && el.videoWidth > 0; }

  image(absPath: string): HTMLImageElement | null {
    let img = this.images.get(absPath);
    if (!img) {
      img = new Image();
      img.crossOrigin = "anonymous";
      img.decoding = "async";
      this.pendingImages.add(absPath);
      img.onload = () => { this.pendingImages.delete(absPath); store.emit("frame-ready"); };
      img.onerror = () => { this.pendingImages.delete(absPath); store.error(absPath, "cannot load image"); };
      img.src = mediaUrl(absPath);
      this.images.set(absPath, img);
    }
    return img.complete && img.naturalWidth > 0 ? img : null;
  }
  imagesPending() { return this.pendingImages.size; }

  /** Frame-accurate seek used by export / frame grabs. */
  async seekExact(el: HTMLVideoElement, t: number, fps: number) {
    if (el.readyState < 1) await once(el, "loadedmetadata", 8000);
    const target = Math.min(Math.max(0, t), Math.max(0, (el.duration || 0) - 0.001));
    if (Math.abs(el.currentTime - target) > 0.25 / fps || el.readyState < 2) {
      const p = once(el, "seeked", 8000);
      el.currentTime = target;
      await p;
    }
    if (el.readyState < 2) await once(el, "loadeddata", 4000);
    if ("requestVideoFrameCallback" in el) {
      await Promise.race([new Promise((r) => (el as any).requestVideoFrameCallback(() => r(0))), sleep(60)]);
    }
  }

  pauseAll() { for (const e of this.videos.values()) if (!e.el.paused) e.el.pause(); }
  entries() { return this.videos; }

  drop(id: string) {
    const e = this.videos.get(id);
    if (!e) return;
    e.el.pause(); e.el.removeAttribute("src"); e.el.load();
    this.videos.delete(id);
  }

  private gc() {
    if (this.videos.size <= 14) return;
    const sorted = [...this.videos.entries()].sort((a, b) => a[1].used - b[1].used);
    for (const [id] of sorted.slice(0, this.videos.size - 14)) this.drop(id);
  }

  purgeMissing(p: Project) {
    for (const id of [...this.videos.keys()]) if (!p.clips.some((c) => c.id === id)) this.drop(id);
  }
}

export const pool = new MediaPool();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function once(el: EventTarget, ev: string, timeout: number) {
  return new Promise<void>((res) => {
    const done = () => { el.removeEventListener(ev, done); clearTimeout(tm); res(); };
    const tm = setTimeout(done, timeout);
    el.addEventListener(ev, done);
  });
}

export function videoSourceTime(c: Clip, lt: number, m?: Media) {
  const src = c.source as any;
  const t = (src.in ?? 0) + (c.freeze ? 0 : lt * (c.speed ?? 1));
  return m?.duration ? Math.min(t, m.duration - 0.001) : t;
}

export const sourceMediaOf = (p: Project, c: Clip) => mediaOf(p, c);

// ---------------- text rasterizers ----------------

const fontStack = (s: TextStyle) =>
  `${s.italic ? "italic " : ""}${s.weight ?? 700} ${s.size ?? 96}px "${s.font ?? "Inter"}", "SF Pro Display", "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif`;

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxW: number) {
  const out: string[] = [];
  for (const para of String(text).split("\n")) {
    const words = para.split(" ");
    let line = "";
    for (const w of words) {
      const test = line ? line + " " + w : w;
      if (ctx.measureText(test).width > maxW && line) { out.push(line); line = w; } else line = test;
    }
    out.push(line);
  }
  return out;
}

/**
 * Draw styled text block. `k` animation progress in (0..1, entering) and `o` (1..0, leaving).
 */
export function drawText(ctx: CanvasRenderingContext2D, W: number, H: number, text: string, s: TextStyle & { animation?: string },
  lt: number, dur: number, animDur = 0.6, centerY?: number) {
  const size = s.size ?? 96;
  ctx.save();
  ctx.font = fontStack(s);
  (ctx as any).letterSpacing = `${(s.tracking ?? 0) * size}px`;
  ctx.textBaseline = "middle";
  const align = s.align ?? "center";
  ctx.textAlign = align;
  const lines = wrapLines(ctx, text, W * 0.86);
  const lh = size * (s.lineHeight ?? 1.15);
  const blockH = lh * lines.length;
  const cy = centerY ?? H / 2;
  const x = align === "left" ? W * 0.07 : align === "right" ? W * 0.93 : W / 2;

  const anim = s.animation ?? "none";
  const kin = anim === "none" ? 1 : kit.clamp(lt / animDur);
  const kout = anim === "none" ? 1 : kit.clamp((dur - lt) / Math.min(0.35, animDur));
  const sp = kit.spring(lt, 1, animDur * 0.9);
  let alpha = Math.min(kin < 1 ? kit.ease.outCubic(kin) : 1, kout);
  let dy = 0, sc = 1, blur = 0, dx = 0;
  let visibleText = (str: string) => str;
  switch (anim) {
    case "fadeUp": dy = (1 - sp) * size * 0.45; break;
    case "scaleIn": sc = 0.86 + 0.14 * sp; break;
    case "blurIn": blur = (1 - kit.ease.outCubic(kin)) * 24; break;
    case "slideLeft": dx = (1 - sp) * size * 1.2; break;
    case "tracking": (ctx as any).letterSpacing = `${((s.tracking ?? 0) + (1 - kit.ease.outExpo(kin)) * 0.35) * size}px`; break;
    case "typewriter": {
      alpha = kout;
      const all = lines.join("\n");
      const n = Math.round(kit.clamp(lt / Math.max(animDur, all.length * 0.035)) * all.length);
      let used = 0;
      visibleText = (str) => { const vis = str.slice(0, Math.max(0, n - used)); used += str.length + 1; return vis; };
      break;
    }
  }
  ctx.globalAlpha = Math.max(0, alpha);
  if (blur > 0.2) ctx.filter = `blur(${blur}px)`;
  ctx.translate(x + dx, cy + dy);
  ctx.scale(sc, sc);

  if (s.background) {
    const pad = s.background.padding ?? size * 0.3;
    const widths = lines.map((l) => ctx.measureText(l).width);
    const bw = Math.max(...widths) + pad * 2;
    const bx = align === "left" ? -pad : align === "right" ? -bw + pad : -bw / 2;
    ctx.fillStyle = s.background.color;
    kit.roundRect(ctx, bx, -blockH / 2 - pad * 0.6, bw, blockH + pad * 1.2, s.background.radius ?? 12);
    ctx.fill();
  }
  if (s.shadow) { ctx.shadowColor = s.shadow.color; ctx.shadowBlur = s.shadow.blur; ctx.shadowOffsetX = s.shadow.x ?? 0; ctx.shadowOffsetY = s.shadow.y ?? 0; }

  lines.forEach((line, i) => {
    const y = -blockH / 2 + lh * (i + 0.5);
    if (anim === "wordPop") {
      const words = line.split(" ");
      const full = ctx.measureText(line).width;
      let cx = align === "left" ? 0 : align === "right" ? -full : -full / 2;
      ctx.textAlign = "left";
      words.forEach((w, wi) => {
        const ww = ctx.measureText(w + " ").width;
        const k = kit.spring(lt - (wi + i * 4) * 0.07, 0.75, 0.42);
        ctx.save();
        ctx.translate(cx + ctx.measureText(w).width / 2, y);
        ctx.scale(0.6 + 0.4 * k, 0.6 + 0.4 * k);
        ctx.globalAlpha = Math.max(0, Math.min(1, k * 1.5)) * kout;
        ctx.textAlign = "center";
        if (s.stroke) { ctx.lineJoin = "round"; ctx.strokeStyle = s.stroke.color; ctx.lineWidth = s.stroke.width; ctx.strokeText(w, 0, 0); }
        ctx.fillStyle = s.color ?? "#fff";
        ctx.fillText(w, 0, 0);
        ctx.restore();
        cx += ww;
      });
      ctx.textAlign = align;
      return;
    }
    const str = visibleText(line);
    if (s.stroke) { ctx.lineJoin = "round"; ctx.strokeStyle = s.stroke.color; ctx.lineWidth = s.stroke.width; ctx.strokeText(str, 0, y); }
    ctx.fillStyle = s.color ?? "#fff";
    ctx.fillText(str, 0, y);
  });
  ctx.restore();
}
