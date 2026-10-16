// Resolve-style clip processing: scene cut detection, silence removal,
// stabilization, noise reduction, voice enhance, reverse, optical-flow slow
// motion, loudness normalization, beat detection, freeze frame.

import { invoke, join } from "./ipc";
import { store } from "./store";
import { Clip, clipEnd, mediaOf, frameSnap } from "./model";
import { importFiles, waveforms } from "./media";
import { splitClip, rippleDeleteRange } from "./actions";
import { uid } from "./model";

const enc = ["-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p", "-movflags", "+faststart"];
const aenc = ["-c:a", "aac", "-b:a", "256k"];

function srcRange(c: Clip) {
  const sin = (c.source as any).in ?? 0, sp = c.speed ?? 1;
  return { sin, sp, sout: sin + c.duration * sp };
}

export async function sceneDetect(c: Clip, threshold = 0.32) {
  const m = mediaOf(store.project, c);
  if (!m || m.kind !== "video") throw new Error("Scene detection needs a video clip");
  store.emit("toast", "Detecting scene cuts…");
  const cuts = await invoke<number[]>("detect_scenes", { path: store.abs(m.path), threshold });
  const { sin, sp, sout } = srcRange(c);
  const times = cuts.filter((t) => t > sin + 0.1 && t < sout - 0.1).map((t) => frameSnap(c.start + (t - sin) / sp, store.fps));
  store.mutate("scene detect", (p) => {
    const group = c.link ? p.clips.filter((x) => x.link === c.link) : [c];
    for (const g of group) {
      let cur = g;
      for (const t of times) {
        if (t <= cur.start || t >= clipEnd(cur)) continue;
        const right = splitClip(cur, t);
        right.link = g.link ? uid("l") + "_" + Math.round(t * 1000) : undefined;
        p.clips.push(right);
        cur = right;
      }
    }
    // re-link pieces of the same cut
    if (c.link) {
      const byStart = new Map<number, string>();
      for (const x of p.clips.filter((x) => x.link?.includes("_"))) {
        const key = Math.round(x.start * 1000);
        if (!byStart.has(key)) byStart.set(key, uid("l"));
        x.link = byStart.get(key);
      }
    }
  });
  store.emit("toast", `${times.length} scene cuts`);
  return times.length;
}

export async function removeSilence(c: Clip, noiseDb = -32, minDur = 0.45, pad = 0.08) {
  const m = mediaOf(store.project, c);
  if (!m || (m.kind !== "audio" && !m.hasAudio)) throw new Error("Clip has no audio");
  store.emit("toast", "Finding silences…");
  const sil = await invoke<[number, number][]>("detect_silence", { path: store.abs(m.path), noiseDb, minDur });
  const { sin, sp, sout } = srcRange(c);
  const ranges = sil
    .map(([a, b]) => [Math.max(a, sin) + pad, Math.min(b, sout) - pad] as [number, number])
    .filter(([a, b]) => b - a > 0.1)
    .map(([a, b]) => [frameSnap(c.start + (a - sin) / sp, store.fps), frameSnap(c.start + (b - sin) / sp, store.fps)] as [number, number])
    .sort((x, y) => y[0] - x[0]);
  for (const [a, b] of ranges) rippleDeleteRange(a, b);
  store.emit("toast", `Removed ${ranges.length} silences`);
  return ranges.length;
}

export async function normalizeLoudness(c: Clip, target = -14) {
  const m = mediaOf(store.project, c);
  if (!m) return;
  const lufs = await invoke<number>("loudness", { path: store.abs(m.path) });
  const gain = Math.min(4, Math.pow(10, (target - lufs) / 20));
  store.mutate("normalize", (p) => {
    for (const x of p.clips) if (x.source.type === "media" && (x.source as any).media === m.id && p.tracks.find((t) => t.id === x.track)?.kind === "audio") x.volume = +gain.toFixed(3);
  });
  store.emit("toast", `${lufs.toFixed(1)} LUFS → ${target} LUFS (gain ${gain.toFixed(2)}×)`);
}

