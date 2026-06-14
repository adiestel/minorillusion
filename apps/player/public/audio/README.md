# Bundled audio cues

The player resolves an `AudioCue` (from `@minorillusion/contract`) to
`/audio/<cue>.mp3` and plays it via `audio.play(...)` (see
`src/capabilities/audio.ts`). The M2 cue set is:

| File           | Used by                                                        |
| -------------- | -------------------------------------------------------------- |
| `thunder.mp3`  | `audio` effect (one-shot)                                      |
| `chime.mp3`    | `audio` effect (one-shot)                                      |
| `heartbeat.mp3`| `audio` effect (one-shot)                                      |
| `rain.mp3`     | `audio` effect, and the **storm** ambiance rain bed (looped)   |

Drop the real `.mp3` files here (filenames must match the cue ids exactly).
Until they exist, playback no-ops cleanly: a missing/undecodable file is caught
and the element is untracked, so nothing throws — there is just no sound. The
storm scene's visuals (vignette + lightning) still render without `rain.mp3`.

`rain.mp3` should be a seamless loop (it plays with `loop: true`, gain 0.6).
