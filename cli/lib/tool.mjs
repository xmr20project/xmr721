// The carrier tool (reader/carrier) as the xmr721 command runs it.
//
// The tool runs in a process group of its own. A stop signal from the terminal goes to every process of the terminal's
// group, so it reaches the command and not the tool; the command decides what to do (cli/xmr721.mjs) and ends the tool
// with stop() when it stops itself. While the tool runs, the wallet folder's lock holds a file for it
// (cli/lib/lock.mjs).
//
// Reading the chain has no time limit: a wallet that was not used for long reads many blocks, and the tool keeps what
// it read only when it is through. Making keys has one. The wallet hands its transactions to the node itself
// (reader/lib/chain.mjs), not through the tool.
import {spawn} from 'node:child_process';
import {clean} from './text.mjs';

// start: the block the wallet's scan starts at, or a function that gives it (asked each time the tool is run).
export function createTool({bin,stateDir,node,network,start=1,lock=null,limit=1<<21}){
 let queue=Promise.resolve(),child=null,release=null;
 const env={PATH:process.env.PATH||'',HOME:process.env.HOME||'',MORDINALS_NODE:node,MORDINALS_NETWORK:network};
 // Mainnet and the fee limit are set by the command itself (cli/xmr721.mjs), never taken from elsewhere.
 for(const k of ['MORDINALS_MAINNET','MORDINALS_MAX_FEE'])if(process.env[k])env[k]=process.env[k];
 const end=c=>{try{process.kill(-c.pid,'SIGKILL');}catch{try{c.kill('SIGKILL');}catch{}}};
 const run=(op,arg,timeout=0)=>{
  const next=queue.then(()=>new Promise((done,fail)=>{
   const cannot=e=>`The carrier tool at ${bin} cannot be started (${clean(e?.code||e?.message,60)}).`;
   let c;try{c=spawn(bin,[stateDir,op,...(arg==null?[]:[String(arg)])],{env:{...env,MORDINALS_START:String(typeof start==='function'?start():start)},detached:true,stdio:['ignore','pipe','ignore']});}catch(e){fail(Error(cannot(e)));return;}
   const free=c.pid&&lock?lock.hold(c.pid):()=>{},parts=[];let size=0,over=false,late=false,finished=false;child=c;release=free;
   const timer=timeout?setTimeout(()=>{late=true;end(c);},timeout):null;
   const finish=problem=>{
    if(finished)return;finished=true;clearTimeout(timer);if(child===c){child=null;release=null;}free();
    let v=null;try{v=JSON.parse(Buffer.concat(parts).toString('utf8').trim().split('\n').at(-1));}catch{}
    if(!problem&&!over&&v&&typeof v==='object'&&'result' in v)done(v.result);
    else fail(Error(problem||(v&&typeof v.error==='string'?clean(v.error,300):'The carrier tool did not answer'+(late?' in time':'')+'.')));};
   c.stdout.on('data',d=>{size+=d.length;if(size>limit){over=true;end(c);}else parts.push(d);});
   // (A tool that was ended is done when it is gone, whoever still holds its output open.)
   c.on('error',e=>finish(cannot(e)));c.on('close',()=>finish(null));c.on('exit',()=>{if(late||over)finish(null);});}));
  queue=next.catch(()=>{});return next;};
 return {init:()=>run('init',null,60000),status:()=>run('status'),carry:record=>run('carry',record),split:n=>run('split',n),
  // The process id of the tool while it runs, and a way to end it at once: it is killed outright, and with that its
  // hold on the wallet folder is over.
  get running(){return child?.pid??null;},stop(){if(child){end(child);release?.();}}};}
