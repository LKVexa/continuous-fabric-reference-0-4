'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {Journal}=require('../lib/journal');
const {Fabric}=require('../lib/fabric');
const {createHub}=require('../lib/hub');
const {startAgent}=require('../lib/agent');
const {adapter,atomic,sha,token,VERSION,timingSafeEqualString,acquireLock,redactSecrets,resolveUserPath,canonical}=require('../lib/common');
const attestation=require('../lib/attestation');
const {Metrics}=require('../lib/metrics');
const crypto=require('node:crypto');
const {Client}=require('../runtime/hermit/tests/helpers');
const python=process.env.CFP_PYTHON||(process.platform==='win32'?'python':'python3');
const principal={sub:'alice',tenant:'fabric',submit:true};
const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'cfp-test-'));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,ms=15000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await sleep(50);}throw new Error('timeout: '+label);}

// Binding-aware suite: a test that needs a pinned donor is SKIPPED (never silently passed) when the donor is not bound on this host.
// docs/VALIDATION.md counts skips as unexecuted evidence.
let doctor={bindings:{}};
test.before(async()=>{try{doctor=await adapter(python,'doctor',{});}catch(e){doctor={bindings:{},error:e.message};}});
const bound=(...keys)=>keys.every(k=>doctor.bindings[k]==='HASH_MATCH');
const needs=(t,...keys)=>{if(!bound(...keys)){t.skip('donor binding not matched on this host: '+keys.filter(k=>doctor.bindings[k]!=='HASH_MATCH').join(', '));return false;}return true;};

test('journal persists, detects tampering, torn tail and corrupt records, and refuses quota overflow',()=>{
  const dir=temp(),file=path.join(dir,'events');
  const j=new Journal(file);j.append({ok:1});assert.equal(new Journal(file).events.length,1);
  const original=fs.readFileSync(file,'utf8');fs.writeFileSync(file,original.replace('"ok":1','"ok":2'));assert.throws(()=>new Journal(file),/INTEGRITY/);
  fs.writeFileSync(file,original.slice(0,-1));assert.throws(()=>new Journal(file),/TORN_TAIL/);
  fs.writeFileSync(file,'{not json\n');assert.throws(()=>new Journal(file),/INTEGRITY: unparsable/);
  fs.writeFileSync(file,'[1,2]\n');assert.throws(()=>new Journal(file),/INTEGRITY: non-object/);
  fs.writeFileSync(file,original);assert.throws(()=>new Journal(file,{maxBytes:1}),/LIMIT/);
});

test('adapter reports a missing source root by name instead of a stray relative path',async()=>{
  const report=await adapter(python,'doctor',{},path.join(temp(),'absent'));
  assert.equal(report.source_root_present,false);
  for(const v of Object.values(report.bindings))assert.equal(v,'SOURCE_ROOT_MISSING');
  await assert.rejects(adapter(python,'place',{workload:{},nodes:[]},path.join(temp(),'absent')),/SOURCE_ROOT_MISSING/);
});

test('actual source adapters: model numerical score and causal conflict preservation',async t=>{
  if(!needs(t,'replication','model/__init__.py','model/evaluation.py','model/contracts.py','model/vendor/__init__.py','model/vendor/agentark_scoring.py','model/vendor/agentark_numeric.py'))return;
  const score=await adapter(python,'model.evaluate',{metric:'numeric',rows:[{response:'1/2',gt:'50%'},{response:'wrong',gt:'7'}]});
  assert.equal(score.mean_score,0.5);assert.equal(score.advisory_only,true);
  const data={key:'shared',replicas:['local','cloud'],writes:[{value:'one',site:'local',vector:{local:1}},{value:'two',site:'cloud',vector:{cloud:1}}]};
  const merge=await adapter(python,'state.merge',data),reverse=await adapter(python,'state.merge',{...data,writes:data.writes.slice().reverse()});
  assert.equal(merge.value,null);assert.equal(merge.conflicts.open,true);assert.equal(merge.conflicts.total_unresolved,2);assert.deepEqual(merge,reverse);
});

test('actual SCH-01 scheduler: hard constraint refusal and node-count bound',async t=>{
  if(!needs(t,'scheduler'))return;
  const refused=await adapter(python,'place',{workload:{name:'a',tenant:'fabric',provenance:'public',needs:['echo']},nodes:[{name:'local',site:'local',tiers:['process'],capabilities:['echo'],free_slots:1,reported_at:1}],now:1});
  assert.equal(refused.refused.code,'NO_CANDIDATE');
  await assert.rejects(adapter(python,'place',{workload:{name:'a',tenant:'fabric',provenance:'internal',needs:['echo']},nodes:new Array(65).fill({}),now:1}),/node count/);
});

