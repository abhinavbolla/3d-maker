# Opens Draftsman's glTF (.glb), OBJ (with its MTL), PLY and STL samples in
# Blender, with Blender's own importers, and compares what Blender sees with
# what test/outside-samples.mjs says the kernel wrote. Blender is used here as
# an outside program to check our files; it is not a dependency of Draftsman
# and none of its code is in this repository.
# Run by .github/workflows/outside-programs.yml:
#   SAMPLE_DIR=out blender --background --factory-startup --python test/blender-check.py
import json
import math
import os
import sys
import traceback

import bmesh
import bpy

DIR = os.environ.get("SAMPLE_DIR", "outside-samples")
VOLUME = 5e-4  # relative, against the kernel's mesh
BY_HAND = 1e-2  # relative, against a volume worked out by hand
MM = 0.01  # bounds, millimetres

failures = []


def check(ok, what):
    print(("ok   " if ok else "FAIL ") + what)
    if not ok:
        failures.append(what)


def close(a, b, rel):
    return abs(a - b) <= rel * max(abs(a), abs(b), 1e-9)


def fmt(b):
    return "[" + ", ".join("%.2f" % v for v in b) + "]"


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_file(kind, path):
    v = bpy.app.version
    if kind == "glb":
        bpy.ops.import_scene.gltf(filepath=path)
    elif kind == "obj":
        bpy.ops.wm.obj_import(filepath=path)
    elif kind == "ply":
        bpy.ops.wm.ply_import(filepath=path)
    elif kind == "stl":
        if v >= (4, 1, 0):
            bpy.ops.wm.stl_import(filepath=path)
        else:
            bpy.ops.import_mesh.stl(filepath=path)


def mesh_objects():
    return [o for o in bpy.context.scene.objects if o.type == "MESH"]


def measure(obj, scale, world=True):
    """What Blender's mesh holds, in our millimetres: faces, edges by how many
    faces meet there once coincident vertices are merged, signed volume and
    bounds; and how its corner normals sit against its faces."""
    me = obj.data
    out = {"faces": len(me.polygons), "vertices": len(me.vertices)}
    # Corner normals (the file's own, where it has them) against the faces.
    if hasattr(me, "corner_normals"):
        corner = [c.vector for c in me.corner_normals]
    else:
        me.calc_normals_split()
        corner = [l.normal for l in me.loops]
    agree = total = 0
    for p in me.polygons:
        n = p.normal
        for li in p.loop_indices:
            total += 1
            if corner[li].dot(n) > 0:
                agree += 1
    out["normals_agree"] = agree / max(total, 1)
    out["custom_normals"] = bool(getattr(me, "has_custom_normals", False))
    bm = bmesh.new()
    bm.from_mesh(me)
    if world:
        bm.transform(obj.matrix_world)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6 / scale)
    bm.edges.ensure_lookup_table()
    one = two = more = odd = 0
    for e in bm.edges:
        n = len(e.link_faces)
        if n == 1:
            one += 1
        elif n == 2:
            two += 1
        else:
            more += 1
        if n % 2:
            odd += 1
    out.update(merged_faces=len(bm.faces), merged_vertices=len(bm.verts), one=one, two=two, more=more, odd=odd)
    out["volume"] = bm.calc_volume(signed=True) * scale**3
    lo = [min(v.co[k] for v in bm.verts) * scale for k in range(3)] if bm.verts else [0, 0, 0]
    hi = [max(v.co[k] for v in bm.verts) * scale for k in range(3)] if bm.verts else [0, 0, 0]
    out["bounds"] = lo + hi
    bm.free()
    return out


def principled(mat):
    if not mat or not mat.use_nodes:
        return None
    for n in mat.node_tree.nodes:
        if n.type == "BSDF_PRINCIPLED":
            return n
    return None


def value(node, *names):
    for name in names:
        if name in node.inputs:
            return node.inputs[name].default_value
    return None


def check_part(file, kind, got, want):
    name = want["name"]
    e = want["edges"]
    check(got["faces"] == want["triangles"], "%s: \"%s\" %d triangles, written %d" % (file, name, got["faces"], want["triangles"]))
    check(
        got["one"] == 0 and got["odd"] == 0 and got["more"] == e["more"],
        "%s: \"%s\" is closed: every edge has two faces (%d edges with one face, %d with more than two; written %d with more)" % (file, name, got["one"], got["more"], e["more"]),
    )
    check(got["merged_vertices"] == e["vertices"], "%s: \"%s\" %d vertices once merged, written %d" % (file, name, got["merged_vertices"], e["vertices"]))
    check(close(got["volume"], want["volume"], VOLUME), "%s: \"%s\" volume %.2f mm3, kernel %.2f" % (file, name, got["volume"], want["volume"]))
    check(got["volume"] > 0, "%s: \"%s\" faces point outward (positive volume)" % (file, name))
    off = max(abs(got["bounds"][k] - want["bounds"][k]) for k in range(6))
    check(off <= MM, "%s: \"%s\" bounds %s mm, kernel %s (worst %.4f mm)" % (file, name, fmt(got["bounds"]), fmt(want["bounds"]), off))
    if want.get("by_hand_volume"):
        check(close(got["volume"], want["by_hand_volume"], BY_HAND), "%s: \"%s\" volume %.2f mm3, by hand %.2f" % (file, name, got["volume"], want["by_hand_volume"]))
    if kind in ("glb", "obj"):
        check(got["normals_agree"] >= 0.99, "%s: \"%s\" corner normals agree with the faces (%.4f)" % (file, name, got["normals_agree"]))


