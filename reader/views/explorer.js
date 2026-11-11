// The explorer: totals, newest activity, records waiting for a block, search, one address, one record.
import {canonical} from './rules.js';
import {el,add,api,service,count,xmr,pills,table,eventColumns,waitingList,notice,exact,field,textInput,pictures,terms,mordinalLink,addr,code,txid,strong,OPNAME} from './ui.js';
import {card} from './gallery.js';
import {follow} from './sign.js';

const KINDS=[['','All'],['claim','Claims'],['move','Sends'],['list','Listings'],['cancel','Stopped sales'],['reserve','Reservations'],['sale','Sales']],PAGE=25;
const HINT='Type a Mordinal number, a transaction id, a record code or a Monero address.';

function searchBox(value=''){
 const input=textInput({placeholder:'Mordinal number, transaction id, record code or Monero address','aria-label':'Search',value,'data-field':'search'});
 const go=()=>{location.hash='#/search?q='+encodeURIComponent(input.value.trim());};
 input.addEventListener('keydown',e=>{if(e.key==='Enter')go();});
 return el('div',{class:'search',role:'search'},input,el('button',{type:'button',class:'btn primary',text:'Search','data-action':'search',onclick:go}));}

// Looks through the newest events for one that fits. The service has no lookup by record code or
// transaction id, so this reads a bounded number of pages and gives up after that.
async function findEvent(fits,signal,pages=5){
 let before=null;
 for(let i=0;i<pages;i++){
  const a=await api('/activity?limit=200'+(before==null?'':'&before='+before),{signal}),hit=a.events.find(fits);
  if(hit)return hit;if(a.next==null)return null;before=a.next;}
 return null;}
const exists=async(path,signal)=>{try{return await api(path,{signal});}catch(e){if(e.status===404||e.status===400)return null;throw e;}};

// Where a search text leads: the hash of the view to open. Throws a plain message when nothing fits.
async function resolve(text,signal){
 const q=text.trim(),info=service.info;
 if(!q)throw Error(HINT);
 const number=/^#?\s*(\d{1,9})$/.exec(q.replace(/,/g,''));
 if(number){if(Number(number[1])>=info.count)throw Error(`There are ${count(info.count)} Mordinals, numbered from 0 to ${count(info.count-1)}.`);return '#/mordinal/'+Number(number[1]);}
 const hexText=q.toLowerCase();
 if(/^[0-9a-f]{64}$/.test(hexText)){
  const m=await exists('/mordinal/'+hexText,signal);if(m)return '#/mordinal/'+m.mordinal.number;
  if(await exists('/lot/'+hexText,signal))return '#/lot/'+hexText;
  const s=await api('/status/'+hexText,{signal});if(s.state!=='unknown')return '#/record/'+hexText;
  const e=await findEvent(x=>x.txid===hexText||(x.payments||[]).includes(hexText),signal);if(e)return '#/record/'+e.id;
  throw Error('No Mordinal, listing or record here has this id. Only registration transactions and record transactions are known to this service.');}
 if(/^[0-9a-f]{32}$/.test(hexText)){
  const e=await findEvent(x=>x.id.startsWith(hexText)||(x.lot||'').startsWith(hexText),signal);
  if(e)return e.kind==='list'||(e.lot||'').startsWith(hexText)?'#/lot/'+e.lot:'#/record/'+e.id;
  const p=await api('/pending',{signal}),j=[...p.jobs,...p.pool].find(x=>x.id.startsWith(hexText));if(j)return '#/record/'+j.id;
  throw Error('No record with this code was found among the newest records.');}
 if(/^[1-9A-HJ-NP-Za-km-z]{90,110}$/.test(q))return '#/address/'+canonical(q,info.network);
 throw Error('This is not a Mordinal number, a transaction id, a record code or a Monero address.');}

export async function search(ctx){
 ctx.title('Search');const q=ctx.query.get('q')||'';let problem;
 try{const to=await resolve(q,ctx.signal);if(ctx.signal.aborted)return;location.replace(to);return;}
 catch(e){if(e.name==='AbortError')throw e;problem=e.message;}
 add(ctx.main,el('div',{class:'head'},el('h1',{class:'small',text:'Search'}),searchBox(q)),notice('error',problem));}

