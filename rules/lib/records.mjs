// MD1 records: claim, move, list, cancel, reserve, buy, and collection, mint, burn (RULES.md). Draft.
//   record   = "MD1\xfe" op(u8) body [proof or signature]
//   op 1 claim    reg32 ownerTx32 to proof(u8) [holder when proof = 1 or 2] [spendTx32 keyImage32 when proof = 2]
//                 proof 0 (one-time key):       c32 r32
//                 proof 1 (payment proof + message): D32 pc32 pr32 variant(u8) c32 r32
//                 proof 2 (spent coin: payment proof + signed key image + message): D32 pc32 pr32 kc32 kr32 variant(u8) c32 r32
//   op 2 move     reg32 seq(u32) from to                              variant c32 r32
//   op 3 list     reg32 seq(u32) until(u32) price(u64 piconero) seller variant c32 r32
//   op 4 cancel   lot32 seller                                        variant c32 r32
//   op 5 reserve  lot32 payBy(u32) buyer rate(u16) [market when rate > 0]  variant c32 r32
//   op 6 buy      lot32 n(u8) n×(txid32 out(u8) D32 c32 s32)           (no signature) one entry per payee, in the
//                 reservation's order: seller, protocol fee, marketplace fee when it names one. out = output number,
//                 D c s = the payment proof (payment.mjs). 296 or 425 bytes.
//   op 7 collection creator max(u32) flags(u8, 0) name(len u8, 1–64)   variant c32 r32
//   op 8 mint     collection32 edition(u32) creator flags(u8) [to] name(len u8, 0–64) type(u8) content(len u16, 1+)
//                 [origin: kind(u8) ref(len u8, 1–64)]                 variant c32 r32
//                 flags bit 0: the first owner is `to` (else the creator); bit 1: an origin follows the content.
//                 collection32 is all zero for an NFT that belongs to no collection (then edition is 0).
//   op 9 burn     nft32 seq(u32) owner                                 variant c32 r32
//   op 10 offer   bidder price(u64) until(u32) count(u16) kind(u8) ref32 rate(u16) [market when rate > 0]  variant c32 r32
//                 kind 0: one NFT (ref = its 32 bytes); 1: a collection made on this ledger (its id); 2: a set of
//                 Mordinals (the root of its list, offers.mjs)
//   op 11 accept  offer32 reg32 seq(u32) seller n(u8) n×hash32          variant c32 r32   (the path, for a set)
//   op 12 withdraw offer32 bidder                                      variant c32 r32
//   An NFT is named by 32 bytes: a Mordinal's registration transaction, or the id of a mint record.
//   address  = kind(u8: 0 main address, 1 subaddress) B32 A32
//   id       = SHA-256("MORDINALS-RECORD-v1\0" || domain32 || "MD1\xfe" op body); a listing's id is its lot id
//   code     = first 16 bytes of the id, in the signed text
// The text a wallet signs is rebuilt from the record bytes and the ledger (inscription number, listing terms), so a signature
// cannot be attached to anything else. variant says how the wallet ended the text: 0 nothing, 1 "\n", 2 "\r\n".
import {sha256} from '@noble/hashes/sha256';
import {decodeAddress,encodeAddress,verifySpendSignature,usableSpendKey,parseSignature,hex,unhex,concat,le,leBytes} from './monero.mjs';
const enc=new TextEncoder();
export const MAGIC=Uint8Array.of(0x4d,0x44,0x31,0xfe),OP={claim:1,move:2,list:3,cancel:4,reserve:5,buy:6,collection:7,mint:8,burn:9,offer:10,accept:11,withdraw:12},PROOF={outputKey:0,payment:1,spend:2};
// A record travels in one relayed transaction, which leaves this many bytes for it (RULES.md section 8).
export const MAX_RECORD=1000,NO_COLLECTION='0'.repeat(64),MAX_EDITIONS=10000,MAX_NAME=64,ORIGIN={bitcoinInscription:1};
// Draft parameters. The fee address is given to the ledger; rate, cap, minimum price and window are the draft values of RULES.md section 7.
// settle: blocks after a reservation's pay-by block in which the listing stays held for it, so a buyer who paid in time
// can still get the purchase recorded before anyone else may reserve.
// maxListing: a listing ends at most this many blocks (about 30 days) after the block of its record.
// maxOffer: an offer ends at most this many blocks (about 7 days) after the block of its record; maxOfferCount: the most
// pieces one offer asks for; maxPath: the longest path an accept carries (offers.mjs).
export const RULES={feeBps:500,marketFeeCapBps:500,minPrice:10n**9n,maxReserve:30,settle:10,maxPayments:3,maxKeys:17,maxListing:21600,maxOffer:5040,maxOfferCount:100,maxPath:20};
export const SCOPE={nft:0,collection:1,set:2};
// The last block at which a reservation still holds its listing (no other reservation, no cancel).
export const heldUntil=reservation=>reservation.payBy+RULES.settle;
export const SUFFIX=['','\n','\r\n'],U64=(1n<<64n)-1n,TX_EXTRA_LIMIT=1060;
const HEX32=/^[0-9a-f]{64}$/,ID_TAG=concat(enc.encode('MORDINALS-RECORD-v1'),Uint8Array.of(0));
const u16=n=>leBytes(BigInt(n),2),u32=n=>leBytes(BigInt(n),4),u64=n=>{if(n<0n||n>U64)throw Error('Amount out of range');return leBytes(n,8);};
const height=(n,what)=>{if(!Number.isInteger(n)||n<1||n>0xffffffff)throw Error('Bad '+what);return u32(n);};
const id32=(h,what)=>{if(!HEX32.test(h||''))throw Error(what+' required');return unhex(h);};
export const formatXmr=p=>{const s=BigInt(p).toString().padStart(13,'0'),f=s.slice(-12).replace(/0+$/,'');return s.slice(0,-12)+(f?'.'+f:'');};
export function parseXmr(text){const t=String(text).trim().replace(/[,\s_]/g,'');const m=/^(\d+)(?:\.(\d{1,12}))?$/.exec(t);if(!m)throw Error('Enter a price in XMR like 0.5 (up to 12 decimals).');
 const v=BigInt(m[1])*10n**12n+BigInt((m[2]||'').padEnd(12,'0'));if(v<=0n)throw Error('Enter a price above 0.');if(v>U64)throw Error('That price is too large.');return v;}
