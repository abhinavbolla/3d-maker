// Test fixture: a small helicopter, about 12 m long.
title("Helicopter");
const rotorLen = param("Blade length", 5200, { min: 3000, max: 7000, part: "Main rotor" });
const blades = param("Blades", 4, { min: 2, max: 6, step: 1, part: "Main rotor" });
const boomLen = param("Length", 6000, { min: 4000, max: 8000, part: "Tail boom" });

const cabin = ellipsoid(2200, 1100, 1150).at(0, 0, 1700);
const nose = ellipsoid(1200, 900, 800).at(1500, 0, 1450);
const engine = capsule([-600, 0, 2600], [-1800, 0, 2500], 600, 450);
const body = union(cabin, nose, engine, 300);
const windows = ellipsoid(1300, 1150, 600).at(1300, 0, 1950);
part("Fuselage", subtract(body, windows.offset(-30).cut(windows.offset(-60)).move(0, 0, 0)), { color: "#b8483e" });
part("Canopy", intersect(windows, body.offset(10)), { color: "#2f3338" });
part("Tail boom", tube([[-1600, 0, 2000, 420], [-1600 - boomLen, 0, 2350, 140]]), { color: "#b8483e" });
part("Fin", extrude([[0, 0], [700, 0], [300, 1300], [-200, 1300]], 80).rotateX(90).at(-1600 - boomLen - 100, 0, 2300), { color: "#b8483e" });
const blade = box(rotorLen, 320, 50, 20).at(rotorLen / 2, 0, 0);
part("Main rotor", union(blade.radial(blades), cylinder(260, 220)).at(-200, 0, 3350), { color: "#2f3338", spin: { axis: [0, 0, 1], center: [-200, 0, 3350], rpm: 300 } });
part("Mast", cylinder(110, 600).at(-200, 0, 3000), { color: "#5b6670" });
const tblade = box(700, 120, 30, 10).at(350, 0, 0);
part("Tail rotor", tblade.radial(2).rotateX(90).at(-1600 - boomLen, 260, 2500), { color: "#2f3338", spin: { axis: [0, 1, 0], center: [-1600 - boomLen, 260, 2500], rpm: 1200 } });
const skid = tube([[2200, 0, 150, 70], [-1800, 0, 150, 70], [-2300, 0, 300, 70]]);
const strut = capsule([700, 0, 160], [500, 0, 900], 60);
const strut2 = capsule([-1000, 0, 160], [-900, 0, 900], 60);
part("Skids", union(skid, strut, strut2).move(0, 1000, 0).symmetric("y"), { color: "#5b6670" });
