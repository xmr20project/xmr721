// Offline tests of the draft rules with made-up keys and transactions: node --test tests/rules.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createLedger} from '../lib/ledger.mjs';
import {OP,PROOF,RULES,TX_EXTRA_LIMIT,encodeBody,decodeRecord,amounts,formatXmr,parseXmr,recordId,codeOf} from '../lib/records.mjs';
import {outputSecret,signWithOutputKey,verifyOutputKeySignature,claimKeyHash,findMine,parseInProof,formatInProof,verifyInProof,ownsOutput,derivation,inProofFromViewKey,findWithViewKey} from '../lib/claim.mjs';
import {hex,unhex,concat,le,leBytes,Hs,encodeAddress,decodeAddress,parseSignature} from '../lib/monero.mjs';
import {ed25519} from '@noble/curves/ed25519';
import {paymentMessage,makeOutProof,verifyOutProof,provePayments,checkPayment,checkPaymentProof} from '../lib/payment.mjs';
import {keccak_256} from '@noble/hashes/sha3';
import {wallet,makeTx,ownerEntry,makeInProof,fact,entry,entries,scalar,DOMAIN} from './helpers.mjs';
const XMR=10n**12n,G=ed25519.ExtendedPoint.BASE,L=ed25519.CURVE.n;
const varint0=Uint8Array.of(0);

function world(){
 const w=Object.fromEntries(['alice','bob','carol','dave','eve','fee','market'].map(n=>[n,wallet(n)]));
 const txs=[
  makeTx('m0',[{to:w.alice,amount:10n**9n},{to:w.alice,amount:5n*XMR}]),                       // #0 alice, inscribed by herself
  makeTx('m1',[{to:w.alice.sub(3),amount:10n**9n},{to:w.dave,amount:XMR}],{subaddressKey:true}), // #1 alice's subaddress 3
  makeTx('m2',[{to:w.bob,amount:10n**9n},{to:w.bob,amount:XMR}]),                               // #2 bob
  makeTx('m3',[{to:w.bob.sub(1),amount:10n**9n},{to:w.dave,amount:XMR}],{subaddressKey:true}),   // #3 bob's subaddress 1
  makeTx('m4',[{to:w.dave,amount:XMR},{to:w.bob,amount:10n**9n}]),                              // #4 output 0 is dave's, bob only has output 1
  makeTx('m5',[{to:w.carol,amount:10n**9n},{to:w.dave,amount:XMR}]),                            // #5 carol, moved before the start block
 ];
 const owners=txs.map((t,i)=>ownerEntry(i,t,i===5?hex(leBytes(scalar('registration 5'))):t.txid));
 for(let i=6;i<40;i++)owners.push(ownerEntry(i,makeTx('filler'+i,[{to:wallet('stranger'+i),amount:10n**9n}])));
 const l=createLedger({domain:DOMAIN,feeAddress:w.fee.address,owners,height:100});
 const by=new Map(Object.values(w).map(x=>[x.address,x]));
 const key=(n,holder)=>outputSecret({viewSecret:holder.viewSecret,spendSecret:holder.spendSecret,txPub:owners[n].ownerTxPubKeys[0],subScalar:holder.subScalar});
 const claim0=(n,holder,to=holder)=>{const p=l.prepareClaim({mordinal:n,to:to.address});return l.claimWithKey(p.bodyBytes,signWithOutputKey(p.keyHash,key(n,holder)));};
 const claim1=(n,holder,to=holder,proof=makeInProof({txid:owners[n].ownerTx,txPub:owners[n].ownerTxPubKeys[0],holder}))=>{
  const p=l.prepareClaim({mordinal:n,to:to.address,holder:holder.address});return l.claimWithProof(p.bodyBytes,proof,holder.sign(p.text));};
 // A signed record straight from a body, for records the prepare functions would not offer.
 const raw=(op,body,signer)=>{const b=encodeBody(op,body);return l.sign(b,signer.sign(l.textOf(b)));};
 const list=(n,seller,price,until=l.height+500)=>{const p=l.prepareList({mordinal:n,seller:seller.address,price,until});l.apply(l.sign(p.bodyBytes,seller.sign(p.text)));return p.id;};
 const reserve=(lot,buyer,o={})=>{const p=l.prepareReserve({lot,buyer:buyer.address,...o});l.apply(l.sign(p.bodyBytes,buyer.sign(p.text)));return p;};
 const payment=(label,pays,extra=[])=>makeTx(label,[...pays.map(x=>({to:by.get(x.to),amount:x.amount})),...extra]);
 // What the latest reservation on a listing asks for.
 const linesFor=lot=>{const x=l.lot(lot),r=x.reservations.at(-1);
  return [{to:x.seller,amount:BigInt(r.seller),what:'seller'},{to:w.fee.address,amount:BigInt(r.protocol),what:'protocol fee'},...(r.rate?[{to:r.market,amount:BigInt(r.marketPay),what:'marketplace fee'}]:[])];};
 // What a wallet does: find its payments with the transaction keys and make a proof for each payee.
 const prove=(lot,txs)=>provePayments({lines:linesFor(lot),payments:txs.map(t=>({txid:t.txid,tx:t.tx,txKey:t.keys.join('')})),domain:DOMAIN,lot});
 // The same record without a wallet's checks, so the ledger is what judges the transaction.
 const record=(lot,txs,o)=>l.buyRecord({lot,payments:entries(linesFor(lot),txs,lot,o)});
 const buy=(lot,txs,h=l.height)=>l.apply(record(lot,txs),txs.map(t=>fact(t,h)));
 return {w,l,owners,txs,key,claim0,claim1,raw,list,reserve,payment,buy,prove,record,linesFor};}

test('amounts and text helpers',()=>{
 assert.equal(formatXmr(1900000000001n),'1.900000000001');assert.equal(parseXmr('0.5'),5n*10n**11n);
 const code='000f423f'+'0'.repeat(24);                       // 0x000f423f = 999,999 → tail 1
 assert.deepEqual(amounts({price:2n*XMR,code}),{tail:1n,fee:10n**11n,marketFee:0n,seller:19n*10n**11n+1n,protocol:10n**11n+1n,market:0n});
 const a=amounts({price:1000000000019n,rate:250,code:'ffffffff'+'0'.repeat(24)});
 assert.equal(a.fee,50000000000n);assert.equal(a.marketFee,25000000000n);              // rounded down to the piconero
 assert.equal(a.seller+a.protocol,1000000000019n+2n*a.tail);assert.equal(a.market,a.marketFee+a.tail);
 assert.ok(a.tail>=1n&&a.tail<=999999n);});

