'use strict';
/* G-code parser and motion-time model. Runs inside a Web Worker (and under Node for tests). */

function scanConfig(u8) {
  const dec = new TextDecoder('latin1');
  const head = dec.decode(u8.subarray(0, Math.min(u8.length, 256 * 1024)));
  const tail = u8.length > 256 * 1024 ? dec.decode(u8.subarray(Math.max(256 * 1024, u8.length - 768 * 1024))) : '';
  const text = head + '\n' + tail;
  const get = (key) => {
    const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = text.match(new RegExp('^;\\s*' + esc + '\\s*[=:]\\s*(.+?)\\s*$', 'm'));
    return m ? m[1] : null;
  };
  const num = (key) => {
    const v = get(key);
    if (v == null) return 0;
    const n = parseFloat(v.split(/[,;]/)[0]);
    return Number.isFinite(n) ? n : 0;
  };
  const colour = (get('filament_colour') || get('extruder_colour') || '').split(/[,;]/)[0].trim();
  return {
    nozzle: num('nozzle_diameter'),
    filamentDiameter: num('filament_diameter'),
    layerHeight: num('layer_height'),
    firstLayerHeight: num('first_layer_height'),
    filamentColour: /^#[0-9a-fA-F]{6}$/.test(colour) ? colour : null,
    filamentType: (get('filament_type') || '').split(/[,;]/)[0].trim() || null,
    printerModel: get('printer_model'),
    bedShape: get('bed_shape'),
    maxPrintHeight: num('max_print_height'),
    slicerTime: get('estimated printing time (normal mode)'),
    filamentGrams: num('filament used [g]'),
  };
}

function grow(arr, need) {
  if (need <= arr.length) return arr;
  let n = arr.length * 2;
  while (n < need) n *= 2;
  const out = new arr.constructor(n);
  out.set(arr);
  return out;
}

