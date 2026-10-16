import { store } from "../store";
import { Clip, Track, clipEnd, mediaOf, timecode, frameSnap, uid } from "../model";
import { h, I, clear, menu, MenuItem, drag } from "./dom";
import { thumbUrl, waveforms } from "../media";
import * as act from "../actions";
import { TRANSITIONS, TRANSITION_NAMES, EFFECTS } from "../engine/shaders";
import { playback } from "../engine/playback";
import { sceneDetect, removeSilence, normalizeLoudness, detectBeats, processClip, PROCS, toggleFreeze } from "../processing";

const RULER = 30;
const COLORS: Record<string, string> = { media: "#3a5bd9", audio: "#1f9d6b", image: "#2f7fb8", motion: "#8e44e8", html: "#c43a6b", text: "#d4730f", subtitle: "#b88a00", solid: "#5a5a66", gradient: "#a0458f", adjustment: "#6f6f88" };

interface Row { track: Track; y: number; h: number }

export class Timeline {
  el: HTMLElement;
  private heads: HTMLElement;
  private ruler: HTMLCanvasElement;
  private cv: HTMLCanvasElement;
  private lane: HTMLElement;
  private rows: Row[] = [];
  private scrollY = 0;
  private dirty = true;
  private images = new Map<string, HTMLImageElement>();
  private marquee: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private dropHint: { track: string; t: number; dur: number } | null = null;
  private snapLine: number | null = null;
  private hover: { clip?: Clip; edge?: "l" | "r" } = {};
  onOpenClip: (c: Clip) => void = () => {};
  onAskAgent: (text: string) => void = () => {};

