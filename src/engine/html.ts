// HTML motion clips: frames are rendered by headless Edge in Rust (html.rs)
// and cached here as GPU-ready ImageBitmaps (Resolve-style render cache).

import { invoke, join, fs } from "../ipc";
import { store } from "../store";
import { Clip } from "../model";
import { TEMPLATES } from "../templates";

import gsap from "gsap/dist/gsap.min.js?raw";
import SplitText from "gsap/dist/SplitText.min.js?raw";
import DrawSVG from "gsap/dist/DrawSVGPlugin.min.js?raw";
import MorphSVG from "gsap/dist/MorphSVGPlugin.min.js?raw";
import MotionPath from "gsap/dist/MotionPathPlugin.min.js?raw";
import CustomEase from "gsap/dist/CustomEase.min.js?raw";
import Scramble from "gsap/dist/ScrambleTextPlugin.min.js?raw";
import TextPlugin from "gsap/dist/TextPlugin.min.js?raw";
import Physics2D from "gsap/dist/Physics2DPlugin.min.js?raw";

const LIBS: Record<string, string> = {
  "gsap.min.js": gsap, "SplitText.min.js": SplitText, "DrawSVGPlugin.min.js": DrawSVG, "MorphSVGPlugin.min.js": MorphSVG,
  "MotionPathPlugin.min.js": MotionPath, "CustomEase.min.js": CustomEase, "ScrambleTextPlugin.min.js": Scramble,
  "TextPlugin.min.js": TextPlugin, "Physics2DPlugin.min.js": Physics2D,
};

/** Write the offline animation libraries into <project>/motion/lib/. */
export async function installLibs() {
  for (const [name, code] of Object.entries(LIBS)) {
    const p = join(store.dir, "motion", "lib", name);
    if (!(await fs.exists(p))) await fs.writeText(p, code);
  }
  // starter examples the agent can read and copy from
  for (const t of TEMPLATES.filter((x) => x.kind === "html")) {
    const p = join(store.dir, "motion", `${t.id}.html`);
    if (!(await fs.exists(p))) await fs.writeText(p, t.code);
  }
}

interface Job { key: string; path: string; t: number; w: number; h: number; scale: number; params: any; duration: number; prio: number; seq: number; done: (b: Blob | null) => void }

const WORKERS = 3;            // matches the Rust renderer pool
const BLOB_BUDGET = 700 * 1024 * 1024;
const DECODED_MAX = 120;

/**
 * Render cache for HTML compositions (like Resolve's render cache):
 * compressed PNG blobs for every rendered frame, a small LRU of decoded
 * GPU-ready bitmaps, 3 parallel renderers, idle-time background caching
 * and decode-ahead during playback.
 */
class HtmlFrames {
  private blobs = new Map<string, Blob>();
  private blobBytes = 0;
  private decoded = new Map<string, ImageBitmap>();
  private last = new Map<string, ImageBitmap>();
  private rendering = new Map<string, Promise<Blob | null>>();
  private decoding = new Map<string, Promise<ImageBitmap | null>>();
  private queue: Job[] = [];
  private active = 0;
  private seq = 0;
  private versions = new Map<string, number>();
  busy: () => boolean = () => false;

  version(path: string) { return this.versions.get(path) ?? 0; }
  invalidate(rel: string) {
    this.versions.set(rel, this.version(rel) + 1);
    for (const k of [...this.blobs.keys()]) if (k.startsWith(rel + "|")) { this.blobBytes -= this.blobs.get(k)!.size; this.blobs.delete(k); }
    for (const k of [...this.decoded.keys()]) if (k.startsWith(rel + "|")) { this.decoded.get(k)!.close(); this.decoded.delete(k); }
    this.queue = this.queue.filter((j) => { if (j.key.startsWith(rel + "|")) { j.done(null); return false; } return true; });
  }
  clear() {
    for (const b of this.decoded.values()) b.close();
    this.decoded.clear(); this.blobs.clear(); this.blobBytes = 0; this.last.clear();
    this.queue.forEach((j) => j.done(null)); this.queue = [];
  }

  key(c: Clip, lt: number, scale: number, fps: number) {
    const s: any = c.source;
    const f = Math.max(0, Math.min(Math.round(lt * fps), Math.round(c.duration * fps) - 1));
    return `${s.module}|${f}|${scale}|${this.version(s.module)}|${JSON.stringify(s.params ?? {})}`;
  }

  /** Decoded bitmap if ready (kicks a decode if only the blob is cached). */
  get(key: string, clipId?: string) {
    const b = this.decoded.get(key);
    if (b) { this.decoded.delete(key); this.decoded.set(key, b); if (clipId) this.last.set(clipId, b); return b; }
    if (this.blobs.has(key)) void this.decode(key);
    return undefined;
  }
  cached(key: string) { return this.blobs.has(key); }
  fallback(clipId: string) { return this.last.get(clipId); }

  private decode(key: string): Promise<ImageBitmap | null> {
    const hit = this.decoded.get(key);
    if (hit) return Promise.resolve(hit);
    const d = this.decoding.get(key);
    if (d) return d;
    const blob = this.blobs.get(key);
    if (!blob) return Promise.resolve(null);
    const p = createImageBitmap(blob, { imageOrientation: "flipY", premultiplyAlpha: "premultiply" })
      .then((bmp) => {
        this.decoded.set(key, bmp);
        const keep = new Set(this.last.values());
        for (const [k, old] of this.decoded) {
          if (this.decoded.size <= DECODED_MAX) break;
          if (keep.has(old)) continue;
          old.close(); this.decoded.delete(k);
        }
        store.emit("frame-ready");
        return bmp;
      })
      .catch(() => null)
      .finally(() => this.decoding.delete(key));
    this.decoding.set(key, p);
    return p;
  }

