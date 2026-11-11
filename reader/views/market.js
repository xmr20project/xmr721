// The market: open listings, recent sales, one listing, and buying it by signing a message and paying from any wallet.
import {OP,RULES,heldUntil,encodeBody,renderText,recordId,codeOf,amounts,splitOf,formatXmr,canonical,parseTxKey,provePayments,hex} from './rules.js';
import {el,add,fill,api,service,count,xmr,addr,code,exact,notice,pill,pills,strong,table,when,pictures,terms,running,field,textInput,mordinalLink,draft,kindPill,eventText,ROOT} from './ui.js';
import {tutorial} from './xmr721.js';
import {collectionGrid} from './collection.js';
import {walletPanel,watchWallet} from './wallet.js';
import {collectionCards} from './collections.js';
import {subject,nftPicture} from './nft.js';
import {signPanel,sent,follow} from './sign.js';

const READ_ONLY='Records cannot be sent from here: this service only reads. Use the XMR20 wallet or the command-line tool to buy.';
// A Monero block takes about two minutes.
const minutes=blocks=>blocks*2;
const fact=(label,value)=>el('div',{},el('dt',{text:label}),el('dd',{},value));

function costs(){
 return el('ul',{class:'plain'},
  el('li',{text:'Signing a message moves no XMR.'}),
  el('li',{text:'The relay pays the Monero network fee of each record and charges nothing in this version.'}),
  el('li',{text:'A buyer pays the price in two payments: to the seller, and the 5% protocol fee to the fee address. Your own wallet adds its normal network fee for those payments.'}),
  el('li',{text:'A record counts only once it is in a Monero block. Until then it is shown as waiting.'}));}

const SHOW=[['mordinals','Mordinals'],['genesis','GENESIS']];
// The newest records, short, for the side of the market.
function history(events){
 return el('aside',{class:'side card stack','data-section':'history'},
  el('div',{class:'section-head'},el('h2',{text:'History'}),el('a',{class:'dim',href:'#/',text:'All'})),
  events.length?el('ul',{class:'feed'},events.map(e=>el('li',{'data-kind':e.kind},
   el('div',{class:'feed-top'},kindPill(e.kind),mordinalLink(e.number??e.nft),el('span',{class:'dim',text:when(e.time).slice(5,16)})),
   el('div',{class:'feed-text'},eventText(e))))):el('p',{class:'empty',text:'Nothing has happened yet.'}));}

