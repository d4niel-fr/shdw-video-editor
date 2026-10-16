// GLSL library: every built-in effect / transition / blend mode / grade.
// All textures are premultiplied alpha, uv origin bottom-left.

export const VS = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main(){ v_uv = a_pos*0.5+0.5; gl_Position = vec4(a_pos,0.0,1.0); }`;

export const HEAD = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 v_uv;
out vec4 outColor;
float hash(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
float vnoise(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.0-2.0*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),u.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),u.x), u.y); }
float luma(vec3 c){ return dot(c, vec3(0.2126,0.7152,0.0722)); }
vec4 unpremul(vec4 c){ return c.a > 1e-5 ? vec4(c.rgb/c.a, c.a) : vec4(0.0); }
`;

// ---------------- copy / fit ----------------
export const FS_FIT = HEAD + `
uniform sampler2D src; uniform vec2 uSrcSize; uniform vec2 uDstSize; uniform vec4 uCrop; uniform vec2 uFlip; uniform float uFill;
void main(){
  vec2 p = gl_FragCoord.xy;
  float s = uFill > 0.5 ? max(uDstSize.x/uSrcSize.x, uDstSize.y/uSrcSize.y) : min(uDstSize.x/uSrcSize.x, uDstSize.y/uSrcSize.y);
  vec2 size = uSrcSize*s; vec2 off = (uDstSize-size)*0.5;
  vec2 uv = (p-off)/size;
  if (uFlip.x > 0.5) uv.x = 1.0-uv.x;
  if (uFlip.y > 0.5) uv.y = 1.0-uv.y;
  // crop: l, r, t, b (t = top = high uv.y)
  if (uv.x < uCrop.x || uv.x > 1.0-uCrop.y || uv.y > 1.0-uCrop.z || uv.y < uCrop.w || uv.x<0.0||uv.y<0.0||uv.x>1.0||uv.y>1.0) { outColor = vec4(0); return; }
  outColor = texture(src, uv);
}`;

export const FS_COPY = HEAD + `
uniform sampler2D src; uniform float uOpacity;
void main(){ outColor = texture(src, v_uv) * uOpacity; }`;

export const FS_SOLID = HEAD + `
uniform vec4 uColor; void main(){ outColor = vec4(uColor.rgb*uColor.a, uColor.a); }`;

export const FS_GRADIENT = HEAD + `
uniform vec3 uColors[8]; uniform int uCount; uniform float uAngle; uniform float uRadial; uniform vec2 uSize;
void main(){
  vec2 uv = v_uv; float t;
  if (uRadial > 0.5) { vec2 d = (uv-0.5)*vec2(uSize.x/uSize.y,1.0); t = clamp(length(d)*1.4,0.0,1.0); }
  else { float a = radians(uAngle); vec2 dir = vec2(sin(a), -cos(a)); vec2 d = vec2(uv.x-0.5, 0.5-uv.y); t = clamp(dot(d, dir)/ (abs(dir.x)*0.5+abs(dir.y)*0.5) *0.5+0.5, 0.0, 1.0); }
  float f = t*float(uCount-1); int i = int(floor(f)); float k = fract(f);
  vec3 c = uColors[0];
  for (int j=0;j<7;j++){ if (j==i) c = mix(uColors[j], uColors[j+1], k); }
  if (i >= uCount-1) c = uColors[uCount-1];
  outColor = vec4(c, 1.0);
}`;

// ---------------- compositing ----------------
const BLEND_LIB = `
float Lum(vec3 c){ return dot(c, vec3(0.3,0.59,0.11)); }
vec3 ClipColor(vec3 c){ float l=Lum(c); float n=min(min(c.r,c.g),c.b); float x=max(max(c.r,c.g),c.b);
  if(n<0.0) c = l+(c-l)*l/(l-n+1e-6); if(x>1.0) c = l+(c-l)*(1.0-l)/(x-l+1e-6); return c; }
vec3 SetLum(vec3 c, float l){ return ClipColor(c + (l-Lum(c))); }
float Sat(vec3 c){ return max(max(c.r,c.g),c.b)-min(min(c.r,c.g),c.b); }
vec3 SetSat(vec3 c, float s){ float mx=max(max(c.r,c.g),c.b), mn=min(min(c.r,c.g),c.b); return mx>mn ? (c-mn)*s/(mx-mn) : vec3(0.0); }
float softL(float b, float s){ float d = b<=0.25 ? ((16.0*b-12.0)*b+4.0)*b : sqrt(b);
  return s<=0.5 ? b-(1.0-2.0*s)*b*(1.0-b) : b+(2.0*s-1.0)*(d-b); }
float dodge(float b, float s){ return b==0.0?0.0: s>=1.0?1.0: min(1.0, b/(1.0-s)); }
float burn(float b, float s){ return b>=1.0?1.0: s<=0.0?0.0: 1.0-min(1.0,(1.0-b)/s); }
float hardL(float b, float s){ return s<=0.5 ? b*2.0*s : 1.0-(1.0-b)*(1.0-(2.0*s-1.0)); }
float vivid(float b, float s){ return s<=0.5 ? burn(b, 2.0*s) : dodge(b, 2.0*(s-0.5)); }
float pinL(float b, float s){ return s<=0.5 ? min(b, 2.0*s) : max(b, 2.0*(s-0.5)); }
`;

