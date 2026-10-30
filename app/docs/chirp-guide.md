# CHIRP: Current-Hopping Interleaved Rotation Protocol

## Hall measurements with a rotating Halbach magnet and AC lock-in detection

A practical guide for graduate students. This version uses sinusoidal current excitation, initially in the **500–900 Hz range**, and a slowly rotating magnetic field. It explains the assumptions behind the measurement as well as how to build, acquire, fit, and check it.

**Start with the ordinary Hall measurement at zero sample tilt.** Add planar Hall measurements after the ordinary Hall result passes the calibration and repeatability checks. The numerical settings below are starting points to test on your apparatus, not guaranteed instrument performance.

### Contents

1. What is measured, and what is assumed
2. Two frequencies and two kinds of phase
3. Geometry, contacts, and signs
4. Deriving the transport signals
5. What survives lock-in detection
6. Hardware and choosing the carrier frequency
7. Filters, timing, and current-step settling
8. Selecting tilt and the measurement sequence
9. Logging and fitting the data
10. Extracting physical quantities
11. Uncertainty and detection limits
12. Commissioning the apparatus
13. Higher harmonics and limits of interpretation
14. Worked examples
15. Troubleshooting and reporting
16. References

---

## 1. What is measured, and what is assumed

An ordinary Hall measurement detects a transverse voltage: current flows along a sample, a magnetic field deflects the carriers, and a voltage develops across its width. The voltage can be much smaller than the unwanted longitudinal voltage picked up by imperfectly aligned contacts.

CHIRP uses two separations:

- **Electrical frequency:** sinusoidal current moves the desired response to a carrier frequency where a lock-in can reject slowly varying voltages and much of the broadband noise.
- **Field angle:** rotation makes the ordinary Hall response change sign once per half-turn. A fit separates this angular pattern from a constant contact offset and, under an appropriate material model, from a planar Hall response.

Changing the current amplitude provides additional tests of linearity and current-independent interference. Running the magnet in both directions tests timing and mechanical errors. Neither operation is a universal mathematical requirement for extracting a Hall coefficient from a well-behaved lock-in measurement.

### 1.1 Outputs

| Output | What is needed in addition to voltage, current, and angle |
|---|---|
| Ordinary Hall amplitude per ampere | Calibrated electrical gain and phase |
| Hall coefficient $R_H$ | Field magnitude, conducting thickness, and valid sample geometry |
| Hall sheet density $n_{s,H}$ | Field magnitude and valid geometry |
| Hall mobility $\mu_H$ | A separate sheet-resistance measurement |
| Planar transverse coefficient $K$ | A validated quadratic transport model, field, thickness, and geometry |
| Dimensionless planar coefficient $C$ | Ordinary and planar coefficients, plus zero-field sheet resistance, under the model in Section 4 |
| Additional angular harmonics | Further measurements before assigning a microscopic explanation |

The Hall density is not automatically the actual carrier density. A scattering factor, multiple carrier populations, anomalous Hall contributions, or spatial inhomogeneity can change its interpretation.

### 1.2 Baseline assumptions

The introductory model assumes:

1. The sample is homogeneous enough to have a meaningful transport tensor and conducting thickness.
2. Contacts are ohmic; the chosen current does not significantly change temperature or transport coefficients.
3. The measured electrical response is effectively resistive over the chosen carrier-frequency range, after checking the wiring and instruments.
4. The material response follows the slowly rotating field without appreciable hysteresis or relaxation.
5. The ordinary Hall coefficient is independent of field orientation in the geometry studied.
6. The second-order symmetric transverse response can be represented by a coefficient multiplying $B_jB_t$.

These are testable assumptions, not properties of every semiconductor or metal. In a crystal with strong anisotropy, a magnetic sample, a heterogeneous film, or a nonlinear Hall regime, fit amplitudes may remain useful but the simple conversion to material parameters can fail.

### 1.3 Sample geometry matters

The derivations use a uniform bar with current density $j=I/(wd)$ and transverse probe separation $w$. They are also useful idealizations for a properly characterized Hall structure.

Four contacts drawn in a cross do **not** establish that these formulas apply quantitatively. Finite contacts, current spreading, and sample shape can change the measured voltages. Standard van der Pauw Hall measurements have their own geometry assumptions; extracting a symmetric planar transverse tensor component generally requires separate justification. See [3] and [4].

For an unfamiliar geometry, retain the measured angular coefficients and establish the geometric corrections before reporting intrinsic $R_H$ or $K$. A reference sample checks the instrument and sign convention, but does not remove geometry errors specific to a different specimen.

---

## 2. Two frequencies and two kinds of phase

Use separate symbols throughout:

| Symbol | Meaning | Typical starting value |
|---|---|---|
| $f_c$ | Electrical carrier frequency | A tested value between 500 and 900 Hz |
| $\theta(t)$ | Direction of the magnetic field | Measured by a calibrated encoder |
| $\omega(t)=d\theta/dt$ | Signed angular velocity | rad/s |
| $f_r=|\omega|/(2\pi)$ | Mechanical rotation frequency during a constant-speed segment | 0.1–0.3 Hz for commissioning |
| $I(t)$ | Slowly changing RMS current amplitude | Selected for the sample |
| $i(t)$ | Instantaneous signed current | $\sqrt{2}I(t)\cos(2\pi f_ct)$ |

Even when the amplitude $I(t)$ is positive, **the actual AC current reverses every half electrical cycle**. “Unipolar amplitude levels” means nonnegative envelope settings; it does not mean unidirectional current through the specimen.

If the Hall resistance varies as $\cos\theta$, the raw Hall voltage is proportional to

$$
\cos(2\pi f_ct)\cos\theta(t).
$$

At constant rotation speed this produces sidebands at $f_c-f_r$ and $f_c+f_r$. Demodulation moves the slowly changing Hall envelope back to $f_r$. The planar term similarly becomes an envelope at $2f_r$.

Thus:

- The lock-in **X/Y phase** refers to the electrical carrier.
- The distinction between $\cos\theta$, $\sin\theta$, and $\sin2\theta$ refers to the mechanical angle.

The ordinary Hall, planar Hall, and longitudinal leakage voltages can all be electrically in phase with current and therefore all appear in X. X/Y separation does not separate their angular patterns.

For phase-sensitive detection and instrument conventions, see [1]. The sideband relationships above follow directly by multiplying the two cosines.

---

## 3. Geometry, contacts, and signs

The following definitions fix the sign of the reported Hall coefficient. Write them in the experiment log and verify them physically.

![CHIRP sample orientation, contact polarities, tilt, and field-angle conventions](images/chirp_orientation.svg)

*Figure 1. Original geometry illustration. Panel (a) shows zero tilt; panel (b) shows a positive 30-degree tilt, with I+ moving toward the observer and downward. The lower-left panel defines the field angle viewed from above. The vector definitions and field projections in the lower-right panel agree with this guide.*

**Equation-panel note:** the lower-right voltage equation is retained from the original illustration and is superseded by Sections 5 and 9. In particular, its raw Faraday and thermal terms must not be interpreted as unchanged contributions to the lock-in X output. Use the filtered envelope model in this guide for fitting, and the assumptions in Section 10 for the extraction formulas. “NHE only” and “PHE only” refer to the baseline transport model, not the absence of all parasitic signals.

### 3.1 Laboratory axes and field

The Halbach bore axis is vertical. Its ideal transverse field lies in the horizontal plane.

Standing in front of the magnet:

| Axis | Direction |
|---|---|
| $+X$ | From the magnet toward you |
| $+Y$ | To your right |
| $+Z$ | Up, along the bore |

This is a right-handed coordinate system. Define

$$
\mathbf B(\theta)=B[\cos\theta,\ \sin\theta,\ 0],\qquad B>0.
$$

