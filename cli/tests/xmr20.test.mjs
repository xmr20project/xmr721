// The xmr20 command (cli/xmr20.mjs): its own words for the xmr721 wallet's token commands. Real processes, a stand-in for
// the carrier tool and one local server that plays reader and node, as in command.test.mjs.
//   node --test cli/tests/xmr20.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,mkdirSync,chmodSync} from 'node:fs';
import {spawnSync,spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const dirs=[];test.after(()=>{for(const d of dirs)rmSync(d,{recursive:true,force:true});});
const temp=()=>{const d=mkdtempSync(join(tmpdir(),'xmr20-command-'));dirs.push(d);return d;};
const BIN=join(import.meta.dirname,'..','xmr20.mjs'),DOMAIN='7c'.repeat(32);
const run=(...args)=>{const r=spawnSync(process.execPath,[BIN,...args],{encoding:'utf8'});return [r.status,r.stdout,r.stderr];};

test('help and refusals speak of xmr20, and the NFT commands are not here',()=>{
 const [code,out]=run('--help');assert.equal(code,0);assert.match(out,/xmr20 deploy --tick/);assert.match(out,/xmr20 mint <token id> <amount>/);
 assert.ok(!/xmr721 wallet (deploy|mint) --/.test(out.split('A token is announced')[0]));
 assert.equal(run()[0],2);
 for(const c of ['inscribe','collection','send','wallet','nothing']){const [k,,err]=run(c);assert.equal(k,2);assert.match(err,/^xmr20 <create \| receive/);}
 const none=join(temp(),'none');
 assert.deepEqual(run('mint','0123456789abcdef','5','--wallet',none).slice(0,3),[2,'',`There is no wallet in ${none}. Make one with: xmr20 create\n`]);
 assert.deepEqual(run('--wallet',none,'status')[2],`There is no wallet in ${none}. Make one with: xmr20 create\n`);
 assert.equal(run('mint','zz','5')[2],'The token is its id (64 hex characters), or the 16 characters signed texts show.\n');
 assert.equal(run('split')[2],'xmr20 split <n>\n');assert.equal(run('forget')[2],'xmr20 forget <n>\n');
 assert.equal(run('deploy','--tick','PEPE')[2],'Give --max.\n');
 assert.equal(run('deploy','--tick','PEPE','--max','100','--col','ab')[2],'"deploy" takes no --col.\n');
 assert.equal(run('mint','0123456789abcdef','5','--file','x')[2],'"mint" takes no --file.\n');
 assert.equal(run('status','--bogus','1')[2],'There is no option --bogus. See: xmr20 --help\n');
});

test('balance and status run the wallet on the same folder',async()=>{
 const dir=join(temp(),'wallet');mkdirSync(dir,{mode:0o700});
 writeFileSync(join(dir,'carrier.keys.json'),JSON.stringify({spend:'01'.padEnd(64,'0'),view:'02'.padEnd(64,'0')}),{mode:0o600});
 writeFileSync(join(dir,'wallet.json'),JSON.stringify({network:'stagenet',start:5}));
 const tool=join(dir,'..','tool.js');
 writeFileSync(tool,`#!/usr/bin/env node
const [dir,op]=process.argv.slice(2);
console.log(JSON.stringify(op==='status'?{result:{address:'x',tip:10,balance:'30000000000',coins:3,ready:3,payments:[]}}:{error:'Unknown operation'}));
`);chmodSync(tool,0o755);
 const s=createServer(async(req,res)=>{for await(const _ of req);const send=v=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(v));};
  if(req.url==='/info')return send({network:'stagenet',domain:DOMAIN,height:10,mintFrom:5});
  if(req.url==='/json_rpc')return send({result:{height:11,top_block_hash:'ab'.repeat(32),nettype:'stagenet',offline:false,synchronized:true}});
  send({status:'OK',txs:[]});});
 await new Promise(r=>s.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+s.address().port;
 const go=(...args)=>new Promise(done=>{const c=spawn(process.execPath,[BIN,...args,'--wallet',dir,'--network','stagenet','--reader',url,'--node',url,'--domain',DOMAIN,'--carrier',tool],{stdio:['ignore','pipe','pipe']});
  let out='',err='';c.stdout.on('data',d=>out+=d);c.stderr.on('data',d=>err+=d);c.on('exit',code=>done({code,out,err}));});
 try{
  const b=await go('balance');assert.equal(b.code,0,b.err);assert.equal(JSON.parse(b.out).balance!==undefined||/0\.03/.test(b.out),true,b.out);
  const st=await go('status');assert.equal(st.code,0,st.err);assert.ok(!/xmr721 wallet/.test(st.out+st.err),st.out+st.err);
 }finally{s.closeAllConnections?.();await new Promise(r=>s.close(r));}
});

test('sign: a message signed with the wallet\'s address, as a Monero wallet signs one',async()=>{
 const {verifySpendSignature}=await import('../../rules/lib/monero.mjs');
 const dir=join(temp(),'wallet');mkdirSync(dir,{mode:0o700});
 writeFileSync(join(dir,'carrier.keys.json'),JSON.stringify({spend:'01'.padEnd(64,'0'),view:'02'.padEnd(64,'0')}),{mode:0o600});
 writeFileSync(join(dir,'wallet.json'),JSON.stringify({network:'stagenet',start:5}));
 const on=['--wallet',dir,'--network','stagenet'];
 const address=JSON.parse(run('receive',...on)[1]).address;
 const message=`XMR20 list: sell 1000 PEPE (token 35400ac2ee704eeb) for 0.05 XMR paid to ${address}; valid until block 3817900; code 9c41d07e52ab6f3388e1b4c27a905d1f`;
 // No node, reader or carrier tool is needed: none is there.
 const [code,out,err]=run('sign',message,...on,'--node','http://127.0.0.1:1','--carrier',join(dir,'none'));
 assert.equal(code,0,err);const signed=JSON.parse(out);
 assert.deepEqual([signed.address,signed.message],[address,message]);assert.match(signed.signature,/^SigV2[1-9A-HJ-NP-Za-km-z]{88}$/);
 assert.ok(verifySpendSignature(message,address,signed.signature,'stagenet'));
 assert.ok(!verifySpendSignature(message.replace('0.05','0.01'),address,signed.signature,'stagenet'));
 // From a file, without the line break at its end; the same message, another signature that also holds.
 const file=join(dir,'..','message.txt');writeFileSync(file,message+'\n');
 const again=JSON.parse(run('sign','--file',file,...on)[1]);assert.equal(again.message,message);assert.notEqual(again.signature,signed.signature);
 assert.ok(verifySpendSignature(message,address,again.signature,'stagenet'));
 // Refusals.
 assert.equal(run('sign',...on)[2],'xmr20 sign "<message>" (the message in quotes, as one word), or: xmr20 sign --file <path>\n');
 assert.equal(run('sign','two','words',...on)[0],2);assert.equal(run('sign','a','--file',file,...on)[0],2);
 assert.equal(run('sign','--file',join(dir,'no-file'),...on)[0],2);
 writeFileSync(file,'one\ntwo\n');assert.match(run('sign','--file',file,...on)[2],/line break/);
 assert.match(run('sign','x'.repeat(4097),...on)[2],/longer than 4096/);
 assert.equal(run('sign','x','--wallet',join(dir,'nowhere'))[0],2);
 assert.match(run('--help')[1],/xmr20 sign "<message>"/);
});
