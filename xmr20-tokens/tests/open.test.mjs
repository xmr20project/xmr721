// Offline tests of open XMR20 tokens (OPEN.md, draft): the open deploy text, which mint records are open deploys, and
// the shared test cases other implementations replay (open-fixtures.json). Made-up keys; nothing here is a real wallet.
//   node --test xmr20-tokens/tests/open.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {decodeRecord,renderText,recordId,matchSignature,signerOf,OP} from '../../rules/lib/records.mjs';
import {unhex,hex} from '../../rules/lib/monero.mjs';
import {readDeploy,projectTokens} from '../lib/token.mjs';
import {openDeployText,readOpenDeploy,checkOpenDeploy,openDeployOf,openDeployIn,projectOpen,tickerField,tokenLabel,MAX_WHOLE} from '../lib/open.mjs';

const enc=t=>new TextEncoder().encode(t);
const here=p=>fileURLToPath(new URL(p,import.meta.url));
const FIX=JSON.parse(readFileSync(here('./open-fixtures.json'),'utf8'));

test('an open deploy has one text, and only that text is read',()=>{
 const text=openDeployText({tick:'PEPE',max:'21000000',lim:'1000'});
 assert.equal(text,'{"p":"xmr20","op":"deploy","tick":"PEPE","max":"21000000","dec":"6","mode":"open","lim":"1000"}');
 assert.deepEqual(readOpenDeploy(enc(text)),{p:'xmr20',op:'deploy',tick:'PEPE',max:'21000000',dec:'6',mode:'open',lim:'1000'});
 assert.equal(openDeployText({pre:'5',lim:'1',max:'10',name:'N',tick:'T',col:'ab'.repeat(32)}),'{"p":"xmr20","op":"deploy","tick":"T","name":"N","max":"10","dec":"6","mode":"open","col":"'+'ab'.repeat(32)+'","lim":"1","pre":"5"}');
 assert.equal(openDeployText({tick:'ALL',max:'10',pre:'10'}),'{"p":"xmr20","op":"deploy","tick":"ALL","max":"10","dec":"6","mode":"open","pre":"10"}');
 assert.ok(openDeployText({tick:'BIG',max:String(MAX_WHOLE),lim:'1'}));
 for(const bad of [{tick:'A',max:'10'},{tick:'A',max:'10',lim:'1',pre:'10'},{tick:'A',max:'10',lim:'11'},{tick:'A',max:'10',lim:'1',pre:'11'},{tick:'A',max:'10',lim:'1',pre:'0'},
  {tick:'A',max:'10',lim:'0'},{tick:'A',max:String(MAX_WHOLE+1n),lim:'1'},{tick:'A',max:'010',lim:'1'},{tick:'A',max:10,lim:'1'},{tick:'A',max:'10',lim:'1',dec:'8'},
  {tick:'A',max:'10',lim:'1',mode:'monero-curve'},{tick:'A',max:'10',lim:'1',mint:'So11111111111111111111111111111111111111112'},{tick:'A',max:'10',lim:'1',pair:'wXMR'},
  {tick:' A',max:'10',lim:'1'},{tick:'A​',max:'10',lim:'1'},{tick:'A'.repeat(33),max:'10',lim:'1'},{tick:'A',max:'10',lim:'1',col:'AB'.repeat(32)}])
  assert.throws(()=>openDeployText(bad),undefined,JSON.stringify(bad,(k,v)=>typeof v==='bigint'?String(v):v));
 assert.throws(()=>checkOpenDeploy(null));
 assert.equal(readOpenDeploy(enc(text+' ')),null);
 assert.equal(readOpenDeploy(new Uint8Array(0)),null);
 assert.equal(readOpenDeploy(Uint8Array.of(0xef,0xbb,0xbf,...enc(text))),null);
});