export const BLEND_FUNCS: Record<string, string> = {
  normal: "return s;",
  multiply: "return b*s;",
  screen: "return b+s-b*s;",
  overlay: "return vec3(hardL(s.r,b.r),hardL(s.g,b.g),hardL(s.b,b.b));",
  softLight: "return vec3(softL(b.r,s.r),softL(b.g,s.g),softL(b.b,s.b));",
  hardLight: "return vec3(hardL(b.r,s.r),hardL(b.g,s.g),hardL(b.b,s.b));",
  colorDodge: "return vec3(dodge(b.r,s.r),dodge(b.g,s.g),dodge(b.b,s.b));",
  colorBurn: "return vec3(burn(b.r,s.r),burn(b.g,s.g),burn(b.b,s.b));",
  darken: "return min(b,s);",
  lighten: "return max(b,s);",
  difference: "return abs(b-s);",
  exclusion: "return b+s-2.0*b*s;",
  add: "return min(b+s, vec3(1.0));",
  subtract: "return max(b-s, vec3(0.0));",
  divide: "return min(b/max(s,vec3(1e-4)), vec3(1.0));",
  linearLight: "return clamp(b+2.0*s-1.0, 0.0, 1.0);",
  vividLight: "return vec3(vivid(b.r,s.r),vivid(b.g,s.g),vivid(b.b,s.b));",
  pinLight: "return vec3(pinL(b.r,s.r),pinL(b.g,s.g),pinL(b.b,s.b));",
  hue: "return SetLum(SetSat(s, Sat(b)), Lum(b));",
  saturation: "return SetLum(SetSat(b, Sat(s)), Lum(b));",
  color: "return SetLum(s, Lum(b));",
  luminosity: "return SetLum(b, Lum(s));",
};
export const BLEND_NAMES = Object.keys(BLEND_FUNCS);

/** Composite shader. `body` is either a built-in blend body or a user `vec3 blend(vec3,vec3)` function. */
export function compositeFS(body: string, custom = false) {
  return HEAD + BLEND_LIB + (custom ? body + "\nvec3 blendFn(vec3 b, vec3 s){ return blend(b, s); }" : `vec3 blendFn(vec3 b, vec3 s){ ${body} }`) + `
uniform sampler2D uBase; uniform sampler2D uLayer; uniform mat3 uInv; uniform vec2 uSize; uniform float uOpacity;
void main(){
  vec2 p = gl_FragCoord.xy;
  vec4 base = texture(uBase, p/uSize);
  vec2 lp = (uInv * vec3(p, 1.0)).xy / uSize;
  vec4 top = (lp.x<0.0||lp.y<0.0||lp.x>1.0||lp.y>1.0) ? vec4(0.0) : texture(uLayer, lp);
  top *= uOpacity;
  float as = top.a, ab = base.a;
  vec3 Cs = as > 1e-5 ? top.rgb/as : vec3(0.0);
  vec3 Cb = ab > 1e-5 ? base.rgb/ab : vec3(0.0);
  vec3 B = clamp(blendFn(Cb, Cs), 0.0, 1.0);
  vec3 co = top.rgb*(1.0-ab) + base.rgb*(1.0-as) + as*ab*B;
  outColor = vec4(co, as + ab*(1.0-as));
}`;
}

// ---------------- color grade ----------------
export const FS_GRADE = HEAD + `
uniform sampler2D src; uniform sampler3D uLut; uniform float uHasLut; uniform float uLutMix; uniform float uLutSize;
uniform float uExposure, uContrast, uPivot, uSaturation, uTemp, uTint, uHue, uVibrance, uHigh, uShadow;
uniform vec3 uLift, uGamma, uGain, uOffset;
vec3 hueRotate(vec3 c, float a){ const vec3 k = vec3(0.57735); float ca=cos(a); return c*ca + cross(k,c)*sin(a) + k*dot(k,c)*(1.0-ca); }
void main(){
  vec4 px = texture(src, v_uv); if (px.a < 1e-5) { outColor = vec4(0); return; }
  vec3 c = px.rgb/px.a;
  c *= exp2(uExposure);
  c *= vec3(1.0 + uTemp*0.25, 1.0 - uTint*0.2, 1.0 - uTemp*0.25) ;
  c += uOffset;
  c = c*(1.0+uGain) + uLift*(1.0-c);
  c = pow(max(c, vec3(0.0)), 1.0/max(vec3(0.05), 1.0+uGamma));
  float l = luma(c);
  c += uShadow * (1.0-smoothstep(0.0, 0.5, l)) * 0.5;
  c += uHigh * smoothstep(0.5, 1.0, l) * 0.5;
  c = (c - uPivot)*uContrast + uPivot;
  if (abs(uHue) > 1e-4) c = hueRotate(c, radians(uHue));
  l = luma(c);
  float sat = max(max(c.r,c.g),c.b) - min(min(c.r,c.g),c.b);
  c = mix(vec3(l), c, uSaturation * (1.0 + uVibrance*(1.0-sat)));
  c = clamp(c, 0.0, 1.0);
  if (uHasLut > 0.5) { vec3 lc = texture(uLut, c*((uLutSize-1.0)/uLutSize) + 0.5/uLutSize).rgb; c = mix(c, lc, uLutMix); }
  outColor = vec4(c*px.a, px.a);
}`;

// ---------------- effects ----------------
export interface ParamSpec { type: "number" | "color" | "bool" | "text" | "select"; default: any; min?: number; max?: number; step?: number; options?: string[] }
export interface BuiltinEffect { name: string; params: Record<string, ParamSpec>; glsl: string; passes?: Record<string, number[] | number>[]; extend?: boolean }

