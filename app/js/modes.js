/* Which measurement modes the declared instruments can support, and per-mode validation. */
(function (root) {
  'use strict';
  const SOURCES = { K6220: { name: 'Keithley 6220', ac: false, dc: true }, K6221: { name: 'Keithley 6221', ac: true, dc: true },
    LS155: { name: 'Lake Shore 155', ac: true, dc: true }, MFLI: { name: 'Zurich MFLI (signal output)', ac: true, dc: false } };
  const VOLT = { K2182A: 'Keithley 2182A' };
  const LOCKIN = { SR830: 'SRS SR830', MFLI: 'Zurich MFLI', AMETEK7230: 'Ametek 7230' };
  const ROTATOR = { OWISPS10: 'OWIS PS10' }, ENCODER = { NI9413: 'NI 9413 (cDAQ)' };
  const MODES = {
    fixed: { label: 'Fixed field: angular measurement', ref: 'Gunes et al. §3.4.1', variants: ['dc', 'ac'],
      text: 'Voltage at selected field angles (step and settle) or while scanning through angles. DC current with a nanovoltmeter, or AC current with a lock-in.' },
    rotating: { label: 'Rotating field: continuous detection', ref: 'Gunes et al. §3.4.2', variants: ['dc', 'ac'],
      text: 'Continuously rotating field with a lock-in: DC current with field-frequency detection, or AC current with sideband detection.' },
    chirp: { label: 'CHIRP: current-hopping interleaved rotation', ref: 'CHIRP guide', variants: ['ac'],
      text: 'AC carrier, slowly rotating field and interleaved current amplitudes; lock-in X/Y recorded against calibrated field angle.' },
  };
  const EXC = { dc: 'DC current', ac: 'AC current' };

  /** Missing requirements for one mode + excitation, given hardware (project.hardware). [] means available. */
  function missing(h, kind, exc) {
    const m = [], src = SOURCES[h.source.model];
    if (!h.magnet.rotator) m.push('rotation controller');
    if (!h.magnet.encoder) m.push('position detector');
    if (!src) m.push('current source');
    else if (exc === 'ac' && !src.ac) m.push('AC-capable current source (' + src.name + ' is DC only)');
    else if (exc === 'dc' && !src.dc) m.push('DC-capable current source (' + src.name + ' is AC only)');
    if (kind === 'fixed' && exc === 'dc') { if (!h.measure.volt) m.push('nanovoltmeter'); }
    else if (!h.measure.lockin1 && !h.measure.lockin2) m.push('lock-in amplifier');
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

  function modeErrors(p) {
    const m = p.method, h = p.hardware, e = [];
    if (!m.kind) return ['No measurement mode selected.'];
    const exc = excitationOf(m), mm = missing(h, m.kind, exc);
    if (mm.length) e.push('Selected mode is not available: needs ' + mm.join(', ') + '.');
    const maxmA = h.source.max_mA, pos = v => v > 0;
    const levels = m.kind === 'chirp' ? m.levels_mA : [m[m.kind].I_mA];
    if (!levels.length || !levels.every(pos)) e.push('Current must be positive.');
    else if (maxmA > 0 && Math.max(...levels) > maxmA) e.push(`Current ${Math.max(...levels)} mA exceeds the source limit of ${maxmA} mA (Current source tab).`);
    if (!(m.tc_ms > 0)) e.push('Lock-in time constant must be > 0 (Measure tab).');
    if (m.kind === 'chirp') {
      if (!pos(m.carrier_hz)) e.push('Carrier frequency must be > 0.');
      if (!pos(m.rot_hz)) e.push('Rotation frequency must be > 0.');
      if (!pos(m.dwell_s) || m.mask_s >= m.dwell_s) e.push('Dwell must be > 0 and longer than the mask.');
    } else if (m.kind === 'fixed') {
      const f = m.fixed;
      if (f.acq === 'step') { if (!(f.n_angles >= 4)) e.push('Use at least 4 angles.'); if (!pos(f.settle_s)) e.push('Settling time must be > 0.'); }
      else if (!pos(f.rot_hz)) e.push('Rotation frequency must be > 0.');
      if (f.excitation === 'ac' && !pos(f.carrier_hz)) e.push('Carrier frequency must be > 0.');
    } else {
      const r = m.rotating;
      if (!pos(r.rot_hz)) e.push('Rotation frequency must be > 0.');
      if (!pos(r.duration_s) || r.duration_s * r.rot_hz < 1) e.push('Acquire at least one full rotation (duration × rotation frequency ≥ 1).');
      if (r.excitation === 'ac' && !pos(r.carrier_hz)) e.push('Carrier frequency must be > 0.');
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
    if (m.kind === 'chirp') return m.levels_mA.length * m.dwell_s * (m.direction === 'both' ? 2 : 1);
    if (m.kind === 'fixed') { const f = m.fixed; return f.acq === 'scan' ? 1 / f.rot_hz : f.n_angles * (f.settle_s + 2) * (f.excitation === 'dc' && f.reverse ? 2 : 1); }
    if (m.kind === 'rotating') return m.rotating.duration_s + (m.rotating.background ? 10 : 0);
    return 0;
  }

  const api = { SOURCES, VOLT, LOCKIN, ROTATOR, ENCODER, MODES, EXC, missing, availability, excitationOf, modeErrors, modeWarnings, sampleErrors, acqSeconds };
  if (typeof module !== 'undefined') module.exports = api; else (root.HH = root.HH || {}, Object.assign(root.HH, api));
})(typeof window !== 'undefined' ? window : globalThis);
