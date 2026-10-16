// Media pool operations: import + probe, thumbnails, waveforms, proxies, transcripts.

import { invoke, fs, join, basename, ext, VIDEO_EXT, AUDIO_EXT, IMAGE_EXT, mediaUrl } from "./ipc";
import { store } from "./store";
import { Media, uid } from "./model";

const PLAYABLE = new Set(["h264", "vp8", "vp9", "av1", "mjpeg", "png", "theora"]);

export const thumbInterval = (m: Media) => Math.max(0.5, m.duration / 80);
export const waveforms = new Map<string, Uint8Array>();
const thumbsReady = new Set<string>();

export function thumbUrl(m: Media, sourceT: number) {
  if (!thumbsReady.has(m.id)) return null;
  const i = Math.max(1, Math.floor(sourceT / thumbInterval(m)) + 1);
  const max = Math.max(1, Math.floor(m.duration / thumbInterval(m)));
  return mediaUrl(join(store.dir, ".shdw/thumbs", m.id, `thumb_${String(Math.min(i, max)).padStart(4, "0")}.jpg`));
}

export async function probeFile(path: string): Promise<Omit<Media, "id">> {
  const e = ext(path);
  const name = basename(path);
  if (IMAGE_EXT.includes(e)) {
    const img = new Image();
    img.src = mediaUrl(path);
    await img.decode().catch(() => {});
    return { name, path, kind: "image", duration: 5, width: img.naturalWidth || undefined, height: img.naturalHeight || undefined };
  }
  const info = JSON.parse(await invoke<string>("probe", { path }));
  const v = info.streams?.find((s: any) => s.codec_type === "video" && s.disposition?.attached_pic !== 1);
  const a = info.streams?.find((s: any) => s.codec_type === "audio");
  const dur = parseFloat(info.format?.duration ?? v?.duration ?? a?.duration ?? "0") || 0;
  if (!v) return { name, path, kind: "audio", duration: dur, hasAudio: true, codec: a?.codec_name };
  const [fn, fd] = String(v.avg_frame_rate || v.r_frame_rate || "30/1").split("/").map(Number);
  const rot = Math.abs(parseInt(v.tags?.rotate ?? v.side_data_list?.find((s: any) => s.rotation != null)?.rotation ?? "0")) % 180 === 90;
  return {
    name, path, kind: "video", duration: dur,
    width: rot ? v.height : v.width, height: rot ? v.width : v.height,
    fps: fd ? Math.round((fn / fd) * 1000) / 1000 : 30, hasAudio: !!a,
    codec: `${v.codec_name}${String(v.pix_fmt ?? "").includes("10") ? "-10bit" : ""}`,
  };
}

export function needsProxy(m: Media) {
  if (m.kind !== "video" || m.proxy) return false;
  const c = (m.codec ?? "").toLowerCase();
  return !PLAYABLE.has(c.replace("-10bit", "")) || c.includes("10bit") || !/\.(mp4|m4v|webm|mov|mkv)$/i.test(m.path);
}

/** Import absolute paths into the media pool. */
export async function importFiles(paths: string[], copy = false): Promise<Media[]> {
  const added: Media[] = [];
  for (let path of paths) {
    const e = ext(path);
    if (![...VIDEO_EXT, ...AUDIO_EXT, ...IMAGE_EXT].includes(e)) continue;
    try {
      if (copy && !store.rel(path).startsWith("media/")) {
        const dst = join(store.dir, "media", basename(path));
        if (!(await fs.exists(dst))) await fs.copy(path, dst);
        path = dst;
      }
      const existing = store.project.media.find((m) => store.abs(m.path).toLowerCase() === path.toLowerCase());
      if (existing) { added.push(existing); continue; }
      const info = await probeFile(path);
      const m: Media = { id: uid("m"), ...info, path: store.rel(path) };
      added.push(m);
    } catch (err: any) {
      store.error(basename(path), "import failed: " + (err?.message ?? err));
    }
  }
  const fresh = added.filter((m) => !store.project.media.includes(m));
  if (fresh.length) store.mutate("import", (p) => p.media.push(...fresh));
  for (const m of fresh) void prepareMedia(m);
  return added;
}

