// Writes the test cases other implementations of the open token rules replay (../tests/open-fixtures.json): mint records
// made and signed with this repository's own rule library, each with what a reader has to make of it.
// Throwaway keys; nothing here is a real wallet. The signatures use fixed nonces, so the file comes out the same each time.
//   node xmr20-tokens/tools/open-fixtures.mjs > xmr20-tokens/tests/open-fixtures.json
import {sha256} from '@noble/hashes/sha256';
import {wallet,DOMAIN} from '../../rules/tests/helpers.mjs';
import {encodeBody,decodeRecord,renderText,attachSignature,recordId,OP,NO_COLLECTION} from '../../rules/lib/records.mjs';
import {signWithSpendKey,hex,concat} from '../../rules/lib/monero.mjs';
import {openDeployText,openDeployOf,tokenLabel,tickerField} from '../lib/open.mjs';
import {deployText} from '../lib/token.mjs';

const enc=t=>new TextEncoder().encode(t);
const alice=wallet('open alice'),bob=wallet('open bob'),sub=alice.sub(3);
const ctx={domain:DOMAIN,collectionName:null};
let n=0;
// A signature with a nonce that depends only on the case, so the file is the same on every run.
const sign=(who,text)=>{const seed=sha256(enc('open fixture '+(n++)));return signWithSpendKey(text,{spend:who.spend,view:who.view},who.kind==='sub'?subKey(who):who.spendSecret,()=>concat(seed,seed));};
const subKey=w=>{const L=2n**252n+27742317777372353535851937790883648493n,le=b=>b.reduceRight((a,x)=>a*256n+BigInt(x),0n);
 let v=(le(w.spendSecret)+w.subScalar)%L;const out=new Uint8Array(32);for(let i=0;i<32;i++){out[i]=Number(v&255n);v>>=8n;}return out;};
function record(who,content,{name='',to,origin,type=6,ending='',tamper}={}){
 const body=encodeBody(OP.mint,{collection:NO_COLLECTION,edition:0,creator:who.address,to,name,type,content:typeof content==='string'?enc(content):content,origin});
 const d=decodeRecord(body,'mainnet',{sig:false}),text=renderText(OP.mint,d.body,body,ctx);
 let bytes=attachSignature(body,sign(who,text+ending),ctx);
 if(tamper)bytes=tamper(bytes);
 return {bytes,text,id:recordId(DOMAIN,body)};}
const cases=[];
function add(name,who,content,expect,opts){
 const r=record(who,content,opts);let decoded=null;try{decoded=decodeRecord(r.bytes);}catch{}
 const fields=decoded&&openDeployOf(decoded);
 if(Boolean(fields)!==(expect==='deploy')&&!opts?.tamper)throw Error(`${name}: the library reads this ${fields?'as':'not as'} an open deploy`);
 cases.push({name,expect,record:hex(r.bytes),id:r.id,creator:who.address,signedText:r.text,variant:r.bytes[r.bytes.length-65],
  ...(expect==='deploy'?{content:new TextDecoder().decode(decoded.body.content),tick:fields.tick,max:fields.max,lim:fields.lim??null,pre:fields.pre??null,tickerField:tickerField(fields.tick),label:tokenLabel(fields.tick,r.id)}:{})});}

add('mint only',alice,openDeployText({tick:'PEPE',max:'21000000',lim:'1000'}),'deploy');
add('name, creator share and mint; a subaddress signs; text ended with a line feed',sub,openDeployText({tick:'PEPE',name:'Pepe the second',max:'21000000',lim:'1000',pre:'1000000'}),'deploy',{ending:'\n'});
add('all to the creator; a ticker in another script; text ended with CR LF',bob,openDeployText({tick:'ペペ',max:'1000000000',pre:'1000000000'}),'deploy',{ending:'\r\n'});
add('the largest supply, a collection, a long ticker',bob,openDeployText({tick:'A-very-long-ticker_with.signs!',max:'18446744073709',col:'ab'.repeat(32),lim:'18446744073709'}),'deploy');
add('a ticker with a quote and a backslash',alice,openDeployText({tick:'a"b\\c',max:'5',lim:'1'}),'deploy');

const plain='{"p":"xmr20","op":"deploy","tick":"PEPE","max":"21000000","dec":"6","mode":"open","lim":"1000"}';
add('the NFT has a name of its own',alice,plain,'not',{name:'PEPE'});
add('the first owner is someone else',alice,plain,'not',{to:bob.address});
add('an origin is written',alice,plain,'not',{origin:{kind:1,ref:'00'.repeat(36)}});
add('the content is plain text, not JSON',alice,plain,'not',{type:5});
add('a space in the text',alice,plain.replace('"tick":','"tick": '),'not');
add('fields in another order',alice,'{"op":"deploy","p":"xmr20","tick":"PEPE","max":"21000000","dec":"6","mode":"open","lim":"1000"}','not');
add('a field twice',alice,plain.replace('"lim":"1000"','"lim":"1","lim":"1000"'),'not');
add('a field nobody knows',alice,plain.replace('}',',"x":"1"}'),'not');
add('a Solana mint',alice,plain.replace('"lim"','"mint":"So11111111111111111111111111111111111111112","lim"'),'not');
add('a launchpad deploy text',alice,deployText({tick:'TEST2',max:'1000000000',dec:'6',mode:'monero-curve',mint:'BGqUfSkAitpr6jErdEswXwYSXrf21gfCaBNh1h45HMBL'}),'not');
add('eight decimals',alice,plain.replace('"dec":"6"','"dec":"8"'),'not');
add('no lim while something is left',alice,plain.replace(',"lim":"1000"',''),'not');
add('lim above max',alice,plain.replace('"lim":"1000"','"lim":"21000001"'),'not');
add('lim when nothing is left',alice,plain.replace('}',',"pre":"21000000"}'),'not');
add('pre of nothing',alice,plain.replace('}',',"pre":"0"}'),'not');
add('pre above max',alice,plain.replace('}',',"pre":"21000001"}'),'not');
add('max above what 8 bytes hold',alice,plain.replace('"max":"21000000"','"max":"18446744073710"'),'not');
add('max with a leading zero',alice,plain.replace('"max":"21000000"','"max":"021000000"'),'not');
add('max as a number',alice,plain.replace('"max":"21000000"','"max":21000000'),'not');
add('a hidden character in the ticker',alice,plain.replace('PEPE','PE​PE'),'not');
add('a space at the end of the ticker',alice,plain.replace('PEPE','PEPE '),'not');
add('a signature that does not hold',alice,openDeployText({tick:'FAKE',max:'10',lim:'1'}),'not',{tamper:b=>{const c=b.slice();c[c.length-1]^=1;return c;}});
add('signed by another address',alice,openDeployText({tick:'FAKE2',max:'10',lim:'1'}),'not',{tamper:b=>{const other=record(bob,openDeployText({tick:'FAKE2',max:'10',lim:'1'})).bytes;const c=b.slice();c.set(other.slice(-64),c.length-64);return c;}});

console.log(JSON.stringify({domain:DOMAIN,network:'mainnet',cases},null,1));
