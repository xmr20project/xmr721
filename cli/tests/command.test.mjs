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
import {createTool} from '../lib/tool.mjs';
import {openLock} from '../lib/lock.mjs';

const dirs=[];test.after(()=>{for(const d of dirs)rmSync(d,{recursive:true,force:true});});
const temp=()=>{const d=mkdtempSync(join(tmpdir(),'xmr721-command-'));dirs.push(d);return d;};
const L=ed25519.CURVE.n,scalar=()=>{for(;;){const s=le(randomBytes(32))%L;if(s)return hex(leBytes(s));}};
const BIN=join(import.meta.dirname,'..','xmr721.mjs'),DOMAIN='7c'.repeat(32),sleep=ms=>new Promise(r=>setTimeout(r,ms));

// The stand-in tool: `<wallet folder> <operation> [argument]`, one JSON line as the real tool prints. It writes what it
// was asked into tool.log in the wallet folder (with its process id) and waits as long as slow.json there says.
const TOOL=`#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const [dir,op,arg]=process.argv.slice(2),log=t=>fs.appendFileSync(path.join(dir,'tool.log'),t+' '+Date.now()+' '+process.pid+'\\n');
let slow={};try{slow=JSON.parse(fs.readFileSync(path.join(dir,'slow.json'),'utf8'));}catch{}
log(op+' start');fs.appendFileSync(path.join(dir,'tool.env'),String(process.env.MORDINALS_START)+'\\n');
setTimeout(()=>{
 let result;
 if(op==='status')result={address:'x',tip:10,balance:'30000000000',coins:3,ready:3,payments:[]};
 else if(op==='carry'||op==='split'){const txid=crypto.createHash('sha256').update(String(arg)+Date.now()).digest('hex');result={txid,blob:Buffer.from(JSON.stringify({txid})).toString('hex'),fee:'30000000',extraBytes:100,bytes:2000};}
 else{console.log(JSON.stringify({error:'Unknown operation'}));process.exit(1);}
 log(op+' end');console.log(JSON.stringify({result}));
},slow[op]||0);
`;
// One server as reader and node: an open ledger at block 10, a node at block 10 that knows no transaction and takes
// every transaction it is handed (after `sendDelay`).
function serve({infoDelay=0,sendDelay=0}={}){
 const sends=[];let infos=0;
 const s=createServer(async(req,res)=>{let body='';for await(const p of req)body+=p;const send=(v,code=200)=>{res.writeHead(code,{'content-type':'application/json'});res.end(JSON.stringify(v));};
  if(req.url==='/info'){infos++;await sleep(infoDelay);return send({network:'stagenet',domain:DOMAIN,height:10,mintFrom:5});}
  if(req.url==='/json_rpc')return send({result:{height:11,top_block_hash:'ab'.repeat(32),nettype:'stagenet',offline:false,synchronized:true}});
  if(req.url==='/get_transactions')return send({status:'OK',txs:[]});
  if(req.url==='/send_raw_transaction'){sends.push(JSON.parse(body).tx_as_hex);await sleep(sendDelay);return send({status:'OK'});}
  send({error:'not here'},404);});
 return new Promise(done=>s.listen(0,'127.0.0.1',()=>done({url:'http://127.0.0.1:'+s.address().port,sends,infos:()=>infos,close:()=>new Promise(r=>{s.closeAllConnections?.();s.close(r);})})));}
function walletDir(slow={}){
 const dir=join(temp(),'wallet');mkdirSync(dir,{mode:0o700});writeFileSync(join(dir,'carrier.keys.json'),JSON.stringify({spend:scalar(),view:scalar()}),{mode:0o600});
 writeFileSync(join(dir,'wallet.json'),JSON.stringify({network:'stagenet',start:5}));writeFileSync(join(dir,'slow.json'),JSON.stringify(slow));
 const tool=join(dir,'..','tool.js');writeFileSync(tool,TOOL);chmodSync(tool,0o755);return {dir,tool};}
