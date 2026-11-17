// Parts that Draftsman writes to STEP with exact surfaces, plus two that are
// faceted (a drilled block and a smooth blend), for checking in a CAD program.
title("STEP exact parts sample");
part("Bracket plate", extrude(rect(80, 40, 6).cut(circle(6).move(-25, 0), circle(6).move(25, 0)), 8).at(0, -80, 4), { color: "#4f7cac" });
part("Cam", extrude(path([0, 0]).line(40, 0).tangentArc(40, 20).line(0, 20).radiusArc(0, 0, 10).close(), 6).at(60, 0, 3), { color: "#d9a441" });
part("Bearing ring", revolve(rect(10, 8).cut(circle(2)).move(20, 0)).at(0, 0, 4), { color: "#9aa3ad" });
part("Shaft", cylinder(6, 80, 1).at(0, 0, 40), { color: "#5b6670" });
part("Knob", sphere(10).at(0, 0, 90), { color: "#b8483e" });
part("Spacer", cone(12, 8, 10).at(-60, 0, 5), { color: "#6b8f5e" });
part("O-ring", torus(18, 2).at(0, 0, 12), { color: "#2f3338" });
part("Link", capsule([-60, 40, 10], [-20, 60, 10], 5, 3), { color: "#c9cdd2" });
part("Quarter cover", revolve(rect(30, 4).move(15, 0), 90).at(0, 60, 2), { color: "#4f7cac" });
part("Feet", cylinder(4, 6).at(40, 0, 0).radial(4).at(0, 0, -3), { color: "#2f3338" });
part("Drilled block (faceted)", box(30, 30, 20).cut(cylinder(6, 30)).at(-60, -60, 10), { color: "#d9a441" });
part("Blend (faceted)", union(sphere(10), sphere(8).at(12, 0, 0), 4).at(70, -60, 10), { color: "#b8483e" });