  private render(c: Clip, lt: number, scale: number, prio: number): Promise<Blob | null> {
    const fps = store.fps;
    const key = this.key(c, lt, scale, fps);
    const have = this.blobs.get(key);
    if (have) return Promise.resolve(have);
    const r = this.rendering.get(key);
    if (r) {
      const j = this.queue.find((x) => x.key === key);
      if (j && prio < j.prio) j.prio = prio;
      return r;
    }
    const s: any = c.source;
    const { width, height } = store.project.settings;
    const f = Math.max(0, Math.min(Math.round(lt * fps), Math.round(c.duration * fps) - 1));
    const p = new Promise<Blob | null>((done) => {
      this.queue.push({ key, path: store.abs(s.module), t: f / fps, w: width, h: height, scale, params: s.params ?? {}, duration: c.duration, prio, seq: this.seq++, done });
    }).finally(() => this.rendering.delete(key));
    this.rendering.set(key, p);
    this.pump();
    return p;
  }

  /** prio: 0 = needed now, 1 = playback look-ahead, 2 = background cache */
  async request(c: Clip, lt: number, scale: number, prio = 0): Promise<ImageBitmap | null> {
    const key = this.key(c, lt, scale, store.fps);
    const blob = await this.render(c, lt, scale, prio);
    if (!blob) return null;
    const bmp = await this.decode(key);
    if (bmp) this.last.set(c.id, bmp);
    return bmp;
  }

  /** Make a future frame instantly available: decode if cached, else render ahead. */
  warm(c: Clip, lt: number, scale: number) {
    const key = this.key(c, lt, scale, store.fps);
    if (this.decoded.has(key)) return;
    if (this.blobs.has(key)) void this.decode(key);
    else void this.render(c, lt, scale, 1);
  }

  private pump() {
    while (this.active < WORKERS && this.queue.length) {
      this.queue.sort((a, b) => a.prio - b.prio || a.seq - b.seq);
      const j = this.queue.shift()!;
      this.active++;
      void this.run(j).finally(() => { this.active--; this.pump(); });
    }
  }

  private async run(j: Job) {
    try {
      const buf = await Promise.race([
        invoke<ArrayBuffer>("html_frame", { path: j.path, t: j.t, width: j.w, height: j.h, scale: j.scale, params: j.params, duration: j.duration }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("HTML frame timed out (60s) — composition may be stuck")), 60000)),
      ]);
      const blob = new Blob([buf], { type: "image/png" });
      if (!this.blobs.has(j.key)) { this.blobs.set(j.key, blob); this.blobBytes += blob.size; }
      while (this.blobBytes > BLOB_BUDGET && this.blobs.size) {
        const k = this.blobs.keys().next().value!;
        this.blobBytes -= this.blobs.get(k)!.size; this.blobs.delete(k);
      }
      store.clearErrors(store.rel(j.path));
      j.done(blob);
      if (j.prio < 2) store.emit("frame-ready");
    } catch (e: any) {
      store.error(store.rel(j.path), String(e?.message ?? e));
      j.done(null);
    }
  }

  // ---------- background render cache ----------
  private bgTimer = 0;
  stats = { cached: 0, total: 0 };
  startBackground(scale: () => number) {
    clearInterval(this.bgTimer);
    let tick = 0;
    this.bgTimer = window.setInterval(() => {
      if (!store.dir) return;
      const sc = scale();
      const fps = store.fps;
      const clips = store.project.clips.filter((c) => c.source.type === "html" && c.enabled !== false);
      if (++tick % 10 === 0) {
        let cached = 0, total = 0;
        for (const c of clips) {
          const n = Math.round(c.duration * fps);
          total += n;
          for (let f = 0; f < n; f++) if (this.blobs.has(this.key(c, f / fps, sc, fps))) cached++;
        }
        if (cached !== this.stats.cached || total !== this.stats.total) { this.stats = { cached, total }; store.emit("cache-progress"); }
      }
      if (this.busy() || this.queue.some((j) => j.prio < 2) || this.queue.length >= WORKERS) return;
      // next uncached frames: from the playhead forward, then the rest of the timeline
      const ph = store.playhead;
      const order = clips.slice().sort((a, b) => {
        const da = a.start + a.duration < ph ? 1e6 + a.start : Math.max(0, a.start - ph);
        const db = b.start + b.duration < ph ? 1e6 + b.start : Math.max(0, b.start - ph);
        return da - db;
      });
      let added = 0;
      for (const c of order) {
        const n = Math.round(c.duration * fps);
        const f0 = ph > c.start && ph < c.start + c.duration ? Math.round((ph - c.start) * fps) : 0;
        for (let i = 0; i < n && added < WORKERS; i++) {
          const lt = ((f0 + i) % n) / fps;
          const key = this.key(c, lt, sc, fps);
          if (this.blobs.has(key) || this.rendering.has(key)) continue;
          void this.render(c, lt, sc, 2);
          added++;
        }
        if (added >= WORKERS) break;
      }
    }, 40);
  }

  pending() { return this.queue.length + this.active; }
}

export const htmlFrames = new HtmlFrames();
