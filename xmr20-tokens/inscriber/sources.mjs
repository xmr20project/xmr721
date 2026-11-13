// Where the inscriber learns of launches. Each source reads one public list and answers in one shape:
//   {launches: [{mint, at, fields}], skipped: [{mint, why}]}
// `at` is when the launch was made (milliseconds), `fields` are the deploy's fields (../FORMAT.md) without `p` and `op`.
// A source names no creator and no wallet: a deploy says what the token is, not whose it is.
import {checkDeploy} from '../lib/token.mjs';

// Whole tokens from a raw supply and its decimals, when it divides evenly.
function whole(raw,decimals){
 if(typeof raw!=='string'||!/^[1-9][0-9]{0,39}$/.test(raw))return null;
 const unit=10n**BigInt(decimals),n=BigInt(raw);return n%unit===0n?(n/unit).toString():null;}

function collect(items,make){
 const launches=[],skipped=[],seen=new Set();
 for(const item of items){
  const mint=typeof item?.mint==='string'?item.mint:null;
  try{const made=make(item);if(!made)continue;
   const d=checkDeploy({p:'xmr20',op:'deploy',...made.fields});if(!d.mint)throw Error('no mint');
   if(!Number.isSafeInteger(made.at)||made.at<=0)throw Error('no launch time');
   if(seen.has(d.mint))throw Error('listed twice');seen.add(d.mint);
   const {p,op,...fields}=d;launches.push({mint:d.mint,at:made.at,fields});}
  catch(e){skipped.push({mint,why:String(e.message).slice(0,120)});}}
 return {launches:launches.sort((a,b)=>a.at-b.at||(a.mint<b.mint?-1:1)),skipped};}

// Launches on the Monero curve: the trading service's public list. A launch is listed there once its market exists.
// Every launch has the supply the service's parameters give, with 6 decimals; open and private launches read the same.
export function tradeSource({base,get,decimals=6}){
 return {name:'monero-curve',async list(){
  const info=await get(base+'/api/info'),max=whole(info?.params?.curve?.supply,decimals);
  if(!max)throw Error('The trading service did not give a whole supply.');
  const list=(await get(base+'/api/launches'))?.launches;if(!Array.isArray(list))throw Error('The trading service did not give its launches.');
  return collect(list,x=>({at:x.launchedAt,fields:{tick:x.symbol,name:x.name,max,dec:String(decimals),mode:'monero-curve',mint:x.mint}}));}};}

// Launches on the Solana bonding curve: the launch service's public list. A launch counts once Solana has finalized
// it. The pair is wXMR, or XMR20 for a launch on the XMR20 pair. These tokens have 6 decimals.
export function bridgeSource({url,get,decimals=6,solanaNetwork='mainnet-beta'}){
 return {name:'bonding-curve',async list(){
  const answer=await get(url);if(answer?.schema!=='xmr20-launches-v1'||!Array.isArray(answer.tokens))throw Error('The launch service did not give its launches.');
  if(answer.solanaNetwork!==solanaNetwork)throw Error('The launch service is on another network.');
  return collect(answer.tokens,x=>{
   if(x.solanaFinalized!==true||x.hidden===true||x.network!==solanaNetwork||x.cancelledAt)return null;
   const max=whole(x.supply,decimals);if(!max)throw Error('no whole supply');
   return {at:x.createdAt,fields:{tick:x.ticker,name:x.name,max,dec:String(decimals),mode:'bonding-curve',pair:x.venue==='meteora-damm-v2'?'XMR20':'wXMR',mint:x.mint}};});}};}

// A JSON GET with a time limit, for the sources and the index.
export const httpGet=(timeout=20000)=>async url=>{
 const r=await fetch(url,{headers:{accept:'application/json'},cache:'no-store',signal:AbortSignal.timeout(timeout)});
 if(!r.ok)throw Object.assign(Error(`${new URL(url).host} answered ${r.status}`),{status:r.status});
 return r.json();};
