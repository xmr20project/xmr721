// The earlier XMR20 formats, read on.
//
// Two formats were inscribed on Monero before XMR721 carried tokens and NFTs: the deploy inscriptions of XMR20 tokens
// (xmr20-tokens/EARLIER.md) and XMR20 NFT records (xmr20-nfts/FORMAT.md). Both sit in "XM2" fragments of a
// transaction's extra field. For the blocks up to a reader's start block the repository ships what a scan of the chain
// found: the list of deploys (xmr20-tokens/earlier) and the GENESIS collection (xmr20-nfts/collections). From there on
// a follower (follow.mjs) keeps the transactions that continue them. This file is the follower's pick function and
// the two views made of the shipped files and what the follower found: the tokens, and who owns the NFTs of a saved
// collection.
//
// Shipped files are continued only when they end at the reader's start block, the same block by its hash: then files
// and follower together are every block from the files' first to the follower's last. Otherwise only the files are
// served, as they are.
import {createHash} from 'node:crypto';
import {carrierOf,open as openNft,recordOf} from '../../xmr20-nfts/lib/format.mjs';
import {reduce,signedBy} from '../../xmr20-nfts/lib/ledger.mjs';
import {MAGIC as DEPLOY,openCarrier,tokenOf} from '../../xmr20-tokens/lib/earlier.mjs';

export const NAME='xmr20-earlier',FINAL=10;
// Counted up when what `picker` keeps changes, so that a follower folder made by other rules is not continued.
const RULES=1,NFT='XMR20T2';

// The follower's pick function, and a name for what it picks. Kept are:
//   - a well-formed deploy signed by one of `deployers` (its signature checked here, once);
//   - a transfer of one of `nfts` (mint transaction ids) with standard addresses and its signer's valid signature.
//     Whether the signer owns the NFT is the view's question, so a transfer signed by someone who does not own it is
//     kept too; it moves nothing.
// Everything else is left alone, cheaply: a stranger's deploy and a record of another NFT cost no signature check. A
// carrier that does not open throws, which keeps nothing.
export function picker({deployers=[],nfts=[]}={}){
 const who=new Set(deployers),ids=new Set(nfts),name=NAME+'-'+createHash('sha256').update(JSON.stringify({rules:RULES,deployers:[...who].sort(),nfts:[...ids].sort()})).digest('hex').slice(0,16);
 const pick=extra=>{
  const bytes=Buffer.from(extra),carrier=carrierOf(bytes);if(!carrier)return null;
  const magic=carrier.subarray(0,7).toString('latin1');
  if(magic===DEPLOY&&who.size){if(!who.has(openCarrier(carrier,'mainnet',{verify:false}).record.owner))return null;openCarrier(carrier);return {kind:'deploy',extra:bytes.toString('hex')};}
  if(magic===NFT&&ids.size){const e=openNft(carrier);return e.record.op==='nft_transfer'&&ids.has(e.record.token)&&signedBy(e)?{kind:'nft',extra:bytes.toString('hex')}:null;}
  return null;};
 return {pick,name};}

// Does something that ends at block `height` with hash `hash` end where this reader starts?
const atStart=(height,hash,reader)=>height===reader.meta.start&&Boolean(reader.meta.startHash)&&hash===reader.meta.startHash;

// The earlier tokens. base: loadEarlier() of xmr20-tokens/lib/earlier.mjs. Deploys the follower found count when one of
// the list's deployers signed them; the token of a Solana mint is its earliest deploy, and numbers go on from the list.
// A deploy counts from the block it is in: one in a block that is later replaced goes away with that block.
export function earlierTokens({base,follower=null,reader}){
 const deployers=new Set(base.header.deployers),opened=new Map();let made=null;
 const on=()=>Boolean(follower)&&atStart(base.header.to,base.header.toHash,reader);
 // What the follower's folder holds is checked again here, once: a line is a deploy only if it reads as one and its
 // signature is its owner's.
 const open=e=>{if(!opened.has(e.txid)){let d=null;try{d=openCarrier(carrierOf(Buffer.from(e.extra,'hex')));}catch{d=null;}opened.set(e.txid,d);}return opened.get(e.txid);};
 function make(live){
  const deploys=base.deploys.slice(),tokens=base.tokens.slice(),mints=new Set(base.deploys.map(d=>d.record.mint));
  if(live)for(const e of follower.entries){if(e.kind!=='deploy')continue;const d=open(e);if(!d||!deployers.has(d.record.owner))continue;
   const entry={txid:e.txid,height:e.height,time:e.time??null,record:d.record,signature:d.signature};deploys.push(entry);
   if(!mints.has(d.record.mint)){mints.add(d.record.mint);tokens.push(tokenOf(entry,tokens.length+1));}}
  return {deploys,tokens,by:new Map(tokens.flatMap(x=>[[x.txid,x],[x.mint,x],[String(x.number),x]])),entry:new Map(deploys.map(d=>[d.txid,d]))};}
 return {on,deployers:base.header.deployers,
  // How far the view reaches: the follower's last block when it continues the list, the list's last block otherwise.
  // `complete` says it holds every block the reader has read.
  get reach(){return on()?{from:base.header.from,to:follower.height,following:true,complete:follower.complete}:{from:base.header.from,to:base.header.to,following:false,complete:false};},
  // {deploys, tokens, by, entry}: made again only when what the follower holds has changed.
  get view(){const live=on(),key=live?follower.version:-1;if(!made||made.key!==key)made={key,...make(live)};return made;}};}