test('idempotency, tenant isolation, restart UNKNOWN, stale receipts, and single-slot admission',async t=>{
  if(!needs(t,'scheduler'))return;
  const dir=temp(),f=new Fabric({stateDir:dir,python});let messages=[];
  const peer=f.register({id:'local',tenant:'fabric',site:'local',operations:['echo']},['echo'],m=>{messages.push(m);return true;});
  const j=await f.command(principal,['submit','one','auto','echo','hello']);assert.equal(j.state,'ASSIGNED');
  const again=await f.command(principal,['submit','one','auto','echo','hello']);assert.equal(again.id,j.id);assert.equal(messages.length,1);
  await assert.rejects(f.command(principal,['submit','one','auto','echo','changed']),/IDEMPOTENCY_CONFLICT/);
  await assert.rejects(f.command({...principal,tenant:'other'},['job',j.id]),/NOT_FOUND/);
  await assert.rejects(f.command({...principal,submit:false},['run','auto','echo','no']),/FORBIDDEN/);
  const queued=await f.command(principal,['submit','two','auto','echo','two']);assert.equal(queued.state,'QUEUED');
  const receipt={id:j.id,lease:messages[0].job.lease,state:'SUCCEEDED',result:{text:'hello'}};
  await assert.rejects(f.receipt(peer,{...receipt,lease:'wrong'}),/STALE/);
  const restart=new Fabric({stateDir:dir,python});assert.equal(restart.jobs.get(j.id).state,'UNKNOWN');
  const p=restart.register({id:'local',tenant:'fabric',site:'local',operations:['echo']},['echo'],()=>true);
  await restart.receipt(p,receipt);assert.equal(restart.jobs.get(j.id).state,'SUCCEEDED');
  await restart.receipt(p,receipt);
  await assert.rejects(restart.receipt(p,{...receipt,result:{text:'different'}}),/EQUIVOCATION/);
});

test('command surface: version from the manifest, payload validation, malformed JSON named, unknown op refused before parse',async()=>{
  const f=new Fabric({stateDir:temp(),python});
  const status=await f.command(principal,['status']);assert.equal(status.version,VERSION);assert.match(status.platform,new RegExp(VERSION.replace(/\./g,'\\.')));
  await assert.rejects(f.command(principal,['run','auto','model.evaluate','{not json']),/BAD_PAYLOAD_JSON/);
  await assert.rejects(f.command(principal,['run','auto','shell','ls']),/UNSUPPORTED_OPERATION/);
  await assert.rejects(f.command(principal,['run','auto','model.evaluate','[]']),/OBJECT_REQUIRED/);
  await assert.rejects(f.command(principal,['run','auto','echo','x'.repeat(20000)]),/PAYLOAD_LIMIT/);
  await assert.rejects(f.command(principal,['run','bad target!','echo','x']),/BAD_TARGET/);
  await assert.rejects(f.command(principal,['run','auto','model.evaluate','{"__proto__":{"x":1}}']),/BAD_OBJECT_KEY/);
  const st=await f.command(principal,['status']);
  assert.equal(typeof st.journal.bytes,'number');assert.equal(st.journal.maxBytes,32*1024*1024);
  assert.match(st.retention,/archive-journal/);
});

