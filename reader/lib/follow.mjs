// A follower: transactions of other formats in the blocks a reader has read.
//
// The reader (reader.mjs) keeps the XMR721 ledger and looks at nothing else. A follower walks the same blocks behind
// it and keeps, in a folder of its own, the transactions a `pick` function chooses. It never runs ahead of the
// reader and takes a block only when the node gives it with the hash the reader holds for that height, so what it
// keeps is always a run of blocks of the reader's chain from the start block on. Nothing here changes the ledger, its
// journal or its checkpoints; a reader without a follower, or code that knows nothing of this folder, is unaffected,
// and a follower that was away catches up from where it stopped.
//
// Folder:
//   covered.json   how far the blocks were read, and how much of found.jsonl that is:
//                  {schema, name, network, start, startHash, height, hash, size, sum, recent, check}
//   found.jsonl    the chosen transactions in chain order: {height, pos, txid, time, …what pick returned}
// covered.json is the one statement of what is kept: it is replaced whole, and the first `size` bytes of found.jsonl
// are the transactions of the blocks it covers. A block's transactions are written behind those bytes before
// covered.json names the block; bytes behind `size` belong to nothing and are cut off before the next write. So a stop
// or a failed write at any point leaves either the state before the block or the state after it. `sum` is a hash over
// the kept lines, one after the other, and `check` a hash over covered.json's own fields: a folder whose files do not
// say the same thing is not believed.
// `recent` holds the hashes of the last covered blocks. When the reader's chain no longer has the covered block, the
// follower goes back to the newest of them the reader still has (to the start block when none is left) and reads on
// from there; going back only lowers `size`. A folder that is damaged or was made for something else (another pick,
// another start block, another chain) is not continued: the follower starts over from the start block. A folder that
// cannot be read at the moment is left as it is and tried again. Opening a follower writes nothing and does not fail
// on what the folder holds.
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,renameSync,openSync,writeSync,fsyncSync,ftruncateSync,fstatSync,closeSync} from 'node:fs';
import {join} from 'node:path';

export const SCHEMA='xmr721-follower-v2';
const int=v=>Number.isSafeInteger(v),sha=x=>createHash('sha256').update(x).digest('hex');
// The hash over the kept lines so far, with one more line.
const NONE=sha('no kept line'),next=(sum,line)=>createHash('sha256').update(sum).update(line).digest('hex');
const FIELDS=['schema','name','network','start','startHash','height','hash','size','sum','recent'];
const seal=c=>({...c,check:sha(JSON.stringify(FIELDS.map(k=>c[k])))});
// Every byte, or an error: a write that took only part is not counted as done.
const all=(fd,buf,at)=>{let done=0;while(done<buf.length){const n=writeSync(fd,buf,done,buf.length-done,at==null?null:at+done);if(!(n>0))throw Error('A write to the follower folder took nothing.');done+=n;}};
const replace=(file,text)=>{const tmp=file+'.tmp',fd=openSync(tmp,'w',0o644);try{all(fd,Buffer.from(text),null);fsyncSync(fd);}finally{closeSync(fd);}renameSync(tmp,file);};
// Cuts the file to `size` bytes and writes `buf` behind them. A file shorter than `size` is not what covered.json names.
function writeBehind(file,size,buf){
 const fd=openSync(file,existsSync(file)?'r+':'w+',0o644);
 try{if(fstatSync(fd).size<size)throw Error('found.jsonl is shorter than covered.json says.');ftruncateSync(fd,size);all(fd,buf,size);fsyncSync(fd);}finally{closeSync(fd);}}

// One block as a node gives it: its hash and time, and the extra field of each of its ordinary transactions in block
// order. A node that does not have every transaction of the block in that block is not believed.
export async function blockExtras(chain,height){
 const b=await chain.block(height),got=b.txids.length?await chain.txs(b.txids):new Map(),txs=[];
 for(const [pos,txid] of b.txids.entries()){const t=got.get(txid);
  if(!t||t.inPool||t.height!==height)throw Error(`The Monero node did not give transaction ${txid} of block ${height}.`);
  txs.push({txid,pos,extra:t.tx?.extra});}
 return {height,hash:b.hash,prev:b.prev,time:b.time,txs};}

