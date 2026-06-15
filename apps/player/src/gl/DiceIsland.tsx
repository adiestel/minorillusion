/**
 * DiceIsland — the 3D dice as a GL island (M4: "3D dice — throw + tumble").
 *
 * Design note (D6 — we own rolls): the die VISUALIZES an authoritative result, it
 * doesn't derive one. A physics sim would be both biased (cocked dice, uneven
 * settling) and a poor system-of-record, so instead the roll number is chosen by
 * a uniform RNG (or, at M5, by the server) and the die does a scripted tumble that
 * settles showing exactly that face. We reuse the pure, unit-tested face math
 * (dice/dieFaces) to compute the orientation that lands the chosen face up. This
 * removes the physics dependency and makes the result deterministic + fair.
 *
 * Lazy-loaded behind `useGLEnabled`; the cheap fallback (a flat rolled number) is
 * the consumer's job. Default export so it code-splits via React.lazy. Tier
 * damping: at "low" we drop antialiasing + the contact shadow + the pixel ratio.
 */
import { Canvas, useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, type CSSProperties } from "react";
import * as THREE from "three";
import { upFaceIndex, assignD20Numbers, type Vec3 } from "./dice/dieFaces";
import type { FidelityTier } from "./fidelity";

const UP = new THREE.Vector3(0, 1, 0);
const TUMBLE_MS = 1300;
const easeOutCubic = (p: number) => 1 - Math.pow(1 - p, 3);
const randD20 = () => Math.floor(Math.random() * 20) + 1;

/** The d20 geometry + per-face outward normals (THREE) + numbering (once). */
function useD20() {
  return useMemo(() => {
    const geo = new THREE.IcosahedronGeometry(1, 0); // non-indexed, 20 faces
    const pos = geo.attributes.position!;
    const tuples: Vec3[] = [];
    const vecs: THREE.Vector3[] = [];
    for (let i = 0; i < pos.count; i += 3) {
      const c = new THREE.Vector3(
        (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3,
        (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3,
        (pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3,
      ).normalize();
      vecs.push(c);
      tuples.push([c.x, c.y, c.z]);
    }
    return { geo, vecs, tuples, numbers: assignD20Numbers(tuples) };
  }, []);
}

interface DieProps {
  rollKey: number;
  result?: number;
  onSettled?: (n: number) => void;
}

/** The tumbling die group: on each rollKey, tumbles + settles showing `result`. */
function Die({ rollKey, result, onSettled }: DieProps) {
  const group = useRef<THREE.Group>(null);
  const { geo, vecs, numbers } = useD20();

  // Per-roll animation state (refs so the frame loop reads them without re-render).
  const start = useRef(new THREE.Quaternion());
  const target = useRef(new THREE.Quaternion());
  const spinAxis = useRef(new THREE.Vector3(0, 1, 0));
  const spins = useRef(4);
  const t0 = useRef(0);
  const settled = useRef(false);
  const elapsed = useRef(0);
  const rolled = useRef(1);

  useEffect(() => {
    const target20 = result ?? randD20();
    rolled.current = Math.min(20, Math.max(1, Math.round(target20)));
    // Find the face printed with this number and the rotation bringing it up.
    const faceIndex = numbers.indexOf(rolled.current);
    const normal = vecs[faceIndex] ?? UP;
    const settle = new THREE.Quaternion().setFromUnitVectors(normal, UP);
    // A random yaw about up so the die doesn't always face the same way.
    const yaw = new THREE.Quaternion().setFromAxisAngle(UP, Math.random() * Math.PI * 2);
    target.current.copy(yaw).multiply(settle);
    // A random start orientation + tumble axis + a few spins for the toss.
    start.current.random();
    spinAxis.current.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
    spins.current = 3 + Math.floor(Math.random() * 3);
    t0.current = 0;
    elapsed.current = 0;
    settled.current = false;
  }, [rollKey, result, numbers, vecs]);

  useFrame((state, delta) => {
    const g = group.current;
    if (!g || settled.current) return;
    if (t0.current === 0) t0.current = state.clock.elapsedTime;
    elapsed.current += delta;
    const p = Math.min(1, elapsed.current / (TUMBLE_MS / 1000));
    const e = easeOutCubic(p);
    // Slerp toward the settle orientation, with a decaying tumble layered on so
    // the die spins fast at first and unwinds exactly onto the target face.
    const q = start.current.clone().slerp(target.current, e);
    const spinAngle = spins.current * Math.PI * 2 * (1 - e);
    q.premultiply(new THREE.Quaternion().setFromAxisAngle(spinAxis.current, spinAngle));
    g.quaternion.copy(q);
    // Drop in and settle onto the tray.
    g.position.y = 1.7 * Math.pow(1 - e, 1.4);
    if (p >= 1) {
      settled.current = true;
      g.quaternion.copy(target.current);
      g.position.y = 0;
      // Sanity: the face we render up should match what we rolled (tested math).
      const shownFace = upFaceIndex(
        vecs.map((v) => [v.x, v.y, v.z] as Vec3),
        target.current,
      );
      onSettled?.(numbers[shownFace] ?? rolled.current);
    }
  });

  return (
    <group ref={group}>
      <mesh geometry={geo} castShadow>
        <meshStandardMaterial color="#e6dcc2" metalness={0.15} roughness={0.5} flatShading />
      </mesh>
      {/* ember edges so the facets read crisply */}
      <lineSegments>
        <edgesGeometry args={[geo]} />
        <lineBasicMaterial color="#c2410c" transparent opacity={0.9} />
      </lineSegments>
    </group>
  );
}

export interface DiceIslandProps {
  /** Change this to throw again (each new value re-rolls). */
  rollKey: number;
  /** The number to land on; omitted → a uniform random d20 (preview/standalone). */
  result?: number;
  /** Called with the shown number once the die settles. */
  onSettled?: (n: number) => void;
  tier?: FidelityTier;
  style?: CSSProperties;
}

export default function DiceIsland({
  rollKey,
  result,
  onSettled,
  tier = "high",
  style,
}: DiceIslandProps) {
  const low = tier === "low";
  return (
    <Canvas
      style={style}
      shadows={!low}
      dpr={low ? 1 : [1, 2]}
      gl={{ antialias: !low, alpha: true }}
      camera={{ position: [0, 4.5, 5], fov: 42 }}
    >
      <ambientLight intensity={0.7} />
      <directionalLight position={[3, 8, 4]} intensity={2.6} color="#fff1dc" castShadow={!low} />
      <pointLight position={[-3, 2, 3]} intensity={16} color="#ff7a3c" />
      {/* the tray floor — a dark disc the die settles onto */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -1, 0]} receiveShadow>
        <circleGeometry args={[5, 48]} />
        <meshStandardMaterial color="#0c0a08" roughness={0.95} />
      </mesh>
      <Die rollKey={rollKey} result={result} onSettled={onSettled} />
    </Canvas>
  );
}