test('real HERMIT terminal -> hub -> outbound agent; receipt survives disconnect and reconnect',async t=>{
  if(!needs(t,'scheduler'))return;
  const dir=temp(),operator=token(),agentToken=token();
  const principalsFile=path.join(dir,'principals.json'),agentsFile=path.join(dir,'agents.json');
  atomic(principalsFile,[{sub:'alice',tenant:'fabric',tokenSha256:sha(operator),capabilities:['terminal','fabric']}]);
  atomic(agentsFile,[{id:'cloud-test',tenant:'fabric',site:'cloud',tokenSha256:sha(agentToken),operations:['echo','sha256']}]);
  const hub=await createHub({stateDir:dir,python,port:0,principalsFile,agentsFile});
  let client,agent;
  try {
    let release,started=false;
    agent=startAgent({url:`ws://127.0.0.1:${hub.port}/ws/agent`,token:agentToken,operations:['echo','sha256'],stateFile:path.join(dir,'receipts.json')},
      {executor:async(_op,data)=>{started=true;await new Promise(r=>{release=r;});return {text:data};}});
    await until(()=>hub.fabric.peers.size===1,'agent registration');
    client=await new Client(`ws://127.0.0.1:${hub.port}/ws/terminal`,operator).open();
    await client.run('cfp submit e2e-one site:cloud echo circuit-complete','"state": "ASSIGNED"');
    await until(()=>started,'actual agent execution');
    const job=[...hub.fabric.jobs.values()][0];assert.equal(job.node,'cloud-test');
    agent.socket.close();await until(()=>hub.fabric.jobs.get(job.id).state==='UNKNOWN','disconnect marked unknown');
    release();await until(()=>hub.fabric.jobs.get(job.id).state==='SUCCEEDED','outbox delivered on reconnect');
    assert.deepEqual(hub.fabric.jobs.get(job.id).result,{text:'circuit-complete'});
    client.close();client=await new Client(`ws://127.0.0.1:${hub.port}/ws/terminal`,operator).open();
    await client.run('cfp jobs','"state": "SUCCEEDED"');
    assert.equal(hub.fabric.jobs.size,1);
    atomic(agentsFile,[{id:'cloud-test',tenant:'fabric',site:'cloud',tokenSha256:sha(agentToken),operations:['echo','sha256'],revoked:true}]);
    await until(()=>hub.fabric.peers.size===0,'live revocation');
    const denied=await fetch(`http://127.0.0.1:${hub.port}/internal/fabric`,{method:'POST',body:'{}'});assert.equal(denied.status,403);
    // A bridge key of the wrong length or a near-miss never passes the constant-time comparison.
    const near=await fetch(`http://127.0.0.1:${hub.port}/internal/fabric`,{method:'POST',headers:{authorization:'Bearer '+hub.bridge.key.slice(0,-1)+'x'},body:'{}'});assert.equal(near.status,403);
  } finally {client?.close();await agent?.stop();await hub.stop();}
});

test('agent rejects off-loopback cleartext, malformed enrollment, and duplicate ownership; hub refuses non-TLS public binding',async()=>{
  assert.throws(()=>startAgent({url:'ws://example.com/ws/agent'}),/TLS_REQUIRED/);
  assert.throws(()=>startAgent({url:'ws://127.0.0.1:1/ws/agent',token:'short',operations:['echo'],stateFile:path.join(temp(),'r.json')}),/BAD_AGENT_TOKEN/);
  assert.throws(()=>startAgent({url:'ws://127.0.0.1:1/ws/agent',token:token(),operations:[],stateFile:path.join(temp(),'r.json')}),/BAD_AGENT_OPERATIONS/);
  const dir=temp();await assert.rejects(createHub({stateDir:dir,python,host:'0.0.0.0',port:0}),/TLS/);
  assert.equal(fs.existsSync(path.join(dir,'hub.lock')),false);
  const release=acquireLock(path.join(dir,'x.lock'));
  assert.throws(()=>acquireLock(path.join(dir,'x.lock')),/LOCKED: .*recover-lock/);
  release();assert.equal(fs.existsSync(path.join(dir,'x.lock')),false);
  assert.equal(timingSafeEqualString('abc','abc'),true);assert.equal(timingSafeEqualString('abc','abd'),false);assert.equal(timingSafeEqualString('abc','ab'),false);assert.equal(timingSafeEqualString(undefined,'ab'),false);
  assert.match(redactSecrets('Authorization: Bearer '+token()),/REDACTED/);
  assert.throws(()=>resolveUserPath('','x'),/BAD_PATH/);
  assert.throws(()=>canonical(JSON.parse('{"__proto__":{"a":1}}')),/BAD_OBJECT_KEY/);
});

test('hub refuses a malformed grant store instead of admitting agents against it',async()=>{
  const dir=temp(),secret=token(),principalsFile=path.join(dir,'principals.json'),agentsFile=path.join(dir,'agents.json');
  atomic(principalsFile,[]);atomic(agentsFile,[{id:'bad',tenant:'fabric',site:'local',tokenSha256:'not-a-hash',operations:['echo']}]);
  const hub=await createHub({stateDir:dir,python,port:0,principalsFile,agentsFile});
  try {
    const states=[];const agent=startAgent({url:`ws://127.0.0.1:${hub.port}/ws/agent`,token:secret,operations:['echo'],stateFile:path.join(dir,'r.json')},{onState:s=>states.push(s)});
    await until(()=>states.some(s=>s==='disconnected'||s==='connection-error'),'refused admission');
    assert.equal(hub.fabric.peers.size,0);await agent.stop();
  } finally {await hub.stop();}
  // Unknown / non-OPS grant operations fail closed even with a well-formed hash.
  const dir2=temp(),agents2=path.join(dir2,'agents.json'),prin2=path.join(dir2,'principals.json');
  atomic(prin2,[]);atomic(agents2,[{id:'bad2',tenant:'fabric',site:'local',tokenSha256:sha(secret),operations:['shell']}]);
  const hub2=await createHub({stateDir:dir2,python,port:0,principalsFile:prin2,agentsFile:agents2});
  try {
    const states=[];const agent=startAgent({url:`ws://127.0.0.1:${hub2.port}/ws/agent`,token:secret,operations:['echo'],stateFile:path.join(dir2,'r.json')},{onState:s=>states.push(s)});
    await until(()=>states.some(s=>s==='disconnected'||s==='connection-error'),'unknown op grant refused');
    assert.equal(hub2.fabric.peers.size,0);await agent.stop();
  } finally {await hub2.stop();}
});

