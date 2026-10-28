# Convert the Onshape 3MF export into a GLB whose top-level nodes are the
# build steps used by the website's assembly animation. Instancing is kept:
# every unique part mesh is stored once and referenced by many nodes.
import sys, re, json, struct, math
from array import array
import xml.etree.ElementTree as ET

src, dst = sys.argv[1], sys.argv[2]
NS = '{http://schemas.microsoft.com/3dmanufacturing/core/2015/02}'
MNS = '{http://schemas.microsoft.com/3dmanufacturing/material/2015/02}'

SKIP = re.compile(r'screw|bolt|\bnut\b(?! cutout)|washer|bhcs|shcs|fhcs|rivet|e clip|94383a|91255a|97431a|standoff', re.I)

objs = {}
colors = []
for ev, el in ET.iterparse(src, events=('end',)):
    if el.tag == MNS + 'color':
        colors.append(el.get('color'))
    elif el.tag == NS + 'object':
        oid, name = el.get('id'), el.get('name') or ''
        mesh = el.find(NS + 'mesh')
        if mesh is not None:
            pos = array('f')
            for v in mesh.find(NS + 'vertices'):
                pos.append(float(v.get('x'))); pos.append(float(v.get('y'))); pos.append(float(v.get('z')))
            idx = array('I')
            for t in mesh.find(NS + 'triangles'):
                idx.append(int(t.get('v1'))); idx.append(int(t.get('v2'))); idx.append(int(t.get('v3')))
            objs[oid] = dict(name=name, pos=pos, idx=idx, color=int(el.get('pindex') or 0), comps=[])
        else:
            comps = [(c.get('objectid'), c.get('transform')) for c in el.iter(NS + 'component')]
            objs[oid] = dict(name=name, comps=comps)
        el.clear()
print('parsed', len(objs), 'objects,', len(colors), 'colors', file=sys.stderr)

def mat3mf(t):
    """3MF row-vector 4x3 transform -> glTF column-major 4x4 list."""
    if not t:
        return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    m = [float(x) for x in t.split()]
    return [m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0, m[9], m[10], m[11], 1]

def mul(a, b):  # column-major 4x4: a*b
    r = [0.0] * 16
    for c in range(4):
        for row in range(4):
            r[c * 4 + row] = sum(a[k * 4 + row] * b[c * 4 + k] for k in range(4))
    return r

def has_geometry(oid):
    o = objs[oid]
    if SKIP.search(o['name']):
        return False
    if 'pos' in o:
        return len(o['idx']) > 0
    return any(has_geometry(c) for c, _ in o['comps'])

# ---------- step grouping, from the CAD's own sub-assemblies ----------
ROOT = '2'
STEPS = ['Frame', 'Swerve modules', 'Electronics', 'Hopper', 'Indexer', 'Intake', 'Shooter', 'Bumpers']
FROM = {  # direction each step flies in from (glTF space, y up), in robot widths
    'Frame': [0, -0.35, 0], 'Swerve modules': [0, -0.4, 0], 'Electronics': [0, 0.7, 0],
    'Hopper': [0, 0.85, 0], 'Indexer': [0.8, 0.2, 0], 'Intake': [0, 0.2, -0.8],
    'Shooter': [0, 0.8, 0.3], 'Bumpers': [0, -0.1, 0],
}
groups = {s: [] for s in STEPS}   # step -> list of (objectid, accumulated matrix)

def name_of(oid):
    return objs[oid]['name']

for cid, t in objs[ROOT]['comps']:
    m = mat3mf(t)
    n = name_of(cid)
    if n.startswith('Chassis and Drivetrain'):
        for kid, kt in objs[cid]['comps']:
            km = mul(m, mat3mf(kt))
            kn = name_of(kid)
            groups['Swerve modules' if kn.startswith('SDS MK4i') or kn.startswith('Swerve Cover') else 'Frame'].append((kid, km))
    elif n.startswith('Hopper'):
        for kid, kt in objs[cid]['comps']:
            km = mul(m, mat3mf(kt))
            kn = name_of(kid)
            groups['Indexer' if kn.startswith('Bottom Indexer') or kn.startswith('Compliant Star Churro') else 'Hopper'].append((kid, km))
    elif n.startswith('electronics panel') or n.startswith('Robot Battery'):
        groups['Electronics'].append((cid, m))
    elif n.startswith('Intake'):
        groups['Intake'].append((cid, m))
    elif n.startswith('Bumpers'):
        groups['Bumpers'].append((cid, m))
    else:   # hood, gearboxes, camera mount and the loose drive parts around them
        groups['Shooter'].append((cid, m))

