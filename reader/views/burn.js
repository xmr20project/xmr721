// Claiming by burning, for the pages: says whether this ledger claims that way and shows how a burning transfer is
// made with the original Mordinals wallet, and how its fee is paid. A ledger without a first burn block shows none of this.
// The burn address, the text, the fee wallet and each Mordinal's fee address come from the rule library in these pages,
// not from the service: when the service states other ones, no instructions are shown.
import {burnAddress,CLAIM_PREFIX,feeWallet,feeAddressOf,formatXmr} from './rules.js';
import {el,service,count,exact,notice} from './ui.js';

// The XMR20 wallet's own way to burn is named only on pages whose index.html says that wallet has it:
//   <meta name="xmr721-wallet-burn" content="yes">
const walletBurns=()=>document.querySelector('meta[name="xmr721-wallet-burn"]')?.getAttribute('content')==='yes';
// null, or {from, recordsEnd, active, records, fits, address, text, wallet, fee}.
//   active   the ledger has reached its first burn block
//   records  claim records still count (they stop at block recordsEnd)
//   fits     the service states the burn address, the text and the fee wallet these pages work out themselves
//   fee      the fee wallet (main address, public view key), when it fits
export function burning(){
 const i=service.info;if(!i||i.burnFrom==null)return null;
 let address=null,wallet=null;try{address=burnAddress(i.network);wallet=feeWallet(null,i.network);}catch{}
 const text=CLAIM_PREFIX+'<address>',b=i.burn,f=b?.fee,feeFits=Boolean(wallet&&f&&f.wallet===wallet.address&&f.viewKey===wallet.viewKey&&f.account===1&&f.offset===1);
 const fits=Boolean(b&&address&&b.address===address&&b.text===text&&Number.isInteger(b.recordsEnd)&&b.recordsEnd>i.burnFrom&&feeFits);
 return {from:i.burnFrom,recordsEnd:fits?b.recordsEnd:null,active:i.height>=i.burnFrom,records:fits&&i.height<b.recordsEnd,fits,address,text,wallet:walletBurns(),fee:fits?wallet:null};}
export const burnMisfit=()=>notice('warn',el('span',{'data-burn':'misfit',text:'This service states another burn address, claim text or fee wallet than these pages work out themselves, so no instructions are shown. The service does not fit its code: do not burn a Mordinal or pay a fee on its word.'}));
// The fee address of Mordinal n, worked out here.
export const feeAddress=(b,n)=>feeAddressOf(b.fee,n).address;
// The two things a burning transfer needs, to copy: where the old Mordinal goes, and what its text says; and, on a page
// about no one Mordinal, where fees go. The fee wallet's main address is never shown: nobody is to pay it.
export const burnFacts=(b,{number=null}={})=>el('dl',{class:'kv one','data-burn':'facts'},
 el('div',{},el('dt',{text:'Burn address (nobody can spend from it)'}),el('dd',{},exact(b.address,{what:'burn address'}))),
 el('div',{},el('dt',{text:'Text of the transfer, exactly'}),el('dd',{},el('code',{'data-burn':'text',text:b.text})),
  el('dd',{class:'dim',text:'<address> is the Monero address that will own the Mordinal: a main address or a subaddress, with nothing before it and at most one line end after it.'})),
 number==null?el('div',{'data-burn':'fee-wallet'},el('dt',{text:'Fee addresses'}),
  el('dd',{class:'dim',text:'Each Mordinal has a fee address of its own, shown on its own page. The fee wallet’s view key is public, so anyone can see every fee payment and the Mordinal it is for:'}),
  el('dd',{},exact(b.fee.viewKey,{what:'fee wallet view key'}))):null);
