// Editing operations shared by the timeline, menus, keyboard and control API.

import { store } from "./store";
import { Clip, Media, Track, uid, clipEnd, frameSnap, deepClone, TrackKind, Source } from "./model";
import { Segment, transcribe } from "./media";

const fps = () => store.fps;

export function tracksOf(kind: TrackKind) { return store.project.tracks.filter((t) => t.kind === kind); }

export function addTrack(kind: TrackKind, ref?: string, above = true) {
  store.mutate("add track", (p) => {
    const n = p.tracks.filter((t) => t.kind === kind).length + 1;
    const prefix = kind === "video" ? "V" : kind === "audio" ? "A" : "S";
    let id = `${prefix}${n}`;
    while (p.tracks.some((t) => t.id === id)) id += "'";
    const t: Track = { id, kind, name: kind === "subtitle" ? `Subtitles ${n}` : id, volume: 1, pan: 0 };
    if (kind === "subtitle") t.style = { font: "Inter", size: 54, weight: 600, color: "#ffffff", y: 0.88, background: { color: "rgba(0,0,0,0.55)", padding: 14, radius: 10 } };
    const refIdx = ref ? p.tracks.findIndex((x) => x.id === ref && x.kind === kind) : -1;
    // array order = bottom-up for video; "above" in the UI means later in the array for video/subtitle, earlier for audio
    if (refIdx >= 0) p.tracks.splice(kind === "audio" ? (above ? refIdx : refIdx + 1) : (above ? refIdx + 1 : refIdx), 0, t);
    else { const lastIdx = p.tracks.map((x) => x.kind).lastIndexOf(kind); p.tracks.splice(lastIdx + 1, 0, t); }
  });
}

export function removeEmptyTracks() {
  store.mutate("remove empty tracks", (p) => {
    p.tracks = p.tracks.filter((t) => p.clips.some((c) => c.track === t.id) || p.tracks.filter((x) => x.kind === t.kind).indexOf(t) === 0);
  });
}

export function moveTrack(id: string, dir: number) {
  store.mutate("move track", (p) => {
    const i = p.tracks.findIndex((t) => t.id === id);
    const kind = p.tracks[i].kind;
    let j = i + dir;
    while (j >= 0 && j < p.tracks.length && p.tracks[j].kind !== kind) j += dir;
    if (j < 0 || j >= p.tracks.length) return;
    [p.tracks[i], p.tracks[j]] = [p.tracks[j], p.tracks[i]];
  });
}

export function removeTrack(id: string) {
  store.mutate("remove track", (p) => {
    p.tracks = p.tracks.filter((t) => t.id !== id);
    p.clips = p.clips.filter((c) => c.track !== id);
  });
}

/** First free track of kind with no overlap in [start, end). */
export function freeTrack(kind: TrackKind, start: number, end: number, preferred?: string): string {
  const p = store.project;
  const order = tracksOf(kind);
  const pref = order.find((t) => t.id === preferred);
  const candidates = pref ? [pref, ...order.filter((t) => t !== pref)] : order;
  for (const t of candidates) {
    if (t.locked) continue;
    if (!p.clips.some((c) => c.track === t.id && c.start < end - 1e-6 && clipEnd(c) > start + 1e-6)) return t.id;
  }
  addTrack(kind);
  return tracksOf(kind).slice(-1)[0].id;
}

/** Place a media item on the timeline; video with audio gets a linked audio clip. */
export function placeMedia(m: Media, start: number, trackId?: string, srcIn = 0, srcOut?: number): Clip[] {
  const dur = Math.max(1 / fps(), (srcOut ?? m.duration) - srcIn);
  const clips: Clip[] = [];
  store.mutate("place", (p) => {
    const kind: TrackKind = m.kind === "audio" ? "audio" : "video";
    const tr = trackId && p.tracks.find((t) => t.id === trackId)?.kind === kind ? trackId : freeTrack(kind, start, start + dur, trackId);
    const link = m.kind === "video" && m.hasAudio ? uid("l") : undefined;
    const main: Clip = { id: uid("c"), track: tr, start, duration: dur, name: m.name, source: { type: "media", media: m.id, in: srcIn }, link };
    clips.push(main);
    if (link) {
      const at = freeTrack("audio", start, start + dur);
      clips.push({ id: uid("c"), track: at, start, duration: dur, name: m.name, source: { type: "media", media: m.id, in: srcIn }, link });
    }
    p.clips.push(...clips);
  });
  store.select(clips.map((c) => c.id));
  return clips;
}

export function addGenerated(source: Source, name: string, duration = 5, start = store.playhead, kind: TrackKind = "video") {
  let clip!: Clip;
  store.mutate("add " + name, (p) => {
    const track = freeTrack(kind, start, start + duration);
    clip = { id: uid("c"), track, start, duration, name, source };
    p.clips.push(clip);
  });
  store.select([clip.id]);
  return clip;
}

