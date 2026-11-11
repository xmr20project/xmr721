// Collections: Mordinals as a whole, the collections found among them (ownership-index/collections: display groups
// made from each inscription's published title and links), GENESIS, and collections made on this ledger. A
// collection is a guide for browsing; nothing here decides who owns a Mordinal.
import {el,add,api,service,count,xmr,pills,ROOT} from './ui.js';
import {loadMedia,nftPicture} from './collection.js';
import {card} from './gallery.js';
import {pictures} from './ui.js';
// Pictures of a collection's members come through the same loader as everywhere: checked, and hidden when marked sensitive.

const PAGE=60,SMALLEST=10;
const shortName=name=>name.length>44?name.slice(0,42).trimEnd()+'…':name;

// One collection as a card: three pictures, a name, figures.
function tile(href,name,note,kind,extra=null){
 const mosaic=el('span',{class:'mosaic'},el('span',{}),el('span',{}),el('span',{}));
 return {mosaic,card:el('a',{class:'ccard','data-kind':kind,href,title:name},mosaic,el('span',{class:'cmeta'},el('span',{class:'n',text:shortName(name)}),el('span',{class:'s',text:note}),extra))};}
const put=(mosaic,urls,pixel=false)=>[...mosaic.children].forEach((slot,i)=>{if(urls[i])slot.replaceChildren(el('img',{alt:'',loading:'lazy',class:pixel?'pixel':null,src:urls[i]}));});
const figures=g=>[`${count(g.count)} Mordinals`,g.forSale?`${count(g.forSale)} for sale`:null].filter(Boolean).join(' · ');
const floorTag=g=>g.floor!=null?el('span',{class:'cfloor'},el('span',{text:'Floor '}),el('b',{text:xmr(g.floor)+' XMR'})):null;
const groupTile=(g,pic)=>{const t=tile('#/collection/'+g.id,g.name,figures(g),'group',floorTag(g));[...t.mosaic.children].forEach((slot,i)=>{if(g.sample[i]!=null)slot.replaceChildren(pic(g.sample[i]));});return t.card;};

// The cards. `limit` keeps the strip on the market short.
export async function collectionCards(ctx,{limit=Infinity}={}){
 const info=service.info,cards=[],[held,map,list]=await Promise.all([api('/collections',{signal:ctx.signal}).then(v=>v.collections),loadMedia(ctx.signal),
  api('/groups',{signal:ctx.signal}).then(v=>v.groups).catch(()=>[])]);
 const all=tile('#/gallery','Mordinals',`All ${count(info.count)} inscriptions`,'mordinals');cards.push(all.card);
 api('/gallery?filter=all&from=0&limit=12',{signal:ctx.signal}).then(g=>put(all.mosaic,g.items.filter(m=>m.bodySize!==null).slice(0,3).map(m=>new URL('content/'+m.number,ROOT).href),true)).catch(()=>{});
 for(const c of held){const t=tile('#/market?show='+c.key,c.name,`${count(c.minted)} of ${count(c.max)} · earlier format`,'held');
  [...t.mosaic.children].forEach((slot,i)=>slot.replaceChildren(nftPicture(map,c.key,[4,1,5][i])));cards.push(t.card);}
 // Collections made on this ledger.
 const made=await api('/nft-collections',{signal:ctx.signal}).then(v=>v.collections).catch(()=>[]);
 for(const c of made){const t=tile('#/set/'+c.id,c.name,`${count(c.minted)} of ${count(c.max)} minted`,'made');
  api('/nfts?limit=3&collection='+c.id,{signal:ctx.signal}).then(v=>put(t.mosaic,v.items.filter(x=>x.type>=1&&x.type<=4).map(x=>new URL(`nft/${x.id}/content`,ROOT).href),true)).catch(()=>{});cards.push(t.card);}
 const big=list.filter(g=>g.count>=SMALLEST),small=list.filter(g=>g.count<SMALLEST);
 const pic=pictures(ctx);for(const g of big.slice(0,Math.max(0,limit-cards.length)))cards.push(groupTile(g,pic));
 return {cards,big,small};}

