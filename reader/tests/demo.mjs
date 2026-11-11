// A demonstration service with a made-up Monero node, made-up owner list and made-up wallets, for trying the pages
// and wallets without any chain. Nothing here is real: no real Mordinal, key or payment.
//
//   node tests/demo.mjs [--port 18951] [--count 300] [--give <address>=7,120]... [--auto <ms>] [--allow-origin <origin>]
//
//   --give   puts the numbered demo Mordinals at an address of yours (main address or subaddress), so a throwaway
//            wallet can find and claim them.
//   --auto   puts waiting transactions in a new made-up block every <ms> (default 4000; 0 = only on request).
//
// Extra routes of the demo only:
//   POST /test/mine {blocks}            make blocks now (waiting transactions go into the first), then read them
//   POST /test/payment {pay:[{to,amount}]}   a made-up payment transaction in the pool -> {txid, keys}
//   POST /test/payment/hold {pay}      the same, kept back -> {txid, keys, fee}; /test/payment/publish {txid} puts it in
//                                      the pool; /test/payment/fail {mode: 'before'|'after'|'lost'} makes the next publish
//                                      fail ('lost': the wallet is told it may have been sent, and it never was)
//                                      /test/payment/found {txid} puts a 'lost' payment in the pool after all
//   POST /test/ahead {blocks}           the wallet's Monero node is this many blocks ahead of the service
//   POST /test/sign {as, text}          a message signature by one of the demo wallets (alice, bob, carol, dave, erin)
//   POST /test/coins {ready}            how many coins the made-up relay wallet has
//   GET  /test/wallets                  the demo wallets' addresses
import {createHash} from 'node:crypto';
import {deflateSync,crc32} from 'node:zlib';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {decodeAddress} from '../../rules/lib/monero.mjs';
import {outputSecret,signWithOutputKey} from '../../rules/lib/claim.mjs';
import {provePayments} from '../../rules/lib/payment.mjs';
import {wallet,makeTx,ownerEntry,makeInProof,DOMAIN} from '../../rules/tests/helpers.mjs';
import {openReader} from '../lib/reader.mjs';
import {loadCollections} from '../../xmr20-nfts/lib/collection.mjs';
import {createRelay} from '../lib/relay.mjs';
import {createContent} from '../lib/content.mjs';
import {createService} from '../service.mjs';
import {fakeChain,fakeCarrier,carried} from './fake.mjs';

const XMR=10n**12n,sha=b=>createHash('sha256').update(b).digest('hex');