| Angle | Field direction |
|---|---|
| $0^\circ$ | Toward you, $+X$ |
| $90^\circ$ | To your right, $+Y$ |
| $180^\circ$ | Away from you, $-X$ |
| $270^\circ$ | To your left, $-Y$ |

The encoder must report **field direction**, after calibration. Do not assume its mechanical zero, direction, or angular scale already equals the magnetic-field angle. Map the field at the sample position, including any nonuniform angular motion or out-of-plane component.

### 3.2 Contacts at zero tilt

At $\psi=0$, the sample lies in the YZ plane. Viewed toward the magnet:

| Contact | Position |
|---|---|
| I+ | Top |
| I− | Bottom |
| V+ | Right |
| V− | Left |

During the positive half-cycle, conventional current enters I+ and leaves I−. Define $\hat{\jmath}$ along that direction and $\hat t$ from V− to V+.

The measured voltage is

$$
V=U(\mathrm{V+})-U(\mathrm{V-}).
$$

For a uniform transverse electric field and probe separation $w$,

$$
V=-w\,\mathbf E\cdot\hat t.
$$

The minus sign follows from $\mathbf E=-\nabla U$. It must be retained when translating a transport tensor into a measured terminal voltage.

### 3.3 Tilt

Tilt the sample by a right-handed rotation $\psi$ about $+Y$. The normal moves from $+X$ toward $-Z$; the top current contact moves toward you and downward.

$$
\hat n=[\cos\psi,0,-\sin\psi],\qquad
\hat{\jmath}=[-\sin\psi,0,-\cos\psi],\qquad
\hat t=[0,1,0].
$$

These obey $\hat{\jmath}\times\hat t=\hat n$. Projecting the field gives

$$
\boxed{
B_n=B\cos\theta\cos\psi,\qquad
B_j=-B\cos\theta\sin\psi,\qquad
B_t=B\sin\theta.
}
$$

Check the limiting cases:

- At $\psi=0$, $B_j=0$: the baseline planar term vanishes.
- At $\psi=90^\circ$, $B_n=0$: the ordinary Hall term vanishes.

Measure $\psi$ independently. Fitting a Hall amplitude and an unknown tilt from the same amplitude alone cannot determine both.

### 3.4 Sign checks

Swapping only the voltage leads reverses every measured voltage. Swapping only the current leads reverses the resistive voltage relative to an unchanged electrical reference. Reversing encoder sense changes the sign of sine harmonics but not cosine harmonics, provided the same zero is retained. Reversing the tilt sense changes the baseline planar term's sign.

Verify the complete chain with a reference of known carrier sign. In this guide's wiring, an electron-like ordinary Hall response gives a **positive** coefficient of $I\cos\theta$ at zero tilt.

Do not use a rule such as “flipping the sample reverses the Hall sign” without specifying exactly how the contacts, wiring, sample normal, and field coordinates are transformed.

---

## 4. Deriving the transport signals

### 4.1 Ordinary Hall effect

Use the convention

$$
\mathbf E_H=R_H(\mathbf B\times\mathbf j).
$$

For a single classical carrier population with charge $q$, $R_H=1/(nq)$ in the simplest model. Electrons have $q=-e$, so $R_H<0$.

Because $\hat{\jmath}\times\hat t=\hat n$,

$$
\mathbf E_H\cdot\hat t=R_HjB_n.
$$

Substitution of $j=i/(wd)$ and the measured-voltage convention gives

$$
v_H(t)=-\frac{R_H}{d}i(t)B_n(t).
$$

After ideal RMS-referred demodulation, its envelope is

$$
u_H(t)=\beta_1 I(t)\cos\theta(t)\cos\psi,
\qquad
\boxed{\beta_1=-\frac{R_HB}{d}}.
$$

Here $\beta_1$ is in ohms, equivalently V/A. It is an angular voltage amplitude per ampere, not a voltage.

### 4.2 Symmetric transverse response: the planar term

For the baseline nonmagnetic, approximately isotropic quadratic model, write the relevant symmetric transverse electric field as

$$
E_{t,P}=KjB_jB_t.
$$

$K$ has units $\Omega\,\mathrm m/\mathrm T^2$ and can have either sign. This equation is the material assumption being tested. It does not assert that every conductor has an observable planar Hall effect.

The terminal voltage is

$$
v_P=-\frac{K}{d}iB_jB_t.
$$

Since

$$
B_jB_t=-\frac{B^2}{2}\sin\psi\sin2\theta,
$$

the demodulated envelope is

$$
u_P(t)=\beta_2I(t)\sin2\theta(t)\sin\psi,
\qquad
\boxed{\beta_2=\frac{KB^2}{2d}}.
$$

The ordinary Hall term is odd under field reversal; this planar term is even. This is a useful symmetry distinction even when their magnitudes are very different.

For stopped, settled measurements at the same current amplitude, define the signed transverse resistance $R_T(\theta)=X(\theta)/I$. The combination

$$
R_{\mathrm{odd}}(\theta)=\frac{R_T(\theta)-R_T(\theta+\pi)}{2}
$$

removes contributions that are even under field reversal, including stable ordinary longitudinal leakage. The corresponding half-sum retains the even part. This is an intuitive check of the angular fit. It does not remove an artifact that is itself odd in field, and drift between the paired readings can contaminate the difference.

In a basic isotropic single-band Drude model with a constant relaxation time, resistivity has no ordinary orbital magnetoresistance and this symmetric quadratic coefficient is zero. A nonzero $K$ requires additional material physics. Crystal anisotropy can also require more tensor coefficients than this one-term model contains.

### 4.3 Optional dimensionless coefficient

Define

$$
\mu_H=\frac{|R_H|}{\rho_0},\qquad
K=\rho_0C\mu_H^2,
$$

where $\rho_0$ is the zero-field resistivity at the measurement temperature. Then

$$
\beta_2=\frac{\rho_0C\mu_H^2B^2}{2d}.
$$

This defines a convenient normalization $C$; it is not a universal predicted constant. Report $K$ or the measured $\beta_2$ when $R_H$ is near zero, because normalizing by $R_H^2$ makes $C$ unstable or undefined.

For ferromagnets, planar Hall signals are often described using magnetization direction and an anisotropic resistivity difference. The expressions above must not be applied by simply substituting the applied field for magnetization. Even a saturated ferromagnet can have an anomalous Hall contribution at the same angular harmonic as ordinary Hall.

### 4.4 Longitudinal leakage

Slight longitudinal misalignment of the voltage contacts produces an approximately angle-independent envelope $b_0I$. Longitudinal magnetoresistance can add an even angular modulation, for example $b_{2c}I\cos2\theta$.

In an ideal geometry its phase differs from the planar $\sin2\theta$ term. An angular calibration error rotates one into the other. More general anisotropy or contact geometry can also produce a longitudinal contribution proportional to $\sin2\theta$, which is indistinguishable from the planar term in this measurement alone.

Therefore **a fitted second sine harmonic is a candidate planar signal**, requiring geometry and longitudinal-response checks before it is assigned to $K$.

---

## 5. What survives lock-in detection

### 5.1 Raw voltage versus the measured envelope

A useful schematic raw-input equation is

$$
v_{\mathrm{raw}}(t)=\sqrt{2}\,u(t)\cos(2\pi f_ct)
+p(t)+e_{\mathrm{th}}(t)+v_q(t)+\eta(t),
$$

where:

- $u(t)$ is the in-phase transport envelope, including Hall voltage and longitudinal leakage;
- $p(t)$ is low-frequency Faraday pickup from the rotating field;
- $e_{\mathrm{th}}(t)$ is a slowly varying thermoelectric voltage;
- $v_q(t)$ includes carrier-frequency quadrature signals;
- $\eta(t)$ is noise.

The lock-in multiplies by a reference and low-pass filters the result. With RMS calibration and correct phase, write

