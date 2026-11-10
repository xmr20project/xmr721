// Pictures. A Mordinal's content is the bytes inscribed in its registration transaction. The owner list carries the
// SHA-256 of those bytes, so content from any source can be checked before it is shown: this module only passes on
// bytes whose hash and size match the owner list and whose first bytes are a plain picture format.
// Other content (text, HTML, SVG, anything else) is never served for display.
import {createHash} from 'node:crypto';
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';

const starts=(b,sig,at=0)=>sig.every((v,i)=>b[at+i]===v);
// The picture type by its first bytes, or null. The stated type of a source is never trusted.
export function pictureType(b){
 if(b.length>=8&&starts(b,[0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))return 'image/png';
 if(b.length>=3&&starts(b,[0xff,0xd8,0xff]))return 'image/jpeg';
 if(b.length>=6&&(starts(b,[0x47,0x49,0x46,0x38,0x37,0x61])||starts(b,[0x47,0x49,0x46,0x38,0x39,0x61])))return 'image/gif';
 if(b.length>=12&&starts(b,[0x52,0x49,0x46,0x46])&&starts(b,[0x57,0x45,0x42,0x50],8))return 'image/webp';
 return null;}

// Files named by their SHA-256 in one folder (tests, or a local copy of the archive).
export const dirContent=dir=>async o=>{const f=join(dir,o.bodySha256);return existsSync(f)?{bytes:readFileSync(f),sensitive:false}:null;};
// The public Mordinals archive: find the item by registration transaction and hash, then fetch its file.
export function archiveContent(base='https://xmr20.org/api/mordinals',{fetch:f=fetch,timeout=20000}={}){
 return async o=>{
  const c=await f(`${base}?route=catalog&q=${o.registrationTx}`,{signal:AbortSignal.timeout(timeout)});if(!c.ok)throw Error('The archive answered HTTP '+c.status);
  const item=((await c.json()).items||[]).find(i=>i.txid===o.registrationTx&&i.sha256===o.bodySha256);if(!item||!Number.isInteger(item.id))return null;
  const r=await f(`${base}?route=file&id=${item.id}&sha=${o.bodySha256}`,{signal:AbortSignal.timeout(timeout)});if(!r.ok)throw Error('The archive answered HTTP '+r.status);
  return {bytes:Buffer.from(await r.arrayBuffer()),sensitive:Boolean(item.sensitive)};};}

// -> get(ownerEntry) = {status:200, type, bytes, sensitive} | {status:404|415|502, error}
export function createContent({source,maxBytes=2097152,keep=200}){
 const cache=new Map();
 return async function get(o){
  if(!o?.bodySha256||!source)return {status:404,error:'No picture is known for this Mordinal.'};
  if(o.bodySize>maxBytes)return {status:415,error:'This content is too large to show.'};
  const hit=cache.get(o.bodySha256);if(hit){cache.delete(o.bodySha256);cache.set(o.bodySha256,hit);return hit;}
  let found;try{found=await source(o);}catch(e){return {status:502,error:String(e.message).slice(0,200)};}
  if(!found)return {status:404,error:'No picture is known for this Mordinal.'};
  const bytes=Buffer.from(found.bytes);let out;
  if(bytes.length!==o.bodySize||createHash('sha256').update(bytes).digest('hex')!==o.bodySha256)out={status:502,error:'The stored content does not match the inscription.'};
  else{const type=pictureType(bytes);out=type?{status:200,type,bytes,sensitive:Boolean(found.sensitive)}:{status:415,error:'This Mordinal is not a picture.'};}
  if(out.status!==502){cache.set(o.bodySha256,out);if(cache.size>keep)cache.delete(cache.keys().next().value);}
  return out;};}
