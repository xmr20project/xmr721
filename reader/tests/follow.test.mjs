// Offline tests of the follower (lib/follow.mjs) and of what a reader makes of the earlier XMR20 formats with it
// (lib/earlier.mjs): new deploy inscriptions of the listed deployers, and transfers of a saved collection's NFTs.
// A made-up node, made-up keys and made-up records; the last test reads the GENESIS files this repository ships.
//   node --test reader/tests/follow.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,appendFileSync,existsSync,mkdirSync,truncateSync,chmodSync} from 'node:fs';
import {createServer} from 'node:http';
import {deflateRawSync} from 'node:zlib';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {wallet,makeTx,ownerEntry,DOMAIN} from '../../rules/tests/helpers.mjs';
import {openReader} from '../lib/reader.mjs';
import {openFollower,blockExtras} from '../lib/follow.mjs';
import {picker,earlierTokens,collectionOwners,FINAL} from '../lib/earlier.mjs';
import {createService,startService} from '../service.mjs';
import {fakeChain} from './fake.mjs';
import {loadEarlier,signedText as deployText,canonical,MAGIC} from '../../xmr20-tokens/lib/earlier.mjs';
import {signedText as nftText,recordOf} from '../../xmr20-nfts/lib/format.mjs';
import {reduce,signedBy} from '../../xmr20-nfts/lib/ledger.mjs';
import {encodeMap} from '../../xmr20-nfts/lib/map-codec.mjs';
import {loadCollection,loadCollections} from '../../xmr20-nfts/lib/collection.mjs';
import {scanCollection} from '../../xmr20-nfts/tools/scan-collection.mjs';
import {build} from '../../xmr20-nfts/tools/build-collection.mjs';

const dirs=[];test.after(()=>{for(const d of dirs)rmSync(d,{recursive:true,force:true});});
const temp=name=>{const d=mkdtempSync(join(tmpdir(),name));dirs.push(d);return d;};
const sha=t=>createHash('sha256').update(t).digest('hex');
const START=300;
const w={holder:wallet('holder'),fee:wallet('fee'),launchpad:wallet('launchpad'),deployer:wallet('earlier deployer'),other:wallet('someone else'),artist:wallet('nft artist'),b:wallet('nft b'),c:wallet('nft c')};
const owners=[makeTx('reg0',[{to:w.holder,amount:10n**9n}])].map((t,i)=>({...ownerEntry(i,t),registrationHeight:50,ownerHeight:50}));
// A reader on a made-up chain, read up to its tip.
async function world(){const chain=fakeChain({start:START}),reader=openReader({dir:temp('follow-reader-'),chain,domain:DOMAIN,feeAddress:w.fee.address,owners,start:START,mintFrom:START});await reader.sync();return {chain,reader};}
// A transaction with a given extra field, as the made-up node holds it.
let n=0;const tx=extra=>({txid:sha('follow test tx '+n++),tx:{version:2,extra:[...extra],vout:[]}});
const varint=k=>k<128?[k]:[(k&127)|128,k>>7];
// An extra field holding a carrier: the transaction key, then the carrier in "XM2" fragments.
const extraOf=(carrier,size=240)=>{const parts=[];for(let i=0;i<carrier.length;i+=size)parts.push(carrier.subarray(i,i+size));
 const out=[1,...Array(32).fill(7)];parts.forEach((p,i)=>{const nonce=Buffer.concat([Buffer.from('XM2'),Buffer.from([i,parts.length]),p]);out.push(2,...varint(nonce.length),...nonce);});return Uint8Array.from(out);};

// Earlier deploy inscriptions.
const MINTS=['BGqUfSkAitpr6jErdEswXwYSXrf21gfCaBNh1h45HMBL','CkdaDUzBGW6dt7UkDnbD6dB5SMapyT2HQQSmfZsAtXMR','So11111111111111111111111111111111111111112','EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'],CREATOR='HcWMaxsLoSQpqNu1Rq4xTsdvPufMixcPfV8nN4Y8C42Y';
// `signer` signs for another address's record (a forgery) when given.
const deploy=({signer=null,...o}={},who=w.deployer)=>{const r={chain:'mainnet',creator:CREATOR,fee:'150',initial:'0',max:'1000000000000000',meta:'ab'.repeat(32),mint:MINTS[0],net:'mainnet',nonce:randomBytes(16).toString('hex'),op:'deploy',owner:who.address,p:'xmr20',tick:'TEST',v:2,...o};
 return {record:r,signature:(signer||who).sign(deployText(r))};};
const deployExtra=e=>extraOf(Buffer.from(MAGIC+canonical(e),'latin1'));
function listDir(entries,header={}){
 const dir=temp('follow-list-'),lines=entries.map(x=>JSON.stringify(x)+'\n').join('');writeFileSync(join(dir,'deploys.jsonl'),lines);
 writeFileSync(join(dir,'list.json'),JSON.stringify({format:'xmr20-earlier-deploys-v1',network:'mainnet',deployers:[w.deployer.address],from:100,to:START,count:entries.length,sha256:sha(lines),...header}));return dir;}
const line=(k,h,e)=>({txid:String(k).padStart(64,'0'),height:h,time:1790000000+h,text:canonical(e)});

// XMR20 NFT records.
const nftExtra=envelope=>extraOf(Buffer.concat([Buffer.from('XMR20T2'),deflateRawSync(Buffer.from(JSON.stringify(envelope)),{level:9})]),250);
const signed=(record,by)=>({record,signature:by.sign(nftText(record))});
const base=(op,by)=>({p:'xmr20',v:2,net:'mainnet',op,owner:by.address,nonce:randomBytes(16).toString('hex')});
const picture=()=>{const idx=Uint8Array.from({length:64},(_,i)=>(i*7+(i>>3))%4);return {codec:'json-text-1',width:8,height:8,palette:['000000','ff6600','ffffff','333333'],encoding:'range-base64',data:encodeMap(idx,8,8,4).toString('base64')};};
const mintOf=(by,collection,edition,to,max)=>signed({...base('nft_mint',by),collection_id:collection,edition,to:to.address,name:'Test '+edition,collection:'TEST',description:'',attributes:{editions:`${edition}/${max}`},image:picture()},by);
const move=(by,token,prev,to)=>signed({...base('nft_transfer',by),token,prev,to:to.address},by);
// A collection of `max` NFTs as its files: deployed and minted before block START, every NFT at w.b. `minted` below max leaves it open.
async function collectionFiles({max=2,minted=max,asOf}){
 const dir=temp('follow-collection-'),id=sha('collection'+n++),txs=[{txid:id,height:210,pos:0,extra:Buffer.from(nftExtra(signed({...base('nft_deploy',w.artist),name:'TEST',max,meta:'00'.repeat(32)},w.artist))).toString('hex')}];
 for(let e=1;e<=minted;e++)txs.push({txid:sha('mint'+n++),height:220+e,pos:0,extra:Buffer.from(nftExtra(mintOf(w.artist,id,e,w.b,max))).toString('hex')});
 const s=await reduce(txs.map(t=>({txid:t.txid,height:t.height,envelope:recordOf(Buffer.from(t.extra,'hex'))})));assert.equal(s.events.filter(e=>e.status!=='accepted').length,0);
 const items=s.tokens.map(t=>({edition:t.edition,id:t.id,mintedAt:t.history[0].height,name:t.mint.record.name,attributes:t.mint.record.attributes,codec:'json-text-1',width:8,height:8,art:t.art,owner:t.owner,last:t.last,transfers:0}));
 writeFileSync(join(dir,'test.json'),JSON.stringify({id,name:'TEST',max,meta:'00'.repeat(32),authority:w.artist.address,deployedAt:210,minted,format:'XMR20-NFT-V2',...(asOf?{ownersAsOf:asOf}:{})}));
 writeFileSync(join(dir,'test.jsonl'),items.map(t=>JSON.stringify(t)+'\n').join(''));writeFileSync(join(dir,'test-transactions.json'),JSON.stringify({collection:id,transactions:txs}));
 return {dir,id,items};}

