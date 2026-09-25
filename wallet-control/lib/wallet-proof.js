import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { canonical, digest, fail } from './wallet-controls.js';

export class WalletProof {
  constructor(directory) {
    fs.mkdirSync(directory,{recursive:true,mode:0o700});
    this.directory=directory;
    const file=path.join(directory,'signing-key.pem');
    if (!fs.existsSync(file)) {
      const pair=crypto.generateKeyPairSync('ed25519');
      fs.writeFileSync(file,pair.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600,flag:'wx'});
    }
    this.privateKey=crypto.createPrivateKey(fs.readFileSync(file));
    this.publicKey=crypto.createPublicKey(this.privateKey).export({type:'spki',format:'pem'}).toString();
    this.keyId=digest(this.publicKey).slice(0,20);
  }
  sign(kind,payload) {
    const document={format:'wallet-proof/1',kind,issued_at:new Date().toISOString(),key_id:this.keyId,payload};
    return {document,signature:crypto.sign(null,Buffer.from(canonical(document)),this.privateKey).toString('base64url')};
  }
  verify(value) {
    try { return value.document?.key_id===this.keyId && value.document?.format==='wallet-proof/1' && crypto.verify(null,Buffer.from(canonical(value.document)),this.publicKey,Buffer.from(value.signature,'base64url')); } catch { return false; }
  }
}

// One writer owns the durable wallet. Another process must not issue authority.
export function acquireWalletLock(file) {
  try { fs.writeFileSync(file,String(process.pid),{flag:'wx',mode:0o600}); }
  catch(err) {
    if(err.code!=='EEXIST') throw err;
    const pid=Number(fs.readFileSync(file,'utf8'));
    if(!Number.isInteger(pid)||pid<1) throw fail('Wallet lock needs operator inspection',503);
    try { process.kill(pid,0); } catch(e) {
      if(e.code!=='ESRCH') throw e;
      fs.unlinkSync(file); return acquireWalletLock(file);
    }
    throw fail('Another process already owns this wallet',503);
  }
  const release=()=>{try {if(fs.readFileSync(file,'utf8')===String(process.pid))fs.unlinkSync(file);}catch{}};
  process.once('exit',release);
  return release;
}

export class DeviceAccess {
  constructor(directory,enabled=true) {
    this.enabled=enabled;this.file=path.join(directory,'devices.json');this.nonces=new Map();
    try { this.devices=JSON.parse(fs.readFileSync(this.file,'utf8')); } catch(e) {if(e.code!=='ENOENT')throw e;this.devices=[];}
    const secret=path.join(directory,'pairing-key');
    if(!fs.existsSync(secret)) fs.writeFileSync(secret,crypto.randomBytes(32).toString('hex'),{mode:0o600,flag:'wx'});
    this.pairingKey=fs.readFileSync(secret,'utf8').trim();
  }
  save(){fs.writeFileSync(this.file+'.pending',JSON.stringify(this.devices),{mode:0o600});fs.renameSync(this.file+'.pending',this.file);}
  list(){return this.devices.map(({key,...d})=>d);}
  request({public_key,name}) {
    if(this.devices.filter(d=>d.status==='pending').length>=25)throw fail('Pairing queue is full',429);
    let key;try{key=crypto.createPublicKey({key:public_key,format:'jwk'});}catch{throw fail('Invalid device key',400);}
    if(key.asymmetricKeyType!=='ec'||key.asymmetricKeyDetails.namedCurve!=='prime256v1')throw fail('Device must use P-256',400);
    const exported=key.export({format:'jwk'}), id=digest(exported).slice(0,24);
    const existing=this.devices.find(d=>d.id===id);if(existing)return {id,status:existing.status};
    const d={id,key:exported,name:String(name||'Browser').slice(0,60),status:'pending',created_at:new Date().toISOString()};
    this.devices.push(d);this.save();return {id,status:d.status};
  }
  setStatus(id,status){const d=this.devices.find(d=>d.id===id);if(!d)throw fail('Unknown device',404);d.status=status;this.save();return {id,status};}
  internalAuthorized(req){const a=Buffer.from(String(req.headers.authorization||'')),b=Buffer.from('Bearer '+this.pairingKey);return a.length===b.length&&crypto.timingSafeEqual(a,b);}
  verify(req,raw) {
    if(!this.enabled)return 'local-test';
    const id=req.headers['x-wallet-device'],ts=req.headers['x-wallet-time'],nonce=req.headers['x-wallet-nonce'],signature=req.headers['x-wallet-signature'];
    const d=this.devices.find(x=>x.id===id&&x.status==='active');
    if(!d||!ts||!Number.isFinite(Number(ts))||!nonce||!signature||Math.abs(Date.now()-Number(ts))>60000||String(nonce).length>100)throw fail('Pair this browser before changing wallet permissions',401);
    for(const [k,until] of this.nonces)if(until<Date.now())this.nonces.delete(k);
    const replay=id+':'+nonce;if(this.nonces.has(replay))throw fail('Request already used',409);
    const message=[req.method,req.url,ts,nonce,crypto.createHash('sha256').update(raw).digest('hex')].join('\n');
    let valid=false;try{valid=crypto.verify('sha256',Buffer.from(message),{key:crypto.createPublicKey({key:d.key,format:'jwk'}),dsaEncoding:'ieee-p1363'},Buffer.from(signature,'base64url'));}catch{}
    if(!valid)throw fail('Invalid device signature',401);
    this.nonces.set(replay,Date.now()+120000);return id;
  }
}
