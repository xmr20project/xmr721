// One command at a time on a wallet folder.
//
// The lock is the folder <wallet>/lock. A command puts an empty file of its own into it, named after its process, and
// only then looks who else is there. It works when nobody else is, and takes its file away again when it is not alone
// or when it is done. Two commands that arrive at the same moment both see each other and both step back and try again
// a little later; no command ever works beside another, whatever the timing, and no file has to be read to know whose
// it is.
//
// A file whose process is gone is left over and is removed by whoever finds it. That is safe, because every name is
// used once. The carrier tool runs apart from the command (cli/lib/tool.mjs) and has a file of its own while it runs:
// a command that was killed does not let a second one work on the wallet beside its tool.
import {mkdirSync,readdirSync,openSync,closeSync,unlinkSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';

const NAME=/^([1-9][0-9]{0,9})-(command|tool)-[0-9a-f]{16}$/;
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e?.code==='EPERM';}};
// Every file this process put into a lock folder and has not taken away. Such a file is in use, whichever caller in
// this process put it there.
const ours=new Set();

export function openLock(dir,{tries=6}={}){
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
  // -> a function that gives the wallet back. Throws when another command holds the wallet for longer than a moment.
  async acquire(){
   try{mkdirSync(folder,{mode:0o700});}
   catch(e){
    if(e?.code!=='EEXIST')throw Error(e?.code==='ENOENT'||e?.code==='ENOTDIR'?'There is no wallet folder at '+dir+'.':`The wallet folder ${dir} cannot be written (${e?.code}).`);
    let folderThere=false;try{folderThere=statSync(folder).isDirectory();}catch{}
    if(!folderThere)throw Error(`${folder} is not a folder. If no xmr721 command is running, remove it.`);}
   for(let i=0;;i++){
    let mine;try{mine=put(process.pid,'command');}catch(e){throw Error(`The wallet folder ${dir} cannot be written (${e?.code}).`);}
    let busy;try{busy=others(mine);}catch(e){drop(mine);throw Error(`The wallet folder ${dir} cannot be read (${e?.code}).`);}
    if(!busy.length){const release=()=>{process.removeListener('exit',release);drop(mine);};process.on('exit',release);return release;}
    drop(mine);
    if(i+1>=tries){const b=busy.find(x=>x.kind==='tool')||busy[0];
     throw Error(b.kind==='tool'?`A step of an earlier xmr721 command is still running on this wallet (process ${b.pid}). Wait until it is done.`
      :`Another xmr721 command is working on this wallet (process ${b.pid}). Wait until it is done. If none is running, remove the folder ${folder}`);}
    await new Promise(r=>setTimeout(r,(20+Math.floor(Math.random()*80))*(i+1)));}},
  // The carrier tool runs as process `pid`: the wallet stays held for as long as that process lives.
  // -> a function to call when it has ended.
  hold(pid){try{const path=put(pid,'tool');return ()=>drop(path);}catch{return ()=>{};}}};}
