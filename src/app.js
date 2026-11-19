'use strict';
(() => {
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const TAU = Math.PI * 2, DEG = Math.PI / 180;
const srgb2lin = (v) => Math.pow(v / 255, 2.2);
const hexRgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const hexLin = (h) => hexRgb(h).map(srgb2lin);

/* ---------- matrices ---------- */
const Mat = {
  persp(fovy, aspect, n, f) {
    const t = 1 / Math.tan(fovy / 2);
    return new Float32Array([t / aspect, 0, 0, 0, 0, t, 0, 0, 0, 0, (f + n) / (n - f), -1, 0, 0, 2 * f * n / (n - f), 0]);
  },
  ortho(l, r, b, t, n, f) {
    return new Float32Array([2 / (r - l), 0, 0, 0, 0, 2 / (t - b), 0, 0, 0, 0, -2 / (f - n), 0,
      -(r + l) / (r - l), -(t + b) / (t - b), -(f + n) / (f - n), 1]);
  },
  lookAt(e, c, u) {
    const f = norm(sub(c, e)), s = norm(cross(f, u)), v = cross(s, f);
    return new Float32Array([s[0], v[0], -f[0], 0, s[1], v[1], -f[1], 0, s[2], v[2], -f[2], 0,
      -dot(s, e), -dot(v, e), dot(f, e), 1]);
  },
  mul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[r + 4] * b[c * 4 + 1] + a[r + 8] * b[c * 4 + 2] + a[r + 12] * b[c * 4 + 3];
    }
    return o;
  },
};
function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function norm(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }

/* ---------- shaders ---------- */
const LIGHTING = `
uniform vec3 uCam;
uniform mat4 uShadowMat;
uniform highp sampler2DShadow uShadow;
uniform float uShadowR;
uniform vec3 uTip;
uniform float uHotend;
const vec3 KEY = normalize(vec3(-.52, -.62, 1.0));
const vec3 FILL = normalize(vec3(.75, -.25, .45));
const vec3 RIM = normalize(vec3(.25, .9, .35));
const vec2 DISK[12] = vec2[12](vec2(-.326,-.406),vec2(-.840,-.074),vec2(-.696,.457),vec2(-.203,.621),vec2(.962,-.195),vec2(.473,-.480),
  vec2(.519,.767),vec2(.185,-.893),vec2(.507,.064),vec2(.896,.412),vec2(-.322,-.933),vec2(-.792,-.598));
float shadowAt(vec3 P, vec3 N) {
  vec4 c = uShadowMat * vec4(P + N * .14, 1.);
  vec3 p = c.xyz * .5 + .5;
  if (p.x < 0. || p.x > 1. || p.y < 0. || p.y > 1. || p.z > 1.) return 1.;
  float s = 0.;
  for (int i = 0; i < 12; i++) s += texture(uShadow, vec3(p.xy + DISK[i] * uShadowR, p.z - .00018));
  return s / 12.;
}
float capsule(vec3 P, vec3 L, vec3 A, vec3 B, float r) {
  vec3 d = B - A, w = P - A;
  float a = dot(L, L), b = dot(L, d), c = dot(d, d), e = dot(L, w), f = dot(d, w);
  float D = a * c - b * b;
  float t = D < 1e-5 ? f / c : (a * f - b * e) / D;
  t = clamp(t, 0., 1.);
  vec3 Q = A + d * t;
  float s = max(dot(Q - P, L), 0.);
  float dist = length(P + L * s - Q);
  float pen = .5 + s * .05;
  return smoothstep(r - pen, r + pen, dist);
}
float hotendShadow(vec3 P) {
  if (uHotend < .5) return 1.;
  return capsule(P, KEY, uTip + vec3(0, 0, 1), uTip + vec3(0, 0, 4), 3.) *
         capsule(P, KEY, uTip + vec3(0, 3, 9), uTip + vec3(0, 3, 13), 10.) *
         capsule(P, KEY, uTip + vec3(0, 0, 24), uTip + vec3(0, 0, 52), 11.);
}
float dGGX(float NoH, float a) { float a2 = a * a, f = NoH * NoH * (a2 - 1.) + 1.; return a2 / (3.14159 * f * f); }
float vSmith(float NoV, float NoL, float a) { float k = a * .5; return .25 / ((NoV * (1. - k) + k) * (NoL * (1. - k) + k)); }
vec3 lobe(vec3 N, vec3 V, vec3 L, vec3 col, vec3 dif, vec3 F0, float a, float NoV, float wrap) {
  float NoL = dot(N, L);
  float d = max((NoL + wrap) / (1. + wrap), 0.);
  vec3 c = dif * d / 3.14159;
  if (NoL > 0.) {
    vec3 H = normalize(L + V);
    float VoH = max(dot(V, H), 0.);
    vec3 F = F0 + (1. - F0) * pow(1. - VoH, 5.);
    c += dGGX(max(dot(N, H), 0.), a) * vSmith(NoV, NoL, a) * F * NoL;
  }
  return c * col;
}
vec3 shade(vec3 P, vec3 N, vec3 alb, float rough, float metal, float ao) {
  vec3 V = normalize(uCam - P);
  float a = max(rough * rough, .03), NoV = max(dot(N, V), .03);
  vec3 F0 = mix(vec3(.04), alb, metal), dif = alb * (1. - metal);
  float sh = shadowAt(P, N) * hotendShadow(P);
  vec3 col = lobe(N, V, KEY, vec3(3.5, 3.35, 3.15) * sh, dif, F0, a, NoV, .18);
  col += lobe(N, V, FILL, vec3(.75, .82, .95), dif, F0, a, NoV, .3);
  col += lobe(N, V, RIM, vec3(.8, .78, .75), dif, F0, a, NoV, .1);
  col += dif * mix(vec3(.10, .095, .09), vec3(.34, .36, .39), N.z * .5 + .5) * ao * mix(.72, 1., sh);
  vec3 R = reflect(-V, N);
  vec3 env = mix(vec3(.2, .205, .215), vec3(.5, .53, .58), smoothstep(-.2, .9, R.z));
  env += smoothstep(.72, .98, dot(R, normalize(vec3(-.25, -.3, .9)))) * .8 * (1. - rough);
  vec3 F = F0 + (max(vec3(1. - rough), F0) - F0) * pow(1. - NoV, 5.);
  return col + env * F * ao * mix(1., .4, rough);
}
vec3 display(vec3 c) {
  c *= .92;
  c = (c * (2.51 * c + .03)) / (c * (2.43 * c + .59) + .14);
  return pow(clamp(c, 0., 1.), vec3(1. / 2.2));
}`;

const VS_BEAD = `#version 300 es
layout(location=0) in vec4 aM;
layout(location=1) in vec3 aA;
layout(location=2) in vec3 aB;
layout(location=3) in vec2 aS;
uniform mat4 uVP;
uniform int uPartial;
uniform float uFrac;
out vec3 vP; out vec3 vN; out float vAO; out float vTint; out float vH;
void main() {
  vH = aS.y;
  vec3 a = aA, b = aB;
  if (gl_InstanceID == uPartial) b = mix(a, b, uFrac);
  vec3 d = b - a;
  float L = length(d);
  d = L > 1e-5 ? d / L : vec3(1, 0, 0);
  vec3 s = vec3(-d.y, d.x, 0);
  float sl = length(s);
  s = sl > 1e-4 ? s / sl : vec3(1, 0, 0);
  vec3 up = vec3(0, 0, 1);
  float w = aS.x * .5, h = aS.y * .5;
  vec3 p = mix(a, b, aM.x) + s * aM.y * w + up * (aM.z * h - h) + d * aM.w * w;
  vP = p;
  vN = s * aM.y / sqrt(w) + up * aM.z / sqrt(h) + d * aM.w / sqrt(w);
  vAO = smoothstep(-.95, .45, aM.z);
  vTint = 1. + .05 * (fract(aA.z * 53.17) - .5);
  gl_Position = uVP * vec4(p, 1);
}`;
const FS_BEAD = `#version 300 es
precision highp float;
in vec3 vP; in vec3 vN; in float vAO; in float vTint; in float vH;
uniform vec3 uColor; uniform float uRough, uMetal, uSS;
out vec4 o;
${LIGHTING}
void main() {
  // When a layer is thinner than a pixel, fade its fine shading so distant prints do not shimmer
  vec3 V = normalize(uCam - vP);
  float f = smoothstep(.4, 1.8, length(fwidth(vP)) * uSS / vH);
  vec3 N = normalize(normalize(vN) + V * f * .9);
  float ao = mix(mix(.3, 1., vAO), .82, f);
  o = vec4(display(shade(vP, N, uColor * mix(vTint, 1., f), mix(uRough, max(uRough, .6), f), uMetal, ao)), 1);
}`;
const FS_DEPTH = `#version 300 es
precision mediump float;
void main() {}`;

