use crate::{
    instruments,
    protocol::{num, number, register, text, Device, Hardware, LockIn, Session, R},
};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

fn positive(v: &Value, name: &str, max: f64) -> R<f64> {
    let n = num(v).map_err(|_| format!("{name} must be numeric"))?;
    if n <= 0. || n > max {
        return Err(format!("{name} outside allowed range"));
    }
    Ok(n)
}
fn whole(v: &Value, min: u64, max: u64, name: &str) -> R<u64> {
    v.as_u64()
        .filter(|n| *n >= min && *n <= max)
        .ok_or_else(|| format!("{name} must be a whole number in {min}..{max}"))
}
fn tag<'a>(v: &'a Value, allowed: &[&str], name: &str) -> R<&'a str> {
    let s = text(v)?;
    if !allowed.contains(&s) {
        return Err(format!("Invalid {name}"));
    }
    Ok(s)
}
fn timestamp() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

#[derive(Clone, Debug)]
pub struct Config {
    pub project: Value,
    pub h: Value,
    pub m: Value,
    pub mode: Value,
    pub kind: String,
    pub exc: String,
    pub volt: bool,
    pub levels: Vec<f64>,
    pub steps: Vec<Value>,
}
impl Config {
    pub fn parse(p: Value) -> R<Self> {
        if !p.is_object() {
            return Err("Expected project object".into());
        }
        let h = p["hardware"].clone();
        let m = p["method"].clone();
        tag(&h["backend"], &["real"], "backend")?;
        let kind = tag(&m["kind"], &["fixed", "rotating", "chirp"], "method")?.to_string();
        let mode = if kind == "chirp" {
            m.clone()
        } else {
            m[&kind].clone()
        };
        let mut exc = if kind == "chirp" {
            "ac"
        } else {
            tag(
                &mode["excitation"],
                if kind == "fixed" {
                    &["dc", "delta", "ac"]
                } else {
                    &["dc", "ac"]
                },
                "excitation",
            )?
        }
        .to_string();
        if kind == "fixed" && exc == "dc" && h["measure"]["dc_mode"] == "delta" {
            exc = "delta".into();
        }
        tag(&h["magnet"]["rotator"], &["OWISPS10"], "motor")?;
        positive(
            &h["magnet"]["counts_per_turn"],
            "OWIS counts per revolution",
            f64::MAX,
        )?;
        positive(
            &h["magnet"]["velocity_scale"],
            "OWIS velocity conversion",
            f64::MAX,
        )?;
        let dir = num(&h["magnet"]["dir_sign"])?;
        if ![-1., 1.].contains(&dir) {
            return Err("Direction must be +1 or -1".into());
        }
        num(&h["magnet"]["angle_offset_deg"])?;
        let source = tag(&h["source"]["model"], &["K6220", "K6221"], "current source")?;
        if exc == "ac" && source != "K6221" {
            return Err("AC sourcing requires 6221".into());
        }
        let limit = positive(&h["source"]["max_mA"], "Current limit", 105.)?;
        positive(&h["source"]["compliance_V"], "Voltage compliance", 105.)?;
        let sweep = kind == "rotating" && exc == "dc";
        let values = if kind == "chirp" {
            m["levels_mA"]
                .as_array()
                .cloned()
                .ok_or("Missing CHIRP current list")?
        } else if sweep {
            mode["currents_mA"]
                .as_array()
                .cloned()
                .ok_or("Missing signed DC currents")?
        } else {
            vec![mode["I_mA"].clone()]
        };
        if values.is_empty() || values.len() > 1000 {
            return Err("Current list must contain 1..1000 levels".into());
        }
        let levels: Vec<f64> = values.iter().map(num).collect::<R<_>>()?;
        for i in &levels {
            if i.abs() > limit || i.abs() * if exc == "ac" { 2f64.sqrt() } else { 1. } > 105. {
                return Err("Current exceeds software or peak source limit".into());
            }
            if !sweep && *i <= 0. {
                return Err("Current amplitudes must be positive".into());
            }
        }
        if sweep && levels.iter().all(|x| *x == levels[0]) {
            return Err("At least two distinct signed currents are required".into());
        }
        let volt = kind == "fixed" && exc != "ac";
        if volt {
            tag(&h["measure"]["volt"], &["K2182", "K2182A"], "voltmeter")?;
            whole(
                &mode.get("nplc").cloned().unwrap_or(json!(1)),
                1,
                50,
                "Integration PLC",
            )?;
        } else {
            tag(
                &h["measure"]["lockin1"],
                &["SR830", "AMETEK7230"],
                "lock-in",
            )?;
            positive(&m["tc_ms"], "Time constant", 30_000_000.)?;
            positive(&m["lock_timeout_s"], "TTL lock timeout", 600.)?;
            if h["measure"]["lockin2"]
                .as_str()
                .is_some_and(|x| !x.is_empty())
            {
                return Err("Real acquisition currently records one lock-in".into());
            }
        }
        match kind.as_str() {
            "fixed" => {
                tag(&mode["acq"], &["step", "scan"], "angular acquisition")?;
                if mode["acq"] == "step" {
                    whole(&mode["n_angles"], 4, 3600, "Angle count")?;
                    positive(&mode["settle_s"], "Settling time", 3600.)?;
                } else {
                    positive(&mode["rot_hz"], "Rotation frequency", 1.2)?;
                }
            }
            "rotating" => {
                let hz = positive(&mode["rot_hz"], "Rotation frequency", 1.2)?;
                if positive(&mode["duration_s"], "Duration", 86400.)? * hz < 1. {
                    return Err("Acquire at least one full rotation per current".into());
                }
                if exc == "ac" {
                    tag(&mode["sideband"], &["lower", "upper"], "sideband")?;
                }
            }
            _ => {
                let hz = positive(&m["rot_hz"], "Maximum rotation frequency", 1.2)?;
                let cycles = whole(&m["cycles"], 1, 10000, "Cycles")?;
                let mask = num(&m["mask_s"])?;
                if mask < 0. || mask >= cycles as f64 / hz {
                    return Err("Invalid CHIRP mask".into());
                }
                tag(&m["direction"], &["both", "cw", "ccw"], "direction")?;
            }
        }
        if exc == "ac" {
            let fc = positive(&mode["carrier_hz"], "Carrier frequency", 100000.)?;
            if kind == "rotating" && fc <= num(&mode["rot_hz"])? {
                return Err("Carrier must exceed rotation frequency".into());
            }
        }
        let temp = tag(
            &h["temperature"],
            &["off", "read", "control"],
            "temperature selection",
        )?;
        if temp != "off" {
            tag(
                &h["tempController"]["model"],
                &["LS332", "LS335"],
                "temperature controller",
            )?;
            tag(&h["tempController"]["input"], &["A", "B"], "sensor input")?;
            whole(&h["tempController"]["loop"], 1, 2, "Control loop")?;
        }
        if temp == "control" {
            positive(&h["tempController"]["maxK"], "Maximum temperature", 1500.)?;
            positive(&h["tempController"]["maxRateKmin"], "Maximum ramp", 100.)?;
        }
        let steps = p["tempProgram"]
            .as_array()
            .cloned()
            .filter(|s| !s.is_empty() && s.len() <= 10000)
            .ok_or("Experiment program must contain 1..10000 steps")?;
        for s in &steps {
            match tag(
                &s["type"],
                &["measure", "soak", "goto", "heater_off"],
                "program step",
            )? {
                "soak" => {
                    positive(&s["seconds"], "Soak duration", 86400.)?;
                }
                "goto" => {
                    if temp != "control" {
                        return Err("Temperature control is not enabled".into());
                    }
                    positive(&s["T"], "Setpoint", num(&h["tempController"]["maxK"])?)?;
                    positive(
                        &s["rate"],
                        "Ramp rate",
                        num(&h["tempController"]["maxRateKmin"])?,
                    )?;
                    let tol = positive(&s["tol"], "Tolerance", f64::MAX)?;
                    let mean = num(s.get("mean_tol").unwrap_or(&s["tol"]))?;
                    if mean < 0. || mean > tol {
                        return Err("Invalid mean temperature tolerance".into());
                    }
                    positive(&s["window_s"], "Stability window", 86400.)?;
                    positive(&s["timeout_s"], "Stability timeout", 86400.)?;
                    tag(&s["range"], &["low", "medium", "high"], "heater range")?;
                }
                "heater_off" if temp != "control" => {
                    return Err("Temperature control is not enabled".into())
                }
                _ => (),
            }
        }
        Ok(Self {
            project: p,
            h,
            m,
            mode,
            kind,
            exc,
            volt,
            levels,
            steps,
        })
    }
    fn devices(&self) -> R<Vec<Device>> {
        let h = &self.h;
        let mut ds = vec![
            Device {
                role: "motion".into(),
                model: "OWISPS10".into(),
                address: text(&h["magnet"]["rotator_addr"])?.into(),
                baud: Some(h["magnet"]["baud"].as_u64().unwrap_or(9600) as u32),
                ..Default::default()
            },
            Device {
                role: "source".into(),
                model: text(&h["source"]["model"])?.into(),
                address: text(&h["source"]["address"])?.into(),
                ..Default::default()
            },
        ];
        ds.push(if self.volt {
            Device {
                role: "voltmeter".into(),
                model: text(&h["measure"]["volt"])?.into(),
                address: text(if self.exc == "delta" {
                    &h["source"]["address"]
                } else {
                    &h["measure"]["volt_addr"]
                })?
                .into(),
                connection: Some(
                    if self.exc == "delta" {
                        "delta"
                    } else {
                        "independent"
                    }
                    .into(),
                ),
                source_model: Some(text(&h["source"]["model"])?.into()),
                ..Default::default()
            }
        } else {
            Device {
                role: "lockin1".into(),
                model: text(&h["measure"]["lockin1"])?.into(),
                address: text(&h["measure"]["lockin1_addr"])?.into(),
                ..Default::default()
            }
        });
        if h["temperature"] != "off" {
            ds.push(Device {
                role: "temperature".into(),
                model: text(&h["tempController"]["model"])?.into(),
                address: text(&h["tempController"]["address"])?.into(),
                ..Default::default()
            });
        }
        let mut seen = HashSet::new();
        for d in &ds {
            if d.address.trim().is_empty() {
                return Err("Device address is required".into());
            }
            if d.connection.as_deref() != Some("delta")
                && !seen.insert(d.address.trim().to_uppercase())
            {
                return Err("Devices share an address".into());
            }
        }
        Ok(ds)
    }
}

