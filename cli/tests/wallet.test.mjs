// Offline tests of the xmr721 wallet (cli/lib/wallet.mjs) and its command line: a made-up node and a stand-in for the
// carrier tool that keeps its keys the way the real one does, a reader over HTTP, and a ledger whose minting opens to
// everyone at a block. The made-up ledger is a stagenet one: on mainnet the wallet inscribes on one ledger only.
//   node --test cli/tests/wallet.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,existsSync,mkdirSync,statSync} from 'node:fs';
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
import {openWallet,readerAt,typeOf,mintingClosed,keysOf,clean,LEDGERS} from '../lib/wallet.mjs';

const NET='stagenet',dirs=[];test.after(()=>{for(const d of dirs)rmSync(d,{recursive:true,force:true});});
const temp=name=>{const d=mkdtempSync(join(tmpdir(),name));dirs.push(d);return d;};
const L=ed25519.CURVE.n,scalar=()=>{for(;;){const s=le(randomBytes(32))%L;if(s)return hex(leBytes(s));}};
// The carrier tool as the tests need it: its keys in carrier.keys.json (two random scalars, as the real tool writes
// them), coins and transactions as reader/tests/fake.mjs keeps them. `lose` makes the next send fail: 'before' the
// node has the transaction, or 'after' (the node has it and the answer is lost).
function carrierIn(dir,chain,{coins=5}={}){
 const c=fakeCarrier(chain,{coins}),x={lose:null,sends:0,
  get made(){return c.made;},get ready(){return c.ready;},set ready(v){c.ready=v;},
  status:()=>c.status(),carry:r=>c.carry(r),split:n=>c.split(n),
  publish:async blob=>{x.sends++;const how=x.lose;x.lose=null;if(how==='before')throw Error('the node is not there');const done=await c.publish(blob);if(how==='after')throw Error('the answer was lost');return done;},
  init:async()=>{mkdirSync(dir,{recursive:true});const f=join(dir,'carrier.keys.json');if(!existsSync(f))writeFileSync(f,JSON.stringify({spend:scalar(),view:scalar()}));return {address:keysOf(dir,NET).address};}};
 return x;}

async function world({openFrom=106}={}){
 const launchpad=testWallet('launchpad',NET),bob=testWallet('bob',NET),fee=testWallet('fee',NET),holder=testWallet('holder',NET);
 const owners=[makeTx('reg0',[{to:holder,amount:10n**9n}])].map((t,i)=>({...ownerEntry(i,t),registrationHeight:50,ownerHeight:50}));
 const chain=fakeChain({start:100}),reader=openReader({dir:temp('wallet-reader-'),chain,network:NET,domain:DOMAIN,feeAddress:fee.address,owners,start:100,mintFrom:101,minters:[launchpad.address],openFrom});
 await reader.sync();const service=createService({reader,owners}),base='http://127.0.0.1:'+await service.listen(0);
 const make=(name,o={})=>{const dir=join(temp('wallet-'),name),carrier=carrierIn(dir,chain,o);return {dir,carrier,wallet:openWallet({dir,carrier,reader:o.reader??readerAt(base),chain,network:NET,domain:DOMAIN})};};
 const block=async()=>{chain.mine();await service.step();};
 const until=async h=>{while(reader.height<h)await block();};
 return {chain,reader,service,base,owners,bob,launchpad,make,block,until,close:()=>service.close()};}
const states=async w=>(await w.inscriptions()).map(r=>[r.kind,r.state.replace(/\(block \d+, \d+ confirmations\)/,'(…)')]);

test('a wallet is made once, readable by its owner only, and its address is the one its keys give',async()=>{
 const x=await world();
 try{
  const a=x.make('a'),made=await a.wallet.create({height:x.reader.height});
  assert.equal(made.address,a.wallet.address);assert.deepEqual(JSON.parse(readFileSync(join(a.dir,'wallet.json'),'utf8')),{network:NET,start:100});
  assert.deepEqual([statSync(a.dir).mode&0o777,statSync(join(a.dir,'wallet.json')).mode&0o777],[0o700,0o600]);
  await assert.rejects(a.wallet.create({height:100}),/a wallet in .* already/);
  assert.throws(()=>x.make('none').wallet.address,/There is no wallet/);
  const b=await a.wallet.balance();assert.deepEqual([b.address,b.ready,b.coins,b.waitingToBeSent],[made.address,5,5,0]);
 }finally{await x.close();}});

