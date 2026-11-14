// The xmr721 wallet: a Monero wallet of its own that inscribes on the XMR721 ledger.
//
// The wallet is a folder. The carrier tool (reader/carrier) keeps its keys there (carrier.keys.json) and its view of the
// chain; it builds the transactions that carry records and pays their network fee from the wallet's own coins. This
// file signs the records with the same keys: the wallet's address is the creator of what it inscribes. A reader
// (reader/service.mjs, any one) is asked for the ledger's settings and state before a record is made; nothing a reader
// says can make the wallet sign something else than what it was told to make.
//
//   wallet.json            {network, start}: the wallet's network and the block its scan starts at
//   carrier.keys.json      the keys (written by the carrier tool, readable by the owner only)
//   inscriptions.jsonl     what this wallet sent: one line per record, {kind, id, code, txid, fee, sent, …}
import {existsSync,readFileSync,writeFileSync,appendFileSync,mkdirSync} from 'node:fs';
import {join,extname} from 'node:path';
import {ed25519} from '@noble/curves/ed25519';
import {OP,NO_COLLECTION,MAX_RECORD,encodeBody,decodeRecord,recordId,codeOf,renderText,nftLabel,attachSignature,canonical,formatXmr} from '../../rules/lib/records.mjs';
import {le,hex,unhex,encodeAddress,signWithSpendKey} from '../../rules/lib/monero.mjs';

const G=ed25519.ExtendedPoint.BASE,L=ed25519.CURVE.n;
const need=(ok,why)=>{if(!ok)throw Error(why);};

// Content types of the rules (RULES.md section 9), by name and by file ending.
export const TYPES={png:1,jpeg:2,jpg:2,webp:3,gif:4,text:5,txt:5,md:5,json:6,mp4:7,art:8};
export function typeOf(file,given=null){
 if(given!=null&&given!==''){const n=TYPES[String(given).toLowerCase()]??Number(given);need(Number.isInteger(n)&&n>=1&&n<=255,'--type is a content type name (png, jpeg, webp, gif, text, json, mp4, art) or a number from 1 to 255.');return n;}
 const n=TYPES[extname(String(file)).slice(1).toLowerCase()];need(n,'The type of this file is not known from its name: give --type.');return n;}

// The wallet's keys as the carrier tool wrote them: its address and its signature.
export function keysOf(dir,network){
 const file=join(dir,'carrier.keys.json');need(existsSync(file),'There is no wallet in '+dir+'. Make one with: xmr721 wallet create');
 const k=JSON.parse(readFileSync(file,'utf8'));need(/^[0-9a-f]{64}$/.test(k.spend||'')&&/^[0-9a-f]{64}$/.test(k.view||''),'The wallet keys are not readable.');
 const s=le(unhex(k.spend)),v=le(unhex(k.view));need(s>0n&&s<L&&v>0n&&v<L,'The wallet keys are not keys.');
 const spend=G.multiply(s).toRawBytes(),view=G.multiply(v).toRawBytes(),key=unhex(k.spend);
 return {address:encodeAddress({spend,view,kind:'main',network}),sign:text=>signWithSpendKey(text,{spend,view},key)};}

// A reader's HTTP service, asked for JSON.
export function readerAt(url,{fetch:f=fetch,timeout=30000}={}){
 const base=String(url).replace(/\/$/,'');
 const get=async path=>{const r=await f(base+path,{signal:AbortSignal.timeout(timeout)});const body=await r.json().catch(()=>({}));
  if(r.status===404)return null;if(!r.ok)throw Error(`The reader answered ${r.status} for ${path}: ${String(body.error||'').slice(0,200)}`);return body;};
 return {url:base,info:()=>get('/info'),collection:id=>get('/nft-collection/'+id),nft:id=>get('/nft/'+id)};}