$$
X(t)\simeq\mathcal L[u(t)]+o_X(t)+\epsilon_X(t).
$$

$\mathcal L$ represents the demodulator's envelope filter and acquisition response. $o_X$ denotes an output offset or other empirically established baseband background. See [1] for the detection principle.

Slow raw thermoelectric voltage is shifted toward the carrier frequency by mixing and rejected. Slow Faraday pickup is also rejected, subject to finite filter rejection and input linearity. They do **not** normally remain as unchanged slow terms in X.

### 5.2 Baseline envelope model

Use

$$
u(t)=I(t)\left[
b_0+A_1\cos\theta+D_1\sin\theta
+A_2\sin2\theta+b_{2c}\cos2\theta
\right],
$$

with

$$
A_1=\beta_1\cos\psi,\qquad A_2=\beta_2\sin\psi.
$$

| Coefficient | Interpretation under the baseline model | Units |
|---|---|---|
| $A_1$ | Measured ordinary Hall coefficient before tilt correction | $\Omega$ |
| $D_1$ | First-harmonic quadrature in **angle**; useful diagnostic | $\Omega$ |
| $A_2$ | Measured planar coefficient before tilt correction | $\Omega$ |
| $b_0$ | Angle-independent current-proportional transverse resistance | $\Omega$ |
| $b_{2c}$ | Second cosine harmonic, often longitudinal MR leakage | $\Omega$ |

If needed, add a constant output offset $o_0$ and slow output drift $o_1\tilde t$, with $\tilde t=2(t-t_0)/T-1$. These are in volts. Their inclusion does not mean a raw thermal EMF passed unchanged through the lock-in.

### 5.3 What current hopping buys

Varying $I$ can separate $b_0I$ from a current-independent output offset. It also tests current linearity and heating. At fixed $I$, those two constant columns are identical up to scale: combine them into a single nuisance offset instead of fitting an unidentifiable pair.

The angular Hall coefficient can still be measured at fixed amplitude. Start that way during commissioning; add amplitude hopping after the basic measurement works.

### 5.4 Interference that lock-in detection cannot remove

An interference signal at the carrier frequency passes through demodulation. Examples include electrical feedthrough, current-lead coupling, and a carrier-synchronous thermoelectric response. Peltier heating can be current-linear; AC excitation does not guarantee that every thermoelectric effect disappears.

An artifact proportional to $I\cos\theta$ has the same signature as ordinary Hall in this model. No least-squares routine can separate two effects with identical signatures. Change a physical control: frequency, lead routing, contacts, sample orientation, or measurement geometry.

Keep Y. A large Y can reveal capacitance, inductive coupling, an incorrect reference phase, or genuine sample dynamics. It is not proof of any one mechanism. Do not repeatedly auto-phase the sample signal to force Y to zero; that can hide an error or remove the Hall sign.

---

## 6. Hardware and choosing the carrier frequency

### 6.1 Suggested initial configuration

| Item | Starting choice | Verification |
|---|---|---|
| Current waveform | Low-distortion sinusoid | Check delivered current and compliance |
| Carrier $f_c$ | Test clean frequencies within 500–900 Hz | Hall coefficient and phase should be stable |
| Rotation | Constant-speed segments at 0.1–0.3 Hz, both senses | Encoder and stationary-angle comparison |
| Tilt | $\psi=0$ | Independent alignment measurement |
| Lock-in outputs | Signed X and Y | Resistor gain/phase check |
| Envelope filter | For an instrument with conventional RC filters: try 4 poles, $\tau=5$ ms | Confirm actual filter definition, rejection, and settling |
| Output acquisition | For example 500 or 1000 samples/s if supported | Confirm actual update rate and anti-alias behavior |
| Initial current | One conservative nonzero RMS amplitude | Heating, signal size, and linearity |
| Production amplitudes | For example $\{0,I_{\max}/3,2I_{\max}/3,I_{\max}\}$ | Test actual amplitudes, phase, and transients |
| Record length | Several complete rotations per segment | Increase until repeatability meets the target |

These settings belong together. Slowing the rotation relaxes filter tracking requirements. Increasing the output rate does not create additional independent measurements once the output is bandwidth limited.

### 6.2 Is 500–900 Hz high enough?

It is a reasonable **starting band relative to sub-hertz rotation**, but the best frequency is the one that gives a stable calibrated transport response with low interference.

Benefits of moving above very low electrical frequencies include reduced exposure to some drift and low-frequency noise. Costs include larger capacitive currents, changing current-source accuracy, phase errors, and electrical coupling. The apparatus may not have a useful plateau throughout 500–900 Hz.

Select frequencies away from strong measured interference, including mains harmonics and motor-controller lines. Do not choose 500, 600, or 900 Hz merely because they are convenient round numbers. Candidate values such as 517, 733, or 887 Hz are examples to screen, not privileged frequencies. A nearby line can mix into the slow signal band, so separation from interference must be judged against the envelope bandwidth too.

**Frequency test:** at fixed temperature and current, repeat a short Hall measurement at at least three clean carrier frequencies. Calibrate electrical gain and reference phase at each. Compare the fitted coefficient $A_1$, already expressed in V/A, and the Y harmonics. If the results vary beyond uncertainty, investigate before reporting a frequency-independent Hall coefficient. Extend the test below 500 Hz if necessary.

### 6.3 Current source and reference

Use a current source with sufficient voltage compliance and specified AC behavior over the selected band. A lock-in sine-voltage output alone is not a calibrated current source. A voltage source plus a series resistor is acceptable only after establishing the actual sample current, including reactive paths.

Measure current using a calibrated, sufficiently noninductive series sense resistor and a second synchronous channel:

$$
I=\frac{V_{\mathrm{sense,rms}}}{R_{\mathrm{sense}}}.
$$

Check that the sensed current is the current through the active sample region. Cable capacitance or a shunt path downstream of the sense resistor can invalidate that assumption.

Use a continuous reference shared by the source and lock-in. At zero amplitude, the reference must remain present and locked. Avoid phase resets when hopping amplitudes. If a 180-degree excitation phase reversal is used as a diagnostic, keep the reference convention fixed and verify what the source sync output does.

Record actual current amplitude and, preferably, its phase. A filtered current-monitor reading is itself delayed; Section 9 explains how to avoid treating it as instantaneous current.

Set current using both source compliance and sample heating. For a resistive current path of resistance $R_{\mathrm{path}}$, the approximate mean Joule power is $I^2R_{\mathrm{path}}$, with $I$ in RMS amperes; contacts may dissipate additional power. Sinusoidal excitation also produces a heating component at twice the carrier frequency. Changing the amplitude changes the mean heating and can produce a much slower thermal transient.

Begin at low current, increase cautiously, and compare coefficients in V/A at several levels. Check the longitudinal resistance or a thermometer for temperature changes. A response that remains proportional to current over a narrow range is helpful evidence, but is not by itself a complete heating test. There is no universal safe current based only on the expected Hall voltage.

### 6.4 RMS, gain, and electrical phase

Use RMS amperes and input-referred RMS volts throughout. If an external preamplifier has gain $G$, convert its output back to sample volts. Include analog-output scaling if recording a lock-in output with a separate ADC.

At each carrier frequency, test with a known resistor using representative wiring. The corrected ratio must equal the resistor value, and Y should be consistent with its expected reactance. This establishes the gain, reference phase, and peak/RMS convention.

Use signed X for a validated resistive measurement. The magnitude $\sqrt{X^2+Y^2}$ is nonnegative, loses the Hall sign, and is biased upward near the noise floor. If significant complex response remains, retain complex voltage and current and develop a complex response model.

### 6.5 Voltage-input loading and noise

Use the actual specifications of the selected input or preamplifier. “FET” or “bipolar” alone does not establish its input resistance, capacitance, current noise, or suitability. One cannot assign a universal resistance crossover to those labels.

