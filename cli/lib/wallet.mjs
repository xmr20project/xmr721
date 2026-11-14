// The xmr721 wallet: a Monero wallet of its own that inscribes on the XMR721 ledger.
//
// The wallet is a folder. The carrier tool (reader/carrier) keeps its keys there (carrier.keys.json) and its view of the
// chain; it builds the transactions that carry records and pays their network fee from the wallet's own coins. This
// file signs the records with the same keys: the wallet's address is the creator of what it inscribes.
//
// Everything the wallet builds is written down in journal.json, from before the tool is asked to build a transaction
// until that transaction is final:
//
//   building  the tool was asked to build; if the program stopped here, whether a transaction was built is not known
//   built     the transaction is kept, and no node was ever handed it without saying no
//   sent      it was handed to a node that took it or did not answer; from then on it may be anywhere
//   done      the wallet's own node shows it 10 blocks deep (and, for a record, the reader shows the record accepted)
//   refused   the same, and the reader shows the record refused by the ledger
//   dead      its coin was spent by another transaction, 10 blocks deep: it cannot get into a block any more
//
// A transaction that was sent cannot be taken back, by nobody: any node that has it can get it into a block, today or
// later. So the wallet never gives one up. It keeps the transaction and what it would take (an edition, an NFT) until
// the chain itself has settled it: in a block, or dead. It hands the same transaction to the node again when the node
// does not have it (`resend`) and never builds a second one for the same record. Only a transaction that was never
// sent can be removed (`forget`). What the wallet's own node shows decides all of this; a reader is asked only what
// the ledger made of a record whose transaction the node shows in a block.
//
// Settled is not let go of: the wallet keeps a settled transaction for another 100 blocks and looks at it every time.
// Should the chain be replaced 10 blocks deep or more, a final transaction whose block is gone, and a dead one whose
// coin is unspent again, count as sent once more.
//
// The wallet hands its transactions to the node itself. The node's answer is one of three: it took it; it did not
// take it (it says so, or turns the request away); or no answer came, and then whether it took it is not known and
// the transaction counts as sent.
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
//   journal.json        what the wallet built and what became of it, and notes for its owner
//   lock/               who is working on the wallet right now (cli/lib/lock.mjs)
import {createHash} from 'node:crypto';
import {existsSync,readFileSync,mkdirSync,chmodSync,openSync,writeSync,fsyncSync,closeSync,renameSync,unlinkSync,statSync} from 'node:fs';
import {join,extname,dirname} from 'node:path';
import {ed25519} from '@noble/curves/ed25519';
import {OP,NO_COLLECTION,MAX_RECORD,MAX_EDITIONS,encodeBody,decodeRecord,recordId,codeOf,renderText,nftLabel,attachSignature,canonical,formatXmr} from '../../rules/lib/records.mjs';
import {le,hex,unhex,encodeAddress,signWithSpendKey} from '../../rules/lib/monero.mjs';
import {openLock} from './lock.mjs';
import {clean} from './text.mjs';
export {clean,plain,ascii} from './text.mjs';

