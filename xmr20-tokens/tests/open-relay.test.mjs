// Offline tests of open XMR20 tokens through a relay (OPEN.md, draft): a deploy by a wallet that only signs a message,
// and mints the relay carries for a fee, with no signature at all. A made-up node, made-up keys and a stand-in for the
// carrier tool; nothing here is a real chain, wallet or token.
//   node --test xmr20-tokens/tests/open-relay.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {randomBytes,createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {wallet,makeTx,ownerEntry,DOMAIN} from '../../rules/tests/helpers.mjs';
import {openReader} from '../../reader/lib/reader.mjs';
import {createRelay,TOKEN_MINT} from '../../reader/lib/relay.mjs';
import {createService} from '../../reader/service.mjs';
import {fakeChain,fakeCarrier} from '../../reader/tests/fake.mjs';
import {unframe} from '../../reader/lib/transport.mjs';

const dirs=[];test.after(()=>{for(const d of dirs)rmSync(d,{recursive:true,force:true});});
const FEE=500000000n,OPEN=103,sha=t=>createHash('sha256').update(t).digest('hex');
async function world({fees={mint:FEE,tokenMint:FEE},limits={},tokens=true}={}){
 const w=Object.fromEntries(['alice','bob','fee','holder'].map(n=>[n,wallet('relay '+n)]));
 const owners=[makeTx('relay reg0',[{to:w.holder,amount:10n**9n}])].map((t,i)=>({...ownerEntry(i,t),registrationHeight:50,ownerHeight:50}));
 const dir=mkdtempSync(join(tmpdir(),'open-relay-'));dirs.push(dir);
 const chain=fakeChain({start:100}),reader=openReader({dir:join(dir,'state'),chain,domain:DOMAIN,feeAddress:w.fee.address,owners,start:100,mintFrom:101}),carrier=fakeCarrier(chain,{coins:20});let clock=1_000_000;
 const relay=createRelay({dir:join(dir,'relay'),reader,chain,carrier,domain:DOMAIN,limits:{resendMs:1000,mintDepth:1,...limits},fees,now:()=>clock});
 const service=createService({reader,relay,owners,...(tokens?{xmr20Open:{from:OPEN}}:{})}),base='http://127.0.0.1:'+await service.listen(0);
 const get=async path=>{const r=await fetch(base+path);return {status:r.status,body:await r.json()};};
 const post=async(path,body)=>{const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
 const block=async()=>{chain.mine();await service.step();},until=async h=>{while(reader.height<h)await block();};
 // A payment to one of the relay's fee addresses, in a block.
 const payFee=async(p,amount=BigInt(p.amount))=>{const txid=sha('fee payment '+randomBytes(8).toString('hex'));chain.mine([{txid,tx:{version:2,extra:[],vout:[]}}]);carrier.paid({index:Number(/(\d+)$/.exec(p.address)[1]),amount,txid});await service.step();};
 // The whole of a deploy as a signing wallet does it: ask for the text, sign it, hand the signature over, pay the relay.
 const deploy=async(who,fields)=>{const t=await post('/xmr20/open/deploy-text',{creator:who.address,...fields});assert.equal(t.status,200,JSON.stringify(t.body));
  const s=await post('/xmr20/open/deploys',{body:t.body.body,signature:who.sign(t.body.text)});assert.equal(s.status,200,JSON.stringify(s.body));
  if(s.body.state==='unpaid')await payFee(s.body.pay);await block();return t.body;};
 return {w,dir,chain,reader,relay,carrier,service,base,get,post,block,until,payFee,deploy,tick:ms=>{clock+=ms;},close:()=>service.close()};}
const recordIn=async(x,txid)=>{const t=(await x.chain.txs([txid])).get(txid);return {t,extra:Uint8Array.from(t.tx.extra)};};

test('a wallet that only signs a message deploys a token through the relay',async()=>{
 const x=await world();
 try{
  const fields={tick:'PEPE',name:'Pepe of the relay',max:'1000',lim:'100',pre:'10'};
  // Before the opening block nothing is prepared: a deploy carried now would be an NFT and no token.
  assert.deepEqual([(await x.post('/xmr20/open/deploy-text',{creator:x.w.alice.address,...fields})).status,(await x.post('/xmr20/open/mints',{token:'ab'.repeat(8),amount:'1',address:x.w.bob.address})).status],[409,409]);
  await x.until(OPEN-1);
  for(const bad of [{creator:'nobody',...fields},{creator:x.w.alice.address,tick:'PEPE',max:'1000'},{creator:x.w.alice.address,...fields,mint:'So11111111111111111111111111111111111111112'},{creator:x.w.alice.address,...fields,pre:'0'}])
   assert.equal((await x.post('/xmr20/open/deploy-text',bad)).status,400,JSON.stringify(bad));
  const t=(await x.post('/xmr20/open/deploy-text',{creator:x.w.alice.address,...fields})).body;
  assert.match(t.text,/^XMR721 mint: one NFT in no collection; \d+ bytes of type 6, SHA-256 [0-9a-f]{64}; first owner /);assert.ok(t.text.endsWith('; code '+t.id.slice(0,32)));
  assert.equal(t.label,`PEPE (token ${t.id.slice(0,16)})`);assert.equal(t.signer,x.w.alice.address);
  // A signature by another address, or over another text, makes no record; a body that is no deploy is not signed into one.
  assert.equal((await x.post('/xmr20/open/deploys',{body:t.body,signature:x.w.bob.sign(t.text)})).status,400);
  assert.equal((await x.post('/xmr20/open/deploys',{body:t.body,signature:x.w.alice.sign(t.text+' ')})).status,400);
  const plain=x.reader.ledger.prepareMint({creator:x.w.alice.address,type:5,content:Buffer.from('hello')});
  assert.equal((await x.post('/xmr20/open/deploys',{body:Buffer.from(plain.bodyBytes).toString('hex'),signature:x.w.alice.sign(plain.text)})).status,400);
  // Signed as wallets end a text (a line feed), handed over, paid for, and in a block: a token.
  const sent=(await x.post('/xmr20/open/deploys',{body:t.body,signature:x.w.alice.sign(t.text+'\n')})).body;
  assert.deepEqual([sent.id,sent.state,sent.pay.amount],[t.id,'unpaid',FEE.toString()]);assert.equal(x.carrier.made.length,0);
  await x.payFee(sent.pay);assert.equal(x.carrier.made.length,1);await x.block();
  const listed=(await x.get('/xmr20/open')).body.items;
  assert.deepEqual(listed.map(i=>[i.id,i.creator,i.label,i.lim,i.pre]),[[t.id,x.w.alice.address,t.label,'100','10']]);
  // The same deploy again, and one whose id would start the same way, are refused before anyone signs.
  assert.equal((await x.post('/xmr20/open/deploy-text',{creator:x.w.alice.address,...fields})).status,409);
  assert.equal((await x.get('/info')).body.relay.fees.tokenMint,FEE.toString());
 }finally{await x.close();}});

test('the relay carries a mint for its fee: no signature, to any address, once per request, settled by the node',async()=>{
 const x=await world({limits:{settleBlocks:3}});
 try{
  await x.until(OPEN-1);const token=await x.deploy(x.w.alice,{tick:'PEPE',max:'1000',lim:'100'}),all=await x.deploy(x.w.alice,{tick:'ALL',max:'5',pre:'5'});
  const ask={token:token.id.slice(0,16),amount:'50.5',address:x.w.bob.address,salt:'0102030405060708'};
  for(const [bad,status] of [[{...ask,token:'zz'},400],[{...ask,token:'cd'.repeat(32)},404],[{...ask,amount:'0'},400],[{...ask,amount:50},400],[{...ask,amount:'100.000001'},400],[{...ask,address:'nobody'},400],[{...ask,salt:'xyz'},400],[{...ask,token:all.id},400]])
   assert.equal((await x.post('/xmr20/open/mints',bad)).status,status,JSON.stringify(bad));
  const made=x.carrier.made.length,m=(await x.post('/xmr20/open/mints',ask)).body;
  assert.deepEqual([m.state,m.op,m.pay.amount,m.mint.token,m.mint.amount,m.mint.to,m.record.length],['unpaid',TOKEN_MINT,FEE.toString(),token.id,'50500000',x.w.bob.address,168]);
  assert.ok(m.record.startsWith('584f31fe'+m.mint.asset)&&m.record.endsWith(ask.salt));
  // The same request is the same job and the same address to pay; another salt is another mint.
  const again=(await x.post('/xmr20/open/mints',{...ask,token:token.id})).body;assert.deepEqual([again.id,again.pay.address],[m.id,m.pay.address]);
  const other=(await x.post('/xmr20/open/mints',{...ask,salt:undefined})).body;assert.notEqual(other.id,m.id);assert.notEqual(other.pay.address,m.pay.address);
  // Nothing is sent before the fee is in a block; too little is not the fee.
  await x.block();assert.equal(x.carrier.made.length,made);
  await x.payFee(m.pay,FEE-1n);assert.equal((await x.get('/xmr20/open-mint/'+m.id)).body.state,'unpaid');
  await x.payFee(m.pay,1n);
  const sent=(await x.get('/xmr20/open-mint/'+m.id)).body;assert.equal(sent.state,'sent');assert.equal(x.carrier.made.length,made+1);
  // What anyone can ask about a mint, or see among the waiting ones, names no address: the chain shows an owner key only.
  assert.deepEqual(sent.mint,{token:token.id,amount:'50500000',asset:m.mint.asset});assert.ok(!JSON.stringify([sent,x.relay.pending()]).includes(x.w.bob.address));assert.match(m.notice,/token ledger/);
  // The transaction carries exactly that record, in a field the XMR721 reader does not take for one of its own.
  const {t,extra}=await recordIn(x,sent.txid);assert.equal(t.inPool,true);assert.equal(unframe(extra),null);
  assert.ok(Buffer.from(extra).toString('hex').endsWith(m.record));
  await x.block();assert.equal((await x.get('/xmr20/open-mint/'+m.id)).body.state,'sent');
  await x.block();await x.block();
  const done=(await x.get('/xmr20/open-mint/'+m.id)).body;assert.deepEqual([done.state,done.confirmations>=3,done.txid],['done',true,sent.txid]);
  assert.ok(!x.reader.entryByTx(sent.txid));
  // A mint that is not paid for in time is dropped unsent; asked for again with the same salt, a late fee counts.
  for(let i=0;i<32;i++)await x.block();
  const late=(await x.get('/xmr20/open-mint/'+other.id)).body;assert.equal(late.state,'refused');assert.match(late.error,/not paid in time/);
  await x.payFee(other.pay);assert.equal((await x.get('/xmr20/open-mint/'+other.id)).body.state,'refused');
  const back=(await x.post('/xmr20/open/mints',{...ask,salt:other.mint.salt})).body;assert.deepEqual([back.id,back.pay.address,back.state],[other.id,other.pay.address,'unpaid']);
  await x.block();assert.equal((await x.get('/xmr20/open-mint/'+other.id)).body.state,'sent');
  // It asked nothing of the address the tokens go to: bob's own records are not held up by mints to him.
  assert.deepEqual(x.relay.waitingFor({signer:x.w.bob.address}),[]);
  assert.equal((await x.get('/xmr20/open-mint/'+'ef'.repeat(32))).status,404);
 }finally{await x.close();}});

test('a mint to an XMR20 wallet names the wallet by its owner key, in place of an address',async()=>{
 const x=await world();
 try{
  await x.until(OPEN-1);const token=await x.deploy(x.w.alice,{tick:'PEPE',max:'1000',lim:'100'});
  const key='cd'.repeat(32),ask={token:token.id,amount:'2.5',wallet:key,salt:'0102030405060708'};
  for(const bad of [{...ask,address:x.w.bob.address},{...ask,wallet:'cd'.repeat(31)},{...ask,wallet:'CD'.repeat(32)},{...ask,wallet:'ff'.repeat(32)},{...ask,wallet:7}])
   assert.equal((await x.post('/xmr20/open/mints',bad)).status,400,JSON.stringify(bad));
  const m=(await x.post('/xmr20/open/mints',ask)).body;
  assert.deepEqual([m.state,m.mint.wallet,m.mint.to,m.mint.amount],['unpaid',key,null,'2500000']);
  assert.equal(m.record.slice(8+64+16,8+64+16+64),key,'the record names the wallet as the owner');
  assert.equal((await x.post('/xmr20/open/mints',ask)).body.id,m.id,'asked again, the same mint');
  await x.payFee(m.pay);const sent=(await x.get('/xmr20/open-mint/'+m.id)).body;assert.equal(sent.state,'sent');
  assert.equal(JSON.stringify(sent).includes(key),false,'what the public sees of a mint does not say who it is for');
  assert.equal((await x.post('/xmr20/open/mints',{...ask,wallet:'00'.repeat(32)})).status,400);
  // A mint to an address, asked for again by the owner key its record shows: the same job, and not the address behind it.
  const a=(await x.post('/xmr20/open/mints',{token:token.id,amount:'1',address:x.w.bob.address,salt:'1112131415161718'})).body,owner=a.record.slice(88,152);
  const peek=(await x.post('/xmr20/open/mints',{token:token.id,amount:'1',wallet:owner,salt:'1112131415161718'})).body;
  assert.deepEqual([peek.id,peek.mint.to,peek.mint.wallet],[a.id,null,owner]);assert.equal(JSON.stringify(peek).includes(x.w.bob.address),false);
 }finally{await x.close();}
});

test('a mint the node dropped goes out again as the same transaction, and a block replaced under a done mint sends it again',async()=>{
 const x=await world({limits:{settleBlocks:3}});
 try{
  await x.until(OPEN-1);const token=await x.deploy(x.w.alice,{tick:'PEPE',max:'1000',lim:'100'});
  const m=(await x.post('/xmr20/open/mints',{token:token.id,amount:'1',address:x.w.bob.address})).body;await x.payFee(m.pay);
  const sent=(await x.get('/xmr20/open-mint/'+m.id)).body;assert.equal(sent.state,'sent');const made=x.carrier.made.length;
  x.chain.drop(sent.txid);x.tick(5000);await x.block();
  assert.equal((await x.chain.txs([sent.txid])).has(sent.txid),true,'handed to the node again');assert.equal(x.carrier.made.length,made,'no second transaction');
  await x.block();await x.block();await x.block();assert.equal((await x.get('/xmr20/open-mint/'+m.id)).body.state,'done');
  // The blocks that held it are replaced and it is gone from the node: it counts as sent again and goes out once more.
  x.chain.pop(4);await x.service.step();x.tick(5000);await x.block();
  assert.deepEqual([(await x.get('/xmr20/open-mint/'+m.id)).body.state,(await x.chain.txs([sent.txid])).has(sent.txid),x.carrier.made.length],['sent',true,made]);
 }finally{await x.close();}});

test('a relay without a fee for token mints, or a reader without open tokens, carries none',async()=>{
 const free=await world({fees:{mint:FEE}}),none=await world({tokens:false});
 try{
  await free.until(OPEN-1);const token=await free.deploy(free.w.alice,{tick:'PEPE',max:'1000',lim:'100'});
  const r=await free.post('/xmr20/open/mints',{token:token.id,amount:'1',address:free.w.bob.address});assert.equal(r.status,503);assert.match(r.body.error,/does not carry mints/);
  assert.equal((await free.get('/info')).body.relay.fees.tokenMint,undefined);
  await none.until(OPEN);
  for(const path of ['/xmr20/open/mints','/xmr20/open/deploy-text','/xmr20/open/deploys'])assert.equal((await none.post(path,{})).status,404,path);
 }finally{await free.close();await none.close();}});

test('a mint that is paid for waits for a coin as long as it takes and is never charged twice; mints do not use up the records\' limits',async()=>{
 const x=await world({limits:{settleBlocks:3,stuckBlocks:5,waiting:2,perDay:2,mintDepth:4}});
 try{
  await x.until(OPEN-1);const token=await x.deploy(x.w.alice,{tick:'PEPE',max:'1000',lim:'100'}),ask={token:token.id,amount:'1',address:x.w.bob.address};
  // The relay mints a token only once its deploy is some blocks deep: a replaced block could put a mint before its deploy.
  const early=await x.post('/xmr20/open/mints',ask);assert.equal(early.status,400);assert.match(early.body.error,/once its deploy is 4 blocks deep/);
  await x.block();await x.block();await x.block();
  // No coin of the relay is ready: the paid mints wait, far beyond the blocks after which an unsent record is given up on.
  x.carrier.ready=0;const jobs=[];
  for(const salt of ['00'.repeat(8),'11'.repeat(8),'22'.repeat(8)]){const m=(await x.post('/xmr20/open/mints',{...ask,salt})).body;await x.payFee(m.pay);jobs.push(m);}
  for(let i=0;i<12;i++)await x.block();
  assert.deepEqual(await Promise.all(jobs.map(async m=>(await x.get('/xmr20/open-mint/'+m.id)).body.state)),['queued','queued','queued']);
  // Asked for again, each is the same job, with nothing more to pay.
  const again=(await x.post('/xmr20/open/mints',{...ask,salt:'00'.repeat(8)})).body;assert.deepEqual([again.id,again.state,again.pay],[jobs[0].id,'queued',undefined]);
  // Three paid mints waiting do not make the relay "busy" for a record (two may wait), nor count against its daily limit.
  const p=x.reader.ledger.prepareMint({creator:x.w.bob.address,type:5,content:Buffer.from('a record beside the mints')}),record=Buffer.from(x.reader.ledger.sign(p.bodyBytes,x.w.bob.sign(p.text))).toString('hex');
  const r=await x.post('/records',{record});assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.state,'unpaid');
  // Coins are back: every paid mint goes out, once.
  // (The relay counts its coins at the end of a pass, so it sees them in the pass after.)
  x.carrier.ready=10;const made=x.carrier.made.length;await x.block();await x.block();
  assert.deepEqual(await Promise.all(jobs.map(async m=>(await x.get('/xmr20/open-mint/'+m.id)).body.state)),['sent','sent','sent']);assert.equal(x.carrier.made.length,made+3);
  for(let i=0;i<4;i++)await x.block();
  assert.deepEqual(await Promise.all(jobs.map(async m=>(await x.get('/xmr20/open-mint/'+m.id)).body.state)),['done','done','done']);assert.equal(x.carrier.made.length,made+3);
 }finally{await x.close();}});

