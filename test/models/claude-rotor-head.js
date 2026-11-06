// Made by Claude in 3D Maker (npm run try) from the prompt: "A Black Hawk-style
// main rotor head ... It works like the real one: the rotor turns, cyclic and
// collective sliders tilt and raise the swashplate, and the pitch links pitch
// each blade as it goes round." Kept as a test: 47 parts, 29 joints.

title("Black Hawk-style main rotor head");
const D = Math.PI / 180;
// ---------- sliders ----------
const RPM  = param("Rotor rpm", 20, { min: 0, max: 60, step: 1, part: "Rotor mast" });
const COLL = param("Collective (mm)", 15, { min: -40, max: 40, step: 1, part: "Stationary swashplate" });
const LON  = param("Cyclic fore-aft (deg)", 5, { min: -8, max: 8, step: 0.5, part: "Stationary swashplate" });
const LAT  = param("Cyclic lateral (deg)", 0, { min: -8, max: 8, step: 0.5, part: "Stationary swashplate" });
const BLADE_R = param("Blade stub length", 1800, { min: 1000, max: 3000, step: 50, part: "Blade 1" });

// ---------- key geometry ----------
const HUB_Z = 800;            // pitch axis / hub centre height
const SW_Z = 380;             // swashplate (uniball) centre at rest
const C0 = [0, 0, SW_Z];
const EAR_Z = 450;            // pitch-link lower eye height on rotating plate
const HORN = [430, 200, 740]; // pitch-horn tip, blade along +x
const RHO = Math.hypot(HORN[0], HORN[1]);
const DELTA = Math.atan2(HORN[1], HORN[0]) / D;
const PHI = [0, 90, 180, 270];

// ---------- vector helpers ----------
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = a => Math.hypot(a[0], a[1], a[2]);
const nrm = a => scl(a, 1 / len(a));
const rz = (p, d) => { const c = Math.cos(d * D), s = Math.sin(d * D); return [c * p[0] - s * p[1], s * p[0] + c * p[1], p[2]]; };
const rx = (p, d) => { const c = Math.cos(d * D), s = Math.sin(d * D); return [p[0], c * p[1] - s * p[2], s * p[1] + c * p[2]]; };
const ry = (p, d) => { const c = Math.cos(d * D), s = Math.sin(d * D); return [c * p[0] + s * p[2], p[1], -s * p[0] + c * p[2]]; };
// rotate p about axis k (unit) through point c by d degrees
const rotAx = (p, k, c, d) => {
  const v = sub(p, c), cs = Math.cos(d * D), sn = Math.sin(d * D);
  const kx = [k[1] * v[2] - k[2] * v[1], k[2] * v[0] - k[0] * v[2], k[0] * v[1] - k[1] * v[0]];
  return add(c, add(add(scl(v, cs), scl(kx, sn)), scl(k, dot(k, v) * (1 - cs))));
};
const psi = t => RPM * 6 * t;                       // rotor azimuth, degrees (CCW from above)
// stationary swashplate: tilt about uniball centre, then raise by collective
const swPose = () => turn(LAT, "x", C0).turn(LON, "y", C0).slide(0, 0, COLL);
const S = p => add(add(ry(rx(sub(p, C0), LAT), LON), C0), [0, 0, COLL]);
// two-bar knee: arms L1 (from a) and L2 (to b), knee bent toward 'out'
const knee = (a, b, L1, L2, out) => {
  const d = sub(b, a), dl = len(d), u = scl(d, 1 / dl);
  const x = (L1 * L1 - L2 * L2 + dl * dl) / (2 * dl);
  const h = Math.sqrt(Math.max(0, L1 * L1 - x * x));
  const n = nrm(sub(out, scl(u, dot(out, u))));
  return add(a, add(scl(u, x), scl(n, h)));
};

// ---------- colours ----------
const C = { olive: "#56604a", steel: "#8d949c", ti: "#70767d", dark: "#3a3e44", blade: "#2c2f33",
  rubber: "#1c1d20", rot: "#aab1b9", stat: "#7c838b", link: "#c2c8ce", damp: "#b59a4a", yellow: "#d8b23a" };