// A small real PNG: a mirrored pattern of blocks drawn from the number.
function png(size,pixel){
 const row=size*3+1,raw=Buffer.alloc(row*size);
 for(let y=0;y<size;y++)for(let x=0;x<size;x++){const [r,g,b]=pixel(x,y);raw.set([r,g,b],y*row+1+x*3);}
 const chunk=(type,data)=>{const body=Buffer.concat([Buffer.from(type),data]),out=Buffer.alloc(8+body.length);out.writeUInt32BE(data.length,0);body.copy(out,4);out.writeUInt32BE(crc32(body),4+body.length);return out;};
 const head=Buffer.alloc(13);head.writeUInt32BE(size,0);head.writeUInt32BE(size,4);head[8]=8;head[9]=2;
 return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',head),chunk('IDAT',deflateSync(raw,{level:9})),chunk('IEND',Buffer.alloc(0))]);}
function picture(n,scale=12){
 const h=createHash('sha256').update('demo picture '+n).digest(),cells=8,size=cells*scale;
 const hue=h[0]/255*360,colour=(l,s=0.62)=>{const a=s*Math.min(l,1-l),f=k=>{const t=(k+hue/30)%12;return Math.round(255*(l-a*Math.max(-1,Math.min(t-3,9-t,1))));};return [f(0),f(8),f(4)];};
 const back=colour(0.14,0.35),front=colour(0.62),mark=colour(0.82,0.8);
 return png(size,(x,y)=>{const cx=Math.floor(x/scale),cy=Math.floor(y/scale),mx=cx<cells/2?cx:cells-1-cx,bit=h[1+cy*4+mx];return bit>150?front:bit>118&&(cx+cy)%2?mark:back;});}

// mints: the made-up ledger allows minting from its first block, and a collection and a few minted NFTs are added.
export async function startDemo({port=18951,count=300,give=[],auto=4000,origins=[],network='mainnet',views=undefined,mints=false,log=()=>{}}={}){
 const names=['alice','bob','carol','dave','erin'],w=Object.fromEntries([...names,'fee','other'].map(n=>[n,wallet('demo '+n,network)])),by=new Map(Object.values(w).map(x=>[x.address,x]));
 const given=new Map();for(const g of give){const a=decodeAddress(g.address,network);for(const n of g.numbers)given.set(n,{spend:a.spend,view:a.view,sub:a.kind==='sub'});}
 // Who holds what at the start: the demo wallets hold the low numbers, everything else sits with a wallet nobody uses.
 const seeded=new Map([[0,w.alice],[1,w.alice],[2,w.bob],[3,w.carol],[4,w.alice],[5,w.dave],[6,w.bob],[8,w.erin],[9,w.erin],[10,w.erin],[12,w.carol],[14,w.dave],[15,w.bob]]);
 const pictures=new Map(),owners=[];
 for(let n=0;n<count;n++){
  const g=given.get(n),to=g||seeded.get(n)||w.other,t=makeTx('demo owner '+n,[{to,amount:1000+n}],{subaddressKey:Boolean(g?.sub)});
  // Most are pictures; some are text (never shown), some have no known content, one is marked sensitive.
  const body=n%13===5?null:n%9===4?Buffer.from(`Demo text inscription ${n}. Text is not shown as a picture.`):picture(n);
  if(body)pictures.set(sha(body),{bytes:body,sensitive:n===11});
  owners.push({...ownerEntry(n,t),registrationHeight:2850000+n*7,ownerHeight:2850000+n*7,...(body?{bodySha256:sha(body),bodySize:body.length}:{})});}
 const transfers=[{result:'updated',mordinal:3,height:2990123,tx:sha('demo old transfer 3')},{result:'updated',mordinal:8,height:3001200,tx:sha('demo old transfer 8a')},{result:'updated',mordinal:8,height:3014477,tx:sha('demo old transfer 8b')}];
 for(const t of transfers){const o=owners[t.mordinal];if(o)o.ownerHeight=t.height;}

 const dir=mkdtempSync(join(tmpdir(),'mordinals-demo-')),start=100,story=14;
 const chain=fakeChain({start,time:Math.floor(Date.now()/1000)-story*120});
 const reader=openReader({dir:join(dir,'state'),chain,network,domain:DOMAIN,feeAddress:w.fee.address,owners,start,checkpointEvery:5,...(mints?{mintFrom:start+1}:{}),log});
 const carrier=fakeCarrier(chain,{coins:40});
 const relay=createRelay({dir:join(dir,'relay'),reader,chain,carrier,network,domain:DOMAIN,limits:{resendMs:60000,settleBlocks:3,holdBlocks:60},log});
 const L=()=>reader.ledger,key=(n,h)=>outputSecret({viewSecret:h.viewSecret,spendSecret:h.spendSecret,txPub:owners[n].ownerTxPubKeys[0],subScalar:h.subScalar});
 const make={
  claim:(n,h)=>{const p=L().prepareClaim({mordinal:n,to:h.address});return L().claimWithKey(p.bodyBytes,signWithOutputKey(p.keyHash,key(n,h)));},
  claimProof:(n,h)=>{const p=L().prepareClaim({mordinal:n,to:h.address,holder:h.address});return L().claimWithProof(p.bodyBytes,makeInProof({txid:owners[n].ownerTx,txPub:owners[n].ownerTxPubKeys[0],holder:h}),h.sign(p.text));},
  move:(n,from,to)=>{const p=L().prepareMove({mordinal:n,from:from.address,to:to.address});return L().sign(p.bodyBytes,from.sign(p.text));},
  list:(n,seller,price)=>{const p=L().prepareList({mordinal:n,seller:seller.address,price});return {id:p.id,record:L().sign(p.bodyBytes,seller.sign(p.text))};},
  cancel:(lot,seller)=>{const p=L().prepareCancel({lot,seller:seller.address});return L().sign(p.bodyBytes,seller.sign(p.text));},
  reserve:(lot,buyer)=>{const p=L().prepareReserve({lot,buyer:buyer.address});return {...p,record:L().sign(p.bodyBytes,buyer.sign(p.text))};}};
 let paid=0;
 const payment=outs=>makeTx('demo payment '+paid++ +' '+Date.now(),outs.map(x=>{const a=by.get(x.to)||decodeAddress(x.to,network);return {to:{spend:a.spend,view:a.view,kind:a.kind},amount:BigInt(x.amount)};}));
 const block=async(...items)=>{chain.mine(items.map(r=>r.txid?{txid:r.txid,tx:r.tx}:carried(r)));await reader.sync();};

 // A short made-up history, so every page has something to show.
 const have=n=>n<count&&!given.has(n);
 if(have(0)&&have(1)&&have(2))await block(make.claim(0,w.alice),make.claim(1,w.alice),make.claimProof(2,w.bob));
 if(have(3))await block(make.claim(3,w.carol));
 let first=null;if(have(0)){first=make.list(0,w.alice,3n*XMR/2n);await block(first.record);}
 if(first){const r=make.reserve(first.id,w.bob);await block(r.record);const t=payment(r.pay);await block(t);await block(L().buyRecord({lot:first.id,payments:provePayments({lines:r.pay,payments:[{txid:t.txid,tx:t.tx,txKey:t.keys.join('')}],domain:DOMAIN,lot:first.id,network})}));}
 if(have(1)){await block(make.move(1,w.alice,w.dave));const l=make.list(1,w.dave,8n*XMR/10n);await block(l.record);await block(make.cancel(l.id,w.dave));}
 if(have(8)&&have(9)&&have(10))await block(make.claim(8,w.erin),make.claimProof(9,w.erin),make.claim(10,w.erin));
 if(have(3))await block(make.list(3,w.carol,2n*XMR).record);
 if(have(8))await block(make.list(8,w.erin,XMR/4n).record);
 if(have(10)){const l=make.list(10,w.erin,45n*XMR/100n);await block(l.record);await block(make.reserve(l.id,w.dave).record);}
 if(have(12)&&have(14))await block(make.claim(12,w.carol),make.claim(14,w.dave));

 if(mints){
  const signed=(p,who)=>L().sign(p.bodyBytes,who.sign(p.text)),set=L().prepareCollection({creator:w.erin.address,name:'Demo Blocks',max:12});
  await block(signed(set,w.erin));
  const ids=[];for(const n of [1,2,3]){const p=L().prepareMint({collection:set.id,edition:n,creator:w.erin.address,name:'Block '+n,type:1,content:picture(900+n,2),...(n===3?{to:w.carol.address}:{})});ids.push(p.id);await block(signed(p,w.erin));}
  const note=L().prepareMint({creator:w.bob.address,name:'A note',type:5,content:Buffer.from('Made on Monero. Owned by an address, moved by a signature.')});await block(signed(note,w.bob));
  await block(signed(L().prepareList({mordinal:ids[0],seller:w.erin.address,price:3n*XMR/10n}),w.erin));}
 let busy=Promise.resolve(),failNext=null,ahead=0;const held=new Map(),lost=new Map();
 const extra=(method,path,body,step)=>{
  // Bytes of a small made-up picture, for trying the Create page.
  if(method==='GET'&&path==='/test/picture')return {hex:picture(Date.now()%100000,2).toString('hex')};
  if(method==='GET'&&path==='/test/wallets')return {wallets:Object.fromEntries(names.map(n=>[n,w[n].address])),feeAddress:w.fee.address};
  if(method!=='POST')return undefined;
  if(path==='/test/mine'){const n=Math.min(200,Math.max(1,Number(body.blocks)||1));
   return busy=busy.catch(()=>{}).then(async()=>{await step();for(let i=0;i<n;i++)chain.mine();await step();await step();return {height:reader.height};});}
  if(path==='/test/payment'){if(!Array.isArray(body.pay)||!body.pay.length||body.pay.length>8)throw Error('pay: a list of {to, amount}');
   const t=payment(body.pay);chain.publish({txid:t.txid,tx:t.tx});return {txid:t.txid,keys:t.keys};}
  if(path==='/test/payment/hold'){if(!Array.isArray(body.pay)||!body.pay.length||body.pay.length>3)throw Error('pay: a list of {to, amount}');
   const t=payment(body.pay);held.set(t.txid,t);return {txid:t.txid,keys:t.keys,fee:'30720000',chainHeight:chain.tip+ahead};}
  if(path==='/test/payment/publish'){const t=held.get(body.txid);if(!t)throw Error('This payment is not held.');const mode=failNext;failNext=null;
   if(mode==='before')return {failed:'before'};held.delete(t.txid);if(mode==='lost'){lost.set(t.txid,t);return {failed:'after'};}chain.publish({txid:t.txid,tx:t.tx});return mode==='after'?{failed:'after'}:{ok:true};}
  // A payment the wallet was told may have gone out, and that never did, reaches the node after all.
  if(path==='/test/payment/found'){const t=lost.get(body.txid);if(!t)throw Error('This payment was not lost.');lost.delete(t.txid);chain.publish({txid:t.txid,tx:t.tx});return {ok:true};}
  if(path==='/test/payment/fail'){failNext=['before','after','lost'].includes(body.mode)?body.mode:null;return {mode:failNext};}
  if(path==='/test/ahead'){ahead=Math.min(1000,Math.max(0,Number(body.blocks)||0));return {ahead};}
  if(path==='/test/sign'){const who=w[body.as];if(!who||!names.includes(body.as)||typeof body.text!=='string')throw Error('as: one of '+names.join(', ')+'; text: the text to sign');return {address:who.address,signature:who.sign(body.text)};}
  if(path==='/test/coins'){carrier.ready=Math.max(0,Number(body.ready)||0);return {ready:carrier.ready};}
  return undefined;};
 const content=createContent({source:async o=>pictures.get(o.bodySha256)||null});
 const service=createService({reader,relay,owners,transfers,content,collections:loadCollections(join(import.meta.dirname,'../../xmr20-nfts/collections')),origins,testHooks:true,extra,chunk:100,rate:{perSecond:50,burst:500},log,
  ...(views===undefined?{views:join(import.meta.dirname,'../views')}:{views})});
 const at=await service.listen(port);
 let timer=null;
 if(auto>0){timer=setInterval(()=>{busy=busy.catch(()=>{}).then(async()=>{await service.step();if((await chain.pool()).length){chain.mine();await service.step();}});},auto);timer.unref?.();}
 return {...service,port:at,chain,carrier,owners,wallets:w,make,payment,dir,
  mine:async(n=1)=>{await service.step();for(let i=0;i<n;i++)chain.mine();await service.step();await service.step();return reader.height;},
  close:async()=>{if(timer)clearInterval(timer);await service.close();rmSync(dir,{recursive:true,force:true});}};}

if(process.argv[1]===import.meta.filename){
 const arg=name=>{const i=process.argv.indexOf('--'+name);return i<0?null:process.argv[i+1];};
 const give=process.argv.flatMap((a,i)=>{if(a!=='--give')return [];const [address,list]=String(process.argv[i+1]).split('=');return [{address,numbers:(list||'7').split(',').map(Number)}];});
 const d=await startDemo({port:Number(arg('port'))||18951,count:Number(arg('count'))||300,give,auto:arg('auto')==null?4000:Number(arg('auto')),
  origins:process.argv.flatMap((a,i)=>a==='--allow-origin'?[process.argv[i+1]]:[]),log:v=>console.log(JSON.stringify(v))});
 console.log(`Mordinals demo (made-up chain) on http://127.0.0.1:${d.port}  pages: http://127.0.0.1:${d.port}/view/  block ${d.reader.height}`);
 for(const s of ['SIGINT','SIGTERM'])process.on(s,()=>d.close().then(()=>process.exit(0)));
}
