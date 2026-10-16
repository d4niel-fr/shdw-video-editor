import { store } from "../store";
import { Clip, Key, prop, mediaOf, Track, frameSnap } from "../model";
import { h, clear, group, slider, switchEl, I } from "./dom";
import { EFFECTS, BLEND_NAMES, TRANSITIONS, TRANSITION_NAMES, ParamSpec } from "../engine/shaders";
import { getModule, defaultsOf, listModules } from "../engine/modules";
import { fontFamilies } from "../fonts";

// ---------- path get/set ----------
export function getBase(c: Clip, path: string): any {
  const [head, a, b] = path.split(".");
  const src: any = c.source;
  switch (head) {
    case "transform": return (c.transform as any)?.[a];
    case "effects": return c.effects?.[+a]?.params?.[b];
    case "params": return src.type === "motion" ? src.params?.[a] : src[a];
    case "grade": return (c.grade as any)?.[a];
    default: return (c as any)[head];
  }
}
export function setBase(c: Clip, path: string, v: any) {
  const [head, a, b] = path.split(".");
  const src: any = c.source;
  switch (head) {
    case "transform": (c.transform ??= {} as any)[a] = v; break;
    case "effects": { const e = c.effects?.[+a]; if (e) (e.params ??= {})[b] = v; break; }
    case "params": if (src.type === "motion") (src.params ??= {})[a] = v; else src[a] = v; break;
    case "grade": (c.grade ??= {} as any)[a] = v; break;
    default: (c as any)[head] = v;
  }
}
export function localTime(c: Clip) { return Math.max(0, Math.min(c.duration, frameSnap(store.playhead - c.start, store.fps))); }

/** Write a value: updates the key at the playhead if the property is animated, else the base value. */
export function writeProp(c: Clip, path: string, v: any) {
  const keys = c.keyframes?.[path];
  if (keys?.length) {
    const lt = localTime(c);
    const k = keys.find((k) => Math.abs(k.t - lt) < 0.5 / store.fps);
    if (k) k.v = v; else { keys.push({ t: lt, v, ease: "easeInOut" }); keys.sort((x, y) => x.t - y.t); }
  } else setBase(c, path, v);
}

export function toggleKey(c: Clip, path: string, fallback: any) {
  store.mutate("keyframe", () => {
    const lt = localTime(c);
    c.keyframes ??= {};
    const keys = (c.keyframes[path] ??= []);
    const i = keys.findIndex((k) => Math.abs(k.t - lt) < 0.5 / store.fps);
    if (i >= 0) keys.splice(i, 1);
    else { keys.push({ t: lt, v: prop(c, path, lt, getBase(c, path) ?? fallback), ease: "easeInOut" } as Key); keys.sort((a, b) => a.t - b.t); }
    if (!keys.length) delete c.keyframes[path];
  });
}

export class Inspector {
  el: HTMLElement;
  private body: HTMLElement;
  private live: (() => void)[] = [];
  private lastKey = "";

  constructor() {
    this.body = h("div", { class: "body insp" });
    this.el = h("div", { class: "panel" }, h("header", {}, h("h3", {}, "Inspector"), h("div", { class: "grow" })), this.body);
    store.on("selection", () => this.render());
    store.on("project", (why) => { if (why === "drag" || why === "trim" || why === "inspector") { this.refresh(); return; } this.render(); });
    store.on("time", () => this.refresh());
    store.on("modules", () => this.render());
    this.render();
  }

  private refresh() { for (const f of this.live) f(); }

