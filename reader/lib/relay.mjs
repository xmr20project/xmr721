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
// A relay with a lane (`lane`: the ledger's listed minters) carries their collections and mints without the fee. Other
// signers' collections and mints it carries only when it charges for them; without a fee it refuses them.
//
// Every job is one file, jobs/<record id>.json, written before the step it describes:
//   unpaid   a mint or a collection whose relay fee has not arrived yet (only when the relay charges one)
//   queued   accepted, no transaction built yet (no coin ready, or the node was unreachable)
//   held     a purchase whose payments are not in a block yet, or a claim by a spent coin whose spending transaction
//            is not in a block below the newest one yet; it is sent once they are
//   built    transaction built and saved, not yet handed to the node
//   sent     handed to the node; waiting for a block
//   done     the reader accepted the record from a block
//   refused  the rules refused it (before sending, or in the block)
//   stuck    not mined after a long time; needs a person
//
// Mint records of open XMR20 tokens (xmr20-tokens/OPEN.md) are carried too, when the relay charges for them
// (`fees.tokenMint`). Such a record is no MD1 record and carries no signature: whoever asks names the token, the amount
// and the Monero address the tokens go to, the relay has the carrier tool make the record and sends it once its fee is
// paid. The XMR721 ledger has nothing to say about it, so the job is done when the node shows its transaction 10 blocks
// deep. What the mint credited is the token ledger's to say.
import {execFile} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {existsSync,mkdirSync,readdirSync,readFileSync,renameSync,unlinkSync,openSync,writeSync,fsyncSync,closeSync} from 'node:fs';
import {join} from 'node:path';
import {OP,PROOF,NO_COLLECTION,decodeRecord,recordId,signerOf,canonical} from '../../rules/lib/records.mjs';
import {readDeploy,TYPE_JSON} from '../../xmr20-tokens/lib/token.mjs';
import {unhex,hex,leBytes,decodeAddress} from '../../rules/lib/monero.mjs';
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
 return {init:()=>run('init'),status:()=>run('status'),carry:record=>run('carry',record),split:n=>run('split',n),publish:blob=>run('publish',blob),address:n=>run('address',n),mintRecord:arg=>run('mint-record',arg)};}

const FINAL=new Set(['done','refused','stuck']);
// The kind of a job that carries a token mint record (every other job's `op` is its record's number).
export const TOKEN_MINT='token-mint';
const UNIT=1000000n;
export const DEFAULT_LIMITS={perSigner:3,waiting:200,perDay:2000,margin:5,resendMs:600000,stuckBlocks:720,holdBlocks:60,settleBlocks:10,sendAgain:2,minReady:3,splitInto:8,keepMs:7*86400000,payBlocks:30,unpaid:2000,mintUnpaid:500,mintWaiting:200,mintPerDay:2000,mintDepth:10,mintIdleMs:6*3600000,payAddresses:5000,buyReserve:2,laneReserve:2,perCallerDay:200};
// A purchase is never held back by the shared limits: once a buyer has paid, the record that makes the Mordinal
// theirs goes first, with coins kept back for it (buyReserve), so nobody can crowd it out until the reservation runs out.

