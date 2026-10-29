use crate::protocol::{AmetekTcp, Device, Hardware, Session, R};
use serde_json::Value;

#[derive(Default)]
pub struct NativeHardware {
    #[cfg(windows)]
    visa: Option<std::sync::Arc<windows::VisaApi>>,
    #[cfg(windows)]
    daq: Option<windows::DaqTask>,
}
impl Hardware for NativeHardware {
    fn open(&mut self, d: &Device) -> R<Box<dyn Session>> {
        if d.model == "AMETEK7230" {
            return Ok(Box::new(AmetekTcp::connect(&d.address)?));
        }
        #[cfg(windows)]
        {
            if self.visa.is_none() {
                self.visa = Some(std::sync::Arc::new(windows::VisaApi::new()?));
            }
            Ok(Box::new(windows::VisaSession::open(
                self.visa.as_ref().unwrap().clone(),
                d,
            )?))
        }
        #[cfg(not(windows))]
        {
            Err("VISA/DAQmx require Windows with the installed NI runtimes".into())
        }
    }
    fn optical(&mut self, d: &Device) -> R<Value> {
        #[cfg(windows)]
        {
            let key = format!(
                "{}|{}|{}",
                d.address,
                d.host.as_deref().unwrap_or(""),
                d.pulses_per_rev.unwrap_or(0)
            );
            if self.daq.as_ref().map(|t| t.key.as_str()) != Some(key.as_str()) {
                self.daq = None;
                self.daq = Some(windows::DaqTask::new(d, key)?);
            }
            self.daq.as_mut().unwrap().read()
        }
        #[cfg(not(windows))]
        {
            let _ = d;
            Err("NI-DAQmx requires Windows".into())
        }
    }
}

