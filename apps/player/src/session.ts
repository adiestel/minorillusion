/**
 * Persists the player's last-joined circle so the app can auto-reconnect on
 * page refresh. Stored under `mi.session` in localStorage.
 *
 * Shape: { code: string; name: string; consented?: true }
 *   - code: the six-digit circle join code (from result.circle.code)
 *   - name: the player's chosen name (from result.player.name)
 *   - consented: set once the player accepts the consent disclosure (D10), so
 *     the auto-reconnect path does NOT re-prompt. A fresh manual join always
 *     shows the disclosure regardless of this flag.
 *
 * The server pins a player by (circleId, deviceId), so re-emitting circle:join
 * with the same deviceId always returns the same player record.
 */

const STORAGE_KEY = "mi.session";

export interface StoredSession {
  code: string;
  name: string;
  /** True once the consent disclosure was accepted for this stored session. */
  consented?: true;
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
      const obj = parsed as Record<string, unknown>;
      const session: StoredSession = {
        code: obj.code as string,
        name: obj.name as string,
      };
      if (obj.consented === true) session.consented = true;
      return session;
    }
    return null;
  } catch {
    return null;
  }
}

export function clearSession(): void {
  localStorage.removeItem(STORAGE_KEY);
}