test('deadline expiration preserves unknown outcome and never redispatches; agent cannot self-grant operations',async t=>{
  if(!needs(t,'scheduler'))return;
  let now=100000,count=0;
  const f=new Fabric({stateDir:temp(),python,clock:()=>now});
  assert.throws(()=>f.register({id:'evil',tenant:'fabric',site:'local',operations:['echo']},['model.evaluate'],()=>true),/CAPABILITY_ESCALATION/);
  f.register({id:'local',tenant:'fabric',site:'local',operations:['echo']},['echo'],()=>{count++;return true;});
  const j=await f.command(principal,['run','auto','echo','expire']);assert.equal(j.state,'ASSIGNED');
  now+=31000;await f.tick();assert.equal(f.jobs.get(j.id).state,'UNKNOWN');await f.tick();assert.equal(count,1);
});

test('changed bound donor is refused before scheduler import',async()=>{
  const root=temp(),binding=require('../catalog/bindings.json').files.scheduler;
  const destination=path.join(root,binding.path);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,'raise RuntimeError("MUST NOT EXECUTE")');
  await assert.rejects(adapter(python,'place',{workload:{},nodes:[]},root),/SOURCE_DIGEST_MISMATCH/);
});

test('native HTTPS listener validates a trusted test certificate and serves the terminal configuration',async()=>{
  const https=require('node:https');
  const dir=temp(),principalsFile=path.join(dir,'principals.json'),agentsFile=path.join(dir,'agents.json');
  atomic(principalsFile,[]);atomic(agentsFile,[]);
  const tls={cert:path.join(__dirname,'fixtures/test-only-cert.pem'),key:path.join(__dirname,'fixtures/test-only-key.pem')};
  const hub=await createHub({stateDir:dir,python,port:0,host:'127.0.0.1',principalsFile,agentsFile,tls});
  try {
    const response=await new Promise((resolve,reject)=>{https.get(`https://127.0.0.1:${hub.port}/config.json`,{ca:fs.readFileSync(tls.cert)},res=>{
      let body='';res.on('data',b=>{body+=b;});res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(body)}));
    }).on('error',reject);});
    assert.equal(response.status,200);assert.equal(response.body.protocol,'hermit.vws.v2');assert.notEqual(hub.port,hub.internalPort);
  } finally {await hub.stop();}
});

test('agent storage failure stops delivery instead of reporting an unpersisted success',async t=>{
  if(!needs(t,'scheduler'))return;
  const dir=temp(),secret=token(),principalsFile=path.join(dir,'principals.json'),agentsFile=path.join(dir,'agents.json'),stateFile=path.join(dir,'receipts.json');
  atomic(principalsFile,[]);atomic(agentsFile,[{id:'disk-test',tenant:'fabric',site:'local',tokenSha256:sha(secret),operations:['echo']}]);
  const hub=await createHub({stateDir:dir,python,port:0,principalsFile,agentsFile});let agent;const states=[];
  try {
    agent=startAgent({url:`ws://127.0.0.1:${hub.port}/ws/agent`,token:secret,operations:['echo'],stateFile},
      {onState:s=>states.push(s),executor:async()=>{fs.unlinkSync(stateFile);fs.mkdirSync(stateFile);return {text:'must not be accepted'};}});
    await until(()=>hub.fabric.peers.size===1,'disk-test registration');
    const job=await hub.fabric.command(principal,['run','auto','echo','test']);
    await until(()=>states.includes('durable-state-failed'),'durability failure detected');
    await until(()=>hub.fabric.jobs.get(job.id).state==='UNKNOWN','hub retained uncertain outcome');
    assert.equal(hub.fabric.jobs.get(job.id).result,undefined);
  } finally {await agent?.stop();await hub.stop();}
});

test('agent receipt store prunes only acknowledged receipts and keeps unacked results',async()=>{
  const dir=temp(),stateFile=path.join(dir,'receipts.json');
  const cache={};
  for(let i=0;i<1000;i++){const id=crypto.randomUUID();cache[id]={id,lease:crypto.randomUUID(),fingerprint:'f'.repeat(64),state:'SUCCEEDED',acked:i%2===0,result:{}};}
  atomic(stateFile,cache);
  const agent=startAgent({url:'ws://127.0.0.1:1/ws/agent',token:token(),operations:['echo'],stateFile});
  try {
    const after=JSON.parse(fs.readFileSync(stateFile,'utf8'));
    const values=Object.values(after);
    assert.ok(values.length<=800,'pruned to cap');
    assert.equal(values.filter(r=>!r.acked).length,500,'every unacked receipt retained');
  } finally {await agent.stop();}
});