  constructor(private compact = false) {
    this.heads = h("div", { class: "tl-heads" });
    this.ruler = h("canvas");
    this.cv = h("canvas");
    const rulerWrap = h("div", { class: "tl-ruler" }, this.ruler);
    this.lane = h("div", { class: "tl-canvas" }, this.cv);
    const corner = h("div", { class: "tl-corner" },
      h("button", { class: "btn icon sm ghost", title: "Add track", onclick: (e: MouseEvent) => menu(e.clientX, e.clientY, [
        { label: "Add Video Track", action: () => act.addTrack("video") },
        { label: "Add Audio Track", action: () => act.addTrack("audio") },
        { label: "Add Subtitle Track", action: () => act.addTrack("subtitle") },
      ]) }, I.plus()),
      h("span", { class: "timecode dim", id: "tl-tc" }, "00:00:00:00"));
    const grid = h("div", { class: "timeline" }, corner, rulerWrap, this.heads, this.lane);
    this.el = h("div", { class: "col", style: { flex: "1", minHeight: "0", gap: "0" } }, this.toolbar(), grid);

    new ResizeObserver(() => this.invalidate()).observe(this.lane);
    for (const ev of ["project", "time", "selection", "thumbs", "zoom"]) store.on(ev, () => this.invalidate());
    store.on("project", () => this.buildHeads());
    this.bindRuler(rulerWrap);
    this.bindLane();
    const loop = () => { if (this.dirty && this.el.isConnected) { this.dirty = false; this.draw(); } requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    this.buildHeads();
  }

  invalidate() { this.dirty = true; }

  private toolbar() {
    const tool = (id: typeof store.tool, icon: SVGElement, tip: string) => {
      const b = h("button", { class: "btn icon sm ghost" + (store.tool === id ? " on" : ""), title: tip, onclick: () => { store.tool = id; store.emit("tool"); } }, icon);
      store.on("tool", () => b.classList.toggle("on", store.tool === id));
      return b;
    };
    const snap = h("button", { class: "btn icon sm ghost" + (store.snapping ? " on" : ""), title: "Snapping (N)", onclick: () => { store.snapping = !store.snapping; snap.classList.toggle("on", store.snapping); } }, I.magnet());
    const zoom = h("input", { type: "range", min: 2, max: 600, step: 1, value: store.zoom, style: { width: "120px" } });
    zoom.addEventListener("input", () => { store.zoom = +zoom.value; store.emit("zoom"); });
    store.on("zoom", () => { zoom.value = String(store.zoom); });
    return h("div", { class: "tl-toolbar" },
      tool("select", I.cursor(), "Selection (A)"), tool("blade", I.blade(), "Blade (B)"), tool("trim", I.trim(), "Ripple trim (T)"), tool("hand", I.hand(), "Hand (H)"),
      h("div", { class: "sep" }),
      h("button", { class: "btn sm ghost", title: "Add video track", onclick: () => act.addTrack("video") }, "+V"),
      h("button", { class: "btn sm ghost", title: "Add audio track", onclick: () => act.addTrack("audio") }, "+A"),
      h("button", { class: "btn sm ghost", title: "Add subtitle track", onclick: () => act.addTrack("subtitle") }, "+S"),
      h("div", { class: "sep" }), snap,
      h("button", { class: "btn icon sm ghost", title: "Link / unlink (Ctrl+L)", onclick: () => act.toggleLink() }, I.link()),
      h("button", { class: "btn icon sm ghost", title: "Split at playhead (Ctrl+B)", onclick: () => act.splitAt() }, I.split()),
      h("button", { class: "btn icon sm ghost", title: "Add marker (M)", onclick: () => act.addMarker() }, I.marker()),
      h("button", { class: "btn icon sm ghost", title: "Cross dissolve at playhead (Ctrl+T)", onclick: () => act.transitionAtPlayhead() }, I.wand()),
      h("div", { class: "sep" }),
      h("button", { class: "btn icon sm ghost", title: "Undo", onclick: () => store.undo() }, I.undo()),
      h("button", { class: "btn icon sm ghost", title: "Redo", onclick: () => store.redo() }, I.redo()),
      h("div", { class: "grow" }),
      h("button", { class: "btn icon sm ghost", title: "Zoom out", onclick: () => { store.zoom = Math.max(2, store.zoom / 1.4); store.emit("zoom"); } }, I.zoomOut()),
      zoom,
      h("button", { class: "btn icon sm ghost", title: "Zoom in", onclick: () => { store.zoom = Math.min(600, store.zoom * 1.4); store.emit("zoom"); } }, I.zoomIn()),
      h("button", { class: "btn icon sm ghost", title: "Zoom to fit (Shift+Z)", onclick: () => this.fit() }, I.fit()));
  }

  fit() {
    const w = this.lane.clientWidth - 40;
    store.zoom = Math.max(2, Math.min(600, w / Math.max(5, store.duration)));
    store.scrollX = 0;
    store.emit("zoom");
  }

  // ---------- geometry ----------
  private layout() {
    const p = store.project;
    const subs = p.tracks.filter((t) => t.kind === "subtitle").reverse();
    const vids = p.tracks.filter((t) => t.kind === "video").reverse();
    const auds = p.tracks.filter((t) => t.kind === "audio");
    let y = 0;
    this.rows = [];
    const sc = this.compact ? 0.8 : 1;
    for (const t of [...subs, ...vids, ...auds]) {
      const hgt = Math.round((t.height ?? (t.kind === "video" ? 62 : t.kind === "audio" ? 52 : 34)) * sc);
      this.rows.push({ track: t, y, h: hgt });
      y += hgt;
    }
    return y;
  }
  private x(t: number) { return (t - store.scrollX) * store.zoom; }
  private t(x: number) { return x / store.zoom + store.scrollX; }
  private rowAt(y: number) { return this.rows.find((r) => y + this.scrollY >= r.y && y + this.scrollY < r.y + r.h); }
  private clipAt(x: number, y: number): { clip?: Clip; edge?: "l" | "r" } {
    const r = this.rowAt(y);
    if (!r) return {};
    const t = this.t(x);
    const c = store.project.clips.filter((c) => c.track === r.track.id && t >= c.start - 4 / store.zoom && t <= clipEnd(c) + 4 / store.zoom)
      .sort((a, b) => Math.abs(a.start + a.duration / 2 - t) - Math.abs(b.start + b.duration / 2 - t))[0];
    if (!c) return {};
    const xl = this.x(c.start), xr = this.x(clipEnd(c));
    const edgeW = Math.min(8, (xr - xl) / 3);
    if (x - xl <= edgeW) return { clip: c, edge: "l" };
    if (xr - x <= edgeW) return { clip: c, edge: "r" };
    if (t < c.start || t > clipEnd(c)) return {};
    return { clip: c };
  }

  // ---------- heads ----------
  private buildHeads() {
    this.layout();
    clear(this.heads);
    for (const r of this.rows) {
      const t = r.track;
      const toggle = (key: "locked" | "hidden" | "muted" | "solo") => () => { store.mutate(key, () => { (t as any)[key] = !(t as any)[key]; }); playback.refreshBuses(); };
      const head = h("div", { class: "tl-head", style: { top: r.y - this.scrollY + "px", height: r.h + "px" } },
        h("div", { class: "tag", style: { background: t.kind === "video" ? "var(--clip-video)" : t.kind === "audio" ? "var(--clip-audio)" : "var(--clip-sub)" } }),
        h("div", { class: "nm", ondblclick: async () => { const { prompt } = await import("./dom"); const n = await prompt("Track name", t.name); if (n) store.mutate("rename track", () => { t.name = n; }); } }, t.id, t.name !== t.id ? h("small", {}, t.name) : null),
        t.kind !== "audio" ? h("button", { class: t.hidden ? "on" : "", title: "Show/hide", onclick: toggle("hidden") }, t.hidden ? I.eyeOff() : I.eye()) : null,
        t.kind === "audio" ? h("button", { class: "mute" + (t.muted ? " on" : ""), title: "Mute", onclick: toggle("muted") }, "M") : null,
        h("button", { class: "solo" + (t.solo ? " on" : ""), title: "Solo", onclick: toggle("solo") }, "S"),
        h("button", { class: t.locked ? "on" : "", title: "Lock", onclick: toggle("locked") }, t.locked ? I.lock() : I.unlock()));
      head.querySelectorAll("svg").forEach((s) => { (s as any).style.width = "13px"; (s as any).style.height = "13px"; });
      head.addEventListener("contextmenu", (e) => { e.preventDefault(); menu(e.clientX, e.clientY, [
        { label: "Rename…", action: () => head.querySelector<HTMLElement>(".nm")!.dispatchEvent(new MouseEvent("dblclick")) },
        { label: "Insert track above", action: () => act.addTrack(t.kind, t.id, true) },
        { label: "Insert track below", action: () => act.addTrack(t.kind, t.id, false) },
        { label: "Move track up", action: () => act.moveTrack(t.id, t.kind === "audio" ? -1 : 1) },
        { label: "Move track down", action: () => act.moveTrack(t.id, t.kind === "audio" ? 1 : -1) },
        { label: "Delete all empty tracks", action: () => act.removeEmptyTracks() },
        { label: "Close gaps", action: () => act.closeGaps(t.id) },
        { label: "Taller", action: () => store.mutate("track height", () => { t.height = (t.height ?? r.h) + 16; }) },
        { label: "Shorter", action: () => store.mutate("track height", () => { t.height = Math.max(24, (t.height ?? r.h) - 16); }) },
        { sep: true },
        { label: "Delete track", action: () => act.removeTrack(t.id) },
      ]); });
      this.heads.appendChild(head);
    }
  }

  // ---------- drawing ----------
  private draw() {
    const W = this.lane.clientWidth, H = this.lane.clientHeight;
    const dpr = devicePixelRatio || 1;
    for (const [c, w, hh] of [[this.cv, W, H], [this.ruler, W, RULER]] as [HTMLCanvasElement, number, number][]) {
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(hh * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(hh * dpr); }
    }
    const total = this.layout();
    this.scrollY = Math.max(0, Math.min(this.scrollY, Math.max(0, total - H + 40)));
    this.heads.querySelectorAll<HTMLElement>(".tl-head").forEach((el, i) => { if (this.rows[i]) el.style.top = this.rows[i].y - this.scrollY + "px"; });
    if (store.playing) {
      const px = this.x(store.playhead);
      if (px > W * 0.85 || px < 0) { store.scrollX = Math.max(0, store.playhead - (W * 0.15) / store.zoom); }
    }
    const tc = document.getElementById("tl-tc");
    if (tc) tc.textContent = timecode(store.playhead, store.fps);
    this.drawRuler(W, dpr);
    const g = this.cv.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    // lanes
    for (const r of this.rows) {
      const y = r.y - this.scrollY;
      if (y > H || y + r.h < 0) continue;
      g.fillStyle = r.track.kind === "audio" ? "rgba(31,157,107,0.035)" : r.track.kind === "subtitle" ? "rgba(199,154,0,0.03)" : "rgba(255,255,255,0.018)";
      g.fillRect(0, y, W, r.h);
      g.fillStyle = "rgba(255,255,255,0.06)";
      g.fillRect(0, y + r.h - 1, W, 1);
      if (r.track.locked) { g.fillStyle = "rgba(0,0,0,0.25)"; g.fillRect(0, y, W, r.h); }
    }
    // in/out
    if (store.inPoint != null || store.outPoint != null) {
      const a = this.x(store.inPoint ?? 0), b = this.x(store.outPoint ?? store.duration);
      g.fillStyle = "rgba(10,132,255,0.06)"; g.fillRect(a, 0, b - a, H);
    }
    // clips
    const p = store.project;
    for (const r of this.rows) {
      const y = r.y - this.scrollY;
      if (y > H || y + r.h < 0) continue;
      for (const c of p.clips) {
        if (c.track !== r.track.id) continue;
        const x0 = this.x(c.start), x1 = this.x(clipEnd(c));
        if (x1 < 0 || x0 > W) continue;
        this.drawClip(g, c, r, x0, x1, y);
      }
    }
    // drop hint
    if (this.dropHint) {
      const r = this.rows.find((rr) => rr.track.id === this.dropHint!.track);
      if (r) {
        g.fillStyle = "rgba(10,132,255,0.25)"; g.strokeStyle = "#0a84ff"; g.lineWidth = 1.5;
        rr(g, this.x(this.dropHint.t), r.y - this.scrollY + 3, this.dropHint.dur * store.zoom, r.h - 6, 6); g.fill(); g.stroke();
      }
    }
    // markers
    for (const m of p.markers) { g.fillStyle = (m.color ?? "#5e8bff") + "55"; g.fillRect(this.x(m.t), 0, 1, H); }
    if (this.snapLine != null) { g.fillStyle = "#ffd60a"; g.fillRect(this.x(this.snapLine) - 0.5, 0, 1, H); }
    // playhead
    const px = this.x(store.playhead);
    g.fillStyle = "#ff375f"; g.fillRect(Math.round(px) - 0.5, 0, 1.5, H);
    // marquee
    if (this.marquee) {
      const m = this.marquee;
      g.fillStyle = "rgba(10,132,255,0.12)"; g.strokeStyle = "rgba(10,132,255,0.8)"; g.lineWidth = 1;
      g.fillRect(Math.min(m.x0, m.x1), Math.min(m.y0, m.y1), Math.abs(m.x1 - m.x0), Math.abs(m.y1 - m.y0));
      g.strokeRect(Math.min(m.x0, m.x1) + 0.5, Math.min(m.y0, m.y1) + 0.5, Math.abs(m.x1 - m.x0), Math.abs(m.y1 - m.y0));
    }
  }

  private drawRuler(W: number, dpr: number) {
    const g = this.ruler.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, RULER);
    const fps = store.fps;
    const steps = [1 / fps, 2 / fps, 5 / fps, 10 / fps, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const major = steps.find((s) => s * store.zoom >= 80) ?? 600;
    const minor = steps.slice().reverse().find((s) => s < major && s * store.zoom >= 9) ?? major / 2;
    const t0 = Math.floor(store.scrollX / minor) * minor;
    g.font = "10px " + getComputedStyle(document.body).getPropertyValue("--mono");
    for (let t = t0; this.x(t) < W; t += minor) {
      const x = Math.round(this.x(t)) + 0.5;
      const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
      g.fillStyle = isMajor ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.14)";
      g.fillRect(x, isMajor ? 14 : 22, 1, isMajor ? 16 : 8);
      if (isMajor) { g.fillStyle = "rgba(235,235,245,0.6)"; g.fillText(timecode(t, fps).slice(3), x + 4, 12); }
    }
    if (store.inPoint != null || store.outPoint != null) {
      const a = this.x(store.inPoint ?? 0), b = this.x(store.outPoint ?? store.duration);
      g.fillStyle = "rgba(10,132,255,0.35)"; g.fillRect(a, RULER - 5, b - a, 5);
    }
    for (const m of store.project.markers) {
      const x = this.x(m.t);
      g.fillStyle = m.color ?? "#5e8bff";
      g.beginPath(); g.moveTo(x - 5, 16); g.lineTo(x + 5, 16); g.lineTo(x + 5, 22); g.lineTo(x, 27); g.lineTo(x - 5, 22); g.closePath(); g.fill();
    }
    const px = this.x(store.playhead);
    g.fillStyle = "#ff375f";
    g.beginPath(); g.moveTo(px - 6, RULER - 12); g.lineTo(px + 6, RULER - 12); g.lineTo(px + 6, RULER - 6); g.lineTo(px, RULER); g.lineTo(px - 6, RULER - 6); g.closePath(); g.fill();
  }