// A node that can be made to fail for the follower alone.
const flaky=chain=>{const c={...chain,down:false,block:async h=>{if(c.down)throw Error('the node is down');return chain.block(h);},txs:async ids=>chain.txs(ids)};return c;};
const linesOf=file=>readFileSync(file,'utf8').split('\n').filter(Boolean);

test('a follower keeps the chosen transactions of the blocks the reader has read, in chain order, and only those',async()=>{
 const {chain,reader}=await world(),dir=temp('follower-'),pick=extra=>extra[0]===9?(extra[1]===0?(()=>{throw Error('bad');})():{kind:'x',n:extra[1]}):null;
 const A=tx([9,1]),plain=tx([1,...Array(32).fill(7)]),bad=tx([9,0]),none={txid:sha('no extra'),tx:{version:2,vout:[]}},B=tx([9,2]),C=tx([9,3]);
 chain.mine([A,plain,bad,none]);chain.mine();chain.mine([B,C]);
 // Opening writes nothing; nothing is read ahead of the reader.
 const fresh=join(temp('follower-'),'not made yet'),unused=openFollower({dir:fresh,chain,reader,pick,name:'t'});assert.equal(existsSync(fresh),false);void unused;
 const f=openFollower({dir,chain,reader,pick,name:'t'});
 assert.deepEqual(await f.run(),{height:START,added:0,complete:true});assert.equal(f.entries.length,0);
 await reader.sync();assert.equal(f.complete,false);
 assert.deepEqual(await f.run({budget:0}),{height:START,added:0,complete:false},'no time, no block');
 assert.deepEqual(await f.run(),{height:START+3,added:3,complete:true});
 assert.deepEqual(f.entries.map(e=>[e.height,e.txid,e.kind,e.n]),[[START+1,A.txid,'x',1],[START+3,B.txid,'x',2],[START+3,C.txid,'x',3]]);
 assert.deepEqual([f.entries[1].pos<f.entries[2].pos,f.entries[0].time,f.height,f.hash,f.complete],[true,(await chain.header(START+1)).time,START+3,reader.hash,true]);
 // The reader's own journal and checkpoint are those of a reader that has no follower.
 const alone=openReader({dir:temp('follow-reader-'),chain,domain:DOMAIN,feeAddress:w.fee.address,owners,start:START,mintFrom:START});await alone.sync();
 assert.deepEqual(reader.checkpoint(),alone.checkpoint());assert.equal(reader.journal.length,0);
 // A few blocks at a time gives the same.
 const slow=openFollower({dir:temp('follower-'),chain,reader,pick,name:'t'});
 assert.deepEqual(await slow.run({limit:1}),{height:START+1,added:1,complete:false});assert.deepEqual(await slow.run({limit:1}),{height:START+2,added:1,complete:false});
 await slow.run();assert.deepEqual(slow.entries,f.entries);
 // Opened again it goes on where it was and asks the node nothing. Bytes behind what covered.json names (a stop between
 // the two writes, a torn line) belong to nothing: they are not read, and are cut off before the next write.
 appendFileSync(join(dir,'found.jsonl'),JSON.stringify({height:START+3,pos:9,txid:'f'.repeat(64),kind:'x',n:9})+'\n{"torn');
 const calls=chain.calls,again=openFollower({dir,chain,reader,pick,name:'t'});
 assert.deepEqual(again.entries,f.entries);assert.deepEqual(await again.run(),{height:START+3,added:0,complete:true});assert.equal(chain.calls,calls);
 const D=tx([9,4]);chain.mine([D]);await reader.sync();await again.run();
 assert.deepEqual(linesOf(join(dir,'found.jsonl')).map(l=>JSON.parse(l).n),[1,2,3,4]);assert.deepEqual(openFollower({dir,chain,reader,pick,name:'t'}).entries,again.entries);
 // A folder made for another choice is not continued: it starts over and reads everything again.
 const anew=openFollower({dir,chain,reader,pick:extra=>extra[0]===9&&extra[1]===3?{kind:'y'}:null,name:'other'});
 assert.equal(anew.entries.length,0);await anew.run();assert.deepEqual(anew.entries.map(e=>[e.height,e.txid,e.kind]),[[START+3,C.txid,'y']]);assert.equal(linesOf(join(dir,'found.jsonl')).length,1);
 assert.throws(()=>openFollower({dir,chain,reader}),/pick function/);});

