#!/usr/bin/env node
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {ROOT,VERSION,atomic,token,sha,adapter,redactSecrets,resolveUserPath,OPS}=require('../lib/common');
const {createHub}=require('../lib/hub');
const {startAgent}=require('../lib/agent');
const custody=require('../lib/custody');
const attestation=require('../lib/attestation');
const {Metrics}=require('../lib/metrics');
const {resolvePython}=require('../lib/python');
const state=path.resolve(process.env.CFP_STATE_DIR||path.join(ROOT,'.state'));
const file=name=>path.join(state,name);
function keyCtx(){return custody.loadMasterKey({stateDir:state});}
function readPlainOrSecret(name){
  const p=file(name);
  if(custody.isSecretPath(p))return custody.readSecret(p,keyCtx());
  return JSON.parse(fs.readFileSync(p,'utf8'));
}
function writePlainOrSecret(name,value){
  const p=file(name);
  if(custody.isSecretPath(p))return custody.writeSecret(p,value,keyCtx());
  return atomic(p,value);
}
function assertEngines() {
  const [major,minor]=process.versions.node.split('.').map(Number);
  if(!Number.isFinite(major)||major<24||(major===24&&minor<19))throw new Error('NODE_ENGINE: Continuous Fabric Reference '+VERSION+' requires Node >=24.19 (running '+process.versions.node+')');
}
function refusePackagedTlsFixture(p,label) {
  const resolved=resolveUserPath(p,'tls.'+label);
  const fixtures=path.join(ROOT,'tests','fixtures')+path.sep;
  if(resolved.startsWith(fixtures)||resolved.includes(path.sep+'tests'+path.sep+'fixtures'+path.sep)) {
    throw new Error('TLS_TEST_FIXTURE_REFUSED: '+label+' points at packaged test-only material; provision an operator certificate (see docs/DEPLOYMENT.md)');
  }
  if(!fs.existsSync(resolved)||!fs.statSync(resolved).isFile())throw new Error('TLS_'+label.toUpperCase()+'_MISSING');
  const fixture=path.join(ROOT,'tests','fixtures',label==='cert'?'test-only-cert.pem':'test-only-key.pem');
  if(sha(fs.readFileSync(resolved))===sha(fs.readFileSync(fixture)))throw new Error('TLS_TEST_FIXTURE_REFUSED: copied public fixture is not deployment material');
  return resolved;
}
const {copyTree,restoreTree}=require('../lib/backup');
async function main(args) {
  const [cmd,...rest]=args;
  if(cmd==='init') {
    assertEngines();
    if(fs.existsSync(file('hub.json')))throw new Error('ALREADY_INITIALIZED');
    fs.mkdirSync(state,{recursive:true,mode:0o700});
    const python=resolvePython();
    const report=await adapter(python,'doctor',{});
    const unbound=Object.entries(report.bindings||{}).filter(([,v])=>v!=='HASH_MATCH').map(([k])=>k);
    if(unbound.length)console.error('WARNING: '+unbound.length+' pinned source binding(s) not matched ('+unbound.join(', ')+'). Source-backed operations (place/model.evaluate/state.merge) will be refused until CFP_SOURCE_ROOT points at the pinned tree. See docs/DEPLOYMENT.md.');
    let ctx=keyCtx();
    if(!ctx.key && (process.env.CFP_GENERATE_MASTER_KEY==='1' || process.env.CFP_REQUIRE_ENCRYPTION==='1')){
      const mk=custody.writeMasterKeyFile(file('master.key'));
      console.error('Generated '+file('master.key')+' (mode 0600). Back it up offline; loss prevents decrypting secrets.');
      process.env.CFP_MASTER_KEY_FILE=file('master.key');
      ctx=keyCtx();
    }
    const operator=token(),agent=token();
    atomic(file('principals.json'),[{sub:'operator',tenant:'fabric',tokenSha256:sha(operator),capabilities:['terminal','fabric']}]);
    writePlainOrSecret('agents.json',[{id:'local-1',tenant:'fabric',site:'local',tokenSha256:sha(agent),operations:[...OPS]}]);
    writePlainOrSecret('local-agent.json',{url:'ws://127.0.0.1:8740/ws/agent',token:agent,operations:[...OPS],python,stateFile:file('local-receipts.json')});
    writePlainOrSecret('operator-login.json',{token:operator,note:'Paste token into HERMIT Sign in. Keep this local credential private.'});
    atomic(file('hub.json'),{host:'127.0.0.1',port:8740,python,stateDir:state,principalsFile:file('principals.json'),agentsFile:file('agents.json')});
    const encNote=ctx.key?' Secrets encrypted at rest (AES-256-GCM).':' Secrets stored as plaintext JSON (set CFP_MASTER_KEY or CFP_GENERATE_MASTER_KEY=1 for encryption).';
    console.log('Initialized. Browser credential: '+file('operator-login.json')+'\nStart: node bin/cfp.js start'+encNote);return;
  }
  if(cmd==='doctor') {
    assertEngines();
    const python=resolvePython(fs.existsSync(file('hub.json'))?JSON.parse(fs.readFileSync(file('hub.json'),'utf8')).python:undefined);
    const report=await adapter(python,'doctor',{});
    let custodyReport={enabled:false};
    try{
      const ctx=keyCtx();
      custodyReport={keyPresent:!!ctx.key,source:ctx.source||null,requireEncryption:ctx.requireEnc,requireEnv:process.env.CFP_REQUIRE_ENCRYPTION==='1'};
      if(fs.existsSync(state)){
        const secrets=[];
        for(const name of fs.readdirSync(state)){
          const p=file(name);
          if(!fs.statSync(p).isFile()||!custody.isSecretPath(p))continue;
          try{
            const parsed=JSON.parse(fs.readFileSync(p,'utf8'));
            secrets.push({file:name,encrypted:custody.isEnvelope(parsed)});
          }catch{secrets.push({file:name,encrypted:null,error:'unreadable'});}
        }
        custodyReport.secrets=secrets;
      }
    }catch(e){custodyReport.error=e.message;}
    report.runtime={node:process.versions.node,cfp:VERSION,stateDir:state,engines:require('../package.json').engines.node};
    report.custody=custodyReport;
    let attestReport={kind:attestation.KIND,hardwareStatus:attestation.HARDWARE_STATUS,note:'Software seam only; not TPM/hardware attestation'};
    try{
      const am=attestation.loadAttestationMaterial({stateDir:state});
      attestReport.requireAttestation=am.requireAtt;
      attestReport.pubkeyPresent=!!am.publicKeyPem;
      attestReport.privateKeyPresent=!!am.privateKeyPem;
    }catch(e){attestReport.error=e.message;}
    report.attestation=attestReport;
    report.metrics={schema:'CFP_METRICS/1',scope:'local_process',note:'Live counters appear on `cfp status` while the hub is running; doctor reports scaffolding only',scaffold:new Metrics().snapshot()};
    console.log(JSON.stringify(report,null,2));
    if(Object.values(report.bindings||{}).some(value=>value!=='HASH_MATCH')||custodyReport.error||custodyReport.secrets?.some(item=>item.error)||attestReport.error)process.exitCode=1;
    return;
  }
  if(cmd==='start') {
    assertEngines();
    const cfg=JSON.parse(fs.readFileSync(file('hub.json'),'utf8'));
    cfg.python=resolvePython(cfg.python);
    cfg.stateDir=resolveUserPath(cfg.stateDir||state,'stateDir');
    cfg.principalsFile=resolveUserPath(cfg.principalsFile,'principalsFile');
    cfg.agentsFile=resolveUserPath(cfg.agentsFile,'agentsFile');
    const custodyStatus=custody.enforceCustody(cfg.stateDir,keyCtx());
    if(custodyStatus.migrated.length)console.error('Migrated plaintext secrets to AES-256-GCM: '+custodyStatus.migrated.join(', '));
    if(cfg.tls) {
      cfg.tls={cert:refusePackagedTlsFixture(cfg.tls.cert,'cert'),key:refusePackagedTlsFixture(cfg.tls.key,'key')};
      if(!cfg.host||['127.0.0.1','localhost','::1'].includes(cfg.host)) {
        console.error('WARNING: TLS is configured while host remains loopback-only; off-loopback clients still cannot connect until hub.json host is a reachable address.');
      }
    } else if(cfg.host&&!['127.0.0.1','localhost','::1'].includes(cfg.host)) {
      throw new Error('TLS_CERT_AND_KEY_REQUIRED_OFF_LOOPBACK');
    }
    if(process.env.CFP_REQUIRE_ATTESTATION==='1')cfg.requireAttestation=true;
    const hub=await createHub(cfg);
    const local=custody.isSecretPath(file('local-agent.json'))
      ?custody.readSecret(file('local-agent.json'),keyCtx())
      :JSON.parse(fs.readFileSync(file('local-agent.json'),'utf8'));
    local.python=cfg.python;
    local.url=`ws://127.0.0.1:${hub.internalPort}/ws/agent`;
    local.stateFile=resolveUserPath(local.stateFile,'local.stateFile');
    let agent;try{agent=startAgent(local);}catch(e){await hub.stop();throw e;}
    console.log(`Continuous Fabric reference: ${cfg.tls?'https':'http'}://${cfg.host}:${hub.port}\nSign-in credential file: ${file('operator-login.json')}\nTry: cfp help`);
    let stopping=false;const stop=async()=>{if(stopping)return;stopping=true;await agent.stop();await hub.stop();};
    process.on('SIGINT',()=>stop().then(()=>process.exit(0)));process.on('SIGTERM',()=>stop().then(()=>process.exit(0)));return;
  }
  if(cmd==='enroll') {
    assertEngines();
    const [name,site,url]=rest;
    if(!/^[A-Za-z0-9_.-]{1,64}$/.test(name||'')||!['local','cloud'].includes(site))throw new Error('Usage: enroll NODE local|cloud wss://hub/ws/agent');
    const u=new URL(url);if(u.protocol!=='wss:'||u.pathname!=='/ws/agent'||u.username||u.password||u.search||u.hash)throw new Error('WSS_AGENT_URL_REQUIRED');
    const grants=readPlainOrSecret('agents.json');if(grants.some(g=>g.id===name)||grants.length>=32)throw new Error('DUPLICATE_OR_LIMIT');
    const secret=token();grants.push({id:name,tenant:'fabric',site,tokenSha256:sha(secret),operations:['echo','sha256']});writePlainOrSecret('agents.json',grants);
    const destination=file(name+'-agent.json');custody.writeSecret(destination,{url,token:secret,operations:['echo','sha256'],stateFile:'./agent-state/'+name+'-receipts.json'},keyCtx());
    console.log('Copy this private configuration to that agent: '+destination);return;
  }
  if(cmd==='revoke') {
    const grants=readPlainOrSecret('agents.json'),grant=grants.find(g=>g.id===rest[0]);if(!grant)throw new Error('NOT_FOUND');grant.revoked=true;writePlainOrSecret('agents.json',grants);console.log('Revoked; active agent connection expires within one second.');return;
  }
  if(cmd==='agent') {
    assertEngines();
    const cfgPath=resolveUserPath(rest[0],'agent-config');
    let cfg;
    try{
      const parsed=JSON.parse(fs.readFileSync(cfgPath,'utf8'));
      if(custody.isEnvelope(parsed))cfg=custody.readSecret(cfgPath,keyCtx());
      else cfg=parsed;
    }catch(e){
      if(e.message&&e.message.startsWith('MASTER_KEY'))throw e;
      throw new Error('AGENT_CONFIG_UNREADABLE: '+e.message);
    }
    if(cfg.operations?.some(op=>['model.evaluate','state.merge'].includes(op)))cfg.python=resolvePython(cfg.python);
    if(cfg.stateFile)cfg.stateFile=resolveUserPath(cfg.stateFile,'stateFile');
    const agent=startAgent(cfg,{onState:s=>console.log(redactSecrets(s))});
    process.on('SIGINT',async()=>{await agent.stop();process.exit(0);});process.on('SIGTERM',async()=>{await agent.stop();process.exit(0);});return;
  }
  if(cmd==='version'||cmd==='--version'||cmd==='-v'){console.log(VERSION);return;}
  if(cmd==='recover-lock') {
    const p=resolveUserPath(rest[0]||file('hub.lock'),'lock');
    if(!p.endsWith('.lock'))throw new Error('LOCK_FILE_REQUIRED');
    const pid=Number(fs.readFileSync(p,'utf8'));if(!Number.isInteger(pid)||pid<=0)throw new Error('INVALID_LOCK');
    if(pid===process.pid)throw new Error('INVALID_LOCK');
    try {process.kill(pid,0);throw new Error('OWNER_STILL_RUNNING');}catch(e){if(e.code!=='ESRCH')throw e;}
    fs.unlinkSync(p);console.log('Removed stale lock: '+p);return;
  }
  if(cmd==='archive-journal') {
    const lock=file('hub.lock');
    if(fs.existsSync(lock)) {
      const pid=Number(fs.readFileSync(lock,'utf8'));
      if(Number.isInteger(pid)&&pid>0){
        try{process.kill(pid,0);throw new Error('HUB_RUNNING: stop the hub before archive-journal');}catch(e){if(e.code!=='ESRCH')throw e;}
      }
      throw new Error('HUB_LOCK_PRESENT: recover-lock first if the owner has exited');
    }
    const journal=file('jobs.jsonl');
    if(!fs.existsSync(journal))throw new Error('JOURNAL_ABSENT');
    const stamp=new Date().toISOString().replace(/[:.]/g,'-');
    const dest=file('jobs-'+stamp+'.jsonl.archived');
    fs.renameSync(journal,dest);
    console.log('Archived journal to '+dest+'\nNext start begins an empty idempotency domain. Restore grants/receipts consistently; see docs/DEPLOYMENT.md.');
    return;
  }
  if(cmd==='backup') {
    assertEngines();
    const lock=file('hub.lock');
    if(fs.existsSync(lock)) {
      const pid=Number(fs.readFileSync(lock,'utf8'));
      if(Number.isInteger(pid)&&pid>0){
        try{process.kill(pid,0);throw new Error('HUB_RUNNING: stop the hub before backup');}catch(e){if(e.code!=='ESRCH')throw e;}
      }
      throw new Error('HUB_LOCK_PRESENT: recover-lock first if the owner has exited');
    }
    if(!fs.existsSync(state))throw new Error('STATE_ABSENT');
    const stamp=new Date().toISOString().replace(/[:.]/g,'-');
    const dest=resolveUserPath(rest[0]||path.join(state,'..','cfp-backup-'+stamp),'backup-dest');
    if(fs.existsSync(dest)&&fs.readdirSync(dest).length)throw new Error('BACKUP_DEST_NOT_EMPTY');
    copyTree(state,dest);
    const manifest={schema:'CFP_BACKUP/1',version:VERSION,created:new Date().toISOString(),sourceState:state,files:fs.readdirSync(dest)};
    atomic(path.join(dest,'BACKUP.json'),manifest);
    console.log('Backup written to '+dest);return;
  }
  if(cmd==='restore') {
    assertEngines();
    const lock=file('hub.lock');
    if(fs.existsSync(lock)) {
      const pid=Number(fs.readFileSync(lock,'utf8'));
      if(Number.isInteger(pid)&&pid>0){
        try{process.kill(pid,0);throw new Error('HUB_RUNNING: stop the hub before restore');}catch(e){if(e.code!=='ESRCH')throw e;}
      }
      throw new Error('HUB_LOCK_PRESENT: recover-lock first if the owner has exited');
    }
    const src=resolveUserPath(rest[0],'backup-source');
    if(!fs.existsSync(path.join(src,'BACKUP.json'))&&!fs.existsSync(path.join(src,'hub.json')))throw new Error('NOT_A_BACKUP: need BACKUP.json or hub.json');
    const dest=resolveUserPath(rest[1]||state,'restore-dest');
    const restored=restoreTree(src,dest);
    if(restored.previous)console.error('Moved existing state aside: '+restored.previous);
    // Drop backup manifest from live state if present
    const bm=path.join(dest,'BACKUP.json');
    if(fs.existsSync(bm))fs.unlinkSync(bm);
    console.log('Restored state to '+dest+'\nVerify custody key still decrypts secrets before start.');return;
  }
  if(cmd==='attest-keygen') {
    assertEngines();
    fs.mkdirSync(state,{recursive:true,mode:0o700});
    const written=attestation.writeKeyPairFiles(state);
    console.log(JSON.stringify({
      ok:true,
      kind:attestation.KIND,
      hardware:false,
      tpm:false,
      hardwareStatus:attestation.HARDWARE_STATUS,
      publicKeyFile:written.publicKeyFile,
      privateKeyFile:written.privateKeyFile,
      note:'SOFTWARE attestation keys only. Hardware TPM GAP-06 remains BLOCKED. Set CFP_ATTESTATION_PUBKEY_FILE / CFP_ATTESTATION_KEY_FILE or leave keys under .state/. Use CFP_REQUIRE_ATTESTATION=1 to fail-closed.'
    },null,2));
    return;
  }
  if(cmd==='upgrade-dry-run') {
    assertEngines();
    // Local single-hub rolling-upgrade dry-run: version read + backup-before-upgrade + restore path validation.
    // Does NOT claim multi-host rolling upgrade.
    const lock=file('hub.lock');
    if(fs.existsSync(lock)) {
      const pid=Number(fs.readFileSync(lock,'utf8'));
      if(Number.isInteger(pid)&&pid>0){
        try{process.kill(pid,0);throw new Error('HUB_RUNNING: stop the hub before upgrade-dry-run');}catch(e){if(e.code!=='ESRCH')throw e;}
      }
      throw new Error('HUB_LOCK_PRESENT: recover-lock first if the owner has exited');
    }
    if(!fs.existsSync(state)||!fs.existsSync(file('hub.json')))throw new Error('STATE_ABSENT: init a hub first');
    const fromVersion=VERSION;
    const stamp=new Date().toISOString().replace(/[:.]/g,'-');
    const dest=resolveUserPath(rest[0]||path.join(state,'..','cfp-upgrade-backup-'+stamp),'upgrade-backup-dest');
    if(fs.existsSync(dest)&&fs.readdirSync(dest).length)throw new Error('BACKUP_DEST_NOT_EMPTY');
    copyTree(state,dest);
    const manifest={schema:'CFP_BACKUP/1',version:fromVersion,created:new Date().toISOString(),sourceState:state,purpose:'upgrade-dry-run',files:fs.readdirSync(dest)};
    atomic(path.join(dest,'BACKUP.json'),manifest);
    // Validate restore path without destroying live state: restore into a sibling scratch dir.
    const scratch=resolveUserPath(path.join(path.dirname(dest),'cfp-upgrade-restore-check-'+stamp),'upgrade-restore-scratch');
    copyTree(dest,scratch);
    const bm=path.join(scratch,'BACKUP.json');
    if(fs.existsSync(bm))fs.unlinkSync(bm);
    if(!fs.existsSync(path.join(scratch,'hub.json')))throw new Error('RESTORE_CHECK_FAILED: hub.json missing after restore copy');
    const backupManifest=JSON.parse(fs.readFileSync(path.join(dest,'BACKUP.json'),'utf8'));
    if(backupManifest.version!==fromVersion)throw new Error('VERSION_MISMATCH_IN_BACKUP');
    console.log(JSON.stringify({
      ok:true,
      procedure:'local_single_hub_upgrade_dry_run',
      multiHostRolling:'NOT_CLAIMED',
      fromVersion,
      packageVersion:VERSION,
      backupDest:dest,
      restoreCheckDir:scratch,
      nextSteps:[
        '1. Keep the backup offline with the master key',
        '2. Replace the package tree with the new release',
        '3. Confirm node bin/cfp.js version matches the target',
        '4. If needed: node bin/cfp.js restore <backup>',
        '5. node bin/cfp.js doctor && node bin/cfp.js start'
      ],
      note:'Single-process local dry-run only. Multi-instance rolling upgrade remains unqualified.'
    },null,2));
    return;
  }
  if(cmd&&cmd!=='help')process.exitCode=2;
  console.log('cfp '+VERSION+': init | start | doctor | version | enroll NODE local|cloud WSS_URL | revoke NODE | agent CONFIG | recover-lock [LOCK_FILE] | archive-journal | backup [DEST] | restore SOURCE [DEST] | attest-keygen | upgrade-dry-run [BACKUP_DEST]');
}
main(process.argv.slice(2)).catch(e=>{console.error(redactSecrets(e.message));process.exitCode=1;});
