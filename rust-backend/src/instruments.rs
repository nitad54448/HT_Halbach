use crate::protocol::{number, register, Device, Hardware, LockIn, Session, R};
use serde_json::{json, Value};
use std::time::{Duration, Instant};

// Host command pacing for the 622x-to-2182 RS-232 bridge, independent of
// SOUR:DELT:DEL (the current-polarity settling delay inside a measurement).
pub const DELTA_COMMAND_WAIT: Duration = Duration::from_millis(200);

fn clean_identity(identity: &str) -> &str {
    identity.trim_matches(|c: char| c.is_whitespace() || ['"', '\u{11}', '\u{13}'].contains(&c))
}
fn query_identity(s: &mut dyn Session, d: &Device) -> R<String> {
    s.query("*IDN?")
        .map(|id| clean_identity(&id).into())
        .map_err(|e| {
            format!(
                "Cannot identify {} at {:?} (expected {}): {e}",
                d.role, d.address, d.model
            )
        })
}
pub fn model_matches(identity: &str, model: &str) -> bool {
    let id = clean_identity(identity).to_uppercase();
    let raw = id
        .split(',')
        .nth(1)
        .unwrap_or(&id)
        .trim()
        .trim_matches('"')
        .trim();
    let raw = raw
        .strip_prefix("MODEL")
        .unwrap_or(raw)
        .trim_start_matches([' ', ':', '='])
        .trim();
    let expected = match model {
        "K6220" => "6220",
        "K6221" => "6221",
        "K2182" => "2182",
        "K2182A" => "2182A",
        "SR830" => "SR830",
        "LS332" => "332",
        "LS335" => "335",
        "LS155" => "155",
        "MFLI" => "MFLI",
        _ => return false,
    };
    raw == expected
}
fn identity_error(d: &Device, identity: &str) -> String {
    let received = if identity.trim().is_empty() {
        "an empty *IDN? reply".to_string()
    } else {
        format!("*IDN? reply {identity:?}")
    };
    format!(
        "Instrument identity mismatch: {} at {:?}; expected {}, received {}. Check the selected model and the VISA resource/alias in NI MAX.",
        d.role, d.address, d.model, received
    )
}
pub fn open_lockin(hw: &mut dyn Hardware, d: &Device) -> R<LockIn> {
    LockIn::new(hw.open(d)?, d)
}
pub fn check(hw: &mut dyn Hardware, d: &Device) -> R<Value> {
    if d.model == "NI9361" && d.role == "position" {
        let mut r = hw.optical(d)?;
        r["ok"] = json!(true);
        return Ok(r);
    }
    if ["SR830", "AMETEK7230", "MFLI"].contains(&d.model.as_str()) && d.role.starts_with("lockin") {
        let id = open_lockin(hw, d)?.identify()?;
        return Ok(json!({"ok":true,"identity":id}));
    }
    if d.model == "OWISPS10" && ["motion", "position"].contains(&d.role.as_str()) {
        let mut s = hw.open(d)?;
        let id = s.query("?VERSION")?;
        if !id.replace(' ', "").to_uppercase().contains("PS10") {
            return Err("Controller did not identify as PS10".into());
        }
        let axis = d.axis.unwrap_or(1);
        if !(1..=9).contains(&axis) {
            return Err("OWIS axis must be between 1 and 9".into());
        }
        let raw = s.query(&format!("?CNT{axis}"))?;
        let count = number(raw.split('=').next_back().unwrap_or(""))?;
        let stage_angle = d
            .counts_per_turn
            .filter(|v| v.is_finite() && *v > 0.)
            .map(|v| count * 360. / v);
        let sign = d.dir_sign.unwrap_or(1.);
        let offset = d.angle_offset_deg.unwrap_or(0.);
        if ![1., -1.].contains(&sign) || !offset.is_finite() {
            return Err("Invalid field-angle calibration".into());
        }
        let angle = stage_angle.map(|a| sign * a + offset);
        return Ok(
            json!({"ok":true,"identity":format!("{id}; counter={count}"),"counter":count,"stageAngleDeg":stage_angle,"angleDeg":angle,"angleType":"absolute"}),
        );
    }
    if ![
        "K6220", "K6221", "K2182", "K2182A", "LS332", "LS335", "LS155", "MFLI",
    ]
    .contains(&d.model.as_str())
    {
        return Err(format!("No implemented driver for {}", d.model));
    }
    if d.connection.as_deref() == Some("delta") {
        let source = d
            .source_model
            .as_deref()
            .ok_or("Missing delta source model")?;
        if !["K6220", "K6221"].contains(&source) {
            return Err("Delta requires 6220 or 6221".into());
        }
        let upper = d.address.to_uppercase();
        if upper.starts_with("COM") || upper.starts_with("ASRL") {
            return Err("Delta reserves source RS-232 for the voltmeter; use GPIB or 6221 Ethernet for the PC".into());
        }
        let mut sd = d.clone();
        sd.model = source.into();
        sd.role = "source".into();
        let mut s = hw.open(&sd)?;
        let source_id = query_identity(s.as_mut(), &sd)?;
        if !model_matches(&source_id, source) {
            return Err(identity_error(&sd, &source_id));
        }
        if register(&s.query("SOUR:DELT:NVPR?")?)? != 1 {
            return Err("No compatible nanovoltmeter on source RS-232 link".into());
        }
        std::thread::sleep(DELTA_COMMAND_WAIT);
        s.write("SYST:COMM:SER:SEND \"*IDN?\"")?;
        let id = delta_identity(s.as_mut(), d)?;
        if !model_matches(&id, &d.model) {
            return Err(format!(
                "{} Voltmeter was queried through the source RS-232 link.",
                identity_error(d, &id)
            ));
        }
        std::thread::sleep(DELTA_COMMAND_WAIT);
        return Ok(
            json!({"ok":true,"identity":format!("{id} via {source} RS-232; delta link detected")}),
        );
    }
    let mut s = hw.open(d)?;
    let id = query_identity(s.as_mut(), d)?;
    if !model_matches(&id, &d.model) {
        return Err(identity_error(d, &id));
    }
    Ok(json!({"ok":true,"identity":id}))
}

