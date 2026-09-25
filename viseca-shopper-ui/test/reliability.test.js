const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { agentTimeoutSeconds, classifyFailure } = require('../turn-reliability');
delete process.env.NODE_USE_ENV_PROXY;
process.env.NO_PROXY = '127.0.0.1,localhost';
const delay = ms => new Promise(r => setTimeout(r, ms));
test('agent deadline leaves response margin within bridge budget', () => {
  assert.equal(agentTimeoutSeconds(890000), 880);
  assert.equal(agentTimeoutSeconds(420000), 410);
  assert.equal(agentTimeoutSeconds(4000), 3);
});
test('runtime failures and exhausted deadlines cannot become retriable no-reply', () => {
  assert.equal(classifyFailure({stderr:'PluginInstanceUnavailableError',timeoutMs:890000}).kind,'infrastructure');
  assert.equal(classifyFailure({stderr:'prepared reply dispatch runtime owner was not published',timeoutMs:890000}).kind,'infrastructure');
  assert.equal(classifyFailure({elapsedMs:880000,timeoutMs:890000}).kind,'agent-timeout');
});
test('bridge passes deadline, returns actionable failures, kills detached child and does not restart work', {timeout:25000}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'shopper-reliability-'));
  const calls = path.join(dir,'calls'); const grand = path.join(dir,'grand');
  const stub = path.join(dir,'cli');
  fs.writeFileSync(stub, `#!/usr/bin/env node
const fs=require('fs'); const a=process.argv.slice(2);
if(a[0]!=='agent'){console.log('{"sessions":[]}');process.exit(0);}
const m=a[a.indexOf('-m')+1]; fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(a)+'\\n');
if(m.startsWith('hang')){const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore',env:process.env}); fs.writeFileSync(${JSON.stringify(grand)},String(c.pid)); c.unref();setInterval(()=>{},1000);}
else if(m.startsWith('infra')){process.stderr.write('PluginInstanceUnavailableError: browser reloaded');console.log('{}');}
else if(m.startsWith('empty')){console.log('{}');}
else console.log(JSON.stringify({finalAssistantVisibleText:'healthy reply'}));
`,{mode:0o700});
  const port = await new Promise(r => {const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
  const server=spawn(process.execPath,[path.join(__dirname,'../server.js')],{env:{...process.env,PORT:String(port),HOST:'127.0.0.1',OPENCLAW_BIN:stub,OPENCLAW_TIMEOUT_MS:'4000',OPENCLAW_OVERALL_BUDGET_MS:'4000',OPENCLAW_LATE_PICKUP_ENABLED:'0',OPENCLAW_ALLOW_AUTOMATIC_RETRY:'0',ACCOUNTS_DATA_DIR:path.join(dir,'data'),POLICY_KEYS_DIR:path.join(dir,'keys'),POLICY_PUB_OUT:path.join(dir,'pub.pem'),POLICY_DIR:path.join(dir,'policies'),DEMO_MODE:'false',ACTIVITY_REPORTING:'off',SHOPPING_WEB_SEARCH:'0'},stdio:'ignore'});
  try {
    const base=`http://127.0.0.1:${port}`;
    for(let i=0;i<80;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await delay(100);}
    const reg=await fetch(base+'/api/auth/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Reliability test',email:'reliability@example.test',password:'isolated-test-only-123'})});
    assert.equal(reg.status,201);
    const cookie=reg.headers.get('set-cookie').split(';')[0];
    const chat=async message => {const r=await fetch(base+'/api/v1/chat',{method:'POST',headers:{'content-type':'application/json',cookie},body:JSON.stringify({message})});return [r.status,await r.json()];};
    assert.equal((await chat('healthy'))[0],200);
    const argv=JSON.parse(fs.readFileSync(calls,'utf8').trim().split('\n')[0]);assert.equal(argv[argv.indexOf('--timeout')+1],'3');
    const [status,body]=await chat('infra');assert.equal(status,502);assert.match(body.error,/browser or agent runtime/);
    const [emptyStatus,empty]=await chat('empty');assert.equal(emptyStatus,502);assert.match(empty.error,/Check Purchases/);
    const started=Date.now();const [hs,h]=await chat('hang');assert.equal(hs,502);assert.match(h.error,/time limit/);assert.ok(Date.now()-started<7000);
    const pid=Number(fs.readFileSync(grand,'utf8'));await delay(300);
    let live=false;try{live=fs.readFileSync(`/proc/${pid}/stat`,'utf8').split(' ')[2]!=='Z';}catch{}assert.equal(live,false,'detached marked child must be killed');
    assert.equal((await chat('healthy again'))[0],200,'capacity recovers after timeout');
    assert.equal(fs.readFileSync(calls,'utf8').trim().split('\n').length,5,'no retry or late agent run');
  } finally {server.kill('SIGKILL');await delay(100);fs.rmSync(dir,{recursive:true,force:true});}
});
