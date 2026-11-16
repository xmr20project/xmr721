// Claiming by burning on a local test chain. SIMULATED: own offline fakechain (monerod --regtest) and throwaway wallets,
// no real funds. Real here: the registration and the burning transfer are real transactions in the original Mordinals
// format, built by a separate tool and accepted by a real node; the reader finds the transfer in a real block, as the
// node returns it: the Mordinal is burned and waits for its fee. Then an ordinary monero-wallet-rpc wallet pays the
// fee to the Mordinal's fee address (once alone, once beside another payment, where the transaction carries additional
// keys), and the reader gives the Mordinal to the address in the text. A view-only copy of the project's fee wallet in
// monero-wallet-rpc, made from its public view key, sees the same payments at the same subaddresses (1, n + 1) with the
// same amounts.
// The tool is not part of this repository: MORDINAL_OLD names its binary (a wallet that builds original-format
// registrations and transfers to the burn address: `init`, `mint-old`, `transfer-old`, `publish`; it takes the owner
// list and the first burn block, and builds no burn before that block). Without it the test is skipped.
//   MONERO_BIN=<folder with monerod and monero-wallet-rpc> MORDINAL_OLD=<path to the tool> node --test reader/tests/lab-burn.test.mjs   (a few minutes)
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {hex} from '../../rules/lib/monero.mjs';
import {burnAddress,burnClaimId,burnParts,readTransfer} from '../../rules/lib/burn.mjs';
import {call,startChain,startWallet,stopAll,txPubKeys} from '../../rules/tests/lab-harness.mjs';
import {FEE_WALLET,feeWallet,feeAddressOf} from '../../rules/lib/burn-fee.mjs';
import {wallet} from '../../rules/tests/helpers.mjs';
import {transferOf} from '../../rules/tests/original-rules.mjs';
import {startService} from '../service.mjs';
import {verify,download} from '../tools/verify.mjs';
import {createChain} from '../lib/chain.mjs';
const HERE=import.meta.dirname,TOOL=process.env.MORDINAL_OLD,DOMAIN='5e'.repeat(32);
// The test chain's dead outputs: mining rewards have one output each, so the reward of block h is global output h.
// Sixteen in a row with one left out, the shape of mainnet's.
const DEAD=[5,6,7,8,9,10,11,12,13,14,15,16,17,18,20];

