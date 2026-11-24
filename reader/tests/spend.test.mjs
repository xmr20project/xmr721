// Offline tests of claiming by a spent coin (RULES.md section 11) in the reader, the relay and the service, with a made-up
// node and made-up keys: node --test reader/tests/spend.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {hex} from '../../rules/lib/monero.mjs';
import {outputSecret} from '../../rules/lib/claim.mjs';
import {RECORDS_OVERLAP,MAINNET_DEAD} from '../../rules/lib/burn.mjs';
import {SPEND_FEE,signKeyImage} from '../../rules/lib/spend.mjs';
import {wallet,makeTx,ownerEntry,makeInProof,payFee,offsetsOf,DOMAIN} from '../../rules/tests/helpers.mjs';
import {openReader,BURN_MARGIN,SCHEMA,SCHEMA_BURN,SCHEMA_SPEND} from '../lib/reader.mjs';
import {createService} from '../service.mjs';
import {createRelay} from '../lib/relay.mjs';
import {verify,scan,download} from '../tools/verify.mjs';
import {fakeChain,fakeCarrier,carried} from './fake.mjs';

const dirs=[];test.after(()=>{for(const d of dirs)rmSync(d,{recursive:true,force:true});});
const FROM=102,SPEND=104,END=FROM+RECORDS_OVERLAP;
const sha=t=>createHash('sha256').update(t).digest('hex');
// An ordinary transaction that spends the given key images: its inputs and extra field as the node shows them.
let spends=0;
function spendTx(images,{extra=null}={}){const k=spends++;
 return {txid:sha('spend tx '+k),tx:{version:2,vin:images.map(i=>({key:{amount:0,key_offsets:[5,6],k_image:i}})),vout:[],extra:extra??[1,...Buffer.from(sha('spend tx key '+k),'hex')]}};}
const json=x=>JSON.parse(JSON.stringify(x));
const snapshot=r=>JSON.stringify({h:r.height,hash:r.hash,j:r.journal,e:r.events,c:r.checkpoints,s:r.ledger.toJSON(),now:r.checkpoint()});

function world({every=0}={}){
 const w=Object.fromEntries(['alice','bob','carol','fee'].map(n=>[n,wallet(n)]));
 const holders=[w.alice,w.alice.sub(2),w.bob,w.carol];
 const owners=holders.map((h,i)=>({...ownerEntry(i,makeTx('spend reader '+i,[{to:h,amount:10n**9n}],{subaddressKey:h.kind==='sub'})),registrationHeight:50+i,ownerHeight:50+i}));
 const dir=mkdtempSync(join(tmpdir(),'mordinals-spend-'));dirs.push(dir);
 const chain=fakeChain({start:100}),state=join(dir,'state');
 const open=(o={})=>openReader({dir:state,chain,domain:DOMAIN,feeAddress:w.fee.address,owners,start:100,checkpointEvery:every,burnFrom:FROM,spendFrom:SPEND,...o});
 const secret=k=>outputSecret({viewSecret:holders[k].viewSecret,spendSecret:holders[k].spendSecret,txPub:owners[k].ownerTxPubKeys[0],subScalar:holders[k].subScalar});
 // The holder's key image export for the coin of Mordinal k.
 const signed=k=>signKeyImage(secret(k));
 // The holder's claim of Mordinal k by its coin, spent in s, to `to`: the record's bytes.
 const record=(l,k,s,{to=holders[k],ki=signed(k)}={})=>{const h=holders[k],p=l.prepareClaim({mordinal:k,to:to.address,holder:h.address,spendTx:s.txid,keyImage:ki.keyImage});
  return l.claimWithSpend(p.bodyBytes,makeInProof({txid:owners[k].ownerTx,txPub:owners[k].ownerTxPubKeys[0],holder:h}),{c:ki.c,r:ki.r},h.sign(p.text));};
 return {w,holders,owners,dir,state,chain,open,signed,record};}

