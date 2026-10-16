// Deliver: deterministic frame-by-frame render streamed to ffmpeg.

import { invoke, join } from "../ipc";
import { store } from "../store";
import { Renderer } from "./renderer";
import { clipEnd, mediaOf, prop, deepClone } from "../model";
import { playback } from "./playback";

export interface ExportOptions {
  out: string; codec: string; quality?: number; from?: number; to?: number;
  width?: number; height?: number; fps?: number;
}

export interface ExportProgress { frame: number; total: number; fps: number; eta: number; stage: string }

let cancelFlag = false;
export function cancelExport() { cancelFlag = true; void invoke("export_cancel"); }

function audioPlan(from: number, to: number) {
  const p = store.project;
  const anySolo = p.tracks.some((t) => t.kind === "audio" && t.solo);
  const out: any[] = [];
  for (const c of p.clips) {
    const tr = p.tracks.find((t) => t.id === c.track);
    if (!tr || tr.kind !== "audio" || c.enabled === false || tr.muted || (anySolo && !tr.solo)) continue;
    const m = mediaOf(p, c);
    if (!m || (m.kind !== "audio" && !m.hasAudio)) continue;
    const a = Math.max(c.start, from), b = Math.min(clipEnd(c), to);
    if (b <= a) continue;
    const sp = c.speed ?? 1;
    const vol = (c.volume ?? 1) * (tr.volume ?? 1) * (c.keyframes?.volume ? prop(c, "volume", (a + b) / 2 - c.start, 1) : 1);
    out.push({
      path: store.abs(m.path), sourceIn: ((c.source as any).in ?? 0) + (a - c.start) * sp, start: a - from, duration: b - a,
      volume: vol, pan: Math.max(-1, Math.min(1, (c.pan ?? 0) + (tr.pan ?? 0))),
      fadeIn: a === c.start ? c.audioFadeIn ?? 0 : 0, fadeOut: b === clipEnd(c) ? c.audioFadeOut ?? 0 : 0, speed: sp,
    });
  }
  return out;
}

export async function exportVideo(renderer: Renderer, opts: ExportOptions, onProgress: (p: ExportProgress) => void) {
  cancelFlag = false;
  playback.pause();
  const p = store.project;
  const fps = opts.fps ?? p.settings.fps;
  const from = opts.from ?? 0;
  const to = opts.to ?? store.duration;
  if (to - from <= 0) throw new Error("Timeline is empty");
  const total = Math.max(1, Math.round((to - from) * fps));
  const out = store.abs(opts.out);

  const savedScale = renderer.scale;
  renderer.locked++;
  const snapshot = deepClone(p);
  if (opts.width && opts.height) { snapshot.settings.width = opts.width; snapshot.settings.height = opts.height; }
  renderer.configure(snapshot, 1);
  const W = renderer.tw, H = renderer.th;

  try {
    onProgress({ frame: 0, total, fps: 0, eta: 0, stage: "Mixing audio" });
    let audio: string | null = null;
    if (!["gif", "png"].includes(opts.codec)) {
      audio = join(store.dir, ".shdw", "mixdown.wav");
      await invoke("mixdown", { clips: audioPlan(from, to), total: to - from, out: audio });
    }
    await invoke("export_start", { opts: { out, width: W, height: H, fps, audio, codec: opts.codec, quality: opts.quality ?? 18 } });
    const buf = new Uint8Array(W * H * 4);
    const t0 = performance.now();
    const decs = new Map<string, { next: number; w: number; h: number }>();
    for (let f = 0; f < total; f++) {
      if (cancelFlag) throw new Error("Export cancelled");
      const t = from + f / fps;
      await feedDecoders(renderer, snapshot, t, fps, decs, W, H);
      await renderer.prepare(snapshot, t, true);
      renderer.render(snapshot, t, true);
      renderer.readFrame(buf);
      await invoke("export_frame", buf);
      if (f % 3 === 0 || f === total - 1) {
        const el = (performance.now() - t0) / 1000;
        const rate = (f + 1) / el;
        onProgress({ frame: f + 1, total, fps: rate, eta: (total - f - 1) / rate, stage: "Rendering" });
      }
    }
    onProgress({ frame: total, total, fps: 0, eta: 0, stage: "Finalizing" });
    await invoke("export_finish");
    return out;
  } catch (e) {
    void invoke("export_cancel");
    throw e;
  } finally {
    void invoke("decoder_close_all");
    renderer.rawFrames.clear();
    renderer.locked--;
    renderer.configure(store.project, savedScale);
    store.emit("frame-ready");
  }
}

