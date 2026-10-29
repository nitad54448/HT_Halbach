/* Which measurement modes the declared instruments can support, and per-mode validation. */
(function (root) {
  'use strict';
  const SOURCES = { K6220: { name: 'Keithley 6220', ac: false, dc: true }, K6221: { name: 'Keithley 6221', ac: true, dc: true },
    LS155: { name: 'Lake Shore 155', ac: true, dc: true }, MFLI: { name: 'Zurich MFLI (signal output)', ac: true, dc: false } };
  const VOLT = { K2182: 'Keithley 2182', K2182A: 'Keithley 2182A' };
  const LOCKIN = { SR830: 'SRS SR830', MFLI: 'Zurich MFLI', AMETEK7230: 'Ametek 7230' };
  const ROTATOR = { OWISPS10: 'OWIS PS10' }, ENCODER = { NI9361: 'External optical encoder: NI 9361 / cDAQ-9183' };
  const MODES = {
    fixed: { label: 'DC field: steps or scans', ref: 'Gunes et al. §3.4.1', variants: ['dc', 'ac'],
      text: 'Voltage at selected field angles (step and settle) or while scanning through angles. DC current with a nanovoltmeter, or AC current with a lock-in.' },
    rotating: { label: 'AC field: DC or AC current', ref: 'Gunes et al. §3.4.2', variants: ['dc', 'ac'],
      text: 'Continuously rotating field with a lock-in: DC current with field-frequency detection, or AC current with sideband detection.' },
    chirp: { label: 'CHIRP: current-hopping interleaved rotation', ref: 'CHIRP guide', variants: ['ac'],
      text: 'AC carrier, slowly rotating field and interleaved current amplitudes; lock-in X/Y recorded against calibrated field angle.' },
  };
  const EXC = { dc: 'DC current', ac: 'AC current' };
  const MAX_ROT_HZ = 1.2;
  const isDelta = p => {
    const isKeithleySource = ['K6220', 'K6221'].includes(p.hardware.source.model);
    const isKeithleyVolt = ['K2182', 'K2182A'].includes(p.hardware.measure.volt);
    return isKeithleySource && isKeithleyVolt && (
      p.hardware.measure.dc_mode === 'delta' ||
      p.method.fixed?.excitation === 'delta' ||
      !p.hardware.measure.volt_addr ||
      p.hardware.measure.volt_addr.trim() === '' ||
      p.hardware.measure.volt_addr.trim().toUpperCase() === (p.hardware.source.address || '').trim().toUpperCase()
    );
  };
  const usesVoltmeter = m => m.kind === 'fixed' && ['dc', 'delta'].includes(m.fixed.excitation);
  function chirpDwell(m) { return m.cycles ? m.cycles / m.rot_hz : m.dwell_s; }

  /** Missing requirements for one mode + excitation, given hardware (project.hardware). [] means available. */
  function missing(h, kind, exc) {
    const m = [], src = SOURCES[h.source.model];
    if (!h.magnet.rotator) m.push('rotation controller');
    // OWIS provides absolute position without an external encoder/DAQ.
    if (!src) m.push('current source');
    else if (exc === 'ac' && !src.ac) m.push('AC-capable current source (' + src.name + ' is DC only)');
    else if (['dc', 'delta'].includes(exc) && !src.dc) m.push('DC-capable current source (' + src.name + ' is AC only)');
    if (kind === 'fixed' && ['dc', 'delta'].includes(exc)) { if (!h.measure.volt) m.push('nanovoltmeter'); }
    else if (!h.measure.lockin1 && !h.measure.lockin2) m.push('lock-in amplifier');
    if (kind === 'fixed' && (exc === 'delta' || (exc === 'dc' && h.measure.dc_mode === 'delta')) && !['K6220', 'K6221'].includes(h.source.model)) m.push('Keithley 6220 or 6221 for delta mode');
    return m;
  }
  /** {kind: {ok, variants: {dc:{ok, missing}, ac:{...}}}} */
  function availability(h) {
    const out = {};
    for (const [k, md] of Object.entries(MODES)) {
      const variants = {}; let ok = false;
      for (const e of md.variants) { const mm = missing(h, k, e); variants[e] = { ok: !mm.length, missing: mm }; ok = ok || !mm.length; }
      out[k] = { ok, variants };
    }
    return out;
  }
  function excitationOf(m) { return m.kind === 'chirp' ? 'ac' : m.kind ? m[m.kind].excitation : null; }
  function principle(m) { return {kind:m.kind, excitation:excitationOf(m)==='delta'?'dc':excitationOf(m), acquisition:m.kind==='fixed'?m.fixed.acq:null}; }
  function principleErrors(m) {
    if(!MODES[m.kind]) return ['Choose a measurement method.'];
    const errors=[];
    if(!MODES[m.kind].variants.includes(excitationOf(m))) errors.push('Choose DC current or AC current.');
    if(m.kind==='fixed'&&!['step','scan'].includes(m.fixed.acq)) errors.push('Choose steps or scans.');
    return errors;
  }

  function modeErrors(p, checkHardware = true) {
    const m = p.method, h = p.hardware, e = [];
    if (!m.kind) return ['No measurement mode selected.'];
    if (!MODES[m.kind]) return ['Unknown measurement mode.'];
    const exc = excitationOf(m), mm = missing(h, m.kind, exc);
    if (checkHardware && mm.length) e.push('Selected mode is not available: needs ' + mm.join(', ') + '.');
    if (!MODES[m.kind].variants.includes(exc)) e.push('Select a valid excitation.');
    const maxmA = h.source.max_mA, pos = v => Number.isFinite(v) && v > 0;
    const sweep = m.kind === 'rotating' && exc === 'dc';
    const levels = m.kind === 'chirp' ? m.levels_mA : sweep ? m.rotating.currents_mA : [m[m.kind].I_mA];
    if (!Array.isArray(levels) || !levels.length || !levels.every(v => sweep ? Number.isFinite(v) : pos(v))) e.push('Enter valid current levels (positive amplitudes except for DC current sweeps).');
    else {
      if (sweep && new Set(levels).size < 2) e.push('DC current slope requires at least two distinct currents.');
      if (maxmA > 0 && Math.max(...levels.map(Math.abs)) > maxmA) e.push(`Current exceeds the source limit of ${maxmA} mA (Current source tab).`);
    }
    if (!usesVoltmeter(m) && !(m.tc_ms > 0)) e.push('Lock-in time constant must be > 0 (Experiment setup).');
    if (!usesVoltmeter(m) && (!pos(m.lock_timeout_s) || m.lock_timeout_s > 600)) e.push('Reference lock timeout must be > 0 and at most 600 seconds.');
    const rotation = m.kind === 'chirp' ? m.rot_hz : m[m.kind].rot_hz;
    if ((m.kind !== 'fixed' || m.fixed.acq === 'scan') && (!pos(rotation) || rotation > MAX_ROT_HZ)) e.push('Rotation frequency must be > 0 and at most 1.2 Hz.');
    if (m.kind === 'chirp') {
      if (!pos(m.carrier_hz)) e.push('Carrier frequency must be > 0.');
      if (!pos(m.rot_hz)) e.push('Rotation frequency must be > 0.');
      if (!Number.isInteger(m.cycles) || m.cycles < 1) e.push('CHIRP cycles per current level must be a positive integer.');
      if (!(m.mask_s >= 0) || m.mask_s >= chirpDwell(m)) e.push('Mask must be nonnegative and shorter than cycles / rotation frequency.');
    } else if (m.kind === 'fixed') {
      const f = m.fixed;
      if (usesVoltmeter(m) && (!Number.isInteger(f.nplc) || f.nplc<1 || f.nplc>50)) e.push('Nanovoltmeter integration must be 1..50 whole PLC.');
      if (!['step','scan'].includes(f.acq)) e.push('Select steps or scans.');
      if (f.acq === 'step') { if (!Number.isInteger(f.n_angles) || !(f.n_angles >= 4)) e.push('Use at least 4 whole angles.'); if (!pos(f.settle_s)) e.push('Settling time must be > 0.'); }
      else if (!pos(f.rot_hz)) e.push('Rotation frequency must be > 0.');
      if (f.excitation === 'ac' && !pos(f.carrier_hz)) e.push('Carrier frequency must be > 0.');
    } else {
      const r = m.rotating;
      if (!pos(r.rot_hz)) e.push('Rotation frequency must be > 0.');
      if (!pos(r.duration_s) || r.duration_s * r.rot_hz < 1) e.push('Acquire at least one full rotation (duration × rotation frequency ≥ 1).');
      if (r.excitation === 'ac') { if (!pos(r.carrier_hz)) e.push('Carrier frequency must be > 0.'); else if (r.carrier_hz <= r.rot_hz) e.push('Carrier frequency must exceed rotation frequency.'); }
    }
    return e;
  }
  function modeWarnings(p) {
    const m = p.method, w = [], h = p.hardware;
    if (m.kind === 'chirp') {
      if (m.carrier_hz < 500 || m.carrier_hz > 900) w.push('Carrier outside the guide starting range of 500-900 Hz.');
      if (m.rot_hz < 0.1 || m.rot_hz > 0.3) w.push('Rotation frequency outside the guide range of 0.1-0.3 Hz.');
    }
    if (m.kind === 'rotating' && m.rotating.excitation === 'ac' && !m.rotating.background) w.push('No zero-current background measurement selected.');
    if (m.kind && h.source.model === 'MFLI' && !(h.measure.lockin1 === 'MFLI' || h.measure.lockin2 === 'MFLI')) w.push('MFLI source used with a different lock-in: provide a validated reference connection.');
    return w;
  }
  function sampleErrors(p) {
    const s = p.sample, e = [];
    if (!(s.thickness_nm > 0)) e.push('Thickness must be > 0.');
    if (!(s.B_T > 0)) e.push('Field magnitude must be > 0 (Magnet tab).');
    return e;
  }
  /** Approximate acquisition time in seconds for one temperature point. */
  function acqSeconds(m) {
    if (m.kind === 'chirp') return m.levels_mA.length * chirpDwell(m) * (m.direction === 'both' ? 2 : 1);
    if (m.kind === 'fixed') { const f = m.fixed; return f.acq === 'scan' ? 1 / f.rot_hz : f.n_angles * (f.settle_s + 2) * (f.excitation === 'delta' || (f.excitation === 'dc' && f.reverse) ? 2 : 1); }
    if (m.kind === 'rotating') return m.rotating.excitation === 'dc' ? m.rotating.currents_mA.length * m.rotating.duration_s : m.rotating.duration_s + (m.rotating.background ? 10 : 0);
    return 0;
  }

  const api = { SOURCES, VOLT, LOCKIN, ROTATOR, ENCODER, MODES, EXC, MAX_ROT_HZ, isDelta, usesVoltmeter, chirpDwell, missing, availability, excitationOf, principle, principleErrors, modeErrors, modeWarnings, sampleErrors, acqSeconds };
  if (typeof module !== 'undefined') module.exports = api; else (root.HH = root.HH || {}, Object.assign(root.HH, api));
})(typeof window !== 'undefined' ? window : globalThis);