test('a damaged follower folder never stops anything: the follower starts over, and a failed write loses nothing',async()=>{
 const {chain,reader}=await world(),pick=extra=>extra[0]===9?{kind:'x',n:extra[1]}:null;
 chain.mine([tx([9,1])]);chain.mine([tx([9,2]),tx([9,3])]);chain.mine();await reader.sync();
 const good=openFollower({dir:temp('follower-'),chain,reader,pick,name:'t'});await good.run();const want=good.entries.map(e=>e.n);assert.deepEqual(want,[1,2,3]);
 // Each kind of damage: opening does not throw, the follower is at the start, and one pass reads everything again.
 const damage={
  'covered.json is not JSON':d=>writeFileSync(join(d,'covered.json'),'{"schema":'),
  'covered.json is empty':d=>writeFileSync(join(d,'covered.json'),''),
  'covered.json says null':d=>writeFileSync(join(d,'covered.json'),'null'),
  'remembered hashes of another shape':d=>{const c=JSON.parse(readFileSync(join(d,'covered.json'),'utf8'));c.recent=[{height:1}];writeFileSync(join(d,'covered.json'),JSON.stringify(c));},
  'found.jsonl is gone':d=>rmSync(join(d,'found.jsonl')),
  'found.jsonl is shorter than covered.json says':d=>truncateSync(join(d,'found.jsonl'),40),
  'a line that is no kept transaction':d=>{const f=join(d,'found.jsonl'),l=linesOf(f);l[1]='null'.padEnd(l[1].length,' ');writeFileSync(f,l.join('\n')+'\n');},
  'a line of a block above the covered one':d=>{const f=join(d,'found.jsonl'),l=linesOf(f);l[2]=l[2].replace('"height":'+(START+2),'"height":'+(START+9));writeFileSync(f,l.join('\n')+'\n');},
  'a kept line that was changed':d=>{const f=join(d,'found.jsonl'),l=linesOf(f);l[0]=l[0].replace('"n":1','"n":8');writeFileSync(f,l.join('\n')+'\n');},
  'covered.json edited to name fewer lines':d=>{const c=JSON.parse(readFileSync(join(d,'covered.json'),'utf8'));c.size=Buffer.byteLength(linesOf(join(d,'found.jsonl'))[0])+1;writeFileSync(join(d,'covered.json'),JSON.stringify(c));},
  'covered.json edited to another block':d=>{const c=JSON.parse(readFileSync(join(d,'covered.json'),'utf8'));c.height+=5;writeFileSync(join(d,'covered.json'),JSON.stringify(c));},
  'found.jsonl is a folder':d=>{rmSync(join(d,'found.jsonl'));mkdirSync(join(d,'found.jsonl'));}};
 for(const [what,harm] of Object.entries(damage)){
  const dir=temp('follower-'),made=openFollower({dir,chain,reader,pick,name:'t'});await made.run();harm(dir);
  const logs=[],f=openFollower({dir,chain,reader,pick,name:'t',log:v=>logs.push(v)});
  assert.deepEqual([f.entries.length,f.height,f.complete,logs.length>0],[0,START,false,true],what);
  if(what==='found.jsonl is a folder'){await assert.rejects(f.run(),undefined,what);continue;}
  await f.run();assert.deepEqual([f.entries.map(e=>e.n),f.complete],[want,true],what);
  assert.deepEqual(openFollower({dir,chain,reader,pick,name:'t'}).entries.map(e=>e.n),want,what);}
 // A folder that cannot be read at the moment is not damage: nothing is concluded, nothing is overwritten, and once it
 // can be read again the follower goes on without asking the node for anything.
 if(process.getuid?.()!==0){const dir=temp('follower-'),made=openFollower({dir,chain,reader,pick,name:'t'});await made.run();const before=readFileSync(join(dir,'found.jsonl'),'utf8');
  chmodSync(join(dir,'covered.json'),0o000);const f=openFollower({dir,chain,reader,pick,name:'t'});assert.equal(f.entries.length,0);await assert.rejects(f.run(),/cannot be read now/);await assert.rejects(f.run(),/cannot be read now/);
  chmodSync(join(dir,'covered.json'),0o644);const calls=chain.calls;assert.deepEqual(await f.run(),{height:START+3,added:0,complete:true});
  assert.deepEqual([f.entries.map(e=>e.n),chain.calls,readFileSync(join(dir,'found.jsonl'),'utf8')],[want,calls,before]);}
 // The folder's place is taken by a file: opening still does not throw, and each pass fails without harm.
 const taken=join(temp('follower-'),'x');writeFileSync(taken,'');const blocked=openFollower({dir:taken,chain,reader,pick,name:'t'});await assert.rejects(blocked.run());assert.equal(blocked.entries.length,0);
 // A write of covered.json that fails: the block is not counted, in memory or on disk, and is read again later.
 const dir=temp('follower-'),f=openFollower({dir,chain,reader,pick,name:'t'});await f.run({limit:1});assert.deepEqual(f.entries.map(e=>e.n),[1]);
 mkdirSync(join(dir,'covered.json.tmp'));const v=f.version;
 await assert.rejects(f.run());assert.deepEqual([f.entries.map(e=>e.n),f.height,f.version,f.complete],[[1],START+1,v,false]);
 assert.deepEqual(openFollower({dir,chain,reader,pick,name:'t'}).entries.map(e=>e.n),[1],'the two lines written for the uncounted block are not read');
 rmSync(join(dir,'covered.json.tmp'),{recursive:true});await f.run();
 assert.deepEqual([f.entries.map(e=>e.n),linesOf(join(dir,'found.jsonl')).map(l=>JSON.parse(l).n),f.complete],[want,want,true]);
 // The same when going back fails: nothing is forgotten until the smaller state is written.
 chain.pop(2);chain.mine([tx([9,7])]);chain.mine();chain.mine();await reader.sync();
 mkdirSync(join(dir,'covered.json.tmp'));await assert.rejects(f.run());assert.deepEqual(f.entries.map(e=>e.n),want);
 rmSync(join(dir,'covered.json.tmp'),{recursive:true});await f.run();assert.deepEqual([f.entries.map(e=>e.n),f.complete],[[1,7],true]);
 assert.deepEqual(openFollower({dir,chain,reader,pick,name:'t'}).entries.map(e=>e.n),[1,7]);});

test('when the chain is reorganised the follower goes back with the reader, however far',async()=>{
 const {chain,reader}=await world(),pick=extra=>extra[0]===9?{kind:'x',n:extra[1]}:null;
 const A=tx([9,1]),B=tx([9,2]),D=tx([9,4]),G=tx([9,5]);
 chain.mine([A]);chain.mine();chain.mine([B]);await reader.sync();
 const f=openFollower({dir:temp('follower-'),chain,reader,pick,name:'t'}),short=openFollower({dir:temp('follower-'),chain,reader,pick,name:'t',keep:1}),late=openFollower({dir:temp('follower-'),chain,reader,pick,name:'t'});
 await f.run();await short.run();const v=f.version;
 // The newest block is replaced: its transaction is gone, another one comes.
 chain.pop(1);chain.mine([D]);chain.mine();
 // Before the reader has seen it, the node's block is not the reader's: nothing of it is taken.
 assert.deepEqual(await late.run(),{height:START+2,added:2,complete:false});assert.deepEqual(late.entries.map(e=>e.n),[1]);
 assert.deepEqual(await f.run(),{height:START+3,added:0,complete:true});assert.deepEqual(f.entries.map(e=>e.n),[1,2]);
 await reader.sync();assert.equal(f.complete,false);
 for(const x of [f,short,late]){await x.run();assert.deepEqual(x.entries.map(e=>[e.height,e.n]),[[START+1,1],[START+3,4]]);assert.deepEqual([x.height,x.hash,x.complete],[START+4,reader.hash,true]);}
 assert.ok(f.version>v);
 // Deeper than the follower remembers block hashes for: back to the start block, and everything is read again.
 chain.pop(3);chain.mine([G]);chain.mine();chain.mine();chain.mine();await reader.sync();
 for(const x of [f,short]){await x.run();assert.deepEqual(x.entries.map(e=>[e.height,e.n]),[[START+1,1],[START+2,5]]);assert.equal(x.complete,true);}
 // The files say the same as a follower made now, and as each of these opened again.
 const fresh=openFollower({dir:temp('follower-'),chain,reader,pick,name:'t'});await fresh.run();assert.deepEqual(fresh.entries,f.entries);
 // A shorter chain: the reader is cut back below what was covered.
 chain.pop(2);await reader.sync();await f.run();assert.deepEqual([f.entries.map(e=>e.n),f.height,f.hash,f.complete],[[1,5],START+3,reader.hash,true]);
 // A node that does not have every transaction of a block in that block is not believed.
 await assert.rejects(blockExtras({block:async h=>({height:h,hash:'h',prev:'p',time:1,txids:['a']}),txs:async()=>new Map()},5),/did not give transaction/);});

