// The launch inscriber: inscribes one XMR20 deploy (../FORMAT.md) on an XMR721 ledger for every new launch its sources
// list, through a relay. It holds one key, the inscriber's, which signs mint records and nothing else; it holds no coin
// and pays nothing (the relay carries its records). What it has made is kept in a journal file, so a stop at any point
// is picked up where it was, and a launch is never inscribed twice: the record of a launch has one id, and the index
// lists one token per Solana mint.
import {existsSync,mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {deployRecord} from '../lib/inscribe.mjs';
import {deployText} from '../lib/token.mjs';

export const DEFAULT_LIMITS={inFlight:3,perTurn:10,resendAfter:20,settle:10};

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

export function createInscriber({dir,sources,index,inscriber,domain,network='mainnet',since,limits={},log=()=>{}}){
 if(!Number.isSafeInteger(since)||since<=0)throw Error('The inscriber needs the time from which launches are inscribed.');
 if(!/^[0-9a-f]{64}$/.test(domain||''))throw Error('The inscriber needs the ledger domain.');
 const lim={...DEFAULT_LIMITS,...limits},file=join(dir,'journal.json');mkdirSync(dir,{recursive:true});
 const journal=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{version:1,inscriber:inscriber.address,domain,launches:{}};
 if(journal.version!==1||journal.inscriber!==inscriber.address||journal.domain!==domain)throw Error('This journal was made for another inscriber or ledger.');
 const save=()=>{writeFileSync(file+'.new',JSON.stringify(journal,null,1)+'\n',{mode:0o600});renameSync(file+'.new',file);};
 const entries=()=>Object.values(journal.launches).sort((a,b)=>a.at-b.at||(a.mint<b.mint?-1:1));
 const counts=()=>entries().reduce((n,e)=>{n[e.state]=(n[e.state]||0)+1;return n;},{});
 const settled=(e,t,height)=>{Object.assign(e,{state:'done',number:t.number,inscription:t.inscription,height:t.height,txid:t.txid});if(t.id!==e.id)e.other=t.id;delete e.note;};

 // One pass. Returns what it did, in words a log can keep: {height, waiting?, found, sent, done, counts}.
 async function turn(){
  const info=await index.info(),height=info.height;
  if(info.network!==network||info.domain!==domain)throw Error('The index is for another ledger.');
  const waiting=!info.xmr20?.inscribers?.includes(inscriber.address)?'the index does not list the tokens of this inscriber':info.mintFrom==null||height<info.mintFrom?'minting is not open on this ledger':!info.relay?'the index has no relay':null;
  if(waiting)return {height,waiting,found:0,sent:0,done:0,counts:counts()};
  const out={height,found:0,sent:0,done:0};

  // 1. What was sent: on the ledger now? A token that is done is looked at again while its block could still be replaced.
  for(const e of entries()){
   if(e.state==='done'&&height-e.height<lim.settle){const t=await index.token(e.mint);
    if(!t||t.id!==(e.other||e.id)){Object.assign(e,{state:'sent',sentAt:height,note:'its block was replaced'});delete e.other;log({replaced:e.mint,id:e.id});}}
   if(e.state!=='sent')continue;
   const t=await index.token(e.mint);if(t){settled(e,t,height);out.done++;log({inscribed:e.mint,tick:e.fields.tick,number:t.number,inscription:t.inscription,txid:t.txid});continue;}
   const job=await index.status(e.id);
   if(job?.state==='refused'){Object.assign(e,{state:'refused',note:String(job.error||'refused').slice(0,200)});log({refused:e.mint,id:e.id,why:e.note});continue;}
   // The relay no longer knows the record, or has held it for long: hand it over again (the same record, the same id).
   if(job?.state==='stuck'){if(!e.note)log({stuck:e.mint,id:e.id});e.note='the relay could not get this record into a block; it needs a person';continue;}
   if(!job||job.state==='unknown'||height-e.sentAt>=lim.resendAfter){const again=await index.submit(e.record);e.sentAt=height;e.tries=(e.tries||1)+1;if(again.state==='refused')e.note=String(again.error||'').slice(0,200);else delete e.note;}}
  save();

  // 2. New launches: every one a source lists from `since` on gets its record, made once and kept.
  for(const source of sources){
   let listed;try{listed=await source.list();}catch(e){log({source:source.name,error:String(e.message).slice(0,160)});continue;}
   for(const s of listed.skipped)if(s.mint&&!journal.skipped?.[s.mint]){(journal.skipped??={})[s.mint]={source:source.name,why:s.why};log({skipped:s.mint,source:source.name,why:s.why});}
   for(const l of listed.launches){
    if(l.at<since||journal.launches[l.mint])continue;
    const made=deployRecord({fields:l.fields,inscriber,domain,network});
    journal.launches[l.mint]={mint:l.mint,source:source.name,at:l.at,fields:l.fields,id:made.id,record:made.record,state:'made'};out.found++;
    log({launch:l.mint,tick:l.fields.tick,mode:l.fields.mode,id:made.id});}}
  save();

  // 3. Hand the made records to the relay, oldest launch first, a few at a time.
  let flying=entries().filter(e=>e.state==='sent').length,handed=0;
  for(const e of entries()){
   if(e.state!=='made'||flying>=lim.inFlight||handed>=lim.perTurn)continue;
   // Already a token (inscribed before this journal existed, or by another run): nothing to send.
   const t=await index.token(e.mint);if(t){settled(e,t,height);out.done++;continue;}
   const answer=await index.submit(e.record);handed++;
   if(answer.pay){e.note='the relay asks a fee for this record; it must carry this inscriber\'s records without one';log({unpaid:e.mint,id:e.id});continue;}
   if(answer.state==='refused'){e.note=String(answer.error||'refused').slice(0,200);e.tries=(e.tries||0)+1;log({notTaken:e.mint,id:e.id,why:e.note});continue;}
   Object.assign(e,{state:'sent',sentAt:height,tries:(e.tries||0)+1});delete e.note;flying++;out.sent++;}
  save();
  return {...out,counts:counts()};}

 return {turn,journal,entries,counts,address:inscriber.address,
  // What would be inscribed for the launches listed now, without a journal entry or a record sent.
  async preview(){const out=[];for(const source of sources){const listed=await source.list();
   for(const l of listed.launches)if(l.at>=since&&!journal.launches[l.mint])out.push({source:source.name,mint:l.mint,at:l.at,text:deployText(l.fields)});}return out;}};}
