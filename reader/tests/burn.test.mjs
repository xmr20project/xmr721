// Offline tests of claiming by burning (RULES.md section 10) in the reader and the service, with a made-up node and
// made-up keys: node --test reader/tests/burn.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {hex} from '../../rules/lib/monero.mjs';
import {outputSecret,signWithOutputKey} from '../../rules/lib/claim.mjs';
import {BURN,MAINNET_DEAD,RECORDS_OVERLAP,burnAddress,burnClaimId,burnParts,claimText} from '../../rules/lib/burn.mjs';
import {createLedger} from '../../rules/lib/ledger.mjs';
import {wallet,makeTx,ownerEntry,makeBurn,burnParty,feeParty,payFee,DOMAIN} from '../../rules/tests/helpers.mjs';
import {feeParts,feeWallet,feeAddressOf,FEE_SAFE} from '../../rules/lib/burn-fee.mjs';
import {ownersHash,ownerOutputsHash} from '../lib/owners.mjs';
import {openReader,SCHEMA,SCHEMA_BURN,BURN_MARGIN} from '../lib/reader.mjs';
import {unframe} from '../lib/transport.mjs';
import {createService} from '../service.mjs';
import {verify,scan,download} from '../tools/verify.mjs';
import {createRelay} from '../lib/relay.mjs';
import {fakeChain,fakeCarrier,carried} from './fake.mjs';

const dirs=[];test.after(()=>{for(const d of dirs)rmSync(d,{recursive:true,force:true});});
const FROM=103,END=FROM+RECORDS_OVERLAP,TEST_DEAD=[5,6,7,8,9,10,11,12,13,14,15,16,17,18,20],DUE=10n**9n+30000000n;
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
 // A burning transfer that pays its own fee to the Mordinal's fee address, as the burn's own transaction fee (paid: false: it
 // does not; the burn then waits for a fee payment).
 const burn=(label,n,to,{paid=true,...more}={})=>{const t=makeBurn(label,{output:1000+n,to,...(paid?{outs:[{to:burnParty,amount:1n},{to:feeParty(n),amount:DUE},{to:wallet(label+' change'),amount:10n**9n}]}:{}),...more});return {txid:t.txid,tx:t.tx};};
 return {w,owners,dir,state,chain,open,claim,move,burn};}

test('the reader finds burn claims from the first burn block on, in block order, and rebuilds them without a node',async()=>{
 const {w,owners,chain,open,claim,move,burn,state}=world(),reader=open(),L=()=>reader.ledger;
 assert.equal(reader.meta.schema,SCHEMA+SCHEMA_BURN);assert.equal(reader.meta.burnFrom,FROM);assert.equal(reader.meta.burnDead,MAINNET_DEAD.join(','));assert.equal(reader.meta.ownerOutputs,ownerOutputsHash(owners));
 const sync=async(...txs)=>{chain.mine(txs);await reader.sync();return reader.height;};
 const c0=claim(0,w.alice,L()),early=burn('early',1,w.carol);
 await sync(c0);                                                   // 101: a claim record, before the first burn block
 await sync(early);                                                // 102: a burning transfer before that block is not looked at, nor the fee it pays
 assert.deepEqual(reader.journal.map(e=>e.txid),[c0.txid]);assert.equal(L().mordinal(1).claimed,false);assert.equal(reader.entryByTx(early.txid),null);assert.equal(L().burnFee(1).paid,'0');
 // 103: two burns of one Mordinal and a claim record for another, in one block. The first burn counts, the second does
 // not; the claim record still counts (claim records stop 720 blocks later). A tx_extra above 1,060 bytes is no transfer.
 const b1=burn('b1',2,w.carol),b2=burn('b2',2,w.dave,{paid:false}),c4=claim(4,w.alice,L()),plain={txid:'ee'.repeat(32),tx:{version:2,extra:[1,...new Uint8Array(32)],vout:[]}};
 const junk=burn('junk',3,w.dave,{paid:false,tamper:tx=>{tx.extra=[...tx.extra.slice(0,33),0x11,0xa0,0x9c,1,...new Uint8Array(20000).fill(66)];}}),long=burn('long',3,w.dave,{paid:false,tamper:tx=>{tx.extra=[...tx.extra.slice(0,33),...Array.from({length:8},()=>[2,127,...new Uint8Array(127)]).flat(),...tx.extra.slice(33)];}});
 assert.ok(long.tx.extra.length>1060);
 await sync(plain,b1,junk,c4,long,b2);
 assert.deepEqual(reader.journal.slice(1).map(e=>[e.height,e.pos,e.txid,e.ok,e.error??null]),[[103,1,b1.txid,true,null],[103,3,c4.txid,true,null],[103,5,b2.txid,false,'This Mordinal is already claimed.']]);
 assert.equal(reader.entryByTx(junk.txid),null);assert.equal(reader.entryByTx(long.txid),null);assert.equal(L().mordinal(3).claimed,false);
 // The burn pays its own fee: the entry holds what the rule read for both, and the Mordinal is claimed in its block.
 const e1=reader.journal[1];assert.deepEqual(e1,{height:103,pos:1,txid:b1.txid,burn:burnParts(b1.tx),id:burnClaimId(DOMAIN,b1.txid),ok:true,fee:feeParts(b1.tx)});
 assert.deepEqual(reader.feesOf(b1.txid),[{index:1,number:2,amount:DUE.toString(),counted:true,error:null}]);
 assert.equal(L().mordinal(2).owner,w.carol.address);assert.equal(L().mordinal(4).owner,w.alice.address);
 assert.deepEqual(reader.events.map(e=>[e.kind,e.number,e.to,e.proof,e.txid,e.height]),[['claim',0,w.alice.address,'one-time key',c0.txid,101],['claim',2,w.carol.address,'burn',b1.txid,103],['claim',4,w.alice.address,'one-time key',c4.txid,103]]);
 assert.equal(reader.events[1].id,e1.id);assert.equal(reader.events[1].time,reader.timeOf(103));assert.equal(reader.entryById(e1.id),e1);assert.equal(reader.entryByTx(b2.txid).ok,false);
 // 104: the holder whose burn was mined a block early claims by record with the one-time key (the coin is spent, the
 // key is not); carol sends hers on with an ordinary record. 105: one more burn, with a line end after the address; a checkpoint.
 await sync(claim(1,w.alice,L(),w.carol),move(2,w.carol,w.bob,L()));await sync(burn('b3',5,w.dave.sub(1),{text:claimText(w.dave.sub(1).address)+'\n'}));
 assert.equal(L().mordinal(1).owner,w.carol.address);assert.equal(L().mordinal(2).owner,w.bob.address);assert.equal(L().mordinal(5).owner,w.dave.sub(1).address);
 const c=reader.checkpoints.at(-1);assert.equal(c.height,105);
 assert.deepEqual(Object.keys(c),['schema','network','domain','owners','start','burnFrom','burnDead','ownerOutputs','burnFee','height','blockHash','records','listHash','stateHash']);
 assert.deepEqual([c.burnFrom,c.burnDead,c.ownerOutputs,c.burnFee,c.records],[FROM,MAINNET_DEAD.join(','),ownerOutputsHash(owners),feeWallet().address,6]);assert.equal(reader.meta.burnFee,feeWallet().address);
 // Opened again from its folder, and read again from the node by another reader: the same journal, events and checkpoints.
 const snapshot=r=>JSON.stringify({h:r.height,hash:r.hash,j:r.journal,e:r.events,c:r.checkpoints,s:r.ledger.toJSON(),now:r.checkpoint()});
 const calls=chain.calls,again=open();assert.equal(chain.calls,calls);assert.equal(snapshot(again),snapshot(reader));
 const fresh=open({dir:state+'-fresh'});await fresh.sync();assert.equal(snapshot(fresh),snapshot(reader));
 // A reader that has read the first burn block keeps its setting: another one is another ledger.
 assert.throws(()=>open({burnFrom:FROM+1}),/made for another ledger \(burnFrom differs\)/);assert.throws(()=>open({burnFrom:FROM+50}),/made for another ledger \(burnFrom differs\)/);assert.throws(()=>open({burnFrom:null}),/made for another ledger \(schema differs\)/);
 assert.throws(()=>open({owners:owners.map((o,i)=>i===3?{...o,ownerOutputIndex:999}:o)}),/made for another ledger \(ownerOutputs differs\)/);
 assert.throws(()=>open({dir:state+'-bad',burnFrom:100}),/Bad first burn block/);assert.throws(()=>open({dir:state+'-bad',burnFrom:null,burnDead:[...MAINNET_DEAD]}),/only with a first burn block/);});

