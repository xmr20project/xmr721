// Where the inscriber learns of launches. Each source reads one public list and answers in one shape:
//   {launches: [{mint, at, fields}], skipped: [{mint, why, at}]}
// `at` is when the launch was made (milliseconds), `fields` are the deploy's fields (../FORMAT.md) without `p` and `op`.
// A source names no creator and no wallet: a deploy says what the token is, not whose it is.
// A launch a source cannot describe fully and for certain is left out with the reason, never guessed: what is
// inscribed stays on the chain.
import {checkDeploy,readable} from '../lib/token.mjs';

const MOST=20000,AHEAD=600000;

// Whole tokens from a raw supply and its decimals, when it divides evenly.
function whole(raw,decimals){
 if(typeof raw!=='string'||!/^[1-9][0-9]{0,39}$/.test(raw))return null;
 const unit=10n**BigInt(decimals),n=BigInt(raw);return n%unit===0n?(n/unit).toString():null;}

function collect(items,make,now){
 if(items.length>MOST)throw Error('The list is longer than a launch list can be.');
 const launches=[],skipped=[],seen=new Set();
 for(const item of items){
  const mint=typeof item?.mint==='string'&&item.mint.length<=64?item.mint:null;
  let at=null;
  try{const made=make(item);if(!made)continue;
   at=Number.isSafeInteger(made.at)&&made.at>0?made.at:null;if(made.skip)throw Error(made.skip);
   // The name is optional. One that cannot be written (FORMAT.md: hidden characters, joined emoji) is left out and the
   // ticker stands alone; spaces at its ends are dropped.
   const f={...made.fields},name=typeof f.name==='string'?f.name.trim():'';if(name&&readable(name,64))f.name=name;else delete f.name;
   const d=checkDeploy({p:'xmr20',op:'deploy',...f});if(!d.mint)throw Error('no mint');
   if(at===null)throw Error('no launch time');
   if(at>now()+AHEAD)throw Error('a launch time in the future');
   if(seen.has(d.mint))throw Error('listed twice');seen.add(d.mint);
   const {p,op,...fields}=d;launches.push({mint:d.mint,at,fields});}
  catch(e){skipped.push({mint,why:String(e.message).slice(0,120),at});}}
 return {launches:launches.sort((a,b)=>a.at-b.at||(a.mint<b.mint?-1:1)),skipped};}

// Launches on the Monero curve: the trading service's public lists. A launch is listed there once its market exists.
// Its supply is the launch's own: what the list shows now plus what was burned when its pool opened (the service's
// present parameters are not used: they may have changed since the launch). Tokens have 6 decimals; open and private
// launches read the same.
export function tradeSource({base,get,decimals=6,now=Date.now}){
 return {name:'monero-curve',async list(){
  const [answer,markets]=await Promise.all([get(base+'/api/launches'),get(base+'/api/markets')]),list=answer?.launches;
  if(!Array.isArray(list)||!Array.isArray(markets))throw Error('The trading service did not give its launches.');
  const burned=new Map(markets.filter(m=>typeof m?.mint==='string'&&m.graduated?.burnedTokens!==undefined).map(m=>[m.mint,m.graduated.burnedTokens]));
  const launched=x=>{const b=burned.get(x.mint)??'0';if(typeof x.supply!=='string'||!/^\d{1,40}$/.test(x.supply)||typeof b!=='string'||!/^\d{1,40}$/.test(b))return null;return (BigInt(x.supply)+BigInt(b)).toString();};
  return collect(list,x=>{const max=whole(launched(x),decimals);if(!max)return {at:x.launchedAt,skip:'no whole supply'};
   return {at:x.launchedAt,fields:{tick:x.symbol,name:x.name,max,dec:String(decimals),mode:'monero-curve',mint:x.mint}};},now);}};}

// Launches on the Solana bonding curve: the launch service's public list. A launch counts once Solana has finalized it,
// and only while the list itself shows it (not hidden, halted, cancelled or kept out of the index). The pair is read
// from the launch's venue, and a venue this source does not know is left out. These tokens have 6 decimals.
export function bridgeSource({url,get,decimals=6,solanaNetwork='mainnet-beta',moneroNetwork='mainnet',now=Date.now}){
 const pairOf=x=>x.venue==='meteora-damm-v2'?'XMR20':(x.venue==='raydium-launchlab'&&x.flow==='wxmr-sponsored-curve-v1')||(x.venue==null&&x.launchPlatform===2)?'wXMR':null;
 return {name:'bonding-curve',async list(){
  const answer=await get(url);if(answer?.schema!=='xmr20-launches-v1'||!Array.isArray(answer.tokens))throw Error('The launch service did not give its launches.');
  if(answer.solanaNetwork!==solanaNetwork||answer.moneroNetwork!==moneroNetwork)throw Error('The launch service is on another network.');
  return collect(answer.tokens,x=>{
   if(x.solanaFinalized!==true||x.hidden===true||x.halted===true||x.publicIndexExcluded===true||x.cancelledAt||x.network!==solanaNetwork||(x.moneroNetwork!==undefined&&x.moneroNetwork!==moneroNetwork))return null;
   const pair=pairOf(x);if(!pair)return {at:x.createdAt,skip:'a launch venue this source does not know'};
   const max=whole(x.supply,decimals);if(!max)return {at:x.createdAt,skip:'no whole supply'};
   return {at:x.createdAt,fields:{tick:x.ticker,name:x.name,max,dec:String(decimals),mode:'bonding-curve',pair,mint:x.mint}};},now);}};}

// A JSON GET with a time limit, for the sources and the index.
export const httpGet=(timeout=20000)=>async url=>{
 const r=await fetch(url,{headers:{accept:'application/json'},cache:'no-store',signal:AbortSignal.timeout(timeout)});
 if(!r.ok)throw Object.assign(Error(`${new URL(url).host} answered ${r.status}`),{status:r.status});
 return r.json();};
