import "./styles.css";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke, listen, join, norm, basename, fs } from "./ipc";
import { store } from "./store";
import { defaultProject, clipEnd, frameSnap } from "./model";
import { h, I, clear, toast, modal, prompt, drag } from "./ui/dom";
import { Renderer } from "./engine/renderer";
import { playback } from "./engine/playback";
import { pool } from "./engine/sources";
import { invalidateModule, invalidateAll } from "./engine/modules";
import { Timeline } from "./ui/timeline";
import { Inspector } from "./ui/inspector";
import { Viewer } from "./ui/viewer";
import { Library } from "./ui/library";
import { AgentPanel } from "./ui/agent";
import { MediaPage } from "./pages/media";
import { MotionPage } from "./pages/motion";
import { ColorPage } from "./pages/color";
import { AudioPage } from "./pages/audio";
import { DeliverPage } from "./pages/deliver";
import { importFiles, prepareMedia } from "./media";
import { loadProjectFonts } from "./fonts";
import { startControl } from "./control";
import * as act from "./actions";
import { htmlFrames, installLibs } from "./engine/html";
import { liveHtml } from "./engine/live";
import { glassFolder, projectInfo, confirmDialog, sameDir } from "./ui/projects";

const win = getCurrentWindow();
let env: any = {};

// ---------------- engine ----------------
const canvas = h("canvas");
const renderer = new Renderer(canvas);
let dirty = true;
const invalidate = () => (dirty = true);
for (const ev of ["time", "project", "frame-ready", "modules", "fonts", "scrub"]) store.on(ev, invalidate);
playback.onFrame = invalidate;
function frameLoop() {
  if (dirty && !renderer.locked && store.dir) {
    dirty = false;
    renderer.configure(store.project, store.previewScale);
    renderer.live = store.liveHtml ? renderer.livePlan(store.project, store.playhead) : null;
    renderer.render(store.project, store.playhead, false);
    liveHtml.sync(renderer, renderer.live, store.playhead);
    store.emit("rendered");
  }
  requestAnimationFrame(frameLoop);
}
requestAnimationFrame(frameLoop);
startControl(renderer);
// live preview doesn't need the screenshot cache; keep the headless renderers free for exports/agent frames
htmlFrames.busy = () => renderer.locked > 0 || store.liveHtml;
htmlFrames.startBackground(() => store.previewScale);

// ---------------- UI ----------------
const viewer = new Viewer(renderer);
const timeline = new Timeline();
const audioTimeline = new Timeline(true);
const inspector = new Inspector();
const library = new Library();
const agent = new AgentPanel();
const mediaPage = new MediaPage();
const motionPage = new MotionPage(viewer);
const colorPage = new ColorPage(viewer);
const audioPage = new AudioPage(audioTimeline);
const deliverPage = new DeliverPage(viewer);
timeline.onOpenClip = audioTimeline.onOpenClip = (c) => { if (c.source.type === "motion") { setPage("motion"); store.emit("open-motion", c.id); } };
timeline.onAskAgent = audioTimeline.onAskAgent = (t) => store.emit("agent-prompt", t);

const split = h("div", { class: "p-split" });
const editPage = h("div", { class: "page page-edit" }, library.el, h("div", { class: "p-viewer-slot", style: { display: "flex", minHeight: "0", gridRow: "1", gridColumn: "2" } }), h("div", { class: "p-insp", style: { display: "flex", minHeight: "0" } }, inspector.el), split,
  h("div", { class: "panel p-tl" }, timeline.el));
inspector.el.style.flex = "1";
split.addEventListener("pointerdown", (e) => {
  const page = editPage.getBoundingClientRect();
  drag(e, (_dx, _dy, ev) => { const hgt = Math.max(160, Math.min(page.height - 220, page.bottom - ev.clientY)); editPage.style.setProperty("--tl-h", hgt + "px"); });
});