For a simple differential Thevenin source impedance $Z_s$ and input impedance $Z_{\mathrm{in}}$,

$$
V_{\mathrm{meas}}=V_{\mathrm{open}}\frac{Z_{\mathrm{in}}}{Z_s+Z_{\mathrm{in}}}.
$$

Check both amplitude and phase. Cable capacitance may dominate the nominal input capacitance.

For a resistive source $R_s$ with total shunt capacitance $C_{\mathrm{tot}}$ and negligible resistive loading,

$$
\frac{V_{\mathrm{meas}}}{V_{\mathrm{open}}}
=\frac{1}{1+i2\pi f_cR_sC_{\mathrm{tot}}}.
$$

At 733 Hz, $R_s=100\,\mathrm{k\Omega}$ and $C_{\mathrm{tot}}=1$ nF give $2\pi f_cR_sC_{\mathrm{tot}}\approx0.46$: roughly 9% magnitude loss and 25 degrees of phase lag. That is not a small correction.

A two-terminal DC resistance measurement across the voltage probes is a useful initial check, performed with the source safely disconnected or configured appropriately. It does not replace measuring the effective AC impedance with the current-source termination and wiring present. Contact impedances and common-mode paths can matter.

For an approximate resistive source, input-referred voltage-noise density is

$$
e_{\mathrm{tot}}^2\simeq e_n^2+(i_nR_s)^2+4k_BTR_s.
$$

Choose the input using loading, voltage noise, current noise, and common-mode requirements together. At high resistance, shorter cables, buffering close to the sample, or a lower carrier frequency may help more than changing a nominal voltage-noise specification.

### 6.6 Field, leads, and mechanics

Calibrate the field vector at the sample position as a function of encoder angle. Check uniformity over the active sample area and monitor magnet temperature. A fixed-magnitude field is an approximation to verify.

Twist the voltage leads, minimize their enclosed area, and twist current leads separately. A stationary loop of effective area $A$ in a rotating field can have pickup amplitude approximately

$$
V_F\sim AB|\omega|.
$$

For $A=1$ cm², $B=1$ T, and $f_r=1$ Hz, this is about 0.63 mV. The lock-in may reject that frequency at its output while the input amplifier still sees the full voltage. Inspect input overload and common-mode limits, not just the displayed X value.

Use an insulating or appropriately interrupted conducting holder to limit eddy currents. Balance the rotor, avoid transmitting motor vibration to the specimen, and compare fields under static and rotating conditions if conducting hardware is close to the sample. Use the magnet's required mechanical containment and clearance procedure.

---

## 7. Filters, timing, and current-step settling

### 7.1 Filter attenuation and phase

For $p$ identical cascaded RC poles, each with time constant $\tau$, the envelope transfer function is

$$
H(\Omega)=(1+i\Omega\tau)^{-p}.
$$

Hence

$$
|H|=[1+(\Omega\tau)^2]^{-p/2},\qquad
\arg H=-p\arctan(\Omega\tau).
$$

Here $\Omega$ is the **envelope** angular frequency, such as $\omega$ for ordinary Hall or $2\omega$ for the planar term. The conventional cascade and its bandwidth definitions are documented in [2]. Instruments using other digital filters require their actual transfer functions.

For four poles at $f_r=0.3$ Hz:

| Per-pole $\tau$ | Ordinary-Hall phase lag expressed as field angle | Amplitude loss at $2f_r$ |
|---|---|---|
| 2 ms | 0.864° | 0.0114% |
| 5 ms | 2.160° | 0.0710% |
| 10 ms | 4.319° | 0.2836% |

These values are calculated from the equations above. Small amplitude loss does not imply negligible phase mixing when another angular component is much larger than the signal of interest.

The exact group delay is

$$
t_g(\Omega)=\frac{p\tau}{1+(\Omega\tau)^2}.
$$

The low-frequency limit is $p\tau$. Correcting angle by $\theta\mapsto\theta-\omega p\tau$ is an approximation, not a complete filter correction. It neglects attenuation and becomes less accurate during acceleration and steps.

### 7.2 Why planar Hall needs accurate angle

Suppose the second cosine harmonic is ten times the planar coefficient. A small field-angle error $\delta$ mixes the two second harmonics with approximate magnitude

$$
|\Delta A_2|\simeq2|\delta b_{2c}|.
$$

A 0.5-degree angle error then causes about 17% relative contamination. The sign depends on how the angle error is defined.

For a target fractional error $\varepsilon$ on $A_2$, a useful requirement is

$$
|\delta|\lesssim\frac{\varepsilon|A_2|}{2|b_{2c}|}.
$$

At the same amplitude ratio, 1% accuracy requires about 0.029 degrees. Encoder count resolution alone does not establish this accuracy; magnetic-angle mapping and timestamp alignment are also required.

### 7.3 Correct the model, not just the timestamp

The preferred method is **forward filtering**:

1. Construct each ideal envelope basis function from current and angle.
2. Pass it through the measured or specified acquisition filter.
3. Fit the recorded X data to these filtered functions.

Filtering is linear, so the fit remains linear in the unknown coefficients. This handles attenuation, phase lag, amplitude changes, and varying speed without trying to invert a filter on noisy data.

Include acquisition latency, output averaging, and any additional software filters. Do not apply a separate $p\tau$ angle correction as well if the forward model already includes that delay.

Validate the response experimentally with a known resistor and amplitude modulation or steps. For sinusoidal calibration modulation, measure amplitude and phase over the envelope-frequency band used in the experiment.

### 7.4 Settling after an amplitude change

An ideal $p$-pole RC cascade leaves a fractional step error

$$
r_p(t)=e^{-t/\tau}\sum_{k=0}^{p-1}\frac{(t/\tau)^k}{k!}.
$$

For four poles, 1% settling takes about $10\tau$ and 0.1% takes about $13.1\tau$. At $\tau=5$ ms these are approximately 50 and 65 ms, before allowing for current-source behavior.

**Choose the settling threshold relative to the small signal, not the large step.** If a contact-leakage step is 1 mV and the allowed residual is 1 nV, the required residual fraction is $10^{-6}$, much smaller than 0.1%.

Measure actual settling by aligning and averaging many step responses. Test several step sizes and both step directions. Include current-source settling, capacitive charging, and thermal relaxation. A forward model of the electrical filter does not automatically model nonlinear source transients or sample heating.

Keep all samples for filter-history reconstruction, but exclude unreliable intervals from the regression. If actual current during a transient is unknown, wait until both the transient and its remaining filter memory are below the error target. Also exclude the initial filter startup and verify recovery after an overload.

### 7.5 Rejecting carrier ripple and avoiding aliasing

Demodulation produces unwanted high-frequency terms, including a component near $2f_c$. The output filter must suppress them before they contaminate the recorded data. A large current-proportional contact voltage can produce substantial ripple even when the Hall voltage is tiny.

For acquisition rate $f_s$, residual components can alias to frequencies of the form

$$
f_{\mathrm{alias}}=|f-kf_s|,
$$

folded into $[0,f_s/2]$. Apply this check to relevant residual frequencies, including carrier-related terms and interference lines. The actual internal decimation and analog-output path also matter.

Do not rely on post-processing to remove a component already aliased into the Hall band. Prefer adequate rejection before decimation and verify the recorded spectrum with a dummy sample. If extra software filtering is used, apply its complete response to the model too. A forward-backward filter has zero phase but changes amplitudes and spreads step contamination backward as well as forward in time.

---

## 8. Selecting tilt and the measurement sequence

### 8.1 Ordinary Hall: $\psi=0$

This is the most forgiving starting geometry:

$$
A_1=\beta_1,\qquad A_2=0
$$

under the baseline model. A small tilt error changes ordinary Hall amplitude only at second order: $1-\cos\delta\psi\approx\delta\psi^2/2$. A 2-degree error gives about 0.061% amplitude loss.

