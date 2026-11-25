// Offline tests of offers (RULES.md section 13) with made-up keys and transactions: node --test rules/tests/offers.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createLedger} from '../lib/ledger.mjs';
import {OP,RULES,SCOPE,TX_EXTRA_LIMIT,encodeBody,decodeRecord,formatXmr} from '../lib/records.mjs';
import {setRoot,setPath,inSet} from '../lib/offers.mjs';
import {outputSecret,signWithOutputKey} from '../lib/claim.mjs';
import {wallet,makeTx,ownerEntry,fact,entries,DOMAIN} from './helpers.mjs';
const XMR=10n**12n,FROM=110,HOLD=RULES.maxReserve+RULES.settle;

function world(o={}){
 const w=Object.fromEntries(['alice','bob','carol','dave','fee','market'].map(n=>[n,wallet(n)]));
 const holders=[w.alice,w.alice,w.alice,w.carol,w.carol,w.dave,w.dave,w.dave];
 const owners=holders.map((h,i)=>ownerEntry(i,makeTx('offer world '+i,[{to:h,amount:10n**9n}])));
 const l=createLedger({domain:DOMAIN,feeAddress:w.fee.address,owners,height:100,mintFrom:101,offersFrom:FROM,...o});
 const by=new Map(Object.values(w).map(x=>[x.address,x])),regs=owners.map(x=>x.registrationTx);
 const key=(n,h)=>outputSecret({viewSecret:h.viewSecret,spendSecret:h.spendSecret,txPub:owners[n].ownerTxPubKeys[0],subScalar:h.subScalar});
 const claim=(n,h)=>{const p=l.prepareClaim({mordinal:n,to:h.address});l.apply(l.claimWithKey(p.bodyBytes,signWithOutputKey(p.keyHash,key(n,h))));};
 const signed=(p,who)=>l.sign(p.bodyBytes,who.sign(p.text));
 const offer=(bidder,x)=>{const p=l.prepareOffer({bidder:bidder.address,...x});return {...p,record:signed(p,bidder)};};
 const accept=(id,n,seller,path=[])=>{const p=l.prepareAccept({offer:id,mordinal:n,seller:seller.address,path});return {...p,record:signed(p,seller)};};
 const payment=(label,pays)=>makeTx(label,pays.map(x=>({to:by.get(x.to),amount:x.amount})));
 const linesFor=lot=>{const x=l.lot(lot),r=x.reservations.at(-1);
  return [{to:x.seller,amount:BigInt(r.seller),what:'seller'},{to:w.fee.address,amount:BigInt(r.protocol),what:'protocol fee'},...(r.rate?[{to:r.market,amount:BigInt(r.marketPay),what:'marketplace fee'}]:[])];};
 const buy=(lot,tx,h=l.height)=>l.apply(l.buyRecord({lot,payments:entries(linesFor(lot),[tx],lot)}),[fact(tx,h)]);
 return {w,l,owners,regs,claim,signed,offer,accept,payment,linesFor,buy};}

test('a set of Mordinals is one root; a path shows one of them is on the list',()=>{
 const regs=Array.from({length:11},(_,i)=>String(i%10).repeat(63)+(i<10?'a':'b')),root=setRoot(regs);
 assert.equal(setRoot([...regs].reverse()),root);assert.match(root,/^[0-9a-f]{64}$/);
 for(const r of regs){const p=setPath(regs,r);assert.ok(p.length<=4);assert.equal(inSet(r,p,root),true);}
 assert.equal(inSet('c'.repeat(64),setPath(regs,regs[0]),root),false);assert.equal(inSet(regs[0],setPath(regs,regs[1]),root),false);
 assert.equal(inSet(regs[0],[],root),false);assert.equal(setRoot([regs[0]]).length,64);assert.equal(inSet(regs[0],[],setRoot([regs[0]])),true);
 assert.throws(()=>setRoot([regs[0],regs[0]]),/each Mordinal once/);assert.throws(()=>setRoot([]),/list of registration/);assert.throws(()=>setPath(regs,'c'.repeat(64)),/not in the set/);
 assert.equal(inSet(regs[0],Array(21).fill(root),root),false);});