const n = (d: number, min = 0, max = 1, step?: number): ParamSpec => ({ type: "number", default: d, min, max, step });
const col = (d: string): ParamSpec => ({ type: "color", default: d });

const BLUR_PASS = `
uniform vec2 uDir;
vec4 blur1(sampler2D t, vec2 uv, float r){ if(r<0.5) return texture(t,uv);
  vec2 d = uDir/iResolution.xy*(r/12.0); vec4 a=vec4(0); float w=0.0;
  for(int i=-12;i<=12;i++){ float x=float(i); float g=exp(-x*x/72.0); a+=texture(t,uv+d*x)*g; w+=g; } return a/w; }`;

export const EFFECTS: Record<string, BuiltinEffect> = {
  gaussianBlur: { name: "Gaussian Blur", params: { radius: n(12, 0, 200) }, passes: [{ uDir: [1, 0] }, { uDir: [0, 1] }],
    glsl: BLUR_PASS + `vec4 effect(vec2 uv){ return blur1(src, uv, u_radius); }` },
  directionalBlur: { name: "Directional Blur", params: { length: n(30, 0, 300), angle: n(0, -180, 180) },
    glsl: `vec4 effect(vec2 uv){ float a=radians(u_angle); vec2 d=vec2(cos(a),sin(a))*u_length/iResolution.xy; vec4 c=vec4(0);
      for(int i=0;i<32;i++){ c+=texture(src, uv + d*(float(i)/31.0-0.5)); } return c/32.0; }` },
  zoomBlur: { name: "Zoom Blur", params: { amount: n(0.15, 0, 1), cx: n(0.5), cy: n(0.5) },
    glsl: `vec4 effect(vec2 uv){ vec2 c=vec2(u_cx,1.0-u_cy); vec4 a=vec4(0); for(int i=0;i<32;i++){ float s=1.0-u_amount*float(i)/31.0; a+=texture(src, c+(uv-c)*s);} return a/32.0; }` },
  sharpen: { name: "Sharpen", params: { amount: n(0.6, 0, 3) },
    glsl: `vec4 effect(vec2 uv){ vec2 p=1.0/iResolution.xy; vec4 c=texture(src,uv);
      vec4 b=(texture(src,uv+vec2(p.x,0))+texture(src,uv-vec2(p.x,0))+texture(src,uv+vec2(0,p.y))+texture(src,uv-vec2(0,p.y)))*0.25;
      return vec4(clamp(c.rgb+(c.rgb-b.rgb)*u_amount*2.0, 0.0, c.a), c.a); }` },
  vignette: { name: "Vignette", params: { amount: n(0.5), softness: n(0.45, 0.01, 1) },
    glsl: `vec4 effect(vec2 uv){ vec4 c=texture(src,uv); vec2 d=(uv-0.5)*vec2(iResolution.x/iResolution.y,1.0); float v=smoothstep(0.85, 0.85-u_softness, length(d)*1.2);
      c.rgb *= mix(1.0, v, u_amount); return c; }` },
  glow: { name: "Glow", params: { radius: n(30, 0, 200), strength: n(1, 0, 4), threshold: n(0.6) }, passes: [{ uDir: [1, 0], uPass: 0 }, { uDir: [0, 1], uPass: 1 }],
    glsl: BLUR_PASS + `uniform float uPass;
      vec4 effect(vec2 uv){ if(uPass<0.5){ vec2 d=uDir/iResolution.xy*(u_radius/12.0); vec4 a=vec4(0); float w=0.0;
          for(int i=-12;i<=12;i++){ float x=float(i); float g=exp(-x*x/72.0); vec4 s=texture(src,uv+d*x); vec3 cs = s.a>0.0? s.rgb/s.a : vec3(0);
            float k=smoothstep(u_threshold, u_threshold+0.15, luma(cs)); a+=vec4(s.rgb*k, s.a*k)*g; w+=g; } return a/w; }
        vec4 g = blur1(src, uv, u_radius); vec4 o = texture(orig, uv); return vec4(o.rgb + g.rgb*u_strength, clamp(o.a + g.a*u_strength, 0.0, 1.0)); }` },
  chromaticAberration: { name: "Chromatic Aberration", params: { amount: n(0.004, 0, 0.05, 0.0005) },
    glsl: `vec4 effect(vec2 uv){ vec2 d=(uv-0.5)*u_amount*2.0; vec4 c=texture(src,uv); return vec4(texture(src,uv+d).r, c.g, texture(src,uv-d).b, c.a); }` },
  filmGrain: { name: "Film Grain", params: { amount: n(0.12, 0, 1), size: n(1.5, 0.5, 6) },
    glsl: `vec4 effect(vec2 uv){ vec4 c=texture(src,uv); float g=hash(floor(uv*iResolution.xy/u_size)+fract(iTime*24.0)*91.7)-0.5; c.rgb += g*u_amount*c.a; return c; }` },
  pixelate: { name: "Pixelate", params: { size: n(24, 1, 200) },
    glsl: `vec4 effect(vec2 uv){ vec2 s=u_size/iResolution.xy; return texture(src, (floor(uv/s)+0.5)*s); }` },
  mirror: { name: "Mirror", params: { mode: n(0, 0, 3, 1) },
    glsl: `vec4 effect(vec2 uv){ int m=int(u_mode); if(m==0&&uv.x>0.5) uv.x=1.0-uv.x; if(m==1&&uv.x<0.5) uv.x=1.0-uv.x; if(m==2&&uv.y<0.5) uv.y=1.0-uv.y; if(m==3){ uv=abs(uv-0.5)*-1.0+0.5; } return texture(src,uv); }` },
  posterize: { name: "Posterize", params: { levels: n(5, 2, 32, 1) },
    glsl: `vec4 effect(vec2 uv){ vec4 c=unpremul(texture(src,uv)); c.rgb=floor(c.rgb*u_levels)/(u_levels-1.0); return vec4(c.rgb*c.a,c.a); }` },
  invert: { name: "Invert", params: {}, glsl: `vec4 effect(vec2 uv){ vec4 c=texture(src,uv); return vec4(c.a-c.rgb, c.a); }` },
  hueShift: { name: "Hue Shift", params: { degrees: n(90, -180, 180) },
    glsl: `vec4 effect(vec2 uv){ vec4 c=texture(src,uv); const vec3 k=vec3(0.57735); float a=radians(u_degrees); float ca=cos(a); c.rgb=c.rgb*ca+cross(k,c.rgb)*sin(a)+k*dot(k,c.rgb)*(1.0-ca); return c; }` },
  blackWhite: { name: "Black & White", params: { contrast: n(1.1, 0.5, 2) },
    glsl: `vec4 effect(vec2 uv){ vec4 c=unpremul(texture(src,uv)); float l=clamp((luma(c.rgb)-0.5)*u_contrast+0.5,0.0,1.0); return vec4(vec3(l)*c.a,c.a); }` },
  sepia: { name: "Sepia", params: { amount: n(1) },
    glsl: `vec4 effect(vec2 uv){ vec4 c=texture(src,uv); vec3 s=vec3(dot(c.rgb,vec3(.393,.769,.189)),dot(c.rgb,vec3(.349,.686,.168)),dot(c.rgb,vec3(.272,.534,.131))); c.rgb=mix(c.rgb,min(s,vec3(c.a)),u_amount); return c; }` },
  glitch: { name: "Digital Glitch", params: { amount: n(0.5), speed: n(1, 0, 5) },
    glsl: `vec4 effect(vec2 uv){ float t=floor(iTime*12.0*u_speed); float row=floor(uv.y*24.0); float r=hash(vec2(row,t));
      if(r<u_amount*0.6) uv.x += (hash(vec2(t,row*1.3))-0.5)*0.2*u_amount; float sh=0.012*u_amount*(hash(vec2(t,7.0))-0.5)*4.0;
      vec4 c=texture(src,uv); return vec4(texture(src,uv+vec2(sh,0)).r, c.g, texture(src,uv-vec2(sh,0)).b, c.a); }` },
  rgbSplit: { name: "RGB Split", params: { amount: n(0.01, 0, 0.1, 0.001), angle: n(0, -180, 180) },
    glsl: `vec4 effect(vec2 uv){ float a=radians(u_angle); vec2 d=vec2(cos(a),sin(a))*u_amount; vec4 c=texture(src,uv); vec4 r=texture(src,uv+d), b=texture(src,uv-d);
      return vec4(r.r, c.g, b.b, max(c.a,max(r.a,b.a))); }` },
  lensDistortion: { name: "Lens Distortion", params: { amount: n(0.2, -1, 1) },
    glsl: `vec4 effect(vec2 uv){ vec2 d=uv-0.5; float r2=dot(d,d); vec2 u=0.5+d*(1.0+u_amount*r2*1.5); if(u.x<0.0||u.y<0.0||u.x>1.0||u.y>1.0) return vec4(0); return texture(src,u); }` },
  edgeDetect: { name: "Edge Detect", params: {},
    glsl: `vec4 effect(vec2 uv){ vec2 p=1.0/iResolution.xy; float tl=luma(texture(src,uv+p*vec2(-1,1)).rgb), t=luma(texture(src,uv+p*vec2(0,1)).rgb), tr=luma(texture(src,uv+p*vec2(1,1)).rgb),
      l=luma(texture(src,uv+p*vec2(-1,0)).rgb), r=luma(texture(src,uv+p*vec2(1,0)).rgb), bl=luma(texture(src,uv+p*vec2(-1,-1)).rgb), b=luma(texture(src,uv+p*vec2(0,-1)).rgb), br=luma(texture(src,uv+p*vec2(1,-1)).rgb);
      float gx=-tl-2.0*l-bl+tr+2.0*r+br, gy=-tl-2.0*t-tr+bl+2.0*b+br; float e=clamp(length(vec2(gx,gy)),0.0,1.0); float a=texture(src,uv).a; return vec4(vec3(e)*a,a); }` },
  chromaKey: { name: "Chroma Key", params: { color: col("#00ff00"), similarity: n(0.32), smoothness: n(0.08), spill: n(0.5) },
    glsl: `vec2 toUV(vec3 c){ return vec2(-0.169*c.r-0.331*c.g+0.5*c.b, 0.5*c.r-0.419*c.g-0.081*c.b); }
      vec4 effect(vec2 uv){ vec4 c=unpremul(texture(src,uv)); float d=distance(toUV(c.rgb), toUV(u_color));
        float a=smoothstep(u_similarity, u_similarity+u_smoothness, d); float sp=clamp(pow(clamp(d-u_similarity,0.0,1.0)/max(u_spill,1e-3),1.5),0.0,1.0);
        float l=luma(c.rgb); vec3 rgb=mix(vec3(l), c.rgb, sp); float o=c.a*a; return vec4(rgb*o, o); }` },
  lumaKey: { name: "Luma Key", params: { low: n(0.0), high: n(0.25), invert: { type: "bool", default: false } },
    glsl: `vec4 effect(vec2 uv){ vec4 c=texture(src,uv); vec3 s=c.a>0.0?c.rgb/c.a:vec3(0); float k=smoothstep(u_low,u_high,luma(s)); if(u_invert>0.5) k=1.0-k; return c*k; }` },
  letterbox: { name: "Letterbox", params: { ratio: n(2.39, 1, 4, 0.01) },
    glsl: `vec4 effect(vec2 uv){ float h=(iResolution.x/u_ratio)/iResolution.y; if(abs(uv.y-0.5)>h*0.5) return vec4(0,0,0,1); return texture(src,uv); }` },
  cameraShake: { name: "Camera Shake", params: { amount: n(0.01, 0, 0.1, 0.001), speed: n(6, 0, 30) },
    glsl: `vec4 effect(vec2 uv){ float t=iTime*u_speed; vec2 o=vec2(vnoise(vec2(t,1.3))-0.5, vnoise(vec2(4.1,t))-0.5)*2.0*u_amount; vec2 c=(uv-0.5)/(1.0+u_amount*2.5)+0.5; return texture(src, c+o); }` },
  vhs: { name: "VHS", params: { amount: n(0.6) },
    glsl: `vec4 effect(vec2 uv){ float t=iTime; float j=(vnoise(vec2(uv.y*80.0, t*20.0))-0.5)*0.004*u_amount; uv.x+=j; float band=step(0.98, fract(uv.y*3.0 - t*0.2))*0.01*u_amount; uv.x+=band;
      vec4 c=texture(src,uv); float r=texture(src,uv+vec2(0.004*u_amount,0)).r; float b=texture(src,uv-vec2(0.004*u_amount,0)).b; vec3 o=vec3(r,c.g,b);
      o += (hash(uv*iResolution.xy+t)-0.5)*0.12*u_amount*c.a; o *= 0.95+0.05*sin(uv.y*iResolution.y*1.5); return vec4(o, c.a); }` },
  halftone: { name: "Halftone", params: { size: n(10, 2, 60) },
    glsl: `vec4 effect(vec2 uv){ vec2 px=uv*iResolution.xy; float a=0.785; mat2 R=mat2(cos(a),-sin(a),sin(a),cos(a)); vec2 g=R*px; vec2 cell=(floor(g/u_size)+0.5)*u_size; vec2 cuv=(inverse(R)*cell)/iResolution.xy;
      vec4 c=unpremul(texture(src,cuv)); float r=(1.0-luma(c.rgb))*u_size*0.6; float d=length(g-cell); float k=1.0-smoothstep(r-1.0,r+1.0,d); vec3 col=mix(vec3(1),vec3(0),k); return vec4(col*c.a,c.a); }` },
  scanlines: { name: "Scanlines", params: { amount: n(0.35), count: n(400, 50, 2000) },
    glsl: `vec4 effect(vec2 uv){ vec4 c=texture(src,uv); c.rgb*=1.0-u_amount*(0.5+0.5*sin(uv.y*u_count*3.14159)); return c; }` },
  threshold: { name: "Threshold", params: { level: n(0.5) },
    glsl: `vec4 effect(vec2 uv){ vec4 c=unpremul(texture(src,uv)); float v=step(u_level, luma(c.rgb)); return vec4(vec3(v)*c.a,c.a); }` },
  emboss: { name: "Emboss", params: { amount: n(1, 0, 4) },
    glsl: `vec4 effect(vec2 uv){ vec2 p=1.0/iResolution.xy; vec4 c=texture(src,uv); float e=luma(texture(src,uv-p).rgb)-luma(texture(src,uv+p).rgb); return vec4(vec3(0.5+e*u_amount*2.0)*c.a, c.a); }` },
  wave: { name: "Wave Warp", params: { amount: n(0.01, 0, 0.1, 0.001), frequency: n(12, 1, 80), speed: n(2, 0, 20) },
    glsl: `vec4 effect(vec2 uv){ uv.x += sin(uv.y*u_frequency + iTime*u_speed)*u_amount; uv.y += cos(uv.x*u_frequency*0.7 + iTime*u_speed)*u_amount*0.5; return texture(src,uv); }` },
  kaleidoscope: { name: "Kaleidoscope", params: { segments: n(6, 2, 24, 1) },
    glsl: `vec4 effect(vec2 uv){ vec2 d=uv-0.5; d.x*=iResolution.x/iResolution.y; float r=length(d); float a=atan(d.y,d.x); float s=6.28318/u_segments; a=mod(a,s); a=abs(a-s*0.5);
      vec2 u=vec2(cos(a),sin(a))*r; u.x/=iResolution.x/iResolution.y; return texture(src, u+0.5); }` },
  dropShadow: { name: "Drop Shadow", params: { x: n(12, -200, 200), y: n(12, -200, 200), blur: n(16, 0, 100), opacity: n(0.6) },
    glsl: `vec4 effect(vec2 uv){ vec2 o=vec2(u_x,-u_y)/iResolution.xy; float a=0.0; float w=0.0; for(int i=-3;i<=3;i++) for(int j=-3;j<=3;j++){ vec2 q=vec2(float(i),float(j)); float g=exp(-dot(q,q)/8.0);
      a+=texture(src, uv-o+q*u_blur/6.0/iResolution.xy).a*g; w+=g; } a=a/w*u_opacity; vec4 c=texture(src,uv); return c + vec4(0,0,0,a)*(1.0-c.a); }` },
  tint: { name: "Tint", params: { color: col("#5e8bff"), amount: n(0.5) },
    glsl: `vec4 effect(vec2 uv){ vec4 c=texture(src,uv); vec3 t=luma(c.rgb)*u_color*1.4; c.rgb=mix(c.rgb, min(t, vec3(c.a)), u_amount); return c; }` },
  duotone: { name: "Duotone", params: { dark: col("#1b1464"), light: col("#ff7a59") },
    glsl: `vec4 effect(vec2 uv){ vec4 c=unpremul(texture(src,uv)); vec3 o=mix(u_dark,u_light,smoothstep(0.0,1.0,luma(c.rgb))); return vec4(o*c.a,c.a); }` },
  bloom: { name: "Bloom (soft)", params: { radius: n(60, 0, 200), strength: n(0.6, 0, 3), threshold: n(0.75) }, passes: [{ uDir: [1, 0], uPass: 0 }, { uDir: [0, 1], uPass: 1 }],
    glsl: "" },
  colorBalance: { name: "Color Balance", params: { shadows: col("#000000"), highlights: col("#000000"), amount: n(0.5) },
    glsl: `vec4 effect(vec2 uv){ vec4 c=unpremul(texture(src,uv)); float l=luma(c.rgb); c.rgb += (u_shadows-0.0)*(1.0-l)*u_amount + u_highlights*l*u_amount; return vec4(clamp(c.rgb,0.0,1.0)*c.a, c.a); }` },
  transform2: { name: "Spin", params: { speed: n(30, -720, 720) },
    glsl: `vec4 effect(vec2 uv){ float a=radians(iTime*u_speed); vec2 d=(uv-0.5)*vec2(iResolution.x/iResolution.y,1.0); d=mat2(cos(a),-sin(a),sin(a),cos(a))*d; d.x/=iResolution.x/iResolution.y; return texture(src,d+0.5); }` },
};
EFFECTS.bloom.glsl = EFFECTS.glow.glsl;

