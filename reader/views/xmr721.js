// What XMR721 is, how a Mordinal becomes an XMR721 NFT, and the short tutorial shown on a first visit to the market.
import {el,add,service,count,notice} from './ui.js';
import {walletLink} from './wallet.js';
import {burning,burnHow,burnAhead,burnMisfit} from './burn.js';

// The ledger claims by burning now, and the service states what these pages work out themselves.
const live=()=>{const b=burning();return b?.active&&b.fits?b:null;};
const SEEN='xmr721-tutorial-seen';
const seen=()=>{try{return localStorage.getItem(SEEN)==='1';}catch{return false;}};
const remember=()=>{try{localStorage.setItem(SEEN,'1');}catch{}};

// The four steps, used by the page and by the tutorial.
const STEPS=[
 {key:'what',title:'Mordinals are back, as XMR721',
  body:()=>[el('p',{text:'XMR721 is an NFT standard for Monero. An NFT belongs to an ordinary Monero address and is sent or sold by signing a message in your wallet.'}),
   live()
    ?el('p',{text:'In 2023, every move of a Mordinal spent its coin in public. With XMR721 that happens once: the claim burns the old Mordinal. After it, nothing is spent and nothing about your Monero spending is shown to anyone.'})
    :el('p',{text:'In 2023, moving a Mordinal meant spending its coin in public. With XMR721 the coin is never spent, so nothing about your Monero spending is shown to anyone.'})]},
 {key:'wallet',title:'Open the wallet that holds your Mordinals',
  body:()=>[el('p',{text:'Use the wallet you inscribed with or received them in. In the XMR20 wallet, restore it with that wallet’s recovery phrase. The phrase stays on your device.'}),
   live()
    ?el('p',{class:'dim',text:live().wallet?'The original Mordinals wallet can claim too; its commands are under How it works.':'Claiming is done with the original Mordinals wallet; its commands are under How it works.'})
    :el('p',{class:'dim',text:'Feather and Cake Wallet holders can claim too; it takes one more step, described under How it works.'}),
   connectRow()]},
 {key:'claim',title:'Find and claim them',
  body:()=>[el('p',{text:'Choose “Find my Mordinals”. The wallet checks the public list of all Mordinals on your device and shows the ones your keys hold.'}),
   live()
    ?el('p',{text:(live().wallet?'Press “Burn and claim”. The wallet sends the old Mordinal to the burn address and names your Monero address;':'Burn each one: transfer the old Mordinal to the burn address with a text that names your Monero address, as described under How it works;')
      +' it then is an XMR721 NFT at that address, with its number, its picture and its history. This is one Monero transaction: it spends the inscribed coin in public and costs about 0.001 XMR. A burn that is refused cannot be tried again.'})
    :el('p',{text:'Press Claim. Each one becomes an XMR721 NFT at your Monero address. It keeps its number, its picture and its history. Nothing is spent and no XMR moves.'})]},
 {key:'trade',title:'Sell or send by signing a message',
  body:()=>[el('p',{text:'Once claimed, a Mordinal can be listed here for XMR or sent to another address. Each step is a message you sign in your wallet.'}),
   el('p',{text:'A buyer pays you directly in XMR. Of each sale 95% goes to the seller and 5% to the protocol fee address.'})]}];

// Connect from the tutorial or the guide. Pages hosted without a wallet link say so.
function connectRow(){
 const w=walletLink(),note=el('span',{class:'dim'});
 if(!w)return el('div',{class:'row'},el('button',{type:'button',class:'btn',disabled:true,'data-action':'connect',text:'Connect wallet'}),el('span',{class:'dim',text:'This copy of the pages has no wallet link.'}));
 const b=el('button',{type:'button',class:'btn primary','data-action':'connect',text:w.status().connected?'Connected':'Connect wallet',disabled:w.status().connected});
 b.addEventListener('click',async()=>{b.disabled=true;note.textContent='';remember();try{await w.connect();b.textContent='Connected';}catch(e){note.textContent=e.message||'The wallet did not answer.';b.disabled=false;}});
 return el('div',{class:'row'},b,note);}
// The three steps on the page, side by side: number, title, then what to do.
const steps=()=>el('ol',{class:'guide'},STEPS.slice(1).map((s,i)=>el('li',{'data-step':s.key},
 el('span',{class:'guide-n','aria-hidden':'true',text:String(i+1)}),el('h3',{text:s.title}),el('div',{class:'guide-text'},s.body()))));

