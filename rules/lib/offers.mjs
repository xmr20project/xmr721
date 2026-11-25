// Offers (RULES.md section 13): the list of a set of Mordinals as a hash tree, so that an offer can name a whole set by
// 32 bytes and an accept can show that its Mordinal is on the list.
//   leaf  = SHA-256(0x00 ‖ registration32)
//   node  = SHA-256(0x01 ‖ the smaller of its two children ‖ the larger), compared as bytes
//   A level with an odd number of nodes hands its last node up unchanged. The leaves are the list's registrations,
//   each once, in ascending order. The root of a list of one is its leaf.
// A path is the sibling at each level from the leaf up; a level where the node had no sibling adds nothing.
import {sha256} from '@noble/hashes/sha256';
import {hex,unhex,concat} from './monero.mjs';
export const MAX_PATH=20;
const HEX32=/^[0-9a-f]{64}$/;
const leaf=reg=>sha256(concat(Uint8Array.of(0),unhex(reg)));
const less=(a,b)=>{for(let i=0;i<32;i++)if(a[i]!==b[i])return a[i]<b[i];return false;};
const node=(a,b)=>less(b,a)?sha256(concat(Uint8Array.of(1),b,a)):sha256(concat(Uint8Array.of(1),a,b));
function levels(regs){
 if(!Array.isArray(regs)||!regs.length||regs.some(r=>!HEX32.test(r||'')))throw Error('A set is a list of registration transactions');
 const sorted=[...new Set(regs)].sort();if(sorted.length!==regs.length)throw Error('A set names each Mordinal once');
 if(sorted.length>2**MAX_PATH)throw Error('This set is too large');
 const out=[sorted.map(leaf)];
 while(out.at(-1).length>1){const l=out.at(-1),next=[];for(let i=0;i<l.length;i+=2)next.push(i+1<l.length?node(l[i],l[i+1]):l[i]);out.push(next);}
 return {sorted,levels:out};}
// The root of a set, as hex.
export const setRoot=regs=>hex(levels(regs).levels.at(-1)[0]);
// The path of one registration of a set: hex strings, the leaf's sibling first.
export function setPath(regs,reg){
 const {sorted,levels:L}=levels(regs);let i=sorted.indexOf(reg);if(i<0)throw Error('This Mordinal is not in the set');
 const path=[];for(let d=0;d<L.length-1;d++){const sib=i^1;if(sib<L[d].length)path.push(hex(L[d][sib]));i>>=1;}
 return path;}
// Whether `reg` with this path leads to `root`.
export function inSet(reg,path,root){
 if(!HEX32.test(reg||'')||!HEX32.test(root||'')||!Array.isArray(path)||path.length>MAX_PATH||path.some(p=>!HEX32.test(p||'')))return false;
 let h=leaf(reg);for(const p of path)h=node(h,unhex(p));return hex(h)===root;}
