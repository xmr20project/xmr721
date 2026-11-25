// A relay with a price of its own for one NFT minted on its own: a mint that names no collection costs that price, a
// mint into a collection and a token's deploy text cost the mint fee. Made-up chain, nothing real.
//   node --test reader/tests/single-fee.test.mjs
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {startDemo} from './demo.mjs';
import {hex} from '../../rules/lib/monero.mjs';

const MINT=500000000n,SET=2500000000n,SINGLE=2500000001n;
const demo=await startDemo({port:0,auto:0,mints:true,fees:{mint:MINT,collection:SET,single:SINGLE}}),root=`http://127.0.0.1:${demo.port}`;
after(()=>demo.close());
const get=async path=>(await fetch(root+path)).json();
const post=async(path,body)=>{const r=await fetch(root+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}),j=await r.json();if(!r.ok)throw Object.assign(Error(j.error||String(r.status)),{status:r.status});return j;};
const L=()=>demo.reader.ledger,W=demo.wallets,text=s=>new TextEncoder().encode(s);
const send=(who,p)=>post('/records',{record:hex(L().sign(p.bodyBytes,who.sign(p.text)))});
const pay=(to,amount)=>post('/test/payment',{pay:[{to,amount:String(amount)}]});

test('the service says all three prices',async()=>{
 assert.deepEqual((await get('/info')).relay.fees,{collection:SET.toString(),mint:MINT.toString(),single:SINGLE.toString()});});

test('one NFT on its own costs the single price, and the mint fee alone does not send it',async()=>{
 const p=L().prepareMint({creator:W.alice.address,type:5,content:text('on its own')}),out=await send(W.alice,p);
 assert.equal(out.state,'unpaid');assert.equal(out.pay.amount,SINGLE.toString());
 await pay(out.pay.address,MINT);await demo.mine();await demo.mine();assert.equal((await get('/status/'+p.id)).state,'unpaid');
 await pay(out.pay.address,SINGLE-MINT);await demo.mine();await demo.mine();assert.equal((await get('/status/'+p.id)).state,'done');});

test('a collection costs the collection fee, each mint into it the mint fee',async()=>{
 const set=L().prepareCollection({creator:W.bob.address,name:'Priced Set',max:3}),made=await send(W.bob,set);
 assert.equal(made.pay.amount,SET.toString());await pay(made.pay.address,SET);await demo.mine();await demo.mine();assert.equal(L().collection(set.id).name,'Priced Set');
 const p=L().prepareMint({collection:set.id,edition:1,creator:W.bob.address,type:5,content:text('one of three')}),out=await send(W.bob,p);
 assert.equal(out.state,'unpaid');assert.equal(out.pay.amount,MINT.toString());
 await pay(out.pay.address,MINT);await demo.mine();await demo.mine();assert.equal((await get('/status/'+p.id)).state,'done');});

test('a JSON text with no collection, as a token deploy is, keeps the mint fee',async()=>{
 const p=L().prepareMint({creator:W.carol.address,type:6,content:text('{"p":"test"}')}),out=await send(W.carol,p);
 assert.equal(out.state,'unpaid');assert.equal(out.pay.amount,MINT.toString());});
