// The reader, relay and service on a local test chain. SIMULATED: own offline fakechain (monerod --regtest), real wallet2 wallets
// (monero-wallet-rpc) for the holders, and the real carrier tool for the relay's transactions. Throwaway wallets, no real funds.
// Real here: every record travels in a real Monero transaction built by the carrier tool and is read back out of real blocks;
// wallet signatures, claim proofs, payments and transaction keys are wallet2's (the proofs in a buy record are made
// here from wallet2's transaction keys); chain reorganisations are the node's own.
// Not real here: the test Mordinals are ordinary transactions put on an owner list by hand (no 0x10 inscription).
//   node --test tests/lab.test.mjs        (a few minutes; writes lab-results.json)
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {OP,decodeRecord} from '../../rules/lib/records.mjs';
import {outputSecret,signWithOutputKey,findMine} from '../../rules/lib/claim.mjs';
import {hex,unhex,decodeAddress,subaddressSecret} from '../../rules/lib/monero.mjs';
import {call,startChain,startWallet,txPubKeys,stopAll,sleep} from '../../rules/tests/lab-harness.mjs';
import {createLedger} from '../../rules/lib/ledger.mjs';
import {fetchTx,provePayments,makeOutProof,paymentMessage} from '../../rules/lib/payment.mjs';
import {startService} from '../service.mjs';
import {unframe} from '../lib/transport.mjs';
import {verify,scan,download} from '../tools/verify.mjs';
const HERE=import.meta.dirname,CARRIER=join(HERE,'..','bin','mordinals-carrier');
const DOMAIN='4d'.repeat(32),XMR=10n**12n,sha=b=>createHash('sha256').update(b).digest('hex');
const PNG=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),Buffer.from('test picture bytes')]),TEXT=Buffer.from('plain text body');
const evidence={execution:'SIMULATED (own offline fakechain; real carrier transactions, real wallet2 signatures, proofs and payments; throwaway wallets)',date:new Date().toISOString(),steps:[]};
const note=(name,x={})=>{evidence.steps.push({name,...x});console.error(JSON.stringify({step:name,...x}).slice(0,400));};

