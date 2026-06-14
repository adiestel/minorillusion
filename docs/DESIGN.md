# Design Language & Rendering

## Core principle: diegetic & skeuomorphic (inviolable)

The player's immersive views are **skeuomorphic and diegetic — no floating UI text, labels, or app-chrome.** Information is conveyed through in-world objects and effects, not captions. The resting state is *only* the breathing ember on near-black; a player's name, presence rosters, and status text do **not** belong on the immersive canvas. If presence must be shown to players at all, it is rendered diegetically (e.g. small flames ringing the central fire), never as text. Plain text and controls live only on explicit menu/liminal surfaces (the join/code-entry screen, settings). Treat this as inviolable as the safety rules. *(Established at the M1 design review — the first parchment build violated it with on-screen name/roster text.)*

## Theme: the circle around the fire
The organizing metaphor is a campfire circle, and it maps onto every system concept:
- **Join** = enter the circle (tap the hearth).
- **Session live** = the fire is lit.
- **Session end** = the fire dies / the circle breaks (players disconnect; mics stop).

### The hearth device
The GM may run the app in a "hearth" mode on a phone at the center of the table. It is simultaneously: the crackling bonfire visual, the **tap-to-join point**, and an additional **output target**. (It falls out of the actor/target model for free — a player-class device in the hearth role.)

### Join ritual & transports
The *ritual* is: tap your phone to the hearth → a haptic "glow and thrum" → you're in the circle. The *transport* underneath is chosen for reliability, not NFC dogma:
- **6-digit code + QR** — universal, always available.
- **BLE proximity** — backs the "tap" gesture on any device pairing.
- **NFC** — only when the hearth is an Android device (HCE); iOS cannot be the tapped target. Never hard-depend on NFC.

### Resting state
After joining, the screen goes near-black with a **breathing ember** (a faint pulsing glow). Pure black reads as "off/broken"; the ember signals "alive, waiting," and true-black OLED + one ember is battery-friendly. The phone is meant to lie face-up on the table.

## Parchment text (the Marauder's Map / Riddle's Diary look)
All text appears as ink on weathered parchment that writes itself in and fades. This is a single reusable primitive used everywhere (GM messages, quill compose, logs, summaries).

Build ladder:
- **Everyday text (cheap, ~90% of the feel):** handwriting font + left-to-right ink-reveal mask + slight bleed, on a parchment texture, with an unfurl.
- **Hero text (premium):** true stroke-by-stroke cursive via SVG-stroke paths. Reserve for named moments.

Dismissal vocabulary (this is how the acknowledge/auto-dismiss/silent modes look):
- **Acknowledge** → the parchment catches fire and curls to ash when touched.
- **Auto-dismiss** → it refolds and fades on its own.
- **Silent** → no parchment; a faint ember-glow at the screen edge.

## Input grammar
Tap the black screen → two sigils bloom from the touch point: the **quill** (text) and the **crystal ball** (voice).

**The sigil/wax-seal is the universal "who" token** — the same iconography for choosing a recipient everywhere.

- **Quill (text):** tap → the page turns up; the current recipient rides at the bottom as a **wax seal**; tap the seal to change recipient (a satisfying haptic "stamp"). The OS keyboard handles typing.
- **Crystal ball (voice):** tap to open → swipe through the contact sigils to aim → **press-and-hold to talk** (PTT), release to send. With only the GM as contact (the default), it collapses to just hold-to-talk — no aim step. The ball is the one true-3D element: it refracts the live effect playing behind it and glows/thrums with the speaker's voice (mic amplitude).
- Multi-contact selection only appears when the GM has configured extra channels; otherwise everything defaults to "talk to the GM."
- **PTT feedback:** while holding, the rest of the screen blurs, glows, and thrums with the voice.

