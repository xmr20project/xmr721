// XMR20 tokens on an XMR721 ledger (../FORMAT.md): a token is announced by one inscription, a minted NFT whose content
// is a short JSON text. This file writes that text, reads it back and picks the tokens out of a ledger's minted NFTs.
// It decides nothing about balances: a deploy inscription says that a token exists and what it is called.
import {NO_COLLECTION} from '../../rules/lib/records.mjs';

export const TYPE_JSON=6,MAX_TEXT=600;
// The fields, in the order they are written. `name`, `pair`, `mint` and `col` may be left out.
export const FIELDS=['p','op','tick','name','max','dec','mode','pair','mint','col'];

const B58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
// Base58 as Bitcoin and Solana write it (not Monero's block form). Returns the bytes, or null.
export function base58(text){
 if(typeof text!=='string'||!text.length||text.length>64)return null;
 let n=0n;for(const c of text){const i=B58.indexOf(c);if(i<0)return null;n=n*58n+BigInt(i);}
 const out=[];while(n>0n){out.unshift(Number(n&255n));n>>=8n;}
 for(const c of text){if(c!=='1')break;out.unshift(0);}
 return Uint8Array.from(out);}

// Text a person reads as a name: no control, formatting or direction characters, no space at either end.
const HIDDEN=/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/;
const words=(v,max)=>typeof v==='string'&&v.length>0&&[...v].length<=max&&v===v.trim()&&!HIDDEN.test(v)&&v.isWellFormed();

// The fields of a deploy, checked. Throws with the reason; returns them in written order with nothing else.
export function checkDeploy(o){
 if(!o||typeof o!=='object'||Array.isArray(o))throw Error('A deploy is a JSON object.');
 for(const k of Object.keys(o))if(!FIELDS.includes(k))throw Error(`Unknown field "${k}".`);
 if(o.p!=='xmr20'||o.op!=='deploy')throw Error('Not an XMR20 deploy.');
 if(!words(o.tick,32))throw Error('tick: 1 to 32 characters.');
 if(o.name!==undefined&&!words(o.name,64))throw Error('name: 1 to 64 characters.');
 if(typeof o.max!=='string'||!/^[1-9][0-9]{0,29}$/.test(o.max))throw Error('max: a whole number of tokens, written as text.');
 if(typeof o.dec!=='string'||!/^(0|[1-9]|1[0-8])$/.test(o.dec))throw Error('dec: 0 to 18, written as text.');
 if(typeof o.mode!=='string'||o.mode.length>32||!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(o.mode))throw Error('mode: lower-case words joined by hyphens.');
 if(o.pair!==undefined&&!(typeof o.pair==='string'&&/^[A-Za-z0-9]{1,16}$/.test(o.pair)))throw Error('pair: 1 to 16 letters or digits.');
 if(o.mint!==undefined&&base58(o.mint)?.length!==32)throw Error('mint: a Solana address.');
 if(o.col!==undefined&&!(typeof o.col==='string'&&/^[0-9a-f]{64}$/.test(o.col)))throw Error('col: the id of an XMR721 collection.');
 return Object.fromEntries(FIELDS.filter(k=>o[k]!==undefined).map(k=>[k,o[k]]));}

// The inscribed text of a deploy: its fields in written order, no spaces. One deploy has exactly one text.
export function deployText(fields){
 const text=JSON.stringify(checkDeploy({p:'xmr20',op:'deploy',...fields}));
 if(new TextEncoder().encode(text).length>MAX_TEXT)throw Error(`A deploy is at most ${MAX_TEXT} bytes.`);
 return text;}

// The deploy written in these bytes, or null. Only the exact text deployText() writes is read, so every reader agrees
// on what a text says (no second spelling of the same token, no field read two ways).
export function readDeploy(bytes){
 if(!bytes||bytes.length>MAX_TEXT)return null;
 try{const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes),d=checkDeploy(JSON.parse(text));return JSON.stringify(d)===text?d:null;}catch{return null;}}

// The tokens among a ledger's minted NFTs, oldest first.
//   nfts: every minted NFT in ledger order, each {id, creator, collection, type, burned, content: () => bytes, …}
//   inscribers: the addresses whose deploy inscriptions count (canonical text form)
// Every deploy inscription of an inscriber takes the next number, for good. The token of a Solana mint is the earliest
// such inscription that is not burned; a later one for the same mint is not a token while that one stands.
export function projectTokens(nfts,inscribers){
 const allowed=new Set(inscribers),taken=new Set(),out=[];let number=0;
 for(const x of nfts){
  if(!allowed.has(x.creator)||x.collection!==NO_COLLECTION||x.type!==TYPE_JSON)continue;
  const d=readDeploy(x.content());if(!d)continue;
  number++;if(x.burned)continue;
  if(d.mint){if(taken.has(d.mint))continue;taken.add(d.mint);}
  const {p,op,...fields}=d,{content,creator,collection,type,burned,...rest}=x;
  out.push({number,...fields,inscriber:creator,...rest});}
 return out;}