/** Energy-flux onset detection on the cached waveform → timeline markers. */
export function detectBeats(c: Clip) {
  const m = mediaOf(store.project, c);
  const wf = m && waveforms.get(m.id);
  if (!wf) throw new Error("Waveform not ready yet");
  const { sin, sp, sout } = srcRange(c);
  const a = Math.floor(sin * 100), b = Math.min(wf.length, Math.floor(sout * 100));
  const env: number[] = [];
  for (let i = a; i < b; i++) env.push(wf[i]);
  const flux = env.map((v, i) => Math.max(0, v - (env[i - 1] ?? v)));
  const beats: number[] = [];
  const win = 50;
  let last = -1e9;
  for (let i = 1; i < flux.length - 1; i++) {
    const lo = Math.max(0, i - win), hi = Math.min(flux.length, i + win);
    let mean = 0; for (let j = lo; j < hi; j++) mean += flux[j]; mean /= hi - lo;
    let sd = 0; for (let j = lo; j < hi; j++) sd += (flux[j] - mean) ** 2; sd = Math.sqrt(sd / (hi - lo));
    if (flux[i] > mean + 1.6 * sd && flux[i] >= flux[i - 1] && flux[i] >= flux[i + 1] && i - last > 22) { beats.push(i); last = i; }
  }
  const times = beats.map((i) => frameSnap(c.start + ((a + i) / 100 - sin) / sp, store.fps));
  store.mutate("beats", (p) => { for (const t of times) p.markers.push({ t, name: "beat", color: "#ff375f" }); });
  store.emit("toast", `${times.length} beats marked`);
  return times;
}

type Proc = "stabilize" | "denoise" | "audioDenoise" | "voiceEnhance" | "reverse" | "slowmo";
export const PROCS: Record<Proc, string> = {
  stabilize: "Stabilize", denoise: "Video noise reduction", audioDenoise: "Audio noise reduction",
  voiceEnhance: "Voice enhance (dialogue)", reverse: "Reverse clip", slowmo: "Optical-flow slow motion (25%)",
};

export async function processClip(c: Clip, kind: Proc) {
  const m = mediaOf(store.project, c);
  if (!m || m.kind === "image") throw new Error("Needs a video or audio clip");
  const { sin, sp, sout } = srcRange(c);
  const isAudio = m.kind === "audio";
  const ext = isAudio ? "wav" : "mp4";
  const out = join(store.dir, ".shdw", "processed", `${m.id}_${kind}_${Math.round(sin * 1000)}.${ext}`);
  const fps = store.fps;
  const trim = ["-ss", sin.toFixed(3), "-t", (sout - sin).toFixed(3)];
  let args: string[]; let partial = false; let stretch = 1;
  switch (kind) {
    case "stabilize": args = ["-vf", "deshake=rx=48:ry=48:edge=mirror,scale=trunc(iw/2)*2:trunc(ih/2)*2", ...enc, ...(m.hasAudio ? ["-c:a", "copy"] : [])]; break;
    case "denoise": args = ["-vf", "hqdn3d=3:2.5:6:4.5", ...enc, ...(m.hasAudio ? ["-c:a", "copy"] : [])]; break;
    case "audioDenoise": args = isAudio ? ["-af", "afftdn=nf=-25,highpass=f=70"] : ["-c:v", "copy", "-af", "afftdn=nf=-25,highpass=f=70", ...aenc]; break;
    case "voiceEnhance": { const af = "highpass=f=80,afftdn=nf=-24,equalizer=f=3000:t=q:w=1.2:g=3,acompressor=threshold=-20dB:ratio=3:attack=5:release=80,loudnorm=I=-16:TP=-1.5:LRA=11"; args = isAudio ? ["-af", af] : ["-c:v", "copy", "-af", af, ...aenc]; break; }
    case "reverse": partial = true; args = [...trim, ...(isAudio ? ["-af", "areverse"] : ["-vf", "reverse", ...(m.hasAudio ? ["-af", "areverse"] : []), ...enc, ...(m.hasAudio ? aenc : [])])]; break;
    case "slowmo": partial = true; stretch = 4; args = [...trim, "-vf", `minterpolate=fps=${fps * 4}:mi_mode=mci:mc_mode=aobmc:vsbmc=1,setpts=4*PTS,fps=${fps}`, "-an", ...enc]; break;
  }
  store.emit("toast", `${PROCS[kind]}: processing ${m.name}…`);
  await invoke<string>("ffmpeg_process", { input: store.abs(m.path), args, output: out });
  const [nm] = await importFiles([out]);
  store.mutate(kind, (p) => {
    const group = c.link && !partial ? p.clips.filter((x) => x.link === c.link) : [c];
    for (const x of group) {
      const xm = mediaOf(p, x);
      if (kind === "audioDenoise" || kind === "voiceEnhance") { if (p.tracks.find((t) => t.id === x.track)?.kind !== "audio" && !isAudio) continue; }
      else if (xm?.id !== m.id) continue;
      (x.source as any).media = nm.id;
      if (partial) { (x.source as any).in = 0; x.speed = 1; x.duration *= stretch; if (kind === "slowmo") delete x.link; }
    }
    if (kind === "slowmo" && c.link) for (const x of p.clips) if (x.link === c.link && x.id !== c.id) delete x.link;
    nm.name = `${m.name} · ${PROCS[kind]}`;
  });
  store.emit("toast", `${PROCS[kind]} done`);
}

export function toggleFreeze(c: Clip) {
  store.mutate("freeze", () => { c.freeze = !c.freeze; });
}
