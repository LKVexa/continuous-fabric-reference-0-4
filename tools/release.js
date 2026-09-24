#!/usr/bin/env node
'use strict';
// Regenerates FILES.sha256 over every distributable file (state, caches and the manifest itself excluded).
// Sorted, `sha256sum -c` compatible. Run after any source or documentation change, before packaging.
const fs=require('node:fs');
const path=require('node:path');
const {ROOT,sha}=require('../lib/common');
const SKIP=new Set(['node_modules','.state','.git','__pycache__']);
function walk(dir,out=[]){for(const e of fs.readdirSync(dir,{withFileTypes:true})){if(SKIP.has(e.name))continue;const p=path.join(dir,e.name);if(e.isDirectory())walk(p,out);else out.push(p);}return out;}
const lines=walk(ROOT).map(f=>path.relative(ROOT,f).split(path.sep).join('/')).filter(r=>r!=='FILES.sha256'&&!r.endsWith('.log')&&!r.endsWith('.pyc')).sort()
  .map(r=>sha(fs.readFileSync(path.join(ROOT,r)))+'  '+r);
fs.writeFileSync(path.join(ROOT,'FILES.sha256'),lines.join('\n')+'\n');
console.log(JSON.stringify({files:lines.length,manifest:'FILES.sha256'}));
