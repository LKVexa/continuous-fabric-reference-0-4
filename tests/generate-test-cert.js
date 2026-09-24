'use strict';
// Ephemeral loopback-only test certificates. Never used by application startup.
const crypto=require('node:crypto');
const fs=require('node:fs');
function der(tag,...parts){
  const body=Buffer.concat(parts);
  let size=body.length,bytes=[];
  if(size<128)bytes=[size];
  else {while(size){bytes.unshift(size&255);size>>>=8;}bytes.unshift(128|bytes.length);}
  return Buffer.concat([Buffer.from([tag,...bytes]),body]);
}
const seq=(...parts)=>der(0x30,...parts);
const oid=hex=>der(6,Buffer.from(hex,'hex'));
const pem=(label,bytes)=>`-----BEGIN ${label}-----\n${bytes.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;
function generateTestCert(keyFile,certFile){
  const {publicKey,privateKey}=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
  const algorithm=seq(oid('2a864886f70d01010b'),der(5,Buffer.alloc(0)));
  const name=seq(der(0x31,seq(oid('550403'),der(0x0c,Buffer.from('CFP ephemeral loopback test')))));
  const utc=ms=>der(0x17,Buffer.from(new Date(ms).toISOString().replace(/[-:]/g,'').slice(2,15).replace('T','')+'Z'));
  const serial=crypto.randomBytes(16);serial[0]|=128;
  const extensions=der(0xa3,seq(
    seq(oid('551d13'),der(1,Buffer.from([255])),der(4,seq(der(1,Buffer.from([255]))))),
    seq(oid('551d11'),der(4,seq(der(0x82,Buffer.from('localhost')),der(0x87,Buffer.from([127,0,0,1])))))
  ));
  const body=seq(der(0xa0,der(2,Buffer.from([2]))),der(2,Buffer.concat([Buffer.from([0]),serial])),algorithm,name,
    seq(utc(Date.now()-60000),utc(Date.now()+86400000)),name,publicKey.export({type:'spki',format:'der'}),extensions);
  const certificate=pem('CERTIFICATE',seq(body,algorithm,der(3,Buffer.concat([Buffer.from([0]),crypto.sign('RSA-SHA256',body,privateKey)]))));
  const parsed=new crypto.X509Certificate(certificate);
  if(!parsed.verify(publicKey)||parsed.checkIP('127.0.0.1')!=='127.0.0.1'||parsed.checkHost('localhost')!=='localhost')throw new Error('Invalid generated test certificate');
  fs.writeFileSync(keyFile,privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
  fs.writeFileSync(certFile,certificate,{mode:0o600});
}
module.exports={generateTestCert};