#[cfg(windows)]
mod windows {
    use super::*;
    use crate::protocol::number;
    use serde_json::json;
    use std::{
        ffi::{c_char, c_void, CString},
        net::ToSocketAddrs,
        sync::Arc,
    };
    type OpenRm = unsafe extern "system" fn(*mut u32) -> i32;
    type Open = unsafe extern "system" fn(u32, *const c_char, u32, u32, *mut u32) -> i32;
    type Close = unsafe extern "system" fn(u32) -> i32;
    type Attr = unsafe extern "system" fn(u32, u32, usize) -> i32;
    type Write = unsafe extern "system" fn(u32, *const u8, u32, *mut u32) -> i32;
    type Read = unsafe extern "system" fn(u32, *mut u8, u32, *mut u32) -> i32;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn LoadLibraryW(name: *const u16) -> *mut c_void;
        fn GetProcAddress(module: *mut c_void, name: *const c_char) -> *mut c_void;
        fn FreeLibrary(module: *mut c_void) -> i32;
        fn GetLastError() -> u32;
    }
    struct Library(usize);
    impl Library {
        unsafe fn new(name: &str) -> R<Self> {
            let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
            let h = LoadLibraryW(wide.as_ptr());
            if h.is_null() {
                Err(format!(
                    "Cannot load {name} (Windows error {})",
                    GetLastError()
                ))
            } else {
                Ok(Self(h as usize))
            }
        }
    }
    impl Drop for Library {
        fn drop(&mut self) {
            unsafe {
                FreeLibrary(self.0 as *mut c_void);
            }
        }
    }
    unsafe fn symbol<T: Copy>(lib: &Library, name: &[u8]) -> R<T> {
        let p = GetProcAddress(lib.0 as *mut c_void, name.as_ptr().cast());
        if p.is_null() {
            return Err(format!(
                "Missing native symbol {}",
                String::from_utf8_lossy(name)
            ));
        }
        assert_eq!(std::mem::size_of::<T>(), std::mem::size_of_val(&p));
        Ok(std::mem::transmute_copy(&p))
    }
    fn cstring(s: &str) -> R<CString> {
        CString::new(s).map_err(|_| "Embedded NUL".into())
    }
    fn check(code: i32) -> R<()> {
        if code < 0 {
            Err(format!(
                "VISA error 0x{:08X}; check address, power, interface and timeout",
                code as u32
            ))
        } else {
            Ok(())
        }
    }
    pub struct VisaApi {
        _lib: Library,
        rm: u32,
        open: Open,
        close: Close,
        attr: Attr,
        write: Write,
        read: Read,
    }
    impl VisaApi {
        pub fn new() -> R<Self> {
            unsafe {
                let name = if cfg!(target_pointer_width = "64") {
                    "visa64.dll"
                } else {
                    "visa32.dll"
                };
                let lib = Library::new(name).map_err(|e| {
                    format!("Cannot load {name}. Install matching-architecture NI-VISA: {e}")
                })?;
                let open_rm: OpenRm = symbol(&lib, b"viOpenDefaultRM\0")?;
                let open = symbol(&lib, b"viOpen\0")?;
                let close = symbol(&lib, b"viClose\0")?;
                let attr = symbol(&lib, b"viSetAttribute\0")?;
                let write = symbol(&lib, b"viWrite\0")?;
                let read = symbol(&lib, b"viRead\0")?;
                let mut rm = 0;
                check(open_rm(&mut rm))?;
                Ok(Self {
                    _lib: lib,
                    rm,
                    open,
                    close,
                    attr,
                    write,
                    read,
                })
            }
        }
    }
    impl Drop for VisaApi {
        fn drop(&mut self) {
            unsafe {
                (self.close)(self.rm);
            }
        }
    }
    pub struct VisaSession {
        api: Arc<VisaApi>,
        handle: u32,
        ending: u8,
    }
    impl VisaSession {
        pub fn open(api: Arc<VisaApi>, d: &Device) -> R<Self> {
            let mut address = d.address.trim().to_string();
            let upper = address.to_uppercase();
            if let Some(port) = upper.strip_prefix("COM") {
                if !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()) {
                    address = format!("ASRL{port}::INSTR");
                }
            }
            if !["GPIB", "TCPIP", "USB", "ASRL"]
                .iter()
                .any(|p| address.to_uppercase().starts_with(p))
                || !address.contains("::")
            {
                return Err("Use a VISA resource or OWIS COM port".into());
            }
            let addr = cstring(&address)?;
            let mut handle = 0;
            unsafe {
                check((api.open)(api.rm, addr.as_ptr(), 1, 2000, &mut handle))?;
            }
            let s = Self {
                api,
                handle,
                ending: if d.model == "OWISPS10" { 13 } else { 10 },
            };
            s.attr(
                0x3FFF001A,
                if ["K2182", "K2182A"].contains(&d.model.as_str()) {
                    5000
                } else {
                    2000
                },
            )?;
            if address.to_uppercase().starts_with("ASRL") {
                let baud = d.baud.unwrap_or(9600);
                if ![9600, 19200, 38400, 57600, 115200].contains(&baud) {
                    return Err("Unsupported baud rate".into());
                }
                for (a, v) in [
                    (0x3FFF0021, baud as usize),
                    (0x3FFF0022, 8),
                    (0x3FFF0023, 0),
                    (0x3FFF0024, 10),
                    (0x3FFF0025, 0),
                ] {
                    s.attr(a, v)?;
                }
            }
            s.attr(0x3FFF0018, s.ending as usize)?;
            s.attr(0x3FFF0038, 1)?;
            Ok(s)
        }
        fn attr(&self, a: u32, v: usize) -> R<()> {
            unsafe { check((self.api.attr)(self.handle, a, v)) }
        }
    }
    impl Session for VisaSession {
        fn write(&mut self, c: &str) -> R<()> {
            if !c.is_ascii() || c.contains(['\n', '\r', '\0']) {
                return Err("Invalid instrument command".into());
            }
            let mut b = c.as_bytes().to_vec();
            b.push(self.ending);
            let mut n = 0;
            unsafe {
                check((self.api.write)(
                    self.handle,
                    b.as_ptr(),
                    b.len() as u32,
                    &mut n,
                ))?;
            }
            if n as usize != b.len() {
                return Err("Incomplete VISA write".into());
            }
            Ok(())
        }
        fn query(&mut self, c: &str) -> R<String> {
            self.write(c)?;
            let mut b = [0u8; 4096];
            let mut n = 0;
            unsafe {
                check((self.api.read)(self.handle, b.as_mut_ptr(), 4096, &mut n))?;
            }
            if n == 0 || n >= 4096 {
                return Err("Empty or oversized VISA reply".into());
            }
            String::from_utf8(b[..n as usize].to_vec())
                .map(|s| s.trim().into())
                .map_err(|e| e.to_string())
        }
    }
    impl Drop for VisaSession {
        fn drop(&mut self) {
            unsafe {
                (self.api.close)(self.handle);
            }
        }
    }

    type GetString = unsafe extern "system" fn(*const c_char, *mut c_char, u32) -> i32;
    type GetSim = unsafe extern "system" fn(*const c_char, *mut u32) -> i32;
    type Task = *mut c_void;
    type CreateTask = unsafe extern "system" fn(*const c_char, *mut Task) -> i32;
    type Encoder = unsafe extern "system" fn(
        Task,
        *const c_char,
        *const c_char,
        i32,
        u32,
        f64,
        i32,
        i32,
        u32,
        f64,
        *const c_char,
    ) -> i32;
    type TaskAction = unsafe extern "system" fn(Task) -> i32;
    type ReadCounter = unsafe extern "system" fn(Task, f64, *mut f64, *mut c_void) -> i32;
    type ErrorInfo = unsafe extern "system" fn(*mut c_char, u32) -> i32;
    pub struct DaqTask {
        lib: Library,
        handle: usize,
        pub key: String,
        identity: String,
        clear: TaskAction,
        read: ReadCounter,
    }
    impl DaqTask {
        fn check(lib: &Library, code: i32) -> R<()> {
            if code < 0 {
                unsafe {
                    let f: ErrorInfo = symbol(lib, b"DAQmxGetExtendedErrorInfo\0")?;
                    let mut b = [0u8; 2048];
                    f(b.as_mut_ptr().cast(), 2048);
                    let end = b.iter().position(|x| *x == 0).unwrap_or(b.len());
                    Err(format!("DAQmx: {}", String::from_utf8_lossy(&b[..end])))
                }
            } else {
                Ok(())
            }
        }
        fn string(lib: &Library, name: &[u8], device: &str) -> R<String> {
            unsafe {
                let f: GetString = symbol(lib, name)?;
                let mut b = [0u8; 2048];
                let d = cstring(device)?;
                Self::check(lib, f(d.as_ptr(), b.as_mut_ptr().cast(), 2048))?;
                Ok(
                    String::from_utf8_lossy(
                        &b[..b.iter().position(|x| *x == 0).unwrap_or(b.len())],
                    )
                    .into(),
                )
            }
        }
        pub fn new(d: &Device, key: String) -> R<Self> {
            unsafe {
                let lib = Library::new("nicaiu.dll")
                    .map_err(|e| format!("NI-DAQmx runtime unavailable: {e}"))?;
                let module = d.address.split('/').next().ok_or("Missing DAQmx channel")?;
                let channel_part = d.address.split('/').nth(1).ok_or("Use module/ctrN")?;
                if !channel_part.starts_with("ctr")
                    || !channel_part[3..].chars().all(|c| c.is_ascii_digit())
                    || channel_part.len() == 3
                {
                    return Err("Use module/ctrN".into());
                }
                let product = Self::string(&lib, b"DAQmxGetDevProductType\0", module)?;
                if !product.contains("9361") {
                    return Err("Module is not NI 9361".into());
                }
                let chassis = Self::string(&lib, b"DAQmxGetDevCompactDAQChassisDevName\0", module)?;
                if !Self::string(&lib, b"DAQmxGetDevProductType\0", &chassis)?.contains("9183") {
                    return Err("Module is not in cDAQ-9183".into());
                }
                let ip = Self::string(&lib, b"DAQmxGetDevTCPIPAddr\0", &chassis)?;
                let host = d.host.as_deref().ok_or("Missing chassis host")?;
                if !(host, 0)
                    .to_socket_addrs()
                    .map_err(|e| e.to_string())?
                    .any(|a| a.ip().to_string() == ip)
                {
                    return Err("DAQmx chassis host/IP mismatch".into());
                }
                let sim: GetSim = symbol(&lib, b"DAQmxGetDevIsSimulated\0")?;
                let mut simulated = 0;
                let module_c = cstring(module)?;
                Self::check(&lib, sim(module_c.as_ptr(), &mut simulated))?;
                if simulated != 0 {
                    return Err("DAQmx device is simulated".into());
                }
                let ppr = d
                    .pulses_per_rev
                    .filter(|x| *x > 0)
                    .ok_or("Configure encoder pulses per revolution")?;
                let create: CreateTask = symbol(&lib, b"DAQmxCreateTask\0")?;
                let clear: TaskAction = symbol(&lib, b"DAQmxClearTask\0")?;
                let read: ReadCounter = symbol(&lib, b"DAQmxReadCounterScalarF64\0")?;
                let mut handle = std::ptr::null_mut();
                Self::check(&lib, create(c"".as_ptr(), &mut handle))?;
                let task = Self {
                    identity: format!("{product}, {chassis} ({ip}), {}", d.address),
                    lib,
                    handle: handle as usize,
                    key,
                    clear,
                    read,
                };
                let encoder: Encoder = symbol(&task.lib, b"DAQmxCreateCIAngEncoderChan\0")?;
                let channel = cstring(&d.address)?;
                Self::check(
                    &task.lib,
                    encoder(
                        handle,
                        channel.as_ptr(),
                        c"".as_ptr(),
                        10092,
                        0,
                        0.,
                        10040,
                        10146,
                        ppr,
                        0.,
                        c"".as_ptr(),
                    ),
                )?;
                let start: TaskAction = symbol(&task.lib, b"DAQmxStartTask\0")?;
                Self::check(&task.lib, start(handle))?;
                Ok(task)
            }
        }
        pub fn read(&mut self) -> R<Value> {
            unsafe {
                let mut angle = 0.;
                Self::check(
                    &self.lib,
                    (self.read)(self.handle as Task, 1., &mut angle, std::ptr::null_mut()),
                )?;
                number(&angle.to_string())?;
                Ok(json!({"identity":self.identity,"angleDeg":angle,"angleType":"relative"}))
            }
        }
    }
    impl Drop for DaqTask {
        fn drop(&mut self) {
            unsafe {
                (self.clear)(self.handle as Task);
            }
        }
    }
}
