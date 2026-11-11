// Collections: Mordinals as a whole, the collections this service carries (GENESIS), and, when the hosting page names
// a public Mordinals archive (<meta name="xmr721-archive" content="/api/mordinals">), the collections that archive
// infers among the 2023 inscriptions. Archive data is for browsing only: names and groupings are the archive's own
// reading of titles and links, and nothing here decides who owns a Mordinal.
import {el,add,api,service,count,notice,ROOT} from './ui.js';
import {loadMedia,nftPicture} from './collection.js';

const ARCHIVE=document.querySelector('meta[name="xmr721-archive"]')?.content||null,PAGE=24;
const IMAGES=new Set(['image/png','image/jpeg','image/webp','image/gif']),HEX=/^[0-9a-f]{64}$/,GROUP=/^[0-9a-f]{24}$/;
const RUDE=/\b(nsfw|porn(?:star|ographic|ography)?|hentai|nudity|nudes?|naked|erotic|xxx|cunny|retard(?:ed)?)\b/i;
const hidden=t=>t.sensitive===true||RUDE.test(t.title||'');
// Groups of a handful of inscriptions are mostly one person's uploads; the list starts at this size.
const SMALLEST=10;
const showable=t=>Number.isSafeInteger(t.id)&&HEX.test(t.sha256||'')&&IMAGES.has(t.mime)&&t.size<=3145728&&!hidden(t);
const fileOf=t=>new URL(`${ARCHIVE}?route=file&id=${t.id}&sha=${t.sha256}`,location.href).href;
async function archive(args,signal){
 const r=await fetch(new URL(ARCHIVE+'?'+new URLSearchParams({route:'catalog',q:'',sort:'oldest',...args}),location.href),{signal,credentials:'omit'});
 if(!r.ok)throw Error('The Mordinals archive did not answer.');
 const d=await r.json();if(!Array.isArray(d.items)||!Array.isArray(d.collections))throw Error('The Mordinals archive sent something else.');
 d.collections=d.collections.filter(g=>GROUP.test(g.id)&&typeof g.name==='string'&&Number.isSafeInteger(g.count));return d;}
const shortName=name=>name.length>44?name.slice(0,42).trimEnd()+'…':name;

// One collection as a card: three pictures, a name, a count.
function tile(href,name,note,kind){
 const mosaic=el('span',{class:'mosaic'},el('span',{}),el('span',{}),el('span',{}));
 return {mosaic,card:el('a',{class:'ccard','data-kind':kind,href,title:name},mosaic,el('span',{class:'cmeta'},el('span',{class:'n',text:shortName(name)}),el('span',{class:'s',text:note})))};}
const put=(mosaic,urls,pixel=false)=>[...mosaic.children].forEach((slot,i)=>{if(urls[i])slot.replaceChildren(el('img',{alt:'',loading:'lazy',class:pixel?'pixel':null,src:urls[i]}));});

