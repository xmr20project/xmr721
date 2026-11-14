#!/usr/bin/env node
// Rebuilds one XMR20 NFT collection from the Monero chain and writes it to collections/<name>.json(l).
//
//   node xmr20-nfts/tools/build-collection.mjs --node <monero node url> --collection <deploy txid> --name genesis
//        (--reader <reader api url> | --txids <file with one txid per line>) [--extras <file>]
//   node xmr20-nfts/tools/build-collection.mjs --scan <file made by scan-collection.mjs> --name genesis [--extras <file>]
//
// The transactions are read from the node, decoded and judged here with lib/. A reader service is only asked which
// transactions belong to the collection (its deploy, mints and transfers); its owners are then compared with the
// owners worked out here, and any difference stops the run. --extras also saves the raw extra fields, so the same
// result can be rebuilt offline (tests/nfts.test.mjs).
// With --scan nothing is asked of anyone: the transactions are those a scan of every block of a range found, and the
// files then say that the owners are those at the range's last block (`ownersAsOf`) and which blocks were read. Those
// owners are what the format gives there: only records 10 blocks deep at that block count. Every scanned transaction is
// saved (--extras), the ones that do not count yet as well, so that a reader can apply them once they do. A scan also
// finds records that name the collection and are not valid (anyone can publish one); they are saved too, change
// nothing, and are counted in what this prints.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { recordOf } from '../lib/format.mjs';
import { reduce, webpWithSharp } from '../lib/ledger.mjs';

const HERE = import.meta.dirname;
const arg = name => { const i = process.argv.indexOf('--' + name); return i < 0 ? null : process.argv[i + 1]; };
const getJson = async (url, body) => {
  const r = await fetch(url, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  if (!r.ok) throw Error(`${url}: HTTP ${r.status}`);
  return r.json();
};

// {txid, height, pos, extra} for each id, in chain order.
export async function fetchExtras(node, ids) {
  const base = node.replace(/\/$/, ''), out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const part = ids.slice(i, i + 50), v = await getJson(base + '/get_transactions', { txs_hashes: part, decode_as_json: true, prune: true });
    if (v.status !== 'OK' || (v.txs || []).length !== part.length) throw Error('The node does not know every transaction');
    for (const t of v.txs) {
      if (!part.includes(t.tx_hash) || t.in_pool) throw Error('Transaction not in a block: ' + t.tx_hash);
      out.push({ txid: t.tx_hash, height: t.block_height, extra: Buffer.from(JSON.parse(t.as_json).extra).toString('hex') });
    }
  }
  const order = new Map();
  for (const height of new Set(out.map(t => t.height))) {
    const b = (await getJson(base + '/json_rpc', { jsonrpc: '2.0', id: '0', method: 'get_block', params: { height } })).result;
    (b.tx_hashes || []).forEach((id, pos) => order.set(id, pos));
  }
  for (const t of out) { if (!order.has(t.txid)) throw Error('The node gave two answers for ' + t.txid); t.pos = order.get(t.txid); }
  return out.sort((a, b) => a.height - b.height || a.pos - b.pos);
}

export async function build(extras, collectionId, { allowRefused = false } = {}) {
  const entries = extras.map(t => ({ txid: t.txid, height: t.height, envelope: recordOf(Buffer.from(t.extra, 'hex')) }));
  const missing = entries.filter(e => !e.envelope);
  if (missing.length) throw Error('Not an NFT record: ' + missing.map(e => e.txid).join(', '));
  const state = await reduce(entries, { webp: await webpWithSharp() });
  const refused = state.events.filter(e => e.status !== 'accepted');
  if (refused.length && !allowRefused) throw Error('Refused: ' + JSON.stringify(refused));
  const c = state.collections.find(x => x.id === collectionId);
  if (!c) throw Error('The collection was not deployed by these transactions');
  const tokens = state.tokens.filter(t => t.collection === c.id).sort((a, b) => a.edition - b.edition);
  return {
    refused: refused.length,
    collection: { id: c.id, name: c.name, max: c.max, meta: c.meta, authority: c.authority, deployedAt: c.height, minted: tokens.length },
    items: tokens.map(t => {
      const r = t.mint.record;
      return { edition: t.edition, id: t.id, mintedAt: t.history[0].height, name: r.name, attributes: r.attributes,
        codec: r.image.codec, width: r.image.width, height: r.image.height, art: t.art, owner: t.owner, last: t.last, transfers: t.history.length - 1 };
    }),
  };
}

