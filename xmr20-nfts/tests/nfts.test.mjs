// Offline tests: the saved extra fields of the Genesis transactions rebuild the collection files, and made-up
// records with throwaway keys exercise the ownership rules. Nothing here talks to a network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { carrierOf, open, recordOf, signedText, MAX_CARRIER } from '../lib/format.mjs';
import { reduce, pictureOk, webpWithSharp } from '../lib/ledger.mjs';
import { encodeMap } from '../lib/map-codec.mjs';
import { build } from '../tools/build-collection.mjs';
import { loadCollection, picturePixels } from '../lib/collection.mjs';
import { textArt } from '../lib/text-art.mjs';
import { pixels } from '../tools/decode.mjs';
import { wallet } from '../../rules/tests/helpers.mjs';
import { verifySpendSignature } from '../../rules/lib/monero.mjs';

const read = name => readFileSync(new URL(name, import.meta.url), 'utf8');
const saved = JSON.parse(read('../collections/genesis-transactions.json'));

// Record -> extra field bytes, the way a wallet carries it: public key, then fragments of 250 carrier bytes.
function extraOf(envelope, { size = 250 } = {}) {
  const carrier = Buffer.concat([Buffer.from('XMR20T2'), deflateRawSync(Buffer.from(JSON.stringify(envelope)), { level: 9 })]);
  assert.ok(carrier.length <= MAX_CARRIER);
  const parts = [];
  for (let at = 0; at < carrier.length; at += size) parts.push(carrier.subarray(at, at + size));
  return Buffer.concat([Buffer.from([1]), randomBytes(32), ...parts.map((p, j) => Buffer.concat([Buffer.from([2, ...varint(p.length + 5)]), Buffer.from('XM2'), Buffer.from([j, parts.length]), p]))]);
}
const varint = n => n < 128 ? [n] : [n & 127 | 128, n >> 7];
const signed = (record, by) => ({ record, signature: by.sign(signedText(record)) });
const nonce = () => randomBytes(16).toString('hex');
const base = (op, by) => ({ p: 'xmr20', v: 2, net: 'mainnet', op, owner: by.address, nonce: nonce() });
function picture(width = 8, height = 8) {
  const idx = Uint8Array.from({ length: width * height }, (_, i) => (i * 7 + (i >> 3)) % 4);
  return { codec: 'json-text-1', width, height, palette: ['000000', 'ff6600', 'ffffff', '333333'], encoding: 'range-base64', data: encodeMap(idx, width, height, 4).toString('base64') };
}
const mint = (by, collection, edition, to, max = 3) => signed({ ...base('nft_mint', by), collection_id: collection, edition, to: to.address, name: 'Test ' + edition, collection: 'TEST', description: '', attributes: { editions: `${edition}/${max}` }, image: picture() }, by);

test('the saved Genesis transactions rebuild the collection files', async () => {
  const out = await build(saved.transactions, saved.collection), header = JSON.parse(read('../collections/genesis.json'));
  const items = read('../collections/genesis.jsonl').split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.deepEqual(out.items, items);
  for (const k of Object.keys(out.collection)) assert.deepEqual(out.collection[k], header[k], k);
  assert.equal(items.length, 100);
  assert.deepEqual(items.map(t => t.edition), Array.from({ length: 100 }, (_, i) => i + 1));
  assert.deepEqual([items.filter(t => t.codec === 'json-text-1').length, items.filter(t => t.codec === 'json-text-webp-1').length], [90, 10]);
  assert.ok(items.every(t => t.owner === header.authority || t.transfers > 0));
});

test('every saved picture decodes to its stated size', async () => {
  for (const t of saved.transactions.slice(1)) {
    const { record } = recordOf(Buffer.from(t.extra, 'hex'));
    assert.equal((await pixels(record.image)).length, record.image.width * record.image.height * 3, t.txid);
  }
});

test('an NFT is drawn as its own text over its picture', async () => {
  const dir = new URL('../collections', import.meta.url).pathname, c = loadCollection(dir, 'genesis');
  const size = png => [png.readUInt32BE(16), png.readUInt32BE(20)];
  const venus = await c.picture(7), mona = await c.picture(1);
  assert.equal(venus.type, 'image/png');
  assert.deepEqual(size(venus.bytes), [768, 480], 'a palette picture: 96 characters of 8 pixels, rows of 12');
  assert.deepEqual(size(mona.bytes), [1024, 1524], 'a WebP picture: 128 characters wide');
  assert.deepEqual(size((await c.picture(7, { plain: true })).bytes), [42, 26], 'the bare picture');
  // The text starts with the record's name; a record with other text gives another drawing of the same size.
  const { record } = recordOf(Buffer.from(saved.transactions.find(t => t.txid === c.items[6].id).extra, 'hex'));
  const raw = await picturePixels(record.image), a = textArt(record, raw), b = textArt({ ...record, name: 'Another name' }, raw);
  assert.deepEqual([a.width, a.height, b.width, b.height], [768, 480, 768, 480]); assert.ok(!a.rgb.equals(b.rgb));
  assert.deepEqual([...a.rgb.subarray(0, 3)], [20, 25, 31], 'the ground colour where the first glyph has no pixel');
  assert.equal(c.picture(101), null);
});