## Effect vocabulary (examples; the engine is general)
The engine is one mechanism (actor → router → target). An **EffectSpec** + a **Target** [+ a `startDelayMs`] is fired with `effect:send`; a choreographed **cue** (`effect:cue`) is a bundle of specs at one target, each with its own offset, scheduled locally by each device so a moment lands in time across the set. New effects are new spec kinds, not new plumbing.

**Implemented (M2 — the cheap-path core):**
- **message** — the parchment (M1).
- **audio** — a bundled SFX cue (`thunder`/`chime`/`heartbeat`/`rain`) or **TTS** (text → inline `data:` audio via the ElevenLabs adapter). A loop (e.g. `rain`) is *sustained*; a one-shot is *transient*. Unlocked on the consent/join tap.
- **haptic** — named patterns (`buzz`/`double`/`rumble`/`heartbeat`/`success`); web `navigator.vibrate` + a `@capacitor/haptics` native seam.
- **ambiance** — a persistent scene: `clear` (resting ember), **`storm`** (cold vignette + faint rain streaks + a rain audio bed), `ember` (stirred warm glow). Cheap CSS, not video.
- **flash** — a brief, photosensitivity-safe full-screen light wash (the storm's lightning; also reusable for spell/camera flashes).
- **heartbeat** — a red edge-vignette pulse + haptic train, `bpm`×`beats`.
- **Storm = server-driven** (D15): the `storm` ambiance + a server runner that fires synced strikes — a room-wide **flash** + a **thunderclap on one random player's phone** (thunder from one corner of the table). The client no longer self-times lightning.

**GM control model (D15):** effects are **sustained** (loops/ambiance/storm — run until stopped) or **transient** (one-shots with a countdown). The soundboard is split into **Loops** vs **One-shots**; an **Active Effects** panel shows what's running and *for whom*, with a Stop on sustained rows and a live countdown on transient ones (server-tracked registry → `effects:active`; `effect:stop` → `effect:end`). **Consent-at-join** discloses what the GM can do (sound/vibration/screen) and that mic/camera are never silent.

**Still aspirational (later milestones), all the same engine:**
- **Atmospheric / broadcast:** staggered lightning across phones, darkness+silence (then one torch as the party's only light), surround soundscape (phones as a distributed speaker array), spatial whispers (voice hops device-to-device), tremor.
- **Personal / targeted:** the secret note (one player only), affliction (that player's screen subtly corrupts), scrying (a private vision).
- **Hardware-as-mechanic:** steady-hand (hold the phone still via gyro), diviner's compass (sweep the room via gyro), the doom clock (shared countdown).

## Rendering strategy
**Default to the cheap path; escalate to WebGL only when an effect earns it.**

- **Cheap path (default):** DOM/CSS (`transform`/`opacity`, SVG stroke for ink) + pre-rendered media (hardware-decoded `<video>` loops, sprite sheets) + good static art. Idles for free; most "quality" is art + hardware video decode, not real-time compute.
- **WebGL island (escalate) only if the effect:** (1) must refract/distort what's behind it (the ball), (2) is interactive/physics-driven (the dice), (3) must react continuously to live input (mic/gyro) beyond what a loop fakes, or (4) needs non-repeating variation a visible loop would betray.
- **Guardrails:** GL islands are transient (mount on demand, unmount when idle); cap ~1–2 heavy ones at a time. **Every effect ships its cheap version** (which doubles as the low-end-device tier). WebGL2 baseline, WebGPU as progressive enhancement. CSS isn't free either — pre-bake blurs; avoid animating large-area `backdrop-filter`/shadows.

Decision rule: *if it doesn't need to react in real time or refract what's behind it, pre-render it. Spend the GPU only on interactivity, reactivity, and compositing.*

## Accessibility
The all-black, gesture-driven, handwriting, audio-cued aesthetic is beautiful but an accessibility risk. Hold in tension: critical info (a message that needs a response) must always have a non-audio, legible path; keep an optional reduced-effects / higher-contrast mode. Build native-first and let the experience degrade — never design to the lowest common denominator.