test('the reader takes claims by a spent coin from their first block on: one waits for its fee, and all is rebuilt without a node',async()=>{
 const {w,holders,chain,open,signed,record,state}=world({every:2}),reader=open(),L=()=>reader.ledger;
 assert.equal(reader.meta.spendFrom,SPEND);assert.deepEqual(L().spend,{from:SPEND,fee:SPEND_FEE.toString()});
 // A schema of its own: reader code from before section 11 refuses this folder (it compares the schema).
 assert.equal(reader.meta.schema,SCHEMA+SCHEMA_BURN+SCHEMA_SPEND);
 // 101: alice spends the coin of Mordinal 1 (it is at a subaddress) in an ordinary transaction. 103: her claim, before the
 // first block of claims by a spent coin: there it is no known record, logged as a reader from before section 11 logs it.
 const s1=spendTx([signed(1).keyImage]),early=carried(record(L(),1,s1),'early');
 chain.mine([s1]);chain.mine();chain.mine([early]);await reader.sync();
 assert.deepEqual(reader.journal.map(e=>[e.height,e.txid,e.ok,e.error??null]),[[103,early.txid,false,'Unknown proof kind']]);assert.deepEqual(Object.keys(reader.journal[0]),['height','pos','txid','record','ok','error']);
 // 104: her claim again: the coin was spent before the first block of such claims, so it never counts. In the same block
 // alice spends the coin of Mordinal 0, and bob claims Mordinal 2 with a spend in this very block: refused.
 const c1=carried(record(L(),1,s1,{to:w.carol}),'c1'),s0=spendTx([signed(0).keyImage]),s2=spendTx([signed(2).keyImage]),same=carried(record(L(),2,s2),'same');
 chain.mine([c1,s0,s2,same]);await reader.sync();
 assert.deepEqual(reader.journal.slice(1).map(e=>[e.height,e.pos,e.txid,e.ok,e.error??null]),[[104,0,c1.txid,false,`The coin was spent before block ${SPEND}; only a coin spent from that block on claims its Mordinal this way.`],[104,3,same.txid,false,'The spending transaction has to be in a block before the block of this record.']]);
 // 105: alice's claim of Mordinal 0, to carol: its coin was spent in block 104.
 const c0=carried(record(L(),0,s0,{to:w.carol}),'c0');chain.mine([c0]);await reader.sync();
 // The journal keeps what the rule read of the spending transaction: its block, extra field and the key images it spends.
 const e1=reader.journal[3],id1=e1.id;assert.deepEqual([e1.height,e1.txid,e1.ok],[105,c0.txid,true]);
 assert.deepEqual(json(e1.facts),[{txid:s0.txid,height:104,tx:{extra:s0.tx.extra,vin:[{key:{k_image:signed(0).keyImage,key_offsets:[5,6]}}]}}]);
 // It waits for its fee: no event yet, and the Mordinal is not claimed.
 assert.deepEqual([L().burnClaim(id1).state,L().burnClaim(id1).kind,L().burnClaim(id1).due,L().mordinal(0).claimed,Boolean(L().mordinal(0).waiting)],['waiting','spend',SPEND_FEE.toString(),false,true]);
 assert.deepEqual(reader.events,[]);assert.deepEqual(L().toJSON().waiting,[{number:0,id:id1,to:w.carol.address,due:SPEND_FEE.toString()}]);
 // 106: half the fee; 107: the rest, in a transaction that pays someone else too. The claim completes in block 107; its
 // event carries the transaction of the record, where the record and the spend are, and the payment that completed it.
 const half1=payFee('spend half 1',0,SPEND_FEE/2n),half2=payFee('spend half 2',0,SPEND_FEE-SPEND_FEE/2n,{alongside:wallet('somebody')});
 chain.mine([half1]);await reader.sync();assert.equal(L().burnClaim(id1).missing,(SPEND_FEE-SPEND_FEE/2n).toString());assert.deepEqual(reader.events,[]);
 chain.mine([half2]);await reader.sync();assert.equal(L().mordinal(0).owner,w.carol.address);
 assert.deepEqual(reader.events.map(e=>[e.kind,e.number,e.to,e.proof,e.height,e.txid,e.id,e.spendTx,e.recordHeight,e.feeTx]),[['claim',0,w.carol.address,'spent coin',107,c0.txid,id1,s0.txid,105,half2.txid]]);
 assert.equal(reader.events[0].time,reader.timeOf(107));
 assert.deepEqual(L().mordinal(0).history.at(-1),{what:'claim',height:107,record:id1,to:w.carol.address,proof:'spent coin',tx:s0.txid});
 // 108: the fee for Mordinal 3 paid ahead, and carol spends its coin; 109: her claim, claimed in its own block.
 const pre=payFee('spend ahead',3,SPEND_FEE),s3=spendTx([signed(3).keyImage]);chain.mine([pre,s3]);
 const c3=carried(record(L(),3,s3),'c3');chain.mine([c3]);await reader.sync();
 assert.equal(L().mordinal(3).owner,holders[3].address);const last=reader.events.at(-1);
 assert.deepEqual([last.kind,last.number,last.proof,last.height,last.txid,last.spendTx,'recordHeight' in last,'feeTx' in last],['claim',3,'spent coin',109,c3.txid,s3.txid,false,false]);
 assert.equal(L().mordinal(1).claimed,false);
 // Checkpoints name the first block of claims by a spent coin from that block on.
 const [c102,c104]=reader.checkpoints;assert.deepEqual([c102.height,c104.height],[102,104]);assert.equal('spendFrom' in c102,false);
 assert.deepEqual(Object.keys(c104),['schema','network','domain','owners','start','burnFrom','burnDead','ownerOutputs','burnFee','spendFrom','height','blockHash','records','listHash','stateHash']);assert.equal(c104.spendFrom,SPEND);
 // Opened again from its folder, and read again from the node by another reader: the same journal, events and checkpoints.
 const calls=chain.calls,again=open();assert.equal(chain.calls,calls);assert.equal(snapshot(again),snapshot(reader));
 const fresh=open({dir:state+'-fresh'});await fresh.sync();assert.equal(snapshot(fresh),snapshot(reader));
 // A reader without the setting knows no such record; up to the block before it, the two agree on every checkpoint and
 // write the same log.
 const plain=open({dir:state+'-plain',spendFrom:null});await plain.sync();
 assert.deepEqual(plain.journal.filter(e=>e.record!==undefined).map(e=>[e.txid,e.ok,e.error??null]),[early,c1,same,c0,c3].map(t=>[t.txid,false,'Unknown proof kind']));
 assert.deepEqual(plain.journal[0],reader.journal[0]);assert.equal(plain.meta.schema,SCHEMA+SCHEMA_BURN);
 assert.equal(plain.ledger.mordinal(0).claimed,false);assert.deepEqual(plain.checkpoints[0],c102);assert.notDeepEqual(plain.checkpoints[1],c104);
 // A folder keeps its setting; a bad one is refused.
 assert.throws(()=>open({spendFrom:SPEND+20}),/made for another ledger \(spendFrom differs\)/);assert.throws(()=>open({spendFrom:null}),/made for another ledger \(schema differs\)/);
 assert.throws(()=>open({dir:state+'-bad',spendFrom:FROM-1}),/Bad first block of claims by a spent coin/);assert.throws(()=>open({dir:state+'-bad',burnFrom:null}),/Bad first block of claims by a spent coin/);
 assert.throws(()=>open({dir:state+'-bad',spendFrom:'104'}),/Bad first block of claims by a spent coin/);});