test('inscribing: closed to anyone off the list until the opening block, then one NFT owned by the wallet or by --to',async()=>{
 const x=await world();
 try{
  const a=x.make('a');await a.wallet.create({height:x.reader.height});const content=Buffer.from('hello, Monero'),me=a.wallet.address;
  // Before the opening block: refused here, before anything is built or sent.
  await assert.rejects(a.wallet.inscribe({content,type:5}),/Minting opens to everyone at block 106/);assert.equal(a.carrier.made.length,0);
  await x.until(105);
  // A dry run makes and signs the record, shows it, and builds and sends nothing.
  const dry=await a.wallet.inscribe({content,type:5,name:'hello',dryRun:true});
  assert.deepEqual([dry.dryRun,dry.kind,dry.owner,a.carrier.made.length,existsSync(join(a.dir,'inscriptions.jsonl')),existsSync(join(a.dir,'pending.json'))],[true,'mint',me,0,false,false]);
  assert.match(dry.text,/^XMR721 mint: one NFT in no collection named "hello"; 13 bytes of type 5/);assert.match(dry.record,/^[0-9a-f]+$/);
  const one=await a.wallet.inscribe({content,type:5,name:'hello'}),two=await a.wallet.inscribe({content:Buffer.from('for bob'),type:5,to:x.bob.address});
  assert.equal(one.id,dry.id,'the same record whenever it is made');assert.equal(a.carrier.made.length,2);assert.ok(one.txid&&one.fee&&!('blob' in one));
  assert.deepEqual(await states(a.wallet),[['mint','waiting for a block'],['mint','waiting for a block']]);
  await x.block();
  assert.deepEqual([x.reader.ledger.nft(one.id)?.owner,x.reader.ledger.nft(two.id)?.owner,x.reader.ledger.nft(one.id)?.minted.creator],[me,x.bob.address,me]);
  assert.deepEqual(await states(a.wallet),[['mint','on the ledger (…)'],['mint','on the ledger (…)']]);
  // --to the wallet's own address is the same record as none.
  assert.equal((await a.wallet.inscribe({content,type:5,name:'hello',to:me,dryRun:true})).id,one.id);
 }finally{await x.close();}});

test('the same record is never paid for twice: before it is in a block, after, and for a collection',async()=>{
 const x=await world({openFrom:102});
 try{
  await x.until(102);const a=x.make('a');await a.wallet.create({height:x.reader.height});const content=Buffer.from('once');
  await a.wallet.inscribe({content,type:5});
  await assert.rejects(a.wallet.inscribe({content,type:5}),/sent this very record before/);
  await x.block();await assert.rejects(a.wallet.inscribe({content,type:5}),/on the ledger already/);
  // Another name or other content is another record.
  await a.wallet.inscribe({content,type:5,name:'again'});
  const c=await a.wallet.collection({name:'Set',max:2});await assert.rejects(a.wallet.collection({name:'Set',max:2}),/sent this very record before/);
  await x.block();await assert.rejects(a.wallet.collection({name:'Set',max:2}),/a collection of this name and size already/);
  assert.equal(a.carrier.made.length,3);assert.ok(x.reader.ledger.collection(c.id));
 }finally{await x.close();}});

