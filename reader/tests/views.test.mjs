// The pages in views/, opened in a headless browser against the demonstration service (made-up chain, made-up wallets).
// Nothing here is real: signatures come from the demo wallets, payments and blocks from the demo's test routes.
// The browser may only talk to 127.0.0.1.
//
//   node tests/views.test.mjs      (or: node --test tests/views.test.mjs)   about a minute; writes shots/*.png
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {startDemo} from './demo.mjs';
import {build} from '../views/build.mjs';
import {chromium} from 'playwright';

const HERE=import.meta.dirname,VIEWS=join(HERE,'..','views'),SHOTS=join(HERE,'..','shots');
mkdirSync(SHOTS,{recursive:true});

const demo=await startDemo({port:0,auto:0});
const root=`http://127.0.0.1:${demo.port}`;
const browser=await chromium.launch();
const context=await browser.newContext({viewport:{width:1280,height:900}});
await context.grantPermissions(['clipboard-read','clipboard-write'],{origin:root});
after(async()=>{await browser.close();await demo.close();});

// Everything the browser asks for, and everything it complains about.
const problems=[],blocked=[],posted=[];
// A browser logs every answer that is not 2xx as a console error. These two are expected and say nothing about the pages:
// an inscription that is not a picture answers 415 to a picture request (and, when it is not a text either, to a text
// request), and a search for an id asks whether it is a registration.
const EXPECTED=[[/\/content\/\d+$/,'415'],[/\/text\/\d+$/,'415'],[/\/mordinal\/[0-9a-f]{64}$/,'404']];
await context.route('**/*',route=>{
 const url=new URL(route.request().url());
 if(url.hostname==='127.0.0.1'||url.protocol==='data:'||url.protocol==='blob:')return route.continue();
 blocked.push(url.href);return route.abort();});
await context.exposeBinding('reportViolation',(_,text)=>{problems.push('content security policy: '+text);});
// The first-visit tutorial would cover the market in every test, so it is marked as seen here; its own test uses a
// browser context of its own.
await context.addInitScript(()=>{try{localStorage.setItem('xmr721-tutorial-seen','1');}catch{}});
await context.addInitScript(()=>document.addEventListener('securitypolicyviolation',e=>window.reportViolation(`${e.violatedDirective} ${e.blockedURI}`)));
function watch(page){
 page.on('console',m=>{
  if(m.type()!=='error')return;
  const text=m.text(),url=m.location().url||'';
  if(text.startsWith('Failed to load resource')&&EXPECTED.some(([where,status])=>where.test(url)&&text.includes('status of '+status)))return;
  problems.push(`console: ${text} ${url}`);});
 page.on('pageerror',e=>problems.push('page error: '+e.message));
 page.on('request',r=>{const u=new URL(r.url());
  if(u.pathname.startsWith('/test/'))problems.push('the page called '+u.pathname);
  if(r.method()==='POST')posted.push(u.pathname);});
 return page;}
const page=watch(await context.newPage());

const get=async path=>(await fetch(root+path)).json();
const post=async(path,body)=>{const r=await fetch(root+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 const j=await r.json();if(!r.ok)throw Error(j.error||String(r.status));return j;};
const {wallets:W,feeAddress}=await get('/test/wallets');
const sign=async(as,text)=>(await post('/test/sign',{as,text})).signature;
const lotOf=async number=>(await get('/mordinal/'+number)).mordinal.lot.id;
const ownerOf=async number=>(await get('/mordinal/'+number)).mordinal.owner;
const atomic=text=>{const [whole,part='']=text.split('.');return (BigInt(whole)*10n**12n+BigInt(part.padEnd(12,'0'))).toString();};

// Opens a view by its address after "#" and waits until that view is on the page.
const view=at=>page.locator(`#main > .view[data-at="${at}"]`);
async function go(at){await page.goto(`${root}/view/#${at}`);await view(at).waitFor();}
const shown=at=>view(at).waitFor();
const text=async selector=>(await page.locator(selector).first().textContent()).trim();
const count=selector=>page.locator(selector).count();
const noSideScroll=async()=>assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth),0,'the page scrolls sideways at '+page.url());
const shot=(name,fullPage=false)=>page.screenshot({path:join(SHOTS,name+'.png'),fullPage});
// The same view on a 360 px wide screen: no sideways scroll, and optionally a picture of it.
async function narrow(name){
 await page.setViewportSize({width:360,height:740});await page.waitForTimeout(150);
 await noSideScroll();if(name)await shot(name);
 await page.setViewportSize({width:1280,height:900});}
