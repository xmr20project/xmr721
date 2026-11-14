// The xmr721 wallet: a Monero wallet of its own that inscribes on the XMR721 ledger.
//
// The wallet is a folder. The carrier tool (reader/carrier) keeps its keys there (carrier.keys.json) and its view of the
// chain; it builds the transactions that carry records and pays their network fee from the wallet's own coins. This
// file signs the records with the same keys: the wallet's address is the creator of what it inscribes.
//
// Everything the wallet builds is written down in journal.json, from before the tool is asked to build a transaction
// until what it carried is final on the ledger, accepted or refused:
//
//   building  the tool was asked to build; if the program stopped here, whether a transaction was built is not known
//   built     the transaction is kept and never reached the node
//   sent      the node took it; it is kept all the same, because a node can drop a transaction again
//   gone      it was sent, and the user gave it up: it is not sent again, but it can still get into a block for as
//             long as nodes hold it, so what it would take (an edition, an NFT) is not given to anything else by
//             itself until then
//   done      the reader shows the record accepted and the wallet's own node shows its transaction 10 blocks deep
//   refused   the reader shows the record refused, its transaction 10 blocks deep
//
// A transaction that was sent cannot be taken back: once nodes have it, it gets into a block or is dropped by them
// after some days. So a kept transaction is sent again as it is (`resend`), never built a second time for the same
// record; `forget` removes one that never reached the node, and marks one that did as given up. Coins the tool marked
// as used for transactions that never got into a block come back with `rescan`. One command at a time works on a
// wallet folder (`lock`).
//
// A reader (reader/service.mjs, any one) is asked for the ledger's state before a record is made. What is signed is
// what the user asked for, for the ledger the wallet is set to (on mainnet, the one this program knows by its
// domain). The numbers a reader gives are in what is signed, though: the next free edition and an NFT's move number.
// A reader that lies about them makes the wallet pay for a record the ledger refuses, and such a record could count
// later, when the number it carries comes true. Nothing is made final on a reader's word alone: the wallet's own node
// has to show the transaction 10 blocks deep. Use a reader you run yourself to depend on no one.
//
//   wallet.json         {network, start}: the wallet's network and the block its scan starts at
//   carrier.keys.json   the keys (written by the carrier tool, readable by the owner only)
//   carrier.state.json  the tool's view of the chain and of its coins
//   journal.json        what the wallet built and what became of it, and notes for its owner
import {createHash,randomBytes} from 'node:crypto';
import {existsSync,readFileSync,mkdirSync,chmodSync,openSync,writeSync,fsyncSync,closeSync,renameSync,unlinkSync,linkSync,statSync} from 'node:fs';
import {join,extname,dirname} from 'node:path';
import {ed25519} from '@noble/curves/ed25519';
import {OP,NO_COLLECTION,MAX_RECORD,MAX_EDITIONS,encodeBody,decodeRecord,recordId,codeOf,renderText,nftLabel,attachSignature,canonical,formatXmr} from '../../rules/lib/records.mjs';
import {le,hex,unhex,encodeAddress,signWithSpendKey} from '../../rules/lib/monero.mjs';

