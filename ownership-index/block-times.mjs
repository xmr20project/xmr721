// Writes result/block-times.json: the timestamp of every Monero block that holds a registration (owners.jsonl,
// added/added.jsonl) or a transfer (transfers.jsonl) of the index. The reader shows these as the dates of the
// original Mordinals history. Read-only: it only asks a Monero node for block headers.
//   node ownership-index/block-times.mjs http://127.0.0.1:18081
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const here=import.meta.dirname,node=process.argv[2];
if(!/^https?:\/\//.test(node||''))throw Error('usage: node ownership-index/block-times.mjs <monero node url>');
const lines=f=>readFileSync(join(here,f),'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l));
const heights=new Set([...lines('result/owners.jsonl'),...lines('added/added.jsonl')].map(o=>o.registrationHeight).filter(Number.isInteger));
for(const t of lines('result/transfers.jsonl'))heights.add(t.height);
const want=[...heights].sort((a,b)=>a-b),times={};
const call=async(method,params)=>{const r=await fetch(node+'/json_rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'0',method,params})});const v=await r.json();if(v.error)throw Error(v.error.message);return v.result;};
for(const start of [...new Set(want.map(h=>Math.floor(h/1000)*1000))]){
 const r=await call('get_block_headers_range',{start_height:start,end_height:start+999});
 for(const b of r.headers)if(heights.has(b.height))times[b.height]=b.timestamp;}
const missing=want.filter(h=>times[h]==null);if(missing.length)throw Error('The node did not return '+missing.length+' blocks');
writeFileSync(join(here,'result/block-times.json'),JSON.stringify({about:'Timestamps (unix seconds, as the miner wrote them) of every Monero block that holds a Mordinals registration or a transfer of the index. Rebuild: node ownership-index/block-times.mjs <node url>.',blocks:want.length,times:Object.fromEntries(want.map(h=>[h,times[h]]))})+'\n');
console.log('block-times.json:',want.length,'blocks');
