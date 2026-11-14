// Offline tests of the xmr721 wallet (cli/lib/wallet.mjs): a made-up node and a stand-in for the carrier tool that
// keeps its keys the way the real one does, a reader over HTTP, and a ledger whose minting opens to everyone at a block.
//   node --test cli/tests/wallet.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,existsSync,mkdirSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ed25519} from '@noble/curves/ed25519';
import {wallet as testWallet,makeTx,ownerEntry,DOMAIN} from '../../rules/tests/helpers.mjs';
import {le,leBytes,hex} from '../../rules/lib/monero.mjs';
import {MAX_RECORD} from '../../rules/lib/records.mjs';
import {openReader} from '../../reader/lib/reader.mjs';
import {createService} from '../../reader/service.mjs';
import {fakeChain,fakeCarrier,carried} from '../../reader/tests/fake.mjs';
import {openWallet,readerAt,typeOf,mintingClosed,keysOf} from '../lib/wallet.mjs';

const dirs=[];test.after(()=>{for(const d of dirs)rmSync(d,{recursive:true,force:true});});
const temp=name=>{const d=mkdtempSync(join(tmpdir(),name));dirs.push(d);return d;};
const L=ed25519.CURVE.n,scalar=()=>{for(;;){const s=le(randomBytes(32))%L;if(s)return hex(leBytes(s));}};
// The carrier tool as the tests need it: its keys in carrier.keys.json (two random scalars, as the real tool writes
// them), coins and transactions as reader/tests/fake.mjs keeps them.
function carrierIn(dir,chain,{coins=5}={}){
 const c=fakeCarrier(chain,{coins});
 return {...c,get made(){return c.made;},set ready(v){c.ready=v;},
  init:async()=>{mkdirSync(dir,{recursive:true});const f=join(dir,'carrier.keys.json');if(!existsSync(f))writeFileSync(f,JSON.stringify({spend:scalar(),view:scalar()}));return {address:keysOf(dir,'mainnet').address};}};}

async function world({openFrom=106,coins=5}={}){
 const launchpad=testWallet('launchpad'),bob=testWallet('bob'),fee=testWallet('fee'),holder=testWallet('holder');
 const owners=[makeTx('reg0',[{to:holder,amount:10n**9n}])].map((t,i)=>({...ownerEntry(i,t),registrationHeight:50,ownerHeight:50}));
 const chain=fakeChain({start:100}),reader=openReader({dir:temp('wallet-reader-'),chain,domain:DOMAIN,feeAddress:fee.address,owners,start:100,mintFrom:101,minters:[launchpad.address],openFrom});
 await reader.sync();const service=createService({reader,owners}),base='http://127.0.0.1:'+await service.listen(0);
 const make=(name,o={})=>{const dir=join(temp('wallet-'),name),carrier=carrierIn(dir,chain,o);return {dir,carrier,wallet:openWallet({dir,carrier,reader:readerAt(base),network:'mainnet'})};};
 const block=async()=>{chain.mine();await service.step();};
 const until=async h=>{while(reader.height<h)await block();};
 return {chain,reader,service,base,owners,bob,launchpad,make,block,until,close:()=>service.close()};}

test('a wallet is made once, and its address is the one its keys give',async()=>{
 const x=await world();
 try{
  const a=x.make('a'),made=await a.wallet.create({height:x.reader.height});
  assert.equal(made.address,a.wallet.address);assert.deepEqual(JSON.parse(readFileSync(join(a.dir,'wallet.json'),'utf8')),{network:'mainnet',start:100});
  await assert.rejects(a.wallet.create({height:100}),/a wallet in .* already/);
  assert.throws(()=>x.make('none').wallet.address,/There is no wallet/);
  const b=await a.wallet.balance();assert.deepEqual([b.address,b.ready,b.coins],[made.address,5,5]);
 }finally{await x.close();}});

test('inscribing: closed to anyone off the list until the opening block, then one NFT owned by the wallet or by --to',async()=>{
 const x=await world();
 try{
  const a=x.make('a');await a.wallet.create({height:x.reader.height});const content=Buffer.from('hello, Monero'),me=a.wallet.address;
  // Before the opening block: refused here, before anything is built or sent.
  await assert.rejects(a.wallet.inscribe({content,type:5}),/Minting opens to everyone at block 106/);assert.equal(a.carrier.made.length,0);
  await x.until(105);
  // A dry run makes and signs the record, and sends nothing.
  const dry=await a.wallet.inscribe({content,type:5,name:'hello',dryRun:true});
  assert.deepEqual([dry.dryRun,dry.kind,dry.owner,a.carrier.made.length,existsSync(join(a.dir,'inscriptions.jsonl'))],[true,'mint',me,0,false]);
  assert.match(dry.text,/^XMR721 mint: one NFT in no collection named "hello"; 13 bytes of type 5/);
  const one=await a.wallet.inscribe({content,type:5,name:'hello'}),two=await a.wallet.inscribe({content:Buffer.from('for bob'),type:5,to:x.bob.address});
  assert.equal(one.id,dry.id,'the same record whenever it is made');assert.equal(a.carrier.made.length,2);assert.ok(one.txid&&one.fee);
  await x.block();
  assert.deepEqual([x.reader.ledger.nft(one.id)?.owner,x.reader.ledger.nft(two.id)?.owner,x.reader.ledger.nft(one.id)?.minted.creator],[me,x.bob.address,me]);
  // What the wallet sent, and where each is now.
  assert.deepEqual((await a.wallet.inscriptions()).map(r=>[r.kind,r.id,r.state]),[['mint',one.id,'on the ledger, owned by '+me],['mint',two.id,'on the ledger, owned by '+x.bob.address]]);
 }finally{await x.close();}});

