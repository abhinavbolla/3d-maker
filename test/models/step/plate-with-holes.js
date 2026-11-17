// An extrusion with holes: an 80 x 50 mm plate, 6 mm thick, corners rounded
// 6 mm, four 6 mm holes 30 mm and 17 mm from the middle, and a slot.
// Volume: (80*50 - (4 - pi)*36 - 4*pi*9 - (20*6 + pi*9)) * 6
//       = (4000 - 30.9026 - 113.0973 - 148.2743) * 6 = 22246.35 mm3.
title("Plate with holes");
const holes = [[-30, -17], [30, -17], [30, 17], [-30, 17]].map(([x, y]) => circle(3).move(x, y));
const slot = path([-10, -3]).line(10, -3).radiusArc(10, 3, 3).line(-10, 3).radiusArc(-10, -3, 3).close();
part("Plate", extrude(rect(80, 50, 6).cut(...holes, slot), 6).at(0, 0, 3), { color: "#9aa3ad" });