export async function explorer(ctx){
 ctx.title('Explorer');
 const asked=ctx.query.get('kind'),kind=KINDS.some(([k])=>k&&k===asked)?asked:'',before=/^\d{1,9}$/.test(ctx.query.get('before')||'')?ctx.query.get('before'):'';
 const at=(k,b)=>{const p=new URLSearchParams();if(k)p.set('kind',k);if(b!=null&&b!=='')p.set('before',b);const s=p.toString();return '#/'+(s?'?'+s:'');};
 const [stats,pending,activity]=await Promise.all([api('/stats',{signal:ctx.signal}),api('/pending',{signal:ctx.signal}),
  api(`/activity?limit=${PAGE}${kind?'&kind='+kind:''}${before?'&before='+before:''}`,{signal:ctx.signal})]);
 ctx.tip(stats.height);
 const tile=(label,value,unit)=>el('div',{class:'tile','data-stat':label},el('span',{class:'label',text:label}),el('span',{class:'value'},value,unit?el('span',{class:'unit',text:unit}):null));
 const known=new Set(pending.jobs.map(j=>j.id)),pool=pending.pool.filter(p=>!known.has(p.id));
 add(ctx.main,
  el('div',{class:'head'},el('h1',{text:'Mordinals'}),
   el('p',{class:'lede',text:'Inscriptions on Monero, each owned by a Monero address. Everything here is read from Monero blocks.'}),
   searchBox(),
   el('div',{class:'stats'},tile('Mordinals',count(stats.mordinals)),tile('Claimed',count(stats.claimed)),tile('For sale',count(stats.forSale)),
    tile('Sales',count(stats.sales)),tile('Volume',xmr(stats.volume),'XMR'))),
  el('section',{class:'section','data-section':'waiting'},el('div',{class:'section-head'},el('h2',{text:'Waiting for a block'}),
    el('span',{class:'dim',text:'These records do not count yet.'})),
   pending.jobs.length||pool.length?[
    pending.jobs.length?waitingList(pending.jobs):null,
    pool.length?table([{label:'Record',cell:p=>OPNAME[p.op]||'Record'},{label:'Code',cell:p=>code(p.id)},{label:'Transaction',cell:p=>txid(p.txid)},
     {label:'State',cell:()=>'Seen by the Monero node, not in a block yet'}],pool):null]
    :el('p',{class:'empty',text:'Nothing is waiting.'})),
  el('section',{class:'section','data-section':'activity'},el('div',{class:'section-head'},el('h2',{text:before?'Earlier activity':'Newest activity'}),
    pills(KINDS,kind,k=>{location.hash=at(k);},'Kind of event')),
   table(eventColumns(),activity.events,'No events of this kind yet.'),
   el('div',{class:'pager'},
    before?el('a',{class:'btn',href:at(kind),text:'Newest'}):el('span',{}),
    activity.next!=null?el('a',{class:'btn',href:at(kind,activity.next),text:'Older'}):el('span',{class:'where',text:activity.events.length?'This is the oldest.':''}))));}

export async function address(ctx,a){
 const info=service.info,me=canonical(a,info.network),before=/^\d{1,9}$/.test(ctx.query.get('before')||'')?ctx.query.get('before'):'';
 ctx.title('Address');
 const [own,activity]=await Promise.all([api('/address/'+me,{signal:ctx.signal}),
  api(`/activity?limit=${PAGE}&address=${me}${before?'&before='+before:''}`,{signal:ctx.signal})]);
 const pic=pictures(ctx),height=own.height;ctx.tip(height);
 const buying=own.buying.map(l=>{try{return terms(l);}catch{return null;}}).filter(Boolean);
 add(ctx.main,
  el('div',{class:'head'},el('a',{class:'crumb',href:'#/',text:'Explorer'}),el('h1',{class:'small',text:'Address'}),
   el('div',{class:'section'},exact(me,{what:'address'}))),
  buying.length?el('section',{class:'section','data-section':'buying'},el('div',{class:'section-head'},el('h2',{text:'Purchases to continue'})),
   table([{label:'NFT',cell:t=>mordinalLink(t.number??t.nft)},{label:'Price',cell:t=>strong(xmr(t.price)+' XMR')},
    {label:'Reservation',cell:t=>t.reservation.payBy<height?'Ran out at block '+count(t.reservation.payBy):'Pay by block '+count(t.reservation.payBy)},
    {label:'',cell:t=>el('a',{class:'btn small',href:`#/buy/${t.id}/${me}`,text:'Continue'})}],buying)):null,
  own.waiting.length?el('section',{class:'section','data-section':'waiting'},el('div',{class:'section-head'},el('h2',{text:'Waiting for a block'}),
   el('span',{class:'dim',text:'These records do not count yet.'})),waitingList(own.waiting)):null,
  el('section',{class:'section','data-section':'owned'},el('div',{class:'section-head'},el('h2',{text:'Mordinals it owns'}),el('span',{class:'dim',text:count(own.mordinals.length)})),
   own.mordinals.length?el('div',{class:'grid'},own.mordinals.map(m=>card(pic,m,height))):el('p',{class:'empty',text:'This address owns no claimed Mordinal.'})),
  el('section',{class:'section','data-section':'activity'},el('div',{class:'section-head'},el('h2',{text:'Activity'})),
   table(eventColumns(),activity.events,'No records name this address.'),
   el('div',{class:'pager'},before?el('a',{class:'btn',href:'#/address/'+me,text:'Newest'}):el('span',{}),
    activity.next!=null&&activity.events.length?el('a',{class:'btn',href:`#/address/${me}?before=${activity.next}`,text:'Older'}):el('span',{}))));}

export async function record(ctx,id){
 ctx.title('Record');
 const [s,e]=await Promise.all([api('/status/'+id,{signal:ctx.signal}),findEvent(x=>x.id===id,ctx.signal)]);
 add(ctx.main,
  el('div',{class:'head'},el('a',{class:'crumb',href:'#/',text:'Explorer'}),el('h1',{class:'small',text:'Record'}),
   el('div',{class:'section'},exact(id,{what:'record code'}))),
  el('section',{class:'section card stack'},el('h2',{text:'Where it is'}),
   s.state==='unknown'&&!e?el('p',{class:'muted',text:'This service does not know a record with this code.'}):follow(ctx,id),
   el('p',{class:'dim',text:'A record counts only once it is in a Monero block.'})),
  e?el('section',{class:'section'},el('div',{class:'section-head'},el('h2',{text:'What it did'})),table(eventColumns(),[e])):null);}
