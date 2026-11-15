// Offline tests of claiming by burning (RULES.md section 10) with made-up keys and transactions, and with one real pair
// of mainnet transactions kept in fixtures-burn.json: node --test rules/tests/burn.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {keccak_256} from '@noble/hashes/sha3';
import {createLedger} from '../lib/ledger.mjs';
import {OP,encodeBody} from '../lib/records.mjs';
import {hex,unhex,concat,encodeAddress,base58Encode,decodeAddress} from '../lib/monero.mjs';
import {outputSecret,signWithOutputKey} from '../lib/claim.mjs';
import {BURN,BURN_SPEND_TEXT,BURN_VIEW_TEXT,MAINNET_DEAD,RECORDS_OVERLAP,EXTRA_LIMIT,isMainnetDead,burnAddress,hashToPoint,deadOutputs,recordCost,claimText,burnClaimId,readTransfer,transferExtra,claimTo,burnParts,movedOutput,paysBurnAddress} from '../lib/burn.mjs';
import {wallet,makeTx,ownerEntry,makeInProof,makeBurn,burnParty,input,scalar,DOMAIN} from './helpers.mjs';
import {transferOf,parseExtra,recordCost as originalCost} from './original-rules.mjs';
const FIX=JSON.parse(readFileSync(new URL('./fixtures-burn.json',import.meta.url),'utf8')),enc=new TextEncoder();
const XMR=10n**12n,FROM=110,END=FROM+RECORDS_OVERLAP,ORIGINAL={deadAbove:70499730,deadBelow:70499747};
// What the original rules make of a made-up transaction.
const original=(t,o=ORIGINAL)=>transferOf({extra:t.tx.extra,inputs:t.tx.vin.map(i=>i.key.key_offsets),fee:t.tx.rct_signatures.txnFee},o);

function world(o={}){
 const w=Object.fromEntries(['alice','bob','carol','dave','fee'].map(n=>[n,wallet(n)]));
 const holders=[w.alice,w.alice,w.bob,w.bob,w.carol,w.carol];
 const owners=holders.map((h,i)=>ownerEntry(i,makeTx('burn world '+i,[{to:h,amount:10n**9n}])));     // owner outputs 1000 to 1005
 const l=createLedger({domain:DOMAIN,feeAddress:w.fee.address,owners,height:100,burnFrom:FROM,...o});
 const key=(n,h)=>outputSecret({viewSecret:h.viewSecret,spendSecret:h.spendSecret,txPub:owners[n].ownerTxPubKeys[0],subScalar:h.subScalar});
 const claim0=(n,h,to=h)=>{const p=l.prepareClaim({mordinal:n,to:to.address});return l.claimWithKey(p.bodyBytes,signWithOutputKey(p.keyHash,key(n,h)));};
 const claim1=(n,h)=>{const p=l.prepareClaim({mordinal:n,to:h.address,holder:h.address});return l.claimWithProof(p.bodyBytes,makeInProof({txid:owners[n].ownerTx,txPub:owners[n].ownerTxPubKeys[0],holder:h}),h.sign(p.text));};
 const burn=(label,n,to,more={})=>makeBurn(label,{output:1000+n,to,...more});
 const apply=t=>l.applyBurnClaim(t.txid,burnParts(t.tx)),refused=(t,why)=>assert.throws(()=>l.checkBurnClaim(t.txid,burnParts(t.tx)),why);
 return {w,l,owners,key,claim0,claim1,burn,apply,refused};}

test('hash_to_ec and the burn address: derived as stated, equal to the published keys',()=>{
 for(const [from,point] of FIX.hashToEc)assert.equal(hex(hashToPoint(unhex(from)).toRawBytes()),point);assert.equal(FIX.hashToEc.length,32);
 assert.deepEqual(BURN,{spend:FIX.burnAddress.spend,view:FIX.burnAddress.view,viewSecret:FIX.burnAddress.viewSecret});
 assert.equal(BURN.spend,hex(hashToPoint(keccak_256(enc.encode(BURN_SPEND_TEXT))).toRawBytes()));
 assert.equal(BigInt('0x'+[...unhex(BURN.viewSecret)].reverse().map(b=>b.toString(16).padStart(2,'0')).join('')),BigInt('0x'+[...keccak_256(enc.encode(BURN_VIEW_TEXT))].reverse().map(b=>b.toString(16).padStart(2,'0')).join(''))%(2n**252n+27742317777372353535851937790883648493n));
 assert.equal(burnAddress(),FIX.burnAddress.mainnet);assert.equal(burnAddress('stagenet'),FIX.burnAddress.stagenet);
 // A point of the main group that is not the neutral point, like any spend key; its secret key is what nobody has.
 const a=decodeAddress(burnAddress());assert.equal(hex(a.spend),BURN.spend);assert.equal(hex(a.view),BURN.view);assert.equal(burnParty.address,burnAddress());});

