// The xmr721 wallet: a Monero wallet of its own that inscribes on the XMR721 ledger.
//
// The wallet is a folder. The carrier tool (reader/carrier) keeps its keys there (carrier.keys.json) and its view of the
// chain; it builds the transactions that carry records and pays their network fee from the wallet's own coins. This
// file signs the records with the same keys: the wallet's address is the creator of what it inscribes.
//
// Everything the wallet builds is written down in journal.json, from before the tool is asked to build a transaction
// until what it carried is final on the ledger (10 blocks deep), accepted or refused:
//
//   building  the tool was asked to build; if the program stopped here, the transaction is not known (see `rescan`)
//   built     the transaction is kept and the node has not taken it
//   sent      the node took it; it is kept all the same, because a node can drop a transaction again
//   done      the reader shows the record accepted, 10 blocks deep (a split: the node shows it in a block that deep)
//   refused   the reader shows the record refused, 10 blocks deep
//
// A kept transaction is sent again as it is (`resend`), never built a second time for the same record. One that will
// never get into a block can be given up (`forget`), which frees what it held: the edition, the NFT, the right to
// inscribe that record again. Coins the tool marked as used for transactions that never got into a block come back
// with `rescan`. One command at a time works on a wallet folder (`lock`).
//
// A reader (reader/service.mjs, any one) is asked for the ledger's state before a record is made. What is signed is
// what the user asked for, for the ledger the wallet is set to (on mainnet, the one this program knows by its
// domain). The numbers a reader gives are in what is signed, though: the next free edition and an NFT's move number.
// A reader that lies about them makes the wallet pay for a record the ledger refuses, and such a record could count
// later, when the number it carries comes true. Use a reader you run yourself to depend on no one.
//
//   wallet.json         {network, start}: the wallet's network and the block its scan starts at
//   carrier.keys.json   the keys (written by the carrier tool, readable by the owner only)
//   carrier.state.json  the tool's view of the chain and of its coins
//   journal.json        what the wallet built and what became of it
import {createHash} from 'node:crypto';
import {existsSync,readFileSync,mkdirSync,chmodSync,openSync,writeSync,fsyncSync,closeSync,renameSync,unlinkSync,statSync} from 'node:fs';
import {join,extname,dirname} from 'node:path';
import {ed25519} from '@noble/curves/ed25519';
import {OP,NO_COLLECTION,MAX_RECORD,MAX_EDITIONS,encodeBody,decodeRecord,recordId,codeOf,renderText,nftLabel,attachSignature,canonical,formatXmr} from '../../rules/lib/records.mjs';
import {le,hex,unhex,encodeAddress,signWithSpendKey} from '../../rules/lib/monero.mjs';

const G=ed25519.ExtendedPoint.BASE,L=ed25519.CURVE.n,HEX64=/^[0-9a-f]{64}$/;
export const FINAL=10;
const need=(ok,why)=>{if(!ok)throw Error(why);};
// Text from a reader or a node, made safe to print: no control characters, no characters that turn the direction of
// the text, not endless. (The ranges are built from numbers so that this source holds none of those characters.)
const UNSAFE=new RegExp('['+[[0,31],[127,159],[0x200e,0x200f],[0x2028,0x202e],[0x2066,0x2069],[0xfeff,0xfeff]].map(([a,b])=>String.fromCharCode(a)+'-'+String.fromCharCode(b)).join('')+']','g');
export const clean=(v,max=200)=>String(v??'').replace(UNSAFE,' ').slice(0,max);
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
  let r;try{r=await f(base+path,{signal:AbortSignal.timeout(timeout)});}catch(e){throw Error(`The reader at ${clean(base,120)} does not answer (${clean(e?.cause?.code||e?.cause?.errors?.[0]?.code||e?.cause?.message||e?.message,80)}).`);}
  const parts=[];let size=0;
  if(r.body)for await(const part of r.body){size+=part.length;if(size>limit){try{await r.body.cancel();}catch{}throw Error('The reader sent more than this program reads.');}parts.push(part);}
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