// ================= STEP 1: gearbox, guide, mast =================
part("Gearbox top", union(
  revolve([[0, 0], [470, 0], [470, 110], [400, 190], [220, 225], [0, 225]]),
  cylinder(230, 30).move(0, 0, 230)
), { color: C.olive });

const R_SCI_A = [0, -165, 262];  // stationary scissors fixed pivot (az 270)
part("Swash guide", subtract(union(
  cylinder(135, 300).move(0, 0, 395),
  cylinder(200, 30).move(0, 0, 255),
  box(60, 50, 40, 6).move(0, -165, 285),
), cylinder(114, 400).move(0, 0, 380)), { color: C.stat });

const R_ROT_A = rz([150, 0, 600], 45); // rotating scissors pivot on mast collar
part("Rotor mast", union(
  revolve([[0, 230], [110, 230], [110, 680], [175, 690], [175, 712], [100, 720], [100, 890], [90, 905], [0, 905]]),
  cylinder(140, 44, 6).move(0, 0, 600),
  box(70, 50, 40, 6).move(150, 0, 600).rotateZ(45),
  // spline ridges
  box(12, 232, 150).move(0, 0, 790).radial(6, "z")
), { color: C.steel, motion: t => turn(psi(t), "z") });

// ================= STEP 2: swashplates and servos =================
const SERVO_AZ = [0, 90, 180];
const SERVO_Q = SERVO_AZ.map(a => rz([380, 0, 335], a));   // ram top eye centres
const S_SCI_B = [0, -280, 345];                              // stationary scissors plate pivot

part("Stationary swashplate", union(
  subtract(revolve([[160, 355], [400, 355], [405, 375], [400, 395], [160, 395]]),
    cylinder(137, 200).move(0, 0, SW_Z)),
  subtract(intersect(sphere(168).move(0, 0, SW_Z), box(400, 400, 70).move(0, 0, SW_Z)),
    cylinder(137, 200).move(0, 0, SW_Z)),
  SERVO_AZ.map(a => subtract(box(60, 46, 50, 6).move(380, 0, 340),
    cylinder(11, 80).rotateX(90).move(380, 0, 335)).rotateZ(a)),
  subtract(box(46, 60, 40, 6).move(0, -280, 348), cylinder(10, 80).rotateY(90).move(0, -280, 345))
), { color: C.stat, motion: t => swPose() });

const ROT_SCI_B = rz([255, 0, 452], 45);   // rotating scissors pivot on rotating plate
const EAR0 = PHI.map(p => rz([RHO, 0, EAR_Z], p + DELTA));
part("Rotating swashplate", union(
  subtract(revolve([[180, 399], [455, 399], [470, 412], [470, 424], [455, 437], [180, 437]]),
    cylinder(170, 200).move(0, 0, SW_Z)),
  // pitch-link clevises
  PHI.map(p => subtract(union(box(100, 70, 34, 8).move(450, 0, 430), box(46, 60, 50, 6).move(RHO, 0, EAR_Z)),
      box(60, 24, 60).move(RHO, 0, EAR_Z + 10), cylinder(9, 90).rotateX(90).move(RHO, 0, EAR_Z))
    .rotateZ(p + DELTA)),
  // driver (scissors) lug
  subtract(box(50, 40, 40, 6).move(255, 0, 448), cylinder(9, 60).rotateX(90).move(255, 0, 452)).rotateZ(45),
  // bearing cap bolts
  cylinder(9, 8).move(330, 0, 441).radial(16, "z")
), { color: C.rot, follow: "Stationary swashplate", motion: t => turn(psi(t), "z") });

part("Servos", union(SERVO_AZ.map(a => union(
  cylinder(50, 120, 8).move(380, 0, 245),
  cylinder(34, 20).move(380, 0, 312),
  box(90, 70, 30, 6).move(380, 0, 195)
).rotateZ(a))), { color: C.olive });

