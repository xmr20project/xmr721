// Offline tests of the fee of a claim by burning (RULES.md section 10, "The fee") with made-up keys and transactions,
// the fee addresses checked against monero-wallet-rpc (fixtures-burn.json): node --test rules/tests/burn-fee.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ed25519} from '@noble/curves/ed25519';
import {keccak_256} from '@noble/hashes/sha3';
import {createLedger} from '../lib/ledger.mjs';
import {hex,unhex,concat,le,leBytes,Hs,decodeAddress} from '../lib/monero.mjs';
import {signWithOutputKey,outputSecret} from '../lib/claim.mjs';
import {checkPayment} from '../lib/payment.mjs';
import {RECORDS_OVERLAP,burnClaimId,burnParts,readTransfer,paysBurnAddress} from '../lib/burn.mjs';
import {FEE_WALLET,FEE_ACCOUNT,FEE_LOOKAHEAD,feeIndex,feeWallet,isProjectFeeWallet,feeAddressOf,feeTable,feeParts,feeOutputs,walletKeys} from '../lib/burn-fee.mjs';
import {wallet,makeTx,ownerEntry,makeBurn,burnParty,feeParty,payFee,DOMAIN} from './helpers.mjs';
const FIX=JSON.parse(readFileSync(new URL('./fixtures-burn.json',import.meta.url),'utf8')),enc=new TextEncoder();
const Pt=ed25519.ExtendedPoint,G=Pt.BASE,H=Pt.fromHex('8b655970153799af2aeadc9ff1add0ea6c7251d54154cfa92c173a0dd39c1f94');
const FROM=110,END=FROM+RECORDS_OVERLAP,DUE=10n**9n+30000000n;
const varint=n=>{const out=[];do{let b=n&127;n=Math.floor(n/128);if(n)b|=128;out.push(b);}while(n);return Uint8Array.from(out);};

// What anyone with the fee wallet's public view key can work out for output i of a transaction made with public key R.
function shared(R,i,w=feeWallet()){const d=Pt.fromHex(R).multiply(le(unhex(w.viewKey))).multiply(8n).toRawBytes(),s=Hs(concat(d,varint(i)));
 const pad=keccak_256(concat(enc.encode('amount'),leBytes(s))).subarray(0,8),mask=Hs(concat(enc.encode('commitment_mask'),leBytes(s)));
 return {ecdh:amount=>hex(Uint8Array.from(leBytes(amount,8),(x,j)=>x^pad[j])),commitment:amount=>hex(G.multiply(mask).add(amount?H.multiply(amount):Pt.ZERO).toRawBytes())};}

function world(o={}){
 const w=Object.fromEntries(['alice','bob','carol','dave','fee'].map(n=>[n,wallet(n)]));
 const holders=[w.alice,w.alice,w.bob,w.bob,w.carol,w.carol];
 const owners=holders.map((h,i)=>ownerEntry(i,makeTx('fee world '+i,[{to:h,amount:10n**9n}])));     // owner outputs 1000 to 1005
 const l=createLedger({domain:DOMAIN,feeAddress:w.fee.address,owners,height:100,burnFrom:FROM,...o});
 const key=(n,h)=>outputSecret({viewSecret:h.viewSecret,spendSecret:h.spendSecret,txPub:owners[n].ownerTxPubKeys[0],subScalar:h.subScalar});
 const claim0=(n,h,to=h)=>{const p=l.prepareClaim({mordinal:n,to:to.address});return l.claimWithKey(p.bodyBytes,signWithOutputKey(p.keyHash,key(n,h)));};
 const burn=(label,n,to,more={})=>makeBurn(label,{output:1000+n,to,...more});
 const apply=t=>l.applyBurnClaim(t.txid,burnParts(t.tx)),fees=t=>l.applyBurnFees(t.txid,feeParts(t.tx));
 let k=0;const pay=(n,amount=DUE,more)=>fees(payFee('fee world payment '+k++,n,amount,more));
 return {w,l,owners,claim0,burn,apply,fees,pay};}

