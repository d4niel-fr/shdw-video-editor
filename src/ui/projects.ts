import "./projects.css";
// Projects page: each project is a glass folder (back panel with generated
// liquid art, its latest renders as files, a frosted front panel). Vanilla
// port of the "Glass Folder Cards" component.

import { h, modal } from "./dom";
import { fs, basename, join, mediaUrl, norm } from "../ipc";

type Recipe = { style: "marble" | "streak"; colors: string[]; scale: number; warp: number; angle: number; gloss: number; veins: number };

const PRESETS: Recipe[] = [
  { style: "streak", colors: ["#f4efe9", "#e9c2b8", "#c2433f", "#2a1e2a", "#22395e", "#6f97c2", "#e5edf4"], scale: 0.7, warp: 1.4, angle: -0.62, gloss: 0.18, veins: 0 },
  { style: "marble", colors: ["#07090c", "#16252c", "#3d5f68", "#1a1416", "#a3201a", "#ef4a2b", "#ff8a5c"], scale: 0.62, warp: 3.2, angle: -0.5, gloss: 0.55, veins: 0.6 },
  { style: "marble", colors: ["#120c18", "#3e2850", "#8f6c9c", "#2b1a24", "#b3502f", "#eab08a", "#fbe7d2"], scale: 0.75, warp: 3.6, angle: 0.8, gloss: 0.5, veins: 0.5 },
  { style: "streak", colors: ["#f7f8fa", "#d9e2ea", "#9fb4c7", "#e8edf2", "#bccbd8", "#ffffff"], scale: 0.7, warp: 1.6, angle: 0.35, gloss: 0.25, veins: 0 },
  { style: "marble", colors: ["#070b08", "#173024", "#4f7a5a", "#141812", "#a7843a", "#e9cf87", "#fbf3d6"], scale: 0.7, warp: 3.4, angle: 2.1, gloss: 0.5, veins: 0.5 },
];

const hexToRgb = (hex: string): [number, number, number] => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const hash = (s: string) => { let x = 2166136261; for (let i = 0; i < s.length; i++) x = Math.imul(x ^ s.charCodeAt(i), 16777619); return x >>> 0; };
function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function makeFbm(seed: number) {
  const r = rng(seed), perm = new Uint8Array(512), grad = new Float32Array(512), p: number[] = [];
  for (let i = 0; i < 256; i++) p.push(i);
  for (let i = 255; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  for (let i = 0; i < 256; i++) { const a = r() * Math.PI * 2; grad[i * 2] = Math.cos(a); grad[i * 2 + 1] = Math.sin(a); }
  const noise = (x: number, y: number) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi, X = xi & 255, Y = yi & 255;
    const g = (hh: number, dx: number, dy: number) => grad[hh] * dx + grad[hh + 1] * dy;
    const d00 = g(perm[X + perm[Y]] * 2, xf, yf), d10 = g(perm[X + 1 + perm[Y]] * 2, xf - 1, yf);
    const d01 = g(perm[X + perm[Y + 1]] * 2, xf, yf - 1), d11 = g(perm[X + 1 + perm[Y + 1]] * 2, xf - 1, yf - 1);
    const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10), v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
    return d00 + u * (d10 - d00) + v * (d01 - d00 + u * (d11 - d01 - d10 + d00));
  };
  return (x: number, y: number, oct: number) => {
    let s = 0, amp = 0.5;
    for (let i = 0; i < oct; i++) { s += amp * noise(x, y); const nx = 1.6 * x + 1.2 * y + 7.1; y = -1.2 * x + 1.6 * y + 3.3; x = nx; amp *= 0.5; }
    return s;
  };
}

