// A claim for holders who use Feather or Cake Wallet: the wallet only signs a message. SIMULATED: own offline fakechain
// (monerod --regtest) with REAL wallet2 wallets (monero-wallet-rpc, the wallet code inside Feather and Cake Wallet). Throwaway
// wallets, no real funds. The Feather and Cake apps themselves are not driven.
//   Way 1, view key: the holder gives the main address and the private view key to a local tool, which finds the Mordinals and
//          makes the payment proof; the holder signs the claim text in the wallet.
//   Way 2, view-only wallet: the holder opens a view-only copy of the wallet. There the owner transaction is a received one, so the
//          wallet makes the payment proof itself; the holder signs the claim text in the full wallet.
// Both end in the same claim record as the Monero CLI way (proof 1). No rule changes.
//   node --test tests/lab-wallet-apps.test.mjs      (about 1 minute; writes tests/fixtures-wallet-apps.json and lab-wallet-apps-results.json)
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createLedger} from '../lib/ledger.mjs';
import {OP,PROOF,RULES,decodeRecord} from '../lib/records.mjs';
import {findWithViewKey,inProofFromViewKey,parseInProof,verifyInProof} from '../lib/claim.mjs';
import {checkPayment,fetchTx} from '../lib/payment.mjs';
import {hex,unhex,decodeAddress} from '../lib/monero.mjs';
import {call,startChain,startWallet,txPubKeys,stopAll} from './lab-harness.mjs';
const HERE=import.meta.dirname,DOMAIN='4d'.repeat(32);
const evidence={execution:'SIMULATED (own offline fakechain; real wallet2 signatures, payment proofs and view-only wallet; throwaway wallets; Feather and Cake apps not driven)',date:new Date().toISOString(),steps:[]};
const step=(name,x={})=>{evidence.steps.push({name,...x});console.error(JSON.stringify({step:name,...x}).slice(0,400));};