test('the earlier tokens are read on: a new deploy of a listed deployer is the next token',async()=>{
 const {chain,reader}=await world(),hash=reader.meta.startHash,node=flaky(chain);
 const one=deploy({tick:'ONE'}),two=deploy({tick:'TWO',mint:MINTS[1]});
 const list=loadEarlier(listDir([line(1,110,one),line(2,150,two)],{toHash:hash})),apart=loadEarlier(listDir([line(1,110,one),line(2,150,two)],{to:200,toHash:hash})),fork=loadEarlier(listDir([line(1,110,one),line(2,150,two)],{toHash:'0'.repeat(64)}));
 const choice=picker({deployers:[w.deployer.address]}),follower=openFollower({dir:temp('follower-'),chain:node,reader,pick:choice.pick,name:choice.name});
 // The name says what is picked: other deployers or other NFTs are another name.
 assert.equal(choice.name,picker({deployers:[w.deployer.address]}).name);for(const o of [{},{deployers:[w.other.address]},{deployers:[w.deployer.address],nfts:['a'.repeat(64)]}])assert.notEqual(choice.name,picker(o).name);
 const view=earlierTokens({base:list,follower,reader});
 // Until the follower's first pass the view is the list, and says that it is not everything yet.
 assert.deepEqual([view.view.tokens.length,view.reach],[2,{from:100,to:START,following:true,complete:false}]);
 await follower.run();assert.deepEqual([view.view.tokens.length,view.reach],[2,{from:100,to:START,following:true,complete:true}]);
 // A new deploy by the listed deployer; one by someone else; one whose signature is another address's; a second deploy
 // for a mint that has its token; and in the next block one more new one.
 const three=deploy({tick:'THREE',mint:MINTS[2]}),stranger=deploy({tick:'FAKE',mint:MINTS[3]},w.other),forged=deploy({tick:'FORGED',mint:MINTS[3],signer:w.other}),twice=deploy({tick:'ONEB'}),four=deploy({tick:'FOUR',mint:MINTS[3],v:1,chain:'mainnet-beta',fee:'200'});
 const txs=[three,stranger,forged,twice].map(e=>tx(deployExtra(e)));chain.mine(txs);const last=tx(deployExtra(four));chain.mine([last]);await reader.sync();await follower.run();
 // Kept: the listed deployer's signed deploys. Not kept: a stranger's deploy, and one whose signature is not its owner's.
 assert.deepEqual(follower.entries.map(e=>[e.kind,e.txid]),[['deploy',txs[0].txid],['deploy',txs[3].txid],['deploy',last.txid]]);
 assert.equal(picker().pick(deployExtra(three)),null,'no deployers, no deploys');
 const v=view.view;
 assert.deepEqual(v.tokens.map(t=>[t.number,t.tick,t.mint,t.height,t.version]),[[1,'ONE',MINTS[0],110,2],[2,'TWO',MINTS[1],150,2],[3,'THREE',MINTS[2],START+1,2],[4,'FOUR',MINTS[3],START+2,1]]);
 assert.deepEqual([v.deploys.length,v.by.get(MINTS[2]).txid,v.by.get('4').tick,v.entry.get(txs[3].txid).record.tick,view.reach],[5,txs[0].txid,'FOUR','ONEB',{from:100,to:START+2,following:true,complete:true}]);
 assert.equal(view.view,v,'made once while nothing changes');
 // A list that does not end at the reader's start block, or ends there on another chain, is not continued.
 for(const b of [apart,fork]){const x=earlierTokens({base:b,follower,reader});assert.deepEqual([x.on(),x.view.tokens.length,x.reach.following,x.reach.to],[false,2,false,b.header.to]);}
 assert.deepEqual(earlierTokens({base:list,reader}).view.tokens.length,2);
 // The service: the list and the new tokens as one, and how far it reaches.
 const logs=[],service=createService({reader,owners,xmr20:{inscribers:[w.launchpad.address]},earlier:list,follower,log:x=>logs.push(x)}),get=async path=>{const r=await fetch(base+path);return {status:r.status,body:await r.json()};};
 const base='http://127.0.0.1:'+await service.listen(0);
 try{
  await service.ready;
  assert.deepEqual((await get('/info')).body.xmr20,{inscribers:[w.launchpad.address],earlier:{count:4,from:100,to:START+2,deployers:[w.deployer.address],following:{complete:true}}});
  const all=(await get('/xmr20/earlier')).body;
  assert.deepEqual([all.total,all.range,all.following,all.items.map(t=>t.tick)],[4,{from:100,to:START+2},{complete:true},['FOUR','THREE','TWO','ONE']]);
  const got=(await get('/xmr20/earlier/'+MINTS[3])).body;assert.deepEqual([got.token.number,got.record,got.text],[4,four.record,canonical(four)]);
  assert.equal((await get('/xmr20/tokens')).body.earlier,4);
  // A new block is read by the service's own step.
  const five=tx(deployExtra(deploy({tick:'FIVE',mint:'9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin'})));chain.mine([five]);
  const s=await service.step();assert.deepEqual([s.height,s.earlier],[START+3,{height:START+3,added:1,complete:true}]);assert.equal((await get('/xmr20/earlier')).body.total,5);
  chain.pop(1);chain.mine();const r=await service.step();assert.equal(r.reorg,1);assert.deepEqual((await get('/xmr20/earlier')).body.items.map(t=>t.tick),['FOUR','THREE','TWO','ONE']);
  // The follower's node fails: the step still syncs, the failure is logged, and the answer says it is not everything.
  chain.mine([tx(deployExtra(deploy({tick:'SIX',mint:'4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R'})))]);node.down=true;
  const bad=await service.step();assert.deepEqual([bad.height,bad.earlier,logs.some(x=>/node is down/.test(x.earlier||''))],[START+4,undefined,true]);
  const behind=(await get('/xmr20/earlier')).body;assert.deepEqual([behind.total,behind.range.to,behind.following],[4,START+3,{complete:false}]);
  node.down=false;await service.step();assert.deepEqual([(await get('/xmr20/earlier')).body.total,(await get('/xmr20/earlier')).body.following],[5,{complete:true}]);
 }finally{await service.close();}});

