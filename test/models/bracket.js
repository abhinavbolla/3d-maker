// An angle bracket with holes, kept as a test for drawings: a base plate with
// four 9 mm holes and one 20 mm bore, an upright with two 6.6 mm holes, and a
// turned bush. Holes are cut with hole() and cylinder(), so the drawing can
// take their sizes from the script.

title("Angle bracket");
const T = 10;
const base = box(120, 80, T).at(0, 0, T / 2);
const upright = box(T, 80, 60).at(-55, 0, T + 30);
const holes = [-30, 30].flatMap((x) => [-25, 25].map((y) => hole(9, T).at(x + 15, y, T)));
const bore = cylinder(10, T * 3).at(5, 0, T / 2);
const sideHoles = [-20, 20].map((y) => cylinder(3.3, T * 3).rotateY(90).at(-55, y, 50));
part("Bracket", union(base, upright).cut(...holes, bore, ...sideHoles));
part("Bush", subtract(cylinder(14, 16), cylinder(6, 20)).at(5, 0, T + 8));
