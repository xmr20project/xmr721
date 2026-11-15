// Claiming by burning, for the pages: says whether this ledger claims that way and shows the burn address and the
// text a burning transfer carries. A ledger without a first burn block shows none of this.
import {el,service,count,exact} from './ui.js';

// null, or {from, active, address, text}: active once the ledger has reached its first burn block.
export function burning(){
 const i=service.info;if(!i||i.burnFrom==null||!i.burn)return null;
 return {from:i.burnFrom,active:i.height>=i.burnFrom,address:i.burn.address,text:i.burn.text};}
// The two things a burning transfer needs, to copy: where the old Mordinal goes, and what its text says.
export const burnFacts=b=>el('dl',{class:'kv one','data-burn':'facts'},
 el('div',{},el('dt',{text:'Burn address (nobody can spend from it)'}),el('dd',{},exact(b.address,{what:'burn address'}))),
 el('div',{},el('dt',{text:'Text of the transfer, exactly'}),el('dd',{},el('code',{'data-burn':'text',text:b.text})),
  el('dd',{class:'dim',text:'<address> is the Monero address that will own the Mordinal: a main address or a subaddress, with nothing before or after.'})));
// With the original Mordinals wallet: one command.
export const burnCommand=b=>el('pre',{class:'cmd','data-burn':'command',text:`transfer_inscription <inscription> ${b.address} <text file>`});
// Ahead of the first burn block: what changes, and when.
export const burnAhead=b=>`From block ${count(b.from)} a Mordinal is claimed by burning it: one Monero transaction that sends the old Mordinal to an address nobody can spend from and names the address that will own it. Claims made before that block stay as they are.`;