test('the setting, and the records before it',()=>{
 const {w,l,regs,offer}=world();
 assert.deepEqual(l.offers,{from:FROM});assert.equal(world({offersFrom:null}).l.offers,null);
 assert.throws(()=>world({offersFrom:0}),/Bad first block of offers/);
 const o=offer(w.bob,{price:XMR,kind:SCOPE.set,ref:setRoot(regs.slice(0,3))});
 assert.throws(()=>l.check(o.record),/Offers start at block 110/);
 // A reader of blocks before the setting reads these records as it always did.
 for(const op of [OP.offer,OP.accept,OP.withdraw])assert.throws(()=>decodeRecord(Uint8Array.of(0x4d,0x44,0x31,0xfe,op,1,2,3),'mainnet',{offers:false}),/Unknown operation/);
 assert.throws(()=>world({offersFrom:null}).l.check(o.record),/Offers are not part of this ledger/);
 // Sizes: every record fits a Monero transaction, an accept with the longest path too.
 assert.ok(o.record.length<=260,String(o.record.length));
 const body=encodeBody(OP.accept,{offer:o.id,reg:regs[0],seq:0,seller:w.alice.address,path:Array(RULES.maxPath).fill(regs[1])});assert.ok(body.length+65<=TX_EXTRA_LIMIT-60,String(body.length+65));
 assert.throws(()=>encodeBody(OP.accept,{offer:o.id,reg:regs[0],seq:0,seller:w.alice.address,path:Array(RULES.maxPath+1).fill(regs[1])}),/path is too long/);
 assert.throws(()=>encodeBody(OP.offer,{bidder:w.bob.address,price:XMR,until:200,count:101,kind:SCOPE.set,ref:regs[0]}),/1 to 100 pieces/);
 assert.throws(()=>encodeBody(OP.offer,{bidder:w.bob.address,price:XMR,until:200,count:1,kind:3,ref:regs[0]}),/Unknown kind/);});

test('an offer for a set: accepted by an owner, paid by the bidder, the Mordinal moves',()=>{
 const {w,l,regs,claim,offer,accept,payment,linesFor,buy}=world(),set=regs.slice(0,5),root=setRoot(set);
 claim(0,w.alice);claim(1,w.alice);claim(3,w.carol);claim(5,w.dave);
 l.setHeight(FROM);
 const o=offer(w.bob,{price:2n*XMR,count:2,kind:SCOPE.set,ref:root,until:FROM+1000});
 assert.match(o.text,new RegExp(`^XMR721 offer: buy 2 pieces of the set of Mordinals ${root} for 2 XMR each; pay within 30 blocks of each accept; valid until block 1110; NFTs to ${w.bob.address}; code [0-9a-f]{32}$`));
 l.apply(o.record);assert.deepEqual([l.offer(o.id).status,l.offer(o.id).left,l.offer(o.id).running,l.offer(o.id).open],['open',2,0,true]);
 assert.throws(()=>l.check(o.record),/already on the ledger/);
 // Not in the set, not the owner, the bidder's own piece, a wrong path, a path for a single-NFT offer.
 assert.throws(()=>l.check(accept(o.id,5,w.dave,[]).record),/not for this NFT/);
 assert.throws(()=>l.check(accept(o.id,0,w.alice,setPath(set,regs[1])).record),/not for this NFT/);
 assert.throws(()=>l.prepareAccept({offer:o.id,mordinal:3,seller:w.alice.address}),/belongs to another address/);
 assert.throws(()=>l.prepareAccept({offer:o.id,mordinal:2,seller:w.alice.address}),/not been claimed/);
 l.setHeight(FROM+2);
 const a=accept(o.id,0,w.alice,setPath(set,regs[0]));
 assert.match(a.text,new RegExp(`^XMR721 accept: sell Mordinal #0 to ${w.bob.address} for 2 XMR \\(1\\.9 XMR to ${w.alice.address}, 0\\.1 XMR protocol fee\\); offer ${o.id.slice(0,32)}; sale 0; code [0-9a-f]{32}$`));
 const done=l.apply(a.record);assert.deepEqual([done.lot,done.offer,done.number,done.payBy],[a.id,o.id,0,FROM+2+30]);
 const lot=l.lot(a.id);assert.deepEqual([lot.status,lot.offer,lot.until,lot.price,lot.reservations.length,lot.reservations[0].buyer],['open',o.id,FROM+2+HOLD,2n*XMR,1,w.bob.address]);
 assert.equal(l.mordinal(0).lot,a.id);assert.equal(l.offer(o.id).running,1);
 // What the accept said the bidder pays is what the sale asks for.
 assert.deepEqual(a.pay.map(p=>[p.to,p.amount]),linesFor(a.id).map(p=>[p.to,p.amount]));
 // The sale cannot be reserved by someone else or cancelled; the Mordinal cannot be listed or sent meanwhile.
 assert.throws(()=>l.prepareReserve({lot:a.id,buyer:w.carol.address})&&l.check(l.sign(l.prepareReserve({lot:a.id,buyer:w.carol.address}).bodyBytes,w.carol.sign(l.prepareReserve({lot:a.id,buyer:w.carol.address}).text))),/came from an accepted offer/);
 {const c=l.prepareCancel({lot:a.id,seller:w.alice.address});assert.throws(()=>l.check(l.sign(c.bodyBytes,w.alice.sign(c.text))),/came from an accepted offer/);}
 assert.throws(()=>l.prepareMove({mordinal:0,from:w.alice.address,to:w.carol.address})&&l.check(l.sign(l.prepareMove({mordinal:0,from:w.alice.address,to:w.carol.address}).bodyBytes,w.alice.sign(l.prepareMove({mordinal:0,from:w.alice.address,to:w.carol.address}).text))),/listed for sale/);
 // The bidder pays the seller and the fee address directly; anyone posts the record.
 l.setHeight(FROM+5);const t=payment('offer pay 1',a.pay),sold=buy(a.id,t);
 assert.deepEqual([sold.owner,sold.number],[w.bob.address,0]);assert.equal(l.mordinal(0).owner,w.bob.address);assert.equal(l.lot(a.id).status,'sold');
 assert.deepEqual([l.offer(o.id).status,l.offer(o.id).left,l.offer(o.id).running],['open',1,0]);
 // The second piece completes the offer; a third accept is refused.
 const a2=accept(o.id,3,w.carol,setPath(set,regs[3]));l.apply(a2.record);
 assert.throws(()=>l.check(accept(o.id,1,w.alice,setPath(set,regs[1])).record),/Every piece this offer asks for is accepted already/);
 buy(a2.id,payment('offer pay 2',a2.pay));assert.deepEqual([l.offer(o.id).status,l.offer(o.id).left,l.offer(o.id).open],['done',0,false]);
 assert.throws(()=>l.check(accept(o.id,1,w.alice,setPath(set,regs[1])).record),/This offer is complete/);
 assert.equal(l.toJSON().offers.length,1);assert.equal(world().l.toJSON().offers,undefined);});

