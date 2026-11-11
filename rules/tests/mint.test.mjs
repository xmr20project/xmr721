// Offline tests of creating, minting and burning (records 7, 8, 9) with made-up keys: node --test tests/mint.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createLedger} from '../lib/ledger.mjs';
import {OP,RULES,MAX_RECORD,NO_COLLECTION,encodeBody,decodeRecord,codeOf} from '../lib/records.mjs';
import {concat,hex} from '../lib/monero.mjs';
import {sha256} from '@noble/hashes/sha256';
import {frame,unframe,EXTRA_LIMIT} from '../../reader/lib/transport.mjs';
import {outputSecret,signWithOutputKey} from '../lib/claim.mjs';
import {wallet,makeTx,ownerEntry,fact,entries,payees,DOMAIN} from './helpers.mjs';

const XMR=10n**12n,PNG=1,TEXT=5;
function world(){
 const w=Object.fromEntries(['alice','bob','carol','dave','fee'].map(n=>[n,wallet(n)])),by=new Map(Object.values(w).map(x=>[x.address,x]));
 const txs=[makeTx('held by alice',[{to:w.alice,amount:10n**9n}]),makeTx('held by bob',[{to:w.bob,amount:10n**9n}])],owners=txs.map((t,i)=>ownerEntry(i,t));
 const l=createLedger({domain:DOMAIN,feeAddress:w.fee.address,owners,height:100,mintFrom:100});
 const signed=(p,who)=>l.sign(p.bodyBytes,who.sign(p.text));
 const collection=(creator,name,max)=>{const p=l.prepareCollection({creator:creator.address,name,max});l.apply(signed(p,creator));return p.id;};
 const mintRecord=(creator,o)=>{const p=l.prepareMint({creator:creator.address,type:PNG,content:randomBytes(40),...o});return {...p,record:signed(p,creator)};};
 const mint=(creator,o)=>{const m=mintRecord(creator,o);l.apply(m.record);return m.id;};
 const raw=(op,body,signer)=>{const b=encodeBody(op,body);return l.sign(b,signer.sign(l.textOf(b)));};
 const claim=(n,holder)=>{const p=l.prepareClaim({mordinal:n,to:holder.address});
  l.apply(l.claimWithKey(p.bodyBytes,signWithOutputKey(p.keyHash,outputSecret({viewSecret:holder.viewSecret,spendSecret:holder.spendSecret,txPub:owners[n].ownerTxPubKeys[0],subScalar:holder.subScalar}))));};
 return {w,by,l,signed,collection,mintRecord,mint,raw,claim,owners};}

test('minting is a setting of the ledger: off unless a first block is named, and refused before that block',()=>{
 const {w,l,owners,mintRecord,signed}=world(),m=mintRecord(w.alice,{}),c=signed(l.prepareCollection({creator:w.alice.address,name:'Set',max:1}),w.alice);
 const plain=createLedger({domain:DOMAIN,feeAddress:w.fee.address,owners,height:100});
 for(const r of [m.record,c])assert.throws(()=>plain.check(r),/Minting and burning are not part of this ledger/);
 const later=createLedger({domain:DOMAIN,feeAddress:w.fee.address,owners,height:100,mintFrom:150});
 assert.throws(()=>later.check(m.record),/Minting and burning start at block 150/);later.setHeight(150);assert.equal(later.apply(m.record).owner,w.alice.address);
 assert.throws(()=>createLedger({domain:DOMAIN,feeAddress:w.fee.address,owners,mintFrom:0}),/Bad first mint block/);});