test('a tx_extra above 1,060 bytes is not looked at: the reader ends where it would without that transaction',async()=>{
 const a=world(),b=world(),ra=a.open(),rb=b.open();
 const junk=a.burn('junk',3,a.w.dave,{paid:false,tamper:tx=>{tx.extra=[...tx.extra.slice(0,33),0x11,0xa0,0x9c,1,...new Uint8Array(20000).fill(66)];}}),good=a.burn('good',2,a.w.carol);
 for(const x of [a,b]){x.chain.mine();x.chain.mine();}
 a.chain.mine([good,junk]);b.chain.mine([good]);for(const x of [a,b]){x.chain.mine();x.chain.mine();}await ra.sync();await rb.sync();
 assert.equal(ra.height,105);assert.deepEqual(ra.journal,rb.journal);assert.deepEqual(ra.events.map(e=>({...e,time:0})),rb.events.map(e=>({...e,time:0})));assert.equal(ra.journal.length,1);
 assert.equal(ra.checkpoint().stateHash,rb.checkpoint().stateHash);assert.equal(ra.checkpoint().listHash,rb.checkpoint().listHash);assert.equal(readFileSync(join(a.state,'records.jsonl'),'utf8'),readFileSync(join(b.state,'records.jsonl'),'utf8'));});

test('a chain reorganisation removes a burn claim, and brings it back when the transaction is in a block again',async()=>{
 const {w,chain,open,burn,state}=world({every:2}),reader=open();
 chain.mine();chain.mine();await reader.sync();                                                 // 101, 102
 const b=burn('reorg',3,w.dave);chain.mine([b]);chain.mine();await reader.sync();               // 103 holds the burn; 104 a checkpoint
 assert.equal(reader.ledger.mordinal(3).owner,w.dave.address);assert.equal(reader.checkpoints.at(-1).height,104);const old=reader.checkpoints.at(-1);
 // Blocks 103 and 104 are replaced by blocks without it.
 chain.pop(2);chain.mine();chain.mine();const r=await reader.sync();assert.deepEqual({height:r.height,reorg:r.reorg},{height:104,reorg:2});
 assert.equal(reader.ledger.mordinal(3).claimed,false);assert.equal(reader.ledger.mordinal(3).owner,null);assert.deepEqual(reader.journal,[]);assert.deepEqual(reader.events,[]);
 assert.equal(reader.entryByTx(b.txid),null);assert.equal(reader.entryById(burnClaimId(DOMAIN,b.txid)),null);assert.notEqual(reader.checkpoints.at(-1).stateHash,old.stateHash);assert.equal(reader.checkpoints.at(-1).records,0);
 // The same transaction in a later block of the new chain claims it again, there.
 chain.mine([b]);await reader.sync();assert.equal(reader.ledger.mordinal(3).owner,w.dave.address);assert.deepEqual(reader.events.map(e=>[e.kind,e.proof,e.height]),[['claim','burn',105]]);
 // Replaced once more, with the transaction back among the waiting ones and then mined: one step back, one forward.
 chain.pop(1,{keep:true});const back=await reader.sync();assert.equal(back.height,104);assert.equal(reader.ledger.mordinal(3).claimed,false);
 chain.mine();await reader.sync();assert.equal(reader.ledger.mordinal(3).owner,w.dave.address);
 const fresh=open({dir:state+'-fresh'});await fresh.sync();assert.deepEqual(fresh.journal,reader.journal);assert.deepEqual(fresh.checkpoints,reader.checkpoints);});

