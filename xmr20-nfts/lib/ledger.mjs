// Who owns which XMR20 NFT, from NFT records in chain order. See ../FORMAT.md, "Ownership".
import { checkEnvelope, signedText, artHash, MAX_JSON } from './format.mjs';
import { decodeMap, encodeMap } from './map-codec.mjs';
import { decodeAddress, verifySpendSignature } from '../../rules/lib/monero.mjs';

const standard = a => { try { return decodeAddress(a, 'mainnet').kind === 'main'; } catch { return false; } };

// A palette picture must decode and encode back to the same bytes. A WebP picture must be one still frame of
// exactly the stated size without transparency; `webp(bytes)` -> {width, height, pages, hasAlpha} decodes it
// (see webpWithSharp below). Without a decoder a WebP mint cannot be judged.
export async function pictureOk(record, { webp } = {}) {
  try {
    const i = record.image, b = Buffer.from(i.data, 'base64');
    if (i.codec === 'json-text-1') {
      if (b.length < 5) return false;
      const { idx } = decodeMap(b, 0, i.width, i.height, i.palette.length);
      return encodeMap(idx, i.width, i.height, i.palette.length).equals(b);
    }
    if (i.codec !== 'json-text-webp-1' || b.length < 12 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WEBP' || b.readUInt32LE(4) + 8 !== b.length) return false;
    if (!webp) throw Error('A WebP decoder is needed to judge this mint');
    const m = await webp(b);
    return m.width === i.width && m.height === i.height && m.pages === 1 && !m.hasAlpha;
  } catch (e) { if (/decoder is needed/.test(e.message)) throw e; return false; }
}
export async function webpWithSharp() {
  const { default: sharp } = await import('sharp');
  return async bytes => {
    const s = sharp(bytes, { limitInputPixels: 24576, failOn: 'error' }), m = await s.metadata();
    const raw = await s.removeAlpha().raw().toBuffer({ resolveWithObject: true });
    return { width: raw.info.width, height: raw.info.height, pages: m.pages || 1, hasAlpha: Boolean(m.hasAlpha) || m.width !== raw.info.width || m.height !== raw.info.height };
  };
}

// entries: [{txid, height, envelope}] in chain order (block, then position in the block), each at least
// `confirmations` blocks deep at `tip`. -> {collections, tokens, events}
export async function reduce(entries, { webp } = {}) {
  const collections = new Map(), tokens = new Map(), nonces = new Set(), events = [];
  for (const { txid, height, envelope } of entries) {
    const event = { txid, height };
    const refuse = reason => events.push({ ...event, status: 'refused', reason });
    let r;
    try { r = checkEnvelope(envelope).record; if (Buffer.byteLength(JSON.stringify(envelope)) > MAX_JSON) throw Error('JSON too large'); }
    catch (e) { refuse(e.message); continue; }
    if (![r.owner, ...(r.to ? [r.to] : [])].every(standard) || !verifySpendSignature(signedText(r), r.owner, envelope.signature, 'mainnet')) {
      refuse('Invalid address or spend-key signature'); continue;
    }
    const picture = r.op !== 'nft_mint' || await pictureOk(r, { webp });
    try {
      const nonce = r.owner + ':' + r.nonce;
      if (nonces.has(nonce)) throw Error('Nonce already used');
      if (r.op === 'nft_deploy') {
        collections.set(txid, { id: txid, authority: r.owner, name: r.name, max: r.max, meta: r.meta, height, editions: [] });
      } else if (r.op === 'nft_mint') {
        const c = collections.get(r.collection_id);
        if (!c) throw Error('Unknown collection');
        if (r.owner !== c.authority) throw Error('Only the collection authority may mint');
        if (r.collection !== c.name) throw Error('Collection name differs');
        if (r.edition > c.max || c.editions.includes(r.edition)) throw Error('Edition out of range or already minted');
        if (r.attributes.editions !== `${r.edition}/${c.max}`) throw Error('Edition label differs');
        if (!picture) throw Error('Invalid picture data');
        c.editions.push(r.edition);
        tokens.set(txid, { id: txid, collection: c.id, edition: r.edition, owner: r.to, last: txid, art: artHash(r), mint: envelope, history: [{ ...event, op: 'nft_mint', owner: r.to }] });
      } else {
        const t = tokens.get(r.token);
        if (!t) throw Error('Unknown token');
        if (r.owner !== t.owner) throw Error('Signer is not the owner');
        if (r.prev !== t.last) throw Error('Not signed for the latest state of the token');
        t.owner = r.to; t.last = txid; t.history.push({ ...event, op: 'nft_transfer', owner: r.to });
      }
      nonces.add(nonce);
      events.push({ ...event, status: 'accepted', op: r.op });
    } catch (e) { refuse(e.message); }
  }
  return { collections: [...collections.values()], tokens: [...tokens.values()], events };
}
