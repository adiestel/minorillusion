/**
 * Generate an image with OpenAI gpt-image-2 and save it to a file.
 * Reads OPENAI_API_KEY from .env.local (value is used, never printed).
 *
 *   node scripts/gen-assets/openai-image.mjs "<prompt>" <out.png> [size]
 *
 * size: 1024x1024 (default) | 1536x1024 | 1024x1536 | auto
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

function loadKey(name) {
  const env = readFileSync(new URL("../../.env.local", import.meta.url), "utf8");
  const line = env.split(/\r?\n/).find((l) => l.startsWith(`${name}=`));
  if (!line) throw new Error(`${name} not found in .env.local`);
  return line.slice(name.length + 1).trim();
}

const prompt = process.argv[2];
const out = process.argv[3];
const size = process.argv[4] ?? "1024x1024";
if (!prompt || !out) {
  console.error('usage: node openai-image.mjs "<prompt>" <out.png> [size]');
  process.exit(2);
}

const key = loadKey("OPENAI_API_KEY");
const res = await fetch("https://api.openai.com/v1/images/generations", {
  method: "POST",
  headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  body: JSON.stringify({ model: "gpt-image-2", prompt, size, n: 1 }),
});

if (!res.ok) {
  console.error(`API error ${res.status}:`, await res.text());
  process.exit(1);
}

const json = await res.json();
const b64 = json?.data?.[0]?.b64_json;
if (!b64) {
  console.error("no image in response:", JSON.stringify(json).slice(0, 600));
  process.exit(1);
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.from(b64, "base64"));
console.log("wrote", out, `(${(Buffer.from(b64, "base64").length / 1024).toFixed(0)} KB)`);