test('the original fee rule, the dead outputs and the text',()=>{
 for(const [size,cost] of [[0,0n],[1,10n**9n],[111,10n**9n],[250,10n**9n],[251,2n*10n**9n],[500,2n*10n**9n],[501,3n*10n**9n]]){assert.equal(recordCost(size),cost);assert.equal(originalCost(size),cost);}
 assert.deepEqual(deadOutputs(null),[70499731,70499732,70499733,70499734,70499735,70499736,70499737,70499738,70499739,70499740,70499741,70499742,70499743,70499744,70499746]);
 assert.ok(!MAINNET_DEAD.includes(70499745));assert.equal(MAINNET_DEAD.length,15);
 assert.throws(()=>deadOutputs(null,'stagenet'),/has to name its fifteen dead outputs/);assert.throws(()=>deadOutputs(null,'mainnet',{testChain:true}),/has to name its fifteen dead outputs/);
 // On mainnet the list is mainnet's: named or not, and nothing else. Only a test chain, or another network, names its own.
 assert.deepEqual(deadOutputs([...MAINNET_DEAD].reverse()),[...MAINNET_DEAD]);assert.equal(isMainnetDead(deadOutputs(null)),true);assert.equal(isMainnetDead([5,6,7,8,9,10,11,12,13,14,15,16,17,18,20]),false);
 assert.throws(()=>deadOutputs([5,6,7,8,9,10,11,12,13,14,15,16,17,18,20]),/On mainnet the dead outputs are fixed/);assert.throws(()=>deadOutputs([...MAINNET_DEAD.slice(0,14),70499745]),/On mainnet the dead outputs are fixed/);
 assert.deepEqual(deadOutputs([20,5,6,7,8,9,10,11,12,13,14,15,16,17,18],'mainnet',{testChain:true}),[5,6,7,8,9,10,11,12,13,14,15,16,17,18,20]);assert.deepEqual(deadOutputs([20,5,6,7,8,9,10,11,12,13,14,15,16,17,18],'stagenet'),[5,6,7,8,9,10,11,12,13,14,15,16,17,18,20]);
 assert.equal(RECORDS_OVERLAP,720);assert.equal(EXTRA_LIMIT,1060);
 for(const bad of [[],[1,2,3],[...MAINNET_DEAD,70499745],[...MAINNET_DEAD.slice(1),70499732],[...MAINNET_DEAD.slice(1),-1],[...MAINNET_DEAD.slice(1),1.5]])assert.throws(()=>deadOutputs(bad,'mainnet',{testChain:true}),/fifteen different global output indexes/);
 const a=wallet('alice'),sub=a.sub(2),text=t=>claimTo(enc.encode(t));
 assert.equal(text(claimText(a.address)),a.address);assert.equal(text('xmr721 claim to '+sub.address),sub.address);
 // One line end after the address is taken, as a text file often has one; the saved cases say what else is and is not.
 for(const who of [a,sub]){for(const ok of FIX.texts.accepted)assert.equal(text(ok.replaceAll('{address}',who.address)),who.address,JSON.stringify(ok));
  for(const bad of FIX.texts.refused)assert.throws(()=>text(bad.replaceAll('{address}',who.address)),/nothing else/,JSON.stringify(bad));}
 assert.equal(text('xmr721 claim to '+a.address+'\n'),a.address);assert.equal(text('xmr721 claim to '+a.address+'\r\n'),a.address);assert.deepEqual(FIX.texts.accepted.map(x=>x.slice(25)),['','\n','\r\n']);
 for(const end of ['\n\n',' ','\r','\n\r','\r\n\n',' \n','\n '])assert.throws(()=>text('xmr721 claim to '+a.address+end),/nothing else/,JSON.stringify(end));
 // A long text is refused before it is read, whatever it holds.
 assert.throws(()=>claimTo(new Uint8Array(200000).fill(65)),/nothing else/);assert.throws(()=>text('xmr721 claim to '+'1'.repeat(109)),/nothing else/);
 const integrated=(()=>{const body=concat(Uint8Array.of(19),a.spend,a.view,new Uint8Array(8).fill(7));return base58Encode(concat(body,keccak_256(body).subarray(0,4)));})();assert.equal(integrated.length,106);
 const stagenet=wallet('alice','stagenet').address,flipped=a.address.slice(0,-1)+(a.address.endsWith('1')?'2':'1');
 const small=encodeAddress({spend:Uint8Array.of(1,...new Uint8Array(31)),view:a.view}),smallView=encodeAddress({spend:a.spend,view:Uint8Array.of(1,...new Uint8Array(31))});
 for(const [bad,why] of [['',/nothing else/],[a.address,/nothing else/],['xmr721 claim to',/nothing else/],['xmr721 claim to ',/nothing else/],['xmr721 claim to '+a.address+' ',/nothing else/],['xmr721 claim to '+a.address+'\n\n',/nothing else/],
  [' xmr721 claim to '+a.address,/nothing else/],['XMR721 claim to '+a.address,/nothing else/],['xmr721 claim to  '+a.address,/nothing else/],['xmr721 claim to '+a.address+' and more',/nothing else/],['xmr721 claim to '+a.address+a.address,/nothing else/],['xmr721 claim to '+a.address+'1',/95 characters/],['xmr721 claim to '+integrated+'\n',/not an integrated address/],
  ['xmr721 claim to '+a.address.slice(0,94),/95 characters/],['xmr721 claim to '+integrated,/not an integrated address/],['xmr721 claim to '+stagenet,/stagenet address/],['xmr721 claim to '+flipped,/cannot be used/],
  ['xmr721 claim to '+small,/key no wallet can use/],['xmr721 claim to '+smallView,/key no wallet can use/],['xmr721 claim to '+a.address.replace(/.$/,'é'),/nothing else/]])assert.throws(()=>text(bad),why,JSON.stringify(bad));
 assert.equal(claimTo(enc.encode('xmr721 claim to '+stagenet),'stagenet'),stagenet);});