// Who owns the NFTs of one saved collection (xmr20-nfts/lib/collection.mjs). The collection's saved records and the
// transfers the follower found are applied in chain order by the format's own rules (xmr20-nfts/lib/ledger.mjs): the
// result is that ledger at the follower's last block, where a record counts once it is 10 blocks deep. The files are
// continued only when they hold every record up to the reader's start block (`ownersAsOf`), every edition is minted,
// so that the collection's NFTs are the ones in the files, and their last record is 10 blocks deep at that block, so
// that the owners they name are the ledger's there. The pictures were judged when the files were made (a saved WebP
// mint that is among the NFTs had a valid picture, one that is not had none that counted); nothing here needs a
// picture decoder.
// Only this collection's records are read: a nonce its signer used in a record of another collection is not seen.
export function collectionOwners({collection,follower=null,reader}){
 const h=collection.header,ids=new Set(collection.items.map(t=>t.id)),cache=new Map(),checked=new Map(),dead=new Set();
 // Saved transactions that do not read as records leave nothing to continue.
 let base=[];try{base=(collection.transactions||[]).map(t=>({txid:t.txid,height:t.height,envelope:recordOf(Buffer.from(t.extra,'hex'))}));if(base.some(e=>!e.envelope||!Number.isSafeInteger(e.height)))base=[];}catch{base=[];}
 const known=new Map(base.filter(e=>e.envelope.record.op==='nft_mint'&&e.envelope.record.image.codec==='json-text-webp-1').map(e=>[e.txid,ids.has(e.txid)]));
 const on=()=>Boolean(follower)&&base.length>0&&h.minted===h.max&&atStart(h.ownersAsOf?.height,h.ownersAsOf?.hash,reader)&&base.every(e=>h.ownersAsOf.height-e.height+1>=FINAL);
 // A kept line counts as a transfer of this collection only if it reads as one and its signature is its signer's:
 // the follower's folder is checked again here, once for each line, a few at a time.
 const check=e=>{let v=null;try{v=recordOf(Buffer.from(e.extra,'hex'));}catch{v=null;}return v&&v.record.op==='nft_transfer'&&ids.has(v.record.token)&&signedBy(v)?v:null;};
 let state=null,key=null,epoch=null;
 async function refresh(){
  if(!on()){state=null;key=null;return null;}
  // What the follower holds at this moment; a change during the work below shows as another version at the next refresh.
  const at={height:follower.height,hash:follower.hash,version:follower.version},kept=follower.entries.filter(e=>e.kind==='nft');
  // Kept lines only ever come behind the ones seen before, unless the follower dropped some: then all are judged anew.
  if(follower.epoch!==epoch){dead.clear();key=null;epoch=follower.epoch;}
  let n=0;for(const e of kept){if(checked.has(e.txid))continue;checked.set(e.txid,check(e));if(++n%20===0)await new Promise(done=>setImmediate(done));}
  const live=kept.map(e=>({txid:e.txid,height:e.height,envelope:checked.get(e.txid)})).filter(e=>e.envelope&&!dead.has(e.txid));
  const deep=e=>at.height-e.height+1>=FINAL,final=live.filter(deep),k=at.version+':'+final.length;
  if(k!==key||!state){const r=await reduce([...base,...final],{known,verified:new Set(final.map(e=>e.txid)),cache});
   // A transfer that was refused once it counted moves nothing and uses no nonce: it need not be looked at again.
   const mine=new Set(final.map(e=>e.txid));for(const e of r.events)if(e.status!=='accepted'&&mine.has(e.txid))dead.add(e.txid);
   state={tokens:new Map(r.tokens.map(t=>[t.id,t])),events:r.events};key=k;}
  state.pending=live.filter(e=>!deep(e)).length;state.at=at;return state;}
 return {on,ids,refresh,
  // Null while the files are not continued (then they are served as they are) and until the first refresh.
  get state(){return state;},
  // What the state may say of itself now: the block it was made at, how many kept transfers are not deep enough yet,
  // and whether it is the ledger at the newest block the reader holds.
  get status(){return state?{asOf:{height:state.at.height,hash:state.at.hash},pending:state.pending,
   complete:follower.complete&&follower.height===state.at.height&&follower.hash===state.at.hash&&follower.version===state.at.version}:null;}};}
