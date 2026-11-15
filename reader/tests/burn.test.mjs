// Offline tests of claiming by burning (RULES.md section 10) in the reader and the service, with a made-up node and
// made-up keys: node --test reader/tests/burn.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {hex} from '../../rules/lib/monero.mjs';
import {outputSecret,signWithOutputKey} from '../../rules/lib/claim.mjs';
import {BURN,MAINNET_DEAD,burnAddress,burnClaimId,burnParts,claimText} from '../../rules/lib/burn.mjs';
import {wallet,makeTx,ownerEntry,makeBurn,DOMAIN} from '../../rules/tests/helpers.mjs';
import {ownersHash,ownerOutputsHash} from '../lib/owners.mjs';
import {openReader,SCHEMA,SCHEMA_BURN} from '../lib/reader.mjs';
import {unframe} from '../lib/transport.mjs';
import {createService} from '../service.mjs';
import {verify,scan,download} from '../tools/verify.mjs';
import {createRelay} from '../lib/relay.mjs';
import {fakeChain,fakeCarrier,carried} from './fake.mjs';

const dirs=[];test.after(()=>{for(const d of dirs)rmSync(d,{recursive:true,force:true});});
const FROM=103;
// The record a made-up carrier transaction holds, as hex (what a wallet hands to the relay).
const recordOf=t=>hex(unframe(t.tx.extra));
function world({every=5}={}){
 const w=Object.fromEntries(['alice','bob','carol','dave','fee'].map(n=>[n,wallet(n)]));
 const holders=[w.alice,w.alice,w.bob,w.carol,w.alice,w.bob];
 const owners=holders.map((h,i)=>({...ownerEntry(i,makeTx('burn reader '+i,[{to:h,amount:10n**9n}])),registrationHeight:50+i,ownerHeight:50+i}));   // owner outputs 1000 to 1005
 const dir=mkdtempSync(join(tmpdir(),'mordinals-burn-'));dirs.push(dir);
 const chain=fakeChain({start:100}),state=join(dir,'state');
 const open=(o={})=>openReader({dir:state,chain,domain:DOMAIN,feeAddress:w.fee.address,owners,start:100,checkpointEvery:every,burnFrom:FROM,...o});
 const key=(n,h)=>outputSecret({viewSecret:h.viewSecret,spendSecret:h.spendSecret,txPub:owners[n].ownerTxPubKeys[0],subScalar:h.subScalar});
 const claim=(n,h,l,to=h)=>{const p=l.prepareClaim({mordinal:n,to:to.address});return carried(l.claimWithKey(p.bodyBytes,signWithOutputKey(p.keyHash,key(n,h))));};
 const move=(n,from,to,l)=>{const p=l.prepareMove({mordinal:n,from:from.address,to:to.address});return carried(l.sign(p.bodyBytes,from.sign(p.text)));};
 const burn=(label,n,to,more)=>{const t=makeBurn(label,{output:1000+n,to,...more});return {txid:t.txid,tx:t.tx};};
 return {w,owners,dir,state,chain,open,claim,move,burn};}