test('refused in the reader: a spend that does not spend the coin, one that moved the Mordinal in the original format, one not in a block, a second claim',async()=>{
 const {w,chain,open,signed,record}=world(),reader=open(),L=()=>reader.ledger;
 for(let h=101;h<SPEND;h++)chain.mine();
 const other=spendTx([signed(3).keyImage]),odd={txid:sha('odd'),tx:{version:2,vin:[{key:{amount:0,key_offsets:offsetsOf([...MAINNET_DEAD,1000]),k_image:signed(0).keyImage}}],vout:[],extra:[1,...Buffer.from(sha('odd'),'hex'),0x11,3,65,66,67]}},pool=spendTx([signed(2).keyImage]),s0=spendTx([signed(0).keyImage]);
 chain.mine([other,odd,s0]);await reader.sync();chain.publish(pool);                                       // 104; one spend waits in the pool
 const wrong=carried(record(L(),0,other),'wrong'),notOrdinary=carried(record(L(),0,odd),'odd'),waits=carried(record(L(),2,pool),'pool'),good=carried(record(L(),0,s0),'good'),again=carried(record(L(),0,s0,{to:w.bob}),'again');
 chain.mine([wrong,notOrdinary,waits,good,again],{only:[wrong.txid,notOrdinary.txid,waits.txid,good.txid,again.txid]});await reader.sync();
 // (The transfer of Mordinal 0 in the original format was read as a burn in block 104, and refused for its text.)
 assert.deepEqual(reader.entryByTx(odd.txid).ok,false);const records=reader.journal.filter(e=>e.record!==undefined);
 assert.deepEqual(records.map(e=>[e.txid,e.ok,e.error??null]),[
  [wrong.txid,false,'The spending transaction does not spend the owner coin (no input has its key image).'],
  [notOrdinary.txid,false,'The spending transaction is a transfer of this Mordinal in the original Mordinals format (a transfer or a burn): the Mordinal moved with it, so its spent coin does not claim it.'],
  [waits.txid,false,'The spending transaction was not looked up.'],
  [good.txid,true,null],
  [again.txid,false,'A claim of this Mordinal by its spent coin waits for its fee already.']]);
 // The spend still in the pool is not kept in the journal; a key image signed for another coin is refused before any lookup.
 assert.deepEqual(records[2].facts,[]);
 const forged=carried(record(L(),2,s0,{ki:signed(0)}),'forged');chain.mine([forged],{only:[forged.txid]});await reader.sync();
 assert.equal(reader.entryByTx(forged.txid).error,'The signed key image is not the key image of the owner coin.');});