test('a saved collection is read on: a transfer changes the owner once it is 10 blocks deep',async()=>{
 const {chain,reader}=await world(),asOf={height:START,hash:reader.meta.startHash},node=flaky(chain);
 const c=await collectionFiles({max:2,asOf}),open=await collectionFiles({max:3,minted:2,asOf}),early=await collectionFiles({max:2,asOf:{height:START-5,hash:asOf.hash}});
 const collection=loadCollection(c.dir,'test'),[t1,t2]=c.items.map(t=>t.id);
 const choice=picker({nfts:c.items.map(t=>t.id)}),folder=temp('follower-'),follower=openFollower({dir:folder,chain:node,reader,pick:choice.pick,name:choice.name});
 const view=collectionOwners({collection,follower,reader});
 assert.equal(view.state,null);await follower.run();const s0=await view.refresh();
 assert.deepEqual([s0.tokens.size,s0.tokens.get(t1).owner,view.status],[2,w.b.address,{asOf,pending:0,complete:true}]);
 // Edition 1 is sent on by its owner. In the same block: a transfer of an NFT of another collection, a transfer by
 // someone who is not the owner, one whose signature is not its signer's, and a mint that names the collection.
 const sent=tx(nftExtra(move(w.b,t1,t1,w.c))),foreign=tx(nftExtra(move(w.b,'e'.repeat(64),'e'.repeat(64),w.c))),thief=tx(nftExtra(move(w.c,t2,t2,w.artist)));
 const forged=tx(nftExtra({record:move(w.b,t2,t2,w.c).record,signature:w.c.sign('something else')})),extraMint=tx(nftExtra(mintOf(w.artist,c.id,2,w.c,2)));
 chain.mine([sent,foreign,thief,forged,extraMint]);await reader.sync();await follower.run();
 // Kept: signed transfers that name one of the collection's NFTs. Whether the signer owns it is judged in the view.
 assert.deepEqual(follower.entries.map(e=>[e.kind,e.txid]),[['nft',sent.txid],['nft',thief.txid]]);
 // Not deep enough yet: the owner is who it was, and the view says that two transfers wait.
 let s=await view.refresh();assert.deepEqual([s.tokens.get(t1).owner,view.status],[w.b.address,{asOf:{height:START+1,hash:reader.hash},pending:2,complete:true}]);
 for(let i=0;i<FINAL-2;i++)chain.mine();await reader.sync();
 // The reader is ahead of the follower: the view is still the one of its own block, and says it is not the newest.
 assert.equal(view.status.complete,false);
 await follower.run({limit:3});s=await view.refresh();assert.deepEqual([s.tokens.get(t1).owner,view.status.asOf.height,view.status.pending,view.status.complete],[w.b.address,START+4,2,false]);
 await follower.run();s=await view.refresh();assert.deepEqual([s.tokens.get(t1).owner,view.status.pending],[w.b.address,2],'9 blocks deep');
 chain.mine();await reader.sync();await follower.run();s=await view.refresh();
 assert.deepEqual([s.tokens.get(t1).owner,s.tokens.get(t1).last,s.tokens.get(t1).history.length,s.tokens.get(t2).owner,view.status],[w.c.address,sent.txid,2,w.b.address,{asOf:{height:START+FINAL,hash:reader.hash},pending:0,complete:true}]);
 assert.deepEqual(s.events.slice(-2).map(e=>e.status==='accepted'?'ok':e.reason),['ok','Signer is not the owner']);
 // A transfer that was refused once it counted is not judged again while nothing kept is dropped; the owners stay.
 const again=await view.refresh();assert.deepEqual([again.events.some(e=>e.txid===thief.txid),again.events.length,again.tokens.get(t1).owner,again.tokens.get(t2).owner],[false,4,w.c.address,w.b.address]);
 // The service shows the collection with these owners from its start (what the follower's folder holds needs no step),
 // and one NFT with its moves.
 const logs=[],service=createService({reader,owners,collections:new Map([['test',collection],['open',loadCollection(open.dir,'test')],['early',loadCollection(early.dir,'test')]]),follower,log:x=>logs.push(x)}),get=async path=>{const r=await fetch(base+path);return {status:r.status,body:await r.json()};};
 const base='http://127.0.0.1:'+await service.listen(0);
 try{
  await service.ready;
  const all=(await get('/collections/test')).body;
  assert.deepEqual([all.collection.key,all.collection.ownersAsOf,all.collection.following,all.items.map(t=>[t.edition,t.owner,t.last,t.transfers])],['test',{height:START+FINAL,hash:reader.hash},{complete:true,pending:0},[[1,w.c.address,sent.txid,1],[2,w.b.address,t2,0]]]);
  const one=(await get('/collections/test/1')).body.item;assert.deepEqual([one.owner,one.moves],[w.c.address,[{txid:sent.txid,height:START+1,to:w.c.address}]]);
  assert.deepEqual((await get('/collections/test/2')).body.item.moves,[]);
  assert.deepEqual((await get('/collections')).body.collections.map(x=>[x.key,x.ownersAsOf.height,Boolean(x.following)]),[['test',START+FINAL,true],['open',START,false],['early',START-5,false]]);
  // A collection that can still be minted, or whose files end before the start block, is served as its files say.
  for(const key of ['open','early']){const x=(await get('/collections/'+key)).body;assert.deepEqual([x.collection.key,x.collection.following,x.items.every(t=>t.transfers===0)],[key,undefined,true]);assert.equal((await get(`/collections/${key}/1`)).body.item.moves,undefined);}
  assert.equal((await get('/collections/nothing')).status,404);assert.equal((await get('/collections/test/3')).status,404);
  // The follower's node fails while new blocks come: the owners shown are those of the last block read, and the answer
  // says that this is not the newest block.
  chain.mine();node.down=true;await service.step();
  const stale=(await get('/collections/test')).body;assert.deepEqual([stale.height,stale.collection.ownersAsOf.height,stale.collection.following],[START+FINAL+1,START+FINAL,{complete:false,pending:0}]);
  assert.ok(logs.some(x=>/node is down/.test(x.earlier||'')));node.down=false;await service.step();assert.equal((await get('/collections/test')).body.collection.following.complete,true);
  // In one block, in this order: the new owner sends it on; the next owner sends it on again; then a transfer signed
  // for a state that is no longer the latest, and one that uses its signer's nonce a second time.
  const m2=move(w.c,t1,sent.txid,w.artist),next=tx(nftExtra(m2)),m3=move(w.artist,t1,next.txid,w.b),then=tx(nftExtra(m3));
  const old=tx(nftExtra(move(w.b,t1,next.txid,w.c))),reused=tx(nftExtra(signed({...move(w.b,t1,then.txid,w.c).record,nonce:m3.record.nonce,owner:w.artist.address},w.artist)));
  chain.mine([next,then,old,reused]);for(let i=0;i<FINAL-1;i++)chain.mine();await service.step();
  const item=(await get('/collections/test/1')).body.item;assert.deepEqual([item.owner,item.last,item.transfers,item.moves.map(m=>m.to)],[w.b.address,then.txid,3,[w.c.address,w.artist.address,w.b.address]]);
  // Those blocks are replaced by others: the owners are again those the remaining transfers give.
  chain.pop(FINAL);for(let i=0;i<FINAL+1;i++)chain.mine();await service.step();
  const back=(await get('/collections/test')).body;assert.deepEqual([back.items.map(t=>[t.owner,t.transfers]),back.collection.ownersAsOf.height,back.collection.following],[[[w.c.address,1],[w.b.address,0]],START+2*FINAL+2,{complete:true,pending:0}]);
 }finally{await service.close();}
 // A service started on the same folder later (a restart) shows the same at once, without a step and with its node down.
 node.down=true;const later=createService({reader,owners,collections:new Map([['test',collection]]),follower:openFollower({dir:folder,chain:node,reader,pick:choice.pick,name:choice.name})}),at='http://127.0.0.1:'+await later.listen(0);
 try{await later.ready;const x=await (await fetch(at+'/collections/test')).json();
  assert.deepEqual([x.items.map(i=>[i.owner,i.transfers]),x.collection.ownersAsOf.height,x.collection.following],[[[w.c.address,1],[w.b.address,0]],START+2*FINAL+2,{complete:true,pending:0}]);
 }finally{await later.close();node.down=false;}
 // Without a follower, and for a collection whose transactions are not saved or do not read as records, there is nothing to continue.
 assert.equal(await collectionOwners({collection,reader}).refresh(),null);assert.equal(collectionOwners({collection:{...collection,transactions:undefined},follower,reader}).on(),false);
 assert.equal(collectionOwners({collection:{...collection,transactions:[{txid:'a'.repeat(64),height:5}]},follower,reader}).on(),false);});