SERVO_Q.forEach((q, i) => {
  part("Servo ram " + (i + 1), union(
    cylinder(18, 80).move(q[0], q[1], 300),
    subtract(box(36, 30, 30, 8).move(q[0], q[1], q[2]), cylinder(10, 60).rotateZ(SERVO_AZ[i]).rotateX(0)
      .rotateX(90).rotateZ(SERVO_AZ[i]).move(q[0], q[1], q[2]))
  ), { color: C.link, motion: t => slide(sub(S(q), q)) });
});

// ================= STEP 3: scissors links =================
const eye = (p, az, r = 20, w = 44) => cylinder(r, w).rotateX(90).rotateZ(az).move(p[0], p[1], p[2]);
const arm = (a, b, az) => union(capsule(a, b, 13), eye(a, az), eye(b, az), capsule(a, b, 7).move(0, 0, 0).offset(0));
// stationary scissors (az 270): guide lug -> knee -> stationary plate lug
const SA = [0, -165, 285], SB0 = S_SCI_B, SL = 110, SOUT = [0, -1, 0];
const SK0 = knee(SA, SB0, SL, SL, SOUT);
const sK = () => knee(SA, S(SB0), SL, SL, SOUT);
part("Stationary scissors lower", arm(SA, SK0, 270), { color: C.dark, motion: t => link(SA, SK0, SA, sK()) });
part("Stationary scissors upper", arm(SK0, SB0, 270), { color: C.dark, motion: t => link(SK0, SB0, sK(), S(SB0)) });

// rotating scissors (driver, az 45): mast collar lug -> knee -> rotating plate lug; solved in the rotating frame
const RA = R_ROT_A, RB0 = ROT_SCI_B, RL = 130, ROUT = rz([1, 0, 0], 45);
const RK0 = knee(RA, RB0, RL, RL, ROUT);
const rB = t => rz(S(rz(RB0, psi(t))), -psi(t));
const rK = t => knee(RA, rB(t), RL, RL, ROUT);
part("Rotating scissors upper", arm(RA, RK0, 45), { color: C.dark, follow: "Rotor mast", motion: t => link(RA, RK0, RA, rK(t)) });
part("Rotating scissors lower", arm(RK0, RB0, 45), { color: C.dark, follow: "Rotor mast", motion: t => link(RK0, RB0, rK(t), rB(t)) });
print("stat knee", SK0.map(Math.round), "rot knee", RK0.map(Math.round));

joint("Stationary scissors lower", "Swash guide", SA);
joint("Stationary scissors lower", "Stationary scissors upper", SK0);
joint("Stationary scissors upper", "Stationary swashplate", SB0);
joint("Rotating scissors upper", "Rotor mast", RA);
joint("Rotating scissors upper", "Rotating scissors lower", RK0);
joint("Rotating scissors lower", "Rotating swashplate", RB0);
SERVO_Q.forEach((q, i) => joint("Servo ram " + (i + 1), "Stationary swashplate", q));

// ================= STEP 4: hub and elastomeric bearings =================
const DH = [200, -195, HUB_Z];   // damper hub-end pivot (blade along +x)
const hubArm = subtract(union(
    box(230, 250, 170, 14).move(290, 0, HUB_Z),
    box(70, 60, 56, 8).move(DH[0], DH[1] + 10, HUB_Z)),
  box(150, 172, 200).move(298, 0, HUB_Z),
  cylinder(54, 80).rotateY(90).move(390, 0, HUB_Z),
  cylinder(12, 90).move(DH[0], DH[1], HUB_Z));
part("Hub", union(
  cylinder(215, 170, 16).move(0, 0, HUB_Z),
  PHI.map(p => hubArm.rotateZ(p)),
  cylinder(160, 26, 6).move(0, 0, HUB_Z + 96),
  cylinder(14, 14).move(185, 0, HUB_Z + 88).radial(12, "z")
), { color: C.ti, follow: "Rotor mast" });

const bearing = union(
  Array.from({ length: 11 }, (_, k) => cylinder(k % 2 ? 66 : 74, 10).rotateY(90).move(245 + k * 10, 0, HUB_Z)),
  sphere(70).scale(0.5, 1, 1).move(240, 0, HUB_Z),
  cylinder(80, 14).rotateY(90).move(358, 0, HUB_Z)
);
PHI.forEach((p, i) => part("Bearing " + (i + 1), bearing.rotateZ(p), { color: C.rubber, follow: "Hub" }));