test('a mint fits one relayed transaction: 824 bytes of name and content, 759 when minted to another address',()=>{
 const {w,l,mintRecord}=world();
 const most=mintRecord(w.alice,{content:randomBytes(824)});
 assert.equal(most.record.length,MAX_RECORD);assert.equal(MAX_RECORD,1000);
 const extra=frame(most.record,randomBytes(32));assert.ok(extra.length<=EXTRA_LIMIT,'extra field is '+extra.length);assert.deepEqual(unframe(extra),most.record);
 assert.equal(l.apply(most.record).owner,w.alice.address);
 const over=mintRecord(w.alice,{content:randomBytes(825)});assert.equal(over.record.length,1001);
 assert.throws(()=>l.check(over.record),/at most 1000 bytes; this one is 1001/);
 assert.equal(mintRecord(w.alice,{to:w.bob.address,content:randomBytes(759)}).record.length,MAX_RECORD);
 assert.equal(mintRecord(w.alice,{name:'A name of 20 letters',content:randomBytes(804)}).record.length,MAX_RECORD,'a name comes out of the same room');
 assert.equal(mintRecord(w.alice,{content:randomBytes(700),origin:{kind:1,ref:'ab'.repeat(36)}}).record.length,176+700+2+36+0);
 // Sizes of the other new records.
 const c=l.prepareCollection({creator:w.alice.address,name:'Sixteen letters!',max:100});assert.equal(c.bodyBytes.length+65,5+65+4+1+1+16+65);
});

test('records 7, 8 and 9 decode in one way only',()=>{
 const {w,l,mintRecord,raw}=world(),m=mintRecord(w.alice,{name:'One',to:w.bob.address,origin:{kind:1,ref:'00ff'}}),d=decodeRecord(m.record);
 assert.deepEqual({op:d.op,name:d.body.name,to:d.body.to,type:d.body.type,size:d.body.content.length,origin:d.body.origin,collection:d.body.collection,edition:d.body.edition},
  {op:OP.mint,name:'One',to:w.bob.address,type:1,size:40,origin:{kind:1,ref:'00ff'},collection:NO_COLLECTION,edition:0});
 assert.throws(()=>decodeRecord(concat(m.record,Uint8Array.of(0))),/extra bytes/);assert.throws(()=>decodeRecord(m.record.slice(0,-1)),/truncated/);
 const at=5+32+4+65,flags=m.record.slice();flags[at]=7;assert.throws(()=>decodeRecord(flags),/Unknown mint flags/);
 const body=o=>encodeBody(OP.mint,{creator:w.alice.address,type:1,content:Uint8Array.of(1),...o});
 assert.throws(()=>body({edition:1}),/Bad edition number/);assert.throws(()=>body({collection:'ab'.repeat(32)}),/Bad edition number/);
 assert.throws(()=>body({type:0}),/Content type required/);assert.throws(()=>body({content:[]}),/Content required/);
 for(const name of [' lead','trail ','tab\there','é','x'.repeat(65)])assert.throws(()=>body({name}),/A name is at most 64 plain characters/,JSON.stringify(name));
 assert.throws(()=>body({origin:{kind:0,ref:'00'}}),/Bad origin/);assert.throws(()=>body({origin:{kind:1,ref:''}}),/Bad origin/);
 // The first owner is written only when it differs from the creator, so there is one spelling.
 assert.equal(hex(body({to:w.alice.address})),hex(body({})));
 const twice=body({to:w.bob.address}).slice();twice.set(twice.subarray(5+36,5+36+65),at+1);assert.throws(()=>decodeRecord(twice,'mainnet',{sig:false}),/only when it is not the creator/);
 assert.throws(()=>encodeBody(OP.collection,{creator:w.alice.address,name:'',max:5}),/A name is 1 to 64/);
 assert.throws(()=>encodeBody(OP.collection,{creator:w.alice.address,name:'Set',max:0}),/1 to 10000 editions/);assert.throws(()=>encodeBody(OP.collection,{creator:w.alice.address,name:'Set',max:10001}),/1 to 10000 editions/);
 const c=encodeBody(OP.collection,{creator:w.alice.address,name:'Set',max:5}).slice();c[5+65+4]=1;assert.throws(()=>decodeRecord(c,'mainnet',{sig:false}),/Unknown collection flags/);
 assert.equal(decodeRecord(raw(OP.collection,{creator:w.alice.address,name:'Set',max:5},w.alice)).body.max,5);
});

