/* Core: logger, event bus, shared project state. Classic script (works from file://). */
(function (root) {
  'use strict';
  const LEVELS = { none: 0, normal: 1, verbose: 2, debug: 3 };
  const bus = (() => {
    const h = {};
    return {
      on(e, f) { (h[e] = h[e] || []).push(f); },
      emit(e, p) { (h[e] || []).forEach(f => { try { f(p); } catch (err) { console.error(err); } }); },
    };
  })();

  /* Log entry: {t (ms epoch), level: 'normal'|'verbose'|'debug'|'error'|'warn', src, msg, data}
     The ring buffer always stores everything at the configured capture level; the *view* filter is separate,
     so switching to Debug afterwards never loses entries captured while it was on. */
  const Logger = {
    level: 'normal', entries: [], max: 50000, seq: 0,
    setLevel(l) { if (!(l in LEVELS)) throw new Error('bad log level ' + l); this.level = l; bus.emit('log:level', l); this.add('verbose', 'log', 'Log level set to ' + l); },
    // errors and warnings are always kept unless level is 'none'
    add(level, src, msg, data) {
      const rank = level === 'error' || level === 'warn' ? 1 : LEVELS[level];
      if (LEVELS[this.level] < rank || this.level === 'none') return null;
      const e = { n: ++this.seq, t: Date.now(), level, src, msg: String(msg) };
      if (data !== undefined && this.level === 'debug') e.data = data;
      this.entries.push(e);
      if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max);
      bus.emit('log:add', e);
      return e;
    },
    info(src, m, d) { return this.add('normal', src, m, d); },
    verbose(src, m, d) { return this.add('verbose', src, m, d); },
    debug(src, m, d) { return this.add('debug', src, m, d); },
    warn(src, m, d) { return this.add('warn', src, m, d); },
    error(src, m, d) { return this.add('error', src, m, d); },
    clear() { this.entries = []; bus.emit('log:clear'); },
    toText(filter) {
      return this.entries.filter(filter || (() => true)).map(e =>
        new Date(e.t).toISOString() + ' [' + e.level.toUpperCase().padEnd(7) + '] ' + e.src + ': ' + e.msg +
        (e.data !== undefined ? ' ' + JSON.stringify(e.data) : '')).join('\n');
    },
  };

  /* Project: everything needed to reload a session for analysis. */
  function newProject() {
    return {
      format: 'halbach-hall-project', version: 1,
      created: new Date().toISOString(), modified: new Date().toISOString(),
      simulated: true,
      sample: { id: '', thickness_nm: 100, width_um: 100, length_um: 500, tilt_deg: 0, B_T: 1.0, rsq_ohm: null, notes: '' },
      hardware: {
        backend: 'real', temperature: 'off',
        tempController: { model: 'LS335', address: 'GPIB0::12::INSTR', input: 'A', loop: 1, maxK: 400, maxRateKmin: 10 },
        magnet: { rotator: 'OWISPS10', rotator_addr: 'COM4', baud: 9600, unit: 1, axis: 1, term: 'crlf', counts_per_turn: 50000, velocity_scale: 1, encoder: '', encoder_addr: '', angle_offset_deg: 0, dir_sign: 1 },
        source: { model: '', address: '', compliance_V: 10, max_mA: 10 },
        measure: { volt: '', volt_addr: '', dc_mode: 'independent', lockin1: '', lockin1_addr: '', lockin2: '', lockin2_addr: '' },
      },
      method: {
        kind: '', tc_ms: 100, lock_timeout_s: 30,
        // CHIRP
        carrier_hz: 700, levels_mA: [0.5, 1, 2], rot_hz: 1.2, cycles: 6, dwell_s: 20, mask_s: 3, direction: 'both',
        // Gunes 2017 sections 3.4.1 and 3.4.2
        fixed: { excitation: 'ac', acq: 'step', I_mA: 1, nplc: 1, carrier_hz: 700, n_angles: 36, settle_s: 2, rot_hz: 0.05, reverse: true },
        rotating: { excitation: 'ac', currents_mA: [-5, -2.5, 0, 2.5, 5], I_mA: 1, rot_hz: 0.2, carrier_hz: 700, sideband: 'lower', duration_s: 60, background: true },
      },
      tempProgram: [{ type: 'measure', label: 'Room temp' }],
      runs: [],        // one per measurement step: {id, T_set, T_mean, started, fit, samples:{t,theta,X,Y,I,T}, flags}
      history: [],     // audit trail of user actions & run lifecycle
      log: [],
    };
  }

  // Ready-to-run fixture; keep newProject blank for project import defaults.
  function newTestProject() {
    const p = newProject();
    p.sample.id = 'TEST-001';
    p.sample.notes = 'Synthetic test sample. All instruments and measurements are simulated.';
    Object.assign(p.hardware.magnet, { rotator: 'OWISPS10', rotator_addr: 'SIM::ROTATOR', encoder: 'NI9361', encoder_addr: 'SIM::ENCODER', host: 'SIM::CHASSIS' });
    p.hardware.backend = 'simulation'; p.hardware.temperature = 'control';
    Object.assign(p.hardware.source, { model: 'K6221', address: 'GPIB0::13::INSTR' });
    Object.assign(p.hardware.measure, { volt: 'K2182A', volt_addr: 'GPIB0::7::INSTR', lockin1: 'SR830', lockin1_addr: 'GPIB0::8::INSTR', lockin2: 'SR830', lockin2_addr: 'GPIB0::9::INSTR' });
    p.method.kind = 'chirp';
    return p;
  }

  function hist(project, kind, text, extra) {
    project.history.push(Object.assign({ t: new Date().toISOString(), kind, text }, extra || {}));
    project.modified = new Date().toISOString();
    bus.emit('history:add');
  }

  // Validate and normalize a copy before replacing the open project. Historical
  // runs keep their own geometry and method; cached results are always refitted.
  function normalizeProject(input) {
    if (!input || input.format !== 'halbach-hall-project') throw new Error('Not a Halbach Hall project file.');
    if (input.version !== undefined && (!Number.isInteger(input.version) || input.version < 1 || input.version > 1)) throw new Error('Unsupported project version: ' + input.version);
    const o = JSON.parse(JSON.stringify(input)), base = newProject();
    const object = (v, name) => { if (v !== undefined && (!v || typeof v !== 'object' || Array.isArray(v))) throw new Error(name + ' must be an object.'); return v || {}; };
    const mergeMethod = (value, defaults) => {
      const method = { ...defaults, ...object(value, 'Method') };
      for (const k of ['fixed','rotating']) method[k] = { ...defaults[k], ...object(value?.[k], 'Method ' + k) };
      if (!Array.isArray(method.levels_mA) || !Array.isArray(method.rotating.currents_mA)) throw new Error('Current levels must be arrays.');
      return method;
    };
    const p = { ...base, ...o, sample: { ...base.sample, ...object(o.sample, 'Sample') }, method: mergeMethod(o.method, base.method), hardware: { ...base.hardware, ...object(o.hardware, 'Hardware') } };
    for (const k of ['tempController','magnet','source','measure']) p.hardware[k] = { ...base.hardware[k], ...object(o.hardware?.[k], 'Hardware ' + k) };
    if (!o.method?.kind) p.method.kind = 'chirp';
    if (p.method.fixed.excitation === 'delta') { p.method.fixed.excitation = 'dc'; p.hardware.measure.dc_mode = 'delta'; }
    if (!o.method?.cycles) p.method.cycles = Math.max(1, Math.ceil(p.method.dwell_s * p.method.rot_hz));
    for (const k of ['runs','history','log','tempProgram']) if (!Array.isArray(p[k])) throw new Error(k + ' must be an array.');
    if (p.tempProgram.some(s => !s || typeof s !== 'object' || typeof s.type !== 'string')) throw new Error('Invalid program step.');
    if (p.history.some(h => !h || typeof h.t !== 'string' || typeof h.kind !== 'string' || typeof h.text !== 'string')) throw new Error('Invalid history entry.');
    if (p.log.some(e => !e || !Number.isFinite(e.t) || typeof e.level !== 'string' || typeof e.src !== 'string' || typeof e.msg !== 'string')) throw new Error('Invalid log entry.');
    const ids = new Set();
    p.runs = p.runs.map((r, index) => {
      object(r, 'Run');
      const id = String(r.id || 'run-' + String(index+1).padStart(3,'0'));
      if (ids.has(id)) throw new Error('Duplicate run ID: ' + id); ids.add(id);
      const samples = object(r.samples, 'Run ' + id + ' samples'), n = samples.t?.length;
      if (!Array.isArray(samples.t) || !samples.t.every(Number.isFinite)) throw new Error('Run ' + id + ': sample times must be finite numbers.');
      for (const key of ['X','I','theta','Y','T','valid']) {
        if (samples[key] === undefined && ['Y','T','valid'].includes(key)) samples[key] = new Array(n).fill(key === 'valid' ? 1 : null);
        if (samples[key] === undefined && key === 'theta' && r.detectionKind === 'field-lockin') samples.theta = new Array(n).fill(null);
        if (!Array.isArray(samples[key]) || samples[key].length !== n) throw new Error('Run ' + id + ': inconsistent ' + key + ' sample array.');
        if (key !== 'valid' && samples[key].some(v => v !== null && !Number.isFinite(v))) throw new Error('Run ' + id + ': ' + key + ' contains nonnumeric samples.');
      }
      if (samples.valid.some(v => ![0,1,false,true].includes(v))) throw new Error('Run ' + id + ': invalid sample mask.');
      samples.valid = samples.valid.map(Number);
      const method = mergeMethod(r.method, p.method);
      if (method.fixed.excitation === 'delta') method.fixed.excitation = 'dc';
      if (r.simulated !== undefined && typeof r.simulated !== 'boolean') throw new Error('Run ' + id + ': simulated must be true or false.');
      if (r.analysisSample !== undefined) object(r.analysisSample, 'Analysis sample');
      return { ...r, id, simulated:r.simulated ?? (o.simulated !== false), sample: { ...p.sample, ...object(r.sample, 'Run sample') }, method, samples, excluded: Array.isArray(r.excluded) ? r.excluded : [], fit: null, derived: null, fitError: null };
    });
    p.simulated = p.runs.some(r => r.simulated === true);
    return p;
  }

  const api = { LEVELS, bus, Logger, newProject, newTestProject, normalizeProject, hist };
  if (typeof module !== 'undefined') module.exports = api; else root.HH = Object.assign(root.HH || {}, api);
})(typeof window !== 'undefined' ? window : globalThis);