# ---------- glTF build ----------
bin_parts, buffer_views, accessors = [], [], []
offset = 0
def add_view(data, target):
    global offset
    b = data.tobytes()
    pad = (-len(b)) % 4
    bin_parts.append(b + b'\0' * pad)
    buffer_views.append({'buffer': 0, 'byteOffset': offset, 'byteLength': len(b), 'target': target})
    offset += len(b) + pad
    return len(buffer_views) - 1

def srgb_to_linear(c):
    c /= 255
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

materials, mat_index = [], {}
def material_for(ci):
    if ci in mat_index:
        return mat_index[ci]
    hexc = colors[ci] if ci < len(colors) else '#B3B3B3FF'
    r, g, b, a = (int(hexc[i:i + 2], 16) for i in (1, 3, 5, 7))
    lin = [srgb_to_linear(r), srgb_to_linear(g), srgb_to_linear(b)]
    gray = max(r, g, b) - min(r, g, b) < 18
    polycarb = b > 200 and r < 210 and b - r > 25           # the light-blue polycarbonate colors
    m = {'name': hexc, 'pbrMetallicRoughness': {'baseColorFactor': lin + [1.0]}}
    pbr = m['pbrMetallicRoughness']
    if polycarb:
        pbr.update(baseColorFactor=lin + [0.32], metallicFactor=0.0, roughnessFactor=0.1)
        m.update(alphaMode='BLEND', doubleSided=True, name='polycarb ' + hexc)
    elif gray and r > 150:
        pbr.update(metallicFactor=0.75, roughnessFactor=0.35)      # aluminum
    elif gray:
        pbr.update(metallicFactor=0.3, roughnessFactor=0.6)        # dark plastic / steel
    else:
        pbr.update(metallicFactor=0.0, roughnessFactor=0.55)       # colored plastic, wheels
    materials.append(m)
    mat_index[ci] = len(materials) - 1
    return mat_index[ci]

meshes, mesh_index = [], {}
def mesh_for(oid):
    if oid in mesh_index:
        return mesh_index[oid]
    o = objs[oid]
    pos = o['pos']
    xs, ys, zs = pos[0::3], pos[1::3], pos[2::3]
    pv = add_view(pos, 34962)
    accessors.append({'bufferView': pv, 'componentType': 5126, 'count': len(pos) // 3, 'type': 'VEC3',
                      'min': [min(xs), min(ys), min(zs)], 'max': [max(xs), max(ys), max(zs)]})
    pa = len(accessors) - 1
    iv = add_view(o['idx'], 34963)
    accessors.append({'bufferView': iv, 'componentType': 5125, 'count': len(o['idx']), 'type': 'SCALAR'})
    ia = len(accessors) - 1
    meshes.append({'name': o['name'], 'primitives': [{'attributes': {'POSITION': pa}, 'indices': ia, 'material': material_for(o['color'])}]})
    mesh_index[oid] = len(meshes) - 1
    return mesh_index[oid]

nodes = []
def node_for(oid, matrix):
    o = objs[oid]
    n = {'name': o['name']}
    if matrix != [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]:
        n['matrix'] = matrix
    if 'pos' in o:
        n['mesh'] = mesh_for(oid)
    else:
        kids = [node_for(c, mat3mf(t)) for c, t in o['comps'] if has_geometry(c)]
        if kids:
            n['children'] = kids
    nodes.append(n)
    return len(nodes) - 1

Q = math.sqrt(0.5)
top = []
for s in STEPS:
    kids = [node_for(oid, m) for oid, m in groups[s] if has_geometry(oid)]
    nodes.append({'name': s, 'rotation': [-Q, 0, 0, Q], 'children': kids, 'extras': {'step': s, 'from': FROM[s]}})
    top.append(len(nodes) - 1)
    print(f'{s:16} {len(kids):3} top-level parts', file=sys.stderr)

gltf = {'asset': {'version': '2.0', 'generator': 'team97 3mf->glb'}, 'scene': 0, 'scenes': [{'nodes': top}],
        'nodes': nodes, 'meshes': meshes, 'materials': materials, 'accessors': accessors,
        'bufferViews': buffer_views, 'buffers': [{'byteLength': offset}]}
js = json.dumps(gltf, separators=(',', ':')).encode()
js += b' ' * ((-len(js)) % 4)
binb = b''.join(bin_parts)
with open(dst, 'wb') as f:
    f.write(struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(binb)))
    f.write(struct.pack('<II', len(js), 0x4E4F534A)); f.write(js)
    f.write(struct.pack('<II', len(binb), 0x004E4942)); f.write(binb)
print('wrote', dst, len(meshes), 'meshes', len(nodes), 'nodes', len(materials), 'materials', file=sys.stderr)
