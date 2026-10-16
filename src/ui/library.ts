// Left-hand panel of the Edit page: Media Pool · Effects Library · Transcript.

import { store } from "../store";
import { h, I, clear, menu } from "./dom";
import { Media, clipEnd, uid } from "../model";
import { thumbUrl, importFiles, makeProxy, proxying, needsProxy, transcribe, Segment } from "../media";
import { EFFECTS, TRANSITIONS } from "../engine/shaders";
import { TEMPLATES, TEMPLATE_CATEGORIES } from "../templates";
import { listModules, getModule } from "../engine/modules";
import { fs, join, mediaUrl } from "../ipc";
import * as act from "../actions";
import { open } from "@tauri-apps/plugin-dialog";
import { fmtTime } from "./dom";

export async function pickAndImport() {
  const sel = await open({ multiple: true, title: "Import media", filters: [{ name: "Media", extensions: ["mp4", "mov", "m4v", "webm", "mkv", "avi", "mxf", "mp3", "wav", "m4a", "aac", "flac", "ogg", "png", "jpg", "jpeg", "gif", "webp", "svg"] }] });
  if (!sel) return;
  const paths = Array.isArray(sel) ? sel : [sel];
  await importFiles(paths.map(String), localStorage.getItem("shdw.copyMedia") === "1");
}

/** Copy a built-in template into motion/ and return its relative path. */
export async function materializeTemplate(id: string) {
  const t = TEMPLATES.find((x) => x.id === id)!;
  const rel = `motion/${t.id}.${t.kind === "html" ? "html" : "js"}`;
  const abs = store.abs(rel);
  if (!(await fs.exists(abs))) await fs.writeText(abs, t.code);
  return rel;
}

export function mediaCard(m: Media, onSelect?: (m: Media) => void) {
  const thumb = m.kind === "video" ? thumbUrl(m, m.duration * 0.2) : m.kind === "image" ? mediaUrl(store.abs(m.path)) : null;
  const card = h("div", { class: "mcard", draggable: true, title: m.path },
    h("div", { class: "th", style: thumb ? { backgroundImage: `url("${thumb}")` } : {} },
      !thumb ? (m.kind === "audio" ? I.music() : I.film()) : null,
      h("span", { class: "badge" }, m.kind + (m.proxy ? " · opt" : proxying.has(m.id) ? " · …" : "")),
      m.kind !== "image" ? h("span", { class: "dur" }, fmtTime(m.duration)) : null),
    h("div", { class: "nm" }, m.name, h("small", {}, m.kind === "image" ? `${m.width ?? "?"}×${m.height ?? "?"}` : m.kind === "video" ? `${m.width}×${m.height} · ${m.fps}fps · ${m.codec ?? ""}` : m.codec ?? "audio")));
  const svgEl = card.querySelector(".th svg") as SVGElement | null;
  if (svgEl) { svgEl.style.width = "28px"; svgEl.style.height = "28px"; }
  card.addEventListener("dragstart", (e) => { e.dataTransfer!.setData("shdw/media", m.id); (window as any).__dragDur = String(m.duration); });
  card.addEventListener("click", () => onSelect?.(m));
  card.addEventListener("dblclick", () => act.placeMedia(m, store.duration));
  // hover scrub
  if (m.kind === "video") card.querySelector(".th")!.addEventListener("pointermove", (e: any) => {
    const r = e.currentTarget.getBoundingClientRect();
    const u = thumbUrl(m, ((e.clientX - r.left) / r.width) * m.duration);
    if (u) e.currentTarget.style.backgroundImage = `url("${u}")`;
  });
  card.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    menu(e.clientX, e.clientY, [
      { label: "Append to timeline", action: () => act.placeMedia(m, store.duration) },
      { label: "Insert at playhead", action: () => act.placeMedia(m, store.playhead) },
      { sep: true },
      ...(m.kind === "video" ? [{ label: m.proxy ? "Regenerate optimized media" : "Generate optimized media", action: () => { if (m.proxy) store.mutate("unproxy", () => { delete m.proxy; }); void makeProxy(m); } }] : []),
      ...(m.kind !== "image" ? [{ label: "Transcribe (Whisper)", action: () => transcribe(m, true).catch((err) => store.error("transcribe", String(err))) },
        { label: "Auto captions on timeline", action: () => act.captionsFor(m.id).then((n) => store.emit("toast", `${n} captions`)).catch((err) => store.error("captions", String(err))) }] : []),
      { label: "Reveal in Explorer", action: () => fs.reveal(store.abs(m.path)) },
      { sep: true },
      { label: "Remove from pool", action: () => store.mutate("remove media", (p) => { p.media = p.media.filter((x) => x.id !== m.id); p.clips = p.clips.filter((c) => !(c.source.type === "media" && (c.source as any).media === m.id)); }) },
    ]);
  });
  return card;
}