test('the ownership rules with a cache, known pictures and checked signatures give what they give without',async()=>{
 const id='c0'.repeat(32),dep=signed({...base('nft_deploy',w.artist),name:'TEST',max:3,meta:'00'.repeat(32)},w.artist),m1=mintOf(w.artist,id,1,w.b,3),t=move(w.b,'a1'.repeat(32),'a1'.repeat(32),w.c);
 const entries=[{txid:id,height:10,envelope:dep},{txid:'a1'.repeat(32),height:11,envelope:m1},{txid:'b1'.repeat(32),height:12,envelope:t}];
 const plain=await reduce(entries),cache=new Map(),first=await reduce(entries,{cache}),second=await reduce(entries,{cache});
 assert.deepEqual(first,plain);assert.deepEqual(second,plain);assert.equal(plain.tokens[0].owner,w.c.address);assert.equal(signedBy(t),true);
 // What the cache holds for a transaction id is used only for the same record: another record under that id is judged anew.
 const forged={record:move(w.b,'a1'.repeat(32),'a1'.repeat(32),w.artist).record,signature:t.signature};
 const swapped=await reduce([entries[0],entries[1],{txid:'b1'.repeat(32),height:12,envelope:forged}],{cache});
 assert.deepEqual([swapped.events.at(-1).reason,swapped.tokens[0].owner],['Invalid address or spend-key signature',w.b.address]);assert.equal(signedBy(forged),false);
 // A signature the caller checked before is not checked again; one it did not list is.
 assert.equal((await reduce([entries[0],entries[1],{txid:'b9'.repeat(32),height:12,envelope:forged}],{verified:new Set(['b9'.repeat(32)])})).tokens[0].owner,w.artist.address);
 assert.equal((await reduce([entries[0],entries[1],{txid:'b9'.repeat(32),height:12,envelope:forged}],{verified:new Set(['b8'.repeat(32)])})).tokens[0].owner,w.b.address);
 // Such a claim is not remembered: with the same cache and no claim, the signature is checked.
 const c3=new Map(),claimed=[entries[0],entries[1],{txid:'b9'.repeat(32),height:12,envelope:forged}];
 assert.equal((await reduce(claimed,{verified:new Set(['b9'.repeat(32)]),cache:c3})).tokens[0].owner,w.artist.address);assert.equal((await reduce(claimed,{cache:c3})).tokens[0].owner,w.b.address);
 // A WebP mint: a picture judged before stands when there is no decoder, a decoder decides when there is one (also
 // with the same cache), and without either the mint cannot be judged, but only if it is valid in every other way.
 const riff=Buffer.concat([Buffer.from('RIFF'),Buffer.from([24,0,0,0]),Buffer.from('WEBP'),Buffer.alloc(20)]);
 const webpMint=(edition,by=w.artist)=>signed({...base('nft_mint',by),collection_id:id,edition,to:w.b.address,name:'W '+edition,collection:'TEST',description:'',attributes:{editions:`${edition}/3`},image:{codec:'json-text-webp-1',width:8,height:8,encoding:'base64',data:riff.toString('base64')}},by);
 const wm={txid:'a2'.repeat(32),height:13,envelope:webpMint(2)},yes=async()=>({width:8,height:8,pages:1,hasAlpha:false}),no=async()=>({width:9,height:8,pages:1,hasAlpha:false}),c2=new Map();
 const minted=r=>r.tokens.map(x=>x.edition);
 assert.deepEqual(minted(await reduce([...entries,wm],{known:new Map([[wm.txid,true]]),cache:c2})),[1,2]);
 assert.deepEqual(minted(await reduce([...entries,wm],{known:new Map([[wm.txid,true]]),webp:no,cache:c2})),[1],'the decoder decides, whatever was known');
 assert.deepEqual(minted(await reduce([...entries,wm],{known:new Map([[wm.txid,false]])})),[1]);assert.deepEqual(minted(await reduce([...entries,wm],{webp:yes})),[1,2]);
 await assert.rejects(reduce([...entries,wm]),/decoder is needed/);
 const taken={txid:'a3'.repeat(32),height:14,envelope:webpMint(1)},stranger={txid:'a4'.repeat(32),height:14,envelope:webpMint(3,w.other)};
 const r=await reduce([...entries,taken,stranger]);assert.deepEqual(r.events.slice(-2).map(e=>e.reason),['Edition out of range or already minted','Only the collection authority may mint']);});

