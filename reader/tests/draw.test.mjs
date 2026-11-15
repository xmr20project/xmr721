// Offline tests of the SVG drawings (lib/draw.mjs) and of how a Mordinal's content becomes a picture (lib/content.mjs):
//   node --test reader/tests/draw.test.mjs
// The tests that draw need the optional picture library `sharp`; without it they are skipped.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {svgSource,createDrawer,SVG_MAX,DRAW_SIZE} from '../lib/draw.mjs';
import {createContent} from '../lib/content.mjs';

const sha=b=>createHash('sha256').update(b).digest('hex');
const sharp=await import('sharp').then(m=>m.default,()=>null),needs={skip:sharp?false:'the optional picture library sharp is not installed'};
const dirs=[];test.after(()=>{for(const d of dirs)rmSync(d,{recursive:true,force:true});});
const temp=()=>{const d=mkdtempSync(join(tmpdir(),'xmr721-draw-'));dirs.push(d);return d;};
const NS='xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"';
const svg=(inner,size='width="64" height="64"')=>`<svg ${NS} ${size}>${inner}</svg>`;
const DRAWING=svg('<circle cx="32" cy="32" r="28" fill="#f26822"/>');
// What a PNG holds: its size, its channels and the colour at a point.
const look=async(png,x=0,y=0)=>{const {data,info}=await sharp(png).raw().toBuffer({resolveWithObject:true}),i=(y*info.width+x)*info.channels;
 return {width:info.width,height:info.height,channels:info.channels,at:[...data.subarray(i,i+info.channels)],data};};
const reds=(data,channels)=>{let n=0;for(let i=0;i<data.length;i+=channels)if(data[i]>200&&data[i+1]<60&&data[i+2]<60&&(channels<4||data[i+3]>200))n++;return n;};