test('records decode strictly and fit a Monero transaction',()=>{
 const {w,l,claim0,claim1,owners}=world(),sizes={};
 const c0=claim0(0,w.alice),c1=claim1(2,w.bob);sizes.claimOneTimeKey=c0.length;sizes.claimPaymentProof=c1.length;
 for(const r of [c0,c1]){assert.equal(decodeRecord(r).op,OP.claim);
  assert.throws(()=>decodeRecord(concat(r,Uint8Array.of(0))),/extra bytes/);assert.throws(()=>decodeRecord(r.slice(0,-1)),/truncated/);}
 assert.throws(()=>decodeRecord(Uint8Array.of(0x4d,0x44,0x31,0xfe,10)),/Unknown operation/);
 assert.throws(()=>decodeRecord(Uint8Array.of(0x58,0x54,0x31,0xfe,1)),/Not an MD1 record/);
 const bad=c0.slice();bad[5+64+65]=2;assert.throws(()=>decodeRecord(bad),/Unknown proof kind/);
 l.apply(c0);l.apply(c1);
 const m=l.prepareMove({mordinal:0,from:w.alice.address,to:w.carol.address}),mr=l.sign(m.bodyBytes,w.alice.sign(m.text+'\n'));sizes.move=mr.length;
 assert.equal(decodeRecord(mr).proof.variant,1);                                        // a wallet that adds a line break still verifies
 const v3=mr.slice();v3[m.bodyBytes.length]=3;assert.throws(()=>decodeRecord(v3),/Unknown text ending/);
 const p=l.prepareList({mordinal:2,seller:w.bob.address,price:XMR}),lr=l.sign(p.bodyBytes,w.bob.sign(p.text));sizes.list=lr.length;l.apply(lr);
 const r=l.prepareReserve({lot:p.id,buyer:w.carol.address,market:w.market.address,rate:100});sizes.reserveWithMarketplace=l.sign(r.bodyBytes,w.carol.sign(r.text)).length;
 const c=l.prepareCancel({lot:p.id,seller:w.bob.address});sizes.cancel=l.sign(c.bodyBytes,w.bob.sign(c.text)).length;
 const k='11'.repeat(32),t=i=>String(i).repeat(64),e=i=>({txid:t(i),out:i,D:k,c:k,s:k}),bought=n=>l.buyRecord({lot:p.id,payments:[1,2,3,4].slice(0,n).map(e)});
 sizes.buyTwoPayees=bought(2).length;sizes.buyThreePayees=bought(3).length;
 assert.deepEqual(decodeRecord(bought(3)).body,{lot:p.id,payments:[e(1),e(2),e(3)]});
 assert.throws(()=>bought(1),/2 or 3 payments/);assert.throws(()=>bought(4),/2 or 3 payments/);
 assert.throws(()=>l.buyRecord({lot:p.id,payments:[e(1),{...e(2),out:256}]}),/Output number required/);
 assert.throws(()=>l.buyRecord({lot:p.id,payments:[e(1),{...e(2),D:k.slice(2)}]}),/Payment proof/);
 assert.throws(()=>decodeRecord(bought(2).slice(0,-32)),/truncated/);
 const one=bought(2).slice(0,38+129);one[37]=1;assert.throws(()=>decodeRecord(one),/2 or 3 payments/);
 // One transaction may pay two payees; one output cannot be named twice.
 assert.equal(decodeRecord(l.buyRecord({lot:p.id,payments:[e(1),{...e(1),out:2}]})).body.payments.length,2);
 assert.throws(()=>decodeRecord(l.buyRecord({lot:p.id,payments:[e(1),e(1)]})),/payment output appears twice/);
 for(const [name,n] of Object.entries(sizes))assert.ok(n<=TX_EXTRA_LIMIT-60,`${name} is ${n} bytes`);
 assert.deepEqual(sizes,{claimOneTimeKey:199,claimPaymentProof:361,move:236,list:183,reserveWithMarketplace:238,cancel:167,buyTwoPayees:296,buyThreePayees:425});});

test('claim with the one-time key of the owner coin',()=>{
 const {w,l,owners,key,claim0}=world();
 // The key really is the secret of output 0, for a main address and for a subaddress.
 assert.equal(hex(G.multiply(key(0,w.alice)).toRawBytes()),owners[0].ownerOutputKey);
 assert.equal(hex(G.multiply(key(1,w.alice.sub(3))).toRawBytes()),owners[1].ownerOutputKey);
 const p=l.prepareClaim({mordinal:0,to:w.alice.address});assert.equal(p.text,null);
 // Refused: another wallet's key, a signature moved onto another receiving address, another ledger, a wrong owner transaction.
 assert.throws(()=>l.check(l.claimWithKey(p.bodyBytes,signWithOutputKey(p.keyHash,key(0,w.eve)))),/not made with the key of the owner coin/);
 const good=signWithOutputKey(p.keyHash,key(0,w.alice)),stolen=l.prepareClaim({mordinal:0,to:w.eve.address});
 assert.throws(()=>l.check(l.claimWithKey(stolen.bodyBytes,good)),/not made with the key of the owner coin/);
 assert.equal(verifyOutputKeySignature(claimKeyHash('00'.repeat(32),p.bodyBytes),owners[0].ownerOutputKey,good.c,good.r),false);
 assert.throws(()=>l.check(concat(encodeBody(OP.claim,{reg:owners[0].registrationTx,ownerTx:owners[2].ownerTx,to:w.alice.address,proof:PROOF.outputKey}),good.c,good.r)),/not the owner transaction/);
 assert.throws(()=>l.prepareClaim({mordinal:'ab'.repeat(32),to:w.alice.address}),/not a Mordinal on the owner list/);
 assert.throws(()=>l.check(claim0(4,w.bob)),/not made with the key/);                     // bob only received output 1
 const r=l.claimWithKey(p.bodyBytes,good);assert.deepEqual(l.apply(r),{id:p.id,number:0,owner:w.alice.address});
 assert.throws(()=>l.apply(r),/already on the ledger/);assert.throws(()=>l.check(claim0(0,w.alice,w.carol)),/already claimed/);
 // A subaddress holder can send the Mordinal to any address in the same step; a moved Mordinal is claimed through its latest owner coin.
 l.apply(claim0(1,w.alice.sub(3),w.alice));assert.deepEqual(l.owned(w.alice.address),[0,1]);
 l.apply(claim0(5,w.carol));assert.equal(l.mordinal(5).reg,owners[5].registrationTx);assert.notEqual(owners[5].registrationTx,owners[5].ownerTx);
 assert.deepEqual(l.mordinal(1).history.map(h=>[h.what,h.proof]),[['claim','one-time key']]);});

