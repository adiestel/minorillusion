import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  assignD20Numbers,
  oppositeFaces,
  rotateVec,
  upFaceIndex,
  type Vec3,
} from "./dieFaces";

/** The 20 face directions of a unit icosahedron = each triangle's centroid,
 *  normalized (outward for a centered polyhedron). Same source the island uses. */
function icosaFaceNormals(): Vec3[] {
  const geo = new THREE.IcosahedronGeometry(1, 0); // non-indexed: 60 verts, 20 faces
  const pos = geo.attributes.position!;
  const normals: Vec3[] = [];
  for (let i = 0; i < pos.count; i += 3) {
    const cx = (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3;
    const cy = (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3;
    const cz = (pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3;
    const len = Math.hypot(cx, cy, cz) || 1;
    normals.push([cx / len, cy / len, cz / len]);
  }
  return normals;
}

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };

describe("rotateVec", () => {
  it("identity leaves a vector unchanged", () => {
    expect(rotateVec([1, 2, 3], IDENTITY)).toEqual([1, 2, 3]);
  });

  it("a 90° rotation about Z maps +X onto +Y", () => {
    // quaternion for +90° about Z: (0,0,sin45,cos45)
    const s = Math.SQRT1_2;
    const [x, y, z] = rotateVec([1, 0, 0], { x: 0, y: 0, z: s, w: s });
    expect(x).toBeCloseTo(0, 5);
    expect(y).toBeCloseTo(1, 5);
    expect(z).toBeCloseTo(0, 5);
  });
});

describe("upFaceIndex", () => {
  it("picks the face whose normal points most up under identity", () => {
    const normals: Vec3[] = [
      [0, -1, 0],
      [1, 0, 0],
      [0, 1, 0], // the up one
      [0, 0, 1],
    ];
    expect(upFaceIndex(normals, IDENTITY)).toBe(2);
  });

  it("rotation changes which face is up", () => {
    const normals: Vec3[] = [
      [1, 0, 0], // becomes +Y after +90° about Z
      [0, 1, 0],
    ];
    const s = Math.SQRT1_2;
    expect(upFaceIndex(normals, { x: 0, y: 0, z: s, w: s })).toBe(0);
  });

  it("returns -1 for no faces", () => {
    expect(upFaceIndex([], IDENTITY)).toBe(-1);
  });
});

describe("d20 numbering (real icosahedron)", () => {
  const normals = icosaFaceNormals();

  it("has 20 faces", () => {
    expect(normals).toHaveLength(20);
  });

  it("pairs every face with a distinct antipodal opposite", () => {
    const opp = oppositeFaces(normals);
    for (let i = 0; i < 20; i++) {
      expect(opp[i]).not.toBe(i);
      expect(opp[opp[i]!]).toBe(i); // opposite is symmetric
    }
  });

  it("assigns 1..20 exactly once, with opposite faces summing to 21", () => {
    const numbers = assignD20Numbers(normals);
    expect([...numbers].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
    const opp = oppositeFaces(normals);
    for (let i = 0; i < 20; i++) {
      expect(numbers[i]! + numbers[opp[i]!]!).toBe(21);
    }
  });

  it("a settled die reports a number in 1..20", () => {
    const numbers = assignD20Numbers(normals);
    const face = upFaceIndex(normals, IDENTITY);
    expect(numbers[face]).toBeGreaterThanOrEqual(1);
    expect(numbers[face]).toBeLessThanOrEqual(20);
  });
});