test('a burn waits for its fee in the reader: payments add up across blocks, a replaced block takes one away and brings it back',async()=>{
 const {w,chain,open,claim,burn,state}=world({every:2}),reader=open(),L=()=>reader.ledger;
 const snapshot=r=>JSON.stringify({h:r.height,hash:r.hash,j:r.journal,e:r.events,c:r.checkpoints,s:r.ledger.toJSON(),now:r.checkpoint()});
 chain.mine();chain.mine();const b=burn('waits',2,w.carol,{paid:false}),id=burnClaimId(DOMAIN,b.txid);chain.mine([b]);await reader.sync();          // 103
 assert.equal(L().mordinal(2).claimed,false);assert.equal(L().burnClaim(id).state,'waiting');assert.deepEqual(reader.events,[]);
 assert.deepEqual(reader.journal.map(e=>[e.height,e.txid,e.ok,Boolean(e.fee)]),[[103,b.txid,true,false]]);
 const half1=payFee('half 1',2,DUE/2n),half2=payFee('half 2',2,DUE-DUE/2n,{alongside:wallet('somebody')});
 chain.mine([half1]);await reader.sync();assert.equal(L().burnClaim(id).missing,(DUE-DUE/2n).toString());                                       // 104
 chain.mine([half2]);await reader.sync();assert.equal(L().mordinal(2).owner,w.carol.address);                                                       // 105
 assert.deepEqual(reader.events.map(e=>[e.kind,e.number,e.height,e.txid,e.burnHeight,e.feeTx]),[['claim',2,105,b.txid,103,half2.txid]]);
 assert.deepEqual(reader.journal.map(e=>[e.height,e.txid,e.ok,Boolean(e.fee)]),[[103,b.txid,true,false],[104,half1.txid,true,true],[105,half2.txid,true,true]]);
 const claimed=snapshot(reader);
 // Block 105 is replaced by one without the second payment: the Mordinal waits again, with half of its fee paid.
 chain.pop(1);chain.mine();await reader.sync();assert.equal(reader.height,105);assert.equal(L().mordinal(2).claimed,false);assert.equal(L().burnClaim(id).state,'waiting');
 assert.deepEqual(reader.events,[]);assert.equal(reader.entryByTx(half2.txid),null);assert.equal(L().burnFee(2).paid,(DUE/2n).toString());
 // The payment in a later block of the new chain claims it there.
 chain.mine([half2]);await reader.sync();assert.equal(L().mordinal(2).owner,w.carol.address);assert.deepEqual(reader.events.map(e=>e.height),[106]);
 // Blocks 104 to 106 replaced, the payments back among the waiting ones and then mined together in block 104: claimed there.
 chain.pop(3,{keep:true});chain.mine();chain.mine();await reader.sync();assert.equal(reader.height,105);
 assert.deepEqual(reader.events.map(e=>e.height),[104]);assert.deepEqual(reader.journal.map(e=>[e.height,e.txid]).slice(1).sort(),[[104,half1.txid],[104,half2.txid]].sort());
 // From its folder, and read again from the node: the same.
 assert.equal(snapshot(open()),snapshot(reader));const fresh=open({dir:state+'-fresh'});await fresh.sync();assert.equal(snapshot(fresh),snapshot(reader));
 assert.notEqual(snapshot(reader),claimed);
 // A claim record while a burn waits, in the overlap: the record claims it, the burn is passed over, its fee gives nothing.
 const b4=burn('overtaken',4,w.dave,{paid:false}),id4=burnClaimId(DOMAIN,b4.txid);chain.mine([b4]);await reader.sync();
 chain.mine([claim(4,w.alice,L())]);chain.mine([payFee('too late',4,DUE)]);await reader.sync();
 assert.equal(L().mordinal(4).owner,w.alice.address);assert.equal(L().burnClaim(id4).state,'lost');assert.equal(L().burnFee(4).paid,DUE.toString());
 assert.deepEqual(reader.events.filter(e=>e.number===4).map(e=>[e.kind,e.proof]),[['claim','one-time key']]);
 const service=createService({reader,owners:[],testHooks:true});
 try{const port=await service.listen(0),got=await (await fetch(`http://127.0.0.1:${port}/status/${id4}`)).json();
  assert.deepEqual({state:got.state,error:got.error},{state:'refused',error:'The Mordinal was claimed by a record before the fee of this burn was paid.'});
 }finally{await service.close();}});

test('a burn that a reorganisation moved in front of the first burn block claims nothing; its holder claims by record',async()=>{
 const {w,chain,open,claim,burn}=world(),reader=open();
 chain.mine();chain.mine();const b=burn('moved',2,w.carol);chain.mine([b]);await reader.sync();                       // the burn is in block 103
 assert.equal(reader.ledger.mordinal(2).owner,w.carol.address);
 chain.pop(2,{keep:true});chain.mine();await reader.sync();                                                          // now it is in block 102
 assert.equal(reader.height,102);assert.equal(reader.ledger.mordinal(2).claimed,false);assert.deepEqual(reader.journal,[]);
 chain.mine();chain.mine([claim(2,w.bob,reader.ledger,w.carol)]);await reader.sync();                                // 103, 104
 assert.equal(reader.ledger.mordinal(2).owner,w.carol.address);assert.deepEqual(reader.events.map(e=>[e.proof,e.height]),[['one-time key',104]]);});

