// A relay that adds the Monero network fee to what it charges: the payer is asked the relay's price plus the fee of the
// transaction that will carry the record, worked out from its size and the node's rate. Made-up chain, nothing real.
//   node --test reader/tests/network-fee.test.mjs
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {startDemo} from './demo.mjs';
import {hex} from '../../rules/lib/monero.mjs';
import {frame} from '../lib/transport.mjs';

const MINT=500000000n,SET=2500000000n,SINGLE=2500000000n;
const demo=await startDemo({port:0,auto:0,mints:true,fees:{mint:MINT,collection:SET,single:SINGLE,network:'added'}}),root=`http://127.0.0.1:${demo.port}`;
after(()=>demo.close());
const get=async path=>(await fetch(root+path)).json();
const post=async(path,body)=>{const r=await fetch(root+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}),j=await r.json();if(!r.ok)throw Object.assign(Error(j.error||String(r.status)),{status:r.status});return j;};
const L=()=>demo.reader.ledger,W=demo.wallets,text=s=>new TextEncoder().encode(s);
const signed=(who,p)=>hex(L().sign(p.bodyBytes,who.sign(p.text)));
const pay=(to,amount)=>post('/test/payment',{pay:[{to,amount:String(amount)}]});
// The fee of a carrier for a record at a rate: 1499 bytes and the record in its frame, rounded up to the step.
const extra=record=>frame(new Uint8Array(record.length/2),new Uint8Array(32),{paymentId:new Uint8Array(8)}).length;
const network=(record,perByte=20000n,mask=10000n)=>{const f=BigInt(1499+extra(record))*perByte;return (f+mask-1n)/mask*mask;};

test('the service says the network fee is added, and between what amounts it lies',async()=>{
 const r=(await get('/info')).relay;assert.equal(r.networkFee,'added');assert.equal(r.network.perByte,'20000');
 assert.ok(BigInt(r.network.least)>=30000000n&&BigInt(r.network.most)<=60000000n&&BigInt(r.network.least)<BigInt(r.network.most),JSON.stringify(r.network));
 assert.deepEqual(r.fees,{collection:SET.toString(),mint:MINT.toString(),single:SINGLE.toString()});});

test('one NFT is asked its price and the network fee, told apart; the price alone does not send it',async()=>{
 const p=L().prepareMint({creator:W.alice.address,type:5,content:text('with the network fee')}),record=signed(W.alice,p),out=await post('/records',{record}),n=network(record);
 assert.equal(out.pay.price,SINGLE.toString());assert.equal(out.pay.network,n.toString());assert.equal(out.pay.amount,(SINGLE+n).toString());
 assert.ok(n>30000000n&&n<60000000n);
 await pay(out.pay.address,SINGLE);await demo.mine();await demo.mine();assert.equal((await get('/status/'+p.id)).state,'unpaid');
 await pay(out.pay.address,n);await demo.mine();await demo.mine();assert.equal((await get('/status/'+p.id)).state,'done');});

test('a larger record is asked more for the network; the node\'s rate of the moment counts',async()=>{
 const small=L().prepareMint({creator:W.bob.address,type:5,content:text('a')}),large=L().prepareMint({creator:W.bob.address,type:5,content:text('b'.repeat(600))});
 const a=await post('/records',{record:signed(W.bob,small)}),b=await post('/records',{record:signed(W.bob,large)});
 const ra=signed(W.bob,small),rb=signed(W.bob,large);assert.equal(a.pay.network,network(ra).toString());assert.equal(b.pay.network,network(rb).toString());assert.ok(BigInt(b.pay.network)>BigInt(a.pay.network));
 // A dearer network: after the relay's next pass a new record is asked at the new rate.
 demo.chain.rate={perByte:30001n,mask:10000n};await demo.step();
 const next=L().prepareMint({creator:W.bob.address,type:5,content:text('c')}),rn=signed(W.bob,next),c=await post('/records',{record:rn});
 assert.equal(c.pay.network,network(rn,30001n).toString());assert.equal(BigInt(c.pay.network)%10000n,0n);demo.chain.rate={perByte:20000n,mask:10000n};await demo.step();
 // The same record asked again keeps what it was told.
 assert.equal((await post('/records',{record:signed(W.bob,small)})).pay.amount,a.pay.amount);});

test('a collection and a mint into it are asked their own price and the network fee',async()=>{
 const set=L().prepareCollection({creator:W.carol.address,name:'Net Set',max:2}),sr=signed(W.carol,set),made=await post('/records',{record:sr});
 assert.equal(made.pay.amount,(SET+network(sr)).toString());await pay(made.pay.address,made.pay.amount);await demo.mine();await demo.mine();assert.equal(L().collection(set.id).name,'Net Set');
 const p=L().prepareMint({collection:set.id,edition:1,creator:W.carol.address,type:5,content:text('one')}),r=signed(W.carol,p),out=await post('/records',{record:r});
 assert.equal(out.pay.price,MINT.toString());assert.equal(out.pay.amount,(MINT+network(r)).toString());});

test('records the relay carries free stay free',async()=>{
 const first=L().prepareMint({creator:W.dave.address,type:5,content:text('to be moved')}),fr=signed(W.dave,first),out=await post('/records',{record:fr});
 await pay(out.pay.address,out.pay.amount);await demo.mine();await demo.mine();assert.equal((await get('/status/'+first.id)).state,'done');
 const q=L().prepareMove({mordinal:first.id,from:W.dave.address,to:W.erin.address}),moved=await post('/records',{record:signed(W.dave,q)});
 assert.notEqual(moved.state,'unpaid');assert.equal(moved.pay,undefined);});
