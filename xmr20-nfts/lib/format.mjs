// XMR20 NFT records (profile XMR20-NFT-V2) as they sit in Monero transactions. See ../FORMAT.md.
//
//   tx_extra  ->  carrier fragments ("XM2")  ->  "XMR20T2" + raw DEFLATE  ->  JSON {record, signature}
//
// Everything here fails closed: a transaction that does not parse exactly is simply not an NFT record.
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

export const DOMAIN = 'XMR20-NFT-V2\n';
export const MAX_EXTRA = 1060, MAX_CARRIER = 984, MAX_JSON = 16384;
const MAGIC = Buffer.from('XMR20T2'), FRAGMENT = Buffer.from('XM2');

export const sha256 = data => createHash('sha256').update(data).digest('hex');
const need = (ok, why) => { if (!ok) throw Error(why); };
const plain = x => x !== null && typeof x === 'object' && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;
const fields = (x, list) => need(plain(x) && Object.keys(x).sort().join('|') === [...list].sort().join('|'), 'Unexpected fields');
const hex = (x, n) => typeof x === 'string' && new RegExp(`^[0-9a-f]{${n}}$`).test(x);
const text = (x, max, empty = false) => typeof x === 'string' && x.length <= max && x.length >= (empty ? 0 : 1) && /^[\x20-\x7e]*$/.test(x);
const address = x => typeof x === 'string' && /^4[1-9A-HJ-NP-Za-km-z]{94}$/.test(x);

// The carrier bytes of a transaction's extra field, or null when it holds no fragment.
// Known fields: 0x00 padding, 0x01 transaction public key, 0x02 nonce, 0x04 additional public keys.
export function carrierOf(extra) {
  extra = Buffer.from(extra);
  need(extra.length <= MAX_EXTRA, 'Extra field too long');
  let at = 0;
  const fragments = [];
  const take = n => { need(n >= 0 && at + n <= extra.length, 'Truncated extra field'); const b = extra.subarray(at, at + n); at += n; return b; };
  const varint = max => {
    let n = 0;
    for (let k = 0; k < 3; k++) {
      const b = take(1)[0];
      n += (b & 127) * 2 ** (7 * k);
      if (!(b & 128)) { need(k === 0 || b !== 0, 'Overlong length'); need(n <= max, 'Length too large'); return n; }
    }
    throw Error('Invalid length');
  };
  while (at < extra.length) {
    const tag = take(1)[0];
    if (tag === 0) { let n = 1; while (at < extra.length && extra[at] === 0) { at++; n++; } need(n <= 255, 'Padding too long'); }
    else if (tag === 1) take(32);
    else if (tag === 2) { const b = take(varint(255)); if (b.subarray(0, 3).equals(FRAGMENT)) fragments.push(b); }
    else if (tag === 4) take(32 * varint(32));
    else throw Error('Unsupported extra field');
  }
  if (!fragments.length) return null;
  need(fragments.length <= 5, 'Too many fragments');
  fragments.forEach((b, j) => {
    need(b.length > 5 && b.length <= 255 && b[3] === j && b[4] === fragments.length, 'Fragments out of order');
    if (j < fragments.length - 1) need(b.length === fragments[0].length, 'Fragments of different sizes');
  });
  return Buffer.concat(fragments.map(b => b.subarray(5)));
}

