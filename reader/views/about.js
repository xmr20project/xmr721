// What a reader has to trust, the newest checkpoint, and how to recompute it.
import {el,add,api,service,count,exact,addr,ROOT} from './ui.js';
import {burning,burnFacts,burnAhead} from './burn.js';

export async function about(ctx){
 ctx.title('About');const info=service.info,burn=burning();
 const c=await api('/checkpoint',{signal:ctx.signal});ctx.tip(c.height);
 const fact=(label,value)=>el('div',{},el('dt',{text:label}),el('dd',{},value));
 const origin=ROOT.href.replace(/\/$/,'');
 add(ctx.main,
  el('div',{class:'head'},el('h1',{text:'About and checking'}),
   el('p',{class:'lede',text:'Who owns a Mordinal is decided by public records in Monero blocks, not by this service. Here is what you rely on when you use these pages, and how to check it yourself.'})),
  el('section',{class:'about-grid'},
   el('div',{class:'card'},el('h2',{text:'What you trust'}),el('ul',{},
    el('li',{text:'This service reads Monero blocks and shows what the records in them add up to. It holds none of your keys and cannot move a Mordinal: only a message signed by the owning address can.'}),
    el('li',{text:'You rely on it to show the ledger truthfully and to pass your records on. A service that lies could hide or delay records. It cannot make one up.'}),
    el('li',{text:'These pages come from the same service. The text you sign names the Mordinal, the addresses and the exact amounts. Read it in your wallet before you sign: that text is what counts.'}),
    el('li',{text:'Before a purchase the page reads price, seller and end block from the seller’s signed listing and checks them against the listing code. The amounts you pay are worked out in your browser.'}))),
   el('div',{class:'card'},el('h2',{text:'What it costs'}),el('ul',{},
    el('li',{text:'Signing a message moves no XMR.'}),
    el('li',{text:info.relay?'The relay pays the Monero network fee of each record and charges nothing in this version.':'This service only reads: records cannot be sent from here.'}),
    el('li',{text:'A buyer pays the price in two payments: to the seller, and the 5% protocol fee to the fee address. The buyer’s own wallet adds its normal network fee for those payments.'}),
    el('li',{text:'A record counts only once it is in a Monero block. Until then it is shown as waiting, never as done.'}),
    burn?.active
     ?el('li',{'data-burn':'about'},'Claiming a Mordinal burns the old one: a Monero transaction made by the wallet that holds it (“Burn and claim” in the XMR20 wallet, or a transfer with the original Mordinals wallet), not on these pages. It spends the inscribed coin in public, names the receiving address and needs a fee of at least 0.001 XMR.',burnFacts(burn))
     :el('li',{text:'Claiming a Mordinal needs the keys of the wallet that holds it, so it is done in the XMR20 wallet or with the command-line tool, not on these pages.'}),
    burn&&!burn.active?el('li',{'data-burn':'ahead',text:burnAhead(burn)}):null))),
  el('section',{class:'section card stack','data-section':'checkpoint'},el('div',{class:'section-head'},el('h2',{text:'Newest checkpoint'}),el('span',{class:'dim',text:'Block '+count(c.height)})),
   el('p',{class:'muted',text:'A checkpoint sums up the ledger at one block: the accepted records so far and the owners they lead to. Two readers that saw the same chain get the same hashes.'}),
   el('dl',{class:'kv one'},
    fact('Block hash',exact(c.blockHash,{what:'block hash'})),
    fact('Accepted records',count(c.records)),
    fact('List hash (the accepted records, in order)',exact(c.listHash,{what:'list hash'})),
    fact('State hash (owners, listings and sales)',exact(c.stateHash,{what:'state hash'})))),
  el('section',{class:'section card stack','data-section':'verify'},el('h2',{text:'Check it yourself'}),
   el('p',{class:'muted'},'Anyone can recompute the checkpoint with ',el('code',{text:'tools/verify.mjs'}),' from the reader’s source and the public owner list:'),
   el('pre',{class:'cmd',text:`node tools/verify.mjs --service ${origin} --owners owners.jsonl --node <your Monero node>`}),
   el('ul',{class:'plain'},
    el('li',{text:'It replays every record with the rules and compares the result with this service.'}),
    el('li',{},'With ',el('code',{text:'--node'}),' it looks each record and payment up on a Monero node you choose.'),
    el('li',{},'Only ',el('code',{text:'--scan <empty folder>'}),' reads the blocks itself, which also shows that no record was left out.'))),
  el('section',{class:'section card stack','data-section':'ledger'},el('h2',{text:'This ledger'}),
   el('dl',{class:'kv'},
    fact('Network',info.network+(info.test?' (test data)':'')),
    fact('Mordinals on the owner list',count(info.count)),
    fact('Start block',count(info.start)),
    fact('Protocol fee address',addr(info.feeAddress)),
    fact('Ledger domain',exact(info.domain,{what:'ledger domain'})),
    fact('Owner list hash',exact(info.owners,{what:'owner list hash'})))));}
