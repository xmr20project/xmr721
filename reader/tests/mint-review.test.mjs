// What the review before the first mint block found (docs/OPEN-POINTS.md), each as a test that fails on the code
// before its fix. A made-up node, relay wallet and keys; nothing here is a real chain or wallet.
//   node --test reader/tests/mint-review.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync,readFileSync,existsSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OP,decodeRecord,encodeBody,NO_COLLECTION} from '../../rules/lib/records.mjs';
import {createLedger} from '../../rules/lib/ledger.mjs';
import {outputSecret,signWithOutputKey} from '../../rules/lib/claim.mjs';
import {wallet,makeTx,ownerEntry,DOMAIN} from '../../rules/tests/helpers.mjs';
import {openReader,SCHEMA,SCHEMA_MINTERS,SCHEMA_OPEN} from '../lib/reader.mjs';
import {createRelay} from '../lib/relay.mjs';
import {createService} from '../service.mjs';
import {verify,scan,download} from '../tools/verify.mjs';
import {fakeChain,fakeCarrier,carried} from './fake.mjs';

const dirs=[];test.after(()=>{for(const d of dirs)rmSync(d,{recursive:true,force:true});});
const hex=b=>Buffer.from(b).toString('hex'),TEXT=5;

function world({minters=null,mintFrom=100,coins=20,limits={},lane=[],fees=null,origins=[],holders=['alice','bob']}={}){
 const w=Object.fromEntries(['alice','bob','carol','fee',...Array.from({length:6},(_,i)=>'anon'+i)].map(n=>[n,wallet(n)]));
 const txs=holders.map(n=>w[n]).map((h,i)=>makeTx('reg'+i,[{to:h,amount:10n**9n}])),owners=txs.map((t,i)=>({...ownerEntry(i,t),registrationHeight:50+i,ownerHeight:50+i}));
 const dir=mkdtempSync(join(tmpdir(),'mint-review-'));dirs.push(dir);
 const chain=fakeChain({start:100}),setup={chain,domain:DOMAIN,feeAddress:w.fee.address,owners,start:100,mintFrom,checkpointEvery:2},pick=m=>m?m.map(n=>w[n].address):null;
 const reader=openReader({dir:join(dir,'state'),...setup,minters:pick(minters)}),carrier=fakeCarrier(chain,{coins});let clock=1_000_000;
 const relay=createRelay({dir:join(dir,'relay'),reader,chain,carrier,domain:DOMAIN,limits:{resendMs:1000,...limits},lane:lane.map(n=>w[n].address),...(fees?{fees}:{}),now:()=>clock});
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
  assert.throws(()=>again({minters:x.pick(['alice'])}),/minters differs/);assert.throws(()=>again({minters:null}),/schema differs/);assert.throws(()=>again({mintFrom:101}),/mintFrom differs/);
  again({minters:x.pick(['bob','alice'])});
  // The check tool replays with the service's setup and refuses a checkpoint of another one.
  const entries=(await web.get('/log?limit=500')).body.entries,checkpoints=(await web.get('/checkpoints')).body.checkpoints;
  assert.ok(checkpoints.length>0&&checkpoints.every(c=>c.mintFrom===100));
  assert.equal((await verify({info,entries,checkpoints,owners:x.owners})).ok,true);
  const other=await verify({info,entries,checkpoints:checkpoints.map(c=>({...c,mintFrom:90})),owners:x.owners});
  assert.equal(other.ok,false);assert.match(other.problems.join(' '),/another first mint block, minter list or opening block/);
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

test('a listed minter\'s mints are not crowded out by what everyone else has waiting, and a relay with a lane carries no one else\'s mints',async()=>{
 const x=world({coins:0,limits:{waiting:2,minReady:0},lane:['alice'],holders:['alice','bob','carol']});await x.reader.sync();const {relay,w}=x,send=async r=>{try{return (await relay.submit(hex(r.record??r))).state;}catch(e){return e.status;}};
 // Everyone else's records fill the relay's waiting places.
 assert.deepEqual([await send(x.claim(1,w.bob)),await send(x.claim(2,w.carol))],['queued','queued']);
 // The lane is for the listed address's collections and mints, three at a time like any address; nobody else has it.
 assert.deepEqual([await send(x.mint(w.alice,'launch 1')),await send(x.mint(w.alice,'launch 2')),await send(x.mint(w.alice,'launch 3')),await send(x.mint(w.alice,'launch 4'))],['queued','queued','queued',429]);
 // Collections and mints of anyone else are not carried by a relay with a lane: they come from wallets of their own.
 const own=x.signed(x.L().prepareCollection({creator:w.bob.address,name:'mine',max:2}),w.bob);
 for(const r of [x.mint(w.bob,'not in the lane'),x.mint(w['anon0'],'junk'),own])assert.equal(await send(r),403);
 await assert.rejects(relay.submit(hex(x.mint(w.carol,'x').record)),/own minters only/);
 // Nothing was kept for any of them, and a job of such a record left from before the rule is refused at the next pass, unsent.
 assert.equal(relay.jobs().filter(j=>j.op===8||j.op===7).length,3,'only the three of the listed address');
 const left=x.mint(w.carol,'left over'),file=join(x.dir,'relay','jobs',left.id+'.json');
 writeFileSync(file,JSON.stringify({id:left.id,record:hex(left.record),op:8,number:null,signer:w.carol.address,caller:null,state:'queued',createdAt:1,createdHeight:100}));
 const again=createRelay({dir:join(x.dir,'relay'),reader:x.reader,chain:x.chain,carrier:x.carrier,domain:DOMAIN,lane:[w.alice.address]});x.carrier.ready=5;await again.tick();
 assert.deepEqual([again.status(left.id).state,/own minters only/.test(again.status(left.id).error),x.carrier.made.length],['refused',true,x.carrier.made.length]);
 // Such a record marked stuck is not sent again either.
 await assert.rejects(again.submit(hex(left.record)),/own minters only/);});

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

// ---- Found in a second read, of the fixes above ----

test('the check tool\'s own scan reads with the service\'s minter list, and a minter list is never empty',async()=>{
 const x=world({minters:['alice']}),{w,reader,block,mint}=x;await reader.sync();
 await block(mint(w.bob,'not listed').record,mint(w.alice,'listed').record);await block();
 const web=await served(x);
 try{
  const info=(await web.get('/info')).body,entries=(await web.get('/log?limit=500')).body.entries;
  assert.deepEqual(entries.map(e=>e.ok),[false,true]);
  assert.deepEqual(await scan({info,entries,owners:x.owners,chain:x.chain,dir:join(x.dir,'scan'),height:info.height}),[]);
  // An empty list is refused before anything is written, so the folder stays usable; so is the flag given without a value.
  const fresh=join(x.dir,'fresh');assert.throws(()=>openReader({dir:fresh,...x.setup,minters:[]}),/Bad minter list/);assert.ok(!existsSync(join(fresh,'meta.json')));
  openReader({dir:fresh,...x.setup,minters:x.pick(['alice'])});
  const run=(...more)=>spawnSync(process.execPath,[join(import.meta.dirname,'../service.mjs'),'--owners',join(import.meta.dirname,'../../ownership-index/added/added.jsonl'),'--domain',DOMAIN,'--fee-address',w.fee.address,'--node','http://127.0.0.1:9','--start','100','--state',join(x.dir,'cli'),'--port','0','--mint-from','101',...more],{encoding:'utf8',timeout:20000});
  for(const empty of [['--minters',''],['--minters']]){const r=run(...empty);assert.notEqual(r.status,0);assert.match(r.stderr,/Bad minter list/);}
  // An option this program does not know, a misspelt one, one written with "=", or one given twice stops the start: an
  // ignored --open-from would be another ledger than the one meant.
  for(const [bad,why] of [[['--open-form','200'],/There is no option --open-form/],[['--openfrom','200'],/There is no option --openfrom/],[['--Open-From=200'],/with a space/],[['--open_from=200'],/with a space/],[['-open-from','200'],/There is no option -open-from/],
   [['--open-from','200','--open-from','300'],/--open-from is given twice/],[['--open-from'],/the opening block is a whole number/],[['--open-from','2e2'],/whole number/],[['--minters',w.alice.address,'--open-from','101'],/opening block/]]){
   const r=run(...bad);assert.notEqual(r.status,0,bad.join(' '));assert.match(r.stderr,why,bad.join(' '));}
  // A folder made with a list has a schema name of its own (code from before the list would refuse it, not read it without the list).
  assert.equal(JSON.parse(readFileSync(join(x.dir,'state','meta.json'),'utf8')).schema,SCHEMA_MINTERS);
  const plain=world();await plain.reader.sync();assert.equal(JSON.parse(readFileSync(join(plain.dir,'state','meta.json'),'utf8')).schema,SCHEMA);
 }finally{await x.service.close();}});

test('a checkpoint names the first mint block and the minters from that block on, not before',async()=>{
 const x=world({mintFrom:104,minters:['alice']}),{reader,block}=x;await reader.sync();
 for(let i=0;i<6;i++)await block();
 const web=await served(x);
 try{
  const info=(await web.get('/info')).body,checkpoints=(await web.get('/checkpoints')).body.checkpoints,entries=[];
  assert.deepEqual(checkpoints.map(c=>[c.height,c.mintFrom??null,c.minters?1:0]),[[102,null,0],[104,104,1],[106,104,1]]);
  assert.equal((await verify({info,entries,checkpoints,owners:x.owners})).ok,true);
  // A checkpoint from before the block that names a setup, or one after it that names none, is not this ledger's.
  for(const wrong of [checkpoints.map(c=>c.height===102?{...c,mintFrom:104}:c),checkpoints.map(c=>{const {mintFrom,minters,...rest}=c;return rest;})])
   assert.match((await verify({info,entries,checkpoints:wrong,owners:x.owners})).problems.join(' '),/another first mint block, minter list or opening block/);
 }finally{await x.service.close();}});

test('a sent record marked stuck goes out again as the same transaction, once; one that reaches a block later ends as done',async()=>{
 const x=world({limits:{stuckBlocks:2,resendMs:10**12}}),{relay,carrier,chain,service,w}=x;await x.reader.sync();
 const m=x.mint(w.alice,'in the pool for long'),first=await relay.submit(hex(m.record));assert.equal(first.state,'sent');
 // Blocks pass without the transaction (the node keeps it in its pool): the job is marked stuck.
 for(let i=0;i<4;i++){chain.mine([],{only:[]});await service.step();}
 assert.equal(relay.status(m.id).state,'stuck');assert.equal(carrier.made.length,1);
 // Anyone hands the record over again (its bytes are public): no second transaction is built, the first one is sent again.
 const again=await relay.submit(hex(m.record));assert.equal(again.state,'sent');assert.equal(again.txid,first.txid);assert.equal(carrier.made.length,1);
 chain.mine();await service.step();
 assert.equal(x.L().nft(m.id).owner,w.alice.address);assert.deepEqual(x.reader.journal.filter(e=>e.id===m.id).map(e=>e.ok),[true]);assert.equal(relay.status(m.id).state,'done');
 // A stuck job nobody hands over again, whose transaction is mined after all, is done on disk too.
 const n=x.mint(w.bob,'mined late'),sent=await relay.submit(hex(n.record));
 for(let i=0;i<4;i++){chain.mine([],{only:[]});await service.step();}
 const file=join(x.dir,'relay','jobs',n.id+'.json'),saved=()=>JSON.parse(readFileSync(file,'utf8')).state;assert.equal(saved(),'stuck');
 chain.mine([],{only:[sent.txid]});await service.step();assert.equal(saved(),'done');});

test('the lane has its own coins and counts: other records cannot take them, it does not take the purchases\' coins, and it does not use up others\' limits',async()=>{
 // Two coins are kept for purchases and two above them for the lane.
 const x=world({coins:4,limits:{buyReserve:2,laneReserve:2,minReady:0,perDay:2,perCallerDay:2},lane:['alice'],holders:['alice','bob','carol']}),{relay,carrier,w}=x;await x.reader.sync();
 // The relay's wallet cannot split a coin in this test, so the counts stay put; that it tries is checked below.
 let splits=0;carrier.split=async()=>{splits++;throw Error('no split in this test');};await x.service.step();
 const send=async(r,o)=>{try{const a=await relay.submit(hex(r.record),o);return a.state+(a.note?': '+a.note:'');}catch(e){return e.status;}},waits='queued: Waiting for a coin of the relay; purchases go first.';
 assert.equal(await send({record:x.claim(1,w.bob)}),waits);
 assert.equal(await send(x.mint(w.alice,'launch 1'),{caller:'local'}),'sent');assert.equal(await send(x.mint(w.alice,'launch 2'),{caller:'local'}),'sent');
 // The lane stops at the purchases' coins.
 assert.equal(await send(x.mint(w.alice,'launch 3'),{caller:'local'}),waits);assert.equal(carrier.ready,2);
 // Lane records count neither toward the day's limit of everyone nor toward their connection's: others still get a place.
 assert.equal(await send({record:x.claim(2,w.carol)},{caller:'local'}),waits);
 // With coins this low the relay keeps trying to split one, so nothing waits on a count that never changes
 // (its own setting asked for no ready coins at all: the kept coins decide).
 assert.ok(splits>=1);const before=splits;await x.block();assert.ok(splits>before);
 // A relay without a lane keeps nothing back for one: the live relay's behaviour is unchanged.
 const y=world({coins:3,limits:{buyReserve:2,laneReserve:2,minReady:0}});await y.reader.sync();await y.service.step();
 const got=await y.relay.submit(hex(y.mint(y.w.bob,'no lane here').record));assert.equal(got.state,'sent');
 // (A relay without a lane takes everyone's mints, as before; this one waits for a coin.)
 assert.equal((await y.relay.submit(hex(y.mint(y.w.carol,'anyone').record))).state,'queued');});

test('the content route always varies by origin, so a cached copy cannot fail an allowed page',async()=>{
 const x=world({origins:['https://xmr20.org']});await x.reader.sync();const note=x.mint(x.w.bob,'a note');await x.block(note.record);
 const web=await served(x);
 try{for(const origin of [undefined,'https://xmr20.org','https://elsewhere.example'])assert.equal((await web.get('/nft/'+note.id+'/content',origin?{origin}:{})).headers.get('vary'),'origin',String(origin));}
 finally{await x.service.close();}});

// ---- Found by the outside review ----

test('the relay lists a signer\'s collection and mint records in any state, also a stuck one, and no other kind of record',async()=>{
 const x=world({coins:0,limits:{stuckBlocks:2,minReady:0}});await x.reader.sync();const {relay,w,block}=x,web=await served(x);
 try{
  const m=x.mint(w.alice,'waits'),other=x.mint(w.bob,'another signer');await relay.submit(hex(m.record));await relay.submit(hex(other.record));
  const records=async who=>(await web.get('/address/'+who.address+'/records')).body.records;
  assert.deepEqual(await records(w.alice),[{id:m.id,state:'queued',op:8,record:hex(m.record)}]);
  for(let i=0;i<4;i++)await block();
  assert.deepEqual((await records(w.alice)).map(r=>r.state),['stuck']);
  // (The pages' "waiting for a block" list is as before: a stuck record is not in it, so its owner is offered to act again.)
  assert.deepEqual((await web.get('/address/'+w.alice.address)).body.waiting,[]);
  // A move waiting at the relay is not in the list: only collections and mints are.
  await block(x.claim(0,w.alice));x.carrier.ready=0;const move=x.signed(x.L().prepareMove({mordinal:0,from:w.alice.address,to:w.bob.address}),w.alice);await relay.submit(hex(move));
  assert.deepEqual((await records(w.alice)).map(r=>r.op),[8]);assert.deepEqual(await records(w.carol),[]);
  assert.equal((await web.get('/address/not-an-address/records')).status,400);
 }finally{await x.service.close();}});

// ---- Opening minting to everyone from a block ----

test('a listed ledger can open minting at a block: before it only the list mints, from it anyone; the setup says so',()=>{
 const w={alice:wallet('alice'),bob:wallet('bob'),fee:wallet('fee')},owners=[];
 const make=o=>createLedger({domain:DOMAIN,feeAddress:w.fee.address,owners,height:100,mintFrom:100,...o});
 const L=make({minters:[w.alice.address],openFrom:105}),mint=(who,text)=>{const p=L.prepareMint({creator:who.address,type:TEXT,content:Buffer.from(text)});return L.sign(p.bodyBytes,who.sign(p.text));};
 L.setHeight(104);assert.throws(()=>L.apply(mint(w.bob,'too early')),/only the listed addresses make collections and mint\.$/);L.apply(mint(w.alice,'listed'));
 L.setHeight(105);L.apply(mint(w.bob,'open now'));L.apply(L.sign(L.prepareCollection({creator:w.bob.address,name:'mine',max:2}).bodyBytes,w.bob.sign(L.prepareCollection({creator:w.bob.address,name:'mine',max:2}).text)));
 // An opening needs a list and a first mint block before it.
 for(const o of [{openFrom:105},{minters:[w.alice.address],openFrom:100},{minters:[w.alice.address],openFrom:99},{minters:[w.alice.address],openFrom:'105'},{minters:[w.alice.address],openFrom:105,mintFrom:null}])
  assert.throws(()=>make(o),/opening block/,JSON.stringify(o));});

test('a reader folder of the listed ledger takes an opening in while it has not read that block; checkpoints name it from then on',async()=>{
 const x=world({minters:['alice'],mintFrom:101}),{reader,block,w}=x;await reader.sync();for(let i=0;i<3;i++)await block();
 assert.equal(reader.height,103);
 // Opened at block 106: the folder takes it in (and is marked so that code from before the opening refuses it).
 const again=openReader({dir:join(x.dir,'state'),...x.setup,mintFrom:101,minters:x.pick(['alice']),openFrom:106});
 const meta=()=>JSON.parse(readFileSync(join(x.dir,'state','meta.json'),'utf8'));
 assert.deepEqual([meta().schema,meta().openFrom],[SCHEMA_OPEN,106]);
 assert.throws(()=>openReader({dir:join(x.dir,'state'),...x.setup,mintFrom:101,minters:x.pick(['alice'])}),/another ledger \(schema differs\)/);
 assert.throws(()=>openReader({dir:join(x.dir,'state'),...x.setup,mintFrom:101,minters:x.pick(['alice']),openFrom:107}),/another ledger \(openFrom differs\)/);
 // Bob's mint is refused before the opening block and counts from it on.
 const early=x.mint(w.bob,'early');x.chain.mine([carried(early.record)]);x.chain.mine();await again.sync();
 const late=x.mint(w.bob,'late');x.chain.mine([carried(late.record)]);await again.sync();for(let i=0;i<4;i++){x.chain.mine();await again.sync();}
 assert.deepEqual([again.entryByTx(again.journal.find(e=>e.id===early.id)?.txid)?.ok,again.ledger.nft(late.id)?.owner],[false,w.bob.address]);
 assert.deepEqual(again.checkpoints.map(c=>[c.height,c.openFrom??null]),[[102,null],[104,null],[106,106],[108,106],[110,106]]);
 // A reader made with the opening from the start reaches the same checkpoints; one that has read past the block does
 // not take an opening in.
 const freshDir=mkdtempSync(join(tmpdir(),'mint-open-'));dirs.push(freshDir);const fresh=openReader({dir:freshDir,...x.setup,mintFrom:101,minters:x.pick(['alice']),openFrom:106});await fresh.sync();
 assert.deepEqual(fresh.checkpoints,again.checkpoints);
 const past=world({minters:['alice'],mintFrom:101});await past.reader.sync();for(let i=0;i<6;i++)await past.block();
 assert.throws(()=>openReader({dir:join(past.dir,'state'),...past.setup,mintFrom:101,minters:past.pick(['alice']),openFrom:105}),/another ledger \(schema differs\)/);
 // The check tool knows the opening: a checkpoint that names none after it, or one before it, is not this ledger's.
 const svc=createService({reader:again,owners:x.owners}),web=await served({service:svc});
 try{
  const {info,entries,checkpoints}=await download(web.base);
  assert.equal(info.openFrom,106);const ok=await verify({info,entries,checkpoints,owners:x.owners});assert.equal(ok.ok,true,ok.problems?.join(' '));
  for(const wrong of [checkpoints.map(c=>c.height===104?{...c,openFrom:106}:c),checkpoints.map(c=>{const {openFrom,...rest}=c;return rest;})])
   assert.match((await verify({info,entries,checkpoints:wrong,owners:x.owners})).problems.join(' '),/opening block/);
  // Without the opening the same log does not replay: bob's late mint is not this ledger's.
  const {openFrom,...closed}=info;assert.equal((await verify({info:closed,entries,checkpoints:checkpoints.map(c=>{const {openFrom,...rest}=c;return rest;}),owners:x.owners})).ok,false);
 }finally{await svc.close();}});

// Paid minting on a relay with a lane: the listed minters go free, everyone else's collections and mints are carried for
// the relay's fee, and nothing of theirs goes out before it is paid.
const FEE=500000000n;
async function payFee(x,view,amount=FEE){const index=Number(view.pay.address.split(' ').at(-1)),t=makeTx('fee for '+view.id+' '+amount,[{to:x.w.fee,amount}]);
 x.chain.mine([{txid:t.txid,tx:t.tx}]);x.carrier.paid({index,amount,txid:t.txid});}
test('a relay with a lane and a fee: the listed minters go free, everyone else pays first, and nothing unpaid goes out',async()=>{
 const x=world({lane:['alice'],fees:{mint:FEE,collection:FEE},holders:['alice','bob','carol']});await x.reader.sync();const {relay,w,carrier}=x;
 const sent=()=>carrier.made.length,before=sent();
 // The listed minter: no fee, no payment address, out at once.
 const own=x.mint(w.alice,'launch'),o=await relay.submit(hex(own.record));
 assert.equal(o.pay,undefined);assert.match(o.state,/queued|sent/);assert.equal(sent(),before+1);
 // Everyone else: a mint and a collection wait unpaid at their own addresses for exactly the fee.
 const m=x.mint(w.bob,'paid mint'),mv=await relay.submit(hex(m.record));
 const c=x.signed(x.L().prepareCollection({creator:w.carol.address,name:'Carol set',max:2}),w.carol),cv=await relay.submit(hex(c));
 for(const v of [mv,cv]){assert.equal(v.state,'unpaid');assert.equal(v.pay.amount,FEE.toString());}
 assert.notEqual(mv.pay.address,cv.pay.address);assert.equal(sent(),before+1,'nothing of theirs went out');
 // The regular pass keeps them (they were taken for the fee), and still sends nothing unpaid.
 await x.service.step();await x.service.step();
 assert.deepEqual([relay.status(mv.id).state,relay.status(cv.id).state],['unpaid','unpaid']);assert.equal(sent(),before+1);
 // Too little is not enough.
 await payFee(x,mv,FEE-1n);await x.service.step();assert.equal(relay.status(mv.id).state,'unpaid');assert.equal(sent(),before+1);
 // Paid in full: it goes out and counts; the other one still waits.
 await payFee(x,mv,1n);await x.service.step();assert.match(relay.status(mv.id).state,/sent|done/);assert.equal(sent(),before+2);
 assert.equal(relay.status(cv.id).state,'unpaid');
 await x.block();x.chain.mine([]);await x.service.step();
 assert.equal(relay.status(mv.id).state,'done');assert.equal(x.L().nft(mv.id).owner,w.bob.address);});

test('a relay with a lane charging only for mints still refuses everyone else\'s collections, and its minters\' are free',async()=>{
 const x=world({lane:['alice'],fees:{mint:FEE},holders:['alice','bob']});await x.reader.sync();const {relay,w}=x;
 const send=async r=>{try{return await relay.submit(hex(r));}catch(e){return e.status;}};
 assert.equal(await send(x.signed(x.L().prepareCollection({creator:w.bob.address,name:'Bob set',max:2}),w.bob)),403);
 assert.equal((await send(x.mint(w.bob,'paid').record)).state,'unpaid');
 const own=await send(x.signed(x.L().prepareCollection({creator:w.alice.address,name:'Launch set',max:2}),w.alice));assert.equal(own.pay,undefined);assert.notEqual(own.state,'unpaid');});

test('a record taken for the fee is still carried once paid when the relay restarts without a fee; a free one left over is not',async()=>{
 const x=world({lane:['alice'],fees:{mint:FEE},holders:['alice','bob','carol']});await x.reader.sync();const {w,carrier}=x;
 const m=x.mint(w.bob,'taken for the fee'),v=await x.relay.submit(hex(m.record));assert.equal(v.state,'unpaid');
 // A free job of someone outside the lane, left from before the lane rule.
 const left=x.mint(w.carol,'left over');writeFileSync(join(x.dir,'relay','jobs',left.id+'.json'),JSON.stringify({id:left.id,record:hex(left.record),op:8,number:null,signer:w.carol.address,caller:null,state:'queued',createdAt:1,createdHeight:100}));
 const again=createRelay({dir:join(x.dir,'relay'),reader:x.reader,chain:x.chain,carrier,domain:DOMAIN,lane:[w.alice.address]}),before=carrier.made.length;
 await again.tick();assert.deepEqual([again.status(m.id).state,again.status(left.id).state],['unpaid','refused']);assert.equal(carrier.made.length,before);
 await payFee(x,v);await again.tick();assert.match(again.status(m.id).state,/sent|done/);assert.equal(carrier.made.length,before+1);});

