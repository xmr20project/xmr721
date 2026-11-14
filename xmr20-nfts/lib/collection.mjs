// A collection as saved in ../collections: its header, its items and the pictures of its mints, decoded from the
// saved raw transactions. Used by the reader service to show a collection next to the Mordinals.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, crc32 } from 'node:zlib';
import { recordOf } from './format.mjs';
import { decodeMap } from './map-codec.mjs';
import { textArt } from './text-art.mjs';

function png(width, height, rgb) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]), out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc32(body) >>> 0, body.length + 4);
    return out;
  };
  const head = Buffer.alloc(13); head.writeUInt32BE(width, 0); head.writeUInt32BE(height, 4); head[8] = 8; head[9] = 2;
  const rows = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) rgb.copy(rows, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', head), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

// The plain decoded picture of a mint record as RGBA bytes. A WebP picture needs the optional `sharp` package.
export async function picturePixels(image) {
  const bytes = Buffer.from(image.data, 'base64');
  if (image.codec === 'json-text-1') {
    const { idx } = decodeMap(bytes, 0, image.width, image.height, image.palette.length), raw = Buffer.alloc(idx.length * 4, 255);
    idx.forEach((v, i) => raw.write(image.palette[v], i * 4, 'hex'));
    return raw;
  }
  const { default: sharp } = await import('sharp');
  return sharp(bytes).ensureAlpha().raw().toBuffer();
}
// A mint record as the picture people know: its text drawn over its picture (text-art.mjs), as a PNG.
// `plain: true` gives the bare decoded picture instead.
export async function pictureFile(record, { plain = false } = {}) {
  const image = record.image, raw = await picturePixels(image);
  if (plain) { const rgb = Buffer.alloc(image.width * image.height * 3); for (let i = 0; i < image.width * image.height; i++) raw.copy(rgb, i * 3, i * 4, i * 4 + 3); return { type: 'image/png', bytes: png(image.width, image.height, rgb) }; }
  const art = textArt(record, raw);
  return { type: 'image/png', bytes: png(art.width, art.height, art.rgb) };
}

export function loadCollection(dir, name) {
  const header = JSON.parse(readFileSync(join(dir, name + '.json'), 'utf8'));
  const items = readFileSync(join(dir, name + '.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const saved = JSON.parse(readFileSync(join(dir, name + '-transactions.json'), 'utf8'));
  const extras = new Map(saved.transactions.map(t => [t.txid, t.extra])), files = new Map();
  return {
    key: name, header, items,
    // The saved transactions of the collection in chain order: {txid, height, pos, extra}.
    transactions: saved.transactions,
    // -> a promise of {type, bytes}, or null when there is no such edition. Drawn once, then kept.
    picture(edition, { plain = false } = {}) {
      const item = items.find(t => t.edition === edition);
      if (!item) return null;
      const key = edition + (plain ? ':plain' : '');
      if (!files.has(key)) files.set(key, pictureFile(recordOf(Buffer.from(extras.get(item.id), 'hex')).record, { plain }));
      return files.get(key);
    },
  };
}
// Every collection saved in a folder -> Map(key -> collection).
export function loadCollections(dir) {
  const out = new Map();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).sort()) if (f.endsWith('.jsonl')) { const c = loadCollection(dir, f.slice(0, -6)); out.set(c.key, c); }
  return out;
}