const VS_MESH = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNor;
layout(location=2) in vec3 aCol;
layout(location=3) in vec3 aPbr;
uniform mat4 uVP; uniform vec3 uOffset;
out vec3 vP; out vec3 vN; out vec3 vC; out vec3 vPbr;
void main() { vP = aPos + uOffset; vN = aNor; vC = aCol; vPbr = aPbr; gl_Position = uVP * vec4(vP, 1); }`;
const FS_MESH = `#version 300 es
precision highp float;
in vec3 vP; in vec3 vN; in vec3 vC; in vec3 vPbr;
uniform sampler2D uAlbedo, uGrain;
uniform vec2 uSheetMin, uSheetSize;
uniform float uAOOn;
out vec4 o;
${LIGHTING}
void main() {
  vec3 N = normalize(vN), alb = vC;
  float rough = vPbr.x;
  if (vPbr.z > .5) {
    vec2 uv = (vP.xy - uSheetMin) / uSheetSize; uv.y = 1. - uv.y;
    vec4 t = texture(uAlbedo, uv);
    vec4 g = texture(uGrain, vP.xy / 6.5), g2 = texture(uGrain, vP.xy / 23.);
    vec2 slope = (g.rg - .5) * .55 + (g2.rg - .5) * .35;
    N = normalize(vec3(slope, 1.));
    alb = t.rgb * mix(.82, 1.18, g.b);
    rough = t.a * (.86 + .28 * g2.b);
  }
  o = vec4(display(shade(vP, N, alb, rough, vPbr.y, vPbr.z > .5 ? .5 : 1.)), 1);
}`;

const VS_FS = `#version 300 es
out vec2 vNdc;
void main() { vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); vNdc = p * 2. - 1.; gl_Position = vec4(vNdc, 0, 1); }`;
const FS_BG = `#version 300 es
precision highp float;
in vec2 vNdc;
uniform vec3 uCam, uRight, uUp, uFwd;
uniform float uTan, uAspect, uFloor;
uniform vec2 uBedC, uBedH;
out vec4 o;
void main() {
  vec3 rd = normalize(uFwd + uRight * vNdc.x * uTan * uAspect + uUp * vNdc.y * uTan);
  vec3 col = mix(vec3(.075, .08, .088), vec3(.17, .18, .195), smoothstep(-1., 1.1, vNdc.y));
  if (rd.z < -1e-3) {
    vec3 hit = uCam + rd * (uFloor - uCam.z) / rd.z;
    vec2 q = abs(hit.xy - uBedC - vec2(20, 24)) - uBedH;
    float sd = length(max(q, 0.)) + min(max(q.x, q.y), 0.);
    float r = length(hit.xy - uBedC);
    vec3 fl = vec3(.235, .24, .25) * mix(.3, 1., smoothstep(-50., 120., sd));
    col = mix(col, fl, 1. - smoothstep(170., 1250., r));
  }
  o = vec4(col, 1);
}`;
const FS_POST = `#version 300 es
precision highp float;
in vec2 vNdc;
uniform sampler2D uTex;
out vec4 o;
void main() {
  vec3 c = texture(uTex, vNdc * .5 + .5).rgb;
  c *= 1. - .26 * pow(length(vNdc * vec2(.82, .9)), 2.6);
  float n = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(.06711056, .00583715))));
  o = vec4(c + (n - .5) / 255., 1);
}`;
const VS_HUD = `#version 300 es
uniform vec4 uRect;
out vec2 vUv;
void main() {
  vec2 p = vec2(gl_VertexID & 1, (gl_VertexID >> 1) & 1);
  vUv = vec2(p.x, 1. - p.y);
  gl_Position = vec4(mix(uRect.xy, uRect.zw, p), 0, 1);
}`;
const FS_HUD = `#version 300 es
precision mediump float;
in vec2 vUv; uniform sampler2D uTex; out vec4 o;
void main() { o = texture(uTex, vUv); }`;
const VS_RIB = `#version 300 es
layout(location=0) in vec2 aC;
layout(location=1) in vec3 aA;
layout(location=2) in vec3 aB;
layout(location=3) in float aT;
uniform mat4 uVP; uniform vec2 uRes; uniform float uWidth, uNow, uFade;
out float vA;
void main() {
  vec4 a = uVP * vec4(aA, 1), b = uVP * vec4(aB, 1);
  vec2 d = (b.xy / b.w - a.xy / a.w) * uRes;
  float l = length(d);
  d = l > 1e-4 ? d / l : vec2(1, 0);
  vec4 p = mix(a, b, aC.x);
  p.xy += vec2(-d.y, d.x) / uRes * uWidth * aC.y * p.w;
  p.z -= .00012 * p.w;
  vA = uFade > 0. ? clamp(1. - (uNow - aT) / uFade, 0., 1.) : 1.;
  gl_Position = p;
}`;
const FS_RIB = `#version 300 es
precision mediump float;
in float vA; uniform vec4 uCol; out vec4 o;
void main() { o = vec4(uCol.rgb * uCol.a * vA, uCol.a * vA); }`;

/* ---------- mesh building ---------- */
class MeshB {
  constructor() { this.v = []; }
  vert(p, n, m) { this.v.push(p[0], p[1], p[2], n[0], n[1], n[2], m.c[0], m.c[1], m.c[2], m.r, m.m, m.t || 0); }
  tri(a, b, c, n, m) { this.vert(a, n, m); this.vert(b, n, m); this.vert(c, n, m); }
  quad(a, b, c, d, n, m) { this.tri(a, b, c, n, m); this.tri(a, c, d, n, m); }
  smoothQuad(a, b, c, d, na, nb, nc, nd, m) {
    this.vert(a, na, m); this.vert(b, nb, m); this.vert(c, nc, m);
    this.vert(a, na, m); this.vert(c, nc, m); this.vert(d, nd, m);
  }
  box(cx, cy, cz, sx, sy, sz, m) {
    const x0 = cx - sx / 2, x1 = cx + sx / 2, y0 = cy - sy / 2, y1 = cy + sy / 2, z0 = cz - sz / 2, z1 = cz + sz / 2;
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], m);
    this.quad([x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0], [0, 0, -1], m);
    this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0], m);
    this.quad([x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [0, 1, 0], m);
    this.quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], [1, 0, 0], m);
    this.quad([x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [-1, 0, 0], m);
  }
  lathe(prof, segs, m, flat) {
    const off = flat ? Math.PI / segs : 0;
    for (let i = 0; i + 1 < prof.length; i++) {
      const [r0, z0] = prof[i], [r1, z1] = prof[i + 1];
      const l = Math.hypot(r1 - r0, z1 - z0) || 1, nr = (z1 - z0) / l, nz = -(r1 - r0) / l;
      for (let s = 0; s < segs; s++) {
        const a0 = s / segs * TAU + off, a1 = (s + 1) / segs * TAU + off, am = (a0 + a1) / 2;
        const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
        const n0 = flat ? [Math.cos(am) * nr, Math.sin(am) * nr, nz] : [c0 * nr, s0 * nr, nz];
        const n1 = flat ? n0 : [c1 * nr, s1 * nr, nz];
        this.smoothQuad([r0 * c0, r0 * s0, z0], [r0 * c1, r0 * s1, z0], [r1 * c1, r1 * s1, z1], [r1 * c0, r1 * s0, z1], n0, n1, n1, n0, m);
      }
    }
  }
  cylX(cy, cz, x0, x1, r, segs, m) {
    for (let s = 0; s < segs; s++) {
      const a0 = s / segs * TAU, a1 = (s + 1) / segs * TAU;
      const p = (x, a) => [x, cy + r * Math.cos(a), cz + r * Math.sin(a)];
      const n = (a) => [0, Math.cos(a), Math.sin(a)];
      this.smoothQuad(p(x0, a0), p(x1, a0), p(x1, a1), p(x0, a1), n(a0), n(a0), n(a1), n(a1), m);
      this.tri([x1, cy, cz], p(x1, a0), p(x1, a1), [1, 0, 0], m);
      this.tri([x0, cy, cz], p(x0, a1), p(x0, a0), [-1, 0, 0], m);
    }
  }
  plate(outline, zTop, zBot, top, side, bevel) {
    const n = outline.length, edgeN = [];
    for (let i = 0; i < n; i++) {
      const a = outline[i], b = outline[(i + 1) % n];
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      edgeN.push([(b[1] - a[1]) / l, -(b[0] - a[0]) / l]);
    }
    const vn = outline.map((_, i) => {
      const e0 = edgeN[(i + n - 1) % n], e1 = edgeN[i];
      const x = e0[0] + e1[0], y = e0[1] + e1[1], l = Math.hypot(x, y) || 1;
      return [x / l, y / l];
    });
    const inner = outline.map((p, i) => [p[0] - vn[i][0] * bevel, p[1] - vn[i][1] * bevel]);
    const tris = earclip(inner);
    for (let i = 0; i < tris.length; i += 3) {
      const a = inner[tris[i]], b = inner[tris[i + 1]], c = inner[tris[i + 2]];
      this.tri([a[0], a[1], zTop], [b[0], b[1], zTop], [c[0], c[1], zTop], [0, 0, 1], top);
    }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n, a = outline[i], b = outline[j], ai = inner[i], bi = inner[j], e = edgeN[i];
      const nb = norm([e[0], e[1], 1]);
      this.quad([a[0], a[1], zTop - bevel], [b[0], b[1], zTop - bevel], [bi[0], bi[1], zTop], [ai[0], ai[1], zTop], nb, side);
      this.quad([a[0], a[1], zBot], [b[0], b[1], zBot], [b[0], b[1], zTop - bevel], [a[0], a[1], zTop - bevel], [e[0], e[1], 0], side);
    }
  }
  array() { return new Float32Array(this.v); }
}

function earclip(pts) {
  const area = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const idx = pts.map((_, i) => i), out = [];
  let guard = pts.length * pts.length;
  while (idx.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length], ib = idx[i], ic = idx[(i + 1) % idx.length];
      const a = pts[ia], b = pts[ib], c = pts[ic];
      if (area(a, b, c) <= 1e-9) continue;
      let ok = true;
      for (const j of idx) {
        if (j === ia || j === ib || j === ic) continue;
        const p = pts[j];
        if (area(a, b, p) >= -1e-9 && area(b, c, p) >= -1e-9 && area(c, a, p) >= -1e-9) { ok = false; break; }
      }
      if (!ok) continue;
      out.push(ia, ib, ic);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) idx.splice(0, 1);
  }
  if (idx.length === 3) out.push(idx[0], idx[1], idx[2]);
  return out;
}

function sheetBounds(W, D) { return { x0: -2, x1: W + 2, y0: -16, y1: D + 15 }; }

function sheetOutline(b, r, notches) {
  const pts = [];
  const arc = (cx, cy, a0, a1, rad, n) => { for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * i / n; pts.push([cx + rad * Math.cos(a), cy + rad * Math.sin(a)]); } };
  arc(b.x0 + r, b.y0 + r, Math.PI, 1.5 * Math.PI, r, 8);
  arc(b.x1 - r, b.y0 + r, 1.5 * Math.PI, TAU, r, 8);
  arc(b.x1 - r, b.y1 - r, 0, .5 * Math.PI, r, 8);
  for (const n of [...notches].sort((p, q) => q.x - p.x)) {
    const hw = n.w / 2;
    pts.push([n.x + hw, b.y1]);
    arc(n.x, b.y1 - n.d + hw, 0, -Math.PI, hw, 10);
    pts.push([n.x - hw, b.y1]);
  }
  arc(b.x0 + r, b.y1 - r, .5 * Math.PI, Math.PI, r, 8);
  return pts;
}

function buildBedMesh(W, D) {
  const mb = new MeshB();
  const b = sheetBounds(W, D);
  const notches = [{ x: W * .14, w: 9, d: 7 }, { x: W * .86, w: 9, d: 7 }];
  const top = { c: [.02, .02, .02], r: .55, m: 0, t: 1 };
  const steel = { c: hexLin('#c9ccd1'), r: .3, m: 1 };
  const pcb = { c: hexLin('#17191c'), r: .38, m: 0 };
  const pin = { c: hexLin('#d3d6da'), r: .24, m: 1 };
  mb.plate(sheetOutline(b, 6, notches), 0, -.6, top, steel, .16);
  const pb = { x0: b.x0 - 1.5, x1: b.x1 + 1.5, y0: b.y0 - 1.5, y1: b.y1 + 1.5 };
  mb.plate(sheetOutline(pb, 5, []), -.6, -3.8, pcb, pcb, .25);
  for (const n of notches) {
    const start = mb.v.length;
    mb.lathe([[2.6, -.6], [2.6, 1.1], [2.2, 1.5], [0, 1.5]], 24, pin, false);
    const y = b.y1 - n.d + n.w / 2;
    for (let i = start; i < mb.v.length; i += 12) { mb.v[i] += n.x; mb.v[i + 1] += y; }
  }
  return mb.array();
}

function buildHotend() {
  const mb = new MeshB();
  const brass = { c: hexLin('#d9a74a'), r: .3, m: 1 };
  const alu = { c: hexLin('#c5c8cc'), r: .42, m: 1 };
  const fin = { c: hexLin('#b6b9be'), r: .46, m: 1 };
  const steel = { c: hexLin('#9fa3a9'), r: .3, m: 1 };
  const dark = { c: hexLin('#25262a'), r: .5, m: 0 };
  mb.lathe([[0, .001], [.22, 0], [.55, 0], [.8, .25], [3.1, 2.2], [4.04, 2.2]], 36, brass, false);
  mb.lathe([[4.04, 2.2], [4.04, 5], [0, 5]], 6, brass, true);
  mb.box(0, 3.5, 10.75, 16, 23, 11.5, alu);
  mb.cylX(9.6, 10.75, -9.4, 9.4, 3.05, 20, steel);
  mb.cylX(-3.5, 13.4, -8.6, 8.6, 1.6, 14, dark);
  mb.lathe([[3.5, 16.5], [3.5, 18], [1.6, 19], [1.6, 21.5], [3.5, 22], [3.5, 23]], 24, steel, false);
  mb.lathe([[4.6, 23], [4.6, 53], [0, 53]], 24, fin, false);
  for (let k = 0; k < 12; k++) {
    const z = 23 + k * 2.6;
    mb.lathe([[4.6, z], [11.25, z], [11.25, z + 1], [4.6, z + 1]], 40, fin, false);
  }
  return mb.array();
}

function makeBeadMesh(degs, caps) {
  const ring = degs.map((d) => {
    const a = d * DEG, c = Math.cos(a), s = Math.sin(a);
    return [c, Math.sign(s) * Math.pow(Math.abs(s), .72)];
  });
  const v = [];
  const put = (t, r, e) => v.push(t, r[0], r[1], e);
  for (let i = 0; i + 1 < ring.length; i++) {
    const a = ring[i], b = ring[i + 1];
    put(0, a, 0); put(1, a, 0); put(1, b, 0);
    put(0, a, 0); put(1, b, 0); put(0, b, 0);
    if (caps) {
      const tip = [0, .25];
      put(1, a, 0); put(1, tip, 1); put(1, b, 0);
      put(0, b, 0); put(0, tip, -1); put(0, a, 0);
    }
  }
  return new Float32Array(v);
}

/* ---------- bed textures ---------- */
function noiseField(w, h, cells) {
  const small = document.createElement('canvas');
  small.width = cells; small.height = Math.max(2, Math.round(cells * h / w));
  const sc = small.getContext('2d');
  const id = sc.createImageData(small.width, small.height);
  for (let i = 0; i < id.data.length; i += 4) { const v = Math.random() * 255; id.data[i] = id.data[i + 1] = id.data[i + 2] = v; id.data[i + 3] = 255; }
  sc.putImageData(id, 0, 0);
  const big = document.createElement('canvas');
  big.width = w; big.height = h;
  const bc = big.getContext('2d', { willReadFrequently: true });
  bc.imageSmoothingEnabled = true; bc.imageSmoothingQuality = 'high';
  bc.drawImage(small, 0, 0, w, h);
  return bc.getImageData(0, 0, w, h).data;
}

function makeBedTexture(W, D, label, custom, maxTex) {
  const b = sheetBounds(W, D), sw = b.x1 - b.x0, sh = b.y1 - b.y0;
  const scale = Math.min(10, Math.min(maxTex, 4096) / Math.max(sw, sh));
  const tw = Math.round(sw * scale), th = Math.round(sh * scale);
  const cv = document.createElement('canvas');
  cv.width = tw; cv.height = th;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const base = [37, 39, 43];
  const X = (x) => (x - b.x0) * scale, Y = (y) => (b.y1 - y) * scale;
  ctx.fillStyle = `rgb(${base})`;
  ctx.fillRect(0, 0, tw, th);
  const opaque = custom && !custom.hasAlpha;
  if (opaque) {
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(custom.img, 0, 0, tw, th);
  } else if (custom) {
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(custom.img, X(0), Y(D), W * scale, D * scale);
  } else {
    const ox = (W % 50) / 2, oy = (D % 50) / 2;
    const vline = (x) => { ctx.beginPath(); ctx.moveTo(X(x), Y(0)); ctx.lineTo(X(x), Y(D)); ctx.stroke(); };
    const hline = (y) => { ctx.beginPath(); ctx.moveTo(X(0), Y(y)); ctx.lineTo(X(W), Y(y)); ctx.stroke(); };
    ctx.strokeStyle = '#fff';
    ctx.globalAlpha = .55; ctx.lineWidth = Math.max(1, .16 * scale);
    for (let x = ox % 10; x <= W; x += 10) vline(x);
    for (let y = oy % 10; y <= D; y += 10) hline(y);
    ctx.globalAlpha = .95; ctx.lineWidth = .5 * scale;
    for (let x = ox; x <= W; x += 50) vline(x);
    for (let y = oy; y <= D; y += 50) hline(y);
    ctx.strokeRect(X(0), Y(D), W * scale, D * scale);
    ctx.globalAlpha = 1;
    if (label) {
      const size = Math.min(7.4, W / 33) * scale;
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic';
      ctx.font = `600 ${size}px "Segoe UI", Arial, sans-serif`;
      ctx.fillText(label, X(W - 14), Y(18));
    }
  }
  const img = ctx.getImageData(0, 0, tw, th), d = img.data;
  const blotch = noiseField(tw, th, 40), wear = noiseField(tw, th, 460);
  let seed = 0x2f6e2b1;
  for (let j = 0; j < d.length; j += 4) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    const n = (seed >>> 0) / 4294967296;
    let r = d[j], g = d[j + 1], bl = d[j + 2], rough;
    const lo = blotch[j] / 255;
    if (opaque) {
      rough = .55;
    } else {
      const silk = clamp((r - base[0] - 5) / (255 - base[0]), 0, 1);
      if (silk > 0) {
        const fade = .6 + .4 * smooth(.28, .68, wear[j] / 255) * (.75 + .25 * n);
        r = lerp(base[0], r, fade); g = lerp(base[1], g, fade); bl = lerp(base[2], bl, fade);
      }
      const m = (.9 + .2 * lo) * (silk > .2 ? 1 : .84 + .32 * n);
      r *= m; g *= m; bl *= m;
      if (n > .982 && silk < .3) { r += 34; g += 28; bl += 15; }
      rough = silk > .3 ? .46 : .56 + .05 * lo + .14 * (n - .5);
    }
    d[j] = clamp(r, 0, 255); d[j + 1] = clamp(g, 0, 255); d[j + 2] = clamp(bl, 0, 255); d[j + 3] = clamp(rough * 255, 0, 255);
  }
  return { data: d, width: tw, height: th };
}

function makeGrainTile(n) {
  const h = new Float32Array(n * n);
  const blur = (src, r) => {
    const tmp = new Float32Array(n * n), norm2 = 1 / (2 * r + 1);
    for (let y = 0; y < n; y++) { let s = 0; for (let k = -r; k <= r; k++) s += src[y * n + ((k + n) % n)];
      for (let x = 0; x < n; x++) { tmp[y * n + x] = s * norm2; s += src[y * n + ((x + r + 1) % n)] - src[y * n + ((x - r + n) % n)]; } }
    for (let x = 0; x < n; x++) { let s = 0; for (let k = -r; k <= r; k++) s += tmp[((k + n) % n) * n + x];
      for (let y = 0; y < n; y++) { src[y * n + x] = s * norm2; s += tmp[((y + r + 1) % n) * n + x] - tmp[((y - r + n) % n) * n + x]; } }
  };
  for (const [r, amp] of [[1, .9], [3, 1.5], [7, 2.2]]) {
    const f = new Float32Array(n * n);
    for (let i = 0; i < f.length; i++) f[i] = Math.random() - .5;
    blur(f, r); blur(f, r);
    let max = 1e-6; for (let i = 0; i < f.length; i++) max = Math.max(max, Math.abs(f[i]));
    for (let i = 0; i < f.length; i++) h[i] += f[i] / max * amp;
  }
  let max = 1e-6; for (let i = 0; i < h.length; i++) max = Math.max(max, Math.abs(h[i]));
  const out = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const v = h[y * n + x] / max;
    const dx = (h[y * n + (x + 1) % n] - h[y * n + (x + n - 1) % n]) / max;
    const dy = (h[((y + 1) % n) * n + x] - h[((y + n - 1) % n) * n + x]) / max;
    const j = (y * n + x) * 4;
    out[j] = clamp(128 + dx * 330, 0, 255); out[j + 1] = clamp(128 + dy * 330, 0, 255);
    out[j + 2] = clamp(128 + v * 127, 0, 255); out[j + 3] = 255;
  }
  return out;
}

/* ---------- renderer ---------- */
function createRenderer(canvas) {
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance' });
  if (!gl) return null;
  const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
  const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  const maxRB = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE);
  const samples = Math.min(4, gl.getParameter(gl.MAX_SAMPLES));

  function program(vs, fs) {
    const mk = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('Shader error: ' + gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Link error: ' + gl.getProgramInfoLog(p));
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const name = gl.getActiveUniform(p, i).name; u[name] = gl.getUniformLocation(p, name); }
    return { p, u };
  }
  const P = {
    bead: program(VS_BEAD, FS_BEAD), depth: program(VS_BEAD, FS_DEPTH), mesh: program(VS_MESH, FS_MESH),
    bg: program(VS_FS, FS_BG), post: program(VS_FS, FS_POST), hud: program(VS_HUD, FS_HUD), rib: program(VS_RIB, FS_RIB),
  };

  /* bead geometry */
  const segVBO = gl.createBuffer();
  function beadVAO(mesh) {
    const vao = gl.createVertexArray(), vbo = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo); gl.bufferData(gl.ARRAY_BUFFER, mesh, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, 0);
    for (const l of [1, 2, 3]) { gl.enableVertexAttribArray(l); gl.vertexAttribDivisor(l, 1); }
    return { vao, count: mesh.length / 4 };
  }
  const beadHi = beadVAO(makeBeadMesh([205, 165, 125, 90, 55, 15, -25], true));
  const beadMid = beadVAO(makeBeadMesh([190, 135, 90, 45, -10], true));
  const beadLo = beadVAO(makeBeadMesh([180, 120, 60, 0], false));
  function bindSegs(v, first) {
    gl.bindVertexArray(v.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, segVBO);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 32, first * 32);
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 32, first * 32 + 12);
    gl.vertexAttribPointer(3, 2, gl.FLOAT, false, 32, first * 32 + 24);
  }
  // Large prints are drawn in batches so one huge draw call cannot trip the GPU watchdog
  const BATCH = 120000;
  function drawBeads(v, prog, first, count, partial) {
    for (let s = first, end = first + count; s < end; s += BATCH) {
      const n = Math.min(BATCH, end - s);
      bindSegs(v, s);
      gl.uniform1i(prog.u.uPartial, partial >= s && partial < s + n ? partial - s : -1);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, v.count, n);
      gl.flush();
    }
  }

  /* generic meshes */
  function meshVAO() {
    const vao = gl.createVertexArray(), vbo = gl.createBuffer();
    gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 48, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 48, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 48, 24);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 3, gl.FLOAT, false, 48, 36);
    return { vao, vbo, count: 0, set(data) { gl.bindBuffer(gl.ARRAY_BUFFER, vbo); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); this.count = data.length / 12; } };
  }
  const bedMesh = meshVAO(), hotMesh = meshVAO();
  hotMesh.set(buildHotend());

  /* ribbons */
  const ribCorner = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, ribCorner);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, -1, 1, -1, 0, 1, 1, 1]), gl.STATIC_DRAW);
  function ribVAO() {
    const vao = gl.createVertexArray(), vbo = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, ribCorner);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    for (const l of [1, 2, 3]) { gl.enableVertexAttribArray(l); gl.vertexAttribDivisor(l, 1); }
    return { vao, vbo };
  }
  const bindRib = (r, first) => {
    gl.bindVertexArray(r.vao); gl.bindBuffer(gl.ARRAY_BUFFER, r.vbo);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 28, first * 28);
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 28, first * 28 + 12);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, 28, first * 28 + 24);
  };
  const travelRib = ribVAO(), volumeRib = ribVAO();
  const emptyVAO = gl.createVertexArray();

  /* textures */
  const texAlbedo = gl.createTexture(), texGrain = gl.createTexture(), texHud = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texGrain);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 512, 512, 0, gl.RGBA, gl.UNSIGNED_BYTE, makeGrainTile(512));
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, 8);
  gl.bindTexture(gl.TEXTURE_2D, texHud);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  /* shadow map */
  const shadowSize = Math.min(4096, maxTex);
  const texShadow = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texShadow);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, shadowSize, shadowSize);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
  const shadowFB = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, shadowFB);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, texShadow, 0);
  gl.drawBuffers([gl.NONE]); gl.readBuffer(gl.NONE);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  /* render targets */
  let outW = 0, outH = 0, scW = 0, scH = 0, curSS = 1;
  const msFB = gl.createFramebuffer(), resFB = gl.createFramebuffer();
  const rbColor = gl.createRenderbuffer(), rbDepth = gl.createRenderbuffer(), texRes = gl.createTexture();
  function setSize(w, h, ss) {
    if (ss * Math.max(w, h) > maxRB) ss = 1;
    curSS = ss;
    canvas.width = w; canvas.height = h; outW = w; outH = h;
    const sw = w * ss, sh = h * ss;
    if (sw === scW && sh === scH) return;
    scW = sw; scH = sh;
    gl.bindRenderbuffer(gl.RENDERBUFFER, rbColor);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, sw, sh);
    gl.bindRenderbuffer(gl.RENDERBUFFER, rbDepth);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH_COMPONENT24, sw, sh);
    gl.bindFramebuffer(gl.FRAMEBUFFER, msFB);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, rbColor);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rbDepth);
    gl.bindTexture(gl.TEXTURE_2D, texRes);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, sw, sh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, resFB);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texRes, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /* scene state */
  let nSeg = 0, nTrav = 0, shadowN = 0, shadowDirty = true;
  let lightVP = new Float32Array(16), shadowR = .001;
  let bed = { W: 250, D: 210, H: 210 };

  function setLight() {
    const L = norm([-.52, -.62, 1]);
    const c = [bed.W / 2, bed.D / 2, bed.H / 2];
    const r = .5 * Math.hypot(bed.W + 40, bed.D + 50, bed.H) + 20;
    const eye = [c[0] + L[0] * r * 2, c[1] + L[1] * r * 2, c[2] + L[2] * r * 2];
    lightVP = Mat.mul(Mat.ortho(-r, r, -r, r, .1, r * 4), Mat.lookAt(eye, c, [0, 1, 0]));
    shadowR = .9 / (2 * r);
    shadowDirty = true;
  }

  function setBed(W, D, H, label, custom) {
    bed = { W, D, H };
    bedMesh.set(buildBedMesh(W, D));
    const t = makeBedTexture(W, D, label, custom, maxTex);
    gl.bindTexture(gl.TEXTURE_2D, texAlbedo);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, t.width, t.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(t.data.buffer));
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(16, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
    const e = [[0,0,0,W,0,0],[W,0,0,W,D,0],[W,D,0,0,D,0],[0,D,0,0,0,0],[0,0,H,W,0,H],[W,0,H,W,D,H],[W,D,H,0,D,H],[0,D,H,0,0,H],[0,0,0,0,0,H],[W,0,0,W,0,H],[W,D,0,W,D,H],[0,D,0,0,D,H]];
    const arr = new Float32Array(e.length * 7);
    e.forEach((s, i) => arr.set([...s, 0], i * 7));
    gl.bindBuffer(gl.ARRAY_BUFFER, volumeRib.vbo); gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW);
    setLight();
  }

  function setPrint(d) {
    gl.bindBuffer(gl.ARRAY_BUFFER, segVBO);
    gl.bufferData(gl.ARRAY_BUFFER, d.seg, gl.STATIC_DRAW);
    nSeg = d.seg.length / 8;
    nTrav = d.trvT.length;
    const tr = new Float32Array(nTrav * 7);
    for (let i = 0; i < nTrav; i++) {
      for (let k = 0; k < 6; k++) tr[i * 7 + k] = d.trv[i * 6 + k];
      tr[i * 7 + 6] = d.trvT[i] - d.stats.tStart;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, travelRib.vbo); gl.bufferData(gl.ARRAY_BUFFER, tr, gl.STATIC_DRAW);
    shadowDirty = true; shadowN = 0;
  }

  function lightUniforms(p, cam, f) {
    gl.uniform3fv(p.u.uCam, cam.eye);
    gl.uniformMatrix4fv(p.u.uShadowMat, false, lightVP);
    gl.uniform1i(p.u.uShadow, 0);
    gl.uniform1f(p.u.uShadowR, shadowR);
    gl.uniform3fv(p.u.uTip, f.tip);
    gl.uniform1f(p.u.uHotend, f.showNozzle ? 1 : 0);
  }

  function updateShadow(count) {
    if (shadowDirty || count < shadowN) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, shadowFB);
      gl.clearDepth(1); gl.depthMask(true); gl.clear(gl.DEPTH_BUFFER_BIT);
      shadowN = 0; shadowDirty = false;
    }
    if (count <= shadowN) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, shadowFB);
    gl.viewport(0, 0, shadowSize, shadowSize);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS); gl.depthMask(true);
    gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(1.5, 3);
    gl.useProgram(P.depth.p);
    gl.uniformMatrix4fv(P.depth.u.uVP, false, lightVP);
    drawBeads(beadLo, P.depth, shadowN, count - shadowN, -1);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    shadowN = count;
  }

  function render(cam, f) {
    gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE);
    updateShadow(f.count);

    gl.bindFramebuffer(gl.FRAMEBUFFER, msFB);
    gl.viewport(0, 0, scW, scH);
    gl.clearColor(0, 0, 0, 1); gl.clearDepth(1); gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.disable(gl.DEPTH_TEST); gl.depthMask(false);
    gl.useProgram(P.bg.p);
    gl.uniform3fv(P.bg.u.uCam, cam.eye); gl.uniform3fv(P.bg.u.uRight, cam.right);
    gl.uniform3fv(P.bg.u.uUp, cam.up); gl.uniform3fv(P.bg.u.uFwd, cam.fwd);
    gl.uniform1f(P.bg.u.uTan, cam.tan); gl.uniform1f(P.bg.u.uAspect, cam.aspect); gl.uniform1f(P.bg.u.uFloor, -46);
    gl.uniform2f(P.bg.u.uBedC, bed.W / 2, bed.D / 2); gl.uniform2f(P.bg.u.uBedH, bed.W / 2 + 4, bed.D / 2 + 18);
    gl.bindVertexArray(emptyVAO); gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(true);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texShadow);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, texAlbedo);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, texGrain);

    gl.useProgram(P.mesh.p);
    lightUniforms(P.mesh, cam, f);
    gl.uniformMatrix4fv(P.mesh.u.uVP, false, cam.vp);
    gl.uniform1i(P.mesh.u.uAlbedo, 1); gl.uniform1i(P.mesh.u.uGrain, 2);
    const b = sheetBounds(bed.W, bed.D);
    gl.uniform2f(P.mesh.u.uSheetMin, b.x0, b.y0); gl.uniform2f(P.mesh.u.uSheetSize, b.x1 - b.x0, b.y1 - b.y0);
    gl.uniform3f(P.mesh.u.uOffset, 0, 0, 0);
    gl.bindVertexArray(bedMesh.vao); gl.drawArrays(gl.TRIANGLES, 0, bedMesh.count);

    const total = f.count + (f.partial >= 0 ? 1 : 0);
    if (total > 0) {
      const v = f.forExport ? (total <= 700000 ? beadHi : beadMid) : (total <= 150000 ? beadHi : total <= 500000 ? beadMid : beadLo);
      gl.useProgram(P.bead.p);
      lightUniforms(P.bead, cam, f);
      gl.uniformMatrix4fv(P.bead.u.uVP, false, cam.vp);
      gl.uniform3fv(P.bead.u.uColor, f.color); gl.uniform1f(P.bead.u.uRough, f.rough); gl.uniform1f(P.bead.u.uMetal, f.metal);
      gl.uniform1f(P.bead.u.uFrac, f.frac);
      gl.uniform1f(P.bead.u.uSS, curSS);
      drawBeads(v, P.bead, 0, total, f.partial);
    }

    if (f.showNozzle) {
      gl.useProgram(P.mesh.p);
      gl.uniform3fv(P.mesh.u.uOffset, f.tip);
      gl.bindVertexArray(hotMesh.vao); gl.drawArrays(gl.TRIANGLES, 0, hotMesh.count);
    }

    if (f.showVolume || (f.showTravel && f.travelCount > 0)) {
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
      gl.useProgram(P.rib.p);
      gl.uniformMatrix4fv(P.rib.u.uVP, false, cam.vp);
      gl.uniform2f(P.rib.u.uRes, scW, scH);
      const px = scH / 1080;
      if (f.showVolume) {
        gl.uniform1f(P.rib.u.uWidth, 1.1 * px); gl.uniform1f(P.rib.u.uFade, 0); gl.uniform4f(P.rib.u.uCol, .86, .9, .96, .3);
        bindRib(volumeRib, 0); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, 12);
      }
      if (f.showTravel && f.travelCount > 0) {
        gl.uniform1f(P.rib.u.uWidth, 1.3 * px); gl.uniform1f(P.rib.u.uNow, f.simRel); gl.uniform1f(P.rib.u.uFade, f.travelFade);
        gl.uniform4f(P.rib.u.uCol, .45, .78, 1, .75);
        bindRib(travelRib, f.travelFirst); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, f.travelCount);
      }
      gl.disable(gl.BLEND); gl.depthMask(true);
    }

    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, msFB);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, resFB);
    gl.blitFramebuffer(0, 0, scW, scH, 0, 0, scW, scH, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, outW, outH);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(P.post.p);
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, texRes);
    gl.uniform1i(P.post.u.uTex, 3);
    gl.bindVertexArray(emptyVAO); gl.drawArrays(gl.TRIANGLES, 0, 3);

    if (f.hud) {
      gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, texHud);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, f.hud.canvas);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(P.hud.p);
      gl.uniform1i(P.hud.u.uTex, 3);
      const x0 = f.hud.x / outW * 2 - 1, x1 = (f.hud.x + f.hud.canvas.width) / outW * 2 - 1;
      const y0 = f.hud.y / outH * 2 - 1, y1 = (f.hud.y + f.hud.canvas.height) / outH * 2 - 1;
      gl.uniform4f(P.hud.u.uRect, x0, y0, x1, y1);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.disable(gl.BLEND);
    }
    gl.flush();
  }

  return { gl, setSize, setBed, setPrint, render, invalidateShadow() { shadowDirty = true; }, info() { return { maxTex, maxRB, samples, renderer: gl.getParameter(gl.RENDERER) }; } };
}

/* ---------- MP4 muxer ---------- */
class Mp4Muxer {
  constructor(width, height, fps, codec) {
    this.w = width; this.h = height; this.fps = fps; this.codec = codec;
    this.samples = []; this.desc = null; this.colorSpace = null; this.timescale = 90000;
  }
  add(chunk, meta) {
    if (meta && meta.decoderConfig) {
      if (meta.decoderConfig.description) {
        const d = meta.decoderConfig.description;
        this.desc = d instanceof ArrayBuffer ? new Uint8Array(d.slice(0)) : new Uint8Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength));
      }
      if (meta.decoderConfig.colorSpace) this.colorSpace = meta.decoderConfig.colorSpace;
    }
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    this.samples.push({ data, pts: chunk.timestamp, key: chunk.type === 'key' });
  }
  finish() {
    const u8 = (...v) => new Uint8Array(v);
    const u16 = (v) => u8(v >> 8 & 255, v & 255);
    const u32 = (v) => u8(v >>> 24 & 255, v >>> 16 & 255, v >>> 8 & 255, v & 255);
    const u64 = (v) => { const hi = Math.floor(v / 4294967296); return cat([u32(hi), u32(v - hi * 4294967296)]); };
    const str = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
    const zeros = (n) => new Uint8Array(n);
    function cat(parts) {
      let n = 0; for (const p of parts) n += p.length;
      const o = new Uint8Array(n); let i = 0;
      for (const p of parts) { o.set(p, i); i += p.length; }
      return o;
    }
    const box = (type, ...parts) => { const body = cat(parts); return cat([u32(body.length + 8), str(type), body]); };
    const full = (type, ver, flags, ...parts) => box(type, u32((ver << 24 | flags) >>> 0), ...parts);

    const n = this.samples.length, ts = this.timescale, dur = Math.round(ts / this.fps), total = n * dur;
    const offsets = this.samples.map((s, i) => Math.round(s.pts * ts / 1e6) - i * dur);
    const hasCtts = offsets.some((o) => o !== 0);
    const matrix = cat([u32(0x10000), u32(0), u32(0), u32(0), u32(0x10000), u32(0), u32(0), u32(0), u32(0x40000000)]);

    const isAvc = this.codec.startsWith('avc1');
    const cs = this.colorSpace || {};
    const prim = { bt709: 1, bt470bg: 5, smpte170m: 6 }[cs.primaries] || 1;
    const trc = { bt709: 1, smpte170m: 6, iec61966_2_1: 13 }[cs.transfer] || 1;
    const mx = { bt709: 1, bt470bg: 5, smpte170m: 6, rgb: 0 }[cs.matrix] || 1;
    const colr = box('colr', str('nclx'), u16(prim), u16(trc), u16(mx), u8(cs.fullRange ? 0x80 : 0));
    const codecBox = isAvc ? box('avcC', this.desc)
      : full('vpcC', 1, 0, u8(0, 40, (8 << 4) | (1 << 1) | (cs.fullRange ? 1 : 0), prim, trc, mx), u16(0));
    const entry = box(isAvc ? 'avc1' : 'vp09', zeros(6), u16(1), zeros(16), u16(this.w), u16(this.h),
      u32(0x480000), u32(0x480000), u32(0), u16(1), zeros(32), u16(0x18), u16(0xffff), codecBox, colr);

    const keys = []; this.samples.forEach((s, i) => { if (s.key) keys.push(i + 1); });
    const stblParts = (offset) => [
      full('stsd', 0, 0, u32(1), entry),
      full('stts', 0, 0, u32(1), u32(n), u32(dur)),
      full('stss', 0, 0, u32(keys.length), ...keys.map(u32)),
      ...(hasCtts ? [full('ctts', 1, 0, u32(n), ...offsets.flatMap((o) => [u32(1), u32(o >>> 0)]))] : []),
      full('stsc', 0, 0, u32(1), u32(1), u32(n), u32(1)),
      full('stsz', 0, 0, u32(0), u32(n), ...this.samples.map((s) => u32(s.data.length))),
      full('co64', 0, 0, u32(1), u64(offset)),
    ];
    const moov = (offset) => box('moov',
      full('mvhd', 0, 0, u32(0), u32(0), u32(ts), u32(total), u32(0x10000), u16(0x100), zeros(10), matrix, zeros(24), u32(2)),
      box('trak',
        full('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(total), zeros(8), u16(0), u16(0), u16(0), u16(0), matrix, u32(this.w * 65536), u32(this.h * 65536)),
        box('edts', full('elst', 1, 0, u32(1), u64(total), u64(Math.max(0, offsets[0])), u16(1), u16(0))),
        box('mdia',
          full('mdhd', 0, 0, u32(0), u32(0), u32(ts), u32(total), u16(0x55c4), u16(0)),
          full('hdlr', 0, 0, u32(0), str('vide'), zeros(12), str('VideoHandler'), u8(0)),
          box('minf',
            full('vmhd', 0, 1, zeros(8)),
            box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))),
            box('stbl', ...stblParts(offset))))));

    const ftyp = box('ftyp', str('isom'), u32(0x200), str('isom'), str('iso2'), str(isAvc ? 'avc1' : 'vp09'), str('mp41'));
    const moovSize = moov(0).length;
    const dataOffset = ftyp.length + moovSize + 16;
    let mdatSize = 16;
    for (const s of this.samples) mdatSize += s.data.length;
    const mdatHead = cat([u32(1), str('mdat'), u64(mdatSize)]);
    return new Blob([ftyp, moov(dataOffset), mdatHead, ...this.samples.map((s) => s.data)], { type: 'video/mp4' });
  }
}

/* ---------- application ---------- */
const DEFAULTS = {
  preset: 'mk3s', bedX: 250, bedY: 210, bedZ: 210, label: 'ORIGINAL PRUSA i3 MK3S',
  color: '#fa6831', colorTouched: false, finish: 'satin',
  camMode: 'orbit', showNozzle: true, showTravel: true, showVolume: true, showHud: true,
  res: '1920x1080', fps: 30, length: 30, quality: 'high',
};
const PRESETS = { mk3s: { bedX: 250, bedY: 210, bedZ: 210, label: 'ORIGINAL PRUSA i3 MK3S' } };
const FINISH = { matte: { r: .66, m: 0 }, satin: { r: .44, m: 0 }, glossy: { r: .24, m: 0 }, silk: { r: .32, m: .5 } };
const SWATCHES = [['Orange', '#fa6831'], ['Black', '#26272b'], ['White', '#efeee8'], ['Silver', '#b4b8bd'], ['Red', '#c61f2c'], ['Blue', '#1d5fc4'], ['Green', '#2c9c46'], ['Yellow', '#f3c222'], ['Purple', '#6a3bb0']];
const HOLD_SEC = 2;
const STORE = 'gcode-sim-settings-v1';

let S = { ...DEFAULTS };
try { S = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORE) || '{}') }; } catch (e) { /* storage unavailable */ }
const save = () => { try { localStorage.setItem(STORE, JSON.stringify(S)); } catch (e) { /* storage unavailable */ } };

const canvas = $('gl');
let R;
try { R = createRenderer(canvas); } catch (e) { console.error(e); }
if (!R) {
  $('drop').querySelector('.card').innerHTML = '<h1>WebGL 2 is unavailable</h1><p>Open this file in a current version of Edge or Chrome with hardware acceleration turned on.</p>';
  return;
}

let print = null, fileName = '', customBed = null;
let vt = 0, playing = false, dirty = true, exporting = false, cancelRequested = false;
const view = { yaw: -32, pitch: 31, zoom: 1, panX: 0, panY: 0 };

const lowerBound = (a, x, n = a.length) => { let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; } return lo; };
const upperBound = (a, x, n = a.length) => { let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] <= x) lo = m + 1; else hi = m; } return lo; };
const printSpan = () => print ? Math.max(.001, print.stats.tEnd - print.stats.tStart) : 0;
const totalLen = () => S.length + HOLD_SEC;
const speedFactor = () => print ? printSpan() / S.length : 1;
const outDims = () => S.res.split('x').map(Number);

function nozzleAt(t) {
  if (!print) return [S.bedX / 2, S.bedY / 2, 40];
  const { mT, mP } = print;
  const n = mT.length;
  if (n < 2) return [mP[0] || 0, mP[1] || 0, mP[2] || 0];
  const k = clamp(upperBound(mT, t) - 1, 0, n - 2);
  const span = mT[k + 1] - mT[k];
  const f = span > 1e-9 ? clamp((t - mT[k]) / span, 0, 1) : 1;
  return [lerp(mP[k * 3], mP[k * 3 + 3], f), lerp(mP[k * 3 + 1], mP[k * 3 + 4], f), lerp(mP[k * 3 + 2], mP[k * 3 + 5], f)];
}

function frameState(videoT) {
  const u = clamp(videoT / S.length, 0, 1);
  const simT = print ? print.stats.tStart + printSpan() * u : 0;
  const finish = FINISH[S.finish] || FINISH.satin;
  const f = {
    simT, simRel: print ? simT - print.stats.tStart : 0, u, count: 0, partial: -1, frac: 0, tip: nozzleAt(simT),
    color: hexLin(S.color), rough: finish.r, metal: finish.m,
    showNozzle: S.showNozzle, showTravel: S.showTravel && !!print, showVolume: S.showVolume,
    travelFirst: 0, travelCount: 0, travelFade: 1, forExport: false, hud: null, layer: 0,
  };
  if (print && print.stats.segments) {
    const n = print.stats.segments;
    let c = upperBound(print.sT1, simT, n);
    if (u >= 1) c = n;
    f.count = c;
    if (c < n && print.sT0[c] < simT) {
      f.partial = c;
      f.frac = clamp((simT - print.sT0[c]) / Math.max(1e-9, print.sT1[c] - print.sT0[c]), 0, 1);
    }
    const ls = print.layerSeg;
    f.layer = ls.length ? clamp(upperBound(ls, Math.max(0, c - (f.partial >= 0 ? 0 : 1))), 1, ls.length) : 0;
    if (f.showTravel && print.trvT.length) {
      f.travelFade = Math.max(.05, Math.min(.2 * speedFactor(), 12));
      const first = lowerBound(print.trvT, simT - f.travelFade), last = upperBound(print.trvT, simT);
      f.travelFirst = first; f.travelCount = Math.max(0, last - first);
    }
  }
  return f;
}

function modelHeight() { return print && print.stats.bbox ? print.stats.bbox.maxZ : 0; }

function cameraAt(videoT, f) {
  const [w, h] = outDims();
  const aspect = w / h, fov = 27 * DEG, tan = Math.tan(fov / 2);
  const W = S.bedX, D = S.bedY, u = clamp(videoT / totalLen(), 0, 1);
  const R0 = .5 * Math.hypot(W + 24, D + 40);
  const fit = (R0 / tan) * .97 * Math.max(1, 1.42 / aspect) * (1 + modelHeight() / 1100);
  let yaw = view.yaw, pitch = view.pitch, dist = fit * view.zoom;
  let target = [W / 2 + view.panX, D / 2 - 6 + view.panY, modelHeight() * .2];
  if (S.camMode === 'orbit') {
    yaw += 110 * (u - .5);
  } else if (S.camMode === 'follow') {
    const win = Math.max(.5, 1.6 * speedFactor());
    let sx = 0, sy = 0, sz = 0;
    for (let i = 0; i < 24; i++) { const p = nozzleAt(f.simT + win * (i / 23 - .5) * 2); sx += p[0]; sy += p[1]; sz += p[2]; }
    target = [sx / 24 + view.panX, sy / 24 + view.panY, sz / 24];
    dist = Math.min(fit, 230) * view.zoom;
    pitch = clamp(view.pitch - 6, 8, 70);
    yaw += 40 * (u - .5);
  } else if (S.camMode === 'top') {
    yaw = 0; pitch = 89.4;
    target = [W / 2 + view.panX, D / 2 + view.panY, 0];
    dist = Math.max((D + 44) / 2 / tan, (W + 24) / 2 / (tan * aspect)) * 1.06 * view.zoom;
  }
  const cy = Math.cos(yaw * DEG), sy = Math.sin(yaw * DEG), cp = Math.cos(pitch * DEG), sp = Math.sin(pitch * DEG);
  const eye = [target[0] + dist * cp * sy, target[1] - dist * cp * cy, target[2] + dist * sp];
  const fwd = norm(sub(target, eye)), right = norm(cross(fwd, [0, 0, 1])), up = cross(right, fwd);
  const near = Math.max(4, dist * .04), far = dist * 5 + 1500;
  const vp = Mat.mul(Mat.persp(fov, aspect, near, far), Mat.lookAt(eye, target, [0, 0, 1]));
  return { eye, fwd, right, up, vp, tan, aspect };
}

const fmtClock = (s) => { s = Math.max(0, Math.round(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const fmtDur = (s) => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60; return `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

