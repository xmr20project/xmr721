// Offline tests of the reader, relay, service and check tools with a made-up node and made-up keys:
//   node --test tests/reader.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {mkdtempSync,mkdirSync,rmSync,readFileSync,writeFileSync,appendFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OP,MAGIC,decodeRecord} from '../../rules/lib/records.mjs';
import {hex} from '../../rules/lib/monero.mjs';
import {outputSecret,signWithOutputKey} from '../../rules/lib/claim.mjs';
import {wallet,makeTx,ownerEntry,makeInProof,entries,payees,DOMAIN} from '../../rules/tests/helpers.mjs';
import {frame,unframe,CHUNK,MAX_RECORD} from '../lib/transport.mjs';
import {ownersHash,ownerLine} from '../lib/owners.mjs';
import {openReader,slim} from '../lib/reader.mjs';
import {createRelay} from '../lib/relay.mjs';
import {createContent,dirContent,plainText,TEXT_MAX} from '../lib/content.mjs';
import {createService} from '../service.mjs';
import {verify,scan,download} from '../tools/verify.mjs';
import {exportCheckpoints} from '../tools/export-checkpoints.mjs';
import {fakeChain,fakeCarrier,carried} from './fake.mjs';

const XMR=10n**12n,sha=b=>createHash('sha256').update(b).digest('hex');
const dirs=[];test.after(()=>{for(const d of dirs)rmSync(d,{recursive:true,force:true});});
const PNG=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),Buffer.from('made-up picture bytes, not a real image')]),SVG=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="4" fill="#f26822"/></svg>'),TEXT=Buffer.from('<script>alert(1)</script> is text here: served as text/plain, shown as text, never run.\n');

function world({every=5,coins=6,limits={}}={}){
 const w=Object.fromEntries(['alice','bob','carol','dave','fee'].map(n=>[n,wallet(n)])),by=new Map(Object.values(w).map(x=>[x.address,x]));
 const holders=[w.alice,w.alice,w.bob,w.carol,w.alice,w.alice,w.bob,w.dave];
 const txs=holders.map((h,i)=>makeTx('reg'+i,[{to:h,amount:10n**9n}]));
 const owners=txs.map((t,i)=>({...ownerEntry(i,t),registrationHeight:50+i,ownerHeight:50+i,...(i===0?{bodySha256:sha(PNG),bodySize:PNG.length}:i===1?{bodySha256:sha(TEXT),bodySize:TEXT.length}:i===3?{bodySha256:sha(SVG),bodySize:SVG.length}:{})}));
 const dir=mkdtempSync(join(tmpdir(),'mordinals-reader-'));dirs.push(dir);
 const chain=fakeChain({start:100}),state=join(dir,'state');
 const open=(o={})=>openReader({dir:state,chain,domain:DOMAIN,feeAddress:w.fee.address,owners,start:100,checkpointEvery:every,...o});
 const reader=open();let clock=1_000_000;
 const carrier=fakeCarrier(chain,{coins});
 const relay=()=>createRelay({dir:join(dir,'relay'),reader,chain,carrier,domain:DOMAIN,limits:{resendMs:1000,...limits},now:()=>clock});
 const key=(n,h)=>outputSecret({viewSecret:h.viewSecret,spendSecret:h.spendSecret,txPub:owners[n].ownerTxPubKeys[0],subScalar:h.subScalar});
 // Records, prepared against a ledger (the reader's own unless another is given).
 const make={
  claim:(n,h,to=h,l=reader.ledger)=>{const p=l.prepareClaim({mordinal:n,to:to.address});return l.claimWithKey(p.bodyBytes,signWithOutputKey(p.keyHash,key(n,h)));},
  claimProof:(n,h,l=reader.ledger)=>{const p=l.prepareClaim({mordinal:n,to:h.address,holder:h.address});return l.claimWithProof(p.bodyBytes,makeInProof({txid:owners[n].ownerTx,txPub:owners[n].ownerTxPubKeys[0],holder:h}),h.sign(p.text));},
  move:(n,from,to,l=reader.ledger)=>{const p=l.prepareMove({mordinal:n,from:from.address,to:to.address});return l.sign(p.bodyBytes,from.sign(p.text));},
  list:(n,seller,price,until,l=reader.ledger)=>{const p=l.prepareList({mordinal:n,seller:seller.address,price,...(until?{until}:{})});return {id:p.id,record:l.sign(p.bodyBytes,seller.sign(p.text))};},
  cancel:(lot,seller,l=reader.ledger)=>{const p=l.prepareCancel({lot,seller:seller.address});return l.sign(p.bodyBytes,seller.sign(p.text));},
  reserve:(lot,buyer,l=reader.ledger)=>{const p=l.prepareReserve({lot,buyer:buyer.address});return {...p,record:l.sign(p.bodyBytes,buyer.sign(p.text))};},
  payment:(label,p)=>{const t=makeTx(label,p.pay.map(x=>({to:by.get(x.to),amount:x.amount})));return {...t,direct:{txid:t.txid,tx:t.tx}};},
  buy:(lot,t,l=reader.ledger)=>l.buyRecord({lot,payments:entries(payees(l,lot,w.fee.address),[t],lot)})};
 // Put records in the next block without any relay, then read it.
 const block=async(...records)=>{const txs=records.map(r=>r.txid?r:carried(r));chain.mine(txs);await reader.sync();return txs.map(t=>t.txid);};
 return {w,by,owners,dir,state,chain,open,reader,carrier,relay,make,block,tick:ms=>{clock+=ms;},get clock(){return clock;}};}

test('plain text: UTF-8 with something to read, no control characters, no direction marks, not too long',()=>{
 const t=s=>plainText(Buffer.from(s,'utf8'));const c=n=>String.fromCodePoint(n);
 assert.equal(t('777\n'),'777\n');assert.equal(t('two\r\nlines\tand a tab'),'two\r\nlines\tand a tab');assert.equal(t('Monero '+c(0x1f512)+' é'),'Monero '+c(0x1f512)+' é');
 assert.equal(t('a <b>tag</b> in a sentence'),'a <b>tag</b> in a sentence');assert.equal(t('<3 Monero'),'<3 Monero');assert.equal(plainText(Buffer.from([0xef,0xbb,0xbf,0x41])),'A');
 assert.equal(t('family '+c(0x1f469)+c(0x200d)+c(0x1f467)+' '+c(0x2764)+c(0xfe0f)),'family '+c(0x1f469)+c(0x200d)+c(0x1f467)+' '+c(0x2764)+c(0xfe0f));assert.equal(t('漢字 한국어'),'漢字 한국어');
 for(const bad of ['','   \n\t',c(0)+'a','a'+c(7),'a'+c(0x1b)+'[31m','a'+c(0x7f),'a'+c(0x85),'a'+c(0x202e)+'b','a'+c(0x2067)+'b','a'+c(0x200f),'a'+c(0xfeff)+'b','x'.repeat(TEXT_MAX+1),
  c(0x61c)+'1 2 3','a'+c(0xad)+'b','a'+c(0x2028)+'b','a'+c(0xe0041),'a'+c(0xe000),'a'+c(0xfdd0),c(0x200b),c(0x3164)+c(0x3164),c(0x2800)+' '+c(0x115f),c(0x301)+c(0x302),c(0x200d)+' '+c(0x3000),'<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>\n',' <!DOCTYPE html><p>x</p> ','<?xml version="1.0"?><a/>','X5O!P%@AP[4\\PZX54(P^)7CC)7}$'+'EICAR-STANDARD-'+'ANTIVIRUS-TEST-FILE!$H+H*'])assert.equal(t(bad),null,JSON.stringify(bad));
 assert.equal(t('x'.repeat(TEXT_MAX)),'x'.repeat(TEXT_MAX));
 for(const bytes of [[0xff],[0xc3],[0xed,0xa0,0x80],[0x89,0x50,0x4e,0x47]])assert.equal(plainText(Buffer.from(bytes)),null,String(bytes));});