test('collections: made by the wallet, its editions minted in turn by the wallet alone; sending an NFT the wallet owns',async()=>{
 const x=await world({openFrom:102});
 try{
  await x.until(101);const a=x.make('a'),b=x.make('b');await a.wallet.create({height:x.reader.height});await b.wallet.create({height:x.reader.height});
  const c=await a.wallet.collection({name:'Moons',max:3});await x.block();
  assert.deepEqual(x.reader.ledger.collection(c.id)?.creator,a.wallet.address);
  const e1=await a.wallet.inscribe({content:Buffer.from('moon 1'),type:5,collection:c.id});await x.block();
  const e2=await a.wallet.inscribe({content:Buffer.from('moon 2'),type:5,collection:c.id});
  assert.deepEqual([e1.edition,e2.edition],[1,2]);assert.match(e2.text,/edition 2 of "Moons"/);await x.block();
  await assert.rejects(a.wallet.inscribe({content:Buffer.from('again'),type:5,collection:c.id,edition:1}),/Edition 1 of this collection is minted already/);
  await assert.rejects(a.wallet.inscribe({content:Buffer.from('x'),type:5,collection:c.id,edition:4}),/An edition of this collection is 1 to 3/);
  await assert.rejects(b.wallet.inscribe({content:Buffer.from('mine?'),type:5,collection:c.id}),/only its creator mints its editions/);
  await assert.rejects(a.wallet.inscribe({content:Buffer.from('x'),type:5,collection:'ab'.repeat(32)}),/not on the ledger/);
  // Send edition 1 to b; then b sends it back. Each send names the NFT's latest state.
  const s=await a.wallet.send({nft:e1.id,to:b.wallet.address});assert.match(s.text,/^Mordinals move: send "Moons" #1 \(NFT [0-9a-f]{32}\) to /);await x.block();
  assert.equal(x.reader.ledger.nft(e1.id).owner,b.wallet.address);
  await assert.rejects(a.wallet.send({nft:e1.id,to:x.bob.address}),/belongs to .*, not to this wallet/);
  await b.wallet.send({nft:e1.id,to:a.wallet.address});await x.block();assert.equal(x.reader.ledger.nft(e1.id).owner,a.wallet.address);
  await assert.rejects(a.wallet.send({nft:e1.id,to:a.wallet.address}),/own address/);
  assert.deepEqual((await a.wallet.inscriptions()).map(r=>[r.kind,r.state]),[['collection','on the ledger, 2 of 3 minted'],['mint','on the ledger, owned by '+a.wallet.address],['mint','on the ledger, owned by '+a.wallet.address],['send','done']]);
 }finally{await x.close();}});

test('what the wallet does not send: no coin ready, a record too big, a name the rules refuse, a reader of another network',async()=>{
 const x=await world({openFrom:102});
 try{
  await x.until(102);const a=x.make('a',{coins:0});await a.wallet.create({height:x.reader.height});
  await assert.rejects(a.wallet.inscribe({content:Buffer.from('x'),type:5}),/The wallet has no coins. Send some XMR to 4/);
  a.carrier.ready=1;
  await assert.rejects(a.wallet.inscribe({content:Buffer.alloc(MAX_RECORD,1),type:1}),/record is \d+ bytes; a record is at most 1000/);
  await assert.rejects(a.wallet.inscribe({content:Buffer.from('x'),type:5,name:'say "hi"'}),/name|quote/i);
  await assert.rejects(a.wallet.collection({name:'Too many',max:10001}),/1 to 10000 editions/);
  await assert.rejects(a.wallet.inscribe({content:Buffer.alloc(0),type:5}),/empty/);
  assert.equal(a.carrier.made.length,0);
  const other=openWallet({dir:a.dir,carrier:a.carrier,reader:readerAt(x.base),network:'stagenet'});await assert.rejects(other.inscribe({content:Buffer.from('x'),type:5}),/The reader is for mainnet, the wallet for stagenet/);
 }finally{await x.close();}});

test('content types and the minting check',()=>{
 assert.deepEqual(['a.png','b.JPG','c.jpeg','d.webp','e.gif','f.txt','g.json','h.mp4'].map(f=>typeOf(f)),[1,2,2,3,4,5,6,7]);
 assert.deepEqual([typeOf('x.bin','art'),typeOf('x','9'),typeOf('x.png','text')],[8,9,5]);
 assert.throws(()=>typeOf('x.bin'),/give --type/);assert.throws(()=>typeOf('x','0'),/1 to 255/);assert.throws(()=>typeOf('x','pdf'),/content type name/);
 const info={height:99,mintFrom:101,minters:['L'],openFrom:110};
 assert.match(mintingClosed({...info,mintFrom:null},'A'),/no minting/);assert.match(mintingClosed(info,'A'),/starts at block 101/);
 assert.equal(mintingClosed({...info,height:100},'L'),null);assert.match(mintingClosed({...info,height:100},'A'),/opens to everyone at block 110/);
 assert.equal(mintingClosed({...info,height:109},'A'),null);assert.equal(mintingClosed({...info,minters:undefined,openFrom:undefined,height:100},'A'),null);
 assert.match(mintingClosed({...info,openFrom:undefined,height:100},'A'),/only its listed minters/);});
