// Claiming by a spent coin (RULES.md section 11). Draft.
// A wallet that cannot build a burn (Feather, and other wallet2 wallets that export signed key images and sign messages)
// spends the owner coin in an ordinary transaction and shows two things about it:
//   - the coin's key image, signed with the coin's one-time key: wallet2's signed key image, as export_key_images makes it
//     (Feather's offline signing exports it for exactly the coins of an outputs file it is given):
//       generate_ring_signature(prefix = the key image, image I, ring = {P}, x)    P = x·G, I = x·Hp(P)
//       accepted when Hs(I ‖ r·G + c·P ‖ r·Hp(P) + c·I) = c, with I a point of the main group
//   - the transaction that spent it: an input of it has that key image, and it did not move the Mordinal under the
//     original Mordinals rules (mayHaveMoved).
import {ed25519} from '@noble/curves/ed25519';
import {hex,concat,le,leBytes,Hs,usableSpendKey} from './monero.mjs';
import {hashToPoint} from './burn.mjs';
const Pt=ed25519.ExtendedPoint,G=Pt.BASE,L=ed25519.CURVE.n,HEX32=/^[0-9a-f]{64}$/;
const bytes=x=>typeof x==='string'?Uint8Array.from(x.match(/../g)||[],v=>parseInt(v,16)):x;
// What a claim by a spent coin pays to its Mordinal's fee address (the fee address of section 10), in piconero. Draft value.
export const SPEND_FEE=2000000000n;
// The signed key image: c and r of a ring signature with one member. -> true when it proves that `keyImage` is the key
// image of `outputKey`.
export function verifyKeyImageProof({outputKey,keyImage,c,r}){
 try{const P=usableSpendKey(bytes(outputKey)),I=usableSpendKey(bytes(keyImage));if(!P||!I)return false;
  const cs=le(bytes(c)),rs=le(bytes(r));if(cs===0n||cs>=L||rs===0n||rs>=L)return false;
  const a=G.multiply(rs).add(P.multiply(cs)),b=hashToPoint(bytes(outputKey)).multiply(rs).add(I.multiply(cs));
  return Hs(concat(bytes(keyImage),a.toRawBytes(),b.toRawBytes()))===cs;}
 catch{return false;}}
// The same signature, as a wallet makes it (tests and the wallet's own tools): x is the coin's one-time secret key.
export function signKeyImage(x,random=n=>crypto.getRandomValues(new Uint8Array(n))){
 if(x<=0n||x>=L)throw Error('Invalid key');const P=G.multiply(x).toRawBytes(),Hp=hashToPoint(P),I=Hp.multiply(x).toRawBytes();
 let k=0n;while(k===0n)k=Hs(concat(random(64),leBytes(x),P));
 const c=Hs(concat(I,G.multiply(k).toRawBytes(),Hp.multiply(k).toRawBytes())),r=((k-c*x)%L+L)%L;
 return {outputKey:hex(P),keyImage:hex(I),c:hex(leBytes(c)),r:hex(leBytes(r))};}
// Whether the 2023 Mordinals indexer reads a transfer in a tx_extra, read as it reads tx_extra (parse_tx_extra and the
// field types of src/cryptonote_basic/tx_extra.h of github.com/mooonero/mordinals): fields in order; a field that does not
// read ends the reading and keeps the fields read before it. It reads a transfer when it read a transfer field (0x11) and
// no registration field (0x10). As there:
//   - a varint that the end of tx_extra cuts short is the value read so far (read_varint); a zero byte after the first
//     one, or a value above 64 bits, does not read;
//   - a string is a varint length and that many bytes, which have to be there;
//   - padding (0) is at most 254 zero bytes to the end; a nonce (2) at most 255 bytes; additional keys (4) a varint
//     count and that many 32-byte keys; a merge mining tag (3) a string holding exactly a varint and 32 bytes; field
//     0xde a string; a registration (0x10) two strings; a transfer (0x11) a string; field 0x12 a string, 32 bytes and
//     two 8-byte numbers; field 0x13 32 bytes, a string and 32 bytes; any other tag does not read.
export function originalTransfer(extra){
 const e=Array.isArray(extra)&&extra.every(v=>Number.isInteger(v)&&v>=0&&v<=255)?Uint8Array.from(extra):null;if(!e)return false;
 let at=0,transfer=false,registration=false;
 const varint=(end=e.length)=>{let v=0n;for(let shift=0n;;shift+=7n){if(at>=end)return v;const b=e[at++];
  if(shift+7n>=64n&&b>=2**Number(64n-shift))throw Error('overflow');if(b===0&&shift)throw Error('varint');v|=BigInt(b&0x7f)<<shift;if(!(b&0x80))return v;}};
 const take=n=>{if(n>BigInt(e.length-at))throw Error('short');at+=Number(n);},string=()=>take(varint());
 try{while(at<e.length){const tag=e[at++];
  if(tag===0x00){if(e.length-at>254||e.subarray(at).some(b=>b))throw Error('padding');at=e.length;}
  else if(tag===0x01)take(32n);
  else if(tag===0x02){const n=varint();take(n);if(n>255n)throw Error('nonce');}
  else if(tag===0x03){const n=varint();take(n);const end=at;at-=Number(n);varint(end);if(end-at!==32)throw Error('merge mining tag');at=end;}
  else if(tag===0x04){const n=varint();if(n>BigInt(e.length-at))throw Error('count');take(32n*n);}
  else if(tag===0xde)string();
  else if(tag===0x10){string();string();registration=true;}
  else if(tag===0x11){string();transfer=true;}
  else if(tag===0x12){string();take(32n);take(8n);take(8n);}
  else if(tag===0x13){take(32n);string();take(32n);}
  else break;}}
 catch{}
 return transfer&&!registration;}
// Whether a spending transaction moved a Mordinal under the original rules, or may have: the indexer reads a transfer in
// it, and one of its inputs has a ring whose members all lie in the dead range (from the lowest to the highest dead
// output) but one, and that one is the Mordinal's owner output (isOwner(global index)). The transfer's fee and the place
// of that input among the inputs are not looked at: such a transaction counts as having moved the Mordinal either way.
// Any other spend moves nothing there: an ordinary transaction, a registration, a transfer of another Mordinal.
export function mayHaveMoved(tx,isOwner,dead){
 if(!originalTransfer(tx?.extra))return false;
 const lo=dead[0],hi=dead.at(-1);
 for(const input of Array.isArray(tx?.vin)?tx.vin:[]){const o=input?.key?.key_offsets;
  if(!Array.isArray(o)||!o.length||!o.every(v=>Number.isSafeInteger(v)&&v>=0))continue;
  let at=0;const outside=o.map(v=>at+=v).filter(v=>v<lo||v>hi);
  if(outside.length===1&&isOwner(outside[0]))return true;}
 return false;}
// The key images a transaction spends, as get_transactions decode_as_json shows its inputs.
export const keyImagesOf=tx=>Array.isArray(tx?.vin)?tx.vin.map(i=>i?.key?.k_image).filter(k=>HEX32.test(k||'')):[];