test('a record has one spelling and anything else is not a record', () => {
  const extra = Buffer.from(saved.transactions[1].extra, 'hex'), carrier = carrierOf(extra), envelope = open(carrier);
  assert.deepEqual(recordOf(extraOf(envelope)), envelope, 'carried again, it reads the same');
  const flipped = Buffer.from(extra); flipped[flipped.length - 40] ^= 1;
  const changed = recordOf(flipped);
  assert.ok(!changed || !verifySpendSignature(signedText(changed.record), changed.record.owner, changed.signature), 'a changed byte: no record, or one its signature does not fit');
  assert.ok(verifySpendSignature(signedText(envelope.record), envelope.record.owner, envelope.signature));
  assert.equal(recordOf(Buffer.concat([extra, Buffer.from([0x7f, 1, 0])])), null, 'an unknown field after it');
  assert.equal(recordOf(Buffer.from([1, ...randomBytes(32)])), null, 'no fragment');
  const spaced = Buffer.concat([Buffer.from('XMR20T2'), deflateRawSync(Buffer.from(JSON.stringify(envelope, null, 1)))]);
  assert.throws(() => open(spaced), /one spelling|Not a carrier/);
  assert.throws(() => open(Buffer.concat([carrier, Buffer.from([0])])), /after the compressed data/);
});

test('ownership: only the authority mints, only the owner moves, a nonce and a state are used once', async () => {
  const [a, b, c] = ['nft a', 'nft b', 'nft c'].map(n => wallet(n));
  const deploy = signed({ ...base('nft_deploy', a), name: 'TEST', max: 3, meta: '00'.repeat(32) }, a);
  const m1 = mint(a, 'c0'.repeat(32), 1, b), stranger = mint(b, 'c0'.repeat(32), 2, b), again = mint(a, 'c0'.repeat(32), 1, c), four = mint(a, 'c0'.repeat(32), 4, c);
  const move = (by, token, prev, to, n = nonce()) => signed({ ...base('nft_transfer', by), nonce: n, token, prev, to: to.address }, by);
  const t1 = move(b, 'a1'.repeat(32), 'a1'.repeat(32), c), stale = move(b, 'a1'.repeat(32), 'a1'.repeat(32), a), thief = move(a, 'a1'.repeat(32), 'b1'.repeat(32), b);
  const forged = { record: move(c, 'a1'.repeat(32), 'b1'.repeat(32), a).record, signature: a.sign('something else') };
  const sub = a.sub(1), toSub = signed({ ...base('nft_transfer', c), token: 'a1'.repeat(32), prev: 'b1'.repeat(32), to: sub.address }, c);
  const ok = move(c, 'a1'.repeat(32), 'b1'.repeat(32), a);
  const entries = [['c0', deploy], ['a1', m1], ['a2', stranger], ['a3', again], ['a4', four], ['b1', t1], ['b2', stale], ['b3', thief], ['b5', forged], ['b6', ok]]
    .map(([id, envelope], i) => ({ txid: id.repeat(32), height: 10 + i, envelope }));
  const s = await reduce(entries);
  assert.deepEqual(s.events.map(e => e.status === 'accepted' ? 'ok' : e.reason), ['ok', 'ok', 'Only the collection authority may mint', 'Edition out of range or already minted',
    'Edition out of range or already minted', 'ok', 'Signer is not the owner', 'Signer is not the owner', 'Invalid address or spend-key signature', 'ok']);
  assert.equal(s.tokens.length, 1); assert.equal(s.tokens[0].owner, a.address); assert.equal(s.tokens[0].last, 'b6'.repeat(32)); assert.equal(s.tokens[0].history.length, 3);
  // The same signer and nonce again, in any operation, is refused; so are a damaged signature, a view-key
  // signature and a subaddress.
  const more = await reduce([...entries, { txid: 'd1'.repeat(32), height: 30, envelope: signed({ ...base('nft_deploy', a), nonce: deploy.record.nonce, name: 'AGAIN', max: 1, meta: '00'.repeat(32) }, a) },
    { txid: 'd2'.repeat(32), height: 31, envelope: { record: move(a, 'a1'.repeat(32), 'b6'.repeat(32), b).record, signature: 'x' } }]);
  assert.equal(more.events.at(-2).reason, 'Nonce already used'); assert.match(more.events.at(-1).reason, /signature/i);
  const view = move(a, 'a1'.repeat(32), 'b6'.repeat(32), b); view.signature = a.signView(signedText(view.record));
  const tail = await reduce([...entries, { txid: 'd3'.repeat(32), height: 32, envelope: view }, { txid: 'd4'.repeat(32), height: 33, envelope: toSub }]);
  assert.equal(tail.events.at(-2).reason, 'Invalid address or spend-key signature');
  assert.notEqual(tail.events.at(-1).status, 'accepted');
});

test('a picture has to survive decoding and encoding again', async () => {
  const good = { image: picture() }, webp = await webpWithSharp();
  assert.equal(await pictureOk(good), true);
  const bytes = Buffer.from(good.image.data, 'base64');
  assert.equal(await pictureOk({ image: { ...good.image, data: Buffer.concat([bytes, Buffer.from([1])]).toString('base64') } }), false, 'bytes after the picture');
  assert.equal(await pictureOk({ image: { ...good.image, width: 9 } }), false, 'another size');
  const real = recordOf(Buffer.from(saved.transactions.find(t => recordOf(Buffer.from(t.extra, 'hex')).record.image?.codec === 'json-text-webp-1').extra, 'hex')).record;
  assert.equal(await pictureOk(real, { webp }), true);
  assert.equal(await pictureOk({ image: { ...real.image, width: real.image.width + 1 } }, { webp }), false);
  await assert.rejects(pictureOk(real), /decoder is needed/);
});