// ================= STEP 5: blade cuffs, pitch horns, blades =================
const HT = HORN[1], HV = HORN[2] - HUB_Z;          // horn tip: 200 mm ahead of, 60 mm below the pitch axis
const HR = Math.hypot(HT, HV), HA = Math.atan2(HV, HT);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
// blade pitch (deg) that keeps the pitch link at its length: horn tip follows the swashplate eye height
const pitch = (i, t) => {
  const E = S(rz(EAR0[i], psi(t)));
  return (Math.asin(clamp((HV + E[2] - EAR_Z) / HR, -1, 1)) - HA) / D;
};
const DC = [600, -172, HUB_Z];   // damper cuff-end pivot

const cuff = union(
  cylinder(46, 200).rotateY(90).move(370, 0, HUB_Z),
  extrude([[420, -80], [760, -215], [760, 215], [420, 80]], 120).move(0, 0, HUB_Z),
  // blade-grip clevis plates above and below the blade root
  box(150, 400, 14, 5).move(830, -50, HUB_Z + 34),
  box(150, 400, 14, 5).move(830, -50, HUB_Z - 34),
  [[700, -150], [700, 120], [860, -200], [860, 100]].map(([x, y]) => cylinder(20, 96).move(x, y, HUB_Z)),
  subtract(box(60, 60, 56, 8).move(DC[0], DC[1] + 8, HUB_Z), cylinder(12, 90).move(DC[0], DC[1], HUB_Z)),
  cylinder(60, 24).rotateY(90).move(432, 0, HUB_Z)
);
const horn = union(
  tube([[475, 50, HUB_Z, 30], [460, 140, HUB_Z - 25, 24], [HORN[0], HORN[1] - 10, HORN[2] + 4, 20]]),
  subtract(box(44, 50, 44, 8).move(HORN[0], HORN[1], HORN[2]), box(60, 54, 22).move(HORN[0], HORN[1] + 4, HORN[2] - 16),
    cylinder(9, 60).rotateY(90).move(HORN[0], HORN[1], HORN[2]))
);
// NACA-0012-like section, quarter chord on the pitch axis, leading edge toward +y (rotation is CCW)
const CHORD = 530, TH = 0.12;
const foil = [];
for (let k = 0; k <= 24; k++) { const x = (1 - Math.cos(Math.PI * k / 24)) / 2;
  const v = 5 * TH * CHORD * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4);
  foil.push([-v, (0.25 - x) * CHORD]); }
for (let k = 23; k >= 1; k--) { const p = foil[k]; foil.push([-p[0], p[1]]); }
const bladeStub = (R0, R1) => extrude(foil, R1 - R0).rotateY(90).move((R0 + R1) / 2, 0, HUB_Z);
const blade = union(
  bladeStub(770, BLADE_R),
  box(260, 330, 54, 12).move(900, -40, HUB_Z),           // root doubler between the grip plates
  box(30, CHORD * 0.9, 66, 6).move(1060, -50, HUB_Z)      // root fairing step
);

PHI.forEach((p, i) => {
  const n = i + 1, ax = [Math.cos(p * D), Math.sin(p * D), 0];
  part("Blade cuff " + n, cuff.rotateZ(p), { color: C.dark, follow: "Hub",
    motion: t => turn(pitch(i, t), ax, [0, 0, HUB_Z]) });
  part("Pitch horn " + n, horn.rotateZ(p), { color: C.steel, follow: "Blade cuff " + n });
  part("Blade " + n, blade.rotateZ(p), { color: C.blade, follow: "Blade cuff " + n });
  joint("Blade cuff " + n, "Bearing " + n, rz([300, 0, HUB_Z], p));
});

