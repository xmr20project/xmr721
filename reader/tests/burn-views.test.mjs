// Claiming by burning on the pages, in a headless browser against the demonstration service started with a first burn
// block (made-up chain, made-up wallets, nothing real): before that block the pages say what will change, from it on
// they explain the burn, show the burn address and the text, and show a burn claim in a Mordinal's history.
//   node --test reader/tests/burn-views.test.mjs
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {startDemo} from './demo.mjs';
import {burnAddress} from '../../rules/lib/burn.mjs';
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
 assert.match(await text('.head'),/No coin is spent/);assert.match(await text('.head .note'),/From block 140 a Mordinal is claimed by burning it/);
 assert.match(await text('[data-step=claim]'),/Press Claim\./);assert.equal(await page.locator('[data-burn=how]').count(),0);assert.match(await text('[data-section=more]'),/Feather and Cake Wallet/);
 await go('/mordinal/5','[data-answer]');
 assert.match(await text('[data-answer=unclaimed]'),/can claim it in the XMR20 wallet or with the command-line tool/);assert.match(await text('[data-burn=ahead]'),/From block 140/);assert.equal(await page.locator('[data-burn=facts]').count(),0);
 await go('/about','[data-section=checkpoint]');assert.match(await text('[data-burn=ahead]'),/From block 140/);assert.equal(await page.locator('[data-burn=about]').count(),0);});

test('from the first burn block on the pages explain the burn, with the burn address and the text',async()=>{
 while((await get('/info')).height<FROM)await demo.mine(10);
 const info=await get('/info');assert.equal(info.burn.address,burnAddress());
 await go('/xmr721','[data-burn=how]');
 assert.match(await text('.head'),/claimed once, by burning the old one/);assert.equal(await page.locator('.head .note').count(),0);
 assert.match(await text('[data-step=claim]'),/Press “Burn and claim”/);assert.match(await text('[data-step=claim]'),/spends the inscribed coin in public/);
 assert.match(await text('[data-section=what]'),/Claiming burns the old Mordinal/);assert.doesNotMatch(await text('[data-section=what]'),/The coin is not spent/);
 assert.equal(await text('[data-burn=how] [data-burn=command]'),`transfer_inscription <inscription> ${burnAddress()} <text file>`);
 assert.equal(await text('[data-burn=how] [data-burn=text]'),'xmr721 claim to <address>');assert.equal(await text('[data-burn=how] .exact .v'),burnAddress());
 assert.doesNotMatch(await text('[data-section=more]'),/create the payment proof/);
 await go('/mordinal/5','[data-answer]');
 assert.match(await text('[data-answer=unclaimed]'),/claims it by burning the old Mordinal/);assert.equal(await text('[data-answer] .exact .v'),burnAddress());
 assert.equal(await text('[data-answer] [data-burn=text]'),'xmr721 claim to <address>');assert.match(await text('[data-burn=output]'),/output 1,005 of the chain/);
 await go('/about','[data-burn=about]');assert.match(await text('[data-burn=about]'),/burns the old one/);assert.equal(await text('[data-burn=about] .exact .v'),burnAddress());
 // A claimed Mordinal's page says nothing of it.
 await go('/mordinal/3','[data-answer=claimed]');assert.equal(await page.locator('[data-burn]').count(),0);});

test('a burn claim shows on the Mordinal and in the activity, and fits a phone',async()=>{
 const {txid}=await post('/test/burn',{number:5,to:W.erin});await demo.mine();
 assert.equal((await get('/entry/'+txid)).entry.ok,true);
 await go('/mordinal/5','[data-answer=claimed]');
 assert.equal(await text('[data-answer=claimed] .exact .v'),W.erin);assert.match(await page.locator('body').textContent(),/Claimed by burning the old Mordinal, by/);
 await page.setViewportSize({width:360,height:740});
 await go('/mordinal/6','[data-answer=unclaimed]');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth),0,'no sideways scroll');
 await go('/xmr721','[data-burn=how]');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth),0,'no sideways scroll');
 assert.deepEqual(problems,[]);});
