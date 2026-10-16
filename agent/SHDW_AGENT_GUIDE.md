# shdw project — agent guide

You are working inside a **shdw** video project. shdw is a DaVinci-Resolve-style
non-linear editor. The user chats with you from the editor's Agent panel. You
edit the video by **editing files in this folder**; shdw watches the folder and
hot-reloads everything within ~200 ms. You can also call the running editor's
local control API (see bottom) to render frames and check your work visually.

Always finish a request by making the change in files — not by describing it.

## Folder layout

| Path | Purpose |
| --- | --- |
| `project.shdw.json` | The timeline: settings, media pool, tracks, clips, markers. Single source of truth. |
| `media/` | Imported footage, audio, images. |
| `motion/` | Motion-graphics clips you write in code (`*.js`). |
| `transitions/` | Custom transitions (`*.js`, GLSL). |
| `effects/` | Custom per-clip effects (`*.js`, GLSL). |
| `blends/` | Custom blend modes (`*.js`, GLSL). |
| `fonts/` | `.ttf/.otf/.woff/.woff2` files — auto-registered; use the file name (without extension) as the font family. |
| `luts/` | `.cube` 3D LUTs for the Color page. |
| `inspo/` | Reference images / videos / notes the user collected. Look at them (Read the images) when asked to match a style. |
| `transcripts/` | Whisper transcripts (`<mediaId>.json`). |
| `renders/` | Exports and your verification frames. |

Paths inside `project.shdw.json` are relative to the project folder (absolute also allowed). Use forward slashes.

## project.shdw.json

```jsonc
{
  "version": 1,
  "name": "My Video",
  "settings": { "width": 1920, "height": 1080, "fps": 30, "background": "#000000" },
  "media": [
    { "id": "m_intro", "name": "intro.mp4", "path": "media/intro.mp4", "kind": "video",
      "duration": 12.5, "width": 1920, "height": 1080, "fps": 29.97, "hasAudio": true }
  ],
  "tracks": [
    { "id": "V1", "kind": "video", "name": "V1" },
    { "id": "V2", "kind": "video", "name": "V2" },
    { "id": "A1", "kind": "audio", "name": "A1", "volume": 1, "pan": 0 },
    { "id": "S1", "kind": "subtitle", "name": "Subtitles" }
  ],
  "clips": [ /* see Clip */ ],
  "markers": [ { "t": 4.0, "name": "drop", "color": "#ff375f" } ]
}
```

* Video tracks composite **bottom-up in array order**: the first video track is the bottom layer. Subtitle tracks always draw on top.
* Track flags (optional): `hidden`, `locked`, `muted`, `solo`, `volume` (0–2), `pan` (-1..1).
* All times are **seconds** (floats). Snap to frames: `Math.round(t*fps)/fps`.
* IDs must be unique strings. Prefix: `m_` media, `c_` clips, `l_` links.

### Clip

```jsonc
{
  "id": "c_title", "track": "V2", "start": 0.0, "duration": 4.0,
  "name": "Title",                                  // optional label
  "source": { "type": "motion", "module": "motion/title.js", "params": { "text": "HELLO" } },
  "transform": { "x": 0, "y": 0, "scale": 1, "scaleX": 1, "scaleY": 1, "rotation": 0,
                 "anchorX": 0.5, "anchorY": 0.5, "flipH": false, "flipV": false,
                 "cropLeft": 0, "cropRight": 0, "cropTop": 0, "cropBottom": 0 },
  "opacity": 1,
  "blend": "normal",                // built-in name OR "blends/myblend.js"
  "speed": 1,                       // media playback rate (0.1 – 16)
  "volume": 1, "pan": 0,            // audio
  "fadeIn": 0, "fadeOut": 0,        // video opacity fades (s)
  "audioFadeIn": 0, "audioFadeOut": 0,
  "effects": [ { "type": "gaussianBlur", "params": { "radius": 12 } },
               { "type": "effects/glitch.js", "params": { "amount": 0.4 } } ],
  "grade": { "exposure": 0, "contrast": 1, "saturation": 1, "temperature": 0, "tint": 0,
             "lift": [0,0,0], "gamma": [0,0,0], "gain": [0,0,0], "offset": [0,0,0],
             "hue": 0, "vibrance": 0, "highlights": 0, "shadows": 0,
             "lut": "luts/film.cube", "lutMix": 1 },
  "keyframes": {
    "opacity":      [ { "t": 0, "v": 0, "ease": "easeOut" }, { "t": 0.6, "v": 1 } ],
    "transform.scale": [ { "t": 0, "v": 1.2, "ease": "spring" }, { "t": 1, "v": 1 } ],
    "effects.0.radius": [ { "t": 0, "v": 30 }, { "t": 0.5, "v": 0 } ],
    "params.progress": [ { "t": 0, "v": 0 }, { "t": 3, "v": 1 } ]
  },
  "transition": { "type": "crossDissolve", "duration": 0.5 },   // INTO this clip from the clip that ends at `start` on the same track
  "link": "l_1",                    // clips sharing a link move/trim together (video + its audio)
  "enabled": true
}
```

