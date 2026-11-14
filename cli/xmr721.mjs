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
//   xmr721 wallet resend                         hands the node, as they are, the kept transactions it does not have
//   xmr721 wallet forget <n>                     takes an entry off the list (its number in "inscriptions"): a transaction
//                                                that was never sent, or one the chain settled 100 blocks ago. A
//                                                transaction that was sent cannot be taken back and stays on the list
//   xmr721 wallet rescan                         reads the wallet's coins anew; frees coins of transactions that never got in
//   xmr721 wallet restore --height <n>           the block the wallet's scan starts at (for a folder that has only its keys)
//
// Options for every command, each written as "--name value":
//   --wallet <dir>     the wallet folder (default ~/.xmr721/wallet); back it up, its keys are in it
//   --network <name>   mainnet (default) or stagenet
//   --node <url>       your Monero node (default http://127.0.0.1:18081, on stagenet :38081); the wallet takes its
//                      decoys from it and sends through it
//   --reader <url>     an XMR721 reader (default https://api.xmr20.org/xmr721 on mainnet; or run your own)
//   --domain <hex>     the ledger's domain; needed on stagenet to inscribe or send, fixed on mainnet
//   --carrier <path>   the carrier tool (default reader/bin/mordinals-carrier; build it with sh reader/carrier/build.sh)
//   --max-fee <xmr>    the highest network fee one transaction may pay (default 0.005)
//   --help             this text
import {existsSync,readFileSync,statSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {createChain} from '../reader/lib/chain.mjs';
import {MAX_RECORD} from '../rules/lib/records.mjs';
import {openWallet,readerAt,typeOf} from './lib/wallet.mjs';
import {createTool} from './lib/tool.mjs';
import {openLock} from './lib/lock.mjs';
import {clean,plain,ascii} from './lib/text.mjs';

const HERE=import.meta.dirname;
// The header of this file is the help text.
const HELP=readFileSync(import.meta.filename,'utf8').split('\n').slice(1).filter((l,i,all)=>all.slice(0,i+1).every(x=>x.startsWith('//'))).map(l=>l.slice(3)).join('\n');
// What is printed is made safe to print. Text from a reader, a node or the tool is cut down to printable ASCII where it
// is taken in (cli/lib/text.mjs); here, a message loses what steers a terminal or cannot be seen, and a result is
// printed as JSON in printable ASCII.
const stop=(text,code=2)=>{console.error(plain(text));process.exit(code);};
const show=v=>console.log(ascii(JSON.stringify(v,null,1)));

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
const whole=(v,what)=>{if(!/^[1-9][0-9]{0,9}$/.test(v??''))stop(what+' is a whole number, 1 or more.');return Number(v);};

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
if(existsSync(dir)&&!statSync(dir).isDirectory())stop(`${dir} is a file, not a wallet folder.`);
const has=f=>existsSync(join(dir,f));
let settings=null;
if(has('wallet.json')){try{settings=JSON.parse(readFileSync(join(dir,'wallet.json'),'utf8'));}catch{settings=null;}
 if(!settings||!['mainnet','stagenet'].includes(settings.network)||!Number.isSafeInteger(settings.start)||settings.start<1){settings=null;
  if(command!=='restore')stop(`${join(dir,'wallet.json')} is not readable. Write it again with: xmr721 wallet restore --height <the block to scan from>`);}
 else if(settings.network!==network)stop(`This wallet is for ${settings.network}; add --network ${settings.network}.`);}
else if(has('carrier.keys.json')&&command!=='restore')stop('The wallet folder has keys and no wallet.json. Say which block to scan from: xmr721 wallet restore --height <n> (a block before the wallet first received anything).');
if(command==='create'){if(has('carrier.keys.json'))stop('There is a wallet in '+dir+' already.');}
else if(!has('carrier.keys.json'))stop(command==='restore'?'There are no wallet keys in '+dir+'.':'There is no wallet in '+dir+'. Make one with: xmr721 wallet create');
// A folder whose wallet.json does not say which network the wallet is for is not taken to be a mainnet wallet.
if(command==='restore'&&!settings&&!options.has('network'))stop('Say which network this wallet is for: add --network mainnet or --network stagenet.');
// The commands that make a record need a reader and the ledger's domain. The others ask a reader, when one is given,
// what the ledger made of the wallet's records, and go by the node alone without one.
const makes=['inscribe','collection','send'].includes(command),looks=['inscriptions','resend','forget','rescan','restore'].includes(command);
const readerUrl=makes||looks?text('reader')||(network==='mainnet'?'https://api.xmr20.org/xmr721':null):null;if(makes&&!readerUrl)stop('On stagenet, give --reader <url> of your own reader.');
const domain=text('domain');if(domain&&!/^[0-9a-f]{64}$/.test(domain))stop('--domain is 64 hex characters.');
if(network!=='mainnet'&&!domain&&makes)stop('On stagenet, give --domain <hex>: the domain of the ledger to inscribe on.');
// The network fee limit is always this program's: --max-fee, or 0.005 XMR. An amount is digits with a decimal point.
let limit=5_000_000_000n;
if(opt('max-fee')!=null){const m=/^([0-9]{1,3})(?:\.([0-9]{1,12}))?$/.exec(opt('max-fee'));if(!m)stop('--max-fee is an amount of XMR with a decimal point, like 0.02.');
 limit=BigInt(m[1])*10n**12n+BigInt((m[2]||'').padEnd(12,'0'));if(limit<=0n||limit>10n**12n)stop('--max-fee is above 0 and at most 1 XMR.');}
process.env.MORDINALS_MAX_FEE=limit.toString();delete process.env.MORDINALS_SPLIT_COIN;
// The carrier tool sends on mainnet only when its own environment says so: running this command on mainnet is that.
if(network==='mainnet')process.env.MORDINALS_MAINNET='1';else delete process.env.MORDINALS_MAINNET;
const usesCarrier=['create','balance','split','rescan'].includes(command)||(makes&&!dry);
const bin=resolve(text('carrier')||join(HERE,'..','reader','bin','mordinals-carrier'));
if(usesCarrier&&!(existsSync(bin)&&statSync(bin).isFile()))stop(`The carrier tool is not at ${bin}. Build it with: sh reader/carrier/build.sh (needs Rust), or give --carrier <path>.`);
// The node as the wallet needs it: on the wallet's network, and synchronized.
async function nodeTip(){
 let i;try{const r=await fetch(node.replace(/\/$/,'')+'/json_rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'0',method:'get_info'}),signal:AbortSignal.timeout(30000)});i=(await r.json()).result;}
 catch(e){stop(`The Monero node at ${node} does not answer (${clean(e?.cause?.code||e?.message,80)}). Give --node <url> of your own node.`);}
 if(!i||typeof i.nettype!=='string')stop('The Monero node gave no information.');
 if(i.nettype!==network)stop(`The node at ${node} is a ${clean(i.nettype,20)} node; this wallet is for ${network}.`);
 if(i.synchronized===false||i.busy_syncing===true)stop('The Monero node is still synchronizing. Try again when it is done.');
 if(!Number.isSafeInteger(i.height)||i.height<2)stop('The Monero node gave no height.');return i.height-1;}
// The tool runs apart from the terminal (cli/lib/tool.mjs), so a stop signal (Ctrl-C, a closed terminal) reaches this
// program only. It stops the command at once and ends the tool, unless a transaction is in hand at that moment: being
// built by the tool, or being handed to the node. Then that one step is finished and written down first, and the
// command stops after it; nothing further is begun. A third signal stops at once all the same: what became of the
// transaction is then found out by the next command.
// (An output that can no longer be written to, a closed terminal or a pipe whose reader is gone, must not end the
// command in the middle of that step: what cannot be printed is dropped.)
for(const out of [process.stdout,process.stderr])out.on('error',()=>{});
// The block the scan starts at is read when the tool is run, under the wallet's lock: another command may have set it.
const startNow=()=>{try{const v=JSON.parse(readFileSync(join(dir,'wallet.json'),'utf8')).start;if(Number.isSafeInteger(v)&&v>=1)return v;}catch{}return settings?.start??1;};
const lock=openLock(dir),tool=createTool({bin,stateDir:dir,node,network,start:startNow,lock});
let inHand=false,signals=0;
for(const s of ['SIGINT','SIGTERM','SIGHUP'])process.on(s,()=>{signals++;
 if(!inHand||signals>=3){tool.stop();process.exit(130);}
 console.error(signals===1?'A transaction is in hand: finishing this one step and writing it down, then stopping. (Twice more stops at once.)':'Still finishing that step.');});
const hand=on=>{inHand=on;if(!on&&signals)process.exit(130);};

try{
 const wallet=openWallet({dir,carrier:tool,reader:readerUrl?readerAt(readerUrl):null,chain:createChain(node),network,nettype:network,domain,lock,inHand:hand,warn:t=>console.error('Note: '+plain(t,600))});
 const told=()=>{for(const n of wallet.notes())console.error('Note: '+plain(n,600));};
 if(command!=='create')wallet.tighten();
 switch(command){
  case 'create':{const made=await wallet.create({height:await nodeTip()});show({...made,wallet:dir});
   console.error('The wallet pays the network fee of each inscription from its own coins. Send it XMR in one payment (0.05 XMR is plenty to begin with).');
   console.error(plain(`Back up the folder ${dir}: it holds the wallet's keys and nothing else can restore it.`));break;}
  case 'restore':show({...await wallet.restore(asked.height),wallet:dir});wallet.tighten();
   console.error('The wallet reads its coins anew from that block at the next command.');break;
  case 'receive':show({address:wallet.address});break;
  case 'balance':console.error('Reading the blocks since the wallet was last used…');show(await wallet.balance());break;
  case 'split':show(await wallet.split(asked.n));break;
  case 'inscribe':show(await wallet.inscribe({content:readFileSync(asked.file),type:asked.type,name:asked.name,to:asked.to,collection:asked.collection,edition:asked.edition,dryRun:dry}));break;
  case 'collection':show(await wallet.collection({name:asked.name,max:asked.max,dryRun:dry}));break;
  case 'send':show(await wallet.send({nft:rest[0],to:rest[1],dryRun:dry}));break;
  case 'inscriptions':show(await wallet.inscriptions());break;
  case 'resend':{const out=await wallet.resend();show(out);if(out.some(r=>r.failed))process.exitCode=1;break;}
  case 'forget':show(await wallet.forget(rest[0]));break;
  case 'rescan':console.error('Reading every block since the wallet\'s start block…');show(await wallet.rescan());break;}
 told();
}catch(e){try{if(has('journal.json'))for(const n of JSON.parse(readFileSync(join(dir,'journal.json'),'utf8')).notes||[])console.error('Note: '+plain(n,600));}catch{}stop(e?.message||e,2);}
