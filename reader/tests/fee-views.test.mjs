// The relay fee on the pages, in a headless browser against the demonstration service with a fee switched on
// (made-up chain, made-up wallets, nothing real): the price is said before signing, the page shows where to pay,
// and the mint goes through once the payment is in a block.
//   node --test reader/tests/fee-views.test.mjs
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {startDemo} from './demo.mjs';
import {chromium} from 'playwright';

const demo=await startDemo({port:0,auto:0,mints:true,fees:{mint:500000000n,collection:500000000n}}),root=`http://127.0.0.1:${demo.port}`,browser=await chromium.launch();
const context=await browser.newContext({viewport:{width:1280,height:900}});
await context.addInitScript(()=>{try{localStorage.setItem('xmr721-tutorial-seen','1');}catch{}});
after(async()=>{await browser.close();await demo.close();});
const problems=[],page=await context.newPage();
page.on('pageerror',e=>problems.push('page error: '+e.message));
page.on('console',m=>{if(m.type()==='error')problems.push('console: '+m.text());});
const get=async path=>(await fetch(root+path)).json();
const post=async(path,body)=>{const r=await fetch(root+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const j=await r.json();if(!r.ok)throw Error(j.error||String(r.status));return j;};
const {wallets:W}=await get('/test/wallets');
const text=async selector=>(await page.locator(selector).first().textContent()).trim();

test('Create says the price, shows where to pay after signing, and the mint counts once the fee is in a block',async()=>{
 await page.goto(`${root}/view/#/create`);await page.locator('[data-field=creator]').waitFor();
 assert.match(await text('[data-fee]'),/Minting costs 0\.0005 XMR/);
 await page.locator('[data-field=creator]').fill(W.dave);await page.locator('[data-field=text]').fill('Paid for on the page');await page.locator('[data-action=next]').click();
 await page.locator('[data-field=signature]').fill((await post('/test/sign',{as:'dave',text:await text('[data-signtext]')})).signature);
 await page.locator('[data-action=send]').click();await page.locator('[data-pay]:not([hidden])').waitFor();
 assert.equal(await text('[data-pay-amount]'),'0.0005 XMR');const address=await text('[data-pay-address]');assert.match(address,/^8[1-9A-HJ-NP-Za-km-z]{94}$/);
 assert.equal(await page.locator('[data-sent] .status').getAttribute('data-state'),'unpaid');
 await demo.mine();await page.waitForTimeout(3000);assert.equal(await page.locator('[data-sent] .good').count(),0,'nothing happens without the fee');
 await post('/test/payment',{pay:[{to:address,amount:'500000000'}]});await demo.mine();await demo.mine();
 await page.locator('[data-sent] .good').waitFor({timeout:20000});assert.equal(await page.locator('[data-pay]:not([hidden])').count(),0,'the payment box is gone');
 assert.equal((await get('/nfts')).items.filter(x=>x.owner===W.dave).length,1);});

test('a collection says its price too, and the payment box fits a phone',async()=>{
 await page.goto(`${root}/view/#/create?make=collection`);await page.locator('[data-field=name]').waitFor();
 assert.match(await text('[data-fee]'),/Making a collection costs 0\.0005 XMR/);
 await page.setViewportSize({width:360,height:740});
 await page.locator('[data-field=creator]').fill(W.erin);await page.locator('[data-field=name]').fill('Phone Set');await page.locator('[data-field=max]').fill('2');await page.locator('[data-action=next]').click();
 await page.locator('[data-field=signature]').fill((await post('/test/sign',{as:'erin',text:await text('[data-signtext]')})).signature);
 await page.locator('[data-action=send]').click();await page.locator('[data-pay]:not([hidden])').waitFor();
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth),0,'no sideways scroll');
 assert.deepEqual(problems,[]);});