/** Domain-warped noise shaded as a liquid surface, painted a few rows per frame. */
function artJob(w: number, h: number, R: Recipe, seed: number) {
  const stops = R.colors.map((c, i) => ({ t: i / (R.colors.length - 1), c: hexToRgb(c) }));
  const fbm = makeFbm(seed * 977 + 13), r = rng(seed + 1), ox = r() * 50, oy = r() * 50;
  const ang = R.angle + (r() - 0.5) * 0.5, ca = Math.cos(ang), sa = Math.sin(ang), m = Math.min(w, h);
  const F = new Float32Array(w * h), Q = new Float32Array(w * h), px = new Uint8ClampedArray(w * h * 4);
  let row = 0;
  const step = (rows: number) => {
    const end = Math.min(h, row + rows);
    for (; row < end; row++) for (let x = 0; x < w; x++) {
      const u = (x - w / 2) / m, v = (row - h / 2) / m;
      let X = (u * ca - v * sa) * R.scale, Y = (u * sa + v * ca) * R.scale;
      if (R.style === "streak") { X *= 0.14; Y *= 2.2; }
      X += ox; Y += oy;
      const qx = fbm(X, Y, 3), qy = fbm(X + 5.2, Y + 1.3, 3);
      const rx = fbm(X + R.warp * qx + 1.7, Y + R.warp * qy + 9.2, 3), ry = fbm(X + R.warp * qx + 8.3, Y + R.warp * qy + 2.8, 3);
      F[row * w + x] = fbm(X + R.warp * rx, Y + R.warp * ry, 4);
      Q[row * w + x] = Math.hypot(qx, qy);
    }
    if (row < h) return false;
    const sample: number[] = [];
    for (let i = 0; i < F.length; i += Math.max(1, Math.floor(F.length / 4096))) sample.push(F[i]);
    sample.sort((a, b) => a - b);
    const lo = sample[Math.floor(sample.length * 0.02)], hi = sample[Math.floor(sample.length * 0.98)], k = 1 / (hi - lo || 1), slope = k * m * 0.012;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const t = Math.min(1, Math.max(0, (F[i] - lo) * k));
      let j = 1; while (j < stops.length - 1 && stops[j].t < t) j++;
      const a = stops[j - 1], b = stops[j];
      let f = Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t || 1))); f = f * f * (3 - 2 * f);
      const gx = (F[x < w - 1 ? i + 1 : i] - F[x > 0 ? i - 1 : i]) * slope, gy = (F[y < h - 1 ? i + w : i] - F[y > 0 ? i - w : i]) * slope;
      const nd = (gx * 0.55 + gy * 0.65 + 0.52) / Math.sqrt(gx * gx + gy * gy + 1);
      const spec = Math.pow(Math.max(0, nd), 24) * R.gloss * 255;
      const vein = R.veins * Math.max(0, 1 - Math.abs(Q[i] - 0.42) * 14) * 0.6;
      const lit = (0.82 + 0.28 * nd) * (1 + 0.035 * Math.sin(t * 150 + Q[i] * 24)) * (1 - vein);
      for (let c = 0; c < 3; c++) px[i * 4 + c] = (a.c[c] + (b.c[c] - a.c[c]) * f) * lit + spec;
      px[i * 4 + 3] = 255;
    }
    return true;
  };
  return { w, h, px, step };
}

// one shared painter so a page of folders never janks
const cache = new Map<string, Promise<HTMLCanvasElement>>();
const queue: { job: ReturnType<typeof artJob>; done: (c: HTMLCanvasElement) => void }[] = [];
let pumping = false;
function pump() {
  if (pumping) return;
  pumping = true;
  const tick = () => {
    const until = performance.now() + 7;
    while (queue.length && performance.now() < until) {
      const q = queue[0];
      if (q.job.step(3)) {
        queue.shift();
        const c = document.createElement("canvas"); c.width = q.job.w; c.height = q.job.h;
        c.getContext("2d")!.putImageData(new ImageData(q.job.px, q.job.w, q.job.h), 0, 0);
        q.done(c);
      }
    }
    if (queue.length) requestAnimationFrame(tick); else pumping = false;
  };
  requestAnimationFrame(tick);
}
function paint(R: Recipe, seed: number, w: number, h: number) {
  const key = JSON.stringify([R.colors[0], seed, w, h]);
  let p = cache.get(key);
  if (!p) { p = new Promise((done) => { queue.push({ job: artJob(w, h, R, seed), done }); pump(); }); cache.set(key, p); }
  return p;
}