  private img(url: string) {
    let im = this.images.get(url);
    if (!im) { im = new Image(); im.onload = () => this.invalidate(); im.src = url; this.images.set(url, im); if (this.images.size > 600) this.images.delete(this.images.keys().next().value!); }
    return im.complete && im.naturalWidth ? im : null;
  }

  private drawClip(g: CanvasRenderingContext2D, c: Clip, r: Row, x0: number, x1: number, y: number) {
    const p = store.project;
    const m = mediaOf(p, c);
    const kind = c.source.type === "media" ? (m?.kind === "audio" || r.track.kind === "audio" ? "audio" : m?.kind === "image" ? "image" : "media") : c.source.type;
    const base = c.color ?? COLORS[kind] ?? "#555";
    const sel = store.selection.has(c.id);
    const top = y + 2, hh = r.h - 4, w = Math.max(2, x1 - x0);
    g.save();
    g.globalAlpha = c.enabled === false ? 0.35 : 1;
    rr(g, x0, top, w, hh, 6);
    g.clip();
    const grad = g.createLinearGradient(0, top, 0, top + hh);
    grad.addColorStop(0, shade(base, 0.12)); grad.addColorStop(1, shade(base, -0.18));
    g.fillStyle = grad;
    g.fillRect(x0, top, w, hh);
    // content
    if (m && kind === "media" && r.track.kind === "video" && hh > 30) {
      const tw = (hh - 16) * (16 / 9);
      const sin = (c.source as any).in ?? 0;
      for (let x = Math.max(x0, x0 + Math.floor((0 - x0) / tw) * tw); x < Math.min(x1, this.cv.clientWidth); x += tw) {
        const st = sin + ((x - x0) / store.zoom) * (c.speed ?? 1);
        const u = thumbUrl(m, st);
        const im = u ? this.img(u) : null;
        if (im) g.drawImage(im, x, top + 15, tw, hh - 15);
      }
      g.fillStyle = "rgba(0,0,0,0.25)"; g.fillRect(x0, top + 15, w, hh - 15);
    }
    if (m && (kind === "audio" || (r.track.kind === "audio")) && waveforms.has(m.id)) {
      const wf = waveforms.get(m.id)!;
      const sin = (c.source as any).in ?? 0, sp = c.speed ?? 1;
      const mid = top + 14 + (hh - 14) / 2, amp = (hh - 18) / 2;
      const vol = Math.min(2, c.volume ?? 1);
      g.fillStyle = "rgba(180,255,220,0.55)";
      const xa = Math.max(x0, 0), xb = Math.min(x1, this.cv.clientWidth);
      for (let x = xa; x < xb; x++) {
        const st = sin + ((x - x0) / store.zoom) * sp;
        const i0 = Math.floor(st * 100), i1 = Math.max(i0 + 1, Math.floor((st + sp / store.zoom) * 100));
        let v = 0;
        for (let i = i0; i < i1 && i < wf.length; i += Math.max(1, Math.floor((i1 - i0) / 8))) v = Math.max(v, wf[i] ?? 0);
        const a = (v / 255) * amp * vol;
        g.fillRect(x, mid - a, 1, a * 2 || 1);
      }
    }
    if (kind === "subtitle" || kind === "text") {
      g.fillStyle = "rgba(255,255,255,0.92)"; g.font = "600 11px " + getComputedStyle(document.body).getPropertyValue("--font");
      g.fillText(String((c.source as any).text ?? "").replace(/\n/g, " ").slice(0, 200), x0 + 6, kind === "subtitle" ? top + hh / 2 + 4 : top + 28);
    }
    if (kind === "motion" || kind === "html") {
      g.fillStyle = "rgba(255,255,255,0.10)";
      for (let x = x0 - (x0 % 14); x < x1; x += 14) { g.fillRect(x, top + 16, 6, hh - 16); }
    }
    // header strip
    g.fillStyle = "rgba(0,0,0,0.28)"; g.fillRect(x0, top, w, 15);
    g.fillStyle = "#fff"; g.font = "600 10.5px " + getComputedStyle(document.body).getPropertyValue("--font");
    const label = (c.speed && c.speed !== 1 ? `${Math.round(c.speed * 100)}% · ` : "") + (c.name ?? kind) + (c.effects?.length ? `  ƒ${c.effects.length}` : "");
    g.fillText(label, x0 + 6, top + 11);
    if (c.link) { g.fillStyle = "rgba(255,255,255,0.6)"; g.fillText("∞", x1 - 12, top + 11); }
    // fades
    g.fillStyle = "rgba(0,0,0,0.35)";
    const fi = c.source.type === "media" && r.track.kind === "audio" ? c.audioFadeIn : c.fadeIn;
    const fo = c.source.type === "media" && r.track.kind === "audio" ? c.audioFadeOut : c.fadeOut;
    if (fi) { g.beginPath(); g.moveTo(x0, top + 15); g.lineTo(x0 + fi * store.zoom, top + 15); g.lineTo(x0, top + hh); g.fill(); }
    if (fo) { g.beginPath(); g.moveTo(x1, top + 15); g.lineTo(x1 - fo * store.zoom, top + 15); g.lineTo(x1, top + hh); g.fill(); }
    // transition
    if (c.transition) {
      const tw = c.transition.duration * store.zoom;
      const tg = g.createLinearGradient(x0, 0, x0 + tw, 0);
      tg.addColorStop(0, "rgba(255,255,255,0.45)"); tg.addColorStop(1, "rgba(255,255,255,0.05)");
      g.fillStyle = tg; g.fillRect(x0, top, tw, hh);
      g.fillStyle = "#fff"; g.font = "600 9.5px system-ui";
      g.fillText("⧓ " + (TRANSITIONS[c.transition.type]?.name ?? c.transition.type.split("/").pop()), x0 + 4, top + hh - 5);
    }
    // keyframes
    if (sel && c.keyframes) {
      const times = new Set<number>();
      Object.values(c.keyframes).forEach((ks) => ks.forEach((k) => times.add(k.t)));
      g.fillStyle = "#ff9f0a";
      for (const t of times) { const x = x0 + t * store.zoom; g.save(); g.translate(x, top + hh - 6); g.rotate(Math.PI / 4); g.fillRect(-3, -3, 6, 6); g.restore(); }
    }
    g.restore();
    // border
    g.lineWidth = sel ? 2 : 1;
    g.strokeStyle = sel ? "#ffffff" : "rgba(255,255,255,0.18)";
    rr(g, x0 + 0.5, top + 0.5, w - 1, hh - 1, 6); g.stroke();
    if (this.hover.clip === c && this.hover.edge) {
      g.fillStyle = "#ffd60a";
      g.fillRect(this.hover.edge === "l" ? x0 : x1 - 3, top, 3, hh);
    }
  }

