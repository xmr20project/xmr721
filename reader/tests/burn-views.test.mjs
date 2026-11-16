// Claiming by burning on the pages, in a headless browser against the demonstration service started with a first burn
// block (made-up chain, made-up wallets, nothing real): before that block the pages say what will change, from it on
// they explain the burn, show the burn address and the text, the fee and each Mordinal's fee address, a burn that waits
// for its fee, and a burn claim in a Mordinal's history.
//   node --test reader/tests/burn-views.test.mjs
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {startDemo} from './demo.mjs';
import {burnAddress} from '../../rules/lib/burn.mjs';
import {feeWallet,feeAddressOf} from '../../rules/lib/burn-fee.mjs';
import {chromium} from 'playwright';

const FROM=140,demo=await startDemo({port:0,auto:0,burnFrom:FROM}),root=`http://127.0.0.1:${demo.port}`,browser=await chromium.launch();
const context=await browser.newContext({viewport:{width:1280,height:900}});
await context.addInitScript(()=>{try{localStorage.setItem('xmr721-tutorial-seen','1');}catch{}});
after(async()=>{await browser.close();await demo.close();});
const problems=[],page=await context.newPage();
page.on('pageerror',e=>problems.push('page error: '+e.message));
page.on('console',m=>{if(m.type()!=='error')return;const url=m.location().url||'';if(/Failed to load resource.*status of 415/.test(m.text())&&/\/(content|text)\/\d+$/.test(url))return;problems.push('console: '+m.text()+' '+url);});
const get=async path=>(await fetch(root+path)).json();
const post=async(path,body)=>{const r=await fetch(root+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const j=await r.json();if(!r.ok)throw Error(j.error||String(r.status));return j;};
const {wallets:W}=await get('/test/wallets');
const text=async selector=>(await page.locator(selector).first().textContent()).trim();
// A fresh load, so the page reads /info again.
const go=async(path,wait)=>{await page.goto('about:blank');await page.goto(`${root}/view/#${path}`);await page.locator(wait).first().waitFor();};

test('before the first burn block the pages keep their words and say what changes',async()=>{
 assert.ok((await get('/info')).height<FROM);
 await go('/xmr721','[data-section=steps]');
 assert.match(await text('.head'),/No coin is spent/);assert.match(await text('.head .note'),/From block 140 a Mordinal is claimed by burning it/);assert.match(await text('.head .note'),/A burn in a block before that one claims nothing/);
 assert.match(await text('.head .note'),/Claims by signature still count until block 860/);
 assert.match(await text('[data-step=claim]'),/Press Claim\./);assert.equal(await page.locator('[data-burn=how]').count(),0);assert.match(await text('[data-section=more]'),/Feather and Cake Wallet/);
 await go('/mordinal/5','[data-answer]');
 assert.match(await text('[data-answer=unclaimed]'),/can claim it in the XMR20 wallet or with the command-line tool/);assert.match(await text('[data-burn=ahead]'),/From block 140/);assert.equal(await page.locator('[data-burn=facts]').count(),0);
 await go('/about','[data-section=checkpoint]');assert.match(await text('[data-burn=ahead]'),/From block 140/);assert.equal(await page.locator('[data-burn=about]').count(),0);});

test('from the first burn block on the pages give the steps for the original wallet, with an address and a text they work out themselves',async()=>{
 while((await get('/info')).height<FROM)await demo.mine(10);
 const info=await get('/info');assert.equal(info.burn.address,burnAddress());assert.equal(info.burn.recordsEnd,860);
 await go('/xmr721','[data-burn=how]');
 assert.match(await text('.head'),/claimed once, by burning the old one/);assert.equal(await page.locator('.head .note').count(),0);
 // No wallet button is named: these pages do not say the XMR20 wallet can burn.
 assert.doesNotMatch(await page.locator('body').textContent(),/Burn and claim/);assert.equal(await page.locator('[data-burn=wallet]').count(),0);
 assert.match(await text('[data-step=claim]'),/Burn each one: transfer the old Mordinal to the burn address/);assert.match(await text('[data-step=claim]'),/spends the inscribed coin in public/);assert.match(await text('[data-step=claim]'),/A burn that is refused cannot be tried again/);
 assert.match(await text('[data-step=wallet]'),/Claiming is done with the original Mordinals wallet/);
 assert.match(await text('[data-section=what]'),/Claiming burns the old Mordinal/);assert.doesNotMatch(await text('[data-section=what]'),/The coin is not spent/);
 // The three commands, the text file made with no stray byte, the address and the text.
 assert.equal(await text('[data-burn=how] [data-burn=file]'),"printf '%s' 'xmr721 claim to <address>' > claim.txt");
 assert.match(await text('[data-burn=how] [data-burn=steps]'),/list_my_inscriptions prints the inscription hash/);
 assert.equal(await text('[data-burn=how] [data-burn=command]'),`transfer_inscription <inscription hash> ${burnAddress()} claim.txt`);
 assert.equal(await text('[data-burn=how] [data-burn=text]'),'xmr721 claim to <address>');assert.equal(await text('[data-burn=how] .exact .v'),burnAddress());
 // What cannot be undone, and from which block it counts; and that a claim by signature still counts for a while.
 const once=await text('[data-burn=how] [data-burn=once]');
 assert.match(once,/A burn cannot be tried again/);assert.match(once,/counts only in block 140 or later/);assert.match(once,/A burn that is refused has still spent the coin/);assert.match(once,/Until block 860 a claim by signature, as before, still counts/);
 assert.doesNotMatch(await text('[data-section=more]'),/create the payment proof/);
 // The fee: the safe amount (the burn's own fee is not known yet), to the fee address the page works out for this Mordinal.
 assert.match(await text('[data-burn=how] [data-burn=fee-step]'),/Pay at least 0\.0012 XMR to the fee address of that Mordinal, from any Monero wallet, before or after the burn/);
 assert.match(await text('[data-burn=how] [data-burn=no-refund]'),/A fee paid without a burn, or to the fee address of another Mordinal, is not refunded/);
 assert.equal(await page.locator('[data-burn=how] [data-burn=fee-address]').count(),0);assert.match(await text('[data-burn=how] [data-burn=fee-wallet]'),new RegExp(feeWallet().address));
 assert.match(await text('[data-burn=how] [data-burn=once]'),/claims the Mordinal once its fee is paid/);
 await go('/mordinal/5','[data-answer]');
 assert.match(await text('[data-answer=unclaimed]'),/claims it by burning the old Mordinal/);assert.equal(await text('[data-answer] [data-burn=facts] .exact .v'),burnAddress());
 assert.equal(await text('[data-answer] [data-burn=fee-amount]'),'0.0012 XMR');assert.equal(await text('[data-answer] [data-burn=fee-address] .exact .v'),feeAddressOf(feeWallet(),5).address);
 assert.match(await text('[data-answer] [data-burn=fee-step]'),/to the fee address of Mordinal #5/);assert.match(await text('[data-answer] [data-burn=no-refund]'),/not refunded/);
 assert.equal(await text('[data-answer] [data-burn=text]'),'xmr721 claim to <address>');assert.match(await text('[data-answer] [data-burn=once]'),/cannot be tried again/);assert.match(await text('[data-burn=output]'),/output 1,005 of the chain/);
 await go('/about','[data-burn=about]');assert.match(await text('[data-burn=about]'),/burns the old one/);assert.match(await text('[data-burn=about]'),/cannot be tried again/);assert.equal(await text('[data-burn=about] .exact .v'),burnAddress());
 // A claimed Mordinal's page says nothing of it.
 await go('/mordinal/3','[data-answer=claimed]');assert.equal(await page.locator('[data-burn]').count(),0);});

test('the XMR20 wallet is named only on pages whose index.html says that wallet can burn',async()=>{
 await page.route('**/view/',async route=>{const r=await route.fetch(),html=await r.text();assert.match(html,/<head>/);await route.fulfill({response:r,body:html.replace('<head>','<head><meta name="xmr721-wallet-burn" content="yes">')});});
 try{await go('/xmr721','[data-burn=how]');
  assert.match(await text('[data-burn=wallet]'),/In the XMR20 wallet, “Burn and claim” builds and sends this transfer/);assert.match(await text('[data-step=claim]'),/Press “Burn and claim”/);
  assert.equal(await text('[data-burn=how] [data-burn=command]'),`transfer_inscription <inscription hash> ${burnAddress()} claim.txt`);
 }finally{await page.unroute('**/view/');}
 await go('/xmr721','[data-burn=how]');assert.equal(await page.locator('[data-burn=wallet]').count(),0);});

test('a service that states another burn address, text or fee wallet gets no instructions shown',async()=>{
 const other='4'+burnAddress().slice(1,-1)+(burnAddress().endsWith('o')?'p':'o');
 for(const change of [i=>{i.burn.address=other;},i=>{i.burn.text='xmr721 claim for <address>';},i=>{delete i.burn;},i=>{i.burn.recordsEnd=null;},
  i=>{i.burn.fee.wallet=other;},i=>{i.burn.fee.viewKey='00'.repeat(32);},i=>{i.burn.fee.account=2;},i=>{delete i.burn.fee;}]){
  await page.route('**/info',async route=>{const r=await route.fetch(),i=await r.json();change(i);await route.fulfill({response:r,json:i});});
  try{
   await go('/xmr721','[data-burn=misfit]');assert.match(await text('[data-burn=misfit]'),/The service does not fit its code: do not burn a Mordinal or pay a fee on its word/);
   assert.equal(await page.locator('[data-burn=how],[data-burn=facts],[data-burn=command],[data-burn=file]').count(),0);assert.doesNotMatch(await page.locator('body').textContent(),new RegExp(other));
   await go('/mordinal/6','[data-burn=misfit]');assert.equal(await page.locator('[data-burn=facts],[data-burn=command]').count(),0);
   await go('/about','[data-burn=misfit]');assert.equal(await page.locator('[data-burn=facts]').count(),0);
  }finally{await page.unroute('**/info');}}
 // A Mordinal whose fee address, as the service states it, is not the one these pages work out: nothing about the burn there.
 const wrong=feeAddressOf(feeWallet(),7).address;
 await page.route('**/mordinal/6',async route=>{const r=await route.fetch(),v=await r.json();v.mordinal.burnFee.address=wrong;await route.fulfill({response:r,json:v});});
 try{await go('/mordinal/6','[data-burn=misfit]');assert.equal(await page.locator('[data-burn=fee],[data-burn=facts]').count(),0);assert.doesNotMatch(await page.locator('body').textContent(),new RegExp(wrong));}
 finally{await page.unroute('**/mordinal/6');}
 await go('/xmr721','[data-burn=how]');assert.equal(await page.locator('[data-burn=misfit]').count(),0);});

test('a burn claim shows on the Mordinal and in the activity, and fits a phone',async()=>{
 const {txid}=await post('/test/burn',{number:5,to:W.erin});await demo.mine();
 assert.equal((await get('/entry/'+txid)).entry.ok,true);
 await go('/mordinal/5','[data-answer=claimed]');
 assert.equal(await text('[data-answer=claimed] .exact .v'),W.erin);assert.match(await page.locator('body').textContent(),/Claimed by burning the old Mordinal, by/);
 await page.setViewportSize({width:360,height:740});
 await go('/mordinal/6','[data-answer=unclaimed]');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth),0,'no sideways scroll');
 await go('/xmr721','[data-burn=how]');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth),0,'no sideways scroll');
 assert.deepEqual(problems,[]);});

