// Checks a Mordinals reader service without trusting it.
//
//   node tools/verify.mjs --service <url> --owners <owners.jsonl> [--node <monero node url>] [--scan <empty folder>] [--published <folder>]
//
// Always: the owner list here hashes to the value the service states; every entry of the service's record log is
//   judged again with the rule library, in order, and must come out the same way (accepted with the same id, or
//   refused); every checkpoint the service shows is recomputed from that replay. On a ledger that claims by burning
//   (RULES.md section 10) the logged burning transfers are judged again the same way, and the logged fee payments are
//   read again and applied after what their transaction carries.
// --node: every logged record is looked up on the Monero node: it must sit in the stated block at the stated place
//   and its transaction must carry exactly those record bytes; the payments of every purchase are fetched again and
//   compared; the parts of a burning transfer or a fee payment are read again from the node's transaction and compared;
//   checkpoint block hashes are compared with the node.
// --scan: additionally reads every block from the start block with this code (a reader of your own in that folder)
//   and compares the two logs. Only this finds a record or a fee payment the service left out. It takes as long as a first sync.
// --published: compares with checkpoint files written by tools/export-checkpoints.mjs (for example a public copy).
import {createHash} from 'node:crypto';
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createLedger} from '../../rules/lib/ledger.mjs';
import {OP,decodeRecord,recordId} from '../../rules/lib/records.mjs';
import {hex,unhex} from '../../rules/lib/monero.mjs';
import {burnParts,burnClaimId,isMainnetDead} from '../../rules/lib/burn.mjs';
import {feeParts,feeWallet,isProjectFeeWallet} from '../../rules/lib/burn-fee.mjs';
import {ownersHash,ownerOutputsHash,readOwners} from '../lib/owners.mjs';
import {unframe} from '../lib/transport.mjs';
import {createChain} from '../lib/chain.mjs';
import {openReader,slim} from '../lib/reader.mjs';

const sha=text=>createHash('sha256').update(text).digest('hex');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

