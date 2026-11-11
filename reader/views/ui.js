// Shared pieces of the pages: building DOM nodes, calling the service, formatting, pictures.
// Everything from the service or the person goes in as text nodes or attributes, never as markup.
import {formatXmr,decodeRecord,recordId,unhex,OP,heldUntil} from './rules.js';

// The service root. The pages live in <root>/view/, the API beside it.
// The service is one folder above these pages, unless the page names another place (a site that hosts the pages
// under its own address does that with <meta name="xmr721-api" content="…">).
const named=document.querySelector('meta[name="xmr721-api"]')?.content;
export const ROOT=named?new URL(named,location.href):new URL('../',new URL('.',location.href));

// What /info said when the page loaded: network, domain, fee address, whether records can be sent from here.
export const service={info:null};

const PROPS=new Set(['value','disabled','hidden','checked']);
export function el(tag,props,...kids){
 const node=document.createElement(tag);
 for(const [k,v] of Object.entries(props||{})){
  if(v==null||v===false)continue;
  if(k==='class')node.className=v;
  else if(k==='text')node.textContent=v;
  else if(k.startsWith('on'))node.addEventListener(k.slice(2),v);
  else if(PROPS.has(k))node[k]=v;
  else node.setAttribute(k,v===true?'':String(v));}
 add(node,kids);return node;}
// Appends children, leaving out what is null or false; text goes in as text nodes.
export function add(node,...kids){
 for(const k of kids.flat(Infinity)){if(k==null||k===false)continue;node.append(k instanceof Node?k:document.createTextNode(String(k)));}
 return node;}
// The same, replacing what the node held.
export const fill=(node,...kids)=>{node.replaceChildren();return add(node,...kids);};

export async function api(path,{signal,body}={}){
 let res;
 try{res=await fetch(new URL(path.replace(/^\/+/,''),ROOT),{method:body?'POST':'GET',signal,cache:'no-store',
  ...(body?{headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})});}
 catch(e){if(e.name==='AbortError')throw e;throw Error('The Mordinals service cannot be reached. Check your connection and try again.');}
 let data=null;try{data=await res.json();}catch{}
 if(!res.ok||!data){const e=Error(data?.error||`The Mordinals service answered ${res.status}.`);e.status=res.status;throw e;}
 return data;}

// A listing as its own signed record states it. The service's plain fields are not used for money:
// price, seller and end block come from the record bytes, after checking that they hash to the listing id.
export function terms(l){
 const info=service.info;let d,bytes;
 try{bytes=unhex(l.body);d=decodeRecord(bytes,info.network,{sig:false});}catch{d=null;}
 // A Mordinal is known by its number; a minted NFT has none and is known by its id, which the listing itself names.
 if(!d||d.op!==OP.list||recordId(info.domain,bytes)!==l.id||!(Number.isInteger(l.number)||(l.number===null&&l.nft===d.body.reg)))throw Error('The service sent a listing that does not fit its code.');
 return {id:l.id,number:l.number,nft:l.number===null?d.body.reg:null,reg:d.body.reg,seq:d.body.seq,price:d.body.price,until:d.body.until,seller:d.body.seller,
  status:l.status,reservation:l.reservation||null,buyer:l.buyer||null};}
// The reservation that holds a listing now, or null.
// The reservation that holds this listing now: until it runs out and 10 blocks more, nobody else can reserve it.
export const running=(t,height)=>t.reservation&&heldUntil(t.reservation)>=height?t.reservation:null;

export const xmr=p=>formatXmr(BigInt(p));
// What this relay charges to carry a collection or a mint record, in atomic units (0n = free).
export const relayFee=kind=>{try{return BigInt(service.info.relay?.fees?.[kind]||0);}catch{return 0n;}};
export const count=n=>Number(n).toLocaleString('en-US');
export const short=(s,head=8,tail=6)=>s.length>head+tail+1?s.slice(0,head)+'…'+s.slice(-tail):s;
export const when=seconds=>seconds?new Date(seconds*1000).toISOString().slice(0,16).replace('T',' ')+' UTC':'';
export const strong=text=>el('span',{class:'strong',text});
export const pill=(text,tone='')=>el('span',{class:'pill '+tone,text});
export const notice=(kind,...kids)=>el('p',{class:kind,role:kind==='error'||kind==='warn'?'alert':null},kids);

function copyByHand(value){
 const t=el('textarea',{readonly:true,'aria-hidden':'true'});t.value=value;t.className='offscreen';document.body.append(t);t.select();
 let ok=false;try{ok=document.execCommand('copy');}catch{}t.remove();return ok;}
