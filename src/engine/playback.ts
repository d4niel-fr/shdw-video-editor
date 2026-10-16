// Transport: wall-clock driven playhead, video element sync, and a WebAudio
// mixer (clip gain/fades → track gain/pan → master) with level meters.

import { store } from "../store";
import { Clip, clipEnd, mediaOf, prop, Track } from "../model";
import { pool, videoSourceTime } from "./sources";
import { mediaUrl } from "../ipc";

interface ANode { el: HTMLAudioElement; src: MediaElementAudioSourceNode; gain: GainNode; pan: StereoPannerNode; track: string; srcUrl: string }
interface TBus { gain: GainNode; pan: StereoPannerNode; analyser: AnalyserNode }

class Playback {
  ctx: AudioContext | null = null;
  master!: GainNode;
  masterAnalyser!: AnalyserNode;
  buses = new Map<string, TBus>();
  private nodes = new Map<string, ANode>();
  private raf = 0;
  private wall0 = 0;
  private t0 = 0;
  rate = 1;
  onFrame: () => void = () => {};

  private ensureAudio() {
    if (this.ctx) return;
    this.ctx = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
    this.master = this.ctx.createGain();
    this.masterAnalyser = this.ctx.createAnalyser();
    this.masterAnalyser.fftSize = 2048;
    this.master.connect(this.masterAnalyser).connect(this.ctx.destination);
  }

  bus(track: Track): TBus {
    this.ensureAudio();
    let b = this.buses.get(track.id);
    if (!b) {
      const ctx = this.ctx!;
      b = { gain: ctx.createGain(), pan: ctx.createStereoPanner(), analyser: ctx.createAnalyser() };
      b.analyser.fftSize = 1024;
      b.gain.connect(b.pan).connect(b.analyser).connect(this.master);
      this.buses.set(track.id, b);
    }
    const p = store.project;
    const anySolo = p.tracks.some((t) => t.kind === "audio" && t.solo);
    const audible = !track.muted && (!anySolo || track.solo);
    b.gain.gain.value = audible ? (track.volume ?? 1) : 0;
    b.pan.pan.value = track.pan ?? 0;
    return b;
  }

  get playing() { return store.playing; }

  toggle() { store.playing ? this.pause() : this.play(); }

  play(rate = 1) {
    this.ensureAudio();
    void this.ctx!.resume();
    this.rate = rate;
    const end = this.endTime();
    if (store.playhead >= end - 1 / store.fps) store.seek(store.inPoint ?? 0);
    store.playing = true;
    this.wall0 = performance.now();
    this.t0 = store.playhead;
    store.emit("transport");
    cancelAnimationFrame(this.raf);
    const tick = () => {
      if (!store.playing) return;
      let t = this.t0 + ((performance.now() - this.wall0) / 1000) * this.rate;
      const end = this.endTime();
      const start = store.inPoint ?? 0;
      if (this.rate > 0 && t >= end) {
        if (store.loopPlayback) { this.t0 = start; this.wall0 = performance.now(); t = start; }
        else { store.playhead = end; this.pause(); return; }
      }
      if (this.rate < 0 && t <= 0) { store.playhead = 0; this.pause(); return; }
      store.playhead = t;
      this.sync(t);
      store.emit("time");
      this.onFrame();
      this.raf = requestAnimationFrame(tick);
    };
    this.sync(store.playhead);
    this.raf = requestAnimationFrame(tick);
  }

  endTime() {
    return store.outPoint ?? Math.max(store.duration, 0.04);
  }

  pause() {
    store.playing = false;
    cancelAnimationFrame(this.raf);
    pool.pauseAll();
    for (const n of this.nodes.values()) n.el.pause();
    store.playhead = Math.round(store.playhead * store.fps) / store.fps;
    store.emit("transport");
    store.emit("time");
  }

  /** J/K/L shuttle */
  shuttle(dir: number) {
    if (dir === 0) { this.pause(); return; }
    const cur = store.playing ? this.rate : 0;
    let next = dir > 0 ? (cur > 0 ? Math.min(cur * 2, 8) : 1) : (cur < 0 ? Math.max(cur * 2, -8) : -1);
    this.pause();
    this.play(next);
  }