test('a real burning transfer on a test chain waits for its fee; a real payment of the fee claims the Mordinal',{timeout:900000,skip:TOOL?false:'MORDINAL_OLD is not set'},async()=>{
 const dir=await mkdtemp(join(HERE,'..','runs-lab-burn-'));let chain,service=null,payer=null,feeView=null;
 try{
  chain=await startChain(dir);
  const tool=(wallet,...args)=>new Promise((res,rej)=>execFile(TOOL,[join(dir,wallet),...args],{env:{PATH:process.env.PATH,MORDINALS_NODE:chain.url,MORDINALS_NETWORK:'offline-fakechain'},maxBuffer:1<<24},
   (err,out)=>{let v;try{v=JSON.parse(out);}catch{return rej(err||Error('tool output: '+out));}if(!v.result)return rej(Error(`${args[0]}: ${v.error}`));res(v.result);}));
  const holder=(await tool('holder','init')).address,filler=(await tool('filler','init')).address,receiver=(await tool('receiver','init')).address;
  const mine=(n,to=filler)=>call(chain.port,'generateblocks',{amount_of_blocks:n,wallet_address:to});
  const tip=async()=>(await call(chain.port,'get_info')).height-1;
  const node=async txid=>{const r=await (await fetch(chain.url+'/get_transactions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({txs_hashes:[txid],decode_as_json:true})})).json();
   const t=r.txs[0];return {height:t.block_height,outs:t.output_indices,tx:JSON.parse(t.as_json)};};
  payer=await startWallet(dir,chain.port,'payer');
  await mine(70,holder);await mine(70,payer.address);await mine(500);
  // Two registrations in the original format, each a small picture of its own. Their owner outputs make the owner list.
  const picture=()=>Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),randomBytes(40)]);
  const owners=[];
  for(const n of [0,1]){await writeFile(join(dir,`p${n}.png`),picture());const reg=await tool('holder','mint-old',join(dir,`p${n}.png`));await tool('holder','publish',reg.blob);await mine(1);
   const t=await node(reg.txid),o=t.tx.vout[0].target.tagged_key;
   owners.push({number:n,registrationTx:reg.txid,registrationHeight:t.height,ownerTx:reg.txid,ownerHeight:t.height,ownerOutputIndex:t.outs[0],ownerOutputKey:o.key,ownerViewTag:o.view_tag,ownerTxPubKeys:[hex(Uint8Array.from(t.tx.extra.slice(1,33)))],ownerAdditionalPubKeys:[]});}
  await mine(10);                                             // an owner output can be spent 10 blocks after it was mined
  await writeFile(join(dir,'owners.jsonl'),owners.map(o=>JSON.stringify(o)+'\n').join(''));
  const start=await tip();
  service=await startService({owners:join(dir,'owners.jsonl'),domain:DOMAIN,feeAddress:filler,node:chain.url,start,burnFrom:start+2,burnDead:DEAD,state:join(dir,'state'),port:0,checkpointEvery:2,testHooks:true,xmr20Earlier:false,log:()=>{}});
  const base='http://127.0.0.1:'+service.port,get=async path=>(await (await fetch(base+path)).json());
  const pass=async()=>{const r=await fetch(base+'/test/step',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(r.status,200);return r.json();};
  const info=await get('/info');assert.equal(info.burnFrom,start+2);assert.deepEqual(info.burn.dead,DEAD);assert.equal(info.burn.address,burnAddress());
  assert.equal((await get('/mordinal/0')).mordinal.ownerOutput,owners[0].ownerOutputIndex);

  assert.equal(info.burn.recordsEnd,start+2+720);
  // The tool builds no burn before the first burn block: such a transfer would claim nothing and could not be made again.
  const burnArgs=['--dead','5-18,20','--owners',join(dir,'owners.jsonl'),'--burn-from',String(start+2),'--margin','0'],other=wallet('lab burn receiver').sub(3).address;
  await writeFile(join(dir,'claim.txt'),'xmr721 claim to '+receiver+'\n');await writeFile(join(dir,'other.txt'),'  xmr721 claim to '+other+'\r\n');await writeFile(join(dir,'bad.txt'),'a transfer with another text');
  await assert.rejects(tool('holder','transfer-old',owners[0].registrationTx,join(dir,'claim.txt'),...burnArgs),/Too early: the ledger counts burns from block/);
  await mine(2);await pass();assert.equal(await tip(),start+2);
  await assert.rejects(tool('holder','transfer-old',owners[1].registrationTx,join(dir,'bad.txt'),...burnArgs),/has to be exactly "xmr721 claim to <address>"/);
  // The burn of Mordinal 0, naming the receiver, and of Mordinal 1, naming a subaddress of another wallet. The tool
  // trims the text files: the transfers carry the text and nothing else.
  const burn=await tool('holder','transfer-old',owners[0].registrationTx,join(dir,'claim.txt'),...burnArgs);
  const second=await tool('holder','transfer-old',owners[1].registrationTx,join(dir,'other.txt'),...burnArgs);
  assert.equal(burn.text,'xmr721 claim to '+receiver);assert.equal(second.text,'xmr721 claim to '+other);
  await tool('holder','publish',burn.blob);await tool('holder','publish',second.blob);await mine(1);await pass();   // block start+3
  const t=await node(burn.txid);assert.equal(t.height,start+3);
  // What the node returned is what the rule read: the text, the ring of the fifteen and the owner output, the fee.
  assert.equal(Buffer.from(readTransfer(t.tx.extra).text).toString(),'xmr721 claim to '+receiver);
  const ring=(()=>{let at=0;return t.tx.vin[0].key.key_offsets.map(o=>at+=o);})();assert.deepEqual(ring,[...DEAD,owners[0].ownerOutputIndex].sort((a,b)=>a-b));
  assert.ok(BigInt(t.tx.rct_signatures.txnFee)>=10n**9n);
  // The reader: both burns count, and both Mordinals wait for their fee, the burn's own transaction fee.
  const id=burnClaimId(DOMAIN,burn.txid),due0=String(t.tx.rct_signatures.txnFee),due1=String((await node(second.txid)).tx.rct_signatures.txnFee),fees=feeWallet();
  {const m=await get('/mordinal/0');assert.equal(m.mordinal.claimed,false);assert.equal(m.mordinal.owner,null);
   assert.deepEqual(m.mordinal.waiting,{txid:burn.txid,id,to:receiver,height:start+3,due:due0,paid:'0',missing:due0});assert.deepEqual(m.mordinal.burnFee,{address:feeAddressOf(fees,0).address,paid:'0'});
   const entry=(await get('/entry/'+burn.txid)).entry;assert.deepEqual({...entry,pos:0},{txid:burn.txid,height:start+3,pos:0,id,op:null,kind:'burn claim',number:0,to:receiver,state:'waiting',fee:{due:due0,paid:'0',missing:due0,address:feeAddressOf(fees,0).address},ok:true});
   assert.equal((await get('/mordinal/1')).mordinal.waiting.to,other);assert.equal((await get('/status/'+id)).state,'waiting');}
  const burns=(await get('/burns')).burns;assert.deepEqual(burns.map(x=>x.txid).sort(),[burn.txid,second.txid].sort());assert.deepEqual(burns.find(x=>x.txid===burn.txid).burn,burnParts(t.tx));
  assert.deepEqual(burns.map(x=>x.state),['waiting','waiting']);
  // An ordinary wallet pays Mordinal 0's fee to its fee address, as the only payment of its transaction: the fee output
  // is found with the transaction public key. The claim completes in that block.
  await payer.rpc('refresh');
  const pay0=await payer.rpc('transfer',{destinations:[{amount:Number(due0),address:feeAddressOf(fees,0).address}],account_index:0,priority:0});await mine(1);await pass();
  const p0=await node(pay0.tx_hash),at0=p0.height;assert.equal(txPubKeys(p0.tx).additional.length,0);
  {const m=await get('/mordinal/0');assert.equal(m.mordinal.claimed,true);assert.equal(m.mordinal.owner,receiver);assert.equal(m.mordinal.seq,0);
   assert.deepEqual(m.history.map(h=>[h.kind,h.proof??null,h.txid,h.height,h.burnHeight??null,h.feeTx??null]),[['inscribed',null,owners[0].registrationTx,owners[0].registrationHeight,null,null],['claim','burn',burn.txid,at0,start+3,pay0.tx_hash]]);
   const fee=(await get('/entry/'+pay0.tx_hash)).entry;assert.equal(fee.kind,'fee payment');assert.deepEqual(fee.fees.map(f=>[f.number,f.amount,f.counted]),[[0,due0,true]]);
   assert.equal((await get('/entry/'+burn.txid)).entry.state,'claimed');assert.equal((await get('/status/'+id)).state,'done');}
  // Mordinal 1's fee in a transaction that also pays someone else: it carries additional keys, and the fee output is
  // found with its own. One piconero short, then the rest in a block of its own.
  const pay1=await payer.rpc('transfer',{destinations:[{amount:Number(due1)-1,address:feeAddressOf(fees,1).address},{amount:500000000000,address:filler}],account_index:0,priority:0});await mine(1);await pass();
  const p1=await node(pay1.tx_hash);assert.equal(txPubKeys(p1.tx).additional.length,p1.tx.vout.length);
  assert.equal((await get('/mordinal/1')).mordinal.waiting.missing,'1');
  await mine(10);await payer.rpc('refresh');
  const pay2=await payer.rpc('transfer',{destinations:[{amount:1,address:feeAddressOf(fees,1).address},{amount:1000000,address:filler}],account_index:0,priority:0});await mine(1);await pass();
  {const m=await get('/mordinal/1'),at=(await node(pay2.tx_hash)).height;assert.equal(m.mordinal.owner,other);assert.deepEqual(m.history.at(-1).height,at);assert.equal(m.history.at(-1).feeTx,pay2.tx_hash);}
  // A payment to the fee address of a number that is not on this ledger's owner list (the last number of mainnet's) is
  // no fee payment here: nothing is journaled for it.
  await mine(10);await payer.rpc('refresh');
  const far=await payer.rpc('transfer',{destinations:[{amount:1000000,address:feeAddressOf(fees,42894).address}],account_index:0,priority:0});await mine(1);await pass();
  assert.equal((await fetch(base+'/entry/'+far.tx_hash)).status,404);
  // A view-only copy of the fee wallet, made from the fee wallet's address and public view key, with the subaddress
  // lookahead the operator note asks for (account 1, 50,000 addresses), sees the same payments at subaddresses (1, 1)
  // and (1, 2), Mordinals 0 and 1, with the same amounts, and the one at (1, 42895).
  feeView=await startWallet(dir,chain.port,'fee-view-only',port=>call(port,'generate_from_keys',{filename:'w',address:FEE_WALLET.address,viewkey:FEE_WALLET.viewKey,password:'',restore_height:0}));
  assert.equal(feeView.address,FEE_WALLET.address);await feeView.rpc('set_subaddress_lookahead',{major_idx:2,minor_idx:50000});await feeView.rpc('rescan_blockchain');await feeView.rpc('refresh');
  const seen=((await feeView.rpc('get_transfers',{in:true,account_index:1})).in||[]).map(x=>[x.txid,x.subaddr_index.major,x.subaddr_index.minor,String(x.amount)]).sort();
  assert.deepEqual(seen,[[pay0.tx_hash,1,1,due0],[pay1.tx_hash,1,2,String(Number(due1)-1)],[pay2.tx_hash,1,2,'1'],[far.tx_hash,1,42895,'1000000']].sort());
  assert.equal((await feeView.rpc('get_address',{account_index:1,address_index:[1,2]})).addresses.map(a=>a.address).join(','),[feeAddressOf(fees,0).address,feeAddressOf(fees,1).address].join(','));
  // The original rules read the same transaction as a transfer of the same output.
  assert.deepEqual(transferOf({extra:t.tx.extra,inputs:t.tx.vin.map(i=>i.key.key_offsets),fee:t.tx.rct_signatures.txnFee},{deadAbove:4,deadBelow:21}),{moved:owners[0].ownerOutputIndex,text:'xmr721 claim to '+receiver});
  // The check tool replays the log and finds each entry on the node as logged (the node is the offline test chain,
  // which is what lets this ledger name dead outputs of its own).
  await mine(2);await pass();
  const checked=await verify({...await download(base),owners,chain:createChain(chain.url)});assert.deepEqual(checked,{ok:true,problems:[],accepted:5,refused:0,checkpoints:checked.checkpoints,checkedOnNode:5});
  assert.ok(checked.checkpoints>=1);assert.equal((await get('/checkpoint')).burnFrom,start+2);
 }finally{if(service)await service.close();await stopAll([chain,payer,feeView]);await rm(dir,{recursive:true,force:true});}});
