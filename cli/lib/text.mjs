// Text made safe to print.
//
// clean: text that came from somewhere else (a reader, a node, the carrier tool). Printable ASCII only, and not endless:
// nothing in it can steer a terminal, hide, or turn the direction of what is read.
export const clean=(v,max=200)=>{let s;try{s=typeof v==='string'?v:v==null?'':typeof v==='object'?JSON.stringify(v):String(v);}catch{s='';}return String(s??'').replace(/[^ -~]/g,' ').slice(0,max);};

// plain: this program's own messages, which may name a path the user typed. Every character stays but the ones that
// steer a terminal or cannot be seen; line breaks stay. (The ranges are built from numbers, so that this source holds
// none of those characters.)
const RANGES=[[0,9],[11,31],[127,159],[0xad,0xad],[0x34f,0x34f],[0x61c,0x61c],[0x115f,0x1160],[0x17b4,0x17b5],[0x180b,0x180f],[0x200b,0x200f],[0x2028,0x202f],[0x205f,0x206f],[0x3164,0x3164],[0xfe00,0xfe0f],[0xfeff,0xfeff],[0xffa0,0xffa0],[0xfff0,0xfffb],[0xe0000,0xe0fff]];
const UNSEEN=new RegExp('['+RANGES.map(([a,b])=>String.fromCodePoint(a)+'-'+String.fromCodePoint(b)).join('')+']','gu');
export const plain=(v,max=4000)=>String(v??'').replace(UNSEEN,' ').slice(0,max);

// ascii: JSON text with every character beyond printable ASCII written as its escape. It reads back as the same JSON.
const BACKSLASH=String.fromCharCode(92);
export const ascii=json=>String(json).replace(/[^ -~\n]/g,c=>BACKSLASH+'u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