test('the fee wallet and the fee addresses: subaddresses (1, n + 1) of the project wallet, as monero-wallet-rpc lists them',()=>{
 const f=FIX.feeAddresses,w=feeWallet();
 assert.deepEqual({wallet:f.wallet,viewKey:f.viewKey,account:f.account},{wallet:FEE_WALLET.address,viewKey:FEE_WALLET.viewKey,account:FEE_ACCOUNT});
 assert.equal(w.address,FEE_WALLET.address);assert.equal(isProjectFeeWallet(w),true);assert.equal(FEE_LOOKAHEAD,50000);
 assert.equal(feeIndex(0),1);assert.equal(feeIndex(42894),42895);
 // The view key belongs to the address: its public key is the address's view key.
 assert.equal(hex(G.multiply(le(unhex(FEE_WALLET.viewKey))).toRawBytes()),hex(decodeAddress(FEE_WALLET.address).view));
 // Mordinal n pays to index n + 1: #0 to index 1, the owner list's last numbers to 42,894 and 42,895.
 assert.deepEqual(f.subaddresses.map(x=>x[0]),[0,1,2,3,8,43,256,257,1001,4096,42875,42894,42895,49999,50000]);
 for(const [index,address] of f.subaddresses.filter(x=>x[0]>0)){const a=feeAddressOf(w,index-1);assert.equal(a.address,address,'index '+index);
  const d=decodeAddress(address);assert.equal(d.kind,'sub');assert.equal(hex(d.spend),a.spend);assert.equal(hex(d.view),a.view);}
 // The table finds each number by its spend key; numbers not asked for are not found, and index 0 (the wallet's own
 // change) is no number's fee address.
 const all=f.subaddresses.filter(x=>x[0]>0).map(x=>x[0]-1),of=feeTable(w,[0,7,42894,...all]),zero=decodeAddress(f.subaddresses[0][1]);
 assert.equal(of(feeAddressOf(w,7).spend),7);assert.equal(of(feeAddressOf(w,42894).spend),42894);assert.equal(of(w.spend),undefined);assert.equal(of(hex(zero.spend)),undefined);
 // The same keys on stagenet, written as stagenet addresses; another network names a wallet of its own if it likes.
 const s=feeWallet(null,'stagenet');assert.equal(s.spend,w.spend);assert.equal(s.view,w.view);assert.equal(decodeAddress(feeAddressOf(s,7).address,'stagenet').kind,'sub');assert.equal(feeAddressOf(s,7).spend,feeAddressOf(w,7).spend);
 const own=wallet('own fee','stagenet');assert.equal(feeWallet({address:own.address,viewKey:hex(own.viewSecret)},'stagenet').address,own.address);
 // On mainnet the project's wallet only, unless the chain is the offline test chain; a view key has to fit its address.
 const mine=wallet('own fee');assert.throws(()=>feeWallet({address:mine.address,viewKey:hex(mine.viewSecret)}),/On mainnet the fee wallet is fixed/);
 assert.equal(feeWallet({address:mine.address,viewKey:hex(mine.viewSecret)},'mainnet',{testChain:true}).address,mine.address);
 assert.equal(feeWallet({address:FEE_WALLET.address,viewKey:FEE_WALLET.viewKey}).address,FEE_WALLET.address);
 assert.throws(()=>feeWallet({address:mine.address,viewKey:FEE_WALLET.viewKey},'mainnet',{testChain:true}),/does not belong/);
 assert.throws(()=>feeWallet({address:mine.sub(1).address,viewKey:hex(mine.viewSecret)},'mainnet',{testChain:true}),/main address/);
 assert.throws(()=>feeWallet({address:mine.address}),/main address and its secret view key/);
 assert.throws(()=>feeAddressOf(w,-1),/whole number/);assert.throws(()=>feeAddressOf(w,2**32-1),/whole number from 0 to 4294967294/);});

test('index 0 of account 1 is no fee address: the fee wallet\'s own change there is not Mordinal #0\'s fee',()=>{
 const w=feeWallet(),of=feeTable(w,[0,1,2,3,4,5]),z=decodeAddress(FIX.feeAddresses.subaddresses[0][1]),zero={label:'change',kind:'sub',spend:z.spend,view:z.view,address:z.address};
 // A payment from account 1, as wallet2 makes one: the change goes to (1, 0), made with the transaction key.
 const t=makeTx('change',[{to:zero,amount:10n**9n}]);assert.deepEqual(feeOutputs(feeParts(t.tx),w,of),[]);
 const {l}=world();l.setHeight(FROM);assert.throws(()=>l.applyBurnFees(t.txid,feeParts(t.tx)),/pays no fee address/);assert.equal(l.burnFee(0).paid,'0');
 assert.equal(l.burnFee(0).address,FIX.feeAddresses.subaddresses[1][1]);});

