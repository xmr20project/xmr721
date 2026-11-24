// Offline tests of claiming by a spent coin (RULES.md section 11) with made-up keys and transactions:
// node --test rules/tests/spend.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {keccak_256} from '@noble/hashes/sha3';
import {createLedger} from '../lib/ledger.mjs';
import {OP,PROOF,decodeRecord,MAX_RECORD} from '../lib/records.mjs';
import {hex,unhex,le,leBytes} from '../lib/monero.mjs';
import {outputSecret,signWithOutputKey} from '../lib/claim.mjs';
import {RECORDS_OVERLAP,MAINNET_DEAD,burnParts} from '../lib/burn.mjs';
import {feeParts} from '../lib/burn-fee.mjs';
import {SPEND_FEE,verifyKeyImageProof,signKeyImage,originalTransfer,mayHaveMoved,keyImagesOf} from '../lib/spend.mjs';
import {wallet,makeTx,ownerEntry,makeInProof,makeBurn,payFee,offsetsOf,DOMAIN} from './helpers.mjs';
import {parseExtra} from './original-rules.mjs';
const enc=new TextEncoder(),FROM=110,SPEND=120,END=FROM+RECORDS_OVERLAP;
// Fixed nonces, so a test run makes the same records every time.
const det=label=>n=>Uint8Array.from({length:n},(_,i)=>keccak_256(enc.encode('spend test nonce '+label+' '+i))[0]);
// An ordinary transaction that spends the given key images, as get_transactions decode_as_json shows it (inputs and extra).
let spends=0;
function spendTx(images,{extra=null}={}){const n=spends++,R=[...keccak_256(enc.encode('spend tx key '+n))];
 return {txid:hex(keccak_256(enc.encode('spend tx '+n))),tx:{version:2,vin:images.map(k=>({key:{amount:0,key_offsets:[1,2],k_image:k}})),extra:extra??[1,...R,2,9,1,...Array(8).fill(7)]}};}

function world(o={}){
 const w=Object.fromEntries(['alice','bob','carol','fee'].map(n=>[n,wallet(n)]));
 const holders=[w.alice,w.alice.sub(3),w.bob,w.carol];
 const owners=holders.map((h,i)=>ownerEntry(i,makeTx('spend world '+i,[{to:h,amount:10n**9n}],{subaddressKey:h.kind==='sub'})));
 const l=createLedger({domain:DOMAIN,feeAddress:w.fee.address,owners,height:100,burnFrom:FROM,spendFrom:SPEND,...o});
 const secret=n=>outputSecret({viewSecret:holders[n].viewSecret,spendSecret:holders[n].spendSecret,txPub:owners[n].ownerTxPubKeys[0],subScalar:holders[n].subScalar});
 // The holder's key image export for coin n, and the transaction that spent the coin.
 const signed=n=>signKeyImage(secret(n),det('ki '+n));
 // The claim record (proof 2): holder h of coin n, to `to`, coin spent in `s`.
 const record=(n,{h=holders[n],to=h,s,ki=signed(n),inProof=makeInProof({txid:owners[n].ownerTx,txPub:owners[n].ownerTxPubKeys[0],holder:h}),sign=h.sign}={})=>{
  const p=l.prepareClaim({mordinal:n,to:to.address,holder:h.address,spendTx:s.txid,keyImage:ki.keyImage});return {p,bytes:l.claimWithSpend(p.bodyBytes,inProof,{c:ki.c,r:ki.r},sign(p.text))};};
 let paid=0;const pay=(n,amount=SPEND_FEE)=>{const t=payFee('spend world fee '+paid++,n,amount);return l.applyBurnFees(t.txid,feeParts(t.tx));};
 return {w,holders,owners,l,secret,signed,record,pay};}

test('the signed key image: made as wallet2 makes it, verified for its own coin only',()=>{
 const {signed,owners,secret}=world();
 for(const n of [0,1,2]){const s=signed(n);assert.equal(s.outputKey,owners[n].ownerOutputKey);assert.ok(verifyKeyImageProof(s));
  assert.ok(!verifyKeyImageProof({...s,outputKey:owners[(n+1)%3].ownerOutputKey}),'another coin');
  const bad=unhex(s.c);bad[3]^=1;assert.ok(!verifyKeyImageProof({...s,c:hex(bad)}),'a changed byte');
  assert.ok(!verifyKeyImageProof({...s,keyImage:signed((n+1)%3).keyImage}),'another key image');}
 // The key image is x·Hp(P), the one a wallet spends the coin with.
 assert.notEqual(signed(0).keyImage,signed(1).keyImage);assert.ok(secret(0)>0n);});