export function createRelay({dir,reader,chain,carrier,network='mainnet',domain,limits:given={},fees:asked={},lane=[],now=()=>Date.now(),log=()=>{}}){
 const laneOf=new Set(lane.map(a=>canonical(a,network)));
 // A collection or mint record of someone who is not one of this relay's own minters (on a relay that has any), when
 // the relay does not charge for that kind of record. A relay that charges carries it once it is paid for.
 const NOT_CARRIED='This relay carries collection and mint records of its own minters only. Inscribe from your own wallet with the xmr721 command (see the XMR721 README).';
 const foreign=d=>(d.op===OP.mint||d.op===OP.collection)&&laneOf.size>0&&!laneOf.has(canonical(d.body.creator,network))&&!priceOf(d.op);
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
 const fees={collection:BigInt(asked.collection||0),mint:BigInt(asked.mint||0),tokenMint:BigInt(asked.tokenMint||0)},priceOf=op=>op===OP.collection?fees.collection:op===OP.mint?fees.mint:0n;
 mkdirSync(jobsDir,{recursive:true});
 const write=(file,value)=>{const tmp=file+'.tmp',fd=openSync(tmp,'w',0o600);try{writeSync(fd,JSON.stringify(value)+'\n');fsyncSync(fd);}finally{closeSync(fd);}renameSync(tmp,file);};
 const jobs=new Map();
 for(const f of readdirSync(jobsDir)){if(!/^[0-9a-f]{64}\.json$/.test(f))continue;try{const j=JSON.parse(readFileSync(join(jobsDir,f),'utf8'));if(j.id===f.slice(0,64))jobs.set(j.id,j);}catch{}}
 let split=existsSync(splitFile)?JSON.parse(readFileSync(splitFile,'utf8')):null;
 // Fee payments: which record each subaddress was given to (and from which block its payments count), and the
 // payments already counted for a record that was sent.
 const pay=existsSync(payFile)?JSON.parse(readFileSync(payFile,'utf8')):{addresses:{},used:[]};const used=new Set(pay.used);
 // (A job is saved as paid before its payments are marked used; one that was cut off in between is made whole here.)
 for(const j of jobs.values())for(const k of j.paid||[])used.add(k);
 // Callers are counted by a salted hash of their address, never by the address itself.
 const saltFile=join(dir,'caller-salt');if(!existsSync(saltFile))write(saltFile,randomBytes(16).toString('hex'));const salt=JSON.parse(readFileSync(saltFile,'utf8'));
 const callerKey=c=>c?createHash('sha256').update(salt+':'+c).digest('hex').slice(0,24):null;
 let ready=null;   // spendable coins at the last check; null until the first one
 function payAddress(id,tip,t){
  for(const [n,e] of Object.entries(pay.addresses))if(e.id===id){if(e.idleAt){delete e.idleAt;write(payFile,pay);}return Number(n);}
  for(let n=1;n<=limits.payAddresses;n++){const e=pay.addresses[n],j=e&&jobs.get(e.id);
   // A subaddress is given out again only when its record is long gone, so a late payment is not counted for another record.
   // The address of a token mint that nobody paid anything for is given out again sooner (`idleAt`): asking for a mint
   // costs nothing, so such addresses must not stay taken for a week. Its job goes with it.
   const idle=e?.idleAt&&t-e.idleAt>limits.mintIdleMs&&(!j||(j.op===TOKEN_MINT&&j.state==='refused'));
   if(!e||(!j&&t-e.at>limits.keepMs)||idle){if(idle&&j)drop(j);pay.addresses[n]={id,from:tip,at:t};write(payFile,pay);return n;}}
  throw bad('The relay is busy. Try again in a few minutes.',503);}
 // A fee payment is one output of a transaction: one transaction may pay several records' fees.
 const outKey=p=>p.txid+':'+(p.out??0);
 const paidFor=(j,payments)=>{const e=pay.addresses[j.pay.index];return e&&e.id===j.id?payments.filter(p=>p.index===j.pay.index&&p.height>=e.from&&!used.has(outKey(p))):[];};
 const save=j=>write(join(jobsDir,j.id+'.json'),j),drop=j=>{jobs.delete(j.id);try{unlinkSync(join(jobsDir,j.id+'.json'));}catch{}};
 const waiting=()=>[...jobs.values()].filter(j=>!FINAL.has(j.state));
 const view=j=>({id:j.id,state:j.state,op:j.op,number:j.number,txid:j.txid||null,error:j.error||null,note:j.note||null,...(j.mint?{mint:{token:j.mint.token,amount:j.mint.amount,asset:j.mint.asset}}:{}),...(j.state==='unpaid'&&!j.mint?{pay:{address:j.pay.address,amount:j.pay.amount,payBy:j.payBy}}:{})});
 // What the one who asked for a mint is told: also the address the tokens go to, the record, and where to pay. The
 // public answers (status, pending) leave those out: the chain shows an owner key, never the address behind it.
 const mintView=j=>({...view(j),mint:j.mint,record:j.record,...(j.state==='unpaid'?{pay:{address:j.pay.address,amount:j.pay.amount,payBy:j.payBy}}:{}),
  notice:'The fee pays for carrying the mint. What it credits is the token ledger\'s to say: less than asked when less is left of the token, nothing when it is minted out.'});
 const refuse=(j,error)=>{j.state='refused';j.error=String(error).slice(0,300);j.endedAt=now();save(j);};
 // One thing at a time: a new record and the regular check never interleave.
 let chainOf=Promise.resolve();
 const alone=work=>{const next=chainOf.then(work);chainOf=next.catch(()=>{});return next;};
 const bad=(message,status=400)=>{const e=Error(message);e.status=status;return e;};

 // A purchase waits here while its payments are not in a block: the listing must still be open and reserved.
 // A job that carries a claim by a spent coin (section 11).
 const spendClaim=j=>{if(j.op!==OP.claim)return false;try{return decodeRecord(unhex(j.record),network).body.proof===PROOF.spend;}catch{return false;}};
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
  // A claim by a spent coin (section 11): the transaction that spent the coin, as the node has it now, in a block or not.
  const spent=d.op===OP.claim&&d.body.proof===PROOF.spend,spend=spent?(await reader.lookup([d.body.spendTx],null,{inputs:true}))[0]??null:null;
  try{
   // A claim record handed over now reaches the next block at the earliest. On a ledger that claims by burning it
   // would be refused there once claim records no longer count, so it is not carried. A claim by a spent coin counts
   // from its own first block on, whatever the claim records do.
   const burn=reader.ledger.burn;if(d.op===OP.claim&&!spent&&burn&&reader.height+1>=burn.recordsEnd)throw bad(`From block ${burn.recordsEnd} a Mordinal is claimed only by burning it; a claim record no longer counts.`);
   if(spent){
    // Before the first block of such claims: refused if the record could not reach it, held if it reaches it at the earliest.
    const from=reader.ledger.spend?.from??null;
    if(from!==null&&reader.height<from){if(reader.height+1<from)throw bad(`Claiming by a spent coin starts at block ${from}.`);return {ready:false};}
    // A node may miss a transaction for a moment (between the pool and a block, or another node): a held claim stays held.
    if(!spend){if(fresh)throw bad('The Monero node does not know the transaction that spent the coin. Check that it was sent, then hand the claim over again.');return {ready:false};}
    // Not in a block yet, or in the newest one: the record reaches a later block, where the spend is in an earlier one.
    // It is judged as if the spend were one block back, and held until it is.
    if(spend.height==null||spend.height>=reader.height){reader.ledger.check(bytes,[{...spend,height:reader.height-1}]);return {ready:false};}
    // In an older block: judged against that block, as a reader judges it.
    reader.ledger.check(bytes,await reader.lookup([d.body.spendTx],reader.height,{inputs:true}));return {ready:true};}
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
  // A relay with a lane that charges no fee for a kind of record carries collections and mints of that kind for the lane
  // alone: everyone else inscribes from a wallet of their own, which pays its own network fee. Every other record it
  // carries for everyone. This comes first: nothing is looked up, kept or sent again for such a record. A relay that
  // charges takes everyone's for the fee below (the lane's go free).
  if(foreign(d))throw bad(NOT_CARRIED,403);
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
  const ownLane=(d.op===OP.mint||d.op===OP.collection)&&laneOf.has(signer);
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
  // The listed minters' collections and mints go without the fee.
  // (Token mints have limits of their own, so they neither fill nor use up the records' limits.)
  const all=waiting().filter(j=>j.op!==TOKEN_MINT),open=all.filter(j=>j.state!=='unpaid'),price=ownLane?0n:priceOf(d.op);
  if(number!=null&&open.some(j=>j.number===number))throw bad('Another record for this Mordinal is waiting for a block. Try again in a few minutes.',429);
  if(price&&all.length-open.length>=limits.unpaid)throw bad('The relay is busy. Try again in a few minutes.',503);
  if(all.filter(j=>j.signer===signer).length>=limits.perSigner)throw bad('This address already has '+limits.perSigner+' records waiting for a block. Try again in a few minutes.',429);
  const day=now()-86400000,who=callerKey(caller);
  // The ledger's listed minters (the launchpad's inscriber) have a lane of their own for their collections and mints:
  // like a purchase, such a record is not held back by what everyone else has waiting, and it does not count against
  // everyone else's daily limits. The per-address limit still applies.
  if(d.op!==OP.buy&&!ownLane){
   if(open.length>=limits.waiting)throw bad('The relay is busy. Try again in a few minutes.',503);
   if([...jobs.values()].filter(j=>j.createdAt>day&&j.txid&&j.op!==OP.buy&&j.op!==TOKEN_MINT&&!j.lane).length>=limits.perDay)throw bad('The relay reached its daily limit. Try again later, or publish the record yourself.',503);
   if(who&&[...jobs.values()].filter(j=>j.caller===who&&j.createdAt>day&&!j.lane).length>=limits.perCallerDay)throw bad('This connection sent many records today. Try again tomorrow, or publish the record yourself.',429);}
  if(known)drop(known);
  const j={id,record:recordHex,op:d.op,number,signer,caller:who,state:isReady?'queued':'held',createdAt:now(),createdHeight:tip,...(ownLane?{lane:true}:{}),...(launch?{launch}:{})};
  if(price){
   // The subaddress is saved by the carrier before it is given out, so every later scan looks for payments to it.
   const index=payAddress(id,tip,j.createdAt),{address}=await carrier.address(index);
   j.state='unpaid';j.pay={index,address,amount:price.toString()};j.payBy=tip+limits.payBlocks;}
  jobs.set(id,j);save(j);
  if(j.state==='queued')await send(j);return view(j);}

 // ---- Mint records of open XMR20 tokens
 // The open token with this id, as the service that runs this relay lists it ({id, tick, lim}), or null.
 let tokenOf=null;
 const NO_MINTS='This relay does not carry mints of open XMR20 tokens. Mint from your own wallet with the xmr721 command.';
 // May this token be minted now? -> null, or why not. Asked when a mint is taken and again when its fee has arrived.
 const unmintable=(t,units)=>!t?'This is not an open token on this ledger. A new token has to be in a block before it is minted.'
  :reader.height-t.height+1<limits.mintDepth?`This token's deploy is ${Math.max(1,reader.height-t.height+1)} blocks deep; the relay mints a token once its deploy is ${limits.mintDepth} blocks deep.`
  :t.lim==null?'Nothing of this token can be minted: its whole supply went to its creator.':units>BigInt(t.lim)*UNIT?`One mint of this token takes at most ${t.lim}.`:null;
 async function submitMint({token,amount,address,wallet=null,salt=null,caller=null}={}){
  if(!fees.tokenMint||!tokenOf)throw bad(NO_MINTS,503);
  if(typeof token!=='string'||!/^(?:[0-9a-f]{16}|[0-9a-f]{64})$/.test(token))throw bad('token: the token\'s id (64 hex characters), or the 16 characters signed texts show.');
  const m=typeof amount==='string'?/^([0-9]{1,14})(?:\.([0-9]{1,6}))?$/.exec(amount):null,units=m?BigInt(m[1])*UNIT+BigInt((m[2]||'').padEnd(6,'0')):0n;
  if(units<1n||units>=1n<<64n)throw bad('amount: a number of tokens with up to 6 decimals, above 0, written as text.');
  // The tokens go to a Monero address, or to an XMR20 wallet named by its owner key: one of the two.
  let to=null,k=null;
  if(wallet!=null){if(address!=null)throw bad('Give the address or the wallet the tokens go to, not both.');if(typeof wallet!=='string'||!/^[0-9a-f]{64}$/.test(wallet)||/^0+$/.test(wallet))throw bad('wallet: the owner key of the XMR20 wallet the tokens go to (64 hex characters).');}
  else try{to=canonical(address,network);k=decodeAddress(to,network);}catch{throw bad('address: the Monero address the tokens go to (a main address or a subaddress).');}
  if(salt!=null&&!(typeof salt==='string'&&/^[0-9a-f]{16}$/.test(salt)))throw bad('salt: 16 hex characters, or leave it out.');
  const t=tokenOf(token),why=unmintable(t,units);if(why)throw bad(why,t?400:404);
  // The limits come before the carrier tool is asked for anything: a request that is refused costs the relay nothing.
  const mints=[...jobs.values()].filter(j=>j.op===TOKEN_MINT),live=mints.filter(j=>!FINAL.has(j.state)),tip=reader.height,day=now()-86400000,who=callerKey(caller);
  const full=live.filter(j=>j.state==='unpaid').length>=limits.mintUnpaid||live.filter(j=>j.state!=='unpaid').length>=limits.mintWaiting||mints.filter(j=>j.createdAt>day&&j.txid).length>=limits.mintPerDay;
  const many=who&&[...jobs.values()].filter(j=>j.caller===who&&j.createdAt>day&&!j.lane).length>=limits.perCallerDay;
  // The same mint asked for again (same token, amount, address and salt) is the same job, whatever the limits say; so a
  // salt is needed to find it before the tool runs. Without one the mint is new.
  const s=salt??randomBytes(8).toString('hex');
  if(salt==null&&(full||many))throw bad(many?'This connection sent many records today. Try again tomorrow, or mint from your own wallet.':'The relay is busy. Try again in a few minutes.',many?429:503);
  let made;
  try{made=await carrier.mintRecord((wallet!=null?[t.id,units,'k',wallet,s]:[t.id,units,k.kind==='sub'?1:0,hex(k.spend),hex(k.view),s]).join(':'));}
  catch(e){if(wallet!=null&&/not an owner key/.test(e.message))throw bad('wallet: that is not the owner key of an XMR20 wallet.');throw bad('The relay cannot make the mint record right now. Try again in a few minutes.',503);}
  if(wallet!=null&&made?.owner!==wallet)throw bad('The relay cannot make the mint record right now. Try again in a few minutes.',503);
  // What the tool made is the record that was asked for: this amount, this salt, and nothing after them.
  if(!(made&&typeof made.record==='string'&&/^[0-9a-f]{64}$/.test(made.asset||'')&&/^[0-9a-f]{64}$/.test(made.owner||'')&&made.record===`584f31fe${made.asset}${hex(leBytes(units,8))}${made.owner}${s}`))throw bad('The relay cannot make the mint record right now. Try again in a few minutes.',503);
  const id=createHash('sha256').update(Buffer.from(made.record,'hex')).digest('hex'),known=jobs.get(id);
  // A job found again is shown with the receiver as this caller named it: the record's owner key is public once it is
  // in a transaction, the Monero address behind an address owner is not, and asking by the key must not give it out.
  const shown=j=>{const v=mintView(j),{wallet:_,...rest}=v.mint;return {...v,mint:{...rest,to,...(wallet!=null?{wallet}:{})}};};
  if(known&&known.state!=='refused'&&known.state!=='stuck')return shown(known);
  // A mint the relay gave up on as stuck was paid for: it goes on from where it stood (its own transaction when it has
  // one, wherever that is by now), never as a new job with a new fee.
  if(known?.state==='stuck'){known.state=known.blob?'built':'queued';known.note=null;known.endedAt=null;known.createdHeight=tip;save(known);await mintStep(known,tip,now(),async()=>[]);return shown(known);}
  // One that was refused (its fee did not arrive in time) starts over, and a fee that arrived late counts for it.
  if(full||many)throw bad(many?'This connection sent many records today. Try again tomorrow, or mint from your own wallet.':'The relay is busy. Try again in a few minutes.',many?429:503);
  if(known)drop(known);
  // (No signer: the address the tokens go to did not ask for anything, so the mint does not count against its records.)
  const j={id,record:made.record,op:TOKEN_MINT,number:null,signer:null,caller:who,state:'unpaid',createdAt:now(),createdHeight:tip,mint:{token:t.id,amount:units.toString(),to,...(wallet!=null?{wallet}:{}),asset:made.asset,salt:s}};
  const index=payAddress(id,tip,j.createdAt),{address:payTo}=await carrier.address(index);
  j.pay={index,address:payTo,amount:fees.tokenMint.toString()};j.payBy=tip+limits.payBlocks;jobs.set(id,j);save(j);return mintView(j);}
 // One step of a mint job. The node alone says where its transaction is.
 async function mintStep(j,tip,t,received){
  const where=async()=>{const s=(await chain.txs([j.txid])).get(j.txid);return !s?'unknown':s.inPool?'pool':s.height;};
  const finish=height=>{j.state='done';j.doneHeight=height;j.endedAt=t;j.note=null;save(j);};
  if(j.state==='done'){
   // A block that held it can still be replaced for a while: if the node no longer shows it in a block, it goes out again.
   if(tip-j.doneHeight<limits.settleBlocks*2){const at=await where();if(!Number.isInteger(at)){j.state='sent';j.sentAt=0;j.sentHeight=tip;j.doneHeight=null;j.endedAt=null;save(j);}return;}
   if(t-j.endedAt>limits.keepMs)drop(j);return;}
  if(j.state==='refused'){if(t-j.endedAt>limits.keepMs)drop(j);return;}
  if(j.state==='stuck'){const at=j.txid?await where():null;if(Number.isInteger(at)&&tip-at+1>=limits.settleBlocks)finish(at);
   // (Given up on before it was ever built, by an earlier version: it is paid for, so it waits for a coin again.)
   else if(!j.txid&&j.paid){j.state='queued';j.endedAt=null;save(j);await send(j);}return;}
  if(j.state==='unpaid'){
   const got=paidFor(j,await received()),sum=got.reduce((a,p)=>a+BigInt(p.amount),0n);
   if(sum<BigInt(j.pay.amount)){if(tip>j.payBy){refuse(j,'The relay fee was not paid in time. Nothing was sent. A payment that arrives late counts when the same mint is asked for again with the same salt.');
     // Nothing at all was paid: the address can be given to someone else after a while.
     if(!got.length&&pay.addresses[j.pay.index]?.id===j.id){pay.addresses[j.pay.index].idleAt=t;write(payFile,pay);}}return;}
   const why=tokenOf?unmintable(tokenOf(j.mint.token),BigInt(j.mint.amount)):NO_MINTS;
   if(why){refuse(j,why);log({job:j.id,paidButRefused:got.map(p=>p.txid)});return;}
   j.state='queued';j.paid=got.map(outKey);j.createdHeight=tip;save(j);
   for(const p of got)used.add(outKey(p));pay.used=[...used];write(payFile,pay);await send(j);return;}
  // A mint that is paid for waits for a coin as long as it takes: it is never given up on before it was sent.
  if(j.state==='queued'){await send(j);return;}
  // A transaction that was built may be with the node, or in a block, already (it was sent once and given up on, or the
  // node did not show it for a moment): then it is not handed over again, it is watched.
  if(j.state==='built'){const at=j.txid&&j.sentAt!=null?await where():'unknown';
   if(at!=='unknown'){j.state='sent';j.sentAt=t;j.sentHeight=tip;j.note=null;save(j);if(Number.isInteger(at)&&tip-at+1>=limits.settleBlocks)finish(at);return;}
   await send(j);return;}
  if(j.state==='sent'){
   const at=await where();
   if(Number.isInteger(at)){if(tip-at+1>=limits.settleBlocks)finish(at);return;}
   if(tip-j.sentHeight>limits.stuckBlocks){j.state='stuck';j.endedAt=t;save(j);log({job:j.id,stuck:true});return;}
   // The node dropped the transaction, or a block that held it was replaced: the very same transaction goes out again.
   if(at==='unknown'&&t-j.sentAt>limits.resendMs){j.state='built';save(j);await send(j);}}}

 // After each reader pass: settle what reached a block, send again what did not, keep coins ready.
 async function tick(){
  const tip=reader.height,t=now();let asked=null,unknown=null,payments=null;
  // (One look at the relay's wallet per pass, also when it fails: then every unpaid job waits for the next pass.)
  let unseen=null;const received=async()=>{if(unseen)throw unseen;try{return payments??=((await carrier.status()).payments||[]);}catch(e){unseen=e;throw e;}};
  const missing=async txid=>{if(!asked?.has(txid)){const ids=[...new Set([...jobs.values()].filter(j=>j.state==='sent').map(j=>j.txid).concat([txid]))],got=await chain.txs(ids);asked=new Set(ids);unknown=new Set(ids.filter(i=>!got.has(i)));}return unknown.has(txid);};
  // Purchases first.
  for(const j of [...jobs.values()].sort((a,b)=>(b.op===OP.buy)-(a.op===OP.buy))){
   try{
    if(j.op===TOKEN_MINT){await mintStep(j,tip,t,received);continue;}
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
    // A collection or mint of someone who is not one of this relay's minters that the relay took before it had that
    // rule, and has not sent, is not carried either. One taken for the relay's fee (it has a payment address) is.
    if(!j.txid&&!j.pay&&(j.op===OP.mint||j.op===OP.collection)&&laneOf.size&&!laneOf.has(j.signer)){refuse(j,NOT_CARRIED);continue;}
    if(mine&&!mine.ok){
     // A purchase can be refused in its block only because replaced blocks put it before its own payment, and a claim by
     // a spent coin because they put it beside or before the spending transaction. If the rules would accept it now, or
     // once that transaction is in a block, it goes out again in a new transaction, a limited number of times; the
     // buyer's wallet may no longer hold what it takes to make the record again.
     if(!(j.op===OP.buy||spendClaim(j))||(j.again||0)>=limits.sendAgain){refuse(j,mine.error);continue;}
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
     // A claim by a spent coin is held while its spending transaction is not in a block below the newest one, for so long.
     // One whose transaction went out once already is given up on as stuck: that transaction may still be mined, and a
     // claim handed over again goes out as that same transaction.
     if(j.state==='held'&&j.op===OP.claim&&tip-j.createdHeight>limits.holdBlocks){
      if(j.blob){j.state='stuck';j.endedAt=t;save(j);log({job:j.id,stuck:true});continue;}
      refuse(j,'The transaction that spent the coin did not reach a block in time. Nothing was sent; once it is in a block, hand the claim over again.');continue;}
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
      if(!ready){j.state='held';j.createdHeight=tip;save(j);continue;}
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

 return {limits,fees:{collection:fees.collection.toString(),mint:fees.mint.toString(),...(fees.tokenMint?{tokenMint:fees.tokenMint.toString()}:{})},
  // Mints of open XMR20 tokens: the token list is the service's (it knows the opening block), handed over once.
  useTokens(lookup){tokenOf=lookup;},submitMint:o=>alone(()=>submitMint(o)),
  submit:(recordHex,o)=>alone(()=>submit(recordHex,o)),tick:()=>alone(tick),
  // What became of a record: a waiting job, or an accepted record in a block.
  status(id){const j=jobs.get(id),e=reader.entryById(id);
   if(e)return {id,state:'done',txid:e.txid,height:e.height,confirmations:reader.height-e.height+1,error:null};
   if(j&&j.op===TOKEN_MINT)return {...view(j),height:j.doneHeight??null,confirmations:j.doneHeight!=null?Math.max(0,reader.height-j.doneHeight+1):0};
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