const hudCanvas = document.createElement('canvas');
const hudCtx = hudCanvas.getContext('2d', { willReadFrequently: true });
function makeHud(f, outW, outH) {
  if (!S.showHud || !print) return null;
  const k = Math.min(outW, outH * 16 / 9) / 1920 * 1.0;
  const scale = Math.max(.5, outH >= outW ? outW / 1080 : k);
  const w = Math.round(430 * scale), h = Math.round(98 * scale);
  if (hudCanvas.width !== w || hudCanvas.height !== h) { hudCanvas.width = w; hudCanvas.height = h; }
  const c = hudCtx;
  c.clearRect(0, 0, w, h);
  c.save(); c.scale(scale, scale);
  c.fillStyle = 'rgba(12,13,15,.62)';
  c.beginPath(); c.roundRect(0, 0, 430, 98, 10); c.fill();
  const layers = print.stats.layers, z = f.layer > 0 ? print.layerZ[f.layer - 1] : 0;
  const col = (x, label, value) => {
    c.fillStyle = 'rgba(255,255,255,.62)'; c.font = '500 14px "Segoe UI", Arial, sans-serif'; c.fillText(label, x, 30);
    c.fillStyle = '#fff'; c.font = '600 23px "Segoe UI", Arial, sans-serif'; c.fillText(value, x, 60);
  };
  c.textBaseline = 'alphabetic';
  col(20, 'LAYER', `${f.layer} / ${layers}`);
  col(170, 'HEIGHT', `${Math.max(0, z).toFixed(2)} mm`);
  col(310, 'PRINT TIME', fmtDur(f.simRel));
  c.fillStyle = 'rgba(255,255,255,.2)'; c.fillRect(20, 76, 390, 5);
  c.fillStyle = S.color; c.fillRect(20, 76, 390 * f.u, 5);
  c.restore();
  const m = Math.round(26 * scale);
  return { canvas: hudCanvas, x: m, y: m };
}

