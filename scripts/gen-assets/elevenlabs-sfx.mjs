/**
 * Generate sound-effect clips with the ElevenLabs sound-generation API and save
 * them as mp3. Reads ELEVENLABS_API_KEY from .env.local (value is used, never
 * printed).
 *
 * One-off:   node scripts/gen-assets/elevenlabs-sfx.mjs "<prompt>" <out.mp3> [seconds]
 * M2 set:    node scripts/gen-assets/elevenlabs-sfx.mjs            (no args → the cues below)
 *
 * The M2 cue set lands in apps/player/public/audio/<cue>.mp3 — bundled, committed
 * assets that the player's cheap-path audio resolves by name (see contract `audioCue`).
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

/** The M2 cheap-path cue set. duration is a hint to the model (seconds). */
const M2_SET = [
  {
    out: "thunder.mp3",
    seconds: 5,
    prompt:
      "A single powerful thunderclap: a sharp crack followed by a deep rumble rolling off into the distance. Cinematic, dramatic, no music, no rain.",
  },
  {
    out: "chime.mp3",
    seconds: 4,
    prompt:
      "A soft, clear magical bell chime — a single gentle ring with a long shimmering crystalline tail. Warm, fantasy, no music.",
  },
  {
    out: "heartbeat.mp3",
    seconds: 4,
    prompt:
      "A slow, deep human heartbeat heard from close and inside the chest — muffled lub-dub thumps, steady and tense, no music.",
  },
  {
    out: "rain.mp3",
    seconds: 11,
    prompt:
      "Steady heavy rain, a continuous even downpour on stone with a soft distant rumble. Seamless looping ambience, no sudden thunderclaps, no music.",
  },
];

async function generate(key, prompt, seconds) {
  const body = { text: prompt, prompt_influence: 0.45 };
  if (seconds) body.duration_seconds = seconds;
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
  if (!res.ok) {
    throw new Error(`API error ${res.status}: ${await res.text()}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

const key = loadKey("ELEVENLABS_API_KEY");

const [, , argPrompt, argOut, argSecs] = process.argv;

if (argPrompt && argOut) {
  const buf = await generate(key, argPrompt, argSecs ? Number(argSecs) : undefined);
  mkdirSync(dirname(argOut), { recursive: true });
  writeFileSync(argOut, buf);
  console.log("wrote", argOut, `(${(buf.length / 1024).toFixed(0)} KB)`);
} else {
  mkdirSync(AUDIO_DIR, { recursive: true });
  for (const cue of M2_SET) {
    const buf = await generate(key, cue.prompt, cue.seconds);
    const dest = new URL(cue.out, AUDIO_DIR);
    writeFileSync(dest, buf);
    console.log("wrote", cue.out, `(${(buf.length / 1024).toFixed(0)} KB)`);
  }
  console.log("done — M2 cue set generated");
}
