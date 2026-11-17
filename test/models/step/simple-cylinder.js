// One simple exact part: a cylinder 40 mm across, 60 mm tall, standing on the floor.
// Volume: pi * 20^2 * 60 = 75398.22 mm3.
title("Cylinder 40 x 60");
part("Cylinder", cylinder(20, 60).at(0, 0, 30), { color: "#4f7cac" });