test('an accept that is not paid frees the piece by itself and closes the offer',()=>{
 const run=steps=>{const x=world(),{w,l,regs,claim,offer,accept}=x,set=regs.slice(0,5),root=setRoot(set);
  claim(0,w.alice);claim(1,w.alice);claim(3,w.carol);l.setHeight(FROM);
  const o=offer(w.bob,{price:XMR,count:3,kind:SCOPE.set,ref:root,until:FROM+2000});l.apply(o.record);
  const a=accept(o.id,0,w.alice,setPath(set,regs[0]));l.apply(a.record);
  l.setHeight(FROM+3);const b=accept(o.id,3,w.carol,setPath(set,regs[3]));l.apply(b.record);
  for(const h of steps)l.setHeight(h);return {...x,o,a,b,set};};
 // Through the last block of the hold the sale is open and payable; one block later it is over.
 {const {l,o,a}=run([FROM+HOLD]);assert.equal(l.lot(a.id).status,'open');assert.equal(l.offer(o.id).status,'open');}
 const {w,l,regs,o,a,b,set,accept,payment,buy}=run([FROM+HOLD+1]);
 assert.deepEqual([l.lot(a.id).status,l.lot(a.id).lapsed.height,l.mordinal(0).lot,l.mordinal(0).seq,l.mordinal(0).owner],['lapsed',FROM+HOLD+1,null,1,w.alice.address]);
 assert.deepEqual([l.offer(o.id).status,l.offer(o.id).running,l.offer(o.id).left,l.offer(o.id).open],['closed',1,3,false]);
 // The other accept, made before the miss, can still be paid; nothing new is accepted; a payment for the lapsed one is refused.
 assert.throws(()=>l.check(accept(o.id,1,w.alice,setPath(set,regs[1])).record),/closed: an earlier accept of it was not paid/);
 assert.throws(()=>buy(a.id,payment('late',a.pay)),/not paid in time/);
 buy(b.id,payment('in time',b.pay),FROM+3+RULES.maxReserve);assert.equal(l.mordinal(3).owner,w.bob.address);assert.deepEqual([l.offer(o.id).status,l.offer(o.id).left,l.offer(o.id).running],['closed',2,0]);
 // The seller lists or sends the freed Mordinal with no record in between.
 {const p=l.prepareList({mordinal:0,seller:w.alice.address,price:XMR,until:l.height+100});l.apply(l.sign(p.bodyBytes,w.alice.sign(p.text)));assert.equal(l.mordinal(0).lot,p.id);}
 {const p=l.prepareWithdraw({offer:o.id,bidder:w.bob.address});assert.throws(()=>l.check(l.sign(p.bodyBytes,w.bob.sign(p.text))),/This offer is closed/);}
 // The state at a height is the same whether the blocks came one by one or the height jumped.
 const far=FROM+HOLD+50,one=run(Array.from({length:far-FROM-3},(_,i)=>FROM+4+i)),jump=run([far]);
 // (Each run has its own made-up transactions, so ids differ; everything else must be the same.)
 const shape=x=>{const j=x.l.toJSON();return {height:j.height,claimed:j.claimed.map(c=>[c.number,c.seq,Boolean(c.lot),c.history]),lots:j.lots.map(t=>[t.number,t.status,t.reservations]),offers:j.offers.map(o=>[o.status,o.left,o.running,o.count,o.until]),lapsed:[x.a,x.b].map(r=>x.l.lot(r.id).lapsed.height)};};
 assert.deepEqual(shape(one),shape(jump));assert.equal(jump.l.lot(jump.b.id).status,'lapsed');assert.equal(jump.l.lot(jump.b.id).lapsed.height,FROM+3+HOLD+1);});

