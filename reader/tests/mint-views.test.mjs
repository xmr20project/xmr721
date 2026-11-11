// Creating, showing, sending, selling and burning minted NFTs through the pages, in a headless browser against the
// demonstration service with minting switched on (made-up chain, made-up wallets, nothing real).
//   node --test reader/tests/mint-views.test.mjs
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {startDemo} from './demo.mjs';
import {chromium} from 'playwright';

const demo=await startDemo({port:0,auto:0,mints:true}),root=`http://127.0.0.1:${demo.port}`,browser=await chromium.launch();
const context=await browser.newContext({viewport:{width:1280,height:900}});
await context.addInitScript(()=>{try{localStorage.setItem('xmr721-tutorial-seen','1');}catch{}});
after(async()=>{await browser.close();await demo.close();});
const problems=[];
const page=await context.newPage();
page.on('pageerror',e=>problems.push('page error: '+e.message));
page.on('console',m=>{if(m.type()==='error')problems.push('console: '+m.text()+' '+(m.location().url||''));});
page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/test/'))problems.push('the page called a test route');});

const get=async path=>(await fetch(root+path)).json();
const post=async(path,body)=>{const r=await fetch(root+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const j=await r.json();if(!r.ok)throw Error(j.error||String(r.status));return j;};
const {wallets:W,feeAddress}=await get('/test/wallets');
const view=at=>page.locator(`#main > .view[data-at="${at}"]`);
const go=async at=>{await page.goto(`${root}/view/#${at}`);await view(at).waitFor();};
const text=async selector=>(await page.locator(selector).first().textContent()).trim();
const count=selector=>page.locator(selector).count();
const atomic=t=>{const [whole,part='']=t.split('.');return (BigInt(whole)*10n**12n+BigInt(part.padEnd(12,'0'))).toString();};
// Signs the text on the page with a demo wallet, sends it, and puts it in a block.
async function signSendMine(as){
 const words=await text('[data-signtext]');
 await page.locator('[data-field=signature]').fill((await post('/test/sign',{as,text:words})).signature);
 await page.locator('[data-action=send]').click();await page.locator('[data-sent]').waitFor();
 assert.equal(await count('[data-sent] .good'),0,'not done before a block');
 await demo.mine();await page.locator('[data-sent] .good').waitFor({timeout:20000});return words;}
const picture=async()=>Buffer.from((await get('/test/picture')).hex,'hex');
let setId,newId;

test('the list shows the minted NFTs and the collection made on the ledger',async()=>{
 const seeded=(await get('/nfts')).items;assert.equal(seeded.length,4);
 await go('/nfts');
 assert.equal(await count('[data-nft-card]'),4);assert.match(await text('[data-section=made-collections]'),/Demo Blocks\s*3 of 12/);
 const block=seeded.find(x=>x.name==='Block 1'),note=seeded.find(x=>x.name==='A note');
 await page.waitForFunction(id=>{const i=document.querySelector(`[data-nft-card="${id}"] img`);return i&&i.complete&&i.naturalWidth===16;},block.id);
 await page.waitForFunction(id=>/Made on Monero/.test(document.querySelector(`[data-nft-card="${id}"] .nfttext`)?.textContent||''),note.id);
 assert.match(await text(`[data-nft-card="${block.id}"]`),/0\.3 XMR/);
 // The same NFTs appear among the collections and in the history.
 await go('/collections');assert.deepEqual(await page.locator('.ccard[data-kind=made] .n').allTextContents(),['Demo Blocks']);
 await go('/');assert.match(await text('#main'),/Minted “Block 1”/);});

test('create a collection, then mint a picture into it; too much content and another signer are refused',async()=>{
 await go('/create?make=collection');
 await page.locator('[data-action=next]').click();assert.match(await text('[data-section=create] .error'),/Editions: a whole number/);
 await page.locator('[data-field=creator]').fill(W.dave);await page.locator('[data-field=name]').fill('Page Made');await page.locator('[data-field=max]').fill('5');
 await page.locator('[data-action=next]').click();
 const words=await signSendMine('dave');assert.match(words,/^XMR721 collection: create "Page Made" with 5 editions, minted only by /);
 await page.locator('a',{hasText:'Open the collection'}).click();await page.locator('[data-section=editions]').waitFor();
 setId=page.url().split('/set/')[1];assert.match(setId,/^[0-9a-f]{64}$/);assert.match(await text('.lede'),/0 of 5 editions minted/);
 await page.locator('a',{hasText:'Mint the next edition'}).click();await view('/create?collection='+setId).waitFor();
 // Too large: the count turns red and nothing is prepared.
 await page.locator('[data-field=creator]').fill(W.dave);await page.locator('[data-field=text]').fill('x'.repeat(900));
 assert.match(await text('[data-room]'),/900 of 824 bytes used/);assert.equal(await page.locator('[data-room]').getAttribute('data-over'),'true');
 await page.locator('[data-action=next]').click();assert.match(await text('[data-section=create] .error'),/76 bytes too large/);
 // A picture, a name, and the wrong creator first.
 const png=await picture();await page.locator('[data-field=text]').fill('');await page.locator('[data-field=file]').setInputFiles({name:'tiny.png',mimeType:'image/png',buffer:png});
 await page.locator('[data-field=name]').fill('First of five');
 assert.match(await text('[data-room]'),new RegExp(`^${png.length+13} of 824 bytes used`));
 await page.locator('[data-field=creator]').fill(W.bob);await page.locator('[data-action=next]').click();
 assert.match(await text('[data-section=create] .error'),/Only the creator of this collection can mint into it/);
 await page.locator('[data-field=creator]').fill(W.dave);await page.locator('[data-action=next]').click();
 const minted=await signSendMine('dave');assert.match(minted,new RegExp(`^XMR721 mint: edition 1 of "Page Made" named "First of five"; ${png.length} bytes of type 1, SHA-256 [0-9a-f]{64}; first owner ${W.dave}; code `));
 await page.locator('a',{hasText:'Open the NFT'}).click();await page.locator('[data-section=owner]').waitFor();
 newId=page.url().split('/nft/')[1];
 assert.match(await text('h1'),/First of five/);assert.match(await text('.kv'),new RegExp(`PNG picture, ${png.length} bytes`));
 await page.waitForFunction(()=>{const i=document.querySelector('.nftpic.large img');return i&&i.complete&&i.naturalWidth===16;});
 const served=Buffer.from(await (await fetch(`${root}/nft/${newId}/content`)).arrayBuffer());assert.ok(served.equals(png),'the bytes served are the bytes inscribed');
 assert.equal((await get('/nft/'+newId)).nft.owner,W.dave);});

test('one NFT in no collection, minted to another address',async()=>{
 await go('/create');assert.doesNotMatch(await text('[data-section=create]'),/null|undefined/);
 await page.locator('[data-field=creator]').fill(W.carol);await page.locator('[data-field=text]').fill('A short line.');await page.locator('[data-field=to]').fill(W.alice);
 assert.match(await text('[data-room]'),/13 of 759 bytes used/);
 await page.locator('[data-action=next]').click();const words=await signSendMine('carol');
 assert.match(words,new RegExp(`^XMR721 mint: one NFT in no collection; 13 bytes of type 5, SHA-256 [0-9a-f]{64}; first owner ${W.alice}; code `));
 await page.locator('a',{hasText:'Open the NFT'}).click();await page.locator('[data-section=owner]').waitFor();
 assert.equal((await get('/nft/'+page.url().split('/nft/')[1])).nft.owner,W.alice);assert.match(await text('.nfttext'),/A short line\./);});

test('the owner sends it, and another owner burns one',async()=>{
 await go('/nft/'+newId);await page.locator('[data-action=own]').click();await page.locator('[data-action=send-start]').click();await view(`/nft/${newId}/send`).waitFor();
 await page.locator('[data-field=to]').fill(W.dave);await page.locator('[data-action=next]').click();assert.match(await text('[data-section=owner] .error'),/already owns it/);
 await page.locator('[data-field=to]').fill(W.alice);await page.locator('[data-action=next]').click();
 assert.match(await signSendMine('dave'),/^Mordinals move: send "Page Made" #1 \(NFT [0-9a-f]{32}\) to /);
 assert.equal((await get('/nft/'+newId)).nft.owner,W.alice);
 await go('/nft/'+newId);assert.match(await text('[data-section=history]'),/Sent by/);
 const note=(await get('/nfts')).items.find(x=>x.name==='A note');
 await go(`/nft/${note.id}/burn`);assert.match(await text('[data-section=owner] .warn'),/cannot be undone/);
 assert.match(await signSendMine('bob'),/^XMR721 burn: destroy NFT [0-9a-f]{32} for good; burn 0; /);
 await go('/nft/'+note.id);assert.match(await text('.split'),/Burned/);assert.equal(await count('[data-action=own]'),0);assert.equal((await get('/nft/'+note.id)).nft.owner,null);});

test('a minted NFT is listed, reserved, paid and bought through the same pages as a Mordinal',async()=>{
 await go('/nft/'+newId+'/sell');await page.locator('[data-field=price]').fill('0.4');await page.locator('[data-action=next]').click();
 assert.match(await signSendMine('alice'),/^Mordinals list: sell "Page Made" #1 \(NFT [0-9a-f]{32}\) for 0\.4 XMR \(0\.38 XMR to /);
 await go('/market');const row=page.locator('[data-section=listings] tbody tr',{hasText:'NFT '+newId.slice(0,8)});assert.match(await row.textContent(),/0\.4 XMR/);
 await row.locator('a',{hasText:'See and buy'}).click();await page.locator('[data-section=buy]').waitFor();
 assert.match(await text('h1'),/First of five/);const lot=page.url().split('/lot/')[1];
 await page.locator('[data-field=buyer]').fill(W.bob);await page.locator('[data-action=buy]').click();await view(`/buy/${lot}/${W.bob}`).waitFor();
 await page.locator('[data-stage=reserve]').waitFor();
 const words=await text('[data-signtext]');assert.match(words,/^Mordinals reserve: buy "Page Made" #1 \(NFT [0-9a-f]{32}\) for 0\.4 XMR; /);assert.match(words,/; NFT to /);
 await page.locator('[data-field=signature]').fill((await post('/test/sign',{as:'bob',text:words})).signature);await page.locator('[data-action=send]').click();await page.locator('[data-sent]').waitFor();
 await demo.mine();await page.locator('[data-stage=pay]').waitFor({timeout:15000});
 const amounts=[await text('[data-payment="1"] .exact.big .v'),await text('[data-payment="2"] .exact.big .v')],to=[await text('[data-payment="1"] .exact:not(.big) .v'),await text('[data-payment="2"] .exact:not(.big) .v')];
 assert.deepEqual(to,[W.alice,feeAddress]);assert.match(amounts[0],/^0\.38\d{1,10}$/);assert.match(amounts[1],/^0\.02\d{1,10}$/);
 const paid=await post('/test/payment',{pay:[{to:to[0],amount:atomic(amounts[0])},{to:to[1],amount:atomic(amounts[1])}]});
 await page.locator('[data-field=txid]').fill(paid.txid);await page.locator('[data-field=key]').fill(paid.keys.join(''));await page.locator('[data-action=finish]').click();
 await page.locator('[data-stage=finishing]').waitFor();await demo.mine();await demo.mine();
 await page.locator('[data-stage=sold]').waitFor({timeout:20000});assert.match(await text('[data-stage=sold]'),/First of five is yours/);
 assert.equal((await get('/nft/'+newId)).nft.owner,W.bob);
 await go('/address/'+W.bob);});

// A site may give the pages a wallet that approves records itself. Here the wallet is a stand-in that signs in this
// test process the way a wallet would: from the body bytes alone.
test('with a connected wallet, the creator is filled in and one approval mints; a refusal sends nothing',async()=>{
 const {decodeRecord,renderText,attachSignature,recordId}=await import('../../rules/lib/records.mjs'),{hex,unhex}=await import('../../rules/lib/monero.mjs'),info=await get('/info');
 const other=await context.newPage();other.on('pageerror',e=>problems.push('page error: '+e.message));
 let refuse=true;const asked=[];
 await other.exposeFunction('walletApprove',async bodyHex=>{
  asked.push(bodyHex);if(refuse)return {cancelled:true};
  const bodyBytes=unhex(bodyHex),d=decodeRecord(bodyBytes,info.network,{sig:false}),ctx={domain:info.domain,number:null};
  const record=attachSignature(bodyBytes,(await post('/test/sign',{as:'carol',text:renderText(d.op,d.body,bodyBytes,ctx)})).signature,ctx,info.network);
  return {id:recordId(info.domain,bodyBytes),state:(await post('/records',{record:hex(record)})).state};});
 await other.addInitScript(address=>{globalThis.xmr721Wallet={status:()=>({connected:true,address,label:'Test wallet'}),connect:async()=>({connected:true,address}),disconnect(){},openMordinals(){},onChange:()=>()=>{},
  async signRecord(body){const out=await globalThis.walletApprove(body);if(out.cancelled)throw Object.assign(Error('Not approved. Nothing was signed.'),{cancelled:true});return out;}};},W.carol);
 await other.goto(`${root}/view/#/create`);await other.locator('[data-wallet=connected]').waitFor();
 assert.equal(await other.locator('[data-field=creator]').inputValue(),W.carol);
 await other.locator('[data-field=text]').fill('Approved in the wallet');await other.locator('[data-field=name]').fill('One press');await other.locator('[data-action=next]').click();
 const words=(await other.locator('[data-wallet-sign] [data-signtext]').textContent()).trim();assert.match(words,/^XMR721 mint: one NFT in no collection named "One press"; 22 bytes of type 5/);
 assert.equal(await other.locator('details.other-wallet [data-field=signature]').count(),1,'signing in another wallet stays possible');
 const before=(await get('/nfts')).total;
 await other.locator('[data-action=approve]').click();await other.locator('[data-wallet-sign] p.note').waitFor();
 assert.match(await other.locator('[data-wallet-sign] p.note').textContent(),/Nothing was signed/);assert.equal(await other.locator('[data-sent]').count(),0);
 refuse=false;await other.locator('[data-action=approve]').click();await other.locator('[data-sent]').waitFor();
 assert.equal(asked.length,2);assert.equal(asked[0],asked[1]);
 await demo.mine();await other.locator('[data-sent] .good').waitFor({timeout:20000});
 const now=await get('/nfts');assert.equal(now.total,before+1);const made=now.items.find(x=>x.name==='One press');assert.equal(made.owner,W.carol);
 // On the NFT's page the owner's choices are open at once, and a burn goes through the wallet too.
 await other.goto(`${root}/view/#/nft/${made.id}`);await other.locator('[data-action=burn-start]').click();
 await other.locator('[data-action=approve]').waitFor();
 // Another address gets the three steps, with no wallet button.
 await other.goto(`${root}/view/#/create`);await other.locator('[data-field=creator]').fill(W.dave);await other.locator('[data-field=text]').fill('Not this wallet');await other.locator('[data-action=next]').click();
 await other.locator('[data-field=signature]').waitFor();assert.equal(await other.locator('[data-action=approve]').count(),0);
 await other.close();});

test('nothing scrolls sideways at 360 px, and the browser reported no errors',async()=>{
 await page.setViewportSize({width:360,height:740});
 for(const at of ['/nfts','/create','/create?make=collection','/set/'+setId,'/nft/'+newId,'/nft/'+newId+'/send']){await go(at);await page.waitForTimeout(150);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth),0,'sideways scroll at '+at);}
 assert.deepEqual(problems,[]);});