test('records go through the relay into real blocks and the reader follows them',{timeout:1800000},async()=>{
 const dir=await mkdtemp(join(HERE,'..','runs-lab-'));let chain,W={},service=null,failed=true;
 try{
  chain=await startChain(dir);for(const n of ['alice','bob','carol','fee'])W[n]=await startWallet(dir,chain.port,n);
  const {alice,bob,carol,fee}=W,all=Object.values(W);
  const mine=async(n=1)=>{await call(chain.port,'generateblocks',{amount_of_blocks:n,wallet_address:fee.address});};
  const mineTo=async(n,w)=>{await call(chain.port,'generateblocks',{amount_of_blocks:n,wallet_address:w.address});};
  const tip=async()=>(await call(chain.port,'get_info')).height-1;
  const refresh=async()=>{for(const w of all)await w.rpc('refresh');};
  for(const w of [alice,bob,carol])await mineTo(80,w);await mine(70);await refresh();
  const transfer=async(from,destinations)=>{for(let i=0;;i++){try{const t=await from.rpc('transfer',{destinations:destinations.map(d=>({address:d.address||d.to,amount:Number(d.amount)})),get_tx_key:true,priority:0});
    return {txid:t.tx_hash,keys:t.tx_key.match(/.{64}/g)};}catch(e){if(i>=5)throw e;await mine(1);await refresh();}}};
  const pay=async(from,destinations)=>{const t=await transfer(from,destinations);await mine(1);await refresh();return t;};

  // 1. Test Mordinals: ordinary transactions whose output 0 plays the owner coin (each wallet pays itself, so it holds every output).
  const holders=[alice,bob,carol,alice],owners=[];
  for(const [i,h] of holders.entries()){const t=await pay(h,[{address:h.address,amount:10n**9n}]),x=await fetchTx(chain.url,t.txid),keys=txPubKeys(x.tx),o=x.tx.vout[0].target.tagged_key;
   assert.equal(keys.main.length,1);assert.equal(keys.additional.length,0);
   owners.push({number:i,registrationTx:t.txid,registrationHeight:x.height,ownerTx:t.txid,ownerHeight:x.height,ownerOutputKey:o.key,ownerViewTag:o.view_tag,ownerTxPubKeys:keys.main,ownerAdditionalPubKeys:[],
    ...(i===0?{bodySha256:sha(PNG),bodySize:PNG.length}:i===1?{bodySha256:sha(TEXT),bodySize:TEXT.length}:{})});}
  await writeFile(join(dir,'owners.jsonl'),owners.map(o=>JSON.stringify(o)+'\n').join(''));
  await mkdir(join(dir,'content'));await writeFile(join(dir,'content',sha(PNG)),PNG);await writeFile(join(dir,'content',sha(TEXT)),TEXT);

  // 2. The service with its relay. The relay's wallet starts empty and is paid like any wallet.
  const start=await tip(),logs=[];
  const options={owners:join(dir,'owners.jsonl'),domain:DOMAIN,feeAddress:fee.address,node:chain.url,start,state:join(dir,'state'),port:0,checkpointEvery:5,carrierBin:CARRIER,carrierState:join(dir,'carrier'),
   carrierNetwork:'offline-fakechain',carrierStart:1,limits:{resendMs:0,settleBlocks:6,minReady:3,splitInto:6,margin:2},contentDir:join(dir,'content'),testHooks:true,log:v=>logs.push(v)};
  service=await startService(options);let base='http://127.0.0.1:'+service.port;
  const get=async path=>{const r=await fetch(base+path);return {status:r.status,headers:r.headers,body:r.headers.get('content-type')?.startsWith('application/json')?await r.json():Buffer.from(await r.arrayBuffer())};};
  const post=async(path,body={})=>{const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
  const send=async record=>{const r=await post('/records',{record:hex(record)});assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
  const pass=async()=>{const r=await post('/test/step');assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
  const next=async(n=1)=>{await mine(n);return pass();};
  const status=async id=>(await get('/status/'+id)).body;
  const carrier=service.relay.carrier,relayAddress=(await carrier.init()).address;
  assert.equal((await post('/records',{record:'00'})).status,400);
  // No coin yet: a record waits in line.
  const L=()=>service.reader.ledger;
  const c0=L().prepareClaim({mordinal:0,to:alice.address,holder:alice.address});
  const claim0=L().claimWithProof(c0.bodyBytes,await alice.proof(owners[0].ownerTx),await alice.sign(c0.text));
  const queued=await send(claim0);assert.equal(queued.state,'queued');assert.match(queued.note,/coin|balance|funds/i);
  note('relay without coins',{state:queued.state,note:queued.note});
  // Fund it with one ordinary transaction of several coins, as an operator would.
  await pay(alice,Array.from({length:3},()=>({address:relayAddress,amount:XMR/5n})));await mine(10);await refresh();
  const funded=await carrier.status();assert.equal(funded.ready,3);assert.equal(funded.balance,String(3n*XMR/5n));
  let s=await pass();assert.equal((await status(queued.id)).state,'sent');
  // Two coins left after the first record... the relay splits one into more while it still has some.
  assert.ok(logs.some(l=>l.split),"the relay made a split transaction: "+JSON.stringify([s,logs.slice(-6)]));
  s=await next();assert.deepEqual([(await status(queued.id)).state,(await status(queued.id)).confirmations],['done',1]);
  const first=service.reader.journal[0],onChain=await fetchTx(chain.url,first.txid);
  assert.deepEqual(unframe(onChain.tx.extra),claim0,'the record is in tx_extra of a real transaction');assert.ok(onChain.tx.extra.length<=1060);
  note('first record through the relay',{txid:first.txid,height:first.height,recordBytes:claim0.length,extraBytes:onChain.tx.extra.length,fee:service.relay.jobs().find(j=>j.id===queued.id).fee});
  await mine(10);await pass();const coins=await carrier.status();assert.ok(coins.ready>=6,'the split coins are ready after 10 blocks: '+JSON.stringify(coins));

  // 3. Claim with the one-time key of the owner coin (what the XMR20 wallet does). The throwaway keys stay in memory.
  const keys={view:unhex((await bob.rpc('query_key',{key_type:'view_key'})).key),spend:unhex((await bob.rpc('query_key',{key_type:'spend_key'})).key)};
  const found=findMine(owners,{viewSecret:keys.view,spends:new Map([[hex(decodeAddress(bob.address).spend),0]])});assert.deepEqual(found.map(m=>m.entry.number),[1]);
  const c1=L().prepareClaim({mordinal:1,to:bob.address}),claim1=L().claimWithKey(c1.bodyBytes,signWithOutputKey(c1.keyHash,outputSecret({viewSecret:keys.view,spendSecret:keys.spend,txPub:owners[1].ownerTxPubKeys[0],subScalar:subaddressSecret(keys.view,0,found[0].at)})));
  const sent1=await send(claim1);assert.equal(sent1.state,'sent');
  assert.deepEqual(await send(claim1),sent1,'posting the same record again changes nothing');
  const rival=L().prepareClaim({mordinal:1,to:carol.address});
  const second=await post('/records',{record:hex(L().claimWithKey(rival.bodyBytes,signWithOutputKey(rival.keyHash,outputSecret({viewSecret:keys.view,spendSecret:keys.spend,txPub:owners[1].ownerTxPubKeys[0],subScalar:subaddressSecret(keys.view,0,found[0].at)}))))});
  assert.equal(second.status,429);assert.match(second.body.error,/Another record for this Mordinal is waiting/);
  assert.deepEqual((await get('/pending')).body.pool.map(p=>p.txid),[sent1.txid]);
  await next();assert.equal((await status(sent1.id)).state,'done');assert.deepEqual((await get('/claimed')).body.numbers,[0,1]);
  note('claims',{proofAndMessage:'done',oneTimeKey:'done',secondRecordForTheSameMordinal:'429'});

  // 4. A sale: list, reserve, pay with a wallet, purchase held until the payment is in a block.
  const sign=async(w,p)=>L().sign(p.bodyBytes,await w.sign(p.text));
  const listing=L().prepareList({mordinal:0,seller:alice.address,price:2n*XMR});await send(await sign(alice,listing));await next();
  assert.deepEqual((await get('/listings')).body.listings.map(l=>[l.id,l.price]),[[listing.id,String(2n*XMR)]]);
  const res=L().prepareReserve({lot:listing.id,buyer:bob.address});await send(await sign(bob,res));await next();
  assert.deepEqual(res.pay.map(p=>[p.to,p.amount/10n**6n]),[[alice.address,1900000n],[fee.address,100000n]]);       // each amount ends in digits of the reservation
  const unknown=await post('/records',{record:hex(L().buyRecord({lot:listing.id,payments:res.pay.map((p,i)=>{const x=makeOutProof({txid:'77'.repeat(32),secret:7n,address:decodeAddress(p.to),message:paymentMessage(DOMAIN,listing.id)});
   return {txid:'77'.repeat(32),out:i,D:hex(x.D),c:hex(x.c),s:hex(x.s)};})}))});
  assert.deepEqual([unknown.status,/not known to the Monero node yet/.test(unknown.body.error)],[400,true]);
  const paid=await transfer(bob,res.pay.map(p=>({address:p.to,amount:p.amount})));                 // in the pool, not in a block
  const seen=await get('/tx/'+paid.txid);assert.deepEqual([seen.status,seen.body.payment.height],[200,null]);        // the service hands out the waiting payment
  const proofs=provePayments({lines:res.pay,payments:[{txid:paid.txid,tx:seen.body.payment.tx,txKey:paid.keys.join('')}],domain:DOMAIN,lot:listing.id});
  const buy=L().buyRecord({lot:listing.id,payments:proofs}),held=await send(buy);assert.equal(held.state,'held');assert.ok(paid.keys.every(k=>!hex(buy).includes(k)));
  assert.equal((await pass()).relay.waiting,1);assert.equal((await status(held.id)).state,'held');
  await next();assert.equal((await status(held.id)).state,'sent');
  await next();assert.equal((await status(held.id)).state,'done');assert.equal(L().mordinal(0).owner,bob.address);
  const sale=(await get('/sales')).body.events[0];assert.deepEqual([sale.number,sale.seller,sale.buyer,sale.price,sale.fee,sale.payments],[0,alice.address,bob.address,String(2n*XMR),String(XMR/10n),[paid.txid]]);
  await refresh();
  note('sale',{price:'2 XMR',fee:'0.1 XMR',heldUntilPaymentMined:true,payments:1});

  // 5. A move, and a refused record that someone publishes without the relay (it is journaled, and changes nothing).
  const move=L().prepareMove({mordinal:0,from:bob.address,to:carol.address}),late=await sign(bob,L().prepareMove({mordinal:0,from:bob.address,to:alice.address}));
  const moved=await send(await sign(bob,move));await next();
  assert.equal((await status(moved.id)).state,'done');assert.equal(L().mordinal(0).owner,carol.address);
  const stale=await carrier.carry(hex(late));await carrier.publish(stale.blob);await next();                  // signed earlier, published by hand afterwards
  const refused=service.reader.journal.find(e=>e.txid===stale.txid);assert.equal(refused.ok,false);assert.equal(typeof refused.error,'string');assert.equal(L().mordinal(0).owner,carol.address);
  note('direct record',{refusedInBlock:refused.error});

  // 6. Restart from the same folders: same state, nothing asked of the node for old blocks.
  const snapshot=()=>JSON.stringify({h:service.reader.height,hash:service.reader.hash,j:service.reader.journal,c:service.reader.checkpoints,s:service.reader.ledger.toJSON()});
  const before=snapshot();await service.close();service=await startService(options);base='http://127.0.0.1:'+service.port;assert.equal(snapshot(),before);
  assert.equal((await status(moved.id)).state,'done');

  // 7. The node replaces the newest block. The record that was in it goes back to waiting and is mined again.
  const c2=L().prepareClaim({mordinal:2,to:carol.address,holder:carol.address});
  const claim2=await send(L().claimWithProof(c2.bodyBytes,await carol.proof(owners[2].ownerTx),await carol.sign(c2.text)));
  await next();assert.equal((await status(claim2.id)).state,'done');const was=service.reader.hash;
  const popped=await (await fetch(chain.url+'/pop_blocks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({nblocks:1})})).json();assert.equal(popped.status,'OK');
  await call(chain.port,'flush_txpool');                                                            // the node forgets the transaction, too
  s=await pass();assert.equal(s.reorg,1);assert.equal(L().mordinal(2).claimed,false);
  assert.equal((await status(claim2.id)).state,'sent');assert.equal((await service.chain.txs([claim2.txid])).get(claim2.txid)?.inPool,true,'the relay sent the same transaction again');
  s=await next();assert.notEqual(service.reader.hash,was);assert.equal((await status(claim2.id)).state,'done');assert.equal(L().mordinal(2).owner,carol.address);
  note('reorganisation',{blocksReplaced:1,recordSentAgain:true,sameTransaction:true});
  await next(6);

  // 8. Pictures and views.
  const pic=await get('/content/0');assert.equal(pic.status,200);assert.deepEqual(pic.body,PNG);assert.equal(pic.headers.get('content-type'),'image/png');assert.equal((await get('/content/1')).status,415);
  const act=(await get('/activity')).body.events.map(e=>e.kind);assert.deepEqual(act,['claim','move','sale','reserve','list','claim','claim']);
  const m0=(await get('/mordinal/0')).body;assert.deepEqual(m0.history.map(h=>h.kind),['inscribed','claim','list','reserve','sale','move']);assert.equal(m0.mordinal.owner,carol.address);
  assert.deepEqual((await get('/address/'+carol.address)).body.mordinals.map(m=>m.number),[0,2]);

  // 9. The check tool agrees: replay, lookups on the node, and a scan of every block with a second reader.
  const got=await download(base),checked=await verify({...got,owners,chain:service.chain});
  assert.deepEqual(checked.problems,[]);assert.equal(checked.accepted,7);assert.equal(checked.refused,1);assert.ok(checked.checkpoints>=3);assert.equal(checked.checkedOnNode,8);
  assert.deepEqual(await scan({...got,owners,chain:service.chain,dir:join(dir,'scan')}),[]);
  // And a ledger fed by hand from the log comes to the same state.
  const hand=createLedger({domain:DOMAIN,feeAddress:fee.address,owners,height:start});for(const e of got.entries){hand.setHeight(e.height);if(e.ok)hand.apply(unhex(e.record),e.facts);}
  hand.setHeight(got.height);assert.deepEqual(hand.toJSON(),L().toJSON());
  const jobs=service.relay.jobs().filter(j=>j.fee),fees=jobs.map(j=>BigInt(j.fee));
  note('check tool',{...checked,scan:'equal'});
  note('relay cost',{records:jobs.length,feePerRecordAtomic:[String(fees.reduce((a,b)=>a<b?a:b)),String(fees.reduce((a,b)=>a>b?a:b))],note:'fakechain fee level; on mainnet a transaction of this size costs about the same as a small transfer'});
  evidence.result='passed';failed=false;
 }finally{
  if(service)await service.close().catch(()=>{});await stopAll([chain,...Object.values(W)]);await sleep(300);
  await rm(dir,{recursive:true,force:true});
  await writeFile(join(HERE,'..','lab-results.json'),JSON.stringify({...evidence,result:failed?'FAILED':'passed'},null,1)+'\n');}
});
