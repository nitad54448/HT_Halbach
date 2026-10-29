# Halbach Hall workstation (app/)

Open `index.html` in a browser (no build step). Tests: `node test/run.js`.

Workflow tabs (sequential, each unlocks when the previous is valid): Hardware (sub-tabs: Temperature control, Magnet, Current source, Measure) → Mode (only modes the declared instruments support) → Sample → Temperature → Run → Data inspect → Analysis.
Always-available tabs: History, Log (None/Normal/Verbose/Debug), Project & report (save/load JSON, CSV export, print report).

## Test mode

The app opens with a complete simulated instrument setup, a test sample, CHIRP selected, and a 295?305 K program ending with heater off. Open Run and click Start program. Simulation speed defaults to Max; select a slower speed to try pause and abort. All measurement modes remain configurable. New project restores this setup; loading a project reconnects the simulated temperature controller without replacing its instrument settings or data.

## Status

- **Backend is simulated.** `js/sim.js` generates synthetic CHIRP data and `SimLakeShore` emulates the controller. All simulated runs are tagged `simulated: true` and reports warn about it.
- `js/lakeshore.js` is the real 332/335 driver over an async `{write, query}` transport. Replace `SimLakeShore` with a Tauri-IPC → NI-VISA GPIB transport. Verify the command subset (RANGE, RAMP, RAMPST?, HTR?, SETP, KRDG?) against the 332/335 manuals before connecting hardware.
- Other instruments (current source, lock-in, stage, encoder) are not controlled yet; see `../rust-backend/README.md`.
- Fit assumes plateau data after the post-step mask; it does not model lock-in filter dynamics (guide §7, §9.3 `F[...]`).

## Temperature program

Set start/end temperature, a positive step size, ramp rate, heater range, instantaneous |?T| limit, mean |?T| limit, stability window and timeout, then append the program. Cooling sweeps are automatic when end < start. Only whole increments are generated (up to 1000 points). Each point waits for stability before acquiring data; the step table allows individual overrides.

Here ?T = measured temperature ? target (K). Stability requires the ramp to finish and every reading to remain within the instantaneous limit for a full window. The time-weighted mean absolute error over that rolling window must also pass the mean limit. Any out-of-band reading resets the window. Mean absolute error prevents positive and negative errors cancelling. Existing project steps without a mean limit retain their previous instantaneous-only criterion. Run displays the current error, window mean and time in band.
