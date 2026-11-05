// test/engine/lm-node.ts
import { readFileSync } from "node:fs";

// src/engine/lm.ts
function parseSpm(buf) {
  const pieces = /* @__PURE__ */ new Map();
  const dec = new TextDecoder();
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let i = 0;
  const varint = () => {
    let v = 0, shift = 0, b;
    do {
      b = buf[i++];
      v += (b & 127) * 2 ** shift;
      shift += 7;
    } while (b & 128);
    return v;
  };
  const skip = (wire) => {
    if (wire === 0) varint();
    else if (wire === 1) i += 8;
    else if (wire === 5) i += 4;
    else if (wire === 2) {
      const l = varint();
      i += l;
    } else throw new Error(`bad wire type ${wire}`);
  };
  while (i < buf.length) {
    const key = varint();
    const field = Math.floor(key / 8), wire = key & 7;
    if (field === 1 && wire === 2) {
      const len = varint();
      const end = i + len;
      let piece = "", score = 0;
      while (i < end) {
        const k = varint();
        const f = Math.floor(k / 8), w = k & 7;
        if (f === 1 && w === 2) {
          const l = varint();
          piece = dec.decode(buf.subarray(i, i + l));
          i += l;
        } else if (f === 2 && w === 5) {
          score = dv.getFloat32(i, true);
          i += 4;
        } else skip(w);
      }
      pieces.set(piece, score);
    } else skip(wire);
  }
  return pieces;
}
function makeLM(pieces) {
  let maxLen = 1, minScore = 0;
  for (const [p, s] of pieces) {
    maxLen = Math.max(maxLen, [...p].length);
    minScore = Math.min(minScore, s);
  }
  const unk = minScore - 5;
  return {
    /** Best unigram segmentation log-likelihood (Viterbi). */
    score(text) {
      const s = [..."\u2581" + text.replace(/ /g, "\u2581")];
      const best = new Float64Array(s.length + 1).fill(-1e18);
      best[0] = 0;
      for (let i = 1; i <= s.length; i++) {
        for (let j = Math.max(0, i - maxLen); j < i; j++) {
          let sc = pieces.get(s.slice(j, i).join(""));
          if (sc === void 0) {
            if (i - j !== 1) continue;
            sc = unk;
          }
          if (best[j] + sc > best[i]) best[i] = best[j] + sc;
        }
      }
      return best[s.length];
    }
  };
}
var JUNK = /[ㄱ-ㆎ[\]\\|“”{}]/g;
var PUNCT = /[.,!?…~]/g;
function lineScore(lm2, t) {
  return lm2.score(t) - 8 * (t.match(JUNK)?.length ?? 0) + 5 * (t.match(PUNCT)?.length ?? 0);
}
function diff(a, b) {
  const A = [...a], B = [...b];
  const n = A.length, m = B.length;
  const L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i2 = n - 1; i2 >= 0; i2--) for (let j2 = m - 1; j2 >= 0; j2--) L[i2][j2] = A[i2] === B[j2] ? L[i2 + 1][j2 + 1] + 1 : Math.max(L[i2 + 1][j2], L[i2][j2 + 1]);
  const ops = [];
  let i = 0, j = 0, ca = "", cb = "", eq = "";
  const flushChange = () => {
    if (ca || cb) {
      ops.push(["change", ca, cb]);
      ca = cb = "";
    }
  };
  const flushEq = () => {
    if (eq) {
      ops.push(["equal", eq, eq]);
      eq = "";
    }
  };
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) {
      flushChange();
      eq += A[i];
      i++;
      j++;
    } else {
      flushEq();
      if (j >= m || i < n && L[i + 1][j] >= L[i][j + 1]) ca += A[i++];
      else cb += B[j++];
    }
  }
  flushChange();
  flushEq();
  return ops;
}
function mergeReadings(lm2, a, b) {
  const ops = diff(a, b);
  const choice = ops.map((o) => o[1]);
  for (let k = 0; k < ops.length; k++) {
    if (ops[k][0] === "equal") continue;
    const alt = [...choice];
    alt[k] = ops[k][2];
    if (lineScore(lm2, alt.join("")) > lineScore(lm2, choice.join(""))) choice[k] = ops[k][2];
  }
  return choice.join("");
}
function combineReadings(lm2, a, b) {
  if (!a) return b;
  if (!b || a === b) return a;
  const cands = [.../* @__PURE__ */ new Set([a, b, mergeReadings(lm2, b, a), mergeReadings(lm2, a, b)])];
  const norm = (t) => lineScore(lm2, t) / Math.max(1, t.replace(/\s/g, "").length);
  return cands.reduce((x, y) => norm(y) > norm(x) ? y : x);
}

// test/engine/lm-node.ts
var lm = makeLM(parseSpm(new Uint8Array(readFileSync("assets/models/bergamot/koen/vocab.koen.spm"))));
var idx = JSON.parse(readFileSync(process.argv[2], "utf8"));
var out = {};
for (const [k, rows] of Object.entries(idx)) out[k] = rows.map((r) => combineReadings(lm, r.korean_g2, r.tess_best));
console.log(JSON.stringify(out));