const run=(w,url,args,{group=false}={})=>{const c=spawn(process.execPath,[BIN,'wallet',...args,'--wallet',w.dir,'--network','stagenet','--reader',url,'--node',url,'--domain',DOMAIN,'--carrier',w.tool],{stdio:['ignore','pipe','pipe'],detached:group});
 let out='',err='';c.stdout.on('data',d=>out+=d);c.stderr.on('data',d=>err+=d);const began=Date.now();
 // `signal` reaches the command alone; `terminal` reaches every process of its group, as Ctrl-C in a terminal does.
 return {child:c,signal:s=>c.kill(s),terminal:s=>process.kill(-c.pid,s),done:new Promise(r=>c.on('exit',(code,signal)=>r({code,signal,out,err,ms:Date.now()-began})))};};
const toolLog=w=>existsSync(join(w.dir,'tool.log'))?readFileSync(join(w.dir,'tool.log'),'utf8').split('\n').filter(Boolean).map(l=>l.split(' ').slice(0,2).join(' ')):[];
const toolPids=w=>existsSync(join(w.dir,'tool.log'))?readFileSync(join(w.dir,'tool.log'),'utf8').split('\n').filter(l=>/ start /.test(l)).map(l=>Number(l.split(' ')[3])):[];
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
const journal=w=>existsSync(join(w.dir,'journal.json'))?JSON.parse(readFileSync(join(w.dir,'journal.json'),'utf8')):{entries:[]};
const locks=w=>existsSync(join(w.dir,'lock'))?readdirSync(join(w.dir,'lock')):[];
const until=async(what,ms=8000)=>{const t=Date.now();while(!what()){if(Date.now()-t>ms)throw Error('waited too long');await sleep(20);}};

test('a stop signal stops the command at once while nothing is in hand: nothing is built, and a tool that reads the chain is ended',async()=>{
 const s=await serve({infoDelay:4000}),w=walletDir(),file=join(w.dir,'..','note.txt');writeFileSync(file,'a note');
 try{
  // (The command is waiting for the reader's answer, four seconds away, when the signal comes.)
  for(const signal of ['SIGINT','SIGTERM','SIGHUP']){
   const asked=s.infos(),r=run(w,s.url,['inscribe','--file',file]);await until(()=>s.infos()>asked);const at=Date.now();r.signal(signal);const e=await r.done;
   assert.deepEqual([e.code,Date.now()-at<2000,toolLog(w),journal(w).entries.length,locks(w)],[130,true,[],0,[]],signal+': '+e.err);}
  // The tool reads the chain (for as long as that takes) when the signal comes: the command stops at once and ends the
  // tool, so that nothing goes on working on the wallet, and leaves nothing in the lock.
  const slow=walletDir({status:6000}),r=run(slow,s.url,['balance'],{group:true});await until(()=>toolLog(slow).includes('status start'));
  const [pid]=toolPids(slow);assert.ok(alive(pid));r.terminal('SIGINT');const e=await r.done;
  assert.deepEqual([e.code,e.ms<5500,locks(slow)],[130,true,[]],e.err);await until(()=>!alive(pid),3000);assert.deepEqual(toolLog(slow),['status start']);
  writeFileSync(join(slow.dir,'slow.json'),'{}');const next=await run(slow,s.url,['balance']).done;assert.equal(next.code,0,next.err);assert.deepEqual(locks(slow),[]);
 }finally{await s.close();}});

