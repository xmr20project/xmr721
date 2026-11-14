// The relay: takes a signed MD1 record, puts it in a Monero transaction of its own and publishes it.
// It holds no user key and decides nothing: a record counts only when the reader finds it in a block and the rules
// accept it there. Anyone can publish a record without this relay (see RULES.md section 8).
//
// The relay pays the Monero network fee of each carrier transaction from its own small wallet (the carrier tool in
// ../carrier). That is why it checks a record against the current ledger before sending it and limits how many
// records one address or one Mordinal can have waiting.
//
// Minting is open to anyone, so a relay may charge a fee for carrying a collection or a mint record (`fees`, in
// atomic units; 0 = free). The fee is this relay's own price, not a rule of the ledger: a record published any other
// way counts the same. Each such record gets a subaddress of the relay's wallet; the record is sent once payments of
// at least the fee to that subaddress are in a block. A record that is not paid for in time is dropped unsent.
//
// Every job is one file, jobs/<record id>.json, written before the step it describes:
//   unpaid   a mint or a collection whose relay fee has not arrived yet (only when the relay charges one)
//   queued   accepted, no transaction built yet (no coin ready, or the node was unreachable)
//   held     a purchase whose payments are not in a block yet; it is sent once they are
//   built    transaction built and saved, not yet handed to the node
//   sent     handed to the node; waiting for a block
//   done     the reader accepted the record from a block
//   refused  the rules refused it (before sending, or in the block)
//   stuck    not mined after a long time; needs a person
import {execFile} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {existsSync,mkdirSync,readdirSync,readFileSync,renameSync,unlinkSync,openSync,writeSync,fsyncSync,closeSync} from 'node:fs';
import {join} from 'node:path';
import {OP,NO_COLLECTION,decodeRecord,recordId,signerOf,canonical} from '../../rules/lib/records.mjs';
import {readDeploy,TYPE_JSON} from '../../xmr20-tokens/lib/token.mjs';
import {unhex} from '../../rules/lib/monero.mjs';
import {MAX_RECORD} from './transport.mjs';

// The carrier tool, one call at a time (it keeps one state file).
export function createCarrier({bin,stateDir,node,network='offline-fakechain',start=1,timeout=180000}){
 let queue=Promise.resolve();
 const env={PATH:process.env.PATH||'',HOME:process.env.HOME||'',MORDINALS_NODE:node,MORDINALS_NETWORK:network,MORDINALS_START:String(start)};
 // Mainnet and the fee limit are switched on by the service's own environment, never by a request.
 for(const k of ['MORDINALS_MAINNET','MORDINALS_MAX_FEE','MORDINALS_SPLIT_COIN'])if(process.env[k])env[k]=process.env[k];
 const run=(op,arg)=>{const next=queue.then(()=>new Promise((done,fail)=>execFile(bin,[stateDir,op,...(arg==null?[]:[String(arg)])],{env,timeout,maxBuffer:1<<21},(err,stdout)=>{
   let v=null;try{v=JSON.parse(String(stdout).trim().split('\n').at(-1));}catch{}
   if(v&&'result' in v)done(v.result);else fail(Error(v?.error?String(v.error).slice(0,300):'The carrier tool did not answer'+(err?.killed?' in time':'')));})));
  queue=next.catch(()=>{});return next;};
 return {init:()=>run('init'),status:()=>run('status'),carry:record=>run('carry',record),split:n=>run('split',n),publish:blob=>run('publish',blob),address:n=>run('address',n)};}

const FINAL=new Set(['done','refused','stuck']);
export const DEFAULT_LIMITS={perSigner:3,waiting:200,perDay:2000,margin:5,resendMs:600000,stuckBlocks:720,holdBlocks:60,settleBlocks:10,sendAgain:2,minReady:3,splitInto:8,keepMs:7*86400000,payBlocks:30,unpaid:2000,payAddresses:5000,buyReserve:2,laneReserve:2,perCallerDay:200};
// A purchase is never held back by the shared limits: once a buyer has paid, the record that makes the Mordinal
// theirs goes first, with coins kept back for it (buyReserve), so nobody can crowd it out until the reservation runs out.

