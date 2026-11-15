// Pictures and short texts. A Mordinal's content is the bytes inscribed in its registration transaction. The owner list
// carries the SHA-256 of those bytes, so content from any source can be checked before it is shown: this module only
// passes on bytes whose hash and size match the owner list and whose first bytes are a plain picture format, or that
// are a short plain text (plainText below), which pages show as text, never as markup.
// Other content (HTML, SVG, anything else) is never served for display.
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

// The content as text, or null. Plain text is UTF-8 of at most TEXT_MAX bytes with at least one character that shows,
// and no character that could hide or change how other text reads: no control character but tab, line feed and
// carriage return; no format character (direction marks, overrides and isolates, the Arabic letter mark, invisible
// separators, tag characters, a byte order mark past the start; the decoder drops one at the start) except the
// zero-width joiner and non-joiner that emoji and some scripts need; no line or paragraph separator; nothing private,
// unassigned or a noncharacter.
export const TEXT_MAX=4096;
const BARRED=/[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/u,ALLOWED=new Set([9,10,13,0x200c,0x200d]);
// What shows nothing: white space, format characters, combining marks alone, and the blank letters (Hangul fillers,
// the blank braille pattern).
const NOTHING=/[\p{White_Space}\p{Cf}\p{M}]/u,BLANK=new Set([0x115f,0x1160,0x3164,0xffa0,0x2800]);
// Not shown as text either: a markup document (SVG, HTML, XML: its source is not what it was made to look like), and
// the antivirus test string, which security software on a visitor's computer reports as a virus.
const MARKUP=/^<[\s\S]*>$/,EICAR='EICAR-STANDARD-ANTIVIRUS-TEST-FILE';
export function plainText(b){
 if(!b.length||b.length>TEXT_MAX)return null;
 let s;try{s=new TextDecoder('utf-8',{fatal:true}).decode(b);}catch{return null;}
 if(MARKUP.test(s.trim())||s.includes(EICAR))return null;
 let shows=false;
 for(const ch of s){const c=ch.codePointAt(0);
  if(!ALLOWED.has(c)&&BARRED.test(ch))return null;
  if(!shows&&!NOTHING.test(ch)&&!BLANK.has(c))shows=true;}
 return shows?s:null;}

// Files named by their SHA-256 in one folder (tests, or a local copy of the archive). A content-flags.json beside the
// folder ({"sha256": [...]}) names pictures a person reviewed as sensitive; pages hide those until asked.
export const dirContent=dir=>{
 const flags=join(dir,'..','content-flags.json'),hidden=new Set(existsSync(flags)?JSON.parse(readFileSync(flags,'utf8')).sha256||[]:[]);
 return async o=>{const f=join(dir,o.bodySha256);return existsSync(f)?{bytes:readFileSync(f),sensitive:hidden.has(o.bodySha256)}:null;};};
// The public Mordinals archive: find the item by registration transaction and hash, then fetch its file.
export function archiveContent(base='https://xmr20.org/api/mordinals',{fetch:f=fetch,timeout=20000}={}){
 return async o=>{
  const c=await f(`${base}?route=catalog&q=${o.registrationTx}`,{signal:AbortSignal.timeout(timeout)});if(!c.ok)throw Error('The archive answered HTTP '+c.status);
  const item=((await c.json()).items||[]).find(i=>i.txid===o.registrationTx&&i.sha256===o.bodySha256);if(!item||!Number.isInteger(item.id))return null;
  const r=await f(`${base}?route=file&id=${item.id}&sha=${o.bodySha256}`,{signal:AbortSignal.timeout(timeout)});if(!r.ok)throw Error('The archive answered HTTP '+r.status);
  return {bytes:Buffer.from(await r.arrayBuffer()),sensitive:Boolean(item.sensitive)};};}

// -> get(ownerEntry) = {status:200, type, bytes, sensitive} | {status:415, error, text?, bytes?, sensitive?} | {status:404|502, error}
// A 415 carries text, bytes and sensitive when the content is plain text: still not a picture, but it can be shown as text.
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
  else{const type=pictureType(bytes),text=type?null:plainText(bytes);
   out=type?{status:200,type,bytes,sensitive:Boolean(found.sensitive)}
    :{status:415,error:'This Mordinal is not a picture.',...(text!=null?{text,bytes,sensitive:Boolean(found.sensitive)}:{})};}
  if(out.status!==502){cache.set(o.bodySha256,out);if(cache.size>keep)cache.delete(cache.keys().next().value);}
  return out;};}