test('a fee payment is found with the transaction public key and with an additional key, its amount read and checked',()=>{
 const w=feeWallet(),of=feeTable(w,[0,1,2,3,4,5]);
 // One output to the fee address: the transaction key is r·D, the payment is found with the transaction public key.
 const one=payFee('found main',3,123456789n);assert.equal(one.tx.extra.length,33);
 assert.deepEqual(feeOutputs(feeParts(one.tx),w,of),[{index:0,number:3,amount:123456789n,error:null}]);
 // With an ordinary payment beside it the transaction carries additional keys, and the fee output is found with its own.
 const two=payFee('found additional',4,987654321n,{alongside:wallet('somebody')});assert.equal(two.tx.extra[33],4);
 assert.deepEqual(feeOutputs(feeParts(two.tx),w,of),[{index:1,number:4,amount:987654321n,error:null}]);
 // The payer's own view (payment.mjs, with the transaction key) reads the same amounts.
 assert.equal(checkPayment({tx:one.tx,txKey:one.keys.join(''),address:feeParty(3).address}).received,123456789n);
 assert.equal(checkPayment({tx:two.tx,txKey:two.keys.join(''),address:feeParty(4).address}).received,987654321n);
 // Several fee addresses in one transaction, and the parts as a journal keeps them (through JSON).
 const many=makeTx('found many',[{to:feeParty(1),amount:5n},{to:wallet('x'),amount:6n},{to:feeParty(2),amount:7n}]),parts=feeParts(many.tx);
 assert.deepEqual(feeOutputs(JSON.parse(JSON.stringify(parts)),w,of).map(f=>[f.index,f.number,f.amount]),[[0,1,5n],[2,2,7n]]);
 assert.deepEqual(Object.keys(parts),['unlock','keys','outs']);assert.deepEqual(Object.keys(parts.outs[0]),['key','tag','amount','commitment']);
 // Not a fee payment: an ordinary payment, a number not asked for, another wallet's subaddress with the same index.
 assert.deepEqual(feeOutputs(feeParts(makeTx('plain',[{to:wallet('x'),amount:5n}]).tx),w,of),[]);
 assert.deepEqual(feeOutputs(feeParts(payFee('far',99,5n).tx),w,of),[]);
 const other=wallet('another fee wallet'),otherSub=makeTx('other wallet',[{to:other.sub(3),amount:5n}]);assert.deepEqual(feeOutputs(feeParts(otherSub.tx),w,of),[]);
 // A transaction that is not a current RingCT transaction holds none.
 for(const change of [tx=>{tx.version=1;},tx=>{tx.rct_signatures.type=3;},tx=>{tx.rct_signatures.ecdhInfo.pop();},tx=>{tx.vout=[];},tx=>{delete tx.rct_signatures;}]){
  const t=payFee('not rct '+change,3,5n,{tamper:change});assert.equal(feeParts(t.tx),null);}});