test('a replaced block takes a claim by a spent coin away; in the block of its spend it is refused, and later it counts again',async()=>{
 const {w,chain,open,signed,record,state}=world(),reader=open(),L=()=>reader.ledger;
 for(let h=101;h<SPEND;h++)chain.mine();
 const s=spendTx([signed(2).keyImage]);chain.mine([s]);                                                     // 104
 const bytes=record(L(),2,s,{to:w.carol}),c=carried(bytes,'first');chain.mine([c]);                       // 105
 const fee=payFee('spend reorg fee',2,SPEND_FEE);chain.mine([fee]);await reader.sync();                     // 106
 assert.equal(L().mordinal(2).owner,w.carol.address);
 // Blocks 104 to 106 replaced; their transactions all come back in one block, 104: the claim is refused there, the fee counts.
 chain.pop(3,{keep:true});chain.mine();const r=await reader.sync();assert.deepEqual([r.height,r.reorg],[104,3]);
 assert.equal(L().mordinal(2).claimed,false);assert.equal(L().burnFee(2).paid,SPEND_FEE.toString());assert.deepEqual(reader.events,[]);
 assert.equal(reader.entryByTx(c.txid).error,'The spending transaction has to be in a block before the block of this record.');
 // The same record carried again in block 105: the fee is there already, so it is claimed in that block.
 const c2=carried(bytes,'second');chain.mine([c2]);await reader.sync();
 assert.equal(L().mordinal(2).owner,w.carol.address);assert.deepEqual(reader.events.map(e=>[e.height,e.txid,e.proof]),[[105,c2.txid,'spent coin']]);
 const fresh=open({dir:state+'-fresh'});await fresh.sync();assert.equal(snapshot(fresh),snapshot(reader));});

