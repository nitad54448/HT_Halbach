const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync(require.resolve('../js/backend.js'),'utf8');
function bridge(hostname, protocol='http:', embedded=false) {
  const calls=[],saved=new Map(),location={hostname,protocol,origin:protocol+'//'+hostname+':18865'};
  const window={__HALBACH_SERVICE__:embedded};
  const context={window,location,URL,AbortController,setTimeout,clearTimeout,localStorage:{getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v)},sessionStorage:{removeItem:k=>saved.delete(k)},
    fetch:async(url,options)=>{calls.push({url,options});return {ok:true,status:200,json:async()=>url.endsWith('/session')?{backend:'rust',mode:'workstation',token:'automatic-test-token-1234'}:{ok:true,identity:'fake'}};}};
  vm.runInNewContext(source,context);return {api:window.HHHardware,calls,saved,context};
}
(async()=>{
  for(const host of ['lab.github.io','192.168.1.40','localhost.evil']) {
    const b=bridge(host);assert.equal((await b.api.connect()).ok,false);
    b.api.configure({baseUrl:'http://127.0.0.1:8765',token:'manual-token-cannot-unlock'});
    await assert.rejects(b.api.checkDevice({}),/local workstation/);assert.equal(b.calls.length,0);
  }
  const file=bridge('','file:');assert.equal((await file.api.connect()).ok,false);assert.equal(file.calls.length,0);
  const b=bridge('127.0.0.1','http:',true);assert.equal((await b.api.connect()).ok,true);
  assert.equal(b.calls[0].url,'http://127.0.0.1:18865/api/session');
  await b.api.checkDevice({role:'fake'});assert.equal(b.calls[1].options.headers['X-Halbach-Token'],'automatic-test-token-1234');
  assert(!('token' in b.api.settings()));assert(![...b.saved.keys()].some(k=>k.includes('token')));
  b.api.configure({baseUrl:'http://localhost:5502'});assert.equal(b.api.settings().connected,false);
  await assert.rejects(b.api.readDevice({}),/local workstation/);
  for(const url of ['http://192.168.1.40:8765','http://localhost.evil','http://user:pass@localhost:8765','http://localhost:8765/path']) assert.throws(()=>b.api.configure({baseUrl:url}),/local service URL/);
  const denied=bridge('localhost');denied.context.fetch=async()=>({ok:false,status:403,json:async()=>({error:'Denied'})});assert.equal((await denied.api.connect()).ok,false);
  const old=bridge('localhost');old.context.fetch=async()=>({ok:true,status:200,json:async()=>({ok:true})});assert.equal((await old.api.connect()).ok,false);
  console.log('LOCAL / REMOTE ACCESS REGRESSION TESTS PASSED');
})().catch(e=>{console.error(e);process.exitCode=1;});