const pages: Record<string, { el: HTMLElement; mount: () => void; label: string; icon: () => SVGElement }> = {
  media: { el: mediaPage.el, mount: () => mediaPage.render(), label: "Media", icon: I.media },
  edit: { el: editPage, mount: () => { const slot = editPage.querySelector(".p-viewer-slot")!; if (viewer.el.parentElement !== slot) slot.appendChild(viewer.el); viewer.el.style.flex = "1"; viewer.mount(); timeline.invalidate(); }, label: "Edit", icon: I.edit },
  motion: { el: motionPage.el, mount: () => motionPage.mount(), label: "Motion", icon: I.motion },
  color: { el: colorPage.el, mount: () => colorPage.mount(), label: "Color", icon: I.color },
  audio: { el: audioPage.el, mount: () => audioPage.mount(), label: "Fairlight", icon: I.audio },
  deliver: { el: deliverPage.el, mount: () => deliverPage.mount(), label: "Deliver", icon: I.deliver },
};

const pagesHost = h("div", { id: "pages" }, ...Object.values(pages).map((p) => p.el));
const seg = h("div", { class: "seg" }, h("div", { class: "thumb" }));
const segBtns: Record<string, HTMLButtonElement> = {};
for (const [id, p] of Object.entries(pages)) {
  segBtns[id] = h("button", { onclick: () => setPage(id), title: `${p.label}` }, p.icon(), p.label) as HTMLButtonElement;
  seg.appendChild(segBtns[id]);
}
function moveThumb() {
  const b = segBtns[store.page]; const th = seg.querySelector(".thumb") as HTMLElement;
  if (!b) return;
  th.style.left = b.offsetLeft + "px"; th.style.width = b.offsetWidth + "px";
}
function setPage(id: string) {
  store.page = id;
  for (const [k, p] of Object.entries(pages)) { p.el.classList.toggle("on", k === id); segBtns[k].classList.toggle("on", k === id); }
  pages[id].mount();
  moveThumb();
  invalidate();
}

const errBadge = h("button", { class: "btn sm ghost", style: { display: "none", color: "var(--red)" }, onclick: () => showErrors() });
store.on("errors", () => { errBadge.style.display = store.errors.length ? "" : "none"; errBadge.textContent = `⚠ ${store.errors.length}`; });
const agentDot = h("span", { class: "dot" });
store.on("agent-busy", (b) => (agentDot.className = "dot " + (b ? "busy" : "ok")));
const projName = h("span", { class: "proj" }, "");
store.on("project", () => { projName.textContent = store.project.name; });
const saved = h("span", { class: "faint" }, "");
store.on("saved", () => { saved.textContent = "Saved"; setTimeout(() => (saved.textContent = ""), 1200); });

const titlebar = h("header", { class: "titlebar", "data-tauri-drag-region": true },
  h("div", { class: "lights" },
    h("button", { class: "close", title: "Close", onclick: () => win.close() }),
    h("button", { class: "min", title: "Minimize", onclick: () => win.minimize() }),
    h("button", { class: "max", title: "Zoom", onclick: () => win.toggleMaximize() })),
  h("div", { class: "brand", "data-tauri-drag-region": true }, h("div", { class: "logo" }), "shdw"),
  projName,
  h("div", { class: "spacer", "data-tauri-drag-region": true, ondblclick: () => win.toggleMaximize() }),
  h("div", { class: "status" }, saved, errBadge,
    h("button", { class: "btn sm ghost", title: "Open / new project", onclick: () => showWelcome() }, I.folder(), "Projects")));

const agentToggle = h("button", { class: "btn sm", title: "Agent (Ctrl+K)", onclick: () => { agent.toggle(); agentToggle.classList.toggle("on", !agent.el.classList.contains("hidden")); } }, agentDot, I.spark(), "Agent");
agentToggle.classList.add("on");
const pagebar = h("footer", { class: "pagebar" },
  h("div", { class: "left" }, h("button", { class: "btn icon sm ghost", title: "Undo (Ctrl+Z)", onclick: () => store.undo() }, I.undo()), h("button", { class: "btn icon sm ghost", title: "Redo (Ctrl+Shift+Z)", onclick: () => store.redo() }, I.redo())),
  seg,
  h("div", { class: "right" }, agentToggle));