test('collections: editions in turn, also several before a block; only the maker mints; sending, one send at a time',async()=>{
 const x=await world({openFrom:102});
 try{
  await x.until(101);const a=x.make('a'),b=x.make('b');await a.wallet.create({height:x.reader.height});await b.wallet.create({height:x.reader.height});
  const c=await a.wallet.collection({name:'Moons',max:3});
  // A new collection has to be in a block before its editions are minted.
  await assert.rejects(a.wallet.inscribe({content:Buffer.from('moon 1'),type:5,collection:c.id}),/not on the ledger yet/);
  await x.block();assert.equal(x.reader.ledger.collection(c.id)?.creator,a.wallet.address);
  // Two editions before a block: the wallet counts its own mint that no block holds yet.
  const e1=await a.wallet.inscribe({content:Buffer.from('moon 1'),type:5,collection:c.id}),e2=await a.wallet.inscribe({content:Buffer.from('moon 2'),type:5,collection:c.id});
  assert.deepEqual([e1.edition,e2.edition],[1,2]);assert.match(e2.text,/edition 2 of "Moons"/);
  await assert.rejects(a.wallet.inscribe({content:Buffer.from('x'),type:5,collection:c.id,edition:2}),/this wallet's mint of it is waiting/);
  await x.block();assert.deepEqual([x.reader.ledger.nft(e1.id)?.minted.edition,x.reader.ledger.nft(e2.id)?.minted.edition],[1,2]);
  await assert.rejects(a.wallet.inscribe({content:Buffer.from('again'),type:5,collection:c.id,edition:1}),/Edition 1 of this collection is minted already/);
  await assert.rejects(a.wallet.inscribe({content:Buffer.from('x'),type:5,collection:c.id,edition:4}),/An edition of this collection is 1 to 3/);
  await assert.rejects(b.wallet.inscribe({content:Buffer.from('mine?'),type:5,collection:c.id}),/only its creator mints its editions/);
  await assert.rejects(a.wallet.inscribe({content:Buffer.from('x'),type:5,collection:'ab'.repeat(32)}),/not on the ledger yet/);
  await assert.rejects(a.wallet.inscribe({content:Buffer.from('x'),type:5,edition:2}),/--edition goes with --collection/);
  // Send edition 1 to b: one send of an NFT at a time; then b sends it back. Each send names the NFT's latest state.
  const s=await a.wallet.send({nft:e1.id,to:b.wallet.address});assert.match(s.text,/^Mordinals move: send "Moons" #1 \(NFT [0-9a-f]{32}\) to /);
  await assert.rejects(a.wallet.send({nft:e1.id,to:x.bob.address}),/earlier send of this NFT is waiting for a block/);
  await x.block();assert.equal(x.reader.ledger.nft(e1.id).owner,b.wallet.address);
  await assert.rejects(a.wallet.send({nft:e1.id,to:x.bob.address}),/belongs to .*, not to this wallet/);
  await b.wallet.send({nft:e1.id,to:a.wallet.address});await x.block();assert.equal(x.reader.ledger.nft(e1.id).owner,a.wallet.address);
  await assert.rejects(a.wallet.send({nft:e1.id,to:a.wallet.address}),/own address/);
  assert.deepEqual(await states(a.wallet),[['collection','on the ledger (…)'],['mint','on the ledger (…)'],['mint','on the ledger (…)'],['send','on the ledger (…)']]);
  assert.equal(a.carrier.made.length,4);
 }finally{await x.close();}});

test('a send that fails loses nothing: the built transaction is kept and goes out again as the same one',async()=>{
 const x=await world({openFrom:102});
 try{
  await x.until(102);const a=x.make('a');await a.wallet.create({height:x.reader.height});const content=Buffer.from('kept');
  // The node is not there: the transaction is built (its coin is used) and kept.
  a.carrier.lose='before';await assert.rejects(a.wallet.inscribe({content,type:5}),/built and the node did not take it .* It is kept: run "xmr721 wallet resend"/);
  assert.equal(a.carrier.made.length,1);const kept=Object.values(JSON.parse(readFileSync(join(a.dir,'pending.json'),'utf8')));
  assert.deepEqual([kept.length,kept[0].txid,(await a.wallet.balance()).waitingToBeSent,existsSync(join(a.dir,'inscriptions.jsonl'))],[1,a.carrier.made[0],1,false]);
  assert.deepEqual(await states(a.wallet),[['mint','built, not with the node yet: run "xmr721 wallet resend"']]);
  // The same command again sends that transaction; nothing new is built.
  const again=await a.wallet.inscribe({content,type:5});assert.deepEqual([again.again,again.txid,a.carrier.made.length],[true,kept[0].txid,1]);
  assert.equal(readFileSync(join(a.dir,'pending.json'),'utf8').trim(),'{}');await x.block();assert.ok(x.reader.ledger.nft(again.id));
  // The node took it and its answer was lost: the node has the transaction, so it counts as sent.
  a.carrier.lose='after';const lost=await a.wallet.inscribe({content:Buffer.from('answer lost'),type:5});assert.ok(lost.txid);assert.equal(readFileSync(join(a.dir,'pending.json'),'utf8').trim(),'{}');
  // "resend" sends everything that is kept; a transaction the node still does not take stays kept.
  a.carrier.lose='before';await assert.rejects(a.wallet.inscribe({content:Buffer.from('third'),type:5}));
  a.carrier.lose='before';assert.match((await a.wallet.resend())[0].state,/the node did not take it/);
  assert.deepEqual((await a.wallet.resend()).map(r=>r.state),['sent']);assert.deepEqual(await a.wallet.resend(),[]);
  await x.block();assert.deepEqual(await states(a.wallet),[['mint','on the ledger (…)'],['mint','on the ledger (…)'],['mint','on the ledger (…)']]);assert.equal(a.carrier.made.length,3);
 }finally{await x.close();}});

test('a reader is not believed beyond one network fee: its answers are checked, and a refused record is shown as refused',async()=>{
 const x=await world({openFrom:102});
 try{
  await x.until(102);const real=readerAt(x.base);
  // A reader that hides a collection's minted editions: the wallet mints edition 1 again, the ledger refuses it, and
  // the wallet says so.
  const a=x.make('a');await a.wallet.create({height:x.reader.height});const c=await a.wallet.collection({name:'Set',max:2});await x.block();
  await a.wallet.inscribe({content:Buffer.from('one'),type:5,collection:c.id});await x.block();
  // (Had it also hidden what became of the wallet's own mint, the wallet would count that mint itself and pick edition 2.)
  const liar={...real,collection:async(id,n)=>({...(await real.collection(id,n)),editions:[]})},blind={...liar,entry:async()=>null};
  assert.equal((await openWallet({dir:a.dir,carrier:a.carrier,reader:blind,chain:x.chain,network:NET,domain:DOMAIN}).inscribe({content:Buffer.from('x'),type:5,collection:c.id,dryRun:true})).edition,2);
  const fooled=openWallet({dir:a.dir,carrier:a.carrier,reader:liar,chain:x.chain,network:NET,domain:DOMAIN});
  const wasted=await fooled.inscribe({content:Buffer.from('one again'),type:5,collection:c.id});assert.equal(wasted.edition,1);await x.block();
  assert.deepEqual((await states(a.wallet)).at(-1),['mint','refused by the ledger: This edition is already minted.']);
  // Answers of the wrong shape are refused before anything is signed or built.
  const made=a.carrier.made.length,stub=answers=>new Promise(done=>{const s=createServer((req,res)=>{const v=answers(req.url);res.writeHead(v.status??200,{'content-type':'application/json'});res.end(typeof v.body==='string'?v.body:JSON.stringify(v.body));});s.listen(0,'127.0.0.1',()=>done(s));});
  const info={network:NET,domain:DOMAIN,height:x.reader.height,mintFrom:101,minters:[x.launchpad.address],openFrom:102};
  const tries=[
   [u=>({body:{...info,domain:'ab'.repeat(32)}}),/another ledger/],
   [u=>({body:{...info,network:'mainnet'}}),/The reader is for mainnet, the wallet for stagenet/],
   [u=>({body:{...info,height:'9'}}),/no usable height/],
   [u=>({body:{...info,minters:['not an address']}}),/no usable minter list/],
   [u=>u==='/info'?{body:info}:{body:{collection:{id:c.id,name:'Set',max:4294967295,creator:a.wallet.address},items:[]}},/no usable number of editions/],
   [u=>u==='/info'?{body:info}:{body:{collection:{id:c.id,name:'Set',max:2,creator:a.wallet.address},items:[{edition:'1'}]}},/no usable edition/],
   [u=>u==='/info'?{body:info}:{status:500,body:{error:'bad \u001b]52;c;QUFB\u0007 thing'}},/answered 500 for .*: bad  \]52;c;QUFB  thing$/],
   [u=>({body:'x'.repeat(200)}),/no settings|did not answer with JSON/]];
  for(const [answers,why] of tries){const s=await stub(answers);
   try{const w=openWallet({dir:a.dir,carrier:a.carrier,reader:readerAt('http://127.0.0.1:'+s.address().port),chain:x.chain,network:NET,domain:DOMAIN});
    await assert.rejects(w.inscribe({content:Buffer.from('never'),type:5,collection:c.id}),why);}finally{await new Promise(r=>{s.closeAllConnections?.();s.close(r);});}}
  const big=await stub(()=>({body:{pad:'x'.repeat(4096)}}));
  try{await assert.rejects(readerAt('http://127.0.0.1:'+big.address().port,{limit:1024}).info(NET),/more than this program reads/);}finally{await new Promise(r=>{big.closeAllConnections?.();big.close(r);});}
  assert.equal(a.carrier.made.length,made,'nothing was built for any of them');
  // On mainnet the ledger is the one this program knows: no option and no reader makes it another.
  assert.throws(()=>openWallet({dir:a.dir,carrier:a.carrier,reader:real,chain:x.chain,network:'mainnet',domain:DOMAIN}),/another domain is another ledger/);
  assert.match(LEDGERS.mainnet.domain,/^[0-9a-f]{64}$/);
  const main=await stub(()=>({body:{...info,network:'mainnet',domain:DOMAIN,minters:undefined}}));
  try{const dir=join(temp('wallet-'),'m'),carrier={...carrierIn(dir,x.chain),init:async()=>{mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'carrier.keys.json'),JSON.stringify({spend:scalar(),view:scalar()}));return {address:keysOf(dir,'mainnet').address};}};
   const w=openWallet({dir,carrier,reader:readerAt('http://127.0.0.1:'+main.address().port),chain:x.chain,network:'mainnet'});await w.create({height:5});
   await assert.rejects(w.inscribe({content:Buffer.from('x'),type:5}),/another ledger \([0-9a-f]{64}\) than this wallet inscribes on/);}finally{await new Promise(r=>{main.closeAllConnections?.();main.close(r);});}
 }finally{await x.close();}});

