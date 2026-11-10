// MD1 records: claim, move, list, cancel, reserve, buy (RULES.md). Draft.
//   record   = "MD1\xfe" op(u8) body [proof or signature]
//   op 1 claim    reg32 ownerTx32 to proof(u8) [holder when proof = 1]
//                 proof 0 (one-time key):       c32 r32
//                 proof 1 (payment proof + message): D32 pc32 pr32 variant(u8) c32 r32
//   op 2 move     reg32 seq(u32) from to                              variant c32 r32
//   op 3 list     reg32 seq(u32) until(u32) price(u64 piconero) seller variant c32 r32
//   op 4 cancel   lot32 seller                                        variant c32 r32
//   op 5 reserve  lot32 payBy(u32) buyer rate(u16) [market when rate > 0]  variant c32 r32
//   op 6 buy      lot32 n(u8) n×(txid32 out(u8) D32 c32 s32)           (no signature) one entry per payee, in the
//                 reservation's order: seller, protocol fee, marketplace fee when it names one. out = output number,
//                 D c s = the payment proof (payment.mjs). 296 or 425 bytes.
//   address  = kind(u8: 0 main address, 1 subaddress) B32 A32
//   id       = SHA-256("MORDINALS-RECORD-v1\0" || domain32 || "MD1\xfe" op body); a listing's id is its lot id
//   code     = first 16 bytes of the id, in the signed text
// The text a wallet signs is rebuilt from the record bytes and the ledger (inscription number, listing terms), so a signature
// cannot be attached to anything else. variant says how the wallet ended the text: 0 nothing, 1 "\n", 2 "\r\n".
import {sha256} from '@noble/hashes/sha256';
import {decodeAddress,encodeAddress,verifySpendSignature,usableSpendKey,parseSignature,hex,unhex,concat,le,leBytes} from './monero.mjs';
const enc=new TextEncoder();
export const MAGIC=Uint8Array.of(0x4d,0x44,0x31,0xfe),OP={claim:1,move:2,list:3,cancel:4,reserve:5,buy:6},PROOF={outputKey:0,payment:1};
// Draft parameters. The fee address is given to the ledger; rate, cap, minimum price and window are the draft values of RULES.md section 7.
// settle: blocks after a reservation's pay-by block in which the listing stays held for it, so a buyer who paid in time
// can still get the purchase recorded before anyone else may reserve.
export const RULES={feeBps:500,marketFeeCapBps:500,minPrice:10n**9n,maxReserve:30,settle:10,maxPayments:3,maxKeys:17};
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
function reader(b){let at=0;const take=n=>{if(at+n>b.length)throw Error('Record is truncated');const v=b.subarray(at,at+n);at+=n;return v;};
 return {take,u8:()=>take(1)[0],u16:()=>Number(le(take(2))),u32:()=>Number(le(take(4))),u64:()=>le(take(8)),hex32:()=>hex(take(32)),get at(){return at;},get left(){return b.length-at;}};}
const readParty=(r,network)=>{const k=r.u8();if(k>1)throw Error('Unknown address kind');const spend=r.take(32).slice(),view=r.take(32).slice();
 if(!usableSpendKey(spend))throw Error('An address in this record cannot sign');if(!usableSpendKey(view))throw Error('An address in this record has an unusable view key');return encodeAddress({spend,view,kind:k?'sub':'main',network});};

export function encodeBody(op,b,network='mainnet'){
 const head=concat(MAGIC,Uint8Array.of(op));
 if(op===OP.claim){if(b.proof!==PROOF.outputKey&&b.proof!==PROOF.payment)throw Error('Unknown proof kind');
  return concat(head,id32(b.reg,'Inscription transaction'),id32(b.ownerTx,'Owner transaction'),party(b.to,network),Uint8Array.of(b.proof),b.proof===PROOF.payment?party(b.holder,network):new Uint8Array(0));}
 if(op===OP.move)return concat(head,id32(b.reg,'Inscription transaction'),u32(b.seq),party(b.from,network),party(b.to,network));
 if(op===OP.list){if(!(b.price>0n))throw Error('Price must be above 0');return concat(head,id32(b.reg,'Inscription transaction'),u32(b.seq),height(b.until,'expiry height'),u64(b.price),party(b.seller,network));}
 if(op===OP.cancel)return concat(head,id32(b.lot,'Listing id'),party(b.seller,network));
 if(op===OP.reserve){const rate=b.rate||0;if(!Number.isInteger(rate)||rate<0||rate>0xffff)throw Error('Bad marketplace fee rate');if(!rate&&b.market)throw Error('A marketplace address needs a rate');
  return concat(head,id32(b.lot,'Listing id'),height(b.payBy,'pay-by height'),party(b.buyer,network),u16(rate),rate?party(b.market,network):new Uint8Array(0));}
 if(op===OP.buy){const p=b.payments||[];if(p.length<2||p.length>RULES.maxPayments)throw Error('A buy record names 2 or 3 payments');
  return concat(head,id32(b.lot,'Listing id'),Uint8Array.of(p.length),...p.flatMap(x=>{if(!Number.isInteger(x.out)||x.out<0||x.out>255)throw Error('Output number required');
   return [id32(x.txid,'Payment transaction'),Uint8Array.of(x.out),id32(x.D,'Payment proof'),id32(x.c,'Payment proof'),id32(x.s,'Payment proof')];}));}
 throw Error('Unknown operation');}
