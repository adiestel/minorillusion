# M4 — Showpiece GL islands — progress tracker

> Working doc for the M4 milestone (see `ROADMAP.md`). The first real WebGL work:
> crystal-ball refraction + 3D dice (drag/throw + physics), on the on-demand
> **GL-island** model (D7) with **fidelity tiering** + **budget guardrails** and a
> cheap fallback for every island. Hero visuals iterate via the **screenshot
> feedback loop** (D13 — the parchment GL island was rejected twice when built
> blind). Updated as each piece lands; folded into ROADMAP + DECISIONS when done.

## Definition of done (from ROADMAP)
Crystal-ball refraction; 3D dice (drag/throw + physics). Fidelity tiering + the
GL budget guardrails.

## Ground truth at M4 start
- `@react-three/fiber` (8.17), `@react-three/drei` (9.120), `three` (0.171) +
  `@types/three` are ALREADY in `apps/player` (leftover from the D12 parchment
  experiment) but **unused** (D13 removed the code) → clean slate, tree-shaken out.
- No physics engine yet — dice will add one (likely `@react-three/rapier`).
- Rendering rules to honor: D7 (cheap-first; GL only as transient islands; cap
  ~1–2 heavy; every island ships a cheap fallback = low-end tier; WebGL2
  baseline, WebGPU progressive), D13 (screenshot-review hero visuals; reserve 3D
  for genuinely-3D/interactive — the ball + dice qualify).

## Plan
### Commit 1 — GL foundation (headlessly verifiable) — ✓ DONE
- [x] **Fidelity tiering** (`gl/fidelity.ts`): WebGL2 detect + a pure `selectTier`
      (high/low/off) from capability signals (webgl2, cores, deviceMemory,
      reduced-motion, save-data). No-WebGL2/save-data → off; reduced-motion/≤4
      cores/≤2GB → low. Unit-tested (7).
- [x] **GL budget** (`gl/glBudget.ts`): a slot manager capping concurrent heavy
      islands (default 2); acquire on mount / release on unmount, idempotent per
      id; over-budget → fallback. Unit-tested (5).
- [x] **Gate hook** (`gl/useGLEnabled.ts`): tier≠off AND a free slot → render GL,
      else the cheap fallback (returns `{enabled, tier}` so islands damp at "low").
      Three-free, so the main bundle stays clean (islands are lazy-loaded).
- [x] **Test runner:** added `vitest` to `apps/player` (`test` script) — frontend
      logic is now covered (`pnpm test` runs contract+server+player = 114 tests).

### Commit 2 — Crystal ball (hero visual #1) — ⏸ DEFERRED ("keep the basic one for now")
- Built a true-3D refracting-glass island (MeshTransmissionMaterial: ember core +
  refracted wisp ring, amplitude thrum, tier damping) and iterated it via the D13
  screenshot loop (orange-planet+green-bug → dark scrying orb). The orb look
  didn't land for the user, so — exactly as D13 intends — it was reviewed BEFORE
  commit and **set aside**, never wired in. The app keeps the flat **SVG** crystal
  ball already shipped in `PlayerInput` (M3). The island + preview view were
  removed from the tree (nothing committed); revisit later if wanted.
- The **GL foundation stays** (committed `e9b909a`) — it's general infra the dice
  reuse.

### Commit 3 — 3D dice (hero visual #2) — ✓ DONE (via the screenshot loop)
- [x] **Pure dice math** (`gl/dice/dieFaces.ts` + test, 9 tests): rotate-vec,
      up-face-from-quaternion, antipodal pairing, and a d20 numbering where
      opposite faces sum to 21. GPU/physics-free, fully unit-tested.
- [x] **DiceIsland** (`gl/DiceIsland.tsx`): a d20 (icosahedron) that tumbles and
      settles **showing an authoritative result**. Design call (D6 — we own
      rolls): a physics sim would be biased + a poor system-of-record, so the
      number is chosen by RNG (server at M5) and a **scripted tumble** lands that
      face up via the tested math. No physics dep (tried `@react-three/rapier`,
      hit a ref-forwarding bug + it's the wrong model → removed). Tier-damped;
      cheap fallback = a flat number (consumer).
- [x] Reviewed via `preview.html?view=dice` (D13): clean ivory d20, ember edges,
      contact shadow, settles + reports the roll. **Wired into the app in M5**
      (GM-called rolls → the die shows the server's result).

## Verification log
- 2026-06-15 — M4 started. Confirmed R3F/three/drei already present + unused.
- 2026-06-15 — Commit 1 (GL foundation): `pnpm typecheck` 5/5; `pnpm test` 114 (contract 28 + server 74 + player 12); `pnpm build` 3/3. fidelity + budget + gate hook landed; vitest added to the player.
- 2026-06-15 — Crystal ball: built + iterated via the D13 screenshot loop, reviewed, set aside (look didn't land); island/preview removed, nothing committed. App keeps the SVG ball. Foundation retained for the dice.
- 2026-06-15 — Dice: pure face math (9 tests) + a scripted-tumble d20 island, reviewed via the screenshot loop (clean ivory d20, settles + reports the roll). Rapier tried + removed (ref bug + wrong model for an authoritative roll). `pnpm typecheck` 5/5; `pnpm test` 123 (contract 28 + server 74 + player 21); `pnpm build` 3/3. **M4 GL capability done** (crystal ball deferred); dice wires into the roll flow at M5.