test('without the setting a reader is what it was: burning transfers are not looked at, checkpoints and folder unchanged',async()=>{
 const {w,owners,chain,open,claim,burn,state}=world(),plain=open({burnFrom:null}),burning=open({dir:state+'-burning'});
 const c0=claim(0,w.alice,plain.ledger),b=burn('ignored',2,w.carol),c1=claim(1,w.alice,plain.ledger,w.bob);
 chain.mine([c0]);chain.mine();chain.mine([b,c1]);chain.mine();chain.mine();await plain.sync();await burning.sync();                 // 101 … 105
 // The plain reader: the two claim records, nothing else; a folder and checkpoints with the fields they always had.
 assert.deepEqual(plain.journal.map(e=>[e.txid,e.ok]),[[c0.txid,true],[c1.txid,true]]);assert.equal(plain.ledger.mordinal(2).claimed,false);assert.equal(plain.ledger.mordinal(1).owner,w.bob.address);assert.equal(plain.ledger.burn,null);
 assert.deepEqual(plain.meta,{schema:SCHEMA,network:'mainnet',domain:DOMAIN,feeAddress:w.fee.address,start:100,owners:ownersHash(owners),startHash:plain.meta.startHash});
 assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(state,'meta.json'),'utf8'))),['schema','network','domain','feeAddress','start','owners','startHash']);
 const c=plain.checkpoints.at(-1);assert.deepEqual(Object.keys(c),['schema','network','domain','owners','start','height','blockHash','records','listHash','stateHash']);assert.equal(c.records,2);
 assert.deepEqual(Object.keys(plain.journal[0]),['height','pos','txid','record','op','id','ok']);
 // The burning reader on the same chain: the burn counts too.
 assert.deepEqual(burning.journal.map(e=>[e.txid,e.ok]),[[c0.txid,true],[b.txid,true],[c1.txid,true]]);assert.equal(burning.ledger.mordinal(2).owner,w.carol.address);assert.equal(burning.ledger.mordinal(1).owner,w.bob.address);
 // Up to the block before the first burn block the two agree on everything a checkpoint states.
 const p2=open({dir:state+'-p2',burnFrom:null,checkpointEvery:2}),b2=open({dir:state+'-b2',checkpointEvery:2});await p2.sync();await b2.sync();
 assert.deepEqual(b2.checkpoints[0],p2.checkpoints[0]);assert.equal(p2.checkpoints[0].height,102);assert.notDeepEqual(b2.checkpoints[1],p2.checkpoints[1]);});

test('claim records count for 720 blocks from the first burn block, in the reader and at the relay',async()=>{
 const {w,chain,open,claim,burn,dir}=world({every:0}),reader=open(),relay=createRelay({dir:join(dir,'relay'),reader,chain,carrier:fakeCarrier(chain,{coins:6}),domain:DOMAIN,limits:{resendMs:1000},now:()=>1_000_000});
 assert.equal(END,823);assert.equal(reader.ledger.burn.recordsEnd,END);
 for(let h=101;h<=END-2;h++)chain.mine();await reader.sync();assert.equal(reader.height,END-2);                       // the next block is the last in which a record counts
 const first=await relay.submit(recordOf(claim(0,w.alice,reader.ledger)));assert.equal(first.state,'sent');
 chain.mine();await reader.sync();await relay.tick();assert.equal(reader.height,END-1);assert.equal(reader.ledger.mordinal(0).owner,w.alice.address);
 // One block before the end the relay stops: the record would reach block 823 at the earliest.
 await assert.rejects(relay.submit(recordOf(claim(1,w.alice,reader.ledger))),e=>/From block 823 a Mordinal is claimed only by burning it/.test(e.message)&&e.rule===true);
 assert.equal((await chain.pool()).length,0);
 // Carried by someone else into block 823, the record is refused there; a burn in the same block counts.
 const late=claim(1,w.alice,reader.ledger),b=burn('at the end',2,w.dave);chain.mine([late,b]);await reader.sync();
 assert.deepEqual(reader.journal.slice(1).map(e=>[e.height,e.txid,e.ok,e.error??null]),[[END,late.txid,false,'From block 823 a Mordinal is claimed only by burning it; a claim record no longer counts.'],[END,b.txid,true,null]]);
 // Other records are carried as before.
 const mv=reader.ledger.prepareMove({mordinal:0,from:w.alice.address,to:w.bob.address});assert.equal((await relay.submit(hex(reader.ledger.sign(mv.bodyBytes,w.alice.sign(mv.text))))).state,'sent');});

