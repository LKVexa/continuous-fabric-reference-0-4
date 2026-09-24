'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {ROOT,sha}=require('../lib/common');
const manifest=require('../catalog/hermit-provenance.json');
let failures=0;
for(const rec of manifest.files) {
  const file=path.join(ROOT,rec.destination);
  if(!fs.existsSync(file)||sha(fs.readFileSync(file))!==rec.derived_sha256){console.error('MISMATCH: '+rec.destination);failures++;}
}
console.log(JSON.stringify({hermitFiles:manifest.files.length,failures,scope:'derived hosted runtime; not upstream release certification'}));
process.exitCode=failures?1:0;
