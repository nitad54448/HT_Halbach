# HT Halbach

Hall effect measurement UI with a native Rust instrument service. Open `app/index.html` using VS Code Live Server, or host `app/` on GitHub Pages. Hardware access runs locally in Rust; no Python runtime is used.

Start the service from the repository root:

```powershell
powershell -File rust-backend/start.ps1
```

On Devices, enter `http://127.0.0.1:8765` and the pairing token printed by the service. See [Rust setup and supported hardware](rust-backend/README.md) and [UI workflow](app/README.md).