test('the views take nothing in the follower\'s folder on trust, and odd collection files stop nothing',async()=>{
 const {chain,reader}=await world(),asOf={height:START,hash:reader.meta.startHash};
 const c=await collectionFiles({max:2,asOf}),collection=loadCollection(c.dir,'test'),[t1]=c.items.map(t=>t.id);
 const one=deploy({tick:'ONE'}),list=loadEarlier(listDir([line(1,110,one)],{toHash:asOf.hash}));
 // Lines no picker would have kept: a deploy and a transfer whose signatures are someone else's, a stranger's deploy,
 // a line of another kind, and bytes that are no record at all.
 const hexOf=x=>Buffer.from(x).toString('hex'),row=(k,kind,extra)=>({height:START+1,pos:k,txid:String(k).padStart(64,'e'),time:1,kind,extra});
 const lines=[row(1,'deploy',hexOf(deployExtra(deploy({tick:'FORGED',mint:MINTS[1],signer:w.other})))),row(2,'deploy',hexOf(deployExtra(deploy({tick:'FAKE',mint:MINTS[2]},w.other)))),
  row(3,'nft',hexOf(nftExtra({record:move(w.b,t1,t1,w.c).record,signature:w.c.sign('x')}))),row(4,'nft',hexOf(nftExtra(mintOf(w.artist,c.id,1,w.c,2)))),row(5,'other','00'),row(6,'nft','zz'),row(7,'deploy','0102')];
 const follower={entries:lines,version:1,epoch:0,height:START+20,hash:'f'.repeat(64),complete:true};
 const tokens=earlierTokens({base:list,follower,reader}),held=collectionOwners({collection,follower,reader});
 assert.deepEqual(tokens.view.tokens.map(x=>x.tick),['ONE']);
 const s=await held.refresh();assert.deepEqual([s.tokens.get(t1).owner,s.tokens.get(t1).history.length,s.pending],[w.b.address,1,0]);
 // A collection made from a scan that also found a mint of its authority with a picture that does not count: the
 // reader judges it as the files did, without a decoder.
 const id=sha('scan built'),riff=Buffer.concat([Buffer.from('RIFF'),Buffer.from([24,0,0,0]),Buffer.from('WEBP'),Buffer.alloc(20)]),hx=e=>Buffer.from(nftExtra(e)).toString('hex');
 const bad=signed({...base('nft_mint',w.artist),collection_id:id,edition:1,to:w.b.address,name:'W',collection:'TEST',description:'',attributes:{editions:'1/1'},image:{codec:'json-text-webp-1',width:8,height:8,encoding:'base64',data:riff.toString('base64')}},w.artist);
 const txs=[{txid:id,height:210,pos:0,extra:hx(signed({...base('nft_deploy',w.artist),name:'TEST',max:1,meta:'00'.repeat(32)},w.artist))},{txid:sha('bad mint'),height:211,pos:0,extra:hx(bad)},{txid:sha('good mint'),height:212,pos:0,extra:hx(mintOf(w.artist,id,1,w.b,1))}];
 const made=await build(txs,id,{allowRefused:true});assert.deepEqual([made.refused,made.items.map(x=>x.id)],[1,[txs[2].txid]]);
 const scanned={key:'s',header:{...made.collection,ownersAsOf:asOf},items:made.items,transactions:txs},view=collectionOwners({collection:scanned,follower:{entries:[],version:0,epoch:0,height:START,hash:asOf.hash,complete:true},reader});
 assert.equal(view.on(),true);const r=await view.refresh();assert.deepEqual([r.tokens.size,r.tokens.get(txs[2].txid).owner,r.events.map(e=>e.status)],[1,w.b.address,['accepted','refused','accepted']]);
 // Files whose last record is not 10 blocks deep at the start block name owners the format would not name there yet:
 // they are served as they are and not continued.
 const late=await collectionFiles({max:2,asOf}),l=loadCollection(late.dir,'test');l.transactions=l.transactions.map((x,i)=>i===2?{...x,height:START-3}:x);
 assert.equal(collectionOwners({collection:l,follower,reader}).on(),false);
 // Collection objects that are not what the loader gives: the service is made, steps and answers.
 const odd=new Map([['none',{key:'none',header:null,items:[null],transactions:[]}],['half',{key:'half',header:{id:'x'},items:[],transactions:[{}]}],['test',collection]]);
 const real=openFollower({dir:temp('follower-'),chain,reader,pick:picker({nfts:[t1]}).pick,name:'t'}),service=createService({reader,owners,collections:odd,follower:real});
 const at='http://127.0.0.1:'+await service.listen(0);
 try{await service.ready;chain.mine();const step=await service.step();assert.equal(step.height,START+1);
  const all=await (await fetch(at+'/collections')).json();assert.deepEqual(all.collections.map(x=>[x.key,Boolean(x.following)]),[['none',false],['half',false],['test',true]]);
 }finally{await service.close();}});

// A node over HTTP, as lib/chain.mjs asks it, answering from the made-up chain.
function nodeServer(chain){
 const head=b=>({height:b.height,hash:b.hash,prev_hash:b.prev,timestamp:b.time});
 const server=createServer(async(req,res)=>{let body='';for await(const part of req)body+=part;const q=JSON.parse(body||'{}'),p=q.params||{},send=v=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(v));};
  try{
   if(req.url==='/json_rpc'&&q.method==='get_info'){const i=await chain.info();return send({result:{height:i.height+1,top_block_hash:i.hash,nettype:'mainnet',offline:false}});}
   if(req.url==='/json_rpc'&&q.method==='get_block_header_by_height')return send({result:{block_header:head(await chain.header(p.height))}});
   if(req.url==='/json_rpc'&&q.method==='get_block'){const b=await chain.block(p.height);return send({result:{block_header:head(b),tx_hashes:b.txids,miner_tx_hash:b.minerTx}});}
   if(req.url==='/get_transactions'){const got=await chain.txs(q.txs_hashes);return send({status:'OK',txs:[...got.values()].map(x=>({tx_hash:x.txid,in_pool:x.inPool,block_height:x.height,as_json:JSON.stringify(x.tx)}))});}
   if(req.url==='/get_transaction_pool_hashes')return send({status:'OK',tx_hashes:await chain.pool()});
   send({error:{message:'not known'}});
  }catch(e){send({error:{message:String(e?.message||e)}});}});
 return new Promise(done=>server.listen(0,'127.0.0.1',()=>done({url:'http://127.0.0.1:'+server.address().port,close:()=>new Promise(r=>{server.closeAllConnections?.();server.close(()=>r());})})));}

test('a service started from its options reads the shipped files on, and starts whatever its follower folder holds',async()=>{
 const chain=fakeChain({start:START}),node=await nodeServer(chain),hash=(await chain.header(START)).hash,asOf={height:START,hash};
 const dir=temp('follow-service-'),ownersFile=join(dir,'owners.jsonl');writeFileSync(ownersFile,owners.map(o=>JSON.stringify(o)+'\n').join(''));
 const c=await collectionFiles({max:2,asOf}),[t1]=c.items.map(t=>t.id),one=deploy({tick:'ONE'}),listed=listDir([line(1,110,one)],{toHash:hash});
 const logs=[],options=state=>({owners:ownersFile,domain:DOMAIN,feeAddress:w.fee.address,node:node.url,start:START,mintFrom:START,state:join(dir,state),port:0,xmr20Earlier:listed,collections:c.dir,log:x=>logs.push(x)});
 const get=async(s,path)=>(await fetch(`http://127.0.0.1:${s.port}${path}`)).json();
 let s=await startService(options('a'));
 try{
  // Nothing is read on before the reader's first pass; then both files are continued, in a folder inside the state folder.
  assert.deepEqual((await get(s,'/info')).xmr20.earlier,{count:1,from:100,to:START,deployers:[w.deployer.address]});
  const sent=tx(nftExtra(move(w.b,t1,t1,w.c))),two=tx(deployExtra(deploy({tick:'TWO',mint:MINTS[1]}))),strange=tx(deployExtra(deploy({tick:'NO',mint:MINTS[2]},w.other)));
  chain.mine([sent,two,strange]);for(let i=0;i<FINAL-1;i++)chain.mine();await s.step();
  assert.deepEqual((await get(s,'/info')).xmr20.earlier,{count:2,from:100,to:START+FINAL,deployers:[w.deployer.address],following:{complete:true}});
  assert.deepEqual((await get(s,'/xmr20/earlier')).items.map(x=>x.tick),['TWO','ONE']);
  const col=await get(s,'/collections/test');assert.deepEqual([col.items[0].owner,col.collection.ownersAsOf.height,col.collection.following],[w.c.address,START+FINAL,{complete:true,pending:0}]);
  assert.deepEqual(linesOf(join(dir,'a','xmr20-earlier','found.jsonl')).map(x=>JSON.parse(x).kind),['nft','deploy']);
  await s.close();
  // Started again, it shows the same before any step.
  s=await startService(options('a'));assert.equal((await get(s,'/collections/test')).items[0].owner,w.c.address);assert.equal((await get(s,'/xmr20/earlier')).total,2);await s.close();
  // Told not to read on, it serves the files as they are and keeps no folder.
  s=await startService({...options('b'),xmr20Follow:false});await s.step();
  assert.deepEqual([(await get(s,'/info')).xmr20.earlier.following,(await get(s,'/xmr20/earlier')).total,(await get(s,'/collections/test')).items[0].owner,existsSync(join(dir,'b','xmr20-earlier'))],[undefined,1,w.b.address,false]);await s.close();
  // The folder's place taken by a file, and a folder left by something else: the service starts, syncs and serves.
  mkdirSync(join(dir,'c'));writeFileSync(join(dir,'c','xmr20-earlier'),'');s=await startService(options('c'));const step=await s.step();
  assert.deepEqual([step.height,(await get(s,'/xmr20/earlier')).total,(await get(s,'/xmr20/earlier')).following],[START+FINAL,1,{complete:false}]);await s.close();
  mkdirSync(join(dir,'d','xmr20-earlier'),{recursive:true});writeFileSync(join(dir,'d','xmr20-earlier','covered.json'),'{"schema":"other"}');writeFileSync(join(dir,'d','xmr20-earlier','found.jsonl'),'junk\n');
  s=await startService(options('d'));await s.step();assert.deepEqual([(await get(s,'/xmr20/earlier')).total,(await get(s,'/collections/test')).items[0].owner],[2,w.c.address]);
 }finally{await s.close().catch(()=>{});await node.close();}});