test('a transfer is read from tx_extra more strictly than the original parser reads it, never differently',()=>{
 const pub=keccak_256(enc.encode('a public key')),text=enc.encode('xmr721 claim to somebody'),plain=[...transferExtra(pub,text)],withId=[...transferExtra(pub,text,{paymentId:new Uint8Array(8).fill(9)})];
 const same=e=>{const mine=readTransfer(e),theirs=parseExtra(e);assert.ok(mine,JSON.stringify(e));assert.equal(theirs.ok,true);assert.ok(!theirs.fields.some(f=>f.tag===0x10));
  assert.equal(hex(theirs.fields.find(f=>f.tag===0x11).meta),hex(mine.text));assert.equal(hex(theirs.fields.find(f=>f.tag===1).key),mine.txPub);return mine;};
 assert.equal(hex(same(plain).text),hex(text));assert.equal(same(withId).txPub,hex(pub));assert.deepEqual(readTransfer(Uint8Array.from(withId)),readTransfer(withId));
 const keys=[4,2,...pub,...pub],long=enc.encode('x'.repeat(300));
 same([1,...pub,...keys,0x11,text.length,...text]);same([0x11,text.length,...text,1,...pub]);same([1,...pub,1,...keccak_256(pub),0x11,text.length,...text]);same([1,...pub,2,0,0x11,0]);
 assert.equal(same([...transferExtra(pub,long)]).text.length,300);assert.equal(same([1,...pub,0x11,0]).text.length,0);
 // At most 1,060 bytes, like a record's tx_extra: one byte more is no transfer, whatever it holds, and a list or a byte string alike.
 {const nonces=n=>{const out=[];while(n>0){const k=Math.min(n,129);out.push(2,k-2,...new Uint8Array(k-2));n-=k;}return out;},fill=n=>[1,...pub,...nonces(n-35-text.length),0x11,text.length,...text],at=fill(1060),over=fill(1061);
  assert.equal(at.length,1060);assert.equal(over.length,1061);assert.equal(hex(same(at).text),hex(text));assert.equal(readTransfer(over),null);assert.equal(readTransfer(Uint8Array.from(over)),null);assert.equal(parseExtra(over).ok,true);   // (the original parser has no such limit; a node relays no such transaction)
  assert.equal(readTransfer([1,...pub,0x11,0xa0,0x9c,1,...new Uint8Array(20000).fill(66)]),null);assert.equal(readTransfer(new Uint8Array(5_000_000)),null);}
 // Not a transfer here: no public key, no text, two texts, a registration, padding, any other field, a length written long, bytes left over.
 for(const bad of [[],[1,...pub],[0x11,text.length,...text],[...plain,0x11,1,65],[...plain,0x10,1,65,1,66],[0x10,1,65,1,66,...plain],[...plain,0],[...plain,0,0],[...plain,3,1,0],[...plain,0xde,1,0],[...plain,0x12],[...plain,0x13],[...plain,5],
  [1,...pub,0x11,0x80|text.length,0,...text],[1,...pub,0x11,text.length+1,...text],[1,...pub,0x11,text.length-1,...text],[1,...pub.subarray(1),0x11,0],[1,...pub,2,0x80,2,...new Uint8Array(256),0x11,0],[1,...pub,4,1,0x11,0],[...plain,2,5,1],
  [1,...pub,0x11,0x80,0x80,0x80,0x80,1],'text',null,undefined,[1,...pub,0x11,0,256],[1,...pub,0x11,0,-1],[1,...pub,0x11,0,1.5]])assert.equal(readTransfer(bad),null,JSON.stringify(bad));});

