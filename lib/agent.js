'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {atomic,sha,adapter,payload,acquireLock,resolveUserPath,OPS}=require('./common');
const RECEIPT_CAP=1000, RECEIPT_PRUNE_TO=800;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
async function execute(op,data,config) {
  payload(op,data);
  if(op==='echo')return {text:data};
  if(op==='sha256')return {sha256:sha(data)};
  return adapter(config.python,op,data,config.sourceRoot);
}
function startAgent(config,{onState=()=>{},executor=execute}={}) {
  const u=new URL(config.url);
  if(u.protocol!=='wss:'&&!(u.protocol==='ws:'&&['127.0.0.1','localhost','[::1]'].includes(u.hostname)))throw new Error('TLS_REQUIRED_OFF_LOOPBACK');
  if(u.pathname!=='/ws/agent'||u.search||u.hash||u.username||u.password)throw new Error('BAD_AGENT_URL');
  if(typeof config.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(config.token))throw new Error('BAD_AGENT_TOKEN');
  if(!Array.isArray(config.operations)||config.operations.length===0||config.operations.length>OPS.length||config.operations.some(x=>!OPS.includes(x)))throw new Error('BAD_AGENT_OPERATIONS');
  const stateFile=resolveUserPath(config.stateFile,'stateFile'), lock=stateFile+'.lock';
  const releaseLock=acquireLock(lock);
  let cache;
  try{if(fs.existsSync(stateFile)&&fs.statSync(stateFile).size>40*1024*1024)throw new Error('RECEIPT_STORE_LIMIT');cache=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile,'utf8')):{};if(!cache||typeof cache!=='object'||Array.isArray(cache))throw new Error('BAD_RECEIPT_STORE');}
  catch(e){releaseLock();throw e;}
  try {
    if(fs.existsSync(stateFile)&&fs.statSync(stateFile).size>40*1024*1024)throw new Error('RECEIPT_STORE_LIMIT');
    if(Object.keys(cache).length>RECEIPT_CAP)throw new Error('RECEIPT_STORE_LIMIT');
    for(const [key,r] of Object.entries(cache)){
      if(!UUID.test(key)||!r||r.id!==key||!UUID.test(r.lease)||!['EXECUTING','SUCCEEDED','FAILED','UNKNOWN'].includes(r.state)||typeof r.acked!=='boolean'||! /^[0-9a-f]{64}$/.test(r.fingerprint))throw new Error('BAD_RECEIPT_STORE');
      if(r.state==='EXECUTING'){r.state='UNKNOWN';r.result={error:'executor restarted before a durable result'};}
    }
  } catch(error){releaseLock();throw error;}
  // Bounded receipt store: acknowledged receipts are the only prunable records; unacked results are never evicted.
  const prune=()=>{
    const ids=Object.keys(cache);if(ids.length<RECEIPT_CAP)return;
    for(const k of ids){if(Object.keys(cache).length<=RECEIPT_PRUNE_TO)break;if(cache[k].acked)delete cache[k];}
  };
  try{prune();atomic(stateFile,cache);}catch(error){releaseLock();throw error;}
  let ws=null,stopped=false,retry=null,beat=null,attempt=0,busy=false,ready=false;
  const persist=()=>{
    try {atomic(stateFile,cache);}
    catch(e){stopped=true;clearTimeout(retry);clearInterval(beat);ws?.close(4011,'state write failed');onState('durable-state-failed');throw e;}
  };
  const send=m=>{if(ws?.readyState===1&&ws.bufferedAmount<65536){ws.send(JSON.stringify(m));return true;}return false;};
  const receipts=()=>{for(const r of Object.values(cache))if(r.state!=='EXECUTING'&&!r.acked)send({type:'receipt',...r});};
  const connect=()=>{
    if(stopped)return;
    ready=false;
    ws=new WebSocket(config.url,{protocols:['cfp.agent.v1'],headers:{authorization:'Bearer '+config.token}});
    ws.addEventListener('open',()=>{
      const reg={type:'register',operations:config.operations};
      // Optional software attestation (NOT TPM). Config may carry pre-built {attestation,signature}.
      if(config.softwareAttestation&&typeof config.softwareAttestation==='object'){
        reg.attestation=config.softwareAttestation.attestation;
        reg.signature=config.softwareAttestation.signature;
      }
      send(reg);
    });
    ws.addEventListener('error',()=>onState('connection-error'));
    ws.addEventListener('close',()=>{ready=false;clearInterval(beat);onState('disconnected');if(!stopped)retry=setTimeout(connect,Math.min(10000,250*2**Math.min(attempt++,5))+Math.floor(Math.random()*100));});
    ws.addEventListener('message',async e=>{
      if(stopped)return;
      try {
        if(typeof e.data!=='string'||Buffer.byteLength(e.data)>65536)throw new Error('BAD_MESSAGE');
        const m=JSON.parse(e.data);
        if(!m||typeof m!=='object'||Array.isArray(m))throw new Error('BAD_MESSAGE');
        if(m.type==='welcome') {if(ready)throw new Error('DUPLICATE_WELCOME');ready=true;attempt=0;onState('connected');receipts();beat=setInterval(()=>{send({type:'heartbeat'});receipts();},3000);return;}
        if(m.type==='receipt.ack'){if(!ready||!UUID.test(m.id)||!UUID.test(m.lease))throw new Error('BAD_RECEIPT_ACK');const r=Object.hasOwn(cache,m.id)?cache[m.id]:null;if(r&&r.lease===m.lease){r.acked=true;persist();}return;}
        if(m.type!=='execute'||!ready)throw new Error('BAD_MESSAGE');
        const j=m.job;
        if(!j||!UUID.test(j.id)||!UUID.test(j.lease)||!Number.isSafeInteger(j.deadline))throw new Error('BAD_JOB');
        const fingerprint=sha(JSON.stringify([j.lease,j.op,j.data]));
        if(Object.hasOwn(cache,j.id)) {
          if(cache[j.id].fingerprint!==fingerprint)throw new Error('JOB_EQUIVOCATION');
          if(cache[j.id].state!=='EXECUTING')send({type:'receipt',...cache[j.id]});return;
        }
        prune();
        if(busy||Object.keys(cache).length>=RECEIPT_CAP||j.deadline<Date.now()||!config.operations.includes(j.op))throw new Error('JOB_REFUSED');
        payload(j.op,j.data);busy=true;
        try {
          cache[j.id]={id:j.id,lease:j.lease,fingerprint,state:'EXECUTING',acked:false};persist();
          let state='SUCCEEDED',result;
          try{result=await executor(j.op,j.data,config);if(Buffer.byteLength(JSON.stringify(result))>32768)throw new Error('result limit');}
          catch(err){state='FAILED';result={error:String(err.message).slice(0,300)};}
          cache[j.id]={...cache[j.id],state,result};persist();receipts();
        } finally {busy=false;}
      } catch(err){onState('protocol-error: '+err.message);ws?.close(4008,'protocol error');}
    });
  };
  try{connect();}catch(error){releaseLock();throw error;}
  return {get socket(){return ws;},get ready(){return ready;},async stop(){
    stopped=true;clearTimeout(retry);clearInterval(beat);ws?.close(1000,'stop');
    // Retain exclusive ownership until an in-flight result has reached disk.
    while(busy)await new Promise(resolve=>setTimeout(resolve,25));
    releaseLock();
  }};
}
module.exports={startAgent,execute};
