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
  let connectionCheck = null, checking = false;
  const connectionKey = () => JSON.stringify([P.hardware, HH.principle(P.method)]);
  const connectionsOk = () => connectionCheck?.ok && connectionCheck.key === connectionKey();
  let configurationReleased = false, appliedMethod = null, parameterBusy = false;
  let realJobId=null;
  const paused = () => running && runner?.state === 'paused';
  const configurationLocked = () => checking || (running ? !paused() : connectionsOk() && !configurationReleased);
  const principlePath = path => ['method.fixed.excitation','method.rotating.excitation','method.fixed.acq'].includes(path);
  let ctrl = null, simDev = null, runner = null, running = false, vnow = 0;
  let trace = { t: [], T: [], sp: [] }, stepState = [], selRun = null;

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
    if(running&&['run','temp','mode','hardware'].includes(id))return true;
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
      b.classList.toggle('done', FLOW.some(f => f[0] === id) && ok && id !== current && ['hardware', 'mode', 'sample', 'temp'].includes(id) && stepOk(id));
      b.setAttribute('aria-selected', id === current);
    });
    const i = FLOW.findIndex(f => f[0] === current), inFlow = i >= 0;
    $('pager').style.display = inFlow ? 'flex' : 'none';
    if (inFlow) { $('back').disabled = i === 0; $('next').disabled = i === FLOW.length - 1 || !reachable(FLOW[i + 1][0]); }
  }
  function show(id) {
    if (!reachable(id)) return;
    current = id;
    document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === 'p-' + id));
    Logger.verbose('UI', 'Tab ' + id);
    renderPage(id); refreshTabs(); window.scrollTo(0, 0);
  }
  function renderPage(id) {
    ({ mode: renderMode, sample: renderSample, temp: renderProgram, run: renderRun, inspect: renderInspect, analysis: renderAnalysis, history: renderHistory, log: renderLog, hardware: renderHardware })[id]?.();
  }
  $('back').onclick = () => { const i = FLOW.findIndex(f => f[0] === current); if (i > 0) show(FLOW[i - 1][0]); };
  $('next').onclick = () => { const i = FLOW.findIndex(f => f[0] === current); if (i < FLOW.length - 1) show(FLOW[i + 1][0]); };

  /* ---------------- data binding ---------------- */
  function getPath(o, p) { return p.split('.').reduce((a, k) => a?.[k], o); }
  function setPath(o, p, v) { const ks = p.split('.'); const last = ks.pop(); ks.reduce((a, k) => a[k], o)[last] = v; }
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
    const bridge=window.HHHardware.settings?.();
    if(bridge){$('rust-url').value=bridge.baseUrl;$('rust-token').value=bridge.token;}
  }
  document.querySelectorAll('[data-bind]').forEach(el => el.addEventListener('change', () => {
    const path = el.dataset.bind; let v = el.value;
    if(running && path==='hardware.backend') {syncForm();return;}
    if ((path.startsWith('hardware.') || principlePath(path)) && configurationLocked()) { syncForm(); return; }
    if (running && path.startsWith('sample.')) { syncForm(); return; }
    if ('bool' in el.dataset) v = v === 'true';
    else if ('num' in el.dataset) { if (v === '' && 'nullable' in el.dataset) v = null; else { v = Number(v); if (!isFinite(v)) { el.classList.add('bad'); return; } } }
    el.classList.remove('bad');
    const old = getPath(P, path); setPath(P, path, v);
    if (path.startsWith('hardware.') || principlePath(path)) { connectionCheck = null; ctrl = null; simDev = null; }
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
    if (configurationLocked()) throw new Error('Pause or stop before loading a preset.');
    if (o.format !== 'halbach-hall-preset' || !HH.MODES[o.method?.kind]) throw new Error('Invalid measurement preset.');
    const base = newProject();
    for (const k of ['fixed', 'rotating']) Object.assign(base.method[k], o.method[k] || {});
    for (const [k,v] of Object.entries(o.method)) if (!['fixed','rotating'].includes(k)) base.method[k] = v;
    for (const k of ['tempController','magnet','source','measure']) Object.assign(base.hardware[k], o.hardware?.[k] || {});
    for (const k of ['backend','temperature']) if (o.hardware?.[k]) base.hardware[k] = o.hardware[k];
    if (!Array.isArray(base.method.levels_mA) || !Array.isArray(base.method.rotating.currents_mA)) throw new Error('Preset current levels must be arrays.');
    if(base.method.fixed.excitation==='delta') {base.method.fixed.excitation='dc';base.hardware.measure.dc_mode='delta';}
    const errors = HH.principleErrors(base.method);
    if (errors.length) throw new Error('Invalid preset: ' + errors.join(' '));
    P.method = base.method; P.hardware = base.hardware;
    connectionCheck = null; ctrl = null; simDev = null; dirty = true;
    hist(P, 'preset', 'Loaded ' + (o.name || 'preset'));
    syncForm(); renderMode(); refreshTabs();
  }
  $('preset-file').onchange = async ev => {
    const f = ev.target.files[0]; ev.target.value = ''; if (!f) return;
    try { await loadPreset(JSON.parse(await f.text())); } catch (e) { $('mode-msg').textContent = e.message; }
  };
  $('save-preset').onclick = () => {
    if (checking) return;
    if (!P.method.kind) { $('preset-save-status').textContent='Choose a method first.'; return; }
    const preset={format:'halbach-hall-preset',version:1,name:HH.MODES[P.method.kind].label,method:JSON.parse(JSON.stringify(P.method)),hardware:JSON.parse(JSON.stringify(P.hardware))};
    download(P.method.kind+'.preset.json',JSON.stringify(preset,null,2),'application/json');
    $('preset-save-status').textContent='Saved method and device settings.';
  };

  /* ---------------- hardware ---------------- */
  for(const id of ['rust-url','rust-token']) $(id).addEventListener('change',()=>{
    try{window.HHHardware.configure({baseUrl:$('rust-url').value,token:$('rust-token').value});connectionCheck=null;ctrl=null;simDev=null;$('rust-settings-status').textContent='Local Rust connection settings updated.';renderHardware();refreshTabs();}
    catch(e){$('rust-settings-status').textContent=e.message;}
  });
  document.querySelectorAll('#hw-subtabs button').forEach(b => b.onclick = () => {
    document.querySelectorAll('#hw-subtabs button').forEach(x => x.classList.toggle('active', x === b));
    document.querySelectorAll('#p-hardware .subpane').forEach(x => x.classList.toggle('active', x.dataset.pane === b.dataset.sub));
  });
  function renderHardware() {
    const h = P.hardware, src = HH.SOURCES[h.source.model], lines = [];
    $('rust-settings').hidden=h.backend!=='real';
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
    if (h.measure.lockin1 === 'SR830' && h.measure.lockin2 === 'SR830' && h.measure.lockin1_addr && h.measure.lockin1_addr === h.measure.lockin2_addr) warn.push('Two SR830s share the same address.');
    $('measure-msg').innerHTML = warn.map(x => `<div class="notice err">${esc(x)}</div>`).join('');
    for(const k of ['lockin1','lockin2']) document.querySelector(`[data-bind="hardware.measure.${k}_addr"]`).placeholder = h.measure[k]==='AMETEK7230' ? '192.168.1.100:50000' : 'GPIB0::8::INSTR';
    if ([h.measure.lockin1,h.measure.lockin2].includes('AMETEK7230')) $('measure-msg').innerHTML+='<p class="muted">Ametek 7230: enter the Ethernet host/IP or host:50000.</p>';
    setBadges();
    $('connection-results').innerHTML = connectionCheck && connectionCheck.key === connectionKey()
      ? connectionCheck.results.map(r => `<div class="notice ${r.warning ? '' : r.ok ? 'ok' : 'err'}">${esc(r.role)}: ${esc(r.message)}</div>`).join('')
      : '<div class="notice">Connections not checked for this configuration.</div>';
    const configErrors = HH.connectionErrors(P);
    $('check-connections').disabled = configurationLocked() || configErrors.length > 0;
    $('check-reference').hidden = HH.usesVoltmeter(P.method);
    $('check-requirements').textContent = configErrors.length ? 'Configure the required devices and addresses: ' + configErrors.join('; ') : 'Required instruments configured. Ready to check connections.';
    for (const path of ['hardware.magnet.host', 'hardware.magnet.encoder_addr', 'hardware.magnet.encoder_ppr']) document.querySelector(`[data-bind="${path}"]`).closest('.field').hidden = !h.magnet.encoder;
    const isDC = HH.usesVoltmeter(P.method);
    document.querySelectorAll('[data-bind^="hardware.measure."]').forEach(el => {
      const dc = /\.(volt|volt_addr|dc_mode)$/.test(el.dataset.bind);
      el.closest('.field').hidden = dc ? !isDC : isDC;
    });
    document.querySelector('[data-bind="hardware.measure.volt_addr"]').closest('.field').hidden = !isDC || HH.isDelta(P);
    $('delta-info').hidden = !HH.isDelta(P);
    const exc = HH.excitationOf(P.method);
    document.querySelectorAll('[data-bind="hardware.source.model"] option').forEach(o => { o.disabled = !!o.value && (!HH.SOURCES[o.value]?.[exc === 'delta' ? 'dc' : exc] || (HH.isDelta(P) && !['K6220','K6221'].includes(o.value))); });
    $('measure-msg').innerHTML += HH.connectionErrors(P).map(e => `<div class="notice err">${esc(e)}</div>`).join('');
    document.querySelector('[data-pane="temp"]').hidden = h.temperature === 'off';
    document.querySelector('#hw-subtabs [data-sub="temp"]').hidden = h.temperature === 'off';
    if (h.temperature === 'off' && document.querySelector('[data-pane="temp"]').classList.contains('active')) document.querySelector('#hw-subtabs [data-sub="magnet"]').click();
  }
  $('check-connections').onclick = async () => {
    if (configurationLocked() || HH.connectionErrors(P).length) return;
    checking = true; connectionCheck = null;
    const key = connectionKey(), snapshot = JSON.parse(JSON.stringify(P));
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
    if (running || checking) return;
    const ds = HH.selectedDevices(P).filter(d => d.role.startsWith('lockin'));
    if (!ds.length || HH.connectionErrors(P).length) { $('reference-result').textContent = 'Configure a lock-in and its address first.'; return; }
    $('check-reference').disabled = true;
    $('reference-result').textContent = 'Waiting for TTL reference lock…';
    try {
      for (const d of ds) {
        const r = P.hardware.backend === 'simulation' ? { frequencyHz: P.method.kind === 'rotating' && P.method.rotating.excitation === 'dc' ? P.method.rotating.rot_hz : P.method.carrier_hz } : await window.HHHardware.waitForReference(d);
        $('reference-result').textContent = (P.hardware.backend === 'simulation' ? 'SIMULATED: ' : '') + d.model + ' locked at ' + r.frequencyHz + ' Hz';
      }
    } catch (e) { $('reference-result').textContent = e.message; Logger.error('REF', e.message); }
    finally { $('check-reference').disabled = false; }
  };
  function setBadges() {
    $('b-mode').textContent = P.hardware.backend === 'simulation' ? 'SIMULATION: synthetic data' : 'Real instruments';
    const m = $('b-ls'); m.textContent = P.hardware.temperature === 'off' ? 'Temp: OFF' : P.hardware.backend === 'real' && connectionsOk() ? 'Temp: verified ('+P.hardware.temperature+')' : ctrl ? `Temp: ${P.hardware.temperature} (simulated)` : 'Temp: not connected'; m.className = 'badge ' + (ctrl || connectionsOk() ? 'ok' : '');
    const r = $('b-run'); r.textContent = running ? (runner?.state === 'paused' ? 'Paused' : 'Running') : 'Idle'; r.className = 'badge ' + (running ? 'run' : '');
    $('ls-connect').disabled = true; $('ls-disconnect').disabled = configurationLocked() || !ctrl; $('ls-heateroff').disabled = !ctrl || P.hardware.temperature !== 'control';
    document.querySelectorAll('[data-bind]').forEach(el => el.disabled = el.closest('#p-mode,#p-hardware') ? configurationLocked() : el.dataset.bind.startsWith('sample.') ? running || checking : checking);
    if(running) document.querySelector('[data-bind="hardware.backend"]').disabled=true;
    document.querySelectorAll('#f-levels,#f-dc-currents').forEach(el=>el.disabled=checking);
    document.querySelectorAll('#p-temp .toolbar input,#p-temp .toolbar select,#p-temp .toolbar button').forEach(el=>el.disabled=running||checking);
    $('save-preset').disabled=checking; $('preset-file').disabled=configurationLocked();
    $('rust-url').disabled=configurationLocked();$('rust-token').disabled=configurationLocked();
    document.querySelectorAll('#mode-cards button').forEach(button=>button.disabled=configurationLocked());
    document.querySelectorAll('[data-step-index]').forEach(input=>input.disabled=running&&Number(input.dataset.stepIndex)<=(runner?.index??stepState.findIndex(x=>x==='start')));
    document.querySelectorAll('[data-release-config]').forEach(button=>{button.hidden=!connectionsOk()||configurationReleased;button.disabled=running||checking;});
    const lockMessage=checking?'Checking connections…':configurationLocked()?'Validated configuration is read only. Pause or stop to change the method or devices.':'Choose the method and devices, then check connections.';
    $('method-lock').textContent=lockMessage;$('device-lock').textContent=lockMessage;
    $('apply-parameters').disabled=checking||parameterBusy||HH.modeErrors(P).length>0||progErrors().length>0;
    $('r-pause').disabled=!running||runner?.state==='pausing'||(paused()&&(!connectionsOk()||HH.modeErrors(P).length>0));
    $('r-speed').disabled = running || P.hardware.backend === 'real';
  }
  async function connectController() {
    if (P.hardware.backend !== 'simulation' || P.hardware.temperature === 'off') return;
    const c = P.hardware.tempController;
    try {
      simDev = new HH.SimLakeShore(c.model, 295, 7);
      const d = new HH.LakeShore(c.model, simDev, { input: c.input, loop: c.loop });
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
    const av = HH.availability(P.hardware), m = P.method, box = $('mode-cards'); box.replaceChildren();
    for (const [k, md] of Object.entries(HH.MODES)) {
      const a = av[k], b = document.createElement('button'); b.className = 'mode-card' + (m.kind === k ? ' sel' : ''); b.disabled = configurationLocked();
      const why = a.ok ? '' : md.variants.map(v => `${HH.EXC[v]}: needs ${a.variants[v].missing.join(', ')}`).join(' · ');
      b.innerHTML = `<b>${esc(md.label)}</b><small>${esc(md.ref)}</small><small>${esc(md.text)}</small>`;
      b.onclick = () => {
        if(configurationLocked()) return;
        const old = m.kind; m.kind = k; const ex = m[k] && m[k].excitation;
        connectionCheck = null; ctrl = null; simDev = null;
        hist(P, 'config', `mode: ${old || 'none'} → ${k}`); dirty = true; syncForm(); renderMode(); refreshTabs();
      };
      box.append(b);
    }
    const presetCard=document.createElement('button');presetCard.className='mode-card';presetCard.id='preset-card';presetCard.disabled=configurationLocked();
    presetCard.innerHTML='<b>Load preset</b><small>Open a JSON file containing the method and devices.</small>';
    presetCard.onclick=()=> $('preset-file').click();box.append(presetCard);
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
    const parameterErrors=m.kind?HH.modeErrors(P):[];
    $('experiment-msg').innerHTML=parameterErrors.map(x=>`<div class="notice err">${esc(x)}</div>`).join('');
    const e = HH.principleErrors(m), w = [];
    $('mode-msg').innerHTML = (m.kind ? '' : '<div class="notice">Select a mode.</div>') + e.map(x => `<div class="notice err">${esc(x)}</div>`).join('') + w.map(x => `<div class="notice">${esc(x)}</div>`).join('') +
      (m.kind && !e.length ? '<div class="notice ok">Select compatible devices next. Set numerical parameters in Experiment setup.</div>' : '');
    setBadges();
  }
  function renderSample() {
    const w = []; if (P.sample.tilt_deg !== 0) w.push('Non-zero tilt: guide recommends validating zero-tilt ordinary Hall first.');
    $('sample-msg').innerHTML = HH.sampleErrors(P).map(x => `<div class="notice err">${esc(x)}</div>`).join('') + w.map(x => `<div class="notice">${esc(x)}</div>`).join('');
  }

  /* ---------------- temperature program ---------------- */
  const tl = () => P.hardware.tempController;
  function progErrors() {
    const e = HH.validateProgram(P.tempProgram, { maxK: tl().maxK, maxRateKmin: tl().maxRateKmin });
    if (P.hardware.temperature !== 'control' && P.tempProgram.some(s => ['goto', 'heater_off'].includes(s.type))) e.push('Temperature OFF/read only permits measurement and soak steps. Remove temperature control steps or enable control.');
    return e;
  }
  function renderProgram() {
    renderMode();
    const sel = $('add-type'); if (!sel.childElementCount) for (const [k, v] of Object.entries(HH.STEP_TYPES)) sel.add(new Option(v.label, k));
    for (const o of sel.options) o.disabled = P.hardware.temperature !== 'control' && ['goto', 'heater_off'].includes(o.value);
    if (sel.selectedOptions[0]?.disabled) sel.value = 'measure';
    $('add-sweep').disabled = running || P.hardware.temperature !== 'control';
    const t = $('prog-table'), cols = { goto: ['T', 'rate', 'range', 'tol', 'mean_tol', 'window_s', 'timeout_s'], soak: ['seconds'], measure: ['label'], heater_off: [] };
    const hdr = { T: 'T (K)', rate: 'Rate (K/min)', range: 'Heater', tol: 'Tol ±K', mean_tol: 'Mean |?T| (K)', window_s: 'Window (s)', timeout_s: 'Timeout (s)', seconds: 'Seconds', label: 'Label' };
    t.innerHTML = '<tr><th>#</th><th>Step</th><th>Parameters</th><th></th></tr>';
    P.tempProgram.forEach((s, i) => {
      const tr = t.insertRow(); tr.insertCell().textContent = i + 1; tr.insertCell().textContent = HH.STEP_TYPES[s.type].label;
      const c = tr.insertCell(); c.style.whiteSpace = 'normal';
      cols[s.type].forEach(k => {
        const w = document.createElement('label'); w.style.cssText = 'display:inline-block;margin-right:12px;font-size:11px;color:#9db0c0'; w.append(hdr[k] + ' ');
        let inp;
        if (k === 'range') { inp = document.createElement('select'); ['low', 'medium', 'high'].forEach(r => inp.add(new Option(r, r))); }
        else { inp = document.createElement('input'); inp.type = k === 'label' ? 'text' : 'number'; inp.step = 'any'; inp.style.width = k === 'label' ? '120px' : '90px'; }
        inp.value = k === 'mean_tol' && s[k] === undefined ? s.tol : s[k]; inp.dataset.stepIndex=i; inp.disabled = running && i <= (runner?.index??stepState.findIndex(x=>x==='start'));
        inp.onchange = () => { const old = s[k]; s[k] = k === 'label' || k === 'range' ? inp.value : Number(inp.value); hist(P, 'program', `step ${i + 1} ${k}: ${old} → ${s[k]}`); dirty = true; renderProgram(); refreshTabs(); };
        w.append(inp); c.append(w);
      });
      const ac = tr.insertCell();
      [['↑', -1], ['↓', 1]].forEach(([l, d]) => { const b = document.createElement('button'); b.className = 'secondary'; b.textContent = l; b.disabled = running || i + d < 0 || i + d >= P.tempProgram.length; b.onclick = () => { const a = P.tempProgram; [a[i], a[i + d]] = [a[i + d], a[i]]; hist(P, 'program', `moved step ${i + 1}`); dirty = true; renderProgram(); }; ac.append(b, ' '); });
      const x = document.createElement('button'); x.className = 'danger'; x.textContent = '✕'; x.disabled = running; x.onclick = () => { P.tempProgram.splice(i, 1); hist(P, 'program', `deleted step ${i + 1} (${s.type})`); dirty = true; renderProgram(); refreshTabs(); }; ac.append(x);
    });
    const errs = progErrors(), warn = HH.programWarnings(P.tempProgram), est = HH.estimateDuration(P.tempProgram, 295);
    const meas = P.tempProgram.filter(s => s.type === 'measure').length, per = Math.round(HH.acqSeconds(P.method));
    $('prog-msg').innerHTML = (P.tempProgram.length ? '' : '<div class="muted">No steps yet. Add steps or append a sweep.</div>') +
      errs.map(x => `<div class="notice err">${esc(x)}</div>`).join('') + warn.map(x => `<div class="notice">${esc(x)}</div>`).join('') +
      (P.tempProgram.length && !errs.length ? `<div class="notice ok">Valid. Estimated duration ≈ ${fmtDur(est + meas * per)} (thermal ${fmtDur(est)} + ${meas} measurements × ${per} s), assuming start at 295 K.</div>` : '');
  }
  $('apply-parameters').onclick=async()=>{
    if(HH.modeErrors(P).length||progErrors().length||parameterBusy)return;
    parameterBusy=true;setBadges();
    try {
      if(running&&P.hardware.backend==='real') {
        if(!realJobId)throw Error('Wait for the program to start.');
        await window.HHHardware.updateProgram(realJobId,P);
      }
      appliedMethod=JSON.parse(JSON.stringify(P.method));
      if(running&&P.hardware.backend==='simulation') runner.steps=JSON.parse(JSON.stringify(P.tempProgram));
      $('parameter-status').textContent=running?'Accepted for the next measurement. Current data keep their original settings.':'Parameters ready.';
      hist(P,'config','Experiment parameters applied');
    }catch(e){$('parameter-status').textContent='Not applied: '+e.message;}
    finally{parameterBusy=false;setBadges();}
  };
  function fmtDur(s) { const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return h ? `${h} h ${m} min` : `${m} min ${Math.round(s % 60)} s`; }
  $('add-step').onclick = () => { const ty = $('add-type').value; P.tempProgram.push(HH.makeStep(ty)); hist(P, 'program', 'added step ' + ty); dirty = true; renderProgram(); refreshTabs(); };
  $('add-sweep').onclick = () => {
    if (running) return;
    try {
      const steps = HH.sweep(+$('sw0').value, +$('sw1').value, +$('swd').value, {
        rate: +$('swr').value, tol: +$('sw-tol').value, mean_tol: +$('sw-mean').value,
        window_s: +$('sw-window').value, timeout_s: +$('sw-timeout').value, range: $('sw-range').value,
      });
      const errors = HH.validateProgram(steps, { maxK: tl().maxK, maxRateKmin: tl().maxRateKmin });
      if (errors.length) throw new Error(errors[0]);
      P.tempProgram.push(...steps);
      hist(P, 'program', `Appended ${steps.length / 2} temperature points`, { steps }); dirty = true;
      $('sweep-msg').textContent = `Added ${steps.length / 2} temperature points, each followed by a measurement.`;
    } catch (e) { Logger.error('UI', e.message); $('sweep-msg').textContent = e.message; }
    renderProgram(); refreshTabs();
  };
  $('clear-prog').onclick = () => { if (P.tempProgram.length && confirm('Delete all program steps?')) { P.tempProgram = []; hist(P, 'program', 'cleared'); renderProgram(); refreshTabs(); } };

  /* ---------------- run ---------------- */
  function renderRun() {
    const n = $('run-notice'), why = [];
    if (!connectionsOk()) why.push('Check all selected device connections before running.');
    if (P.hardware.backend === 'real') why.push(...realRunErrors());
    if (P.hardware.backend === 'simulation' && P.hardware.temperature !== 'off' && !ctrl) why.push('Temperature device not connected.');
    methodErrors().forEach(x => why.push(x)); progErrors().forEach(x => why.push(x));
    n.innerHTML = why.map(x => `<div class="notice err">${esc(x)}</div>`).join('') + (P.hardware.backend === 'simulation' ? '<div class="notice">Simulation: synthetic data, tagged in saved projects.</div>' : '<div class="notice">Real program: Start enables the configured current source and moves the referenced OWIS axis. Abort stops motion, disables current and turns off temperature control. Timing and electrical phase require bench calibration.</div>');
    $('r-start').disabled = running || why.length > 0;
    $('r-pause').disabled = !running || runner?.state==='pausing' || (paused() && (!connectionsOk() || HH.modeErrors(P).length>0)); $('r-abort').disabled = !running;
    $('r-pause').textContent = runner?.state === 'paused' ? 'Resume' : 'Pause';
    const t = $('run-steps'); t.innerHTML = '<tr><th>#</th><th>Step</th><th>Detail</th><th>State</th></tr>';
    P.tempProgram.forEach((s, i) => { const tr = t.insertRow(); tr.className = stepState[i] === 'start' ? 'cur' : stepState[i] === 'done' ? 'donest' : ''; tr.insertCell().textContent = i + 1; tr.insertCell().textContent = s.type; tr.insertCell().textContent = s.type === 'goto' ? `${s.T} K @ ${s.rate} K/min` : s.type === 'soak' ? s.seconds + ' s' : s.label || ''; tr.insertCell().textContent = stepState[i] === 'start' ? 'active' : stepState[i] === 'done' ? 'done' : ''; });
    drawTemp(); setBadges();
  }
  function drawTemp() { if (current === 'run') HH.plot($('c-temp'), [{ x: trace.t, y: trace.sp, color: '#e3b96e' }, { x: trace.t, y: trace.T, color: '#66d6ce' }], { xlabel: 'virtual time (s)', ylabel: 'T (K)' }); }
  function updateKpis(s) {
    $('r-kpis').innerHTML = [['Temperature', fx(s.T, 4) + ' K'], ['Setpoint', fx(s.setpoint, 4) + ' K'], ['Heater', fx(s.heater, 3) + ' %'], ['Runs saved', P.runs.length], ['Elapsed', fmtDur(vnow)]].map(([a, b]) => `<div class="kpi"><span>${a}</span><b>${esc(b)}</b></div>`).join('');
  }
  function setStatus(t) { $('r-status').textContent = t; }
  function realRunErrors() {
    const h=P.hardware,e=[];
    if (location.protocol==='file:') e.push('Open the UI through Live Server or GitHub Pages and start the local Rust service.');
    if (!(h.magnet.counts_per_turn>0) || !(h.magnet.velocity_scale>0)) e.push('Configure calibrated OWIS counts per revolution and velocity conversion on Devices.');
    if (!['K6220','K6221'].includes(h.source.model)) e.push('Real acquisition currently supports Keithley 6220/6221 sources.');
    if (!HH.usesVoltmeter(P.method) && !['SR830','AMETEK7230'].includes(h.measure.lockin1)) e.push('Select SR830 or Ametek 7230 as Lock-in 1 for real acquisition.');
    if (h.measure.lockin2) e.push('Real acquisition currently records one lock-in; deselect Lock-in 2.');
    return e;
  }
  async function startRealProgram() {
    if (realRunErrors().length) {renderRun();return;}
    let jobId=null,cursor=0,abortRequested=false;
    running=true; stepState=[];vnow=0;trace={t:[],T:[],sp:[]};const realStarted=Date.now();
    appliedMethod=JSON.parse(JSON.stringify(P.method));configurationReleased=false;
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
        if(status.state==='paused')configurationReleased=true;
        for (const data of status.runs) {
          const run=Object.assign({id:'run-'+String(P.runs.length+1).padStart(3,'0'),started:new Date().toISOString(),sample:JSON.parse(JSON.stringify(P.sample)),method:JSON.parse(JSON.stringify(P.method)),excluded:[]},data);
          if (run.incomplete) {run.fitError='Incomplete acquisition: retained raw samples.';run.fit=null;run.derived=null;} else fitRun(run);
          P.runs.push(run);selRun=run.id;dirty=true;hist(P,'run',run.id+' recorded from real instruments');
        }
        cursor=status.count; P.simulated=P.runs.some(r=>r.simulated);
        stepState=P.tempProgram.map((_,i)=>i<status.step?'done':i===status.step?'start':'');
        $('r-prog').style.width=((status.step+(status.state==='finished'?1:0))/P.tempProgram.length*100)+'%';
        vnow=(Date.now()-realStarted)/1000;
        if (Number.isFinite(status.temperatureK)) {trace.t.push(vnow);trace.T.push(status.temperatureK);trace.sp.push(status.setpointK??NaN);}
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
    if (running) return;
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
      onTemp: s => { if (s.stability) $('r-stability').textContent = `Temperature stability: |?T| ${fx(s.stability.error)} K; mean |?T| ${s.stability.meanError === null ? 'collecting window' : fx(s.stability.meanError) + ' K'}; in band ${fx(s.stability.stableFor)} s`; trace.t.push(s.t); trace.T.push(s.T); trace.sp.push(s.setpoint); updateKpis(s); drawTemp(); },
      onStep: (i, s, st) => { stepState[i] = st; $('r-prog').style.width = ((st === 'done' ? i + 1 : i) / total * 100) + '%'; setStatus(`Step ${i + 1}/${total}: ${HH.STEP_TYPES[s.type].label}`); hist(P, 'run', `Step ${i + 1} ${st}: ${s.type}`); renderRun(); },
      measure: ctx => measure(ctx, speed),
    };
    runner = new HH.ProgramRunner(ctrl, JSON.parse(JSON.stringify(P.tempProgram)), env, { maxK: tl().maxK, maxRateKmin: tl().maxRateKmin });
    appliedMethod=JSON.parse(JSON.stringify(P.method));configurationReleased=false;
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
        if(!connectionsOk()||HH.modeErrors(P).length)return;
        if(P.hardware.backend==='simulation'){
          if(P.hardware.temperature==='off'&&!ctrl){simDev={advance(){}};ctrl={readK:async()=>null,getSetpoint:async()=>null,heaterOff:async()=>{}};}
          runner.c=ctrl;appliedMethod=JSON.parse(JSON.stringify(P.method));
        }
        await runner.resume();configurationReleased=false;
      } else {
        await runner.pause();
        if(P.hardware.backend==='simulation') {runner.state='paused';configurationReleased=true;}
      }
      hist(P,'run',paused()?'Program paused':'Program resumed');renderRun();refreshTabs();
    }catch(e){setStatus(e.message);renderRun();}
  };
  $('r-abort').onclick = () => { if (runner && confirm('Abort the program? The heater will be switched off.')) runner.abort(); };

  async function measure(ctx, speed) {
    const id = 'run-' + String(P.runs.length + 1).padStart(3, '0');
    Logger.info('MEAS', `${id}: ${P.method.kind} mode at ${ctx.T_set} K`);
    const T = await ctrl.readK();
    const snapshot=JSON.parse(JSON.stringify(P));snapshot.method=JSON.parse(JSON.stringify(appliedMethod||P.method));
    const res = await HH.acquire(snapshot, ctx, () => T === null ? 295 : T);
    if (P.hardware.temperature === 'off') { res.T_mean = null; res.samples.T.fill(null); }
    const dur = res.samples.t[res.samples.t.length - 1]; vnow += dur; simDev.advance(dur);
    if (speed > 0) await sleepReal(Math.min(dur * 1000 / speed, 5000));
    const run = { id, label: ctx.step.label || '', positionSource: connectionCheck?.positionSource||'owis', T_set: ctx.T_set, T_mean: res.T_mean, started: new Date().toISOString(), simulated: true, rsq_ohm: res.rsq_ohm, sample:snapshot.sample, method:snapshot.method, samples: res.samples, excluded: [] };
    fitRun(run); P.runs.push(run);
    hist(P, 'run', `${id} saved: T=${fx(run.T_mean)} K, n_s=${fx(run.derived?.ns)} m⁻²`, { run: id });
    Logger.info('MEAS', `${id} done: A1=${fx(run.fit?.A1)} Ω`);
    selRun = id; if (current === 'inspect' && $('i-live').checked) renderInspect();
  }
  function fitRun(run) {
    try {
      if (run.incomplete) throw new Error('Incomplete acquisition: retained raw samples without fitting.');
      run.fit = run.detectionKind === 'field-lockin' ? HH.fitFieldLockin(run.samples,run.method.rotating.excitation) : run.method?.kind === 'rotating' && run.method.rotating.excitation === 'dc' ? HH.fitCurrentSweep(run.samples) : HH.fitHarmonics(run.samples);
      run.derived = HH.derive(run.fit, Object.assign({}, run.sample, { rsq_ohm: run.rsq_ohm ?? run.sample.rsq_ohm }));
      if (run.fit.warnings) run.derived.warnings.push(...run.fit.warnings);
      run.fitError = null;
    } catch (e) { run.fit = null; run.derived = null; run.fitError = e.message; Logger.error('FIT', run.id + ': ' + e.message); }
  }

  /* ---------------- data inspect ---------------- */
  const runById = id => P.runs.find(r => r.id === id);
  function renderInspect() {
    const sel = $('i-run'); sel.replaceChildren(); P.runs.forEach(r => sel.add(new Option(`${r.id} — ${fx(r.T_mean, 4)} K ${r.label}`, r.id)));
    if ($('i-live').checked && P.runs.length) selRun = P.runs[P.runs.length - 1].id;
    if (!runById(selRun) && P.runs.length) selRun = P.runs[0].id;
    sel.value = selRun || ''; const r = runById(selRun);
    if (!r) { $('i-kpis').innerHTML = '<div class="notice">No runs yet.</div>'; ['c-xth', 'c-xt', 'c-res'].forEach(c => HH.plot($(c), [])); $('i-table').innerHTML = ''; return; }
    const s = r.samples, f = r.fit, d = r.derived;
    $('i-slope-info').textContent = '';
    for (const id of ['c-xth','c-res']) $(id).closest('.card').hidden = r.detectionKind === 'field-lockin';
    $('i-slope-card').hidden = !f?.currentSlope;
    if (f?.currentSlope) {
      const slope = f.currentSlope, x = slope.points.map(p => p.I), y = slope.points.map(p => p.voltage);
      HH.plot($('c-current-slope'), [{x, y, color:'#66d6ce', kind:'points'}, {x, y:x.map(I=>slope.intercept+slope.slope*I), color:'#e3b96e'}], {xlabel:'DC current (A)', ylabel:'Signed Hall voltage (V)'});
      $('i-slope-info').textContent = `Slope ${fx(slope.slope)} V/A; fitted intercept ${fx(slope.intercept)} V. ${slope.points.length} distinct currents; no separate zero-current background subtraction.`;
      if (r.detectionKind==='field-lockin') $('i-slope-info').textContent += ' RMS lock-in output normalized to Hall amplitude; verify reference phase and gain.';
    }
    $('i-kpis').innerHTML = [['T mean', fx(r.T_mean, 5) + ' K'], ['Samples (valid)', `${s.t.length} (${s.valid.reduce((a, b) => a + b, 0)})`], ['A1', f ? fx(f.A1) + ' Ω' : '—'], ['D1/A1', f ? fx(f.D1 / f.A1, 3) : '—'], ['A2', f ? fx(f.A2) + ' Ω' : '—'], ['Fit rms', f ? fx(f.rms) + ' V' : '—'], ['Condition', f ? fx(f.cond, 3) : '—'], ['Carrier', d?.carrier || '—']].map(([a, b]) => `<div class="kpi"><span>${a}</span><b>${esc(b)}</b></div>`).join('') + (r.fitError ? `<div class="notice err">${esc(r.fitError)}</div>` : '') + (d ? d.warnings.map(w => `<div class="notice">${esc(w)}</div>`).join('') : '') + (r.simulated ? '<div class="notice">Simulated data.</div>' : '');
    // choose one current level for X vs angle readability: all valid points, X/I normalised to ohm
    const vi = [], mi = []; s.theta.forEach((th, i) => { if (s.I[i] !== 0) (s.valid[i] ? vi : mi).push(i); });
    const wrap = th => { const w = ((th % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI); return w * 180 / Math.PI; };
    const R = i => s.X[i] / s.I[i];
    const model = i => { if (!f) return NaN; const th = s.theta[i]; return f.A1 * Math.cos(th) + f.D1 * Math.sin(th) + f.A2 * Math.sin(2 * th) + f.B2c * Math.cos(2 * th) + (isFinite(f.b0) ? f.b0 : 0) + f.o0 / s.I[i]; };
    HH.plot($('c-xth'), [{ x: mi.map(i => wrap(s.theta[i])), y: mi.map(R), color: '#566677', kind: 'points' }, { x: vi.map(i => wrap(s.theta[i])), y: vi.map(R), color: '#66d6ce', kind: 'points' }, { x: vi.map(i => wrap(s.theta[i])), y: vi.map(model), color: '#e3b96e', kind: 'points' }], { xlabel: 'field angle (deg)', ylabel: 'X / I (Ω)' });
    HH.plot($('c-xt'), [{ x: s.t, y: s.X, color: '#66d6ce' }, { x: s.t, y: s.Y, color: '#80aaf9' }], { xlabel: 't (s)', ylabel: 'lock-in (V)' });
    HH.plot($('c-res'), [{ x: vi.map(i => wrap(s.theta[i])), y: vi.map(i => R(i) - model(i)), color: '#80aaf9', kind: 'points' }], { xlabel: 'field angle (deg)', ylabel: 'residual (Ω)' });
    const t = $('i-table'); t.innerHTML = '<tr><th>t (s)</th><th>θ (deg)</th><th>X (V)</th><th>Y (V)</th><th>I (A)</th><th>T (K)</th><th>valid</th></tr>';
    const stride = Math.max(1, Math.floor(s.t.length / 300));
    for (let i = 0; i < s.t.length; i += stride) { const tr = t.insertRow(); [s.t[i].toFixed(2), (s.theta[i] * 180 / Math.PI).toFixed(1), fx(s.X[i], 4), fx(s.Y[i], 3), fx(s.I[i], 4), fx(s.T[i], 4), s.valid[i]].forEach(v => tr.insertCell().textContent = v); }
  }
  $('i-run').onchange = () => { selRun = $('i-run').value; $('i-live').checked = false; renderInspect(); };
  $('i-live').onchange = renderInspect;
  $('i-refit').onclick = () => { const r = runById(selRun); if (r) { fitRun(r); hist(P, 'analysis', `refit ${r.id}`); dirty = true; renderInspect(); } };
  function maskRange(val) {
    const r = runById(selRun); if (!r) return; const a = Number($('i-m0').value), b = Number($('i-m1').value);
    if (!(b > a)) { Logger.warn('UI', 'Invalid mask range'); return; }
    let n = 0; r.samples.t.forEach((t, i) => { if (t >= a && t <= b && r.samples.valid[i] !== val) { r.samples.valid[i] = val; n++; } });
    r.excluded.push({ from: a, to: b, valid: val, n }); fitRun(r);
    hist(P, 'analysis', `${r.id}: ${val ? 'restored' : 'excluded'} ${n} samples in t=[${a}, ${b}] s`); dirty = true; renderInspect();
  }
  $('i-mask').onclick = () => maskRange(0); $('i-unmask').onclick = () => maskRange(1);

  /* ---------------- analysis ---------------- */
  const COLS = [['id', 'Run', r => r.id], ['T', 'T (K)', r => fx(r.T_mean, 5)], ['ns', 'n_s (cm⁻²)', r => fx(r.derived?.ns / 1e4)], ['ns_e', '± ', r => fx(r.derived?.ns_err / 1e4, 2)],
    ['rh', 'R_H (cm³/C)', r => fx(r.derived?.RH * 1e6)], ['mu', 'µ (cm²/Vs)', r => fx(r.derived?.mu * 1e4)], ['rs', 'R□ (Ω)', r => fx(r.rsq_ohm ?? r.sample.rsq_ohm)], ['A1', 'A1 (Ω)', r => fx(r.fit?.A1)], ['A1e', '± A1', r => fx(r.fit?.A1_err, 2)], ['D1', 'D1 (Ω)', r => fx(r.fit?.D1)], ['A2', 'A2 (Ω)', r => fx(r.fit?.A2)], ['ty', 'Type', r => r.derived?.carrier || ''], ['sim', 'Sim', r => r.simulated ? 'yes' : '']];
  function renderAnalysis() {
    const t = $('a-table'); t.innerHTML = '<tr>' + COLS.map(c => `<th>${esc(c[1])}</th>`).join('') + '</tr>';
    P.runs.forEach(r => { const tr = t.insertRow(); COLS.forEach(c => tr.insertCell().textContent = c[2](r)); });
    const ok = P.runs.filter(r => r.derived && Number.isFinite(r.T_mean)), T = ok.map(r => r.T_mean);
    HH.plot($('c-ns'), [{ x: T, y: ok.map(r => r.derived.ns / 1e4), color: '#66d6ce', kind: 'points' }, { x: T, y: ok.map(r => r.derived.ns / 1e4), color: '#66d6ce' }], { xlabel: 'T (K)', ylabel: 'n_s (cm⁻²)' });
    HH.plot($('c-mu'), [{ x: T, y: ok.map(r => r.derived.mu * 1e4), color: '#80aaf9' }, { x: T, y: ok.map(r => r.derived.mu * 1e4), color: '#80aaf9', kind: 'points' }], { xlabel: 'T (K)', ylabel: 'µ (cm²/Vs)' });
    HH.plot($('c-rh'), [{ x: T, y: ok.map(r => r.derived.RH * 1e6), color: '#e3b96e' }, { x: T, y: ok.map(r => r.derived.RH * 1e6), color: '#e3b96e', kind: 'points' }], { xlabel: 'T (K)', ylabel: 'R_H (cm³/C)' });
    HH.plot($('c-rs'), [{ x: T, y: ok.map(r => r.rsq_ohm ?? r.sample.rsq_ohm), color: '#f08a8a' }, { x: T, y: ok.map(r => r.rsq_ohm ?? r.sample.rsq_ohm), color: '#f08a8a', kind: 'points' }], { xlabel: 'T (K)', ylabel: 'R□ (Ω)' });
  }
  const csvCell = v => /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
  $('a-csv').onclick = () => { download((P.sample.id || 'hall') + '_summary.csv', [COLS.map(c => c[1]).join(','), ...P.runs.map(r => COLS.map(c => csvCell(c[2](r))).join(','))].join('\n'), 'text/csv'); Logger.info('IO', 'Exported summary CSV'); };

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
    P.log = Logger.entries.slice(-20000); P.modified = new Date().toISOString();
    const name = (P.sample.id || 'hall_project').replace(/[^\w.-]+/g, '_') + '.hallproj.json';
    download(name, JSON.stringify(P), 'application/json'); dirty = false; hist(P, 'project', 'saved ' + name); Logger.info('IO', 'Saved project ' + name);
    msg('Saved ' + name, 'ok');
  };
  $('pr-load').onchange = async ev => {
    const f = ev.target.files[0]; ev.target.value = ''; if (!f) return;
    if (running) { msg('Cannot load while a program is running.', 'err'); return; }
    try {
      const o = JSON.parse(await f.text());
      if (o.format !== 'halbach-hall-project') throw new Error('Not a Halbach Hall project file.');
      if (o.version > 1) throw new Error('Project version ' + o.version + ' is newer than this application supports.');
      const base = newProject(), np = Object.assign(base, o);
      np.sample = Object.assign(base.sample, o.sample); np.method = Object.assign(newProject().method, o.method); for (const k of ['fixed', 'rotating']) np.method[k] = Object.assign(newProject().method[k], (o.method || {})[k]); if (!o.method || !o.method.kind) np.method.kind = 'chirp';
      np.hardware = Object.assign(newProject().hardware, o.hardware); for (const k of ['tempController', 'magnet', 'source', 'measure']) np.hardware[k] = Object.assign(newProject().hardware[k], (o.hardware || {})[k]);
      if (np.method.fixed.excitation === 'delta') {np.method.fixed.excitation='dc';np.hardware.measure.dc_mode='delta';}
      if (!o.method?.cycles) np.method.cycles = Math.max(1, Math.ceil(np.method.dwell_s * np.method.rot_hz));
      for (const r of np.runs) { const s = r.samples, n = s && s.t ? s.t.length : -1; if (n < 1 || ['theta', 'X', 'Y', 'I', 'T', 'valid'].some(k => !Array.isArray(s[k]) || s[k].length !== n)) throw new Error(`Run ${r.id}: inconsistent sample arrays.`); }
      if (dirty && !confirm('Unsaved changes will be lost. Load anyway?')) return;
      P = np; ctrl = null; simDev = null; dirty = false; selRun = P.runs.length ? P.runs[0].id : null;
      np.runs.forEach(r => { if (!r.fit && !r.fitError) fitRun(r); });
      if (Array.isArray(o.log)) { Logger.entries = o.log.slice(-Logger.max); Logger.seq = Logger.entries.reduce((m, e) => Math.max(m, e.n || 0), 0); }
      hist(P, 'project', `loaded ${f.name} (${P.runs.length} runs)`); Logger.info('IO', `Loaded project ${f.name}: ${P.runs.length} runs`);
      connectionCheck = null; syncForm(); setBadges(); msg(`Loaded ${f.name}: ${P.runs.length} runs. Check device connections before running.`, 'ok'); show(P.runs.length ? 'analysis' : 'project');
    } catch (e) { Logger.error('IO', 'Load failed: ' + e.message); msg('Load failed: ' + e.message, 'err'); }
  };
  $('pr-new').onclick = async () => { if (running) return; if (!confirm('Start a new project? Unsaved data will be lost.')) return; P = newProject(); connectionCheck = null; ctrl = null; simDev = null; dirty = false; selRun = null; syncForm(); setBadges(); hist(P, 'project', 'new project'); show('mode'); };
  $('pr-csv').onclick = () => {
    const r = runById(selRun) || P.runs[0]; if (!r) { msg('No runs to export.', 'err'); return; }
    const s = r.samples; download(`${r.id}_raw.csv`, 't_s,theta_rad,X_V,Y_V,I_A,T_K,valid\n' + s.t.map((t, i) => [t, s.theta[i], s.X[i], s.Y[i], s.I[i], s.T[i], s.valid[i]].join(',')).join('\n'), 'text/csv');
  };
  function chartImage(series, o) { const c = document.createElement('canvas'); c.width = 760; c.height = 300; return HH.plot(c, series, Object.assign({ print: true }, o)); }
  function modeRows(row) {
    const m = P.method, md = HH.MODES[m.kind]; if (!md) return row('Mode', 'unknown');
    const r = [row('Mode', md.label + ' (' + md.ref + ')')];
    if (m.kind === 'chirp') r.push(row('Carrier', m.carrier_hz + ' Hz'), row('Current levels (RMS)', m.levels_mA.join(', ') + ' mA'), row('Rotation', m.rot_hz + ' Hz, ' + m.direction), row('Dwell / mask', m.dwell_s + ' s / ' + m.mask_s + ' s'));
    else for (const [k, v] of Object.entries(m[m.kind])) r.push(row(k, v));
    return r.join('');
  }
  $('pr-report').onclick = () => {
    const ok = P.runs.filter(r => r.derived && Number.isFinite(r.T_mean)), T = ok.map(r => r.T_mean), s = P.sample, m = P.method;
    const row = (a, b) => `<tr><th>${esc(a)}</th><td>${esc(b)}</td></tr>`;
    const imgs = ok.length ? [['n_s (cm⁻²)', r => r.derived.ns / 1e4], ['µ (cm²/Vs)', r => r.derived.mu * 1e4], ['R_H (cm³/C)', r => r.derived.RH * 1e6]].map(([l, fn]) => `<h3>${esc(l)} vs temperature</h3><img alt="${esc(l)}" src="${chartImage([{ x: T, y: ok.map(fn), color: '#1b6fb5' }, { x: T, y: ok.map(fn), color: '#1b6fb5', kind: 'points' }], { xlabel: 'T (K)', ylabel: l })}">`).join('') : '<p>No analysed runs.</p>';
    const steps = P.tempProgram.map((st, i) => `<tr><td>${i + 1}</td><td>${esc(st.type)}</td><td>${esc(JSON.stringify(Object.fromEntries(Object.entries(st).filter(([k]) => k !== 'type'))))}</td></tr>`).join('');
    const logs = Logger.entries.filter(e => e.level === 'warn' || e.level === 'error').slice(-50).map(e => `<tr><td>${esc(new Date(e.t).toISOString())}</td><td>${esc(e.level)}</td><td>${esc(e.src + ': ' + e.msg)}</td></tr>`).join('');
    const sim = P.runs.some(r => r.simulated);
    $('report').innerHTML = `<h1>Hall effect measurement report</h1>${sim ? '<p><b>WARNING: contains SIMULATED data — not a measurement.</b></p>' : ''}
      <p>Generated ${esc(new Date().toLocaleString())}. Project created ${esc(P.created)}.</p>
      <h2>Sample</h2><table>${row('ID', s.id)}${row('Thickness', s.thickness_nm + ' nm')}${row('Width × length', s.width_um + ' × ' + s.length_um + ' µm')}${row('Field B', s.B_T + ' T')}${row('Tilt', s.tilt_deg + '°')}${row('Notes', s.notes)}</table>
      <h2>Measurement mode</h2><table>${modeRows(row)}${row('Lock-in time constant', m.tc_ms + ' ms')}${row('Current source', (HH.SOURCES[P.hardware.source.model] || {}).name || 'none')}${row('Temperature controller', tl().model + ' ' + tl().address + ', input ' + tl().input + ', loop ' + tl().loop)}</table>
      <h2>Temperature program</h2><table><tr><th>#</th><th>Step</th><th>Parameters</th></tr>${steps}</table>
      <h2>Results</h2><table><tr>${COLS.map(c => `<th>${esc(c[1])}</th>`).join('')}</tr>${P.runs.map(r => '<tr>' + COLS.map(c => `<td>${esc(c[2](r))}</td>`).join('') + '</tr>').join('')}</table>
      <div class="pb"></div><h2>Plots</h2>${imgs}
      <h2>Assumptions</h2><p>Quantities follow the CHIRP guide §10 and assume a uniform bar geometry, ohmic contacts, an ordinary Hall coefficient independent of field orientation, and a validated field magnitude and angle calibration. n<sub>s</sub> is the Hall sheet density (no scattering factor applied); µ is the Hall mobility. Uncertainties are 1σ statistical from the harmonic fit only; calibration and geometry uncertainty are not included.</p>
      <h2>Warnings and errors (last 50)</h2><table>${logs || '<tr><td>None recorded</td></tr>'}</table>
      <h2>History</h2><table>${P.history.slice(-60).map(h => `<tr><td>${esc(h.t)}</td><td>${esc(h.kind)}</td><td>${esc(h.text)}</td></tr>`).join('')}</table>`;
    hist(P, 'project', 'report printed'); Logger.info('IO', 'Report generated'); window.print();
  };

  /* ---------------- init ---------------- */
  window.addEventListener('beforeunload', e => { if (dirty || running) { e.preventDefault(); e.returnValue = ''; } });
  window.addEventListener('error', e => Logger.error('JS', e.message));
  window.addEventListener('unhandledrejection', e => Logger.error('JS', 'Unhandled: ' + (e.reason && e.reason.message || e.reason)));
  buildTabs(); syncForm(); setBadges(); Logger.info('APP', 'Workstation started; select real instruments or explicit simulation'); hist(P, 'project', 'new project');
  show('mode');
  window.HH.debugState = () => ({ P, ctrl, running, connectionsOk, runner });
})();
