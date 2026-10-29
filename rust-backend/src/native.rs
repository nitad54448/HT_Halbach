use crate::protocol::{mfli_endpoint, AmetekTcp, Device, Hardware, Session, R};
use serde_json::Value;

#[derive(Default)]
pub struct NativeHardware {
    #[cfg(windows)]
    visa: Option<std::sync::Arc<windows::VisaApi>>,
    #[cfg(windows)]
    zi: Option<std::sync::Arc<windows::ZiApi>>,
    #[cfg(windows)]
    daq: Option<windows::DaqTask>,
}
impl Hardware for NativeHardware {
    fn open(&mut self, d: &Device) -> R<Box<dyn Session>> {
        if d.model == "AMETEK7230" {
            return Ok(Box::new(AmetekTcp::connect(&d.address)?));
        }
        if d.model == "MFLI" {
            let _ = mfli_endpoint(&d.address)?;
            #[cfg(windows)]
            {
                if self.zi.is_none() {
                    self.zi = Some(std::sync::Arc::new(windows::ZiApi::new()?));
                }
                return Ok(Box::new(windows::ZiSession::open(
                    self.zi.as_ref().unwrap().clone(),
                    d,
                )?));
            }
            #[cfg(not(windows))]
            {
                return Err("LabOne ziAPI requires Windows with installed LabOne C API".into());
            }
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

    type ZiConn = *mut c_void;
    type ZiInit = unsafe extern "C" fn(*mut ZiConn) -> i32;
    type ZiDestroy = unsafe extern "C" fn(ZiConn) -> i32;
    type ZiConnectEx = unsafe extern "C" fn(ZiConn, *const c_char, u16, u32, *const c_char) -> i32;
    type ZiDisconnect = unsafe extern "C" fn(ZiConn) -> i32;
    type ZiGetDemod = unsafe extern "C" fn(ZiConn, *const c_char, *mut ZiDemodSample) -> i32;
    type ZiGetDouble = unsafe extern "C" fn(ZiConn, *const c_char, *mut f64) -> i32;
    type ZiSetDouble = unsafe extern "C" fn(ZiConn, *const c_char, f64) -> i32;
    type ZiGetInt = unsafe extern "C" fn(ZiConn, *const c_char, *mut i64) -> i32;
    type ZiSetInt = unsafe extern "C" fn(ZiConn, *const c_char, i64) -> i32;
    type ZiGetBytes =
        unsafe extern "C" fn(ZiConn, *const c_char, *mut u8, *mut u32, u32) -> i32;
    type ZiGetError = unsafe extern "C" fn(i32, *mut *const c_char, *mut i32) -> i32;

    #[repr(C)]
    #[derive(Default)]
    struct ZiDemodSample {
        time_stamp: u64,
        x: f64,
        y: f64,
        frequency: f64,
        phase: f64,
        dio_bits: u32,
        trigger: u32,
        aux_in0: f64,
        aux_in1: f64,
    }

    pub struct ZiApi {
        _lib: Library,
        init: ZiInit,
        destroy: ZiDestroy,
        connect_ex: ZiConnectEx,
        disconnect: ZiDisconnect,
        get_demod: ZiGetDemod,
        get_double: ZiGetDouble,
        set_double: ZiSetDouble,
        get_int: ZiGetInt,
        set_int: ZiSetInt,
        get_bytes: ZiGetBytes,
        get_error: ZiGetError,
    }
    impl ZiApi {
        pub fn new() -> R<Self> {
            unsafe {
                let candidates = if cfg!(target_pointer_width = "64") {
                    &[
                        "ziAPI-win64.dll",
                        "LabOneAPI.dll",
                        r"C:\Program Files\Zurich Instruments\LabOne\API\C\lib\ziAPI-win64.dll",
                    ][..]
                } else {
                    &[
                        "ziAPI-win32.dll",
                        "LabOneAPI.dll",
                        r"C:\Program Files (x86)\Zurich Instruments\LabOne\API\C\lib\ziAPI-win32.dll",
                    ][..]
                };
                let mut last_err = String::new();
                let mut loaded = None;
                for name in candidates {
                    match Library::new(name) {
                        Ok(l) => {
                            loaded = Some(l);
                            break;
                        }
                        Err(e) => last_err = e,
                    }
                }
                let lib = loaded.ok_or_else(|| {
                    format!(
                        "Cannot load Zurich Instruments LabOne C API (ziAPI-win64.dll). Install LabOne matching executable architecture: {last_err}"
                    )
                })?;
                Ok(Self {
                    init: symbol(&lib, b"ziAPIInit\0")?,
                    destroy: symbol(&lib, b"ziAPIDestroy\0")?,
                    connect_ex: symbol(&lib, b"ziAPIConnectEx\0")?,
                    disconnect: symbol(&lib, b"ziAPIDisconnect\0")?,
                    get_demod: symbol(&lib, b"ziAPIGetDemodSample\0")?,
                    get_double: symbol(&lib, b"ziAPIGetValueD\0")?,
                    set_double: symbol(&lib, b"ziAPISetValueD\0")?,
                    get_int: symbol(&lib, b"ziAPIGetValueI\0")?,
                    set_int: symbol(&lib, b"ziAPISetValueI\0")?,
                    get_bytes: symbol(&lib, b"ziAPIGetValueB\0")?,
                    get_error: symbol(&lib, b"ziAPIGetError\0")?,
                    _lib: lib,
                })
            }
        }
        fn check(&self, code: i32) -> R<()> {
            if code == 0 {
                return Ok(());
            }
            unsafe {
                let mut buf: *const c_char = std::ptr::null();
                if (self.get_error)(code, &mut buf, std::ptr::null_mut()) == 0 && !buf.is_null() {
                    let msg = std::ffi::CStr::from_ptr(buf).to_string_lossy();
                    return Err(format!("LabOne error {code}: {msg}"));
                }
            }
            Err(format!("LabOne error 0x{:08X}", code as u32))
        }
    }

    pub struct ZiSession {
        api: Arc<ZiApi>,
        conn: usize,
        dev: String,
    }
    impl ZiSession {
        pub fn open(api: Arc<ZiApi>, d: &Device) -> R<Self> {
            let (host, port, dev) = mfli_endpoint(&d.address)?;
            let mut conn: ZiConn = std::ptr::null_mut();
            unsafe {
                api.check((api.init)(&mut conn))?;
            }
            let s = Self {
                api,
                conn: conn as usize,
                dev,
            };
            let host_c = cstring(&host)?;
            unsafe {
                s.api.check((s.api.connect_ex)(
                    s.conn as ZiConn,
                    host_c.as_ptr(),
                    port,
                    6,
                    std::ptr::null(),
                ))?;
            }
            Ok(s)
        }
        fn path(&self, suffix: &str) -> R<CString> {
            cstring(&format!("/{}/{suffix}", self.dev))
        }
        fn get_d(&self, suffix: &str) -> R<f64> {
            let p = self.path(suffix)?;
            let mut v = 0.;
            unsafe {
                self.api
                    .check((self.api.get_double)(self.conn as ZiConn, p.as_ptr(), &mut v))?;
            }
            number(&v.to_string())
        }
        fn set_d(&self, suffix: &str, v: f64) -> R<()> {
            let p = self.path(suffix)?;
            unsafe {
                self.api
                    .check((self.api.set_double)(self.conn as ZiConn, p.as_ptr(), v))
            }
        }
        fn get_i(&self, suffix: &str) -> R<i64> {
            let p = self.path(suffix)?;
            let mut v = 0i64;
            unsafe {
                self.api
                    .check((self.api.get_int)(self.conn as ZiConn, p.as_ptr(), &mut v))?;
            }
            Ok(v)
        }
        fn set_i(&self, suffix: &str, v: i64) -> R<()> {
            let p = self.path(suffix)?;
            unsafe {
                self.api
                    .check((self.api.set_int)(self.conn as ZiConn, p.as_ptr(), v))
            }
        }
        fn get_s(&self, suffix: &str) -> R<String> {
            let p = self.path(suffix)?;
            let mut b = [0u8; 256];
            let mut len = 0u32;
            unsafe {
                self.api.check((self.api.get_bytes)(
                    self.conn as ZiConn,
                    p.as_ptr(),
                    b.as_mut_ptr(),
                    &mut len,
                    b.len() as u32,
                ))?;
            }
            let end = b[..(len as usize).min(b.len())]
                .iter()
                .position(|x| *x == 0)
                .unwrap_or((len as usize).min(b.len()));
            Ok(String::from_utf8_lossy(&b[..end]).trim().into())
        }
        fn sample(&self) -> R<ZiDemodSample> {
            let p = self.path("demods/0/sample")?;
            let mut s = ZiDemodSample::default();
            unsafe {
                self.api
                    .check((self.api.get_demod)(self.conn as ZiConn, p.as_ptr(), &mut s))?;
            }
            number(&s.x.to_string())?;
            number(&s.y.to_string())?;
            number(&s.frequency.to_string())?;
            Ok(s)
        }
    }
    impl Session for ZiSession {
        fn write(&mut self, c: &str) -> R<()> {
            if let Some(v) = c.strip_prefix("TC ") {
                return self.set_d("demods/0/tc", number(v)?);
            }
            if let Some(v) = c.strip_prefix("SOUR:WAVE:AMPL ") {
                let amp = number(v)?;
                self.set_i("sigouts/0/enables/0", 1)?;
                return self.set_d("sigouts/0/amplitudes/0", amp);
            }
            if let Some(v) = c.strip_prefix("SOUR:WAVE:FREQ ") {
                return self.set_d("oscs/0/freq", number(v)?);
            }
            if c.starts_with("SOUR:CURR:COMP ") {
                return Ok(());
            }
            match c {
                "DEMOD:HARM 1" => self.set_i("demods/0/harmonic", 1),
                "EXTREF:AUTOMODE 4" => self.set_i("extrefs/0/automode", 4),
                "EXTREF:ENABLE 1" => self.set_i("extrefs/0/enable", 1),
                "DEMOD:ENABLE 1" => self.set_i("demods/0/enable", 1),
                "SIGIN:ON 1" => self.set_i("sigins/0/on", 1),
                "DEMOD:ADC 0" => self.set_i("demods/0/adcselect", 0),
                "OUTP OFF" | "SOUR:SWE:ABOR" | "SOUR:WAVE:ABOR" => {
                    let _ = self.set_d("sigouts/0/amplitudes/0", 0.);
                    self.set_i("sigouts/0/on", 0)
                }
                "SOUR:WAVE:FUNC SIN" | "SOUR:WAVE:OFFS 0" | "SOUR:WAVE:ARM" => Ok(()),
                "SOUR:WAVE:INIT" | "OUTP ON" => self.set_i("sigouts/0/on", 1),
                _ => Err(format!("Unsupported MFLI command: {c}")),
            }
        }
        fn query(&mut self, c: &str) -> R<String> {
            match c {
                "*IDN?" => {
                    let devtype = self
                        .get_s("features/devtype")
                        .unwrap_or_else(|_| "MFLI".into());
                    if !devtype.to_uppercase().contains("MFLI") {
                        return Err(format!("Expected MFLI, LabOne reported {devtype}"));
                    }
                    Ok(format!(
                        "Zurich Instruments,{devtype},{},LabOne",
                        self.dev.to_uppercase()
                    ))
                }
                "TC?" => Ok(self.get_d("demods/0/tc")?.to_string()),
                "LOCKED?" => Ok(self.get_i("extrefs/0/locked")?.to_string()),
                "FREQ?" => Ok(self.sample()?.frequency.to_string()),
                "XY?" => {
                    let s = self.sample()?;
                    Ok(format!("{},{}", s.x, s.y))
                }
                "SIGIN:ON?" => Ok(self.get_i("sigins/0/on")?.to_string()),
                "DEMOD:ENABLE?" => Ok(self.get_i("demods/0/enable")?.to_string()),
                "SYST:ERR?" => Ok("0,No error".into()),
                "STAT:MEAS?" | "STAT:MEAS:COND?" => {
                    let over = self.get_i("sigouts/0/over").unwrap_or(0);
                    Ok(if over != 0 { "8" } else { "0" }.into())
                }
                _ => Err(format!("Unsupported MFLI query: {c}")),
            }
        }
    }
    impl Drop for ZiSession {
        fn drop(&mut self) {
            unsafe {
                let _ = (self.api.disconnect)(self.conn as ZiConn);
                let _ = (self.api.destroy)(self.conn as ZiConn);
            }
        }
    }
}
