// Claiming a Mordinal by burning it (RULES.md section 10). Draft.
//
// A burn claim is no MD1 record. It is a transfer in the original 2023 Mordinals format: a transaction whose tx_extra
// holds field 0x11 with a text, and one input whose ring is the Mordinal's owner output plus fifteen "dead" outputs
// nobody can spend. The original rules give the Mordinal to output 0 of that transaction. Here output 0 must pay the
// burn address, which nobody can spend from, and the text names the address that owns the Mordinal from then on.
//
//   text        "xmr721 claim to <address>"      a main address or a subaddress of the ledger's network, nothing else
//                                                (one line end after it is allowed: wallets read the text from a file)
//   ring        the fifteen dead outputs and one other output: the owner output, by its global output index
//   output 0    P = Hs(8·a·R ‖ varint 0)·G + B   R = the first transaction public key in tx_extra,
//                                                a, B = the burn address's view secret key (public) and spend key
//   fee         at least 4,000,000 piconero for each byte of the text, rounded up to 0.001 XMR (the original fee rule)
//
// The burn address: spend key B = hash_to_ec(keccak256("XMR721 Mordinal burn address v1: spend key")), a point that
// came out of a hash, so nobody knows a secret key for it; view secret a = keccak256("XMR721 Mordinal burn address
// v1: view key") mod l, public on purpose so anyone can check a payment to it.
// Input: the transaction as monerod's get_transactions decode_as_json gives it.
import {ed25519} from '@noble/curves/ed25519';
import {keccak_256} from '@noble/hashes/sha3';
import {sha256} from '@noble/hashes/sha256';
import {decodeAddress,encodeAddress,usableSpendKey,hex,unhex,concat,le,leBytes,Hs} from './monero.mjs';
import {derivation,viewTag} from './claim.mjs';
const Pt=ed25519.ExtendedPoint,L=ed25519.CURVE.n,G=Pt.BASE,enc=new TextEncoder(),HEX32=/^[0-9a-f]{64}$/;

// Monero's hash_to_ec (the function behind key images): Keccak-256, then ge_fromfe_frombytes_vartime, then times 8.
const p=2n**255n-19n,A=486662n;
const mod=a=>((a%p)+p)%p;
const pow=(b,e)=>{let r=1n;b=mod(b);for(;e>0n;e>>=1n){if(e&1n)r=r*b%p;b=b*b%p;}return r;};
const SQRT_M1=pow(2n,(p-1n)/4n);
const root=a=>{a=mod(a);let r=pow(a,(p+3n)/8n);if(mod(r*r)!==a)r=mod(r*SQRT_M1);if(mod(r*r)!==a)throw Error('No square root');return r;};
// The four constants of the reference code: square roots of ∓2A(A+2) and of ∓√-1·A(A+2).
const FFFB1=root(-2n*A*(A+2n)),FFFB2=root(2n*A*(A+2n)),FFFB3=root(-SQRT_M1*A*(A+2n)),FFFB4=root(SQRT_M1*A*(A+2n));
export function hashToPoint(bytes){
 const u=mod(le(keccak_256(bytes))),v=mod(2n*u*u),w=mod(v+1n);
 let x=mod(w*w-A*A*v),r=mod(w*pow(x,3n)*pow(w*pow(x,7n),(p-5n)/8n)),y=mod(r*r),z=mod(-A),odd;
 x=mod(y*x);y=mod(w-x);
 if(y===0n){r=mod(r*FFFB2*u);z=mod(z*v);odd=0n;}
 else if(mod(w+x)===0n){r=mod(r*FFFB1*u);z=mod(z*v);odd=0n;}
 else{x=mod(x*SQRT_M1);
  if(mod(w-x)===0n)r=mod(r*FFFB4);else{if(mod(w+x)!==0n)throw Error('hash_to_ec failed');r=mod(r*FFFB3);}
  odd=1n;}
 if((r&1n)!==odd)r=mod(-r);
 const Z=mod(z+w),zi=pow(Z,p-2n);
 return Pt.fromAffine({x:mod(r*Z*zi),y:mod((z-w)*zi)}).multiply(8n);}

export const BURN_SPEND_TEXT='XMR721 Mordinal burn address v1: spend key',BURN_VIEW_TEXT='XMR721 Mordinal burn address v1: view key';
const viewSecret=Hs(enc.encode(BURN_VIEW_TEXT)),spendPoint=hashToPoint(keccak_256(enc.encode(BURN_SPEND_TEXT)));
// The keys of the burn address. viewSecret is public: with it anyone finds the payments to the address.
export const BURN={spend:hex(spendPoint.toRawBytes()),view:hex(G.multiply(viewSecret).toRawBytes()),viewSecret:hex(leBytes(viewSecret))};
export const burnAddress=(network='mainnet')=>encodeAddress({spend:unhex(BURN.spend),view:unhex(BURN.view),kind:'main',network});

