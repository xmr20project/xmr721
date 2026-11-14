// The carrier tool (reader/carrier) as the xmr721 command runs it.
//
// The tool runs in a process group of its own. A stop signal from the terminal goes to every process of the terminal's
// group, so it reaches the command and not the tool; the command decides what to do (cli/xmr721.mjs) and ends the tool
// with stop() when it stops itself. While the tool runs, the wallet folder's lock holds a file for it
// (cli/lib/lock.mjs).
//
// Reading the chain has no time limit: a wallet that was not used for long reads many blocks, and the tool keeps what
// it read only when it is through. Handing a transaction to the node, and making keys, do have one.
import {spawn} from 'node:child_process';
import {clean} from './text.mjs';

export function createTool({bin,stateDir,node,network,start=1,lock=null,limit=1<<21,sendTimeout=120000}){
 let queue=Promise.resolve(),child=null;
 const env={PATH:process.env.PATH||'',HOME:process.env.HOME||'',MORDINALS_NODE:node,MORDINALS_NETWORK:network,MORDINALS_START:String(start)};
 // Mainnet and the fee limit are set by the command itself (cli/xmr721.mjs), never taken from elsewhere.
 for(const k of ['MORDINALS_MAINNET','MORDINALS_MAX_FEE'])if(process.env[k])env[k]=process.env[k];
 const end=c=>{try{process.kill(-c.pid,'SIGKILL');}catch{try{c.kill('SIGKILL');}catch{}}};
 const run=(op,arg,timeout=0)=>{
  const next=queue.then(()=>new Promise((done,fail)=>{
   const cannot=e=>`The carrier tool at ${bin} cannot be started (${clean(e?.code||e?.message,60)}).`;
   let c;try{c=spawn(bin,[stateDir,op,...(arg==null?[]:[String(arg)])],{env,detached:true,stdio:['ignore','pipe','ignore']});}catch(e){fail(Error(cannot(e)));return;}
   const free=c.pid&&lock?lock.hold(c.pid):()=>{},parts=[];let size=0,over=false,late=false,finished=false;child=c;
   const timer=timeout?setTimeout(()=>{late=true;end(c);},timeout):null;
   const finish=problem=>{
    if(finished)return;finished=true;clearTimeout(timer);if(child===c)child=null;free();
    let v=null;try{v=JSON.parse(Buffer.concat(parts).toString('utf8').trim().split('\n').at(-1));}catch{}
    if(!problem&&!over&&v&&typeof v==='object'&&'result' in v)done(v.result);
    else fail(Error(problem||(v&&typeof v.error==='string'?clean(v.error,300):'The carrier tool did not answer'+(late?' in time':'')+'.')));};
   c.stdout.on('data',d=>{size+=d.length;if(size>limit){over=true;end(c);}else parts.push(d);});
   c.on('error',e=>finish(cannot(e)));c.on('close',()=>finish(null));}));
  queue=next.catch(()=>{});return next;};
 return {init:()=>run('init',null,60000),status:()=>run('status'),carry:record=>run('carry',record),split:n=>run('split',n),publish:blob=>run('publish',blob,sendTimeout),
  // The process id of the tool while it runs, and a way to end it at once.
  get running(){return child?.pid??null;},stop(){if(child)end(child);}};}