// The ledger's settings as a reader states them, checked against the wallet's network.
async function settingsOf(reader,network){
 const info=await reader.info();need(info&&info.network===network,`The reader is for ${info?.network??'another network'}, the wallet for ${network}.`);
 need(/^[0-9a-f]{64}$/.test(info.domain||''),'The reader gives no ledger domain.');need(Number.isSafeInteger(info.height),'The reader gives no height.');return info;}

// May this address make collections and mint in the next block? -> null, or the reason it may not.
export function mintingClosed(info,address){
 const next=info.height+1;
 if(info.mintFrom==null)return 'This ledger has no minting.';
 if(next<info.mintFrom)return `Minting starts at block ${info.mintFrom}; the ledger is at block ${info.height}.`;
 if(!Array.isArray(info.minters)||info.minters.includes(address))return null;
 if(info.openFrom!=null&&next>=info.openFrom)return null;
 return info.openFrom!=null?`Minting opens to everyone at block ${info.openFrom}; the ledger is at block ${info.height} (about ${Math.max(1,Math.round((info.openFrom-next)*2/60))} hours from now).`:'On this ledger only its listed minters make collections and mint.';}

// carrier: {init, status, carry, publish, split} (reader/lib/relay.mjs createCarrier, or a stand-in in tests).
export function openWallet({dir,carrier,reader,network='mainnet',now=()=>Date.now()}){
 const log=join(dir,'inscriptions.jsonl'),me=()=>keysOf(dir,network);
 const sent=entry=>{appendFileSync(log,JSON.stringify({...entry,sent:new Date(now()).toISOString()})+'\n',{mode:0o600});return entry;};
 // Builds the record, signs it, and unless it is a dry run carries it in a transaction of the wallet and sends that.
 async function carry(kind,bodyBytes,ctx,{dryRun,extra={}}){
  const keys=me(),d=decodeRecord(bodyBytes,network,{sig:false}),text=renderText(d.op,d.body,bodyBytes,ctx),record=attachSignature(bodyBytes,keys.sign(text),ctx,network);
  need(record.length<=MAX_RECORD,`The record is ${record.length} bytes; a record is at most ${MAX_RECORD}. Make the content smaller.`);
  const id=recordId(ctx.domain,bodyBytes),out={kind,id,code:codeOf(id),bytes:record.length,text,...extra};
  if(dryRun)return {...out,dryRun:true};
  const s=await carrier.status();need(s.ready>0,s.coins?'No coin of the wallet can pay right now (a coin can be spent 10 blocks after it arrived). Wait, or make more coins with: xmr721 wallet split':'The wallet has no coins. Send some XMR to '+keys.address);
  const built=await carrier.carry(hex(record)),done=await carrier.publish(built.blob);need(done.txid===built.txid,'The node took another transaction than the one built.');
  return sent({...out,txid:built.txid,fee:formatXmr(BigInt(built.fee))});}
 return {
  dir,
  get address(){return me().address;},
  // A new wallet: its keys, and the block its scan starts at (the node's newest: a new wallet has received nothing yet).
  async create({height}){
   need(!existsSync(join(dir,'carrier.keys.json')),'There is a wallet in '+dir+' already.');
   need(Number.isSafeInteger(height)&&height>=1,'The node gave no height.');
   mkdirSync(dir,{recursive:true,mode:0o700});writeFileSync(join(dir,'wallet.json'),JSON.stringify({network,start:height})+'\n',{mode:0o600});
   const made=await carrier.init(),address=me().address;
   need(made.address===address,'The carrier tool and this program see another address for the same keys.');
   return {address,start:height};},
  async balance(){const s=await carrier.status();return {address:me().address,balance:formatXmr(BigInt(s.balance)),coins:s.coins,ready:s.ready,scanned:s.tip};},
  async split(n){need(Number.isInteger(n)&&n>=2&&n<=16,'Split into 2 to 16 coins.');const t=await carrier.split(n),done=await carrier.publish(t.blob);return {txid:done.txid,fee:formatXmr(BigInt(t.fee))};},
  // One NFT: in no collection, or the next free edition of one of the wallet's collections.
  async inscribe({content,type,name='',to=null,collection=null,edition=null,dryRun=false}){
   const info=await settingsOf(reader,network),address=me().address,closed=mintingClosed(info,address);need(!closed,closed);
   need(content&&content.length,'The file is empty.');
   let ctx={domain:info.domain,collectionName:null},col=NO_COLLECTION,ed=0;
   if(collection){
    need(/^[0-9a-f]{64}$/.test(collection),'--collection is a collection id (64 hex characters).');
    const c=await reader.collection(collection);need(c,'This collection is not on the ledger (yet).');
    need(c.collection.creator===address,'This collection was made by '+c.collection.creator+'; only its creator mints its editions.');
    const taken=new Set(c.items.map(t=>t.edition));
    ed=edition??Array.from({length:c.collection.max},(_,i)=>i+1).find(e=>!taken.has(e));
    need(ed!=null,'Every edition of this collection is minted.');need(Number.isInteger(ed)&&ed>=1&&ed<=c.collection.max,`An edition of this collection is 1 to ${c.collection.max}.`);
    need(!taken.has(ed),`Edition ${ed} of this collection is minted already.`);
    col=collection;ctx={domain:info.domain,collectionName:c.collection.name};}
   const bodyBytes=encodeBody(OP.mint,{collection:col,edition:ed,creator:address,to:to?canonical(to,network):null,name,type,content},network);
   return carry('mint',bodyBytes,ctx,{dryRun,extra:{type,size:content.length,...(col!==NO_COLLECTION?{collection:col,edition:ed}:{}),owner:to?canonical(to,network):address}});},
  async collection({name,max,dryRun=false}){
   const info=await settingsOf(reader,network),address=me().address,closed=mintingClosed(info,address);need(!closed,closed);
   const bodyBytes=encodeBody(OP.collection,{creator:address,name,max},network);
   return carry('collection',bodyBytes,{domain:info.domain},{dryRun,extra:{name,max}});},
  // Sends an NFT the wallet owns to another address.
  async send({nft,to,dryRun=false}){
   const info=await settingsOf(reader,network),address=me().address;
   need(/^[0-9a-f]{64}$/.test(nft||''),'Give the NFT id (64 hex characters).');
   const v=await reader.nft(nft);need(v,'This NFT is not on the ledger (yet).');const x=v.nft;
   need(!x.burned,'This NFT was burned.');need(x.owner===address,'This NFT belongs to '+x.owner+', not to this wallet.');
   need(!x.lot,'This NFT is listed for sale; stop the listing first.');need(!(v.waiting||[]).length,'A record for this NFT is waiting for a block. Try again later.');
   const target=canonical(to,network);need(target!==address,'That is this wallet\'s own address.');
   const bodyBytes=encodeBody(OP.move,{reg:nft,seq:x.seq,from:address,to:target},network);
   return carry('send',bodyBytes,{domain:info.domain,what:nftLabel(nft,x,x.collectionName)},{dryRun,extra:{nft,to:target}});},
  // What this wallet sent, each with what the reader knows of it now.
  async inscriptions(){
   if(!existsSync(log))return [];
   const rows=readFileSync(log,'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l)),out=[];
   for(const r of rows){let state='waiting for a block';
    if(r.kind==='mint'){const v=await reader.nft(r.id);if(v)state=v.nft.burned?'burned':'on the ledger, owned by '+v.nft.owner;}
    else if(r.kind==='collection'){const v=await reader.collection(r.id);if(v)state=`on the ledger, ${v.collection.minted} of ${v.collection.max} minted`;}
    else if(r.kind==='send'){const v=await reader.nft(r.nft);if(v&&v.history.some(h=>h.txid===r.txid))state='done';}
    out.push({...r,state});}
   return out;}};}
