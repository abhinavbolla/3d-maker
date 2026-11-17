# Opens Draftsman's STEP samples in FreeCAD and compares what FreeCAD reads
# with what test/step-samples.mjs says each file holds. FreeCAD is used here
# as an outside program to check our files against a real CAD kernel; it is
# not a dependency of Draftsman and none of its code is in this repository.
# Run by .github/workflows/step-freecad.yml:
#   STEP_DIR=out freecad.cmd test/freecad-check.py
import json
import os
import sys
import traceback

import FreeCAD
import Import
import Part

DIR = os.environ.get("STEP_DIR", "step-samples")
REL = 1e-4  # volumes, relative
MM = 1e-3  # bounding boxes, millimetres

failures = []


def check(ok, what):
    print(("ok   " if ok else "FAIL ") + what)
    if not ok:
        failures.append(what)


def close(a, b, rel=REL):
    return abs(a - b) <= rel * max(abs(a), abs(b), 1e-9)


def run():
    with open(os.path.join(DIR, "expected.json"), encoding="utf-8") as f:
        expected = json.load(f)
    print("FreeCAD " + ".".join(FreeCAD.Version()[:3]))
    for name in sorted(expected):
        want = expected[name]
        path = os.path.join(DIR, name)
        print("\n== " + name)

        # The geometry alone, as one shape.
        shape = Part.Shape()
        shape.read(path)
        solids = shape.Solids
        want_solids = sum(p["solids"] for p in want["parts"])
        check(len(solids) == want_solids, "%s: %d solids read, %d written" % (name, len(solids), want_solids))
        check(shape.isValid(), "%s: FreeCAD finds the shape valid" % name)
        check(all(s.isValid() and s.isClosed() for s in solids), "%s: every solid is valid and closed" % name)
        check(all(s.Volume > 0 for s in solids), "%s: every solid has its faces pointing outward (positive volume)" % name)
        total = sum(s.Volume for s in solids)
        want_total = sum(p["volume"] for p in want["parts"])
        check(close(total, want_total), "%s: volume %.3f mm3, our reader %.3f" % (name, total, want_total))
        if want.get("by_hand_volume"):
            check(close(total, want["by_hand_volume"]), "%s: volume %.3f mm3, by hand %.3f" % (name, total, want["by_hand_volume"]))
        lo = [min(p["bounds"][k] for p in want["parts"]) for k in range(3)]
        hi = [max(p["bounds"][k + 3] for p in want["parts"]) for k in range(3)]
        b = shape.BoundBox
        got = [b.XMin, b.YMin, b.ZMin, b.XMax, b.YMax, b.ZMax]
        # FreeCAD's box may be a little larger than a curved face; never smaller.
        slack = 1e-2 * max(hi[k] - lo[k] for k in range(3))
        check(
            all(got[k] <= lo[k] + MM and got[k] >= lo[k] - slack for k in range(3))
            and all(got[k + 3] >= hi[k] - MM and got[k + 3] <= hi[k] + slack for k in range(3)),
            "%s: bounding box %s, written %s" % (name, [round(v, 3) for v in got], [round(v, 3) for v in lo + hi]),
        )
        kinds = sorted(set(type(f.Surface).__name__ for f in shape.Faces))
        print("     surfaces as FreeCAD names them: " + ", ".join(kinds))
        if all(p["exact"] for p in want["parts"]):
            check("BSplineSurface" not in kinds, "%s: exact parts come in as planes, cylinders, cones, spheres and tori" % name)

        # The document: the assembly's parts with their names and volumes.
        doc = FreeCAD.newDocument("check")
        try:
            Import.insert(path, doc.Name)
            doc.recompute()
            leaves = [o for o in doc.Objects if o.isDerivedFrom("Part::Feature") and o.Shape.Solids]
            labels = [o.Label for o in leaves]
            print("     parts as FreeCAD names them: " + ", ".join(labels[:14]) + (" ..." if len(labels) > 14 else ""))
            for p in want["parts"]:
                match = [o for o in leaves if o.Label == p["name"]]
                check(len(match) == 1, "%s: part \"%s\" is in the document under its name" % (name, p["name"]))
                if len(match) == 1:
                    v = match[0].Shape.Volume
                    check(close(v, p["volume"]), "%s: \"%s\" volume %.3f mm3, our reader %.3f" % (name, p["name"], v, p["volume"]))

            # Round trip: FreeCAD writes the document as STEP and reads it back.
            back = os.path.join(DIR, "roundtrip-" + name)
            Import.export(leaves, back)
            again = Part.Shape()
            again.read(back)
            check(close(sum(s.Volume for s in again.Solids), total), "%s: the same volume after FreeCAD writes it out and reads it back" % name)
        finally:
            FreeCAD.closeDocument(doc.Name)


try:
    run()
except Exception:
    traceback.print_exc()
    failures.append("the check itself stopped with an error")

print("\nSTEP-FREECAD: " + ("PASS" if not failures else "FAIL (%d)" % len(failures)))
for f in failures:
    print("  " + f)
sys.stdout.flush()
os._exit(0 if not failures else 1)