test('a forged amount, a wrong view tag, a lock time: the output is not counted',()=>{
 const w=feeWallet(),of=feeTable(w,[0,1,2,3,4,5]);
 // ecdhInfo says 1 XMR; the commitment holds 1 piconero. Anyone can write such an ecdhInfo with the public view key.
 const forged=payFee('forged',2,1n,{tamper:tx=>{const k=shared(hex(Uint8Array.from(tx.extra.slice(1,33))),0);assert.equal(tx.rct_signatures.outPk[0],k.commitment(1n));tx.rct_signatures.ecdhInfo[0].amount=k.ecdh(10n**12n);}});
 assert.deepEqual(feeOutputs(feeParts(forged.tx),w,of),[{index:0,number:2,amount:null,error:'Its amount does not match its commitment, so a wallet cannot spend it.'}]);
 // A commitment that is not the one the amount gives (another mask), and amounts no wallet can read.
 const masked=payFee('masked',2,5n,{tamper:tx=>{tx.rct_signatures.outPk[0]=hex(G.multiply(77n).add(H.multiply(5n)).toRawBytes());}});assert.match(feeOutputs(feeParts(masked.tx),w,of)[0].error,/does not match its commitment/);
 const torn=payFee('torn',2,5n,{tamper:tx=>{tx.rct_signatures.ecdhInfo[0].amount='00';}});assert.match(feeOutputs(feeParts(torn.tx),w,of)[0].error,/no amount a wallet can read/);
 // A view tag that is not the one the derivation gives: a wallet does not look further, so the payment is not found.
 const tagged=payFee('tag',2,5n,{tamper:tx=>{const t=tx.vout[0].target.tagged_key;t.view_tag=t.view_tag==='00'?'01':'00';}});assert.deepEqual(feeOutputs(feeParts(tagged.tx),w,of),[]);
 // Without a view tag (the older output form) the key alone decides.
 const untagged=payFee('untagged',2,5n,{tamper:tx=>{tx.vout[0].target={key:tx.vout[0].target.tagged_key.key};}});assert.deepEqual(feeOutputs(feeParts(untagged.tx),w,of),[{index:0,number:2,amount:5n,error:null}]);
 // A lock time: the fee wallet could not spend it now.
 const locked=payFee('locked',2,5n,{tamper:tx=>{tx.unlock_time=10;}});assert.deepEqual(feeOutputs(feeParts(locked.tx),w,of),[{index:0,number:2,amount:5n,error:'A payment with a lock time does not count.'}]);
 // A transaction public key that is no point, an additional key list after a field a wallet does not know.
 const broken=payFee('broken',2,5n,{tamper:tx=>{tx.extra=[1,...new Uint8Array(32).fill(255)];}});assert.deepEqual(feeOutputs(feeParts(broken.tx),w,of),[]);
 const late=payFee('late keys',4,5n,{alongside:wallet('y'),tamper:tx=>{tx.extra=[1,...tx.extra.slice(1,33),0x11,1,65,...tx.extra.slice(33)];}});assert.deepEqual(feeOutputs(feeParts(late.tx),w,of),[]);
 // In the ledger: kept and refused with the reason, nothing counted.
 const {l}=world();l.setHeight(FROM);
 assert.deepEqual(l.applyBurnFees(forged.txid,feeParts(forged.tx)),{paid:[{index:0,number:2,amount:null,counted:false,error:'Its amount does not match its commitment, so a wallet cannot spend it.'}],claims:[]});
 assert.equal(l.applyBurnFees(locked.txid,feeParts(locked.tx)).paid[0].counted,false);assert.equal(l.burnFee(2).paid,'0');
 assert.throws(()=>l.applyBurnFees(tagged.txid,feeParts(tagged.tx)),/pays no fee address/);assert.equal(l.toJSON().fees,undefined);});

