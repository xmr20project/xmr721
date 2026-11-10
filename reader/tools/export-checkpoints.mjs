// Writes a service's checkpoints as files that can be kept in a public place (a git repository, a static site):
//
//   node tools/export-checkpoints.mjs --service <url> --out <folder>
//
//   <folder>/checkpoints/<height>.json   one checkpoint each, exactly as the reader computed it
//   <folder>/checkpoints.json            the list: height, block hash and the SHA-256 of each file
// Files already written are never changed: if the service now states another checkpoint for a height that was
// written before, this stops and says so (the chain reorganised below a checkpoint, or the service changed).
// A checkpoint is a statement by whoever runs the reader. tools/verify.mjs recomputes it from the chain.
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';

export async function exportCheckpoints({service,out,fetch:f=fetch}){
 const r=await f(service.replace(/\/$/,'')+'/checkpoints',{signal:AbortSignal.timeout(30000)});if(!r.ok)throw Error('The service answered HTTP '+r.status);
 const {checkpoints}=await r.json(),dir=join(out,'checkpoints');mkdirSync(dir,{recursive:true});
 const list=[];let added=0;
 for(const c of checkpoints){const file=join(dir,c.height+'.json'),text=JSON.stringify(c,null,1)+'\n';
  if(existsSync(file)){if(readFileSync(file,'utf8')!==text)throw Error(`The checkpoint at block ${c.height} differs from the one written before. Nothing was changed.`);}
  else{writeFileSync(file,text);added++;}
  list.push({height:c.height,blockHash:c.blockHash,records:c.records,sha256:createHash('sha256').update(text).digest('hex')});}
 writeFileSync(join(out,'checkpoints.json'),JSON.stringify({schema:'mordinals-checkpoints-v1',network:checkpoints[0]?.network??null,domain:checkpoints[0]?.domain??null,owners:checkpoints[0]?.owners??null,checkpoints:list},null,1)+'\n');
 return {total:list.length,added};}

if(process.argv[1]===import.meta.filename){
 const arg=name=>{const i=process.argv.indexOf('--'+name);return i<0?null:process.argv[i+1];};
 if(!arg('service')||!arg('out')){console.error('Usage: node tools/export-checkpoints.mjs --service <url> --out <folder>');process.exit(2);}
 try{console.log(JSON.stringify(await exportCheckpoints({service:arg('service'),out:arg('out')})));}catch(e){console.error(e.message);process.exit(1);}
}
