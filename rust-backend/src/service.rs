use crate::{
    engine::{self, Job},
    instruments,
    native::NativeHardware,
    protocol::{Device, Hardware, R},
};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    io::Read,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tiny_http::{Header, Request, Response, Server, StatusCode};

pub struct Service {
    pub port: u16,
    pub origins: HashSet<String>,
    pub token: String,
    hardware: Arc<Mutex<Box<dyn Hardware>>>,
    job: Mutex<Option<Arc<Job>>>,
    output: PathBuf,
    ui: Option<PathBuf>,
    shutdown: AtomicBool,
}
impl Service {
    pub fn new(
        port: u16,
        origins: HashSet<String>,
        token: String,
        output: PathBuf,
        ui: Option<PathBuf>,
    ) -> Arc<Self> {
        Arc::new(Self {
            port,
            origins,
            token,
            hardware: Arc::new(Mutex::new(Box::new(NativeHardware::default()))),
            job: Mutex::new(None),
            output,
            ui,
            shutdown: AtomicBool::new(false),
        })
    }
    pub fn stop(&self) {
        self.shutdown.store(true, Ordering::SeqCst);
        if let Some(j) = self.job.lock().unwrap().as_ref() {
            j.abort.store(true, Ordering::SeqCst);
        }
    }
    pub fn allowed_origin(&self, origin: Option<&str>) -> bool {
        origin.is_none_or(|o| self.origins.contains(o))
    }
    pub fn authorized(&self, token: &str) -> bool {
        let a = self.token.as_bytes();
        let b = token.as_bytes();
        let mut difference = a.len() ^ b.len();
        for (i, x) in a.iter().enumerate() {
            difference |= (*x ^ b.get(i).copied().unwrap_or(0)) as usize;
        }
        difference == 0
    }
    fn busy(&self) -> bool {
        self.job
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|j| !j.done.load(Ordering::SeqCst))
    }
    pub fn dispatch(&self, path: &str, data: Value) -> R<Value> {
        match path {
            "/api/run" => {
                let mut active = self.job.lock().map_err(|_| "Job lock poisoned")?;
                if active
                    .as_ref()
                    .is_some_and(|j| !j.done.load(Ordering::SeqCst))
                {
                    return Err("An acquisition is already running".into());
                }
                let j = engine::launch(
                    self.hardware.clone(),
                    data["project"].clone(),
                    self.output.clone(),
                )?;
                let result = json!({"id":j.id});
                *active = Some(j);
                Ok(result)
            }
            "/api/status" | "/api/abort" | "/api/pause" | "/api/resume" | "/api/update" => {
                let active = self.job.lock().map_err(|_| "Job lock poisoned")?;
                let j = active.as_ref().ok_or("Unknown job")?;
                if data["id"].as_str() != Some(j.id.as_str()) {
                    return Err("Unknown job".into());
                }
                if path == "/api/abort" {
                    j.abort.store(true, Ordering::SeqCst);
                }
                if path == "/api/pause" {
                    j.pause.store(true, Ordering::SeqCst);
                }
                if path == "/api/update" {
                    j.update(data["project"].clone())?;
                }
                if path == "/api/resume" {
                    if j.state.lock().unwrap().state != "paused" {
                        return Err("Program is not paused".into());
                    }
                    j.update(data["project"].clone())?;
                    j.pause.store(false, Ordering::SeqCst);
                }
                Ok(j.status(data["cursor"].as_u64().unwrap_or(0) as usize))
            }
            "/api/check" | "/api/read" | "/api/lock" => {
                if self.busy()
                    && !self
                        .job
                        .lock()
                        .unwrap()
                        .as_ref()
                        .is_some_and(|j| j.state.lock().unwrap().state == "paused")
                {
                    return Err("Hardware is busy with an acquisition".into());
                }
                let d: Device = serde_json::from_value(data).map_err(|e| e.to_string())?;
                let mut hw = self.hardware.lock().map_err(|_| "Hardware lock poisoned")?;
                match path {
                    "/api/check" => instruments::check(hw.as_mut(), &d),
                    "/api/read" => instruments::read(hw.as_mut(), &d),
                    _ => instruments::wait_reference(hw.as_mut(), &d),
                }
            }
            _ => Err("Unknown API endpoint".into()),
        }
    }
    pub fn serve(self: &Arc<Self>, server: Server) -> R<()> {
        while !self.shutdown.load(Ordering::SeqCst) {
            if let Some(request) = server
                .recv_timeout(Duration::from_millis(100))
                .map_err(|e| e.to_string())?
            {
                let service = self.clone();
                std::thread::spawn(move || service.handle(request));
            }
        }
        self.stop();
        let deadline = Instant::now() + Duration::from_secs(20);
        while self.busy() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(100));
        }
        if self.busy() {
            eprintln!("Native driver did not complete cleanup; check bench outputs.");
        }
        Ok(())
    }
    fn handle(&self, mut request: Request) {
        let header = |name: &'static str| {
            request
                .headers()
                .iter()
                .find(|h| h.field.equiv(name))
                .map(|h| h.value.as_str().to_string())
        };
        let origin = header("Origin");
        let host = header("Host").unwrap_or_default();
        let token = header("X-Halbach-Token").unwrap_or_default();
        let host_ok = [
            format!("127.0.0.1:{}", self.port),
            format!("localhost:{}", self.port),
        ]
        .contains(&host);
        if !host_ok || !self.allowed_origin(origin.as_deref()) {
            self.reply(request,403,json!({"error":"Origin/Host is not authorized. Add this exact frontend origin with --allow-origin."}),None);
            return;
        }
        let method = request.method().as_str().to_string();
        let path = request.url().to_string();
        if method == "OPTIONS" {
            self.reply(request, 204, json!(null), origin.as_deref());
            return;
        }
        if method == "GET" && path == "/api/health" {
            self.reply(request,200,json!({"ok":true,"backend":"rust","busy":self.busy(),"version":env!("CARGO_PKG_VERSION")}),origin.as_deref());
            return;
        }
        if method == "GET" && !path.starts_with("/api/") {
            self.static_file(request, &path, origin.as_deref());
            return;
        }
        if method != "POST" {
            self.reply(
                request,
                404,
                json!({"error":"Unknown endpoint"}),
                origin.as_deref(),
            );
            return;
        }
        if !self.authorized(&token) {
            self.reply(request,403,json!({"error":"Pairing token is missing or incorrect. Paste the local Rust service token on Devices."}),origin.as_deref());
            return;
        }
        let mut body = Vec::new();
        let result = (|| {
            request
                .as_reader()
                .take(65_537)
                .read_to_end(&mut body)
                .map_err(|e| e.to_string())?;
            if body.is_empty() || body.len() > 65_536 {
                return Err("Invalid request size".into());
            }
            let data = serde_json::from_slice(&body).map_err(|e| e.to_string())?;
            self.dispatch(&path, data)
        })();
        match result {
            Ok(data) => self.reply(request, 200, data, origin.as_deref()),
            Err(e) => self.reply(request, 400, json!({"error":e}), origin.as_deref()),
        }
    }
    fn cors(&self, origin: Option<&str>) -> Vec<Header> {
        let mut h = vec![
            Header::from_bytes("Cache-Control", "no-store").unwrap(),
            Header::from_bytes("Vary", "Origin").unwrap(),
        ];
        if let Some(o) = origin {
            h.push(Header::from_bytes("Access-Control-Allow-Origin", o).unwrap());
            h.push(
                Header::from_bytes("Access-Control-Allow-Methods", "GET, POST, OPTIONS").unwrap(),
            );
            h.push(
                Header::from_bytes(
                    "Access-Control-Allow-Headers",
                    "Content-Type, X-Halbach-Token",
                )
                .unwrap(),
            );
        }
        h
    }
    fn reply(&self, request: Request, status: u16, data: Value, origin: Option<&str>) {
        let mut r = Response::from_string(data.to_string())
            .with_status_code(StatusCode(status))
            .with_header(Header::from_bytes("Content-Type", "application/json").unwrap());
        for h in self.cors(origin) {
            r.add_header(h);
        }
        let _ = request.respond(r);
    }
    fn static_file(&self, request: Request, path: &str, origin: Option<&str>) {
        let result: R<(Vec<u8>, &'static str)> = (|| {
            let root=self.ui.as_ref().ok_or("The UI is served by Live Server/GitHub Pages; use /api/health for service health")?.canonicalize().map_err(|e|e.to_string())?;
            let relative = path.split('?').next().unwrap_or("").trim_start_matches('/');
            let relative = if relative.is_empty() {
                "index.html"
            } else {
                relative
            };
            let file = root
                .join(relative)
                .canonicalize()
                .map_err(|e| e.to_string())?;
            if !file.starts_with(&root) || !file.is_file() {
                return Err("Invalid static path".into());
            }
            let mime = match file.extension().and_then(|s| s.to_str()).unwrap_or("") {
                "html" => "text/html; charset=utf-8",
                "js" => "application/javascript",
                "css" => "text/css",
                "json" => "application/json",
                _ => "application/octet-stream",
            };
            Ok((std::fs::read(&file).map_err(|e| e.to_string())?, mime))
        })();
        match result {
            Ok((body, mime)) => {
                let mut r = Response::from_data(body)
                    .with_header(Header::from_bytes("Content-Type", mime).unwrap());
                for h in self.cors(origin) {
                    r.add_header(h);
                }
                let _ = request.respond(r);
            }
            Err(e) => self.reply(request, 404, json!({"error":e}), origin),
        }
    }
}
pub fn valid_origin(o: &str) -> bool {
    let rest = o
        .strip_prefix("https://")
        .or_else(|| o.strip_prefix("http://"));
    rest.is_some_and(|r| {
        !r.is_empty()
            && !r.contains(['/', '?', '#', '@', '\r', '\n'])
            && r.chars()
                .all(|c| c.is_ascii_alphanumeric() || ".-:[]".contains(c))
    })
}