test('a burn waits for its fee: below the fee it waits, at the fee it claims, in the block of the payment that reaches it',()=>{
 const {w,l,burn,apply,pay}=world();l.setHeight(FROM+1);
 const t=burn('waits',2,w.carol),id=burnClaimId(DOMAIN,t.txid);
 assert.deepEqual(l.checkBurnClaim(t.txid,burnParts(t.tx)),{id,number:2,owner:w.carol.address,due:DUE.toString(),paid:'0',waiting:true});
 assert.equal(apply(t).owner,null);
 const m=l.mordinal(2);assert.equal(m.claimed,false);assert.equal(m.owner,null);assert.equal(m.waiting.id,id);
 assert.deepEqual(l.burnFee(2),{address:feeAddressOf(feeWallet(),2).address,paid:'0',waiting:{id,tx:t.txid,number:2,to:w.carol.address,due:DUE.toString(),height:FROM+1,state:'waiting',paid:'0',missing:DUE.toString()}});
 assert.deepEqual(l.toJSON().waiting,[{number:2,id,to:w.carol.address,due:DUE.toString()}]);
 // While it waits nothing can be done with it: it has no owner.
 assert.throws(()=>l.prepareMove({mordinal:2,from:w.carol.address,to:w.dave.address}),/has not been claimed yet/);
 // Fee payments add up, across transactions and outputs; one piconero short it still waits.
 l.setHeight(FROM+2);assert.deepEqual(pay(2,DUE/2n).claims,[]);
 l.setHeight(FROM+3);const both=makeTx('two parts',[{to:feeParty(2),amount:DUE/4n},{to:feeParty(2),amount:DUE/4n-1n}]);
 assert.deepEqual(l.applyBurnFees(both.txid,feeParts(both.tx)).paid.map(p=>[p.number,p.amount,p.counted]),[[2,(DUE/4n).toString(),true],[2,(DUE/4n-1n).toString(),true]]);
 assert.equal(l.burnClaim(id).missing,'1');assert.equal(l.mordinal(2).claimed,false);
 // A payment for another Mordinal is not counted for this one.
 assert.deepEqual(pay(3,DUE).claims,[]);assert.equal(l.burnClaim(id).missing,'1');assert.equal(l.burnFee(3).paid,DUE.toString());
 // The payment that reaches the fee claims it, in its block.
 l.setHeight(FROM+9);assert.deepEqual(pay(2,1n).claims,[{id,number:2,owner:w.carol.address}]);
 assert.deepEqual(l.mordinal(2).history,[{what:'claim',height:FROM+9,record:id,to:w.carol.address,proof:'burn',tx:t.txid}]);
 assert.equal(l.burnClaim(id).state,'claimed');assert.equal(l.burnClaim(id).claimedAt,FROM+9);assert.equal(l.burnClaim(id).missing,'0');assert.equal(l.toJSON().waiting,undefined);
 assert.deepEqual(l.toJSON().fees,[{number:2,paid:DUE.toString(),outputs:4},{number:3,paid:DUE.toString(),outputs:1}]);
 // More payments for a claimed Mordinal are kept and give nothing.
 assert.deepEqual(pay(2,5n).claims,[]);assert.equal(l.mordinal(2).owner,w.carol.address);assert.equal(l.burnFee(2).paid,(DUE+5n).toString());});

test('a fee paid before the burn, or in the burn transaction itself, claims at the burn',()=>{
 const {w,l,burn,apply,pay}=world();l.setHeight(FROM);
 // Before: payments for a Mordinal with no burn are kept; a later burn uses them.
 assert.deepEqual(pay(1,DUE-10n).claims,[]);assert.deepEqual(pay(1,10n).claims,[]);assert.equal(l.mordinal(1).claimed,false);
 l.setHeight(FROM+5);const t=burn('after its fee',1,w.dave);assert.deepEqual(apply(t),{id:burnClaimId(DOMAIN,t.txid),number:1,owner:w.dave.address});
 assert.deepEqual(l.mordinal(1).history,[{what:'claim',height:FROM+5,record:burnClaimId(DOMAIN,t.txid),to:w.dave.address,proof:'burn',tx:t.txid}]);
 // In the transaction itself: output 0 to the burn address, an output to the fee address, change. Applied as a reader
 // applies a transaction: the burn, then the payments it holds.
 const own=burn('own fee',4,w.alice,{outs:[{to:burnParty,amount:1n},{to:feeParty(4),amount:DUE},{to:wallet('own fee change'),amount:10n**9n}]});
 // Its tx_extra: the public key, the payment id, the three additional keys, then the transfer field.
 assert.deepEqual([own.tx.extra[0],own.tx.extra[33],own.tx.extra[44],own.tx.extra[45],own.tx.extra[46+96]],[1,2,4,3,0x11]);assert.equal(readTransfer(own.tx.extra).txPub,own.txPub);
 const parts=burnParts(own.tx);assert.equal(l.checkBurnClaim(own.txid,parts).waiting,true);assert.equal(apply(own).owner,null);
 assert.deepEqual(l.applyBurnFees(own.txid,feeParts(own.tx)),{paid:[{index:1,number:4,amount:DUE.toString(),counted:true,error:null}],claims:[{id:burnClaimId(DOMAIN,own.txid),number:4,owner:w.alice.address}]});
 // A payment of less in the burn transaction leaves it waiting.
 const less=burn('own fee short',5,w.alice,{outs:[{to:burnParty,amount:1n},{to:feeParty(5),amount:DUE-1n},{to:wallet('c'),amount:1n}]});apply(less);
 assert.deepEqual(l.applyBurnFees(less.txid,feeParts(less.tx)).claims,[]);assert.equal(l.burnClaim(burnClaimId(DOMAIN,less.txid)).missing,'1');});

