// The Mordinals reader service: follows a Monero node, keeps the record journal (lib/reader.mjs), answers wallets and
// the explorer pages, and - when it is given a carrier wallet - relays signed records to the chain (lib/relay.mjs).
// It listens on 127.0.0.1 only. It holds no user key. Everything it answers can be rebuilt by anyone from the owner
// list and the chain with this same code.
//
//   node service.mjs --owners <owners.jsonl> --domain <hex32> --fee-address <address> --node <url> --start <height> --state <dir>
//        [--start-hash <hash>] [--network mainnet|stagenet] [--port 18951] [--every <ms>] [--transfers <transfers.jsonl>] [--block-times <file>] [--groups <collections.json>]
//        [--mint-from <height> [--minters <address>,… [--open-from <height>]]]   the ledger's first mint block, and who may mint (everyone when no list is
//                                                   given; with --open-from everyone from that block on); part of the ledger's setup
//        [--carrier-bin <path> --carrier-state <dir> --carrier-network offline-fakechain|stagenet|mainnet [--carrier-start <height>] [--relay-limits name=n,…]]   relay on (mainnet also needs MORDINALS_MAINNET=1)
//        [--mint-fee <atomic units> --collection-fee <atomic units>]   what this relay charges to carry a mint or a collection record
//        [--content-dir <dir> | --content-archive [url]] [--collections <dir>] [--views <dir>] [--allow-origin <origin>] [--allow-extension <id>] [--behind-proxy] [--test-hooks]
//        [--xmr20-inscribers <address>,…]   list the XMR20 tokens these addresses inscribed (xmr20-tokens/FORMAT.md)
//        [--xmr20-earlier <dir> | --no-xmr20-earlier]   the earlier XMR20 deploy inscriptions (xmr20-tokens/EARLIER.md); the list this repository ships is served unless another is named
//        [--no-xmr20-follow]   do not read the earlier formats on in the blocks this reader follows (lib/earlier.mjs): serve the shipped list and the saved collections as they are
//
// Lists are served whole (the owner list in pieces, every claimed number), so a wallet never has to name the
// Mordinals it holds before it claims them.
import {createServer} from 'node:http';
import {existsSync,readFileSync,statSync} from 'node:fs';
import {join,normalize,extname,sep} from 'node:path';
import {RULES,NO_COLLECTION,heldUntil,canonical,decodeRecord} from '../rules/lib/records.mjs';
import {createChain} from './lib/chain.mjs';
import {openReader} from './lib/reader.mjs';
import {createRelay,createCarrier} from './lib/relay.mjs';
import {createContent,dirContent,archiveContent,pictureType} from './lib/content.mjs';
import {served,readOwners} from './lib/owners.mjs';
import {loadCollections} from '../xmr20-nfts/lib/collection.mjs';
import {projectDeploys,TYPE_JSON} from '../xmr20-tokens/lib/token.mjs';
import {loadEarlier,canonical as earlierText} from '../xmr20-tokens/lib/earlier.mjs';
import {openFollower} from './lib/follow.mjs';
import {picker,earlierTokens,collectionOwners,NAME as EARLIER_NAME} from './lib/earlier.mjs';

const TYPES={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'};
const PAGE_CSP="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const EARLIER=join(import.meta.dirname,'..','xmr20-tokens','earlier'),VIEWS=join(import.meta.dirname,'views'),BLOCK_TIMES=join(import.meta.dirname,'..','ownership-index','result','block-times.json'),GROUPS=join(import.meta.dirname,'..','ownership-index','collections','collections.json');
const KINDS=new Set(['claim','move','list','cancel','reserve','sale','collection','mint','burn']);
const fail=(message,status=400)=>{const e=Error(message);e.status=status;return e;};
const isJson=bytes=>{try{JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));return true;}catch{return false;}};
const int=(v,fallback,min,max)=>{const n=v==null||v===''?NaN:Number(v);return Number.isInteger(n)?Math.min(max,Math.max(min,n)):fallback;};