test('a folder takes in the first block of claims by a spent coin while that block is at least 10 blocks away',async()=>{
 const {chain,open,state}=world(),meta=()=>JSON.parse(readFileSync(join(state,'meta.json'),'utf8'));
 const before=open({spendFrom:null});chain.mine();chain.mine();chain.mine();await before.sync();             // 103
 assert.equal(meta().spendFrom,undefined);assert.equal(BURN_MARGIN,10);
 assert.throws(()=>open({spendFrom:112}),/has to be at least 10 blocks above the newest block this folder has read \(103\)/);
 // 113: taken in, and written once the node's newest block is known.
 const r=open({spendFrom:113});assert.equal(r.spendPending,113);assert.equal(r.meta.spendFrom,undefined);assert.equal(meta().spendFrom,undefined);
 assert.equal(meta().schema,SCHEMA+SCHEMA_BURN);
 await r.sync();assert.equal(r.spendPending,null);assert.equal(meta().spendFrom,113);assert.equal(r.meta.spendFrom,113);assert.equal(meta().schema,SCHEMA+SCHEMA_BURN+SCHEMA_SPEND);
 // Opened again it keeps it; without it (as reader code from before section 11 opens it), or with another block, it is another ledger.
 assert.equal(open({spendFrom:113}).spendPending,null);assert.throws(()=>open({spendFrom:null}),/schema differs/);assert.throws(()=>open({spendFrom:130}),/spendFrom differs/);
 // A node whose newest block is too close: refused, and the folder keeps what it had.
 const b=world(),first=b.open({spendFrom:null});b.chain.mine();await first.sync();for(let i=0;i<9;i++)b.chain.mine();   // folder 101, node 110
 const close=b.open({spendFrom:115});assert.equal(close.spendPending,115);
 await assert.rejects(close.sync(),/at least 10 blocks above the newest block of the Monero node \(110\); this folder keeps its setting/);
 assert.equal(JSON.parse(readFileSync(join(b.state,'meta.json'),'utf8')).spendFrom,undefined);
 // A folder that read the block already cannot take it in.
 const plainB=b.open({spendFrom:null});assert.equal(plainB.height,101);await plainB.sync();assert.equal(plainB.height,110);
 assert.throws(()=>b.open({spendFrom:105}),/schema differs/);});

test('the relay holds a claim by a spent coin until the spend is below the newest block, and carries it after claim records end',async()=>{
 const {w,chain,open,signed,record,dir}=world(),reader=open(),relay=createRelay({dir:join(dir,'relay'),reader,chain,carrier:fakeCarrier(chain,{coins:6}),domain:DOMAIN,limits:{resendMs:1000},now:()=>1_000_000});
 const sOld=spendTx([signed(1).keyImage]);chain.mine([sOld]);for(let h=102;h<=SPEND;h++)chain.mine();await reader.sync();
 // A coin spent before the first block of such claims: refused, nothing carried.
 await assert.rejects(relay.submit(hex(record(reader.ledger,1,sOld))),e=>/was spent before block 104/.test(e.message)&&e.rule===true);
 // A spend the node does not know: refused, nothing carried.
 const s0=spendTx([signed(0).keyImage]);
 await assert.rejects(relay.submit(hex(record(reader.ledger,0,s0))),e=>/does not know the transaction that spent the coin/.test(e.message)&&e.rule===true);
 assert.deepEqual(await chain.pool(),[]);
 // In the pool: held. In the newest block (105): still held. Below it (106): carried, and in block 107 it waits for its fee.
 chain.publish(s0);const held=await relay.submit(hex(record(reader.ledger,0,s0,{to:w.bob})));assert.equal(held.state,'held');assert.deepEqual(await chain.pool(),[s0.txid]);
 chain.mine();await reader.sync();await relay.tick();assert.equal(relay.status(held.id).state,'held');assert.deepEqual(await chain.pool(),[]);
 chain.mine();await reader.sync();await relay.tick();assert.equal(relay.status(held.id).state,'sent');
 chain.mine();await reader.sync();await relay.tick();assert.equal(reader.ledger.burnClaim(held.id).state,'waiting');assert.equal(reader.entryById(held.id).height,107);
 // A second claim of that Mordinal while it waits: refused by the rules, not carried.
 await assert.rejects(relay.submit(hex(record(reader.ledger,0,s0))),e=>/waits for its fee already/.test(e.message)&&e.rule===true);
 // The service: the setting in /info, the waiting claim in /status, /mordinal and /entry, then done once the fee is paid.
 const service=createService({reader,relay,owners:[],testHooks:true}),port=await service.listen(0),get=async p=>(await fetch(`http://127.0.0.1:${port}${p}`)).json();
 try{const info=await get('/info');assert.deepEqual([info.spendFrom,info.spend],[SPEND,{fee:SPEND_FEE.toString()}]);
  const st=await get('/status/'+held.id);assert.deepEqual([st.state,st.txid,st.fee.due,st.fee.missing,st.error],['waiting',reader.entryById(held.id).txid,SPEND_FEE.toString(),SPEND_FEE.toString(),null]);
  const en=await get('/entry/'+reader.entryById(held.id).txid);assert.deepEqual([en.entry.kind,en.entry.state,en.entry.number,en.entry.to],['spent coin claim','waiting',0,w.bob.address]);
  chain.mine([payFee('spend relay fee',0,SPEND_FEE)]);await reader.sync();await relay.tick();
  const done=await get('/status/'+held.id);assert.deepEqual([done.state,done.confirmations],['done',1]);assert.equal(reader.ledger.mordinal(0).owner,w.bob.address);
 }finally{await service.close();}
 // After the last block of claim records: an ordinary claim is refused at the relay, a claim by a spent coin is carried.
 while(chain.tip<END)chain.mine();await reader.sync();
 const s3=spendTx([signed(3).keyImage]);chain.mine([s3]);chain.mine();await reader.sync();await relay.tick();
 const late=await relay.submit(hex(record(reader.ledger,3,s3)));assert.equal(late.state,'sent');
 chain.mine();await reader.sync();await relay.tick();assert.equal(reader.ledger.burnClaim(late.id).state,'waiting');assert.ok(reader.height>END);});

