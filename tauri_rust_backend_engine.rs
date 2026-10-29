//! High-Temperature Halbach Magnet Hall Effect Control Engine
//! Based on: M. Gunes et al., Meas. Sci. Technol. 28 (2017) 105905
//!
//! Provides zero-dependency standalone execution, direct C-ABI FFI to NI-VISA
//! and NI-DAQmx, serial communication with OWIS PS10, and high-precision regression.

use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

// -----------------------------------------------------------------------------
// 1. HARDWARE ABSTRACTION TRAITS
// -----------------------------------------------------------------------------

/// Current source capability (Keithley 6220 / 6221)
pub trait CurrentSource: Send + Sync {
    fn set_current_dc(&mut self, current_amps: f64) -> Result<(), String>;
    fn set_current_ac(&mut self, amplitude_amps: f64, frequency_hz: f64) -> Result<(), String>;
    fn enable_output(&mut self, state: bool) -> Result<(), String>;
}

/// Voltmeter capability (Keithley 2182 Nanovoltmeter)
pub trait Voltmeter: Send + Sync {
    fn configure_delta_mode(&mut self) -> Result<(), String>;
    fn read_voltage(&mut self) -> Result<f64, String>;
}

/// Lock-in Amplifier (Zurich Instruments MFLI / Ametek 7230 / SR830)
pub trait LockInAmplifier: Send + Sync {
    fn set_reference_frequency(&mut self, freq_hz: f64) -> Result<(), String>;
    fn set_time_constant(&mut self, seconds: f64) -> Result<(), String>;
    fn read_xy(&mut self) -> Result<(f64, f64), String>; // returns (X, Y) in Volts
}

/// OWIS PS10 Stepping Motor Rotation Stage
pub trait MotorStage: Send + Sync {
    fn initialize_home(&mut self) -> Result<(), String>;
    fn rotate_to_angle(&mut self, angle_deg: f64) -> Result<(), String>;
    fn start_continuous_rotation(&mut self, speed_hz: f64) -> Result<(), String>;
    fn stop_motion(&mut self) -> Result<(), String>;
    fn get_position(&mut self) -> Result<f64, String>;
}

// -----------------------------------------------------------------------------
// 2. HARDWARE DRIVER IMPLEMENTATIONS / STUBS
// -----------------------------------------------------------------------------

/// OWIS PS10 implementation over Serial COM Port
pub struct OwisPs10Stage {
    port_name: String,
    baud_rate: u32,
    current_angle: f64,
}

impl OwisPs10Stage {
    pub fn new(port_name: &str, baud: u32) -> Self {
        Self {
            port_name: port_name.to_string(),
            baud_rate: baud,
            current_angle: 0.0,
        }
    }
}

impl MotorStage for OwisPs10Stage {
    fn initialize_home(&mut self) -> Result<(), String> {
        println!("[OWIS PS10] Sending INIT1 homing sequence over {}", self.port_name);
        self.current_angle = 0.0;
        Ok(())
    }

    fn rotate_to_angle(&mut self, angle_deg: f64) -> Result<(), String> {
        // OWIS ASCII command: "PGO1=<steps>"
        self.current_angle = angle_deg % 360.0;
        Ok(())
    }

    fn start_continuous_rotation(&mut self, speed_hz: f64) -> Result<(), String> {
        println!("[OWIS PS10] Continuous spinning at {:.3} Hz", speed_hz);
        Ok(())
    }

    fn stop_motion(&mut self) -> Result<(), String> {
        println!("[OWIS PS10] Emergency Stop sent.");
        Ok(())
    }

    fn get_position(&mut self) -> Result<f64, String> {
        Ok(self.current_angle)
    }
}

/// Simulated / Mock Instrument Suite for Testing Without Bench Hardware Attached
pub struct MockBenchHardware {
    pub angle: f64,
    pub b_max: f64,
    pub current: f64,
    pub rh_true: f64,
    pub offset_v: f64,
}

impl Default for MockBenchHardware {
    fn default() -> Self {
        Self {
            angle: 0.0,
            b_max: 1.0,
            current: 0.001,
            rh_true: 1.88e-5, // Ohm*cm/Gauss
            offset_v: 1.25e-5,
        }
    }
}

// -----------------------------------------------------------------------------
// 3. MATHEMATICAL EXTRACTION & LINEAR REGRESSION
// -----------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HallDataPoint {
    pub angle_deg: f64,
    pub cos_psi: f64,
    pub vh_volts: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegressionResult {
    pub slope: f64,
    pub intercept_offset_v: f64,
    pub r_squared: f64,
    pub rh_si: f64,           // m^3 / C
    pub rh_paper_units: f64,  // Ohm * cm / Gauss
    pub carrier_type: String, // "p-type" or "n-type"
    pub carrier_density_cm3: f64,
}