export async function market(ctx){
 ctx.title('Market');const info=service.info;
 const asked=ctx.query.get('show'),show=SHOW.some(([k])=>k===asked)?asked:'mordinals';
 const [l,s,a,grid]=await Promise.all([api('/listings',{signal:ctx.signal}),api('/sales?limit=10',{signal:ctx.signal}),api('/activity?limit=12',{signal:ctx.signal}),
  show==='genesis'?collectionGrid(ctx,'genesis'):null]);
 const pic=pictures(ctx),height=l.height;ctx.tip(height);
 const mine=await walletPanel(ctx,pic);watchWallet(ctx,()=>ctx.reload());
 const strip=await collectionCards(ctx,{limit:6});
 const rows=l.listings.map(x=>{try{return terms(x);}catch{return {unfit:true,id:x.id,number:x.number};}});
 const who=textInput({class:'mono','data-field':'continue',placeholder:'Your Monero address','aria-label':'Your Monero address'}),problem=el('div',{});
 const resume=()=>{try{location.hash='#/address/'+canonical(who.value,info.network);}catch(e){problem.replaceChildren(notice('error',e.message));}};
 who.addEventListener('keydown',e=>{if(e.key==='Enter')resume();});
 const mordinals=()=>[
  el('section',{class:'section','data-section':'listings'},el('div',{class:'section-head'},el('h2',{text:'For sale'}),el('span',{class:'dim',text:count(rows.length)})),
   table([
    {label:'NFT',cell:t=>el('div',{class:'with-thumb'},Number.isInteger(t.number)?pic(t.number,{size:'thumb'}):t.nft&&!t.unfit?el('img',{class:'thumb-img',alt:'',loading:'lazy',src:new URL(`nft/${t.nft}/content`,ROOT).href}):null,t.unfit?'':mordinalLink(t.number??t.nft))},
    {label:'Price',cell:t=>t.unfit?'':strong(xmr(t.price)+' XMR')},
    {label:'Seller',cell:t=>t.unfit?'This listing does not fit its code and cannot be bought here.':addr(t.seller)},
    {label:'Ends at block',num:true,cell:t=>t.unfit?'':count(t.until)},
    {label:'State',cell:t=>t.unfit?'':running(t,height)?pill('Reserved','purple'):pill('Open','green')},
    {label:'',cell:t=>t.unfit?'':el('a',{class:'btn small',href:'#/lot/'+t.id,text:'See and buy'})}],rows,'Nothing is for sale right now.')),
  el('section',{class:'section about-grid'},
   el('div',{class:'card stack'},el('h2',{text:'How buying works'}),
    el('ol',{class:'plain'},
     el('li',{text:'Reserve: you sign a message with the Monero address that will own the Mordinal. The text names both payments.'}),
     el('li',{text:`Pay: once the reservation is in a block you have up to ${RULES.maxReserve} blocks (about ${minutes(RULES.maxReserve)} minutes) to pay the exact amounts from your own wallet.`}),
     el('li',{text:'Finish: you paste each payment’s transaction id and transaction key. When that record is in a block, the Mordinal is yours.'})),
    info.relay?null:notice('note',READ_ONLY)),
   el('div',{class:'card stack'},el('h2',{text:'What it costs'}),costs())),
  info.relay?el('section',{class:'section card stack','data-section':'continue'},el('h2',{text:'Continue a purchase'}),
   el('p',{class:'muted',text:'Started buying and closed the page? Enter the address you reserved with.'}),
   el('div',{class:'search'},who,el('button',{type:'button',class:'btn','data-action':'continue',text:'Continue',onclick:resume})),problem):null,
  el('section',{class:'section','data-section':'sales'},el('div',{class:'section-head'},el('h2',{text:'Recent sales'})),
   table([{label:'NFT',cell:e=>mordinalLink(e.number??e.nft)},{label:'Price',cell:e=>strong(xmr(e.price)+' XMR')},{label:'Seller',cell:e=>addr(e.seller)},
    {label:'Buyer',cell:e=>addr(e.buyer)},{label:'Block',num:true,cell:e=>count(e.height)},{label:'Time',num:true,cell:e=>when(e.time)}],s.events,'No sales yet.'))];
 add(ctx.main,
  el('div',{class:'head'},el('h1',{text:'Mordinals / XMR721'}),
   el('p',{class:'lede',text:'Buy and sell Mordinals as XMR721 NFTs, for XMR. The buyer pays the seller directly; no one holds the money or the NFT in between.'}),
   el('div',{class:'row head-row'},
    pills(SHOW,show,v=>{location.hash='#/market'+(v==='mordinals'?'':'?show='+v);},'Collection'),
    el('button',{type:'button',class:'btn small','data-action':'tutorial',text:'How it works',onclick:()=>tutorial(ctx,{force:true})}),
    el('a',{class:'btn small',href:'#/xmr721',text:'Claim your Mordinals'}))),
  el('div',{class:'market'},
   el('div',{class:'market-main'},mine,
    el('section',{class:'section','data-section':'collections'},el('div',{class:'section-head'},el('h2',{text:'Collections'}),el('a',{class:'dim',href:'#/collections',text:'All collections'})),
     el('div',{class:'cgrid strip'},strip.cards)),
    show==='genesis'?grid:mordinals()),
   history(a.events)));
 tutorial(ctx);}

