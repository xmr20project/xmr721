// Offline tests of XMR20 tokens on an XMR721 ledger (FORMAT.md): the deploy text, and the token list a reader serves.
// A made-up node and made-up keys; nothing here is a real chain, wallet or token.
//   node --test xmr20-tokens/tests/tokens.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {wallet,makeTx,ownerEntry,DOMAIN} from '../../rules/tests/helpers.mjs';
import {openReader} from '../../reader/lib/reader.mjs';
import {createService} from '../../reader/service.mjs';
import {fakeChain,carried} from '../../reader/tests/fake.mjs';
import {deployText,readDeploy,checkDeploy,projectTokens,base58,TYPE_JSON,MAX_TEXT} from '../lib/token.mjs';

const enc=t=>new TextEncoder().encode(t);
const MINT='BGqUfSkAitpr6jErdEswXwYSXrf21gfCaBNh1h45HMBL',MINT2='So11111111111111111111111111111111111111112',MINT3='CkdaDUzBGW6dt7UkDnbD6dB5SMapyT2HQQSmfZsAtXMR';
const CURVE={tick:'TEST2',name:'Test Two',max:'1000000000',dec:'6',mode:'monero-curve',mint:MINT};
const dirs=[];test.after(()=>{for(const d of dirs)rmSync(d,{recursive:true,force:true});});

test('a deploy has one text: its fields in written order, and only that text is read',()=>{
 const text=deployText(CURVE);
 assert.equal(text,'{"p":"xmr20","op":"deploy","tick":"TEST2","name":"Test Two","max":"1000000000","dec":"6","mode":"monero-curve","mint":"'+MINT+'"}');
 assert.deepEqual(readDeploy(enc(text)),{p:'xmr20',op:'deploy',...CURVE});
 // The order the fields are given in does not matter; the text is the same.
 assert.equal(deployText({mint:MINT,mode:'monero-curve',dec:'6',max:'1000000000',name:'Test Two',tick:'TEST2'}),text);
 // Fields that may be left out, and the two a mode adds.
 assert.equal(deployText({tick:'A',max:'1',dec:'0',mode:'bonding-curve',pair:'wXMR'}),'{"p":"xmr20","op":"deploy","tick":"A","max":"1","dec":"0","mode":"bonding-curve","pair":"wXMR"}');
 assert.ok(readDeploy(enc(deployText({...CURVE,mode:'sweep-burn',pair:'wXMR',col:'ab'.repeat(32)}))));
 // Another spelling of the same fields is not read: spaces, another order, a field twice, a field nobody knows.
 const o=JSON.parse(text);
 for(const other of [JSON.stringify(o,null,1),' '+text,text+'\n',JSON.stringify({op:'deploy',p:'xmr20',...CURVE}),text.replace('"dec":"6"','"dec":"9","dec":"6"'),JSON.stringify({...o,note:'x'}),
  text.replace('TEST2','TEST\\u0032'),'['+text+']','"'+text+'"','null','',text.replace('xmr20','XMR20'),text.replace('deploy','mint')])
  assert.equal(readDeploy(enc(other)),null,other);
 assert.equal(readDeploy(Uint8Array.of(0xff,0xfe,0x7b,0x7d)),null);assert.equal(readDeploy(null),null);});

test('field limits',()=>{
 const bad=(change,why)=>assert.throws(()=>deployText({...CURVE,...change}),why,JSON.stringify(change));
 bad({tick:''},/tick/);bad({tick:' A'},/tick/);bad({tick:'A\n'},/tick/);bad({tick:'A\u202eB'},/tick/);bad({tick:'A\u200bB'},/tick/);bad({tick:'x'.repeat(33)},/tick/);bad({tick:7},/tick/);
 bad({name:''},/name/);bad({name:'x'.repeat(65)},/name/);bad({name:'a\u0007'},/name/);
 bad({max:'0'},/max/);bad({max:'01'},/max/);bad({max:1000},/max/);bad({max:'1.5'},/max/);bad({max:'1'.repeat(31)},/max/);bad({max:undefined},/max/);
 bad({dec:'19'},/dec/);bad({dec:6},/dec/);bad({dec:'06'},/dec/);bad({dec:undefined},/dec/);
 bad({mode:'Monero'},/mode/);bad({mode:'a--b'},/mode/);bad({mode:'-a'},/mode/);bad({mode:'x'.repeat(33)},/mode/);bad({mode:undefined},/mode/);
 bad({pair:'w XMR'},/pair/);bad({pair:''},/pair/);
 bad({mint:'0OIl'},/mint/);bad({mint:'abc'},/mint/);bad({mint:MINT+'1'},/mint/);bad({mint:MINT.slice(0,30)},/mint/);bad({mint:7},/mint/);
 bad({col:'AB'.repeat(32)},/col/);bad({col:'ab'.repeat(31)},/col/);
 assert.throws(()=>checkDeploy({...CURVE,p:'xmr20',op:'deploy',extra:'1'}),/Unknown field/);
 // Names in any script are fine; 32 and 64 are counted in characters.
 assert.ok(deployText({...CURVE,tick:'門羅'.repeat(16),name:'😀'.repeat(64)}));
 assert.throws(()=>deployText({...CURVE,name:'😀'.repeat(64),tick:'門'.repeat(32),pair:'x'.repeat(16),col:'ab'.repeat(32),max:'9'.repeat(30),mode:'m'.repeat(32)+''}),/at most/);
 assert.ok(MAX_TEXT<=759,'fits a mint record with or without a first owner');
 assert.equal(base58(MINT).length,32);assert.equal(base58('11111111111111111111111111111111').length,32);assert.equal(base58('l'),null);});