const G=ed25519.ExtendedPoint.BASE,L=ed25519.CURVE.n,HEX64=/^[0-9a-f]{64}$/,HEX=/^([0-9a-f]{2})+$/;
// A transaction is final 10 blocks deep. It is kept all the same until it is 100 blocks deep: should the chain be
// replaced that deep or deeper, the wallet still has it and can send it again. A reader more than a few blocks behind
// the wallet's node does not know the ledger as it is. A signature adds 65 bytes to a record.
export const FINAL=10,KEEP=100,BEHIND=3;
const SIGNATURE=65;
// What the ledger says of a record it holds already (rules/lib/ledger.mjs).
const DUPLICATE='This record is already on the ledger.';
const need=(ok,why)=>{if(!ok)throw Error(why);};
// A collection's name as the rules allow it: printable ASCII, no double quote, no space at either end.
const NAME=/^[!#-~]([ !#-~]{0,62}[!#-~])?$/;
// The ledgers this program knows by itself (docs/LAUNCH-SETTINGS.md). On another network the domain is given.
export const LEDGERS={mainnet:{domain:'ec7f7d26dba6725124df69417d43335c52e34557fc61c1d8d6b4736370e6ba1d'}};

// Content types of the rules (RULES.md section 9), by name and by file ending.
export const TYPES={png:1,jpeg:2,jpg:2,webp:3,gif:4,text:5,txt:5,md:5,json:6,mp4:7,art:8};
export function typeOf(file,given=null){
 if(given!=null&&given!==''){const g=String(given).toLowerCase(),n=Object.hasOwn(TYPES,g)?TYPES[g]:(/^[0-9]{1,3}$/.test(g)?Number(g):NaN);need(Number.isInteger(n)&&n>=1&&n<=255,'--type is a content type name (png, jpeg, webp, gif, text, json, mp4, art) or a number from 1 to 255.');return n;}
 const e=extname(String(file)).slice(1).toLowerCase();need(Object.hasOwn(TYPES,e),'The type of this file is not known from its name: give --type.');return TYPES[e];}

// The key images of a transaction's inputs, read from its bytes: version, unlock time, the number of inputs, then each
// input as its kind (2), amount, ring offsets and 32-byte key image. A key image names the coin an input spends.
// -> [] when the bytes are not that.
export function imagesOf(blob){
 try{
  const b=Buffer.from(String(blob),'hex');let p=0;
  const number=()=>{let v=0n;for(let shift=0n;;shift+=7n){if(p>=b.length||shift>63n)throw Error('short');const x=b[p++];v|=BigInt(x&127)<<shift;if(!(x&128))return v;}};
  number();number();const inputs=number();if(inputs<1n||inputs>16n)return [];
  const out=[];
  for(let i=0n;i<inputs;i++){
   if(b[p++]!==2)return [];number();const ring=number();if(ring<1n||ring>128n)return [];
   for(let k=0n;k<ring;k++)number();
   if(p+32>b.length)return [];out.push(b.subarray(p,p+32).toString('hex'));p+=32;}
  return out;}
 catch{return [];}}

// A file of the wallet, replaced whole, flushed, and readable by its owner only. Every byte is written before the file
// takes the place of the old one; when that fails (a full disk, a size limit), the old file stays as it was.
function put(file,text){
 const tmp=file+'.part',data=Buffer.from(text,'utf8');let fd=null;
 try{fd=openSync(tmp,'w',0o600);
  for(let at=0;at<data.length;){const n=writeSync(fd,data,at,data.length-at);if(!(n>0))throw Object.assign(Error('nothing written'),{code:'ENOSPC'});at+=n;}
  fsyncSync(fd);closeSync(fd);fd=null;renameSync(tmp,file);}
 catch(e){if(fd!==null)try{closeSync(fd);}catch{}try{unlinkSync(tmp);}catch{}
  throw Error(`${file} could not be written (${clean(e?.code||e?.message,60)}); it is as it was. Is the disk full?`);}
 try{const d=openSync(dirname(file),'r');try{fsyncSync(d);}finally{closeSync(d);}}catch{}}

// The wallet's keys as the carrier tool wrote them: its address and its signature.
export function keysOf(dir,network){
 const file=join(dir,'carrier.keys.json');need(existsSync(file),'There is no wallet in '+dir+'. Make one with: xmr721 wallet create');
 let k;try{k=JSON.parse(readFileSync(file,'utf8'));}catch{k={};}
 need(HEX64.test(k?.spend||'')&&HEX64.test(k?.view||''),'The wallet keys in '+file+' are not readable.');
 const s=le(unhex(k.spend)),v=le(unhex(k.view));need(s>0n&&s<L&&v>0n&&v<L,'The wallet keys are not keys.');
 const spend=G.multiply(s).toRawBytes(),view=G.multiply(v).toRawBytes(),key=unhex(k.spend);
 return {address:encodeAddress({spend,view,kind:'main',network}),sign:text=>signWithSpendKey(text,{spend,view},key)};}

// A reader's HTTP service. Every answer is checked for its shape before anything is done with it, no answer is read
// beyond `limit` bytes, and the reader is asked at the address given and nowhere it points to. Whatever is wrong with a
// reader is an error marked `reader`: a command that can go on without a reader does.
export function readerAt(url,{fetch:f=fetch,timeout=30000,limit=16<<20}={}){
 const base=String(url).replace(/\/$/,''),wrong=why=>Object.assign(Error(why),{reader:true}),need=(ok,why)=>{if(!ok)throw wrong(why);};
 const get=async path=>{
  const parts=[];let r,size=0;
  try{r=await f(base+path,{signal:AbortSignal.timeout(timeout),redirect:'manual'});
   if(r.body)for await(const part of r.body){size+=part.length;if(size>limit){try{await r.body.cancel();}catch{}throw wrong('The reader sent more than this program reads.');}parts.push(part);}}
  catch(e){if(e?.reader)throw e;throw wrong(`The reader at ${clean(base,120)} does not answer (${clean(e?.cause?.code||e?.cause?.errors?.[0]?.code||e?.cause?.message||e?.message,80)}).`);}
  need(!(r.status>=300&&r.status<400),`The reader at ${clean(base,120)} points to another address. Give --reader the address it answers at.`);
  let body={};try{body=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{body={};}
  if(r.status===404)return null;need(r.ok,`The reader answered ${r.status} for ${clean(path,80)}: ${clean(body?.error)}`);need(body&&typeof body==='object','The reader did not answer with JSON.');return body;};
 const int=(v,what,min=0,max=Number.MAX_SAFE_INTEGER)=>{need(Number.isSafeInteger(v)&&v>=min&&v<=max,'The reader gave no usable '+what+'.');return v;};
 const address=(v,what,network)=>{try{return canonical(v,network);}catch{throw wrong('The reader gave no usable '+what+'.');}};
 return {url:base,
  async info(network){const i=await get('/info');need(i&&typeof i.network==='string','The reader gave no settings.');
   need(i.network===network,`The reader is for ${clean(i.network,20)}, the wallet for ${network}.`);need(HEX64.test(i.domain||''),'The reader gives no ledger domain.');
   return {network,domain:i.domain,height:int(i.height,'height',1),mintFrom:i.mintFrom==null?null:int(i.mintFrom,'first mint block',1),openFrom:i.openFrom==null?null:int(i.openFrom,'opening block',1),
    minters:i.minters==null?null:(need(Array.isArray(i.minters),'The reader gave no usable minter list.'),i.minters.map(a=>address(a,'minter list',network)))};},
  async collection(id,network){const v=await get('/nft-collection/'+id);if(!v)return null;const c=v.collection||{};
   need(c.id===id&&typeof c.name==='string'&&NAME.test(c.name)&&Array.isArray(v.items),'The reader gave no usable collection.');
   const max=int(c.max,'number of editions',1,MAX_EDITIONS);need(v.items.length<=max,'The reader lists more NFTs than the collection has editions.');
   return {id,name:c.name,max,creator:address(c.creator,'creator',network),editions:v.items.map(t=>int(t?.edition,'edition',1,max))};},
  async nft(id,network){const v=await get('/nft/'+id);if(!v)return null;const x=v.nft||{};need(x.id===id,'The reader gave no usable NFT.');
   return {id,owner:x.owner==null?null:address(x.owner,'owner',network),burned:Boolean(x.burned),seq:int(x.seq,'move number'),listed:Boolean(x.lot),waiting:Array.isArray(v.waiting)&&v.waiting.length>0,
    collection:HEX64.test(x.collection||'')?x.collection:NO_COLLECTION,edition:int(x.edition??0,'edition',0,MAX_EDITIONS),collectionName:typeof x.collectionName==='string'&&NAME.test(x.collectionName)?x.collectionName:null};},
  // What the ledger made of the record a transaction carried: {ok, error, height, confirmations}, or null when the
  // reader has read no record in that transaction.
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

const STATES=new Set(['building','built','sent','done','refused','dead']);
const KEPT=new Set(['built','sent']);   // not settled by the chain: the transaction is kept, and holds what it would take
const SETTLED=new Set(['done','refused','dead']);
// carrier:  {init, status, carry, split} (cli/lib/tool.mjs, or a stand-in in tests).
// chain:    {info(), header(height), txs(ids), spent(images), send(blob)} of the wallet's node (reader/lib/chain.mjs).
// nettype:  what the node has to say it is (mainnet, stagenet); not checked when not given.
// reader:   readerAt(url), or null: then only what the node shows is known.
// domain:   the ledger's domain; on mainnet the one this program knows, which no option and no reader changes.
// ledgers:  the ledgers known by themselves (LEDGERS above; a test on a made-up chain with mainnet addresses gives none).
// lock:     who works on the wallet folder (cli/lib/lock.mjs); the command line shares it with the tool.
// inHand:   called with true when a transaction is in hand (being built or handed to the node) and with false when it
//           is written down again: a program that wants to stop does it outside.
// warn:     called with what the owner should know and no result says (a reader that cannot be asked).
export function openWallet({dir,carrier,reader=null,chain,network='mainnet',nettype=null,domain=null,ledgers=LEDGERS,lock=null,inHand=()=>{},warn=()=>{},now=()=>Date.now()}){
 const files={journal:join(dir,'journal.json'),state:join(dir,'carrier.state.json')},me=()=>keysOf(dir,network);
 const pinned=ledgers[network]?.domain??null;need(!(pinned&&domain&&domain!==pinned),`On ${network} the ledger is ${pinned}; another domain is another ledger.`);
 const want=pinned??domain,stamp=()=>new Date(now()).toISOString(),held=lock??openLock(dir);
 const locked=async work=>{const release=await held.acquire();try{return await work();}finally{release();}};

 // journal.json: read whole, written whole.
 function load(){
  if(!existsSync(files.journal))return {version:1,next:1,entries:[],notes:[]};
  let j;try{j=JSON.parse(readFileSync(files.journal,'utf8'));}catch{j=null;}
  const whole=e=>e&&typeof e==='object'&&typeof e.kind==='string'&&STATES.has(e.state)&&Number.isInteger(e.n)&&(e.state==='building'||HEX64.test(e.txid||''))&&(e.blob==null||(typeof e.blob==='string'&&HEX.test(e.blob)));
  need(j&&j.version===1&&Array.isArray(j.entries)&&j.entries.every(whole)&&Number.isInteger(j.next),
   `${files.journal} is damaged and nothing was changed. It holds the transactions this wallet keeps; without it the wallet no longer knows them.`);
  j.notes=Array.isArray(j.notes)?j.notes.filter(x=>typeof x==='string'):[];return j;}
 const save=j=>put(files.journal,JSON.stringify(j)+'\n');
 // A transaction that was being built when the program stopped: whether the tool built it is not known. It was never
 // sent (the tool sends nothing while it builds), so it is not kept. A note stays for the owner until a rescan has
 // read the coins anew.
 const LOST='A command stopped while a transaction was being built, and it is not known whether the tool built one. Nothing was sent. If the balance is lower than it should be, a coin is marked as used for it: xmr721 wallet rescan';
 function clear(j){
  if(!j.entries.some(e=>e.state==='building'))return;
  j.entries=j.entries.filter(e=>e.state!=='building');if(!j.notes.includes(LOST))j.notes.push(LOST);save(j);}

 // The ledger's settings as the reader states them, for the ledger this wallet inscribes on.
 async function settings(){
  need(reader,'This command asks a reader for the state of the ledger: give --reader <url>.');
  need(want,'No ledger is named: give --domain <hex>, the domain of the ledger to inscribe on.');
  const info=await reader.info(network);
  need(info.domain===want,`The reader is for another ledger (${info.domain}) than this wallet inscribes on (${want}).`);return info;}
 // The same, for a command that makes a record: the wallet's node has to answer, and the reader has to be about where
 // that node is.
 async function ledgerNow(){
  const info=await settings();let node;
  try{node=await chain.info();}catch(e){throw Error(`Your Monero node does not answer (${clean(e?.message,120)}). The wallet builds and sends through it, and checks the reader against it.`);}
  const tip=node?.height;need(Number.isSafeInteger(tip),'Your Monero node gave no height.');
  need(!nettype||node.nettype===nettype,`Your Monero node is a ${clean(node.nettype,20)} node; this wallet is for ${nettype}.`);
  need(tip-info.height<=BEHIND,`The reader is at block ${info.height} and your node at block ${tip}: the reader is behind and does not show the ledger as it is. Try again when it has caught up, or use another reader.`);return info;}
 // Where the node has a transaction: 'pool', a block height, 'unknown' (it has it nowhere), or null (it cannot be asked).
 async function atNode(txid){try{const t=(await chain.txs([txid])).get(txid);return t?(t.inPool?'pool':Number.isSafeInteger(t.height)?t.height:null):'unknown';}catch{return null;}}
 // Does the node show one of these coins spent by a transaction in a block? -> {spent, tip, hash}: the answer and the
 // newest block it holds for, or null when the node cannot say (also when a block came in while it was asked).
 async function look(images){
  if(!images.length||typeof chain.spent!=='function')return null;
  try{const a=await chain.info(),s=await chain.spent(images),b=await chain.info();
   if(!Number.isSafeInteger(a.height)||typeof a.hash!=='string'||a.height!==b.height||a.hash!==b.hash)return null;
   return {spent:s.some(x=>x===1),tip:a.height,hash:a.hash};}
  catch{return null;}}
 // Is this block still part of the chain? -> true, false, or null (the node cannot say).
 async function stillThere(height,hash){try{return (await chain.header(height)).hash===hash;}catch{return null;}}

 // Brings every transaction the wallet keeps up to date with the wallet's own node, and asks the reader what the ledger
 // made of the records whose transactions the node shows in a block. Nothing moves on a reader's word alone.
 // -> what is known of each entry right now: Map(entry -> {where, tip, depth, seen, asked}).
 async function refresh(j){
  const live=new Map(),watched=j.entries.filter(e=>KEPT.has(e.state)||(SETTLED.has(e.state)&&e.blob));
  if(!watched.length)return live;
  let tip=null;try{tip=(await chain.info()).height;}catch{tip=null;}if(!Number.isSafeInteger(tip))tip=null;
  // The reader, when there is one and it answers: asked about the entries made for its ledger only.
  let ledger=null;
  const deaf=e=>{if(!e?.reader)throw e;if(ledger!==false)warn(`${clean(e.message,200)} What follows is what your node alone shows.`);ledger=false;};
  const ask=async e=>{
   if(e.kind==='split'||!reader||ledger===false)return [null,false];
   if(ledger===null){try{ledger=(await reader.info(network)).domain;}catch(x){deaf(x);return [null,false];}}
   if(ledger!==(e.domain??want))return [null,false];
   try{return [await reader.entry(e.txid),true];}catch(x){deaf(x);return [null,false];}};
  for(const e of watched){
   const where=await atNode(e.txid);
   if(where===null||tip===null){live.set(e,{where:null,tip});continue;}
   const depth=Number.isInteger(where)?tip-where+1:0;
   if(e.state==='done'||e.state==='refused'){
    // Final, and still kept: let go of 100 blocks deep. If the block it was in is no longer part of the chain, it
    // counts as sent again.
    if(where===e.height){if(depth>=KEEP)delete e.blob;continue;}
    e.state='sent';delete e.height;delete e.error;delete e.other;}
   if(e.state==='dead'){
    // Dead, and still kept: let go of 100 blocks on. If the node has it after all, or no longer shows its coin spent
    // in a block, the chain was replaced and it counts as sent again.
    const now=where==='unknown'?await look(imagesOf(e.blob)):{spent:false};
    if(now===null)continue;
    if(now.spent){if(Number.isSafeInteger(e.deadAt)&&now.tip-e.deadAt>=KEEP)delete e.blob;continue;}
    e.state='sent';delete e.deadAt;}
   // A transaction the node has was sent, whatever was written down.
   if(where!=='unknown'){if(e.state==='built'){e.state='sent';e.sent??=stamp();}delete e.refusal;delete e.spentSeen;delete e.spentHash;}
   if(Number.isInteger(where)){
    if(e.kind==='split'){if(depth>=FINAL){Object.assign(e,{state:'done',height:where});if(depth>=KEEP)delete e.blob;}else live.set(e,{where,tip,depth});continue;}
    const [seen,asked]=await ask(e),view={where,tip,depth,seen:seen&&seen.height===where?seen:null,asked};
    if(depth>=FINAL&&view.seen&&seen.confirmations>=FINAL){
     // A record the ledger refused because it holds that very record already got there before, in someone else's
     // transaction: it is on the ledger.
     const other=!seen.ok&&seen.error===DUPLICATE;
     Object.assign(e,{state:seen.ok||other?'done':'refused',height:where});
     if(seen.ok||other)delete e.error;else e.error=seen.error;if(other)e.other=true;else delete e.other;
     if(depth>=KEEP)delete e.blob;continue;}
    live.set(e,view);continue;}
   // In no block and not with the node. When the node shows its coin spent by another transaction in a block, and the
   // block that was the newest at that sight is still part of the chain 10 blocks later, the spend is 10 blocks deep
   // and this transaction cannot get into a block.
   if(where==='unknown'){
    const now=await look(imagesOf(e.blob));
    if(now?.spent===true){
     const same=Number.isSafeInteger(e.spentSeen)&&typeof e.spentHash==='string'&&e.spentSeen<=now.tip?await stillThere(e.spentSeen,e.spentHash):false;
     if(same===false){e.spentSeen=now.tip;e.spentHash=now.hash;}
     else if(same===true&&now.tip-e.spentSeen>=FINAL){e.state='dead';e.deadAt=now.tip;delete e.spentSeen;delete e.spentHash;delete e.refusal;continue;}}
    else if(now?.spent===false){delete e.spentSeen;delete e.spentHash;}}
   live.set(e,{where,tip,depth});}
  save(j);return live;}
 const describe=(e,v)=>{
  if(e.state==='done')return e.kind==='split'?`done (block ${e.height})`:e.other?`on the ledger, carried by another transaction (this one, in block ${e.height}, was refused as a duplicate)`:`on the ledger (block ${e.height})`;
  if(e.state==='refused')return 'refused by the ledger: '+e.error;
  if(e.state==='dead')return 'its coin was spent by another transaction, 10 blocks deep: this one cannot get into a block any more, and what it carried is not on the ledger';
  const where=v?.where??null,again='"xmr721 wallet resend"';
  if(e.state==='built')return where===null?'built and not sent; your node cannot be asked right now'
   :`built and not sent${e.refusal?` (the node said no: ${e.refusal})`:''}: ${again} hands it to the node, "xmr721 wallet forget ${e.n}" gives it up`;
  if(where===null)return 'sent; your node cannot be asked right now';
  if(Number.isInteger(where)){
   const of=`${Math.min(v.depth,FINAL)} of ${FINAL} confirmations`;
   if(e.kind==='split')return `in block ${where} (${of})`;
   if(v.seen)return v.seen.ok?`on the ledger (block ${where}, ${of})`:`refused by the ledger (block ${where}, ${of}): ${v.seen.error}`;
   return v.asked?`in block ${where} (${of}); the reader has not read it yet`:`in block ${where} (${of}); no reader was asked what the ledger made of it`;}
  if(where==='pool')return 'waiting for a block';
  if(Number.isSafeInteger(e.spentSeen))return `the node does not have it, and its coin was spent by another transaction (seen at block ${e.spentSeen}). If that is still so at block ${e.spentSeen+FINAL}, this one cannot get into a block any more`;
  return e.refusal?`the node does not have this transaction and said no to it the last time (${e.refusal}): ${again} hands it over again`:`the node does not have this transaction: ${again} sends it again`;};
 const shown=(e,v)=>{const {blob,spentSeen,spentHash,deadAt,...rest}=e;return {...rest,state:describe(e,v)};};
 const hint=reason=>/double spend/.test(reason)?' Its coin is being spent by another transaction, which can be one of this wallet that is on its way.':'';

 // Hands a kept transaction to the node. -> {taken: true} the node has it; {taken: false, refused} the node answered
 // and did not take it; {taken: null, unknown} no answer came, and whether the node took it is not known.
 // It is written down as sent before the node is handed it: from that moment on nothing else is certain. Only an
 // answer from the node that it did not take it puts that back, for a transaction that was never sent before.
 async function deliver(j,e){
  need(e.blob,`The transaction of entry ${e.n} is not kept any more.`);
  // A node that does not answer, or is of another network, is handed nothing.
  let node;try{node=await chain.info();}catch(x){throw Error(`Your Monero node does not answer (${clean(x?.message,120)}), so nothing was handed to it. The transaction is kept as entry ${e.n}: "xmr721 wallet resend" sends it.`);}
  need(!nettype||node?.nettype===nettype,`Your Monero node is a ${clean(node?.nettype,20)} node and this wallet is for ${nettype}, so nothing was handed to it. The transaction is kept as entry ${e.n}.`);
  const was={state:e.state,sent:e.sent};inHand(true);
  try{
   Object.assign(e,{state:'sent',sent:stamp()});save(j);
   let answer=null,silence=null;
   try{answer=await chain.send(e.blob);if(!answer||typeof answer.ok!=='boolean'){answer=null;silence='an answer this program does not understand';}}catch(x){silence=clean(x?.message,160)||'no answer';}
   if(answer?.ok===true){delete e.refusal;save(j);return {taken:true};}
   // (A node that says no to a transaction it has already is no failure: an earlier send got through.)
   const where=await atNode(e.txid);
   if(where==='pool'||Number.isInteger(where)){delete e.refusal;save(j);return {taken:true};}
   if(answer){
    e.refusal=clean(answer.reason,160)||'no reason given';if(was.state==='built'){e.state='built';delete e.sent;}else if(was.sent)e.sent=was.sent;
    save(j);return {taken:false,refused:e.refusal};}
   save(j);return {taken:null,unknown:silence};}
  finally{inHand(false);}}
 // What the tool says of the wallet's coins, checked before it is used or shown.
 async function coins(){const s=await carrier.status();
  need(s&&/^[0-9]{1,30}$/.test(String(s.balance))&&[s.coins,s.ready,s.tip].every(n=>Number.isSafeInteger(n)&&n>=0),'The carrier tool did not answer with the wallet\'s coins.');return s;}
 // Builds one transaction with the tool and keeps it, written down before and after.
 async function build(j,entry,make){
  const s=await coins();
  need(s.ready>0,s.coins?'No coin of the wallet can pay right now. A coin can be spent 10 blocks after it arrived, and a coin smaller than the network fee cannot pay at all. Wait, or send the wallet more.':'The wallet has no coins. Send some XMR to '+me().address);
  const e={n:j.next++,...entry,state:'building',built:stamp()};inHand(true);
  try{j.entries.push(e);save(j);
   let t;
   try{t=await make();need(t&&HEX64.test(t.txid||'')&&typeof t.blob==='string'&&HEX.test(t.blob)&&/^[0-9]{1,20}$/.test(String(t.fee??'')),'The carrier tool did not answer with a transaction.');}
   catch(x){
    // The tool said no (it marks no coin then), or it did not answer (then nothing is known, and a note stays).
    j.entries=j.entries.filter(y=>y!==e);if(/did not answer/.test(String(x?.message))&&!j.notes.includes(LOST))j.notes.push(LOST);save(j);throw x;}
   Object.assign(e,{txid:t.txid,fee:formatXmr(BigInt(t.fee)),blob:t.blob,state:'built'});save(j);return e;}
  finally{inHand(false);}}
 // A newly built transaction goes to the node. Anything but "the node has it" is an error that says where things stand.
 async function first(j,e,notes=[]){
  const r=await deliver(j,e);
  if(r.taken===true)return {...shown(e,{where:'pool'}),...(notes.length?{notes}:{})};
  if(r.taken===false)throw Error(`The node said no to the transaction (${r.refused}), and nothing was sent.${hint(r.refused)} The transaction is kept as entry ${e.n}: "xmr721 wallet resend" hands it to the node again, "xmr721 wallet forget ${e.n}" gives it up.`);
  throw Error(`The node did not answer when the transaction was handed to it (${r.unknown}), so it is not known whether it took it. The transaction is kept as entry ${e.n} and counts as sent: "xmr721 wallet inscriptions" shows where it is, and "xmr721 wallet resend" sends it again when the node does not have it.`);}
 // What was asked for is a transaction the wallet keeps already: that one, handed to the node again when the node does
 // not have it. Nothing is built.
 async function same(j,e,live,notes=[]){
  let v=live.get(e),failed=null;
  if(KEPT.has(e.state)&&e.blob&&v?.where==='unknown'&&!Number.isSafeInteger(e.spentSeen)){
   const r=await deliver(j,e);
   if(r.taken===true)v={where:'pool'};else failed=r.taken===false?`the node said no: ${r.refused}.${hint(r.refused)}`:`the node did not answer (${r.unknown}); whether it took the transaction is not known`;}
  return {...shown(e,v),again:true,...(failed?{failed}:{}),...(notes.length?{notes}:{})};}

 // Signs the record and, unless it is a dry run, carries it in a transaction of the wallet and sends that.
 async function carry(j,kind,bodyBytes,ctx,{dryRun,extra={},notes=[],live=null}){
  const keys=me(),d=decodeRecord(bodyBytes,network,{sig:false}),text=renderText(d.op,d.body,bodyBytes,ctx),record=attachSignature(bodyBytes,keys.sign(text),ctx,network);
  need(record.length<=MAX_RECORD,`The record is ${record.length} bytes; a record is at most ${MAX_RECORD}. Make the content or the name smaller.`);
  const id=recordId(ctx.domain,bodyBytes),out={kind,id,code:codeOf(id),bytes:record.length,text,...extra,domain:ctx.domain};
  // (A dry run shows what would be signed, not the signed record: a signed record counts in whoever's transaction.)
  if(dryRun){const {domain:_,...rest}=out;return {...rest,dryRun:true,...(notes.length?{notes}:{})};}
  // The same record is never paid for twice: while its transaction is kept, that transaction is the record's. It is
  // looked for before the node is asked (one that turns out to be settled just now is still this record's) and after
  // (one that was settled may count as sent again).
  const before=j.entries.find(e=>e.id===id&&KEPT.has(e.state));
  live??=await refresh(j);
  const kept=before??j.entries.find(e=>e.id===id&&KEPT.has(e.state));
  if(kept)return same(j,kept,live,notes);
  return first(j,await build(j,out,()=>carrier.carry(hex(record))),notes);}

 // This wallet's own records of one kind, for one ledger, whose transactions the chain has not settled.
 const holding=(j,kind,ledger,match)=>j.entries.filter(e=>e.kind===kind&&KEPT.has(e.state)&&(e.domain??want)===ledger&&match(e));
 const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
 // May the wallet's coins be read anew? Reading them anew counts every coin as free that no block shows spent, also the
 // coins of transactions that are kept. -> notes for the owner.
 async function mayReadAnew(j){
  const live=await refresh(j),built=j.entries.filter(e=>e.state==='built'),sent=j.entries.filter(e=>e.state==='sent').map(e=>live.get(e));
  need(!built.length,`${built.length} transaction(s) of this wallet are built and not sent. Hand them to the node ("xmr721 wallet resend") or give them up ("xmr721 wallet forget <n>") first: they spend coins that would count as free.`);
  need(sent.every(v=>v&&v.where!==null),'Transactions of this wallet are on their way, and your Monero node cannot be asked where they are. Try again when it answers.');
  const waiting=sent.filter(v=>v.where==='pool').length,out=sent.filter(v=>v.where==='unknown').length;
  need(!waiting,`${waiting} transaction(s) of this wallet wait for a block. Try again when they are in one.`);
  return out?[`${out} transaction(s) of this wallet were sent and are in no block (see "xmr721 wallet inscriptions"). Their coins count as free again from now on. If one of them gets into a block after all, its coin is spent.`]:[];}
 const balanceOf=s=>({address:me().address,balance:formatXmr(BigInt(s.balance)),coins:s.coins,ready:s.ready,scanned:s.tip});
 // The newest block of the node, or null when it does not answer.
 const tipNow=async()=>{try{const t=(await chain.info()).height;return Number.isSafeInteger(t)?t:null;}catch{return null;}};
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
  // The coins are read anew from there at the next command.
  restore:height=>locked(async()=>{need(Number.isSafeInteger(height)&&height>=1,'The block to scan from is a whole number, 1 or more.');const j=load();clear(j);
   const tip=await tipNow();need(tip===null||height<=tip,`Block ${height} is above the newest block of your node (${tip}). A scan from there finds nothing.`);
   const notes=await mayReadAnew(j);
   put(join(dir,'wallet.json'),JSON.stringify({network,start:height})+'\n');if(existsSync(files.state))unlinkSync(files.state);return {address:me().address,start:height,...(notes.length?{notes}:{})};}),
  balance:()=>locked(async()=>{const j=load();clear(j);const s=await coins();await refresh(j);
   return {...balanceOf(s),kept:j.entries.filter(e=>KEPT.has(e.state)).length};}),
  // Makes n coins of the tool's split size from one larger coin.
  split:n=>locked(async()=>{need(Number.isInteger(n)&&n>=2&&n<=14,'Split into 2 to 14 coins.');
   const j=load();clear(j);return first(j,await build(j,{kind:'split',coins:n},()=>carrier.split(n)));}),
  // One NFT: in no collection, or an edition of one of the wallet's collections (the next free one unless named).
  inscribe:({content,type,name='',to=null,collection=null,edition=null,dryRun=false})=>locked(async()=>{
   const address=me().address,j=load();clear(j);
   // What can be seen to be wrong without asking anyone is said first.
   need(content&&content.length,'The file is empty.');
   const owner=to==null?address:canonical(to,network);
   need(collection==null||HEX64.test(collection),'--collection is a collection id (64 hex characters).');need(collection!=null||edition==null,'--edition goes with --collection.');
   need(edition==null||(Number.isInteger(edition)&&edition>=1&&edition<=MAX_EDITIONS),`An edition is 1 to ${MAX_EDITIONS}.`);
   const body=(col,ed)=>encodeBody(OP.mint,{collection:col,edition:ed,creator:address,to:owner===address?null:owner,name,type,content},network);
   need(body(collection??NO_COLLECTION,collection==null?0:(edition??MAX_EDITIONS)).length+SIGNATURE<=MAX_RECORD,`The record would be more than ${MAX_RECORD} bytes. Make the content or the name smaller.`);
   const info=await ledgerNow(),closed=mintingClosed(info,address);need(!closed,closed);
   let ctx={domain:info.domain,collectionName:null},col=NO_COLLECTION,ed=0,live=null;const digest=sha(content);
   if(collection!=null){
    const c=await reader.collection(collection,network);need(c,'This collection is not on the ledger yet. A new collection has to be in a block before its editions are minted.');
    need(c.creator===address,'This collection was made by '+c.creator+'; only its creator mints its editions.');
    live=await refresh(j);
    // The same file, name and owner again while its transaction is kept is that same edition, not a new one.
    const mine=holding(j,'mint',info.domain,e=>e.collection===collection),again=mine.find(e=>e.sha===digest&&e.name===name&&e.owner===owner&&e.type===type&&(edition==null||e.edition===edition));
    // Taken: what the reader shows, what this wallet knows it minted, and its own mints the chain has not settled.
    const own=j.entries.filter(e=>e.kind==='mint'&&e.collection===collection&&e.state==='done'&&(e.domain??want)===info.domain).map(e=>e.edition);
    const taken=new Set([...c.editions,...own,...mine.filter(e=>e!==again).map(e=>e.edition)]);
    if(again)edition=again.edition;
    else if(edition==null){for(let e=1;e<=c.max&&edition==null;e++)if(!taken.has(e))edition=e;need(edition!=null,'Every edition of this collection is minted, or a mint of this wallet for it is on its way.');}
    need(edition<=c.max,`An edition of this collection is 1 to ${c.max}.`);
    need(again||!taken.has(edition),`Edition ${edition} of this collection is minted already, or this wallet's mint of it is on its way.`);
    col=collection;ed=edition;ctx={domain:info.domain,collectionName:c.name};}
   const bodyBytes=body(col,ed),id=recordId(info.domain,bodyBytes);
   // A record that is on the ledger already counts once; a second one would be paid for and refused. The wallet knows
   // that of its own records, and the reader of everyone's.
   const once='This very NFT is on the ledger already. A record counts once: change the name or the content to inscribe again.';
   need(dryRun||!j.entries.some(e=>e.id===id&&e.state==='done'),once);
   need(dryRun||j.entries.some(e=>e.id===id&&KEPT.has(e.state))||!await reader.nft(id,network),once);
   return carry(j,'mint',bodyBytes,ctx,{dryRun,live,extra:{type,size:content.length,sha:digest,name,...(col!==NO_COLLECTION?{collection:col,edition:ed}:{}),owner}});}),
  collection:({name,max,dryRun=false})=>locked(async()=>{
   const address=me().address,j=load();clear(j);
   const made=()=>encodeBody(OP.collection,{creator:address,name,max},network);made();
   const info=await ledgerNow(),closed=mintingClosed(info,address);need(!closed,closed);
   const bodyBytes=made(),id=recordId(info.domain,bodyBytes);
   const once='This wallet made a collection of this name and size already. Two collections of one creator differ in name or size.';
   need(dryRun||!j.entries.some(e=>e.id===id&&e.state==='done'),once);
   need(dryRun||j.entries.some(e=>e.id===id&&KEPT.has(e.state))||!await reader.collection(id,network),once);
   return carry(j,'collection',bodyBytes,{domain:info.domain},{dryRun,extra:{name,max}});}),
  // Sends an NFT the wallet owns to another address.
  send:({nft,to,dryRun=false})=>locked(async()=>{
   const address=me().address,j=load();clear(j);
   need(HEX64.test(nft||''),'Give the NFT id (64 hex characters).');const target=canonical(to,network);need(target!==address,'That is this wallet\'s own address.');
   const info=await ledgerNow(),live=await refresh(j);
   // A send of this NFT to the same address that is kept goes out again as it is; a send elsewhere waits for it.
   const mine=holding(j,'send',info.domain,e=>e.nft===nft),again=mine.find(e=>e.to===target);
   if(again&&!dryRun)return same(j,again,live);
   need(dryRun||!mine.length,`This wallet's send of this NFT to ${mine[0]?.to} is on its way and cannot be taken back. When it is in a block the NFT is there.`);
   const x=await reader.nft(nft,network);need(x,'This NFT is not on the ledger (yet).');
   need(!x.burned,'This NFT was burned.');need(x.owner===address,'This NFT belongs to '+x.owner+', not to this wallet.');
   need(!x.listed,'This NFT is listed for sale; stop the listing first.');need(!x.waiting,'A record for this NFT is waiting for a block. Try again later.');
   const bodyBytes=encodeBody(OP.move,{reg:nft,seq:x.seq,from:address,to:target},network);
   return carry(j,'send',bodyBytes,{domain:info.domain,what:nftLabel(nft,{collection:x.collection,edition:x.edition},x.collectionName)},{dryRun,live,extra:{nft,to:target,seq:x.seq}});}),
  // Hands every kept transaction the node does not have to the node: one it never took, and one it no longer has. The
  // node alone decides which those are.
  resend:()=>locked(async()=>{const j=load();clear(j);const live=await refresh(j),out=[];
   for(const e of j.entries.filter(e=>KEPT.has(e.state))){const v=live.get(e);
    if(!e.blob){out.push({...shown(e,v),sentAgain:false,failed:'its transaction is not kept'});continue;}
    if(v?.where!=='unknown'||Number.isSafeInteger(e.spentSeen)){out.push({...shown(e,v),sentAgain:false});continue;}
    try{const r=await deliver(j,e);
     out.push(r.taken===true?{...shown(e,{where:'pool'}),sentAgain:true}:{...shown(e,{where:'unknown',tip:v.tip}),sentAgain:false,failed:r.taken===false?`the node said no: ${r.refused}.${hint(r.refused)}`:`the node did not answer (${r.unknown}); whether it took the transaction is not known`});}
    catch(x){out.push({...shown(e,v),sentAgain:false,failed:clean(x?.message,300)});}}
   return out;}),
  // Takes an entry off the list (by its number in `inscriptions`, its record id or its transaction id): a transaction
  // that was never sent, which frees what it held; or one the wallet has let go of, 100 blocks after the chain settled
  // it. Any other stays: a sent transaction cannot be taken back, and a settled one is kept for 100 blocks in case its
  // block is replaced.
  forget:ref=>locked(async()=>{const j=load();clear(j);const live=await refresh(j),e=j.entries.find(e=>String(e.n)===String(ref)||e.id===ref||e.txid===ref);
   need(e,'There is no such entry. See: xmr721 wallet inscriptions');
   const v=live.get(e),off=why=>{j.entries=j.entries.filter(x=>x!==e);save(j);return {...shown(e,v),forgotten:why};};
   const later=(from,what)=>`It can leave the list at block ${from+KEEP}: until then the wallet keeps it, ${what}.`;
   if(SETTLED.has(e.state)){
    if(!e.blob)return off('removed from the list; the chain has settled it for good');
    throw Error(e.state==='dead'?`This transaction cannot get into a block as the chain stands. ${later(e.deadAt,'in case the chain is replaced and it can again')}`
     :`This transaction is final in block ${e.height}. ${later(e.height-1,'to send it again should its block be replaced')}`);}
   need(v&&v.where!==null,'Your Monero node cannot be asked right now, so it is not known where this transaction is. Try again when it answers.');
   if(e.state==='built')return off('removed. It was never sent, so what it held is free. The coin it would have spent counts as used until: xmr721 wallet rescan');
   if(Number.isInteger(v.where)){
    need(v.depth>=KEEP,`This transaction is in block ${v.where}. ${later(v.where-1,'to send it again should its block be replaced')}`);
    return off(`removed from the list; its transaction is in block ${v.where} for good`);}
   throw Error(v.where==='pool'?'This transaction was sent and the node has it: it waits for a block. A sent transaction cannot be taken back.'
    :'This transaction was sent. A sent transaction cannot be taken back: a node that has it can still get it into a block, so the wallet keeps it and what it holds. It leaves the list by itself once it is in a block, or once its coin was spent by another transaction.');}),
  // Reads the wallet's coins anew from its start block. Coins the tool marked as used for transactions that never got
  // into a block are free again.
  rescan:()=>locked(async()=>{const j=load();clear(j);const notes=await mayReadAnew(j);
   if(existsSync(files.state))unlinkSync(files.state);const s=await coins();j.notes=[];save(j);
   return {...balanceOf(s),...(notes.length?{notes}:{})};}),
  // What this wallet built, each with what the node and the reader know of it now.
  inscriptions:()=>locked(async()=>{const j=load();clear(j);const live=await refresh(j);return j.entries.map(e=>shown(e,live.get(e)));}),
  // For the command line: the folder and its files are the owner's alone, also when they were copied from elsewhere.
  tighten(){try{chmodSync(dir,0o700);for(const f of ['carrier.keys.json','wallet.json','journal.json','carrier.state.json'])if(existsSync(join(dir,f))&&statSync(join(dir,f)).isFile())chmodSync(join(dir,f),0o600);}catch{}}};}