  // ---------- interaction ----------
  private bindRuler(wrap: HTMLElement) {
    wrap.addEventListener("pointerdown", (e) => {
      const rect = wrap.getBoundingClientRect();
      const seek = (cx: number) => { store.seek(Math.max(0, this.t(cx - rect.left))); if (!store.playing) store.emit("scrub"); };
      if (store.playing) playback.pause();
      seek(e.clientX);
      drag(e, (_dx, _dy, ev) => seek(ev.clientX));
    });
    wrap.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const t = this.t(e.clientX - wrap.getBoundingClientRect().left);
      const near = store.project.markers.find((m) => Math.abs(m.t - t) * store.zoom < 6);
      menu(e.clientX, e.clientY, [
        { label: "Add marker here", action: () => act.addMarker(frameSnap(t, store.fps)) },
        { label: "Set In point", key: "I", action: () => { store.inPoint = frameSnap(t, store.fps); store.emit("time"); } },
        { label: "Set Out point", key: "O", action: () => { store.outPoint = frameSnap(t, store.fps); store.emit("time"); } },
        { label: "Clear In/Out", key: "Alt+X", action: () => { store.inPoint = store.outPoint = null; store.emit("time"); } },
        ...(near ? [{ sep: true }, { label: `Delete marker "${near.name}"`, action: () => store.mutate("del marker", (p) => { p.markers = p.markers.filter((m) => m !== near); }) }] as MenuItem[] : []),
      ]);
    });
  }

  private snap(t: number, exclude: Set<string>): number {
    this.snapLine = null;
    if (!store.snapping) return t;
    const thr = 8 / store.zoom;
    let best = t, bd = thr;
    const cands = [0, store.playhead, ...store.project.markers.map((m) => m.t)];
    for (const c of store.project.clips) if (!exclude.has(c.id)) cands.push(c.start, clipEnd(c));
    for (const v of cands) { const d = Math.abs(v - t); if (d < bd) { bd = d; best = v; } }
    if (best !== t) this.snapLine = best;
    return best;
  }

  private bindLane() {
    const lane = this.lane;
    lane.addEventListener("wheel", (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const rect = lane.getBoundingClientRect();
        const tAt = this.t(e.clientX - rect.left);
        store.zoom = Math.max(2, Math.min(600, store.zoom * Math.pow(1.0018, -e.deltaY)));
        store.scrollX = Math.max(0, tAt - (e.clientX - rect.left) / store.zoom);
        store.emit("zoom");
      } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        store.scrollX = Math.max(0, store.scrollX + (e.deltaX || e.deltaY) / store.zoom);
        this.invalidate();
      } else { this.scrollY += e.deltaY; this.invalidate(); }
    }, { passive: false });

    lane.addEventListener("pointermove", (e) => {
      if (e.buttons) return;
      const rect = lane.getBoundingClientRect();
      const hit = this.clipAt(e.clientX - rect.left, e.clientY - rect.top);
      const changed = hit.clip !== this.hover.clip || hit.edge !== this.hover.edge;
      this.hover = hit;
      lane.style.cursor = store.tool === "blade" && hit.clip ? "crosshair" : store.tool === "hand" ? "grab" : hit.edge ? "ew-resize" : hit.clip ? "default" : "default";
      if (changed) this.invalidate();
    });
    lane.addEventListener("pointerleave", () => { this.hover = {}; this.invalidate(); });

    lane.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 && e.button !== 1) return;
      const rect = lane.getBoundingClientRect();
      const lx = e.clientX - rect.left, ly = e.clientY - rect.top;
      const hit = this.clipAt(lx, ly);
      const track = hit.clip ? store.project.tracks.find((t) => t.id === hit.clip!.track) : undefined;
      if (store.tool === "hand" || e.button === 1) {
        const sx = store.scrollX, sy = this.scrollY;
        drag(e, (dx, dy) => { store.scrollX = Math.max(0, sx - dx / store.zoom); this.scrollY = sy - dy; this.invalidate(); });
        return;
      }
      if (!hit.clip) {
        if (!e.shiftKey && !e.ctrlKey) { store.selection.clear(); store.emit("selection"); }
        this.marquee = { x0: lx, y0: ly, x1: lx, y1: ly };
        drag(e, (_dx, _dy, ev) => {
          this.marquee!.x1 = ev.clientX - rect.left; this.marquee!.y1 = ev.clientY - rect.top;
          const m = this.marquee!;
          const ta = this.t(Math.min(m.x0, m.x1)), tb = this.t(Math.max(m.x0, m.x1));
          const ya = Math.min(m.y0, m.y1) + this.scrollY, yb = Math.max(m.y0, m.y1) + this.scrollY;
          const ids = store.project.clips.filter((c) => {
            const r = this.rows.find((rr) => rr.track.id === c.track);
            return r && r.y < yb && r.y + r.h > ya && c.start < tb && clipEnd(c) > ta;
          }).map((c) => c.id);
          store.selection = new Set(ids); store.emit("selection");
        }, (_ev, moved) => {
          this.marquee = null;
          if (!moved) { store.seek(this.t(lx)); if (store.playing) playback.pause(); }
          this.invalidate();
        });
        return;
      }
      if (track?.locked) return;
      const c = hit.clip;
      if (store.tool === "blade") { act.splitAt(frameSnap(this.t(lx), store.fps), false); return; }
      if (e.shiftKey || e.ctrlKey) { if (store.selection.has(c.id)) { store.selection.delete(c.id); store.emit("selection"); } else store.select([c.id], true); }
      else if (!store.selection.has(c.id)) store.select([c.id]);
      if (hit.edge) this.trimDrag(e, c, hit.edge);
      else this.moveDrag(e, c, rect);
    });

    lane.addEventListener("dblclick", (e) => {
      const rect = lane.getBoundingClientRect();
      const hit = this.clipAt(e.clientX - rect.left, e.clientY - rect.top);
      if (hit.clip) this.onOpenClip(hit.clip);
    });

    lane.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const rect = lane.getBoundingClientRect();
      const hit = this.clipAt(e.clientX - rect.left, e.clientY - rect.top);
      if (!hit.clip) {
        menu(e.clientX, e.clientY, [
          { label: "Paste", key: "Ctrl+V", action: () => act.paste(frameSnap(this.t(e.clientX - rect.left), store.fps)) },
          { label: "Add Text", action: () => act.addText() },
          { label: "Add Solid Color", action: () => act.addSolid() },
          { label: "Add Gradient", action: () => act.addGradient() },
          { label: "Add Adjustment Layer", action: () => act.addAdjustment() },
          { sep: true },
          { label: "Close all gaps", action: () => act.closeGaps() },
        ]);
        return;
      }
      const c = hit.clip;
      if (!store.selection.has(c.id)) store.select([c.id]);
      const m = mediaOf(store.project, c);
      const items: MenuItem[] = [
        { label: "Split at playhead", key: "Ctrl+B", action: () => act.splitAt() },
        { label: "Cut", key: "Ctrl+X", action: () => act.cutSelection() },
        { label: "Copy", key: "Ctrl+C", action: () => act.copySelection() },
        { label: "Duplicate", key: "Ctrl+D", action: () => act.duplicateSelection() },
        { label: "Delete", key: "Del", action: () => act.deleteSelection() },
        { label: "Ripple delete", key: "Shift+Del", action: () => act.deleteSelection(true) },
        { sep: true },
        { label: c.enabled === false ? "Enable clip" : "Disable clip", key: "D", action: () => act.toggleEnabled() },
        { label: c.link ? "Unlink" : "Link", key: "Ctrl+L", action: () => act.toggleLink() },
        { header: "Speed" },
        ...[0.25, 0.5, 1, 1.5, 2, 4].map((s) => ({ label: `${s * 100}%`, action: () => setSpeed(c, s) })),
        { header: "Transition in" },
        ...TRANSITION_NAMES.slice(0, 10).map((n) => ({ label: TRANSITIONS[n].name, action: () => act.setTransition(c.id, n) })),
        { label: "More transitions… (Effects library)", action: () => store.emit("show-library", "transitions") },
        ...(c.transition ? [{ label: "Remove transition", action: () => act.setTransition(c.id, "") }] : []),
        { sep: true },
        ...(m && (m.kind === "video" || m.kind === "audio") ? [
          { label: "Auto captions (Whisper)", action: () => act.captionsFor(m.id).then((n) => store.emit("toast", `${n} captions added`)).catch((err) => store.error("captions", String(err))) },
        ] : []),
        ...(m && m.kind !== "image" ? [
          { header: "Processing" },
          ...(m.kind === "video" ? [{ label: "Scene cut detection → split", action: () => run(() => sceneDetect(c)) }] : []),
          ...(m.kind === "audio" || m.hasAudio ? [
            { label: "Remove silences (ripple)", action: () => run(() => removeSilence(c)) },
            { label: "Normalize loudness (-14 LUFS)", action: () => run(() => normalizeLoudness(c)) },
            { label: "Detect beats → markers", action: () => run(async () => detectBeats(c)) },
          ] : []),
          ...(Object.keys(PROCS) as (keyof typeof PROCS)[]).filter((k) => m.kind === "video" || ["audioDenoise", "voiceEnhance", "reverse"].includes(k))
            .map((k) => ({ label: PROCS[k], action: () => run(() => processClip(c, k)) })),
          ...(m.kind === "video" ? [{ label: c.freeze ? "Unfreeze frame" : "Freeze frame", action: () => toggleFreeze(c) }] : []),
        ] as MenuItem[] : []),
        { sep: true },
        { label: "✦ Ask agent about this clip…", action: () => this.onAskAgent(`About clip ${c.id} ("${c.name ?? c.source.type}"): `) },
      ];
      menu(e.clientX, e.clientY, items);
    });

    // drag & drop from libraries / media pool / explorer
    lane.addEventListener("dragover", (e) => {
      const types = e.dataTransfer?.types ?? [];
      if (!types.includes("shdw/media") && !types.includes("shdw/gen") && !types.includes("shdw/effect") && !types.includes("shdw/transition")) return;
      e.preventDefault();
      const rect = lane.getBoundingClientRect();
      const r = this.rowAt(e.clientY - rect.top);
      const dur = parseFloat((window as any).__dragDur ?? "5");
      if (r && (types.includes("shdw/media") || types.includes("shdw/gen"))) {
        this.dropHint = { track: r.track.id, t: this.snap(Math.max(0, this.t(e.clientX - rect.left)), new Set()), dur };
        this.invalidate();
      }
    });
    lane.addEventListener("dragleave", () => { this.dropHint = null; this.snapLine = null; this.invalidate(); });
    lane.addEventListener("drop", (e) => {
      e.preventDefault();
      const rect = lane.getBoundingClientRect();
      const lx = e.clientX - rect.left, ly = e.clientY - rect.top;
      const r = this.rowAt(ly);
      const t = this.dropHint?.t ?? Math.max(0, this.t(lx));
      this.dropHint = null; this.snapLine = null;
      const dt = e.dataTransfer!;
      if (dt.getData("shdw/media")) {
        const m = store.project.media.find((mm) => mm.id === dt.getData("shdw/media"));
        if (m) act.placeMedia(m, frameSnap(t, store.fps), r?.track.id);
      } else if (dt.getData("shdw/gen")) {
        const spec = JSON.parse(dt.getData("shdw/gen"));
        const c = act.addGenerated(spec.source, spec.name, spec.duration ?? 5, frameSnap(t, store.fps));
        if (r && r.track.kind === "video") store.mutate("move", () => { const cc = store.clip(c.id); if (cc) cc.track = r.track.id; });
      } else if (dt.getData("shdw/effect")) {
        const hit = this.clipAt(lx, ly);
        const type = dt.getData("shdw/effect");
        if (hit.clip) store.mutate("add effect", () => { hit.clip!.effects = [...(hit.clip!.effects ?? []), { type, params: {} }]; });
        store.select(hit.clip ? [hit.clip.id] : []);
      } else if (dt.getData("shdw/transition")) {
        const hit = this.clipAt(lx, ly);
        if (hit.clip) act.setTransition(hit.clip.id, dt.getData("shdw/transition"));
      }
      this.invalidate();
    });
  }

  private moveDrag(e: PointerEvent, c: Clip, rect: DOMRect) {
    const sel = store.selectedClips();
    const ids = new Set(sel.map((x) => x.id));
    const starts = new Map(sel.map((x) => [x.id, { start: x.start, track: x.track }]));
    const grabT = this.t(e.clientX - rect.left) - c.start;
    let began = false;
    const p = store.project;
    drag(e, (dx, dy, ev) => {
      if (!began) { if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return; store.begin(); began = true; }
      let ns = this.t(ev.clientX - rect.left) - grabT;
      // snap either edge of the grabbed clip
      const s1 = this.snap(ns, ids);
      if (s1 !== ns) ns = s1; else { const s2 = this.snap(ns + c.duration, ids); if (s2 !== ns + c.duration) ns = s2 - c.duration; }
      const delta = Math.max(-Math.min(...[...starts.values()].map((v) => v.start)), ns - starts.get(c.id)!.start);
      // vertical: move along rows of same kind
      const row = this.rowAt(ev.clientY - rect.top);
      const origRow = this.rows.findIndex((rr) => rr.track.id === starts.get(c.id)!.track);
      const newRow = row ? this.rows.indexOf(row) : origRow;
      const rowDelta = newRow - origRow;
      for (const x of sel) {
        const o = starts.get(x.id)!;
        x.start = Math.max(0, o.start + delta);
        if (!x.link || sel.filter((y) => y.link === x.link).length === 1 || x === c || store.project.tracks.find((t) => t.id === x.track)?.kind === store.project.tracks.find((t) => t.id === c.track)?.kind) {
          const idx = this.rows.findIndex((rr) => rr.track.id === o.track) + rowDelta;
          const target = this.rows[idx];
          const kind = p.tracks.find((t) => t.id === o.track)?.kind;
          if (target && target.track.kind === kind && !target.track.locked) x.track = target.track.id;
        }
      }
      store.emit("project", "drag");
    }, () => {
      this.snapLine = null;
      if (began) {
        for (const x of sel) x.start = frameSnap(x.start, store.fps);
        resolveOverlaps(sel);
        store.changed("move");
      }
      this.invalidate();
    });
  }

  private trimDrag(e: PointerEvent, c: Clip, edge: "l" | "r") {
    const p = store.project;
    const partners = c.link ? p.clips.filter((x) => x.link === c.link) : [c];
    const orig = new Map(partners.map((x) => [x.id, { start: x.start, duration: x.duration, in: (x.source as any).in ?? 0 }]));
    const ripple = store.tool === "trim";
    const followers = ripple ? p.clips.filter((x) => !partners.includes(x) && partners.some((pp) => pp.track === x.track) && x.start >= clipEnd(c) - 1e-6) : [];
    const fStarts = new Map(followers.map((x) => [x.id, x.start]));
    store.begin();
    drag(e, (dx) => {
      const exclude = new Set(partners.map((x) => x.id));
      let dt = dx / store.zoom;
      for (const x of partners) {
        const o = orig.get(x.id)!;
        const m = mediaOf(p, x);
        const sp = x.speed ?? 1;
        const minDur = 1 / store.fps;
        if (edge === "l") {
          let ns = this.snap(o.start + dt, exclude);
          dt = ns - o.start;
          let d = dt;
          if (x.source.type === "media" && m && m.kind !== "image") d = Math.max(d, -o.in / sp);
          d = Math.min(d, o.duration - minDur);
          d = Math.max(d, -o.start);
          x.start = o.start + d; x.duration = o.duration - d;
          if (x.source.type === "media") (x.source as any).in = o.in + d * sp;
        } else {
          let ne = this.snap(o.start + o.duration + dt, exclude);
          let d = ne - (o.start + o.duration);
          if (x.source.type === "media" && m && m.kind !== "image") d = Math.min(d, (m.duration - o.in) / sp - o.duration);
          d = Math.max(d, minDur - o.duration);
          x.duration = o.duration + d;
          if (ripple) for (const f of followers) f.start = Math.max(0, fStarts.get(f.id)! + d);
        }
      }
      store.emit("project", "trim");
    }, () => {
      this.snapLine = null;
      for (const x of partners) { x.start = frameSnap(x.start, store.fps); x.duration = Math.max(1 / store.fps, frameSnap(x.duration, store.fps)); }
      store.changed("trim");
    });
  }
}

