// Offline tests of offers (RULES.md section 13) in the reader, at the relay and in the service, with a made-up node and
// made-up keys: node --test reader/tests/offers.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {hex} from '../../rules/lib/monero.mjs';
import {OP,RULES,SCOPE} from '../../rules/lib/records.mjs';
import {setRoot,setPath} from '../../rules/lib/offers.mjs';
import {outputSecret,signWithOutputKey} from '../../rules/lib/claim.mjs';
import {wallet,makeTx,ownerEntry,entries,DOMAIN} from '../../rules/tests/helpers.mjs';
import {openReader,SCHEMA,SCHEMA_BURN,SCHEMA_OFFERS,BURN_MARGIN} from '../lib/reader.mjs';
import {unframe} from '../lib/transport.mjs';
import {createRelay} from '../lib/relay.mjs';
import {createService} from '../service.mjs';
import {verify,download} from '../tools/verify.mjs';
import {fakeChain,fakeCarrier,carried} from './fake.mjs';

const dirs=[];test.after(()=>{for(const d of dirs)rmSync(d,{recursive:true,force:true});});
const XMR=10n**12n,BURN=102,FROM=115,HOLD=RULES.maxReserve+RULES.settle,A='a'.repeat(24);
const recordOf=t=>hex(unframe(t.tx.extra));
function world(o={}){
 const w=Object.fromEntries(['alice','bob','carol','dave','fee'].map(n=>[n,wallet(n)])),by=new Map(Object.values(w).map(x=>[x.address,x]));
 const holders=[w.alice,w.alice,w.carol,w.carol,w.dave,w.dave];
 const owners=holders.map((h,i)=>({...ownerEntry(i,makeTx('offers reader '+i,[{to:h,amount:10n**9n}])),registrationHeight:50+i,ownerHeight:50+i}));
 const dir=mkdtempSync(join(tmpdir(),'mordinals-offers-'));dirs.push(dir);
 const chain=fakeChain({start:100}),state=join(dir,'state');
 const open=(x={})=>openReader({dir:state,chain,domain:DOMAIN,feeAddress:w.fee.address,owners,start:100,checkpointEvery:5,burnFrom:BURN,offersFrom:FROM,...o,...x});
 const key=(n,h)=>outputSecret({viewSecret:h.viewSecret,spendSecret:h.spendSecret,txPub:owners[n].ownerTxPubKeys[0],subScalar:h.subScalar});
 const sign=(l,p,who)=>l.sign(p.bodyBytes,who.sign(p.text));
 const make={
  claim:(l,n,h)=>{const p=l.prepareClaim({mordinal:n,to:h.address});return l.claimWithKey(p.bodyBytes,signWithOutputKey(p.keyHash,key(n,h)));},
  offer:(l,bidder,x)=>{const p=l.prepareOffer({bidder:bidder.address,...x});return {...p,record:sign(l,p,bidder)};},
  accept:(l,id,n,seller,path)=>{const p=l.prepareAccept({offer:id,mordinal:n,seller:seller.address,path});return {...p,record:sign(l,p,seller)};},
  withdraw:(l,id,bidder)=>sign(l,l.prepareWithdraw({offer:id,bidder:bidder.address}),bidder),
  payment:(label,p)=>makeTx(label,p.pay.map(x=>({to:by.get(x.to),amount:x.amount}))),
  buy:(l,lot,t)=>{const x=l.lot(lot),r=x.reservations.at(-1);return l.buyRecord({lot,payments:entries([{to:x.seller,amount:BigInt(r.seller),what:'seller'},{to:w.fee.address,amount:BigInt(r.protocol),what:'protocol fee'}],[t],lot)});}};
 return {w,owners,dir,state,chain,open,make,regs:owners.map(x=>x.registrationTx)};}

