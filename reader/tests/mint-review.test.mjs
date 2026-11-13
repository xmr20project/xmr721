// What the review before the first mint block found (docs/OPEN-POINTS.md), each as a test that fails on the code
// before its fix. A made-up node, relay wallet and keys; nothing here is a real chain or wallet.
//   node --test reader/tests/mint-review.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OP,decodeRecord,encodeBody,NO_COLLECTION} from '../../rules/lib/records.mjs';
import {createLedger} from '../../rules/lib/ledger.mjs';
import {outputSecret,signWithOutputKey} from '../../rules/lib/claim.mjs';
import {wallet,makeTx,ownerEntry,DOMAIN} from '../../rules/tests/helpers.mjs';
import {openReader} from '../lib/reader.mjs';
import {createRelay} from '../lib/relay.mjs';
import {createService} from '../service.mjs';
import {verify} from '../tools/verify.mjs';
import {fakeChain,fakeCarrier,carried} from './fake.mjs';

const dirs=[];test.after(()=>{for(const d of dirs)rmSync(d,{recursive:true,force:true});});
const hex=b=>Buffer.from(b).toString('hex'),TEXT=5;

function world({minters=null,mintFrom=100,coins=20,limits={},lane=[],origins=[]}={}){
 const w=Object.fromEntries(['alice','bob','carol','fee',...Array.from({length:6},(_,i)=>'anon'+i)].map(n=>[n,wallet(n)]));
 const txs=[w.alice,w.bob].map((h,i)=>makeTx('reg'+i,[{to:h,amount:10n**9n}])),owners=txs.map((t,i)=>({...ownerEntry(i,t),registrationHeight:50+i,ownerHeight:50+i}));
 const dir=mkdtempSync(join(tmpdir(),'mint-review-'));dirs.push(dir);
 const chain=fakeChain({start:100}),setup={chain,domain:DOMAIN,feeAddress:w.fee.address,owners,start:100,mintFrom,checkpointEvery:2},pick=m=>m?m.map(n=>w[n].address):null;
 const reader=openReader({dir:join(dir,'state'),...setup,minters:pick(minters)}),carrier=fakeCarrier(chain,{coins});let clock=1_000_000;
 const relay=createRelay({dir:join(dir,'relay'),reader,chain,carrier,domain:DOMAIN,limits:{resendMs:1000,...limits},lane:lane.map(n=>w[n].address),now:()=>clock});
 const service=createService({reader,relay,owners,origins,testHooks:true});
 const L=()=>reader.ledger,signed=(p,who)=>L().sign(p.bodyBytes,who.sign(p.text));
 const mint=(who,text,o={})=>{const p=L().prepareMint({creator:who.address,type:TEXT,content:Buffer.from(text),...o});return {...p,record:signed(p,who)};};
 const claim=(n,h)=>{const p=L().prepareClaim({mordinal:n,to:h.address});return L().claimWithKey(p.bodyBytes,signWithOutputKey(p.keyHash,outputSecret({viewSecret:h.viewSecret,spendSecret:h.spendSecret,txPub:owners[n].ownerTxPubKeys[0],subScalar:h.subScalar})));};
 const block=async(...records)=>{chain.mine(records.map(r=>carried(r)));await service.step();};
 return {w,dir,setup,owners,chain,reader,relay,carrier,service,L,signed,mint,claim,block,pick,tick:ms=>{clock+=ms;}};}
async function served(x){const port=await x.service.listen(0),base='http://127.0.0.1:'+port;
 return {base,get:async(path,headers={})=>{const r=await fetch(base+path,{headers});return {status:r.status,headers:r.headers,body:r.headers.get('content-type')?.startsWith('application/json')?await r.json():await r.text()};},
  post:async(record,headers={})=>{const r=await fetch(base+'/records',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify({record})});return {status:r.status,body:await r.json()};}};}

