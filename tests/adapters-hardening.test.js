'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {adapter}=require('../lib/common');
const python=process.env.CFP_PYTHON||(process.platform==='win32'?'python':'python3');

function temp(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cfp-adapter-hardening-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}

test('adapter ignores Python startup hooks injected through PYTHONPATH',async t=>{
  const dir=temp(t),marker=path.join(dir,'startup-executed');
  fs.writeFileSync(path.join(dir,'sitecustomize.py'),`from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text('executed')\n`);
  const previous=process.env.PYTHONPATH;process.env.PYTHONPATH=dir;
  t.after(()=>{if(previous===undefined)delete process.env.PYTHONPATH;else process.env.PYTHONPATH=previous;});
  const result=await adapter(python,'doctor',{},path.join(dir,'absent-sources'));
  assert.ok(Object.values(result.bindings).every(value=>value==='SOURCE_ROOT_MISSING'));
  assert.equal(fs.existsSync(marker),false);
});

test('bound source paths cannot escape the configured source root',t=>{
  const dir=temp(t),sourceRoot=path.join(dir,'sources');fs.mkdirSync(sourceRoot);
  const outside=path.join(dir,'outside.py');fs.writeFileSync(outside,'raise RuntimeError("must not import")\n');
  const adapterFile=path.resolve(__dirname,'../lib/adapters.py');
  const code=`import runpy, hashlib\nfrom pathlib import Path\nm = runpy.run_path(${JSON.stringify(adapterFile)})\nr = m['LOCK']['files']['scheduler']\nr['path'] = '../outside.py'\nr['sha256'] = hashlib.sha256(Path(${JSON.stringify(outside)}).read_bytes()).hexdigest()\ntry:\n    m['checked']('scheduler')\nexcept ValueError as error:\n    assert str(error).startswith('SOURCE_PATH_'), str(error)\nelse:\n    raise AssertionError('escaped the source root')\n`;
  const result=spawnSync(python,['-I','-B','-c',code],{env:{...process.env,CFP_SOURCE_ROOT:sourceRoot},encoding:'utf8',windowsHide:true,timeout:10000});
  assert.equal(result.status,0,result.stderr);
});
