// Fixes from the review before launch: a mining reward named as a payment, purchases ahead of the shared relay limits,
// fee payments counted per output, the fixed order of tx_extra, and the longest listing.
//   node --test reader/tests/review.test.mjs
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {startDemo} from './demo.mjs';
import {unframe,frame} from '../lib/transport.mjs';
import {hex,unhex} from '../../rules/lib/monero.mjs';
import {OP,RULES,encodeBody,renderText} from '../../rules/lib/records.mjs';
import {randomBytes} from 'node:crypto';

const XMR=10n**12n,FEE=500000000n;
const demo=await startDemo({port:0,auto:0,mints:true,fees:{mint:FEE,collection:FEE}}),root=`http://127.0.0.1:${demo.port}`;
after(()=>demo.close());
const get=async path=>(await fetch(root+path)).json();
const post=async(path,body)=>{const r=await fetch(root+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}),j=await r.json();if(!r.ok)throw Object.assign(Error(j.error||String(r.status)),{status:r.status});return j;};
const L=()=>demo.reader.ledger,W=demo.wallets;

test('a buy record that names a mining reward transaction is refused, and the reader goes on',async()=>{
 const lot=L().prepareList({mordinal:12,seller:W.carol.address,price:XMR});await post('/records',{record:hex(L().sign(lot.bodyBytes,W.carol.sign(lot.text)))});await demo.mine();
 const res=L().prepareReserve({lot:lot.id,buyer:W.dave.address});await post('/records',{record:hex(L().sign(res.bodyBytes,W.dave.sign(res.text)))});await demo.mine();
 const minerTx=(await demo.chain.block(demo.chain.tip)).minerTx;assert.match(minerTx,/^[0-9a-f]{64}$/);
 // Proof values do not matter: the reader looks the payment up before any rule reads them.
 const fakeProof=(p,i)=>({txid:minerTx,out:i,D:'11'.repeat(32),c:'22'.repeat(32),s:'33'.repeat(32)});
 let record;try{record=L().buyRecord({lot:lot.id,payments:res.pay.map(fakeProof)});}catch{record=null;}
 if(record){const {frame:f}=await import('../lib/transport.mjs');demo.chain.mine([{txid:'aa'.repeat(32),tx:{version:2,extra:[...f(record,randomBytes(32))],vout:[]}}]);}
 else demo.chain.mine();
 const before=demo.chain.tip;await demo.step();demo.chain.mine();await demo.step();
 assert.equal(demo.reader.height,before+1,'the reader passed the block with the bad purchase');
 assert.equal(L().lot(lot.id).status,'open','nothing was bought');
 assert.ok(record,'the buy record was made');const e=demo.reader.entryByTx('aa'.repeat(32));assert.ok(e&&e.ok===false,'the reader judged the record and refused it');});

test('purchases are not held back by the shared limits, and coins are kept for them',async()=>{
 const r=demo.relay;r.limits.perDay=0;r.limits.waiting=0;
 try{
 const other=L().prepareMove({mordinal:2,from:W.bob.address,to:W.carol.address});
 await assert.rejects(post('/records',{record:hex(L().sign(other.bodyBytes,W.bob.sign(other.text)))}),e=>e.status===503);
 // A full purchase still goes through.
 const lot=L().prepareList({mordinal:14,seller:W.dave.address,price:XMR});r.limits.perDay=2000;r.limits.waiting=200;
 await post('/records',{record:hex(L().sign(lot.bodyBytes,W.dave.sign(lot.text)))});await demo.mine();
 const res=L().prepareReserve({lot:lot.id,buyer:W.erin.address});await post('/records',{record:hex(L().sign(res.bodyBytes,W.erin.sign(res.text)))});await demo.mine();
 const t=demo.payment(res.pay);demo.chain.mine([{txid:t.txid,tx:t.tx}]);await demo.step();
 const {provePayments}=await import('../../rules/lib/payment.mjs');
 const buy=L().buyRecord({lot:lot.id,payments:provePayments({lines:res.pay,payments:[{txid:t.txid,tx:t.tx,txKey:t.keys.join('')}],domain:demo.reader.meta.domain,lot:lot.id,network:'mainnet'})});
 r.limits.perDay=0;r.limits.waiting=0;demo.carrier.ready=2;await demo.step();
 const sent=await post('/records',{record:hex(buy)});assert.notEqual(sent.state,'refused');assert.ok(sent.txid,'the purchase went out on a kept coin');
 // With only the kept coins left, a move waits.
 r.limits.perDay=2000;r.limits.waiting=200;demo.carrier.ready=2;await demo.step();
 const m=L().prepareMove({mordinal:2,from:W.bob.address,to:W.carol.address}),waiting=await post('/records',{record:hex(L().sign(m.bodyBytes,W.bob.sign(m.text)))});
 assert.equal(waiting.state,'queued');assert.match(waiting.note,/purchases go first/);
 demo.carrier.ready=40;await demo.mine();await demo.mine();assert.equal(L().lot(lot.id).status,'sold');
 }finally{r.limits.perDay=2000;r.limits.waiting=200;demo.carrier.ready=40;}});

test('one transaction that pays two fee addresses pays for both records',async()=>{
 const mint=w=>{const p=L().prepareMint({creator:w.address,type:5,content:new TextEncoder().encode('two in one '+w.address.slice(0,6))});return {id:p.id,record:hex(L().sign(p.bodyBytes,w.sign(p.text)))};};
 const a=mint(W.alice),b=mint(W.bob),ra=await post('/records',{record:a.record}),rb=await post('/records',{record:b.record});
 await post('/test/payment',{pay:[{to:ra.pay.address,amount:String(FEE)},{to:rb.pay.address,amount:String(FEE)}]});
 await demo.mine();await demo.mine();await demo.mine();
 assert.equal((await get('/status/'+a.id)).state,'done');assert.equal((await get('/status/'+b.id)).state,'done');});

test('tx_extra fields must come in their fixed order',()=>{
 const record=unhex('4d4431fe'+'02'+'00'.repeat(60)),pub=randomBytes(32),good=frame(record,pub);assert.ok(unframe(good));
 const chunk=good.subarray(33);
 assert.equal(unframe(Uint8Array.from([...chunk,1,...pub])),null,'chunks before the public key');
 assert.equal(unframe(Uint8Array.from([1,...pub,...chunk,2,9,1,1,2,3,4,5,6,7,8])),null,'a payment id after the chunks');
 assert.ok(unframe(frame(record,pub,{paymentId:new Uint8Array(8)})),'a payment id before the chunks');});

test('a listing ends at most 21,600 blocks after its block',()=>{
 const tip=demo.reader.height,m=L().mordinal(9),sign=until=>{const body={reg:m.reg,seq:m.seq,until,price:XMR,seller:W.erin.address},bytes=encodeBody(OP.list,body,'mainnet');
  return L().sign(bytes,W.erin.sign(renderText(OP.list,body,bytes,{domain:demo.reader.meta.domain,number:9})));};
 assert.throws(()=>L().check(sign(tip+RULES.maxListing+5)),/at most 21600 blocks/);
 assert.doesNotThrow(()=>L().check(sign(tip+RULES.maxListing-5)));
 assert.equal(RULES.maxListing,21600);});
