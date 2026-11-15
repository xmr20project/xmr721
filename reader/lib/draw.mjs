// SVG drawings. Some Mordinals are an SVG document inscribed as text: made to look like the picture it draws, not like
// its source. The service draws such a document itself, as a PNG picture of at most DRAW_SIZE pixels a side, and never
// serves the SVG: a page only ever receives picture bytes. It is drawn on white, the page a browser shows an SVG file
// on: a document that draws dark lines on nothing would not show on a dark page.
//
// Fences, one behind the other:
//  - svgSource below lets through only a document that names nothing outside itself, not even data inside an address;
//  - the drawing library (librsvg in sharp's libvips) is given the bytes alone, with no file or address to resolve
//    other names against: it then loads no file and no address (reader/tests/draw.test.mjs checks that on the machine it
//    runs on), but it would decode a data address, which is why svgSource keeps those out;
//  - every drawing runs in a child process of its own, one at a time, on one thread, with only the SVG loader allowed;
//    it is stopped after `timeout` milliseconds or when it holds more than MEMORY_MAX bytes (the child watches itself
//    every 2 ms, as a filter can take much memory in very little time), and its picture is bounded in pixels and bytes.
// Every check here takes time in proportion to the document's size at most: the service runs svgSource itself.
import {spawn} from 'node:child_process';
import {writeFileSync,writeSync} from 'node:fs';

export const SVG_MAX=1048576,DRAW_SIZE=1024,PNG_MAX=8388608,MEMORY_MAX=268435456;