test('claim from a wallet that only signs messages: view key, or a view-only wallet',{timeout:900000},async()=>{
 const dir=await mkdtemp(join(HERE,'..','runs-lab-'));let chain,W={},failed=true;
 try{
  chain=await startChain(dir);for(const n of ['dana','erin','fee'])W[n]=await startWallet(dir,chain.port,n);
  const {dana,erin,fee}=W;
  evidence.software={monerod:chain.version,walletRpc:(await dana.rpc('get_version')).version};
  const mine=async(n=1,to=fee.address)=>{await call(chain.port,'generateblocks',{amount_of_blocks:n,wallet_address:to});};
  const tip=async()=>(await call(chain.port,'get_info')).height-1;
  const refresh=async()=>{for(const w of Object.values(W))await w.rpc('refresh');};
  await mine(80,dana.address);await mine(80,erin.address);await mine(70);await refresh();
  const pay=async(from,address)=>{const t=await from.rpc('transfer',{destinations:[{address,amount:1e9}],get_tx_key:true,priority:0});await mine(1);await refresh();return {txid:t.tx_hash,key:t.tx_key};};
  const danaSub=(await dana.rpc('create_address',{account_index:0,label:'mordinals'})).address;
  const paysOutput0=async(t,address)=>checkPayment({tx:(await fetchTx(chain.url,t.txid)).tx,txKey:t.key,address}).outputs.some(o=>o.index===0);
  const until=async(make,want)=>{for(let i=0;i<12;i++){const t=await make();if(await want(t))return t;}throw Error('no transaction with the wanted output order in 12 tries');};

  // 1. Five test Mordinals: ordinary transactions whose output 0 plays the owner coin.
  const made=[
   ['dana sends to herself (the inscriber keeps it)',await pay(dana,dana.address)],
   ['dana sends to herself again',await pay(dana,dana.address)],
   ['sent to a subaddress of dana',await until(()=>pay(erin,danaSub),t=>paysOutput0(t,danaSub))],
   ['dana sends to her own subaddress',await until(()=>pay(dana,danaSub),t=>paysOutput0(t,danaSub))],
   ['erin sends to herself (not dana\'s)',await pay(erin,erin.address)],
  ];
  const owners=[];for(const [i,[what,t]] of made.entries()){const x=await fetchTx(chain.url,t.txid),keys=txPubKeys(x.tx),o=x.tx.vout[0].target.tagged_key;
   assert.equal(keys.main.length,1);assert.equal(keys.additional.length,0,'one transaction key, as on every real owner transaction');
   owners.push({number:i,what,registrationTx:t.txid,registrationHeight:x.height,ownerTx:t.txid,ownerHeight:x.height,ownerOutputKey:o.key,ownerViewTag:o.view_tag,ownerTxPubKeys:keys.main,ownerAdditionalPubKeys:[]});}
  const start=await tip(),L=createLedger({domain:DOMAIN,feeAddress:fee.address,owners,height:start}),events=[];
  step('test Mordinals',{count:owners.length,startHeight:start,kinds:owners.map(o=>o.what)});
  const textOf=record=>{try{const d=decodeRecord(record);return d.op===OP.buy||(d.op===OP.claim&&d.body.proof===PROOF.outputKey)?null:L.textOf(d.bodyBytes);}catch{return null;}};
  const accept=async(name,record)=>{L.setHeight(await tip());const text=textOf(record),out=L.apply(record);events.push({name,height:L.height,record:hex(record),text,accepted:true,id:out.id});return out;};
  const refuse=async(name,record,pattern)=>{L.setHeight(await tip());let error;try{L.check(record);}catch(e){error=e.message;}
   assert.ok(error,name+': should be refused');assert.match(error,pattern,name);events.push({name,height:L.height,record:hex(record),text:textOf(record),accepted:false,error});return error;};

  // 2. Why the wallet app cannot do it alone: in the full wallet a transaction sent to yourself is an outgoing one.
  //    (Feather makes payment proofs for incoming transactions only; Cake Wallet makes none.)
  const kindIn=async(w,txid)=>[...new Set(((await w.rpc('get_transfer_by_txid',{txid})).transfers||[]).map(t=>t.type))].sort().join('+');
  const fullWalletSees=await kindIn(dana,owners[1].ownerTx);assert.equal(fullWalletSees,'out');

  // 3. Way 1: main address + private view key. The throwaway view key stays in memory and is wiped below.
  const view=unhex((await dana.rpc('query_key',{key_type:'view_key'})).key),erinView=unhex((await erin.rpc('query_key',{key_type:'view_key'})).key);
  assert.throws(()=>findWithViewKey(owners,{address:dana.address,viewSecret:erinView,subaddresses:5}),/does not belong to this address/,'a wrong view key is noticed');
  assert.throws(()=>findWithViewKey(owners,{address:danaSub,viewSecret:view}),/main address/);
  const found=findWithViewKey(owners,{address:dana.address,viewSecret:view,subaddresses:5});
  assert.deepEqual(found.map(m=>[m.entry.number,m.holder]),[[0,dana.address],[1,dana.address],[2,danaSub],[3,danaSub]],'the view key finds the four Mordinals and the address that holds each');
  for(const m of found){assert.equal(m.proof.length,141);
   const checked=await erin.rpc('check_tx_proof',{txid:m.entry.ownerTx,address:m.holder,signature:m.proof});assert.equal(checked.good,true,'wallet2 accepts the proof made from the view key');assert.ok(checked.received>0);}
  const c0=L.prepareClaim({mordinal:0,to:dana.address,holder:found[0].holder});step('claim text',{text:c0.text});
  await assert.rejects(async()=>L.claimWithProof(c0.bodyBytes,found[0].proof,await dana.sign(c0.text,'view')),/not for this text and address/,'the view key alone cannot claim');
  await assert.rejects(async()=>L.claimWithProof(c0.bodyBytes,found[0].proof,await erin.sign(c0.text)),/not for this text and address/,'another wallet cannot sign the claim');
  assert.equal((await accept('claim #0: proof made from the view key + message signed in the wallet (self-sent transaction)',L.claimWithProof(c0.bodyBytes,found[0].proof,await dana.sign(c0.text)))).owner,dana.address);
  const c2=L.prepareClaim({mordinal:2,to:dana.address,holder:found[2].holder});
  await assert.rejects(async()=>L.claimWithProof(c2.bodyBytes,found[2].proof,await dana.sign(c2.text,'spend',0)),/not for this text and address/,'the subaddress itself must sign');
  assert.equal((await accept('claim #2: proof made from the view key, subaddress coin, signed with the subaddress',L.claimWithProof(c2.bodyBytes,found[2].proof,await dana.sign(c2.text,'spend',1)))).owner,dana.address);
  // The view key cannot take somebody else's Mordinal: a correct proof for dana's address on erin's transaction pays her nothing.
  const c4=L.prepareClaim({mordinal:4,to:dana.address,holder:dana.address}),p4=inProofFromViewKey({txid:owners[4].ownerTx,txPub:owners[4].ownerTxPubKeys[0],address:decodeAddress(dana.address),viewSecret:view});
  assert.equal(verifyInProof({txid:owners[4].ownerTx,txPub:owners[4].ownerTxPubKeys[0],address:decodeAddress(dana.address),...parseInProof(p4)}),true);
  await refuse('claim #4: a Mordinal of another wallet',L.claimWithProof(c4.bodyBytes,p4,await dana.sign(c4.text)),/did not receive output 0/);
  step('way 1: view key',{found:found.map(m=>m.entry.number),proofsAcceptedByWallet2:found.length,selfSentTransaction:'accepted',subaddressCoin:'accepted',viewKeySignature:'refused',otherWallet:'refused',wrongViewKey:'noticed',anotherWalletsMordinal:'refused'});

  // 4. Way 2: a view-only copy of the wallet (address + private view key, no spend key), as Feather and the Monero CLI make it.
  //    It cannot see what the wallet spent, so the owner transaction is a received one and the wallet makes the InProof itself.
  W.viewOnly=await startWallet(dir,chain.port,'dana-view-only',port=>call(port,'generate_from_keys',{filename:'w',address:dana.address,viewkey:hex(view),password:'',restore_height:0}));
  view.fill(0);erinView.fill(0);
  const viewOnly=W.viewOnly;assert.equal(viewOnly.address,dana.address);await viewOnly.rpc('refresh');
  await assert.rejects(()=>viewOnly.rpc('query_key',{key_type:'spend_key'}).then(r=>{if(/^0+$/.test(r.key))throw Error('no spend key');}),'the view-only wallet has no spend key');
  const viewOnlySees=await kindIn(viewOnly,owners[1].ownerTx);assert.equal(viewOnlySees,'in');
  const p1=await viewOnly.proof(owners[1].ownerTx);assert.match(p1,/^InProofV2/);assert.equal(p1.length,141);
  assert.equal((await erin.rpc('check_tx_proof',{txid:owners[1].ownerTx,address:dana.address,signature:p1})).good,true);
  const c1=L.prepareClaim({mordinal:1,to:dana.address,holder:dana.address});
  // A view-only wallet cannot sign the claim: either it refuses, or what it signs is refused here.
  let viewOnlySignature='refused by the wallet';
  try{const s=await viewOnly.sign(c1.text);viewOnlySignature='made, refused by the rules';assert.throws(()=>L.claimWithProof(c1.bodyBytes,p1,s),/not for this text and address/);}catch(e){if(e.code==='ERR_ASSERTION')throw e;}
  assert.equal((await accept('claim #1: proof from the view-only wallet + message signed in the full wallet (self-sent transaction)',L.claimWithProof(c1.bodyBytes,p1,await dana.sign(c1.text)))).owner,dana.address);
  const p3=await viewOnly.proof(owners[3].ownerTx,danaSub),c3=L.prepareClaim({mordinal:3,to:danaSub,holder:danaSub});
  assert.equal((await accept('claim #3: proof from the view-only wallet, self-sent to a subaddress',L.claimWithProof(c3.bodyBytes,p3,await dana.sign(c3.text,'spend',1)))).owner,danaSub);
  step('way 2: view-only wallet',{fullWalletShowsOwnerTransactionAs:fullWalletSees,viewOnlyWalletShowsItAs:viewOnlySees,proofMadeByWallet:'InProofV2, accepted',signingInViewOnlyWallet:viewOnlySignature,subaddressCoin:'accepted'});

  // 5. After the claim everything is one signed message from the wallet.
  const post=async(name,p,signer,index=0)=>accept(name,L.sign(p.bodyBytes,await signer.sign(p.text,'spend',index)));
  const mv=L.prepareMove({mordinal:0,from:dana.address,to:erin.address});step('move text',{text:mv.text});
  assert.equal((await post('move #0 to erin',mv,dana)).owner,erin.address);
  const li=L.prepareList({mordinal:3,seller:danaSub,price:10n**11n,until:(await tip())+300});
  assert.ok((await post('list #3 for 0.1 XMR from the subaddress',li,dana,1)).lot);
  step('after the claim',{move:'accepted',listing:'accepted'});

  const final=JSON.parse(JSON.stringify(L.toJSON()));
  assert.deepEqual(final.claimed.map(m=>[m.number,m.owner]),[[0,erin.address],[1,dana.address],[2,dana.address],[3,danaSub]]);
  step('result',{accepted:events.filter(e=>e.accepted).length,refused:events.filter(e=>!e.accepted).length,claimRecordBytes:Math.max(...events.filter(e=>e.accepted&&e.name.startsWith('claim')).map(e=>e.record.length/2))});
  await writeFile(join(HERE,'fixtures-wallet-apps.json'),JSON.stringify({about:'Records and expected results from tests/lab-wallet-apps.test.mjs (wallet2 wallets on a local test chain). Public data only: no keys.',
   made:evidence.date.slice(0,10),network:'mainnet',domain:DOMAIN,feeAddress:fee.address,startHeight:start,rules:{...RULES,minPrice:RULES.minPrice.toString()},owners,events,final},null,1)+'\n');
  failed=false;evidence.result='PASSED';
 }finally{evidence.result??='FAILED';await writeFile(join(HERE,'..','lab-wallet-apps-results.json'),JSON.stringify(evidence,null,1)+'\n');
  await stopAll([...Object.values(W),chain]);
  if(!failed)await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:500});else console.error('lab kept at '+dir);}
});