// What is not refunded.
const noRefund=()=>notice('warn',el('span',{'data-burn':'no-refund',text:'Fees are not refunded: a fee paid without a valid burn, also for a burn that is refused; a payment to the fee wallet’s main address or to another Mordinal’s fee address; more than is due; and a fee for a burn that a claim by signature overtook.'}));
// Which wallet to pay from.
const payFrom=()=>el('p',{class:'dim','data-burn':'pay-from',text:'Pay from a wallet that holds no inscribed coins: never from the 2023 Mordinals wallet or a wallet restored from the same seed. A payment can spend any coin of its wallet, and an inscribed coin spent as money is gone as a Mordinal.'});
// Someone paying for another holder's burn waits until claims by signature stop: until then the holder can still claim
// the Mordinal that way, and the burn would be lost with its fee.
const others=b=>b.records?el('p',{class:'dim','data-burn':'others',text:`Paying the fee for someone else’s burn? Wait until block ${count(b.recordsEnd)}. Until then its holder can still claim the Mordinal by signature, and the burn, with the fee paid for it, would be lost.`}):null;
// The fee. waiting: the burn claim of this Mordinal that waits for its fee ({due, paid, missing} in piconero, as
// /mordinal states it): what is still missing, to the address worked out here. Before the burn, only when and how.
export function burnFee(b,{number=null,waiting=null}={}){
 if(number!=null&&waiting)return el('div',{class:'stack','data-burn':'fee'},
  el('p',{},'Pay ',el('strong',{'data-burn':'fee-amount',text:formatXmr(BigInt(waiting.missing))+' XMR'}),` to the fee address of Mordinal #${count(number)}:`),
  el('div',{'data-burn':'fee-address'},exact(feeAddress(b,number),{what:'fee address'})),
  el('p',{class:'dim','data-burn':'paid',text:`Paid so far: ${formatXmr(BigInt(waiting.paid))} of ${formatXmr(BigInt(waiting.due))} XMR, the burn transaction’s own fee, which the claim pays once more to the project. A payment shows here once it is in a block.`}),
  payFrom(),others(b),noRefund());
 return el('div',{class:'stack','data-burn':'fee'},
  el('p',{},'Pay the fee after the burn. Once the burn is in a block, '+(number!=null?'this page shows':'the Mordinal’s page shows')+' the Mordinal as burned and waiting for its fee, with the exact amount still missing (the burn transaction’s own fee, about 0.001 XMR) and the address to pay it to'+(number!=null?'.':': each Mordinal has a fee address of its own.')),
  payFrom(),others(b),noRefund());}
// How it is done, step by step, and what cannot be undone. number: the Mordinal the page is about, if one.
export const burnHow=(b,{number=null}={})=>[
 b.wallet?el('p',{'data-burn':'wallet',text:'In the XMR20 wallet, “Burn and claim” builds and sends this transfer. With the original Mordinals wallet it takes three commands and a payment:'})
  :el('p',{text:'With the original Mordinals wallet, the one that made the transfers of 2023, it takes three commands, and a payment from any Monero wallet:'}),
 el('ol',{'data-burn':'steps'},
  el('li',{},'Write the text to a file, with no other byte in it (put your own address in):',el('pre',{class:'cmd','data-burn':'file',text:`printf '%s' '${b.text}' > claim.txt`})),
  el('li',{},'In the wallet, ',el('code',{text:'list_my_inscriptions'}),' prints the inscription hash of each Mordinal it holds.'),
  el('li',{},'Transfer the Mordinal to the burn address:',el('pre',{class:'cmd','data-burn':'command',text:`transfer_inscription <inscription hash> ${b.address} claim.txt`})),
  el('li',{'data-burn':'fee-step'},'Pay the fee, from any Monero wallet. ',burnFee(b,{number}))),
 burnFacts(b,{number}),
 notice('warn',el('span',{'data-burn':'once',text:`A burn cannot be tried again. It counts only in block ${count(b.from)} or later, with exactly this text, to exactly this address and with a transaction fee of at least 0.001 XMR. A burn that is refused has still spent the coin: that Mordinal can then never be claimed by burning. A burn that counts claims the Mordinal once its fee is paid; until then the Mordinal is burned and waits for it.`
  +(b.records?` Until block ${count(b.recordsEnd)} a claim by signature, as before, still counts, also after a refused burn or while a burn waits for its fee: the first claim that completes wins.`:'')})),
 notice('note','The transfer shows in public which coin held the Mordinal and which address receives it; the fee payment shows, to anyone, that it is a fee for that Mordinal. Feather and Cake Wallet cannot make the transfer; they can pay the fee, and they send and sell a claimed Mordinal as before.')];
// Ahead of the first burn block: what changes, and when.
export const burnAhead=b=>`From block ${count(b.from)} a Mordinal is claimed by burning it: one Monero transaction that sends the old Mordinal to an address nobody can spend from and names the address that will own it, and a fee of the same size as that transaction’s own fee, paid to the Mordinal’s fee address. A burn in a block before that one claims nothing. `
 +(b.recordsEnd!=null?`Claims by signature still count until block ${count(b.recordsEnd)}; claims made before then stay as they are.`:'Claims made before then stay as they are.');