test('the service shows a waiting claim by a spent coin on its Mordinal page',async()=>{
 const {w,owners,chain,open,signed,record}=world(),reader=open();
 for(let h=101;h<=SPEND;h++)chain.mine();const s=spendTx([signed(1).keyImage]);chain.mine([s]);
 const c=carried(record(reader.ledger,1,s,{to:w.carol}),'page');chain.mine([c]);await reader.sync();
 const service=createService({reader,owners,testHooks:true}),port=await service.listen(0);
 try{const got=await (await fetch(`http://127.0.0.1:${port}/mordinal/1`)).json(),id=reader.entryByTx(c.txid).id;
  assert.deepEqual(json(got.mordinal.waiting),{txid:c.txid,id,to:w.carol.address,height:106,due:SPEND_FEE.toString(),paid:'0',missing:SPEND_FEE.toString(),proof:'spent coin',spendTx:s.txid});
 }finally{await service.close();}});

test('the check tool replays claims by a spent coin, finds their spending transactions on the node, and notices a changed log',async()=>{
 const {w,owners,chain,open,signed,record,dir}=world({every:2}),reader=open();
 for(let h=101;h<SPEND;h++)chain.mine();
 const s0=spendTx([signed(0).keyImage]),s2=spendTx([signed(2).keyImage]);chain.mine([s0,s2]);                       // 104
 const c0=carried(record(reader.ledger,0,s0,{to:w.carol}),'v0'),c2=carried(record(reader.ledger,2,s0),'v2');chain.mine([c0,c2]);   // 105: c2 names another coin's spend
 chain.mine([payFee('verify fee',0,SPEND_FEE)]);chain.mine();await reader.sync();                                      // 106, 107
 assert.equal(reader.ledger.mordinal(0).owner,w.carol.address);
 const service=createService({reader,owners,testHooks:true}),port=await service.listen(0),base='http://127.0.0.1:'+port;
 try{const got=await download(base);assert.equal(got.info.spendFrom,SPEND);
  assert.deepEqual(await verify({...got,owners,chain}),{ok:true,problems:[],accepted:2,refused:1,checkpoints:3,checkedOnNode:3});
  assert.deepEqual(await scan({...got,owners,chain,dir:join(dir,'scan')}),[]);
  const problems=async change=>{const g=JSON.parse(JSON.stringify(got));change(g);return (await verify({...g,owners,chain})).problems;};
  const at=g=>g.entries.find(e=>e.txid===c0.txid);
  // The spending transaction left out of the log: the replay refuses the claim.
  assert.match((await problems(g=>{at(g).facts=[];}))[0],/marked accepted, but the rules refuse it: The spending transaction was not looked up/);
  // Another key image in the logged inputs: the replay refuses it, and the node shows other inputs.
  assert.match((await problems(g=>{at(g).facts[0].tx.vin[0].key.k_image='ab'.repeat(32);}))[0],/marked accepted, but the rules refuse it: The spending transaction does not spend the owner coin/);
  const other=signed(1).keyImage;assert.match((await problems(g=>{at(g).facts[0].tx.vin.push({key:{k_image:other}});}))[0],/spending transaction [0-9a-f]{64} is not on the node as logged/);
  // A log that hides a claim: the spending transaction left out and the entry marked refused for it. The replay agrees
  // with such an entry (checkpoints left out here); the node shows what was left out.
  const hidden=async change=>problems(g=>{const e=at(g);change(e);e.ok=false;e.error='The spending transaction was not looked up.';g.checkpoints=[];});
  assert.match((await hidden(e=>{delete e.facts;})).join('\n'),/the transactions this record names are missing from the log/);
  assert.match((await hidden(e=>{e.facts=[];})).join('\n'),/is left out of the logged facts/);
  // A checkpoint that names another first block, or none.
  assert.match((await problems(g=>{g.checkpoints.at(-1).spendFrom=SPEND+1;}))[0],/another first block of claims by a spent coin/);
  assert.match((await problems(g=>{delete g.checkpoints.at(-1).spendFrom;}))[0],/another first block of claims by a spent coin/);
 }finally{await service.close();}});

