/**
 * Persists the player's last-joined circle so the app can auto-reconnect on
 * page refresh. Stored under `mi.session` in localStorage.
 *
 * Shape: { code: string; name: string }
 *   - code: the six-digit circle join code (from result.circle.code)
 *   - name: the player's chosen name (from result.player.name)
 *
 * The server pins a player by (circleId, deviceId), so re-emitting circle:join
 * with the same deviceId always returns the same player record.
 */

const STORAGE_KEY = "mi.session";

export interface StoredSession {
  code: string;
  name: string;
}

export function saveSession(session: StoredSession): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

export function loadSession(): StoredSession | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "code" in parsed &&
      "name" in parsed &&
      typeof (parsed as Record<string, unknown>).code === "string" &&
      typeof (parsed as Record<string, unknown>).name === "string"
    ) {
      return parsed as StoredSession;
    }
    return null;
  } catch {
    return null;
  }
}

export function clearSession(): void {
  localStorage.removeItem(STORAGE_KEY);
}