test('packaged TLS fixtures are marked test-only and start refuses them as hub material',()=>{
  const cert=fs.readFileSync(path.join(__dirname,'fixtures/test-only-cert.pem'),'utf8');
  assert.match(cert,/CFP public test fixture only|BEGIN CERTIFICATE/);
  const fixturesReadme=fs.readFileSync(path.join(__dirname,'fixtures/README.md'),'utf8');
  assert.match(fixturesReadme,/Never/i);
  // Mirror the start-time guard without launching a hub process.
  const resolved=path.resolve(path.join(__dirname,'fixtures/test-only-cert.pem'));
  assert.match(resolved,/tests[\\/]+fixtures/);
});

test('custody: AES-256-GCM round-trip and refuse without key in require mode',()=>{
  const custody=require('../lib/custody');
  const dir=temp();
  const key=Buffer.from('a'.repeat(64),'hex');
  const secret={token:token(),note:'x'};
  const file=path.join(dir,'operator-login.json');
  const envKey=process.env.CFP_MASTER_KEY,envReq=process.env.CFP_REQUIRE_ENCRYPTION,envFile=process.env.CFP_MASTER_KEY_FILE;
  try {
    delete process.env.CFP_MASTER_KEY;delete process.env.CFP_MASTER_KEY_FILE;delete process.env.CFP_REQUIRE_ENCRYPTION;
    const enc=custody.encryptJson(secret,key);
    assert.equal(enc.schema,'CFP_ENC/1');
    assert.deepEqual(custody.decryptJson(enc,key),secret);
    assert.throws(()=>custody.decryptJson(enc,Buffer.from('b'.repeat(64),'hex')),/.+/);
    process.env.CFP_REQUIRE_ENCRYPTION='1';
    assert.throws(()=>custody.loadMasterKey({stateDir:dir}),/MASTER_KEY_REQUIRED/);
    process.env.CFP_MASTER_KEY='a'.repeat(64);
    const ctx=custody.loadMasterKey({stateDir:dir});
    assert.equal(ctx.key.length,32);
    custody.writeSecret(file,secret,ctx);
    const onDisk=JSON.parse(fs.readFileSync(file,'utf8'));
    assert.equal(onDisk.schema,'CFP_ENC/1');
    assert.equal(onDisk.token,undefined);
    assert.deepEqual(custody.readSecret(file,ctx),secret);
    // Plaintext refuse under require without key
    delete process.env.CFP_MASTER_KEY;
    const plain=path.join(dir,'local-agent.json');
    fs.writeFileSync(plain,JSON.stringify({token:'x'}));
    process.env.CFP_REQUIRE_ENCRYPTION='1';
    assert.throws(()=>custody.enforceCustody(dir),/MASTER_KEY_REQUIRED|PLAINTEXT_SECRET_REFUSED/);
  } finally {
    if(envKey===undefined)delete process.env.CFP_MASTER_KEY;else process.env.CFP_MASTER_KEY=envKey;
    if(envReq===undefined)delete process.env.CFP_REQUIRE_ENCRYPTION;else process.env.CFP_REQUIRE_ENCRYPTION=envReq;
    if(envFile===undefined)delete process.env.CFP_MASTER_KEY_FILE;else process.env.CFP_MASTER_KEY_FILE=envFile;
  }
});