test('the tokens of a ledger: only an inscriber\'s deploy inscriptions, numbered for good, one per Solana mint',()=>{
 const text=(o={})=>()=>enc(deployText({...CURVE,...o})),none='0'.repeat(64);
 const nft=(id,o={})=>({id,creator:'launchpad',collection:none,type:TYPE_JSON,burned:false,owner:'launchpad',height:5,content:text(),...o});
 const list=nfts=>projectTokens(nfts,['launchpad']).map(t=>[t.number,t.id,t.tick]);
 assert.deepEqual(list([nft('a'),nft('b',{creator:'someone'}),nft('c',{content:text({tick:'B',mint:MINT2})}),nft('d',{type:5,content:text({mint:MINT3})}),nft('e',{collection:'ab'.repeat(32),content:text({mint:MINT3})}),
  nft('f',{content:()=>enc('{"p":"xmr20"}')}),nft('g',{content:text({tick:'G',mint:undefined})}),nft('h',{content:text({tick:'H',mint:undefined})})]),
  [[1,'a','TEST2'],[2,'c','B'],[3,'g','G'],[4,'h','H']]);
 // The same mint again: the earliest stands. Burning it gives the mint to the next one; numbers never move.
 const again=[nft('a'),nft('b',{content:text({tick:'COPY'})}),nft('c',{content:text({tick:'C',mint:MINT2})})];
 assert.deepEqual(list(again),[[1,'a','TEST2'],[3,'c','C']]);
 again[0].burned=true;assert.deepEqual(list(again),[[2,'b','COPY'],[3,'c','C']]);
 again[1].burned=true;assert.deepEqual(list(again),[[3,'c','C']]);
 // What a token carries: its fields, who inscribed it, and what the reader knows of the inscription. Not `p`, `op` or the bytes.
 const [t]=projectTokens([nft('a',{txid:'tx',time:9})],['launchpad']);
 assert.deepEqual(t,{number:1,tick:'TEST2',name:'Test Two',max:'1000000000',dec:'6',mode:'monero-curve',mint:MINT,inscriber:'launchpad',id:'a',owner:'launchpad',height:5,txid:'tx',time:9});
 assert.deepEqual(projectTokens([nft('a')],[]),[]);});

function world(){
 const w=Object.fromEntries(['launchpad','other','holder','fee'].map(n=>[n,wallet(n)]));
 const owners=[makeTx('reg0',[{to:w.holder,amount:10n**9n}])].map((t,i)=>({...ownerEntry(i,t),registrationHeight:50,ownerHeight:50}));
 const dir=mkdtempSync(join(tmpdir(),'xmr20-tokens-'));dirs.push(dir);
 const chain=fakeChain({start:100}),reader=openReader({dir:join(dir,'state'),chain,domain:DOMAIN,feeAddress:w.fee.address,owners,start:100,mintFrom:101});
 const L=()=>reader.ledger,signed=(p,who)=>L().sign(p.bodyBytes,who.sign(p.text)),block=async(...records)=>{chain.mine(records.map(r=>carried(r)));await reader.sync();};
 const deploy=(fields,who=w.launchpad,o={})=>{const p=L().prepareMint({creator:who.address,name:/^[\x21-\x7e]{1,64}$/.test(fields.tick)?fields.tick:'',type:TYPE_JSON,content:enc(deployText(fields)),...o});return {...p,record:signed(p,who)};};
 return {w,owners,chain,reader,L,signed,block,deploy};}