test('the original rules\' reading: a transfer moves a Mordinal only with a ring of the dead range and its owner output',()=>{
 const R=Array(32).fill(9),T=[0x11,3,65,66,67];
 for(const extra of [[1,...R],[1,...R,2,9,1,...Array(8).fill(0)],[1,...R,4,2,...R,...R],[],'x',[1,...R,256]])assert.equal(originalTransfer(extra),false,JSON.stringify(extra).slice(0,40));
 assert.equal(originalTransfer([1,...R,...T]),true);assert.equal(originalTransfer([1,...R,4,1,...R,2,9,1,...Array(8).fill(0),...T]),true);
 assert.equal(originalTransfer([0x10,1,0,1,0,1,...R,...T]),false,'a registration moves nothing');
 assert.equal(originalTransfer([1,...R,0x99,...T]),false,'an unknown field ends the reading');
 assert.equal(originalTransfer([1,...R,0x11,9,65]),false,'a transfer field cut short');
 assert.equal(originalTransfer([1,...R,0,0,1,...T]),false,'padding that is not all zeros ends the reading');
 assert.equal(originalTransfer([1,...R,2,0x80,0,...T]),false,'a length not written the shortest way ends the reading');
 // As the 2023 indexer reads (src/common/varint.h, src/cryptonote_basic/tx_extra.h): a length the end cuts short is the
 // value read so far, field 0x12 ends in two 8-byte numbers, a merge mining tag holds exactly a varint and 32 bytes.
 assert.equal(originalTransfer([1,...R,0x11]),true,'a transfer field with nothing after its tag');assert.equal(originalTransfer([1,...R,0x11,0x80]),true);
 assert.equal(originalTransfer([1,...R,0x11,0x85]),false,'a length longer than what follows');
 assert.equal(originalTransfer([1,...R,0x12,0,...R,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,...T]),true,'field 0x12 with two 8-byte numbers');
 assert.equal(originalTransfer([1,...R,...T,0x03,0,0x10,0,0]),true,'a merge mining tag that does not read ends the reading before the registration');
 assert.equal(originalTransfer([1,...R,0x03,33,5,...R,0x10,0,0,...T]),false,'a merge mining tag that reads, then a registration');
 assert.equal(originalTransfer([1,...R,2,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0x02,...T]),false,'a varint above 64 bits');
 assert.equal(originalTransfer([1,...R,2,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0x01]),false,'a 64-bit length: no such bytes');
 // The reading written again in original-rules.mjs (parseExtra, from the same source) agrees on many made-up extras.
 {const reads=x=>{const {fields}=parseExtra(x);return fields.some(f=>f.tag===0x11)&&!fields.some(f=>f.tag===0x10);};
  const rnd=(()=>{let n=0;return k=>keccak_256(enc.encode('extra fuzz '+n++))[0]%k;})();
  const piece=()=>{const k=rnd(13),len=rnd(6);return [[1,...R],[2,len,...Array(len).fill(7)],[0x11,len,...Array(len).fill(65)],[0x10,len,...Array(len).fill(1),0],[0x03,33,rnd(3),...R],[0x03,len,...Array(len).fill(2)],
   [0x04,1,...R],[0x04,len],[0x12,0,...R,...Array(16).fill(0)],[0x13,...R,0,...R],[0xde,len,...Array(len).fill(3)],[0,0,0],[rnd(256)]][k];};
  let agree=0;for(let i=0;i<4000;i++){let x=[];for(let j=1+rnd(5);j>0;j--)x.push(...piece());if(rnd(3)===0)x=x.slice(0,rnd(x.length+1));
   assert.equal(originalTransfer(x),reads(x),JSON.stringify(x).slice(0,120));agree++;}
  assert.equal(agree,4000);}
 const dead=MAINNET_DEAD,own=o=>o===1003,ring=r=>({key:{amount:0,k_image:'a'.repeat(64),key_offsets:offsetsOf(r)}}),plain=ring([5,9,100,1003,4000]),tx=(extra,vin)=>({extra,vin});
 assert.equal(mayHaveMoved(tx([1,...R,...T],[ring([...dead,1003])]),own,dead),true,'a transfer of this Mordinal');
 assert.equal(mayHaveMoved(tx([1,...R,...T],[ring([...dead,1002]),ring([...dead,1003])]),own,dead),true,'not the deciding ring: counted all the same');
 assert.equal(mayHaveMoved(tx([1,...R,...T],[ring([...dead,1002]),plain]),own,dead),false,'a transfer of another Mordinal that also spent this coin');
 assert.equal(mayHaveMoved(tx([1,...R],[ring([...dead,1003])]),own,dead),false,'no transfer field');
 assert.equal(mayHaveMoved(tx([0x10,1,0,1,0,1,...R,...T],[ring([...dead,1003])]),own,dead),false,'a registration');
 assert.equal(mayHaveMoved(tx([1,...R,...T],[ring([...dead.slice(1),1003,5])]),own,dead),false,'two members outside the dead range');
 assert.equal(mayHaveMoved(tx([1,...R,...T],[{key:{k_image:'a'.repeat(64)}}]),own,dead),false,'no ring');
 assert.deepEqual(keyImagesOf({vin:[{key:{k_image:'a'.repeat(64)}},{gen:{height:1}}]}),['a'.repeat(64)]);});

