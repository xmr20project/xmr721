// Offline tests of the xmr721 wallet (cli/lib/wallet.mjs) and its command line: a made-up node and a stand-in for the
// carrier tool that keeps its keys the way the real one does, a reader over HTTP, and a ledger whose minting opens to
// everyone at a block. The made-up ledger is a stagenet one: on mainnet the wallet inscribes on one ledger only.
// Nothing here talks to a network beyond this machine.
//   node --test cli/tests/wallet.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,existsSync,mkdirSync,statSync,chmodSync,readdirSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ed25519} from '@noble/curves/ed25519';
import {wallet as testWallet,makeTx,ownerEntry,DOMAIN} from '../../rules/tests/helpers.mjs';
import {le,leBytes,hex} from '../../rules/lib/monero.mjs';
import {MAX_RECORD} from '../../rules/lib/records.mjs';
import {openReader} from '../../reader/lib/reader.mjs';
import {createService} from '../../reader/service.mjs';
import {fakeChain,fakeCarrier} from '../../reader/tests/fake.mjs';
import {openWallet,readerAt,typeOf,mintingClosed,keysOf,imagesOf,clean,plain,ascii,LEDGERS,FINAL,KEEP} from '../lib/wallet.mjs';
import {openLock} from '../lib/lock.mjs';

const NET='stagenet',dirs=[];test.after(()=>{for(const d of dirs)rmSync(d,{recursive:true,force:true});});
const temp=name=>{const d=mkdtempSync(join(tmpdir(),name));dirs.push(d);return d;};
const L=ed25519.CURVE.n,scalar=()=>{for(;;){const s=le(randomBytes(32))%L;if(s)return hex(leBytes(s));}};
// The beginning of a transaction as the real tool makes it, as far as the wallet reads it: version 2, unlock time 0,
// one input (kind 2, amount 0, a ring of 16) with a key image of its own. What the stand-in made follows it.
const begin=image=>'020001'+'0200'+'10'+'01'.repeat(16)+image,BEGIN=begin('00'.repeat(32)).length;
// The carrier tool as the tests need it: its keys in carrier.keys.json (two random scalars, as the real tool writes
// them), its state file, coins and transactions as reader/tests/fake.mjs keeps them. `lose` sets what happens when the
// next transaction is handed to the node: 'refused' (the node answers no), 'silent' (no answer, and the node does not
// have it), 'after' (the node has it and the answer is lost). `scans` counts the times the tool found no state file and
// read the chain anew; `die` makes the next build fail: 'no' (the tool says no), 'silent' (no answer, the coin is used).
// `slow` makes every question to the tool take that many milliseconds.
function carrierIn(dir,chain,{coins=5}={}){
 const c=fakeCarrier(chain,{coins}),state=join(dir,'carrier.state.json'),real=t=>({...t,blob:begin(randomBytes(32).toString('hex'))+t.blob});
 const wait=()=>x.slow?new Promise(r=>setTimeout(r,x.slow)):null;
 const x={lose:null,die:false,sends:0,scans:0,slow:0,
  get made(){return c.made;},get ready(){return c.ready;},set ready(v){c.ready=v;},
  status:async()=>{await wait();if(!existsSync(state)){x.scans++;writeFileSync(state,'{}');}return c.status();},
  carry:async r=>{await wait();const how=x.die;x.die=false;if(how==='no')throw Error('The network fee of this transaction (9) is above the limit (5); nothing was sent');const t=await c.carry(r);if(how==='silent')throw Error('The carrier tool did not answer in time.');return real(t);},
  split:async n=>real(await c.split(n)),
  publish:async blob=>{x.sends++;const how=x.lose;x.lose=null;
   if(how==='refused')throw Error('transaction was rejected (double spend)');if(how==='silent')throw Error('The carrier tool did not answer in time.');
   const done=await c.publish(blob.slice(BEGIN));if(how==='after')throw Error('The carrier tool did not answer in time.');return done;},
  init:async()=>{mkdirSync(dir,{recursive:true});const f=join(dir,'carrier.keys.json');if(!existsSync(f))writeFileSync(f,JSON.stringify({spend:scalar(),view:scalar()}));return {address:keysOf(dir,NET).address};}};
 return x;}

// `spent`: the key images the made-up node shows as spent by a transaction in a block.
async function world({openFrom=106}={}){
 const launchpad=testWallet('launchpad',NET),bob=testWallet('bob',NET),fee=testWallet('fee',NET),holder=testWallet('holder',NET);
 const owners=[makeTx('reg0',[{to:holder,amount:10n**9n}])].map((t,i)=>({...ownerEntry(i,t),registrationHeight:50,ownerHeight:50}));
 const chain=fakeChain({start:100}),spent=new Set();chain.spent=async images=>images.map(i=>spent.has(i)?1:0);
 const reader=openReader({dir:temp('wallet-reader-'),chain,network:NET,domain:DOMAIN,feeAddress:fee.address,owners,start:100,mintFrom:101,minters:[launchpad.address],openFrom});
 await reader.sync();const service=createService({reader,owners}),base='http://127.0.0.1:'+await service.listen(0);
 const make=(name,o={})=>{const dir=join(temp('wallet-'),name),carrier=carrierIn(dir,chain,o),notes=[];
  const open=(more={})=>openWallet({dir,carrier,reader:readerAt(base),chain,network:NET,domain:DOMAIN,warn:t=>notes.push(t),...more});
  return {dir,carrier,notes,open,wallet:open()};};
 const block=async()=>{chain.mine();await service.step();};
 const blocks=async n=>{for(let i=0;i<n;i++)await block();};
 const until=async h=>{while(reader.height<h)await block();};
 return {chain,spent,reader,service,base,owners,bob,launchpad,make,block,blocks,until,close:()=>service.close()};}
// The states of what a wallet built, with block numbers and counts left out.
const tidy=t=>t.replace(/block \d+/g,'block N').replace(/\d+ of 10/,'n of 10').replace(/forget \d+/,'forget N');
const states=async w=>(await w.inscriptions()).map(r=>[r.kind,tidy(r.state)]);
const journal=dir=>JSON.parse(readFileSync(join(dir,'journal.json'),'utf8'));
const locks=dir=>existsSync(join(dir,'lock'))?readdirSync(join(dir,'lock')):[];
const RESEND='"xmr721 wallet resend"';

test('a wallet is made once, readable by its owner only, and its address is the one its keys give',async()=>{
 const x=await world();
 try{
  const a=x.make('a'),made=await a.wallet.create({height:x.reader.height});
  assert.equal(made.address,a.wallet.address);assert.deepEqual(JSON.parse(readFileSync(join(a.dir,'wallet.json'),'utf8')),{network:NET,start:100});
  assert.deepEqual([statSync(a.dir).mode&0o777,statSync(join(a.dir,'wallet.json')).mode&0o777,locks(a.dir)],[0o700,0o600,[]]);
  await assert.rejects(a.wallet.create({height:100}),/a wallet in .* already/);
  assert.throws(()=>x.make('none').wallet.address,/There is no wallet/);
  const b=await a.wallet.balance();assert.deepEqual([b.address,b.ready,b.coins,b.kept],[made.address,5,5,0]);
  // A folder copied from elsewhere with open modes is closed again.
  chmodSync(a.dir,0o755);chmodSync(join(a.dir,'carrier.keys.json'),0o644);a.wallet.tighten();
  assert.deepEqual([statSync(a.dir).mode&0o777,statSync(join(a.dir,'carrier.keys.json')).mode&0o777],[0o700,0o600]);
 }finally{await x.close();}});