test('a name cannot hold a double quote, so it cannot close the quotes of a signed text',async()=>{
 const x=world();await x.reader.sync();const {w,L}=x;
 for(const name of ['A" named "B','"','say "hi"'])
  for(const make of [()=>L().prepareCollection({creator:w.alice.address,name,max:3}),()=>L().prepareMint({creator:w.alice.address,name,type:TEXT,content:Buffer.from('x')})])assert.throws(make,/no double quote/,name);
 // The same bytes with a quote written into the name by hand are not a record.
 const good=L().prepareMint({creator:w.alice.address,name:'AxB',type:TEXT,content:Buffer.from('x')}),bytes=Uint8Array.from(good.bodyBytes),at=Buffer.from(bytes).indexOf('AxB');
 bytes[at+1]=0x22;assert.throws(()=>decodeRecord(bytes,'mainnet',{sig:false}),/Bad name/);
 // Two collections whose names differ only by where a quote would sit can no longer give one text.
 assert.ok(L().prepareCollection({creator:w.alice.address,name:"A' named 'B",max:3}).text.includes(`create "A' named 'B" with 3 editions`));});

test('a ledger whose setup lists its minters: only they make collections and mint; everyone still moves, sells and burns what they own',async()=>{
 const x=world({minters:['alice']}),{w,L,signed,mint,block,reader}=x;await reader.sync();
 const refused=()=>reader.journal.at(-1);
 const set=L().prepareCollection({creator:w.bob.address,name:'Bob set',max:2});await block(signed(set,w.bob));
 assert.deepEqual([refused().ok,refused().error],[false,'On this ledger only the listed addresses make collections and mint.']);
 await block(mint(w.bob,'not listed').record);assert.equal(refused().ok,false);assert.equal(L().nftsOf(w.bob.address).length,0);
 const mine=mint(w.alice,'listed'),gift=mint(w.alice,'for bob',{to:w.bob.address});await block(mine.record,gift.record);
 assert.deepEqual([L().nft(mine.id).owner,L().nft(gift.id).owner],[w.alice.address,w.bob.address]);
 // Bob holds an NFT a listed minter made: he moves it and burns it like any owner.
 await block(signed(L().prepareMove({mordinal:gift.id,from:w.bob.address,to:w.carol.address}),w.bob));assert.equal(L().nft(gift.id).owner,w.carol.address);
 await block(signed(L().prepareBurn({nft:gift.id,owner:w.carol.address}),w.carol));assert.equal(L().nft(gift.id).burned,true);
 // The list is part of the ledger's setup: the rule library takes it, and an empty or malformed one is refused.
 const lib=o=>createLedger({domain:DOMAIN,feeAddress:w.fee.address,owners:x.owners,height:100,mintFrom:100,...o});
 assert.throws(()=>lib({minters:[]}),/Bad minter list/);assert.throws(()=>lib({minters:['nonsense']}));assert.throws(()=>lib({minters:w.alice.address}),/Bad minter list/);
 const open=lib({});open.setHeight(101);open.apply(mint(w.bob,'anyone, where no list is set').record);});

test('the first mint block and the minter list are part of a state folder, of /info and of every checkpoint',async()=>{
 const x=world({minters:['alice','bob']}),{w,setup,reader,block,mint}=x;await reader.sync();
 await block(mint(w.alice,'one').record);await block();await block();
 const web=await served(x);
 try{
  const info=(await web.get('/info')).body;assert.deepEqual([info.mintFrom,info.minters],[100,[w.alice.address,w.bob.address].sort()]);
  const mark=reader.checkpoint();assert.deepEqual([mark.mintFrom,mark.minters],[100,[w.alice.address,w.bob.address].sort().join(',')]);
  // The same folder opened for another setup is refused, whichever part differs; the order of the list does not matter.
  const again=o=>openReader({dir:join(x.dir,'state'),...setup,minters:x.pick(['alice','bob']),...o});
  assert.throws(()=>again({minters:x.pick(['alice'])}),/minters differs/);assert.throws(()=>again({minters:null}),/minters differs/);assert.throws(()=>again({mintFrom:101}),/mintFrom differs/);
  again({minters:x.pick(['bob','alice'])});
  // The check tool replays with the service's setup and refuses a checkpoint of another one.
  const entries=(await web.get('/log?limit=500')).body.entries,checkpoints=(await web.get('/checkpoints')).body.checkpoints;
  assert.ok(checkpoints.length>0&&checkpoints.every(c=>c.mintFrom===100));
  assert.equal((await verify({info,entries,checkpoints,owners:x.owners})).ok,true);
  const other=await verify({info,entries,checkpoints:checkpoints.map(c=>({...c,mintFrom:90})),owners:x.owners});
  assert.equal(other.ok,false);assert.match(other.problems.join(' '),/another first mint block or minter list/);
  // A ledger without a first mint block has the checkpoints it always had.
  const plain=world({mintFrom:null});await plain.reader.sync();assert.deepEqual(Object.keys(plain.reader.checkpoint()),['schema','network','domain','owners','start','height','blockHash','records','listHash','stateHash']);
 }finally{await x.service.close();}});

