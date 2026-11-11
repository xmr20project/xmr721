// How an MD1 record rides in a Monero transaction (RULES.md section 8). Same framing as XMR20 records:
//   tx_extra = 01 <transaction public key 32>  [02 09 01 <payment id 8>]  then per chunk: 02 <length varint> 7f <chunk>
// The record is cut into 254-byte chunks (the last may be shorter). A transaction carries a record only when its tx_extra
// parses exactly this way and the joined chunks start with "MD1" 0xfe. Anything else is not a record and is skipped.
import {MAGIC} from '../../rules/lib/records.mjs';
export const EXTRA_LIMIT=1060,CHUNK=254,MAX_RECORD=1000;

// tx_extra bytes -> the record bytes, or null when this transaction carries no MD1 record.
export function unframe(extra){
 const e=extra instanceof Uint8Array?extra:Uint8Array.from(extra||[]);
 if(e.length>EXTRA_LIMIT)return null;
 let at=0,pubkeys=0,paymentIds=0;const chunks=[];
 while(at<e.length){
  const tag=e[at++];
  // The order is fixed: the public key first, then a payment id if there is one, then the chunks and nothing after them.
  if(tag===1){if(++pubkeys!==1||at!==1||at+32>e.length)return null;at+=32;continue;}
  if(tag!==2)return null;
  let len=0,shift=0;
  for(;;){if(at>=e.length||shift>7)return null;const n=e[at++];len|=(n&127)<<shift;if(n<128){if(shift!==0&&n===0)return null;break;}shift+=7;}
  if(len<1||len>255||at+len>e.length)return null;
  const d=e.subarray(at,at+len);at+=len;
  if(d[0]===127)chunks.push(d.subarray(1));
  else if(++paymentIds!==1||chunks.length||d[0]!==1||d.length!==9)return null;}
 if(pubkeys!==1||!chunks.length)return null;
 const size=chunks.reduce((n,c)=>n+c.length,0);if(size<5||size>MAX_RECORD)return null;
 // Canonical chunking: every chunk is full except the last, and none is empty.
 if(chunks.length!==Math.ceil(size/CHUNK)||chunks.some((c,i)=>c.length!==(i<chunks.length-1?CHUNK:size-CHUNK*(chunks.length-1))))return null;
 const record=new Uint8Array(size);let o=0;for(const c of chunks){record.set(c,o);o+=c.length;}
 return MAGIC.every((b,i)=>record[i]===b)?record:null;}

// The tx_extra a carrier transaction has for this record (tests and size checks; the relay's wallet tool frames the same way).
export function frame(record,txPub,{paymentId=null}={}){
 if(record.length<5||record.length>MAX_RECORD)throw Error('Record size out of range');if(txPub.length!==32)throw Error('Transaction public key required');
 const out=[1,...txPub];if(paymentId){if(paymentId.length!==8)throw Error('Payment id is 8 bytes');out.push(2,9,1,...paymentId);}
 for(let i=0;i<record.length;i+=CHUNK){const c=record.subarray(i,i+CHUNK),l=c.length+1;out.push(2);if(l<128)out.push(l);else out.push((l&127)|128,l>>7);out.push(127,...c);}
 if(out.length>EXTRA_LIMIT)throw Error('The record does not fit a standard transaction');return Uint8Array.from(out);}
