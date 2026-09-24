#!/usr/bin/env node
'use strict';
// Release gate: syntax-check every JavaScript file, verify the derived HERMIT provenance, and verify FILES.sha256.
// Exit 0 only when all three pass. Run before `node --test`.
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {ROOT,sha}=require('../lib/common');
const SKIP=new Set(['node_modules','.state','.git','__pycache__']);
function walk(dir,out=[]){for(const e of fs.readdirSync(dir,{withFileTypes:true})){if(SKIP.has(e.name))continue;const p=path.join(dir,e.name);if(e.isDirectory())walk(p,out);else out.push(p);}return out;}
const files=walk(ROOT);
let syntaxFailures=0;
for(const f of files.filter(f=>f.endsWith('.js'))){
  const r=spawnSync(process.execPath,['--check',f],{encoding:'utf8'});
  if(r.status!==0){syntaxFailures++;console.error('SYNTAX: '+path.relative(ROOT,f)+'\n'+r.stderr.trim());}
}
const provenance=spawnSync(process.execPath,[path.join(ROOT,'tools/verify.js')],{encoding:'utf8'});
let manifestFailures=0,manifestEntries=0,manifestMissing=0;
const manifestFile=path.join(ROOT,'FILES.sha256');
if(fs.existsSync(manifestFile)){
  const listed=new Set();
  for(const line of fs.readFileSync(manifestFile,'utf8').split('\n').filter(Boolean)){
    const m=/^([a-f0-9]{64})  (.+)$/.exec(line);if(!m){manifestFailures++;console.error('MANIFEST: unparsable line: '+line);continue;}
    manifestEntries++;listed.add(m[2]);const p=path.join(ROOT,m[2]);
    if(!fs.existsSync(p)||sha(fs.readFileSync(p))!==m[1]){manifestFailures++;console.error('MANIFEST: mismatch or missing: '+m[2]);}
  }
  for(const f of files){const rel=path.relative(ROOT,f).split(path.sep).join('/');if(rel!=='FILES.sha256'&&!listed.has(rel)){manifestMissing++;console.error('MANIFEST: unlisted file: '+rel);}}
} else {manifestFailures++;console.error('MANIFEST: FILES.sha256 missing');}
const ok=syntaxFailures===0&&provenance.status===0&&manifestFailures===0&&manifestMissing===0;
console.log(JSON.stringify({javascriptFiles:files.filter(f=>f.endsWith('.js')).length,syntaxFailures,provenance:provenance.stdout.trim(),manifestEntries,manifestFailures,unlistedFiles:manifestMissing,ok}));
process.exitCode=ok?0:1;
