import { useEffect, useState, type Dispatch, type SetStateAction } from "react";

/**
 * useState that survives reloads. Seeds from localStorage[key] (JSON) and writes
 * back on every change, so GM control settings — volumes, FX toggles, target,
 * gaps, the active tab — stay put instead of resetting each session, and the GM
 * doesn't have to re-dial them in.
 *
 * Values must be JSON-serialisable (primitives, plain objects, arrays) — don't
 * store a Set/Map here. Storage failures (private mode, quota) and bad JSON
 * degrade to the in-memory default rather than throwing. The key is fixed per
 * call site; changing keys at runtime isn't supported.
 */
export function usePersistentState<T>(
  key: string,
  initial: T,
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw !== null ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage unavailable — keep the in-memory value */
    }
  }, [key, value]);

  return [value, setValue];
}
