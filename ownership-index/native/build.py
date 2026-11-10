#!/usr/bin/env python3
"""Builds the replay tool around the unmodified original Mordinals index source.

Original source: mooonero/mordinals at the commit in the manifest, checked by hash.
Compiler flags, include paths and libraries are taken from a CMake/Ninja build tree of that
source which has a small executable target named `mordinals_probe` linking the node
libraries.

Environment:
  MORDINALS_MANIFEST  folder with source-manifest.json and source/ (the files it lists)
  MORDINALS_SOURCE    checkout of mooonero/mordinals at that commit
  MORDINALS_BUILD     its build folder (holds build.ninja)
"""
from pathlib import Path
import json,hashlib,os,re,shlex,subprocess
BASE=Path(__file__).resolve().parent
UP=Path(os.environ['MORDINALS_MANIFEST']);SRC=Path(os.environ['MORDINALS_SOURCE']);BUILD=Path(os.environ['MORDINALS_BUILD'])
manifest=json.loads((UP/'source-manifest.json').read_text())
checks=[]
for entry in manifest['files']:
    p=UP/'source'/entry['path'];h=hashlib.sha256(p.read_bytes()).hexdigest()
    assert h==entry['sha256'],entry['path']
    assert (SRC/entry['path']).read_bytes()==p.read_bytes(),entry['path']
    checks.append({'path':entry['path'],'sha256':h})
ninja=(BUILD/'build.ninja').read_text()
obj=ninja[ninja.index('build CMakeFiles/mordinals_probe.dir/'):ninja.index('# Link build statements for EXECUTABLE target mordinals_probe')]
link=ninja[ninja.index('build mordinals_probe:'):];link=link[:link.index('\n\n')]
get=lambda text,name:re.search(r'^  '+name+r' = (.*)$',text,re.M).group(1)
flags=shlex.split(get(obj,'DEFINES'))+shlex.split(get(obj,'FLAGS'))
incs=['-I'+str(UP/'source/src'),'-I'+str(SRC/'src/cryptonote_basic'),'-I'+str(SRC/'src/cryptonote_core')]+shlex.split(get(obj,'INCLUDES'))
libs=[str(BUILD/x) if x.endswith('.a') and not x.startswith('/') else x for x in shlex.split(get(link,'LINK_LIBRARIES'))]
out=BASE/'build';out.mkdir(exist_ok=True)
objects=[]
for name,src in [('original-indexer',UP/'source/src/cryptonote_core/inscriptions_container.cpp'),('original-parser',UP/'source/src/cryptonote_basic/cryptonote_format_utils.cpp'),('replay',BASE/'replay.cpp')]:
    o=out/(name+'.o');subprocess.run(['/usr/bin/clang++',*flags,*incs,'-c',str(src),'-o',str(o)],check=True,cwd=BUILD);objects.append(str(o))
subprocess.run(['/usr/bin/clang++','-arch','arm64',*objects,*libs,'-o',str(out/'replay')],check=True,cwd=BUILD)
(BASE/'build-evidence.json').write_text(json.dumps({'upstream':manifest['upstream'],'commit':manifest['commit'],'sourceChecks':checks,'sourceRulePatches':False,'freshlyCompiled':['src/cryptonote_core/inscriptions_container.cpp','src/cryptonote_basic/cryptonote_format_utils.cpp','replay.cpp'],'replaySha256':hashlib.sha256((BASE/'replay.cpp').read_bytes()).hexdigest(),'binarySha256':hashlib.sha256((out/'replay').read_bytes()).hexdigest()},indent=2)+'\n')
print('built',out/'replay')