  render() {
    const sel = store.selectedClips();
    const c = sel[0];
    const key = c ? c.id + JSON.stringify(c).length : "none";
    this.live = [];
    clear(this.body);
    if (!c) { this.projectPanel(); return; }
    this.lastKey = key;
    const p = store.project;
    const m = mediaOf(p, c);
    const track = p.tracks.find((t) => t.id === c.track);
    const isAudio = track?.kind === "audio";
    const src: any = c.source;

    this.body.append(h("div", { style: { padding: "10px 12px 6px" } },
      h("div", { style: { font: "600 14px var(--font-display)", letterSpacing: "-0.01em" } }, c.name ?? src.type),
      h("div", { class: "faint", style: { fontSize: "11px" } }, `${src.type}${m ? " · " + m.name : ""}${src.module ? " · " + src.module : ""} · ${c.id}`)));

    // clip
    this.body.append(group("Clip", [
      this.textField("Name", c.name ?? "", (v) => this.commit(() => { c.name = v; })),
      this.numBase(c, "Start", "start", 0, 36000, 1 / store.fps),
      this.numBase(c, "Duration", "duration", 1 / store.fps, 36000, 1 / store.fps),
      ...(src.type === "media" && m?.kind !== "image" ? [this.numBase(c, "Speed", "speed", 0.1, 16, 0.05, 1, (v) => {
        const old = c.speed ?? 1; c.duration = (c.duration * old) / v; c.speed = v;
      })] : []),
      this.fieldRow("Enabled", switchEl(c.enabled !== false, (v) => this.commit(() => { c.enabled = v; }))),
    ]));

    if (!isAudio && src.type !== "adjustment") {
      this.body.append(group("Transform", [
        this.num(c, "Position X", "transform.x", -4000, 4000, 1, 0),
        this.num(c, "Position Y", "transform.y", -4000, 4000, 1, 0),
        this.num(c, "Zoom", "transform.scale", 0, 8, 0.01, 1),
        this.num(c, "Scale X", "transform.scaleX", 0, 8, 0.01, 1),
        this.num(c, "Scale Y", "transform.scaleY", 0, 8, 0.01, 1),
        this.num(c, "Rotation", "transform.rotation", -720, 720, 0.1, 0),
        this.num(c, "Anchor X", "transform.anchorX", -1, 2, 0.01, 0.5),
        this.num(c, "Anchor Y", "transform.anchorY", -1, 2, 0.01, 0.5),
        this.fieldRow("Flip", h("div", { class: "row" },
          h("button", { class: "btn sm" + (c.transform?.flipH ? " on" : ""), onclick: () => this.commit(() => { (c.transform ??= {}).flipH = !c.transform.flipH; }) }, "Horizontal"),
          h("button", { class: "btn sm" + (c.transform?.flipV ? " on" : ""), onclick: () => this.commit(() => { (c.transform ??= {}).flipV = !c.transform.flipV; }) }, "Vertical"))),
      ]));
      this.body.append(group("Cropping", [
        this.num(c, "Left", "transform.cropLeft", 0, 1, 0.005, 0), this.num(c, "Right", "transform.cropRight", 0, 1, 0.005, 0),
        this.num(c, "Top", "transform.cropTop", 0, 1, 0.005, 0), this.num(c, "Bottom", "transform.cropBottom", 0, 1, 0.005, 0),
      ], true));
      this.body.append(group("Composite", [
        this.num(c, "Opacity", "opacity", 0, 1, 0.01, 1),
        this.blendSelect(c),
        this.numBase(c, "Fade in", "fadeIn", 0, 30, 0.05, 0),
        this.numBase(c, "Fade out", "fadeOut", 0, 30, 0.05, 0),
      ]));
    }

    if (isAudio || (src.type === "media" && m?.kind === "audio")) {
      this.body.append(group("Audio", [
        this.num(c, "Volume", "volume", 0, 2, 0.01, 1),
        this.numBase(c, "Pan", "pan", -1, 1, 0.01, 0),
        this.numBase(c, "Fade in", "audioFadeIn", 0, 30, 0.05, 0),
        this.numBase(c, "Fade out", "audioFadeOut", 0, 30, 0.05, 0),
      ]));
    }

    // source specific
    if (src.type === "text") this.body.append(group("Text", this.textControls(c)));
    if (src.type === "subtitle") this.body.append(group("Subtitle", [this.area(src.text, (v) => this.commit(() => { src.text = v; }))]));
    if (src.type === "solid") this.body.append(group("Color", [this.fieldRow("Color", this.color(src.color, (v) => this.commit(() => { src.color = v; })))]));
    if (src.type === "gradient") this.body.append(group("Gradient", [
      ...src.colors.map((col: string, i: number) => this.fieldRow(`Stop ${i + 1}`, h("div", { class: "row" }, this.color(col, (v) => this.commit(() => { src.colors[i] = v; })),
        src.colors.length > 2 ? h("button", { class: "btn icon sm ghost", onclick: () => this.commit(() => src.colors.splice(i, 1)) }, I.minus()) : null))),
      h("button", { class: "btn sm", onclick: () => this.commit(() => src.colors.push("#ffffff")) }, "Add stop"),
      this.num(c, "Angle", "params.angle", 0, 360, 1, 135),
      this.fieldRow("Radial", switchEl(!!src.radial, (v) => this.commit(() => { src.radial = v; }))),
    ]));
    if (src.type === "motion") this.body.append(group("Motion Graphic", this.motionControls(c), false,
      h("button", { class: "btn sm", onclick: () => store.emit("open-motion", c.id) }, I.code(), "Code")));

    // effects
    if (!isAudio) this.body.append(group("Effects", this.effectControls(c), false));
    if (!isAudio && src.type !== "adjustment") this.body.append(group("Transition In", this.transitionControls(c), !c.transition));
  }