test('a reader lists the tokens its ledger holds, and serves each by id, number and mint',async()=>{
 const {w,owners,chain,reader,L,signed,block,deploy}=world();await reader.sync();
 const service=createService({reader,owners,xmr20:{inscribers:[w.launchpad.address]}}),plain=createService({reader,owners});
 const port=await service.listen(0),port2=await plain.listen(0),base='http://127.0.0.1:'+port;
 const get=async(path,b=base)=>{const r=await fetch(b+path);return {status:r.status,type:r.headers.get('content-type'),body:r.headers.get('content-type')?.startsWith('application/json')?await r.json():await r.text()};};
 try{
  assert.deepEqual((await get('/info')).body.xmr20,{inscribers:[w.launchpad.address]});
  assert.deepEqual((await get('/xmr20/tokens')).body,{height:100,total:0,from:0,inscribers:[w.launchpad.address],items:[]});
  const a=deploy(CURVE),copy=deploy({...CURVE,tick:'FAKE',mint:MINT3},w.other),b=deploy({tick:'ALPHA',max:'1000000000',dec:'6',mode:'bonding-curve',pair:'wXMR',mint:MINT2});
  await block(a.record,copy.record);                                   // 101
  await block(b.record);                                               // 102
  const all=(await get('/xmr20/tokens')).body;
  assert.deepEqual([all.height,all.total,all.items.map(t=>[t.number,t.tick,t.mode,t.height,t.confirmations])],[102,2,[[2,'ALPHA','bonding-curve',102,1],[1,'TEST2','monero-curve',101,2]]]);
  const first=all.items[1];
  assert.deepEqual(first,{number:1,tick:'TEST2',name:'Test Two',max:'1000000000',dec:'6',mode:'monero-curve',mint:MINT,inscriber:w.launchpad.address,id:a.id,inscription:1,owner:w.launchpad.address,height:101,time:1700000120,txid:first.txid,confirmations:2});
  assert.match(first.txid,/^[0-9a-f]{64}$/);
  // The inscription number counts every minted NFT after the Mordinals (here one, number 0): the copy took number 2.
  assert.deepEqual(all.items.map(t=>t.inscription),[3,1]);
  assert.deepEqual((await get('/xmr20/tokens?mode=bonding-curve')).body.items.map(t=>t.tick),['ALPHA']);
  assert.deepEqual((await get('/xmr20/tokens?from=1&limit=1')).body.items.map(t=>t.tick),['TEST2']);
  // One token, by its inscription id, its number or its Solana mint, with the record and the text to check it against.
  for(const key of [a.id,'1',MINT]){const one=(await get('/xmr20/token/'+key)).body;
   assert.deepEqual([one.token.id,one.token.tick,one.text,one.record],[a.id,'TEST2',deployText(CURVE),Buffer.from(a.record).toString('hex')]);}
  for(const key of [copy.id,'3','0',MINT3,'nothing'])assert.equal((await get('/xmr20/token/'+key)).status,404,key);
  // The inscription is an NFT like any other on the ledger; its bytes are served as JSON.
  const shown=await get('/nft/'+a.id+'/content');assert.deepEqual([shown.status,shown.type,shown.body],[200,'application/json; charset=utf-8',JSON.parse(deployText(CURVE))]);
  assert.equal((await get('/nft/'+copy.id)).body.nft.creator,w.other.address);
  // JSON-typed bytes that are not JSON are not served.
  const junk=L().prepareMint({creator:w.other.address,type:TYPE_JSON,content:enc('<script>alert(1)</script>')});await block(signed(junk,w.other));   // 103
  assert.equal((await get('/nft/'+junk.id+'/content')).status,415);
  // The inscriber burns a token's inscription: it leaves the list, its number is not used again, and its mint can be inscribed anew.
  await block(signed(L().prepareBurn({nft:a.id,owner:w.launchpad.address}),w.launchpad));         // 104
  assert.deepEqual((await get('/xmr20/tokens')).body.items.map(t=>t.number),[2]);assert.equal((await get('/xmr20/token/'+MINT)).status,404);
  const anew=deploy({...CURVE,name:'Test Two, again'});await block(anew.record);                   // 105
  assert.deepEqual((await get('/xmr20/tokens')).body.items.map(t=>[t.number,t.name??null]),[[3,'Test Two, again'],[2,null]]);
  assert.equal((await get('/xmr20/token/'+MINT)).body.token.id,anew.id);
  // A token moved to another owner is still the inscriber's token.
  await block(signed(L().prepareMove({mordinal:anew.id,from:w.launchpad.address,to:w.holder.address}),w.launchpad));   // 106
  assert.deepEqual((({owner,inscriber})=>[owner,inscriber])((await get('/xmr20/token/3')).body.token),[w.holder.address,w.launchpad.address]);
  // A replaced block takes its tokens with it.
  chain.pop(2);chain.mine();chain.mine();chain.mine();await reader.sync();
  assert.deepEqual((await get('/xmr20/tokens')).body.items.map(t=>t.number),[2]);
  // A reader that was not given inscribers has no token routes.
  assert.equal((await get('/xmr20/tokens','http://127.0.0.1:'+port2)).status,404);assert.equal((await get('/info','http://127.0.0.1:'+port2)).body.xmr20,undefined);
 }finally{await service.close();await plain.close();}});

