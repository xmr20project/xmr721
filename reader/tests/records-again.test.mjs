// Offline tests of claim records counting again (RULES.md section 12) in the reader and at the relay, with a made-up
// node and made-up keys: node --test reader/tests/records-again.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {hex} from '../../rules/lib/monero.mjs';
import {outputSecret,signWithOutputKey} from '../../rules/lib/claim.mjs';
import {RECORDS_OVERLAP} from '../../rules/lib/burn.mjs';
import {wallet,makeTx,ownerEntry,DOMAIN} from '../../rules/tests/helpers.mjs';
import {openReader,SCHEMA,SCHEMA_BURN,SCHEMA_RECORDS,BURN_MARGIN} from '../lib/reader.mjs';
import {unframe} from '../lib/transport.mjs';
import {createRelay} from '../lib/relay.mjs';
import {fakeChain,fakeCarrier,carried} from './fake.mjs';

const dirs=[];test.after(()=>{for(const d of dirs)rmSync(d,{recursive:true,force:true});});
const FROM=103,END=FROM+RECORDS_OVERLAP,AGAIN=END+20;
const recordOf=t=>hex(unframe(t.tx.extra));
function world(){
 const w=Object.fromEntries(['alice','bob','carol','fee'].map(n=>[n,wallet(n)]));
 const holders=[w.alice,w.alice,w.bob,w.carol];
 const owners=holders.map((h,i)=>({...ownerEntry(i,makeTx('records reader '+i,[{to:h,amount:10n**9n}])),registrationHeight:50+i,ownerHeight:50+i}));
 const dir=mkdtempSync(join(tmpdir(),'mordinals-records-'));dirs.push(dir);
 const chain=fakeChain({start:100}),state=join(dir,'state');
 const open=(o={})=>openReader({dir:state,chain,domain:DOMAIN,feeAddress:w.fee.address,owners,start:100,checkpointEvery:0,burnFrom:FROM,...o});
 const key=(n,h)=>outputSecret({viewSecret:h.viewSecret,spendSecret:h.spendSecret,txPub:owners[n].ownerTxPubKeys[0],subScalar:h.subScalar});
 const claim=(n,h,l,to=h)=>{const p=l.prepareClaim({mordinal:n,to:to.address});return carried(l.claimWithKey(p.bodyBytes,signWithOutputKey(p.keyHash,key(n,h))));};
 return {w,owners,dir,state,chain,open,claim};}

test('a folder takes the setting in ahead of its block, confirms it against the node and keeps it',async()=>{
 const {chain,open,state}=world();let reader=open();
 for(let h=101;h<=END+2;h++)chain.mine();await reader.sync();assert.equal(reader.height,END+2);assert.equal(reader.meta.schema,SCHEMA+SCHEMA_BURN);
 // Too close to what the folder has read, or before the block where claim records stopped: not taken.
 assert.throws(()=>open({recordsFrom:END+2+BURN_MARGIN-1}),/at least 10 blocks above the newest block this folder has read \(825\)/);
 assert.throws(()=>open({recordsFrom:END-1}),/Bad first block of claim records counting again/);
 reader=open({recordsFrom:AGAIN});assert.equal(reader.recordsPending,AGAIN);assert.equal(reader.meta.recordsFrom,undefined);
 // Too close to the node's newest block: refused, and the folder keeps its setting.
 assert.throws(()=>reader.confirmBurn({height:AGAIN-BURN_MARGIN+1}),/claim records counting again has to be at least 10 blocks above the newest block of the Monero node/);
 assert.equal(JSON.parse(readFileSync(join(state,'meta.json'),'utf8')).recordsFrom,undefined);
 reader.confirmBurn(await chain.info());assert.equal(reader.recordsPending,null);assert.equal(reader.meta.recordsFrom,AGAIN);assert.equal(reader.meta.schema,SCHEMA+SCHEMA_BURN+SCHEMA_RECORDS);
 // Opened again with the same setting it is the same ledger; without it, or with another block, it is not.
 assert.equal(open({recordsFrom:AGAIN}).meta.recordsFrom,AGAIN);
 assert.throws(()=>open(),/made for another ledger \((schema|recordsFrom) differs\)/);assert.throws(()=>open({recordsFrom:AGAIN+1}),/made for another ledger \(recordsFrom differs\)/);});

test('claim records count again from the block, in the reader and at the relay; a checkpoint names it',async()=>{
 const {w,owners,chain,open,claim,dir}=world();let reader=open();
 for(let h=101;h<=END;h++)chain.mine();await reader.sync();
 reader=open({recordsFrom:AGAIN,checkpointEvery:1});reader.confirmBurn(await chain.info());
 const relay=createRelay({dir:join(dir,'relay'),reader,chain,carrier:fakeCarrier(chain,{coins:6}),domain:DOMAIN,limits:{resendMs:1000},now:()=>1_000_000});
 // Before the block: refused in a block and not carried by the relay.
 const early=claim(0,w.alice,reader.ledger);chain.mine([early]);await reader.sync();
 assert.deepEqual(reader.journal.map(e=>[e.height,e.ok,e.error??null]),[[END+1,false,`Claim records count again from block ${AGAIN}.`]]);
 await assert.rejects(relay.submit(recordOf(claim(1,w.alice,reader.ledger))),e=>new RegExp(`Claim records count again from block ${AGAIN}`).test(e.message)&&e.rule===true);
 for(let h=END+2;h<=AGAIN-1;h++)chain.mine();await reader.sync();assert.equal(reader.height,AGAIN-1);
 await assert.rejects(relay.submit(recordOf(claim(1,w.alice,reader.ledger))),/Claim records count again/);
 assert.equal(reader.checkpoints.at(-1).recordsFrom,undefined);
 // From the block on the relay carries a claim record, as the ledger takes it.
 chain.mine();await reader.sync();assert.equal(reader.height,AGAIN);
 const c=reader.checkpoints.at(-1);assert.equal(c.height,AGAIN);assert.equal(c.recordsFrom,AGAIN);
 const sent=await relay.submit(recordOf(claim(1,w.alice,reader.ledger,w.bob)));assert.equal(sent.state,'sent');
 chain.mine();await reader.sync();await relay.tick();assert.equal(reader.ledger.mordinal(1).owner,w.bob.address);
 assert.equal(reader.events.at(-1).kind,'claim');assert.equal(reader.events.at(-1).proof,'one-time key');
 // A record carried by someone else into the first block itself counts there.
 const direct=claim(2,w.bob,reader.ledger);chain.mine([direct]);await reader.sync();assert.equal(reader.ledger.mordinal(2).owner,w.bob.address);
 // The same blocks read from the start by a new folder that names the setting give the same state.
 const fresh=openReader({dir:join(dir,'fresh'),chain,domain:DOMAIN,feeAddress:w.fee.address,owners,start:100,checkpointEvery:1,burnFrom:FROM,recordsFrom:AGAIN});await fresh.sync();
 assert.deepEqual(fresh.checkpoints.at(-1),reader.checkpoints.at(-1));assert.equal(fresh.checkpoints.at(-1).recordsFrom,AGAIN);});
