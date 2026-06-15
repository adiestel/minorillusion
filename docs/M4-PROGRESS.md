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

### Commit 2 — Crystal ball (hero visual #1) — via the D13 screenshot loop
- [ ] A true-3D refracting sphere GL island that refracts what's behind it and
      glows/thrums with mic amplitude during PTT (the M3 crystal-ball, upgraded).
- [ ] Cheap fallback: the existing SVG ball (low-end / no-WebGL2 tier).
- [ ] Wire into `PlayerInput` behind `useGLEnabled`; review rendered frames.

### Commit 3 — 3D dice (hero visual #2 + physics) — via the screenshot loop
- [ ] Add a physics engine (decide: `@react-three/rapier`); a draggable/throwable
      die that tumbles + settles on a face. Cheap fallback: a 2D result.
- [ ] (Connects to M5's GM-called rolls; M4 owns the interaction/visual.)

## Verification log
- 2026-06-15 — M4 started. Confirmed R3F/three/drei already present + unused.
- 2026-06-15 — Commit 1 (GL foundation): `pnpm typecheck` 5/5; `pnpm test` 114 (contract 28 + server 74 + player 12); `pnpm build` 3/3. fidelity + budget + gate hook landed; vitest added to the player.
