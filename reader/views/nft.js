// Minted NFTs (RULES.md section 9): the list, one NFT's page with what its owner can do, a made collection, and the
// Create page. Everything that is signed is built here from the records themselves; the service's plain fields are
// only used for reading.
import {OP,RULES,MAX_RECORD,NO_COLLECTION,MAX_NAME,MAX_EDITIONS,encodeBody,decodeRecord,recordId,codeOf,renderText,nftLabel,splitOf,formatXmr,parseXmr,canonical,unhex} from './rules.js';
import {el,add,api,service,count,xmr,relayFee,addr,txid,code,notice,pill,strong,table,field,textInput,eventColumns,waitingList,terms,running,draft,ROOT} from './ui.js';
import {signPanel,signingWallet} from './sign.js';
import {walletLink,watchWallet} from './wallet.js';
// An origin as RULES.md describes it: kind 1 with 36 bytes is a Bitcoin inscription id, txid then the index (u32 little-endian).
const originText=o=>o.kind===1&&/^[0-9a-f]{72}$/.test(o.ref)?`Bitcoin inscription ${o.ref.slice(0,64)}i${parseInt(o.ref.slice(64).match(/../g).reverse().join(''),16)}`:`${o.kind===1?'Bitcoin inscription':'kind '+o.kind} ${o.ref}`;

const TYPES={1:'PNG picture',2:'JPEG picture',3:'WebP picture',4:'GIF picture',5:'Text',6:'JSON',7:'MP4 video',8:'Text art'},LISTING_BLOCKS=720,SIGNATURE=65;
const fact=(label,value)=>el('div',{},el('dt',{text:label}),el('dd',{},value));
const readOnly=()=>notice('note','Records cannot be sent from here: this service only reads.');
// Whether this ledger takes mints now, and a line to show when it does not.
const closed=height=>{const from=service.info.mintFrom;return from==null?'Creating NFTs is not switched on for this ledger yet.':height<from?`Creating NFTs starts at block ${count(from)}.`:null;};

// One minted NFT, checked against its own records: the mint record must hash to the NFT's id, and the collection
// record to the collection's id. What the page signs and shows (collection, edition, name) comes from those records.
export async function loadNft(ctx,id){
 const info=service.info,v=await api('/nft/'+id,{signal:ctx.signal});let d,c=null;
 try{const bytes=unhex(v.record);d=decodeRecord(bytes,info.network);if(d.op!==OP.mint||recordId(info.domain,d.bodyBytes)!==id)throw 0;
  if(d.body.collection!==NO_COLLECTION){const cb=unhex(v.collectionRecord);c=decodeRecord(cb,info.network);if(c.op!==OP.collection||recordId(info.domain,c.bodyBytes)!==d.body.collection)throw 0;}}
 catch{throw Error('The service sent an NFT that does not fit its code.');}
 const b=d.body,what=nftLabel(id,b,c?.body.name??null);
 return {...v,id,mint:b,collectionName:c?.body.name??null,what,title:b.name||(c?`${c.body.name} #${b.edition}`:'NFT '+codeOf(id).slice(0,8))};}
// The content: a picture, a text, or a line saying it is not shown.
export function nftPicture(ctx,id,type,{size=''}={}){
 const box=el('div',{class:('pic nftpic '+size).trim(),'data-nft':id}),src=new URL(`nft/${id}/content`,ROOT).href;
 if(type>=1&&type<=4){const img=el('img',{alt:'',loading:'lazy',src});img.addEventListener('error',()=>box.replaceChildren(el('span',{text:'Picture not available'})));box.append(img);}
 else if(type===5){const text=el('span',{class:'nfttext'});box.append(text);
  fetch(src,{signal:ctx.signal}).then(r=>r.ok?r.text():'').then(t=>{text.textContent=t.slice(0,900);}).catch(()=>{});}
 else box.append(el('span',{text:(TYPES[type]||'This content')+' is not shown'}));
 return box;}
