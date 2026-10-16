import { store } from "../store";
import { h, I, clear, prompt } from "../ui/dom";
import { Viewer } from "../ui/viewer";
import { TEMPLATES } from "../templates";
import { listModules, getModule, moduleError } from "../engine/modules";
import { fs } from "../ipc";
import { materializeTemplate, listHtml } from "../ui/library";
import * as act from "../actions";
import { clipEnd } from "../model";

const NEW_MODULE = `export default {
  name: "My Motion",
  duration: 4,
  params: {
    text: { type: "text", default: "Hello" },
    color: { type: "color", default: "#ffffff" },
  },
  render(ctx, t, api) {
    const { width: W, height: H, params: p, kit } = api;
    const k = kit.spring(t, 1, 0.5);
    ctx.globalAlpha = kit.clamp(k);
    kit.text(ctx, p.text, W / 2, H / 2 + (1 - k) * 60, { size: 160, weight: 800, tracking: -0.03, color: p.color });
  },
};
`;

export class MotionPage {
  el: HTMLElement;
  private lib: HTMLElement;
  private codeHost: HTMLElement;
  private strip: HTMLElement;
  private file: string | null = null;
  private ta!: HTMLTextAreaElement;
  private gutter!: HTMLElement;
  private err!: HTMLElement;
  private dirty = false;

  constructor(private viewer: Viewer) {
    this.lib = h("div", { class: "body" });
    this.codeHost = h("div", { class: "col", style: { flex: "1", minHeight: "0", gap: "0" } });
    this.strip = h("div", { class: "strip" });
    this.el = h("div", { class: "page page-motion" },
      h("div", { class: "panel p-lib" }, h("header", {}, h("h3", {}, "Motion Library"), h("div", { class: "grow" }),
        h("button", { class: "btn sm", onclick: () => this.newModule() }, I.plus(), "New")), this.lib),
      h("div", { class: "p-viewer", style: { display: "flex", minHeight: "0" } }),
      h("div", { class: "panel p-code" }, this.codeHost),
      h("div", { class: "panel p-strip" }, h("header", {}, h("h3", {}, "Motion clips on timeline")), this.strip));
    store.on("open-motion", (id) => {
      const c = store.clip(id);
      if (c?.source.type === "motion" || c?.source.type === "html") { void this.open((c.source as any).module); store.select([c.id]); store.seek(c.start + 0.0001); }
    });
    store.on("modules", () => { this.paintError(); });
    store.on("project", (w) => { if (w !== "drag" && w !== "inspector") this.renderStrip(); });
    store.on("fs-module", (path) => { if (path === this.file && !this.dirty) void this.open(path, true); });
  }

  mount() {
    const slot = this.el.querySelector(".p-viewer") as HTMLElement;
    if (this.viewer.el.parentElement !== slot) slot.appendChild(this.viewer.el);
    this.viewer.el.style.flex = "1";
    this.viewer.mount();
    void this.renderLib();
    this.renderStrip();
    const sel = store.selectedClips().find((c) => c.source.type === "motion" || c.source.type === "html");
    if (sel && (sel.source as any).module !== this.file) void this.open((sel.source as any).module);
    else if (!this.file) this.renderEditor();
  }

  private async renderLib() {
    clear(this.lib);
    const own = [...(await listHtml()), ...(await listModules("motion"))];
    this.lib.appendChild(h("div", { class: "lib-sec" }, "Project modules"));
    if (!own.length) this.lib.appendChild(h("div", { class: "faint", style: { padding: "4px 16px" } }, "None yet — create one or ask the agent."));
    for (const p of own) {
      const mod = p.endsWith(".js") ? getModule(p) : null;
      this.lib.appendChild(h("div", { class: "lib-item" + (p === this.file ? " sel" : ""), onclick: () => this.open(p) },
        h("div", { class: "sw", style: { background: p.endsWith(".html") ? "linear-gradient(135deg,#ff9f0a,#c43a6b)" : "linear-gradient(135deg,#8e44e8,#3b1066)" } }),
        h("div", { class: "t" }, h("div", {}, mod?.name ?? p.split("/").pop()), h("small", {}, moduleError(p) ? "⚠ error" : p.endsWith(".html") ? "HTML · " + p : p))));
    }
    this.lib.appendChild(h("div", { class: "lib-sec" }, "Templates"));
    for (const t of TEMPLATES) {
      this.lib.appendChild(h("div", { class: "lib-item", title: "Double-click to add to timeline", onclick: async () => this.open(await materializeTemplate(t.id)), ondblclick: async () => act.addMotion(await materializeTemplate(t.id), t.name, t.duration) },
        h("div", { class: "sw", style: { background: t.preview } }), h("div", { class: "t" }, h("div", {}, t.name), h("small", {}, t.category))));
    }
  }