  private commit(fn: () => void) { store.mutate("inspector-struct", fn); }

  // ---------- generic rows ----------
  private fieldRow(label: string, ctl: HTMLElement, after?: HTMLElement) {
    return h("div", { class: "field" }, h("label", { title: label }, label), h("div", { class: "ctl" }, ctl), after ?? h("span"));
  }
  private textField(label: string, value: string, onChange: (v: string) => void) {
    const i = h("input", { type: "text", value });
    i.addEventListener("change", () => onChange(i.value));
    return this.fieldRow(label, i);
  }
  private area(value: string, onChange: (v: string) => void) {
    const t = h("textarea", { rows: 3, style: { width: "100%", resize: "vertical" } }) as HTMLTextAreaElement;
    t.value = value ?? "";
    t.addEventListener("change", () => onChange(t.value));
    return t;
  }
  private color(value: string, onChange: (v: string) => void) {
    const i = h("input", { type: "color", value: toHex(value) });
    i.addEventListener("change", () => onChange(i.value));
    return i;
  }

  /** Animatable numeric property with keyframe toggle. */
  num(c: Clip, label: string, path: string, min: number, max: number, step: number, def: number) {
    const cur = () => prop(c, path, localTime(c), getBase(c, path) ?? def);
    const s = slider(cur(), min, max, step, (v) => { writeProp(c, path, v); store.changed("inspector"); }, () => store.begin());
    const kf = h("button", { class: "kf", title: "Keyframe" });
    const paintKf = () => {
      const keys = c.keyframes?.[path];
      kf.classList.toggle("has", !!keys?.length);
      kf.classList.toggle("on", !!keys?.some((k) => Math.abs(k.t - localTime(c)) < 0.5 / store.fps));
    };
    kf.addEventListener("click", () => toggleKey(c, path, def));
    paintKf();
    s.range.addEventListener("dblclick", () => { store.begin(); writeProp(c, path, def); s.set(def); store.changed("inspector"); });
    this.live.push(() => { if (document.activeElement !== s.num) s.set(cur()); paintKf(); });
    return this.fieldRow(label, h("div", { class: "row grow" }, s.range, s.num), kf);
  }

  /** Non-animatable numeric property on the clip root. */
  private numBase(c: Clip, label: string, key: string, min: number, max: number, step: number, def = 0, custom?: (v: number) => void) {
    const s = slider((c as any)[key] ?? def, min, max, step, (v) => { if (custom) custom(v); else (c as any)[key] = v; store.changed("inspector"); }, () => store.begin());
    this.live.push(() => { if (document.activeElement !== s.num) s.set((c as any)[key] ?? def); });
    return this.fieldRow(label, h("div", { class: "row grow" }, s.range, s.num));
  }

  private blendSelect(c: Clip) {
    const sel = h("select") as HTMLSelectElement;
    const fill = (custom: string[]) => {
      clear(sel);
      for (const n of BLEND_NAMES) sel.appendChild(h("option", { value: n, selected: (c.blend ?? "normal") === n }, n.replace(/([A-Z])/g, " $1").replace(/^./, (x) => x.toUpperCase())));
      for (const f of custom) sel.appendChild(h("option", { value: f, selected: c.blend === f }, "✦ " + f.split("/").pop()));
    };
    fill([]);
    void listModules("blends").then(fill);
    sel.addEventListener("change", () => this.commit(() => { c.blend = sel.value; }));
    return this.fieldRow("Blend", sel);
  }

