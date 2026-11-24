// Claiming by a spent coin (RULES.md section 11) on a local test chain. SIMULATED: own offline fakechain (monerod --regtest),
// throwaway wallet2 wallets (monero-wallet-rpc) and the real carrier tool for the relay's transactions; no real funds.
// Real here: the owner coins are spent by ordinary wallet2 transactions (sweep_single), one before the first block of such
// claims (in the start block: it never counts); the
// key images and their signatures are wallet2's own key image export (the one-member ring signature Feather exports for an
// imported outputs file); payment proofs and message signatures are wallet2's; the fees are paid by an ordinary wallet; the
// records travel in real transactions, and the reader reads all of it out of real blocks.
// Not real here: the test Mordinals are ordinary transactions put on an owner list by hand (no 0x10 inscription).
//   MONERO_BIN=<folder with monerod and monero-wallet-rpc> [MORDINALS_CARRIER=<carrier binary>] node --test reader/tests/lab-spend.test.mjs   (a few minutes)
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {hex} from '../../rules/lib/monero.mjs';
import {SPEND_FEE,originalTransfer} from '../../rules/lib/spend.mjs';
import {feeWallet,feeAddressOf} from '../../rules/lib/burn-fee.mjs';
import {BIN,call,startChain,startWallet,stopAll,txPubKeys} from '../../rules/tests/lab-harness.mjs';
import {startService} from '../service.mjs';
import {verify,scan,download} from '../tools/verify.mjs';
import {createChain} from '../lib/chain.mjs';
const HERE=import.meta.dirname,CARRIER=process.env.MORDINALS_CARRIER||join(HERE,'..','bin','mordinals-carrier'),DOMAIN='5f'.repeat(32),XMR=10n**12n;
// The test chain's dead outputs (as in lab-burn.test.mjs): this ledger claims by burning too, which section 11 needs.
const DEAD=[5,6,7,8,9,10,11,12,13,14,15,16,17,18,20];
const note=(step,x={})=>console.error(JSON.stringify({step,...x}).slice(0,600));

