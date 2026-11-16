// Transport: wall-clock driven playhead, video element sync, and a WebAudio
// mixer (clip gain/fades → track gain/pan → master) with level meters.

import { store } from "../store";
import { Clip, clipEnd, mediaOf, prop, Track, Media } from "../model";
import { pool, videoSourceTime } from "./sources";
import { mediaUrl, invoke, ext } from "../ipc";
import { decideSync, nextLead, shouldRestartBuffered, INITIAL_LEAD, LEAD_MIN, LEAD_MAX, SEEK_SETTLE_MS, SETTLING_HARD_DRIFT, VIDEO_DRIFT } from "./avsync";

interface ANode {
  el: HTMLAudioElement; src: MediaElementAudioSourceNode; gain: GainNode; pan: StereoPannerNode; track: string; srcUrl: string;
  /** performance.now() of the last seek (−Infinity = never) and the measured seek latency in seconds. */
  lastSeek: number; seekAt: number; seekTarget: number; lead: number;
}
/** One running AudioBufferSourceNode (restarted, never seeked). */
interface BSrc { src: AudioBufferSourceNode; fade: GainNode; startedCtx: number; startedPerf: number; offset: number; rate: number }
/** Decoded-audio playback chain for one audio clip: source → fade → clip gain → pan → track bus. */
interface BNode { gain: GainNode; pan: StereoPannerNode; track: string; buf: AudioBuffer; cur: BSrc | null }
/** Longer files are streamed through an <audio> element instead of being decoded into memory (seconds). */
const MAX_DECODE_SECONDS = 1800;

interface TBus { gain: GainNode; pan: StereoPannerNode; analyser: AnalyserNode }

/** Playback health counters, readable through the control API (`/state` → `playback`). */
interface PlaybackStats {
  audioDriftSeeks: number; videoDriftSeeks: number; waiting: number; stalled: number; mediaErrors: number;
  frames: number; gaps50: number; gaps100: number; maxGapMs: number; events: string[];
  buffersDecoded: number; decodeFailed: number; bufferRestarts: number;
}

class Playback {
  stats: PlaybackStats = { audioDriftSeeks: 0, videoDriftSeeks: 0, waiting: 0, stalled: 0, mediaErrors: 0, frames: 0, gaps50: 0, gaps100: 0, maxGapMs: 0, events: [], buffersDecoded: 0, decodeFailed: 0, bufferRestarts: 0 };
  private lastTick = 0;
  /** Opt-in output capture (diagnostics): counts discontinuities and dropouts in the master mix. */
  capture: { on: boolean; buffers: number; clicks: number; dropouts: number; maxDelta: number; peak: number; at: string[] } = { on: false, buffers: 0, clicks: 0, dropouts: 0, maxDelta: 0, peak: 0, at: [] };
  private tap: ScriptProcessorNode | null = null;
  /** How long an audio element stays silent after a seek on this machine (s). WebKit needs ~0.3 s, others ~0.05 s. */
  private audioLead = (() => {
    try { const v = parseFloat(localStorage.getItem("shdw.audioLead") ?? ""); if (v > 0) return Math.min(LEAD_MAX, Math.max(LEAD_MIN, v)); } catch { /* no storage */ }
    return /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Edg/.test(navigator.userAgent) ? 0.3 : INITIAL_LEAD;
  })();
  ctx: AudioContext | null = null;
  master!: GainNode;
  masterAnalyser!: AnalyserNode;
  buses = new Map<string, TBus>();
  private nodes = new Map<string, ANode>();
  /** Decoded audio by file path (null = decoding failed or file too long: use an <audio> element). */
  private decoded = new Map<string, AudioBuffer | null>();
  private decoding = new Set<string>();
  private bnodes = new Map<string, BNode>();
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

  private note(kind: string, el?: HTMLMediaElement) {
    const e = this.stats.events;
    e.push(`${store.playhead.toFixed(2)}s ${kind}${el ? ` rs=${el.readyState} ct=${el.currentTime.toFixed(2)}` : ""}`);
    if (e.length > 40) e.shift();
  }