test('an SVG document is drawn only when it names nothing outside itself',()=>{
 const yes=s=>assert.equal(svgSource(Buffer.from(s)),s,s.slice(0,160)),no=s=>assert.equal(svgSource(typeof s==='string'?Buffer.from(s):s),null,String(s).slice(0,160));
 yes(DRAWING);yes(DRAWING+'\n');yes('<svg width="8" height="8"><rect width="8" height="8"/></svg>');
 yes('<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n'+DRAWING);
 yes('<?xml version="1.0"?>\n<!-- Generator: an editor -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n'+DRAWING);
 yes(svg('<defs><clipPath id="c"><rect width="9" height="9"/></clipPath><linearGradient id="g"><stop offset="0"/></linearGradient></defs><g clip-path="url(#c)"><rect fill="url( \'#g\')" width="9" height="9"/></g><use href="#c"/><use xlink:href=\'#c\'/>','viewBox="0 0 9 9" data-name="Layer 1"'));
 yes(svg('<title>m</title><text x="1" y="9">Tom &amp; Jerry &lt;3 &#169; &#x263A;</text><style>rect{fill:#000}</style><style><![CDATA[ g > rect {fill:red} ]]></style>'));
 yes(svg('<metadata>drawn by hand</metadata><g inkscape:label="layer"/>','xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" sodipodi:docname="a.svg" width="9" height="9"'));
 assert.equal(svgSource(Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from(DRAWING)])),DRAWING,'a byte order mark at the start');
 // Not an SVG document.
 for(const s of ['','hello','<html><body><svg></svg></body></html>','<?xml version="1.0"?><note/>','<p><svg/></p>','<svgx/>','<svg:svg xmlns:svg="http://www.w3.org/2000/svg"/>',
  Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),Buffer.from([0x3c,0x73,0x76,0x67,0x20,0xff,0x3e]),svg('<desc>'+'x'.repeat(SVG_MAX)+'</desc>'),
  '<?xml version="1.0" encoding="UTF-16"?>'+DRAWING,'<?xml version="1.0" encoding="UTF-7"?>'+DRAWING,'<!-- a note --><?xml version="1.0"?>'+DRAWING,'<!-- open'+DRAWING])no(s);
 // Declarations, entities and processing instructions.
 for(const s of ['<!DOCTYPE svg [<!ENTITY x "y">]>'+svg('<text>&x;</text>'),'<!DOCTYPE svg SYSTEM "file:///etc/passwd">'+DRAWING,
  '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "file:///dev/zero">'+DRAWING,'<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://example.com/svg11.dtd">'+DRAWING,
  svg('<text>&nbsp;</text>'),svg('<text>&x;</text>'),svg('<text>a & b</text>'),svg('<!ENTITY x "y">'),svg('<!DOCTYPE svg>'),
  '<?xml-stylesheet type="text/css" href="http://127.0.0.1/a.css"?>'+DRAWING,svg('<?xml-stylesheet href="a.css"?>'),svg('<?php echo 1 ?>')])no(s);
 // References to anything outside the document.
 for(const s of [svg('<image href="http://127.0.0.1/a.png"/>'),svg('<image xlink:href="file:///etc/passwd"/>'),svg('<image href="/etc/passwd"/>'),svg('<image href="a.png"/>'),
  svg('<image href="data:image/png;base64,AAAA"/>'),svg('<use href=" #a"/>'),svg('<use href=""/>'),svg('<use HREF="http://127.0.0.1/"/>'),svg('<use x:href = \'other.svg#a\'/>'),
  svg('<a href="https://example.com/"><rect/></a>'),svg('<feImage href="http://127.0.0.1/a.png"/>'),
  svg('<rect fill="url(http://127.0.0.1/p.svg#p)"/>'),svg('<rect style="fill:URL( \'file:///x.svg#p\')"/>'),svg('<rect filter="url()"/>'),svg('<rect fill="url(other.svg#p)"/>'),
  svg('<style>@import "http://127.0.0.1/a.css";</style>'),svg('<style>@IMPORT url(#a);</style>'),svg('<style>@font-face{src:url(a.woff)}</style>'),
  svg('<style>rect{fill:\\75 rl(http://127.0.0.1/)}</style>'),svg('<xi:include href="#a" xmlns:xi="http://www.w3.org/2001/XInclude"/>'),svg('<g xml:base="http://127.0.0.1/"><use href="#a"/></g>'),
  svg('<text>see data:text/html,x</text>'),
  // ... also once the parser has replaced references and left out comments and CDATA marks.
  svg('<rect fill="&#117;rl(http://127.0.0.1/)"/>'),svg('<rect fill="&#x55;RL(a.svg#p)"/>'),svg('<image h&#114;ef="a.png"/>'),svg('<style>rect{fill:&#92;75rl(a.svg#p)}</style>'),
  svg('<style>rect{fill:ur<!-- -->l(http://127.0.0.1/)}</style>'),svg('<style><![CDATA[rect{fill:ur]]><![CDATA[l(http://127.0.0.1/)}]]></style>'),
  svg('<style>@imp<!---->ort "a.css";</style>'),svg('<rect fill="url(&quot;http://127.0.0.1/&quot;)"/>'),svg('<!-- a comment that does not end')])no(s);
 // In time that grows with the size at most: the service runs this check itself.
 for(const s of ['<svg>'+'<!--'.repeat(250000),'<svg '+' href="'.repeat(140000),'<svg '+'a'.repeat(SVG_MAX-8),'<svg>'+'url('.repeat(250000),'<svg>'+'&#x41;'.repeat(170000),
  '<svg '+' x:'.repeat(330000),'<svg>'+'<![CDATA['.repeat(110000),'<svg>'+'&lt;!--'.repeat(140000)]){const t=Date.now();svgSource(Buffer.from(s));assert.ok(Date.now()-t<1500,'slow: '+s.slice(0,20));}});