const G=ed25519.ExtendedPoint.BASE,L=ed25519.CURVE.n,HEX64=/^[0-9a-f]{64}$/;
// A record is final 10 blocks deep. Nodes drop a transaction they could not get into a block after three days; a
// transaction that was given up is taken to be gone four days after it was last sent. A reader more than a few blocks
// behind the wallet's node does not know the ledger as it is.
export const FINAL=10,GONE_AFTER=4*86400000,BEHIND=3;
const need=(ok,why)=>{if(!ok)throw Error(why);};
// Text from a reader or a node, made safe to print: no control characters, none that turn the direction of the text or
// take no room, not endless. (The ranges are built from numbers so that this source holds none of those characters.)
const UNSAFE=new RegExp('['+[[0,31],[127,159],[0x61c,0x61c],[0x200b,0x200f],[0x2028,0x202e],[0x2060,0x2069],[0xfeff,0xfeff]].map(([a,b])=>String.fromCharCode(a)+'-'+String.fromCharCode(b)).join('')+']','g');
export const clean=(v,max=200)=>{let s;try{s=typeof v==='string'?v:v==null?'':typeof v==='object'?JSON.stringify(v):String(v);}catch{s='';}return String(s??'').replace(UNSAFE,' ').slice(0,max);};
// A collection's name as the rules allow it: printable ASCII, no double quote, no space at either end.
const NAME=/^[!#-~]([ !#-~]{0,62}[!#-~])?$/;
// The ledgers this program knows by itself (docs/LAUNCH-SETTINGS.md). On another network the domain is given.
export const LEDGERS={mainnet:{domain:'ec7f7d26dba6725124df69417d43335c52e34557fc61c1d8d6b4736370e6ba1d'}};

// Content types of the rules (RULES.md section 9), by name and by file ending.
export const TYPES={png:1,jpeg:2,jpg:2,webp:3,gif:4,text:5,txt:5,md:5,json:6,mp4:7,art:8};
export function typeOf(file,given=null){
 if(given!=null&&given!==''){const g=String(given).toLowerCase(),n=Object.hasOwn(TYPES,g)?TYPES[g]:(/^[0-9]{1,3}$/.test(g)?Number(g):NaN);need(Number.isInteger(n)&&n>=1&&n<=255,'--type is a content type name (png, jpeg, webp, gif, text, json, mp4, art) or a number from 1 to 255.');return n;}
 const e=extname(String(file)).slice(1).toLowerCase();need(Object.hasOwn(TYPES,e),'The type of this file is not known from its name: give --type.');return TYPES[e];}

// A file of the wallet, replaced whole, flushed, and readable by its owner only.
function put(file,text){
 const tmp=file+'.part',fd=openSync(tmp,'w',0o600);try{writeSync(fd,text);fsyncSync(fd);}finally{closeSync(fd);}renameSync(tmp,file);
 try{const d=openSync(dirname(file),'r');try{fsyncSync(d);}finally{closeSync(d);}}catch{}}

// The wallet's keys as the carrier tool wrote them: its address and its signature.
export function keysOf(dir,network){
 const file=join(dir,'carrier.keys.json');need(existsSync(file),'There is no wallet in '+dir+'. Make one with: xmr721 wallet create');
 let k;try{k=JSON.parse(readFileSync(file,'utf8'));}catch{k={};}
 need(HEX64.test(k?.spend||'')&&HEX64.test(k?.view||''),'The wallet keys in '+file+' are not readable.');
 const s=le(unhex(k.spend)),v=le(unhex(k.view));need(s>0n&&s<L&&v>0n&&v<L,'The wallet keys are not keys.');
 const spend=G.multiply(s).toRawBytes(),view=G.multiply(v).toRawBytes(),key=unhex(k.spend);
 return {address:encodeAddress({spend,view,kind:'main',network}),sign:text=>signWithSpendKey(text,{spend,view},key)};}

// A reader's HTTP service. Every answer is checked for its shape before anything is done with it, and no answer is
// read beyond `limit` bytes.
export function readerAt(url,{fetch:f=fetch,timeout=30000,limit=16<<20}={}){
 const base=String(url).replace(/\/$/,'');
 const get=async path=>{
  const parts=[];let r,size=0;
  try{r=await f(base+path,{signal:AbortSignal.timeout(timeout)});
   if(r.body)for await(const part of r.body){size+=part.length;if(size>limit){try{await r.body.cancel();}catch{}throw Object.assign(Error('The reader sent more than this program reads.'),{plain:true});}parts.push(part);}}
  catch(e){if(e?.plain)throw e;throw Object.assign(Error(`The reader at ${clean(base,120)} does not answer (${clean(e?.cause?.code||e?.cause?.errors?.[0]?.code||e?.cause?.message||e?.message,80)}).`),{unreachable:true});}
  let body={};try{body=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{body={};}
  if(r.status===404)return null;need(r.ok,`The reader answered ${r.status} for ${clean(path,80)}: ${clean(body?.error)}`);need(body&&typeof body==='object','The reader did not answer with JSON.');return body;};
 const int=(v,what,min=0,max=Number.MAX_SAFE_INTEGER)=>{need(Number.isSafeInteger(v)&&v>=min&&v<=max,'The reader gave no usable '+what+'.');return v;};
 const address=(v,what,network)=>{try{return canonical(v,network);}catch{throw Error('The reader gave no usable '+what+'.');}};
 return {url:base,
  async info(network){const i=await get('/info');need(i&&typeof i.network==='string','The reader gave no settings.');
   need(i.network===network,`The reader is for ${clean(i.network,20)}, the wallet for ${network}.`);need(HEX64.test(i.domain||''),'The reader gives no ledger domain.');
   return {network,domain:i.domain,height:int(i.height,'height',1),mintFrom:i.mintFrom==null?null:int(i.mintFrom,'first mint block',1),openFrom:i.openFrom==null?null:int(i.openFrom,'opening block',1),
    minters:Array.isArray(i.minters)?i.minters.map(a=>address(a,'minter list',network)):null};},
  async collection(id,network){const v=await get('/nft-collection/'+id);if(!v)return null;const c=v.collection||{};
   need(c.id===id&&typeof c.name==='string'&&NAME.test(c.name)&&Array.isArray(v.items),'The reader gave no usable collection.');
   const max=int(c.max,'number of editions',1,MAX_EDITIONS);need(v.items.length<=max,'The reader lists more NFTs than the collection has editions.');
   return {id,name:c.name,max,creator:address(c.creator,'creator',network),editions:v.items.map(t=>int(t?.edition,'edition',1,max))};},
  async nft(id,network){const v=await get('/nft/'+id);if(!v)return null;const x=v.nft||{};need(x.id===id,'The reader gave no usable NFT.');
   return {id,owner:x.owner==null?null:address(x.owner,'owner',network),burned:Boolean(x.burned),seq:int(x.seq,'move number'),listed:Boolean(x.lot),waiting:Array.isArray(v.waiting)&&v.waiting.length>0,
    collection:HEX64.test(x.collection||'')?x.collection:NO_COLLECTION,edition:int(x.edition??0,'edition',0,MAX_EDITIONS),collectionName:typeof x.collectionName==='string'&&NAME.test(x.collectionName)?x.collectionName:null};},
  // What became of the record a transaction carried: {ok, error, height, confirmations}, or null when the reader has not seen it.
  async entry(txid){const v=await get('/entry/'+txid);if(!v)return null;const e=v.entry||{};need(e.txid===txid&&typeof e.ok==='boolean','The reader gave no usable record entry.');
   return {ok:e.ok,id:HEX64.test(e.id||'')?e.id:null,error:e.ok?null:clean(e.error),height:int(e.height,'block',1),confirmations:int(v.confirmations,'confirmations',0)};}};}

// May this address make collections and mint in the next block? -> null, or the reason it may not.
export function mintingClosed(info,address){
 const next=info.height+1;
 if(info.mintFrom==null)return 'This ledger has no minting.';
 if(next<info.mintFrom)return `Minting starts at block ${info.mintFrom}; the ledger is at block ${info.height}.`;
 if(!Array.isArray(info.minters)||info.minters.includes(address))return null;
 if(info.openFrom!=null&&next>=info.openFrom)return null;
 return info.openFrom!=null?`Minting opens to everyone at block ${info.openFrom}; the ledger is at block ${info.height} (about ${Math.max(1,Math.round((info.openFrom-next)*2/60))} hours from now).`:'On this ledger only its listed minters make collections and mint.';}

const KEPT=new Set(['built','sent']);          // a transaction is kept, and sent again when the node does not have it
const HOLDS=new Set(['built','sent','gone']);  // a transaction may still get into a block, and holds what it would take
// carrier:  {init, status, carry, publish, split} (reader/lib/relay.mjs createCarrier, or a stand-in in tests).
// chain:    {info(), txs(ids)} of the wallet's node (reader/lib/chain.mjs).
// domain:   the ledger's domain; on mainnet the one this program knows, which no option and no reader changes.
// ledgers:  the ledgers known by themselves (LEDGERS above; a test on a made-up chain with mainnet addresses gives none).
// inHand:   called with true when a transaction is in hand (being built or handed to the node) and with false when it
//           is written down again: a program that wants to stop does it outside.
export function openWallet({dir,carrier,reader,chain,network='mainnet',domain=null,ledgers=LEDGERS,inHand=()=>{},now=()=>Date.now()}){
 const files={journal:join(dir,'journal.json'),lock:join(dir,'lock'),state:join(dir,'carrier.state.json')},me=()=>keysOf(dir,network);
 const pinned=ledgers[network]?.domain??null;need(!(pinned&&domain&&domain!==pinned),`On ${network} the ledger is ${pinned}; another domain is another ledger.`);
 const stamp=()=>new Date(now()).toISOString();

 // One command at a time. The lock names the process that holds it. A lock whose process is gone, or that is older
 // than any command runs, is left over: it is taken away by one process only (the one that manages to give it a
 // second name), so that two commands that find it at the same moment do not both go on.
 async function locked(work){
  const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e?.code==='EPERM';}};
  const token=randomBytes(8).toString('hex');
  for(let i=0;;i++){
   try{const fd=openSync(files.lock,'wx',0o600);try{writeSync(fd,JSON.stringify({pid:process.pid,token,since:stamp()}));}finally{closeSync(fd);}break;}
   catch(e){need(e?.code==='EEXIST',e?.code==='ENOENT'||e?.code==='ENOTDIR'?'There is no wallet folder at '+dir+'.':`The wallet folder ${dir} cannot be written (${e?.code}).`);
    let held=null,age=0;try{held=JSON.parse(readFileSync(files.lock,'utf8'));}catch{held=null;}try{age=now()-statSync(files.lock).mtimeMs;}catch{age=0;}
    const left=held&&Number.isInteger(held.pid)&&/^[0-9a-f]{16}$/.test(held.token||'')?(held.pid!==process.pid&&!alive(held.pid))||age>7*3600000:age>60000;
    need(left&&i<5,`Another xmr721 command is working on this wallet${held?.pid?` (process ${held.pid})`:''}. Wait until it is done. If none is running, remove the file ${files.lock}`);
    // Only the process that gives the left-over lock its second name takes it away; that name is of this one lock.
    const dead=files.lock+'.'+(held?.token||'empty')+'.left';
    try{linkSync(files.lock,dead);}catch(x){if(x?.code==='EEXIST'){try{if(now()-statSync(dead).mtimeMs>30000)unlinkSync(dead);}catch{}}await new Promise(r=>setTimeout(r,20+Math.floor(Math.random()*60)));continue;}
    try{const again=readFileSync(files.lock,'utf8');if(!held||JSON.parse(again).token===held.token)unlinkSync(files.lock);}catch{}
    try{unlinkSync(dead);}catch{}}}
  try{return await work();}finally{try{if(JSON.parse(readFileSync(files.lock,'utf8')).token===token)unlinkSync(files.lock);}catch{}}}

 // journal.json: read whole, written whole.
 function load(){
  if(!existsSync(files.journal))return {version:1,next:1,entries:[],notes:[]};
  let j;try{j=JSON.parse(readFileSync(files.journal,'utf8'));}catch{j=null;}
  need(j&&j.version===1&&Array.isArray(j.entries)&&j.entries.every(e=>e&&typeof e==='object'&&typeof e.kind==='string'&&typeof e.state==='string'&&Number.isInteger(e.n))&&Number.isInteger(j.next),
   `${files.journal} is damaged and nothing was changed. It lists what this wallet built; move it aside to go on without it.`);
  j.notes=Array.isArray(j.notes)?j.notes.filter(x=>typeof x==='string'):[];return j;}
 const save=j=>put(files.journal,JSON.stringify(j)+'\n');
 // A transaction that was being built when the program stopped: whether the tool built it is not known, and it is not
 // kept. What happened is written down for the owner until a rescan has read the coins anew.
 const LOST='A command stopped while a transaction was being built, and it is not known whether the tool built one. If the balance is lower than it should be, a coin is marked as used for it: xmr721 wallet rescan';
 function clear(j){
  if(!j.entries.some(e=>e.state==='building'))return;
  j.entries=j.entries.filter(e=>e.state!=='building');if(!j.notes.includes(LOST))j.notes.push(LOST);save(j);}

 // The ledger's settings as the reader states them, for the ledger this wallet inscribes on.
 async function settings(){
  const info=await reader.info(network),want=pinned??domain;
  need(want||network!=='mainnet','No ledger domain.');
  need(!want||info.domain===want,`The reader is for another ledger (${info.domain}) than this wallet inscribes on (${want}).`);return info;}
 // The same, for a command that makes a record: the reader has to be about where the wallet's own node is.
 async function ledgerNow(){
  const info=await settings();let tip=null;try{tip=(await chain.info()).height;}catch{tip=null;}
  need(tip===null||tip-info.height<=BEHIND,`The reader is at block ${info.height} and your node at block ${tip}: the reader is behind and does not show the ledger as it is. Try again when it has caught up, or use another reader.`);return info;}
 // Where the node has a transaction: 'pool', a block height, 'unknown' (it has it nowhere), or null (it cannot be asked).
 async function atNode(txid){try{const t=(await chain.txs([txid])).get(txid);return t?(t.inPool?'pool':t.height):'unknown';}catch{return null;}}
 const until=e=>Date.parse(e.sent||e.built||0)+GONE_AFTER,lives=e=>e.state!=='gone'||now()<until(e);

 // Brings every transaction that may still get into a block up to date with the reader and the node. Final is what the
 // reader shows 10 blocks deep and the wallet's own node, too. Without a reader (`alone`), the node alone is asked and
 // nothing is made final.
 async function refresh(j,{alone=false}={}){
  let tip=null,asked=!alone;const live=new Map();
  if(asked){try{await settings();}catch(e){if(!e?.unreachable)throw e;need(alone===null,e.message);asked=false;}}
  try{tip=(await chain.info()).height;}catch{tip=null;}
  for(const e of j.entries.filter(e=>HOLDS.has(e.state))){
   const seen=asked&&e.kind!=='split'?await reader.entry(e.txid):null,where=await atNode(e.txid),deep=Number.isInteger(where)&&tip!==null&&tip-where+1>=FINAL;
   if(deep&&e.kind==='split'){Object.assign(e,{state:'done',height:where});delete e.blob;continue;}
   if(deep&&seen&&seen.confirmations>=FINAL){Object.assign(e,{state:seen.ok?'done':'refused',height:seen.height,...(seen.ok?{}:{error:seen.error})});delete e.blob;continue;}
   // A transaction the node has, or that is in a block, did reach the network, whatever was known before.
   // (One that was given up and is in a block counts like any other again; its transaction is no longer kept.)
   if(e.state==='built'&&(seen||where==='pool'||Number.isInteger(where))){e.state='sent';e.sent??=stamp();}
   if(e.state==='gone'&&(seen||Number.isInteger(where))){e.wasGivenUp=true;e.state='sent';}
   // One that was given up and that no node can hold any more is over.
   if(e.state==='gone'&&!lives(e)&&where==='unknown'){j.entries=j.entries.filter(x=>x!==e);continue;}
   // A record that got onto the ledger in another transaction than this one (anyone can carry a signed record).
   let other=false;
   if(asked&&!seen&&where==='unknown'){
    if(e.kind==='mint')other=Boolean(await reader.nft(e.id,network));
    if(e.kind==='collection')other=Boolean(await reader.collection(e.id,network));
    if(e.kind==='send'){const x=await reader.nft(e.nft,network);other=Boolean(x&&x.owner===e.to&&x.seq>e.seq);}}
   if(other){Object.assign(e,{state:'done',other:true});delete e.blob;continue;}
   live.set(e,{seen,where,asked});}
  save(j);return live;}
 const describe=(e,v)=>{
  if(e.state==='done')return e.other?'on the ledger, carried by another transaction than this one':e.kind==='split'?`done (block ${e.height})`:`on the ledger (block ${e.height})`;
  if(e.state==='refused')return 'refused by the ledger: '+e.error;
  if(e.state==='built')return v&&v.where===null?'built; the node cannot be asked right now':'built and never sent: run "xmr721 wallet resend", or give it up with "xmr721 wallet forget '+e.n+'"';
  const given=e.wasGivenUp?' (it was given up, and got in all the same)':'';
  if(v?.seen)return (v.seen.ok?`on the ledger (block ${v.seen.height}, ${v.seen.confirmations} of ${FINAL} confirmations)`:`refused by the ledger (block ${v.seen.height}, ${v.seen.confirmations} of ${FINAL} confirmations): ${v.seen.error}`)+given;
  if(Number.isInteger(v?.where))return (e.kind==='split'?`in block ${v.where}`:v.asked?`in block ${v.where}; the reader has not read it yet`:`in block ${v.where}`)+given;
  if(e.state==='gone')return `given up. It was sent, so it can still get into a block until nodes drop it (about ${new Date(until(e)).toISOString().slice(0,10)})`+(v?.where==='pool'?'; the node has it now':'');
  if(v?.where==='pool')return 'waiting for a block';
  if(v?.where==='unknown')return 'the node no longer has this transaction: run "xmr721 wallet resend" to send it again';
  return 'sent; the node cannot be asked right now';};
 const shown=(e,v)=>{const {blob,...rest}=e;return {...rest,state:describe(e,v)};};

 // Hands a kept transaction to the node. It stays kept whatever the node says.
 async function deliver(j,e){
  let failure=null;inHand(true);
  try{try{await carrier.publish(e.blob);}catch(x){failure=x;}
   // (A node that refuses a transaction it has already is no failure: an earlier send got through.)
   const where=failure?await atNode(e.txid):'pool';
   if(failure&&(where===null||where==='unknown'))throw Error(`The transaction was built and the node did not take it (${clean(failure.message,160)}). It is kept: "xmr721 wallet resend" sends the same transaction again; nothing is paid twice.`);
   e.state='sent';e.sent=stamp();save(j);}
  finally{inHand(false);}}
 // Builds one transaction with the tool and keeps it, written down before and after.
 async function build(j,entry,make){
  const s=await carrier.status();
  need(s.ready>0,s.coins?'No coin of the wallet can pay right now. A coin can be spent 10 blocks after it arrived, and a coin smaller than the network fee cannot pay at all. Wait, or send the wallet more.':'The wallet has no coins. Send some XMR to '+me().address);
  const e={n:j.next++,...entry,state:'building',built:stamp()};inHand(true);
  try{j.entries.push(e);save(j);
   let t;try{t=await make();}
   catch(x){
    // The tool said no (it marks no coin then), or it did not answer (then nothing is known, and a note stays).
    j.entries=j.entries.filter(y=>y!==e);if(/did not answer/.test(String(x?.message))&&!j.notes.includes(LOST))j.notes.push(LOST);save(j);throw x;}
   Object.assign(e,{txid:t.txid,fee:formatXmr(BigInt(t.fee)),blob:t.blob,state:'built'});save(j);return e;}
  finally{inHand(false);}}

 // Signs the record and, unless it is a dry run, carries it in a transaction of the wallet and sends that.
 async function carry(j,kind,bodyBytes,ctx,{dryRun,extra={},notes=[]}){
  const keys=me(),d=decodeRecord(bodyBytes,network,{sig:false}),text=renderText(d.op,d.body,bodyBytes,ctx),record=attachSignature(bodyBytes,keys.sign(text),ctx,network);
  need(record.length<=MAX_RECORD,`The record is ${record.length} bytes; a record is at most ${MAX_RECORD}. Make the content or the name smaller.`);
  const id=recordId(ctx.domain,bodyBytes),out={kind,id,code:codeOf(id),bytes:record.length,text,...extra};
  // (A dry run shows what would be signed, not the signed record: a signed record counts in whoever's transaction.)
  if(dryRun)return {...out,dryRun:true,...(notes.length?{notes}:{})};
  const same=j.entries.filter(e=>e.id===id),kept=same.find(e=>KEPT.has(e.state)),gone=same.find(e=>e.state==='gone'&&lives(e));
  // The same record is never paid for twice. Its kept transaction goes out again as it is, unless the node has it or it
  // is in a block already; one that was given up may still get in, and a second one beside it would be refused.
  if(kept){let v=(await refresh(j)).get(kept);if(kept.blob&&(kept.state==='built'||(kept.state==='sent'&&v&&!v.seen&&v.where==='unknown'))){await deliver(j,kept);v={where:'pool'};}
   return {...shown(kept,v),again:true,...(notes.length?{notes}:{})};}
  need(!gone,`A transaction for this very record was sent and then given up (entry ${gone?.n}). It can still get into a block until about ${gone?new Date(until(gone)).toISOString().slice(0,10):''}; a second one would be paid for and refused. See: xmr721 wallet inscriptions`);
  const e=await build(j,out,()=>carrier.carry(hex(record)));await deliver(j,e);
  return {...shown(e,{where:'pool'}),...(notes.length?{notes}:{})};}

 // This wallet's own records of one kind that may still get into a block.
 const holding=(j,kind,match)=>j.entries.filter(e=>e.kind===kind&&HOLDS.has(e.state)&&lives(e)&&match(e));
 const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
 return {
  dir,
  get address(){return me().address;},
  // What the journal holds for the wallet's owner to read (a build that was cut short).
  notes(){try{return load().notes;}catch{return [];}},
  // A new wallet: its keys, and the block its scan starts at (the node's newest: a new wallet has received nothing yet).
  async create({height}){
   need(!existsSync(join(dir,'carrier.keys.json')),'There is a wallet in '+dir+' already.');
   need(Number.isSafeInteger(height)&&height>=1,'The node gave no height.');
   try{mkdirSync(dir,{recursive:true,mode:0o700});chmodSync(dir,0o700);}catch(e){throw Error(`A wallet folder cannot be made at ${dir} (${e?.code}).`);}
   return locked(async()=>{put(join(dir,'wallet.json'),JSON.stringify({network,start:height})+'\n');
    const made=await carrier.init(),address=me().address;
    need(made.address===address,'The carrier tool and this program see another address for the same keys.');
    return {address,start:height};});},
  // Sets the block the wallet's scan starts at: for a folder that has only its keys, or to scan from another block.
  // The coins are read anew from there at the next command, so nothing may be kept that spends them.
  restore:height=>locked(async()=>{need(Number.isSafeInteger(height)&&height>=1,'The block to scan from is a whole number.');const j=load();
   need(!j.entries.some(e=>HOLDS.has(e.state)&&lives(e)),'Transactions of this wallet may still get into a block. Wait until they are final before changing where its scan starts.');
   put(join(dir,'wallet.json'),JSON.stringify({network,start:height})+'\n');if(existsSync(files.state))unlinkSync(files.state);return {address:me().address,start:height};}),
  balance:()=>locked(async()=>{const j=load();clear(j);const s=await carrier.status();
   return {address:me().address,balance:formatXmr(BigInt(s.balance)),coins:s.coins,ready:s.ready,scanned:s.tip,kept:j.entries.filter(e=>KEPT.has(e.state)).length};}),
  // Makes n coins of the tool's split size from one larger coin.
  split:n=>locked(async()=>{need(Number.isInteger(n)&&n>=2&&n<=14,'Split into 2 to 14 coins.');
   const j=load();clear(j);const e=await build(j,{kind:'split',coins:n},()=>carrier.split(n));await deliver(j,e);return shown(e,{where:'pool'});}),
  // One NFT: in no collection, or an edition of one of the wallet's collections (the next free one unless named).
  inscribe:({content,type,name='',to=null,collection=null,edition=null,dryRun=false})=>locked(async()=>{
   const address=me().address,j=load(),notes=[];clear(j);
   // What can be seen to be wrong without asking anyone is said first.
   need(content&&content.length,'The file is empty.');
   const owner=to==null?address:canonical(to,network);
   need(collection==null||HEX64.test(collection),'--collection is a collection id (64 hex characters).');need(collection!=null||edition==null,'--edition goes with --collection.');
   need(edition==null||(Number.isInteger(edition)&&edition>=1&&edition<=MAX_EDITIONS),`An edition is 1 to ${MAX_EDITIONS}.`);
   const body=(col,ed)=>encodeBody(OP.mint,{collection:col,edition:ed,creator:address,to:owner===address?null:owner,name,type,content},network);
   need(body(collection??NO_COLLECTION,collection==null?0:(edition??MAX_EDITIONS)).length+64<=MAX_RECORD,`The record would be more than ${MAX_RECORD} bytes. Make the content or the name smaller.`);
   const info=await ledgerNow(),closed=mintingClosed(info,address);need(!closed,closed);
   let ctx={domain:info.domain,collectionName:null},col=NO_COLLECTION,ed=0;const digest=sha(content);
   if(collection!=null){
    const c=await reader.collection(collection,network);need(c,'This collection is not on the ledger yet. A new collection has to be in a block before its editions are minted.');
    need(c.creator===address,'This collection was made by '+c.creator+'; only its creator mints its editions.');
    await refresh(j);
    // The same file, name and owner again while its transaction may still get in is that same edition, not a new one.
    const mine=holding(j,'mint',e=>e.collection===collection),again=mine.find(e=>e.sha===digest&&e.name===name&&e.owner===owner&&e.type===type&&(edition==null||e.edition===edition));
    // Taken: what the reader shows, what this wallet knows it minted, and its own mints that may still get into a block.
    const own=j.entries.filter(e=>e.kind==='mint'&&e.collection===collection&&e.state==='done').map(e=>e.edition);
    const taken=new Set([...c.editions,...own,...mine.filter(e=>e!==again&&e.state!=='gone').map(e=>e.edition)]),given=new Set(mine.filter(e=>e!==again&&e.state==='gone').map(e=>e.edition));
    if(again)edition=again.edition;
    else if(edition==null){for(let e=1;e<=c.max&&edition==null;e++)if(!taken.has(e)&&!given.has(e))edition=e;need(edition!=null,'Every edition of this collection is minted, or a mint of this wallet for it may still get into a block.');}
    need(edition<=c.max,`An edition of this collection is 1 to ${c.max}.`);
    need(!taken.has(edition),`Edition ${edition} of this collection is minted already, or this wallet's mint of it is on its way.`);
    if(given.has(edition))notes.push(`A mint of edition ${edition} was sent and given up; it can still get into a block before this one, and then this one is refused.`);
    col=collection;ed=edition;ctx={domain:info.domain,collectionName:c.name};}
   const bodyBytes=body(col,ed),id=recordId(info.domain,bodyBytes);
   // A record that is on the ledger already counts once; a second one would be paid for and refused.
   need(dryRun||j.entries.some(e=>e.id===id&&KEPT.has(e.state))||!await reader.nft(id,network),'This very NFT is on the ledger already. A record counts once: change the name or the content to inscribe again.');
   return carry(j,'mint',bodyBytes,ctx,{dryRun,notes,extra:{type,size:content.length,sha:digest,name,...(col!==NO_COLLECTION?{collection:col,edition:ed}:{}),owner}});}),
  collection:({name,max,dryRun=false})=>locked(async()=>{
   const address=me().address,j=load();clear(j);
   const made=id=>encodeBody(OP.collection,{creator:address,name,max},network);made();
   const info=await ledgerNow(),closed=mintingClosed(info,address);need(!closed,closed);
   const bodyBytes=made(),id=recordId(info.domain,bodyBytes);
   need(dryRun||j.entries.some(e=>e.id===id&&KEPT.has(e.state))||!await reader.collection(id,network),'This wallet made a collection of this name and size already. Two collections of one creator differ in name or size.');
   return carry(j,'collection',bodyBytes,{domain:info.domain},{dryRun,extra:{name,max}});}),
  // Sends an NFT the wallet owns to another address.
  send:({nft,to,dryRun=false})=>locked(async()=>{
   const address=me().address,j=load(),notes=[];clear(j);
   need(HEX64.test(nft||''),'Give the NFT id (64 hex characters).');const target=canonical(to,network);need(target!==address,'That is this wallet\'s own address.');
   const info=await ledgerNow();await refresh(j);
   // A send of this NFT to the same address that is still kept goes out again as it is; another one waits for it.
   const mine=holding(j,'send',e=>e.nft===nft),kept=mine.filter(e=>e.state!=='gone'),again=kept.find(e=>e.to===target);
   if(again&&!dryRun){let v=(await refresh(j)).get(again);if(again.blob&&(again.state==='built'||(again.state==='sent'&&v&&!v.seen&&v.where==='unknown'))){await deliver(j,again);v={where:'pool'};}return {...shown(again,v),again:true};}
   need(dryRun||!kept.length,`This wallet's send of this NFT to ${kept[0]?.to} is on its way and cannot be taken back. When it is in a block the NFT is there.`);
   for(const g of mine.filter(e=>e.state==='gone'))notes.push(`A send of this NFT to ${g.to} was sent and given up; it can still get into a block before this one, and then the NFT is there and this send is refused.`);
   const x=await reader.nft(nft,network);need(x,'This NFT is not on the ledger (yet).');
   need(!x.burned,'This NFT was burned.');need(x.owner===address,'This NFT belongs to '+x.owner+', not to this wallet.');
   need(!x.listed,'This NFT is listed for sale; stop the listing first.');need(!x.waiting,'A record for this NFT is waiting for a block. Try again later.');
   const bodyBytes=encodeBody(OP.move,{reg:nft,seq:x.seq,from:address,to:target},network);
   return carry(j,'send',bodyBytes,{domain:info.domain,what:nftLabel(nft,{collection:x.collection,edition:x.edition},x.collectionName)},{dryRun,notes,extra:{nft,to:target,seq:x.seq}});}),
  // Sends again every kept transaction the node does not have: one it never took, and one it dropped. A reader is
  // asked when it answers; without one the node alone decides.
  resend:()=>locked(async()=>{const j=load();clear(j);const live=await refresh(j,{alone:null}),out=[];
   for(const e of j.entries.filter(e=>KEPT.has(e.state))){const v=live.get(e);
    if(!e.blob||(e.state==='sent'&&(v?.seen||v?.where==='pool'||Number.isInteger(v?.where)||v?.where===null))){out.push({...shown(e,v),sentAgain:false});continue;}
    try{await deliver(j,e);out.push({...shown(e,{where:'pool'}),sentAgain:true});}catch(x){out.push({...shown(e,v),sentAgain:false,failed:clean(x.message,300)});}}
   return out;}),
  // Gives up a transaction (by its number in `inscriptions`, its record id or its transaction id). One that never
  // reached the node is removed, and what it held is free. One that was sent cannot be taken back; with `sent` it is
  // marked as given up: not sent again, and treated as gone once nodes have dropped it. An entry that is final is
  // removed from the list.
  forget:(ref,{sent=false}={})=>locked(async()=>{const j=load();clear(j);const e=j.entries.find(e=>String(e.n)===String(ref)||e.id===ref||e.txid===ref);
   need(e,'There is no such entry. See: xmr721 wallet inscriptions');
   if(e.state==='done'||e.state==='refused'){j.entries=j.entries.filter(x=>x!==e);save(j);return {...shown(e),forgotten:'removed from the list; it is final on the ledger'};}
   need(e.state!=='gone','That one is given up already.');
   const where=await atNode(e.txid);need(where!==null,'The node cannot be asked right now, so it is not known whether it has this transaction. Try again.');
   if(e.state==='built'&&where==='unknown'){j.entries=j.entries.filter(x=>x!==e);save(j);return {...shown(e,{where}),forgotten:'removed; it never reached the node, and what it held is free'};}
   need(!Number.isInteger(where),`This transaction is in block ${where}. It cannot be given up.`);
   need(sent,`This transaction was sent${where==='pool'?' and the node has it':''}. It cannot be taken back: it gets into a block, or nodes drop it after about three days. To stop sending it again and treat it as gone after that, run: xmr721 wallet forget ${e.n} --sent`);
   e.state='gone';e.sent??=stamp();delete e.blob;save(j);return {...shown(e,{where}),forgotten:'marked as given up; it can still get into a block until nodes drop it'};}),
  // Reads the wallet's coins anew from its start block. Coins the tool marked as used for transactions that never got
  // into a block are free again. Not while any transaction of this wallet may still get into a block: it spends such
  // a coin.
  rescan:()=>locked(async()=>{const j=load();clear(j);await refresh(j,{alone:null});
   const kept=j.entries.filter(e=>HOLDS.has(e.state));need(!kept.length,`${kept.length} transaction(s) of this wallet may still get into a block and spend their coins. Rescan when they are final or gone. See: xmr721 wallet inscriptions`);
   if(existsSync(files.state))unlinkSync(files.state);const s=await carrier.status();j.notes=[];save(j);
   return {address:me().address,balance:formatXmr(BigInt(s.balance)),coins:s.coins,ready:s.ready,scanned:s.tip};}),
  // What this wallet built, each with what the reader and the node know of it now.
  inscriptions:()=>locked(async()=>{const j=load();clear(j);const live=await refresh(j,{alone:null});return j.entries.map(e=>shown(e,live.get(e)));}),
  // For the command line: the folder and its files are the owner's alone, also when they were copied from elsewhere.
  tighten(){try{chmodSync(dir,0o700);for(const f of ['carrier.keys.json','wallet.json','journal.json','carrier.state.json'])if(existsSync(join(dir,f))&&statSync(join(dir,f)).isFile())chmodSync(join(dir,f),0o600);}catch{}}};}
