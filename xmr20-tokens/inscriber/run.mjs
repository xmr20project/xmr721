// The launch inscriber as a command (inscriber.mjs).
//
//   node xmr20-tokens/inscriber/run.mjs --new-key <file>
//        makes an inscriber key in <file> (readable by its owner only) and prints its address; the address goes into
//        the index's --xmr20-inscribers list
//   node xmr20-tokens/inscriber/run.mjs --index <reader service url> --domain <hex32> --key-file <file> --state <dir> --since <time>
//        [--trade <trading service url>] [--bridge <launch list url>] [--network mainnet|stagenet] [--every <ms>] [--once] [--preview]
//        [--backfill] [--burst <n>] [--per-day <n>]
//        --since    launches made from this time on are inscribed: milliseconds, or a date like 2026-11-14T00:00:00Z.
//                   A time more than two days back is refused unless --backfill is given (what is inscribed stays).
//        --burst    a list showing more new launches than this at once is not taken from (default 20)
//        --per-day  records made in 24 hours (default 50)
//        --trade    Monero curve launches, e.g. https://api.xmr20.org/trade
//        --bridge   bonding curve launches, e.g. https://xmr20.org/api/xmr20/tokens
//        --preview  print the texts that would be inscribed for the launches listed now, and what is left out and why;
//                   sign and send nothing
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {newSecret,inscriberFrom} from '../lib/inscribe.mjs';
import {createInscriber,httpIndex,EARLIEST} from './inscriber.mjs';
import {tradeSource,bridgeSource,httpGet} from './sources.mjs';

const arg=name=>{const i=process.argv.indexOf('--'+name);return i<0?null:process.argv[i+1];},has=name=>process.argv.includes('--'+name);
const network=arg('network')||'mainnet';
if(has('new-key')){
 const file=arg('new-key');if(!file||existsSync(file)){console.error('--new-key needs a file that does not exist yet.');process.exit(2);}
 const secret=newSecret();writeFileSync(file,secret+'\n',{mode:0o600,flag:'wx'});
 console.log('Inscriber address: '+inscriberFrom(secret,network).address);process.exit(0);}
for(const need of ['index','domain','key-file','state','since'])if(!arg(need)){console.error('Missing --'+need+'. See the top of this file.');process.exit(2);}
const since=/^\d+$/.test(arg('since'))?Number(arg('since')):Date.parse(arg('since'));
if(!Number.isSafeInteger(since)||since<EARLIEST){console.error('--since: milliseconds (13 digits) or a date like 2026-11-14T00:00:00Z.');process.exit(2);}
if(since>Date.now()+600000){console.error('--since is in the future.');process.exit(2);}
if(since<Date.now()-2*86400000&&!has('backfill')){console.error('--since is more than two days back ('+new Date(since).toISOString()+'). Every launch since then would be inscribed for good; give --backfill if that is meant.');process.exit(2);}
const whole=name=>{const v=arg(name);if(v===null)return {};if(!/^\d{1,6}$/.test(v)){console.error('--'+name+': a number.');process.exit(2);}return Number(v);};
const limits={...(arg('burst')!==null?{burst:whole('burst')}:{}),...(arg('per-day')!==null?{perDay:whole('per-day')}:{})};
const get=httpGet(),sources=[...(arg('trade')?[tradeSource({base:arg('trade').replace(/\/$/,''),get})]:[]),...(arg('bridge')?[bridgeSource({url:arg('bridge'),get})]:[])];
if(!sources.length){console.error('Give at least one of --trade and --bridge.');process.exit(2);}
const log=v=>console.log(new Date().toISOString(),JSON.stringify(v));
const inscriber=createInscriber({dir:arg('state'),sources,index:httpIndex(arg('index').replace(/\/$/,'')),inscriber:inscriberFrom(readFileSync(arg('key-file'),'utf8').trim(),network),domain:arg('domain'),network,since,limits,log});
if(has('preview')){for(const l of await inscriber.preview())console.log(l.at?new Date(l.at).toISOString():'-',l.source,l.skipped?'LEFT OUT '+l.mint+': '+l.skipped:l.text);process.exit(0);}
console.log('Launch inscriber '+inscriber.address+', launches from '+new Date(since).toISOString());
let last='';
const turn=async()=>{try{const out=await inscriber.turn(),line=JSON.stringify({...out,height:undefined});if(line!==last){last=line;log(out);}}catch(e){log({error:String(e.message).slice(0,200)});}};
await turn();
if(!has('once'))setInterval(turn,Number(arg('every'))||60000);
