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
import {openWallet,readerAt,typeOf,mintingClosed,keysOf,clean,LEDGERS,FINAL} from '../lib/wallet.mjs';

const NET='stagenet',dirs=[];test.after(()=>{for(const d of dirs)rmSync(d,{recursive:true,force:true});});
const temp=name=>{const d=mkdtempSync(join(tmpdir(),name));dirs.push(d);return d;};
const L=ed25519.CURVE.n,scalar=()=>{for(;;){const s=le(randomBytes(32))%L;if(s)return hex(leBytes(s));}};
// The carrier tool as the tests need it: its keys in carrier.keys.json (two random scalars, as the real tool writes
// them), its state file, coins and transactions as reader/tests/fake.mjs keeps them. `lose` makes the next send fail:
// 'before' the node has the transaction, or 'after' (the node has it and the answer is lost). `scans` counts the times
// the tool found no state file and read the chain anew; `die` makes the next build throw after the coin was used.
function carrierIn(dir,chain,{coins=5}={}){
 const c=fakeCarrier(chain,{coins}),state=join(dir,'carrier.state.json'),x={lose:null,die:false,sends:0,scans:0,
  get made(){return c.made;},get ready(){return c.ready;},set ready(v){c.ready=v;},
  status:async()=>{if(!existsSync(state)){x.scans++;writeFileSync(state,'{}');}return c.status();},
  carry:async r=>{const how=x.die;x.die=false;if(how==='no')throw Error('The network fee of this transaction (9) is above the limit (5); nothing was sent');const t=await c.carry(r);if(how==='silent')throw Error('The carrier tool did not answer in time');return t;},
  split:async n=>c.split(n),
  publish:async blob=>{x.sends++;const how=x.lose;x.lose=null;if(how==='before')throw Error('the node is not there');const done=await c.publish(blob);if(how==='after')throw Error('the answer was lost');return done;},
  init:async()=>{mkdirSync(dir,{recursive:true});const f=join(dir,'carrier.keys.json');if(!existsSync(f))writeFileSync(f,JSON.stringify({spend:scalar(),view:scalar()}));return {address:keysOf(dir,NET).address};}};
 return x;}

async function world({openFrom=106}={}){
 const launchpad=testWallet('launchpad',NET),bob=testWallet('bob',NET),fee=testWallet('fee',NET),holder=testWallet('holder',NET);
 const owners=[makeTx('reg0',[{to:holder,amount:10n**9n}])].map((t,i)=>({...ownerEntry(i,t),registrationHeight:50,ownerHeight:50}));
 const chain=fakeChain({start:100}),reader=openReader({dir:temp('wallet-reader-'),chain,network:NET,domain:DOMAIN,feeAddress:fee.address,owners,start:100,mintFrom:101,minters:[launchpad.address],openFrom});
 await reader.sync();const service=createService({reader,owners}),base='http://127.0.0.1:'+await service.listen(0);
 const make=(name,o={})=>{const dir=join(temp('wallet-'),name),carrier=carrierIn(dir,chain,o),clock={ahead:0};
  return {dir,carrier,clock,wallet:openWallet({dir,carrier,reader:o.reader??readerAt(base),chain:o.chain??chain,network:NET,domain:DOMAIN,now:()=>Date.now()+clock.ahead})};};
 const block=async()=>{chain.mine();await service.step();};
 const blocks=async n=>{for(let i=0;i<n;i++)await block();};
 const until=async h=>{while(reader.height<h)await block();};
 return {chain,reader,service,base,owners,bob,launchpad,make,block,blocks,until,close:()=>service.close()};}
// The states of what a wallet built, with block numbers and counts left out.
const states=async w=>(await w.inscriptions()).map(r=>[r.kind,r.state.replace(/block \d+/g,'block N').replace(/\d+ of 10/,'n of 10').replace(/forget \d+/,'forget N').replace(/about \d{4}-\d\d-\d\d/,'about DATE')]);
const journal=dir=>JSON.parse(readFileSync(join(dir,'journal.json'),'utf8'));