  /** Keep media elements in step with the timeline clock. */
  private sync(t: number) {
    const p = store.project;
    const media = this.rate > 0 && this.rate <= 4;
    const activeVideo = new Set<string>();
    for (const c of p.clips) {
      if (c.enabled === false || t < c.start || t >= clipEnd(c)) continue;
      const m = mediaOf(p, c);
      if (!m) continue;
      const track = p.tracks.find((tr) => tr.id === c.track);
      if (!track) continue;
      const lt = t - c.start;
      const want = videoSourceTime(c, lt, m);
      if (track.kind === "video" && m.kind === "video") {
        activeVideo.add(c.id);
        const el = pool.video(c, m);
        if (!media) continue;
        const r = (c.speed ?? 1) * this.rate;
        if (Math.abs(el.playbackRate - r) > 1e-3) el.playbackRate = Math.min(16, Math.max(0.0625, r));
        if (el.paused) { el.currentTime = want; void el.play().catch(() => {}); }
        else if (Math.abs(el.currentTime - want) > 0.2) el.currentTime = want;
      } else if (track.kind === "audio" && (m.kind === "audio" || m.hasAudio !== false)) {
        this.syncAudio(c, track, store.abs(m.path), want, lt, media);
      }
    }
    for (const [id, e] of pool.entries()) if (!activeVideo.has(id) && !e.el.paused) e.el.pause();
    for (const [id, n] of this.nodes) {
      const c = store.clip(id);
      if (!c || t < c.start || t >= clipEnd(c) || c.enabled === false) { if (!n.el.paused) n.el.pause(); }
    }
  }

  private syncAudio(c: Clip, track: Track, path: string, want: number, lt: number, media: boolean) {
    this.ensureAudio();
    const url = mediaUrl(path);
    let n = this.nodes.get(c.id);
    if (n && n.srcUrl !== url) { n.el.pause(); n.src.disconnect(); this.nodes.delete(c.id); n = undefined; }
    if (!n) {
      const el = new Audio();
      el.crossOrigin = "anonymous";
      el.preload = "auto";
      el.src = url;
      const src = this.ctx!.createMediaElementSource(el);
      const gain = this.ctx!.createGain();
      const pan = this.ctx!.createStereoPanner();
      src.connect(gain).connect(pan);
      n = { el, src, gain, pan, track: track.id, srcUrl: url };
      this.nodes.set(c.id, n);
    }
    const bus = this.bus(track);
    if (n.track !== track.id) { n.pan.disconnect(); n.track = track.id; }
    try { n.pan.connect(bus.gain); } catch { /* already connected */ }
    let g = prop(c, "volume", lt, c.volume ?? 1);
    if (c.audioFadeIn) g *= Math.min(1, lt / c.audioFadeIn);
    if (c.audioFadeOut) g *= Math.min(1, (c.duration - lt) / c.audioFadeOut);
    n.gain.gain.value = Math.max(0, g);
    n.pan.pan.value = c.pan ?? 0;
    if (!media) { if (!n.el.paused) n.el.pause(); return; }
    const r = (c.speed ?? 1) * this.rate;
    if (Math.abs(n.el.playbackRate - r) > 1e-3) n.el.playbackRate = Math.min(16, Math.max(0.0625, r));
    if (n.el.paused) { n.el.currentTime = want; void n.el.play().catch(() => {}); }
    else if (Math.abs(n.el.currentTime - want) > 0.12) n.el.currentTime = want;
  }

  /** Peak level 0..1 for a track bus (or master). */
  level(trackId?: string) {
    const a = trackId ? this.buses.get(trackId)?.analyser : this.masterAnalyser;
    if (!a) return 0;
    const buf = new Float32Array(a.fftSize);
    a.getFloatTimeDomainData(buf);
    let m = 0;
    for (let i = 0; i < buf.length; i++) m = Math.max(m, Math.abs(buf[i]));
    return m;
  }

  refreshBuses() { for (const t of store.project.tracks) if (t.kind === "audio" && this.buses.has(t.id)) this.bus(t); }
}

export const playback = new Playback();
