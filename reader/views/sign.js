// Signing a record's text in any Monero wallet, sending the record, and following it until it is in a block.
import {attachSignature,hex} from './rules.js';
import {canonical} from './rules.js';
import {el,fill,api,service,addr,txid,copyButton,pill,notice,count,xmr,JOB} from './ui.js';
import {walletLink} from './wallet.js';

const ENDED=new Set(['done','refused','stuck']);

// A line that follows one record: waiting, sent, in a block, or failed. `onEnd` gets the last status.
// `own` words a held purchase for the buyer who is looking at it.
export function follow(ctx,id,{own=false,onEnd}={}){
 const line=el('div',{class:'status',role:'status','data-record':id,'data-state':'checking'},pill('Checking…'));
 let timer=null;
 function show(s){
  const [word,tone]=JOB[s.state]||[s.state,''];line.dataset.state=s.state;
  fill(line,pill(own&&s.state==='held'?'Waiting for your payment to be in a block':word,tone),
   s.state==='done'&&s.height!=null?el('span',{class:'dim',text:'Block '+count(s.height)}):null,
   s.txid?txid(s.txid):null,
   s.error?el('span',{class:'dim',text:s.error}):null,
   s.note&&!s.error?el('span',{class:'dim',text:s.note}):null);
  payBox(s);}
 // A record whose relay fee is not paid yet: where to pay, how much, and until when.
 const paying=el('div',{class:'stack paybox','data-pay':'',hidden:''});let shownFor='';
 function payBox(s){
  if(s.state!=='unpaid'||!s.pay){paying.hidden=true;shownFor='';return;}
  if(shownFor===s.pay.address)return;shownFor=s.pay.address;paying.hidden=false;
  fill(paying,el('h3',{text:'Pay the relay fee'}),
   el('p',{class:'muted'},'Send ',el('strong',{'data-pay-amount':'',text:xmr(s.pay.amount)+' XMR'}),' to this address from any Monero wallet. The record is sent to the Monero network once the payment is in a block, usually a few minutes after you pay.'),
   el('div',{class:'signtext','data-pay-address':'',text:s.pay.address}),
   el('div',{class:'row'},copyButton(s.pay.address,'Copy address','to pay'),copyButton(xmr(s.pay.amount),'Copy amount','to pay'),el('span',{class:'dim',text:'Pay by block '+count(s.pay.payBy)+'. This address is for this record only.'})),
   el('p',{class:'dim',text:'The fee pays for putting the record on the Monero network. If you do not pay, nothing is sent and nothing is owed.'}));}
 async function turn(){
  if(ctx.signal.aborted)return;
  try{const s=await api('/status/'+id,{signal:ctx.signal});show(s);if(s.height!=null&&s.state!=='done')ctx.tip(s.height);
   if(ENDED.has(s.state)){onEnd?.(s);return;}}
  catch(e){if(e.name==='AbortError'||ctx.signal.aborted)return;}
  timer=setTimeout(turn,2500);}
 ctx.onLeave(()=>clearTimeout(timer));
 turn();return el('div',{class:'stack'},line,paying);}

// What the person sees while a sent record waits, and when it has ended.
//   done(status) -> node shown once the record is in a block
//   again()      -> called by "Try again" after a record that did not count
export function sent(ctx,id,{own=false,done,again}={}){
 const end=el('div',{class:'stack'});
 const box=el('div',{class:'stack','data-sent':id},
  notice('note','Handed to the relay. It is not done yet: a record counts only once it is in a Monero block. This usually takes a few minutes. You can leave this page and come back.'),
  follow(ctx,id,{own,onEnd(s){
   if(s.state==='done')end.replaceChildren(done?done(s):notice('good','Done. The record is in block '+count(s.height)+'.'));
   else fill(end,notice('error',s.state==='refused'?'The record was refused: '+(s.error||'it does not fit the rules.'):'The record did not reach a block. Nothing changed.'),
    again?el('p',{},el('button',{type:'button',class:'btn',text:'Try again',onclick:again})):null);}}),
  end);
 return box;}