test('a reader of launchpad deploys does not read an open deploy, and the other way round',()=>{
 const open=openDeployText({tick:'PEPE',max:'21000000',lim:'1000'}),all=openDeployText({tick:'PEPE',max:'21000000',pre:'21000000'});
 assert.equal(readDeploy(enc(open)),null);assert.equal(readDeploy(enc(all)),null);
 const launched='{"p":"xmr20","op":"deploy","tick":"TEST2","max":"1000000000","dec":"6","mode":"monero-curve","mint":"BGqUfSkAitpr6jErdEswXwYSXrf21gfCaBNh1h45HMBL"}';
 assert.ok(readDeploy(enc(launched)));assert.equal(readOpenDeploy(enc(launched)),null);
 // A text with mode "open" and no lim or pre is no deploy of either kind as an open text, though the launchpad
 // format reads it; the token list takes it only from a listed inscriber, as it always did.
 const odd='{"p":"xmr20","op":"deploy","tick":"X","max":"10","dec":"6","mode":"open"}';
 assert.equal(readOpenDeploy(enc(odd)),null);assert.ok(readDeploy(enc(odd)));
 assert.deepEqual(projectTokens([{id:'aa',creator:'someone',collection:'0'.repeat(64),type:6,content:()=>enc(odd)}],['inscriber']),[]);
});

test('how a signed text names an open token',()=>{
 assert.equal(tickerField('PEPE'),'PEPE');assert.equal(tickerField('ABCDEFGHIJKL'),'ABCDEFGHIJKL');
 for(const odd of ['ABCDEFGHIJKLM','ペペ','a b','a-b',''])assert.equal(tickerField(odd),'TOKEN');
 assert.equal(tokenLabel('PEPE','3f9a1c0be27d4a66'+'0'.repeat(48)),'PEPE (token 3f9a1c0be27d4a66)');
 assert.equal(tokenLabel('ペペ','3f9a1c0be27d4a66'+'0'.repeat(48)),'TOKEN (token 3f9a1c0be27d4a66)');
});

test('the shared test cases are what the rule library makes and reads',()=>{
 const made=execFileSync(process.execPath,[here('../tools/open-fixtures.mjs')],{encoding:'utf8'});
 assert.equal(made.trim(),readFileSync(here('./open-fixtures.json'),'utf8').trim(),'open-fixtures.json is not what tools/open-fixtures.mjs writes');
 const ctx={domain:FIX.domain,collectionName:null};let deploys=0;
 for(const c of FIX.cases){
  const bytes=unhex(c.record),d=decodeRecord(bytes,FIX.network);
  assert.equal(d.op,OP.mint,c.name);assert.equal(recordId(FIX.domain,d.bodyBytes),c.id,c.name);
  const text=renderText(d.op,d.body,d.bodyBytes,ctx);assert.equal(text,c.signedText,c.name);
  const signed=matchSignature(text,signerOf(d.op,d.body),{c:d.proof.c,r:d.proof.r},FIX.network)===d.proof.variant;
  const fields=signed?openDeployOf(d):null;
  assert.equal(fields?'deploy':'not',c.expect,c.name);
  const whole=openDeployIn(bytes,{domain:FIX.domain,network:FIX.network});assert.equal(whole?'deploy':'not',c.expect,c.name);if(whole){assert.equal(whole.id,c.id);assert.equal(whole.creator,c.creator);}
  assert.equal(openDeployIn(bytes,{domain:'11'.repeat(32),network:FIX.network}),null,c.name+': another ledger');
  if(fields){deploys++;assert.equal(new TextDecoder().decode(d.body.content),c.content);assert.equal(tokenLabel(fields.tick,c.id),c.label);assert.equal(d.body.creator,c.creator);}}
 assert.ok(deploys>=5&&FIX.cases.length-deploys>=20);
});