export async function xmr721(ctx){
 ctx.title('XMR721');const info=service.info,burn=burning(),now=live();
 add(ctx.main,
  el('div',{class:'head'},el('h1',{text:'XMR721'}),
   el('p',{class:'lede',text:now?'An NFT standard for Monero. NFTs belong to Monero addresses and move by wallet signature. A Mordinal is claimed once, by burning the old one; after that no coin is spent.'
    :'An NFT standard for Monero. NFTs belong to Monero addresses and move by wallet signature. No coin is spent, so nothing about anyone’s spending is made public.'}),
   burn&&!burn.fits?burnMisfit():burn&&!now?notice('note',burnAhead(burn)):null),
  el('section',{class:'section about-grid','data-section':'what'},
   el('div',{class:'card catalog stack'},el('h2',{text:'Why a new standard'}),
    el('ul',{class:'dots'},
     el('li',{text:'The 2023 Mordinals rules moved an inscription by spending its coin in the open. Every such transfer made other people’s transactions a little easier to trace.'}),
     el('li',{text:'The sites that showed and traded Mordinals went away. For almost three years nothing could be done with them.'}),
     el('li',{text:`All ${count(info.count)} are still on the chain. XMR721 lets their holders use them again without that privacy cost.`}))),
   el('div',{class:'card catalog stack'},el('h2',{text:'How XMR721 works'}),
    el('ul',{class:'dots'},
     el('li',{text:'Ownership is a signed record in an ordinary Monero transaction. Anyone can rebuild the whole ledger from the chain.'}),
     now?el('li',{text:'Claiming burns the old Mordinal: a transfer under the 2023 rules to an address nobody can spend from, with the receiving address written in it. The transfer is public, like every 2023 transfer.'})
      :el('li',{text:'Claiming proves you hold the inscribed coin with a signature. The coin is not spent and stays an ordinary coin.'}),
     el('li',{text:'Sending and selling are messages signed with “Sign message” in a Monero wallet.'}),
     el('li',{text:'A sale is paid in XMR from buyer to seller. No one holds the money or the NFT in between.'})))),
  el('section',{class:'section card catalog','data-section':'steps'},
   el('div',{class:'cat-head'},el('div',{},el('h2',{text:'Turn your Mordinals into XMR721 NFTs'}),el('p',{class:'card-sub',text:now?'Three steps in your wallet. The claim is one Monero transaction; after it nothing is spent.':'Three steps in your wallet. Nothing is spent and no XMR moves.'}))),
   steps(),
   el('div',{class:'guide-foot'},el('a',{class:'btn primary',href:'#/market',text:'Go to the market'}),el('a',{class:'btn',href:'#/gallery',text:'See all Mordinals'}))),
  el('section',{class:'section about-grid','data-section':'more'},
   now?el('div',{class:'card catalog stack','data-burn':'how'},el('h2',{text:'Claiming burns the old Mordinal'}),
    el('p',{class:'muted',text:'The claim is a transfer of the Mordinal under the 2023 rules to the burn address, with a text that names the address that will own it. Only the wallet that holds the inscribed coin can make it.'}),
    burnHow(now))
   :el('div',{class:'card catalog stack'},el('h2',{text:'Feather and Cake Wallet'}),
    el('p',{class:'muted',text:'These wallets can sign messages, so sending and selling work as they are. Claiming needs proof that your address holds the inscribed coin:'}),
    el('ul',{class:'dots'},
     el('li',{text:'Feather: make a view-only copy of the wallet, create the payment proof for the inscription there, then sign the claim in your full wallet.'}),
     el('li',{text:'Cake Wallet: a small tool on your own computer makes the proof from the wallet’s view key; you sign the claim in Cake.'})),
    notice('note','The tool for these two wallets is not finished. The claim shows your address and the amount of the inscribed coin; the XMR20 wallet claim shows neither.')),
   el('div',{class:'card catalog stack'},el('h2',{text:'Collections'}),
    el('p',{class:'muted',text:'Mordinals are the first XMR721 collection. GENESIS, the 100 paintings inscribed in 2026, is shown in the market; it was made in an earlier format and cannot be traded here yet.'}),
    el('div',{class:'row'},el('a',{class:'btn',href:'#/market',text:'Mordinals'}),el('a',{class:'btn',href:'#/market?show=genesis',text:'GENESIS'})))));}

// The tutorial as a dialog: four short screens, Back / Next, and a way out on every screen.
export function tutorial(ctx,{force=false}={}){
 if(!force&&seen())return null;
 const box=el('dialog',{class:'tour','aria-label':'How XMR721 works','data-tutorial':''}),body=el('div',{class:'tour-body stack'}),dots=el('div',{class:'tour-dots'}),foot=el('div',{class:'tour-foot'});
 let at=0;
 const close=()=>{remember();if(box.open)box.close();box.remove();};
 const draw=()=>{const s=STEPS[at],last=at===STEPS.length-1;
  body.replaceChildren(el('p',{class:'label',text:`Step ${at+1} of ${STEPS.length}`}),el('h2',{text:s.title}),...s.body());
  dots.replaceChildren(...STEPS.map((_,i)=>el('span',{class:i===at?'on':''})));
  foot.replaceChildren(...[
   el('button',{type:'button',class:'btn','data-action':'skip',text:last?'Close':'Skip to the market',onclick:close}),
   el('span',{class:'tour-gap'}),
   at?el('button',{type:'button',class:'btn','data-action':'back',text:'Back',onclick:()=>{at--;draw();}}):null,
   last?el('a',{class:'btn primary',href:'#/xmr721','data-action':'more',text:'Full guide',onclick:close})
       :el('button',{type:'button',class:'btn primary','data-action':'next',text:'Next',onclick:()=>{at++;draw();}})].filter(Boolean));};
 box.addEventListener('cancel',remember);box.addEventListener('click',e=>{if(e.target===box)close();});
 add(box,body,dots,foot);draw();document.body.append(box);
 if(box.showModal)box.showModal();else box.setAttribute('open','');
 ctx.onLeave(()=>{if(box.isConnected){if(box.open)box.close();box.remove();}});
 return box;}