/** Single-frame PNG (for agent verification). */
export async function renderFramePNG(renderer: Renderer, t: number, scale = 0.5): Promise<Uint8Array> {
  const saved = renderer.scale;
  renderer.locked++;
  try {
    renderer.configure(store.project, scale);
    await renderer.prepare(store.project, t);
    renderer.render(store.project, t, true);
    return await renderer.snapshotPNG();
  } finally {
    renderer.locked--;
    renderer.configure(store.project, saved);
    store.emit("frame-ready");
  }
}

/** Contact sheet of `count` frames between from..to. */
export async function renderContactSheet(renderer: Renderer, from: number, to: number, count: number, scale = 0.3) {
  const saved = renderer.scale;
  renderer.locked++;
  try {
    renderer.configure(store.project, scale);
    const w = renderer.tw, h = renderer.th;
    const cols = Math.min(count, 4), rows = Math.ceil(count / cols);
    const sheet = document.createElement("canvas");
    sheet.width = cols * w + (cols + 1) * 8; sheet.height = rows * (h + 22) + 8;
    const ctx = sheet.getContext("2d")!;
    ctx.fillStyle = "#111"; ctx.fillRect(0, 0, sheet.width, sheet.height);
    for (let i = 0; i < count; i++) {
      const t = count === 1 ? from : from + ((to - from) * i) / (count - 1);
      await renderer.prepare(store.project, t);
      renderer.render(store.project, t, true);
      const x = 8 + (i % cols) * (w + 8), y = 8 + Math.floor(i / cols) * (h + 22);
      ctx.drawImage(renderer.canvas, x, y, w, h);
      ctx.fillStyle = "#aaa"; ctx.font = "12px system-ui"; ctx.fillText(`t=${t.toFixed(2)}s`, x, y + h + 14);
    }
    const blob: Blob = await new Promise((r) => sheet.toBlob((b) => r(b!), "image/png"));
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    renderer.locked--;
    renderer.configure(store.project, saved);
    store.emit("frame-ready");
  }
}

/** Pull the next decoded frame for every video layer visible at t (sequential, no seeking). */
async function feedDecoders(renderer: Renderer, p: any, t: number, fps: number, decs: Map<string, { next: number; w: number; h: number }>, W: number, H: number) {
  for (const { layer, from } of renderer.layersAt(p, t)) {
    for (const l of from ? [layer, from] : [layer]) {
      const c = l.clip;
      const m = mediaOf(p, c);
      if (m?.kind !== "video") continue;
      const idx = c.freeze ? 0 : Math.round(l.lt * fps);
      let st = decs.get(c.id);
      if (c.freeze && st && renderer.rawFrames.has(c.id)) continue;
      if (!st || idx < st.next || idx - st.next > 90) {
        const mw = m.width ?? W, mh = m.height ?? H;
        const s = Math.min(W / mw, H / mh, 1.0 * Math.max(1, W / mw));
        const w = Math.max(2, Math.round((mw * s) / 2) * 2), h = Math.max(2, Math.round((mh * s) / 2) * 2);
        const sp = c.speed ?? 1;
        await invoke("decoder_open", { o: { id: c.id, path: store.abs(m.proxy ?? m.path), start: ((c.source as any).in ?? 0) + (idx / fps) * sp, fps, speed: sp, width: w, height: h } });
        st = { next: idx, w, h };
        decs.set(c.id, st);
      }
      const data = new Uint8Array(await invoke<ArrayBuffer>("decoder_read", { id: c.id, skip: idx - st.next }));
      st.next = idx + 1;
      if (data.length) renderer.rawFrames.set(c.id, { data, w: st.w, h: st.h });
    }
  }
}