// The cards. `limit` keeps the strip on the market short.
export async function collectionCards(ctx,{limit=Infinity}={}){
 const info=service.info,cards=[],[held,map]=await Promise.all([api('/collections',{signal:ctx.signal}).then(v=>v.collections),loadMedia(ctx.signal)]);
 const all=tile('#/gallery','Mordinals',`${count(info.count)} inscriptions from 2023`,'mordinals');cards.push(all.card);
 api('/gallery?filter=all&from=0&limit=12',{signal:ctx.signal}).then(g=>put(all.mosaic,g.items.filter(m=>m.bodySize!==null).slice(0,3).map(m=>new URL('content/'+m.number,ROOT).href),true)).catch(()=>{});
 for(const c of held){const t=tile('#/market?show='+c.key,c.name,`${count(c.minted)} of ${count(c.max)} · earlier format`,'held');
  [...t.mosaic.children].forEach((slot,i)=>slot.replaceChildren(nftPicture(map,c.key,[4,1,5][i])));cards.push(t.card);}
 let groups=[],problem=null;
 if(ARCHIVE){try{groups=(await archive({page:'1'},ctx.signal)).collections.filter(g=>g.count>=SMALLEST&&!RUDE.test(g.name)).sort((a,b)=>b.count-a.count);}catch(e){if(e.name==='AbortError')throw e;problem=e.message;}}
 // A collection's pictures load when its card comes into view.
 const io='IntersectionObserver' in window?new IntersectionObserver(seen=>{for(const s of seen)if(s.isIntersecting){io.unobserve(s.target);s.target.fill?.();}},{rootMargin:'200px'}):null;
 ctx.onLeave(()=>io?.disconnect());
 for(const g of groups.slice(0,Math.max(0,limit-cards.length))){
  const t=tile('#/collection/'+g.id,g.name,`${count(g.count)} Mordinals`,'archive');
  t.card.fill=()=>archive({page:'1',collection:g.id},ctx.signal).then(d=>{const urls=d.items.filter(showable).slice(0,3).map(fileOf);
   if(urls.length)put(t.mosaic,urls);else t.mosaic.replaceChildren(el('span',{class:'none',text:'No picture to show'}));}).catch(()=>{});
  if(io)io.observe(t.card);else t.card.fill();cards.push(t.card);}
 return {cards,groups:groups.length,problem};}

export async function collections(ctx){
 ctx.title('Collections');
 const {cards,groups,problem}=await collectionCards(ctx);
 add(ctx.main,
  el('div',{class:'head'},el('h1',{text:'Collections'}),
   el('p',{class:'lede',text:'Mordinals, the collections found among them, and GENESIS. Every Mordinal can become an XMR721 NFT once its holder claims it.'})),
  problem?notice('warn',problem):null,
  el('section',{class:'section','data-section':'collections'},el('div',{class:'cgrid'},cards)),
  groups?el('p',{class:'dim section',text:`The ${count(groups)} Mordinal collections shown are groupings of ten or more, worked out from titles, descriptions and shared links of the 2023 inscriptions. They are a guide for browsing, not part of the ownership rules.`}):null);}

// One archive collection, a page at a time.
export async function archiveCollection(ctx,id){
 if(!ARCHIVE)throw Error('This copy of the pages has no Mordinals archive.');
 const page=Math.max(1,Math.floor(Number(ctx.query.get('page'))||1)),d=await archive({page:String(page),collection:id},ctx.signal),g=d.collections.find(x=>x.id===id);
 if(!g)throw Error('The archive knows no such collection.');
 ctx.title(shortName(g.name));
 const at=p=>`#/collection/${id}`+(p>1?'?page='+p:''),step=(text,p,on)=>on?el('a',{class:'btn',href:at(p),text}):el('button',{type:'button',class:'btn',disabled:true,text});
 add(ctx.main,
  el('p',{class:'crumb'},el('a',{href:'#/collections',text:'Collections'}),el('span',{text:'/'}),el('span',{text:'Mordinals'})),
  el('div',{class:'head'},el('h1',{class:'small',text:g.name.length>90?g.name.slice(0,88)+'…':g.name}),
   el('p',{class:'lede',text:`${count(g.count)} Mordinals, grouped by ${g.basis}.`})),
  service.info.test?notice('note','This preview runs on a test ledger, so these real Mordinals cannot be opened, claimed or bought here.'):null,
  el('section',{class:'section','data-section':'archive-items'},
   el('div',{class:'grid'},d.items.map(t=>el('article',{class:'mcard','data-archive':t.id},
    el('a',{class:'pic',href:'#/search?q='+t.txid},showable(t)?el('img',{alt:'',loading:'lazy',src:fileOf(t)}):el('span',{text:hidden(t)?'Hidden':'Not a picture'})),
    el('a',{class:'meta',href:'#/search?q='+t.txid},el('span',{class:'n',text:(t.title||'Untitled').slice(0,40)}),el('span',{class:'s'},el('span',{text:'Block '+count(t.height)})))))),
   el('div',{class:'pager'},step('Newer',page-1,page>1),el('span',{class:'where',text:`Page ${count(d.page)} of ${count(d.pages)}`}),step('Older',page+1,page<d.pages))));}