// The dead outputs of mainnet, by global output index: the fifteen the 2023 wallet put into every transfer ring. All
// fifteen carry one key, the `dead_key` constant of the original source (deadbeef…dead000f): a pattern of bytes, not a
// key made from a secret. The original rule counts every index from 70499731 to 70499746 as dead; 70499745 is the
// ordinary sixteenth output of the transaction that made them and is left out here, because somebody may hold its key.
export const MAINNET_DEAD=Object.freeze([70499731,70499732,70499733,70499734,70499735,70499736,70499737,70499738,70499739,70499740,70499741,70499742,70499743,70499744,70499746]);
// The list a ledger uses. On mainnet it is mainnet's own and nothing else. A ledger on another network names its
// fifteen, and so does one on the offline test chain, whose addresses are written like mainnet's (testChain): fifteen
// different indexes, in rising order.
export function deadOutputs(list,network='mainnet',{testChain=false}={}){
 if(list==null){if(network!=='mainnet'||testChain)throw Error('A ledger on this network has to name its fifteen dead outputs.');return [...MAINNET_DEAD];}
 const d=[...list].map(Number).sort((a,b)=>a-b);
 if(d.length!==15||d.some((v,i)=>!Number.isSafeInteger(v)||v<0||(i&&v===d[i-1])))throw Error('The dead outputs are fifteen different global output indexes.');
 if(network==='mainnet'&&!testChain&&d.some((v,i)=>v!==MAINNET_DEAD[i]))throw Error('On mainnet the dead outputs are fixed; other ones can be named only on a test chain.');
 return d;}
export const isMainnetDead=list=>list.length===15&&list.every((v,i)=>v===MAINNET_DEAD[i]);
// Claim records still count for this many blocks (about a day) from the first burn block on. A holder whose burn got
// into a block just before the first burn block, where it claims nothing, can then still claim by record.
export const RECORDS_OVERLAP=720;
// A transfer's tx_extra is at most this long, like a record's (the most a node relays).
export const EXTRA_LIMIT=1060;

// The fee the original rules ask for a record of `size` bytes (get_inscription_record_cost).
export const recordCost=size=>(BigInt(size)*4000000n+999999999n)/1000000000n*1000000000n;
export const CLAIM_PREFIX='xmr721 claim to ';
export const claimText=address=>CLAIM_PREFIX+address;
export const burnClaimId=(domain,txid)=>hex(sha256(concat(enc.encode('XMR721-BURN-CLAIM-v1'),Uint8Array.of(0),unhex(domain),unhex(txid))));

// The transfer a tx_extra carries, or null. Read more strictly than the original parser reads: only a transaction
// public key (01), a nonce (02), additional public keys (04) and one transfer field (11), each whole, every length
// written the shortest way, nothing left over. Whatever passes here the original parser reads to the end and finds the
// same field in; a tx_extra with a registration (10), padding or anything else is not a burn claim, and neither is one
// longer than 1,060 bytes.
export function readTransfer(extra){
 if(!(extra instanceof Uint8Array||Array.isArray(extra))||extra.length>EXTRA_LIMIT)return null;
 const b=extra instanceof Uint8Array?extra:extra.every(v=>Number.isInteger(v)&&v>=0&&v<=255)?Uint8Array.from(extra):null;if(!b)return null;
 let at=0,txPub=null,text=null;
 const count=()=>{let n=0,scale=1;for(let i=0;i<4;i++){if(at>=b.length)return -1;const v=b[at++];if(i&&!v)return -1;n+=(v&127)*scale;scale*=128;if(!(v&128))return n;}return -1;};
 while(at<b.length){const tag=b[at++];
  if(tag===1){if(at+32>b.length)return null;if(!txPub)txPub=b.slice(at,at+32);at+=32;}
  else if(tag===2){const n=count();if(n<0||n>255||at+n>b.length)return null;at+=n;}
  else if(tag===4){const n=count();if(n<0||at+32*n>b.length)return null;at+=32*n;}
  else if(tag===0x11){const n=count();if(n<0||at+n>b.length||text)return null;text=b.slice(at,at+n);at+=n;}
  else return null;}
 return txPub&&text?{txPub:hex(txPub),text}:null;}
