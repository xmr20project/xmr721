// Open XMR20 tokens (../OPEN.md, draft): a token anyone announces with one inscription. This file writes the open deploy
// text, reads it back, says which mint records are open deploys and how a signed text names an open token.
// It holds no balances: those are worked out by the token ledger from the same records.
import {NO_COLLECTION,OP,MAX_RECORD,SUFFIX,decodeRecord,encodeBody,attachSignature,renderText,recordId,signerOf} from '../../rules/lib/records.mjs';
import {verifySpendSignature} from '../../rules/lib/monero.mjs';
import {readable,TYPE_JSON,MAX_TEXT} from './token.mjs';

// The fields, in the order they are written. `name`, `col`, `lim` and `pre` may be left out.
export const OPEN_FIELDS=['p','op','tick','name','max','dec','mode','col','lim','pre'];
// One token is 1,000,000 units, and a record counts units in 8 bytes: the largest supply in whole tokens.
export const UNIT=1000000n,MAX_WHOLE=((1n<<64n)-1n)/UNIT;
// Hex characters of the token id a signed text shows, and what the ticker field of a move or a listing can hold.
export const ID_SHOWN=16,FIELD_TICKER=/^[A-Za-z0-9]{1,12}$/;

const whole=v=>typeof v==='string'&&/^[1-9][0-9]{0,13}$/.test(v)&&BigInt(v)<=MAX_WHOLE?BigInt(v):null;

// The fields of an open deploy, checked. Throws with the reason; returns them in written order with nothing else.
export function checkOpenDeploy(o){
 if(!o||typeof o!=='object'||Array.isArray(o))throw Error('A deploy is a JSON object.');
 for(const k of Object.keys(o))if(!OPEN_FIELDS.includes(k))throw Error(`Unknown field "${k}".`);
 if(o.p!=='xmr20'||o.op!=='deploy')throw Error('Not an XMR20 deploy.');
 if(o.mode!=='open')throw Error('mode: "open".');
 if(o.dec!=='6')throw Error('dec: "6".');
 if(!readable(o.tick,32))throw Error('tick: 1 to 32 characters.');
 if(o.name!==undefined&&!readable(o.name,64))throw Error('name: 1 to 64 characters.');
 const max=whole(o.max);if(max===null)throw Error(`max: a whole number of tokens from 1 to ${MAX_WHOLE}, written as text.`);
 if(o.col!==undefined&&!(typeof o.col==='string'&&/^[0-9a-f]{64}$/.test(o.col)))throw Error('col: the id of an XMR721 collection.');
 let pre=0n;if(o.pre!==undefined){pre=whole(o.pre);if(pre===null||pre>max)throw Error('pre: 1 to max, written as text; left out when the creator takes nothing.');}
 if(o.lim!==undefined){const lim=whole(o.lim);if(lim===null||lim>max)throw Error('lim: 1 to max, written as text.');if(pre===max)throw Error('lim is left out when nothing is left to mint.');}
 else if(pre<max)throw Error('lim is required while something is left to mint.');
 return Object.fromEntries(OPEN_FIELDS.filter(k=>o[k]!==undefined).map(k=>[k,o[k]]));}

// The inscribed text of an open deploy: its fields in written order, no spaces. One deploy has exactly one text.
export function openDeployText(fields){
 const text=JSON.stringify(checkOpenDeploy({p:'xmr20',op:'deploy',dec:'6',mode:'open',...fields}));
 if(new TextEncoder().encode(text).length>MAX_TEXT)throw Error(`A deploy is at most ${MAX_TEXT} bytes.`);
 return text;}

// The open deploy written in these bytes, or null. Only the exact text openDeployText() writes is read.
export function readOpenDeploy(bytes){
 if(!bytes||!bytes.length||bytes.length>MAX_TEXT)return null;
 try{const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes),d=checkOpenDeploy(JSON.parse(text));return JSON.stringify(d)===text?d:null;}catch{return null;}}

