use halbach_instruments::service::{valid_origin, Service};
use std::{collections::HashSet, path::PathBuf, sync::Arc};
#[cfg(windows)]
fn install_shutdown(service: Arc<Service>) -> Result<(), String> {
    static SERVICE: std::sync::OnceLock<Arc<Service>> = std::sync::OnceLock::new();
    unsafe extern "system" fn handler(event: u32) -> i32 {
        if [0, 1, 2, 5, 6].contains(&event) {
            if let Some(s) = SERVICE.get() {
                s.stop();
            }
            1
        } else {
            0
        }
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn SetConsoleCtrlHandler(
            handler: Option<unsafe extern "system" fn(u32) -> i32>,
            add: i32,
        ) -> i32;
    }
    SERVICE
        .set(service)
        .map_err(|_| "Shutdown handler already installed")?;
    if unsafe { SetConsoleCtrlHandler(Some(handler), 1) } == 0 {
        return Err("Cannot install console shutdown handler".into());
    }
    Ok(())
}
#[cfg(not(windows))]
fn install_shutdown(_: Arc<Service>) -> Result<(), String> {
    Ok(())
}

fn run() -> Result<(), String> {
    let mut port = 8765u16;
    let mut origins = HashSet::new();
    let mut ui = None;
    let mut output = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("data");
    let mut token_override = None;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--port" => {
                port = args
                    .next()
                    .ok_or("Missing port")?
                    .parse()
                    .map_err(|_| "Invalid port")?
            }
            "--allow-origin" => {
                let o = args.next().ok_or("Missing origin")?;
                if !valid_origin(&o) {
                    return Err(
                        "Use an exact origin such as https://account.github.io (no path)".into(),
                    );
                }
                origins.insert(o);
            }
            "--ui-dir" => ui = Some(PathBuf::from(args.next().ok_or("Missing UI directory")?)),
            "--data-dir" => output = PathBuf::from(args.next().ok_or("Missing data directory")?),
            "--token" => token_override = Some(args.next().ok_or("Missing token")?),
            "--help" => {
                println!("halbach-service [--port 8765] [--allow-origin https://account.github.io] [--data-dir PATH] [--ui-dir app]\nStart Live Server for app/index.html. Pair its Devices page with this local service token. NI-VISA/DAQmx must match the executable architecture.");
                return Ok(());
            }
            _ => return Err(format!("Unknown argument: {a}")),
        }
    }
    for host in ["localhost", "127.0.0.1"] {
        for p in [5500, 5501, port] {
            origins.insert(format!("http://{host}:{p}"));
        }
    }
    std::fs::create_dir_all(&output).map_err(|e| e.to_string())?;
    let tokenfile = output.join("service.token");
    let token = if let Some(t) = token_override {
        t
    } else {
        match std::fs::read_to_string(&tokenfile) {
            Ok(t) if t.trim().len() >= 32 => t.trim().into(),
            _ => {
                let t = format!(
                    "{:032x}{:032x}",
                    rand::random::<u128>(),
                    rand::random::<u128>()
                );
                std::fs::write(&tokenfile, &t).map_err(|e| e.to_string())?;
                t
            }
        }
    };
    if token.len() < 16 {
        return Err("Pairing token must have at least 16 characters".into());
    }
    let server = tiny_http::Server::http((std::net::Ipv4Addr::LOCALHOST, port))
        .map_err(|e| e.to_string())?;
    let actual = server.server_addr().to_ip().ok_or("No TCP address")?.port();
    let service = Service::new(actual, origins, token, output, ui);
    install_shutdown(service.clone())?;
    println!("Rust hardware service: http://127.0.0.1:{actual}\nPairing token: {}\nOpen the UI in Live Server or GitHub Pages. No instruments are accessed until requested.",service.token);
    service.serve(server)
}
fn main() {
    if let Err(e) = run() {
        eprintln!("{e}");
        std::process::exit(1);
    }
}
