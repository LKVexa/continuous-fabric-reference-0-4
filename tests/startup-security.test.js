'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {atomic}=require('../lib/common');
const python=require('../lib/python').resolvePython();
const cli=path.resolve(__dirname,'../bin/cfp.js');
function temp(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cfp-startup-security-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function run(args,env){return spawnSync(process.execPath,[cli,...args],{env:{...process.env,...env},encoding:'utf8',windowsHide:true,timeout:10000});}
test('doctor returns a failure exit code for missing pinned sources',t=>{
  const dir=temp(t);const result=run(['doctor'],{CFP_PYTHON:python,CFP_STATE_DIR:dir,CFP_SOURCE_ROOT:path.join(dir,'missing')});
  assert.equal(result.status,1,result.stderr);assert.equal(JSON.parse(result.stdout).source_root_present,false);
});
test('CLI rejects copied public TLS fixtures before starting a hub',t=>{
  const dir=temp(t),cert=path.join(dir,'operator-cert.pem'),key=path.join(dir,'operator-key.pem');
  fs.copyFileSync(path.join(__dirname,'fixtures/test-only-cert.pem'),cert);fs.copyFileSync(path.join(__dirname,'fixtures/test-only-key.pem'),key);
  atomic(path.join(dir,'hub.json'),{python,stateDir:dir,principalsFile:path.join(dir,'principals.json'),agentsFile:path.join(dir,'agents.json'),host:'127.0.0.1',port:0,tls:{cert,key}});
  const result=run(['start'],{CFP_PYTHON:python,CFP_STATE_DIR:dir});
  assert.equal(result.status,1,result.stderr);assert.match(result.stderr,/TLS_TEST_FIXTURE_REFUSED/);
  assert.equal(fs.existsSync(path.join(dir,'hub.lock')),false);
});