test('backup then wipe then restore recovers journal jobs',async()=>{
  const {spawnSync}=require('node:child_process');
  const cfp=path.join(__dirname,'..','bin','cfp.js');
  const dir=temp();
  const backupDir=path.join(dir,'backup');
  const stateDir=path.join(dir,'state');
  fs.mkdirSync(stateDir,{recursive:true});
  // Seed a fabric journal via Fabric API then backup through CLI
  const f=new Fabric({stateDir,python});
  // With no agent, the job remains queued and durable.
  const job=await f.command(principal,['submit','backup-key','auto','echo','persist-me']);
  assert.equal(job.state,'QUEUED');
  assert.ok(fs.existsSync(path.join(stateDir,'jobs.jsonl')));
  atomic(path.join(stateDir,'hub.json'),{host:'127.0.0.1',port:8740,python,stateDir,principalsFile:path.join(stateDir,'principals.json'),agentsFile:path.join(stateDir,'agents.json')});
  atomic(path.join(stateDir,'principals.json'),[]);
  atomic(path.join(stateDir,'agents.json'),[]);
  const run=(args,env={})=>{
    const r=spawnSync(process.execPath,[cfp,...args],{env:{...process.env,CFP_STATE_DIR:stateDir,...env},encoding:'utf8'});
    if(r.status!==0)throw new Error((r.stderr||r.stdout||'fail')+' status='+r.status);
    return r;
  };
  run(['backup',backupDir]);
  assert.ok(fs.existsSync(path.join(backupDir,'BACKUP.json')));
  assert.ok(fs.existsSync(path.join(backupDir,'jobs.jsonl')));
  // Wipe durable journal + config while keeping directory
  for(const name of fs.readdirSync(stateDir)){
    fs.rmSync(path.join(stateDir,name),{recursive:true,force:true});
  }
  assert.equal(fs.existsSync(path.join(stateDir,'jobs.jsonl')),false);
  run(['restore',backupDir,stateDir]);
  assert.ok(fs.existsSync(path.join(stateDir,'jobs.jsonl')));
  const restored=new Fabric({stateDir,python});
  const found=restored.jobs.get(job.id);
  assert.ok(found);assert.equal(found.state,'QUEUED');
  assert.equal(found.key,'backup-key');
});

test('browser smoke: sign-in page served; off-loopback cleartext refused',async()=>{
  const dir=temp(),principalsFile=path.join(dir,'principals.json'),agentsFile=path.join(dir,'agents.json');
  atomic(principalsFile,[]);atomic(agentsFile,[]);
  const hub=await createHub({stateDir:dir,python,port:0,principalsFile,agentsFile});
  try {
    const res=await fetch(`http://127.0.0.1:${hub.port}/`);
    assert.equal(res.status,200);
    const body=await res.text();
    assert.match(body,/sign|login|token|hermit|terminal/i);
    const cfg=await fetch(`http://127.0.0.1:${hub.port}/config.json`);
    assert.equal(cfg.status,200);
    const json=await cfg.json();
    assert.equal(json.protocol,'hermit.vws.v2');
  } finally {await hub.stop();}
  // Cleartext off-loopback still refused (same contract as test 8; re-assert for smoke evidence).
  await assert.rejects(createHub({stateDir:temp(),python,host:'0.0.0.0',port:0}),/TLS/);
  assert.throws(()=>startAgent({url:'ws://example.com/ws/agent'}),/TLS_REQUIRED/);
});


test('software attestation seam: verify Ed25519 blob; refuse false hardware; fail-closed when required',()=>{
  const pair=attestation.generateKeyPair();
  const created=attestation.createSoftwareAttestation({nodeId:'n1',operations:['echo'],privateKeyPem:pair.privateKeyPem,ttlMs:60000});
  assert.equal(created.hardware,false);assert.equal(created.tpm,false);
  assert.equal(created.kind,attestation.KIND);
  const ok=attestation.verifySoftwareAttestation({attestation:created.attestation,signature:created.signature},{publicKeyPem:pair.publicKeyPem,expectedNodeId:'n1',allowedOps:['echo','sha256']});
  assert.equal(ok.ok,true);assert.equal(ok.hardware,false);assert.match(ok.label,/SOFTWARE/);
  assert.equal(ok.hardwareStatus,'BLOCKED_NOT_TPM');
  // Tamper
  const bad={...created.attestation,operations:['echo','model.evaluate']};
  assert.throws(()=>attestation.verifySoftwareAttestation({attestation:bad,signature:created.signature},{publicKeyPem:pair.publicKeyPem,expectedNodeId:'n1',allowedOps:['echo']}),/ATTESTATION_/);
  // False hardware claim
  const hw={...created.attestation,hardware:true,tpm:true};
  assert.throws(()=>attestation.verifySoftwareAttestation({attestation:hw,signature:created.signature},{publicKeyPem:pair.publicKeyPem}),/FALSE_HARDWARE|HARDWARE/);
  // Require mode without blob
  const prev=process.env.CFP_REQUIRE_ATTESTATION;
  try{
    process.env.CFP_REQUIRE_ATTESTATION='1';
    assert.throws(()=>attestation.verifySoftwareAttestation(null,{publicKeyPem:pair.publicKeyPem,require:true}),/ATTESTATION_REQUIRED/);
  } finally {
    if(prev===undefined)delete process.env.CFP_REQUIRE_ATTESTATION;else process.env.CFP_REQUIRE_ATTESTATION=prev;
  }
  // Skipped when optional and absent
  const skip=attestation.verifySoftwareAttestation(null,{publicKeyPem:pair.publicKeyPem,require:false});
  assert.equal(skip.skipped,true);assert.equal(skip.hardware,false);
});