export function createService({reader,relay=null,owners,transfers=[],blockTimes=null,groups=null,content=null,collections=new Map(),views=null,origins=[],extensions=null,behindProxy=false,testHooks=false,extra=null,xmr20=null,earlier=null,follower=null,followLimit=25,followBudget=1000,chunk=4000,rate={perSecond:2,burst:60},log=()=>{}}){
 const m=reader.meta,list=owners.map(served),numbers=owners.map(o=>o.number),entry=new Map(owners.map(o=>[o.number,o])),byReg=new Map(owners.map(o=>[o.registrationTx,o]));
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
   groupList.push({id:g.id,name:g.display||g.name,fullName:g.name,basis:g.basis,members});for(const n of members)if(!groupOf.has(n))groupOf.set(n,g.id);}
  const first=new Map((groups.featured||[]).map((id,i)=>[id,i]));groupList.sort((a,b)=>(first.get(a.id)??1e9)-(first.get(b.id)??1e9)||b.members.length-a.members.length||a.name.localeCompare(b.name));
  for(const n of open(groups.sensitiveByLabel||[]))labelled.add(n);}
 const groupById=new Map(groupList.map(g=>[g.id,g]));
 // The original Mordinals history, oldest first: every registration and every transfer under the 2023 rules.
 const legacy=[...owners.map(o=>({kind:'inscribed',number:o.number,height:o.registrationHeight??null,time:timeAt(o.registrationHeight),txid:o.registrationTx,size:o.bodySize??null})),
  ...[...old].flatMap(([number,list])=>list.map(t=>({...t,number})))].sort((a,b)=>(a.height??0)-(b.height??0)||a.number-b.number);
 // Answers that only change when the reader moves are kept until it does.
 let memoAt='',memo=new Map();
 const once=(key,make)=>{const at=reader.height+':'+reader.journal.length+':'+reader.hash;if(at!==memoAt){memoAt=at;memo=new Map();}if(!memo.has(key))memo.set(key,make());return memo.get(key);};
 const L=()=>reader.ledger;
 const lotView=id=>{const l=L().lot(id),r=l.reservations.at(-1)||null;
  return {id:l.id,number:l.number,nft:l.number==null?l.reg:null,reg:l.reg,seller:l.seller,price:l.price.toString(),until:l.until,status:l.status,body:reader.body(l.id),
   reservation:r?{record:r.record,buyer:r.buyer,height:r.height,payBy:r.payBy,rate:r.rate}:null,buyer:l.sale?.buyer||null};};
 const state=n=>{const x=L().mordinal(n);return {number:x.number,reg:x.reg,claimed:x.claimed,owner:x.owner,...(x.burned?{burned:true}:{}),seq:x.seq,lot:x.lot?lotView(x.lot):null};};
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
 const open=()=>once('open',()=>reader.lots.map(lotView).filter(l=>l.status==='open'));
 const claimed=()=>once('claimed',()=>numbers.filter(n=>L().mordinal(n).claimed));
 const card=n=>{const o=entry.get(n),s=state(n);return {number:n,reg:s.reg,claimed:s.claimed,owner:s.owner,...(s.burned?{burned:true}:{}),bodySize:o.bodySize??null,group:groupOf.get(n)??null,
  lot:s.lot?{id:s.lot.id,price:s.lot.price,until:s.lot.until,seller:s.lot.seller,reserved:Boolean(s.lot.reservation&&heldUntil(s.lot.reservation)>=reader.height)}:null};};
 const which=text=>{const t=decodeURIComponent(text);const o=/^\d{1,9}$/.test(t)?entry.get(Number(t)):/^[0-9a-f]{64}$/.test(t)?byReg.get(t):null;if(!o)throw fail('This is not a Mordinal on the owner list.',404);return o;};
 const stats=()=>once('stats',()=>{const by={};let volume=0n,fees=0n;for(const e of reader.events){by[e.kind]=(by[e.kind]||0)+1;if(e.kind==='sale'){volume+=BigInt(e.price);fees+=BigInt(e.fee);}}
  return {height:reader.height,mordinals:list.length,claimed:claimed().length,forSale:open().filter(l=>l.until>=reader.height).length,sales:by.sale||0,volume:volume.toString(),fees:fees.toString(),
   records:reader.journal.filter(e=>e.ok).length,refused:reader.journal.filter(e=>!e.ok).length,byKind:by,checkpoint:reader.checkpoints.at(-1)||null};});
 const waitingFor=q=>relay?relay.waitingFor(q):[];
 // One sync and relay pass. The loop below runs it on a timer; tests call it directly.
 let stepping=null;
 const step=()=>{if(!stepping)stepping=(async()=>{const r=await reader.sync();const t=relay?await relay.tick():null;const f=await earlierStep();return {...r,relay:t,...(f?{earlier:f}:{})};})().finally(()=>{stepping=null;});return stepping;};

 async function route(method,url,body,req){
  const path=url.pathname,q=url.searchParams,height=reader.height;
  if(method==='GET'){
   if(path==='/info')return {network:m.network,domain:m.domain,feeAddress:m.feeAddress,height,count:list.length,chunk,test:Boolean(testHooks),owners:m.owners,start:m.start,startHash:m.startHash,mintFrom:m.mintFrom??null,...(m.minters?{minters:m.minters.split(',')}:{}),...(m.openFrom!=null?{openFrom:m.openFrom}:{}),...(xmr20||E?{xmr20:{...(xmr20?{inscribers:xmr20.inscribers}:{}),...(E?{earlier:earlierInfo()}:{})}}:{}),
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
   if(path==='/records'){const all=reader.journal.filter(e=>e.ok),from=int(q.get('from'),0,0,all.length),limit=int(q.get('limit'),1000,1,5000);
    return {height,total:all.length,from,records:all.slice(from,from+limit).map(e=>e.record)};}
   if(path.startsWith('/status/')){const id=path.slice(8);if(!/^[0-9a-f]{64}$/.test(id))throw fail('A record code is 64 hexadecimal characters.');
    if(relay)return {height,...relay.status(id)};const e=reader.entryById(id);
    return e?{height,id,state:'done',txid:e.txid,confirmations:height-e.height+1,error:null}:{height,id,state:'unknown',txid:null,confirmations:0,error:null};}
   // A transaction as the node gives it, for a wallet that makes payment proofs. In the pool: height null.
   if(path.startsWith('/tx/')){const id=path.slice(4);if(!/^[0-9a-f]{64}$/.test(id))throw fail('A transaction ID is 64 hexadecimal characters.');
    if(!allow(caller(req)))throw fail('Too many requests. Try again in a minute.',429);
    const [t]=await reader.lookup([id]);if(!t)throw fail('The Monero node does not know this transaction yet.',404);return {height,payment:t};}
   // What became of the record a transaction carried: its entry in this reader's journal, accepted or refused.
   if(path.startsWith('/entry/')){const id=path.slice(7);if(!/^[0-9a-f]{64}$/.test(id))throw fail('A transaction ID is 64 hexadecimal characters.');
    const e=reader.entryByTx(id);if(!e)throw fail('This reader has read no record in this transaction.',404);
    return {height,entry:{txid:e.txid,height:e.height,pos:e.pos,id:e.id??null,op:e.op??null,ok:e.ok,...(e.ok?{}:{error:e.error})},confirmations:height-e.height+1};}
   if(path==='/pending')return {height,jobs:relay?relay.pending():[],pool:await poolNow()};
   if(path==='/stats')return stats();
   if(path==='/activity'||path==='/sales'){
    const kind=path==='/sales'?'sale':q.get('kind'),number=q.has('number')?Number(q.get('number')):null,address=q.get('address'),limit=int(q.get('limit'),50,1,200);
    if(kind&&!KINDS.has(kind))throw fail('Unknown kind.');
    const all=reader.events,before=int(q.get('before'),all.length,0,all.length),out=[];let at=before;
    while(at>0&&out.length<limit){const e=all[--at];
     if(kind&&e.kind!==kind)continue;if(number!=null&&e.number!==number)continue;
     if(address&&![e.to,e.from,e.seller,e.buyer].includes(address))continue;out.push({at,...e,confirmations:height-e.height+1});}
    return {height,total:all.length,next:at>0?at:null,events:out};}
   // The original history (inscriptions and transfers under the 2023 rules), newest first, by pages.
   if(path==='/history'){const kind=q.get('kind');if(kind&&kind!=='inscribed'&&kind!=='transfer')throw fail('Unknown kind.');
    const limit=int(q.get('limit'),50,1,200),before=int(q.get('before'),legacy.length,0,legacy.length),out=[];let at=before;
    while(at>0&&out.length<limit){const e=legacy[--at];if(kind&&e.kind!==kind)continue;out.push({at,...e});}
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
   if(path.startsWith('/mordinal/')){const o=which(path.slice(10)),s=state(o.number);
    // The whole public story of one Mordinal: inscribed, moved by spending (2023), then claimed and moved by record.
    const history=[{kind:'inscribed',height:o.registrationHeight??null,time:timeAt(o.registrationHeight),txid:o.registrationTx},...(old.get(o.number)||[]),
     ...reader.events.filter(e=>e.number===o.number).map(e=>({...e,confirmations:height-e.height+1}))];
    const gid=groupOf.get(o.number);
    return {height,mordinal:{...s,group:gid?{id:gid,name:groupById.get(gid).name}:null,registrationHeight:o.registrationHeight??null,ownerTx:o.ownerTx,ownerHeight:o.ownerHeight??null,bodySize:o.bodySize??null,bodySha256:o.bodySha256||null},
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
 function allow(ip){const t=Date.now(),b=buckets.get(ip)||{tokens:rate.burst,at:t};b.tokens=Math.min(rate.burst,b.tokens+(t-b.at)/1000*rate.perSecond);b.at=t;
  if(buckets.size>10000)buckets.clear();buckets.set(ip,b);if(b.tokens<1)return false;b.tokens-=1;return true;}
 async function picture(res,text){
  const o=which(text),got=content?await content(o):{status:404,error:'This service has no pictures.'};
  const head={'x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; sandbox",'cross-origin-resource-policy':'cross-origin'};
  if(got.status!==200){res.writeHead(got.status,{...head,'content-type':'application/json','cache-control':got.status===502?'no-store':'public, max-age=3600'});res.end(JSON.stringify({error:got.error}));return;}
  res.writeHead(200,{...head,'content-type':got.type,'content-length':got.bytes.length,'cache-control':'public, max-age=31536000, immutable','x-mordinal-sensitive':got.sensitive||labelled.has(o.number)?'1':'0','x-mordinal-sha256':o.bodySha256});res.end(got.bytes);}
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
   if(req.method==='GET'&&url.pathname.startsWith('/content/')){if(headers['access-control-allow-origin'])for(const k of ['access-control-allow-origin','access-control-expose-headers','vary'])res.setHeader(k,headers[k]);return await picture(res,url.pathname.slice(9));}
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

// Everything from command-line style options: used by the command below and by tests.
export async function startService(o){
 const owners=readOwners(o.owners),chain=createChain(o.node),network=o.network||'mainnet';
 const reader=openReader({dir:o.state,chain,network,domain:o.domain,feeAddress:o.feeAddress,owners,start:Number(o.start),startHash:o.startHash||null,mintFrom:o.mintFrom==null?null:Number(o.mintFrom),minters:o.minters??null,openFrom:o.openFrom==null?null:Number(o.openFrom),checkpointEvery:o.checkpointEvery??720,log:o.log});
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
 const service=createService({reader,relay,owners,transfers:o.transfers?readOwners(o.transfers):[],blockTimes:times?JSON.parse(readFileSync(times,'utf8')).times:null,groups:groupFile?JSON.parse(readFileSync(groupFile,'utf8')):null,content:source?createContent({source}):null,collections,views:o.views||(existsSync(VIEWS)?VIEWS:null),xmr20:o.xmr20Inscribers?.length?{inscribers:o.xmr20Inscribers.map(a=>canonical(a,network))}:null,
  earlier,follower,...(o.followLimit?{followLimit:o.followLimit}:{}),origins:o.origins||[],extensions:o.extensions?.length?o.extensions:null,behindProxy:Boolean(o.behindProxy),testHooks:Boolean(o.testHooks),...(o.rate?{rate:o.rate}:{}),log:o.log});
 // The views are made from what the follower's folder holds before anything is served; a few seconds at most are waited for it.
 await Promise.race([service.ready,new Promise(done=>{setTimeout(done,5000).unref?.();})]);const port=await service.listen(o.port==null?18951:Number(o.port));return {...service,port,chain,owners};}

if(process.argv[1]===import.meta.filename){
 // Every word that begins with a dash is an option this program knows, written "--name value", and given once (the
 // two lists of allowed origins and extensions may repeat). A misspelt option stops the start: an ignored
 // --open-from or --minters would make this another ledger than the one that was meant.
 {const KNOWN=new Set(['owners','transfers','block-times','groups','domain','fee-address','node','start','start-hash','mint-from','minters','open-from','state','network','port','every','xmr20-inscribers','xmr20-earlier','no-xmr20-earlier','no-xmr20-follow',
   'mint-fee','collection-fee','carrier-bin','carrier-state','carrier-start','carrier-network','relay-limits','content-dir','content-archive','collections','views','allow-origin','allow-extension','behind-proxy','test-hooks']),MANY=new Set(['allow-origin','allow-extension']),seen=new Set();
  for(const a of process.argv.slice(2)){if(!a.startsWith('-'))continue;
   if(a.includes('='))throw Error(`Write "${a.split('=')[0]} <value>", with a space: ${a}`);
   const name=a.startsWith('--')?a.slice(2):null;if(!name||!KNOWN.has(name))throw Error(`There is no option ${a}. See the top of this file.`);
   if(seen.has(name)&&!MANY.has(name))throw Error(`--${name} is given twice.`);seen.add(name);}}
 const arg=name=>{const i=process.argv.indexOf('--'+name);return i<0?null:process.argv[i+1];},has=name=>process.argv.includes('--'+name);
 for(const need of ['owners','domain','fee-address','node','start','state'])if(!arg(need)){console.error('Missing --'+need+'. See the top of this file.');process.exit(2);}
 const archive=has('content-archive')?(arg('content-archive')?.startsWith('http')?arg('content-archive'):true):null;
 // --relay-limits minReady=4,splitInto=12,buyReserve=2: whole numbers for the relay's limits (lib/relay.mjs DEFAULT_LIMITS).
 const limits=Object.fromEntries((arg('relay-limits')||'').split(',').filter(Boolean).map(kv=>{const [k,v]=kv.split('=');if(!/^[a-zA-Z]+$/.test(k)||!/^\d{1,12}$/.test(v||''))throw Error('--relay-limits: name=number,…');return [k,Number(v)];}));
 const s=await startService({...(Object.keys(limits).length?{limits}:{}),owners:arg('owners'),transfers:arg('transfers'),...(arg('block-times')?{blockTimes:arg('block-times')}:{}),...(arg('groups')?{groups:arg('groups')}:{}),domain:arg('domain'),feeAddress:arg('fee-address'),node:arg('node'),start:arg('start'),startHash:arg('start-hash'),mintFrom:arg('mint-from'),
  // --minters given means a list: an empty value is refused, never read as "everyone".
  ...(has('minters')?{minters:(arg('minters')||'').split(',').filter(Boolean)}:{}),...(has('open-from')?{openFrom:(v=>{if(!/^[1-9]\d{0,9}$/.test(v||''))throw Error('--open-from <height>: the opening block is a whole number');return Number(v);})(arg('open-from'))}:{}),state:arg('state'),network:arg('network'),xmr20Inscribers:(arg('xmr20-inscribers')||'').split(',').filter(Boolean),...(has('no-xmr20-earlier')?{xmr20Earlier:false}:arg('xmr20-earlier')?{xmr20Earlier:arg('xmr20-earlier')}:{}),...(has('no-xmr20-follow')?{xmr20Follow:false}:{}),
  port:arg('port'),fees:{mint:arg('mint-fee')||0,collection:arg('collection-fee')||0},carrierBin:arg('carrier-bin'),carrierState:arg('carrier-state'),carrierStart:arg('carrier-start'),carrierNetwork:arg('carrier-network'),contentDir:arg('content-dir'),collections:arg('collections'),contentArchive:archive,views:arg('views'),
  origins:process.argv.flatMap((a,i)=>a==='--allow-origin'?[process.argv[i+1]]:[]),extensions:process.argv.flatMap((a,i)=>a==='--allow-extension'?[process.argv[i+1]]:[]),behindProxy:has('behind-proxy'),testHooks:has('test-hooks'),log:v=>console.log(new Date().toISOString(),JSON.stringify(v))});
 console.log(`Mordinals reader on http://127.0.0.1:${s.port} (${s.owners.length} Mordinals, block ${s.reader.height}${s.relay?', relay on':', reader only'})`);
 s.follow(Number(arg('every'))||5000);
}