  private renderStrip() {
    clear(this.strip);
    const clips = store.project.clips.filter((c) => c.source.type === "motion" || c.source.type === "html").sort((a, b) => a.start - b.start);
    if (!clips.length) { this.strip.appendChild(h("div", { class: "faint", style: { padding: "10px" } }, "No motion clips yet. Double-click a template to add one.")); return; }
    for (const c of clips) {
      this.strip.appendChild(h("div", { class: "sc" + (store.selection.has(c.id) ? " sel" : ""), onclick: () => { store.select([c.id]); store.seek(c.start + Math.min(1, c.duration / 2)); void this.open((c.source as any).module); this.renderStrip(); } },
        h("div", { class: "im", style: { background: c.source.type === "html" ? "linear-gradient(135deg,#ff9f0a,#c43a6b)" : "linear-gradient(135deg,#8e44e8,#22113a)" } }),
        h("small", {}, `${c.name ?? "motion"} · ${c.start.toFixed(1)}–${clipEnd(c).toFixed(1)}s`)));
    }
  }

  private async newModule() {
    const name = await prompt("New motion composition (end with .js for canvas/GLSL)", "my-motion", "file name");
    if (!name) return;
    const isJs = name.endsWith(".js");
    const rel = `motion/${name.replace(/\.(js|html)$/, "").replace(/[^\w-]+/g, "-")}.${isJs ? "js" : "html"}`;
    await fs.writeText(store.abs(rel), isJs ? NEW_MODULE.replace("My Motion", name) : TEMPLATES.find((t) => t.id === "keynote-reveal")!.code);
    await this.open(rel);
    act.addMotion(rel, name, 4);
    void this.renderLib();
  }

  async open(rel: string, keepCursor = false) {
    this.file = rel;
    let code = "";
    try { code = await fs.readText(store.abs(rel)); } catch (e) { code = `// cannot read ${rel}: ${e}`; }
    const pos = keepCursor && this.ta ? this.ta.selectionStart : 0;
    this.renderEditor(code);
    if (keepCursor) this.ta.selectionStart = this.ta.selectionEnd = pos;
    void this.renderLib();
  }

  private renderEditor(code?: string) {
    clear(this.codeHost);
    if (!this.file) {
      this.codeHost.append(h("header", { style: { display: "flex", padding: "8px 12px", borderBottom: "1px solid var(--hair)" } }, h("h3", { style: { margin: 0, font: "600 12px var(--font-display)" } }, "Code")),
        h("div", { class: "empty" }, h("div", {}, h("b", {}, "Motion graphics as code"), "Pick a module, or ask the agent:", h("br"), h("i", {}, "“make an Apple-style product reveal with my logo”"))));
      return;
    }
    this.dirty = false;
    this.ta = h("textarea", { spellcheck: false }) as HTMLTextAreaElement;
    this.ta.value = code ?? "";
    this.gutter = h("div", { class: "gutter" });
    this.err = h("div", { class: "errbar", style: { display: "none" } });
    const save = h("button", { class: "btn sm primary", onclick: () => this.save() }, "Save  ⌃S");
    const ask = h("input", { type: "text", placeholder: "Ask the agent to change this module…", style: { flex: "1" } }) as HTMLInputElement;
    ask.addEventListener("keydown", (e) => { if (e.key === "Enter" && ask.value.trim()) { store.emit("agent-prompt", `Edit the motion module ${this.file}: ${ask.value.trim()}. After editing, render a contact sheet with the control API to verify it looks great.`); ask.value = ""; } });
    const syncGutter = () => { this.gutter.textContent = this.ta.value.split("\n").map((_, i) => i + 1).join("\n"); this.gutter.scrollTop = this.ta.scrollTop; };
    this.ta.addEventListener("input", () => { this.dirty = true; syncGutter(); });
    this.ta.addEventListener("scroll", () => (this.gutter.scrollTop = this.ta.scrollTop));
    this.ta.addEventListener("keydown", (e) => {
      if (e.key === "Tab") { e.preventDefault(); const s = this.ta.selectionStart; this.ta.setRangeText("  ", s, this.ta.selectionEnd, "end"); this.dirty = true; }
      if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); void this.save(); }
      e.stopPropagation();
    });
    syncGutter();
    this.codeHost.append(
      h("header", { style: { display: "flex", alignItems: "center", gap: "8px", padding: "7px 10px", borderBottom: "1px solid var(--hair)" } },
        h("h3", { style: { margin: 0, font: "600 12px var(--font-display)" } }, this.file), h("div", { class: "grow" }),
        h("button", { class: "btn sm", onclick: () => act.addMotion(this.file!, (this.file!.endsWith(".js") ? getModule(this.file!)?.name : null) ?? this.file!.split("/").pop()!, (this.file!.endsWith(".js") ? getModule(this.file!)?.duration : null) ?? 5) }, I.plus(), "Add to timeline"), save),
      h("div", { class: "code" }, this.gutter, this.ta), this.err,
      h("div", { class: "row", style: { padding: "8px 10px", borderTop: "1px solid var(--hair)" } }, I.spark(), ask));
    this.paintError();
  }

  private async save() {
    if (!this.file) return;
    await fs.writeText(store.abs(this.file), this.ta.value);
    this.dirty = false;
    store.emit("toast", "Saved — hot reloading");
  }

  private paintError() {
    if (!this.file || !this.err) return;
    const e = moduleError(this.file) ?? store.errors.filter((x) => x.source.startsWith(this.file!)).map((x) => x.message).pop();
    this.err.style.display = e ? "block" : "none";
    this.err.textContent = e ?? "";
  }
}
