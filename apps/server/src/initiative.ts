import { randomUUID } from "node:crypto";
import type {
  InitiativeEntry,
  InitiativeState,
  SetInitiativeRequest,
} from "@minorillusion/contract";

/**
 * The initiative tracker as a PURE reducer (M5; D6 — we own combat order). Given
 * the current InitiativeState and an action, return the NEXT state — no I/O, no
 * mutation of the input. The socket layer holds the per-circle state in memory
 * (transient session state, not persisted for M5) and feeds it through here, so
 * all the ordering rules are unit-testable in isolation. See src/initiative.test.ts.
 *
 * Conventions:
 *   • Entries are kept sorted high→low by `initiative` (a STABLE sort, so equal
 *     rolls preserve the GM's input order — a manual tiebreak).
 *   • `turnIndex` is the 0-based cursor into `entries`; it is −1 exactly when the
 *     order is empty (no current turn). `round` is 0 only when empty, else ≥ 1.
 */

/** An empty tracker for a circle (no entries, no current turn). */
export function emptyInitiative(circleId: string): InitiativeState {
  return { circleId, round: 0, turnIndex: -1, entries: [] };
}

/** Stable high→low sort by initiative (equal rolls keep their input order). */
function sortEntries(entries: InitiativeEntry[]): InitiativeEntry[] {
  // .sort() is stable in V8/modern JS, so equal initiatives retain input order.
  return [...entries].sort((a, b) => b.initiative - a.initiative);
}

/**
 * Replace the whole order from a GM set request. New entries (no id) are minted a
 * uuid; existing ids are preserved (so a re-set that only reorders keeps entry
 * identity). The result is sorted high→low, the round resets to 1 (a fresh order
 * starts a fresh combat) and the cursor to the top entry — or to the empty
 * sentinel (round 0, turnIndex −1) when the GM clears every entry via an empty set.
 */
export function setEntries(
  state: InitiativeState,
  req: SetInitiativeRequest,
): InitiativeState {
  const entries = sortEntries(
    req.entries.map((e) => ({
      id: e.id ?? randomUUID(),
      name: e.name,
      initiative: e.initiative,
      ...(e.characterId !== undefined ? { characterId: e.characterId } : {}),
      ...(e.hp !== undefined ? { hp: e.hp } : {}),
      ...(e.maxHp !== undefined ? { maxHp: e.maxHp } : {}),
    })),
  );
  const nonEmpty = entries.length > 0;
  return {
    circleId: state.circleId,
    round: nonEmpty ? 1 : 0,
    turnIndex: nonEmpty ? 0 : -1,
    entries,
  };
}

/**
 * Advance the cursor to the next combatant. Moves `turnIndex` forward by one;
 * wrapping past the last entry returns to index 0 and increments `round` (the top
 * of the order comes round again). A no-op on an empty order. If the cursor was
 * somehow un-started (−1) on a non-empty order, it lands on the first entry.
 */
export function advanceTurn(state: InitiativeState): InitiativeState {
  if (state.entries.length === 0) return state;
  const next = state.turnIndex + 1;
  const wrapped = next >= state.entries.length;
  return {
    ...state,
    turnIndex: wrapped ? 0 : next,
    round: wrapped ? state.round + 1 : Math.max(1, state.round),
    entries: state.entries,
  };
}

/** Clear the tracker: no entries, round 0, no current turn (−1). */
export function clearInitiative(state: InitiativeState): InitiativeState {
  return emptyInitiative(state.circleId);
}