test('a burn claim: the Mordinal belongs to the address in the text, as after a claim record',()=>{
 const {w,l,owners,claim0,burn,apply,refused}=world();
 assert.deepEqual(l.burn,{from:FROM,recordsEnd:END,dead:[...MAINNET_DEAD],address:burnAddress()});
 l.setHeight(FROM);
 const t=burn('first',2,w.carol),out=apply(t);
 assert.deepEqual(out,{id:burnClaimId(DOMAIN,t.txid),number:2,owner:w.carol.address});
 const m=l.mordinal(2);assert.equal(m.claimed,true);assert.equal(m.owner,w.carol.address);assert.equal(m.seq,0);assert.equal(m.lot,null);
 assert.deepEqual(m.history,[{what:'claim',height:FROM,record:out.id,to:w.carol.address,proof:'burn',tx:t.txid}]);assert.deepEqual(l.owned(w.carol.address),[2]);
 // The original rules read the same transaction as a transfer of the same output.
 assert.deepEqual(original(t),{moved:1002,text:claimText(w.carol.address)});
 // The same state as a ledger where that Mordinal was claimed by a record.
 const other=world({burnFrom:null}),p=other.l.prepareClaim({mordinal:2,to:w.carol.address});other.l.setHeight(FROM);
 other.l.apply(other.l.claimWithKey(p.bodyBytes,signWithOutputKey(p.keyHash,other.key(2,w.bob))));assert.deepEqual(l.toJSON(),other.l.toJSON());
 // What follows works as after any claim: carol sends it on, with move 0.
 const mv=l.prepareMove({mordinal:2,from:w.carol.address,to:w.dave.address});l.apply(l.sign(mv.bodyBytes,w.carol.sign(mv.text)));assert.equal(l.mordinal(2).owner,w.dave.address);assert.equal(l.mordinal(2).seq,1);
 // A subaddress in the text, no payment id in tx_extra, more inputs behind the ring, more outputs, a larger fee, additional public keys.
 const sub=w.alice.sub(4);assert.equal(apply(burn('second',0,sub,{paymentId:false,after:[input([11,22,33,44,55,66,77,88,99,111,222,333,444,555,666,777])],fee:5n*XMR})).owner,sub.address);
 const extraKeys=burn('third',4,w.dave,{tamper:tx=>{tx.extra=[...tx.extra.slice(0,33),4,2,...keccak_256(enc.encode('k1')),...keccak_256(enc.encode('k2')),...tx.extra.slice(33)];}});
 assert.equal(apply(extraKeys).number,4);assert.equal(original(extraKeys).moved,1004);
 // An ordinary input in front of the ring: the original rules pass over it, and so does this rule.
 const behind=burn('fourth',5,w.dave,{before:[input([3,70499731,70499732,90000000,90000001,90000002,90000003,90000004,90000005,90000006,90000007,90000008,90000009,90000010,90000011,90000012])]});
 assert.equal(apply(behind).number,5);assert.equal(original(behind).moved,1005);
 // The check and the apply say the same, and nothing is left to claim twice.
 refused(burn('again',2,w.bob),/already claimed/);refused(burn('again 2',5,w.bob),/already claimed/);
 assert.deepEqual(l.toJSON().claimed.map(c=>c.number),[0,2,4,5]);});

