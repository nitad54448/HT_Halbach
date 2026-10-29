use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};

pub type R<T> = Result<T, String>;
pub fn number(s: &str) -> R<f64> {
    let n: f64 = s
        .trim()
        .parse()
        .map_err(|_| format!("Invalid numeric reply: {s}"))?;
    if !n.is_finite() || n.abs() >= 9e36 {
        return Err("Non-finite or overrange reading".into());
    }
    Ok(n)
}
pub fn num(v: &Value) -> R<f64> {
    v.as_f64()
        .filter(|x| x.is_finite() && x.abs() < 9e36)
        .ok_or_else(|| "Expected a finite number".into())
}
pub fn text(v: &Value) -> R<&str> {
    v.as_str().ok_or_else(|| "Expected text".into())
}
pub fn register(s: &str) -> R<u32> {
    let s = s.trim().to_uppercase();
    let result = match s.get(..2) {
        Some("#B") => u32::from_str_radix(&s[2..], 2),
        Some("#H") => u32::from_str_radix(&s[2..], 16),
        Some("#Q") => u32::from_str_radix(&s[2..], 8),
        _ => s.parse(),
    };
    result.map_err(|_| "Invalid status register".into())
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub role: String,
    pub model: String,
    pub address: String,
    #[serde(default)]
    pub baud: Option<u32>,
    #[serde(default)]
    pub position_source: Option<String>,
    #[serde(default)]
    pub angle_type: Option<String>,
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub pulses_per_rev: Option<u32>,
    #[serde(default)]
    pub counts_per_turn: Option<f64>,
    #[serde(default)]
    pub connection: Option<String>,
    #[serde(default)]
    pub source_model: Option<String>,
    #[serde(default)]
    pub input: Option<String>,
    #[serde(default)]
    pub lock_timeout: Option<f64>,
}

pub trait Session: Send {
    fn write(&mut self, command: &str) -> R<()>;
    fn query(&mut self, command: &str) -> R<String>;
    fn status(&self) -> (u8, u8) {
        (0, 0)
    }
}
pub trait Hardware: Send {
    fn open(&mut self, d: &Device) -> R<Box<dyn Session>>;
    fn optical(&mut self, d: &Device) -> R<Value>;
}

pub fn ametek_endpoint(address: &str) -> R<(String, u16)> {
    let a = address.trim();
    let host = if a.to_uppercase().starts_with("TCPIP") {
        let p: Vec<_> = a.split("::").collect();
        if p.len() != 4 || p[2] != "50000" || !p[3].eq_ignore_ascii_case("SOCKET") {
            return Err("Use TCPIP0::host::50000::SOCKET".into());
        }
        p[1]
    } else {
        let a = a.strip_prefix("tcp://").unwrap_or(a);
        let p: Vec<_> = a.split(':').collect();
        if p.len() > 2 || (p.len() == 2 && p[1] != "50000") {
            return Err("Ametek uses Ethernet port 50000".into());
        }
        p[0]
    };
    if host.is_empty()
        || !host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
    {
        return Err("Invalid Ametek host".into());
    }
    Ok((host.into(), 50000))
}
pub struct AmetekTcp {
    stream: TcpStream,
    status: u8,
    overload: u8,
}
impl AmetekTcp {
    pub fn connect(address: &str) -> R<Self> {
        let (host, port) = ametek_endpoint(address)?;
        let addr = (host.as_str(), port)
            .to_socket_addrs()
            .map_err(|e| e.to_string())?
            .next()
            .ok_or("Host not found")?;
        let stream =
            TcpStream::connect_timeout(&addr, Duration::from_secs(2)).map_err(|e| e.to_string())?;
        stream
            .set_write_timeout(Some(Duration::from_secs(2)))
            .map_err(|e| e.to_string())?;
        Ok(Self {
            stream,
            status: 0,
            overload: 0,
        })
    }
    fn exchange(&mut self, c: &str) -> R<String> {
        if c.contains(['\0', '\r', '\n', ';']) {
            return Err("Expected one Ametek command".into());
        }
        self.stream
            .write_all(format!("{c}\0").as_bytes())
            .map_err(|e| e.to_string())?;
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut data = Vec::new();
        loop {
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .ok_or("Ametek reply timed out")?;
            self.stream
                .set_read_timeout(Some(remaining))
                .map_err(|e| e.to_string())?;
            let mut b = [0u8; 4096];
            let n = self.stream.read(&mut b).map_err(|e| e.to_string())?;
            if n == 0 {
                return Err("Ametek closed an incomplete reply".into());
            }
            data.extend_from_slice(&b[..n]);
            if data.len() > 8192 {
                return Err("Oversized Ametek reply".into());
            }
            if let Some(end) = data.iter().position(|b| *b == 0) {
                if data.len() < end + 3 {
                    continue;
                }
                if data.len() != end + 3 {
                    return Err("Unexpected Ametek trailing bytes".into());
                }
                self.status = data[end + 1];
                self.overload = data[end + 2];
                if self.status & 6 != 0 {
                    return Err(format!("Ametek rejected command: {c}"));
                }
                return String::from_utf8(data[..end].to_vec())
                    .map(|s| s.trim().into())
                    .map_err(|e| e.to_string());
            }
        }
    }
}
impl Session for AmetekTcp {
    fn query(&mut self, c: &str) -> R<String> {
        self.exchange(c)
    }
    fn write(&mut self, c: &str) -> R<()> {
        self.exchange(c).map(|_| ())
    }
    fn status(&self) -> (u8, u8) {
        (self.status, self.overload)
    }
}