// An address in a record. Its spend key must be able to sign, or nothing could ever move what it holds, and its view
// key must be a real key of the same kind, or a payment to it could not be checked or found.
const party=(address,network)=>{const a=decodeAddress(address,network);if(!usableSpendKey(a.spend))throw Error('This address cannot sign');
 if(!usableSpendKey(a.view))throw Error('This address has an unusable view key');return concat(Uint8Array.of(a.kind==='sub'?1:0),a.spend,a.view);};
export const canonical=(address,network='mainnet')=>encodeAddress(decodeAddress(address,network));
// A name: printable ASCII with no space at either end and no double quote, so it reads the same wherever it is shown
// or signed and cannot close the quotes a signed text puts around it.
const NAME=/^[\x21\x23-\x7e](?:[\x20\x21\x23-\x7e]*[\x21\x23-\x7e])?$/;
const nameBytes=(text,least)=>{const t=String(text??'');if(t.length<least||t.length>MAX_NAME||(t&&!NAME.test(t)))throw Error(least?`A name is 1 to ${MAX_NAME} plain characters with no space at either end and no double quote.`:`A name is at most ${MAX_NAME} plain characters with no space at either end and no double quote.`);
 return concat(Uint8Array.of(t.length),enc.encode(t));};
const readName=(r,least)=>{const n=r.u8(),t=String.fromCharCode(...r.take(n));if(n<least||n>MAX_NAME||(n&&!NAME.test(t)))throw Error('Bad name');return t;};
function reader(b){let at=0;const take=n=>{if(at+n>b.length)throw Error('Record is truncated');const v=b.subarray(at,at+n);at+=n;return v;};
 return {take,u8:()=>take(1)[0],u16:()=>Number(le(take(2))),u32:()=>Number(le(take(4))),u64:()=>le(take(8)),hex32:()=>hex(take(32)),get at(){return at;},get left(){return b.length-at;}};}
const readParty=(r,network)=>{const k=r.u8();if(k>1)throw Error('Unknown address kind');const spend=r.take(32).slice(),view=r.take(32).slice();
 if(!usableSpendKey(spend))throw Error('An address in this record cannot sign');if(!usableSpendKey(view))throw Error('An address in this record has an unusable view key');return encodeAddress({spend,view,kind:k?'sub':'main',network});};

