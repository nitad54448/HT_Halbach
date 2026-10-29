# Native Rust instrument service

The static HTML/JavaScript UI runs in Live Server, GitHub Pages, or directly from the local Rust service. All hardware communication and real acquisition run in this Rust process on the measurement PC. Browsers cannot load NI-VISA/DAQmx/LabOne DLLs or control the PS10 COM port directly. There is no Python dependency and no required Tauri desktop shell.

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
  - For GitHub Pages (origin only, no repository path or trailing slash):
    ```powershell
    powershell -File rust-backend/start.ps1 -AllowOrigin https://YOUR-ACCOUNT.github.io
    ```

### 3. Open the UI and Pair with the Service
1. Open `app/index.html` using VS Code Live Server (or visit `http://127.0.0.1:8765` if started with `-ServeUi`, or your GitHub Pages URL).
2. Copy the **Pairing token** printed in the PowerShell terminal (also stored locally in `rust-backend/data/service.token`).
3. In the UI:
   - Tab 1 (**Method**): Select the measurement principle (**DC field**, **AC field**, or **CHIRP**), excitation mode (**DC current** or **AC current**), and angular acquisition (**Steps** or **Scans** for DC field), or load a JSON preset.
   - Tab 2 (**Devices**): Under **Local Rust service**, enter `http://127.0.0.1:8765` and paste the pairing token. Configure the instruments and addresses, then click **CHECK connections**.
4. Once **CHECK connections** succeeds, **Method** and **Devices** become read-only so the validated hardware and measurement principle cannot be altered accidentally. To edit them before a run, click **Stop setup and edit configuration**; during a run, click **Pause** or **Abort**.
5. Tab 3 (**Sample**) & Tab 4 (**Experiment setup**): Enter sample geometry, numerical method parameters (current levels, frequencies, lock-in time constant, TTL timeout, cycles/dwell), and temperature program steps. During a run, edit parameters on **Experiment setup** and click **Apply parameters** to queue them for the next measurement step.

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

- **Live parameter updates (`/api/update`):** Experimental setup parameters and future temperature step parameters can be modified while running and take effect at the next program-step boundary. Active measurements retain their initial settings, and every saved run records the exact method, sample, and hardware snapshot used.
- **Pause and Resume (`/api/pause`, `/api/resume`):** Pausing interrupts the active step, saves partial raw samples, turns off outputs/motion, and releases native sessions so **Method** and **Devices** can be unlocked, edited, and re-verified with **CHECK connections**. Resuming re-validates configuration, restores the preceding temperature setpoint/stability if applicable, and repeats the interrupted step.

## Verification

```powershell
cargo test --manifest-path rust-backend/Cargo.toml
```

Tests use fake instruments and TCP protocol emulators covering acquisition, cleanup, limits, fallback, heartbeat, autosave, Ametek framing, MFLI LabOne command/endpoint handling, live updates, pause/resume, and HTTP origin/token enforcement.
