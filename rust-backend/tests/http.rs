use halbach_instruments::service::{local_origin, valid_origin, Service};
use std::{
    collections::HashSet,
    io::{Read, Write},
    net::TcpStream,
    path::PathBuf,
    time::Duration,
};
use tiny_http::Server;
fn request(
    port: u16,
    method: &str,
    path: &str,
    origin: &str,
    token: Option<&str>,
    host: Option<&str>,
    body: &str,
) -> String {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    write!(s,"{method} {path} HTTP/1.1\r\nHost: {}\r\nOrigin: {origin}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n",host.map(String::from).unwrap_or(format!("127.0.0.1:{port}")),body.len()).unwrap();
    if let Some(t) = token {
        write!(s, "X-Halbach-Token: {t}\r\n").unwrap();
    }
    write!(s, "\r\n{body}").unwrap();
    let mut r = String::new();
    s.read_to_string(&mut r).unwrap();
    r
}
#[test]
fn origin_and_token_policy() {
    let s = Service::new(
        8765,
        HashSet::from(["https://lab.github.io".into()]),
        "0123456789abcdef".into(),
        PathBuf::new(),
        None,
    );
    assert!(s.allowed_origin(Some("https://lab.github.io")));
    assert!(!s.allowed_origin(Some("https://evil.github.io")));
    assert!(!s.authorized(""));
    assert!(s.authorized("0123456789abcdef"));
    assert!(!valid_origin("https://lab.github.io/path"));
    assert!(local_origin("http://127.0.0.1:5501"));
    assert!(local_origin("http://localhost:8765"));
    assert!(local_origin("http://[::1]:5500"));
    for origin in [
        "null",
        "http://localhost.evil:5501",
        "http://127.0.0.1.evil",
        "https://lab.github.io",
        "http://localhost:0",
    ] {
        assert!(!local_origin(origin));
    }
}
#[test]
fn cors_preflight_and_pairing_over_http() {
    let server = Server::http("127.0.0.1:0").unwrap();
    let port = server.server_addr().to_ip().unwrap().port();
    let token = "test-pairing-token-123456";
    let service = Service::new(
        port,
        HashSet::from([
            "http://127.0.0.1:5501".into(),
            "https://lab.github.io".into(),
        ]),
        token.into(),
        PathBuf::new(),
        Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../app")),
    );
    let worker = service.clone();
    let t = std::thread::spawn(move || worker.serve(server).unwrap());
    let r = request(
        port,
        "OPTIONS",
        "/api/check",
        "https://lab.github.io",
        None,
        None,
        "",
    );
    assert!(r.contains("204"));
    assert!(r
        .to_lowercase()
        .contains("access-control-allow-origin: https://lab.github.io"));
    let r = request(
        port,
        "GET",
        "/api/health",
        "http://127.0.0.1:5501",
        None,
        None,
        "",
    );
    assert!(r.contains("\"backend\":\"rust\""));
    let r = request(
        port,
        "POST",
        "/api/check",
        "https://lab.github.io",
        None,
        None,
        "{}",
    );
    assert!(r.contains("403"));
    let r = request(
        port,
        "POST",
        "/api/check",
        "https://evil.example",
        Some(token),
        None,
        "{}",
    );
    assert!(r.contains("403"));
    assert!(!r.to_lowercase().contains("access-control-allow-origin:"));
    let r = request(
        port,
        "POST",
        "/api/run",
        "https://lab.github.io",
        Some(token),
        None,
        "{\"project\":{}}",
    );
    assert!(
        r.contains("403"),
        "Even a valid token cannot enable hardware for a remote page"
    );
    let r = request(
        port,
        "GET",
        "/api/session",
        "https://lab.github.io",
        Some(token),
        None,
        "",
    );
    assert!(r.contains("403") && !r.contains(token));
    let r = request(
        port,
        "GET",
        "/api/session",
        "http://127.0.0.1:5501",
        None,
        None,
        "",
    );
    assert!(r.contains("200") && r.contains(token) && r.contains("workstation"));
    let r = request(
        port,
        "POST",
        "/api/run",
        "http://127.0.0.1:5501",
        Some(token),
        None,
        "{\"project\":{}}",
    );
    assert!(
        r.contains("400"),
        "Local authenticated requests reach project validation"
    );
    let r = request(
        port,
        "POST",
        "/api/run",
        "http://127.0.0.1:5501",
        None,
        None,
        "{\"project\":{}}",
    );
    assert!(
        r.contains("403"),
        "Local commands still require the automatic session credential"
    );
    let r = request(
        port,
        "GET",
        "/index.html",
        "http://127.0.0.1:5501",
        None,
        None,
        "",
    );
    assert!(
        r.contains("__HALBACH_SERVICE__") && !r.contains(token),
        "HTML contains no credential"
    );
    let r = request(
        port,
        "GET",
        "/api/health",
        "https://lab.github.io",
        None,
        Some("evil.example"),
        "",
    );
    assert!(r.contains("403"));
    service.stop();
    t.join().unwrap();
}