// info = GET /info, entries = every entry of GET /log, checkpoints = GET /checkpoints (+ optionally GET /checkpoint).
// -> {ok, problems:[text], accepted, refused, checkpoints, checkedOnNode}
export async function verify({info,entries,checkpoints=[],owners,chain=null,published=[]}){
 const problems=[],bad=text=>{if(problems.length<50)problems.push(text);};
 if(ownersHash(owners)!==info.owners)return {ok:false,problems:['The owner list here is not the one this service uses (hash differs).'],accepted:0,refused:0,checkpoints:0,checkedOnNode:0};
 // A ledger that claims by burning finds Mordinals by the index of their owner output: that hash has to fit as well.
 // On mainnet the dead outputs are mainnet's. A service that names other ones is believed only on the offline test
 // chain, which a node has to show.
 // The same holds for the fee wallet: on mainnet the project's, another one only on the offline test chain.
 const named=info.burn?.fee?{address:info.burn.fee.wallet,viewKey:info.burn.fee.viewKey}:null;
 let ownFee=false;if(info.burnFrom!=null){try{ownFee=!isProjectFeeWallet(feeWallet(named,info.network,{testChain:true}));}catch{ownFee=true;}}
 const own=info.burnFrom!=null&&info.network==='mainnet'&&(!(Array.isArray(info.burn?.dead)&&isMainnetDead([...info.burn.dead].sort((a,b)=>a-b)))||ownFee);
 if(own){let nettype=null;try{nettype=chain?(await chain.info()).nettype:null;}catch{}
  if(nettype!=='fakechain')return {ok:false,problems:['The service names dead outputs or a fee wallet that are not mainnet\'s. Only a ledger on the offline test chain may, and no node of that chain was given.'],accepted:0,refused:0,checkpoints:0,checkedOnNode:0};}
 // Off mainnet (stagenet, testnet) a ledger names its own dead outputs, and the service's list is the one to replay with.
 const burns=info.burnFrom!=null?{burnFrom:info.burnFrom,burnDead:own||info.network!=='mainnet'?info.burn?.dead??null:null,burnFee:own||info.network!=='mainnet'?named:null,testChain:own}:{};
 if(info.burnFrom!=null&&ownerOutputsHash(owners)!==info.burn?.ownerOutputs)return {ok:false,problems:['The owner list here has other owner output indexes than the one this service uses (hash differs).'],accepted:0,refused:0,checkpoints:0,checkedOnNode:0};
 let ledger;try{ledger=createLedger({network:info.network,domain:info.domain,feeAddress:info.feeAddress,owners,height:info.start,mintFrom:info.mintFrom??null,minters:info.minters??null,openFrom:info.openFrom??null,...burns});}
 catch(e){return {ok:false,problems:['The service states a setup the rules do not take: '+String(e?.message||e).slice(0,200)],accepted:0,refused:0,checkpoints:0,checkedOnNode:0};}
 // A checkpoint names the first mint block and the minter list of its ledger; they have to be this service's.
 const setup={mintFrom:info.mintFrom??null,minters:info.minters?[...info.minters].sort().join(','):null,openFrom:info.openFrom??null};
 for(const c of checkpoints){const minting=setup.mintFrom!==null&&c.height>=setup.mintFrom,opened=minting&&setup.openFrom!==null&&c.height>=setup.openFrom;
  if((c.mintFrom??null)!==(minting?setup.mintFrom:null)||(c.minters??null)!==(minting?setup.minters:null)||(c.openFrom??null)!==(opened?setup.openFrom:null)){bad(`The checkpoint at block ${c.height} is for a ledger with another first mint block, minter list or opening block.`);break;}
  const burning=info.burnFrom!=null&&c.height>=info.burnFrom;
  if((c.burnFrom??null)!==(burning?info.burnFrom:null)||(c.burnDead??null)!==(burning?ledger.burn.dead.join(','):null)||(c.ownerOutputs??null)!==(burning?info.burn.ownerOutputs:null)||(c.burnFee??null)!==(burning?ledger.burn.fee.wallet:null)){bad(`The checkpoint at block ${c.height} is for a ledger with another first burn block, other dead outputs, other owner outputs or another fee wallet.`);break;}}
 const marks=[...checkpoints].sort((a,b)=>a.height-b.height),accepted=[];let mark=0,last=[info.start,-1],ok=0,refused=0;
 const settle=upTo=>{for(;mark<marks.length&&marks[mark].height<=upTo;mark++){const c=marks[mark];ledger.setHeight(c.height);
  const mine={records:accepted.length,listHash:sha(accepted.map(e=>`${e.height}:${e.txid}\n`).join('')),stateHash:sha(JSON.stringify(ledger.toJSON()))};
  for(const k of Object.keys(mine))if(c[k]!==mine[k])bad(`Checkpoint at block ${c.height}: ${k} differs from the replay.`);
  for(const k of ['network','domain','owners','start'])if(c[k]!==info[k])bad(`Checkpoint at block ${c.height}: ${k} is not this ledger's.`);}};
 // The fee payments of an entry, after what it carries. A fee payment entry has to pay a fee address.
 // The outputs it names as found are found again here (the reader itself does not, when it rebuilds from its journal).
 const fees=(e,i)=>{if(e.fee===undefined&&e.feeFound===undefined)return true;
  if(info.burnFrom==null||e.height<info.burnFrom){bad(`Log entry ${i} (block ${e.height}) holds fee payments where none count.`);return false;}
  if(!same(ledger.scanBurnFees(e.fee),e.feeFound)){bad(`Log entry ${i} (block ${e.height}) names other fee outputs than the rules find in it.`);return false;}
  try{ledger.applyBurnFees(e.txid,e.fee);return true;}catch(err){bad(`Log entry ${i} (block ${e.height}) is logged as a fee payment, but the rules find none in it: ${String(err.message)}`);return false;}};
 for(const [i,e] of entries.entries()){
  if(!Number.isInteger(e.height)||!Number.isInteger(e.pos)||e.height<=info.start||e.height<last[0]||(e.height===last[0]&&e.pos<=last[1])){bad(`Log entry ${i} is out of chain order.`);break;}
  settle(e.height-1);last=[e.height,e.pos];ledger.setHeight(e.height);
  // A burning transfer: judged from the parts of the transaction the log holds.
  if(e.burn){
   if(e.record!==undefined||e.id!==burnClaimId(info.domain,String(e.txid)))bad(`Log entry ${i} (block ${e.height}) is not a well-formed burn claim entry.`);
   let error=null;try{ledger.checkBurnClaim(e.txid,e.burn);}catch(err){error=String(err.message);}
   if(e.ok){if(error){bad(`Log entry ${i} (block ${e.height}) is marked accepted, but the rules refuse it: ${error}`);break;}ledger.applyBurnClaim(e.txid,e.burn);accepted.push(e);ok++;}
   else{if(!error)bad(`Log entry ${i} (block ${e.height}) is marked refused, but the rules accept it.`);else if(error!==e.error)bad(`Log entry ${i} (block ${e.height}) is refused for another reason than stated.`);refused++;}
   if(!fees(e,i))break;continue;}
  // A fee payment and nothing else.
  if(e.record===undefined&&e.fee!==undefined){if(e.ok!==true||e.id!==undefined||e.error!==undefined){bad(`Log entry ${i} (block ${e.height}) is not a well-formed fee payment entry.`);break;}
   if(!fees(e,i))break;accepted.push(e);ok++;continue;}
  let bytes,d=null;try{bytes=unhex(e.record);d=decodeRecord(bytes,info.network);}catch{}
  if(!d){if(e.ok)bad(`Log entry ${i} (block ${e.height}) is marked accepted but does not decode.`);else refused++;if(!fees(e,i))break;continue;}
  if(e.id!==recordId(info.domain,d.bodyBytes))bad(`Log entry ${i} (block ${e.height}) has another record id than its bytes.`);
  let out=null,error=null;try{out=ledger.check(bytes,e.facts);}catch(err){error=String(err.message);}
  if(e.ok){if(error){bad(`Log entry ${i} (block ${e.height}) is marked accepted, but the rules refuse it: ${error}`);break;}ledger.apply(bytes,e.facts);accepted.push(e);ok++;}
  else{if(!error)bad(`Log entry ${i} (block ${e.height}) is marked refused, but the rules accept it.`);else if(error!==e.error)bad(`Log entry ${i} (block ${e.height}) is refused for another reason than stated.`);refused++;}
  if(!fees(e,i))break;}
 settle(Infinity);
 for(const p of published){const c=marks.find(x=>x.height===p.height);
  if(!c)bad(`The published checkpoint at block ${p.height} is not among the service's.`);else if(!same(c,p))bad(`The published checkpoint at block ${p.height} differs from the service's.`);}
 let onNode=0;
 if(chain&&!problems.length){
  const heights=new Map();
  for(const [i,e] of entries.entries()){
   if(!heights.has(e.height))heights.set(e.height,await chain.block(e.height));
   if(heights.get(e.height).txids[e.pos]!==e.txid){bad(`Log entry ${i}: transaction ${e.txid} is not at place ${e.pos} of block ${e.height}.`);continue;}
   // The fee parts of any entry are what the node's transaction gives.
   if(e.fee!==undefined){const t=(await chain.txs([e.txid])).get(e.txid);
    if(!t||t.inPool||t.height!==e.height||!same(feeParts(t.tx),e.fee)){bad(`Log entry ${i}: the fee payments of transaction ${e.txid} are not on the node as logged.`);continue;}
    if(e.record===undefined&&!e.burn){onNode++;continue;}}
   if(e.burn){const t=(await chain.txs([e.txid])).get(e.txid);
    if(!t||t.inPool||t.height!==e.height||!same(burnParts(t.tx),e.burn)){bad(`Log entry ${i}: transaction ${e.txid} is not on the node as logged.`);continue;}
    onNode++;continue;}
   const t=(await chain.txs([e.txid])).get(e.txid),record=t&&!t.inPool&&t.height===e.height?unframe(t.tx.extra):null;
   if(!record||hex(record)!==e.record){bad(`Log entry ${i}: transaction ${e.txid} does not carry this record.`);continue;}
   if(e.facts){const ids=[...new Set(e.facts.map(f=>f.txid))],got=await chain.txs(ids);
    for(const f of e.facts){const p=got.get(f.txid);if(!p||p.inPool||p.height!==f.height||!same(slim(p.tx),f.tx))bad(`Log entry ${i}: payment ${f.txid} is not on the node as logged.`);}
    // A payment the log leaves out although it was in a block by then would change the verdict.
    let d=null;try{d=decodeRecord(unhex(e.record),info.network);}catch{}
    if(d?.op===OP.buy){const named=[...new Set(d.body.payments.map(p=>p.txid))],all=await chain.txs(named);
     for(const id of named){const p=all.get(id),counts=p&&!p.inPool&&p.height<=e.height;if(counts!==e.facts.some(f=>f.txid===id))bad(`Log entry ${i}: payment ${id} is ${counts?'left out of':'wrongly in'} the logged facts.`);}}}
   onNode++;}
  for(const c of marks)if((await chain.header(c.height)).hash!==c.blockHash)bad(`Checkpoint at block ${c.height}: the node has another block there.`);
  if(info.startHash&&(await chain.header(info.start)).hash!==info.startHash)bad('The node has another block at the start block.');}
 return {ok:!problems.length,problems,accepted:ok,refused,checkpoints:marks.length,checkedOnNode:onNode};}

