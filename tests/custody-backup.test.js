'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {copyTree,restoreTree}=require('../lib/backup');
const custody=require('../lib/custody');
const attestation=require('../lib/attestation');
const {atomic,token,sha}=require('../lib/common');
const {createHub}=require('../lib/hub');
const {startAgent}=require('../lib/agent');
function temp(t){const p=fs.mkdtempSync(path.join(os.tmpdir(),'cfp-custody-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;}
async function until(fn){const end=Date.now()+6000;while(Date.now()<end){if(fn())return;await new Promise(resolve=>setTimeout(resolve,25));}throw new Error('condition timed out');}

test('explicit missing master-key file cannot silently downgrade to plaintext',t=>{
  const original=process.env.CFP_MASTER_KEY;delete process.env.CFP_MASTER_KEY;
  t.after(()=>{if(original!==undefined)process.env.CFP_MASTER_KEY=original;});
  assert.throws(()=>custody.loadMasterKey({keyFile:path.join(temp(t),'missing.key')}),/MASTER_KEY_FILE_MISSING/);
});
test('master-key creation cannot overwrite an existing recovery key',t=>{
  const file=path.join(temp(t),'master.key');custody.writeMasterKeyFile(file,'a'.repeat(64));
  assert.throws(()=>custody.writeMasterKeyFile(file,'b'.repeat(64)),/EEXIST/);
  assert.equal(fs.readFileSync(file,'utf8').trim(),'a'.repeat(64));
});
test('failed plaintext custody serialization removes temporary secret files',t=>{
  const dir=temp(t),value={};value.loop=value;
  assert.throws(()=>custody.writeSecret(path.join(dir,'secret.json'),value,{key:null,requireEnc:false}));
  assert.deepEqual(fs.readdirSync(dir),[]);
});
test('backup rejects a destination inside the source before creating recursive copies',t=>{
  const src=temp(t);fs.writeFileSync(path.join(src,'important'),'preserve');
  assert.throws(()=>copyTree(src,path.join(src,'backup')),/BACKUP_PATH_OVERLAP/);
  assert.deepEqual(fs.readdirSync(src),['important']);
});
test('restore rejects identical and nested source paths before moving existing state',t=>{
  const root=temp(t),inside=path.join(root,'backup');fs.mkdirSync(inside);fs.writeFileSync(path.join(root,'important'),'preserve');
  assert.throws(()=>restoreTree(root,root),/BACKUP_PATH_OVERLAP/);
  assert.throws(()=>restoreTree(inside,root),/BACKUP_PATH_OVERLAP/);
  assert.equal(fs.readFileSync(path.join(root,'important'),'utf8'),'preserve');
});
test('restore refuses a locked destination and preserves both copies',t=>{
  const root=temp(t),src=path.join(root,'backup'),dest=path.join(root,'live');fs.mkdirSync(src);fs.mkdirSync(dest);
  fs.writeFileSync(path.join(src,'new'),'backup');fs.writeFileSync(path.join(dest,'hub.lock'),'123');
  assert.throws(()=>restoreTree(src,dest),/RESTORE_DEST_LOCKED/);
  assert.equal(fs.readFileSync(path.join(src,'new'),'utf8'),'backup');assert.ok(fs.existsSync(path.join(dest,'hub.lock')));
});
test('restore stages replacement and preserves previous state in a recovery sibling',t=>{
  const root=temp(t),src=path.join(root,'backup'),dest=path.join(root,'live');fs.mkdirSync(src);fs.mkdirSync(dest);
  fs.writeFileSync(path.join(src,'new'),'backup');fs.writeFileSync(path.join(dest,'old'),'current');
  const result=restoreTree(src,dest);
  assert.equal(fs.readFileSync(path.join(dest,'new'),'utf8'),'backup');
  assert.equal(fs.readFileSync(path.join(result.previous,'old'),'utf8'),'current');
  assert.equal(fs.readdirSync(root).some(name=>name.startsWith('live.restore-')),false);
});
test('attestation expires at the exact deadline',()=>{
  const pair=attestation.generateKeyPair();const proof=attestation.createSoftwareAttestation({nodeId:'node',operations:['echo'],privateKeyPem:pair.privateKeyPem,clock:()=>1000,ttlMs:1000});
  assert.throws(()=>attestation.verifySoftwareAttestation(proof,{publicKeyPem:pair.publicKeyPem,clock:()=>2000}),/ATTESTATION_EXPIRED/);
});
test('hub binds registered operations to the signed attestation and expires active sessions',async t=>{
  const dir=temp(t),pair=attestation.generateKeyPair(),secret=token();attestation.writeKeyPairFiles(dir,pair);
  const principalsFile=path.join(dir,'principals.json'),agentsFile=path.join(dir,'agents.json');
  atomic(principalsFile,[]);atomic(agentsFile,[{id:'node',tenant:'fabric',site:'local',tokenSha256:sha(secret),operations:['echo','sha256']}]);
  const hub=await createHub({stateDir:dir,python:process.env.CFP_PYTHON,port:0,principalsFile,agentsFile,requireAttestation:true});
  t.after(()=>hub.stop());
  const proof=attestation.createSoftwareAttestation({nodeId:'node',operations:['echo'],privateKeyPem:pair.privateKeyPem,ttlMs:1000});
  const common={url:`ws://127.0.0.1:${hub.port}/ws/agent`,token:secret,softwareAttestation:proof};
  const states=[];const rejected=startAgent({...common,operations:['sha256'],stateFile:path.join(dir,'bad.json')},{onState:s=>states.push(s)});
  try {await until(()=>states.includes('disconnected'));assert.equal(hub.fabric.peers.size,0);} finally {await rejected.stop();}
  const accepted=startAgent({...common,operations:['echo'],stateFile:path.join(dir,'good.json')});
  try {await until(()=>hub.fabric.peers.size===1);await until(()=>hub.fabric.peers.size===0);} finally {await accepted.stop();}
});
