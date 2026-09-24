'use strict';
const fs=require('node:fs');
const path=require('node:path');
const https=require('node:https');
const {Fabric}=require('./fabric');
const {token,sha,timingSafeEqualString,acquireLock,redactSecrets,OPS,resolveUserPath}=require('./common');
const custody=require('./custody');
const attestation=require('./attestation');
const {load}=require('../runtime/hermit/gateway/config');
const {createGateway}=require('../runtime/hermit/gateway/server');
const {WsConnection,checkUpgrade,acceptUpgrade,rejectUpgrade}=require('../runtime/hermit/gateway/ws');
const loopback=x=>['127.0.0.1','::1','::ffff:127.0.0.1'].includes(x);
const LOOPBACK_HOSTS=new Set(['127.0.0.1','localhost','::1']);
async function createHub(options) {
  const stateDir=resolveUserPath(options.stateDir,'stateDir');fs.mkdirSync(stateDir,{recursive:true,mode:0o700});
  const releaseLock=acquireLock(path.join(stateDir,'hub.lock'));
  let gw,external,tick;
  const sockets=new Set();
  try {
    if(options.host&&!LOOPBACK_HOSTS.has(options.host)&&!options.tls)throw new Error('TLS_CERT_AND_KEY_REQUIRED_OFF_LOOPBACK');
    if(options.tls) {
      if(!options.tls.cert||!options.tls.key)throw new Error('TLS_CERT_AND_KEY_REQUIRED_OFF_LOOPBACK');
      options={...options,tls:{
        cert:resolveUserPath(options.tls.cert,'tls.cert'),
        key:resolveUserPath(options.tls.key,'tls.key')
      }};
      for(const [label,p] of [['cert',options.tls.cert],['key',options.tls.key]]) {
        if(!fs.existsSync(p)||!fs.statSync(p).isFile())throw new Error('TLS_'+label.toUpperCase()+'_MISSING');
      }
    }
    const attestMat=attestation.loadAttestationMaterial({stateDir, require: options.requireAttestation === true});
    const fabric=new Fabric(options), bridge={key:token(),url:null};
    const base=load({VWS_HOST:'127.0.0.1',VWS_PRINCIPALS_FILE:options.principalsFile,VWS_SECURE_COOKIES:options.tls?'1':'0',VWS_LOG:'error',VWS_FABRIC:'0'});
    gw=createGateway({...base,port:options.tls?0:options.port,cfp:bridge});
    const json=(res,status,value)=>{const b=JSON.stringify(value);res.writeHead(status,{'Content-Type':'application/json','Content-Length':Buffer.byteLength(b),'Cache-Control':'no-store'});res.end(b);};
    const originalRequest=gw.server.listeners('request')[0];gw.server.removeAllListeners('request');
    // Private loopback command bridge: size + simple rate bound (not a public-edge defense).
    let bridgeCount=0,bridgeWindow=Date.now();
    const request=(req,res)=>{
      if(req.url!=='/internal/fabric')return originalRequest(req,res);
      if(req.method!=='POST'||!loopback(req.socket.remoteAddress)||req.headers.origin||!timingSafeEqualString(req.headers.authorization||'','Bearer '+bridge.key)){req.resume();return json(res,403,{error:'FORBIDDEN'});}
      if(Date.now()-bridgeWindow>1000){bridgeWindow=Date.now();bridgeCount=0;}
      if(++bridgeCount>30){req.resume();return json(res,429,{error:'BRIDGE_RATE_LIMIT'});}
      const chunks=[];let n=0,over=false;
      req.on('data',b=>{
        if(over)return;
        n+=b.length;
        if(n>32768){
          over=true;
          if(!res.headersSent)json(res,413,{error:'PAYLOAD_TOO_LARGE'});
          req.destroy();
          return;
        }
        chunks.push(b);
      });
      req.on('error',()=>{});
      req.on('end',async()=>{
        if(over||res.headersSent)return;
        try{
          const m=JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if(!m||typeof m!=='object'||!m.principal||typeof m.principal.sub!=='string'||typeof m.principal.tenant!=='string'||typeof m.principal.submit!=='boolean'||m.principal.sub.length>128||m.principal.tenant.length>128||!Array.isArray(m.args)||m.args.length>32||m.args.some(x=>typeof x!=='string'||x.length>16384))throw new Error('BAD_COMMAND');
          json(res,200,await fabric.command(m.principal,m.args));
        }catch(e){json(res,400,{error:e.message});}
      });
    };
    gw.server.on('request',request);
    const getGrants=()=>{
      const values=custody.isSecretPath(options.agentsFile)
        ?custody.readSecret(options.agentsFile,custody.loadMasterKey({stateDir}))
        :JSON.parse(fs.readFileSync(options.agentsFile,'utf8'));
      if(!Array.isArray(values)||values.length>32)throw new Error('BAD_GRANT_STORE');
      for(const g of values){
        if(!g||typeof g.id!=='string'||g.id.length>64||typeof g.tenant!=='string'||g.tenant.length>128||typeof g.site!=='string'||g.site.length>64||!/^[a-f0-9]{64}$/.test(g.tokenSha256||'')||!Array.isArray(g.operations)||g.operations.length===0||g.operations.length>16||g.operations.some(op=>typeof op!=='string'||!OPS.includes(op)))throw new Error('BAD_GRANT_STORE');
      }
      return values;
    };
    const originalUpgrade=gw.server.listeners('upgrade')[0];gw.server.removeAllListeners('upgrade');
    const upgrade=(req,socket,head)=>{
      socket.on('error',()=>{});
      if(req.url!=='/ws/agent')return originalUpgrade(req,socket,head);
      try {
        if(gw.registry.draining||req.headers.origin||sockets.size>=32)return rejectUpgrade(socket,403,'agent channel unavailable');
        const up=checkUpgrade(req,'cfp.agent.v1');if(!up.ok)return rejectUpgrade(socket,up.status,up.reason);
        if(head.length)return rejectUpgrade(socket,400,'unexpected data');
        const auth=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization||'');
        const presented=auth?sha(auth[1]):null;
        const grant=presented&&getGrants().find(g=>!g.revoked&&timingSafeEqualString(g.tokenSha256,presented));
        if(!grant)return rejectUpgrade(socket,401,'unauthorized');
        if(fabric.peers.has(grant.id))return rejectUpgrade(socket,409,'duplicate agent');
        acceptUpgrade(socket,up.key,'cfp.agent.v1');
        const ws=new WsConnection(socket,{maxMessageBytes:65536,sendQueueBytes:131072,closeWaitMs:100});sockets.add(ws);
        let peer=null,seen=Date.now(),count=0,window=Date.now(),attestationDeadline=null;
        const send=m=>ws.sendText(JSON.stringify(m));
        const timer=setInterval(()=>{
          try {
            const current=getGrants().find(g=>g.id===grant.id&&!g.revoked&&g.tokenSha256===grant.tokenSha256);
            if(!current||JSON.stringify(current)!==JSON.stringify(grant)||Date.now()-seen>(peer?15000:5000)||(attestationDeadline!==null&&Date.now()>=attestationDeadline))ws.terminate(1008,'expired or revoked');
          }catch{ws.terminate(1008,'grant unavailable');}
        },1000);
        ws.on('binary',()=>ws.close(1003,'text only'));
        ws.on('text',bytes=>{
          try {
            if(Date.now()-window>1000){window=Date.now();count=0;}if(++count>20)throw new Error('rate');
            const m=JSON.parse(bytes.toString('utf8'));if(!m||typeof m!=='object'||Array.isArray(m))throw new Error('shape');seen=Date.now();
            if(!peer) {
              if(m.type!=='register')throw new Error('registration required');
              // Software attestation seam (NOT TPM). Fail-closed when CFP_REQUIRE_ATTESTATION=1.
              let attestResult;
              try {
                attestResult=attestation.verifySoftwareAttestation(m.attestation ? {attestation:m.attestation,signature:m.signature} : (m.softwareAttestation||null), {
                  publicKeyPem: attestMat.publicKeyPem,
                  expectedNodeId: grant.id,
                  allowedOps: grant.operations,
                  require: attestMat.requireAtt
                });
              } catch(err) {
                send({type:'error',error:err.message,attestationHardwareStatus:attestation.HARDWARE_STATUS});
                throw err;
              }
              if(attestResult.ok){
                if(!Array.isArray(m.operations)||m.operations.some(op=>!attestResult.operations.includes(op)))throw new Error('ATTESTATION_OPERATION_MISMATCH');
                attestationDeadline=attestResult.expiresAt;
              }
              peer=fabric.register(grant,m.operations,send,{attestationLabel:attestResult.label,attestationKind:attestResult.kind});
              send({type:'welcome',node:grant.id,heartbeatMs:3000,attestation:attestResult.label,attestationHardware:false,attestationHardwareStatus:attestation.HARDWARE_STATUS});
              fabric.tick().catch(()=>ws.close(1011,'control unavailable'));return;
            }
            if(m.type==='heartbeat'){peer.seen=Date.now();return;}
            if(m.type==='receipt'){fabric.receipt(peer,m).then(r=>send(r)).catch(()=>ws.close(1008,'receipt rejected'));return;}
            throw new Error('unknown message');
          }catch{ws.close(1008,'bad agent message');}
        });
        ws.on('close',()=>{clearInterval(timer);sockets.delete(ws);if(peer)fabric.disconnect(peer).catch(()=>{});});
      }catch{rejectUpgrade(socket,503,'admission unavailable');}
    };
    gw.server.on('upgrade',upgrade);
    const address=await gw.listen();bridge.url=`http://127.0.0.1:${address.port}/internal/fabric`;
    let port=address.port;
    if(options.tls) {
      external=https.createServer({cert:fs.readFileSync(options.tls.cert),key:fs.readFileSync(options.tls.key)},request);
      external.on('upgrade',upgrade);external.on('clientError',(_e,s)=>s.destroy());external.headersTimeout=10000;external.requestTimeout=10000;
      await new Promise((resolve,reject)=>{external.once('error',reject);external.listen(options.port,options.host||'0.0.0.0',resolve);});port=external.address().port;
    }
    tick=setInterval(()=>fabric.tick().catch(e=>{console.error('fabric control failure:',redactSecrets(e.message));for(const ws of sockets)ws.close(1011,'control unavailable');}),3000);
    return {fabric,gw,port,bridge,internalPort:address.port,attestation:{require:attestMat.requireAtt,pubkeyPresent:!!attestMat.publicKeyPem,kind:attestation.KIND,hardwareStatus:attestation.HARDWARE_STATUS},
      async stop(){clearInterval(tick);for(const ws of sockets)ws.terminate(1001,'hub stopped');if(external){external.close();external.closeAllConnections();}await gw.shutdown();await fabric.tail;releaseLock();}};
  } catch(e) {clearInterval(tick);if(external)external.close();if(gw)await gw.shutdown();releaseLock();throw e;}
}
module.exports={createHub};
