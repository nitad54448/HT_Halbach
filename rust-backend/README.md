# Native Rust instrument service

The static HTML/JavaScript UI runs in Live Server or GitHub Pages. All hardware communication and real acquisition run in this Rust process on the measurement PC. Browsers cannot load NI-VISA/DAQmx DLLs or control the PS10 COM port directly. There is no Python dependency and no required Tauri desktop shell.

## Start

From the repository root:

```powershell
powershell -File rust-backend/start.ps1
```

The launcher uses the compiled release executable when available, otherwise builds it with Cargo. This checkout also supports the workspace-local Rust toolchain under `.tools/`; a fresh checkout needs Rust installed with rustup. To rebuild after changing Rust sources, run `cargo build --release --manifest-path rust-backend/Cargo.toml` using your installed toolchain. The standalone executable is `rust-backend/target/release/halbach-service.exe`.

Open `app/index.html` using Live Server. On Devices, under Local Rust service, enter `http://127.0.0.1:8765` and the pairing token printed in the service terminal. The token is saved locally in `rust-backend/data/service.token`; the browser keeps it only for the current session and excludes it from exported presets/projects. Starting the service or opening the UI does not operate instruments.

Live Server origins `http://localhost:5500`, `http://127.0.0.1:5500` and ports 5501 are allowed by default. For another port, pass its exact origin:

```powershell
powershell -File rust-backend/start.ps1 -AllowOrigin http://127.0.0.1:5502
```

For GitHub Pages:

```powershell
powershell -File rust-backend/start.ps1 -AllowOrigin https://YOUR-ACCOUNT.github.io
```

Use the origin only, without repository path or trailing slash. Serve the contents of `app/` as the site, or visit `/app/` if publishing the repository root. The Rust service must still run on the PC connected to the instruments. Allow the browser's Local Network Access/loopback permission when prompted; browser policies may restrict access from hosted pages. The UI explicitly requests loopback access. The service listens only on IPv4 loopback and requires both an allowed Origin and a pairing token for hardware requests. Do not publish the token. Optional `-ServeUi` also serves the UI at `http://127.0.0.1:8765`.

## Hardware

Use Windows with NI-VISA matching the executable architecture (this build is 64 bit). The Rust service loads `visa64.dll` dynamically; NI 9361 optical position additionally needs NI-DAQmx (`nicaiu.dll`). Configure the Ethernet cDAQ-9183, NI 9361 counter and encoder wiring in NI MAX first. There are no Python driver wrappers.

Supported acquisition uses OWIS PS10 over COM, Keithley 6220/6221 current sourcing, independent 2182/2182A or a source-linked delta nanovoltmeter, SR830 or Ethernet Ametek 7230 lock-in, and supported Lake Shore temperature devices. Ametek 7230 uses its native TCP protocol on port 50000 and does not require VISA for that connection. Use a hostname/IP, `host:50000`, or VISA-style `TCPIP0::host::50000::SOCKET` address.

Delta verifies the nanovoltmeter through the source, without opening a separate PC interface to it. Reserve the source RS232 connection for the nanovoltmeter; connect the PC using GPIB or supported Ethernet. Physical trigger wiring and bench timing still require commissioning.

Before acquisition, initialize/reference the PS10 using its controller tools and enter calibrated counts per turn and velocity conversion. The service does not automatically home or change stage limits. Rotation is limited to 1.2 Hz. Optical position falls back to verified OWIS position before acquisition when unavailable; encoder failure during acquisition aborts to avoid changing the angular origin. TTL reference checks use the selected timeout and reject loss of lock or the wrong sideband frequency.

The engine implements DC steps/scans, automatic delta reversal, signed current sweeps for AC-field/DC-current fits, sideband acquisition and measured-cycle CHIRP rotation. It validates limits, checks source compliance/temperature/reference faults, switches outputs off after success or failure, and aborts if UI polling stops. Completed and partial projects are saved in `rust-backend/data/`. Keep the terminal open during acquisition; use Abort before closing it. Windows Ctrl+C requests cleanup, although disconnects or stalled native drivers can prevent confirmation.

## Verification

```powershell
cargo test --manifest-path rust-backend/Cargo.toml
```

Tests use fake instruments and a TCP protocol emulator. They cover acquisition, cleanup, limits, fallback, heartbeat, autosave, Ametek framing and HTTP origin/token enforcement, including a GitHub Pages origin. These checks do not replace testing against the actual bench instruments.

Live parameter updates are validated through `/api/update` and take effect at the next program-step boundary. Every run stores the method, sample and hardware settings used. `/api/pause` interrupts acquisition, saves partial raw data and cleans up outputs before reporting `paused`; native sessions are released for connection checks. `/api/resume` revalidates configuration and repeats the interrupted step, restoring the preceding temperature setpoint/stability if applicable. Hardware or method-principle changes require pause; active/completed temperature steps and sequence structure cannot be changed. Browser polling must continue while paused.
