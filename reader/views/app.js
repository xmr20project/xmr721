// The page shell: reads /info once, then shows the view that the address after "#" names.
import {el,api,service,count,notice} from './ui.js';
import {explorer,search,address,record} from './explorer.js';
import {gallery} from './gallery.js';
import {mordinal} from './mordinal.js';
import {market,lot,buy} from './market.js';
import {about} from './about.js';
import {xmr721} from './xmr721.js';
import {nft} from './collection.js';

const ADDRESS='([1-9A-HJ-NP-Za-km-z]{95})',ID='([0-9a-f]{64})';
const ROUTES=[
 [/^\/?$/,explorer,'explorer'],
 [/^\/search$/,search,'explorer'],
 [new RegExp(`^/address/${ADDRESS}$`),address,'explorer'],
 [new RegExp(`^/record/${ID}$`),record,'explorer'],
 [/^\/gallery$/,gallery,'gallery'],
 [/^\/mordinal\/(\d{1,9})(?:\/(send|sell|stop))?$/,mordinal,'gallery'],
 [/^\/market$/,market,'market'],
 [new RegExp(`^/lot/${ID}$`),lot,'market'],
 [new RegExp(`^/buy/${ID}/${ADDRESS}$`),buy,'market'],
 [/^\/nft\/([a-z0-9-]{1,40})\/(\d{1,5})$/,nft,'market'],
 [/^\/xmr721$/,xmr721,'xmr721'],
 [/^\/about$/,about,'about']];

const main=document.getElementById('main'),tip=document.getElementById('tip');
let current=null;

function showTip(height){
 const info=service.info;if(!info||height==null)return;
 tip.replaceChildren('Block ',el('b',{text:count(height)}),info.network==='mainnet'?'':' · '+info.network,info.test?' · test data':'');}
async function loadInfo(signal){service.info=await api('/info',{signal});showTip(service.info.height);}

function parse(){
 const hash=location.hash.replace(/^#/,'')||'/',cut=hash.indexOf('?');
 return {path:cut<0?hash:hash.slice(0,cut),query:new URLSearchParams(cut<0?'':hash.slice(cut+1))};}

async function show({keep=false}={}){
 if(current){current.abort.abort();for(const leave of current.leaving.splice(0)){try{leave();}catch{}}}
 const {path,query}=parse();let found=null;
 for(const [pattern,view,tab] of ROUTES){const m=pattern.exec(path);if(m){found={view,tab,args:m.slice(1)};break;}}
 for(const a of document.querySelectorAll('.tabs a')){if(found&&a.dataset.tab===found.tab)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');}
 const box=el('div',{class:'view','data-at':location.hash.replace(/^#/,'')||'/'}),abort=new AbortController();
 const ctx={main:box,query,signal:abort.signal,abort,leaving:[],
  onLeave(work){this.leaving.push(work);},
  title(text){document.title=text?text+' · XMR721':'XMR721';},
  tip:showTip,
  // Shows the same view again with fresh data, staying where the person is on the page.
  reload:()=>show({keep:true})};
 current=ctx;
 if(!keep){main.replaceChildren(el('p',{class:'loading',text:'Loading…'}));window.scrollTo(0,0);}
 try{
  if(!service.info)await loadInfo(abort.signal);
  if(!found){ctx.title('Not found');box.append(el('div',{class:'head'},el('h1',{class:'small',text:'Nothing at this address'})),
   el('p',{class:'muted'},'Go to the ',el('a',{href:'#/',text:'explorer'}),'.'));}
  else await found.view(ctx,...found.args);
  if(abort.signal.aborted)return;
  main.replaceChildren(box);}
 catch(e){
  if(abort.signal.aborted||e.name==='AbortError')return;
  main.replaceChildren(notice('error',e.message||'Something went wrong.'),
   el('p',{class:'section'},el('button',{type:'button',class:'btn',text:'Try again',onclick:()=>show()})));}}

// A hosting page can name the view to open first (<html data-home="/market">).
const home=document.documentElement.dataset.home;if(home&&!location.hash.replace(/^#\/?$/,''))history.replaceState(null,'','#'+home);
addEventListener('hashchange',()=>show());
// The newest block for the header, checked now and then while the page is in front.
setInterval(()=>{if(!document.hidden&&service.info)api('/info').then(i=>{service.info=i;showTip(i.height);}).catch(()=>{});},20000);
show();
