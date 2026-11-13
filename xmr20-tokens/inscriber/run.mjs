// The launch inscriber as a command (inscriber.mjs).
//
//   node xmr20-tokens/inscriber/run.mjs --new-key <file>
//        makes an inscriber key in <file> (readable by its owner only) and prints its address; the address goes into
//        the index's --xmr20-inscribers list
//   node xmr20-tokens/inscriber/run.mjs --index <reader service url> --domain <hex32> --key-file <file> --state <dir> --since <time>
//        [--trade <trading service url>] [--bridge <launch list url>] [--network mainnet|stagenet] [--every <ms>] [--once] [--preview]
//        --since    launches made from this time on are inscribed: milliseconds, or a date like 2026-11-14T00:00:00Z
//        --trade    Monero curve launches, e.g. https://api.xmr20.org/trade
//        --bridge   bonding curve launches, e.g. https://xmr20.org/api/xmr20/tokens
//        --preview  print the texts that would be inscribed for the launches listed now; sign and send nothing
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {newSecret,inscriberFrom} from '../lib/inscribe.mjs';
import {createInscriber,httpIndex} from './inscriber.mjs';
import {tradeSource,bridgeSource,httpGet} from './sources.mjs';

const arg=name=>{const i=process.argv.indexOf('--'+name);return i<0?null:process.argv[i+1];},has=name=>process.argv.includes('--'+name);
const network=arg('network')||'mainnet';
if(has('new-key')){
 const file=arg('new-key');if(!file||existsSync(file)){console.error('--new-key needs a file that does not exist yet.');process.exit(2);}
 const secret=newSecret();writeFileSync(file,secret+'\n',{mode:0o600,flag:'wx'});
 console.log('Inscriber address: '+inscriberFrom(secret,network).address);process.exit(0);}
for(const need of ['index','domain','key-file','state','since'])if(!arg(need)){console.error('Missing --'+need+'. See the top of this file.');process.exit(2);}
const since=/^\d+$/.test(arg('since'))?Number(arg('since')):Date.parse(arg('since'));
if(!Number.isSafeInteger(since)||since<=0){console.error('--since: milliseconds or a date.');process.exit(2);}
const get=httpGet(),sources=[...(arg('trade')?[tradeSource({base:arg('trade').replace(/\/$/,''),get})]:[]),...(arg('bridge')?[bridgeSource({url:arg('bridge'),get})]:[])];
if(!sources.length){console.error('Give at least one of --trade and --bridge.');process.exit(2);}
const log=v=>console.log(new Date().toISOString(),JSON.stringify(v));
const inscriber=createInscriber({dir:arg('state'),sources,index:httpIndex(arg('index').replace(/\/$/,'')),inscriber:inscriberFrom(readFileSync(arg('key-file'),'utf8').trim(),network),domain:arg('domain'),network,since,log});
if(has('preview')){for(const l of await inscriber.preview())console.log(new Date(l.at).toISOString(),l.source,l.text);process.exit(0);}
console.log('Launch inscriber '+inscriber.address+', launches from '+new Date(since).toISOString());
let last='';
const turn=async()=>{try{const out=await inscriber.turn(),line=JSON.stringify({...out,height:undefined});if(line!==last){last=line;log(out);}}catch(e){log({error:String(e.message).slice(0,200)});}};
await turn();
if(!has('once'))setInterval(turn,Number(arg('every'))||60000);