test('the relay waits for the first block of such claims, keeps a held claim through a missed lookup, gives up after a while, and sends again a claim that blocks put beside its spend',async()=>{
 const {chain,open,signed,record,dir}=world(),reader=open(),relay=createRelay({dir:join(dir,'relay'),reader,chain,carrier:fakeCarrier(chain,{coins:8}),domain:DOMAIN,limits:{resendMs:1000,holdBlocks:3},now:()=>1_000_000});
 const step=async(txs=[])=>{chain.mine(txs);await reader.sync();await relay.tick();};
 // Two blocks before the first block of such claims the record could not reach it: refused. One block before: held,
 // and sent once the reader is at that block.
 const s0=spendTx([signed(0).keyImage]),empty=()=>chain.mine([],{only:[]});chain.publish(s0);empty();empty();await reader.sync();   // 102; the spend waits in the pool
 await assert.rejects(relay.submit(hex(record(reader.ledger,0,s0))),e=>/Claiming by a spent coin starts at block 104/.test(e.message)&&e.rule===true);
 empty();await reader.sync();const early=await relay.submit(hex(record(reader.ledger,0,s0)));assert.equal(early.state,'held');   // 103
 await step();assert.equal(relay.status(early.id).state,'held');                                                       // 104 holds the spend
 await step();assert.equal(relay.status(early.id).state,'sent');await step();assert.equal(reader.ledger.burnClaim(early.id).state,'waiting');

 // The node loses the spend for a moment while the claim is held: still held, then sent once the spend is below the newest block.
 const s2=spendTx([signed(2).keyImage]);chain.publish(s2);const held=await relay.submit(hex(record(reader.ledger,2,s2)));assert.equal(held.state,'held');
 chain.drop(s2.txid);await step();assert.equal(relay.status(held.id).state,'held');
 await step([s2]);assert.equal(relay.status(held.id).state,'held');await step();assert.equal(relay.status(held.id).state,'sent');
 await step();assert.equal(reader.ledger.burnClaim(held.id).state,'waiting');
 // A spend that never reaches a block: held for holdBlocks blocks, then refused.
 const s3=spendTx([signed(3).keyImage]);chain.publish(s3);const lost=await relay.submit(hex(record(reader.ledger,3,s3)));assert.equal(lost.state,'held');chain.drop(s3.txid);
 for(let i=0;i<4;i++)await step();assert.equal(relay.status(lost.id).state,'refused');assert.match(relay.status(lost.id).error,/did not reach a block in time/);
 // Blocks replaced, and the record comes back in one block with its spend: refused there, held, sent again, counted.
 const s1=spendTx([signed(1).keyImage]);await step([s1]);await step();
 const r1=await relay.submit(hex(record(reader.ledger,1,s1)));assert.equal(r1.state,'sent');await step();assert.equal(reader.ledger.burnClaim(r1.id).state,'waiting');
 chain.pop(3,{keep:true});await step();
 const refused=reader.journal.find(e=>e.id===r1.id);assert.equal(refused.ok,false);assert.equal(refused.error,'The spending transaction has to be in a block before the block of this record.');
 assert.equal(relay.status(r1.id).state,'held');
 await step();assert.equal(relay.status(r1.id).state,'sent');await step();assert.equal(reader.ledger.burnClaim(r1.id).state,'waiting');assert.equal(relay.status(r1.id).state,'done');});