test('a record rides in tx_extra in one canonical way',()=>{
 const pub=randomBytes(32);
 for(const size of [5,199,253,254,255,508,509,617,1000]){const r=Uint8Array.from([...MAGIC,...randomBytes(size-4)]),e=frame(r,pub);
  assert.deepEqual(unframe(e),r,'size '+size);assert.deepEqual(unframe([...e]),r);assert.ok(e.length<=1060);
  assert.deepEqual(unframe(frame(r,pub,{paymentId:randomBytes(8)})),r);}
 const r=Uint8Array.from([...MAGIC,...randomBytes(300)]),e=[...frame(r,pub)];
 assert.throws(()=>frame(Uint8Array.from([...MAGIC,...randomBytes(MAX_RECORD)]),pub),/out of range/);
 assert.equal(unframe(undefined),null);assert.equal(unframe([]),null);
 assert.equal(unframe(e.slice(33)),null,'no transaction public key');
 assert.equal(unframe([1,...pub,...e]),null,'two transaction public keys');
 assert.equal(unframe([...e,0]),null,'padding tag');assert.equal(unframe([...e,4,1,0]),null,'another tag');
 assert.equal(unframe(e.slice(0,-1)),null,'cut short');
 assert.equal(unframe(frame(Uint8Array.from([0x58,0x54,0x31,0xfe,...randomBytes(40)]),pub)),null,'another protocol');
 // The same bytes cut into chunks another way are not a record.
 const odd=[1,...pub,2,101,127,...r.subarray(0,100),2,205,1,127,...r.subarray(100)];assert.equal(odd.length,33+3+100+4+204);assert.equal(unframe(odd),null,'uneven chunks');
 const small=Uint8Array.from([...MAGIC,...randomBytes(60)]),long=[1,...pub,2,0x80|65,0,127,...small];assert.equal(unframe(long),null,'length written the long way');
 assert.deepEqual(unframe([1,...pub,2,65,127,...small]),small);
 // Two payment ids, or a nonce of another kind, make it not a record.
 assert.equal(unframe([1,...pub,2,9,1,...randomBytes(8),2,9,1,...randomBytes(8),2,65,127,...small]),null);
 assert.equal(unframe([1,...pub,2,3,7,7,7,2,65,127,...small]),null);
 assert.equal(CHUNK,254);});

test('the reader follows blocks, journals every record and restarts to the same state',async()=>{
 const {w,chain,reader,make,block,open,state,owners}=world();
 assert.equal(reader.height,100);await reader.sync();assert.equal(reader.height,100);
 await block(make.claim(0,w.alice),make.claimProof(2,w.bob));                                  // 101
 assert.equal(reader.height,101);assert.deepEqual(reader.ledger.owned(w.alice.address),[0]);assert.deepEqual(reader.ledger.owned(w.bob.address),[2]);
 const lot=make.list(0,w.alice,2n*XMR);await block(lot.record);                                 // 102
 const res=make.reserve(lot.id,w.bob);await block(res.record);                                  // 103
 const paid=make.payment('pay a',res);await block(paid.direct);                                 // 104: the payment, no record
 assert.equal(reader.journal.length,4);
 const [buyTx]=await block(make.buy(lot.id,paid));                                              // 105
 assert.equal(reader.ledger.mordinal(0).owner,w.bob.address);
 assert.deepEqual(reader.events.map(e=>e.kind),['claim','claim','list','reserve','sale']);
 const sale=reader.events.at(-1);assert.deepEqual({number:sale.number,seller:sale.seller,buyer:sale.buyer,price:sale.price,fee:sale.fee,payments:sale.payments,txid:sale.txid,height:sale.height},
  {number:0,seller:w.alice.address,buyer:w.bob.address,price:String(2n*XMR),fee:String(XMR/10n),payments:[paid.txid],txid:buyTx,height:105});
 assert.equal(reader.events[1].proof,'payment proof and message');assert.equal(reader.events[0].proof,'one-time key');assert.equal(reader.events[0].time,1700000120);
 assert.equal(reader.checkpoints.length,1);const c=reader.checkpoints[0];
 assert.deepEqual({height:c.height,records:c.records,owners:c.owners,start:c.start,blockHash:c.blockHash},{height:105,records:5,owners:ownersHash(owners),start:100,blockHash:(await chain.header(105)).hash});
 // Refused records are journaled too: a move by a former owner, bytes that do not decode, the same claim again.
 const stale=make.claim(0,w.alice,w.carol);                                                           // already claimed
 const l2=open({dir:state+'-other'});                                                           // a ledger where alice still owns #0, to sign a move the real ledger refuses
 l2.ledger.apply(make.claim(0,w.alice,w.alice,l2.ledger));const move=make.move(0,w.alice,w.carol,l2.ledger);
 await block(stale,Uint8Array.of(...MAGIC,10),move);                                             // 106
 assert.deepEqual(reader.journal.slice(-3).map(e=>[e.ok,e.error]),[[false,'This Mordinal is already claimed.'],[false,'Unknown operation'],[false,'This Mordinal belongs to another address.']]);
 assert.equal(reader.journal.at(-2).id,undefined);assert.equal(reader.entryById(reader.journal[0].id).txid,reader.journal[0].txid);
 assert.equal(reader.entryByTx(reader.journal.at(-1).txid).ok,false);assert.equal(reader.body(lot.id).length,2*decodeRecord(lot.record).bodyBytes.length);
 // Restart: same journal, same events, same checkpoint, without asking the node.
 const snapshot=r=>JSON.stringify({h:r.height,hash:r.hash,j:r.journal,e:r.events,c:r.checkpoints,s:r.ledger.toJSON(),now:r.checkpoint()});
 const before=snapshot(reader);chain.fail='txs';const again=open();assert.equal(snapshot(again),before);chain.fail=null;
 // A stop in the middle of a write: a torn line, and a record line above the last block line, are dropped.
 appendFileSync(join(state,'records.jsonl'),JSON.stringify({...reader.journal[0],height:107})+'\n{"height":107,"pos":1,"txi');
 appendFileSync(join(state,'blocks.jsonl'),'{"height":107,"ha');
 const third=open();assert.equal(snapshot(third),before);assert.ok(readFileSync(join(state,'records.jsonl'),'utf8').endsWith('}\n'));assert.equal(readFileSync(join(state,'records.jsonl'),'utf8').split('\n').length,9);
 // A state folder is for one ledger only.
 assert.throws(()=>open({start:101}),/another ledger \(start differs\)/);assert.throws(()=>open({owners:owners.slice(1)}),/another ledger \(owners differs\)/);
 assert.throws(()=>open({domain:'00'.repeat(32)}),/another ledger \(domain differs\)/);assert.throws(()=>open({startHash:'ab'.repeat(32)}),/another start block hash/);});

