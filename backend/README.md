# Backend moved to Rust

All instrument communication and acquisition now live in [rust-backend](../rust-backend/README.md). The Python implementation has been removed.

Run `powershell -File rust-backend/start.ps1` from the repository root, then open `app/index.html` through Live Server or GitHub Pages. `backend/start.ps1` remains a compatibility launcher for the Rust service.