export function checkRecord(r) {
  need(plain(r), 'Record required');
  need(r.p === 'xmr20' && r.v === 2 && r.net === 'mainnet', 'Wrong protocol, version or network');
  need(address(r.owner) && hex(r.nonce, 32), 'Invalid signer or nonce');
  const common = ['p', 'v', 'net', 'op', 'owner', 'nonce'];
  if (r.op === 'nft_deploy') {
    fields(r, [...common, 'name', 'max', 'meta']);
    need(text(r.name, 80) && Number.isSafeInteger(r.max) && r.max > 0 && r.max <= 10000 && hex(r.meta, 64), 'Invalid collection');
  } else if (r.op === 'nft_mint') {
    fields(r, [...common, 'collection_id', 'edition', 'to', 'name', 'collection', 'description', 'attributes', 'image']);
    need(hex(r.collection_id, 64) && Number.isSafeInteger(r.edition) && r.edition > 0 && r.edition <= 10000 && address(r.to), 'Invalid mint');
    need(text(r.name, 160) && text(r.collection, 80) && text(r.description, 500, true), 'Invalid text');
    need(plain(r.attributes) && Object.keys(r.attributes).length <= 24, 'Invalid attributes');
    for (const [k, v] of Object.entries(r.attributes)) need(text(k, 32) && text(v, 240, true), 'Invalid attribute');
    need(typeof r.attributes.editions === 'string', 'Missing edition label');
    const i = r.image;
    need(plain(i) && Number.isInteger(i.width) && Number.isInteger(i.height) && i.width > 0 && i.height > 0 && i.width <= 128 && i.height <= 192 && i.width * i.height <= 24576, 'Picture too large');
    if (i.codec === 'json-text-1') {
      fields(i, ['codec', 'width', 'height', 'palette', 'encoding', 'data']);
      need(i.encoding === 'range-base64' && Array.isArray(i.palette) && [2, 4, 8, 16].includes(i.palette.length) && i.palette.every(c => hex(c, 6)), 'Invalid palette');
    } else if (i.codec === 'json-text-webp-1') {
      fields(i, ['codec', 'width', 'height', 'encoding', 'data']);
      need(i.encoding === 'base64', 'Invalid picture encoding');
    } else throw Error('Unknown picture codec');
    need(typeof i.data === 'string' && i.data.length > 0 && i.data.length <= 12000, 'Invalid picture data');
    need(Buffer.from(i.data, 'base64').toString('base64') === i.data, 'Picture data is not plain base64');
  } else if (r.op === 'nft_transfer') {
    fields(r, [...common, 'token', 'prev', 'to']);
    need(hex(r.token, 64) && hex(r.prev, 64) && address(r.to) && r.to !== r.owner, 'Invalid transfer');
  } else throw Error('Unknown operation');
  return r;
}

export function checkEnvelope(e) {
  fields(e, ['record', 'signature']);
  checkRecord(e.record);
  need(typeof e.signature === 'string' && /^SigV2[1-9A-HJ-NP-Za-km-z]{88}$/.test(e.signature), 'Invalid signature format');
  return e;
}

// Carrier bytes -> {record, signature}. The JSON has to be exactly what JSON.stringify would write for it: one
// spelling, no duplicate keys, key order kept. The carrier is never compressed again to check it.
export function open(carrier) {
  carrier = Buffer.from(carrier);
  need(carrier.length <= MAX_CARRIER && carrier.subarray(0, MAGIC.length).equals(MAGIC), 'Not a carrier');
  const packed = carrier.subarray(MAGIC.length);
  const out = inflateRawSync(packed, { maxOutputLength: MAX_JSON, info: true });
  need(out.engine.bytesWritten === packed.length, 'Bytes after the compressed data');
  const json = out.buffer.toString('utf8');
  need(Buffer.from(json).equals(out.buffer), 'Invalid UTF-8');
  const envelope = JSON.parse(json);
  need(JSON.stringify(envelope) === json, 'JSON is not in its one spelling');
  return checkEnvelope(envelope);
}

// The NFT record in a transaction's extra field, or null.
export function recordOf(extra) {
  try { const carrier = carrierOf(extra); return carrier ? open(carrier) : null; } catch { return null; }
}

// What the signer signs with the wallet's "sign message": the domain line and the hash of the record as written.
export const signedText = record => DOMAIN + sha256(Buffer.from(JSON.stringify(record)));
// The hash that identifies an NFT's artwork.
export const artHash = r => sha256(JSON.stringify({ name: r.name, collection: r.collection, description: r.description, attributes: r.attributes, image: r.image }));