test('inscribing: closed to anyone off the list until the opening block, then one NFT owned by the wallet or by --to',async()=>{
 const x=await world();
 try{
  const a=x.make('a');await a.wallet.create({height:x.reader.height});const content=Buffer.from('hello, Monero'),me=a.wallet.address;
  // Before the opening block: refused here, before anything is built or sent.
  await assert.rejects(a.wallet.inscribe({content,type:5}),/Minting opens to everyone at block 106/);assert.equal(a.carrier.made.length,0);
  await x.until(105);
  // A dry run says what would be signed and built: nothing is built, nothing is written, and no signed record is shown.
  const dry=await a.wallet.inscribe({content,type:5,name:'hello',dryRun:true});
  assert.deepEqual([dry.dryRun,dry.kind,dry.owner,a.carrier.made.length,existsSync(join(a.dir,'journal.json')),'record' in dry],[true,'mint',me,0,false,false]);
  assert.match(dry.text,/^XMR721 mint: one NFT in no collection named "hello"; 13 bytes of type 5/);
  const one=await a.wallet.inscribe({content,type:5,name:'hello'}),two=await a.wallet.inscribe({content:Buffer.from('for bob'),type:5,to:x.bob.address});
  assert.equal(one.id,dry.id,'the same record whenever it is made');assert.equal(a.carrier.made.length,2);assert.ok(one.txid&&one.fee&&!('blob' in one));assert.equal(one.state,'waiting for a block');
  assert.deepEqual(await states(a.wallet),[['mint','waiting for a block'],['mint','waiting for a block']]);
  await x.block();
  assert.deepEqual([x.reader.ledger.nft(one.id)?.owner,x.reader.ledger.nft(two.id)?.owner,x.reader.ledger.nft(one.id)?.minted.creator],[me,x.bob.address,me]);
  assert.deepEqual(await states(a.wallet),[['mint','on the ledger (block N, n of 10 confirmations)'],['mint','on the ledger (block N, n of 10 confirmations)']]);
  // Ten blocks deep it is final.
  assert.ok(journal(a.dir).entries.every(e=>e.blob));await x.blocks(FINAL-1);
  assert.deepEqual(await states(a.wallet),[['mint','on the ledger (block N)'],['mint','on the ledger (block N)']]);assert.ok(journal(a.dir).entries.every(e=>e.state==='done'));
  // --to the wallet's own address is the same record as none.
  assert.equal((await a.wallet.inscribe({content,type:5,name:'hello',to:me,dryRun:true})).id,one.id);
 }finally{await x.close();}});

test('the same record is never paid for twice: its transaction goes out again as it is, and once on the ledger it is refused here',async()=>{
 const x=await world({openFrom:102});
 try{
  await x.until(102);const a=x.make('a');await a.wallet.create({height:x.reader.height});const content=Buffer.from('once');
  const first=await a.wallet.inscribe({content,type:5}),again=await a.wallet.inscribe({content,type:5});
  assert.deepEqual([again.again,again.txid,a.carrier.made.length],[true,first.txid,1]);
  // In a block, the same command says where the record is and sends nothing.
  await x.block();const there=await a.wallet.inscribe({content,type:5});assert.deepEqual([there.again,a.carrier.sends],[true,1]);assert.match(there.state,/^on the ledger \(block \d+, 1 of 10 confirmations\)$/);
  // Another name or other content is another record.
  await a.wallet.inscribe({content,type:5,name:'again'});
  const c=await a.wallet.collection({name:'Set',max:2});assert.equal((await a.wallet.collection({name:'Set',max:2})).again,true);
  await x.block();assert.match((await a.wallet.collection({name:'Set',max:2})).state,/^on the ledger/);
  assert.equal(a.carrier.made.length,3);assert.ok(x.reader.ledger.collection(c.id));
  // Final on the ledger, the wallet's own word says so, also to a reader that does not show the record.
  await x.blocks(FINAL);await a.wallet.inscriptions();await assert.rejects(a.wallet.inscribe({content,type:5}),/This very NFT is on the ledger already/);await assert.rejects(a.wallet.collection({name:'Set',max:2}),/a collection of this name and size already/);
  const blind={...readerAt(x.base),nft:async()=>null,collection:async()=>null};
  await assert.rejects(a.open({reader:blind}).inscribe({content,type:5}),/This very NFT is on the ledger already/);await assert.rejects(a.open({reader:blind}).collection({name:'Set',max:2}),/a collection of this name and size already/);
  // A wallet folder that knows nothing of it (restored from its keys) is told by the reader.
  rmSync(join(a.dir,'journal.json'));await assert.rejects(a.wallet.inscribe({content,type:5}),/This very NFT is on the ledger already/);assert.equal(a.carrier.made.length,3);
 }finally{await x.close();}});