// The collection as a scan file (scan-collection.mjs) gives it: only records 10 blocks deep at the scan's last block
// count. -> build()'s result, with `notDeepYet`, the number of scanned transactions that do not count yet.
export async function buildFromScan(scan) {
  const counted = scan.transactions.filter(t => scan.to - t.height + 1 >= 10);
  return { ...(await build(counted, scan.collection, { allowRefused: true })), notDeepYet: scan.transactions.length - counted.length };
}

if (process.argv[1] === import.meta.filename) {
  const scan = arg('scan') ? JSON.parse(readFileSync(arg('scan'), 'utf8')) : null;
  const node = arg('node'), id = scan ? scan.collection : arg('collection'), name = arg('name');
  if (!name || !(scan || (node && id && (arg('reader') || arg('txids'))))) {
    console.error('Usage: build-collection.mjs --node <url> --collection <deploy txid> --name <file name> (--reader <url> | --txids <file>) [--extras <file>]\n       build-collection.mjs --scan <file> --name <file name> [--extras <file>]');
    process.exit(2);
  }
  let ids, theirs = null, checkpoint = null;
  if (scan) checkpoint = { height: scan.to, hash: scan.toHash };
  else if (arg('reader')) {
    const base = arg('reader').replace(/\/$/, ''), list = await getJson(base + '/nfts');
    if (list.complete !== true) throw Error('The reader says its list is not complete');
    checkpoint = list.checkpoint;
    theirs = list.tokens.filter(t => t.collection === id);
    ids = new Set([id]);
    for (const t of theirs) {
      ids.add(t.id);
      if (t.last !== t.id) for (const h of (await getJson(`${base}/nfts/${t.id}`)).token.history) ids.add(h.txid);
    }
    ids = [...ids];
  } else ids = [...new Set([id, ...readFileSync(arg('txids'), 'utf8').split(/\s+/).filter(Boolean)])];

  const extras = scan ? scan.transactions : await fetchExtras(node, ids), out = scan ? await buildFromScan(scan) : await build(extras, id);
  if (theirs) {
    const mine = new Map(out.items.map(t => [t.id, t]));
    for (const t of theirs) {
      const m = mine.get(t.id);
      if (!m || m.owner !== t.owner || m.last !== t.last || m.art !== t.art || m.edition !== t.edition) throw Error('The reader and this rebuild differ for ' + t.id);
    }
    if (theirs.length !== out.items.length) throw Error('The reader lists another number of NFTs');
  }
  const header = { ...out.collection, format: 'XMR20-NFT-V2', ...(checkpoint ? { ownersAsOf: checkpoint } : {}), ...(scan ? { scanned: { from: scan.from, to: scan.to } } : {}) };
  writeFileSync(join(HERE, '..', 'collections', name + '.json'), JSON.stringify(header, null, 1) + '\n');
  writeFileSync(join(HERE, '..', 'collections', name + '.jsonl'), out.items.map(t => JSON.stringify(t) + '\n').join(''));
  if (arg('extras')) writeFileSync(arg('extras'), JSON.stringify({ collection: id, transactions: extras.map(({ txid, height, pos, extra }) => ({ txid, height, pos, extra })) }) + '\n');
  console.log(JSON.stringify({ ...header, transactions: extras.length, notDeepYet: out.notDeepYet ?? 0, refused: out.refused, comparedWithReader: Boolean(theirs), fromScan: Boolean(scan) }));
}
