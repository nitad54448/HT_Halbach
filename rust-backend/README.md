# Native Rust instrument service

The static HTML/JavaScript UI runs in Live Server, GitHub Pages, or directly from the local Rust service. All hardware communication and real acquisition run in this Rust process on the measurement PC. Browsers cannot load NI-VISA/DAQmx/LabOne DLLs or control the PS10 COM port directly. There is no Python dependency and no required Tauri desktop shell.

The active build is `rust-backend/Cargo.toml`, with `src/main.rs` as the service entry point. The root `tauri_rust_backend_engine.rs` is an unused reference implementation and is not compiled or launched. The current PS10 implementation sends serial commands through NI-VISA; it does **not** load `ps10.dll`, so that DLL does not belong in a repository folder. Install the controller's serial drivers and NI-VISA on the measurement PC.

The service address and reconnect action are in the UI's top banner. Devices configuration expands in an accordion above live readings; the same readings are available on Run. **+B angle** is the mechanical stage angle corresponding to positive field, normally 0° for this setup. Field angle is `sign × (stage angle − +B angle)`. Saved projects continue to store the equivalent `angle_offset_deg = −sign × +B angle`.

Selecting Keithley 6220 defaults to `GPIB0::6::INSTR`. Loading a project or preset with an empty 6220 address or the previous default alias `6220` replaces that current setup address with `GPIB0::6::INSTR`; other custom addresses and historical acquisition snapshots are preserved. An identity mismatch reports the role, address, expected model and exact `*IDN?` reply, including explicit empty replies. Check the resource/alias and query `*IDN?` in NI MAX before retrying; the service continues to reject a different model.

