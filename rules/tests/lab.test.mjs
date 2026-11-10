// Mordinals claim and trade rules on a local test chain. SIMULATED: own offline fakechain (monerod --regtest) with five REAL wallet2
// wallets (monero-wallet-rpc, the wallet code inside Feather, Cake Wallet and the Monero CLI). Throwaway wallets, no real funds.
// Real here: every transaction, every wallet signature (wallet2 "sign"), every claim proof (wallet2 get_tx_proof), every payment
// and its transaction key, and wallet2's own check_tx_proof / check_tx_key, which these rules must agree with. The proofs in
// a buy record are made by this code from wallet2's transaction keys; wallet2 checks them, and this code checks wallet2's.
// Not real here: the test Mordinals are ordinary transactions put on an owner list by hand (no 0x10 inscription), and the records
// are fed to the ledger directly instead of being posted on chain by a relay. The Feather and Cake apps themselves are not driven.
//   node --test tests/lab.test.mjs        (about 3 minutes; writes tests/fixtures.json and lab-results.json)
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createLedger} from '../lib/ledger.mjs';
import {OP,PROOF,RULES,encodeBody,decodeRecord,amounts} from '../lib/records.mjs';
import {outputSecret,signWithOutputKey,findMine,parseInProof,verifyInProof} from '../lib/claim.mjs';
import {checkPayment,checkPaymentProof,fetchTx,parseTxKey,provePayments,makeOutProof,verifyOutProof,paymentMessage} from '../lib/payment.mjs';
import {hex,unhex,concat,decodeAddress,base58Encode,base58Decode,subaddressSecret,subaddressKeys,parseSignature as parseSig} from '../lib/monero.mjs';
import {makeInProof} from './helpers.mjs';
import {call,startChain,startWallet,txPubKeys,slim} from './lab-harness.mjs';
const HERE=import.meta.dirname;
const DOMAIN='4d'.repeat(32),XMR=10n**12n;
const evidence={execution:'SIMULATED (own offline fakechain; real wallet2 signatures, claim proofs, payments and transaction keys; buy-record proofs checked by wallet2; throwaway wallets)',date:new Date().toISOString(),steps:[]};
const step=(name,x={})=>{evidence.steps.push({name,...x});console.error(JSON.stringify({step:name,...x}).slice(0,400));};
test('claim with both proofs, trade with the 5% fee split, moves; real wallet2 wallets on a test chain',{timeout:1800000},async()=>{
 const dir=await mkdtemp(join(HERE,'..','runs-lab-'));let chain,W={},failed=true;
 try{
  chain=await startChain(dir);for(const n of ['alice','bob','carol','fee','market'])W[n]=await startWallet(dir,chain.port,n);
  const {alice,bob,carol,fee,market}=W,all=Object.values(W);
  evidence.software={monerod:chain.version,walletRpc:(await alice.rpc('get_version')).version};
  const mine=async(n=1,to=fee.address)=>{await call(chain.port,'generateblocks',{amount_of_blocks:n,wallet_address:to});};
  const tip=async()=>(await call(chain.port,'get_info')).height-1;
  const refresh=async()=>{for(const w of all)await w.rpc('refresh');};
  for(const w of [alice,bob,carol,market])await mine(80,w.address);await mine(70);await refresh();
  const pay=async(from,destinations,more={})=>{const t=await from.rpc('transfer',{destinations:destinations.map(d=>({address:d.address||d.to,amount:Number(d.amount)})),get_tx_key:true,priority:0,...more});
   await mine(1);await refresh();return {txid:t.tx_hash,key:t.tx_key,keys:t.tx_key.match(/.{64}/g)};};
  const facts=async(...txids)=>Promise.all(txids.map(async id=>{const t=await fetchTx(chain.url,id);return {txid:id,height:t.height,tx:slim(t.tx)};}));
  const txOf=async id=>slim((await fetchTx(chain.url,id)).tx);
  // The entries a wallet puts in a buy record: it holds the transaction keys and checks the amounts first.
  const prove=async(lines,pays,lot)=>provePayments({lines,payments:await Promise.all(pays.map(async p=>({txid:p.txid,tx:await txOf(p.txid),txKey:p.key}))),domain:DOMAIN,lot});
  // One entry made without a wallet's checks: the first output of `p` that pays this line's address, whatever its amount.
  // secrets: the transaction key the proof is made with (the payment's own unless a test gives another).
  const entry=async(p,line,lot,secrets=p.key)=>{const tx=await txOf(p.txid),o=checkPayment({tx,txKey:p.key,address:line.to}).outputs[0];assert.ok(o,'the payment pays '+line.what);
   const k=parseTxKey(secrets),message=paymentMessage(DOMAIN,lot),made=[k.additional[o.index],k.main].filter(x=>x!==undefined).map(secret=>{
    const x=makeOutProof({txid:p.txid,secret,address:decodeAddress(line.to),message});return {txid:p.txid,out:o.index,D:hex(x.D),c:hex(x.c),s:hex(x.s)};});
   return made.find(e=>{try{checkPaymentProof({tx,...e,address:line.to,message});return true;}catch{return false;}})||made.at(-1);};
  // wallet2's own OutProof text for a payment: one part per transaction key, the main key first.
  const outProofParts=text=>{assert.match(text,/^OutProofV2/);const rest=text.slice(10);assert.equal(rest.length%132,0);
   return rest.match(/.{132}/g).map(x=>{const s=base58Decode(x.slice(44));return {D:base58Decode(x.slice(0,44)),c:s.slice(0,32),s:s.slice(32)};});};
  const bobSub=(await bob.rpc('create_address',{account_index:0,label:'mordinals'})).address,aliceSub=(await alice.rpc('create_address',{account_index:0,label:'mordinals'})).address;

  // 1. Five test Mordinals: ordinary transactions whose output 0 plays the owner coin.
  const paysOutput0=async(t,address)=>checkPayment({tx:(await fetchTx(chain.url,t.txid)).tx,txKey:t.key,address}).outputs.some(o=>o.index===0);
  const until=async(make,want)=>{for(let i=0;i<12;i++){const t=await make();if(await want(t))return t;}throw Error('no transaction with the wanted output order in 12 tries');};
  const made=[
   ['bob sends to himself (the inscriber keeps it)',await pay(bob,[{address:bob.address,amount:10n**9n}])],
   ['alice sends to herself',await pay(alice,[{address:alice.address,amount:10n**9n}])],
   ['sent to a subaddress of alice',await until(()=>pay(market,[{address:aliceSub,amount:10n**9n}]),t=>paysOutput0(t,aliceSub))],
   ['sent to a subaddress of bob',await until(()=>pay(market,[{address:bobSub,amount:10n**9n}]),t=>paysOutput0(t,bobSub))],
   ['paid to bob, but output 0 is the sender\'s change',await until(()=>pay(market,[{address:bob.address,amount:10n**9n}]),async t=>!(await paysOutput0(t,bob.address)))],
  ];
  const owners=[];for(const [i,[what,t]] of made.entries()){const x=await fetchTx(chain.url,t.txid),keys=txPubKeys(x.tx),o=x.tx.vout[0].target.tagged_key;
   assert.equal(keys.main.length,1);assert.equal(keys.additional.length,0,'one transaction key, as on every real owner transaction');
   owners.push({number:i,what,registrationTx:t.txid,registrationHeight:x.height,ownerTx:t.txid,ownerHeight:x.height,ownerOutputKey:o.key,ownerViewTag:o.view_tag,ownerTxPubKeys:keys.main,ownerAdditionalPubKeys:[]});}
  const start=await tip(),L=createLedger({domain:DOMAIN,feeAddress:fee.address,owners,height:start}),events=[];
  step('test Mordinals',{count:owners.length,startHeight:start,kinds:owners.map(o=>o.what)});
  const textOf=record=>{try{const d=decodeRecord(record);return d.op===OP.buy||(d.op===OP.claim&&d.body.proof===PROOF.outputKey)?null:L.textOf(d.bodyBytes);}catch{return null;}};
  const accept=async(name,record,f)=>{L.setHeight(await tip());const text=textOf(record),out=L.apply(record,f);events.push({name,height:L.height,record:hex(record),text,...(f?{facts:f}:{}),accepted:true,id:out.id});return out;};
  const refuse=async(name,record,pattern,f)=>{L.setHeight(await tip());let error;try{L.check(record,f);}catch(e){error=e.message;}
   assert.ok(error,name+': should be refused');assert.match(error,pattern,name);events.push({name,height:L.height,record:hex(record),text:textOf(record),...(f?{facts:f}:{}),accepted:false,error});return error;};

  // 2. Claim with a wallet payment proof and a signed message (Monero CLI and wallet-rpc; Feather when the transaction was received).
  const bobProof=await bob.proof(owners[0].ownerTx);
  assert.match(bobProof,/^InProofV2/,'wallet2 makes an InProof for a transaction the wallet sent to itself');assert.equal(bobProof.length,141);
  const checked=await carol.rpc('check_tx_proof',{txid:owners[0].ownerTx,address:bob.address,signature:bobProof});assert.equal(checked.good,true);assert.ok(checked.received>0);
  assert.equal(verifyInProof({txid:owners[0].ownerTx,txPub:owners[0].ownerTxPubKeys[0],address:decodeAddress(bob.address),...parseInProof(bobProof)}),true,'this verifier agrees with wallet2');
  const c0=L.prepareClaim({mordinal:0,to:bob.address,holder:bob.address});
  step('claim text',{text:c0.text});
  await assert.rejects(async()=>L.claimWithProof(c0.bodyBytes,bobProof,await bob.sign(c0.text,'view')),/not for this text and address/,'a view-key signature is refused');
  await assert.rejects(async()=>L.claimWithProof(c0.bodyBytes,bobProof,await carol.sign(c0.text)),/not for this text and address/,'another wallet cannot sign the claim');
  const withMessage=await bob.proof(owners[0].ownerTx,bob.address,c0.text);
  assert.equal((await carol.rpc('check_tx_proof',{txid:owners[0].ownerTx,address:bob.address,message:c0.text,signature:withMessage})).good,true);
  await refuse('claim: payment proof made with a message',L.claimWithProof(c0.bodyBytes,withMessage,await bob.sign(c0.text)),/empty message/);
  await refuse('claim: payment proof of another transaction',L.claimWithProof(c0.bodyBytes,await bob.proof(owners[4].ownerTx),await bob.sign(c0.text)),/payment proof is not valid/);
  const out=await market.proof(owners[2].ownerTx,aliceSub);assert.match(out,/^OutProofV2/);assert.throws(()=>L.claimWithProof(c0.bodyBytes,out,'SigV2x'),/OutProof/);
  const claim0=L.claimWithProof(c0.bodyBytes,bobProof,await bob.sign(c0.text));
  assert.equal((await accept('claim #0: payment proof + message, sent to himself',claim0)).owner,bob.address);
  await refuse('claim #0 again',claim0,/already on the ledger/);
  // Subaddress holder.
  const c3=L.prepareClaim({mordinal:3,to:bobSub,holder:bobSub}),p3=await bob.proof(owners[3].ownerTx,bobSub);
  assert.equal((await carol.rpc('check_tx_proof',{txid:owners[3].ownerTx,address:bobSub,signature:p3})).good,true);
  await assert.rejects(async()=>L.claimWithProof(c3.bodyBytes,p3,await bob.sign(c3.text,'spend',0)),/not for this text and address/,'the main address cannot sign for the subaddress');
  assert.equal((await accept('claim #3: subaddress holder, payment proof + message',L.claimWithProof(c3.bodyBytes,p3,await bob.sign(c3.text,'spend',1)))).owner,bobSub);
  // #4: bob was paid by this transaction but does not hold output 0. The sender does.
  const c4=L.prepareClaim({mordinal:4,to:bob.address,holder:bob.address});
  await refuse('claim #4 by the payee of output 1',L.claimWithProof(c4.bodyBytes,await bob.proof(owners[4].ownerTx),await bob.sign(c4.text)),/did not receive output 0/);
  const c4m=L.prepareClaim({mordinal:4,to:market.address,holder:market.address});
  assert.equal((await accept('claim #4 by the holder of output 0',L.claimWithProof(c4m.bodyBytes,await market.proof(owners[4].ownerTx),await market.sign(c4m.text)))).owner,market.address);
  step('claim by payment proof',{selfSentTransaction:'InProofV2 made by wallet2, accepted',verifierAgreesWithWallet2:true,subaddress:'accepted',proofWithMessage:'refused',viewKeySignature:'refused',outProof:'refused',payeeOfOutput1:'refused'});

  // 3. Claim with the one-time key of the owner coin (what the XMR20 wallet does). The throwaway keys stay in memory.
  const keys={view:unhex((await alice.rpc('query_key',{key_type:'view_key'})).key),spend:unhex((await alice.rpc('query_key',{key_type:'spend_key'})).key)};
  const spends=new Map([[hex(decodeAddress(alice.address).spend),0],...[1,2,3].map(i=>[hex(subaddressKeys({spendSecret:keys.spend,viewSecret:keys.view,account:0,index:i}).spend),i])]);
  assert.equal(hex(subaddressKeys({spendSecret:keys.spend,viewSecret:keys.view,account:0,index:1}).spend),hex(decodeAddress(aliceSub).spend));
  const found=findMine(owners,{viewSecret:keys.view,spends});
  assert.deepEqual(found.map(m=>[m.entry.number,m.at]),[[1,0],[2,1]],'the wallet finds its two Mordinals in the owner list');
  const oneTime=(n,to)=>{const m=found.find(x=>x.entry.number===n),p=L.prepareClaim({mordinal:n,to});
   return {p,sig:signWithOutputKey(p.keyHash,outputSecret({viewSecret:keys.view,spendSecret:keys.spend,txPub:m.entry.ownerTxPubKeys[0],subScalar:subaddressSecret(keys.view,0,m.at)}))};};
  const k1=oneTime(1,alice.address);assert.equal(k1.sig.key,owners[1].ownerOutputKey);
  await refuse('claim #1: signature moved onto another receiving address',L.claimWithKey(L.prepareClaim({mordinal:1,to:carol.address}).bodyBytes,k1.sig),/not made with the key of the owner coin/);
  await refuse('claim #0 with the key of #1',L.claimWithKey(L.prepareClaim({mordinal:0,to:alice.address}).bodyBytes,k1.sig),/already claimed/);
  assert.equal((await accept('claim #1: one-time key',L.claimWithKey(k1.p.bodyBytes,k1.sig))).owner,alice.address);
  const k2=oneTime(2,alice.address);assert.equal(k2.sig.key,owners[2].ownerOutputKey);
  assert.equal((await accept('claim #2: one-time key of a subaddress coin, sent to the main address',L.claimWithKey(k2.p.bodyBytes,k2.sig))).owner,alice.address);
  // A proof made by this code from the view key is accepted by wallet2, so both directions agree.
  const own=makeInProof({txid:owners[1].ownerTx,txPub:owners[1].ownerTxPubKeys[0],holder:{...decodeAddress(alice.address),viewSecret:keys.view}});
  assert.equal((await carol.rpc('check_tx_proof',{txid:owners[1].ownerTx,address:alice.address,signature:own})).good,true);
  keys.view.fill(0);keys.spend.fill(0);
  step('claim by one-time key',{foundInOwnerList:[1,2],mainAddressCoin:'accepted',subaddressCoin:'accepted',signatureOnAnotherAddress:'refused',recordBytes:199});

  // 4. Sale 1: alice sells #1 for 0.2 XMR. carol pays the seller and the fee address in ONE transaction.
  const post=async(name,p,signer,index=0)=>accept(name,L.sign(p.bodyBytes,await signer.sign(p.text,'spend',index)));
  const l1=L.prepareList({mordinal:1,seller:alice.address,price:XMR/5n,until:(await tip())+400});step('listing text',{text:l1.text});
  await assert.rejects(async()=>L.sign(l1.bodyBytes,await alice.sign(l1.text,'view')),/not for this text and address/);
  await assert.rejects(async()=>L.sign(l1.bodyBytes,await bob.sign(l1.text)),/not for this text and address/);
  const lot1=(await post('list #1 for 0.2 XMR',l1,alice)).lot;
  const own1=L.prepareReserve({lot:lot1,buyer:alice.address});await refuse('reserve own listing',L.sign(own1.bodyBytes,await alice.sign(own1.text)),/seller cannot reserve/);
  const r1=L.prepareReserve({lot:lot1,buyer:carol.address});step('reservation text',{text:r1.text});await post('reserve #1',r1,carol);
  const second=L.prepareReserve({lot:lot1,buyer:market.address});await refuse('reserve while reserved',L.sign(second.bodyBytes,await market.sign(second.text)),/reserved by someone else/);
  const cx=L.prepareCancel({lot:lot1,seller:alice.address});await refuse('cancel while reserved',L.sign(cx.bodyBytes,await alice.sign(cx.text)),/reserved until block/);
  const mv=encodeBody(OP.move,{reg:owners[1].registrationTx,seq:0,from:alice.address,to:bob.address});await refuse('move while listed',L.sign(mv,await alice.sign(L.textOf(mv))),/listed for sale/);
  const t1=amounts({price:XMR/5n,code:r1.code}).tail;assert.deepEqual(r1.pay.map(x=>x.amount),[190000000000n+t1,10000000000n+t1]);
  const plain=await pay(carol,[{address:alice.address,amount:190000000000n},{address:fee.address,amount:10000000000n}]);
  await assert.rejects(()=>prove(r1.pay,[plain],lot1),/seller payment is 0\.19 XMR; this reservation needs exactly/,'the wallet side makes no record for a wrong amount');
  await refuse('buy #1: amounts without the reservation\'s last digits',L.buyRecord({lot:lot1,payments:[await entry(plain,r1.pay[0],lot1),await entry(plain,r1.pay[1],lot1)]}),/seller payment is 0\.19 XMR; this reservation needs exactly/,await facts(plain.txid));
  const sellerOnly=await pay(carol,[r1.pay[0]]);
  await assert.rejects(()=>prove(r1.pay,[sellerOnly],lot1),/protocol fee payment is missing/);
  assert.throws(()=>L.buyRecord({lot:lot1,payments:[]}),/names 2 or 3 payments/,'a record cannot leave a payee out');
  await refuse('buy #1: seller paid, fee paid without the last digits',L.buyRecord({lot:lot1,payments:[await entry(sellerOnly,r1.pay[0],lot1),await entry(plain,r1.pay[1],lot1)]}),/protocol fee payment is 0\.01 XMR; this reservation needs exactly/,await facts(sellerOnly.txid,plain.txid));
  // A payment with a lock time would not count; this wallet2 no longer makes one.
  await assert.rejects(()=>pay(carol,r1.pay,{unlock_time:1000}),/non-zero unlock time/);
  const both=await pay(carol,r1.pay);assert.equal(both.keys.length,1,'two standard addresses in one transaction: one transaction key');
  for(const x of r1.pay)assert.equal(BigInt((await bob.rpc('check_tx_key',{txid:both.txid,tx_key:both.key,address:x.to})).received),x.amount,'wallet2 check_tx_key agrees for the '+x.what);
  await assert.rejects(async()=>provePayments({lines:r1.pay,payments:[{txid:both.txid,tx:await txOf(both.txid),txKey:sellerOnly.key}],domain:DOMAIN,lot:lot1}),/pays nobody in this reservation with the key given/);
  await refuse('buy #1: proofs made with another transaction key',L.buyRecord({lot:lot1,payments:[await entry(both,r1.pay[0],lot1,sellerOnly.key),await entry(both,r1.pay[1],lot1,sellerOnly.key)]}),/proof for the seller payment does not fit/,await facts(both.txid));
  // The proofs of a buy record and wallet2's OutProof are the same thing: each side checks the other's.
  const proofs1=await prove(r1.pay,[both],lot1),message1=paymentMessage(DOMAIN,lot1),carried1=txPubKeys(await txOf(both.txid)).main[0];
  for(const [i,x] of r1.pay.entries()){
   const ours='OutProofV2'+base58Encode(unhex(proofs1[i].D))+base58Encode(unhex(proofs1[i].c+proofs1[i].s));
   const seen=await bob.rpc('check_tx_proof',{txid:both.txid,address:x.to,message:message1,signature:ours});
   assert.equal(seen.good,true,'wallet2 accepts the buy record\'s proof for the '+x.what);assert.equal(BigInt(seen.received),x.amount);
   assert.equal((await bob.rpc('check_tx_proof',{txid:both.txid,address:x.to,message:paymentMessage(DOMAIN,'00'.repeat(32)),signature:ours})).good,false,'not for another listing');
   const theirs=outProofParts(await carol.proof(both.txid,x.to,message1));assert.equal(theirs.length,1);
   assert.equal(verifyOutProof({txid:both.txid,txPub:carried1,address:decodeAddress(x.to),message:message1,...theirs[0]}),true,'this verifier accepts wallet2\'s proof for the '+x.what);
   assert.equal(hex(theirs[0].D),proofs1[i].D,'the same shared secret');}
  const buy1=L.buyRecord({lot:lot1,payments:proofs1});assert.equal(buy1.length,296);assert.ok(!hex(buy1).includes(both.key),'the record does not carry the transaction key');
  await refuse('buy #1: proofs made for another listing',L.buyRecord({lot:lot1,payments:await prove(r1.pay,[both],'00'.repeat(32))}),/proof for the seller payment does not fit/,await facts(both.txid));
  const sold1=await accept('buy #1: one transaction paying seller and fee',buy1,await facts(both.txid));
  assert.equal(sold1.owner,carol.address);assert.deepEqual(sold1.paid,{seller:(190000000000n+t1).toString(),'protocol fee':(10000000000n+t1).toString()});
  await refuse('buy #1 again, same record',buy1,/already on the ledger/,await facts(both.txid));
  await refuse('buy #1 again, new proofs of the same payment',L.buyRecord({lot:lot1,payments:await prove(r1.pay,[both],lot1)}),/already sold/,await facts(both.txid));
  await refuse('buy #1 again with other payments',L.buyRecord({lot:lot1,payments:[await entry(plain,r1.pay[0],lot1),await entry(plain,r1.pay[1],lot1)]}),/already sold/,await facts(plain.txid));
  step('sale 1',{price:'0.2 XMR',sellerReceived:sold1.paid.seller,feeAddressReceived:sold1.paid['protocol fee'],transactions:1,recordBytes:buy1.length,wallet2CheckTxKeyAgrees:true,wallet2CheckTxProofAcceptsRecordProofs:true,recordCheckAcceptsWallet2OutProof:true,walletRefusesLockTime:true,
   refused:['no last digits','fee without last digits','proofs with another key','proofs for another listing','second reservation','cancel while reserved','move while listed']});

  // 5. Sale 2: bob's subaddress sells #3 for 0.5 XMR through a marketplace that adds 2.5%. Paid in two transactions.
  const l3=L.prepareList({mordinal:3,seller:bobSub,price:XMR/2n,until:(await tip())+400}),lot3=(await post('list #3 for 0.5 XMR from a subaddress',l3,bob,1)).lot;
  const high=encodeBody(OP.reserve,{lot:lot3,payBy:(await tip())+10,buyer:carol.address,rate:501,market:market.address});
  await refuse('reserve with a marketplace fee above the cap',L.sign(high,await carol.sign(L.textOf(high))),/at most 5%/);
  const r3=L.prepareReserve({lot:lot3,buyer:carol.address,market:market.address,rate:250});step('reservation text with a marketplace fee',{text:r3.text});await post('reserve #3 with a 2.5% marketplace fee',r3,carol);
  const t3=amounts({price:XMR/2n,rate:250,code:r3.code}).tail;assert.deepEqual(r3.pay.map(x=>x.amount),[475000000000n+t3,25000000000n+t3,12500000000n+t3]);
  const first=await pay(carol,[r3.pay[0]]);assert.equal(first.keys.length,1);
  await assert.rejects(()=>prove(r3.pay,[first],lot3),/protocol fee payment is missing/);
  const rest=await pay(carol,[r3.pay[1],r3.pay[2]]);
  await refuse('buy #3: no entry for the marketplace fee',L.buyRecord({lot:lot3,payments:[await entry(first,r3.pay[0],lot3),await entry(rest,r3.pay[1],lot3)]}),/marketplace fee payment is missing/,await facts(first.txid,rest.txid));
  await refuse('buy #1 payment reused for #3',L.buyRecord({lot:lot3,payments:[await entry(first,r3.pay[0],lot3),await entry(both,r3.pay[1],lot3),await entry(rest,r3.pay[2],lot3)]}),/already used for a sale/,await facts(first.txid,both.txid,rest.txid));
  const buy3=L.buyRecord({lot:lot3,payments:await prove(r3.pay,[first,rest],lot3)});assert.equal(buy3.length,425);
  const sold3=await accept('buy #3: seller in one transaction, both fees in another',buy3,await facts(first.txid,rest.txid));
  assert.equal(sold3.owner,carol.address);assert.equal(sold3.paid['marketplace fee'],(12500000000n+t3).toString());
  step('sale 2',{price:'0.5 XMR',seller:'subaddress',paid:sold3.paid,transactions:2,recordBytes:buy3.length,refused:['fee above cap','marketplace fee entry missing','payment reuse']});

  // 6. Sale 3: carol sells #3 to alice's subaddress... the first reservation runs out; the next buyer wins; one transaction pays a
  //    subaddress seller and the fee address, so the wallet gives several transaction keys.
  const l0=L.prepareList({mordinal:0,seller:bob.address,price:XMR/10n,until:(await tip())+400}),lot0=(await post('list #0 for 0.1 XMR',l0,bob)).lot;
  const ra=L.prepareReserve({lot:lot0,buyer:carol.address,window:2});await post('reserve #0 for 2 blocks',ra,carol);await mine(3);
  // It ran out, and still holds the listing for 10 more blocks so that a payment made in time can be recorded.
  const early=L.prepareReserve({lot:lot0,buyer:aliceSub});await refuse('reserve #0 right after the first ran out',L.sign(early.bodyBytes,await alice.sign(early.text,'spend',1)),/reserved by someone else until block/);await mine(10);
  const rb=L.prepareReserve({lot:lot0,buyer:aliceSub});await post('reserve #0 after the first ran out',rb,alice,1);
  const late=await pay(carol,ra.pay);
  await assert.rejects(()=>prove(rb.pay,[late],lot0),/seller payment is .* this reservation needs exactly/);
  await refuse('buy #0: late payment for the reservation that ran out',L.buyRecord({lot:lot0,payments:[await entry(late,rb.pay[0],lot0),await entry(late,rb.pay[1],lot0)]}),/seller payment is .* this reservation needs exactly/,await facts(late.txid));
  const p0=await pay(alice,rb.pay);
  assert.equal((await accept('buy #0 by the newer reservation',L.buyRecord({lot:lot0,payments:await prove(rb.pay,[p0],lot0)}),await facts(p0.txid))).owner,aliceSub);
  const l0b=L.prepareList({mordinal:0,seller:aliceSub,price:XMR/10n,until:(await tip())+400}),lot0b=(await post('list #0 from a subaddress',l0b,alice,1)).lot;
  const rc=L.prepareReserve({lot:lot0b,buyer:bob.address});await post('reserve #0',rc,bob);
  const multi=await pay(bob,rc.pay);assert.ok(multi.keys.length>1,'a subaddress and a standard address in one transaction: additional transaction keys');
  assert.equal(BigInt((await carol.rpc('check_tx_key',{txid:multi.txid,tx_key:multi.key,address:aliceSub})).received),rc.pay[0].amount);
  const proofsMulti=await prove(rc.pay,[multi],lot0b),buyMulti=L.buyRecord({lot:lot0b,payments:proofsMulti}),messageMulti=paymentMessage(DOMAIN,lot0b),carriedMulti=txPubKeys(await txOf(multi.txid));
  assert.equal(carriedMulti.additional.length,multi.keys.length-1);assert.ok(multi.keys.every(k=>!hex(buyMulti).includes(k)),'no transaction key in the record');
  // wallet2's OutProof for the subaddress seller has one part per transaction key; the part of the seller's output is the record's proof.
  const partsMulti=outProofParts(await bob.proof(multi.txid,aliceSub,messageMulti)),at=proofsMulti[0].out;assert.equal(partsMulti.length,multi.keys.length);
  assert.equal(hex(partsMulti[at+1].D),proofsMulti[0].D,'the same shared secret as wallet2 for the additional key of that output');
  assert.equal(verifyOutProof({txid:multi.txid,txPub:carriedMulti.additional[at],address:decodeAddress(aliceSub),message:messageMulti,...partsMulti[at+1]}),true,'this verifier accepts wallet2\'s proof for an additional key');
  assert.equal((await accept('buy #0: subaddress seller, several transaction keys',buyMulti,await facts(multi.txid))).owner,bob.address);
  step('sale 3',{lapsedReservation:'late payment refused, newer reservation bought',subaddressSeller:{transactionKeys:multi.keys.length,recordBytes:buyMulti.length,wallet2CheckTxKeyAgrees:true,recordCheckAcceptsWallet2OutProof:true}});

  // 7. Moves, cancel, and records signed for an earlier state.
  const m2=L.prepareMove({mordinal:2,from:alice.address,to:bobSub}),held=L.sign(m2.bodyBytes,await alice.sign(m2.text));          // signed, not posted
  const l2=L.prepareList({mordinal:2,seller:alice.address,price:XMR/100n,until:(await tip())+5}),lot2=(await post('list #2 for 0.01 XMR, 5 blocks',l2,alice)).lot;
  await refuse('move #2 while listed',held,/cancel the listing first/);await mine(6);
  const expired=L.prepareReserve({lot:lot2,buyer:carol.address});await refuse('reserve an expired listing',L.sign(expired.bodyBytes,await carol.sign(expired.text)),/listing has expired/);
  const c2=L.prepareCancel({lot:lot2,seller:alice.address});await refuse('cancel by someone else',concat(c2.bodyBytes,Uint8Array.of(0),...Object.values(parseSig(await carol.sign(c2.text)))),/signature does not match/);
  await post('cancel the listing of #2',c2,alice);
  await refuse('move #2 signed before the cancel',held,/earlier state/);
  const m2b=L.prepareMove({mordinal:2,from:alice.address,to:bobSub});assert.equal((await post('move #2 to a subaddress',m2b,alice)).owner,bobSub);
  const m2c=L.prepareMove({mordinal:2,from:bobSub,to:carol.address});
  await assert.rejects(async()=>L.sign(m2c.bodyBytes,await bob.sign(m2c.text,'spend',0)),/not for this text and address/);
  assert.equal((await post('move #2 on from the subaddress',m2c,bob,1)).owner,carol.address);
  await refuse('move #2 by a former owner',L.sign(m2.bodyBytes.slice(),await alice.sign(L.textOf(m2.bodyBytes))),/belongs to another address/);
  step('moves and cancel',{moveWhileListed:'refused',cancelAfterExpiry:'accepted',recordSignedBeforeCancel:'refused',subaddressOwnerMoves:'accepted',formerOwner:'refused'});

  // 8. Result: who owns what, with the history of each Mordinal.
  const final=JSON.parse(JSON.stringify(L.toJSON()));
  assert.deepEqual(final.claimed.map(m=>[m.number,m.owner,m.history.join(' → ')]),[
   [0,bob.address,'claim → sale → sale'],[1,carol.address,'claim → sale'],[2,carol.address,'claim → move → move'],[3,carol.address,'claim → sale'],[4,market.address,'claim']]);
  const sizes={};for(const e of events.filter(e=>e.accepted)){const k=e.name.split(/[ :]/)[0];sizes[k]=Math.max(sizes[k]||0,e.record.length/2);}
  step('result',{accepted:events.filter(e=>e.accepted).length,refused:events.filter(e=>!e.accepted).length,largestRecordBytes:sizes,owners:final.claimed.map(m=>`#${m.number}: ${m.history.join(' → ')}`)});
  await writeFile(join(HERE,'fixtures.json'),JSON.stringify({about:'Records, payment transactions and expected results from tests/lab.test.mjs (wallet2 wallets on a local test chain). Public data only: no keys.',
   made:evidence.date.slice(0,10),network:'mainnet',domain:DOMAIN,feeAddress:fee.address,startHeight:start,rules:{...RULES,minPrice:RULES.minPrice.toString()},owners,events,final},null,1)+'\n');
  failed=false;evidence.result='PASSED';
 }finally{evidence.result??='FAILED';await writeFile(join(HERE,'..','lab-results.json'),JSON.stringify(evidence,null,1)+'\n');
  const children=[...Object.values(W),chain].filter(p=>p?.child).map(p=>p.child);
  await Promise.all(children.map(c=>new Promise(done=>{if(c.exitCode!==null)return done();c.once('exit',done);c.kill('SIGTERM');setTimeout(()=>{c.kill('SIGKILL');done();},15000).unref();})));
  if(!failed)await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:500});else console.error('lab kept at '+dir);}
});