function drawFrame(videoT, opts = {}) {
  const f = frameState(videoT);
  f.forExport = !!opts.export;
  f.hud = makeHud(f, canvas.width, canvas.height);
  R.render(cameraAt(videoT, f), f);
}

function fitCanvas() {
  if (exporting) return;
  const [w, h] = outDims();
  const box = $('viewport').getBoundingClientRect();
  if (box.width < 2 || box.height < 2) return;
  const s = Math.min(box.width / w, box.height / h);
  const cssW = Math.floor(w * s), cssH = Math.floor(h * s);
  canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  R.setSize(Math.max(2, Math.round(cssW * dpr)), Math.max(2, Math.round(cssH * dpr)), 1);
  dirty = true;
}
new ResizeObserver(fitCanvas).observe($('viewport'));

let lastTs = 0;
function tick(ts) {
  const dt = lastTs ? Math.min(.25, (ts - lastTs) / 1000) : 0;
  lastTs = ts;
  if (!exporting) {
    if (playing) {
      vt += dt;
      if (vt >= totalLen()) { vt = totalLen(); setPlaying(false); }
      syncTransport();
      dirty = true;
    }
    if (dirty) { dirty = false; drawFrame(vt); }
  }
  requestAnimationFrame(tick);
}

function setPlaying(p) {
  playing = p;
  $('play').innerHTML = p ? '&#10074;&#10074;' : '&#9654;';
  $('play').setAttribute('aria-label', p ? 'Pause' : 'Play');
}
function syncTransport() {
  const t = totalLen();
  $('scrub').value = String(Math.round(vt / t * 10000));
  $('clock').textContent = `${fmtClock(vt)} / ${fmtClock(t)}`;
}
function updateSpeedInfo() {
  if (!print) { $('speedInfo').textContent = ''; return; }
  const sp = speedFactor();
  const frames = Math.round(totalLen() * S.fps);
  $('speedInfo').textContent = `${sp >= 10 ? Math.round(sp) : sp.toFixed(1)}× speed, ${frames.toLocaleString()} frames, including a ${HOLD_SEC} second hold on the finished print.`;
}