export class Library {
  el: HTMLElement;
  private body: HTMLElement;
  private tab = "media";
  private tabs: HTMLElement;
  private query = "";
  txMedia: string | null = null;

  constructor() {
    this.tabs = h("div", { class: "tabs" });
    this.body = h("div", { class: "body" });
    this.el = h("div", { class: "panel p-left" }, h("header", {}, this.tabs), this.body);
    this.renderTabs();
    store.on("project", (why) => { if (this.tab === "media" && why !== "drag" && why !== "trim" && why !== "inspector") this.render(); });
    store.on("thumbs", () => this.tab === "media" && this.render());
    store.on("modules", () => this.tab === "effects" && this.render());
    store.on("show-library", (which) => { this.tab = which === "transcript" ? "transcript" : "effects"; this.renderTabs(); });
    store.on("time", () => this.tab === "transcript" && this.highlightTx());
    this.render();
  }

  private renderTabs() {
    clear(this.tabs);
    for (const [id, label] of [["media", "Media"], ["effects", "Effects"], ["transcript", "Transcript"]]) {
      this.tabs.appendChild(h("button", { class: this.tab === id ? "on" : "", onclick: () => { this.tab = id; this.renderTabs(); } }, label));
    }
    this.render();
  }

  render() {
    clear(this.body);
    if (this.tab === "media") this.renderMedia();
    else if (this.tab === "effects") void this.renderEffects();
    else void this.renderTranscript();
  }

  private renderMedia() {
    const p = store.project;
    const bar = h("div", { class: "row", style: { padding: "8px 10px 0" } },
      h("button", { class: "btn sm primary", onclick: () => pickAndImport() }, I.import(), "Import"),
      h("div", { class: "grow" }),
      h("span", { class: "faint" }, `${p.media.length} items`));
    this.body.appendChild(bar);
    if (!p.media.length) {
      this.body.appendChild(h("div", { class: "empty", style: { height: "auto", paddingTop: "40px" } }, h("div", {}, h("b", {}, "No media yet"), "Drop files here from Explorer,", h("br"), "or ask the agent to generate clips.")));
      return;
    }
    const grid = h("div", { class: "pool", style: { gridTemplateColumns: "repeat(auto-fill,minmax(120px,1fr))" } });
    for (const m of p.media) {
      const c = mediaCard(m);
      if (needsProxy(m) && !proxying.has(m.id)) c.querySelector(".badge")!.textContent = m.kind + " · needs opt";
      grid.appendChild(c);
    }
    this.body.appendChild(grid);
  }

  private async renderEffects() {
    const q = h("input", { type: "search", placeholder: "Search effects, transitions, titles…", value: this.query });
    q.addEventListener("input", () => { this.query = q.value.toLowerCase(); void this.renderEffectsList(list); });
    const list = h("div");
    this.body.append(h("div", { class: "search" }, q), list);
    await this.renderEffectsList(list);
  }