test('the drawing library loads nothing outside the document, whatever it names',needs,async()=>{
 // The second fence alone: hostile documents go straight to the library, as the child sets it up, past svgSource.
 const dir=temp(),hits=[],red=await sharp({create:{width:8,height:8,channels:4,background:'#ff0000'}}).png().toBuffer();
 writeFileSync(join(dir,'red.png'),red);writeFileSync(join(dir,'red.css'),'rect{fill:#ff0000}');writeFileSync(join(dir,'secret.txt'),'SECRET SECRET SECRET');
 writeFileSync(join(dir,'red.svg'),svg('<rect id="r" width="64" height="64" fill="#ff0000"/>'));
 const server=createServer((q,r)=>{hits.push(q.url);const css=q.url.endsWith('.css'),text=q.url.endsWith('.txt')||q.url.endsWith('.dtd');
  r.writeHead(200,{'content-type':css?'text/css':text?'text/plain':q.url.endsWith('.svg')?'image/svg+xml':'image/png'});r.end(css?'rect{fill:#ff0000}':text?'SECRET':q.url.endsWith('.svg')?readFileSync(join(dir,'red.svg')):red);});
 await new Promise(done=>server.listen(0,'127.0.0.1',done));const H='http://127.0.0.1:'+server.address().port,F='file://'+dir;
 const base='<rect width="64" height="64" fill="none"/>',T=s=>svg(`<text x="0" y="40" font-size="30" fill="#ff0000">${s}</text>`);
 const cases=[svg(`<image href="${H}/a.png" width="64" height="64"/>`),svg(`<image xlink:href="${H}/b.png" width="64" height="64"/>`),svg(`<image href="${F}/red.png" width="64" height="64"/>`),
  svg(`<image href="${dir}/red.png" width="64" height="64"/>`),svg('<image href="red.png" width="64" height="64"/>'),svg(`<use href="${F}/red.svg#r"/>`),svg(`<use href="${H}/c.svg#r"/>`),svg('<use href="red.svg#r"/>'),
  svg(`<filter id="f"><feImage href="${H}/d.png"/></filter><rect width="64" height="64" filter="url(#f)"/>`),svg(`<style>@import url("${H}/e.css");</style><rect width="64" height="64" fill="#000000"/>`),
  svg(`<style>@import url("${F}/red.css");</style><rect width="64" height="64"/>`),`<?xml version="1.0"?><?xml-stylesheet type="text/css" href="${H}/f.css"?>`+svg('<rect width="64" height="64"/>'),
  `<?xml version="1.0"?><?xml-stylesheet type="text/css" href="${F}/red.css"?>`+svg('<rect width="64" height="64"/>'),svg(`<rect width="64" height="64" style="fill:url(${H}/g.svg#r)"/>`),
  svg(`<rect width="64" height="64" fill="url(${F}/red.svg#r)"/>`),svg(`<g xml:base="${F}/"><use href="red.svg#r"/></g>`),
  T(`<xi:include href="${F}/secret.txt" parse="text" xmlns:xi="http://www.w3.org/2001/XInclude"/>`),svg(`<xi:include href="${H}/h.svg" xmlns:xi="http://www.w3.org/2001/XInclude"/>`),
  `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x SYSTEM "${F}/secret.txt">]>`+T('&x;'),`<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x SYSTEM "${H}/i.txt">]>`+T('&x;'),
  `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY % p SYSTEM "${H}/j.dtd"> %p;]>`+T('x'),`<?xml version="1.0"?><!DOCTYPE svg SYSTEM "${H}/k.dtd">`+svg(base),
  `<?xml version="1.0"?><!DOCTYPE svg [${Array.from({length:8},(_,i)=>`<!ENTITY e${i} "${i?`&e${i-1};`.repeat(10):'lol'}">`).join('')}]>`+T('&e7;'),
  svg(`<style>@font-face{font-family:X;src:url(${H}/l.woff)}</style><text x="0" y="40" font-family="X">a</text>`)];
 const S=sharp;S.cache(false);S.block({operation:['VipsForeignLoad']});S.unblock({operation:['VipsForeignLoadSvgBuffer']});
 try{for(const c of cases){let data=null,channels=4;try{({data,info:{channels}}=await S(Buffer.from(c)).ensureAlpha().raw().toBuffer({resolveWithObject:true}));}catch{}
   if(data)assert.equal(reds(data,channels),0,'drew something it was not given: '+c.slice(0,160));}
  assert.deepEqual(hits,[],'the library asked for '+hits.join(', '));
  // What the library does draw from a reference: a data address. svgSource keeps those out.
  const inline=svg(`<image href="data:image/png;base64,${red.toString('base64')}" width="64" height="64"/>`);
  assert.ok(reds((await S(Buffer.from(inline)).ensureAlpha().raw().toBuffer()),4)>0);assert.equal(svgSource(Buffer.from(inline)),null);
  for(const c of cases)assert.equal(svgSource(Buffer.from(c)),null,'svgSource let through '+c.slice(0,160));}
 finally{S.unblock({operation:['VipsForeignLoad']});server.close();}});