let bedTimer = 0;
function rebuildBed() {
  clearTimeout(bedTimer);
  bedTimer = setTimeout(() => { R.setBed(S.bedX, S.bedY, S.bedZ, S.label, customBed); checkBounds(); dirty = true; }, 180);
}
function checkBounds() {
  const el = $('warn');
  const bb = print && print.stats.bbox;
  if (!bb) { el.hidden = true; return; }
  const out = bb.minX < -5 || bb.minY < -5 || bb.maxX > S.bedX + 5 || bb.maxY > S.bedY + 5 || bb.maxZ > S.bedZ + .01;
  el.hidden = !out;
  if (out) el.textContent = `This print measures X ${bb.minX.toFixed(0)} to ${bb.maxX.toFixed(0)}, Y ${bb.minY.toFixed(0)} to ${bb.maxY.toFixed(0)}, Z up to ${bb.maxZ.toFixed(1)} mm, which is outside the build volume set below.`;
}

/* settings bindings */
function setColor(hex, touched) {
  S.color = hex.toLowerCase();
  if (touched) S.colorTouched = true;
  $('color').value = S.color; $('colorHex').value = S.color;
  for (const b of $('swatches').children) b.setAttribute('aria-pressed', String(b.dataset.c === S.color));
  save(); dirty = true;
}
function applySettingsToUI() {
  for (const id of ['preset', 'bedX', 'bedY', 'bedZ', 'label', 'finish', 'camMode', 'res', 'length', 'quality']) $(id).value = S[id];
  $('fps').value = String(S.fps);
  for (const id of ['showNozzle', 'showTravel', 'showVolume', 'showHud']) $(id).checked = S[id];
  setColor(S.color, false);
}
for (const [name, c] of SWATCHES) {
  const b = document.createElement('button');
  b.style.background = c; b.dataset.c = c; b.title = name; b.setAttribute('aria-label', name);
  b.addEventListener('click', () => setColor(c, true));
  $('swatches').appendChild(b);
}
$('color').addEventListener('input', (e) => setColor(e.target.value, true));
$('colorHex').addEventListener('change', (e) => {
  let v = e.target.value.trim();
  if (/^[0-9a-fA-F]{6}$/.test(v)) v = '#' + v;
  if (/^#[0-9a-fA-F]{6}$/.test(v)) setColor(v, true); else e.target.value = S.color;
});
$('preset').addEventListener('change', (e) => {
  S.preset = e.target.value;
  if (PRESETS[S.preset]) { Object.assign(S, PRESETS[S.preset]); applySettingsToUI(); rebuildBed(); }
  save();
});
for (const [id, lo, hi] of [['bedX', 50, 1000], ['bedY', 50, 1000], ['bedZ', 20, 1000]]) {
  $(id).addEventListener('change', (e) => {
    const v = clamp(Math.round(+e.target.value || S[id]), lo, hi);
    S[id] = v; e.target.value = v; S.preset = 'custom'; $('preset').value = 'custom';
    save(); rebuildBed();
  });
}
$('label').addEventListener('change', (e) => { S.label = e.target.value.trim(); save(); rebuildBed(); });
for (const id of ['finish', 'camMode', 'quality']) $(id).addEventListener('change', (e) => { S[id] = e.target.value; save(); dirty = true; });
for (const id of ['showNozzle', 'showTravel', 'showVolume', 'showHud']) $(id).addEventListener('change', (e) => { S[id] = e.target.checked; save(); dirty = true; });
$('res').addEventListener('change', (e) => { S.res = e.target.value; save(); fitCanvas(); });
$('fps').addEventListener('change', (e) => { S.fps = +e.target.value; save(); updateSpeedInfo(); });
$('length').addEventListener('change', (e) => {
  S.length = clamp(Math.round(+e.target.value || 30), 3, 3600); e.target.value = S.length;
  vt = Math.min(vt, totalLen()); save(); updateSpeedInfo(); syncTransport(); dirty = true;
});

/* bed image */
$('bedPick').addEventListener('click', () => $('bedFile').click());
$('bedFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const img = new Image();
    img.src = URL.createObjectURL(file);
    await img.decode();
    const probe = document.createElement('canvas'); probe.width = probe.height = 64;
    const pc = probe.getContext('2d', { willReadFrequently: true });
    pc.drawImage(img, 0, 0, 64, 64);
    const d = pc.getImageData(0, 0, 64, 64).data;
    let hasAlpha = false;
    for (let i = 3; i < d.length; i += 4) if (d[i] < 245) { hasAlpha = true; break; }
    customBed = { img, hasAlpha };
    $('bedHint').textContent = hasAlpha ? `${file.name} is overlaid on the print area.` : `${file.name} covers the whole steel sheet.`;
    $('bedReset').disabled = false;
    rebuildBed();
  } catch (err) {
    $('bedHint').textContent = 'That image could not be read. Use a PNG, JPG, WebP, or SVG file.';
  }
});
$('bedReset').addEventListener('click', () => {
  customBed = null; $('bedReset').disabled = true; $('bedHint').textContent = 'Using the built-in MK3S sheet.'; rebuildBed();
});