pub fn mfli_endpoint(address: &str) -> R<(String, u16, String)> {
    let a = address.trim();
    let parse_dev = |s: &str| -> R<String> {
        let d = s.trim().trim_matches('/').to_lowercase();
        let rest = d
            .strip_prefix("dev")
            .ok_or("MFLI device ID must be devXXXX (e.g. dev1234)")?;
        if rest.is_empty() || !rest.chars().all(|c| c.is_ascii_alphanumeric()) {
            return Err("MFLI device ID must be devXXXX (e.g. dev1234)".into());
        }
        Ok(d)
    };
    let check_host = |h: &str| -> R<String> {
        if h.is_empty()
            || !h
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
        {
            return Err("Invalid MFLI host".into());
        }
        Ok(h.to_string())
    };
    let check_port = |p: &str| -> R<u16> {
        p.parse::<u16>()
            .ok()
            .filter(|v| *v > 0)
            .ok_or_else(|| "Invalid MFLI LabOne Data Server port".into())
    };
    if a.to_uppercase().starts_with("TCPIP") {
        let p: Vec<_> = a.split("::").collect();
        if p.len() == 4 && p[3].eq_ignore_ascii_case("SOCKET") {
            let hp: Vec<_> = p[1].split('/').collect();
            let dev = if hp.len() == 2 {
                parse_dev(hp[1])?
            } else if p[1].to_lowercase().starts_with("dev") {
                parse_dev(p[1])?
            } else {
                return Err("Specify MFLI device ID as host:8004/devXXXX or devXXXX".into());
            };
            let host = if hp.len() == 2 {
                check_host(hp[0])?
            } else {
                "127.0.0.1".into()
            };
            return Ok((host, check_port(p[2])?, dev));
        }
        return Err("Use devXXXX or host:8004/devXXXX for MFLI".into());
    }
    let a = a.strip_prefix("tcp://").unwrap_or(a);
    if let Some((hp, dev_str)) = a.split_once('/') {
        let dev = parse_dev(dev_str)?;
        let parts: Vec<_> = hp.split(':').collect();
        if parts.len() > 2 {
            return Err("Use host:8004/devXXXX for MFLI".into());
        }
        let host = check_host(parts[0])?;
        let port = if parts.len() == 2 {
            check_port(parts[1])?
        } else {
            8004
        };
        return Ok((host, port, dev));
    }
    let parts: Vec<_> = a.split(':').collect();
    if parts.len() == 1 && parts[0].to_lowercase().starts_with("dev") {
        return Ok(("127.0.0.1".into(), 8004, parse_dev(parts[0])?));
    }
    if parts.len() == 2 && parts[0].to_lowercase().starts_with("dev") {
        return Ok((
            "127.0.0.1".into(),
            check_port(parts[1])?,
            parse_dev(parts[0])?,
        ));
    }
    if parts.len() == 2 && parts[1].to_lowercase().starts_with("dev") {
        return Ok((check_host(parts[0])?, 8004, parse_dev(parts[1])?));
    }
    if parts.len() == 3 && parts[2].to_lowercase().starts_with("dev") {
        return Ok((
            check_host(parts[0])?,
            check_port(parts[1])?,
            parse_dev(parts[2])?,
        ));
    }
    Err("Use devXXXX or host:8004/devXXXX for MFLI".into())
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum LockInKind {
    Sr830,
    Ametek7230,
    Mfli,
}
pub struct LockIn {
    pub session: Box<dyn Session>,
    kind: LockInKind,
}
impl LockIn {
    pub fn new(mut session: Box<dyn Session>, d: &Device) -> R<Self> {
        let kind = match d.model.as_str() {
            "SR830" => LockInKind::Sr830,
            "AMETEK7230" => LockInKind::Ametek7230,
            "MFLI" => LockInKind::Mfli,
            _ => return Err("Unsupported lock-in".into()),
        };
        if kind == LockInKind::Sr830 {
            session.write(
                if d.address.to_uppercase().starts_with("ASRL")
                    || d.address.to_uppercase().starts_with("COM")
                {
                    "OUTX 0"
                } else {
                    "OUTX 1"
                },
            )?;
        }
        Ok(Self { session, kind })
    }
    pub fn identify(&mut self) -> R<String> {
        match self.kind {
            LockInKind::Ametek7230 => {
                let id = self.session.query("ID")?;
                if id != "7230" {
                    return Err(format!("Expected 7230, got {id}"));
                }
                Ok("AMETEK SIGNAL RECOVERY 7230".into())
            }
            LockInKind::Mfli => {
                let id = self.session.query("*IDN?")?;
                if !id.to_uppercase().contains("MFLI") {
                    return Err(format!("Expected MFLI, got {id}"));
                }
                Ok(id)
            }
            LockInKind::Sr830 => {
                let id = self.session.query("*IDN?")?;
                if id.split(',').nth(1).unwrap_or("").trim() != "SR830" {
                    return Err(format!("Expected SR830, got {id}"));
                }
                Ok(id)
            }
        }
    }
    pub fn reference(&mut self) -> R<()> {
        let commands: &[&str] = match self.kind {
            LockInKind::Ametek7230 => &["REFMODE 0", "VRLOCK 0", "IE 1", "REFN 1"],
            LockInKind::Mfli => &[
                "DEMOD:HARM 1",
                "EXTREF:AUTOMODE 4",
                "EXTREF:ENABLE 1",
                "DEMOD:ENABLE 1",
            ],
            LockInKind::Sr830 => &["FMOD 0", "RSLP 1", "HARM 1"],
        };
        for c in commands {
            self.session.write(c)?;
        }
        Ok(())
    }
    pub fn configure(&mut self, seconds: f64) -> R<f64> {
        if !seconds.is_finite() || seconds <= 0. {
            return Err("Invalid time constant".into());
        }
        self.reference()?;
        if self.kind == LockInKind::Mfli {
            if seconds > 1000. {
                return Err("Time constant exceeds instrument range".into());
            }
            for c in ["SIGIN:ON 1", "DEMOD:ADC 0"] {
                self.session.write(c)?;
            }
            self.session.write(&format!("TC {seconds}"))?;
            let actual = number(&self.session.query("TC?")?)?;
            if actual <= 0. {
                return Err("Invalid time constant readback".into());
            }
            return Ok(actual);
        }
        let mut constants = Vec::new();
        for e in -5..5 {
            for v in if self.kind == LockInKind::Ametek7230 {
                &[1., 2., 5.][..]
            } else {
                &[1., 3.][..]
            } {
                constants.push(v * 10f64.powi(e));
            }
        }
        if self.kind == LockInKind::Ametek7230 {
            constants.push(100000.);
            for c in ["IMODE 0", "NOISEMODE 0", "SYNC 0", "DD 44"] {
                self.session.write(c)?;
            }
        }
        let index = constants
            .iter()
            .position(|v| *v >= seconds)
            .ok_or("Time constant exceeds instrument range")?;
        self.session.write(&format!(
            "{} {index}",
            if self.kind == LockInKind::Ametek7230 {
                "TC"
            } else {
                "OFLT"
            }
        ))?;
        let actual = if self.kind == LockInKind::Ametek7230 {
            number(&self.session.query("TC.")?)?
        } else {
            constants[index]
        };
        if actual <= 0. {
            return Err("Invalid time constant readback".into());
        }
        Ok(actual)
    }
    pub fn clear_unlock(&mut self) -> R<()> {
        if self.kind == LockInKind::Sr830 {
            self.session.query("LIAS? 3")?;
        }
        Ok(())
    }
    pub fn unlocked(&mut self) -> R<bool> {
        match self.kind {
            LockInKind::Ametek7230 => Ok(register(&self.session.query("ST")?)? & 8 != 0),
            LockInKind::Mfli => Ok(register(&self.session.query("LOCKED?")?)? == 0),
            LockInKind::Sr830 => Ok(register(&self.session.query("LIAS? 3")?)? != 0),
        }
    }
    pub fn frequency(&mut self) -> R<f64> {
        number(&self.session.query(match self.kind {
            LockInKind::Ametek7230 => "FRQ.",
            LockInKind::Mfli => "FREQ?",
            LockInKind::Sr830 => "FREQ?",
        })?)
    }
    pub fn read_xy(&mut self) -> R<(f64, f64)> {
        match self.kind {
            LockInKind::Ametek7230 => {
                if self.session.query("IMODE")? != "0" || self.session.query("REFMODE")? != "0" {
                    return Err("Ametek must use voltage input and single reference".into());
                }
                if self.session.query("VMODE")? == "0" {
                    return Err("Ametek voltage input is grounded; select the wired input".into());
                }
            }
            LockInKind::Mfli => {
                if self.session.query("SIGIN:ON?")? != "1"
                    || self.session.query("DEMOD:ENABLE?")? != "1"
                {
                    return Err(
                        "MFLI Signal Input 1 and Demodulator 1 must remain enabled".into(),
                    );
                }
            }
            LockInKind::Sr830 => (),
        }
        let raw = self.session.query(match self.kind {
            LockInKind::Ametek7230 => "XY.",
            LockInKind::Mfli => "XY?",
            LockInKind::Sr830 => "SNAP? 1,2",
        })?;
        let (status, overload) = self.session.status();
        if self.kind == LockInKind::Ametek7230 && (status & 88 != 0 || overload != 0) {
            return Err("Ametek overload or reference unlock".into());
        }
        let p: Vec<_> = raw.split(',').collect();
        if p.len() != 2 {
            return Err("Expected two lock-in voltages".into());
        }
        Ok((number(p[0])?, number(p[1])?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::BufRead, net::TcpListener};
    #[test]
    fn fragmented_ametek_frames_and_setter_ack() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let t = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut reader = std::io::BufReader::new(s.try_clone().unwrap());
            for (command, body) in [("IE 1", ""), ("ID", "7230"), ("XY.", "1.2E-6,-2.5E-6")] {
                let mut c = Vec::new();
                reader.read_until(0, &mut c).unwrap();
                assert_eq!(c, format!("{command}\0").as_bytes());
                s.write_all(body.as_bytes()).unwrap();
                s.write_all(&[0]).unwrap();
                s.write_all(&[1, 0]).unwrap();
            }
        });
        let stream = TcpStream::connect(addr).unwrap();
        let mut s = AmetekTcp {
            stream,
            status: 0,
            overload: 0,
        };
        s.write("IE 1").unwrap();
        assert_eq!(s.query("ID").unwrap(), "7230");
        assert_eq!(s.query("XY.").unwrap(), "1.2E-6,-2.5E-6");
        assert_eq!(s.status(), (1, 0));
        t.join().unwrap();
    }
    #[test]
    fn ametek_rejects_command_errors() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let t = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut b = [0; 32];
            s.read(&mut b).unwrap();
            s.write_all(&[0, 3, 0]).unwrap();
        });
        let mut s = AmetekTcp {
            stream: TcpStream::connect(addr).unwrap(),
            status: 0,
            overload: 0,
        };
        assert!(s.query("BAD").unwrap_err().contains("rejected"));
        t.join().unwrap();
    }
}