// The three steps of signing: copy the text, sign it in a wallet, paste the signature.
// The signature is checked here against the exact text and address before anything is sent.
//   bodyBytes, rctx  the record body and what its text is rendered with (rule library)
//   text, signer     what the person signs, and with which address
//   done(status)     -> node shown when the record is in a block
//   back()           leaves the panel without sending
//   wallet           true for records a connected wallet can approve itself (those of minted NFTs and collections)
// The connected wallet that holds the signing address, if it approves records itself.
export function signingWallet(signer){
 const w=walletLink();if(!w||typeof w.signRecord!=='function')return null;
 try{const s=w.status();return s.connected&&canonical(s.address,service.info.network)===signer?w:null;}catch{return null;}}
export function signPanel(ctx,{bodyBytes,rctx,text,signer,done,back,backLabel='Back',own=false,wallet=false}){
 const info=service.info;
 const area=el('textarea',{spellcheck:'false',autocomplete:'off',autocapitalize:'off',placeholder:'SigV2…','aria-label':'Signature','data-field':'signature'});
 const problem=el('div',{});
 const send=el('button',{type:'button',class:'btn primary',text:'Check and send','data-action':'send'});
 const panel=el('div',{class:'stack','data-sign':''});
 const fail=message=>problem.replaceChildren(notice('error',message));
 area.addEventListener('input',()=>problem.replaceChildren());
 send.addEventListener('click',async()=>{
  let record;
  try{record=attachSignature(bodyBytes,area.value.trim(),rctx,info.network);}
  catch(e){fail(e.message+' Nothing was sent.');return;}
  send.disabled=true;problem.replaceChildren();
  try{const out=await api('/records',{body:{record:hex(record)},signal:ctx.signal});
   panel.replaceChildren(sent(ctx,out.id,{own,done,again:()=>ctx.reload()}));}
  catch(e){if(e.name==='AbortError')return;send.disabled=false;fail(e.message);}});
 const w=wallet?signingWallet(signer):null,steps=el('ol',{class:'steps'},
   el('li',{class:'stack'},el('h3',{text:'Copy this text'}),
    el('div',{class:'signtext','data-signtext':'',text}),
    el('div',{class:'row'},copyButton(text,'Copy text','to sign'),el('span',{class:'dim',text:'One line. Sign it exactly as it is.'}))),
   el('li',{class:'stack'},el('h3',{text:'Sign a message in your Monero wallet'}),
    el('p',{class:'muted'},'Open “Sign message” in the wallet that holds ',addr(signer),' (Feather, Cake Wallet, Monero GUI or CLI). Paste the text and sign it with this address. Signing moves no XMR.')),
   el('li',{class:'stack'},el('h3',{text:'Paste the signature'}),area,problem,
    el('div',{class:'row'},send,back?el('button',{type:'button',class:'btn',text:backLabel,onclick:back}):null)));
 const fee=el('p',{class:'dim',text:'The relay puts this record on the Monero network. The record counts once it is in a block.'});
 if(!w){panel.append(steps,fee);return panel;}
 // One approval in the connected wallet: it reads the record itself, shows it, signs and sends it.
 const label=w.status().label||'your wallet',approve=el('button',{type:'button',class:'btn primary',text:'Approve in '+label,'data-action':'approve'}),trouble=el('div',{});
 approve.addEventListener('click',async()=>{
  approve.disabled=true;trouble.replaceChildren();
  try{const out=await w.signRecord(hex(bodyBytes));if(ctx.signal.aborted)return;
   panel.replaceChildren(sent(ctx,out.id,{own,done,again:()=>ctx.reload()}));}
  catch(e){approve.disabled=false;if(!ctx.signal.aborted)trouble.replaceChildren(notice(e.cancelled?'note':'error',e.message||'The wallet did not answer.'));}});
 panel.append(
  el('div',{class:'stack','data-wallet-sign':''},
   el('p',{class:'muted'},'Your connected wallet holds ',addr(signer),'. It shows this record and the text below, and signs after you approve. Signing moves no XMR.'),
   el('div',{class:'signtext','data-signtext':'',text}),
   el('div',{class:'row'},approve,back?el('button',{type:'button',class:'btn',text:backLabel,onclick:back}):null),trouble),
  el('details',{class:'other-wallet'},el('summary',{text:'Sign in another wallet instead'}),steps),fee);
 return panel;}