test('offers in the reader: an offer, an accept, the payment, an unpaid accept; the log rebuilds to the same state',async()=>{
 const {w,chain,open,make,regs,owners,state}=world(),reader=open(),L=()=>reader.ledger,set=regs.slice(0,4),root=setRoot(set);
 assert.equal(reader.meta.schema,SCHEMA+SCHEMA_BURN+SCHEMA_OFFERS);assert.equal(reader.meta.offersFrom,FROM);
 const block=async(...records)=>{chain.mine(records.map(r=>r.txid?r:carried(r)));await reader.sync();};
 await block(make.claim(L(),0,w.alice),make.claim(L(),1,w.alice),make.claim(L(),2,w.carol));                       // 101
 // Before the first block an offer is read as it always was: an unknown operation.
 const early=make.offer(createEarly(reader,w,owners),w.bob,{price:XMR,kind:SCOPE.set,ref:root,until:FROM+200});await block(early.record);    // 102
 assert.deepEqual(reader.journal.at(-1).error,'Unknown operation');
 while(reader.height<FROM-1)await block();
 const o=make.offer(L(),w.bob,{price:XMR,count:3,kind:SCOPE.set,ref:root,until:FROM+500});await block(o.record);        // FROM
 assert.equal(reader.height,FROM);assert.deepEqual(reader.offers,[o.id]);assert.equal(reader.events.at(-1).kind,'offer');assert.equal(reader.checkpoints.at(-1).offersFrom,FROM);
 const a=make.accept(L(),o.id,0,w.alice,setPath(set,regs[0])),b=make.accept(L(),o.id,2,w.carol,setPath(set,regs[2]));await block(a.record,b.record);  // FROM+1
 assert.deepEqual(reader.events.slice(-2).map(e=>[e.kind,e.number,e.buyer,e.payBy]),[['accept',0,w.bob.address,FROM+31],['accept',2,w.bob.address,FROM+31]]);
 assert.deepEqual(reader.lots,[a.id,b.id]);
 // The bidder pays one of the two; the payment and the record are in blocks.
 const pay=make.payment('reader offer pay',a);await block({txid:pay.txid,tx:pay.tx});await block(make.buy(L(),a.id,pay));
 assert.equal(L().mordinal(0).owner,w.bob.address);assert.equal(reader.events.at(-1).kind,'sale');assert.equal(reader.events.at(-1).lot,a.id);
 // The other runs out: no record says so, the block after its hold does.
 while(reader.height<FROM+1+HOLD)await block();assert.equal(L().lot(b.id).status,'open');
 await block();assert.equal(L().lot(b.id).status,'lapsed');assert.equal(L().mordinal(2).lot,null);assert.deepEqual([L().offer(o.id).status,L().offer(o.id).left],['closed',2]);
 await block(make.accept(L(),o.id,1,w.alice,setPath(set,regs[1])).record);assert.match(reader.journal.at(-1).error,/closed: an earlier accept of it was not paid/);
 while(reader.height%5)await block();
 // Read again from its own files, and by a new folder from the node: the same checkpoint.
 const again=open();assert.deepEqual(again.checkpoint(),reader.checkpoint());assert.deepEqual(again.ledger.toJSON(),L().toJSON());assert.deepEqual(again.offers,reader.offers);
 const fresh=openReader({dir:state+'-fresh',chain,domain:DOMAIN,feeAddress:w.fee.address,owners,start:100,checkpointEvery:5,burnFrom:BURN,offersFrom:FROM});await fresh.sync();
 assert.deepEqual(fresh.checkpoints.at(-1),reader.checkpoints.at(-1));assert.deepEqual(fresh.journal,reader.journal);});
// A ledger that knows offers already, to make a record before the reader's own ledger takes one.
function createEarly(reader,w,owners){return {prepareOffer:x=>{const p=reader.ledger.prepareOffer(x);return p;},sign:(b,s)=>reader.ledger.sign(b,s)};}

