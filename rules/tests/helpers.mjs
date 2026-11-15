// Throwaway keys and made-up transactions for the offline tests. Nothing here is a real wallet or a real transaction.
import {ed25519} from '@noble/curves/ed25519';
import {keccak_256} from '@noble/hashes/sha3';
import {hex,concat,le,leBytes,Hs,encodeAddress,base58Encode,messageHash,signWithSpendKey,subaddressKeys,subaddressSecret} from '../lib/monero.mjs';
import {viewTag,formatInProof} from '../lib/claim.mjs';
import {makeOutProof,paymentMessage} from '../lib/payment.mjs';
import {BURN,MAINNET_DEAD,burnAddress,claimText,transferExtra} from '../lib/burn.mjs';
const Pt=ed25519.ExtendedPoint,L=ed25519.CURVE.n,G=Pt.BASE,enc=new TextEncoder();
const H=Pt.fromHex('8b655970153799af2aeadc9ff1add0ea6c7251d54154cfa92c173a0dd39c1f94');
const varint=n=>{const out=[];do{let b=n&127;n=Math.floor(n/128);if(n)b|=128;out.push(b);}while(n);return Uint8Array.from(out);};
export const scalar=label=>{const s=Hs(enc.encode('mordinals test '+label));if(!s)throw Error('zero');return s;};
export const DOMAIN=hex(keccak_256(enc.encode('mordinals test ledger')));

function party({label,b,a,spend,view,kind,main,subScalar=0n,network}){
 return {label,kind,spend,view,address:encodeAddress({spend,view,kind,network}),viewSecret:leBytes(a),spendSecret:leBytes(main),subScalar,
  sign:text=>signWithSpendKey(text,{spend,view},leBytes(b)),
  // A view-key signature (wallet2 mode 1). wallet2 verifies it; these rules must refuse it.
  signView:text=>{const k=scalar(label+' nonce '+text),h=messageHash(text,spend,view,1),c=Hs(concat(h,view,G.multiply(k).toRawBytes()));
   return 'SigV2'+base58Encode(concat(leBytes(c),leBytes(((k-c*a)%L+L)%L)));}};}
export function wallet(label,network='mainnet'){
 const b=scalar(label+' spend'),a=scalar(label+' view'),spend=G.multiply(b).toRawBytes(),view=G.multiply(a).toRawBytes();
 const w=party({label,b,a,spend,view,kind:'main',main:b,network});
 w.sub=index=>{const k=subaddressKeys({spendSecret:leBytes(b),viewSecret:leBytes(a),account:0,index});
  return party({label:`${label}/${index}`,b:le(k.secret),a,spend:k.spend,view:k.view,kind:'sub',main:b,subScalar:subaddressSecret(leBytes(a),0,index),network});};
 return w;}

// A RingCT-shaped transaction paying the given outputs, as get_transactions decode_as_json shows it (only the fields the rules read).
// Transaction keys as wallet2 picks them:
//   - one key r with R = r·G when every destination is a main address;
//   - one key r with R = r·B when the only destination is one subaddress (subaddressKey forces this for outs[0], the
//     shape of an owner transaction with change);
//   - otherwise an additional key per output: rᵢ·B for a subaddress, rᵢ·G for a main address (whose output uses r).
// tamper: a function that may change the finished transaction (for transactions no wallet would make).
let counter=0;
export function makeTx(label,outs,{subaddressKey=false,height=null,tamper=null}={}){
 const sub=o=>o.to.kind==='sub',subs=outs.filter(sub).length,single=subaddressKey||(subs===1&&outs.length===1),more=!single&&subs>0;
 const r=scalar(label+' txkey'),base=single?Pt.fromHex(hex(outs[0].to.spend)):G,R=base.multiply(r).toRawBytes();
 const extraKeysOf=outs.map((o,i)=>scalar(label+' txkey '+i)),keys=[r,...(more?extraKeysOf:[])];
 const extra=[1,...R,...(more?[4,outs.length,...outs.flatMap((o,i)=>[...(sub(o)?Pt.fromHex(hex(o.to.spend)):G).multiply(extraKeysOf[i]).toRawBytes()])]:[])];
 const vout=[],ecdhInfo=[],outPk=[];
 outs.forEach((o,i)=>{const D=Pt.fromHex(hex(o.to.view)).multiply(more&&sub(o)?extraKeysOf[i]:r).multiply(8n).toRawBytes(),s=Hs(concat(D,varint(i))),sb=leBytes(s);
  const key=G.multiply(s).add(Pt.fromHex(hex(o.to.spend))).toRawBytes(),pad=keccak_256(concat(enc.encode('amount'),sb)).subarray(0,8);
  const amount=BigInt(o.amount),mask=Hs(concat(enc.encode('commitment_mask'),sb));
  vout.push({amount:0,target:{tagged_key:{key:hex(key),view_tag:viewTag(D,i).toString(16).padStart(2,'0')}}});
  ecdhInfo.push({amount:hex(Uint8Array.from(leBytes(amount,8),(x,j)=>x^pad[j]))});outPk.push(hex(G.multiply(mask).add(H.multiply(amount)).toRawBytes()));});
 const tx={version:2,unlock_time:0,vout,extra,rct_signatures:{type:6,ecdhInfo,outPk}};if(tamper)tamper(tx);
 return {txid:hex(keccak_256(enc.encode('mordinals test tx '+label+' '+counter++))),height,txKey:hex(leBytes(r)),keys:keys.map(k=>hex(leBytes(k))),txPub:hex(R),tx,
  outs:outs.map((o,i)=>({to:o.to,amount:BigInt(o.amount),secret:more&&sub(o)?extraKeysOf[i]:r}))};}