// What a listing is about, for the market's listing and buying pages: a Mordinal or a minted NFT.
export async function subject(ctx,t,pic){
 if(t.nft==null)return {name:'Mordinal #'+count(t.number),href:'#/mordinal/'+t.number,what:undefined,key:t.number,picture:size=>pic(t.number,{size})};
 const n=await loadNft(ctx,t.nft);return {name:n.title,href:'#/nft/'+t.nft,what:n.what,key:t.nft,picture:size=>nftPicture(ctx,t.nft,n.mint.type,{size})};}
export const nftCard=(ctx,x)=>el('article',{class:'mcard','data-nft-card':x.id},
 el('a',{class:'cardpic',href:'#/nft/'+x.id},nftPicture(ctx,x.id,x.type)),
 el('a',{class:'meta',href:'#/nft/'+x.id},el('span',{class:'n',text:x.name||(x.collectionName?`${x.collectionName} #${x.edition}`:'NFT '+x.id.slice(0,8))}),
  el('span',{class:'s'},el('span',{text:x.burned?'Burned':x.collectionName?`${x.collectionName} #${x.edition}`:'No collection'}),x.lot&&!x.burned?el('span',{class:'price',text:xmr(x.lot.price)+' XMR'}):null)));

// Every minted NFT, newest first, and the collections made here.
export async function minted(ctx){
 ctx.title('New NFTs');
 const [n,c]=await Promise.all([api('/nfts?limit=120',{signal:ctx.signal}),api('/nft-collections',{signal:ctx.signal})]);ctx.tip(n.height);
 add(ctx.main,
  el('div',{class:'head'},el('h1',{text:'New NFTs'}),
   el('p',{class:'lede',text:'NFTs made under XMR721. Each one is whole in a single Monero transaction and belongs to a Monero address.'}),
   el('div',{class:'row head-row'},el('a',{class:'btn primary',href:'#/create',text:'Create an NFT'}),el('a',{class:'btn',href:'#/create?make=collection',text:'Create a collection'}))),
  closed(n.height)?notice('note',closed(n.height)):null,
  el('section',{class:'section','data-section':'made-collections'},el('div',{class:'section-head'},el('h2',{text:'Collections'}),el('span',{class:'dim',text:count(c.collections.length)})),
   table([{label:'Collection',cell:x=>el('a',{class:'strong',href:'#/set/'+x.id,text:x.name})},{label:'Minted',cell:x=>`${count(x.minted)} of ${count(x.max)}`},{label:'Creator',cell:x=>addr(x.creator)},
    {label:'Block',num:true,cell:x=>count(x.height)}],c.collections,'No collection has been made yet.')),
  el('section',{class:'section','data-section':'minted'},el('div',{class:'section-head'},el('h2',{text:'Newest'}),el('span',{class:'dim',text:count(n.total)})),
   n.items.length?el('div',{class:'grid'},n.items.map(x=>nftCard(ctx,x))):el('p',{class:'empty',text:'Nothing has been minted yet.'})));}

export async function madeCollection(ctx,id){
 const info=service.info,v=await api('/nft-collection/'+id,{signal:ctx.signal});let d;
 try{d=decodeRecord(unhex(v.record),info.network);if(d.op!==OP.collection||recordId(info.domain,d.bodyBytes)!==id)throw 0;}catch{throw Error('The service sent a collection that does not fit its code.');}
 ctx.title(d.body.name);ctx.tip(v.height);
 add(ctx.main,
  el('p',{class:'crumb'},el('a',{href:'#/nfts',text:'New NFTs'}),el('span',{text:'/'}),el('span',{text:'Collection'})),
  el('div',{class:'head'},el('h1',{class:'small',text:d.body.name}),el('p',{class:'lede',text:`${count(v.items.length)} of ${count(d.body.max)} editions minted.`})),
  el('div',{class:'card'},el('dl',{class:'kv'},fact('Creator',addr(d.body.creator)),fact('Collection code',code(id)),fact('Made at block',count(v.collection.height)),fact('Editions',count(d.body.max)))),
  el('section',{class:'section','data-section':'editions'},v.items.length?el('div',{class:'grid'},v.items.map(x=>nftCard(ctx,x))):el('p',{class:'empty',text:'No edition has been minted yet.'})),
  v.items.length<d.body.max?el('p',{class:'section'},el('a',{class:'btn',href:`#/create?collection=${id}`,text:'Mint the next edition'}),' ',el('span',{class:'dim',text:'Only the creator’s signature counts.'})):null);}