const app = h("div", { id: "app" }, titlebar, h("div", { id: "workspace" }, pagesHost, agent.el), pagebar);
document.body.appendChild(app);
addEventListener("resize", moveThumb);
setPage("edit");

store.on("toast", (t) => toast(t));
store.on("set-page", (n) => { if (pages[n]) setPage(n); });

function showErrors() {
  modal((close) => h("div", { class: "col" },
    h("h2", {}, "Problems"),
    h("p", {}, "Compile/runtime errors from motion modules, shaders and media. The agent sees these too."),
    h("div", { style: { maxHeight: "50vh", overflow: "auto", font: "11.5px/1.5 var(--mono)", userSelect: "text" } },
      ...store.errors.slice().reverse().map((e) => h("div", { style: { padding: "6px 0", borderBottom: "1px solid var(--hair)" } }, h("b", {}, e.source), h("div", { class: "muted", style: { whiteSpace: "pre-wrap" } }, e.message)))),
    h("div", { class: "row", style: { justifyContent: "flex-end" } },
      h("button", { class: "btn", onclick: () => { store.clearErrors(); close(); } }, "Clear"),
      h("button", { class: "btn primary", onclick: () => { store.emit("agent-prompt", "Fix these editor errors:\n" + store.errors.slice(-8).map((e) => `- ${e.source}: ${e.message}`).join("\n")); close(); } }, I.spark(), "Ask agent to fix"))));
}

// ---------------- project lifecycle ----------------
function recents(): string[] { try { return JSON.parse(localStorage.getItem("shdw.recent") ?? "[]"); } catch { return []; } }
function addRecent(dir: string) { localStorage.setItem("shdw.recent", JSON.stringify([dir, ...recents().filter((d) => d !== dir)].slice(0, 12))); }

async function openProject(dir: string) {
  dir = norm(dir);
  const port = await invoke<number>("control_port");
  agent.port = port;
  const text = await invoke<string>("project_init", { dir, port, defaultProject: JSON.stringify(defaultProject(basename(dir)), null, 2) });
  playback.pause();
  invalidateAll();
  await store.load(dir, text);
  await invoke("watch_dir", { dir });
  addRecent(dir);
  closeWelcome();
  await loadProjectFonts();
  htmlFrames.clear();
  void installLibs();
  for (const m of store.project.media) void prepareMedia(m);
  pool.purgeMissing(store.project);
  setPage(store.page);
  timeline.fit();
  document.title = `shdw — ${store.project.name}`;
}

