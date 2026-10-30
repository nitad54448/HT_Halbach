/* Browser regression suite. Build the debug Rust service, then run
 * node app/test/browser.js. Uses installed Chrome; no npm dependencies. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {spawn}=require('node:child_process');
const root=path.resolve(__dirname,'../..'),artifacts=path.join(root,'.browser-test'),url=process.env.HALBACH_TEST_URL||'http://127.0.0.1:18865';
const chrome=process.env.CHROME_BIN||'C:/Program Files/Google/Chrome/Application/chrome.exe';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function eventually(fn,timeout=15000){const until=Date.now()+timeout;let last;while(Date.now()<until){try{const result=await fn();if(result)return result;}catch(e){last=e;}await pause(50);}throw last||Error('Timed out');}
(async()=>{
  fs.mkdirSync(artifacts,{recursive:true});
  let service;
  if(!process.env.HALBACH_TEST_URL) {
    service=spawn(path.join(root,'rust-backend/target/debug/halbach-service.exe'),['--port','18865','--ui-dir',path.join(root,'app'),'--data-dir',path.join(artifacts,'service-data')],{windowsHide:true,stdio:'ignore'});
  }
  await eventually(async()=>{const r=await fetch(url+'/api/health',{signal:AbortSignal.timeout(1000)});return r.ok;});
  const profile=fs.mkdtempSync(path.join(artifacts,'qa-'));
  const staticServer=http.createServer((req,res)=>{
    const filename=path.resolve(root,'app','.'+new URL(req.url,'http://test').pathname);
    if(!filename.startsWith(path.join(root,'app')+path.sep)){res.writeHead(403).end();return;}
    fs.readFile(filename.endsWith(path.sep)?filename+'index.html':filename,(err,body)=>{
      if(err){res.writeHead(404).end();return;}
      res.setHeader('Content-Type',filename.endsWith('.js')?'application/javascript':filename.endsWith('.css')?'text/css':'text/html; charset=utf-8');res.end(body);
    });
  });
  await new Promise(r=>staticServer.listen(0,'127.0.0.1',r));
  const browser=spawn(chrome,['--headless=new','--no-sandbox','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+profile,'--host-resolver-rules=MAP analysis.test 127.0.0.1','--no-proxy-server','about:blank'],{windowsHide:true,stdio:'ignore'});
  console.log('Browser started for UI regression tests');
  let socket;
  try {
    const lines=await eventually(()=>{const filename=path.join(profile,'DevToolsActivePort');return fs.existsSync(filename)&&fs.readFileSync(filename,'utf8').split('\n');});
    socket=new WebSocket('ws://127.0.0.1:'+lines[0].trim()+lines[1].trim());
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Browser connection timed out')),10000);socket.onopen=()=>{clearTimeout(timer);resolve();};socket.onerror=e=>{clearTimeout(timer);reject(e);};});
    console.log('Browser automation connected');
    let seq=0;const pending=new Map();
    socket.onmessage=event=>{const message=JSON.parse(event.data);if(message.id){const p=pending.get(message.id);pending.delete(message.id);message.error?p.reject(Error(message.error.message)):p.resolve(message.result);}};
    const cdp=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>{pending.delete(id);reject(Error('Browser command timed out: '+method));},10000);pending.set(id,{resolve:r=>{clearTimeout(timer);resolve(r);},reject:e=>{clearTimeout(timer);reject(e);}});socket.send(JSON.stringify({id,method,params,sessionId}));});
    const target=await cdp('Target.createTarget',{url:'about:blank'}),session=(await cdp('Target.attachToTarget',{targetId:target.targetId,flatten:true})).sessionId;
    const evaluate=async expression=>{const r=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},session);if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
    const navigate=async targetUrl=>{await cdp('Page.navigate',{url:targetUrl},session);await eventually(()=>evaluate('document.readyState === "complete" && !!window.HH?.debugState && !HH.debugState().accessChecking'));};
    await cdp('Page.enable',{},session);
    await cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false},session);
    await cdp('Page.navigate',{url:url+'/test/workflow.html'},session);
    const workflow=await eventually(async()=>{const text=await evaluate('document.getElementById("results")?.textContent');return /^(PASS|FAIL)/.test(text||'')&&text;},30000);
    assert(workflow.startsWith('PASS'),workflow);console.log(workflow.split('\n')[0]);
    await navigate(url+'/index.html');
    assert.equal(await evaluate('HH.debugState().accessMode'),'workstation');
    assert.equal(await evaluate('!!document.querySelector("#splash-modal, #rust-token")'),false);
    const fixture=await evaluate(`(async()=>{
      const p=HH.newTestProject();p.hardware.temperature='off';p.sample.id='QA-HALL';p.sample.rsq_ohm=100;
      const result=await HH.acquire(p,{},()=>295,42);
      p.runs=[{id:'measured',samples:result.samples,T_mean:null,sample:{...p.sample},method:JSON.parse(JSON.stringify(p.method)),simulated:false,fit:{A1:999}},
        {id:'simulated',samples:JSON.parse(JSON.stringify(result.samples)),T_mean:300,simulated:true},
        {id:'partial',samples:JSON.parse(JSON.stringify(result.samples)),incomplete:true,T_mean:null,simulated:false}];
      p.runs[0].samples.X[0]=null;return JSON.stringify(p);
    })()`);
    const load=async text=>evaluate(`(async()=>{window.confirm=()=>true;await document.getElementById('pr-load').onchange({target:{files:[new File([${JSON.stringify(text)}],'qa.hallproj.json')],value:''}});return HH.debugState().P.runs.length;})()`);
    assert.equal(await load(fixture),3);
    assert.equal(await evaluate('HH.debugState().P.runs[0].fit.A1 !== 999'),true);
    assert.equal(await evaluate('document.querySelectorAll("#a-table tr").length'),4);
    assert.equal(await evaluate('document.getElementById("a-notice").textContent.includes("run number")'),true);
    const before=await evaluate('HH.debugState().P.runs[0].derived.RH');
    await evaluate(`document.getElementById('a-thickness').value=200;document.getElementById('a-apply').click()`);
    const after=await evaluate('HH.debugState().P.runs[0].derived.RH');assert(Math.abs(after/before-2)<1e-9);
    assert.equal(await evaluate('HH.debugState().P.runs[0].sample.thickness_nm'),100);
    await evaluate(`document.getElementById('a-inspect').click();document.getElementById('i-mask').click()`);
    assert.equal(await evaluate('document.getElementById("i-mask-status").textContent.includes("Enter finite")'),true);
    await evaluate(`document.getElementById('i-m0').value=0;document.getElementById('i-m1').value=1e9;document.getElementById('i-mask').click()`);
    assert.equal(await evaluate('HH.debugState().P.runs[0].fit'),null);
    await evaluate(`document.getElementById('i-unmask').click();document.querySelector('#tabs [data-id="analysis"]').click()`);
    assert.equal(await evaluate('!!HH.debugState().P.runs[0].fit'),true);
    await evaluate(`URL.createObjectURL=blob=>{window.exportedBlob=blob;return 'blob:qa';};URL.revokeObjectURL=()=>{};HTMLAnchorElement.prototype.click=function(){};document.getElementById('a-csv').click()`);
    const csv=await evaluate('exportedBlob.text()');assert(csv.includes('n (cm⁻³)')&&!/NaN|Infinity|undefined/.test(csv));
    await evaluate(`document.getElementById('pr-save').click()`);
    const saved=JSON.parse(await evaluate('exportedBlob.text()'));assert.equal(saved.runs[0].analysisSample.thickness_nm,200);
    await evaluate(`window.print=()=>{};document.getElementById('pr-report').click()`);
    assert.equal(await evaluate('document.getElementById("report").textContent.includes("Inputs used for each run")'),true);
    await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:true},session).then(r=>fs.writeFileSync(path.join(artifacts,'analysis-desktop.png'),Buffer.from(r.data,'base64')));
    const remote='http://analysis.test:'+staticServer.address().port+'/index.html';
    await navigate(remote);
    assert.equal(await evaluate('HH.debugState().accessMode'),'analysis');
    assert.equal(await load(fixture),3);
    assert.equal(await evaluate('HH.debugState().P.hardware.backend'),'simulation');
    assert.equal(await evaluate('document.querySelector("#tabs [data-id=run]").hidden'),true);
    await evaluate(`document.getElementById('r-start').onclick()`);
    assert.equal(await evaluate('HH.debugState().running'),false);
    for(const tab of ['inspect','history','log','project','analysis']){await evaluate(`document.querySelector('#tabs [data-id="${tab}"]').click()`);assert.equal(await evaluate(`document.getElementById('p-${tab}').classList.contains('active')`),true);}
    await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true},session);
    await evaluate(`window.dispatchEvent(new Event('resize'))`);
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'),true,'Mobile layout must not overflow');
    await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:true},session).then(r=>fs.writeFileSync(path.join(artifacts,'analysis-mobile.png'),Buffer.from(r.data,'base64')));
    await navigate('file:///'+path.join(root,'app/index.html').replaceAll('\\','/'));
    assert.equal(await evaluate('HH.debugState().accessMode'),'analysis');
    assert.equal(await load(fixture),3);
    console.log('PASS: automatic local sessions; raw inspection; geometry corrections; masks; full-precision CSV; save/report; hosted and file analysis modes; mobile layout');
  } finally {if(socket)socket.close();browser.kill();if(service)service.kill();staticServer.closeAllConnections();await new Promise(r=>staticServer.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