test('claim with a wallet payment proof and a signed message',()=>{
 const {w,l,owners,claim1}=world(),o=owners[2],proof=makeInProof({txid:o.ownerTx,txPub:o.ownerTxPubKeys[0],holder:w.bob});
 const p=l.prepareClaim({mordinal:2,to:w.carol.address,holder:w.bob.address});
 assert.match(p.text,/^Mordinals claim: Mordinal #2 \(inscription [0-9a-f]{64}\), held by output 0 of [0-9a-f]{64}, now belongs to 4\w{94}; code [0-9a-f]{32}$/);
 assert.equal(proof.length,141);
 // Proof alone is not enough: it needs only the view key. The message must be signed with the spend key of the same address.
 assert.throws(()=>l.claimWithProof(p.bodyBytes,proof,w.bob.signView(p.text)),/not for this text and address/);
 assert.throws(()=>l.claimWithProof(p.bodyBytes,proof,w.eve.sign(p.text)),/not for this text and address/);
 const vs=parseSignature(w.bob.signView(p.text)),{D,c,r}=parseInProof(proof);                  // a record built by hand around a view-key signature
 assert.throws(()=>l.check(concat(p.bodyBytes,D,c,r,Uint8Array.of(0),vs.c,vs.r)),/signature does not match/);
 // Refused proofs.
 assert.throws(()=>l.check(l.claimWithProof(p.bodyBytes,makeInProof({txid:o.ownerTx,txPub:o.ownerTxPubKeys[0],holder:w.bob,message:p.text}),w.bob.sign(p.text))),/empty message/);
 const t=parseInProof(proof);t.r=leBytes((le(t.r)+1n)%L);assert.throws(()=>l.check(l.claimWithProof(p.bodyBytes,formatInProof(t),w.bob.sign(p.text))),/payment proof is not valid/);
 assert.throws(()=>l.check(l.claimWithProof(p.bodyBytes,makeInProof({txid:owners[3].ownerTx,txPub:o.ownerTxPubKeys[0],holder:w.bob}),w.bob.sign(p.text))),/payment proof is not valid/);
 assert.throws(()=>parseInProof('OutProofV2'+proof.slice(9)),/OutProof/);assert.throws(()=>parseInProof('InProofV1'+proof.slice(9)),/InProofV1/);
 assert.throws(()=>parseInProof('ReserveProofV2abc'),/never accepted/);assert.throws(()=>parseInProof(proof+proof.slice(9)),/more than one transaction key/);
 // bob received output 1 of #4, not output 0: his proof is valid for the transaction but he does not hold the Mordinal.
 assert.throws(()=>l.check(claim1(4,w.bob)),/did not receive output 0/);
 // Someone with only bob's view key can make the proof but not the signature.
 const spy=l.prepareClaim({mordinal:2,to:w.eve.address,holder:w.bob.address});
 assert.throws(()=>l.claimWithProof(spy.bodyBytes,proof,w.eve.sign(spy.text)),/not for this text and address/);
 // An invented address that fits the owner coin: its proof passes, but nobody can sign for it.
 const a2=scalar('eve second view'),D2=ed25519.ExtendedPoint.fromHex(o.ownerTxPubKeys[0]).multiply(a2),s2=Hs(concat(D2.multiply(8n).toRawBytes(),varint0));
 const fakeSpend=ed25519.ExtendedPoint.fromHex(o.ownerOutputKey).subtract(G.multiply(s2)).toRawBytes(),fakeView=G.multiply(a2).toRawBytes();
 const fake={kind:'main',spend:fakeSpend,view:fakeView,address:encodeAddress({spend:fakeSpend,view:fakeView}),viewSecret:leBytes(a2)};
 const fp=makeInProof({txid:o.ownerTx,txPub:o.ownerTxPubKeys[0],holder:fake}),pf=parseInProof(fp);
 assert.equal(verifyInProof({txid:o.ownerTx,txPub:o.ownerTxPubKeys[0],address:decodeAddress(fake.address),...pf}),true);
 assert.equal(ownsOutput({D:pf.D,spend:fakeSpend,outputKey:o.ownerOutputKey}),true);
 const fb=l.prepareClaim({mordinal:2,to:w.eve.address,holder:fake.address});
 assert.throws(()=>l.claimWithProof(fb.bodyBytes,fp,w.eve.sign(fb.text)),/not for this text and address/);
 // Accepted: main address, and a subaddress holder.
 assert.equal(l.apply(l.claimWithProof(p.bodyBytes,proof,w.bob.sign(p.text+'\r\n'))).owner,w.carol.address);
 assert.equal(l.apply(claim1(3,w.bob.sub(1))).owner,w.bob.sub(1).address);
 assert.equal(l.mordinal(3).history[0].proof,'payment proof and message');
 assert.throws(()=>l.check(claim1(2,w.bob)),/already claimed/);});
test('a wallet finds its own Mordinals in the public owner list, locally',()=>{
 const {w,owners}=world(),spends=w=>new Map([[hex(w.spend),'main'],...[1,2,3,4].map(i=>[hex(w.sub(i).spend),'subaddress '+i])]);
 assert.deepEqual(findMine(owners,{viewSecret:w.alice.viewSecret,spends:spends(w.alice)}).map(m=>[m.entry.number,m.at]),[[0,'main'],[1,'subaddress 3']]);
 assert.deepEqual(findMine(owners,{viewSecret:w.bob.viewSecret,spends:spends(w.bob)}).map(m=>m.entry.number),[2,3]);
 assert.deepEqual(findMine(owners,{viewSecret:w.eve.viewSecret,spends:spends(w.eve)}),[]);});

test('moves are signed by the owner and cannot be replayed',()=>{
 const {w,l,claim0,raw,list,reserve,payment,buy}=world();l.apply(claim0(0,w.alice));
 assert.throws(()=>l.prepareMove({mordinal:2,from:w.bob.address,to:w.carol.address}),/not been claimed/);
 assert.throws(()=>l.prepareMove({mordinal:0,from:w.bob.address,to:w.carol.address}),/belongs to another address/);
 assert.throws(()=>l.check(raw(OP.move,{reg:l.mordinal(0).reg,seq:0,from:w.bob.address,to:w.carol.address},w.bob)),/belongs to another address/);
 assert.throws(()=>l.check(raw(OP.move,{reg:l.mordinal(0).reg,seq:0,from:w.alice.address,to:w.alice.address},w.alice)),/already owns/);
 const m=l.prepareMove({mordinal:0,from:w.alice.address,to:w.bob.address});
 assert.throws(()=>l.sign(m.bodyBytes,w.alice.signView(m.text)),/not for this text and address/);
 assert.throws(()=>l.sign(m.bodyBytes,w.bob.sign(m.text)),/not for this text and address/);
 const unposted=l.sign(m.bodyBytes,w.alice.sign(m.text));                                // signed, kept back
 const cheap=l.prepareList({mordinal:0,seller:w.alice.address,price:10n**9n,until:5000}),unpostedList=l.sign(cheap.bodyBytes,w.alice.sign(cheap.text));
 // alice sells to carol, carol sends it back.
 l.setHeight(101);const lot=list(0,w.alice,XMR);l.setHeight(102);const r=reserve(lot,w.carol);l.setHeight(103);buy(lot,[payment('p',r.pay)]);
 const back=l.prepareMove({mordinal:0,from:w.carol.address,to:w.alice.address});l.setHeight(104);
 assert.deepEqual(l.apply(l.sign(back.bodyBytes,w.carol.sign(back.text))),{id:back.id,number:0,owner:w.alice.address});
 // alice owns it again, but what she signed before the sale no longer works.
 assert.throws(()=>l.check(unposted),/earlier state/);assert.throws(()=>l.check(unpostedList),/earlier state/);
 assert.deepEqual(l.mordinal(0).history.map(h=>h.what),['claim','sale','move']);assert.equal(l.mordinal(0).seq,2);});

test('sale: one payment transaction pays the seller 95% and the fee address 5%',()=>{
 const {w,l,claim0,raw,list,reserve,payment,buy,prove,record,linesFor}=world();l.apply(claim0(0,w.alice));l.setHeight(101);
 assert.throws(()=>l.prepareList({mordinal:0,seller:w.bob.address,price:XMR}),/belongs to another address/);
 assert.throws(()=>l.check(raw(OP.list,{reg:l.mordinal(0).reg,seq:0,until:600,price:10n**9n-1n,seller:w.alice.address},w.alice)),/lowest price is 0.001 XMR/);
 assert.throws(()=>l.check(raw(OP.list,{reg:l.mordinal(0).reg,seq:0,until:100,price:XMR,seller:w.alice.address},w.alice)),/listing expired/);
 const p=l.prepareList({mordinal:0,seller:w.alice.address,price:2n*XMR,until:601});
 assert.match(p.text,/^Mordinals list: sell Mordinal #0 for 2 XMR \(1\.9 XMR to 4\w{94}, 0\.1 XMR protocol fee\); valid until block 601; code [0-9a-f]{32}$/);
 assert.throws(()=>l.sign(p.bodyBytes,w.alice.signView(p.text)),/not for this text and address/);
 const lot=l.apply(l.sign(p.bodyBytes,w.alice.sign(p.text))).lot;assert.equal(lot,p.id);
 assert.throws(()=>list(0,w.alice,3n*XMR),/listed for sale; cancel the listing first/);
 l.setHeight(102);
 assert.throws(()=>reserve(lot,w.alice),/seller cannot reserve/);
 assert.throws(()=>l.check(raw(OP.reserve,{lot,payBy:133,buyer:w.carol.address,rate:0},w.carol)),/at most 30 blocks/);
 assert.throws(()=>l.check(raw(OP.reserve,{lot,payBy:102,buyer:w.carol.address,rate:0},w.carol)),/ran out before it was posted/);
 const r=reserve(lot,w.carol);
 assert.match(r.text,/^Mordinals reserve: buy Mordinal #0 for 2 XMR; pay exactly 1\.9\d{11} XMR to 4\w{94} and exactly 0\.1\d{11} XMR to 4\w{94} by block 132; Mordinal to 4\w{94}; code [0-9a-f]{32}$/);
 const tail=amounts({price:2n*XMR,code:r.code}).tail;
 assert.deepEqual(r.pay,[{to:w.alice.address,amount:19n*10n**11n+tail,what:'seller'},{to:w.fee.address,amount:10n**11n+tail,what:'protocol fee'}]);
 assert.throws(()=>reserve(lot,w.dave),/reserved by someone else until block 142/);
 const c=l.prepareCancel({lot,seller:w.alice.address});assert.throws(()=>l.check(l.sign(c.bodyBytes,w.alice.sign(c.text))),/reserved until block 142; it can be cancelled after that/);
 assert.throws(()=>l.check(raw(OP.move,{reg:l.mordinal(0).reg,seq:0,from:w.alice.address,to:w.bob.address},w.alice)),/listed for sale/);
 l.setHeight(103);
 const change=[{to:w.carol,amount:7n*XMR}],good=payment('t1',r.pay,change),rec=record(lot,[good]);
 // Refused payments.
 assert.throws(()=>l.check(rec),/not looked up/);
 assert.throws(()=>l.check(rec,[fact(good,null)]),/not in a block yet/);
 assert.throws(()=>l.check(rec,[fact(good,104)]),/in a block after this record/);
 assert.throws(()=>l.check(rec,[fact(good,101)]),/made before the reservation/);
 const noTail=payment('t1a',[{to:w.alice.address,amount:19n*10n**11n},{to:w.fee.address,amount:10n**11n}]);
 // Each is refused twice: by the wallet when it makes the record, and by the ledger when a record is made anyway.
 assert.throws(()=>prove(lot,[noTail]),/seller payment is 1\.9 XMR; this reservation needs exactly 1\.9\d{11} XMR in one piece/);
 assert.throws(()=>buy(lot,[noTail]),/seller payment is 1\.9 XMR; this reservation needs exactly 1\.9\d{11} XMR\./);
 const noFee=payment('t1b',[r.pay[0]]);assert.throws(()=>prove(lot,[noFee]),/protocol fee payment is missing; this reservation needs exactly 0\.1\d{11} XMR/);
 assert.throws(()=>buy(lot,[noFee]),/2 or 3 payments/);
 const all=payment('t1c',[{to:w.alice.address,amount:2n*XMR+2n*tail}]);assert.throws(()=>prove(lot,[all]),/seller payment is 2\.\d{12} XMR/);
 const over=payment('t1d',[r.pay[0],{to:w.fee.address,amount:r.pay[1].amount+1n}]);
 assert.throws(()=>prove(lot,[over]),/protocol fee payment is 0\.1\d{11} XMR; this reservation needs exactly/);
 assert.throws(()=>buy(lot,[over]),/protocol fee payment is 0\.1\d{11} XMR; this reservation needs exactly/);
 const wrong=hex(leBytes(scalar('wrong key')));
 assert.throws(()=>provePayments({lines:linesFor(lot),payments:[{txid:good.txid,tx:good.tx,txKey:wrong}],domain:DOMAIN,lot}),/pays nobody in this reservation with the key given/);
 assert.throws(()=>l.check(record(lot,[good],{secret:scalar('wrong key')}),[fact(good,103)]),/proof for the seller payment does not fit this transaction, listing and address/);
 // The wallet's record names the two outputs and carries no transaction key.
 const mine=prove(lot,[good]);assert.deepEqual(mine.map(x=>[x.txid,x.out]),[[good.txid,0],[good.txid,1]]);
 assert.ok(good.keys.every(k=>!hex(l.buyRecord({lot,payments:mine})).includes(k)));l.check(l.buyRecord({lot,payments:mine}),[fact(good,103)]);
 // Accepted.
 const done=buy(lot,[good]);assert.equal(done.owner,w.carol.address);
 assert.deepEqual(done.paid,{seller:(19n*10n**11n+tail).toString(),'protocol fee':(10n**11n+tail).toString()});
 assert.throws(()=>buy(lot,[payment('t1e',r.pay)]),/already sold/);
 const m=l.mordinal(0);assert.equal(m.owner,w.carol.address);assert.equal(m.seq,1);assert.equal(m.lot,null);
 assert.deepEqual(m.history.at(-1),{what:'sale',height:103,record:done.id,from:w.alice.address,to:w.carol.address,price:(2n*XMR).toString(),fee:(10n**11n).toString(),lot});
 // The same payment cannot buy anything else.
 l.setHeight(104);const lot2=list(0,w.carol,2n*XMR);l.setHeight(105);reserve(lot2,w.dave);
 assert.throws(()=>l.check(record(lot2,[good]),[fact(good,105)]),/already used for a sale/);});

test('sale with a marketplace fee, paid in three transactions',()=>{
 const {w,l,claim1,raw,list,reserve,payment,buy,prove,record}=world();l.apply(claim1(2,w.bob));l.setHeight(101);const lot=list(2,w.bob,XMR/2n);l.setHeight(102);
 const body=(rate,market)=>({lot,payBy:120,buyer:w.dave.address,rate,market:market.address});
 assert.throws(()=>l.check(raw(OP.reserve,body(501,w.market),w.dave)),/marketplace fee is at most 5%/);
 assert.throws(()=>l.check(raw(OP.reserve,body(250,w.bob),w.dave)),/must differ from the seller and the protocol fee address/);
 assert.throws(()=>l.check(raw(OP.reserve,body(250,w.fee),w.dave)),/must differ from the seller and the protocol fee address/);
 assert.throws(()=>encodeBody(OP.reserve,{lot,payBy:120,buyer:w.dave.address,rate:0,market:w.market.address}),/needs a rate/);
 const r=reserve(lot,w.dave,{market:w.market.address,rate:250}),t=amounts({price:XMR/2n,rate:250,code:r.code}).tail;
 assert.match(r.text,/ and exactly 0\.0125\d{8} XMR to 4\w{94} by block 132; Mordinal to /);
 assert.deepEqual(r.pay.map(x=>[x.what,x.amount]),[['seller',475000000000n+t],['protocol fee',25000000000n+t],['marketplace fee',12500000000n+t]]);
 l.setHeight(103);const first=payment('t2a',[r.pay[0]]);
 assert.throws(()=>prove(lot,[first]),/protocol fee payment is missing/);
 l.setHeight(104);const second=payment('t2b',[r.pay[1]]);assert.throws(()=>prove(lot,[first,second]),/marketplace fee payment is missing/);
 assert.throws(()=>l.check(record(lot,[first,second]),[fact(first,103),fact(second,104)]),/marketplace fee payment is missing/);
 l.setHeight(105);const third=payment('t2c',[r.pay[2]]);
 // The order the payments are given in does not matter: the record lists the payees in the reservation's order.
 const mine=prove(lot,[third,first,second]);assert.deepEqual(mine.map(x=>x.txid),[first.txid,second.txid,third.txid]);
 const done=l.apply(l.buyRecord({lot,payments:mine}),[fact(first,103),fact(second,104),fact(third,105)]);
 assert.equal(done.owner,w.dave.address);assert.equal(done.paid['marketplace fee'],(12500000000n+t).toString());});

test('a reservation that ran out: it holds the listing 10 more blocks, then the next reservation wins',()=>{
 const {w,l,claim0,claim1,list,reserve,payment,buy}=world();l.apply(claim0(0,w.alice));l.apply(claim1(2,w.bob));l.setHeight(101);
 const a=list(0,w.alice,XMR),b=list(2,w.bob,XMR);l.setHeight(102);const ra=reserve(a,w.carol),rb=reserve(b,w.carol);
 // Both ran out at 132 and hold their listing until 142: a payment made in time can still be recorded, nobody else can reserve.
 l.setHeight(140);assert.throws(()=>reserve(b,w.dave),/reserved by someone else until block 142/);
 l.setHeight(143);
 // Listing a: nobody else reserved, so carol's late payment still buys it.
 assert.equal(buy(a,[payment('late-a',ra.pay)]).owner,w.carol.address);
 // Listing b: dave reserved after carol's ran out. carol's late payment no longer fits; dave's does.
 const rd=reserve(b,w.dave);l.setHeight(144);
 assert.notEqual(rd.pay[0].amount,rb.pay[0].amount);
 assert.throws(()=>buy(b,[payment('late-b',rb.pay)]),/seller payment is .* this reservation needs exactly/);
 assert.equal(buy(b,[payment('dave-b',rd.pay)]).owner,w.dave.address);});

test('cancel, expiry and listing again',()=>{
 const {w,l,claim0,raw,list,reserve,payment,buy,prove,record,linesFor}=world();l.apply(claim0(0,w.alice));l.setHeight(101);
 const first=list(0,w.alice,XMR,106);
 const c=l.prepareCancel({lot:first,seller:w.bob.address});assert.throws(()=>l.check(l.sign(c.bodyBytes,w.bob.sign(c.text))),/Only the seller can cancel/);
 l.setHeight(102);const r=reserve(first,w.carol,{window:3});assert.equal(r.bodyBytes.length>0&&l.lot(first).reservations[0].payBy,105);
 assert.throws(()=>l.check(raw(OP.reserve,{lot:first,payBy:107,buyer:w.dave.address,rate:0},w.dave)),/reserved by someone else/);
 l.setHeight(107);                                                                      // reservation ran out at 105, listing at 106
 assert.throws(()=>reserve(first,w.dave),/listing has expired/);
 assert.throws(()=>l.check(raw(OP.move,{reg:l.mordinal(0).reg,seq:0,from:w.alice.address,to:w.bob.address},w.alice)),/cancel the listing first/);
 const cancel=l.prepareCancel({lot:first,seller:w.alice.address});
 assert.throws(()=>l.check(l.sign(cancel.bodyBytes,w.alice.sign(cancel.text))),/reserved until block 115/);
 l.setHeight(116);
 assert.match(cancel.text,/^Mordinals cancel: stop selling Mordinal #0; listing [0-9a-f]{32}; code [0-9a-f]{32}$/);
 l.apply(l.sign(cancel.bodyBytes,w.alice.sign(cancel.text)));
 assert.throws(()=>buy(first,[payment('after-cancel',r.pay)]),/listing was cancelled/);
 assert.throws(()=>reserve(first,w.dave),/listing was cancelled/);
 // Same terms again: a new listing with its own id.
 const again=list(0,w.alice,XMR,116+500);assert.notEqual(again,first);
 l.setHeight(117);assert.throws(()=>l.check(raw(OP.reserve,{lot:again,payBy:118,buyer:w.dave.address,rate:0},w.eve)),/signature is not for this text|not for this text and address/);
 const rr=reserve(again,w.dave);l.setHeight(118);assert.equal(buy(again,[payment('again',rr.pay)]).owner,w.dave.address);
 assert.deepEqual(l.toJSON().lots.map(x=>[x.status,x.reservations]),[['cancelled',1],['sold',1]]);});

test('a payment counts only if the payee\'s wallet finds it as one spendable coin',()=>{
 const {w,l,claim0,list,reserve,payment,buy,prove}=world();l.apply(claim0(0,w.alice));l.setHeight(101);const lot=list(0,w.alice,XMR);l.setHeight(102);const r=reserve(lot,w.carol);l.setHeight(103);
 const made=(label,tamper,pays=r.pay)=>makeTx(label,pays.map(x=>({to:x.to===w.alice.address?w.alice:w.fee,amount:x.amount})),{tamper});
 const other=hex(G.multiply(scalar('some other key')).toRawBytes());
 const unfit=/proof for the seller payment does not fit this transaction/,unfound=/does not carry the public key its wallet needs/;
 const cases=[['locked',tx=>{tx.unlock_time=500;},/lock time does not count/],
  ['no key',tx=>{tx.extra=[];},unfound],['key after padding',tx=>{tx.extra=[0,...tx.extra];},unfound],['odd extra',tx=>{tx.extra=[1,2,3];},unfound],
  // Another public key where the wallet looks: the proof is for the key that made the output, which the transaction does not carry.
  ['other key',tx=>{tx.extra=[1,...unhex(other)];},unfit,unfound],['second key',tx=>{tx.extra=[1,...unhex(other),...tx.extra];},unfit,unfound],
  ['tag',tx=>{const t=tx.vout[0].target.tagged_key;t.view_tag=(parseInt(t.view_tag,16)^1).toString(16).padStart(2,'0');},/view tag is wrong/]];
 // Refused by the ledger, and by the wallet before it makes a record.
 for(const [label,tamper,error,walletError=error] of cases){const t=made(label,tamper);assert.throws(()=>buy(lot,[t]),error,label);assert.throws(()=>prove(lot,[t]),walletError,label);}
 // One payee, two coins: refused even when the sum is exact. A record can only name one of them.
 const half=r.pay[0].amount/2n,parts=made('parts',null,[{to:w.alice.address,amount:half},{to:w.alice.address,amount:r.pay[0].amount-half},r.pay[1]]);
 assert.throws(()=>prove(lot,[parts]),/seller payment is .* in several parts; this reservation needs exactly/);
 assert.throws(()=>buy(lot,[parts]),/seller payment is 0\.\d+ XMR; this reservation needs exactly/);
 // A record names one output for each payee and nothing else is looked at: an output that pays another payee, an output
 // the transaction does not have, and a payment that pays nobody.
 const good=made('good'),again=made('seller again',null,[r.pay[0]]),stranger=makeTx('stranger',[{to:w.eve,amount:XMR}]),facts=[fact(good,103),fact(again,103)];
 assert.throws(()=>l.check(l.buyRecord({lot,payments:[entry(good,0,lot),entry(again,0,lot,{to:w.fee})]}),facts),/Output 0 of the protocol fee payment does not pay the protocol fee address/);
 assert.throws(()=>l.check(l.buyRecord({lot,payments:[entry(good,1,lot,{to:w.alice}),entry(good,0,lot,{to:w.fee})]}),facts),/Output 1 of the seller payment does not pay the seller's address/);
 assert.throws(()=>l.check(l.buyRecord({lot,payments:[entry(good,0,lot),{...entry(good,1,lot),out:9}]}),facts),/names output 9, which its transaction does not have/);
 assert.throws(()=>l.check(l.buyRecord({lot,payments:[entry(good,0,lot),entry(good,0,lot)]}),facts),/payment output appears twice/);
 assert.throws(()=>l.check(l.buyRecord({lot,payments:[entry(good,0,lot),entry(good,1,lot),entry(again,0,lot)]}),facts),/names 3 payments; this reservation has 2 payees/);
 assert.throws(()=>prove(lot,[good,stranger]),/pays nobody in this reservation with the key given/);
 // A nonce before nothing else is fine: the key still comes first among the keys.
 const nonce=made('with nonce',tx=>{tx.extra=[...tx.extra,2,9,1,1,2,3,4,5,6,7,8];});
 assert.equal(buy(lot,[nonce]).owner,w.carol.address);});

test('a seller at a subaddress is paid with the extra transaction keys',()=>{
 const {w,l,claim0,list,reserve,prove,record,linesFor}=world(),sub=w.alice.sub(3);l.apply(claim0(1,sub));l.setHeight(101);const lot=list(1,sub,XMR);l.setHeight(102);const r=reserve(lot,w.carol);l.setHeight(103);
 assert.equal(r.pay[0].to,sub.address);
 const outs=[{to:sub,amount:r.pay[0].amount},{to:w.fee,amount:r.pay[1].amount},{to:w.carol,amount:3n*XMR}];
 const send=(label,tamper)=>{const t=makeTx(label,outs,{tamper});return ()=>l.check(record(lot,[t]),[fact(t,103)]);};
 const good=makeTx('sub good',outs);assert.equal(good.keys.length,4,'the main key and one key per output');
 // Only the main key: the fee address is found, the subaddress is not. A proof made with the main key does not count either.
 assert.throws(()=>provePayments({lines:linesFor(lot),payments:[{txid:good.txid,tx:good.tx,txKey:good.keys[0]}],domain:DOMAIN,lot}),/seller payment is missing/);
 const unfit=/proof for the seller payment does not fit this transaction/;
 assert.throws(()=>l.check(l.buyRecord({lot,payments:[entry(good,0,lot,{secret:good.outs[1].secret}),entry(good,1,lot)]}),[fact(good,103)]),unfit);
 // The transaction must carry one extra public key per output, each made for its own receiver.
 assert.throws(send('sub short',tx=>{const at=tx.extra.indexOf(4,33);tx.extra=[...tx.extra.slice(0,at),4,2,...tx.extra.slice(at+2,at+2+64)];}),unfit);
 assert.throws(send('sub none',tx=>{tx.extra=tx.extra.slice(0,33);}),unfit);
 assert.throws(send('sub base',tx=>{const k=scalar('sub base txkey 0');tx.extra.splice(35,32,...G.multiply(k).toRawBytes());}),unfit);
 // The seller's entry is proved with the extra key of its output, the fee address's with the main key.
 const mine=prove(lot,[good]);assert.deepEqual(mine.map(x=>x.out),[0,1]);
 const [forSub,forFee]=mine.map((x,i)=>keys=>keys.some(txPub=>verifyOutProof({...x,txPub,address:decodeAddress(linesFor(lot)[i].to),message:paymentMessage(DOMAIN,lot)})));
 const carried=[hex(good.tx.extra.slice(1,33)),hex(good.tx.extra.slice(35,67))];
 assert.deepEqual([forSub([carried[0]]),forSub([carried[1]]),forFee([carried[0]]),forFee([carried[1]])],[false,true,true,false]);
 assert.equal(l.apply(l.buyRecord({lot,payments:mine}),[fact(good,103)]).owner,w.carol.address);
 // A payment to the subaddress alone uses one key made for it (R = r·B); the fee goes in a second payment.
 l.setHeight(104);const lot3=(()=>{const p=l.prepareList({mordinal:1,seller:w.carol.address,price:XMR,until:l.height+500});l.apply(l.sign(p.bodyBytes,w.carol.sign(p.text)));return p.id;})();
 l.setHeight(105);const cancel=l.prepareCancel({lot:lot3,seller:w.carol.address});l.apply(l.sign(cancel.bodyBytes,w.carol.sign(cancel.text)));
 const moveBack=l.prepareMove({mordinal:1,from:w.carol.address,to:sub.address});l.apply(l.sign(moveBack.bodyBytes,w.carol.sign(moveBack.text)));
 l.setHeight(106);const lot4=list(1,sub,XMR);l.setHeight(107);const r4=reserve(lot4,w.dave);l.setHeight(108);
 const alone=makeTx('sub alone',[{to:sub,amount:r4.pay[0].amount}]),feeOnly=makeTx('fee alone',[{to:w.fee,amount:r4.pay[1].amount}]);
 assert.equal(alone.keys.length,1);assert.equal(alone.txPub,hex(ed25519.ExtendedPoint.fromHex(hex(sub.spend)).multiply(alone.outs[0].secret).toRawBytes()));
 assert.equal(l.apply(l.buyRecord({lot:lot4,payments:prove(lot4,[feeOnly,alone])}),[fact(alone,108),fact(feeOnly,108)]).owner,w.dave.address);
 l.setHeight(109);const list2=p=>{l.apply(l.sign(p.bodyBytes,w.dave.sign(p.text)));return p.id;},lot2=list2(l.prepareList({mordinal:1,seller:w.dave.address,price:XMR,until:l.height+500}));l.setHeight(110);
 // A subaddress can reserve too.
 const back=l.prepareReserve({lot:lot2,buyer:sub.address});l.apply(l.sign(back.bodyBytes,sub.sign(back.text)));
 assert.equal(l.lot(lot2).reservations[0].buyer,sub.address);});

test('one payment never buys twice: used coins, and two reservations waiting for the same amounts',()=>{
 const {w,l,claim0,raw,list,reserve,payment,buy}=world();l.apply(claim0(0,w.alice));l.apply(claim0(1,w.alice.sub(3),w.alice));l.setHeight(101);
 const a=list(0,w.alice,XMR),b=list(1,w.alice,XMR);l.setHeight(102);
 // Two reservations, one on each listing, whose codes give the same amounts (found by trying pay-by blocks and fee rates).
 const tailOf=(lot,buyer,payBy,rate)=>amounts({price:XMR,rate,code:codeOf(recordId(DOMAIN,encodeBody(OP.reserve,{lot,payBy,buyer:buyer.address,rate,market:rate?w.market.address:undefined})))}).tail;
 const seen=new Map();let pair=null;
 for(let rate=0;rate<50;rate++)for(let payBy=103;payBy<=132;payBy++)seen.set(tailOf(a,w.carol,payBy,rate),{payBy,rate});
 for(let rate=0;rate<=500&&!pair;rate++)for(let payBy=103;payBy<=132&&!pair;payBy++){const hit=seen.get(tailOf(b,w.dave,payBy,rate));if(hit)pair=[hit,{payBy,rate}];}
 assert.ok(pair,'two reservations with the same amounts exist');
 const body=(lot,buyer,x)=>({lot,payBy:x.payBy,buyer:buyer.address,rate:x.rate,market:x.rate?w.market.address:undefined});
 l.apply(raw(OP.reserve,body(a,w.carol,pair[0]),w.carol));
 assert.throws(()=>l.check(raw(OP.reserve,body(b,w.dave,pair[1]),w.dave)),/Another reservation is waiting for exactly these amounts right now/);
 // Any other pay-by block gives other amounts and is accepted.
 const rb=reserve(b,w.dave,{window:pair[1].payBy===132?29:30});
 const ra=l.lot(a).reservations[0],linesA=[{to:w.alice.address,amount:BigInt(ra.seller)},{to:w.fee.address,amount:BigInt(ra.protocol)},...(ra.rate?[{to:w.market.address,amount:BigInt(ra.marketPay)}]:[])];
 l.setHeight(103);const paidA=payment('same keys',linesA);assert.equal(buy(a,[paidA]).owner,w.carol.address);
 // The same payment again, and a second transaction that repeats the keys of its coins.
 assert.throws(()=>buy(b,[paidA]),/already used for a sale/);
 const repeat=payment('same keys',rb.pay);assert.notEqual(repeat.txid,paidA.txid);assert.equal(repeat.tx.vout[0].target.tagged_key.key,paidA.tx.vout[0].target.tagged_key.key);
 assert.throws(()=>buy(b,[repeat]),/repeats the key of a payment that was already used/);
 assert.equal(buy(b,[payment('fresh keys',rb.pay)]).owner,w.dave.address);});

test('a payment after the listing ended does not count',()=>{
 const {w,l,claim0,list,reserve,payment,record}=world();l.apply(claim0(0,w.alice));l.setHeight(101);const lot=list(0,w.alice,XMR,110);l.setHeight(102);
 const r=reserve(lot,w.carol);assert.equal(l.lot(lot).reservations[0].payBy,110);l.setHeight(112);
 const late=payment('late',r.pay),rec=record(lot,[late]);
 assert.throws(()=>l.check(rec,[fact(late,111)]),/made after the listing ended \(block 110\), so it does not count/);
 assert.equal(l.apply(rec,[fact(late,110)]).owner,w.carol.address);});

test('transaction extras a wallet would not read the same way do not count',()=>{
 const {w,l,claim0,list,reserve,record}=world(),sub=w.alice.sub(3);l.apply(claim0(1,sub));l.setHeight(101);const lot=list(1,sub,XMR);l.setHeight(102);const r=reserve(lot,w.carol);l.setHeight(103);
 const outs=[{to:sub,amount:r.pay[0].amount},{to:w.fee,amount:r.pay[1].amount},{to:w.carol,amount:3n*XMR}];
 const send=(label,tamper)=>{const t=makeTx(label,outs,{tamper});return ()=>l.check(record(lot,[t]),[fact(t,103)]);};
 const refused=/does not carry the public key its wallet needs/,unread=/proof for the seller payment does not fit this transaction/;
 // Additional keys alone, with no transaction public key: a wallet skips the whole transaction.
 assert.throws(send('no main key',tx=>{assert.deepEqual(tx.extra.slice(33,35),[4,3]);tx.extra=tx.extra.slice(33);}),refused);
 // The number of additional keys written in two bytes where one is enough.
 assert.throws(send('long count',tx=>{tx.extra=[...tx.extra.slice(0,33),4,0x83,0,...tx.extra.slice(35)];}),unread);
 // A nonce whose length is written that way stops the reading before the additional keys.
 assert.throws(send('long nonce length',tx=>{tx.extra=[...tx.extra.slice(0,33),2,0x80,0,...tx.extra.slice(33)];}),unread);
 // A length that really needs two bytes is fine.
 assert.doesNotThrow(send('nonce of 200 bytes',tx=>{tx.extra=[...tx.extra.slice(0,33),2,0xc8,1,...Array(200).fill(7),...tx.extra.slice(33)];}));
 assert.doesNotThrow(send('plain'));});

test('a copy of a payment\'s output key at another address does not block the real buyer',()=>{
 const {w,l,claim0,list,reserve,payment,buy,record}=world();l.apply(claim0(0,w.alice));l.apply(claim0(2,w.bob));l.setHeight(101);
 const a=list(0,w.alice,XMR),b=list(2,w.bob,XMR);l.setHeight(102);const ra=reserve(a,w.carol);l.setHeight(103);
 const honest=payment('honest',ra.pay),K=honest.tx.vout[0].target.tagged_key.key;
 // Eve sees the payment and makes a marketplace address whose third output, under her own transaction key, has key K.
 const Pt=ed25519.ExtendedPoint,v=scalar('made view'),V=G.multiply(v),rr=scalar('copy txkey');
 const s=Hs(concat(V.multiply(rr).multiply(8n).toRawBytes(),Uint8Array.of(2))),spend=Pt.fromHex(K).subtract(G.multiply(s)).toRawBytes(),view=V.toRawBytes();
 const made={kind:'main',spend,view,address:encodeAddress({spend,view})};
 const rb=reserve(b,w.eve,{rate:100,market:made.address});assert.equal(rb.pay.length,3);assert.equal(rb.pay[2].to,made.address);l.setHeight(104);
 const copy=makeTx('copy',[{to:w.bob,amount:rb.pay[0].amount},{to:w.fee,amount:rb.pay[1].amount},{to:made,amount:rb.pay[2].amount}]);
 assert.equal(copy.tx.vout[2].target.tagged_key.key,K,'the copy carries the same output key');
 assert.equal(buy(b,[copy]).owner,w.eve.address);
 // The seller's coin is still one coin at the seller's address, so the real purchase counts.
 assert.equal(l.apply(record(a,[honest]),[fact(honest,103)]).owner,w.carol.address);});

test('a copy of a payment\'s output key at the same address is worth nothing without the transaction key, which no record shows',()=>{
 const {w,l,claim0,list,reserve,payment,prove}=world();l.apply(claim0(0,w.alice));l.apply(claim0(2,w.bob));l.setHeight(101);
 const a=list(0,w.alice,XMR),b=list(2,w.bob,XMR);l.setHeight(102);const ra=reserve(a,w.carol),rb=reserve(b,w.eve);l.setHeight(103);
 // Carol pays and sends her record. While it waits for a block, everyone sees the payment and the record.
 const honest=payment('honest',ra.pay),mine=prove(a,[honest]),rec=l.buyRecord({lot:a,payments:mine});
 assert.ok(honest.keys.every(k=>!hex(rec).includes(k)),'the record carries no transaction key');
 // Eve pays Bob with her own key and adds a copy of Carol's coin at the fee address: the same output, with Carol's
 // public key where a wallet looks first. Eve's own public key goes in as an additional key.
 const copy=makeTx('copy',[{to:w.bob,amount:rb.pay[0].amount},{to:w.fee,amount:rb.pay[1].amount}],{tamper:tx=>{
  const own=tx.extra.slice(1,33);tx.extra=[1,...honest.tx.extra.slice(1,33),4,2,...own,...own];
  tx.vout[1]=structuredClone(honest.tx.vout[1]);tx.rct_signatures.ecdhInfo[1]=honest.tx.rct_signatures.ecdhInfo[1];tx.rct_signatures.outPk[1]=honest.tx.rct_signatures.outPk[1];}});
 const K=honest.tx.vout[1].target.tagged_key.key,message=paymentMessage(DOMAIN,b),facts=[fact(copy,103)];
 assert.equal(copy.tx.vout[1].target.tagged_key.key,K);
 // With Carol's transaction key the copy could be proved. That key is what the earlier record format made public.
 const withKey=entry(copy,1,b,{secret:honest.outs[1].secret});
 assert.deepEqual(checkPaymentProof({tx:copy.tx,...withKey,address:w.fee.address,message}),{index:1,amount:ra.pay[1].amount,key:K});
 // Without it: Carol's own proof is for her transaction and her listing, and Eve cannot make another one.
 const unfit=/proof for the protocol fee payment does not fit this transaction, listing and address/,forBob=entry(copy,0,b);
 // A proof with her own key is a true proof, of a secret that does not open this output.
 assert.throws(()=>l.check(l.buyRecord({lot:b,payments:[forBob,entry(copy,1,b,{secret:copy.outs[0].secret})]}),facts),/Output 1 of the protocol fee payment does not pay the protocol fee address/);
 const tries={replayed:{...mine[1],txid:copy.txid},
  ownKeyCarolSecret:{...entry(copy,1,b,{secret:copy.outs[0].secret}),D:mine[1].D},
  ownListing:{...entry(honest,1,b,{secret:copy.outs[0].secret}),txid:copy.txid,D:mine[1].D}};
 for(const [name,e] of Object.entries(tries))assert.throws(()=>l.check(l.buyRecord({lot:b,payments:[forBob,e]}),facts),unfit,name);
 // Carol's proof names Carol's transaction; used with it on Eve's listing it is refused too.
 assert.throws(()=>l.check(l.buyRecord({lot:b,payments:[forBob,mine[1]]}),[...facts,fact(honest,103)]),unfit);
 // Nothing of Eve's was recorded, so Carol's purchase counts.
 assert.equal(l.apply(rec,[fact(honest,103)]).owner,w.carol.address);});

test('a payment proof fits one transaction, one listing, one payee and one ledger, and has one spelling',()=>{
 const {w,l,claim0,list,reserve,payment}=world();l.apply(claim0(0,w.alice));l.setHeight(101);const lot=list(0,w.alice,XMR);l.setHeight(102);
 const r=reserve(lot,w.carol);l.setHeight(103);const good=payment('good',r.pay),facts=[fact(good,103)],Pt=ed25519.ExtendedPoint;
 const check=(i,o,patch=x=>x,f=facts)=>()=>{const e=[entry(good,0,lot),entry(good,1,lot)];e[i]=patch(entry(good,i,lot,o));return l.check(l.buyRecord({lot,payments:e}),f);};
 const seller=/proof for the seller payment does not fit this transaction, listing and address/,fee=/proof for the protocol fee payment does not fit/;
 assert.doesNotThrow(check(0));
 assert.throws(check(0,{proofTxid:'ab'.repeat(32)}),seller,'another transaction');
 assert.throws(check(0,{message:paymentMessage(DOMAIN,'cd'.repeat(32))}),seller,'another listing');
 assert.throws(check(0,{domain:'ef'.repeat(32)}),seller,'another ledger');
 assert.throws(check(1,{to:w.alice}),fee,'another payee');assert.throws(check(1,{to:w.fee.sub(1)}),fee,'a subaddress of the payee');
 assert.throws(check(0,{message:''}),seller,'the proof a wallet makes with no message');
 // The shared secret: another point, the right point with a small-order part added, the neutral point.
 const T=Pt.fromHex('c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a');assert.ok(T.multiply(8n).equals(Pt.ZERO)&&!T.multiply(4n).equals(Pt.ZERO));
 assert.throws(check(0,{},x=>({...x,D:hex(G.multiply(5n).toRawBytes())})),seller);
 assert.throws(check(0,{},x=>({...x,D:hex(Pt.fromHex(x.D).add(T).toRawBytes())})),seller);
 assert.throws(check(0,{},x=>({...x,D:hex(Pt.ZERO.toRawBytes())})),seller);
 // The two numbers of the proof, each written as the same number plus the group order: the equations would still hold for the second.
 const plus=h=>hex(leBytes(le(unhex(h))+L));
 assert.throws(check(0,{},x=>({...x,c:plus(x.c)})),seller);assert.throws(check(0,{},x=>({...x,s:plus(x.s)})),seller);
 const e=entry(good,0,lot),args={...e,txPub:good.txPub,address:w.alice,message:paymentMessage(DOMAIN,lot)};
 assert.equal(verifyOutProof(args),true);assert.equal(verifyOutProof({...args,s:plus(e.s)}),false);assert.equal(verifyOutProof({...args,c:plus(e.c)}),false);
 // The carried public key with a small-order part added: the same coin for nobody.
 const bent=structuredClone(good.tx);bent.extra=[1,...Pt.fromHex(good.txPub).add(T).toRawBytes()];
 assert.throws(check(0,{},x=>x,[{...facts[0],tx:bent}]),/seller payment does not carry the public key its wallet needs/);
 // The proof is new each time it is made, and each one is accepted.
 const again=entry(good,0,lot);assert.notEqual(again.c,e.c);assert.equal(again.D,e.D);assert.equal(verifyOutProof({...args,...again}),true);
 // A random source that repeats itself must not give two different proofs the same one-time number (X = c·R + s·G
 // shows it): from two such proofs anyone could work out the transaction key.
 const stuck=()=>new Uint8Array(64).fill(7),secret=good.outs[0].secret,shown=message=>{const p=makeOutProof({txid:good.txid,secret,address:w.alice,message,random:stuck});
  assert.equal(verifyOutProof({txid:good.txid,txPub:good.txPub,address:w.alice,message,D:p.D,c:p.c,s:p.s}),true);
  return hex(Pt.fromHex(good.txPub).multiply(le(p.c)).add(G.multiply(le(p.s))).toRawBytes());};
 assert.notEqual(shown(paymentMessage(DOMAIN,lot)),shown(paymentMessage(DOMAIN,'cd'.repeat(32))));
 assert.equal(shown(paymentMessage(DOMAIN,lot)),shown(paymentMessage(DOMAIN,lot)));
 // The payee's own keys are checked by the proof check itself, whoever calls it.
 const T8=Pt.fromHex('c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a'),bentView=Pt.fromHex(hex(w.alice.view)).add(T8).toRawBytes();
 assert.equal(verifyOutProof({...args,address:{...w.alice,view:bentView}}),false);assert.equal(verifyOutProof({...args,address:{kind:'sub',view:w.alice.view,spend:new Uint8Array(32)}}),false);});

test('a payment whose first public key is not a usable point does not count, also not through an additional key',()=>{
 const {w,l,claim0,list,reserve,linesFor,prove}=world(),sub=w.alice.sub(3),Pt=ed25519.ExtendedPoint;
 l.apply(claim0(1,sub));l.setHeight(101);const lot=list(1,sub,XMR);l.setHeight(102);const r=reserve(lot,w.carol),lines=linesFor(lot);l.setHeight(103);
 const pays=[{to:sub,amount:lines[0].amount},{to:w.fee,amount:lines[1].amount}],fits=makeTx('sub-good',pays);
 assert.equal(fits.tx.extra[33],4,'one key per output');assert.doesNotThrow(()=>l.check(l.buyRecord({lot,payments:prove(lot,[fits])}),[fact(fits,103)]));
 const T8=Pt.fromHex('c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a');
 const broken={'not a point':()=>Array(32).fill(255),'a point of order 8':()=>[...T8.toRawBytes()],'a point with a small-order part':t=>[...Pt.fromHex(hex(Uint8Array.from(t.extra.slice(1,33)))).add(T8).toRawBytes()]};
 for(const [name,key] of Object.entries(broken)){
  const t=makeTx('sub-'+name,pays,{tamper:tx=>{tx.extra.splice(1,32,...key(tx));}});
  // The seller's coin sits behind an additional key that is fine; the transaction still does not count.
  assert.throws(()=>l.check(l.buyRecord({lot,payments:[entry(t,0,lot),entry(t,1,lot)]}),[fact(t,103)]),/seller payment does not carry the public key its wallet needs/,name);
  assert.throws(()=>prove(lot,[t]),/does not carry the public key its wallet needs to find it/,name);}
 assert.ok(r.id);});

test('an address whose view key no wallet could use is refused in every record',()=>{
 const {w,l,claim0,raw}=world();l.apply(claim0(0,w.alice));l.setHeight(101);
 const eight='c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',one='01'+'00'.repeat(31);
 for(const view of [eight,one]){const bad=encodeAddress({spend:w.bob.spend,view:unhex(view),kind:'main',network:'mainnet'});
  assert.throws(()=>l.prepareMove({mordinal:0,from:w.alice.address,to:bad}),/unusable view key/);
  const good=raw(OP.move,{reg:l.mordinal(0).reg,seq:0,from:w.alice.address,to:w.bob.address},w.alice),text=hex(good),at=text.indexOf(hex(w.bob.view));
  assert.ok(at>0);assert.throws(()=>l.check(unhex(text.slice(0,at)+view+text.slice(at+64))),/unusable view key/);
  // The ledger's own fee address is held to the same rule, for both of its keys.
  const fees=[encodeAddress({spend:w.fee.spend,view:unhex(view),kind:'main',network:'mainnet'}),encodeAddress({spend:unhex(view),view:w.fee.view,kind:'main',network:'mainnet'}),encodeAddress({spend:new Uint8Array(32),view:w.fee.view,kind:'sub',network:'mainnet'})];
  for(const feeAddress of fees)assert.throws(()=>createLedger({domain:DOMAIN,feeAddress,owners:[],height:100}),/fee address has a key no wallet can use/);}});

test('a wallet that only signs messages: the payment proof is made from the view key',()=>{
 const {w,l,owners}=world(),o=owners[0],alice=decodeAddress(w.alice.address);
 const proof=inProofFromViewKey({txid:o.ownerTx,txPub:o.ownerTxPubKeys[0],address:alice,viewSecret:w.alice.viewSecret});
 assert.equal(proof.length,141);assert.equal(verifyInProof({txid:o.ownerTx,txPub:o.ownerTxPubKeys[0],address:alice,...parseInProof(proof)}),true);
 assert.notEqual(proof,inProofFromViewKey({txid:o.ownerTx,txPub:o.ownerTxPubKeys[0],address:alice,viewSecret:w.alice.viewSecret}),'a fresh nonce each time');
 assert.throws(()=>inProofFromViewKey({txid:o.ownerTx,txPub:o.ownerTxPubKeys[0],address:alice,viewSecret:w.bob.viewSecret}),/does not belong to this address/);
 // Main address + view key: finds the main-address coin and the subaddress coin, with the address that must sign each claim.
 assert.throws(()=>findWithViewKey(owners,{address:w.alice.address,viewSecret:w.bob.viewSecret}),/does not belong to this address/);
 assert.throws(()=>findWithViewKey(owners,{address:w.alice.sub(3).address,viewSecret:w.alice.viewSecret}),/main address/);
 assert.deepEqual(findWithViewKey(owners,{address:w.alice.address,viewSecret:w.alice.viewSecret,subaddresses:3}).map(m=>m.entry.number),[0],'a subaddress beyond the searched range is not found');
 const found=findWithViewKey(owners,{address:w.alice.address,viewSecret:w.alice.viewSecret,subaddresses:10});
 assert.deepEqual(found.map(m=>[m.entry.number,m.holder,m.index]),[[0,w.alice.address,0],[1,w.alice.sub(3).address,3]]);
 const signers=[w.alice,w.alice.sub(3)];
 for(const [i,m] of found.entries()){const p=l.prepareClaim({mordinal:m.entry.number,to:w.carol.address,holder:m.holder});
  // The view key makes the proof but cannot sign the claim; the spend key in the wallet must.
  assert.throws(()=>l.claimWithProof(p.bodyBytes,m.proof,signers[i].signView(p.text)),/not for this text and address/);
  assert.throws(()=>l.claimWithProof(p.bodyBytes,m.proof,w.eve.sign(p.text)),/not for this text and address/);
  assert.equal(l.apply(l.claimWithProof(p.bodyBytes,m.proof,signers[i].sign(p.text))).owner,w.carol.address);}
 // Bob's view key gives a correct proof for his address on dave's coin (#4), and the claim is still refused.
 const p4=l.prepareClaim({mordinal:4,to:w.bob.address,holder:w.bob.address}),proof4=inProofFromViewKey({txid:owners[4].ownerTx,txPub:owners[4].ownerTxPubKeys[0],address:decodeAddress(w.bob.address),viewSecret:w.bob.viewSecret});
 assert.throws(()=>l.check(l.claimWithProof(p4.bodyBytes,proof4,w.bob.sign(p4.text))),/did not receive output 0/);});

for(const [file,least] of [['fixtures.json',10],['fixtures-wallet-apps.json',2]])test('saved test cases from the wallet lab replay to the same result: '+file,{skip:!existsSync(fileURLToPath(new URL('./'+file,import.meta.url)))},()=>{
 const f=JSON.parse(readFileSync(new URL('./'+file,import.meta.url),'utf8')),l=createLedger({network:f.network,domain:f.domain,feeAddress:f.feeAddress,owners:f.owners,height:f.startHeight});
 let accepted=0,refused=0;
 for(const e of f.events){l.setHeight(e.height);const record=unhex(e.record);
  if(e.text!==undefined&&e.text!==null){const d=decodeRecord(record,f.network);if(d.op!==OP.buy&&!(d.op===OP.claim&&d.body.proof===PROOF.outputKey))assert.equal(l.textOf(d.bodyBytes),e.text,e.name);}
  if(e.accepted){const out=l.apply(record,e.facts);assert.equal(out.id,e.id,e.name);accepted++;}
  else{assert.throws(()=>l.check(record,e.facts),x=>x.message===e.error,e.name);refused++;}}
 assert.deepEqual(JSON.parse(JSON.stringify(l.toJSON())),f.final);assert.ok(accepted>=least&&refused>=1&&(least<10||refused>=10),`${accepted} accepted, ${refused} refused`);});
