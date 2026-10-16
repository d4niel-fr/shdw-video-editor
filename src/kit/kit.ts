// Helper library handed to motion modules as `api.kit`.

import { springCurve, hexToRgb, rgbToHex } from "../model";

const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const map = (v: number, a: number, b: number, c: number, d: number, clampIt = true) => {
  const k = (v - a) / (b - a || 1e-9);
  return lerp(c, d, clampIt ? clamp(k) : k);
};
const smoothstep = (a: number, b: number, v: number) => { const k = clamp((v - a) / (b - a)); return k * k * (3 - 2 * k); };

const c1 = 1.70158, c2 = c1 * 1.525, c3 = c1 + 1, c4 = (2 * Math.PI) / 3;
const outBounce = (x: number) => {
  const n1 = 7.5625, d1 = 2.75;
  if (x < 1 / d1) return n1 * x * x;
  if (x < 2 / d1) return n1 * (x -= 1.5 / d1) * x + 0.75;
  if (x < 2.5 / d1) return n1 * (x -= 2.25 / d1) * x + 0.9375;
  return n1 * (x -= 2.625 / d1) * x + 0.984375;
};
const ease = {
  linear: (x: number) => x,
  inQuad: (x: number) => x * x,
  outQuad: (x: number) => 1 - (1 - x) * (1 - x),
  inOutQuad: (x: number) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2),
  inCubic: (x: number) => x * x * x,
  outCubic: (x: number) => 1 - Math.pow(1 - x, 3),
  inOutCubic: (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
  inQuart: (x: number) => x ** 4,
  outQuart: (x: number) => 1 - Math.pow(1 - x, 4),
  inOutQuart: (x: number) => (x < 0.5 ? 8 * x ** 4 : 1 - Math.pow(-2 * x + 2, 4) / 2),
  inExpo: (x: number) => (x === 0 ? 0 : Math.pow(2, 10 * x - 10)),
  outExpo: (x: number) => (x === 1 ? 1 : 1 - Math.pow(2, -10 * x)),
  inOutExpo: (x: number) => (x === 0 ? 0 : x === 1 ? 1 : x < 0.5 ? Math.pow(2, 20 * x - 10) / 2 : (2 - Math.pow(2, -20 * x + 10)) / 2),
  inBack: (x: number) => c3 * x * x * x - c1 * x * x,
  outBack: (x: number) => 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2),
  inOutBack: (x: number) => (x < 0.5 ? (Math.pow(2 * x, 2) * ((c2 + 1) * 2 * x - c2)) / 2 : (Math.pow(2 * x - 2, 2) * ((c2 + 1) * (x * 2 - 2) + c2) + 2) / 2),
  outElastic: (x: number) => (x === 0 ? 0 : x === 1 ? 1 : Math.pow(2, -10 * x) * Math.sin((x * 10 - 0.75) * c4) + 1),
  outBounce,
};

/** Physical spring: x = seconds since start. damping 1 = no overshoot. */
const spring = (x: number, damping = 1, response = 0.4) => (x <= 0 ? 0 : springCurve(x, damping, response, 1));
const stagger = (t: number, i: number, each = 0.08, dur = 0.6) => clamp((t - i * each) / dur);
const seq = (t: number, start: number, end: number) => clamp((t - start) / (end - start || 1e-9));

function rand(seed: number) {
  let x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}
function noise(x: number, y = 0) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const h = (a: number, b: number) => rand(a * 157.1 + b * 311.7);
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  return lerp(lerp(h(xi, yi), h(xi + 1, yi), u), lerp(h(xi, yi + 1), h(xi + 1, yi + 1), u), v) * 2 - 1;
}

const mixColor = (a: string, b: string, k: number) => {
  const pa = hexToRgb(a), pb = hexToRgb(b);
  return rgbToHex(pa.map((v, i) => lerp(v, pb[i], k)));
};

export interface TextOpts {
  font?: string; size?: number; weight?: number | string; color?: string; align?: CanvasTextAlign;
  baseline?: CanvasTextBaseline; tracking?: number; italic?: boolean; stroke?: string; strokeWidth?: number;
  shadow?: { color: string; blur: number; x?: number; y?: number }; maxWidth?: number;
}

const fontString = (o: TextOpts) =>
  `${o.italic ? "italic " : ""}${o.weight ?? 600} ${o.size ?? 64}px "${o.font ?? "Inter"}", "SF Pro Display", "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif`;

function applyText(ctx: CanvasRenderingContext2D, o: TextOpts) {
  ctx.font = fontString(o);
  (ctx as any).letterSpacing = `${(o.tracking ?? 0) * (o.size ?? 64)}px`;
  ctx.textAlign = o.align ?? "center";
  ctx.textBaseline = o.baseline ?? "middle";
}

function text(ctx: CanvasRenderingContext2D, str: string, x: number, y: number, o: TextOpts = {}) {
  ctx.save();
  applyText(ctx, o);
  if (o.shadow) {
    ctx.shadowColor = o.shadow.color; ctx.shadowBlur = o.shadow.blur;
    ctx.shadowOffsetX = o.shadow.x ?? 0; ctx.shadowOffsetY = o.shadow.y ?? 0;
  }
  if (o.stroke) {
    ctx.lineJoin = "round"; ctx.strokeStyle = o.stroke; ctx.lineWidth = o.strokeWidth ?? 4;
    ctx.strokeText(str, x, y, o.maxWidth);
  }
  ctx.fillStyle = o.color ?? "#fff";
  ctx.fillText(str, x, y, o.maxWidth);
  ctx.restore();
}

function measure(ctx: CanvasRenderingContext2D, str: string, o: TextOpts = {}) {
  ctx.save(); applyText(ctx, o);
  const m = ctx.measureText(str);
  ctx.restore();
  return { width: m.width, ascent: m.actualBoundingBoxAscent, descent: m.actualBoundingBoxDescent };
}

const splitWords = (s: string) => s.split(/\s+/).filter(Boolean);
const splitChars = (s: string) => Array.from(s);
const typewriter = (s: string, k: number) => Array.from(s).slice(0, Math.round(clamp(k) * Array.from(s).length)).join("");

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function path(ctx: CanvasRenderingContext2D, pts: number[][], close = false) {
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
  if (close) ctx.closePath();
}

function gradient(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, stops: (string | [number, string])[]) {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  stops.forEach((s, i) => (Array.isArray(s) ? g.addColorStop(s[0], s[1]) : g.addColorStop(i / Math.max(1, stops.length - 1), s)));
  return g;
}

function glow(ctx: CanvasRenderingContext2D, color: string, blur: number) {
  ctx.shadowColor = color; ctx.shadowBlur = blur; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
}

export const kit = {
  lerp, clamp, map, smoothstep, ease, spring, stagger, seq, rand, noise, hexToRgb, rgbToHex, mixColor,
  text, measure, splitWords, splitChars, typewriter, roundRect, path, gradient, glow, fontString,
  TAU: Math.PI * 2,
};
export type Kit = typeof kit;
