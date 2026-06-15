/**
 * Die-face math for the 3D dice island (M4) — pure + unit-tested, so the part
 * that decides "what did I roll" never depends on the GPU or physics. The island
 * (DiceIsland.tsx) hands us the die's local face normals (from the geometry) and
 * its settled orientation (a quaternion from the physics body); we return which
 * face points up and what number is printed on it.
 *
 * A d20 is an icosahedron: 20 triangular faces, each with an outward normal. After
 * the die settles, the up-face is the one whose (rotated) normal points most along
 * world-up. The printed number comes from a numbering where geometrically-opposite
 * faces sum to 21 (the standard d20 property) — we assign it deterministically
 * from the normals, since this is our own die model.
 */

/** A 3-component vector as a tuple (local face normal, etc.). */
export type Vec3 = readonly [number, number, number];

/** A quaternion (three.js order: x, y, z, w). */
export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** Rotate a vector by a quaternion (v' = v + 2w(q×v) + 2 q×(q×v)). */
export function rotateVec(v: Vec3, q: Quat): Vec3 {
  const { x: qx, y: qy, z: qz, w: qw } = q;
  const [vx, vy, vz] = v;
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  // v' = v + w*t + cross(q.xyz, t)
  return [
    vx + qw * tx + (qy * tz - qz * ty),
    vy + qw * ty + (qz * tx - qx * tz),
    vz + qw * tz + (qx * ty - qy * tx),
  ];
}

/**
 * Index of the face whose normal, rotated by `q`, points most along world-up
 * (+Y) — i.e. the face showing on top after the die settles. Returns -1 for an
 * empty normal set.
 */
export function upFaceIndex(localNormals: readonly Vec3[], q: Quat): number {
  let best = -1;
  let bestY = -Infinity;
  for (let i = 0; i < localNormals.length; i++) {
    const normal = localNormals[i];
    if (normal === undefined) continue;
    const y = rotateVec(normal, q)[1]; // only the up-component matters
    if (y > bestY) {
      bestY = y;
      best = i;
    }
  }
  return best;
}

/** For each face, the index of its geometric opposite (most antipodal normal). */
export function oppositeFaces(localNormals: readonly Vec3[]): number[] {
  const n = localNormals.length;
  const opposite = new Array<number>(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const a = localNormals[i]!;
    let best = -1;
    let bestDot = Infinity; // most negative dot = most antipodal
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const b = localNormals[j]!;
      const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      if (dot < bestDot) {
        bestDot = dot;
        best = j;
      }
    }
    opposite[i] = best;
  }
  return opposite;
}

/**
 * Assign d20 numbers (1..20) to faces so geometrically-opposite faces sum to 21
 * (the standard die property). Deterministic from the face normals: we pair
 * antipodal faces, then hand pairs the numbers (1,20), (2,19), … (10,11) in a
 * stable order. Returns `number[face]`. Requires an even face count with clean
 * antipodal pairs (an icosahedron's 20 faces qualify).
 */
export function assignD20Numbers(localNormals: readonly Vec3[]): number[] {
  const n = localNormals.length;
  const opposite = oppositeFaces(localNormals);
  const numbers = new Array<number>(n).fill(0);
  let next = 1;
  for (let i = 0; i < n; i++) {
    if (numbers[i] !== 0) continue; // already assigned via its pair
    const opp = opposite[i]!;
    numbers[i] = next;
    numbers[opp] = 21 - next; // opposite faces sum to 21
    next++;
  }
  return numbers;
}
