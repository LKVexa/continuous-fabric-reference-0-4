"""Bounded JSON adapter. Donor code is hashed before import; source trees stay read only."""
import hashlib, importlib.util, json, os, sys
from pathlib import Path
sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
LOCK = json.loads((ROOT/'catalog/bindings.json').read_text(encoding='utf-8'))
_ROOT_ENV = os.environ.get('CFP_SOURCE_ROOT')

def _windows_abs(s):
    s=str(s); return len(s)>=3 and s[0].isalpha() and s[1]==':' and s[2] in '\\/'

def _posix_abs(s):
    return str(s).startswith('/')

# Catalogued foreign-OS absolute roots must not be resolve()'d into a package-relative junk path.
_raw = _ROOT_ENV if _ROOT_ENV else LOCK['source_root']
SOURCE_ROOT_PROBLEM = None
if not _ROOT_ENV and os.name != 'nt' and _windows_abs(LOCK['source_root']):
    SOURCE = Path(str(LOCK['source_root']))
    SOURCE_ROOT_PROBLEM = 'SOURCE_ROOT_MISSING: ' + str(LOCK['source_root']) + ' (set CFP_SOURCE_ROOT to the pinned source tree)'
elif not _ROOT_ENV and os.name == 'nt' and _posix_abs(LOCK['source_root']) and not _windows_abs(LOCK['source_root']):
    SOURCE = Path(str(LOCK['source_root']))
    SOURCE_ROOT_PROBLEM = 'SOURCE_ROOT_MISSING: ' + str(LOCK['source_root']) + ' (set CFP_SOURCE_ROOT to the pinned source tree)'
else:
    SOURCE = (ROOT / _raw).resolve()
    if not SOURCE.is_dir():
        SOURCE_ROOT_PROBLEM = 'SOURCE_ROOT_MISSING: ' + str(SOURCE) + ' (set CFP_SOURCE_ROOT to the pinned source tree)'

def checked(key):
    if SOURCE_ROOT_PROBLEM: raise ValueError(SOURCE_ROOT_PROBLEM)
    rec=LOCK['files'][key]
    rel=rec['path']
    if not isinstance(rel, str) or not rel or rel.startswith(('/', '\\')) or '..' in Path(rel).parts:
        raise ValueError('SOURCE_PATH_REFUSED: '+key)
    p=(SOURCE/rel).resolve()
    try: p.relative_to(SOURCE)
    except ValueError: raise ValueError('SOURCE_PATH_ESCAPE: '+key)
    if not p.is_file(): raise ValueError('SOURCE_FILE_MISSING: '+key)
    if hashlib.sha256(p.read_bytes()).hexdigest()!=rec['sha256']:
        raise ValueError('SOURCE_DIGEST_MISMATCH: '+key)
    return p

def pinned_paths():
    return {(SOURCE/rec['path']).resolve() for rec in LOCK['files'].values()}

def assert_only_pinned_loaded(prefix):
    """After importing a donor package, refuse if any module under the donor tree was loaded from an unpinned file."""
    allowed=pinned_paths(); root=(SOURCE/prefix).resolve()
    for name,mod in list(sys.modules.items()):
        f=getattr(mod,'__file__',None)
        if not f: continue
        fp=Path(f).resolve()
        try: fp.relative_to(root)
        except ValueError: continue
        if fp not in allowed: raise ValueError('UNPINNED_DONOR_MODULE: '+name)

def module(key):
    p=checked(key); name='cfp_bound_'+key
    spec=importlib.util.spec_from_file_location(name,p)
    mod=importlib.util.module_from_spec(spec);sys.modules[name]=mod;spec.loader.exec_module(mod)
    return mod

def dispatch(req):
    if not isinstance(req, dict): raise ValueError('BAD_REQUEST')
    op=req.get('op'); data=req.get('data',{})
    if not isinstance(op, str) or not op: raise ValueError('BAD_OP')
    if data is None: data={}
    if not isinstance(data, dict): raise ValueError('BAD_DATA')
    if op=='doctor':
        result={}
        for key in LOCK['files']:
            try: checked(key);result[key]='HASH_MATCH'
            except ValueError as e: result[key]='SOURCE_ROOT_MISSING' if str(e).startswith('SOURCE_ROOT_MISSING') else ('MISSING' if str(e).startswith('SOURCE_FILE_MISSING') else 'CHANGED')
            except OSError: result[key]='UNREADABLE'
        return {'bindings':result,'source_root':str(SOURCE),'source_root_present':SOURCE_ROOT_PROBLEM is None,
                'python':sys.version.split()[0],
                'full_model_mission':'BLOCKED: standalone _model lacks MODEL_CONFIG.json and mission/bootstrap.py at its expected parent',
                'promotion':'NO_PRODUCTION_CLAIM'}
    if op=='place':
        if not isinstance(data.get('nodes'),list) or len(data['nodes'])>64: raise ValueError('node count')
        # Digest/root checks run before shape details so missing donors stay SOURCE_* errors.
        m=module('scheduler')
        wl=data.get('workload')
        if not isinstance(wl, dict) or not isinstance(wl.get('needs'), list) or len(wl['needs'])>16: raise ValueError('workload shape')
        w=m.Workload(**{**wl,'needs':frozenset(wl['needs'])})
        ns=[m.NodeReport(**{**n,'tiers':frozenset(n['tiers']),'capabilities':frozenset(n['capabilities'])}) for n in data['nodes']]
        try:return m.place(w,ns,now=data['now'],lease_ticks=30)
        except m.Unplaceable as e:return {'refused':e.as_dict()}
    if op=='model.evaluate':
        for key in LOCK['files']:
            if key.startswith('model/'):checked(key)
        if not isinstance(data.get('rows'),list) or len(data['rows'])>512: raise ValueError('row count')
        sys.path.insert(0,str(SOURCE/'_model'))
        from reasoning_center.evaluation import evaluate
        assert_only_pinned_loaded('_model')
        return evaluate(data['rows'],data.get('metric','exact'))
    if op=='state.merge':
        m=module('replication')
        if not isinstance(data.get('writes'),list) or len(data['writes'])>128:raise ValueError('write count')
        if not isinstance(data.get('replicas'),list) or len(data['replicas'])>32 or not isinstance(data.get('key'),str):raise ValueError('merge shape')
        state=m.ReplicatedKey(data['key'],frozenset(data['replicas']))
        for w in data['writes']:
            state.apply(m.Write(key=data['key'],value=w['value'],site=w['site'],vector=tuple(w['vector'].items())))
        conflicts=state.conflict_set()
        return {'schema':'CFP_CAUSAL_PREVIEW/1','conflicts':conflicts,'value':state.value() if conflicts['total_unresolved']==1 else None,
                'scope':'pure causal merge computation, no replication transport or persistent application state'}
    raise ValueError('unknown adapter')

if __name__=='__main__':
    try:
        raw=sys.stdin.buffer.read(131073)
        if len(raw)>131072:raise ValueError('input limit')
        result=dispatch(json.loads(raw))
        print(json.dumps({'ok':True,'result':result},allow_nan=False))
    except Exception as e:
        print(json.dumps({'ok':False,'error':type(e).__name__+': '+str(e)[:300]}))
        sys.exit(1)
