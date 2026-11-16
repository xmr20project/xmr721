// Claiming by burning, for the pages: says whether this ledger claims that way and shows how a burning transfer is
// made with the original Mordinals wallet, and how its fee is paid. A ledger without a first burn block shows none of this.
// The burn address, the text, the fee wallet and each Mordinal's fee address come from the rule library in these pages,
// not from the service: when the service states other ones, no instructions are shown.
import {burnAddress,CLAIM_PREFIX,FEE_SAFE,feeWallet,feeAddressOf,formatXmr} from './rules.js';
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
 const text=CLAIM_PREFIX+'<address>',b=i.burn,f=b?.fee,feeFits=Boolean(wallet&&f&&f.wallet===wallet.address&&f.viewKey===wallet.viewKey&&f.account===1);
 const fits=Boolean(b&&address&&b.address===address&&b.text===text&&Number.isInteger(b.recordsEnd)&&b.recordsEnd>i.burnFrom&&feeFits);
 return {from:i.burnFrom,recordsEnd:fits?b.recordsEnd:null,active:i.height>=i.burnFrom,records:fits&&i.height<b.recordsEnd,fits,address,text,wallet:walletBurns(),fee:fits?wallet:null};}
export const burnMisfit=()=>notice('warn',el('span',{'data-burn':'misfit',text:'This service states another burn address, claim text or fee wallet than these pages work out themselves, so no instructions are shown. The service does not fit its code: do not burn a Mordinal or pay a fee on its word.'}));
// The fee address of Mordinal n, worked out here.
export const feeAddress=(b,n)=>feeAddressOf(b.fee,n).address;
// The two things a burning transfer needs, to copy: where the old Mordinal goes, and what its text says; and where its fee goes.
export const burnFacts=(b,{number=null}={})=>el('dl',{class:'kv one','data-burn':'facts'},
 el('div',{},el('dt',{text:'Burn address (nobody can spend from it)'}),el('dd',{},exact(b.address,{what:'burn address'}))),
 el('div',{},el('dt',{text:'Text of the transfer, exactly'}),el('dd',{},el('code',{'data-burn':'text',text:b.text})),
  el('dd',{class:'dim',text:'<address> is the Monero address that will own the Mordinal: a main address or a subaddress, with nothing before it and at most one line end after it.'})),
 number==null?el('div',{'data-burn':'fee-wallet'},el('dt',{text:'Fee addresses'}),
  el('dd',{class:'dim',text:'Each Mordinal has its own: the subaddress at account 1, index = its number, of this fee wallet. Its view key is public, so anyone can see every fee payment and the Mordinal it is for.'}),
  el('dd',{},exact(b.fee.address,{what:'fee wallet'})),el('dd',{},exact(b.fee.viewKey,{what:'fee wallet view key'}))):null);
// The fee: what to pay, and where. due: the amount still missing for a burn that waits (in piconero); without it, a
// safe amount above an ordinary burn's own fee.
export function burnFee(b,{number=null,due=null}={}){
 const amount=formatXmr(due!=null?BigInt(due):FEE_SAFE)+' XMR';
 return el('div',{class:'stack','data-burn':'fee'},
  number!=null
   ?el('p',{},'Pay at least ',el('strong',{'data-burn':'fee-amount',text:amount}),` to the fee address of Mordinal #${count(number)}, from any Monero wallet, before or after the burn:`)
   :el('p',{},'Pay at least ',el('strong',{'data-burn':'fee-amount',text:amount}),' to the fee address of that Mordinal, from any Monero wallet, before or after the burn. Each Mordinal has a fee address of its own; its page shows it.'),
  number!=null?el('div',{'data-burn':'fee-address'},exact(feeAddress(b,number),{what:'fee address'})):null,
  el('p',{class:'dim',text:due!=null?'This is what is still missing of the burn’s own transaction fee, which the claim pays once more to the project.'
   :'The fee is the burn transaction’s own fee once more (about 0.00103 XMR for an ordinary burn); 0.0012 XMR covers it. The claim completes in the first block in which the burn and enough fee for this Mordinal are both on the chain.'}),
  notice('warn',el('span',{'data-burn':'no-refund',text:'A fee paid without a burn, or to the fee address of another Mordinal, is not refunded.'})));}
// How it is done, step by step, and what cannot be undone. number: the Mordinal the page is about, if one.
export const burnHow=(b,{number=null}={})=>[
 b.wallet?el('p',{'data-burn':'wallet',text:'In the XMR20 wallet, “Burn and claim” builds and sends this transfer. With the original Mordinals wallet it takes three commands and a payment:'})
  :el('p',{text:'With the original Mordinals wallet, the one that made the transfers of 2023, it takes three commands, and a payment from any Monero wallet:'}),
 el('ol',{'data-burn':'steps'},
  el('li',{},'Write the text to a file, with no other byte in it (put your own address in):',el('pre',{class:'cmd','data-burn':'file',text:`printf '%s' '${b.text}' > claim.txt`})),
  el('li',{},'In the wallet, ',el('code',{text:'list_my_inscriptions'}),' prints the inscription hash of each Mordinal it holds.'),
  el('li',{},'Transfer the Mordinal to the burn address:',el('pre',{class:'cmd','data-burn':'command',text:`transfer_inscription <inscription hash> ${b.address} claim.txt`})),
  el('li',{'data-burn':'fee-step'},'Pay the fee. ',burnFee(b,{number}))),
 burnFacts(b,{number}),
 notice('warn',el('span',{'data-burn':'once',text:`A burn cannot be tried again. It counts only in block ${count(b.from)} or later, with exactly this text, to exactly this address and with a transaction fee of at least 0.001 XMR. A burn that is refused has still spent the coin: that Mordinal can then never be claimed by burning. A burn that counts claims the Mordinal once its fee is paid; until then the Mordinal is burned and waits for it.`
  +(b.records?` Until block ${count(b.recordsEnd)} a claim by signature, as before, still counts, also after a refused burn or while a burn waits for its fee: the first claim that completes wins.`:'')})),
 notice('note','The transfer shows in public which coin held the Mordinal and which address receives it; the fee payment shows, to anyone, that it is a fee for that Mordinal. Feather and Cake Wallet cannot make the transfer; they can pay the fee, and they send and sell a claimed Mordinal as before.')];
// Ahead of the first burn block: what changes, and when.
export const burnAhead=b=>`From block ${count(b.from)} a Mordinal is claimed by burning it: one Monero transaction that sends the old Mordinal to an address nobody can spend from and names the address that will own it, and a fee of the same size as that transaction’s own fee, paid to the Mordinal’s fee address. A burn in a block before that one claims nothing. `
 +(b.recordsEnd!=null?`Claims by signature still count until block ${count(b.recordsEnd)}; claims made before then stay as they are.`:'Claims made before then stay as they are.');
