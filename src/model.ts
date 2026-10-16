// Project data model — mirrors agent/SHDW_AGENT_GUIDE.md exactly.

export type TrackKind = "video" | "audio" | "subtitle";
export type MediaKind = "video" | "audio" | "image";

export interface Settings { width: number; height: number; fps: number; background: string }

export interface Media {
  id: string; name: string; path: string; kind: MediaKind;
  duration: number; width?: number; height?: number; fps?: number; hasAudio?: boolean;
  codec?: string; proxy?: string; transcript?: string;
}

export interface TextStyle {
  font?: string; size?: number; weight?: number; color?: string; align?: "left" | "center" | "right";
  tracking?: number; lineHeight?: number; italic?: boolean;
  stroke?: { color: string; width: number }; shadow?: { color: string; blur: number; x?: number; y?: number };
  background?: { color: string; padding?: number; radius?: number }; y?: number;
}

export interface Track {
  id: string; kind: TrackKind; name: string;
  hidden?: boolean; locked?: boolean; muted?: boolean; solo?: boolean;
  volume?: number; pan?: number; height?: number; style?: TextStyle;
}

export type Source =
  | { type: "media"; media: string; in: number }
  | { type: "motion"; module: string; params?: Record<string, any> }
  | { type: "html"; module: string; params?: Record<string, any> }
  | ({ type: "text"; text: string; animation?: string; animDuration?: number } & TextStyle)
  | { type: "solid"; color: string }
  | { type: "gradient"; colors: string[]; angle?: number; radial?: boolean }
  | { type: "subtitle"; text: string }
  | { type: "adjustment" };

export interface Transform {
  x?: number; y?: number; scale?: number; scaleX?: number; scaleY?: number; rotation?: number;
  anchorX?: number; anchorY?: number; flipH?: boolean; flipV?: boolean;
  cropLeft?: number; cropRight?: number; cropTop?: number; cropBottom?: number;
}

export interface Effect { type: string; params?: Record<string, any>; enabled?: boolean }

export interface Grade {
  exposure?: number; contrast?: number; saturation?: number; temperature?: number; tint?: number;
  lift?: number[]; gamma?: number[]; gain?: number[]; offset?: number[];
  hue?: number; vibrance?: number; highlights?: number; shadows?: number; pivot?: number;
  lut?: string; lutMix?: number;
}

export type Ease = string | number[];
export interface Key { t: number; v: any; ease?: Ease }

export interface Clip {
  /** media clips: hold the first frame */
  freeze?: boolean;
  id: string; track: string; start: number; duration: number; name?: string;
  source: Source; transform?: Transform; opacity?: number; blend?: string; speed?: number;
  volume?: number; pan?: number; fadeIn?: number; fadeOut?: number; audioFadeIn?: number; audioFadeOut?: number;
  effects?: Effect[]; grade?: Grade; keyframes?: Record<string, Key[]>;
  transition?: { type: string; duration: number; params?: Record<string, any> };
  link?: string; enabled?: boolean; color?: string;
}

export interface Marker { t: number; name?: string; color?: string; note?: string }

export interface Project {
  version: number; name: string; settings: Settings;
  media: Media[]; tracks: Track[]; clips: Clip[]; markers: Marker[];
}

export const defaultProject = (name = "Untitled"): Project => ({
  version: 1,
  name,
  settings: { width: 1920, height: 1080, fps: 30, background: "#000000" },
  media: [],
  tracks: [
    { id: "V1", kind: "video", name: "V1" },
    { id: "V2", kind: "video", name: "V2" },
    { id: "V3", kind: "video", name: "V3" },
    { id: "V4", kind: "video", name: "V4" },
    { id: "A1", kind: "audio", name: "A1", volume: 1, pan: 0 },
    { id: "A2", kind: "audio", name: "A2", volume: 1, pan: 0 },
    { id: "A3", kind: "audio", name: "A3", volume: 1, pan: 0 },
    { id: "A4", kind: "audio", name: "A4", volume: 1, pan: 0 },
    { id: "S1", kind: "subtitle", name: "Subtitles", style: { font: "Inter", size: 54, weight: 600, color: "#ffffff", y: 0.88, background: { color: "rgba(0,0,0,0.55)", padding: 14, radius: 10 } } },
  ],
  clips: [],
  markers: [],
});

/** Fill in fields the agent may have omitted and repair obvious damage. */
export function normalize(p: any): Project {
  const d = defaultProject();
  const out: Project = {
    version: 1,
    name: p?.name ?? d.name,
    settings: { ...d.settings, ...(p?.settings ?? {}) },
    media: Array.isArray(p?.media) ? p.media : [],
    tracks: Array.isArray(p?.tracks) && p.tracks.length ? p.tracks : d.tracks,
    clips: Array.isArray(p?.clips) ? p.clips : [],
    markers: Array.isArray(p?.markers) ? p.markers : [],
  };
  for (const c of out.clips) {
    c.start = +c.start || 0;
    c.duration = Math.max(1 / out.settings.fps, +c.duration || 1);
    if (!c.source) c.source = { type: "solid", color: "#333" };
    if (!out.tracks.some((t) => t.id === c.track)) {
      const kind: TrackKind = c.source.type === "subtitle" ? "subtitle" : isAudioOnly(out, c) ? "audio" : "video";
      const first = out.tracks.find((t) => t.kind === kind);
      if (first) c.track = first.id;
    }
  }
  return out;
}

