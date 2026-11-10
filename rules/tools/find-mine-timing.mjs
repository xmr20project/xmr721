// How long "find my Mordinals" takes over the real owner list, with a throwaway key (so nothing is found).
//   node tools/find-mine-timing.mjs [../ownership-index/result/owners.jsonl]
import {readFileSync} from 'node:fs';
import {findMine} from '../lib/claim.mjs';
const file=process.argv[2]||new URL('../../ownership-index/result/owners.jsonl',import.meta.url);
const owners=readFileSync(file,'utf8').trim().split('\n').map(l=>JSON.parse(l));
const viewSecret=crypto.getRandomValues(new Uint8Array(32));viewSecret[31]&=15;
const t=performance.now(),found=findMine(owners,{viewSecret,spends:new Map()}),ms=performance.now()-t;
console.log(JSON.stringify({entries:owners.length,found:found.length,seconds:+(ms/1000).toFixed(1),perEntryMs:+(ms/owners.length).toFixed(2)}));
