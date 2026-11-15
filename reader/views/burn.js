// Claiming by burning, for the pages: says whether this ledger claims that way and shows how a burning transfer is
// made with the original Mordinals wallet. A ledger without a first burn block shows none of this.
// The burn address and the text come from the rule library in these pages, not from the service: when the service
// states other ones, no instructions are shown.
import {burnAddress,CLAIM_PREFIX} from './rules.js';
import {el,service,count,exact,notice} from './ui.js';

// The XMR20 wallet's own way to burn is named only on pages whose index.html says that wallet has it:
//   <meta name="xmr721-wallet-burn" content="yes">
const walletBurns=()=>document.querySelector('meta[name="xmr721-wallet-burn"]')?.getAttribute('content')==='yes';
// null, or {from, recordsEnd, active, records, fits, address, text, wallet}.
//   active   the ledger has reached its first burn block
//   records  claim records still count (they stop at block recordsEnd)
//   fits     the service states the burn address and the text these pages work out themselves
export function burning(){
 const i=service.info;if(!i||i.burnFrom==null)return null;
 let address=null;try{address=burnAddress(i.network);}catch{}
 const text=CLAIM_PREFIX+'<address>',b=i.burn,fits=Boolean(b&&address&&b.address===address&&b.text===text&&Number.isInteger(b.recordsEnd)&&b.recordsEnd>i.burnFrom);
 return {from:i.burnFrom,recordsEnd:fits?b.recordsEnd:null,active:i.height>=i.burnFrom,records:fits&&i.height<b.recordsEnd,fits,address,text,wallet:walletBurns()};}
export const burnMisfit=()=>notice('warn',el('span',{'data-burn':'misfit',text:'This service states another burn address or claim text than these pages work out themselves, so no instructions are shown. The service does not fit its code: do not burn a Mordinal on its word.'}));
// The two things a burning transfer needs, to copy: where the old Mordinal goes, and what its text says.
export const burnFacts=b=>el('dl',{class:'kv one','data-burn':'facts'},
 el('div',{},el('dt',{text:'Burn address (nobody can spend from it)'}),el('dd',{},exact(b.address,{what:'burn address'}))),
 el('div',{},el('dt',{text:'Text of the transfer, exactly'}),el('dd',{},el('code',{'data-burn':'text',text:b.text})),
  el('dd',{class:'dim',text:'<address> is the Monero address that will own the Mordinal: a main address or a subaddress, with nothing before it and at most one line end after it.'})));
// How it is done, step by step, and what cannot be undone.
export const burnHow=b=>[
 b.wallet?el('p',{'data-burn':'wallet',text:'In the XMR20 wallet, “Burn and claim” builds and sends this transfer. With the original Mordinals wallet it takes three commands:'})
  :el('p',{text:'With the original Mordinals wallet, the one that made the transfers of 2023, it takes three commands:'}),
 el('ol',{'data-burn':'steps'},
  el('li',{},'Write the text to a file, with no other byte in it (put your own address in):',el('pre',{class:'cmd','data-burn':'file',text:`printf '%s' '${b.text}' > claim.txt`})),
  el('li',{},'In the wallet, ',el('code',{text:'list_my_inscriptions'}),' prints the inscription hash of each Mordinal it holds.'),
  el('li',{},'Transfer the Mordinal to the burn address:',el('pre',{class:'cmd','data-burn':'command',text:`transfer_inscription <inscription hash> ${b.address} claim.txt`}))),
 burnFacts(b),
 notice('warn',el('span',{'data-burn':'once',text:`A burn cannot be tried again. It counts only in block ${count(b.from)} or later, with exactly this text, to exactly this address and with a fee of at least 0.001 XMR. A burn that is refused has still spent the coin: that Mordinal can then never be claimed by burning.`
  +(b.records?` Until block ${count(b.recordsEnd)} a claim by signature, as before, still counts, also after a refused burn.`:'')})),
 notice('note','The transfer shows in public which coin held the Mordinal and which address receives it. Feather and Cake Wallet cannot make it; they send and sell a claimed Mordinal as before.')];
// Ahead of the first burn block: what changes, and when.
export const burnAhead=b=>`From block ${count(b.from)} a Mordinal is claimed by burning it: one Monero transaction that sends the old Mordinal to an address nobody can spend from and names the address that will own it. A burn in a block before that one claims nothing. `
 +(b.recordsEnd!=null?`Claims by signature still count until block ${count(b.recordsEnd)}; claims made before then stay as they are.`:'Claims made before then stay as they are.');