export function encodeBody(op,b,network='mainnet'){
 const head=concat(MAGIC,Uint8Array.of(op));
 if(op===OP.claim){if(b.proof!==PROOF.outputKey&&b.proof!==PROOF.payment&&b.proof!==PROOF.spend)throw Error('Unknown proof kind');
  return concat(head,id32(b.reg,'Inscription transaction'),id32(b.ownerTx,'Owner transaction'),party(b.to,network),Uint8Array.of(b.proof),b.proof===PROOF.outputKey?new Uint8Array(0):party(b.holder,network),
   b.proof===PROOF.spend?concat(id32(b.spendTx,'Spending transaction'),id32(b.keyImage,'Key image')):new Uint8Array(0));}
 if(op===OP.move)return concat(head,id32(b.reg,'Inscription transaction'),u32(b.seq),party(b.from,network),party(b.to,network));
 if(op===OP.list){if(!(b.price>0n))throw Error('Price must be above 0');return concat(head,id32(b.reg,'Inscription transaction'),u32(b.seq),height(b.until,'expiry height'),u64(b.price),party(b.seller,network));}
 if(op===OP.cancel)return concat(head,id32(b.lot,'Listing id'),party(b.seller,network));
 if(op===OP.reserve){const rate=b.rate||0;if(!Number.isInteger(rate)||rate<0||rate>0xffff)throw Error('Bad marketplace fee rate');if(!rate&&b.market)throw Error('A marketplace address needs a rate');
  return concat(head,id32(b.lot,'Listing id'),height(b.payBy,'pay-by height'),party(b.buyer,network),u16(rate),rate?party(b.market,network):new Uint8Array(0));}
 if(op===OP.buy){const p=b.payments||[];if(p.length<2||p.length>RULES.maxPayments)throw Error('A buy record names 2 or 3 payments');
  return concat(head,id32(b.lot,'Listing id'),Uint8Array.of(p.length),...p.flatMap(x=>{if(!Number.isInteger(x.out)||x.out<0||x.out>255)throw Error('Output number required');
   return [id32(x.txid,'Payment transaction'),Uint8Array.of(x.out),id32(x.D,'Payment proof'),id32(x.c,'Payment proof'),id32(x.s,'Payment proof')];}));}
 if(op===OP.collection){if(!Number.isInteger(b.max)||b.max<1||b.max>MAX_EDITIONS)throw Error(`A collection has 1 to ${MAX_EDITIONS} editions`);
  return concat(head,party(b.creator,network),u32(b.max),Uint8Array.of(0),nameBytes(b.name,1));}
 if(op===OP.mint){const collection=b.collection||NO_COLLECTION,edition=b.edition||0,content=Uint8Array.from(b.content||[]),creator=canonical(b.creator,network);
  if(collection===NO_COLLECTION?edition!==0:!(Number.isInteger(edition)&&edition>=1&&edition<=MAX_EDITIONS))throw Error('Bad edition number');
  if(!Number.isInteger(b.type)||b.type<1||b.type>255)throw Error('Content type required');if(!content.length||content.length>0xffff)throw Error('Content required');
  const to=b.to&&canonical(b.to,network)!==creator?b.to:null,o=b.origin||null;
  if(o&&(!Number.isInteger(o.kind)||o.kind<1||o.kind>255||!/^(?:[0-9a-f]{2}){1,64}$/.test(o.ref||'')))throw Error('Bad origin');
  return concat(head,id32(collection,'Collection id'),u32(edition),party(creator,network),Uint8Array.of((to?1:0)|(o?2:0)),to?party(to,network):new Uint8Array(0),
   nameBytes(b.name,0),Uint8Array.of(b.type),u16(content.length),content,o?concat(Uint8Array.of(o.kind,o.ref.length/2),unhex(o.ref)):new Uint8Array(0));}
 if(op===OP.burn)return concat(head,id32(b.nft,'NFT id'),u32(b.seq),party(b.owner,network));
 if(op===OP.offer){const rate=b.rate||0;if(!(b.price>0n))throw Error('Price must be above 0');if(!Number.isInteger(rate)||rate<0||rate>0xffff)throw Error('Bad marketplace fee rate');if(!rate&&b.market)throw Error('A marketplace address needs a rate');
  if(!Number.isInteger(b.count)||b.count<1||b.count>RULES.maxOfferCount)throw Error(`An offer is for 1 to ${RULES.maxOfferCount} pieces`);if(![SCOPE.nft,SCOPE.collection,SCOPE.set].includes(b.kind))throw Error('Unknown kind of offer');
  return concat(head,party(b.bidder,network),u64(b.price),height(b.until,'last block'),u16(b.count),Uint8Array.of(b.kind),id32(b.ref,'What the offer is for'),u16(rate),rate?party(b.market,network):new Uint8Array(0));}
 if(op===OP.accept){const path=b.path||[];if(path.length>RULES.maxPath)throw Error('The path is too long');
  return concat(head,id32(b.offer,'Offer id'),id32(b.reg,'NFT id'),u32(b.seq),party(b.seller,network),Uint8Array.of(path.length),...path.map(p=>id32(p,'Path entry')));}
 if(op===OP.withdraw)return concat(head,id32(b.offer,'Offer id'),party(b.bidder,network));
 throw Error('Unknown operation');}