A second harmonic at nominal zero tilt is a diagnostic, but not a unique tilt measurement. It can also come from material anisotropy, misalignment, or an electrical artifact.

### 8.2 Planar measurement: $\psi=90^\circ$

The field lies in the sample plane:

$$
A_1=0,\qquad A_2=\beta_2.
$$

This maximizes the baseline planar term. A small tilt error reduces its amplitude at second order while admitting ordinary Hall at first order. Fit both first-harmonic components as diagnostics if the data support them, but do not divide $A_1$ by $\cos90^\circ$ to extract $R_H$.

Check longitudinal MR and the accuracy of its angular phase before assigning the second sine harmonic to planar Hall.

### 8.3 Mixed tilt

For $0<\psi<90^\circ$,

$$
\beta_1=A_1/\cos\psi,\qquad
\beta_2=A_2/\sin\psi.
$$

Mixed tilt measures both signals without changing mounting, but introduces first-order angle uncertainty. There is no universal optimal tilt. Choose it using expected signal sizes, measured noise, angle uncertainty, and which reported quantity matters most.

A 45-degree tilt is an easy initial geometry check; it is not necessarily the best production setting. Separate zero-tilt and in-plane runs are often more robust if the mounting can be changed reproducibly.

### 8.4 Recommended progression

1. **Stationary-angle validation.** Measure a set of angles with the magnet stopped and settled. Include angles separated by 180 degrees. Establish ordinary Hall symmetry and a reference result.
2. **Constant-amplitude rotation.** Acquire several turns at a low fixed speed, then repeat in the opposite sense. Fit each direction separately.
3. **Speed check.** Repeat at a second speed. Corrected coefficients should agree; a discrepancy points to timing, dynamics, or mechanics.
4. **Amplitude check.** Repeat at reduced current. Coefficients in V/A should agree within uncertainty.
5. **Current hopping.** Introduce several amplitudes with adequate dwell time. Randomize order and dwell, independently of encoder angle, if helpful to avoid repeated correlations.
6. **Additional tilts.** Add planar or mixed-tilt measurements after the preceding checks pass.

For example, begin with 0.5–1 s amplitude dwells only if the settling study leaves a useful portion of each dwell. Lengthen them if required. Store the random seed or exact schedule.

Zero-current intervals are useful for electrical-background tests. They are not the only way to estimate an intercept, and their length trades off against time measuring the Hall signal. Keep the reference running during them.

Constant-speed plateaus in both senses are easy to interpret. Acceleration ramps provide additional diagnostics but are not inherently optimal. Exclude reversal transients or model them using an acquisition response already validated for those conditions.

Do not impose a universal minimum number of turns, condition-number cutoff, or run duration. Acquire enough angular coverage and repeats to establish identifiability, uncertainty, and stability for the intended precision.

---

## 9. Logging and fitting the data

### 9.1 Save enough information to reconstruct the measurement

| Data | Purpose |
|---|---|
| Timestamp and acquisition sequence number | Identify timing, dropped data, and order |
| X and Y, in input-referred volts | Signed signal and electrical-phase diagnostics |
| Actual current amplitude and phase, where available | Current calibration and settling |
| Programmed amplitude and exact change times | Reconstruct source history |
| Raw encoder counts and index events | Reconstruct field angle without losing turns |
| Calibrated field-angle mapping | Relate encoder coordinates to the physical field |
| Temperature and magnet temperature | Detect transport and field drift |
| Overload, compliance, and reference-lock flags | Exclude invalid data |
| Carrier, gain, filter, sample rate, coupling, and input settings | Reproduce the transfer function |
| Sample dimensions, contact map, tilt, field map, and calibration records | Convert fit results into physics |

Use a common timebase or establish the offset and drift between clocks. Timestamp the actual acquisition, not just the time a computer receives a packet. A millisecond timing error corresponds to 0.36 degrees at 1 Hz rotation.

### 9.2 Prepare the record

Unwrap encoder angle before differentiating. Estimate $\omega$ with an appropriately smooth derivative, retaining the unmodified angle record. Use the calibrated field angle in trigonometric functions. Motor setpoints are not measurements of field angle or speed.

Flag invalid samples. Do not close up the time axis after masking. Filter state evolves during an excluded interval even though that interval contributes no residual to the fit.

When field magnitude or direction differs appreciably from the ideal model, replace ideal harmonic columns with measured-field quantities. For example, use $-I B_n$ to fit $R_H/d$, and $-I B_jB_t$ to fit $K/d$, subject to the same transport assumptions and geometry corrections. Longitudinal terms must then be modeled consistently too.

### 9.3 Design matrix for the ideal field

Let $\mathcal F$ mean the complete forward acquisition operation, evaluated on a sufficiently fine time grid and then sampled at the recorded timestamps. It includes the lock-in envelope filter and any additional known averaging or latency.

The columns are:

| Column | Coefficient |
|---|---|
| $\mathcal F[I\cos\theta]$ | $A_1$ |
| $\mathcal F[I\sin\theta]$ | $D_1$ |
| $\mathcal F[I\sin2\theta]$ | $A_2$ |
| $\mathcal F[I\cos2\theta]$ | $b_{2c}$ |
| $\mathcal F[I]$ | $b_0$ |
| $1$, if an output intercept is needed | $o_0$ |
| $\tilde t$, if an output drift is needed | $o_1$ |

These last two columns describe a background at the recorded output. A background introduced before a later software filter must pass through that later filter as well. State where each modeled background enters the measurement chain.

Each retained sample contributes one row to a matrix $M$. Then

$$
\mathbf X=M\mathbf a+\boldsymbol\epsilon,
\qquad
\mathbf a=[A_1,D_1,A_2,b_{2c},b_0,o_0,o_1]^{\mathsf T}
$$

for the seven-column case. Remove or combine unidentifiable nuisance columns. At fixed current, use one constant background instead of separately fitting $b_0$ and $o_0$ after settling.

The physical factors $\sin\psi$ and $\cos\psi$ remain outside the harmonic matrix. This lets the same angular basis serve as a diagnostic at limiting tilts, while physical extraction remains restricted to nonzero geometric factors.

### 9.4 Avoid filtering the current twice

If the current-monitor output is already low-pass filtered, it is not the unfiltered envelope $I(t)$. Multiplying that output by instantaneous $\cos\theta(t)$ and filtering the product again generally gives the wrong predictor.

Options include:

- Use calibrated plateau amplitudes and a validated model of source transitions.
- Measure current with sufficient temporal resolution to construct the envelope before the voltage-channel filter.
- Use a joint measurement model that includes the current-monitor response.

On long settled plateaus, the measured current amplitude is usually sufficient, provided timing and residual transition memory are handled. Dividing X by instantaneous current sample by sample is also inappropriate near steps or zero-current intervals.

### 9.5 Solve with QR or SVD

For ordinary least squares, minimize

$$
\|M\mathbf a-\mathbf X\|^2.
$$

Scale each nonzero column by its RMS magnitude. Solve the scaled problem using QR or singular-value decomposition, then undo the scaling on coefficients and covariance. Avoid explicitly inverting $M^{\mathsf T}M$.

Inspect singular values and correlations among coefficients. A large condition number means some combinations are poorly constrained; it does not identify the cause by itself. Adding diagnostic columns can increase uncertainty substantially if they resemble existing columns.

If noise differs among current levels, weighted fitting may help. Correlated noise needs the treatment in Section 11; changing weights alone does not remove temporal correlation.

### 9.6 Diagnostic extensions

Add terms because a controlled test or residual pattern motivates them:

- Third and fifth sine/cosine angular pairs for departures from the baseline model.
- Separate coefficients by current level to test linearity.
- Separate runs or segments by rotation direction, speed, and carrier frequency.
- Current-independent angular terms if zero-current records actually show such output backgrounds.

