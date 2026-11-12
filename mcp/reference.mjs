// The 3D Maker modelling language, as Claude reads it: every function, with
// examples, and how to work. Claude Code shows an MCP server's instructions
// only up to 4096 characters, so this is not the server's instructions: the
// server returns it from its reference tool, and the app puts it in the
// system prompt of the Claude runs it starts.
export const REFERENCE = `3D Maker turns a short JavaScript model script into solid 3D parts the user sees live. You write the whole script with set_model (or change part of it with edit_model), then look at it with screenshot and fix what looks wrong.

Units are millimetres, +Z is up, the ground is z = 0, angles are degrees. Model real objects at real size (a mug is about 95 mm tall, a car about 4500 mm long). Every shape is a solid; joins, cuts and blends never fail.

PRIMITIVES (all centred on the origin)
  box(x, y, z, round?)            round = edge radius, at most half the smallest side
  sphere(r)
  ellipsoid(rx, ry, rz)           good for bodies, fuselages, heads, pebbles
  cylinder(r, h, round?)          along Z
  cone(r1, r2, h)                 along Z; r1 at the bottom, r2 at the top; either may be 0
  torus(R, r)                     ring in the XY plane
  capsule([x,y,z], [x,y,z], r1, r2?)   rounded rod between two points, optionally tapered. Great for struts, limbs, booms, handles, legs
  tube([[x,y,z,r], ...], smooth?) rounded rods through several points with a radius at each point: pipes, cables, tails, skids
  extrude(profile, h, { draft })  a profile (below) pushed along Z (centred: from -h/2 to h/2). A list of [x, y] points also works.
                                  draft: degrees the sides lean in going up (out if negative), as on moulded and cast parts; the bottom keeps the profile
  revolve(profile, angle?)        a profile drawn as [radius, height] (x >= 0) spun around Z, all the way or through angle degrees from +X: vases, glasses, wheels, nose cones, pipe bends
  sweep(profile, path, { smooth, closed, twist, up })
                                  a profile carried along a path: handrails, frames, gaskets, hoses, wires, springs, bent tubes, mouldings, coils.
                                  path: [[x,y,z], ...] (a smooth curve through the points; smooth: false keeps straight runs with mitred corners), helix(r, pitch, turns), or path(...) in the XY plane (closed with .close() for a ring).
                                  The profile's y axis points up (+Z, or up: [x,y,z]) and it stays square to the path. closed: true joins the ends. twist: degrees of twist from start to end.
  loft([[z, profile], ...], { smooth })
                                  a solid through profiles at increasing heights z (smooth by default): wings and blades (airfoil sections), fuselages, hulls, bottles, shoes, handles, transitions from round to square.
                                  Sections morph into each other in proportion, so chord, thickness and sweep change smoothly. Loft along Z, then rotate it into place.
  views({ side, top, front }, smooth?)
                                  a solid from its outlines in two or three views, the way a body is drawn on paper: the solid is what all the outlines share.
                                  side: outline x = world X, outline y = world Z. top: x = X, y = Y. front: x = Y, y = Z. smooth rounds the edges where the views meet.
                                  Plain views() gives box-like cross-sections: right for flat-sided things (a truck box, a cabinet, a bracket).
  views({ side, top, round, belly, tumble })
                                  a body with ROUNDED cross-sections along X: at each x the section is as tall as the side outline and as wide as the top outline there.
                                  round: its shape, 2 an oval, 3 a soft box, 5+ nearly square; belly: the lower half's (default round); tumble: 0 to 0.4, how much the
                                  sides lean in towards the top. Each is a number or a table [[x, value], ...] along the length, so a squarish cabin flows into an oval
                                  tail cone and a round boom. No front outline. The best way to make fuselages, hulls, car bodies, nacelles, drone and robot shells.

PROFILES (flat outlines in their own XY plane, for extrude, revolve, sweep and loft)
  circle(r)    rect(w, h, round?)    polygon([[x,y], ...], round?)     round = corner radius
  text("Label", size, { align, pen, spacing, lineHeight })
                                  text in our own single-stroke font (technical lettering): size is the capital height. Centred on the origin; align "left" or "right" puts the
                                  first line's baseline start or end there. pen: stroke width (default 12% of size). "\\n" starts a new line. Extrude it to raise it, cut it to engrave it.
                                  Characters: A-Z a-z 0-9 space . , : ; ! ? ' " - + = _ / \\ | ( ) [ ] # % * < > $ ° & @
  airfoil("2412", chord)          NACA 4-digit wing section: leading edge at the origin, chord along +x, upper surface up. "0012" is symmetric; "4415" is thick and cambered
  path([x, y])                    an outline drawn piece by piece, chained:
    .line(x, y)  .lineBy(dx, dy)  straight
    .arc([x, y], [x2, y2])        arc through the first point to the second
    .radiusArc(x, y, r)           arc of radius r to (x, y); r > 0 bends left, r < 0 right
    .tangentArc(x, y)             arc to (x, y) continuing smoothly from the last piece
    .curve([cx, cy], [x, y])  .curve([c1x, c1y], [c2x, c2y], [x, y])   Bezier curves
    .spline([[x, y], ...])        a smooth curve through these points
    .close(round?)                back to the start: makes it a profile (round = corner radius)
    .stroke(w)                    or leave it open and draw it with a round pen w wide: a profile for slots, grooves, raised lines
  Profile methods: .move(x, y) .rotate(deg) .scale(s) or .scale(sx, sy) .mirror("x"|"y") .offset(d)
    .add(other, ..., smooth?)  .cut(other, ...)  .common(other, ...)    combine outlines before making a solid: holes, slots, keyways

  EXAMPLE: profiles, sweep and loft
    const glass = path([0, 0]).line(35, 0).line(35, 3).line(4, 8).line(4, 90).curve([40, 100], [38, 170]).line(35, 170).curve([37, 103], [0, 96]).close();
    part("Glass", revolve(glass));
    part("Rail", sweep(circle(6), [[0, 0, 0], [100, 0, 40], [200, 60, 40], [260, 60, 0]]).at(-100, -80, 0));
    part("Spring", sweep(circle(2), helix(15, 8, 6)).at(300, 0, 0));
    part("Wing", loft([[0, airfoil("2412", 300)], [900, airfoil("0012", 120).move(150, 0)]]).rotateX(-90).at(0, 300, 0));
    part("Bracket", extrude(rect(80, 40, 6).cut(circle(6).move(-25, 0), circle(6).move(25, 0)), 8).at(0, -150, 4));

  EXAMPLE: text, wrapping, twist, taper, lattice, hull
    part("Plate", extrude(rect(120, 40, 5), 6).at(0, 0, 3).cut(extrude(text("3D MAKER", 12), 4).at(0, 0, 6)));   // engraved 2 mm deep
    const R = 40;
    part("Mug", cylinder(R, 90).at(0, 200, 45));
    part("Label", extrude(text("COFFEE", 14), 1).at(0, 0, 0.5).bend(-R).rotateX(90).at(0, 200 - R, 50));   // wrapped round the mug, standing 1 mm proud
    print(bounds(text("COFFEE", 14)).size[0] / R * 180 / Math.PI);   // degrees of the mug the label covers: keep clear of the handle
    part("Vase", extrude(polygon([[30, 0], [15, 26], [-15, 26], [-30, 0], [-15, -26], [15, -26]], 4), 150).at(0, 0, 75).twist(120).taper(0.6).at(-150, 0, 0));
    part("Infill", box(60, 60, 30).lattice("gyroid", 15, 1.5, { skin: 2 }).cut(box(70, 40, 40).at(0, -30, 20)).at(150, 0, 15));
    part("Arm", hull(sphere(15), sphere(8).at(120, 0, 30)).at(0, -150, 15));

HARDWARE (ISO metric, sizes "M2" to "M36")
  thread("M10", 40)               a threaded rod along Z, centred like cylinder. thread(10, 40, { pitch: 1.25, left: true }) for other pitches
  hole("M6", depth, { tapped, cbore, csink, tip })
                                  a hole to cut away, going down from z = 0: move it to the surface, then cut. "M6": clearance hole for an M6 bolt.
                                  tapped: true threads it for the bolt. cbore: true counterbores it for a socket head (or [diameter, depth]); csink: true countersinks it 90° for a flat head (or a diameter).
                                  tip: true adds a 118° drill point. A number instead of "M6" is a plain drill diameter. Rotate it first for holes in side faces.
  bolt("M6", length, { head, thread })
                                  head: "hex" (default), "socket" or "flat". The head sits on z = 0 and the threaded shank goes down to -length; a flat head's top is at z = 0 (flush in a csink hole). thread: false draws the shank smooth
  nut("M6")  washer("M6")         stand on z = 0. Under a part, turn them over: nut("M6").rotateX(180).at(x, y, underside)
  metric("M6")                    the sizes: { d, pitch, clearance, tapDrill, hex: { s, k }, socket: { d, k }, flat: { d, k }, nut: { s, m }, washer: { d, D, h }, cbore: { d, depth } }
  Bolts and holes made at the same x, y and z fit exactly: a bolt in its tapped hole, a socket head flush in its counterbore at the surface minus cbore.depth.

  EXAMPLE: a bracket bolted down
    const T = 20;
    const plate = extrude(rect(120, 60, 5), T).at(0, 0, T / 2).cut(hole("M8", T, { cbore: true }).at(-40, 0, T), hole("M8", T, { tapped: true }).at(40, 0, T));
    part("Plate", plate);
    part("Socket bolt", bolt("M8", 16, { head: "socket" }).at(-40, 0, T - metric("M8").cbore.depth));
    part("Washer", washer("M8").at(40, 0, T));
    part("Hex bolt", bolt("M8", 16).at(40, 0, T + metric("M8").washer.h));

COMBINING (smooth is an optional blend radius in mm; leave it out for a sharp join)
  hull(a, b, ...)                 the convex hull: the smallest convex solid around all of them, like a skin stretched over them. Smooth arms between two joints, tapered links, cases
  union(a, b, ..., smooth?)       also a.add(b, ..., smooth?)
  subtract(a, b, ..., smooth?)    cut b, c, ... out of a; also a.cut(b, ...)
  intersect(a, b, ..., smooth?)   keep only the overlap; also a.common(b, ...)
  Arrays of shapes work anywhere a list of shapes is expected.

METHODS (each returns a new shape; chain them)
  .move(x, y, z)  .at(x, y, z)
  .rotate(rx, ry, rz)             about world X, then Y, then Z, through the origin, so rotate before you move
  .rotateX(d) .rotateY(d) .rotateZ(d)
  .scale(s) or .scale(sx, sy, sz)
  .offset(d)                      grow (d > 0) or shrink (d < 0) the surface by d
  .shell(t)                       hollow it, keeping a wall of thickness t inside the surface; cut an opening to see in
  .mirror("x")                    reflect across the plane x = 0 (or "y", "z")
  .symmetric("y")                 make it symmetric across y = 0, keeping the y >= 0 side. Model one side, then mirror it
  .twist(deg)                     turn it about Z, from 0 at its bottom to deg at its top: twisted vases, drill flutes, twisted columns
  .taper(s) or .taper(sx, sy)     scale it across X and Y (about the Z axis) from 1 at its bottom to s at its top: tapered legs, towers, horns
  .bend(r)                        bend its X axis onto a circle of radius |r| through the origin, in the XZ plane: r > 0 curls the ends up (+Z), r < 0 down.
                                  Lengths along z = 0 are kept, so a length L turns through L / r radians. Model it straight along X, bend it, then place it
  .lattice(kind, cell, wall, { skin })
                                  fill it with a lattice: "gyroid" or "diamond" (smooth, strong, printable infill), "grid" (square struts) or "honeycomb" (hexagonal cells along Z),
                                  repeating every cell mm with walls wall mm thick. skin: keep a solid outer wall that thick (cut it open to show the inside)
  .radial(n, "z")                 n copies spaced evenly around the axis through the origin: blades, spokes, bolts
  .array(n, dx, dy, dz)           n copies, each moved one step further

PARTS, VALUES, MOTION
  part(name, shape, { color: "#rrggbb", material, spin: { axis, center, rpm }, swing: { axis, center, angle, seconds }, follow, motion, hidden })
    Every visible piece must be a part with a unique, plain name ("Main rotor", "Left door"). The user clicks parts to select and tweak them.
    material is how the surface is drawn: "metal" (machined or cast metal), "paint" (glossy painted skin), "plastic" (satin), "rubber" (matt: tyres, seals, grips) or "glass" (see-through: windows, canopies, lenses). Give every part the material the real one has. Without it, grey parts are drawn as metal, near-black ones as rubber and coloured ones as paint.
    spin rotates the part forever around the line through center along axis ("x", "y", "z" or [x, y, z]): rotors, wheels, fans. swing rocks it back and forth by ±angle: doors, pendulums, wings. Motion is only shown in the app, not exported.
  param(label, value, { min, max, step, part })
    Returns the number to use, and gives the user a slider. Always set part to the part it mainly affects, so the slider appears when they click that part. Add 1 to 3 sliders per important part for its main dimensions (length, width, count, angle). Keep labels short ("Length", "Blades").
  title("Name")                   names the model (used for the exported file)
  print(...values)                values to see in the tool result, for checking measurements
  bounds(shape or profile)        { min, max, size }: the box around it, to measure before placing (how long a text is, how tall a part is)

You can use normal JavaScript: const, functions, loops, Math. There is no import, file access or network.

LINKED MOTION (mechanisms whose parts drive each other)
  Model every part at rest, in world coordinates. Motion moves it from rest; t is in seconds.
  part(..., { follow: "Other part" })     moves with that part: a blade follows the hub, the rotating swashplate follows the stationary one. The part's own spin, swing and motion are applied first, then everything the followed part does.
  part(..., { motion: t => pose })        the part's own motion at time t.
  turn(deg, axis, center)                 a rotation about the line through center along axis ("x", "y", "z" or [x, y, z])
  slide(dx, dy, dz)                       a move
  link(a0, b0, a, b)                      moves a rigid rod whose ends rest at a0 and b0 so they sit at a and b: pitch links, connecting rods, push rods. The app checks every link: the summary's motion.links gives max_stretch_mm, how far a and b ever get from the rod's length.
  turn(...).slide(...), pose.then(other)  chain poses, each moving the result of the last; still() is no motion
  where("Part", [x, y, z], t)             where a point, given at rest on that part, is at time t (with everything it follows). Use it inside motion functions so one part's motion comes from another's.
  joint("Part A", "Part B", [x, y, z])    a point (at rest) where two parts connect: every pin, ball joint and rod end. The app checks it over the whole loop; the summary lists each joint's max_gap_mm and warns when one comes apart.
  loop(seconds)                           the animation's length; it repeats. Pick speeds that complete whole turns in it. Default: found from spin and swing, else 4 s.
  screenshot with at: seconds             shows the pose at that moment. Check a mechanism at two or three moments.

  EXAMPLE: crank, connecting rod and piston (the joints stay closed exactly)
    loop(1);
    part("Crank", cylinder(30, 10).rotateX(90).at(0, -10, 0), { spin: { axis: "y", rpm: 60 } });   // beside the rod, not through it
    const pin = [0, 0, 25], top = [0, 0, 125];          // the rod's ends at rest, 100 mm apart
    part("Piston", cylinder(20, 30).at(0, 0, 135), { motion: t => { const p = where("Crank", pin, t); return slide(0, 0, p[2] + Math.sqrt(100 ** 2 - p[0] ** 2) - top[2]); } });
    part("Rod", capsule(pin, top, 5), { motion: t => link(pin, top, where("Crank", pin, t), where("Piston", top, t)) });
    joint("Rod", "Crank", pin);
    joint("Rod", "Piston", top);

  DRIVEN LEVERS: when a rod moves a lever that turns about its own axis (pitch horns, steering arms, rocker arms, suspension), work the lever's angle out from where the rod's driven end is, so the rod keeps its length: for a lever arm of length a, angle = asin((height of the rod end in the lever's frame - its rest height) / a). Give the lever its motion from that angle and the rod link(...) between where() of its two ends. Declare joints at both ends of every rod.

EXAMPLE
  title("Desk lamp");
  const armLen = param("Arm length", 320, { min: 150, max: 500, part: "Arm" });
  const tilt = param("Tilt", 35, { min: 0, max: 80, part: "Arm" });
  part("Base", cylinder(80, 16, 6).at(0, 0, 8), { color: "#2f3338" });
  const top = [Math.sin(tilt * Math.PI / 180) * armLen, 0, 16 + Math.cos(tilt * Math.PI / 180) * armLen];
  part("Arm", capsule([0, 0, 16], top, 9), { color: "#9aa3ad" });
  const shade = cone(70, 25, 90).shell(2).cut(cylinder(68, 20).at(0, 0, -45)).rotateY(110).at(top[0] + 40, 0, top[2] - 20);
  part("Shade", shade, { color: "#b8483e" });

MAKING IT LOOK REAL (anything)
- Form: no visible main part is a bare box, cylinder or sphere. Make each one the way the real one is shaped:
  bodies, hulls, shells and housings: views({ side, top, round }) or a loft of sections that change along the length;
  turned parts (watch cases, hubs, flywheels, pistons, lift columns, knobs): revolve a real profile with its steps, chamfers, grooves and a domed or curved back;
  seats, backs, panels and covers people touch: curved (loft between curved profiles, .bend()), with rounded, thicker edges;
  keels, rudders, fins, wings, blades, propellers: loft of airfoil() sections that taper and twist;
  castings (crankcases, gearboxes, robot links, brackets): rounded sections, bosses where shafts enter, ribs, and union(a, b, smooth) where pieces of one casting meet so they read as one part, not glued-on blocks.
- Before you finish, go through the main visible parts: any still made from a plain primitive with nothing shaping it gets reshaped.

MAKING IT LOOK REAL (vehicles, aircraft, machines)
- Proportions first. Put the real overall dimensions at the top as constants (length, height, width, wheelbase or rotor diameter, cabin size) and check the result with bounds() and print().
- Shape the body from its outlines: views({ side, top, round }) with the real side outline (nose, windshield rake, roof line, the hump over the engines, belly, how the tail tapers) and top outline (how it narrows to nose and tail). Draw each outline with every break the real one has (usually 15 to 30 points and curves), not a few round corners. Then give the sections their real shape with a round table along the length: a cabin about 3.5 with a flatter belly (belly 5) and tumble 0.1, a tail cone easing to 2.4, a boom 2. Plain views() with a front outline gives slab sides with rounded corners, which reads as a box.
- Let sections flow into each other the way the real skin does: a tail cone continues the cabin's roof and belly lines and tapers to the tail, a nacelle or fairing widens smoothly out of the roof. A thin tube or box stuck onto the end of another reads as a toy. Draw the body and tail cone as one outline, or blend them with union(a, b, smooth).
- The eye knows a vehicle by its features. Add them as separate small pieces, each a real shape: glazing split into framed panes, doors with frames, hinges and handles, steps and grab handles, antennas, navigation and anti-collision lights, pitot tubes, intake screens, exhaust deflectors, access panels standing slightly proud, mirrors, wipers, tie-downs. Small pieces added to a part keep their own mesh detail.
- A mechanism inside a vehicle (a rotor head, a landing gear, a suspension) gets the same pieces, motion and joints it would get if it were asked for alone. A helicopter rotor head: the swashplate tilts, and as the rotor turns each pitch link pushes its horn so that blade's pitch changes; every blade, grip, horn and link is its own part, made in a loop, with a joint() at both ends of each link.
- Legs, struts, booms and arms carry weight and look it: a landing-gear strut is about a fifth to a quarter of its wheel's diameter thick, with a fork or axle yoke, a drag brace and a shock absorber; no load-carrying tube is thinner than about a fifteenth of its length. Keep them short by putting wheels and mounts where the real ones are.
- Detail finer than about twice a part's detail_mm (finish_step lists it) cannot show; panel lines and rivets on a big body need to be separate pieces or left out.
- Real colours and materials: the real paint (material "paint"), tinted glass ("glass", so the cabin shows through), black rubber ("rubber"), grey metal ("metal"), and slightly different shades for different materials.
- Point the nose toward +X. Then screenshot view "front" shows the side (the views() side outline), "top" the plan and "right" the nose. These straight-on views are flat, like a drawing (no perspective), so lengths compare truly across the picture. On the ground grid the red line is the X axis and the green line the Y axis. When the shape is done, take all three and compare each with the real object seen that way. Fix proportions and outlines before adding more detail.

HOW TO WORK
- Small things (up to about 5 parts: a mug, a bracket, a lamp): write the whole script with one set_model call, then screenshot and fix.
- Anything bigger or mechanical (vehicles, machines, mechanisms, robots, a rotor head, an engine): build it with a plan, the way an engineer builds an assembly.
  1. Call set_plan first, quickly: the user sees nothing but "Thinking" until the plan is up. Think only about what the real object is made of: its sub-assemblies and the real pieces in each (bolts, links, bearings, clamps, brackets). Do not work out dimensions, positions or code yet; that comes step by step.
  2. The plan has 6 to 30 steps in build order, from the core outwards. Each step is one sub-assembly and lists the part names it will create, exactly as you will pass them to part(). Every part belongs to one step.
  3. Step 1: decide the few shared dimensions every step depends on (overall sizes, axis heights, where sub-assemblies meet), then set_model with title(), those as constants at the top (and sliders for the main ones), and the first step's parts. Later steps: work out that step's own dimensions, then append_to_model with its code, reusing the constants so pieces line up.
  4. After each step call finish_step. It checks the step's parts exist and are solid and shows you just those parts against the rest. Look hard: fix anything floating, intersecting wrongly, mis-sized or crude with edit_model, then move on. Never skip finish_step, and finish every step.
  5. When all steps are done, screenshot the whole model from two or three views and fix what is still wrong.
- Mechanisms (anything where parts drive each other: rotor heads, engines, linkages, landing gear, robot arms): use LINKED MOTION, declare a joint() at every connection (one per copy: four links have eight joints), and finish only when every joint's max_gap_mm and every link's max_stretch_mm is under 1, there are no motion warnings, and screenshots at two or three moments look right. Make each moving piece its own part.
- Solid parts touch; they do not pass through each other. finish_step lists the step's overlaps: fix each one, by cutting a hole where one part fits into another (a shaft into a hub, a blade root into a grip, a bolt into a plate) or by moving it. When the model is done, call check_fit once for all of it; for mechanisms it also finds moving parts hitting anything during the motion.
- Every screw, bolt, nut, washer, threaded rod and threaded or counterbored hole is made with bolt(), nut(), washer(), thread() and hole() at a real size, never with plain cylinders. Moulded and cast parts (housings, enclosures, trays) are extrudes with draft, then shell.
- Do not finish while check_fit lists an overlap you have not fixed. An overlap listed with joints is away from those joints, so it is real. In your answer, say parts do not collide only if the last check_fit after your last change found nothing.
- Model real pieces as separate named parts, not one blob: a hub, each clamp, each link, each damper. Detail is what makes it look real: bolts, fillets, lightening holes, chamfers, bearing races.
- For changes to an existing model, prefer edit_model. If the model has an unfinished plan (get_model shows plan), continue it.
- Pick the operation the real part is made by: turned parts with revolve, plates and brackets with extrude of a profile with holes, bent tube, wire, rails and seals with sweep, wings, blades, hulls and fuselages with loft, springs with sweep along a helix. Draw real outlines with path() curves rather than stacking boxes.
- Build recognisable silhouettes from smooth blends of ellipsoids, capsules, tubes, revolves and lofts; add detail (windows, panels, bolts) with subtract and small shapes; use symmetric() for anything with left and right sides.
- After every change, call screenshot (try "iso", then "front", "top" or "right" as needed) and fix anything that looks wrong: parts floating apart, poking through each other, wrong proportions, missing pieces. A part listed as empty, or one much thinner than its detail_mm, needs to be thicker.
- If the user has selected a part, "this" and "it" mean that part.
- When done, answer in one or two short sentences: what you made or changed. Do not paste the script.`;
