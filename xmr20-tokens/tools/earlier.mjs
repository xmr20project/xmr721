// The list of earlier XMR20 deploy inscriptions (../EARLIER.md), made from the chain and checked against it.
//
//   node xmr20-tokens/tools/earlier.mjs scan --node <url> --from <height> --to <height> --deployer <address>[,…] --out <dir>
//        reads every block of the range from a Monero node, in order, and writes the deploy inscriptions signed by the
//        given addresses: <dir>/deploys.jsonl and <dir>/list.json. A stopped scan goes on where it was (<dir>/scan.json).
//   node xmr20-tokens/tools/earlier.mjs check --node <url> [--dir xmr20-tokens/earlier]
//        reads every listed transaction again from a node and compares it with the list: its block, its inscribed text.
//        It shows that what is listed is on the chain as listed; only a scan of the whole range shows that nothing was
//        left out.
// Any node answers these questions; use your own to trust nobody for what is in the blocks.
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync,appendFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {createChain} from '../../reader/lib/chain.mjs';
import {readEarlier,loadEarlier,canonical} from '../lib/earlier.mjs';

const arg=name=>{const i=process.argv.indexOf('--'+name);return i<0?null:process.argv[i+1];};
const stop=text=>{console.error(text);process.exit(2);};
const sha=text=>createHash('sha256').update(text).digest('hex');
const HERE=join(import.meta.dirname,'..','earlier');

// The deploy inscriptions of one block, in block order.
export async function deploysOf(chain,height,deployers){
 const b=await chain.block(height),got=b.txids.length?await chain.txs(b.txids):new Map(),out=[];
 for(const txid of b.txids){const t=got.get(txid);if(!t||t.inPool||t.height!==height)throw Error(`The node did not give transaction ${txid} of block ${height}.`);
  const e=readEarlier(t.tx.extra);if(e&&deployers.has(e.record.owner))out.push({txid,height,time:b.time,text:e.text});}
 return {hash:b.hash,deploys:out};}

async function scan(){
 const node=arg('node'),from=Number(arg('from')),to=Number(arg('to')),deployers=(arg('deployer')||'').split(',').filter(Boolean),dir=arg('out');
 if(!node||!dir||!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||from<1||to<from||!deployers.length)stop('scan --node <url> --from <height> --to <height> --deployer <address>[,…] --out <dir>');
 const chain=createChain(node,{timeout:60000}),set=new Set(deployers),state=join(dir,'scan.json'),file=join(dir,'deploys.jsonl');mkdirSync(dir,{recursive:true});
 let s=existsSync(state)?JSON.parse(readFileSync(state,'utf8')):{from,to,deployers,next:from,count:0};
 if(s.from!==from||s.to!==to||s.deployers.join()!==deployers.join())stop('This folder holds a scan of another range or of other deployers.');
 if(s.next===from)writeFileSync(file,'');
 const tip=(await chain.info()).height;if(to>tip)stop(`The node is at block ${tip}; the range ends at ${to}.`);
 let hash=null;
 for(let h=s.next;h<=to;){
  // A few blocks at a time, written in order.
  const batch=[];for(let k=h;k<=to&&k<h+6;k++)batch.push(k);
  const done=await Promise.all(batch.map(k=>deploysOf(chain,k,set)));
  const lines=done.flatMap(d=>d.deploys.map(x=>JSON.stringify(x)+'\n'));if(lines.length)appendFileSync(file,lines.join(''));
  hash=done.at(-1).hash;h=batch.at(-1)+1;s={...s,next:h,count:s.count+lines.length};writeFileSync(state+'.new',JSON.stringify(s));renameSync(state+'.new',state);
  if((h-from)%600<6)console.log(new Date().toISOString(),`block ${h-1} of ${to}, ${s.count} deploys`);}
 hash??=(await chain.header(to)).hash;
 const text=readFileSync(file,'utf8');
 writeFileSync(join(dir,'list.json'),JSON.stringify({format:'xmr20-earlier-deploys-v1',network:'mainnet',deployers,from,to,toHash:hash,count:text.split('\n').filter(Boolean).length,sha256:sha(text)},null,1)+'\n');
 console.log(`done: ${s.count} deploys in blocks ${from} to ${to}`);}

async function check(){
 const node=arg('node'),dir=arg('dir')||HERE;if(!node)stop('check --node <url> [--dir <dir>]');
 const chain=createChain(node,{timeout:60000}),list=loadEarlier(dir),raw=readFileSync(join(dir,'deploys.jsonl'),'utf8');
 const problems=[];if(sha(raw)!==list.header.sha256)problems.push('deploys.jsonl is not the file its header names.');
 const end=await chain.header(list.header.to);if(list.header.toHash&&end.hash!==list.header.toHash)problems.push(`The node has another block ${list.header.to} than the list was made on.`);
 const got=await chain.txs(list.deploys.map(d=>d.txid));
 for(const d of list.deploys){const t=got.get(d.txid);
  if(!t||t.inPool){problems.push(`${d.txid}: the node does not have it in a block.`);continue;}
  if(t.height!==d.height){problems.push(`${d.txid}: in block ${t.height}, listed in ${d.height}.`);continue;}
  const e=readEarlier(t.tx.extra);
  if(!e||e.text!==canonical({record:d.record,signature:d.signature}))problems.push(`${d.txid}: the node's transaction does not hold the listed inscription.`);}
 console.log(problems.length?problems.slice(0,20).join('\n'):`all ${list.deploys.length} listed inscriptions are on the node's chain as listed (${list.tokens.length} tokens; blocks ${list.header.from} to ${list.header.to})`);
 process.exit(problems.length?1:0);}

if(process.argv[1]===import.meta.filename){
 const what=process.argv[2];
 if(what==='scan')await scan();else if(what==='check')await check();else stop('scan or check; see the top of this file.');}
