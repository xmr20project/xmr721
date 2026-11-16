// The Mordinals reader: follows the Monero chain from the start block, finds MD1 records, judges each one with the
// rule library (rules/lib) and keeps a journal of what it saw. Anyone can run it; two readers on the same chain
// keep the same journal and reach the same owners.
//
// State folder:
//   meta.json          what this journal is for (network, domain, fee address, start block, owner list hash)
//   blocks.jsonl       {height, hash, time} of every block read after the start block
//   records.jsonl      every MD1 record seen, in chain order: {height, pos, txid, record, ok, id, op, error?, facts?}
//                      and, on a ledger that claims by burning, every transfer in the original Mordinals format from
//                      its first burn block on: {height, pos, txid, burn, id, ok, error?} (burn: rules/lib/burn.mjs),
//                      and every transaction from that block on that pays a fee address: its record or burn entry
//                      gets `fee` and `feeFound`, or it has an entry of its own, {height, pos, txid, ok: true, fee,
//                      feeFound} (fee: what feeParts() in rules/lib/burn-fee.mjs reads; feeFound: the outputs that pay
//                      a fee address, as the ledger's scanBurnFees found them, so a rebuild from this journal derives
//                      no key again; a transaction's payments count after what it carries)
//   checkpoints.jsonl  a summary every `checkpointEvery` blocks (see checkpoint())
// Records of a block are written before the block line, so a stop in between leaves nothing half read: record lines
// above the last block line are dropped at the next start. When the chain reorganises, the journal is cut back to
// the last block both agree on and the ledger is rebuilt from the owner list and the journal.
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync,renameSync,openSync,writeSync,fsyncSync,closeSync} from 'node:fs';
import {join} from 'node:path';
import {createLedger} from '../../rules/lib/ledger.mjs';
import {OP,PROOF,RULES,decodeRecord,recordId,canonical} from '../../rules/lib/records.mjs';
import {hex,unhex} from '../../rules/lib/monero.mjs';
import {deadOutputs,isMainnetDead,readTransfer,burnParts,burnClaimId} from '../../rules/lib/burn.mjs';
import {feeWallet,isProjectFeeWallet,feeParts} from '../../rules/lib/burn-fee.mjs';
import {unframe} from './transport.mjs';
import {ownersHash,ownerOutputsHash} from './owners.mjs';

// A state folder made for a ledger with a minter list has a schema name of its own, so code from before the list existed
// refuses the folder instead of reading it without the list.
// A folder for a listed ledger that opens minting at a block has one more, so code from before the opening refuses it
// instead of judging the blocks after it by the list alone.
// A folder of a ledger that claims by burning adds "-burn-fee" to its name, for the same reason (code from before the
// fee of burn claims, which named such a folder "-burn", refuses it too).
export const SCHEMA='mordinals-reader-v3',SCHEMA_MINTERS='mordinals-reader-v3-minters',SCHEMA_OPEN='mordinals-reader-v3-open',SCHEMA_BURN='-burn-fee';
// A folder takes a first burn block in, or another one, only when that block is at least this far above the newest
// block it has read and above the newest block of the Monero node: a block that close may be read, or replaced, before
// every reader of the ledger has the setting, and a folder that lags behind the chain must not take a block that is
// already in the past. The folder is checked when it is opened, the node at the first pass; only then is the setting
// written into the folder.
export const BURN_MARGIN=10;
const BURN_KEYS=['burnFrom','burnDead','ownerOutputs','burnFee'];
const sha=text=>createHash('sha256').update(text).digest('hex');
// Only the parts of a payment transaction the rules read. A transaction of another kind is kept as it is not: the
// rule library then refuses it by its own check.
export const slim=tx=>({version:tx?.version,unlock_time:tx?.unlock_time,vout:Array.isArray(tx?.vout)?tx.vout:[],extra:tx?.extra,
 rct_signatures:tx?.rct_signatures?{type:tx.rct_signatures.type,ecdhInfo:tx.rct_signatures.ecdhInfo,outPk:tx.rct_signatures.outPk}:undefined});
const lines=file=>{if(!existsSync(file))return {rows:[],torn:false};const out=[];let torn=false;
 for(const l of readFileSync(file,'utf8').split('\n')){if(!l)continue;try{out.push(JSON.parse(l));}catch{torn=true;break;}}return {rows:out,torn};};