test('offers: what is refused, withdrawal, and the end of an offer',()=>{
 const {w,l,regs,claim,signed,offer,accept,payment,buy}=world(),set=regs.slice(0,5),root=setRoot(set);
 claim(0,w.alice);claim(1,w.alice);l.setHeight(FROM);
 const bad=(x,why)=>assert.throws(()=>l.check(offer(w.bob,{price:XMR,kind:SCOPE.set,ref:root,...x}).record),why);
 bad({price:10n**9n-1n},/lowest price is 0\.001 XMR/);bad({until:FROM+RULES.maxOffer+1},/at most 5040 blocks/);bad({until:FROM-1},/ended before it was posted/);
 bad({rate:501,market:w.market.address},/at most 5%/);bad({rate:100,market:w.fee.address},/differ from the protocol fee address/);
 bad({kind:SCOPE.collection,ref:regs[0]},/collection does not exist/);bad({kind:SCOPE.nft,ref:'c'.repeat(64)},/not a Mordinal on the owner list/);
 assert.throws(()=>l.check(offer(w.fee,{price:XMR,kind:SCOPE.set,ref:root}).record),/fee address cannot make an offer/);
 {const p=l.prepareOffer({bidder:w.bob.address,price:XMR,kind:SCOPE.set,ref:root});assert.throws(()=>l.check(l.sign(p.bodyBytes,w.bob.sign(p.text)).fill(1,-3,-2)),/signature does not match/);}
 // The bidder's own piece, a listed piece, an offer that ends too soon.
 const mine=offer(w.alice,{price:XMR,kind:SCOPE.set,ref:root});l.apply(mine.record);
 assert.throws(()=>l.check(accept(mine.id,0,w.alice,setPath(set,regs[0])).record),/cannot accept their own offer/);
 const o=offer(w.bob,{price:XMR,count:2,kind:SCOPE.set,ref:root,until:FROM+100});l.apply(o.record);
 {const p=l.prepareList({mordinal:1,seller:w.alice.address,price:XMR,until:FROM+50});l.apply(signed(p,w.alice));
  assert.throws(()=>l.check(accept(o.id,1,w.alice,setPath(set,regs[1])).record),/listed for sale; cancel the listing first/);}
 l.setHeight(FROM+100-HOLD);const a=accept(o.id,0,w.alice,setPath(set,regs[0]));assert.equal(l.check(a.record).op,OP.accept);
 l.setHeight(FROM+100-HOLD+1);assert.throws(()=>l.check(accept(o.id,0,w.alice,setPath(set,regs[0])).record),/ends too soon/);
 l.setHeight(FROM+101);assert.throws(()=>l.check(accept(o.id,0,w.alice,setPath(set,regs[0])).record),/This offer has ended/);assert.equal(l.offer(o.id).open,false);
 // Withdrawal: only the bidder; a running accept can still be paid, nothing new is accepted.
 const o2=offer(w.bob,{price:XMR,count:2,kind:SCOPE.set,ref:root,until:l.height+1000});l.apply(o2.record);
 const a2=accept(o2.id,0,w.alice,setPath(set,regs[0]));l.apply(a2.record);
 {const p=l.prepareWithdraw({offer:o2.id,bidder:w.carol.address});assert.throws(()=>l.check(signed(p,w.carol)),/Only the bidder/);}
 {const p=l.prepareWithdraw({offer:o2.id,bidder:w.bob.address});assert.match(p.text,new RegExp(`^XMR721 withdraw: end offer ${o2.id.slice(0,32)}; code [0-9a-f]{32}$`));l.apply(signed(p,w.bob));
  assert.throws(()=>l.check(signed(l.prepareWithdraw({offer:o2.id,bidder:w.bob.address}),w.bob)),/already on the ledger/);}
 assert.equal(l.offer(o2.id).status,'withdrawn');
 buy(a2.id,payment('after withdrawal',a2.pay));assert.equal(l.mordinal(0).owner,w.bob.address);assert.deepEqual([l.offer(o2.id).status,l.offer(o2.id).left],['withdrawn',1]);});