// pick(extra) -> an object to keep for that transaction, or null. `extra` is the extra field as the node gives it (an
// array of byte values). A pick that throws keeps nothing. `name` names what is picked: a folder made under another
// name is not continued. `keep` is how many block hashes are remembered for going back.
export function openFollower({dir,chain,reader,pick,name='',keep=100,log=()=>{}}){
 if(typeof pick!=='function')throw Error('A follower needs a pick function.');
 const files={found:join(dir,'found.jsonl'),covered:join(dir,'covered.json')},start=reader.meta.start,network=reader.meta.network;
 // The reader's block at a height, as it stands now.
 const hashAt=h=>h===start?reader.meta.startHash:reader.blocks[h-start-1]?.hash??null;
 // entries[i] ends at byte ends[i] of found.jsonl, and sums[i] is the hash over the lines up to it.
 // `version` counts every change of what is kept, `epoch` only the times something kept was dropped again.
 let covered=null,entries=[],ends=[],sums=[],version=0,epoch=0;
 const forget=()=>{covered=null;if(entries.length){version++;epoch++;}entries=[];ends=[];sums=[];};
 const fits=c=>c!==null&&typeof c==='object'&&c.schema===SCHEMA&&c.name===name&&c.network===network&&c.start===start&&int(c.height)&&c.height>=start&&typeof c.hash==='string'&&typeof c.startHash==='string'
  &&int(c.size)&&c.size>=0&&typeof c.sum==='string'&&Array.isArray(c.recent)&&c.recent.every(x=>Array.isArray(x)&&x.length===2&&int(x[0])&&typeof x[1]==='string')&&c.check===seal(c).check
  &&(!reader.meta.startHash||c.startHash===reader.meta.startHash);
 // Reads the folder; writes nothing. -> 'ok' (a covered state is held), 'fresh' (nothing there), 'damaged' (not a
 // covered state: start over) or 'unreadable' (the files cannot be read now: nothing is concluded).
 function load(){
  const over=why=>{log({follower:name,startingOver:String(why).slice(0,160)});return 'damaged';};
  let text,buf=Buffer.alloc(0),c;
  if(!existsSync(files.covered))return 'fresh';
  try{text=readFileSync(files.covered,'utf8');}catch{return 'unreadable';}
  try{c=JSON.parse(text);}catch{return over('covered.json is not whole');}
  if(!fits(c))return over('the folder was made for something else, or its covered.json was changed');
  if(c.size){try{buf=readFileSync(files.found);}catch(e){if(e?.code==='ENOENT'||e?.code==='EISDIR')return over('found.jsonl is not there');return 'unreadable';}}
  const rows=[],at=[],hashes=[];
  try{
   if(buf.length<c.size||(c.size&&buf[c.size-1]!==10))throw Error('found.jsonl does not hold what covered.json names');
   let from=0,last=start,sum=NONE;
   for(let i=0;i<c.size;i++){if(buf[i]!==10)continue;const line=buf.subarray(from,i+1),e=JSON.parse(line.toString('utf8'));
    if(e===null||typeof e!=='object'||!int(e.height)||e.height<last||e.height>c.height||typeof e.txid!=='string')throw Error('found.jsonl holds a line that is not a kept transaction');
    sum=next(sum,line);rows.push(e);at.push(i+1);hashes.push(sum);last=e.height;from=i+1;}
   if((hashes.at(-1)??NONE)!==c.sum)throw Error('found.jsonl is not the file covered.json was written for');
  }catch(e){return over(e?.message||e);}
  covered=c;entries=rows;ends=at;sums=hashes;return 'ok';}
 let folder=load();
 const save=c=>replace(files.covered,JSON.stringify(c)+'\n');
 let busy=null;
 async function pass({limit=Infinity,budget=Infinity}={}){
  const startHash=reader.meta.startHash,began=Date.now();
  // Before the reader's first pass there is no chain to follow.
  if(!startHash)return {height:covered?.height??start,added:0,complete:false};
  // A folder that could not be read is read again; while it cannot be, nothing is done and nothing is overwritten.
  if(folder==='unreadable'){folder=load();if(folder==='unreadable')throw Error('The follower folder cannot be read now.');}
  // A folder read before the reader knew its start block's hash, and made on another chain: start over.
  if(covered&&covered.startHash!==startHash){forget();log({follower:name,startingOver:'another start block hash'});}
  if(!covered){const c=seal({schema:SCHEMA,name,network,start,startHash,height:start,hash:startHash,size:0,sum:NONE,recent:[]});mkdirSync(dir,{recursive:true});save(c);forget();covered=c;}
  // Is the covered block still a block of the reader's chain? A block's hash names every block below it, so when it
  // is, nothing that was covered has changed. Going back is one write: the smaller `size` drops what lay above.
  if(covered.height>reader.height||hashAt(covered.height)!==covered.hash){
   const from=covered.height;let to=[start,startHash];
   for(let i=covered.recent.length-1;i>=0;i--){const [h,x]=covered.recent[i];if(h<=reader.height&&hashAt(h)===x){to=[h,x];break;}}
   let n=entries.length;while(n>0&&entries[n-1].height>to[0])n--;
   const c=seal({...covered,height:to[0],hash:to[1],size:n?ends[n-1]:0,sum:n?sums[n-1]:NONE,recent:covered.recent.filter(([h])=>h<=to[0])});save(c);
   covered=c;if(n<entries.length){version++;epoch++;}entries=entries.slice(0,n);ends=ends.slice(0,n);sums=sums.slice(0,n);log({follower:name,back:from-to[0],to:to[0]});}
  let added=0;
  while(covered.height<reader.height&&added<limit&&Date.now()-began<budget){
   const h=covered.height+1,b=await blockExtras(chain,h);
   // The reader may have gone back meanwhile, or the node may be on another chain than the reader read: only a block
   // the reader holds now, by its hash, on top of the covered one, is taken. Otherwise the next pass looks again.
   if(hashAt(h)!==b.hash||hashAt(h-1)!==covered.hash)break;
   const got=[];for(const t of b.txs){let v=null;try{v=pick(t.extra);}catch{v=null;}if(v)got.push({height:h,pos:t.pos,txid:t.txid,time:b.time,...v});}
   const lines=got.map(e=>Buffer.from(JSON.stringify(e)+'\n')),buf=Buffer.concat(lines);
   // (A found.jsonl that lost bytes while this ran cannot be continued: start over at the next pass.)
   if(buf.length){try{writeBehind(files.found,covered.size,buf);}catch(e){if(/shorter than/.test(String(e?.message)))forget();throw e;}}
   let at=covered.size,sum=covered.sum;const more=[],hashes=[];for(const x of lines){at+=x.length;sum=next(sum,x);more.push(at);hashes.push(sum);}
   const c=seal({...covered,height:h,hash:b.hash,size:at,sum,recent:keep>0?[...covered.recent,[h,b.hash]].slice(-keep):[]});save(c);
   // Only now, with both writes done, does the follower itself hold the block.
   covered=c;if(got.length){entries.push(...got);ends.push(...more);sums.push(...hashes);version++;}
   added++;}
  return {height:covered.height,added,complete:whole()};}
 const whole=()=>Boolean(covered)&&covered.height===reader.height&&hashAt(covered.height)===covered.hash;
 return {
  // Everything kept so far, in chain order. Do not change it.
  get entries(){return entries;},
  // The last covered block, and whether the follower has read every block the reader holds.
  get height(){return covered?.height??start;},get hash(){return covered?.hash??reader.meta.startHash;},
  get complete(){return whole();},
  // `version` changes whenever the kept transactions change (new ones, or a step back), so a view made from them can
  // be kept; `epoch` changes only when kept transactions were dropped: until then new ones only come behind the old.
  get version(){return version;},get epoch(){return epoch;},
  // One pass at a time: go back if the reader's chain changed, then read on, at most `limit` blocks and for about
  // `budget` milliseconds.
  run(options){if(!busy)busy=pass(options).finally(()=>{busy=null;});return busy;}};}