test('readers that run at different times keep the same journal',async()=>{
 const {w,chain,reader,make,block,open,state}=world();
 await block(make.claim(0,w.alice));const lot=make.list(0,w.alice,XMR);await block(lot.record);const res=make.reserve(lot.id,w.bob);await block(res.record);
 // The purchase is mined one block before its payment. A reader at the tip sees the payment waiting; a reader that
 // arrives later sees it in a block. Both must refuse the purchase, for the same reason.
 const paid=make.payment('late',res),early=carried(make.buy(lot.id,paid));
 chain.publish(paid.direct);chain.mine([early],{only:[early.txid]});await reader.sync();          // 104: buy only
 assert.deepEqual([reader.journal.at(-1).ok,reader.journal.at(-1).error,reader.journal.at(-1).facts],[false,'A payment in this record was not looked up.',[]]);
 chain.mine();await reader.sync();                                                               // 105: the payment
 const [second]=await block(make.buy(lot.id,paid));                                              // 106: counts now
 assert.equal(reader.entryByTx(second).ok,true);assert.equal(reader.ledger.mordinal(0).owner,w.bob.address);
 const late=open({dir:state+'-late'});await late.sync();
 assert.deepEqual(late.journal,reader.journal);assert.deepEqual(late.checkpoints,reader.checkpoints);assert.deepEqual(late.checkpoint(),reader.checkpoint());assert.deepEqual(late.events,reader.events);
 // In steps of a few blocks, too.
 const slow=open({dir:state+'-slow'});for(let i=0;i<4;i++)await slow.sync({limit:2});assert.equal(slow.height,106);assert.deepEqual(slow.journal,reader.journal);assert.deepEqual(slow.checkpoints,reader.checkpoints);});

test('a chain reorganisation cuts the journal back and the ledger is rebuilt',async()=>{
 const {w,chain,reader,make,block,open,state}=world({every:2});
 await block(make.claim(0,w.alice));                                                            // 101
 const lot=make.list(0,w.alice,XMR);await block(lot.record);                                    // 102 (checkpoint)
 await block(make.claim(2,w.bob));                                                              // 103
 assert.equal(reader.checkpoints.length,1);const old=reader.checkpoints[0];
 // Blocks 102 and 103 are replaced: the listing and bob's claim are gone, a move is there instead.
 chain.pop(2);const l2=open({dir:state+'-x'});await l2.sync();const move=make.move(0,w.alice,w.carol,l2.ledger);
 chain.mine([carried(move)]);const r=await reader.sync();
 assert.deepEqual({height:r.height,reorg:r.reorg,added:r.added},{height:102,reorg:2,added:1});
 assert.equal(reader.ledger.mordinal(0).owner,w.carol.address);assert.equal(reader.ledger.mordinal(0).lot,null);assert.equal(reader.ledger.mordinal(2).claimed,false);
 assert.equal(reader.ledger.lot(lot.id),null);assert.deepEqual(reader.events.map(e=>e.kind),['claim','move']);assert.equal(reader.entryById(lot.id),null);
 assert.equal(reader.checkpoints.length,1);assert.notEqual(reader.checkpoints[0].blockHash,old.blockHash);assert.notEqual(reader.checkpoints[0].stateHash,old.stateHash);
 const fresh=open({dir:state+'-fresh'});await fresh.sync();assert.deepEqual(fresh.journal,reader.journal);assert.deepEqual(fresh.checkpoints,reader.checkpoints);
 // A shorter chain for a moment: the reader steps back and waits.
 chain.pop(1,{keep:true});const back=await reader.sync();assert.deepEqual({height:back.height,reorg:back.reorg},{height:101,reorg:1});assert.equal(reader.ledger.mordinal(0).owner,w.alice.address);
 chain.mine();await reader.sync();assert.equal(reader.ledger.mordinal(0).owner,w.carol.address);assert.equal(reader.height,102);
 // Another chain at the start block is refused outright.
 const other=open({dir:state+'-other',startHash:'ee'.repeat(32)});await assert.rejects(other.sync(),/another chain at the start block/);});

test('collections, mints and burns are read from blocks once the ledger opens minting, and never before',async()=>{
 const {w,chain,open,state}=world(),reader=open({dir:state+'-mint',mintFrom:102});await reader.sync();
 const L=()=>reader.ledger,signed=(p,who)=>L().sign(p.bodyBytes,who.sign(p.text)),block=async(...records)=>{chain.mine(records.map(r=>carried(r)));await reader.sync();};
 const set=L().prepareCollection({creator:w.alice.address,name:'Reader Set',max:2}),made=signed(set,w.alice);
 await block(made);                                                                               // 101: one block too early
 assert.deepEqual([reader.journal.at(-1).ok,reader.journal.at(-1).error],[false,'Minting and burning start at block 102.']);
 await block(made);                                                                               // 102: the same record counts now
 assert.equal(reader.journal.at(-1).ok,true);assert.equal(L().collection(set.id).name,'Reader Set');
 const one=L().prepareMint({collection:set.id,edition:1,creator:w.alice.address,name:'One',type:5,content:Buffer.from('first')});
 const loose=L().prepareMint({creator:w.bob.address,to:w.carol.address,type:1,content:randomBytes(700)});
 await block(signed(one,w.alice),signed(loose,w.bob));                                            // 103
 assert.deepEqual([L().nft(one.id).owner,L().nft(loose.id).owner],[w.alice.address,w.carol.address]);
 await block(signed(L().prepareMove({mordinal:one.id,from:w.alice.address,to:w.dave.address}),w.alice));   // 104
 await block(signed(L().prepareBurn({nft:loose.id,owner:w.carol.address}),w.carol));              // 105
 assert.deepEqual(reader.events.map(e=>[e.kind,e.number,e.nft??e.collection]),[['collection',null,set.id],['mint',null,one.id],['mint',null,loose.id],['move',null,one.id],['burn',null,loose.id]]);
 assert.deepEqual([L().nft(one.id).owner,L().nft(loose.id).burned],[w.dave.address,true]);
 // The relay carries the new records too: two mints may wait together, one NFT has one record waiting at a time.
 const relay=createRelay({dir:state+'-mint-relay',reader,chain,carrier:fakeCarrier(chain,{coins:8}),domain:DOMAIN,limits:{resendMs:1000,minReady:0},now:()=>1_000_000});
 const two=L().prepareMint({collection:set.id,edition:2,creator:w.alice.address,type:1,content:randomBytes(824)}),other=L().prepareMint({creator:w.alice.address,type:1,content:randomBytes(10)});
 const sent=await relay.submit(hex(signed(two,w.alice)));assert.deepEqual({state:sent.state,op:sent.op,number:sent.number},{state:'sent',op:OP.mint,number:null});
 assert.equal((await relay.submit(hex(signed(other,w.alice)))).state,'sent');
 const shift=L().prepareMove({mordinal:one.id,from:w.dave.address,to:w.bob.address});assert.equal((await relay.submit(hex(signed(shift,w.dave)))).number,one.id);
 await assert.rejects(relay.submit(hex(signed(L().prepareBurn({nft:one.id,owner:w.dave.address}),w.dave))),e=>e.status===429&&/Another record for this/.test(e.message));
 chain.mine();await reader.sync();await relay.tick();                                             // 106
 assert.deepEqual([relay.status(sent.id).state,L().nft(two.id).owner,L().nft(other.id).owner,L().nft(one.id).owner],['done',w.alice.address,w.alice.address,w.bob.address]);
 assert.deepEqual(reader.events.slice(-3).map(e=>e.kind).sort(),['mint','mint','move']);
 // Read again from its files, and by a second reader from the start: the same journal and the same owners.
 const again=open({dir:state+'-mint',mintFrom:102});assert.deepEqual(again.journal,reader.journal);assert.equal(again.ledger.nft(one.id).owner,w.bob.address);
 assert.deepEqual(again.checkpoint(),reader.checkpoint());
 // The folder belongs to a ledger with minting from block 102; it cannot be opened as another.
 assert.throws(()=>open({dir:state+'-mint'}),/another ledger \(mintFrom differs\)/);assert.throws(()=>open({dir:state+'-mint',mintFrom:103}),/mintFrom differs/);
 // A reader of a ledger without minting sees the same transactions and refuses every one of them.
 const plain=open({dir:state+'-plain'});await plain.sync();
 assert.equal(plain.journal.length,reader.journal.length);assert.ok(plain.journal.every(e=>!e.ok));
 assert.deepEqual([...new Set(plain.journal.map(e=>e.error))],['Minting and burning are not part of this ledger.','This is not a Mordinal on the owner list.']);});