test('the reader finds burn claims from the first burn block on, in block order, and rebuilds them without a node',async()=>{
 const {w,owners,chain,open,claim,move,burn,state}=world(),reader=open(),L=()=>reader.ledger;
 assert.equal(reader.meta.schema,SCHEMA+SCHEMA_BURN);assert.equal(reader.meta.burnFrom,FROM);assert.equal(reader.meta.burnDead,MAINNET_DEAD.join(','));assert.equal(reader.meta.ownerOutputs,ownerOutputsHash(owners));
 const sync=async(...txs)=>{chain.mine(txs);await reader.sync();return reader.height;};
 const c0=claim(0,w.alice,L()),early=burn('early',1,w.carol);
 await sync(c0);                                                   // 101: a claim record, before the first burn block
 await sync(early);                                                // 102: a burning transfer before that block is not looked at
 assert.deepEqual(reader.journal.map(e=>e.txid),[c0.txid]);assert.equal(L().mordinal(1).claimed,false);assert.equal(reader.entryByTx(early.txid),null);
 // 103: two burns of one Mordinal and a claim record for another, in one block. The first burn counts; the record no longer does.
 const b1=burn('b1',2,w.carol),b2=burn('b2',2,w.dave),c4=claim(4,w.alice,L()),plain={txid:'ee'.repeat(32),tx:{version:2,extra:[1,...new Uint8Array(32)],vout:[]}};
 await sync(plain,b1,c4,b2);
 assert.deepEqual(reader.journal.slice(1).map(e=>[e.height,e.pos,e.txid,e.ok,e.error??null]),[[103,1,b1.txid,true,null],[103,2,c4.txid,false,'From block 103 a Mordinal is claimed by burning it; a claim record no longer counts.'],[103,3,b2.txid,false,'This Mordinal is already claimed.']]);
 const e1=reader.journal[1];assert.deepEqual(e1,{height:103,pos:1,txid:b1.txid,burn:burnParts(b1.tx),id:burnClaimId(DOMAIN,b1.txid),ok:true});
 assert.equal(L().mordinal(2).owner,w.carol.address);assert.equal(L().mordinal(4).claimed,false);
 assert.deepEqual(reader.events.map(e=>[e.kind,e.number,e.to,e.proof,e.txid,e.height]),[['claim',0,w.alice.address,'one-time key',c0.txid,101],['claim',2,w.carol.address,'burn',b1.txid,103]]);
 assert.equal(reader.events[1].id,e1.id);assert.equal(reader.events[1].time,reader.timeOf(103));assert.equal(reader.entryById(e1.id),e1);assert.equal(reader.entryByTx(b2.txid).ok,false);
 // 104: carol sends it on with an ordinary record; 105: a checkpoint.
 await sync(move(2,w.carol,w.bob,L()));await sync(burn('b3',5,w.dave.sub(1)));
 assert.equal(L().mordinal(2).owner,w.bob.address);assert.equal(L().mordinal(5).owner,w.dave.sub(1).address);
 const c=reader.checkpoints.at(-1);assert.equal(c.height,105);
 assert.deepEqual(Object.keys(c),['schema','network','domain','owners','start','burnFrom','burnDead','ownerOutputs','height','blockHash','records','listHash','stateHash']);
 assert.deepEqual([c.burnFrom,c.burnDead,c.ownerOutputs,c.records],[FROM,MAINNET_DEAD.join(','),ownerOutputsHash(owners),4]);
 // Opened again from its folder, and read again from the node by another reader: the same journal, events and checkpoints.
 const snapshot=r=>JSON.stringify({h:r.height,hash:r.hash,j:r.journal,e:r.events,c:r.checkpoints,s:r.ledger.toJSON(),now:r.checkpoint()});
 const calls=chain.calls,again=open();assert.equal(chain.calls,calls);assert.equal(snapshot(again),snapshot(reader));
 const fresh=open({dir:state+'-fresh'});await fresh.sync();assert.equal(snapshot(fresh),snapshot(reader));
 // A reader with another first burn block or other dead outputs keeps another folder, and says so.
 assert.throws(()=>open({burnFrom:FROM+1}),/made for another ledger \(burnFrom differs\)/);assert.throws(()=>open({burnFrom:null}),/made for another ledger \(schema differs\)/);
 assert.throws(()=>open({burnDead:[5,6,7,8,9,10,11,12,13,14,15,16,17,18,20]}),/made for another ledger \(burnDead differs\)/);
 assert.throws(()=>open({owners:owners.map((o,i)=>i===3?{...o,ownerOutputIndex:999}:o)}),/made for another ledger \(ownerOutputs differs\)/);
 assert.throws(()=>open({dir:state+'-bad',burnFrom:100}),/Bad first burn block/);assert.throws(()=>open({dir:state+'-bad',burnFrom:null,burnDead:[...MAINNET_DEAD]}),/only with a first burn block/);});

test('a chain reorganisation removes a burn claim, and brings it back when the transaction is in a block again',async()=>{
 const {w,chain,open,burn,state}=world({every:2}),reader=open();
 chain.mine();chain.mine();await reader.sync();                                                 // 101, 102
 const b=burn('reorg',3,w.dave);chain.mine([b]);chain.mine();await reader.sync();               // 103 holds the burn; 104 a checkpoint
 assert.equal(reader.ledger.mordinal(3).owner,w.dave.address);assert.equal(reader.checkpoints.at(-1).height,104);const old=reader.checkpoints.at(-1);
 // Blocks 103 and 104 are replaced by blocks without it.
 chain.pop(2);chain.mine();chain.mine();const r=await reader.sync();assert.deepEqual({height:r.height,reorg:r.reorg},{height:104,reorg:2});
 assert.equal(reader.ledger.mordinal(3).claimed,false);assert.equal(reader.ledger.mordinal(3).owner,null);assert.deepEqual(reader.journal,[]);assert.deepEqual(reader.events,[]);
 assert.equal(reader.entryByTx(b.txid),null);assert.equal(reader.entryById(old.stateHash),null);assert.notEqual(reader.checkpoints.at(-1).stateHash,old.stateHash);assert.equal(reader.checkpoints.at(-1).records,0);
 // The same transaction in a later block of the new chain claims it again, there.
 chain.mine([b]);await reader.sync();assert.equal(reader.ledger.mordinal(3).owner,w.dave.address);assert.deepEqual(reader.events.map(e=>[e.kind,e.proof,e.height]),[['claim','burn',105]]);
 // Replaced once more, with the transaction back among the waiting ones and then mined: one step back, one forward.
 chain.pop(1,{keep:true});const back=await reader.sync();assert.equal(back.height,104);assert.equal(reader.ledger.mordinal(3).claimed,false);
 chain.mine();await reader.sync();assert.equal(reader.ledger.mordinal(3).owner,w.dave.address);
 const fresh=open({dir:state+'-fresh'});await fresh.sync();assert.deepEqual(fresh.journal,reader.journal);assert.deepEqual(fresh.checkpoints,reader.checkpoints);});