test('a claim by a spent coin: waits for its fee, then belongs to the address in it',()=>{
 const {l,holders,owners,record,pay,w}=world();l.setHeight(SPEND+5);
 const s=spendTx([world().signed(1).keyImage]);
 // (the same coin: world() is deterministic)
 const {p,bytes}=record(1,{to:w.carol,s});
 assert.match(p.text,new RegExp(`^Mordinals claim: Mordinal #1 \\(inscription ${owners[1].registrationTx}\\), held by output 0 of ${owners[1].ownerTx} and spent in ${s.txid}, now belongs to ${w.carol.address}; code [0-9a-f]{32}$`));
 const d=decodeRecord(bytes);assert.equal(d.op,OP.claim);assert.equal(d.body.proof,PROOF.spend);assert.equal(d.body.spendTx,s.txid);assert.equal(d.body.holder,holders[1].address);
 assert.equal(bytes.length,489);assert.ok(bytes.length<=MAX_RECORD);
 const out=l.apply(bytes,[{txid:s.txid,height:SPEND+2,tx:s.tx}]);
 assert.equal(out.owner,null);assert.equal(out.waiting.due,SPEND_FEE.toString());assert.equal(out.waiting.kind,'spend');assert.equal(out.waiting.missing,SPEND_FEE.toString());
 assert.equal(l.mordinal(1).claimed,false);assert.equal(l.burnClaim(out.id).state,'waiting');
 // Half the fee: still waiting. The rest: claimed, with the record's id.
 assert.deepEqual(pay(1,SPEND_FEE/2n).claims,[]);
 const done=pay(1,SPEND_FEE);assert.deepEqual(done.claims,[{id:out.id,number:1,owner:w.carol.address}]);
 const m=l.mordinal(1);assert.equal(m.claimed,true);assert.equal(m.owner,w.carol.address);assert.deepEqual(m.history.at(-1),{what:'claim',height:SPEND+5,record:out.id,to:w.carol.address,proof:'spent coin',tx:s.txid});
 // Claimed: the same record again, or another claim, is refused.
 assert.throws(()=>l.check(bytes,[{txid:s.txid,height:SPEND+2,tx:s.tx}]),/already on the ledger/);
 assert.deepEqual(l.toJSON().claimed.find(x=>x.number===1),{number:1,owner:w.carol.address,seq:0,lot:null,history:['claim']});});

test('a fee paid before the claim: it is claimed at once',()=>{
 const {l,record,pay,signed,w}=world();l.setHeight(SPEND+1);pay(2,SPEND_FEE+5n);l.setHeight(SPEND+3);
 const s=spendTx([signed(2).keyImage]),{bytes}=record(2,{s}),out=l.apply(bytes,[{txid:s.txid,height:SPEND+2,tx:s.tx}]);
 assert.equal(out.owner,w.bob.address);assert.equal(l.mordinal(2).history.at(-1).proof,'spent coin');});

