// The xmr721 wallet on a local test chain. SIMULATED: own offline fakechain (monerod --regtest), a real wallet2 wallet
// (monero-wallet-rpc) that funds the xmr721 wallet, the real carrier tool, and a real reader service. Throwaway wallets,
// no real funds. Real here: the wallet's keys are the carrier tool's, its records travel in real transactions it builds
// and pays for, and the reader takes them from real blocks. The made-up chain uses mainnet addresses, so the wallet is
// told its ledger (`ledgers: {}`) instead of knowing it.
//   MONERO_BIN=<folder with monerod and monero-wallet-rpc> node --test cli/tests/lab.test.mjs        (about a minute)
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {call,startChain,startWallet,stopAll} from '../../rules/tests/lab-harness.mjs';
import {startService} from '../../reader/service.mjs';
import {createCarrier} from '../../reader/lib/relay.mjs';
import {createChain} from '../../reader/lib/chain.mjs';
import {openWallet,readerAt} from '../lib/wallet.mjs';
const HERE=import.meta.dirname,CARRIER=join(HERE,'..','..','reader','bin','mordinals-carrier'),DOMAIN='5a'.repeat(32),XMR=10n**12n;

test('a wallet made by the command is funded, inscribes, makes a collection and sends, all in real transactions',{timeout:900000},async()=>{
 const dir=await mkdtemp(join(HERE,'..','..','runs-lab-wallet-'));let chain,W={},service=null;
 try{
  chain=await startChain(dir);for(const n of ['alice','fee'])W[n]=await startWallet(dir,chain.port,n);
  const {alice,fee}=W;
  const mine=async(n=1)=>{await call(chain.port,'generateblocks',{amount_of_blocks:n,wallet_address:fee.address});};
  const tip=async()=>(await call(chain.port,'get_info')).height-1;
  // Enough blocks and a few ordinary payments, so the wallet finds decoys for its transactions.
  await call(chain.port,'generateblocks',{amount_of_blocks:120,wallet_address:alice.address});await mine(230);await alice.rpc('refresh');
  const pay=async destinations=>{for(let i=0;;i++){try{const t=await alice.rpc('transfer',{destinations:destinations.map(d=>({address:d.address,amount:Number(d.amount)})),priority:0});await mine(1);await alice.rpc('refresh');return t.tx_hash;}
   catch(e){if(i>=5)throw e;await mine(1);await alice.rpc('refresh');}}};
  for(let i=0;i<4;i++)await pay([{address:alice.address,amount:10n**9n}]);
  await writeFile(join(dir,'owners.jsonl'),'');
  // A ledger whose minting is the fee wallet's alone until an opening block some way ahead.
  const start=await tip(),openFrom=start+30;
  service=await startService({owners:join(dir,'owners.jsonl'),domain:DOMAIN,feeAddress:fee.address,node:chain.url,start,mintFrom:start+1,minters:[fee.address],openFrom,state:join(dir,'state'),port:0,checkpointEvery:5,testHooks:true,log:()=>{}});
  const base='http://127.0.0.1:'+service.port,L=()=>service.reader.ledger;
  const pass=async()=>{const r=await fetch(base+'/test/step',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(r.status,200);return r.json();};
  // The wallet, as the command makes it: a folder, the carrier tool on it, this reader, this node.
  const wdir=join(dir,'wallet'),made=await tip();
  const wallet=openWallet({dir:wdir,carrier:createCarrier({bin:CARRIER,stateDir:wdir,node:chain.url,network:'offline-fakechain',start:made}),reader:readerAt(base),chain:createChain(chain.url),network:'mainnet',domain:DOMAIN,ledgers:{}});
  const {address}=await wallet.create({height:made});
  assert.equal((await alice.rpc('validate_address',{address})).valid,true,'the address is one a Monero wallet pays to');
  await pay([{address,amount:XMR/10n},{address,amount:XMR/10n},{address,amount:XMR/10n}]);await mine(10);await pass();
  const funded=await wallet.balance();assert.deepEqual([funded.balance,funded.ready,funded.coins],['0.3',3,3]);
  // Closed until the opening block.
  const content=Buffer.from('inscribed on a real chain');
  await assert.rejects(wallet.inscribe({content,type:5}),/Minting opens to everyone at block/);
  while(await tip()<openFrom-1)await mine(1);await pass();
  // An NFT for alice; a collection; and an NFT the wallet keeps.
  const forAlice=await wallet.inscribe({content,type:5,name:'for alice',to:alice.address}),set=await wallet.collection({name:'Lab set',max:2}),own=await wallet.inscribe({content:Buffer.from('kept'),type:5});
  assert.equal((await wallet.inscriptions()).filter(r=>r.state==='waiting for a block').length,3);
  await mine(1);await pass();
  assert.deepEqual([L().nft(forAlice.id)?.owner,L().nft(forAlice.id)?.minted.creator,L().collection(set.id)?.creator,L().nft(own.id)?.owner],[alice.address,address,address,address]);
  assert.ok((await wallet.inscriptions()).every(r=>/^on the ledger/.test(r.state)));
  const node=createChain(chain.url),carried=(await node.txs([forAlice.txid])).get(forAlice.txid);assert.equal(carried.inPool,false);assert.ok(carried.tx.extra.length>content.length);
  // Coins are spent now; ten blocks later the change can pay again: an edition of the collection, and a send.
  await mine(10);await pass();
  const edition=await wallet.inscribe({content:Buffer.from('lab set 1'),type:5,collection:set.id}),moved=await wallet.send({nft:own.id,to:alice.address});
  assert.equal(edition.edition,1);await mine(1);await pass();
  assert.deepEqual([L().nft(edition.id)?.minted.edition,L().nft(own.id)?.owner],[1,alice.address]);
  // The same record again is refused before any coin is used.
  await assert.rejects(wallet.inscribe({content:Buffer.from('kept'),type:5}),/on the ledger already/);
  // Every network fee the wallet paid is what it lacks now.
  const fees=(await wallet.inscriptions()).reduce((a,r)=>a+BigInt(Math.round(Number(r.fee)*1e12)),0n),after=await wallet.balance();
  assert.equal(BigInt(Math.round(Number(after.balance)*1e12)),3n*XMR/10n-fees);assert.equal((await wallet.inscriptions()).length,5);void moved;
 }finally{await service?.close().catch(()=>{});await stopAll([chain,...Object.values(W)]);await rm(dir,{recursive:true,force:true});}});