// A reader of your own over the same blocks; the two logs must be equal. -> list of problems
export async function scan({info,entries,owners,chain,dir,height}){
 const named=info.burn?.fee?{address:info.burn.fee.wallet,viewKey:info.burn.fee.viewKey}:null;let project=false;try{project=info.burnFrom!=null&&isProjectFeeWallet(feeWallet(named,info.network,{testChain:true}));}catch{}
 let reader;try{reader=openReader({dir,chain,network:info.network,domain:info.domain,feeAddress:info.feeAddress,owners,start:info.start,startHash:info.startHash,mintFrom:info.mintFrom??null,minters:info.minters??null,openFrom:info.openFrom??null,...(info.burnFrom!=null?{burnFrom:info.burnFrom,burnDead:info.network==='mainnet'&&Array.isArray(info.burn?.dead)&&isMainnetDead([...info.burn.dead].sort((a,b)=>a-b))?null:info.burn?.dead??null,burnFee:project?null:named}:{}),checkpointEvery:0});}catch(e){return ['The service states a setup the rules do not take: '+String(e?.message||e).slice(0,200)];}
 while(reader.height<height){const before=reader.height;await reader.sync({limit:height-reader.height});if(reader.height===before)break;}
 if(reader.height<height)return [`The node only reaches block ${reader.height}; the service is at ${height}.`];
 const mine=reader.journal.filter(e=>e.height<=height),theirs=entries.filter(e=>e.height<=height),problems=[];
 if(mine.length!==theirs.length)problems.push(`This scan found ${mine.length} records up to block ${height}; the service logs ${theirs.length}.`);
 for(let i=0;i<Math.min(mine.length,theirs.length);i++)if(!same(mine[i],theirs[i])){problems.push(`Record ${i} differs: this scan has ${mine[i].txid} in block ${mine[i].height} (${mine[i].ok?'accepted':'refused'}), the service has ${theirs[i].txid} in block ${theirs[i].height} (${theirs[i].ok?'accepted':'refused'}).`);break;}
 return problems;}