Do not automatically insert raw Faraday terms such as $\omega\cos\theta$ into a lock-in-output model. A significant coefficient would not, by itself, establish raw Faraday leakage. Likewise, a term proportional to $\omega|\omega|$ is an empirical diagnostic, not a unique identification of eddy currents.

For a small static angle offset defined by $\theta_{\mathrm{true}}=\theta_{\mathrm{logged}}+\delta$, a pure ordinary Hall signal gives $D_1/A_1\approx-\delta$. This interpretation fails near $A_1=0$ or when other first-harmonic physics is present. Do not rotate away $D_1$ without an independent angular calibration.

### 9.7 Residual checks

Inspect residuals versus time, angle, amplitude level, and time since each step. Look for coherent angular patterns and correlation beyond that expected from the filter.

With nonuniform rotation, an ordinary time-domain FFT is not an angular spectrum. Regress against angular sine/cosine functions or carefully resample onto angle before an angular Fourier analysis. Be aware that resampling changes noise correlations.

Filtered residuals are normally colored; require **no unexplained structure beyond the expected noise process**, not a flat raw residual spectrum. A high $R^2$ can simply mean that the large contact offset was fitted accurately. Judge the Hall coefficient using its uncertainty and controls.

---

## 10. Extracting physical quantities

All expressions here assume the ideal geometry and baseline material model have been validated.

### 10.1 Hall coefficient and density

At a tilt with nonzero $\cos\psi$,

$$
\boxed{R_H=-\frac{A_1d}{B\cos\psi}=-\frac{\beta_1d}{B}}.
$$

Define the Hall densities

$$
n_H=\frac{1}{e|R_H|},\qquad
\boxed{n_{s,H}=\frac{B}{e|\beta_1|}}.
$$

For a single carrier population with $R_H=r_H/(nq)$,

$$
n=r_Hn_H,\qquad n_s=r_Hn_{s,H}.
$$

State the assumed Hall scattering factor $r_H$. It has no universal range valid for all materials. With multiple carrier populations, a measured Hall sign describes the net Hall response and does not identify all carriers present.

### 10.2 Sheet resistance and mobility

Measure zero-field sheet resistance $R_\square=\rho_0/d$ at the same temperature. The constant transverse leakage $b_0$ is not a substitute for it.

For a suitable uniform bar with longitudinal voltage-probe spacing $L$ and width $w$,

$$
R_\square=R_{xx}\frac{w}{L}.
$$

For a specimen meeting van der Pauw assumptions, obtain two appropriate four-terminal resistances $R_A,R_B$ and solve

$$
e^{-\pi R_A/R_\square}+e^{-\pi R_B/R_\square}=1.
$$

Do not automatically use $R_\square=(\pi/\ln2)R_A$ unless the relevant characteristic resistances are equal within the required precision. See [3] and [4].

Then

$$
\boxed{\mu_H=\frac{|\beta_1|}{BR_\square}}.
$$

This is Hall mobility. Its equality to drift mobility requires additional assumptions.

The Halbach field does not become zero merely because it is rotated into the sample plane. Obtain zero-field resistance separately, or clearly define a field-dependent normalization instead of calling it $\rho_0$.

### 10.3 Planar quantities

At a tilt with nonzero $\sin\psi$,

$$
\beta_2=\frac{A_2}{\sin\psi},\qquad
\boxed{K=\frac{2d\beta_2}{B^2}}.
$$

Under the normalization in Section 4,

$$
\boxed{C=\frac{2R_\square\beta_2}{\beta_1^2}}.
$$

For one mixed-tilt run,

$$
\boxed{C=\frac{2R_\square A_2\cos^2\psi}{A_1^2\sin\psi}}.
$$

Thickness and field cancel algebraically when the two amplitudes refer to the same physical field magnitude and the same applicable geometry. This removes those explicit factors; it does not remove contact-geometry errors or independent gain errors.

If ordinary and planar runs use different field magnitudes $B_H$ and $B_P$, respectively, the expression includes an extra factor $B_H^2/B_P^2$. Monitor field changes between runs.

For multiplicative geometry factors defined by

$$
\beta_{1,\mathrm{meas}}=g_H\beta_{1,\mathrm{ideal}},\qquad
\beta_{2,\mathrm{meas}}=g_P\beta_{2,\mathrm{ideal}},
$$

the measured ratio must be multiplied by $g_H^2/g_P$ to recover $C$, assuming $R_\square$ is already correct. There is no general reason for $g_P=g_H^2$.

---

## 11. Uncertainty and detection limits

### 11.1 Separate random uncertainty from calibration and model uncertainty

Random noise can decrease with longer acquisition. Thickness, field calibration, contact geometry, timing calibration, and an incorrect material model do not necessarily improve with averaging.

Repeatability is necessary but not sufficient: a fixed gain error can give highly repeatable wrong results. Conversely, a weak signal can remain limited by random noise even with excellent calibration.

### 11.2 Correlated noise

For independent equal-variance errors, the usual formulas are

$$
\hat\sigma^2=\frac{\mathrm{RSS}}{N-p},\qquad
\operatorname{Cov}(\hat{\mathbf a})=\hat\sigma^2(M^{\mathsf T}M)^{-1}.
$$

Here $p$ is the number of fitted coefficients. Lock-in output samples usually are correlated, so this independent-noise covariance is often too optimistic.

For ordinary least squares with a known noise covariance $\Sigma$,

$$
\operatorname{Cov}(\hat{\mathbf a})=
(M^{\mathsf T}M)^{-1}M^{\mathsf T}\Sigma M(M^{\mathsf T}M)^{-1}.
$$

Practical choices are a noise-covariance model and generalized least squares, a suitable correlation-robust covariance estimate, or block-based uncertainty estimation with blocks longer than the measured correlation time. Preserve current and angular coverage in the fit. Complete-run repeats are especially useful for assessing experimental drift.

For an ideal RC cascade driven by white noise, its one-sided equivalent noise bandwidth is:

| Poles | ENBW |
|---|---|
| 1 | $1/(4\tau)$ |
| 2 | $1/(8\tau)$ |
| 3 | $3/(32\tau)$ |
| 4 | $5/(64\tau)$ |

These filter quantities are documented in [2]. For estimating a long-record **mean** of this ideal stationary noise, $N_{\mathrm{eff}}\approx2\,\mathrm{ENBW}\,T$. Thus four poles give approximately $T/(6.4\tau)$, not $T/(2\tau)$. This scalar mean estimate is not a substitute for the covariance of a modulated, masked regression.

For a stationary series with measured normalized autocorrelation $\rho_\ell$, another mean-estimation approximation is

$$
N_{\mathrm{eff}}\simeq\frac{N}{1+2\sum_{\ell\ge1}\rho_\ell},
$$

with a justified lag cutoff. Colored interference and sample drift can make even this estimate inadequate.

### 11.3 A useful planning estimate

If retained samples are effectively independent, angular coverage is uniform, the relevant regressors are nearly orthogonal, and filter attenuation is negligible or accounted for,

$$
\sigma(A_1)\approx\sigma(A_2)
\approx\frac{\sqrt{2}\,\sigma_V}{I_{\mathrm{eff}}\sqrt{N_{\mathrm{eff}}}},
\qquad I_{\mathrm{eff}}=\sqrt{\langle I^2\rangle}.
$$

This is a planning estimate. Use the actual design and noise model for final uncertainty. Correlations between fit columns increase coefficient uncertainty; current hopping does not guarantee orthogonality.

At mixed tilt, divide by $|\cos\psi|$ or $|\sin\psi|$ for the corresponding coefficient's statistical uncertainty. For a well-determined $\beta_1$, an approximate $k$-sigma planar detection threshold is