test('the service finds the transaction that spent a key image: in the pool or the newest blocks, or around a given block',async()=>{
 const {w,owners,chain,open,signed,dir}=world(),reader=open();
 for(let h=101;h<SPEND;h++)chain.mine();const s0=spendTx([signed(0).keyImage]);chain.mine([s0]);for(let i=0;i<3;i++)chain.mine();   // the spend in 104; newest 107
 const s2=spendTx([signed(2).keyImage]);chain.publish(s2);await reader.sync();
 const service=createService({reader,owners,testHooks:true}),port=await service.listen(0),get=async p=>{const r=await fetch(`http://127.0.0.1:${port}${p}`);return {status:r.status,body:await r.json()};};
 try{let r=await get('/spent/'+signed(0).keyImage);assert.equal(r.status,200);assert.deepEqual(json(r.body.spent),{txid:s0.txid,height:104,tx:{extra:s0.tx.extra,vin:[{key:{k_image:signed(0).keyImage,key_offsets:[5,6]}}]}});
  assert.equal((await get('/spent/'+signed(0).keyImage+'?height=105')).body.spent.txid,s0.txid);
  {const r=(await get('/spent/'+signed(0).keyImage+'?height=102')).body;assert.equal(r.spent,null);assert.equal(r.earlier,true);}   // spent, in another block
  {const p=(await get('/spent/'+signed(2).keyImage)).body.spent;assert.deepEqual([p.txid,p.height],[s2.txid,null]);}
  {const r=(await get('/spent/'+signed(3).keyImage)).body;assert.equal(r.spent,null);assert.equal(r.earlier,undefined);}   // not spent: the node says so, no block is read
  // A spend older than the newest 10 blocks: the node says it is spent, the newest blocks do not hold it.
  for(let i=0;i<10;i++)chain.mine();await reader.sync();{const r=(await get('/spent/'+signed(0).keyImage)).body;assert.deepEqual([r.spent,r.earlier],[null,true]);}
  // Many lookups from one caller: a budget of its own.
  let limited=0;for(let i=0;i<12;i++)if((await get('/spent/'+signed(3).keyImage)).status===429)limited++;assert.ok(limited>=1,'no limit');
  assert.equal((await get('/spent/xyz')).status,400);assert.equal((await get('/spent/'+signed(3).keyImage+'?height=4000')).status,400);assert.equal((await get('/spent/'+signed(3).keyImage+'?height=1.5')).status,400);
 }finally{await service.close();}
 // A ledger without claims by a spent coin has no such route.
 const plain=open({dir:join(dir,'plain'),spendFrom:null});await plain.sync();const other=createService({reader:plain,owners,testHooks:true}),p2=await other.listen(0);
 try{assert.equal((await fetch(`http://127.0.0.1:${p2}/spent/${signed(0).keyImage}`)).status,404);}finally{await other.close();}});

test('the service lists the claims that wait for their fee',async()=>{
 const {w,owners,chain,open,signed,record}=world(),reader=open();
 for(let h=101;h<=SPEND;h++)chain.mine();const s=spendTx([signed(1).keyImage]);chain.mine([s]);
 const c=carried(record(reader.ledger,1,s,{to:w.carol}),'list');chain.mine([c]);chain.mine([payFee('list half',1,SPEND_FEE/4n)]);await reader.sync();
 const service=createService({reader,owners,testHooks:true}),port=await service.listen(0);
 try{const got=await (await fetch(`http://127.0.0.1:${port}/waiting`)).json(),id=reader.entryByTx(c.txid).id;
  assert.deepEqual(got.waiting,[{number:1,id,to:w.carol.address,kind:'spent coin',due:SPEND_FEE.toString(),paid:(SPEND_FEE/4n).toString(),missing:(SPEND_FEE-SPEND_FEE/4n).toString()}]);
 }finally{await service.close();}});
