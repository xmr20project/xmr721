// The page shell: reads /info once, then shows the view that the address after "#" names.
import {el,api,service,count,notice} from './ui.js';
import {explorer,search,address,record} from './explorer.js';
import {gallery} from './gallery.js';
import {mordinal} from './mordinal.js';
import {market,lot,buy} from './market.js';
import {about} from './about.js';
import {xmr721} from './xmr721.js';
import {nft} from './collection.js';
import {collections,groupCollection} from './collections.js';
import {minted,madeCollection,nft as mintedNft,create} from './nft.js';

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
 [/^\/nfts$/,minted,'nfts'],
 [/^\/nft\/([0-9a-f]{64})(?:\/(send|sell|stop|burn))?$/,mintedNft,'nfts'],
 [/^\/set\/([0-9a-f]{64})$/,madeCollection,'nfts'],
 [/^\/create$/,create,'create'],
 [/^\/collections$/,collections,'collections'],
 [/^\/collection\/([0-9a-f]{24})$/,groupCollection,'collections'],
 [/^\/xmr721$/,xmr721,'xmr721'],
 [/^\/about$/,about,'about']];

// A hosting page can place the views in an element of its own (data-xmr721-main), next to its other content.
const main=document.querySelector('[data-xmr721-main]')||document.getElementById('main'),tip=document.getElementById('tip'),embedded=main.hasAttribute('data-xmr721-main');
// In a hosting page only addresses of these views ("#/...") are ours; the page keeps its other anchors.
const ours=()=>!embedded||/^#\//.test(location.hash);
let current=null;

function showTip(height){
 const info=service.info;if(!info||height==null||!tip)return;
 tip.replaceChildren('Block ',el('b',{text:count(height)}),info.network==='mainnet'?'':' · '+info.network,info.test?' · test data':'');}
async function loadInfo(signal){service.info=await api('/info',{signal});showTip(service.info.height);}

function parse(){
 const hash=location.hash.replace(/^#/,'')||'/',cut=hash.indexOf('?');
 return {path:cut<0?hash:hash.slice(0,cut),query:new URLSearchParams(cut<0?'':hash.slice(cut+1))};}

async function show({keep=false}={}){
 if(current){current.abort.abort();for(const leave of current.leaving.splice(0)){try{leave();}catch{}}}
 const {path,query}=parse();let found=null;
 for(const [pattern,view,tab] of ROUTES){const m=pattern.exec(path);if(m){found={view,tab,args:m.slice(1)};break;}}
 for(const a of document.querySelectorAll('.tabs a[data-tab]')){if(found&&a.dataset.tab===found.tab)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');}
 const box=el('div',{class:'view','data-at':location.hash.replace(/^#/,'')||'/'}),abort=new AbortController();
 const ctx={main:box,query,signal:abort.signal,abort,leaving:[],
  onLeave(work){this.leaving.push(work);},
  title(text){if(!embedded)document.title=text?text+' · XMR721':'XMR721';},
  tip:showTip,
  // Shows the same view again with fresh data, staying where the person is on the page.
  reload:()=>show({keep:true})};
 current=ctx;
 if(!keep){main.replaceChildren(el('p',{class:'loading',text:'Loading…'}));if(!embedded)window.scrollTo(0,0);else if(main.getBoundingClientRect().top<0)(main.closest('[data-xmr721-top]')||main).scrollIntoView();}
 try{
  if(!service.info)await loadInfo(abort.signal);
  // Tabs for making NFTs are shown only on a ledger that takes mints.
  for(const a of document.querySelectorAll('.tabs a[data-tab=nfts],.tabs a[data-tab=create]'))a.hidden=service.info.mintFrom==null;
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
const home=document.documentElement.dataset.home;if(!embedded&&home&&!location.hash.replace(/^#\/?$/,''))history.replaceState(null,'','#'+home);
addEventListener('hashchange',()=>{if(ours())show();});
// The newest block for the header, checked now and then while the page is in front.
setInterval(()=>{if(!document.hidden&&service.info)api('/info').then(i=>{service.info=i;showTip(i.height);}).catch(()=>{});},20000);
if(ours())show();