`transform.x/y` are pixels offset from frame center. `scale` multiplies `scaleX/scaleY`.
Media is fitted to the frame (contain) before the transform is applied.
Keyframe `t` is **relative to clip start**. Keyframe paths: `opacity`, `transform.<key>`,
`volume`, `effects.<index>.<param>`, `params.<name>` (motion / text params), `grade.<key>`.
Eases: `linear`, `hold`, `easeIn`, `easeOut`, `easeInOut`, `easeInBack`, `easeOutBack`,
`easeOutExpo`, `easeInOutExpo`, `spring` (critically damped), `bounce` (spring, damping 0.6),
or a cubic-bezier array `[x1,y1,x2,y2]`. Ease applies to the segment starting at that key.

### Source types

| type | fields |
| --- | --- |
| `media` | `media` (media id), `in` (source seconds). Video, audio or image. Put audio-only media on audio tracks. Video media with audio: add a second linked clip on an audio track (same `link`) so it is mixed. |
| `html` | `module` (path to `motion/*.html`), `params` — **HTML/CSS/SVG/GSAP composition, rendered frame-exact with alpha (see below). Preferred for rich motion design.** |
| `motion` | `module` (path to `motion/*.js`), `params` — canvas 2D / GLSL module |
| `text` | `text`, `font` (family), `size` (px), `weight`, `color`, `align` (`left|center|right`), `tracking` (em), `lineHeight`, `stroke` `{color,width}`, `shadow` `{color,blur,x,y}`, `background` `{color,padding,radius}`, `animation` (`none|fade|fadeUp|typewriter|wordPop|scaleIn|blurIn|slideLeft|tracking`), `animDuration` |
| `solid` | `color` |
| `gradient` | `colors` (array), `angle` (deg), `radial` (bool) |
| `subtitle` | `text` — on subtitle tracks. Track-level style lives in the track's `style` (same keys as text, plus `y` position 0..1). |
| `adjustment` | no fields: its `effects` and `grade` apply to everything composited below it. |

### Built-ins

* **Blend modes**: normal, multiply, screen, overlay, softLight, hardLight, colorDodge, colorBurn,
  darken, lighten, difference, exclusion, add, subtract, divide, linearLight, vividLight, pinLight,
  hue, saturation, color, luminosity.
* **Effects** (`type` → params): gaussianBlur{radius}, directionalBlur{length,angle}, zoomBlur{amount,cx,cy},
  sharpen{amount}, vignette{amount,softness}, glow{radius,strength,threshold}, chromaticAberration{amount},
  filmGrain{amount,size}, pixelate{size}, mirror{mode 0-3}, posterize{levels}, invert{}, hueShift{degrees},
  blackWhite{}, sepia{amount}, glitch{amount,speed}, rgbSplit{amount,angle}, lensDistortion{amount},
  edgeDetect{}, chromaKey{color,similarity,smoothness,spill}, lumaKey{low,high,invert},
  letterbox{ratio}, cameraShake{amount,speed}, vhs{amount}, halftone{size}, scanlines{amount,count},
  threshold{level}, emboss{}, wave{amount,frequency,speed}, kaleidoscope{segments},
  dropShadow{x,y,blur,opacity}, tint{color,amount}, duotone{dark,light}.
* **Transitions**: crossDissolve, dipToBlack, dipToWhite, additiveDissolve, wipeLeft, wipeRight,
  wipeUp, wipeDown, slideLeft, slideRight, slideUp, slideDown, pushLeft, pushRight, zoomIn,
  zoomOut, crashZoom, blurDissolve, irisCircle, irisDiamond, clockWipe, barnDoor, whipPan,
  spin, glitch, rgbSplit, pixelDissolve, noiseDissolve, lumaFade, filmBurn, lightLeak,
  squeeze, cube, pageSlide, ripple.

## Canvas / GLSL motion modules (`motion/*.js`)

Use these for generative / particle / shader work or when you want pure canvas drawing.

ES module, default export. Rendered on a transparent canvas the size of the comp, every frame,
deterministically (export renders frame-by-frame — never use `Date.now()` or `Math.random()`;
use `t` and `api.kit.rand(seed)`).

