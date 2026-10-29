use crate::protocol::{number, register, Device, Hardware, LockIn, R};
use serde_json::{json, Value};
use std::time::{Duration, Instant};

pub fn model_matches(identity: &str, model: &str) -> bool {
    let id = identity.to_uppercase();
    let raw = id.split(',').nth(1).unwrap_or(&id).trim();
    let raw = raw.strip_prefix("MODEL").unwrap_or(raw).trim();
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
        let raw = s.query("?CNT1")?;
        let count = number(raw.split('=').next_back().unwrap_or(""))?;
        let angle = d
            .counts_per_turn
            .filter(|v| v.is_finite() && *v > 0.)
            .map(|v| count * 360. / v);
        return Ok(
            json!({"ok":true,"identity":format!("{id}; counter={count}"),"counter":count,"angleDeg":angle,"angleType":"absolute"}),
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
        if !model_matches(&s.query("*IDN?")?, source) {
            return Err("Delta source identity mismatch".into());
        }
        if register(&s.query("SOUR:DELT:NVPR?")?)? != 1 {
            return Err("No compatible nanovoltmeter on source RS-232 link".into());
        }
        s.write("SYST:COMM:SER:SEND \"*IDN?\"")?;
        std::thread::sleep(Duration::from_millis(100));
        let id = s.query("SYST:COMM:SER:ENT?")?.trim_matches('"').to_string();
        if !model_matches(&id, &d.model) {
            return Err(format!("Serial nanovoltmeter identity mismatch: {id}"));
        }
        return Ok(
            json!({"ok":true,"identity":format!("{id} via {source} RS-232; delta link detected")}),
        );
    }
    let mut s = hw.open(d)?;
    let id = s.query("*IDN?")?;
    if !model_matches(&id, &d.model) {
        return Err(format!("Instrument identity mismatch: {id}"));
    }
    Ok(json!({"ok":true,"identity":id}))
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