export const signedOp=op=>op===OP.move||op===OP.list||op===OP.cancel||op===OP.reserve;
// Strict decode of a whole record, or of a body alone (sig: false). Nothing may follow the last field.
export function decodeRecord(bytes,network='mainnet',{sig=true}={}){
 const r=reader(bytes);if(hex(r.take(4))!==hex(MAGIC))throw Error('Not an MD1 record');const op=r.u8();let body,proof=null;
 if(op===OP.claim){const reg=r.hex32(),ownerTx=r.hex32(),to=readParty(r,network),kind=r.u8();if(kind>1)throw Error('Unknown proof kind');
  body={reg,ownerTx,to,proof:kind};if(kind===PROOF.payment)body.holder=readParty(r,network);}
 else if(op===OP.move)body={reg:r.hex32(),seq:r.u32(),from:readParty(r,network),to:readParty(r,network)};
 else if(op===OP.list){body={reg:r.hex32(),seq:r.u32(),until:r.u32(),price:r.u64(),seller:readParty(r,network)};if(!(body.price>0n)||!body.until)throw Error('Bad listing');}
 else if(op===OP.cancel)body={lot:r.hex32(),seller:readParty(r,network)};
 else if(op===OP.reserve){body={lot:r.hex32(),payBy:r.u32(),buyer:readParty(r,network),rate:r.u16()};if(!body.payBy)throw Error('Bad pay-by height');if(body.rate)body.market=readParty(r,network);}
 else if(op===OP.buy){const lot=r.hex32(),n=r.u8();if(n<2||n>RULES.maxPayments)throw Error('A buy record names 2 or 3 payments');const payments=[];
  for(let i=0;i<n;i++)payments.push({txid:r.hex32(),out:r.u8(),D:r.hex32(),c:r.hex32(),s:r.hex32()});
  if(new Set(payments.map(p=>p.txid+':'+p.out)).size!==n)throw Error('A payment output appears twice');body={lot,payments};}
 else throw Error('Unknown operation');
 const bodyBytes=bytes.slice(0,r.at);
 if(sig){
  if(op===OP.claim&&body.proof===PROOF.outputKey)proof={c:r.take(32).slice(),r:r.take(32).slice()};
  else if(op===OP.claim)proof={D:r.take(32).slice(),pc:r.take(32).slice(),pr:r.take(32).slice(),variant:r.u8(),c:r.take(32).slice(),r:r.take(32).slice()};
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
export function renderText(op,b,bodyBytes,ctx){
 const code=codeOf(recordId(ctx.domain,bodyBytes)),n=ctx.number;
 if(op===OP.claim)return `Mordinals claim: Mordinal #${n} (inscription ${b.reg}), held by output 0 of ${b.ownerTx}, now belongs to ${b.to}; code ${code}`;
 if(op===OP.move)return `Mordinals move: send Mordinal #${n} to ${b.to}; move ${b.seq}; code ${code}`;
 if(op===OP.list){const s=splitOf(b.price);return `Mordinals list: sell Mordinal #${n} for ${formatXmr(b.price)} XMR (${formatXmr(s.seller)} XMR to ${b.seller}, ${formatXmr(s.fee)} XMR protocol fee); valid until block ${b.until}; code ${code}`;}
 if(op===OP.cancel)return `Mordinals cancel: stop selling Mordinal #${n}; listing ${codeOf(b.lot)}; code ${code}`;
 if(op===OP.reserve){const l=ctx.lot,a=amounts({price:l.price,rate:b.rate,code});
  return `Mordinals reserve: buy Mordinal #${n} for ${formatXmr(l.price)} XMR; pay exactly ${formatXmr(a.seller)} XMR to ${l.seller} and exactly ${formatXmr(a.protocol)} XMR to ${ctx.feeAddress}`
   +(b.rate?` and exactly ${formatXmr(a.market)} XMR to ${b.market}`:'')+` by block ${b.payBy}; Mordinal to ${b.buyer}; code ${code}`;}
 throw Error('This record has no text to sign');}
export const signerOf=(op,b)=>op===OP.claim?b.holder:op===OP.move?b.from:op===OP.list||op===OP.cancel?b.seller:op===OP.reserve?b.buyer:null;
// Which text ending the wallet used, or -1 when the signature is not a spend-key signature of this text by this address.
export function matchSignature(text,address,signature,network='mainnet'){
 const s=typeof signature==='string'?parseSignature(signature):signature;return SUFFIX.findIndex(x=>verifySpendSignature(text+x,address,s,network));}
// Body + pasted wallet signature -> record (move, list, cancel, reserve).
export function attachSignature(bodyBytes,signature,ctx,network='mainnet'){
 const d=decodeRecord(bodyBytes,network,{sig:false});if(!signedOp(d.op))throw Error('This record takes no message signature');
 if(!signature)throw Error('Paste the signature.');const s=parseSignature(signature),text=renderText(d.op,d.body,bodyBytes,ctx),variant=matchSignature(text,signerOf(d.op,d.body),s,network);
 if(variant<0)throw Error('This signature is not for this text and address. Sign the exact text with the spend key of '+signerOf(d.op,d.body)+'.');
 return concat(bodyBytes,Uint8Array.of(variant),s.c,s.r);}