// ---------------------------------------------------------------- folder
const W = 340, H = 272, HEADROOM = 54, FRONT_H = 198;
const BACK_PATH = "M0 56A22 22 0 0 1 22 34L146 34C170 34 172 0 198 0L318 0A22 22 0 0 1 340 22L340 250A22 22 0 0 1 318 272L22 272A22 22 0 0 1 0 250Z";
const FRONT_PATH = `M0 22A22 22 0 0 1 22 0L118 0C144 0 146 32 172 32L318 32A22 22 0 0 1 340 54L340 ${FRONT_H - 22}A22 22 0 0 1 318 ${FRONT_H}L22 ${FRONT_H}A22 22 0 0 1 0 ${FRONT_H - 22}Z`;
const SVGNS = "http://www.w3.org/2000/svg";
const svg = (vb: string, cls: string, d: string, stroke?: string) => {
  const s = document.createElementNS(SVGNS, "svg"); s.setAttribute("viewBox", vb); s.setAttribute("class", cls);
  const p = document.createElementNS(SVGNS, "path"); p.setAttribute("d", d); if (stroke) p.setAttribute("stroke", stroke);
  s.appendChild(p); return s;
};

export interface MenuItem { label: string; danger?: boolean; run: () => void }
export interface FolderOpts {
  label: string; meta: string; seed: number; width?: number; delay?: number; current?: boolean;
  files: { name: string; meta?: string; image?: string }[];
  onOpen: () => void; menu: MenuItem[];
}

export function glassFolder(o: FolderOpts): HTMLElement {
  const width = o.width ?? 300, k = width / W;
  const root = h("div", { class: "gf-root" + (o.current ? " current" : ""), style: { width: width + "px", height: (H + HEADROOM) * k + "px" } });
  const stage = h("div", { class: "gf-stage", style: { transform: `translateY(${HEADROOM * k}px) scale(${k})` } });
  const tilt = h("div", { class: "gf-tilt" });

  const back = h("div", { class: "gf-back", style: { clipPath: `path('${BACK_PATH}')` } });
  const art = document.createElement("canvas"); art.className = "gf-art";
  Object.assign(art.style, { width: W + 24 + "px", height: H + 24 + "px" });
  const dens = Math.min(1.25, devicePixelRatio || 1) * k;
  void paint(PRESETS[o.seed % PRESETS.length], o.seed % 997, Math.round((W + 24) * dens), Math.round((H + 24) * dens)).then((src) => {
    art.width = src.width; art.height = src.height; art.getContext("2d")!.drawImage(src, 0, 0); art.dataset.ready = "1";
  });
  back.append(art, h("div", { class: "gf-back-sheen" }));

  const files = h("div", { class: "gf-files" });
  const vis = o.files.slice(0, 3);
  vis.forEach((f, v) => {
    const slot = vis.length <= 1 ? 0 : (v / (vis.length - 1)) * 2 - 1, j = rng(hash(f.name));
    const sheet = h("div", { class: "gf-sheet" + (f.image ? " gf-sheet--art" : ""), style: { "--gf-slot": slot, "--gf-depth": vis.length - 1 - v, "--gf-jx": ((j() - 0.5) * 10).toFixed(2) + "px", "--gf-jr": ((j() - 0.5) * 3.2).toFixed(2) + "deg", zIndex: v + 1 } as any },
      f.image ? h("img", { class: "gf-sheet-art", src: f.image, draggable: false }) : h("span", { class: "gf-lines" }, ...[86, 92, 64, 88, 42].map((w) => h("i", { style: { width: w + "%" } }))),
      h("span", { class: "gf-sheet-head" }, h("span", { class: "gf-sheet-name" }, f.name), f.meta ? h("span", { class: "gf-sheet-meta" }, f.meta) : null));
    files.appendChild(sheet);
  });

  const front = h("div", { class: "gf-front", style: { clipPath: `path('${FRONT_PATH}')` } },
    h("div", { class: "gf-tint" }), h("div", { class: "gf-spec" }),
    svg(`0 0 ${W} ${FRONT_H}`, "gf-rim gf-front-rim", FRONT_PATH),
    h("button", { class: "gf-hit", title: "Open project", onclick: () => o.onOpen() }),
    h("div", { class: "gf-label" }, h("span", { class: "gf-title" }, o.label), h("span", { class: "gf-meta" }, o.meta)));

  const menu = h("div", { class: "gf-menu" }, ...o.menu.map((m) => h("button", { class: "gf-menu-item" + (m.danger ? " danger" : ""), onclick: (e: Event) => { e.stopPropagation(); menu.classList.remove("open"); m.run(); } }, m.label)));
  const more = h("button", { class: "gf-key", title: "More", onclick: (e: Event) => { e.stopPropagation(); menu.classList.toggle("open"); } },
    svg("0 0 30 12", "gf-glyph", "M5 6h.01M15 6h.01M25 6h.01"));
  document.addEventListener("pointerdown", (e) => { if (!menu.contains(e.target as Node) && !more.contains(e.target as Node)) menu.classList.remove("open"); });

  tilt.append(h("div", { class: "gf-shadow" }), back, svg(`0 0 ${W} ${H}`, "gf-rim gf-back-rim", BACK_PATH), files, front, more, menu);
  stage.appendChild(tilt);
  root.appendChild(stage);

  root.addEventListener("pointermove", (e) => {
    const r = root.getBoundingClientRect();
    root.style.setProperty("--gf-px", (((e.clientX - r.left) / r.width) * 2 - 1).toFixed(3));
    root.style.setProperty("--gf-py", (((e.clientY - r.top) / r.height) * 2 - 1).toFixed(3));
  });
  root.addEventListener("pointerleave", () => { root.style.setProperty("--gf-px", "0"); root.style.setProperty("--gf-py", "0"); });
  setTimeout(() => root.classList.add("in"), 40 + (o.delay ?? 0));
  return root;
}

