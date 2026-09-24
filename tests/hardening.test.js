'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {atomic,sha,token}=require('../lib/common');
const {startAgent}=require('../lib/agent');
const {createIdentity}=require('../runtime/hermit/gateway/auth');

function temp(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cfp-hardening-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}

test('rotated or revoked credential cannot borrow validity from another token for the same principal',t=>{
  const file=path.join(temp(t),'principals.json'),old=token(),replacement=token();
  const principal={sub:'operator',tenant:'fabric',capabilities:['terminal','fabric']};
  atomic(file,[{...principal,tokenSha256:sha(old)}]);
  const provider=createIdentity({auth:'static-file',principalsFile:file},{info(){},error(){}});
  const session=provider.authenticate(old);assert.ok(provider.stillValid(session));
  atomic(file,[{...principal,tokenSha256:sha(old),revoked:true},{...principal,tokenSha256:sha(replacement)}]);
  fs.utimesSync(file,new Date(),new Date(Date.now()+1000));
  assert.equal(provider.authenticate(old),null);
  assert.equal(provider.stillValid(session),false);
  assert.ok(provider.stillValid(provider.authenticate(replacement)));
});

test('failed atomic writes remove temporary credential files',t=>{
  const dir=temp(t),file=path.join(dir,'value.json');
  const cyclic={};cyclic.self=cyclic;
  assert.throws(()=>atomic(file,cyclic));
  assert.deepEqual(fs.readdirSync(dir),[]);
  fs.mkdirSync(file);
  assert.throws(()=>atomic(file,{secret:'test-only'}));
  assert.deepEqual(fs.readdirSync(dir),['value.json']);
});

test('invalid receipt state and failed initialization do not strand an agent lock',t=>{
  const dir=temp(t),stateFile=path.join(dir,'receipts.json');
  const config={url:'ws://127.0.0.1/ws/agent',token:token(),operations:['echo'],stateFile};
  for(const contents of ['null','[]','{"__proto__":{}}','{"bad":{"state":"EXECUTING"}}']) {
    fs.writeFileSync(stateFile,contents);
    assert.throws(()=>startAgent(config),/BAD_RECEIPT_STORE/);
    assert.equal(fs.existsSync(stateFile+'.lock'),false);
  }
});

test('agent validates local credentials and operation grants before creating state',t=>{
  const stateFile=path.join(temp(t),'receipts.json');
  const valid={url:'ws://127.0.0.1/ws/agent',token:token(),operations:['echo'],stateFile};
  assert.throws(()=>startAgent({...valid,token:'invalid'}),/BAD_AGENT_TOKEN/);
  assert.throws(()=>startAgent({...valid,operations:['shell']}),/BAD_AGENT_OPERATIONS/);
  assert.throws(()=>startAgent({...valid,url:'wss://host/ws/agent?token=x'}),/BAD_AGENT_URL/);
  assert.equal(fs.existsSync(stateFile+'.lock'),false);
});

async function fakeAgent(t){
  const original=globalThis.WebSocket;
  class FakeSocket extends EventTarget {
    constructor(){super();this.readyState=1;this.bufferedAmount=0;queueMicrotask(()=>this.dispatchEvent(new Event('open')));}
    send(){}
    close(code){if(this.readyState===3)return;this.code=code;this.readyState=3;this.dispatchEvent(new Event('close'));}
    message(value){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(value)}));}
  }
  globalThis.WebSocket=FakeSocket;t.after(()=>{globalThis.WebSocket=original;});
  const states=[],agent=startAgent({url:'ws://127.0.0.1/ws/agent',token:token(),operations:['echo'],stateFile:path.join(temp(t),'receipts.json')},{onState:s=>states.push(s)});
  t.after(async()=>agent.stop());
  await new Promise(resolve=>setImmediate(resolve));
  return {agent,states};
}

test('receipt acknowledgements cannot mutate Object.prototype',async t=>{
  const {agent,states}=await fakeAgent(t);
  agent.socket.message({type:'welcome'});
  agent.socket.message({type:'receipt.ack',id:'__proto__'});
  assert.equal(Object.hasOwn(Object.prototype,'acked'),false);
  assert.ok(states.some(s=>s.includes('BAD_RECEIPT_ACK')));
  assert.equal(agent.socket.code,4008);
});

test('duplicate welcome is rejected instead of leaking heartbeat timers',async t=>{
  const {agent,states}=await fakeAgent(t);
  agent.socket.message({type:'welcome'});assert.equal(agent.ready,true);
  agent.socket.message({type:'welcome'});
  assert.ok(states.some(s=>s.includes('DUPLICATE_WELCOME')));
  assert.equal(agent.socket.code,4008);
});

test('agent limits incoming messages by UTF-8 bytes',async t=>{
  const {agent,states}=await fakeAgent(t);
  agent.socket.message({type:'welcome',padding:'é'.repeat(32768)});
  assert.ok(states.some(s=>s.includes('BAD_MESSAGE')));
  assert.equal(agent.ready,false);
});