/* transport */
$('play').addEventListener('click', () => { if (vt >= totalLen()) vt = 0; setPlaying(!playing); });
$('scrub').addEventListener('input', (e) => { setPlaying(false); vt = +e.target.value / 10000 * totalLen(); syncTransport(); dirty = true; });
window.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || !print || exporting || /^(INPUT|SELECT|BUTTON|TEXTAREA)$/.test(e.target.tagName)) return;
  e.preventDefault(); $('play').click();
});

/* camera gestures */
let drag = null;
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey }; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointermove', (e) => {
  if (!drag || exporting) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag.x = e.clientX; drag.y = e.clientY;
  if (drag.pan) {
    const k = .55 * view.zoom, y = view.yaw * DEG;
    view.panX += (-dx * Math.cos(y) - dy * Math.sin(y)) * k;
    view.panY += (-dx * Math.sin(y) + dy * Math.cos(y)) * k;
  } else {
    view.yaw -= dx * .3; view.pitch = clamp(view.pitch + dy * .25, 4, 89);
  }
  dirty = true;
});
canvas.addEventListener('pointerup', () => { drag = null; });
canvas.addEventListener('wheel', (e) => { e.preventDefault(); if (exporting) return; view.zoom = clamp(view.zoom * Math.exp(e.deltaY * .001), .12, 3); dirty = true; }, { passive: false });
canvas.addEventListener('dblclick', () => { if (exporting) return; Object.assign(view, { yaw: -32, pitch: 31, zoom: 1, panX: 0, panY: 0 }); dirty = true; });

