'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {sha,canonical}=require('./common');
class Journal {
  constructor(file,{maxBytes=32*1024*1024}={}) {
    this.file=file;this.maxBytes=maxBytes;this.seq=0;this.head='0'.repeat(64);this.events=[];
    fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
    if(fs.existsSync(file)) {
      if(fs.statSync(file).size>maxBytes)throw new Error('JOURNAL_LIMIT');
      const raw=fs.readFileSync(file,'utf8');
      if(raw && !raw.endsWith('\n'))throw new Error('JOURNAL_TORN_TAIL: preserve evidence and repair offline');
      for(const line of raw.split('\n').filter(Boolean)) {
        let r;
        try{r=JSON.parse(line);}catch{throw new Error('JOURNAL_INTEGRITY: unparsable record at seq '+(this.seq+1));}
        if(!r||typeof r!=='object'||Array.isArray(r))throw new Error('JOURNAL_INTEGRITY: non-object record at seq '+(this.seq+1));
        const {hash,...body}=r;
        let digest;
        try{digest=sha(canonical(body));}
        catch(e){throw new Error('JOURNAL_INTEGRITY: '+e.message+' at seq '+(this.seq+1));}
        if(r.seq!==this.seq+1||r.prev!==this.head||typeof hash!=='string'||digest!==hash)throw new Error('JOURNAL_INTEGRITY: chain break at seq '+(this.seq+1));
        this.seq=r.seq;this.head=hash;this.events.push(r.event);
      }
    }
  }
  append(event) {
    const body={seq:this.seq+1,prev:this.head,event};const hash=sha(canonical(body));
    const line=JSON.stringify({...body,hash})+'\n';
    if((fs.existsSync(this.file)?fs.statSync(this.file).size:0)+Buffer.byteLength(line)>this.maxBytes)throw new Error('JOURNAL_LIMIT');
    const fd=fs.openSync(this.file,'a',0o600);
    try {fs.writeFileSync(fd,line);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    this.seq++;this.head=hash;this.events.push(event);return event;
  }
  /** Bounded-growth observation for operators; compaction is offline via `cfp archive-journal`. */
  stats() {
    const bytes=fs.existsSync(this.file)?fs.statSync(this.file).size:0;
    return {seq:this.seq,bytes,maxBytes:this.maxBytes,remainingBytes:Math.max(0,this.maxBytes-bytes)};
  }
}
module.exports={Journal};
