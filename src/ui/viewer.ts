import { store } from "../store";
import { h, I, drag } from "./dom";
import { timecode, prop, frameSnap } from "../model";
import { playback } from "../engine/playback";
import { Renderer } from "../engine/renderer";
import { writeProp, localTime } from "./inspector";
import { htmlFrames } from "../engine/html";
import { liveHtml } from "../engine/live";

/** One renderer canvas, re-parented into whichever page's viewer is visible. */
export class Viewer {
  el: HTMLElement;
  stage: HTMLElement;
  private tc: HTMLElement;
  private dur: HTMLElement;
  private playBtn: HTMLButtonElement;
  private safe: HTMLElement;

  constructor(public renderer: Renderer, title = "Timeline Viewer") {
    this.safe = h("div", { class: "safe", style: { display: "none", zIndex: "5" } });
    this.stage = h("div", { class: "viewer" }, this.safe);
    this.tc = h("span", { class: "timecode" }, "00:00:00:00");
    this.dur = h("span", { class: "timecode dim" }, "");
    this.playBtn = h("button", { class: "btn icon ghost", title: "Play (Space)", onclick: () => playback.toggle() }, I.play());
    const scale = h("select", { style: { width: "86px" } }) as HTMLSelectElement;
    for (const [l, v] of [["Full", 1], ["Half", 0.5], ["Quarter", 0.25]] as [string, number][]) scale.appendChild(h("option", { value: v, selected: store.previewScale === v }, l));
    scale.addEventListener("change", () => { store.previewScale = +scale.value; store.emit("frame-ready"); });
    const loop = h("button", { class: "btn icon ghost sm" + (store.loopPlayback ? " on" : ""), title: "Loop", onclick: () => { store.loopPlayback = !store.loopPlayback; loop.classList.toggle("on", store.loopPlayback); } }, I.loop());
    const live = h("button", { class: "btn ghost sm" + (store.liveHtml ? " on" : ""), title: "Live HTML preview — compositions play as real DOM: sharp and real-time. Off = exact rendered frames (what export produces).", onclick: () => {
      store.liveHtml = !store.liveHtml; live.classList.toggle("on", store.liveHtml);
      try { localStorage.setItem("shdw.liveHtml", store.liveHtml ? "1" : "0"); } catch {}
      if (!store.liveHtml) liveHtml.clear();
      this.info(); store.emit("frame-ready");
    } }, "Live");
    const safeBtn = h("button", { class: "btn ghost sm", title: "Safe area", onclick: () => { this.safe.style.display = this.safe.style.display === "none" ? "block" : "none"; this.layoutSafe(); } }, "Safe");
    const transport = h("div", { class: "transport" },
      this.tc, h("div", { class: "grow" }),
      h("button", { class: "btn icon ghost", title: "Go to start (Home)", onclick: () => store.seek(0) }, I.prev()),
      h("button", { class: "btn icon ghost", title: "Previous frame (←)", onclick: () => store.seek(store.playhead - 1 / store.fps) }, I.stepB()),
      this.playBtn,
      h("button", { class: "btn icon ghost", title: "Next frame (→)", onclick: () => store.seek(store.playhead + 1 / store.fps) }, I.stepF()),
      h("button", { class: "btn icon ghost", title: "Go to end (End)", onclick: () => store.seek(store.duration) }, I.next()),
      loop, h("div", { class: "grow" }), live, safeBtn, scale, this.dur);
    this.el = h("div", { class: "panel p-viewer" }, h("header", {}, h("h3", {}, title), h("div", { class: "grow" }), h("span", { class: "faint", id: "vw-info" })), this.stage, transport);
    store.on("cache-progress", () => this.info());
    store.on("rendered", () => { if (liveHtml.active !== this.wasLive) { this.wasLive = liveHtml.active; this.info(); } });
    store.on("time", () => this.update());
    store.on("transport", () => { this.playBtn.replaceChildren(store.playing ? I.pause() : I.play()); });
    store.on("project", () => this.update());
    new ResizeObserver(() => this.layoutSafe()).observe(this.stage);
    this.bindDirectManipulation();
  }

  private wasLive = false;
  private info() {
    const info = this.el.querySelector("#vw-info") as HTMLElement | null;
    if (!info) return;
    if (store.liveHtml) {
      info.textContent = liveHtml.active ? "● Live" : "";
      info.style.color = "var(--green)";
      return;
    }
    const { cached, total } = htmlFrames.stats;
    info.textContent = total ? (cached >= total ? "● Render cache ready" : `◐ Caching motion ${Math.round((cached / total) * 100)}%`) : "";
    info.style.color = cached >= total ? "var(--green)" : "var(--orange)";
  }

  mount() {
    if (this.renderer.canvas.parentElement !== this.stage) this.stage.prepend(this.renderer.canvas);
    liveHtml.attach(this.stage, this.renderer.canvas);
    this.layoutSafe();
  }

  update() {
    this.tc.textContent = timecode(store.playhead, store.fps);
    this.dur.textContent = timecode(store.duration, store.fps);
  }

  private layoutSafe() {
    const cv = this.renderer.canvas;
    if (cv.parentElement !== this.stage) return;
    const r = cv.getBoundingClientRect(), sr = this.stage.getBoundingClientRect();
    Object.assign(this.safe.style, { left: r.left - sr.left + r.width * 0.05 + "px", top: r.top - sr.top + r.height * 0.05 + "px", width: r.width * 0.9 + "px", height: r.height * 0.9 + "px" });
  }

  /** Drag in the viewer to move the selected clip; Shift-drag scales; Alt-drag rotates. */
  private bindDirectManipulation() {
    this.stage.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target !== this.renderer.canvas) return;
      const c = store.selectedClips().find((x) => store.project.tracks.find((t) => t.id === x.track)?.kind === "video");
      if (!c) return;
      const rect = this.renderer.canvas.getBoundingClientRect();
      const k = store.project.settings.width / rect.width;
      const lt = localTime(c);
      const x0 = prop(c, "transform.x", lt, c.transform?.x ?? 0), y0 = prop(c, "transform.y", lt, c.transform?.y ?? 0);
      const s0 = prop(c, "transform.scale", lt, c.transform?.scale ?? 1), r0 = prop(c, "transform.rotation", lt, c.transform?.rotation ?? 0);
      store.begin();
      drag(e, (dx, dy, ev) => {
        if (ev.shiftKey) writeProp(c, "transform.scale", Math.max(0.01, +(s0 * Math.pow(1.005, dx - dy)).toFixed(3)));
        else if (ev.altKey) writeProp(c, "transform.rotation", +(r0 + dx * 0.4).toFixed(1));
        else { writeProp(c, "transform.x", Math.round(x0 + dx * k)); writeProp(c, "transform.y", Math.round(y0 + dy * k)); }
        store.changed("inspector");
      });
    });
    this.stage.addEventListener("wheel", (e) => {
      if (!e.altKey) return;
      e.preventDefault();
      store.seek(frameSnap(store.playhead + Math.sign(e.deltaY) / store.fps, store.fps));
    }, { passive: false });
  }
}
