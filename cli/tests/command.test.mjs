// The xmr721 command as real processes: stop signals, and several commands at once on one wallet folder. A stand-in for
// the carrier tool (a small script that answers like it, slowly when told to) and one local server that plays reader
// and node. Nothing here talks to a network beyond this machine.
//   node --test cli/tests/command.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,existsSync,mkdirSync,chmodSync,readdirSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ed25519} from '@noble/curves/ed25519';
import {le,leBytes,hex} from '../../rules/lib/monero.mjs';

const dirs=[];test.after(()=>{for(const d of dirs)rmSync(d,{recursive:true,force:true});});
const temp=()=>{const d=mkdtempSync(join(tmpdir(),'xmr721-command-'));dirs.push(d);return d;};
const L=ed25519.CURVE.n,scalar=()=>{for(;;){const s=le(randomBytes(32))%L;if(s)return hex(leBytes(s));}};
const BIN=join(import.meta.dirname,'..','xmr721.mjs'),DOMAIN='7c'.repeat(32),sleep=ms=>new Promise(r=>setTimeout(r,ms));

// The stand-in tool: `<wallet folder> <operation> [argument]`, one JSON line as the real tool prints. It writes what it
// was asked into tool.log in the wallet folder and waits as long as slow.json there says.
const TOOL=`#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const [dir,op,arg]=process.argv.slice(2),log=t=>fs.appendFileSync(path.join(dir,'tool.log'),t+' '+Date.now()+'\\n');
let slow={};try{slow=JSON.parse(fs.readFileSync(path.join(dir,'slow.json'),'utf8'));}catch{}
log(op+' start');
setTimeout(()=>{
 let result;
 if(op==='status')result={address:'x',tip:10,balance:'30000000000',coins:3,ready:3,payments:[]};
 else if(op==='carry'||op==='split'){const txid=crypto.createHash('sha256').update(String(arg)+Date.now()).digest('hex');result={txid,blob:Buffer.from(JSON.stringify({txid})).toString('hex'),fee:'30000000',extraBytes:100,bytes:2000};}
 else if(op==='publish')result={txid:JSON.parse(Buffer.from(arg,'hex').toString('utf8')).txid};
 else{console.log(JSON.stringify({error:'Unknown operation'}));process.exit(1);}
 log(op+' end');console.log(JSON.stringify({result}));
},slow[op]||0);
`;
// One server as reader and node: an open ledger at block 10, a node at block 10 that knows no transaction.
function serve({infoDelay=0}={}){
 const s=createServer(async(req,res)=>{let body='';for await(const p of req)body+=p;const send=(v,code=200)=>{res.writeHead(code,{'content-type':'application/json'});res.end(JSON.stringify(v));};
  if(req.url==='/info'){await sleep(infoDelay);return send({network:'stagenet',domain:DOMAIN,height:10,mintFrom:5});}
  if(req.url==='/json_rpc')return send({result:{height:11,top_block_hash:'ab'.repeat(32),nettype:'stagenet',offline:false,synchronized:true}});
  if(req.url==='/get_transactions')return send({status:'OK',txs:[]});
  send({error:'not here'},404);});
 return new Promise(done=>s.listen(0,'127.0.0.1',()=>done({url:'http://127.0.0.1:'+s.address().port,close:()=>new Promise(r=>{s.closeAllConnections?.();s.close(r);})})));}
function walletDir(slow={}){
 const dir=join(temp(),'wallet');mkdirSync(dir,{mode:0o700});writeFileSync(join(dir,'carrier.keys.json'),JSON.stringify({spend:scalar(),view:scalar()}),{mode:0o600});
 writeFileSync(join(dir,'wallet.json'),JSON.stringify({network:'stagenet',start:5}));writeFileSync(join(dir,'slow.json'),JSON.stringify(slow));
 const tool=join(dir,'..','tool.js');writeFileSync(tool,TOOL);chmodSync(tool,0o755);return {dir,tool};}
const run=(w,url,args)=>{const c=spawn(process.execPath,[BIN,'wallet',...args,'--wallet',w.dir,'--network','stagenet','--reader',url,'--node',url,'--domain',DOMAIN,'--carrier',w.tool],{stdio:['ignore','pipe','pipe']});
 let out='',err='';c.stdout.on('data',d=>out+=d);c.stderr.on('data',d=>err+=d);const began=Date.now();
 return {child:c,done:new Promise(r=>c.on('exit',(code,signal)=>r({code,signal,out,err,ms:Date.now()-began})))};};