/* loading */
const workerUrl = URL.createObjectURL(new Blob([$('parser-src').textContent], { type: 'text/javascript' }));
function setBusy(text, p) {
  $('busy').hidden = text == null;
  if (text != null) { $('busyText').textContent = text; $('busyBar').style.width = `${Math.round(p * 100)}%`; }
}
function parseInWorker(buffer) {
  return new Promise((resolve, reject) => {
    const w = new Worker(workerUrl);
    w.onmessage = (e) => {
      if (e.data.type === 'progress') setBusy('Reading G-code', e.data.value);
      else if (e.data.type === 'done') { w.terminate(); resolve(e.data.result); }
      else { w.terminate(); reject(new Error(e.data.message)); }
    };
    w.onerror = (e) => { w.terminate(); reject(new Error(e.message || 'The G-code reader stopped unexpectedly.')); };
    w.postMessage({ buffer }, [buffer]);
  });
}
function showError(msg) { $('status').textContent = msg; $('status').className = 'err'; }
function clearStatus() { $('status').textContent = ''; $('status').className = ''; }

async function loadBuffer(name, buffer) {
  if (exporting) return;
  setPlaying(false); clearStatus();
  setBusy('Reading G-code', 0);
  try {
    const r = await parseInWorker(buffer);
    if (!r.stats.segments) throw new Error('No extrusion moves were found in this file.');
    print = r; fileName = name;
    R.setPrint(r);
    if (r.cfg.filamentColour && !S.colorTouched) setColor(r.cfg.filamentColour, false);
    vt = 0;
    const st = r.stats, rows = [
      ['File', name], ['Print time', fmtDur(st.printTime)], ['Layers', st.layers.toLocaleString()],
      ['Filament', `${(st.filamentMm / 1000).toFixed(2)} m`], ['Moves', st.moves.toLocaleString()],
    ];
    if (r.cfg.printerModel) rows.splice(1, 0, ['Sliced for', r.cfg.printerModel]);
    const info = $('fileinfo');
    info.replaceChildren(...rows.flatMap(([k, v]) => { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = k; dd.textContent = v; return [dt, dd]; }));
    info.hidden = false;
    $('drop').hidden = true;
    for (const id of ['play', 'scrub']) $(id).disabled = false;
    $('export').disabled = !('VideoEncoder' in window);
    if (!('VideoEncoder' in window)) showError('Video export needs a current version of Edge or Chrome.');
    checkBounds(); updateSpeedInfo(); syncTransport();
    dirty = true;
    setPlaying(true);
  } catch (err) {
    showError(err.message || String(err));
  } finally {
    setBusy(null);
  }
}
async function loadFile(file) {
  if (/\.bgcode$/i.test(file.name)) { showError('Binary .bgcode files are not supported. Export plain text G-code from your slicer.'); return; }
  setBusy('Reading G-code', 0);
  try { await loadBuffer(file.name, await file.arrayBuffer()); }
  catch (err) { setBusy(null); showError(`Could not read ${file.name}: ${err.message}`); }
}
const pick = () => $('file').click();
$('open').addEventListener('click', pick);
$('openBig').addEventListener('click', pick);
$('file').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) loadFile(f); });
window.addEventListener('dragover', (e) => { e.preventDefault(); $('viewport').classList.add('dragging'); });
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) $('viewport').classList.remove('dragging'); });
window.addEventListener('drop', (e) => { e.preventDefault(); $('viewport').classList.remove('dragging'); const f = e.dataTransfer.files[0]; if (f) loadFile(f); });