let idCounter = 0;
export const uid = (prefix: string) =>
  `${prefix}_${Date.now().toString(36).slice(-5)}${(idCounter++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

export const clipEnd = (c: Clip) => c.start + c.duration;
export const mediaOf = (p: Project, c: Clip) => (c.source.type === "media" ? p.media.find((m) => m.id === (c.source as any).media) : undefined);
export const isAudioOnly = (p: Project, c: Clip) => mediaOf(p, c)?.kind === "audio";
export const trackOf = (p: Project, c: Clip) => p.tracks.find((t) => t.id === c.track);

export function projectDuration(p: Project) {
  let d = 0;
  for (const c of p.clips) if (c.enabled !== false) d = Math.max(d, clipEnd(c));
  return d;
}

export const frameSnap = (t: number, fps: number) => Math.round(t * fps) / fps;

export function timecode(t: number, fps: number) {
  const neg = t < 0; t = Math.abs(t);
  const f = Math.floor(t * fps + 1e-6);
  const fr = f % Math.round(fps);
  const s = Math.floor(f / Math.round(fps));
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${neg ? "-" : ""}${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}:${pad(fr)}`;
}

// ---------- easing & keyframes ----------

function bezier(x1: number, y1: number, x2: number, y2: number) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sy = (t: number) => ((ay * t + by) * t + cy) * t;
  const dx = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number) => {
    let t = x;
    for (let i = 0; i < 8; i++) {
      const e = sx(t) - x; const d = dx(t);
      if (Math.abs(e) < 1e-5 || Math.abs(d) < 1e-6) break;
      t -= e / d;
    }
    return sy(Math.min(1, Math.max(0, t)));
  };
}

/** Apple-style spring step response: damping ratio + response (s), normalized to 0..1 over [0,1]. */
export function springCurve(x: number, damping = 1, response = 0.4, total = 1) {
  const t = x * total;
  const w = (2 * Math.PI) / response;
  if (damping >= 1) return 1 - (1 + w * t) * Math.exp(-w * t);
  const wd = w * Math.sqrt(1 - damping * damping);
  return 1 - Math.exp(-damping * w * t) * (Math.cos(wd * t) + ((damping * w) / wd) * Math.sin(wd * t));
}

const backS = 1.70158;
export const EASES: Record<string, (x: number) => number> = {
  linear: (x) => x,
  hold: () => 0,
  easeIn: (x) => x * x * x,
  easeOut: (x) => 1 - Math.pow(1 - x, 3),
  easeInOut: (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
  easeInBack: (x) => (backS + 1) * x * x * x - backS * x * x,
  easeOutBack: (x) => 1 + (backS + 1) * Math.pow(x - 1, 3) + backS * Math.pow(x - 1, 2),
  easeOutExpo: (x) => (x === 1 ? 1 : 1 - Math.pow(2, -10 * x)),
  easeInOutExpo: (x) => (x === 0 ? 0 : x === 1 ? 1 : x < 0.5 ? Math.pow(2, 20 * x - 10) / 2 : (2 - Math.pow(2, -20 * x + 10)) / 2),
  spring: (x) => springCurve(x, 1, 0.35),
  bounce: (x) => springCurve(x, 0.6, 0.45),
};

export function applyEase(e: Ease | undefined, x: number) {
  if (!e) return x;
  if (Array.isArray(e)) return bezier(e[0], e[1], e[2], e[3])(x);
  return (EASES[e] ?? EASES.linear)(x);
}

function lerpValue(a: any, b: any, k: number): any {
  if (typeof a === "number" && typeof b === "number") return a + (b - a) * k;
  if (Array.isArray(a) && Array.isArray(b)) return a.map((v, i) => lerpValue(v, b[i], k));
  if (typeof a === "string" && typeof b === "string" && a.startsWith("#") && b.startsWith("#")) {
    const pa = hexToRgb(a), pb = hexToRgb(b);
    return rgbToHex(pa.map((v, i) => v + (pb[i] - v) * k));
  }
  return k < 1 ? a : b;
}

export function evalKeys(keys: Key[] | undefined, t: number, fallback: any) {
  if (!keys || !keys.length) return fallback;
  if (t <= keys[0].t) return keys[0].v;
  const last = keys[keys.length - 1];
  if (t >= last.t) return last.v;
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1];
    if (t >= a.t && t <= b.t) {
      if (a.ease === "hold") return a.v;
      const k = applyEase(a.ease, (t - a.t) / Math.max(1e-9, b.t - a.t));
      return lerpValue(a.v, b.v, k);
    }
  }
  return fallback;
}

/** Resolve an animatable property for a clip at clip-local time `lt`. */
export function prop(c: Clip, path: string, lt: number, fallback: any) {
  return evalKeys(c.keyframes?.[path], lt, fallback);
}

export function hexToRgb(h: string): number[] {
  let s = h.replace("#", "");
  if (s.length === 3) s = s.split("").map((c) => c + c).join("");
  const n = parseInt(s.slice(0, 6), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export const rgbToHex = (c: number[]) => "#" + c.slice(0, 3).map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");

export const deepClone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
