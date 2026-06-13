# Design Language & Rendering

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
- **Atmospheric / broadcast:** thunderstorm (staggered lightning across phones), heartbeat (synced haptic + red breath), darkness+silence (then one torch as the party's only light), surround soundscape (phones as a distributed speaker array), spatial whispers (voice hops device-to-device), tremor.
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
