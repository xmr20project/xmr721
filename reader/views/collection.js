// Collections shown next to the Mordinals: a grid of a collection's NFTs and one NFT's page. Read-only.
import {el,add,api,count,addr,txid,pill,ROOT} from './ui.js';

// The service draws each NFT as it is meant to be seen: its own text over its picture.
const src=(key,edition)=>new URL(`collections/${key}/${edition}/picture`,ROOT).href;
// A hosting site may have larger pictures and pages of its own for a collection. It names a JSON file
// (<meta name="xmr721-media" content="…">) of {<collection key>: {<edition>: {image, href}}}; both must be paths on
// the same site. With it, cards show that picture and open that page.
const MEDIA=document.querySelector('meta[name="xmr721-media"]')?.content||null;
let media=null;
const local=path=>typeof path==='string'&&/^\/(?!\/)[^\s"'<>\\]*$/.test(path);
export function loadMedia(signal){
 if(!MEDIA)return Promise.resolve({});
 return media||(media=fetch(new URL(MEDIA,location.href),{signal,credentials:'omit'}).then(r=>r.ok?r.json():{}).catch(()=>{media=null;return {};}));}
const better=(map,key,edition)=>{const m=map?.[key]?.[edition];return m&&local(m.image)&&local(m.href)?m:null;};
// The picture of one edition: the site's larger one when there is one (falling back to the service's drawing).
export function nftPicture(map,key,edition,alt=''){
 const m=better(map,key,edition),img=el('img',{alt,loading:'lazy',decoding:'async',src:m?m.image:src(key,edition)});
 if(m)img.addEventListener('error',()=>{img.src=src(key,edition);},{once:true});
 return img;}
export const nftHref=(map,key,edition)=>better(map,key,edition)?.href||`#/nft/${key}/${edition}`;
const title=t=>t.attributes?.artwork||t.name;
const fact=(label,value)=>el('div',{},el('dt',{text:label}),el('dd',{},value));

export function nftCard(key,t,map){
 const href=nftHref(map,key,t.edition);
 return el('article',{class:'mcard','data-edition':t.edition},
  el('a',{class:'pic art',href},nftPicture(map,key,t.edition,title(t))),
  el('a',{class:'meta',href},
   el('span',{class:'n',text:'#'+count(t.edition)}),
   el('span',{class:'s'},el('span',{text:title(t)}))));}

// The grid used inside the market.
export async function collectionGrid(ctx,key){
 const [c,map]=await Promise.all([api('/collections/'+key,{signal:ctx.signal}),loadMedia(ctx.signal)]);
 return el('section',{class:'section','data-section':'collection'},
  el('div',{class:'section-head'},el('h2',{text:c.collection.name}),el('span',{class:'dim',text:`${count(c.collection.minted)} of ${count(c.collection.max)} minted`})),
  el('p',{class:'note',text:'These were inscribed in 2026 in an earlier format. Each is drawn from its own inscription: its text, coloured by its picture. They cannot be bought or sold in this market yet.'}),
  el('div',{class:'grid art-grid'},c.items.map(t=>nftCard(key,t,map))));}

export async function nft(ctx,key,edition){
 const [v,map]=await Promise.all([api(`/collections/${key}/${edition}`,{signal:ctx.signal}),loadMedia(ctx.signal)]),t=v.item,c=v.collection,page=nftHref(map,key,t.edition);
 ctx.title(`${c.name} #${t.edition}`);ctx.tip(v.height);
 const more=Object.entries(t.attributes||{}).filter(([k])=>!['editions','artwork'].includes(k));
 add(ctx.main,
  el('p',{class:'crumb'},el('a',{href:'#/market?show='+key,text:c.name}),el('span',{text:'/'}),el('span',{text:'#'+t.edition})),
  el('div',{class:'split'},
   el('div',{class:'pic art large'},nftPicture(map,key,t.edition,title(t))),
   el('div',{class:'stack'},
    el('div',{class:'head'},el('h1',{class:'small',text:title(t)}),el('p',{class:'lede',text:`${c.name}, edition ${t.edition} of ${c.max}`})),
    el('div',{class:'row'},pill('Not for sale here yet'),page.startsWith('/')?el('a',{class:'btn small',href:page,text:'Open its page'}):null),
    el('div',{class:'card'},el('dl',{class:'kv'},
     fact('Owner',addr(t.owner)),fact('Minted at block',count(t.mintedAt)),
     fact('Mint transaction',txid(t.id)),fact('Transfers',count(t.transfers)),
     ...more.map(([k,val])=>fact(k[0].toUpperCase()+k.slice(1),val)),
     fact('Picture',`${t.width} × ${t.height}, ${t.codec==='json-text-1'?'palette':'WebP'}`))))));}
