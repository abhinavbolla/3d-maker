// Example: an angle bracket bolted to a plate. Socket bolts go down through
// counterbored holes into tapped holes in the plate; hex bolts go through
// the upright with a washer and a nut behind.
title("Angle bracket");

const W = param("Width", 90, { min: 60, max: 160, step: 5, part: "Bracket" });
const Hgt = param("Height", 70, { min: 50, max: 120, step: 5, part: "Bracket" });
const T = param("Thickness", 8, { min: 6, max: 14, step: 1, part: "Bracket" });
const D = 60; // how far the foot reaches out
const P = 10; // the plate's thickness

// The bracket: an L-shaped outline pushed out to the width, with a rounded
// inside corner and a rib at each side.
const L = extrude(polygon([[0, 0], [D, 0], [D, T], [T, T], [T, Hgt], [0, Hgt]], 1.5), W).rotateX(90);
const rib = extrude(polygon([[T - 1, T - 1], [D * 0.75, T - 1], [T - 1, Hgt * 0.75]], 1), 6).rotateX(90);
let bracket = union(L, rib.move(0, W / 2 - 3, 0), rib.move(0, -W / 2 + 3, 0), 3);

// Two counterbored holes in the foot, two clearance holes in the upright.
const footX = T + (D - T) / 2 + 2;
const ys = [-W / 2 + 18, W / 2 - 18];
const upZ = T + (Hgt - T) * 0.6;
for (const y of ys) {
  bracket = bracket.cut(hole("M6", T, { cbore: true }).at(footX, y, T));
  bracket = bracket.cut(hole("M8", T + 2).rotateY(-90).at(-1, y, upZ));
}
part("Bracket", bracket, { color: "#9aa1a8", material: "metal" });

// The plate under it, with a tapped hole under each socket bolt.
let plate = box(D + 50, W + 50, P, 2).at(D / 2 - 5, 0, -P / 2);
for (const y of ys) plate = plate.cut(hole("M6", P, { tapped: true }).at(footX, y, 0));
part("Plate", plate, { color: "#4f5a64", material: "paint" });

const m6 = metric("M6"), m8 = metric("M8");
const socketLen = T - m6.cbore.depth + P - 1; // ends 1 mm short of the plate's underside
part("Socket bolts", union(ys.map((y) => bolt("M6", socketLen, { head: "socket" }).at(footX, y, T - m6.cbore.depth))), { color: "#2b2d30", material: "metal" });

// Through the upright along +X: head behind it, washer and nut in front.
const hexLen = T + m8.washer.h + m8.nut.m + 3;
part("Hex bolts", union(ys.map((y) => bolt("M8", hexLen).rotateY(-90).at(0, y, upZ))), { color: "#2b2d30", material: "metal" });
part("Washers", union(ys.map((y) => washer("M8").rotateY(90).at(T, y, upZ))), { color: "#c3c8cd", material: "metal" });
part("Nuts", union(ys.map((y) => nut("M8").rotateY(90).at(T + m8.washer.h, y, upZ))), { color: "#c3c8cd", material: "metal" });
