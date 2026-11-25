// The Mordinals reader service: follows a Monero node, keeps the record journal (lib/reader.mjs), answers wallets and
// the explorer pages, and - when it is given a carrier wallet - relays signed records to the chain (lib/relay.mjs).
// It listens on 127.0.0.1 only. It holds no user key. Everything it answers can be rebuilt by anyone from the owner
// list and the chain with this same code.
//
//   node service.mjs --ledger mainnet --node <url> --state <dir>   the mainnet ledger: every setting of RULES.md section 13 is filled in
//        (rules/lib/mainnet.mjs) and none of them may be given beside it; or, for a ledger of one's own (a test chain, stagenet):
//   node service.mjs --owners <owners.jsonl> --domain <hex32> --fee-address <address> --node <url> --start <height> --state <dir>
//        [--start-hash <hash>] [--network mainnet|stagenet] [--port 18951] [--every <ms>] [--transfers <transfers.jsonl>] [--block-times <file>] [--groups <collections.json>]
//        [--mint-from <height> [--minters <address>,… [--open-from <height>]]]   the ledger's first mint block, and who may mint (everyone when no list is
//                                                   given; with --open-from everyone from that block on); part of the ledger's setup
//        [--burn-from <height> [--burn-dead <index>,… (fifteen)] [--burn-fee-wallet <main address>:<secret view key>]]   from that block a
//                                                   Mordinal is claimed by burning it (RULES.md section 10) and 720 blocks later claim records stop;
//                                                   the dead outputs and the fee wallet are mainnet's (the project's), and other ones can be named
//                                                   only on the offline test chain or another network; part of the ledger's setup
//        (a new or changed --burn-from of an existing state folder has to lie at least 10 blocks above the newest block of the folder and of the node)
//        [--spend-from <height>]   with --burn-from (at or after it): from that block a claim record may show a spent owner coin (proof 2, RULES.md
//                                                   section 11); part of the ledger's setup. A folder that has not read that block yet takes it in
//                                                   (it has to lie at least 10 blocks above the newest block of the folder and of the node).
//        [--carrier-bin <path> --carrier-state <dir> --carrier-network offline-fakechain|stagenet|mainnet [--carrier-start <height>] [--relay-limits name=n,…]]   relay on (mainnet also needs MORDINALS_MAINNET=1)
//        [--mint-fee <atomic units> --collection-fee <atomic units>]   what this relay charges to carry a mint or a collection record
//        [--token-mint-fee <atomic units>]   what this relay charges to carry a mint of an open XMR20 token (with --xmr20-open-from; without it the relay carries none)
//        [--content-dir <dir> | --content-archive [url]] [--collections <dir>] [--views <dir>] [--allow-origin <origin>] [--allow-extension <id>] [--behind-proxy] [--test-hooks]
//        [--xmr20-inscribers <address>,…]   list the XMR20 tokens these addresses inscribed (xmr20-tokens/FORMAT.md)
//        [--xmr20-open-from <block>]   list the open XMR20 tokens deployed from this block on (xmr20-tokens/OPEN.md, draft)
//        [--xmr20-earlier <dir> | --no-xmr20-earlier]   the earlier XMR20 deploy inscriptions (xmr20-tokens/EARLIER.md); the list this repository ships is served unless another is named
//        [--no-xmr20-follow]   do not read the earlier formats on in the blocks this reader follows (lib/earlier.mjs): serve the shipped list and the saved collections as they are
//
// Lists are served whole (the owner list in pieces, every claimed number), so a wallet never has to name the
// Mordinals it holds before it claims them.
import {createServer} from 'node:http';
import {existsSync,readFileSync,statSync} from 'node:fs';
import {join,normalize,extname,sep} from 'node:path';
import {RULES,NO_COLLECTION,heldUntil,canonical,decodeRecord} from '../rules/lib/records.mjs';
import {BURN,CLAIM_PREFIX,isMainnetDead} from '../rules/lib/burn.mjs';
import {feeWallet,isProjectFeeWallet} from '../rules/lib/burn-fee.mjs';
import {mainnetOptions} from '../rules/lib/mainnet.mjs';
import {createChain} from './lib/chain.mjs';
import {openReader} from './lib/reader.mjs';
import {createRelay,createCarrier} from './lib/relay.mjs';
import {createContent,dirContent,archiveContent,pictureType} from './lib/content.mjs';
import {createDrawer} from './lib/draw.mjs';
import {served,readOwners} from './lib/owners.mjs';
import {loadCollections} from '../xmr20-nfts/lib/collection.mjs';
import {projectDeploys,TYPE_JSON} from '../xmr20-tokens/lib/token.mjs';
import {loadEarlier,canonical as earlierText} from '../xmr20-tokens/lib/earlier.mjs';
import {openDeployIn,projectOpen,prepareOpenDeploy,finishOpenDeploy,ID_SHOWN} from '../xmr20-tokens/lib/open.mjs';
import {openFollower} from './lib/follow.mjs';
import {picker,earlierTokens,collectionOwners,NAME as EARLIER_NAME} from './lib/earlier.mjs';

const TYPES={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'};
const PAGE_CSP="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const EARLIER=join(import.meta.dirname,'..','xmr20-tokens','earlier'),VIEWS=join(import.meta.dirname,'views'),BLOCK_TIMES=join(import.meta.dirname,'..','ownership-index','result','block-times.json'),GROUPS=join(import.meta.dirname,'..','ownership-index','collections','collections.json');
const KINDS=new Set(['claim','move','list','cancel','reserve','sale','collection','mint','burn']);
const fail=(message,status=400)=>{const e=Error(message);e.status=status;return e;};
const isJson=bytes=>{try{JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));return true;}catch{return false;}};
const int=(v,fallback,min,max)=>{const n=v==null||v===''?NaN:Number(v);return Number.isInteger(n)?Math.min(max,Math.max(min,n)):fallback;};