export async function lot(ctx,id){
 const info=service.info;
 const v=await api('/lot/'+id,{signal:ctx.signal}),t=terms(v.lot),height=v.height,held=running(t,height),ended=t.until<height;
 const pic=pictures(ctx),s=splitOf(t.price),about=await subject(ctx,t,pic);
 ctx.title('Listing of '+about.name);ctx.tip(height);
 const state=t.status==='sold'?pill('Sold','green'):t.status==='cancelled'?pill('Stopped'):ended?pill('Ended'):held?pill('Reserved','purple'):pill('Open','green');
 const buyBox=el('div',{class:'card stack','data-section':'buy'});
 if(t.status==='sold')add(buyBox,el('h2',{text:'Sold'}),el('p',{class:'muted'},'Bought by ',v.lot.buyer?addr(v.lot.buyer):'another address','.'));
 else if(t.status!=='open')add(buyBox,el('h2',{text:'Not for sale'}),el('p',{class:'muted',text:'The seller stopped this sale.'}));
 else if(ended)add(buyBox,el('h2',{text:'Not for sale'}),el('p',{class:'muted',text:'This sale ended at block '+count(t.until)+'.'}));
 else if(!info.relay)add(buyBox,el('h2',{text:'Buy'}),notice('note',READ_ONLY));
 else{
  const who=textInput({class:'mono','data-field':'buyer'}),problem=el('div',{});
  const start=()=>{let me;
   try{me=canonical(who.value,info.network);if(me===t.seller)throw Error('This is the seller’s address. The seller cannot buy their own Mordinal.');}
   catch(e){problem.replaceChildren(notice('error',e.message));return;}
   location.hash=`#/buy/${t.id}/${me}`;};
  who.addEventListener('keydown',e=>{if(e.key==='Enter')start();});
  add(buyBox,el('h2',{text:'Buy'}),
   held?notice('note','Reserved by ',addr(held.buyer),' until block '+count(held.payBy)+'. If it is not paid by then, it can be reserved again. If this is your reservation, enter your address to continue.'):null,
   field('Your Monero address',who,'The Mordinal will belong to this address. You sign a message with it, so use an address of a wallet that has “Sign message”.'),problem,
   el('div',{class:'row'},el('button',{type:'button',class:'btn primary',text:held?'Continue':'Buy','data-action':'buy',onclick:start})),
   el('p',{class:'dim',text:'Nothing is paid in this step.'}));}
 add(ctx.main,
  el('div',{class:'head'},el('a',{class:'crumb',href:'#/market',text:'Market'}),
   el('h1',{class:'small'},about.name)),
  el('div',{class:'split'},about.picture('large'),
   el('div',{class:'stack'},
    el('div',{class:'card stack answer','data-section':'terms'},el('div',{class:'section-head'},el('p',{class:'label',text:'Price'}),state),
     el('p',{class:'big','data-price':'',text:xmr(t.price)+' XMR'}),
     el('dl',{class:'kv'},fact('Seller',addr(t.seller)),fact(ended?'Ended at block':'Ends at block',count(t.until)),
      fact('Seller receives',formatXmr(s.seller)+' XMR'),fact('Protocol fee (5%)',formatXmr(s.fee)+' XMR'),
      fact('Listing code',code(t.id)),fact(t.nft?'NFT':'Mordinal',el('a',{href:about.href,text:'See its page and history'}))),
     el('p',{class:'dim',text:'Price, seller and end block are read from the seller’s signed listing, checked against its code in your browser.'})),
    buyBox)),
  v.waiting.length?el('section',{class:'section'},notice('note','A record for this Mordinal is waiting for a block.')):null,
  el('section',{class:'section card stack'},el('h2',{text:'What it costs'}),costs()));}