fn delta_identity(s: &mut dyn Session, d: &Device) -> R<String> {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        std::thread::sleep(DELTA_COMMAND_WAIT);
        let response = s
            .query("SYST:COMM:SER:ENT?")
            .map_err(|e| format!("Cannot identify linked {} at {:?}: {e}", d.model, d.address))?;
        let id = clean_identity(&response);
        if !id.is_empty() {
            return Ok(id.into());
        }
        if Instant::now() >= deadline {
            return Err(identity_error(d, id));
        }
    }
}

#[cfg(test)]
mod identity_tests {
    use super::*;
    use crate::protocol::Session;

    struct Owis;
    impl Session for Owis {
        fn write(&mut self, _: &str) -> R<()> {
            Err("Connection checks must not write commands".into())
        }
        fn query(&mut self, command: &str) -> R<String> {
            match command {
                "?VERSION" => Ok("PS10-V3.0".into()),
                "?CNT2" => Ok("CNT2=12500".into()),
                _ => Err(format!("Unexpected query: {command}")),
            }
        }
    }
    impl Hardware for Owis {
        fn open(&mut self, _: &Device) -> R<Box<dyn Session>> {
            Ok(Box::new(Owis))
        }
        fn optical(&mut self, _: &Device) -> R<Value> {
            Err("No optical reader".into())
        }
    }

    #[test]
    fn owis_readback_applies_plus_b_reference_and_selected_axis() {
        let mut d = Device {
            role: "position".into(),
            model: "OWISPS10".into(),
            address: "COM4".into(),
            axis: Some(2),
            counts_per_turn: Some(50000.),
            dir_sign: Some(-1.),
            angle_offset_deg: Some(30.),
            ..Default::default()
        };
        let read = check(&mut Owis, &d).unwrap();
        assert_eq!(read["stageAngleDeg"], 90.);
        assert_eq!(read["angleDeg"], -60.);
        d.angle_offset_deg = Some(90.);
        assert_eq!(check(&mut Owis, &d).unwrap()["angleDeg"], 0.);
        d.dir_sign = Some(0.);
        assert!(check(&mut Owis, &d).is_err());
    }