export function createService({reader,relay=null,owners,transfers=[],blockTimes=null,groups=null,content=null,collections=new Map(),views=null,origins=[],extensions=null,behindProxy=false,testHooks=false,extra=null,xmr20=null,xmr20Open=null,earlier=null,follower=null,followLimit=25,followBudget=1000,chunk=4000,rate={perSecond:2,burst:60},log=()=>{}}){
 // On a ledger that claims by burning the list also gives each owner output's global index, so the hash over them can be recomputed.
 const m=reader.meta,list=owners.map(m0=>reader.meta.burnFrom!=null?{...served(m0),ownerOutputIndex:m0.ownerOutputIndex}:served(m0)),numbers=owners.map(o=>o.number),entry=new Map(owners.map(o=>[o.number,o])),byReg=new Map(owners.map(o=>[o.registrationTx,o]));
 // When the blocks of the original history were made: exact for the blocks in the list, and between two listed blocks
 // from the blocks on either side. Outside the list there is no date.
 const known=blockTimes?Object.entries(blockTimes).map(([h,t])=>[Number(h),Number(t)]).filter(([h,t])=>Number.isInteger(h)&&Number.isFinite(t)).sort((a,b)=>a[0]-b[0]):[];
 const timeAt=h=>{if(!Number.isInteger(h)||!known.length||h<known[0][0]||h>known.at(-1)[0])return null;
  let lo=0,hi=known.length-1;while(lo<hi){const mid=(lo+hi+1)>>1;if(known[mid][0]<=h)lo=mid;else hi=mid-1;}
  const [h0,t0]=known[lo];if(h0===h||lo===known.length-1)return t0;const [h1,t1]=known[lo+1];return Math.round(t0+(t1-t0)*(h-h0)/(h1-h0));};
 const old=new Map();for(const t of transfers){if(t.result!=='updated')continue;if(!old.has(t.mordinal))old.set(t.mordinal,[]);old.get(t.mordinal).push({kind:'transfer',height:t.height,time:timeAt(t.height),txid:t.tx});}
 // Collections of Mordinals (ownership-index/collections): display groups from published titles and links. They
 // decide nothing about ownership. Ranges are opened here; numbers this owner list does not have are left out.
 const groupList=[],groupOf=new Map(),labelled=new Set();
 if(groups){const open=list=>list.flatMap(x=>Array.isArray(x)?Array.from({length:x[1]-x[0]+1},(_,i)=>x[0]+i):[x]).filter(n=>entry.has(n));
  for(const g of groups.groups||[]){if(!/^[0-9a-f]{24}$/.test(g.id)||typeof g.name!=='string')continue;const members=open(g.numbers||[]);if(members.length<2)continue;
   groupList.push({id:g.id,name:g.display||g.name,fullName:g.name,basis:g.basis,named:g.named===true,members});for(const n of members)if(!groupOf.has(n))groupOf.set(n,g.id);}
  const first=new Map((groups.featured||[]).map((id,i)=>[id,i]));groupList.sort((a,b)=>(first.get(a.id)??1e9)-(first.get(b.id)??1e9)||b.members.length-a.members.length||a.name.localeCompare(b.name));
  for(const n of open(groups.sensitiveByLabel||[]))labelled.add(n);}
 const groupById=new Map(groupList.map(g=>[g.id,g]));
 // A Mordinal's name: the name of its collection when that is a real one (`named`), with "#<edition>" where the creator
 // numbered it (its list or its own title: Mordinal 2 is Monero Punks #0). An edition counts only for a member of that
 // same collection. Null outside a named collection; pages then say "Mordinal #n".
 const editionOf=new Map();
 if(groups)for(const g of groups.groups||[])if(groupById.get(g.id)&&Array.isArray(g.editions))for(const x of g.editions)
  if(Array.isArray(x)&&groupOf.get(x[0])===g.id&&Number.isSafeInteger(x[1])&&x[1]>=0&&!editionOf.has(x[0]))editionOf.set(x[0],x[1]);
 // Where the creator named each member ("Sir Fulton Brown is a distinguished citizen of The Ape Society."), its own title
 // names it instead: up to 80 printable characters, for a member of that collection only.
 const titleOf=new Map();
 if(groups)for(const g of groups.groups||[])if(groupById.get(g.id)&&Array.isArray(g.titles))for(const x of g.titles)
  if(Array.isArray(x)&&groupOf.get(x[0])===g.id&&typeof x[1]==='string'&&/^[^\x00-\x1f\x7f]{1,80}$/.test(x[1])&&x[1].trim()===x[1]&&!titleOf.has(x[0]))titleOf.set(x[0],x[1]);
 const nameOf=n=>{const g=groupById.get(groupOf.get(n));if(!g?.named)return null;const t=titleOf.get(n);if(t)return t;const e=editionOf.get(n);return e==null?g.name:`${g.name} #${e}`;};
 // The original Mordinals history, oldest first: every registration and every transfer under the 2023 rules.
 const legacy=[...owners.map(o=>({kind:'inscribed',number:o.number,height:o.registrationHeight??null,time:timeAt(o.registrationHeight),txid:o.registrationTx,size:o.bodySize??null})),
  ...[...old].flatMap(([number,list])=>list.map(t=>({...t,number})))].sort((a,b)=>(a.height??0)-(b.height??0)||a.number-b.number);
 // Answers that only change when the reader moves are kept until it does.
 let memoAt='',memo=new Map();
 const once=(key,make)=>{const at=reader.height+':'+reader.journal.length+':'+reader.hash;if(at!==memoAt){memoAt=at;memo=new Map();}if(!memo.has(key))memo.set(key,make());return memo.get(key);};
 const L=()=>reader.ledger;
 const lotView=id=>{const l=L().lot(id),r=l.reservations.at(-1)||null;
  return {id:l.id,number:l.number,name:l.number==null?null:nameOf(l.number),nft:l.number==null?l.reg:null,reg:l.reg,seller:l.seller,price:l.price.toString(),until:l.until,status:l.status,body:reader.body(l.id),
   reservation:r?{record:r.record,buyer:r.buyer,height:r.height,payBy:r.payBy,rate:r.rate}:null,buyer:l.sale?.buyer||null};};
 // A Mordinal whose burn claim, or claim by a spent coin, waits for its fee is not claimed; `waiting` says so.
 const state=n=>{const x=L().mordinal(n);return {number:x.number,name:nameOf(x.number),reg:x.reg,claimed:x.claimed,owner:x.owner,...(x.burned?{burned:true}:{}),...(x.waiting?{waiting:true}:{}),seq:x.seq,lot:x.lot?lotView(x.lot):null};};
 // A burn claim as the routes show it: the Mordinal, the address in its text, its state ('claimed', 'waiting': burned and
 // waiting for its fee, 'lost': claimed by a record first) and its fee: due (the burn's own fee), paid, missing, and the
 // Mordinal's fee address.
 const burnState=id=>{const b=L().burnClaim(id);if(!b)return null;
  return {number:b.number,to:b.to,state:b.state,...(b.claimedAt!=null?{claimedAt:b.claimedAt}:{}),fee:{due:b.due,paid:b.paid,missing:b.missing,address:L().burnFee(b.number).address}};};
// A minted NFT. `record` is its mint record, so a page can check every field against the NFT's id itself.
 const minted=id=>{const x=L().nft(id);if(!x)return null;const c=x.minted.collection===NO_COLLECTION?null:L().collection(x.minted.collection),e=reader.entryById(id);
  return {id,...x.minted,collectionName:c?.name??null,owner:x.owner,burned:Boolean(x.burned),seq:x.seq,height:e?.height??null,txid:e?.txid??null,lot:x.lot?lotView(x.lot):null};};
 const mintedIds=()=>once('minted',()=>reader.events.filter(e=>e.kind==='mint').map(e=>e.nft));
 const madeCollection=c=>({id:c.id,name:c.name,max:c.max,creator:c.creator,height:c.height,minted:c.editions.length});
 // XMR20 tokens (xmr20-tokens/FORMAT.md): the deploy inscriptions of the listed addresses, read from the minted NFTs.
 // A view of the ledger, like the collections: it changes no record and no owner.
 const contentOf=id=>decodeRecord(Buffer.from(reader.entryById(id).record,'hex'),m.network).body.content;
 // `inscription` counts every minted NFT on from the Mordinals' numbers, in ledger order: a number to show, where records use ids.
 const firstMinted=numbers.reduce((a,b)=>Math.max(a,b),-1)+1;
 // The earlier XMR20 formats (lib/earlier.mjs): the tokens' deploy inscriptions from before this ledger and the saved
 // collections' NFTs, as the shipped files hold them, read on by the follower in the blocks this reader holds where the
 // files end at its start block. Views of other formats: they change no record and no owner of this ledger.
 // (A saved collection whose files cannot be read as one is served as it is, without owners of its own.)
 const E=earlier?earlierTokens({base:earlier,follower,reader}):null,O=new Map();
 for(const [key,c] of collections){if(!Array.isArray(c?.transactions))continue;try{O.set(key,collectionOwners({collection:c,follower,reader}));}catch(e){log({earlier:`collection ${key}: ${String(e?.message||e).slice(0,160)}`});}}
 const earlierInfo=()=>{const at=E.reach;return {count:E.view.tokens.length,from:at.from,to:at.to,deployers:E.deployers,...(at.following?{following:{complete:at.complete}}:{})};};
 const follows=()=>Boolean(follower)&&(Boolean(E?.on())||[...O.values()].some(o=>o.on()));
 // One pass of the follower, short (some blocks, about a second), and then the views: the token view is made here so that
 // no request has to, and each collection's owners are worked out again, which asks the node nothing. A failure in any of
 // it is logged and tried again at the next turn; it never stops a sync or the relay.
 // (The same failure again and again is logged once, then now and then.)
 let noted='',times=0;const note=e=>{const m=String(e?.message||e).slice(0,200);if(m===noted&&++times%120!==0)return;if(m!==noted){noted=m;times=0;}log({earlier:m});};
 // The views are made one at a time, in the order they were asked for.
 let making=Promise.resolve();const remake=()=>making=making.then(async()=>{try{E?.view;}catch(e){note(e);}for(const o of O.values()){try{await o.refresh();}catch(e){note(e);}}});
 const earlierStep=async()=>{let f=null;try{if(!follows())return null;f=await follower.run({limit:followLimit,budget:followBudget});}catch(e){note(e);}await remake();return f;};
 // What the follower's folder already holds is shown from the start: `ready` settles when the views are made.
 const ready=remake();
 // A saved collection as it stands now: its files, with the owners the follower's transfers lead to where the files are
 // continued. `ownersAsOf` is then the block those owners are the format's ledger at; `following.complete` says whether
 // that is the newest block this reader holds, and `pending` counts kept transfers that are not 10 blocks deep yet.
 const saved=(key,c)=>{const o=O.get(key),s=o?.state;if(!s)return c;const st=o.status;
  return {header:{...c.header,ownersAsOf:st.asOf,following:{complete:st.complete,pending:st.pending}},items:c.items.map(t=>{const x=s.tokens.get(t.id);return x?{...t,owner:x.owner,last:x.last,transfers:x.history.length-1}:t;})};};
 // Who burned an NFT matters here: only its inscriber's own burn takes a token back.
 const tokens=()=>once('xmr20',()=>{const all=projectDeploys(reader.events.filter(e=>e.kind==='mint').map((e,i)=>{const x=L().nft(e.nft);
   return {id:e.nft,inscription:firstMinted+i,creator:x.minted.creator,collection:x.minted.collection,type:x.minted.type,burned:Boolean(x.burned),burnedBy:x.burned?x.history.find(h=>h.what==='burn')?.from??null:null,
    owner:x.owner,height:e.height,time:e.time,txid:e.txid,content:()=>contentOf(e.nft)};}),xmr20.inscribers),list=all.filter(t=>t.listed).map(({listed,...t})=>t);
  return {all,list,by:new Map(list.flatMap(t=>[[t.id,t],[String(t.number),t],...(t.mint?[[t.mint,t]]:[])]))};});
 // Open XMR20 tokens (xmr20-tokens/OPEN.md): the open deploys among every MD1 record carried from the opening block on,
 // also the records the ledger passed over (a deploy inscribed before the opening block and carried again). The journal
 // holds them all in chain order. This is the list of announcements: what was minted and who holds it is the token
 // ledger's to say, and so is the one deploy this list cannot refuse (its asset already had supply there).
 // Whether a journal entry's record is an open deploy depends on its bytes alone, so it is worked out once per entry.
 const deployOf=new WeakMap(),openDeployAt=e=>{if(!deployOf.has(e))deployOf.set(e,openDeployIn(Buffer.from(e.record,'hex'),{domain:m.domain,network:m.network}));return deployOf.get(e);};
 if(xmr20Open&&!(Number.isInteger(xmr20Open.from)&&xmr20Open.from>m.start))throw Error('The opening block of open XMR20 tokens has to be above the start block of this reader.');
 const openTokens=()=>once('xmr20open',()=>{const records=[];
   for(const e of reader.journal){if(!e.record||e.height<xmr20Open.from)continue;const d=openDeployAt(e);
    if(d)records.push({id:d.id,decoded:d.decoded,height:e.height,txid:e.txid,record:e.record});}
   const list=projectOpen(records).map((t,i)=>({number:i+1,...t})),record=new Map(records.map(r=>[r.id+':'+r.txid,r.record]));
   return {list,record,by:new Map(list.flatMap(t=>[[t.id,t],[t.id.slice(0,ID_SHOWN),t]]))};});
 // The relay carries mints of the tokens this service lists (lib/relay.mjs).
 if(relay&&xmr20Open)relay.useTokens(key=>openTokens().by.get(key)??null);
 const opened=()=>{if(!xmr20Open)throw fail('This reader lists no open XMR20 tokens.',404);if(reader.height+1<xmr20Open.from)throw fail(`Open XMR20 tokens start at block ${xmr20Open.from}; the ledger is at block ${reader.height}.`,409);};
 const open=()=>once('open',()=>reader.lots.map(lotView).filter(l=>l.status==='open'));
 const claimed=()=>once('claimed',()=>numbers.filter(n=>L().mordinal(n).claimed));
 const card=n=>{const o=entry.get(n),s=state(n);return {number:n,name:s.name,reg:s.reg,claimed:s.claimed,owner:s.owner,...(s.burned?{burned:true}:{}),...(s.waiting?{waiting:true}:{}),bodySize:o.bodySize??null,group:groupOf.get(n)??null,
  lot:s.lot?{id:s.lot.id,price:s.lot.price,until:s.lot.until,seller:s.lot.seller,reserved:Boolean(s.lot.reservation&&heldUntil(s.lot.reservation)>=reader.height)}:null};};
 const which=text=>{const t=decodeURIComponent(text);const o=/^\d{1,9}$/.test(t)?entry.get(Number(t)):/^[0-9a-f]{64}$/.test(t)?byReg.get(t):null;if(!o)throw fail('This is not a Mordinal on the owner list.',404);return o;};
 const stats=()=>once('stats',()=>{const by={};let volume=0n,fees=0n;for(const e of reader.events){by[e.kind]=(by[e.kind]||0)+1;if(e.kind==='sale'){volume+=BigInt(e.price);fees+=BigInt(e.fee);}}
  return {height:reader.height,mordinals:list.length,claimed:claimed().length,forSale:open().filter(l=>l.until>=reader.height).length,sales:by.sale||0,volume:volume.toString(),fees:fees.toString(),
   records:reader.journal.filter(e=>e.ok&&!feeOnly(e)).length,refused:reader.journal.filter(e=>!e.ok).length,byKind:by,
   // On a ledger that claims by burning: claims waiting for their fee (burns, and claims by a spent coin), and transactions
   // that paid a fee address.
   ...(m.burnFrom!=null?{burns:{waiting:L().toJSON().waiting?.length??0,feePayments:reader.journal.filter(e=>e.fee).length}}:{}),checkpoint:reader.checkpoints.at(-1)||null};});
 const waitingFor=q=>relay?relay.waitingFor(q):[];
 // A journal entry that is a fee payment and nothing else (RULES.md section 10).
 const feeOnly=e=>Boolean(e.fee)&&e.record===undefined&&!e.burn;
 // One sync and relay pass. The loop below runs it on a timer; tests call it directly.
 let stepping=null;
 const step=()=>{if(!stepping)stepping=(async()=>{const r=await reader.sync();const t=relay?await relay.tick():null;const f=await earlierStep();return {...r,relay:t,...(f?{earlier:f}:{})};})().finally(()=>{stepping=null;});return stepping;};

 async function route(method,url,body,req){
  const path=url.pathname,q=url.searchParams,height=reader.height;
  if(method==='GET'){
   if(path==='/info')return {network:m.network,domain:m.domain,feeAddress:m.feeAddress,height,count:list.length,chunk,test:Boolean(testHooks),owners:m.owners,start:m.start,startHash:m.startHash,mintFrom:m.mintFrom??null,...(m.minters?{minters:m.minters.split(',')}:{}),...(m.openFrom!=null?{openFrom:m.openFrom}:{}),
    // Claiming by burning: the first block, the first block at which claim records no longer count, where the burned
    // Mordinal goes, the text that names the new owner, the dead outputs of the ring.
    // The fee: the fee wallet, its public secret view key, the account of the fee addresses and what is added to a
    // Mordinal's number to give its index there (1: index 0 takes the wallet's own change).
    ...(m.burnFrom!=null?{burnFrom:m.burnFrom,burn:{recordsEnd:L().burn.recordsEnd,address:L().burn.address,viewKey:BURN.viewSecret,text:CLAIM_PREFIX+'<address>',dead:L().burn.dead,ownerOutputs:m.ownerOutputs,
     fee:L().burn.fee}}:{}),
    // Claiming by a spent coin (section 11): its first block, and the fixed part of what such a claim pays to its Mordinal's
    // fee address (the network fee of the transaction that carries the record comes on top).
    ...(m.spendFrom!=null?{spendFrom:m.spendFrom,spend:{base:L().spend.base}}:{}),...(xmr20||E||xmr20Open?{xmr20:{...(xmr20?{inscribers:xmr20.inscribers}:{}),...(E?{earlier:earlierInfo()}:{}),...(xmr20Open?{open:{from:xmr20Open.from}}:{})}}:{}),
    relay:relay?{networkFee:'relay',perAddress:relay.limits.perSigner,fees:relay.fees,payBlocks:relay.limits.payBlocks}:null,rules:{feeBps:RULES.feeBps,marketFeeCapBps:RULES.marketFeeCapBps,minPrice:RULES.minPrice.toString(),maxReserve:RULES.maxReserve,settle:RULES.settle}};
   if(path==='/owners'){const from=int(q.get('from'),0,0,list.length),limit=int(q.get('limit'),chunk,1,chunk);return {from,total:list.length,entries:list.slice(from,from+limit)};}
   if(path==='/claimed')return {height,numbers:claimed()};
   // Every collection and mint record signed by one address that the relay knows, in any state, with its bytes: a signer
   // that lost its own notes finds here what it already handed over.
   if(/^\/address\/[^/]+\/records$/.test(path)){const a=canonical(decodeURIComponent(path.slice(9,-8)),m.network);return {height,records:relay?relay.jobsOf(a):[]};}
   if(path.startsWith('/address/')){const a=canonical(decodeURIComponent(path.slice(9)),m.network);
    return {height,mordinals:L().owned(a).map(state),nfts:L().nftsOf(a).map(minted),buying:open().filter(l=>l.reservation?.buyer===a),waiting:waitingFor({signer:a})};}
   if(path==='/listings')return {height,listings:open().filter(l=>l.until>=height)};
   if(path.startsWith('/lot/')){const id=path.slice(5);if(!/^[0-9a-f]{64}$/.test(id)||!L().lot(id))throw fail('This listing does not exist.',404);return {height,lot:lotView(id),waiting:waitingFor({number:L().lot(id).number??L().lot(id).reg})};}
   if(path==='/records'){const all=reader.journal.filter(e=>e.ok&&e.record!==undefined),from=int(q.get('from'),0,0,all.length),limit=int(q.get('limit'),1000,1,5000);
    return {height,total:all.length,from,records:all.slice(from,from+limit).map(e=>e.record)};}
   // The valid burn claims and the fee payments, in ledger order. /records holds MD1 records only; `before` says how many
   // of those come before each entry here (a record in the same transaction as a fee payment comes before it), so a
   // client that replays the ledger applies records[0..before), then the burn claim (applyBurnClaim), then the fee
   // payments (applyBurnFees). `state` is where a burn claim stands now: 'claimed', 'waiting' for its fee, or 'lost'.
   if(m.burnFrom!=null&&path==='/burns'){
    const all=once('burns',()=>{const out=[];let before=0;for(const e of reader.journal){const burn=e.ok&&e.burn;if(e.ok&&e.record!==undefined)before++;
     if(burn||e.fee)out.push({height:e.height,pos:e.pos,txid:e.txid,...(burn?{id:e.id}:{}),before,...(burn?{burn:e.burn,state:L().burnClaim(e.id).state}:{}),...(e.fee?{fee:e.fee}:{})});}return out;});
    // (An entry with a fee payment holds the outputs of its transaction, a few kilobytes: pages of at most 500.)
    const from=int(q.get('from'),0,0,all.length),limit=int(q.get('limit'),200,1,500);return {height,total:all.length,from,burns:all.slice(from,from+limit)};}
   if(path.startsWith('/status/')){const id=path.slice(8);if(!/^[0-9a-f]{64}$/.test(id))throw fail('A record code is 64 hexadecimal characters.');
    // A burn claim, or a claim by a spent coin (section 11), is done once it claimed its Mordinal; before that it waits for
    // its fee, or it was passed over.
    {const e=reader.entryById(id),k=e?L().burnClaim(id):null,b=k?burnState(id):null;
     if(b&&b.state!=='claimed')return {height,id,state:b.state==='waiting'?'waiting':'refused',txid:e.txid,confirmations:0,
      error:b.state==='lost'?(k.kind==='spend'?'The Mordinal was claimed by another record before the fee of this claim was paid.':'The Mordinal was claimed by a record before the fee of this burn was paid.'):null,fee:b.fee};
     if(b)return {height,id,state:'done',txid:e.txid,confirmations:height-b.claimedAt+1,error:null};}
    if(relay)return {height,...relay.status(id)};const e=reader.entryById(id);
    return e?{height,id,state:'done',txid:e.txid,confirmations:height-e.height+1,error:null}:{height,id,state:'unknown',txid:null,confirmations:0,error:null};}
   // A transaction as the node gives it, for a wallet that makes payment proofs. In the pool: height null.
   if(path.startsWith('/tx/')){const id=path.slice(4);if(!/^[0-9a-f]{64}$/.test(id))throw fail('A transaction ID is 64 hexadecimal characters.');
    if(!allow(caller(req)))throw fail('Too many requests. Try again in a minute.',429);
    const [t]=await reader.lookup([id]);if(!t)throw fail('The Monero node does not know this transaction yet.',404);return {height,payment:t};}
   // The transaction that spent a key image, for a claim by a spent coin (section 11): asked of the node first (spent or
   // not, and where), then looked for in the pool or the newest 10 blocks, or with ?height=h in blocks h - 1 to h + 1 (a
   // wallet shows the block in which it spent a coin). Only on a ledger that takes such claims; a budget of its own, and one
   // lookup at a time. -> {height, keyImage, status (the node's: 0 not spent, 1 in a block, 2 in the pool), spent: {txid,
   // height (null: in the pool), tx} or null, earlier: true when the node says it is spent in a block that was not searched}
   if(path.startsWith('/spent/')){const ki=path.slice(7);if(!/^[0-9a-f]{64}$/.test(ki))throw fail('A key image is 64 hexadecimal characters.');
    if(m.spendFrom==null)throw fail('This ledger does not take claims by a spent coin.',404);
    const at=q.get('height');if(at!=null&&!/^[1-9][0-9]{0,9}$/.test(at))throw fail('A block height is a whole number.');
    const h=at==null?null:Number(at);if(h!=null&&h>height)throw fail('That block is not read yet. Try again in a few minutes.');
    if(!allow(caller(req))||!allowSpent(caller(req)))throw fail('Too many requests. Try again in a minute.',429);
    const r=await(spentQueue=spentQueue.catch(()=>{}).then(()=>reader.spentBy(ki,{heights:h==null?Array.from({length:10},(_,i)=>height-i).filter(x=>x>m.start):[h-1,h,h+1]})));
    return {height,keyImage:ki,status:r.status,spent:r.spent,...(r.status===1&&!r.spent?{earlier:true}:{})};}
   // Claims that wait for their fee (burns, and claims by a spent coin; public, as the ledger's state is): which Mordinal,
   // the claim's code, the address it goes to, what is due, paid and missing.
   if(path==='/waiting'){if(m.burnFrom==null)return {height,waiting:[]};
    return {height,waiting:once('waiting',()=>(L().toJSON().waiting||[]).map(w=>{const b=L().burnClaim(w.id);return {number:w.number,id:w.id,to:w.to,kind:b?.kind==='spend'?'spent coin':'burn',due:w.due,paid:b?.paid??'0',missing:b?.missing??w.due};}))};}
   // What became of the record a transaction carried: its entry in this reader's journal, accepted or refused.
   if(path.startsWith('/entry/')){const id=path.slice(7);if(!/^[0-9a-f]{64}$/.test(id))throw fail('A transaction ID is 64 hexadecimal characters.');
    const e=reader.entryByTx(id);if(!e)throw fail('This reader has read no record in this transaction.',404);
    // A claim by burning is a transaction of its own kind: its entry says so, which Mordinal goes to whom, and whether it
    // waits for its fee. A transaction that pays fee addresses lists what each payment counted for.
    // A claim by a spent coin (section 11) says the same: which Mordinal goes to whom, and whether it waits for its fee.
    const burned=e.burn&&e.ok?burnState(e.id):null,spent=!e.burn&&e.ok&&e.id&&L().burnClaim(e.id)?.kind==='spend'?burnState(e.id):null;
    return {height,entry:{txid:e.txid,height:e.height,pos:e.pos,id:e.id??null,op:e.op??null,...(e.burn?{kind:'burn claim',...(burned||{})}:spent?{kind:'spent coin claim',...spent}:feeOnly(e)?{kind:'fee payment'}:{}),ok:e.ok,...(e.ok?{}:{error:e.error}),
     ...(e.fee?{fees:reader.feesOf(e.txid)}:{})},confirmations:height-e.height+1};}
   if(path==='/pending')return {height,jobs:relay?relay.pending():[],pool:await poolNow()};
   if(path==='/stats')return stats();
   if(path==='/activity'||path==='/sales'){
    const kind=path==='/sales'?'sale':q.get('kind'),number=q.has('number')?Number(q.get('number')):null,address=q.get('address'),limit=int(q.get('limit'),50,1,200);
    if(kind&&!KINDS.has(kind))throw fail('Unknown kind.');
    const all=reader.events,before=int(q.get('before'),all.length,0,all.length),out=[];let at=before;
    while(at>0&&out.length<limit){const e=all[--at];
     if(kind&&e.kind!==kind)continue;if(number!=null&&e.number!==number)continue;
     if(address&&![e.to,e.from,e.seller,e.buyer].includes(address))continue;out.push({at,...e,...(Number.isInteger(e.number)?{name:nameOf(e.number)}:{}),confirmations:height-e.height+1});}
    return {height,total:all.length,next:at>0?at:null,events:out};}
   // The original history (inscriptions and transfers under the 2023 rules), newest first, by pages.
   if(path==='/history'){const kind=q.get('kind');if(kind&&kind!=='inscribed'&&kind!=='transfer')throw fail('Unknown kind.');
    const limit=int(q.get('limit'),50,1,200),before=int(q.get('before'),legacy.length,0,legacy.length),out=[];let at=before;
    while(at>0&&out.length<limit){const e=legacy[--at];if(kind&&e.kind!==kind)continue;out.push({at,...e,name:nameOf(e.number)});}
    return {height,total:legacy.length,inscriptions:owners.length,transfers:legacy.length-owners.length,next:at>0&&(kind?legacy.slice(0,at).some(e=>e.kind===kind):true)?at:null,events:out};}
   // Collections: each with its figures and a few members to show, and one collection's members by pages.
   if(path==='/groups')return once('groups',()=>{const listed=new Map();for(const l of open())if(l.until>=height&&l.number!=null)listed.set(l.number,l);const done=new Set(claimed());
    return {height,groups:groupList.map(g=>{const sale=g.members.filter(n=>listed.has(n)).map(n=>BigInt(listed.get(n).price)).sort((a,b)=>a<b?-1:a>b?1:0);
     return {id:g.id,name:g.name,fullName:g.fullName,basis:g.basis,count:g.members.length,claimed:g.members.filter(n=>done.has(n)).length,forSale:sale.length,floor:sale.length?sale[0].toString():null,
      sample:g.members.filter(n=>entry.get(n).bodySize!=null).slice(0,3)};})};});
   if(path.startsWith('/group/')){const g=groupById.get(path.slice(7));if(!g)throw fail('This collection does not exist.',404);
    const filter=q.get('filter')||'all',listed=new Set(open().filter(l=>l.until>=height&&l.number!=null).map(l=>l.number)),done=new Set(claimed());
    const pick=filter==='all'?g.members:filter==='listed'?g.members.filter(n=>listed.has(n)):filter==='claimed'?g.members.filter(n=>done.has(n)):null;if(!pick)throw fail('Unknown filter.');
    const from=int(q.get('from'),0,0,pick.length),limit=int(q.get('limit'),60,1,200);
    return {height,group:{id:g.id,name:g.name,fullName:g.fullName,basis:g.basis,count:g.members.length,claimed:g.members.filter(n=>done.has(n)).length,forSale:g.members.filter(n=>listed.has(n)).length},
     filter,from,total:pick.length,items:pick.slice(from,from+limit).map(card)};}
   if(path==='/gallery'){const filter=q.get('filter')||'all';
    const pick=filter==='claimed'?claimed():filter==='unclaimed'?once('unclaimed',()=>{const c=new Set(claimed());return numbers.filter(n=>!c.has(n));})
     :filter==='listed'?once('listed',()=>open().filter(l=>l.until>=height&&l.number!=null).map(l=>l.number).sort((a,b)=>a-b)):filter==='all'?numbers:null;
    if(!pick)throw fail('Unknown filter.');const from=int(q.get('from'),0,0,pick.length),limit=int(q.get('limit'),60,1,200);
    return {height,filter,from,total:pick.length,items:pick.slice(from,from+limit).map(card)};}
   // Names of many Mordinals at once: by number (a wallet's list), or by registration transaction (the archive's pages
   // know a Mordinal by its transaction). Numbers or transactions that are not on the owner list are left out.
   if(path==='/names'){const nums=q.get('numbers'),txs=q.get('tx');if((nums===null)===(txs===null))throw fail('Ask by numbers or by tx.');
    const list=(nums??txs).split(',').filter(Boolean),most=nums!==null?200:100;if(!list.length||list.length>most)throw fail(`Ask for 1 to ${most}.`);
    const one=n=>{const gid=groupOf.get(n);return {name:nameOf(n),group:gid?{id:gid,name:groupById.get(gid).name}:null};},names={};
    if(nums!==null)for(const x of list){if(!/^\d{1,9}$/.test(x))throw fail('Not a Mordinal number.');const n=Number(x);if(entry.has(n))names[n]=one(n);}
    else for(const x of list){if(!/^[0-9a-f]{64}$/.test(x))throw fail('Not a transaction id.');const o=byReg.get(x);if(o)names[x]={number:o.number,...one(o.number)};}
    return {height,names};}
   if(path.startsWith('/mordinal/')){const o=which(path.slice(10)),s=state(o.number);
    // The whole public story of one Mordinal: inscribed, moved by spending (2023), then claimed and moved by record.
    const history=[{kind:'inscribed',height:o.registrationHeight??null,time:timeAt(o.registrationHeight),txid:o.registrationTx},...(old.get(o.number)||[]),
     ...reader.events.filter(e=>e.number===o.number).map(e=>({...e,confirmations:height-e.height+1}))];
    const gid=groupOf.get(o.number);
    return {height,mordinal:{...s,edition:editionOf.get(o.number)??null,group:gid?{id:gid,name:groupById.get(gid).name}:null,registrationHeight:o.registrationHeight??null,ownerTx:o.ownerTx,ownerHeight:o.ownerHeight??null,bodySize:o.bodySize??null,bodySha256:o.bodySha256||null,
      // The owner output's global index: what the ring of a burning transfer names; the Mordinal's fee address and what
      // was paid to it; a burn claim that waits for its fee.
      ...(m.burnFrom!=null?(f=>({ownerOutput:Number.isSafeInteger(o.ownerOutputIndex)?o.ownerOutputIndex:null,burnFee:{address:f.address,paid:f.paid},
       // A claim by a spent coin that waits (section 11): txid is the transaction that carries its record, spendTx the one
       // that spent the coin.
       ...(f.waiting?{waiting:{txid:f.waiting.kind==='spend'?reader.entryById(f.waiting.id)?.txid??null:f.waiting.tx,id:f.waiting.id,to:f.waiting.to,height:f.waiting.height,due:f.waiting.due,paid:f.waiting.paid,missing:f.waiting.missing,
        ...(f.waiting.kind==='spend'?{proof:'spent coin',spendTx:f.waiting.tx}:{})}}:{})}))(L().burnFee(o.number)):{})},
     history,waiting:waitingFor({number:o.number})};}
   if(path==='/log'){const all=reader.journal,from=int(q.get('from'),0,0,all.length),limit=int(q.get('limit'),200,1,500);
    return {height,hash:reader.hash,from,total:all.length,entries:all.slice(from,from+limit)};}
   // Minted NFTs (RULES.md section 9), newest first, and the collections made on this ledger.
   if(path==='/nfts'){const all=mintedIds(),from=int(q.get('from'),0,0,all.length),limit=int(q.get('limit'),60,1,200),c=q.get('collection');
    const pick=c?all.filter(id=>L().nft(id).minted.collection===c):all;
    return {height,total:pick.length,from,items:pick.slice().reverse().slice(from,from+limit).map(minted)};}
   if(path.startsWith('/nft/')){const id=path.slice(5),x=/^[0-9a-f]{64}$/.test(id)?minted(id):null;if(!x)throw fail('This NFT does not exist.',404);
    const e=reader.entryById(id),c=x.collection===NO_COLLECTION?null:reader.entryById(x.collection);
    return {height,nft:x,record:e.record,collectionRecord:c?.record??null,
     history:reader.events.filter(v=>v.nft===id).map(v=>({...v,confirmations:height-v.height+1})),waiting:waitingFor({number:id})};}
   if(path==='/nft-collections')return {height,collections:L().collections().map(madeCollection).reverse()};
   if(path.startsWith('/nft-collection/')){const c=L().collection(path.slice(16));if(!c)throw fail('This collection does not exist.',404);
    return {height,collection:madeCollection(c),record:reader.entryById(c.id).record,items:mintedIds().filter(id=>L().nft(id).minted.collection===c.id).map(minted).sort((a,b)=>a.edition-b.edition)};}
   // XMR20 tokens, newest first; one token by its inscription id, its number or its Solana mint.
   if(xmr20&&path==='/xmr20/tokens'){const mode=q.get('mode'),all=mode?tokens().list.filter(t=>t.mode===mode):tokens().list,from=int(q.get('from'),0,0,all.length),limit=int(q.get('limit'),60,1,200);
    return {height,total:all.length,from,inscribers:xmr20.inscribers,...(E?{earlier:E.view.tokens.length}:{}),items:all.slice().reverse().slice(from,from+limit).map(t=>({...t,confirmations:height-t.height+1}))};}
   // The earlier XMR20 tokens, newest first, and one of them with the text that was inscribed for it. `range` is every
   // block the answer covers: the list's, and on from it the blocks the follower has read.
   if(E&&path==='/xmr20/earlier'){const v=E.view,at=E.reach,all=v.tokens,from=int(q.get('from'),0,0,all.length),limit=int(q.get('limit'),60,1,200);
    return {height,total:all.length,from,range:{from:at.from,to:at.to},deployers:E.deployers,...(at.following?{following:{complete:at.complete}}:{}),items:all.slice().reverse().slice(from,from+limit)};}
   if(E&&path.startsWith('/xmr20/earlier/')){const v=E.view,x=v.by.get(decodeURIComponent(path.slice(15)));if(!x)throw fail('This is not an earlier XMR20 token.',404);
    const d=v.entry.get(x.txid);return {height,token:x,record:d.record,signature:d.signature,text:earlierText({record:d.record,signature:d.signature})};}
   // The open XMR20 tokens, newest first, and one of them (by its id or the 16 characters signed texts show) with its
   // deploy record and text.
   if(xmr20Open&&path==='/xmr20/open'){const all=openTokens().list,from=int(q.get('from'),0,0,all.length),limit=int(q.get('limit'),60,1,200);
    return {height,total:all.length,from,openFrom:xmr20Open.from,items:all.slice().reverse().slice(from,from+limit).map(t=>({...t,confirmations:height-t.height+1}))};}
   if(xmr20Open&&path.startsWith('/xmr20/open/')){const o=openTokens(),t=o.by.get(decodeURIComponent(path.slice(12)));if(!t)throw fail('This is not an open XMR20 token on this ledger.',404);
    const record=o.record.get(t.id+':'+t.txid);return {height,token:{...t,confirmations:height-t.height+1},record,text:Buffer.from(decodeRecord(Buffer.from(record,'hex'),m.network).body.content).toString('utf8')};}
   // What became of a mint the relay was asked to carry (POST /xmr20/open/mints).
   if(xmr20Open&&relay&&path.startsWith('/xmr20/open-mint/')){const id=path.slice(17);if(!/^[0-9a-f]{64}$/.test(id))throw fail('A mint is named by its id.',400);
    const s=relay.status(id);if(s.op!=='token-mint')throw fail('The relay knows no such mint.',404);return {height,...s};}
   if(xmr20&&path.startsWith('/xmr20/token/')){const t=tokens().by.get(decodeURIComponent(path.slice(13)));if(!t)throw fail('This is not an XMR20 token on this ledger.',404);
    return {height,token:{...t,confirmations:height-t.height+1},record:reader.entryById(t.id).record,text:Buffer.from(contentOf(t.id)).toString('utf8')};}
   // Every deploy inscription that names one Solana mint, listed as a token or not (burned by its inscriber, or behind an
   // earlier one), each with its record: what a launchpad's inscriber needs to know before it inscribes a launch.
   if(xmr20&&path.startsWith('/xmr20/deploys/')){const mint=decodeURIComponent(path.slice(15));
    return {height,deploys:tokens().all.filter(t=>t.mint===mint).map(t=>({...t,confirmations:height-t.height+1,record:reader.entryById(t.id).record}))};}
   // Collections shown next to the Mordinals (read-only; see xmr20-nfts/).
   if(path==='/collections')return {height,collections:[...collections].map(([key,c])=>({key,...saved(key,c).header}))};
   if(path.startsWith('/collections/')){const [key,edition]=path.slice(13).split('/'),c=collections.get(key);if(!c)throw fail('This collection is not known here.',404);
    const now=saved(key,c);if(edition===undefined)return {height,collection:{key,...now.header},items:now.items};
    const item=/^\d{1,5}$/.test(edition)?now.items.find(t=>t.edition===Number(edition)):null;if(!item)throw fail('This collection has no such edition.',404);
    // One NFT comes with its transfers, oldest first, where the files are continued.
    const moves=O.get(key)?.state?.tokens.get(item.id)?.history.slice(1).map(x=>({txid:x.txid,height:x.height,to:x.owner}));
    return {height,collection:{key,...now.header},item:moves?{...item,moves}:item};}
   if(path==='/checkpoints')return {height,checkpoints:reader.checkpoints};
   if(path==='/checkpoint')return reader.checkpoint();}
  if(method==='POST'&&path==='/records'){
   if(!relay)throw fail('This reader does not relay records. Publish the record yourself or use a relay.',503);
   if(!allow(caller(req)))throw fail('Too many requests. Try again in a minute.',429);
   // `anew`: the sender means to inscribe again a launch whose earlier inscription its signer burned (xmr20-tokens/FORMAT.md).
   return {height,...await relay.submit(body.record,{caller:caller(req),anew:body.anew===true})};}
  // Open XMR20 tokens for wallets that only sign messages (Feather, Cake Wallet): the text of a deploy to sign and the
  // record the signature makes of it, which then goes the way of every record; and a mint, which needs no signature.
  if(method==='POST'&&path==='/xmr20/open/deploy-text'){opened();if(!allow(caller(req)))throw fail('Too many requests. Try again in a minute.',429);
   let p;try{const {creator,...fields}=body||{};p=prepareOpenDeploy({creator:canonical(creator,m.network),fields,domain:m.domain,network:m.network});}catch(e){throw fail(String(e.message).slice(0,200),400);}
   const there=openTokens().by.get(p.id.slice(0,ID_SHOWN));
   if(there)throw fail(there.id===p.id?'This token is deployed already.':'Another token\'s id starts with the same 16 characters. Change a field, the name for example.',409);
   if(reader.entryById(p.id))throw fail('This deploy is on the ledger as an NFT from before the opening block: it is no token. Change a field of the token.',409);
   return {height,id:p.id,label:p.label,body:Buffer.from(p.body).toString('hex'),text:p.text,signer:canonical(body.creator,m.network),fields:p.fields};}
  if(method==='POST'&&path==='/xmr20/open/deploys'){opened();
   if(!relay)throw fail('This reader does not relay records. Publish the record yourself or use a relay.',503);
   if(!allow(caller(req)))throw fail('Too many requests. Try again in a minute.',429);
   let record;try{if(typeof body?.body!=='string'||!/^([0-9a-f]{2}){1,1000}$/.test(body.body)||typeof body.signature!=='string'||body.signature.length>200)throw Error('Give the body and the signature.');
    record=finishOpenDeploy({body:Buffer.from(body.body,'hex'),signature:body.signature,domain:m.domain,network:m.network});}catch(e){throw fail(String(e.message).slice(0,200),400);}
   return {height,...await relay.submit(Buffer.from(record).toString('hex'),{caller:caller(req)})};}
  if(method==='POST'&&path==='/xmr20/open/mints'){opened();
   if(!relay)throw fail('This reader does not relay records. Mint from your own wallet with the xmr721 command.',503);
   if(!allow(caller(req)))throw fail('Too many requests. Try again in a minute.',429);
   return {height,...await relay.submitMint({token:body?.token,amount:body?.amount,address:body?.address,wallet:body?.wallet??null,salt:body?.salt??null,caller:caller(req)})};}
  if(testHooks&&method==='POST'&&path==='/test/step')return step();
  if(testHooks&&extra){const out=await extra(method,path,body,step);if(out!==undefined)return out;}
  throw fail('Not found',404);}

 // Many visitors asking at once share one look at the node's pool.
 let poolRead=null;const poolNow=()=>poolRead||(poolRead=reader.waiting().finally(()=>{poolRead=null;}));
 // Per address: a small steady rate with room for a burst. Behind this machine's own proxy the caller is the last
 // address the proxy added; without that option the header is ignored, because anyone can write it.
 const caller=req=>{const direct=req.socket.remoteAddress||'';if(!behindProxy)return direct;
  const last=String(req.headers['x-forwarded-for']||'').split(',').at(-1).trim();return last||direct;};
 const buckets=new Map();
 // /spent reads blocks and the pool of the node: a budget of its own, a few per minute, and one lookup at a time.
 const spentBuckets=new Map();let spentQueue=Promise.resolve();
 function allowSpent(ip){const t=Date.now(),b=spentBuckets.get(ip)||{tokens:10,at:t};b.tokens=Math.min(10,b.tokens+(t-b.at)/1000*0.2);b.at=t;if(spentBuckets.size>10000)spentBuckets.clear();spentBuckets.set(ip,b);if(b.tokens<1)return false;b.tokens--;return true;}
 function allow(ip){const t=Date.now(),b=buckets.get(ip)||{tokens:rate.burst,at:t};b.tokens=Math.min(rate.burst,b.tokens+(t-b.at)/1000*rate.perSecond);b.at=t;
  if(buckets.size>10000)buckets.clear();buckets.set(ip,b);if(b.tokens<1)return false;b.tokens-=1;return true;}
 async function picture(res,text){
  const o=which(text),got=content?await content(o):{status:404,error:'This service has no pictures.'};
  const head={'x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; sandbox",'cross-origin-resource-policy':'cross-origin'};
  if(got.status!==200){res.writeHead(got.status,{...head,'content-type':'application/json','cache-control':got.status===502?'no-store':'public, max-age=3600'});res.end(JSON.stringify({error:got.error}));return;}
  // A picture drawn from an SVG document (lib/draw.mjs) says so: its bytes are not the inscribed bytes that
  // x-mordinal-sha256 names, and a later service may draw it better, so it is kept for a day, not for good.
  res.writeHead(200,{...head,'content-type':got.type,'content-length':got.bytes.length,'cache-control':got.drawn?'public, max-age=86400':'public, max-age=31536000, immutable','x-mordinal-sensitive':got.sensitive||labelled.has(o.number)?'1':'0','x-mordinal-sha256':o.bodySha256,...(got.drawn?{'x-mordinal-drawn':got.drawn}:{})});res.end(got.bytes);}
 // A Mordinal whose content is a short plain text (lib/content.mjs plainText): its bytes as text/plain, for a page to
 // show as text. A picture, or content that is neither, answers 415; the rest as /content/ answers.
 async function words(res,text){
  const o=which(text),got=content?await content(o):{status:404,error:'This service has no pictures.'};
  const head={'x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; sandbox",'cross-origin-resource-policy':'cross-origin'};
  if(got.text==null){const status=got.status===200?415:got.status,error=got.status===200?'This Mordinal is a picture, not a text.':got.status===415?'This Mordinal is not a text.':got.error;
   res.writeHead(status,{...head,'content-type':'application/json','cache-control':status===502?'no-store':'public, max-age=3600'});res.end(JSON.stringify({error}));return;}
  res.writeHead(200,{...head,'content-type':'text/plain; charset=utf-8','content-length':got.bytes.length,'cache-control':'public, max-age=31536000, immutable','x-mordinal-sensitive':got.sensitive||labelled.has(o.number)?'1':'0','x-mordinal-sha256':o.bodySha256});res.end(got.bytes);}
 function page(res,path){
  const rel=normalize(decodeURIComponent(path.slice(6))||'index.html'),file=join(views,rel.endsWith(sep)||rel==='.'?join(rel,'index.html'):rel);
  if(rel.startsWith('..')||!file.startsWith(views+sep)||!existsSync(file)||!statSync(file).isFile()||!TYPES[extname(file)]){res.writeHead(404,{'content-type':'text/plain'});res.end('Not found');return;}
  res.writeHead(200,{'content-type':TYPES[extname(file)],'cache-control':'no-store','content-security-policy':PAGE_CSP,'x-content-type-options':'nosniff','referrer-policy':'no-referrer'});res.end(readFileSync(file));}
 const server=createServer(async(req,res)=>{
  const origin=req.headers.origin||'',headers={'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'};
  if(origins.includes(origin)||(origin.startsWith('chrome-extension://')&&(!extensions||extensions.includes(origin.slice(19))))){headers['access-control-allow-origin']=origin;headers['access-control-allow-headers']='content-type';headers['access-control-expose-headers']='x-mordinal-sensitive';headers.vary='origin';}
  if(req.method==='OPTIONS'){res.writeHead(204,headers);res.end();return;}
  try{
   const url=new URL(req.url,'http://127.0.0.1');
   // Content and texts are kept by caches for a long time, and the same address is read with and without an Origin
   // (an <img>, a page's fetch): every answer says that it depends on the Origin.
   if(req.method==='GET'&&url.pathname.startsWith('/content/')){res.setHeader('vary','origin');if(headers['access-control-allow-origin'])for(const k of ['access-control-allow-origin','access-control-expose-headers'])res.setHeader(k,headers[k]);return await picture(res,url.pathname.slice(9));}
   if(req.method==='GET'&&url.pathname.startsWith('/text/')){res.setHeader('vary','origin');if(headers['access-control-allow-origin'])for(const k of ['access-control-allow-origin','access-control-expose-headers'])res.setHeader(k,headers[k]);return await words(res,url.pathname.slice(6));}
   // The inscribed bytes of a minted NFT: pictures by their first bytes, plain text as text, JSON that parses as JSON;
   // nothing else is served.
   const made=/^\/nft\/([0-9a-f]{64})\/content$/.exec(url.pathname);
   if(req.method==='GET'&&made){const x=reader.ledger.nft(made[1]),e=x&&reader.entryById(made[1]);
    // A page on an allowed origin may read the bytes (text and JSON are shown by the page itself).
    res.setHeader('vary','origin');if(headers['access-control-allow-origin'])res.setHeader('access-control-allow-origin',headers['access-control-allow-origin']);
    if(!x){res.writeHead(404,headers);res.end(JSON.stringify({error:'This NFT does not exist.'}));return;}
    const bytes=Buffer.from(decodeRecord(Buffer.from(e.record,'hex'),m.network).body.content),type=pictureType(bytes)||(x.minted.type===5?'text/plain; charset=utf-8':x.minted.type===TYPE_JSON&&isJson(bytes)?'application/json; charset=utf-8':null);
    if(!type){res.writeHead(415,headers);res.end(JSON.stringify({error:'This content is not shown.'}));return;}
    res.writeHead(200,{'content-type':type,'content-length':bytes.length,'cache-control':'public, max-age=31536000, immutable','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; sandbox",'cross-origin-resource-policy':'cross-origin'});res.end(bytes);return;}
   const shot=/^\/collections\/([a-z0-9-]{1,40})\/(\d{1,5})\/picture$/.exec(url.pathname);
   if(req.method==='GET'&&shot){const file=await collections.get(shot[1])?.picture(Number(shot[2]),{plain:url.searchParams.get('plain')==='1'});
    if(!file){res.writeHead(404,headers);res.end(JSON.stringify({error:'No such picture.'}));return;}
    res.writeHead(200,{'content-type':file.type,'content-length':file.bytes.length,'cache-control':'public, max-age=31536000, immutable','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; sandbox",'cross-origin-resource-policy':'cross-origin'});res.end(file.bytes);return;}
   if(req.method==='GET'&&views&&(url.pathname==='/'||url.pathname==='/view')){res.writeHead(302,{location:'/view/'});res.end();return;}
   if(req.method==='GET'&&views&&url.pathname.startsWith('/view/'))return page(res,url.pathname);
   let body={};
   if(req.method==='POST'){const kind=String(req.headers['content-type']||'').split(';')[0].trim().toLowerCase(),length=req.headers['content-length'];
    // A page on another site can post plain text without asking; it cannot post JSON without this service agreeing first.
    if(kind!=='application/json'&&!(kind===''&&(length==='0'||length===undefined&&!req.headers['transfer-encoding'])))throw fail('Send JSON (content-type: application/json).',415);
    const parts=[];let size=0;for await(const c of req){size+=c.length;if(size>65536)throw fail('Request too large',413);parts.push(c);}
    try{body=JSON.parse(Buffer.concat(parts).toString('utf8')||'{}');}catch{throw fail('The request is not JSON.');}if(!body||typeof body!=='object')throw fail('The request is not JSON.');}
   const out=await route(req.method,url,body,req);res.writeHead(200,headers);res.end(JSON.stringify(out));}
  catch(e){if(!e.status||e.status>=500)log({error:String(e?.message||e).slice(0,200)});if(!res.headersSent)res.writeHead(e.status||400,headers);
   // `rule` marks a refusal by the rules themselves: it will not change, where a busy or failing relay may answer differently later.
   // `held` names the record that already holds a launch with the relay.
   res.end(JSON.stringify({error:String(e?.message||e).slice(0,400),...(e?.rule?{rule:true}:{}),...(e?.held?{held:e.held}:{})}));}});
 let timer=null;
 return {reader,relay,server,step,ready,
  listen:port=>new Promise((done,bad)=>{server.once('error',bad);server.listen(port,'127.0.0.1',()=>done(server.address().port));}),
  // Follow the chain on a timer. A failed pass is logged and tried again at the next turn.
  follow(every=5000){if(timer)return;const turn=()=>step().catch(e=>log({sync:String(e.message).slice(0,200)}));turn();timer=setInterval(turn,every);timer.unref?.();},
  close:()=>new Promise(done=>{if(timer)clearInterval(timer);timer=null;server.closeAllConnections?.();server.close(()=>done());})};}

// Everything from command-line style options: used by the command below and by tests (which may hand in `chain`, a
// made-up node, in place of `node`).
export async function startService(o){
 const owners=readOwners(o.owners),chain=o.chain??createChain(o.node),network=o.network||'mainnet';
 // Dead outputs of one's own are for the offline test chain. On mainnet they are refused here, before anything is
 // opened (the reader refuses them again whenever it reads).
 if(o.burnDead!=null&&network==='mainnet'&&!isMainnetDead([...o.burnDead].map(Number).sort((x,y)=>x-y))&&(await chain.info()).nettype!=='fakechain')throw Error('--burn-dead: on mainnet the dead outputs are fixed; other ones can be named only on the offline test chain.');
 if(o.burnFee!=null&&network==='mainnet'&&!isProjectFeeWallet(feeWallet(o.burnFee,network,{testChain:true}))&&(await chain.info()).nettype!=='fakechain')throw Error('--burn-fee-wallet: on mainnet the fee wallet is the project\'s; another one can be named only on the offline test chain.');
 const reader=openReader({dir:o.state,chain,network,domain:o.domain,feeAddress:o.feeAddress,owners,start:Number(o.start),startHash:o.startHash||null,mintFrom:o.mintFrom==null?null:Number(o.mintFrom),minters:o.minters??null,openFrom:o.openFrom==null?null:Number(o.openFrom),burnFrom:o.burnFrom==null?null:Number(o.burnFrom),burnDead:o.burnDead??null,burnFee:o.burnFee??null,spendFrom:o.spendFrom==null?null:Number(o.spendFrom),checkpointEvery:o.checkpointEvery??720,log:o.log});
 // A first burn block that this start takes in, or changes, has to lie at least 10 blocks above the node's newest block,
 // and so does a first block of claims by a spent coin that it takes in. It is checked here, before anything is served: otherwise the pages would announce a setting the folder refuses.
 if(reader.burnPending!=null||reader.spendPending!=null){const info=await chain.info();try{reader.confirmBurn(info);}catch(e){throw Error((/spent coin/.test(e.message)?'--spend-from: ':'--burn-from: ')+e.message);}}
 let relay=null;
 if(o.carrierBin){const carrier=createCarrier({bin:o.carrierBin,stateDir:o.carrierState,node:o.node,network:o.carrierNetwork||'offline-fakechain',start:Number(o.carrierStart||o.start)});
  relay=createRelay({dir:join(o.state,'relay'),reader,chain,carrier,network,domain:o.domain,limits:o.limits,fees:o.fees,lane:o.minters||[],...(o.now?{now:o.now}:{}),log:o.log});}
 const source=o.contentDir?dirContent(o.contentDir):o.contentArchive?archiveContent(o.contentArchive===true?undefined:o.contentArchive):null;
 const times=o.blockTimes!==undefined?o.blockTimes:existsSync(BLOCK_TIMES)?BLOCK_TIMES:null,groupFile=o.groups!==undefined?o.groups:existsSync(GROUPS)?GROUPS:null;
 // The earlier XMR20 tokens are a list of mainnet inscriptions: served on a mainnet reader, from the named folder or the shipped one.
 const earlier=network==='mainnet'&&o.xmr20Earlier!==false&&(o.xmr20Earlier||existsSync(join(EARLIER,'list.json')))?loadEarlier(o.xmr20Earlier||EARLIER,network):null;
 const collections=o.collections?loadCollections(o.collections):new Map();
 // Both are read on in the blocks this reader follows, in a folder of its own inside the state folder, where they end at
 // this reader's start block: new deploys of the list's deployers, and transfers of the NFTs of saved collections that are
 // fully minted.
 const full=network==='mainnet'?[...collections.values()].filter(c=>Array.isArray(c?.transactions)&&Array.isArray(c.items)&&c.header&&c.header.minted===c.header.max&&c.header.ownersAsOf?.height===Number(o.start)):[];
 const choice=picker({deployers:earlier?.header.to===Number(o.start)?earlier.header.deployers:[],nfts:full.flatMap(c=>c.items.map(t=>t?.id)).filter(id=>typeof id==='string')});
 // A follower that cannot be opened (its folder cannot be written, say) is done without: the shipped files are then served as they are.
 let follower=null;
 if(network==='mainnet'&&o.xmr20Follow!==false&&(earlier||full.length)){try{follower=openFollower({dir:join(o.state,EARLIER_NAME),chain,reader,pick:choice.pick,name:choice.name,log:o.log});}catch(e){o.log?.({earlier:'not read on: '+String(e?.message||e).slice(0,200)});}}
 const service=createService({reader,relay,owners,transfers:o.transfers?readOwners(o.transfers):[],blockTimes:times?JSON.parse(readFileSync(times,'utf8')).times:null,groups:groupFile?JSON.parse(readFileSync(groupFile,'utf8')):null,content:source?createContent({source,draw:createDrawer({log:o.log})}):null,collections,views:o.views||(existsSync(VIEWS)?VIEWS:null),xmr20:o.xmr20Inscribers?.length?{inscribers:o.xmr20Inscribers.map(a=>canonical(a,network))}:null,xmr20Open:o.xmr20OpenFrom!=null?{from:o.xmr20OpenFrom}:null,
  earlier,follower,...(o.followLimit?{followLimit:o.followLimit}:{}),origins:o.origins||[],extensions:o.extensions?.length?o.extensions:null,behindProxy:Boolean(o.behindProxy),testHooks:Boolean(o.testHooks),...(o.rate?{rate:o.rate}:{}),log:o.log});
 // The views are made from what the follower's folder holds before anything is served; a few seconds at most are waited for it.
 await Promise.race([service.ready,new Promise(done=>{setTimeout(done,5000).unref?.();})]);const port=await service.listen(o.port==null?18951:Number(o.port));return {...service,port,chain,owners};}

if(process.argv[1]===import.meta.filename){
 // Every word that begins with a dash is an option this program knows, written "--name value", and given once (the
 // two lists of allowed origins and extensions may repeat). A misspelt option stops the start: an ignored
 // --open-from or --minters would make this another ledger than the one that was meant.
 {const KNOWN=new Set(['ledger','owners','transfers','block-times','groups','domain','fee-address','node','start','start-hash','mint-from','minters','open-from','burn-from','burn-dead','burn-fee-wallet','spend-from','state','network','port','every','xmr20-inscribers','xmr20-open-from','xmr20-earlier','no-xmr20-earlier','no-xmr20-follow',
   'mint-fee','collection-fee','token-mint-fee','carrier-bin','carrier-state','carrier-start','carrier-network','relay-limits','content-dir','content-archive','collections','views','allow-origin','allow-extension','behind-proxy','test-hooks']),MANY=new Set(['allow-origin','allow-extension']),seen=new Set();
  for(const a of process.argv.slice(2)){if(!a.startsWith('-'))continue;
   if(a.includes('='))throw Error(`Write "${a.split('=')[0]} <value>", with a space: ${a}`);
   const name=a.startsWith('--')?a.slice(2):null;if(!name||!KNOWN.has(name))throw Error(`There is no option ${a}. See the top of this file.`);
   if(seen.has(name)&&!MANY.has(name))throw Error(`--${name} is given twice.`);seen.add(name);}}
 const arg=name=>{const i=process.argv.indexOf('--'+name);return i<0?null:process.argv[i+1];},has=name=>process.argv.includes('--'+name);
 // --ledger mainnet stands for every setting of the mainnet ledger. A setting given beside it is refused, whatever its
 // value: one command line names one ledger.
 const ledger=has('ledger')?arg('ledger'):null;
 if(has('ledger')&&ledger!=='mainnet'){console.error('--ledger mainnet is the only ledger this program knows by name.');process.exit(2);}
 if(ledger)for(const fixed of ['owners','domain','fee-address','start','start-hash','network','mint-from','minters','open-from','burn-from','burn-dead','burn-fee-wallet','spend-from','xmr20-inscribers','xmr20-open-from'])if(has(fixed)){console.error(`--${fixed} is part of --ledger ${ledger} and cannot be given beside it.`);process.exit(2);}
 const ROOT=join(import.meta.dirname,'..'),preset=ledger?mainnetOptions(ROOT):{};
 for(const need of ledger?['node','state']:['owners','domain','fee-address','node','start','state'])if(!arg(need)){console.error('Missing --'+need+'. See the top of this file.');process.exit(2);}
 const archive=has('content-archive')?(arg('content-archive')?.startsWith('http')?arg('content-archive'):true):null;
 // --relay-limits minReady=4,splitInto=12,buyReserve=2: whole numbers for the relay's limits (lib/relay.mjs DEFAULT_LIMITS).
 const limits=Object.fromEntries((arg('relay-limits')||'').split(',').filter(Boolean).map(kv=>{const [k,v]=kv.split('=');if(!/^[a-zA-Z]+$/.test(k)||!/^\d{1,12}$/.test(v||''))throw Error('--relay-limits: name=number,…');return [k,Number(v)];}));
 const s=await startService({...(Object.keys(limits).length?{limits}:{}),owners:arg('owners'),transfers:arg('transfers')||(ledger?join(ROOT,'ownership-index/result/transfers.jsonl'):null),...(arg('block-times')?{blockTimes:arg('block-times')}:{}),...(arg('groups')?{groups:arg('groups')}:{}),domain:arg('domain'),feeAddress:arg('fee-address'),node:arg('node'),start:arg('start'),startHash:arg('start-hash'),mintFrom:arg('mint-from'),
  // --minters given means a list: an empty value is refused, never read as "everyone".
  ...(has('minters')?{minters:(arg('minters')||'').split(',').filter(Boolean)}:{}),...(has('open-from')?{openFrom:(v=>{if(!/^[1-9]\d{0,9}$/.test(v||''))throw Error('--open-from <height>: the opening block is a whole number');return Number(v);})(arg('open-from'))}:{}),
  // The same care for the burn setting: a height that does not read as one, or a list that is not fifteen indexes, stops the start.
  ...(has('burn-from')?{burnFrom:(v=>{if(!/^[1-9]\d{0,9}$/.test(v||''))throw Error('--burn-from <height>: the first burn block is a whole number');return Number(v);})(arg('burn-from'))}:{}),
  ...(has('spend-from')?{spendFrom:(v=>{if(!/^[1-9]\d{0,9}$/.test(v||''))throw Error('--spend-from <height>: the first block of claims by a spent coin is a whole number');return Number(v);})(arg('spend-from'))}:{}),
  ...(has('burn-dead')?{burnDead:(v=>{if(!/^\d{1,15}(,\d{1,15}){14}$/.test(v||''))throw Error('--burn-dead <index>,…: fifteen global output indexes');return v.split(',').map(Number);})(arg('burn-dead'))}:{}),
  ...(has('burn-fee-wallet')?{burnFee:(v=>{const m=/^([1-9A-HJ-NP-Za-km-z]{95}):([0-9a-f]{64})$/.exec(v||'');if(!m)throw Error('--burn-fee-wallet <main address>:<secret view key>');return {address:m[1],viewKey:m[2]};})(arg('burn-fee-wallet'))}:{}),state:arg('state'),network:arg('network'),xmr20Inscribers:(arg('xmr20-inscribers')||'').split(',').filter(Boolean),...(has('xmr20-open-from')?{xmr20OpenFrom:(v=>{if(!/^[1-9][0-9]{0,8}$/.test(v||''))throw Error('--xmr20-open-from <block>');return Number(v);})(arg('xmr20-open-from'))}:{}),...(has('no-xmr20-earlier')?{xmr20Earlier:false}:arg('xmr20-earlier')?{xmr20Earlier:arg('xmr20-earlier')}:{}),...(has('no-xmr20-follow')?{xmr20Follow:false}:{}),
  port:arg('port'),fees:{mint:arg('mint-fee')||0,collection:arg('collection-fee')||0,tokenMint:arg('token-mint-fee')||0},carrierBin:arg('carrier-bin'),carrierState:arg('carrier-state'),carrierStart:arg('carrier-start'),carrierNetwork:arg('carrier-network'),contentDir:arg('content-dir'),collections:arg('collections')||(ledger?join(ROOT,'xmr20-nfts/collections'):null),contentArchive:archive,views:arg('views'),
  origins:process.argv.flatMap((a,i)=>a==='--allow-origin'?[process.argv[i+1]]:[]),extensions:process.argv.flatMap((a,i)=>a==='--allow-extension'?[process.argv[i+1]]:[]),behindProxy:has('behind-proxy'),testHooks:has('test-hooks'),log:v=>console.log(new Date().toISOString(),JSON.stringify(v)),...preset});
 console.log(`Mordinals reader on http://127.0.0.1:${s.port} (${s.owners.length} Mordinals, block ${s.reader.height}${s.relay?', relay on':', reader only'})`);
 s.follow(Number(arg('every'))||5000);
}
