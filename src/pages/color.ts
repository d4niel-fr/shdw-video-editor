import { store } from "../store";
import { h, I, clear, slider, drag } from "../ui/dom";
import { Viewer } from "../ui/viewer";
import { Clip, Grade, clipEnd, mediaOf, deepClone } from "../model";
import { thumbUrl } from "../media";
import { fs, join } from "../ipc";

const WHEELS: { key: "lift" | "gamma" | "gain" | "offset"; label: string; range: number }[] = [
  { key: "lift", label: "Lift", range: 0.5 }, { key: "gamma", label: "Gamma", range: 0.5 }, { key: "gain", label: "Gain", range: 1 }, { key: "offset", label: "Offset", range: 0.4 },
];

let gradeClipboard: Grade | null = null;

export class ColorPage {
  el: HTMLElement;
  private strip: HTMLElement;
  private wheels: HTMLElement;
  private scopeCv: HTMLCanvasElement;
  private scopeMode = "waveform";
  private lastScope = 0;
  private sample = document.createElement("canvas");

  constructor(private viewer: Viewer) {
    this.strip = h("div", { class: "strip" });
    this.wheels = h("div", { class: "wheels" });
    this.scopeCv = h("canvas", { width: 640, height: 400 });
    const tabs = h("div", { class: "tabs" });
    const paintTabs = () => { clear(tabs); for (const m of ["waveform", "parade", "vectorscope", "histogram"]) tabs.appendChild(h("button", { class: this.scopeMode === m ? "on" : "", onclick: () => { this.scopeMode = m; paintTabs(); this.drawScope(true); } }, m[0].toUpperCase() + m.slice(1))); };
    paintTabs();
    this.el = h("div", { class: "page page-color" },
      h("div", { class: "p-viewer", style: { display: "flex", minHeight: "0" } }),
      h("div", { class: "panel p-scopes scopes" }, h("header", {}, h("h3", {}, "Scopes"), h("div", { class: "grow" }), tabs), h("div", { style: { padding: "8px" } }, this.scopeCv)),
      h("div", { class: "panel p-strip" }, this.strip),
      h("div", { class: "panel p-wheels" }, h("header", {}, h("h3", {}, "Primaries"), h("div", { class: "grow" }),
        h("button", { class: "btn sm", onclick: () => this.copyGrade() }, "Copy grade"),
        h("button", { class: "btn sm", onclick: () => this.pasteGrade() }, "Paste grade"),
        h("button", { class: "btn sm", onclick: () => this.applyAll() }, "Apply to all"),
        h("button", { class: "btn sm danger", onclick: () => this.reset() }, "Reset"),
        h("button", { class: "btn sm primary", onclick: () => this.aiGrade() }, I.spark(), "AI grade")), this.wheels));
    store.on("selection", () => this.el.isConnected && this.render());
    store.on("project", (w) => { if (this.el.isConnected && w !== "inspector" && w !== "color") this.render(); });
    store.on("rendered", () => this.el.isConnected && this.drawScope());
  }

  mount() {
    const slot = this.el.querySelector(".p-viewer") as HTMLElement;
    if (this.viewer.el.parentElement !== slot) slot.appendChild(this.viewer.el);
    this.viewer.el.style.flex = "1";
    this.viewer.mount();
    if (!this.current()) {
      const first = this.gradable().find((c) => store.playhead >= c.start && store.playhead < clipEnd(c)) ?? this.gradable()[0];
      if (first) store.select([first.id]);
    }
    this.render();
  }

  private gradable() {
    return store.project.clips.filter((c) => store.project.tracks.find((t) => t.id === c.track)?.kind === "video").sort((a, b) => a.start - b.start);
  }
  private current(): Clip | undefined { return store.selectedClips().find((c) => store.project.tracks.find((t) => t.id === c.track)?.kind === "video"); }

