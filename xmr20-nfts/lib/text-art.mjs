// How an XMR20 NFT is meant to be seen: the record's own JSON text, drawn in an 8×12 pixel font, each character
// coloured from the decoded picture underneath. The same drawing as the xmr20.org pages (FORMAT.md, section 6).
//   palette pictures: 96 characters wide, one colour per character, on a dark ground
//   WebP pictures:    128 characters wide, each font pixel takes the picture's colour at that point, slightly lifted
import { readFileSync } from 'node:fs';
const FONT = Uint8Array.from(Buffer.from(JSON.parse(readFileSync(new URL('./art-font.json', import.meta.url), 'utf8')), 'base64'));   // 95 glyphs × 12 rows

// Bilinear sample of channel k of an RGBA picture.
function sample(raw, w, h, x, y, k) {
  x = Math.max(0, Math.min(w - 1, x)); y = Math.max(0, Math.min(h - 1, y));
  const a = Math.floor(x), b = Math.floor(y), c = Math.min(w - 1, a + 1), d = Math.min(h - 1, b + 1), u = x - a, v = y - b;
  return raw[(b * w + a) * 4 + k] * (1 - u) * (1 - v) + raw[(b * w + c) * 4 + k] * u * (1 - v) + raw[(d * w + a) * 4 + k] * (1 - u) * v + raw[(d * w + c) * 4 + k] * u * v;
}

// record: a mint record; raw: its picture as RGBA bytes of image.width × image.height. -> {width, height, rgb}
export function textArt(record, raw) {
  const { width: w, height: h } = record.image, webp = record.image.codec !== 'json-text-1';
  const cols = webp ? 128 : 96, rows = Math.round(cols * 8 * h / (w * 12)), W = cols * 8, H = rows * 12;
  if (H < 12 || W * H > 6000000) throw Error('Unsupported picture size');
  let text = JSON.stringify({ name: record.name, collection: record.collection, description: record.description, attributes: record.attributes });
  if (webp) text = text.replace(/[\u007f-￿]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  const rgb = Buffer.alloc(W * H * 3), ground = webp ? [12, 16, 20] : [20, 25, 31];
  for (let gy = 0; gy < rows; gy++) for (let gx = 0; gx < cols; gx++) {
    const glyph = text.charCodeAt((gy * cols + gx) % text.length) - 32;
    const colour = webp ? null : [0, 1, 2].map(k => Math.round(sample(raw, w, h, (gx + .5) * w / cols - .5, (gy + .5) * h / rows - .5, k)));
    for (let y = 0; y < 12; y++) for (let x = 0; x < 8; x++) {
      const bits = FONT[glyph * 12 + y], hit = (bits >> (7 - x)) & 1, heavy = webp && x > 0 && ((bits >> (8 - x)) & 1), at = ((gy * 12 + y) * W + gx * 8 + x) * 3;
      for (let k = 0; k < 3; k++) rgb[at + k] = hit || heavy
        ? (webp ? Math.round(255 * Math.pow(sample(raw, w, h, (gx * 8 + x + .5) * w / W - .5, (gy * 12 + y + .5) * h / H - .5, k) / 255, .65)) : colour[k])
        : ground[k];
    }
  }
  return { width: W, height: H, rgb };
}