test('a scan of the blocks finds a collection\'s transactions: its deploy, its mints, the transfers of its NFTs',async()=>{
 const {chain}=await world(),id=sha('scan collection');
 // The deploy has to be the transaction the collection id names; here its made-up id is put in by hand.
 const d={txid:id,tx:{version:2,extra:[...nftExtra(signed({...base('nft_deploy',w.artist),name:'TEST',max:2,meta:'00'.repeat(32)},w.artist))],vout:[]}};
 const m1=tx(nftExtra(mintOf(w.artist,id,1,w.b,2))),other=tx(nftExtra(mintOf(w.artist,'d'.repeat(64),1,w.b,2))),plain=tx([1,...Array(32).fill(7)]),junk=tx(nftExtra(mintOf(w.other,id,2,w.other,2)));
 chain.mine([d]);chain.mine([m1,other,plain,junk]);
 // In one block: the second mint and a transfer of its NFT behind it; a transfer of the first NFT; a stray one.
 const m2=tx(nftExtra(mintOf(w.artist,id,2,w.b,2))),t2=tx(nftExtra(move(w.b,m2.txid,m2.txid,w.c))),t=tx(nftExtra(move(w.b,m1.txid,m1.txid,w.c))),stray=tx(nftExtra(move(w.b,other.txid,other.txid,w.c)));
 chain.mine([m2,t2,t,stray]);for(let i=0;i<8;i++)chain.mine();
 const read=h=>blockExtras(chain,h),found=await scanCollection(read,id,START+1,START+11);
 assert.deepEqual([found.collection,found.from,found.to,found.toHash,found.transactions.map(x=>[x.txid,x.height])],[id,START+1,START+11,(await chain.header(START+11)).hash,[[id,START+1],[m1.txid,START+2],[junk.txid,START+2],[m2.txid,START+3],[t2.txid,START+3],[t.txid,START+3]]]);
 assert.ok(found.transactions.every(x=>recordOf(Buffer.from(x.extra,'hex'))&&Number.isInteger(x.pos)));
 // The collection as the scan gives it: the stranger's mint is among the transactions and changes nothing.
 const made=await build(found.transactions,id,{allowRefused:true});
 assert.deepEqual([made.refused,made.collection.minted,made.items.map(x=>[x.edition,x.owner,x.transfers])],[1,2,[[1,w.c.address,1],[2,w.c.address,1]]]);await assert.rejects(build(found.transactions,id),/Refused/);
 // Blocks that do not follow one another are not one chain: the scan stops.
 await assert.rejects(scanCollection(async h=>h===START+5?{...(await read(h)),prev:'0'.repeat(64)}:read(h),id,START+1,START+11),/does not follow/);});

test('the GENESIS files this repository ships: complete to the XMR721 start block, and read on from there',async()=>{
 const dir=join(import.meta.dirname,'..','..','xmr20-nfts','collections'),g=loadCollections(dir).get('genesis'),h=g.header;
 // The owners are those at the ledger's start block, from a scan of every block since the first XMR20 block.
 assert.deepEqual([h.name,h.max,h.minted,h.ownersAsOf,h.scanned,g.transactions.length,g.items.length],['GENESIS',100,100,{height:3804029,hash:'cddee72e248e6fc903d7850f73e29cceff64dd9a027f64afc7362d76784081cd'},{from:3772610,to:3804029},101,100]);
 // The list of earlier deploys ends at the same block.
 const list=loadEarlier(join(import.meta.dirname,'..','..','xmr20-tokens','earlier'));assert.deepEqual([list.header.to,list.header.toHash],[h.ownersAsOf.height,h.ownersAsOf.hash]);
 // A reader that starts there continues them, and needs no picture decoder for it: every NFT is where the files say.
 const reader={meta:{start:3804029,startHash:h.ownersAsOf.hash,network:'mainnet'},height:3804029,blocks:[]},follower={entries:[],version:0,height:3804029,hash:h.ownersAsOf.hash,complete:true};
 const view=collectionOwners({collection:g,follower,reader});assert.equal(view.on(),true);
 const s=await view.refresh();assert.deepEqual([s.tokens.size,s.events.length,s.events.every(e=>e.status==='accepted'),view.status],[100,101,true,{asOf:h.ownersAsOf,pending:0,complete:true}]);
 for(const t of g.items){const x=s.tokens.get(t.id);assert.deepEqual([x.owner,x.last,x.art,x.edition],[t.owner,t.last,t.art,t.edition]);}
 assert.equal(earlierTokens({base:list,follower,reader}).on(),true);
 // The follower's choice for it: the listed deployer's deploys, signed transfers of these 100 NFTs, and nothing of any
 // other collection.
 const choice=picker({deployers:list.header.deployers,nfts:g.items.map(t=>t.id)});
 assert.equal(choice.pick(Buffer.from(g.transactions[1].extra,'hex')),null,'a mint is not a transfer');
 const sent=move(w.b,g.items[0].id,g.items[0].id,w.c),another='1c1367025a43be1948a695e254887d515062b27c03c2a3bcab048ea0ca7d7b20';
 assert.equal(choice.pick(nftExtra(sent))?.kind,'nft');assert.equal(choice.pick(nftExtra({record:sent.record,signature:w.c.sign('x')})),null,'a signature that is not the signer\'s');
 assert.equal(choice.pick(nftExtra(move(w.b,another,another,w.c))),null,'an NFT of another collection');assert.equal(choice.pick([1,...Array(32).fill(7)]),null);
 assert.equal(choice.pick(deployExtra(deploy({tick:'NEW'}))),null,'a deploy by someone who is not the listed deployer');
 assert.throws(()=>choice.pick([9,9,9]),/Unsupported extra field/);
 assert.ok(existsSync(join(dir,'genesis-txids.txt')));});
