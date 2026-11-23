// The gallery: every Mordinal as a card, one page of the list at a time.
import {el,add,api,count,xmr,pills,pictures,service,mordinalName} from './ui.js';

const FILTERS=[['all','All'],['claimed','Claimed'],['unclaimed','Unclaimed'],['listed','For sale']],PAGE=60;

// One Mordinal as a card. The price shown is the service's plain field, for reading only;
// buying always starts from the listing's own record on its page.
export function card(pic,m,height){
 const lot=m.lot||null,reserved=lot&&(lot.reserved??Boolean(lot.reservation&&lot.reservation.payBy>=height));
 const box=pic(m.number,{hasContent:m.bodySize!==null});
 box.addEventListener('click',e=>{if(!e.target.closest('button'))location.hash='#/mordinal/'+m.number;});
 return el('article',{class:'mcard','data-number':m.number},box,
  el('a',{class:'meta',href:'#/mordinal/'+m.number},
   el('span',{class:'n',title:mordinalName(m.number,m.name),text:mordinalName(m.number,m.name)}),
   el('span',{class:'s'},el('span',{'data-claimed':String(Boolean(m.claimed)),text:(m.name?'#'+count(m.number)+' · ':'')+(m.burned?'Burned':m.claimed?'Claimed':m.waiting?'Waiting for its fee':'Unclaimed')}),
    lot?el('span',{class:'price',text:xmr(lot.price)+' XMR'}):null),
   reserved?el('span',{class:'s'},el('span',{text:'Reserved'})):null));}

export async function gallery(ctx){
 ctx.title('Gallery');
 const asked=ctx.query.get('filter'),filter=FILTERS.some(([f])=>f===asked)?asked:'all';
 const from=Math.max(0,Math.floor(Number(ctx.query.get('from'))||0));
 const g=await api(`/gallery?filter=${filter}&from=${from}&limit=${PAGE}`,{signal:ctx.signal});
 const pic=pictures(ctx);ctx.tip(g.height);
 const at=start=>'#/gallery?filter='+filter+(start>0?'&from='+start:'');
 const last=Math.max(0,Math.floor((g.total-1)/PAGE)*PAGE),step=(text,start,on)=>on?el('a',{class:'btn',href:at(start),text}):el('button',{type:'button',class:'btn',disabled:true,text});
 const where=g.items.length?`${count(g.from+1)}–${count(g.from+g.items.length)} of ${count(g.total)}`:`0 of ${count(g.total)}`;
 add(ctx.main,
  el('div',{class:'head'},el('h1',{text:'Gallery'}),
   el('p',{class:'lede',text:`All ${count(service.info.count)} Mordinals in the order they were inscribed. Open one to see who owns it.`})),
  el('div',{class:'section-head'},pills(FILTERS,filter,f=>{location.hash='#/gallery?filter='+f;},'Show'),el('span',{class:'dim','data-where':'',text:where})),
  g.items.length?el('div',{class:'grid'},g.items.map(m=>card(pic,m,g.height))):el('p',{class:'empty',text:'No Mordinals here.'}),
  g.total>PAGE?el('div',{class:'pager'},
   el('div',{class:'row'},step('First',0,g.from>0),step('Previous',Math.max(0,g.from-PAGE),g.from>0)),
   el('span',{class:'where',text:`Page ${count(Math.floor(g.from/PAGE)+1)} of ${count(Math.floor(last/PAGE)+1)}`}),
   el('div',{class:'row'},step('Next',g.from+PAGE,g.from+PAGE<g.total),step('Last',last,g.from<last))):null);}
