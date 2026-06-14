import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Zero-dependency .env loader (no dotenv). On import it reads `.env.local` then
 * `.env` from the repo root and sets each `KEY=VALUE` into process.env ONLY when
 * the key is not already set — so a real environment variable always wins, and
 * `.env.local` overrides `.env`. Values are never logged. Missing files are fine
 * (the try/catch swallows the read error). Import this FIRST in index.ts so that
 * DATABASE_URL / ELEVENLABS_API_KEY are populated before any module reads them.
 *
 * Parsing mirrors scripts/gen-assets/openai-image.mjs: split each line on the
 * FIRST `=`, trim both sides, and ignore blank lines and `#` comments.
 */

// Repo root is two levels up from apps/server (this file lives in apps/server/src).
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function loadEnvFile(path: string): void {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    return; // Missing/unreadable file: nothing to load, which is fine.
  }
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue; // No `=`: not a KEY=VALUE line.
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key === "") continue;
    // Real env wins; first file to set a key wins (.env.local before .env).
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

// .env.local takes precedence over .env (loaded first; real env still wins).
loadEnvFile(join(repoRoot, ".env.local"));
loadEnvFile(join(repoRoot, ".env"));