export async function collections(ctx){
 ctx.title('Collections');
 const {cards,big,small}=await collectionCards(ctx);
 add(ctx.main,
  el('div',{class:'head'},el('h1',{text:'Collections'}),
   el('p',{class:'lede',text:`Every collection among the ${count(service.info.count)} Mordinals, and GENESIS. Each Mordinal can become an XMR721 NFT once its holder claims it.`})),
  el('section',{class:'section','data-section':'collections'},el('div',{class:'cgrid'},cards)),
  small.length?el('section',{class:'section card catalog','data-section':'small-groups'},
   el('div',{class:'cat-head'},el('div',{},el('h2',{text:'Smaller groups'}),el('p',{class:'card-sub',text:`${count(small.length)} groups of fewer than ${SMALLEST} Mordinals.`}))),
   el('div',{class:'chips-list'},small.map(g=>el('a',{class:'gchip',href:'#/collection/'+g.id,title:g.fullName},el('span',{text:shortName(g.name)}),el('b',{text:count(g.count)}))))):null,
  big.length||small.length?el('p',{class:'dim section',text:'Collections are worked out from the titles, descriptions and shared links the inscriptions published, by the rule in the index (ownership-index/collections). They are a guide for browsing, not part of the ownership rules.'}):null);}

const FILTERS=[['all','All'],['listed','For sale'],['claimed','Claimed']];
// One collection of Mordinals, a page at a time.
export async function groupCollection(ctx,id){
 const asked=ctx.query.get('filter'),filter=FILTERS.some(([f])=>f===asked)?asked:'all',from=Math.max(0,Math.floor(Number(ctx.query.get('from'))||0));
 const v=await api(`/group/${id}?filter=${filter}&from=${from}&limit=${PAGE}`,{signal:ctx.signal}),g=v.group,pic=pictures(ctx);ctx.tip(v.height);
 ctx.title(shortName(g.name));
 const at=(f,start)=>`#/collection/${id}?filter=${f}`+(start>0?'&from='+start:'');
 const step=(text,start,on)=>on?el('a',{class:'btn',href:at(filter,start),text}):el('button',{type:'button',class:'btn',disabled:true,text});
 const where=v.items.length?`${count(v.from+1)}–${count(v.from+v.items.length)} of ${count(v.total)}`:`0 of ${count(v.total)}`;
 const stat=(k,val)=>el('div',{class:'gstat'},el('span',{text:k}),el('b',{text:val}));
 add(ctx.main,
  el('p',{class:'crumb'},el('a',{href:'#/collections',text:'Collections'}),el('span',{text:'/'}),el('span',{text:'Mordinals'})),
  el('div',{class:'head'},el('h1',{class:'small',text:g.name.length>90?g.name.slice(0,88)+'…':g.name}),
   g.fullName!==g.name?el('p',{class:'dim',text:g.fullName}):null,
   el('div',{class:'gstats'},stat('Mordinals',count(g.count)),stat('Claimed',count(g.claimed)),stat('For sale',count(g.forSale)))),
  el('section',{class:'section','data-section':'group-items'},
   el('div',{class:'section-head'},pills(FILTERS,filter,f=>{location.hash=at(f,0);},'Show'),el('span',{class:'where dim',text:where})),
   v.items.length?el('div',{class:'grid'},v.items.map(m=>card(pic,m,v.height))):el('p',{class:'empty',text:filter==='listed'?'Nothing from this collection is for sale right now.':filter==='claimed'?'No Mordinal of this collection is claimed yet.':'Nothing here.'}),
   v.total>PAGE?el('div',{class:'pager'},step('Previous',Math.max(0,v.from-PAGE),v.from>0),el('span',{class:'where',text:where}),step('Next',v.from+PAGE,v.from+PAGE<v.total)):null),
  el('p',{class:'dim section',text:`Grouped by ${g.basis}. A collection is a guide for browsing; ownership comes only from the records.`}));}
