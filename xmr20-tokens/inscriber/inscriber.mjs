// The launch inscriber: inscribes one XMR20 deploy (../FORMAT.md) on an XMR721 ledger for every new launch its sources
// list, through a relay. It holds one key, the inscriber's, which signs mint records and nothing else; it holds no coin
// and pays nothing (the relay carries its records). What it has made is kept in a journal file, so a stop at any point
// is picked up where it was, and a launch is never inscribed twice: the record of a launch has one id, and the index
// lists one token per Solana mint.
//
// What is inscribed stays on the chain, so the inscriber holds back rather than guess: it inscribes launches made
// from a set time on, a bounded number a day, and stops taking launches from a list that suddenly shows many new ones.
import {existsSync,mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {deployRecord} from '../lib/inscribe.mjs';
import {deployText} from '../lib/token.mjs';

// inFlight     records waiting for a block at once (the relay takes three of one address)
// perTurn      records handed to the relay in one pass
// resendAfter  blocks after which a record the relay still holds is handed over again
// settle       blocks after which a block is taken as final
// burst        a list showing more new launches than this in one pass is not taken from until a person has looked
// perDay       records made in 24 hours
// quiet        blocks a new journal waits before its first record, so records of an earlier run reach their blocks first
// skipped      how many left-out launches the journal remembers
export const DEFAULT_LIMITS={inFlight:3,perTurn:10,resendAfter:20,settle:10,burst:20,perDay:50,quiet:2,skipped:200};
// Times are milliseconds; a time before this one was given in seconds by mistake.
export const EARLIEST=1e12;

// The index and relay of one reader service (reader/service.mjs), over HTTP.
export function httpIndex(base,{timeout=20000}={}){
 const call=async(path,init)=>{const r=await fetch(base+path,{...init,cache:'no-store',signal:AbortSignal.timeout(timeout)});let body=null;try{body=await r.json();}catch{}
  return {status:r.status,body};};
 const need=(r,what)=>{if(r.status!==200||!r.body)throw Error(`The index did not answer (${what}: ${r.status}${r.body?.error?' '+String(r.body.error).slice(0,120):''}).`);return r.body;};
 return {
  info:async()=>need(await call('/info'),'info'),
  token:async key=>{const r=await call('/xmr20/token/'+encodeURIComponent(key));if(r.status===404)return null;return need(r,'token').token;},
  // The relay's answer for a record: {id, state, error, pay?}. A refusal comes back as {state:'refused', error}.
  submit:async record=>{const r=await call('/records',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({record})});
   if(r.status===200&&r.body)return r.body;return {state:'refused',error:String(r.body?.error||'The relay answered '+r.status).slice(0,200),status:r.status};},
  status:async id=>{const r=await call('/status/'+id);if(r.status===404)return null;return need(r,'status');}};}

