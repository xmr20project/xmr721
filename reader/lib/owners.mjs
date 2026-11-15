// The owner list as wallets receive it, and the one hash that pins it.
// A wallet downloads the whole list, computes this hash and compares it with the value it was built with, so a
// service cannot hand out a changed list. The hash also covers each picture's SHA-256, which is how a wallet
// checks a picture before showing it.
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
export const served=o=>({number:o.number,registrationTx:o.registrationTx,ownerTx:o.ownerTx,ownerOutputKey:o.ownerOutputKey,ownerViewTag:o.ownerViewTag,ownerTxPubKeys:o.ownerTxPubKeys,
 ...(o.bodySha256?{bodySha256:o.bodySha256,bodySize:o.bodySize}:{})});
// One line per entry, in list order: number:registrationTx:ownerTx:ownerOutputKey:ownerViewTag:txPublicKeys (comma separated):bodySha256:bodySize\n
export const ownerLine=o=>[o.number,o.registrationTx,o.ownerTx,o.ownerOutputKey,o.ownerViewTag,o.ownerTxPubKeys.join(','),o.bodySha256||'',o.bodySize||0].join(':')+'\n';
export function ownersHash(owners){const h=createHash('sha256');for(const o of owners)h.update(ownerLine(o));return h.digest('hex');}
// One file, or several separated by commas and read in that order (the original list, then added entries).
export const readOwners=files=>String(files).split(',').flatMap(file=>readFileSync(file,'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l)));
// The global output index of each owner output, in list order: number:ownerOutputIndex\n. A ledger that claims by
// burning (RULES.md section 10) finds a Mordinal by this index, which the hash above does not cover, so such a ledger
// pins it with this second hash.
export function ownerOutputsHash(owners){const h=createHash('sha256');for(const o of owners)h.update(`${o.number}:${Number.isSafeInteger(o.ownerOutputIndex)?o.ownerOutputIndex:''}\n`);return h.digest('hex');}