test('the open tokens among the carried mint records: the first record of an id, in chain order',()=>{
 const good=FIX.cases.filter(c=>c.expect==='deploy'),not=FIX.cases.find(c=>c.name==='the NFT has a name of its own');
 const rec=(c,height)=>({id:c.id,decoded:decodeRecord(unhex(c.record)),height,txid:hex(Uint8Array.of(height)).padStart(64,'0')});
 const tokens=projectOpen([rec(good[0],10),rec(not,11),rec(good[1],12),rec(good[0],13),rec(good[2],14)]);
 assert.deepEqual(tokens.map(t=>[t.id,t.height]),[[good[0].id,10],[good[1].id,12],[good[2].id,14]]);
 assert.deepEqual(tokens.map(t=>t.tick),['PEPE','PEPE','ペペ']);
 assert.equal(tokens[0].kind,'open');assert.equal(tokens[0].creator,good[0].creator);assert.equal(tokens[0].label,good[0].label);
 assert.equal(tokens[1].pre,'1000000');assert.equal(tokens[2].lim,undefined);
 // A deploy whose id starts with the 16 characters a signed text shows of an earlier token is refused.
 const twin={...rec(good[3],15),id:good[0].id.slice(0,16)+'f'.repeat(48)},other={...rec(good[3],16),id:good[0].id.slice(0,15)+'0'+'f'.repeat(48)};
 assert.deepEqual(projectOpen([rec(good[0],10),twin,other]).map(t=>t.height),[10,16]);
});

test('a reader lists the open tokens from the records its journal holds, from the opening block on',async()=>{
 const {mkdtempSync,rmSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const {wallet,makeTx,ownerEntry,DOMAIN}=await import('../../rules/tests/helpers.mjs'),{openReader}=await import('../../reader/lib/reader.mjs'),{createService}=await import('../../reader/service.mjs'),{fakeChain,carried}=await import('../../reader/tests/fake.mjs');
 assert.equal(DOMAIN,FIX.domain);
 const dir=mkdtempSync(join(tmpdir(),'xmr721-open-')),w={holder:wallet('open holder'),fee:wallet('open fee')};
 const owners=[makeTx('open reg0',[{to:w.holder,amount:10n**9n}])].map((t,i)=>({...ownerEntry(i,t),registrationHeight:50,ownerHeight:50}));
 const chain=fakeChain({start:100}),reader=openReader({dir:join(dir,'state'),chain,domain:DOMAIN,feeAddress:w.fee.address,owners,start:100,mintFrom:101});
 const block=async(...cases)=>{chain.mine(cases.map(c=>carried(unhex(c.record))));await reader.sync();};
 const good=FIX.cases.filter(c=>c.expect==='deploy'),named=FIX.cases.find(c=>c.name==='the NFT has a name of its own'),unsigned=FIX.cases.find(c=>c.name==='a signature that does not hold');
 await block(good[0]);                       // 101: before the opening block, an NFT and no token
 await block();                              // 102
 await block(good[0],good[1],named,unsigned);// 103: the opening block; the first record is passed over by the ledger and is the deploy
 await block(good[2],good[1]);               // 104
 const service=createService({reader,owners,xmr20Open:{from:103}}),plain=createService({reader,owners});
 const port=await service.listen(0),port2=await plain.listen(0),get=async(path,p=port)=>{const r=await fetch('http://127.0.0.1:'+p+path);return {status:r.status,body:await r.json()};};
 try{
  const list=(await get('/xmr20/open')).body;
  assert.equal(list.total,3);assert.equal(list.openFrom,103);
  assert.deepEqual(list.items.map(t=>[t.number,t.id,t.height,t.kind]),[[3,good[2].id,104,'open'],[2,good[1].id,103,'open'],[1,good[0].id,103,'open']]);
  assert.equal(list.items[2].label,good[0].label);assert.equal(list.items[2].creator,good[0].creator);assert.equal(list.items[2].lim,'1000');
  // The ledger itself holds the first deploy as the NFT of block 101, and refused the copy in block 103.
  assert.equal(reader.ledger.nft(good[0].id).history[0].height,101);
  for(const key of [good[1].id,good[1].id.slice(0,16)]){const one=(await get('/xmr20/open/'+key)).body;
   assert.equal(one.token.id,good[1].id);assert.equal(one.record,good[1].record);assert.equal(one.text,good[1].content);}
  assert.equal((await get('/xmr20/open/'+named.id)).status,404);
  assert.deepEqual((await get('/info')).body.xmr20,{open:{from:103}});
  // A reader that was not asked for open tokens serves none.
  assert.equal((await get('/xmr20/open',port2)).status,404);assert.equal((await get('/info',port2)).body.xmr20,undefined);
 }finally{await service.close();await plain.close();rmSync(dir,{recursive:true,force:true});}
});
