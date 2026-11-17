// Example: a coffee mug on a cork coaster. The mug is turned from one
// profile, the handle is swept along a curve, and each has sliders.
title("Coffee mug");

const H = param("Height", 95, { min: 70, max: 140, step: 1, part: "Mug" });
const R = param("Diameter", 84, { min: 60, max: 110, step: 1, part: "Mug" }) / 2;
const wall = param("Wall", 4, { min: 2.5, max: 7, step: 0.5, part: "Mug" });
const reach = param("Reach", 34, { min: 24, max: 50, step: 1, part: "Handle" });
const grip = param("Width", 14, { min: 10, max: 22, step: 1, part: "Handle" });

const base = 5; // the coaster's thickness: the mug stands on it
// The mug flares a little towards the rim.
const r = (h) => R - 3 + (3 * h) / H;

const outer = revolve(path([0, 0]).line(r(0) - 5, 0).curve([r(0), 0], [r(3), 3]).line(r(H), H).line(0, H).close());
const inner = revolve(path([0, wall + 2]).line(r(wall) - wall - 5, wall + 2).curve([r(wall) - wall, wall + 2], [r(wall + 6) - wall, wall + 6]).line(r(H + 10) - wall, H + 10).line(0, H + 10).close());
const lip = torus(r(H) - wall / 2, wall / 2).at(0, 0, H);
part("Mug", union(subtract(outer, inner), lip).at(0, 0, base), { color: "#2f5d8a", material: "paint" });

// The handle runs from just under the rim to near the foot, and is trimmed
// where it meets the mug so the two touch without passing into each other.
const top = H * 0.8, low = H * 0.24;
const curve = [[r(top) - 2, 0, top], [r(top) + reach * 0.7, 0, top + 2], [r(H / 2) + reach, 0, (top + low) / 2], [r(low) + reach * 0.6, 0, low - 2], [r(low) - 2, 0, low]];
const handle = sweep(rect(9, grip, 4), curve, { up: [0, 1, 0] });
part("Handle", handle.cut(outer).at(0, 0, base), { color: "#2f5d8a", material: "paint" });

part("Coaster", cylinder(R + 16, base, 2).at(0, 0, base / 2), { color: "#b48a5c", material: "rubber" });
