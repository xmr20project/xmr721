// The local test chain and wallets shared by the lab tests: an offline fakechain (monerod --regtest) and monero-wallet-rpc wallets.
// Throwaway wallets, no real funds, no network.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {writeFile,mkdir} from 'node:fs/promises';
import {createServer} from 'node:net';
import {join} from 'node:path';
import {hex} from '../lib/monero.mjs';
// Folder holding monerod and monero-wallet-rpc (0.18.x).
export const BIN=process.env.MONERO_BIN;
if(!BIN)throw Error('Set MONERO_BIN to the folder that holds monerod and monero-wallet-rpc.');
export const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export const freePort=()=>new Promise(res=>{const s=createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>res(p));});});
export const call=async(port,method,params={})=>{const r=await fetch(`http://127.0.0.1:${port}/json_rpc`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'t',method,params}),signal:AbortSignal.timeout(180000)});
 const v=await r.json();if(v.error)throw Error(method+': '+v.error.message);return v.result;};
export async function startChain(dir){
 const rpc=await freePort(),p2p=await freePort();await writeFile(join(dir,'config'),'');
 const child=spawn(join(BIN,'monerod'),['--regtest','--keep-fakechain','--offline','--fixed-difficulty','1','--no-igd','--hide-my-port','--no-zmq','--disable-dns-checkpoints','--check-updates','disabled','--non-interactive',
  '--data-dir',join(dir,'data'),'--config-file',join(dir,'config'),'--log-file',join(dir,'daemon.log'),'--rpc-bind-ip','127.0.0.1','--rpc-bind-port',String(rpc),'--p2p-bind-ip','127.0.0.1','--p2p-bind-port',String(p2p),'--max-concurrency','2'],{stdio:'ignore'});
 for(let i=0;i<150;i++){try{const info=await call(rpc,'get_info');assert.equal(info.nettype,'fakechain');return {port:rpc,url:`http://127.0.0.1:${rpc}`,child,version:info.version};}catch{await sleep(200);}}
 child.kill('SIGKILL');throw Error('monerod did not start');}
export async function startWallet(dir,daemonPort,name,make=port=>call(port,'create_wallet',{filename:'w',password:'',language:'English'})){
 const port=await freePort(),wdir=join(dir,name);await mkdir(wdir);
 const child=spawn(join(BIN,'monero-wallet-rpc'),['--daemon-address','127.0.0.1:'+daemonPort,'--trusted-daemon','--allow-mismatched-daemon-version','--wallet-dir',wdir,'--rpc-bind-ip','127.0.0.1','--rpc-bind-port',String(port),
  '--disable-rpc-login','--log-level','0','--log-file',join(wdir,'rpc.log'),'--non-interactive'],{stdio:'ignore'});
 for(let i=0;i<150;i++){try{await call(port,'get_version');break;}catch{await sleep(200);}}
 await make(port);
 const address=(await call(port,'get_address',{account_index:0})).address,rpc=(m,p)=>call(port,m,p);
 return {name,port,address,child,rpc,sign:(data,type='spend',index=0)=>rpc('sign',{data,account_index:0,address_index:index,signature_type:type}).then(r=>r.signature),
  proof:(txid,addr=address,message)=>rpc('get_tx_proof',{txid,address:addr,...(message?{message}:{})}).then(r=>r.signature)};}
// The transaction public keys in tx_extra: tag 01 = the key, tag 04 = additional keys.
export function txPubKeys(tx){const e=Uint8Array.from(tx.extra),main=[],additional=[];
 for(let i=0;i<e.length;){const t=e[i++];if(t===1){main.push(hex(e.subarray(i,i+32)));i+=32;}else if(t===4){const n=e[i++];for(let j=0;j<n;j++,i+=32)additional.push(hex(e.subarray(i,i+32)));}else if(t===2){i+=1+e[i];}else if(t===0)break;else throw Error('Unexpected tx_extra tag '+t);}
 return {main,additional};}
// What the rules read of a payment transaction.
export const slim=tx=>({version:tx.version,unlock_time:tx.unlock_time,vout:tx.vout,extra:tx.extra,rct_signatures:{type:tx.rct_signatures.type,ecdhInfo:tx.rct_signatures.ecdhInfo,outPk:tx.rct_signatures.outPk}});

// Stops the chain and the wallets and waits for them, so nothing is written after the run folder is removed.
export const stopAll=procs=>Promise.all(procs.filter(p=>p?.child).map(p=>p.child).map(c=>new Promise(done=>{if(c.exitCode!==null)return done();c.once('exit',done);c.kill('SIGTERM');setTimeout(()=>{c.kill('SIGKILL');done();},15000).unref();})));