  /** Tap the master bus and look for waveform jumps (> 0.15 between samples) and silent buffers mid-tone. */
  startCapture() {
    this.ensureAudio();
    this.stopCapture();
    this.capture = { on: true, buffers: 0, clicks: 0, dropouts: 0, maxDelta: 0, peak: 0, at: [] };
    const tap = this.ctx!.createScriptProcessor(2048, 1, 1);
    let heardTone = false;
    tap.onaudioprocess = (e) => {
      const x = e.inputBuffer.getChannelData(0);
      let sum = 0, prev = x[0];
      for (let i = 1; i < x.length; i++) {
        const d = Math.abs(x[i] - prev); prev = x[i]; sum += x[i] * x[i];
        if (d > this.capture.maxDelta) this.capture.maxDelta = d;
        if (d > 0.15) { this.capture.clicks++; if (this.capture.at.length < 40) this.capture.at.push(`click@${store.playhead.toFixed(2)}`); }
        if (Math.abs(x[i]) > this.capture.peak) this.capture.peak = Math.abs(x[i]);
      }
      const rms = Math.sqrt(sum / x.length);
      if (rms > 0.01) heardTone = true; else if (heardTone && rms < 1e-4 && store.playing && store.playhead < store.duration - 0.3) { this.capture.dropouts++; if (this.capture.at.length < 40) this.capture.at.push(`silent@${store.playhead.toFixed(2)}`); }
      if (rms > 0.01 || heardTone) this.capture.buffers++;
    };
    this.master.connect(tap);
    tap.connect(this.ctx!.destination);
    this.tap = tap;
  }

  stopCapture() {
    if (this.tap) { try { this.master.disconnect(this.tap); } catch { /* gone */ } this.tap.disconnect(); this.tap.onaudioprocess = null; this.tap = null; }
    this.capture.on = false;
  }

  /** Snapshot for diagnostics: counters + audio context + every audio element. */
  report() {
    const c = this.ctx;
    return {
      ...this.stats,
      capture: this.capture,
      audioContext: c ? { state: c.state, sampleRate: c.sampleRate, baseLatencyMs: Math.round(c.baseLatency * 1000), outputLatencyMs: Math.round((c.outputLatency ?? 0) * 1000) } : null,
      buffers: {
        inFlight: [...this.decoding].map((p) => p.split("/").pop()),
        decoded: [...this.decoded.entries()].map(([path, b]) => ({ file: path.split("/").pop(), seconds: b ? +b.duration.toFixed(2) : null, channels: b?.numberOfChannels, sampleRate: b?.sampleRate })),
        playing: [...this.bnodes.entries()].filter(([, b]) => b.cur).map(([id, b]) => ({ clip: id, offset: +b.cur!.offset.toFixed(3), rate: b.cur!.rate })),
      },
      audioElements: [...this.nodes.entries()].map(([id, n]) => ({ clip: id, paused: n.el.paused, readyState: n.el.readyState, currentTime: +n.el.currentTime.toFixed(3), bufferedEnd: n.el.buffered.length ? +n.el.buffered.end(n.el.buffered.length - 1).toFixed(2) : 0, rate: n.el.playbackRate })),
    };
  }

  private prepT = 0;
  private videoSeekAt = new Map<string, number>();

  constructor() {
    store.on("project", () => this.prewarm());
    // while paused, park audio elements where playback would start so Play doesn't begin with a seek
    store.on("time", () => { if (!store.playing) { clearTimeout(this.prepT); this.prepT = window.setTimeout(() => this.prepareAudio(), 120); } });
  }

  /** Park the audio element of every audio clip under the playhead exactly at the playhead (paused only). */
  private prepareAudio() {
    if (store.playing || !store.dir) return;
    const p = store.project, t = store.playhead;
    for (const c of p.clips) {
      if (c.enabled === false || t < c.start || t >= clipEnd(c)) continue;
      const m = mediaOf(p, c), track = p.tracks.find((tr) => tr.id === c.track);
      if (!m || !track || track.kind !== "audio" || !(m.kind === "audio" || m.hasAudio !== false)) continue;
      if (this.decoded.get(store.abs(m.path)) !== null) continue; // decoded clips need no pre-positioning
      const n = this.node(c, track, store.abs(m.path));
      const want = videoSourceTime(c, t - c.start, m);
      if (!n.el.seeking && Math.abs(n.el.currentTime - want) > 0.05) n.el.currentTime = want;
    }
  }

  get playing() { return store.playing; }

  toggle() { store.playing ? this.pause() : this.play(); }

