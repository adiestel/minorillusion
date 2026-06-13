/**
 * Stable per-device identity (DECISIONS.md D9).
 *
 * Generated once with crypto.randomUUID() and persisted in localStorage under
 * the key `mi.deviceId`. Every subsequent load reuses the same id, so the
 * server can recognise a returning player across reconnects or app restarts.
 */

const STORAGE_KEY = "mi.deviceId";

function loadOrCreate(): string {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored !== null) return stored;
  const fresh = crypto.randomUUID();
  localStorage.setItem(STORAGE_KEY, fresh);
  return fresh;
}

export const deviceId: string = loadOrCreate();
