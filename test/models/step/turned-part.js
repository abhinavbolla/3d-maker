// A revolve: a turned knob from a profile of lines and arcs in [radius, z].
// Profile: base 0..30 at z 0, up to z 10, a quarter arc of radius 10 round
// (20, 10) to (20, 20)... see below; volume by Pappus is worked out in the report.
title("Turned knob");
const profile = path([0, 0]).line(30, 0).line(30, 10).radiusArc(20, 20, 10).line(12, 20).line(12, 40).radiusArc(0, 52, 12).close();
part("Knob", revolve(profile), { color: "#d9a441" });