test('output 0 found with the additional key of output 0, as a wallet that makes every output with its own key',()=>{
 const {w,l,burn,apply,pay}=world();l.setHeight(FROM);
 const t=burn('all additional',3,w.carol,{allAdditional:true,outs:[{to:burnParty,amount:1n},{to:feeParty(3),amount:DUE},{to:wallet('aa change'),amount:5n}]});
 // The transaction public key does not find output 0; the additional key of output 0 does.
 const out0=burnParts(t.tx).out0,additional=hex(Uint8Array.from(t.tx.extra.slice(46,78)));assert.equal(t.tx.extra[44],4);
 assert.equal(paysBurnAddress({txPub:t.txPub,...out0}),false);assert.equal(paysBurnAddress({txPub:t.txPub,additional,...out0}),true);
 assert.deepEqual(l.checkBurnClaim(t.txid,burnParts(t.tx)).number,3);apply(t);assert.deepEqual(l.applyBurnFees(t.txid,feeParts(t.tx)).claims.map(c=>c.owner),[w.carol.address]);
 // The same with the additional keys after the transfer field, where a wallet does not read: no burn, and no fee payment.
 const late=burn('late additional',5,w.carol,{allAdditional:true,outs:[{to:burnParty,amount:1n},{to:feeParty(5),amount:DUE}],
  tamper:tx=>{const at=44,n=tx.extra[at+1];assert.equal(tx.extra[at],4);const keys=tx.extra.slice(at,at+2+32*n);tx.extra=[...tx.extra.slice(0,at),...tx.extra.slice(at+2+32*n),...keys];}});
 assert.throws(()=>l.checkBurnClaim(late.txid,burnParts(late.tx)),/does not pay the burn address/);assert.deepEqual(l.scanBurnFees(feeParts(late.tx)),[]);
 // wallet2's shape: output 0 with the transaction key, the fee output with its additional key.
 const usual=burn('usual',5,w.carol,{outs:[{to:burnParty,amount:1n},{to:feeParty(5),amount:DUE}]});assert.equal(usual.tx.extra[33],2);
 assert.equal(apply(usual).number,5);assert.equal(l.applyBurnFees(usual.txid,feeParts(usual.tx)).claims[0].owner,w.carol.address);});

test('fee payments count from the first burn block, and the same one-time key counts once, at its largest amount',()=>{
 const {w,l,burn,apply,pay}=world();
 l.setHeight(FROM-1);assert.throws(()=>pay(2),/Fee payments count from block 110/);assert.deepEqual(l.scanBurnFees(feeParts(payFee('early',2,DUE).tx)).map(f=>f.number),[2]);
 l.setHeight(FROM);assert.equal(l.burnFee(2).paid,'0');
 // A copy of a payment's one-time key: anyone can make one (the view key is public) with another amount. A wallet keeps
 // one of two outputs with the same key, the larger, so the copy counts only by what it adds on top.
 const first=payFee('original',2,DUE/2n),R=hex(Uint8Array.from(first.tx.extra.slice(1,33))),k=shared(R,0);
 const copy=amount=>payFee('copy '+amount,2,1n,{tamper:tx=>{tx.extra=[...first.tx.extra];tx.vout=[structuredClone(first.tx.vout[0])];tx.rct_signatures.ecdhInfo=[{amount:k.ecdh(amount)}];tx.rct_signatures.outPk=[k.commitment(amount)];}});
 assert.equal(l.applyBurnFees(first.txid,feeParts(first.tx)).paid[0].counted,true);
 const small=copy(5n);assert.deepEqual(l.applyBurnFees(small.txid,feeParts(small.tx)).paid,[{index:0,number:2,amount:'5',counted:false,error:'An earlier output with the same one-time key holds as much or more; a wallet keeps only one of them.'}]);
 assert.equal(l.burnFee(2).paid,(DUE/2n).toString());
 const big=copy(DUE);assert.equal(l.applyBurnFees(big.txid,feeParts(big.tx)).paid[0].counted,true);assert.equal(l.burnFee(2).paid,DUE.toString());assert.equal(l.toJSON().fees[0].outputs,1);
 // That is enough for a burn of Mordinal 2 now.
 assert.equal(apply(burn('after copies',2,w.dave)).owner,w.dave.address);});

