#!/usr/bin/env node
// Decodes the XMR20 NFT record in one Monero transaction and, for a mint, writes its picture as a PNG.
//
//   node xmr20-nfts/tools/decode.mjs --node <monero node url> --tx <txid> [--png <file>]
import { writeFileSync } from 'node:fs';
import { recordOf, signedText, artHash } from '../lib/format.mjs';
import { decodeMap } from '../lib/map-codec.mjs';
import { verifySpendSignature } from '../../rules/lib/monero.mjs';

// The picture of a mint record as raw RGB bytes.
export async function pixels(image) {
  const bytes = Buffer.from(image.data, 'base64');
  if (image.codec === 'json-text-1') {
    const { idx } = decodeMap(bytes, 0, image.width, image.height, image.palette.length), rgb = Buffer.alloc(idx.length * 3);
    idx.forEach((v, i) => rgb.write(image.palette[v], i * 3, 'hex'));
    return rgb;
  }
  const { default: sharp } = await import('sharp');
  return sharp(bytes).removeAlpha().raw().toBuffer();
}

if (process.argv[1] === import.meta.filename) {
  const arg = name => { const i = process.argv.indexOf('--' + name); return i < 0 ? null : process.argv[i + 1]; };
  if (!arg('node') || !arg('tx')) { console.error('Usage: decode.mjs --node <monero node url> --tx <txid> [--png <file>]'); process.exit(2); }
  const r = await fetch(arg('node').replace(/\/$/, '') + '/get_transactions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ txs_hashes: [arg('tx')], decode_as_json: true, prune: true }) });
  const t = (await r.json()).txs?.[0];
  if (!t) throw Error('The node does not know this transaction');
  const envelope = recordOf(Buffer.from(JSON.parse(t.as_json).extra));
  if (!envelope) throw Error('This transaction holds no XMR20 NFT record');
  const record = envelope.record, image = record.image;
  console.log(JSON.stringify({ txid: t.tx_hash, block: t.in_pool ? null : t.block_height, signatureValid: verifySpendSignature(signedText(record), record.owner, envelope.signature),
    ...(image ? { art: artHash(record) } : {}), record: image ? { ...record, image: { ...image, data: `(${image.data.length} characters)` } } : record }, null, 1));
  if (image && arg('png')) {
    const { default: sharp } = await import('sharp');
    writeFileSync(arg('png'), await sharp(await pixels(image), { raw: { width: image.width, height: image.height, channels: 3 } }).png().toBuffer());
  }
}
