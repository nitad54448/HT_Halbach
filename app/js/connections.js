/* Read-only connection checks. A browser cannot access VISA or DAQmx directly. */
(function (root) {
  'use strict';
  const modes = typeof module !== 'undefined' ? require('./modes.js') : root.HH;
  function motorPosition(h) {
    return {
      role: 'position',
      model: h.magnet.rotator,
      address: (h.magnet.rotator_addr || '').trim(),
      parent: 'motion',
      positionSource: 'owis',
      angleType: 'absolute',
      baud: h.magnet.baud || 9600,
      unit: h.magnet.unit || 1,
      axis: h.magnet.axis || 1,
      term: h.magnet.term || 'crlf',
      countsPerTurn: h.magnet.counts_per_turn,
      angleOffsetDeg: h.magnet.angle_offset_deg || 0,
      dirSign: h.magnet.dir_sign || 1,
    };
  }
  function selectedDevices(p) {
    const h = p.hardware, devices = [];
    const add = (role, model, address, extra) => { if (model) devices.push(Object.assign({ role, model, address: (address || '').trim() }, extra)); };
    add('motion', h.magnet.rotator, h.magnet.rotator_addr, {
      baud: h.magnet.baud || 9600,
      unit: h.magnet.unit || 1,
      axis: h.magnet.axis || 1,
      term: h.magnet.term || 'crlf',
      countsPerTurn: h.magnet.counts_per_turn,
      angleOffsetDeg: h.magnet.angle_offset_deg || 0,
      dirSign: h.magnet.dir_sign || 1,
    });
    if (h.magnet.encoder) add('position', h.magnet.encoder, h.magnet.encoder_addr, { chassis: 'cDAQ-9183', host: h.magnet.host || '', pulsesPerRev: h.magnet.encoder_ppr, positionSource: 'optical', angleType: 'relative' });
    else devices.push(Object.assign(motorPosition(h), { baud: h.magnet.baud || 9600, countsPerTurn: h.magnet.counts_per_turn }));
    add('source', h.source.model, h.source.address);
    if (modes.usesVoltmeter(p.method)) {
      const delta = modes.isDelta(p);
      const voltAddr = delta ? (h.source.address || '').trim() : (h.measure.volt_addr || '').trim();
      add('voltmeter', h.measure.volt, voltAddr,
        { connection: delta ? 'delta' : 'independent', parent: delta ? 'source' : null, sourceModel: h.source.model });
    } else {
      add('lockin1', h.measure.lockin1, h.measure.lockin1_addr, { lockTimeout: p.method.lock_timeout_s });
      add('lockin2', h.measure.lockin2, h.measure.lockin2_addr, { lockTimeout: p.method.lock_timeout_s });
    }
    if (h.temperature !== 'off') add('temperature', h.tempController.model, h.tempController.address);
    return devices;
  }
  function connectionErrors(p) {
    const e = modes.missing(p.hardware, p.method.kind, modes.excitationOf(p.method));
    if (!p.method.kind) e.push('Select a measurement method first');
    const ds = selectedDevices(p), seen = new Map();
    for (const d of ds) {
      // An unavailable external reader is handled by the OWIS fallback below.
      // Delta voltmeter automatically inherits the 6220/6221 source address.
      if (!d.address && d.positionSource !== 'optical' && d.connection !== 'delta') e.push(d.role + ': address/channel is required');
      const key = (d.address || '').toUpperCase();
      if (key && !d.parent) {
        const sharedMfli = d.model === 'MFLI' && ((d.role.startsWith('lockin') && seen.get(key) === 'source' && p.hardware.source.model === 'MFLI') || (d.role === 'source' && String(seen.get(key)).startsWith('lockin')));
        if (seen.has(key) && !sharedMfli) e.push(d.role + ' and ' + seen.get(key) + ' share an address');
        seen.set(key, d.role);
      }
    }
    return e;
  }
  async function checkDevices(p, bridge) {
    const errors = connectionErrors(p);
    if (errors.length) return { ok: false, results: errors.map(message => ({ role: 'Configuration', ok: false, message })) };
    const simulated = p.hardware.backend === 'simulation', results = [];
    let positionSource = null;
    async function probe(d) {
      if (d.positionSource === 'optical' && (!d.address || !d.host.trim())) throw new Error('External encoder channel or cDAQ-9183 host is not configured');
      if (simulated) return 'SIMULATED: ' + d.model + (d.angleType ? ' (' + d.angleType + ' angle)' : '');
      if (!bridge || typeof bridge.checkDevice !== 'function') throw new Error('Rust hardware client unavailable. Reload the page and start the local Rust service.');
      let timer, r;
      try { r = await Promise.race([bridge.checkDevice(d), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Connection check timed out')), 8000); })]); }
      finally { clearTimeout(timer); }
      if (!r || r.ok !== true || !r.identity) throw new Error(r && r.message || 'No verified device identity returned');
      return String(r.identity);
    }
    for (const d of selectedDevices(p)) {
      try {
        const message = await probe(d);
        results.push({ role: d.role, ok: true, message });
        if (d.role === 'position') positionSource = d.positionSource;
      } catch (e) {
        if (d.positionSource === 'optical') {
          results.push({ role: 'External position', ok: true, warning: true, message: e.message + '. Falling back to OWIS absolute angle.' });
          try {
            const message = await probe(Object.assign(motorPosition(p.hardware), { baud: p.hardware.magnet.baud || 9600, countsPerTurn: p.hardware.magnet.counts_per_turn }));
            results.push({ role: 'position', ok: true, message: 'OWIS absolute angle: ' + message });
            positionSource = 'owis';
          } catch (fallbackError) { results.push({ role: 'position', ok: false, message: 'OWIS position unavailable: ' + fallbackError.message }); }
        } else {
          results.push({ role: d.role, ok: false, message: e.message });
        }
      }
    }
    return { ok: results.length > 0 && results.every(r => r.ok), simulated, positionSource, results };
  }
  const api = { selectedDevices, connectionErrors, checkDevices };
  if (typeof module !== 'undefined') module.exports = api;
  else Object.assign(root.HH, api);
})(typeof window !== 'undefined' ? window : globalThis);