test('a wallet is made once, readable by its owner only, and its address is the one its keys give',async()=>{
 const x=await world();
 try{
  const a=x.make('a'),made=await a.wallet.create({height:x.reader.height});
  assert.equal(made.address,a.wallet.address);assert.deepEqual(JSON.parse(readFileSync(join(a.dir,'wallet.json'),'utf8')),{network:NET,start:100});
  assert.deepEqual([statSync(a.dir).mode&0o777,statSync(join(a.dir,'wallet.json')).mode&0o777,existsSync(join(a.dir,'lock'))],[0o700,0o600,false]);
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
  // Ten blocks deep it is final, and the transaction is no longer kept.
  assert.ok(journal(a.dir).entries.every(e=>e.blob));await x.blocks(FINAL-1);
  assert.deepEqual(await states(a.wallet),[['mint','on the ledger (block N)'],['mint','on the ledger (block N)']]);assert.ok(journal(a.dir).entries.every(e=>!e.blob&&e.state==='done'));
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
  // Final on the ledger, it is this wallet's own word that says so.
  await x.blocks(FINAL);await a.wallet.inscriptions();await assert.rejects(a.wallet.inscribe({content,type:5}),/This very NFT is on the ledger already/);await assert.rejects(a.wallet.collection({name:'Set',max:2}),/a collection of this name and size already/);
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

test('a transaction is kept until it is final: a failed send, a lost answer and a node that drops it lose nothing',async()=>{
 const x=await world({openFrom:102});
 try{
  await x.until(102);const a=x.make('a');await a.wallet.create({height:x.reader.height});const content=Buffer.from('kept');
  // The node is not there: the transaction is built (its coin is used) and kept.
  a.carrier.lose='before';await assert.rejects(a.wallet.inscribe({content,type:5}),/built and the node did not take it .* It is kept: "xmr721 wallet resend" sends the same transaction again/);
  assert.equal(a.carrier.made.length,1);const kept=journal(a.dir).entries;
  assert.deepEqual([kept.length,kept[0].state,kept[0].txid,Boolean(kept[0].blob),(await a.wallet.balance()).kept],[1,'built',a.carrier.made[0],true,1]);
  assert.deepEqual(await states(a.wallet),[['mint','built and never sent: run "xmr721 wallet resend", or give it up with "xmr721 wallet forget N"']]);
  // The same command again sends that transaction; nothing new is built.
  const again=await a.wallet.inscribe({content,type:5});assert.deepEqual([again.again,again.txid,a.carrier.made.length,again.state],[true,kept[0].txid,1,'waiting for a block']);
  // The node took it and its answer was lost: the node has the transaction, so it counts as sent.
  a.carrier.lose='after';const lost=await a.wallet.inscribe({content:Buffer.from('answer lost'),type:5});assert.deepEqual([lost.state,journal(a.dir).entries[1].state],['waiting for a block','sent']);
  // The program died after the node took a transaction and before that was written down: the wallet finds it with the node.
  const j0=journal(a.dir);j0.entries[1].state='built';delete j0.entries[1].sent;writeFileSync(join(a.dir,'journal.json'),JSON.stringify(j0));
  assert.deepEqual((await states(a.wallet))[1],['mint','waiting for a block']);assert.equal(journal(a.dir).entries[1].state,'sent');
  // The node drops a transaction it had (its pool was emptied): the wallet still has it, says so, and sends it again.
  x.chain.drop(lost.txid);
  assert.deepEqual((await states(a.wallet))[1],['mint','the node no longer has this transaction: run "xmr721 wallet resend" to send it again']);
  const sent=await a.wallet.resend();assert.deepEqual(sent.map(r=>[r.txid===again.txid,r.sentAgain,r.failed,r.state]),[[true,false,undefined,'waiting for a block'],[false,true,undefined,'waiting for a block']]);
  await x.block();assert.ok(x.reader.ledger.nft(again.id)&&x.reader.ledger.nft(lost.id));
  // "resend" leaves what the node has alone, reports what it still does not take, and works without a reader.
  a.carrier.lose='before';await assert.rejects(a.wallet.inscribe({content:Buffer.from('third'),type:5}));
  a.carrier.lose='before';const failed=await a.wallet.resend();assert.deepEqual(failed.map(r=>[r.sentAgain,Boolean(r.failed)]),[[false,false],[false,false],[false,true]]);
  const deaf=openWallet({dir:a.dir,carrier:a.carrier,reader:readerAt('http://127.0.0.1:9'),chain:x.chain,network:NET,domain:DOMAIN});
  assert.deepEqual((await deaf.resend()).map(r=>r.sentAgain),[false,false,true]);await assert.rejects(deaf.inscribe({content:Buffer.from('x'),type:5}),/The reader at .* does not answer/);
  // Final needs both: the reader's word and the wallet's own node showing the transaction 10 blocks deep.
  await x.blocks(FINAL-2);const early={...readerAt(x.base),entry:async id=>({...(await readerAt(x.base).entry(id)),confirmations:99})};
  await openWallet({dir:a.dir,carrier:a.carrier,reader:early,chain:x.chain,network:NET,domain:DOMAIN}).inscriptions();assert.equal(journal(a.dir).entries[2].state,'sent','a reader alone makes nothing final');
  await x.blocks(2);assert.deepEqual(await states(a.wallet),[['mint','on the ledger (block N)'],['mint','on the ledger (block N)'],['mint','on the ledger (block N)']]);
  assert.deepEqual([a.carrier.made.length,await a.wallet.resend(),journal(a.dir).entries.every(e=>!e.blob)],[3,[],true]);
  // A reader of another ledger is not listened to at all.
  const other={...readerAt(x.base),info:async()=>({network:NET,domain:'cd'.repeat(32),height:x.reader.height,mintFrom:101,openFrom:102,minters:null})};
  await assert.rejects(openWallet({dir:a.dir,carrier:a.carrier,reader:other,chain:x.chain,network:NET,domain:DOMAIN}).inscribe({content:Buffer.from('y'),type:5}),/another ledger/);
 }finally{await x.close();}});

test('giving up: what never reached the node is removed; what was sent cannot be taken back and holds its place until nodes drop it',async()=>{
 const x=await world({openFrom:102});
 try{
  await x.until(102);const a=x.make('a',{coins:14});await a.wallet.create({height:x.reader.height});
  const c=await a.wallet.collection({name:'Set',max:3});await x.block();
  // Never sent: given up, the edition is free at once and the file can be minted anew.
  a.carrier.lose='before';await assert.rejects(a.wallet.inscribe({content:Buffer.from('one'),type:5,collection:c.id}));
  assert.deepEqual(journal(a.dir).entries.filter(e=>e.kind==='mint').map(e=>[e.edition,e.state]),[[1,'built']]);
  await assert.rejects(a.wallet.rescan(),/2 transaction\(s\) of this wallet may still get into a block/);
  const gone=await a.wallet.forget(journal(a.dir).entries.find(e=>e.edition===1).n);assert.match(gone.forgotten,/removed; it never reached the node/);
  await assert.rejects(a.wallet.forget('99'),/no such entry/);
  // Sent, with the node: it cannot be given up without saying so, and saying so does not take it back.
  const one=await a.wallet.inscribe({content:Buffer.from('one'),type:5,collection:c.id});assert.equal(one.edition,1);
  await assert.rejects(a.wallet.forget(one.n),/was sent and the node has it. It cannot be taken back.*xmr721 wallet forget \d+ --sent/);
  const up=await a.wallet.forget(one.n,{sent:true});assert.match(up.forgotten,/marked as given up; it can still get into a block/);
  assert.deepEqual([journal(a.dir).entries.at(-1).state,'blob' in journal(a.dir).entries.at(-1)],['gone',false]);
  assert.deepEqual((await states(a.wallet)).at(-1),['mint','given up. It was sent, so it can still get into a block until nodes drop it (about DATE); the node has it now']);
  // Its edition is not given to another file by itself; named outright it is, with a warning. The same file is not built twice.
  const two=await a.wallet.inscribe({content:Buffer.from('two'),type:5,collection:c.id});assert.equal(two.edition,2);
  await assert.rejects(a.wallet.inscribe({content:Buffer.from('one'),type:5,collection:c.id}),/sent and then given up \(entry \d+\).*a second one would be paid for and refused/);
  const dry=await a.wallet.inscribe({content:Buffer.from('other'),type:5,collection:c.id,edition:1,dryRun:true});assert.match(dry.notes[0],/A mint of edition 1 was sent and given up; it can still get into a block before this one/);
  await assert.rejects(a.wallet.rescan(),/transaction\(s\) of this wallet may still get into a block/);
  // It gets into a block after all: it is on the ledger like any other, and said to be.
  await x.block();assert.equal(x.reader.ledger.nft(one.id)?.minted.edition,1);
  assert.match((await a.wallet.inscriptions()).find(r=>r.id===one.id).state,/^on the ledger \(block \d+, 1 of 10 confirmations\) \(it was given up, and got in all the same\)$/);
  // A send that was sent: another send of the NFT is refused while it is on its way; given up, a new one goes out with a warning.
  const own=await a.wallet.inscribe({content:Buffer.from('mine'),type:5});await x.block();
  const toBob=await a.wallet.send({nft:own.id,to:x.bob.address});
  await assert.rejects(a.wallet.send({nft:own.id,to:x.launchpad.address}),/is on its way and cannot be taken back/);
  x.chain.drop(toBob.txid);await a.wallet.forget(toBob.n,{sent:true});
  const toPad=await a.wallet.send({nft:own.id,to:x.launchpad.address});assert.match(toPad.notes[0],/A send of this NFT to .* was sent and given up; it can still get into a block before this one/);
  await x.block();assert.equal(x.reader.ledger.nft(own.id).owner,x.launchpad.address);
  // Four days after it was last sent no node holds it: it is gone from the list and holds nothing, and a rescan may run
  // once everything else is final.
  await x.blocks(FINAL+1);a.clock.ahead=5*86400000;
  assert.ok(!(await a.wallet.inscriptions()).some(r=>r.txid===toBob.txid));assert.ok(journal(a.dir).entries.every(e=>e.state==='done'));
  const scans=a.carrier.scans,back=await a.wallet.rescan();assert.deepEqual([a.carrier.scans,back.address],[scans+1,a.wallet.address]);
  // A record the ledger refused is final after 10 blocks and can then be made again; an entry that is final can be dropped from the list.
  const liar={...readerAt(x.base),collection:async(id,n)=>({...(await readerAt(x.base).collection(id,n)),editions:[]})},j=journal(a.dir);
  j.entries=j.entries.filter(e=>e.kind!=='mint');writeFileSync(join(a.dir,'journal.json'),JSON.stringify(j));
  const fooled=openWallet({dir:a.dir,carrier:a.carrier,reader:liar,chain:x.chain,network:NET,domain:DOMAIN});
  const wasted=await fooled.inscribe({content:Buffer.from('three'),type:5,collection:c.id});assert.equal(wasted.edition,1);await x.block();
  assert.deepEqual((await states(a.wallet)).at(-1),['mint','refused by the ledger (block N, n of 10 confirmations): This edition is already minted.']);
  await x.blocks(FINAL);assert.deepEqual((await states(a.wallet)).at(-1),['mint','refused by the ledger: This edition is already minted.']);
  const retry=await a.wallet.inscribe({content:Buffer.from('three'),type:5,collection:c.id});assert.deepEqual([retry.edition,retry.again],[3,undefined]);
  assert.match((await a.wallet.forget(wasted.n)).forgotten,/removed from the list/);
 }finally{await x.close();}});

test('one command at a time on a wallet folder; a build that was cut short leaves a note until a rescan; a damaged journal stops everything',async()=>{
 const x=await world({openFrom:102});
 try{
  await x.until(102);const a=x.make('a');await a.wallet.create({height:x.reader.height});
  // Two commands at once: the second is told to wait; one coin is used, one transaction built.
  const both=await Promise.allSettled([a.wallet.inscribe({content:Buffer.from('first'),type:5}),a.wallet.inscribe({content:Buffer.from('second'),type:5})]);
  assert.deepEqual(both.map(r=>r.status).sort(),['fulfilled','rejected']);assert.match(both.find(r=>r.status==='rejected').reason.message,/Another xmr721 command is working on this wallet/);
  assert.deepEqual([a.carrier.made.length,existsSync(join(a.dir,'lock'))],[1,false]);
  // A lock left by a process that is gone is taken over, by one command only; one of a live process is not, unless it
  // is older than any command runs; one that says nothing is another command's for a minute.
  const left=(pid,token='0123456789abcdef')=>writeFileSync(join(a.dir,'lock'),JSON.stringify({pid,token,since:'x'}));
  left(2147483646);const race=await Promise.allSettled([a.wallet.balance(),a.wallet.balance(),a.wallet.balance()]);
  assert.equal(race.filter(r=>r.status==='fulfilled').length,1);assert.deepEqual(readdirSync(a.dir).filter(f=>f.startsWith('lock')),[]);
  left(process.ppid);await assert.rejects(a.wallet.balance(),/Another xmr721 command is working on this wallet \(process \d+\).*remove the file/);
  a.clock.ahead=8*3600000;assert.equal((await a.wallet.balance()).kept,1);a.clock.ahead=0;
  writeFileSync(join(a.dir,'lock'),'');await assert.rejects(a.wallet.balance(),/Another xmr721 command/);a.clock.ahead=61000;assert.equal((await a.wallet.balance()).kept,1);a.clock.ahead=0;
  // The tool does not answer while it builds (it was killed): nothing is known of a transaction, and a note stays for
  // the owner through every later command, until a rescan has read the coins anew.
  a.carrier.die='silent';await assert.rejects(a.wallet.inscribe({content:Buffer.from('cut short'),type:5}),/did not answer/);
  assert.deepEqual([journal(a.dir).entries.length,a.wallet.notes().length],[1,1]);assert.match(a.wallet.notes()[0],/stopped while a transaction was being built.*xmr721 wallet rescan/);
  // The same when the program itself was stopped there: the entry it left is cleared at the next command, the note stays.
  const j=journal(a.dir);j.notes=[];j.entries.push({n:j.next++,kind:'mint',id:'ab'.repeat(32),state:'building',built:'x'});writeFileSync(join(a.dir,'journal.json'),JSON.stringify(j));
  await a.wallet.inscriptions();assert.deepEqual([journal(a.dir).entries.some(e=>e.state==='building'),a.wallet.notes().length],[false,1]);
  await a.wallet.inscribe({content:Buffer.from('after the cut'),type:5,dryRun:true});await a.wallet.balance();assert.equal(a.wallet.notes().length,1);
  // The tool saying no (no coin, a fee above the limit) marks no coin and leaves no note.
  a.carrier.die='no';await assert.rejects(a.wallet.inscribe({content:Buffer.from('refused by the tool'),type:5}),/above the limit/);assert.equal(a.wallet.notes().length,1);
  // A split is kept and sent again like a record.
  a.carrier.lose='before';await assert.rejects(a.wallet.split(3),/It is kept/);assert.equal(journal(a.dir).entries.at(-1).kind,'split');
  assert.equal((await a.wallet.resend()).at(-1).sentAgain,true);await x.blocks(FINAL);assert.deepEqual((await states(a.wallet)).at(-1),['split','done (block N)']);
  await a.wallet.rescan();assert.deepEqual(a.wallet.notes(),[]);
  // The block the scan starts at can be set anew while nothing is on its way; the coins are then read anew.
  const scans=a.carrier.scans;assert.deepEqual(await a.wallet.restore(50),{address:a.wallet.address,start:50});assert.equal(JSON.parse(readFileSync(join(a.dir,'wallet.json'),'utf8')).start,50);
  await a.wallet.balance();assert.equal(a.carrier.scans,scans+1);
  await a.wallet.inscribe({content:Buffer.from('on its way'),type:5});await assert.rejects(a.wallet.restore(60),/may still get into a block/);
  // A journal that does not read: nothing is done and nothing is overwritten.
  const good=readFileSync(join(a.dir,'journal.json'),'utf8');writeFileSync(join(a.dir,'journal.json'),good.slice(0,60));
  for(const run of [()=>a.wallet.inscribe({content:Buffer.from('x'),type:5}),()=>a.wallet.inscriptions(),()=>a.wallet.resend(),()=>a.wallet.balance(),()=>a.wallet.forget('1'),()=>a.wallet.rescan()])await assert.rejects(run(),/journal.json is damaged and nothing was changed/);
  assert.equal(readFileSync(join(a.dir,'journal.json'),'utf8'),good.slice(0,60));
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
  // A reader that does not show the wallet's own final edition (it lost it, or lies): the wallet knows it minted it.
  const blind={...readerAt(x.base),collection:async(id,n)=>({...(await readerAt(x.base).collection(id,n)),editions:[]})};
  const w=openWallet({dir:a.dir,carrier:a.carrier,reader:blind,chain:x.chain,network:NET,domain:DOMAIN});
  assert.equal((await w.inscribe({content:Buffer.from('two'),type:5,collection:c.id,dryRun:true})).edition,2);
  // What can be seen to be wrong without a reader is said without asking one.
  const deaf=openWallet({dir:a.dir,carrier:a.carrier,reader:readerAt('http://127.0.0.1:9'),chain:x.chain,network:NET,domain:DOMAIN});
  await assert.rejects(deaf.inscribe({content:Buffer.from('x'),type:5,name:'say "hi"'}),/name|quote/i);await assert.rejects(deaf.collection({name:'Too many',max:10001}),/1 to 10000 editions/);
  await assert.rejects(deaf.inscribe({content:Buffer.alloc(900,1),type:1,to:x.bob.address}),/more than 1000 bytes/);await assert.rejects(deaf.inscribe({content:Buffer.from('x'),type:5,collection:c.id,edition:10001}),/An edition is 1 to 10000/);
 }finally{await x.close();}});

test('a reader\'s answers are checked before anything is signed or built, and on mainnet the ledger is fixed',async()=>{
 const x=await world({openFrom:102});
 try{
  await x.until(102);const real=readerAt(x.base);
  const a=x.make('a');await a.wallet.create({height:x.reader.height});const c=await a.wallet.collection({name:'Set',max:2});await x.block();
  const made=a.carrier.made.length,stub=answers=>new Promise(done=>{const s=createServer((req,res)=>{const v=answers(req.url);res.writeHead(v.status??200,{'content-type':'application/json'});res.end(typeof v.body==='string'?v.body:JSON.stringify(v.body));});s.listen(0,'127.0.0.1',()=>done(s));});
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
 assert.equal(clean('a'+c(27)+'[31mb'+c(7)+'c'+c(0x2028)+'d'+c(0x202e)+'e'+c(0x9b)+'f'),'a [31mb c d e f');assert.equal(clean('x'.repeat(500)).length,200);assert.equal(clean(null),'');});

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
 assert.deepEqual(run('wallet','inscribe','--file',file,'--edition','1.5','--collection','ab'.repeat(32)),[2,'--edition is a whole number.']);
 assert.deepEqual(run('wallet','inscribe','--file',file,'--file',file),[2,'--file is given twice.']);
 assert.deepEqual(run('wallet','split','20'),[2,'Split into 2 to 14 coins.']);
 assert.deepEqual(run('wallet','send','onlyone'),[2,'xmr721 wallet send <nft id> <address>']);
 assert.deepEqual(run('wallet','forget'),[2,'xmr721 wallet forget <n> [--sent]']);
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
 assert.deepEqual(o('wallet','restore','--height','x'),[2,'--height is a whole number.']);
 assert.equal(o('wallet','restore','--height','3806000')[0],0);assert.deepEqual(JSON.parse(readFileSync(join(odd,'wallet.json'),'utf8')),{network:'mainnet',start:3806000});
 assert.deepEqual([statSync(odd).mode&0o777,statSync(join(odd,'carrier.keys.json')).mode&0o777],[0o700,0o600]);
 assert.match(o('wallet','receive')[1],/^\{$/);assert.equal(o('wallet','restore','--height','5')[0],0);assert.equal(JSON.parse(readFileSync(join(odd,'wallet.json'),'utf8')).start,5);
 assert.deepEqual(o('wallet','forget','1','--dry-run'),[2,'"wallet forget" takes no --dry-run.']);assert.deepEqual(o('wallet','forget','1','--sent'),[2,'There is no such entry. See: xmr721 wallet inscriptions']);
 const asFile=join(temp('wallet-'),'f');writeFileSync(asFile,'');assert.deepEqual(at(asFile)('wallet','receive'),[2,`${asFile} is a file, not a wallet folder.`]);
 // On stagenet a reader and a domain are asked for only by the commands that need them; another domain on mainnet is refused plainly.
 const s=spawnSync(process.execPath,[bin,'wallet','receive','--wallet',odd,'--network','stagenet'],{encoding:'utf8'});assert.match(s.stderr,/This wallet is for mainnet; add --network mainnet/);
 assert.deepEqual(o('wallet','inscribe','--file',file,'--domain','ab'.repeat(32),'--dry-run'),[2,'On mainnet the ledger is ec7f7d26dba6725124df69417d43335c52e34557fc61c1d8d6b4736370e6ba1d; another domain is another ledger.']);
 const r=o('wallet','inscribe','--file',file,'--dry-run');assert.equal(r[0],2);assert.match(r[1],/^The reader at http:\/\/127\.0\.0\.1:9 does not answer \(.+\)\.$/);});