$$
|C|_{\min}\approx\frac{2R_\square k\sigma(\beta_2)}{\beta_1^2}.
$$

This is a random-noise threshold, not a guarantee against phase leakage or geometry artifacts. Choose the required threshold from the scientific question; there is no universal value of $C$ below which a measurement should be abandoned.

### 11.4 Propagating uncertainty to $R_H$

Using directly fitted $A_1$,

$$
R_H=-\frac{A_1d}{B\cos\psi}.
$$

If the listed inputs are independent, a first-order expression is

$$
\left(\frac{\sigma_{R_H}}{|R_H|}\right)^2
\simeq
\left(\frac{\sigma_{A_1}}{|A_1|}\right)^2
+\left(\frac{\sigma_d}{d}\right)^2
+\left(\frac{\sigma_B}{B}\right)^2
+\tan^2\psi\,\sigma_\psi^2
+u_{\mathrm{cal}}^2.
$$

$u_{\mathrm{cal}}$ collects relevant relative voltage/current calibration errors not already included in $\sigma_{A_1}$. Add separately justified geometry and model uncertainty. Do not count current calibration twice. Angle uncertainties are in radians.

At an extremum such as zero tilt, the first derivative vanishes; use the second-order dependence or Monte Carlo propagation when the leading tilt effect matters.

### 11.5 Propagating uncertainty to $C$

For a mixed-tilt run,

$$
\frac{dC}{C}=
\frac{dR_\square}{R_\square}
+\frac{dA_2}{A_2}
-2\frac{dA_1}{A_1}
-(2\tan\psi+\cot\psi)d\psi.
$$

The tilt contribution alone is

$$
\boxed{
\frac{\sigma_{C,\psi}}{|C|}
=|2\tan\psi+\cot\psi|\,\sigma_\psi.
}
$$

At 45 degrees and $\sigma_\psi=0.5$ degrees, this contributes **2.62%**. The angle errors in $\beta_1$ and $\beta_2$ come from the same angle and must not be treated as independent.

The general rule is

$$
\sigma_C^2\simeq\nabla C^{\mathsf T}\Sigma_q\nabla C,
\qquad q=(R_\square,A_1,A_2,\psi,\ldots).
$$

For example, correlation between $A_1$ and $A_2$ contributes $-4\operatorname{Cov}(A_1,A_2)/(A_1A_2)$ to the relative variance. Shared voltage/current calibration can partly or fully cancel when resistance and Hall amplitudes use the same calibrated ratio; propagate it as a shared quantity rather than independently adding the same error several times.

Near $A_2=0$, quote an absolute coefficient uncertainty or interval instead of a divergent relative uncertainty. Near $A_1=0$, $C$ is not a stable quantity to report. Monte Carlo propagation is useful for nonlinear ratios and bounded or asymmetric input uncertainties.

### 11.6 Repeated runs

Fit complete runs independently before pooling them. Report the number of runs, their scatter, and the uncertainty of the pooled estimate. For independent stationary repeats, uncertainty in the mean decreases approximately as $1/\sqrt{m}$ for $m$ runs.

A drifting series is not a set of independent identical measurements. If direction, temperature, frequency, or elapsed time predicts the result, investigate or explicitly model that dependence. Longer measurements do buy random precision, but do not automatically fix a bias.

---

## 12. Commissioning the apparatus

Perform these checks before measuring unknown samples quantitatively.

1. **Field and encoder calibration.** Verify field direction at several angles, both rotation senses, and the actual sample position. Record field magnitude and spatial variation.
2. **Gain and RMS calibration.** Measure known resistors at each proposed carrier frequency with the intended gains and wiring. Verify input-referred X/current and the expected Y.
3. **Loading check.** Use a representative source impedance and measure the frequency response. A low-resistance standard alone does not validate a high-resistance sample.
4. **Current and compliance check.** Verify actual current amplitude and phase at all levels, including transitions. Confirm reference lock at zero amplitude.
5. **Transfer-function check.** Measure response to known amplitude modulation and steps. Determine latency, filter response, and masks from data.
6. **Zero-current rotation.** Record X/Y while the magnet rotates with the carrier reference still active. Fit any background directly in volts. Current-proportional coefficients are unidentifiable when all currents are zero; they cannot be claimed to have been measured as zero.
7. **Representative dummy test.** Check electrical feedthrough, lead pickup, dynamic range, and motor-related interference with suitable non-Hall wiring or a characterized dummy.
8. **Reference Hall sample.** Recover the known sign and magnitude within a realistic uncertainty budget.
9. **Stopped versus rotating field.** Compare settled measurements at fixed angles with continuous-rotation results after filtering corrections.
10. **Current, frequency, speed, and direction checks.** Vary each independently. Normalized transport coefficients should agree within their applicable regime.
11. **Contact and longitudinal checks.** Measure longitudinal MR and, if possible, use another transverse contact pair. Establish how much longitudinal voltage enters the planar harmonic.
12. **Tilt check.** Under the baseline model, $A_1(45^\circ)/A_1(0)=\cos45^\circ$ and $A_2(45^\circ)/A_2(90^\circ)=\sin45^\circ$. Disagreement can reflect geometry, material anisotropy, field changes, or timing, not just a bad wedge.

### Reciprocity: use the correct field reversal

Define $R_{ab,cd}$ as the voltage $U_c-U_d$ divided by current entering $a$ and leaving $b$. For a nonmagnetic conductor in the applicable linear-response regime,

$$
R_{ab,cd}(\mathbf B)=R_{cd,ab}(-\mathbf B).
$$

Exchange the ordered current and voltage pairs **and reverse the field**, preserving the defined polarities. In the ideal rotating geometry, field reversal corresponds to adding $\pi$ to the physical field angle. Compare stopped, settled configurations first, so rotation history and filter lag do not obscure the test. See [5].

Simply swapping pairs at the same field does not generally preserve the signed Hall component. Magnetic states require reversal of the relevant time-reversal-odd internal variables too, and may not be reproducible by a simple field reversal.

---

## 13. Higher harmonics and limits of interpretation

### 13.1 What a third harmonic tells you

A third angular harmonic shows that a pure first-harmonic description is incomplete. It is not, by itself, proof of multiband transport.

For a response governed only by perpendicular field, suppose

$$
V_H/I=h_1B_n+h_3B_n^3+\cdots,
\qquad B_n=B\cos\psi\cos\theta.
$$

Using

$$
\cos^3\theta=\frac{3\cos\theta+\cos3\theta}{4},
$$

the cubic term contributes to both the first and third harmonics. Consequently, the first harmonic alone no longer gives the low-field linear Hall slope $h_1$.

Fit both sine and cosine components of an added harmonic unless independent calibration justifies a fixed phase. Account for their different filter responses. Check field mapping, encoder nonlinearity, vibration, current nonlinearity, and material anisotropy before a microscopic interpretation.

### 13.2 Two-dimensional versus three-dimensional transport

A conducting film is not automatically electronically two-dimensional. To interpret rotation as a sweep of $B_n$ alone, establish that in-plane field effects are negligible over the field and temperature range used. Finite thickness, Zeeman effects, interlayer motion, and anisotropy can violate that approximation. A single magnetoresistance harmonic cannot establish dimensionality by itself.

For an ideal isotropic 3D conductor, a rotationally covariant resistivity tensor can be written schematically as

$$
\rho_{ij}=a(B^2)\delta_{ij}+b(B^2)B_iB_j
+\rho^{\mathrm{odd}}_{ij},
$$

with the odd part producing an electric field $c(B^2)(\mathbf B\times\mathbf j)$. At fixed magnitude, $a,b,c$ are constant during rotation. The transverse response then has first and second angular harmonics even if the coefficients have complicated magnitude dependence. Multiband isotropic Drude transport is one example; rotation at a single magnitude need not reveal its nonlinearity with field strength.