// Signs the text on the page with a demo wallet, pastes the signature and sends.
async function signAndSend(as){
 const words=await text('[data-signtext]');
 await page.locator('[data-field=signature]').fill(await sign(as,words));
 await page.locator('[data-action=send]').click();
 await page.locator('[data-sent]').waitFor();
 return words;}
// A sent record must read as waiting, never as done, until a block holds it.
async function stillWaiting(){
 await page.locator('[data-sent] .status:not([data-state=checking])').waitFor();
 assert.notEqual(await page.locator('[data-sent] .status').getAttribute('data-state'),'done');
 assert.equal(await count('[data-sent] .good'),0);
 assert.match(await text('[data-sent]'),/not done yet/);}

test('the pages are plain static files that fit the service policy',async()=>{
 assert.equal(readFileSync(join(VIEWS,'rules.js'),'utf8'),await build(),'rules.js is out of date; run node reader/views/build.mjs');
 const res=await fetch(root+'/view/'),html=await res.text(),policy=res.headers.get('content-security-policy')||'';
 assert.match(policy,/script-src 'self'/);assert.match(policy,/style-src 'self'/);
 assert.doesNotMatch(html,/\sstyle=|<style|\son[a-z]+=|<script(?![^>]*\ssrc=)/i,'index.html has inline style or script');
 assert.doesNotMatch(html,/https?:\/\//,'index.html points outside the service');
 for(const name of readdirSync(VIEWS).filter(n=>/\.(js|html|css)$/.test(n)&&n!=='rules.js')){
  const source=readFileSync(join(VIEWS,name),'utf8');
  assert.doesNotMatch(source,/\/test\//,name+' uses a test route');
  assert.doesNotMatch(source,/innerHTML|outerHTML|insertAdjacentHTML|document\.write/,name+' writes markup from text');}});

test('the explorer shows totals and the seeded activity, with a filter',async()=>{
 await go('/');
 for(const [label,value] of [['Mordinals','300'],['Claimed','9'],['For sale','3'],['Sales','1']])assert.equal(await text(`[data-stat="${label}"] .value`),value);
 assert.match(await text('[data-stat="Volume"] .value'),/^1\.5\s*XMR$/);
 assert.equal(await count('[data-section=waiting]'),0,'nothing waits, so no waiting list');
 assert.match(await text('[data-section=legacy]'),/300 inscriptions and 3 transfers/);
 assert.equal(await count('[data-section=legacy] tbody tr'),25);assert.match(await page.locator('[data-section=legacy] tbody tr').first().innerText(),/Moved in 2023[\s\S]*2023-11-\d\d/);
 const rows=page.locator('[data-section=activity] tbody tr');
 assert.equal(await rows.count(),19);
 const first=await rows.first().innerText();
 assert.match(first,/Claimed by/);assert.match(first,/\b115\b/);assert.match(first,/\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
 assert.match(await text('[data-section=activity]'),/Sold for 1\.5 XMR/);
 assert.match(await text('#tip'),/Block 115/);
 await shot('explorer');await narrow('explorer-360');
 await page.locator('[data-section=activity] .pills button[data-value=list]').click();await shown('/?kind=list');
 assert.equal(await rows.count(),5);
 assert.deepEqual([...new Set(await page.locator('[data-section=activity] tbody tr td:first-child .pill').allTextContents())],['Listed']);});

test('search leads from a number, an address, a registration transaction and a listing code to the right view',async()=>{
 const find=async(words,at)=>{await go('/');await page.locator('[data-field=search]').fill(words);await page.keyboard.press('Enter');await shown(at);};
 await find('7','/mordinal/7');
 assert.match(await text('h1'),/Mordinal #7/);
 await find(W.erin,'/address/'+W.erin);
 assert.equal(await count('[data-section=owned] .mcard'),3);
 assert.match(await text('[data-section=activity]'),/Put up for sale by/);
 const three=(await get('/mordinal/3')).mordinal;
 await find(three.reg,'/mordinal/3');
 await find(three.lot.id,'/lot/'+three.lot.id);
 await go('/');await page.locator('[data-field=search]').fill('300');await page.locator('[data-action=search]').click();
 await page.locator('#main .error').waitFor();assert.match(await text('#main .error'),/numbered from 0 to 299/);
 await page.locator('[data-field=search]').fill('not something to find');await page.keyboard.press('Enter');
 await page.locator('#main .error:has-text("not a Mordinal number")').waitFor();});

test('the gallery pages through the list, filters it, and shows pictures only when they may be shown',async()=>{
 await go('/gallery');
 assert.equal(await count('.mcard'),60);assert.equal(await text('[data-where]'),'1–60 of 300');
 await page.locator('[data-number="0"] .pic[data-state=shown] img').waitFor();
 assert.ok(await page.locator('[data-number="0"] .pic img').evaluate(i=>i.complete&&i.naturalWidth>0),'picture 0 did not load');
 await page.locator('[data-number="4"] .pic[data-state=text]').waitFor();
 assert.equal(await page.locator('[data-number="4"] .pic .mtext').evaluate(e=>e.textContent),'777');assert.equal(await page.locator('[data-number="4"] .pic .mtext').getAttribute('class'),'mtext xl');
 await page.locator('[data-number="13"]').scrollIntoViewIfNeeded();await page.locator('[data-number="13"] .pic[data-state=none]').waitFor();assert.equal(await text('[data-number="13"] .pic'),'Not a picture');
 await page.locator('[data-number="22"]').scrollIntoViewIfNeeded();await page.locator('[data-number="22"] .pic[data-state=hidden]').waitFor();assert.equal(await page.locator('[data-number="22"] .mtext').count(),0);
 await page.locator('[data-number="22"] .pic button').click();await page.locator('[data-number="22"] .pic[data-state=text]').waitFor();
 assert.match(await text('[data-number="22"] .mtext'),/^Demo text inscription 22\. A plain text/);
 assert.ok(await page.locator('[data-number="4"] .pic .mtext').evaluate(e=>{const b=e.parentElement.getBoundingClientRect(),r=e.getBoundingClientRect();return r.width>0&&r.left>=b.left&&r.right<=b.right&&r.top>=b.top&&r.bottom<=b.bottom&&parseFloat(getComputedStyle(e).fontSize)>20;}),'the short text fills the box without spilling out');
 assert.equal(await text('[data-number="5"] .pic'),'No picture');
 // An SVG document shows as the picture the service drew from it.
 await page.locator('[data-number="23"]').scrollIntoViewIfNeeded();await page.locator('[data-number="23"] .pic[data-state=shown] img').waitFor();
 assert.equal(await page.locator('[data-number="23"] .pic img').evaluate(i=>i.complete&&i.naturalWidth),1024);
 assert.equal(await text('[data-number="3"] .price'),'2 XMR');
 assert.equal(await text('[data-number="3"] [data-claimed]'),'Claimed');assert.equal(await text('[data-number="7"] [data-claimed]'),'Unclaimed');
 // The sensitive picture stays hidden until asked for.
 const hidden=page.locator('[data-number="11"] .pic');
 await hidden.scrollIntoViewIfNeeded();await page.locator('[data-number="11"] .pic[data-state=hidden]').waitFor();
 assert.equal(await hidden.locator('img').count(),0);assert.match(await hidden.innerText(),/Hidden/);
 await shot('gallery');await narrow('gallery-360');
 await hidden.locator('button',{hasText:'Show'}).click();
 await page.locator('[data-number="11"] .pic[data-state=shown] img').waitFor();
 assert.equal(page.url(),`${root}/view/#/gallery`,'pressing Show left the gallery');
 // Paging.
 await page.locator('.pager a',{hasText:'Next'}).click();await shown('/gallery?filter=all&from=60');
 assert.equal(await text('[data-where]'),'61–120 of 300');
 assert.equal(await page.locator('.mcard').first().getAttribute('data-number'),'60');
 await page.locator('.pager a',{hasText:'Last'}).click();await shown('/gallery?filter=all&from=240');
 assert.equal(await text('[data-where]'),'241–300 of 300');
 assert.equal(await count('.pager a:has-text("Next")'),0);
 await page.locator('.pager a',{hasText:'First'}).click();await shown('/gallery?filter=all');
 // Filters.
 await page.locator('.pills button[data-value=claimed]').click();await shown('/gallery?filter=claimed');
 assert.equal(await count('.mcard'),9);assert.equal(await count('.mcard [data-claimed=false]'),0);
 await page.locator('.pills button[data-value=unclaimed]').click();await shown('/gallery?filter=unclaimed');
 assert.equal(await text('[data-where]'),'1–60 of 291');assert.equal(await count('.mcard [data-claimed=true]'),0);
 await page.locator('.pills button[data-value=listed]').click();await shown('/gallery?filter=listed');
 assert.deepEqual((await page.locator('.mcard .price').allTextContents()).sort(),['0.25 XMR','0.45 XMR','2 XMR']);
 await page.locator('.mcard[data-number="8"] a.meta').click();await shown('/mordinal/8');});

test('one Mordinal answers "is it claimed?" with its owner, picture and whole history',async()=>{
 await go('/mordinal/2');
 assert.match(await text('[data-answer=claimed]'),/Claimed\s*owned by/);
 assert.equal(await text('[data-answer=claimed] .exact .v'),W.bob);
 assert.equal(await page.locator('[data-answer=claimed] .exact button').getAttribute('data-copy'),W.bob);
 await page.locator('.pic.large[data-state=shown] img').waitFor();
 const history=await page.locator('[data-section=history] tbody tr').allInnerTexts();
 assert.equal(history.length,2);assert.match(history[0],/Inscribed/);assert.match(history[1],/Claimed by/);
 // Long values are shortened; the whole value is in the title and on the copy button.
 const chip=page.locator('[data-section=history] tbody tr').nth(1).locator('.chip').first();
 assert.equal(await chip.locator('.v').getAttribute('title'),W.bob);
 assert.ok((await chip.locator('.v').textContent()).length<20);
 await chip.locator('button').click();
 assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),W.bob);
 const reg=(await get('/mordinal/2')).mordinal.reg;
 assert.equal(await page.locator('dl.kv .chip .v').first().getAttribute('title'),reg);

 await go('/mordinal/7');
 assert.match(await text('[data-answer=unclaimed]'),/Not claimed yet/);
 assert.match(await text('[data-answer=unclaimed]'),/XMR20 wallet or with the command-line tool/);
 assert.equal(await count('[data-section=owner]'),0);assert.equal(await count('[data-section=listing]'),0);

 await go('/mordinal/3');
 assert.equal(await text('[data-answer=claimed] .exact .v'),W.carol);
 assert.match(await text('[data-section=listing]'),/2 XMR/);assert.match(await text('[data-section=listing]'),/1\.9 XMR/);
 assert.match(await text('[data-section=history]'),/Moved in 2023/);
 await shot('mordinal-claimed');await narrow('mordinal-360');

 await go('/mordinal/4');
 await page.locator('.pic.large[data-state=text]').waitFor();assert.equal(await text('.pic.large'),'777');
 // A short text fits its box whole: nothing to scroll (a scroll bar would show beside it where bars take room).
 assert.deepEqual(await page.locator('.pic.large .mtext').evaluate(e=>[e.scrollHeight<=e.clientHeight,e.scrollWidth<=e.clientWidth,getComputedStyle(e).overflowY]),[true,true,'hidden']);await shot('mordinal-text');
 await go('/mordinal/13');
 await page.locator('.pic.large[data-state=none]').waitFor();assert.equal(await text('.pic.large'),'Not a picture');
 await go('/mordinal/10');
 assert.match(await text('[data-section=listing]'),/Reserved by/);});

test('a signature that does not fit is refused in the page and nothing is posted',async()=>{
 await go('/mordinal/9');
 await page.locator('[data-action=own]').click();await page.locator('[data-action=send-start]').click();await shown('/mordinal/9/send');
 await page.locator('[data-field=to]').fill('not an address');await page.locator('[data-action=next]').click();
 await page.locator('[data-section=owner] .error').waitFor();
 await page.locator('[data-field=to]').fill(W.alice);await page.locator('[data-action=next]').click();
 const words=await text('[data-signtext]');
 assert.match(words,/#9/);assert.ok(words.includes(W.alice)&&!words.includes('\n'));
 const before=posted.length;
 for(const wrong of ['hello',await sign('dave',words),await sign('erin',words+' ')]){
  await page.locator('[data-field=signature]').fill(wrong);await page.locator('[data-action=send]').click();
  await page.locator('[data-sign] .error').waitFor();
  assert.match(await text('[data-sign] .error'),/Nothing was sent\.$/);
  assert.equal(await count('[data-sent]'),0);}
 assert.equal(posted.length,before,'a record was posted with a wrong signature');
 assert.equal(await ownerOf(9),W.erin);});

test('send: the owner signs, the record waits, and it counts once a block holds it',async()=>{
 // Still on the signing step for Mordinal #9, from erin to alice.
 await signAndSend('erin');
 await stillWaiting();
 assert.equal(await ownerOf(9),W.erin);
 await demo.mine();
 await page.locator('[data-sent] .good').waitFor({timeout:15000});
 assert.match(await text('[data-sent] .good'),/Sent\. The record is in block \d+/);
 await go('/mordinal/9');
 assert.equal(await text('[data-answer=claimed] .exact .v'),W.alice);
 assert.match(await text('[data-section=history]'),/Sent by/);});

test('sell and stop selling through the page',async()=>{
 await go('/mordinal/12');
 await page.locator('[data-action=own]').click();await page.locator('[data-action=sell-start]').click();await shown('/mordinal/12/sell');
 await page.locator('[data-field=price]').fill('0.3');
 assert.match(await text('[data-split]'),/You receive 0\.285 XMR · protocol fee 0\.015 XMR/);
 // A sale runs 30 days unless the seller picks 1 or 7; the end block is in the signed text.
 assert.deepEqual(await page.locator('.pills button').allInnerTexts(),['1 day','7 days','30 days']);
 assert.equal(await text('.pills button[aria-pressed=true]'),'30 days');
 const height=(await get('/mordinal/12')).height;
 assert.match(await text('p.muted:has-text("The sale ends at block")'),new RegExp(`ends at block ${(height+21540).toLocaleString('en-US')}, about 30 days from now`));
 await page.locator('[data-action=next]').click();
 assert.match(await text('[data-signtext]'),new RegExp(`until block ${height+21540};`));
 assert.match(await signAndSend('carol'),/0\.3 XMR/);
 await stillWaiting();
 await demo.mine();
 await page.locator('[data-sent] .good').waitFor({timeout:15000});
 await go('/market');
 const row=page.locator('[data-section=listings] .lotcard',{hasText:'#12'});
 assert.match(await row.innerText(),/0\.3 XMR/);assert.match(await row.innerText(),/Open/);

 await go('/mordinal/12');
 assert.match(await text('[data-section=listing]'),/0\.3 XMR/);
 await page.locator('[data-action=own]').click();
 assert.equal(await count('[data-action=send-start]'),0,'a listed Mordinal offers Send');
 await page.locator('[data-action=stop]').click();await shown('/mordinal/12/stop');
 await signAndSend('carol');
 await stillWaiting();
 await demo.mine();
 await page.locator('[data-sent] .good').waitFor({timeout:15000});
 await go('/market');
 assert.equal(await count('[data-section=listings] .lotcard:has-text("#12")'),0);
 await go('/mordinal/12');
 assert.equal(await count('[data-section=listing]'),0);
 assert.equal(await text('[data-answer=claimed] .exact .v'),W.carol);});

test('buy: reserve by signing, pay the exact amounts, finish, and the buyer owns it',async()=>{
 const lot=await lotOf(8),at=`/buy/${lot}/${W.alice}`;
 await go('/market');
 assert.equal(await count('[data-section=listings] .lotcard'),3);
 assert.match(await text('[data-section=listings] .lotcard:has-text("#10")'),/Reserved/);
 assert.match(await text('[data-section=sales]'),/1\.5 XMR/);
 await shot('market');await narrow('market-360');
 await page.locator('[data-section=listings] .lotcard',{hasText:'#8'}).locator('a',{hasText:'Buy now'}).click();await shown('/lot/'+lot);
 assert.equal(await text('[data-price]'),'0.25 XMR');
 assert.equal(await page.locator('[data-section=terms] .chip .v').first().getAttribute('title'),W.erin);
 await page.locator('[data-field=buyer]').fill(W.erin);await page.locator('[data-action=buy]').click();
 assert.match(await text('[data-section=buy] .error'),/seller/);
 await page.locator('[data-field=buyer]').fill(W.alice);await page.locator('[data-action=buy]').click();await shown(at);

 // Step 1: the reservation.
 await page.locator('[data-stage=reserve]').waitFor();
 const words=await text('[data-signtext]');
 assert.match(words,/reserve/);assert.match(words,/#8 for 0\.25 XMR/);assert.ok(words.includes(W.erin)&&words.includes(feeAddress)&&words.includes(W.alice));
 await shot('buy-sign',true);await narrow();
 await signAndSend('alice');
 await stillWaiting();
 assert.equal(await count('[data-payment]'),0,'payments are shown before the reservation is in a block');
 await demo.mine();

 // Step 2: the two exact payments.
 await page.locator('[data-stage=pay]').waitFor({timeout:15000});
 const read=async()=>({amounts:[await text('[data-payment="1"] .exact.big .v'),await text('[data-payment="2"] .exact.big .v')],
  to:[await text('[data-payment="1"] .exact:not(.big) .v'),await text('[data-payment="2"] .exact:not(.big) .v')]});
 const pay=await read();
 assert.deepEqual(pay.to,[W.erin,feeAddress]);
 assert.ok(words.includes(`exactly ${pay.amounts[0]} XMR`)&&words.includes(`exactly ${pay.amounts[1]} XMR`),'the amounts differ from the signed text');
 assert.match(pay.amounts[0],/^0\.2375\d{8}$/);assert.match(pay.amounts[1],/^0\.0125\d{8}$/);
 assert.equal(await page.locator('[data-deadline]').getAttribute('data-late'),'false');
 await page.locator('[data-payment="1"] .exact.big button').click();
 assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),pay.amounts[0]);
 await shot('buy-pay',true);await narrow('buy-pay-360');

 // Loading the page again, or coming back by address, leads to the same step with the same amounts.
 await page.reload();await page.locator('[data-stage=pay]').waitFor();
 assert.deepEqual(await read(),pay);
 await go('/market');
 await page.locator('[data-field=continue]').fill(W.alice);await page.locator('[data-action=continue]').click();await shown('/address/'+W.alice);
 await page.locator('[data-section=buying] a',{hasText:'Continue'}).click();await shown(at);
 await page.locator('[data-stage=pay]').waitFor();
 assert.deepEqual(await read(),pay);

 // Step 3: the payment's transaction id and key.
 const before=posted.length;
 await page.locator('[data-action=finish]').click();
 assert.match(await text('[data-stage=pay] .error'),/Paste the transaction id and transaction key/);
 await page.locator('[data-field=txid]').fill('1234');await page.locator('[data-field=key]').fill('5678');await page.locator('[data-action=finish]').click();
 assert.match(await text('[data-stage=pay] .error'),/64 hexadecimal characters/);
 assert.equal(posted.length,before);
 const paid=await post('/test/payment',{pay:[{to:pay.to[0],amount:atomic(pay.amounts[0])},{to:pay.to[1],amount:atomic(pay.amounts[1])}]});
 // A key that is not this payment's key makes no proof, and nothing is posted.
 await page.locator('[data-field=txid]').fill(paid.txid);await page.locator('[data-field=key]').fill('01'+'00'.repeat(31));await page.locator('[data-action=finish]').click();
 await page.locator('[data-stage=pay] .error').waitFor();
 assert.match(await text('[data-stage=pay] .error'),/pays nobody in this reservation with the key given/);
 assert.equal(posted.length,before);
 // The transaction key is not kept by the page and is not in the record it posts.
 await page.locator('[data-field=key]').fill(paid.keys.join(''));
 assert.ok(!(await page.evaluate(()=>JSON.stringify(Object.entries(sessionStorage)))).includes(paid.keys[0]),'the page kept the transaction key');
 const sentBody=page.waitForRequest(r=>r.method()==='POST'&&new URL(r.url()).pathname==='/records');
 await page.locator('[data-action=finish]').click();
 const record=JSON.parse((await sentBody).postData()).record;
 assert.equal(record.length,2*296);assert.ok(paid.keys.every(k=>!record.includes(k)),'the record shows a transaction key');
 await page.locator('[data-stage=finishing]').waitFor();
 await demo.step();
 await page.locator('[data-stage=finishing] .status[data-state=held]').waitFor({timeout:15000});
 assert.match(await text('[data-stage=finishing] .status'),/Waiting for your payment to be in a block/);
 assert.equal(await ownerOf(8),W.erin);
 // While it waits, the page can be loaded again without losing the purchase.
 await page.reload();await page.locator('[data-stage=finishing]').waitFor();
 await demo.mine();await demo.mine();
 await page.locator('[data-stage=sold]').waitFor({timeout:20000});
 assert.match(await text('[data-stage=sold]'),/Mordinal #8 is yours/);
 assert.equal(await ownerOf(8),W.alice);
 await go('/mordinal/8');
 assert.equal(await text('[data-answer=claimed] .exact .v'),W.alice);
 assert.match(await text('[data-section=history]'),/Sold for 0\.25 XMR/);
 await go('/market');
 assert.match(await text('[data-section=sales] tbody tr:first-child'),/#8/);
 await go('/lot/'+lot);
 assert.match(await text('[data-section=buy]'),/Sold/);assert.equal(await count('[data-action=buy]'),0);});

test('a reservation that ran out warns not to pay',async()=>{
 const lot=await lotOf(10),v=await get('/lot/'+lot),payBy=v.lot.reservation.payBy;
 assert.equal(v.lot.reservation.buyer,W.dave);assert.ok(payBy>=v.height);
 await go(`/buy/${lot}/${W.dave}`);
 await page.locator('[data-stage=pay]').waitFor();
 assert.equal(await page.locator('[data-deadline]').getAttribute('data-late'),'false');
 assert.match(await text('[data-deadline]'),new RegExp(`Pay both exact amounts by block ${payBy}\\.`));
 // Someone else sees that it is taken.
 await go(`/buy/${lot}/${W.bob}`);
 assert.match(await text('[data-stage=taken]'),/Reserved by/);
 await go(`/buy/${lot}/${W.dave}`);await page.locator('[data-stage=pay]').waitFor();
 await demo.mine(payBy-v.height+1);
 // The open page notices by itself.
 await page.locator('[data-deadline][data-late=true]').waitFor({timeout:15000});
 assert.match(await text('[data-deadline]'),new RegExp(`This reservation ran out at block ${payBy}\\. Do not pay now\\.`));
 assert.equal(await page.locator('[data-deadline] [role=alert]').count(),1);
 await shot('buy-late');await narrow();
 await page.reload();await page.locator('[data-deadline][data-late=true]').waitFor();});

test('a first visit to the market shows the tutorial once; it can be left at any step and opened again',async()=>{
 const visitor=await browser.newContext({viewport:{width:1280,height:900}}),fresh=watch(await visitor.newPage());
 await fresh.goto(`${root}/view/#/market`);
 const tour=fresh.locator('dialog[data-tutorial]');await tour.waitFor();
 assert.match(await tour.locator('.label').textContent(),/Step 1 of 4/);assert.equal(await tour.locator('[data-action=back]').count(),0);
 await tour.locator('[data-action=next]').click();assert.match(await tour.locator('h2').textContent(),/Open the wallet/);
 assert.equal(await tour.locator('[data-action=connect]').isDisabled(),true);
 await tour.locator('[data-action=next]').click();await tour.locator('[data-action=next]').click();
 assert.match(await tour.locator('.label').textContent(),/Step 4 of 4/);assert.equal(await tour.locator('[data-action=next]').count(),0);
 await tour.locator('[data-action=back]').click();assert.match(await tour.locator('.label').textContent(),/Step 3 of 4/);
 await tour.locator('[data-action=skip]').click();assert.equal(await fresh.locator('dialog[data-tutorial]').count(),0);
 assert.ok(await fresh.locator('[data-section=listings] .lotcard').count()>=1,'the market is behind it');
 await fresh.reload();await fresh.locator('[data-section=listings]').waitFor();await fresh.waitForTimeout(200);
 assert.equal(await fresh.locator('dialog[data-tutorial]').count(),0,'not shown a second time');
 await fresh.locator('[data-action=tutorial]').click();await fresh.locator('dialog[data-tutorial]').waitFor();
 await fresh.keyboard.press('Escape');await visitor.close();});

test('the market shows the newest history beside the listings, and the GENESIS collection',async()=>{
 await go('/market');
 assert.match(await text('h1'),/Mordinals \/ XMR721/);
 assert.ok(await count('[data-section=history] .feed li')>=5);
 await page.locator('.pills [data-value=genesis]').click();await shown('/market?show=genesis');
 assert.equal(await count('[data-section=collection] [data-edition]'),100);
 const first=page.locator('[data-edition="1"] img');await first.scrollIntoViewIfNeeded();
 await page.waitForFunction(()=>{const i=document.querySelector('[data-edition="1"] img');return i&&i.complete&&i.naturalWidth===1024&&i.naturalHeight===1524;});   // its text over its picture, 128 characters wide
 await page.waitForFunction(()=>{const i=document.querySelector('[data-edition="2"] img');return i&&i.complete&&i.naturalWidth>0;});
 assert.equal(await count('[data-section=history]'),1);
 await page.locator('[data-edition="4"] .meta').click();await shown('/nft/genesis/4');
 assert.match(await text('h1'),/The Scream/);assert.match(await text('.kv'),/Edvard Munch/);
 await go('/xmr721');assert.equal(await count('[data-section=steps] .guide > li'),3);
 // Collections: Mordinals as a whole, GENESIS, and the collections of the index (in the demo, real names on made-up numbers).
 await go('/collections');assert.deepEqual((await page.locator('.ccard .n').allTextContents()).slice(0,2),['Mordinals','GENESIS']);
 assert.equal(await count('.ccard[data-kind=group]'),10);assert.match(await text('.ccard[data-kind=group] .n'),/Monero Punks/);
 await page.waitForFunction(()=>document.querySelectorAll('.ccard[data-kind=held] .mosaic img').length===3);
 const group=await page.locator('.ccard[data-kind=group]').nth(4).getAttribute('href');await page.locator(`.ccard[href="${group}"]`).click();await shown(group.slice(1));
 assert.match(await text('h1'),/Retarded Rat/);assert.equal(await count('[data-section=group-items] .mcard'),24);
 const member=await page.locator('[data-section=group-items] .mcard').first().getAttribute('data-number');
 await go('/mordinal/'+member);assert.match(await text('.kv'),/Collection\s*Retarded Rat/);
 await go('/market');assert.equal(await count('[data-section=collections] .ccard'),6);assert.equal(await count('[data-section=wallet]'),0,'no wallet link, no wallet panel');});

test('activity pages through older events',async()=>{
 // Eight more records, so the newest activity no longer fits one page.
 const w=demo.wallets;
 for(let i=0;i<8;i++){
  const [from,to]=i%2?[w.bob,w.dave]:[w.dave,w.bob];
  await post('/records',{record:Buffer.from(demo.make.move(14,from,to)).toString('hex')});await demo.mine();}
 const total=(await get('/activity?limit=1')).total;assert.ok(total>25);
 await go('/');
 const rows=page.locator('[data-section=activity] tbody tr');
 assert.equal(await rows.count(),25);
 assert.match(await rows.first().innerText(),/Sent by/);
 await page.locator('[data-section=activity] .pager a',{hasText:'Older'}).click();
 await page.locator('[data-section=activity] h2:has-text("Earlier XMR721 activity")').waitFor();
 assert.equal(await rows.count(),total-25);
 assert.match(await rows.last().innerText(),/Claimed by/);
 assert.equal(await count('[data-section=activity] .pager a:has-text("Older")'),0);
 await page.locator('[data-section=activity] .pager a',{hasText:'Newest'}).click();await shown('/');
 assert.equal(await rows.count(),25);});

test('about shows the newest checkpoint and how to recompute it',async()=>{
 const c=await get('/checkpoint');
 await go('/about');
 const box=await text('[data-section=checkpoint]');
 for(const value of [c.blockHash,c.listHash,c.stateHash])assert.ok(box.includes(value));
 assert.ok(box.includes('Block '+c.height));
 assert.match(await text('[data-section=verify]'),/tools\/verify\.mjs/);
 assert.match(await text('#main'),/charges nothing in this version/);
 await shot('about');await narrow('about-360');});

test('a service without a relay is shown as read-only',async()=>{
 const quiet=watch(await context.newPage());
 await quiet.route('**/info',async route=>{const answer=await route.fetch(),info=await answer.json();info.relay=null;await route.fulfill({response:answer,json:info});});
 const open=async at=>{await quiet.goto(`${root}/view/#${at}`);await quiet.locator(`#main > .view[data-at="${at}"]`).waitFor();};
 await open('/mordinal/2');
 assert.match(await quiet.locator('[data-section=owner]').innerText(),/Records cannot be sent from here/);
 assert.equal(await quiet.locator('[data-action=own]').count(),0);
 const lot=await lotOf(3);
 await open('/lot/'+lot);
 assert.match(await quiet.locator('[data-section=buy]').innerText(),/Records cannot be sent from here/);
 assert.equal(await quiet.locator('[data-action=buy]').count(),0);
 await open(`/buy/${lot}/${W.bob}`);
 assert.equal(await quiet.locator('[data-stage=read-only]').count(),1);assert.equal(await quiet.locator('[data-sign]').count(),0);
 await open('/market');
 assert.equal(await quiet.locator('[data-section=continue]').count(),0);
 await open('/about');
 assert.match(await quiet.locator('#main').innerText(),/only reads/);
 await quiet.close();});

test('no view scrolls sideways at 360 px',async()=>{
 const lot=await lotOf(3);
 await page.setViewportSize({width:360,height:740});
 for(const at of ['/','/?kind=sale','/gallery','/gallery?filter=listed','/mordinal/3','/mordinal/7','/mordinal/3/stop','/mordinal/2/send','/mordinal/2/sell','/market','/market?show=genesis','/xmr721','/collections','/nft/genesis/4','/lot/'+lot,
  `/buy/${lot}/${W.bob}`,'/address/'+W.alice,'/about','/search?q=nothing','/nowhere']){
  await go(at);await page.waitForTimeout(150);await noSideScroll();}
 await page.setViewportSize({width:1280,height:900});});

test('the browser reported no errors, broke no policy and asked for nothing outside',()=>{
 assert.deepEqual(problems,[]);
 assert.deepEqual(blocked,[]);
 assert.ok(posted.length>0&&posted.every(p=>p==='/records'),'the pages posted to something other than /records');});

test('on its first day the activity page shows the original history and waits for XMR721 activity',async()=>{
 const fresh=await startDemo({port:0,auto:0,seed:false}),at=`http://127.0.0.1:${fresh.port}`,p=await context.newPage();
 try{
  await p.goto(at+'/view/#/');await p.locator('#main > .view[data-at="/"]').waitFor();
  assert.equal(await p.locator('[data-section=activity][data-empty]').count(),1);
  assert.match(await p.locator('[data-section=activity]').innerText(),/Waiting for activity/);
  assert.equal(await p.locator('[data-section=legacy] tbody tr').count(),25);
  await p.locator('[data-section=legacy] .pills button[data-value=transfer]').click();await p.locator('#main > .view[data-at="/?h=transfer"]').waitFor();
  assert.equal(await p.locator('[data-section=legacy] tbody tr').count(),3);
  await p.goto(at+'/view/#/market');await p.locator('#main > .view[data-at="/market"]').waitFor();
  assert.equal(await p.locator('[data-section=history][data-legacy] .feed li').count(),9,'the market rail falls back to the original history');
  assert.match(await p.locator('[data-section=listings]').innerText(),/Nothing is for sale right now/);
 }finally{await p.close();await fresh.close();}});