test('a claim record while a burn waits for its fee: the first claim that completes wins',()=>{
 const {w,l,claim0,burn,apply,pay}=world();l.setHeight(FROM+1);
 // The holder of Mordinal 0 (alice) burned it, naming dave; before the fee is paid she claims it by record for herself.
 const t=burn('overtaken',0,w.dave),id=burnClaimId(DOMAIN,t.txid);apply(t);assert.equal(l.burnClaim(id).state,'waiting');
 l.setHeight(FROM+2);l.apply(claim0(0,w.alice));assert.equal(l.mordinal(0).owner,w.alice.address);
 assert.equal(l.burnClaim(id).state,'lost');assert.equal(l.burnClaim(id).lostAt,FROM+2);assert.equal(l.mordinal(0).waiting,null);assert.equal(l.toJSON().waiting,undefined);
 // The fee paid afterwards is kept and gives nothing; the record's claim stands.
 l.setHeight(FROM+3);assert.deepEqual(pay(0).claims,[]);assert.equal(l.mordinal(0).owner,w.alice.address);assert.deepEqual(l.mordinal(0).history.map(h=>h.what),['claim']);
 // Once the fee is paid, the burn has claimed it and a claim record is refused, also in the overlap.
 const u=burn('first',1,w.dave);pay(1);apply(u);assert.throws(()=>l.check(claim0(1,w.alice)),/already claimed/);
 // After the overlap a waiting burn is the only way left.
 const v=burn('late',3,w.carol);apply(v);l.setHeight(END);assert.throws(()=>l.check(claim0(3,w.bob)),/claimed only by burning it/);
 pay(3);assert.equal(l.mordinal(3).owner,w.carol.address);});

test('a ledger without a first burn block has no fee and no fee state',()=>{
 const {l}=world({burnFrom:null}),w=wallet('fee');l.setHeight(FROM+5);
 assert.equal(l.burn,null);assert.deepEqual(l.scanBurnFees(feeParts(payFee('none',2,DUE).tx)),[]);assert.throws(()=>l.applyBurnFees('aa'.repeat(32),{}),/not part of this ledger/);
 assert.equal(l.burnFee(2),null);assert.deepEqual(Object.keys(l.toJSON()),['height','claimed','lots','payments']);
 assert.throws(()=>createLedger({domain:DOMAIN,feeAddress:w.address,owners:[],burnFee:{address:FEE_WALLET.address,viewKey:FEE_WALLET.viewKey}}),/named only with a first burn block/);
 // A test chain names a fee wallet of its own; its fee addresses are its own.
 const own=wallet('lab fee'),named={address:own.address,viewKey:hex(own.viewSecret)},dead=[5,6,7,8,9,10,11,12,13,14,15,16,17,18,20];
 const owners=[ownerEntry(0,makeTx('own fee owner',[{to:wallet('alice'),amount:1n}]))];
 assert.throws(()=>createLedger({domain:DOMAIN,feeAddress:w.address,owners,burnFrom:FROM,burnFee:named}),/fee wallet is fixed/);
 const t=createLedger({domain:DOMAIN,feeAddress:w.address,owners,burnFrom:FROM,burnDead:dead,burnFee:named,testChain:true});t.setHeight(FROM);
 assert.equal(t.burn.fee.wallet,own.address);const fw=feeWallet(named,'mainnet',{testChain:true});
 assert.equal(t.applyBurnFees(...(p=>[p.txid,feeParts(p.tx)])(payFee('own wallet',0,7n,{wallet:fw}))).paid[0].counted,true);
 assert.throws(()=>t.applyBurnFees(...(p=>[p.txid,feeParts(p.tx)])(payFee('project wallet',0,7n))),/pays no fee address/);});