async function newProject() {
  const parent = await open({ directory: true, title: "Choose where to create the project" });
  if (!parent) return;
  const name = await prompt("Project name", "My Video");
  if (!name) return;
  await openProject(join(String(parent), name.replace(/[<>:"/\\|?*]+/g, "-")));
}
async function openExisting() {
  const dir = await open({ directory: true, title: "Open a shdw project folder" });
  if (dir) await openProject(String(dir));
}

let welcome: HTMLElement | null = null;
const fmtDur = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const ago = (ms: number) => { if (!ms) return ""; const d = (Date.now() - ms) / 1000; return d < 3600 ? `${Math.max(1, Math.round(d / 60))}m ago` : d < 86400 ? `${Math.round(d / 3600)}h ago` : `${Math.round(d / 86400)}d ago`; };
function closeWelcome() { welcome?.remove(); welcome = null; }
function showWelcome() {
  closeWelcome();
  const rec = recents();
  const tile = (title: string, value: string, sub: string, ok?: boolean) =>
    h("div", { class: "wtile" }, h("h3", {}, title), h("p", { class: "big" }, value),
      h("p", { class: "sub" }, ok === undefined ? null : h("span", { class: "dot " + (ok ? "ok" : "bad") }), sub));
  const grid = h("div", { class: "desk-grid" });
  const count = h("span", {}, String(rec.length));
  welcome = h("div", { class: "welcome desk" },
    h("div", { class: "desk-inner" },
      h("header", { class: "desk-head" },
        h("div", {}, h("div", { class: "eyebrow" }, "shdw · projects"), h("h1", {}, "Your projects")),
        h("div", { class: "row" },
          store.dir ? h("button", { class: "btn ghost", onclick: () => closeWelcome() }, "Back to editor") : null,
          h("button", { class: "btn", onclick: () => openExisting() }, I.folder(), "Open…"),
          h("button", { class: "btn primary", onclick: () => newProject() }, I.plus(), "New project"))),
      h("div", { class: "wtiles" },
        h("div", { class: "wtile" }, h("h3", {}, "Projects"), h("p", { class: "big" }, count), h("p", { class: "sub" }, "in recents")),
        tile("Claude Code", env.claude ? "Ready" : "Missing", env.claudeVersion ?? "not found", !!env.claude),
        tile("Codex CLI", env.codex ? "Ready" : "Missing", env.codexVersion ?? "not found", !!env.codex),
        tile("FFmpeg", env.ffmpeg ? "Ready" : "Missing", env.ffmpeg ? "decode · encode" : "winget install Gyan.FFmpeg", !!env.ffmpeg)),
      rec.length ? grid : h("div", { class: "desk-empty" }, h("p", {}, "No projects yet."), h("p", { class: "faint" }, "Create one, or open an existing shdw folder.")),
      h("p", { class: "desk-hint" }, "Hover to lean · Click to open · ··· for options")));
  const forget = (d: string) => { localStorage.setItem("shdw.recent", JSON.stringify(recents().filter((x) => !sameDir(x, d)))); };
  rec.forEach(async (d, i) => {
    const info = await projectInfo(d);
    const cur = !!store.dir && sameDir(store.dir, d);
    const card = glassFolder({
      label: info.name, seed: hashDir(d), delay: i * 90, current: cur,
      meta: info.clips ? `${info.clips} clips · ${fmtDur(info.duration)}${info.modified ? " · " + ago(info.modified) : ""}` : "Empty project",
      files: info.renders.length ? info.renders.map((r) => ({ name: r.name, image: r.image })) : [{ name: "project.shdw.json", meta: "JSON" }],
      onOpen: () => (cur ? closeWelcome() : openProject(d).catch((e) => toast(String(e)))),
      menu: [
        { label: "Open", run: () => (cur ? closeWelcome() : openProject(d).catch((e) => toast(String(e)))) },
        { label: "Show in Explorer", run: () => void fs.reveal(d) },
        { label: "Remove from list", run: () => { forget(d); card.remove(); count.textContent = String(recents().length); } },
        { label: "Delete project…", danger: true, run: async () => {
          if (cur) return toast("Close this project first (open another one), then delete it.");
          if (!(await confirmDialog(`Delete “${info.name}”?`, `This permanently deletes the folder and everything in it:
${d}`, "Delete"))) return;
          try { await fs.remove(d); forget(d); card.remove(); count.textContent = String(recents().length); toast("Project deleted"); }
          catch (e) { toast("Delete failed: " + e); }
        } },
      ],
    });
    card.style.order = String(i);
    grid.appendChild(card);
  });
  document.body.appendChild(welcome);
}
const hashDir = (d: string) => { let x = 7; for (const ch of norm(d).toLowerCase()) x = (x * 31 + ch.charCodeAt(0)) >>> 0; return x; };

// ---------------- file watcher (agent edits) ----------------
let pendingPaths = new Set<string>();
let fsTimer = 0;
void listen<string[]>("fs-change", (e) => {
  for (const p of e.payload) pendingPaths.add(norm(p));
  clearTimeout(fsTimer);
  fsTimer = window.setTimeout(async () => {
    const paths = [...pendingPaths]; pendingPaths = new Set();
    let files = false, fonts = false;
    for (const p of paths) {
      const rel = store.rel(p);
      if (rel === "project.shdw.json") await store.reloadFromDisk();
      else if (/^motion\/.*\.html?$/i.test(rel)) { htmlFrames.invalidate(rel); store.emit("fs-module", rel); }
      else if (/^motion\/.*\.(css|svg|json|png|jpg|webp)$/i.test(rel)) { for (const c of store.project.clips) if (c.source.type === "html") htmlFrames.invalidate((c.source as any).module); }
      else if (/^(motion|transitions|effects|blends)\//.test(rel)) { invalidateModule(rel); store.emit("fs-module", rel); }
      else if (rel.startsWith("fonts/")) fonts = true;
      else if (rel.startsWith("luts/")) { (renderer as any).luts?.delete(rel); invalidate(); }
      if (/^(media|inspo|renders|motion)\//.test(rel)) files = true;
    }
    if (fonts) await loadProjectFonts();
    if (files) store.emit("files");
    for (const m of store.project.media) if (!(m as any).__prep) { (m as any).__prep = 1; }
    invalidate();
  }, 140);
});
// when the agent adds media entries directly in JSON, build thumbs/waveforms
let knownMedia = new Set<string>();
store.on("project", () => {
  for (const m of store.project.media) if (!knownMedia.has(m.id)) { knownMedia.add(m.id); if (store.dir) void prepareMedia(m); }
});
store.on("opened", () => { knownMedia = new Set(store.project.media.map((m) => m.id)); });

// ---------------- drag & drop from Explorer ----------------
void getCurrentWebview().onDragDropEvent(async (e) => {
  if (e.payload.type !== "drop" || !store.dir) return;
  const paths = e.payload.paths;
  if (store.page === "media" && (document.getElementById("media-title")?.textContent ?? "").startsWith("inspo")) {
    for (const p of paths) await fs.copy(p, join(store.dir, "inspo", basename(p)));
    store.emit("files"); toast(`Added ${paths.length} inspiration item(s)`);
    return;
  }
  const media = await importFiles(paths, localStorage.getItem("shdw.copyMedia") === "1");
  const pos = e.payload.position;
  const target = document.elementFromPoint(pos.x / devicePixelRatio, pos.y / devicePixelRatio);
  if (target?.closest(".tl-canvas")) { let t = store.duration; for (const m of media) { act.placeMedia(m, t); t += m.duration; } }
  toast(`Imported ${media.length} file(s)`);
});

// ---------------- keyboard ----------------
addEventListener("keydown", (e) => {
  const tgt = e.target as HTMLElement;
  if (tgt.closest("input, textarea, select, [contenteditable]")) return;
  const ctrl = e.ctrlKey || e.metaKey, k = e.key;
  const fps = store.fps;
  const edits = () => [...new Set([0, ...store.project.clips.flatMap((c) => [c.start, clipEnd(c)])])].sort((a, b) => a - b);
  const handled = () => { e.preventDefault(); e.stopPropagation(); };
  if (ctrl && k.toLowerCase() === "k") { handled(); agent.show(); (agent.el.querySelector("textarea") as HTMLTextAreaElement)?.focus(); return; }
  if (ctrl && k.toLowerCase() === "z") { handled(); e.shiftKey ? store.redo() : store.undo(); return; }
  if (ctrl && k.toLowerCase() === "y") { handled(); store.redo(); return; }
  if (ctrl && k.toLowerCase() === "s") { handled(); void store.save().then(() => toast("Saved")); return; }
  if (ctrl && k.toLowerCase() === "i") { handled(); void import("./ui/library").then((m) => m.pickAndImport()); return; }
  if (ctrl && k.toLowerCase() === "o") { handled(); showWelcome(); return; }
  if (!store.dir) return;
  if (e.shiftKey && !ctrl && /^Digit[1-6]$/.test(e.code)) { handled(); setPage(Object.keys(pages)[+e.code.slice(5) - 1]); return; }
  if (ctrl) {
    switch (k.toLowerCase()) {
      case "b": handled(); act.splitAt(); return;
      case "c": handled(); act.copySelection(); return;
      case "x": handled(); act.cutSelection(); return;
      case "v": handled(); act.paste(); return;
      case "d": handled(); act.duplicateSelection(); return;
      case "l": handled(); act.toggleLink(); return;
      case "t": handled(); act.transitionAtPlayhead(); return;
      case "a": handled(); store.select(store.project.clips.map((c) => c.id)); return;
      case "e": handled(); setPage("deliver"); return;
    }
    return;
  }
  switch (k) {
    case " ": handled(); playback.toggle(); break;
    case "j": case "J": handled(); playback.shuttle(-1); break;
    case "k": case "K": handled(); playback.shuttle(0); break;
    case "l": case "L": handled(); playback.shuttle(1); break;
    case "ArrowLeft": handled(); store.seek(store.playhead - (e.shiftKey ? 1 : 1 / fps)); break;
    case "ArrowRight": handled(); store.seek(store.playhead + (e.shiftKey ? 1 : 1 / fps)); break;
    case "ArrowUp": handled(); { const p = edits().filter((t) => t < store.playhead - 1e-6).pop(); store.seek(p ?? 0); } break;
    case "ArrowDown": handled(); { const n = edits().find((t) => t > store.playhead + 1e-6); if (n != null) store.seek(n); } break;
    case "Home": handled(); store.seek(0); break;
    case "End": handled(); store.seek(store.duration); break;
    case "i": case "I": handled(); store.inPoint = frameSnap(store.playhead, fps); store.emit("time"); break;
    case "o": case "O": handled(); store.outPoint = frameSnap(store.playhead, fps); store.emit("time"); break;
    case "x": case "X": if (e.altKey) { handled(); store.inPoint = store.outPoint = null; store.emit("time"); } break;
    case "Delete": case "Backspace": handled(); act.deleteSelection(e.shiftKey); break;
    case "a": case "A": handled(); store.tool = "select"; store.emit("tool"); break;
    case "b": case "B": handled(); store.tool = "blade"; store.emit("tool"); break;
    case "t": case "T": handled(); store.tool = "trim"; store.emit("tool"); break;
    case "h": case "H": handled(); store.tool = "hand"; store.emit("tool"); break;
    case "m": case "M": handled(); act.addMarker(); break;
    case "n": case "N": handled(); store.snapping = !store.snapping; toast(`Snapping ${store.snapping ? "on" : "off"}`); break;
    case "d": case "D": handled(); act.toggleEnabled(); break;
    case "z": case "Z": if (e.shiftKey) { handled(); timeline.fit(); } break;
    case "=": case "+": handled(); store.zoom = Math.min(600, store.zoom * 1.3); store.emit("zoom"); break;
    case "-": handled(); store.zoom = Math.max(2, store.zoom / 1.3); store.emit("zoom"); break;
    case ",": handled(); act.nudge(-1 / fps); break;
    case ".": handled(); act.nudge(1 / fps); break;
    case "Escape": store.selection.clear(); store.emit("selection"); break;
  }
});

// ---------------- boot ----------------
(async () => {
  env = await invoke("env_info").catch(() => ({}));
  agent.port = await invoke<number>("control_port").catch(() => 0);
  if (!env.claude && env.codex) localStorage.setItem("shdw.provider", "codex");
  const arg = await invoke<string | null>("startup_project").catch(() => null);
  if (arg) { try { await openProject(arg); return; } catch (e) { toast(String(e)); } }
  const last = recents()[0];
  if (last && (await fs.exists(join(last, "project.shdw.json")).catch(() => false))) {
    try { await openProject(last); return; } catch (e) { console.warn(e); }
  }
  showWelcome();
})();
void clear;