export function copyButton(value,label='Copy',what=''){
 const b=el('button',{type:'button',class:'btn small',text:label,'data-copy':value,'aria-label':what?`${label} ${what}`:null});
 b.addEventListener('click',async()=>{
  let ok=true;try{await navigator.clipboard.writeText(value);}catch{ok=copyByHand(value);}
  b.textContent=ok?'Copied':'Not copied';setTimeout(()=>{b.textContent=label;},1500);});
 return b;}
// A long value shortened for reading: the whole value is in the title and on the copy button.
export const addr=a=>el('span',{class:'chip'},el('a',{class:'v',href:'#/address/'+a,title:a,text:short(a)}),copyButton(a,'Copy','address'));
export const txid=t=>el('span',{class:'chip'},el('span',{class:'v',title:t,text:short(t)}),copyButton(t,'Copy','transaction id'));
export const code=id=>el('span',{class:'chip'},el('a',{class:'v',href:'#/record/'+id,title:id,text:short(id)}),copyButton(id,'Copy','record code'));
// A link to what a row is about: a Mordinal by number, a minted NFT by its id (64 hex), nothing when there is neither.
export const mordinalLink=n=>n==null?'':typeof n==='string'?el('a',{class:'strong',href:'#/nft/'+n,title:n,text:'NFT '+n.slice(0,8)}):el('a',{class:'strong',href:'#/mordinal/'+n,text:'#'+count(n)});
// A value that must be copied exactly (an amount, an address, a text to sign), shown in full.
export const exact=(value,{big=false,what='',label='Copy'}={})=>el('div',{class:'exact'+(big?' big':'')},el('span',{class:'v',text:value}),copyButton(value,label,what));

export function field(label,input,hint){
 const id='f'+Math.random().toString(36).slice(2,9);input.id=id;
 return el('div',{class:'field'},el('label',{class:'label',for:id,text:label}),input,hint?el('span',{class:'hint'},hint):null);}
export const textInput=(props={})=>el('input',{type:'text',spellcheck:'false',autocomplete:'off',autocapitalize:'off',...props});
// Buttons that pick one of several values; `pick` is called with the chosen value.
export function pills(options,current,pick,label){
 return el('div',{class:'pills',role:'group','aria-label':label},options.map(([value,text])=>
  el('button',{type:'button','aria-pressed':String(value===current),'data-value':value,text,onclick:()=>pick(value)})));}

// A table whose rows turn into stacked cards on narrow screens (each cell carries its column label).
export function table(columns,rows,empty='Nothing here yet.'){
 if(!rows.length)return el('p',{class:'empty',text:empty});
 return el('div',{class:'table-card'},el('table',{class:'rows'},
  el('thead',{},el('tr',{},columns.map(c=>el('th',{scope:'col',class:c.num?'num':null,text:c.label})))),
  el('tbody',{},rows.map(r=>el('tr',{'data-row':c0(r)},columns.map(c=>el('td',{class:c.num?'num':null,'data-label':c.label},el('div',{},c.cell(r)))))))));}
const c0=r=>r&&(r.id||r.txid)||null;

export const KIND={inscribed:['Inscribed',''],transfer:['Moved in 2023',''],claim:['Claimed','green'],move:['Sent','cyan'],list:['Listed','yellow'],
 cancel:['Sale stopped',''],reserve:['Reserved','purple'],sale:['Sold','green'],collection:['Collection','cyan'],mint:['Minted','green'],burn:['Burned','red']};
export const kindPill=kind=>pill(...(KIND[kind]||[kind,'']));
// One event in plain words. Amounts here are for reading only; nothing is signed or paid from them.
export function eventText(e){
 switch(e.kind){
  case 'inscribed':return ['Inscribed on Monero'];
  case 'transfer':return ['Moved by spending its coin, under the 2023 rules'];
  case 'claim':return ['Claimed by ',addr(e.to)];
  case 'move':return ['Sent by ',addr(e.from),' to ',addr(e.to)];
  case 'list':return ['Put up for sale by ',addr(e.seller),' for ',strong(xmr(e.price)+' XMR'),', until block '+count(e.until)];
  case 'cancel':return ['Sale stopped by ',addr(e.seller)];
  case 'reserve':return ['Reserved by ',addr(e.buyer),', to pay by block '+count(e.payBy)];
  case 'collection':return ['Collection “'+e.name+'” of '+count(e.max)+' created by ',addr(e.creator)];
  case 'mint':return ['Minted'+(e.name?' “'+e.name+'”':'')+' by ',addr(e.creator),...(e.to!==e.creator?[' to ',addr(e.to)]:[])];
  case 'burn':return ['Burned by ',addr(e.owner)];
  case 'sale':return ['Sold for ',strong(xmr(e.price)+' XMR'),' by ',addr(e.seller),' to ',addr(e.buyer)];
  default:return [String(e.kind)];}}