/** After a move: any unmoved clip overlapped by a moved one gets trimmed/split (overwrite edit). */
function resolveOverlaps(moved: Clip[]) {
  const p = store.project;
  const ids = new Set(moved.map((m) => m.id));
  const add: Clip[] = [];
  for (const m of moved) {
    for (const o of p.clips) {
      if (ids.has(o.id) || o.track !== m.track) continue;
      const a = m.start, b = clipEnd(m);
      if (clipEnd(o) <= a + 1e-6 || o.start >= b - 1e-6) continue;
      if (o.start >= a && clipEnd(o) <= b) { (o as any).__del = true; continue; }
      if (o.start < a && clipEnd(o) > b) { const right = act.splitClip(o, a); const r2 = act.splitClip(right, b); add.push(r2); continue; }
      if (o.start < a) { o.duration = a - o.start; continue; }
      const cut = b - o.start;
      o.start = b; o.duration -= cut;
      if (o.source.type === "media") (o.source as any).in = ((o.source as any).in ?? 0) + cut * (o.speed ?? 1);
    }
  }
  p.clips = p.clips.filter((c) => !(c as any).__del).concat(add);
}

function setSpeed(c: Clip, s: number) {
  store.mutate("speed", (p) => {
    const group = c.link ? p.clips.filter((x) => x.link === c.link) : [c];
    for (const x of group) { const old = x.speed ?? 1; x.duration = (x.duration * old) / s; x.speed = s; }
  });
}

function rr(g: CanvasRenderingContext2D, x: number, y: number, w: number, hh: number, r: number) {
  g.beginPath();
  if ((g as any).roundRect) (g as any).roundRect(x, y, Math.max(0, w), Math.max(0, hh), Math.min(r, w / 2, hh / 2));
  else g.rect(x, y, w, hh);
}
function shade(hex: string, k: number) {
  const n = parseInt(hex.replace("#", "").slice(0, 6), 16);
  const f = (v: number) => Math.round(Math.max(0, Math.min(255, k > 0 ? v + (255 - v) * k : v * (1 + k))));
  return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
}
export { uid, EFFECTS };

function run(fn: () => Promise<unknown>) {
  fn().catch((e) => store.error("processing", String(e?.message ?? e)));
}