// One minted NFT and what its owner can do with it.
export async function nft(ctx,id,action){
 const info=service.info,n=await loadNft(ctx,id),x=n.nft,b=n.mint,home='#/nft/'+id;
 ctx.title(n.title);ctx.tip(n.height);
 let t=null,unfit=null;if(x.lot){try{t=terms(x.lot);}catch(e){unfit=e.message;}}
 const held=t&&running(t,n.height),ended=t&&t.until<n.height,rctx={domain:info.domain,number:null,what:n.what,feeAddress:info.feeAddress};
 const state=x.burned?pill('Burned','red'):t?(held?pill('Reserved','purple'):ended?pill('Sale ended'):pill('For sale','yellow')):pill('Owned','green');

 function owner(){
  const box=el('section',{class:'section card stack','data-section':'owner'},el('h2',{text:'Do you own this NFT?'}));
  if(x.burned){box.replaceChildren(el('h2',{text:'Burned'}),el('p',{class:'muted',text:'This NFT was ended by its owner. It has no owner and cannot be sent or sold.'}));return box;}
  if(!info.relay){box.append(readOnly());return box;}
  const panel=el('div',{class:'stack'}),open=el('button',{type:'button',class:'btn',text:'I own this','data-action':'own',onclick:()=>{open.hidden=true;choices();}});
  const done=text=>s=>el('div',{class:'stack'},notice('good',text+' The record is in block '+count(s.height)+'.'),el('p',{},el('a',{class:'btn',href:home,text:'Back to the NFT'})));
  const go=to=>()=>{location.hash=home+'/'+to;},leave=()=>{location.hash=home;};
  const sign=(op,body,title,lines,ok,back)=>{const bodyBytes=encodeBody(op,body,info.network);
   panel.replaceChildren(el('h3',{text:title}),...lines,signPanel(ctx,{bodyBytes,rctx,text:renderText(op,body,bodyBytes,rctx),signer:x.owner,back,backLabel:back===leave?'Cancel':'Back',done:done(ok),wallet:true}));};
  function choices(){
   const say=[el('p',{class:'muted'},'You send it, sell it, stop a sale or burn it by signing a message with the address that owns it, ',addr(x.owner),'. Signing moves no XMR.')];
   if(n.waiting.length)say.push(notice('note','A record for this NFT is waiting for a block. Wait until it is in a block before sending another.'));
   else if(unfit)say.push(notice('error',unfit));
   else if(held)say.push(notice('note','A buyer reserved it until block '+count(held.payBy)+'. You can stop the sale after that if it is not paid.'));
   else if(t)say.push(el('p',{class:'muted',text:ended?'This sale ended at block '+count(t.until)+'. Stop it before you send, sell or burn the NFT.':'It is for sale. Stop the sale before you send it, change the price or burn it.'}),
    el('div',{class:'row'},el('button',{type:'button',class:'btn primary',text:'Stop selling','data-action':'stop',onclick:go('stop')})));
   else say.push(el('div',{class:'row'},el('button',{type:'button',class:'btn primary',text:'Send','data-action':'send-start',onclick:go('send')}),
    el('button',{type:'button',class:'btn primary',text:'Sell','data-action':'sell-start',onclick:go('sell')}),el('button',{type:'button',class:'btn',text:'Burn','data-action':'burn-start',onclick:go('burn')})));
   panel.replaceChildren(...say);}
  function sendForm(typed=''){
   const to=textInput({class:'mono',value:typed,'data-field':'to'}),problem=el('div',{});
   const next=()=>{let dest;try{dest=canonical(to.value,info.network);if(dest===x.owner)throw Error('This address already owns it.');}catch(e){problem.replaceChildren(notice('error',e.message));return;}
    sign(OP.move,{reg:id,seq:x.seq,from:x.owner,to:dest},'Send '+n.title,[el('p',{class:'muted'},'To ',addr(dest),'. This cannot be undone.')],'Sent.',()=>sendForm(to.value));};
   panel.replaceChildren(el('h3',{text:'Send '+n.title}),field('Monero address that receives it',to,'A main address or a subaddress. Check it carefully: a sent NFT cannot be taken back.'),problem,
    el('div',{class:'row'},el('button',{type:'button',class:'btn primary',text:'Continue','data-action':'next',onclick:next}),el('button',{type:'button',class:'btn',text:'Cancel',onclick:leave})));}
  function sellForm(typed=''){
   const price=textInput({value:typed,placeholder:'0',inputmode:'decimal','data-field':'price'}),problem=el('div',{}),split=el('span',{'data-split':''});
   const read=()=>{const p=parseXmr(price.value);if(p<RULES.minPrice)throw Error('The lowest price is '+formatXmr(RULES.minPrice)+' XMR.');return p;};
   const hint=()=>{problem.replaceChildren();try{const s=splitOf(read());split.textContent=`You receive ${formatXmr(s.seller)} XMR · protocol fee ${formatXmr(s.fee)} XMR`;}catch{split.textContent='';}};
   price.addEventListener('input',hint);hint();
   const next=()=>{let p;try{p=read();}catch(e){problem.replaceChildren(notice('error',e.message));return;}
    const key=`sell:${id}:${x.seq}:${p}`,kept=draft.get(key),until=kept&&Number.isInteger(kept.until)&&kept.until>=n.height+LISTING_BLOCKS-120&&kept.until<=n.height+LISTING_BLOCKS?kept.until:n.height+LISTING_BLOCKS;
    draft.set(key,{until});const s=splitOf(p);
    sign(OP.list,{reg:id,seq:x.seq,until,price:p,seller:x.owner},'Sell '+n.title,
     [el('p',{class:'muted'},'For ',strong(formatXmr(p)+' XMR'),`: you receive ${formatXmr(s.seller)} XMR and ${formatXmr(s.fee)} XMR is the protocol fee. The sale ends at block ${count(until)}.`)],'It is for sale.',()=>sellForm(price.value));};
   panel.replaceChildren(el('h3',{text:'Sell '+n.title}),field('Price in XMR',price,split),problem,
    el('p',{class:'muted',text:`The buyer pays you directly. 5% of the price goes to the protocol fee address. The sale ends at block ${count(n.height+LISTING_BLOCKS)}, about one day from now; you can stop it earlier.`}),
    el('div',{class:'row'},el('button',{type:'button',class:'btn primary',text:'Continue','data-action':'next',onclick:next}),el('button',{type:'button',class:'btn',text:'Cancel',onclick:leave})));}
  box.append(open,panel);
  const free=!n.waiting.length&&!unfit;
  if(action==='send'&&free&&!t){open.hidden=true;sendForm();}
  else if(action==='sell'&&free&&!t){open.hidden=true;sellForm();}
  else if(action==='stop'&&free&&t&&!held){open.hidden=true;sign(OP.cancel,{lot:t.id,seller:x.owner},'Stop selling '+n.title,[el('p',{class:'muted',text:'The NFT stays yours. Nobody can buy it after the record is in a block.'})],'The sale is stopped.',leave);}
  else if(action==='burn'&&free&&!t){open.hidden=true;sign(OP.burn,{nft:id,seq:x.seq,owner:x.owner},'Burn '+n.title,
   [notice('warn','Burning ends this NFT for good. It will have no owner, and nobody, including you, can send or sell it again. This cannot be undone.')],'Burned.',leave);}
  else if(signingWallet(x.owner)){open.hidden=true;choices();}
  return box;}

 add(ctx.main,
  el('p',{class:'crumb'},el('a',{href:'#/nfts',text:'New NFTs'}),...(b.collection!==NO_COLLECTION?[el('span',{text:'/'}),el('a',{href:'#/set/'+b.collection,text:n.collectionName})]:[])),
  el('div',{class:'split'},nftPicture(ctx,id,b.type,{size:'large'}),
   el('div',{class:'stack'},
    el('div',{class:'head'},el('h1',{class:'small',text:n.title}),el('p',{class:'lede',text:b.collection===NO_COLLECTION?'An NFT in no collection':`${n.collectionName}, edition ${count(b.edition)}`})),
    el('div',{class:'row'},state,t&&!x.burned?strong(formatXmr(t.price)+' XMR'):null,t&&!held&&!ended&&!x.burned?el('a',{class:'btn primary small',href:'#/lot/'+t.id,text:'See and buy'}):null),
    el('div',{class:'card'},el('dl',{class:'kv'},
     fact('Owner',x.owner?addr(x.owner):'None (burned)'),fact('Creator',addr(b.creator)),
     fact('Content',`${TYPES[b.type]||'Type '+b.type}, ${count(b.content.length)} bytes`),fact('Minted at block',count(x.height)),
     fact('NFT code',code(id)),fact('Mint transaction',x.txid?txid(x.txid):''),
     ...(b.origin?[fact('Said to come from',originText(b.origin))]:[]))))),
  n.waiting.length?el('section',{class:'section','data-section':'waiting'},el('h2',{text:'Waiting for a block'}),waitingList(n.waiting)):null,
  owner(),
  el('section',{class:'section','data-section':'history'},el('div',{class:'section-head'},el('h2',{text:'History'})),table(eventColumns({number:false}),n.history.slice().reverse(),'Nothing yet.')));}

