// A tiny Korean "language model" for choosing between OCR readings: the
// unigram SentencePiece vocabulary of the Bergamot ko-en model (already
// bundled) scores how plausible a line is. Used to combine two recognisers.

export interface PieceLM {
  score(text: string): number;
}

/** Parse SentencePiece ModelProto: repeated pieces (field 1) {piece:1, score:2}. */
export function parseSpm(buf: Uint8Array): Map<string, number> {
  const pieces = new Map<string, number>();
  const dec = new TextDecoder();
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let i = 0;
  const varint = () => {
    let v = 0, shift = 0, b: number;
    do { b = buf[i++]; v += (b & 0x7f) * 2 ** shift; shift += 7; } while (b & 0x80);
    return v;
  };
  const skip = (wire: number) => {
    if (wire === 0) varint(); else if (wire === 1) i += 8; else if (wire === 5) i += 4; else if (wire === 2) { const l = varint(); i += l; }
    else throw new Error(`bad wire type ${wire}`);
  };
  while (i < buf.length) {
    const key = varint();
    const field = Math.floor(key / 8), wire = key & 7;
    if (field === 1 && wire === 2) {
      const len = varint();
      const end = i + len;
      let piece = '', score = 0;
      while (i < end) {
        const k = varint();
        const f = Math.floor(k / 8), w = k & 7;
        if (f === 1 && w === 2) { const l = varint(); piece = dec.decode(buf.subarray(i, i + l)); i += l; }
        else if (f === 2 && w === 5) { score = dv.getFloat32(i, true); i += 4; }
        else skip(w);
      }
      pieces.set(piece, score);
    } else skip(wire);
  }
  return pieces;
}

export function makeLM(pieces: Map<string, number>): PieceLM {
  let maxLen = 1, minScore = 0;
  for (const [p, s] of pieces) { maxLen = Math.max(maxLen, [...p].length); minScore = Math.min(minScore, s); }
  const unk = minScore - 5;
  return {
    /** Best unigram segmentation log-likelihood (Viterbi). */
    score(text: string) {
      const s = [...('▁' + text.replace(/ /g, '▁'))];
      const best = new Float64Array(s.length + 1).fill(-1e18);
      best[0] = 0;
      for (let i = 1; i <= s.length; i++) {
        for (let j = Math.max(0, i - maxLen); j < i; j++) {
          let sc = pieces.get(s.slice(j, i).join(''));
          if (sc === undefined) { if (i - j !== 1) continue; sc = unk; }
          if (best[j] + sc > best[i]) best[i] = best[j] + sc;
        }
      }
      return best[s.length];
    },
  };
}

const JUNK = /[ㄱ-ㆎ[\]\\|“”{}]/g; // stray jamo / brackets: typical OCR garbage
const PUNCT = /[.,!?…~]/g;

export function lineScore(lm: PieceLM, t: string): number {
  return lm.score(t) - 8 * (t.match(JUNK)?.length ?? 0) + 5 * (t.match(PUNCT)?.length ?? 0);
}

/** Character diff (LCS) as opcodes: [tag, aText, bText]. */
export function diff(a: string, b: string): ['equal' | 'change', string, string][] {
  const A = [...a], B = [...b];
  const n = A.length, m = B.length;
  const L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const ops: ['equal' | 'change', string, string][] = [];
  let i = 0, j = 0, ca = '', cb = '', eq = '';
  const flushChange = () => { if (ca || cb) { ops.push(['change', ca, cb]); ca = cb = ''; } };
  const flushEq = () => { if (eq) { ops.push(['equal', eq, eq]); eq = ''; } };
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) { flushChange(); eq += A[i]; i++; j++; }
    else { flushEq(); if (j >= m || (i < n && L[i + 1][j] >= L[i][j + 1])) ca += A[i++]; else cb += B[j++]; }
  }
  flushChange(); flushEq();
  return ops;
}

/** Keep `a`, but take `b`'s version of each differing segment when that makes the line more plausible. */
export function mergeReadings(lm: PieceLM, a: string, b: string): string {
  const ops = diff(a, b);
  const choice = ops.map((o) => o[1]);
  for (let k = 0; k < ops.length; k++) {
    if (ops[k][0] === 'equal') continue;
    const alt = [...choice];
    alt[k] = ops[k][2];
    if (lineScore(lm, alt.join('')) > lineScore(lm, choice.join(''))) choice[k] = ops[k][2];
  }
  return choice.join('');
}

const HANGUL = /[\uac00-\ud7a3]/;

/** Combine two recognisers' readings of one line: `a` = primary (good at Latin,
 *  digits, punctuation), `b` = Tesseract (good at Hangul). */
export function combineReadings(lm: PieceLM, a: string, b: string): string {
  if (!a) return b;
  if (!b || a === b) return a;
  const cands = [...new Set([a, b, mergeReadings(lm, b, a), mergeReadings(lm, a, b)])];
  const norm = (t: string) => lineScore(lm, t) / Math.max(1, t.replace(/\s/g, '').length);
  const best = cands.reduce((x, y) => (norm(y) > norm(x) ? y : x));
  // Where the readings differ only in non-Korean characters (Lv.1, +120, %),
  // the language score knows nothing: keep the primary reader's version.
  return diff(best, a).map(([tag, x, y]) => (tag === 'change' && !HANGUL.test(x) && !HANGUL.test(y) && /[A-Za-z0-9]/.test(y + x) ? y : x)).join('');
}