test('the setting of a folder: taken in, changed and taken out before its block is read, with ten blocks to spare',async()=>{
 const {w,chain,open,claim,burn,state}=world(),before=open({burnFrom:null}),meta=()=>JSON.parse(readFileSync(join(state,'meta.json'),'utf8'));
 chain.mine([claim(0,w.alice,before.ledger)]);chain.mine();await before.sync();                        // 101, 102
 assert.equal(BURN_MARGIN,10);
 // Too close to what the folder has read: refused, and the folder is as it was.
 for(const near of [103,111])assert.throws(()=>open({burnFrom:near}),/at least 10 blocks above the newest block this folder has read \(102\)/);
 assert.equal(meta().burnFrom,undefined);assert.equal(meta().schema,SCHEMA);
 // Ten blocks above: taken in.
 const logged=[],lit=open({burnFrom:112,log:v=>logged.push(v)});assert.deepEqual(logged,[{burnFrom:112,at:102}]);
 assert.equal(lit.meta.schema,SCHEMA+SCHEMA_BURN);assert.deepEqual([meta().burnFrom,meta().burnDead,meta().burnFee,meta().schema],[112,MAINNET_DEAD.join(','),feeWallet().address,SCHEMA+SCHEMA_BURN]);
 assert.equal(lit.height,102);assert.equal(lit.ledger.mordinal(0).owner,w.alice.address);assert.equal(lit.ledger.burn.from,112);
 // A mistyped height is corrected while neither block was read: to a later one, to an earlier one, and taken out again.
 assert.equal(open({burnFrom:120}).ledger.burn.from,120);assert.equal(meta().burnFrom,120);
 assert.equal(open({burnFrom:113}).ledger.burn.from,113);assert.equal(meta().burnFrom,113);
 assert.throws(()=>open({burnFrom:105}),/at least 10 blocks above/);assert.equal(meta().burnFrom,113);
 const out=open({burnFrom:null});assert.equal(out.ledger.burn,null);assert.deepEqual(Object.keys(meta()),['schema','network','domain','feeAddress','start','owners','startHash']);assert.equal(meta().schema,SCHEMA);
 // Taken in again and read up to the block before it: still open to change; the block itself read: no longer.
 const r=open({burnFrom:113});for(let h=103;h<=112;h++)chain.mine(h===108?[burn('too early',2,w.carol)]:[]);await r.sync();assert.equal(r.height,112);assert.deepEqual(r.journal.length,1);
 assert.throws(()=>open({burnFrom:121}),/at least 10 blocks above the newest block this folder has read \(112\)/);
 const moved=open({burnFrom:122});assert.equal(moved.ledger.burn.from,122);
 const back=open({burnFrom:null});assert.equal(back.ledger.burn,null);const again=open({burnFrom:125});
 for(let h=113;h<=124;h++)chain.mine();chain.mine([burn('in time',3,w.dave)]);await again.sync();assert.equal(again.height,125);assert.equal(again.ledger.mordinal(3).owner,w.dave.address);
 assert.throws(()=>open({burnFrom:140}),/made for another ledger \(burnFrom differs\)/);assert.throws(()=>open({burnFrom:null}),/made for another ledger \(schema differs\)/);
 assert.equal(meta().burnFrom,125);
 // A folder that has read a block without the setting cannot take that block, or an earlier one, as its first burn block.
 const past=open({dir:state+'-past',burnFrom:null});await past.sync({limit:8});assert.equal(past.height,108);
 for(const late of [103,108])assert.throws(()=>open({dir:state+'-past',burnFrom:late}),/made for another ledger/);
 assert.equal(JSON.parse(readFileSync(join(state+'-past','meta.json'),'utf8')).burnFrom,undefined);
 // A new folder has read nothing: any block above the start block is taken.
 const fresh=open({dir:state+'-new',burnFrom:101});assert.equal(fresh.ledger.burn.from,101);});

test('dead outputs of one\'s own only on the offline test chain; every owner entry states its output index',async()=>{
 const {w,owners,chain,open,burn,state,dir}=world(),reader=open({burnDead:TEST_DEAD});
 assert.equal(reader.meta.burnDead,TEST_DEAD.join(','));chain.mine();chain.mine();
 const good=burn('test chain',2,w.carol,{dead:TEST_DEAD}),main=burn('mainnet ring',3,w.carol);chain.mine([good,main]);await reader.sync();
 assert.equal(reader.ledger.mordinal(2).owner,w.carol.address);assert.equal(reader.ledger.mordinal(3).claimed,false);assert.match(reader.entryByTx(main.txid).error,/No input/);
 // The same folder against a node that is not the offline test chain: nothing is read.
 const info=chain.info;chain.info=async()=>({...await info(),nettype:'mainnet'});chain.mine();
 await assert.rejects(reader.sync(),/dead outputs of its own, which only the offline test chain has/);assert.equal(reader.height,103);
 await assert.rejects(open({dir:state+'-other',burnDead:TEST_DEAD}).sync(),/only the offline test chain has/);
 // Mainnet's own list, named or not, is the same ledger and reads any node.
 const named=open({dir:state+'-named',burnDead:[...MAINNET_DEAD]});await named.sync();assert.equal(named.height,104);assert.equal(open({dir:state+'-named'}).height,104);
 // The check tool says the same of a service that names its own list.
 const service=createService({reader,owners,testHooks:true}),port=await service.listen(0);
 try{const got=await download('http://127.0.0.1:'+port);
  assert.match((await verify({...got,owners,chain})).problems[0],/names dead outputs or a fee wallet that are not mainnet's/);assert.match((await verify({...got,owners})).problems[0],/not mainnet's/);
  chain.info=info;assert.equal((await verify({...got,owners,chain})).ok,true);
 }finally{await service.close();}
 // An owner list with an entry that has no output index: nothing is opened and nothing is written.
 const bare=owners.map((o,i)=>{if(i!==4)return o;const {ownerOutputIndex,...rest}=o;return rest;});
 assert.throws(()=>open({dir:join(dir,'bare'),owners:bare}),/Owner list entry 4 does not state the global index of its owner output/);assert.equal(existsSync(join(dir,'bare','meta.json')),false);
 assert.equal(open({dir:join(dir,'bare'),owners:bare,burnFrom:null}).ledger.burn,null);});