test('a node failure in the middle of a block leaves nothing half read',async()=>{
 const {w,chain,reader,make,block,state}=world();
 await block(make.claim(0,w.alice),make.claim(2,w.bob));const lot=make.list(0,w.alice,XMR);await block(lot.record);
 const res=make.reserve(lot.id,w.carol);await block(res.record);const paid=make.payment('p',res);await block(paid.direct);
 const files=()=>['blocks.jsonl','records.jsonl'].map(f=>readFileSync(join(state,f),'utf8')),before=files(),journal=reader.journal.length;
 // Block 105 holds a move (applies) and then the purchase, whose payment lookup fails.
 chain.mine([carried(make.move(2,w.bob,w.dave)),carried(make.buy(lot.id,paid))]);
 const real=chain.txs;let calls=0;chain.txs=async ids=>{if(++calls===2)throw Error('The Monero node answered HTTP 500');return real(ids);};
 await assert.rejects(reader.sync(),/HTTP 500/);
 assert.equal(reader.height,104);assert.equal(reader.journal.length,journal);assert.deepEqual(files(),before);
 assert.equal(reader.ledger.mordinal(2).owner,w.bob.address,'the move of the failed block is not kept');assert.equal(reader.events.length,4);
 for(const what of ['info','header','block']){chain.fail=what;await assert.rejects(reader.sync(),/HTTP 500/);assert.equal(reader.height,104);}
 chain.txs=real;const r=await reader.sync();assert.equal(r.height,105);
 assert.equal(reader.ledger.mordinal(2).owner,w.dave.address);assert.equal(reader.ledger.mordinal(0).owner,w.carol.address);assert.deepEqual(reader.journal.slice(-2).map(e=>e.ok),[true,true]);
 assert.equal(reader.checkpoints.length,1);});

test('a payment the node reports from blocks that are not in this journal is asked again',async()=>{
 const {w,chain,reader,make,block,state}=world();
 await block(make.claim(0,w.alice));const lot=make.list(0,w.alice,XMR);await block(lot.record);          // 101, 102
 const res=make.reserve(lot.id,w.carol);await block(res.record);await block();                           // 103, 104 (empty)
 // The payment is still waiting. The purchase record is in block 105.
 const paid=make.payment('answered from other blocks',res),buy=carried(make.buy(lot.id,paid));
 chain.publish(paid.direct);chain.mine([buy],{only:[buy.txid]});
 const files=()=>['blocks.jsonl','records.jsonl'].map(f=>readFileSync(join(state,f),'utf8')),before=files();
 // The node answers the payment lookup as if block 104 held it (an answer from blocks that were replaced since).
 const real=chain.txs;chain.txs=async ids=>{const got=await real(ids),t=got.get(paid.txid);if(t)got.set(paid.txid,{...t,inPool:false,height:104});return got;};
 await assert.rejects(reader.sync(),/changed its answer for block 104/);
 assert.equal(reader.height,104);assert.deepEqual(files(),before);assert.equal(reader.ledger.mordinal(0).owner,w.alice.address);
 await assert.rejects(reader.lookup([paid.txid],reader.height),/changed its answer for block 104/);
 // With the node's true answer the record is read and refused: its payment was in no block yet.
 chain.txs=real;await reader.sync();
 assert.deepEqual([reader.height,reader.journal.at(-1).ok,reader.journal.at(-1).error],[105,false,'A payment in this record was not looked up.']);
 assert.equal(reader.ledger.mordinal(0).owner,w.alice.address);
 // Once the payment is in a block of this journal, the same purchase sent again counts.
 await block();await block(make.buy(lot.id,paid));
 assert.equal(reader.journal.at(-1).facts[0].height,106);assert.equal(reader.ledger.mordinal(0).owner,w.carol.address);});

test('the relay sends records, waits for blocks and keeps to its limits',async()=>{
 const x=world({coins:12,limits:{perSigner:2,stuckBlocks:6,settleBlocks:4,minReady:0}}),{w,chain,reader,make,carrier}=x;let relay=x.relay();
 const step=async(o)=>{chain.mine([],o);await reader.sync();return relay.tick();};
 // Sent, waiting, mined, done.
 const claim=make.claim(0,w.alice),sent=await relay.submit(hex(claim));
 assert.deepEqual({state:sent.state,op:sent.op,number:sent.number,error:sent.error},{state:'sent',op:OP.claim,number:0,error:null});
 assert.deepEqual(await chain.pool(),[sent.txid]);assert.equal(relay.status(sent.id).state,'sent');assert.equal(relay.status(sent.id).confirmations,0);
 assert.deepEqual(await relay.submit(hex(claim)),sent,'the same record again is the same job');assert.equal(carrier.made.length,1);
 await assert.rejects(relay.submit(hex(make.claim(0,w.alice,w.carol))),e=>e.status===429&&/Another record for this Mordinal/.test(e.message));
 assert.deepEqual(relay.waitingFor({number:0}).map(j=>j.id),[sent.id]);assert.deepEqual(relay.waitingFor({signer:w.alice.address}).map(j=>j.id),[sent.id]);
 await step();assert.deepEqual({...relay.status(sent.id),id:0},{id:0,state:'done',txid:sent.txid,height:101,confirmations:1,error:null});
 assert.equal((await relay.submit(hex(claim))).state,'done');assert.deepEqual(relay.pending(),[]);
 // Records the rules refuse cost nothing: they are not sent.
 await assert.rejects(relay.submit(hex(make.claim(0,w.alice,w.carol))),e=>!e.status&&e.message==='This Mordinal is already claimed.');
 await assert.rejects(relay.submit('zz'),/hexadecimal/);await assert.rejects(relay.submit(hex(Uint8Array.of(...MAGIC,10))),/Unknown operation/);
 await assert.rejects(relay.submit(hex(make.list(0,w.alice,XMR,reader.height+2).record)),/would end before it reaches a block/);
 assert.equal(carrier.made.length,1);
 // Two waiting records per address here; the third waits its turn.
 const a=await relay.submit(hex(make.claim(1,w.alice))),b=await relay.submit(hex(make.claim(4,w.alice)));assert.deepEqual([a.state,b.state],['sent','sent']);
 await assert.rejects(relay.submit(hex(make.claim(5,w.alice))),e=>e.status===429&&/already has 2 records waiting/.test(e.message));
 await step();assert.deepEqual(reader.ledger.owned(w.alice.address),[0,1,4]);
 // A purchase is held until its payment is in a block, then sent.
 const lot=make.list(0,w.alice,3n*XMR);await relay.submit(hex(lot.record));await step();
 const res=make.reserve(lot.id,w.bob);await relay.submit(hex(res.record));await step();
 // Only a purchase that really pays is held: a payment the node does not know, or one that pays the wrong amounts, is turned away.
 await assert.rejects(relay.submit(hex(make.buy(lot.id,make.payment('never sent',res)))),e=>e.status===400&&/not known to the Monero node yet/.test(e.message));
 const cheap=make.payment('too little',{pay:res.pay.map(p=>({...p,amount:p.amount-1n}))});chain.publish(cheap.direct);
 await assert.rejects(relay.submit(hex(make.buy(lot.id,cheap))),e=>!e.status&&e.rule===true);chain.drop(cheap.txid);
 assert.deepEqual(relay.pending(),[]);
 const paid=make.payment('relay pay',res);chain.publish(paid.direct);
 const buy=make.buy(lot.id,paid),held=await relay.submit(hex(buy));assert.equal(held.state,'held');assert.equal(held.txid,null);
 chain.fail='txs';await assert.rejects(relay.submit(hex(make.buy(lot.id,paid))),e=>e.status===503);
 const made=carrier.made.length;await relay.tick();assert.equal(relay.status(held.id).state,'held');assert.equal(carrier.made.length,made);
 await step({only:[paid.txid]});assert.equal(relay.status(held.id).state,'sent');assert.equal(carrier.made.length,made+1);
 await step();assert.equal(relay.status(held.id).state,'done');assert.equal(reader.ledger.mordinal(0).owner,w.bob.address);
 // The node forgot a transaction: it is sent again, the same transaction, after a while.
 const move=await relay.submit(hex(make.move(1,w.alice,w.carol)));chain.drop(move.txid);assert.deepEqual(await chain.pool(),[]);
 await relay.tick();assert.deepEqual(await chain.pool(),[],'not before the wait is over');x.tick(2000);await relay.tick();assert.deepEqual(await chain.pool(),[move.txid]);
 const count=carrier.made.length;
 // The relay restarts from its files.
 relay=x.relay();assert.equal(relay.status(move.id).state,'sent');assert.equal(relay.status(move.id).txid,move.txid);
 await step();assert.equal(relay.status(move.id).state,'done');
 // The block that held it is replaced: the record is sent again until it is in a block for good.
 chain.pop(1);await reader.sync();assert.equal(reader.ledger.mordinal(1).owner,w.alice.address);await relay.tick();
 assert.equal(relay.status(move.id).state,'sent');await relay.tick();assert.deepEqual(await chain.pool(),[move.txid]);assert.equal(carrier.made.length,count,'no second transaction is built');
 await step();assert.equal(relay.status(move.id).state,'done');assert.equal(reader.ledger.mordinal(1).owner,w.carol.address);
 // Someone publishes a competing record first: the relay's record is refused in its block and reported so.
 const mine=await relay.submit(hex(make.move(4,w.alice,w.bob))),rival=carried(make.move(4,w.alice,w.dave));
 chain.mine([rival],{only:[rival.txid]});chain.mine();await reader.sync();await relay.tick();
 assert.deepEqual([relay.status(mine.id).state,relay.status(mine.id).error],['refused','This Mordinal belongs to another address.']);assert.equal(reader.ledger.mordinal(4).owner,w.dave.address);
 // Never mined: after a long time the job is marked stuck and stops holding the Mordinal's place.
 const lost=await relay.submit(hex(make.claim(5,w.alice)));for(let i=0;i<7;i++)await step({only:[]});
 assert.equal(relay.status(lost.id).state,'stuck');assert.deepEqual(relay.pending(),[]);
 // No coin ready: the record waits in line and goes out when a coin is.
 carrier.ready=0;const q=await relay.submit(hex(make.claim(6,w.bob)));assert.equal(q.state,'queued');assert.match(q.note,/No coin of this wallet/);
 carrier.ready=2;await relay.tick();assert.equal(relay.status(q.id).state,'sent');});

