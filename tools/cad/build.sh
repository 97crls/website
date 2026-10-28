#!/bin/sh
# Rebuild assets/cad/robot.glb from an Onshape 3MF export.
#   sh tools/cad/build.sh "~/Downloads/Full Robot.3mf"
# Needs python3 and node. Steps: 3MF -> GLB grouped into build steps (to_glb.py),
# weld + simplify, per-part triangle budget (budget.mjs), then meshopt compression.
set -e
SRC="$1"
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
unzip -q -o "$SRC" -d "$WORK/x"
python3 -I "$HERE/to_glb.py" "$WORK/x/3D/3dmodel.model" "$WORK/raw.glb"
cd "$WORK"
npm init -y >/dev/null
npm i @gltf-transform/cli@4.1.1 >/dev/null 2>&1
npx gltf-transform weld raw.glb w.glb
npx gltf-transform simplify w.glb s.glb --ratio 0.04 --error 0.0015
cp "$HERE/budget.mjs" . && node budget.mjs s.glb b.glb
npx gltf-transform meshopt b.glb "$HERE/../../assets/cad/robot.glb"
rm -rf "$WORK"
