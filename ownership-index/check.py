#!/usr/bin/env python3
"""Second, separately written replay of the original Mordinals ownership rules.

Reads the scanned transactions, applies the rules as written in the original index
source, compares every decision with what the compiled original index decided
(native/build/replay output), and writes the owner list.

Usage: check.py NATIVE.jsonl OUT_DIR PART.bin [PART.bin ...]
Body identity here is SHA-256; the original uses Keccak-256. Both give the same
equal/not-equal answers. Transaction ids come from the native tool.
"""
import sys,json,struct,hashlib
from pathlib import Path
FIRST=2838270;FEE_FROM=2855400;DEAD_LO=70499730;DEAD_HI=70499747

class Bad(Exception):pass
class Rd:
    def __init__(s,b,i=0,end=None):s.b=b;s.i=i;s.end=len(b) if end is None else end
    def eof(s):return s.i>=s.end
    def left(s):return s.end-s.i
    def byte(s):
        if s.i>=s.end:raise Bad('end')
        v=s.b[s.i];s.i+=1;return v
    def take(s,n):
        if s.left()<n:raise Bad('end')
        v=s.b[s.i:s.i+n];s.i+=n;return v
    def varint(s):
        r=0;shift=0
        while True:
            c=s.byte()
            if c==0 and shift:raise Bad('varint form')
            if shift+7>=64 and c>=1<<(64-shift):raise Bad('varint size')
            r|=(c&127)<<shift
            if c<128:return r
            shift+=7
    def string(s):return s.take(s.varint())

def parse_tx(blob):
    r=Rd(blob);version=r.varint();r.varint();ins=[]
    for _ in range(r.varint()):
        if r.byte()!=2:raise Bad('input type')
        r.varint();offs=[r.varint() for _ in range(r.varint())];r.take(32);ins.append(offs)
    outs=[]
    for _ in range(r.varint()):
        r.varint();t=r.byte()
        if t==2:outs.append((r.take(32),None))
        elif t==3:k=r.take(32);outs.append((k,r.take(1)))
        else:raise Bad('output type')
    extra=r.string();rct=r.byte();fee=r.varint() if rct else 0
    return version,ins,outs,extra,fee

def parse_extra(extra):
    """Fields parsed before the first failure, and whether the whole extra parsed."""
    fields=[];r=Rd(extra)
    if not extra:return fields,True
    try:
        while True:
            tag=r.byte()
            if tag==0x00:
                n=1
                while n<=255:
                    if r.eof():break
                    if r.byte()!=0:raise Bad('padding')
                    n+=1
                if n>255:raise Bad('padding size')
                f=(tag,)
            elif tag==0x01:f=(tag,r.take(32))
            elif tag==0x02:
                v=r.string()
                if len(v)>255:raise Bad('nonce size')
                f=(tag,v)
            elif tag==0x03:
                v=r.string();q=Rd(v);q.varint();q.take(32)
                if not q.eof():raise Bad('merge mining tag')
                f=(tag,v)
            elif tag==0x04:
                n=r.varint()
                if n>r.left():raise Bad('key count')
                f=(tag,[r.take(32) for _ in range(n)])
            elif tag==0xde:f=(tag,r.string())
            elif tag==0x10:a=r.string();f=(tag,a,r.string())
            elif tag==0x11:f=(tag,r.string())
            elif tag==0x12:a=r.string();f=(tag,a,r.take(32),r.take(8),r.take(8))
            elif tag==0x13:a=r.take(32);b=r.string();f=(tag,a,b,r.take(32))
            else:raise Bad('tag')
            fields.append(f)
            if r.eof():return fields,True
    except Bad:return fields,False

def fee_ok(size,height,fee):
    if height<FEE_FROM:return True
    need=(size*4000000+999999999)//1000000000*1000000000
    return fee>=need

def frames(paths):
    for p in paths:
        with open(p,'rb') as f:
            ended=False
            while True:
                c=f.read(1)
                if not c:break
                assert not ended
                if c==b'E':
                    n,=struct.unpack('<I',f.read(4));yield 'E',json.loads(f.read(n));ended=True;continue
                assert c==b'T'
                tx_id,height,pos,flags,n_outs=struct.unpack('<QQIBI',f.read(25))
                outs=struct.unpack('<%dQ'%n_outs,f.read(8*n_outs));f.read(33)
                n,=struct.unpack('<I',f.read(4));yield 'T',(tx_id,height,pos,flags,outs,f.read(n))
            assert ended,p