test('a stop signal while a transaction is in hand lets that one step finish and be written down; a third one stops at once',async()=>{
 const s=await serve(),late=await serve({sendDelay:1200}),w=walletDir({carry:1200}),file=join(w.dir,'..','note.txt');writeFileSync(file,'a note');
 try{
  // Ctrl-C in a terminal goes to every process of the command's group. The tool is not one of them: it finishes.
  const r=run(w,s.url,['inscribe','--file',file],{group:true});await until(()=>toolLog(w).includes('carry start'));
  r.terminal('SIGINT');await sleep(100);r.terminal('SIGINT');const e=await r.done;
  // The transaction the tool built is kept ("built"); it was not handed to the node, and nothing else was begun.
  assert.deepEqual([e.code,toolLog(w),journal(w).entries.map(x=>[x.kind,x.state,Boolean(x.blob)]),locks(w),s.sends.length],[130,['status start','status end','carry start','carry end'],[['mint','built',true]],[],0],e.err);
  assert.match(e.err,/A transaction is in hand: finishing this one step and writing it down, then stopping\. \(Twice more stops at once\.\)\nStill finishing that step\./);
  // The next command hands that same transaction to the node: nothing is built again.
  const again=await run(w,s.url,['inscribe','--file',file]).done;assert.equal(again.code,0,again.err);
  assert.deepEqual([JSON.parse(again.out).again,toolLog(w).filter(l=>l==='carry start').length,journal(w).entries[0].state,s.sends.length],[true,1,'sent',1]);
  // The same with nowhere left to print to (the terminal was closed, or the output went to a program that is gone):
  // the step is finished all the same.
  const w1=walletDir({carry:1200}),r1=run(w1,s.url,['inscribe','--file',file],{group:true});await until(()=>toolLog(w1).includes('carry start'));
  r1.child.stderr.destroy();r1.child.stdout.destroy();r1.terminal('SIGHUP');await sleep(100);r1.terminal('SIGHUP');const e1=await r1.done;
  assert.deepEqual([e1.code,toolLog(w1).at(-1),journal(w1).entries.map(x=>x.state),locks(w1)],[130,'carry end',['built'],[]]);
  // Stopped while the transaction is being handed to the node: that step is finished too. It was written down as sent
  // before the node was handed it.
  const w2=walletDir(),r2=run(w2,late.url,['inscribe','--file',file],{group:true});await until(()=>late.sends.length===1);
  assert.deepEqual(journal(w2).entries.map(x=>x.state),['sent']);r2.terminal('SIGTERM');const e2=await r2.done;
  assert.deepEqual([e2.code,journal(w2).entries.map(x=>x.state),e2.ms>=1200],[130,['sent'],true],e2.err);
  // Three signals stop the command at once, also in the middle of a step, and end the tool. The next command says what
  // that means and goes on.
  const w3=walletDir({carry:6000}),r3=run(w3,s.url,['inscribe','--file',file],{group:true});await until(()=>toolLog(w3).includes('carry start'));
  const pid=toolPids(w3).at(-1);for(let i=0;i<3;i++){r3.terminal('SIGINT');await sleep(60);}const e3=await r3.done;
  assert.deepEqual([e3.code,e3.ms<5500,journal(w3).entries.map(x=>x.state),locks(w3)],[130,true,['building'],[]],e3.err);await until(()=>!alive(pid),3000);assert.ok(!toolLog(w3).includes('carry end'));
  writeFileSync(join(w3.dir,'slow.json'),'{}');const after=await run(w3,s.url,['balance']).done;
  assert.deepEqual([after.code,journal(w3).entries.length],[0,0],after.err);assert.match(after.err,/Note: A command stopped while a transaction was being built, and it is not known whether the tool built one\. Nothing was sent\./);
 }finally{await s.close();await late.close();}});

test('several commands at once on one folder: one at a time works, the others wait their turn; a killed command leaves its tool holding the wallet',async()=>{
 const s=await serve(),w=walletDir({status:400});
 try{
  for(const leftOver of [false,true]){
   writeFileSync(join(w.dir,'tool.log'),'');if(leftOver){mkdirSync(join(w.dir,'lock'),{recursive:true});writeFileSync(join(w.dir,'lock','2147483646-command-0123456789abcdef'),'');}
   const all=await Promise.all(Array.from({length:8},()=>run(w,s.url,['balance']).done)),ok=all.filter(e=>e.code===0),waited=all.filter(e=>e.code===2);
   assert.equal(ok.length+waited.length,8);assert.ok(ok.length>=2,all.map(e=>e.err).join('|'));
   for(const e of waited)assert.match(e.err,/^(Another xmr721 command is working on this wallet|The carrier tool of an xmr721 command that ended is still working)/);
   // The tool was never run by two commands at the same time: every start is followed by its end.
   const steps=readFileSync(join(w.dir,'tool.log'),'utf8').split('\n').filter(Boolean).map(l=>l.split(' ')[1]);
   assert.deepEqual(steps,Array.from({length:ok.length},()=>['start','end']).flat(),'left over: '+leftOver);
   assert.deepEqual(locks(w),[]);}
  // The command is killed outright while its tool works. The tool goes on, and holds the wallet until it is through:
  // a command that works on the wallet waits for it, and then says who holds the wallet and what to do if that is wrong.
  const k=walletDir({status:30000}),r=run(k,s.url,['balance']);await until(()=>toolLog(k).includes('status start'));
  const [pid]=toolPids(k);r.signal('SIGKILL');await r.done;assert.ok(alive(pid));
  const early=await run(k,s.url,['receive']).done;assert.equal(early.code,0,'a command that does not work on the wallet is not held up');
  const held=await run(k,s.url,['inscriptions']).done;assert.deepEqual([held.code,held.ms>=5000],[2,true]);
  assert.match(held.err,new RegExp(`^The carrier tool of an xmr721 command that ended is still working on this wallet \\(process ${pid}\\)\\. Try again when it is done\\. If process ${pid} is something else, remove the folder .*lock\n$`));
  process.kill(pid,'SIGKILL');await until(()=>!alive(pid),3000);const free=await run(k,s.url,['inscriptions']).done;assert.deepEqual([free.code,free.out.trim(),locks(k)],[0,'[]',[]],free.err);
 }finally{await s.close();}});

