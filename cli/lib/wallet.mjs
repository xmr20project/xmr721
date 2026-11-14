// The xmr721 wallet: a Monero wallet of its own that inscribes on the XMR721 ledger.
//
// The wallet is a folder. The carrier tool (reader/carrier) keeps its keys there (carrier.keys.json) and its view of the
// chain; it builds the transactions that carry records and pays their network fee from the wallet's own coins. This
// file signs the records with the same keys: the wallet's address is the creator of what it inscribes.
//
// A reader (reader/service.mjs, any one) is asked for the ledger's state before a record is made. What a reader says
// never changes what is signed: the record is made from what the user asked for, for the ledger the wallet is set to
// (on mainnet, the one ledger this program knows by its domain). A reader that lies can at most make the wallet pay
// the network fee of a record that the ledger then refuses.
//
// A transaction is kept from the moment it is built until the node has it (pending.json): a send that failed is sent
// again as the same transaction, never built a second time, so no coin is lost and nothing is paid twice.
//
//   wallet.json            {network, start}: the wallet's network and the block its scan starts at
//   carrier.keys.json      the keys (written by the carrier tool, readable by the owner only)
//   pending.json           transactions built and not yet known to be with the node, by record id
//   inscriptions.jsonl     what this wallet sent: one line per record, {kind, id, code, txid, fee, sent, …}
import {existsSync,readFileSync,appendFileSync,mkdirSync,chmodSync,openSync,writeSync,fsyncSync,closeSync,renameSync} from 'node:fs';
import {join,extname} from 'node:path';
import {ed25519} from '@noble/curves/ed25519';
import {OP,NO_COLLECTION,MAX_RECORD,MAX_EDITIONS,MAX_NAME,encodeBody,decodeRecord,recordId,codeOf,renderText,nftLabel,attachSignature,canonical,formatXmr} from '../../rules/lib/records.mjs';
import {le,hex,unhex,encodeAddress,signWithSpendKey} from '../../rules/lib/monero.mjs';

const G=ed25519.ExtendedPoint.BASE,L=ed25519.CURVE.n,HEX64=/^[0-9a-f]{64}$/;
const need=(ok,why)=>{if(!ok)throw Error(why);};
// Text from a reader or a node, made safe to print: no control characters, not endless.
export const clean=(v,max=200)=>String(v??'').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g,' ').slice(0,max);
// The ledgers this program knows by itself (docs/LAUNCH-SETTINGS.md). On another network the domain is given.
export const LEDGERS={mainnet:{domain:'ec7f7d26dba6725124df69417d43335c52e34557fc61c1d8d6b4736370e6ba1d'}};

// Content types of the rules (RULES.md section 9), by name and by file ending.
export const TYPES={png:1,jpeg:2,jpg:2,webp:3,gif:4,text:5,txt:5,md:5,json:6,mp4:7,art:8};
export function typeOf(file,given=null){
 if(given!=null&&given!==''){const n=TYPES[String(given).toLowerCase()]??(/^\d{1,3}$/.test(String(given))?Number(given):NaN);need(Number.isInteger(n)&&n>=1&&n<=255,'--type is a content type name (png, jpeg, webp, gif, text, json, mp4, art) or a number from 1 to 255.');return n;}
 const n=TYPES[extname(String(file)).slice(1).toLowerCase()];need(n,'The type of this file is not known from its name: give --type.');return n;}

// A file of the wallet, replaced whole and readable by its owner only.
const put=(file,text)=>{const tmp=file+'.part',fd=openSync(tmp,'w',0o600);try{writeSync(fd,text);fsyncSync(fd);}finally{closeSync(fd);}renameSync(tmp,file);};

// The wallet's keys as the carrier tool wrote them: its address and its signature.
export function keysOf(dir,network){
 const file=join(dir,'carrier.keys.json');need(existsSync(file),'There is no wallet in '+dir+'. Make one with: xmr721 wallet create');
 let k;try{k=JSON.parse(readFileSync(file,'utf8'));}catch{k={};}
 need(HEX64.test(k.spend||'')&&HEX64.test(k.view||''),'The wallet keys in '+file+' are not readable.');
 const s=le(unhex(k.spend)),v=le(unhex(k.view));need(s>0n&&s<L&&v>0n&&v<L,'The wallet keys are not keys.');
 const spend=G.multiply(s).toRawBytes(),view=G.multiply(v).toRawBytes(),key=unhex(k.spend);
 return {address:encodeAddress({spend,view,kind:'main',network}),sign:text=>signWithSpendKey(text,{spend,view},key)};}