  private textControls(c: Clip): HTMLElement[] {
    const s: any = c.source;
    const fonts = h("select") as HTMLSelectElement;
    for (const f of fontFamilies()) fonts.appendChild(h("option", { value: f, selected: (s.font ?? "Inter") === f }, f));
    fonts.addEventListener("change", () => this.commit(() => { s.font = fonts.value; }));
    const align = h("div", { class: "tabs" }, ...["left", "center", "right"].map((a) =>
      h("button", { class: (s.align ?? "center") === a ? "on" : "", onclick: () => this.commit(() => { s.align = a; }) }, a)));
    const anim = h("select") as HTMLSelectElement;
    for (const a of ["none", "fade", "fadeUp", "typewriter", "wordPop", "scaleIn", "blurIn", "slideLeft", "tracking"]) anim.appendChild(h("option", { value: a, selected: (s.animation ?? "none") === a }, a));
    anim.addEventListener("change", () => this.commit(() => { s.animation = anim.value; }));
    const weight = h("select") as HTMLSelectElement;
    for (const w of [100, 200, 300, 400, 500, 600, 700, 800, 900]) weight.appendChild(h("option", { value: w, selected: (s.weight ?? 700) === w }, String(w)));
    weight.addEventListener("change", () => this.commit(() => { s.weight = +weight.value; }));
    return [
      this.area(s.text, (v) => this.commit(() => { s.text = v; })),
      this.fieldRow("Font", fonts),
      this.fieldRow("Weight", weight),
      this.num(c, "Size", "params.size", 6, 800, 1, 96),
      this.num(c, "Tracking", "params.tracking", -0.2, 1, 0.005, 0),
      this.numBaseSrc(s, "Line height", "lineHeight", 0.6, 3, 0.01, 1.15),
      this.fieldRow("Color", this.color(s.color ?? "#ffffff", (v) => this.commit(() => { s.color = v; }))),
      this.fieldRow("Align", align),
      this.fieldRow("Animation", anim),
      this.numBaseSrc(s, "Anim time", "animDuration", 0.05, 5, 0.05, 0.6),
      this.fieldRow("Stroke", h("div", { class: "row" }, this.color(s.stroke?.color ?? "#000000", (v) => this.commit(() => { s.stroke = { width: s.stroke?.width ?? 4, color: v }; })),
        h("input", { type: "number", value: s.stroke?.width ?? 0, min: 0, max: 60, style: { width: "56px" }, onchange: (e: any) => this.commit(() => { const w = +e.target.value; s.stroke = w ? { color: s.stroke?.color ?? "#000", width: w } : undefined; }) }))),
      this.fieldRow("Shadow", h("div", { class: "row" }, this.color(s.shadow?.color ?? "#000000", (v) => this.commit(() => { s.shadow = { blur: s.shadow?.blur ?? 20, color: v, y: 6 }; })),
        h("input", { type: "number", value: s.shadow?.blur ?? 0, min: 0, max: 200, style: { width: "56px" }, onchange: (e: any) => this.commit(() => { const b = +e.target.value; s.shadow = b ? { color: s.shadow?.color ?? "rgba(0,0,0,0.6)", blur: b, y: 6 } : undefined; }) }))),
      this.fieldRow("Background", h("div", { class: "row" }, switchEl(!!s.background, (v) => this.commit(() => { s.background = v ? { color: "rgba(0,0,0,0.6)", padding: 24, radius: 16 } : undefined; })),
        s.background ? this.color(s.background.color, (v) => this.commit(() => { s.background.color = v; })) : null)),
    ];
  }
  private numBaseSrc(s: any, label: string, key: string, min: number, max: number, step: number, def: number) {
    const sl = slider(s[key] ?? def, min, max, step, (v) => { s[key] = v; store.changed("inspector"); }, () => store.begin());
    return this.fieldRow(label, h("div", { class: "row grow" }, sl.range, sl.num));
  }

  private motionControls(c: Clip): HTMLElement[] {
    const s: any = c.source;
    const mod = getModule(s.module);
    if (!mod) return [h("div", { class: "faint" }, `Loading ${s.module}…`)];
    const out: HTMLElement[] = [];
    const specs = mod.params ?? {};
    const vals = { ...defaultsOf(specs), ...(s.params ?? {}) };
    for (const [k, spec] of Object.entries(specs)) out.push(this.paramControl(c, `params.${k}`, k, spec, vals[k]));
    if (!out.length) out.push(h("div", { class: "faint" }, "This module has no parameters."));
    return out;
  }