  render() {
    clear(this.strip);
    for (const c of this.gradable()) {
      const m = mediaOf(store.project, c);
      const u = m?.kind === "video" ? thumbUrl(m, (c.source as any).in ?? 0) : null;
      this.strip.appendChild(h("div", { class: "sc" + (store.selection.has(c.id) ? " sel" : ""), onclick: () => { store.select([c.id]); store.seek(c.start + Math.min(c.duration / 2, 1)); } },
        h("div", { class: "im", style: u ? { backgroundImage: `url("${u}")` } : { background: c.source.type === "motion" ? "linear-gradient(135deg,#8e44e8,#22113a)" : "#2a2a30" } }),
        c.grade && Object.keys(c.grade).length ? h("div", { class: "graded" }) : null,
        h("small", {}, c.name ?? c.source.type)));
    }
    clear(this.wheels);
    const c = this.current();
    if (!c) { this.wheels.appendChild(h("div", { class: "empty" }, "Select a video clip to grade.")); return; }
    const g: Grade = c.grade ?? {};
    const touch = () => { if (!c.grade) c.grade = g; };
    for (const w of WHEELS) this.wheels.appendChild(this.wheel(c, g, touch, w.key, w.label, w.range));
    const prim = h("div", { class: "prims" });
    const row = (label: string, key: keyof Grade, min: number, max: number, step: number, def: number) => {
      const s = slider((g as any)[key] ?? def, min, max, step, (v) => { touch(); (g as any)[key] = v; store.changed("color"); }, () => store.begin());
      s.range.addEventListener("dblclick", () => { (g as any)[key] = def; s.set(def); store.changed("color"); });
      return h("div", { class: "field" }, h("label", {}, label), h("div", { class: "ctl" }, s.range, s.num), h("span"));
    };
    prim.append(row("Exposure", "exposure", -4, 4, 0.01, 0), row("Contrast", "contrast", 0, 2.5, 0.01, 1), row("Pivot", "pivot", 0, 1, 0.005, 0.435),
      row("Saturation", "saturation", 0, 3, 0.01, 1), row("Vibrance", "vibrance", -1, 1, 0.01, 0), row("Temperature", "temperature", -1, 1, 0.01, 0),
      row("Tint", "tint", -1, 1, 0.01, 0), row("Hue", "hue", -180, 180, 0.5, 0), row("Highlights", "highlights", -1, 1, 0.01, 0), row("Shadows", "shadows", -1, 1, 0.01, 0));
    const lut = h("select", { style: { width: "100%" } }) as HTMLSelectElement;
    lut.appendChild(h("option", { value: "" }, "No LUT"));
    void fs.list(join(store.dir, "luts")).then((es) => es.filter((e) => e.name.toLowerCase().endsWith(".cube")).forEach((e) => lut.appendChild(h("option", { value: `luts/${e.name}`, selected: g.lut === `luts/${e.name}` }, e.name)))).catch(() => {});
    lut.addEventListener("change", () => { store.mutate("lut", () => { touch(); g.lut = lut.value || undefined; }); });
    prim.append(h("div", { class: "field" }, h("label", {}, "LUT"), h("div", { class: "ctl" }, lut), h("span")), row("LUT mix", "lutMix", 0, 1, 0.01, 1));
    this.wheels.appendChild(prim);
  }

