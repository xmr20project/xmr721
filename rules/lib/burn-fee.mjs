// The fee of a claim by burning (RULES.md section 10, "The fee"). Draft.
//
// Claiming by burning is a paid service. The claimer pays the burn transaction's own fee once more (its `txnFee`: the
// network fee and the record cost of the original rules), to the project's fee wallet. Each Mordinal has a fee address
// of its own: the fee wallet's standard subaddress at account 1, index = the Mordinal's number.
//
//   m = Hs("SubAddr\0" ‖ a ‖ u32le(1) ‖ u32le(n))     a = the fee wallet's secret view key (public on purpose), n = the number
//   D = B + m·G                                        B = the fee wallet's spend key: the subaddress's spend key
//   C = a·D                                            the subaddress's view key
//
// A fee payment is an output that pays such an address, found the way a wallet (wallet2) finds its outputs:
//   derivation   8·a·R          R = the transaction public key; then, when the transaction carries a list of additional
//                               public keys, the one of that output's place
//   view tag     an output that has one is looked at further only when it is the tag this derivation gives
//   output key   P = Hs(derivation ‖ varint i)·G + D, so P - Hs(derivation ‖ varint i)·G is looked up among the fee
//                addresses' spend keys, one for each Mordinal on the owner list
//   amount       the 8 bytes of ecdhInfo XOR keccak("amount" ‖ Hs(derivation ‖ varint i)), counted only when
//                Hs("commitment_mask" ‖ Hs(derivation ‖ varint i))·G + amount·H is the output's commitment: an amount
//                that does not match is refused, as wallet2 refuses to spend such an output
// The public keys are read from tx_extra as payment.mjs reads them: the first transaction public key and the first list
// of additional keys, up to the first field a wallet does not know (the transfer field 0x11 of the original format is one).
// Input: the transaction as monerod's get_transactions decode_as_json gives it (pruned is enough).
import {ed25519} from '@noble/curves/ed25519';
import {keccak_256} from '@noble/hashes/sha3';
import {decodeAddress,encodeAddress,usableSpendKey,subaddressSecret,hex,unhex,concat,le,leBytes,Hs} from './monero.mjs';
import {viewTag} from './claim.mjs';
import {extraKeys} from './payment.mjs';
const Pt=ed25519.ExtendedPoint,L=ed25519.CURVE.n,G=Pt.BASE,enc=new TextEncoder(),HEX32=/^[0-9a-f]{64}$/;
const H=Pt.fromHex('8b655970153799af2aeadc9ff1add0ea6c7251d54154cfa92c173a0dd39c1f94');
const varint=n=>{const out=[];do{let b=n&127;n=Math.floor(n/128);if(n)b|=128;out.push(b);}while(n);return Uint8Array.from(out);};
const times=(point,s)=>{s%=L;return s===0n?Pt.ZERO:point.multiplyUnsafe(s);};

// The project's fee wallet. Its secret view key is public by design: with it every reader finds every fee payment and
// the Mordinal it is for. Its spend key is the project's.
export const FEE_WALLET=Object.freeze({address:'47BebHskardKh24pHr92oZ8wv9JLcyjmJQcUKTpzK4gshhHkffYBqnJ7CUFNRjbJ77iMx3bTgESDjXmBMJZeTKbhCoTxnfE',
 viewKey:'8ecb6081cebfdc165fc9201fc5b9df7c86dad5e546b811a1783df0a312626f04'});
// The account whose subaddresses are the fee addresses; the index is the Mordinal's number.
export const FEE_ACCOUNT=1;
// What the pages ask for before the burn and its own fee are known: more than an ordinary burn's fee (0.00103 XMR).
export const FEE_SAFE=1200000000n;
// The fee wallet sees and spends the fees only with a subaddress lookahead of at least this many addresses in account 1.
export const FEE_LOOKAHEAD=50000;

const fixed=decodeAddress(FEE_WALLET.address,'mainnet');
const made=(spend,view,viewKey,network)=>Object.freeze({address:encodeAddress({spend,view,kind:'main',network}),spend:hex(spend),view:hex(view),viewKey,network});
// The fee wallet of a ledger: {address (its main address on the ledger's network), spend, view, viewKey (hex), network}.
// named: null for the project's wallet (the keys are the same on every network; only the written address differs), or
// {address, viewKey}: a wallet of one's own, for a ledger on another network or on the offline test chain, like the dead
// outputs. On mainnet no other wallet is taken.
export function feeWallet(named=null,network='mainnet',{testChain=false}={}){
 if(named==null)return made(fixed.spend,fixed.view,FEE_WALLET.viewKey,network);
 if(typeof named!=='object'||typeof named.address!=='string'||!HEX32.test(named.viewKey||''))throw Error('A fee wallet is named by its main address and its secret view key.');
 const a=decodeAddress(named.address,network);if(a.kind!=='main')throw Error('A fee wallet is named by its main address.');
 const v=le(unhex(named.viewKey));
 if(v===0n||v>=L||hex(G.multiply(v).toRawBytes())!==hex(a.view))throw Error('This secret view key does not belong to the fee wallet\'s address.');
 if(!usableSpendKey(a.spend))throw Error('The fee wallet\'s address has a key no wallet can use.');
 if(network==='mainnet'&&!testChain&&!(hex(a.spend)===hex(fixed.spend)&&hex(a.view)===hex(fixed.view)))throw Error('On mainnet the fee wallet is fixed; another one can be named only on a test chain.');
 return made(a.spend,a.view,named.viewKey,network);}
export const isProjectFeeWallet=w=>w.spend===hex(fixed.spend)&&w.view===hex(fixed.view)&&w.viewKey===FEE_WALLET.viewKey;

