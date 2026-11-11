// A made-up Monero node and carrier wallet for the offline tests. Nothing here is a real chain, wallet or transaction.
import {createHash,randomBytes} from 'node:crypto';
import {frame} from '../lib/transport.mjs';
import {unhex} from '../../rules/lib/monero.mjs';
const sha=t=>createHash('sha256').update(t).digest('hex');

// Answers the same questions as lib/chain.mjs. mine() puts every waiting transaction in a new block.
export function fakeChain({start=100,time=1700000000}={}){
 let fork=0,tip=start;const blocks=new Map(),mined=new Map(),pool=new Map();
 const hashOf=h=>sha(`block ${h} fork ${fork}`);
 blocks.set(start,{height:start,hash:hashOf(start),prev:sha('before'),time,txids:[]});
 const c={node:'fake',fail:null,calls:0,
  get tip(){return tip;},
  trip(what){if(c.fail===what){c.fail=null;throw Error('The Monero node answered HTTP 500');}},
  async info(){c.trip('info');return {height:tip,hash:blocks.get(tip).hash,nettype:'fakechain',offline:true};},
  async header(h){c.trip('header');const b=blocks.get(h);if(!b)throw Error('Monero node: no such block');return {height:b.height,hash:b.hash,prev:b.prev,time:b.time};},
  async block(h){c.trip('block');const b=blocks.get(h);if(!b)throw Error('Monero node: no such block');return {...b,txids:b.txids.slice()};},
  async txs(ids){c.calls++;c.trip('txs');const out=new Map();for(const id of ids){const m=mined.get(id),p=pool.get(id);if(m)out.set(id,{txid:id,inPool:false,height:m.height,tx:m.tx});else if(p)out.set(id,{txid:id,inPool:true,height:null,tx:p});}return out;},
  async pool(){return [...pool.keys()];},
  // Test controls.
  publish(t){if(mined.has(t.txid))throw Error('The node refused the transaction (double spend)');pool.set(t.txid,t.tx);},
  mine(extra=[],{only=null}={}){for(const t of extra)pool.set(t.txid,t.tx);
   const take=[...pool.keys()].filter(id=>!only||only.includes(id)),h=++tip;
   for(const id of take){mined.set(id,{height:h,tx:pool.get(id)});pool.delete(id);}
   blocks.set(h,{height:h,hash:hashOf(h),prev:blocks.get(h-1).hash,time:time+(h-start)*120,txids:take});return h;},
  // Replace the newest n blocks: their transactions are gone (or back in the pool with keep).
  pop(n,{keep=false}={}){fork++;for(let i=0;i<n;i++){const b=blocks.get(tip);for(const id of b.txids){if(keep)pool.set(id,mined.get(id).tx);mined.delete(id);}blocks.delete(tip--);}},
  drop(txid){pool.delete(txid);}};
 return c;}

// A carrier wallet with a number of coins; each record or split spends one.
// `subaddress(n)` gives the address of the relay wallet's subaddress n (for fee payments); `paid({index,amount,txid})`
// tells the stand-in about a payment, which it reports once that transaction is in a block.
export function fakeCarrier(chain,{coins=5,subaddress=n=>'relay subaddress '+n}={}){
 let ready=coins,n=0,subs=0;const made=[],payments=[];
 const settled=async()=>{if(!payments.length)return [];const got=await chain.txs(payments.map(p=>p.txid));return payments.filter(p=>got.get(p.txid)&&!got.get(p.txid).inPool).map(p=>({index:p.index,amount:p.amount,txid:p.txid,height:got.get(p.txid).height}));};
 const tx=extra=>{const txid=sha('carrier tx '+n++ +randomBytes(8).toString('hex'));return {txid,blob:Buffer.from(JSON.stringify({txid,extra})).toString('hex'),fee:'30000000',extraBytes:extra.length,bytes:2000+extra.length};};
 return {made,get ready(){return ready;},set ready(v){ready=v;},get subs(){return subs;},subaddress,paid:p=>{payments.push({index:p.index,amount:String(p.amount),txid:p.txid});},
  address:async k=>{k=Number(k);if(!(k>=1))throw Error('address number');subs=Math.max(subs,k);return {address:subaddress(k),index:k};},
  init:async()=>({address:'carrier'}),
  status:async()=>({address:'carrier',tip:chain.tip,balance:String(ready*10_000_000_000),coins:ready,ready,payments:await settled()}),
  carry:async recordHex=>{if(ready<1)throw Error('No coin of this wallet can pay for a transaction now (coins unlock 10 blocks after they arrive)');ready--;
   const t=tx([...frame(unhex(recordHex),randomBytes(32))]);made.push(t.txid);return t;},
  split:async k=>{ready+=k-1;return tx([1,...randomBytes(32)]);},
  publish:async blob=>{const t=JSON.parse(Buffer.from(blob,'hex').toString('utf8'));chain.publish({txid:t.txid,tx:{version:2,extra:t.extra,vout:[]}});return {txid:t.txid};}};}

// A record in a transaction of its own, as anyone could publish it without the relay.
export const carried=(record,label=randomBytes(8).toString('hex'))=>({txid:sha('direct '+label),tx:{version:2,extra:[...frame(record,randomBytes(32))],vout:[]}});
