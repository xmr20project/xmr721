// The mint record that inscribes an XMR20 deploy (../FORMAT.md), made and signed with an inscriber's own key.
import {ed25519} from '@noble/curves/ed25519';
import {OP,NO_COLLECTION,encodeBody,decodeRecord,recordId,codeOf,renderText,attachSignature} from '../../rules/lib/records.mjs';
import {Hs,le,leBytes,hex,unhex,encodeAddress,signWithSpendKey} from '../../rules/lib/monero.mjs';
import {deployText,TYPE_JSON} from './token.mjs';

const G=ed25519.ExtendedPoint.BASE,L=ed25519.CURVE.n;

// A new secret spend key (64 hex). It signs inscriptions and nothing else; no coin is ever sent to its address.
export function newSecret(random=n=>crypto.getRandomValues(new Uint8Array(n))){
 for(;;){const b=le(random(32))%L;if(b)return hex(leBytes(b));}}

// The inscriber of a secret spend key: its address and its signature. The view key is the one wallets derive from the
// spend key, so the address is the same as a Monero wallet restored from this key would show.
export function inscriberFrom(secret,network='mainnet'){
 if(typeof secret!=='string'||!/^[0-9a-f]{64}$/.test(secret))throw Error('An inscriber key is 64 hex characters.');
 const b=le(unhex(secret));if(!b||b>=L)throw Error('This is not a Monero spend key.');
 const key=leBytes(b),spend=G.multiply(b).toRawBytes(),view=G.multiply(Hs(key)).toRawBytes();
 return {address:encodeAddress({spend,view,kind:'main',network}),sign:text=>signWithSpendKey(text,{spend,view},key)};}

// A mint record takes a name of printable ASCII; a ticker in another script is carried by the text alone.
const recordName=tick=>/^[\x21-\x7e]([\x20-\x7e]{0,62}[\x21-\x7e])?$/.test(tick)?tick:'';

// The signed mint record of a deploy: an NFT in no collection, owned by the inscriber, whose content is the deploy text.
// The same fields by the same inscriber on the same ledger always give the same record id, whenever it is made.
export function deployRecord({fields,inscriber,domain,network='mainnet'}){
 const content=new TextEncoder().encode(deployText(fields));
 const bodyBytes=encodeBody(OP.mint,{collection:NO_COLLECTION,edition:0,creator:inscriber.address,name:recordName(fields.tick),type:TYPE_JSON,content},network);
 const id=recordId(domain,bodyBytes),ctx={domain,collectionName:null},d=decodeRecord(bodyBytes,network,{sig:false});
 const text=renderText(d.op,d.body,bodyBytes,ctx);
 return {id,code:codeOf(id),text,record:hex(attachSignature(bodyBytes,inscriber.sign(text),ctx,network))};}
