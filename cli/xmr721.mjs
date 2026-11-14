#!/usr/bin/env node
// xmr721: inscribe on Monero from a wallet of your own (README.md, "Inscribe").
//
//   xmr721 wallet create                         a new wallet; prints its address
//   xmr721 wallet receive                        the wallet's address
//   xmr721 wallet balance                        its balance and how many coins can pay right now
//   xmr721 wallet split <n>                      makes n coins of 0.01 XMR (2 to 14) from one larger coin, so n records
//                                                can go out in one block
//   xmr721 wallet inscribe --file <path> [--type <type>] [--name <text>] [--to <address>]
//                          [--collection <id> [--edition <n>]] [--dry-run]
//                                                one NFT; with --collection, an edition of one of the wallet's collections
//   xmr721 wallet collection --name <text> --max <n> [--dry-run]
//                                                a collection whose editions only this wallet mints
//   xmr721 wallet send <nft id> <address> [--dry-run]
//                                                sends an NFT the wallet owns
//   xmr721 wallet inscriptions                   what the wallet built, and where each transaction is now
//   xmr721 wallet resend                         sends again what is kept and in no block
//   xmr721 wallet forget <n>                     gives up a kept transaction (its number in "inscriptions")
//   xmr721 wallet rescan                         reads the wallet's coins anew; frees coins of transactions that never got in
//   xmr721 wallet restore --height <n>           for a wallet folder that has only its keys: the block to scan from
//
// Options for every command, each written as "--name value":
//   --wallet <dir>     the wallet folder (default ~/.xmr721/wallet); back it up, its keys are in it
//   --network <name>   mainnet (default) or stagenet
//   --node <url>       your Monero node (default http://127.0.0.1:18081, on stagenet :38081); the wallet takes its
//                      decoys from it and sends through it
//   --reader <url>     an XMR721 reader (default https://api.xmr20.org/xmr721 on mainnet; or run your own)
//   --domain <hex>     the ledger's domain; needed on stagenet, fixed on mainnet
//   --carrier <path>   the carrier tool (default reader/bin/mordinals-carrier; build it with sh reader/carrier/build.sh)
//   --max-fee <xmr>    the highest network fee one transaction may pay (default 0.005)
//   --help             this text
import {existsSync,readFileSync,statSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {createCarrier} from '../reader/lib/relay.mjs';
import {createChain} from '../reader/lib/chain.mjs';
import {MAX_RECORD} from '../rules/lib/records.mjs';
import {openWallet,readerAt,typeOf,clean} from './lib/wallet.mjs';

const HERE=import.meta.dirname;
// The header of this file is the help text.
const HELP=readFileSync(import.meta.filename,'utf8').split('\n').slice(1).filter((l,i,all)=>all.slice(0,i+1).every(x=>x.startsWith('//'))).map(l=>l.slice(3)).join('\n');
const stop=(text,code=2)=>{console.error(clean(text,2000));process.exit(code);};
// What is printed is made safe to print, whatever a reader or a node put into it.
const safe=v=>typeof v==='string'?clean(v,4000):Array.isArray(v)?v.map(safe):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[clean(k,80),safe(x)])):v;
const show=v=>console.log(JSON.stringify(safe(v),null,1));

// Options are "--name value"; flags stand alone. Anything else that begins with "--" is refused, not skipped, and a
// value does not begin with "--" (a forgotten value would otherwise swallow the next option).
const VALUES=new Set(['wallet','network','node','reader','domain','carrier','max-fee','file','type','name','to','collection','edition','max','height']),FLAGS=new Set(['dry-run','help']);
// Which options a command takes beside the ones every command takes, and how many words follow it.
const COMMANDS={create:[],receive:[],balance:[],split:[],inscribe:['file','type','name','to','collection','edition','dry-run'],collection:['name','max','dry-run'],send:['dry-run'],inscriptions:[],resend:[],forget:[],rescan:[],restore:['height']};
const WORDS={split:['xmr721 wallet split <n>',1],send:['xmr721 wallet send <nft id> <address>',2],forget:['xmr721 wallet forget <n>',1]};
const EVERY=['wallet','network','node','reader','domain','carrier','max-fee','help'];
function parse(argv){
 const options=new Map(),words=[];
 for(let i=0;i<argv.length;i++){const a=argv[i];
  if(!a.startsWith('--')){words.push(a);continue;}
  if(a.includes('='))stop(`Write "${a.split('=')[0]} <value>", with a space instead of "=".`);
  const name=a.slice(2);
  if(options.has(name))stop(`--${name} is given twice.`);
  if(FLAGS.has(name)){options.set(name,true);continue;}
  if(!VALUES.has(name))stop(`There is no option --${name}. See: xmr721 --help`);
  if(i+1>=argv.length||argv[i+1].startsWith('--'))stop(`--${name} needs a value.`);
  options.set(name,argv[++i]);}
 return {options,words};}
