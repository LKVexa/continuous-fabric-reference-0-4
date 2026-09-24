'use strict';
// Controlled, offline baseline probes. No Electron startup, network, host writes,
// dependency installation, or operating-system command execution by the terminal.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = null;
const base = path.resolve(process.argv[2]);
const { SpiralKernel } = require(path.join(base, 'src/main/spiral/kernel.js'));
const { VFS } = require(path.join(base, 'src/main/spiral/vfs.js'));
(async () => {
  const observations = [];
  const kernel = new SpiralKernel();
  let boundId = null, earlyEvents = 0;
  kernel.on('data', e => { if (e.sessionId !== boundId) earlyEvents++; });
  const opened = await Promise.resolve(kernel.openSession({cols:80,rows:24}));
  boundId = opened.sessionId;
  const a = kernel.sessions.get(opened.sessionId);
  const b = kernel.openSession({cols:80,rows:24});
  await Promise.resolve();
  const io = {stdin:{},stdout:{write(){}},stderr:{write(){}},signal:new AbortController().signal};
  const ca = kernel._makeContext(a,{parse:{}},[],io);
  const cb = kernel._makeContext(kernel.sessions.get(b.sessionId),{parse:{}},[],io);
  observations.push({id:'PROBE01',name:'Same-kernel sessions share the same VFS object',observed:ca.vfs===cb.vfs});
  observations.push({id:'PROBE02',name:'Async-open simulation receives data before consumer stores session id',early_events:earlyEvents,scope:'Node async simulation; not an Electron event-order test'});
  kernel.resize(opened.sessionId,-3,0);
  observations.push({id:'PROBE03',name:'Kernel resize accepts invalid geometry',cols:a.cols,rows:a.rows});
  const pending=a.pending;
  let settled=false;
  if(pending) pending.promise.then(()=>{settled=true;});
  kernel.closeSession(opened.sessionId);
  await new Promise(resolve=>setTimeout(resolve,20));
  observations.push({id:'PROBE04',name:'Close does not settle active line reader within 20 ms',pending_exists:!!pending,settled,has_resolver:!!(pending&&pending._resolve)});
  // Complete private reader only as probe cleanup; no source patch is made.
  if(pending) pending._finish(null);
  const bs=kernel.sessions.get(b.sessionId); if(bs&&bs.pending) bs.pending._finish(null);
  kernel.closeSession(b.sessionId);
  const ctx={window:{}}; vm.createContext(ctx);
  for(const f of ['screen.js','parser.js']) vm.runInContext(fs.readFileSync(path.join(base,'src/renderer/vt',f),'utf8'),ctx,{timeout:1000});
  const {Screen,Parser,MAX_SCROLLBACK}=ctx.window.HermitVT;
  const s=new Screen(4,24),parser=new Parser(s);
  parser.write('\x1b]0;'+ 'a'.repeat(8192));
  observations.push({id:'PROBE05',name:'Unterminated OSC retains at least 8194 code units',osc_length:parser.osc.length});
  const iterations=Math.ceil(MAX_SCROLLBACK/23)+1;
  for(let i=0;i<iterations;i++){s.resize(4,1);s.resize(4,24);}
  observations.push({id:'PROBE06',name:'Resize path can exceed the declared scrollback bound',declared_max:MAX_SCROLLBACK,actual:s.scrollback.length});
  const vfs=new VFS();vfs.writeFile('/tmp/probe',Buffer.from([255]));vfs.writeFile('/tmp/probe',Buffer.from([0]),{append:true});
  const value=vfs.readFile('/tmp/probe');
  observations.push({id:'PROBE07',name:'Buffer append is coerced to a string',type:typeof value,actual_hex:Buffer.from(value).toString('hex'),expected_hex:'ff00'});
  process.stdout.write(JSON.stringify({scope:'Offline baseline characterization, not product acceptance tests',node_version:process.version,source_changed:false,observations},null,2)+'\n');
})().catch(e=>{console.error(e);process.exitCode=1;});