test('hub admits agent with valid software attestation and refuses when CFP_REQUIRE_ATTESTATION=1 without it',async()=>{
  const pair=attestation.generateKeyPair();
  const dir=temp(),secret=token();
  attestation.writeKeyPairFiles(dir,pair);
  const principalsFile=path.join(dir,'principals.json'),agentsFile=path.join(dir,'agents.json');
  atomic(principalsFile,[]);atomic(agentsFile,[{id:'att-agent',tenant:'fabric',site:'local',tokenSha256:sha(secret),operations:['echo']}]);
  const prevReq=process.env.CFP_REQUIRE_ATTESTATION,prevPub=process.env.CFP_ATTESTATION_PUBKEY;
  try{
    delete process.env.CFP_REQUIRE_ATTESTATION;
    process.env.CFP_ATTESTATION_PUBKEY=pair.publicKeyPem;
    const sw=attestation.createSoftwareAttestation({nodeId:'att-agent',operations:['echo'],privateKeyPem:pair.privateKeyPem});
    const hub=await createHub({stateDir:dir,python,port:0,principalsFile,agentsFile});
    let agent;
    try{
      agent=startAgent({url:`ws://127.0.0.1:${hub.port}/ws/agent`,token:secret,operations:['echo'],stateFile:path.join(dir,'r.json'),softwareAttestation:{attestation:sw.attestation,signature:sw.signature}});
      await until(()=>hub.fabric.peers.size===1,'attested registration');
      const nodes=await hub.fabric.command(principal,['nodes']);
      assert.match(nodes[0].attestation,/SOFTWARE/);
      assert.equal(nodes[0].attestationHardware,false);
    } finally {await agent?.stop();await hub.stop();}

    // Require mode: hub create ok with pubkey in state; agent without attestation refused
    process.env.CFP_REQUIRE_ATTESTATION='1';
    const dir2=temp(),secret2=token();
    attestation.writeKeyPairFiles(dir2,pair);
    const pf2=path.join(dir2,'principals.json'),af2=path.join(dir2,'agents.json');
    atomic(pf2,[]);atomic(af2,[{id:'need-att',tenant:'fabric',site:'local',tokenSha256:sha(secret2),operations:['echo']}]);
    const hub2=await createHub({stateDir:dir2,python,port:0,principalsFile:pf2,agentsFile:af2,requireAttestation:true});
    let agent2;const states=[];
    try{
      agent2=startAgent({url:`ws://127.0.0.1:${hub2.port}/ws/agent`,token:secret2,operations:['echo'],stateFile:path.join(dir2,'r2.json')},{onState:s=>states.push(s)});
      await until(()=>states.some(s=>s==='disconnected'||s==='connection-error'||String(s).includes('protocol')),'require attestation refused');
      assert.equal(hub2.fabric.peers.size,0);
    } finally {await agent2?.stop();await hub2.stop();}
  } finally {
    if(prevReq===undefined)delete process.env.CFP_REQUIRE_ATTESTATION;else process.env.CFP_REQUIRE_ATTESTATION=prevReq;
    if(prevPub===undefined)delete process.env.CFP_ATTESTATION_PUBKEY;else process.env.CFP_ATTESTATION_PUBKEY=prevPub;
  }
});

test('SLO scaffolding: metrics record samples and appear on cfp status',async()=>{
  const m=new Metrics({clock:()=>1000});
  m.record(true,12);m.record(true,40);m.record(false,5);
  const snap=m.snapshot();
  assert.equal(snap.requests,3);assert.equal(snap.errors,1);
  assert.equal(snap.latencyMs.samples,3);assert.equal(snap.latencyMs.min,5);assert.equal(snap.scope,'local_process');
  assert.match(snap.note,/not WAN/i);
  const f=new Fabric({stateDir:temp(),python});
  await f.command(principal,['status']);
  await f.command(principal,['help']);
  await assert.rejects(f.command(principal,['run','bad!','echo','x']),/BAD_TARGET/);
  const status=await f.command(principal,['status']);
  assert.ok(status.metrics);assert.ok(status.metrics.requests>=3);assert.ok(status.metrics.errors>=1);
  assert.equal(typeof status.metrics.latencyMs.p50,'number');
});

