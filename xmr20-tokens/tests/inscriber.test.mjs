// Offline tests of the launch inscriber (inscriber/): made-up launch lists in the shapes the public lists have, a
// made-up node and relay wallet, the real reader, relay and service. Nothing here is a real chain, key or token.
//   node --test xmr20-tokens/tests/inscriber.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,existsSync,statSync} from 'node:fs';
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
import {createInscriber,httpIndex} from '../inscriber/inscriber.mjs';
import {tradeSource,bridgeSource} from '../inscriber/sources.mjs';

const dirs=[];test.after(()=>{for(const d of dirs)rmSync(d,{recursive:true,force:true});});
const SINCE=1_800_000_000_000,B58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
// A Solana-shaped address for a label (32 bytes, base58).
const mintOf=label=>{let n=0n;for(const b of Buffer.concat([Buffer.from(label.padEnd(8,'.')),Buffer.alloc(24,7)]))n=n*256n+BigInt(b);let s='';while(n){s=B58[Number(n%58n)]+s;n/=58n;}return s;};

// The two public lists, as the services give them (only the fields that exist there; a creator and a wallet kind are
// among them on purpose: the inscriber must not carry them over).
const curveLaunch=(symbol,at,o={})=>({mint:mintOf(symbol),name:symbol.toLowerCase(),symbol,creator:null,creatorWallet:'monero',launchedAt:at,phase:'curve',venue:'curve',price:1e-11,supply:'1000000000000000',progress:0,trades:0,...o});
const bridgeLaunch=(ticker,at,o={})=>({id:'00000000-0000-4000-8000-'+Buffer.from(ticker.padEnd(6,'x')).toString('hex').slice(0,12),ticker,name:ticker+' coin',description:'made up',image:'https://api.xmr20.org/mainnet/i/x',mint:mintOf(ticker),
 owner:mintOf('creator'),network:'mainnet-beta',createdAt:at,state:'Launched',publicIndex:200,solanaFinalized:true,hidden:false,supply:'1000000000000000',launchMode:'normal',...o});
function lists(){
 const curve=[],bridge=[],info={params:{curve:{supply:'1000000000000000'}}};let down=null;
 const get=async url=>{if(down&&url.includes(down))throw Error('host answered 502');
  if(url==='https://trade.test/api/info')return info;if(url==='https://trade.test/api/launches')return {launches:curve.slice().reverse()};
  if(url==='https://site.test/api/xmr20/tokens')return {schema:'xmr20-launches-v1',moneroNetwork:'mainnet',solanaNetwork:'mainnet-beta',confirmations:10,tokens:bridge.slice()};
  throw Error('unexpected '+url);};
 return {curve,bridge,info,get,down:v=>{down=v;},sources:()=>[tradeSource({base:'https://trade.test',get}),bridgeSource({url:'https://site.test/api/xmr20/tokens',get})]};}

async function world({fees,inscribers,mintFrom=100,coins=30,relayOn=true}={}){
 const w=Object.fromEntries(['holder','fee'].map(n=>[n,wallet(n)])),key=newSecret(),signer=inscriberFrom(key);
 const owners=[makeTx('reg0',[{to:w.holder,amount:10n**9n}])].map((t,i)=>({...ownerEntry(i,t),registrationHeight:50,ownerHeight:50}));
 const dir=mkdtempSync(join(tmpdir(),'xmr20-inscriber-'));dirs.push(dir);
 const chain=fakeChain({start:100}),reader=openReader({dir:join(dir,'state'),chain,domain:DOMAIN,feeAddress:w.fee.address,owners,start:100,mintFrom});
 const carrier=fakeCarrier(chain,{coins}),relay=relayOn?createRelay({dir:join(dir,'relay'),reader,chain,carrier,domain:DOMAIN,limits:{resendMs:1000},...(fees?{fees}:{})}):null;
 const service=createService({reader,relay,owners,xmr20:{inscribers:inscribers||[signer.address]},testHooks:true}),port=await service.listen(0),base='http://127.0.0.1:'+port;
 await service.step();
 const l=lists(),logs=[],index=httpIndex(base);
 const open=(o={})=>createInscriber({dir:join(dir,'inscriber'),sources:l.sources(),index,inscriber:signer,domain:DOMAIN,since:SINCE,log:v=>logs.push(v),...o});
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
  await assert.rejects(a.turn(),/connection lost/);
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
  const d=open();assert.deepEqual(await d.turn(),{height:101,found:2,sent:0,done:2,counts:{done:2}});
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
 for(const [setup,why] of [[{inscribers:[other]},/does not list the tokens of this inscriber/],[{mintFrom:200},/minting is not open/],[{relayOn:false},/no relay/]]){
  const x=await world(setup);
  try{x.curve.push(curveLaunch('WAITS',SINCE+1));const a=x.open(),out=await a.turn();
   assert.match(out.waiting,why);assert.deepEqual([out.found,out.sent,a.entries().length],[0,0,0]);assert.ok(!existsSync(join(x.dir,'inscriber','journal.json')));}
  finally{await x.service.close();}}
 const x=await world();
 try{await assert.rejects(x.open({domain:'ab'.repeat(32)}).turn(),/another ledger/);
  assert.throws(()=>x.open({since:0}),/time from which/);
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
  assert.deepEqual(tl.skipped,[{mint:null,why:'no mint'},{mint:mintOf('NOTIME'),why:'no launch time'},{mint:'not-an-address',why:'mint: a Solana address.'}]);
  assert.deepEqual(bl.launches.map(l=>l.fields.tick),['FINE','GOOD2']);assert.deepEqual(bl.skipped,[{mint:mintOf('ODD'),why:'no whole supply'}]);
  // The same mint on both lists is inscribed once, for the list that is read first.
  const a=open();assert.deepEqual(await a.turn(),{height:100,found:2,sent:2,done:0,counts:{sent:2}});
  assert.deepEqual(a.entries().map(e=>[e.fields.tick,e.source]),[['GOOD','monero-curve'],['FINE','bonding-curve']]);
  // One list is down: the other is still read. A supply that is no whole number of tokens stops that list.
  curve.push(curveLaunch('LATER',SINCE+9));bridge.push(bridgeLaunch('MORE',SINCE+10));x.down('trade.test');
  await x.block();const out=await a.turn();assert.equal(out.found,1);assert.ok(x.logs.some(l=>l.source==='monero-curve'&&/502/.test(l.error)));
  x.down(null);x.info.params.curve.supply='1000000000000000001';await assert.rejects(t.list(),/whole supply/);
  x.info.params.curve.supply='1000000000000000';assert.equal((await a.turn()).found,1);
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
