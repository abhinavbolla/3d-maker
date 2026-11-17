// A small single-storey house, 9 x 7 m outside: two bedrooms, a bathroom,
// a kitchen, a living room and a hall from the front door. Used by the
// building tests and the floor-plan run; the numbers in the comments are
// what the tests check against.
title("Two-bedroom house");
house({ height: 2700, wall: 300, partition: 100, slab: 200 });
// Outside corners. Inside, the outer walls leave 8400 x 6400.
outerWalls([[0, 0], [9000, 0], [9000, 7000], [0, 7000]]);

// Inner walls along their centre lines, 100 thick. Ends inside the outer
// walls are trimmed to their inner face.
wall("Living wall", [[4000, 0], [4000, 7000]]);
wall("Kitchen wall", [[5500, 0], [5500, 7000]]);
wall("Bedroom 2 wall", [[0, 3800], [4000, 3800]]);
wall("Bedroom 1 wall", [[5500, 3850], [9000, 3850]]);
wall("Bathroom wall", [[4000, 5050], [5500, 5050]]);

room("Living room", [2000, 2000]);   // 3650 x 3450 = 12.59 m2
room("Bedroom 2", [2000, 5000]);     // 3650 x 2850 = 10.40 m2
room("Hall", [4750, 2500]);          // 1400 x 4700 = 6.58 m2
room("Bathroom", [4750, 6000]);      // 1400 x 1600 = 2.24 m2
room("Kitchen", [7000, 2000]);       // 3150 x 3500 = 11.03 m2
room("Bedroom 1", [7000, 5000]);     // 3150 x 2800 = 8.82 m2

// Outer walls: "at" is the opening's centre, from the wall's left end seen from outside.
door("South wall", 4750, { width: 1000, name: "Front door" });
window("South wall", 1950, { width: 1800, name: "Living window" });
window("South wall", 7100, { width: 1500, name: "Kitchen window" });
window("East wall", 2000, { width: 1200, name: "Kitchen side window" });
window("East wall", 5300, { width: 1200, name: "Bedroom 1 side window" });
window("North wall", 1900, { width: 1500, name: "Bedroom 1 window" });
window("North wall", 4250, { width: 600, height: 600, sill: 1500, name: "Bathroom window" });
window("North wall", 6900, { width: 1500, name: "Bedroom 2 window" });
window("West wall", 1700, { width: 1200, name: "Bedroom 2 side window" });
window("West wall", 5000, { width: 1200, name: "Living side window" });

// Inner doors: "at" from the wall's first point, opening into a room.
door("Living wall", 2000, { opens: "Living room", hinge: "start", name: "Living door" });
door("Living wall", 4400, { width: 800, opens: "Bedroom 2", hinge: "end", name: "Bedroom 2 door" });
door("Kitchen wall", 2500, { opens: "Kitchen", hinge: "start", name: "Kitchen door" });
door("Kitchen wall", 4400, { width: 800, opens: "Bedroom 1", hinge: "end", name: "Bedroom 1 door" });
door("Bathroom wall", 750, { width: 700, opens: "Bathroom", hinge: "start", name: "Bathroom door" });

roof({ type: "gable", pitch: 30, overhang: 400, ridge: "x" });