def run_glb(name, want):
    file = name + ".glb"
    print("\n== " + file)
    reset()
    import_file("glb", os.path.join(DIR, file))
    objs = {o.name: o for o in mesh_objects()}
    parts = want["split"]
    check(len(objs) == len(parts), "%s: %d mesh objects, %d parts written" % (file, len(objs), len(parts)))
    missing = [p["name"] for p in parts if p["name"] not in objs]
    check(not missing, "%s: every part is an object under its name%s" % (file, (" (missing: " + ", ".join(missing[:5]) + ")") if missing else ""))
    moving = set((want.get("motion") or {}).get("moving", []))
    fps = bpy.context.scene.render.fps / bpy.context.scene.render.fps_base
    durations = []
    for p in parts:
        o = objs.get(p["name"])
        if not o:
            continue
        anim = o.animation_data.action if o.animation_data else None
        if p["name"] in moving:
            check(anim is not None, "%s: \"%s\" moves and has an action" % (file, p["name"]))
            if anim:
                s, e = anim.frame_range
                durations.append((e - s) / fps)
            # Its own mesh, at rest: the pose is the animation's, not the shape's.
            got = measure(o, 1000.0, world=False)
        else:
            check(anim is None, "%s: \"%s\" does not move and has no action" % (file, p["name"]))
            ident = all(abs(o.matrix_world[i][j] - (1 if i == j else 0)) < 1e-6 for i in range(4) for j in range(4))
            check(ident, "%s: \"%s\" sits at the origin, unturned (the axes are in its vertices)" % (file, p["name"]))
            got = measure(o, 1000.0)
        check_part(file, "glb", got, p)
        check(got["custom_normals"], "%s: \"%s\" keeps the file's normals" % (file, p["name"]))
        # The material: Principled BSDF, as Blender's importer makes it.
        mat = o.material_slots[0].material if o.material_slots else None
        bsdf = principled(mat)
        check(bsdf is not None, "%s: \"%s\" has a Principled BSDF material" % (file, p["name"]))
        if bsdf is None:
            continue
        check(mat.name == p["gltf_material"], "%s: \"%s\" material named \"%s\", written \"%s\"" % (file, p["name"], mat.name, p["gltf_material"]))
        base = list(value(bsdf, "Base Color"))
        metallic = value(bsdf, "Metallic")
        rough = value(bsdf, "Roughness")
        alpha = value(bsdf, "Alpha")
        ok = all(abs(base[k] - p["base_color"][k]) < 1e-4 for k in range(3)) and abs(metallic - p["metallic"]) < 1e-4 and abs(rough - p["roughness"]) < 1e-4 and abs(alpha - p["alpha"]) < 1e-4
        check(
            ok,
            "%s: \"%s\" (%s) base colour %s metallic %.2f roughness %.2f alpha %.2f; written %s %.2f %.2f %.2f"
            % (file, p["name"], p["look"], fmt(base[:3]), metallic, rough, alpha, fmt(p["base_color"][:3]), p["metallic"], p["roughness"], p["alpha"]),
        )
        if p["look"] == "paint":
            coat = value(bsdf, "Coat Weight", "Clearcoat")
            check(coat is not None and abs(coat - 0.55) < 1e-4, "%s: \"%s\" clear coat %s, written 0.55" % (file, p["name"], coat))
        if p["alpha"] < 1:
            mode = getattr(mat, "surface_render_method", None) or getattr(mat, "blend_method", None)
            check(mode in ("BLENDED", "BLEND"), "%s: \"%s\" is see-through (%s)" % (file, p["name"], mode))
    if moving:
        loop = want["motion"]["loop_seconds"]
        worst = max(abs(d - loop) for d in durations) if durations else float("inf")
        check(durations and worst < 1e-3, "%s: every action is %.3f s long, the loop %.3f s" % (file, durations[0] if durations else -1, loop))


