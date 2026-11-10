"""Read-only scan of a Monero node's transaction table for Mordinals records.

Streamed over SSH into a low-priority Python process on the node host. Writes no
remote files and calls only read-only daemon endpoints. Reads the node database
without taking its lock, in short batches; a batch is accepted only when both
database metadata pages are byte-identical before and after it was read.

Selects every non-coinbase transaction whose tx_extra reaches a 0x10 or 0x11 field
at a field boundary (a superset of what the original indexer acts on) and writes
its pruned bytes, output indexes and prunable hash to stdout as binary frames.
Progress goes to stderr as JSON lines.

Arguments: FIRST_HEIGHT LAST_HEIGHT(0 = tip-10) [RESUME_COINBASE_TX_ID]
"""
import sys,json,struct,time,hashlib,urllib.request,ctypes as C,ctypes.util
FIRST=int(sys.argv[1]);LAST=int(sys.argv[2]);RESUME=int(sys.argv[3]) if len(sys.argv)>3 else None
DB=b'/var/lib/monero/lmdb';URL='http://127.0.0.1:18081/json_rpc';BATCH=20000
out=sys.stdout.buffer
def log(kind,**kw):print(json.dumps({'kind':kind,**kw}),file=sys.stderr,flush=True)
def rpc(method,params={}):
    req=urllib.request.Request(URL,data=json.dumps({'jsonrpc':'2.0','id':'0','method':method,'params':params}).encode(),headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(req,timeout=60) as r:r=json.load(r)
    if 'error' in r:raise RuntimeError(r['error'])
    return r['result']
info=rpc('get_info');assert info['mainnet'] is True and info['synchronized'] is True
if LAST==0:LAST=info['height']-1-10
endhash=rpc('get_block_header_by_height',{'height':LAST})['block_header']['hash']
log('start',first=FIRST,last=LAST,lastHash=endhash,node=info['version'],tip=info['height']-1)

lib=C.CDLL(ctypes.util.find_library('lmdb'))
class Val(C.Structure):_fields_=[('size',C.c_size_t),('data',C.c_void_p)]
P=C.c_void_p;U=C.c_uint
for name,args,ret in [('mdb_env_create',[C.POINTER(P)],C.c_int),('mdb_env_set_maxdbs',[P,U],C.c_int),('mdb_env_open',[P,C.c_char_p,U,U],C.c_int),('mdb_txn_begin',[P,P,U,C.POINTER(P)],C.c_int),('mdb_dbi_open',[P,C.c_char_p,U,C.POINTER(U)],C.c_int),('mdb_cursor_open',[P,U,C.POINTER(P)],C.c_int),('mdb_cursor_get',[P,C.POINTER(Val),C.POINTER(Val),U],C.c_int),('mdb_get',[P,U,C.POINTER(Val),C.POINTER(Val)],C.c_int),('mdb_cursor_close',[P],None),('mdb_txn_abort',[P],None),('mdb_env_close',[P],None)]:
    fn=getattr(lib,name);fn.argtypes=args;fn.restype=ret
lib.mdb_strerror.argtypes=[C.c_int];lib.mdb_strerror.restype=C.c_char_p
def ok(n):
    if n:raise RuntimeError(lib.mdb_strerror(n).decode())
def metadata():
    with open(DB+b'/data.mdb','rb',buffering=0) as f:return f.read(8192)
env=P();ok(lib.mdb_env_create(C.byref(env)));ok(lib.mdb_env_set_maxdbs(env,40))
ok(lib.mdb_env_open(env,DB,0x20000|0x200000|0x400000,0))   # RDONLY | NOTLS | NOLOCK
string_at=C.string_at;cget=lib.mdb_cursor_get
NOTFOUND=-30798
retries=0
def snapshot(fn):
    """Run fn(txn) in a fresh read snapshot; accept only if no commit happened meanwhile."""
    global retries
    while True:
        before=metadata();txn=P();ok(lib.mdb_txn_begin(env,None,0x20000,C.byref(txn)))
        try:result=fn(txn)
        finally:lib.mdb_txn_abort(txn)
        if metadata()==before:return result
        retries+=1
def read_rows(first_id,count):
    def fn(txn):
        dbi=U();cur=P();ok(lib.mdb_dbi_open(txn,b'txs_pruned',0,C.byref(dbi)));ok(lib.mdb_cursor_open(txn,dbi,C.byref(cur)))
        try:
            kb=C.create_string_buffer(struct.pack('<Q',first_id));key=Val(8,C.cast(kb,P));val=Val()
            rc=cget(cur,C.byref(key),C.byref(val),17);rows=[]   # MDB_SET_RANGE
            while rc==0 and len(rows)<count:
                rows.append((struct.unpack('<Q',string_at(key.data,8))[0],string_at(val.data,val.size)))
                rc=cget(cur,C.byref(key),C.byref(val),8)       # MDB_NEXT
            if rc not in(0,NOTFOUND):ok(rc)
            return rows
        finally:lib.mdb_cursor_close(cur)
    return snapshot(fn)
def lookup(table,tx_id):
    def fn(txn):
        dbi=U();ok(lib.mdb_dbi_open(txn,table,0,C.byref(dbi)))
        kb=C.create_string_buffer(struct.pack('<Q',tx_id));key=Val(8,C.cast(kb,P));val=Val()
        rc=lib.mdb_get(txn,dbi,C.byref(key),C.byref(val))
        if rc==NOTFOUND:return None
        ok(rc);return string_at(val.data,val.size)
    return snapshot(fn)
def last_id():
    def fn(txn):
        dbi=U();cur=P();ok(lib.mdb_dbi_open(txn,b'txs_pruned',0,C.byref(dbi)));ok(lib.mdb_cursor_open(txn,dbi,C.byref(cur)))
        try:
            key=Val();val=Val();ok(cget(cur,C.byref(key),C.byref(val),6));return struct.unpack('<Q',string_at(key.data,8))[0]
        finally:lib.mdb_cursor_close(cur)
    return snapshot(fn)

def varint(b,i):
    r=0;s=0
    while True:
        c=b[i];i+=1;r|=(c&127)<<s
        if c<128:return r,i
        s+=7
def parse(b):
    """Returns ('cb',height) for a coinbase, else ('tx',extra_bytes)."""
    i=0
    while b[i]>127:i+=1
    i+=1
    while b[i]>127:i+=1
    i+=1
    nin,i=varint(b,i)
    if nin and b[i]==0xff:
        h,i=varint(b,i+1);return 'cb',h
    for _ in range(nin):
        if b[i]!=2:raise ValueError('input type %d'%b[i])
        i+=1
        while b[i]>127:i+=1
        i+=1
        n,i=varint(b,i)
        for _ in range(n):
            while b[i]>127:i+=1
            i+=1
        i+=32
    nout,i=varint(b,i)
    for _ in range(nout):
        while b[i]>127:i+=1
        i+=1
        t=b[i]
        if t==2:i+=33
        elif t==3:i+=34
        else:raise ValueError('output type %d'%t)
    n,i=varint(b,i)
    if i+n>len(b):raise ValueError('extra past end')
    return 'tx',b[i:i+n]
def flags(e):
    """Walk tx_extra fields the way the original parser does, leniently. bit0: 0x10 seen, bit1: 0x11 seen."""
    i=0;n=len(e);f=0
    try:
        while i<n:
            t=e[i];i+=1
            if t==1:i+=32
            elif t==2 or t==3 or t==0xde:l,i=varint(e,i);i+=l
            elif t==4:c,i=varint(e,i);i+=32*c
            elif t==0x10:
                f|=1;l,i=varint(e,i);i+=l;l,i=varint(e,i);i+=l
            elif t==0x11:f|=2;l,i=varint(e,i);i+=l
            elif t==0x12:l,i=varint(e,i);i+=l+48
            elif t==0x13:i+=32;l,i=varint(e,i);i+=l+32
            else:break
    except IndexError:pass
    return f

def next_coinbase(tx_id):
    while True:
        rows=read_rows(tx_id,64)
        if not rows:return None
        for k,b in rows:
            r=parse(b)
            if r[0]=='cb':return r[1],k
        tx_id=rows[-1][0]+1
top=last_id()
if RESUME is None:
    lo,hi=0,top
    while lo<hi:
        mid=(lo+hi)//2;r=next_coinbase(mid)
        if r is None or r[0]>=FIRST:hi=mid
        else:lo=r[1]+1
    h,start_id=next_coinbase(lo);assert h==FIRST,(h,FIRST)
else:
    start_id=RESUME;r=parse(read_rows(start_id,1)[0][1]);assert r[0]=='cb' and r[1]>=FIRST
log('located',startTxId=start_id,topTxId=top)

t0=time.time();nid=start_id;height=None;pos=0;scanned=0;blocks=0;cands=0;reg=0;upd=0;done=False;lastcb=start_id;bytes_out=0;next_log=t0+20
while not done:
    rows=read_rows(nid,BATCH)
    if not rows:break
    for k,b in rows:
        assert k==nid,(k,nid);nid+=1
        r=parse(b)
        if r[0]=='cb':
            if r[1]>LAST:done=True;break
            assert height is None or r[1]==height+1,(height,r[1])
            height=r[1];pos=0;blocks+=1;lastcb=k;continue
        scanned+=1;f=flags(r[1])
        if f:
            outs=lookup(b'tx_outputs',k) or b'';ph=lookup(b'txs_prunable_hash',k)
            frame=b'T'+struct.pack('<QQIBI',k,height,pos,f,len(outs)//8)+outs+(b'\x01'+ph if ph else b'\x00'+bytes(32))+struct.pack('<I',len(b))+b
            out.write(frame);bytes_out+=len(frame);cands+=1;reg+=f&1;upd+=(f>>1)&1
        pos+=1
    if time.time()>next_log:
        out.flush();next_log=time.time()+20
        log('progress',height=height,nextTxId=nid,lastCoinbaseTxId=lastcb,scanned=scanned,blocks=blocks,candidates=cands,with10=reg,with11=upd,bytesOut=bytes_out,retries=retries,seconds=round(time.time()-t0,1))
assert height==LAST,(height,LAST)
assert rpc('get_block_header_by_height',{'height':LAST})['block_header']['hash']==endhash
summary={'kind':'complete','first':FIRST,'last':LAST,'lastHash':endhash,'startTxId':start_id,'endTxId':nid,'transactions':scanned,'blocks':blocks,'candidates':cands,'with10':reg,'with11':upd,'bytesOut':bytes_out,'snapshotRetries':retries,'seconds':round(time.time()-t0,1)}
j=json.dumps(summary).encode();out.write(b'E'+struct.pack('<I',len(j))+j);out.flush()
lib.mdb_env_close(env);log(**summary)
