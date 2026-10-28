// Per-mesh triangle budget: parts used many times get simplified harder.
import { NodeIO } from "@gltf-transform/core";
import { prune, dedup } from "@gltf-transform/functions";
import { MeshoptSimplifier } from "meshoptimizer";

const [src, dst] = process.argv.slice(2);
const TOTAL = 420000;          // rendered triangle budget for the whole robot
await MeshoptSimplifier.ready;
const io = new NodeIO();
const doc = await io.read(src);
const root = doc.getRoot();

const uses = new Map();
for (const node of root.listNodes()) {
  const m = node.getMesh();
  if (m) uses.set(m, (uses.get(m) || 0) + 1);
}
const triCount = (p) => p.getIndices().getCount() / 3;
let rendered = 0;
for (const [m, n] of uses) for (const p of m.listPrimitives()) rendered += triCount(p) * n;
const scale = Math.min(1, TOTAL / rendered);
console.log("rendered before", Math.round(rendered), "scale", scale.toFixed(3));

let after = 0;
for (const [m, n] of uses) {
  for (const p of m.listPrimitives()) {
    const tris = triCount(p);
    // every mesh keeps at least ~300 triangles so small parts don't collapse
    // and parts repeated many times share a fixed budget across all their copies
    const target = Math.max(300, Math.min(Math.floor(tris * scale), Math.floor(45000 / n)));
    if (target >= tris) { after += tris * n; continue; }
    const pos = p.getAttribute("POSITION").getArray();
    const idx = new Uint32Array(p.getIndices().getArray());
    const [out] = MeshoptSimplifier.simplify(idx, pos, 3, target * 3, 0.05, []);
    p.getIndices().setArray(new Uint32Array(out));
    after += (out.length / 3) * n;
  }
}
console.log("rendered after", Math.round(after));
await doc.transform(prune(), dedup());
await io.write(dst, doc);