export function createRelay({dir,reader,chain,carrier,network='mainnet',domain,limits:given={},fees:asked={},lane=[],now=()=>Date.now(),log=()=>{}}){
 const laneOf=new Set(lane.map(a=>canonical(a,network)));
 // The launch a record is for: a deploy inscription (xmr20-tokens/FORMAT.md) names a Solana mint. The launch is its
 // signer's own (signer and mint together), so nobody holds a launch against another signer.
 const launchOf=d=>{if(d.op!==OP.mint||d.body.collection!==NO_COLLECTION||d.body.type!==TYPE_JSON)return null;
  const f=readDeploy(d.body.content);return f?.mint?d.body.creator+':'+f.mint:null;};
 // The deploy inscriptions the ledger holds for a launch, oldest first: [{id, withdrawn}] (withdrawn: burned by its own
 // signer). Read from the reader's accepted records and kept until the reader moves.
 let inscribedAt='',inscribedBy=new Map();
 const inscribed=launch=>{const at=reader.height+':'+reader.journal.length+':'+reader.hash;
  if(at!==inscribedAt){inscribedAt=at;inscribedBy=new Map();
   for(const e of reader.events){if(e.kind!=='mint'||e.type!==TYPE_JSON||e.collection!==NO_COLLECTION)continue;
    try{const k=launchOf(decodeRecord(unhex(reader.entryById(e.nft).record),network));if(k){if(!inscribedBy.has(k))inscribedBy.set(k,[]);inscribedBy.get(k).push(e.nft);}}catch{}}}
  return (inscribedBy.get(launch)||[]).map(nft=>{const x=reader.ledger.nft(nft);return {id:nft,withdrawn:Boolean(x?.burned)&&x.history.find(h=>h.what==='burn')?.from===x.minted.creator};});};
 const limits={...DEFAULT_LIMITS,...given},jobsDir=join(dir,'jobs'),splitFile=join(dir,'split.json'),payFile=join(dir,'pay.json');
 // Coins kept for the lane (none on a relay without one), and how many ready coins the relay keeps so that ordinary
 // records never wait on a count that starts no new split.
 const laneReserve=laneOf.size?limits.laneReserve:0,keepReady=Math.max(limits.minReady,limits.buyReserve+laneReserve+1);
 const fees={collection:BigInt(asked.collection||0),mint:BigInt(asked.mint||0)},priceOf=op=>op===OP.collection?fees.collection:op===OP.mint?fees.mint:0n;
 mkdirSync(jobsDir,{recursive:true});
 const write=(file,value)=>{const tmp=file+'.tmp',fd=openSync(tmp,'w',0o600);try{writeSync(fd,JSON.stringify(value)+'\n');fsyncSync(fd);}finally{closeSync(fd);}renameSync(tmp,file);};
 const jobs=new Map();
 for(const f of readdirSync(jobsDir)){if(!/^[0-9a-f]{64}\.json$/.test(f))continue;try{const j=JSON.parse(readFileSync(join(jobsDir,f),'utf8'));if(j.id===f.slice(0,64))jobs.set(j.id,j);}catch{}}
 let split=existsSync(splitFile)?JSON.parse(readFileSync(splitFile,'utf8')):null;
 // Fee payments: which record each subaddress was given to (and from which block its payments count), and the
 // payments already counted for a record that was sent.
 const pay=existsSync(payFile)?JSON.parse(readFileSync(payFile,'utf8')):{addresses:{},used:[]};const used=new Set(pay.used);
 // Callers are counted by a salted hash of their address, never by the address itself.
 const saltFile=join(dir,'caller-salt');if(!existsSync(saltFile))write(saltFile,randomBytes(16).toString('hex'));const salt=JSON.parse(readFileSync(saltFile,'utf8'));
 const callerKey=c=>c?createHash('sha256').update(salt+':'+c).digest('hex').slice(0,24):null;
 let ready=null;   // spendable coins at the last check; null until the first one
 function payAddress(id,tip,t){
  for(const [n,e] of Object.entries(pay.addresses))if(e.id===id)return Number(n);
  for(let n=1;n<=limits.payAddresses;n++){const e=pay.addresses[n],j=e&&jobs.get(e.id);
   // A subaddress is given out again only when its record is long gone, so a late payment is not counted for another record.
   if(!e||(!j&&t-e.at>limits.keepMs)){pay.addresses[n]={id,from:tip,at:t};write(payFile,pay);return n;}}
  throw bad('The relay is busy. Try again in a few minutes.',503);}
 // A fee payment is one output of a transaction: one transaction may pay several records' fees.
 const outKey=p=>p.txid+':'+(p.out??0);
 const paidFor=(j,payments)=>{const e=pay.addresses[j.pay.index];return e&&e.id===j.id?payments.filter(p=>p.index===j.pay.index&&p.height>=e.from&&!used.has(outKey(p))):[];};
 const save=j=>write(join(jobsDir,j.id+'.json'),j),drop=j=>{jobs.delete(j.id);try{unlinkSync(join(jobsDir,j.id+'.json'));}catch{}};
 const waiting=()=>[...jobs.values()].filter(j=>!FINAL.has(j.state));
 const view=j=>({id:j.id,state:j.state,op:j.op,number:j.number,txid:j.txid||null,error:j.error||null,note:j.note||null,...(j.state==='unpaid'?{pay:{address:j.pay.address,amount:j.pay.amount,payBy:j.payBy}}:{})});
 const refuse=(j,error)=>{j.state='refused';j.error=String(error).slice(0,300);j.endedAt=now();save(j);};
 // One thing at a time: a new record and the regular check never interleave.
 let chainOf=Promise.resolve();
 const alone=work=>{const next=chainOf.then(work);chainOf=next.catch(()=>{});return next;};
 const bad=(message,status=400)=>{const e=Error(message);e.status=status;return e;};

 // A purchase waits here while its payments are not in a block: the listing must still be open and reserved.
 function holdable(d){const l=reader.ledger.lot(d.body.lot);
  if(!l)throw bad('This listing does not exist.');if(l.status!=='open')throw bad(l.status==='sold'?'This Mordinal is already sold.':'This listing was cancelled.');
  const r=l.reservations.at(-1);if(!r)throw bad('Nobody reserved this listing; reserve it before paying.');
  if(reader.height>r.payBy+limits.holdBlocks)throw bad('The payments did not reach a block in time. If they are in a block now, send the purchase again.');
  return l;}
 // Judge a record against the ledger as the reader has it now. -> {ready}
 // A purchase whose payments are not all in a block yet is judged as if they were in the newest block: only a
 // purchase that would count is held, so nobody can hold a Mordinal's place without really paying.
 async function judge(bytes,d,{fresh=false}={}){
  // A node that cannot be reached throws here unmarked; only the rules' own answers are marked as refusals.
  const ids=d.op===OP.buy?[...new Set(d.body.payments.map(p=>p.txid))]:null,facts=ids?await reader.lookup(ids,reader.height):undefined;
  const late=ids&&facts.length<ids.length?await reader.lookup(ids.filter(id=>!facts.some(f=>f.txid===id))):null;
  try{
   if(late){holdable(d);
    if(late.length+facts.length<ids.length){if(fresh)throw bad('A payment of this purchase is not known to the Monero node yet. Wait a moment and send it again.');return {ready:false};}
    reader.ledger.check(bytes,[...facts,...late.map(f=>({...f,height:reader.height}))]);return {ready:false};}
   reader.ledger.check(bytes,facts);return {ready:true};}
  catch(e){e.rule=true;throw e;}}
 function describe(d){
  const b=d.body;if(d.op===OP.collection||d.op===OP.mint)return {number:null,signer:b.creator};
  const l=d.op===OP.cancel||d.op===OP.reserve||d.op===OP.buy?reader.ledger.lot(b.lot):null;
  // One record at a time per NFT: a Mordinal by its number, a minted NFT by its id.
  const m=reader.ledger.mordinal(l?l.reg:d.op===OP.burn?b.nft:b.reg),number=m.number??m.reg;
  const signer=signerOf(d.op,b)||(d.op===OP.claim?b.to:l?.reservations.at(-1)?.buyer)||'';
  return {number,signer};}
 async function send(j){
  // Coins are kept back in two steps: the last ones for purchases, the ones above them for the listed minters' lane.
  // A purchase never waits here, a lane record waits only for the purchases' coins, every other record for both.
  if(j.state!=='built'&&ready!=null&&ready<=(j.op===OP.buy?-1:j.lane?limits.buyReserve:limits.buyReserve+laneReserve)){j.note='Waiting for a coin of the relay; purchases go first.';save(j);return j;}
  try{
   if(j.state!=='built'){const t=await carrier.carry(j.record);if(ready!=null)ready=Math.max(0,ready-1);j.txid=t.txid;j.blob=t.blob;j.fee=t.fee;j.state='built';j.note=null;save(j);}
   await carrier.publish(j.blob);j.state='sent';j.sentAt=now();j.sentHeight=reader.height;j.note=null;save(j);}
  catch(e){j.note=String(e.message).slice(0,200);j.tries=(j.tries||0)+1;save(j);log({job:j.id,note:j.note});}
  return j;}

 async function submit(recordHex,{caller=null,anew=false}={}){
  if(typeof recordHex!=='string'||!/^([0-9a-f]{2})+$/.test(recordHex)||recordHex.length>2*MAX_RECORD)throw bad('A record is hexadecimal and at most '+MAX_RECORD+' bytes.');
  const bytes=unhex(recordHex),d=decodeRecord(bytes,network),id=recordId(domain,d.bodyBytes);
  // A record this relay gave up on (refused, or not mined for so long that it was marked stuck) may be handed over again.
  const known=jobs.get(id);if(known&&known.state!=='refused'&&known.state!=='stuck')return view(known);
  const entry=reader.entryById(id);if(entry)return {id,state:'done',op:d.op,txid:entry.txid,error:null,note:null};
  // A stuck record whose transaction was built goes out as that same transaction: the node may still hold it, and a second
  // transaction for the same record would be mined beside it and paid for twice.
  if(known?.state==='stuck'&&known.blob){known.state='built';known.note=null;known.endedAt=null;save(known);await send(known);return view(known);}
  // The rules' own answers go back as they are; a node that cannot be reached is the relay's trouble, not the record's.
  let isReady;try{({ready:isReady}=await judge(bytes,d,{fresh:true}));}catch(e){if(!e.rule&&!e.status)e.status=503;throw e;}
  const {number,signer}=describe(d),tip=reader.height;
  if(d.op===OP.reserve&&d.body.payBy<tip+limits.margin)throw bad('This reservation would run out before it reaches a block. Reserve again.');
  if(d.op===OP.list&&d.body.until<tip+limits.margin)throw bad('This listing would end before it reaches a block. Choose a later end.');
  // One record per launch (a signer's deploy inscription for a Solana mint). A record for a launch is not taken while
  // another one stands for it: one this relay still has on its way (any state but refused), or one on the ledger that
  // its signer has not burned. Nor is it taken, by itself, for a launch that was inscribed before and withdrawn: that
  // needs `anew`, the word of a person who means to inscribe the launch again. What is on the ledger is looked at here,
  // not remembered from the relay's own jobs, so it holds whatever became of them; and records are taken one at a time,
  // so no two runs of one signer get a record in for the same launch.
  const launch=launchOf(d);
  if(launch){
   const before=inscribed(launch).filter(x=>x.id!==id),standing=before.find(x=>!x.withdrawn);
   const onItsWay=[...jobs.values()].find(j=>j.launch===launch&&j.id!==id&&j.state!=='refused'&&!reader.entryById(j.id));
   if(onItsWay||standing)throw Object.assign(bad('Another record for this launch is with the relay or on the ledger already.',409),{held:(onItsWay||standing).id});
   if(before.length&&!anew)throw Object.assign(bad('This launch was inscribed before and its inscription was burned. To inscribe it again, hand the record over with "anew".',409),{held:before.at(-1).id});}
  const all=waiting(),open=all.filter(j=>j.state!=='unpaid'),price=priceOf(d.op);
  if(number!=null&&open.some(j=>j.number===number))throw bad('Another record for this Mordinal is waiting for a block. Try again in a few minutes.',429);
  if(price&&all.length-open.length>=limits.unpaid)throw bad('The relay is busy. Try again in a few minutes.',503);
  if(all.filter(j=>j.signer===signer).length>=limits.perSigner)throw bad('This address already has '+limits.perSigner+' records waiting for a block. Try again in a few minutes.',429);
  const day=now()-86400000,who=callerKey(caller);
  // The ledger's listed minters (the launchpad's inscriber) have a lane of their own for their collections and mints:
  // like a purchase, such a record is not held back by what everyone else has waiting, and it does not count against
  // everyone else's daily limits. The per-address limit still applies.
  const ownLane=(d.op===OP.mint||d.op===OP.collection)&&laneOf.has(signer);
  if(d.op!==OP.buy&&!ownLane){
   if(open.length>=limits.waiting)throw bad('The relay is busy. Try again in a few minutes.',503);
   if([...jobs.values()].filter(j=>j.createdAt>day&&j.txid&&j.op!==OP.buy&&!j.lane).length>=limits.perDay)throw bad('The relay reached its daily limit. Try again later, or publish the record yourself.',503);
   if(who&&[...jobs.values()].filter(j=>j.caller===who&&j.createdAt>day&&!j.lane).length>=limits.perCallerDay)throw bad('This connection sent many records today. Try again tomorrow, or publish the record yourself.',429);}
  if(known)drop(known);
  const j={id,record:recordHex,op:d.op,number,signer,caller:who,state:isReady?'queued':'held',createdAt:now(),createdHeight:tip,...(ownLane?{lane:true}:{}),...(launch?{launch}:{})};
  if(price){
   // The subaddress is saved by the carrier before it is given out, so every later scan looks for payments to it.
   const index=payAddress(id,tip,j.createdAt),{address}=await carrier.address(index);
   j.state='unpaid';j.pay={index,address,amount:price.toString()};j.payBy=tip+limits.payBlocks;}
  jobs.set(id,j);save(j);
  if(j.state==='queued')await send(j);return view(j);}

 // After each reader pass: settle what reached a block, send again what did not, keep coins ready.
 async function tick(){
  const tip=reader.height,t=now();let asked=null,unknown=null,payments=null;
  const received=async()=>payments??=((await carrier.status()).payments||[]);
  const missing=async txid=>{if(!asked?.has(txid)){const ids=[...new Set([...jobs.values()].filter(j=>j.state==='sent').map(j=>j.txid).concat([txid]))],got=await chain.txs(ids);asked=new Set(ids);unknown=new Set(ids.filter(i=>!got.has(i)));}return unknown.has(txid);};
  // Purchases first.
  for(const j of [...jobs.values()].sort((a,b)=>(b.op===OP.buy)-(a.op===OP.buy))){
   try{
    if(j.state==='done'){
     // A block that held this record can still be replaced for a while.
     if(tip-j.doneHeight<limits.settleBlocks&&!reader.entryById(j.id)){j.state='sent';j.sentAt=0;j.sentHeight=tip;j.doneHeight=null;j.endedAt=null;save(j);}
     else{if(t-j.endedAt>limits.keepMs)drop(j);continue;}}
    if(FINAL.has(j.state)){
     // A record given up on as stuck may still reach a block.
     const late=j.state==='stuck'?reader.entryById(j.id):null;
     if(late){j.state='done';j.txid=late.txid;j.doneHeight=late.height;j.endedAt=t;j.note=null;save(j);}
     else if(j.state==='refused'&&t-j.endedAt>limits.keepMs)drop(j);continue;}
    const ok=reader.entryById(j.id),mine=j.txid?reader.entryByTx(j.txid):null;
    if(ok){j.state='done';j.txid=ok.txid;j.doneHeight=ok.height;j.endedAt=t;j.note=null;save(j);continue;}
    if(mine&&!mine.ok){
     // A purchase can be refused in its block only because replaced blocks put it before its own payment. If the
     // rules would accept it now, or once its payment is in a block, it goes out again in a new transaction, a
     // limited number of times; the buyer's wallet may no longer hold what it takes to make the record again.
     if(j.op!==OP.buy||(j.again||0)>=limits.sendAgain){refuse(j,mine.error);continue;}
     const bytes=unhex(j.record);let ready;
     try{({ready}=await judge(bytes,decodeRecord(bytes,network)));}catch(e){if(e.rule){refuse(j,mine.error);continue;}throw e;}
     j.again=(j.again||0)+1;j.state=ready?'queued':'held';j.txid=j.blob=j.fee=null;j.createdHeight=tip;j.note=null;save(j);log({job:j.id,again:j.again});
     if(ready)await send(j);
     continue;}
    if(j.state==='unpaid'){
     const got=paidFor(j,await received()),sum=got.reduce((a,p)=>a+BigInt(p.amount),0n);
     if(sum<BigInt(j.pay.amount)){if(tip>j.payBy)refuse(j,'The relay fee was not paid in time. Nothing was sent. A payment that arrives late counts when the same record is sent again.');continue;}
     const bytes=unhex(j.record);
     try{await judge(bytes,decodeRecord(bytes,network));}catch(e){if(e.rule){refuse(j,e.message);log({job:j.id,paidButRefused:got.map(p=>p.txid)});continue;}throw e;}
     // The job is saved as paid before the payment is marked used, so a crash in between keeps the fee with this record.
     j.state='queued';j.paid=got.map(outKey);j.createdHeight=tip;save(j);
     for(const p of got)used.add(outKey(p));pay.used=[...used];write(payFile,pay);await send(j);continue;}
    if(j.state==='queued'||j.state==='held'){
     if(j.state==='queued'&&tip-j.createdHeight>limits.stuckBlocks){j.state='stuck';j.endedAt=t;save(j);log({job:j.id,stuck:true});continue;}
     const bytes=unhex(j.record),d=decodeRecord(bytes,network);let ready;
     try{({ready}=await judge(bytes,d));}catch(e){if(e.rule){refuse(j,e.message);continue;}throw e;}
     if(ready){j.state=j.blob?'built':'queued';await send(j);}
     continue;}
    if(j.state==='built'){await send(j);continue;}
    if(j.state==='sent'){
     if(tip-j.sentHeight>limits.stuckBlocks){j.state='stuck';j.endedAt=t;save(j);log({job:j.id,stuck:true});continue;}
     if(t-j.sentAt>limits.resendMs&&await missing(j.txid)){
      // The node dropped the transaction (or a block that held it was replaced). Send it again only if it would still count.
      const bytes=unhex(j.record);let ready;try{({ready}=await judge(bytes,decodeRecord(bytes,network)));}catch(e){if(e.rule){refuse(j,e.message);continue;}throw e;}
      if(!ready){j.state='held';save(j);continue;}
      j.state='built';await send(j);}}}
   catch(e){log({job:j.id,error:String(e.message).slice(0,200)});}}
  // Coins: every record spends one coin of the relay's wallet, so keep a few ready.
  try{
   if(split){const got=await chain.txs([split.txid]),s=got.get(split.txid);
    if(s&&!s.inPool){split=null;try{unlinkSync(splitFile);}catch{}}
    else if(!s&&t-split.sentAt>limits.resendMs){await carrier.publish(split.blob);split.sentAt=t;write(splitFile,split);}}
   const status=await carrier.status();ready=status.ready;
   if(!split&&status.ready<keepReady&&status.ready>0){
    try{const s=await carrier.split(limits.splitInto);split={txid:s.txid,blob:s.blob,sentAt:t};write(splitFile,split);await carrier.publish(s.blob);log({split:s.txid});}
    catch(e){log({coins:String(e.message).slice(0,200)});}}
   return {tip,waiting:waiting().length,ready:status.ready,balance:status.balance};}
  catch(e){log({coins:String(e.message).slice(0,200)});return {tip,waiting:waiting().length,ready:null,balance:null};}}

 return {limits,fees:{collection:fees.collection.toString(),mint:fees.mint.toString()},
  submit:(recordHex,o)=>alone(()=>submit(recordHex,o)),tick:()=>alone(tick),
  // What became of a record: a waiting job, or an accepted record in a block.
  status(id){const j=jobs.get(id),e=reader.entryById(id);
   if(e)return {id,state:'done',txid:e.txid,height:e.height,confirmations:reader.height-e.height+1,error:null};
   if(j)return {...view(j),state:j.state==='done'?'sent':j.state,height:null,confirmations:0};
   return {id,state:'unknown',txid:null,height:null,confirmations:0,error:null};},
  pending:()=>waiting().map(view),
  // Records waiting for one Mordinal or signed by one address, for "waiting for a block" notices.
  waitingFor:({number,signer})=>waiting().filter(j=>(number!=null&&j.number===number)||(signer&&j.signer===signer)).map(view),
  // Every collection and mint record of one signer that this relay knows, whatever became of it, with its bytes. Only
  // those two kinds: they hold nothing but what their signer means to publish, where a purchase waiting for its payment
  // holds proofs that are not public before its block.
  jobsOf:signer=>[...jobs.values()].filter(j=>j.signer===signer&&(j.op===OP.mint||j.op===OP.collection)).map(j=>({id:j.id,state:j.state,op:j.op,record:j.record})),
  jobs:()=>[...jobs.values()].map(j=>({...view(j),fee:j.fee||null,createdAt:j.createdAt})),
  carrier};
}
