// The relay's fee for mint and collection records: a record waits unsent until its fee is in a block at the
// subaddress it was given, late or short payments, and records that stay free. Made-up chain, nothing real.
//   node --test reader/tests/fee.test.mjs
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {startDemo} from './demo.mjs';
import {hex} from '../../rules/lib/monero.mjs';

const FEE=500000000n,demo=await startDemo({port:0,auto:0,mints:true,fees:{mint:FEE,collection:FEE}}),root=`http://127.0.0.1:${demo.port}`;
after(()=>demo.close());
const get=async path=>(await fetch(root+path)).json();
const post=async(path,body)=>{const r=await fetch(root+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}),j=await r.json();if(!r.ok)throw Object.assign(Error(j.error||String(r.status)),{status:r.status});return j;};
const L=()=>demo.reader.ledger,W=demo.wallets,text=s=>new TextEncoder().encode(s);
const mint=(who,words,extra={})=>{const p=L().prepareMint({creator:who.address,type:5,content:text(words),...extra});return {id:p.id,record:hex(L().sign(p.bodyBytes,who.sign(p.text)))};};
let first;
const pay=(to,amount)=>post('/test/payment',{pay:[{to,amount:String(amount)}]});

test('the service says what the relay charges',async()=>{
 const info=await get('/info');assert.deepEqual(info.relay.fees,{collection:FEE.toString(),mint:FEE.toString()});assert.equal(info.relay.payBlocks,30);});

test('a mint waits unsent until its fee is in a block, then goes out and counts',async()=>{
 const m=mint(W.alice,'paid for'),out=await post('/records',{record:m.record});first=m.id;
 assert.equal(out.state,'unpaid');assert.equal(out.pay.amount,FEE.toString());assert.match(out.pay.address,/^8/);assert.equal(out.txid,null);
 await demo.mine();await demo.mine();
 assert.equal((await get('/status/'+m.id)).state,'unpaid');assert.equal(L().nft(m.id),null,'nothing was sent without the fee');
 // The same record again gives the same address.
 assert.equal((await post('/records',{record:m.record})).pay.address,out.pay.address);
 await pay(out.pay.address,FEE);await demo.step();
 assert.equal((await get('/status/'+m.id)).state,'unpaid','a payment in the pool is not enough');
 await demo.mine();assert.match((await get('/status/'+m.id)).state,/sent|done/);
 await demo.mine();assert.equal((await get('/status/'+m.id)).state,'done');assert.equal(L().nft(m.id).owner,W.alice.address);});

test('too little is not enough; a second payment makes up the rest',async()=>{
 const m=mint(W.bob,'in two parts'),out=await post('/records',{record:m.record});
 await pay(out.pay.address,FEE-1n);await demo.mine();await demo.mine();assert.equal((await get('/status/'+m.id)).state,'unpaid');
 await pay(out.pay.address,1n);await demo.mine();await demo.mine();assert.equal((await get('/status/'+m.id)).state,'done');});

test('each record has its own address, and one payment pays for one record',async()=>{
 const a=mint(W.carol,'first'),b=mint(W.carol,'second'),ra=await post('/records',{record:a.record}),rb=await post('/records',{record:b.record});
 assert.notEqual(ra.pay.address,rb.pay.address);
 await pay(ra.pay.address,FEE*3n);await demo.mine();await demo.mine();
 assert.equal((await get('/status/'+a.id)).state,'done');assert.equal((await get('/status/'+b.id)).state,'unpaid');});

test('an unpaid record is dropped after its time; the late payment counts when the record is sent again',async()=>{
 const m=mint(W.dave,'late'),out=await post('/records',{record:m.record});
 for(let i=0;i<31;i++)await demo.mine();
 const gone=await get('/status/'+m.id);assert.equal(gone.state,'refused');assert.match(gone.error,/not paid in time/);assert.equal(L().nft(m.id),null);
 await pay(out.pay.address,FEE);await demo.mine();
 const again=await post('/records',{record:m.record});assert.equal(again.state,'unpaid');assert.equal(again.pay.address,out.pay.address);
 await demo.mine();await demo.mine();assert.equal((await get('/status/'+m.id)).state,'done');});

test('a collection is charged too; claims, moves and sales stay free',async()=>{
 const p=L().prepareCollection({creator:W.erin.address,name:'Paid Set',max:3}),out=await post('/records',{record:hex(L().sign(p.bodyBytes,W.erin.sign(p.text)))});
 assert.equal(out.state,'unpaid');await pay(out.pay.address,FEE);await demo.mine();await demo.mine();assert.equal(L().collection(p.id).name,'Paid Set');
 const q=L().prepareMove({mordinal:first,from:W.alice.address,to:W.bob.address});
 const moved=await post('/records',{record:hex(L().sign(q.bodyBytes,W.alice.sign(q.text)))});assert.notEqual(moved.state,'unpaid');assert.equal(moved.pay,undefined);});

test('unpaid records do not use up the relay: the limit per address still holds',async()=>{
 const who=W.other;for(let i=0;i<3;i++)assert.equal((await post('/records',{record:mint(who,'spam '+i).record})).state,'unpaid');
 await assert.rejects(post('/records',{record:mint(who,'spam 3').record}),e=>e.status===429);
 assert.equal(demo.carrier.made.length,6,'only paid records and the free move were built');});