test('without the setting a reader is what it was: burning transfers are not looked at, checkpoints and folder unchanged',async()=>{
 const {w,owners,chain,open,claim,move,burn,state}=world(),plain=open({burnFrom:null}),burning=open({dir:state+'-burning'});
 const c0=claim(0,w.alice,plain.ledger),b=burn('ignored',2,w.carol),c1=claim(1,w.alice,plain.ledger,w.bob);
 chain.mine([c0]);chain.mine();chain.mine([b,c1]);chain.mine();chain.mine();await plain.sync();await burning.sync();                 // 101 … 105
 // The plain reader: the two claim records, nothing else; a folder and checkpoints with the fields they always had.
 assert.deepEqual(plain.journal.map(e=>[e.txid,e.ok]),[[c0.txid,true],[c1.txid,true]]);assert.equal(plain.ledger.mordinal(2).claimed,false);assert.equal(plain.ledger.mordinal(1).owner,w.bob.address);assert.equal(plain.ledger.burn,null);
 assert.deepEqual(plain.meta,{schema:SCHEMA,network:'mainnet',domain:DOMAIN,feeAddress:w.fee.address,start:100,owners:ownersHash(owners),startHash:plain.meta.startHash});
 assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(state,'meta.json'),'utf8'))),['schema','network','domain','feeAddress','start','owners','startHash']);
 const c=plain.checkpoints.at(-1);assert.deepEqual(Object.keys(c),['schema','network','domain','owners','start','height','blockHash','records','listHash','stateHash']);assert.equal(c.records,2);
 assert.deepEqual(Object.keys(plain.journal[0]),['height','pos','txid','record','op','id','ok']);
 // The burning reader on the same chain: the burn counts and the later claim record does not.
 assert.deepEqual(burning.journal.map(e=>[e.txid,e.ok]),[[c0.txid,true],[b.txid,true],[c1.txid,false]]);assert.equal(burning.ledger.mordinal(2).owner,w.carol.address);assert.equal(burning.ledger.mordinal(1).claimed,false);
 // Up to the block before the first burn block the two agree on everything a checkpoint states.
 const p2=open({dir:state+'-p2',burnFrom:null,checkpointEvery:2}),b2=open({dir:state+'-b2',checkpointEvery:2});await p2.sync();await b2.sync();
 assert.deepEqual(b2.checkpoints[0],p2.checkpoints[0]);assert.equal(p2.checkpoints[0].height,102);assert.notDeepEqual(b2.checkpoints[1],p2.checkpoints[1]);});

test('a folder from before the first burn block takes the setting in; a folder past it does not',async()=>{
 const {w,chain,open,claim,burn,state}=world(),before=open({burnFrom:null});
 chain.mine([claim(0,w.alice,before.ledger)]);chain.mine();await before.sync();                        // 101, 102
 const logged=[],lit=open({log:v=>logged.push(v)});assert.deepEqual(logged,[{burnFrom:FROM,at:102}]);
 assert.equal(lit.meta.schema,SCHEMA+SCHEMA_BURN);assert.equal(lit.meta.burnFrom,FROM);assert.equal(JSON.parse(readFileSync(join(state,'meta.json'),'utf8')).burnFrom,FROM);
 assert.equal(lit.height,102);assert.equal(lit.ledger.mordinal(0).owner,w.alice.address);assert.equal(lit.checkpoints.length,0);
 const b=burn('after',2,w.carol);chain.mine([b]);await lit.sync();assert.equal(lit.ledger.mordinal(2).owner,w.carol.address);
 // Code that still opens it without the setting is refused: it would not see the burns.
 assert.throws(()=>open({burnFrom:null}),/made for another ledger/);
 // A folder that has read the first burn block without the setting may have passed over burns: it is not continued.
 const past=open({dir:state+'-past',burnFrom:null});await past.sync();assert.equal(past.height,103);
 assert.throws(()=>open({dir:state+'-past'}),/made for another ledger/);assert.equal(JSON.parse(readFileSync(join(state+'-past','meta.json'),'utf8')).burnFrom,undefined);
 // Exactly at the block before: still taken in.
 const edge=open({dir:state+'-edge',burnFrom:null});await edge.sync({limit:2});assert.equal(edge.height,102);const e2=open({dir:state+'-edge'});await e2.sync();assert.equal(e2.ledger.mordinal(2).owner,w.carol.address);});