test('a burn claim is refused: text, fee, ring, owner output, burn address',()=>{
 const {w,l,burn,refused,apply}=world();l.setHeight(FROM+5);
 const good=burn('good',1,w.carol);assert.equal(l.checkBurnClaim(good.txid,burnParts(good.tx)).number,1);
 // The text.
 refused(burn('t1',1,w.carol,{text:'xmr721 claim to '+w.carol.address+'\n\n'}),/nothing else/);refused(burn('t1b',1,w.carol,{text:'xmr721 claim to '+w.carol.address+' '}),/nothing else/);
 // One line end is part of an accepted text; the fee rule then counts it (113 bytes are still 0.001 XMR), and the original rules agree.
 for(const end of ['\n','\r\n']){const t=burn('t1 '+JSON.stringify(end),1,w.carol,{text:'xmr721 claim to '+w.carol.address+end});assert.equal(l.checkBurnClaim(t.txid,burnParts(t.tx)).owner,w.carol.address);assert.equal(original(t).moved,1001);}
 refused(burn('t2',1,w.carol,{text:'claim to '+w.carol.address}),/nothing else/);
 refused(burn('t3',1,w.carol,{text:''}),/nothing else/);
 refused(burn('t4',1,w.carol,{text:'xmr721 claim to '+wallet('carol','stagenet').address}),/stagenet address/);
 {const a=w.carol,body=concat(Uint8Array.of(19),a.spend,a.view,new Uint8Array(8).fill(1)),integrated=base58Encode(concat(body,keccak_256(body).subarray(0,4)));
  refused(burn('t5',1,w.carol,{text:'xmr721 claim to '+integrated}),/not an integrated address/);}
 // The fee: the original rules would ignore the transfer.
 const cheap=burn('f1',1,w.carol,{fee:10n**9n-1n});refused(cheap,/fee is below the 0\.001 XMR the original rules ask for a text of 111 bytes/);assert.equal(original(cheap).why,'fee below the record cost');
 refused(burn('f2',1,w.carol,{fee:0n}),/fee is below/);refused(burn('f3',1,w.carol,{tamper:tx=>{delete tx.rct_signatures.txnFee;}}),/fee is below/);
 assert.equal(l.checkBurnClaim(good.txid,burnParts(burn('f4',1,w.carol,{fee:10n**9n}).tx)).number,1);
 // The ring. 70499745 is dead for the original rules and not here: such a ring moves the Mordinal there and claims nothing here.
 const with45=burn('r1',1,w.carol,{ring:[...MAINNET_DEAD.slice(1),70499745,1001]});refused(with45,/holds output 70499745, which is not one of the dead outputs/);assert.equal(original(with45).moved,1001);
 const stranger=burn('r2',1,w.carol,{ring:[...MAINNET_DEAD.slice(1),90000000,1001]});refused(stranger,/No input of this transaction has a ring of the dead outputs and one owner output/);assert.equal(original(stranger).moved,null);
 refused(burn('r3',1,w.carol,{ring:[...MAINNET_DEAD,1001,90000000]}),/No input/);
 refused(burn('r4',1,w.carol,{ring:[...MAINNET_DEAD]}),/No input/);
 refused(burn('r5',1,w.carol,{ring:[...MAINNET_DEAD,70499745]}),/No input/);
 refused(burn('r6',1,w.carol,{ring:[...MAINNET_DEAD.slice(2),1001]}),/fifteen dead outputs and the owner output, nothing else/);
 refused(burn('r7',1,w.carol,{ring:[1001]}),/nothing else/);
 refused(burn('r8',1,w.carol,{tamper:tx=>{tx.vin[0].key.amount=1000000;}}),/nothing else/);
 refused(burn('r9',1,w.carol,{tamper:tx=>{tx.vin=[];}}),/No input/);
 refused(burn('r10',1,w.carol,{tamper:tx=>{tx.vin=[{gen:{height:5}}];}}),/No input/);
 // The first ring the original rules would take decides, whatever follows it.
 const first45=burn('r11',1,w.carol,{before:[input([...MAINNET_DEAD.slice(1),70499745,1003])]});refused(first45,/holds output 70499745/);assert.equal(original(first45).moved,1003);
 const firstOther=burn('r12',1,w.carol,{before:[input([...MAINNET_DEAD,1003])]});assert.equal(l.checkBurnClaim(firstOther.txid,burnParts(firstOther.tx)).number,3);assert.equal(original(firstOther).moved,1003);
 // The owner output.
 const unknown=burn('o1',1,w.carol,{output:777777});refused(unknown,/Output 777777, which the ring names, is not the owner output of a Mordinal on the owner list/);
 // Output 0 and the burn address.
 refused(burn('b1',1,w.carol,{outs:[{to:w.carol,amount:1n},{to:burnParty,amount:1n}]}),/Output 0 of this transaction does not pay the burn address/);
 refused(burn('b2',1,w.carol,{outs:[{to:w.carol,amount:1n}]}),/does not pay the burn address/);
 refused(burn('b3',1,w.carol,{tamper:tx=>{const t=tx.vout[0].target.tagged_key;t.view_tag=t.view_tag==='00'?'01':'00';}}),/does not pay the burn address/);
 refused(burn('b4',1,w.carol,{tamper:tx=>{tx.vout=[];}}),/does not pay the burn address/);
 refused(burn('b5',1,w.carol,{tamper:tx=>{tx.extra=[1,...keccak_256(enc.encode('another key')),...tx.extra.slice(33)];}}),/does not pay the burn address/);
 // The burn address is paid only through the first transaction public key: one found through an additional key is not counted.
 {const t=burn('b6',1,w.carol),real=t.tx.extra.slice(1,33);t.tx.extra=[1,...keccak_256(enc.encode('decoy key')),4,2,...real,...real,...t.tx.extra.slice(33)];refused(t,/does not pay the burn address/);}
 // An output without a view tag (the older output form) is judged by its key alone.
 {const t=burn('b7',1,w.carol);t.tx.vout[0].target={key:t.tx.vout[0].target.tagged_key.key};assert.equal(l.checkBurnClaim(t.txid,burnParts(t.tx)).number,1);}
 // Not a transfer at all, or one that also registers.
 refused(burn('x1',1,w.carol,{tamper:tx=>{tx.extra=tx.extra.slice(0,33);}}),/carries no transfer in the original Mordinals format/);
 const both=burn('x2',1,w.carol,{tamper:tx=>{tx.extra=[...tx.extra,0x10,1,65,1,66];}});refused(both,/carries no transfer/);assert.equal(original(both).why,'a registration');
 assert.throws(()=>l.checkBurnClaim('zz',burnParts(good.tx)),/Transaction ID required/);assert.throws(()=>l.checkBurnClaim(good.txid,null),/carries no transfer/);assert.throws(()=>l.checkBurnClaim(good.txid,{extra:'zz'}),/carries no transfer/);
 // None of the refusals changed anything.
 assert.deepEqual(l.toJSON().claimed,[]);assert.equal(apply(good).number,1);});

