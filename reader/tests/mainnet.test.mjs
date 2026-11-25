// The mainnet ledger's values (rules/lib/mainnet.mjs) against the owner list this repository ships, the rule document
// and the launch settings, and the reader's --ledger mainnet option: node --test reader/tests/mainnet.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MAINNET,mainnetOptions} from '../../rules/lib/mainnet.mjs';
import {readOwners,ownersHash,ownerOutputsHash} from '../lib/owners.mjs';
import {openReader} from '../lib/reader.mjs';
import {RECORDS_OVERLAP} from '../../rules/lib/burn.mjs';

const ROOT=join(import.meta.dirname,'../..'),text=f=>readFileSync(join(ROOT,f),'utf8');
const grouped=n=>String(n).replace(/\B(?=(\d{3})+$)/g,',');

test('the shipped owner list is the one the mainnet ledger names',()=>{
 const o=mainnetOptions(ROOT),owners=readOwners(o.owners);
 assert.equal(owners.length,MAINNET.ownersCount);
 assert.equal(ownersHash(owners),MAINNET.ownersHash);
 assert.equal(ownerOutputsHash(owners),MAINNET.ownerOutputsHash);
 assert.equal(createHash('sha256').update('XMR721 mainnet ledger 1').digest('hex'),MAINNET.domain);});

test('the values cannot be changed by code that imports them',()=>{
 assert.throws(()=>{MAINNET.start=1;},TypeError);assert.throws(()=>{MAINNET.minters.push('x');},TypeError);
 const o=mainnetOptions(ROOT);o.minters.push('x');assert.equal(MAINNET.minters.length,2);});

test('RULES.md section 13 and the launch settings state the same values',()=>{
 const rules=text('RULES.md'),at=rules.indexOf('## 13. The mainnet ledger'),section=rules.slice(at,rules.indexOf('## 14.',at)),launch=text('docs/LAUNCH-SETTINGS.md');
 assert.ok(at>0);assert.ok(section.includes('version '+MAINNET.version));
 for(const page of [section,launch]){
  for(const v of [MAINNET.domain,MAINNET.feeAddress,MAINNET.ownersHash,MAINNET.startHash,...MAINNET.minters])assert.ok(page.includes(v),v);
  for(const n of [MAINNET.start,MAINNET.mintFrom,MAINNET.openFrom,MAINNET.burnFrom,MAINNET.spendFrom,MAINNET.burnFrom+RECORDS_OVERLAP-1])assert.ok(page.includes(grouped(n)),String(n));}
 assert.ok(section.includes(MAINNET.ownerOutputsHash));assert.ok(section.includes(grouped(MAINNET.ownersCount)));
 assert.ok(launch.includes(grouped(MAINNET.xmr20OpenFrom)));});

test('a reader opened with the mainnet options is a reader of that ledger, and of no other',()=>{
 const dir=mkdtempSync(join(tmpdir(),'xmr721-mainnet-'));
 try{const o=mainnetOptions(ROOT),owners=readOwners(o.owners),open=more=>openReader({dir,chain:null,network:o.network,domain:o.domain,feeAddress:o.feeAddress,owners,start:o.start,startHash:o.startHash,mintFrom:o.mintFrom,minters:o.minters,openFrom:o.openFrom,burnFrom:o.burnFrom,spendFrom:o.spendFrom,...more});
  const m=open().meta;
  assert.equal(m.schema,'mordinals-reader-v3-open-burn-fee-spend');
  assert.deepEqual([m.owners,m.ownerOutputs,m.start,m.startHash,m.mintFrom,m.openFrom,m.burnFrom,m.spendFrom],[MAINNET.ownersHash,MAINNET.ownerOutputsHash,MAINNET.start,MAINNET.startHash,MAINNET.mintFrom,MAINNET.openFrom,MAINNET.burnFrom,MAINNET.spendFrom]);
  // The same folder refuses a start that leaves a setting out, as the long command line once could.
  assert.throws(()=>open({spendFrom:null}),/another ledger/);assert.throws(()=>open({openFrom:null}),/another ledger/);
 }finally{rmSync(dir,{recursive:true,force:true});}});

test('--ledger mainnet takes no setting beside it and knows no other name',()=>{
 const run=(...args)=>spawnSync(process.execPath,[join(ROOT,'reader/service.mjs'),...args],{encoding:'utf8',timeout:30000});
 let r=run('--ledger','mainnet','--node','http://127.0.0.1:1','--state','unused','--start','3804030');
 assert.equal(r.status,2);assert.match(r.stderr,/--start is part of --ledger mainnet/);
 r=run('--ledger','mainnet','--node','http://127.0.0.1:1','--state','unused','--open-from','3806221');
 assert.equal(r.status,2);assert.match(r.stderr,/--open-from is part of --ledger mainnet/);
 r=run('--ledger','stagenet','--node','http://127.0.0.1:1','--state','unused');
 assert.equal(r.status,2);assert.match(r.stderr,/only ledger/);
 r=run('--ledger','mainnet','--state','unused');
 assert.equal(r.status,2);assert.match(r.stderr,/Missing --node/);});
