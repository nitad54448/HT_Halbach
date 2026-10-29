/* Analysis: CHIRP harmonic fit (README-Chirp §9) and derived transport quantities (§10).
   Model for lock-in X at plateau amplitude I(t):
     X = I (A1 cos th + D1 sin th + A2 sin 2th + B2c cos 2th + b0) + o0
   Columns are RMS-scaled and solved by Householder QR (no normal equations). */
(function (root) {
  'use strict';
  const E_CHARGE = 1.602176634e-19;

  /** Least squares via Householder QR. M: array of rows. Returns {coef, cov, rss, dof, cond}. */
  function lstsq(M, y) {
    const n = M.length, p = M[0].length;
    if (n <= p) throw new Error('Not enough samples (' + n + ') for ' + p + ' parameters');
    const scale = new Array(p).fill(0);
    for (const r of M) for (let j = 0; j < p; j++) scale[j] += r[j] * r[j];
    for (let j = 0; j < p; j++) scale[j] = Math.sqrt(scale[j] / n) || 1;
    const A = M.map(r => r.map((v, j) => v / scale[j])), b = y.slice();
    for (let k = 0; k < p; k++) {
      let norm = 0; for (let i = k; i < n; i++) norm += A[i][k] * A[i][k];
      norm = Math.sqrt(norm);
      if (norm === 0) throw new Error('Rank-deficient design matrix (column ' + k + ')');
      const alpha = A[k][k] > 0 ? -norm : norm, v = new Array(n).fill(0);
      for (let i = k; i < n; i++) v[i] = A[i][k];
      v[k] -= alpha;
      let vn = 0; for (let i = k; i < n; i++) vn += v[i] * v[i];
      if (vn === 0) continue;
      for (let j = k; j < p; j++) { let s = 0; for (let i = k; i < n; i++) s += v[i] * A[i][j]; s = 2 * s / vn; for (let i = k; i < n; i++) A[i][j] -= s * v[i]; }
      let s = 0; for (let i = k; i < n; i++) s += v[i] * b[i]; s = 2 * s / vn; for (let i = k; i < n; i++) b[i] -= s * v[i];
    }
    const z = new Array(p).fill(0);
    for (let i = p - 1; i >= 0; i--) {
      let s = b[i]; for (let j = i + 1; j < p; j++) s -= A[i][j] * z[j];
      if (Math.abs(A[i][i]) < 1e-12) throw new Error('Rank-deficient design matrix (nearly collinear columns)');
      z[i] = s / A[i][i];
    }
    let rss = 0; for (let i = p; i < n; i++) rss += b[i] * b[i];
    const dof = n - p, s2 = rss / dof;
    // inverse of R (upper triangular), cov_scaled = s2 * Rinv Rinv^T
    const Ri = Array.from({ length: p }, () => new Array(p).fill(0));
    for (let c = 0; c < p; c++) {
      for (let i = p - 1; i >= 0; i--) {
        let s = i === c ? 1 : 0; for (let j = i + 1; j < p; j++) s -= A[i][j] * Ri[j][c];
        Ri[i][c] = s / A[i][i];
      }
    }
    const cov = Array.from({ length: p }, (_, i) => Array.from({ length: p }, (_, j) => {
      let s = 0; for (let k = 0; k < p; k++) s += Ri[i][k] * Ri[j][k];
      return s * s2 / (scale[i] * scale[j]);
    }));
    const dg = A.slice(0, p).map((r, i) => Math.abs(r[i])), cond = Math.max(...dg) / Math.min(...dg);
    return { coef: z.map((v, j) => v / scale[j]), cov, rss, dof, cond };
  }

  /** samples: {theta[], X[], I[] (A rms), valid[] optional}. Returns fit with 1-sigma errors. */
  function fitHarmonics(s, opts) {
    const idx = []; for (let i = 0; i < s.X.length; i++) if (!s.valid || s.valid[i]) idx.push(i);
    const levels = new Set(idx.map(i => s.I[i].toFixed(9)));
    const singleLevel = levels.size === 1, names = ['A1', 'D1', 'A2', 'B2c'];
    if (!singleLevel) names.push('b0');
    names.push('o0');
    const M = idx.map(i => {
      const th = s.theta[i], I = s.I[i], row = [I * Math.cos(th), I * Math.sin(th), I * Math.sin(2 * th), I * Math.cos(2 * th)];
      if (!singleLevel) row.push(I);
      row.push(1); return row;
    });
    const r = lstsq(M, idx.map(i => s.X[i]));
    const out = { n: idx.length, levels: levels.size, rss: r.rss, dof: r.dof, cond: r.cond, rms: Math.sqrt(r.rss / r.dof) };
    names.forEach((nm, j) => { out[nm] = r.coef[j]; out[nm + '_err'] = Math.sqrt(r.cov[j][j]); });
    // coefficients in V/A (= ohm) because X is volts and I is amps
    if (singleLevel) { out.b0 = NaN; out.b0_err = NaN; }
    return out;
  }

  /** Physical quantities. sample: {thickness_nm, tilt_deg, B_T, rsq_ohm}. fit units: ohm. */
  function derive(fit, sample) {
    const psi = (sample.tilt_deg || 0) * Math.PI / 180, B = sample.B_T, d = sample.thickness_nm * 1e-9;
    const o = { warnings: [] };
    const c = Math.cos(psi), s = Math.sin(psi);
    if (Math.abs(c) > 0.05) {
      const beta1 = fit.A1 / c, e1 = fit.A1_err / Math.abs(c);
      o.RH = -beta1 * d / B; o.RH_err = e1 * d / B;                       // m^3/C
      o.ns = B / (E_CHARGE * Math.abs(beta1)); o.ns_err = o.ns * e1 / Math.abs(beta1); // m^-2
      o.n = o.ns / d; o.n_err = o.ns_err / d;                              // m^-3
      o.carrier = o.RH > 0 ? 'p-type (holes)' : 'n-type (electrons)';
      if (sample.rsq_ohm > 0) { o.mu = Math.abs(beta1) / (B * sample.rsq_ohm); o.mu_err = e1 / (B * sample.rsq_ohm); } // m^2/Vs
      else o.warnings.push('Sheet resistance not set: mobility unavailable.');
      if (Math.abs(fit.D1) > 0.2 * Math.abs(fit.A1)) o.warnings.push('|D1| > 20% of |A1|: check angle calibration / phase.');
    } else o.warnings.push('cos(tilt) ≈ 0: ordinary Hall not extractable at this tilt.');
    if (Math.abs(s) > 0.05 && Number.isFinite(fit.A2)) {
      const beta2 = fit.A2 / s; o.K = 2 * d * beta2 / (B * B);
      if (Math.abs(c) > 0.05 && sample.rsq_ohm > 0) o.C = 2 * sample.rsq_ohm * beta2 / Math.pow(fit.A1 / c, 2);
    }
    return o;
  }

  /** Fit signed first-harmonic voltage at each DC current, then voltage/current slope.
   * A free intercept removes current-independent pickup without a separate background run. */
  function fitCurrentSweep(s) {
    const groups = new Map();
    s.I.forEach((I, i) => { if ((!s.valid || s.valid[i]) && Number.isFinite(I)) { if (!groups.has(I)) groups.set(I, []); groups.get(I).push(i); } });
    if (groups.size < 2) throw new Error('Current slope requires at least two distinct currents.');
    const points = [...groups].map(([I, indices]) => {
      const r = lstsq(indices.map(i => { const a = s.theta[i]; return [Math.cos(a), Math.sin(a), Math.sin(2*a), Math.cos(2*a), 1]; }), indices.map(i => s.X[i]));
      return { I, voltage: r.coef[0], coefficients: r.coef, n: indices.length };
    });
    const slopes = [0, 1, 2, 3, 4].map(k => {
      // With two current levels use within-level noise to propagate slope uncertainty.
      const x = points.map(p => p.I), y = points.map(p => p.coefficients[k]);
      const xm = x.reduce((a,b)=>a+b,0)/x.length, ym = y.reduce((a,b)=>a+b,0)/y.length;
      const ss = x.reduce((a,v)=>a+(v-xm)**2,0), slope = x.reduce((a,v,i)=>a+(v-xm)*(y[i]-ym),0)/ss;
      const intercept = ym-slope*xm, rss = x.reduce((a,v,i)=>a+(y[i]-intercept-slope*v)**2,0);
      return { slope, intercept, error: x.length > 2 ? Math.sqrt(rss/(x.length-2)/ss) : null };
    });
    const fit = fitHarmonics(s);
    ['A1', 'D1', 'A2', 'B2c', 'b0'].forEach((name,k) => { fit[name] = slopes[k].slope; if (slopes[k].error !== null) fit[name+'_err'] = slopes[k].error; });
    fit.currentSlope = { points, slope: slopes[0].slope, intercept: slopes[0].intercept, slopeError: slopes[0].error };
    return fit;
  }
  /** Real AC-field detection produces demodulated amplitudes, not angular traces.
   * RMS X: DC-current field detection needs sqrt(2), AC sideband needs 2.
   * Signed X requires an independently calibrated electrical/field reference phase. */
  function fitFieldLockin(s, excitation) {
    const groups=new Map(), gain=excitation==='dc'?Math.SQRT2:2;
    s.I.forEach((I,i)=>{ if ((!s.valid || s.valid[i]) && Number.isFinite(s.X[i])) { if (!groups.has(I)) groups.set(I,[]); groups.get(I).push(s.X[i]*gain); } });
    const points=[...groups].map(([I,ys])=>{ const voltage=ys.reduce((a,b)=>a+b,0)/ys.length; return {I,voltage,n:ys.length,variance:ys.length>1?ys.reduce((a,v)=>a+(v-voltage)**2,0)/(ys.length-1)/ys.length:0}; });
    if (!points.length || points.every(p=>p.I===0)) throw new Error('No nonzero-current lock-in samples.');
    if (excitation==='dc' && points.length<2) throw new Error('DC slope requires multiple currents.');
    let slope,intercept,error;
    if (points.length===1) { slope=points[0].voltage/points[0].I; intercept=0; error=Math.sqrt(points[0].variance)/Math.abs(points[0].I); }
    else {
      const xm=points.reduce((a,p)=>a+p.I,0)/points.length, ym=points.reduce((a,p)=>a+p.voltage,0)/points.length;
      const ss=points.reduce((a,p)=>a+(p.I-xm)**2,0);
      slope=points.reduce((a,p)=>a+(p.I-xm)*(p.voltage-ym),0)/ss; intercept=ym-slope*xm;
      const propagated=points.reduce((a,p)=>a+(p.I-xm)**2*p.variance,0)/ss**2;
      const residual=points.reduce((a,p)=>a+(p.voltage-intercept-slope*p.I)**2,0);
      error=Math.sqrt(Math.max(propagated, points.length>2?residual/(points.length-2)/ss:0));
    }
    return {A1:slope,A1_err:error,D1:null,D1_err:null,A2:null,A2_err:null,B2c:null,b0:null,o0:intercept,
      n:points.reduce((a,p)=>a+p.n,0),levels:points.length,cond:1,rms:Math.sqrt(points.reduce((a,p)=>a+p.variance*p.n,0)/points.length),
      currentSlope:{points,slope,intercept,slopeError:error},
      warnings:['Lock-in amplitude normalization assumes calibrated phase, sinusoidal field and RMS current.', ...(points.length===1?['No zero-current level: current-independent pickup was not subtracted.']:[])]};
  }
  const api = { lstsq, fitHarmonics, fitCurrentSweep, fitFieldLockin, derive, E_CHARGE };
  if (typeof module !== 'undefined') module.exports = api; else (root.HH = root.HH || {}, Object.assign(root.HH, api));
})(typeof window !== 'undefined' ? window : globalThis);
