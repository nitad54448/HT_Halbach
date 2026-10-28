# Rust instrument backend foundation

This crate is an early, independent foundation, not a working hardware backend or a Tauri application. It has no third-party dependencies. The existing `tauri_rust_backend_engine.rs` is an old simulation and must not be used to control hardware or treated as real measurement data.

## Current functionality

- Typed inventory and roles for Keithley 6220, 6221 and 2182A; Lake Shore 155 AC; Ametek 7230; Zurich Instruments MFLI; SRS SR830; OWIS PS10; NI 9413; and an NI DAQmx temperature reader.
- Discovery adapter interface with explicit errors and duplicate-identity rejection. No vendor discovery adapter is implemented yet. No device is simulated as discovered.
- Role assignment validation and tentative method candidates. These do not verify reference generation, signal wiring, device options or timing.
- A line-oriented TCP transport for explicitly configured endpoints that actually support that protocol. It is not an implementation of VISA, VXI-11, HiSLIP or LabOne.
- SR830 X/Y snapshot parser using `SNAP? 1,2`, transport-independent. The SR830's GPIB transport and response-interface setup are not implemented.
- Unit tests for parsing, roles and failure behavior. Run `cargo test` from this directory after installing Rust.

## Work required before equipment use

1. Implement NI-VISA GPIB discovery and sessions, with explicit timeouts, device identification and disconnect handling; verify command sets and each device's interface configuration. Two SR830s must have distinct addresses.
2. Implement Lake Shore 155 and Ametek Ethernet transport using their documented protocols, and MFLI through the supported Zurich LabOne API. Do not assume a raw TCP protocol applies to every Ethernet device.
3. Implement OWIS serial discovery and motion using the actual PS10 firmware, axis configuration, stage calibration, travel limits and interlocks.
4. Implement NI-DAQmx discovery and acquisition for the actual cDAQ chassis, position module, encoder wiring, channel mapping, calibration and temperature module. Confirm the model number: NI's published counter-support list includes NI 9411 but does not establish NI 9413 support.
5. Implement device-specific configuration, current limits and output disable, stopping motion, synchronized acquisition, data storage, errors and recovery. Verify current units (peak vs RMS), limits and readbacks per model. Design and test safe failure behavior on the actual bench.
6. Create the Tauri project, IPC commands and permissions; connect discovery results to the UI's `setDiscoveryResults`. Live parameter updates need validated, acknowledged backend commands and an acquisition record of changes. The old simulation's start/stop commands are not suitable.

The [SR830 manual](https://www.thinksrs.com/downloads/pdfs/manuals/SR830m.pdf) documents `SNAP?` and the response interface. The [Keithley 6220/6221 reference manual](https://download.tek.com/manual/622x-901-01%20%28C%20-%20Oct%202008%29%28Ref%29.pdf), [2182A manual](https://download.tek.com/manual/2182A-900-01C_July_2022_User.pdf), [Lake Shore 155 manual](https://www.lakeshore.com/docs/default-source/product-downloads/manuals/155manual.pdf) and [OWIS PS10 manual](https://www.owis.eu/fileadmin/user_upload/PDF-Files/Download_Area/manuals___co/Betriebsanleitungen/PS_10_User_Manual.pdf) are primary sources for future drivers. MFLI requires the [LabOne API](https://docs.zhinst.com/mfli_user_manual/getting_started/device_connectivity_labone.html). Check the [NI counter module support list](https://www.ni.com/en/support/documentation/supplemental/18/cdaq-module-support-for-accessing-on-board-counters.html) against the actual module and chassis.
