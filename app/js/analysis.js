/* Analysis: CHIRP harmonic fit (README-Chirp §9) and derived transport quantities (§10).
   Model for lock-in X at plateau amplitude I(t):
     X = I (A1 cos th + D1 sin th + A2 sin 2th + B2c cos 2th + b0) + o0
   Columns are RMS-scaled and solved by Householder QR (no normal equations). */
(function (root) {
  'use strict';
  const E_CHARGE = 1.602176634e-19;

  /** Least squares via Householder QR. M: array of rows. Returns {coef, cov, rss, dof, cond}. */
  function lstsq(M, y) {
    if (!Array.isArray(M) || !M.length || !Array.isArray(M[0]) || !M[0].length) throw new Error('No usable samples for fitting.');
    const n = M.length, p = M[0].length;
    if (!Array.isArray(y) || y.length !== n || !y.every(Number.isFinite) || M.some(r => !Array.isArray(r) || r.length !== p || !r.every(Number.isFinite))) throw new Error('Fit arrays must have matching lengths and finite numeric values.');
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
    const coef = z.map((v, j) => v / scale[j]);
    if (!coef.every(Number.isFinite) || !Number.isFinite(rss) || !cov.every(r => r.every(Number.isFinite))) throw new Error('Fit overflow: check sample units and current range.');
    return { coef, cov, rss, dof, cond };
  }

  function usableSamples(s, angular) {
    const fields = angular ? ['X', 'I', 'theta'] : ['X', 'I'];
    if (!s || fields.some(k => !Array.isArray(s[k])) || fields.some(k => s[k].length !== s.X.length) || (s.valid && (!Array.isArray(s.valid) || s.valid.length !== s.X.length))) throw new Error('Inconsistent sample arrays.');
    const idx = [];
    for (let i = 0; i < s.X.length; i++) if ((!s.valid || s.valid[i] === 1 || s.valid[i] === true) && fields.every(k => Number.isFinite(s[k][i]))) idx.push(i);
    if (!idx.length) throw new Error('No usable samples: check the mask and numeric data.');
    return idx;
  }

  /** samples: {theta[], X[], I[] (A rms), valid[] optional}. Returns fit with 1-sigma errors. */
  function fitHarmonics(s, opts) {
    const idx = usableSamples(s, true);
    const levels = new Set(idx.map(i => s.I[i]));
    if (idx.every(i => s.I[i] === 0)) throw new Error('No nonzero-current samples.');
    const singleLevel = levels.size === 1, names = ['A1', 'D1', 'A2', 'B2c'];
    if (!singleLevel) names.push('b0');
    names.push('o0');
    const M = idx.map(i => {
      const th = s.theta[i], I = s.I[i], row = [I * Math.cos(th), I * Math.sin(th), I * Math.sin(2 * th), I * Math.cos(2 * th)];
      if (!singleLevel) row.push(I);
      row.push(1); return row;
    });
    const r = lstsq(M, idx.map(i => s.X[i]));
    const out = { n: idx.length, levels: levels.size, rss: r.rss, dof: r.dof, cond: r.cond, rms: Math.sqrt(r.rss / r.dof), warnings: [] };
    names.forEach((nm, j) => { out[nm] = r.coef[j]; out[nm + '_err'] = Math.sqrt(r.cov[j][j]); });
    // coefficients in V/A (= ohm) because X is volts and I is amps
    if (singleLevel) { out.b0 = null; out.b0_err = null; out.warnings.push('Single current level: resistive offset and voltage offset cannot be separated.'); }
    if (r.cond > 1e6) out.warnings.push('Poorly conditioned fit: check angular coverage and current levels.');
    return out;
  }

  /** Physical quantities. sample: {thickness_nm, tilt_deg, B_T, rsq_ohm}. fit units: ohm. */
  function derive(fit, sample) {
    const psi = (sample.tilt_deg === undefined ? 0 : sample.tilt_deg) * Math.PI / 180, B = sample.B_T, d = sample.thickness_nm * 1e-9;
    const o = { warnings: [] };
    if (!Number.isFinite(B) || B <= 0) { o.warnings.push('A finite, positive calibrated field magnitude is required for physical properties.'); return o; }
    if (sample.tilt_deg === null || !Number.isFinite(psi)) { o.warnings.push('A finite sample tilt is required for physical properties.'); return o; }
    const thicknessOK = Number.isFinite(sample.thickness_nm) && d > 0;
    if (!thicknessOK) o.warnings.push('A finite, positive thickness is required for bulk density, Hall coefficient and resistivity.');
    const resistanceOK = Number.isFinite(sample.rsq_ohm) && sample.rsq_ohm > 0;
    if (!resistanceOK) o.warnings.push('Sheet resistance not set or invalid: mobility and resistivity unavailable.');
    if (thicknessOK && resistanceOK) { o.rho = sample.rsq_ohm * d; o.sigma = 1 / o.rho; }
    const c = Math.cos(psi), s = Math.sin(psi);
    if (Math.abs(c) > 0.05 && Number.isFinite(fit.A1)) {
      const beta1 = fit.A1 / c, e1 = Number.isFinite(fit.A1_err) ? Math.abs(fit.A1_err / c) : null;
      if (thicknessOK) { o.RH = -beta1 * d / B; o.RH_err = e1 === null ? null : e1 * d / B; }
      if (beta1 === 0) o.warnings.push('Hall slope is zero: carrier density and carrier type are undefined.');
      else {
        o.ns = B / (E_CHARGE * Math.abs(beta1)); o.ns_err = e1 === null ? null : o.ns * e1 / Math.abs(beta1);
        if (thicknessOK) { o.n = o.ns / d; o.n_err = o.ns_err === null ? null : o.ns_err / d; }
        if (e1 !== null && Math.abs(beta1) <= 3 * e1) o.warnings.push('Hall slope is within 3σ of zero: density and carrier sign are poorly resolved.');
        else o.carrier = beta1 < 0 ? 'p-type (holes)' : 'n-type (electrons)';
      }
      if (resistanceOK) { o.mu = Math.abs(beta1) / (B * sample.rsq_ohm); o.mu_err = e1 === null ? null : e1 / (B * sample.rsq_ohm); }
      if (Number.isFinite(fit.D1) && Math.abs(fit.D1) > 0.2 * Math.abs(fit.A1)) o.warnings.push('|D1| > 20% of |A1|: check angle calibration / phase.');
    } else o.warnings.push('cos(tilt) ≈ 0: ordinary Hall not extractable at this tilt.');
    if (Math.abs(s) > 0.05 && Number.isFinite(fit.A2)) {
      const beta2 = fit.A2 / s;
      if (thicknessOK) { o.K = 2 * d * beta2 / (B * B); o.K_err = Number.isFinite(fit.A2_err) ? 2 * d * Math.abs(fit.A2_err / s) / (B * B) : null; }
      if (Math.abs(c) > 0.05 && resistanceOK && Number.isFinite(fit.A1) && fit.A1 !== 0 && (fit.A1_err === null || Math.abs(fit.A1) > 3 * Math.abs(fit.A1_err || 0))) o.C = 2 * sample.rsq_ohm * beta2 / Math.pow(fit.A1 / c, 2);
    }
    for (const key of Object.keys(o)) if (typeof o[key] === 'number' && !Number.isFinite(o[key])) { o[key] = null; o.warnings.push('Property overflow: check calibration and sample units.'); }
    return o;
  }

  /** Fit signed first-harmonic voltage at each DC current, then voltage/current slope.
   * A free intercept removes current-independent pickup without a separate background run. */
  function fitCurrentSweep(s) {
    const groups = new Map();
    usableSamples(s, true).forEach(i => { const I = s.I[i]; if (!groups.has(I)) groups.set(I, []); groups.get(I).push(i); });
    if (groups.size < 2) throw new Error('Current slope requires at least two distinct currents.');
    const points = [...groups].map(([I, indices]) => {
      const r = lstsq(indices.map(i => { const a = s.theta[i]; return [Math.cos(a), Math.sin(a), Math.sin(2*a), Math.cos(2*a), 1]; }), indices.map(i => s.X[i]));
      return { I, voltage: r.coef[0], coefficients: r.coef, covariance: r.cov, n: indices.length, rss: r.rss, dof: r.dof, cond: r.cond };
    }).sort((a, b) => a.I - b.I);
    const slopes = [0, 1, 2, 3, 4].map(k => {
      // With two current levels use within-level noise to propagate slope uncertainty.
      const x = points.map(p => p.I), y = points.map(p => p.coefficients[k]);
      const xm = x.reduce((a,b)=>a+b,0)/x.length, ym = y.reduce((a,b)=>a+b,0)/y.length;
      const ss = x.reduce((a,v)=>a+(v-xm)**2,0), slope = x.reduce((a,v,i)=>a+(v-xm)*(y[i]-ym),0)/ss;
      const intercept = ym-slope*xm, rss = x.reduce((a,v,i)=>a+(y[i]-intercept-slope*v)**2,0);
      const propagated = points.reduce((a, p) => a + (p.I - xm)**2 * p.covariance[k][k], 0) / ss**2;
      return { slope, intercept, error: Math.sqrt(Math.max(propagated, x.length > 2 ? rss/(x.length-2)/ss : 0)) };
    });
    const rss = points.reduce((a, p) => a + p.rss, 0), dof = points.reduce((a, p) => a + p.dof, 0);
    const fit = { n: points.reduce((a,p) => a + p.n, 0), levels: points.length, rss, dof, rms: Math.sqrt(rss / dof), cond: Math.max(...points.map(p => p.cond)), warnings: [] };
    ['A1', 'D1', 'A2', 'B2c', 'b0'].forEach((name,k) => { fit[name] = slopes[k].slope; fit[name+'_err'] = slopes[k].error; });
    fit.o0 = slopes[4].intercept;
    fit.angularIntercept = slopes.slice(0, 4).map(r => r.intercept);
    if (slopes.some(r=>![r.slope,r.intercept,r.error].every(Number.isFinite))) throw new Error('Current slope is not identifiable. Check current separation and sample units.');
    fit.currentSlope = { points, slope: slopes[0].slope, intercept: slopes[0].intercept, slopeError: slopes[0].error };
    return fit;
  }
  /** Real AC-field detection produces demodulated amplitudes, not angular traces.
   * RMS X: DC-current field detection needs sqrt(2), AC sideband needs 2.
   * Signed X requires an independently calibrated electrical/field reference phase. */
  function fitFieldLockin(s, excitation) {
    if (!['dc', 'ac'].includes(excitation)) throw new Error('Unknown field-lock-in excitation.');
    const groups=new Map(), gain=excitation==='dc'?Math.SQRT2:2;
    usableSamples(s, false).forEach(i => { const I=s.I[i]; if (!groups.has(I)) groups.set(I,[]); groups.get(I).push(s.X[i]*gain); });
    const points=[...groups].map(([I,ys])=>{ const voltage=ys.reduce((a,b)=>a+b,0)/ys.length; return {I,voltage,n:ys.length,variance:ys.length>1?ys.reduce((a,v)=>a+(v-voltage)**2,0)/(ys.length-1)/ys.length:null}; }).sort((a,b)=>a.I-b.I);
    if (!points.length || points.every(p=>p.I===0)) throw new Error('No nonzero-current lock-in samples.');
    if (excitation==='dc' && points.length<2) throw new Error('DC slope requires multiple currents.');
    let slope,intercept,error;
    if (points.length===1) { slope=points[0].voltage/points[0].I; intercept=0; error=points[0].variance === null ? null : Math.sqrt(points[0].variance)/Math.abs(points[0].I); }
    else {
      const xm=points.reduce((a,p)=>a+p.I,0)/points.length, ym=points.reduce((a,p)=>a+p.voltage,0)/points.length;
      const ss=points.reduce((a,p)=>a+(p.I-xm)**2,0);
      slope=points.reduce((a,p)=>a+(p.I-xm)*(p.voltage-ym),0)/ss; intercept=ym-slope*xm;
      const propagated=points.reduce((a,p)=>a+(p.I-xm)**2*p.variance,0)/ss**2;
      const residual=points.reduce((a,p)=>a+(p.voltage-intercept-slope*p.I)**2,0);
      error=points.some(p=>p.variance===null) && points.length<=2 ? null : Math.sqrt(Math.max(propagated, points.length>2?residual/(points.length-2)/ss:0));
    }
    if (!Number.isFinite(slope) || !Number.isFinite(intercept) || (error !== null && !Number.isFinite(error))) throw new Error('Lock-in slope is not identifiable. Check current separation and sample units.');
    return {A1:slope,A1_err:error,D1:null,D1_err:null,A2:null,A2_err:null,B2c:null,b0:null,o0:intercept,
      n:points.reduce((a,p)=>a+p.n,0),levels:points.length,cond:1,rms:Math.sqrt(points.reduce((a,p)=>a+(p.variance || 0)*p.n*(p.n-1),0)/Math.max(1,points.reduce((a,p)=>a+p.n-1,0)))/gain,
      currentSlope:{points,slope,intercept,slopeError:error},
      warnings:['Lock-in amplitude normalization assumes calibrated phase, sinusoidal field and RMS current.', ...(error===null?['Too few repeats to estimate statistical uncertainty.']:[]), ...(points.length===1?['No zero-current level: current-independent pickup was not subtracted.']:[])]};
  }
  function predictVoltage(fit, theta, I) {
    if (!fit || !Number.isFinite(theta) || !Number.isFinite(I)) return null;
    const basis = [Math.cos(theta), Math.sin(theta), Math.sin(2*theta), Math.cos(2*theta)];
    return I * (['A1','D1','A2','B2c'].reduce((a,k,j) => a + (fit[k] || 0) * basis[j], fit.b0 || 0)) + (fit.o0 || 0) + basis.reduce((a,v,j) => a + v * (fit.angularIntercept?.[j] || 0), 0);
  }
  const api = { lstsq, usableSamples, fitHarmonics, fitCurrentSweep, fitFieldLockin, predictVoltage, derive, E_CHARGE };
  if (typeof module !== 'undefined') module.exports = api; else (root.HH = root.HH || {}, Object.assign(root.HH, api));
})(typeof window !== 'undefined' ? window : globalThis);
