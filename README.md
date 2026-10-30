# Halbach Physical Properties Workstation

A local measurement workstation for Hall transport measurements in a rotating Halbach field, with a Rust instrument service and a browser interface for acquisition, project inspection and physical properties analysis.

## Start on the measurement PC

Double-click `start-workstation.bat`. The launcher builds changed Rust sources, starts the service on `http://127.0.0.1:8765`, and opens the browser after the service is ready. The browser obtains its local session automatically; no token entry is required. Stop an older running service before rebuilding it.

Only the computer running the Rust service can control its instruments. The service binds to loopback, checks the request host and origin, and authenticates every hardware command with the automatic session credential. Hosted pages, including GitHub Pages, cannot obtain a hardware session or send instrument commands, even with a saved token.

## Open on another computer

Open the static app from GitHub Pages, a local web server, or `app/index.html`. Without a connected local workstation it opens in analysis mode. Use **Open project**, or drop a `.hallproj.json` file, to inspect existing measurements. Method setup, instrument checks, simulation execution and acquisition are unavailable in this mode. Project settings cannot unlock acquisition.

## Temperature and acquisition programs

Use stabilized temperature steps with a measurement count at each point, or slow heating/cooling scans that acquire during temperature evolution. Supported single-current modes keep excitation and rotation active between saved windows. Every run records its measured temperature mean/range and acquisition conditions. Edit active parameters and the future sequence during a run, then apply them at acquisition boundaries.

## Analyze measurements

- Inspect raw voltages, angular fits, current slopes, residuals and excluded samples.
- Recalculate saved runs from raw data; historical cached fits are not trusted.
- Correct thickness, field, tilt and independently measured sheet resistance per run while preserving acquisition metadata.
- Review Hall coefficient, sheet and bulk carrier density, Hall mobility, resistivity, statistical uncertainties and fit warnings.
- Plot by temperature or run number, and distinguish measured from simulated results.
- Save the updated project, export all raw samples or full-precision result CSVs, and print a report.

Physical properties use the geometry and sign conventions in [the CHIRP guide](README%20-%20Chirp.md). The app does not infer longitudinal resistance from transverse voltage. Mobility needs an independent sheet resistance. Statistical uncertainties exclude calibration, geometry, filter dynamics and model uncertainty. Instrument timing and phase must be validated on the bench.

See [instrument setup](rust-backend/README.md) and [the UI workflow](app/README.md) for hardware requirements and measurement configuration.

## Verification

```powershell
cargo test --manifest-path rust-backend/Cargo.toml
node app/test/run.js
node app/test/modes.js
node app/test/connections.js
node app/test/analysis.js
node app/test/backend.js
node app/test/temperature.js
```

For installed-Chrome browser tests, build the debug Rust binary, then run `node app/test/browser.js`. The suite starts an isolated service on port 18865 and stops it afterward. Override `HALBACH_TEST_URL` to use an already-running test service, or `CHROME_BIN` to choose a browser. The browser suite uses simulated data and fake acquisition responses, without accessing physical instruments.