test('what the wallet does not send: no coin ready, a record too big, a name the rules refuse, an address of another kind',async()=>{
 const x=await world({openFrom:102});
 try{
  await x.until(102);const a=x.make('a',{coins:0});await a.wallet.create({height:x.reader.height});
  await assert.rejects(a.wallet.inscribe({content:Buffer.from('x'),type:5}),/The wallet has no coins. Send some XMR to [57]/);
  a.carrier.ready=1;
  await assert.rejects(a.wallet.inscribe({content:Buffer.alloc(MAX_RECORD,1),type:1}),/record is \d+ bytes; a record is at most 1000/);
  await assert.rejects(a.wallet.inscribe({content:Buffer.from('x'),type:5,name:'say "hi"'}),/name|quote/i);
  await assert.rejects(a.wallet.collection({name:'Too many',max:10001}),/1 to 10000 editions/);
  await assert.rejects(a.wallet.inscribe({content:Buffer.alloc(0),type:5}),/empty/);
  await assert.rejects(a.wallet.inscribe({content:Buffer.from('x'),type:5,to:testWallet('main','mainnet').address}),/address/i);
  await assert.rejects(a.wallet.split(15),/2 to 14/);
  assert.equal(a.carrier.made.length,0);assert.equal(existsSync(join(a.dir,'pending.json')),false);
 }finally{await x.close();}});

