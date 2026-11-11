// The relay's fee on a local test chain. SIMULATED: own offline fakechain (monerod --regtest), a real wallet2 wallet
// (monero-wallet-rpc) that mints and pays, and the real carrier tool as the relay's wallet. Throwaway wallets, no real funds.
// Real here: the fee is an ordinary wallet2 payment to a subaddress of the relay's wallet, found by the carrier tool in
// a real block; the mint record then travels in a real transaction; and the fee coin itself later pays for a record.
//   node --test reader/tests/lab-fee.test.mjs        (about a minute)
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {hex} from '../../rules/lib/monero.mjs';
import {call,startChain,startWallet,stopAll,sleep} from '../../rules/tests/lab-harness.mjs';
import {startService} from '../service.mjs';
const HERE=import.meta.dirname,CARRIER=join(HERE,'..','bin','mordinals-carrier'),DOMAIN='4f'.repeat(32),XMR=10n**12n,FEE=10n**10n;   // the test chain's network fee is far above a real one, so the relay fee here is too

test('a mint is carried once its fee reached the relay wallet, and the fee coin pays for a later record',{timeout:900000},async()=>{
 const dir=await mkdtemp(join(HERE,'..','runs-lab-fee-'));let chain,W={},service=null;
 try{
  chain=await startChain(dir);for(const n of ['alice','fee'])W[n]=await startWallet(dir,chain.port,n);
  const {alice,fee}=W;
  const mine=async(n=1)=>{await call(chain.port,'generateblocks',{amount_of_blocks:n,wallet_address:fee.address});};
  const tip=async()=>(await call(chain.port,'get_info')).height-1;
  // Enough blocks and a few ordinary payments, so the relay's wallet finds decoys for its transactions.
  await call(chain.port,'generateblocks',{amount_of_blocks:120,wallet_address:alice.address});await mine(230);await alice.rpc('refresh');
  const pay=async destinations=>{for(let i=0;;i++){try{const t=await alice.rpc('transfer',{destinations:destinations.map(d=>({address:d.address,amount:Number(d.amount)})),priority:0});await mine(1);await alice.rpc('refresh');return t.tx_hash;}
   catch(e){if(i>=5)throw e;await mine(1);await alice.rpc('refresh');}}};
  for(let i=0;i<4;i++)await pay([{address:alice.address,amount:10n**9n}]);
  await writeFile(join(dir,'owners.jsonl'),'');
  const start=await tip();
  service=await startService({owners:join(dir,'owners.jsonl'),domain:DOMAIN,feeAddress:fee.address,node:chain.url,start,mintFrom:start+1,state:join(dir,'state'),port:0,checkpointEvery:5,carrierBin:CARRIER,carrierState:join(dir,'carrier'),
   carrierNetwork:'offline-fakechain',carrierStart:1,fees:{mint:FEE,collection:FEE},limits:{resendMs:0,settleBlocks:6,minReady:1,splitInto:4,margin:2},testHooks:true,log:()=>{}});
  const base='http://127.0.0.1:'+service.port,L=()=>service.reader.ledger,carrier=service.relay.carrier;
  const post=async(path,body={})=>{const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
  const pass=async()=>{const r=await post('/test/step');assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
  const status=async id=>(await (await fetch(base+'/status/'+id)).json());
  const mint=async words=>{const p=L().prepareMint({creator:alice.address,type:5,content:new TextEncoder().encode(words)});return {id:p.id,record:hex(L().sign(p.bodyBytes,await alice.sign(p.text)))};};
  // The relay's wallet gets two coins to work with.
  const relayAddress=(await carrier.init()).address;await pay([{address:relayAddress,amount:XMR/5n},{address:relayAddress,amount:XMR/5n}]);await mine(10);await pass();
  const before=await carrier.status();assert.equal(before.ready,2);assert.deepEqual(before.payments,[]);

  const m=await mint('paid on a real chain'),sent=await post('/records',{record:m.record});
  assert.equal(sent.status,200,JSON.stringify(sent.body));assert.equal(sent.body.state,'unpaid');assert.equal(sent.body.pay.amount,FEE.toString());
  const where=sent.body.pay.address;assert.notEqual(where,relayAddress);
  assert.equal((await alice.rpc('validate_address',{address:where})).subaddress,true,'the fee address is a subaddress');
  await mine(2);await pass();assert.equal((await status(m.id)).state,'unpaid');assert.equal(L().nft(m.id),null);
  const feeTx=await pay([{address:where,amount:FEE}]);await pass();
  const paid=await carrier.status();assert.deepEqual(paid.payments.map(p=>[p.index,p.amount,p.txid]),[[1,FEE.toString(),feeTx]]);
  {const s=await status(m.id);assert.match(s.state,/sent|done/,JSON.stringify(s));}await mine(1);await pass();
  assert.equal((await status(m.id)).state,'done');assert.equal(L().nft(m.id).owner,alice.address);

  // After ten blocks the first fee coin is the smallest coin the wallet can spend, so the next record rides on it.
  await mine(10);await pass();const ready=await carrier.status();assert.ok(ready.ready>=2,JSON.stringify(ready));
  const second=await mint('rides on the fee coin'),two=await post('/records',{record:second.record});
  const fee2=await pay([{address:two.body.pay.address,amount:FEE}]);await pass();
  assert.match((await status(second.id)).state,/sent|done/,JSON.stringify([await status(second.id),await carrier.status()]));
  const job=service.relay.jobs().find(j=>j.id===second.id),carried=(await service.chain.txs([job.txid])).get(job.txid);
  await mine(1);await pass();assert.equal((await status(second.id)).state,'done');
  const after=await carrier.status();
  // Everything the wallet received, less the two network fees it paid, is still there: the fee coin was a valid input.
  assert.equal(BigInt(after.balance),2n*XMR/5n+2n*FEE-BigInt(service.relay.jobs().filter(j=>j.fee).reduce((a,j)=>a+BigInt(j.fee),0n)));
  assert.equal(after.payments.length,2);assert.ok(carried,'the second carrier was accepted by the node');
  const fees=service.relay.jobs().filter(j=>j.fee).map(j=>j.fee);
  console.error(JSON.stringify({step:'relay fee',feeAtomic:FEE.toString(),networkFeePerRecordAtomic:fees,feeTransactions:[feeTx,fee2]}));
 }finally{
  if(service)await service.close().catch(()=>{});await stopAll([chain,...Object.values(W)]);await sleep(300);await rm(dir,{recursive:true,force:true});}
});