test('a purchase that replaced blocks put before its own payment is sent again by the relay',async()=>{
 const x=world({coins:12,limits:{minReady:0}}),{w,chain,reader,make,carrier}=x,relay=x.relay();
 const step=async o=>{chain.mine([],o);await reader.sync();return relay.tick();};
 await x.block(make.claim(0,w.alice));const lot=make.list(0,w.alice,3n*XMR);await x.block(lot.record);
 const res=make.reserve(lot.id,w.bob);await x.block(res.record);
 const paid=make.payment('paid before the blocks changed',res);chain.publish(paid.direct);
 const record=hex(make.buy(lot.id,paid)),held=await relay.submit(record);assert.equal(held.state,'held');
 await step({only:[paid.txid]});const first=relay.status(held.id).txid;assert.ok(first);
 await step();assert.deepEqual([relay.status(held.id).state,relay.status(held.id).confirmations],['done',1]);assert.equal(reader.ledger.mordinal(0).owner,w.bob.address);
 // The two newest blocks are replaced. The record's transaction is mined first, its payment one block later.
 chain.pop(2,{keep:true});await step({only:[first]});
 assert.equal(reader.entryByTx(first).ok,false);assert.equal(reader.ledger.mordinal(0).owner,w.alice.address);
 assert.deepEqual([relay.status(held.id).state,relay.status(held.id).txid],['held',null],'kept, waiting for the payment again');
 const made=carrier.made.length;await step({only:[paid.txid]});
 const second=relay.status(held.id).txid;assert.equal(relay.status(held.id).state,'sent');assert.notEqual(second,first);assert.equal(carrier.made.length,made+1);
 await step();assert.equal(relay.status(held.id).state,'done');assert.equal(reader.entryById(held.id).txid,second);
 assert.equal(reader.ledger.mordinal(0).owner,w.bob.address);assert.equal(reader.ledger.lot(lot.id).status,'sold');
 // A purchase the rules refuse for good is refused once, with the block's own reason, and is not sent again.
 await x.block(make.claim(2,w.bob));const lot2=make.list(2,w.bob,2n*XMR);await x.block(lot2.record);
 const res2=make.reserve(lot2.id,w.carol);await x.block(res2.record);
 const pay2=make.payment('second purchase',res2);chain.publish(pay2.direct);const job=await relay.submit(hex(make.buy(lot2.id,pay2)));
 await step({only:[pay2.txid]});const sent=relay.status(job.id).txid,count=carrier.made.length;
 for(let i=0;i<45;i++)chain.mine([],{only:[]});await reader.sync();
 const rival=carried(make.reserve(lot2.id,w.dave).record);chain.mine([rival],{only:[rival.txid]});await reader.sync();assert.equal(reader.entryByTx(rival.txid).ok,true);
 await step();assert.equal(reader.entryByTx(sent).ok,false);
 assert.deepEqual([relay.status(job.id).state,relay.status(job.id).error],['refused',reader.entryByTx(sent).error]);assert.equal(carrier.made.length,count);
 // The number of times a purchase goes out again is limited.
 const x2=world({coins:12,limits:{minReady:0,sendAgain:1}}),r2=x2.relay(),s2=async o=>{x2.chain.mine([],o);await x2.reader.sync();return r2.tick();};
 await x2.block(x2.make.claim(0,x2.w.alice));const l3=x2.make.list(0,x2.w.alice,3n*XMR);await x2.block(l3.record);
 const res3=x2.make.reserve(l3.id,x2.w.bob);await x2.block(res3.record);
 const pay3=x2.make.payment('paid twice replaced',res3);x2.chain.publish(pay3.direct);const j3=await r2.submit(hex(x2.make.buy(l3.id,pay3)));
 await s2({only:[pay3.txid]});const t1=r2.status(j3.id).txid;await s2();assert.equal(r2.status(j3.id).state,'done');
 x2.chain.pop(2,{keep:true});await s2({only:[t1]});assert.equal(r2.status(j3.id).state,'held');
 await s2({only:[pay3.txid]});const t2=r2.status(j3.id).txid;await s2();assert.equal(r2.status(j3.id).state,'done');
 x2.chain.pop(2,{keep:true});await s2({only:[t2]});
 assert.deepEqual([r2.status(j3.id).state,r2.status(j3.id).error],['refused',x2.reader.entryByTx(t2).error]);});