VISA sessions inspect `VI_ATTR_INTF_TYPE` after opening, so aliases receive the same configuration as full resource strings. GPIB sessions explicitly assert END on writes and terminate reads on EOI, with character termination disabled. Serial sessions retain line termination and configure baud/data/parity/stop bits even when opened by alias. This follows [NI's termination guidance](https://www.ni.com/en/support/documentation/supplemental/06/termination-characters-in-ni-visa.html). The [6220/6221 manual](https://download.tek.com/manual/622x-901-01%20%28C%20-%20Oct%202008%29%28Ref%29.pdf), section 10, specifies LF and EOI for responses. Receiving identity text followed by a read timeout indicates an unfinished transfer; the service continues to reject timed-out replies rather than treating partial readings as complete measurement data. GPIB read errors identify the EOI mode. Native driver tests emulate aliases, resource types, successful identity transfer and partial timeouts without accessing instruments; bench verification remains necessary.

The VISA reader skips up to two blank frames while waiting for the answer to a single command; it does not resend the query. Delta identification sends the voltmeter query once, polls the source's serial buffer for up to two seconds, and removes surrounding XON/XOFF characters and quotes. A nonempty response for a different model is still rejected immediately. Tests cover blank frames, bounded failures, delayed serial replies and the reported 6220/2182A identity strings. These checks do not replace validation on the connected instruments.

Delta setup sends 2182/2182A commands through the 6220/6221 RS-232 bridge (`SYST:COMM:SER:SEND`), without opening a separate PC-to-voltmeter session. A conservative 200 ms host pacing interval separates forwarded setup commands and delta settings. Identification also waits between the serial-presence check, forwarded identity request, serial-buffer reads and subsequent operations. After `SOUR:DELT:ARM`, the service waits 500 ms, then polls `SOUR:DELT:ARM?` every 200 ms for up to 10 seconds before sending `INIT:IMM`. Failure to arm prevents initiation and triggers cleanup. These timing values are application defaults to verify on the bench, not manufacturer-specified minimum delays. Pacing during acquisition setup remains interruptible; Abort/output cleanup is not delayed by this pacing. The existing `SOUR:DELT:DEL 0.1` sets current-polarity settling inside each delta measurement and is separate from host communication pacing. See the [6220/6221 manual](https://download.tek.com/manual/622x-901-01%20%28C%20-%20Oct%202008%29%28Ref%29.pdf), section 5, for the serial bridge and arm-status query.

`0xBFFF0015` is a VISA timeout, not a model mismatch. Errors now distinguish `viOpen` (including the exclusive-lock wait), `viSetAttribute`, `viWrite`, and `viRead`, and identify the device/address. Read failures include the command, timeout and any partial reply. Close NI MAX VISA test panels and other instrument sessions before checking from this app. If MAX identifies the 6220 while this app intermittently times out, do not change the selected model; compare the failing operation and address first.

After Rust edits, stop the existing service with Ctrl+C in its console when instruments are idle, then launch `start-workstation.bat` again so it rebuilds. Refreshing the browser only reloads the UI. The launcher reports an older running release before attempting to rebuild its locked executable.

If the console ignores Ctrl+C, press **Esc** to leave text selection, then try **Ctrl+Break**. The updated service restores Ctrl+C handling inherited from its parent, and its console handler only sets a shutdown flag; cleanup runs outside the handler. Alternatively, run **`stop-workstation.bat`**, or `powershell -File rust-backend/stop.ps1 -Port 8765` for a custom port. This uses the authenticated local shutdown endpoint, aborts an active acquisition through normal cleanup, and waits for the process to exit without force-killing it. A service built before this endpoint was added needs one manual stop and rebuild first. Remote pages cannot request shutdown.

## How to Start the Program

### 1. Prerequisites on the Measurement PC
- **Windows (64-bit)** matching the compiled 64-bit executable.
- **NI-VISA (`visa64.dll`)** for GPIB, USB, or serial instruments (Keithley 6220/6221, Keithley 2182/2182A, SRS SR830, Lake Shore 332/335, OWIS PS10).
- **NI-DAQmx (`nicaiu.dll`)** *(optional)* when using an external optical encoder via NI 9361 in a cDAQ-9183 chassis. Configure the chassis, module, and counter wiring in NI MAX first.
- **Zurich Instruments LabOne (`ziAPI-win64.dll`)** *(optional)* when using a Zurich Instruments MFLI lock-in or signal output. Ensure the LabOne Data Server is running (default port `8004`).

### 2. Start the Local Rust Service
Open PowerShell at the repository root (`HT_Halbach`) and run:

```powershell
powershell -File rust-backend/start.ps1
```

- **How the launcher works:** `rust-backend/start.ps1` runs `rust-backend/target/release/halbach-service.exe` if already compiled; otherwise it builds and runs it via Cargo (falling back to the workspace-local `.tools/` toolchain if system Rust is not in `PATH`).
- **Rebuild after editing Rust sources:**
  ```powershell
  cargo build --release --manifest-path rust-backend/Cargo.toml
  ```
- **Serve the UI directly from the Rust service *(optional)*:**
  ```powershell
  powershell -File rust-backend/start.ps1 -ServeUi
  ```
  Then open `http://127.0.0.1:8765` in your browser.
- **Custom port or origin:**
  - Live Server origins `http://localhost:5500`, `http://127.0.0.1:5500`, and port `5501` are allowed by default.
  - For another local port:
    ```powershell
    powershell -File rust-backend/start.ps1 -AllowOrigin http://127.0.0.1:5502
    ```

### 3. Open the local workstation

Double-click `start-workstation.bat` for automatic startup and browser opening, or use `powershell -File rust-backend/start.ps1 -ServeUi -OpenBrowser`.

Open `http://127.0.0.1:8765` on the measurement PC. The browser requests `/api/session` and authenticates hardware commands automatically. No pairing token is displayed or requested. The session credential remains in browser memory and is excluded from projects and presets. If the service is restarted or connection settings change, use **Reconnect local service**.

Select Method, configure Devices, and click **CHECK connections** before configuring the sample and experiment. Validated hardware settings become read only until setup is released or the program is paused. Start enables outputs and motion; Abort requests cleanup.

The service binds exclusively to `127.0.0.1`. Hardware APIs and `/api/session` require a loopback peer and an absent or explicitly allowed loopback Origin. Remote origins (including GitHub Pages) cannot access instruments even when added with `--allow-origin` or supplied a valid token. That flag is for additional local development origins. Host checks protect the loopback service from DNS rebinding. Session credentials are not embedded in served HTML.

Static copies on GitHub Pages, other computers, or opened directly as files support saved project inspection, fitting, masks, physical properties calculations, exports and reports. Hardware checks, measurement setup and simulation execution are unavailable until a local workstation service is connected.

The launcher rebuilds changed sources before starting; it never silently runs a stale release binary. Stop an existing service before rebuilding the executable on Windows. `-BuildOnly` builds without starting the service.

## Supported Hardware & Addressing

- **Motion & Position:**
  - **OWIS PS10** over serial COM (`COM3` or `ASRL3::INSTR`). Initialize and reference the stage in OWIS software before starting acquisition, and enter calibrated counts per revolution and velocity conversion on Devices. Rotation is capped at `1.2 Hz`.
  - **NI 9361 / cDAQ-9183** optical encoder (`cDAQ1Mod2/ctr0` with chassis host/IP). If unavailable during connection checks, position falls back to the verified OWIS absolute angle; encoder failure mid-run aborts to preserve angular origin.
- **Current Sources:**
  - **Keithley 6220** (DC) and **Keithley 6221** (DC and AC) over GPIB/VISA (`GPIB0::13::INSTR`).
  - **Zurich Instruments MFLI** signal output (AC modes) via LabOne (`dev1234` or `127.0.0.1:8004/dev1234`).
- **Nanovoltmeters (DC field + DC current):**
  - **Keithley 2182 / 2182A** in **Independent** mode (own VISA address) or **Source-linked delta mode** (linked to Keithley 6220/6221 via RS-232 and Trigger Link; only the current source needs a PC VISA connection).
- **Lock-in Amplifiers:**
  - **SRS SR830** over GPIB/serial VISA (`GPIB0::8::INSTR`).
  - **Ametek 7230** over native TCP port `50000` (`192.168.1.100`, `192.168.1.100:50000`, or `TCPIP0::192.168.1.100::50000::SOCKET`, no VISA required).
  - **Zurich Instruments MFLI** over LabOne C API (`ziAPI-win64.dll` talking to LabOne Data Server on port `8004`). Address format: `devXXXX` (e.g. `dev1234` for local Data Server) or `host:8004/devXXXX` (e.g. `192.168.1.50:8004/dev1234`). An MFLI can simultaneously act as AC source and Lock-in 1 using the same device ID.
- **Temperature Control:**
  - **Lake Shore 332 / 335** over GPIB/VISA (`GPIB0::12::INSTR`).

## Runtime Behavior, Live Updates, and Safety

The engine executes DC steps/scans, automatic delta reversal, signed current sweeps for AC-field/DC-current fits, sideband acquisition, and measured-cycle CHIRP rotation. It validates software limits before enabling outputs, monitors source compliance/temperature/reference lock, switches outputs and motion off after completion or fault, and aborts if browser polling stops for more than 15 s. Completed and partial projects are autosaved in `rust-backend/data/`.

- **Live parameter updates (`/api/update`):** Electrical conditions, active thermal parameters, repeat counts, and the future sequence can be modified while running. Electrical conditions and scan targets apply at the next acquisition boundary; active stabilization targets update at the next temperature check. Completed operations and the active operation type are fixed. Future operations can be appended, removed, reordered or replaced. Active measurements retain their initial settings, and every saved run records the exact method, sample, and hardware snapshot used.
- **Pause and Resume (`/api/pause`, `/api/resume`):** Pausing interrupts the active step, saves partial raw samples, turns off outputs/motion, and releases native sessions so **Method** and **Devices** can be unlocked, edited, and re-verified with **CHECK connections**. Resuming re-validates configuration, restores the preceding temperature setpoint/stability if applicable, and restarts an interrupted acquisition while retaining completed repeats.

## Verification

```powershell
cargo test --manifest-path rust-backend/Cargo.toml
```

Tests use fake instruments and TCP protocol emulators covering acquisition, cleanup, limits, fallback, heartbeat, autosave, Ametek framing, MFLI LabOne command/endpoint handling, live updates, pause/resume, and HTTP local-session/origin enforcement.


## Thermal acquisition modes

`measure` accepts optional `repeats` (default 1) and `interval_s` (default 0). `scan` requires temperature control, a continuously acquired electrical method, target `T`, positive `rate`, heater `range`, `endpoint_tol`, and `timeout_s`; `interval_s` is optional. It records complete acquisitions while the measured temperature moves toward the target. Both heating and cooling are supported. Single-current, zero-wait scans keep rotation and excitation enabled across windows when the method requires no delta, interleaved current or background switching. All scan exits and faults clean up outputs and motion.

Acquisition records include `programStep`, `measurement`, `temperatureMode`, `continuousAcquisition`, and time-weighted `temperatureStats`, alongside the original raw samples and method/sample/hardware snapshots. Statistics use adjacent valid temperature samples; missing/masked intervals are excluded. Changing the temperature program does not rewrite earlier runs.

`tempController.minRateKmin` defaults to 0.1. A verified LS335 firmware version 1.4 or later can be configured for 0.001; LS332 remains at least 0.1. Temperature targets, ramp limits, counts, waits, timeouts and method compatibility are validated before commands execute. Simulation and native Rust use the same operation schema. Tests cover repetitions, heating/cooling, persistent excitation/rotation, live target and method changes, future structural edits, temperature averaging, and completed-repeat preservation on resume.
