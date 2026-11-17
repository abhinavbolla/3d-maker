// OBJ export: one object per part, with vertex normals, in millimetres with
// Y up (the convention OBJ readers expect: a point (x, y, z) here is
// (x, z, -y) there), and its materials in a separate MTL file. The OBJ names
// its MTL file on a line of its own, mtllib, which whoever writes the files
// puts first (see objWithMtl), because only they know the file's name.
import { LOOKS, lookOf, srgb } from "./gltf.js";

const num = (v) => String(Math.round(v * 1e4) / 1e4);
const nrm = (v) => String(Math.round(v * 1e5) / 1e5);
// Names on one line, without the characters OBJ readers split on.
const oneLine = (s) => String(s).replace(/[\r\n]+/g, " ").trim() || "part";
export const materialName = (s, i) => `m${i + 1}_${String(s).replace(/[^\w-]+/g, "_").replace(/^_+|_+$/g, "")}`;

// parts: [{ name, color, material, positions, normals, indices }].
// Returns { obj, mtl } as text; obj has no mtllib line yet.
export function toOBJ(parts, { title = "" } = {}) {
  const out = ["# Draftsman", title ? `# ${oneLine(title)}` : null, "# Units: millimetres. Y is up."].filter(Boolean);
  out.push("");
  const mtl = ["# Draftsman materials", ""];
  let base = 1;
  parts.forEach((p, i) => {
    const P = p.positions, N = p.normals, I = p.indices;
    const m = materialName(p.name, i);
    out.push(`o ${oneLine(p.name)}`, `usemtl ${m}`);
    const lines = [];
    for (let v = 0; v < P.length; v += 3) lines.push(`v ${num(P[v])} ${num(P[v + 2])} ${num(-P[v + 1])}`);
    if (N) for (let v = 0; v < N.length; v += 3) lines.push(`vn ${nrm(N[v])} ${nrm(N[v + 2])} ${nrm(-N[v + 1])}`);
    for (let t = 0; t < I.length; t += 3) {
      const [a, b, c] = [I[t] + base, I[t + 1] + base, I[t + 2] + base];
      lines.push(N ? `f ${a}//${a} ${b}//${b} ${c}//${c}` : `f ${a} ${b} ${c}`);
    }
    out.push(lines.join("\n"));
    base += P.length / 3;

    const look = lookOf(p);
    const L = LOOKS[look];
    const [r, g, b] = srgb(p.color).map((c) => c.toFixed(4));
    // Kd is the colour; Pr and Pm are roughness and metalness (the PBR
    // extension to MTL that Blender and others read); Ns and Ks are the same
    // look for readers that only know the old shading model.
    const spec = L.metallic > 0.5 ? `${r} ${g} ${b}` : "0.5000 0.5000 0.5000";
    mtl.push(`newmtl ${m}`, `# ${oneLine(p.name)}, ${look}`, "Ka 0.0000 0.0000 0.0000", `Kd ${r} ${g} ${b}`, `Ks ${spec}`, `Ns ${Math.round(1000 * (1 - L.roughness) ** 2)}`, `Pr ${L.roughness}`, `Pm ${L.metallic}`);
    if (L.alpha !== undefined) mtl.push(`d ${L.alpha}`, `Tr ${Math.round((1 - L.alpha) * 100) / 100}`);
    mtl.push("illum 2", "");
  });
  out.push("");
  return { obj: out.join("\n"), mtl: mtl.join("\n") };
}

// A file name that is safe on the mtllib line ("Rotor head.obj" -> "Rotor-head.mtl").
export const mtlFileName = (objName) => `${String(objName).replace(/\.obj$/i, "").replace(/^.*[\\/]/, "").replace(/[^\w.-]+/g, "-") || "model"}.mtl`;
// The OBJ with its mtllib line first.
export const objWithMtl = (obj, mtlName) => `mtllib ${mtlName}\n${obj}`;