test('the relay counts records per connection, as its limits say',async()=>{
 const x=world({limits:{perCallerDay:2}});await x.reader.sync();const web=await served(x);
 try{
  const got=[];for(let i=0;i<4;i++)got.push((await web.post(hex(x.mint(x.w['anon'+i],'junk '+i).record))).status);
  assert.deepEqual(got,[200,200,429,429]);
  const jobs=readdirSync(join(x.dir,'relay','jobs')).map(f=>JSON.parse(readFileSync(join(x.dir,'relay','jobs',f),'utf8')));
  assert.equal(jobs.length,2);assert.ok(jobs.every(j=>typeof j.caller==='string'&&j.caller.length>0&&!j.caller.includes('127.0.0.1')));
 }finally{await x.service.close();}});

test('a record the relay gave up on as stuck can be handed over again',async()=>{
 const x=world({coins:0,limits:{stuckBlocks:2,minReady:0}});await x.reader.sync();const {relay,carrier,block,w}=x;
 const m=x.mint(w.alice,'waits for a coin'),first=await relay.submit(hex(m.record));assert.equal(first.state,'queued');
 for(let i=0;i<4;i++)await block();assert.equal(relay.status(m.id).state,'stuck');
 // The relay's wallet has coins again and the same record comes back: it waits for a block again, not "stuck" for good.
 carrier.ready=5;const again=await relay.submit(hex(m.record));assert.equal(again.state,'queued');
 for(let i=0;i<4&&!x.L().nft(m.id);i++)await block();
 assert.equal(carrier.made.length,1);assert.equal(x.L().nft(m.id).owner,w.alice.address);assert.equal(relay.status(m.id).state,'done');});

test('a listed minter\'s mints are not crowded out by what everyone else has waiting',async()=>{
 const x=world({coins:0,limits:{waiting:3,minReady:0},lane:['alice']});await x.reader.sync();const {relay,w}=x,send=async r=>{try{return (await relay.submit(hex(r.record))).state;}catch(e){return e.status;}};
 const got=[];for(let i=0;i<5;i++)got.push(await send(x.mint(w['anon'+i],'junk '+i)));
 assert.deepEqual(got,['queued','queued','queued',503,503]);
 // The lane is for the listed address's collections and mints, three at a time like any address; nobody else has it.
 assert.deepEqual([await send(x.mint(w.alice,'launch 1')),await send(x.mint(w.alice,'launch 2')),await send(x.mint(w.alice,'launch 3')),await send(x.mint(w.alice,'launch 4'))],['queued','queued','queued',429]);
 assert.equal(await send(x.mint(w.bob,'not in the lane')),503);});

test('a burned Mordinal says so wherever its state is served, and a page on an allowed origin can read an NFT\'s text',async()=>{
 const x=world({origins:['https://xmr20.org']}),{w,L,signed,block,reader}=x;await reader.sync();
 await block(x.claim(0,w.alice));assert.equal(L().mordinal(0).owner,w.alice.address);
 await block(signed(L().prepareBurn({nft:x.owners[0].registrationTx,owner:w.alice.address}),w.alice));
 const note=x.mint(w.bob,'a note');await block(note.record);
 const web=await served(x);
 try{
  const one=(await web.get('/mordinal/0')).body.mordinal??(await web.get('/mordinal/0')).body;
  assert.deepEqual([one.claimed,one.owner,one.burned],[true,null,true]);
  assert.equal((await web.get('/mordinal/1')).body.burned,undefined);
  const text=await web.get('/nft/'+note.id+'/content',{origin:'https://xmr20.org'});
  assert.deepEqual([text.status,text.body,text.headers.get('access-control-allow-origin')],[200,'a note','https://xmr20.org']);
  assert.equal((await web.get('/nft/'+note.id+'/content',{origin:'https://elsewhere.example'})).headers.get('access-control-allow-origin'),null);
 }finally{await x.service.close();}});
