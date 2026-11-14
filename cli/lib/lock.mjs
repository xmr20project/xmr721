// One command at a time on a wallet folder.
//
// The lock is the folder <wallet>/lock. A command puts an empty file of its own into it, named after its process, and
// only then looks who else is there. It works when nobody else is, and takes its file away again when it is not alone
// or when it is done. A command that is not alone steps back and tries again a little later, for a few seconds; then
// it says who holds the wallet. No command ever works beside another, whatever the timing, and no file has to be read
// to know whose it is.
//
// A file whose process is gone is left over and is removed by whoever finds it. That is safe, because every name is
// used once. The carrier tool runs apart from the command (cli/lib/tool.mjs) and has a file of its own while it runs:
// a command that was killed does not let a second one work on the wallet beside its tool. Process ids are those of one
// machine: a wallet folder is for one machine at a time.
import {mkdirSync,readdirSync,openSync,closeSync,unlinkSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';

const NAME=/^([1-9][0-9]{0,9})-(command|tool)-[0-9a-f]{16}$/;
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e?.code==='EPERM';}};
// Every file this process put into a lock folder and has not taken away. Such a file is in use, whichever caller in
// this process put it there.
const ours=new Set();

export function openLock(dir,{wait=5000}={}){
 const folder=join(dir,'lock');
 const put=(pid,kind)=>{const path=join(folder,`${pid}-${kind}-${randomBytes(8).toString('hex')}`);closeSync(openSync(path,'wx',0o600));ours.add(path);return path;};
 const drop=path=>{ours.delete(path);try{unlinkSync(path);}catch{}};
 // Who else holds the wallet: files of processes that are alive, and files of this process that are still in use.
 // Files of processes that are gone are removed on the way.
 function others(mine){
  const out=[];
  for(const name of readdirSync(folder)){
   const path=join(folder,name),m=NAME.exec(name);if(path===mine||!m)continue;
   const pid=Number(m[1]);
   if(ours.has(path)||(pid!==process.pid&&alive(pid)))out.push({pid,kind:m[2]});
   else try{unlinkSync(path);}catch{}}
  return out;}
 return {folder,
  // -> a function that gives the wallet back. Throws when someone else holds the wallet for longer than `wait`.
  async acquire(){
   try{mkdirSync(folder,{mode:0o700});}
   catch(e){
    if(e?.code!=='EEXIST')throw Error(e?.code==='ENOENT'||e?.code==='ENOTDIR'?'There is no wallet folder at '+dir+'.':`The wallet folder ${dir} cannot be written (${e?.code}).`);
    let folderThere=false;try{folderThere=statSync(folder).isDirectory();}catch{}
    if(!folderThere)throw Error(`${folder} is not a folder. If no xmr721 command is running, remove it.`);}
   for(const until=Date.now()+wait;;){
    let mine;try{mine=put(process.pid,'command');}catch(e){throw Error(`The wallet folder ${dir} cannot be written (${e?.code}).`);}
    let busy;try{busy=others(mine);}catch(e){drop(mine);throw Error(`The wallet folder ${dir} cannot be read (${e?.code}).`);}
    if(!busy.length){const release=()=>{process.removeListener('exit',release);drop(mine);};process.on('exit',release);return release;}
    drop(mine);
    if(Date.now()>=until){const b=busy.find(x=>x.kind==='command')||busy[0];
     throw Error(b.kind==='command'?`Another xmr721 command is working on this wallet (process ${b.pid}). Try again when it is done. If no such command is running, remove the folder ${folder}`
      :`The carrier tool of an xmr721 command that ended is still working on this wallet (process ${b.pid}). Try again when it is done. If process ${b.pid} is something else, remove the folder ${folder}`);}
    await new Promise(r=>setTimeout(r,40+Math.floor(Math.random()*160)));}},
  // The carrier tool runs as process `pid`: the wallet stays held for as long as that process lives.
  // -> a function to call when it has ended.
  hold(pid){try{const path=put(pid,'tool');return ()=>drop(path);}catch{return ()=>{};}}};}
