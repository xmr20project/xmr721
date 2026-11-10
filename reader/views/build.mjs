#!/usr/bin/env node
// Builds rules.js: the Mordinals rule library (rules/lib) as one browser module for the pages in this folder.
//
//   node reader/views/build.mjs           write rules.js
//   node reader/views/build.mjs --check   exit 1 when rules.js is not what the sources build to
//
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import * as esbuild from 'esbuild';

const here=path.dirname(fileURLToPath(import.meta.url));
const out=path.join(here,'rules.js');

export async function build(){
 const result=await esbuild.build({
  entryPoints:[path.join(here,'rules-entry.mjs')],bundle:true,format:'esm',platform:'browser',target:'es2020',
  minify:true,legalComments:'none',charset:'ascii',write:false,logLevel:'warning',
  banner:{js:'// Built by build.mjs from rules/lib. Do not edit; run "node reader/views/build.mjs".'}});
 return result.outputFiles[0].text;}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const text=await build();
 if(process.argv.includes('--check')){
  const same=existsSync(out)&&readFileSync(out,'utf8')===text;
  console.log(same?'rules.js is current.':'rules.js is out of date; run node reader/views/build.mjs');
  process.exit(same?0:1);}
 writeFileSync(out,text);
 console.log(`rules.js written, ${text.length} bytes.`);}