export const signedOp=op=>op===OP.move||op===OP.list||op===OP.cancel||op===OP.reserve||op===OP.collection||op===OP.mint||op===OP.burn||op===OP.offer||op===OP.accept||op===OP.withdraw;
// Strict decode of a whole record, or of a body alone (sig: false). Nothing may follow the last field.
// spend: false reads a claim with proof 2 (section 11) as an unknown proof kind, as it reads on a ledger, or in a block,
// where claims by a spent coin do not count; a reader decodes so, and its log stays what it was before proof 2 existed.
// offers: false reads an offer, an accept and a withdrawal (section 13) as an unknown operation, in the same way.
export function decodeRecord(bytes,network='mainnet',{sig=true,spend=true,offers=true}={}){
 const r=reader(bytes);if(hex(r.take(4))!==hex(MAGIC))throw Error('Not an MD1 record');const op=r.u8();let body,proof=null;
 if(op===OP.claim){const reg=r.hex32(),ownerTx=r.hex32(),to=readParty(r,network),kind=r.u8();if(kind>(spend?2:1))throw Error('Unknown proof kind');
  body={reg,ownerTx,to,proof:kind};if(kind!==PROOF.outputKey)body.holder=readParty(r,network);if(kind===PROOF.spend){body.spendTx=r.hex32();body.keyImage=r.hex32();}}
 else if(op===OP.move)body={reg:r.hex32(),seq:r.u32(),from:readParty(r,network),to:readParty(r,network)};
 else if(op===OP.list){body={reg:r.hex32(),seq:r.u32(),until:r.u32(),price:r.u64(),seller:readParty(r,network)};if(!(body.price>0n)||!body.until)throw Error('Bad listing');}
 else if(op===OP.cancel)body={lot:r.hex32(),seller:readParty(r,network)};
 else if(op===OP.reserve){body={lot:r.hex32(),payBy:r.u32(),buyer:readParty(r,network),rate:r.u16()};if(!body.payBy)throw Error('Bad pay-by height');if(body.rate)body.market=readParty(r,network);}
 else if(op===OP.buy){const lot=r.hex32(),n=r.u8();if(n<2||n>RULES.maxPayments)throw Error('A buy record names 2 or 3 payments');const payments=[];
  for(let i=0;i<n;i++)payments.push({txid:r.hex32(),out:r.u8(),D:r.hex32(),c:r.hex32(),s:r.hex32()});
  if(new Set(payments.map(p=>p.txid+':'+p.out)).size!==n)throw Error('A payment output appears twice');body={lot,payments};}
 else if(op===OP.collection){body={creator:readParty(r,network),max:r.u32()};if(body.max<1||body.max>MAX_EDITIONS)throw Error('Bad edition count');if(r.u8()!==0)throw Error('Unknown collection flags');body.name=readName(r,1);}
 else if(op===OP.mint){body={collection:r.hex32(),edition:r.u32(),creator:readParty(r,network)};const flags=r.u8();if(flags>3)throw Error('Unknown mint flags');
  if(body.collection===NO_COLLECTION?body.edition!==0:body.edition<1||body.edition>MAX_EDITIONS)throw Error('Bad edition number');
  if(flags&1){body.to=readParty(r,network);if(body.to===body.creator)throw Error('The first owner is written only when it is not the creator');}
  body.name=readName(r,0);body.type=r.u8();if(!body.type)throw Error('Unknown content type');const n=r.u16();if(!n)throw Error('A mint has content');body.content=r.take(n).slice();
  if(flags&2){const kind=r.u8(),len=r.u8();if(!kind||len<1||len>64)throw Error('Bad origin');body.origin={kind,ref:hex(r.take(len))};}}
 else if(op===OP.burn)body={nft:r.hex32(),seq:r.u32(),owner:readParty(r,network)};
 else if(offers&&op===OP.offer){body={bidder:readParty(r,network),price:r.u64(),until:r.u32(),count:r.u16(),kind:r.u8(),ref:r.hex32(),rate:r.u16()};
  if(!(body.price>0n)||!body.until||body.count<1||body.count>RULES.maxOfferCount||body.kind>SCOPE.set)throw Error('Bad offer');if(body.rate)body.market=readParty(r,network);}
 else if(offers&&op===OP.accept){body={offer:r.hex32(),reg:r.hex32(),seq:r.u32(),seller:readParty(r,network)};const n=r.u8();if(n>RULES.maxPath)throw Error('The path is too long');body.path=Array.from({length:n},()=>r.hex32());}
 else if(offers&&op===OP.withdraw)body={offer:r.hex32(),bidder:readParty(r,network)};
 else throw Error('Unknown operation');
 const bodyBytes=bytes.slice(0,r.at);
 if(sig){
  if(op===OP.claim&&body.proof===PROOF.outputKey)proof={c:r.take(32).slice(),r:r.take(32).slice()};
  else if(op===OP.claim)proof={D:r.take(32).slice(),pc:r.take(32).slice(),pr:r.take(32).slice(),...(body.proof===PROOF.spend?{kc:r.take(32).slice(),kr:r.take(32).slice()}:{}),variant:r.u8(),c:r.take(32).slice(),r:r.take(32).slice()};
  else if(signedOp(op))proof={variant:r.u8(),c:r.take(32).slice(),r:r.take(32).slice()};
  if(proof&&'variant' in proof&&proof.variant>=SUFFIX.length)throw Error('Unknown text ending');}
 if(r.left)throw Error('Record has extra bytes');
 return {op,body,bodyBytes,proof};}