// ================= STEP 6: pitch links and dampers =================
const lerp = (a, b, f) => add(a, scl(sub(b, a), f));
PHI.forEach((p, i) => {
  const n = i + 1;
  const E0 = EAR0[i], T0 = rz(HORN, p);
  part("Pitch link " + n, union(
    capsule(E0, T0, 13),
    capsule(lerp(E0, T0, 0.42), lerp(E0, T0, 0.62), 21),       // turnbuckle barrel
    eye(E0, p + DELTA + 90, 21, 22), eye(T0, p + DELTA + 90, 21, 22)
  ), { color: C.link,
    motion: t => link(E0, T0, where("Rotating swashplate", E0, t), where("Blade cuff " + n, T0, t)) });
  joint("Pitch link " + n, "Rotating swashplate", E0);
  joint("Pitch link " + n, "Blade cuff " + n, T0);

  // telescoping lead-lag damper: body pivots on the hub, piston rod pivots on the cuff (solved in the hub frame)
  const Dh = rz(DH, p), Dc = rz(DC, p), ax = [Math.cos(p * D), Math.sin(p * D), 0];
  const dAim = t => {
    const c = rotAx(Dc, ax, [0, 0, HUB_Z], pitch(i, t));
    const u0 = nrm(sub(Dc, Dh)), u = nrm(sub(c, Dh));
    const cr = [u0[1] * u[2] - u0[2] * u[1], u0[2] * u[0] - u0[0] * u[2], u0[0] * u[1] - u0[1] * u[0]];
    const s = len(cr);
    return { c, axis: s > 1e-9 ? scl(cr, 1 / s) : [0, 0, 1], ang: Math.atan2(s, dot(u0, u)) / D };
  };
  part("Damper " + n, union(
    capsule(Dh, lerp(Dh, Dc, 0.62), 40),
    torus(40, 5).rotateY(90).rotateZ(p).move(...lerp(Dh, Dc, 0.2)),
    torus(40, 5).rotateY(90).rotateZ(p).move(...lerp(Dh, Dc, 0.45)),
    cylinder(22, 50).move(...Dh)
  ), { color: C.damp, follow: "Hub", motion: t => { const a = dAim(t); return turn(a.ang, a.axis, Dh); } });
  part("Damper rod " + n, union(
    capsule(lerp(Dh, Dc, 0.5), Dc, 17), cylinder(20, 50).move(...Dc)
  ), { color: C.link, follow: "Hub", motion: t => { const a = dAim(t); return turn(a.ang, a.axis, Dc).slide(sub(a.c, Dc)); } });
  joint("Damper " + n, "Hub", Dh);
  joint("Damper rod " + n, "Blade cuff " + n, Dc);
});

// ================= STEP 7: bifilar vibration absorber =================
const BZ = 985, BR = 330;
const BAZ = PHI.map(p => p + 45);
part("Bifilar", union(
  cylinder(105, 70, 8).move(0, 0, 940),
  cylinder(140, 30, 6).move(0, 0, BZ),
  BAZ.map(a => union(
    box(BR - 60, 80, 34, 8).move((BR - 60) / 2 + 60, 0, BZ),
    box(70, 120, 34, 8).move(BR - 25, 0, BZ)
  ).rotateZ(a)),
  cylinder(18, 12).move(70, 0, BZ + 21).radial(8, "z")
), { color: C.ti, follow: "Hub" });

BAZ.forEach((a, i) => {
  const tang = rz([0, 1, 0], a);
  part("Bifilar weight " + (i + 1), union(
    subtract(cylinder(85, 120, 10).move(BR + 40, 0, BZ), box(140, 130, 42).move(BR, 0, BZ)),
    cylinder(16, 136).move(BR + 5, 38, BZ), cylinder(16, 136).move(BR + 5, -38, BZ)
  ).rotateZ(a), { color: C.stat, follow: "Bifilar",
    // pendulum masses swing in the rotor plane at 3 per rev (tuned to cancel 4/rev hub shear)
    motion: t => slide(scl(tang, 9 * Math.sin(3 * psi(t) * D + i * Math.PI / 2))) });
});

loop(RPM > 0 ? 60 / RPM : 1);   // one full rotor revolution, so the animation repeats seamlessly