This argument does not apply unchanged to every anisotropic bulk crystal. Conversely, absence of a third harmonic does not prove a single band, even in a system where only $B_n$ matters.

Multiple field magnitudes, temperatures, orientations, and longitudinal transport measurements generally provide stronger evidence than one angular trace. A two-band numerical prediction needs densities and carrier signs as well as mobilities.

---

## 14. Worked examples

These examples are calculations illustrating the equations, not experimental performance claims.

### 14.1 Ordinary Hall sign and units

Assume an ideal single electron population with $r_H=1$:

$$
n=10^{21}\ \mathrm{m^{-3}},\quad
d=500\ \mathrm{\mu m},\quad B=1\ \mathrm T,\quad
I=3\ \mathrm{mA\ RMS},\quad\psi=0.
$$

Then

$$
R_H=-\frac{1}{en}\approx-6.24\times10^{-3}\ \mathrm{m^3/C},
$$

$$
\beta_1=-R_HB/d\approx+12.48\ \Omega.
$$

The **maximum RMS-referred Hall envelope** is $I\beta_1\approx37.4$ mV. The raw electrical sine at that field angle has a peak voltage $\sqrt{2}$ times larger. The positive envelope at $\theta=0$ corresponds to electron-like Hall response in the defined wiring.

Check that the required current is compatible with the specimen's resistance, contacts, and heating before using it in an actual sample.

### 14.2 Statistical planning

Suppose the noise on effectively independent envelope samples is 30 nV RMS, the effective current is 1 mA, and the validated effective count for a rough planning estimate is 1000. With nearly orthogonal angular columns,

$$
\sigma(A_1)\approx\frac{\sqrt{2}(30\ \mathrm{nV})}
{(1\ \mathrm{mA})\sqrt{1000}}
\approx1.34\ \mathrm{\mu\Omega}.
$$

A 100 nV Hall envelope at 1 mA corresponds to $A_1=100\ \mathrm{\mu\Omega}$, giving approximately 1.34% random uncertainty. This demonstrates why noise level, effective observation count, and current must be specified before promising a percentage precision.

If thickness uncertainty is 2% and field uncertainty is 1%, with other independent contributions negligible, the total becomes approximately

$$
\sqrt{1.34^2+2^2+1^2}\%=2.61\%.
$$

Longer averaging reduces the 1.34% term, but the calibration terms remain.

### 14.3 Mixed-tilt planar extraction

Suppose $\psi=45^\circ$, $R_\square=100\ \Omega$, $A_1=1.00\ \Omega$, and $A_2=0.0100\ \Omega$. Then

$$
\beta_1=1.414\ \Omega,\qquad
\beta_2=0.01414\ \Omega,
$$

$$
C=\frac{2(100)(0.01414)}{1.414^2}\approx1.414.
$$

This number is meaningful only under the quadratic model and valid geometry. A 0.5-degree tilt uncertainty contributes 2.62% to $C$ even if the two amplitudes are fitted with negligible random uncertainty.

---

## 15. Troubleshooting and reporting

### 15.1 Troubleshooting

| Observation | First checks |
|---|---|
| Hall sign disagrees with reference | Voltage polarity, current-reference polarity, field zero, fixed electrical phase |
| Corrected coefficient depends on carrier frequency | Current division, voltage loading, phase calibration, synchronous thermal effects, sample dynamics |
| Coefficient depends on rotation speed | Filter/latency model, encoder timing, eddy currents, mechanical effects, material relaxation |
| Opposite directions disagree | Magnetic-angle calibration, timing, reversal transients, hysteresis |
| Planar term changes when leads are moved | Electrical coupling, longitudinal leakage, loop geometry |
| Planar term is sensitive to a small angle shift | Large second cosine harmonic leaking into the sine harmonic |
| Singular or badly conditioned fit | Constant-current/intercept degeneracy, insufficient coverage, correlated schedule, redundant columns |
| Residuals follow current steps | Incomplete settling, incorrect current history, heating, unmodeled filtering |
| Large Y | Reference phase, reactive wiring, sample dynamics, quadrature interference |
| Overload despite small X | Large raw pickup, common-mode voltage, longitudinal carrier voltage, or insufficient input range |
| More samples do not improve precision | Oversampling, correlated noise, drift, or systematic floor |
| Density differs by many orders of magnitude | Thickness, field, mobility, and density unit conversions |
| Result differs by $\sqrt{2}$ | Peak/RMS mismatch or calibration convention |
| Third angular harmonic appears | Field/encoder mapping, mechanics, nonlinear or anisotropic transport; test before assigning multiband origin |

### 15.2 Minimum report

Report:

- Sample identity, temperature, contact layout, conducting thickness, and geometric assumptions.
- Field magnitude/vector calibration, tilt, encoder mapping, and rotation schedule.
- Carrier frequency, RMS current levels, actual-current measurement, and compliance checks.
- Input impedance/capacitance considerations, preamplifier gain, X/Y phase calibration, and frequency test.
- Exact filter and acquisition settings, timing alignment, current-step masks, and forward-model implementation.
- Fitted columns, coefficient covariance or uncertainty method, retained duration, and repeat count.
- Measured $A_1,A_2$ and relevant diagnostics before conversion to $R_H$, $n_{s,H}$, $\mu_H$, $K$, or $C$.
- Independent sheet-resistance method, Hall-factor assumption, and any geometry corrections.
- Agreement or disagreement across current, direction, speed, carrier frequency, and stationary-angle controls.
- Random, calibration, and model uncertainties, stated separately where practical.

Use SI internally: $d$ in m, $B$ in T, current in A, $R_H$ in m³/C, $K$ in $\Omega\,\mathrm m/\mathrm T^2$, mobility in m²/(V·s), and angular velocity in rad/s. Common conversions are $1$ T $=10^4$ gauss, $1$ cm²/(V·s) $=10^{-4}$ m²/(V·s), and $1$ cm⁻³ $=10^6$ m⁻³.

Preserve raw records and calibration data. Report a coherent limitation when a control fails rather than absorbing it into an unexplained fit coefficient.

---

## 16. References

These references support the established measurement principles. The CHIRP geometry, forward model, planning settings, algebraic examples, and proposed checks above are developed explicitly in this guide; they are not claims of validation by the instrument manufacturers.

1. **Stanford Research Systems — About Lock-In Amplifiers.** Introduction to phase-sensitive detection, X/Y outputs, noise rejection, and dynamic reserve. [Application note](https://www.thinksrs.com/downloads/pdfs/applicationnotes/AboutLIAs.pdf).
2. **Zurich Instruments — MFLI User Manual, Signal Processing Basics.** Cascaded-filter response, time constants, bandwidth, and settling. Check the manual for the actual instrument and filter mode used. [Manual section](https://docs.zhinst.com/mfli_user_manual/signal_processing_basics.html).
3. **NIST — The Hall Effect.** Hall and van der Pauw measurement principles and sample-geometry considerations. Its terminal convention need not match the voltage sign convention in this guide. [Technical introduction](https://www.nist.gov/pml/nanoscale-device-characterization-division/popular-links/hall-effect/hall-effect).
4. **NIST — Hall Effect Measurements Algorithm.** Sheet-resistance extraction using the van der Pauw equation. [Algorithm](https://www.nist.gov/pml/nanoscale-device-characterization-division/popular-links/hall-effect/hall-effect-measurements-2).
5. **I. Janeček and P. Vašek — Transverse even effect and Hall effect in YBaCuO superconductor.** Discussion and experimental use of the magnetic-field reciprocity relation. This is a reference for the reciprocity check, not validation of the present nonmagnetic transport model. [Preprint](https://arxiv.org/abs/cond-mat/0306560).

The original draft's unaccompanied simulation tables and universal precision promises have been replaced by explicit calculations, assumptions, and procedures for establishing performance on the actual apparatus.