export const recordId=(domain,bodyBytes)=>hex(sha256(concat(ID_TAG,unhex(domain),bodyBytes)));
export const codeOf=id=>id.slice(0,32);
// What the buyer pays. The same small tail (1 to 999,999 piconero, from the reservation's code) is added to every payment, so a
// payment fits one reservation only. The marketplace fee, when the reservation names one, is paid on top of the price.
export function amounts({price,rate=0,code}){
 const tail=1n+BigInt(parseInt(code.slice(0,8),16)%999999),fee=price*BigInt(RULES.feeBps)/10000n,market=rate?price*BigInt(rate)/10000n:0n;
 return {tail,fee,marketFee:market,seller:price-fee+tail,protocol:fee+tail,market:rate?market+tail:0n};}
export const splitOf=price=>{const fee=price*BigInt(RULES.feeBps)/10000n;return {fee,seller:price-fee};};

// The exact text to sign. ctx: {domain, number (inscription number), lot (for cancel and reserve), feeAddress}.
// ctx.what names the NFT in the text: "Mordinal #7" for a Mordinal (so those texts are what they always were), and
// nftLabel() for a minted NFT.
export const nftLabel=(id,minted,collectionName)=>minted.collection===NO_COLLECTION?`NFT ${codeOf(id)}`:`"${collectionName}" #${minted.edition} (NFT ${codeOf(id)})`;
export function renderText(op,b,bodyBytes,ctx){
 const code=codeOf(recordId(ctx.domain,bodyBytes)),n=ctx.number,what=ctx.what??`Mordinal #${n}`;
 if(op===OP.collection)return `XMR721 collection: create "${b.name}" with ${b.max} editions, minted only by ${b.creator}; code ${code}`;
 if(op===OP.mint)return `XMR721 mint: ${b.collection===NO_COLLECTION?'one NFT in no collection':`edition ${b.edition} of "${ctx.collectionName}"`}${b.name?` named "${b.name}"`:''}; ${b.content.length} bytes of type ${b.type}, SHA-256 ${hex(sha256(b.content))}`
  +(b.origin?`; from ${b.origin.kind}:${b.origin.ref}`:'')+`; first owner ${b.to||b.creator}; code ${code}`;
 if(op===OP.burn)return `XMR721 burn: destroy ${what} for good; burn ${b.seq}; code ${code}`;
 if(op===OP.claim)return `Mordinals claim: Mordinal #${n} (inscription ${b.reg}), held by output 0 of ${b.ownerTx}${b.proof===PROOF.spend?` and spent in ${b.spendTx}`:''}, now belongs to ${b.to}; code ${code}`;
 if(op===OP.move)return `Mordinals move: send ${what} to ${b.to}; move ${b.seq}; code ${code}`;
 if(op===OP.list){const s=splitOf(b.price);return `Mordinals list: sell ${what} for ${formatXmr(b.price)} XMR (${formatXmr(s.seller)} XMR to ${b.seller}, ${formatXmr(s.fee)} XMR protocol fee); valid until block ${b.until}; code ${code}`;}
 if(op===OP.cancel)return `Mordinals cancel: stop selling ${what}; listing ${codeOf(b.lot)}; code ${code}`;
 if(op===OP.reserve){const l=ctx.lot,a=amounts({price:l.price,rate:b.rate,code});
  return `Mordinals reserve: buy ${what} for ${formatXmr(l.price)} XMR; pay exactly ${formatXmr(a.seller)} XMR to ${l.seller} and exactly ${formatXmr(a.protocol)} XMR to ${ctx.feeAddress}`
   +(b.rate?` and exactly ${formatXmr(a.market)} XMR to ${b.market}`:'')+` by block ${b.payBy}; ${ctx.what?'NFT':'Mordinal'} to ${b.buyer}; code ${code}`;}
 // ctx.offer: the offer an accept or a withdrawal names; ctx.scope: what an offer is for, in words.
 if(op===OP.offer)return `XMR721 offer: buy ${b.count===1?'1 piece':b.count+' pieces'} of ${ctx.scope} for ${formatXmr(b.price)} XMR each`+(b.rate?` plus ${formatXmr(b.price*BigInt(b.rate)/10000n)} XMR each to ${b.market}`:'')+`; pay within ${RULES.maxReserve} blocks of each accept; valid until block ${b.until}; NFTs to ${b.bidder}; code ${code}`;
 if(op===OP.accept){const o=ctx.offer,s=splitOf(o.price);return `XMR721 accept: sell ${what} to ${o.bidder} for ${formatXmr(o.price)} XMR (${formatXmr(s.seller)} XMR to ${b.seller}, ${formatXmr(s.fee)} XMR protocol fee); offer ${codeOf(o.id)}; sale ${b.seq}; code ${code}`;}
 if(op===OP.withdraw)return `XMR721 withdraw: end offer ${codeOf(b.offer)}; code ${code}`;
 throw Error('This record has no text to sign');}
