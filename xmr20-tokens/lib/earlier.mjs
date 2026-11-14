// The earlier XMR20 deploy inscriptions (../EARLIER.md): how the launchpad announced a token on Monero before tokens
// were inscribed on the XMR721 ledger. This file reads such an inscription out of a transaction's extra field, checks
// it, and loads the list of them that the repository ships. Reading only: nothing new is written in this format here.
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {carrierOf} from '../../xmr20-nfts/lib/format.mjs';
import {verifySpendSignature} from '../../rules/lib/monero.mjs';

export const MAGIC='XMR20M1',MAX_CARRIER=800,SUPPLY='1000000000000000',DECIMALS=6;
// The text a deployer signed is one of these two lines followed by the record. They are bytes of the format, kept as
// they were written on the chain.
export const DOMAINS={1:'MOUSE-ROAD-XMR20-MAINNET-DEPLOY-V1\n',2:'XMR20-MAINNET-DEPLOY-V2\n'};
const FIELDS=['chain','creator','fee','initial','max','meta','mint','net','nonce','op','owner','p','tick','v'];
const SOLANA=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/,MONERO=/^4[1-9A-HJ-NP-Za-km-z]{94}$/;
const need=(ok,why)=>{if(!ok)throw Error(why);};

// The one way a value is written: keys in order, no spaces, ASCII only (what the launchpad's signer wrote).
export const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v!==null&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);

// The fields of an earlier deploy record, checked. Throws with the reason.
export function checkRecord(r){
 need(r!==null&&typeof r==='object'&&!Array.isArray(r)&&Object.keys(r).sort().join(',')===FIELDS.join(','),'Not a deploy record.');
 need(r.p==='xmr20'&&(r.v===1||r.v===2)&&r.net==='mainnet'&&r.op==='deploy','Not an XMR20 mainnet deploy.');
 need(typeof r.owner==='string'&&MONERO.test(r.owner),'owner: a Monero address.');
 need(typeof r.tick==='string'&&/^[A-Z][A-Z0-9]{0,9}$/.test(r.tick),'tick: 1 to 10 capital letters and digits.');
 need(r.chain===(r.v===2?'mainnet':'mainnet-beta'),'chain does not fit the version.');
 need(r.max===SUPPLY&&r.initial==='0'&&(r.fee==='200'||r.fee==='150'),'Not the fixed supply and fee of a launch.');
 need(typeof r.nonce==='string'&&/^[0-9a-f]{32}$/.test(r.nonce)&&typeof r.meta==='string'&&/^[0-9a-f]{64}$/.test(r.meta),'nonce and meta: hex.');
 for(const k of ['mint','creator'])need(typeof r[k]==='string'&&SOLANA.test(r[k]),k+': a Solana address.');
 return r;}

// The text the deployer signed for a record.
export const signedText=record=>DOMAINS[record.v]+canonical(record);

// The envelope written in a carrier: {record, signature}, checked and with its signature verified against the record's
// own `owner`. Throws with the reason. `text` is the exact JSON that was inscribed.
export function openCarrier(carrier,network='mainnet'){
 const bytes=Buffer.from(carrier);need(bytes.length<=MAX_CARRIER&&bytes.subarray(0,7).toString('latin1')===MAGIC,'Not an earlier XMR20 inscription.');
 const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes.subarray(7));need(/^[\x20-\x7e]+$/.test(text),'The inscribed text is not plain ASCII.');
 const e=JSON.parse(text);need(e!==null&&typeof e==='object'&&!Array.isArray(e)&&Object.keys(e).sort().join(',')==='record,signature'&&typeof e.signature==='string','Not a record with its signature.');
 need(canonical(e)===text,'The inscribed text is not written the one way it can be.');
 checkRecord(e.record);
 need(verifySpendSignature(signedText(e.record),e.record.owner,e.signature,network),'The signature is not the owner\'s.');
 return {record:e.record,signature:e.signature,text};}

// The earlier deploy in a transaction's extra field, or null when the transaction holds none (any other content, a
// damaged field, a signature that does not verify).
export function readEarlier(extra,network='mainnet'){
 try{const carrier=carrierOf(extra);return carrier?openCarrier(carrier,network):null;}catch{return null;}}

// A token as an earlier deploy describes it. Supply and decimals were the same for every launch.
export const tokenOf=(entry,number)=>({earlier:true,number,tick:entry.record.tick,max:(BigInt(entry.record.max)/10n**BigInt(DECIMALS)).toString(),dec:String(DECIMALS),mode:'bonding-curve',mint:entry.record.mint,
 creator:entry.record.creator,deployer:entry.record.owner,version:entry.record.v,txid:entry.txid,height:entry.height,time:entry.time??null});

// The shipped list (../earlier/deploys.jsonl with its header ../earlier/list.json), checked line by line: every entry
// is the inscribed text of one transaction, signed by one of the listed deployers. Entries are in chain order. The
// token of a Solana mint is its earliest deploy; a later deploy for the same mint is kept in `deploys` and is no token.
//   -> {header, deploys: [{txid, height, time, record, signature}], tokens: [tokenOf …]}
export function loadEarlier(dir,network='mainnet'){
 const header=JSON.parse(readFileSync(join(dir,'list.json'),'utf8')),deployers=new Set(header.deployers);
 need(header.format==='xmr20-earlier-deploys-v1'&&Array.isArray(header.deployers)&&header.deployers.length>0&&Number.isSafeInteger(header.from)&&Number.isSafeInteger(header.to),'Not a list of earlier deploys.');
 const lines=readFileSync(join(dir,'deploys.jsonl'),'utf8').split('\n').filter(Boolean),deploys=[],tokens=[],mints=new Set(),seen=new Set();let last=[0,''];
 need(lines.length===header.count,'The list has another number of entries than its header says.');
 for(const line of lines){
  const x=JSON.parse(line);need(typeof x.txid==='string'&&/^[0-9a-f]{64}$/.test(x.txid)&&Number.isSafeInteger(x.height)&&x.height>=header.from&&x.height<=header.to&&typeof x.text==='string','A malformed entry.');
  need(!seen.has(x.txid)&&(x.height>last[0]||(x.height===last[0]&&x.txid!==last[1])),'Entries out of order or twice.');seen.add(x.txid);last=[x.height,x.txid];
  const e=openCarrier(Buffer.from(MAGIC+x.text,'latin1'),network);need(deployers.has(e.record.owner),'An entry signed by an address that is not a listed deployer.');
  const entry={txid:x.txid,height:x.height,time:Number.isSafeInteger(x.time)?x.time:null,record:e.record,signature:e.signature};deploys.push(entry);
  if(!mints.has(e.record.mint)){mints.add(e.record.mint);tokens.push(tokenOf(entry,tokens.length+1));}}
 return {header,deploys,tokens};}
