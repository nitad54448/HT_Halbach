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
    const evaluateIn=async(sessionId,expression)=>{const r=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},sessionId);if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
    const evaluate=expression=>evaluateIn(session,expression);
    const navigate=async targetUrl=>{await cdp('Page.navigate',{url:targetUrl},session);await eventually(()=>evaluate('document.readyState === "complete" && !!window.HH?.debugState && !HH.debugState().accessChecking'));};
    await cdp('Page.enable',{},session);
    await cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false},session);
    await cdp('Page.navigate',{url:url+'/test/workflow.html'},session);
    const workflow=await eventually(async()=>{const text=await evaluate('document.getElementById("results")?.textContent');return /^(PASS|FAIL)/.test(text||'')&&text;},30000);
    assert(workflow.startsWith('PASS'),workflow);console.log(workflow.split('\n')[0]);
    await cdp('Page.navigate',{url:url+'/test/temperature-workflow.html'},session);
    const temperatureWorkflow=await eventually(async()=>{const text=await evaluate('document.getElementById("results")?.textContent');return /^(PASS|FAIL)/.test(text||'')&&text;},30000);
    assert(temperatureWorkflow.startsWith('PASS'),temperatureWorkflow);console.log(temperatureWorkflow.split('\n')[0]);
    await navigate(url+'/index.html');
    assert.equal(await evaluate('HH.debugState().accessMode'),'workstation');
    assert.equal(await evaluate('!!document.querySelector("#splash-modal, #rust-token")'),false);
    const pristineProject=await evaluate('JSON.stringify(HH.debugState().P)');
    await evaluate('document.querySelector(".help-tip").focus()');
    assert.equal(await evaluate('getComputedStyle(document.getElementById("workstation-help")).display'),'block','Startup tooltip opens on keyboard focus');
    await evaluate('document.querySelector(".help-tip").blur()');
    assert.equal(await evaluate('getComputedStyle(document.getElementById("workstation-help")).display'),'none','Startup tooltip closes when focus leaves');
    await evaluate('document.querySelector("[data-theme-switch]").click()');
    assert.equal(await evaluate('document.documentElement.dataset.theme'),'dark');
    assert.equal(await evaluate('getComputedStyle(document.documentElement).colorScheme'),'dark');
    assert.equal(await evaluate('JSON.stringify(HH.debugState().P)'),pristineProject,'Changing appearance must preserve the project');
    await navigate(url+'/index.html');
    assert.equal(await evaluate('document.querySelector("[data-theme-switch]").checked'),true,'Dark mode persists after reload');
    await evaluate('document.querySelector("[data-theme-switch]").click()');
    await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:true},session).then(r=>fs.writeFileSync(path.join(artifacts,'workstation-method.png'),Buffer.from(r.data,'base64')));
    await evaluate('document.getElementById("method-fixed").click()');
    await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:true},session).then(r=>fs.writeFileSync(path.join(artifacts,'method-dc-options.png'),Buffer.from(r.data,'base64')));
    await evaluate('document.getElementById("method-rotating").click()');
    await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:true},session).then(r=>fs.writeFileSync(path.join(artifacts,'method-ac-options.png'),Buffer.from(r.data,'base64')));
    await evaluate(`(async()=>{window.confirm=()=>true;const p=HH.newTestProject();p.tempProgram=[HH.makeStep('goto',{T:300,rate:1}),HH.makeStep('measure',{repeats:5}),HH.makeStep('scan',{T:305,rate:0.1})];await document.getElementById('pr-load').onchange({target:{files:[new File([JSON.stringify(p)],'setup.hallproj.json')],value:''}});document.querySelector('#tabs [data-id=hardware]').click();await document.getElementById('check-connections').onclick();document.querySelector('#tabs [data-id=temp]').click();})()`);
    await evaluate('document.querySelector("#tabs [data-id=hardware]").click();document.querySelector("#hw-subtabs [data-sub=magnet]").click()');
    await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:true},session).then(r=>fs.writeFileSync(path.join(artifacts,'workstation-devices.png'),Buffer.from(r.data,'base64')));
    await evaluate('document.getElementById("device-configuration").open=false');
    assert.equal(await evaluate('document.getElementById("actual-values-panel").getBoundingClientRect().top>=document.getElementById("device-configuration").getBoundingClientRect().bottom'),true,'Live readings follow collapsed configuration');
    await evaluate('document.querySelector("#tabs [data-id=run]").click()');
    await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:true},session).then(r=>fs.writeFileSync(path.join(artifacts,'workstation-run.png'),Buffer.from(r.data,'base64')));
    assert.equal(await evaluate('document.getElementById("actual-values-panel").closest("#p-run")!==null'),true);
    await evaluate('document.querySelector("#tabs [data-id=temp]").click()');
    await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:true},session).then(r=>fs.writeFileSync(path.join(artifacts,'workstation-program.png'),Buffer.from(r.data,'base64')));
    await evaluate('document.querySelector("[data-theme-switch]").click()');
    await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:true},session).then(r=>fs.writeFileSync(path.join(artifacts,'workstation-program-dark.png'),Buffer.from(r.data,'base64')));
    await evaluate('document.querySelector("[data-theme-switch]").click()');
    const fixture=await evaluate(`(async()=>{
      const p=HH.newTestProject();p.hardware.temperature='off';p.sample.id='QA-HALL';p.sample.rsq_ohm=100;
      const result=await HH.acquire(p,{},()=>295,42);
      p.runs=[{id:'measured',samples:result.samples,T_mean:null,sample:{...p.sample},method:JSON.parse(JSON.stringify(p.method)),simulated:false,fit:{A1:999}},
        {id:'simulated',samples:JSON.parse(JSON.stringify(result.samples)),T_mean:300,simulated:true},
        {id:'partial',samples:JSON.parse(JSON.stringify(result.samples)),incomplete:true,T_mean:null,simulated:false}];
      p.runs[0].samples.X[0]=null;p.runs[0].samples.T.fill(null);return JSON.stringify(p);
    })()`);
    const load=async text=>evaluate(`(async()=>{window.confirm=()=>true;await document.getElementById('pr-load').onchange({target:{files:[new File([${JSON.stringify(text)}],'qa.hallproj.json')],value:''}});return HH.debugState().P.runs.length;})()`);
    assert.equal(await load(fixture),3);
    assert.equal(await evaluate('HH.debugState().P.runs[0].fit.A1 !== 999'),true);
    assert.equal(await evaluate('document.querySelectorAll("#a-table tr").length'),4);
    assert.equal(await evaluate('document.getElementById("a-notice").textContent.includes("run number")'),true);
    await evaluate('document.querySelector("[data-theme-switch]").click()');
    const darkPixel=await evaluate('Array.from(document.getElementById("c-ns").getContext("2d").getImageData(0,0,1,1).data)');
    assert(darkPixel[0]<70&&darkPixel[1]<70,'Changing theme repaints plot pixels');
    const helpHref=await evaluate('document.getElementById("help-link").href');
    assert(helpHref.endsWith('help.html#analysis'),'Help opens the relevant documentation section');
    const priorTargets=new Set((await cdp('Target.getTargets')).targetInfos.map(t=>t.targetId));
    await cdp('Runtime.evaluate',{expression:'document.getElementById("help-link").click()',userGesture:true},session);
    const helpTarget=await eventually(async()=>{const targets=(await cdp('Target.getTargets')).targetInfos;return targets.find(t=>!priorTargets.has(t.targetId)&&t.url===helpHref);});
    const helpSession=(await cdp('Target.attachToTarget',{targetId:helpTarget.targetId,flatten:true})).sessionId;
    await cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false},helpSession);
    const helpEvaluate=expression=>evaluateIn(helpSession,expression);
    await eventually(()=>helpEvaluate('document.readyState==="complete" && document.getElementById("help-search") && !document.getElementById("help-search").disabled'));
    assert.equal(await helpEvaluate('document.documentElement.dataset.theme'),'dark','Help inherits the selected theme');
    assert.equal(await helpEvaluate('typeof HHHardware'),'undefined','Help never initializes a hardware connection');
    assert.equal(await helpEvaluate('document.querySelectorAll(".doc-section").length'),16);
    assert(await helpEvaluate('document.querySelectorAll("math").length')>=20,'Equations are rendered using native MathML');
    assert.equal(await helpEvaluate('[...document.querySelectorAll("[data-doc-link]")].every(a=>!!document.getElementById(a.hash.slice(1)))'),true,'All documentation contents links resolve');
    assert.equal(await helpEvaluate('document.documentElement.scrollWidth<=innerWidth'),true,'Desktop documentation fits its viewport');
    await helpEvaluate('document.getElementById("help-search").value="Hall coefficient";document.getElementById("help-search").dispatchEvent(new Event("input"))');
    assert.equal(await helpEvaluate('document.getElementById("properties").hidden'),false);
    await helpEvaluate('document.getElementById("help-search").value="no-such-topic-xyz";document.getElementById("help-search").dispatchEvent(new Event("input"))');
    assert.equal(await helpEvaluate('document.getElementById("help-empty").hidden'),false);
    await cdp('Emulation.setEmulatedMedia',{media:'print'},helpSession);
    assert.equal(await helpEvaluate('[...document.querySelectorAll(".doc-section")].every(s=>getComputedStyle(s).display!=="none")'),true,'Printing includes every documentation section');
    assert.equal(await helpEvaluate('getComputedStyle(document.querySelector("math")).color'),'rgb(0, 0, 0)','Printed equations remain legible from dark mode');
    await cdp('Emulation.setEmulatedMedia',{media:''},helpSession);
    await helpEvaluate('document.getElementById("help-clear").click();document.getElementById("properties").scrollIntoView()');
    await cdp('Page.captureScreenshot',{format:'png'},helpSession).then(r=>fs.writeFileSync(path.join(artifacts,'help-equations-dark.png'),Buffer.from(r.data,'base64')));
    await helpEvaluate('document.querySelector("[data-theme-switch]").click()');
    await eventually(()=>evaluate('HHTheme.current()==="light"'));
    const lightPixel=await evaluate('Array.from(document.getElementById("c-ns").getContext("2d").getImageData(0,0,1,1).data)');
    assert(lightPixel[0]>240&&lightPixel[1]>240,'A Help-tab preference change repaints workstation plots');
    await cdp('Network.enable',{},helpSession);
    await cdp('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:-1,uploadThroughput:-1},helpSession);
    await cdp('Page.navigate',{url:'file:///'+path.join(root,'app/help.html').replaceAll('\\','/')+'#properties'},helpSession);
    await eventually(()=>helpEvaluate('document.readyState==="complete" && !!window.HHTheme && !!document.querySelector("math")'));
    assert.equal(await helpEvaluate('document.querySelectorAll(".doc-section").length'),16,'Complete Help works from local files with networking disabled');
    await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true},helpSession);
    assert.equal(await helpEvaluate('document.documentElement.scrollWidth<=innerWidth'),true,'Equations scroll inside the mobile documentation layout');
    assert.equal(fs.readFileSync(path.join(root,'app/docs/chirp-guide.md'),'utf8'),fs.readFileSync(path.join(root,'README - Chirp.md'),'utf8'),'The full source guide is packaged locally');
    await cdp('Target.closeTarget',{targetId:helpTarget.targetId});
    console.log('PASS: Devices navigation, persistent dark mode, plot repaint, contextual Help, offline equations, search and printing');
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
    if(service) {
      const stopper=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'rust-backend/stop.ps1'),'-Port',new URL(url).port,'-WaitSeconds','5'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
      let shutdownOutput='';for(const stream of [stopper.stdout,stopper.stderr])stream.on('data',chunk=>shutdownOutput+=chunk.toString());
      const stopCode=await new Promise((resolve,reject)=>{stopper.once('error',reject);stopper.once('exit',resolve);});
      assert.equal(stopCode,0,shutdownOutput);
      await eventually(()=>service.exitCode!==null,3000);
      assert.equal(service.exitCode,0,'Shutdown must exit cleanly after cleanup');
      assert(shutdownOutput.includes('Workstation service stopped.'));
      console.log('PASS: stop.ps1 shuts down an isolated service and waits for process exit');
    }
  } finally {if(socket)socket.close();browser.kill();if(service)service.kill();staticServer.closeAllConnections();await new Promise(r=>staticServer.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