const replace=(file,rows)=>{const tmp=file+'.tmp',fd=openSync(tmp,'w',0o644);try{writeSync(fd,rows.map(r=>JSON.stringify(r)+'\n').join(''));fsyncSync(fd);}finally{closeSync(fd);}renameSync(tmp,file);};
const append=(file,rows)=>{if(!rows.length)return;const fd=openSync(file,'a',0o644);try{writeSync(fd,rows.map(r=>JSON.stringify(r)+'\n').join(''));fsyncSync(fd);}finally{closeSync(fd);}};

export function openReader({dir,chain,network='mainnet',domain,feeAddress,owners,start,startHash=null,mintFrom=null,minters=null,openFrom=null,burnFrom=null,burnDead=null,burnFee=null,checkpointEvery=720,maxReorg=10000,log=()=>{}}){
 if(!Number.isInteger(start)||start<1)throw Error('Start block required');
 mkdirSync(dir,{recursive:true});
 const files={meta:join(dir,'meta.json'),blocks:join(dir,'blocks.jsonl'),records:join(dir,'records.jsonl'),checkpoints:join(dir,'checkpoints.jsonl')};
 // The minter list is kept as one text (its addresses in order), so two setups compare as texts.
 if(minters!==null&&!(Array.isArray(minters)&&minters.length))throw Error('Bad minter list');
 const minterList=minters===null?null:[...new Set(minters.map(a=>canonical(a,network)))].sort();
 if(openFrom!==null&&!(Number.isInteger(openFrom)&&minterList&&mintFrom!==null&&openFrom>mintFrom))throw Error('Bad opening block: it needs a minter list and comes after the first mint block');
 // meta.json is replaced whole: written beside it, flushed, then put in its place.
 const writeMeta=m=>{const tmp=files.meta+'.tmp',fd=openSync(tmp,'w',0o644);try{writeSync(fd,JSON.stringify(m,null,1)+'\n');fsyncSync(fd);}finally{closeSync(fd);}renameSync(tmp,files.meta);};
 // Claiming by burning: the first burn block, the dead outputs (one text, like the minter list) and the hash of the
 // owner outputs' indexes are part of what the folder is for.
 if(burnFrom!==null&&!(Number.isInteger(burnFrom)&&burnFrom>start))throw Error('Bad first burn block: it comes after the start block');
 if(burnFrom===null&&burnDead!==null)throw Error('Dead outputs are named only with a first burn block');
 if(burnFrom===null&&burnFee!==null)throw Error('A fee wallet is named only with a first burn block');
 // On mainnet the dead outputs and the fee wallet are mainnet's. Other ones are for the offline test chain, whose
 // addresses read as mainnet's: a folder that names its own reads no block from a node that is not that chain (pass()).
 const deadList=burnFrom===null?null:deadOutputs(burnDead,network,{testChain:burnDead!==null}),feeW=burnFrom===null?null:feeWallet(burnFee,network,{testChain:burnFee!==null});
 const testChain=burnFrom!==null&&network==='mainnet'&&(!isMainnetDead(deadList)||!isProjectFeeWallet(feeW));
 if(burnFrom!==null)for(const o of owners)if(!Number.isSafeInteger(o.ownerOutputIndex)||o.ownerOutputIndex<0)throw Error(`Owner list entry ${o.number} does not state the global index of its owner output, which a ledger that claims by burning needs`);
 const burning=burnFrom===null?null:{burnFrom,burnDead:deadList.join(','),ownerOutputs:ownerOutputsHash(owners),burnFee:feeW.address},tail=burning?SCHEMA_BURN:'';
 const want={schema:(openFrom!==null?SCHEMA_OPEN:minterList?SCHEMA_MINTERS:SCHEMA)+tail,network,domain,feeAddress:canonical(feeAddress,network),start,owners:ownersHash(owners),...(mintFrom!==null?{mintFrom}:{}),...(minterList?{minters:minterList.join(',')}:{}),...(openFrom!==null?{openFrom}:{}),...(burning||{})};
 let meta=existsSync(files.meta)?JSON.parse(readFileSync(files.meta,'utf8')):null,opened=null,lit=null;
 // A folder of the same listed ledger that has not read the opening block yet takes the opening in: up to that block
 // the two setups judge every record alike.
 if(meta&&openFrom!==null&&meta.openFrom==null&&meta.schema===SCHEMA_MINTERS+tail&&[...Object.keys(want)].every(k=>k==='schema'||k==='openFrom'||(meta[k]??null)===(want[k]??null))){
  const read=lines(files.blocks).rows.at(-1)?.height??start;
  if(read<openFrom){meta={...meta,schema:SCHEMA_OPEN+tail,openFrom};opened=read;}}
 // The burn setting of a folder can be taken in, changed or taken out while the folder has read neither the block it
 // had nor the block it gets: up to there nothing was judged by it. A new first burn block has to lie BURN_MARGIN
 // blocks above what was read.
 if(meta&&BURN_KEYS.some(k=>(meta[k]??null)!==(want[k]??null))&&meta.schema.replace(SCHEMA_BURN,'')===want.schema.replace(SCHEMA_BURN,'')
  &&[...new Set([...Object.keys(want),...Object.keys(meta)])].every(k=>k==='schema'||k==='startHash'||BURN_KEYS.includes(k)||(meta[k]??null)===(want[k]??null))){
  const read=lines(files.blocks).rows.at(-1)?.height??start,had=meta.burnFrom??null;
  if((had===null||read<had)&&(burnFrom===null||read<burnFrom)){
   if(burnFrom!==null&&burnFrom<read+BURN_MARGIN)throw Error(`The first burn block has to be at least ${BURN_MARGIN} blocks above the newest block this folder has read (${read}).`);
   const {burnFrom:x,burnDead:y,ownerOutputs:z,burnFee:f,...rest}=meta;meta={...rest,schema:want.schema,...(burning||{})};lit=read;}}
 if(meta){for(const k of [...Object.keys(want),'mintFrom','minters','openFrom','burnFrom','burnDead','ownerOutputs','burnFee'])if((meta[k]??null)!==(want[k]??null))throw Error(`This state folder was made for another ledger (${k} differs).`);
  if(startHash&&meta.startHash&&meta.startHash!==startHash)throw Error('This state folder was made for another start block hash.');}
 else{meta={...want,startHash:startHash||null};writeMeta(meta);}

 let ledger,blocks,journal,checkpoints,events,lots,bodies,byId,byTx,feeNotes;
 function tipBlock(){return blocks.at(-1)||{height:start,hash:meta.startHash};}
 const timeOf=height=>blocks[height-start-1]?.time??null;
 // What an accepted record did, in public words. This is what the explorer and the history views show.
 function describe(e,d,out){
  const b=d.body,base={height:e.height,pos:e.pos,txid:e.txid,id:e.id,time:timeOf(e.height)??e.time??null};
  // A minted NFT has no Mordinal number; its events carry its id as `nft`.
  if(d.op===OP.collection)return {...base,kind:'collection',number:null,collection:e.id,creator:b.creator,name:b.name,max:b.max};
  if(d.op===OP.mint)return {...base,kind:'mint',number:null,nft:e.id,collection:b.collection,edition:b.edition,creator:b.creator,to:out.owner,name:b.name,type:b.type,size:b.content.length};
  if(d.op===OP.burn)return {...base,kind:'burn',number:out.number,nft:out.nft,owner:b.owner};
  if(d.op===OP.claim)return {...base,kind:'claim',number:out.number,to:b.to,proof:b.proof===PROOF.payment?'payment proof and message':'one-time key'};
  if(d.op===OP.move)return {...base,kind:'move',number:out.number,...(out.number==null?{nft:b.reg}:{}),from:b.from,to:b.to};
  if(d.op===OP.list)return {...base,kind:'list',number:out.number,...(out.number==null?{nft:b.reg}:{}),lot:e.id,seller:b.seller,price:b.price.toString(),until:b.until};
  const l=ledger.lot(b.lot);
  const which=l.number==null?{nft:l.reg}:{};
  if(d.op===OP.cancel)return {...base,kind:'cancel',number:l.number,...which,lot:l.id,seller:l.seller};
  if(d.op===OP.reserve)return {...base,kind:'reserve',number:l.number,...which,lot:l.id,buyer:b.buyer,payBy:b.payBy};
  return {...base,kind:'sale',number:l.number,...which,lot:l.id,seller:l.seller,buyer:out.owner,price:l.price.toString(),fee:(l.price*BigInt(RULES.feeBps)/10000n).toString(),payments:[...new Set(b.payments.map(p=>p.txid))]};}
 // A claim by burning: the same event as a claim by record, saying so, in the place where it completed: the burning
 // transaction, or the one whose fee payment reached the burn's fee (burnHeight and feeTx then say where each is). Its
 // txid is the burning transaction's.
 const noteBurn=(e,out)=>{const b=ledger.burnClaim(out.id),late=Boolean(b&&b.tx!==e.txid);
  events.push({height:e.height,pos:e.pos,txid:late?b.tx:e.txid,id:out.id,time:timeOf(e.height)??e.time??null,kind:'claim',number:out.number,to:out.owner,proof:'burn',...(late?{burnHeight:b.height,feeTx:e.txid}:{})});};
 // The fee payments of an entry, after what it carries; what each output counted for is kept for /entry.
 const noteFees=e=>{const r=ledger.applyBurnFees(e.txid,e.fee,e.feeFound??null);feeNotes.set(e.txid,r.paid);for(const c of r.claims)noteBurn(e,c);};
 function note(e,d,out){events.push(describe(e,d,out));if(d.op===OP.list){lots.push(e.id);bodies.set(e.id,hex(d.bodyBytes));}}
 const index=e=>{if(e.id&&e.ok)byId.set(e.id,e);if(!byTx.has(e.txid))byTx.set(e.txid,e);};
 // The ledger from the owner list and the journal alone. No node is asked.
 function rebuild(){
  ledger=createLedger({network,domain,feeAddress,owners,height:start,mintFrom,minters:minterList,openFrom,burnFrom,burnDead,burnFee,testChain});events=[];lots=[];bodies=new Map();byId=new Map();byTx=new Map();feeNotes=new Map();
  for(const e of journal){ledger.setHeight(e.height);index(e);
   if(e.ok&&e.burn){const out=ledger.applyBurnClaim(e.txid,e.burn);if(out.id!==e.id)throw Error('The journal does not match the rules at block '+e.height);if(out.owner)noteBurn(e,out);}
   else if(e.ok&&e.record!==undefined){const bytes=unhex(e.record),d=decodeRecord(bytes,network),out=ledger.apply(bytes,e.facts);
    if(out.id!==e.id)throw Error('The journal does not match the rules at block '+e.height);note(e,d,out);}
   if(e.fee)noteFees(e);}
  if(blocks.length)ledger.setHeight(blocks.at(-1).height);}
 function load(){
  const b=lines(files.blocks),r=lines(files.records),c=lines(files.checkpoints);blocks=b.rows;
  for(const [i,x] of blocks.entries())if(x.height!==start+1+i)throw Error('blocks.jsonl is not a run of blocks from the start block');
  const top=blocks.at(-1)?.height??start;journal=r.rows.filter(e=>e.height<=top);checkpoints=c.rows.filter(x=>x.height<=top);
  if(b.torn)replace(files.blocks,blocks);if(r.torn||journal.length!==r.rows.length)replace(files.records,journal);if(c.torn||checkpoints.length!==c.rows.length)replace(files.checkpoints,checkpoints);
  rebuild();
  // A stop between a block line and its checkpoint line: write the checkpoint now.
  if(checkpointEvery&&top>start&&top%checkpointEvery===0&&checkpoints.at(-1)?.height!==top){const c=checkpoint();checkpoints.push(c);append(files.checkpoints,[c]);}}
 function cut(height){
  blocks=blocks.filter(b=>b.height<=height);journal=journal.filter(e=>e.height<=height);checkpoints=checkpoints.filter(c=>c.height<=height);
  replace(files.records,journal);replace(files.blocks,blocks);replace(files.checkpoints,checkpoints);rebuild();}
 load();
 // The opening is written into the folder only now, when the folder has passed every check and was read whole.
 // A burn setting taken out is written now; one taken in, or changed, once the node's newest block is known (pass()),
 // and with it an opening taken in at the same start.
 let pendingBurn=lit!==null&&burnFrom!==null;
 if(opened!==null&&!pendingBurn){writeMeta(meta);log?.({opened:openFrom,at:opened});}
 if(lit!==null&&!pendingBurn){writeMeta(meta);log?.({burnFrom,at:lit});}

 // A summary anyone can compare: the accepted records so far and the ledger they lead to.
 function checkpoint(){
  const t=tipBlock(),accepted=journal.filter(e=>e.ok);
  // From the first mint block on a checkpoint names that block and the minter list, so two readers with different ones
  // never look alike. Before it, and on a ledger without one, a checkpoint is what it always was.
  // From the opening block on it names that block too.
  // From the first burn block on it names that block, the dead outputs and the hash of the owner outputs' indexes.
  const minting=meta.mintFrom!=null&&t.height>=meta.mintFrom,opened=meta.openFrom!=null&&t.height>=meta.openFrom,burns=meta.burnFrom!=null&&t.height>=meta.burnFrom;
  return {schema:'mordinals-checkpoint-v1',network,domain,owners:meta.owners,start,...(minting?{mintFrom:meta.mintFrom,...(meta.minters?{minters:meta.minters}:{}),...(opened?{openFrom:meta.openFrom}:{})}:{}),
   ...(burns?{burnFrom:meta.burnFrom,burnDead:meta.burnDead,ownerOutputs:meta.ownerOutputs,burnFee:meta.burnFee}:{}),height:t.height,blockHash:t.hash,records:accepted.length,
   listHash:sha(accepted.map(e=>`${e.height}:${e.txid}\n`).join('')),stateHash:sha(JSON.stringify(ledger.toJSON()))};}
 // Payment transactions a buy record names, as the node has them now.
 // With `upTo`, only payments in a block at or below that height are returned, so every reader judging the same
 // record sees the same facts whenever it runs.
 // A payment in a block this reader has read is checked against that block: the node's word that it is in a block
 // at that height is not enough, because the node may have answered from blocks that were replaced since. The block
 // there has to have the hash in this journal and has to list the transaction; otherwise the pass is tried again.
 async function lookup(txids,upTo=null){const found=await chain.txs([...new Set(txids)]),out=[];
  for(const id of new Set(txids)){const t=found.get(id);if(!t)continue;const height=t.inPool?null:t.height;
   if(upTo!=null&&(height==null||height>upTo))continue;
   if(upTo!=null&&height>start&&height<=tipBlock().height){const b=await chain.block(height);if(b.hash!==blocks[height-start-1].hash||!(b.txids.includes(id)||b.minerTx===id))throw changed(height);}
   out.push({txid:id,height,tx:slim(t.tx)});}return out;}
 const changed=height=>Error('The Monero node changed its answer for block '+height+'; trying again');
 async function judge(block,pos,txid,record){
  const e={height:block.height,pos,txid,record:hex(record)};let d;
  try{d=decodeRecord(record,network);}catch(err){return {...e,ok:false,error:String(err.message)};}
  e.op=d.op;e.id=recordId(domain,d.bodyBytes);
  // A node failure here stops the pass (and is tried again); it never turns into a refusal.
  const facts=d.op===OP.buy?await lookup(d.body.payments.map(p=>p.txid),block.height):undefined;if(facts)e.facts=facts;
  try{const out=ledger.apply(record,facts);e.ok=true;e.time=block.time;note(e,d,out);delete e.time;}catch(err){e.ok=false;e.error=String(err.message);}
  return e;}
 // A transfer in the original Mordinals format, from the first burn block on: a claim by burning, or refused with the reason.
 function judgeBurn(block,pos,txid,tx){
  const e={height:block.height,pos,txid,burn:burnParts(tx),id:burnClaimId(domain,txid)};
  try{const out=ledger.applyBurnClaim(txid,e.burn);e.ok=true;if(out.owner){e.time=block.time;noteBurn(e,out);delete e.time;}}catch(err){e.ok=false;e.error=String(err.message);}
  return e;}
 // From the first burn block on, every transaction is looked at for fee payments: one that pays a fee address is
 // journaled with what the rule reads of it, on the entry of the record or burn it carries, or on one of its own.
 function judgeFees(block,pos,txid,tx,e){
  const parts=feeParts(tx),found=parts?ledger.scanBurnFees(parts):[];if(!found.length)return e;
  const out=e||{height:block.height,pos,txid,ok:true};out.fee=parts;out.feeFound=found;noteFees(out);return out;}
 async function readBlock(height){
  const b=await chain.block(height);if(b.prev!==tipBlock().hash)return false;
  const txs=b.txids.length?await chain.txs(b.txids):new Map(),found=[];
  ledger.setHeight(height);blocks.push({height,hash:b.hash,time:b.time});
  try{
   for(const [pos,txid] of b.txids.entries()){const t=txs.get(txid);
    if(!t||t.inPool||t.height!==height)throw changed(height);
    const record=unframe(t.tx.extra);let e=null;if(record)e=await judge(b,pos,txid,record);
    // (A tx_extra is a record or a transfer, never both: a record's holds no field 0x11.)
    else if(burning&&height>=burnFrom&&readTransfer(t.tx.extra))e=judgeBurn(b,pos,txid,t.tx);
    if(burning&&height>=burnFrom)e=judgeFees(b,pos,txid,t.tx,e);
    if(e)found.push(e);}
   append(files.records,found);append(files.blocks,[blocks.at(-1)]);}
  catch(err){blocks.pop();rebuild();throw err;}
  for(const e of found){journal.push(e);index(e);}
  if(checkpointEvery&&height%checkpointEvery===0){const c=checkpoint();checkpoints.push(c);append(files.checkpoints,[c]);}
  return true;}
 let busy=null;
 async function pass({limit=Infinity}={}){
  const info=await chain.info();let reorg=0,added=0;
  if(testChain&&info.nettype!=='fakechain')throw Error('This reader names dead outputs of its own, which only the offline test chain has; the Monero node is not on that chain.');
  if(pendingBurn){if(burnFrom<info.height+BURN_MARGIN)throw Error(`The first burn block has to be at least ${BURN_MARGIN} blocks above the newest block of the Monero node (${info.height}); this folder keeps its setting.`);
   writeMeta(meta);if(opened!==null)log?.({opened:openFrom,at:opened});log?.({burnFrom,at:lit});pendingBurn=false;}
  if(info.height<start)throw Error('The Monero node has not reached the start block yet.');
  const first=await chain.header(start);
  if(!meta.startHash){meta.startHash=first.hash;writeMeta(meta);}
  if(first.hash!==meta.startHash)throw Error('The Monero node is on another chain at the start block; the owner list does not apply to it.');
  for(let round=0;round<50;round++){
   // Walk back to the last block this journal and the node agree on.
   let h=tipBlock().height;const from=h;
   while(h>start){if(h<=info.height&&(await chain.header(h)).hash===blocks[h-start-1].hash)break;h--;if(from-h>maxReorg)throw Error('The chain reorganised deeper than this reader follows.');}
   if(h<from){cut(h);reorg+=from-h;log({reorg:from-h,backTo:h});}
   let moved=true;
   while(tipBlock().height<info.height&&added<limit){if(!await readBlock(tipBlock().height+1)){moved=false;break;}added++;}
   if(moved)return {height:tipBlock().height,added,reorg,tip:info.height};}
  throw Error('The chain keeps changing; trying again later.');}
 const pool={seen:new Map()};
 return {
  get ledger(){return ledger;},get height(){return tipBlock().height;},get hash(){return tipBlock().hash;},get meta(){return {...meta};},
  get events(){return events;},get journal(){return journal;},get lots(){return lots;},get checkpoints(){return checkpoints;},get blocks(){return blocks;},
  body:id=>bodies.get(id)||null,entryById:id=>byId.get(id)||null,entryByTx:txid=>byTx.get(txid)||null,timeOf,checkpoint,lookup,
  // What the fee payments of one journaled transaction counted for: [{index, number, amount, counted, error}], or null.
  feesOf:txid=>feeNotes.get(txid)||null,
  // One pass at a time: read new blocks up to the node's tip.
  sync(options){if(!busy)busy=pass(options).finally(()=>{busy=null;});return busy;},
  // MD1 records waiting in the node's pool (not yet in a block). For "waiting" notices only; nothing here counts.
  async waiting(){const ids=await chain.pool(),fresh=ids.filter(i=>!pool.seen.has(i));
   if(fresh.length){const got=await chain.txs(fresh);for(const id of fresh){const t=got.get(id);let v=null;
    if(t){const record=unframe(t.tx.extra);if(record){try{const d=decodeRecord(record,network);v={txid:id,record:hex(record),op:d.op,id:recordId(domain,d.bodyBytes)};}catch{}}}
    pool.seen.set(id,v);}}
   const now=new Set(ids);for(const id of [...pool.seen.keys()])if(!now.has(id))pool.seen.delete(id);
   return ids.map(i=>pool.seen.get(i)).filter(Boolean);}};
}
