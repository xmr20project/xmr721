// The launch inscriber as a command (inscriber.mjs).
//
//   node xmr20-tokens/inscriber/run.mjs --new-key <file> [--network mainnet|stagenet]
//        makes an inscriber key in <file> (readable by its owner only) and prints its address; the address goes into
//        the ledger's --minters and the index's --xmr20-inscribers
//   node xmr20-tokens/inscriber/run.mjs --preview --since <time> [--trade <url>] [--bridge <url>]
//        prints the texts that would be inscribed for the launches listed now, and what is left out and why.
//        Reads the lists and nothing else: no key, no journal, nothing signed or sent.
//   node xmr20-tokens/inscriber/run.mjs --index <reader service url> --domain <hex32> --key-file <file> --state <dir> --since <time>
//        [--trade <trading service url>] [--bridge <launch list url>] [--network mainnet|stagenet] [--every <ms>] [--once]
//        [--backfill] [--burst <n>] [--per-day <n>]
//        --since    launches made from this time on are inscribed: milliseconds (13 digits), or a date with its zone like
//                   2026-11-14T00:00:00Z. A time more than two days back is refused unless --backfill is given (what is
//                   inscribed stays).
//        --trade    Monero curve launches, e.g. https://api.xmr20.org/trade
//        --bridge   bonding curve launches, e.g. https://xmr20.org/api/xmr20/tokens
//        --burst    a list showing more new launches than this at once is not taken from (default 20)
//        --per-day  records made in 24 hours (default 50)
// Every argument has to be one of these: a mistyped one stops the command instead of being passed over.
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {newSecret,inscriberFrom} from '../lib/inscribe.mjs';
import {createInscriber,httpIndex,preview,EARLIEST} from './inscriber.mjs';
import {tradeSource,bridgeSource,httpGet} from './sources.mjs';

const stop=text=>{console.error(text);process.exit(2);};
const VALUES=['index','domain','key-file','state','since','trade','bridge','network','every','burst','per-day','new-key'],FLAGS=['once','preview','backfill'];
const given={};
for(let i=2;i<process.argv.length;i++){
 const a=process.argv[i],name=a.startsWith('--')?a.slice(2):null;
 if(name===null||!(VALUES.includes(name)||FLAGS.includes(name)))stop(`Unknown argument ${a}. See the top of this file.`);
 if(name in given)stop(`--${name} is given twice.`);
 if(FLAGS.includes(name)){given[name]=true;continue;}
 const v=process.argv[++i];if(v===undefined||v.startsWith('--'))stop(`--${name} needs a value.`);
 given[name]=v;}
const arg=name=>given[name]??null,has=name=>given[name]===true;
const network=arg('network')||'mainnet';if(!['mainnet','stagenet'].includes(network))stop('--network: mainnet or stagenet.');

if(arg('new-key')){
 if(Object.keys(given).some(k=>k!=='new-key'&&k!=='network'))stop('--new-key takes only --network with it.');
 const file=arg('new-key');if(existsSync(file))stop('--new-key needs a file that does not exist yet.');
 const secret=newSecret();writeFileSync(file,secret+'\n',{mode:0o600,flag:'wx'});
 console.log('Inscriber address: '+inscriberFrom(secret,network).address);process.exit(0);}

if(!arg('since'))stop('Missing --since. See the top of this file.');
const text=arg('since'),since=/^\d{13,}$/.test(text)?Number(text):/^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d{1,3})?)?(Z|[+-]\d\d:\d\d)$/.test(text)?Date.parse(text):NaN;
if(!Number.isSafeInteger(since)||since<EARLIEST)stop('--since: milliseconds (13 digits) or a date with its zone like 2026-11-14T00:00:00Z.');
if(since>Date.now()+600000)stop('--since is in the future.');
const get=httpGet(),sources=[...(arg('trade')?[tradeSource({base:arg('trade').replace(/\/$/,''),get})]:[]),...(arg('bridge')?[bridgeSource({url:arg('bridge'),get})]:[])];
if(!sources.length)stop('Give at least one of --trade and --bridge.');

if(has('preview')){
 for(const l of await preview({sources,since}))console.log(l.at?new Date(l.at).toISOString():'-',l.source,l.skipped?'LEFT OUT '+l.mint+': '+l.skipped:l.text);
 process.exit(0);}

for(const need of ['index','domain','key-file','state'])if(!arg(need))stop('Missing --'+need+'. See the top of this file.');
if(since<Date.now()-2*86400000&&!has('backfill'))stop('--since is more than two days back ('+new Date(since).toISOString()+'). Every launch since then would be inscribed for good; give --backfill if that is meant.');
const count=name=>{const v=arg(name);if(!/^[1-9]\d{0,5}$/.test(v))stop('--'+name+': a number from 1.');return Number(v);};
const limits={...(arg('burst')!==null?{burst:count('burst')}:{}),...(arg('per-day')!==null?{perDay:count('per-day')}:{})};
const every=arg('every')===null?60000:/^[1-9]\d{3,7}$/.test(arg('every'))?Number(arg('every')):stop('--every: milliseconds, 1000 or more.');
const log=v=>console.log(new Date().toISOString(),JSON.stringify(v));
const inscriber=createInscriber({dir:arg('state'),sources,index:httpIndex(arg('index').replace(/\/$/,'')),inscriber:inscriberFrom(readFileSync(arg('key-file'),'utf8').trim(),network),domain:arg('domain'),network,since,limits,log});
console.log('Launch inscriber '+inscriber.address+', launches from '+new Date(since).toISOString());
let last='';
const turn=async()=>{try{const out=await inscriber.turn(),line=JSON.stringify({...out,height:undefined});if(line!==last){last=line;log(out);}}catch(e){log({error:String(e.message).slice(0,200)});}};
await turn();
if(!has('once'))setInterval(turn,every);