// Everything the checks need from a running service.
export async function download(service,{fetch:f=fetch}={}){
 const get=async path=>{const r=await f(service.replace(/\/$/,'')+path,{signal:AbortSignal.timeout(30000)});if(!r.ok)throw Error(`${path}: HTTP ${r.status}`);return r.json();};
 const info=await get('/info'),entries=[];let height=null,hash=null;
 for(;;){const page=await get(`/log?from=${entries.length}&limit=500`);
  // The log only grows; if the service moved (or reorganised) while it was read, start again.
  if(height!=null&&(page.total<entries.length)){entries.length=0;height=null;continue;}
  height=page.height;hash=page.hash;entries.push(...page.entries);if(entries.length>=page.total)break;}
 const checkpoints=(await get('/checkpoints')).checkpoints.filter(c=>c.height<=height);
 return {info,entries:entries.filter(e=>e.height<=height),checkpoints,height,hash};}

if(process.argv[1]===import.meta.filename){
 const arg=name=>{const i=process.argv.indexOf('--'+name);return i<0?null:process.argv[i+1];};
 if(!arg('service')||!arg('owners')){console.error('Usage: node tools/verify.mjs --service <url> --owners <owners.jsonl> [--node <url>] [--scan <empty folder>] [--published <folder>]');process.exit(2);}
 const owners=readOwners(arg('owners')),got=await download(arg('service')),chain=arg('node')?createChain(arg('node')):null;
 const dir=arg('published'),published=dir&&existsSync(join(dir,'checkpoints.json'))?JSON.parse(readFileSync(join(dir,'checkpoints.json'),'utf8')).checkpoints.map(c=>JSON.parse(readFileSync(join(dir,'checkpoints',c.height+'.json'),'utf8'))):[];
 const result=await verify({...got,owners,chain,published});
 if(arg('scan')){if(!chain){console.error('--scan needs --node');process.exit(2);}const p=await scan({...got,owners,chain,dir:arg('scan')});result.scanned=true;result.problems.push(...p);result.ok=result.ok&&!p.length;}
 console.log(JSON.stringify({service:arg('service'),height:got.height,blockHash:got.hash,...result,note:result.scanned?undefined:'Without --scan this does not show that no record was left out.'},null,1));
 process.exit(result.ok?0:1);
}