#[cfg(test)]
mod migration_tests {
    use super::*;
    use std::sync::atomic::AtomicU64;
    #[derive(Default)]
    struct Bench {
        commands: Vec<(String, String)>,
        position: f64,
        current: f64,
        velocity: f64,
        moving: bool,
        unlock: bool,
        fault: u32,
        reference: f64,
        field: bool,
    }
    struct FakeClock {
        ticks: AtomicU64,
        bench: Arc<Mutex<Bench>>,
    }
    impl Clock for FakeClock {
        fn now(&self) -> Duration {
            Duration::from_micros(self.ticks.load(Ordering::SeqCst))
        }
        fn sleep(&self, d: Duration) {
            self.ticks.fetch_add(d.as_micros() as u64, Ordering::SeqCst);
            let mut b = self.bench.lock().unwrap();
            if b.moving {
                b.position += b.velocity * d.as_secs_f64();
            }
        }
    }
    struct FakeHardware(Arc<Mutex<Bench>>);
    struct FakeSession {
        d: Device,
        b: Arc<Mutex<Bench>>,
    }
    impl Hardware for FakeHardware {
        fn open(&mut self, d: &Device) -> R<Box<dyn Session>> {
            Ok(Box::new(FakeSession {
                d: d.clone(),
                b: self.0.clone(),
            }))
        }
        fn optical(&mut self, _: &Device) -> R<Value> {
            Err("Optical encoder offline".into())
        }
    }
    impl Session for FakeSession {
        fn write(&mut self, c: &str) -> R<()> {
            let mut b = self.b.lock().unwrap();
            b.commands.push((self.d.role.clone(), c.into()));
            if let Some(v) = c.strip_prefix("PSET1=") {
                b.position = number(v)?;
            }
            if let Some(v) = c.strip_prefix("VVEL1=") {
                b.velocity = number(v)?;
            }
            if c == "VGO1" {
                b.moving = true;
            }
            if c == "STOP1" {
                b.moving = false;
                b.velocity = 0.;
            }
            for prefix in ["SOUR:CURR ", "SOUR:DELT:HIGH "] {
                if let Some(v) = c.strip_prefix(prefix) {
                    b.current = number(v)?;
                }
            }
            if let Some(v) = c.strip_prefix("SOUR:WAVE:AMPL ") {
                b.current = number(v)? / 2f64.sqrt();
            }
            Ok(())
        }
        fn query(&mut self, c: &str) -> R<String> {
            let b = self.b.lock().unwrap();
            Ok(match c {
                "*IDN?" => {
                    if self.d.model == "SR830" {
                        "Stanford,SR830,123,1".into()
                    } else {
                        format!(
                            "MANUFACTURER,MODEL {},123,1",
                            match self.d.model.as_str() {
                                "K6220" => "6220",
                                "K6221" => "6221",
                                "K2182A" => "2182A",
                                "K2182" => "2182",
                                "LS335" => "335",
                                _ => "UNKNOWN",
                            }
                        )
                    }
                }
                "?VERSION" => "PS10-V3.0".into(),
                "?CNT1" => b.position.to_string(),
                "?TERM" => "0".into(),
                "?REFST1" => "1".into(),
                "?ASTAT" => if b.moving { "V" } else { "R" }.into(),
                "?VACT1" => b.velocity.to_string(),
                "SYST:ERR?" => "0,No error".into(),
                "STAT:MEAS?" | "STAT:MEAS:COND?" => b.fault.to_string(),
                "SOUR:DELT:NVPR?" => "1".into(),
                "SYST:COMM:SER:ENT?" => "KEITHLEY,MODEL 2182A,456,1".into(),
                "LIAS? 3" => u8::from(b.unlock).to_string(),
                "FREQ?" | "FRQ." => b.reference.to_string(),
                "ID" => "7230".into(),
                "TC." => "0.1".into(),
                "ST" => if b.unlock { "8" } else { "1" }.into(),
                "IMODE" | "REFMODE" => "0".into(),
                "VMODE" => "1".into(),
                "SNAP? 1,2" | "XY." => format!(
                    "{},0",
                    b.current * 2. / if b.field { 2f64.sqrt() } else { 1. }
                ),
                "READ?" | "SENS:DATA?" => {
                    (b.current * 2. * (b.position / 4000. * std::f64::consts::TAU).cos())
                        .to_string()
                }
                "KRDG? A" => "300".into(),
                "RAMPST? 1" => "0".into(),
                _ => return Err(format!("Unexpected test query {c}")),
            })
        }
    }
    fn project() -> Value {
        json!({"hardware":{"backend":"real","temperature":"off","magnet":{"rotator":"OWISPS10","rotator_addr":"COM3","baud":9600,"counts_per_turn":4000,"velocity_scale":1,"dir_sign":1,"angle_offset_deg":0,"encoder":""},"source":{"model":"K6221","address":"GPIB0::13::INSTR","max_mA":10,"compliance_V":10},"measure":{"volt":"K2182A","volt_addr":"GPIB0::7::INSTR","lockin1":"SR830","lockin1_addr":"GPIB0::8::INSTR"},"tempController":{}},"method":{"kind":"fixed","lock_timeout_s":0.3,"tc_ms":100,"fixed":{"excitation":"dc","acq":"step","I_mA":1,"nplc":1,"n_angles":4,"settle_s":0.01,"reverse":false,"carrier_hz":700,"rot_hz":0.2}},"sample":{},"tempProgram":[{"type":"measure","label":"test"}]})
    }
    fn exercise(p: Value, b: Arc<Mutex<Bench>>) -> (R<()>, Arc<Job>) {
        let c = Config::parse(p).unwrap();
        let j = Job::new();
        let mut hw = FakeHardware(b.clone());
        let clock = Arc::new(FakeClock {
            ticks: AtomicU64::new(0),
            bench: b,
        });
        let mut runtime = Runtime::new(&c, &j, &mut hw, clock);
        let result = runtime.execute();
        drop(runtime);
        (result, j)
    }
    fn bench() -> Arc<Mutex<Bench>> {
        Arc::new(Mutex::new(Bench {
            reference: 700.,
            ..Default::default()
        }))
    }
    fn off(b: &Arc<Mutex<Bench>>) {
        let b = b.lock().unwrap();
        assert!(b.commands.contains(&("motion".into(), "STOP1".into())));
        assert_eq!(
            b.commands
                .iter()
                .filter(|(r, _)| r == "source")
                .last()
                .unwrap()
                .1,
            "OUTP OFF"
        );
    }
    #[test]
    fn limits_before_outputs() {
        let mut p = project();
        p["method"]["fixed"]["acq"] = json!("scan");
        p["method"]["fixed"]["rot_hz"] = json!(1.21);
        assert!(Config::parse(p).unwrap_err().contains("Rotation"));
        let mut p = project();
        p["method"]["fixed"]["I_mA"] = json!(20);
        assert!(Config::parse(p).is_err());
        let mut p = project();
        p["hardware"]["magnet"]["velocity_scale"] = Value::Null;
        assert!(Config::parse(p).is_err());
    }
    #[test]
    fn real_steps_cleanup_and_provenance() {
        let b = bench();
        let (r, j) = exercise(project(), b.clone());
        r.unwrap();
        off(&b);
        let s = j.state.lock().unwrap();
        assert_eq!(s.runs.len(), 1);
        assert_eq!(s.runs[0]["simulated"], false);
        assert!(s.runs[0]["samples"]["t"].as_array().unwrap().len() > 20);
        assert!(!b
            .lock()
            .unwrap()
            .commands
            .iter()
            .any(|(_, c)| c.starts_with("INIT1") || c.starts_with("REF1")));
    }
    #[test]
    fn delta_uses_source_and_both_polarities() {
        let mut p = project();
        p["method"]["fixed"]["excitation"] = json!("delta");
        p["hardware"]["measure"]["volt_addr"] = json!("");
        let b = bench();
        exercise(p, b.clone()).0.unwrap();
        off(&b);
        let b = b.lock().unwrap();
        assert!(b
            .commands
            .contains(&("source".into(), "SOUR:DELT:LOW -0.001".into())));
        assert!(!b.commands.iter().any(|(r, _)| r == "voltmeter"));
    }
    fn sweep(model: &str) -> Value {
        let mut p = project();
        p["method"]["kind"] = json!("rotating");
        p["method"]["rotating"] = json!({"excitation":"dc","currents_mA":[-1,0,1],"rot_hz":1.2,"duration_s":1,"background":true});
        p["hardware"]["measure"]["lockin1"] = json!(model);
        p
    }
    #[test]
    fn signed_sweep_no_extra_background() {
        let b = bench();
        {
            let mut b = b.lock().unwrap();
            b.reference = 1.2;
            b.field = true;
        }
        let (r, j) = exercise(sweep("SR830"), b.clone());
        r.unwrap();
        off(&b);
        assert_eq!(
            b.lock()
                .unwrap()
                .commands
                .iter()
                .filter(|(_, c)| c.starts_with("SOUR:CURR "))
                .count(),
            3
        );
        assert_eq!(
            j.state.lock().unwrap().runs[0]["detectionKind"],
            "field-lockin"
        );
    }
    #[test]
    fn ametek_acquisition_commands() {
        let b = bench();
        b.lock().unwrap().reference = 1.2;
        let (r, _) = exercise(sweep("AMETEK7230"), b.clone());
        r.unwrap();
        off(&b);
        let b = b.lock().unwrap();
        assert!(b.commands.contains(&("lockin1".into(), "TC 12".into())));
        assert!(b.commands.contains(&("lockin1".into(), "IE 1".into())));
        assert!(!b.commands.iter().any(|(_, c)| c.starts_with("FMOD")));
    }
    #[test]
    fn chirp_measured_cycles_both_directions() {
        let mut p = project();
        p["method"] = json!({"kind":"chirp","tc_ms":100,"lock_timeout_s":1,"carrier_hz":700,"levels_mA":[1],"rot_hz":1.2,"cycles":1,"mask_s":0.1,"direction":"both"});
        let (r, j) = exercise(p, bench());
        r.unwrap();
        let s = j.state.lock().unwrap();
        let dirs = s.runs[0]["samples"]["dir"].as_array().unwrap();
        assert!(dirs.contains(&json!(1)) && dirs.contains(&json!(-1)));
        assert!(dirs.len() > 30);
    }
    #[test]
    fn reference_timeout_stops_outputs() {
        let mut p = project();
        p["method"]["fixed"]["excitation"] = json!("ac");
        let b = bench();
        b.lock().unwrap().unlock = true;
        assert!(exercise(p, b.clone()).0.unwrap_err().contains("TTL"));
        off(&b);
    }
    #[test]
    fn compliance_rejects_data() {
        let b = bench();
        b.lock().unwrap().fault = 8;
        assert!(exercise(project(), b.clone())
            .0
            .unwrap_err()
            .contains("compliance"));
        off(&b);
    }
    #[test]
    fn optical_unavailable_uses_owis() {
        let mut p = project();
        p["hardware"]["magnet"]["encoder"] = json!("NI9361");
        let (r, j) = exercise(p, bench());
        r.unwrap();
        assert_eq!(j.state.lock().unwrap().runs[0]["positionSource"], "owis");
    }
    #[test]
    fn heartbeat_and_abort() {
        let j = Job::new();
        *j.heartbeat.lock().unwrap() = Instant::now() - Duration::from_secs(16);
        assert!(j.checkpoint().unwrap_err().contains("heartbeat"));
        j.abort.store(true, Ordering::SeqCst);
        assert!(j.checkpoint().unwrap_err().contains("Aborted"));
    }
    #[test]
    fn live_update_validation_and_delta_device_mode() {
        let p = project();
        let j = Job::new();
        *j.desired.lock().unwrap() = p.clone();
        let mut next = p.clone();
        next["method"]["fixed"]["I_mA"] = json!(2);
        j.update(next.clone()).unwrap();
        next["method"]["fixed"]["I_mA"] = json!(1000);
        assert!(j.update(next).is_err());
        let mut next = p.clone();
        next["hardware"]["source"]["address"] = json!("GPIB0::14::INSTR");
        assert!(j.update(next.clone()).unwrap_err().contains("Pause"));
        j.state.lock().unwrap().state = "paused".into();
        j.update(next).unwrap();
        let mut delta = p;
        delta["hardware"]["measure"]["dc_mode"] = json!("delta");
        assert_eq!(Config::parse(delta).unwrap().exc, "delta");
    }
    #[test]
    fn queued_parameters_apply_at_boundary_with_provenance() {
        let p = project();
        let c = Config::parse(p.clone()).unwrap();
        let j = Job::new();
        let mut next = p;
        next["method"]["fixed"]["I_mA"] = json!(2);
        *j.desired.lock().unwrap() = next;
        let b = bench();
        let mut hw = FakeHardware(b.clone());
        let clock = Arc::new(FakeClock {
            ticks: AtomicU64::new(0),
            bench: b.clone(),
        });
        Runtime::new(&c, &j, &mut hw, clock).execute().unwrap();
        assert_eq!(
            j.state.lock().unwrap().runs[0]["method"]["fixed"]["I_mA"],
            2
        );
        off(&b);
    }
    struct ChangeClock {
        clock: FakeClock,
        job: Arc<Job>,
        update: Mutex<Option<Value>>,
        pause: bool,
        fired: AtomicBool,
    }
    impl Clock for ChangeClock {
        fn now(&self) -> Duration {
            self.clock.now()
        }
        fn sleep(&self, d: Duration) {
            self.clock.sleep(d);
            if self.now() > Duration::from_millis(300) && !self.fired.swap(true, Ordering::SeqCst) {
                if self.pause {
                    self.job.pause.store(true, Ordering::SeqCst);
                }
                if let Some(p) = self.update.lock().unwrap().take() {
                    self.job.update(p).unwrap();
                }
            }
        }
    }
    #[test]
    fn pause_cleans_outputs_keeps_partial_and_resume_uses_new_settings() {
        let p = project();
        let c = Config::parse(p.clone()).unwrap();
        let j = Job::new();
        *j.desired.lock().unwrap() = p.clone();
        let b = bench();
        let mut hw = FakeHardware(b.clone());
        let clock = Arc::new(ChangeClock {
            clock: FakeClock {
                ticks: AtomicU64::new(0),
                bench: b.clone(),
            },
            job: j.clone(),
            update: Mutex::new(None),
            pause: true,
            fired: AtomicBool::new(false),
        });
        assert_eq!(
            Runtime::new(&c, &j, &mut hw, clock).execute().unwrap_err(),
            "Pause requested"
        );
        off(&b);
        {
            let s = j.state.lock().unwrap();
            assert_eq!(s.runs.len(), 1);
            assert_eq!(s.runs[0]["incomplete"], true);
            assert!(!s.runs[0]["samples"]["t"].as_array().unwrap().is_empty());
        }
        j.state.lock().unwrap().state = "paused".into();
        let mut next = p;
        next["method"]["fixed"]["I_mA"] = json!(2);
        j.update(next.clone()).unwrap();
        j.pause.store(false, Ordering::SeqCst);
        let c = Config::parse(next).unwrap();
        let clock = Arc::new(FakeClock {
            ticks: AtomicU64::new(0),
            bench: b.clone(),
        });
        Runtime::new(&c, &j, &mut hw, clock).execute().unwrap();
        off(&b);
        let s = j.state.lock().unwrap();
        assert_eq!(s.runs.len(), 2);
        assert_eq!(s.runs[0]["method"]["fixed"]["I_mA"], 1);
        assert_eq!(s.runs[1]["method"]["fixed"]["I_mA"], 2);
        assert_eq!(s.runs[1]["incomplete"], false);
    }
    #[test]
    fn live_edit_does_not_change_current_measurement() {
        let mut p = project();
        p["tempProgram"] = json!([{"type":"measure"},{"type":"measure"}]);
        let c = Config::parse(p.clone()).unwrap();
        let j = Job::new();
        *j.desired.lock().unwrap() = p.clone();
        let mut next = p;
        next["method"]["fixed"]["I_mA"] = json!(2);
        let b = bench();
        let mut hw = FakeHardware(b.clone());
        let clock = Arc::new(ChangeClock {
            clock: FakeClock {
                ticks: AtomicU64::new(0),
                bench: b.clone(),
            },
            job: j.clone(),
            update: Mutex::new(Some(next)),
            pause: false,
            fired: AtomicBool::new(false),
        });
        Runtime::new(&c, &j, &mut hw, clock).execute().unwrap();
        off(&b);
        let s = j.state.lock().unwrap();
        assert_eq!(s.runs.len(), 2);
        assert_eq!(s.runs[0]["method"]["fixed"]["I_mA"], 1);
        assert_eq!(s.runs[1]["method"]["fixed"]["I_mA"], 2);
        for (run, current) in s.runs.iter().zip([0.001, 0.002]) {
            assert!(run["samples"]["I"]
                .as_array()
                .unwrap()
                .iter()
                .all(|x| (x.as_f64().unwrap() - current).abs() < 1e-10));
        }
    }
    #[test]
    fn thermal_program_edits_are_limited_to_future_parameters() {
        let mut p = project();
        p["tempProgram"] = json!([{"type":"measure","label":"first"},{"type":"soak","seconds":2}]);
        let j = Job::new();
        *j.desired.lock().unwrap() = p.clone();
        let mut next = p.clone();
        next["tempProgram"][0]["label"] = json!("changed");
        assert!(j.update(next).is_err());
        let mut next = p.clone();
        next["tempProgram"][1]["seconds"] = json!(3);
        j.update(next).unwrap();
        let mut next = p;
        next["tempProgram"][1] = json!({"type":"measure"});
        assert!(j.update(next).is_err());
    }
    #[test]
    fn temperature_setpoint_precedes_heating() {
        let mut p = project();
        p["hardware"]["temperature"] = json!("control");
        p["hardware"]["tempController"] = json!({"model":"LS335","address":"GPIB0::12::INSTR","input":"A","loop":1,"maxK":400,"maxRateKmin":10});
        p["tempProgram"].as_array_mut().unwrap().insert(0,json!({"type":"goto","T":300,"rate":5,"range":"low","tol":0.1,"mean_tol":0.05,"window_s":1,"timeout_s":5}));
        let b = bench();
        exercise(p, b.clone()).0.unwrap();
        let b = b.lock().unwrap();
        let c: Vec<_> = b
            .commands
            .iter()
            .filter(|(r, _)| r == "temperature")
            .map(|(_, c)| c.as_str())
            .collect();
        assert!(
            c.iter().position(|c| *c == "SETP 1,300").unwrap()
                < c.iter().position(|c| *c == "RANGE 1,1").unwrap()
        );
        assert_eq!(c.last(), Some(&"RANGE 1,0"));
    }
    #[test]
    fn autosave_is_loadable() {
        let p = project();
        let c = Config::parse(p.clone()).unwrap();
        let (r, j) = exercise(p, bench());
        r.unwrap();
        let dir = std::env::temp_dir().join(format!("halbach-rust-test-{}", j.id));
        persist(&c, &j, &dir).unwrap();
        let saved: Value = serde_json::from_slice(
            &std::fs::read(dir.join(format!("{}.hallproj.json", j.id))).unwrap(),
        )
        .unwrap();
        assert_eq!(saved["format"], "halbach-hall-project");
        assert_eq!(saved["runs"][0]["id"], "run-001");
        assert_eq!(saved["simulated"], false);
        assert!(dir.starts_with(std::env::temp_dir()));
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[derive(Default)]
pub struct Status {
    pub state: String,
    pub message: String,
    pub step: usize,
    pub runs: Vec<Value>,
    pub errors: Vec<String>,
    pub temperature: Option<f64>,
    pub setpoint: Option<f64>,
}
pub struct Job {
    pub id: String,
    pub abort: AtomicBool,
    pub pause: AtomicBool,
    pub desired: Mutex<Value>,
    pub done: AtomicBool,
    pub state: Mutex<Status>,
    pub heartbeat: Mutex<Instant>,
}
impl Job {
    pub fn update(&self, project: Value) -> R<()> {
        if self.done.load(Ordering::SeqCst)
            || ["finished", "error", "aborted"].contains(&self.state.lock().unwrap().state.as_str())
        {
            return Err("Program has stopped".into());
        }
        let cfg = Config::parse(project.clone())?;
        cfg.devices()?;
        let mut desired = self.desired.lock().unwrap();
        let (paused, step) = {
            let s = self.state.lock().unwrap();
            (s.state == "paused", s.step)
        };
        let principle = |p: &Value| {
            json!([
                p["method"]["kind"],
                p["method"]["fixed"]["excitation"],
                p["method"]["fixed"]["acq"],
                p["method"]["rotating"]["excitation"]
            ])
        };
        if !paused
            && (project["hardware"] != desired["hardware"]
                || principle(&project) != principle(&desired))
        {
            return Err("Pause before changing the method principle or devices".into());
        }
        if project["sample"] != desired["sample"] {
            return Err("Sample is fixed for the current program".into());
        }
        let old = desired["tempProgram"].as_array().ok_or("Missing program")?;
        let next = project["tempProgram"].as_array().ok_or("Missing program")?;
        if old.len() != next.len()
            || old
                .iter()
                .zip(next)
                .enumerate()
                .any(|(i, (a, b))| a["type"] != b["type"] || (i <= step && a != b))
        {
            return Err("Only future step parameters can change; active/completed steps and sequence structure are fixed".into());
        }
        *desired = project;
        Ok(())
    }
    pub fn status(&self, cursor: usize) -> Value {
        *self.heartbeat.lock().unwrap() = Instant::now();
        let s = self.state.lock().unwrap();
        json!({"id":self.id,"state":s.state,"message":s.message,"step":s.step,"runs":s.runs.get(cursor..).unwrap_or(&[]),"count":s.runs.len(),"cleanupErrors":s.errors,"temperatureK":s.temperature,"setpointK":s.setpoint})
    }
    fn checkpoint(&self) -> R<()> {
        if self.abort.load(Ordering::SeqCst) {
            return Err("Aborted by user".into());
        }
        if self.heartbeat.lock().unwrap().elapsed() > Duration::from_secs(15) {
            return Err("Browser heartbeat lost".into());
        }
        if self.pause.load(Ordering::SeqCst) {
            return Err("Pause requested".into());
        }
        Ok(())
    }
    fn new() -> Arc<Self> {
        Arc::new(Self {
            id: format!("{:032x}", rand::random::<u128>()),
            abort: AtomicBool::new(false),
            pause: AtomicBool::new(false),
            desired: Mutex::new(Value::Null),
            done: AtomicBool::new(false),
            state: Mutex::new(Status {
                state: "starting".into(),
                message: "Checking instruments".into(),
                ..Default::default()
            }),
            heartbeat: Mutex::new(Instant::now()),
        })
    }
}
pub trait Clock: Send + Sync {
    fn now(&self) -> Duration;
    fn sleep(&self, d: Duration);
}
struct RealClock(Instant);
impl Clock for RealClock {
    fn now(&self) -> Duration {
        self.0.elapsed()
    }
    fn sleep(&self, d: Duration) {
        std::thread::sleep(d)
    }
}
pub fn launch(
    hardware: Arc<Mutex<Box<dyn Hardware>>>,
    project: Value,
    output: PathBuf,
) -> R<Arc<Job>> {
    let mut cfg = Config::parse(project)?;
    cfg.devices()?;
    let job = Job::new();
    *job.desired.lock().unwrap() = cfg.project.clone();
    let j = job.clone();
    std::thread::spawn(move || {
        let result = (|| loop {
            let result = {
                let mut hw = hardware.lock().map_err(|_| "Hardware access poisoned")?;
                let mut r =
                    Runtime::new(&cfg, &j, hw.as_mut(), Arc::new(RealClock(Instant::now())));
                j.state.lock().unwrap().state = "running".into();
                r.execute()
            };
            if result.as_ref().err().is_none_or(|e| e != "Pause requested") {
                break result;
            }
            {
                let mut s = j.state.lock().unwrap();
                s.state = "paused".into();
                s.message = "Paused: outputs off. Interrupted step will restart on resume.".into();
            }
            while j.pause.load(Ordering::SeqCst) {
                if j.abort.load(Ordering::SeqCst) {
                    return Err("Aborted by user".into());
                }
                if j.heartbeat.lock().unwrap().elapsed() > Duration::from_secs(15) {
                    return Err("Browser heartbeat lost".into());
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            cfg = Config::parse(j.desired.lock().unwrap().clone())?;
            cfg.project["_resumeStep"] = json!(j.state.lock().unwrap().step);
        })();
        {
            let mut s = j.state.lock().unwrap();
            match result {
                Ok(()) => {
                    s.state = "finished".into();
                    s.message = "Program finished".into();
                }
                Err(e) => {
                    s.state = if j.abort.load(Ordering::SeqCst) {
                        "aborted"
                    } else {
                        "error"
                    }
                    .into();
                    s.message = e;
                }
            }
        }
        if let Ok(latest) = Config::parse(j.desired.lock().unwrap().clone()) {
            cfg = latest;
        }
        if let Err(e) = persist(&cfg, &j, &output) {
            j.state
                .lock()
                .unwrap()
                .errors
                .push(format!("Project autosave failed: {e}"));
        }
        j.done.store(true, Ordering::SeqCst);
    });
    Ok(job)
}
fn persist(c: &Config, j: &Job, folder: &Path) -> R<()> {
    std::fs::create_dir_all(folder).map_err(|e| e.to_string())?;
    let s = j.state.lock().unwrap();
    let mut p = c.project.clone();
    p["format"] = json!("halbach-hall-project");
    p["version"] = json!(1);
    p["simulated"] = json!(false);
    p["created"] = json!(timestamp());
    p["modified"] = json!(timestamp());
    p["history"] =
        json!([{"t":timestamp(),"kind":"run","text":format!("{}: {}",s.state,s.message)}]);
    p["log"] = json!([]);
    p["runs"] = Value::Array(
        s.runs
            .iter()
            .enumerate()
            .map(|(i, r)| {
                let mut r = r.clone();
                r["id"] = json!(format!("run-{:03}", i + 1));
                if r["sample"].is_null() {
                    r["sample"] = c.project["sample"].clone();
                }
                if r["method"].is_null() {
                    r["method"] = c.m.clone();
                }
                r["excluded"] = json!([]);
                r
            })
            .collect(),
    );
    let tmp = folder.join(format!("{}.json.tmp", j.id));
    let target = folder.join(format!("{}.hallproj.json", j.id));
    std::fs::write(&tmp, serde_json::to_vec(&p).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    std::fs::rename(tmp, target).map_err(|e| e.to_string())
}
#[derive(Default, Serialize)]
#[allow(non_snake_case)]
pub struct Samples {
    pub t: Vec<f64>,
    pub theta: Vec<f64>,
    pub X: Vec<f64>,
    pub Y: Vec<f64>,
    pub I: Vec<f64>,
    pub T: Vec<Option<f64>>,
    pub valid: Vec<u8>,
    pub dir: Vec<i8>,
}
struct Runtime<'a> {
    c: Config,
    job: &'a Job,
    hw: &'a mut dyn Hardware,
    clock: Arc<dyn Clock>,
    motor: Option<Box<dyn Session>>,
    source: Option<Box<dyn Session>>,
    volt: Option<Box<dyn Session>>,
    temp: Option<Box<dyn Session>>,
    lia: Option<LockIn>,
    pending: Option<Samples>,
    started: Duration,
    started_iso: String,
    label: String,
    position: String,
    optical: Option<Device>,
    optical_origin: f64,
    velocity: bool,
    tc: f64,
    expected: f64,
    tolerance: f64,
    reference_at: Duration,
    temp_at: Option<Duration>,
    latest_temp: Option<f64>,
}
impl<'a> Runtime<'a> {
    fn new(c: &'a Config, job: &'a Job, hw: &'a mut dyn Hardware, clock: Arc<dyn Clock>) -> Self {
        Self {
            c: c.clone(),
            job,
            hw,
            clock,
            motor: None,
            source: None,
            volt: None,
            temp: None,
            lia: None,
            pending: None,
            started: Duration::ZERO,
            started_iso: String::new(),
            label: String::new(),
            position: "owis".into(),
            optical: None,
            optical_origin: 0.,
            velocity: false,
            tc: 0.,
            expected: 0.,
            tolerance: 0.,
            reference_at: Duration::ZERO,
            temp_at: None,
            latest_temp: None,
        }
    }
    fn sleep(&self, seconds: f64) -> R<()> {
        let end = self.clock.now() + Duration::from_secs_f64(seconds);
        while self.clock.now() < end {
            self.job.checkpoint()?;
            self.clock.sleep(
                end.saturating_sub(self.clock.now())
                    .min(Duration::from_millis(100)),
            );
        }
        Ok(())
    }
    fn mq(&mut self, c: &str) -> R<String> {
        self.motor.as_mut().ok_or("Motor not open")?.query(c)
    }
    fn mw(&mut self, c: &str) -> R<()> {
        self.motor.as_mut().ok_or("Motor not open")?.write(c)
    }
    fn sq(&mut self, c: &str) -> R<String> {
        self.source.as_mut().ok_or("Source not open")?.query(c)
    }
    fn sw(&mut self, c: &str) -> R<()> {
        self.source.as_mut().ok_or("Source not open")?.write(c)
    }
    fn tw(&mut self, c: &str) -> R<()> {
        self.temp
            .as_mut()
            .ok_or("Temperature device not open")?
            .write(c)
    }
    fn setup(&mut self) -> R<()> {
        self.job.checkpoint()?;
        let ds = self.c.devices()?;
        for d in &ds {
            instruments::check(self.hw, d)?;
        }
        self.motor = Some(self.hw.open(&ds[0])?);
        self.source = Some(self.hw.open(&ds[1])?);
        if self.c.volt {
            if self.c.exc != "delta" {
                self.volt = Some(self.hw.open(&ds[2])?);
            }
        } else {
            self.lia = Some(instruments::open_lockin(self.hw, &ds[2])?);
        }
        if self.c.h["temperature"] != "off" {
            self.temp = Some(self.hw.open(ds.last().unwrap())?);
        }
        if self.c.h["magnet"]["encoder"]
            .as_str()
            .is_some_and(|s| !s.is_empty())
        {
            let h = &self.c.h["magnet"];
            let d = Device {
                role: "position".into(),
                model: "NI9361".into(),
                address: h["encoder_addr"].as_str().unwrap_or("").into(),
                host: h["host"].as_str().map(str::to_string),
                pulses_per_rev: h["encoder_ppr"].as_u64().and_then(|x| x.try_into().ok()),
                ..Default::default()
            };
            if let Ok(r) = self.hw.optical(&d) {
                self.optical_origin = self.motor_angle()? - num(&r["angleDeg"])?;
                self.position = "optical".into();
                self.optical = Some(d);
            }
        }
        if self
            .mq("?TERM")?
            .split('=')
            .next_back()
            .unwrap_or("")
            .trim()
            != "0"
        {
            return Err("Set PS10 terminal mode TERM=0".into());
        }
        if self.mq("?ASTAT")? != "R" {
            return Err("Initialize the PS10 stage in OWIS software before acquisition".into());
        }
        if self
            .mq("?REFST1")?
            .split('=')
            .next_back()
            .unwrap_or("")
            .trim()
            != "1"
        {
            return Err("Reference the OWIS stage before acquisition".into());
        }
        Ok(())
    }
    fn execute(&mut self) -> R<()> {
        self.setup()?;
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.program()))
            .unwrap_or_else(|_| Err("Acquisition panicked; outputs are being disabled".into()));
        let errors = self.cleanup();
        self.job
            .state
            .lock()
            .unwrap()
            .errors
            .extend(errors.iter().cloned());
        if result.is_err() {
            if self.pending.as_ref().is_some_and(|s| !s.t.is_empty()) {
                self.save_run(true)?;
            }
        }
        if !errors.is_empty() {
            return Err(format!(
                "Output/motion cleanup failed: {}",
                errors.join("; ")
            ));
        }
        result
    }
    fn cleanup(&mut self) -> Vec<String> {
        let mut errors = Vec::new();
        if let Err(e) = self.mw("STOP1") {
            errors.push(e);
        }
        for c in if self.c.h["source"]["model"] == "K6221" {
            vec!["SOUR:SWE:ABOR", "SOUR:WAVE:ABOR", "OUTP OFF"]
        } else {
            vec!["SOUR:SWE:ABOR", "OUTP OFF"]
        } {
            if let Err(e) = self.sw(c) {
                errors.push(e);
            }
        }
        if self.c.h["temperature"] == "control" {
            if let Err(e) = self.heater_off() {
                errors.push(e);
            }
        }
        errors
    }
    fn configure(&mut self) -> R<()> {
        self.sw("OUTP OFF")?;
        self.sw(&format!(
            "SOUR:CURR:COMP {}",
            num(&self.c.h["source"]["compliance_V"])?
        ))?;
        self.sw("SOUR:SWE:ABOR")?;
        self.sq("STAT:MEAS?")?;
        if self.c.volt {
            let commands = vec![
                "SENS:FUNC 'VOLT'".to_string(),
                "SENS:CHAN 1".into(),
                "SENS:VOLT:CHAN1:RANG:AUTO ON".into(),
                format!(
                    "SENS:VOLT:NPLC {}",
                    self.c.mode["nplc"].as_u64().unwrap_or(1)
                ),
            ];
            if self.c.exc == "delta" {
                for c in commands {
                    self.sw(&format!("SYST:COMM:SER:SEND \"{c}\""))?;
                }
                self.sw("FORM:DATA ASC")?;
                self.sw("FORM:ELEM READ")?;
            } else {
                let v = self.volt.as_mut().unwrap();
                v.write("ABOR")?;
                for c in commands {
                    v.write(&c)?;
                }
                for c in [
                    "TRIG:SOUR IMM",
                    "TRIG:COUN 1",
                    "FORM:DATA ASC",
                    "FORM:ELEM READ",
                ] {
                    v.write(c)?;
                }
            }
        } else {
            self.tc = self
                .lia
                .as_mut()
                .unwrap()
                .configure(num(&self.c.m["tc_ms"])? / 1000.)?;
        }
        Ok(())
    }
    fn program(&mut self) -> R<()> {
        self.configure()?;
        let resume = self.c.project["_resumeStep"].as_u64().unwrap_or(0) as usize;
        if self.c.h["temperature"] == "control" && resume > 0 {
            if let Some(s) = self.c.steps[..resume]
                .iter()
                .rev()
                .find(|s| s["type"] == "goto" || s["type"] == "heater_off")
                .cloned()
            {
                if s["type"] == "goto" {
                    self.goto(&s)?;
                }
            }
        }
        for i in resume..self.c.steps.len() {
            self.job.state.lock().unwrap().step = i;
            self.job.checkpoint()?;
            let desired = self.job.desired.lock().unwrap().clone();
            if !desired.is_null()
                && (desired["method"] != self.c.m
                    || desired["tempProgram"] != self.c.project["tempProgram"])
            {
                self.stop()?;
                self.sw("OUTP OFF")?;
                self.c = Config::parse(desired)?;
                self.configure()?;
            }
            let s = self.c.steps[i].clone();
            {
                let mut st = self.job.state.lock().unwrap();
                st.step = i;
                st.message = format!("Step {}: {}", i + 1, text(&s["type"])?);
            }
            match text(&s["type"])? {
                "measure" => self.acquire(&s)?,
                "soak" => self.sleep(num(&s["seconds"])?)?,
                "heater_off" => self.heater_off()?,
                _ => self.goto(&s)?,
            };
        }
        Ok(())
    }
    fn motor_angle(&mut self) -> R<f64> {
        let r = self.mq("?CNT1")?;
        Ok(number(r.split('=').next_back().unwrap_or(""))? * 360.
            / num(&self.c.h["magnet"]["counts_per_turn"])?)
    }
    fn angle(&mut self) -> R<f64> {
        let a = if let Some(d) = self.optical.clone() {
            num(&self.hw.optical(&d)?["angleDeg"])? + self.optical_origin
        } else {
            self.motor_angle()?
        };
        Ok((a * num(&self.c.h["magnet"]["dir_sign"])?
            + num(&self.c.h["magnet"]["angle_offset_deg"])?)
        .to_radians())
    }
    fn stage(&mut self) -> R<String> {
        let s = self.mq("?ASTAT")?;
        if !["R", "T", "V"].contains(&s.as_str()) {
            return Err(format!("OWIS fault/stopped state: {s}"));
        }
        Ok(s)
    }
    fn stop(&mut self) -> R<()> {
        self.velocity = false;
        self.mw("STOP1")?;
        let end = self.clock.now() + Duration::from_secs(30);
        while self.stage()? != "R" {
            if self.clock.now() > end {
                return Err("OWIS did not stop".into());
            }
            self.sleep(0.1)?;
        }
        Ok(())
    }
    fn move_to(&mut self, deg: f64) -> R<()> {
        self.velocity = false;
        self.output_off()?;
        let h = &self.c.h["magnet"];
        let scale = num(&h["counts_per_turn"])?;
        let target =
            ((deg - num(&h["angle_offset_deg"])?) / num(&h["dir_sign"])? * scale / 360.).round();
        let v = (scale * 0.1 * num(&h["velocity_scale"])?).round().max(1.);
        if target.abs() > i32::MAX as f64 || v > i32::MAX as f64 {
            return Err("OWIS position/velocity exceeds command range".into());
        }
        self.mw("ABSOL1")?;
        self.mw(&format!("PVEL1={}", v as i32))?;
        self.mw(&format!("PSET1={}", target as i32))?;
        self.mw("PGO1")?;
        let end = self.clock.now() + Duration::from_secs(120);
        while self.stage()? != "R" {
            if self.clock.now() > end {
                return Err("OWIS positioning timed out".into());
            }
            self.sleep(0.05)?;
        }
        Ok(())
    }
    fn rotate(&mut self, hz: f64, dir: i8) -> R<()> {
        if !(0. < hz && hz <= 1.2) {
            return Err("Rotation must be >0 and <=1.2 Hz".into());
        }
        let h = &self.c.h["magnet"];
        let raw = (num(&h["counts_per_turn"])? * hz * num(&h["velocity_scale"])? * dir as f64
            / num(&h["dir_sign"])?)
        .round();
        if raw.abs() < 1. || raw.abs() > i32::MAX as f64 {
            return Err("OWIS velocity outside range".into());
        }
        self.mw(&format!("VVEL1={}", raw as i32))?;
        self.mw("VGO1")?;
        let end = self.clock.now() + Duration::from_secs(30);
        let mut stable = 0;
        while stable < 3 {
            self.stage()?;
            let v = self.mq("?VACT1")?;
            let v = number(v.split('=').next_back().unwrap_or(""))?;
            stable = if (v - raw).abs() <= (raw.abs() * 0.05).max(1.) {
                stable + 1
            } else {
                0
            };
            if self.clock.now() > end {
                return Err("OWIS did not reach requested speed".into());
            }
            self.sleep(0.1)?;
        }
        self.velocity = true;
        Ok(())
    }
    fn output_off(&mut self) -> R<()> {
        self.sw("SOUR:SWE:ABOR")?;
        if self.c.h["source"]["model"] == "K6221" {
            self.sw("SOUR:WAVE:ABOR")?;
        }
        self.sw("OUTP OFF")
    }
    fn current(&mut self, ma: f64) -> R<()> {
        self.output_off()?;
        let i = ma / 1000.;
        match self.c.exc.as_str() {
            "delta" => {
                for c in [
                    "UNIT VOLT".into(),
                    format!("SOUR:DELT:HIGH {}", i.abs()),
                    format!("SOUR:DELT:LOW {}", -i.abs()),
                    "SOUR:DELT:DEL 0.1".into(),
                    "SOUR:DELT:COUN INF".into(),
                    "SOUR:DELT:CAB ON".into(),
                    "SOUR:DELT:ARM".into(),
                    "INIT:IMM".into(),
                ] {
                    self.sw(&c)?;
                }
            }
            "ac" => {
                let fc = num(&self.c.mode["carrier_hz"])?;
                for c in [
                    "SOUR:WAVE:FUNC SIN".into(),
                    format!("SOUR:WAVE:AMPL {}", i.abs() * 2f64.sqrt()),
                    format!("SOUR:WAVE:FREQ {fc}"),
                    "SOUR:WAVE:OFFS 0".into(),
                    "SOUR:WAVE:ARM".into(),
                    "SOUR:WAVE:INIT".into(),
                ] {
                    self.sw(&c)?;
                }
            }
            _ => {
                self.sw(&format!("SOUR:CURR {i}"))?;
                self.sw("OUTP ON")?;
            }
        }
        let error = self.sq("SYST:ERR?")?;
        if number(error.split(',').next().unwrap_or(""))? != 0. {
            return Err(format!("Keithley rejected settings: {error}"));
        }
        Ok(())
    }
    fn wait_lock(&mut self, expected: f64) -> R<()> {
        self.tolerance = if self.c.exc == "dc" {
            (expected * 0.02).max(0.001)
        } else {
            (expected * 0.0001).max(0.0001)
        };
        if self.c.kind == "rotating" && self.c.exc == "ac" {
            self.tolerance = self.tolerance.min(num(&self.c.mode["rot_hz"])? / 4.);
        }
        self.lia.as_mut().unwrap().clear_unlock()?;
        let end = self.clock.now() + Duration::from_secs_f64(num(&self.c.m["lock_timeout_s"])?);
        let mut stable = 0;
        while self.clock.now() < end {
            self.sleep(0.1)?;
            let lia = self.lia.as_mut().unwrap();
            let unlocked = lia.unlocked()?;
            let f = lia.frequency()?;
            stable = if !unlocked && (f - expected).abs() <= self.tolerance {
                stable + 1
            } else {
                0
            };
            if stable >= 3 {
                self.expected = expected;
                self.reference_at = self.clock.now();
                return Ok(());
            }
        }
        Err("TTL reference did not lock at the expected frequency".into())
    }
    fn temperature(&mut self) -> R<Option<f64>> {
        if self.temp.is_none() {
            return Ok(None);
        }
        if self
            .temp_at
            .is_none_or(|t| self.clock.now() - t >= Duration::from_secs(1))
        {
            let input = text(&self.c.h["tempController"]["input"])?;
            let t = number(
                &self
                    .temp
                    .as_mut()
                    .unwrap()
                    .query(&format!("KRDG? {input}"))?,
            )?;
            if !(0. < t && t <= 1500.) {
                return Err("Invalid temperature sensor reading".into());
            }
            self.latest_temp = Some(t);
            self.temp_at = Some(self.clock.now());
            self.job.state.lock().unwrap().temperature = Some(t);
        }
        Ok(self.latest_temp)
    }
    fn sample(&mut self, ma: f64, valid: bool, dir: i8) -> R<()> {
        self.job.checkpoint()?;
        let state = self.stage()?;
        if self.velocity && state != "V" {
            return Err("OWIS stopped rotating during acquisition".into());
        }
        let faults = register(&self.sq("STAT:MEAS?")?)? | register(&self.sq("STAT:MEAS:COND?")?)?;
        if faults & 13 != 0 {
            return Err(
                "Source overrange, overtemperature or current compliance; reading rejected".into(),
            );
        }
        let t0 = self.clock.now();
        let theta = self.angle()?;
        let (x, y) = if self.c.volt {
            let r = if self.c.exc == "delta" {
                self.sq("SENS:DATA?")?
            } else {
                self.volt.as_mut().unwrap().query("READ?")?
            };
            (number(r.split(',').next().unwrap_or(""))?, 0.)
        } else {
            let lia = self.lia.as_mut().unwrap();
            if lia.unlocked()? {
                return Err("TTL reference lock lost during acquisition".into());
            }
            if self.clock.now() - self.reference_at >= Duration::from_secs(1) {
                let f = lia.frequency()?;
                self.reference_at = self.clock.now();
                if (f - self.expected).abs() > self.tolerance {
                    return Err("Reference frequency changed during acquisition".into());
                }
            }
            lia.read_xy()?
        };
        let t = ((t0 + self.clock.now()).as_secs_f64() / 2.) - self.started.as_secs_f64();
        let temperature = self.temperature()?;
        let s = self.pending.as_mut().ok_or("No acquisition buffer")?;
        if s.t.len() >= 1_000_000 {
            return Err("Acquisition exceeded one million samples".into());
        }
        s.t.push(t);
        s.theta.push(theta);
        s.X.push(x);
        s.Y.push(y);
        s.I.push(ma / 1000.);
        s.T.push(temperature);
        s.valid.push(valid as u8);
        s.dir.push(dir);
        Ok(())
    }
    fn collect(&mut self, ma: f64, seconds: f64, mask: f64, dir: i8, cycles: Option<f64>) -> R<()> {
        let start = self.clock.now();
        let angle = self.angle()?;
        loop {
            let elapsed = (self.clock.now() - start).as_secs_f64();
            if let Some(c) = cycles {
                if (self.angle()? - angle).abs() >= c * std::f64::consts::TAU {
                    break;
                }
            } else if elapsed >= seconds {
                break;
            }
            if elapsed > (seconds * 2.).max(seconds + 30.) {
                return Err("Requested rotation cycles did not complete".into());
            }
            self.sample(ma, elapsed >= mask, dir)?;
            self.sleep(0.05)?;
        }
        Ok(())
    }
    fn acquire(&mut self, step: &Value) -> R<()> {
        self.label = step["label"].as_str().unwrap_or("").into();
        self.started = self.clock.now();
        self.started_iso = timestamp();
        self.pending = Some(Samples::default());
        let f = self.c.mode.clone();
        if self.c.kind == "fixed" && f["acq"] == "step" {
            let n = f["n_angles"].as_u64().unwrap();
            for k in 0..n {
                self.move_to(k as f64 * 360. / n as f64)?;
                let signs = if self.c.exc == "dc" && f["reverse"].as_bool().unwrap_or(false) {
                    vec![1., -1.]
                } else {
                    vec![1.]
                };
                for sign in signs {
                    let i = sign * num(&f["I_mA"])?;
                    self.current(i)?;
                    if self.c.exc == "ac" {
                        self.wait_lock(num(&f["carrier_hz"])?)?;
                    }
                    self.sleep(num(&f["settle_s"])?)?;
                    self.collect(i, 2., 0., 1, None)?;
                }
            }
        } else if self.c.kind == "chirp" {
            let dirs = match text(&f["direction"])? {
                "both" => vec![1, -1],
                "ccw" => vec![-1],
                _ => vec![1],
            };
            let hz = num(&f["rot_hz"])?;
            let cycles = num(&f["cycles"])?;
            for dir in dirs {
                self.output_off()?;
                self.stop()?;
                self.rotate(hz, dir)?;
                for i in self.c.levels.clone() {
                    self.current(i)?;
                    self.wait_lock(num(&f["carrier_hz"])?)?;
                    self.collect(i, cycles / hz, num(&f["mask_s"])?, dir, Some(cycles))?;
                }
            }
        } else {
            let hz = num(&f["rot_hz"])?;
            self.rotate(hz, 1)?;
            let reference = if self.c.exc == "dc" {
                hz
            } else {
                num(&f["carrier_hz"])?
                    + if self.c.kind == "rotating" {
                        if f["sideband"] == "lower" {
                            -hz
                        } else {
                            hz
                        }
                    } else {
                        0.
                    }
            };
            let duration = if self.c.kind == "rotating" {
                num(&f["duration_s"])?
            } else {
                1. / hz
            };
            for i in self.c.levels.clone() {
                self.current(i)?;
                if !self.c.volt {
                    self.wait_lock(reference)?;
                }
                self.sleep((5. * self.tc).max(1.))?;
                self.collect(i, duration, 0., 1, None)?;
            }
            if self.c.kind == "rotating"
                && self.c.exc == "ac"
                && f["background"].as_bool().unwrap_or(false)
            {
                self.output_off()?;
                self.wait_lock(reference)?;
                self.sleep((5. * self.tc).max(1.))?;
                self.collect(0., duration, 0., 1, None)?;
            }
        }
        self.output_off()?;
        self.stop()?;
        self.save_run(false)
    }
    fn save_run(&mut self, incomplete: bool) -> R<()> {
        let s = self.pending.take().ok_or("Missing raw samples")?;
        let temps: Vec<_> = s.T.iter().flatten().copied().collect();
        let mean = if temps.is_empty() {
            None
        } else {
            Some(temps.iter().sum::<f64>() / temps.len() as f64)
        };
        let r = json!({"method":self.c.m,"sample":self.c.project["sample"],"hardware":self.c.h,"samples":s,"simulated":false,"T_mean":mean,"T_set":self.job.state.lock().unwrap().setpoint,"started":self.started_iso,"label":self.label,"positionSource":self.position,"incomplete":incomplete,"rsq_ohm":null,"detectionKind":if self.c.kind=="rotating"{"field-lockin"}else{"angular"},"acquisitionNotes":["Software-polled samples; timestamps bracket position/voltage reads. Validate timing, phase and filter response on the bench."]});
        self.job.state.lock().unwrap().runs.push(r);
        Ok(())
    }
    fn heater_off(&mut self) -> R<()> {
        let c = &self.c.h["tempController"];
        let command = if c["model"] == "LS332" {
            "RANGE 0".to_string()
        } else {
            format!("RANGE {},0", c["loop"])
        };
        self.tw(&command)
    }
    fn goto(&mut self, s: &Value) -> R<()> {
        let loopn = self.c.h["tempController"]["loop"].as_u64().unwrap();
        let range = match text(&s["range"])? {
            "low" => 1,
            "medium" => 2,
            _ => 3,
        };
        self.heater_off()?;
        self.tw(&format!("RAMP {loopn},1,{}", num(&s["rate"])?))?;
        let target = num(&s["T"])?;
        self.tw(&format!("SETP {loopn},{target}"))?;
        self.job.state.lock().unwrap().setpoint = Some(target);
        self.tw(&if self.c.h["tempController"]["model"] == "LS332" {
            format!("RANGE {range}")
        } else {
            format!("RANGE {loopn},{range}")
        })?;
        let end = self.clock.now() + Duration::from_secs_f64(num(&s["timeout_s"])?);
        let window = num(&s["window_s"])?;
        let mut points: Vec<(f64, f64)> = Vec::new();
        while self.clock.now() < end {
            self.sleep(1.)?;
            self.temp_at = None;
            let t = self.temperature()?.ok_or("No temperature reader")?;
            let now = self.clock.now().as_secs_f64();
            let error = (t - target).abs();
            let ramp = self
                .temp
                .as_mut()
                .unwrap()
                .query(&format!("RAMPST? {loopn}"))?
                != "0";
            if error > num(&s["tol"])? || ramp {
                points.clear();
                continue;
            }
            points.push((now, error));
            let left = now - window;
            while points.len() > 1 && points[1].0 <= left {
                points.remove(0);
            }
            if points.len() > 1 && points[0].0 <= left {
                let mut integral = 0.;
                for w in points.windows(2) {
                    let (a, e0) = w[0];
                    let (b, e1) = w[1];
                    let t = left.max(a);
                    let e = e0 + (e1 - e0) * (t - a) / (b - a);
                    integral += (e + e1) * (b - t) / 2.;
                }
                if integral / window <= num(s.get("mean_tol").unwrap_or(&s["tol"]))? {
                    return Ok(());
                }
            }
        }
        Err("Temperature stabilization timed out".into())
    }
}