test('content types, the minting check, and text made safe to print',()=>{
 assert.deepEqual(['a.png','b.JPG','c.jpeg','d.webp','e.gif','f.txt','g.json','h.mp4'].map(f=>typeOf(f)),[1,2,2,3,4,5,6,7]);
 assert.deepEqual([typeOf('x.bin','art'),typeOf('x','9'),typeOf('x.png','text')],[8,9,5]);
 assert.throws(()=>typeOf('x.bin'),/give --type/);assert.throws(()=>typeOf('x','0'),/1 to 255/);assert.throws(()=>typeOf('x','pdf'),/content type name/);assert.throws(()=>typeOf('x','0x5'),/content type name/);
 const info={height:99,mintFrom:101,minters:['L'],openFrom:110};
 assert.match(mintingClosed({...info,mintFrom:null},'A'),/no minting/);assert.match(mintingClosed(info,'A'),/starts at block 101/);
 assert.equal(mintingClosed({...info,height:100},'L'),null);assert.match(mintingClosed({...info,height:100},'A'),/opens to everyone at block 110/);
 assert.equal(mintingClosed({...info,height:109},'A'),null);assert.equal(mintingClosed({...info,minters:null,openFrom:null,height:100},'A'),null);
 assert.match(mintingClosed({...info,openFrom:null,height:100},'A'),/only its listed minters/);
 assert.equal(clean('a\u001b[31mb\u0007c\u2028d'),'a [31mb c d');assert.equal(clean('x'.repeat(500)).length,200);assert.equal(clean(null),'');});

