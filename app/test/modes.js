const assert = require('assert');
const { newProject } = require('../js/core.js');
const M = require('../js/modes.js'), A = require('../js/analysis.js'), S = require('../js/sim.js');
(async () => {
  const p = newProject(), h = p.hardware;
  assert(Object.values(M.availability(h)).every(a => !a.ok), 'nothing available with no instruments');
  h.magnet.rotator = 'OWISPS10'; h.magnet.encoder = 'NI9413';
  assert(Object.values(M.availability(h)).every(a => !a.ok), 'needs source and detector');
  h.source.model = 'K6220'; h.measure.volt = 'K2182A';
  let av = M.availability(h);
  assert(av.fixed.variants.dc.ok && !av.fixed.variants.ac.ok && !av.chirp.ok && !av.rotating.ok);
  assert(/DC only/.test(av.fixed.variants.ac.missing.join()));
  h.source.model = 'K6221'; h.measure.lockin1 = 'SR830'; av = M.availability(h);
  assert(av.fixed.ok && av.rotating.variants.ac.ok && av.rotating.variants.dc.ok && av.chirp.ok);
  h.source.model = 'MFLI'; av = M.availability(h);
  assert(!av.fixed.variants.dc.ok && av.chirp.ok);
  h.source.model = 'K6221';
  p.method.kind = 'chirp'; assert.deepStrictEqual(M.modeErrors(p), []);
  p.method.levels_mA = [50]; assert(M.modeErrors(p).some(e => /exceeds/.test(e))); p.method.levels_mA = [1];
  p.method.kind = 'fixed'; p.method.fixed.excitation = 'dc'; h.measure.volt = ''; assert(M.modeErrors(p).some(e => /nanovoltmeter/.test(e)));
  h.measure.volt = 'K2182A'; assert.deepStrictEqual(M.modeErrors(p), []);
  p.method.kind = 'rotating'; p.method.rotating.duration_s = 2; assert(M.modeErrors(p).some(e => /full rotation/.test(e)));
  // every mode yields fittable simulated data that recovers the truth
  p.sample = { id: 't', thickness_nm: 100, B_T: 1, tilt_deg: 0, rsq_ohm: null };
  const cases = [['chirp', {}], ['fixed', { excitation: 'ac', acq: 'step' }], ['fixed', { excitation: 'dc', acq: 'step', reverse: true }],
    ['fixed', { excitation: 'ac', acq: 'scan' }], ['rotating', { excitation: 'ac', duration_s: 60, background: true }], ['rotating', { excitation: 'dc', duration_s: 60, background: false }]];
  for (const [kind, over] of cases) {
    p.method.kind = kind; if (kind !== 'chirp') Object.assign(p.method[kind], over);
    p.method.rotating.duration_s = 60;
    const run = await S.acquire(p, {}, () => 300, 5), f = A.fitHarmonics(run.samples);
    const rel = Math.abs(f.A1 / run.truth.A1 - 1);
    console.log(kind, JSON.stringify(over), 'n', f.n, 'A1 rel err', rel.toExponential(2), 'acq s', M.acqSeconds(p.method).toFixed(0));
    assert(rel < 1e-3, kind + ' fit off');
  }
  console.log('MODE TESTS PASSED');
})().catch(e => { console.error(e); process.exit(1); });
