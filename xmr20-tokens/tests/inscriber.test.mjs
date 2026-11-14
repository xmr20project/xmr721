// Offline tests of the launch inscriber (inscriber/): made-up launch lists in the shapes the public lists have, a
// made-up node and relay wallet, the real reader, relay and service. Nothing here is a real chain, key or token.
//   node --test xmr20-tokens/tests/inscriber.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,existsSync,statSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {wallet,makeTx,ownerEntry,DOMAIN} from '../../rules/tests/helpers.mjs';
import {decodeRecord,OP,NO_COLLECTION} from '../../rules/lib/records.mjs';
import {unhex,verifySpendSignature} from '../../rules/lib/monero.mjs';
import {openReader} from '../../reader/lib/reader.mjs';
import {createRelay} from '../../reader/lib/relay.mjs';
import {createService} from '../../reader/service.mjs';
import {fakeChain,fakeCarrier} from '../../reader/tests/fake.mjs';
import {newSecret,inscriberFrom,deployRecord} from '../lib/inscribe.mjs';
import {deployText,readDeploy,TYPE_JSON} from '../lib/token.mjs';
import {createInscriber,httpIndex,preview} from '../inscriber/inscriber.mjs';
import {tradeSource,bridgeSource} from '../inscriber/sources.mjs';

const dirs=[];test.after(()=>{for(const d of dirs)rmSync(d,{recursive:true,force:true});});
const SINCE=1_800_000_000_000,NOW=()=>SINCE+3_600_000,B58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
// A Solana-shaped address for a label (32 bytes, base58).
const mintOf=label=>{let n=0n;for(const b of Buffer.concat([Buffer.from(label.padEnd(8,'.')),Buffer.alloc(24,7)]))n=n*256n+BigInt(b);let s='';while(n){s=B58[Number(n%58n)]+s;n/=58n;}return s;};

// The two public lists, as the services give them (only the fields that exist there; a creator and a wallet kind are
// among them on purpose: the inscriber must not carry them over).
const curveLaunch=(symbol,at,o={})=>({mint:mintOf(symbol),name:symbol.toLowerCase(),symbol,creator:null,creatorWallet:'monero',launchedAt:at,phase:'curve',venue:'curve',price:1e-11,supply:'1000000000000000',progress:0,trades:0,...o});
const bridgeLaunch=(ticker,at,o={})=>({id:'00000000-0000-4000-8000-'+Buffer.from(ticker.padEnd(6,'x')).toString('hex').slice(0,12),ticker,name:ticker+' coin',description:'made up',image:'https://api.xmr20.org/mainnet/i/x',mint:mintOf(ticker),
 owner:mintOf('creator'),network:'mainnet-beta',createdAt:at,state:'Launched',publicIndex:200,solanaFinalized:true,hidden:false,supply:'1000000000000000',launchMode:'normal',launchPlatform:2,...o});
function lists(){
 const curve=[],bridge=[],markets=[];let down=null;
 const get=async url=>{if(down&&url.includes(down))throw Error('host answered 502');
  if(url==='https://trade.test/api/launches')return {launches:curve.slice().reverse()};if(url==='https://trade.test/api/markets')return curve.filter(c=>c?.mint).map(c=>markets.find(m=>m.mint===c.mint)||{mint:c.mint,symbol:c.symbol,phase:c.phase}).concat(markets.filter(m=>!curve.some(c=>c?.mint===m.mint)));
  if(url==='https://site.test/api/xmr20/tokens')return {schema:'xmr20-launches-v1',moneroNetwork:'mainnet',solanaNetwork:'mainnet-beta',confirmations:10,tokens:bridge.slice()};
  throw Error('unexpected '+url);};
 return {curve,bridge,markets,get,down:v=>{down=v;},sources:()=>[tradeSource({base:'https://trade.test',get,now:NOW}),bridgeSource({url:'https://site.test/api/xmr20/tokens',get,now:NOW})]};}

async function world({fees,inscribers,minters=null,mintFrom=100,coins=30,relayOn=true}={}){
 const w=Object.fromEntries(['holder','fee'].map(n=>[n,wallet(n)])),key=newSecret(),signer=inscriberFrom(key);
 const owners=[makeTx('reg0',[{to:w.holder,amount:10n**9n}])].map((t,i)=>({...ownerEntry(i,t),registrationHeight:50,ownerHeight:50}));
 const dir=mkdtempSync(join(tmpdir(),'xmr20-inscriber-'));dirs.push(dir);
 const chain=fakeChain({start:100}),reader=openReader({dir:join(dir,'state'),chain,domain:DOMAIN,feeAddress:w.fee.address,owners,start:100,mintFrom,minters:minters?minters(signer.address):null});
 const carrier=fakeCarrier(chain,{coins}),relay=relayOn?createRelay({dir:join(dir,'relay'),reader,chain,carrier,domain:DOMAIN,limits:{resendMs:1000},...(fees?{fees}:{})}):null;
 const service=createService({reader,relay,owners,xmr20:{inscribers:inscribers||[signer.address]},testHooks:true}),port=await service.listen(0),base='http://127.0.0.1:'+port;
 await service.step();
 const l=lists(),logs=[],index=httpIndex(base);
 const open=(o={})=>createInscriber({dir:join(dir,'inscriber'),sources:l.sources(),index,inscriber:signer,domain:DOMAIN,since:SINCE,now:NOW,log:v=>logs.push(v),...o,limits:{quiet:0,...o.limits}});
 const block=async()=>{chain.mine();await service.step();},tokens=async()=>(await (await fetch(base+'/xmr20/tokens')).json()).items;
 return {w,dir,chain,reader,relay,carrier,service,base,index,signer,key,logs,open,block,tokens,...l};}