export const addText = (text = "Title") =>
  addGenerated({ type: "text", text, font: "Inter", size: 140, weight: 700, color: "#ffffff", align: "center", tracking: -0.025, animation: "fadeUp" } as any, "Text", 4);
export const addSolid = (color = "#1c1c1e") => addGenerated({ type: "solid", color }, "Solid Color", 5);
export const addGradient = () => addGenerated({ type: "gradient", colors: ["#0b0b2a", "#5e3bff", "#ff7aa8"], angle: 135 }, "Gradient", 5);
export const addAdjustment = () => addGenerated({ type: "adjustment" }, "Adjustment Layer", 5);
export const addMotion = (module: string, name: string, duration = 4, params: any = {}) =>
  addGenerated({ type: /\.html?$/i.test(module) ? "html" : "motion", module, params } as any, name, duration);

/** Split clips under the playhead (or the selection if any is under it). */
export function splitAt(t = store.playhead, onlySelected = true) {
  const p = store.project;
  let targets = p.clips.filter((c) => c.start < t - 1e-6 && clipEnd(c) > t + 1e-6 && !p.tracks.find((tr) => tr.id === c.track)?.locked);
  const sel = targets.filter((c) => store.selection.has(c.id));
  if (onlySelected && sel.length) targets = sel;
  if (!targets.length) return;
  store.mutate("split", (pp) => {
    const linkMap = new Map<string, string>();
    for (const c of targets) {
      const right = splitClip(c, t);
      if (c.link) {
        if (!linkMap.has(c.link)) linkMap.set(c.link, uid("l"));
        right.link = linkMap.get(c.link);
      }
      pp.clips.push(right);
    }
  });
}

/** Mutates `c` to the left part, returns the right part. */
export function splitClip(c: Clip, t: number): Clip {
  const cut = frameSnap(t, fps());
  const leftDur = cut - c.start;
  const right: Clip = deepClone(c);
  right.id = uid("c");
  right.start = cut;
  right.duration = c.duration - leftDur;
  if (right.source.type === "media") (right.source as any).in = ((c.source as any).in ?? 0) + leftDur * (c.speed ?? 1);
  if (c.keyframes) {
    for (const k of Object.keys(right.keyframes!)) right.keyframes![k] = right.keyframes![k].map((key) => ({ ...key, t: key.t - leftDur }));
  }
  delete right.transition;
  right.fadeIn = 0; c.fadeOut = 0;
  c.duration = leftDur;
  return right;
}

export function deleteSelection(ripple = false) {
  const ids = new Set(store.selection);
  if (!ids.size) return;
  store.mutate(ripple ? "ripple delete" : "delete", (p) => {
    const removed = p.clips.filter((c) => ids.has(c.id));
    p.clips = p.clips.filter((c) => !ids.has(c.id));
    if (ripple) {
      for (const r of removed.sort((a, b) => b.start - a.start)) {
        const tracks = new Set(removed.filter((x) => x.link && x.link === r.link).map((x) => x.track).concat(r.track));
        for (const c of p.clips) if (tracks.has(c.track) && c.start >= clipEnd(r) - 1e-6) c.start -= r.duration;
      }
    }
  });
  store.selection.clear();
  store.emit("selection");
}

/** Delete a time range across all unlocked tracks and close the gap. */
export function rippleDeleteRange(a: number, b: number, trackFilter?: (c: Clip) => boolean) {
  if (b <= a) return;
  store.mutate("ripple range", (p) => {
    const len = b - a;
    const next: Clip[] = [];
    for (const c of p.clips) {
      if (trackFilter && !trackFilter(c)) { next.push(c); continue; }
      const e = clipEnd(c);
      if (e <= a + 1e-6) { next.push(c); continue; }
      if (c.start >= b - 1e-6) { c.start -= len; next.push(c); continue; }
      if (c.start < a && e > b) { const right = splitClip(c, a); const r2 = splitClip(right, b); r2.start = a; next.push(c, r2); continue; }
      if (c.start < a) { c.duration = a - c.start; next.push(c); continue; }
      if (e > b) { const r = splitClip(c, b); r.start = a; next.push(r); continue; }
    }
    p.clips = next;
  });
}

let clipboard: Clip[] = [];
export function copySelection() { clipboard = deepClone(store.selectedClips()); }
export function cutSelection() { copySelection(); deleteSelection(); }
export function paste(at = store.playhead) {
  if (!clipboard.length) return;
  const base = Math.min(...clipboard.map((c) => c.start));
  const links = new Map<string, string>();
  const created: string[] = [];
  store.mutate("paste", (p) => {
    for (const src of clipboard) {
      const c = deepClone(src);
      c.id = uid("c");
      c.start = at + (src.start - base);
      if (c.link) { if (!links.has(c.link)) links.set(c.link, uid("l")); c.link = links.get(c.link); }
      const kind = p.tracks.find((t) => t.id === c.track)?.kind ?? "video";
      c.track = freeTrack(kind, c.start, clipEnd(c), c.track);
      p.clips.push(c);
      created.push(c.id);
    }
  });
  store.select(created);
}

