// The few questions the reader asks a Monero node. Any node answers them, restricted public nodes included.
// The node is trusted for what is in each block; run the reader against your own node to remove that trust.
const HEX32=/^[0-9a-f]{64}$/;
export function createChain(node,{fetch:f=fetch,timeout=30000}={}){
 const base=String(node).replace(/\/$/,'');
 const post=async(path,body)=>{const r=await f(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(timeout)});
  if(!r.ok)throw Error('The Monero node answered HTTP '+r.status);return r.json();};
 const rpc=async(method,params={})=>{const v=await post('/json_rpc',{jsonrpc:'2.0',id:'0',method,params});if(v.error)throw Error('Monero node: '+v.error.message);return v.result;};
 const header=h=>({height:h.height,hash:h.hash,prev:h.prev_hash,time:h.timestamp});
 return {node:base,
  // The newest block.
  async info(){const i=await rpc('get_info');return {height:i.height-1,hash:i.top_block_hash,nettype:i.nettype,offline:Boolean(i.offline)};},
  async header(height){return header((await rpc('get_block_header_by_height',{height})).block_header);},
  // A block's ordinary transactions in block order, and apart from them the block's mining reward transaction.
  async block(height){const r=await rpc('get_block',{height}),b=header(r.block_header);if(b.height!==height)throw Error('The Monero node returned another block');
   const txids=r.tx_hashes||[],minerTx=r.miner_tx_hash||null;if(txids.some(t=>!HEX32.test(t))||(minerTx!=null&&!HEX32.test(minerTx)))throw Error('The Monero node returned a malformed block');return {...b,txids,minerTx};},
  // Transactions by id -> Map(txid -> {txid, inPool, height, tx}). Unknown ids are simply absent.
  async txs(ids){const out=new Map();
   for(let i=0;i<ids.length;i+=100){const part=ids.slice(i,i+100),v=await post('/get_transactions',{txs_hashes:part,decode_as_json:true,prune:true});
    if(v.status!=='OK')throw Error('The Monero node could not look up transactions: '+String(v.status).slice(0,80));
    for(const t of v.txs||[]){if(!part.includes(t.tx_hash))throw Error('The Monero node returned a transaction that was not asked for');
     out.set(t.tx_hash,{txid:t.tx_hash,inPool:Boolean(t.in_pool),height:t.in_pool?null:t.block_height,tx:JSON.parse(t.as_json)});}}
   return out;},
  // What the node asks for a transaction that is in no hurry: atomic units for each byte, and the step fees are rounded up to.
  async feeRate(){const r=await rpc('get_fee_estimate',{grace_blocks:10}),perByte=BigInt(r.fees?.[0]??r.fee),mask=BigInt(r.quantization_mask||1);
   if(perByte<=0n||mask<=0n)throw Error('The Monero node gave no fee rate');return {perByte,mask};},
  // For each key image, whether it is spent: 0 no, 1 by a transaction in a block, 2 by a transaction that waits for one.
  async spent(images){if(!images.length)return [];const v=await post('/is_key_image_spent',{key_images:images});
   if(v.status!=='OK'||!Array.isArray(v.spent_status)||v.spent_status.length!==images.length||v.spent_status.some(x=>![0,1,2].includes(x)))throw Error('The Monero node could not say whether coins are spent');return v.spent_status;},
  // Hands a transaction to the node. -> {ok: true} when the node took it (or has it already); {ok: false, reason} when
  // the node answers and does not take it. Throws when no answer comes that says which: then it is not known whether
  // the node took it.
  async send(blob,{timeout:limit=120000}={}){
   const r=await f(base+'/send_raw_transaction',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({tx_as_hex:blob,do_not_relay:false}),signal:AbortSignal.timeout(limit),redirect:'manual'});
   // An answer that turns the request itself away took nothing; an error further on may hide a node that did.
   if(r.status>=300&&r.status<500)return {ok:false,reason:'the node answered HTTP '+r.status};
   if(!r.ok)throw Error('The Monero node answered HTTP '+r.status);
   const v=await r.json();if(!v||typeof v.status!=='string')throw Error('The Monero node gave no answer this program understands');
   if(v.status==='OK')return {ok:true};
   const said=typeof v.reason==='string'?v.reason:'',flags=['double_spend','fee_too_low','invalid_input','invalid_output','low_mixin','overspend','too_big','too_few_outputs','sanity_check_failed','tx_extra_too_big','nonzero_unlock_time'].filter(k=>v[k]===true).map(k=>k.replaceAll('_',' '));
   return {ok:false,reason:([said,...flags.filter(x=>!said.toLowerCase().includes(x))].filter(Boolean).join(', ')||v.status).slice(0,200)};},
  // Ids of the transactions waiting to be mined.
  async pool(){const v=await post('/get_transaction_pool_hashes',{});if(v.status!=='OK')throw Error('The Monero node could not list waiting transactions');return v.tx_hashes||[];}};}