    #[test]
    fn scpi_identity_formats_keep_exact_model_checks() {
        for (id, model) in [
            (
                "KEITHLEY INSTRUMENTS INC.,MODEL 6220,1234567,A01\r\n",
                "K6220",
            ),
            ("Keithley Instruments Inc., Model 6221,1234567,D01", "K6221"),
            (
                "KEITHLEY INSTRUMENTS INC.,MODEL 2182A,1234567,C01",
                "K2182A",
            ),
            ("LSCI,MODEL335,1234567,1.4", "LS335"),
            ("LSCI,MODEL332,1234567,1.0", "LS332"),
            (
                "\"KEITHLEY INSTRUMENTS INC.,MODEL 6220,1234567,A01\"",
                "K6220",
            ),
            ("LSCI,\"MODEL 335\",1234567,1.4", "LS335"),
        ] {
            assert!(model_matches(id, model), "{id:?} should match {model}");
        }
        for id in [
            "",
            "\r\n",
            "62201",
            "KEITHLEY,MODEL 6221,123,A01",
            "VENDOR,6220A,123,A01",
        ] {
            assert!(!model_matches(id, "K6220"), "unexpected match: {id:?}");
        }
        assert!(!model_matches("KEITHLEY,MODEL 2182A,123,A01", "K2182"));
    }

    #[test]
    fn mismatch_reports_expected_model_address_and_empty_reply() {
        let d = Device {
            role: "source".into(),
            model: "K6220".into(),
            address: "6220".into(),
            ..Default::default()
        };
        let message = identity_error(&d, "\r\n");
        assert!(message.contains("source at \"6220\"; expected K6220"));
        assert!(message.contains("empty *IDN? reply"));
        assert!(identity_error(&d, "KEITHLEY,MODEL 6221,123,A01").contains("MODEL 6221"));
    }

    #[test]
    fn linked_voltmeter_waits_for_id_and_removes_flow_control_wrappers() {
        struct Delayed {
            polls: usize,
        }
        impl Session for Delayed {
            fn write(&mut self, _: &str) -> R<()> {
                panic!("Must not resend the forwarded identity query")
            }
            fn query(&mut self, command: &str) -> R<String> {
                assert_eq!(command, "SYST:COMM:SER:ENT?");
                self.polls += 1;
                Ok(if self.polls < 3 {
                    "\"\u{13}\r\n\u{11}\""
                } else {
                    "\u{13}KEITHLEY INSTRUMENTS INC.,MODEL 2182A,1260356,C02 /A02 \u{11}"
                }
                .into())
            }
        }
        let mut s = Delayed { polls: 0 };
        let d = Device {
            role: "voltmeter".into(),
            model: "K2182A".into(),
            address: "6220".into(),
            ..Default::default()
        };
        let id = delta_identity(&mut s, &d).unwrap();
        assert_eq!(s.polls, 3);
        assert_eq!(id, "KEITHLEY INSTRUMENTS INC.,MODEL 2182A,1260356,C02 /A02");
        assert!(model_matches(&id, &d.model));
        assert!(!model_matches(&id, "K2182"));
    }
}
pub fn read(hw: &mut dyn Hardware, d: &Device) -> R<Value> {
    if ["motion", "position"].contains(&d.role.as_str()) {
        return check(hw, d);
    }
    check(hw, d)?;
    if ["SR830", "AMETEK7230", "MFLI"].contains(&d.model.as_str()) {
        let (x, y) = open_lockin(hw, d)?.read_xy()?;
        return Ok(json!({"X":x,"Y":y}));
    }
    let mut s = hw.open(d)?;
    match d.model.as_str() {
        "LS332" | "LS335" => {
            let input = d.input.as_deref().unwrap_or("A");
            if !["A", "B"].contains(&input) {
                return Err("Invalid temperature input".into());
            }
            Ok(json!({"temperatureK":number(&s.query(&format!("KRDG? {input}"))?)?}))
        }
        "K2182" | "K2182A" if d.connection.as_deref() != Some("delta") => {
            Ok(json!({"voltageV":number(&s.query("READ?")?)?}))
        }
        _ => Err("Read operation is not implemented for this role".into()),
    }
}
pub fn wait_reference(hw: &mut dyn Hardware, d: &Device) -> R<Value> {
    let timeout = d.lock_timeout.unwrap_or(30.);
    if !timeout.is_finite() || timeout <= 0. || timeout > 600. {
        return Err("Lock timeout must be >0 and <=600 seconds".into());
    }
    let mut driver = open_lockin(hw, d)?;
    driver.identify()?;
    driver.reference()?;
    driver.clear_unlock()?;
    let deadline = Instant::now() + Duration::from_secs_f64(timeout);
    let mut stable = 0;
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(100));
        let unlocked = driver.unlocked()?;
        let frequency = driver.frequency()?;
        stable = if !unlocked && frequency > 0. {
            stable + 1
        } else {
            0
        };
        if stable >= 3 {
            return Ok(json!({"ok":true,"frequencyHz":frequency}));
        }
    }
    Err(format!(
        "No stable TTL Ref In lock within {timeout} seconds"
    ))
}
