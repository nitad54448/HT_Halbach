# Halbach Hall workstation (app/)

Open `index.html` in a browser (no build step). Tests: `node test/run.js`.

Workflow tabs (sequential, each unlocks when the previous is valid): Hardware (sub-tabs: Temperature control, Magnet, Current source, Measure) → Mode (only modes the declared instruments support) → Sample → Temperature → Run → Data inspect → Analysis.
Always-available tabs: History, Log (None/Normal/Verbose/Debug), Project & report (save/load JSON, CSV export, print report).

## Status

- **Backend is simulated.** `js/sim.js` generates synthetic CHIRP data and `SimLakeShore` emulates the controller. All simulated runs are tagged `simulated: true` and reports warn about it.
- `js/lakeshore.js` is the real 332/335 driver over an async `{write, query}` transport. Replace `SimLakeShore` with a Tauri-IPC → NI-VISA GPIB transport. Verify the command subset (RANGE, RAMP, RAMPST?, HTR?, SETP, KRDG?) against the 332/335 manuals before connecting hardware.
- Other instruments (current source, lock-in, stage, encoder) are not controlled yet; see `../rust-backend/README.md`.
- Fit assumes plateau data after the post-step mask; it does not model lock-in filter dynamics (guide §7, §9.3 `F[...]`).