const {options,words}=parse(process.argv.slice(2));
if(options.has('help')||!words.length){console.log(HELP);process.exit(options.has('help')?0:2);}
if(words[0]!=='wallet'||!Object.hasOwn(COMMANDS,words[1]??''))stop('xmr721 wallet <create | receive | balance | split | inscribe | collection | send | inscriptions | resend | forget | rescan | restore>. See: xmr721 --help');
const command=words[1],rest=words.slice(2);
for(const name of options.keys())if(!EVERY.includes(name)&&!COMMANDS[command].includes(name))stop(`"wallet ${command}" takes no --${name}.`);
if(rest.length!==(WORDS[command]?.[1]??0))stop(WORDS[command]?.[0]??`"wallet ${command}" takes no "${rest[0]}".`);
const opt=name=>options.get(name)??null,text=name=>{const v=opt(name);if(v==='')stop(`--${name} is empty.`);return v;};
const whole=(v,what)=>{if(!/^[1-9][0-9]{0,9}$/.test(v??''))stop(what+' is a whole number.');return Number(v);};

const network=text('network')||'mainnet';if(!['mainnet','stagenet'].includes(network))stop('--network is mainnet or stagenet.');
const dir=resolve(text('wallet')||join(homedir(),'.xmr721','wallet')),node=text('node')||(network==='mainnet'?'http://127.0.0.1:18081':'http://127.0.0.1:38081');
const dry=options.has('dry-run');
// What the command is asked to do, checked before anything else is looked at.
const asked={};
if(command==='split'){asked.n=whole(rest[0],'The number of coins');if(asked.n<2||asked.n>14)stop('Split into 2 to 14 coins.');}
if(command==='restore')asked.height=whole(opt('height'),'--height');
if(command==='collection'){asked.name=text('name');if(!asked.name)stop('Give --name <text>.');asked.max=whole(opt('max'),'--max');}
if(command==='inscribe'){const file=text('file');if(!file)stop('Give --file <path>.');if(!existsSync(file)||!statSync(file).isFile())stop('There is no file at '+file+'.');
 if(statSync(file).size>MAX_RECORD)stop(`The file is ${statSync(file).size} bytes. A record is at most ${MAX_RECORD} bytes with everything in it: 824 bytes of content at most, less with --to and a name.`);
 if(opt('edition')!=null&&opt('collection')==null)stop('--edition goes with --collection.');
 let type;try{type=typeOf(file,opt('type'));}catch(e){stop(e.message);}
 Object.assign(asked,{file,type,name:opt('name')??'',to:text('to'),collection:text('collection'),edition:opt('edition')==null?null:whole(opt('edition'),'--edition')});}
// The wallet folder, before any reader or node is asked anything.
const has=f=>existsSync(join(dir,f));
let settings=null;
if(has('wallet.json')){try{settings=JSON.parse(readFileSync(join(dir,'wallet.json'),'utf8'));}catch{settings=null;}
 if(!settings||!['mainnet','stagenet'].includes(settings.network)||!Number.isSafeInteger(settings.start)||settings.start<1){settings=null;
  if(command!=='restore')stop(`${join(dir,'wallet.json')} is not readable. Write it again with: xmr721 wallet restore --height <the block to scan from>`);}
 else if(command==='restore')stop('This wallet has its wallet.json already.');
 else if(settings.network!==network)stop(`This wallet is for ${settings.network}; add --network ${settings.network}.`);}
else if(has('carrier.keys.json')&&command!=='restore')stop('The wallet folder has keys and no wallet.json. Say which block to scan from: xmr721 wallet restore --height <n> (a block before the wallet first received anything).');
if(command==='create'){if(has('carrier.keys.json'))stop('There is a wallet in '+dir+' already.');}
else if(!has('carrier.keys.json'))stop(command==='restore'?'There are no wallet keys in '+dir+'.':'There is no wallet in '+dir+'. Make one with: xmr721 wallet create');
// A reader is asked by the commands that look at the ledger, and only by them.
const needsReader=['inscribe','collection','send','inscriptions','resend','rescan'].includes(command);
const readerUrl=text('reader')||(network==='mainnet'?'https://api.xmr20.org/xmr721':null);if(needsReader&&!readerUrl)stop('On stagenet, give --reader <url> of your own reader.');
const domain=text('domain');if(domain&&!/^[0-9a-f]{64}$/.test(domain))stop('--domain is 64 hex characters.');
if(network!=='mainnet'&&!domain&&['inscribe','collection','send'].includes(command))stop('On stagenet, give --domain <hex>: the domain of the ledger to inscribe on.');
// The network fee limit is always this program's: --max-fee, or 0.005 XMR. An amount is digits with a decimal point.
let limit=5_000_000_000n;
if(opt('max-fee')!=null){const m=/^([0-9]{1,3})(?:\.([0-9]{1,12}))?$/.exec(opt('max-fee'));if(!m)stop('--max-fee is an amount of XMR with a decimal point, like 0.02.');
 limit=BigInt(m[1])*10n**12n+BigInt((m[2]||'').padEnd(12,'0'));if(limit<=0n||limit>10n**12n)stop('--max-fee is above 0 and at most 1 XMR.');}
