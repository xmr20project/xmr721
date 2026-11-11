// Collections shown next to the Mordinals: a grid of a collection's NFTs and one NFT's page. Read-only.
import {el,add,api,count,addr,txid,pill,ROOT} from './ui.js';

const src=(key,edition)=>new URL(`collections/${key}/${edition}/picture`,ROOT).href;
const title=t=>t.attributes?.artwork||t.name;
const fact=(label,value)=>el('div',{},el('dt',{text:label}),el('dd',{},value));

export function nftCard(key,t){
 return el('article',{class:'mcard','data-edition':t.edition},
  el('a',{class:'pic pixel',href:`#/nft/${key}/${t.edition}`},el('img',{alt:title(t),loading:'lazy',src:src(key,t.edition)})),
  el('a',{class:'meta',href:`#/nft/${key}/${t.edition}`},
   el('span',{class:'n',text:'#'+count(t.edition)}),
   el('span',{class:'s'},el('span',{text:title(t)}))));}

// The grid used inside the market.
export async function collectionGrid(ctx,key){
 const c=await api('/collections/'+key,{signal:ctx.signal});
 return el('section',{class:'section','data-section':'collection'},
  el('div',{class:'section-head'},el('h2',{text:c.collection.name}),el('span',{class:'dim',text:`${count(c.collection.minted)} of ${count(c.collection.max)} minted`})),
  el('p',{class:'note',text:'These were inscribed in 2026 in an earlier format. They are shown here as they are on the chain; they cannot be bought or sold in this market yet.'}),
  el('div',{class:'grid'},c.items.map(t=>nftCard(key,t))));}

export async function nft(ctx,key,edition){
 const v=await api(`/collections/${key}/${edition}`,{signal:ctx.signal}),t=v.item,c=v.collection;
 ctx.title(`${c.name} #${t.edition}`);ctx.tip(v.height);
 const more=Object.entries(t.attributes||{}).filter(([k])=>!['editions','artwork'].includes(k));
 add(ctx.main,
  el('p',{class:'crumb'},el('a',{href:'#/market?show='+key,text:c.name}),el('span',{text:'/'}),el('span',{text:'#'+t.edition})),
  el('div',{class:'split'},
   el('div',{class:'pic pixel large'},el('img',{alt:title(t),src:src(key,t.edition)})),
   el('div',{class:'stack'},
    el('div',{class:'head'},el('h1',{class:'small',text:title(t)}),el('p',{class:'lede',text:`${c.name}, edition ${t.edition} of ${c.max}`})),
    el('div',{class:'row'},pill('Not for sale here yet')),
    el('div',{class:'card'},el('dl',{class:'kv'},
     fact('Owner',addr(t.owner)),fact('Minted at block',count(t.mintedAt)),
     fact('Mint transaction',txid(t.id)),fact('Transfers',count(t.transfers)),
     ...more.map(([k,val])=>fact(k[0].toUpperCase()+k.slice(1),val)),
     fact('Picture',`${t.width} × ${t.height}, ${t.codec==='json-text-1'?'palette':'WebP'}`))))));}