```js
export default {
  name: "Kinetic Title",
  duration: 4,                                   // default length when added from the library
  params: {
    text:  { type: "text",   default: "MAKE IT MOVE" },
    color: { type: "color",  default: "#ffffff" },
    size:  { type: "number", default: 180, min: 20, max: 600 },
  },
  render(ctx, t, api) {
    const { width: W, height: H, params: p, kit } = api;
    const words = p.text.split(" ");
    words.forEach((w, i) => {
      const k = kit.spring(kit.stagger(t, i, 0.08, 0.7));       // 0→1 with spring
      ctx.globalAlpha = kit.clamp(k, 0, 1);
      kit.text(ctx, w, W / 2, H / 2 + (i - (words.length - 1) / 2) * p.size * 0.95 + (1 - k) * 80,
        { size: p.size, weight: 800, color: p.color, tracking: -0.03, font: "Inter" });
    });
  },
};
```

`api` = `{ width, height, fps, duration, frame, progress (0..1), params, kit, image(path), video(path, time) , fonts }`.
`api.image("inspo/ref.png")` returns a cached HTMLImageElement (null until loaded — export waits for it).

GPU shader alternative (Shadertoy-style) — export `fragment` instead of `render`:

```js
export default {
  name: "Aurora", duration: 6,
  params: { speed: { type: "number", default: 1 }, tint: { type: "color", default: "#7a5cff" } },
  fragment: `
    void mainImage(out vec4 fragColor, in vec2 fragCoord) {
      vec2 uv = fragCoord / iResolution.xy;
      float w = sin(uv.x * 6.0 + iTime * u_speed) * 0.5 + 0.5;
      fragColor = vec4(u_tint * w, w);           // output PREMULTIPLIED alpha (rgb already × a); opaque → a = 1
    }`,
};
```

Uniforms available: `iTime` (clip-local seconds), `iResolution` (vec3), `iProgress`, `iDuration`,
`iFrame`, and every param as `u_<name>` (number → float, color → vec3, bool → float).

### kit (helpers in `api.kit`)
`lerp, clamp, map(v,a,b,c,d), smoothstep, ease.{linear,inQuad,outQuad,inOutQuad,inCubic,outCubic,inOutCubic,
inQuart,outQuart,inOutQuart,inExpo,outExpo,inOutExpo,inBack,outBack,inOutBack,outElastic,outBounce}`,
`spring(x, damping=1, response=0.4)` (x = seconds since start, returns 0→1 physically),
`stagger(t, i, each, dur)` (local 0..1 progress for item i), `seq(t, start, end)` (0..1 within window),
`rand(seed)`, `noise(x, y)`, `hexToRgb`, `mixColor(a,b,k)`,
`text(ctx, str, x, y, {font,size,weight,color,align,baseline,tracking,italic,stroke,strokeWidth,shadow})`,
`measure(ctx, str, opts)`, `splitWords`, `splitChars`, `typewriter(str, k)`,
`roundRect(ctx,x,y,w,h,r)`, `path(ctx, points)`, `gradient(ctx, x0,y0,x1,y1, stops)`, `glow(ctx, color, blur)`.

### Quality bar for motion graphics
Aim for Apple-keynote polish: generous negative space, tight tracking on large type (-0.02…-0.04em),
critically damped springs for UI-like motion (bounce only after momentum), staggered reveals
(60–90 ms), motion blur via subtle stretch for fast moves, consistent easing, 2–3 colors max,
safe margins (≥ 5% of frame). Respect the comp size from `api.width/height`.

## HTML motion compositions (`motion/*.html`) — the main motion-graphics format

This is the same medium Claude Design / Claude Motion uses (HTML + CSS + JS, GSAP timelines, SVG),
but in shdw it is a real layer on an NLE timeline: composited over footage, with alpha, blend
modes, effects, transitions, keyframed transform/opacity, color grade, and frame-exact export at
any resolution. A headless Chromium renders it with **virtualized time**, so all of these are
seekable and deterministic:

* GSAP — the global timeline and any `gsap.timeline({ paused: true })` you create are seeked to `t`.
* CSS `@keyframes` animations and transitions, Web Animations API (`el.animate`) — `currentTime` is set.
* `requestAnimationFrame`, `performance.now()`, `Date.now()` — virtual clock (React `useTime`-style Stage code works).
* `<video data-start="0">` inside the page is seeked; `<img>` and web fonts are awaited.
* Hook: `shdw.onFrame((t, api) => { ... })` or define `window.render = (t, api) => {...}` — called every frame (may be async).

