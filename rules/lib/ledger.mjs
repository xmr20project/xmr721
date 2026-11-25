// The rules as code: who owns each Mordinal, what is listed, what is reserved (RULES.md). Draft.
// A reader feeds it every MD1 record in chain order (setHeight, then apply); a relay or a wallet uses check before posting.
// Input that is not a record: the owner list at the start block (ownership-index/result/owners.jsonl format) and, for a buy
// record, the payment transactions it names as a Monero node returns them ({txid, height, tx}).
import {decodeAddress,usableSpendKey,verifySpendSignature,parseSignature,concat} from './monero.mjs';
import {inSet} from './offers.mjs';
import {OP,PROOF,RULES,SCOPE,SUFFIX,MAX_RECORD,NO_COLLECTION,heldUntil,encodeBody,decodeRecord,recordId,codeOf,amounts,renderText,nftLabel,signerOf,attachSignature,matchSignature,canonical,formatXmr} from './records.mjs';
import {sha256} from '@noble/hashes/sha256';
import {hex,unhex} from './monero.mjs';
import {claimKeyHash,verifyOutputKeySignature,parseInProof,verifyInProof,ownsOutput} from './claim.mjs';
import {checkPaymentProof,paymentMessage} from './payment.mjs';
import {RECORDS_OVERLAP,deadOutputs,burnAddress,burnClaimId,readTransfer,claimTo,recordCost,movedOutput,paysBurnAddress} from './burn.mjs';
import {FEE_ACCOUNT,feeWallet,feeAddressOf,feeTable,feeOutputs} from './burn-fee.mjs';
import {extraKeys} from './payment.mjs';
import {SPEND_BASE,spendDue,verifyKeyImageProof,mayHaveMoved,keyImagesOf} from './spend.mjs';