test('the command line refuses what it does not understand instead of skipping it',()=>{
 const bin=join(import.meta.dirname,'..','xmr721.mjs'),none=join(temp('wallet-'),'none'),run=(...args)=>{const r=spawnSync(process.execPath,[bin,...args,'--wallet',none],{encoding:'utf8',timeout:20000});return [r.status,(r.stderr||r.stdout).split('\n')[0]];};
 const file=join(temp('wallet-'),'note.txt');writeFileSync(file,'a note');
 assert.deepEqual(run('wallet','inscribe','--file',file,'--dryrun'),[2,'There is no option --dryrun. See: xmr721 --help']);
 assert.deepEqual(run('wallet','inscribe','--file',file,'--dry-run=true'),[2,'Write "--dry-run <value>", with a space instead of "=".']);
 assert.deepEqual(run('wallet','inscribe','--file',file,'--to=4abc'),[2,'Write "--to <value>", with a space instead of "=".']);
 assert.deepEqual(run('wallet','create','--network=stagenet'),[2,'Write "--network <value>", with a space instead of "=".']);
 assert.deepEqual(run('wallet','create','--name','x'),[2,'"wallet create" takes no --name.']);
 assert.deepEqual(run('wallet','inscribe','--file',file,'--edition','2'),[2,'--edition goes with --collection.']);
 assert.deepEqual(run('wallet','inscribe','--file',file,'--collection',''),[2,'--collection is empty.']);
 assert.deepEqual(run('wallet','inscribe','--file',file,'--edition','1.5','--collection','ab'.repeat(32)),[2,'--edition is a whole number.']);
 assert.deepEqual(run('wallet','inscribe','--file',file,'--file',file),[2,'--file is given twice.']);
 assert.deepEqual(run('wallet','split','20'),[2,'Split into 2 to 14 coins.']);
 assert.deepEqual(run('wallet','send','onlyone'),[2,'xmr721 wallet send <nft id> <address>']);
 assert.deepEqual(run('wallet','create','--max-fee','0,02'),[2,'--max-fee is an amount of XMR with a decimal point, like 0.02.']);
 assert.deepEqual(run('wallet','create','--max-fee','5'),[2,'--max-fee is above 0 and at most 1 XMR.']);
 assert.deepEqual(run('wallet','inscribe','--file',file,'--network','stagenet','--reader','http://127.0.0.1:9'),[2,'On stagenet, give --domain <hex>: the domain of the ledger to inscribe on.']);
 assert.match(run('wallet','bogus')[1],/^xmr721 wallet <create \| receive/);
 // A dry run needs a wallet and no carrier tool; --help goes to the output and is no error.
 assert.deepEqual(run('wallet','inscribe','--file',file,'--dry-run'),[2,`There is no wallet in ${none}. Make one with: xmr721 wallet create`]);
 const help=spawnSync(process.execPath,[bin,'--help'],{encoding:'utf8'});assert.deepEqual([help.status,help.stdout.split('\n')[0],help.stderr],[0,'xmr721: inscribe on Monero from a wallet of your own (README.md, "Inscribe").','']);
 assert.ok(!/import |const /.test(help.stdout),'the help is the header of the file and nothing else');
 // A wallet folder whose wallet.json is damaged, or that has keys and no wallet.json, is told how to be put right.
 const odd=join(temp('wallet-'),'odd');mkdirSync(odd);writeFileSync(join(odd,'carrier.keys.json'),JSON.stringify({spend:scalar(),view:scalar()}));
 const at=(...args)=>{const r=spawnSync(process.execPath,[bin,...args,'--wallet',odd],{encoding:'utf8',timeout:20000});return [r.status,(r.stderr||r.stdout).split('\n')[0]];};
 assert.match(at('wallet','receive')[1],/has keys and no wallet.json.*xmr721 wallet restore --height/);
 writeFileSync(join(odd,'wallet.json'),'{"network":');assert.match(at('wallet','receive')[1],/wallet.json is not readable/);
 rmSync(join(odd,'wallet.json'));assert.deepEqual(at('wallet','restore','--height','x'),[2,'--height is a whole number.']);
 const done=at('wallet','restore','--height','3806000');assert.equal(done[0],0);assert.deepEqual(JSON.parse(readFileSync(join(odd,'wallet.json'),'utf8')),{network:'mainnet',start:3806000});
 assert.match(at('wallet','receive')[1],/^\{$/);});