test('the relay keeps coins ready by splitting one',async()=>{
 const x=world({coins:3,limits:{minReady:3,splitInto:8}}),{w,chain,reader,make,carrier}=x,relay=x.relay();
 await relay.submit(hex(make.claim(0,w.alice)));assert.equal(carrier.ready,2);
 const t=await relay.tick();assert.equal(t.ready,2);assert.equal((await chain.pool()).length,2,'the record and the split');assert.equal(carrier.ready,9);
 carrier.ready=1;await relay.tick();assert.equal((await chain.pool()).length,2,'one split at a time');
 carrier.ready=9;chain.mine();await reader.sync();await relay.tick();assert.equal(existsSync(join(x.dir,'relay','split.json')),false);});

test('the service answers wallets and pages, and the check tools agree with it',async()=>{
 const x=world({coins:20,every:3}),{w,chain,reader,make,owners,dir}=x,relay=x.relay();
 mkdirSync(join(dir,'content'));writeFileSync(join(dir,'content',sha(PNG)),PNG);writeFileSync(join(dir,'content',sha(TEXT)),TEXT);writeFileSync(join(dir,'content',sha(SVG)),SVG);
 mkdirSync(join(dir,'views','sub'),{recursive:true});writeFileSync(join(dir,'views','index.html'),'<!doctype html><title>t</title>');writeFileSync(join(dir,'views','notes.txt'),'x');writeFileSync(join(dir,'secret.html'),'secret');
 const transfers=[{tx:'ab'.repeat(32),height:60,result:'updated',mordinal:0},{tx:'cd'.repeat(32),height:61,result:'ignored',mordinal:0}];
 const service=createService({reader,relay,owners,transfers,content:createContent({source:dirContent(join(dir,'content'))}),views:join(dir,'views'),origins:['http://localhost:5180'],testHooks:true,chunk:3});
 const port=await service.listen(0),base='http://127.0.0.1:'+port;
 const get=async(path,headers={})=>{const r=await fetch(base+path,{headers,redirect:'manual'});return {status:r.status,headers:r.headers,body:r.headers.get('content-type')?.startsWith('application/json')?await r.json():Buffer.from(await r.arrayBuffer())};};
 const post=async(path,body,raw)=>{const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:raw??JSON.stringify(body)});return {status:r.status,body:await r.json()};};
 const send=async record=>{const r=await post('/records',{record:hex(record)});assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
 const next=async o=>{chain.mine([],o);const r=await post('/test/step',{});assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
 try{
  const info=(await get('/info')).body;
  assert.deepEqual({...info,rules:0},{network:'mainnet',domain:DOMAIN,feeAddress:w.fee.address,height:100,count:8,chunk:3,test:true,owners:ownersHash(owners),start:100,startHash:null,mintFrom:null,relay:{networkFee:'relay',perAddress:3,fees:{collection:'0',mint:'0'},payBlocks:30},rules:0});
  assert.deepEqual(info.rules,{feeBps:500,marketFeeCapBps:500,minPrice:'1000000000',maxReserve:30,settle:10});
  // The owner list comes in pieces and hashes to the stated value.
  let lines='';for(let from=0;from<8;from+=3){const p=(await get('/owners?from='+from)).body;assert.equal(p.total,8);assert.ok(p.entries.length<=3);for(const o of p.entries){lines+=ownerLine(o);assert.equal(o.registrationHeight,undefined);}}
  assert.equal(sha(lines),info.owners);assert.equal((await get('/owners?from=2&limit=1')).body.entries[0].number,2);
  // A sale from start to end through the relay.
  const c0=await send(make.claim(0,w.alice));assert.equal(c0.state,'sent');await send(make.claimProof(2,w.bob));
  assert.deepEqual((await get('/address/'+w.alice.address)).body.waiting.map(j=>j.id),[c0.id]);assert.equal((await get('/pending')).body.jobs.length,2);assert.equal((await get('/pending')).body.pool.length,2);
  assert.equal((await get('/status/'+c0.id)).body.state,'sent');assert.equal((await get('/mordinal/0')).body.waiting.length,1);
  const s=await next();assert.equal(s.height,101);assert.equal(s.relay.waiting,0);
  assert.deepEqual((await get('/status/'+c0.id)).body,{height:101,id:c0.id,state:'done',txid:c0.txid,confirmations:1,error:null,...{height:101}});
  assert.deepEqual((await get('/claimed')).body,{height:101,numbers:[0,2]});
  const mine=(await get('/address/'+w.alice.address)).body;assert.deepEqual(mine.mordinals.map(m=>[m.number,m.claimed,m.owner,m.seq,m.lot]),[[0,true,w.alice.address,0,null]]);assert.deepEqual(mine.waiting,[]);
  const lot=make.list(0,w.alice,2n*XMR);await send(lot.record);await next();
  const shown=(await get('/listings')).body.listings;assert.equal(shown.length,1);
  assert.deepEqual({...shown[0],until:0},{id:lot.id,number:0,name:null,nft:null,reg:owners[0].registrationTx,seller:w.alice.address,price:String(2n*XMR),until:0,status:'open',body:hex(decodeRecord(lot.record).bodyBytes),reservation:null,buyer:null});
  const res=make.reserve(lot.id,w.bob);await send(res.record);await next();
  const reserved=(await get('/lot/'+lot.id)).body.lot.reservation;assert.deepEqual({buyer:reserved.buyer,record:reserved.record,height:reserved.height,payBy:reserved.payBy},{buyer:w.bob.address,record:res.id,height:103,payBy:132});
  assert.deepEqual((await get('/address/'+w.bob.address)).body.buying.map(l=>l.id),[lot.id]);
  const paid=make.payment('service pay',res);chain.publish(paid.direct);
  // The payment as a wallet reads it to make its proofs: known from the pool on, with only the parts the rules read.
  const seen=(await get('/tx/'+paid.txid)).body;assert.deepEqual(seen,{height:103,payment:{txid:paid.txid,height:null,tx:JSON.parse(JSON.stringify(slim(paid.tx)))}});
  assert.deepEqual([(await get('/tx/'+'77'.repeat(32))).status,(await get('/tx/abc')).status],[404,400]);
  const held=await send(make.buy(lot.id,paid));assert.equal(held.state,'held');assert.equal((await get('/lot/'+lot.id)).body.waiting[0].state,'held');
  await next({only:[paid.txid]});assert.equal((await get('/status/'+held.id)).body.state,'sent');await next();
  const done=(await get('/status/'+held.id)).body;assert.equal(done.state,'done');assert.equal(done.height,105);
  await send(make.move(2,w.bob,w.carol));await next();await next();                                // 106, 107
  assert.deepEqual((await get('/address/'+w.bob.address)).body.mordinals.map(m=>m.number),[0]);assert.deepEqual((await get('/listings')).body.listings,[]);
  // Explorer views.
  const act=(await get('/activity')).body;assert.deepEqual(act.events.map(e=>e.kind),['move','sale','reserve','list','claim','claim']);assert.equal(act.total,6);assert.equal(act.next,null);assert.equal(act.events[0].confirmations,2);
  const page=(await get('/activity?limit=2')).body;assert.equal(page.next,4);assert.deepEqual((await get('/activity?limit=2&before=4')).body.events.map(e=>e.kind),['reserve','list']);
  assert.deepEqual((await get('/activity?kind=claim')).body.events.map(e=>e.number),[2,0]);assert.deepEqual((await get('/activity?number=2')).body.events.map(e=>e.kind),['move','claim']);
  assert.deepEqual((await get('/activity?address='+w.carol.address)).body.events.map(e=>e.kind),['move']);assert.equal((await get('/activity?kind=nonsense')).status,400);
  const sales=(await get('/sales')).body.events;assert.equal(sales.length,1);assert.deepEqual([sales[0].price,sales[0].fee,sales[0].buyer],[String(2n*XMR),String(XMR/10n),w.bob.address]);
  const g=(await get('/gallery')).body;assert.equal(g.total,8);assert.deepEqual(g.items[0],{number:0,name:null,reg:owners[0].registrationTx,claimed:true,owner:w.bob.address,bodySize:PNG.length,group:null,lot:null});
  assert.deepEqual((await get('/gallery?filter=claimed')).body.items.map(i=>i.number),[0,2]);assert.equal((await get('/gallery?filter=unclaimed')).body.total,6);
  assert.deepEqual((await get('/gallery?filter=unclaimed&from=4&limit=5')).body.items.map(i=>i.number),[6,7]);assert.equal((await get('/gallery?filter=else')).status,400);
  const m0=(await get('/mordinal/0')).body;assert.deepEqual(m0.history.map(h=>h.kind),['inscribed','transfer','claim','list','reserve','sale']);
  assert.deepEqual(m0.history[1],{kind:'transfer',height:60,time:null,txid:'ab'.repeat(32)});assert.equal(m0.mordinal.owner,w.bob.address);assert.equal(m0.mordinal.bodySha256,sha(PNG));assert.equal(m0.mordinal.registrationHeight,50);
  assert.deepEqual((await get('/mordinal/'+owners[0].registrationTx)).body,m0);assert.equal((await get('/mordinal/7')).body.mordinal.claimed,false);
  assert.equal((await get('/mordinal/99')).status,404);assert.equal((await get('/mordinal/nonsense')).status,404);
  const stats=(await get('/stats')).body;assert.deepEqual({...stats,checkpoint:0,byKind:0},{height:107,mordinals:8,claimed:2,forSale:0,sales:1,volume:String(2n*XMR),fees:String(XMR/10n),records:6,refused:0,byKind:0,checkpoint:0});
  assert.equal(stats.checkpoint.height,105);
  // A listing that is open shows in the gallery filter; a new listing is waiting to be bought.
  const lot2=make.list(0,w.bob,XMR);await send(lot2.record);await next();                          // 108 (checkpoint)
  assert.deepEqual((await get('/gallery?filter=listed')).body.items.map(i=>[i.number,i.lot.id,i.lot.price,i.lot.reserved]),[[0,lot2.id,String(XMR),false]]);
  // Pictures: only checked picture bytes are served, and never as a page.
  const pic=await get('/content/0');assert.equal(pic.status,200);assert.deepEqual(pic.body,PNG);
  assert.deepEqual(['content-type','x-content-type-options','content-security-policy','x-mordinal-sensitive','x-mordinal-sha256'].map(h=>pic.headers.get(h)),['image/png','nosniff',"default-src 'none'; sandbox",'0',sha(PNG)]);
  assert.equal((await get('/content/1')).status,415);assert.equal((await get('/content/2')).status,404);assert.equal((await get('/content/99')).status,404);
  assert.equal((await get('/content/'+owners[0].registrationTx)).status,200);
  // Texts: plain text is served as text/plain from /text/ (a page shows it as text, never as markup); a picture is not a text.
  const words=await get('/text/1');assert.equal(words.status,200);assert.deepEqual(words.body,TEXT);
  assert.deepEqual(['content-type','x-content-type-options','content-security-policy','x-mordinal-sensitive','x-mordinal-sha256'].map(h=>words.headers.get(h)),['text/plain; charset=utf-8','nosniff',"default-src 'none'; sandbox",'0',sha(TEXT)]);
  assert.equal((await get('/text/0')).status,415);assert.equal((await get('/text/2')).status,404);assert.equal((await get('/text/99')).status,404);assert.equal((await get('/text/x')).status,404);
  assert.equal((await get('/text/'+owners[1].registrationTx)).status,200);
  // An SVG document: the service answers with a PNG picture it drew (when the optional picture library is there), never the SVG.
  const drawn=await get('/content/3'),canDraw=await import('sharp').then(()=>true,()=>false);
  if(canDraw){assert.equal(drawn.status,200);assert.deepEqual(drawn.body.subarray(0,8),PNG.subarray(0,8));
   assert.deepEqual(['content-type','x-content-type-options','content-security-policy','x-mordinal-sensitive','x-mordinal-sha256','x-mordinal-drawn','cache-control'].map(h=>drawn.headers.get(h)),['image/png','nosniff',"default-src 'none'; sandbox",'0',sha(SVG),'svg','public, max-age=86400']);}
  else assert.equal(drawn.status,415);
  assert.equal(pic.headers.get('x-mordinal-drawn'),null);assert.equal((await get('/text/3')).status,415);
  // Pages are static files of one folder.
  const index=await get('/view/');assert.equal(index.status,200);assert.match(index.headers.get('content-security-policy'),/script-src 'self'/);assert.equal((await get('/')).status,302);
  for(const p of ['/view/notes.txt','/view/..%2fsecret.html','/view/%2e%2e/secret.html','/view/sub/','/view/missing.html'])assert.equal((await get(p)).status,404,p);
  // Requests.
  assert.equal((await get('/nothing')).status,404);assert.equal((await get('/status/xyz')).status,400);assert.equal((await get('/lot/'+'00'.repeat(32))).status,404);
  assert.equal((await get('/address/nonsense')).status,400);
  assert.equal((await post('/records',null,'{not json')).status,400);assert.equal((await post('/records',null,JSON.stringify({record:'ab'.repeat(40000)}))).status,413);
  assert.equal((await fetch(base+'/records',{method:'POST',body:JSON.stringify({record:'00'})})).status,415);
  const whole=await get('/records'),part=await get('/records?from=1&limit=2');assert.ok(whole.body.total>=3&&whole.body.total===whole.body.records.length);
  assert.deepEqual([part.body.from,part.body.total,part.body.records],[1,whole.body.total,whole.body.records.slice(1,3)]);
  // Many visitors at once: one look at the node's pool.
  const pool=chain.pool;let looks=0;chain.pool=async()=>{looks++;await new Promise(r=>setTimeout(r,40));return pool.call(chain);};
  try{const answers=await Promise.all([1,2,3,4,5].map(()=>get('/pending')));assert.equal(looks,1);assert.ok(answers.every(a=>a.status===200));}finally{chain.pool=pool;}
  const refused=await post('/records',{record:hex(make.claim(0,w.alice,w.carol))});assert.deepEqual([refused.status,refused.body.error],[400,'This Mordinal is already claimed.']);
  assert.equal((await get('/info',{origin:'chrome-extension://abcdefgh'})).headers.get('access-control-allow-origin'),'chrome-extension://abcdefgh');
  assert.equal((await get('/info',{origin:'http://localhost:5180'})).headers.get('access-control-allow-origin'),'http://localhost:5180');
  assert.equal((await get('/info',{origin:'https://elsewhere.example'})).headers.get('access-control-allow-origin'),null);
  assert.equal((await fetch(base+'/records',{method:'OPTIONS',headers:{origin:'chrome-extension://abcdefgh'}})).status,204);
  // The log, the checkpoints, and the tools that check them.
  const log=(await get('/log?limit=4')).body;assert.equal(log.total,7);assert.equal(log.entries.length,4);assert.equal(log.height,108);
  const cps=(await get('/checkpoints')).body.checkpoints;assert.deepEqual(cps.map(c=>c.height),[102,105,108]);assert.deepEqual((await get('/checkpoint')).body,cps[2]);
  const got=await download(base);assert.equal(got.entries.length,7);assert.equal(got.height,108);
  const good=await verify({...got,owners,chain});assert.deepEqual(good,{ok:true,problems:[],accepted:7,refused:0,checkpoints:3,checkedOnNode:7});
  assert.deepEqual(await scan({...got,owners,chain,dir:join(dir,'scan')}),[]);
  const out=join(dir,'public');assert.deepEqual(await exportCheckpoints({service:base,out}),{total:3,added:3});assert.deepEqual(await exportCheckpoints({service:base,out}),{total:3,added:0});
  const published=JSON.parse(readFileSync(join(out,'checkpoints.json'),'utf8'));assert.equal(published.checkpoints.length,3);assert.equal(published.owners,info.owners);
  const files=published.checkpoints.map(c=>{const t=readFileSync(join(out,'checkpoints',c.height+'.json'),'utf8');assert.equal(sha(t),c.sha256);return JSON.parse(t);});
  assert.equal((await verify({...got,owners,published:files})).ok,true);
  // What the tools catch.
  const clone=()=>structuredClone(got),problems=async(change,more={})=>{const g=clone();change(g);return (await verify({...g,owners,chain,...more})).problems;};
  assert.match((await problems(g=>{g.entries.splice(3,1);}))[0],/marked accepted, but the rules refuse it|differs from the replay/);              // a record left out breaks what follows
  assert.match((await problems(g=>{g.entries[1].ok=false;g.entries[1].error='no';}))[0],/marked refused, but the rules accept it/);
  assert.match((await problems(g=>{g.checkpoints[1].stateHash='00'.repeat(32);}))[0],/Checkpoint at block 105: stateHash differs/);
  assert.match((await problems(g=>{g.checkpoints[2].blockHash='00'.repeat(32);}))[0],/the node has another block there/);
  assert.match((await problems(g=>{g.entries[0].txid='11'.repeat(32);}))[0],/differs from the replay|is not at place/);
  assert.match((await problems(g=>{const e=g.entries[6];e.height=107;g.checkpoints.pop();}))[0],/is not at place 0 of block 107/);
  assert.match((await problems(g=>{[g.entries[0],g.entries[1]]=[g.entries[1],g.entries[0]];}))[0],/out of chain order/);
  assert.match((await problems(()=>{},{owners:owners.slice(0,7)}))[0],/owner list here is not the one/);
  assert.match((await problems(()=>{},{published:[{...files[0],records:9}]}))[0],/published checkpoint at block 102 differs/);
  // Leaving out the newest record (nothing follows it) passes the replay; only a scan of the chain finds it.
  const short=clone();short.entries.pop();short.checkpoints.pop();assert.equal((await verify({...short,owners,chain})).ok,true);
  assert.match((await scan({...short,owners,chain,dir:join(dir,'scan2')}))[0],/This scan found 7 records up to block 108; the service logs 6/);
  // A changed checkpoint is never written over a published one.
  writeFileSync(join(out,'checkpoints','105.json'),'{}\n');await assert.rejects(exportCheckpoints({service:base,out}),/differs from the one written before/);
 }finally{await service.close();}
 // Too many posts from one place are slowed down; a reader without a relay says so.
 const quiet=createService({reader,owners,rate:{perSecond:0,burst:2}}),busy=createService({reader,relay,owners,rate:{perSecond:0,burst:2}});
 const p1=await quiet.listen(0),p2=await busy.listen(0),hit=async(p,headers={'content-type':'application/json'})=>(await fetch('http://127.0.0.1:'+p+'/records',{method:'POST',headers,body:JSON.stringify({record:'00'})})).status;
 try{assert.equal(await hit(p1),503);assert.equal((await (await fetch('http://127.0.0.1:'+p1+'/info')).json()).relay,null);assert.equal((await fetch('http://127.0.0.1:'+p1+'/test/step',{method:'POST'})).status,404);
  assert.deepEqual([await hit(p2),await hit(p2),await hit(p2)],[400,400,429]);
  // A forwarded-for header is believed only behind the machine's own proxy, and then only its last entry.
  const json={'content-type':'application/json'};assert.equal(await hit(p2,{...json,'x-forwarded-for':'5.5.5.5'}),429);
  const proxied=createService({reader,relay,owners,behindProxy:true,extensions:['abcdefgh'],rate:{perSecond:0,burst:1}}),p3=await proxied.listen(0);
  try{assert.deepEqual([await hit(p3,{...json,'x-forwarded-for':'9.9.9.9, 1.1.1.1'}),await hit(p3,{...json,'x-forwarded-for':'8.8.8.8, 1.1.1.1'}),await hit(p3,{...json,'x-forwarded-for':'1.1.1.1, 2.2.2.2'})],[400,429,400]);
   // With a list of extensions, only those may read from a page.
   const from=async origin=>(await fetch('http://127.0.0.1:'+p3+'/info',{headers:{origin}})).headers.get('access-control-allow-origin');
   assert.deepEqual([await from('chrome-extension://abcdefgh'),await from('chrome-extension://zzzzzzzz')],['chrome-extension://abcdefgh',null]);}
  finally{await proxied.close();}}
 finally{await quiet.close();await busy.close();}});