// Columns shared by every list of events.
export const eventColumns=({number=true}={})=>[
 {label:'Event',cell:e=>kindPill(e.kind)},
 ...(number?[{label:'NFT',cell:e=>mordinalLink(e.number??e.nft)}]:[]),
 {label:'What happened',cell:eventText},
 {label:'Transaction',cell:e=>e.txid?txid(e.txid):''},
 {label:'Block',num:true,cell:e=>e.height==null?'':count(e.height)},
 {label:'Time',num:true,cell:e=>when(e.time)}];

export const OPNAME={1:'Claim',2:'Send',3:'Listing',4:'Stop selling',5:'Reservation',6:'Purchase',7:'Collection',8:'Mint',9:'Burn'};
export const JOB={unpaid:['Waiting for the relay fee','yellow'],queued:['Waiting to be sent','yellow'],built:['Waiting to be sent','yellow'],held:['Waiting for a payment to be in a block','yellow'],
 sent:['Sent, waiting for a block','yellow'],done:['In a block','green'],refused:['Refused','red'],stuck:['Did not reach a block','red'],unknown:['Not known to this service','']};
export const jobPill=state=>pill(...(JOB[state]||[state,'']));
// Records the relay holds that are not in a block yet. They do not count until they are.
export function waitingList(jobs){
 return table([
  {label:'Record',cell:j=>OPNAME[j.op]||'Record'},
  {label:'NFT',cell:j=>mordinalLink(j.number)},
  {label:'State',cell:j=>[jobPill(j.state),j.error?' '+j.error:'']},
  {label:'Code',cell:j=>code(j.id)},
  {label:'Transaction',cell:j=>j.txid?txid(j.txid):''}],jobs);}

// Pictures. Content is only ever shown through <img>; a picture marked sensitive stays hidden until asked for.
// Tiles load when they come into view, so a long gallery page does not fetch every picture at once.
export function pictures(ctx){
 const urls=[],start=new WeakMap();
 const io='IntersectionObserver' in window?new IntersectionObserver(entries=>{
  for(const e of entries)if(e.isIntersecting){io.unobserve(e.target);start.get(e.target)?.();}},{rootMargin:'300px'}):null;
 ctx.onLeave(()=>{io?.disconnect();for(const u of urls)URL.revokeObjectURL(u);});
 const say=(box,state,text)=>{box.dataset.state=state;box.replaceChildren(el('span',{text}));};
 async function load(box,n,shown){
  let res;
  try{res=await fetch(new URL('content/'+n,ROOT),{signal:ctx.signal});}
  catch{if(!ctx.signal.aborted)say(box,'failed','Picture not available');return;}
  if(res.status===415)return say(box,'none','Not a picture');
  if(res.status===404)return say(box,'none','No picture');
  if(!res.ok||!/^image\/(png|jpeg|gif|webp)$/.test(res.headers.get('content-type')||''))return say(box,'failed','Picture not available');
  if(res.headers.get('x-mordinal-sensitive')==='1'&&!shown){
   res.body?.cancel().catch(()=>{});box.dataset.state='hidden';
   box.replaceChildren(el('span',{text:'Hidden: marked sensitive'}),
    el('button',{type:'button',class:'btn small',text:'Show',onclick:()=>{say(box,'loading','');load(box,n,true);}}));
   return;}
  let url;try{url=URL.createObjectURL(await res.blob());}catch{if(!ctx.signal.aborted)say(box,'failed','Picture not available');return;}
  urls.push(url);
  const img=el('img',{alt:'Mordinal #'+n,src:url});
  img.addEventListener('error',()=>say(box,'failed','Picture not available'));
  box.dataset.state='shown';box.replaceChildren(img);}
 return (n,{size='',hasContent=true}={})=>{
  const box=el('div',{class:('pic '+size).trim(),'data-picture':String(n)});
  if(!hasContent){say(box,'none','No picture');return box;}
  say(box,'loading','');
  if(io){start.set(box,()=>load(box,n,false));io.observe(box);}else load(box,n,false);
  return box;};}

// Small values kept for this tab only, so a reload does not change a text that is being signed.
export const draft={
 get(key){try{return JSON.parse(sessionStorage.getItem('mordinals:'+key));}catch{return null;}},
 set(key,value){try{sessionStorage.setItem('mordinals:'+key,JSON.stringify(value));}catch{}},
 drop(key){try{sessionStorage.removeItem('mordinals:'+key);}catch{}}};
