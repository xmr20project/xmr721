// The xmr721 wallet on a local test chain. SIMULATED: own offline fakechain (monerod --regtest), a real wallet2 wallet
// (monero-wallet-rpc) that funds the xmr721 wallet, the real carrier tool, and a real reader service. Throwaway wallets,
// no real funds. Real here: the wallet's keys are the carrier tool's, its records travel in real transactions it builds
// and pays for, and the reader takes them from real blocks. The made-up chain uses mainnet addresses, so the wallet is
// told its ledger (`ledgers: {}`) instead of knowing it.
//   MONERO_BIN=<folder with monerod and monero-wallet-rpc> node --test cli/tests/lab.test.mjs        (about a minute)
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,cp} from 'node:fs/promises';
import {join} from 'node:path';
import {call,startChain,startWallet,stopAll} from '../../rules/tests/lab-harness.mjs';
import {startService} from '../../reader/service.mjs';
import {createChain} from '../../reader/lib/chain.mjs';
import {openWallet,readerAt,imagesOf} from '../lib/wallet.mjs';
import {createTool} from '../lib/tool.mjs';
import {openLock} from '../lib/lock.mjs';
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
  // (The tool runs as the command runs it: apart, and under the wallet folder's lock. `change` alters the node as the
  // wallet reaches it.)
  const wdir=join(dir,'wallet'),made=await tip(),node=createChain(chain.url);
  const open=(folder,change=n=>n)=>{const lock=openLock(folder);return openWallet({dir:folder,carrier:createTool({bin:CARRIER,stateDir:folder,node:chain.url,network:'offline-fakechain',start:made,lock}),lock,reader:readerAt(base),chain:change(node),network:'mainnet',nettype:'fakechain',domain:DOMAIN,ledgers:{}});};
  const wallet=open(wdir),journal=async folder=>JSON.parse(await readFile(join(folder,'journal.json'),'utf8')).entries;
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
  const carried=(await node.txs([forAlice.txid])).get(forAlice.txid);assert.equal(carried.inPool,false);assert.ok(carried.tx.extra.length>content.length);
  // The coin a transaction spends, as the wallet reads it from the transaction it keeps, is the one the node shows; the
  // node shows it spent by a transaction in a block.
  const images=imagesOf((await journal(wdir)).find(e=>e.txid===forAlice.txid).blob);
  assert.deepEqual(images,carried.tx.vin.map(i=>i.key.k_image));assert.equal(images.length,1);assert.deepEqual(await node.spent(images),[1]);
  // Coins are spent now; ten blocks later the change can pay again: an edition of the collection, and a send.
  await mine(10);await pass();
  const edition=await wallet.inscribe({content:Buffer.from('lab set 1'),type:5,collection:set.id}),moved=await wallet.send({nft:own.id,to:alice.address});
  assert.equal(edition.edition,1);await mine(1);await pass();
  assert.deepEqual([L().nft(edition.id)?.minted.edition,L().nft(own.id)?.owner],[1,alice.address]);
  // The same record again, now final on the ledger, is refused before any coin is used.
  await assert.rejects(wallet.inscribe({content:Buffer.from('kept'),type:5}),/on the ledger already/);
  // The node drops a transaction it had taken (its pool is emptied): the wallet still has it, says so, and sends the
  // very same transaction again; it then gets into a block.
  await mine(10);await pass();
  const dropped=await wallet.inscribe({content:Buffer.from('dropped by the node'),type:5});await call(chain.port,'flush_txpool');
  assert.match((await wallet.inscriptions()).at(-1).state,/^the node does not have this transaction: "xmr721 wallet resend" sends it again$/);
  await assert.rejects(wallet.forget(dropped.txid),/A sent transaction cannot be taken back/);
  const back=(await wallet.resend()).find(r=>r.txid===dropped.txid);assert.deepEqual([back.sentAgain,back.failed],[true,undefined]);
  await mine(1);await pass();assert.equal(L().nft(dropped.id)?.owner,address);
  // Two commands at once work one after the other.
  const two=await Promise.all([wallet.balance(),wallet.balance()]);assert.equal(two[0].balance,two[1].balance);
  // Every network fee the wallet paid is what it lacks now.
  const fees=(await wallet.inscriptions()).reduce((a,r)=>a+BigInt(Math.round(Number(r.fee)*1e12)),0n),after=await wallet.balance();
  assert.equal(BigInt(Math.round(Number(after.balance)*1e12)),3n*XMR/10n-fees);assert.equal((await wallet.inscriptions()).length,6);void moved;
  // A transaction the node says no to: the tool has marked its coin as used, and the transaction is kept, unsent. Given
  // up, it is removed; a rescan from the wallet's start block then runs, and the coin is back: the balance is what it was.
  await mine(10);await pass();assert.ok((await wallet.inscriptions()).every(r=>/^on the ledger \(block \d+\)$/.test(r.state)));assert.equal((await wallet.balance()).kept,0);
  const refusing=open(wdir,n=>({...n,send:async()=>({ok:false,reason:'made up'})}));
  await assert.rejects(refusing.inscribe({content:Buffer.from('never sent'),type:5}),/The node said no to the transaction \(made up\), and nothing was sent\. The transaction is kept as entry \d+/);
  const short=await wallet.balance();assert.ok(BigInt(Math.round(Number(short.balance)*1e12))<BigInt(Math.round(Number(after.balance)*1e12)),'the coin of the unsent transaction is marked as used');
  await assert.rejects(wallet.rescan(),/built and not sent/);
  const entry=(await wallet.inscriptions()).at(-1);assert.match(entry.state,/^built and not sent \(the node said no: made up\)/);assert.match((await wallet.forget(entry.n)).forgotten,/It was never sent/);
  const again=await wallet.rescan();assert.deepEqual([again.balance,again.address],[after.balance,address]);
  // A split: several coins from one, kept and tracked like a record, final by the node alone.
  const parts=await wallet.split(2);assert.equal(parts.kind,'split');await mine(10);await pass();
  assert.match((await wallet.inscriptions()).at(-1).state,/^done \(block \d+\)$/);assert.ok((await wallet.balance()).ready>=2);
  // The same coin spent twice. A copy of the wallet folder (the same keys, the same coins) builds a transaction that the
  // node is never heard to take; then the wallet itself spends that very coin in a transaction that gets into a block.
  const copy=join(dir,'wallet-copy');await cp(wdir,copy,{recursive:true,filter:f=>!f.endsWith('/lock')});
  let silent=true;const other=open(copy,n=>({...n,send:async blob=>{if(silent){silent=false;throw Error('no answer');}return n.send(blob);}}));
  await assert.rejects(other.inscribe({content:Buffer.from('from the copy'),type:5}),/counts as sent/);
  const lostOne=(await journal(copy)).at(-1);assert.equal(lostOne.state,'sent');assert.equal((await node.txs([lostOne.txid])).size,0);
  const winner=await wallet.inscribe({content:Buffer.from('from the wallet'),type:5});
  assert.deepEqual(imagesOf((await journal(wdir)).at(-1).blob),imagesOf(lostOne.blob),'both spend the same coin');
  // The copy hands its transaction to the node: the node says no, and why. It stays kept.
  const refusal=(await other.resend()).find(r=>r.txid===lostOne.txid);assert.equal(refusal.sentAgain,false);assert.match(refusal.failed,/^the node said no: double spend\. Its coin is being spent by another transaction/);
  // A transaction the node has already is taken when it is handed over again.
  assert.deepEqual(await node.send((await journal(wdir)).at(-1).blob),{ok:true});
  assert.equal((await journal(copy)).at(-1).state,'sent');await assert.rejects(other.forget(lostOne.txid),/A sent transaction cannot be taken back/);
  // The wallet's transaction gets into a block: the copy sees its coin spent by another transaction, stops sending, and
  // ten blocks later knows that its own can never get in.
  await mine(1);await pass();assert.equal(L().nft(winner.id)?.owner,address);
  assert.match((await other.inscriptions()).at(-1).state,/^the node does not have it, and its coin was spent by another transaction \(seen at block \d+\)/);
  assert.ok((await other.resend()).every(r=>!r.sentAgain&&!r.failed));
  await mine(10);await pass();
  assert.equal((await other.inscriptions()).at(-1).state,'its coin was spent by another transaction, 10 blocks deep: this one cannot get into a block any more, and what it carried is not on the ledger');
  assert.equal(L().nft(lostOne.id),null);await assert.rejects(other.forget(lostOne.txid),/It can leave the list at block \d+/);
  // In a block as well, the wallet's own transaction is taken when handed over once more.
  assert.deepEqual(await node.send((await journal(wdir)).at(-1).blob),{ok:true});
 }finally{await service?.close().catch(()=>{});await stopAll([chain,...Object.values(W)]);await rm(dir,{recursive:true,force:true});}});