// Whether a decoded mint record (decodeRecord) is an open deploy by its bytes: in no collection, no first owner written,
// no origin, no name of its own, JSON, and the content an open deploy text. Returns the deploy's fields or null.
// Its signature and its block (at or after the opening block) are the caller's to check.
export function openDeployOf(d){
 if(!d||d.op!==OP.mint)return null;const b=d.body;
 if(b.collection!==NO_COLLECTION||b.edition!==0||b.to||b.origin||b.name!==''||b.type!==TYPE_JSON)return null;
 return readOpenDeploy(b.content);}

// The whole rule for one record, apart from its block: the bytes of an MD1 record (as the carrier field gives them) are an
// open deploy when they decode as a mint record of at most 1,000 bytes, have the open deploy's shape and text, and carry
// the creator's signature over the mint text with the ending the record names. Returns {id, creator, fields, decoded} or
// null. Every reader goes through this one function, so none puts the checks together another way.
export function openDeployIn(bytes,{domain,network='mainnet'}){
 if(!bytes||bytes.length>MAX_RECORD)return null;
 let d;try{d=decodeRecord(bytes,network);}catch{return null;}
 const fields=openDeployOf(d);if(!fields)return null;
 const text=renderText(d.op,d.body,d.bodyBytes,{domain,collectionName:null})+SUFFIX[d.proof.variant];
 if(!verifySpendSignature(text,signerOf(d.op,d.body),{c:d.proof.c,r:d.proof.r},network))return null;
 return {id:recordId(domain,d.bodyBytes),creator:d.body.creator,fields,decoded:d};}

// A deploy for a wallet that signs messages (Feather, Cake Wallet, the Monero CLI): the record without its signature,
// and the one line of text the creator signs with the address that deploys. -> {body, text, id, label, fields}
export function prepareOpenDeploy({creator,fields,domain,network='mainnet'}){
 const content=new TextEncoder().encode(openDeployText(fields)),body=encodeBody(OP.mint,{collection:NO_COLLECTION,edition:0,creator,name:'',type:TYPE_JSON,content},network);
 const d=decodeRecord(body,network,{sig:false}),id=recordId(domain,body);
 return {body,text:renderText(OP.mint,d.body,body,{domain,collectionName:null}),id,label:tokenLabel(readOpenDeploy(content).tick,id),fields:readOpenDeploy(content)};}
// The signed deploy record: the body prepareOpenDeploy gave, with the signature the wallet made over its text. Only a
// body that is an open deploy is taken, so nothing else is signed into a record here.
export function finishOpenDeploy({body,signature,domain,network='mainnet'}){
 if(!openDeployOf(decodeRecord(body,network,{sig:false})))throw Error('This is not an open deploy.');
 const record=attachSignature(body,signature,{domain,collectionName:null},network);
 if(!openDeployIn(record,{domain,network}))throw Error('This is not a signed open deploy.');return record;}

// What the ticker field of a move or a listing holds for an open token, and how a signed text names the token.
export const tickerField=tick=>FIELD_TICKER.test(tick)?tick:'TOKEN';
export const tokenLabel=(tick,id)=>`${tickerField(tick)} (token ${id.slice(0,ID_SHOWN)})`;

// The open tokens among the mint records carried from the opening block on.
//   records: every MD1 mint record with a valid signature in a block at or after the opening block, in chain order,
//            each {id, decoded (decodeRecord's result), height, txid}. A record the XMR721 ledger passes over because
//            its id is on the ledger already (the same text inscribed before the opening block) is in the list too.
// The first record of an id is the token's deploy; later ones change nothing. A signed text shows the first 16 hex
// characters of the id, so a deploy whose id starts like an earlier token's is refused.
// The token ledger refuses one more deploy, which this list cannot see: one whose asset already has supply there (a
// credit the issuer got in first, OPEN.md section 8). This list shows that deploy and keeps its 16 characters, so a later
// deploy that starts the same way is refused here and a token there. A reader that serves balances takes the list from
// the token ledger.
export function projectOpen(records){
 const shown=new Set(),out=[];
 for(const r of records){const d=openDeployOf(r.decoded);if(!d||shown.has(r.id.slice(0,ID_SHOWN)))continue;shown.add(r.id.slice(0,ID_SHOWN));
  const {p,op,...fields}=d;out.push({kind:'open',id:r.id,...fields,creator:r.decoded.body.creator,height:r.height,txid:r.txid,label:tokenLabel(d.tick,r.id)});}
 return out;}