test('the service: the setting in /info, burn claims and fee payments in /burns, the waiting state, the entry and the log, and the check tools agree',async()=>{
 const {w,owners,chain,open,claim,move,burn,dir}=world({every:2}),reader=open();
 const service=createService({reader,owners,testHooks:true,chunk:4}),port=await service.listen(0),base='http://127.0.0.1:'+port;
 const get=async path=>{const r=await fetch(base+path);return {status:r.status,body:await r.json()};};
 const next=async(...txs)=>{chain.mine(txs);const r=await fetch(base+'/test/step',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(r.status,200);return r.json();};
 try{
  const info=(await get('/info')).body,fee=feeWallet(),address=n=>feeAddressOf(fee,n).address;
  assert.equal(info.burnFrom,FROM);assert.deepEqual(info.burn,{recordsEnd:END,address:burnAddress(),viewKey:BURN.viewSecret,text:'xmr721 claim to <address>',dead:[...MAINNET_DEAD],ownerOutputs:ownerOutputsHash(owners),
   fee:{wallet:fee.address,viewKey:fee.viewKey,account:1,safe:FEE_SAFE.toString()}});
  assert.deepEqual((await get('/mordinal/3')).body.mordinal.ownerOutput,1003);assert.deepEqual((await get('/mordinal/3')).body.mordinal.burnFee,{address:address(3),paid:'0'});
  // The owner list as served states each owner output's index: both hashes can be recomputed from it.
  const served=[];for(let from=0;from<owners.length;from+=4)served.push(...(await get('/owners?from='+from)).body.entries);
  assert.deepEqual(served.map(o=>o.ownerOutputIndex),[1000,1001,1002,1003,1004,1005]);assert.equal(ownerOutputsHash(served),info.burn.ownerOutputs);assert.equal(ownersHash(served),info.owners);
  const c0=claim(0,w.alice,reader.ledger);await next(c0);await next();                               // 101, 102
  const good=burn('service',3,w.dave),bad=burn('service bad',1,w.dave,{fee:5n,paid:false}),late=claim(4,w.alice,reader.ledger);
  await next(good,bad,late);                                                                         // 103: good pays its own fee
  const mv=move(3,w.dave,w.bob,reader.ledger),second=burn('service 2',5,w.carol,{paid:false});await next(mv,second);   // 104: second pays none
  const id=burnClaimId(DOMAIN,good.txid),id2=burnClaimId(DOMAIN,second.txid);
  // Burned and waiting for its fee: not claimed, no owner; the page has the amount and the fee address to show.
  {const m=(await get('/mordinal/5')).body;assert.equal(m.mordinal.claimed,false);assert.equal(m.mordinal.owner,null);assert.equal(m.mordinal.waiting.due,DUE.toString());
   assert.deepEqual(m.mordinal.waiting,{txid:second.txid,id:id2,to:w.carol.address,height:104,due:DUE.toString(),paid:'0',missing:DUE.toString()});assert.deepEqual(m.mordinal.burnFee,{address:address(5),paid:'0'});
   assert.deepEqual(m.history.map(h=>h.kind),['inscribed']);
   assert.deepEqual((await get('/entry/'+second.txid)).body,{height:104,entry:{txid:second.txid,height:104,pos:1,id:id2,op:null,kind:'burn claim',number:5,to:w.carol.address,state:'waiting',
    fee:{due:DUE.toString(),paid:'0',missing:DUE.toString(),address:address(5)},ok:true},confirmations:1});
   assert.deepEqual((await get('/status/'+id2)).body,{height:104,id:id2,state:'waiting',txid:second.txid,confirmations:0,error:null,fee:{due:DUE.toString(),paid:'0',missing:DUE.toString(),address:address(5)}});
   assert.equal((await get('/gallery')).body.items.find(x=>x.number===5).waiting,true);assert.deepEqual((await get('/claimed')).body.numbers,[0,3,4]);}
  // 105: an ordinary payment of the fee to Mordinal 5's fee address, beside another payment, completes the claim there.
  const pay=payFee('service fee',5,DUE,{alongside:wallet('somebody')});await next(pay);await next();   // 105, 106
  // The Mordinal, its history, the address that now owns it.
  const m=(await get('/mordinal/5')).body;assert.equal(m.mordinal.claimed,true);assert.equal(m.mordinal.owner,w.carol.address);assert.equal(m.mordinal.seq,0);assert.equal('waiting' in m.mordinal,false);
  assert.deepEqual(m.history.map(h=>h.kind),['inscribed','claim']);assert.deepEqual(m.mordinal.burnFee,{address:address(5),paid:DUE.toString()});
  assert.deepEqual({...m.history[1],time:0},{height:105,pos:0,txid:second.txid,id:id2,time:0,kind:'claim',number:5,to:w.carol.address,proof:'burn',burnHeight:104,feeTx:pay.txid,confirmations:2});
  assert.deepEqual((await get('/address/'+w.bob.address)).body.mordinals.map(x=>x.number),[3]);assert.deepEqual((await get('/claimed')).body.numbers,[0,3,4,5]);
  // What became of each transaction.
  assert.deepEqual((await get('/entry/'+good.txid)).body,{height:106,entry:{txid:good.txid,height:103,pos:0,id,op:null,kind:'burn claim',number:3,to:w.dave.address,state:'claimed',claimedAt:103,
   fee:{due:DUE.toString(),paid:DUE.toString(),missing:'0',address:address(3)},ok:true,fees:[{index:1,number:3,amount:DUE.toString(),counted:true,error:null}]},confirmations:4});
  assert.deepEqual((await get('/entry/'+second.txid)).body.entry,{txid:second.txid,height:104,pos:1,id:id2,op:null,kind:'burn claim',number:5,to:w.carol.address,state:'claimed',claimedAt:105,fee:{due:DUE.toString(),paid:DUE.toString(),missing:'0',address:address(5)},ok:true});
  assert.deepEqual((await get('/entry/'+pay.txid)).body.entry,{txid:pay.txid,height:105,pos:0,id:null,op:null,kind:'fee payment',ok:true,fees:[{index:1,number:5,amount:DUE.toString(),counted:true,error:null}]});
  assert.deepEqual((await get('/entry/'+bad.txid)).body.entry,{txid:bad.txid,height:103,pos:1,id:burnClaimId(DOMAIN,bad.txid),op:null,kind:'burn claim',ok:false,error:'The fee is below the 0.001 XMR the original rules ask for a text of 111 bytes.'});
  assert.equal((await get('/entry/'+late.txid)).body.entry.ok,true);assert.equal((await get('/entry/'+c0.txid)).body.entry.kind,undefined);
  assert.deepEqual((await get('/status/'+id)).body,{height:106,id,state:'done',txid:good.txid,confirmations:4,error:null});
  assert.deepEqual((await get('/status/'+id2)).body,{height:106,id:id2,state:'done',txid:second.txid,confirmations:2,error:null});
  // Activity, the records (MD1 records only), the burn claims and fee payments, and the log (everything judged).
  const act=(await get('/activity?kind=claim')).body.events;assert.deepEqual(act.map(e=>[e.number,e.proof,e.height]),[[5,'burn',105],[4,'one-time key',103],[3,'burn',103],[0,'one-time key',101]]);
  const records=(await get('/records')).body;assert.equal(records.total,3);assert.deepEqual(records.records,reader.journal.filter(e=>e.ok&&e.record).map(e=>e.record));
  const burns=(await get('/burns')).body;
  assert.deepEqual(burns,{height:106,total:3,from:0,burns:[{height:103,pos:0,txid:good.txid,id,before:1,burn:burnParts(good.tx),state:'claimed',fee:feeParts(good.tx)},
   {height:104,pos:1,txid:second.txid,id:id2,before:3,burn:burnParts(second.tx),state:'claimed'},{height:105,pos:0,txid:pay.txid,before:3,fee:feeParts(pay.tx)}]});
  assert.deepEqual((await get('/burns?from=1&limit=1')).body.burns.map(x=>x.txid),[second.txid]);
  // A client replays the ledger from the two lists: records[0..before), then the burn claim and the fee payments, and the rest of the records.
  {const l=createLedger({domain:DOMAIN,feeAddress:w.fee.address,owners:served,height:burns.height,burnFrom:info.burnFrom});let at=0;const bytes=h=>Uint8Array.from(Buffer.from(h,'hex'));
   for(const x of burns.burns){for(;at<x.before;at++)l.apply(bytes(records.records[at]));if(x.burn)assert.equal(l.applyBurnClaim(x.txid,x.burn).id,x.id);if(x.fee)l.applyBurnFees(x.txid,x.fee);}
   for(;at<records.total;at++)l.apply(bytes(records.records[at]));
   assert.deepEqual(l.toJSON().claimed.map(c=>[c.number,c.owner,c.seq]),reader.ledger.toJSON().claimed.map(c=>[c.number,c.owner,c.seq]));assert.deepEqual(l.toJSON().fees,reader.ledger.toJSON().fees);}
  const log=(await get('/log')).body;assert.equal(log.total,7);assert.deepEqual(log.entries[1].burn,burnParts(good.tx));assert.deepEqual(log.entries[6],{height:105,pos:0,txid:pay.txid,ok:true,fee:feeParts(pay.tx)});
  const stats=(await get('/stats')).body;assert.deepEqual([stats.claimed,stats.records,stats.refused,stats.byKind.claim,stats.burns],[4,5,1,4,{waiting:0,feePayments:2}]);
  const cps=(await get('/checkpoints')).body.checkpoints;assert.deepEqual(cps.map(c=>[c.height,c.burnFrom??null,c.burnFee??null,c.records]),[[102,null,null,1],[104,FROM,fee.address,5],[106,FROM,fee.address,6]]);
  // The check tools: the log replays, sits on the node as logged, and a reader of one's own finds the same.
  const got=await download(base);assert.deepEqual(await verify({...got,owners,chain}),{ok:true,problems:[],accepted:6,refused:1,checkpoints:3,checkedOnNode:7});
  assert.deepEqual(await scan({...got,owners,chain,dir:join(dir,'scan')}),[]);
  const clone=()=>JSON.parse(JSON.stringify(got)),problems=async change=>{const g=clone();change(g);return (await verify({...g,owners,chain})).problems;};
  assert.match((await problems(g=>{g.entries[1].ok=false;g.entries[1].error='x';}))[0],/marked refused, but the rules accept it/);
  assert.match((await problems(g=>{g.entries[2].ok=true;delete g.entries[2].error;}))[0],/marked accepted, but the rules refuse it: The fee is below/);
  assert.match((await problems(g=>{g.entries[2].error='Another reason.';}))[0],/refused for another reason than stated/);
  assert.match((await problems(g=>{g.entries[1].id='00'.repeat(32);}))[0],/not a well-formed burn claim entry/);
  assert.match((await problems(g=>{g.entries[1].burn.out0.tag=null;}))[0],/is not on the node as logged/);
  assert.match((await problems(g=>{g.entries.splice(1,1);}))[0],/marked accepted, but the rules refuse it: This Mordinal has not been claimed yet/);
  assert.match((await problems(g=>{delete g.checkpoints[1].burnFrom;}))[0],/another first burn block, other dead outputs, other owner outputs or another fee wallet/);
  assert.match((await problems(g=>{g.checkpoints[2].burnFee=address(5);}))[0],/another fee wallet/);
  assert.match((await problems(g=>{g.info.burn.ownerOutputs='00'.repeat(32);}))[0],/other owner output indexes/);
  assert.match((await problems(g=>{g.info.burn.dead=TEST_DEAD;}))[0],/another first burn block, other dead outputs/);
  assert.match((await verify({...got,owners:owners.map((o,i)=>i===5?{...o,ownerOutputIndex:5}:o),chain})).problems[0],/other owner output indexes/);
  // A fee payment left out, one with another amount, one that pays nothing, fee parts that are not the node's.
  assert.match((await problems(g=>{g.entries.splice(6,1);}))[0],/Checkpoint at block 106: (records|stateHash|listHash) differs/);
  assert.match((await problems(g=>{const o=g.entries[6].fee.outs[1];o.amount=o.amount.replace(/^./,c=>c==='0'?'1':'0');}))[0],/Checkpoint at block 106: (stateHash|listHash) differs/);
  assert.match((await problems(g=>{g.entries[4].fee=g.entries[6].fee;}))[0],/Checkpoint at block 104: (stateHash|records|listHash) differs|on the node as logged/);
  assert.match((await problems(g=>{g.entries[6].fee=feeParts(makeTx('pays nobody',[{to:wallet('x'),amount:1n}]).tx);}))[0],/logged as a fee payment, but the rules find none in it/);
  assert.match((await problems(g=>{g.entries[6].ok=false;}))[0],/not a well-formed fee payment entry/);
  {const g=clone();g.entries[6].fee.outs[0].tag='00';const r=await verify({...g,owners,chain});assert.equal(r.ok,false);assert.ok(r.problems.some(p=>/fee payments of transaction .* are not on the node as logged/.test(p)),r.problems.join('; '));}
 }finally{await service.close();}});

test('a burning ledger on stagenet names its own dead outputs, and the check tools replay it',async()=>{
 const w=Object.fromEntries(['alice','bob','carol','fee'].map(n=>[n,wallet(n,'stagenet')])),holders=[w.alice,w.bob,w.alice];
 const owners=holders.map((h,i)=>({...ownerEntry(i,makeTx('burn stagenet '+i,[{to:h,amount:10n**9n}])),registrationHeight:50+i,ownerHeight:50+i}));
 const dir=mkdtempSync(join(tmpdir(),'mordinals-burn-stagenet-'));dirs.push(dir);
 const chain=fakeChain({start:100}),setup={chain,network:'stagenet',domain:DOMAIN,feeAddress:w.fee.address,owners,start:100,checkpointEvery:2,burnFrom:FROM};
 // Off mainnet there is no list to fall back on: the setup has to name the fifteen.
 assert.throws(()=>openReader({...setup,dir:join(dir,'none')}),/has to name its fifteen dead outputs/);
 const reader=openReader({...setup,dir:join(dir,'state'),burnDead:TEST_DEAD});assert.equal(reader.meta.burnDead,TEST_DEAD.join(','));assert.equal(reader.ledger.burn.address,burnAddress('stagenet'));
 const service=createService({reader,owners,testHooks:true}),port=await service.listen(0),base='http://127.0.0.1:'+port,get=async path=>(await (await fetch(base+path)).json());
 // (Each pays its own fee to the stagenet fee address of its Mordinal.)
 const burn=(label,n,to,more)=>{const t=makeBurn(label,{output:1000+n,to,dead:TEST_DEAD,outs:[{to:burnParty,amount:1n},{to:feeParty(n,{network:'stagenet'}),amount:DUE},{to:wallet(label+' change','stagenet'),amount:1n}],...more});return {txid:t.txid,tx:t.tx};};
 try{
  const info=await get('/info');assert.equal(info.network,'stagenet');assert.deepEqual(info.burn.dead,TEST_DEAD);assert.equal(info.burn.address,burnAddress('stagenet'));
  chain.mine();chain.mine();
  const good=burn('stagenet good',1,w.carol),mainnetRing=burn('stagenet other ring',2,w.carol,{dead:MAINNET_DEAD}),mainnetText=burn('stagenet other text',2,wallet('carol'));
  chain.mine([good,mainnetRing,mainnetText]);chain.mine();await reader.sync();                                      // 103, 104
  assert.equal(reader.ledger.mordinal(1).owner,w.carol.address);assert.equal(reader.ledger.mordinal(2).claimed,false);
  assert.match((await get('/entry/'+mainnetRing.txid)).entry.error,/No input/);assert.match((await get('/entry/'+mainnetText.txid)).entry.error,/mainnet address/);
  // The check tool replays the log with the dead outputs the service names, finds it on the node, and a reader of one's own agrees.
  const got=await download(base);assert.deepEqual(await verify({...got,owners,chain}),{ok:true,problems:[],accepted:1,refused:2,checkpoints:2,checkedOnNode:3});
  assert.equal((await verify({...got,owners})).ok,true);
  assert.deepEqual(await scan({...got,owners,chain,dir:join(dir,'scan')}),[]);
  // Another list than the service's own does not replay.
  const other=JSON.parse(JSON.stringify(got));other.info.burn.dead=[...MAINNET_DEAD];assert.equal((await verify({...other,owners,chain})).ok,false);
 }finally{await service.close();}});

test('the service without the setting answers as before',async()=>{
 const {w,owners,chain,open,burn}=world(),reader=open({burnFrom:null});
 const service=createService({reader,owners,testHooks:true}),port=await service.listen(0),base='http://127.0.0.1:'+port,get=async path=>(await (await fetch(base+path)).json());
 try{
  const b=burn('unseen',3,w.dave);chain.mine([b]);chain.mine();chain.mine();await reader.sync();
  const info=await get('/info');assert.equal('burnFrom' in info,false);assert.equal('burn' in info,false);
  assert.deepEqual(Object.keys(info),['network','domain','feeAddress','height','count','chunk','test','owners','start','startHash','mintFrom','relay','rules']);
  assert.equal('ownerOutput' in (await get('/mordinal/3')).mordinal,false);assert.equal((await get('/mordinal/3')).mordinal.claimed,false);
  assert.deepEqual(Object.keys((await get('/owners')).entries[0]),['number','registrationTx','ownerTx','ownerOutputKey','ownerViewTag','ownerTxPubKeys']);
  assert.equal((await fetch(base+'/burns')).status,(await fetch(base+'/no-such-route')).status);
  assert.equal((await get('/log')).total,0);assert.equal((await get('/entry/'+b.txid)).error,'This reader has read no record in this transaction.');
 }finally{await service.close();}});
