#!/usr/bin/env node
// Every transaction of one XMR20 NFT collection in a range of blocks, found by reading the blocks themselves.
//
//   node xmr20-nfts/tools/scan-collection.mjs --node <monero node url> --collection <deploy txid>
//        --from <height> --to <height> --out <file>
//
// Reads every block of the range from the node, in order, and writes the transactions that hold a record of the
// collection: its deploy, every mint that names it, and every transfer of an NFT that such a mint, earlier in the
// chain, made (a transfer before its mint moves nothing). Whether each record is valid is judged later, by
// build-collection.mjs --scan <file>, which makes the collection files from this one; their owners are then those at
// the range's last block. The blocks have to follow one another by their hashes, so the file names one chain: the
// one that ends in the hash it gives for the last block.
// Any node answers these questions; use your own to trust nobody for what is in the blocks.
import { writeFileSync } from 'node:fs';
import { createChain } from '../../reader/lib/chain.mjs';
import { blockExtras } from '../../reader/lib/follow.mjs';
import { recordOf } from '../lib/format.mjs';

const arg = name => { const i = process.argv.indexOf('--' + name); return i < 0 ? null : process.argv[i + 1]; };

// The collection's record transactions in blocks `from` to `to`. `read(height)` gives a block as blockExtras does.
export async function scanCollection(read, collection, from, to, { each = () => {} } = {}) {
  const tokens = new Set(), transactions = [];
  let toHash = null, last = null;
  for (let h = from; h <= to;) {
    // A few blocks at a time, taken in order.
    const heights = [];
    for (let k = h; k <= to && k < h + 6; k++) heights.push(k);
    for (const b of await Promise.all(heights.map(read))) {
      if (last !== null && b.prev !== last) throw Error(`Block ${b.height} does not follow the block before it: the node changed chains during the scan. Run it again.`);
      last = b.hash;
      for (const t of b.txs) {
        let r = null;
        try { r = recordOf(Buffer.from(t.extra))?.record ?? null; } catch { r = null; }
        if (!r) continue;
        const ours = (r.op === 'nft_deploy' && t.txid === collection) || (r.op === 'nft_mint' && r.collection_id === collection) || (r.op === 'nft_transfer' && tokens.has(r.token));
        if (!ours) continue;
        if (r.op === 'nft_mint') tokens.add(t.txid);
        transactions.push({ txid: t.txid, height: b.height, pos: t.pos, extra: Buffer.from(t.extra).toString('hex') });
      }
      toHash = b.hash;
    }
    h = heights.at(-1) + 1;
    each(h - 1, transactions.length);
  }
  return { collection, from, to, toHash, transactions };
}

if (process.argv[1] === import.meta.filename) {
  const node = arg('node'), collection = arg('collection'), from = Number(arg('from')), to = Number(arg('to')), out = arg('out');
  if (!node || !out || !/^[0-9a-f]{64}$/.test(collection || '') || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from) {
    console.error('Usage: scan-collection.mjs --node <url> --collection <deploy txid> --from <height> --to <height> --out <file>');
    process.exit(2);
  }
  const chain = createChain(node, { timeout: 60000 }), tip = (await chain.info()).height;
  if (to > tip) { console.error(`The node is at block ${tip}; the range ends at ${to}.`); process.exit(2); }
  const found = await scanCollection(h => blockExtras(chain, h), collection, from, to, { each: (h, n) => { if ((h - from) % 3000 < 6) console.log(new Date().toISOString(), `block ${h} of ${to}, ${n} transactions`); } });
  writeFileSync(out, JSON.stringify(found) + '\n');
  console.log(`done: ${found.transactions.length} transactions of the collection in blocks ${from} to ${to}`);
}