test('coins spent by ordinary wallet2 transactions claim their Mordinals through the relay once their fee is paid',{timeout:1500000,skip:BIN&&existsSync(CARRIER)?false:'MONERO_BIN or the carrier tool is missing'},async()=>{
 const dir=await mkdtemp(join(HERE,'..','runs-lab-spend-'));let chain,W={},service=null;
 try{
  chain=await startChain(dir);for(const n of ['alice','payer','filler'])W[n]=await startWallet(dir,chain.port,n);
  const {alice,payer,filler}=W;
  const mine=(n=1,to=filler)=>call(chain.port,'generateblocks',{amount_of_blocks:n,wallet_address:to.address});
  const tip=async()=>(await call(chain.port,'get_info')).height-1;
  const refresh=async()=>{for(const w of Object.values(W))await w.rpc('refresh');};
  const node=async txid=>{const r=await (await fetch(chain.url+'/get_transactions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({txs_hashes:[txid],decode_as_json:true})})).json();
   const t=r.txs[0];return {height:t.in_pool?null:t.block_height,outs:t.output_indices,tx:JSON.parse(t.as_json)};};
  await mine(80,alice);await mine(80,payer);await mine(70);await refresh();

  // 1. Two test Mordinals: alice pays her subaddress (0, 1); output 0 of each transaction plays the owner coin, at whichever
  //    of her addresses it went to.
  const sub=(await alice.rpc('create_address',{account_index:0,count:1})).address,owners=[];
  for(const n of [0,1]){const t=await alice.rpc('transfer',{destinations:[{address:sub,amount:Number(XMR/10n)}],priority:0});await mine(1);
   const x=await node(t.tx_hash),keys=txPubKeys(x.tx),o=x.tx.vout[0].target.tagged_key;
   owners.push({number:n,registrationTx:t.tx_hash,registrationHeight:x.height,ownerTx:t.tx_hash,ownerHeight:x.height,ownerOutputIndex:x.outs[0],ownerOutputKey:o.key,ownerViewTag:o.view_tag,ownerTxPubKeys:keys.main,ownerAdditionalPubKeys:keys.additional});}
  await mine(10);await refresh();
  const coinOf=async n=>(await alice.rpc('incoming_transfers',{transfer_type:'all',account_index:0,verbose:true})).transfers.find(c=>c.global_index===owners[n].ownerOutputIndex);
  const addressOf=async c=>(await alice.rpc('get_address',{account_index:0,address_index:[c.subaddr_index.minor]})).addresses[0].address;
  const coins=[await coinOf(0),await coinOf(1)];assert.ok(coins.every(c=>c&&c.key_image),'alice holds both owner coins');
  note('owners',{coins:coins.map(c=>({global:c.global_index,sub:c.subaddr_index}))});
  // Mordinal 1's coin is spent now, by an ordinary transaction, in the start block: before any block the ledger reads.
  const sweep=async c=>{const s=await alice.rpc('sweep_single',{key_image:c.key_image,address:alice.address,priority:0});return s.tx_hash||s.tx_hash_list?.[0];};
  const s1=await sweep(coins[1]);await mine(1);const start=await tip();
  await writeFile(join(dir,'owners.jsonl'),owners.map(o=>JSON.stringify(o)+'\n').join(''));

  // 2. The service with its relay: first burn block start + 2, first block of claims by a spent coin start + 4.
  const logs=[];
  service=await startService({owners:join(dir,'owners.jsonl'),domain:DOMAIN,feeAddress:filler.address,node:chain.url,start,burnFrom:start+2,burnDead:DEAD,spendFrom:start+4,state:join(dir,'state'),port:0,checkpointEvery:2,
   carrierBin:CARRIER,carrierState:join(dir,'carrier'),carrierNetwork:'offline-fakechain',carrierStart:1,limits:{resendMs:0,settleBlocks:6,minReady:3,splitInto:6,margin:2},testHooks:true,xmr20Earlier:false,log:v=>logs.push(v)});
  const base='http://127.0.0.1:'+service.port,get=async path=>(await fetch(base+path)).json();
  const post=async(path,body={})=>{const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
  const pass=async()=>{const r=await post('/test/step');assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
  const status=async id=>get('/status/'+id);
  const info=await get('/info');assert.deepEqual([info.burnFrom,info.spendFrom,info.spend],[start+2,start+4,{fee:SPEND_FEE.toString()}]);
  const relayAddress=(await service.relay.carrier.init()).address;
  await alice.rpc('transfer',{destinations:Array.from({length:3},()=>({address:relayAddress,amount:Number(XMR/5n)})),priority:0});await mine(10);await refresh();await pass();
  while(await tip()<start+4){await mine(1);await pass();}

  // 3. Mordinal 0: alice spends its coin in an ordinary transaction; her claim names that transaction.
  const L=()=>service.reader.ledger,receiver=(await payer.rpc('create_address',{account_index:0,count:1})).address;
  const s0=await sweep(coins[0]);
  const signedKeyImage=async c=>{const k=(await alice.rpc('export_key_images',{all:true})).signed_key_images.find(x=>x.key_image===c.key_image);return {keyImage:k.key_image,c:k.signature.slice(0,64),r:k.signature.slice(64)};};
  const claim=async(n,spendTx,{coin=coins[n],k=null}={})=>{const holder=await addressOf(coin),ki=k||await signedKeyImage(coin),p=L().prepareClaim({mordinal:n,to:receiver,holder,spendTx,keyImage:ki.keyImage});
   return L().claimWithSpend(p.bodyBytes,await alice.proof(owners[n].ownerTx,holder),{c:ki.c,r:ki.r},await alice.sign(p.text,'spend',coin.subaddr_index.minor));};
  // Mordinal 1's key image with Mordinal 0's spend: refused at the relay.
  const wrong=await post('/records',{record:hex(await claim(1,s0))});
  assert.ok(wrong.status>=400&&wrong.status<500,JSON.stringify(wrong));assert.match(wrong.body.error,/does not spend the owner coin/);
  // The spend is in the pool: held. In the newest block: still held. One block further: sent. In a block: waiting for its fee.
  const r0=await post('/records',{record:hex(await claim(0,s0))});assert.equal(r0.status,200,JSON.stringify(r0.body));assert.equal(r0.body.state,'held');
  await mine(1);await pass();assert.equal((await node(s0)).height,await tip());assert.equal((await status(r0.body.id)).state,'held');
  await mine(1);await pass();assert.equal((await status(r0.body.id)).state,'sent');
  await mine(1);await pass();
  const recordTx=service.reader.entryById(r0.body.id).txid,waiting=await status(r0.body.id);
  assert.deepEqual([waiting.state,waiting.txid,waiting.fee.due,waiting.fee.missing,waiting.fee.address],['waiting',recordTx,SPEND_FEE.toString(),SPEND_FEE.toString(),feeAddressOf(feeWallet(),0).address]);
  assert.deepEqual((await get('/mordinal/0')).mordinal.waiting.spendTx,s0);assert.equal((await get('/entry/'+recordTx)).entry.kind,'spent coin claim');
  const spend0=await node(s0);assert.equal(originalTransfer(spend0.tx.extra),false,'a wallet2 sweep holds no transfer of the original format');assert.ok(spend0.tx.vin.some(i=>i.key.k_image===coins[0].key_image));
  note('claim waits',{record:recordTx,spend:s0,spendHeight:spend0.height,recordHeight:service.reader.entryById(r0.body.id).height,extraTags:spend0.tx.extra.slice(0,1)});
  // The fee from an ordinary wallet completes it.
  await payer.rpc('refresh');const fee0=await payer.rpc('transfer',{destinations:[{amount:Number(SPEND_FEE),address:feeAddressOf(feeWallet(),0).address}],priority:0});await mine(1);await pass();
  {const d=await status(r0.body.id),m=await get('/mordinal/0');assert.equal(d.state,'done');assert.equal(m.mordinal.owner,receiver);
   const h=m.history.at(-1);assert.deepEqual([h.kind,h.proof,h.txid,h.spendTx,h.feeTx],['claim','spent coin',recordTx,s0,fee0.tx_hash]);}

  // 4. Mordinal 1, whose coin was spent in the start block, before the first block of such claims: refused at the relay.
  const spend1=await node(s1);assert.ok(spend1.height<=start);assert.equal(originalTransfer(spend1.tx.extra),false);
  const r1=await post('/records',{record:hex(await claim(1,s1))});assert.ok(r1.status>=400&&r1.status<500,JSON.stringify(r1));
  assert.match(r1.body.error,new RegExp(`The coin was spent before block ${start+4}`));assert.equal((await get('/mordinal/1')).mordinal.claimed,false);
  note('claims done',{mordinal0:receiver.slice(0,8),mordinal1:'refused: spent at '+spend1.height+', before block '+(start+4)});

  // 5. The check tool replays the log, finds every record and spending transaction on the node, and a reader of its own
  //    over the same blocks writes the same log.
  await mine(2);await pass();
  const got=await download(base),checked=await verify({...got,owners,chain:createChain(chain.url)});
  assert.equal(checked.ok,true,JSON.stringify(checked.problems));assert.ok(checked.accepted>=2);
  assert.deepEqual(await scan({...got,owners,chain:createChain(chain.url),dir:join(dir,'scan')}),[]);
  note('checked',{accepted:checked.accepted,refused:checked.refused,checkpoints:checked.checkpoints,onNode:checked.checkedOnNode});
 }finally{if(service)await service.close();await stopAll([chain,...Object.values(W)]);await rm(dir,{recursive:true,force:true});}});