  private paramControl(c: Clip, path: string, label: string, spec: ParamSpec, value: any) {
    const nice = label.replace(/([A-Z])/g, " $1").replace(/^./, (x) => x.toUpperCase());
    if (spec.type === "number") return this.num(c, nice, path, spec.min ?? 0, spec.max ?? Math.max(1, (spec.default ?? 1) * 4), spec.step ?? ((spec.max ?? 1) - (spec.min ?? 0) > 20 ? 1 : 0.01), spec.default ?? 0);
    if (spec.type === "color") return this.fieldRow(nice, this.color(value ?? spec.default, (v) => this.commit(() => writeProp(c, path, v))));
    if (spec.type === "bool") return this.fieldRow(nice, switchEl(!!value, (v) => this.commit(() => writeProp(c, path, v))));
    if (spec.type === "select") {
      const sel = h("select") as HTMLSelectElement;
      for (const o of spec.options ?? []) sel.appendChild(h("option", { value: o, selected: o === value }, o));
      sel.addEventListener("change", () => this.commit(() => writeProp(c, path, sel.value)));
      return this.fieldRow(nice, sel);
    }
    const t = h("input", { type: "text", value: value ?? "" });
    t.addEventListener("change", () => this.commit(() => writeProp(c, path, t.value)));
    return this.fieldRow(nice, t);
  }

  private effectControls(c: Clip): HTMLElement[] {
    const out: HTMLElement[] = [];
    (c.effects ?? []).forEach((e, i) => {
      const builtin = EFFECTS[e.type];
      const mod = builtin ? null : getModule(e.type);
      const specs: Record<string, ParamSpec> = builtin?.params ?? mod?.params ?? {};
      const card = h("div", { class: "fxcard" },
        h("div", { class: "fxh" }, switchEl(e.enabled !== false, (v) => this.commit(() => { e.enabled = v; })),
          h("span", { class: "grow" }, builtin?.name ?? mod?.name ?? e.type),
          i > 0 ? h("button", { class: "btn icon sm ghost", title: "Move up", onclick: () => this.commit(() => { const a = c.effects!; [a[i - 1], a[i]] = [a[i], a[i - 1]]; }) }, "↑") : null,
          h("button", { class: "btn icon sm ghost", title: "Remove", onclick: () => this.commit(() => { c.effects!.splice(i, 1); }) }, I.x())),
        ...Object.entries(specs).map(([k, sp]) => this.paramControl(c, `effects.${i}.${k}`, k, sp, e.params?.[k] ?? sp.default)));
      out.push(card);
    });
    const add = h("select") as HTMLSelectElement;
    add.appendChild(h("option", { value: "" }, "+ Add effect…"));
    for (const [k, v] of Object.entries(EFFECTS)) add.appendChild(h("option", { value: k }, v.name));
    void listModules("effects").then((fx) => fx.forEach((f) => add.appendChild(h("option", { value: f }, "✦ " + f.split("/").pop()))));
    add.addEventListener("change", () => {
      if (!add.value) return;
      const type = add.value;
      const specs = EFFECTS[type]?.params ?? getModule(type)?.params;
      this.commit(() => { c.effects = [...(c.effects ?? []), { type, params: defaultsOf(specs) }]; });
    });
    out.push(add);
    return out;
  }

  private transitionControls(c: Clip): HTMLElement[] {
    const sel = h("select") as HTMLSelectElement;
    sel.appendChild(h("option", { value: "" }, "None"));
    for (const n of TRANSITION_NAMES) sel.appendChild(h("option", { value: n, selected: c.transition?.type === n }, TRANSITIONS[n].name));
    void listModules("transitions").then((tr) => tr.forEach((f) => sel.appendChild(h("option", { value: f, selected: c.transition?.type === f }, "✦ " + f.split("/").pop()))));
    sel.addEventListener("change", () => this.commit(() => { c.transition = sel.value ? { type: sel.value, duration: c.transition?.duration ?? 0.6 } : undefined; }));
    const out = [this.fieldRow("Type", sel)];
    if (c.transition) {
      const s = slider(c.transition.duration, 1 / store.fps, Math.max(0.1, Math.min(10, c.duration)), 1 / store.fps, (v) => { c.transition!.duration = v; store.changed("inspector"); }, () => store.begin());
      out.push(this.fieldRow("Duration", h("div", { class: "row grow" }, s.range, s.num)));
    }
    out.push(h("div", { class: "faint", style: { fontSize: "11px" } }, "Plays from the clip that ends where this one starts on the same track."));
    return out;
  }

