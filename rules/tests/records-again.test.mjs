// Offline tests of claim records counting again (RULES.md section 12), with made-up keys and transactions:
// node --test rules/tests/records-again.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {createLedger} from '../lib/ledger.mjs';
import {OP} from '../lib/records.mjs';
import {outputSecret,signWithOutputKey} from '../lib/claim.mjs';
import {RECORDS_OVERLAP,burnParts} from '../lib/burn.mjs';
import {feeParts} from '../lib/burn-fee.mjs';
import {wallet,makeTx,ownerEntry,makeInProof,makeBurn,payFee,DOMAIN} from './helpers.mjs';

const FROM=110,END=FROM+RECORDS_OVERLAP,AGAIN=END+50;
function world(o={}){
 const w=Object.fromEntries(['alice','bob','carol','dave','fee'].map(n=>[n,wallet(n)]));
 const holders=[w.alice,w.alice,w.bob,w.bob,w.carol,w.carol];
 const owners=holders.map((h,i)=>ownerEntry(i,makeTx('records world '+i,[{to:h,amount:10n**9n}])));     // owner outputs 1000 to 1005
 const l=createLedger({domain:DOMAIN,feeAddress:w.fee.address,owners,height:100,burnFrom:FROM,recordsFrom:AGAIN,...o});
 const key=(n,h)=>outputSecret({viewSecret:h.viewSecret,spendSecret:h.spendSecret,txPub:owners[n].ownerTxPubKeys[0],subScalar:h.subScalar});
 const claim0=(n,h,to=h)=>{const p=l.prepareClaim({mordinal:n,to:to.address});return l.claimWithKey(p.bodyBytes,signWithOutputKey(p.keyHash,key(n,h)));};
 const claim1=(n,h)=>{const p=l.prepareClaim({mordinal:n,to:h.address,holder:h.address});return l.claimWithProof(p.bodyBytes,makeInProof({txid:owners[n].ownerTx,txPub:owners[n].ownerTxPubKeys[0],holder:h}),h.sign(p.text));};
 const burn=(label,n,to)=>makeBurn(label,{output:1000+n,to});
 let paid=0;const pay=(n,amount=10n**9n+30000000n)=>{const t=payFee('records fee '+paid++,n,amount);return l.applyBurnFees(t.txid,feeParts(t.tx));};
 return {w,l,owners,claim0,claim1,burn,pay};}

test('the setting: a whole block at or after the block where claim records stopped, on a ledger that burns',()=>{
 const w=wallet('fee'),owners=[ownerEntry(0,makeTx('records setting',[{to:wallet('alice'),amount:10n**9n}]))],make=o=>createLedger({domain:DOMAIN,feeAddress:w.address,owners,height:100,...o});
 assert.equal(make({burnFrom:FROM}).records,null);assert.deepEqual(make({burnFrom:FROM,recordsFrom:END}).records,{from:END});
 for(const bad of [{recordsFrom:AGAIN},{burnFrom:FROM,recordsFrom:END-1},{burnFrom:FROM,recordsFrom:FROM},{burnFrom:FROM,recordsFrom:AGAIN+0.5},{burnFrom:FROM,recordsFrom:String(AGAIN)}])
  assert.throws(()=>make(bad),/Bad first block of claim records counting again/);});

test('claim records are refused between the end of the overlap and the new first block, and count from it on',()=>{
 const {w,l,claim0,claim1,burn,pay}=world();
 l.setHeight(END-1);l.apply(claim0(0,w.alice));assert.equal(l.mordinal(0).owner,w.alice.address);
 const c1=claim0(1,w.alice),c4=claim1(4,w.carol);
 for(const h of [END,AGAIN-1]){l.setHeight(h);
  assert.throws(()=>l.check(c1),new RegExp(`Claim records count again from block ${AGAIN}\\.`));assert.throws(()=>l.apply(c4),/Claim records count again/);}
 // A burn in between claims as before.
 const b2=burn('between',2,w.dave);pay(2);l.applyBurnClaim(b2.txid,burnParts(b2.tx));assert.equal(l.mordinal(2).owner,w.dave.address);
 l.setHeight(AGAIN);
 assert.equal(l.check(c1).op,OP.claim);l.apply(c1);assert.equal(l.mordinal(1).owner,w.alice.address);
 l.apply(c4);assert.equal(l.mordinal(4).owner,w.carol.address);
 assert.deepEqual(l.mordinal(1).history.at(-1).proof,'one-time key');assert.deepEqual(l.mordinal(4).history.at(-1).proof,'payment proof and message');
 // Once per Mordinal, whichever way: a claimed Mordinal is not claimed again by record or by burning its coin.
 assert.throws(()=>l.check(claim0(2,w.bob)),/already claimed/);
 const late=burn('after a record',1,w.dave);assert.throws(()=>l.checkBurnClaim(late.txid,burnParts(late.tx)),/already claimed/);
 // Burns go on beside the records, and the first claim of a Mordinal that completes wins.
 const b3=burn('beside',3,w.dave);pay(3);l.applyBurnClaim(b3.txid,burnParts(b3.tx));assert.equal(l.mordinal(3).owner,w.dave.address);assert.throws(()=>l.check(claim0(3,w.bob)),/already claimed/);
 // A Mordinal claimed by record moves and sells like any other.
 const mv=l.prepareMove({mordinal:1,from:w.alice.address,to:w.bob.address});l.apply(l.sign(mv.bodyBytes,w.alice.sign(mv.text)));assert.equal(l.mordinal(1).owner,w.bob.address);});

test('a ledger without the setting keeps refusing claim records after the overlap',()=>{
 const {w,l,claim0}=world({recordsFrom:null});l.setHeight(AGAIN+10);
 assert.throws(()=>l.check(claim0(0,w.alice)),/From block 830 a Mordinal is claimed only by burning it; a claim record no longer counts/);});