test('found by review: a byte order mark is not ignored, and the hidden characters are a fixed list',()=>{
 const text=deployText(CURVE),bytes=enc(text),cp=String.fromCodePoint;
 assert.equal(readDeploy(Uint8Array.of(0xef,0xbb,0xbf,...bytes)),null);assert.ok(readDeploy(bytes));
 // Each of these does not show, or changes how the text around it shows: none may be in a ticker or a name.
 for(const c of [0x00,0x1f,0x7f,0x9f,0xa0,0xad,0x34f,0x600,0x61c,0x6dd,0x70f,0x890,0x8e2,0x115f,0x1160,0x1680,0x17b4,0x180b,0x180e,0x2000,0x200b,0x200c,0x200d,0x200e,0x2028,0x202e,0x202f,0x205f,0x2060,0x2066,0x206f,0x2800,0x3000,0x3164,
  0xe000,0xf8ff,0xfdd0,0xfe00,0xfe0f,0xfeff,0xffa0,0xfff9,0xfffd,0xffff,0x110bd,0x110cd,0x13430,0x1bca0,0x1d173,0xe0001,0xe0041,0xe0100,0xf0000,0x10ffff]){
  assert.throws(()=>deployText({...CURVE,tick:'A'+cp(c)+'B'}),/tick/,'U+'+c.toString(16));assert.throws(()=>deployText({...CURVE,name:'A'+cp(c)+'B'}),/name/,'U+'+c.toString(16));}
 // What shows is taken, in any script; a single space inside is fine; a lone surrogate half is not text.
 for(const good of ['A B','é','ß','Ω','門羅','모네로','монеро','😀','a-b_c.d',"it's"])assert.ok(deployText({...CURVE,tick:good,name:good}),good);
 assert.throws(()=>deployText({...CURVE,name:'a'+String.fromCharCode(0xd83d)}),/name/);
 // The limits the document states: 30 digits, 32 characters.
 assert.ok(deployText({...CURVE,max:'9'.repeat(30),mode:'a'.repeat(32)}));assert.throws(()=>deployText({...CURVE,max:'9'.repeat(31)}),/max/);assert.throws(()=>deployText({...CURVE,mode:'a'.repeat(33)}),/mode/);
 assert.ok(deployText({...CURVE,mode:'v2-curve-9'}));});

test('found by the outside review: only its inscriber\'s burn takes a token back; a later owner\'s burn ends the NFT, not the token',async()=>{
 const {w,owners,reader,L,signed,block,deploy}=world();await reader.sync();
 const service=createService({reader,owners,xmr20:{inscribers:[w.launchpad.address]}}),port=await service.listen(0),base='http://127.0.0.1:'+port,get=async path=>(await (await fetch(base+path)).json());
 try{
  const kept=deploy(CURVE),given=deploy({...CURVE,tick:'GIVEN',mint:MINT2});await block(kept.record,given.record);
  // The inscriber gives one inscription away; its new owner burns it. The token stays, marked as burned.
  await block(signed(L().prepareMove({mordinal:given.id,from:w.launchpad.address,to:w.holder.address}),w.launchpad));
  await block(signed(L().prepareBurn({nft:given.id,owner:w.holder.address}),w.holder));
  assert.equal(L().nft(given.id).burned,true);
  assert.deepEqual((await get('/xmr20/tokens')).items.map(t=>[t.tick,t.burned??false,t.owner]),[['GIVEN',true,null],['TEST2',false,w.launchpad.address]]);
  assert.equal((await get('/xmr20/token/'+MINT2)).token.id,given.id);
  // Its mint stays taken: a second inscription for it is not a token.
  const again=deploy({...CURVE,tick:'GIVEN2',mint:MINT2});await block(again.record);
  assert.deepEqual((await get('/xmr20/deploys/'+MINT2)).deploys.map(d=>[d.tick,d.listed,d.burned??false]),[['GIVEN',true,true],['GIVEN2',false,false]]);
  // The inscriber burns the one it kept: that token is withdrawn.
  await block(signed(L().prepareBurn({nft:kept.id,owner:w.launchpad.address}),w.launchpad));
  assert.deepEqual((await get('/xmr20/tokens')).items.map(t=>t.tick),['GIVEN']);
  assert.deepEqual((await get('/xmr20/deploys/'+MINT)).deploys.map(d=>[d.listed,d.burned,d.number,typeof d.record]),[[false,true,1,'string']]);
  assert.deepEqual((await get('/xmr20/deploys/'+MINT3)).deploys,[]);
 }finally{await service.close();}});