test('burns count from the first burn block; claim records count for 720 blocks more, and the first valid claim wins',()=>{
 const {w,l,claim0,claim1,burn,apply,refused}=world();
 l.setHeight(FROM-1);
 refused(burn('early',2,w.carol),/Claiming by burning starts at block 110/);
 l.apply(claim0(0,w.alice));assert.equal(l.mordinal(0).owner,w.alice.address);
 // In the overlap both count. A holder whose burn was mined a block early, where it claimed nothing, claims by record
 // with the one-time key: that needs the keys, not the coin.
 l.setHeight(FROM);
 l.apply(claim1(4,w.carol));assert.equal(l.mordinal(4).owner,w.carol.address);
 l.apply(claim0(2,w.bob,w.carol));assert.equal(l.mordinal(2).owner,w.carol.address);refused(burn('early again',2,w.dave),/already claimed/);
 // The first valid claim wins, whichever kind it is.
 const b3=burn('three',3,w.dave);apply(b3);assert.throws(()=>l.check(claim0(3,w.bob)),/This Mordinal is already claimed/);assert.equal(l.mordinal(3).owner,w.dave.address);
 // Claimed before the first burn block: it stays claimed, moves on as before, and cannot be claimed again by burning its coin.
 refused(burn('late',0,w.dave),/already claimed/);
 const mv=l.prepareMove({mordinal:0,from:w.alice.address,to:w.bob.address});l.apply(l.sign(mv.bodyBytes,w.alice.sign(mv.text)));assert.equal(l.mordinal(0).owner,w.bob.address);
 // The last block of the overlap, and the first block after it.
 const late0=claim0(1,w.alice),late1=claim1(5,w.carol);
 l.setHeight(END-1);assert.equal(l.check(late0).op,OP.claim);assert.equal(l.check(late1).op,OP.claim);
 l.setHeight(END);assert.equal(END,830);
 assert.throws(()=>l.check(late0),/From block 830 a Mordinal is claimed only by burning it; a claim record no longer counts/);assert.throws(()=>l.apply(late1),/claimed only by burning it/);
 // The refusal comes before the checks of the claim itself (here: a Mordinal that is claimed already).
 assert.throws(()=>l.check(claim0(0,w.alice,w.dave)),/claimed only by burning it/);
 // Burns go on, and two burn claims of one Mordinal are one claim: the first.
 const one=burn('one',1,w.carol),two=burn('two',1,w.dave);assert.equal(l.checkBurnClaim(two.txid,burnParts(two.tx)).owner,w.dave.address);
 apply(one);refused(two,/already claimed/);assert.throws(()=>apply(two),/already claimed/);assert.equal(l.mordinal(1).owner,w.carol.address);
 // A ledger without the setting: claim records count at any height, and no burn does.
 const plain=world({burnFrom:null});plain.l.setHeight(END+100);assert.equal(plain.l.burn,null);
 plain.refused(plain.burn('none',2,w.carol),/Claiming by burning is not part of this ledger/);plain.l.apply(plain.claim0(2,w.bob));assert.equal(plain.l.mordinal(2).owner,w.bob.address);});