  // ---------- no selection: project + track settings ----------
  private projectPanel() {
    const p = store.project;
    const s = p.settings;
    const res = h("select") as HTMLSelectElement;
    const presets: [string, number, number][] = [["3840×2160 4K UHD", 3840, 2160], ["2560×1440 QHD", 2560, 1440], ["1920×1080 HD", 1920, 1080], ["1280×720 HD", 1280, 720],
      ["1080×1920 Vertical", 1080, 1920], ["1080×1350 Portrait 4:5", 1080, 1350], ["1080×1080 Square", 1080, 1080], ["2048×858 Cinema Scope", 2048, 858]];
    let matched = false;
    for (const [n, w, hh] of presets) { const on = s.width === w && s.height === hh; matched ||= on; res.appendChild(h("option", { value: `${w}x${hh}`, selected: on }, n)); }
    if (!matched) res.appendChild(h("option", { value: `${s.width}x${s.height}`, selected: true }, `${s.width}×${s.height} Custom`));
    res.addEventListener("change", () => { const [w, hh] = res.value.split("x").map(Number); this.commit(() => { s.width = w; s.height = hh; }); });
    const fps = h("select") as HTMLSelectElement;
    for (const f of [23.976, 24, 25, 29.97, 30, 50, 59.94, 60]) fps.appendChild(h("option", { value: f, selected: s.fps === f }, String(f)));
    fps.addEventListener("change", () => this.commit(() => { s.fps = +fps.value; }));
    this.body.append(h("div", { style: { padding: "10px 12px 6px" } },
      h("div", { style: { font: "600 14px var(--font-display)" } }, p.name), h("div", { class: "faint", style: { fontSize: "11px" } }, "No clip selected — project settings")));
    this.body.append(group("Timeline", [
      this.textField("Name", p.name, (v) => this.commit(() => { p.name = v; })),
      this.fieldRow("Resolution", res), this.fieldRow("Frame rate", fps),
      this.fieldRow("Background", this.color(s.background, (v) => this.commit(() => { s.background = v; }))),
      h("div", { class: "faint", style: { fontSize: "11px" } }, `${p.clips.length} clips · ${p.media.length} media · duration ${store.duration.toFixed(2)}s`),
    ]));
    for (const t of p.tracks.filter((t) => t.kind === "subtitle")) this.body.append(group(`Subtitle style — ${t.name}`, this.subStyle(t), true));
  }

  private subStyle(t: Track): HTMLElement[] {
    const st = (t.style ??= {});
    const fonts = h("select") as HTMLSelectElement;
    for (const f of fontFamilies()) fonts.appendChild(h("option", { value: f, selected: (st.font ?? "Inter") === f }, f));
    fonts.addEventListener("change", () => this.commit(() => { st.font = fonts.value; }));
    const n = (label: string, key: keyof typeof st, min: number, max: number, step: number, def: number) => {
      const s = slider((st as any)[key] ?? def, min, max, step, (v) => { (st as any)[key] = v; store.changed("inspector"); }, () => store.begin());
      return this.fieldRow(label, h("div", { class: "row grow" }, s.range, s.num));
    };
    return [this.fieldRow("Font", fonts), n("Size", "size", 12, 200, 1, 54), n("Weight", "weight", 100, 900, 100, 600), n("Position Y", "y", 0, 1, 0.01, 0.88),
      this.fieldRow("Color", this.color(st.color ?? "#fff", (v) => this.commit(() => { st.color = v; }))),
      this.fieldRow("Box", switchEl(!!st.background, (v) => this.commit(() => { st.background = v ? { color: "rgba(0,0,0,0.55)", padding: 14, radius: 10 } : undefined; })))];
  }
}

function toHex(c: string) {
  if (!c) return "#000000";
  if (c.startsWith("#")) return c.length === 4 ? "#" + c.slice(1).split("").map((x) => x + x).join("") : c.slice(0, 7);
  const m = c.match(/\d+/g);
  return m ? "#" + m.slice(0, 3).map((v) => (+v).toString(16).padStart(2, "0")).join("") : "#000000";
}