test('refused: each check of section 11, with its reason',()=>{
 const {l,record,signed,w,owners,holders}=world();const s=spendTx([signed(0).keyImage]),fact={txid:s.txid,height:SPEND+2,tx:s.tx},{bytes}=record(0,{s});
 // Before the first block of claims by a spent coin.
 l.setHeight(SPEND-1);assert.throws(()=>l.check(bytes,[fact]),new RegExp(`starts at block ${SPEND}`));l.setHeight(SPEND+5);
 assert.throws(()=>l.check(bytes,[]),/was not looked up/);
 assert.throws(()=>l.check(bytes,[{...fact,height:null}]),/not in a block yet/);
 assert.throws(()=>l.check(bytes,[{...fact,height:SPEND+5}]),/in a block before the block of this record/);
 const other=spendTx([signed(2).keyImage]);
 {const r=record(0,{s:other});assert.throws(()=>l.check(r.bytes,[{txid:other.txid,height:SPEND+2,tx:other.tx}]),/does not spend the owner coin/);}
 for(const extra of [[...s.tx.extra,0x11,3,65,66,67],[0x10,1,0,...s.tx.extra],[...s.tx.extra,0]])
  assert.equal(l.check(bytes,[{...fact,tx:{...s.tx,extra}}]).body.proof,PROOF.spend,'no transfer of this Mordinal: '+extra.slice(-6));
 // A transfer of this Mordinal in the original format (here a burn of it, made with this coin): it moved there.
 const T=[0x11,3,65,66,67],dr=o=>({key:{amount:0,key_offsets:offsetsOf([...MAINNET_DEAD,o]),k_image:signed(0).keyImage}});
 assert.throws(()=>l.check(bytes,[{...fact,tx:{...s.tx,extra:[...s.tx.extra,...T],vin:[dr(1000)]}}]),/is a transfer of this Mordinal in the original Mordinals format/);
 // A transfer field with nothing after its tag is a transfer there with an empty text: the same.
 assert.throws(()=>l.check(bytes,[{...fact,tx:{...s.tx,extra:[...s.tx.extra.slice(0,33),0x11],vin:[dr(1000)]}}]),/is a transfer of this Mordinal in the original Mordinals format/);
 // A transfer of another Mordinal that spent this coin beside it moves nothing of it.
 assert.equal(l.check(bytes,[{...fact,tx:{...s.tx,extra:[...s.tx.extra,...T],vin:[{...dr(1002),key:{...dr(1002).key,k_image:'b'.repeat(64)}},...s.tx.vin]}}]).body.proof,PROOF.spend);
 // Another coin's signed key image, or a changed byte of it.
 {const k=signed(2),r=record(0,{s,ki:k});assert.throws(()=>l.check(r.bytes,[fact]),/not the key image of the owner coin/);}
 {const k=signed(0),c=unhex(k.c);c[0]^=1;const r=record(0,{s,ki:{...k,c:hex(c)}});assert.throws(()=>l.check(r.bytes,[fact]),/not the key image of the owner coin/);}
 // The payment proof and the message, as for proof 1.
 {const r=record(0,{s,inProof:makeInProof({txid:owners[0].ownerTx,txPub:owners[0].ownerTxPubKeys[0],holder:w.bob,viewSecret:w.bob.viewSecret}),h:holders[0]});assert.throws(()=>l.check(r.bytes,[fact]),/payment proof is not valid/);}
 assert.throws(()=>record(0,{s,sign:w.bob.sign}),/not for this text and address/);
 // Someone else's address as holder: their payment proof fails (they did not receive the coin).
 {const r=record(0,{s,h:w.bob,inProof:makeInProof({txid:owners[0].ownerTx,txPub:owners[0].ownerTxPubKeys[0],holder:w.bob})});assert.throws(()=>l.check(r.bytes,[fact]),/did not receive output 0/);}
 // All good: accepted, and a second claim of the same Mordinal waits behind it.
 const first=l.apply(bytes,[fact]);assert.equal(first.owner,null);
 const again=record(0,{s,to:w.carol});assert.throws(()=>l.check(again.bytes,[fact]),/waits for its fee already/);});

