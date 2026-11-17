# Opens Draftsman's DXF samples with FreeCAD's own DXF importer and compares
# what FreeCAD reads with what test/outside-samples.mjs says the kernel wrote:
# entities by type and layer, the drawing's extents in mm, and a known
# circle's centre and radius. FreeCAD is used here as an outside program to
# check our files; it is not a dependency of Draftsman and none of its code
# is in this repository.
# Run by .github/workflows/outside-programs.yml:
#   SAMPLE_DIR=out freecad.cmd test/freecad-dxf-check.py
import json
import math
import os
import sys
import traceback

import FreeCAD
import Part

DIR = os.environ.get("SAMPLE_DIR", "outside-samples")
TOL = 1e-3  # mm

failures = []


def check(ok, what):
    print(("ok   " if ok else "FAIL ") + what)
    if not ok:
        failures.append(what)


# The importer's settings, as its preferences page sets them: every entity
# its own shape, grouped by layer, texts too, nothing joined.
DRAFT = "User parameter:BaseApp/Preferences/Mod/Draft"
p = FreeCAD.ParamGet(DRAFT)
p.SetBool("dxfUseLegacyImporter", False)
p.SetBool("dxfCreatePart", True)
p.SetBool("dxfCreateDraft", False)
p.SetBool("dxfCreateSketch", False)
p.SetBool("groupLayers", True)
p.SetBool("dxftext", True)
p.SetBool("dxflayout", False)
p.SetBool("joingeometry", False)
p.SetBool("dxfStdSize", False)
p.SetFloat("dxfScaling", 1.0)
p.SetBool("dxfShowDialog", False)
p.SetBool("dxfGetOriginalColors", True)
p.SetInt("DxfImportMode", 2)  # FreeCAD 1.1: individual shapes


def layer_of(obj, groups):
    for g, members in groups:
        if obj in members:
            return g
    return "?"


def import_dxf(path, doc):
    """FreeCAD's DXF importer, as File > Import runs it."""
    import importDXF

    importDXF.insert(path, doc.Name)
    doc.recompute()


def read(path):
    doc = FreeCAD.newDocument("dxf")
    errors = []
    try:
        import_dxf(path, doc)
    except Exception as e:
        errors.append("error: %s" % e)
    objs = list(doc.Objects)
    # Layers: groups (or Draft layers) and what is in them.
    groups = []
    for o in objs:
        members = getattr(o, "Group", None)
        if members is not None and not o.isDerivedFrom("Part::Feature"):
            name = o.Label
            if hasattr(o, "Proxy") and o.Proxy is not None and type(o.Proxy).__name__ == "Layer":
                name = o.Label
            groups.append((name, list(members)))
    out = {"objects": len(objs), "types": {}, "by_layer": {}, "circles": [], "texts": 0, "line_edges": 0, "edges_by_layer": {}, "errors": errors}
    lo = [math.inf, math.inf]
    hi = [-math.inf, -math.inf]
    for o in objs:
        t = o.TypeId
        out["types"][t] = out["types"].get(t, 0) + 1
        layer = layer_of(o, groups)
        if t in ("App::Annotation",) or hasattr(o, "Text") or hasattr(o, "LabelText"):
            out["texts"] += 1
            out["by_layer"].setdefault(layer, {}).setdefault("TEXT", 0)
            out["by_layer"][layer]["TEXT"] += 1
            continue
        if not o.isDerivedFrom("Part::Feature"):
            continue
        shape = o.Shape
        if shape.isNull():
            continue
        for e in shape.Edges:
            c = e.Curve
            if isinstance(c, Part.Circle):
                full = abs(abs(e.LastParameter - e.FirstParameter) - 2 * math.pi) < 1e-6
                if full:
                    out["circles"].append({"layer": layer, "cx": c.Center.x, "cy": c.Center.y, "r": c.Radius})
                    out["by_layer"].setdefault(layer, {}).setdefault("circle edges", 0)
                    out["by_layer"][layer]["circle edges"] += 1
                else:
                    out["by_layer"].setdefault(layer, {}).setdefault("arc edges", 0)
                    out["by_layer"][layer]["arc edges"] += 1
            elif isinstance(c, (Part.Line, Part.LineSegment)) or type(c).__name__ in ("Line", "LineSegment"):
                out["line_edges"] += 1
                out["edges_by_layer"][layer] = out["edges_by_layer"].get(layer, 0) + 1
            else:
                out["by_layer"].setdefault(layer, {}).setdefault(type(c).__name__ + " edges", 0)
                out["by_layer"][layer][type(c).__name__ + " edges"] += 1
            b = e.BoundBox
            lo = [min(lo[0], b.XMin), min(lo[1], b.YMin)]
            hi = [max(hi[0], b.XMax), max(hi[1], b.YMax)]
    out["box"] = lo + hi
    out["layers"] = sorted(g for g, _ in groups)
    FreeCAD.closeDocument(doc.Name)
    return out