test('asking for mints costs the relay nothing before its limits, and an address nobody paid is given out again',async()=>{
 const x=await world({limits:{mintUnpaid:2,mintIdleMs:1000,payBlocks:2}});
 try{
  await x.until(OPEN-1);const token=await x.deploy(x.w.alice,{tick:'PEPE',max:'1000',lim:'100'}),ask={token:token.id,amount:'1',address:x.w.bob.address};
  let spawns=0;const tool=x.carrier.mintRecord;x.carrier.mintRecord=async a=>{spawns++;return tool(a);};
  const a=(await x.post('/xmr20/open/mints',ask)).body,b=(await x.post('/xmr20/open/mints',ask)).body;assert.equal(spawns,2);
  // Two unpaid mints are the limit here: further ones are refused before the carrier tool is asked for anything.
  for(let i=0;i<5;i++)assert.equal((await x.post('/xmr20/open/mints',ask)).status,503);assert.equal(spawns,2);
  // Neither is paid. Their addresses are free again after a while, for someone else.
  for(let i=0;i<4;i++)await x.block();assert.equal((await x.get('/xmr20/open-mint/'+a.id)).body.state,'refused');
  x.tick(5000);const c=(await x.post('/xmr20/open/mints',ask)).body;
  assert.ok([a.pay.address,b.pay.address].includes(c.pay.address));assert.equal((await x.get('/xmr20/open-mint/'+a.id)).status+(await x.get('/xmr20/open-mint/'+b.id)).status,200+404);
 }finally{await x.close();}});