`window.shdw` = `{ width, height, time, duration, progress, params, onFrame(fn) }`. Params from the
clip's `source.params` are also applied automatically: `[data-param="title"]` elements get their text,
numbers/colors become CSS vars `--title`, `--accent`. CSS var `--t` = current seconds.

Offline libraries are pre-installed in `motion/lib/`: `gsap.min.js`, `SplitText.min.js`,
`DrawSVGPlugin.min.js`, `MorphSVGPlugin.min.js`, `MotionPathPlugin.min.js`, `CustomEase.min.js`,
`ScrambleTextPlugin.min.js`, `TextPlugin.min.js`, `Physics2DPlugin.min.js` (all GSAP plugins are free).
Load with `<script src="lib/gsap.min.js"></script>`. CDN scripts (cdnjs, jsdelivr — three.js,
lottie-web, d3, anime.js) also work when online. Reference project files relatively (`../media/x.png`, `../fonts/X.woff2`).

Rules:
1. `html, body { background: transparent; margin: 0; overflow: hidden }` — transparency becomes alpha.
2. Lay out in the comp size: use `vw/vh` units or `shdw.width/height` (the viewport equals the timeline resolution).
3. Build ONE paused master timeline and drive it from `shdw.onFrame(t => tl.time(t))`. Rebuild it if
   `shdw.params` or `shdw.duration` change (see the templates `motion/keynote-reveal.html`, `motion/stat-ring.html`).
4. Never use wall-clock timers (`setInterval`, `setTimeout` for animation). Everything is a function of `t`.
5. Exit animation should finish by `shdw.duration`. Entrances start at t = 0.

Skeleton:

```html
<!doctype html><html><head><meta charset="utf-8">
<script src="lib/gsap.min.js"></script><script src="lib/SplitText.min.js"></script>
<style>
  html,body{margin:0;width:100%;height:100%;background:transparent;overflow:hidden}
  body{display:grid;place-items:center;font-family:Inter,"SF Pro Display",system-ui,sans-serif;color:#f5f5f7}
  h1{font-size:8vw;font-weight:700;letter-spacing:-.04em;margin:0}
</style></head><body>
<h1 id="t" data-param="title">Hello</h1>
<script>
  gsap.registerPlugin(SplitText);
  let tl, sig = "";
  function build(){
    if (tl) tl.kill();
    const s = new SplitText("#t", { type: "chars" });
    tl = gsap.timeline({ paused: true })
      .from(s.chars, { yPercent: 120, opacity: 0, filter: "blur(12px)", stagger: .035, duration: 1, ease: "expo.out" })
      .to("#t", { opacity: 0, y: -20, duration: .4, ease: "power2.in" }, shdw.duration - .4);
    sig = JSON.stringify(shdw.params) + shdw.duration;
  }
  shdw.onFrame(t => { if (sig !== JSON.stringify(shdw.params) + shdw.duration) build(); tl.time(t); });
</script></body></html>
```

Clip: `{ "id":"c_title","track":"V3","start":0,"duration":4,"source":{"type":"html","module":"motion/title.html","params":{"title":"Launch day"}} }`

## Motion design playbook (how to beat a generic "AI animation")

1. **Storyboard first.** Before code, write 3–6 beats with timings (e.g. 0–0.8s logo resolve, 0.8–2.4s headline,
   2.4–4s product shot push-in). Put beats on the timeline as markers (`markers[]`). Match beats to music
   (`/process?op=beats` puts markers on the musical onsets).
2. **Layer it like an editor, not a web page.** Separate clips per element on separate tracks (background
   plate, footage, headline, UI card, light leak with `screen` blend, adjustment layer for grade/grain).
   That gives the user handles to retime and tweak each piece on the timeline.
3. **Motion vocabulary.** Expo/quart outs for entrances (`expo.out`, `power4.out`), short accelerating exits
   (`power2.in`, 60–70 % of entrance length), staggered chars/words at 25–45 ms, critically-damped springs for
   UI, overshoot (`back.out(1.4)`) only for playful brands. Motion blur = blur filter that decays with
   velocity (`filter: blur()` from 10–16px → 0). Add a slow continuous drift/scale (2–4 %) so nothing is ever dead-still.
4. **Typography.** Big display type: weight 600–800, tracking −0.03…−0.05em, line-height ~1.0. Supporting text
   ~25–30 % of headline size, tracking +0.01…+0.18em for uppercase labels. Max two families.
5. **Depth & polish.** Soft shadows, subtle gradients, 1px light edges on cards, film grain (`filmGrain` effect
   on an adjustment layer, amount ~0.06), vignette, light leaks via `screen`/`add` blend, depth of field via
   `gaussianBlur` on background layers.