const toolLog=w=>existsSync(join(w.dir,'tool.log'))?readFileSync(join(w.dir,'tool.log'),'utf8').split('\n').filter(Boolean).map(l=>l.split(' ').slice(0,2).join(' ')):[];
const journal=w=>existsSync(join(w.dir,'journal.json'))?JSON.parse(readFileSync(join(w.dir,'journal.json'),'utf8')):{entries:[]};
const until=async(what,ms=8000)=>{const t=Date.now();while(!what()){if(Date.now()-t>ms)throw Error('waited too long');await sleep(20);}};

test('a stop signal stops the command at once while nothing is in hand, and nothing is built',async()=>{
 const s=await serve({infoDelay:1500}),w=walletDir(),file=join(w.dir,'..','note.txt');writeFileSync(file,'a note');
 try{
  for(const signal of ['SIGINT','SIGTERM']){
   const r=run(w,s.url,['inscribe','--file',file]);await sleep(500);r.child.kill(signal);const e=await r.done;
   assert.deepEqual([e.code,e.ms<1400,toolLog(w),journal(w).entries.length],[130,true,[],0],signal+': '+e.err);}
  // The lock it held is left behind and is taken over by the next command.
  assert.ok(readdirSync(w.dir).includes('lock'));const next=await run(w,s.url,['balance']).done;assert.equal(next.code,0,next.err);assert.ok(!readdirSync(w.dir).some(f=>f.startsWith('lock')));
 }finally{await s.close();}});

test('a stop signal while the tool builds lets that one step finish and be written down, and then the command stops',async()=>{
 const s=await serve(),w=walletDir({carry:1200}),file=join(w.dir,'..','note.txt');writeFileSync(file,'a note');
 try{
  const r=run(w,s.url,['inscribe','--file',file]);await until(()=>toolLog(w).includes('carry start'));
  r.child.kill('SIGINT');await sleep(100);r.child.kill('SIGINT');const e=await r.done;
  // The transaction the tool built is kept ("built"); it was not handed to the node, and nothing else was begun.
  assert.deepEqual([e.code,toolLog(w),journal(w).entries.map(x=>[x.kind,x.state,Boolean(x.blob)])],[130,['status start','status end','carry start','carry end'],[['mint','built',true]]],e.err);
  assert.match(e.err,/A transaction is in hand: finishing this one step and writing it down, then stopping/);
  // The next command sends that same transaction: nothing is built again.
  const again=await run(w,s.url,['inscribe','--file',file]).done;assert.equal(again.code,0,again.err);
  assert.deepEqual([JSON.parse(again.out).again,toolLog(w).filter(l=>l==='carry start').length,journal(w).entries[0].state],[true,1,'sent']);
  // Stopped while the transaction is being handed to the node: that step is finished too.
  const w2=walletDir({publish:1200}),r2=run(w2,s.url,['inscribe','--file',file]);await until(()=>toolLog(w2).includes('publish start'));r2.child.kill('SIGTERM');const e2=await r2.done;
  assert.deepEqual([e2.code,journal(w2).entries.map(x=>x.state)],[130,['sent']],e2.err);
 }finally{await s.close();}});

test('several commands at once on one folder, also with a lock left over: one at a time works, the others are told to wait',async()=>{
 const s=await serve(),w=walletDir({status:400});
 try{
  for(const leftOver of [false,true]){
   writeFileSync(join(w.dir,'tool.log'),'');if(leftOver)writeFileSync(join(w.dir,'lock'),JSON.stringify({pid:2147483646,token:'0123456789abcdef',since:'x'}));
   const all=await Promise.all(Array.from({length:8},()=>run(w,s.url,['balance']).done)),ok=all.filter(e=>e.code===0),waited=all.filter(e=>e.code===2);
   assert.equal(ok.length+waited.length,8);assert.ok(ok.length>=1,all.map(e=>e.err).join('|'));
   for(const e of waited)assert.match(e.err,/Another xmr721 command is working on this wallet/);
   // The tool was never run by two commands at the same time: every start is followed by its end.
   const steps=readFileSync(join(w.dir,'tool.log'),'utf8').split('\n').filter(Boolean).map(l=>l.split(' ')[1]);
   assert.deepEqual(steps,Array.from({length:ok.length},()=>['start','end']).flat(),'left over: '+leftOver);
   assert.ok(!readdirSync(w.dir).some(f=>f.startsWith('lock')),readdirSync(w.dir).join(' '));}
 }finally{await s.close();}});
