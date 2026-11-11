// The link from these pages to a wallet. A site that hosts the pages may provide one as globalThis.xmr721Wallet:
//   status() -> {connected, address, label, demo?}    connect() -> status    disconnect()
//   openMordinals()   shows the wallet's own screens, where keys stay and every claim, sale and purchase is approved
//   onChange(fn) -> stop
// These pages never see a key or a recovery phrase. Without a wallet link they work as before, by signed messages.
import {canonical} from './rules.js';
import {el,add,api,service,count,xmr,addr,notice,pill,mordinalLink} from './ui.js';

export const walletLink=()=>{const w=globalThis.xmr721Wallet;return w&&typeof w.connect==='function'&&typeof w.status==='function'?w:null;};
// Runs `again` when the wallet connects, locks or closes its screens, until the view is left.
export function watchWallet(ctx,again){
 const w=walletLink();
 if(w?.onChange)ctx.onLeave(w.onChange(()=>again()));
 else{const late=()=>again();addEventListener('xmr721-wallet',late,{once:true});ctx.onLeave(()=>removeEventListener('xmr721-wallet',late));}}

// "Your Mordinals" on the market: connect, then what this address owns and a way into the wallet's screens.
export async function walletPanel(ctx,pic){
 const w=walletLink();if(!w)return null;
 const s=w.status(),problem=el('div',{}),box=el('section',{class:'section card stack wallet-panel','data-section':'wallet','data-connected':String(Boolean(s.connected))});
 const act=(button,work)=>async()=>{button.disabled=true;problem.replaceChildren();try{await work();}catch(e){problem.replaceChildren(notice('error',e.message||'The wallet did not answer.'));}finally{button.disabled=false;}};
 if(!s.connected){
  const go=el('button',{type:'button',class:'btn primary','data-action':'connect',text:'Connect wallet'});go.addEventListener('click',act(go,()=>w.connect()));
  add(box,el('h2',{text:'Your Mordinals'}),
   el('p',{class:'muted',text:'Connect the wallet that holds your Mordinals. It finds them on your device, and you claim, sell and buy with one approval each. This page never sees your keys.'}),
   el('div',{class:'row'},go,el('a',{class:'btn',href:'#/xmr721',text:'How it works'})),problem);
  return box;}
 let mine=[],made=[];try{const a=await api('/address/'+canonical(s.address,service.info.network),{signal:ctx.signal});mine=a.mordinals;made=a.nfts||[];}catch(e){if(e.name==='AbortError')throw e;}
 const find=el('button',{type:'button',class:'btn primary','data-action':'find',text:'Find my Mordinals'}),open=el('button',{type:'button',class:'btn','data-action':'open-wallet',text:'Sell, send or buy'});
 const leave=el('button',{type:'button',class:'btn','data-action':'disconnect',text:'Disconnect'});
 for(const b of [find,open])b.addEventListener('click',act(b,async()=>w.openMordinals()));leave.addEventListener('click',act(leave,async()=>w.disconnect()));
 add(box,el('div',{class:'section-head'},el('h2',{text:'Your Mordinals'}),el('span',{class:'row'},s.demo?pill('Demo wallet','yellow'):null,addr(s.address))),
  mine.length||made.length?el('div',{class:'owned'},made.map(x=>el('a',{class:'owned-item','data-nft':x.id,href:'#/nft/'+x.id},
    el('span',{},el('span',{class:'strong',text:x.name||'NFT '+x.id.slice(0,8)}),el('span',{class:'dim',text:x.lot?'For sale, '+xmr(x.lot.price)+' XMR':'XMR721 NFT'})))),mine.map(m=>el('a',{class:'owned-item','data-number':m.number,href:'#/mordinal/'+m.number},pic(m.number,{size:'thumb'}),
    el('span',{},el('span',{class:'strong',text:'#'+count(m.number)}),el('span',{class:'dim',text:m.lot?'For sale, '+xmr(m.lot.price)+' XMR':'XMR721 NFT'})))))
   :el('p',{class:'muted',text:'This address holds no XMR721 NFTs yet. Mordinals you inscribed or received in 2023 are found and claimed inside the wallet.'}),
  el('div',{class:'row'},find,open,leave),
  el('p',{class:'dim',text:'Finding checks the public list on your device. Claiming signs with the key of the inscribed coin; the coin is not spent and no XMR moves.'}),problem);
 return box;}
