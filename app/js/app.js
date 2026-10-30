/* UI controller. Depends on core, lakeshore, analysis, sim, plot (all on window.HH). */
(function () {
  'use strict';
  const HH = window.HH, { Logger, bus, newProject, hist } = HH;
  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fx = (v, d) => (v === undefined || v === null || !isFinite(v)) ? '—' : (Math.abs(v) !== 0 && (Math.abs(v) < 1e-3 || Math.abs(v) >= 1e6) ? v.toExponential(d === undefined ? 3 : d) : (+v.toPrecision(5)).toString());
  const sleepReal = ms => new Promise(r => setTimeout(r, ms));
  function download(name, text, mime) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: mime || 'text/plain' }));
    a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  let P = newProject(), dirty = false;
  const configurationSnapshot = () => JSON.parse(JSON.stringify({sample:P.sample,method:P.method,hardware:P.hardware,tempProgram:P.tempProgram}));
  function nextRunId() { let n=P.runs.length+1;while(P.runs.some(r=>r.id==='run-'+String(n).padStart(3,'0')))n++;return 'run-'+String(n).padStart(3,'0'); }
  let connectionCheck = null, checking = false, referenceChecking=false;
  const connectionKey = () => JSON.stringify([P.hardware, HH.principle(P.method)]);
  const connectionsOk = () => connectionCheck?.ok && connectionCheck.key === connectionKey();
  let configurationReleased = false, appliedMethod = null, appliedProgram=null, parameterBusy = false;
  let realJobId=null;
  const paused = () => running && runner?.state === 'paused';
  const configurationLocked = () => checking || (running ? !paused() : connectionsOk() && !configurationReleased);
  const principlePath = path => ['method.fixed.excitation','method.rotating.excitation','method.fixed.acq'].includes(path);
  let ctrl = null, simDev = null, runner = null, running = false, vnow = 0;
  let trace = { t: [], T: [], sp: [] }, stepState = [], selRun = null;
  let hardwareAuthenticated = false;
  let accessChecking = true;
  const canMeasure = () => hardwareAuthenticated;

  /* ---------------- tabs ---------------- */
  const FLOW = [['mode', 'Method'], ['hardware', 'Devices'], ['sample', 'Sample'], ['temp', 'Experiment setup'], ['run', 'Run'], ['inspect', 'Data inspect'], ['analysis', 'Analysis']];
  const UTIL = [['history', 'History'], ['log', 'Log'], ['project', 'Project & report']];
  let current = 'hardware';
  function stepOk(id) {
    switch (id) {
      case 'hardware': return connectionsOk();
      case 'mode': return HH.principleErrors(P.method).length === 0;
      case 'sample': return HH.sampleErrors(P).length === 0;
      case 'temp': return progErrors().length === 0 && HH.modeErrors(P).length === 0;
      default: return true;
    }
  }
  function reachable(id) {
    if (['inspect','analysis','project','history','log'].includes(id)) return true;
    if (!canMeasure()) return false;
    if (id === 'mode') return true;
    if (running && ['run', 'temp', 'mode', 'hardware'].includes(id)) return true;
    if (UTIL.some(u => u[0] === id)) return true;
    if (P.runs.length && ['inspect', 'analysis'].includes(id)) return true;
    const i = FLOW.findIndex(f => f[0] === id);
    return FLOW.slice(0, i).every(f => stepOk(f[0]));
  }
  function buildTabs() {
    const nav = $('tabs'); nav.replaceChildren();
    FLOW.forEach(([id, t], i) => {
      const b = document.createElement('button'); b.setAttribute('role', 'tab'); b.dataset.id = id;
      b.innerHTML = `<span class="n">${i + 1}</span>${esc(t)}`; b.onclick = () => show(id); nav.append(b);
    });
    const sep = document.createElement('span'); sep.className = 'sep'; nav.append(sep);
    UTIL.forEach(([id, t]) => { const b = document.createElement('button'); b.dataset.id = id; b.textContent = t; b.onclick = () => show(id); nav.append(b); });
  }
  function refreshTabs() {
    document.querySelectorAll('#tabs button').forEach(b => {
      const id = b.dataset.id, ok = reachable(id);
      b.disabled = !ok; b.classList.toggle('active', id === current);
      b.hidden = !canMeasure() && ['mode','hardware','sample','temp','run'].includes(id);
      b.classList.toggle('done', FLOW.some(f => f[0] === id) && ok && id !== current && ['hardware', 'mode', 'sample', 'temp'].includes(id) && stepOk(id));
      b.setAttribute('aria-selected', id === current);
    });
    const i = FLOW.findIndex(f => f[0] === current), inFlow = i >= 0;
    $('pager').style.display = inFlow && canMeasure() ? 'flex' : 'none';
    if (inFlow) { $('back').disabled = i === 0; $('next').disabled = i === FLOW.length - 1 || !reachable(FLOW[i + 1][0]); }
  }
  function show(id) {
    if (!reachable(id)) return;
    current = id;
    const helpSections={mode:'methods',hardware:'devices',sample:'geometry',temp:'temperature',run:'run-control',inspect:'inspection',analysis:'analysis',history:'projects',log:'troubleshooting',project:'projects'};
    $('help-link').href='help.html#'+(helpSections[id]||'introduction');
    document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === 'p-' + id));
    Logger.verbose('UI', 'Tab ' + id);
    renderPage(id); refreshTabs(); window.scrollTo(0, 0);
    setBadges();
  }
  function renderPage(id) {
    ({ mode: renderMode, sample: renderSample, temp: renderProgram, run: renderRun, inspect: renderInspect, analysis: renderAnalysis, history: renderHistory, log: renderLog, hardware: renderHardware })[id]?.();
  }
  $('back').onclick = () => { const i = FLOW.findIndex(f => f[0] === current); if (i > 0) show(FLOW[i - 1][0]); };
  $('next').onclick = () => { const i = FLOW.findIndex(f => f[0] === current); if (i < FLOW.length - 1) show(FLOW[i + 1][0]); };

  /* ---------------- data binding ---------------- */
  function getPath(o, p) { return p.split('.').reduce((a, k) => a?.[k], o); }
  function setPath(o, p, v) { const ks = p.split('.'); const last = ks.pop(); ks.reduce((a, k) => a[k], o)[last] = v; }
  function positiveFieldAngle() { return -(P.hardware.magnet.angle_offset_deg || 0) / (P.hardware.magnet.dir_sign || 1); }
  function buildOptions() {
    document.querySelectorAll('select[data-opts]').forEach(sel => {
      if (sel.childElementCount) return;
      sel.add(new Option(sel.dataset.opts === 'ENCODER' ? 'OWIS internal absolute position' : 'None / not available', ''));
      const t = HH[sel.dataset.opts]; for (const [k, v] of Object.entries(t)) sel.add(new Option(typeof v === 'string' ? v : v.name, k));
    });
  }
  function syncForm() {
    buildOptions();
    document.querySelectorAll('[data-bind]').forEach(el => { const v = getPath(P, el.dataset.bind); el.value = v === null || v === undefined ? '' : String(v); });
    $('f-levels').value = P.method.levels_mA.join(', ');
    $('f-dc-currents').value = P.method.rotating.currents_mA.join(', ');
    $('positive-field-angle').value = positiveFieldAngle();
    const bridge=window.HHHardware.settings?.();
    if(bridge) $('rust-url').value=bridge.baseUrl;
  }
  document.querySelectorAll('[data-bind]').forEach(el => el.addEventListener('change', () => {
    const path = el.dataset.bind; let v = el.value;
    if (!canMeasure()) { syncForm(); return; }
    if(running && path==='hardware.backend') {syncForm();return;}
    if ((path.startsWith('hardware.') || principlePath(path)) && configurationLocked()) { syncForm(); return; }
    if (running && path.startsWith('sample.')) { syncForm(); return; }
    if ('bool' in el.dataset) v = v === 'true';
    else if ('num' in el.dataset) { if (v === '' && 'nullable' in el.dataset) v = null; else { v = Number(v); if (!isFinite(v)) { el.classList.add('bad'); return; } } }
    el.classList.remove('bad');
    const old = getPath(P, path), plusBAngle = positiveFieldAngle(); setPath(P, path, v);
    if (path === 'hardware.magnet.dir_sign') P.hardware.magnet.angle_offset_deg = -v * plusBAngle;
    if (path === 'hardware.source.model') {
      HH.normalizeSourceAddress(P.hardware.source);
      document.querySelector('[data-bind="hardware.source.address"]').value = P.hardware.source.address;
    }
    if (path.startsWith('hardware.') || principlePath(path)) { connectionCheck = null; ctrl = null; simDev = null; }
    if (path === 'hardware.temperature' && v === 'off') {
      P.tempProgram = P.tempProgram.filter(s => !['goto', 'scan', 'heater_off'].includes(s.type));
      if (!P.tempProgram.length) P.tempProgram = [{ type: 'measure', label: 'Room temp' }];
    }
    if (old !== v) { hist(P, 'config', `${path}: ${old} → ${v}`); Logger.verbose('CFG', `${path} = ${v} (was ${old})`); dirty = true; }
    if(running && path.startsWith('method.')&&!principlePath(path)) $('parameter-status').textContent='Edited parameters have not been applied.';
    if (path.startsWith('hardware.tempController')) { if (ctrl) Logger.warn('CFG', 'Reconnect for controller settings to take effect'); }
    renderPage(current); refreshTabs();
  }));
  $('f-levels').addEventListener('change', () => {
    const arr = $('f-levels').value.split(',').map(s => s.trim()).filter(Boolean).map(Number);
    P.method.levels_mA = arr; hist(P, 'config', 'current levels → ' + arr.join(', ')); dirty = true; if(running)$('parameter-status').textContent='Edited parameters have not been applied.';renderMode(); refreshTabs();
  });
  document.querySelectorAll('[data-release-config]').forEach(button=>button.onclick=()=>{
    if(running||checking)return;
    configurationReleased=true;connectionCheck=null;ctrl=null;simDev=null;
    renderPage(current);refreshTabs();
  });
  $('f-dc-currents').addEventListener('change', () => {
    P.method.rotating.currents_mA = $('f-dc-currents').value.replace(/−/g, '-').split(',').map(s => s.trim()).filter(Boolean).map(Number);
    dirty = true; hist(P, 'config', 'DC current sweep updated'); if(running)$('parameter-status').textContent='Edited parameters have not been applied.';renderMode(); refreshTabs();
  });
  async function loadPreset(o) {
    if (!canMeasure()) throw new Error('Measurement presets require the local workstation. Load a project to inspect or analyze data.');
    if (configurationLocked()) throw new Error('Pause or stop before loading a preset.');
    if (o.format !== 'halbach-hall-preset' || !HH.MODES[o.method?.kind]) throw new Error('Invalid measurement preset.');
    const base = newProject();
    for (const k of ['fixed', 'rotating']) Object.assign(base.method[k], o.method[k] || {});
    for (const [k,v] of Object.entries(o.method)) if (!['fixed','rotating'].includes(k)) base.method[k] = v;
    for (const k of ['tempController','magnet','source','measure']) Object.assign(base.hardware[k], o.hardware?.[k] || {});
    for (const k of ['backend','temperature']) if (o.hardware?.[k]) base.hardware[k] = o.hardware[k];
    HH.normalizeSourceAddress(base.hardware.source);
    if (!Array.isArray(base.method.levels_mA) || !Array.isArray(base.method.rotating.currents_mA)) throw new Error('Preset current levels must be arrays.');
    if(base.method.fixed.excitation==='delta') {base.method.fixed.excitation='dc';base.hardware.measure.dc_mode='delta';}
    const errors = HH.principleErrors(base.method);
    if (errors.length) throw new Error('Invalid preset: ' + errors.join(' '));
    P.method = base.method; P.hardware = base.hardware;
    if (P.hardware.temperature === 'off') {
      P.tempProgram = P.tempProgram.filter(s => !['goto', 'scan', 'heater_off'].includes(s.type));
      if (!P.tempProgram.length) P.tempProgram = [{ type: 'measure', label: 'Room temp' }];
    }
    connectionCheck = null; ctrl = null; simDev = null; dirty = true;
    hist(P, 'preset', 'Loaded ' + (o.name || 'preset'));
    syncForm(); renderMode(); refreshTabs();
  }
  async function loadProjectObject(o, name) {
    if (running) throw new Error('Cannot load while a program is running.');
    const np = HH.normalizeProject(o);
    if (dirty && !confirm('Unsaved changes will be lost. Load anyway?')) return;
    P = np; ctrl = null; simDev = null; dirty = false; selRun = P.runs.length ? P.runs[0].id : null;
    np.runs.forEach(fitRun);
    if (Array.isArray(o.log)) {
      Logger.entries = o.log.slice(-Logger.max);
      Logger.seq = Logger.entries.reduce((m, e) => Math.max(m, e.n || 0), 0);
    }
    hist(P, 'project', `loaded ${name} (${P.runs.length} runs)`);
    Logger.info('IO', `Loaded project ${name}: ${P.runs.length} runs`);
    connectionCheck = null; syncForm(); setBadges();
    const loadedMsg = `Loaded ${name}: ${P.runs.length} run${P.runs.length === 1 ? '' : 's'}.`;
    $('mode-msg').innerHTML = `<div class="notice ok">${esc(loadedMsg)}</div>`;
    msg(loadedMsg, 'ok');
    dirty = true;
    show(P.runs.length || !canMeasure() ? 'analysis' : 'mode');
  }
  $('preset-file').onchange = async ev => {
    const f = ev.target.files[0]; ev.target.value = ''; if (!f) return;
    try {
      const text = await f.text();
      const o = JSON.parse(text);
      if (o.format === 'halbach-hall-project') {
        await loadProjectObject(o, f.name);
      } else {
        await loadPreset(o);
      }
    } catch (e) {
      $('mode-msg').innerHTML = `<div class="notice err">${esc(e.message)}</div>`;
    }
  };
  $('save-preset').onclick = () => {
    if (checking) return;
    if (!P.method.kind) { $('preset-save-status').textContent='Choose a method first.'; return; }
    const preset={format:'halbach-hall-preset',version:1,name:HH.MODES[P.method.kind].label,method:JSON.parse(JSON.stringify(P.method)),hardware:JSON.parse(JSON.stringify(P.hardware))};
    download(P.method.kind+'.preset.json',JSON.stringify(preset,null,2),'application/json');
    $('preset-save-status').textContent='Saved method and device settings.';
  };

  /* ---------------- hardware ---------------- */
  $('positive-field-angle').addEventListener('change', () => {
    if (!canMeasure() || configurationLocked()) { syncForm(); return; }
    const input = $('positive-field-angle'), angle = input.valueAsNumber;
    if (!Number.isFinite(angle)) { input.classList.add('bad'); return; }
    input.classList.remove('bad');
    P.hardware.magnet.angle_offset_deg = -angle * (P.hardware.magnet.dir_sign || 1);
    dirty = true; connectionCheck = null; ctrl = null; simDev = null;
    hist(P, 'config', `+B stage angle set to ${angle}°`);
    renderPage(current); refreshTabs();
  });
  $('rust-url').addEventListener('change',()=>{
    if (!window.HHHardware.isLocalPage || configurationLocked()) { syncForm(); return; }
    try{window.HHHardware.configure({baseUrl:$('rust-url').value});hardwareAuthenticated=false;connectionCheck=null;ctrl=null;simDev=null;connectWorkstation();}
    catch(e){$('access-status').textContent=e.message;}
  });
  document.querySelectorAll('#hw-subtabs button').forEach(b => b.onclick = () => {
    document.querySelectorAll('#hw-subtabs button').forEach(x => x.classList.toggle('active', x === b));
    document.querySelectorAll('#p-hardware .subpane').forEach(x => x.classList.toggle('active', x.dataset.pane === b.dataset.sub));
  });
  function renderHardware() {
    const h = P.hardware, src = HH.SOURCES[h.source.model], lines = [];
    $('src-caps').textContent = src ? `Supports: ${[src.dc && 'DC', src.ac && 'AC'].filter(Boolean).join(' and ')}` : '';
    const name = (t, k) => t[k] ? (typeof t[k] === 'string' ? t[k] : t[k].name) : null;
    const row = (type, what, ok) => lines.push(`<tr><td>${esc(type)}</td><td>${what ? esc(what) : '<span class="muted">none</span>'}</td></tr>`);
    row('Temperature', h.temperature === 'off' ? 'OFF' : `${h.temperature}: ${HH.MODELS[h.tempController.model].name}`);
    row('Rotation controller', name(HH.ROTATOR, h.magnet.rotator));
    row('Position source', connectionsOk() ? (connectionCheck.positionSource === 'optical' ? 'Optical encoder (relative angle)' : 'OWIS controller (absolute angle)') : h.magnet.encoder ? 'Optical encoder preferred; OWIS fallback (not checked)' : 'OWIS controller (absolute angle, not checked)');
    row('Current source', name(HH.SOURCES, h.source.model)); row('Nanovoltmeter', name(HH.VOLT, h.measure.volt));
    row('Lock-in 1', name(HH.LOCKIN, h.measure.lockin1)); row('Lock-in 2', name(HH.LOCKIN, h.measure.lockin2));
    const av = HH.availability(h), ok = Object.entries(av).filter(([, a]) => a.ok).map(([k]) => HH.MODES[k].label);
    $('hw-summary').innerHTML = `<table>${lines.join('')}</table><div class="notice ${ok.length ? 'ok' : ''}" style="margin-top:12px">${ok.length ? 'Modes available: ' + esc(ok.join('; ')) : 'No measurement mode is available yet. Declare a current source, a rotation controller, a position detector and a nanovoltmeter or lock-in.'}</div>`;
    const warn = [];
    if (['SR830', 'AMETEK7230', 'MFLI'].includes(h.measure.lockin1) && h.measure.lockin1 === h.measure.lockin2 && h.measure.lockin1_addr && h.measure.lockin1_addr.trim().toUpperCase() === h.measure.lockin2_addr.trim().toUpperCase()) warn.push(`Two ${HH.LOCKIN[h.measure.lockin1]}s share the same address.`);
    $('measure-msg').innerHTML = warn.map(x => `<div class="notice err">${esc(x)}</div>`).join('');
    for(const k of ['lockin1','lockin2']) document.querySelector(`[data-bind="hardware.measure.${k}_addr"]`).placeholder = h.measure[k]==='AMETEK7230' ? '192.168.1.100:50000' : h.measure[k]==='MFLI' ? 'dev1234 or 127.0.0.1:8004/dev1234' : 'GPIB0::8::INSTR';
    document.querySelector('[data-bind="hardware.source.address"]').placeholder = h.source.model === 'MFLI' ? 'dev1234 or 127.0.0.1:8004/dev1234' : h.source.model === 'K6220' ? 'GPIB0::6::INSTR' : 'e.g. GPIB0::12::INSTR or VISA alias';
    if ([h.measure.lockin1,h.measure.lockin2,h.source.model].includes('MFLI')) $('measure-msg').innerHTML+='<p class="muted">Zurich Instruments MFLI: enter the LabOne device ID (e.g. dev1234) or Data Server endpoint host:8004/dev1234.</p>';
    if ([h.measure.lockin1,h.measure.lockin2].includes('AMETEK7230')) $('measure-msg').innerHTML+='<p class="muted">Ametek 7230: enter the Ethernet host/IP or host:50000.</p>';
    setBadges();
    $('connection-results').innerHTML = connectionCheck && connectionCheck.key === connectionKey()
      ? connectionCheck.results.map(r => `<div class="notice ${r.warning ? '' : r.ok ? 'ok' : 'err'}">${esc(r.role)}: ${esc(r.message)}</div>`).join('')
      : '<div class="notice">Connections not checked for this configuration.</div>';
    const configErrors = HH.connectionErrors(P);
    $('check-connections').disabled = !canMeasure() || configurationLocked() || configErrors.length > 0;
    $('check-reference').hidden = HH.usesVoltmeter(P.method);
    $('check-requirements').textContent = configErrors.length ? 'Configure the required devices and addresses: ' + configErrors.join('; ') : 'Required instruments configured. Ready to check connections.';
    for (const path of ['hardware.magnet.host', 'hardware.magnet.encoder_addr', 'hardware.magnet.encoder_ppr']) document.querySelector(`[data-bind="${path}"]`).closest('.field').hidden = !h.magnet.encoder;
    const isDC = HH.usesVoltmeter(P.method);
    const isDeltaMode = HH.isDelta(P);
    document.querySelectorAll('[data-bind^="hardware.measure."]').forEach(el => {
      const dc = /\.(volt|volt_addr|dc_mode)$/.test(el.dataset.bind);
      el.closest('.field').hidden = dc ? !isDC : isDC;
    });
    // If Keithley 2182 is paired with 6220/6221, hide the redundant address box
    document.querySelector('[data-bind="hardware.measure.volt_addr"]').closest('.field').hidden = !isDC || isDeltaMode;
    $('delta-info').hidden = !isDeltaMode;
    const exc = HH.excitationOf(P.method);
    document.querySelectorAll('[data-bind="hardware.source.model"] option').forEach(o => { o.disabled = !!o.value && (!HH.SOURCES[o.value]?.[exc === 'delta' ? 'dc' : exc] || (HH.isDelta(P) && !['K6220','K6221'].includes(o.value))); });
    $('measure-msg').innerHTML += HH.connectionErrors(P).map(e => `<div class="notice err">${esc(e)}</div>`).join('');
    document.querySelector('[data-pane="temp"]').hidden = h.temperature === 'off';
    document.querySelector('#hw-subtabs [data-sub="temp"]').hidden = h.temperature === 'off';
    if (h.temperature === 'off' && document.querySelector('[data-pane="temp"]').classList.contains('active')) document.querySelector('#hw-subtabs [data-sub="magnet"]').click();
  }
  $('check-connections').onclick = async () => {
    if (!canMeasure() || configurationLocked() || HH.connectionErrors(P).length) return;
    checking = true; connectionCheck = null;
    const key = connectionKey(), snapshot = configurationSnapshot();
    renderHardware(); refreshTabs();
    try {
      const result = await HH.checkDevices(snapshot, window.HHHardware);
      if (key !== connectionKey()) return;
      connectionCheck = Object.assign(result, { key });
      if(result.ok) configurationReleased=false;
      if (result.ok && result.simulated && P.hardware.temperature !== 'off') await connectController();
      hist(P, 'hardware', result.ok ? 'All selected device checks passed' : 'Device connection check failed', result);
    } finally { checking = false; renderHardware(); refreshTabs(); }
  };
  $('check-reference').onclick = async () => {
    if (!canMeasure() || running || checking || referenceChecking) return;
    const ds = HH.selectedDevices(P).filter(d => d.role.startsWith('lockin'));
    if (!ds.length || HH.connectionErrors(P).length) { $('reference-result').textContent = 'Configure a lock-in and its address first.'; return; }
    referenceChecking=true;$('check-reference').disabled = true;
    $('reference-result').textContent = 'Waiting for TTL reference lock…';
    try {
      for (const d of ds) {
        const r = P.hardware.backend === 'simulation' ? { frequencyHz: P.method.kind === 'rotating' && P.method.rotating.excitation === 'dc' ? P.method.rotating.rot_hz : P.method.carrier_hz } : await window.HHHardware.waitForReference(d);
        $('reference-result').textContent = (P.hardware.backend === 'simulation' ? 'SIMULATED: ' : '') + d.model + ' locked at ' + r.frequencyHz + ' Hz';
      }
    } catch (e) { $('reference-result').textContent = e.message; Logger.error('REF', e.message); }
    finally { referenceChecking=false;setBadges(); }
  };
  function setBadges() {
    const isOfflineViewer = !canMeasure();
    document.body.classList.toggle('analysis-mode',isOfflineViewer);
    $('b-ls').hidden=isOfflineViewer;$('b-run').hidden=isOfflineViewer;
    $('b-mode').textContent = isOfflineViewer ? (accessChecking ? 'Connecting…' : 'Analysis mode') : P.hardware.backend === 'simulation'
      ? 'SIMULATION: synthetic data'
      : 'Real instruments';
    $('b-mode').className = 'badge ' + (isOfflineViewer ? '' : P.hardware.backend === 'simulation' ? 'sim' : 'ok');
    $('actual-values-panel').hidden = isOfflineViewer || !['hardware','run'].includes(current);
    if (['hardware','run'].includes(current)) {
      const slot = $(current === 'hardware' ? 'hardware-readings' : 'run-readings');
      if ($('actual-values-panel').parentElement !== slot) slot.append($('actual-values-panel'));
    }
    $('access-title').textContent = accessChecking ? 'Connecting to the local workstation…' : isOfflineViewer ? 'Project inspection & data analysis' : 'Measurement workstation';
    $('access-description').textContent = accessChecking ? 'Checking for a Rust service on this computer.' : isOfflineViewer ? 'Open a saved project to inspect raw data, adjust analysis inputs and export physical properties. Acquisition is available on the measurement PC.' : 'Choose a method, verify instruments and configure your measurement.';
    $('workstation-controls').hidden = !window.HHHardware.isLocalPage;
    $('workstation-reconnect').hidden = !window.HHHardware.isLocalPage;
    $('workstation-reconnect').disabled = accessChecking || running || checking;
    $('project-context').textContent = `${P.sample.id || 'Untitled project'} · ${P.runs.length} run${P.runs.length === 1 ? '' : 's'}`;
    const m = $('b-ls'); m.textContent = P.hardware.temperature === 'off' ? 'Temp: OFF' : P.hardware.backend === 'real' && connectionsOk() ? 'Temp: verified ('+P.hardware.temperature+')' : ctrl ? `Temp: ${P.hardware.temperature} (simulated)` : 'Temp: not connected'; m.className = 'badge ' + (ctrl || connectionsOk() ? 'ok' : '');
    const r = $('b-run'); r.textContent = running ? (runner?.state === 'paused' ? 'Paused' : 'Running') : 'Idle'; r.className = 'badge ' + (running ? 'run' : '');
    $('ls-connect').disabled = true; $('ls-disconnect').disabled = configurationLocked() || !ctrl; $('ls-heateroff').disabled = !ctrl || P.hardware.temperature !== 'control';
    document.querySelectorAll('[data-bind]').forEach(el => el.disabled = el.closest('#p-mode,#p-hardware') ? configurationLocked() : el.dataset.bind.startsWith('sample.') ? running || checking : checking);
    if(running) document.querySelector('[data-bind="hardware.backend"]').disabled=true;
    document.querySelectorAll('#f-levels,#f-dc-currents').forEach(el=>el.disabled=checking);
    document.querySelectorAll('#p-temp .toolbar input,#p-temp .toolbar select,#p-temp .toolbar button,#p-temp .program-builder input,#p-temp .program-builder select,#p-temp .program-builder button').forEach(el=>el.disabled=checking);
    $('add-sweep').disabled=checking||P.hardware.temperature!=='control'||($('sw-mode').value==='scan'&&!supportsTemperatureScan());
    $('save-preset').disabled=checking; $('preset-file').disabled=configurationLocked();
    $('rust-url').disabled=!window.HHHardware.isLocalPage||configurationLocked()||running||accessChecking;
    $('positive-field-angle').disabled=isOfflineViewer||configurationLocked();
    document.querySelectorAll('#hw-subtabs button').forEach(button=>button.disabled=!canMeasure());
    $('check-reference').disabled=!canMeasure()||running||checking||referenceChecking||HH.connectionErrors(P).length>0||HH.usesVoltmeter(P.method);
    document.querySelectorAll('#mode-cards button').forEach(button=>button.disabled=configurationLocked());
    document.querySelectorAll('[data-step-index]').forEach(input=>input.disabled=checking||(running&&Number(input.dataset.stepIndex)<(runner?.index??0)));
    document.querySelectorAll('[data-program-delete]').forEach(button=>button.disabled=checking||(running&&Number(button.dataset.programDelete)<=activeStepIndex()));
    document.querySelectorAll('[data-program-move]').forEach(button=>{const i=Number(button.dataset.programMove),next=i+Number(button.dataset.delta);button.disabled=checking||next<0||next>=P.tempProgram.length||(running&&(i<=activeStepIndex()||next<=activeStepIndex()));});
    document.querySelectorAll('[data-program-index]').forEach(row=>{const i=Number(row.dataset.programIndex);row.classList.toggle('cur',running&&i===activeStepIndex());row.classList.toggle('donest',running&&i<activeStepIndex());});
    document.querySelectorAll('[data-release-config]').forEach(button=>{button.hidden=!connectionsOk()||configurationReleased;button.disabled=running||checking;});
    const lockMessage=checking?'Checking connections…':configurationLocked()?'Validated configuration is read only. Pause or stop to change the method or devices.':'Choose the method and devices, then check connections.';
    $('method-lock').textContent=lockMessage;$('device-lock').textContent=lockMessage;
    $('method-lock').hidden=!configurationLocked();$('device-lock').hidden=!configurationLocked();
    $('apply-parameters').disabled=checking||parameterBusy||HH.modeErrors(P).length>0||progErrors().length>0;
    $('r-pause').disabled=!running||runner?.state==='pausing'||(paused()&&(!connectionsOk()||HH.modeErrors(P).length>0||progErrors().length>0));
    $('r-speed').disabled = running || P.hardware.backend === 'real';
    if (isOfflineViewer) document.querySelectorAll('#p-mode button,#p-mode input,#p-mode select,#p-hardware button,#p-hardware input,#p-hardware select,#p-sample input,#p-sample textarea,#p-temp button,#p-temp input,#p-temp select,#p-run button').forEach(el => el.disabled = true);
    for (const id of ['btn-quick-zero','btn-set-zero-pos','cal-50000','cal-50040']) $(id).disabled = isOfflineViewer || configurationLocked();
    $('btn-refresh-actual').disabled = isOfflineViewer || checking || running;
  }
  async function connectController() {
    if (P.hardware.backend !== 'simulation' || P.hardware.temperature === 'off') return;
    const c = P.hardware.tempController;
    try {
      simDev = new HH.SimLakeShore(c.model, 295, 7);
      const d = new HH.LakeShore(c.model, simDev, { input: c.input, loop: c.loop, minRateKmin:c.minRateKmin });
      const id = await d.identify(); ctrl = d;
      if (P.hardware.temperature === 'read') ctrl = { readK: () => d.readK(), getSetpoint: async () => null, heaterOff: async () => {} };
      $('ls-info').textContent = `${id.manufacturer} ${id.model}, s/n ${id.serial}, fw ${id.firmware} — SIMULATED at ${c.address}`;
      hist(P, 'hardware', `Connected ${c.model} (simulated) input ${c.input}, loop ${c.loop}`);
    } catch (e) { Logger.error('HW', 'Connect failed: ' + e.message); $('ls-info').textContent = 'Connect failed: ' + e.message; }
    setBadges(); refreshTabs(); renderHardware();
  }
  $('ls-connect').onclick = connectController;
  $('ls-disconnect').onclick = () => { connectionCheck = null; ctrl = null; simDev = null; Logger.info('HW', 'Disconnected'); hist(P, 'hardware', 'Disconnected'); $('ls-info').textContent = ''; setBadges(); refreshTabs(); };
  $('ls-heateroff').onclick = async () => { try { await ctrl.heaterOff(); hist(P, 'hardware', 'Heater switched off by user'); } catch (e) { Logger.error('HW', e.message); } };

  /* ---------------- mode / sample ---------------- */
  function methodErrors() { return HH.modeErrors(P).concat(HH.sampleErrors(P)); }
  function renderMode() {
    const av=HH.availability(P.hardware),m=P.method,box=$('mode-cards');
    const focusedId=box.contains(document.activeElement)?document.activeElement.id:null;
    // Move the existing bound controls; rebuilding them would lose their listeners.
    const options={};
    for(const key of Object.keys(HH.MODES)){options[key]=$('principle-'+key);options[key].remove();}
    box.replaceChildren();
    for(const [key,method] of Object.entries(HH.MODES)) {
      const panel=document.createElement('div');panel.className='method-panel'+(m.kind===key?' sel':'');panel.dataset.method=key;
      const button=document.createElement('button');button.type='button';button.className='mode-card method-option'+(m.kind===key?' sel':'');
      button.id='method-'+key;button.setAttribute('aria-controls','principle-'+key);button.setAttribute('aria-expanded',m.kind===key);
      button.setAttribute('aria-pressed',m.kind===key);button.disabled=configurationLocked();
      button.innerHTML=`<span class="method-radio" aria-hidden="true"></span><span class="method-name">${esc(method.label)}</span><span class="method-description">${esc(method.text)}</span><span class="method-state">${m.kind===key?'Selected':av[key].ok?'Devices configured':'Configure devices'}</span>`;
      button.onclick=()=>{if(!canMeasure()||configurationLocked())return;const old=m.kind;m.kind=key;connectionCheck=null;ctrl=null;simDev=null;hist(P,'config',`Method: ${old||'none'} → ${key}`);dirty=true;syncForm();renderMode();refreshTabs();};
      options[key].hidden=m.kind!==key;panel.append(button,options[key]);box.append(panel);
    }
    const preset=document.createElement('button');preset.type='button';preset.id='preset-card';preset.className='mode-card method-option preset-option';
    preset.disabled=configurationLocked();preset.innerHTML='<span aria-hidden="true">+</span><span class="method-name">Load a method preset</span><span class="method-description">Import saved method and instrument settings from JSON.</span><span class="method-state">Browse…</span>';
    preset.onclick=()=>$('preset-file').click();box.append(preset);
    document.querySelectorAll('.mode-panel').forEach(p => p.hidden = p.id !== 'mp-' + m.kind);
    for(const k of ['fixed','rotating','chirp']) $('principle-'+k).hidden=m.kind!==k;
    document.querySelector('[data-bind="method.tc_ms"]').closest('.card').hidden=!m.kind||HH.usesVoltmeter(m);
    // excitation selects: offer only available variants
    document.querySelectorAll('select[data-excsel]').forEach(sel => {
      const k = sel.id.replace('x-', ''); sel.replaceChildren();
      for (const v of HH.MODES[k].variants) sel.add(new Option(HH.EXC[v], v));
      sel.value = m[k].excitation;
    });
    const f = m.fixed, show = (el, on) => { el.hidden = !on; };
    document.querySelectorAll('#mp-fixed [data-when]').forEach(el => show(el, { ac: f.excitation === 'ac', dc: f.excitation === 'dc' && !HH.isDelta(P), volt: HH.usesVoltmeter(m), step: f.acq === 'step', scan: f.acq === 'scan' }[el.dataset.when]));
    document.querySelectorAll('#mp-rotating [data-when]').forEach(el => show(el, el.dataset.when === m.rotating.excitation));
    const parameterErrors=m.kind?HH.modeErrors(P):[], parameterWarnings=m.kind?HH.modeWarnings(P):[];
    $('experiment-msg').innerHTML=parameterErrors.map(x=>`<div class="notice err">${esc(x)}</div>`).join('')+parameterWarnings.map(x=>`<div class="notice">${esc(x)}</div>`).join('');
    const e = HH.principleErrors(m), w = [];
    $('mode-msg').innerHTML = (m.kind ? e.map(x => `<div class="notice err">${esc(x)}</div>`).join('') : '') + w.map(x => `<div class="notice">${esc(x)}</div>`).join('') +
      (m.kind && !e.length ? '<div class="notice ok">Select compatible devices next. Set numerical parameters in Experiment setup.</div>' : '');
    setBadges();
    if(focusedId)$(focusedId)?.focus({preventScroll:true});
  }
  function renderSample() {
    const w = []; if (P.sample.tilt_deg !== 0) w.push('Non-zero tilt: guide recommends validating zero-tilt ordinary Hall first.');
    $('sample-msg').innerHTML = HH.sampleErrors(P).map(x => `<div class="notice err">${esc(x)}</div>`).join('') + w.map(x => `<div class="notice">${esc(x)}</div>`).join('');
  }

  /* ---------------- temperature program ---------------- */
  const tl = () => P.hardware.tempController;
  const thermalLimits=()=>({maxK:tl().maxK,maxRateKmin:tl().maxRateKmin,minRateKmin:tl().minRateKmin??0.1});
  const activeStepIndex=()=>runner?.index??0;
  const supportsTemperatureScan=()=>P.method.kind==='chirp'||P.method.kind==='rotating'||(P.method.kind==='fixed'&&P.method.fixed.acq==='scan');
  function progErrors() {
    const errors=HH.validateProgram(P.tempProgram,thermalLimits());
    if(P.hardware.temperature!=='control'&&P.tempProgram.some(s=>['goto','scan','heater_off'].includes(s.type)))errors.push('Enable temperature control to use temperature steps or scans.');
    if(P.tempProgram.some(s=>s.type==='scan')&&!supportsTemperatureScan())errors.push('A temperature scan requires angular scan, AC field or CHIRP acquisition.');
    if(P.hardware.tempController.model==='LS332'&&(tl().minRateKmin??0.1)<0.1)errors.push('Model 332 minimum ramp rate is 0.1 K/min.');
    return errors;
  }
  function programEdited(text) {dirty=true;hist(P,'program',text);$('parameter-status').textContent=running?'Pending edits. Apply conditions & program to update the run.':'Program edited.';}
  function renderProgram() {
    renderMode();
    const control=P.hardware.temperature==='control';
    $('prog-heading').textContent=control?'Temperature & acquisition program':'Acquisition program';
    $('prog-intro').textContent=control?'Stabilized steps support a measurement count at each temperature. Slow scans acquire repeatedly during heating or cooling, recording the mean and range of measured temperature for every acquisition.':'Set the number of measurements and the wait between them. Temperature can be monitored without controlling it.';
    $('prog-temp-off-notice').hidden=P.hardware.temperature!=='off';
    $('prog-sweep-group').hidden=!control;$('prog-preview-card').hidden=!control;
    $('program-builder-title').textContent=control?'Build a temperature segment':'Acquisition sequence';$('sw-description').hidden=!control;
    $('prog-grid').className=control?'grid g2':'grid';
    const sel=$('add-type');if(!sel.childElementCount)for(const [key,spec]of Object.entries(HH.STEP_TYPES))sel.add(new Option(spec.label,key));
    for(const option of sel.options)option.disabled=(!control&&['goto','scan','heater_off'].includes(option.value))||(option.value==='scan'&&!supportsTemperatureScan());
    if(sel.selectedOptions[0]?.disabled)sel.value='measure';
    const scanning=$('sw-mode').value==='scan';
    $('sw-step-field').hidden=scanning;$('sw-count-field').hidden=scanning;
    $('sw-description').textContent=scanning?'Stabilize the start temperature, then acquire complete measurements while ramping to the end temperature. Acquisition settings apply to the next complete measurement.':'Stabilize each temperature, then repeat the measurement the requested number of times.';
    if(scanning) {
      const streaming=(P.method.kind==='fixed'&&P.method.fixed.acq==='scan'&&!HH.isDelta(P))||(P.method.kind==='rotating'&&P.method.rotating.excitation==='ac'&&!P.method.rotating.background);
      $('sw-description').textContent+=streaming?' With zero wait, this method keeps excitation and rotation running across saved measurement windows.':' This method retains its required current switching, direction changes or background sequence.';
    }
    $('add-sweep').disabled=!control||checking||(scanning&&!supportsTemperatureScan());
    const cols={goto:['T','rate','range','min_stab_s','max_stab_s','avg_s','tol','mean_tol','esd_tol'],scan:['T','rate','range','interval_s','endpoint_tol','timeout_s','label'],soak:['seconds'],measure:['repeats','interval_s','label'],heater_off:[]};
    const names={T:'Target (K)',rate:'Rate (K/min)',range:'Heater',min_stab_s:'Min stable (s)',max_stab_s:'Timeout (s)',avg_s:'Window (s)',tol:'Max |ΔT| (K)',mean_tol:'Mean |ΔT| (K)',esd_tol:'Std dev (K)',seconds:'Duration (s)',repeats:'Measurements',interval_s:'Wait between (s)',endpoint_tol:'Endpoint tol (K)',timeout_s:'Timeout (s)',label:'Label'};
    const table=$('prog-table');table.innerHTML='<tr><th>#</th><th>Operation</th><th>Conditions</th><th>Edit sequence</th></tr>';
    P.tempProgram.forEach((step,i)=>{
      const frozen=running&&i<activeStepIndex(),row=table.insertRow();row.dataset.programIndex=i;row.className=frozen?'donest':running&&i===activeStepIndex()?'cur':'';
      row.insertCell().textContent=i+1;row.insertCell().textContent=HH.STEP_TYPES[step.type]?.label||step.type;
      const cell=row.insertCell();cell.style.whiteSpace='normal';const fields=document.createElement('div');fields.className='step-fields';cell.append(fields);
      (cols[step.type]||[]).forEach(key=>{
        const label=document.createElement('label');label.append(names[key]);let input;
        if(key==='range'){input=document.createElement('select');for(const value of ['low','medium','high'])input.add(new Option(value,value));}
        else{input=document.createElement('input');input.type=key==='label'?'text':'number';input.step=key==='repeats'?'1':'any';if(key==='repeats')input.min='1';}
        const fallback={mean_tol:step.tol,esd_tol:step.tol,avg_s:step.window_s??30,min_stab_s:step.window_s??60,max_stab_s:step.timeout_s??3600,repeats:1,interval_s:0,label:''};
        input.value=step[key]??fallback[key]??'';input.dataset.stepIndex=i;input.disabled=frozen||checking;
        input.onchange=()=>{if(running&&i<activeStepIndex())return;step[key]=['range','label'].includes(key)?input.value:Number(input.value);programEdited(`Step ${i+1}: ${key} = ${step[key]}`);renderProgramSummary();setBadges();refreshTabs();};
        label.append(input);fields.append(label);
      });
      const actions=row.insertCell();
      for(const [label,delta] of [['↑',-1],['↓',1]]){const button=document.createElement('button');button.className='secondary';button.dataset.programMove=i;button.dataset.delta=delta;button.textContent=label;button.title=delta<0?'Move earlier':'Move later';button.disabled=checking||i+delta<0||i+delta>=P.tempProgram.length||(running&&(i<=activeStepIndex()||i+delta<=activeStepIndex()));button.onclick=()=>{if(checking||(running&&(i<=activeStepIndex()||i+delta<=activeStepIndex())))return;[P.tempProgram[i],P.tempProgram[i+delta]]=[P.tempProgram[i+delta],P.tempProgram[i]];programEdited(`Moved step ${i+1}`);renderProgram();};actions.append(button,' ');}
      const remove=document.createElement('button');remove.className='secondary';remove.dataset.programDelete=i;remove.textContent='Remove';remove.disabled=checking||(running&&i<=activeStepIndex());remove.onclick=()=>{if(checking||(running&&i<=activeStepIndex()))return;P.tempProgram.splice(i,1);programEdited(`Removed step ${i+1}`);renderProgram();refreshTabs();};actions.append(remove);
    });
    $('clear-prog').textContent=running?'Remove future steps':'Clear program';
    renderProgramSummary();
  }
  function renderProgramSummary() {
    const errors=progErrors(),warnings=HH.programWarnings(P.tempProgram);
    const count=P.tempProgram.filter(s=>s.type==='measure').reduce((n,s)=>n+(s.repeats??1),0),scans=P.tempProgram.filter(s=>s.type==='scan').length;
    const seconds=HH.estimateDuration(P.tempProgram,295)+count*HH.acqSeconds(P.method);
    $('prog-msg').innerHTML=errors.map(e=>`<div class="notice err">${esc(e)}</div>`).join('')+warnings.map(e=>`<div class="notice">${esc(e)}</div>`).join('')+(!errors.length?`<div class="notice ok">${count} measurements at fixed temperatures${scans?`; ${scans} continuous temperature scan${scans===1?'':'s'}`:''}. Estimated duration ${fmtDur(seconds)}${scans?' plus acquisition completion at scan endpoints':''}.</div>`:'');
    if(P.hardware.temperature==='control')drawProgramPreview();
  }
  $('sw-mode').onchange=renderProgram;
  $('apply-parameters').onclick=async()=>{
    if(HH.modeErrors(P).length||progErrors().length||parameterBusy)return;
    parameterBusy=true;setBadges();
    try{
      if(running&&P.hardware.backend==='real'){if(!realJobId)throw Error('Wait for the program to start.');await window.HHHardware.updateProgram(realJobId,P);}
      if(running&&P.hardware.backend==='simulation')runner.updateProgram(P.tempProgram);
      appliedMethod=JSON.parse(JSON.stringify(P.method));appliedProgram=JSON.parse(JSON.stringify(P.tempProgram));
      $('parameter-status').textContent=running?'Accepted. Conditions and scan targets apply between acquisitions; stabilization targets update at the next temperature check.':'Conditions and program ready.';
      hist(P,'config','Applied acquisition conditions and temperature program');
    }catch(error){$('parameter-status').textContent='Not applied: '+error.message;}
    finally{parameterBusy=false;setBadges();}
  };
  function fmtDur(seconds){if(!Number.isFinite(seconds))return 'unavailable';const hours=Math.floor(seconds/3600),minutes=Math.floor(seconds%3600/60);return hours?`${hours} h ${minutes} min`:`${minutes} min ${Math.round(seconds%60)} s`;}
  $('add-step').onclick=()=>{if(!canMeasure()||checking)return;const type=$('add-type').value;P.tempProgram.push(HH.makeStep(type));programEdited('Added '+type);renderProgram();refreshTabs();};
  function drawProgramPreview(){
    let T=295,time=0;const x=[0],y=[T];
    for(const step of P.tempProgram){
      if(['goto','scan'].includes(step.type)){time+=Math.abs(step.T-T)/(step.rate||1)*60;T=step.T;x.push(time/60);y.push(T);if(step.type==='goto')time+=step.min_stab_s??step.window_s??60;}
      else if(step.type==='measure')time+=(step.repeats??1)*HH.acqSeconds(P.method)+Math.max(0,(step.repeats??1)-1)*(step.interval_s??0);
      else if(step.type==='soak')time+=step.seconds;
      x.push(time/60);y.push(T);
    }
    HH.plot($('c-prog-preview'),[{x,y,color:'#205f8e'}],{xlabel:'Estimated elapsed time (min)',ylabel:'Temperature (K)'});
    $('prog-preview-stats').textContent='Estimated profile from 295 K; scan acquisitions may finish beyond the target crossing.';
  }
  $('add-sweep').onclick=()=>{
    if(!canMeasure()||checking)return;
    try{
      const start=+$('sw0').value,end=+$('sw1').value,options={rate:+$('swr').value,min_stab_s:+$('sw-minstab').value,max_stab_s:+$('sw-maxstab').value,avg_s:+$('sw-window').value,tol:+$('sw-tol').value,mean_tol:+$('sw-mean').value,esd_tol:+$('sw-esd').value,window_s:+$('sw-window').value,timeout_s:+$('sw-maxstab').value,range:$('sw-range').value,repeats:+$('sw-count').value,interval_s:+$('sw-interval').value};
      const scanning=$('sw-mode').value==='scan';
      if(scanning&&(!supportsTemperatureScan()||start===end))throw Error('Use a continuous acquisition method and different start/end temperatures.');
      const steps=scanning?[HH.makeStep('goto',{...options,T:start}),HH.makeStep('scan',{T:end,rate:options.rate,range:options.range,interval_s:options.interval_s,endpoint_tol:options.tol,timeout_s:Math.max(86400,Math.ceil(Math.abs(end-start)/options.rate*120+HH.acqSeconds(P.method)*2))})]:HH.sweep(start,end,+$('swd').value,options);
      const errors=HH.validateProgram(steps,thermalLimits());if(errors.length)throw Error(errors[0]);
      P.tempProgram.push(...steps);programEdited(`Appended ${scanning?'slow scan':steps.length/2+' temperature points'}`);$('sweep-msg').textContent=scanning?'Added stabilization and a continuous temperature scan.':`Added ${steps.length/2} temperatures × ${options.repeats} measurements.`;
    }catch(error){$('sweep-msg').textContent=error.message;}
    renderProgram();refreshTabs();
  };
  $('clear-prog').onclick=()=>{const from=running?activeStepIndex()+1:0;if(P.tempProgram.length>from&&confirm(running?'Remove all future steps?':'Clear the program?')){P.tempProgram.splice(from);programEdited('Removed remaining program steps');renderProgram();refreshTabs();}};
  /* ---------------- run ---------------- */
  function renderRun() {
    const n = $('run-notice'), why = [];
    if (!canMeasure()) why.push('Measurement requires the local workstation.');
    if (!connectionsOk()) why.push('Check all selected device connections before running.');
    if (P.hardware.backend === 'real') why.push(...realRunErrors());
    if (P.hardware.backend === 'simulation' && P.hardware.temperature !== 'off' && !ctrl) why.push('Temperature device not connected.');
    if(!running){methodErrors().forEach(x => why.push(x)); progErrors().forEach(x => why.push(x));}
    n.innerHTML = why.map(x => `<div class="notice err">${esc(x)}</div>`).join('') + (P.hardware.backend === 'simulation' ? '<div class="notice">Simulation: synthetic data, tagged in saved projects.</div>' : '<div class="notice">Real program: Start enables the configured current source and moves the referenced OWIS axis. Abort stops motion, disables current and turns off temperature control. Timing and electrical phase require bench calibration.</div>');
    $('r-start').disabled = running || why.length > 0;
    $('r-pause').disabled = !running || runner?.state==='pausing' || (paused() && (!connectionsOk() || HH.modeErrors(P).length>0 || progErrors().length>0)); $('r-abort').disabled = !running;
    $('r-pause').textContent = runner?.state === 'paused' ? 'Resume' : 'Pause';
    const t = $('run-steps'); t.innerHTML = '<tr><th>#</th><th>Step</th><th>Detail</th><th>State</th></tr>';
    (running&&appliedProgram?appliedProgram:P.tempProgram).forEach((s, i) => { const tr = t.insertRow(); tr.className = stepState[i] === 'start' ? 'cur' : stepState[i] === 'done' ? 'donest' : ''; tr.insertCell().textContent = i + 1; tr.insertCell().textContent = HH.STEP_TYPES[s.type]?.label||s.type; tr.insertCell().textContent = ['goto','scan'].includes(s.type) ? `${s.T} K @ ${s.rate} K/min` : s.type === 'soak' ? s.seconds + ' s' : `${s.repeats??1} measurements · ${s.interval_s??0} s wait`; tr.insertCell().textContent = stepState[i] === 'start' ? `Active${runner?.measurement?' · measurement '+runner.measurement:''}` : stepState[i] === 'done' ? 'Completed' : 'Pending'; });
    drawTemp(); setBadges();
  }
  function drawTemp() { if (current === 'run') HH.plot($('c-temp'), [{ x: trace.t, y: trace.sp, color: '#ad7521' }, { x: trace.t, y: trace.T, color: '#205f8e' }], { xlabel: P.hardware.backend==='simulation'?'Virtual time (s)':'Elapsed time (s)', ylabel: 'T (K)' }); }
  function updateKpis(s) {
    $('r-kpis').innerHTML = [['Temperature', fx(s.T, 4) + ' K'], ['Setpoint', fx(s.setpoint, 4) + ' K'], ['Heater', fx(s.heater, 3) + ' %'], ['Runs saved', P.runs.length], ['Elapsed', fmtDur(vnow)]].map(([a, b]) => `<div class="kpi"><span>${a}</span><b>${esc(b)}</b></div>`).join('');
  }
  function setStatus(t) { $('r-status').textContent = t; }
  function realRunErrors() {
    const h=P.hardware,e=[];
    if (location.protocol==='file:') e.push('Open the local workstation URL served by start-workstation.bat.');
    if (!(h.magnet.counts_per_turn>0) || !(h.magnet.velocity_scale>0)) e.push('Configure calibrated OWIS counts per revolution and velocity conversion on Devices.');
    if (!['K6220','K6221','MFLI'].includes(h.source.model)) e.push('Real acquisition currently supports Keithley 6220/6221 or Zurich MFLI sources.');
    if (!HH.usesVoltmeter(P.method) && !['SR830','AMETEK7230','MFLI'].includes(h.measure.lockin1)) e.push('Select SR830, Ametek 7230, or Zurich MFLI as Lock-in 1 for real acquisition.');
    if (h.measure.lockin2) e.push('Real acquisition currently records one lock-in; deselect Lock-in 2.');
    return e;
  }
  async function startRealProgram() {
    if (!canMeasure() || !connectionsOk() || realRunErrors().length) {renderRun();return;}
    let jobId=null,cursor=0,abortRequested=false;
    running=true; stepState=[];vnow=0;trace={t:[],T:[],sp:[]};const realStarted=Date.now();
    appliedMethod=JSON.parse(JSON.stringify(P.method));appliedProgram=JSON.parse(JSON.stringify(P.tempProgram));configurationReleased=false;
    runner={state:'running',abort:()=>{abortRequested=true;if(jobId) window.HHHardware.abortProgram(jobId).catch(e=>Logger.error('HW',e.message));},pause:async()=>{runner.state='pausing';renderRun();await window.HHHardware.pauseProgram(jobId);},resume:async()=>{await window.HHHardware.resumeProgram(jobId,P);runner.state='running';configurationReleased=false;}};
    renderRun();
    try {
      jobId=(await window.HHHardware.startProgram(P)).id;
      realJobId=jobId;
      if (abortRequested) await window.HHHardware.abortProgram(jobId);
      hist(P,'run','Real instrument program started');
      while (true) {
        const status=await window.HHHardware.programStatus(jobId,cursor);
        runner.state=status.state;
        runner.index=status.step;runner.measurement=status.measurement;
        if(status.state==='paused')configurationReleased=true;
        for (const data of status.runs) {
          const run=Object.assign({id:nextRunId(),started:new Date().toISOString(),sample:JSON.parse(JSON.stringify(P.sample)),method:JSON.parse(JSON.stringify(P.method)),excluded:[]},data);
          if (run.incomplete) {run.fitError='Incomplete acquisition: retained raw samples.';run.fit=null;run.derived=null;} else fitRun(run);
          P.runs.push(run);selRun=run.id;dirty=true;hist(P,'run',run.id+' recorded from real instruments');
        }
        cursor=status.count; P.simulated=P.runs.some(r=>r.simulated);
        stepState=(appliedProgram||P.tempProgram).map((_,i)=>i<status.step?'done':i===status.step?'start':'');
        $('r-prog').style.width=((status.step+(status.state==='finished'?1:0))/(appliedProgram||P.tempProgram).length*100)+'%';
        vnow=(Date.now()-realStarted)/1000;
        if (Number.isFinite(status.temperatureK)) {trace.t.push(vnow);trace.T.push(status.temperatureK);trace.sp.push(status.setpointK??NaN);}
        updateActualTelemetry({
          T: status.temperatureK,
          sp: status.setpointK,
          current_mA: status.current_mA,
          outputOn: status.outputOn,
          voltageX: status.voltageX,
          voltageY: status.voltageY,
          angleDeg: status.angleDeg,
          counter: status.counter,
          tempStatus: status.tempStatus,
          elapsedS: vnow,
        });
        setStatus(status.message+(status.cleanupErrors?.length?' — '+status.cleanupErrors.join('; '):''));updateKpis({T:status.temperatureK,setpoint:status.setpointK,heater:null});renderRun();
        if (['finished','error','aborted'].includes(status.state)) {
          if (status.state==='finished') stepState=stepState.map(()=> 'done');
          hist(P,'run','Real program '+status.state+': '+status.message); break;
        }
        await sleepReal(500);
      }
    } catch(e) {
      if(jobId) try {await window.HHHardware.abortProgram(jobId);} catch (_) {}
      setStatus('Hardware error: '+e.message);Logger.error('HW',e.message);hist(P,'run','Real program error: '+e.message);
    } finally {running=false;runner=null;realJobId=null;configurationReleased=true;renderRun();refreshTabs();}
  }

  $('r-start').onclick = async () => {
    if (!canMeasure() || running) return;
    if (!connectionsOk() || methodErrors().length || progErrors().length) return;
    if (P.hardware.backend === 'real') return startRealProgram();
    if (P.hardware.temperature === 'off') {
      simDev = { advance() {} };
      ctrl = { readK: async () => null, getSetpoint: async () => null, heaterOff: async () => {} };
    }
    if (!ctrl || progErrors().length || methodErrors().length) { renderRun(); return; }
    if (P.runs.length && !confirm('Runs already exist in this project. New runs will be appended. Continue?')) return;
    $('r-stability').textContent = '';
    const speed = Number($('r-speed').value); vnow = 0; trace = { t: [], T: [], sp: [] }; stepState = [];
    const total = P.tempProgram.length;
    const env = {
      pollSec: 2, now: () => vnow,
      sleep: async s => { simDev.advance(s); vnow += s; if (speed > 0) await sleepReal(s * 1000 / speed); else if (Math.round(vnow) % 20 === 0) await sleepReal(0); },
      onTemp: s => { if (s.stability) $('r-stability').textContent = `Temperature stability: |ΔT| ${fx(s.stability.error)} K; mean |ΔT| ${s.stability.meanError === null ? 'collecting window' : fx(s.stability.meanError) + ' K'}; in band ${fx(s.stability.stableFor)} s`; trace.t.push(s.t); trace.T.push(s.T); trace.sp.push(s.setpoint); updateKpis(s); drawTemp(); },
      onStep: (i, s, st) => { stepState[i] = st; const count=(appliedProgram||P.tempProgram).length;$('r-prog').style.width = ((st === 'done' ? i + 1 : i) / count * 100) + '%'; setStatus(`Step ${i + 1}/${count}: ${HH.STEP_TYPES[s.type].label}`); hist(P, 'run', `Step ${i + 1} ${st}: ${s.type}`); renderRun(); },
      measure: ctx => measure(ctx, speed),
    };
    runner = new HH.ProgramRunner(ctrl, JSON.parse(JSON.stringify(P.tempProgram)), env, thermalLimits());
    appliedMethod=JSON.parse(JSON.stringify(P.method));appliedProgram=JSON.parse(JSON.stringify(P.tempProgram));configurationReleased=false;
    running = true; hist(P, 'run', `Program started (${total} steps, ${P.runs.length} existing runs)`); renderRun();
    try { await runner.run(); setStatus('Finished'); hist(P, 'run', 'Program finished'); }
    catch (e) { setStatus((e.aborted ? 'Aborted: ' : 'Error: ') + e.message); hist(P, 'run', (e.aborted ? 'Aborted: ' : 'ERROR: ') + e.message + ' — heater switched off'); }
    running = false; runner = null; configurationReleased=true;dirty = true; renderRun(); refreshTabs();
    if (P.runs.length) { selRun = P.runs[P.runs.length - 1].id; }
  };
  $('r-pause').onclick = async () => {
    if(!runner)return;
    try {
      if(paused()) {
        if(!connectionsOk()||HH.modeErrors(P).length||progErrors().length)return;
        if(P.hardware.backend==='simulation'){
          if(P.hardware.temperature==='off'&&!ctrl){simDev={advance(){}};ctrl={readK:async()=>null,getSetpoint:async()=>null,heaterOff:async()=>{}};}
          runner.c=ctrl;runner.updateProgram(P.tempProgram);
        }
        await runner.resume();appliedMethod=JSON.parse(JSON.stringify(P.method));appliedProgram=JSON.parse(JSON.stringify(P.tempProgram));configurationReleased=false;
      } else {
        await runner.pause();
        if(P.hardware.backend==='simulation') {runner.state='paused';configurationReleased=true;}
      }
      hist(P,'run',paused()?'Program paused':'Program resumed');renderRun();refreshTabs();
    }catch(e){setStatus(e.message);renderRun();}
  };
  $('r-abort').onclick = () => { if (runner && confirm('Abort the program? The heater will be switched off.')) runner.abort(); };

  async function measure(ctx, speed) {
    const id = nextRunId();
    Logger.info('MEAS', `${id}: ${P.method.kind} mode at ${ctx.T_set} K`);
    const T = await ctrl.readK();
    const snapshot=configurationSnapshot();snapshot.method=JSON.parse(JSON.stringify(appliedMethod||P.method));
    let localTime=0;
    const res = await HH.acquire(snapshot, ctx, time => {const delta=time-localTime;if(delta>0){simDev.advance(delta);vnow+=delta;localTime=time;}return Number.isFinite(simDev.T)?simDev.T:T===null?295:T;});
    if (P.hardware.temperature === 'off') { res.T_mean = null; res.samples.T.fill(null); }
    const dur = res.samples.t[res.samples.t.length - 1];
    if (speed > 0) await sleepReal(Math.min(dur * 1000 / speed, 5000));
    const run = { id, label: ctx.step.label || '', positionSource: connectionCheck?.positionSource||'owis', T_set: ctx.T_set, T_mean: res.T_mean,temperatureMode:ctx.temperatureMode,temperatureStats:res.temperatureStats,programStep:JSON.parse(JSON.stringify(ctx.step)),measurement:ctx.measurement, started: new Date().toISOString(), simulated: true, rsq_ohm: res.rsq_ohm, sample:snapshot.sample, method:snapshot.method, samples: res.samples, excluded: [] };
    fitRun(run); P.runs.push(run); P.simulated=P.runs.some(r=>r.simulated); dirty=true;
    hist(P, 'run', `${id} saved: T=${fx(run.T_mean)} K, n_s=${fx(run.derived?.ns)} m⁻²`, { run: id });
    Logger.info('MEAS', `${id} done: A1=${fx(run.fit?.A1)} Ω`);
    selRun = id; if (current === 'inspect' && $('i-live').checked) renderInspect();
    if(P.hardware.temperature!=='off'){trace.t.push(vnow);trace.T.push(simDev.T??T);trace.sp.push(ctx.T_set);updateActualTelemetry({T:simDev.T??T,sp:ctx.T_set,elapsedS:vnow});drawTemp();}
    setStatus(`Step ${ctx.stepIndex+1}: measurement ${ctx.measurement??1} recorded${ctx.temperatureMode==='scan'?' during temperature scan':''}`);
    renderRun();await sleepReal(0);
  }
  function fitRun(run) {
    try {
      if(run.samples.T.some(Number.isFinite)){run.temperatureStats=HH.temperatureStats(run.samples.t,run.samples.T,run.samples.valid);run.T_mean=run.temperatureStats.mean;}
      if (run.incomplete) throw new Error('Incomplete acquisition: retained raw samples without fitting.');
      run.fit = run.detectionKind === 'field-lockin' ? HH.fitFieldLockin(run.samples,run.method.rotating.excitation) : run.method?.kind === 'rotating' && run.method.rotating.excitation === 'dc' ? HH.fitCurrentSweep(run.samples) : HH.fitHarmonics(run.samples);
      run.derived = HH.derive(run.fit, analysisSample(run));
      if (run.fit.warnings) run.derived.warnings.push(...run.fit.warnings);
      if(run.temperatureMode==='scan')run.derived.warnings.push(`Acquired during a temperature scan (${fx(run.temperatureStats?.min)}–${fx(run.temperatureStats?.max)} K). The fit represents this temperature interval; a single-temperature material model may not describe a rapidly evolving sample.`);
      run.fitError = null;
    } catch (e) { run.fit = null; run.derived = null; run.fitError = e.message; Logger.error('FIT', run.id + ': ' + e.message); }
  }
  function analysisSample(run) {
    return { ...run.sample, rsq_ohm: run.rsq_ohm ?? run.sample?.rsq_ohm, ...run.analysisSample };
  }

  /* ---------------- data inspect ---------------- */
  const runById = id => P.runs.find(r => r.id === id);
  function renderInspect() {
    const sel = $('i-run'); sel.replaceChildren(); P.runs.forEach(r => sel.add(new Option(`${r.id} · ${r.simulated ? 'simulated' : 'measured'} · ${Number.isFinite(r.T_mean) ? fx(r.T_mean, 4) + ' K' : 'temperature not recorded'} ${r.label || ''}`, r.id)));
    if ($('i-live').checked && P.runs.length) selRun = P.runs[P.runs.length - 1].id;
    if (!runById(selRun) && P.runs.length) selRun = P.runs[0].id;
    sel.value = selRun || ''; const r = runById(selRun);
    for (const id of ['i-refit','i-mask','i-unmask','i-export']) $(id).disabled = !r;
    if (!r) { $('i-kpis').innerHTML = '<div class="notice">No runs yet. Open a saved project to inspect its raw data.</div>'; ['c-xth', 'c-xt', 'c-res','c-current-slope'].forEach(c => HH.plot($(c), [])); $('i-slope-card').hidden = true; $('i-table').innerHTML = ''; return; }
    const s = r.samples, f = r.fit, d = r.derived;
    $('i-slope-info').textContent = '';
    for (const id of ['c-xth','c-res']) $(id).closest('.card').hidden = r.detectionKind === 'field-lockin';
    $('i-slope-card').hidden = !f?.currentSlope;
    if (f?.currentSlope) {
      const slope = f.currentSlope, x = slope.points.map(p => p.I), y = slope.points.map(p => p.voltage);
      HH.plot($('c-current-slope'), [{x, y, color:'#205f8e', kind:'points'}, {x, y:x.map(I=>slope.intercept+slope.slope*I), color:'#ad7521'}], {xlabel: r.method.rotating.excitation === 'dc' ? 'DC current (A)' : 'RMS current (A)', ylabel:'Signed Hall voltage (V)'});
      $('i-slope-info').textContent = `Slope ${fx(slope.slope)} V/A; ${slope.points.length === 1 ? 'assumed zero offset' : 'fitted intercept'} ${fx(slope.intercept)} V. ${slope.points.length} distinct currents.`;
      if (r.detectionKind==='field-lockin') $('i-slope-info').textContent += ' RMS lock-in output normalized to Hall amplitude; verify reference phase and gain.';
    }
    $('i-kpis').innerHTML = [['T mean', fx(r.T_mean, 5) + ' K'], ['T range', fx(r.temperatureStats?.min) + '–' + fx(r.temperatureStats?.max) + ' K'], ['Samples (valid)', `${s.t.length} (${s.valid.reduce((a, b) => a + b, 0)})`], ['A1', f ? fx(f.A1) + ' Ω' : '—'], ['D1/A1', f ? fx(f.D1 / f.A1, 3) : '—'], ['A2', f ? fx(f.A2) + ' Ω' : '—'], ['Fit rms', f ? fx(f.rms) + ' V' : '—'], ['Condition', f ? fx(f.cond, 3) : '—'], ['Carrier', d?.carrier || '—']].map(([a, b]) => `<div class="kpi"><span>${a}</span><b>${esc(b)}</b></div>`).join('') + (r.fitError ? `<div class="notice err">${esc(r.fitError)}</div>` : '') + (d ? d.warnings.map(w => `<div class="notice">${esc(w)}</div>`).join('') : '') + (r.simulated ? '<div class="notice">Simulated data.</div>' : '');
    // choose one current level for X vs angle readability: all valid points, X/I normalised to ohm
    const vi = [], mi = []; s.theta.forEach((th, i) => { if (Number.isFinite(th) && Number.isFinite(s.I[i]) && Number.isFinite(s.X[i]) && s.I[i] !== 0) (s.valid[i] ? vi : mi).push(i); });
    const wrap = th => { const w = ((th % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI); return w * 180 / Math.PI; };
    const R = i => s.X[i] / s.I[i];
    const model = i => f ? HH.predictVoltage(f, s.theta[i], s.I[i]) / s.I[i] : null;
    HH.plot($('c-xth'), [{ x: mi.map(i => wrap(s.theta[i])), y: mi.map(R), color: '#9ba7b1', kind: 'points' }, { x: vi.map(i => wrap(s.theta[i])), y: vi.map(R), color: '#205f8e', kind: 'points' }, { x: vi.map(i => wrap(s.theta[i])), y: vi.map(model), color: '#ad7521', kind: 'points' }], { xlabel: 'field angle (deg)', ylabel: 'X / I (Ω)' });
    HH.plot($('c-xt'), [{ x: s.t, y: s.X, color: '#205f8e' }, { x: s.t, y: s.Y, color: '#6a8091' }], { xlabel: 't (s)', ylabel: 'lock-in (V)' });
    HH.plot($('c-res'), f ? [{ x: vi.map(i => wrap(s.theta[i])), y: vi.map(i => R(i) - model(i)), color: '#6a8091', kind: 'points' }] : [], { xlabel: 'field angle (deg)', ylabel: 'residual (Ω)' });
    const t = $('i-table'); t.innerHTML = '<tr><th>t (s)</th><th>θ (deg)</th><th>X (V)</th><th>Y (V)</th><th>I (A)</th><th>T (K)</th><th>valid</th></tr>';
    const stride = Math.max(1, Math.ceil(s.t.length / 300));
    $('i-table-info').textContent = stride > 1 ? `Showing every ${stride}th sample of ${s.t.length}. Raw CSV contains every sample.` : `${s.t.length} raw samples.`;
    for (let i = 0; i < s.t.length; i += stride) { const tr = t.insertRow(); [fx(s.t[i], 4), Number.isFinite(s.theta[i]) ? fx(s.theta[i] * 180 / Math.PI) : '—', fx(s.X[i], 4), fx(s.Y[i], 3), fx(s.I[i], 4), fx(s.T[i], 4), s.valid[i]].forEach(v => tr.insertCell().textContent = v); }
  }
  $('i-run').onchange = () => { selRun = $('i-run').value; $('i-live').checked = false; renderInspect(); };
  $('i-live').onchange = renderInspect;
  $('i-refit').onclick = () => { const r = runById(selRun); if (r) { fitRun(r); hist(P, 'analysis', `refit ${r.id}`); dirty = true; renderInspect(); } };
  function maskRange(val) {
    const r = runById(selRun); if (!r) return; const a = Number($('i-m0').value), b = Number($('i-m1').value);
    if (!$('i-m0').value.trim() || !$('i-m1').value.trim() || !Number.isFinite(a) || !Number.isFinite(b) || !(b > a)) { $('i-mask-status').textContent = 'Enter finite start and end times, with end greater than start.'; return; }
    let n = 0; r.samples.t.forEach((t, i) => { if (t >= a && t <= b && r.samples.valid[i] !== val) { r.samples.valid[i] = val; n++; } });
    r.excluded.push({ from: a, to: b, valid: val, n }); fitRun(r);
    $('i-mask-status').textContent = `${n} samples ${val ? 'restored' : 'excluded'}.`;
    hist(P, 'analysis', `${r.id}: ${val ? 'restored' : 'excluded'} ${n} samples in t=[${a}, ${b}] s`); dirty = true; renderInspect();
  }
  $('i-mask').onclick = () => maskRange(0); $('i-unmask').onclick = () => maskRange(1);

  /* ---------------- analysis ---------------- */
  const scaled = (v, factor) => Number.isFinite(v) ? v * factor : null;
  const COLS = [
    ['id','Run',r=>r.id], ['status','Status',r=>r.fitError || (Number.isFinite(r.derived?.RH) ? 'Analyzed' : 'Fit only')],
    ['source','Data',r=>r.simulated ? 'Simulated' : 'Measured'], ['T','Mean T (K)',r=>r.T_mean], ['Tmin','Min T (K)',r=>r.temperatureStats?.min], ['Tmax','Max T (K)',r=>r.temperatureStats?.max], ['thermalMode','Temperature mode',r=>r.temperatureMode||'step'], ['measurement','Measurement',r=>r.measurement],
    ['ns','n_s (cm⁻²)',r=>scaled(r.derived?.ns,1e-4)], ['ns_e','σ n_s (cm⁻²)',r=>scaled(r.derived?.ns_err,1e-4)],
    ['n','n (cm⁻³)',r=>scaled(r.derived?.n,1e-6)], ['rh','R_H (cm³/C)',r=>scaled(r.derived?.RH,1e6)],
    ['rh_e','σ R_H (cm³/C)',r=>scaled(r.derived?.RH_err,1e6)], ['mu','μ (cm²/Vs)',r=>scaled(r.derived?.mu,1e4)],
    ['mu_e','σ μ (cm²/Vs)',r=>scaled(r.derived?.mu_err,1e4)], ['rho','ρ (Ω·cm)',r=>scaled(r.derived?.rho,100)],
    ['rs','R□ (Ω)',r=>analysisSample(r).rsq_ohm], ['A1','A1 (Ω)',r=>r.fit?.A1], ['A1e','σ A1 (Ω)',r=>r.fit?.A1_err],
    ['D1','D1 (Ω)',r=>r.fit?.D1], ['A2','A2 (Ω)',r=>r.fit?.A2], ['ty','Carrier',r=>r.derived?.carrier],
    ['warnings','Warnings',r=>r.derived?.warnings?.join(' ') || ''],
  ];
  const resultCell = value => typeof value === 'number' ? fx(value) : value ?? '—';
  const visibleRuns = () => P.runs.filter(r => $('a-filter').value === 'all' || ($('a-filter').value === 'simulated') === !!r.simulated);
  function analysisAxis(runs) {
    const temperature = $('a-axis').value === 'temperature' || ($('a-axis').value === 'auto' && runs.length > 0 && runs.every(r=>Number.isFinite(r.T_mean)));
    return { temperature, label: temperature ? 'Temperature (K)' : 'Run number', x: r => temperature ? r.T_mean : P.runs.indexOf(r) + 1 };
  }
  function propertySeries(runs, property, factor, axis) {
    return [false,true].flatMap(simulated => {
      const points = runs.filter(r=>!!r.simulated === simulated && Number.isFinite(axis.x(r)) && Number.isFinite(property(r))).sort((a,b)=>axis.x(a)-axis.x(b));
      const x=points.map(axis.x), y=points.map(r=>property(r)*factor), color=simulated?'#ad7521':'#205f8e';
      return [{x,y,color,kind:'points'}, ...(axis.temperature ? [{x,y,color}] : [])];
    });
  }
  function renderAnalysis() {
    const runs = visibleRuns(), axis = analysisAxis(runs);
    const t = $('a-table'); t.innerHTML = '<tr>' + COLS.map(c => `<th>${esc(c[1])}</th>`).join('') + '</tr>';
    runs.forEach(r => { const tr = t.insertRow(); tr.classList.toggle('sel',r.id===selRun); COLS.forEach(c => tr.insertCell().textContent = resultCell(c[2](r))); });
    const selected = $('a-run'); selected.replaceChildren(); runs.forEach(r=>selected.add(new Option(r.id + (r.simulated?' · simulated':' · measured'),r.id)));
    if (!runs.some(r=>r.id===selRun)) selRun=runs[0]?.id || null;
    selected.value=selRun || '';
    const r=runById(selRun), s=r ? analysisSample(r) : {};
    for (const [id,key] of [['a-thickness','thickness_nm'],['a-field','B_T'],['a-tilt','tilt_deg'],['a-rsq','rsq_ohm']]) { $(id).value=s[key] ?? ''; $(id).disabled=!r; }
    for (const id of ['a-apply','a-reset','a-inspect']) $(id).disabled=!r;
    $('a-csv').disabled=!runs.length; $('a-refit').disabled=!P.runs.length;
    $('analysis-empty').hidden=!!P.runs.length;
    $('analysis-content').hidden=!P.runs.length;
    $('a-kpis').innerHTML=[['Runs shown',runs.length],['Analyzed',runs.filter(r=>r.fit && Number.isFinite(r.derived?.RH)).length],['Fit failed / partial',runs.filter(r=>!r.fit).length],['Simulated',runs.filter(r=>r.simulated).length]].map(([label,value])=>`<div class="kpi"><span>${label}</span><b>${value}</b></div>`).join('');
    $('a-notice').textContent = !runs.length ? 'No runs match this filter.' : axis.temperature ? `${runs.filter(r=>!Number.isFinite(r.T_mean)).length} runs without temperature are omitted from these plots.` : 'Plotted by run number so measurements without recorded temperature remain visible.';
    $('a-run-status').textContent = r ? `${r.id}: ${r.fitError || `${r.fit.n} usable samples; ${r.fit.levels} current levels.`} ${r.derived?.warnings?.join(' ') || ''}` : '';
    const specs=[['c-ns',r=>r.derived?.ns,1e-4,'Hall sheet density (cm⁻²)'],['c-mu',r=>r.derived?.mu,1e4,'Hall mobility (cm²/Vs)'],['c-rh',r=>r.derived?.RH,1e6,'Hall coefficient (cm³/C)'],['c-rs',r=>analysisSample(r).rsq_ohm,1,'Sheet resistance (Ω)']];
    specs.forEach(([id,fn,factor,label])=>HH.plot($(id),propertySeries(runs,fn,factor,axis),{xlabel:axis.label,ylabel:label,integerX:!axis.temperature}));
  }
  $('a-run').onchange=()=>{selRun=$('a-run').value;renderAnalysis();};
  $('a-filter').onchange=renderAnalysis; $('a-axis').onchange=renderAnalysis;
  $('a-inspect').onclick=()=>{ $('i-live').checked=false; show('inspect'); };
  $('a-apply').onclick=()=>{
    const r=runById(selRun); if (!r) return;
    const values={};
    for (const [id,key] of [['a-thickness','thickness_nm'],['a-field','B_T'],['a-tilt','tilt_deg'],['a-rsq','rsq_ohm']]) {
      const text=$(id).value.trim(); values[key]=text === '' ? null : Number(text);
    }
    if (!Number.isFinite(values.thickness_nm) || values.thickness_nm<=0 || !Number.isFinite(values.B_T) || values.B_T<=0 || !Number.isFinite(values.tilt_deg) || (values.rsq_ohm !== null && (!Number.isFinite(values.rsq_ohm) || values.rsq_ohm<=0))) { $('a-run-status').textContent='Enter positive thickness and field, a finite tilt, and positive sheet resistance or leave it blank.'; return; }
    r.analysisSample=values; fitRun(r); dirty=true; hist(P,'analysis',r.id+': applied analysis geometry and resistance',values); renderAnalysis();
  };
  $('a-reset').onclick=()=>{const r=runById(selRun);if(!r)return;delete r.analysisSample;fitRun(r);dirty=true;hist(P,'analysis',r.id+': restored acquisition geometry');renderAnalysis();};
  $('a-refit').onclick=()=>{P.runs.forEach(fitRun);dirty=true;hist(P,'analysis','Recalculated all run fits and physical properties');renderAnalysis();};
  const csvCell = v => { const text=v===undefined || v===null || (typeof v==='number'&&!Number.isFinite(v))?'':String(v); return /[",\r\n]/.test(text)?'"'+text.replace(/"/g,'""')+'"':text; };
  $('a-csv').onclick=()=>{download((P.sample.id||'hall')+'_summary.csv',[COLS.map(c=>csvCell(c[1])).join(','),...visibleRuns().map(r=>COLS.map(c=>csvCell(c[2](r))).join(','))].join('\r\n'),'text/csv');Logger.info('IO','Exported summary CSV');};
  /* ---------------- history ---------------- */
  function renderHistory() {
    const t = $('h-table'); t.innerHTML = '<tr><th>#</th><th>Time</th><th>Kind</th><th>Event</th></tr>';
    P.history.slice(-2000).forEach((h, i) => { const tr = t.insertRow(); tr.insertCell().textContent = i + 1; tr.insertCell().textContent = h.t.replace('T', ' ').slice(0, 19); tr.insertCell().textContent = h.kind; const c = tr.insertCell(); c.textContent = h.text; c.style.whiteSpace = 'normal'; });
  }
  bus.on('history:add', () => { if (current === 'history') renderHistory(); });
  $('h-csv').onclick = () => download('history.csv', 'time,kind,event\n' + P.history.map(h => [h.t, h.kind, h.text].map(csvCell).join(',')).join('\n'), 'text/csv');

  /* ---------------- log ---------------- */
  const RANK = { debug: 3, verbose: 2, normal: 1, warn: 0, error: 0 };
  function logPasses(e) {
    const v = $('l-view').value, f = $('l-filter').value.toLowerCase();
    if (v === 'warn') { if (e.level !== 'warn' && e.level !== 'error') return false; } else if (RANK[e.level] > RANK[v]) return false;
    return !f || (e.src + ' ' + e.msg).toLowerCase().includes(f);
  }
  function logLine(e) {
    const d = document.createElement('span'); d.className = 'll l-' + e.level;
    d.textContent = `${new Date(e.t).toISOString().slice(11, 23)} ${e.level.toUpperCase().padEnd(7)} ${e.src}: ${e.msg}` + (e.data !== undefined ? ' ' + JSON.stringify(e.data) : ''); return d;
  }
  function renderLog() {
    $('l-level').value = Logger.level; const box = $('logview'); box.replaceChildren(...Logger.entries.filter(logPasses).slice(-3000).map(logLine));
    $('l-count').textContent = `${Logger.entries.length} entries captured`; if ($('l-follow').checked) box.scrollTop = box.scrollHeight;
  }
  bus.on('log:add', e => {
    if (current !== 'log') return; if (!logPasses(e)) return;
    const box = $('logview'); box.append(logLine(e)); while (box.childElementCount > 3000) box.firstChild.remove();
    $('l-count').textContent = `${Logger.entries.length} entries captured`; if ($('l-follow').checked) box.scrollTop = box.scrollHeight;
  });
  bus.on('log:level', l => { $('l-level').value = l; });
  $('l-level').onchange = () => { Logger.setLevel($('l-level').value); hist(P, 'log', 'log level → ' + $('l-level').value); };
  $('l-view').onchange = renderLog; $('l-filter').oninput = renderLog;
  $('l-clear').onclick = () => { if (confirm('Clear the in-memory log?')) { Logger.clear(); renderLog(); } };
  $('l-save').onclick = () => download('hall_log_' + new Date().toISOString().replace(/[:.]/g, '-') + '.txt', Logger.toText(logPasses));

  /* ---------------- project / report ---------------- */
  function msg(t, kind) { $('pr-msg').innerHTML = `<div class="notice ${kind || ''}">${esc(t)}</div>`; }
  $('pr-save').onclick = () => {
    hist(P, 'project', 'saved project'); Logger.info('IO', 'Saved project');
    P.log = Logger.entries.slice(-20000); P.modified = new Date().toISOString();
    const name = (P.sample.id || 'hall_project').replace(/[^\w.-]+/g, '_') + '.hallproj.json';
    download(name, JSON.stringify(P), 'application/json'); dirty = false;
    msg('Saved ' + name, 'ok');
  };
  $('pr-load').onchange = async ev => {
    const f = ev.target.files[0]; ev.target.value = ''; if (!f) return;
    try {
      await loadProjectObject(JSON.parse(await f.text()), f.name);
    } catch (e) {
      Logger.error('IO', 'Load failed: ' + e.message);
      msg('Load failed: ' + e.message, 'err');
    }
  };
  $('pr-new').onclick = async () => { if (running) return; if (!confirm('Start a new project? Unsaved data will be lost.')) return; P = newProject(); connectionCheck = null; ctrl = null; simDev = null; dirty = false; selRun = null; trace={t:[],T:[],sp:[]};stepState=[];syncForm(); setBadges(); hist(P, 'project', 'new project'); show(canMeasure() ? 'mode' : 'project'); };
  $('pr-csv').onclick = () => {
    const r = runById(selRun) || P.runs[0]; if (!r) { msg('No runs to export.', 'err'); return; }
    const s = r.samples; download(`${r.id}_raw.csv`, 't_s,theta_rad,X_V,Y_V,I_A,T_K,valid\r\n' + s.t.map((t, i) => [t, s.theta[i], s.X[i], s.Y[i], s.I[i], s.T[i], s.valid[i]].map(csvCell).join(',')).join('\r\n'), 'text/csv');
  };
  $('i-export').onclick = () => $('pr-csv').onclick();
  function chartImage(series, o) { const c = document.createElement('canvas'); c.width = 760; c.height = 300; return HH.plot(c, series, Object.assign({ print: true }, o)); }
  function modeRows(row) {
    const m = P.method, md = HH.MODES[m.kind]; if (!md) return row('Mode', 'unknown');
    const r = [row('Mode', md.label + ' (' + md.ref + ')')];
    if (m.kind === 'chirp') r.push(row('Carrier', m.carrier_hz + ' Hz'), row('Current levels (RMS)', m.levels_mA.join(', ') + ' mA'), row('Rotation', m.rot_hz + ' Hz, ' + m.direction), row('Cycles / dwell / mask', m.cycles + ' cycles (' + fx(HH.chirpDwell(m), 3) + ' s) / ' + m.mask_s + ' s'));
    else for (const [k, v] of Object.entries(m[m.kind])) r.push(row(k, v));
    return r.join('');
  }
  $('pr-report').onclick = () => {
    const ok = P.runs.filter(r => r.derived), s = P.sample, m = P.method;
    const axis = analysisAxis(ok);
    const row = (a, b) => `<tr><th>${esc(a)}</th><td>${esc(b)}</td></tr>`;
    const imgs = ok.length ? [['n_s (cm⁻²)', r => r.derived.ns,1e-4], ['μ (cm²/Vs)', r => r.derived.mu,1e4], ['R_H (cm³/C)', r => r.derived.RH,1e6]].map(([l,fn,factor])=>`<h3>${esc(l)}</h3><img alt="${esc(l)}" src="${chartImage(propertySeries(ok,fn,factor,axis),{xlabel:axis.label,ylabel:l})}">`).join('') : '<p>No analysed runs.</p>';
    const steps = P.tempProgram.map((st, i) => `<tr><td>${i + 1}</td><td>${esc(st.type)}</td><td>${esc(JSON.stringify(Object.fromEntries(Object.entries(st).filter(([k]) => k !== 'type'))))}</td></tr>`).join('');
    const logs = Logger.entries.filter(e => e.level === 'warn' || e.level === 'error').slice(-50).map(e => `<tr><td>${esc(new Date(e.t).toISOString())}</td><td>${esc(e.level)}</td><td>${esc(e.src + ': ' + e.msg)}</td></tr>`).join('');
    const sim = P.runs.some(r => r.simulated);
    const reportCols = COLS.filter(c=>['id','source','T','ns','n','rh','mu','rho'].includes(c[0]));
    $('report').innerHTML = `<h1>Hall effect measurement report</h1>${sim ? '<p><b>WARNING: contains SIMULATED data — not a measurement.</b></p>' : ''}
      <p>Generated ${esc(new Date().toLocaleString())}. Project created ${esc(P.created)}.</p>
      <h2>Sample</h2><table>${row('ID', s.id)}${row('Thickness', s.thickness_nm + ' nm')}${row('Width × length', s.width_um + ' × ' + s.length_um + ' µm')}${row('Field B', s.B_T + ' T')}${row('Tilt', s.tilt_deg + '°')}${row('Notes', s.notes)}</table>
      <h2>Measurement mode</h2><table>${modeRows(row)}${row('Lock-in time constant', m.tc_ms + ' ms')}${row('Current source', (HH.SOURCES[P.hardware.source.model] || {}).name || 'none')}${row('Temperature controller', tl().model + ' ' + tl().address + ', input ' + tl().input + ', loop ' + tl().loop)}</table>
      <h2>Temperature program</h2><table><tr><th>#</th><th>Step</th><th>Parameters</th></tr>${steps}</table>
      <h2>Results</h2><table><tr>${reportCols.map(c => `<th>${esc(c[1])}</th>`).join('')}</tr>${P.runs.map(r => '<tr>' + reportCols.map(c => `<td>${esc(resultCell(c[2](r)))}</td>`).join('') + '</tr>').join('')}</table>
      <h2>Fit diagnostics and statistical uncertainties (1σ)</h2><table><tr><th>Run</th><th>A1 ± σ (Ω)</th><th>n_s ± σ (cm⁻²)</th><th>R_H ± σ (cm³/C)</th><th>μ ± σ (cm²/Vs)</th><th>Status / warnings</th></tr>${P.runs.map(r=>'<tr>'+[r.id,fx(r.fit?.A1)+' ± '+fx(r.fit?.A1_err),fx(scaled(r.derived?.ns,1e-4))+' ± '+fx(scaled(r.derived?.ns_err,1e-4)),fx(scaled(r.derived?.RH,1e6))+' ± '+fx(scaled(r.derived?.RH_err,1e6)),fx(scaled(r.derived?.mu,1e4))+' ± '+fx(scaled(r.derived?.mu_err,1e4)),r.fitError||r.derived?.warnings?.join(' ')||'Fit completed'].map(v=>`<td>${esc(v)}</td>`).join('')+'</tr>').join('')}</table>
      <h2>Inputs used for each run</h2><table><tr><th>Run</th><th>Method</th><th>Thickness (nm)</th><th>B (T)</th><th>Tilt (°)</th><th>R□ (Ω)</th><th>Analysis correction</th></tr>${P.runs.map(r=>{const a=analysisSample(r);return '<tr>'+[r.id,HH.MODES[r.method.kind]?.label||r.method.kind,a.thickness_nm,a.B_T,a.tilt_deg,a.rsq_ohm,r.analysisSample?'yes':'no'].map(v=>`<td>${esc(resultCell(v))}</td>`).join('')+'</tr>';}).join('')}</table>
      <div class="pb"></div><h2>Plots</h2>${imgs}
      <h2>Assumptions</h2><p>Quantities follow the CHIRP guide §10 and assume a uniform bar geometry, ohmic contacts, an ordinary Hall coefficient independent of field orientation, and a validated field magnitude and angle calibration. n<sub>s</sub> is the Hall sheet density (no scattering factor applied); µ is the Hall mobility. Uncertainties are 1σ statistical from the harmonic fit only; calibration and geometry uncertainty are not included.</p>
      <h2>Warnings and errors (last 50)</h2><table>${logs || '<tr><td>None recorded</td></tr>'}</table>
      <h2>History</h2><table>${P.history.slice(-60).map(h => `<tr><td>${esc(h.t)}</td><td>${esc(h.kind)}</td><td>${esc(h.text)}</td></tr>`).join('')}</table>`;
    hist(P, 'project', 'report printed'); Logger.info('IO', 'Report generated'); window.print();
  };

  /* ---------------- Live Actual Values Telemetry & Zero Position ---------------- */
  let actualTelemetry = {
    T: null, sp: null, current_mA: 0, outputOn: false,
    voltageX: null, voltageY: null, angleDeg: null, counter: null,
    tempStatus: null, elapsedS: 0
  };
  let telemetryBusy = false;

  function updateActualTelemetry(data) {
    Object.assign(actualTelemetry, data);
    renderActualPanel();
  }

  function renderActualPanel() {
    const act = actualTelemetry;
    const isTempOn = P.hardware.temperature !== 'off';
    const tempK = act.T;
    $('act-temp').textContent = Number.isFinite(tempK) ? `${tempK.toFixed(3)} K` : '— K';

    let stabText = 'Status: idle';
    let badgeClass = '';
    let badgeLabel = 'Temp: —';

    if (!isTempOn) {
      stabText = 'Temperature: OFF';
      badgeLabel = 'Temp: OFF';
    } else if (act.tempStatus) {
      const ts = act.tempStatus;
      if (ts.ramping) {
        stabText = `Ramping to ${ts.targetK} K | ΔT=${fx(ts.deltaK, 3)} K`;
        badgeLabel = 'Ramping';
        badgeClass = 'sim';
      } else if (ts.stable) {
        stabText = `Stable at ${fx(ts.actualK, 3)} K (ΔT=${fx(ts.meanDeltaK ?? ts.deltaK, 4)} K, ESD=${fx(ts.esdK, 4)} K, ${Math.round(ts.stableForS)} s)`;
        badgeLabel = 'Stable';
        badgeClass = 'ok';
      } else {
        stabText = `Stabilizing (in band ${Math.round(ts.stableForS || 0)}/${ts.minStabS || 60} s, |ΔT|=${fx(ts.meanDeltaK ?? ts.deltaK, 3)} K, ESD=${fx(ts.esdK, 3)} K)`;
        badgeLabel = 'Stabilizing';
        badgeClass = 'sim';
      }
    } else if (Number.isFinite(tempK)) {
      stabText = P.hardware.temperature === 'control' ? (act.sp ? `Setpoint: ${act.sp} K` : 'Monitor mode') : 'Read-only sensor';
      badgeLabel = `${P.hardware.temperature} (${tempK.toFixed(2)} K)`;
      badgeClass = 'ok';
    }
    $('act-temp-status').textContent = stabText;
    const tb = $('act-temp-badge');
    if (tb) {
      tb.textContent = badgeLabel;
      tb.className = 'actual-badge ' + badgeClass;
    }
    const hwSt = $('hw-temp-status');
    if (hwSt) {
      hwSt.textContent = `${badgeLabel} — ${stabText}`;
      hwSt.className = 'notice ' + (badgeClass === 'ok' ? 'ok' : '');
    }

    // Time
    $('act-time').textContent = running ? fmtDur(act.elapsedS || vnow) : '0 min 0 s';
    $('act-clock').textContent = new Date().toLocaleTimeString();

    // Current & Output State
    $('act-current').textContent = `${(act.current_mA || 0).toFixed(3)} mA`;
    const outB = $('act-output-badge');
    if (outB) {
      outB.textContent = act.outputOn ? 'OUTPUT ON' : 'OUTPUT OFF';
      outB.className = 'badge ' + (act.outputOn ? 'run' : '');
    }

    // Measured Voltage
    if (Number.isFinite(act.voltageX)) {
      $('act-voltage').textContent = `${fx(act.voltageX, 4)} V`;
      $('act-voltage-sub').textContent = Number.isFinite(act.voltageY) ? `X: ${fx(act.voltageX, 4)} V | Y: ${fx(act.voltageY, 4)} V` : `V: ${fx(act.voltageX, 4)} V`;
    } else {
      $('act-voltage').textContent = '— V';
      $('act-voltage-sub').textContent = 'X: — | Y: —';
    }

    // Magnet Angle
    if (Number.isFinite(act.angleDeg)) {
      $('act-angle').textContent = `${act.angleDeg.toFixed(2)}°`;
    } else {
      $('act-angle').textContent = '—°';
    }
    $('act-counter').textContent = Number.isFinite(act.counter) ? `Counter: ${act.counter} incs` : 'Counter: — incs';
  }

  async function pollLiveTelemetry() {
    if (!canMeasure() || checking || telemetryBusy || !connectionsOk()) return;
    if (running && P.hardware.backend === 'real') return;
    telemetryBusy = true;
    try {
      if (P.hardware.backend === 'real' && window.HHHardware) {
        // Read temperature if active
        if (P.hardware.temperature !== 'off' && P.hardware.tempController.address) {
          try {
            const tr = await window.HHHardware.readDevice({
              role: 'temperature',
              model: P.hardware.tempController.model,
              address: P.hardware.tempController.address,
              input: P.hardware.tempController.input
            });
            if (tr && Number.isFinite(tr.temperatureK)) {
              actualTelemetry.T = tr.temperatureK;
            }
          } catch (_) {}
        }
        // Read OWIS motor position
        if (P.hardware.magnet.rotator_addr) {
          try {
            const mr = await window.HHHardware.readDevice({
              role: 'motion',
              model: 'OWISPS10',
              address: P.hardware.magnet.rotator_addr,
              baud: P.hardware.magnet.baud || 9600,
              unit: P.hardware.magnet.unit || 1,
              axis: P.hardware.magnet.axis || 1,
              countsPerTurn: P.hardware.magnet.counts_per_turn,
              angleOffsetDeg: P.hardware.magnet.angle_offset_deg || 0,
              dirSign: P.hardware.magnet.dir_sign || 1
            });
            if (mr) {
              actualTelemetry.counter = mr.counter;
              actualTelemetry.angleDeg = mr.angleDeg;
            }
          } catch (_) {}
        }
      } else if (P.hardware.backend === 'simulation') {
        if (ctrl) {
          try {
            actualTelemetry.T = await ctrl.readK();
            actualTelemetry.sp = await ctrl.getSetpoint();
          } catch (_) {}
        }
      }
      renderActualPanel();
    } catch (e) {
      Logger.debug('ACT', 'Poll readings: ' + e.message);
    } finally { telemetryBusy = false; }
  }

  async function setZeroPosition() {
    if (!canMeasure() || configurationLocked() || running || checking) return;
    const statusEl = $('zero-pos-status');
    try {
      if (P.hardware.backend === 'real' && window.HHHardware && P.hardware.magnet.rotator_addr) {
        const mr = await window.HHHardware.readDevice({
          role: 'motion',
          model: 'OWISPS10',
          address: P.hardware.magnet.rotator_addr,
          baud: P.hardware.magnet.baud || 9600,
          unit: P.hardware.magnet.unit || 1,
          axis: P.hardware.magnet.axis || 1,
          countsPerTurn: P.hardware.magnet.counts_per_turn,
          angleOffsetDeg: 0,
          dirSign: 1
        });
        if (mr && Number.isFinite(mr.counter)) {
          const rawAngle = (mr.counter * 360.) / (P.hardware.magnet.counts_per_turn || 50000);
          const dir = P.hardware.magnet.dir_sign || 1;
          const newOffset = -rawAngle * dir;
          P.hardware.magnet.angle_offset_deg = newOffset;
          dirty=true;connectionCheck=null;
          syncForm();
          if (statusEl) statusEl.textContent = `+B reference set at stage ${fx(rawAngle)}° (counter ${mr.counter}); field angle is now 0°.`;
          hist(P, 'config', `Set +B reference at counter ${mr.counter}`);
          actualTelemetry.angleDeg = 0.0;
          actualTelemetry.counter = mr.counter;
          renderActualPanel();
          return;
        }
      }
      if (P.hardware.backend !== 'simulation') throw new Error('No valid motor position received. Zero calibration was not changed.');
      P.hardware.magnet.angle_offset_deg = 0;
      dirty=true;connectionCheck=null;
      actualTelemetry.angleDeg = 0.0;
      if (statusEl) statusEl.textContent = 'Simulated +B reference set at stage 0°.';
      syncForm();
      renderActualPanel();
    } catch (e) {
      if (statusEl) statusEl.textContent = 'Error: ' + e.message;
      Logger.error('ZERO', e.message);
    }
  }

  $('btn-refresh-actual').onclick = pollLiveTelemetry;
  $('btn-quick-zero').onclick = setZeroPosition;
  const zeroBtn2 = $('btn-set-zero-pos');
  if (zeroBtn2) zeroBtn2.onclick = setZeroPosition;

  const cal50000 = $('cal-50000');
  if (cal50000) cal50000.onclick = () => {
    if (!canMeasure() || configurationLocked()) return;
    P.hardware.magnet.counts_per_turn = 50000;
    dirty=true;connectionCheck=null;
    syncForm();
    hist(P, 'config', 'OWIS counts set to 50000 (138.89 inc/deg, 400°=55556 inc)');
  };
  const cal50040 = $('cal-50040');
  if (cal50040) cal50040.onclick = () => {
    if (!canMeasure() || configurationLocked()) return;
    P.hardware.magnet.counts_per_turn = 50040;
    dirty=true;connectionCheck=null;
    syncForm();
    hist(P, 'config', 'OWIS counts set to 50040 (139 inc/deg)');
  };

  setInterval(() => {
    if (!running) {
      renderActualPanel();
    }
  }, 1000);

  /* ---------------- Workstation access ---------------- */
  async function connectWorkstation() {
    if (running || checking) return;
    accessChecking = true; setBadges(); refreshTabs();
    const result = await window.HHHardware.connect();
    hardwareAuthenticated = result.ok; accessChecking = false;
    connectionCheck = null; ctrl = null; simDev = null;
    $('access-status').textContent = result.ok ? 'Local service connected' : result.error;
    setBadges(); refreshTabs();
    if (result.ok && !P.runs.length && ['analysis','project'].includes(current)) show('mode');
    else if (!result.ok && !reachable(current)) show(P.runs.length ? 'analysis' : 'project');
  }
  $('workstation-reconnect').onclick = connectWorkstation;
  $('open-project').onclick = () => $('pr-load').click();
  /* ---------------- Global Drag & Drop for Projects ---------------- */
  window.addEventListener('dragover', e => { e.preventDefault(); });
  window.addEventListener('drop', async e => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (!f || !f.name.endsWith('.json')) return;
    try {
      const text = await f.text();
      const o = JSON.parse(text);
      if (o.format === 'halbach-hall-project') {
        await loadProjectObject(o, f.name);
      } else if (o.format === 'halbach-hall-preset') {
        await loadPreset(o);
      }
    } catch (err) {
      Logger.error('IO', 'Drop load failed: ' + err.message);
    }
  });

  /* ---------------- init ---------------- */
  window.addEventListener('beforeunload', e => { if (dirty || running) { e.preventDefault(); e.returnValue = ''; } });
  window.addEventListener('error', e => Logger.error('JS', e.message));
  window.addEventListener('unhandledrejection', e => Logger.error('JS', 'Unhandled: ' + (e.reason && e.reason.message || e.reason)));
  window.addEventListener('hh:themechange',()=>renderPage(current));
  buildTabs(); syncForm(); setBadges(); connectWorkstation(); Logger.info('APP', 'Workstation started; select real instruments or explicit simulation'); hist(P, 'project', 'new project');
  show('project');
  window.HH.debugState = () => ({ P, ctrl, running, connectionsOk, runner, accessChecking, accessMode:canMeasure()?'workstation':'analysis' });
})();
