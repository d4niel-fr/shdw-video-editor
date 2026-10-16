// Central app state: project document, playhead, selection, undo history,
// persistence to project.shdw.json and external-change (agent) reloads.

import { Project, Clip, normalize, defaultProject, deepClone, projectDuration, frameSnap } from "./model";
import { fs, join, isAbs, norm } from "./ipc";

type Listener = (why: string) => void;

class Store {
  project: Project = defaultProject();
  dir = "";
  playhead = 0;
  playing = false;
  selection = new Set<string>();
  page: string = "edit";
  zoom = 80; // px per second on timeline
  scrollX = 0;
  inPoint: number | null = null;
  outPoint: number | null = null;
  tool: "select" | "blade" | "trim" | "hand" = "select";
  snapping = true;
  previewScale = 1;
  /** viewer plays HTML compositions as live DOM (sharp, real-time) instead of rendered frames */
  liveHtml = (() => { try { return localStorage.getItem("shdw.liveHtml") !== "0"; } catch { return true; } })();
  loopPlayback = false;
  errors: { source: string; message: string; time: number }[] = [];

  private listeners = new Map<string, Set<Listener>>();
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private saveTimer = 0;
  private lastWritten = "";

  on(topic: string, fn: Listener) {
    if (!this.listeners.has(topic)) this.listeners.set(topic, new Set());
    this.listeners.get(topic)!.add(fn);
    return () => this.listeners.get(topic)!.delete(fn);
  }
  emit(topic: string, why = "") {
    this.listeners.get(topic)?.forEach((f) => f(why));
    if (topic !== "*") this.listeners.get("*")?.forEach((f) => f(topic));
  }

  get duration() { return projectDuration(this.project); }
  get fps() { return this.project.settings.fps; }
  get projectFile() { return join(this.dir, "project.shdw.json"); }

  abs(p: string) { return !p ? p : isAbs(p) ? norm(p) : join(this.dir, p); }
  rel(p: string) {
    const n = norm(p), d = norm(this.dir) + "/";
    return n.toLowerCase().startsWith(d.toLowerCase()) ? n.slice(d.length) : n;
  }

  /** Mutate the project with undo support. */
  mutate(label: string, fn: (p: Project) => void) {
    this.undoStack.push(JSON.stringify(this.project));
    if (this.undoStack.length > 300) this.undoStack.shift();
    this.redoStack = [];
    fn(this.project);
    this.changed(label);
  }

  /** Call after in-place edits that already pushed undo via begin(). */
  changed(label = "edit") {
    this.emit("project", label);
    this.scheduleSave();
  }

  /** For continuous gestures: snapshot once at gesture start. */
  begin() {
    this.undoStack.push(JSON.stringify(this.project));
    this.redoStack = [];
  }

  undo() {
    const s = this.undoStack.pop();
    if (!s) return;
    this.redoStack.push(JSON.stringify(this.project));
    this.project = JSON.parse(s);
    this.changed("undo");
  }
  redo() {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push(JSON.stringify(this.project));
    this.project = JSON.parse(s);
    this.changed("redo");
  }

  scheduleSave() {
    if (!this.dir) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.save(), 250);
  }
  async save() {
    if (!this.dir) return;
    const text = JSON.stringify(this.project, null, 2);
    if (text === this.lastWritten) return;
    this.lastWritten = text;
    await fs.writeText(this.projectFile, text);
    this.emit("saved");
  }

  async load(dir: string, text: string) {
    this.dir = norm(dir);
    this.project = normalize(JSON.parse(text));
    this.lastWritten = text;
    this.undoStack = [];
    this.redoStack = [];
    this.selection.clear();
    this.playhead = 0;
    this.emit("project", "load");
    this.emit("opened");
  }

  /** Called when project.shdw.json changed on disk (agent edit). */
  async reloadFromDisk() {
    let text: string;
    try { text = await fs.readText(this.projectFile); } catch { return; }
    if (text === this.lastWritten) return;
    try {
      const parsed = JSON.parse(text);
      this.undoStack.push(JSON.stringify(this.project));
      this.project = normalize(parsed);
      this.lastWritten = text;
      for (const id of [...this.selection]) if (!this.clip(id)) this.selection.delete(id);
      this.emit("project", "external");
      this.emit("toast", "Project updated by agent");
    } catch (e: any) {
      this.error("project.shdw.json", "Invalid JSON: " + e.message);
    }
  }

  error(source: string, message: string) {
    const last = this.errors[this.errors.length - 1];
    if (last && last.source === source && last.message === message) return;
    this.errors.push({ source, message, time: Date.now() });
    if (this.errors.length > 100) this.errors.shift();
    this.emit("errors");
  }
  clearErrors(source?: string) {
    this.errors = source ? this.errors.filter((e) => e.source !== source) : [];
    this.emit("errors");
  }

  clip(id: string): Clip | undefined { return this.project.clips.find((c) => c.id === id); }
  selectedClips() { return this.project.clips.filter((c) => this.selection.has(c.id)); }
  select(ids: string[], additive = false) {
    if (!additive) this.selection.clear();
    for (const id of ids) {
      this.selection.add(id);
      const c = this.clip(id);
      if (c?.link) for (const o of this.project.clips) if (o.link === c.link) this.selection.add(o.id);
    }
    this.emit("selection");
  }

  seek(t: number) {
    this.playhead = Math.max(0, frameSnap(t, this.fps));
    this.emit("time");
  }

  snapshot() { return deepClone(this.project); }
}

export const store = new Store();
(window as any).shdw = store;