// An owner-list entry (ownership-index/result/owners.jsonl format) whose owner coin is output 0 of `tx`.
export const ownerEntry=(number,tx,registrationTx=tx.txid)=>({number,registrationTx,ownerTx:tx.txid,ownerOutputIndex:1000+number,
 ownerOutputKey:tx.tx.vout[0].target.tagged_key.key,ownerViewTag:tx.tx.vout[0].target.tagged_key.view_tag,ownerTxPubKeys:[tx.txPub],ownerAdditionalPubKeys:[]});
// A wallet2 InProofV2, made the way wallet2 makes it from the holder's private view key.
export function makeInProof({txid,txPub,holder,message='',viewSecret=holder.viewSecret}){
 const a=le(viewSecret)%L,R=Pt.fromHex(txPub),D=R.multiply(a).toRawBytes(),k=scalar('proof nonce '+txid+holder.address+message),sub=holder.kind==='sub';
 const X=(sub?Pt.fromHex(hex(holder.spend)):G).multiply(k).toRawBytes(),Y=R.multiply(k).toRawBytes();
 const prefix=keccak_256(concat(Uint8Array.from(txid.match(/../g),x=>parseInt(x,16)),enc.encode(message)));
 const c=Hs(concat(prefix,D,X,Y,keccak_256(enc.encode('TXPROOF_V2')),holder.view,Uint8Array.from(txPub.match(/../g),x=>parseInt(x,16)),sub?holder.spend:new Uint8Array(32)));
 return formatInProof({D,c:leBytes(c),r:leBytes(((k-c*a)%L+L)%L)});}
export const fact=(tx,height)=>({txid:tx.txid,height,tx:tx.tx});
// The payees of a listing's latest reservation, in the order a buy record names them.
export function payees(ledger,lot,feeAddress){
 const x=ledger.lot(lot),r=x.reservations.at(-1);
 return [{to:x.seller,amount:BigInt(r.seller),what:'seller'},{to:feeAddress,amount:BigInt(r.protocol),what:'protocol fee'},...(r.rate?[{to:r.market,amount:BigInt(r.marketPay),what:'marketplace fee'}]:[])];}
// One entry of a buy record for output `index` of `tx`, made with the key that made that output, whatever the transaction
// looks like now. The options make proofs a wallet would not make.
export function entry(tx,index,lot,{domain=DOMAIN,to=tx.outs[index].to,secret=tx.outs[index].secret,proofTxid=tx.txid,message=paymentMessage(domain,lot)}={}){
 const p=makeOutProof({txid:proofTxid,secret,address:to,message});return {txid:tx.txid,out:index,D:hex(p.D),c:hex(p.c),s:hex(p.s)};}
// The entries for a reservation's lines from these transactions, without a wallet's checks: for each payee the output
// with the exact amount, else any output to that payee. Stops at the first payee nothing pays.
export function entries(lines,txs,lot,o){
 const out=[];
 for(const line of lines){let hit=null;
  for(const t of txs)t.outs.forEach((x,i)=>{if(x.to.address===line.to&&(!hit||(hit.t.outs[hit.i].amount!==BigInt(line.amount)&&x.amount===BigInt(line.amount))))hit={t,i};});
  if(!hit)break;out.push(entry(hit.t,hit.i,lot,o));}
 return out;}

// Claiming by burning (lib/burn.mjs). The burn address as a payee for makeTx, and a made-up burning transfer: output 0
// pays the burn address, tx_extra holds the text in field 0x11, and one input's ring is the dead outputs and `output`.
// The options make transfers no wallet would make: another ring, other inputs before or after it, another fee, other
// outputs, a tx_extra of one's own (tamper gets the finished transaction).
const bytesOf=h=>Uint8Array.from(h.match(/../g),x=>parseInt(x,16));
export const burnParty={label:'burn address',kind:'main',spend:bytesOf(BURN.spend),view:bytesOf(BURN.view),address:burnAddress()};
export const offsetsOf=ring=>{const r=[...ring].sort((a,b)=>a-b);return r.map((v,i)=>i?v-r[i-1]:v);};
export const input=(ring,amount=0)=>({key:{amount,key_offsets:offsetsOf(ring),k_image:hex(keccak_256(enc.encode('mordinals test key image '+ring.join(','))))}});
export function makeBurn(label,{output,to,text=claimText(to?.address??to),dead=MAINNET_DEAD,ring=[...dead,output],before=[],after=[],fee=10n**9n+30000000n,outs=null,paymentId=true,tamper=null}={}){
 return makeTx(label,outs||[{to:burnParty,amount:1n},{to:wallet(label+' change'),amount:10n**9n}],{tamper:tx=>{
  tx.extra=[...transferExtra(Uint8Array.from(tx.extra.slice(1,33)),text,{paymentId:paymentId?keccak_256(enc.encode(label)).subarray(0,8):null})];
  tx.vin=[...before,input(ring),...after];tx.rct_signatures.txnFee=Number(fee);if(tamper)tamper(tx);}});}