test('the setting: needs a first burn block at or before it; a ledger without it refuses proof 2',()=>{
 const w=wallet('fee'),owners=[ownerEntry(0,makeTx('setting 0',[{to:wallet('alice'),amount:1}]))],base={domain:DOMAIN,feeAddress:w.address,owners,height:100};
 assert.throws(()=>createLedger({...base,spendFrom:120}),/needs a first burn block/);
 assert.throws(()=>createLedger({...base,burnFrom:130,spendFrom:120}),/needs a first burn block/);
 for(const bad of [0,1.5,'130'])assert.throws(()=>createLedger({...base,burnFrom:110,spendFrom:bad}),/Bad first block of claims by a spent coin/);
 assert.equal(createLedger({...base,burnFrom:110,spendFrom:110}).spend.from,110);
 assert.equal(createLedger({...base,burnFrom:110}).spend,null);
 const {record,signed,owners:o2,w:w2}=world();const l=createLedger({domain:DOMAIN,feeAddress:w2.fee.address,owners:o2,height:100,burnFrom:FROM});
 l.setHeight(SPEND+5);const s=spendTx([signed(0).keyImage]);
 // (a record made on the other ledger: same domain and owners, so the same bytes)
 assert.throws(()=>l.check(record(0,{s}).bytes,[{txid:s.txid,height:SPEND+2,tx:s.tx}]),/not part of this ledger/);});

test('after claim records stop, proof 2 still counts and proofs 0 and 1 do not',()=>{
 const {l,record,signed,w,owners,holders}=world();l.setHeight(END+3);
 const s=spendTx([signed(3).keyImage]),{bytes}=record(3,{s});assert.equal(l.check(bytes,[{txid:s.txid,height:END+1,tx:s.tx}]).body.proof,PROOF.spend);
 const p=l.prepareClaim({mordinal:3,to:w.carol.address,holder:w.carol.address});
 assert.throws(()=>l.check(l.claimWithProof(p.bodyBytes,makeInProof({txid:owners[3].ownerTx,txPub:owners[3].ownerTxPubKeys[0],holder:holders[3]}),w.carol.sign(p.text))),/no longer counts/);});

test('while claim records still count, a claim record overtakes a claim by a spent coin that waits for its fee',()=>{
 const {l,record,signed,secret,pay,w}=world();l.setHeight(SPEND+5);
 const s=spendTx([signed(0).keyImage]),{bytes}=record(0,{s,to:w.carol}),out=l.apply(bytes,[{txid:s.txid,height:SPEND+2,tx:s.tx}]);assert.equal(out.owner,null);
 const p=l.prepareClaim({mordinal:0,to:w.bob.address});l.apply(l.claimWithKey(p.bodyBytes,signWithOutputKey(p.keyHash,secret(0))));
 assert.equal(l.mordinal(0).owner,w.bob.address);assert.equal(l.burnClaim(out.id).state,'lost');
 assert.deepEqual(pay(0).claims,[]);assert.equal(l.mordinal(0).owner,w.bob.address);});

test('a burn that waits for its fee holds the Mordinal against a claim by a spent coin',()=>{
 const {l,record,signed}=world();l.setHeight(SPEND+5);
 const t=makeBurn('spend world burn',{output:1002,to:wallet('dave')});l.applyBurnClaim(t.txid,burnParts(t.tx));
 const s=spendTx([signed(2).keyImage]),{bytes}=record(2,{s});
 assert.throws(()=>l.check(bytes,[{txid:s.txid,height:SPEND+2,tx:s.tx}]),/burned already; that burn waits for its fee/);});

test('key images exported by Feather 2 itself are accepted, each for its own coin only',async()=>{
 const {readFileSync}=await import('node:fs'),FIX=JSON.parse(readFileSync(new URL('./fixtures-spend.json',import.meta.url),'utf8'));
 assert.equal(FIX.feather.length,3);
 for(const [i,k] of FIX.feather.entries()){assert.ok(verifyKeyImageProof(k),k.coin);assert.ok(!verifyKeyImageProof({...k,outputKey:FIX.feather[(i+1)%3].outputKey}),k.coin+' with another coin');}});