// Buying one listing as one address. Where the purchase stands is worked out from the service each time,
// so the page can be closed and opened again at any step.
export async function buy(ctx,id,address){
 const info=service.info,me=canonical(address,info.network);
 const [v,mine]=await Promise.all([api('/lot/'+id,{signal:ctx.signal}),api('/address/'+me,{signal:ctx.signal})]);
 const t=terms(v.lot),height=v.height,r=t.reservation,pic=pictures(ctx),about=await subject(ctx,t,pic),n=about.key,NAME=about.name;
 ctx.title('Buy '+NAME);ctx.tip(height);
 const stage=el('section',{class:'section card stack','data-stage':''});
 const reserveBody=payBy=>encodeBody(OP.reserve,{lot:t.id,payBy,buyer:me,rate:0},info.network);
 const buyJob=r&&r.buyer===me?[...v.waiting,...mine.waiting].find(j=>j.op===OP.buy&&j.number===n):null;
 const reserveJob=mine.waiting.find(j=>j.op===OP.reserve&&j.number===n);
 const set=(name,...kids)=>{stage.dataset.stage=name;fill(stage,kids);};
 const back=el('p',{},el('a',{href:'#/lot/'+t.id,text:'Back to the listing'}));

 if(!info.relay)set('read-only',notice('note',READ_ONLY));
 else if(t.status==='sold')set('sold',v.lot.buyer===me
  ?[el('h2',{text:NAME+' is yours'}),notice('good','The purchase is in a block. It belongs to your address now.'),el('p',{},el('a',{class:'btn',href:about.href,text:'See Mordinal #'+count(n)}))]
  :[el('h2',{text:'Sold'}),el('p',{class:'muted',text:NAME+' was sold to another buyer.'}),back]);
 else if(t.status!=='open')set('stopped',el('h2',{text:'Not for sale'}),el('p',{class:'muted',text:'The seller stopped this sale.'}),back);
 else if(buyJob)set('finishing',el('h2',{text:'Finishing the purchase'}),
  sent(ctx,buyJob.id,{own:true,done:()=>{ctx.reload();return notice('good','Done.');},again:()=>ctx.reload()}));
 else if(r&&r.buyer===me)pay();
 else if(reserveJob)set('reserving',el('h2',{text:'Your reservation is waiting for a block'}),
  el('p',{class:'muted',text:'Do not pay yet. The amounts to pay appear here once the reservation is in a block.'}),
  follow(ctx,reserveJob.id,{onEnd:()=>ctx.reload()}));
 else if(running(t,height))set('taken',el('h2',{text:'Reserved by someone else'}),
  el('p',{class:'muted'},'Reserved by ',addr(running(t,height).buyer),' until block '+count(heldUntil(running(t,height)))+'. If no purchase is recorded by then, you can reserve it.'),back);
 else if(t.until<height)set('ended',el('h2',{text:'Not for sale'}),el('p',{class:'muted',text:'This sale ended at block '+count(t.until)+'.'}),back);
 else if(t.seller===me)set('seller',el('h2',{text:'This is the seller’s address'}),el('p',{class:'muted',text:'The seller cannot buy their own Mordinal.'}),back);
 else reserve();

 add(ctx.main,
  el('div',{class:'head'},el('a',{class:'crumb',href:'#/lot/'+t.id,text:'Market · listing'}),el('h1',{class:'small',text:'Buy '+NAME})),
  el('div',{class:'card tight with-thumb','data-section':'summary'},about.picture('thumb'),
   el('div',{},el('p',{},strong(xmr(t.price)+' XMR'),' from ',addr(t.seller)),el('p',{class:'muted'},'Buying as ',addr(me)))),
  stage);

 // Step 1: reserve. The signed text names the Mordinal, both exact payments, the last block to pay and the new owner.
 function reserve(){
  // The last block to pay is part of the signed text, so it is kept while the page is loaded again.
  const key=`reserve:${t.id}:${me}`,fresh=Math.min(height+RULES.maxReserve,t.until),kept=draft.get(key);
  const payBy=kept&&Number.isInteger(kept.payBy)&&kept.payBy<=fresh&&kept.payBy>=Math.min(fresh,height+20)?kept.payBy:fresh;
  draft.set(key,{payBy});
  const body={lot:t.id,payBy,buyer:me,rate:0},bodyBytes=reserveBody(payBy),rctx={domain:info.domain,number:t.number,what:about.what,lot:{price:t.price,seller:t.seller},feeAddress:info.feeAddress};
  const a=amounts({price:t.price,rate:0,code:codeOf(recordId(info.domain,bodyBytes))});
  set('reserve',el('h2',{text:'Step 1 of 3: reserve it'}),
   el('p',{class:'muted',text:`You reserve ${NAME} until block ${count(payBy)} (now block ${count(height)}). Nobody else can buy it while your reservation runs. Nothing is paid in this step.`}),
   el('p',{class:'muted',text:`After the reservation is in a block you pay exactly ${formatXmr(a.seller)} XMR to the seller and exactly ${formatXmr(a.protocol)} XMR to the fee address. The text below says the same; read it in your wallet before you sign.`}),
   signPanel(ctx,{bodyBytes,rctx,text:renderText(OP.reserve,body,bodyBytes,rctx),signer:me,backLabel:'Cancel',back:()=>{location.hash='#/lot/'+t.id;},
    done:()=>{ctx.reload();return notice('good','Your reservation is in a block.');}}));}

 // Steps 2 and 3: the two exact payments, then the buy record. The pasted transaction key makes a proof for each
 // payee here in the page; the key itself is not sent and not kept.
 function pay(){
  if(r.rate){set('elsewhere',notice('error','This reservation was made through a marketplace. Finish it there.'));return;}
  const rid=recordId(info.domain,reserveBody(r.payBy));
  if(rid!==r.record){set('unfit',notice('error','The service sent a reservation that does not fit its code. Do not pay.'));return;}
  const a=amounts({price:t.price,rate:0,code:codeOf(rid)}),key='pay:'+rid;
  let typed=draft.get(key);typed=Array.isArray(typed)&&typed.length&&typed.length<=RULES.maxPayments?typed.map(p=>({txid:String(p?.txid||''),key:''})):[{txid:'',key:''}];
  const deadline=el('div',{'data-deadline':''}),rowsBox=el('div',{class:'stack'}),problem=el('div',{}),finish=el('button',{type:'button',class:'btn primary',text:'Finish purchase','data-action':'finish'});
  const more=el('button',{type:'button',class:'btn',text:'Add another transaction','data-action':'more'});
  function clock(now){
   const late=now>r.payBy,left=r.payBy-now;deadline.dataset.late=String(late);
   deadline.replaceChildren(late
    ?notice('warn',el('strong',{text:`This reservation ran out at block ${count(r.payBy)}. Do not pay now.`}),' A payment made now can be lost. If you already paid in time, you can still finish below.')
    :notice('note',el('strong',{text:`Pay both exact amounts by block ${count(r.payBy)}.`}),` Now block ${count(now)}: ${count(left)} ${left===1?'block':'blocks'} left, about ${count(minutes(left))} minutes. Do not pay after block ${count(r.payBy)}: a late payment can be lost.`));}
  const payment=(i,label,amount,to)=>el('div',{class:'card stack','data-payment':String(i)},el('h3',{text:`Payment ${i} of 2 · ${label}`}),
   el('p',{class:'label',text:'Exact amount in XMR'}),exact(formatXmr(amount),{big:true,what:'amount '+i,label:'Copy amount'}),
   el('p',{class:'label',text:'Monero address'}),exact(to,{what:'address '+i,label:'Copy address'}));
  const values=()=>[...rowsBox.querySelectorAll('[data-row]')].map(row=>({txid:row.querySelector('[data-field=txid]').value.trim().toLowerCase(),key:row.querySelector('[data-field=key]').value.trim().toLowerCase()}));
  function rows(){
   rowsBox.replaceChildren(...typed.map((p,i)=>el('div',{class:'stack','data-row':String(i)},
    field('Transaction id'+(typed.length>1?' '+(i+1):''),textInput({class:'mono',value:p.txid,'data-field':'txid'})),
    field('Transaction key'+(typed.length>1?' '+(i+1):''),textInput({class:'mono',value:p.key,'data-field':'key'})))));
   more.hidden=typed.length>=RULES.maxPayments;}
  rowsBox.addEventListener('input',()=>{typed=values();draft.set(key,typed.map(p=>({txid:p.txid})));problem.replaceChildren();});
  more.addEventListener('click',()=>{typed=[...values(),{txid:'',key:''}];rows();});
  finish.addEventListener('click',async()=>{
   let given;
   try{given=values().filter(p=>p.txid||p.key).map(p=>{
     if(!/^[0-9a-f]{64}$/.test(p.txid))throw Error('A transaction id is 64 hexadecimal characters.');
     parseTxKey(p.key);return p;});
    if(!given.length)throw Error('Paste the transaction id and transaction key of your payment.');
    if(new Set(given.map(p=>p.txid)).size<given.length)throw Error('The same transaction id is given twice.');}
   catch(e){problem.replaceChildren(notice('error',e.message));return;}
   finish.disabled=true;problem.replaceChildren();
   try{const payments=[];
    for(const p of given){
     const got=await api('/tx/'+p.txid,{signal:ctx.signal}).catch(e=>{if(e.status===404)throw Error('The Monero node does not know transaction '+p.txid.slice(0,8)+'… yet. Wait a few seconds and try again.');throw e;});
     payments.push({txid:p.txid,tx:got.payment.tx,txKey:p.key});}
    const proofs=provePayments({lines:[{to:t.seller,amount:a.seller,what:'seller'},{to:info.feeAddress,amount:a.protocol,what:'protocol fee'}],payments,domain:info.domain,lot:t.id,network:info.network});
    const out=await api('/records',{body:{record:hex(encodeBody(OP.buy,{lot:t.id,payments:proofs},info.network))},signal:ctx.signal});
    clearInterval(timer);
    set('finishing',el('h2',{text:'Finishing the purchase'}),
     sent(ctx,out.id,{own:true,done:()=>{draft.drop(key);ctx.reload();return notice('good','Done.');},again:()=>ctx.reload()}));}
   catch(e){if(e.name==='AbortError')return;finish.disabled=false;problem.replaceChildren(notice('error',e.message));}});
  clock(height);rows();
  set('pay',el('h2',{text:'Step 2 of 3: pay'}),deadline,
   el('div',{class:'pay'},payment(1,'to the seller',a.seller,t.seller),payment(2,'protocol fee',a.protocol,info.feeAddress)),
   el('p',{class:'muted',text:'Pay from any Monero wallet. One transaction with two recipients can make both payments. Your wallet adds its own network fee. A different amount does not count: the last digits tie your payment to this reservation.'}),
   el('h2',{text:'Step 3 of 3: finish'}),
   el('p',{class:'muted',text:'Paste each payment’s transaction id and transaction key from the wallet that paid. Your wallet shows the transaction key in the details of the sent transaction. The key stays in this page: it makes the proof that goes into the purchase record and is not sent or saved.'}),
   rowsBox,el('div',{class:'row'},more),problem,el('div',{class:'row'},finish),
   el('p',{class:'dim',text:'The relay pays the Monero network fee of this record and charges nothing in this version. The Mordinal is yours once the record is in a block.'}));
  // Keep the block count current, and notice when the sale is over or someone else reserved after this one ran out.
  const timer=setInterval(async()=>{
   try{const now=await api('/lot/'+id,{signal:ctx.signal});ctx.tip(now.height);
    if(now.lot.status!=='open'||now.lot.reservation?.record!==r.record){clearInterval(timer);ctx.reload();return;}
    clock(now.height);}catch{}},4000);
  ctx.onLeave(()=>clearInterval(timer));}}