test('an offer for one NFT, and for a collection made on this ledger, with a marketplace fee',()=>{
 const {w,l,regs,claim,signed,offer,accept,payment,linesFor,buy}=world();
 claim(0,w.alice);claim(1,w.alice);l.setHeight(105);
 const set=l.prepareCollection({creator:w.carol.address,name:'Stamps',max:3});l.apply(signed(set,w.carol));
 const mint=e=>{const p=l.prepareMint({collection:set.id,edition:e,creator:w.carol.address,type:1,content:randomBytes(30)});l.apply(signed(p,w.carol));return p.id;};
 const one=mint(1),two=mint(2);l.setHeight(FROM);
 // One NFT: only that one, with no path.
 const o=offer(w.bob,{price:XMR,kind:SCOPE.nft,ref:regs[1]});assert.match(o.text,/buy 1 piece of Mordinal #1 for 1 XMR each/);l.apply(o.record);
 assert.throws(()=>l.check(accept(o.id,0,w.alice).record),/not for this NFT/);assert.throws(()=>l.check(accept(o.id,1,w.alice,[regs[0]]).record),/not for this NFT/);
 assert.throws(()=>l.check(offer(w.bob,{price:XMR,count:2,kind:SCOPE.nft,ref:regs[1]}).record),/for one NFT is for one piece/);
 const a=accept(o.id,1,w.alice);l.apply(a.record);
 // The payment is in a block by the pay-by block; one made later does not count, though the sale is still held.
 {const payBy=l.lot(a.id).reservations[0].payBy,t=payment('nft pay late',a.pay);l.setHeight(payBy+2);
  assert.throws(()=>l.apply(l.buyRecord({lot:a.id,payments:entries(linesFor(a.id),[t],a.id)}),[fact(t,payBy+1)]),/after the pay-by block of this accepted offer/);
  const good=payment('nft pay',a.pay);l.apply(l.buyRecord({lot:a.id,payments:entries(linesFor(a.id),[good],a.id)}),[fact(good,payBy)]);}
 assert.equal(l.mordinal(1).owner,w.bob.address);assert.equal(l.offer(o.id).status,'done');
 // A collection: any NFT minted into it, not a Mordinal; the marketplace is paid on top.
 const c=offer(w.bob,{price:XMR,count:2,kind:SCOPE.collection,ref:set.id,rate:250,market:w.market.address});
 assert.match(c.text,new RegExp(`buy 2 pieces of "Stamps" \\(collection ${set.id.slice(0,32)}\\) for 1 XMR each plus 0\\.025 XMR each to ${w.market.address}; `));l.apply(c.record);
 assert.throws(()=>l.check(accept(c.id,0,w.alice).record),/not for this NFT/);
 const ac=accept(c.id,one,w.carol);assert.match(ac.text,new RegExp(`^XMR721 accept: sell "Stamps" #1 \\(NFT ${one.slice(0,32)}\\) to ${w.bob.address} for 1 XMR `));l.apply(ac.record);
 assert.equal(linesFor(ac.id).length,3);assert.equal(linesFor(ac.id)[2].to,w.market.address);
 const sold=buy(ac.id,payment('collection pay',ac.pay));assert.equal(l.nft(one).owner,w.bob.address);assert.equal(sold.paid['marketplace fee'],linesFor(ac.id)[2].amount.toString());
 assert.equal(l.nft(two).owner,w.carol.address);assert.equal(formatXmr(l.lot(ac.id).price),'1');});
