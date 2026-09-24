'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');

function realDestination(value){
  let current=path.resolve(value),suffix=[];
  while(!fs.existsSync(current)){suffix.unshift(path.basename(current));const parent=path.dirname(current);if(parent===current)throw new Error('BACKUP_PATH_INVALID');current=parent;}
  return path.join(fs.realpathSync(current),...suffix);
}
function contains(parent,child){const rel=path.relative(parent,child);return rel===''||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel));}
function validateCopy(src,dest){
  const from=fs.realpathSync(src),to=realDestination(dest);
  if(contains(from,to)||contains(to,from))throw new Error('BACKUP_PATH_OVERLAP');
  if(!fs.statSync(from).isDirectory())throw new Error('BACKUP_SOURCE_NOT_DIRECTORY');
  const files=[];
  function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    const file=path.join(dir,entry.name);
    if(entry.isSymbolicLink())throw new Error('BACKUP_LINK_REFUSED');
    if(entry.isDirectory())walk(file);
    else if(entry.isFile()&&!entry.name.endsWith('.lock'))files.push(path.relative(from,file));
    else if(!entry.isFile())throw new Error('BACKUP_SPECIAL_FILE_REFUSED');
  }}
  walk(from);return {from,to,files};
}
function copyTree(src,dest){
  const {from,to,files}=validateCopy(src,dest);
  if(fs.existsSync(to)&&fs.readdirSync(to).length)throw new Error('BACKUP_DEST_NOT_EMPTY');
  fs.mkdirSync(to,{recursive:true,mode:0o700});
  for(const rel of files){const target=path.join(to,rel);fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});fs.copyFileSync(path.join(from,rel),target,fs.constants.COPYFILE_EXCL);fs.chmodSync(target,0o600);}
}
function restoreTree(src,dest){
  const {to}=validateCopy(src,dest);
  if(fs.existsSync(path.join(to,'hub.lock')))throw new Error('RESTORE_DEST_LOCKED: stop the destination hub and recover its lock first');
  const staged=to+'.restore-'+randomUUID();
  let previous=null;
  try {
    copyTree(src,staged);
    if(fs.existsSync(to)){previous=to+'.pre-restore-'+randomUUID();fs.renameSync(to,previous);}
    try {fs.renameSync(staged,to);} catch(error){if(previous&&!fs.existsSync(to))fs.renameSync(previous,to);throw error;}
    return {previous};
  } finally {
    // Only the unique staging sibling created above can be removed here.
    if(path.dirname(staged)===path.dirname(to)&&staged.startsWith(to+'.restore-')&&fs.existsSync(staged))fs.rmSync(staged,{recursive:true,force:true});
  }
}
module.exports={copyTree,restoreTree,validateCopy};
