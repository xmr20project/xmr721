#!/usr/bin/env node
// xmr20: create and mint open XMR20 tokens on Monero from a wallet of your own (xmr20-tokens/OPEN.md).
//
//   xmr20 create                                 a new wallet; prints its address
//   xmr20 receive                                the wallet's address
//   xmr20 balance                                its XMR balance and how many coins can pay right now
//   xmr20 split <n>                              makes n coins of 0.01 XMR (2 to 14) from one larger coin, so n records
//                                                can go out in one block
//   xmr20 deploy --tick <ticker> --max <supply> [--lim <most per mint>] [--pre <creator's share>]
//                [--token-name <text>] [--dry-run]
//                                                a new token: anyone mints it, up to --lim at a time; --pre goes to
//                                                this wallet's address at once (with --pre equal to --max, all of it,
//                                                and there is no --lim). Whole tokens. Prints the token's id
//   xmr20 mint <token id> <amount> [--to <address>] [--dry-run]
//                                                mints a token to this wallet's address or to another one; the token
//                                                by its id or the 16 characters shown after its ticker
//   xmr20 sign "<message>" | --file <path>       signs a message with the wallet's address, as Feather and Cake Wallet
//                                                do: to move tokens (xmr20.org/move) or list and buy lots
//                                                (xmr20.org/market) paste the page's message here, in quotes, and paste
//                                                the signature back. Read the message first: its signature does what
//                                                it says
//   xmr20 status                                 what the wallet sent, and where each transaction is now
//   xmr20 resend                                 hands the node, as they are, the kept transactions it does not have
//   xmr20 forget <n>                             takes an entry off the list (its number in "status")
//   xmr20 rescan                                 reads the wallet's coins anew
//   xmr20 restore --height <n>                   the block the wallet's scan starts at (for a folder that has only its keys)
//
// Options for every command, each written as "--name value":
//   --wallet <dir>     the wallet folder (default ~/.xmr721/wallet); back it up, its keys are in it
//   --network <name>   mainnet (default) or stagenet
//   --node <url>       your Monero node (default http://127.0.0.1:18081, on stagenet :38081)
//   --reader <url>     a reader of the ledger (default https://api.xmr20.org/xmr721 on mainnet; or run your own)
//   --domain <hex>     the ledger's domain; needed on stagenet, fixed on mainnet
//   --carrier <path>   the carrier tool (default reader/bin/mordinals-carrier; build it with sh reader/carrier/build.sh)
//   --max-fee <xmr>    the highest network fee one transaction may pay (default 0.005)
//   --help             this text
//
// A token is announced by an inscription on the XMR721 ledger, so this command runs the xmr721 wallet (cli/xmr721.mjs)
// with the same wallet folder: "xmr20 deploy" is "xmr721 wallet deploy", and so on. Moving and trading tokens is done by
// signing a message that xmr20.org/move or xmr20.org/market writes: "xmr20 sign" signs it with this wallet.
import {readFileSync} from 'node:fs';

const HELP=readFileSync(import.meta.filename,'utf8').split('\n').slice(1).filter((l,i,all)=>all.slice(0,i+1).every(x=>x.startsWith('//'))).map(l=>l.slice(3)).join('\n');
// xmr20's commands and the xmr721 wallet command each one runs.
const COMMANDS={create:'create',receive:'receive',balance:'balance',split:'split',deploy:'deploy',mint:'mint',sign:'sign',status:'inscriptions',resend:'resend',forget:'forget',rescan:'rescan',restore:'restore'};
// The command is the first word that is not an option or an option's value (flags take none).
const argv=process.argv.slice(2);let at=-1;
for(let i=0;i<argv.length;i++){if(!argv[i].startsWith('--')){at=i;break;}if(!['--dry-run','--help'].includes(argv[i])&&!argv[i].includes('='))i++;}
const first=at<0?null:argv[at];
if(argv.includes('--help')||!argv.length){console.log(HELP);process.exit(argv.includes('--help')?0:2);}
if(first===null||!Object.hasOwn(COMMANDS,first)){console.error('xmr20 <'+Object.keys(COMMANDS).join(' | ')+'>. See: xmr20 --help');process.exit(2);}
if(argv.includes('--col')){console.error('"deploy" takes no --col.');process.exit(2);}
// The xmr721 wallet runs in this process (so a stop signal reaches it once, as when it is run by its own name).
process.argv=[process.argv[0],process.argv[1],...argv.slice(0,at),'wallet',COMMANDS[first],...argv.slice(at+1)];
// What it prints names its own commands; here they are named as this command has them.
const named=s=>s.replaceAll('xmr721 wallet inscriptions','xmr20 status').replaceAll('"wallet inscriptions"','"status"').replaceAll('xmr721 wallet ','xmr20 ').replace(/"wallet ([a-z]+)"/g,'"$1"').replaceAll('xmr721 --help','xmr20 --help');
for(const out of [process.stdout,process.stderr]){const write=out.write.bind(out);out.write=(chunk,...more)=>write(typeof chunk==='string'?named(chunk):chunk,...more);}
await import('./xmr721.mjs');
