//! Native Rust hardware core. Connection checks do not enable instrument outputs.
//! Real execution, cleanup and autosave are implemented in the engine module.
pub mod engine;
pub mod instruments;
pub mod native;
pub mod protocol;
pub mod service;
use std::collections::HashSet;
use std::fmt;
use std::io::{self, BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Model {
    Keithley6220,
    Keithley6221,
    Keithley2182A,
    LakeShore155Ac,
    Ametek7230,
    ZurichMfli,
    Srs830,
    OwisPs10,
    Ni9361,
    NiDaqTemperature,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Role {
    CurrentSource,
    Voltmeter,
    LockIn,
    Motion,
    Position,
    Temperature,
}
impl Model {
    pub fn role(self) -> Role {
        match self {
            Self::Keithley6220 | Self::Keithley6221 | Self::LakeShore155Ac => Role::CurrentSource,
            Self::Keithley2182A => Role::Voltmeter,
            Self::Ametek7230 | Self::ZurichMfli | Self::Srs830 => Role::LockIn,
            Self::OwisPs10 => Role::Motion,
            Self::Ni9361 => Role::Position,
            Self::NiDaqTemperature => Role::Temperature,
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::Keithley6220 => "Keithley 6220",
            Self::Keithley6221 => "Keithley 6221",
            Self::Keithley2182A => "Keithley 2182A",
            Self::LakeShore155Ac => "Lake Shore 155 AC",
            Self::Ametek7230 => "Ametek 7230",
            Self::ZurichMfli => "Zurich Instruments MFLI",
            Self::Srs830 => "SRS SR830",
            Self::OwisPs10 => "OWIS PS10",
            Self::Ni9361 => "NI 9361",
            Self::NiDaqTemperature => "NI DAQmx temperature reader",
        }
    }
    pub fn supports_ac_current(self) -> bool {
        matches!(self, Self::Keithley6221 | Self::LakeShore155Ac)
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiscoveredDevice {
    pub id: String,
    pub model: Model,
    pub address: String,
}

#[derive(Debug)]
pub enum Error {
    Io(io::Error),
    Protocol(String),
    Unsupported(&'static str),
    Invalid(String),
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(e) => write!(f, "I/O: {e}"),
            Self::Protocol(e) => write!(f, "Protocol: {e}"),
            Self::Unsupported(e) => write!(f, "Not implemented: {e}"),
            Self::Invalid(e) => write!(f, "Invalid: {e}"),
        }
    }
}
impl std::error::Error for Error {}
impl From<io::Error> for Error {
    fn from(e: io::Error) -> Self {
        Self::Io(e)
    }
}
pub type Result<T> = std::result::Result<T, Error>;

/// Transport implementations must set timeouts, enforce exclusive access and delimit replies.
pub trait QueryTransport: Send {
    fn query(&mut self, command: &str) -> Result<String>;
}
/// Explicitly configured TCP endpoint, only for instruments documented to use line-oriented TCP.
/// This is not a VISA, VXI-11, HiSLIP, LabOne, GPIB, or DAQmx implementation.
pub struct LineTcp {
    stream: BufReader<TcpStream>,
}
impl LineTcp {
    pub fn connect(address: SocketAddr, timeout: Duration) -> Result<Self> {
        if timeout.is_zero() {
            return Err(Error::Invalid("timeout must be nonzero".into()));
        }
        let stream = TcpStream::connect_timeout(&address, timeout)?;
        stream.set_read_timeout(Some(timeout))?;
        stream.set_write_timeout(Some(timeout))?;
        Ok(Self {
            stream: BufReader::new(stream),
        })
    }
}
impl QueryTransport for LineTcp {
    fn query(&mut self, command: &str) -> Result<String> {
        if command.contains('\n') || command.contains('\r') {
            return Err(Error::Invalid("embedded line ending".into()));
        }
        let stream = self.stream.get_mut();
        stream.write_all(command.as_bytes())?;
        stream.write_all(b"\n")?;
        stream.flush()?;
        let mut response = String::new();
        // Bound the reply; an absent terminator or oversized response is an error.
        let read = self.stream.by_ref().take(4097).read_line(&mut response)?;
        if read == 0 || read > 4096 || !response.ends_with('\n') {
            return Err(Error::Protocol("incomplete or oversized response".into()));
        }
        Ok(response.trim_end_matches(&['\r', '\n'][..]).to_string())
    }
}
use std::io::Read;

/// Coherent X/Y snapshot on an SR830. Configure its response interface separately as
/// documented by SRS; this operation does not change the reference or sensitivity.
pub struct Sr830<T> {
    transport: T,
}
impl<T: QueryTransport> Sr830<T> {
    pub fn new(transport: T) -> Self {
        Self { transport }
    }
    pub fn read_xy(&mut self) -> Result<(f64, f64)> {
        let reply = self.transport.query("SNAP? 1,2")?;
        let parts: Vec<_> = reply.trim().split(',').collect();
        if parts.len() != 2 {
            return Err(Error::Protocol("SR830 expected two values".into()));
        }
        let parse = |s: &str| -> Result<f64> {
            let n: f64 = s
                .trim()
                .parse()
                .map_err(|_| Error::Protocol("invalid SR830 value".into()))?;
            if !n.is_finite() {
                return Err(Error::Protocol("non-finite SR830 value".into()));
            }
            Ok(n)
        };
        Ok((parse(parts[0])?, parse(parts[1])?))
    }
}

/// Discovery is supplied by independent vendor adapters. Failures remain visible; an
/// empty result is not a substitute for a failed adapter.
pub trait DiscoveryAdapter {
    fn name(&self) -> &'static str;
    fn discover(&mut self) -> Result<Vec<DiscoveredDevice>>;
}
pub struct DiscoveryReport {
    pub devices: Vec<DiscoveredDevice>,
    pub errors: Vec<String>,
}
pub fn discover(adapters: &mut [&mut dyn DiscoveryAdapter]) -> DiscoveryReport {
    let mut report = DiscoveryReport {
        devices: Vec::new(),
        errors: Vec::new(),
    };
    let mut ids = HashSet::new();
    for adapter in adapters {
        match adapter.discover() {
            Ok(found) => {
                for device in found {
                    if device.id.is_empty()
                        || device.address.is_empty()
                        || !ids.insert(device.id.clone())
                    {
                        report.errors.push(format!(
                            "{}: invalid or duplicate device identity",
                            adapter.name()
                        ));
                    } else {
                        report.devices.push(device);
                    }
                }
            }
            Err(e) => report.errors.push(format!("{}: {e}", adapter.name())),
        }
    }
    report
}
/// Placeholder adapters return a failure, never invented hardware.
pub struct UnavailableAdapter(pub &'static str);
impl DiscoveryAdapter for UnavailableAdapter {
    fn name(&self) -> &'static str {
        self.0
    }
    fn discover(&mut self) -> Result<Vec<DiscoveredDevice>> {
        Err(Error::Unsupported("vendor discovery adapter"))
    }
}

#[derive(Default, Debug)]
pub struct Assignments {
    pub source: Option<String>,
    pub voltmeter: Option<String>,
    pub lockin: Option<String>,
    pub lockin2: Option<String>,
    pub motor: Option<String>,
    pub position: Option<String>,
    pub temperature: Option<String>,
}
#[derive(Default, Debug, PartialEq, Eq)]
pub struct MethodCandidates {
    pub fixed_dc: bool,
    pub fixed_ac: bool,
    pub rotating_dc: bool,
    pub rotating_ac: bool,
    pub chirp: bool,
}
/// Proposals only: reference generation, actual device features and wiring still require verification.
pub fn method_candidates(
    devices: &[DiscoveredDevice],
    assignments: &Assignments,
) -> Result<MethodCandidates> {
    let mut used = HashSet::new();
    let mut resolve = |id: &Option<String>, role: Role| -> Result<Option<Model>> {
        let Some(id) = id else { return Ok(None) };
        if !used.insert(id.clone()) {
            return Err(Error::Invalid("a device is assigned more than once".into()));
        }
        let device = devices
            .iter()
            .find(|d| &d.id == id)
            .ok_or_else(|| Error::Invalid(format!("device {id} is not discovered")))?;
        if device.model.role() != role {
            return Err(Error::Invalid(format!("wrong role for {id}")));
        }
        Ok(Some(device.model))
    };
    let source = resolve(&assignments.source, Role::CurrentSource)?;
    let volt = resolve(&assignments.voltmeter, Role::Voltmeter)?;
    let lock = resolve(&assignments.lockin, Role::LockIn)?;
    let lock2 = resolve(&assignments.lockin2, Role::LockIn)?;
    let motor = resolve(&assignments.motor, Role::Motion)?;
    let position = resolve(&assignments.position, Role::Position)?;
    resolve(&assignments.temperature, Role::Temperature)?;
    let base = source.is_some()
        && motor.is_some()
        && (position.is_some() || motor == Some(Model::OwisPs10));
    let has_lock = lock.is_some() || lock2.is_some();
    let ac = source.map(Model::supports_ac_current).unwrap_or(false);
    let ac_lock = base && ac && has_lock;
    Ok(MethodCandidates {
        fixed_dc: base && volt.is_some(),
        fixed_ac: ac_lock,
        rotating_dc: base && has_lock,
        rotating_ac: ac_lock,
        chirp: ac_lock,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fake(&'static str);
    impl QueryTransport for Fake {
        fn query(&mut self, c: &str) -> Result<String> {
            assert_eq!(c, "SNAP? 1,2");
            Ok(self.0.into())
        }
    }
    #[test]
    fn sr830_snapshot() {
        assert_eq!(
            Sr830::new(Fake("1.25,-2e-6\n")).read_xy().unwrap(),
            (1.25, -2e-6)
        );
    }
    #[test]
    fn rejects_bad_snapshot() {
        assert!(Sr830::new(Fake("NaN,2")).read_xy().is_err());
    }
    #[test]
    fn unsupported_does_not_discover() {
        let mut a = UnavailableAdapter("VISA");
        let report = discover(&mut [&mut a]);
        assert!(report.devices.is_empty());
        assert_eq!(report.errors.len(), 1);
    }
    #[test]
    fn no_unverified_device_assignment() {
        let a = Assignments {
            source: Some("not discovered".into()),
            ..Default::default()
        };
        assert!(method_candidates(&[], &a).is_err());
    }
    #[test]
    fn roles_match_user_inventory() {
        assert_eq!(Model::LakeShore155Ac.role(), Role::CurrentSource);
        assert!(!Model::Keithley6220.supports_ac_current());
    }
}