test('a journal that cannot be written whole stays as it was, and the command says so',async()=>{
 const s=await serve(),w=walletDir();
 try{
  // Twenty kept transactions make a journal of about 64,000 bytes; the command may write files of 16,000 or 32,000 bytes
  // (what a full disk or a quota does to a write).
  const entries=Array.from({length:20},(_,i)=>({n:i+1,kind:'mint',id:randomBytes(32).toString('hex'),state:'sent',txid:randomBytes(32).toString('hex'),blob:'ab'.repeat(1500),domain:DOMAIN,sent:'x'}));
  const whole=JSON.stringify({version:1,next:21,entries,notes:[]})+'\n';writeFileSync(join(w.dir,'journal.json'),whole);
  const c=spawn('sh',['-c','ulimit -f 32; exec "$@"','sh',process.execPath,BIN,'wallet','inscriptions','--wallet',w.dir,'--network','stagenet','--reader',s.url,'--node',s.url,'--domain',DOMAIN,'--carrier',w.tool],{stdio:['ignore','pipe','pipe']});
  let err='';c.stderr.on('data',d=>err+=d);const [code,signal]=await new Promise(r=>c.on('exit',(a,b)=>r([a,b])));
  assert.equal(readFileSync(join(w.dir,'journal.json'),'utf8'),whole,'the journal is as it was');
  // (Where the system ends a program that writes past the limit, there is no message; the journal is whole all the same.)
  if(signal===null){assert.equal(code,2,err);assert.match(err,/journal\.json could not be written \(E[A-Z]+\); it is as it was\. Is the disk full\?/);}
  assert.ok(!existsSync(join(w.dir,'journal.json.part'))||signal!==null);
  // Without the limit the same command goes through.
  const fine=await run(w,s.url,['inscriptions']).done;assert.equal(fine.code,0,fine.err);assert.equal(JSON.parse(fine.out).length,20);
 }finally{await s.close();}});

test('the tool is told the wallet\'s start block as it is when the tool is run',async()=>{
 const w=walletDir();let start=5;const tool=createTool({bin:w.tool,stateDir:w.dir,node:'http://127.0.0.1:9',network:'stagenet',start:()=>start});
 await tool.status();start=9;await tool.status();
 assert.deepEqual(readFileSync(join(w.dir,'tool.env'),'utf8').trim().split('\n'),['5','9']);
 // A tool that is ended is done at once and holds the wallet no longer.
 writeFileSync(join(w.dir,'slow.json'),JSON.stringify({status:5000}));mkdirSync(join(w.dir,'lock'));const lock=openLock(w.dir,{wait:0}),slow=createTool({bin:w.tool,stateDir:w.dir,node:'http://127.0.0.1:9',network:'stagenet',lock});
 const answer=slow.status().then(()=>'answered',e=>e.message);await until(()=>slow.running!==null&&locks({dir:w.dir}).length===1);
 const began=Date.now();slow.stop();assert.deepEqual(locks({dir:w.dir}),[]);assert.equal(await answer,'The carrier tool did not answer.');assert.ok(Date.now()-began<2000);});