/** Background work per media: thumbnails, waveform, proxy. */
export async function prepareMedia(m: Media) {
  const abs = store.abs(m.path);
  if (m.kind === "video") {
    const dir = join(store.dir, ".shdw/thumbs", m.id);
    const first = join(dir, "thumb_0001.jpg");
    if (!(await fs.exists(first))) {
      try { await invoke("thumbnails", { path: abs, outDir: dir, duration: m.duration }); } catch (e) { console.warn(e); }
    }
    thumbsReady.add(m.id);
    store.emit("thumbs");
    if (needsProxy(m)) void makeProxy(m);
  }
  if (m.kind === "audio" || m.hasAudio) {
    const cachePath = join(store.dir, ".shdw/wave", m.id + ".bin");
    try {
      let data: Uint8Array;
      if (await fs.exists(cachePath)) data = await fs.readBytes(cachePath);
      else {
        data = new Uint8Array(await invoke<ArrayBuffer>("waveform", { path: abs }));
        await fs.writeBytes(cachePath, data);
      }
      waveforms.set(m.id, data);
      store.emit("thumbs");
    } catch (e) { console.warn("waveform", e); }
  }
}

export const proxying = new Set<string>();
export async function makeProxy(m: Media) {
  if (proxying.has(m.id)) return;
  proxying.add(m.id);
  store.emit("thumbs");
  const out = join(store.dir, ".shdw/proxies", m.id + ".mp4");
  try {
    if (!(await fs.exists(out))) await invoke("make_proxy", { id: m.id, path: store.abs(m.path), out });
    store.mutate("proxy", (p) => { const mm = p.media.find((x) => x.id === m.id); if (mm) mm.proxy = store.rel(out); });
    store.emit("toast", `Optimized media ready: ${m.name}`);
  } catch (e: any) {
    store.error(m.name, "proxy failed: " + e);
  } finally {
    proxying.delete(m.id);
    store.emit("thumbs");
  }
}

export interface Segment { start: number; end: number; text: string }

/** Whisper transcript for a media item (cached in transcripts/). */
export async function transcribe(m: Media, force = false): Promise<Segment[]> {
  const out = join(store.dir, "transcripts", m.id + ".json");
  if (!force && (await fs.exists(out))) return JSON.parse(await fs.readText(out)).segments ?? [];
  store.emit("toast", `Transcribing ${m.name}…`);
  const raw = await invoke<string>("transcribe", { path: store.abs(m.path), model: localStorage.getItem("shdw.whisperModel") || "base", language: null });
  const segments = parseWhisper(raw);
  await fs.writeText(out, JSON.stringify({ media: m.id, segments }, null, 2));
  store.mutate("transcript", (p) => { const mm = p.media.find((x) => x.id === m.id); if (mm) mm.transcript = store.rel(out); });
  store.emit("toast", `Transcript ready (${segments.length} segments)`);
  return segments;
}

/** ffmpeg's whisper filter writes JSON lines `{start,end,text}` in milliseconds. */
function parseWhisper(raw: string): Segment[] {
  const segs: Segment[] = [];
  for (const line of raw.trim().split(/\r?\n/)) {
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    const start = num(o.start) / 1000, end = num(o.end) / 1000;
    const text = String(o.text ?? "").trim();
    if (!text || start < 0 || end <= start || /^[!.\s]+$/.test(text)) continue;
    segs.push({ start, end, text });
  }
  segs.sort((a, b) => a.start - b.start);
  // whisper chunks can overlap slightly — clamp
  for (let i = 1; i < segs.length; i++) if (segs[i].start < segs[i - 1].end) segs[i - 1].end = segs[i].start;
  return segs;
}
const num = (v: any) => (typeof v === "number" ? v : parseFloat(v ?? "0") || 0);
