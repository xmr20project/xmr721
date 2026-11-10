#!/usr/bin/env node
// Builds the owner-list entry for the video inscription in the mining reward transaction of block 3,799,494.
// It is not a Mordinal under the original rules (those read the 0x10 field of ordinary transactions); this ledger
// adds it as one extra entry after the original 42,894. See ../README.md, "Added entry".
//
//   node ownership-index/added/video-entry.mjs --node <monero node url> [--number 42894] [--save-video <file>]
//
// The transaction is read from the node and checked here: its id, its block, the payload format, the video's size
// and SHA-256. Prints the entry as one JSON line.
import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {keccak_256} from '@noble/hashes/sha3';

const TXID='5aaa33278d1c4f318ffc8512ea5466440a6023f7087998b31ad011ed42920f9b',HEIGHT=3799494;
const VIDEO={bytes:598000,sha256:'d8bc3647700fc9c07f6d5ea37bc6d4328ffa0d5c1a888b614116769380e3be6c'};
const arg=name=>{const i=process.argv.indexOf('--'+name);return i<0?null:process.argv[i+1];};
const hex=b=>Buffer.from(b).toString('hex'),need=(ok,what)=>{if(!ok)throw Error(what);};

function varint(b,at){let v=0,shift=0;for(;;){const x=b[at++];v+=(x&127)*2**shift;shift+=7;if(!(x&128))return [v,at];}}
// tx_extra: 0x01 key(32), 0x02 nonce, then the 0xDE field that runs to the end and holds
// "XMR20VIDEO1" | u32le n | n bytes of JSON | the video | zero padding.
export function parse(extra){
 const b=Buffer.from(extra);let at=0,txPub=null,payload=null;
 while(at<b.length){const tag=b[at++];
  if(tag===1){txPub=b.subarray(at,at+32);at+=32;}
  else if(tag===2){const [n,next]=varint(b,at);at=next+n;}
  else if(tag===0xde){const [n,next]=varint(b,at);need(next+n===b.length,'The 0xDE field does not end the extra data');payload=b.subarray(next,next+n);at=next+n;}
  else throw Error('Unexpected field 0x'+tag.toString(16));}
 need(txPub&&payload,'Transaction key or payload missing');
 need(payload.subarray(0,11).toString('latin1')==='XMR20VIDEO1','Not an XMR20VIDEO1 payload');
 const n=payload.readUInt32LE(11),meta=JSON.parse(payload.subarray(15,15+n).toString('utf8')),video=payload.subarray(15+n,15+n+VIDEO.bytes);
 need(payload.subarray(15+n+VIDEO.bytes).every(x=>x===0),'Bytes after the video are not padding');
 return {txPub:hex(txPub),meta,video};}

if(process.argv[1]===import.meta.filename){
 const node=arg('node');if(!node){console.error('Usage: node video-entry.mjs --node <monero node url> [--number 42894] [--save-video <file>]');process.exit(2);}
 const r=await fetch(node.replace(/\/$/,'')+'/get_transactions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({txs_hashes:[TXID],decode_as_json:true,prune:true})});
 const t=(await r.json()).txs?.[0];need(t&&t.tx_hash===TXID&&!t.in_pool&&t.block_height===HEIGHT,'The node does not have this transaction in block '+HEIGHT);
 const tx=JSON.parse(t.as_json);need(tx.vin.length===1&&tx.vin[0].gen?.height===HEIGHT&&tx.vout.length===1,'Not the mining reward transaction of block '+HEIGHT);
 const {txPub,meta,video}=parse(tx.extra),out=tx.vout[0].target.tagged_key;
 need(video.length===VIDEO.bytes&&createHash('sha256').update(video).digest('hex')===VIDEO.sha256,'The video does not match');
 if(arg('save-video'))writeFileSync(arg('save-video'),video);
 console.log(JSON.stringify({number:Number(arg('number')??42894),registrationTx:TXID,registrationHeight:HEIGHT,bodySha256:VIDEO.sha256,bodyKeccak256:hex(keccak_256(video)),bodySize:video.length,
  moves:0,ownerTx:TXID,ownerHeight:HEIGHT,ownerOutputIndex:t.output_indices[0],ownerOutputKey:out.key,ownerViewTag:out.view_tag,ownerTxPubKeys:[txPub],ownerAdditionalPubKeys:[],
  added:{format:'XMR20VIDEO1',type:meta.mime??'video/mp4',title:meta.title??null,miningReward:true}}));}
