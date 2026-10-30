/* Minimal canvas plotter. series: [{x[], y[], color, kind:'line'|'points', label}] */
(function (root) {
  'use strict';
  function nice(min, max, n) {
    if (!(max > min)) { max = min + 1; }
    const raw = (max - min) / n, p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
    const step = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p, out = [];
    for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(+v.toPrecision(12));
    return out;
  }
  function fmt(v) { const a = Math.abs(v); return a !== 0 && (a < 1e-3 || a >= 1e5) ? v.toExponential(3) : +v.toPrecision(4) + ''; }
  function plot(canvas, series, o) {
    o = o || {};
    const dpr = (root.devicePixelRatio || 1), W = canvas.clientWidth || (o.print ? canvas.width : 640), H = canvas.clientHeight || (o.print ? canvas.height : 280);
    canvas.width = W * dpr; canvas.height = H * dpr;
    const g = canvas.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const txt = o.print ? '#000' : '#91a3b5', grid = o.print ? '#ddd' : '#223140';
    g.fillStyle = o.print ? '#fff' : '#0d1721'; g.fillRect(0, 0, W, H);
    const m = { l: 62, r: 14, t: 12, b: 38 };
    let xs = [Infinity, -Infinity], ys = [Infinity, -Infinity];
    for (const s of series) for (let i = 0; i < s.x.length; i++) {
      const x = s.x[i], y = s.y[i]; if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (x < xs[0]) xs[0] = x; if (x > xs[1]) xs[1] = x; if (y < ys[0]) ys[0] = y; if (y > ys[1]) ys[1] = y;
    }
    if (!isFinite(xs[0])) { g.fillStyle = txt; g.fillText('No data', W / 2 - 20, H / 2); return o.print ? canvas.toDataURL('image/png') : undefined; }
    if (o.xmin !== undefined) xs[0] = o.xmin; if (o.xmax !== undefined) xs[1] = o.xmax;
    const pad = (ys[1] - ys[0]) * 0.06 || Math.abs(ys[0]) * 0.1 || 1; ys = [ys[0] - pad, ys[1] + pad];
    if (xs[1] === xs[0]) xs = [xs[0] - 1, xs[1] + 1];
    const X = x => m.l + (x - xs[0]) / (xs[1] - xs[0]) * (W - m.l - m.r), Y = y => H - m.b - (y - ys[0]) / (ys[1] - ys[0]) * (H - m.t - m.b);
    g.font = '11px system-ui'; g.lineWidth = 1;
    for (const v of nice(ys[0], ys[1], 5)) { g.strokeStyle = grid; g.beginPath(); g.moveTo(m.l, Y(v)); g.lineTo(W - m.r, Y(v)); g.stroke(); g.fillStyle = txt; g.textAlign = 'right'; g.fillText(fmt(v), m.l - 5, Y(v) + 4); }
    for (const v of nice(xs[0], xs[1], 7).filter(v=>!o.integerX || Number.isInteger(v))) { g.strokeStyle = grid; g.beginPath(); g.moveTo(X(v), m.t); g.lineTo(X(v), H - m.b); g.stroke(); g.fillStyle = txt; g.textAlign = 'center'; g.fillText(fmt(v), X(v), H - m.b + 14); }
    g.fillStyle = txt; g.textAlign = 'center'; if (o.xlabel) g.fillText(o.xlabel, (m.l + W - m.r) / 2, H - 6);
    if (o.ylabel) { g.save(); g.translate(12, (m.t + H - m.b) / 2); g.rotate(-Math.PI / 2); g.fillText(o.ylabel, 0, 0); g.restore(); }
    g.save(); g.beginPath(); g.rect(m.l, m.t, W - m.l - m.r, H - m.t - m.b); g.clip();
    for (const s of series) {
      g.strokeStyle = g.fillStyle = s.color || '#66d6ce';
      const n = s.x.length, stride = Math.max(1, Math.ceil(n / 4000));
      if (s.kind === 'points') { for (let i = 0; i < n; i += stride) { if (Number.isFinite(s.x[i]) && Number.isFinite(s.y[i])) g.fillRect(X(s.x[i]) - 1.5, Y(s.y[i]) - 1.5, 3, 3); } }
      else { g.lineWidth = 1.5; g.beginPath(); let pen = false; for (let i = 0; i < n; i += stride) { if (!Number.isFinite(s.x[i]) || !Number.isFinite(s.y[i])) { pen = false; continue; } pen ? g.lineTo(X(s.x[i]), Y(s.y[i])) : g.moveTo(X(s.x[i]), Y(s.y[i])); pen = true; } g.stroke(); }
    }
    g.restore();
    if (o.print) return canvas.toDataURL('image/png');
  }
  root.HH = root.HH || {}; root.HH.plot = plot;
})(typeof window !== 'undefined' ? window : globalThis);
