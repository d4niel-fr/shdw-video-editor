// A/V drift-correction policy for media elements that follow the timeline clock.
// Pure (no imports) so it can be tested with `node --test`.
//
// The original rule was "drift > 0.12 s -> seek". On WKWebView a seek takes ~0.14 s to start
// producing sound again, so right after every seek the drift was already > 0.12 s and the
// element was re-seeked forever: the voice restarted every ~130 ms.
//
// Fix: (1) never judge an element that is still seeking, (2) after a seek give it time to settle
// and only re-seek on a gross failure, (3) aim each seek ahead by the measured seek latency so the
// element lands in sync. Changing `playbackRate` to close small gaps is deliberately NOT done:
// on WKWebView it hung the web process when pausing an element wired into WebAudio.

export interface SyncInput {
  /** element.currentTime - timeline time, in seconds (negative = element is behind). */
  drift: number;
  /** element.seeking */
  seeking: boolean;
  /** milliseconds since this element was last seeked (Infinity if never). */
  sinceSeekMs: number;
}

export type SyncAction = { kind: "none" } | { kind: "seek" };

export const HARD_DRIFT = 0.15;
/** Initial guess for how far ahead to aim a seek (s); learned per element from the 'seeked' event. */
export const INITIAL_LEAD = 0.08;
export const SEEK_SETTLE_MS = 1500;
export const SETTLING_HARD_DRIFT = 1.0;
export const LEAD_MIN = 0.03;
export const LEAD_MAX = 1.5; // audio inside an MP4 with a video track needs ~0.6-0.8 s to resume after a seek
/** Video elements only need to stay roughly in step; seek them when they are this far off (settled). */
export const VIDEO_DRIFT = 0.25;

export function decideSync(i: SyncInput): SyncAction {
  if (i.seeking) return { kind: "none" }; // judge only once the element is playing again
  // right after a seek the element is still catching up: only a gross failure may re-seek
  const limit = i.sinceSeekMs < SEEK_SETTLE_MS ? SETTLING_HARD_DRIFT : HARD_DRIFT;
  return Math.abs(i.drift) > limit ? { kind: "seek" } : { kind: "none" };
}

/** Blend a newly measured seek latency (s) into the running estimate used as the seek lead. */
export function nextLead(prev: number, measuredLatency: number): number {
  return Math.min(LEAD_MAX, Math.max(LEAD_MIN, 0.5 * prev + 0.5 * measuredLatency));
}

// ---- buffered (AudioBufferSourceNode) playback -------------------------------------------------
// Decoded audio is played on the AudioContext clock. Restarting a source has no silent gap, so
// drift can be corrected tightly without the seek-latency problems of media elements.

export interface BufferedInput {
  /** expected source position now minus timeline position, seconds (negative = source is behind). */
  drift: number;
  /** playback rate differs from the one the source was started with */
  rateChanged: boolean;
  /** ms since this source was started */
  sinceStartMs: number;
}

export const BUFFER_DRIFT = 0.06;
export const BUFFER_SETTLE_MS = 150;

export function shouldRestartBuffered(i: BufferedInput): boolean {
  if (i.sinceStartMs < BUFFER_SETTLE_MS) return false; // a fresh source: don't chase clock jitter
  return i.rateChanged || Math.abs(i.drift) > BUFFER_DRIFT;
}