/* export */
const yieldTask = () => new Promise((r) => { const ch = new MessageChannel(); ch.port1.onmessage = () => r(); ch.port2.postMessage(0); });

async function pickEncoder(w, h, fps, bitrate) {
  // H.264 levels as [code, max macroblocks per second, max macroblocks per frame]
  const LEVELS = [['28', 245760, 8192], ['2A', 522240, 8704], ['32', 589824, 22080], ['33', 983040, 36864], ['34', 2073600, 36864]];
  const mbs = Math.ceil(w / 16) * Math.ceil(h / 16);
  const base = { width: w, height: h, framerate: fps, bitrate, bitrateMode: 'variable', latencyMode: 'quality' };
  const avc = LEVELS.filter(([, rate, frame]) => mbs * fps <= rate && mbs <= frame).map(([code]) => 'avc1.6400' + code);
  for (const accel of ['prefer-hardware', 'no-preference']) {
    for (const codec of avc) {
      const cfg = { ...base, codec, hardwareAcceleration: accel, avc: { format: 'avc' } };
      try { const r = await VideoEncoder.isConfigSupported(cfg); if (r.supported) return cfg; } catch (e) { /* try the next one */ }
    }
  }
  const vp9 = { ...base, codec: 'vp09.00.40.08' };
  try { const r = await VideoEncoder.isConfigSupported(vp9); if (r.supported) return vp9; } catch (e) { /* none left */ }
  return null;
}

async function exportVideo() {
  if (exporting || !print) return null;
  const [w, h] = outDims();
  const fps = S.fps, frames = Math.round(totalLen() * fps);
  const bpp = { standard: .09, high: .16, max: .28 }[S.quality] || .16;
  const bitrate = Math.round(w * h * fps * bpp);
  clearStatus();
  const cfg = await pickEncoder(w, h, fps, bitrate);
  if (!cfg) { showError('This browser has no H.264 or VP9 video encoder available.'); return null; }

  exporting = true; cancelRequested = false; setPlaying(false);
  $('export').hidden = true; $('cancel').hidden = false; $('expBarWrap').hidden = false; $('expBar').style.width = '0';
  const ss = Math.max(w, h) <= 2560 ? 2 : 1;
  R.setSize(w, h, ss);
  R.invalidateShadow();

  const mux = new Mp4Muxer(w, h, fps, cfg.codec);
  let encError = null;
  const encoder = new VideoEncoder({ output: (chunk, meta) => mux.add(chunk, meta), error: (e) => { encError = e; } });
  let blob = null;
  const t0 = performance.now();
  try {
    encoder.configure(cfg);
    for (let i = 0; i < frames; i++) {
      if (cancelRequested) break;
      if (encError) throw encError;
      drawFrame(i / fps, { export: true });
      const vf = new VideoFrame(canvas, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
      encoder.encode(vf, { keyFrame: i % (fps * 2) === 0 });
      vf.close();
      while (encoder.encodeQueueSize > 4 && !encError) await yieldTask();
      if (i % 3 === 0 || i === frames - 1) {
        const done = (i + 1) / frames, el = (performance.now() - t0) / 1000;
        $('expBar').style.width = `${(done * 100).toFixed(1)}%`;
        $('status').textContent = `Rendering frame ${(i + 1).toLocaleString()} of ${frames.toLocaleString()}, about ${fmtClock(el / done - el)} left`;
        await yieldTask();
      }
    }
    if (encError) throw encError;
    if (!cancelRequested) {
      $('status').textContent = 'Finishing the video file';
      await encoder.flush();
      if (encError) throw encError;
      blob = mux.finish();
      const name = fileName.replace(/\.[^.]+$/, '') + '_simulation.mp4';
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 120000);
      const mb = blob.size / 1048576, secs = (performance.now() - t0) / 1000;
      $('status').textContent = `Saved ${name} to your downloads folder (${mb.toFixed(1)} MB, rendered in ${fmtClock(secs)}).`;
    } else {
      $('status').textContent = 'Export cancelled.';
    }
  } catch (err) {
    console.error(err);
    showError(`Export failed: ${err.message || err}`);
  } finally {
    try { encoder.close(); } catch (e) { /* already closed */ }
    exporting = false;
    $('export').hidden = false; $('cancel').hidden = true; $('expBarWrap').hidden = true;
    fitCanvas(); R.invalidateShadow(); dirty = true;
  }
  return blob;
}
$('export').addEventListener('click', exportVideo);
$('cancel').addEventListener('click', () => { cancelRequested = true; });

canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); showError('The graphics context was lost. Reload this page to continue.'); });

/* start */
applySettingsToUI();
R.setBed(S.bedX, S.bedY, S.bedZ, S.label, customBed);
fitCanvas();
syncTransport();
requestAnimationFrame(tick);

window.__sim = {
  loadBuffer, exportVideo, settings: S, info: () => R.info(), view,
  seek(t) { setPlaying(false); vt = t; syncTransport(); drawFrame(vt); },
  apply(patch) { Object.assign(S, patch); applySettingsToUI(); updateSpeedInfo(); fitCanvas(); R.setBed(S.bedX, S.bedY, S.bedZ, S.label, customBed); checkBounds(); drawFrame(vt); },
  stats: () => print && print.stats,
};
})();