native_path,out_dir,parts=sys.argv[1],Path(sys.argv[2]),sys.argv[3:]
out_dir.mkdir(parents=True,exist_ok=True)
by_hash={};items=[];out_map={};fatal=False;decisions=[];part_summaries=[];events=0
for kind,v in frames(parts):
    if kind=='E':part_summaries.append(v);continue
    tx_id,height,pos,flags,outs,blob=v
    version,ins,vout,extra,fee=parse_tx(blob)
    assert height>=FIRST and len(vout)==len(outs)
    d={'txId':tx_id,'height':height,'pos':pos,'result':'none','reason':None,'inscription':-1,'out0':outs[0],'key0':vout[0][0].hex(),'fee':fee,'field':None}
    decisions.append(d)
    fields,whole=parse_extra(extra)
    keys=[f[1] for f in fields if f[0]==0x01];more=[k for f in fields if f[0]==0x04 for k in f[1]]
    d['_owner']={'txPubKeys':[k.hex() for k in keys],'additionalPubKeys':[k.hex() for k in more],'viewTag':vout[0][1].hex() if vout[0][1] is not None else None}
    if fatal:d['reason']='index stopped';continue
    reg=next((f for f in fields if f[0]==0x10),None);upd=next((f for f in fields if f[0]==0x11),None)
    if reg is None and upd is None:d['reason']='field not reached by the parser';continue
    if reg is not None:
        d['field']='0x10'
        if not fee_ok(len(reg[1])+len(reg[2]),height,fee):d['reason']='fee below rule';continue
        h=hashlib.sha256(reg[1]).digest()
        if h in by_hash:d['reason']='same body already registered';d['duplicateOf']=by_hash[h];continue
        if outs[0] in out_map:fatal=True;d['reason']='output already mapped (index stops)';continue
        i=len(items);items.append({'index':i,'bodySha256':h.hex(),'bodySize':len(reg[1]),'height':height,'stored':outs[0],'ownerOut':outs[0],'ownerTxId':tx_id,'ownerHeight':height,'history':[outs[0]],'metaSizes':[len(reg[2])],'owner':d['_owner'],'ownerKey':d['key0']})
        by_hash[h]=i;out_map[outs[0]]=i;d['result']='registered';d['inscription']=i;continue
    d['field']='0x11'
    if not fee_ok(len(upd[1]),height,fee):d['reason']='fee below rule';continue
    d['reason']='no input with the dead-key ring'
    for offs in ins:
        total=0;dead=0;target=0
        for o in offs:
            total+=o
            if DEAD_LO<total<DEAD_HI:dead+=1
            else:target=total
        if dead!=len(offs)-1:continue
        d['from']=target
        if target not in out_map:d['reason']='spent output is not a Mordinal owner output';break
        if outs[0] in out_map:d['reason']='new output already mapped';break
        it=items[out_map[target]];it['stored']=target;it['history'].append(target);it['metaSizes'].append(len(upd[1]))
        it['ownerOut']=outs[0];it['ownerTxId']=tx_id;it['ownerHeight']=height;it['owner']=d['_owner'];it['ownerKey']=d['key0']
        out_map[outs[0]]=it['index'];events+=1;d['result']='updated';d['reason']=None;d['inscription']=it['index'];break

# Compare with the compiled original index.
ntx=[];nins=[];nend=None;nparts=[]
with open(native_path) as f:
    for line in f:
        o=json.loads(line)
        if o['t']=='tx':ntx.append(o)
        elif o['t']=='ins':nins.append(o)
        elif o['t']=='part':nparts.append(o['summary'])
        else:nend=o
assert nend and nparts==part_summaries
assert len(ntx)==len(decisions),(len(ntx),len(decisions))
mismatch=[]
for a,b in zip(ntx,decisions):
    same=all(a[k]==b[k] for k in('txId','height','pos','result','inscription','out0','key0','fee'))
    if not same:mismatch.append({'native':a,'second':{k:v for k,v in b.items() if k!='_owner'}})
    b['hash']=a['hash']