// mintFrom: the first block at which collection, mint and burn records count (a setting of the ledger, like the start
// block). Without it those records are refused, and the ledger is one of Mordinals only.
// burnFrom: the first block from which a Mordinal is claimed by burning it (section 10; also a setting of the ledger).
// Claim records still count for RECORDS_OVERLAP blocks from there, then no longer. burnDead: the fifteen dead outputs,
// for a chain that is not mainnet; testChain says the chain is the offline test chain, whose addresses read as mainnet's.
// burnFee: the wallet that receives the fees of burn claims, {address, viewKey}; null for the project's own (burn-fee.mjs),
// the only one on mainnet. A burn claim completes once the fee payments for its Mordinal reach the burn's own fee.
// spendFrom: the first block from which a claim record may show a spent owner coin (proof 2, section 11; a setting of the
// ledger, at or after the first burn block). Such a claim waits, like a burn, until the fee payments for its Mordinal
// reach the network fee of the transaction that carried the record plus SPEND_BASE (spendDue).
// recordsFrom: the first block from which claim records of proof 0 and 1 count again (section 12; a setting of the ledger,
// at or after the block where they stopped). Burn claims and claims by a spent coin go on as before.
// offersFrom: the first block at which offer, accept and withdraw records count (section 13; a setting of the ledger).
export function createLedger({network='mainnet',domain,feeAddress,owners,height=0,mintFrom=null,minters=null,openFrom=null,burnFrom=null,burnDead=null,burnFee=null,spendFrom=null,recordsFrom=null,offersFrom=null,testChain=false}){
 if(!/^[0-9a-f]{64}$/.test(domain||''))throw Error('Ledger domain required');
 if(mintFrom!==null&&!(Number.isInteger(mintFrom)&&mintFrom>=1))throw Error('Bad first mint block');
 // Who may make collections and mint: anyone (null), or the addresses the ledger's setup lists. Like the first mint
 // block, the list is part of the setup every reader of one ledger shares.
 if(minters!==null&&!(Array.isArray(minters)&&minters.length))throw Error('Bad minter list');
 const mayMint=minters===null?null:new Set(minters.map(a=>canonical(a,network)));
 // A listed ledger can be opened: from block `openFrom` on (also part of the setup) anyone makes collections and mints.
 if(openFrom!==null&&!(Number.isInteger(openFrom)&&mayMint&&mintFrom!==null&&openFrom>mintFrom))throw Error('Bad opening block: it needs a minter list and comes after the first mint block');
 if(burnFrom!==null&&!(Number.isInteger(burnFrom)&&burnFrom>=1))throw Error('Bad first burn block');
 if(burnFrom===null&&burnDead!==null)throw Error('Dead outputs are named only with a first burn block');
 if(burnFrom===null&&burnFee!==null)throw Error('A fee wallet is named only with a first burn block');
 if(spendFrom!==null&&!(Number.isInteger(spendFrom)&&burnFrom!==null&&spendFrom>=burnFrom))throw Error('Bad first block of claims by a spent coin: it needs a first burn block at or before it');
 if(recordsFrom!==null&&!(Number.isInteger(recordsFrom)&&burnFrom!==null&&recordsFrom>=burnFrom+RECORDS_OVERLAP))throw Error('Bad first block of claim records counting again: it needs a first burn block and comes at or after the block where claim records stopped');
 if(offersFrom!==null&&!(Number.isInteger(offersFrom)&&offersFrom>=1))throw Error('Bad first block of offers');
 const dead=burnFrom===null?null:deadOutputs(burnDead,network,{testChain}),byOutput=new Map(),recordsEnd=burnFrom===null?null:burnFrom+RECORDS_OVERLAP;
 const feeW=dead?feeWallet(burnFee,network,{testChain}):null;
 // The fee address is checked like every address in a record: both keys must be keys a wallet can use.
 {const a=decodeAddress(feeAddress,network);if(!usableSpendKey(a.spend)||!usableSpendKey(a.view))throw Error('The fee address has a key no wallet can use.');}
 const fee=canonical(feeAddress,network),mordinals=new Map(),byNumber=new Map(),lots=new Map(),open=new Set(),applied=new Set(),payments=new Set(),paidOutputs=new Set(),collections=new Map(),offers=new Map();let tip=height;
 for(const o of owners){
  if(o.ownerTxPubKeys?.length!==1||o.ownerAdditionalPubKeys?.length)throw Error(`Owner list entry ${o.number} must have exactly one transaction public key`);
  const m={number:o.number,reg:o.registrationTx,ownerTx:o.ownerTx,outputKey:o.ownerOutputKey,txPub:o.ownerTxPubKeys[0],claimed:false,owner:null,seq:0,lot:null,history:[]};
  if(mordinals.has(m.reg)||byNumber.has(m.number))throw Error('Owner list repeats an entry');mordinals.set(m.reg,m);byNumber.set(m.number,m);
  // A burn claim names a Mordinal by the global index of its owner output, so every entry has to state it.
  if(dead){if(!Number.isSafeInteger(o.ownerOutputIndex)||o.ownerOutputIndex<0)throw Error(`Owner list entry ${o.number} does not state the global index of its owner output, which a ledger that claims by burning needs`);
   if(byOutput.has(o.ownerOutputIndex))throw Error('Owner list repeats an owner output');byOutput.set(o.ownerOutputIndex,m);}}
 // The fee of burn claims (section 10). Fee payments are facts kept from the first burn block on, whatever the state of
 // their Mordinal: `fees` holds, for each one-time output key found, the Mordinal and the amount; for a key found again
 // the larger amount (a wallet keeps one of two outputs with the same key, the larger). A burn claim waits in `burns`
 // until the payments for its Mordinal add up to its own fee.
 const fees=new Map(),paidTo=new Map(),burns=new Map();let feeKeys=null;
 const numberOf=key=>{if(!feeKeys)feeKeys=feeTable(feeW,[...byNumber.keys()]);const n=feeKeys(key);return n!==undefined&&byNumber.has(n)?n:undefined;};
 const paidFor=n=>paidTo.get(n)??0n;
 const burnView=b=>{const paid=paidFor(b.number),due=BigInt(b.due);return {...b,paid:paid.toString(),missing:(paid>=due?0n:due-paid).toString()};};
 // The claim of a waiting burn, once its fee is paid: as after a claim record to the address in its text.
 // A claim by a spent coin (section 11) waits in the same way; its `tx` is the transaction that spent the coin.
 const complete=m=>{const b=m.waiting;if(!b||m.claimed||paidFor(m.number)<BigInt(b.due))return null;
  m.claimed=true;m.waiting=null;m.owner=b.to;b.state='claimed';b.claimedAt=tip;m.history.push({what:'claim',height:tip,record:b.id,to:b.to,proof:b.kind==='spend'?'spent coin':'burn',tx:b.tx});
  return {id:b.id,number:m.number,owner:m.owner};};
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
 // Offers (section 13). An offer: {id, bidder, price, until, count, left (pieces not bought yet), running (accepts that
 // wait for their payment), kind, ref, rate, market, height, status: 'open' | 'withdrawn' | 'closed' (an accept ran out
 // unpaid) | 'done' (every piece bought)}. An accept is a listing with one reservation, made in one record: `offer`
 // names its offer, and its last block is the last block its reservation is held.
 const offerOf=id=>{const o=offers.get(id);if(!o)throw Error('This offer does not exist.');return o;};
 const offerOpen=o=>o.status==='open'&&o.until>=tip;
 // What an offer is for, in the words of its signed text.
 const scopeText=b=>b.kind===SCOPE.nft?(m=>labelOf(m)??`Mordinal #${m.number}`)(find(b.ref)):b.kind===SCOPE.collection?`"${collectionOf(b.ref).name}" (collection ${codeOf(b.ref)})`:`the set of Mordinals ${b.ref}`;
 // An accept whose payment did not come by the end of its hold frees its piece by itself, and its offer closes for good.
 // Done whenever the height moves, before anything is judged at the new height, so the state at a height is the same
 // however the blocks up to it were handed in.
 const lapse=()=>{for(const id of [...open]){const l=lots.get(id);if(!l.offer||l.until>=tip)continue;
  const m=mordinals.get(l.reg),o=offers.get(l.offer);l.status='lapsed';l.lapsed={height:l.until+1};open.delete(id);m.lot=null;m.seq++;o.running--;if(o.status==='open')o.status='closed';}};
 // How a minted NFT is named in a signed text. A Mordinal keeps "Mordinal #n".
 const labelOf=m=>m.minted?nftLabel(m.reg,m.minted,m.minted.collection===NO_COLLECTION?null:collections.get(m.minted.collection).name):undefined;
 const ctxFor=(d)=>{
  if(d.op===OP.collection)return {domain};
  if(d.op===OP.mint)return {domain,collectionName:d.body.collection===NO_COLLECTION?null:collectionOf(d.body.collection).name};
  if(d.op===OP.offer)return {domain,scope:scopeText(d.body)};
  if(d.op===OP.withdraw)return {domain};
  if(d.op===OP.accept){const m=find(d.body.reg);return {domain,number:m.number,what:labelOf(m),offer:offerOf(d.body.offer)};}
  const lot=d.op===OP.cancel||d.op===OP.reserve?lotOf(d.body.lot):null,m=lot?mordinals.get(lot.reg):find(d.op===OP.burn?d.body.nft:d.body.reg);return {domain,number:m.number,what:labelOf(m),lot,feeAddress:fee};};
 const textOf=bodyBytes=>{const d=decodeRecord(bodyBytes,network,{sig:false});return renderText(d.op,d.body,d.bodyBytes,ctxFor(d));};
 const prepared=(op,body)=>{const bodyBytes=encodeBody(op,body,network),id=recordId(domain,bodyBytes);return {bodyBytes,id,code:codeOf(id),text:textOf(bodyBytes)};};
 const owned=(x,by)=>{const m=find(x);if(!m.claimed)throw Error('This Mordinal has not been claimed yet.');if(m.owner!==canonical(by,network))throw Error('This Mordinal belongs to another address.');return m;};
 const api={
  get height(){return tip;},setHeight(h){if(h<tip)throw Error('Height cannot go back');tip=h;lapse();return h;},feeAddress:fee,
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
  // spendTx, keyImage: a claim by a spent coin (proof 2): the transaction that spent the owner coin and the coin's key image.
  prepareClaim({mordinal,to,holder,spendTx,keyImage}){const m=find(mordinal),spent=spendTx!==undefined||keyImage!==undefined;if(spent&&!holder)throw Error('A claim by a spent coin names the holding address.');
   const body={reg:m.reg,ownerTx:m.ownerTx,to,proof:spent?PROOF.spend:holder?PROOF.payment:PROOF.outputKey,holder,spendTx,keyImage};
   const bodyBytes=encodeBody(OP.claim,body,network),id=recordId(domain,bodyBytes);
   return {bodyBytes,id,code:codeOf(id),number:m.number,ownerTx:m.ownerTx,keyHash:claimKeyHash(domain,bodyBytes),text:holder?textOf(bodyBytes):null};},
  claimWithKey:(bodyBytes,{c,r})=>concat(bodyBytes,c,r),
  claimWithProof(bodyBytes,proofText,signature){const d=decodeRecord(bodyBytes,network,{sig:false});if(d.op!==OP.claim||d.body.proof!==PROOF.payment)throw Error('This claim does not take a payment proof');
   const p=parseInProof(proofText);if(!signature)throw Error('Paste the signature.');const s=parseSignature(signature),variant=matchSignature(textOf(bodyBytes),d.body.holder,s,network);
   if(variant<0)throw Error('This signature is not for this text and address. Sign the exact text with the spend key of '+d.body.holder+'.');
   return concat(bodyBytes,p.D,p.c,p.r,Uint8Array.of(variant),s.c,s.r);},
  // A claim by a spent coin: the payment proof, the signed key image ({c, r} as hex, from the wallet's key image export)
  // and the message signature.
  claimWithSpend(bodyBytes,proofText,signed,signature){const d=decodeRecord(bodyBytes,network,{sig:false});if(d.op!==OP.claim||d.body.proof!==PROOF.spend)throw Error('This claim does not take a spent coin');
   const p=parseInProof(proofText);if(!/^[0-9a-f]{64}$/.test(signed?.c||'')||!/^[0-9a-f]{64}$/.test(signed?.r||''))throw Error('The signed key image is missing.');
   if(!signature)throw Error('Paste the signature.');const s=parseSignature(signature),variant=matchSignature(textOf(bodyBytes),d.body.holder,s,network);
   if(variant<0)throw Error('This signature is not for this text and address. Sign the exact text with the spend key of '+d.body.holder+'.');
   return concat(bodyBytes,p.D,p.c,p.r,unhex(signed.c),unhex(signed.r),Uint8Array.of(variant),s.c,s.r);},
  prepareMove({mordinal,from,to}){const m=owned(mordinal,from);return prepared(OP.move,{reg:m.reg,seq:m.seq,from,to});},
  prepareList({mordinal,seller,price,until=tip+720}){const m=owned(mordinal,seller);return prepared(OP.list,{reg:m.reg,seq:m.seq,until,price,seller});},
  prepareCancel({lot,seller}){return prepared(OP.cancel,{lot,seller});},
  prepareReserve({lot,buyer,window=RULES.maxReserve,market,rate=0}){const l=lotOf(lot),p=prepared(OP.reserve,{lot,payBy:Math.min(tip+window,l.until),buyer,rate,market});
   const a=amounts({price:l.price,rate,code:p.code});return {...p,pay:[{to:l.seller,amount:a.seller,what:'seller'},{to:fee,amount:a.protocol,what:'protocol fee'},...(rate?[{to:canonical(market,network),amount:a.market,what:'marketplace fee'}]:[])]};},
  // Offers: an offer for one NFT, a collection made here or a set of Mordinals; its accept by an owner; its withdrawal.
  prepareOffer({bidder,price,count=1,until=tip+RULES.maxOffer,kind,ref,market,rate=0}){return prepared(OP.offer,{bidder,price,until,count,kind,ref,rate,market});},
  // -> also `pay`: what the bidder pays once this accept is in a block, and `payBy` counted from the block it lands in.
  prepareAccept({offer,mordinal,seller,path=[]}){const o=offerOf(offer),m=owned(mordinal,seller),p=prepared(OP.accept,{offer,reg:m.reg,seq:m.seq,seller,path});
   const a=amounts({price:o.price,rate:o.rate,code:p.code});return {...p,pay:[{to:canonical(seller,network),amount:a.seller,what:'seller'},{to:fee,amount:a.protocol,what:'protocol fee'},...(o.rate?[{to:o.market,amount:a.market,what:'marketplace fee'}]:[])]};},
  prepareWithdraw({offer,bidder}){return prepared(OP.withdraw,{offer,bidder});},
  offer:id=>{const o=offers.get(id);return o?{...o,open:offerOpen(o)}:null;},offerList:()=>[...offers.values()].map(o=>({...o,open:offerOpen(o)})),
  // Offers (section 13): the first block. null on a ledger without them.
  offers:offersFrom===null?null:{from:offersFrom},
  sign:(bodyBytes,signature)=>attachSignature(bodyBytes,signature,ctxFor(decodeRecord(bodyBytes,network,{sig:false})),network),
  // payments: one entry per payee in the reservation's order (provePayments in payment.mjs makes them).
  buyRecord:({lot,payments:p})=>encodeBody(OP.buy,{lot,payments:p},network),
  textOf,
  check(record,facts){return validate(record,facts);},
  // Claiming by burning (section 10). null on a ledger without it.
  // recordsEnd: the first block at which a claim record no longer counts.
  // fee: the fee wallet (its main address and public secret view key), the account of the fee addresses and what is
  // added to a Mordinal's number to give its index there.
  burn:dead?{from:burnFrom,recordsEnd,dead:[...dead],address:burnAddress(network),fee:{wallet:feeW.address,viewKey:feeW.viewKey,account:FEE_ACCOUNT,offset:1}}:null,
  // Claiming by a spent coin (section 11): the first block, and what such a claim pays to its Mordinal's fee address. null
  // on a ledger without it.
  spend:spendFrom===null?null:{from:spendFrom,base:SPEND_BASE.toString()},
  // Claim records counting again (section 12): the first block. null on a ledger without it.
  records:recordsFrom===null?null:{from:recordsFrom},
  // A burn claim is a transaction, not a record: `parts` is what burnParts() takes from it (burn.mjs).
  // due: the burn's own fee, which the fee payments for its Mordinal have to reach; paid: what they reach now.
  checkBurnClaim(txid,parts){const v=burnClaim(txid,parts),paid=paidFor(v.mordinal.number);return {id:v.id,number:v.mordinal.number,owner:v.to,due:v.due.toString(),paid:paid.toString(),waiting:paid<v.due};},
  // A valid burn claim. When the fee for its Mordinal is paid already it claims the Mordinal now (owner: the address in
  // its text); otherwise the Mordinal is burned and waits for its fee (owner: null, waiting: what is due and paid).
  applyBurnClaim(txid,parts){const v=burnClaim(txid,parts),m=v.mordinal,b={id:v.id,tx:txid,number:m.number,to:v.to,due:v.due.toString(),height:tip,state:'waiting'};
   burns.set(v.id,b);m.waiting=b;const done=complete(m);return done||{id:v.id,number:m.number,owner:null,waiting:burnView(b)};},
  // The fee payments in one transaction (`parts`: what feeParts() takes from it, burn-fee.mjs), counted from the first
  // burn block on. -> {paid: [{index, number, amount, counted, error}], claims: [{id, number, owner}]}: the outputs that pay
  // a fee address, and the burn claims they complete.
  // scanBurnFees finds the outputs (key derivations: the costly part); applyBurnFees counts them. `found`, when given,
  // is what scanBurnFees gave for these parts earlier (a reader rebuilding from its own journal), so nothing is derived
  // again; without it the outputs are found anew.
  scanBurnFees(parts){if(!dead)return [];return feeOutputs(parts,feeW,numberOf).map(f=>({...f,amount:f.amount==null?null:f.amount.toString()}));},
  applyBurnFees(txid,parts,found=null){
   if(!dead)throw Error('Claiming by burning is not part of this ledger.');if(tip<burnFrom)throw Error(`Fee payments count from block ${burnFrom}.`);
   if(!/^[0-9a-f]{64}$/.test(txid||''))throw Error('Transaction ID required');
   if(found!=null){if(!Array.isArray(found)||found.some(f=>!f||!Number.isInteger(f.index)||!parts?.outs?.[f.index]||!byNumber.has(f.number)||!(f.amount===null||/^\d{1,20}$/.test(f.amount))||!(f.error===null||typeof f.error==='string')||(f.error===null&&f.amount===null)))throw Error('The fee outputs given do not fit this transaction.');
    found=found.map(f=>({...f,amount:f.amount==null?null:BigInt(f.amount)}));}
   else found=feeOutputs(parts,feeW,numberOf);
   if(!found.length)throw Error('This transaction pays no fee address.');
   const paid=found.map(f=>{const out={index:f.index,number:f.number,amount:f.amount==null?null:f.amount.toString(),counted:false,error:f.error};if(f.error)return out;
    const key=parts.outs[f.index].key,had=fees.get(key);
    if(had&&had.amount>=f.amount)return {...out,error:'An earlier output with the same one-time key holds as much or more; a wallet keeps only one of them.'};
    fees.set(key,{number:f.number,amount:f.amount});paidTo.set(f.number,paidFor(f.number)-(had?had.amount:0n)+f.amount);return {...out,counted:true};});
   const claims=[];for(const f of paid)if(f.counted){const c=complete(byNumber.get(f.number));if(c)claims.push(c);}
   return {paid,claims};},
  // A burn claim by its id: {id, tx, number, to, due, height, state ('waiting', 'claimed' or 'lost': the Mordinal was
  // claimed by a record before the fee was paid), claimedAt, paid, missing}, or null.
  burnClaim:id=>{const b=burns.get(id);return b?burnView(b):null;},
  // What has been paid for one Mordinal's burn claim, and its fee address (subaddress (1, number + 1) of the fee wallet).
  burnFee:x=>{const m=find(x);if(!dead||m.number==null)return null;return {address:feeAddressOf(feeW,m.number).address,paid:paidFor(m.number).toString(),...(m.waiting?{waiting:burnView(m.waiting)}:{})};},
  apply(record,facts){
   const v=validate(record,facts),{op,body:b,id}=v;applied.add(id);
   const moved=(m,to,what,extra={})=>{m.history.push({what,height:tip,record:id,from:m.owner,to,...extra});m.owner=to;m.seq++;};
   if(op===OP.collection){collections.set(id,{id,creator:b.creator,name:b.name,max:b.max,height:tip,editions:new Set()});return {id,collection:id};}
   if(op===OP.mint){const owner=b.to||b.creator,minted={collection:b.collection,edition:b.edition,creator:b.creator,name:b.name,type:b.type,size:b.content.length,sha256:hex(sha256(b.content)),...(b.origin?{origin:b.origin}:{})};
    if(b.collection!==NO_COLLECTION)collections.get(b.collection).editions.add(b.edition);
    mordinals.set(id,{number:null,reg:id,claimed:true,owner,seq:0,lot:null,minted,history:[{what:'mint',height:tip,record:id,to:owner}]});return {id,nft:id,owner,number:null};}
   if(op===OP.burn){const m=v.mordinal;m.history.push({what:'burn',height:tip,record:id,from:m.owner,to:null});m.owner=null;m.burned=true;m.seq++;return {id,nft:m.reg,number:m.number,owner:null};}
   if(op===OP.claim&&b.proof===PROOF.spend){const m=v.mordinal,w={id,tx:b.spendTx,number:m.number,to:b.to,due:spendDue(facts).toString(),height:tip,state:'waiting',kind:'spend'};
    burns.set(id,w);m.waiting=w;const done=complete(m);return done||{id,number:m.number,owner:null,waiting:burnView(w)};}
   if(op===OP.claim){const m=v.mordinal;m.claimed=true;m.history.push({what:'claim',height:tip,record:id,to:b.to,proof:b.proof===PROOF.payment?'payment proof and message':'one-time key'});m.owner=b.to;
    // A burn of this Mordinal that still waits for its fee is passed over: the first claim that completes wins.
    if(m.waiting){m.waiting.state='lost';m.waiting.lostAt=tip;m.waiting=null;}
    return {id,number:m.number,owner:m.owner};}
   if(op===OP.move){moved(v.mordinal,b.to,'move');return {id,number:v.mordinal.number,owner:b.to};}
   if(op===OP.list){const m=v.mordinal;lots.set(id,{id,reg:m.reg,number:m.number,seller:b.seller,price:b.price,until:b.until,height:tip,status:'open',reservations:[]});open.add(id);m.lot=id;return {id,lot:id,number:m.number};}
   if(op===OP.cancel){const l=v.lot,m=mordinals.get(l.reg);l.status='cancelled';l.cancelled={height:tip,record:id};open.delete(l.id);m.lot=null;m.seq++;return {id,lot:l.id};}
   if(op===OP.reserve){const a=amounts({price:v.lot.price,rate:b.rate,code:codeOf(id)});
    v.lot.reservations.push({record:id,buyer:b.buyer,height:tip,payBy:b.payBy,rate:b.rate,market:b.market||null,seller:a.seller.toString(),protocol:a.protocol.toString(),marketPay:a.market.toString()});return {id,lot:v.lot.id,payBy:b.payBy};}
   if(op===OP.offer){offers.set(id,{id,bidder:b.bidder,price:b.price,until:b.until,count:b.count,left:b.count,running:0,kind:b.kind,ref:b.ref,rate:b.rate,market:b.market||null,height:tip,status:'open'});return {id,offer:id};}
   if(op===OP.withdraw){v.offer.status='withdrawn';v.offer.withdrawn={height:tip,record:id};return {id,offer:v.offer.id};}
   if(op===OP.accept){const o=v.offer,m=v.mordinal,a=amounts({price:o.price,rate:o.rate,code:codeOf(id)}),payBy=tip+RULES.maxReserve;
    const lot={id,reg:m.reg,number:m.number,seller:b.seller,price:o.price,until:payBy+RULES.settle,height:tip,status:'open',offer:o.id,
     reservations:[{record:id,buyer:o.bidder,height:tip,payBy,rate:o.rate,market:o.market,seller:a.seller.toString(),protocol:a.protocol.toString(),marketPay:a.market.toString()}]};
    lots.set(id,lot);open.add(id);m.lot=id;o.running++;return {id,lot:id,offer:o.id,number:m.number,payBy};}
   const l=v.lot,r=latest(l),m=mordinals.get(l.reg);for(const p of b.payments)payments.add(p.txid);for(const k of v.outputs)paidOutputs.add(k);
   if(l.offer){const o=offers.get(l.offer);o.running--;o.left--;if(!o.left&&o.status==='open')o.status='done';}
   l.status='sold';open.delete(l.id);l.sale={buyer:r.buyer,height:tip,record:id,payments:[...new Set(b.payments.map(p=>p.txid))],paid:v.paid};m.lot=null;
   moved(m,r.buyer,'sale',{price:l.price.toString(),fee:(l.price*BigInt(RULES.feeBps)/10000n).toString(),lot:l.id});return {id,lot:l.id,number:m.number,owner:r.buyer,paid:v.paid};},
  toJSON:()=>({height:tip,claimed:[...mordinals.values()].filter(m=>m.claimed&&!m.minted).map(m=>({number:m.number,owner:m.owner,seq:m.seq,lot:m.lot,history:m.history.map(h=>h.what)})),
   lots:[...lots.values()].map(l=>({id:l.id,number:l.number,seller:l.seller,price:l.price.toString(),status:l.status,buyer:l.sale?.buyer||null,reservations:l.reservations.length})),payments:[...payments].sort(),
   // Present only once something was minted, so a ledger of Mordinals alone has the summary it always had.
   // Present only once an offer was made.
   ...(offers.size?{offers:[...offers.values()].map(o=>({id:o.id,bidder:o.bidder,price:o.price.toString(),until:o.until,count:o.count,left:o.left,running:o.running,kind:o.kind,ref:o.ref,status:o.status}))}:{}),
   ...(collections.size?{collections:[...collections.values()].map(c=>({id:c.id,creator:c.creator,name:c.name,max:c.max,editions:[...c.editions].sort((a,b)=>a-b)}))}:{}),
   ...([...mordinals.values()].some(m=>m.minted)?{minted:[...mordinals.values()].filter(m=>m.minted).map(m=>({id:m.reg,collection:m.minted.collection,edition:m.minted.edition,sha256:m.minted.sha256,owner:m.owner,seq:m.seq,burned:Boolean(m.burned)}))}:{}),
   // On a ledger that claims by burning, once there is something to say: the burns that wait for their fee, and the fee
   // payments counted for each Mordinal.
   ...([...burns.values()].some(b=>b.state==='waiting')?{waiting:[...burns.values()].filter(b=>b.state==='waiting').sort((a,b)=>a.number-b.number).map(b=>({number:b.number,id:b.id,to:b.to,due:b.due}))}:{}),
   ...(paidTo.size?{fees:(outs=>[...paidTo].sort((a,b)=>a[0]-b[0]).map(([number,paid])=>({number,paid:paid.toString(),outputs:outs.get(number)})))
    ([...fees.values()].reduce((m,f)=>m.set(f.number,(m.get(f.number)||0)+1),new Map()))}:{})}),
 };
 function validate(record,facts){
  const d=decodeRecord(record,network),{op,body:b,bodyBytes,proof}=d,id=recordId(domain,bodyBytes),out={op,body:b,id};
  if(applied.has(id))throw Error('This record is already on the ledger.');
  const signedBy=address=>{const ctx=ctxFor(d);if(!verifySpendSignature(renderText(op,b,bodyBytes,ctx)+SUFFIX[proof.variant],address,{c:proof.c,r:proof.r},network))throw Error('The signature does not match this record.');};
  if((op===OP.collection||op===OP.mint||op===OP.burn)&&(mintFrom===null||tip<mintFrom))throw Error(mintFrom===null?'Minting and burning are not part of this ledger.':`Minting and burning start at block ${mintFrom}.`);
  // (The refusal reads the same with and without an opening block: a journal keeps the text a record was refused with.)
  if((op===OP.collection||op===OP.mint)&&mayMint&&!mayMint.has(b.creator)&&!(openFrom!==null&&tip>=openFrom))throw Error('On this ledger only the listed addresses make collections and mint.');
  if(op===OP.offer||op===OP.accept||op===OP.withdraw){
   if(offersFrom===null||tip<offersFrom)throw Error(offersFrom===null?'Offers are not part of this ledger.':`Offers start at block ${offersFrom}.`);
   if(op===OP.offer){
    if(b.price<RULES.minPrice)throw Error(`The lowest price is ${formatXmr(RULES.minPrice)} XMR.`);
    if(b.until<tip)throw Error('This offer ended before it was posted; prepare and sign it again.');
    if(b.until>tip+RULES.maxOffer)throw Error(`An offer ends at most ${RULES.maxOffer} blocks (about 7 days) after its block.`);
    if(b.bidder===fee)throw Error('The fee address cannot make an offer.');
    if(b.kind===SCOPE.nft){const m=find(b.ref);if(m.burned)throw Error('This NFT was burned.');}
    else if(b.kind===SCOPE.collection)collectionOf(b.ref);
    if(b.rate>RULES.marketFeeCapBps)throw Error(`A marketplace fee is at most ${RULES.marketFeeCapBps/100}%.`);
    if(b.rate){if(b.market===fee)throw Error('The marketplace fee address must differ from the protocol fee address.');
     if(!(b.price*BigInt(b.rate)/10000n>0n))throw Error('The marketplace fee would be zero.');}
    signedBy(b.bidder);return out;}
   const o=offerOf(b.offer);
   if(op===OP.withdraw){if(b.bidder!==o.bidder)throw Error('Only the bidder can withdraw this offer.');
    if(o.status!=='open')throw Error(o.status==='withdrawn'?'This offer was withdrawn already.':o.status==='done'?'This offer is complete.':'This offer is closed.');signedBy(b.bidder);return {...out,offer:o};}
   // Accept.
   if(o.status!=='open')throw Error(o.status==='withdrawn'?'This offer was withdrawn.':o.status==='done'?'This offer is complete.':'This offer is closed: an earlier accept of it was not paid.');
   if(o.until<tip)throw Error('This offer has ended.');
   if(tip+RULES.maxReserve+RULES.settle>o.until)throw Error('This offer ends too soon for a sale to be paid and recorded.');
   if(o.left-o.running<1)throw Error('Every piece this offer asks for is accepted already.');
   const m=find(b.reg);
   if(m.burned)throw Error('This NFT was burned.');if(!m.claimed)throw Error('This Mordinal has not been claimed yet.');if(m.owner!==b.seller)throw Error('This Mordinal belongs to another address.');
   if(b.seq!==m.seq)throw Error('This record was signed for an earlier state of the Mordinal; prepare and sign it again.');
   if(m.lot)throw Error('This Mordinal is listed for sale; cancel the listing first.');
   if(b.seller===o.bidder)throw Error('The bidder cannot accept their own offer.');if(b.seller===fee)throw Error('The fee address cannot sell.');
   if(o.rate&&o.market===b.seller)throw Error('The marketplace fee address must differ from the seller.');
   if(o.kind===SCOPE.nft?o.ref!==m.reg||b.path.length:o.kind===SCOPE.collection?!(m.minted&&m.minted.collection===o.ref)||b.path.length:m.minted||!inSet(m.reg,b.path,o.ref))
    throw Error('This offer is not for this NFT.');
   signedBy(b.seller);
   const a=amounts({price:o.price,rate:o.rate,code:codeOf(id)}),taken=awaited();
   if([[b.seller,a.seller],[fee,a.protocol],...(o.rate?[[o.market,a.market]]:[])].some(([address,amount])=>taken.has(address+':'+amount)))
    throw Error('Another sale is waiting for exactly these amounts right now. Accept again in a few minutes.');
   return {...out,offer:o,mordinal:m};}
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
  if(op===OP.claim){
   if(b.proof===PROOF.spend){if(spendFrom===null)throw Error('Claiming by a spent coin is not part of this ledger.');if(tip<spendFrom)throw Error(`Claiming by a spent coin starts at block ${spendFrom}.`);}
   else if(recordsEnd!==null&&tip>=recordsEnd&&(recordsFrom===null||tip<recordsFrom))throw Error(`From block ${recordsEnd} a Mordinal is claimed only by burning it; a claim record no longer counts.`);   // one text with or without recordsFrom: a journal keeps the text a record was refused with
   const m=find(b.reg);
   if(m.claimed)throw Error('This Mordinal is already claimed.');if(b.ownerTx!==m.ownerTx)throw Error('This is not the owner transaction of this Mordinal.');
   if(b.proof===PROOF.outputKey){if(!verifyOutputKeySignature(claimKeyHash(domain,bodyBytes),m.outputKey,proof.c,proof.r))throw Error('The signature was not made with the key of the owner coin.');}
   else{const holder=decodeAddress(b.holder,network);
    if(!verifyInProof({txid:m.ownerTx,txPub:m.txPub,address:holder,message:'',D:proof.D,c:proof.pc,r:proof.pr}))throw Error('The payment proof is not valid for this transaction and address (it must be made with an empty message).');
    if(!ownsOutput({D:proof.D,spend:holder.spend,outputKey:m.outputKey}))throw Error('This address did not receive output 0 of the owner transaction, so it does not hold this Mordinal.');
    if(b.proof===PROOF.spend)spentCoin(b,proof,m,facts);
    signedBy(b.holder);}
   return {...out,mordinal:m};}
  if(op===OP.move||op===OP.list){const who=op===OP.move?b.from:b.seller,m=find(b.reg);
   if(m.burned)throw Error('This NFT was burned.');if(!m.claimed)throw Error('This Mordinal has not been claimed yet.');if(m.owner!==who)throw Error('This Mordinal belongs to another address.');
   if(b.seq!==m.seq)throw Error('This record was signed for an earlier state of the Mordinal; prepare and sign it again.');
   if(m.lot)throw Error('This Mordinal is listed for sale; cancel the listing first.');signedBy(who);
   if(op===OP.move){if(b.to===m.owner)throw Error('This address already owns the Mordinal.');return {...out,mordinal:m};}
   if(b.until<tip)throw Error('This listing expired; prepare and sign it again.');
   if(b.until>tip+RULES.maxListing)throw Error(`A listing ends at most ${RULES.maxListing} blocks (about 30 days) after its block.`);
   if(b.price<RULES.minPrice)throw Error(`The lowest price is ${formatXmr(RULES.minPrice)} XMR.`);
   if(b.seller===fee)throw Error('The fee address cannot sell.');return {...out,mordinal:m};}
  const lot=lotOf(b.lot);
  if(lot.status!=='open')throw Error(lot.status==='sold'?'This Mordinal is already sold.':lot.status==='lapsed'?'This accepted offer was not paid in time.':'This listing was cancelled.');
  if(lot.offer&&op!==OP.buy)throw Error('This sale came from an accepted offer: it is paid by the bidder or ends by itself.');
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
 // A claim by a spent coin (section 11), after the payment proof: nothing waits for the Mordinal yet, the signed key image
 // is the owner coin's, and the transaction that spent it is in an earlier block, has that key image in an input and is an
 // did not move the Mordinal under the original rules. `facts`: the spending transaction as the node has it ({txid, height,
 // tx}; tx: its extra field and its inputs' key images and rings).
 function spentCoin(b,proof,m,facts){
  if(m.waiting)throw Error(m.waiting.kind==='spend'?'A claim of this Mordinal by its spent coin waits for its fee already.':'This Mordinal was burned already; that burn waits for its fee.');
  if(!verifyKeyImageProof({outputKey:m.outputKey,keyImage:b.keyImage,c:proof.kc,r:proof.kr}))throw Error('The signed key image is not the key image of the owner coin.');
  const f=(facts||[]).find(x=>x?.txid===b.spendTx&&!x.carrier);
  if(!f||!f.tx)throw Error('The spending transaction was not looked up.');
  if(f.height==null)throw Error('The spending transaction is not in a block yet; wait for 1 confirmation.');
  if(f.height>=tip)throw Error('The spending transaction has to be in a block before the block of this record.');
  // Only a coin spent from the first block of such claims on counts: the claim is for someone who holds the Mordinal then.
  if(f.height<spendFrom)throw Error(`The coin was spent before block ${spendFrom}; only a coin spent from that block on claims its Mordinal this way.`);
  if(!keyImagesOf(f.tx).includes(b.keyImage))throw Error('The spending transaction does not spend the owner coin (no input has its key image).');
  if(mayHaveMoved(f.tx,o=>byOutput.get(o)===m,dead))throw Error('The spending transaction is a transfer of this Mordinal in the original Mordinals format (a transfer or a burn): the Mordinal moved with it, so its spent coin does not claim it.');
  // What the claim pays is the network fee of the transaction that carries this record and the fixed part: the reader hands that fee over.
  if(spendDue(facts)===null)throw Error('The network fee of the transaction that carries this record was not looked up.');}
 // The checks of a burn claim, in this order; the first that fails is the reason a reader writes down.
 function burnClaim(txid,parts){
  if(!dead)throw Error('Claiming by burning is not part of this ledger.');
  if(tip<burnFrom)throw Error(`Claiming by burning starts at block ${burnFrom}.`);
  if(!/^[0-9a-f]{64}$/.test(txid||''))throw Error('Transaction ID required');
  let extra=null;try{extra=unhex(parts?.extra);}catch{}
  const t=extra&&readTransfer(extra);if(!t)throw Error('This transaction carries no transfer in the original Mordinals format.');
  const to=claimTo(t.text,network);
  // The original rules ignore a transfer that pays less, and the Mordinal would stay unburned for them.
  const cost=recordCost(t.text.length);if(!/^\d{1,20}$/.test(parts.fee||'')||BigInt(parts.fee)<cost)throw Error(`The fee is below the ${formatXmr(cost)} XMR the original rules ask for a text of ${t.text.length} bytes.`);
  const output=movedOutput(parts.inputs,dead),m=byOutput.get(output);
  if(!m)throw Error(`Output ${output}, which the ring names, is not the owner output of a Mordinal on the owner list.`);
  if(m.claimed)throw Error('This Mordinal is already claimed.');
  if(m.waiting)throw Error(m.waiting.kind==='spend'?'A claim of this Mordinal by its spent coin waits for its fee.':'This Mordinal was burned already; that burn waits for its fee.');
  // Output 0 is looked for with the transaction public key and, in a transaction that carries additional public keys
  // (one that also pays a subaddress, such as a fee address), with the additional key of output 0, as a wallet looks.
  if(!paysBurnAddress({txPub:t.txPub,additional:extraKeys([...extra]).additional[0]??null,key:parts.out0?.key,tag:parts.out0?.tag}))throw Error('Output 0 of this transaction does not pay the burn address.');
  return {id:burnClaimId(domain,txid),mordinal:m,to,due:BigInt(parts.fee)};}
 return api;
}
