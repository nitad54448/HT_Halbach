/* Native Rust companion for Live Server and GitHub Pages. */
(function () {
  'use strict';
  const DEFAULT_URL='http://127.0.0.1:8765';
  const read=(store,key,fallback)=>{try{return store.getItem(key)||fallback;}catch{return fallback;}};
  let baseUrl=read(localStorage,'halbach.rust.url',DEFAULT_URL);
  let token=read(sessionStorage,'halbach.rust.token','');
  function normalize(value){
    const u=new URL(value);
    if(!['http:','https:'].includes(u.protocol)||!['127.0.0.1','localhost'].includes(u.hostname)||u.username||u.password||u.search||u.hash||!['','/'].includes(u.pathname)) throw new Error('Use a local Rust service URL, such as http://127.0.0.1:8765.');
    return u.origin;
  }
  try{baseUrl=normalize(baseUrl);}catch{baseUrl=DEFAULT_URL;}
  async function request(path, data, timeout = 8000) {
    if (location.protocol === 'file:') throw new Error('Open the UI through Live Server or GitHub Pages, and start the local Rust service.');
    if(!token) throw new Error('Paste the Rust service pairing token in Devices → Local Rust service.');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout);
    try {
      const r = await fetch(baseUrl+'/api/' + path, { method: 'POST', mode:'cors', targetAddressSpace:'loopback', headers: { 'Content-Type': 'application/json', 'X-Halbach-Token': token }, body: JSON.stringify(data), signal: controller.signal });
      const result = await r.json();
      if (!r.ok) throw new Error(result.error || 'Hardware request failed');
      return result;
    } catch (e) { if (e.name === 'AbortError') throw new Error('Rust hardware request timed out'); if(e instanceof TypeError) throw new Error('Cannot reach the local Rust service. Check its URL, --allow-origin setting and browser Local Network Access permission.'); throw e; }
    finally { clearTimeout(timer); }
  }
  window.HHHardware = {
    settings:()=>({baseUrl,token}),
    configure:settings=>{
      baseUrl=normalize(settings.baseUrl);token=String(settings.token||'').trim();
      try{localStorage.setItem('halbach.rust.url',baseUrl);sessionStorage.setItem('halbach.rust.token',token);}catch{}
    },
    checkDevice: d => request('check', d),
    readDevice: d => request('read', d),
    waitForReference: d => request('lock', d, (d.lockTimeout || 30) * 1000 + 8000),
    startProgram: p => request('run', { project: {hardware:p.hardware,method:p.method,sample:p.sample,tempProgram:p.tempProgram} }),
    programStatus: (id,cursor) => request('status', {id,cursor}),
    abortProgram: id => request('abort', {id}),
    pauseProgram: id => request('pause', {id}),
    resumeProgram: (id,p) => request('resume', {id,project:{hardware:p.hardware,method:p.method,sample:p.sample,tempProgram:p.tempProgram}}),
    updateProgram: (id,p) => request('update', {id,project:{hardware:p.hardware,method:p.method,sample:p.sample,tempProgram:p.tempProgram}}),
  };
})();
