// The acceptance rules of the 2023 Mordinals indexer for a transfer ("update"), written again from its source
// (src/cryptonote_core/inscriptions_container.cpp and src/cryptonote_basic/tx_extra.h of github.com/mooonero/mordinals),
// for the tests of claiming by burning: whatever XMR721 accepts as a burn claim, these rules must read as a transfer of
// the same output. The dead range and the fee rule's first block are constants there and parameters here.
export const recordCost=size=>{const fee=BigInt(size)*4000000n,mask=1000000000n;return (fee+mask-1n)/mask*mask;};
const varint=(e,at)=>{let v=0n;for(let shift=0n;;shift+=7n){if(at.i>=e.length)throw Error('varint');const b=e[at.i++];if(b===0&&shift)throw Error('varint');v|=BigInt(b&0x7f)<<shift;if(!(b&0x80))return Number(v);}};
const bytes=(e,at,n)=>{if(at.i+n>e.length)throw Error('short');const v=e.subarray(at.i,at.i+n);at.i+=n;return v;};
const string=(e,at)=>bytes(e,at,varint(e,at));
// parse_tx_extra: fields in order; an unknown tag or a short field stops the parse (ok = false) and keeps the fields read so far.
export function parseExtra(extra){const e=Uint8Array.from(extra),fields=[],at={i:0};let ok=true;
 try{while(at.i<e.length){const tag=e[at.i++];
  if(tag===0x00){const rest=e.subarray(at.i);if(rest.length>254||rest.some(b=>b))throw Error('padding');fields.push({tag});at.i=e.length;}
  else if(tag===0x01)fields.push({tag,key:bytes(e,at,32)});
  else if(tag===0x02){const n=varint(e,at);if(n>255)throw Error('nonce');fields.push({tag,nonce:bytes(e,at,n)});}
  else if(tag===0x03)fields.push({tag,data:string(e,at)});
  else if(tag===0x04){const n=varint(e,at);fields.push({tag,keys:bytes(e,at,32*n)});}
  else if(tag===0xde)fields.push({tag,data:string(e,at)});
  else if(tag===0x10)fields.push({tag,img:string(e,at),meta:string(e,at)});
  else if(tag===0x11)fields.push({tag,meta:string(e,at)});
  else if(tag===0x12)fields.push({tag,img:string(e,at),next:bytes(e,at,32),sz:varint(e,at),count:varint(e,at)});
  else if(tag===0x13)fields.push({tag,origin:bytes(e,at,32),img:string(e,at),next:bytes(e,at,32)});
  else throw Error('unknown tag');}}
 catch{ok=false;}
 return {ok,fields};}
// on_push_transaction for a transaction that registers nothing: which output it moves, and the text, or why it moves none.
// tx: {extra: [bytes], inputs: [[key offsets]], fee}. holds(output): does that output hold an inscription.
export function transferOf(tx,{deadAbove,deadBelow,holds=()=>true}){
 const {ok,fields}=parseExtra(tx.extra);if(!ok&&!fields.length)return {moved:null,why:'extra not parsed'};
 if(fields.some(f=>f.tag===0x10))return {moved:null,why:'a registration'};
 const upd=fields.find(f=>f.tag===0x11);if(!upd)return {moved:null,why:'no transfer field'};
 if(BigInt(tx.fee)<recordCost(upd.meta.length))return {moved:null,why:'fee below the record cost'};
 for(const offsets of tx.inputs){let at=0,dead=0,other=0;for(const o of offsets){at+=o;if(at>deadAbove&&at<deadBelow)dead++;else other=at;}
  if(dead!==offsets.length-1)continue;
  return holds(other)?{moved:other,text:Buffer.from(upd.meta).toString('latin1')}:{moved:null,why:'output holds no inscription'};}
 return {moved:null,why:'no input with a dead-key ring'};}