// The tx_extra of such a transfer (tests, and wallets that build one).
export function transferExtra(txPub,text,{paymentId=null}={}){
 const t=typeof text==='string'?enc.encode(text):text,n=t.length;if(n>=16384)throw Error('Text too long');
 return Uint8Array.from([1,...(typeof txPub==='string'?unhex(txPub):txPub),...(paymentId?[2,9,1,...paymentId]:[]),0x11,...(n<128?[n]:[(n&127)|128,n>>7]),...t]);}

// The address a transfer's text claims for: exactly "xmr721 claim to " and one main address or subaddress, then
// nothing, or one line end ("\n" or "\r\n": the wallets read the text from a file, and many files end that way).
const NOT_A_CLAIM='The text of this transfer is not "xmr721 claim to <address>" and nothing else.',LONGEST=CLAIM_PREFIX.length+106+2;
export function claimTo(text,network='mainnet'){
 if(text.length>LONGEST)throw Error(NOT_A_CLAIM);
 let s='';for(let i=0;i<text.length;i++)s+=String.fromCharCode(text[i]);
 const m=/^xmr721 claim to ([1-9A-HJ-NP-Za-km-z]+)(?:\r?\n)?$/.exec(s);
 if(!m)throw Error(NOT_A_CLAIM);
 let a;try{a=decodeAddress(m[1],network);}catch(e){throw Error('The address in the text cannot be used: '+e.message);}
 if(!usableSpendKey(a.spend)||!usableSpendKey(a.view))throw Error('The address in the text has a key no wallet can use.');
 return encodeAddress(a);}

// What the rule reads from a transaction: kept in a reader's journal, so the ledger can be rebuilt without a node.
//   {extra: hex, inputs: [{amount, offsets}] (null for an input that spends no output), fee: text, out0: {key, tag}}
export function burnParts(tx){
 const whole=v=>Number.isSafeInteger(v)&&v>=0,o=tx?.vout?.[0]?.target,key=o?.tagged_key?.key??o?.key??null,tag=o?.tagged_key?.view_tag??null,fee=tx?.rct_signatures?.txnFee;
 return {extra:hex(Uint8Array.from(Array.isArray(tx?.extra)?tx.extra:[])),
  inputs:(Array.isArray(tx?.vin)?tx.vin:[]).map(i=>{const k=i?.key;return k&&whole(k.amount)&&Array.isArray(k.key_offsets)&&k.key_offsets.every(whole)?{amount:k.amount,offsets:[...k.key_offsets]}:null;}),
  fee:whole(fee)||(typeof fee==='string'&&/^\d{1,20}$/.test(fee))?String(fee):null,out0:{key:typeof key==='string'&&HEX32.test(key)?key:null,tag:typeof tag==='string'&&/^[0-9a-f]{2}$/.test(tag)?tag:null}};}

// The output a transfer moves, by the ring of its inputs. The first input whose ring the original rule reads as a
// transfer ring decides (all members but one lie in the dead range, which runs from the lowest to the highest dead
// output); the inputs after it are not looked at, as in the original. That ring has to be exactly the fifteen dead
// outputs and one other output of the same kind (amount 0, as every output since RingCT).
export function movedOutput(inputs,dead){
 const lo=dead[0],hi=dead.at(-1),isDead=new Set(dead);
 for(const input of Array.isArray(inputs)?inputs:[]){if(!input||!Array.isArray(input.offsets))continue;
  let at=0,other=null,inRange=0;const ring=input.offsets.map(o=>at+=o);
  for(const m of ring){if(m>=lo&&m<=hi)inRange++;else other=m;}
  if(inRange!==ring.length-1)continue;
  const odd=ring.find(m=>m>=lo&&m<=hi&&!isDead.has(m));
  if(odd!==undefined)throw Error(`The ring holds output ${odd}, which is not one of the dead outputs.`);
  if(input.amount!==0||ring.length!==16||new Set(ring).size!==16)throw Error('The ring has to be the fifteen dead outputs and the owner output, nothing else.');
  return other;}
 throw Error('No input of this transaction has a ring of the dead outputs and one owner output.');}

// True when output 0 pays the burn address: its key is the one the burn address's view key gives for the first
// transaction public key, and its view tag, when it has one, is the one a wallet of the burn address looks for.
// Additional public keys are not used: a wallet pays a main address with the transaction key itself.
export function paysBurnAddress({txPub,key,tag=null}){
 try{if(!HEX32.test(key||''))return false;const d=derivation(unhex(BURN.viewSecret),txPub),s=Hs(concat(d,Uint8Array.of(0)));
  if(hex((s===0n?Pt.ZERO:G.multiply(s)).add(spendPoint).toRawBytes())!==key)return false;
  return tag==null||parseInt(tag,16)===viewTag(d,0);}
 catch{return false;}}