test('a drawing is a PNG on white, at most 1,024 pixels a side, made in a child process that checks the document again',needs,async()=>{
 const draw=createDrawer(),d=await draw(Buffer.from(DRAWING));
 assert.ok(d.bytes,d.error);const p=await look(d.bytes,0,0);
 assert.deepEqual([p.width,p.height,p.channels,p.at],[DRAW_SIZE,DRAW_SIZE,3,[255,255,255]]);assert.deepEqual((await look(d.bytes,512,512)).at,[242,104,34]);
 // The longer side is DRAW_SIZE, whatever the document's own size; no size of its own: the size of what it draws.
 for(const [doc,size] of [[svg('<rect width="9" height="9"/>','width="200" height="100"'),[1024,512]],[svg('<rect width="9" height="9"/>','viewBox="0 0 30 60"'),[512,1024]],
  [svg('<rect width="1" height="1"/>','width="1" height="1"'),[1024,1024]],[svg('<rect width="3000" height="1500"/>','width="3000" height="1500"'),[1024,512]],
  [`<svg ${NS}><rect width="10" height="10"/></svg>`,[1024,1024]]]){const r=await draw(Buffer.from(doc));assert.ok(r.bytes,r.error);const m=await look(r.bytes);assert.deepEqual([m.width,m.height],size,doc);}
 // Too large to draw at any scale, not SVG to the library, broken XML, or nothing a person may see: no picture.
 for(const doc of [svg('','width="100000" height="100000"'),svg('<rect width="9" height="9">','width="9" height="9"'),'<svg '+NS+' width="9" height="9"><rect></svg>'])
  assert.match((await draw(Buffer.from(doc))).error,/^drawing failed/,doc);
 // The child checks the document itself: a document svgSource refuses is never drawn, even when handed straight to it.
 assert.match((await draw(Buffer.from(svg('<image href="data:image/png;base64,AAAA" width="9" height="9"/>')))).error,/not a drawable SVG document/);
 assert.match((await draw(Buffer.from('plain words'))).error,/not a drawable SVG document/);});

test('a drawing that takes too long or too much memory is stopped, and drawings run one at a time',needs,async()=>{
 // Twenty large dilations: half a minute or more of work at 1,024 pixels.
 const slow=svg(`<filter id="f" x="0" y="0" width="1" height="1">${'<feMorphology operator="dilate" radius="60"/>'.repeat(20)}</filter><rect width="64" height="64" fill="#f26822" filter="url(#f)"/>`);
 assert.notEqual(svgSource(Buffer.from(slow)),null);
 const t=Date.now(),r=await createDrawer({timeout:1500})(Buffer.from(slow));
 assert.match(r.error,/took longer than 1500 ms/);assert.ok(Date.now()-t<6000,'stopped late: '+(Date.now()-t)+' ms');
 // A thousand kept filter results: gigabytes in a fraction of a second. The child stops itself first.
 const greedy=svg(`<filter id="f" x="0" y="0" width="1" height="1">${Array.from({length:1000},(_,i)=>`<feFlood flood-color="#f26822" result="r${i}"/>`).join('')}</filter><rect width="64" height="64" filter="url(#f)"/>`);
 assert.notEqual(svgSource(Buffer.from(greedy)),null);assert.match((await createDrawer({timeout:20000})(Buffer.from(greedy))).error,/used more than 512 MiB of memory/);
 assert.match((await createDrawer({memory:64*1048576})(Buffer.from(DRAWING))).error,/used more than 64 MiB of memory/,'a node with sharp loaded holds more than 64 MiB');
 // One at a time: a stand-in for node notes when each run starts and ends.
 const dir=temp(),log=join(dir,'log'),fake=join(dir,'fake.sh');writeFileSync(log,'');
 writeFileSync(fake,`#!/bin/sh\nprintf s >> "${log}"\ncat > /dev/null\nsleep 0.2\nprintf e >> "${log}"\nexit 1\n`);chmodSync(fake,0o755);
 const errors=[],draw=createDrawer({node:fake,log:v=>errors.push(v.draw)}),runs=await Promise.all([1,2,3,4].map(()=>draw(Buffer.from(DRAWING))));
 assert.equal(readFileSync(log,'utf8'),'sesesese');assert.ok(runs.every(x=>/^drawing failed/.test(x.error)));assert.equal(errors.length,4);
 assert.match((await createDrawer({node:join(dir,'missing')})(Buffer.from(DRAWING))).error,/^cannot draw/);});