test('transaction public keys as wallet2 reads them: every key field, past merge-mining and 0xde fields; additional keys up to a broken entry',()=>{
 const w=feeWallet(),of=feeTable(w,[0,1,2,3,4,5]),pt=label=>[...G.multiply(Hs(enc.encode(label))).toRawBytes()];
 // 32 bytes that are no point of the curve.
 const broken=(()=>{for(let y=2;;y++){const b=leBytes(BigInt(y));try{Pt.fromHex(hex(b));}catch{return [...b];}}})();
 const decoy=pt('decoy key'),found=t=>feeOutputs(feeParts(t.tx),w,of).map(f=>[f.index,f.number,f.amount]);
 const base=payFee('keys',3,7n),R=base.tx.extra.slice(1,33),as=(label,extra)=>payFee('keys',3,7n,{tamper:tx=>{tx.extra=extra;}});
 assert.deepEqual(found(base),[[0,3,7n]]);
 // A second, third key field: wallet2 tries every one, in order.
 assert.deepEqual(found(as('second',[1,...decoy,1,...R])),[[0,3,7n]]);assert.deepEqual(walletKeys([1,...decoy,1,...R]).pubs.length,2);
 assert.deepEqual(found(as('third',[1,...decoy,1,...pt('other'),2,1,0,1,...R])),[[0,3,7n]]);
 // A first key that is no point, then the real one.
 assert.deepEqual(found(as('broken first',[1,...broken,1,...R])),[[0,3,7n]]);
 // Past a merge-mining tag (one string: a varint depth and a 32-byte hash) and past a 0xde field.
 assert.deepEqual(found(as('merge mining',[1,...decoy,3,33,5,...new Uint8Array(32).fill(7),1,...R])),[[0,3,7n]]);
 assert.deepEqual(found(as('minergate',[1,...decoy,0xde,3,9,9,9,1,...R])),[[0,3,7n]]);
 // Where wallet2 stops reading, this does too: a merge-mining tag of another length, the transfer field 0x11, any
 // other tag, padding, a length written long, a field cut short.
 for(const extra of [[1,...decoy,3,34,5,...new Uint8Array(33),1,...R],[1,...decoy,3,32,5,...new Uint8Array(31),1,...R],[1,...decoy,0x11,1,65,1,...R],[1,...decoy,0x10,1,65,1,...R],
  [1,...decoy,0,0,0,1,...R],[1,...decoy,2,0x81,0,1,...R],[1,...decoy,0xde,0x80,0x00,1,...R],[1,...decoy,2,200]])assert.deepEqual(found(as('stops',extra)),[],JSON.stringify(extra.slice(33,40)));
 // No key field at all: wallet2 passes the transaction over, additional keys or not.
 const two=payFee('no main',4,9n,{alongside:wallet('x')}),keys=two.tx.extra.slice(33);assert.equal(keys[0],4);
 assert.deepEqual(found(two),[[1,4,9n]]);assert.deepEqual(found({tx:{...two.tx,extra:[...keys]}}),[]);
 // An additional key counts only when every entry before it in the list is a point.
 const k=i=>keys.slice(2+32*i,34+32*i);
 assert.deepEqual(found({tx:{...two.tx,extra:[...two.tx.extra.slice(0,33),4,2,...broken,...k(1)]}}),[]);
 assert.deepEqual(found({tx:{...two.tx,extra:[...two.tx.extra.slice(0,33),4,2,...k(0),...broken]}}),[]);
 const first=makeTx('fee first',[{to:feeParty(5),amount:11n},{to:wallet('y'),amount:1n}]),fk=first.tx.extra.slice(35);
 assert.deepEqual(found({tx:{...first.tx,extra:[...first.tx.extra.slice(0,33),4,2,...fk.slice(0,32),...broken]}}),[[0,5,11n]]);
 // Only the first list of additional keys is read.
 assert.deepEqual(found({tx:{...two.tx,extra:[...two.tx.extra.slice(0,33),4,2,...decoy,...decoy,...keys]}}),[]);});

test('the outputs found once can be given back to the ledger, which then derives nothing; a list that does not fit is refused',()=>{
 const {l}=world(),t=payFee('given',2,DUE),parts=feeParts(t.tx);l.setHeight(FROM);
 const found=l.scanBurnFees(parts);assert.deepEqual(found,[{index:0,number:2,amount:DUE.toString(),error:null}]);
 for(const bad of [[{...found[0],index:3}],[{...found[0],number:99}],[{...found[0],amount:'x'}],[{...found[0],amount:null,error:null}],'x',[null]])
  assert.throws(()=>l.applyBurnFees(t.txid,parts,bad),/do not fit this transaction/);
 assert.deepEqual(l.applyBurnFees(t.txid,parts,JSON.parse(JSON.stringify(found))).paid,[{index:0,number:2,amount:DUE.toString(),counted:true,error:null}]);assert.equal(l.burnFee(2).paid,DUE.toString());});