def run():
    with open(os.path.join(DIR, "expected.json"), encoding="utf-8") as f:
        expected = json.load(f)["dxf"]
    print("FreeCAD " + ".".join(FreeCAD.Version()[:3]))
    for name in sorted(expected):
        want = expected[name]
        print("\n== " + name)
        got = read(os.path.join(DIR, name))
        print("     objects by type: " + json.dumps(got["types"], sort_keys=True))
        print("     groups: " + ", ".join(got["layers"]))
        print("     by layer: " + json.dumps(got["by_layer"], sort_keys=True))
        print("     straight edges by layer: " + json.dumps(got["edges_by_layer"], sort_keys=True))
        check(not got["errors"], "%s: opens without errors%s" % (name, (": " + "; ".join(got["errors"][:5])) if got["errors"] else ""))
        check(got["objects"] > 0, "%s: %d objects in the document" % (name, got["objects"]))
        n = want["counts"].get("CIRCLE", 0)
        check(len(got["circles"]) == n, "%s: %d circles, written %d" % (name, len(got["circles"]), n))
        check(got["line_edges"] == want["lineEdges"], "%s: %d straight edges (lines, polyline sides, filled triangles), written %d" % (name, got["line_edges"], want["lineEdges"]))
        if "TEXT" in want["counts"]:
            check(got["texts"] == want["counts"]["TEXT"], "%s: %d texts, written %d" % (name, got["texts"], want["counts"]["TEXT"]))
        for layer, edges in sorted(want["edgesByLayer"].items()):
            check(got["edges_by_layer"].get(layer, 0) == edges, "%s: layer %s has %d straight edges, written %d" % (name, layer, got["edges_by_layer"].get(layer, 0), edges))
        for layer, kinds in sorted(want["byLayer"].items()):
            c = kinds.get("CIRCLE", 0)
            if c:
                g = sum(1 for k in got["circles"] if k["layer"] == layer)
                check(g == c, "%s: layer %s has %d circles, written %d" % (name, layer, g, c))
        missing = [c for c in want["circles"] if not any(abs(k["cx"] - c["cx"]) < TOL and abs(k["cy"] - c["cy"]) < TOL and abs(k["r"] - c["r"]) < TOL for k in got["circles"])]
        check(not missing, "%s: every circle where it was written%s" % (name, (": missing " + json.dumps(missing[:3])) if missing else ""))
        k = want["known_circle"]
        found = [c for c in got["circles"] if abs(c["cx"] - k["cx"]) < TOL and abs(c["cy"] - k["cy"]) < TOL and abs(c["r"] - k["r"]) < TOL]
        check(bool(found), "%s: the circle at (%.3f, %.3f) r %.3f on %s is read at %s" % (name, k["cx"], k["cy"], k["r"], k["layer"], json.dumps(found[:1] or got["circles"][:2])))
        box = got["box"]
        off = max(abs(box[i] - want["box"][i]) for i in range(4))
        check(off < TOL, "%s: extents %s mm, written %s (worst %.4f mm)" % (name, ["%.3f" % v for v in box], want["box"], off))


try:
    run()
except Exception:
    traceback.print_exc()
    failures.append("the check itself stopped with an error")

print("\nDXF-FREECAD: " + ("PASS" if not failures else "FAIL (%d)" % len(failures)))
for f in failures:
    print("  " + f)
sys.stdout.flush()
os._exit(0 if not failures else 1)
