/* Lake Shore 332 / 335 temperature controller (GPIB) driver, step-program engine, and a command-level simulator.
   Transport interface (async, so the same driver works over Tauri IPC -> NI-VISA GPIB):
       { write(cmd): Promise<void>, query(cmd): Promise<string> }
   Commands below are the common 332/335 subset; verify against the manuals before connecting hardware:
   332: RANGE <r>, RAMP <loop>,<0|1>,<K/min>, HTR?     335: RANGE <out>,<r>, RAMP <out>,<0|1>,<K/min>, HTR? <out>
   Every command sent/received is logged at Debug level. */
(function (root) {
  'use strict';
  const HH = root.HH || (root.HH = {});
  const core = (typeof require !== 'undefined' && typeof module !== 'undefined') ? require('./core.js') : HH;
  const { Logger } = core;

  const MODELS = {
    LS332: { name: 'Lake Shore 332', idn: '332', loops: [1, 2], inputs: ['A', 'B'], maxK: 1500 },
    LS335: { name: 'Lake Shore 335', idn: '335', loops: [1, 2], inputs: ['A', 'B'], maxK: 1500 },
  };
  const RANGES = { off: 0, low: 1, medium: 2, high: 3 };
  const RANGE_NAMES = ['off', 'low', 'medium', 'high'];

  class LakeShore {
    constructor(model, transport, opts) {
      if (!MODELS[model]) throw new Error('Unsupported model ' + model);
      this.model = model; this.spec = MODELS[model]; this.t = transport;
      this.input = (opts && opts.input) || 'A'; this.loop = (opts && opts.loop) || 1;
      if (!this.spec.inputs.includes(this.input)) throw new Error('Input ' + this.input + ' not on ' + this.spec.name);
      if (!this.spec.loops.includes(this.loop)) throw new Error('Loop ' + this.loop + ' not on ' + this.spec.name);
    }
    async _w(c) { Logger.debug('LS.tx', c); await this.t.write(c); }
    async _q(c) {
      Logger.debug('LS.tx', c);
      const r = String(await this.t.query(c)).trim();
      Logger.debug('LS.rx', c + ' -> ' + r);
      return r;
    }
    _num(s, what) {
      const v = Number(s);
      if (!Number.isFinite(v)) throw new Error('Lake Shore returned non-numeric ' + what + ': "' + s + '"');
      return v;
    }
    async identify() {
      const id = await this._q('*IDN?');
      const p = id.split(',');
      if (p.length < 4 || !p[1].includes(this.spec.idn)) throw new Error(`Expected ${this.spec.name}, instrument says "${id}"`);
      Logger.info('LS', 'Connected: ' + id);
      return { manufacturer: p[0], model: p[1], serial: p[2], firmware: p[3] };
    }
    async readK(input) { return this._num(await this._q('KRDG? ' + (input || this.input)), 'temperature'); }
    async getSetpoint() { return this._num(await this._q('SETP? ' + this.loop), 'setpoint'); }
    async setSetpoint(K, maxK) {
      const lim = Math.min(maxK || Infinity, this.spec.maxK);
      if (!(K > 0) || K > lim) throw new Error(`Setpoint ${K} K outside 0..${lim} K`);
      await this._w(`SETP ${this.loop},${K.toFixed(3)}`);
    }
    async setRamp(on, rateKmin) {
      if (on && !(rateKmin >= 0.1 && rateKmin <= 100)) throw new Error('Ramp rate must be 0.1..100 K/min');
      await this._w(`RAMP ${this.loop},${on ? 1 : 0},${on ? rateKmin.toFixed(2) : 0}`);
    }
    async isRamping() { return (await this._q('RAMPST? ' + this.loop)).trim() === '1'; }
    async setHeaterRange(name) {
      if (!(name in RANGES)) throw new Error('Heater range must be off/low/medium/high');
      await this._w(this.model === 'LS332' ? `RANGE ${RANGES[name]}` : `RANGE ${this.loop},${RANGES[name]}`);
    }
    async getHeaterRange() {
      const v = Number(await this._q(this.model === 'LS332' ? 'RANGE?' : 'RANGE? ' + this.loop));
      return RANGE_NAMES[v] || 'unknown';
    }
    async heaterPercent() { return this._num(await this._q(this.model === 'LS332' ? 'HTR?' : 'HTR? ' + this.loop), 'heater output'); }
    async setPID(p, i, d) { await this._w(`PID ${this.loop},${p},${i},${d}`); }
    async getPID() { const [p, i, d] = (await this._q('PID? ' + this.loop)).split(',').map(Number); return { p, i, d }; }
    /** Safe state: heater off and setpoint untouched. Used on abort / error. */
    async heaterOff() { await this.setHeaterRange('off'); Logger.info('LS', 'Heater switched OFF'); }
  }

  /* ---------------- Step programming ---------------- */
  const STEP_TYPES = {
    goto: {
      label: 'Go to T and stabilise',
      defaults: {
        T: 300,
        rate: 5,
        range: 'medium',
        min_stab_s: 60,
        max_stab_s: 3600,
        avg_s: 30,
        tol: 0.05,
        esd_tol: 0.02,
        window_s: 30,
        timeout_s: 3600,
        mean_tol: 0.02,
      },
    },
    soak: { label: 'Soak / wait', defaults: { seconds: 60 } },
    measure: { label: 'Run Hall measurement', defaults: { label: '' } },
    heater_off: { label: 'Heater off', defaults: {} },
  };
  function makeStep(type, over) {
    const step = Object.assign({ type }, STEP_TYPES[type].defaults, over || {});
    if (type === 'goto' && over) {
      if (over.window_s !== undefined) {
        if (over.avg_s === undefined) step.avg_s = over.window_s;
        if (over.min_stab_s === undefined) step.min_stab_s = over.window_s;
      }
      if (over.timeout_s !== undefined && over.max_stab_s === undefined) step.max_stab_s = over.timeout_s;
    }
    return step;
  }
  /** Generate goto+measure pairs for a linear temperature sweep (inclusive). */
  function sweep(T0, T1, dT, base) {
    if (![T0, T1, dT].every(Number.isFinite) || !(dT > 0)) throw new Error('Start, end and step must be finite; step must be > 0');
    if (Math.abs(T1 - T0) / dT > 999) throw new Error('Sweep is limited to 1000 temperature points');
    const out = [], dir = T1 >= T0 ? 1 : -1, n = Math.floor(Math.abs(T1 - T0) / dT + 1e-9);
    for (let k = 0; k <= n; k++) {
      const T = +(T0 + dir * k * dT).toFixed(4);
      out.push(makeStep('goto', Object.assign({}, base, { T })), makeStep('measure', { label: T + ' K' }));
    }
    return out;
  }
  function validateProgram(steps, limits) {
    const L = Object.assign({ maxK: 400, minK: 1.4, maxRateKmin: 10 }, limits), errs = [];
    if (!steps.length) errs.push('Program is empty');
    steps.forEach((s, i) => {
      const w = 'Step ' + (i + 1) + ' (' + s.type + '): ';
      if (!STEP_TYPES[s.type]) return errs.push(w + 'unknown type');
      if (s.type === 'goto') {
        if (!(s.T >= L.minK && s.T <= L.maxK)) errs.push(w + `T must be ${L.minK}..${L.maxK} K`);
        if (!(s.rate > 0 && s.rate <= L.maxRateKmin)) errs.push(w + `rate must be >0 and ≤ ${L.maxRateKmin} K/min`);
        if (!(s.range in RANGES) || s.range === 'off') errs.push(w + 'heater range must be low/medium/high');
        if (s.mean_tol !== undefined && !(Number.isFinite(s.mean_tol) && s.mean_tol > 0 && s.mean_tol <= s.tol)) errs.push(w + 'mean error limit must be > 0 and no greater than the instantaneous error limit');
        if (s.esd_tol !== undefined && !(Number.isFinite(s.esd_tol) && s.esd_tol > 0)) errs.push(w + 'ESD tolerance must be > 0');
        if (!(Number.isFinite(s.tol) && s.tol > 0)) errs.push(w + 'tolerance must be > 0');
        const avg = s.avg_s !== undefined ? s.avg_s : s.window_s;
        const minStab = s.min_stab_s !== undefined ? s.min_stab_s : s.window_s;
        const maxStab = s.max_stab_s !== undefined ? s.max_stab_s : s.timeout_s;
        if (!(Number.isFinite(avg) && avg >= 1)) errs.push(w + 'averaging duration must be ≥ 1 s');
        if (!(Number.isFinite(minStab) && minStab >= avg)) errs.push(w + 'minimum stabilization time must be ≥ averaging duration');
        if (!(Number.isFinite(maxStab) && maxStab > minStab)) errs.push(w + 'maximum stabilization time must exceed minimum stabilization time');
      }
      if (s.type === 'soak' && !(s.seconds >= 0)) errs.push(w + 'seconds must be ≥ 0');
    });
    return errs;
  }
  function programWarnings(steps) {
    return steps.length && !steps.some(s => s.type === 'measure') ? ['Program contains no measurement step'] : [];
  }
  function estimateDuration(steps, T0) {
    let T = T0 || 300, tot = 0;
    for (const s of steps) {
      if (s.type === 'goto') {
        const stabTime = s.min_stab_s !== undefined ? s.min_stab_s : (s.window_s || 60);
        tot += Math.abs(s.T - T) / s.rate * 60 + stabTime;
        T = s.T;
      }
      else if (s.type === 'soak') tot += s.seconds;
    }
    return tot; // seconds, excluding measurement time
  }

  // Stabilization tracker supporting window averaging, mean |ΔT|, and ESD σ_T
  class TemperatureStability {
    constructor(step) {
      this.s = step;
      this.inBandSince = null;
      this.points = [];
      this.avg_s = step.avg_s !== undefined ? step.avg_s : (step.window_s || 30);
      this.min_stab_s = step.min_stab_s !== undefined ? step.min_stab_s : (step.window_s || 60);
      this.max_stab_s = step.max_stab_s !== undefined ? step.max_stab_s : (step.timeout_s || 3600);
      this.tol = step.tol || 0.05;
      this.mean_tol = step.mean_tol !== undefined ? step.mean_tol : this.tol;
      this.esd_tol = step.esd_tol !== undefined ? step.esd_tol : this.tol;
    }
    update(t, T, ramping) {
      const s = this.s, error = Math.abs(T - s.T);
      if (ramping || !Number.isFinite(T) || error > this.tol) {
        this.inBandSince = null;
        this.points = [];
        return {
          error,
          meanError: null,
          esdT: null,
          stableFor: 0,
          ramping,
          covered: false,
          stable: false,
        };
      }
      if (this.inBandSince === null) this.inBandSince = t;
      const stableFor = t - this.inBandSince;

      this.points.push({ t, T, error });
      const cutoff = t - this.avg_s;
      while (this.points.length > 1 && this.points[1].t <= cutoff) this.points.shift();

      const covered = this.points.length > 1 && this.points[0].t <= cutoff;
      let meanError = null, esdT = null;
      if (covered) {
        let integral = 0;
        for (let i = 1; i < this.points.length; i++) {
          const a = this.points[i - 1], b = this.points[i], left = Math.max(cutoff, a.t);
          const eLeft = a.error + (b.error - a.error) * (left - a.t) / (b.t - a.t);
          integral += (eLeft + b.error) * (b.t - left) / 2;
        }
        meanError = integral / this.avg_s;

        const n = this.points.length;
        const meanT = this.points.reduce((acc, p) => acc + p.T, 0) / n;
        const variance = this.points.reduce((acc, p) => acc + Math.pow(p.T - meanT, 2), 0) / n;
        esdT = Math.sqrt(variance);
      }

      const stable = !ramping && covered && stableFor >= this.min_stab_s &&
        (meanError !== null && meanError <= this.mean_tol) &&
        (esdT === null || esdT <= this.esd_tol);

      return {
        error,
        meanError,
        esdT,
        stableFor,
        ramping,
        covered,
        stable,
      };
    }
  }

  /** Executes a program. env = { sleep(sec), now() (sec), measure(ctx) -> Promise, onStep(i, step, state), onTemp(s), pollSec } */
  class ProgramRunner {
    constructor(ctrl, steps, env, limits) {
      this.c = ctrl; this.steps = steps; this.env = env; this.limits = limits || {};
      this.state = 'idle'; this.index = -1; this._abort = false; this._pause = false;
    }
    pause() { this._pause = true; Logger.info('PROG', 'Pause requested'); }
    resume() { this._pause = false; Logger.info('PROG', 'Resume'); }
    abort() { this._abort = true; Logger.warn('PROG', 'Abort requested'); }
    async _checkpoint() {
      while (this._pause && !this._abort) { this.state = 'paused'; await this.env.sleep(1); }
      if (this._abort) throw Object.assign(new Error('Aborted by user'), { aborted: true });
      this.state = 'running';
    }
    async run() {
      const errs = validateProgram(this.steps, this.limits);
      if (errs.length) throw new Error('Invalid program: ' + errs.join('; '));
      this.state = 'running'; Logger.info('PROG', `Program started: ${this.steps.length} steps`);
      try {
        for (this.index = 0; this.index < this.steps.length; this.index++) {
          const s = this.steps[this.index];
          this.env.onStep && this.env.onStep(this.index, s, 'start');
          Logger.verbose('PROG', `Step ${this.index + 1}/${this.steps.length}: ${s.type}`, s);
          await this._exec(s);
          this.env.onStep && this.env.onStep(this.index, s, 'done');
        }
        this.state = 'finished'; Logger.info('PROG', 'Program finished');
      } catch (e) {
        this.state = e.aborted ? 'aborted' : 'error';
        (e.aborted ? Logger.warn : Logger.error).call(Logger, 'PROG', e.message);
        try { await this.c.heaterOff(); } catch (e2) { Logger.error('PROG', 'FAILED to switch heater off: ' + e2.message); }
        throw e;
      }
    }
    async _exec(s) {
      const poll = this.env.pollSec || 2;
      if (s.type === 'goto') {
        await this.c.setHeaterRange(s.range);
        await this.c.setRamp(true, s.rate);
        await this.c.setSetpoint(s.T, this.limits.maxK);
        const t0 = this.env.now(), stability = new TemperatureStability(s);
        for (;;) {
          await this._checkpoint();
          const T = await this.c.readK(), ramping = await this.c.isRamping(), now = this.env.now();
          const status = stability.update(now, T, ramping);
          this.env.onTemp && this.env.onTemp({ t: now, T, setpoint: s.T, heater: await this.c.heaterPercent(), stability: status });
          if (status.stable) { Logger.info('PROG', `Stable at ${T.toFixed(3)} K (set ${s.T}; mean absolute error ${status.meanError.toFixed(4)} K over ${s.window_s} s)`); return; }
          if (now - t0 > s.timeout_s) throw new Error(`Timeout: did not stabilise at ${s.T} K within ${s.timeout_s} s (last ${T.toFixed(3)} K)`);
          await this.env.sleep(poll);
        }
      } else if (s.type === 'soak') {
        const t0 = this.env.now();
        while (this.env.now() - t0 < s.seconds) { await this._checkpoint(); await this.env.sleep(Math.min(poll, s.seconds)); }
      } else if (s.type === 'measure') {
        await this._checkpoint();
        const T = await this.c.readK();
        await this.env.measure({ stepIndex: this.index, step: s, T_set: await this.c.getSetpoint(), T_start: T, checkpoint: () => this._checkpoint() });
      } else if (s.type === 'heater_off') await this.c.heaterOff();
    }
  }

  /* ---------------- Simulated instrument (speaks the command subset above) ---------------- */
  class SimLakeShore {
    constructor(model, T0, seed) {
      this.model = model; this.T = T0 || 295; this.sp = this.T; this.rampOn = false; this.rate = 0; this.rangeI = 0;
      this.ramping = false; this.pid = [50, 20, 0]; this.vt = 0; this.seed = seed || 1;
    }
    _rnd() { this.seed = (this.seed * 1664525 + 1013904223) >>> 0; return this.seed / 4294967296 - 0.5; }
    advance(dt) { // virtual time step
      this.vt += dt;
      if (this.rangeI === 0) { this.T += (295 - this.T) * Math.min(1, dt / 900); this.ramping = false; return; }
      const maxRate = [0, 2, 8, 20][this.rangeI] / 60; // K/s the heater can deliver
      const want = this.rampOn ? this.rate / 60 : maxRate;
      const rate = Math.min(want, maxRate), d = this.sp - this.T;
      this.ramping = this.rampOn && Math.abs(d) > rate * dt;
      this.T += Math.sign(d) * Math.min(Math.abs(d), rate * dt) + 0.002 * this._rnd() * dt;
    }
    _heater() { return this.rangeI === 0 ? 0 : Math.min(100, Math.abs(this.sp - this.T) * 20 + 12); }
    _handle(cmd) {
      const [head, argStr] = cmd.split(/\s+(.*)/); const a = (argStr || '').split(',').map(s => s.trim());
      const is332 = this.model === 'LS332';
      switch (head.toUpperCase()) {
        case '*IDN?': return `LSCI,MODEL${is332 ? '332S' : '335'},SIM0001,1.0`;
        case 'KRDG?': return (this.T + 0.001 * this._rnd()).toFixed(4);
        case 'SETP?': return this.sp.toFixed(4);
        case 'SETP': this.sp = Number(a[1]); return null;
        case 'RAMP': this.rampOn = a[1] === '1'; this.rate = Number(a[2]); return null;
        case 'RAMPST?': return this.ramping ? '1' : '0';
        case 'RANGE': this.rangeI = Number(is332 ? a[0] : a[1]); return null;
        case 'RANGE?': return String(this.rangeI);
        case 'HTR?': return this._heater().toFixed(1);
        case 'PID': this.pid = [a[1], a[2], a[3]]; return null;
        case 'PID?': return this.pid.join(',');
      }
      throw new Error('SIM: unknown command ' + cmd);
    }
    async write(c) { this._handle(c); }
    async query(c) { const r = this._handle(c); if (r === null) throw new Error('SIM: command has no reply: ' + c); return r; }
  }

  const api = { MODELS, RANGES, STEP_TYPES, LakeShore, SimLakeShore, ProgramRunner, TemperatureStability, makeStep, sweep, validateProgram, programWarnings, estimateDuration };
  if (typeof module !== 'undefined') module.exports = api; else Object.assign(HH, api);
})(typeof window !== 'undefined' ? window : globalThis);