def run_obj(name, want):
    file = name + ".obj"
    print("\n== " + file)
    reset()
    import_file("obj", os.path.join(DIR, file))
    objs = {o.name: o for o in mesh_objects()}
    parts = want["split"]
    check(len(objs) == len(parts), "%s: %d mesh objects, %d parts written" % (file, len(objs), len(parts)))
    missing = [p["name"] for p in parts if p["name"] not in objs]
    check(not missing, "%s: every part is an object under its name%s" % (file, (" (missing: " + ", ".join(missing[:5]) + ")") if missing else ""))
    for p in parts:
        o = objs.get(p["name"])
        if not o:
            continue
        check_part(file, "obj", measure(o, 1.0), p)
        mat = o.material_slots[0].material if o.material_slots else None
        bsdf = principled(mat)
        check(bsdf is not None and mat.name == p["mtl_name"], "%s: \"%s\" has material \"%s\" from the MTL" % (file, p["name"], mat.name if mat else None))
        if bsdf is None:
            continue
        base = list(value(bsdf, "Base Color"))
        metallic = value(bsdf, "Metallic")
        rough = value(bsdf, "Roughness")
        alpha = value(bsdf, "Alpha")
        ok = all(abs(base[k] - p["color_srgb"][k]) < 1e-4 for k in range(3)) and abs(metallic - p["metallic"]) < 1e-4 and abs(rough - p["roughness"]) < 1e-4 and abs(alpha - p["alpha"]) < 1e-4
        check(
            ok,
            "%s: \"%s\" (%s) Kd %s metallic %.2f roughness %.2f alpha %.2f; written %s %.2f %.2f %.2f"
            % (file, p["name"], p["look"], fmt(base[:3]), metallic, rough, alpha, fmt(p["color_srgb"]), p["metallic"], p["roughness"], p["alpha"]),
        )


def srgb_of(c):
    # Linear to sRGB, for a Blender without color_srgb.
    return [12.92 * v if v <= 0.0031308 else 1.055 * v ** (1 / 2.4) - 0.055 for v in c]


def run_whole(name, want, kind):
    """PLY and STL: every part in one mesh."""
    file = name + "." + kind
    print("\n== " + file)
    reset()
    import_file(kind, os.path.join(DIR, file))
    objs = mesh_objects()
    check(len(objs) == 1, "%s: %d mesh object(s)" % (file, len(objs)))
    if not objs:
        return
    o = objs[0]
    got = measure(o, 1.0)
    parts = want["plain"]
    tris = sum(p["triangles"] for p in parts)
    vol = sum(p["volume"] for p in parts)
    verts = sum(p["edges"]["vertices"] for p in parts)
    more = sum(p["edges"]["more"] for p in parts)
    lo = [min(p["bounds"][k] for p in parts) for k in range(3)]
    hi = [max(p["bounds"][k + 3] for p in parts) for k in range(3)]
    check(got["faces"] == tris, "%s: %d triangles, written %d" % (file, got["faces"], tris))
    # Parts of one file can share a corner position (the PLY keeps them
    # apart by index; merging joins them), so this is at most.
    check(got["merged_vertices"] <= verts, "%s: %d vertices once merged, written %d" % (file, got["merged_vertices"], verts))
    check(got["one"] == 0 and got["odd"] == 0, "%s: closed: every edge has an even number of faces (%d with one, %d with more than two; written %d with more within parts)" % (file, got["one"], got["more"], more))
    check(close(got["volume"], vol, VOLUME), "%s: volume %.2f mm3, kernel %.2f" % (file, got["volume"], vol))
    off = max(abs(got["bounds"][k] - (lo + hi)[k]) for k in range(6))
    check(off <= MM, "%s: bounds %s mm, kernel %s (worst %.4f mm)" % (file, fmt(got["bounds"]), fmt(lo + hi), off))
    if kind == "ply":
        attrs = o.data.color_attributes
        check(len(attrs) > 0, "%s: has vertex colours" % file)
        if len(attrs):
            a = attrs[0]
            seen = set()
            for d in a.data:
                c = list(d.color_srgb) if hasattr(d, "color_srgb") else srgb_of(list(d.color))
                seen.add(tuple(int(round(v * 255)) for v in c[:3]))
            want_c = set(tuple(int(round(v * 255)) for v in p["color_srgb"]) for p in parts)
            check(seen == want_c, "%s: colours %s, written %s" % (file, sorted(seen)[:6], sorted(want_c)[:6]))


def run():
    with open(os.path.join(DIR, "expected.json"), encoding="utf-8") as f:
        expected = json.load(f)["mesh"]
    print("Blender " + bpy.app.version_string)
    for name in expected:
        want = expected[name]
        for step in (lambda: run_glb(name, want), lambda: run_obj(name, want), lambda: run_whole(name, want, "ply"), lambda: run_whole(name, want, "stl")):
            try:
                step()
            except Exception:
                traceback.print_exc()
                failures.append("%s: the check stopped with an error" % name)


try:
    run()
except Exception:
    traceback.print_exc()
    failures.append("the check itself stopped with an error")

print("\nMESH-BLENDER: " + ("PASS" if not failures else "FAIL (%d)" % len(failures)))
for f in failures:
    print("  " + f)
sys.stdout.flush()
os._exit(0 if not failures else 1)