test('the setting: a first burn block, dead outputs for a chain that is not mainnet, owner outputs named once',()=>{
 const w=wallet('alice'),fee=wallet('fee'),owners=[0,1].map(i=>ownerEntry(i,makeTx('setting '+i,[{to:w,amount:10n**9n}]))),base={domain:DOMAIN,feeAddress:fee.address,owners,height:10};
 for(const bad of [0,-1,1.5,'7'])assert.throws(()=>createLedger({...base,burnFrom:bad}),/Bad first burn block/);
 assert.throws(()=>createLedger({...base,burnDead:[...MAINNET_DEAD]}),/only with a first burn block/);
 assert.throws(()=>createLedger({...base,burnFrom:20,burnDead:[1,2,3],testChain:true}),/fifteen different/);
 assert.throws(()=>createLedger({...base,burnFrom:20,owners:[owners[0],{...owners[1],ownerOutputIndex:owners[0].ownerOutputIndex}]}),/repeats an owner output/);
 // Without the setting the same list is taken as before: the index is not looked at.
 createLedger({...base,owners:[owners[0],{...owners[1],ownerOutputIndex:owners[0].ownerOutputIndex}]});
 // A test chain names its own dead outputs: here 5 to 20 without 19, the shape of mainnet's.
 // On mainnet itself no other list is taken: a ledger says that it stands on a test chain.
 const dead=[5,6,7,8,9,10,11,12,13,14,15,16,17,18,20];assert.throws(()=>createLedger({...base,burnFrom:20,burnDead:dead}),/On mainnet the dead outputs are fixed/);
 assert.throws(()=>createLedger({...base,burnFrom:20,testChain:true}),/has to name its fifteen dead outputs/);assert.deepEqual(createLedger({...base,burnFrom:20,burnDead:[...MAINNET_DEAD]}).burn.dead,[...MAINNET_DEAD]);
 const l=createLedger({...base,burnFrom:20,burnDead:dead,testChain:true});l.setHeight(20);assert.deepEqual(l.burn.dead,dead);
 const ok=makeBurn('chain 1',{output:1001,to:w,dead}),with19=makeBurn('chain 2',{output:1001,to:w,ring:[...dead.slice(1),19,1001]}),mainnet=makeBurn('chain 3',{output:1001,to:w});
 assert.throws(()=>l.checkBurnClaim(with19.txid,burnParts(with19.tx)),/holds output 19, which is not one of the dead outputs/);
 assert.throws(()=>l.checkBurnClaim(mainnet.txid,burnParts(mainnet.tx)),/No input/);
 assert.equal(l.applyBurnClaim(ok.txid,burnParts(ok.tx)).number,1);assert.equal(original(ok,{deadAbove:4,deadBelow:21}).moved,1001);
 // Every entry has to state its owner output's index: a ledger that claims by burning does not open without it.
 const {ownerOutputIndex,...bare}=owners[0];
 for(const entry of [bare,{...bare,ownerOutputIndex:null},{...bare,ownerOutputIndex:'1000'},{...bare,ownerOutputIndex:-1},{...bare,ownerOutputIndex:1.5}])assert.throws(()=>createLedger({...base,owners:[entry,owners[1]],burnFrom:20}),/Owner list entry 0 does not state the global index of its owner output/);
 createLedger({...base,owners:[bare,owners[1]]});
 // On stagenet the list has to be named, and the text takes stagenet addresses.
 const sw=wallet('alice','stagenet'),sfee=wallet('fee','stagenet');assert.throws(()=>createLedger({...base,network:'stagenet',feeAddress:sfee.address,burnFrom:20}),/has to name its fifteen dead outputs/);
 const s=createLedger({...base,network:'stagenet',feeAddress:sfee.address,burnFrom:20,burnDead:dead});s.setHeight(20);assert.equal(s.burn.address,burnAddress('stagenet'));
 const st=makeBurn('chain 5',{output:1000,to:sw,dead});assert.equal(s.applyBurnClaim(st.txid,burnParts(st.tx)).owner,sw.address);
 assert.throws(()=>s.checkBurnClaim(ok.txid,burnParts(ok.tx)),/mainnet address/);});

