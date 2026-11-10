// The picture codec of "json-text-1" images: a palette-index map packed with an adaptive binary range coder.
// Integer-only and deterministic, so decoding and encoding again gives the same bytes; a mint whose picture does
// not survive that round trip is refused.
//   mode 3: a "same as the cell to the left?" bit, else a "same as the cell above?" bit, else the palette index as a
//           bit tree under the context of the left cell.
const kTop = 1 << 24, kBits = 11, kOne = 1 << kBits, kShift = 4;

class Encoder {
  constructor() { this.low = 0; this.range = 0xFFFFFFFF; this.cache = 0; this.cacheSize = 1; this.out = []; }
  shiftLow() {
    if (this.low < 0xFF000000 || this.low >= 0x100000000) {
      const carry = this.low >= 0x100000000 ? 1 : 0;
      let temp = this.cache;
      do { this.out.push((temp + carry) & 0xFF); temp = 0xFF; } while (--this.cacheSize !== 0);
      this.cache = (this.low >>> 24) & 0xFF;
    }
    this.cacheSize++;
    this.low = (this.low & 0x00FFFFFF) * 256; // keep as Number, may exceed 2^32 to signal carry
  }
  encodeBit(probs, i, bit) {
    const p = probs[i];
    const bound = (this.range >>> kBits) * p;
    if (bit === 0) { this.range = bound; probs[i] = p + ((kOne - p) >> kShift); }
    else { this.low += bound; this.range -= bound; probs[i] = p - (p >> kShift); }
    while (this.range < kTop) { this.range = (this.range * 256) >>> 0; this.shiftLow(); }
  }
  encodeTree(probs, base, nbits, sym) {
    let m = 1;
    for (let i = nbits - 1; i >= 0; i--) { const bit = (sym >> i) & 1; this.encodeBit(probs, base + m, bit); m = (m << 1) | bit; }
  }
  finish() { for (let i = 0; i < 5; i++) this.shiftLow(); return Buffer.from(this.out); }
}

class Decoder {
  constructor(buf, pos = 0) {
    this.buf = buf; this.pos = pos; this.range = 0xFFFFFFFF; this.code = 0;
    for (let i = 0; i < 5; i++) this.code = ((this.code * 256) + this.next()) % 0x100000000;
  }
  next() { return this.pos < this.buf.length ? this.buf[this.pos++] : 0; }
  decodeBit(probs, i) {
    const p = probs[i];
    const bound = (this.range >>> kBits) * p; let bit;
    if (this.code < bound) { this.range = bound; probs[i] = p + ((kOne - p) >> kShift); bit = 0; }
    else { this.code -= bound; this.range -= bound; probs[i] = p - (p >> kShift); bit = 1; }
    while (this.range < kTop) { this.range = (this.range * 256) >>> 0; this.code = ((this.code * 256) + this.next()) % 0x100000000; }
    return bit;
  }
  decodeTree(probs, base, nbits) {
    let m = 1;
    for (let i = 0; i < nbits; i++) m = (m << 1) | this.decodeBit(probs, base + m);
    return m - (1 << nbits);
  }
}

function newProbs(n) { const a = new Uint16Array(n); a.fill(kOne >> 1); return a; }

function makeModel(n, mode) {
  const nbits = Math.log2(n) | 0;
  return { n, nbits, mode, probs: newProbs((n + 1) * (1 << nbits) + 64) };
}
function neigh(idx, i, w, n) {
  const x = i % w, y = (i / w) | 0;
  return [x ? idx[i - 1] : n, y ? idx[i - w] : n, (x && y) ? idx[i - w - 1] : n];
}
function encodeMap(idx, w, h, n, mode = 3) {
  const M = makeModel(n, mode), enc = new Encoder(), base = (n + 1) * (1 << M.nbits);
  let prevSame = 0;
  for (let i = 0; i < w * h; i++) {
    const [L, U, UL] = neigh(idx, i, w, n), v = idx[i];
    if (mode === 0) { enc.encodeTree(M.probs, L << M.nbits, M.nbits, v); continue; }
    const c1 = base + prevSame * 4 + (U === L ? 1 : 0) + (UL === L ? 2 : 0);
    const sameL = (L !== n && v === L) ? 1 : 0;
    enc.encodeBit(M.probs, c1, sameL ^ 1); prevSame = sameL;
    if (sameL) continue;
    if (U !== n && U !== L) {
      const sameU = v === U ? 1 : 0; enc.encodeBit(M.probs, base + 8 + (UL === U ? 1 : 0), sameU ^ 1);
      if (sameU) continue;
    }
    enc.encodeTree(M.probs, L << M.nbits, M.nbits, v);
  }
  return enc.finish();
}
function decodeMap(buf, pos, w, h, n, mode = 3) {
  const M = makeModel(n, mode), dec = new Decoder(buf, pos), base = (n + 1) * (1 << M.nbits), idx = new Uint8Array(w * h);
  let prevSame = 0;
  for (let i = 0; i < w * h; i++) {
    const [L, U, UL] = neigh(idx, i, w, n);
    if (mode === 0) { idx[i] = dec.decodeTree(M.probs, L << M.nbits, M.nbits); continue; }
    const c1 = base + prevSame * 4 + (U === L ? 1 : 0) + (UL === L ? 2 : 0);
    const sameL = dec.decodeBit(M.probs, c1) ^ 1; prevSame = sameL;
    if (sameL) { if (L === n) throw new Error('invalid map stream'); idx[i] = L; continue; }
    if (U !== n && U !== L) {
      const sameU = dec.decodeBit(M.probs, base + 8 + (UL === U ? 1 : 0)) ^ 1;
      if (sameU) { idx[i] = U; continue; }
    }
    const v = dec.decodeTree(M.probs, L << M.nbits, M.nbits);
    if (v === L || (U !== n && U !== L && v === U)) throw new Error('non-canonical map stream');
    idx[i] = v;
  }
  return { idx, end: dec.pos };
}
export { encodeMap, decodeMap };