test('a Mordinal whose content is an SVG document answers with the picture drawn from it, drawn once',async()=>{
 const doc=Buffer.from(DRAWING),png=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),Buffer.from('a picture')]),text=Buffer.from('777\n'),outside=Buffer.from(svg('<image href="a.png"/>'));
 const drawnPng=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),Buffer.from('drawn')]),files=new Map([doc,png,text,outside].map(b=>[sha(b),{bytes:b,sensitive:false}]));
 const entry=b=>({bodySha256:sha(b),bodySize:b.length,registrationTx:sha(b)});
 let calls=0,answer={bytes:drawnPng};const draw=async()=>{calls++;await new Promise(done=>setTimeout(done,20));return answer;};
 const get=createContent({source:async o=>files.get(o.bodySha256)??null,draw,keep:3});
 const all=await Promise.all([1,2,3,4,5].map(()=>get(entry(doc))));
 assert.equal(calls,1,'looked up and drawn once for five at the same time');for(const x of all)assert.deepEqual(x,{status:200,type:'image/png',bytes:drawnPng,sensitive:false,drawn:'svg'});
 // Kept apart from the other answers: browsing many other Mordinals does not make it drawn again.
 for(let i=0;i<10;i++){const b=Buffer.from('other '+i);files.set(sha(b),{bytes:b,sensitive:false});await get(entry(b));}
 assert.equal((await get(entry(doc))).status,200);assert.equal(calls,1);
 assert.deepEqual(await get(entry(png)),{status:200,type:'image/png',bytes:png,sensitive:false});
 assert.equal((await get(entry(text))).text,'777\n');
 // A document that names something outside itself is not drawn, nor shown as text.
 assert.deepEqual(await get(entry(outside)),{status:415,error:'This Mordinal is not a picture.'});assert.equal(calls,1);
 // A drawing that fails says so, and is not tried again.
 const other=Buffer.from(svg('<rect width="9" height="9"/>'));files.set(sha(other),{bytes:other,sensitive:true});answer={error:'drawing took longer than 5000 ms'};
 assert.deepEqual(await get(entry(other)),{status:415,error:'This drawing cannot be shown.'});assert.deepEqual(await get(entry(other)),{status:415,error:'This drawing cannot be shown.'});assert.equal(calls,2);
 // Drawing turned off: an SVG document is not a picture.
 assert.deepEqual(await createContent({source:async o=>files.get(o.bodySha256),draw:null})(entry(doc)),{status:415,error:'This Mordinal is not a picture.'});
 // Content that does not match the owner list is never drawn.
 assert.equal((await createContent({source:async()=>({bytes:doc}),draw})({bodySha256:sha(Buffer.from('else')),bodySize:doc.length})).status,502);assert.equal(calls,2);});

test('with the real drawer, the content answer is a PNG picture',needs,async()=>{
 const doc=Buffer.from(DRAWING),get=createContent({source:async()=>({bytes:doc,sensitive:true})});
 const r=await get({bodySha256:sha(doc),bodySize:doc.length});
 assert.deepEqual([r.status,r.type,r.drawn,r.sensitive],[200,'image/png','svg',true]);assert.deepEqual([(await look(r.bytes)).width],[DRAW_SIZE]);});
