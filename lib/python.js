'use strict';
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawnSync}=require('node:child_process');
const PROBE='import json,sys; print(json.dumps({"executable":sys.executable,"version":list(sys.version_info[:3])}))';

function selectPython(candidates,{run=spawnSync,exists=fs.existsSync}={}) {
  const failures=[];
  for(const {command,prefix=[]} of candidates) {
    const r=run(command,[...prefix,'-I','-c',PROBE],{encoding:'utf8',windowsHide:true,timeout:4000,maxBuffer:8192});
    const detail=r.error?r.error.code:r.signal?`signal ${r.signal}`:`exit ${r.status}`;
    if(!r.error&&r.status===0) {
      try {
        const p=JSON.parse(r.stdout);
        if(p.version?.[0]===3&&Number.isInteger(p.version[1])&&p.version[1]>=10&&typeof p.executable==='string'&&path.isAbsolute(p.executable)&&exists(p.executable))return p.executable;
      } catch { /* aliases and banner text are not working interpreters */ }
    }
    failures.push(`${command}: ${detail}${r.stderr?.trim()?' — '+r.stderr.trim().slice(0,400):''}`);
  }
  throw new Error('PYTHON_UNAVAILABLE: a working Python 3.10+ interpreter is required. Set CFP_PYTHON to its full executable path.\n'+failures.join('\n'));
}

function resolvePython(configured) {
  const explicit=process.env.CFP_PYTHON;
  if(explicit)return selectPython([{command:explicit}]);
  const candidates=[];
  if(configured)candidates.push({command:configured});
  // Probe rather than trust PATH: Windows App Execution Aliases may exit without JSON.
  if(process.platform==='win32')candidates.push({command:'py',prefix:['-3']},{command:'python'},{command:'python3'});
  else candidates.push({command:'python3'},{command:'python'});
  const executable=process.platform==='win32'?'python.exe':'bin/python3';
  const bundled=path.join(os.homedir(),'.cache','codex-runtimes','codex-primary-runtime','dependencies','python',executable);
  if(fs.existsSync(bundled))candidates.push({command:bundled});
  const seen=new Set();
  return selectPython(candidates.filter(c=>{const k=JSON.stringify(c);if(seen.has(k))return false;seen.add(k);return true;}));
}
module.exports={resolvePython,selectPython};