  private wheel(c: Clip, g: Grade, touch: () => void, key: "lift" | "gamma" | "gain" | "offset", label: string, range: number) {
    const size = 150, R = 66;
    const cv = h("canvas", { width: size * 2, height: size * 2 });
    const vals = h("div", { class: "vals" });
    const get = () => (g[key] ?? [0, 0, 0]) as number[];
    const paint = () => {
      const ctx = cv.getContext("2d")!;
      ctx.setTransform(2, 0, 0, 2, 0, 0);
      ctx.clearRect(0, 0, size, size);
      const cx = size / 2, cy = size / 2;
      const grad = (ctx as any).createConicGradient ? (ctx as any).createConicGradient(-Math.PI / 2 + Math.PI / 2, cx, cy) : null;
      if (grad) { ["#ff4040", "#ffff40", "#40ff40", "#40ffff", "#4040ff", "#ff40ff", "#ff4040"].forEach((col, i) => grad.addColorStop(i / 6, col)); ctx.fillStyle = grad; }
      ctx.globalAlpha = 0.55; ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
      const rg = ctx.createRadialGradient(cx, cy, 0, cx, cy, R); rg.addColorStop(0, "rgba(40,40,44,1)"); rg.addColorStop(1, "rgba(40,40,44,0)");
      ctx.globalAlpha = 1; ctx.fillStyle = rg; ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.15)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx - 6, cy); ctx.lineTo(cx + 6, cy); ctx.moveTo(cx, cy - 6); ctx.lineTo(cx, cy + 6); ctx.stroke();
      const v = get(); const mean = (v[0] + v[1] + v[2]) / 3;
      const cr = v[0] - mean, cg = v[1] - mean, cb = v[2] - mean;
      const x = 1.5 * cr, y = ((cg - cb) * Math.sqrt(3)) / 2;
      const px = cx + (x / range) * R, py = cy - (y / range) * R;
      ctx.fillStyle = "#fff"; ctx.shadowColor = "rgba(0,0,0,0.6)"; ctx.shadowBlur = 4;
      ctx.beginPath(); ctx.arc(px, py, 5, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
      vals.textContent = v.map((n) => (n >= 0 ? "+" : "") + n.toFixed(2)).join("  ");
    };
    const setFrom = (px: number, py: number) => {
      let x = ((px - size / 2) / R) * range, y = (-(py - size / 2) / R) * range;
      const mag = Math.hypot(x, y); if (mag > range) { x *= range / mag; y *= range / mag; }
      const v = get(); const mean = (v[0] + v[1] + v[2]) / 3;
      touch();
      g[key] = [mean + (2 * x) / 3, mean - x / 3 + y / Math.sqrt(3), mean - x / 3 - y / Math.sqrt(3)].map((n) => +n.toFixed(4));
      paint(); store.changed("color");
    };
    cv.addEventListener("pointerdown", (e) => {
      store.begin();
      const r = cv.getBoundingClientRect();
      const k = size / r.width;
      setFrom((e.clientX - r.left) * k, (e.clientY - r.top) * k);
      drag(e, (_dx, _dy, ev) => setFrom((ev.clientX - r.left) * k, (ev.clientY - r.top) * k));
    });
    cv.addEventListener("dblclick", () => { store.begin(); touch(); g[key] = [0, 0, 0]; paint(); store.changed("color"); this.render(); });
    const v0 = get();
    const master = slider((v0[0] + v0[1] + v0[2]) / 3, -range, range, 0.005, (m) => {
      touch(); const v = get(); const mean = (v[0] + v[1] + v[2]) / 3; g[key] = v.map((n) => +(n - mean + m).toFixed(4)); paint(); store.changed("color");
    }, () => store.begin());
    paint();
    return h("div", { class: "wheel" }, h("div", { class: "lbl" }, label), cv, master.range, vals);
  }

  private copyGrade() { const c = this.current(); if (c?.grade) { gradeClipboard = deepClone(c.grade); store.emit("toast", "Grade copied"); } }
  private pasteGrade() { const c = this.current(); if (c && gradeClipboard) store.mutate("paste grade", () => { c.grade = deepClone(gradeClipboard!); }); }
  private applyAll() { const c = this.current(); if (!c?.grade) return; const g = c.grade; store.mutate("grade all", () => { for (const x of this.gradable()) if (x.source.type === "media") x.grade = deepClone(g); }); }
  private reset() { const c = this.current(); if (c) store.mutate("reset grade", () => { delete c.grade; }); }
  private aiGrade() {
    const c = this.current();
    store.emit("agent-prompt", c ? `Color grade clip ${c.id} (${c.name}). Look at the frame first via the control API (/frame), then set its "grade" in project.shdw.json for a cinematic, balanced look; if there are references in inspo/, match them. Render a frame after to check.` : "Color grade all clips for a consistent cinematic look.");
  }

  // ---------- scopes ----------
  drawScope(force = false) {
    const now = performance.now();
    if (!force && now - this.lastScope < 90) return;
    this.lastScope = now;
    const src = this.viewer.renderer.canvas;
    const sw = 256, sh = Math.max(1, Math.round((256 * src.height) / Math.max(1, src.width)));
    this.sample.width = sw; this.sample.height = sh;
    const sctx = this.sample.getContext("2d", { willReadFrequently: true })!;
    sctx.drawImage(src, 0, 0, sw, sh);
    const px = sctx.getImageData(0, 0, sw, sh).data;
    const W = this.scopeCv.width, H = this.scopeCv.height;
    const g = this.scopeCv.getContext("2d")!;
    g.fillStyle = "#050506"; g.fillRect(0, 0, W, H);
    g.strokeStyle = "rgba(255,255,255,0.07)"; g.lineWidth = 1;
    const img = g.getImageData(0, 0, W, H);
    const d = img.data;
    const plot = (x: number, y: number, r: number, gg: number, b: number) => {
      if (x < 0 || y < 0 || x >= W || y >= H) return;
      const i = ((y | 0) * W + (x | 0)) * 4;
      d[i] = Math.min(255, d[i] + r); d[i + 1] = Math.min(255, d[i + 1] + gg); d[i + 2] = Math.min(255, d[i + 2] + b); d[i + 3] = 255;
    };
    if (this.scopeMode === "waveform" || this.scopeMode === "parade") {
      for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
        const i = (y * sw + x) * 4; const r = px[i], gg = px[i + 1], b = px[i + 2];
        if (this.scopeMode === "waveform") {
          const l = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
          plot((x / sw) * W, H - 10 - (l / 255) * (H - 20), 18, 30, 18);
        } else {
          const third = W / 3;
          plot((x / sw) * third, H - 10 - (r / 255) * (H - 20), 40, 6, 6);
          plot(third + (x / sw) * third, H - 10 - (gg / 255) * (H - 20), 6, 40, 6);
          plot(2 * third + (x / sw) * third, H - 10 - (b / 255) * (H - 20), 8, 8, 44);
        }
      }
      g.putImageData(img, 0, 0);
      g.fillStyle = "rgba(255,255,255,0.25)"; g.font = "10px monospace";
      for (const v of [0, 256, 512, 768, 1023]) { const y = H - 10 - (v / 1023) * (H - 20); g.fillRect(0, y, W, 0.5); g.fillText(String(v), 4, y - 2); }
    } else if (this.scopeMode === "vectorscope") {
      const cx = W / 2, cy = H / 2, R = Math.min(W, H) * 0.45;
      for (let i = 0; i < px.length; i += 4) {
        const r = px[i] / 255, gg = px[i + 1] / 255, b = px[i + 2] / 255;
        const u = -0.169 * r - 0.331 * gg + 0.5 * b, v = 0.5 * r - 0.419 * gg - 0.081 * b;
        plot(cx + u * R * 2, cy - v * R * 2, 30 * r + 8, 30 * gg + 8, 30 * b + 8);
      }
      g.putImageData(img, 0, 0);
      g.strokeStyle = "rgba(255,255,255,0.18)"; g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.stroke();
      g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx - R * 0.65, cy - R * 0.8); g.stroke(); // skin tone line
      g.fillStyle = "rgba(255,255,255,0.35)"; g.font = "10px system-ui";
      for (const [n, r, gg, b] of [["R", 1, 0, 0], ["Y", 1, 1, 0], ["G", 0, 1, 0], ["C", 0, 1, 1], ["B", 0, 0, 1], ["M", 1, 0, 1]] as [string, number, number, number][]) {
        const u = -0.169 * r - 0.331 * gg + 0.5 * b, v = 0.5 * r - 0.419 * gg - 0.081 * b;
        g.fillText(n, cx + u * R * 2 * 0.75 - 3, cy - v * R * 2 * 0.75 + 3);
      }
    } else {
      const bins = [new Array(256).fill(0), new Array(256).fill(0), new Array(256).fill(0)];
      for (let i = 0; i < px.length; i += 4) { bins[0][px[i]]++; bins[1][px[i + 1]]++; bins[2][px[i + 2]]++; }
      const max = Math.max(...bins.flat().slice(1, 255)) || 1;
      g.globalCompositeOperation = "lighter";
      ["rgba(255,60,60,0.55)", "rgba(60,255,60,0.55)", "rgba(80,120,255,0.6)"].forEach((col, k) => {
        g.fillStyle = col; g.beginPath(); g.moveTo(0, H);
        for (let i = 0; i < 256; i++) g.lineTo((i / 255) * W, H - Math.min(1, bins[k][i] / max) * (H - 10));
        g.lineTo(W, H); g.fill();
      });
      g.globalCompositeOperation = "source-over";
    }
  }
}
