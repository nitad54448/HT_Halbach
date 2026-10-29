/* SIMULATED acquisition backend. Generates synthetic CHIRP lock-in data from a made-up semiconductor film.
   Everything produced here is tagged simulated:true and must never be mistaken for measurement data.
   A real backend replaces `acquireChirp` with the Tauri IPC call and keeps the same return shape. */
(function (root) {
  'use strict';
  const HH = root.HH || (root.HH = {});
  const core = (typeof require !== 'undefined' && typeof module !== 'undefined') ? require('./core.js') : HH;
  const { Logger } = core;
  const analysis = (typeof require !== 'undefined' && typeof module !== 'undefined') ? require('./analysis.js') : HH;
  const modes = (typeof require !== 'undefined' && typeof module !== 'undefined') ? require('./modes.js') : HH;

  function rng(seed) { let s = seed >>> 0 || 1; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
  function gauss(r) { return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); }

  /** Toy film: n-type, thermally activated carriers (sheet density ns), Rsq from mobility. Returns ohm quantities. */
  function toyFilm(T, sample) {
    const d = sample.thickness_nm * 1e-9, B = sample.B_T, psi = (sample.tilt_deg || 0) * Math.PI / 180;
    const ns = 4e16 * (1 + 3 * Math.exp(-120 / T)) , mu = 0.12 * Math.pow(300 / T, 0.8); // m^-2, m^2/Vs
    const rsq = 1 / (ns * analysis.E_CHARGE * mu), beta1 = B / (ns * analysis.E_CHARGE); // electrons: R_H<0 => beta1>0 (R_H = -beta1 d/B)
    return { ns, mu, rsq, A1: beta1 * Math.cos(psi), A2: 0.002 * beta1 * Math.sin(psi) };
  }

  /** Build the acquisition schedule for the selected mode. Segment: {n, I (A, signed), mask (s), th(tl, t) -> rad, dir}. */
  function schedule(m, fs) {
    const segs = [], TWO_PI = 2 * Math.PI;
    if (m.kind === 'fixed') {
      const f = m.fixed, I = f.I_mA * 1e-3;
      if (f.acq === 'scan') segs.push({ n: Math.round(fs / m.fixed.rot_hz), I, delta: f.excitation === 'delta', mask: 1, th: (tl, t) => TWO_PI * f.rot_hz * tl, dir: 1 });
      else for (let k = 0; k < f.n_angles; k++) for (const sgn of (f.excitation === 'delta' || (f.excitation === 'dc' && f.reverse) ? [1, -1] : [1]))
        segs.push({ n: Math.round((f.settle_s + 2) * fs), I: sgn * I, mask: f.settle_s, th: () => TWO_PI * k / f.n_angles, dir: 1 });
    } else if (m.kind === 'rotating') {
      const r = m.rotating, I = r.I_mA * 1e-3, n = Math.round(r.duration_s * fs);
      for (const level of (r.excitation === 'dc' ? r.currents_mA : [r.I_mA])) segs.push({ n, I: level * 1e-3, mask: 1, th: (tl, t) => TWO_PI * r.rot_hz * tl, dir: 1 });
      if (r.excitation === 'ac' && r.background) segs.push({ n: Math.round(10 * fs), I: 0, mask: 1, th: (tl) => TWO_PI * r.rot_hz * (tl + r.duration_s), dir: 1 });
    } else {
      const dirs = m.direction === 'both' ? [1, -1] : [m.direction === 'ccw' ? -1 : 1];
      for (const dir of dirs) for (const lvl of m.levels_mA)
        segs.push({ n: Math.round(modes.chirpDwell(m) * fs), I: lvl * 1e-3, mask: m.mask_s, th: (tl, t) => dir * TWO_PI * m.rot_hz * t, dir });
    }
    return segs;
  }

  /** Acquire one run in the selected mode. ctx: {T_set, checkpoint()}. Returns the run record. */
  async function acquire(project, ctx, getT, seed) {
    const m = JSON.parse(JSON.stringify(project.method)), S = project.sample, r = rng(seed || Math.floor(Math.random() * 1e9));
    if(modes.isDelta(project)) m.fixed.excitation='delta';
    const T = getT(), film = toyFilm(T, S), fs = 20; // lock-in output sample rate (Hz)
    const out = { t: [], theta: [], X: [], Y: [], I: [], T: [], valid: [], dir: [] };
    let t = 0; const sigma = 2e-7, contact = 3e-6, tau = Math.max(m.tc_ms / 1000, 0.05) / 3;
    for (const seg of schedule(m, fs)) {
      for (let k = 0; k < seg.n; k++, t += 1 / fs) {
        const tl = k / fs, th = seg.th(tl, t), settle = Math.exp(-tl / tau), I = seg.I * (seg.delta && k % 2 ? -1 : 1);
        const hall = film.A1 * Math.cos(th) + film.A2 * Math.sin(2 * th);
        const Xv = I * hall + I * contact + 1e-7 + settle * I * film.rsq * 0.05 + sigma * gauss(r); // transient removed by the mask
        out.t.push(t); out.theta.push(th); out.X.push(Xv); out.Y.push(sigma * 0.3 * gauss(r)); out.I.push(I);
        out.T.push(T + 0.003 * gauss(r)); out.valid.push(tl >= seg.mask ? 1 : 0); out.dir.push(seg.dir);
      }
      if (ctx.checkpoint) await ctx.checkpoint();
      Logger.debug('SIM', `segment ${(seg.I * 1e3).toFixed(3)} mA, ${seg.n} samples`);
    }
    const rsq_ohm = film.rsq * (1 + 0.002 * gauss(r));
    return { simulated: true, rsq_ohm, T_mean: out.T.reduce((a, b) => a + b, 0) / out.T.length, samples: out, truth: { ns: film.ns, mu: film.mu, rsq: film.rsq, A1: film.A1, A2: film.A2 } };
  }

  const api = { acquire, acquireChirp: acquire, schedule, toyFilm, rng, gauss };
  if (typeof module !== 'undefined') module.exports = api; else Object.assign(HH, api);
})(typeof window !== 'undefined' ? window : globalThis);