const OPEN=new Set(['built','sent']);   // a transaction is kept and may still get into a block
// carrier: {init, status, carry, publish, split} (reader/lib/relay.mjs createCarrier, or a stand-in in tests).
// chain:   {info(), txs(ids)} of the wallet's node (reader/lib/chain.mjs).
// domain:  the ledger's domain; on mainnet the one this program knows, which no option and no reader changes.
// ledgers: the ledgers known by themselves (LEDGERS above; a test on a made-up chain with mainnet addresses gives none).
export function openWallet({dir,carrier,reader,chain,network='mainnet',domain=null,ledgers=LEDGERS,now=()=>Date.now()}){
 const files={journal:join(dir,'journal.json'),lock:join(dir,'lock'),state:join(dir,'carrier.state.json')},me=()=>keysOf(dir,network);
 const pinned=ledgers[network]?.domain??null;need(!(pinned&&domain&&domain!==pinned),`On ${network} the ledger is ${pinned}; another domain is another ledger.`);
 const stamp=()=>new Date(now()).toISOString();

 // One command at a time: the lock names the process that holds it, and a lock whose process is gone is taken over.
 async function locked(work){
  const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e?.code==='EPERM';}};
  for(let i=0;;i++){
   try{const fd=openSync(files.lock,'wx',0o600);try{writeSync(fd,JSON.stringify({pid:process.pid,since:stamp()}));}finally{closeSync(fd);}break;}
   catch(e){if(e?.code!=='EEXIST')throw e;
    let held=null;try{held=JSON.parse(readFileSync(files.lock,'utf8'));}catch{held=null;}
    // (A lock file that says nothing yet is another command's, just taken; one of a process that is gone, or one that
    // has said nothing for a minute, is left over.)
    const quiet=(()=>{try{return now()-statSync(files.lock).mtimeMs>60000;}catch{return true;}})();
    const gone=held&&Number.isInteger(held.pid)?held.pid!==process.pid&&!alive(held.pid):quiet;
    need(gone&&i<3,`Another xmr721 command is working on this wallet${held?.pid?` (process ${held.pid})`:''}. Wait until it is done.`);
    try{unlinkSync(files.lock);}catch{}}}
  try{return await work();}finally{try{unlinkSync(files.lock);}catch{}}}

 // journal.json: read whole, written whole.
 function load(){
  if(!existsSync(files.journal))return {version:1,next:1,entries:[]};
  let j;try{j=JSON.parse(readFileSync(files.journal,'utf8'));}catch{j=null;}
  need(j&&j.version===1&&Array.isArray(j.entries)&&j.entries.every(e=>e&&typeof e==='object'&&typeof e.kind==='string'&&typeof e.state==='string'&&Number.isInteger(e.n))&&Number.isInteger(j.next),
   `${files.journal} is damaged and nothing was changed. It lists what this wallet built; move it aside to go on without it.`);
  return j;}
 const save=j=>put(files.journal,JSON.stringify(j)+'\n');
 // A transaction that was being built when the program stopped: whether the tool built it is not known, and it is not kept.
 function clear(j,notes){
  const lost=j.entries.filter(e=>e.state==='building');if(!lost.length)return;
  j.entries=j.entries.filter(e=>e.state!=='building');save(j);
  notes.push(`An earlier command stopped while a transaction was being built (${lost.map(e=>e.kind).join(', ')}). If the balance is lower than it should be, run: xmr721 wallet rescan`);}

 // The ledger's settings as the reader states them, for the ledger this wallet inscribes on.
 async function settings(){
  const info=await reader.info(network),want=pinned??domain;
  need(want||network!=='mainnet','No ledger domain.');
  need(!want||info.domain===want,`The reader is for another ledger (${info.domain}) than this wallet inscribes on (${want}).`);return info;}
 // Where the node has a transaction: 'pool', a block height, 'unknown' (it has it nowhere), or null (it cannot be asked).
 async function atNode(txid){try{const t=(await chain.txs([txid])).get(txid);return t?(t.inPool?'pool':t.height):'unknown';}catch{return null;}}

 // Brings every kept transaction up to date with the reader and the node, and makes final what is 10 blocks deep.
 async function refresh(j){
  let tip=null;const live=new Map();
  for(const e of j.entries.filter(e=>OPEN.has(e.state))){
   const seen=e.kind==='split'?null:await reader.entry(e.txid),where=seen?seen.height:await atNode(e.txid);
   if(seen&&seen.confirmations>=FINAL){Object.assign(e,{state:seen.ok?'done':'refused',height:seen.height,...(seen.ok?{}:{error:seen.error})});delete e.blob;continue;}
   if(e.kind==='split'&&Number.isInteger(where)){tip??=(await chain.info()).height;if(tip-where+1>=FINAL){Object.assign(e,{state:'done',height:where});delete e.blob;continue;}}
   // A record that got onto the ledger in another transaction than this one (anyone can carry a signed record).
   let other=false;
   if(!seen&&where==='unknown'&&e.kind==='mint')other=Boolean(await reader.nft(e.id,network));
   if(!seen&&where==='unknown'&&e.kind==='collection')other=Boolean(await reader.collection(e.id,network));
   live.set(e,{seen,where,other});}
  save(j);return live;}
 const describe=(e,v)=>{
  if(e.state==='done')return e.kind==='split'?`done (block ${e.height})`:`on the ledger (block ${e.height})`;
  if(e.state==='refused')return 'refused by the ledger: '+e.error;
  if(e.state==='built')return 'built and not with the node: run "xmr721 wallet resend"';
  if(v?.seen)return v.seen.ok?`on the ledger (block ${v.seen.height}, ${v.seen.confirmations} of ${FINAL} confirmations)`:`refused by the ledger (block ${v.seen.height}, ${v.seen.confirmations} of ${FINAL} confirmations): ${v.seen.error}`;
  if(v?.other)return 'on the ledger, carried by another transaction than this one';
  if(v?.where==='pool')return 'waiting for a block';
  if(Number.isInteger(v?.where))return e.kind==='split'?`in block ${v.where}`:`in block ${v.where}; the reader has not read it yet`;
  if(v?.where==='unknown')return `the node no longer has this transaction: run "xmr721 wallet resend" to send it again, or "xmr721 wallet forget ${e.n}" to give it up`;
  return 'sent; the node cannot be asked right now';};
 const shown=(e,v)=>{const {blob,...rest}=e;return {...rest,state:describe(e,v)};};

 // Hands a kept transaction to the node. It stays kept whatever the node says.
 async function deliver(j,e){
  let failure=null;try{await carrier.publish(e.blob);}catch(x){failure=x;}
  // (A node that refuses a transaction it has already is no failure: an earlier send got through.)
  const where=failure?await atNode(e.txid):'pool';
  if(failure&&(where===null||where==='unknown'))throw Error(`The transaction was built and the node did not take it (${clean(failure.message,160)}). It is kept: run "xmr721 wallet resend" to send the same transaction again, or "xmr721 wallet forget ${e.n}" to give it up. Nothing is paid twice.`);
  e.state='sent';e.sent??=stamp();save(j);}
 // Builds one transaction with the tool and keeps it, written down before and after.
 async function build(j,entry,make){
  const s=await carrier.status();
  need(s.ready>0,s.coins?'No coin of the wallet can pay right now. A coin can be spent 10 blocks after it arrived, and a coin smaller than the network fee cannot pay at all. Wait, or send the wallet more.':'The wallet has no coins. Send some XMR to '+me().address);
  const e={n:j.next++,...entry,state:'building',built:stamp()};j.entries.push(e);save(j);
  let t;try{t=await make();}catch(x){j.entries=j.entries.filter(y=>y!==e);save(j);throw x;}
  Object.assign(e,{txid:t.txid,fee:formatXmr(BigInt(t.fee)),blob:t.blob,state:'built'});save(j);return e;}

 // Signs the record and, unless it is a dry run, carries it in a transaction of the wallet and sends that.
 async function carry(j,notes,kind,bodyBytes,ctx,{dryRun,extra={}}){
  const keys=me(),d=decodeRecord(bodyBytes,network,{sig:false}),text=renderText(d.op,d.body,bodyBytes,ctx),record=attachSignature(bodyBytes,keys.sign(text),ctx,network);
  need(record.length<=MAX_RECORD,`The record is ${record.length} bytes; a record is at most ${MAX_RECORD}. Make the content or the name smaller.`);
  const id=recordId(ctx.domain,bodyBytes),out={kind,id,code:codeOf(id),bytes:record.length,text,...extra};
  // (A dry run shows what would be signed, not the signed record: a signed record counts in whoever's transaction.)
  if(dryRun)return {...out,dryRun:true};
  const same=j.entries.filter(e=>e.id===id),done=same.find(e=>e.state==='done'),kept=same.find(e=>OPEN.has(e.state));
  need(!done,`This wallet inscribed this very record before (transaction ${done?.txid}). A record counts once: change the name or the content to inscribe again.`);
  // The same record is never paid for twice: its kept transaction goes out again as it is, unless the node has it or
  // it is in a block already.
  if(kept){let v=(await refresh(j)).get(kept);if(OPEN.has(kept.state)&&!v?.seen&&!v?.other&&(v?.where==='unknown'||v?.where==null)){await deliver(j,kept);v={where:'pool'};}
   return {...shown(kept,v),again:true,...(notes.length?{notes}:{})};}
  const e=await build(j,out,()=>carrier.carry(hex(record)));await deliver(j,e);
  return {...shown(e,{where:'pool'}),...(notes.length?{notes}:{})};}

 // This wallet's own records of one kind that may still get into a block.
 const open=(j,kind,match)=>j.entries.filter(e=>e.kind===kind&&OPEN.has(e.state)&&match(e));
 const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
 return {
  dir,
  get address(){return me().address;},
  // A new wallet: its keys, and the block its scan starts at (the node's newest: a new wallet has received nothing yet).
  async create({height}){
   need(!existsSync(join(dir,'carrier.keys.json')),'There is a wallet in '+dir+' already.');
   need(Number.isSafeInteger(height)&&height>=1,'The node gave no height.');
   mkdirSync(dir,{recursive:true,mode:0o700});chmodSync(dir,0o700);
   return locked(async()=>{put(join(dir,'wallet.json'),JSON.stringify({network,start:height})+'\n');
    const made=await carrier.init(),address=me().address;
    need(made.address===address,'The carrier tool and this program see another address for the same keys.');
    return {address,start:height};});},
  balance:()=>locked(async()=>{const j=load(),s=await carrier.status();
   return {address:me().address,balance:formatXmr(BigInt(s.balance)),coins:s.coins,ready:s.ready,scanned:s.tip,kept:j.entries.filter(e=>OPEN.has(e.state)).length};}),
  // Makes n coins of the tool's split size from one larger coin.
  split:n=>locked(async()=>{need(Number.isInteger(n)&&n>=2&&n<=14,'Split into 2 to 14 coins.');
   const j=load(),notes=[];clear(j,notes);const e=await build(j,{kind:'split',coins:n},()=>carrier.split(n));await deliver(j,e);return {...shown(e,{where:'pool'}),...(notes.length?{notes}:{})};}),
  // One NFT: in no collection, or an edition of one of the wallet's collections (the next free one unless named).
  inscribe:({content,type,name='',to=null,collection=null,edition=null,dryRun=false})=>locked(async()=>{
   const address=me().address,j=load(),notes=[];clear(j,notes);
   need(content&&content.length,'The file is empty.');
   const owner=to==null?address:canonical(to,network);
   need(collection==null||HEX64.test(collection),'--collection is a collection id (64 hex characters).');need(collection!=null||edition==null,'--edition goes with --collection.');
   const info=await settings(),closed=mintingClosed(info,address);need(!closed,closed);
   let ctx={domain:info.domain,collectionName:null},col=NO_COLLECTION,ed=0;const digest=sha(content);
   if(collection!=null){
    const c=await reader.collection(collection,network);need(c,'This collection is not on the ledger yet. A new collection has to be in a block before its editions are minted.');
    need(c.creator===address,'This collection was made by '+c.creator+'; only its creator mints its editions.');
    await refresh(j);
    // The same file, name and owner again while its transaction is still kept is that same edition, not a new one.
    const mine=open(j,'mint',e=>e.collection===collection),again=mine.find(e=>e.sha===digest&&e.name===name&&e.owner===owner&&e.type===type&&(edition==null||e.edition===edition));
    // Editions of this wallet's own mints that may still get into a block are taken too.
    const taken=new Set([...c.editions,...mine.filter(e=>e!==again).map(e=>e.edition)]);
    if(again)edition=again.edition;
    else if(edition==null){for(let e=1;e<=c.max&&edition==null;e++)if(!taken.has(e))edition=e;need(edition!=null,'Every edition of this collection is minted, or this wallet\'s mint of it is on its way.');}
    need(Number.isInteger(edition)&&edition>=1&&edition<=c.max,`An edition of this collection is 1 to ${c.max}.`);
    need(!taken.has(edition),`Edition ${edition} of this collection is minted already, or this wallet's mint of it is on its way.`);
    col=collection;ed=edition;ctx={domain:info.domain,collectionName:c.name};}
   const bodyBytes=encodeBody(OP.mint,{collection:col,edition:ed,creator:address,to:owner===address?null:owner,name,type,content},network),id=recordId(info.domain,bodyBytes);
   // A record that is on the ledger already counts once; a second one would be paid for and refused.
   need(dryRun||j.entries.some(e=>e.id===id&&OPEN.has(e.state))||!await reader.nft(id,network),'This very NFT is on the ledger already. A record counts once: change the name or the content to inscribe again.');
   return carry(j,notes,'mint',bodyBytes,ctx,{dryRun,extra:{type,size:content.length,sha:digest,name,...(col!==NO_COLLECTION?{collection:col,edition:ed}:{}),owner}});}),
  collection:({name,max,dryRun=false})=>locked(async()=>{
   const address=me().address,j=load(),notes=[];clear(j,notes);
   const info=await settings(),closed=mintingClosed(info,address);need(!closed,closed);
   const bodyBytes=encodeBody(OP.collection,{creator:address,name,max},network),id=recordId(info.domain,bodyBytes);
   need(dryRun||j.entries.some(e=>e.id===id&&OPEN.has(e.state))||!await reader.collection(id,network),'This wallet made a collection of this name and size already. Two collections of one creator differ in name or size.');
   return carry(j,notes,'collection',bodyBytes,{domain:info.domain},{dryRun,extra:{name,max}});}),
  // Sends an NFT the wallet owns to another address.
  send:({nft,to,dryRun=false})=>locked(async()=>{
   const address=me().address,j=load(),notes=[];clear(j,notes);
   need(HEX64.test(nft||''),'Give the NFT id (64 hex characters).');const target=canonical(to,network);need(target!==address,'That is this wallet\'s own address.');
   const info=await settings();await refresh(j);
   // A send of this NFT to the same address that is still kept goes out again as it is; another one waits for it.
   const mine=open(j,'send',e=>e.nft===nft),again=mine.find(e=>e.to===target);
   if(again&&!dryRun){let v=(await refresh(j)).get(again);if(OPEN.has(again.state)&&!v?.seen&&(v?.where==='unknown'||v?.where==null)){await deliver(j,again);v={where:'pool'};}return {...shown(again,v),again:true};}
   need(dryRun||!mine.length,`This wallet's send of this NFT to ${mine[0]?.to} is on its way. Wait until it is in a block, or give it up with: xmr721 wallet forget ${mine[0]?.n}`);
   const x=await reader.nft(nft,network);need(x,'This NFT is not on the ledger (yet).');
   need(!x.burned,'This NFT was burned.');need(x.owner===address,'This NFT belongs to '+x.owner+', not to this wallet.');
   need(!x.listed,'This NFT is listed for sale; stop the listing first.');need(!x.waiting,'A record for this NFT is waiting for a block. Try again later.');
   const bodyBytes=encodeBody(OP.move,{reg:nft,seq:x.seq,from:address,to:target},network);
   return carry(j,notes,'send',bodyBytes,{domain:info.domain,what:nftLabel(nft,{collection:x.collection,edition:x.edition},x.collectionName)},{dryRun,extra:{nft,to:target}});}),
  // Sends again every kept transaction the node does not have: one it never took, and one it dropped.
  resend:()=>locked(async()=>{const j=load(),notes=[];clear(j,notes);const live=await refresh(j),out=[];
   for(const e of j.entries.filter(e=>OPEN.has(e.state))){const v=live.get(e);
    if(v?.seen||v?.other||Number.isInteger(v?.where)||v?.where==='pool'){out.push({...shown(e,v),sentAgain:false});continue;}
    try{await deliver(j,e);out.push({...shown(e,{where:'pool'}),sentAgain:true});}catch(x){out.push({...shown(e,v),sentAgain:false,failed:clean(x.message,300)});}}
   return out;}),
  // Gives up a kept transaction (by its number in `inscriptions`, its record id or its transaction id): it will not be
  // sent again, and what it held is free. The transaction itself, if a node still has it, can still get into a block.
  forget:ref=>locked(async()=>{const j=load(),e=j.entries.find(e=>String(e.n)===String(ref)||e.id===ref||e.txid===ref);
   need(e,'There is no such entry. See: xmr721 wallet inscriptions');need(e.state!=='done','That one is final on the ledger; there is nothing to give up.');
   j.entries=j.entries.filter(x=>x!==e);save(j);return shown(e);}),
  // Reads the wallet's coins anew from its start block. Coins the tool marked as used for transactions that never got
  // into a block are free again. Not while transactions are kept: they spend such coins and may still get in.
  rescan:()=>locked(async()=>{const j=load(),notes=[];clear(j,notes);await refresh(j);
   const kept=j.entries.filter(e=>OPEN.has(e.state));need(!kept.length,`${kept.length} kept transaction(s) may still get into a block and spend their coins. Wait until they are final, or give them up (xmr721 wallet forget <n>), then rescan.`);
   if(existsSync(files.state))unlinkSync(files.state);const s=await carrier.status();
   return {address:me().address,balance:formatXmr(BigInt(s.balance)),coins:s.coins,ready:s.ready,scanned:s.tip};}),
  // What this wallet built, each with what the reader and the node know of it now.
  inscriptions:()=>locked(async()=>{const j=load(),notes=[];clear(j,notes);const live=await refresh(j);return j.entries.map(e=>shown(e,live.get(e)));}),
  // For the command line: the folder and its files are the owner's alone, also when they were copied from elsewhere.
  tighten(){try{chmodSync(dir,0o700);for(const f of ['carrier.keys.json','wallet.json','journal.json','carrier.state.json'])if(existsSync(join(dir,f))&&statSync(join(dir,f)).isFile())chmodSync(join(dir,f),0o600);}catch{}}};}