test('a Mordinal is named by its collection and the edition its creator gave it',async()=>{
 const {reader,owners}=world({coins:2}),A='a'.repeat(24),B='b'.repeat(24);
 // Editions for members only, numbers only: 3 is in no collection, -1 is no edition, a list that is not one is not read.
 const C='c'.repeat(24),groups={groups:[{id:A,name:'Rocks Collection',display:'Rocks',basis:'matching numbered names',named:true,numbers:[[0,2]],editions:[[0,5],[1,5],[3,9],[2,-1]]},
  {id:B,name:'Plain',basis:'shared description',named:true,numbers:[4,5],editions:'no'},
  // A group that is not a named collection (only a shared description) names nobody.
  {id:C,name:'testing this',basis:'shared description',numbers:[6,7],editions:[[6,1]]}]};
 const service=createService({reader,owners,groups}),port=await service.listen(0),get=async p=>(await fetch('http://127.0.0.1:'+port+p)).json();
 try{
  assert.deepEqual((await get('/gallery?filter=all&from=0&limit=8')).items.map(i=>i.name),['Rocks #5','Rocks #5','Rocks',null,'Plain','Plain',null,null]);
  const m=(await get('/mordinal/1')).mordinal;assert.deepEqual([m.name,m.edition,m.group],['Rocks #5',5,{id:A,name:'Rocks'}]);
  const u=(await get('/mordinal/3')).mordinal;assert.deepEqual([u.name,u.edition,u.group],[null,null,null]);
  const t=(await get('/mordinal/6')).mordinal;assert.deepEqual([t.name,t.group],[null,{id:C,name:'testing this'}]);
  assert.deepEqual((await get('/group/'+A)).items.map(i=>i.name),['Rocks #5','Rocks #5','Rocks']);
  const h=(await get('/history?kind=inscribed&limit=8')).events;assert.equal(h.find(e=>e.number===0).name,'Rocks #5');assert.equal(h.find(e=>e.number===7).name,null);
  // Many at once: by number (unknown numbers left out) and by registration transaction.
  assert.deepEqual((await get('/names?numbers=0,2,3,99999')).names,{0:{name:'Rocks #5',group:{id:A,name:'Rocks'}},2:{name:'Rocks',group:{id:A,name:'Rocks'}},3:{name:null,group:null}});
  assert.deepEqual((await get('/names?tx='+owners[4].registrationTx+','+'0'.repeat(64))).names,{[owners[4].registrationTx]:{number:4,name:'Plain',group:{id:B,name:'Plain'}}});
  const bad=async p=>(await fetch('http://127.0.0.1:'+port+p)).status;
  assert.deepEqual([await bad('/names'),await bad('/names?numbers=1&tx='+'0'.repeat(64)),await bad('/names?numbers=x'),await bad('/names?tx=12'),await bad('/names?numbers='+Array(201).fill(1).join(','))],[400,400,400,400,400]);
 }finally{await service.close();}});
