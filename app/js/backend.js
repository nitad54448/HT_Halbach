/* Local Rust bridge. Remote pages never contact instruments or obtain a session. */
(function () {
  'use strict';
  const localPage = ['http:', 'https:'].includes(location.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname);
  const DEFAULT_URL = 'http://127.0.0.1:8765';
  let savedUrl;
  try { savedUrl = localStorage.getItem('halbach.rust.url'); sessionStorage.removeItem('halbach.rust.token'); } catch (_) {}
  let baseUrl = window.__HALBACH_SERVICE__ ? location.origin : savedUrl || DEFAULT_URL;
  let token = '', connected = false;
  function normalize(value) {
    const u = new URL(value);
    if (!['http:', 'https:'].includes(u.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || u.username || u.password || u.search || u.hash || !['', '/'].includes(u.pathname)) throw new Error('Use a local service URL, such as http://127.0.0.1:8765.');
    return u.origin;
  }
  try { baseUrl = normalize(baseUrl); } catch (_) { baseUrl = DEFAULT_URL; }
  async function fetchJson(path, options, timeout) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(baseUrl + '/api/' + path, { ...options, mode: 'cors', targetAddressSpace: 'loopback', cache: 'no-store', signal: controller.signal });
      const result = await response.json();
      if (!response.ok) {
        if (response.status === 403) { connected = false; token = ''; }
        throw new Error(result.error || 'Local service request failed.');
      }
      return result;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('Local service request timed out.');
      if (e instanceof TypeError) throw new Error('Cannot reach the local Rust service. Start start-workstation.bat on this computer.');
      throw e;
    } finally { clearTimeout(timer); }
  }
  async function connect() {
    connected = false; token = '';
    if (!localPage) return { ok: false, mode: 'analysis', error: 'This computer is in analysis mode. Open the local workstation URL on the measurement PC to acquire data.' };
    try {
      const result = await fetchJson('session', { method: 'GET' }, 4000);
      if (result.backend !== 'rust' || result.mode !== 'workstation' || typeof result.token !== 'string' || result.token.length < 16) throw new Error('The service does not support automatic local sessions. Restart it using start-workstation.bat.');
      token = result.token; connected = true;
      return { ok: true, mode: 'workstation' };
    } catch (e) { return { ok: false, mode: 'analysis', error: e.message }; }
  }
  function request(path, data, timeout = 8000) {
    if (!localPage || !connected || !token) return Promise.reject(new Error('Measurement controls require a connected local workstation.'));
    return fetchJson(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Halbach-Token': token }, body: JSON.stringify(data) }, timeout);
  }
  const projectConfig = p => ({ hardware: p.hardware, method: p.method, sample: p.sample, tempProgram: p.tempProgram });
  window.HHHardware = {
    isLocalPage: localPage,
    settings: () => ({ baseUrl, connected }),
    configure: settings => { baseUrl = normalize(settings.baseUrl); connected = false; token = ''; try { localStorage.setItem('halbach.rust.url', baseUrl); } catch (_) {} },
    connect,
    checkDevice: d => request('check', d),
    readDevice: d => request('read', d),
    waitForReference: d => request('lock', d, (d.lockTimeout || 30) * 1000 + 8000),
    startProgram: p => request('run', { project: projectConfig(p) }),
    programStatus: (id, cursor) => request('status', { id, cursor }),
    abortProgram: id => request('abort', { id }),
    pauseProgram: id => request('pause', { id }),
    resumeProgram: (id, p) => request('resume', { id, project: projectConfig(p) }),
    updateProgram: (id, p) => request('update', { id, project: projectConfig(p) }),
  };
})();