function parseGcode(u8, onProgress) {
  if (u8.length >= 4 && u8[0] === 0x47 && u8[1] === 0x43 && u8[2] === 0x44 && u8[3] === 0x45) {
    throw new Error('This is a binary G-code (.bgcode) file. Export plain text G-code from your slicer instead.');
  }

  const cfg = scanConfig(u8);
  const nozzle = cfg.nozzle > 0 ? cfg.nozzle : 0.4;
  const filD = cfg.filamentDiameter > 0 ? cfg.filamentDiameter : 1.75;
  const filArea = Math.PI * filD * filD / 4;
  const minW = nozzle * 0.35, maxW = nozzle * 8;

  // Move storage
  let cap = 1 << 16;
  let mP = new Float32Array((cap + 1) * 3);
  let mU = new Float32Array(cap * 4);
  let mLen = new Float32Array(cap);
  let mV = new Float32Array(cap);
  let mA = new Float32Array(cap);
  let nM = 0;

  // Extruded segments: ax ay az bx by bz width height
  let segCap = 1 << 16;
  let seg = new Float32Array(segCap * 8);
  let segMove = new Uint32Array(segCap);
  let nS = 0;

  // Travel moves: ax ay az bx by bz
  let trvCap = 1 << 14;
  let trv = new Float32Array(trvCap * 6);
  let trvMove = new Uint32Array(trvCap);
  let nT = 0;

  const layerSeg = [], layerZs = [];

  // Machine state
  let cx = 0, cy = 0, cz = 0;          // machine position
  let lx = 0, ly = 0, lz = 0, le = 0;  // logical position (after G92)
  let ox = 0, oy = 0, oz = 0;          // G92 offsets
  let relXYZ = false, m83 = false;
  let feed = 25, feedPct = 1;          // feed in mm/s

  // Firmware limits (MK3S defaults, overridden by the file)
  let vMaxX = 200, vMaxY = 200, vMaxZ = 12, vMaxE = 120;
  let aMaxX = 1000, aMaxY = 1000, aMaxZ = 200, aMaxE = 5000;
  let accP = 1250, accR = 1250, accT = 1250;
  let jX = 8, jY = 8, jZ = 0.4, jE = 4.5;

  // Layer tracking
  let layerZ = -Infinity, curH = cfg.firstLayerHeight > 0 ? cfg.firstLayerHeight : (cfg.layerHeight > 0 ? cfg.layerHeight : 0.2);
  let pendingLayer = false, sawLayerComments = false;
  let heightComment = 0, widthComment = 0, lastW = nozzle * 1.1;

  // Stats
  let filamentMm = 0;
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  function ensureMoves() {
    if (nM < cap) return;
    cap *= 2;
    mP = grow(mP, (cap + 1) * 3); mU = grow(mU, cap * 4);
    mLen = grow(mLen, cap); mV = grow(mV, cap); mA = grow(mA, cap);
  }

  function pushPoint(k, x, y, z) { mP[k * 3] = x; mP[k * 3 + 1] = y; mP[k * 3 + 2] = z; }

  function addJump(x, y, z) {
    ensureMoves();
    const k = nM++;
    mLen[k] = 0; mV[k] = 0; mA[k] = 1;
    mU[k * 4] = mU[k * 4 + 1] = mU[k * 4 + 2] = mU[k * 4 + 3] = 0;
    pushPoint(k + 1, x, y, z);
    cx = x; cy = y; cz = z;
  }

  function addSegment(moveIdx, x, y, z, de, dist) {
    if (pendingLayer || (!sawLayerComments && z > layerZ + 0.019)) {
      const dz = layerZ === -Infinity ? z : z - layerZ;
      if (dz >= 0.04 && dz <= 1.2) curH = dz;
      layerZ = z;
      pendingLayer = false;
      layerSeg.push(nS);
      layerZs.push(z);
    }
    const h = heightComment > 0 ? heightComment : curH;
    let w = (de * filArea / dist) / h + h * (1 - Math.PI / 4);
    if (!Number.isFinite(w)) w = widthComment > 0 ? widthComment : lastW;
    if (dist < 0.15) w = widthComment > 0 ? widthComment : lastW;
    w = Math.min(maxW, Math.max(minW, w));
    lastW = w;

    if (nS >= segCap) {
      segCap *= 2;
      seg = grow(seg, segCap * 8);
      segMove = grow(segMove, segCap);
    }
    const i = nS * 8;
    seg[i] = cx; seg[i + 1] = cy; seg[i + 2] = cz;
    seg[i + 3] = x; seg[i + 4] = y; seg[i + 5] = z;
    seg[i + 6] = w; seg[i + 7] = h;
    segMove[nS++] = moveIdx;

    if (cx < minX) minX = cx; if (x < minX) minX = x;
    if (cy < minY) minY = cy; if (y < minY) minY = y;
    if (cx > maxX) maxX = cx; if (x > maxX) maxX = x;
    if (cy > maxY) maxY = cy; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }

  function addMove(x, y, z, de) {
    const dx = x - cx, dy = y - cy, dz = z - cz;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < 1e-6 && Math.abs(de) < 1e-7) return;
    ensureMoves();
    const L = dist > 1e-6 ? dist : Math.abs(de);
    const ux = dx / L, uy = dy / L, uz = dz / L, ue = de / L;
    const k = nM++;
    mU[k * 4] = ux; mU[k * 4 + 1] = uy; mU[k * 4 + 2] = uz; mU[k * 4 + 3] = ue;
    mLen[k] = L;

    let v = feed * feedPct;
    if (ux !== 0) v = Math.min(v, vMaxX / Math.abs(ux));
    if (uy !== 0) v = Math.min(v, vMaxY / Math.abs(uy));
    if (uz !== 0) v = Math.min(v, vMaxZ / Math.abs(uz));
    if (ue !== 0) v = Math.min(v, vMaxE / Math.abs(ue));
    mV[k] = v;

    const dxy = Math.sqrt(dx * dx + dy * dy);
    const extruding = de > 1e-6 && dxy > 1e-4;
    let a = extruding ? accP : (dist > 1e-6 ? accT : accR);
    if (ux !== 0) a = Math.min(a, aMaxX / Math.abs(ux));
    if (uy !== 0) a = Math.min(a, aMaxY / Math.abs(uy));
    if (uz !== 0) a = Math.min(a, aMaxZ / Math.abs(uz));
    if (ue !== 0) a = Math.min(a, aMaxE / Math.abs(ue));
    mA[k] = a;

    pushPoint(k + 1, x, y, z);

    if (de > 0) filamentMm += de;
    if (extruding) {
      addSegment(k, x, y, z, de, dist);
    } else if (dxy > 0.3) {
      if (nT >= trvCap) {
        trvCap *= 2;
        trv = grow(trv, trvCap * 6);
        trvMove = grow(trvMove, trvCap);
      }
      const i = nT * 6;
      trv[i] = cx; trv[i + 1] = cy; trv[i + 2] = cz;
      trv[i + 3] = x; trv[i + 4] = y; trv[i + 5] = z;
      trvMove[nT++] = k;
    }
    cx = x; cy = y; cz = z;
  }

  function addArc(cw, tx, ty, tz, de, I, J, R, hasIJ) {
    const sx = cx, sy = cy, sz = cz;
    let ci, cj;
    if (hasIJ) {
      ci = sx + I; cj = sy + J;
    } else {
      const mx = (tx - sx) / 2, my = (ty - sy) / 2;
      const q2 = mx * mx + my * my;
      if (q2 < 1e-12 || !R) { addMove(tx, ty, tz, de); return; }
      const off = Math.sqrt(Math.max(0, R * R - q2));
      const q = Math.sqrt(q2);
      const sign = ((R > 0) === cw) ? 1 : -1;
      ci = sx + mx + sign * off * (my / q);
      cj = sy + my - sign * off * (mx / q);
    }
    const r = Math.hypot(sx - ci, sy - cj);
    if (r < 1e-5) { addMove(tx, ty, tz, de); return; }
    const a0 = Math.atan2(sy - cj, sx - ci);
    const a1 = Math.atan2(ty - cj, tx - ci);
    let sweep = a1 - a0;
    if (cw) { if (sweep >= -1e-9) sweep -= Math.PI * 2; }
    else { if (sweep <= 1e-9) sweep += Math.PI * 2; }
    const chord = 2 * Math.sqrt(Math.max(1e-6, 2 * r * 0.01));
    const steps = Math.max(1, Math.min(720, Math.ceil(Math.abs(sweep) * r / chord)));
    for (let s = 1; s <= steps; s++) {
      const f = s / steps;
      if (s === steps) addMove(tx, ty, tz, de / steps);
      else addMove(ci + r * Math.cos(a0 + sweep * f), cj + r * Math.sin(a0 + sweep * f), sz + (tz - sz) * f, de / steps);
    }
  }

  // Parameter scratch space, indexed by letter
  const val = new Float64Array(26);
  const has = new Uint32Array(26);
  let stamp = 0;

  const N = u8.length;
  let i = 0, nextReport = 0;

  function commentNumber(start, end) {
    return parseFloat(String.fromCharCode.apply(null, u8.subarray(start, Math.min(end, start + 24))));
  }
  function startsWith(pos, end, s) {
    if (pos + s.length > end) return false;
    for (let k = 0; k < s.length; k++) if (u8[pos + k] !== s.charCodeAt(k)) return false;
    return true;
  }

  while (i < N) {
    let end = u8.indexOf(10, i);
    if (end < 0) end = N;
    if (i >= nextReport) { onProgress && onProgress(i / N * 0.9); nextReport = i + 4194304; }

    let p = i;
    i = end + 1;
    while (p < end && (u8[p] === 32 || u8[p] === 9)) p++;
    if (p >= end) continue;

    if (u8[p] === 59) { // comment
      const c = p + 1;
      if (startsWith(c, end, 'LAYER_CHANGE') || startsWith(c, end, 'LAYER:')) {
        // Anything extruded before the first layer marker (the purge line) is not a layer of the print
        if (!sawLayerComments) { layerSeg.length = 0; layerZs.length = 0; layerZ = -Infinity; }
        pendingLayer = true; sawLayerComments = true;
      } else if (startsWith(c, end, 'HEIGHT:')) {
        const v = commentNumber(c + 7, end);
        heightComment = v > 0 && v < 2 ? v : 0;
      } else if (startsWith(c, end, 'WIDTH:')) {
        const v = commentNumber(c + 6, end);
        widthComment = v > 0 && v < 10 ? v : 0;
      }
      continue;
    }

    // Read the words on this line
    stamp++;
    let letter = -1, code = -1, sub = 0;
    while (p < end) {
      let ch = u8[p];
      if (ch === 59 || ch === 42) break;             // ';' comment or '*' checksum
      if (ch >= 97 && ch <= 122) ch -= 32;           // to upper case
      if (ch < 65 || ch > 90) { p++; continue; }
      const idx = ch - 65;
      p++;
      while (p < end && (u8[p] === 32 || u8[p] === 9)) p++;
      let neg = false, c = u8[p];
      if (c === 45) { neg = true; p++; } else if (c === 43) { p++; }
      let v = 0, digits = 0;
      while (p < end && (c = u8[p]) >= 48 && c <= 57) { v = v * 10 + c - 48; p++; digits++; }
      let frac = 0, fracDigits = 0;
      if (p < end && u8[p] === 46) {
        p++;
        let scale = 0.1;
        while (p < end && (c = u8[p]) >= 48 && c <= 57) { v += (c - 48) * scale; scale *= 0.1; p++; digits++; fracDigits++; }
      }
      if (p < end && (u8[p] === 101 || u8[p] === 69) && digits) {
        const q = p + 1;
        const c2 = u8[q];
        if ((c2 >= 48 && c2 <= 57) || c2 === 45 || c2 === 43) {
          let r = q, eNeg = false;
          if (c2 === 45) { eNeg = true; r++; } else if (c2 === 43) r++;
          let ev = 0;
          while (r < end && (c = u8[r]) >= 48 && c <= 57) { ev = ev * 10 + c - 48; r++; }
          v *= Math.pow(10, eNeg ? -ev : ev);
          p = r;
        }
      }
      frac = neg ? -v : v;
      if (letter < 0) {
        if (idx === 13) continue;                    // N line number
        letter = idx; code = Math.trunc(frac);
        sub = fracDigits ? Math.round((frac - code) * 10) : 0;
      } else {
        val[idx] = frac; has[idx] = stamp;
      }
    }
    if (letter < 0) continue;

    const X = 23, Y = 24, Z = 25, E = 4, F = 5, S = 18, P = 15, R = 17, T = 19, I = 8, J = 9;
    const on = (k) => has[k] === stamp;

    if (letter === 6) { // G
      if (code === 0 || code === 1 || code === 2 || code === 3) {
        if (on(F) && val[F] > 0) feed = val[F] / 60;
        let tlx = lx, tly = ly, tlz = lz;
        if (on(X)) tlx = relXYZ ? lx + val[X] : val[X];
        if (on(Y)) tly = relXYZ ? ly + val[Y] : val[Y];
        if (on(Z)) tlz = relXYZ ? lz + val[Z] : val[Z];
        let de = 0;
        if (on(E)) {
          if (m83 || relXYZ) { de = val[E]; le += de; }
          else { de = val[E] - le; le = val[E]; }
        }
        lx = tlx; ly = tly; lz = tlz;
        const mx = lx + ox, my = ly + oy, mz = lz + oz;
        if (code <= 1) addMove(mx, my, mz, de);
        else addArc(code === 2, mx, my, mz, de, on(I) ? val[I] : 0, on(J) ? val[J] : 0, on(R) ? val[R] : 0, on(I) || on(J));
      } else if (code === 28) {
        const all = !on(X) && !on(Y) && !on(Z);
        if (all || on(X)) { lx = 0; ox = 0; }
        if (all || on(Y)) { ly = 0; oy = 0; }
        if (all || on(Z)) { lz = 0; oz = 0; }
        addJump(lx + ox, ly + oy, lz + oz);
      } else if (code === 90) {
        relXYZ = false;
      } else if (code === 91) {
        relXYZ = true;
      } else if (code === 92) {
        const all = !on(X) && !on(Y) && !on(Z) && !on(E);
        if (all || on(X)) { const v = on(X) ? val[X] : 0; ox = cx - v; lx = v; }
        if (all || on(Y)) { const v = on(Y) ? val[Y] : 0; oy = cy - v; ly = v; }
        if (all || on(Z)) { const v = on(Z) ? val[Z] : 0; oz = cz - v; lz = v; }
        if (all || on(E)) { le = on(E) ? val[E] : 0; }
      }
    } else if (letter === 12) { // M
      if (code === 82) m83 = false;
      else if (code === 83) m83 = true;
      else if (code === 220) { if (on(S) && val[S] > 0) feedPct = val[S] / 100; }
      else if (code === 201) {
        if (on(X) && val[X] > 0) aMaxX = val[X]; if (on(Y) && val[Y] > 0) aMaxY = val[Y];
        if (on(Z) && val[Z] > 0) aMaxZ = val[Z]; if (on(E) && val[E] > 0) aMaxE = val[E];
      } else if (code === 203) {
        if (on(X) && val[X] > 0) vMaxX = val[X]; if (on(Y) && val[Y] > 0) vMaxY = val[Y];
        if (on(Z) && val[Z] > 0) vMaxZ = val[Z]; if (on(E) && val[E] > 0) vMaxE = val[E];
      } else if (code === 204) {
        if (on(S) && val[S] > 0) { accP = val[S]; accT = val[S]; }
        if (on(P) && val[P] > 0) accP = val[P];
        if (on(R) && val[R] > 0) accR = val[R];
        if (on(T) && val[T] > 0) accT = val[T];
      } else if (code === 205) {
        if (on(X) && val[X] >= 0) jX = val[X]; if (on(Y) && val[Y] >= 0) jY = val[Y];
        if (on(Z) && val[Z] >= 0) jZ = val[Z]; if (on(E) && val[E] >= 0) jE = val[E];
      }
    }
  }

  onProgress && onProgress(0.92);

  // Look-ahead planner: junction speeds, then trapezoid time for every move
  const entry = new Float32Array(nM + 1);
  for (let k = 1; k < nM; k++) {
    if (mLen[k - 1] <= 0 || mLen[k] <= 0) continue;
    const vj = Math.min(mV[k - 1], mV[k]);
    const a = (k - 1) * 4, b = k * 4;
    let f = 1, dv;
    dv = Math.abs(mU[a] - mU[b]) * vj;         if (dv > jX) f = Math.min(f, jX / dv);
    dv = Math.abs(mU[a + 1] - mU[b + 1]) * vj; if (dv > jY) f = Math.min(f, jY / dv);
    dv = Math.abs(mU[a + 2] - mU[b + 2]) * vj; if (dv > jZ) f = Math.min(f, jZ / dv);
    dv = Math.abs(mU[a + 3] - mU[b + 3]) * vj; if (dv > jE) f = Math.min(f, jE / dv);
    entry[k] = vj * f;
  }
  for (let k = nM - 1; k >= 0; k--) {
    const lim = Math.sqrt(entry[k + 1] * entry[k + 1] + 2 * mA[k] * mLen[k]);
    if (entry[k] > lim) entry[k] = lim;
  }
  for (let k = 0; k < nM; k++) {
    const lim = Math.sqrt(entry[k] * entry[k] + 2 * mA[k] * mLen[k]);
    if (entry[k + 1] > lim) entry[k + 1] = lim;
  }

  const mT = new Float64Array(nM + 1);
  let t = 0;
  for (let k = 0; k < nM; k++) {
    const L = mLen[k];
    if (L > 0 && mV[k] > 0) {
      const a = mA[k], vs = entry[k], ve = entry[k + 1];
      const vp = Math.max(1e-3, Math.min(mV[k], Math.sqrt((2 * a * L + vs * vs + ve * ve) / 2)));
      const d1 = Math.max(0, (vp * vp - vs * vs) / (2 * a));
      const d3 = Math.max(0, (vp * vp - ve * ve) / (2 * a));
      const d2 = Math.max(0, L - d1 - d3);
      t += Math.max(0, vp - vs) / a + Math.max(0, vp - ve) / a + d2 / vp;
    }
    mT[k + 1] = t;
  }

  onProgress && onProgress(0.97);

  const sT0 = new Float64Array(nS), sT1 = new Float64Array(nS);
  for (let s = 0; s < nS; s++) { sT0[s] = mT[segMove[s]]; sT1[s] = mT[segMove[s] + 1]; }
  const trvT = new Float64Array(nT);
  for (let s = 0; s < nT; s++) trvT[s] = mT[trvMove[s]];

  const tStart = nS ? sT0[0] : 0;
  const lastExtrude = nS ? sT1[nS - 1] : t;
  const tEnd = Math.min(t, lastExtrude + 20);

  const result = {
    seg: seg.slice(0, nS * 8),
    sT0, sT1,
    trv: trv.slice(0, nT * 6),
    trvT,
    mP: mP.slice(0, (nM + 1) * 3),
    mT,
    layerSeg: Uint32Array.from(layerSeg),
    layerZ: Float32Array.from(layerZs),
    stats: {
      moves: nM, segments: nS, travels: nT, layers: layerSeg.length,
      filamentMm, tStart, tEnd, totalTime: t,
      printTime: tEnd - tStart,
      bbox: nS ? { minX, minY, minZ, maxX, maxY, maxZ } : null,
    },
    cfg,
  };
  onProgress && onProgress(1);
  return result;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseGcode, scanConfig };
} else if (typeof self !== 'undefined' && typeof document === 'undefined') {
  self.onmessage = async (ev) => {
    try {
      const u8 = new Uint8Array(ev.data.buffer);
      const r = parseGcode(u8, (p) => self.postMessage({ type: 'progress', value: p }));
      self.postMessage({ type: 'done', result: r }, [
        r.seg.buffer, r.sT0.buffer, r.sT1.buffer, r.trv.buffer, r.trvT.buffer,
        r.mP.buffer, r.mT.buffer, r.layerSeg.buffer, r.layerZ.buffer,
      ]);
    } catch (err) {
      self.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
    }
  };
}
