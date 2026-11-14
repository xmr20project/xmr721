#!/usr/bin/env node
// xmr721: inscribe on Monero from a wallet of your own (README.md, "Inscribe").
//
//   xmr721 wallet create                         a new wallet; prints its address (send it some XMR)
//   xmr721 wallet receive                        the wallet's address
//   xmr721 wallet balance                        its balance and how many coins can pay right now
//   xmr721 wallet split <n>                      makes n coins of 0.01 XMR, so n records can go out in one block
//   xmr721 wallet inscribe --file <path> [--type <type>] [--name <text>] [--to <address>]
//                          [--collection <id> [--edition <n>]] [--dry-run]
//                                                one NFT; with --collection, an edition of one of the wallet's collections
//   xmr721 wallet collection --name <text> --max <n> [--dry-run]
//                                                a collection whose editions only this wallet mints
//   xmr721 wallet send <nft id> <address> [--dry-run]
//                                                sends an NFT the wallet owns
//   xmr721 wallet inscriptions                   what the wallet sent, and where each record is now
//
// Options for every command:
//   --wallet <dir>     the wallet folder (default ~/.xmr721/wallet); back it up, its keys are in it
//   --node <url>       your Monero node (default http://127.0.0.1:18081); the wallet takes decoys and sends through it
//   --reader <url>     an XMR721 reader (default https://api.xmr20.org/xmr721, or run your own)
//   --network <name>   mainnet (default) or stagenet
//   --carrier <path>   the carrier tool (default reader/bin/mordinals-carrier; build it with sh reader/carrier/build.sh)
//   --max-fee <xmr>    the highest network fee one transaction may pay (default 0.05)
import {existsSync,readFileSync,statSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {createCarrier} from '../reader/lib/relay.mjs';
import {createChain} from '../reader/lib/chain.mjs';
import {parseXmr,MAX_RECORD} from '../rules/lib/records.mjs';
import {openWallet,readerAt,typeOf} from './lib/wallet.mjs';

const HERE=import.meta.dirname,args=process.argv.slice(2);
const FLAGS=new Set(['--dry-run','--help']);
const opt=name=>{const i=args.indexOf('--'+name);return i<0?null:args[i+1]??null;},has=name=>args.includes('--'+name);
const words=args.filter((a,i)=>!a.startsWith('--')&&!(i>0&&args[i-1].startsWith('--')&&!FLAGS.has(args[i-1])));
const stop=text=>{console.error(text);process.exit(2);};
const usage=()=>stop(readFileSync(import.meta.filename,'utf8').split('\n').slice(1).filter(l=>l.startsWith('//')).map(l=>l.slice(3)).join('\n'));

if(words[0]!=='wallet'||has('help')||!words[1])usage();
const network=opt('network')||'mainnet';if(!['mainnet','stagenet'].includes(network))stop('--network is mainnet or stagenet.');
const dir=resolve(opt('wallet')||join(homedir(),'.xmr721','wallet')),node=opt('node')||'http://127.0.0.1:18081',bin=resolve(opt('carrier')||join(HERE,'..','reader','bin','mordinals-carrier'));
const settings=existsSync(join(dir,'wallet.json'))?JSON.parse(readFileSync(join(dir,'wallet.json'),'utf8')):null;
if(settings&&settings.network!==network)stop(`This wallet is for ${settings.network}; add --network ${settings.network}.`);
if(!existsSync(bin))stop(`The carrier tool is not at ${bin}. Build it with: sh reader/carrier/build.sh (needs Rust), or give --carrier <path>.`);
// The carrier tool sends on mainnet only when told so by its own environment: running this command on mainnet is that.
if(network==='mainnet')process.env.MORDINALS_MAINNET='1';
if(opt('max-fee')){try{process.env.MORDINALS_MAX_FEE=parseXmr(opt('max-fee')).toString();}catch{stop('--max-fee is an amount of XMR, like 0.02.');}}
const carrier=createCarrier({bin,stateDir:dir,node,network,start:settings?.start??1}),reader=readerAt(opt('reader')||'https://api.xmr20.org/xmr721');
const wallet=openWallet({dir,carrier,reader,network}),show=v=>console.log(JSON.stringify(v,null,1));

try{
 switch(words[1]){
  case 'create':{const tip=(await createChain(node).info()).height;const made=await wallet.create({height:tip});
   show({...made,wallet:dir});console.error(`\nSend some XMR to ${made.address}. Back up the folder ${dir}: the wallet's keys are in carrier.keys.json, and nothing else can restore it.`);break;}
  case 'receive':show({address:wallet.address});break;
  case 'balance':show(await wallet.balance());break;
  case 'split':show(await wallet.split(Number(words[2])));break;
  case 'inscribe':{const file=opt('file');if(!file)stop('Give --file <path>.');if(!existsSync(file)||!statSync(file).isFile())stop('There is no file at '+file+'.');
   if(statSync(file).size>MAX_RECORD)stop(`The file is ${statSync(file).size} bytes; a record is at most ${MAX_RECORD} bytes with everything else in it.`);
   const edition=opt('edition')==null?null:Number(opt('edition'));
   show(await wallet.inscribe({content:readFileSync(file),type:typeOf(file,opt('type')),name:opt('name')??'',to:opt('to'),collection:opt('collection'),edition,dryRun:has('dry-run')}));break;}
  case 'collection':{const name=opt('name'),max=Number(opt('max'));if(!name)stop('Give --name <text>.');show(await wallet.collection({name,max,dryRun:has('dry-run')}));break;}
  case 'send':{if(!words[2]||!words[3])stop('Give the NFT id and the address: xmr721 wallet send <nft id> <address>');show(await wallet.send({nft:words[2],to:words[3],dryRun:has('dry-run')}));break;}
  case 'inscriptions':show(await wallet.inscriptions());break;
  default:usage();}
}catch(e){stop(String(e?.message||e));}
