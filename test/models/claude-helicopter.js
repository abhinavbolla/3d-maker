// Made by Claude in 3D Maker from the prompt "A helicopter. The main rotor and tail
// rotor should spin. Model the whole top properly: rotor head, mast, engine cowling
// and exhausts.", then, with the fuselage selected, "Make this dark blue, and fix
// the engine intake so it sits on top of the cowling instead of sinking into the body."
title("Helicopter");

const R = param("Rotor radius", 5000, { min: 3000, max: 6500, step: 50, part: "Main rotor" });
const nBlades = param("Blades", 4, { min: 2, max: 6, step: 1, part: "Main rotor" });
const mastH = param("Mast height", 420, { min: 250, max: 800, step: 10, part: "Mast" });
const boomLen = param("Boom length", 4200, { min: 3000, max: 5500, step: 50, part: "Tail boom" });
const trR = param("Tail rotor radius", 700, { min: 400, max: 1000, step: 10, part: "Tail rotor" });

// ---------- Fuselage ----------
const cabinShape = ellipsoid(2100, 820, 900).at(300, 0, 1500);
const belly = box(2600, 1400, 500, 200).at(0, 0, 900);
const fuselage = union(cabinShape, intersect(belly, cabinShape.offset(60)), 120);
const deckZ = 2300;
const deck = box(2400, 1200, 300, 120).at(-500, 0, deckZ - 80);
const body = union(fuselage, deck, 200);
part("Fuselage", body, { color: "#1f3a6b" });

const canopy = intersect(
  cabinShape.offset(12),
  union(
    box(1800, 2000, 1200).rotateY(-25).at(1750, 0, 1950),
    box(1200, 2000, 900).at(1600, 0, 1350)
  )
);
part("Canopy", canopy, { color: "#7fb5d6" });

const sideWin = intersect(cabinShape.offset(10), box(900, 2000, 500, 120).at(-150, 0, 1800));
part("Side windows", sideWin, { color: "#7fb5d6" });

// ---------- Engine cowling and exhausts ----------
const cowl = union(
  ellipsoid(1350, 560, 420).at(-600, 0, deckZ + 120),
  box(1800, 1000, 300, 140).at(-550, 0, deckZ + 60),
  120
);
const inZ = deckZ + 350;
const nacelle = cylinder(170, 450, 40).rotateY(90).at(525, 0, inZ);
const intake = cylinder(135, 300).rotateY(90).at(800, 0, inZ);
const cowling = subtract(union(cowl, nacelle, 100), intake);
part("Engine cowling", cowling, { color: "#b1302a" });
part("Intake lip", torus(150, 30).rotateY(90).at(730, 0, inZ), { color: "#8c9196" });
part("Intake", cylinder(140, 20).rotateY(90).at(665, 0, inZ), { color: "#202326" });

function exhaust(side) {
  const outer = tube([[-1500, side * 300, deckZ + 220, 140], [-1950, side * 560, deckZ + 380, 130]]);
  const inner = tube([[-1600, side * 315, deckZ + 240, 100], [-2030, side * 577, deckZ + 390, 100]]);
  return subtract(outer, inner);
}
part("Exhausts", union(exhaust(1), exhaust(-1)), { color: "#5a5550" });
part("Exhaust heat shields", union(
  box(500, 30, 260, 10).rotateZ(-30).at(-1650, 470, deckZ + 250),
  box(500, 30, 260, 10).rotateZ(30).at(-1650, -470, deckZ + 250)
), { color: "#9a9590" });

// ---------- Mast & transmission ----------
const mastBase = deckZ + 380;
const fairing = revolve([[0, deckZ + 250], [380, deckZ + 250], [340, deckZ + 320], [220, mastBase], [0, mastBase]]);
part("Transmission fairing", fairing, { color: "#b1302a" });
const mastTop = mastBase + mastH;
part("Mast", cylinder(85, mastH + 60).at(0, 0, mastBase + (mastH + 60) / 2 - 30), { color: "#8c9196" });

