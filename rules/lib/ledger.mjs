// The rules as code: who owns each Mordinal, what is listed, what is reserved (RULES.md). Draft.
// A reader feeds it every MD1 record in chain order (setHeight, then apply); a relay or a wallet uses check before posting.
// Input that is not a record: the owner list at the start block (ownership-index/result/owners.jsonl format) and, for a buy
// record, the payment transactions it names as a Monero node returns them ({txid, height, tx}).
import {decodeAddress,usableSpendKey,verifySpendSignature,parseSignature,concat} from './monero.mjs';
import {OP,PROOF,RULES,SUFFIX,MAX_RECORD,NO_COLLECTION,heldUntil,encodeBody,decodeRecord,recordId,codeOf,amounts,renderText,nftLabel,signerOf,attachSignature,matchSignature,canonical,formatXmr} from './records.mjs';
import {sha256} from '@noble/hashes/sha256';
import {hex} from './monero.mjs';
import {claimKeyHash,verifyOutputKeySignature,parseInProof,verifyInProof,ownsOutput} from './claim.mjs';
import {checkPaymentProof,paymentMessage} from './payment.mjs';

// mintFrom: the first block at which collection, mint and burn records count (a setting of the ledger, like the start
// block). Without it those records are refused, and the ledger is one of Mordinals only.
export function createLedger({network='mainnet',domain,feeAddress,owners,height=0,mintFrom=null}){
 if(!/^[0-9a-f]{64}$/.test(domain||''))throw Error('Ledger domain required');
 if(mintFrom!==null&&!(Number.isInteger(mintFrom)&&mintFrom>=1))throw Error('Bad first mint block');
 // The fee address is checked like every address in a record: both keys must be keys a wallet can use.
 {const a=decodeAddress(feeAddress,network);if(!usableSpendKey(a.spend)||!usableSpendKey(a.view))throw Error('The fee address has a key no wallet can use.');}
 const fee=canonical(feeAddress,network),mordinals=new Map(),byNumber=new Map(),lots=new Map(),open=new Set(),applied=new Set(),payments=new Set(),paidOutputs=new Set(),collections=new Map();let tip=height;
 for(const o of owners){
  if(o.ownerTxPubKeys?.length!==1||o.ownerAdditionalPubKeys?.length)throw Error(`Owner list entry ${o.number} must have exactly one transaction public key`);
  const m={number:o.number,reg:o.registrationTx,ownerTx:o.ownerTx,outputKey:o.ownerOutputKey,txPub:o.ownerTxPubKeys[0],claimed:false,owner:null,seq:0,lot:null,history:[]};
  if(mordinals.has(m.reg)||byNumber.has(m.number))throw Error('Owner list repeats an entry');mordinals.set(m.reg,m);byNumber.set(m.number,m);}
 const find=x=>{const m=typeof x==='number'?byNumber.get(x):mordinals.get(x);if(!m)throw Error('This is not a Mordinal on the owner list.');return m;};
 const lotOf=id=>{const l=lots.get(id);if(!l)throw Error('This listing does not exist.');return l;};
 const latest=l=>l.reservations.at(-1)||null,running=l=>{const r=latest(l);return r&&heldUntil(r)>=tip?r:null;};
 // What a reservation asks for, payee by payee: [what, address, exact amount].
 const linesOf=(l,r)=>[['seller',l.seller,r.seller],['protocol fee',fee,r.protocol],...(r.rate?[['marketplace fee',r.market,r.marketPay]]:[])];
 // Every exact payment (address and amount) asked for by any reservation, running or run out, of a listing that is
 // still open and has not ended. A new reservation may repeat none of them, or one payment could be shown for two
 // purchases. Lines of reservations that ran out are kept on purpose: a payment made for one of them, late or not yet
 // recorded, must never fit somebody else's reservation.
 const awaited=()=>{const out=new Set();for(const id of open){const l=lots.get(id);if(l.until<tip)continue;for(const r of l.reservations)for(const [,address,amount] of linesOf(l,r))out.add(address+':'+amount);}return out;};
 const collectionOf=id=>{const c=collections.get(id);if(!c)throw Error('This collection does not exist.');return c;};
 // How a minted NFT is named in a signed text. A Mordinal keeps "Mordinal #n".
 const labelOf=m=>m.minted?nftLabel(m.reg,m.minted,m.minted.collection===NO_COLLECTION?null:collections.get(m.minted.collection).name):undefined;
 const ctxFor=(d)=>{
  if(d.op===OP.collection)return {domain};
  if(d.op===OP.mint)return {domain,collectionName:d.body.collection===NO_COLLECTION?null:collectionOf(d.body.collection).name};
  const lot=d.op===OP.cancel||d.op===OP.reserve?lotOf(d.body.lot):null,m=lot?mordinals.get(lot.reg):find(d.op===OP.burn?d.body.nft:d.body.reg);return {domain,number:m.number,what:labelOf(m),lot,feeAddress:fee};};
 const textOf=bodyBytes=>{const d=decodeRecord(bodyBytes,network,{sig:false});return renderText(d.op,d.body,d.bodyBytes,ctxFor(d));};
 const prepared=(op,body)=>{const bodyBytes=encodeBody(op,body,network),id=recordId(domain,bodyBytes);return {bodyBytes,id,code:codeOf(id),text:textOf(bodyBytes)};};
 const owned=(x,by)=>{const m=find(x);if(!m.claimed)throw Error('This Mordinal has not been claimed yet.');if(m.owner!==canonical(by,network))throw Error('This Mordinal belongs to another address.');return m;};
 const api={
  get height(){return tip;},setHeight(h){if(h<tip)throw Error('Height cannot go back');tip=h;return h;},feeAddress:fee,
  mordinal:x=>{const m=find(x);return {...m,history:m.history.slice()};},lot:id=>lots.get(id)||null,
  owned:address=>{const a=canonical(address,network);return [...mordinals.values()].filter(m=>m.owner===a&&m.number!=null).map(m=>m.number);},
  // Minted NFTs: one by id, those of an address, and collections.
  nft:id=>{const m=mordinals.get(id);return m?.minted?{...m,history:m.history.slice()}:null;},
  nftsOf:address=>{const a=canonical(address,network);return [...mordinals.values()].filter(m=>m.minted&&m.owner===a).map(m=>m.reg);},
  collection:id=>{const c=collections.get(id);return c?{...c,editions:[...c.editions]}:null;},collections:()=>[...collections.values()].map(c=>({...c,editions:[...c.editions]})),
  prepareCollection({creator,name,max}){return prepared(OP.collection,{creator,name,max});},
  prepareMint({collection=NO_COLLECTION,edition=0,creator,to,name='',type,content,origin}){return prepared(OP.mint,{collection,edition,creator,to,name,type,content,origin});},
  prepareBurn({nft,owner}){const m=owned(nft,owner);return prepared(OP.burn,{nft:m.reg,seq:m.seq,owner});},
  // Texts and bodies to sign.
  prepareClaim({mordinal,to,holder}){const m=find(mordinal),body={reg:m.reg,ownerTx:m.ownerTx,to,proof:holder?PROOF.payment:PROOF.outputKey,holder};
   const bodyBytes=encodeBody(OP.claim,body,network),id=recordId(domain,bodyBytes);
   return {bodyBytes,id,code:codeOf(id),number:m.number,ownerTx:m.ownerTx,keyHash:claimKeyHash(domain,bodyBytes),text:holder?textOf(bodyBytes):null};},
  claimWithKey:(bodyBytes,{c,r})=>concat(bodyBytes,c,r),
  claimWithProof(bodyBytes,proofText,signature){const d=decodeRecord(bodyBytes,network,{sig:false});if(d.op!==OP.claim||d.body.proof!==PROOF.payment)throw Error('This claim does not take a payment proof');
   const p=parseInProof(proofText);if(!signature)throw Error('Paste the signature.');const s=parseSignature(signature),variant=matchSignature(textOf(bodyBytes),d.body.holder,s,network);
   if(variant<0)throw Error('This signature is not for this text and address. Sign the exact text with the spend key of '+d.body.holder+'.');
   return concat(bodyBytes,p.D,p.c,p.r,Uint8Array.of(variant),s.c,s.r);},
  prepareMove({mordinal,from,to}){const m=owned(mordinal,from);return prepared(OP.move,{reg:m.reg,seq:m.seq,from,to});},
  prepareList({mordinal,seller,price,until=tip+720}){const m=owned(mordinal,seller);return prepared(OP.list,{reg:m.reg,seq:m.seq,until,price,seller});},
  prepareCancel({lot,seller}){return prepared(OP.cancel,{lot,seller});},
  prepareReserve({lot,buyer,window=RULES.maxReserve,market,rate=0}){const l=lotOf(lot),p=prepared(OP.reserve,{lot,payBy:Math.min(tip+window,l.until),buyer,rate,market});
   const a=amounts({price:l.price,rate,code:p.code});return {...p,pay:[{to:l.seller,amount:a.seller,what:'seller'},{to:fee,amount:a.protocol,what:'protocol fee'},...(rate?[{to:canonical(market,network),amount:a.market,what:'marketplace fee'}]:[])]};},
  sign:(bodyBytes,signature)=>attachSignature(bodyBytes,signature,ctxFor(decodeRecord(bodyBytes,network,{sig:false})),network),
  // payments: one entry per payee in the reservation's order (provePayments in payment.mjs makes them).
  buyRecord:({lot,payments:p})=>encodeBody(OP.buy,{lot,payments:p},network),
  textOf,
  check(record,facts){return validate(record,facts);},
  apply(record,facts){
   const v=validate(record,facts),{op,body:b,id}=v;applied.add(id);
   const moved=(m,to,what,extra={})=>{m.history.push({what,height:tip,record:id,from:m.owner,to,...extra});m.owner=to;m.seq++;};
   if(op===OP.collection){collections.set(id,{id,creator:b.creator,name:b.name,max:b.max,height:tip,editions:new Set()});return {id,collection:id};}
   if(op===OP.mint){const owner=b.to||b.creator,minted={collection:b.collection,edition:b.edition,creator:b.creator,name:b.name,type:b.type,size:b.content.length,sha256:hex(sha256(b.content)),...(b.origin?{origin:b.origin}:{})};
    if(b.collection!==NO_COLLECTION)collections.get(b.collection).editions.add(b.edition);
    mordinals.set(id,{number:null,reg:id,claimed:true,owner,seq:0,lot:null,minted,history:[{what:'mint',height:tip,record:id,to:owner}]});return {id,nft:id,owner,number:null};}
   if(op===OP.burn){const m=v.mordinal;m.history.push({what:'burn',height:tip,record:id,from:m.owner,to:null});m.owner=null;m.burned=true;m.seq++;return {id,nft:m.reg,number:m.number,owner:null};}
   if(op===OP.claim){const m=v.mordinal;m.claimed=true;m.history.push({what:'claim',height:tip,record:id,to:b.to,proof:b.proof===PROOF.payment?'payment proof and message':'one-time key'});m.owner=b.to;return {id,number:m.number,owner:m.owner};}
   if(op===OP.move){moved(v.mordinal,b.to,'move');return {id,number:v.mordinal.number,owner:b.to};}
   if(op===OP.list){const m=v.mordinal;lots.set(id,{id,reg:m.reg,number:m.number,seller:b.seller,price:b.price,until:b.until,height:tip,status:'open',reservations:[]});open.add(id);m.lot=id;return {id,lot:id,number:m.number};}
   if(op===OP.cancel){const l=v.lot,m=mordinals.get(l.reg);l.status='cancelled';l.cancelled={height:tip,record:id};open.delete(l.id);m.lot=null;m.seq++;return {id,lot:l.id};}
   if(op===OP.reserve){const a=amounts({price:v.lot.price,rate:b.rate,code:codeOf(id)});
    v.lot.reservations.push({record:id,buyer:b.buyer,height:tip,payBy:b.payBy,rate:b.rate,market:b.market||null,seller:a.seller.toString(),protocol:a.protocol.toString(),marketPay:a.market.toString()});return {id,lot:v.lot.id,payBy:b.payBy};}
   const l=v.lot,r=latest(l),m=mordinals.get(l.reg);for(const p of b.payments)payments.add(p.txid);for(const k of v.outputs)paidOutputs.add(k);
   l.status='sold';open.delete(l.id);l.sale={buyer:r.buyer,height:tip,record:id,payments:[...new Set(b.payments.map(p=>p.txid))],paid:v.paid};m.lot=null;
   moved(m,r.buyer,'sale',{price:l.price.toString(),fee:(l.price*BigInt(RULES.feeBps)/10000n).toString(),lot:l.id});return {id,lot:l.id,number:m.number,owner:r.buyer,paid:v.paid};},
  toJSON:()=>({height:tip,claimed:[...mordinals.values()].filter(m=>m.claimed&&!m.minted).map(m=>({number:m.number,owner:m.owner,seq:m.seq,lot:m.lot,history:m.history.map(h=>h.what)})),
   lots:[...lots.values()].map(l=>({id:l.id,number:l.number,seller:l.seller,price:l.price.toString(),status:l.status,buyer:l.sale?.buyer||null,reservations:l.reservations.length})),payments:[...payments].sort(),
   // Present only once something was minted, so a ledger of Mordinals alone has the summary it always had.
   ...(collections.size?{collections:[...collections.values()].map(c=>({id:c.id,creator:c.creator,name:c.name,max:c.max,editions:[...c.editions].sort((a,b)=>a-b)}))}:{}),
   ...([...mordinals.values()].some(m=>m.minted)?{minted:[...mordinals.values()].filter(m=>m.minted).map(m=>({id:m.reg,collection:m.minted.collection,edition:m.minted.edition,sha256:m.minted.sha256,owner:m.owner,seq:m.seq,burned:Boolean(m.burned)}))}:{})}),
 };
 function validate(record,facts){
  const d=decodeRecord(record,network),{op,body:b,bodyBytes,proof}=d,id=recordId(domain,bodyBytes),out={op,body:b,id};
  if(applied.has(id))throw Error('This record is already on the ledger.');
  const signedBy=address=>{const ctx=ctxFor(d);if(!verifySpendSignature(renderText(op,b,bodyBytes,ctx)+SUFFIX[proof.variant],address,{c:proof.c,r:proof.r},network))throw Error('The signature does not match this record.');};
  if((op===OP.collection||op===OP.mint||op===OP.burn)&&(mintFrom===null||tip<mintFrom))throw Error(mintFrom===null?'Minting and burning are not part of this ledger.':`Minting and burning start at block ${mintFrom}.`);
  if(op===OP.collection){signedBy(b.creator);return out;}
  if(op===OP.mint){
   // Standard mints only: the whole record has to fit a relayed transaction.
   if(record.length>MAX_RECORD)throw Error(`A mint record is at most ${MAX_RECORD} bytes; this one is ${record.length}.`);
   if(b.collection!==NO_COLLECTION){const c=collectionOf(b.collection);
    if(b.creator!==c.creator)throw Error('Only the creator of this collection can mint into it.');
    if(b.edition>c.max)throw Error(`This collection has ${c.max} editions.`);if(c.editions.has(b.edition))throw Error('This edition is already minted.');}
   signedBy(b.creator);return out;}
  if(op===OP.burn){const m=find(b.nft);
   if(m.burned)throw Error('This NFT was burned.');if(!m.claimed)throw Error('This Mordinal has not been claimed yet.');if(m.owner!==b.owner)throw Error('This Mordinal belongs to another address.');
   if(b.seq!==m.seq)throw Error('This record was signed for an earlier state of the Mordinal; prepare and sign it again.');
   if(m.lot)throw Error('This Mordinal is listed for sale; cancel the listing first.');signedBy(b.owner);return {...out,mordinal:m};}
  if(op===OP.claim){const m=find(b.reg);
   if(m.claimed)throw Error('This Mordinal is already claimed.');if(b.ownerTx!==m.ownerTx)throw Error('This is not the owner transaction of this Mordinal.');
   if(b.proof===PROOF.outputKey){if(!verifyOutputKeySignature(claimKeyHash(domain,bodyBytes),m.outputKey,proof.c,proof.r))throw Error('The signature was not made with the key of the owner coin.');}
   else{const holder=decodeAddress(b.holder,network);
    if(!verifyInProof({txid:m.ownerTx,txPub:m.txPub,address:holder,message:'',D:proof.D,c:proof.pc,r:proof.pr}))throw Error('The payment proof is not valid for this transaction and address (it must be made with an empty message).');
    if(!ownsOutput({D:proof.D,spend:holder.spend,outputKey:m.outputKey}))throw Error('This address did not receive output 0 of the owner transaction, so it does not hold this Mordinal.');
    signedBy(b.holder);}
   return {...out,mordinal:m};}
  if(op===OP.move||op===OP.list){const who=op===OP.move?b.from:b.seller,m=find(b.reg);
   if(m.burned)throw Error('This NFT was burned.');if(!m.claimed)throw Error('This Mordinal has not been claimed yet.');if(m.owner!==who)throw Error('This Mordinal belongs to another address.');
   if(b.seq!==m.seq)throw Error('This record was signed for an earlier state of the Mordinal; prepare and sign it again.');
   if(m.lot)throw Error('This Mordinal is listed for sale; cancel the listing first.');signedBy(who);
   if(op===OP.move){if(b.to===m.owner)throw Error('This address already owns the Mordinal.');return {...out,mordinal:m};}
   if(b.until<tip)throw Error('This listing expired; prepare and sign it again.');
   if(b.price<RULES.minPrice)throw Error(`The lowest price is ${formatXmr(RULES.minPrice)} XMR.`);
   if(b.seller===fee)throw Error('The fee address cannot sell.');return {...out,mordinal:m};}
  const lot=lotOf(b.lot);
  if(lot.status!=='open')throw Error(lot.status==='sold'?'This Mordinal is already sold.':'This listing was cancelled.');
  if(op===OP.cancel){if(b.seller!==lot.seller)throw Error('Only the seller can cancel this listing.');signedBy(b.seller);
   const r=running(lot);if(r)throw Error(`This listing is reserved until block ${heldUntil(r)}; it can be cancelled after that.`);return {...out,lot};}
  if(op===OP.reserve){signedBy(b.buyer);
   if(tip>lot.until)throw Error('This listing has expired.');if(b.buyer===lot.seller)throw Error('The seller cannot reserve their own listing.');
   const r=running(lot);if(r)throw Error(`This listing is reserved by someone else until block ${heldUntil(r)}.`);
   if(b.payBy<=tip)throw Error('This reservation ran out before it was posted; reserve again.');
   if(b.payBy>tip+RULES.maxReserve)throw Error(`A reservation lasts at most ${RULES.maxReserve} blocks.`);
   if(b.payBy>lot.until)throw Error('The reservation would outlast the listing.');
   if(b.rate>RULES.marketFeeCapBps)throw Error(`A marketplace fee is at most ${RULES.marketFeeCapBps/100}%.`);
   if(b.rate){if(b.market===lot.seller||b.market===fee)throw Error('The marketplace fee address must differ from the seller and the protocol fee address.');
    if(!(lot.price*BigInt(b.rate)/10000n>0n))throw Error('The marketplace fee would be zero.');}
   const a=amounts({price:lot.price,rate:b.rate,code:codeOf(id)}),taken=awaited();
   if(linesOf(lot,{seller:a.seller,protocol:a.protocol,rate:b.rate,market:b.market,marketPay:a.market}).some(([,address,amount])=>taken.has(address+':'+amount)))
    throw Error('Another reservation is waiting for exactly these amounts right now. Reserve again in a few minutes.');
   return {...out,lot};}
  // Buy: entry i of the record shows the payment to payee i of the reservation: one output of one transaction holding
  // the exact amount, with a proof made by the payer's transaction key for this listing. A transaction counts for one
  // sale only, and so does a coin: the same output key paid to the same address again does not count. (The same key at
  // another address is another coin for another wallet; refusing it would let anyone block a buyer by copying the key
  // of that buyer's payment to an address made for it.)
  const r=latest(lot);if(!r)throw Error('Nobody reserved this listing; reserve it before paying.');
  const seen=new Map((facts||[]).map(f=>[f.txid,f])),need=linesOf(lot,r),message=paymentMessage(domain,lot.id),outputs=[],paid={};
  if(b.payments.length>need.length)throw Error(`This record names ${b.payments.length} payments; this reservation has ${need.length} payees.`);
  need.forEach(([what,address,amount],i)=>{const p=b.payments[i];
   if(!p)throw Error(`The ${what} payment is missing; this reservation needs exactly ${formatXmr(amount)} XMR for it.`);
   const f=seen.get(p.txid);
   if(!f||!f.tx)throw Error('A payment in this record was not looked up.');if(payments.has(p.txid))throw Error('This payment was already used for a sale.');
   if(f.height==null)throw Error('A payment is not in a block yet; wait for 1 confirmation.');if(f.height>tip)throw Error('A payment is in a block after this record.');
   if(f.height<r.height)throw Error('A payment was made before the reservation.');
   if(f.height>lot.until)throw Error(`A payment was made after the listing ended (block ${lot.until}), so it does not count.`);
   const c=checkPaymentProof({tx:f.tx,txid:p.txid,out:p.out,D:p.D,c:p.c,s:p.s,address,message,network,what});
   if(c.amount!==BigInt(amount))throw Error(`The ${what} payment is ${formatXmr(c.amount)} XMR; this reservation needs exactly ${formatXmr(amount)} XMR.`);
   const coin=address+':'+c.key;if(paidOutputs.has(coin)||outputs.includes(coin))throw Error('A payment in this record repeats the key of a payment that was already used, so it does not count.');
   outputs.push(coin);paid[what]=c.amount.toString();});
  return {...out,lot,outputs,paid};}
 return api;
}
