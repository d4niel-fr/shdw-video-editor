import { store } from "../store";
import { h, I, clear, slider } from "../ui/dom";
import { Timeline } from "../ui/timeline";
import { playback } from "../engine/playback";
import * as act from "../actions";

export class AudioPage {
  el: HTMLElement;
  private mixer: HTMLElement;
  private meters: { el: HTMLElement; id?: string; peak: number }[] = [];
  private raf = 0;

  constructor(private timeline: Timeline) {
    this.mixer = h("div", { class: "mixer" });
    this.el = h("div", { class: "page page-audio" },
      h("div", { class: "panel" }, h("header", {}, h("h3", {}, "Timeline"), h("div", { class: "grow" }),
        h("button", { class: "btn sm", onclick: () => act.addTrack("audio") }, I.plus(), "Audio track"),
        h("button", { class: "btn sm", onclick: () => store.emit("agent-prompt", "Mix the audio: balance dialogue vs music (duck the music under speech with volume keyframes), add short fades at every audio cut, and keep peaks below -1 dBFS.") }, I.spark(), "AI mix")),
        h("div", { class: "tl-slot", style: { display: "flex", flex: "1", minHeight: "0" } })),
      h("div", { class: "panel" }, h("header", {}, h("h3", {}, "Mixer")), this.mixer));
    store.on("project", (w) => { if (this.el.isConnected && w !== "drag" && w !== "inspector") this.renderMixer(); });
  }

  mount() {
    const slot = this.el.querySelector(".tl-slot") as HTMLElement;
    if (this.timeline.el.parentElement !== slot) slot.appendChild(this.timeline.el);
    this.renderMixer();
    cancelAnimationFrame(this.raf);
    const loop = () => {
      if (!this.el.isConnected || !this.el.classList.contains("on")) return;
      for (const m of this.meters) {
        const lv = store.playing ? playback.level(m.id) : 0;
        m.peak = Math.max(lv, m.peak * 0.92);
        (m.el.firstChild as HTMLElement).style.height = Math.min(100, m.peak * 100) + "%";
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private renderMixer() {
    clear(this.mixer);
    this.meters = [];
    const tracks = store.project.tracks.filter((t) => t.kind === "audio");
    for (const t of tracks) {
      const meter = h("div", { class: "meter" }, h("i", { style: { height: "0%" } }));
      this.meters.push({ el: meter, id: t.id, peak: 0 });
      const vol = h("input", { type: "range", class: "vfader", min: 0, max: 2, step: 0.01, value: t.volume ?? 1 }) as HTMLInputElement;
      const db = h("div", { class: "faint", style: { font: "10.5px var(--mono)" } }, toDb(t.volume ?? 1));
      vol.addEventListener("pointerdown", () => store.begin());
      vol.addEventListener("input", () => { t.volume = +vol.value; db.textContent = toDb(t.volume); playback.refreshBuses(); store.changed("inspector"); });
      vol.addEventListener("dblclick", () => { t.volume = 1; vol.value = "1"; db.textContent = toDb(1); playback.refreshBuses(); store.changed("inspector"); });
      const pan = slider(t.pan ?? 0, -1, 1, 0.01, (v) => { t.pan = v; playback.refreshBuses(); store.changed("inspector"); }, () => store.begin());
      pan.range.style.width = "76px";
      const btn = (label: string, key: "muted" | "solo", cls: string) => h("button", { class: `btn sm ${t[key] ? "on" : ""}`, style: t[key] ? { background: cls } : {}, onclick: () => { store.mutate(key, () => { t[key] = !t[key]; }); playback.refreshBuses(); } }, label);
      this.mixer.appendChild(h("div", { class: "strip-ch" },
        h("div", { class: "nm" }, t.name), h("div", { class: "faint", style: { fontSize: "10px" } }, "PAN"), pan.range,
        h("div", { class: "fader-wrap" }, meter, vol), db,
        h("div", { class: "row", style: { gap: "4px" } }, btn("M", "muted", "rgba(255,69,58,.35)"), btn("S", "solo", "rgba(255,214,10,.35)"))));
    }
    const mm = h("div", { class: "meter", style: { width: "12px" } }, h("i", { style: { height: "0%" } }));
    this.meters.push({ el: mm, peak: 0 });
    const mv = h("input", { type: "range", class: "vfader", min: 0, max: 2, step: 0.01, value: 1 }) as HTMLInputElement;
    mv.addEventListener("input", () => { if (playback.master) playback.master.gain.value = +mv.value; });
    this.mixer.appendChild(h("div", { class: "strip-ch master" }, h("div", { class: "nm" }, "Master"), h("div", { class: "fader-wrap" }, mm, mv), h("div", { class: "faint", style: { fontSize: "10px" } }, "BUS 1")));
  }
}
const toDb = (v: number) => (v <= 0.0001 ? "-∞ dB" : `${(20 * Math.log10(v)).toFixed(1)} dB`);
