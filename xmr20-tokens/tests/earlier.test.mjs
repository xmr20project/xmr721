// Offline tests of the earlier XMR20 deploy inscriptions (EARLIER.md): reading one out of an extra field, the list a
// reader loads, the routes, and the list this repository ships. Made-up keys for the made-up cases; the shipped list is
// real chain data and is checked as a reader checks it.
//   node --test xmr20-tokens/tests/earlier.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {wallet,makeTx,ownerEntry,DOMAIN} from '../../rules/tests/helpers.mjs';
import {openReader} from '../../reader/lib/reader.mjs';
import {createService} from '../../reader/service.mjs';
import {fakeChain} from '../../reader/tests/fake.mjs';
import {readEarlier,openCarrier,loadEarlier,signedText,canonical,checkRecord,tokenOf,DOMAINS,MAGIC} from '../lib/earlier.mjs';

const dirs=[];test.after(()=>{for(const d of dirs)rmSync(d,{recursive:true,force:true});});
const MINT='BGqUfSkAitpr6jErdEswXwYSXrf21gfCaBNh1h45HMBL',MINT2='CkdaDUzBGW6dt7UkDnbD6dB5SMapyT2HQQSmfZsAtXMR',CREATOR='HcWMaxsLoSQpqNu1Rq4xTsdvPufMixcPfV8nN4Y8C42Y';
const deployer=wallet('earlier deployer'),other=wallet('someone else');
const record=(o={})=>({chain:'mainnet',creator:CREATOR,fee:'150',initial:'0',max:'1000000000000000',meta:'ab'.repeat(32),mint:MINT,net:'mainnet',nonce:'0123456789abcdef0123456789abcdef',op:'deploy',owner:deployer.address,p:'xmr20',tick:'TEST',v:2,...o});
const envelope=(r,who=deployer)=>({record:r,signature:who.sign(signedText(r))});
const text=e=>canonical(e);
// A transaction's extra field holding a carrier: the transaction key, then the carrier in "XM2" fragments.
const varint=n=>n<128?[n]:[(n&127)|128,n>>7];
const extraOf=(carrier,size=240)=>{const parts=[];for(let i=0;i<carrier.length;i+=size)parts.push(carrier.subarray(i,i+size));
 const out=[1,...Array(32).fill(7)];parts.forEach((p,i)=>{const nonce=Buffer.concat([Buffer.from('XM2'),Buffer.from([i,parts.length]),p]);out.push(2,...varint(nonce.length),...nonce);});return Uint8Array.from(out);};
const carrierOf=e=>Buffer.from(MAGIC+(typeof e==='string'?e:text(e)),'latin1');

test('an earlier deploy is read out of an extra field: both versions, each signed over its own first line',()=>{
 for(const r of [record(),record({v:1,chain:'mainnet-beta',fee:'200'})]){
  const e=envelope(r),got=readEarlier(extraOf(carrierOf(e)));
  assert.deepEqual(got,{record:r,signature:e.signature,text:text(e)});
  assert.equal(signedText(r),DOMAINS[r.v]+canonical(r));
  // The same record signed over the other version's line is not an inscription.
  const wrong={record:r,signature:deployer.sign(DOMAINS[r.v===1?2:1]+canonical(r))};assert.equal(readEarlier(extraOf(carrierOf(wrong))),null);}
 // Another wallet's payment id next to the fragments does not matter; a transaction without fragments holds nothing.
 const e=envelope(record()),withId=Uint8Array.from([...extraOf(carrierOf(e)),2,9,1,...Array(8).fill(3)]);
 assert.ok(readEarlier(withId));assert.equal(readEarlier(Uint8Array.from([1,...Array(32).fill(7)])),null);assert.equal(readEarlier(Uint8Array.from([9,9,9])),null);});

