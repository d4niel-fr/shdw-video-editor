// Built-in motion graphics templates. Each is a standalone shdw motion module.
// When used they are copied into the project's motion/ folder so the agent
// (or the user) can freely edit them.

export interface Template { id: string; name: string; category: string; duration: number; code: string; preview: string; kind?: "js" | "html" }

export const TEMPLATES: Template[] = [
  {
    id: "kinetic-title", name: "Kinetic Title", category: "Titles", duration: 4, preview: "linear-gradient(135deg,#111,#333)",
    code: `export default {
  name: "Kinetic Title",
  duration: 4,
  params: {
    text: { type: "text", default: "Think different." },
    subtitle: { type: "text", default: "Introducing shdw" },
    color: { type: "color", default: "#f5f5f7" },
    accent: { type: "color", default: "#0a84ff" },
    size: { type: "number", default: 168, min: 20, max: 500 },
  },
  render(ctx, t, api) {
    const { width: W, height: H, params: p, kit, duration } = api;
    const out = kit.clamp((duration - t) / 0.45);
    const words = p.text.split(" ");
    ctx.save();
    ctx.globalAlpha = kit.ease.outCubic(out);
    const font = { size: p.size, weight: 700, font: "Inter", tracking: -0.035 };
    const widths = words.map((w) => kit.measure(ctx, w + " ", font).width);
    const total = widths.reduce((a, b) => a + b, 0);
    let x = W / 2 - total / 2;
    words.forEach((w, i) => {
      const k = kit.spring(t - 0.12 - i * 0.075, 1, 0.55);
      ctx.save();
      ctx.globalAlpha *= kit.clamp(k * 1.4);
      const blur = (1 - kit.clamp(k)) * 18;
      if (blur > 0.3) ctx.filter = "blur(" + blur + "px)";
      kit.text(ctx, w, x + widths[i] / 2, H / 2 - p.size * 0.12 + (1 - k) * p.size * 0.5, { ...font, color: p.color });
      ctx.restore();
      x += widths[i];
    });
    const k2 = kit.spring(t - 0.55, 1, 0.6);
    ctx.globalAlpha *= kit.clamp(k2);
    kit.text(ctx, p.subtitle.toUpperCase(), W / 2, H / 2 + p.size * 0.62 + (1 - k2) * 20, { size: p.size * 0.17, weight: 600, tracking: 0.18, color: p.accent });
    const lw = kit.ease.inOutCubic(kit.seq(t, 0.4, 1.2)) * total * 0.35;
    ctx.fillStyle = p.accent;
    kit.roundRect(ctx, W / 2 - lw / 2, H / 2 + p.size * 0.42, lw, 4, 2);
    ctx.fill();
    ctx.restore();
  },
};
`,
  },
  {
    id: "lower-third", name: "Glass Lower Third", category: "Lower Thirds", duration: 5, preview: "linear-gradient(90deg,#2a2a33 40%,#0a84ff)",
    code: `export default {
  name: "Glass Lower Third",
  duration: 5,
  params: {
    name: { type: "text", default: "Tim Cook" },
    role: { type: "text", default: "Chief Executive Officer" },
    accent: { type: "color", default: "#0a84ff" },
    x: { type: "number", default: 0.07, min: 0, max: 1 },
    y: { type: "number", default: 0.8, min: 0, max: 1 },
  },
  render(ctx, t, api) {
    const { width: W, height: H, params: p, kit, duration } = api;
    const s = H / 1080;
    const inK = kit.spring(t, 1, 0.5), outK = kit.spring(duration - t - 0.05, 1, 0.4);
    const k = Math.min(inK, outK);
    const nameF = { size: 54 * s, weight: 700, tracking: -0.02, align: "left" };
    const roleF = { size: 30 * s, weight: 500, tracking: 0.01, align: "left" };
    const w = Math.max(kit.measure(ctx, p.name, nameF).width, kit.measure(ctx, p.role, roleF).width) + 76 * s;
    const h = 136 * s, x = W * p.x, y = H * p.y - h / 2;
    ctx.save();
    ctx.globalAlpha = kit.clamp(k * 1.3);
    ctx.translate(x + (1 - k) * -60 * s, y);
    ctx.shadowColor = "rgba(0,0,0,0.45)"; ctx.shadowBlur = 40 * s; ctx.shadowOffsetY = 12 * s;
    kit.roundRect(ctx, 0, 0, w * kit.ease.outExpo(kit.clamp(k)), h, 26 * s);
    ctx.fillStyle = "rgba(30,30,36,0.72)"; ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.strokeStyle = "rgba(255,255,255,0.14)"; ctx.lineWidth = 1.5 * s; ctx.stroke();
    ctx.fillStyle = p.accent;
    kit.roundRect(ctx, 22 * s, 26 * s, 6 * s, (h - 52 * s) * kit.ease.outCubic(kit.seq(t, 0.15, 0.6)), 3 * s); ctx.fill();
    ctx.clip();
    const tk = kit.spring(t - 0.18, 1, 0.5);
    ctx.globalAlpha *= kit.clamp(tk);
    kit.text(ctx, p.name, 46 * s, 50 * s + (1 - tk) * 20 * s, { ...nameF, color: "#fff" });
    const rk = kit.spring(t - 0.3, 1, 0.5);
    kit.text(ctx, p.role, 46 * s, 96 * s + (1 - rk) * 20 * s, { ...roleF, color: "rgba(235,235,245,0.7)" });
    ctx.restore();
  },
};
`,
  },
  {
    id: "mesh-gradient", name: "Mesh Gradient (GPU)", category: "Backgrounds", duration: 10, preview: "radial-gradient(circle at 30% 30%,#5e5ce6,#0a0a20 60%),#ff375f",
    code: `export default {
  name: "Mesh Gradient",
  duration: 10,
  params: {
    c1: { type: "color", default: "#5e5ce6" },
    c2: { type: "color", default: "#ff375f" },
    c3: { type: "color", default: "#0a84ff" },
    bg: { type: "color", default: "#07071a" },
    speed: { type: "number", default: 0.25, min: 0, max: 2 },
    grain: { type: "number", default: 0.04, min: 0, max: 0.2 },
  },
  fragment: \`
    float blob(vec2 uv, vec2 c, float r){ return exp(-dot(uv-c,uv-c)/(r*r)); }
    void mainImage(out vec4 fragColor, in vec2 fragCoord){
      vec2 uv = fragCoord/iResolution.xy; uv.x *= iResolution.x/iResolution.y;
      float t = iTime*u_speed;
      vec2 p1 = vec2(0.5+0.45*sin(t*1.1), 0.5+0.35*cos(t*0.9));
      vec2 p2 = vec2(1.2+0.4*cos(t*0.7), 0.4+0.3*sin(t*1.3));
      vec2 p3 = vec2(0.9+0.5*sin(t*0.5+2.0), 0.8+0.25*cos(t*1.7));
      vec3 col = u_bg;
      col = mix(col, u_c1, blob(uv,p1,0.55));
      col = mix(col, u_c2, blob(uv,p2,0.5)*0.9);
      col = mix(col, u_c3, blob(uv,p3,0.45)*0.85);
      col += (hash(fragCoord+fract(iTime)*100.0)-0.5)*u_grain;
      fragColor = vec4(col,1.0);
    }\`,
};
`,
  },
  {
    id: "counter", name: "Number Counter", category: "Data", duration: 3, preview: "linear-gradient(135deg,#0d2,#063)",
    code: `export default {
  name: "Number Counter",
  duration: 3,
  params: {
    from: { type: "number", default: 0, min: -1e9, max: 1e9 },
    to: { type: "number", default: 1000000, min: -1e9, max: 1e9 },
    prefix: { type: "text", default: "" },
    suffix: { type: "text", default: "+" },
    label: { type: "text", default: "Downloads" },
    decimals: { type: "number", default: 0, min: 0, max: 4, step: 1 },
    color: { type: "color", default: "#ffffff" },
    accent: { type: "color", default: "#30d158" },
  },
  render(ctx, t, api) {
    const { width: W, height: H, params: p, kit, duration } = api;
    const k = kit.ease.outExpo(kit.seq(t, 0.1, duration * 0.75));
    const v = p.from + (p.to - p.from) * k;
    const str = p.prefix + v.toLocaleString("en-US", { minimumFractionDigits: p.decimals, maximumFractionDigits: p.decimals }) + p.suffix;
    const a = kit.spring(t, 1, 0.5);
    ctx.globalAlpha = kit.clamp(a) * kit.clamp((duration - t) / 0.3);
    kit.text(ctx, str, W / 2, H / 2 - 20, { size: H * 0.17, weight: 800, tracking: -0.04, color: p.color, font: "Inter" });
    kit.text(ctx, p.label.toUpperCase(), W / 2, H / 2 + H * 0.12, { size: H * 0.028, weight: 600, tracking: 0.2, color: p.accent });
  },
};
`,
  },
  {
    id: "word-captions", name: "Karaoke Captions", category: "Captions", duration: 4, preview: "linear-gradient(90deg,#222,#ffd60a)",
    code: `export default {
  name: "Karaoke Captions",
  duration: 4,
  params: {
    text: { type: "text", default: "Every word lights up as it is spoken" },
    color: { type: "color", default: "#ffffff" },
    highlight: { type: "color", default: "#ffd60a" },
    size: { type: "number", default: 78, min: 20, max: 200 },
    y: { type: "number", default: 0.78, min: 0, max: 1 },
  },
  render(ctx, t, api) {
    const { width: W, height: H, params: p, kit, duration } = api;
    const words = kit.splitWords(p.text);
    const per = duration / Math.max(1, words.length);
    const f = { size: p.size * H / 1080, weight: 800, tracking: -0.01 };
    const space = kit.measure(ctx, " ", f).width;
    const ws = words.map((w) => kit.measure(ctx, w, f).width);
    // wrap into lines
    const maxW = W * 0.8; const lines = [[]]; let lw = 0;
    words.forEach((w, i) => { if (lw + ws[i] > maxW && lines[lines.length - 1].length) { lines.push([]); lw = 0; } lines[lines.length - 1].push(i); lw += ws[i] + space; });
    const lh = f.size * 1.2;
    lines.forEach((ln, li) => {
      const total = ln.reduce((a, i) => a + ws[i] + space, -space);
      let x = W / 2 - total / 2;
      const y = H * p.y + (li - (lines.length - 1) / 2) * lh;
      ln.forEach((i) => {
        const active = t >= i * per && t < (i + 1) * per;
        const k = kit.spring(t - i * per, 0.7, 0.3);
        ctx.save();
        ctx.translate(x + ws[i] / 2, y);
        const sc = active ? 1 + 0.08 * kit.clamp(k) : 1;
        ctx.scale(sc, sc);
        ctx.globalAlpha = t >= i * per - 0.05 ? 1 : 0.45;
        kit.text(ctx, words[i], 0, 0, { ...f, color: active ? p.highlight : p.color, stroke: "rgba(0,0,0,0.85)", strokeWidth: f.size * 0.14 });
        ctx.restore();
        x += ws[i] + space;
      });
    });
  },
};
`,
  },
  {
    id: "bar-chart", name: "Animated Bar Chart", category: "Data", duration: 5, preview: "linear-gradient(0deg,#0a84ff 30%,#111 30%)",
    code: `export default {
  name: "Animated Bar Chart",
  duration: 5,
  params: {
    title: { type: "text", default: "Revenue growth" },
    values: { type: "text", default: "12,19,27,34,48,61" },
    labels: { type: "text", default: "2020,2021,2022,2023,2024,2025" },
    color: { type: "color", default: "#0a84ff" },
    highlight: { type: "color", default: "#30d158" },
  },
  render(ctx, t, api) {
    const { width: W, height: H, params: p, kit, duration } = api;
    const vals = p.values.split(",").map(Number); const labs = p.labels.split(",");
    const max = Math.max(...vals);
    const cw = W * 0.6, ch = H * 0.5, x0 = (W - cw) / 2, y0 = H * 0.78;
    const out = kit.clamp((duration - t) / 0.4);
    ctx.globalAlpha = out;
    const tk = kit.spring(t, 1, 0.5);
    ctx.globalAlpha = out * kit.clamp(tk);
    kit.text(ctx, p.title, W / 2, H * 0.18 + (1 - tk) * 20, { size: H * 0.055, weight: 700, tracking: -0.02, color: "#fff" });
    const bw = cw / vals.length * 0.62;
    vals.forEach((v, i) => {
      const k = kit.spring(t - 0.3 - i * 0.09, 1, 0.6);
      const bh = (v / max) * ch * kit.clamp(k, 0, 1.2);
      const x = x0 + (i + 0.5) * (cw / vals.length) - bw / 2;
      ctx.globalAlpha = out;
      ctx.fillStyle = i === vals.length - 1 ? p.highlight : p.color;
      kit.roundRect(ctx, x, y0 - bh, bw, bh, Math.min(10, bw / 4)); ctx.fill();
      ctx.globalAlpha = out * kit.clamp(k);
      kit.text(ctx, String(Math.round(v * kit.clamp(k))), x + bw / 2, y0 - bh - H * 0.025, { size: H * 0.026, weight: 700, color: "#fff" });
      kit.text(ctx, labs[i] ?? "", x + bw / 2, y0 + H * 0.035, { size: H * 0.022, weight: 500, color: "rgba(235,235,245,0.6)" });
    });
    ctx.globalAlpha = out * 0.3; ctx.fillStyle = "#fff"; ctx.fillRect(x0, y0, cw * kit.ease.outCubic(kit.seq(t, 0, 0.6)), 2);
  },
};
`,
  },
  {
    id: "logo-reveal", name: "Logo Reveal", category: "Openers", duration: 4, preview: "radial-gradient(circle,#fff 10%,#000 40%)",
    code: `export default {
  name: "Logo Reveal",
  duration: 4,
  params: {
    text: { type: "text", default: "shdw" },
    tagline: { type: "text", default: "edit at the speed of thought" },
    logo: { type: "text", default: "" },
    color: { type: "color", default: "#ffffff" },
    ring: { type: "color", default: "#bf5af2" },
  },
  render(ctx, t, api) {
    const { width: W, height: H, params: p, kit, duration } = api;
    const cx = W / 2, cy = H / 2, R = H * 0.16;
    const out = kit.clamp((duration - t) / 0.5);
    ctx.globalAlpha = out;
    // expanding rings
    for (let i = 0; i < 3; i++) {
      const k = kit.ease.outExpo(kit.seq(t, i * 0.12, 1.4 + i * 0.12));
      ctx.strokeStyle = p.ring; ctx.lineWidth = 3 * (1 - k) + 0.5;
      ctx.globalAlpha = out * (1 - k) * 0.8;
      ctx.beginPath(); ctx.arc(cx, cy, R * (0.4 + k * 2.4), 0, kit.TAU); ctx.stroke();
    }
    ctx.globalAlpha = out;
    const k = kit.spring(t - 0.2, 0.75, 0.6);
    const img = p.logo ? api.image(p.logo) : null;
    ctx.save(); ctx.translate(cx, cy - H * 0.04); ctx.scale(k, k);
    if (img) { const s = (R * 1.6) / Math.max(img.width, img.height); ctx.drawImage(img, -img.width * s / 2, -img.height * s / 2, img.width * s, img.height * s); }
    else kit.text(ctx, p.text, 0, 0, { size: H * 0.16, weight: 800, tracking: -0.05, color: p.color });
    ctx.restore();
    const tk = kit.spring(t - 0.8, 1, 0.5);
    ctx.globalAlpha = out * kit.clamp(tk);
    kit.text(ctx, p.tagline, cx, cy + H * 0.12 + (1 - tk) * 16, { size: H * 0.03, weight: 500, tracking: 0.04, color: "rgba(235,235,245,0.7)" });
  },
};
`,
  },
  {
    id: "light-rays", name: "Light Rays (GPU)", category: "Backgrounds", duration: 8, preview: "conic-gradient(from 0deg,#000,#ffcc66,#000,#ffcc66,#000)",
    code: `export default {
  name: "Light Rays",
  duration: 8,
  params: {
    color: { type: "color", default: "#ffcf7a" },
    intensity: { type: "number", default: 0.9, min: 0, max: 3 },
    speed: { type: "number", default: 0.3, min: 0, max: 3 },
    originY: { type: "number", default: 1.15, min: -0.5, max: 1.5 },
  },
  fragment: \`
    void mainImage(out vec4 fragColor, in vec2 fragCoord){
      vec2 uv = fragCoord/iResolution.xy;
      vec2 o = vec2(0.5, u_originY);
      vec2 d = uv - o; d.x *= iResolution.x/iResolution.y;
      float a = atan(d.x, -d.y);
      float r = vnoise(vec2(a*12.0, iTime*u_speed))*0.6 + vnoise(vec2(a*31.0, iTime*u_speed*1.7))*0.4;
      float fall = exp(-length(d)*1.6);
      float v = pow(r, 3.0) * fall * u_intensity;
      vec3 c = u_color * v;
      fragColor = vec4(c, clamp(v,0.0,1.0));
    }\`,
};
`,
  },
  {
    id: "particles", name: "Bokeh Particles", category: "Backgrounds", duration: 10, preview: "radial-gradient(circle at 20% 40%,#ffb34766 8%,transparent 9%),radial-gradient(circle at 70% 60%,#5e8bff66 10%,transparent 11%),#0b0b12",
    code: `export default {
  name: "Bokeh Particles",
  duration: 10,
  params: {
    count: { type: "number", default: 60, min: 1, max: 300, step: 1 },
    colorA: { type: "color", default: "#ffb347" },
    colorB: { type: "color", default: "#5e8bff" },
    size: { type: "number", default: 60, min: 4, max: 300 },
    drift: { type: "number", default: 30, min: 0, max: 300 },
  },
  render(ctx, t, api) {
    const { width: W, height: H, params: p, kit } = api;
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < p.count; i++) {
      const r1 = kit.rand(i * 3.1), r2 = kit.rand(i * 7.7), r3 = kit.rand(i * 1.9), r4 = kit.rand(i * 5.3);
      const x = (r1 * W + Math.sin(t * 0.3 + i) * p.drift + t * p.drift * (r4 - 0.5)) % W;
      const y = (r2 * H - t * p.drift * (0.3 + r3)) % H;
      const yy = y < 0 ? y + H : y;
      const s = p.size * (0.3 + r3);
      const tw = 0.5 + 0.5 * Math.sin(t * (0.6 + r4) + i);
      const g = ctx.createRadialGradient(x, yy, 0, x, yy, s);
      const c = kit.mixColor(p.colorA, p.colorB, r4);
      g.addColorStop(0, c + "aa"); g.addColorStop(0.6, c + "33"); g.addColorStop(1, c + "00");
      ctx.globalAlpha = 0.35 + 0.65 * tw;
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, yy, s, 0, kit.TAU); ctx.fill();
    }
  },
};
`,
  },
  {
    id: "typewriter-code", name: "Code Typewriter", category: "Titles", duration: 6, preview: "linear-gradient(135deg,#1e1e1e,#2d2d2d)",
    code: `export default {
  name: "Code Typewriter",
  duration: 6,
  params: {
    code: { type: "text", default: "const shdw = await edit({\\n  agent: 'claude',\\n  vibe: 'cinematic',\\n});" },
    accent: { type: "color", default: "#64d2ff" },
  },
  render(ctx, t, api) {
    const { width: W, height: H, params: p, kit, duration } = api;
    const s = H / 1080;
    const w = 1100 * s, h = 420 * s, x = (W - w) / 2, y = (H - h) / 2;
    const k = kit.spring(t, 1, 0.5);
    ctx.globalAlpha = kit.clamp(k) * kit.clamp((duration - t) / 0.4);
    ctx.save(); ctx.translate(0, (1 - k) * 40 * s);
    ctx.shadowColor = "rgba(0,0,0,0.6)"; ctx.shadowBlur = 60 * s; ctx.shadowOffsetY = 20 * s;
    kit.roundRect(ctx, x, y, w, h, 22 * s); ctx.fillStyle = "rgba(28,28,32,0.92)"; ctx.fill(); ctx.shadowColor = "transparent";
    ctx.strokeStyle = "rgba(255,255,255,0.1)"; ctx.stroke();
    ["#ff5f57", "#febc2e", "#28c840"].forEach((c, i) => { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(x + 32 * s + i * 24 * s, y + 30 * s, 7 * s, 0, kit.TAU); ctx.fill(); });
    const shown = kit.typewriter(p.code, kit.seq(t, 0.4, duration * 0.7));
    const lines = shown.split("\\n");
    ctx.font = 600 + " " + 34 * s + "px Consolas, 'SF Mono', monospace"; ctx.textBaseline = "top";
    lines.forEach((ln, i) => {
      let cx = x + 40 * s;
      for (const tok of ln.split(/(\\s+|[{}(),:;])/)) {
        ctx.fillStyle = /^(const|await|let|return|function)$/.test(tok) ? "#ff7ab2" : /^'.*'?$/.test(tok) ? "#fc6a5d" : /[{}(),:;]/.test(tok) ? "#aaa" : tok.endsWith("(") ? p.accent : "#e6e6eb";
        ctx.fillText(tok, cx, y + 80 * s + i * 52 * s); cx += ctx.measureText(tok).width;
      }
      if (i === lines.length - 1 && Math.floor(t * 2.2) % 2 === 0) { ctx.fillStyle = p.accent; ctx.fillRect(cx + 2, y + 80 * s + i * 52 * s, 16 * s, 38 * s); }
    });
    ctx.restore();
  },
};
`,
  },
  {
    id: "callout", name: "Pointer Callout", category: "Annotations", duration: 4, preview: "linear-gradient(135deg,#222,#ff9f0a)",
    code: `export default {
  name: "Pointer Callout",
  duration: 4,
  params: {
    label: { type: "text", default: "New feature" },
    targetX: { type: "number", default: 0.62, min: 0, max: 1 },
    targetY: { type: "number", default: 0.45, min: 0, max: 1 },
    boxX: { type: "number", default: 0.78, min: 0, max: 1 },
    boxY: { type: "number", default: 0.25, min: 0, max: 1 },
    color: { type: "color", default: "#ff9f0a" },
  },
  render(ctx, t, api) {
    const { width: W, height: H, params: p, kit, duration } = api;
    const s = H / 1080;
    const out = kit.clamp((duration - t) / 0.35);
    const tx = p.targetX * W, ty = p.targetY * H, bx = p.boxX * W, by = p.boxY * H;
    ctx.globalAlpha = out;
    const d = kit.spring(t, 0.6, 0.5);
    ctx.fillStyle = p.color;
    ctx.beginPath(); ctx.arc(tx, ty, 12 * s * d, 0, kit.TAU); ctx.fill();
    ctx.strokeStyle = p.color; ctx.lineWidth = 3 * s; ctx.globalAlpha = out * (1 - kit.seq(t % 1.2, 0, 1.2));
    ctx.beginPath(); ctx.arc(tx, ty, 12 * s + 40 * s * kit.seq(t % 1.2, 0, 1.2), 0, kit.TAU); ctx.stroke();
    ctx.globalAlpha = out;
    const lk = kit.ease.inOutCubic(kit.seq(t, 0.15, 0.7));
    ctx.lineWidth = 3 * s; ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(tx + (bx - tx) * lk, ty + (by - ty) * lk); ctx.stroke();
    const bk = kit.spring(t - 0.6, 1, 0.45);
    const f = { size: 40 * s, weight: 700, color: "#111" };
    const w = kit.measure(ctx, p.label, f).width + 48 * s;
    ctx.save(); ctx.translate(bx, by); ctx.scale(bk, bk); ctx.globalAlpha = out * kit.clamp(bk);
    kit.roundRect(ctx, -w / 2, -36 * s, w, 72 * s, 36 * s); ctx.fillStyle = p.color; ctx.fill();
    kit.text(ctx, p.label, 0, 2 * s, f);
    ctx.restore();
  },
};
`,
  },
  {
    id: "grid-bg", name: "Perspective Grid (GPU)", category: "Backgrounds", duration: 10, preview: "linear-gradient(180deg,#120024,#ff2bd6)",
    code: `export default {
  name: "Perspective Grid",
  duration: 10,
  params: {
    line: { type: "color", default: "#ff2bd6" },
    sky: { type: "color", default: "#120024" },
    speed: { type: "number", default: 1, min: 0, max: 5 },
  },
  fragment: \`
    void mainImage(out vec4 fragColor, in vec2 fragCoord){
      vec2 uv = fragCoord/iResolution.xy;
      vec3 col = mix(u_sky*0.4, u_sky, uv.y);
      float hz = 0.42;
      if (uv.y < hz) {
        float z = 1.0/(hz-uv.y+0.001);
        vec2 g = vec2((uv.x-0.5)*z*1.2, z + iTime*u_speed*2.0);
        vec2 f = abs(fract(g)-0.5);
        float l = smoothstep(0.03*z*0.06+0.02, 0.0, min(f.x,f.y));
        col = mix(col*0.2, u_line, l*clamp(1.0-z*0.02,0.0,1.0));
      }
      col += u_line * exp(-abs(uv.y-hz)*40.0) * 0.8;
      vec2 sc = uv-vec2(0.5,0.62); sc.x *= iResolution.x/iResolution.y;
      float sun = smoothstep(0.2,0.19,length(sc)) * step(0.0, sin(uv.y*120.0)+ (uv.y-0.5)*8.0);
      col = mix(col, mix(vec3(1.0,0.85,0.2), u_line, 1.0-(uv.y-0.42)*3.0), sun*step(hz,uv.y));
      fragColor = vec4(col,1.0);
    }\`,
};
`,
  },
  {
    id: "countdown", name: "Countdown", category: "Openers", duration: 4, preview: "linear-gradient(135deg,#ff375f,#5e5ce6)",
    code: `export default {
  name: "Countdown",
  duration: 4,
  params: {
    from: { type: "number", default: 3, min: 1, max: 60, step: 1 },
    color: { type: "color", default: "#ffffff" },
    ring: { type: "color", default: "#ff375f" },
  },
  render(ctx, t, api) {
    const { width: W, height: H, params: p, kit, duration } = api;
    const per = duration / p.from;
    const n = Math.max(1, p.from - Math.floor(t / per));
    const lt = t % per;
    const R = H * 0.2;
    ctx.lineWidth = H * 0.012; ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(255,255,255,0.12)"; ctx.beginPath(); ctx.arc(W / 2, H / 2, R, 0, kit.TAU); ctx.stroke();
    ctx.strokeStyle = p.ring; ctx.beginPath(); ctx.arc(W / 2, H / 2, R, -Math.PI / 2, -Math.PI / 2 + kit.TAU * (1 - lt / per)); ctx.stroke();
    const k = kit.spring(lt, 0.65, 0.35);
    ctx.save(); ctx.translate(W / 2, H / 2); ctx.scale(0.6 + 0.4 * k, 0.6 + 0.4 * k); ctx.globalAlpha = kit.clamp(k);
    kit.text(ctx, String(n), 0, H * 0.01, { size: H * 0.22, weight: 800, tracking: -0.04, color: p.color });
    ctx.restore();
  },
};
`,
  },
  {
    id: "film-frame", name: "Cinematic Letterbox Title", category: "Titles", duration: 5, preview: "linear-gradient(180deg,#000 18%,#333 18%,#333 82%,#000 82%)",
    code: `export default {
  name: "Cinematic Letterbox Title",
  duration: 5,
  params: {
    title: { type: "text", default: "CHAPTER ONE" },
    sub: { type: "text", default: "The beginning" },
    bars: { type: "number", default: 0.12, min: 0, max: 0.3 },
  },
  render(ctx, t, api) {
    const { width: W, height: H, params: p, kit, duration } = api;
    const bk = kit.ease.inOutCubic(kit.seq(t, 0, 0.8)) * kit.ease.inOutCubic(kit.clamp((duration - t) / 0.8));
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H * p.bars * bk); ctx.fillRect(0, H - H * p.bars * bk, W, H * p.bars * bk);
    const tk = kit.seq(t, 0.6, 2.2);
    ctx.globalAlpha = kit.clamp(tk * 2) * kit.clamp((duration - t - 0.4) / 0.5);
    kit.text(ctx, p.title, W / 2, H / 2 - H * 0.02, { size: H * 0.06, weight: 300, tracking: 0.5 - 0.25 * kit.ease.outCubic(tk), color: "#fff", font: "Georgia" });
    ctx.globalAlpha *= kit.clamp((t - 1.1) / 0.6);
    kit.text(ctx, p.sub, W / 2, H / 2 + H * 0.05, { size: H * 0.026, weight: 400, italic: true, tracking: 0.05, color: "rgba(255,255,255,0.7)", font: "Georgia" });
  },
};
`,
  },
  {
    id: "keynote-reveal", kind: "html", name: "Keynote Reveal (GSAP)", category: "HTML · GSAP", duration: 5, preview: "linear-gradient(100deg,#a78bfa,#5e8bff,#22d3ee)",
    code: `<!doctype html>
<html><head><meta charset="utf-8">
<script src="lib/gsap.min.js"></script>
<script src="lib/SplitText.min.js"></script>
<style>
  html, body { margin: 0; width: 100%; height: 100%; background: transparent; overflow: hidden; }
  body { display: grid; place-items: center; font-family: Inter, "SF Pro Display", "Segoe UI Variable Display", system-ui, sans-serif; color: #f5f5f7; }
  .wrap { text-align: center; }
  h1 { font-size: 9vw; font-weight: 700; letter-spacing: -0.045em; line-height: 1.02; margin: 0; }
  h1 .char { display: inline-block; will-change: transform, filter; }
  p { font-size: 2vw; font-weight: 500; margin: 2vw 0 0; background: linear-gradient(100deg, var(--accent, #a78bfa), #5e8bff 50%, #22d3ee); -webkit-background-clip: text; color: transparent; }
</style></head>
<body>
  <div class="wrap"><h1 id="title">Pro. Beyond.</h1><p id="sub">The most powerful editor we have ever made.</p></div>
<script>
  gsap.registerPlugin(SplitText);
  let tl, built = "";
  function build() {
    const p = shdw.params;
    document.getElementById("title").textContent = p.title ?? "Pro. Beyond.";
    document.getElementById("sub").textContent = p.subtitle ?? "The most powerful editor we have ever made.";
    if (tl) tl.kill();
    const split = new SplitText("#title", { type: "chars", charsClass: "char" });
    const end = Math.max(1.5, shdw.duration - 0.55);
    tl = gsap.timeline({ paused: true })
      .from(split.chars, { yPercent: 115, opacity: 0, filter: "blur(14px)", duration: 1.15, ease: "expo.out", stagger: 0.032 })
      .from("#sub", { y: 28, opacity: 0, duration: 0.9, ease: "power3.out" }, 0.55)
      .fromTo(".wrap", { scale: 0.96 }, { scale: 1, duration: shdw.duration, ease: "none" }, 0)
      .to(".wrap", { opacity: 0, y: -18, filter: "blur(8px)", duration: 0.5, ease: "power2.in" }, end);
    built = JSON.stringify(p) + shdw.duration;
  }
  shdw.onFrame((t) => {
    if (built !== JSON.stringify(shdw.params) + shdw.duration) build();
    tl.time(t);
  });
</script>
</body></html>
`,
  },
  {
    id: "stat-ring", kind: "html", name: "Stat Ring (SVG draw)", category: "HTML · GSAP", duration: 4, preview: "conic-gradient(#30d158 0 72%,#222 72%)",
    code: `<!doctype html>
<html><head><meta charset="utf-8">
<script src="lib/gsap.min.js"></script>
<script src="lib/DrawSVGPlugin.min.js"></script>
<style>
  html, body { margin: 0; width: 100%; height: 100%; background: transparent; overflow: hidden; font-family: Inter, "SF Pro Display", system-ui, sans-serif; }
  .stage { position: absolute; inset: 0; display: grid; place-items: center; }
  svg { width: 34vh; height: 34vh; overflow: visible; }
  .num { position: absolute; text-align: center; color: #fff; }
  .num b { display: block; font-size: 10vh; font-weight: 800; letter-spacing: -0.04em; font-variant-numeric: tabular-nums; }
  .num span { font-size: 2.4vh; font-weight: 600; letter-spacing: 0.18em; text-transform: uppercase; color: var(--color, #30d158); }
</style></head>
<body>
<div class="stage">
  <svg viewBox="0 0 200 200">
    <circle cx="100" cy="100" r="88" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="10"/>
    <circle id="ring" cx="100" cy="100" r="88" fill="none" stroke="var(--color, #30d158)" stroke-width="10" stroke-linecap="round" transform="rotate(-90 100 100)"/>
  </svg>
  <div class="num"><b id="val">0%</b><span id="label">Faster renders</span></div>
</div>
<script>
  gsap.registerPlugin(DrawSVGPlugin);
  let tl, built = "";
  const counter = { v: 0 };
  function build() {
    const p = shdw.params, target = p.value ?? 72;
    document.getElementById("label").textContent = p.label ?? "Faster renders";
    if (tl) tl.kill();
    tl = gsap.timeline({ paused: true })
      .from(".stage", { scale: 0.85, opacity: 0, duration: 0.7, ease: "back.out(1.6)" })
      .fromTo("#ring", { drawSVG: "0%" }, { drawSVG: target + "%", duration: 1.6, ease: "expo.out" }, 0.15)
      .fromTo(counter, { v: 0 }, { v: target, duration: 1.6, ease: "expo.out", onUpdate: () => (document.getElementById("val").textContent = Math.round(counter.v) + "%") }, 0.15)
      .to(".stage", { opacity: 0, scale: 0.95, duration: 0.4, ease: "power2.in" }, Math.max(2, shdw.duration - 0.4));
    built = JSON.stringify(p) + shdw.duration;
  }
  shdw.onFrame((t) => { if (built !== JSON.stringify(shdw.params) + shdw.duration) build(); tl.time(t); });
</script>
</body></html>
`,
  },
];

export const TEMPLATE_CATEGORIES = [...new Set(TEMPLATES.map((t) => t.category))];