// What the relay charges for a collection or a mint, said before anything is signed.
const feeLine=(kind,what)=>{const f=relayFee(kind);return f?`${what} costs ${formatXmr(f)} XMR. It pays for putting the record on the Monero network; you pay it after signing, and nothing is sent before it arrives.`:`${what} has no fee. The relay pays the Monero network fee of the record.`;};
// Create: a collection, or one NFT. The content is read in the browser and goes into the record that is signed.
function sniff(bytes){
 const s=(sig,at=0)=>sig.every((v,i)=>bytes[at+i]===v);
 if(s([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))return 1;if(s([0xff,0xd8,0xff]))return 2;if(s([0x52,0x49,0x46,0x46])&&s([0x57,0x45,0x42,0x50],8))return 3;
 if(s([0x47,0x49,0x46,0x38]))return 4;return null;}
export async function create(ctx){
 ctx.title('Create');const info=service.info,height=info.height,make=ctx.query.get('make')==='collection'?'collection':'nft',into=/^[0-9a-f]{64}$/.test(ctx.query.get('collection')||'')?ctx.query.get('collection'):null;
 const stage=el('div',{class:'stack','data-section':'create'}),why=closed(height);
 add(ctx.main,
  el('div',{class:'head'},el('h1',{text:'Create'}),
   el('p',{class:'lede',text:'Make an NFT on Monero. Its content goes into one ordinary transaction, it belongs to your address, and it is sent or sold later by signature. No coin is spent or shown.'}),
   el('div',{class:'row head-row'},
    el('a',{class:'btn'+(make==='nft'?' primary':''),href:'#/create','data-make':'nft',text:'One NFT'}),el('a',{class:'btn'+(make==='collection'?' primary':''),href:'#/create?make=collection','data-make':'collection',text:'A collection'}))),
  why?notice('note',why):!info.relay?readOnly():el('section',{class:'section card stack'},stage));
 if(why||!info.relay)return;
 // A connected wallet that approves records itself: its address is the creator, and one approval there mints.
 const link=walletLink(),able=link&&typeof link.signRecord==='function',state=()=>{try{const s=link.status();return s.connected?canonical(s.address,info.network):'';}catch{return '';}},mine=able?state():'';
 if(able)watchWallet(ctx,()=>{if(state()!==mine)ctx.reload();});
 const bar=()=>{if(!able)return null;const problem=el('span',{class:'dim'});
  if(mine)return el('div',{class:'row','data-wallet':'connected'},pill(link.status().label||'Wallet','green'),addr(mine),el('span',{class:'dim',text:'You approve in this wallet. Nothing is copied or pasted.'}));
  const go=el('button',{type:'button',class:'btn primary small','data-action':'connect',text:'Connect wallet'});
  go.addEventListener('click',async()=>{go.disabled=true;problem.textContent='';try{await link.connect();}catch(e){problem.textContent=e.message||'The wallet did not answer.';}finally{go.disabled=false;}});
  return el('div',{class:'row','data-wallet':'off'},go,el('span',{class:'dim',text:'to create with one approval. Or type an address below and sign in any Monero wallet.'}),problem);};
 const done=(text,href,label)=>s=>el('div',{class:'stack'},notice('good',text+' The record is in block '+count(s.height)+'.'),el('p',{},el('a',{class:'btn primary',href,text:label})));
 const who=textInput({class:'mono','data-field':'creator',placeholder:'4… or 8…',value:mine}),problem=el('div',{}),fail=m=>problem.replaceChildren(notice('error',m));
 const signIt=(op,body,rctx,title,lines,after,back)=>{const bodyBytes=encodeBody(op,body,info.network),id=recordId(info.domain,bodyBytes);
  stage.replaceChildren(el('h2',{text:title}),...lines,signPanel(ctx,{bodyBytes,rctx,text:renderText(op,body,bodyBytes,rctx),signer:body.creator,back,done:after(id),wallet:true}));};

 function collectionForm(){
  const name=textInput({'data-field':'name',maxlength:String(MAX_NAME)}),max=textInput({'data-field':'max',inputmode:'numeric',placeholder:'100'});
  const next=()=>{let body;
   try{const editions=Number(max.value.trim());if(!Number.isInteger(editions)||editions<1||editions>MAX_EDITIONS)throw Error(`Editions: a whole number from 1 to ${count(MAX_EDITIONS)}.`);
    body={creator:canonical(who.value,info.network),name:name.value.trim(),max:editions};encodeBody(OP.collection,body,info.network);}catch(e){fail(e.message);return;}
   signIt(OP.collection,body,{domain:info.domain},'Create “'+body.name+'”',[el('p',{class:'muted'},`${count(body.max)} editions, minted only by `,addr(body.creator),'. The name and the number of editions cannot be changed later.')],
    id=>done('The collection is made.','#/set/'+id,'Open the collection'),collectionForm);};
  stage.replaceChildren(...[el('h2',{text:'A collection'}),bar(),
   field('Your Monero address',who,mine?'The address of your connected wallet. Only this address can mint into the collection. Change it to sign in another wallet.':'The address that makes the collection. Only this address can mint into it. You sign with it, so it must be in a wallet that has “Sign message”.'),
   field('Name',name,`1 to ${MAX_NAME} plain characters.`),field('Editions',max,`How many NFTs the collection can hold, at most ${count(MAX_EDITIONS)}.`),problem,
   el('div',{class:'row'},el('button',{type:'button',class:'btn primary',text:'Continue','data-action':'next',onclick:next})),
   el('p',{class:'dim','data-fee':'',text:feeLine('collection','Making a collection')})].filter(Boolean));}

 async function nftForm(){
  let content=null,type=null;
  const set=into?await api('/nft-collection/'+into,{signal:ctx.signal}):null;
  const name=textInput({'data-field':'name',maxlength:String(MAX_NAME)}),to=textInput({class:'mono','data-field':'to',placeholder:'Leave empty to keep it yourself'});
  const file=el('input',{type:'file','data-field':'file',accept:'image/png,image/jpeg,image/webp,image/gif,text/plain'}),text=el('textarea',{'data-field':'text',spellcheck:'false',placeholder:'Or write a short text here'});
  const room=el('p',{class:'dim','data-room':''}),preview=el('div',{class:'pic nftpic',hidden:''});let url=null;ctx.onLeave(()=>url&&URL.revokeObjectURL(url));
  // What is left for name and content once the fixed parts of the record are counted.
  const fixed=()=>encodeBody(OP.mint,{collection:set?into:NO_COLLECTION,edition:set?1:0,creator:canonical(who.value,info.network),type:1,content:[0],...(to.value.trim()?{to:to.value.trim()}:{})},info.network).length-1+SIGNATURE;
  const count_=()=>{let base;try{base=fixed();}catch{base=176+(to.value.trim()?65:0);}const used=name.value.trim().length+(content?content.length:0),most=MAX_RECORD-base;
   room.textContent=`${count(used)} of ${count(most)} bytes used (name and content). One Monero transaction holds no more.`;room.dataset.over=String(used>most);return {used,most};};
  const take=(bytes,kind)=>{content=bytes;type=kind;problem.replaceChildren();if(url){URL.revokeObjectURL(url);url=null;}
   if(kind>=1&&kind<=4){url=URL.createObjectURL(new Blob([bytes]));preview.replaceChildren(el('img',{alt:'',src:url}));preview.hidden=false;}else preview.hidden=true;count_();};
  file.addEventListener('change',async()=>{const f=file.files[0];if(!f)return;const bytes=new Uint8Array(await f.arrayBuffer()),kind=sniff(bytes)||(f.type==='text/plain'?5:null);
   if(!kind){fail('Choose a PNG, JPEG, WebP or GIF picture, or a plain text file.');file.value='';return;}text.value='';take(bytes,kind);});
  text.addEventListener('input',()=>{if(text.value){file.value='';take(new TextEncoder().encode(text.value),5);}else{content=null;preview.hidden=true;count_();}});
  for(const i of [name,to,who])i.addEventListener('input',count_);
  const next=()=>{let body,c;
   try{const creator=canonical(who.value,info.network);if(!content)throw Error('Choose a picture or write a text.');
    const {used,most}=count_();if(used>most)throw Error(`This is ${count(used-most)} bytes too large. One Monero transaction holds ${count(most)} bytes of name and content.`);
    if(set){c=decodeRecord(unhex(set.record),info.network);if(c.op!==OP.collection||recordId(info.domain,c.bodyBytes)!==into)throw Error('The service sent a collection that does not fit its code.');
     if(c.body.creator!==creator)throw Error('Only the creator of this collection can mint into it. It was made by another address.');
     const taken=new Set(set.items.map(i=>i.edition));let e=1;while(taken.has(e))e++;if(e>c.body.max)throw Error('Every edition of this collection is minted.');
     body={collection:into,edition:e,creator,name:name.value.trim(),type,content,...(to.value.trim()?{to:canonical(to.value,info.network)}:{})};}
    else body={creator,name:name.value.trim(),type,content,...(to.value.trim()?{to:canonical(to.value,info.network)}:{})};
    const bytes=encodeBody(OP.mint,body,info.network);if(bytes.length+SIGNATURE>MAX_RECORD)throw Error('This is too large for one Monero transaction.');body=decodeRecord(bytes,info.network,{sig:false}).body;}
   catch(e){fail(e.message);return;}
   signIt(OP.mint,body,{domain:info.domain,collectionName:c?.body.name??null},'Mint '+(body.name||'this NFT'),
    [el('p',{class:'muted'},c?`Edition ${count(body.edition)} of “${c.body.name}”. `:'An NFT in no collection. ','Its first owner is ',addr(body.to||body.creator),'. The content cannot be changed later.')],
    id=>done('The NFT is made.','#/nft/'+id,'Open the NFT'),()=>nftForm());};
  stage.replaceChildren(...[el('h2',{text:set?'Mint into “'+set.collection.name+'”':'One NFT'}),bar(),
   set?el('p',{class:'muted',text:`${count(set.items.length)} of ${count(set.collection.max)} editions are minted. The next free edition is used.`}):null,
   field('Your Monero address',who,set?'The address that made the collection. You sign with it.':mine?'The address of your connected wallet: the creator. Change it to sign in another wallet.':'The creator. You sign with it, so it must be in a wallet that has “Sign message”.'),
   field('Picture or text file',file,'PNG, JPEG, WebP, GIF or plain text. It has to be very small: see the count below.'),text,preview,
   field('Name (optional)',name,`Up to ${MAX_NAME} plain characters. It uses the same room as the content.`),
   field('First owner (optional)',to,'Another Monero address that receives the NFT. Uses 65 bytes of the room.'),room,problem,
   el('div',{class:'row'},el('button',{type:'button',class:'btn primary',text:'Continue','data-action':'next',onclick:next})),
   el('p',{class:'dim','data-fee':'',text:feeLine('mint','Minting')+' Anything you inscribe is public for good.'})].filter(Boolean));
  count_();}
 if(make==='collection')collectionForm();else await nftForm();}