test('the service: the setting in /info, a burn claim in the history, the entry and the log, and the check tools agree',async()=>{
 const {w,owners,chain,open,claim,burn,dir}=world({every:2}),reader=open();
 const service=createService({reader,owners,testHooks:true}),port=await service.listen(0),base='http://127.0.0.1:'+port;
 const get=async path=>{const r=await fetch(base+path);return {status:r.status,body:await r.json()};};
 const next=async(...txs)=>{chain.mine(txs);const r=await fetch(base+'/test/step',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(r.status,200);return r.json();};
 try{
  const info=(await get('/info')).body;
  assert.equal(info.burnFrom,FROM);assert.deepEqual(info.burn,{address:burnAddress(),viewKey:BURN.viewSecret,text:'xmr721 claim to <address>',dead:[...MAINNET_DEAD],ownerOutputs:ownerOutputsHash(owners)});
  assert.equal((await get('/mordinal/3')).body.mordinal.ownerOutput,1003);
  const c0=claim(0,w.alice,reader.ledger);await next(c0);await next();                               // 101, 102
  const good=burn('service',3,w.dave),bad=burn('service bad',1,w.dave,{fee:5n}),late=claim(4,w.alice,reader.ledger);
  await next(good,bad,late);await next();                                                            // 103, 104
  const id=burnClaimId(DOMAIN,good.txid);
  // The Mordinal, its history, the address that now owns it.
  const m=(await get('/mordinal/3')).body;assert.equal(m.mordinal.claimed,true);assert.equal(m.mordinal.owner,w.dave.address);assert.equal(m.mordinal.seq,0);
  assert.deepEqual(m.history.map(h=>h.kind),['inscribed','claim']);
  assert.deepEqual({...m.history[1],time:0},{height:103,pos:0,txid:good.txid,id,time:0,kind:'claim',number:3,to:w.dave.address,proof:'burn',confirmations:2});
  assert.deepEqual((await get('/address/'+w.dave.address)).body.mordinals.map(x=>x.number),[3]);assert.deepEqual((await get('/claimed')).body.numbers,[0,3]);
  // What became of each transaction.
  assert.deepEqual((await get('/entry/'+good.txid)).body,{height:104,entry:{txid:good.txid,height:103,pos:0,id,op:null,kind:'burn claim',number:3,to:w.dave.address,ok:true},confirmations:2});
  assert.deepEqual((await get('/entry/'+bad.txid)).body.entry,{txid:bad.txid,height:103,pos:1,id:burnClaimId(DOMAIN,bad.txid),op:null,kind:'burn claim',ok:false,error:'The fee is below the 0.001 XMR the original rules ask for a text of 111 bytes.'});
  assert.match((await get('/entry/'+late.txid)).body.entry.error,/claimed by burning it/);assert.equal((await get('/entry/'+c0.txid)).body.entry.kind,undefined);
  assert.deepEqual((await get('/status/'+id)).body,{height:104,id,state:'done',txid:good.txid,confirmations:2,error:null});
  // Activity, the records (MD1 records only) and the log (everything judged).
  const act=(await get('/activity?kind=claim')).body.events;assert.deepEqual(act.map(e=>[e.number,e.proof]),[[3,'burn'],[0,'one-time key']]);
  assert.deepEqual((await get('/activity?address='+w.dave.address)).body.events.map(e=>e.txid),[good.txid]);
  const records=(await get('/records')).body;assert.equal(records.total,1);assert.deepEqual(records.records,[reader.journal[0].record]);
  const log=(await get('/log')).body;assert.equal(log.total,4);assert.deepEqual(log.entries[1].burn,burnParts(good.tx));
  const stats=(await get('/stats')).body;assert.deepEqual([stats.claimed,stats.records,stats.refused,stats.byKind.claim],[2,2,2,2]);
  const cps=(await get('/checkpoints')).body.checkpoints;assert.deepEqual(cps.map(c=>[c.height,c.burnFrom??null]),[[102,null],[104,FROM]]);
  // The check tools: the log replays, sits on the node as logged, and a reader of one's own finds the same.
  const got=await download(base);assert.deepEqual(await verify({...got,owners,chain}),{ok:true,problems:[],accepted:2,refused:2,checkpoints:2,checkedOnNode:4});
  assert.deepEqual(await scan({...got,owners,chain,dir:join(dir,'scan')}),[]);
  const clone=()=>JSON.parse(JSON.stringify(got)),problems=async change=>{const g=clone();change(g);return (await verify({...g,owners,chain})).problems;};
  assert.match((await problems(g=>{g.entries[1].ok=false;g.entries[1].error='x';}))[0],/marked refused, but the rules accept it/);
  assert.match((await problems(g=>{g.entries[2].ok=true;delete g.entries[2].error;}))[0],/marked accepted, but the rules refuse it: The fee is below/);
  assert.match((await problems(g=>{g.entries[2].error='Another reason.';}))[0],/refused for another reason than stated/);
  assert.match((await problems(g=>{g.entries[1].id='00'.repeat(32);}))[0],/not a well-formed burn claim entry/);
  assert.match((await problems(g=>{g.entries[1].burn.out0.tag=null;}))[0],/is not on the node as logged/);
  assert.match((await problems(g=>{g.entries.splice(1,1);}))[0],/Checkpoint at block 104/);
  assert.match((await problems(g=>{delete g.checkpoints[1].burnFrom;}))[0],/another first burn block, other dead outputs or other owner outputs/);
  assert.match((await problems(g=>{g.info.burn.ownerOutputs='00'.repeat(32);}))[0],/other owner output indexes/);
  assert.match((await verify({...got,owners:owners.map((o,i)=>i===5?{...o,ownerOutputIndex:5}:o),chain})).problems[0],/other owner output indexes/);
 }finally{await service.close();}});

test('the relay stops carrying claim records one block before the first burn block',async()=>{
 const {w,chain,open,claim,dir}=world(),reader=open(),relay=createRelay({dir:join(dir,'relay'),reader,chain,carrier:fakeCarrier(chain,{coins:6}),domain:DOMAIN,limits:{resendMs:1000},now:()=>1_000_000});
 chain.mine();await reader.sync();                                                                   // 101: the next block is 102
 const first=await relay.submit(recordOf(claim(0,w.alice,reader.ledger)));assert.equal(first.state,'sent');
 chain.mine();await reader.sync();await relay.tick();assert.equal(reader.ledger.mordinal(0).owner,w.alice.address);   // 102: the next block is the first burn block
 await assert.rejects(relay.submit(recordOf(claim(1,w.alice,reader.ledger))),e=>/From block 103 a Mordinal is claimed by burning it/.test(e.message)&&e.rule===true);
 assert.equal((await chain.pool()).length,0);
 // Other records are carried as before.
 const mv=reader.ledger.prepareMove({mordinal:0,from:w.alice.address,to:w.bob.address});assert.equal((await relay.submit(hex(reader.ledger.sign(mv.bodyBytes,w.alice.sign(mv.text))))).state,'sent');});

test('the service without the setting answers as before',async()=>{
 const {w,owners,chain,open,burn}=world(),reader=open({burnFrom:null});
 const service=createService({reader,owners,testHooks:true}),port=await service.listen(0),base='http://127.0.0.1:'+port,get=async path=>(await (await fetch(base+path)).json());
 try{
  const b=burn('unseen',3,w.dave);chain.mine([b]);chain.mine();chain.mine([{txid:b.txid.replace(/^../,'00'),tx:b.tx}]);await reader.sync();
  const info=await get('/info');assert.equal('burnFrom' in info,false);assert.equal('burn' in info,false);
  assert.deepEqual(Object.keys(info),['network','domain','feeAddress','height','count','chunk','test','owners','start','startHash','mintFrom','relay','rules']);
  assert.equal('ownerOutput' in (await get('/mordinal/3')).mordinal,false);assert.equal((await get('/mordinal/3')).mordinal.claimed,false);
  assert.equal((await get('/log')).total,0);assert.equal((await get('/entry/'+b.txid)).error,'This reader has read no record in this transaction.');
 }finally{await service.close();}});