test('the real mainnet pair: a registration and its transfer to the burn address are a burn claim',()=>{
 const {registration:reg,burn,claimedBy}=FIX.mainnet,fee=wallet('fee');
 assert.equal(reg.txid,'82079d96b982ee6307e74f4aa8b6235adc5be062326da309e905cb8ae8203729');assert.equal(burn.txid,'cde1971f8012dbae22c137c9280a08e0a37aa37f00ff58cf8920b93d10a12af2');
 assert.equal(reg.height,3806656);assert.equal(burn.height,3806759);assert.equal(reg.outputIndices[0],167798895);
 // The owner list entry of that inscription, as the ownership index writes one: output 0 of its registration.
 const out=reg.tx.vout[0].target.tagged_key,entry={number:50000,registrationTx:reg.txid,ownerTx:reg.txid,ownerOutputIndex:reg.outputIndices[0],ownerOutputKey:out.key,ownerViewTag:out.view_tag,
  ownerTxPubKeys:[hex(Uint8Array.from(reg.tx.extra.slice(1,33)))],ownerAdditionalPubKeys:[]};
 const filler=ownerEntry(1,makeTx('real filler',[{to:wallet('alice'),amount:10n**9n}]));
 const l=createLedger({domain:DOMAIN,feeAddress:fee.address,owners:[filler,entry],height:3806700,burnFrom:3806701});l.setHeight(burn.height);
 const parts=burnParts(burn.tx);
 assert.deepEqual(parts.inputs,[{amount:0,offsets:[70499731,1,1,1,1,1,1,1,1,1,1,1,1,1,2,97299149]}]);assert.equal(parts.fee,'1033160000');
 assert.deepEqual(parts.out0,{key:'36b9b4f0280435fd3992f7835cbbb7e7017c1559421df1ec5d696b1799a279f0',tag:'8a'});assert.equal(parts.extra,hex(Uint8Array.from(burn.tx.extra)));
 const t=readTransfer(burn.tx.extra);assert.equal(Buffer.from(t.text).toString(),'xmr721 claim to '+claimedBy);assert.equal(t.text.length,111);
 assert.equal(movedOutput(parts.inputs,MAINNET_DEAD),167798895);assert.equal(paysBurnAddress({txPub:t.txPub,...parts.out0}),true);
 assert.equal(paysBurnAddress({txPub:t.txPub,key:burn.tx.vout[1].target.tagged_key.key,tag:burn.tx.vout[1].target.tagged_key.view_tag}),false);
 assert.deepEqual(l.applyBurnClaim(burn.txid,parts),{id:burnClaimId(DOMAIN,burn.txid),number:50000,owner:claimedBy});assert.equal(l.mordinal(50000).owner,claimedBy);
 // The original rules read the pair the same way, and the registration is no transfer.
 assert.deepEqual(transferOf({extra:burn.tx.extra,inputs:burn.tx.vin.map(i=>i.key.key_offsets),fee:burn.tx.rct_signatures.txnFee},ORIGINAL),{moved:167798895,text:'xmr721 claim to '+claimedBy});
 assert.equal(readTransfer(reg.tx.extra),null);assert.throws(()=>l.checkBurnClaim(reg.txid,burnParts(reg.tx)),/carries no transfer/);
 // Read through JSON, as a journal keeps it, the parts say the same.
 const again=createLedger({domain:DOMAIN,feeAddress:fee.address,owners:[filler,entry],height:3806700,burnFrom:3806701});again.setHeight(burn.height);
 assert.equal(again.applyBurnClaim(burn.txid,JSON.parse(JSON.stringify(parts))).owner,claimedBy);});