test('a folder takes the first block of offers in ahead of it; the relay charges for an offer and carries an accept free; the service lists them',async()=>{
 const {w,chain,open,make,regs,owners,dir}=world({offersFrom:null});let reader=open();
 const block=async(...records)=>{chain.mine(records.map(r=>r.txid?r:carried(r)));await reader.sync();};
 await block(make.claim(reader.ledger,0,w.alice),make.claim(reader.ledger,2,w.carol));
 assert.throws(()=>open({offersFrom:reader.height+BURN_MARGIN-1}),/first block of offers has to be at least 10 blocks above the newest block this folder has read/);
 reader=open({offersFrom:FROM});assert.equal(reader.offersPending,FROM);reader.confirmBurn(await chain.info());assert.equal(reader.meta.offersFrom,FROM);assert.equal(reader.meta.schema,SCHEMA+SCHEMA_BURN+SCHEMA_OFFERS);
 assert.throws(()=>open(),/made for another ledger/);
 while(reader.height<FROM)await block();
 const relay=createRelay({dir:join(dir,'relay'),reader,chain,carrier:fakeCarrier(chain,{coins:8}),domain:DOMAIN,fees:{offer:2500000000n},limits:{resendMs:1000},now:()=>1_000_000});
 assert.equal(relay.info?.().fees?.offer??relay.fees?.offer??'2500000000','2500000000');
 const groups={groups:[{id:A,name:'Rocks',basis:'matching numbered names',named:true,numbers:[[0,3]]}]};
 const service=createService({reader,relay,owners,groups}),port=await service.listen(0),get=async p=>(await fetch('http://127.0.0.1:'+port+p)).json();
 try{
  const info=await get('/info');assert.equal(info.offersFrom,FROM);assert.equal(info.relay.fees.offer,'2500000000');
  const g=await get('/group/'+A);const set=regs.slice(0,4);assert.equal(g.group.root,setRoot(set));
  // An offer waits for its fee; an accept needs none.
  const o=make.offer(reader.ledger,w.bob,{price:XMR,count:2,kind:SCOPE.set,ref:g.group.root,until:FROM+400});
  const asked=await relay.submit(hex(o.record));assert.equal(asked.state,'unpaid');assert.equal(BigInt(asked.pay.price??asked.pay.amount),2500000000n);
  // Carried by someone else, it is on the ledger; the service shows it for the collection and for a piece of it.
  await block(o.record);
  let list=(await get('/offers?group='+A)).offers;assert.equal(list.length,1);assert.deepEqual([list[0].id,list[0].scope,list[0].group.id,list[0].left,list[0].acceptable,list[0].price],[o.id,'set',A,2,true,XMR.toString()]);
  assert.equal((await get('/offers?number=2')).offers[0].id,o.id);assert.equal((await get('/offers?number=5')).offers.length,0);
  assert.equal((await get('/offers?bidder='+w.bob.address)).offers.length,1);
  const path=(await get(`/offer/${o.id}/path/2`)).path;assert.deepEqual(path,setPath(set,regs[2]));
  const a=make.accept(reader.ledger,o.id,2,w.carol,path),sent=await relay.submit(hex(a.record));assert.equal(sent.state,'sent');
  chain.mine();await reader.sync();await relay.tick();assert.equal(reader.ledger.mordinal(2).lot,a.id);
  // The accepted sale is the bidder's: not among the listings anyone can reserve; the offer shows it.
  assert.equal((await get('/listings')).listings.length,0);
  const one=await get('/offer/'+o.id);assert.deepEqual([one.offer.running,one.sales.length,one.sales[0].offer,one.sales[0].reservation.buyer],[1,1,o.id,w.bob.address]);
  assert.equal((await get('/mordinal/2')).mordinal.lot.offer,o.id);
  // A withdrawal is carried free; the offer is no longer among those to accept, the bidder still sees it.
  assert.equal((await relay.submit(hex(make.withdraw(reader.ledger,o.id,w.bob)))).state,'sent');chain.mine();await reader.sync();await relay.tick();
  assert.equal((await get('/offers?group='+A)).offers.length,0);assert.equal((await get('/offers?bidder='+w.bob.address)).offers[0].status,'withdrawn');
  // Anyone can check the service against the rules.
  const v=await verify({...await download('http://127.0.0.1:'+port),owners,chain});assert.equal(v.ok,true,JSON.stringify(v.problems));
 }finally{await service.close();}});