test('a collection: only its creator mints, each edition once, up to its size',()=>{
 const {w,l,collection,mint,mintRecord,signed}=world();
 assert.deepEqual(Object.keys(l.toJSON()),['height','claimed','lots','payments'],'nothing new in the summary before a mint');
 const set=collection(w.alice,'Test Set',3);assert.deepEqual(l.collection(set),{id:set,creator:w.alice.address,name:'Test Set',max:3,height:100,editions:[]});
 const p1=l.prepareMint({collection:set,edition:1,creator:w.alice.address,name:'First',type:TEXT,content:Buffer.from('hello')});
 assert.equal(p1.text,`XMR721 mint: edition 1 of "Test Set" named "First"; 5 bytes of type 5, SHA-256 ${hex(sha256(Buffer.from('hello')))}; first owner ${w.alice.address}; code ${p1.code}`);
 const first=l.apply(signed(p1,w.alice));assert.deepEqual(first,{id:p1.id,nft:p1.id,owner:w.alice.address,number:null});
 const second=mint(w.alice,{collection:set,edition:2,to:w.bob.address});assert.equal(l.nft(second).owner,w.bob.address);
 assert.deepEqual(l.nft(p1.id).minted,{collection:set,edition:1,creator:w.alice.address,name:'First',type:5,size:5,sha256:hex(sha256(Buffer.from('hello')))});
 assert.deepEqual([l.nftsOf(w.alice.address),l.nftsOf(w.bob.address),l.owned(w.bob.address)],[[p1.id],[second],[]]);
 assert.throws(()=>l.check(signed(p1,w.alice)),/already on the ledger/);
 assert.throws(()=>l.check(mintRecord(w.alice,{collection:set,edition:1}).record),/This edition is already minted/);
 assert.throws(()=>l.check(mintRecord(w.bob,{collection:set,edition:3}).record),/Only the creator of this collection can mint into it/);
 assert.throws(()=>l.prepareMint({collection:set,edition:4,creator:w.alice.address,type:1,content:[1]})&&l.check(mintRecord(w.alice,{collection:set,edition:4}).record),/This collection has 3 editions/);
 assert.throws(()=>l.prepareMint({collection:'cd'.repeat(32),edition:1,creator:w.alice.address,type:1,content:[1]}),/This collection does not exist/);
 // A signature by someone else, or for another text, does not count.
 const p3=l.prepareMint({collection:set,edition:3,creator:w.alice.address,type:1,content:[9]});
 assert.throws(()=>l.sign(p3.bodyBytes,w.bob.sign(p3.text)),/not for this text and address/);
 const forged=concat(p3.bodyBytes,l.sign(p1.bodyBytes,w.alice.sign(p1.text)).slice(p1.bodyBytes.length));assert.throws(()=>l.check(forged),/signature does not match/);
 l.apply(signed(p3,w.alice));assert.deepEqual(l.collection(set).editions,[1,2,3]);
 // Two collections may share a name; they are told apart by id.
 assert.notEqual(collection(w.bob,'Test Set',3),set);
 const sum=l.toJSON();assert.equal(sum.collections.length,2);assert.equal(sum.minted.length,3);assert.deepEqual(sum.claimed,[]);
});

test('anyone mints an NFT that belongs to no collection',()=>{
 const {w,l,mint}=world(),id=mint(w.carol,{name:'Alone'});
 assert.equal(l.nft(id).owner,w.carol.address);assert.equal(l.nft(id).minted.collection,NO_COLLECTION);assert.equal(l.nft('ee'.repeat(32)),null);
 assert.equal(l.textOf(l.prepareMove({mordinal:id,from:w.carol.address,to:w.dave.address}).bodyBytes).split(';')[0],`Mordinals move: send NFT ${codeOf(id)} to ${w.dave.address}`);
});