// ---------------------------------------------------------------- project info
export async function projectInfo(dir: string) {
  let name = basename(dir), duration = 0, clips = 0, modified = 0;
  try {
    const p = JSON.parse(await fs.readText(join(dir, "project.shdw.json")));
    name = p.name || name;
    clips = (p.clips ?? []).length;
    duration = Math.max(0, ...(p.clips ?? []).map((c: any) => (c.start ?? 0) + (c.duration ?? 0)));
  } catch {}
  let renders: { name: string; image: string; modified: number }[] = [];
  try {
    renders = (await fs.list(join(dir, "renders")))
      .filter((e) => !e.isDir && /\.(png|jpe?g|webp)$/i.test(e.name))
      .sort((a, b) => b.modified - a.modified).slice(0, 3)
      .map((e) => ({ name: e.name.replace(/\.[^.]+$/, ""), image: mediaUrl(e.path), modified: e.modified }));
    modified = (renders[0]?.modified ?? 0) * 1000;
  } catch {}
  if (!modified) try { modified = ((await fs.list(dir)).find((e) => e.name === "project.shdw.json")?.modified ?? 0) * 1000; } catch {}
  return { name, duration, clips, renders, modified };
}

export function confirmDialog(title: string, body: string, action: string): Promise<boolean> {
  return new Promise((res) => {
    let done = false;
    modal((close) => h("div", { class: "col" }, h("h2", {}, title), h("p", { class: "muted", style: { margin: "0", lineHeight: "1.5" } }, body),
      h("div", { class: "row", style: { justifyContent: "flex-end", marginTop: "10px" } },
        h("button", { class: "btn", onclick: () => close() }, "Cancel"),
        h("button", { class: "btn danger", onclick: () => { done = true; res(true); close(); } }, action))),
      () => { if (!done) res(false); });
  });
}

export const sameDir = (a: string, b: string) => norm(a).toLowerCase() === norm(b).toLowerCase();