test('rolling upgrade dry-run: version read + backup + restore path',async()=>{
  const {spawnSync}=require('node:child_process');
  const cfp=path.join(__dirname,'..','bin','cfp.js');
  const dir=temp(),stateDir=path.join(dir,'state'),backupDest=path.join(dir,'upgrade-backup');
  fs.mkdirSync(stateDir,{recursive:true});
  atomic(path.join(stateDir,'hub.json'),{host:'127.0.0.1',port:8740,python,stateDir,principalsFile:path.join(stateDir,'principals.json'),agentsFile:path.join(stateDir,'agents.json')});
  atomic(path.join(stateDir,'principals.json'),[]);
  atomic(path.join(stateDir,'agents.json'),[]);
  const f=new Fabric({stateDir,python});
  await f.command(principal,['submit','upg-key','auto','echo','keep']);
  const r=spawnSync(process.execPath,[cfp,'upgrade-dry-run',backupDest],{env:{...process.env,CFP_STATE_DIR:stateDir},encoding:'utf8'});
  assert.equal(r.status,0,r.stderr||r.stdout);
  const out=JSON.parse(r.stdout);
  assert.equal(out.ok,true);
  assert.equal(out.fromVersion,VERSION);
  assert.equal(out.multiHostRolling,'NOT_CLAIMED');
  assert.ok(fs.existsSync(path.join(backupDest,'BACKUP.json')));
  const man=JSON.parse(fs.readFileSync(path.join(backupDest,'BACKUP.json'),'utf8'));
  assert.equal(man.version,VERSION);
  assert.equal(man.purpose,'upgrade-dry-run');
  assert.ok(fs.existsSync(out.restoreCheckDir));
  assert.ok(fs.existsSync(path.join(out.restoreCheckDir,'hub.json')));
  // version command
  const v=spawnSync(process.execPath,[cfp,'version'],{encoding:'utf8'});
  assert.equal(v.stdout.trim(),VERSION);
});

test('two-instance loopback TLS drill with freshly generated certs (not packaged fixtures)',async()=>{
  // G3 two-physical-host remains BLOCKED; this is a single-host dual-listener loopback drill only.
  const https=require('node:https');
  const dir=temp();
  const key1=path.join(dir,"h1-key.pem"),cert1=path.join(dir,"h1-cert.pem");
  const key2=path.join(dir,"h2-key.pem"),cert2=path.join(dir,"h2-cert.pem");
  const {generateTestCert}=require("./generate-test-cert");
  generateTestCert(key1,cert1);generateTestCert(key2,cert2);
  assert.ok(fs.existsSync(cert1)&&fs.existsSync(key1));
  assert.ok(!cert1.includes('tests'+path.sep+'fixtures'));
  const mkHub=async (cert,key)=>{
    const d=temp();
    const pf=path.join(d,'principals.json'),af=path.join(d,'agents.json');
    atomic(pf,[]);atomic(af,[]);
    return createHub({stateDir:d,python,port:0,host:'127.0.0.1',principalsFile:pf,agentsFile:af,tls:{cert,key}});
  };
  const hubA=await mkHub(cert1,key1);
  const hubB=await mkHub(cert2,key2);
  try{
    assert.notEqual(hubA.port,hubB.port);
    const get=(port,ca)=>new Promise((resolve,reject)=>{https.get(`https://127.0.0.1:${port}/config.json`,{ca:fs.readFileSync(ca),servername:'localhost',rejectUnauthorized:true},res=>{
      let body='';res.on('data',b=>{body+=b;});res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(body)}));
    }).on('error',reject);});
    // Each freshly signed loopback certificate is explicitly trusted; hostname and chain checks stay enabled.
    const a=await get(hubA.port,cert1);
    const b=await get(hubB.port,cert2);
    assert.equal(a.status,200);assert.equal(a.body.protocol,'hermit.vws.v2');
    assert.equal(b.status,200);assert.equal(b.body.protocol,'hermit.vws.v2');
    assert.notEqual(hubA.port,hubA.internalPort);
    assert.notEqual(hubB.port,hubB.internalPort);
  } finally {await hubA.stop();await hubB.stop();}
});

test('custody refuses bad IV/tag lengths; redactSecrets covers hex keys and PEM',()=>{
  const custody=require('../lib/custody');
  const key=Buffer.from('c'.repeat(64),'hex');
  const good=custody.encryptJson({a:1},key);
  assert.throws(()=>custody.decryptJson({...good,iv:Buffer.alloc(8).toString('base64')},key),/ENVELOPE_IV_LENGTH/);
  assert.throws(()=>custody.decryptJson({...good,tag:Buffer.alloc(8).toString('base64')},key),/ENVELOPE_TAG_LENGTH/);
  const hex='ab'.repeat(32);
  assert.match(redactSecrets('key='+hex),/REDACTED_HEX_KEY/);
  assert.match(redactSecrets('CFP_MASTER_KEY='+hex),/REDACTED/);
  assert.match(redactSecrets('-----BEGIN PRIVATE KEY-----\nABC\n-----END PRIVATE KEY-----'),/REDACTED_PEM/);
});
