/**
 * Generate sound-effect clips with the ElevenLabs sound-generation API and save
 * them as mp3. Reads ELEVENLABS_API_KEY from .env.local (value is used, never
 * printed).
 *
 * Full set:  node scripts/gen-assets/elevenlabs-sfx.mjs
 *              → regenerates the whole canonical cue set into apps/player/public/audio:
 *                chime, heartbeat (a single lub-dub thump), rain (a seamless 30s
 *                loop), and thunder1..thunder5 (variations picked at random in play).
 * One-off:   node scripts/gen-assets/elevenlabs-sfx.mjs "<prompt>" <out.mp3> [seconds] [loop]
 *
 * The `loop` token enables ElevenLabs loop mode (model eleven_text_to_sound_v2):
 * a seamlessly looping clip — use it for ambience beds (rain) and pair with
 * seconds=30. Seamless decode-time looping + the player's Web Audio buffer loop
 * means no gap between repeats.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

function loadKey(name) {
  const env = readFileSync(new URL("../../.env.local", import.meta.url), "utf8");
  const line = env.split(/\r?\n/).find((l) => l.startsWith(`${name}=`));
  if (!line) throw new Error(`${name} not found in .env.local`);
  return line.slice(name.length + 1).trim();
}

const AUDIO_DIR = new URL("../../apps/player/public/audio/", import.meta.url);

/** Single-file cues. heartbeat is ONE lub-dub (played per beat); rain loops. */
const CUES = [
  {
    out: "chime.mp3",
    seconds: 4,
    prompt:
      "A soft, clear magical bell chime — a single gentle ring with a long shimmering crystalline tail. Warm, fantasy, no music.",
  },
  {
    out: "heartbeat.mp3",
    seconds: 1,
    prompt:
      "A single deep muffled human heartbeat — one soft lub-dub thump felt close inside the chest, intimate and visceral, then silence. Isolated one-shot, no music, no echo, no reverb tail.",
  },
  {
    out: "rain.mp3",
    seconds: 30,
    loop: true,
    promptInfluence: 0.3,
    prompt:
      "Soft gentle rainfall heard from a sheltered doorway — a calm, even, distant patter, light and soothing, sitting low and unobtrusive in the background. Seamless continuous loop, quiet and steady, no thunder, no wind gusts, no music, no sudden changes.",
  },
];

/** Thunderclap variations — the player picks one at random per strike for variety. */
const THUNDER_VARIANTS = [
  "A sharp, close thunderclap — a sudden cracking boom with a short tight tail. Cinematic, dramatic, no music, no rain.",
  "A powerful rolling thunderclap — a deep low rumble that builds then rolls off slowly into the distance. Cinematic, no music, no rain.",
  "A distant thunderclap — a muffled low boom far away, soft and ominous with a long reverb. Cinematic, no music, no rain.",
  "A natural rolling thunderclap — a deep resonant rumble that swells then rolls away across the sky, weighty and organic, soft-edged. Realistic storm thunder, no explosion, no sharp boom, no music, no rain.",
  "A long peal of distant thunder — a low grumbling rumble that tumbles and fades slowly into the distance, gentle and natural. Realistic faraway storm, no sharp crack, no explosion, no music, no rain.",
];

async function generate(key, prompt, { seconds, loop, promptInfluence } = {}) {
  const body = { text: prompt, prompt_influence: promptInfluence ?? 0.4 };
  if (seconds) body.duration_seconds = seconds;
  if (loop) body.loop = true; // ElevenLabs seamless-loop mode (eleven_text_to_sound_v2)
  const res = await fetch(
    "https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128",
    {
      method: "POST",
      headers: {
        "xi-api-key": key,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

const key = loadKey("ELEVENLABS_API_KEY");

const [, , argPrompt, argOut, argSecs] = process.argv;
const argLoop = process.argv.slice(2).some((a) => a === "loop" || a === "--loop");

if (argPrompt && argOut) {
  const seconds = argSecs && argSecs !== "loop" ? Number(argSecs) : undefined;
  const buf = await generate(key, argPrompt, { seconds, loop: argLoop });
  mkdirSync(dirname(argOut), { recursive: true });
  writeFileSync(argOut, buf);
  console.log("wrote", argOut, `(${(buf.length / 1024).toFixed(0)} KB)`);
} else {
  mkdirSync(AUDIO_DIR, { recursive: true });
  for (const cue of CUES) {
    const buf = await generate(key, cue.prompt, {
      seconds: cue.seconds,
      loop: cue.loop,
      promptInfluence: cue.promptInfluence,
    });
    writeFileSync(new URL(cue.out, AUDIO_DIR), buf);
    console.log("wrote", cue.out, `(${(buf.length / 1024).toFixed(0)} KB)`);
  }
  for (let i = 0; i < THUNDER_VARIANTS.length; i++) {
    const out = `thunder${i + 1}.mp3`;
    const buf = await generate(key, THUNDER_VARIANTS[i], { seconds: 5 });
    writeFileSync(new URL(out, AUDIO_DIR), buf);
    console.log("wrote", out, `(${(buf.length / 1024).toFixed(0)} KB)`);
  }
  console.log("done — full cue set generated");
}