export const signerOf=(op,b)=>op===OP.claim?b.holder:op===OP.move?b.from:op===OP.list||op===OP.cancel?b.seller:op===OP.reserve?b.buyer:op===OP.collection||op===OP.mint?b.creator:op===OP.burn?b.owner:op===OP.offer||op===OP.withdraw?b.bidder:op===OP.accept?b.seller:null;
// Which text ending the wallet used, or -1 when the signature is not a spend-key signature of this text by this address.
export function matchSignature(text,address,signature,network='mainnet'){
 const s=typeof signature==='string'?parseSignature(signature):signature;return SUFFIX.findIndex(x=>verifySpendSignature(text+x,address,s,network));}
// Body + pasted wallet signature -> record (move, list, cancel, reserve).
export function attachSignature(bodyBytes,signature,ctx,network='mainnet'){
 const d=decodeRecord(bodyBytes,network,{sig:false});if(!signedOp(d.op))throw Error('This record takes no message signature');
 if(!signature)throw Error('Paste the signature.');const s=parseSignature(signature),text=renderText(d.op,d.body,bodyBytes,ctx),variant=matchSignature(text,signerOf(d.op,d.body),s,network);
 if(variant<0)throw Error('This signature is not for this text and address. Sign the exact text with the spend key of '+signerOf(d.op,d.body)+'.');
 return concat(bodyBytes,Uint8Array.of(variant),s.c,s.r);}