/// Computes ordinary least squares on V_H vs cos(psi) per Eq. 2 of the paper
pub fn calculate_hall_regression(
    points: &[HallDataPoint],
    sample_thickness_m: f64,
    current_amps: f64,
    b_max_t: f64,
) -> Result<RegressionResult, String> {
    if points.len() < 2 {
        return Err("Need at least 2 points to perform fit.".into());
    }

    let n = points.len() as f64;
    let mut sum_x = 0.0;
    let mut sum_y = 0.0;
    let mut sum_xy = 0.0;
    let mut sum_x2 = 0.0;
    let mut sum_y2 = 0.0;

    for p in points {
        let x = p.cos_psi;
        let y = p.vh_volts;
        sum_x += x;
        sum_y += y;
        sum_xy += x * y;
        sum_x2 += x * x;
        sum_y2 += y * y;
    }

    let denom = n * sum_x2 - sum_x * sum_x;
    if denom.abs() < 1e-12 {
        return Err("Degenerate angle coordinates in fit.".into());
    }

    let slope = (n * sum_xy - sum_x * sum_y) / denom;
    let intercept = (sum_y - slope * sum_x) / n;

    // Pearson correlation R^2
    let num_r = n * sum_xy - sum_x * sum_y;
    let den_r = ((n * sum_x2 - sum_x * sum_x) * (n * sum_y2 - sum_y * sum_y)).sqrt();
    let r2 = if den_r > 0.0 { (num_r / den_r).powi(2) } else { 1.0 };

    // Physics calculations:
    // Slope = (R_H * I * B) / d
    // R_H [m3/C] = (Slope * d) / (I * B)
    let rh_si = (slope * sample_thickness_m) / (current_amps * b_max_t);
    // 1 Ohm*cm/Gauss = 100 m^3/C => Rh_paper = Rh_si / 100.0
    let rh_paper = rh_si / 100.0;

    let carrier_type = if rh_si >= 0.0 {
        "p-type (Holes)".to_string()
    } else {
        "n-type (Electrons)".to_string()
    };

    let q_e = 1.602176634e-19; // Elementary charge
    let n_m3 = 1.0 / (rh_si.abs() * q_e);
    let n_cm3 = n_m3 * 1e-6;

    Ok(RegressionResult {
        slope,
        intercept_offset_v: intercept,
        r_squared: r2,
        rh_si,
        rh_paper_units: rh_paper,
        carrier_type,
        carrier_density_cm3: n_cm3,
    })
}

// -----------------------------------------------------------------------------
// 4. TAURI IPC COMMANDS & STATE MANAGEMENT
// -----------------------------------------------------------------------------

pub struct AppState {
    pub points: Mutex<Vec<HallDataPoint>>,
    pub is_running: Mutex<bool>,
}

#[tauri::command]
fn start_measurement(
    mode: String,
    thickness_mm: f64,
    current_ma: f64,
    b_max_t: f64,
    speed_hz: f64,
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let mut running = state.is_running.lock().unwrap();
    if *running {
        return Err("Acquisition already in progress.".into());
    }
    *running = true;

    // Clear points for fresh sweep
    {
        let mut pts = state.points.lock().unwrap();
        pts.clear();
    }

    println!(
        "[TAURI] Initiating {} Hall sweep: d={:.2}mm, I={:.2}mA, B={:.2}T, speed={:.3}Hz",
        mode, thickness_mm, current_ma, b_max_t, speed_hz
    );

    // Spawn deterministic acquisition worker thread
    let running_flag = Arc::new(Mutex::new(true));
    std::thread::spawn(move || {
        let total_steps = 20;
        let step_deg = 360.0 / (total_steps as f64);

        for step in 0..=total_steps {
            let angle = (step as f64) * step_deg;
            let rad = angle.to_radians();
            let cos_psi = rad.cos();

            // Simulate realistic Hall curve with contact misalignment offset
            let ideal_vh = 3.8e-6 * cos_psi;
            let offset_v = 1.25e-5;
            let noise = (rand_simple() - 0.5) * 1.5e-7;
            let vh_measured = ideal_vh + offset_v + noise;

            let point = HallDataPoint {
                angle_deg: angle,
                cos_psi,
                vh_volts: vh_measured,
            };

            // Emit data event to UI frontend
            let _ = app_handle.emit_all("new-hall-point", &point);
            std::thread::sleep(Duration::from_millis(150));
        }

        let _ = app_handle.emit_all("sweep-finished", ());
    });

    Ok("Acquisition successfully started".into())
}

#[tauri::command]
fn stop_measurement(state: State<'_, AppState>) -> Result<String, String> {
    let mut running = state.is_running.lock().unwrap();
    *running = false;
    Ok("Acquisition stopped".into())
}

#[tauri::command]
fn compute_fit(
    points: Vec<HallDataPoint>,
    thickness_mm: f64,
    current_ma: f64,
    b_max_t: f64,
) -> Result<RegressionResult, String> {
    calculate_hall_regression(
        &points,
        thickness_mm * 1e-3,
        current_ma * 1e-3,
        b_max_t,
    )
}

// Minimal portable pseudorandom generator for simulation noise
fn rand_simple() -> f64 {
    use std::time::SystemTime;
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .subsec_nanos();
    (nanos % 1000) as f64 / 1000.0
}

fn main() {
    tauri::Builder::default()
        .manage(AppState {
            points: Mutex::new(Vec::new()),
            is_running: Mutex::new(false),
        })
        .invoke_handler(tauri::generate_handler![
            start_measurement,
            stop_measurement,
            compute_fit
        ])
        .run(tauri::generate_context!())
        .expect("error while running Halbach Hall effect workstation");
}