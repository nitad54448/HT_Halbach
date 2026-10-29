const assert = require('assert');
const { Logger, newProject } = require('../js/core.js');
const LS = require('../js/lakeshore.js');
const A = require('../js/analysis.js');
const S = require('../js/sim.js');
Logger.setLevel('debug');
(async () => {
  // --- Lake Shore driver + program against simulator, both models, virtual time
  for (const model of ['LS332', 'LS335']) {
    const sim = new LS.SimLakeShore(model, 295, 3), c = new LS.LakeShore(model, sim);
    assert.strictEqual((await c.identify()).serial, 'SIM0001');
    let now = 0, measured = [];
    const env = { pollSec: 2, now: () => now, sleep: async s => { sim.advance(s); now += s; },
      measure: async ctx => measured.push({ set: ctx.T_set, T: await c.readK() }) };
    const prog = [...LS.sweep(300, 310, 5, { rate: 5, window_s: 30 }), LS.makeStep('heater_off')];
    const r = new LS.ProgramRunner(c, prog, env, { maxK: 400, maxRateKmin: 10 });
    await r.run();
    assert.strictEqual(measured.length, 3);
    measured.forEach(m => assert(Math.abs(m.T - m.set) < 0.06, `${model} ${m.T} vs ${m.set}`));
    assert.strictEqual(await c.getHeaterRange(), 'off');
    console.log(model, 'program OK', measured.map(m => m.T.toFixed(3)).join(' '), 'virtual s:', now);
  }
  // Full continuous window and time-weighted absolute error, including irregular polling.
  {
    const step = LS.makeStep('goto', { T: 300, tol: 0.1, mean_tol: 0.02, window_s: 10 });
    const stability = new LS.TemperatureStability(step);
    assert(!stability.update(0, 300.05, false).stable);
    assert(!stability.update(10, 299.95, false).stable, 'opposite errors must not cancel');
    assert(!stability.update(11, 300.2, false).stable, 'outlier resets full window');
    assert(!stability.update(12, 300.01, false).stable);
    assert(!stability.update(21, 299.99, false).stable);
    assert(stability.update(22, 300.01, false).stable);
    assert(!stability.update(23, 300, true).stable, 'ramping resets window');
    const irregular = new LS.TemperatureStability(step);
    irregular.update(0, 300.08, false);
    irregular.update(2, 300, false);
    const status = irregular.update(12, 300, false);
    assert(status.stable && status.meanError === 0, 'old errors drop out of rolling window');
    const weighted = new LS.TemperatureStability(step);
    weighted.update(0, 300.04, false);
    weighted.update(2, 300, false);
    assert(Math.abs(weighted.update(10, 300, false).meanError - 0.004) < 1e-10);
    assert(LS.validateProgram([LS.makeStep('goto', { mean_tol: 0.2, tol: 0.1 })]).length);
    assert.throws(() => LS.sweep(300, Infinity, 1));
    assert.throws(() => LS.sweep(300, 400, 0.001));
    assert.deepStrictEqual(LS.sweep(310, 300, 5).filter(s => s.type === 'goto').map(s => s.T), [310, 305, 300]);
  }
  { // Mean criterion must gate measurement even when every reading is in band.
    let now = 0, measured = false, off = false;
    const ctrl = { setHeaterRange: async () => {}, setRamp: async () => {}, setSetpoint: async () => {},
      readK: async () => 300.04, isRamping: async () => false, heaterPercent: async () => 10,
      heaterOff: async () => { off = true; } };
    const runner = new LS.ProgramRunner(ctrl, [LS.makeStep('goto', { T: 300, tol: 0.05, mean_tol: 0.01, window_s: 10, timeout_s: 20 }), LS.makeStep('measure')],
      { now: () => now, sleep: async s => { now += s; }, measure: async () => { measured = true; } });
    await assert.rejects(runner.run(), /Timeout/);
    assert(off && !measured);
  }
  // --- validation / safety
  assert(LS.validateProgram([LS.makeStep('goto', { T: 900 })], { maxK: 400 }).length);
  assert(LS.validateProgram([LS.makeStep('goto', { rate: 50 })], { maxRateKmin: 10 }).length);
  assert(LS.validateProgram([]).length);
  { // timeout -> heater off
    const sim = new LS.SimLakeShore('LS335', 295), c = new LS.LakeShore('LS335', sim); let now = 0;
    const env = { pollSec: 5, now: () => now, sleep: async s => { sim.advance(s); now += s; }, measure: async () => {} };
    const r = new LS.ProgramRunner(c, [LS.makeStep('goto', { T: 390, rate: 0.5, timeout_s: 120 })], env, { maxK: 400, maxRateKmin: 10 });
    await assert.rejects(r.run(), /Timeout/); assert.strictEqual(r.state, 'error'); assert.strictEqual(await c.getHeaterRange(), 'off');
  }
  { // abort
    const sim = new LS.SimLakeShore('LS332', 295), c = new LS.LakeShore('LS332', sim); let now = 0; let r;
    const env = { pollSec: 2, now: () => now, sleep: async s => { sim.advance(s); now += s; if (now > 20) r.abort(); }, measure: async () => {} };
    r = new LS.ProgramRunner(c, [LS.makeStep('goto', { T: 350 })], env, { maxK: 400, maxRateKmin: 10 });
    await assert.rejects(r.run(), /Aborted/); assert.strictEqual(r.state, 'aborted'); assert.strictEqual(await c.getHeaterRange(), 'off');
  }
  assert.throws(() => new LS.LakeShore('LS335', {}, { input: 'Z' }));
  // --- fit recovers known Hall coefficient from simulated data
  const p = newProject(); p.sample = { id: 't', thickness_nm: 100, B_T: 1, tilt_deg: 0, rsq_ohm: null };
  const run = await S.acquireChirp(p, {}, () => 300, 42);
  const fit = A.fitHarmonics(run.samples), truth = run.truth;
  console.log('A1 fit', fit.A1, '+-', fit.A1_err, 'truth', truth.A1, 'cond', fit.cond.toFixed(1), 'n', fit.n);
  assert(Math.abs(fit.A1 / truth.A1 - 1) < 1e-4 && fit.A1_err / truth.A1 < 0.01);
  p.sample.rsq_ohm = truth.rsq;
  const d = A.derive(fit, p.sample);
  console.log('ns fit', d.ns, 'truth', truth.ns, '| mu', d.mu, truth.mu, d.carrier);
  assert(Math.abs(d.ns / truth.ns - 1) < 0.02); assert(Math.abs(d.mu / truth.mu - 1) < 0.03); assert(d.RH < 0);
  // lstsq exactness
  const M = [[1, 0], [1, 1], [1, 2], [1, 3]], f = A.lstsq(M, [1, 3, 5, 7.0001]); assert(Math.abs(f.coef[1] - 2) < 1e-3);
  console.log('ALL TESTS PASSED');
})().catch(e => { console.error(e); process.exit(1); });