  private async renderEffectsList(list: HTMLElement) {
    clear(list);
    const ok = (s: string) => !this.query || s.toLowerCase().includes(this.query);
    const item = (name: string, sub: string, swatch: string, data: [string, string], onClick?: () => void) => {
      if (!ok(name + " " + sub)) return null;
      const el = h("div", { class: "lib-item", draggable: true, title: "Drag onto the timeline / a clip, or double-click" },
        h("div", { class: "sw", style: { background: swatch } }), h("div", { class: "t" }, h("div", {}, name), h("small", {}, sub)));
      el.addEventListener("dragstart", (e) => { e.dataTransfer!.setData(data[0], data[1]); (window as any).__dragDur = "5"; });
      if (onClick) el.addEventListener("dblclick", onClick);
      return el;
    };
    const sec = (t: string, items: (HTMLElement | null)[]) => { const xs = items.filter(Boolean) as HTMLElement[]; if (xs.length) list.append(h("div", { class: "lib-sec" }, t), ...xs); };

    sec("Generators", [
      item("Text", "Animated title", "linear-gradient(135deg,#d4730f,#7a3e00)", ["shdw/gen", JSON.stringify({ name: "Text", duration: 4, source: { type: "text", text: "Title", font: "Inter", size: 140, weight: 700, color: "#ffffff", tracking: -0.025, animation: "fadeUp" } })], () => act.addText()),
      item("Solid Color", "Color matte", "#3a3a40", ["shdw/gen", JSON.stringify({ name: "Solid", source: { type: "solid", color: "#1c1c1e" } })], () => act.addSolid()),
      item("Gradient", "Linear / radial", "linear-gradient(135deg,#0b0b2a,#5e3bff,#ff7aa8)", ["shdw/gen", JSON.stringify({ name: "Gradient", source: { type: "gradient", colors: ["#0b0b2a", "#5e3bff", "#ff7aa8"], angle: 135 } })], () => act.addGradient()),
      item("Adjustment Layer", "Effects & grade for layers below", "repeating-linear-gradient(45deg,#555 0 4px,#333 4px 8px)", ["shdw/gen", JSON.stringify({ name: "Adjustment", source: { type: "adjustment" } })], () => act.addAdjustment()),
    ]);
    for (const cat of TEMPLATE_CATEGORIES) {
      sec(`Motion · ${cat}`, TEMPLATES.filter((t) => t.category === cat).map((t) => {
        const ext2 = t.kind === "html" ? "html" : "js";
        const el = item(t.name, `${t.duration}s ${t.kind === "html" ? "HTML/GSAP" : "canvas"} template`, t.preview, ["shdw/gen", JSON.stringify({ name: t.name, duration: t.duration, source: { type: t.kind === "html" ? "html" : "motion", module: `motion/${t.id}.${ext2}`, params: {} } })],
          async () => { const rel = await materializeTemplate(t.id); act.addMotion(rel, t.name, t.duration); });
        el?.addEventListener("dragstart", () => void materializeTemplate(t.id));
        return el;
      }));
    }
    const own = await listModules("motion");
    const htmls = await listHtml();
    sec("Project HTML compositions (motion/*.html)", htmls.filter((p) => !TEMPLATES.some((t) => `motion/${t.id}.html` === p)).map((p) =>
      item(p.split("/").pop()!, "HTML · GSAP / CSS / SVG", "linear-gradient(135deg,#ff9f0a,#ff375f)", ["shdw/gen", JSON.stringify({ name: p.split("/").pop(), duration: 5, source: { type: "html", module: p, params: {} } })],
        () => act.addMotion(p, p.split("/").pop()!, 5))));
    sec("Project motion (motion/)", own.filter((p) => !TEMPLATES.some((t) => `motion/${t.id}.js` === p)).map((p) => {
      const mod = getModule(p);
      return item(mod?.name ?? p.split("/").pop()!, p, "linear-gradient(135deg,#8e44e8,#3b1066)", ["shdw/gen", JSON.stringify({ name: mod?.name ?? p, duration: mod?.duration ?? 4, source: { type: "motion", module: p, params: {} } })],
        () => act.addMotion(p, mod?.name ?? p, mod?.duration ?? 4));
    }));
    sec("Video Transitions", Object.entries(TRANSITIONS).map(([k, v]) => item(v.name, "drag onto a clip's head", "linear-gradient(90deg,#3a5bd9,#111)", ["shdw/transition", k])));
    const ctr = await listModules("transitions");
    sec("Custom Transitions (transitions/)", ctr.map((p) => item(getModule(p)?.name ?? p.split("/").pop()!, p, "linear-gradient(90deg,#8e44e8,#111)", ["shdw/transition", p])));
    sec("Effects", Object.entries(EFFECTS).map(([k, v]) => item(v.name, "drag onto a clip", "linear-gradient(135deg,#2c2c34,#55556a)", ["shdw/effect", k])));
    const cfx = await listModules("effects");
    sec("Custom Effects (effects/)", cfx.map((p) => item(getModule(p)?.name ?? p.split("/").pop()!, p, "linear-gradient(135deg,#8e44e8,#2c2c34)", ["shdw/effect", p])));
  }