6. **Transitions with intent.** Cut on action; use custom GLSL transitions for signature moments only.
7. **Verify every time.** `/frames?from=..&to=..&count=8` contact sheet, Read it, check: legibility, safe margins
   (≥5 %), nothing clipped, entrances complete, exits clean, timing feels right. Fix, re-render, repeat.
8. **Inspiration.** If `inspo/` has files, Read the images first and extract palette, type style, layout grid,
   pacing. State what you are matching.

## Clip processing (Resolve-style tools)

`POST /process?clip=<id>&op=<op>` where op is:
`scenes` (shot-cut detection → splits the clip), `silence` (remove silences, ripple; `&noise=-32&min=0.45`),
`normalize` (loudness to `&target=-14` LUFS), `beats` (music onsets → markers), `stabilize`, `denoise`,
`audioDenoise`, `voiceEnhance`, `reverse`, `slowmo` (optical-flow 25 %). Processing creates new media in
`.shdw/processed/` and swaps it into the clip. `"freeze": true` on a media clip holds its first frame.

## Custom transitions (`transitions/*.js`) — gl-transitions compatible

```js
export default {
  name: "Diagonal Reveal", duration: 0.7,
  params: { softness: { type: "number", default: 0.1 } },
  fragment: `
    vec4 transition(vec2 uv) {
      float d = (uv.x + uv.y) * 0.5;
      float m = smoothstep(progress - u_softness, progress + u_softness, d);
      return mix(getToColor(uv), getFromColor(uv), m);
    }`,
};
```
Available: `progress`, `ratio`, `getFromColor(uv)`, `getToColor(uv)`, `iTime`, `u_<param>`.
Use it with `"transition": { "type": "transitions/diagonal.js", "duration": 0.7 }`.

## Custom effects (`effects/*.js`)

```js
export default {
  name: "Heat Haze",
  params: { amount: { type: "number", default: 0.01 } },
  fragment: `
    vec4 effect(vec2 uv) {
      uv.x += sin(uv.y * 80.0 + iTime * 6.0) * u_amount;
      return texture(src, uv);
    }`,
};
```
Available: `src` (sampler2D, premultiplied), `iResolution`, `iTime`, `u_<param>`.

## Custom blend modes (`blends/*.js`)

```js
export default { name: "Neon Add", fragment: `vec3 blend(vec3 base, vec3 top) { return base + top * top * 1.5; }` };
```

## Fonts
Drop font files into `fonts/` (e.g. download from Google Fonts with
`curl -L -o fonts/Inter.ttf "<url>"`). The family name = file name without extension.
You can also *design* a custom display font: write a motion module that draws glyphs as vector paths.

## Control API — the running editor (http://127.0.0.1:{{PORT}})

The port is also in `.shdw/port`. Use `curl` (Windows: `curl.exe`).

| Method & path | What it does |
| --- | --- |
| `GET /health` | Ping. |
| `GET /state` | Current project, playhead, selected clip ids, project dir. |
| `GET /frame?t=2.5&path=renders/check.png&scale=0.5` | Render the composited frame at time t to PNG. **Then Read the PNG to verify your work visually.** |
| `GET /frames?from=0&to=4&count=6&path=renders/strip.png` | Contact sheet of N frames in one PNG. |
| `POST /reload` | Force reload of project + modules (normally automatic). |
| `POST /seek?t=3` · `POST /play` · `POST /pause` | Transport. |
| `POST /import` body `{"paths":["C:/abs/file.mp4"], "copy": true}` | Import files into the media pool (probes duration/size). Returns media entries with ids. |
| `POST /transcribe?media=m_intro` | Whisper transcript → `transcripts/m_intro.json` `{segments:[{start,end,text}]}` (source-time seconds). |
| `POST /captions?media=m_intro&track=S1` | Transcribe (if needed) and lay subtitle clips for every clip using that media. |
| `POST /export` body `{"out":"renders/final.mp4","codec":"h264"}` | Render the timeline (codecs: h264, h265, prores, prores4444, vp9, gif). |
| `POST /process?clip=c_x&op=stabilize` | Clip processing — see "Clip processing". |
| `GET /errors` | Module compile errors / runtime errors from your code. **Check after writing modules.** |

## Workflow rules
1. Read `project.shdw.json` before editing it; keep it valid JSON; write the whole file back.
2. Never delete user media files. Don't rename existing ids.
3. After writing/altering a motion module or clip: `GET /errors`, then render a frame or a contact
   sheet with `/frame` or `/frames` and look at it. Iterate until it looks great.
4. When the user refers to "this clip"/"selected", use `GET /state` → `selection`.
5. Keep answers short: say what you changed.