export function duplicateSelection() { copySelection(); const end = Math.max(...store.selectedClips().map(clipEnd)); paste(end); }

export function nudge(dt: number) {
  if (!store.selection.size) return;
  store.mutate("nudge", (p) => { for (const c of p.clips) if (store.selection.has(c.id)) c.start = Math.max(0, c.start + dt); });
}

export function toggleLink() {
  const sel = store.selectedClips();
  if (!sel.length) return;
  const linked = sel.some((c) => c.link);
  store.mutate(linked ? "unlink" : "link", () => {
    const l = uid("l");
    for (const c of sel) if (linked) delete c.link; else c.link = l;
  });
}

export function toggleEnabled() {
  store.mutate("enable", () => { for (const c of store.selectedClips()) c.enabled = c.enabled === false; });
}

export function addMarker(t = store.playhead, name = "Marker") {
  store.mutate("marker", (p) => p.markers.push({ t, name, color: "#5e8bff" }));
}

export function setTransition(clipId: string, type: string, duration = 0.6) {
  store.mutate("transition", () => {
    const c = store.clip(clipId);
    if (c) c.transition = type ? { type, duration: Math.min(duration, c.duration) } : undefined;
  });
}

/** Add a transition at the cut nearest to the playhead on selected / any video track. */
export function transitionAtPlayhead(type = "crossDissolve") {
  const p = store.project, t = store.playhead;
  let best: Clip | undefined, d = Infinity;
  for (const c of p.clips) {
    const tr = p.tracks.find((x) => x.id === c.track);
    if (tr?.kind !== "video") continue;
    const hasPrev = p.clips.some((o) => o.track === c.track && Math.abs(clipEnd(o) - c.start) < 1 / p.settings.fps);
    if (!hasPrev) continue;
    const dist = Math.abs(c.start - t);
    if (dist < d) { d = dist; best = c; }
  }
  if (best) setTransition(best.id, type);
  else store.emit("toast", "No cut near playhead");
}

export function closeGaps(trackId?: string) {
  store.mutate("close gaps", (p) => {
    for (const tr of p.tracks) {
      if (trackId && tr.id !== trackId) continue;
      let t = 0;
      for (const c of p.clips.filter((c) => c.track === tr.id).sort((a, b) => a.start - b.start)) { c.start = t; t = clipEnd(c); }
    }
  });
}

/** Lay subtitle clips from transcripts of every clip using `mediaId`. */
export async function captionsFor(mediaId: string, trackId?: string) {
  const m = store.project.media.find((x) => x.id === mediaId);
  if (!m) throw new Error("unknown media " + mediaId);
  const segs = await transcribe(m);
  const track = trackId ?? tracksOf("subtitle")[0]?.id ?? (addTrack("subtitle"), tracksOf("subtitle")[0].id);
  const uses = store.project.clips.filter((c) => c.source.type === "media" && (c.source as any).media === mediaId && store.project.tracks.find((t) => t.id === c.track)?.kind === "video");
  let count = 0;
  store.mutate("captions", (p) => {
    for (const c of uses) {
      const sin = (c.source as any).in ?? 0, sp = c.speed ?? 1, sout = sin + c.duration * sp;
      for (const s of chunkSegments(segs)) {
        if (s.end <= sin || s.start >= sout) continue;
        const a = c.start + (Math.max(s.start, sin) - sin) / sp;
        const b = c.start + (Math.min(s.end, sout) - sin) / sp;
        if (b - a < 0.05) continue;
        p.clips = p.clips.filter((x) => !(x.track === track && x.start < b && clipEnd(x) > a));
        p.clips.push({ id: uid("c"), track, start: a, duration: b - a, name: "Caption", source: { type: "subtitle", text: s.text } });
        count++;
      }
    }
  });
  return count;
}

/** Split long whisper segments into caption-sized chunks (≤ 7 words). */
export function chunkSegments(segs: Segment[], maxWords = 7): Segment[] {
  const out: Segment[] = [];
  for (const s of segs) {
    const words = s.text.split(/\s+/).filter(Boolean);
    if (words.length <= maxWords) { out.push(s); continue; }
    const n = Math.ceil(words.length / maxWords);
    const per = (s.end - s.start) / words.length;
    for (let i = 0; i < n; i++) {
      const w = words.slice(i * maxWords, (i + 1) * maxWords);
      const a = s.start + i * maxWords * per;
      out.push({ start: a, end: a + w.length * per, text: w.join(" ") });
    }
  }
  return out;
}

export function exportSRT(trackId?: string) {
  const p = store.project;
  const tr = trackId ?? tracksOf("subtitle")[0]?.id;
  const subs = p.clips.filter((c) => c.track === tr && c.source.type === "subtitle").sort((a, b) => a.start - b.start);
  const ts = (t: number) => {
    const ms = Math.round(t * 1000);
    const pad = (n: number, w = 2) => String(n).padStart(w, "0");
    return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
  };
  return subs.map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(clipEnd(c))}\n${(c.source as any).text}\n`).join("\n");
}