test('every new launch on both lists is inscribed once and listed; older launches and unfinished ones are not',async()=>{
 const x=await world(),{curve,bridge,open,block,tokens,signer,reader}=x;
 try{
  curve.push(curveLaunch('OLD',SINCE-1),curveLaunch('TEST2',SINCE+10,{creatorWallet:'private',private:true,figures:{holders:1}}));
  bridge.push(bridgeLaunch('EARLY',SINCE-5),bridgeLaunch('ALPHA',SINCE+20),bridgeLaunch('BETA',SINCE+30,{venue:'meteora-damm-v2'}),bridgeLaunch('GAMMA',SINCE+35,{venue:'raydium-launchlab',flow:'wxmr-sponsored-curve-v1'}),
   bridgeLaunch('WAIT',SINCE+40,{solanaFinalized:false,state:'Reserved'}),bridgeLaunch('HID',SINCE+50,{hidden:true}),bridgeLaunch('GONE',SINCE+55,{cancelledAt:SINCE+56}));
  const a=open();
  // Four are new; the relay takes three records of one address at a time.
  assert.deepEqual(await a.turn(),{height:100,found:4,sent:3,done:0,counts:{sent:3,made:1}});
  await block();                                                                                  // 101
  assert.deepEqual(await a.turn(),{height:101,found:0,sent:1,done:3,counts:{done:3,sent:1}});
  await block();                                                                                  // 102
  assert.deepEqual(await a.turn(),{height:102,found:0,sent:0,done:1,counts:{done:4}});
  const listed=(await tokens()).reverse();
  assert.deepEqual(listed.map(t=>[t.number,t.tick,t.name,t.max,t.dec,t.mode,t.pair??null,t.mint]),[
   [1,'TEST2','test2','1000000000','6','monero-curve',null,mintOf('TEST2')],
   [2,'ALPHA','ALPHA coin','1000000000','6','bonding-curve','wXMR',mintOf('ALPHA')],
   [3,'BETA','BETA coin','1000000000','6','bonding-curve','XMR20',mintOf('BETA')],
   [4,'GAMMA','GAMMA coin','1000000000','6','bonding-curve','wXMR',mintOf('GAMMA')]]);
  assert.ok(listed.every(t=>t.inscriber===signer.address&&t.owner===signer.address));
  // What is on the chain for the private launch: the token's fields and nothing of its maker.
  const record=decodeRecord(unhex(reader.entryById(listed[0].id).record),'mainnet'),text=Buffer.from(record.body.content).toString('utf8');
  assert.deepEqual([record.op,record.body.collection,record.body.type,record.body.name,record.body.creator,record.body.to??null],[OP.mint,NO_COLLECTION,TYPE_JSON,'TEST2',signer.address,null]);
  assert.equal(text,deployText({tick:'TEST2',name:'test2',max:'1000000000',dec:'6',mode:'monero-curve',mint:mintOf('TEST2')}));
  assert.ok(!/private|creator|wallet|monero"|figures/.test(text.replace('monero-curve','')));
  // Nothing more to do; then the unfinished launch is finalized and gets its inscription.
  assert.deepEqual(await a.turn(),{height:102,found:0,sent:0,done:0,counts:{done:4}});
  bridge.find(t=>t.ticker==='WAIT').solanaFinalized=true;
  assert.deepEqual(await a.turn(),{height:102,found:1,sent:1,done:0,counts:{done:4,sent:1}});
  await block();await a.turn();assert.deepEqual((await tokens()).map(t=>t.tick),['WAIT','GAMMA','BETA','ALPHA','TEST2']);
  // The journal: one entry per launch, kept in a file only its owner reads; it holds no key.
  const file=join(x.dir,'inscriber','journal.json'),saved=readFileSync(file,'utf8');
  assert.equal(statSync(file).mode&0o777,0o600);assert.ok(!saved.includes(x.key));
  assert.deepEqual(Object.values(JSON.parse(saved).launches).map(e=>e.state),Array(5).fill('done'));
 }finally{await x.service.close();}});

test('a stop at any point is picked up, and a lost journal inscribes nothing twice',async()=>{
 const x=await world(),{curve,open,block,tokens,index,reader}=x;
 try{
  curve.push(curveLaunch('ONE',SINCE+1),curveLaunch('TWO',SINCE+2));
  // The relay cannot be reached when the records are handed over: they are made and kept, not sent.
  const broken={...index,submit:async()=>{throw Error('connection lost');}},a=open({index:broken});
  // (A hand-over that fails outright is taken as a relay that may answer later; the pass goes on.)
  assert.deepEqual((await a.turn()).counts,{made:2});assert.match(a.entries()[0].note,/connection lost/);
  const kept=Object.values(JSON.parse(readFileSync(join(x.dir,'inscriber','journal.json'),'utf8')).launches);
  assert.deepEqual(kept.map(e=>[e.fields.tick,e.state]),[['ONE','made'],['TWO','made']]);
  // A new process: the same records (the same ids) go out.
  const b=open();assert.deepEqual(await b.turn(),{height:100,found:0,sent:2,done:0,counts:{sent:2}});
  assert.deepEqual(b.entries().map(e=>e.id),kept.map(e=>e.id));
  // Stopped again before it saw them in a block; the next process finds them there.
  await block();
  const c=open();assert.deepEqual(await c.turn(),{height:101,found:0,sent:0,done:2,counts:{done:2}});
  // The journal is lost. A new one finds both tokens on the index and sends nothing.
  rmSync(join(x.dir,'inscriber'),{recursive:true});const before=reader.journal.length,jobs=x.relay.pending().length;
  const d=open();assert.deepEqual(await d.turn(),{height:101,found:0,sent:0,done:2,counts:{done:2}});
  await block();await d.turn();assert.equal(reader.journal.length,before);assert.equal(x.relay.pending().length,jobs);
  assert.deepEqual((await tokens()).map(t=>[t.number,t.tick]),[[2,'TWO'],[1,'ONE']]);
  // The same record handed over again by hand changes nothing either: one id, one token.
  assert.equal((await index.submit(d.entries()[0].record)).state,'done');
 }finally{await x.service.close();}});

test('a replaced block: the inscription goes out again and the token comes back with the same id',async()=>{
 const x=await world(),{curve,open,block,tokens,chain,service}=x;
 try{
  curve.push(curveLaunch('REORG',SINCE+1));const a=open();await a.turn();await block();await a.turn();
  const [was]=await tokens();assert.equal(a.entries()[0].state,'done');
  chain.pop(1);chain.mine();await service.step();                       // the block is replaced by an empty one
  assert.deepEqual(await tokens(),[]);
  await a.turn();assert.equal(a.entries()[0].state,'sent');assert.ok(x.logs.some(l=>l.replaced===mintOf('REORG')));
  for(let i=0;i<3&&!(await tokens()).length;i++){await a.turn();await block();}
  await a.turn();const [now]=await tokens();
  assert.deepEqual([now.id,now.tick,a.entries()[0].state],[was.id,'REORG','done']);
 }finally{await x.service.close();}});

test('it waits while the index would not list its tokens, minting is closed or there is no relay; another ledger is refused',async()=>{
 const other=inscriberFrom(newSecret()).address;
 for(const [setup,why] of [[{inscribers:[other]},/does not list the tokens of this inscriber/],[{mintFrom:200},/minting is not open/],[{relayOn:false},/no relay/],[{minters:()=>[other]},/not among the ledger's minters/]]){
  const x=await world(setup);
  try{x.curve.push(curveLaunch('WAITS',SINCE+1));const a=x.open(),out=await a.turn();
   assert.match(out.waiting,why);assert.deepEqual([out.found,out.sent,a.entries().length],[0,0,0]);assert.ok(!existsSync(join(x.dir,'inscriber','journal.json')));}
  finally{await x.service.close();}}
 const x=await world();
 try{await assert.rejects(x.open({domain:'ab'.repeat(32)}).turn(),/another ledger/);
  assert.throws(()=>x.open({since:0}),/time from which/);assert.throws(()=>x.open({since:1_800_000_000}),/in milliseconds/);
  // A journal belongs to one inscriber and one ledger.
  x.curve.push(curveLaunch('MINE',SINCE+1));await x.open().turn();
  assert.throws(()=>x.open({inscriber:inscriberFrom(newSecret())}),/another inscriber or ledger/);
 }finally{await x.service.close();}});

test('a relay that asks a fee is not paid: the record waits, and goes out once the relay carries it',async()=>{
 const x=await world({fees:{mint:500000000n}});
 try{x.curve.push(curveLaunch('FEE',SINCE+1));const a=x.open();
  assert.deepEqual(await a.turn(),{height:100,found:1,sent:0,done:0,counts:{made:1}});
  assert.match(a.entries()[0].note,/asks a fee/);assert.ok(x.logs.some(l=>l.unpaid===mintOf('FEE')));
  await x.block();assert.deepEqual(await x.tokens(),[]);assert.equal(x.carrier.made.length,0);
 }finally{await x.service.close();}});

test('the lists: what cannot be described fully is left out with the reason, and a list that fails does not stop the other',async()=>{
 const x=await world(),{curve,bridge,open}=x;
 try{
  curve.push(curveLaunch('GOOD',SINCE+1),curveLaunch('BADMINT',SINCE+2,{mint:'not-an-address'}),curveLaunch('NOTIME',SINCE+3,{launchedAt:null}),{symbol:'NOMINT',name:'x',launchedAt:SINCE+4});
  bridge.push(bridgeLaunch('ODD',SINCE+5,{supply:'1000000000000001'}),bridgeLaunch('FINE',SINCE+6),bridgeLaunch('DEV',SINCE+7,{network:'devnet'}),{...bridgeLaunch('GOOD2',SINCE+8),mint:mintOf('GOOD')});
  const [t,b]=x.sources(),tl=await t.list(),bl=await b.list();
  assert.deepEqual(tl.launches.map(l=>l.fields.tick),['GOOD']);
  assert.deepEqual(tl.skipped,[{mint:null,why:'its market is not shown in the same phase; next pass',at:SINCE+4},{mint:mintOf('NOTIME'),why:'no launch time',at:null},{mint:'not-an-address',why:'mint: a Solana address.',at:SINCE+2}]);
  assert.deepEqual(bl.launches.map(l=>l.fields.tick),['FINE','GOOD2']);assert.deepEqual(bl.skipped,[{mint:mintOf('ODD'),why:'no whole supply',at:SINCE+5}]);
  // The same mint on both lists is inscribed once, for the list that is read first.
  const a=open();assert.deepEqual(await a.turn(),{height:100,found:2,sent:2,done:0,counts:{sent:2}});
  assert.deepEqual(a.entries().map(e=>[e.fields.tick,e.source]),[['GOOD','monero-curve'],['FINE','bonding-curve']]);
  // One list is down: the other is still read.
  curve.push(curveLaunch('LATER',SINCE+9));bridge.push(bridgeLaunch('MORE',SINCE+10));x.down('trade.test');
  await x.block();const out=await a.turn();assert.equal(out.found,1);assert.ok(x.logs.some(l=>l.source==='monero-curve'&&/502/.test(l.error)));
  x.down(null);assert.equal((await a.turn()).found,1);
 }finally{await x.service.close();}});

test('an inscriber key: a Monero spend key, with the address a wallet would show; its records verify',()=>{
 const key=newSecret(),a=inscriberFrom(key),again=inscriberFrom(key);
 assert.match(key,/^[0-9a-f]{64}$/);assert.equal(a.address,again.address);assert.match(a.address,/^4[1-9A-HJ-NP-Za-km-z]{94}$/);
 assert.notEqual(inscriberFrom(newSecret()).address,a.address);
 for(const bad of ['','00'.repeat(32),'ff'.repeat(32),'zz'.repeat(32),key.slice(2)])assert.throws(()=>inscriberFrom(bad),/key/);
 const fields={tick:'KEY',max:'21000000',dec:'8',mode:'monero-curve',mint:mintOf('KEY')},one=deployRecord({fields,inscriber:a,domain:DOMAIN}),two=deployRecord({fields,inscriber:a,domain:DOMAIN});
 assert.equal(one.id,two.id);assert.notEqual(one.record,two.record);                // one id; a signature is made anew each time
 const d=decodeRecord(unhex(one.record),'mainnet');
 assert.deepEqual(readDeploy(d.body.content),{p:'xmr20',op:'deploy',...fields});
 assert.match(one.text,/^XMR721 mint: one NFT in no collection named "KEY"; \d+ bytes of type 6, SHA-256 [0-9a-f]{64}; first owner 4/);
 assert.equal(d.proof.variant,0);assert.ok(verifySpendSignature(one.text,a.address,{c:d.proof.c,r:d.proof.r}));
 // A ticker in another script has no record name; the text carries it.
 assert.equal(decodeRecord(unhex(deployRecord({fields:{...fields,tick:'門羅'},inscriber:a,domain:DOMAIN}).record),'mainnet').body.name,'');});

// ---- Found by review before the first mint block (each fails on the code before its fix) ----

test('a name that cannot be written is left out and the launch is still inscribed; spaces at its ends are dropped',async()=>{
 const x=await world(),{curve,open,block,tokens}=x,cp=String.fromCodePoint;
 try{
  curve.push(curveLaunch('FAM',SINCE+1,{name:cp(0x1f468,0x200d,0x1f469,0x200d,0x1f467)}),curveLaunch('FA',SINCE+2,{name:cp(0x645,0x6cc,0x200c,0x62e)}),curveLaunch('SPACE',SINCE+3,{name:' padded '}),
   curveLaunch('PRIDE',SINCE+4,{name:cp(0x1f3f3,0xfe0f,0x200d,0x1f308)}),curveLaunch('OK',SINCE+5,{name:'plain'}),curveLaunch('NONAME',SINCE+6,{name:undefined}));
  const a=open();for(let i=0;i<4;i++){await a.turn();await block();}await a.turn();
  assert.deepEqual((await tokens()).reverse().map(t=>[t.tick,t.name??null]),[['FAM',null],['FA',null],['SPACE','padded'],['PRIDE',null],['OK','plain'],['NONAME',null]]);
  assert.deepEqual(x.logs.filter(l=>l.skipped),[]);
 }finally{await x.service.close();}});

test('the supply inscribed is the launch\'s own: what is listed now plus what was burned when its pool opened',async()=>{
 const x=await world(),{curve,markets,open,block,tokens}=x;
 try{
  // A pool opened and burned tokens: the list shows less, the market says how much was burned.
  curve.push(curveLaunch('POOL',SINCE+1,{phase:'pool',supply:'999986016092513'}),curveLaunch('CURVE',SINCE+2),curveLaunch('SMALL',SINCE+3,{supply:'21000000000000'}),curveLaunch('ODDBURN',SINCE+4,{phase:'pool',supply:'999999999999999'}));
  markets.push({mint:mintOf('POOL'),symbol:'POOL',phase:'pool',graduated:{burnedTokens:'13983907487',keptTokens:'206900000000000'}},{mint:mintOf('CURVE'),phase:'curve'},{mint:mintOf('ODDBURN'),phase:'pool',graduated:{burnedTokens:7}});
  const a=open();for(let i=0;i<3;i++){await a.turn();await block();}await a.turn();
  assert.deepEqual((await tokens()).reverse().map(t=>[t.tick,t.max]),[['POOL','1000000000'],['CURVE','1000000000'],['SMALL','21000000']]);
  assert.ok(x.logs.some(l=>l.skipped===mintOf('ODDBURN')&&l.why==='no whole supply'));
 }finally{await x.service.close();}});

test('the bonding curve list: what the index page leaves out is not inscribed, and a venue the source does not know is left out, not guessed',async()=>{
 const x=await world(),{bridge}=x;
 try{
  bridge.push(bridgeLaunch('HALT',SINCE+1,{halted:true}),bridgeLaunch('EXCL',SINCE+2,{publicIndexExcluded:true}),bridgeLaunch('STAGE',SINCE+3,{moneroNetwork:'stagenet'}),
   bridgeLaunch('OLDP',SINCE+4,{launchPlatform:undefined}),bridgeLaunch('NEWV',SINCE+5,{venue:'something-new'}),bridgeLaunch('LAB',SINCE+6,{venue:'raydium-launchlab'}),bridgeLaunch('GOOD',SINCE+7));
  const listed=await x.sources()[1].list();
  assert.deepEqual(listed.launches.map(l=>[l.fields.tick,l.fields.pair]),[['GOOD','wXMR']]);
  assert.deepEqual(listed.skipped.map(s=>[s.mint,s.why,s.at]),[['OLDP',4],['NEWV',5],['LAB',6]].map(([n,i])=>[mintOf(n),'a launch venue this source does not know',SINCE+i]));
  // Left-out launches from before the start time are not noted (the old list is full of earlier venues).
  bridge.push(bridgeLaunch('ANCIENT',SINCE-100,{launchPlatform:undefined}));const a=x.open();await a.turn();
  assert.deepEqual(Object.keys(a.journal.skipped).sort(),['OLDP','NEWV','LAB'].map(mintOf).sort());
  // Another network at the top of the answer refuses the whole list.
  const stagenet=bridgeSource({url:'u',get:async()=>({schema:'xmr20-launches-v1',moneroNetwork:'stagenet',solanaNetwork:'mainnet-beta',tokens:[]})});await assert.rejects(stagenet.list(),/another network/);
 }finally{await x.service.close();}});

test('a list that suddenly shows many new launches is not taken from; a day has a bound; the other list goes on',async()=>{
 const x=await world(),{curve,bridge,open,block,tokens}=x;
 try{
  for(let i=0;i<30;i++)curve.push(curveLaunch('J'+i,SINCE+10+i));bridge.push(bridgeLaunch('REAL',SINCE+5));
  const a=open({limits:{burst:20,perDay:4,inFlight:3}});
  const first=await a.turn();assert.deepEqual([first.found,first.held,first.sent],[1,30,1]);
  assert.deepEqual(x.logs.filter(l=>l.held).map(l=>[l.held,l.launches,l.why]),[['monero-curve',30,'more than 20 new launches at once']]);
  await block();await a.turn();assert.deepEqual((await tokens()).map(t=>t.tick),['REAL']);assert.equal(x.logs.filter(l=>l.held).length,1);
  // A person lets them through (a higher limit): the day's bound still holds, oldest first.
  const b=open({limits:{burst:100,perDay:4,inFlight:10}}),next=await b.turn();assert.deepEqual([next.found,next.held],[3,27]);
  assert.deepEqual(b.entries().map(e=>e.fields.tick),['REAL','J0','J1','J2']);
  // A launch time far in the future and a list longer than a launch list can be are refused by the source.
  curve.length=0;curve.push(curveLaunch('FUTURE',NOW()+86_400_000));assert.deepEqual((await x.sources()[0].list()).skipped.map(s=>s.why),['a launch time in the future']);
  curve.length=0;for(let i=0;i<20001;i++)curve.push({});await assert.rejects(x.sources()[0].list(),/longer than a launch list/);
 }finally{await x.service.close();}});

test('records that will never be tokens do not hold the way: a burned inscription, a record the relay cannot mine, a record the rules refuse',async()=>{
 const x=await world(),{curve,open,block,tokens,index,reader,signer,service}=x;
 try{
  curve.push(curveLaunch('B1',SINCE+1),curveLaunch('B2',SINCE+2),curveLaunch('B3',SINCE+3));
  const a=open();await a.turn();await block();await a.turn();assert.deepEqual(a.counts(),{done:3});
  // The inscriber burns all three inscriptions (FORMAT.md's way to take a token back), and the journal is lost.
  const L=reader.ledger,key=inscriberFrom(x.key);
  for(const e of a.entries()){const p=L.prepareBurn({nft:e.id,owner:signer.address});assert.equal((await index.submit(Buffer.from(L.sign(p.bodyBytes,key.sign(p.text))).toString('hex'))).state,'sent');}
  await block();assert.deepEqual(await tokens(),[]);rmSync(join(x.dir,'inscriber'),{recursive:true});
  curve.push(curveLaunch('NEW',SINCE+4));
  // The new journal finds the three burned inscriptions on the ledger and leaves them withdrawn; they hold no place.
  const b=open({limits:{settle:3}});assert.deepEqual((await b.turn()).counts,{off:3,sent:1});
  for(let i=0;i<4;i++){await block();await b.turn();}await block();await b.turn();
  assert.deepEqual(b.entries().map(e=>[e.fields.tick,e.state]),[['B1','off'],['B2','off'],['B3','off'],['NEW','done']]);
  assert.deepEqual((await tokens()).map(t=>t.tick),['NEW']);
  // A record the relay keeps as stuck holds no in-flight place and is offered again every few blocks until the relay
  // takes it; a record the rules refuse is closed after three tries; a relay that is busy or failing closes nothing.
  curve.push(curveLaunch('STUCK',SINCE+5),curveLaunch('BAD',SINCE+6),curveLaunch('BUSY',SINCE+7));
  let relayTakesIt=false;const idOf=n=>c.journal.launches[mintOf(n)]?.id,of=record=>c.entries().find(e=>e.record===record)?.id;
  const odd={...index,status:async id=>id===idOf('STUCK')&&!relayTakesIt?{id,state:'stuck',error:null}:index.status(id),
   submit:async record=>{const id=of(record);
    if(id===idOf('BAD'))return {state:'refused',error:'A rule says no.',status:400,rule:true};
    if(id===idOf('BUSY'))return {state:'refused',error:'The wallet tool failed.',status:400,rule:false};
    if(id===idOf('STUCK')&&c.journal.launches[mintOf('STUCK')].state!=='made'&&!relayTakesIt)return {id,state:'stuck'};
    return index.submit(record);}};
  const c=open({index:odd,limits:{resendAfter:2}});await c.turn();
  for(let i=0;i<4;i++)await c.turn();
  assert.deepEqual(c.entries().slice(-3).map(e=>[e.fields.tick,e.state]),[['STUCK','stuck'],['BAD','refused'],['BUSY','made']]);
  assert.equal(c.entries().filter(e=>e.state==='sent').length,0);
  relayTakesIt=true;await block();await block();await c.turn();assert.ok(['sent','done'].includes(c.journal.launches[mintOf('STUCK')].state));
  await block();await c.turn();assert.deepEqual((await tokens()).map(t=>t.tick),['STUCK','NEW']);assert.equal(c.journal.launches[mintOf('STUCK')].state,'done');
 }finally{await service.close();}});

test('a new journal waits before its first record, so a record of an earlier run is found in its block and not made a second time',async()=>{
 const x=await world(),{curve,open,block,tokens,reader}=x;
 try{
  curve.push(curveLaunch('TWICE',SINCE+1,{name:'first name'}));const a=open();await a.turn();
  // The journal is lost while the record waits for its block, and the list now gives another name for the launch.
  rmSync(join(x.dir,'inscriber'),{recursive:true});curve[0].name='second name';
  const b=open({limits:{quiet:2}}),before=reader.journal.length;
  const one=await b.turn();assert.deepEqual([one.found,one.quiet],[0,102]);
  await block();assert.equal((await b.turn()).found,0);await block();
  const three=await b.turn();assert.deepEqual([three.found,three.sent,three.done],[0,0,1]);
  await block();await b.turn();
  assert.deepEqual((await tokens()).map(t=>[t.tick,t.name]),[['TWICE','first name']]);assert.equal(reader.journal.length,before+1);
  assert.equal(b.entries()[0].id,(await tokens())[0].id);assert.equal(b.entries()[0].fields.name,'first name');
 }finally{await x.service.close();}});

test('token numbers are final with their block: the journal follows a replaced block that brings two inscriptions back in another order',async()=>{
 const x=await world(),{curve,open,tokens,chain,service}=x;
 try{
  curve.push(curveLaunch('T1',SINCE+1),curveLaunch('T2',SINCE+2));const a=open();await a.turn();
  const ids=a.entries().map(e=>e.id),pool=await chain.pool(),txOf=async id=>{for(const t of pool){const got=(await chain.txs([t])).get(t);if(JSON.stringify(got.tx.extra).length&&a.entries().length)return null;}};
  chain.mine();await service.step();await a.turn();
  assert.deepEqual(a.entries().map(e=>[e.fields.tick,e.number]),[['T1',1],['T2',2]]);
  // The block is replaced; the two records come back one block apart, the second launch first.
  const txids=a.entries().map(e=>e.txid);chain.pop(1,{keep:true});chain.mine([],{only:[txids[1]]});chain.mine([],{only:[txids[0]]});await service.step();await a.turn();
  assert.deepEqual((await tokens()).reverse().map(t=>[t.tick,t.number]),[['T2',1],['T1',2]]);
  assert.deepEqual(a.entries().map(e=>[e.fields.tick,e.number,e.state]),[['T1',2,'done'],['T2',1,'done']]);assert.deepEqual(a.entries().map(e=>e.id),ids);
 }finally{await service.close();}});

test('the command refuses a start time given in seconds, in the future, or far back without --backfill',()=>{
 const run=join(import.meta.dirname,'../inscriber/run.mjs'),dir=mkdtempSync(join(tmpdir(),'xmr20-run-'));dirs.push(dir);
 const key=join(dir,'key');writeFileSync(key,newSecret()+'\n',{mode:0o600});
 const go=(...more)=>spawnSync(process.execPath,[run,'--index','http://127.0.0.1:9','--domain',DOMAIN,'--key-file',key,'--state',join(dir,'state'),'--trade','http://127.0.0.1:9',...more],{encoding:'utf8',timeout:20000});
 // A mistyped argument stops the command (a mistyped --preview must never start the real inscriber).
 for(const wrong of [['--previw'],['--dry-run'],['--per-day=0'],['extra'],['--since','1','--since','2'],['--burst'],['--burst','0'],['--per-day','-1'],['--every','5']]){
  const r=go('--since',String(Date.now()),...wrong);assert.equal(r.status,2,wrong.join(' ')+' '+r.stderr);}
 assert.match(go('--since','2026-11-14T00:00:00').stderr,/with its zone/);
 const seconds=go('--since','1794700000');assert.equal(seconds.status,2);assert.match(seconds.stderr,/milliseconds \(13 digits\)/);
 const future=go('--since',String(Date.now()+86_400_000));assert.equal(future.status,2);assert.match(future.stderr,/in the future/);
 const back=go('--since','2026-01-01T00:00:00Z');assert.equal(back.status,2);assert.match(back.stderr,/--backfill/);
 assert.ok(!existsSync(join(dir,'state')));
 // A new key file is readable by its owner only, and only the address is printed.
 const made=spawnSync(process.execPath,[run,'--new-key',join(dir,'new-key')],{encoding:'utf8'});
 assert.match(made.stdout,/^Inscriber address: 4[1-9A-HJ-NP-Za-km-z]{94}\n$/);assert.equal(statSync(join(dir,'new-key')).mode&0o777,0o600);assert.ok(!made.stdout.includes(readFileSync(join(dir,'new-key'),'utf8').trim()));
 assert.equal(spawnSync(process.execPath,[run,'--new-key',join(dir,'new-key')],{encoding:'utf8'}).status,2);});

// ---- Found in a second read, of the fixes above ----

test('one launch on two rows, a launch whose market is not in the same phase, a time in seconds, an unknown flow: left out, never guessed',async()=>{
 const x=await world(),{curve,bridge,markets}=x;
 try{
  curve.push(curveLaunch('TWIN',SINCE+1),{...curveLaunch('TWIN',SINCE+2),symbol:'OTHER',name:'other'},curveLaunch('AHEAD',SINCE+3),curveLaunch('SECONDS',1_800_000_100),curveLaunch('NOMARKET',SINCE+5),curveLaunch('FINE',SINCE+6));
  // The list still shows AHEAD on the curve while the markets already show its pool and what was burned.
  markets.push({mint:mintOf('AHEAD'),phase:'pool',graduated:{burnedTokens:'14000000000000'}},{mint:mintOf('NOMARKET'),phase:null});
  const t=await x.sources()[0].list();
  assert.deepEqual(t.launches.map(l=>l.fields.tick),['FINE']);
  assert.deepEqual(t.skipped.map(s=>s.why).sort(),['a launch time that is not in milliseconds','its market is not shown in the same phase; next pass','its market is not shown in the same phase; next pass','listed twice','listed twice']);
  // The next pass shows both in the pool phase: the supply is the launch's own.
  Object.assign(curve.find(c=>c.symbol==='AHEAD'),{phase:'pool',supply:'986000000000000'});
  assert.deepEqual((await x.sources()[0].list()).launches.map(l=>[l.fields.tick,l.fields.max]),[['AHEAD','1000000000'],['FINE','1000000000']]);
  bridge.push(bridgeLaunch('FLOWN',SINCE+1,{flow:'something-new'}),bridgeLaunch('FLOWM',SINCE+2,{venue:'meteora-damm-v2',flow:'x'}),bridgeLaunch('PLAIN',SINCE+3),bridgeLaunch('PAIR',SINCE+4,{venue:'meteora-damm-v2'}),
   bridgeLaunch('DUP',SINCE+5),{...bridgeLaunch('DUP2',SINCE+6),mint:mintOf('DUP')});
  const b=await x.sources()[1].list();
  assert.deepEqual(b.launches.map(l=>[l.fields.tick,l.fields.pair]),[['PLAIN','wXMR'],['PAIR','XMR20']]);
  assert.deepEqual(b.skipped.map(s=>s.why),['a launch venue this source does not know','a launch venue this source does not know','listed twice','listed twice']);
 }finally{await x.service.close();}});

test('launches put off by the day\'s bound do not count as a sudden many; they go out as the day moves on',async()=>{
 const x=await world(),{curve,open}=x;let clock=NOW();
 try{
  const a=open({limits:{burst:3,perDay:4,inFlight:10},now:()=>clock});
  // Two launches a pass, for six passes: never more than three new at once, but more than a day's bound in all.
  const seen=[];for(let i=0;i<6;i++){curve.push(curveLaunch('D'+(2*i),SINCE+10+2*i),curveLaunch('D'+(2*i+1),SINCE+11+2*i));const out=await a.turn();seen.push([out.found,out.held||0]);await x.block();}
  assert.deepEqual(seen,[[2,0],[2,0],[0,2],[0,4],[0,6],[0,8]]);
  assert.ok(!x.logs.some(l=>/new launches at once/.test(l.why||'')));
  // A day later the bound has room again: the oldest four go out, the rest wait for the next day, none is lost.
  clock+=86_400_001;const next=await a.turn();assert.deepEqual([next.found,next.held],[4,4]);
  assert.deepEqual(a.entries().map(e=>e.fields.tick),['D0','D1','D2','D3','D4','D5','D6','D7']);
  clock+=86_400_001;assert.equal((await a.turn()).found,4);assert.equal(Object.keys(a.journal.seen).length,0);
  // A real burst is still held: five new ones in one pass.
  for(let i=0;i<5;i++)curve.push(curveLaunch('Z'+i,SINCE+100+i));clock+=86_400_001;const held=await a.turn();assert.deepEqual([held.found,held.held],[0,5]);
 }finally{await x.service.close();}});

test('a new journal waits for as long as the relay still holds records of an earlier run, however many blocks that takes',async()=>{
 const x=await world({coins:0}),{curve,open,tokens,carrier,reader}=x;
 try{
  curve.push(curveLaunch('SLOW',SINCE+1,{name:'first name'}));const a=open();await a.turn();assert.equal(a.entries()[0].state,'sent');
  // The relay has no coin: the record waits there for many blocks. Meanwhile the journal is lost and the list changes the name.
  rmSync(join(x.dir,'inscriber'),{recursive:true});curve[0].name='second name';
  // An index that cannot say what exists for a launch is not used at all.
  assert.throws(()=>open({index:{...x.index,records:undefined}}),/needs an index that lists/);assert.throws(()=>open({index:{...x.index,deploys:undefined}}),/needs an index that lists/);
  // The new journal takes the waiting record over as the launch's record: nothing new is made, whatever the list says now.
  const b=open({limits:{quiet:2}});for(let i=0;i<5;i++){const out=await b.turn();assert.equal(out.found,0,'pass '+i);await x.block();}
  assert.deepEqual(b.entries().map(e=>[e.fields.name,e.state]),[['first name','sent']]);
  carrier.ready=5;for(let i=0;i<3;i++)await x.block();
  const out=await b.turn();assert.deepEqual([out.found,out.done],[0,1]);
  assert.deepEqual((await tokens()).map(t=>t.name),['first name']);assert.equal(reader.journal.filter(e=>e.ok).length,1);
 }finally{await x.service.close();}});

test('left-out launches past the bound are not noted again and again; a preview needs no key and writes nothing',async()=>{
 const x=await world(),{curve,bridge,open}=x;
 try{
  for(let i=0;i<8;i++)bridge.push(bridgeLaunch('V'+i,SINCE+1+i,{venue:'unknown-'+i}));curve.push(curveLaunch('GOOD',SINCE+20,{private:true,creatorWallet:'private'}));
  const a=open({limits:{skipped:5}});for(let i=0;i<3;i++)await a.turn();
  assert.equal(Object.keys(a.journal.skipped).length,5);assert.equal(x.logs.filter(l=>typeof l.skipped==='string'&&l.source).length,5);
  assert.equal(x.logs.filter(l=>/further ones are not noted/.test(l.skipped||'')).length,1);
  const lines=await preview({sources:x.sources(),since:SINCE});
  assert.deepEqual(lines.filter(l=>l.text).map(l=>[l.source,l.text]),[['monero-curve',deployText({tick:'GOOD',name:'good',max:'1000000000',dec:'6',mode:'monero-curve',mint:mintOf('GOOD')})]]);
  assert.equal(lines.filter(l=>l.skipped).length,8);assert.ok(!JSON.stringify(lines).includes('private'));
 }finally{await x.service.close();}});

// ---- Found by the outside review (each fails on the code before its fix) ----

test('a lost journal takes over a record the relay gave up on as stuck: one launch, one inscription, whatever the list says later',async()=>{
 const x=await world(),{curve,open,tokens,chain,service,relay,reader,index}=x;
 try{
  curve.push(curveLaunch('LONG',SINCE+1,{name:'first name'}));const a=open();await a.turn();const original=a.entries()[0].id;
  // The transaction stays in the node's pool, unmined, until the relay marks the record stuck. It is not "waiting" then.
  for(let n=0;n<=relay.limits.stuckBlocks;n++){chain.mine([],{only:[]});await service.step();}
  assert.equal(relay.status(original).state,'stuck');
  // The journal is lost and the list gives another name.
  rmSync(join(x.dir,'inscriber'),{recursive:true});curve[0].name='second name';
  const b=open({limits:{quiet:2}});for(let i=0;i<3;i++){await b.turn();chain.mine([],{only:[]});await service.step();}
  assert.deepEqual(b.entries().map(e=>[e.id,e.fields.name]),[[original,'first name']]);assert.ok(x.logs.some(l=>l.taken===mintOf('LONG')));
  // Everything pending is mined: one accepted mint record, one token.
  await x.block();await b.turn();
  assert.deepEqual(reader.journal.filter(e=>e.ok).map(e=>e.id),[original]);assert.deepEqual((await tokens()).map(t=>[t.id,t.name]),[[original,'first name']]);
  assert.equal(b.entries()[0].state,'done');
 }finally{await service.close();}});

test('an inscription its inscriber burned stays withdrawn: a new journal does not inscribe that launch again, even under another name',async()=>{
 const x=await world(),{curve,open,block,tokens,index,reader,signer}=x;
 try{
  curve.push(curveLaunch('GONE',SINCE+1,{name:'as launched'}));const a=open();await a.turn();await block();await a.turn();
  const L=reader.ledger,key=inscriberFrom(x.key),p=L.prepareBurn({nft:a.entries()[0].id,owner:signer.address});
  await index.submit(Buffer.from(L.sign(p.bodyBytes,key.sign(p.text))).toString('hex'));await block();assert.deepEqual(await tokens(),[]);
  rmSync(join(x.dir,'inscriber'),{recursive:true});curve[0].name='another name';
  const b=open();for(let i=0;i<3;i++){await b.turn();await block();}
  assert.deepEqual(b.entries().map(e=>[e.fields.tick,e.state]),[['GONE','off']]);assert.deepEqual(await tokens(),[]);assert.equal(reader.journal.filter(e=>e.ok&&e.record.startsWith('4d4431fe08')).length,1);
  // The index says so for anyone: the launch's mint has one deploy inscription, burned and not listed.
  const seen=await index.deploys(mintOf('GONE'));assert.deepEqual(seen.map(d=>[d.listed,d.burned,d.inscriber===signer.address,typeof d.record]),[[false,true,true,'string']]);
 }finally{await x.service.close();}});

test('the day\'s bound is shared oldest launch first across the lists, and a long queue keeps draining',async()=>{
 const x=await world(),{curve,bridge,open}=x;let clock=NOW();
 try{
  const a=open({limits:{burst:20,perDay:5,inFlight:50,perTurn:50},now:()=>clock});
  // Five launches on the Monero curve use up the day; an older bonding curve launch shows up after them.
  for(let i=0;i<5;i++)curve.push(curveLaunch('C'+i,SINCE+100+i));await a.turn();
  bridge.push(bridgeLaunch('ELDER',SINCE+2));for(let i=5;i<10;i++)curve.push(curveLaunch('C'+i,SINCE+100+i));
  const full=await a.turn();assert.deepEqual([full.found,full.held],[0,6]);
  // The next day's records go to the oldest launches, whichever list they are on: the older launch is first.
  clock+=86_400_001;const next=await a.turn();assert.equal(next.found,5);
  assert.deepEqual(a.entries().filter(e=>e.madeAt>clock-1000).map(e=>e.fields.tick),['ELDER','C5','C6','C7','C8']);
  // A queue far longer than a day, built up a few at a time, never trips the many-at-once hold and never loses a launch.
  for(let i=0;i<30;i++){for(let j=0;j<20;j++)curve.push(curveLaunch('Q'+i+'x'+j,SINCE+1000+i*20+j));const out=await a.turn();assert.ok(!x.logs.some(l=>/at once/.test(l.why||'')),'pass '+i);}
  assert.equal(Object.keys(a.journal.seen).length,601);
  let made=0;for(let d=0;d<3;d++){clock+=86_400_001;made+=(await a.turn()).found;}
  assert.equal(made,15);assert.equal(Object.keys(a.journal.seen).length,586);
  // A launch its list does not show for a while is set aside: not made while away, not new when it is back.
  const hidden=curve.findIndex(c=>c.symbol==='Q29x19'),[row]=curve.splice(hidden,1);await a.turn();
  assert.ok(x.logs.some(l=>l.gone===mintOf('Q29x19')));assert.ok(a.journal.seen[mintOf('Q29x19')].gone);
  // A whole list answering empty for a pass (and twenty new launches arriving with its return) trips nothing.
  const all=curve.splice(0);await a.turn();assert.equal(Object.values(a.journal.seen).filter(s=>s.gone).length,586);
  curve.push(...all,row);for(let j=0;j<20;j++)curve.push(curveLaunch('R'+j,SINCE+5000+j));const back=await a.turn();
  assert.ok(!x.logs.some(l=>/at once/.test(l.why||'')));assert.equal(Object.values(a.journal.seen).filter(s=>s.gone).length,0);assert.equal(Object.keys(a.journal.seen).length,606);
  clock+=86_400_001;assert.equal((await a.turn()).found,5);
  // After a long absence a launch leaves the queue.
  curve.splice(curve.findIndex(c=>c.symbol==='R19'),1);await a.turn();clock+=31*86_400_000;await a.turn();assert.equal(a.journal.seen[mintOf('R19')],undefined);
 }finally{await x.service.close();}});

// ---- Found in a check of the fixes above ----

test('one inscriber per journal; a record waiting for a place gives way to one another run handed over for the same launch',async()=>{
 const x=await world(),{curve,open,block,tokens,index,reader}=x;
 try{
  curve.push(curveLaunch('ONCE',SINCE+1,{name:'first name'}));
  // The relay is busy: the record is made and kept, not handed over.
  const busy={...index,submit:async()=>({state:'refused',error:'The relay is busy.',status:503})},a=open({index:busy});await a.turn();
  assert.deepEqual(a.entries().map(e=>e.state),['made']);const mine=a.entries()[0].id;
  // Another run with the same key and its own journal folder inscribes the same launch after the list changed its name.
  curve[0].name='second name';const b=open({dir:join(x.dir,'other-journal')});await b.turn();const theirs=b.entries()[0].id;assert.notEqual(theirs,mine);
  // The first run looks again before it hands its record over, finds the other one with the relay, and takes it.
  const c=open();await c.turn();assert.deepEqual(c.entries().map(e=>[e.id,e.state,e.fields.name]),[[theirs,'sent','second name']]);
  await block();await c.turn();await b.turn();
  assert.deepEqual(reader.journal.filter(e=>e.ok).map(e=>e.id),[theirs]);assert.deepEqual((await tokens()).map(t=>t.id),[theirs]);
  // A journal folder is one process's: a live other process on it is refused, a lock left by a dead one is taken over.
  const lock=join(x.dir,'inscriber','journal.lock');writeFileSync(lock,String(process.ppid));assert.throws(()=>open(),/Another inscriber \(process \d+\) is running on this journal/);
  writeFileSync(lock,'4194000');const d=open();assert.equal(readFileSync(lock,'utf8'),String(process.pid));d.close();assert.ok(!existsSync(lock));
 }finally{await x.service.close();}});

test('a record the relay still waits to be paid for is taken over as made, not as sent; a launch that moves to the other list is that list\'s launch',async()=>{
 const x=await world({fees:{mint:500000000n}}),{curve,bridge,open}=x;
 try{
  curve.push(curveLaunch('PAY',SINCE+1));const a=open();await a.turn();assert.equal(a.entries()[0].state,'made');const id=a.entries()[0].id;
  rmSync(join(x.dir,'inscriber'),{recursive:true});
  const b=open();await b.turn();assert.deepEqual(b.entries().map(e=>[e.id,e.state]),[[id,'made']]);
  // (Nothing is paid: it stays made, with the note, and is not closed.)
  for(let i=0;i<3;i++){await x.block();await b.turn();}assert.equal(b.entries()[0].state,'made');assert.match(b.entries()[0].note,/asks a fee/);
 }finally{await x.service.close();}
 const y=await world(),{curve:c2,bridge:b2}=y;let clock=NOW();
 try{
  for(let i=0;i<2;i++)c2.push(curveLaunch('M'+i,SINCE+1+i));const a=y.open({limits:{perDay:1},now:()=>clock});await a.turn();
  // M1 waits for the next day. Meanwhile it leaves the first list and appears on the second.
  c2.splice(1,1);b2.push({...bridgeLaunch('M1B',SINCE+9),mint:mintOf('M1')});await a.turn();await a.turn();
  assert.deepEqual([a.journal.seen[mintOf('M1')].source,a.journal.seen[mintOf('M1')].fields.mode,a.journal.seen[mintOf('M1')].gone??null],['bonding-curve','bonding-curve',null]);
  clock+=86_400_001;await a.turn();assert.deepEqual(a.journal.launches[mintOf('M1')].fields.tick,'M1B');
 }finally{await y.service.close();}});

// ---- Found by the outside review's confirmation ----

test('the relay holds a launch for the first record it takes: two runs with one key and two journals cannot both get a record in',async()=>{
 const x=await world(),{curve,open,block,tokens,index,relay,reader}=x;
 try{
  curve.push(curveLaunch('HELD',SINCE+1,{name:'first name'}));
  // An older run made its record while the relay was busy and has handed over nothing yet.
  const busy={...index,submit:async()=>({state:'refused',error:'busy',status:503})},first=open({index:busy});await first.turn();const original=first.entries()[0].id;
  const resumed=open();
  // A replacement run on another journal sees another name. The older run's hand-over lands after the replacement has read
  // what the relay holds and before the replacement hands its own record over.
  curve[0].name='changed name';let between=true;
  const racing={...index,token:async mint=>{if(between){between=false;await resumed.turn();}return index.token(mint);}};
  const replacement=open({dir:join(x.dir,'replacement'),index:racing});await replacement.turn();
  // The relay refuses the second record and names the one that holds the launch; the replacement takes that one over.
  assert.deepEqual(replacement.entries().map(e=>[e.id,e.state,e.fields.name]),[[original,'sent','first name']]);
  assert.deepEqual(relay.jobsOf(x.signer.address).map(j=>j.id),[original]);
  await block();await replacement.turn();await resumed.turn();
  assert.deepEqual(reader.journal.filter(e=>e.ok).map(e=>e.id),[original]);assert.deepEqual((await tokens()).map(t=>t.name),['first name']);
  // Over HTTP the refusal says which record holds the launch; the same record again is simply known; another signer's
  // deploy for the same mint is no business of the lane.
  const other=deployRecord({fields:{tick:'HELD',name:'another text',max:'1000000000',dec:'6',mode:'monero-curve',mint:mintOf('HELD')},inscriber:inscriberFrom(x.key),domain:DOMAIN});
  const r=await fetch(x.base+'/records',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({record:other.record})});
  assert.equal(r.status,409);assert.deepEqual(await r.json(),{error:'Another record for this launch is with the relay already.',held:original});
  assert.equal((await index.submit(replacement.entries()[0].record)).state,'done');
  // A correction by hand still goes through: once the inscriber has burned the inscription, the relay holds the launch
  // for nothing, and a record with another text is taken.
  const L=reader.ledger,key=inscriberFrom(x.key),p=L.prepareBurn({nft:original,owner:x.signer.address});
  await index.submit(Buffer.from(L.sign(p.bodyBytes,key.sign(p.text))).toString('hex'));await block();assert.deepEqual(await tokens(),[]);
  assert.equal((await index.submit(other.record)).state,'sent');await block();assert.deepEqual((await tokens()).map(t=>t.name),['another text']);
 }finally{await x.service.close();}});

test('a launch that was queued once is never new again, however long its list did not show it',async()=>{
 const x=await world(),{curve,bridge,open}=x;let clock=NOW();
 try{
  const a=open({limits:{perDay:3,inFlight:50,perTurn:50},now:()=>clock});
  for(let i=0;i<3;i++)curve.push(curveLaunch('F'+i,SINCE+1+i));await a.turn();
  // Twenty-one more arrive over two passes while the day is full, then all leave their list for more than the 30 days
  // a queued launch is kept, and come back together.
  const late=[];for(let i=0;i<21;i++)late.push(bridgeLaunch('L'+i,SINCE+100+i));
  bridge.push(...late.slice(0,20));await a.turn();bridge.push(late[20]);await a.turn();assert.equal(Object.keys(a.journal.seen).length,21);
  bridge.length=0;await a.turn();clock+=31*86_400_000;await a.turn();assert.equal(Object.keys(a.journal.seen).length,0);assert.equal(Object.keys(a.journal.known).length,24);
  bridge.push(...late);const back=await a.turn();
  assert.ok(!x.logs.some(l=>/at once/.test(l.why||'')));assert.deepEqual([back.found,back.held],[3,18]);
  // A restart keeps the identities; twenty-one launches never seen before are still held as many at once.
  const b=open({limits:{perDay:3,inFlight:50,perTurn:50},now:()=>clock});clock+=86_400_001;assert.equal((await b.turn()).found,3);
  for(let i=0;i<21;i++)curve.push(curveLaunch('N'+i,SINCE+500+i));const held=await b.turn();assert.equal(held.held,15+21);assert.ok(x.logs.some(l=>/more than 20 new launches at once/.test(l.why||'')));
 }finally{await x.service.close();}});