// A reader's HTTP service. Every answer is checked for its shape before anything is done with it.
export function readerAt(url,{fetch:f=fetch,timeout=30000,limit=16<<20}={}){
 const base=String(url).replace(/\/$/,'');
 const get=async path=>{
  const r=await f(base+path,{signal:AbortSignal.timeout(timeout)}),buf=Buffer.from(await r.arrayBuffer());
  need(buf.length<=limit,'The reader sent more than this program reads.');
  let body={};try{body=JSON.parse(buf.toString('utf8'));}catch{body={};}
  if(r.status===404)return null;need(r.ok,`The reader answered ${r.status} for ${clean(path,80)}: ${clean(body?.error)}`);need(body&&typeof body==='object','The reader did not answer with JSON.');return body;};
 const int=(v,what,min=0,max=Number.MAX_SAFE_INTEGER)=>{need(Number.isSafeInteger(v)&&v>=min&&v<=max,'The reader gave no usable '+what+'.');return v;};
 const address=(v,what,network)=>{try{return canonical(v,network);}catch{throw Error('The reader gave no usable '+what+'.');}};
 return {url:base,
  async info(network){const i=await get('/info');need(i&&typeof i.network==='string','The reader gave no settings.');
   need(i.network===network,`The reader is for ${clean(i.network,20)}, the wallet for ${network}.`);need(HEX64.test(i.domain||''),'The reader gives no ledger domain.');
   return {network,domain:i.domain,height:int(i.height,'height',1),mintFrom:i.mintFrom==null?null:int(i.mintFrom,'first mint block',1),openFrom:i.openFrom==null?null:int(i.openFrom,'opening block',1),
    minters:Array.isArray(i.minters)?i.minters.map(a=>address(a,'minter list',network)):null};},
  async collection(id,network){const v=await get('/nft-collection/'+id);if(!v)return null;const c=v.collection||{};
   need(c.id===id&&typeof c.name==='string'&&c.name.length>=1&&c.name.length<=MAX_NAME&&Array.isArray(v.items),'The reader gave no usable collection.');
   const max=int(c.max,'number of editions',1,MAX_EDITIONS);need(v.items.length<=max,'The reader lists more NFTs than the collection has editions.');
   return {id,name:c.name,max,creator:address(c.creator,'creator',network),editions:v.items.map(t=>int(t?.edition,'edition',1,max))};},
  async nft(id,network){const v=await get('/nft/'+id);if(!v)return null;const x=v.nft||{};need(x.id===id,'The reader gave no usable NFT.');
   return {id,owner:x.owner==null?null:address(x.owner,'owner',network),burned:Boolean(x.burned),seq:int(x.seq,'move number'),listed:Boolean(x.lot),waiting:Array.isArray(v.waiting)&&v.waiting.length>0,
    collection:HEX64.test(x.collection||'')?x.collection:NO_COLLECTION,edition:int(x.edition??0,'edition',0,MAX_EDITIONS),collectionName:typeof x.collectionName==='string'&&x.collectionName.length<=MAX_NAME?x.collectionName:null};},
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

// carrier: {init, status, carry, publish, split} (reader/lib/relay.mjs createCarrier, or a stand-in in tests).
// chain:   {txs(ids)} of the wallet's node (reader/lib/chain.mjs): asked whether the node has a transaction.
// domain:  the ledger's domain; on mainnet the one this program knows, which no option and no reader changes.
// ledgers: the ledgers known by themselves (LEDGERS above; a test on a made-up chain with mainnet addresses gives none).
export function openWallet({dir,carrier,reader,chain,network='mainnet',domain=null,ledgers=LEDGERS,now=()=>Date.now()}){
 const files={log:join(dir,'inscriptions.jsonl'),pending:join(dir,'pending.json')},me=()=>keysOf(dir,network);
 const pinned=ledgers[network]?.domain??null;need(!(pinned&&domain&&domain!==pinned),`On ${network} the ledger is ${pinned}; another domain is another ledger.`);
 const rows=()=>existsSync(files.log)?readFileSync(files.log,'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l)):[];
 const pending=()=>{if(!existsSync(files.pending))return {};const p=JSON.parse(readFileSync(files.pending,'utf8'));need(p&&typeof p==='object'&&!Array.isArray(p),'pending.json is not readable.');return p;};
 // The ledger's settings as the reader states them, for the ledger this wallet inscribes on.
 async function settings(){
  const info=await reader.info(network),want=pinned??domain;
  need(want||network!=='mainnet','No ledger domain.');
  need(!want||info.domain===want,`The reader is for another ledger (${info.domain}) than this wallet inscribes on (${want}).`);return info;}
 const withNode=async txid=>{try{return (await chain.txs([txid])).has(txid);}catch{return false;}};
 // Hands a built transaction to the node. It stays in pending.json until the node has it; then it is written down as sent.
 async function deliver(p){
  let failure=null;try{await carrier.publish(p.blob);}catch(e){failure=e;}
  // (A node that refuses a transaction it has already is no failure: an earlier send got through.)
  if(failure&&!await withNode(p.txid))throw Error(`The transaction was built and the node did not take it (${clean(failure.message,160)}). It is kept: run "xmr721 wallet resend" to send the same transaction again. Nothing is paid twice.`);
  const {blob,built,...entry}=p;appendFileSync(files.log,JSON.stringify({...entry,sent:new Date(now()).toISOString()})+'\n',{mode:0o600});
  const rest=pending();delete rest[p.id];put(files.pending,JSON.stringify(rest)+'\n');return entry;}
 // Signs the record and, unless it is a dry run, carries it in a transaction of the wallet and sends that.
 async function carry(kind,bodyBytes,ctx,{dryRun,extra={}}){
  const keys=me(),d=decodeRecord(bodyBytes,network,{sig:false}),text=renderText(d.op,d.body,bodyBytes,ctx),record=attachSignature(bodyBytes,keys.sign(text),ctx,network);
  need(record.length<=MAX_RECORD,`The record is ${record.length} bytes; a record is at most ${MAX_RECORD}. Make the content or the name smaller.`);
  const id=recordId(ctx.domain,bodyBytes),out={kind,id,code:codeOf(id),bytes:record.length,text,...extra};
  if(dryRun)return {...out,dryRun:true,record:hex(record)};
  // The same record is never paid for twice: one that was built is sent again as it is, one that was sent is not made again.
  const waiting=pending()[id];if(waiting)return {...await deliver(waiting),again:true};
  const before=rows().find(r=>r.id===id);need(!before,`This wallet sent this very record before (transaction ${before?.txid}). A record counts once: change the name or the content to inscribe again.`);
  const s=await carrier.status();need(s.ready>0,s.coins?'No coin of the wallet can pay right now (a coin can be spent 10 blocks after it arrived). Wait, or make more coins with: xmr721 wallet split <n>':'The wallet has no coins. Send some XMR to '+keys.address);
  const built=await carrier.carry(hex(record)),p={...out,txid:built.txid,fee:formatXmr(BigInt(built.fee)),blob:built.blob,built:new Date(now()).toISOString()};
  put(files.pending,JSON.stringify({...pending(),[id]:p})+'\n');
  return deliver(p);}
 // This wallet's own records that the reader does not show yet.
 const unseen=async(kind,match)=>{const out=[];for(const r of [...rows(),...Object.values(pending())].filter(r=>r.kind===kind&&match(r))){const e=r.sent?await reader.entry(r.txid):null;if(!e)out.push(r);}return out;};
 return {
  dir,
  get address(){return me().address;},
  // A new wallet: its keys, and the block its scan starts at (the node's newest: a new wallet has received nothing yet).
  async create({height}){
   need(!existsSync(join(dir,'carrier.keys.json')),'There is a wallet in '+dir+' already.');
   need(Number.isSafeInteger(height)&&height>=1,'The node gave no height.');
   mkdirSync(dir,{recursive:true,mode:0o700});chmodSync(dir,0o700);put(join(dir,'wallet.json'),JSON.stringify({network,start:height})+'\n');
   const made=await carrier.init(),address=me().address;
   need(made.address===address,'The carrier tool and this program see another address for the same keys.');
   return {address,start:height};},
  async balance(){const s=await carrier.status();return {address:me().address,balance:formatXmr(BigInt(s.balance)),coins:s.coins,ready:s.ready,scanned:s.tip,waitingToBeSent:Object.keys(pending()).length};},
  async split(n){need(Number.isInteger(n)&&n>=2&&n<=14,'Split into 2 to 14 coins.');const t=await carrier.split(n),done=await carrier.publish(t.blob);return {txid:done.txid,fee:formatXmr(BigInt(t.fee))};},
  // One NFT: in no collection, or an edition of one of the wallet's collections (the next free one unless named).
  async inscribe({content,type,name='',to=null,collection=null,edition=null,dryRun=false}){
   const info=await settings(),address=me().address,closed=mintingClosed(info,address);need(!closed,closed);
   need(content&&content.length,'The file is empty.');
   const owner=to==null?address:canonical(to,network);
   let ctx={domain:info.domain,collectionName:null},col=NO_COLLECTION,ed=0;
   if(collection!=null){
    need(HEX64.test(collection),'--collection is a collection id (64 hex characters).');
    const c=await reader.collection(collection,network);need(c,'This collection is not on the ledger yet. A new collection has to be in a block before its editions are minted.');
    need(c.creator===address,'This collection was made by '+c.creator+'; only its creator mints its editions.');
    // Editions this wallet minted that the reader does not show yet are taken too.
    const taken=new Set([...c.editions,...(await unseen('mint',r=>r.collection===collection)).map(r=>r.edition)]);
    if(edition==null){for(let e=1;e<=c.max&&edition==null;e++)if(!taken.has(e))edition=e;need(edition!=null,'Every edition of this collection is minted.');}
    need(Number.isInteger(edition)&&edition>=1&&edition<=c.max,`An edition of this collection is 1 to ${c.max}.`);
    need(!taken.has(edition),`Edition ${edition} of this collection is minted already, or this wallet's mint of it is waiting for a block.`);
    col=collection;ed=edition;ctx={domain:info.domain,collectionName:c.name};}
   else need(edition==null,'--edition goes with --collection.');
   const bodyBytes=encodeBody(OP.mint,{collection:col,edition:ed,creator:address,to:owner===address?null:owner,name,type,content},network);
   // A record that is on the ledger already counts once; a second one would be paid for and refused.
   need(dryRun||!await reader.nft(recordId(info.domain,bodyBytes),network),'This very NFT is on the ledger already. A record counts once: change the name or the content to inscribe again.');
   return carry('mint',bodyBytes,ctx,{dryRun,extra:{type,size:content.length,...(col!==NO_COLLECTION?{collection:col,edition:ed}:{}),owner}});},
  async collection({name,max,dryRun=false}){
   const info=await settings(),address=me().address,closed=mintingClosed(info,address);need(!closed,closed);
   const bodyBytes=encodeBody(OP.collection,{creator:address,name,max},network);
   need(dryRun||!await reader.collection(recordId(info.domain,bodyBytes),network),'This wallet made a collection of this name and size already. Two collections of one creator differ in name or size.');
   return carry('collection',bodyBytes,{domain:info.domain},{dryRun,extra:{name,max}});},
  // Sends an NFT the wallet owns to another address.
  async send({nft,to,dryRun=false}){
   const info=await settings(),address=me().address;
   need(HEX64.test(nft||''),'Give the NFT id (64 hex characters).');
   const x=await reader.nft(nft,network);need(x,'This NFT is not on the ledger (yet).');
   need(!x.burned,'This NFT was burned.');need(x.owner===address,'This NFT belongs to '+x.owner+', not to this wallet.');
   need(!x.listed,'This NFT is listed for sale; stop the listing first.');need(!x.waiting,'A record for this NFT is waiting for a block. Try again later.');
   const target=canonical(to,network);need(target!==address,'That is this wallet\'s own address.');
   const bodyBytes=encodeBody(OP.move,{reg:nft,seq:x.seq,from:address,to:target},network),id=recordId(info.domain,bodyBytes);
   need(dryRun||pending()[id]||!(await unseen('send',r=>r.nft===nft)).length,'This wallet\'s earlier send of this NFT is waiting for a block. Try again when it is in one.');
   return carry('send',bodyBytes,{domain:info.domain,what:nftLabel(nft,{collection:x.collection,edition:x.edition},x.collectionName)},{dryRun,extra:{nft,to:target}});},
  // Sends again every transaction that was built and is not known to be with the node.
  async resend(){const out=[];for(const p of Object.values(pending())){try{out.push({...await deliver(p),state:'sent'});}catch(e){out.push({id:p.id,txid:p.txid,state:clean(e.message,300)});}}return out;},
  // What this wallet sent and what is still to be sent, each with what the reader and the node know of it now.
  async inscriptions(){
   const out=[];
   for(const p of Object.values(pending())){const {blob,...r}=p;out.push({...r,state:'built, not with the node yet: run "xmr721 wallet resend"'});}
   for(const r of rows()){
    const e=await reader.entry(r.txid);let state;
    if(e&&!e.ok)state='refused by the ledger: '+e.error;
    else if(e)state=`on the ledger (block ${e.height}, ${e.confirmations} confirmations)`;
    else state=await withNode(r.txid)?'waiting for a block':'not with the node (it may have dropped the transaction); nothing was inscribed';
    out.push({...r,state});}
   return out;}};}