const swashZ = mastBase + 90;
part("Swashplate", union(
  cylinder(260, 40, 8).at(0, 0, swashZ),
  cylinder(200, 30, 6).at(0, 0, swashZ + 45)
), { color: "#6d7378" });

// ---------- Main rotor ----------
const hubZ = mastTop;
let head = union(
  cylinder(230, 150, 20).at(0, 0, hubZ),
  cylinder(120, 140, 10).at(0, 0, hubZ + 130),
  sphere(110).at(0, 0, hubZ + 200)
);
const arm = union(
  capsule([150, 0, hubZ], [520, 0, hubZ], 70),
  box(260, 150, 110, 30).at(600, 0, hubZ),
  capsule([450, 60, hubZ - 20], [450, 230, hubZ - 20], 25),
  capsule([230, 230, swashZ + 60], [450, 230, hubZ - 20], 18)
);
head = union(head, arm.radial(nBlades, "z"), 30);

const chord = 320;
const bladeLen = R - 620;
const blade = box(bladeLen, chord, 45, 20).at(620 + bladeLen / 2, 0, hubZ);
const tip = box(300, chord + 4, 49, 20).at(R - 150, 0, hubZ);
const spinM = { axis: [0, 0, 1], center: [0, 0, 0], rpm: 240 };
part("Main rotor hub", head, { color: "#3a3f44", spin: spinM });
part("Main rotor", blade.radial(nBlades, "z"), { color: "#2a2d30", spin: spinM });
part("Blade tips", tip.radial(nBlades, "z"), { color: "#e8c22a", spin: spinM });

// ---------- Tail ----------
const boomStart = -1500;
const boomEnd = boomStart - boomLen;
part("Tail boom", capsule([boomStart, 0, 1900], [boomEnd, 0, 2150], 360, 130), { color: "#c8372d" });

const fin = extrude([
  [0, 0], [450, 0], [250, 1050], [-150, 1150], [-350, 950], [-250, -350], [100, -350]
], 70).rotateX(90).at(boomEnd + 50, 0, 2150);
part("Vertical fin", fin, { color: "#c8372d" });

const stabX = boomEnd + 900;
part("Stabilizer", union(
  box(420, 2000, 50, 20).at(stabX, 0, 2080),
  box(380, 40, 380, 15).at(stabX - 20, 1000, 2080),
  box(380, 40, 380, 15).at(stabX - 20, -1000, 2080)
), { color: "#c8372d" });

const trC = [boomEnd - 50, -170, 2900];
const trHub = union(cylinder(90, 120).rotateX(90), sphere(70).move(0, -70, 0));
const trBlades = box(110, 20, trR, 8).move(0, 0, trR / 2 + 40).radial(2, "y");
part("Tail rotor", union(trHub, trBlades).at(trC[0], trC[1], trC[2]),
  { color: "#2a2d30", spin: { axis: [0, 1, 0], center: trC, rpm: 1200 } });
part("Tail rotor gearbox", capsule([trC[0], 0, trC[2]], [trC[0], -110, trC[2]], 100), { color: "#6d7378" });
part("Tail skid", tube([[boomEnd + 300, 0, 1850, 30], [boomEnd + 100, 0, 1550, 25], [boomEnd - 150, 0, 1600, 20]]), { color: "#8c9196" });

// ---------- Landing skids ----------
function skid(side) {
  const y = side * 1050;
  const rail = tube([[-1700, y, 110, 55], [1500, y, 110, 55], [1850, y, 230, 50], [1950, y, 420, 45]], 150);
  const c1 = tube([[-900, y, 110, 50], [-900, y * 0.85, 520, 50], [-900, y * 0.55, 760, 50]], 150);
  const c2 = tube([[900, y, 110, 50], [900, y * 0.85, 520, 50], [900, y * 0.55, 760, 50]], 150);
  return union(rail, c1, c2, 20);
}
part("Landing skids", union(skid(1), skid(-1),
  capsule([-900, -580, 760], [-900, 580, 760], 50),
  capsule([900, -580, 760], [900, 580, 760], 50)), { color: "#8c9196" });