test('a minted NFT is sent and sold with the same records as a Mordinal, with the same 5% fee',()=>{
 const {w,by,l,collection,mint,signed}=world(),set=collection(w.alice,'Test Set',10),id=mint(w.alice,{collection:set,edition:7});
 const move=l.prepareMove({mordinal:id,from:w.alice.address,to:w.carol.address});
 assert.match(move.text,new RegExp(`^Mordinals move: send "Test Set" #7 \\(NFT ${codeOf(id)}\\) to `));
 l.apply(signed(move,w.alice));assert.equal(l.nft(id).owner,w.carol.address);assert.equal(l.nft(id).seq,1);
 assert.throws(()=>l.check(signed(move,w.alice)),/already on the ledger/);assert.throws(()=>l.prepareMove({mordinal:id,from:w.alice.address,to:w.bob.address}),/belongs to another address/);
 l.setHeight(101);const lot=l.prepareList({mordinal:id,seller:w.carol.address,price:2n*XMR});l.apply(signed(lot,w.carol));
 assert.match(lot.text,/^Mordinals list: sell "Test Set" #7 \(NFT [0-9a-f]{32}\) for 2 XMR \(1\.9 XMR to /);
 l.setHeight(102);const res=l.prepareReserve({lot:lot.id,buyer:w.bob.address});l.apply(signed(res,w.bob));assert.match(res.text,/; NFT to /);
 l.setHeight(103);const paid=makeTx('pay for minted',res.pay.map(x=>({to:by.get(x.to),amount:x.amount})));
 const out=l.apply(l.buyRecord({lot:lot.id,payments:entries(payees(l,lot.id,w.fee.address),[paid],lot.id)}),[fact(paid,103)]);
 assert.equal(out.owner,w.bob.address);assert.equal(l.nft(id).owner,w.bob.address);
 assert.equal(BigInt(out.paid.seller)-BigInt(out.paid['protocol fee']),2n*XMR*BigInt(10000-2*RULES.feeBps)/10000n,'95% and 5%, each with the same small tail');
 assert.deepEqual(l.nft(id).history.map(h=>h.what),['mint','move','sale']);
});

test('burn: the owner ends an NFT for good',()=>{
 const {w,l,mint,signed,claim}=world(),id=mint(w.alice,{name:'Short life'});
 assert.throws(()=>l.prepareBurn({nft:id,owner:w.bob.address}),/belongs to another address/);
 // Not while it is for sale.
 const lot=l.prepareList({mordinal:id,seller:w.alice.address,price:XMR});l.apply(signed(lot,w.alice));
 const early=l.prepareBurn({nft:id,owner:w.alice.address});assert.throws(()=>l.check(signed(early,w.alice)),/listed for sale; cancel the listing first/);
 const stop=l.prepareCancel({lot:lot.id,seller:w.alice.address});l.apply(signed(stop,w.alice));
 assert.throws(()=>l.check(signed(early,w.alice)),/signed for an earlier state/,'the cancel moved the counter on');
 const burn=l.prepareBurn({nft:id,owner:w.alice.address});
 assert.equal(burn.text,`XMR721 burn: destroy NFT ${codeOf(id)} for good; burn 1; code ${burn.code}`);
 assert.throws(()=>l.sign(burn.bodyBytes,w.bob.sign(burn.text)),/not for this text and address/);
 assert.deepEqual(l.apply(signed(burn,w.alice)),{id:burn.id,nft:id,number:null,owner:null});
 const n=l.nft(id);assert.deepEqual([n.owner,n.burned,n.history.at(-1).what],[null,true,'burn']);assert.deepEqual(l.nftsOf(w.alice.address),[]);
 // Nothing can be done with it afterwards.
 const dead=(op,body)=>concat(encodeBody(op,body),Uint8Array.of(0),new Uint8Array(64));
 for(const r of [dead(OP.move,{reg:id,seq:2,from:w.alice.address,to:w.bob.address}),dead(OP.list,{reg:id,seq:2,until:900,price:XMR,seller:w.alice.address}),dead(OP.burn,{nft:id,seq:2,owner:w.alice.address})])
  assert.throws(()=>l.check(r),/This NFT was burned/);
 assert.equal(l.toJSON().minted[0].burned,true);
 // A burned edition is not free again.
 const {w:w2,l:l2,collection,mint:mint2,signed:signed2,mintRecord}=world(),set=collection(w2.alice,'Burnable',1),only=mint2(w2.alice,{collection:set,edition:1});
 l2.apply(signed2(l2.prepareBurn({nft:only,owner:w2.alice.address}),w2.alice));assert.throws(()=>l2.check(mintRecord(w2.alice,{collection:set,edition:1}).record),/already minted/);
 // A claimed Mordinal can be burned the same way; an unclaimed one cannot.
 claim(0,w.alice);const b0=l.prepareBurn({nft:l.mordinal(0).reg,owner:w.alice.address});assert.match(b0.text,/^XMR721 burn: destroy Mordinal #0 for good; burn 0; /);
 l.apply(signed(b0,w.alice));assert.equal(l.mordinal(0).owner,null);assert.deepEqual(l.owned(w.alice.address),[]);
 assert.throws(()=>l.prepareBurn({nft:l.mordinal(1).reg,owner:w.bob.address}),/has not been claimed yet/);
});
