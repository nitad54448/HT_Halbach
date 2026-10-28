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
  let ctrl = null, simDev = null, runner = null, running = false, vnow = 0;
  let trace = { t: [], T: [], sp: [] }, stepState = [], selRun = null;

  /* ---------------- tabs ---------------- */
  const FLOW = [['hardware', 'Hardware'], ['mode', 'Mode'], ['sample', 'Sample'], ['temp', 'Temperature'], ['run', 'Run'], ['inspect', 'Data inspect'], ['analysis', 'Analysis']];
  const UTIL = [['history', 'History'], ['log', 'Log'], ['project', 'Project & report']];
  let current = 'hardware';
  function stepOk(id) {
    switch (id) {
      case 'hardware': return !!ctrl && Object.values(HH.availability(P.hardware)).some(a => a.ok);
      case 'mode': return HH.modeErrors(P).length === 0;
      case 'sample': return HH.sampleErrors(P).length === 0;
      case 'temp': return progErrors().length === 0;
      default: return true;
    }
  }
  function reachable(id) {
    if (UTIL.some(u => u[0] === id)) return true;
    if (P.runs.length) return true;                      // loaded/finished data: analysis tabs free
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
      sel.add(new Option('None / not available', ''));
      const t = HH[sel.dataset.opts]; for (const [k, v] of Object.entries(t)) sel.add(new Option(typeof v === 'string' ? v : v.name, k));
    });
  }
  function syncForm() {
    buildOptions();
    document.querySelectorAll('[data-bind]').forEach(el => { const v = getPath(P, el.dataset.bind); el.value = v === null || v === undefined ? '' : String(v); });
    $('f-levels').value = P.method.levels_mA.join(', ');
  }
  document.querySelectorAll('[data-bind]').forEach(el => el.addEventListener('change', () => {
    const path = el.dataset.bind; let v = el.value;
    if ('bool' in el.dataset) v = v === 'true';
    else if ('num' in el.dataset) { if (v === '' && 'nullable' in el.dataset) v = null; else { v = Number(v); if (!isFinite(v)) { el.classList.add('bad'); return; } } }
    el.classList.remove('bad');
    const old = getPath(P, path); setPath(P, path, v);
    if (old !== v) { hist(P, 'config', `${path}: ${old} → ${v}`); Logger.verbose('CFG', `${path} = ${v} (was ${old})`); dirty = true; }
    if (path.startsWith('hardware.tempController')) { if (ctrl) Logger.warn('CFG', 'Reconnect for controller settings to take effect'); }
    renderPage(current); refreshTabs();
  }));
  $('f-levels').addEventListener('change', () => {
    const arr = $('f-levels').value.split(',').map(s => s.trim()).filter(Boolean).map(Number);
    P.method.levels_mA = arr; hist(P, 'config', 'current levels → ' + arr.join(', ')); dirty = true; renderMode(); refreshTabs();
  });

  /* ---------------- hardware ---------------- */
  document.querySelectorAll('#hw-subtabs button').forEach(b => b.onclick = () => {
    document.querySelectorAll('#hw-subtabs button').forEach(x => x.classList.toggle('active', x === b));
    document.querySelectorAll('#p-hardware .subpane').forEach(x => x.classList.toggle('active', x.dataset.pane === b.dataset.sub));
  });
  function renderHardware() {
    const h = P.hardware, src = HH.SOURCES[h.source.model], lines = [];
    $('src-caps').textContent = src ? `Supports: ${[src.dc && 'DC', src.ac && 'AC'].filter(Boolean).join(' and ')}` : '';
    const name = (t, k) => t[k] ? (typeof t[k] === 'string' ? t[k] : t[k].name) : null;
    const row = (type, what, ok) => lines.push(`<tr><td>${esc(type)}</td><td>${what ? esc(what) : '<span class="muted">none</span>'}</td></tr>`);
    row('Temperature control', ctrl ? `${HH.MODELS[h.tempController.model].name} (connected, simulated)` : `${HH.MODELS[h.tempController.model].name} (not connected)`);
    row('Rotation controller', name(HH.ROTATOR, h.magnet.rotator)); row('Position detector', name(HH.ENCODER, h.magnet.encoder));
    row('Current source', name(HH.SOURCES, h.source.model)); row('Nanovoltmeter', name(HH.VOLT, h.measure.volt));
    row('Lock-in 1', name(HH.LOCKIN, h.measure.lockin1)); row('Lock-in 2', name(HH.LOCKIN, h.measure.lockin2));
    const av = HH.availability(h), ok = Object.entries(av).filter(([, a]) => a.ok).map(([k]) => HH.MODES[k].label);
    $('hw-summary').innerHTML = `<table>${lines.join('')}</table><div class="notice ${ok.length ? 'ok' : ''}" style="margin-top:12px">${ok.length ? 'Modes available: ' + esc(ok.join('; ')) : 'No measurement mode is available yet. Declare a current source, a rotation controller, a position detector and a nanovoltmeter or lock-in.'}</div>`;
    const warn = [];
    if (h.measure.lockin1 === 'SR830' && h.measure.lockin2 === 'SR830' && h.measure.lockin1_addr && h.measure.lockin1_addr === h.measure.lockin2_addr) warn.push('Two SR830s share the same address.');
    $('measure-msg').innerHTML = warn.map(x => `<div class="notice err">${esc(x)}</div>`).join('');
    setBadges();
  }
  function setBadges() {
    const m = $('b-ls'); m.textContent = ctrl ? `Temp: ${P.hardware.tempController.model} connected` : 'Temp: not connected'; m.className = 'badge ' + (ctrl ? 'ok' : '');
    const r = $('b-run'); r.textContent = running ? (runner?.state === 'paused' ? 'Paused' : 'Running') : 'Idle'; r.className = 'badge ' + (running ? 'run' : '');
    $('ls-connect').disabled = !!ctrl; $('ls-disconnect').disabled = !ctrl || running; $('ls-heateroff').disabled = !ctrl;
    document.querySelectorAll('[data-bind],#f-levels').forEach(el => el.disabled = running);
  }
  $('ls-connect').onclick = async () => {
    const c = P.hardware.tempController;
    try {
      simDev = new HH.SimLakeShore(c.model, 295, 7);
      const d = new HH.LakeShore(c.model, simDev, { input: c.input, loop: c.loop });
      const id = await d.identify(); ctrl = d;
      $('ls-info').textContent = `${id.manufacturer} ${id.model}, s/n ${id.serial}, fw ${id.firmware} — SIMULATED at ${c.address}`;
      hist(P, 'hardware', `Connected ${c.model} (simulated) input ${c.input}, loop ${c.loop}`);
    } catch (e) { Logger.error('HW', 'Connect failed: ' + e.message); $('ls-info').textContent = 'Connect failed: ' + e.message; }
    setBadges(); refreshTabs();
  };
  $('ls-disconnect').onclick = () => { ctrl = null; simDev = null; Logger.info('HW', 'Disconnected'); hist(P, 'hardware', 'Disconnected'); $('ls-info').textContent = ''; setBadges(); refreshTabs(); };
  $('ls-heateroff').onclick = async () => { try { await ctrl.heaterOff(); hist(P, 'hardware', 'Heater switched off by user'); } catch (e) { Logger.error('HW', e.message); } };

  /* ---------------- mode / sample ---------------- */
  function methodErrors() { return HH.modeErrors(P).concat(HH.sampleErrors(P)); }
  function renderMode() {
    const av = HH.availability(P.hardware), m = P.method, box = $('mode-cards'); box.replaceChildren();
    for (const [k, md] of Object.entries(HH.MODES)) {
      const a = av[k], b = document.createElement('button'); b.className = 'mode-card' + (m.kind === k ? ' sel' : ''); b.disabled = !a.ok || running;
      const why = a.ok ? '' : md.variants.map(v => `${HH.EXC[v]}: needs ${a.variants[v].missing.join(', ')}`).join(' · ');
      b.innerHTML = `<b>${esc(md.label)}</b><small>${esc(md.ref)}</small><small>${esc(md.text)}</small>` + (a.ok ? `<small>Available: ${md.variants.filter(v => a.variants[v].ok).map(v => HH.EXC[v]).join(', ')}</small>` : `<small class="why">Unavailable. ${esc(why)}</small>`);
      b.onclick = () => {
        const old = m.kind; m.kind = k; const ex = m[k] && m[k].excitation;
        if (ex && !a.variants[ex].ok) m[k].excitation = md.variants.find(v => a.variants[v].ok);
        hist(P, 'config', `mode: ${old || 'none'} → ${k}`); dirty = true; syncForm(); renderMode(); refreshTabs();
      };
      box.append(b);
    }
    document.querySelectorAll('.mode-panel').forEach(p => p.hidden = p.id !== 'mp-' + m.kind);
    // excitation selects: offer only available variants
    document.querySelectorAll('select[data-excsel]').forEach(sel => {
      const k = sel.id.replace('x-', ''); sel.replaceChildren();
      for (const v of HH.MODES[k].variants) { const o = new Option(k === 'rotating' ? (v === 'dc' ? 'DC current / field-frequency lock-in' : 'AC current / sideband lock-in') : (v === 'dc' ? 'DC current / nanovoltmeter' : 'AC current / lock-in'), v); o.disabled = !av[k].variants[v].ok; sel.add(o); }
      sel.value = m[k].excitation;
    });
    const f = m.fixed, show = (el, on) => { el.hidden = !on; };
    document.querySelectorAll('#mp-fixed [data-when]').forEach(el => show(el, { ac: f.excitation === 'ac', dc: f.excitation === 'dc', step: f.acq === 'step', scan: f.acq === 'scan' }[el.dataset.when]));
    document.querySelectorAll('#mp-rotating [data-when]').forEach(el => show(el, m.rotating.excitation === 'ac'));
    const e = m.kind ? HH.modeErrors(P) : [], w = m.kind ? HH.modeWarnings(P) : [];
    $('mode-msg').innerHTML = (m.kind ? '' : '<div class="notice">Select a mode.</div>') + e.map(x => `<div class="notice err">${esc(x)}</div>`).join('') + w.map(x => `<div class="notice">${esc(x)}</div>`).join('') +
      (m.kind && !e.length ? `<div class="notice ok">Acquisition time per temperature point ≈ ${fmtDur(HH.acqSeconds(m))}.</div>` : '');
  }
  function renderSample() {
    const w = []; if (P.sample.tilt_deg !== 0) w.push('Non-zero tilt: guide recommends validating zero-tilt ordinary Hall first.');
    $('sample-msg').innerHTML = HH.sampleErrors(P).map(x => `<div class="notice err">${esc(x)}</div>`).join('') + w.map(x => `<div class="notice">${esc(x)}</div>`).join('');
  }

  /* ---------------- temperature program ---------------- */
  const tl = () => P.hardware.tempController;
  function progErrors() { return HH.validateProgram(P.tempProgram, { maxK: tl().maxK, maxRateKmin: tl().maxRateKmin }); }
  function renderProgram() {
    const sel = $('add-type'); if (!sel.childElementCount) for (const [k, v] of Object.entries(HH.STEP_TYPES)) sel.add(new Option(v.label, k));
    const t = $('prog-table'), cols = { goto: ['T', 'rate', 'range', 'tol', 'window_s', 'timeout_s'], soak: ['seconds'], measure: ['label'], heater_off: [] };
    const hdr = { T: 'T (K)', rate: 'Rate (K/min)', range: 'Heater', tol: 'Tol ±K', window_s: 'Stable for (s)', timeout_s: 'Timeout (s)', seconds: 'Seconds', label: 'Label' };
    t.innerHTML = '<tr><th>#</th><th>Step</th><th>Parameters</th><th></th></tr>';
    P.tempProgram.forEach((s, i) => {
      const tr = t.insertRow(); tr.insertCell().textContent = i + 1; tr.insertCell().textContent = HH.STEP_TYPES[s.type].label;
      const c = tr.insertCell(); c.style.whiteSpace = 'normal';
      cols[s.type].forEach(k => {
        const w = document.createElement('label'); w.style.cssText = 'display:inline-block;margin-right:12px;font-size:11px;color:#9db0c0'; w.append(hdr[k] + ' ');
        let inp;
        if (k === 'range') { inp = document.createElement('select'); ['low', 'medium', 'high'].forEach(r => inp.add(new Option(r, r))); }
        else { inp = document.createElement('input'); inp.type = k === 'label' ? 'text' : 'number'; inp.step = 'any'; inp.style.width = k === 'label' ? '120px' : '90px'; }
        inp.value = s[k]; inp.disabled = running;
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
  function fmtDur(s) { const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return h ? `${h} h ${m} min` : `${m} min ${Math.round(s % 60)} s`; }
  $('add-step').onclick = () => { const ty = $('add-type').value; P.tempProgram.push(HH.makeStep(ty)); hist(P, 'program', 'added step ' + ty); dirty = true; renderProgram(); refreshTabs(); };
  $('add-sweep').onclick = () => {
    try { P.tempProgram.push(...HH.sweep(+$('sw0').value, +$('sw1').value, +$('swd').value, { rate: +$('swr').value })); hist(P, 'program', `sweep ${$('sw0').value}→${$('sw1').value} K step ${$('swd').value}`); dirty = true; }
    catch (e) { Logger.error('UI', e.message); }
    renderProgram(); refreshTabs();
  };
  $('clear-prog').onclick = () => { if (P.tempProgram.length && confirm('Delete all program steps?')) { P.tempProgram = []; hist(P, 'program', 'cleared'); renderProgram(); refreshTabs(); } };

  /* ---------------- run ---------------- */
  function renderRun() {
    const n = $('run-notice'), why = [];
    if (!ctrl) why.push('Temperature controller not connected.');
    methodErrors().forEach(x => why.push(x)); progErrors().forEach(x => why.push(x));
    n.innerHTML = why.map(x => `<div class="notice err">${esc(x)}</div>`).join('') + '<div class="notice">Simulated backend: all data produced here is synthetic and tagged as such in saved projects.</div>';
    $('r-start').disabled = running || why.length > 0;
    $('r-pause').disabled = !running; $('r-abort').disabled = !running;
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

  $('r-start').onclick = async () => {
    if (running) return;
    if (P.runs.length && !confirm('Runs already exist in this project. New runs will be appended. Continue?')) return;
    const speed = Number($('r-speed').value); vnow = 0; trace = { t: [], T: [], sp: [] }; stepState = [];
    const total = P.tempProgram.length;
    const env = {
      pollSec: 2, now: () => vnow,
      sleep: async s => { simDev.advance(s); vnow += s; if (speed > 0) await sleepReal(s * 1000 / speed); else if (Math.round(vnow) % 20 === 0) await sleepReal(0); },
      onTemp: s => { trace.t.push(s.t); trace.T.push(s.T); trace.sp.push(s.setpoint); updateKpis(s); drawTemp(); },
      onStep: (i, s, st) => { stepState[i] = st; $('r-prog').style.width = ((st === 'done' ? i + 1 : i) / total * 100) + '%'; setStatus(`Step ${i + 1}/${total}: ${HH.STEP_TYPES[s.type].label}`); hist(P, 'run', `Step ${i + 1} ${st}: ${s.type}`); renderRun(); },
      measure: ctx => measure(ctx, speed),
    };
    runner = new HH.ProgramRunner(ctrl, P.tempProgram, env, { maxK: tl().maxK, maxRateKmin: tl().maxRateKmin });
    running = true; hist(P, 'run', `Program started (${total} steps, ${P.runs.length} existing runs)`); renderRun();
    try { await runner.run(); setStatus('Finished'); hist(P, 'run', 'Program finished'); }
    catch (e) { setStatus((e.aborted ? 'Aborted: ' : 'Error: ') + e.message); hist(P, 'run', (e.aborted ? 'Aborted: ' : 'ERROR: ') + e.message + ' — heater switched off'); }
    running = false; runner = null; dirty = true; renderRun(); refreshTabs();
    if (P.runs.length) { selRun = P.runs[P.runs.length - 1].id; }
  };
  $('r-pause').onclick = () => { if (!runner) return; if (runner.state === 'paused') runner.resume(); else runner.pause(); hist(P, 'run', runner.state === 'paused' ? 'resume' : 'pause'); setTimeout(renderRun, 50); };
  $('r-abort').onclick = () => { if (runner && confirm('Abort the program? The heater will be switched off.')) runner.abort(); };

  async function measure(ctx, speed) {
    const id = 'run-' + String(P.runs.length + 1).padStart(3, '0');
    Logger.info('MEAS', `${id}: ${P.method.kind} mode at ${ctx.T_set} K`);
    const T = await ctrl.readK();
    const res = await HH.acquire(P, ctx, () => T);
    const dur = res.samples.t[res.samples.t.length - 1]; vnow += dur; simDev.advance(dur);
    if (speed > 0) await sleepReal(Math.min(dur * 1000 / speed, 5000));
    const run = { id, label: ctx.step.label || '', T_set: ctx.T_set, T_mean: res.T_mean, started: new Date().toISOString(), simulated: true, rsq_ohm: res.rsq_ohm, sample: JSON.parse(JSON.stringify(P.sample)), method: JSON.parse(JSON.stringify(P.method)), samples: res.samples, excluded: [] };
    fitRun(run); P.runs.push(run);
    hist(P, 'run', `${id} saved: T=${run.T_mean.toFixed(3)} K, n_s=${fx(run.derived?.ns)} m⁻²`, { run: id });
    Logger.info('MEAS', `${id} done: A1=${fx(run.fit?.A1)} Ω`);
    selRun = id; if (current === 'inspect' && $('i-live').checked) renderInspect();
  }
  function fitRun(run) {
    try {
      run.fit = HH.fitHarmonics(run.samples);
      run.derived = HH.derive(run.fit, Object.assign({}, run.sample, { rsq_ohm: run.rsq_ohm ?? run.sample.rsq_ohm }));
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
    $('i-kpis').innerHTML = [['T mean', fx(r.T_mean, 5) + ' K'], ['Samples (valid)', `${s.t.length} (${s.valid.reduce((a, b) => a + b, 0)})`], ['A1', f ? fx(f.A1) + ' Ω' : '—'], ['D1/A1', f ? fx(f.D1 / f.A1, 3) : '—'], ['A2', f ? fx(f.A2) + ' Ω' : '—'], ['Fit rms', f ? fx(f.rms) + ' V' : '—'], ['Condition', f ? fx(f.cond, 3) : '—'], ['Carrier', d?.carrier || '—']].map(([a, b]) => `<div class="kpi"><span>${a}</span><b>${esc(b)}</b></div>`).join('') + (r.fitError ? `<div class="notice err">${esc(r.fitError)}</div>` : '') + (d ? d.warnings.map(w => `<div class="notice">${esc(w)}</div>`).join('') : '') + (r.simulated ? '<div class="notice">Simulated data.</div>' : '');
    // choose one current level for X vs angle readability: all valid points, X/I normalised to ohm
    const vi = [], mi = []; s.theta.forEach((th, i) => (s.valid[i] ? vi : mi).push(i));
    const wrap = th => { const w = ((th % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI); return w * 180 / Math.PI; };
    const R = i => s.X[i] / s.I[i];
    const model = i => { if (!f) return NaN; const th = s.theta[i]; return f.A1 * Math.cos(th) + f.D1 * Math.sin(th) + f.A2 * Math.sin(2 * th) + f.B2c * Math.cos(2 * th) + (isFinite(f.b0) ? f.b0 : 0) + f.o0 / s.I[i]; };
    HH.plot($('c-xth'), [{ x: mi.map(i => wrap(s.theta[i])), y: mi.map(R), color: '#566677', kind: 'points' }, { x: vi.map(i => wrap(s.theta[i])), y: vi.map(R), color: '#66d6ce', kind: 'points' }, { x: vi.map(i => wrap(s.theta[i])), y: vi.map(model), color: '#e3b96e', kind: 'points' }], { xlabel: 'field angle (deg)', ylabel: 'X / I (Ω)' });
    HH.plot($('c-xt'), [{ x: s.t, y: s.X, color: '#66d6ce' }, { x: s.t, y: s.Y, color: '#80aaf9' }], { xlabel: 't (s)', ylabel: 'lock-in (V)' });
    HH.plot($('c-res'), [{ x: vi.map(i => wrap(s.theta[i])), y: vi.map(i => R(i) - model(i)), color: '#80aaf9', kind: 'points' }], { xlabel: 'field angle (deg)', ylabel: 'residual (Ω)' });
    const t = $('i-table'); t.innerHTML = '<tr><th>t (s)</th><th>θ (deg)</th><th>X (V)</th><th>Y (V)</th><th>I (A)</th><th>T (K)</th><th>valid</th></tr>';
    const stride = Math.max(1, Math.floor(s.t.length / 300));
    for (let i = 0; i < s.t.length; i += stride) { const tr = t.insertRow(); [s.t[i].toFixed(2), (s.theta[i] * 180 / Math.PI).toFixed(1), fx(s.X[i], 4), fx(s.Y[i], 3), fx(s.I[i], 4), s.T[i].toFixed(4), s.valid[i]].forEach(v => tr.insertCell().textContent = v); }
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
    const ok = P.runs.filter(r => r.derived), T = ok.map(r => r.T_mean);
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
      for (const r of np.runs) { const s = r.samples, n = s && s.t ? s.t.length : -1; if (n < 1 || ['theta', 'X', 'Y', 'I', 'T', 'valid'].some(k => !Array.isArray(s[k]) || s[k].length !== n)) throw new Error(`Run ${r.id}: inconsistent sample arrays.`); }
      if (dirty && !confirm('Unsaved changes will be lost. Load anyway?')) return;
      P = np; ctrl = null; simDev = null; dirty = false; selRun = P.runs.length ? P.runs[0].id : null;
      np.runs.forEach(r => { if (!r.fit && !r.fitError) fitRun(r); });
      if (Array.isArray(o.log)) { Logger.entries = o.log.slice(-Logger.max); Logger.seq = Logger.entries.reduce((m, e) => Math.max(m, e.n || 0), 0); }
      hist(P, 'project', `loaded ${f.name} (${P.runs.length} runs)`); Logger.info('IO', `Loaded project ${f.name}: ${P.runs.length} runs`);
      syncForm(); setBadges(); msg(`Loaded ${f.name}: ${P.runs.length} runs. Controller disconnected — reconnect to run again.`, 'ok'); show(P.runs.length ? 'analysis' : 'project');
    } catch (e) { Logger.error('IO', 'Load failed: ' + e.message); msg('Load failed: ' + e.message, 'err'); }
  };
  $('pr-new').onclick = () => { if (running) return; if (!confirm('Start a new project? Unsaved data will be lost.')) return; P = newProject(); ctrl = null; simDev = null; dirty = false; selRun = null; syncForm(); setBadges(); hist(P, 'project', 'new project'); show('hardware'); };
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
    const ok = P.runs.filter(r => r.derived), T = ok.map(r => r.T_mean), s = P.sample, m = P.method;
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
  buildTabs(); syncForm(); setBadges(); Logger.info('APP', 'Workstation started (simulated backend)'); hist(P, 'project', 'new project');
  show('hardware');
  window.HH.debugState = () => ({ P, ctrl, running });
})();