export function createInscriber({dir,sources,index,inscriber,domain,network='mainnet',since,limits={},log=()=>{},now=Date.now}){
 if(!Number.isSafeInteger(since)||since<EARLIEST)throw Error('The inscriber needs the time from which launches are inscribed, in milliseconds.');
 if(!/^[0-9a-f]{64}$/.test(domain||''))throw Error('The inscriber needs the ledger domain.');
 const lim={...DEFAULT_LIMITS,...limits},file=join(dir,'journal.json');mkdirSync(dir,{recursive:true});
 const journal=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{version:1,inscriber:inscriber.address,domain,launches:{}};
 if(journal.version!==1||journal.inscriber!==inscriber.address||journal.domain!==domain)throw Error('This journal was made for another inscriber or ledger.');
 const save=()=>{writeFileSync(file+'.new',JSON.stringify(journal,null,1)+'\n',{mode:0o600});renameSync(file+'.new',file);};
 const entries=()=>Object.values(journal.launches).sort((a,b)=>a.at-b.at||(a.mint<b.mint?-1:1));
 const counts=()=>entries().reduce((n,e)=>{n[e.state]=(n[e.state]||0)+1;return n;},{});
 const settled=(e,t)=>{Object.assign(e,{state:'done',number:t.number,inscription:t.inscription,height:t.height,txid:t.txid});if(t.id!==e.id)e.other=t.id;else delete e.other;delete e.note;delete e.onLedger;};
 const said=new Set(),once=(key,line)=>{if(!said.has(key)){said.add(key);log(line);}};
 // A left-out launch is remembered (so it is logged once), up to a bound; the oldest notes go first.
 const skip=(mint,source,why)=>{const s=journal.skipped??={};if(s[mint])return;s[mint]={source,why};log({skipped:mint,source,why});
  const keys=Object.keys(s);for(const k of keys.slice(0,Math.max(0,keys.length-lim.skipped)))delete s[k];};

 // One pass. Returns what it did, in words a log can keep: {height, waiting?, found, sent, done, held?, counts}.
 async function turn(){
  const info=await index.info(),height=info.height;
  if(info.network!==network||info.domain!==domain)throw Error('The index is for another ledger.');
  const waiting=!info.xmr20?.inscribers?.includes(inscriber.address)?'the index does not list the tokens of this inscriber':info.mintFrom==null||height<info.mintFrom?'minting is not open on this ledger':!info.relay?'the index has no relay':null;
  if(waiting)return {height,waiting,found:0,sent:0,done:0,counts:counts()};
  const out={height,found:0,sent:0,done:0};

  // 1. What was sent: on the ledger now? A token that is done is looked at again while its block could still be
  //    replaced (its numbers can change with its block until then).
  for(const e of entries()){
   if(e.state==='done'&&height-e.height<lim.settle){const t=await index.token(e.mint);
    if(t&&t.id===(e.other||e.id))settled(e,t);else{Object.assign(e,{state:'sent',sentAt:height,note:'its block was replaced'});delete e.other;log({replaced:e.mint,id:e.id});}}
   if(e.state!=='sent')continue;
   const t=await index.token(e.mint);if(t){settled(e,t);out.done++;log({inscribed:e.mint,tick:e.fields.tick,number:t.number,inscription:t.inscription,txid:t.txid});continue;}
   const job=await index.status(e.id);
   if(job?.state==='refused'){Object.assign(e,{state:'refused',note:String(job.error||'refused').slice(0,200)});log({refused:e.mint,id:e.id,why:e.note});continue;}
   if(job?.state==='stuck'){Object.assign(e,{state:'stuck',note:'the relay could not get this record into a block; it needs a person'});log({stuck:e.mint,id:e.id});continue;}
   // On the ledger and not a token: the inscription was burned (FORMAT.md). Once that is final the entry is closed; a
   // record with this id cannot be inscribed again, so a token inscribed anew has to differ in a field.
   if(job?.state==='done'){e.onLedger??=height;
    if(height-e.onLedger>=lim.settle){Object.assign(e,{state:'off',note:'its inscription is on the ledger and is not listed as a token (burned)'});delete e.onLedger;log({off:e.mint,id:e.id});}continue;}
   delete e.onLedger;
   // The relay no longer knows the record, or has held it for long: hand it over again (the same record, the same id).
   if(!job||job.state==='unknown'||height-e.sentAt>=lim.resendAfter){const again=await index.submit(e.record);e.sentAt=height;e.tries=(e.tries||1)+1;if(again.state==='refused')e.note=String(again.error||'').slice(0,200);else delete e.note;}}
  save();

  // 2. New launches: every one a source lists from `since` on gets its record, made once and kept.
  journal.born??=height;
  if(height<journal.born+lim.quiet){save();return {...out,quiet:journal.born+lim.quiet,counts:counts()};}
  const day=now()-86400000,madeToday=()=>entries().filter(e=>(e.madeAt||0)>day).length;
  for(const source of sources){
   let listed;try{listed=await source.list();}catch(e){log({source:source.name,error:String(e.message).slice(0,160)});continue;}
   for(const s of listed.skipped)if(s.mint&&(s.at==null||s.at>=since))skip(s.mint,source.name,s.why);
   const fresh=listed.launches.filter(l=>l.at>=since&&!journal.launches[l.mint]);
   // Many new launches at once is not how launches arrive: a list that was tampered with, or a first run with a
   // wrong time. Nothing is taken from this list until a person has looked (raise the limit to let them through).
   if(fresh.length>lim.burst){out.held=(out.held||0)+fresh.length;once('burst:'+source.name+':'+fresh.length,{held:source.name,launches:fresh.length,why:`more than ${lim.burst} new launches at once`});continue;}
   for(const l of fresh){
    if(madeToday()>=lim.perDay){out.held=(out.held||0)+1;once('day:'+Math.floor(now()/3600000),{held:source.name,why:`${lim.perDay} records were made in the last 24 hours`});break;}
    const made=deployRecord({fields:l.fields,inscriber,domain,network});
    journal.launches[l.mint]={mint:l.mint,source:source.name,at:l.at,fields:l.fields,id:made.id,record:made.record,state:'made',madeAt:now()};out.found++;
    log({launch:l.mint,tick:l.fields.tick,mode:l.fields.mode,id:made.id});}}
  save();

  // 3. Hand the made records to the relay, oldest launch first, a few at a time.
  let flying=entries().filter(e=>e.state==='sent').length,handed=0;
  for(const e of entries()){
   if(e.state!=='made'||flying>=lim.inFlight||handed>=lim.perTurn)continue;
   // Already a token (inscribed before this journal existed, or by another run): nothing to send.
   const t=await index.token(e.mint);if(t){settled(e,t);out.done++;continue;}
   const answer=await index.submit(e.record);handed++;
   if(answer.pay){e.note='the relay asks a fee for this record; it must carry this inscriber\'s records without one';once('unpaid:'+e.id,{unpaid:e.mint,id:e.id});continue;}
   if(answer.state==='refused'){e.note=String(answer.error||'refused').slice(0,200);e.tries=(e.tries||0)+1;once('refused:'+e.id+':'+e.note,{notTaken:e.mint,id:e.id,why:e.note});
    // The rules' own refusal (not "busy", not "too many") will not change: after three tries the entry is closed, so it
    // does not stand in the way of the launches after it.
    if(answer.status===400&&e.tries>=3){e.state='refused';log({refused:e.mint,id:e.id,why:e.note});}continue;}
   Object.assign(e,{state:'sent',sentAt:height,tries:(e.tries||0)+1});delete e.note;flying++;out.sent++;}
  save();
  return {...out,counts:counts()};}

 return {turn,journal,entries,counts,address:inscriber.address,
  // What would be inscribed for the launches listed now, without a journal entry or a record sent.
  async preview(){const out=[];for(const source of sources){const listed=await source.list();
   for(const l of listed.launches)if(l.at>=since&&!journal.launches[l.mint])out.push({source:source.name,mint:l.mint,at:l.at,text:deployText(l.fields)});
   for(const s of listed.skipped)if(s.at==null||s.at>=since)out.push({source:source.name,mint:s.mint,at:s.at,skipped:s.why});}return out;}};}