// The SVG document as text, or null. A document is drawn when it is UTF-8 of at most SVG_MAX bytes that begins with its
// svg element (before it only white space, the XML declaration, comments and the standard SVG document type, which
// defines nothing), uses no reference but XML's five and characters, and when no form of it, as written or as the
// parser reads it (references replaced, comments and CDATA marks left out), holds:
//  - a comment that does not end, another declaration (an entity, a document type of its own) or a processing
//    instruction (a style sheet);
//  - a backslash (a CSS escape can spell anything), XInclude, xml:base, a CSS import, a data address (also with tabs or
//    line breaks in "data", which an address parser drops);
//  - an href (any attribute whose name ends so, each one on its own) or a url() that does not point at an id in the
//    document ('#…').
const DECL=/^<\?xml\s+version\s*=\s*(["'])1\.\d\1(?:\s+encoding\s*=\s*(["'])utf-8\2)?(?:\s+standalone\s*=\s*(["'])(?:yes|no)\3)?\s*\?>/i;
const DOCTYPE=/^<!DOCTYPE\s+svg\s+PUBLIC\s+"-\/\/W3C\/\/DTD SVG [\d.]+(?: Basic| Tiny)?\/\/EN"\s+"https?:\/\/www\.w3\.org\/[^"\s<>]*"\s*>/;
const REF=/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos);/gi,NAMED={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"};
const read=t=>t.replace(REF,(all,r)=>{if(r[0]!=='#')return NAMED[r.toLowerCase()];
 const c=r[1]==='x'||r[1]==='X'?parseInt(r.slice(2),16):Number(r.slice(1));return c<=0x10ffff?String.fromCodePoint(c):all;});
const flat=t=>{let out='',at=0;for(;;){const a=t.indexOf('<!--',at);if(a<0)return (out+t.slice(at)).replace(/<!\[CDATA\[|\]\]>/g,'');
 const b=t.indexOf('-->',a+4);if(b<0)return null;out+=t.slice(at,a);at=b+3;}};
const pointsOut=(t,re)=>{for(const m of t.matchAll(re))if(t[m.index+m[0].length]!=='#')return true;return false;};
const outside=t=>t==null||/<!(?!--|\[CDATA\[)|<\?|\\|xinclude|xml:base|@import|(?<![\w.-])d[\t\n\r]*a[\t\n\r]*t[\t\n\r]*a[\t\n\r]*:/i.test(t)
 ||pointsOut(t,/href\s*=\s*["']/gi)||pointsOut(t,/url\(\s*["']?/gi);
export function svgSource(b){
 if(!b?.length||b.length>SVG_MAX)return null;
 let s;try{s=new TextDecoder('utf-8',{fatal:true}).decode(b);}catch{return null;}
 let rest=s.replace(/^\s+/,'');const decl=DECL.exec(rest);if(decl)rest=rest.slice(decl[0].length);
 for(let typed=false;;){rest=rest.replace(/^\s+/,'');
  if(rest.startsWith('<!--')){const end=rest.indexOf('-->',4);if(end<0)return null;rest=rest.slice(end+3);continue;}
  const d=!typed&&DOCTYPE.exec(rest);if(d){typed=true;rest=rest.slice(d[0].length);continue;}
  break;}
 if(!/^<svg[\s/>]/.test(rest))return null;
 // What comes before the svg element was read exactly above; the rest is looked at in every form.
 const doc=rest;if(/&(?!(?:#x[0-9a-f]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos);)/i.test(doc))return null;
 const f=flat(doc),r=read(doc);if(f==null)return null;
 return [doc,f,r,flat(r),read(f)].some(outside)?null:s;}

// -> draw(bytes) = Promise<{bytes: PNG} | {error, retry?}>, never rejected. Drawings run one after another. `retry` marks
// a failure that may not happen again (too slow on a busy machine, no process could be started).
export function createDrawer({size=DRAW_SIZE,timeout=5000,memory=MEMORY_MAX,node=process.execPath,log=()=>{}}={}){
 const run=svg=>new Promise(done=>{
  let settled=false,timer=null,got=0,why=null,child;const out=[],err=[];
  const finish=v=>{if(settled)return;settled=true;clearTimeout(timer);if(v.error)log({draw:v.error});done(v);};
  try{child=spawn(node,['--max-old-space-size=64',import.meta.filename,String(size),String(memory)],{stdio:['pipe','pipe','pipe'],
   env:{PATH:process.env.PATH||'/usr/bin:/bin',...(process.env.HOME?{HOME:process.env.HOME}:{}),UV_THREADPOOL_SIZE:'1',VIPS_CONCURRENCY:'1'}});}
  catch(e){finish({error:'cannot draw: '+String(e?.message||e).slice(0,120),retry:true});return;}
  let late=false;timer=setTimeout(()=>{late=true;why='took longer than '+timeout+' ms';child.kill('SIGKILL');},timeout);
  child.stdout.on('data',c=>{got+=c.length;if(got>PNG_MAX){why='answered too much';child.kill('SIGKILL');}else out.push(c);});
  child.stderr.on('data',c=>{if(err.length<4)err.push(c);});
  child.on('error',e=>finish({error:'cannot draw: '+String(e?.message||e).slice(0,120),retry:true}));
  child.on('close',code=>{if(why||code!==0)return finish({error:'drawing '+(why||'failed: '+Buffer.concat(err).toString('utf8').trim().split('\n')[0].slice(0,160)),...(late?{retry:true}:{})});
   const png=Buffer.concat(out);finish(png.length>8&&png.readUInt32BE(0)===0x89504e47&&png.readUInt32BE(4)===0x0d0a1a0a?{bytes:png}:{error:'drawing gave no PNG'});});
  child.stdin.on('error',()=>{});child.stdin.end(svg);});
 let queue=Promise.resolve();
 return bytes=>{const p=queue.then(()=>run(bytes));queue=p.then(()=>{},()=>{});return p;};}

// The child: the SVG on standard input, the PNG on standard output, a reason on standard error. It stops itself at once
// when it holds more than `memory` bytes; on Linux it also asks to be the first process ended when memory runs out.
async function child(size,memory){
 try{writeFileSync('/proc/self/oom_score_adj','1000');}catch{}
 setInterval(()=>{const rss=process.memoryUsage.rss();if(rss>memory){try{writeSync(2,'used more than '+Math.round(memory/1048576)+' MiB of memory\n');}catch{}process.kill(process.pid,'SIGKILL');}},2).unref();
 const parts=[];let n=0;for await(const c of process.stdin){n+=c.length;if(n>SVG_MAX)throw Error('too large');parts.push(c);}
 const svg=Buffer.concat(parts);if(svgSource(svg)==null)throw Error('not a drawable SVG document');
 const {default:sharp}=await import('sharp');
 sharp.cache(false);sharp.concurrency(1);sharp.block({operation:['VipsForeignLoad']});sharp.unblock({operation:['VipsForeignLoadSvgBuffer']});
 // The document's own size, then the scale that makes its longer side `size` pixels. The size is read rounded to whole
 // pixels (10.4 as 10), so the drawing may come out up to half as large again, before it is brought down to `size`.
 const m=await sharp(svg,{density:72}).metadata();
 if(m.format!=='svg'||!(m.width>0&&m.height>0))throw Error('the document has no size');
 const density=72*size/Math.max(m.width,m.height);if(!(density>=1&&density<=100000))throw Error('the document cannot be drawn at this size');
 const png=await sharp(svg,{density,limitInputPixels:(Math.ceil(size*1.5)+2)**2}).resize({width:size,height:size,fit:'inside',withoutEnlargement:true}).flatten({background:'#ffffff'}).png({compressionLevel:9}).toBuffer();
 await new Promise((done,bad)=>process.stdout.write(png,e=>e?bad(e):done()));}
if(process.argv[1]===import.meta.filename){
 const size=Number(process.argv[2]),memory=Number(process.argv[3]??MEMORY_MAX);
 if(!Number.isInteger(size)||size<16||size>4096||!Number.isInteger(memory)||memory<16777216){process.stderr.write('size: 16 to 4096 pixels; memory: at least 16 MiB\n');process.exit(2);}
 child(size,memory).catch(e=>{process.stderr.write(String(e?.message||e).split('\n')[0].slice(0,200)+'\n');process.exitCode=1;});}