test('what is not an earlier deploy',()=>{
 const good=envelope(record()),no=(carrier,why)=>assert.throws(()=>openCarrier(carrier),why);
 // Written another way: spaces, another key order, a field twice, a field too many, not ASCII.
 const t=text(good);
 no(carrierOf(JSON.stringify(good,null,1)),/plain ASCII/);no(carrierOf(t.replace('"record":','"record": ')),/one way/);no(carrierOf(JSON.stringify({signature:good.signature,record:good.record})),/one way/);
 no(carrierOf(t.replace('"v":2','"v":2,"v":2')),/one way/);no(carrierOf(text({...good,note:'x'})),/Not a record with its signature/);
 no(Buffer.concat([Buffer.from(MAGIC),Buffer.from(t.replace('TEST','TÉST'),'utf8')]),/plain ASCII/);
 no(Buffer.from('XMR20T2'+t,'latin1'),/Not an earlier/);no(Buffer.from(MAGIC+t+' '.repeat(800),'latin1'),/Not an earlier/);
 // Signed by someone else than the record's owner; a signature that is damaged.
 no(carrierOf({record:good.record,signature:other.sign(signedText(good.record))}),/not the owner/);no(carrierOf({record:good.record,signature:good.signature.slice(0,-2)+'11'}),/not the owner|damaged/);
 // Fields.
 const bad=(o,why)=>assert.throws(()=>checkRecord(record(o)),why,JSON.stringify(o));
 bad({p:'xmr21'},/Not an XMR20/);bad({v:3},/Not an XMR20/);bad({net:'stagenet'},/Not an XMR20/);bad({op:'mint'},/Not an XMR20/);bad({owner:'4abc'},/owner/);
 bad({tick:'test'},/tick/);bad({tick:'1A'},/tick/);bad({tick:'ABCDEFGHIJK'},/tick/);bad({chain:'mainnet-beta'},/chain/);bad({v:1},/chain/);
 bad({max:'1000'},/fixed supply/);bad({initial:'1'},/fixed supply/);bad({fee:'100'},/fixed supply/);bad({nonce:'xyz'},/hex/);bad({meta:'ab'},/hex/);bad({mint:'0OIl'},/mint/);bad({creator:''},/creator/);
 assert.throws(()=>checkRecord({...record(),extra:1}),/Not a deploy record/);const {fee,...less}=record();assert.throws(()=>checkRecord(less),/Not a deploy record/);});

function listDir(entries,header={}){
 const dir=mkdtempSync(join(tmpdir(),'xmr20-earlier-'));dirs.push(dir);
 const lines=entries.map(x=>JSON.stringify(x)+'\n').join('');writeFileSync(join(dir,'deploys.jsonl'),lines);
 writeFileSync(join(dir,'list.json'),JSON.stringify({format:'xmr20-earlier-deploys-v1',network:'mainnet',deployers:[deployer.address],from:100,to:200,count:entries.length,sha256:createHash('sha256').update(lines).digest('hex'),...header}));
 return dir;}
const line=(n,h,r,who)=>({txid:String(n).padStart(64,'0'),height:h,time:1790000000+h,text:text(envelope(r,who))});

test('the list a reader loads: every line checked again, tokens numbered in chain order, one token per Solana mint',()=>{
 const a=record({tick:'ONE'}),b=record({tick:'TWO',mint:MINT2,v:1,chain:'mainnet-beta'}),again=record({tick:'ONEB',nonce:'f'.repeat(32)});
 const list=loadEarlier(listDir([line(1,110,a),line(2,110,b),line(3,150,again)]));
 assert.deepEqual(list.deploys.map(d=>[d.txid.slice(-1),d.height,d.record.tick]),[['1',110,'ONE'],['2',110,'TWO'],['3',150,'ONEB']]);
 assert.deepEqual(list.tokens,[
  {earlier:true,number:1,tick:'ONE',max:'1000000000',dec:'6',mode:'bonding-curve',mint:MINT,creator:CREATOR,deployer:deployer.address,version:2,txid:'0'.repeat(63)+'1',height:110,time:1790000110},
  {earlier:true,number:2,tick:'TWO',max:'1000000000',dec:'6',mode:'bonding-curve',mint:MINT2,creator:CREATOR,deployer:deployer.address,version:1,txid:'0'.repeat(63)+'2',height:110,time:1790000110}]);
 assert.deepEqual(tokenOf(list.deploys[2],9).tick,'ONEB');
 // A list that does not check does not load.
 const fails=(entries,why,header)=>assert.throws(()=>loadEarlier(listDir(entries,header)),why);
 fails([line(1,110,a,other)],/not the owner/);                                                     // a signature that is not the record's owner's
 fails([line(1,110,record({owner:other.address}),other)],/not a listed deployer/);                 // a valid deploy by an address that is not listed
 fails([{...line(1,110,a),text:text(envelope(a)).replace('ONE','TWO')}],/not the owner/);         // a changed text
 fails([line(2,150,a),line(1,110,b)],/out of order/);fails([line(1,110,a),line(1,110,a)],/out of order or twice/);
 fails([line(1,99,a)],/malformed/);fails([line(1,201,a)],/malformed/);fails([line(1,110,a)],/another number of entries/,{count:2});
 fails([line(1,110,a)],/Not a list/,{format:'other'});fails([line(1,110,a)],/Not a list/,{deployers:[]});});