  play(rate = 1) {
    this.ensureAudio();
    void this.ctx!.resume();
    this.prewarm();
    this.rate = rate;
    const end = this.endTime();
    if (store.playhead >= end - 1 / store.fps) store.seek(store.inPoint ?? 0);
    store.playing = true;
    this.wall0 = performance.now();
    this.t0 = store.playhead;
    store.emit("transport");
    cancelAnimationFrame(this.raf);
    this.lastTick = 0;
    const tick = () => {
      if (!store.playing) return;
      const now = performance.now();
      if (this.lastTick) {
        const gap = now - this.lastTick;
        this.stats.frames++;
        if (gap > 50) this.stats.gaps50++;
        if (gap > 100) this.stats.gaps100++;
        if (gap > this.stats.maxGapMs) this.stats.maxGapMs = Math.round(gap);
      }
      this.lastTick = now;
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
    for (const b of this.bnodes.values()) this.stopBuffered(b);
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
        else if (!el.seeking) {
          // same rule as audio: after a seek give the element time to settle instead of re-seeking every second
          const since = performance.now() - (this.videoSeekAt.get(c.id) ?? -Infinity);
          if (Math.abs(el.currentTime - want) > (since < SEEK_SETTLE_MS ? SETTLING_HARD_DRIFT : VIDEO_DRIFT)) {
            this.stats.videoDriftSeeks++; this.videoSeekAt.set(c.id, performance.now()); el.currentTime = want;
          }
        }
      } else if (track.kind === "audio" && (m.kind === "audio" || m.hasAudio !== false)) {
        this.syncAudio(c, track, m, want, lt, media);
      }
    }
    for (const [id, e] of pool.entries()) if (!activeVideo.has(id) && !e.el.paused) e.el.pause();
    for (const [id, n] of this.nodes) {
      const c = store.clip(id);
      if (!c || t < c.start || t >= clipEnd(c) || c.enabled === false) { if (!n.el.paused) n.el.pause(); }
    }
    for (const [id, b] of this.bnodes) {
      const c = store.clip(id);
      if (!c || t < c.start || t >= clipEnd(c) || c.enabled === false) this.stopBuffered(b);
    }
  }

  /** Get (or create) the audio element + WebAudio chain for an audio clip. */
  private node(c: Clip, track: Track, path: string): ANode {
    this.ensureAudio();
    const url = mediaUrl(path);
    let n = this.nodes.get(c.id);
    if (n && n.srcUrl !== url) { n.el.pause(); n.src.disconnect(); this.nodes.delete(c.id); n = undefined; }
    if (n) return n;
    const el = new Audio();
    el.crossOrigin = "anonymous";
    el.preload = "auto";
    el.src = url;
    const src = this.ctx!.createMediaElementSource(el);
    const gain = this.ctx!.createGain();
    const pan = this.ctx!.createStereoPanner();
    src.connect(gain).connect(pan);
    const node: ANode = { el, src, gain, pan, track: track.id, srcUrl: url, lastSeek: -Infinity, seekAt: 0, seekTarget: 0, lead: this.audioLead };
    el.addEventListener("waiting", () => { this.stats.waiting++; this.note("audio waiting", el); });
    el.addEventListener("stalled", () => { this.stats.stalled++; this.note("audio stalled", el); });
    el.addEventListener("error", () => { this.stats.mediaErrors++; this.note(`audio error ${el.error?.code}`, el); });
    this.nodes.set(c.id, node);
    return node;
  }

  /** Seek an audio element to the timeline position, compensating for the seek latency. */
  private seekAudio(n: ANode, want: number) {
    n.lastSeek = n.seekAt = performance.now();
    n.seekTarget = want + n.lead;
    n.el.currentTime = n.seekTarget;
  }

  /** Load the audio of upcoming clips before playback starts so the first seconds don't begin cold. */
  private prewarm() {
    if (!store.dir) return;
    const p = store.project, t = store.playhead;
    let created = 0;
    for (const c of p.clips) {
      if (created >= 8) break;
      if (c.enabled === false || c.start > t + 10 || clipEnd(c) < t) continue;
      const m = mediaOf(p, c), track = p.tracks.find((tr) => tr.id === c.track);
      if (!m || !track || track.kind !== "audio" || !(m.kind === "audio" || m.hasAudio !== false)) continue;
      const path = store.abs(m.path);
      if (this.decoded.get(path) === null) this.node(c, track, path); // fallback file: warm an <audio> element
      else this.decode(path, m.name, m.duration);
      created++;
    }
  }

  /** Fetch a file's bytes and decode them (plain-binary request: WebKit stalls fetch() of video/* responses). */
  private async fetchDecode(path: string, timeoutMs: number): Promise<AudioBuffer> {
    const abort = new AbortController();
    const timer = window.setTimeout(() => abort.abort(), timeoutMs);
    try {
      const res = await fetch(mediaUrl(path) + "?raw=1", { signal: abort.signal });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await this.ctx!.decodeAudioData(await res.arrayBuffer());
    } finally { clearTimeout(timer); }
  }

  /** Decode a file's audio once; playback then runs on the AudioContext clock (no seeking, no resume latency). */
  private decode(path: string, name: string, duration: number) {
    if (this.decoded.has(path) || this.decoding.has(path)) return;
    if (duration > MAX_DECODE_SECONDS) { this.decoded.set(path, null); return; }
    this.ensureAudio();
    this.decoding.add(path);
    const t0 = performance.now();
    const took = () => `${Math.round(performance.now() - t0)}ms`;
    this.note(`decode start ${name}`);
    // audio-native files decode directly; video containers (and anything WebKit rejects, e.g. HE-AAC) go through ffmpeg
    const direct = () => this.fetchDecode(path, 15000);
    const viaFfmpeg = async () => {
      const wav = await Promise.race([invoke<string>("extract_audio", { path }), new Promise<never>((_, no) => setTimeout(() => no(new Error("extract timed out")), 90000))]);
      return this.fetchDecode(wav, 30000);
    };
    const native = ["wav", "mp3", "m4a", "aac", "flac", "ogg", "opus", "aif", "aiff"].includes(ext(path));
    void (async () => {
      let buf: AudioBuffer | null = null;
      for (const [label, attempt] of (native ? [["direct", direct], ["ffmpeg", viaFfmpeg]] : [["ffmpeg", viaFfmpeg], ["direct", direct]]) as [string, () => Promise<AudioBuffer>][]) {
        try { buf = await attempt(); this.note(`decode ok ${name} via ${label} in ${took()}`); break; }
        catch (e) { this.note(`decode ${label} failed ${name} after ${took()}: ${String(e).slice(0, 70)}`); }
      }
      this.decoded.set(path, buf); // null => <audio> element fallback
      if (buf) this.stats.buffersDecoded++; else this.stats.decodeFailed++;
      this.decoding.delete(path);
    })();
  }

  private syncAudio(c: Clip, track: Track, m: Media, want: number, lt: number, media: boolean) {
    const path = store.abs(m.path);
    const buf = this.decoded.get(path);
    if (buf === undefined) { this.decode(path, m.name, m.duration); return; } // still decoding: silent until ready
    if (buf) this.syncBuffered(c, track, buf, want, lt, media);
    else this.syncElement(c, track, path, want, lt, media);
  }

  /** Decoded clips: a source that is restarted (gaplessly) whenever it drifts, never seeked. */
  private syncBuffered(c: Clip, track: Track, buf: AudioBuffer, want: number, lt: number, media: boolean) {
    const ctx = this.ctx!;
    let b = this.bnodes.get(c.id);
    if (b && b.buf !== buf) { this.stopBuffered(b); this.bnodes.delete(c.id); b = undefined; }
    if (!b) {
      const gain = ctx.createGain(), pan = ctx.createStereoPanner();
      gain.connect(pan);
      b = { gain, pan, track: track.id, buf, cur: null };
      this.bnodes.set(c.id, b);
    }
    const bus = this.bus(track);
    if (b.track !== track.id) { b.pan.disconnect(); b.track = track.id; }
    try { b.pan.connect(bus.gain); } catch { /* already connected */ }
    let g = prop(c, "volume", lt, c.volume ?? 1);
    if (c.audioFadeIn) g *= Math.min(1, lt / c.audioFadeIn);
    if (c.audioFadeOut) g *= Math.min(1, (c.duration - lt) / c.audioFadeOut);
    b.gain.gain.value = Math.max(0, g);
    b.pan.pan.value = c.pan ?? 0;
    if (!media || want >= buf.duration) { this.stopBuffered(b); return; }
    const rate = Math.min(16, Math.max(0.0625, (c.speed ?? 1) * this.rate));
    const cur = b.cur;
    if (!cur) { this.startBuffered(b, want, rate); return; }
    const pos = cur.offset + (ctx.currentTime - cur.startedCtx) * cur.rate;
    if (shouldRestartBuffered({ drift: pos - want, rateChanged: Math.abs(cur.rate - rate) > 1e-3, sinceStartMs: performance.now() - cur.startedPerf })) {
      this.stats.bufferRestarts++;
      this.note(`audio restart (drift ${(pos - want).toFixed(3)}s)`);
      this.startBuffered(b, want, rate);
    }
  }

  private startBuffered(b: BNode, want: number, rate: number) {
    const ctx = this.ctx!;
    this.stopBuffered(b);
    const src = ctx.createBufferSource();
    src.buffer = b.buf;
    src.playbackRate.value = rate;
    const fade = ctx.createGain();
    const now = ctx.currentTime;
    fade.gain.setValueAtTime(0, now); // 8 ms ramps so a (re)start never clicks
    fade.gain.linearRampToValueAtTime(1, now + 0.008);
    src.connect(fade).connect(b.gain);
    src.start(now, want);
    const cur: BSrc = { src, fade, startedCtx: now, startedPerf: performance.now(), offset: want, rate };
    b.cur = cur;
    src.onended = () => { try { src.disconnect(); fade.disconnect(); } catch { /* gone */ } if (b.cur === cur) b.cur = null; };
  }

  private stopBuffered(b: BNode) {
    const cur = b.cur;
    if (!cur) return;
    b.cur = null;
    const now = this.ctx!.currentTime;
    try {
      cur.fade.gain.cancelScheduledValues(now);
      cur.fade.gain.setValueAtTime(cur.fade.gain.value, now);
      cur.fade.gain.linearRampToValueAtTime(0, now + 0.008);
      cur.src.stop(now + 0.01);
    } catch { /* already stopped */ }
  }

  /** Fallback for files that cannot be decoded or are very long: an <audio> element with drift-seek logic. */
  private syncElement(c: Clip, track: Track, path: string, want: number, lt: number, media: boolean) {
    const n = this.node(c, track, path);
    const bus = this.bus(track);
    if (n.track !== track.id) { n.pan.disconnect(); n.track = track.id; }
    try { n.pan.connect(bus.gain); } catch { /* already connected */ }
    let g = prop(c, "volume", lt, c.volume ?? 1);
    if (c.audioFadeIn) g *= Math.min(1, lt / c.audioFadeIn);
    if (c.audioFadeOut) g *= Math.min(1, (c.duration - lt) / c.audioFadeOut);
    n.gain.gain.value = Math.max(0, g);
    n.pan.pan.value = c.pan ?? 0;
    if (!media) { if (!n.el.paused) n.el.pause(); return; }
    const rate = Math.min(16, Math.max(0.0625, (c.speed ?? 1) * this.rate));
    if (n.el.paused) {
      // already parked at the start position (see prepareAudio)? then just play (it resumes without a stall,
      // so no lead is needed); otherwise seek first, aiming ahead by the learned resume latency
      if (n.el.seeking || Math.abs(n.el.currentTime - want) > 0.05) this.seekAudio(n, want);
      void n.el.play().catch(() => {});
    } else {
      // the element is silent after a seek until currentTime moves again: that gap is the lead to aim ahead by
      if (n.seekAt && !n.el.seeking && n.el.currentTime > n.seekTarget + 0.03) {
        const latency = (performance.now() - n.seekAt) / 1000;
        n.seekAt = 0;
        n.lead = nextLead(n.lead, latency);
        this.audioLead = nextLead(this.audioLead, latency);
        try { localStorage.setItem("shdw.audioLead", this.audioLead.toFixed(3)); } catch { /* no storage */ }
      }
      const act = decideSync({ drift: n.el.currentTime - want, seeking: n.el.seeking, sinceSeekMs: performance.now() - n.lastSeek });
      if (act.kind === "seek") {
        this.stats.audioDriftSeeks++;
        this.note(`audio drift ${(n.el.currentTime - want).toFixed(2)}s -> seek`, n.el);
        this.seekAudio(n, want);
      }
    }
    // playbackRate follows the clip speed / transport rate only; drift is never corrected by changing it
    // (that hung WKWebView when pausing an element wired into WebAudio)
    if (Math.abs(n.el.playbackRate - rate) > 1e-3) n.el.playbackRate = rate;
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