const number=n=>{if(!Number.isSafeInteger(n)||n<0||n>0xffffffff)throw Error('A Mordinal number is a whole number from 0 to 4294967295.');return n;};
const spendOf=(w,n)=>Pt.fromHex(w.spend).add(times(G,subaddressSecret(unhex(w.viewKey),FEE_ACCOUNT,number(n))));
// The fee address of Mordinal n: {address, spend, view}. Every wallet that holds the fee wallet's keys derives the same.
export function feeAddressOf(w,n){const D=spendOf(w,n),C=times(D,le(unhex(w.viewKey)));
 return {address:encodeAddress({spend:D.toRawBytes(),view:C.toRawBytes(),kind:'sub',network:w.network}),spend:hex(D.toRawBytes()),view:hex(C.toRawBytes())};}

// The spend keys of the fee addresses, to look a found key up by: one table per fee wallet, kept for the life of the
// process and filled as numbers are asked for (about three seconds for the 42,895 numbers of the owner list).
const tables=new Map();
export function feeTable(w,numbers){
 const id=w.spend+':'+w.viewKey;let t=tables.get(id);if(!t)tables.set(id,t={have:new Set(),of:new Map()});
 const want=[...new Set(numbers)].filter(n=>!t.have.has(n)).map(number);
 if(want.length){const B=Pt.fromHex(w.spend),view=unhex(w.viewKey),points=Pt.normalizeZ(want.map(n=>B.add(times(G,subaddressSecret(view,FEE_ACCOUNT,n)))));
  want.forEach((n,i)=>{t.of.set(hex(points[i].toRawBytes()),n);t.have.add(n);});}
 return key=>t.of.get(key);}

// What the rule reads from a transaction for fee payments: kept in a reader's journal, so the ledger can be rebuilt
// without a node. null for a transaction that cannot hold one (no current RingCT outputs).
//   {unlock, keys: {main, additional}, outs: [{key, tag, amount (ecdhInfo, hex), commitment}]}
export function feeParts(tx){
 const rct=tx?.rct_signatures,vout=Array.isArray(tx?.vout)?tx.vout:[];
 if(tx?.version!==2||![4,5,6].includes(rct?.type)||!vout.length||!Array.isArray(rct.ecdhInfo)||!Array.isArray(rct.outPk)||vout.length!==rct.ecdhInfo.length||vout.length!==rct.outPk.length)return null;
 let keys;try{keys=extraKeys(Array.isArray(tx.extra)?tx.extra:[]);}catch{return null;}
 const outs=vout.map((o,i)=>{const t=o?.target,key=t?.tagged_key?.key??t?.key??null,tag=t?.tagged_key?.view_tag??null,amount=rct.ecdhInfo[i]?.amount,commitment=rct.outPk[i];
  return {key:typeof key==='string'&&HEX32.test(key)?key:null,tag:typeof tag==='string'&&/^[0-9a-f]{2}$/.test(tag)?tag:null,amount:typeof amount==='string'&&/^[0-9a-f]{16}$/.test(amount)?amount:null,commitment:typeof commitment==='string'&&HEX32.test(commitment)?commitment:null};});
 return {unlock:Number.isSafeInteger(tx.unlock_time)?tx.unlock_time:null,keys:{main:keys.main,additional:keys.additional},outs};}

// 8·a·R as bytes, or null when R is not a point.
const derive=(a,pub)=>{try{return times(Pt.fromHex(pub),a).double().double().double().toRawBytes();}catch{return null;}};
// The outputs of a transaction (its feeParts) that pay a fee address: [{index, number, amount (bigint, or null), error}].
// numberOf: spend key (hex) -> Mordinal number, or undefined. error is null for an output that counts.
export function feeOutputs(parts,w,numberOf){
 if(!parts||typeof parts!=='object'||!Array.isArray(parts.outs)||parts.outs.length>16)return [];
 const a=le(unhex(w.viewKey)),main=HEX32.test(parts.keys?.main||'')?parts.keys.main:null,more=Array.isArray(parts.keys?.additional)?parts.keys.additional:[],found=[];
 let mainD;const derivations=i=>{const out=[];if(main){if(mainD===undefined)mainD=derive(a,main);if(mainD)out.push(mainD);}
  if(i<more.length&&HEX32.test(more[i]||'')){const d=derive(a,more[i]);if(d)out.push(d);}return out;};
 for(const [i,o] of parts.outs.entries()){if(!o||!HEX32.test(o.key||''))continue;
  for(const d of derivations(i)){
   if(o.tag!=null&&viewTag(d,i)!==parseInt(o.tag,16))continue;
   const sb=keccak_256(concat(d,varint(i))),s=le(sb)%L;let P;try{P=Pt.fromHex(o.key);}catch{break;}
   const n=numberOf(hex(P.subtract(times(G,s)).toRawBytes()));if(n===undefined)continue;
   const scalar=leBytes(s),f={index:i,number:n,amount:null,error:null};found.push(f);
   if(!/^[0-9a-f]{16}$/.test(o.amount||'')||!HEX32.test(o.commitment||'')){f.error='The output has no amount a wallet can read.';break;}
   const pad=keccak_256(concat(enc.encode('amount'),scalar)).subarray(0,8),amount=le(Uint8Array.from(unhex(o.amount),(x,j)=>x^pad[j]));
   const mask=Hs(concat(enc.encode('commitment_mask'),scalar)),C=times(G,mask).add(amount?H.multiplyUnsafe(amount):Pt.ZERO);
   if(hex(C.toRawBytes())!==o.commitment){f.error='Its amount does not match its commitment, so a wallet cannot spend it.';break;}
   f.amount=amount;if(parts.unlock!==0)f.error='A payment with a lock time does not count.';
   break;}}
 return found;}