test('collections: editions in turn, also several before a block; only the maker mints; sending, one send at a time',async()=>{
 const x=await world({openFrom:102});
 try{
  await x.until(101);const a=x.make('a'),b=x.make('b');await a.wallet.create({height:x.reader.height});await b.wallet.create({height:x.reader.height});
  const c=await a.wallet.collection({name:'Moons',max:3});
  // A new collection has to be in a block before its editions are minted.
  await assert.rejects(a.wallet.inscribe({content:Buffer.from('moon 1'),type:5,collection:c.id}),/not on the ledger yet/);
  await x.block();assert.equal(x.reader.ledger.collection(c.id)?.creator,a.wallet.address);
  // Two editions before a block: the wallet counts its own mint that no block holds yet. The same file again is the
  // same edition and the same transaction, not a third one.
  const e1=await a.wallet.inscribe({content:Buffer.from('moon 1'),type:5,collection:c.id}),e2=await a.wallet.inscribe({content:Buffer.from('moon 2'),type:5,collection:c.id});
  assert.deepEqual([e1.edition,e2.edition],[1,2]);assert.match(e2.text,/edition 2 of "Moons"/);
  const same=await a.wallet.inscribe({content:Buffer.from('moon 2'),type:5,collection:c.id});assert.deepEqual([same.again,same.edition,same.txid],[true,2,e2.txid]);
  await assert.rejects(a.wallet.inscribe({content:Buffer.from('x'),type:5,collection:c.id,edition:2}),/this wallet's mint of it is on its way/);
  await x.block();assert.deepEqual([x.reader.ledger.nft(e1.id)?.minted.edition,x.reader.ledger.nft(e2.id)?.minted.edition],[1,2]);
  await assert.rejects(a.wallet.inscribe({content:Buffer.from('again'),type:5,collection:c.id,edition:1}),/Edition 1 of this collection is minted already/);
  await assert.rejects(a.wallet.inscribe({content:Buffer.from('x'),type:5,collection:c.id,edition:4}),/An edition of this collection is 1 to 3/);
  await assert.rejects(b.wallet.inscribe({content:Buffer.from('mine?'),type:5,collection:c.id}),/only its creator mints its editions/);
  await assert.rejects(a.wallet.inscribe({content:Buffer.from('x'),type:5,collection:'ab'.repeat(32)}),/not on the ledger yet/);
  await assert.rejects(a.wallet.inscribe({content:Buffer.from('x'),type:5,edition:2}),/--edition goes with --collection/);
  // Send edition 1 to b: one send of an NFT at a time (the same send again is the same transaction); then b sends it
  // back. Each send names the NFT's latest state.
  const s=await a.wallet.send({nft:e1.id,to:b.wallet.address});assert.match(s.text,/^Mordinals move: send "Moons" #1 \(NFT [0-9a-f]{32}\) to /);
  assert.deepEqual([(await a.wallet.send({nft:e1.id,to:b.wallet.address})).again,a.carrier.made.length],[true,4]);
  await assert.rejects(a.wallet.send({nft:e1.id,to:x.bob.address}),/send of this NFT to .* is on its way and cannot be taken back/);
  await x.block();assert.equal(x.reader.ledger.nft(e1.id).owner,b.wallet.address);
  await assert.rejects(a.wallet.send({nft:e1.id,to:x.bob.address}),/on its way|belongs to .*, not to this wallet/);
  await x.blocks(FINAL);await assert.rejects(a.wallet.send({nft:e1.id,to:x.bob.address}),/belongs to .*, not to this wallet/);
  await b.wallet.send({nft:e1.id,to:a.wallet.address});await x.block();assert.equal(x.reader.ledger.nft(e1.id).owner,a.wallet.address);
  await assert.rejects(a.wallet.send({nft:e1.id,to:a.wallet.address}),/own address/);
  assert.deepEqual((await states(a.wallet)).map(r=>r[0]),['collection','mint','mint','send']);assert.equal(a.carrier.made.length,4);
 }finally{await x.close();}});

test('a transaction is kept until the chain has settled it: a node that says no, one that does not answer, a lost answer and a dropped transaction lose nothing',async()=>{
 const x=await world({openFrom:102});
 try{
  await x.until(102);const a=x.make('a');await a.wallet.create({height:x.reader.height});const content=Buffer.from('kept');
  // The node answers no: nothing was sent. The transaction is built (its coin is used) and kept.
  a.carrier.lose='refused';await assert.rejects(a.wallet.inscribe({content,type:5}),/^Error: The node said no to the transaction \(transaction was rejected \(double spend\)\), and nothing was sent\. The transaction is kept as entry 1: "xmr721 wallet resend" hands it to the node again, "xmr721 wallet forget 1" gives it up\.$/);
  assert.equal(a.carrier.made.length,1);const kept=journal(a.dir).entries;
  assert.deepEqual([kept.length,kept[0].state,kept[0].txid,Boolean(kept[0].blob),kept[0].sent,(await a.wallet.balance()).kept],[1,'built',a.carrier.made[0],true,undefined,1]);
  assert.deepEqual(await states(a.wallet),[['mint',`built and not sent (the node said no: transaction was rejected (double spend)): ${RESEND} hands it to the node, "xmr721 wallet forget N" gives it up`]]);
  // The same command again hands that transaction to the node; nothing new is built.
  const again=await a.wallet.inscribe({content,type:5});assert.deepEqual([again.again,again.txid,a.carrier.made.length,again.state,journal(a.dir).entries[0].refusal],[true,kept[0].txid,1,'waiting for a block',undefined]);
  // The node does not answer and does not have the transaction: whether it took it is not known, so it counts as sent
  // and is never given up. It is sent again until the node has it.
  a.carrier.lose='silent';await assert.rejects(a.wallet.inscribe({content:Buffer.from('no answer'),type:5}),/The node did not answer when the transaction was handed to it \(The carrier tool did not answer in time\.\), so it is not known whether it took it\. The transaction is kept as entry 2 and counts as sent/);
  assert.equal(journal(a.dir).entries[1].state,'sent');assert.deepEqual((await states(a.wallet))[1],['mint',`the node does not have this transaction: ${RESEND} sends it again`]);
  await assert.rejects(a.wallet.forget(2),/A sent transaction cannot be taken back/);
  assert.deepEqual((await a.wallet.resend()).map(r=>[r.sentAgain,r.failed,r.state]),[[false,undefined,'waiting for a block'],[true,undefined,'waiting for a block']]);
  // The node took it and its answer was lost: the node has the transaction, so all is well.
  a.carrier.lose='after';const lost=await a.wallet.inscribe({content:Buffer.from('answer lost'),type:5});assert.deepEqual([lost.state,journal(a.dir).entries[2].state],['waiting for a block','sent']);
  // It is written down as sent before the node is handed it: a program that dies in between leaves nothing as unsent
  // that a node may have. And a transaction written down as built that the node has is sent all the same.
  const j0=journal(a.dir);j0.entries[2].state='built';delete j0.entries[2].sent;writeFileSync(join(a.dir,'journal.json'),JSON.stringify(j0));
  assert.deepEqual((await states(a.wallet))[2],['mint','waiting for a block']);assert.equal(journal(a.dir).entries[2].state,'sent');
  await assert.rejects(a.wallet.forget(3),/was sent and the node has it: it waits for a block\. A sent transaction cannot be taken back/);
  // The node drops a transaction it had (its pool was emptied): the wallet still has it, says so, and sends it again.
  x.chain.drop(lost.txid);
  assert.deepEqual((await states(a.wallet))[2],['mint',`the node does not have this transaction: ${RESEND} sends it again`]);
  const sends=a.carrier.sends,sent=await a.wallet.resend();assert.deepEqual([sent.map(r=>r.sentAgain),a.carrier.sends],[[false,false,true],sends+1]);
  // A reader's word moves nothing: one that shows a record for a transaction the node does not have is not believed,
  // and the transaction is sent again.
  x.chain.drop(lost.txid);const lying={...readerAt(x.base),entry:async txid=>({ok:true,id:null,error:null,height:x.reader.height,confirmations:50})};
  assert.deepEqual((await states(a.open({reader:lying})))[2],['mint',`the node does not have this transaction: ${RESEND} sends it again`]);
  assert.deepEqual((await a.open({reader:lying}).resend()).map(r=>r.sentAgain),[false,false,true]);assert.equal(journal(a.dir).entries[2].state,'sent');
  await x.block();assert.ok(x.reader.ledger.nft(again.id)&&x.reader.ledger.nft(lost.id));
  // Without a reader, and with one that does not answer, the node alone is gone by, and the owner is told.
  assert.deepEqual((await states(a.open({reader:null}))).map(r=>r[1]),Array(3).fill('in block N (n of 10 confirmations); no reader was asked what the ledger made of it'));
  const deaf=a.open({reader:readerAt('http://127.0.0.1:9')});assert.equal(a.notes.length,0);
  assert.deepEqual((await deaf.resend()).map(r=>r.sentAgain),[false,false,false]);assert.equal(a.notes.length,1);assert.match(a.notes[0],/^The reader at http:\/\/127\.0\.0\.1:9 does not answer \(.+\)\. What follows is what your node alone shows\.$/);
  await assert.rejects(deaf.inscribe({content:Buffer.from('x'),type:5}),/The reader at .* does not answer/);
  // A reader of another ledger is not asked about this wallet's records, and no record is made for its ledger.
  const other={...readerAt(x.base),info:async()=>({network:NET,domain:'cd'.repeat(32),height:x.reader.height,mintFrom:101,openFrom:102,minters:null}),entry:async()=>{throw Error('asked');}};
  assert.match((await a.open({reader:other}).inscriptions())[0].state,/no reader was asked what the ledger made of it$/);
  await assert.rejects(a.open({reader:other}).inscribe({content:Buffer.from('y'),type:5}),/another ledger/);
  // Final needs both: the wallet's own node showing the transaction 10 blocks deep, and the reader's word on the record.
  await x.blocks(FINAL-2);const early={...readerAt(x.base),entry:async id=>({...(await readerAt(x.base).entry(id)),confirmations:99})};
  await a.open({reader:early}).inscriptions();assert.ok(journal(a.dir).entries.every(e=>e.state==='sent'),'a reader alone makes nothing final');
  await a.open({reader:null}).inscriptions();assert.ok(journal(a.dir).entries.every(e=>e.state==='sent'));
  await x.block();assert.deepEqual(await states(a.wallet),Array(3).fill(['mint','on the ledger (block N)']));
  assert.deepEqual([a.carrier.made.length,await a.wallet.resend()],[3,[]]);
  // Final, the transaction is kept all the same until it is 100 blocks deep. Blocks replaced deeper than 10: the wallet
  // sees that its transaction is in no block any more and sends it again.
  assert.ok(journal(a.dir).entries.every(e=>e.state==='done'&&e.blob));
  x.chain.pop(FINAL+1);assert.deepEqual((await states(a.open({reader:null}))).map(r=>r[1]),Array(3).fill(`the node does not have this transaction: ${RESEND} sends it again`));
  assert.deepEqual((await a.open({reader:null}).resend()).map(r=>r.sentAgain),[true,true,true]);x.chain.mine();
  for(let i=0;i<KEEP-1;i++)x.chain.mine();await a.open({reader:null}).inscriptions();assert.ok(journal(a.dir).entries.every(e=>e.state==='sent'&&e.blob),'without a reader a record is not final');
 }finally{await x.close();}});

test('final and let go: a transaction is kept until it is 100 blocks deep',async()=>{
 const x=await world({openFrom:102});
 try{
  await x.until(102);const a=x.make('a');await a.wallet.create({height:x.reader.height});
  await a.wallet.inscribe({content:Buffer.from('deep'),type:5});const parts=await a.wallet.split(3);assert.equal(parts.kind,'split');
  await x.blocks(FINAL);assert.deepEqual(await states(a.wallet),[['mint','on the ledger (block N)'],['split','done (block N)']]);assert.ok(journal(a.dir).entries.every(e=>e.blob));
  await x.blocks(KEEP-FINAL-1);await a.wallet.inscriptions();assert.ok(journal(a.dir).entries.every(e=>e.blob));
  await x.block();await a.wallet.inscriptions();assert.ok(journal(a.dir).entries.every(e=>!e.blob&&e.state==='done'));
  // Let go, the wallet asks nobody about it any more.
  const calls=x.chain.calls;await a.wallet.inscriptions();assert.equal(x.chain.calls,calls);
 }finally{await x.close();}});

test('forgetting: only what was never sent is given up; a sent transaction holds its place until it is in a block or its coin is spent elsewhere',async()=>{
 const x=await world({openFrom:102});
 try{
  await x.until(102);const a=x.make('a',{coins:14});await a.wallet.create({height:x.reader.height});
  const c=await a.wallet.collection({name:'Set',max:4});await x.block();
  // Never sent (the node said no): given up, the edition is free at once and the file can be minted anew.
  a.carrier.lose='refused';await assert.rejects(a.wallet.inscribe({content:Buffer.from('one'),type:5,collection:c.id}),/kept as entry 2/);
  assert.deepEqual(journal(a.dir).entries.filter(e=>e.kind==='mint').map(e=>[e.edition,e.state]),[[1,'built']]);
  await assert.rejects(a.wallet.rescan(),/1 transaction\(s\) of this wallet are built and not sent\. Hand them to the node .* or give them up/);
  await assert.rejects(a.wallet.restore(50),/built and not sent/);
  const gone=await a.wallet.forget(2);assert.match(gone.forgotten,/^removed\. It was never sent, so what it held is free\. The coin it would have spent counts as used until: xmr721 wallet rescan$/);
  await assert.rejects(a.wallet.forget('99'),/no such entry/);
  // Sent, and the node has it: nothing takes it back, and the coins are not read anew beside it.
  const one=await a.wallet.inscribe({content:Buffer.from('one'),type:5,collection:c.id});assert.equal(one.edition,1);
  await assert.rejects(a.wallet.forget(one.n),/it waits for a block\. A sent transaction cannot be taken back/);
  await assert.rejects(a.wallet.rescan(),/1 transaction\(s\) of this wallet wait for a block\. Try again when they are in one/);
  // Sent, and the node no longer has it: it still cannot be given up, by its number, its record or its transaction.
  // It holds its edition, the next file gets the next one, and the same file again is the same transaction, sent again.
  x.chain.drop(one.txid);
  for(const ref of [one.n,one.id,one.txid])await assert.rejects(a.wallet.forget(ref),/A sent transaction cannot be taken back: a node that has it can still get it into a block, so the wallet keeps it and what it holds/);
  const two=await a.wallet.inscribe({content:Buffer.from('two'),type:5,collection:c.id});assert.equal(two.edition,2);
  await assert.rejects(a.wallet.inscribe({content:Buffer.from('other'),type:5,collection:c.id,edition:1}),/this wallet's mint of it is on its way/);
  const made=a.carrier.made.length,same=await a.wallet.inscribe({content:Buffer.from('one'),type:5,collection:c.id});
  assert.deepEqual([same.again,same.edition,same.txid,same.state,a.carrier.made.length],[true,1,one.txid,'waiting for a block',made]);
  // With the node not answering, nobody knows where a sent transaction is: nothing is forgotten and no coin read anew.
  x.chain.drop(one.txid);x.chain.fail='txs';await assert.rejects(a.wallet.forget(one.n),/Your Monero node cannot be asked right now/);
  x.chain.fail='info';await assert.rejects(a.wallet.rescan(),/your Monero node cannot be asked where they are/);
  // In no block and not with the node: the coins may be read anew, and the owner is told what that means.
  await x.block();const scans=a.carrier.scans,anew=await a.wallet.rescan();assert.equal(a.carrier.scans,scans+1);
  assert.match(anew.notes[0],/^1 transaction\(s\) of this wallet were sent and are in no block .* Their coins count as free again from now on\. If one of them gets into a block after all, its coin is spent\.$/);
  // Its coin is spent by another transaction in a block. The wallet notes the block it saw that at, stops sending it,
  // and still holds its edition: the block could be replaced.
  const image=imagesOf(journal(a.dir).entries.find(e=>e.id===one.id).blob)[0];assert.match(image,/^[0-9a-f]{64}$/);x.spent.add(image);
  const seenAt=x.chain.tip;assert.deepEqual((await states(a.wallet)).find(r=>/coin/.test(r[1])),['mint',`the node does not have it, and its coin was spent by another transaction (seen at block N). If that is still so at block N, this one can never get into a block`]);
  assert.equal(journal(a.dir).entries.find(e=>e.id===one.id).spentSeen,seenAt);
  const before=a.carrier.sends;assert.ok((await a.wallet.resend()).every(r=>!r.sentAgain));assert.equal(a.carrier.sends,before);
  assert.equal((await a.wallet.inscribe({content:Buffer.from('three'),type:5,collection:c.id,dryRun:true})).edition,3);
  // The spend is undone (its block was replaced): the transaction is sent again like any other.
  x.spent.delete(image);await a.wallet.inscriptions();assert.equal(journal(a.dir).entries.find(e=>e.id===one.id).spentSeen,undefined);
  x.spent.add(image);await a.wallet.inscriptions();await x.blocks(FINAL-1);await a.wallet.inscriptions();assert.equal(journal(a.dir).entries.find(e=>e.id===one.id).state,'sent','not ten blocks yet');
  // Ten blocks on it is still spent: the transaction can never get into a block. It holds nothing any more, the
  // edition goes to the next file, and the entry can be taken off the list.
  await x.block();assert.deepEqual((await states(a.wallet)).find(r=>/coin/.test(r[1])),['mint','its coin was spent by another transaction, so this one can never get into a block; what it carried is not on the ledger']);
  const dead=journal(a.dir).entries.find(e=>e.id===one.id);assert.deepEqual([dead.state,'blob' in dead,'spentSeen' in dead],['dead',false,false]);
  const three=await a.wallet.inscribe({content:Buffer.from('three'),type:5,collection:c.id});assert.equal(three.edition,1);
  assert.match((await a.wallet.forget(one.n)).forgotten,/removed from the list; the chain has settled it/);
  // A send that was sent: another send of the NFT waits for it, whatever the node has; dead, the NFT can be sent again.
  const own=await a.wallet.inscribe({content:Buffer.from('mine'),type:5});await x.block();
  const toBob=await a.wallet.send({nft:own.id,to:x.bob.address});
  await assert.rejects(a.wallet.send({nft:own.id,to:x.launchpad.address}),/is on its way and cannot be taken back/);
  x.chain.drop(toBob.txid);await assert.rejects(a.wallet.send({nft:own.id,to:x.launchpad.address}),/is on its way and cannot be taken back/);
  x.spent.add(imagesOf(journal(a.dir).entries.find(e=>e.txid===toBob.txid).blob)[0]);await a.wallet.inscriptions();await x.blocks(FINAL);
  const toPad=await a.wallet.send({nft:own.id,to:x.launchpad.address});assert.equal(toPad.state,'waiting for a block');
  await x.block();assert.equal(x.reader.ledger.nft(own.id).owner,x.launchpad.address);
  // A record the ledger refused is final after 10 blocks and can then be made again; a final entry can be dropped from the list.
  await x.blocks(FINAL);await a.wallet.inscriptions();
  const liar={...readerAt(x.base),collection:async(id,n)=>({...(await readerAt(x.base).collection(id,n)),editions:[]})},j=journal(a.dir);
  j.entries=j.entries.filter(e=>e.kind!=='mint');writeFileSync(join(a.dir,'journal.json'),JSON.stringify(j));
  const wasted=await a.open({reader:liar}).inscribe({content:Buffer.from('four'),type:5,collection:c.id});assert.equal(wasted.edition,1);await x.block();
  assert.deepEqual((await states(a.wallet)).at(-1),['mint','refused by the ledger (block N, n of 10 confirmations): This edition is already minted.']);
  await x.blocks(FINAL);assert.deepEqual((await states(a.wallet)).at(-1),['mint','refused by the ledger: This edition is already minted.']);
  const retry=await a.wallet.inscribe({content:Buffer.from('four'),type:5,collection:c.id});assert.deepEqual([retry.edition,retry.again],[3,undefined]);
  assert.match((await a.wallet.forget(wasted.n)).forgotten,/removed from the list/);
  // A record's transaction that is in a block for good can leave the list also when no reader ever said what became of it.
  await x.blocks(FINAL-1);const blind=a.open({reader:null});await assert.rejects(blind.forget(retry.n),/is in block \d+ and not 10 blocks deep yet/);
  await x.block();assert.match((await blind.forget(retry.n)).forgotten,/^removed from the list; its transaction is in block \d+ for good$/);
 }finally{await x.close();}});

test('one command at a time on a wallet folder; a build that was cut short leaves a note until a rescan; a damaged journal stops everything',async()=>{
 const x=await world({openFrom:102});
 try{
  await x.until(102);const a=x.make('a');await a.wallet.create({height:x.reader.height});
  // Two commands at once: one after the other. Two coins are used, two transactions built, and nothing is left in the lock.
  const both=await Promise.all([a.wallet.inscribe({content:Buffer.from('first'),type:5}),a.wallet.inscribe({content:Buffer.from('second'),type:5})]);
  assert.deepEqual([both.map(r=>r.state),a.carrier.made.length,locks(a.dir)],[['waiting for a block','waiting for a block'],2,[]]);
  // A command that holds the wallet for longer than a moment: the other is told to wait.
  a.carrier.slow=1500;const long=a.wallet.balance(),quick=a.open({lock:openLock(a.dir,{tries:2})});await new Promise(r=>setTimeout(r,100));
  await assert.rejects(quick.balance(),new RegExp(`^Error: Another xmr721 command is working on this wallet \\(process ${process.pid}\\)\\. Wait until it is done\\. If none is running, remove the folder .*lock$`));
  assert.equal((await long).kept,2);a.carrier.slow=0;assert.deepEqual(locks(a.dir),[]);
  // What is left in the lock by processes that are gone is removed; what is not a lock file is left alone. A process that
  // is alive holds the wallet: a command, or the tool an ended command left running.
  const put=name=>writeFileSync(join(a.dir,'lock',name),'');
  put('2147483646-command-0123456789abcdef');put('2147483645-tool-0123456789abcdef');put(`${process.pid}-command-0123456789abcdef`);put('notes.txt');
  assert.equal((await a.wallet.balance()).kept,2);assert.deepEqual(locks(a.dir),['notes.txt']);
  put(`${process.ppid}-command-0123456789abcdef`);await assert.rejects(quick.balance(),new RegExp(`Another xmr721 command is working on this wallet \\(process ${process.ppid}\\)`));
  rmSync(join(a.dir,'lock',`${process.ppid}-command-0123456789abcdef`));put(`${process.ppid}-tool-0123456789abcdef`);
  await assert.rejects(quick.balance(),new RegExp(`^Error: A step of an earlier xmr721 command is still running on this wallet \\(process ${process.ppid}\\)\\. Wait until it is done\\.$`));
  rmSync(join(a.dir,'lock'),{recursive:true});writeFileSync(join(a.dir,'lock'),'');await assert.rejects(a.wallet.balance(),/lock is not a folder\. If no xmr721 command is running, remove it/);rmSync(join(a.dir,'lock'));
  // The tool does not answer while it builds (it was killed): nothing is known of a transaction, and a note stays for
  // the owner through every later command, until a rescan has read the coins anew.
  a.carrier.die='silent';await assert.rejects(a.wallet.inscribe({content:Buffer.from('cut short'),type:5}),/did not answer/);
  assert.deepEqual([journal(a.dir).entries.length,a.wallet.notes().length],[2,1]);assert.match(a.wallet.notes()[0],/stopped while a transaction was being built.*Nothing was sent\..*xmr721 wallet rescan/);
  // The same when the program itself was stopped there: the entry it left is cleared at the next command, the note stays.
  const j=journal(a.dir);j.notes=[];j.entries.push({n:j.next++,kind:'mint',id:'ab'.repeat(32),state:'building',built:'x'});writeFileSync(join(a.dir,'journal.json'),JSON.stringify(j));
  await a.wallet.inscriptions();assert.deepEqual([journal(a.dir).entries.some(e=>e.state==='building'),a.wallet.notes().length],[false,1]);
  await a.wallet.inscribe({content:Buffer.from('after the cut'),type:5,dryRun:true});await a.wallet.balance();assert.equal(a.wallet.notes().length,1);
  // The tool saying no (no coin, a fee above the limit) marks no coin and leaves no note.
  a.carrier.die='no';await assert.rejects(a.wallet.inscribe({content:Buffer.from('refused by the tool'),type:5}),/above the limit/);assert.equal(a.wallet.notes().length,1);
  // A split is kept and sent again like a record, and is final by the node alone.
  a.carrier.lose='refused';await assert.rejects(a.wallet.split(3),/kept as entry \d+/);assert.equal(journal(a.dir).entries.at(-1).kind,'split');
  assert.equal((await a.wallet.resend()).at(-1).sentAgain,true);await x.blocks(FINAL);assert.deepEqual((await states(a.open({reader:null}))).at(-1),['split','done (block N)']);
  await a.wallet.rescan();assert.deepEqual(a.wallet.notes(),[]);
  // The block the scan starts at can be set anew while nothing waits for a block; the coins are then read anew.
  const scans=a.carrier.scans;assert.deepEqual(await a.wallet.restore(50),{address:a.wallet.address,start:50});assert.equal(JSON.parse(readFileSync(join(a.dir,'wallet.json'),'utf8')).start,50);
  await a.wallet.balance();assert.equal(a.carrier.scans,scans+1);
  await a.wallet.inscribe({content:Buffer.from('on its way'),type:5});await assert.rejects(a.wallet.restore(60),/wait for a block/);
  await assert.rejects(a.wallet.restore(0),/a whole number, 1 or more/);
  // A journal that does not read, or that holds what this program does not know: nothing is done and nothing is overwritten.
  const good=readFileSync(join(a.dir,'journal.json'),'utf8'),odd=JSON.parse(good);odd.entries[0].state='gone';
  for(const bad of [good.slice(0,60),JSON.stringify(odd)]){writeFileSync(join(a.dir,'journal.json'),bad);
   for(const run of [()=>a.wallet.inscribe({content:Buffer.from('x'),type:5}),()=>a.wallet.inscriptions(),()=>a.wallet.resend(),()=>a.wallet.balance(),()=>a.wallet.forget('1'),()=>a.wallet.rescan(),()=>a.wallet.restore(70)])await assert.rejects(run(),/journal.json is damaged and nothing was changed/);
   assert.equal(readFileSync(join(a.dir,'journal.json'),'utf8'),bad);}
 }finally{await x.close();}});

test('a reader that is behind the wallet\'s node is not asked what is free; the wallet counts its own final editions itself',async()=>{
 const x=await world({openFrom:102});
 try{
  await x.until(102);const a=x.make('a');await a.wallet.create({height:x.reader.height});
  const c=await a.wallet.collection({name:'Set',max:3});await x.block();
  const e1=await a.wallet.inscribe({content:Buffer.from('one'),type:5,collection:c.id});await x.blocks(FINAL);await a.wallet.inscriptions();
  assert.equal(journal(a.dir).entries.find(e=>e.id===e1.id).state,'done');
  // The node is ahead of the reader by more than a few blocks: the command waits for the reader.
  for(let i=0;i<4;i++)x.chain.mine();
  await assert.rejects(a.wallet.inscribe({content:Buffer.from('two'),type:5,collection:c.id}),/The reader is at block \d+ and your node at block \d+: the reader is behind/);
  await assert.rejects(a.wallet.send({nft:e1.id,to:x.bob.address}),/the reader is behind/);await assert.rejects(a.wallet.collection({name:'Other',max:2}),/the reader is behind/);
  await x.service.step();
  // A node that does not answer: no record is made (the reader cannot be checked against it, and nothing could be sent).
  x.chain.fail='info';await assert.rejects(a.wallet.inscribe({content:Buffer.from('two'),type:5,collection:c.id}),/^Error: Your Monero node does not answer \(The Monero node answered HTTP 500\)\. The wallet builds and sends through it, and checks the reader against it\.$/);
  // A node that stops answering after the transaction was built is handed nothing: the transaction is kept, unsent.
  let asked=0;const fading={...x.chain,info:async()=>{if(++asked>1)throw Error('gone '+String.fromCharCode(27)+'[2J');return x.chain.info();}},made=a.carrier.made.length;
  await assert.rejects(a.open({chain:fading}).inscribe({content:Buffer.from('unsent'),type:5}),/^Error: Your Monero node does not answer \(gone  \[2J\), so nothing was handed to it\. The transaction is kept as entry \d+: "xmr721 wallet resend" sends it\.$/);
  assert.deepEqual([a.carrier.made.length,journal(a.dir).entries.at(-1).state,a.carrier.sends],[made+1,'built',2]);
  assert.match((await a.wallet.forget(journal(a.dir).entries.at(-1).n)).forgotten,/It was never sent/);
  // A mint this wallet keeps for another ledger holds no edition on this one.
  const e2=await a.wallet.inscribe({content:Buffer.from('two'),type:5,collection:c.id});assert.equal(e2.edition,2);
  assert.equal((await a.wallet.inscribe({content:Buffer.from('three'),type:5,collection:c.id,dryRun:true})).edition,3);
  const j=journal(a.dir);j.entries.at(-1).domain='cd'.repeat(32);writeFileSync(join(a.dir,'journal.json'),JSON.stringify(j));
  assert.equal((await a.wallet.inscribe({content:Buffer.from('three'),type:5,collection:c.id,dryRun:true})).edition,2);
  j.entries.at(-1).domain=DOMAIN;writeFileSync(join(a.dir,'journal.json'),JSON.stringify(j));await x.block();
  // A reader that does not show the wallet's own final edition (it lost it, or lies): the wallet knows it minted it.
  const blind={...readerAt(x.base),collection:async(id,n)=>({...(await readerAt(x.base).collection(id,n)),editions:[]})};
  const w=openWallet({dir:a.dir,carrier:a.carrier,reader:blind,chain:x.chain,network:NET,domain:DOMAIN});
  assert.equal((await w.inscribe({content:Buffer.from('another'),type:5,collection:c.id,dryRun:true})).edition,3,'edition 1 is final in the journal, edition 2 is kept');
  // What can be seen to be wrong without a reader is said without asking one.
  const deaf=openWallet({dir:a.dir,carrier:a.carrier,reader:readerAt('http://127.0.0.1:9'),chain:x.chain,network:NET,domain:DOMAIN});
  await assert.rejects(deaf.inscribe({content:Buffer.from('x'),type:5,name:'say "hi"'}),/name|quote/i);await assert.rejects(deaf.collection({name:'Too many',max:10001}),/1 to 10000 editions/);
  await assert.rejects(deaf.inscribe({content:Buffer.alloc(900,1),type:1,to:x.bob.address}),/more than 1000 bytes/);
  // The largest content that fits makes a record of exactly 1000 bytes; one byte more is refused before anyone is asked.
  let most=0;for(let n=800;n<1000;n++){try{await deaf.inscribe({content:Buffer.alloc(n,1),type:1});}catch(e){if(/more than 1000 bytes/.test(e.message))break;assert.match(e.message,/does not answer/);most=n;}}
  assert.equal((await a.wallet.inscribe({content:Buffer.alloc(most,1),type:1,dryRun:true})).bytes,MAX_RECORD);await assert.rejects(deaf.inscribe({content:Buffer.from('x'),type:5,collection:c.id,edition:10001}),/An edition is 1 to 10000/);
 }finally{await x.close();}});

test('a reader\'s answers are checked before anything is signed or built, and on mainnet the ledger is fixed',async()=>{
 const x=await world({openFrom:102});
 try{
  await x.until(102);const real=readerAt(x.base);
  const a=x.make('a');await a.wallet.create({height:x.reader.height});const c=await a.wallet.collection({name:'Set',max:2});await x.block();
  const made=a.carrier.made.length,stub=answers=>new Promise(done=>{const s=createServer((req,res)=>{const v=answers(req.url);res.writeHead(v.status??200,{'content-type':'application/json',...(v.headers||{})});res.end(typeof v.body==='string'?v.body:JSON.stringify(v.body));});s.listen(0,'127.0.0.1',()=>done(s));});
  const shut=s=>new Promise(r=>{s.closeAllConnections?.();s.close(r);});
  const info={network:NET,domain:DOMAIN,height:x.reader.height,mintFrom:101,minters:[x.launchpad.address],openFrom:102},esc=String.fromCharCode(27),bell=String.fromCharCode(7);
  const tries=[
   [u=>({body:{...info,domain:'ab'.repeat(32)}}),/another ledger/],
   [u=>({body:{...info,network:'mainnet'}}),/The reader is for mainnet, the wallet for stagenet/],
   [u=>({body:{...info,height:'9'}}),/no usable height/],
   [u=>({body:{...info,minters:['not an address']}}),/no usable minter list/],
   [u=>u==='/info'?{body:info}:{body:{collection:{id:c.id,name:'Set',max:4294967295,creator:a.wallet.address},items:[]}},/no usable number of editions/],
   [u=>u==='/info'?{body:info}:{body:{collection:{id:c.id,name:'Set',max:2,creator:a.wallet.address},items:[{edition:'1'}]}},/no usable edition/],
   [u=>u==='/info'?{body:info}:{body:{collection:{id:c.id,name:'Se'+String.fromCharCode(0x202e)+'t',max:2,creator:a.wallet.address},items:[]}},/no usable collection/],
   [u=>u==='/info'?{body:info}:{status:500,body:{error:'bad '+esc+']52;c;QUFB'+bell+' thing'}},/answered 500 for .*: bad  \]52;c;QUFB  thing$/],
   [u=>({status:302,headers:{location:x.base+u},body:{}}),/^Error: The reader at http:\/\/127\.0\.0\.1:\d+ points to another address\. Give --reader the address it answers at\.$/],
   [u=>({body:'x'.repeat(200)}),/no settings|did not answer with JSON/]];
  for(const [answers,why] of tries){const s=await stub(answers);
   try{const w=openWallet({dir:a.dir,carrier:a.carrier,reader:readerAt('http://127.0.0.1:'+s.address().port),chain:x.chain,network:NET,domain:DOMAIN});
    await assert.rejects(w.inscribe({content:Buffer.from('never'),type:5,collection:c.id}),why);}finally{await shut(s);}}
  // An answer is not read beyond the limit, however long it goes on; a reader that is not there is said plainly.
  const big=await stub(()=>({body:{pad:'x'.repeat(1<<20)}}));
  try{await assert.rejects(readerAt('http://127.0.0.1:'+big.address().port,{limit:1024}).info(NET),/more than this program reads/);}finally{await shut(big);}
  await assert.rejects(readerAt('http://127.0.0.1:9').info(NET),/The reader at http:\/\/127.0.0.1:9 does not answer/);
  assert.equal(a.carrier.made.length,made,'nothing was built for any of them');
  // On mainnet the ledger is the one this program knows: no option and no reader makes it another.
  assert.throws(()=>openWallet({dir:a.dir,carrier:a.carrier,reader:real,chain:x.chain,network:'mainnet',domain:DOMAIN}),/another domain is another ledger/);
  assert.match(LEDGERS.mainnet.domain,/^[0-9a-f]{64}$/);
  const main=await stub(()=>({body:{...info,network:'mainnet',domain:DOMAIN,minters:undefined}}));
  try{const dir=join(temp('wallet-'),'m'),carrier={...carrierIn(dir,x.chain),init:async()=>{mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'carrier.keys.json'),JSON.stringify({spend:scalar(),view:scalar()}));return {address:keysOf(dir,'mainnet').address};}};
   const w=openWallet({dir,carrier,reader:readerAt('http://127.0.0.1:'+main.address().port),chain:x.chain,network:'mainnet'});await w.create({height:5});
   await assert.rejects(w.inscribe({content:Buffer.from('x'),type:5}),/another ledger \([0-9a-f]{64}\) than this wallet inscribes on/);}finally{await shut(main);}
 }finally{await x.close();}});

test('what the wallet does not send: no coin ready, a record too big, a name the rules refuse, an address of another kind',async()=>{
 const x=await world({openFrom:102});
 try{
  await x.until(102);const a=x.make('a',{coins:0});await a.wallet.create({height:x.reader.height});
  await assert.rejects(a.wallet.inscribe({content:Buffer.from('x'),type:5}),/The wallet has no coins. Send some XMR to [57]/);
  a.carrier.ready=1;
  await assert.rejects(a.wallet.inscribe({content:Buffer.alloc(MAX_RECORD,1),type:1}),/more than 1000 bytes/);
  await assert.rejects(a.wallet.inscribe({content:Buffer.from('x'),type:5,name:'say "hi"'}),/name|quote/i);
  await assert.rejects(a.wallet.collection({name:'Too many',max:10001}),/1 to 10000 editions/);
  await assert.rejects(a.wallet.inscribe({content:Buffer.alloc(0),type:5}),/empty/);
  await assert.rejects(a.wallet.inscribe({content:Buffer.from('x'),type:5,to:testWallet('main','mainnet').address}),/address/i);
  await assert.rejects(a.wallet.split(15),/2 to 14/);
  assert.equal(a.carrier.made.length,0);assert.ok(!existsSync(join(a.dir,'journal.json'))||journal(a.dir).entries.length===0);
 }finally{await x.close();}});

test('content types, the minting check, and text made safe to print',()=>{
 assert.deepEqual(['a.png','b.JPG','c.jpeg','d.webp','e.gif','f.txt','g.json','h.mp4'].map(f=>typeOf(f)),[1,2,2,3,4,5,6,7]);
 assert.deepEqual([typeOf('x.bin','art'),typeOf('x','9'),typeOf('x.png','text')],[8,9,5]);
 for(const [f,g,why] of [['x.bin',null,/give --type/],['x','0',/1 to 255/],['x','pdf',/content type name/],['x','0x5',/content type name/],['x.constructor',null,/give --type/],['x','constructor',/content type name/]])assert.throws(()=>typeOf(f,g),why);
 const info={height:99,mintFrom:101,minters:['L'],openFrom:110};
 assert.match(mintingClosed({...info,mintFrom:null},'A'),/no minting/);assert.match(mintingClosed(info,'A'),/starts at block 101/);
 assert.equal(mintingClosed({...info,height:100},'L'),null);assert.match(mintingClosed({...info,height:100},'A'),/opens to everyone at block 110/);
 assert.equal(mintingClosed({...info,height:109},'A'),null);assert.equal(mintingClosed({...info,minters:null,openFrom:null,height:100},'A'),null);
 assert.match(mintingClosed({...info,openFrom:null,height:100},'A'),/only its listed minters/);
 const c=n=>String.fromCharCode(n);
 assert.equal(clean('a'+c(27)+'[31mb'+c(7)+'c'+c(0x2028)+'d'+c(0x202e)+'e'+c(0x9b)+'f'),'a [31mb c d e f');assert.equal(clean('x'.repeat(500)).length,200);assert.equal(clean(null),'');
 // Text from elsewhere is cut down to printable ASCII: nothing unseen and nothing from another script gets through.
 assert.equal(clean('a'+c(0xad)+'b'+c(0x200d)+'c'+c(0xfe0f)+'d'+c(0xe9)+'e'+c(10)+'f'+String.fromCodePoint(0xe0041)+'g'),'a b c d e f  g');
 // The program's own messages keep the letters of a path and their line breaks, and lose what steers a terminal or hides.
 assert.equal(plain('/home/jos'+c(0xe9)+'/w'+c(10)+'x'+c(27)+'[2J'+c(0x202e)+'y'+c(0x200b)+'z'+String.fromCodePoint(0xe0041)+c(0xad)),'/home/jos'+c(0xe9)+'/w'+c(10)+'x [2J y z  ');
 // A result is printed as JSON in printable ASCII that reads back as the same value.
 const value={name:'jos'+c(0xe9),odd:c(0x202e)+'x'+String.fromCodePoint(0x1f600)},printed=ascii(JSON.stringify(value,null,1));
 assert.match(printed,/^[ -~\n]+$/);assert.deepEqual(JSON.parse(printed),value);
 // The key images of a transaction: one per input, in order; [] for bytes that are not a transaction.
 const k1='11'.repeat(32),k2='22'.repeat(32);
 assert.deepEqual(imagesOf('0200'+'02'+'0200'+'02'+'8101'+'05'+k1+'0200'+'01'+'07'+k2+'ffff'),[k1,k2]);
 assert.deepEqual(imagesOf(begin(k1)+'00'),[k1]);
 for(const bad of ['','zz','0200','020000','0200'+'01'+'ff'+'00'+'01'+'01'+k1,'0200'+'01'+'0200'+'01'+'01'+k1.slice(2),'0200'+'11'+'0200',Buffer.from('{"txid":"x"}').toString('hex'),null,undefined])assert.deepEqual(imagesOf(bad),[],String(bad));});

test('the command line refuses what it does not understand instead of skipping it, and asks no network before the wallet is there',()=>{
 const bin=join(import.meta.dirname,'..','xmr721.mjs'),none=join(temp('wallet-'),'none'),nowhere=['--reader','http://127.0.0.1:9','--node','http://127.0.0.1:9'];
 const at=dir=>(...args)=>{const r=spawnSync(process.execPath,[bin,...args,'--wallet',dir,...nowhere],{encoding:'utf8',timeout:20000,env:{...process.env,MORDINALS_MAX_FEE:'900000000000000',MORDINALS_SPLIT_COIN:'1'}});return [r.status,(r.stderr||r.stdout).split('\n')[0]];};
 const run=at(none),file=join(temp('wallet-'),'note.txt');writeFileSync(file,'a note');
 assert.deepEqual(run('wallet','inscribe','--file',file,'--dryrun'),[2,'There is no option --dryrun. See: xmr721 --help']);
 assert.deepEqual(run('wallet','inscribe','--file',file,'--dry-run=true'),[2,'Write "--dry-run <value>", with a space instead of "=".']);
 assert.deepEqual(run('wallet','inscribe','--file',file,'--to=4abc'),[2,'Write "--to <value>", with a space instead of "=".']);
 assert.deepEqual(run('wallet','create','--network=stagenet'),[2,'Write "--network <value>", with a space instead of "=".']);
 assert.deepEqual(run('wallet','create','--name','x'),[2,'"wallet create" takes no --name.']);
 // A forgotten value does not swallow the next option: this would otherwise have been a paid inscription named "--dry-run".
 assert.deepEqual(run('wallet','inscribe','--file',file,'--name','--dry-run'),[2,'--name needs a value.']);
 assert.deepEqual(run('wallet','inscribe','--file',file,'--edition','2'),[2,'--edition goes with --collection.']);
 assert.deepEqual(run('wallet','inscribe','--file',file,'--collection',''),[2,'--collection is empty.']);
 assert.deepEqual(run('wallet','inscribe','--file',file,'--edition','1.5','--collection','ab'.repeat(32)),[2,'--edition is a whole number, 1 or more.']);
 assert.deepEqual(run('wallet','inscribe','--file',file,'--file',file),[2,'--file is given twice.']);
 assert.deepEqual(run('wallet','split','20'),[2,'Split into 2 to 14 coins.']);
 assert.deepEqual(run('wallet','send','onlyone'),[2,'xmr721 wallet send <nft id> <address>']);
 assert.deepEqual(run('wallet','forget'),[2,'xmr721 wallet forget <n>']);assert.deepEqual(run('wallet','forget','1','--sent'),[2,'There is no option --sent. See: xmr721 --help']);
 assert.deepEqual(run('wallet','split','0'),[2,'The number of coins is a whole number, 1 or more.']);
 assert.deepEqual(run('wallet','create','--max-fee','0,02'),[2,'--max-fee is an amount of XMR with a decimal point, like 0.02.']);
 assert.deepEqual(run('wallet','create','--max-fee','5'),[2,'--max-fee is above 0 and at most 1 XMR.']);
 assert.match(run('wallet','bogus')[1],/^xmr721 wallet <create \| receive/);
 // Without a wallet nothing is asked of any reader or node: every command says so at once.
 for(const c of [['inscribe','--file',file,'--dry-run'],['inscribe','--file',file],['receive'],['balance'],['inscriptions'],['resend'],['rescan'],['collection','--name','x','--max','2'],['send','ab'.repeat(32),'4x']])
  assert.deepEqual(run('wallet',...c),[2,`There is no wallet in ${none}. Make one with: xmr721 wallet create`],c[0]);
 const help=spawnSync(process.execPath,[bin,'--help'],{encoding:'utf8'});assert.deepEqual([help.status,help.stdout.split('\n')[0],help.stderr],[0,'xmr721: inscribe on Monero from a wallet of your own (README.md, "Inscribe").','']);
 assert.ok(!/import |const /.test(help.stdout),'the help is the header of the file and nothing else');
 // A wallet folder whose wallet.json is damaged, or that has keys and no wallet.json, is told how to be put right, and is.
 const odd=join(temp('wallet-'),'odd');mkdirSync(odd,{mode:0o755});writeFileSync(join(odd,'carrier.keys.json'),JSON.stringify({spend:scalar(),view:scalar()}),{mode:0o644});const o=at(odd);
 assert.match(o('wallet','receive')[1],/has keys and no wallet.json.*xmr721 wallet restore --height/);
 writeFileSync(join(odd,'wallet.json'),'{"network":');assert.match(o('wallet','receive')[1],/wallet.json is not readable.*xmr721 wallet restore --height/);
 assert.deepEqual(o('wallet','restore','--height','x'),[2,'--height is a whole number, 1 or more.']);
 // A folder that does not say which network it is for is not taken to be a mainnet wallet.
 assert.deepEqual(o('wallet','restore','--height','3806000'),[2,'Say which network this wallet is for: add --network mainnet or --network stagenet.']);
 assert.equal(o('wallet','restore','--height','3806000','--network','mainnet')[0],0);assert.deepEqual(JSON.parse(readFileSync(join(odd,'wallet.json'),'utf8')),{network:'mainnet',start:3806000});
 assert.deepEqual([statSync(odd).mode&0o777,statSync(join(odd,'carrier.keys.json')).mode&0o777],[0o700,0o600]);
 assert.match(o('wallet','receive')[1],/^\{$/);assert.equal(o('wallet','restore','--height','5')[0],0);assert.equal(JSON.parse(readFileSync(join(odd,'wallet.json'),'utf8')).start,5);
 assert.deepEqual(o('wallet','forget','1','--dry-run'),[2,'"wallet forget" takes no --dry-run.']);assert.deepEqual(o('wallet','forget','1'),[2,'There is no such entry. See: xmr721 wallet inscriptions']);
 const asFile=join(temp('wallet-'),'f');writeFileSync(asFile,'');assert.deepEqual(at(asFile)('wallet','receive'),[2,`${asFile} is a file, not a wallet folder.`]);
 // On stagenet a reader and a domain are asked for only by the commands that need them; another domain on mainnet is refused plainly.
 const s=spawnSync(process.execPath,[bin,'wallet','receive','--wallet',odd,'--network','stagenet'],{encoding:'utf8'});assert.match(s.stderr,/This wallet is for mainnet; add --network mainnet/);
 assert.deepEqual(o('wallet','inscribe','--file',file,'--domain','ab'.repeat(32),'--dry-run'),[2,'On mainnet the ledger is ec7f7d26dba6725124df69417d43335c52e34557fc61c1d8d6b4736370e6ba1d; another domain is another ledger.']);
 // The carrier tool has to be a file.
 assert.match(o('wallet','balance','--carrier',odd)[1],/^The carrier tool is not at .*Build it with: sh reader\/carrier\/build\.sh/);
 // A stagenet wallet lists what it built by its node alone: no reader and no domain are asked for.
 const st=join(temp('wallet-'),'st');mkdirSync(st,{mode:0o700});writeFileSync(join(st,'carrier.keys.json'),JSON.stringify({spend:scalar(),view:scalar()}),{mode:0o600});writeFileSync(join(st,'wallet.json'),JSON.stringify({network:'stagenet',start:5}));
 const plainly=(...args)=>{const r=spawnSync(process.execPath,[bin,'wallet',...args,'--wallet',st,'--network','stagenet','--node','http://127.0.0.1:9'],{encoding:'utf8',timeout:20000});return [r.status,(r.stderr||r.stdout).split('\n')[0]];};
 assert.deepEqual(plainly('inscriptions'),[0,'[]']);assert.deepEqual(plainly('resend'),[0,'[]']);
 assert.deepEqual(plainly('inscribe','--file',file,'--dry-run'),[2,'On stagenet, give --reader <url> of your own reader.']);
 assert.deepEqual(plainly('inscribe','--file',file,'--dry-run','--reader','http://127.0.0.1:9'),[2,'On stagenet, give --domain <hex>: the domain of the ledger to inscribe on.']);
 const r=o('wallet','inscribe','--file',file,'--dry-run');assert.equal(r[0],2);assert.match(r[1],/^The reader at http:\/\/127\.0\.0\.1:9 does not answer \(.+\)\.$/);});