export function effectFS(glsl: string, uniforms: string) {
  return HEAD + `uniform sampler2D src; uniform sampler2D orig; uniform vec3 iResolution; uniform float iTime;\n${uniforms}\n${glsl}\nvoid main(){ outColor = effect(v_uv); }`;
}

// ---------------- transitions (gl-transitions convention) ----------------
const ease = `float eio(float x){ return x<0.5 ? 4.0*x*x*x : 1.0-pow(-2.0*x+2.0,3.0)/2.0; }`;
export const TRANSITIONS: Record<string, { name: string; glsl: string; duration?: number }> = {
  crossDissolve: { name: "Cross Dissolve", glsl: `vec4 transition(vec2 uv){ return mix(getFromColor(uv), getToColor(uv), progress); }` },
  dipToBlack: { name: "Dip to Black", glsl: `vec4 transition(vec2 uv){ vec4 k=vec4(0,0,0,1); return progress<0.5? mix(getFromColor(uv),k,progress*2.0) : mix(k,getToColor(uv),progress*2.0-1.0); }` },
  dipToWhite: { name: "Dip to White", glsl: `vec4 transition(vec2 uv){ vec4 k=vec4(1); return progress<0.5? mix(getFromColor(uv),k,progress*2.0) : mix(k,getToColor(uv),progress*2.0-1.0); }` },
  additiveDissolve: { name: "Additive Dissolve", glsl: `vec4 transition(vec2 uv){ return clamp(getFromColor(uv)*min(1.0,2.0-2.0*progress) + getToColor(uv)*min(1.0,2.0*progress), 0.0, 1.0); }` },
  wipeLeft: { name: "Wipe Left", glsl: `vec4 transition(vec2 uv){ return mix(getFromColor(uv), getToColor(uv), smoothstep(1.0-progress-0.01, 1.0-progress+0.01, uv.x)); }` },
  wipeRight: { name: "Wipe Right", glsl: `vec4 transition(vec2 uv){ return mix(getToColor(uv), getFromColor(uv), smoothstep(progress-0.01, progress+0.01, uv.x)); }` },
  wipeUp: { name: "Wipe Up", glsl: `vec4 transition(vec2 uv){ return mix(getToColor(uv), getFromColor(uv), smoothstep(progress-0.01, progress+0.01, uv.y)); }` },
  wipeDown: { name: "Wipe Down", glsl: `vec4 transition(vec2 uv){ return mix(getFromColor(uv), getToColor(uv), smoothstep(1.0-progress-0.01, 1.0-progress+0.01, uv.y)); }` },
  slideLeft: { name: "Slide Left", glsl: ease + `vec4 transition(vec2 uv){ float p=eio(progress); return uv.x > 1.0-p ? getToColor(uv - vec2(1.0-p,0)) : getFromColor(uv); }` },
  slideRight: { name: "Slide Right", glsl: ease + `vec4 transition(vec2 uv){ float p=eio(progress); return uv.x < p ? getToColor(uv + vec2(1.0-p,0)) : getFromColor(uv); }` },
  slideUp: { name: "Slide Up", glsl: ease + `vec4 transition(vec2 uv){ float p=eio(progress); return uv.y < p ? getToColor(uv + vec2(0,1.0-p)) : getFromColor(uv); }` },
  slideDown: { name: "Slide Down", glsl: ease + `vec4 transition(vec2 uv){ float p=eio(progress); return uv.y > 1.0-p ? getToColor(uv - vec2(0,1.0-p)) : getFromColor(uv); }` },
  pushLeft: { name: "Push Left", glsl: ease + `vec4 transition(vec2 uv){ float p=eio(progress); vec2 a=uv+vec2(p,0); return a.x<1.0 ? getFromColor(a) : getToColor(a-vec2(1,0)); }` },
  pushRight: { name: "Push Right", glsl: ease + `vec4 transition(vec2 uv){ float p=eio(progress); vec2 a=uv-vec2(p,0); return a.x>0.0 ? getFromColor(a) : getToColor(a+vec2(1,0)); }` },
  zoomIn: { name: "Zoom In", glsl: ease + `vec4 transition(vec2 uv){ float p=eio(progress); vec4 a=getFromColor(0.5+(uv-0.5)/(1.0+p*1.5)); vec4 b=getToColor(0.5+(uv-0.5)*(1.6-0.6*p)); return mix(a,b,smoothstep(0.3,0.8,progress)); }` },
  zoomOut: { name: "Zoom Out", glsl: ease + `vec4 transition(vec2 uv){ float p=eio(progress); vec4 a=getFromColor(0.5+(uv-0.5)*(1.0+p*0.6)); vec4 b=getToColor(0.5+(uv-0.5)/(1.0+(1.0-p)*1.5)); return mix(a,b,smoothstep(0.3,0.8,progress)); }` },
  crashZoom: { name: "Crash Zoom", glsl: `vec4 transition(vec2 uv){ float s=sin(progress*3.14159); vec4 c=vec4(0); for(int i=0;i<24;i++){ float k=1.0-s*0.35*float(i)/23.0; vec2 u=0.5+(uv-0.5)*k/(1.0+s*1.2);
      c += progress<0.5 ? getFromColor(u) : getToColor(u); } c/=24.0; return mix(c, vec4(1), pow(s,8.0)*0.6); }` },
  blurDissolve: { name: "Blur Dissolve", glsl: `vec4 transition(vec2 uv){ float r=sin(progress*3.14159)*0.025; vec4 a=vec4(0), b=vec4(0); for(int i=0;i<16;i++){ float an=float(i)*2.39996; vec2 o=vec2(cos(an),sin(an))*r*sqrt(float(i)/16.0);
      a+=getFromColor(uv+o); b+=getToColor(uv+o);} return mix(a,b,progress)/16.0; }` },
  irisCircle: { name: "Iris Circle", glsl: `vec4 transition(vec2 uv){ vec2 d=(uv-0.5)*vec2(ratio,1.0); float r=progress*length(vec2(ratio,1.0))*0.5; return mix(getToColor(uv), getFromColor(uv), smoothstep(r-0.005, r+0.005, length(d))); }` },
  irisDiamond: { name: "Iris Diamond", glsl: `vec4 transition(vec2 uv){ vec2 d=abs(uv-0.5); float r=progress*1.0; return mix(getToColor(uv), getFromColor(uv), smoothstep(r-0.005,r+0.005,d.x+d.y)); }` },
  clockWipe: { name: "Clock Wipe", glsl: `vec4 transition(vec2 uv){ vec2 d=uv-0.5; float a=atan(d.x, d.y)/6.28318+0.5; return a < progress ? getToColor(uv) : getFromColor(uv); }` },
  barnDoor: { name: "Barn Door", glsl: `vec4 transition(vec2 uv){ return abs(uv.x-0.5) < progress*0.5 ? getToColor(uv) : getFromColor(uv); }` },
  whipPan: { name: "Whip Pan", glsl: ease + `vec4 transition(vec2 uv){ float p=eio(progress); float s=sin(progress*3.14159); vec4 c=vec4(0); for(int i=0;i<32;i++){ float o=(float(i)/31.0-0.5)*s*0.35; vec2 a=uv+vec2(p+o,0);
      c += a.x<1.0 ? getFromColor(vec2(a.x,a.y)) : getToColor(vec2(a.x-1.0,a.y)); } return c/32.0; }` },
  spin: { name: "Spin", glsl: ease + `vec4 transition(vec2 uv){ float p=eio(progress); float a=p*6.28318; vec2 d=(uv-0.5)*vec2(ratio,1.0); float z=1.0+sin(progress*3.14159)*1.5; d=mat2(cos(a),-sin(a),sin(a),cos(a))*d*z; d.x/=ratio; vec2 u=d+0.5;
      return progress<0.5 ? getFromColor(fract(u)) : getToColor(fract(u)); }` },
  glitch: { name: "Glitch", glsl: `vec4 transition(vec2 uv){ float s=sin(progress*3.14159); float row=floor(uv.y*30.0); float r=hash(vec2(row, floor(progress*20.0)));
      vec2 u=uv+vec2((r-0.5)*0.3*s*step(0.6,r),0); vec4 a=progress<0.5?getFromColor(u):getToColor(u); vec4 b=progress<0.5?getFromColor(u+vec2(0.02*s,0)):getToColor(u+vec2(0.02*s,0));
      return vec4(b.r,a.g,a.b,a.a); }` },
  rgbSplit: { name: "RGB Split", glsl: `vec4 transition(vec2 uv){ float s=sin(progress*3.14159)*0.06; vec4 a=mix(getFromColor(uv+vec2(s,0)),getToColor(uv+vec2(s,0)),progress); vec4 b=mix(getFromColor(uv),getToColor(uv),progress); vec4 c=mix(getFromColor(uv-vec2(s,0)),getToColor(uv-vec2(s,0)),progress); return vec4(a.r,b.g,c.b,b.a); }` },
  pixelDissolve: { name: "Pixelize", glsl: `vec4 transition(vec2 uv){ float s=sin(progress*3.14159); float n=max(1.0, floor(s*60.0)); vec2 sz=vec2(n/ (800.0*ratio), n/800.0); vec2 u = s>0.02 ? (floor(uv/sz)+0.5)*sz : uv; return mix(getFromColor(u),getToColor(u),smoothstep(0.4,0.6,progress)); }` },
  noiseDissolve: { name: "Noise Dissolve", glsl: `vec4 transition(vec2 uv){ float n=vnoise(uv*60.0)*0.5+hash(uv*400.0)*0.5; return mix(getFromColor(uv), getToColor(uv), smoothstep(n-0.05, n+0.05, progress*1.1)); }` },
  lumaFade: { name: "Luma Fade", glsl: `vec4 transition(vec2 uv){ float l=luma(getFromColor(uv).rgb); return mix(getFromColor(uv), getToColor(uv), smoothstep(l-0.1, l+0.1, progress*1.2-0.1)); }` },
  filmBurn: { name: "Film Burn", glsl: `vec4 transition(vec2 uv){ float s=sin(progress*3.14159); float n=vnoise(uv*3.0+progress*4.0); vec3 burn=vec3(1.0,0.45,0.1)*smoothstep(0.3,1.0,n+s*0.8)*s*2.0;
      vec4 b=mix(getFromColor(uv),getToColor(uv),smoothstep(0.35,0.65,progress)); return vec4(min(b.rgb+burn,vec3(1.0)), b.a); }` },
  lightLeak: { name: "Light Leak", glsl: `vec4 transition(vec2 uv){ float s=sin(progress*3.14159); float g=smoothstep(0.0,1.0,1.0-abs(uv.x - (progress*1.6-0.3))*1.8); vec3 leak=mix(vec3(1.0,0.35,0.1), vec3(1.0,0.85,0.5), uv.y)*g*s*1.5;
      vec4 b=mix(getFromColor(uv),getToColor(uv),progress); return vec4(min(b.rgb+leak,vec3(1.0)), b.a); }` },
  squeeze: { name: "Squeeze", glsl: ease + `vec4 transition(vec2 uv){ float p=eio(progress); if(uv.x < 1.0-p){ return getFromColor(vec2(uv.x/(1.0-p), uv.y)); } return getToColor(vec2((uv.x-(1.0-p))/max(p,1e-4), uv.y)); }` },
  cube: { name: "Cube", glsl: ease + `vec4 transition(vec2 uv){ float p=eio(progress); float w1=1.0-p; if(uv.x<w1){ float x=uv.x/w1; float sh=1.0-0.25*p*(x); vec2 u=vec2(x, (uv.y-0.5)/(1.0-0.15*p*x)+0.5); vec4 c=getFromColor(u); c.rgb*=1.0-0.5*p; return (u.y<0.0||u.y>1.0)?vec4(0,0,0,1):c; }
      float x=(uv.x-w1)/max(p,1e-4); vec2 u=vec2(x,(uv.y-0.5)/(1.0-0.15*(1.0-p)*(1.0-x))+0.5); vec4 c=getToColor(u); c.rgb*=0.5+0.5*p; return (u.y<0.0||u.y>1.0)?vec4(0,0,0,1):c; }` },
  pageSlide: { name: "Page Slide", glsl: ease + `vec4 transition(vec2 uv){ float p=eio(progress); float edge=1.0-p; if(uv.x>edge) return getToColor(uv-vec2(edge,0)); vec4 c=getFromColor(uv); c.rgb*=1.0-0.6*smoothstep(edge-0.08,edge,uv.x)*p; return c; }` },
  ripple: { name: "Ripple", glsl: `vec4 transition(vec2 uv){ vec2 d=uv-0.5; float l=length(d); float s=sin(progress*3.14159); vec2 o=d/l*sin(l*60.0-progress*30.0)*0.03*s; return mix(getFromColor(uv+o), getToColor(uv+o), progress); }` },
  smoothZoomBlur: { name: "Smooth Zoom", glsl: ease + `vec4 transition(vec2 uv){ float p=eio(progress); float s=sin(progress*3.14159)*0.25; vec4 c=vec4(0); for(int i=0;i<20;i++){ float k=1.0-s*float(i)/19.0; vec2 u=0.5+(uv-0.5)*k; c+=mix(getFromColor(u),getToColor(u),p); } return c/20.0; }` },
};
export const TRANSITION_NAMES = Object.keys(TRANSITIONS);

export function transitionFS(glsl: string, uniforms: string) {
  return HEAD + `uniform sampler2D uFrom; uniform sampler2D uTo; uniform float progress; uniform float ratio; uniform float iTime; uniform vec3 iResolution;
vec4 getFromColor(vec2 uv){ return texture(uFrom, uv); }
vec4 getToColor(vec2 uv){ return texture(uTo, uv); }
${uniforms}
${glsl}
void main(){ outColor = transition(v_uv); }`;
}

export function motionFS(glsl: string, uniforms: string) {
  return HEAD + `uniform vec3 iResolution; uniform float iTime; uniform float iProgress; uniform float iDuration; uniform float iFrame; uniform vec4 iMouse;
${uniforms}
${glsl}
void main(){ vec4 c = vec4(0); mainImage(c, gl_FragCoord.xy); outColor = c; }`;
}