assert len(nins)==len(items),(len(nins),len(items))
for a,b in zip(nins,items):
    same=a['index']==b['index'] and a['imgSize']==b['bodySize'] and a['height']==b['height'] and a['storedGlobalOut']==b['stored'] and a['ownerOut']==b['ownerOut'] and a['ownerKey']==b['ownerKey'] and [h['g'] for h in a['history']]==b['history'] and [h['metaSize'] for h in a['history']]==b['metaSizes']
    if not same:mismatch.append({'nativeInscription':a['index']})
assert nend['fatalErrorFlag']==fatal and nend['events']==events
assert nend['lastHeight']==decisions[-1]['height']

hash_of={d['txId']:d['hash'] for d in decisions}
owners=[]
for a,b in zip(nins,items):
    owners.append({'number':b['index'],'registrationTx':a['history'][0]['tx'],'registrationHeight':b['height'],'bodySha256':b['bodySha256'],'bodyKeccak256':a['imgHash'],'bodySize':b['bodySize'],'moves':len(b['history'])-1,'ownerTx':hash_of[b['ownerTxId']],'ownerHeight':b['ownerHeight'],'ownerOutputIndex':b['ownerOut'],'ownerOutputKey':b['ownerKey'],'ownerViewTag':b['owner']['viewTag'],'ownerTxPubKeys':b['owner']['txPubKeys'],'ownerAdditionalPubKeys':b['owner']['additionalPubKeys']})
    assert a['history'][-1]['tx']==hash_of[b['ownerTxId']]
text=''.join(json.dumps(o,separators=(',',':'))+'\n' for o in owners)
(out_dir/'owners.jsonl').write_text(text)
with open(out_dir/'transfers.jsonl','w') as f:
    for d in decisions:
        if d['field']=='0x11':f.write(json.dumps({'tx':d['hash'],'height':d['height'],'result':d['result'],'reason':d['reason'],'mordinal':d['inscription'],'spentOutputIndex':d.get('from'),'newOutputIndex':d['out0'],'fee':d['fee']},separators=(',',':'))+'\n')
with open(out_dir/'ignored-registrations.jsonl','w') as f:
    for d in decisions:
        if d['result']=='none' and d['field']!='0x11':f.write(json.dumps({'tx':d['hash'],'height':d['height'],'reason':d['reason'],'duplicateOf':d.get('duplicateOf'),'fee':d['fee']},separators=(',',':'))+'\n')
def count(pred):return sum(1 for d in decisions if pred(d))
reasons={}
for d in decisions:
    if d['result']=='none':
        k=(d['field'] or 'none')+': '+d['reason'];reasons[k]=reasons.get(k,0)+1
applied=[d for d in decisions if d['result']=='updated']
summary={'firstHeight':part_summaries[0]['first'],'lastHeight':part_summaries[-1]['last'],'lastBlockHash':part_summaries[-1]['lastHash'],
 'transactionsScanned':sum(p['transactions'] for p in part_summaries),'blocksScanned':sum(p['blocks'] for p in part_summaries),
 'candidateTransactions':len(decisions),'mordinals':len(items),'registrationsIgnored':count(lambda d:d['field']=='0x10' and d['result']=='none'),
 'transferTransactions':count(lambda d:d['field']=='0x11'),'transfersApplied':len(applied),'mordinalsEverMoved':sum(1 for b in items if len(b['history'])>1),
 'lastAppliedTransferHeight':max((d['height'] for d in applied),default=None),'lastTransferFieldHeight':max((d['height'] for d in decisions if d['field']=='0x11'),default=None),
 'ignoredReasons':reasons,'indexStopFlag':fatal,'differencesFromOriginalIndex':len(mismatch),
 'ownersFile':'owners.jsonl','ownersSha256':hashlib.sha256(text.encode()).hexdigest()}
(out_dir/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
if mismatch:(out_dir/'differences.json').write_text(json.dumps(mismatch[:200],indent=2)+'\n')
print(json.dumps(summary,indent=2))
sys.exit(1 if mismatch else 0)