process.env.MORDINALS_MAX_FEE=limit.toString();delete process.env.MORDINALS_SPLIT_COIN;
// The carrier tool sends on mainnet only when its own environment says so: running this command on mainnet is that.
if(network==='mainnet')process.env.MORDINALS_MAINNET='1';else delete process.env.MORDINALS_MAINNET;
const usesCarrier=['create','balance','split','resend','rescan'].includes(command)||(['inscribe','collection','send'].includes(command)&&!dry);
const bin=resolve(text('carrier')||join(HERE,'..','reader','bin','mordinals-carrier'));
if(usesCarrier&&!existsSync(bin))stop(`The carrier tool is not at ${bin}. Build it with: sh reader/carrier/build.sh (needs Rust), or give --carrier <path>.`);
// The node as the wallet needs it: on the wallet's network, and synchronized.
async function nodeTip(){
 let i;try{const r=await fetch(node.replace(/\/$/,'')+'/json_rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'0',method:'get_info'}),signal:AbortSignal.timeout(30000)});i=(await r.json()).result;}
 catch(e){stop(`The Monero node at ${node} does not answer (${e?.cause?.code||e?.message}). Give --node <url> of your own node.`);}
 if(!i||typeof i.nettype!=='string')stop('The Monero node gave no information.');
 if(i.nettype!==network)stop(`The node at ${node} is a ${i.nettype} node; this wallet is for ${network}.`);
 if(i.synchronized===false||i.busy_syncing===true)stop('The Monero node is still synchronizing. Try again when it is done.');
 if(!Number.isSafeInteger(i.height)||i.height<2)stop('The Monero node gave no height.');return i.height-1;}
// A stop signal while a transaction is in hand: the command finishes what it began, writes it down, and then stops.
let stopping=false;for(const s of ['SIGINT','SIGTERM'])process.on(s,()=>{if(!stopping)console.error('Finishing the step in hand before stopping, so that nothing is left half done…');stopping=true;});

try{
 // A wallet that was not used for a while reads many blocks before it answers: the tool is given hours, not minutes.
 const carrier=createCarrier({bin,stateDir:dir,node,network,start:settings?.start??1,timeout:6*3600*1000}),chain=createChain(node);
 const wallet=openWallet({dir,carrier,reader:readerUrl?readerAt(readerUrl):null,chain,network,domain});
 if(command!=='create')wallet.tighten();
 switch(command){
  case 'create':{const made=await wallet.create({height:await nodeTip()});show({...made,wallet:dir});
   console.error(`\nThe wallet pays the network fee of each inscription from its own coins. Send it XMR in one payment (0.05 XMR is plenty to begin with).\nBack up the folder ${dir}: it holds the wallet's keys and nothing else can restore it.`);break;}
  case 'restore':writeFileSync(join(dir,'wallet.json'),JSON.stringify({network,start:asked.height})+'\n',{mode:0o600});wallet.tighten();show({address:wallet.address,wallet:dir,start:asked.height});
   console.error('\nIf the wallet was used before with another start block, run: xmr721 wallet rescan');break;
  case 'receive':show({address:wallet.address});break;
  case 'balance':console.error('Reading the blocks since the wallet was last used…');show(await wallet.balance());break;
  case 'split':show(await wallet.split(asked.n));break;
  case 'inscribe':show(await wallet.inscribe({content:readFileSync(asked.file),type:asked.type,name:asked.name,to:asked.to,collection:asked.collection,edition:asked.edition,dryRun:dry}));break;
  case 'collection':show(await wallet.collection({name:asked.name,max:asked.max,dryRun:dry}));break;
  case 'send':show(await wallet.send({nft:rest[0],to:rest[1],dryRun:dry}));break;
  case 'inscriptions':show(await wallet.inscriptions());break;
  case 'resend':{const out=await wallet.resend();show(out);if(out.some(r=>r.failed))process.exitCode=1;break;}
  case 'forget':show(await wallet.forget(rest[0]));console.error('\nGiven up. If its coin is to be used again, run: xmr721 wallet rescan');break;
  case 'rescan':console.error('Reading every block since the wallet\'s start block…');show(await wallet.rescan());break;}
 if(stopping)process.exit(130);
}catch(e){stop(e?.message||e,stopping?130:2);}
