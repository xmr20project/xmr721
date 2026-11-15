// One Mordinal: is it claimed, who owns it, its picture and whole history, and what its owner can do with it.
import {OP,RULES,encodeBody,renderText,canonical,parseXmr,splitOf,formatXmr} from './rules.js';
import {el,add,api,service,count,xmr,addr,txid,exact,notice,pill,strong,table,eventColumns,waitingList,pictures,terms,running,field,textInput,draft} from './ui.js';
import {signPanel} from './sign.js';
import {burning,burnHow,burnAhead,burnMisfit} from './burn.js';

// How long a new listing runs: 720 blocks, about one day.
const LISTING_BLOCKS=720;

export async function mordinal(ctx,number,action){
 const info=service.info,n=Number(number);
 const v=await api('/mordinal/'+n,{signal:ctx.signal}),m=v.mordinal,height=v.height;
 ctx.title('Mordinal #'+count(n));ctx.tip(height);
 const pic=pictures(ctx),home='#/mordinal/'+n,burn=burning();
 let t=null,unfit=null;
 if(m.lot){try{t=terms(m.lot);}catch(e){unfit=e.message;}}
 const held=t?running(t,height):null,ended=Boolean(t&&t.until<height);

 // A burned Mordinal has no owner: it is shown as burned, with nothing to send or sell.
 const answer=m.burned
  ?el('div',{class:'card answer stack','data-answer':'burned'},el('p',{class:'label',text:'Is it claimed?'}),
    el('p',{class:'big no',text:'Burned'}),el('p',{class:'muted',text:'Its last owner destroyed this Mordinal for good. It has no owner and cannot be sent or sold.'}))
  :m.claimed
  ?el('div',{class:'card answer stack','data-answer':'claimed'},el('p',{class:'label',text:'Is it claimed?'}),
    el('p',{class:'big',text:'Claimed'}),el('p',{class:'muted',text:'owned by'}),exact(m.owner,{what:'owner address'}),
    el('p',{},el('a',{href:'#/address/'+m.owner,text:'Everything this address owns'})))
  :burn&&!burn.fits
  ?el('div',{class:'card answer stack','data-answer':'unclaimed'},el('p',{class:'label',text:'Is it claimed?'}),
    el('p',{class:'big no',text:'Not claimed yet'}),el('p',{class:'muted',text:'Nobody has claimed this Mordinal.'}),burnMisfit())
  :burn?.active
  ?el('div',{class:'card answer stack','data-answer':'unclaimed'},el('p',{class:'label',text:'Is it claimed?'}),
    el('p',{class:'big no',text:'Not claimed yet'}),
    el('p',{class:'muted',text:'Nobody has claimed this Mordinal. Whoever holds the Monero coin it was inscribed on claims it by burning the old Mordinal: a transfer to the burn address with a text that names the receiving address. It needs that wallet’s own keys, so it is not done on this page.'}),
    burnHow(burn),
    m.ownerOutput!=null?el('p',{class:'dim','data-burn':'output',text:'Its coin is output '+count(m.ownerOutput)+' of the chain; the transfer’s ring names it.'}):null)
  :el('div',{class:'card answer stack','data-answer':'unclaimed'},el('p',{class:'label',text:'Is it claimed?'}),
    el('p',{class:'big no',text:'Not claimed yet'}),
    el('p',{class:'muted',text:'Nobody has claimed this Mordinal. Whoever holds the Monero coin it was inscribed on can claim it in the XMR20 wallet or with the command-line tool. Claiming needs that wallet’s own keys, so it is not done on this page.'}),
    burn?el('p',{class:'dim','data-burn':'ahead',text:burnAhead(burn)}):null);

 const fact=(label,value)=>el('div',{},el('dt',{text:label}),el('dd',{},value));
 const facts=el('dl',{class:'kv'},
  m.group?fact('Collection',el('a',{href:'#/collection/'+m.group.id,text:m.group.name.length>60?m.group.name.slice(0,58)+'…':m.group.name})):null,
  fact('Registration transaction',txid(m.reg)),
  fact('Inscribed at block',m.registrationHeight==null?'Not known':count(m.registrationHeight)),
  fact('Owner transaction at the start',txid(m.ownerTx)),
  fact('Content',m.bodySize==null?'None stored':count(m.bodySize)+' bytes'),
  m.bodySha256?fact('Content SHA-256',txid(m.bodySha256)):null);

 let sale=null;
 if(unfit)sale=el('section',{class:'section'},notice('error',unfit+' It is not shown.'));
 else if(t){const s=splitOf(t.price);
  sale=el('section',{class:'section card stack','data-section':'listing'},
   el('div',{class:'section-head'},el('h2',{text:'For sale'}),ended?pill('Ended'):held?pill('Reserved','purple'):pill('Open','green')),
   el('p',{class:'answer'},el('span',{class:'big',text:xmr(t.price)+' XMR'})),
   el('dl',{class:'kv'},fact('Seller',addr(t.seller)),fact(ended?'Ended at block':'Ends at block',count(t.until)),
    fact('Seller receives',formatXmr(s.seller)+' XMR'),fact('Protocol fee (5%)',formatXmr(s.fee)+' XMR')),
   held?el('p',{class:'muted'},'Reserved by ',addr(held.buyer),' until block '+count(held.payBy)+'. If it is not paid by then, it can be reserved again.'):null,
   el('p',{},el('a',{class:'btn primary',href:'#/lot/'+t.id,text:ended?'See the listing':'See the listing and buy'})));}

 add(ctx.main,
  el('div',{class:'head'},el('a',{class:'crumb',href:'#/gallery',text:'Gallery'}),el('h1',{class:'small',text:'Mordinal #'+count(n)})),
  el('div',{class:'split item'},pic(n,{size:'large',hasContent:m.bodySize!==null}),el('div',{class:'stack'},sale,answer,el('div',{class:'card'},facts))),
  m.claimed&&!m.burned?owner():null,
  v.waiting.length?el('section',{class:'section','data-section':'waiting'},el('div',{class:'section-head'},el('h2',{text:'Waiting for a block'}),
   el('span',{class:'dim',text:'These records do not count yet.'})),waitingList(v.waiting)):null,
  el('section',{class:'section','data-section':'history'},el('div',{class:'section-head'},el('h2',{text:'History'})),
   table(eventColumns({number:false}),v.history)));

 // While something is waiting, look again now and then.
 if(v.waiting.length){const seen=JSON.stringify(v.waiting);
  const timer=setInterval(async()=>{try{const now=await api('/mordinal/'+n,{signal:ctx.signal});
   if(JSON.stringify(now.waiting)!==seen){if(action)location.replace(home);else ctx.reload();}}catch{}},4000);
  ctx.onLeave(()=>clearInterval(timer));}

 // What the owner can do: send, sell, stop selling. Each is a message signed with the owning address.
 function owner(){
  const box=el('section',{class:'section card stack','data-section':'owner'},el('h2',{text:'Do you own this Mordinal?'}));
  if(!info.relay){box.append(el('p',{class:'muted',text:'Records cannot be sent from here: this service only reads. Use the XMR20 wallet or the command-line tool to send or sell it.'}));return box;}
  const panel=el('div',{class:'stack'}),open=el('button',{type:'button',class:'btn',text:'I own this','data-action':'own',onclick:()=>{open.hidden=true;choices();}});
  const done=text=>s=>el('div',{class:'stack'},notice('good',text+' The record is in block '+count(s.height)+'.'),el('p',{},el('a',{class:'btn',href:home,text:'Back to Mordinal #'+count(n)})));
  const go=to=>()=>{location.hash=home+'/'+to;};
  const leave=()=>{location.hash=home;};
  function choices(){
   const say=[el('p',{class:'muted'},'You send it, sell it or stop a sale by signing a message with the address that owns it, ',addr(m.owner),
    '. Signing moves no XMR. The relay pays the Monero network fee of the record and charges nothing in this version.')];
   if(v.waiting.length)say.push(notice('note','A record for this Mordinal is waiting for a block. Wait until it is in a block before sending another.'));
   else if(unfit)say.push(notice('error',unfit));
   else if(held)say.push(notice('note','A buyer reserved it until block '+count(held.payBy)+'. You can stop the sale after that if it is not paid.'));
   else if(t)say.push(ended?notice('note','This sale ended at block '+count(t.until)+'. Stop it before you send the Mordinal or sell it again.'):
     el('p',{class:'muted',text:'It is for sale. Stop the sale before you send it or change the price.'}),
    el('div',{class:'row'},el('button',{type:'button',class:'btn primary',text:'Stop selling','data-action':'stop',onclick:go('stop')})));
   else say.push(el('div',{class:'row'},el('button',{type:'button',class:'btn primary',text:'Send','data-action':'send-start',onclick:go('send')}),
    el('button',{type:'button',class:'btn primary',text:'Sell','data-action':'sell-start',onclick:go('sell')})));
   panel.replaceChildren(...say);}

  function sendForm(typed=''){
   const to=textInput({class:'mono',value:typed,'data-field':'to'}),problem=el('div',{});
   const next=()=>{let dest;
    try{dest=canonical(to.value,info.network);if(dest===m.owner)throw Error('This address already owns it.');}catch(e){problem.replaceChildren(notice('error',e.message));return;}
    const body={reg:m.reg,seq:m.seq,from:m.owner,to:dest},bodyBytes=encodeBody(OP.move,body,info.network),rctx={domain:info.domain,number:n};
    panel.replaceChildren(el('h3',{text:'Send Mordinal #'+count(n)}),el('p',{class:'muted'},'To ',addr(dest),'. This cannot be undone.'),
     signPanel(ctx,{bodyBytes,rctx,text:renderText(OP.move,body,bodyBytes,rctx),signer:m.owner,back:()=>sendForm(to.value),done:done('Sent.')}));};
   panel.replaceChildren(el('h3',{text:'Send Mordinal #'+count(n)}),
    field('Monero address that receives it',to,'A main address or a subaddress. Check it carefully: a sent Mordinal cannot be taken back.'),problem,
    el('div',{class:'row'},el('button',{type:'button',class:'btn primary',text:'Continue','data-action':'next',onclick:next}),el('button',{type:'button',class:'btn',text:'Cancel',onclick:leave})));}

  function sellForm(typed=''){
   const price=textInput({value:typed,placeholder:'0',inputmode:'decimal','data-field':'price'}),problem=el('div',{}),split=el('span',{'data-split':''});
   const read=()=>{const p=parseXmr(price.value);if(p<RULES.minPrice)throw Error('The lowest price is '+formatXmr(RULES.minPrice)+' XMR.');return p;};
   const hint=()=>{problem.replaceChildren();try{const s=splitOf(read());split.textContent=`You receive ${formatXmr(s.seller)} XMR · protocol fee ${formatXmr(s.fee)} XMR`;}catch{split.textContent='';}};
   price.addEventListener('input',hint);hint();
   const next=()=>{let p;try{p=read();}catch(e){problem.replaceChildren(notice('error',e.message));return;}
    // The end block is part of the signed text, so the same price keeps the same end when the page is loaded again.
    const key=`sell:${m.reg}:${m.seq}:${p}`,kept=draft.get(key),until=kept&&Number.isInteger(kept.until)&&kept.until>=height+LISTING_BLOCKS-120&&kept.until<=height+LISTING_BLOCKS?kept.until:height+LISTING_BLOCKS;
    draft.set(key,{until});
    const body={reg:m.reg,seq:m.seq,until,price:p,seller:m.owner},bodyBytes=encodeBody(OP.list,body,info.network),rctx={domain:info.domain,number:n},s=splitOf(p);
    panel.replaceChildren(el('h3',{text:'Sell Mordinal #'+count(n)}),
     el('p',{class:'muted'},'For ',strong(formatXmr(p)+' XMR'),`: you receive ${formatXmr(s.seller)} XMR and ${formatXmr(s.fee)} XMR is the protocol fee. The sale ends at block ${count(until)}.`),
     signPanel(ctx,{bodyBytes,rctx,text:renderText(OP.list,body,bodyBytes,rctx),signer:m.owner,back:()=>sellForm(price.value),done:done('It is for sale.')}));};
   panel.replaceChildren(el('h3',{text:'Sell Mordinal #'+count(n)}),
    field('Price in XMR',price,split),problem,
    el('p',{class:'muted',text:`The buyer pays you directly. 5% of the price goes to the protocol fee address. The sale ends at block ${count(height+LISTING_BLOCKS)}, about one day from now; you can stop it earlier.`}),
    el('div',{class:'row'},el('button',{type:'button',class:'btn primary',text:'Continue','data-action':'next',onclick:next}),el('button',{type:'button',class:'btn',text:'Cancel',onclick:leave})));}

  function stopForm(){
   const body={lot:t.id,seller:m.owner},bodyBytes=encodeBody(OP.cancel,body,info.network),rctx={domain:info.domain,number:n};
   panel.replaceChildren(el('h3',{text:'Stop selling Mordinal #'+count(n)}),
    el('p',{class:'muted',text:'The Mordinal stays yours. Nobody can buy it after the record is in a block.'}),
    signPanel(ctx,{bodyBytes,rctx,text:renderText(OP.cancel,body,bodyBytes,rctx),signer:m.owner,back:leave,backLabel:'Cancel',done:done('The sale is stopped.')}));}

  box.append(open,panel);
  const free=!v.waiting.length&&!unfit;
  if(action==='send'&&free&&!t){open.hidden=true;sendForm();}
  else if(action==='sell'&&free&&!t){open.hidden=true;sellForm();}
  else if(action==='stop'&&free&&t&&!held){open.hidden=true;stopForm();}
  else if(action){open.hidden=true;choices();}
  return box;}}