test('a burn that waits for its fee: the Mordinal page says so, with what is missing and where to pay; a payment claims it',async()=>{
 await page.setViewportSize({width:1280,height:900});
 const {txid}=await post('/test/burn',{number:6,to:W.dave,paid:false});await demo.mine();
 assert.equal((await get('/entry/'+txid)).entry.state,'waiting');
 await go('/mordinal/6','[data-answer=waiting]');
 assert.match(await text('[data-answer=waiting] .big'),/Burned, waiting for its fee/);assert.equal(await text('[data-answer=waiting] [data-burn=missing]'),'0.00103 XMR');
 assert.equal(await text('[data-answer=waiting] [data-burn=fee-amount]'),'0.00103 XMR');assert.equal(await text('[data-answer=waiting] [data-burn=fee-address] .exact .v'),feeAddressOf(feeWallet(),6).address);
 assert.equal(await page.locator('[data-answer=waiting] .chip a.v').first().getAttribute('title'),W.dave);assert.match(await text('[data-answer=waiting] [data-burn=no-refund]'),/not refunded/);
 await go('/gallery','[data-number="6"]');assert.equal(await text('[data-number="6"] [data-claimed]'),'Waiting for its fee');
 await page.setViewportSize({width:360,height:740});await go('/mordinal/6','[data-answer=waiting]');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth),0,'no sideways scroll');
 // Part of it, then the rest: claimed in the block of the payment that reaches the fee.
 await post('/test/fee',{number:6,amount:'30000000'});await demo.mine();await go('/mordinal/6','[data-answer=waiting]');assert.equal(await text('[data-answer=waiting] [data-burn=missing]'),'0.001 XMR');
 await post('/test/fee',{number:6,amount:'1000000000'});await demo.mine();
 await go('/mordinal/6','[data-answer=claimed]');assert.equal(await text('[data-answer=claimed] .exact .v'),W.dave);assert.match(await page.locator('body').textContent(),/Claimed by burning the old Mordinal, by/);
 assert.deepEqual(problems,[]);});