test('a reader serves the earlier tokens, and says in /info and /xmr20/tokens that it has them',async()=>{
 const w={holder:wallet('holder'),fee:wallet('fee'),launchpad:wallet('launchpad')};
 const owners=[makeTx('reg0',[{to:w.holder,amount:10n**9n}])].map((t,i)=>({...ownerEntry(i,t),registrationHeight:50,ownerHeight:50}));
 const dir=mkdtempSync(join(tmpdir(),'xmr20-earlier-reader-'));dirs.push(dir);
 const reader=openReader({dir,chain:fakeChain({start:300}),domain:DOMAIN,feeAddress:w.fee.address,owners,start:300,mintFrom:300});await reader.sync();
 const a=record({tick:'ONE'}),b=record({tick:'TWO',mint:MINT2}),earlier=loadEarlier(listDir([line(1,110,a),line(2,150,b)]));
 const service=createService({reader,owners,xmr20:{inscribers:[w.launchpad.address]},earlier}),plain=createService({reader,owners,xmr20:{inscribers:[w.launchpad.address]}}),only=createService({reader,owners,earlier});
 const base='http://127.0.0.1:'+await service.listen(0),base2='http://127.0.0.1:'+await plain.listen(0),base3='http://127.0.0.1:'+await only.listen(0);
 const get=async(path,from=base)=>{const r=await fetch(from+path);return {status:r.status,body:await r.json()};};
 try{
  assert.deepEqual((await get('/info')).body.xmr20,{inscribers:[w.launchpad.address],earlier:{count:2,from:100,to:200,deployers:[deployer.address]}});
  const all=(await get('/xmr20/earlier')).body;
  assert.deepEqual([all.total,all.from,all.range,all.deployers,all.items.map(t=>[t.number,t.tick,t.earlier,t.mint])],[2,0,{from:100,to:200},[deployer.address],[[2,'TWO',true,MINT2],[1,'ONE',true,MINT]]]);
  assert.deepEqual((await get('/xmr20/earlier?from=1&limit=1')).body.items.map(t=>t.tick),['ONE']);
  for(const key of ['0'.repeat(63)+'1',MINT,'1']){const one=(await get('/xmr20/earlier/'+key)).body;
   assert.deepEqual([one.token.tick,one.record,one.text],['ONE',a,text({record:a,signature:one.signature})]);assert.ok(readEarlier(extraOf(carrierOf(one.text))));}
  for(const key of ['3','0','nothing','f'.repeat(64)])assert.equal((await get('/xmr20/earlier/'+key)).status,404,key);
  assert.equal((await get('/xmr20/tokens')).body.earlier,2);
  // Without a list there are no such routes and nothing is said; a reader with the list and no inscribers serves the list.
  assert.equal((await get('/xmr20/earlier',base2)).status,404);assert.deepEqual((await get('/info',base2)).body.xmr20,{inscribers:[w.launchpad.address]});assert.equal((await get('/xmr20/tokens',base2)).body.earlier,undefined);
  assert.equal((await get('/xmr20/earlier',base3)).body.total,2);assert.equal((await get('/xmr20/tokens',base3)).status,404);assert.deepEqual(Object.keys((await get('/info',base3)).body.xmr20),['earlier']);
 }finally{await service.close();await plain.close();await only.close();}});

const SHIPPED=join(import.meta.dirname,'..','earlier');
test('the shipped list checks: every inscription is the deployer\'s, in order, and its file is the one its header names',{skip:!existsSync(join(SHIPPED,'list.json'))},()=>{
 const list=loadEarlier(SHIPPED),raw=readFileSync(join(SHIPPED,'deploys.jsonl'),'utf8');
 assert.equal(createHash('sha256').update(raw).digest('hex'),list.header.sha256);
 assert.deepEqual([list.header.from,list.header.to,list.header.network,list.header.deployers],[3772610,3804029,'mainnet',['4AMg1kDaXkWckE3uyd1YqoBKvn4z8ATxmWQVdtjF6aGU4sT278XoyhUV1Ve88ZMCXNXQJpjW2553NWERfMZcNsBtCkMLiNM']]);
 assert.ok(list.deploys.length>=77&&list.tokens.length>=70&&list.tokens.length<=list.deploys.length);
 assert.equal(new Set(list.tokens.map(t=>t.mint)).size,list.tokens.length);assert.deepEqual(list.tokens.map(t=>t.number),list.tokens.map((_,i)=>i+1));
 assert.ok(list.deploys.every((d,i)=>i===0||d.height>=list.deploys[i-1].height));
 assert.ok(list.tokens.some(t=>t.tick==='RICKROLL'&&t.mint==='CkdaDUzBGW6dt7UkDnbD6dB5SMapyT2HQQSmfZsAtXMR'&&t.height===3799968));});