  // ---------- transcript ----------
  private segs: Segment[] = [];
  private segEls: HTMLElement[] = [];
  private async renderTranscript() {
    const p = store.project;
    const sel = store.selectedClips().find((c) => c.source.type === "media");
    const candidates = p.media.filter((m) => m.kind !== "image");
    if (!this.txMedia || !candidates.some((m) => m.id === this.txMedia)) this.txMedia = sel ? (sel.source as any).media : candidates[0]?.id ?? null;
    const pick = h("select", { style: { flex: "1" } }) as HTMLSelectElement;
    for (const m of candidates) pick.appendChild(h("option", { value: m.id, selected: m.id === this.txMedia }, m.name));
    pick.addEventListener("change", () => { this.txMedia = pick.value; this.render(); });
    const m = candidates.find((x) => x.id === this.txMedia);
    const status = h("span", { class: "faint" });
    const go = h("button", { class: "btn sm primary", onclick: async () => {
      if (!m) return;
      go.disabled = true; status.textContent = "Transcribing… (first run downloads the model)";
      try { await transcribe(m, true); } catch (e: any) { store.error("transcribe", String(e)); }
      this.render();
    } }, I.caption(), "Transcribe");
    this.body.append(h("div", { class: "row", style: { padding: "8px 10px" } }, pick, go), h("div", { style: { padding: "0 12px" } }, status));
    if (!m) { this.body.appendChild(h("div", { class: "empty" }, "Import video or audio to transcribe.")); return; }
    const file = join(store.dir, "transcripts", m.id + ".json");
    if (!(await fs.exists(file))) { this.body.appendChild(h("div", { class: "empty", style: { height: "auto", padding: "30px" } }, h("div", {}, h("b", {}, "No transcript yet"), "Runs Whisper locally via FFmpeg."))); return; }
    this.segs = JSON.parse(await fs.readText(file)).segments ?? [];
    const selected = new Set<number>();
    const tools = h("div", { class: "row", style: { padding: "0 10px 6px", flexWrap: "wrap" } },
      h("button", { class: "btn sm", onclick: () => act.captionsFor(m.id).then((n) => store.emit("toast", `${n} captions added`)) }, "Captions → timeline"),
      h("button", { class: "btn sm danger", title: "Ripple-delete the selected (struck-through) segments from every clip of this media", onclick: () => this.cutSegments(m.id, [...selected].map((i) => this.segs[i])) }, "Cut selected"),
      h("button", { class: "btn sm", onclick: () => store.emit("agent-prompt", `Using transcripts/${m.id}.json, cut ${m.name} down to the best moments: remove filler words, long pauses and repeated takes. Keep it tight.`) }, I.spark(), "AI cut"));
    const tx = h("div", { class: "tx" });
    this.segEls = this.segs.map((s, i) => {
      const el = h("div", { class: "seg" }, h("time", {}, fmtTime(s.start)), h("span", {}, s.text));
      el.addEventListener("click", (e) => {
        if (e.altKey || e.ctrlKey) { selected.has(i) ? selected.delete(i) : selected.add(i); el.classList.toggle("sel"); return; }
        const use = store.project.clips.find((c) => c.source.type === "media" && (c.source as any).media === m.id && (c.source as any).in <= s.start + 0.01 && (c.source as any).in + c.duration * (c.speed ?? 1) > s.start);
        if (use) store.seek(use.start + (s.start - (use.source as any).in) / (use.speed ?? 1));
      });
      tx.appendChild(el);
      return el;
    });
    this.body.append(tools, h("div", { class: "faint", style: { padding: "0 12px", fontSize: "11px" } }, "Click to jump · Ctrl+click to mark for cutting"), tx);
  }

  private highlightTx() {
    const p = store.project;
    const c = p.clips.find((x) => x.source.type === "media" && (x.source as any).media === this.txMedia && store.playhead >= x.start && store.playhead < clipEnd(x));
    const st = c ? (c.source as any).in + (store.playhead - c.start) * (c.speed ?? 1) : -1;
    this.segEls.forEach((el, i) => el.classList.toggle("now", st >= this.segs[i].start && st < this.segs[i].end));
  }

  /** Text-based editing: remove the source ranges of the given segments from the timeline. */
  private cutSegments(mediaId: string, segs: Segment[]) {
    const ranges: [number, number][] = [];
    for (const s of segs) {
      for (const c of store.project.clips) {
        if (c.source.type !== "media" || (c.source as any).media !== mediaId) continue;
        const sin = (c.source as any).in, sp = c.speed ?? 1;
        const a = c.start + (s.start - sin) / sp, b = c.start + (s.end - sin) / sp;
        if (b > c.start && a < clipEnd(c)) ranges.push([Math.max(a, c.start), Math.min(b, clipEnd(c))]);
      }
    }
    ranges.sort((x, y) => y[0] - x[0]);
    for (const [a, b] of ranges) act.rippleDeleteRange(a, b);
    store.emit("toast", `Removed ${ranges.length} ranges`);
  }
}

export { uid };

export async function listHtml() {
  try { return (await fs.list(store.abs("motion"))).filter((e) => !e.isDir && /\.html?$/i.test(e.name)).map((e) => `motion/${e.name}`); } catch { return []; }
}
