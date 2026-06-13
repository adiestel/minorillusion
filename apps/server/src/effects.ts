import { randomUUID } from "node:crypto";
import type {
  MessageEffect,
  SendMessageRequest,
  Target,
} from "@minorillusion/contract";

/**
 * The effect router — the pure core of the actor → router → target spine
 * (see docs/ARCHITECTURE.md). These functions take a GM's request plus a
 * snapshot of who is present and decide *what* the effect is and *who* receives
 * it. They touch no sockets and no DB, so the routing logic is unit-testable in
 * isolation (see src/effects.test.ts); the socket layer wires the plumbing.
 */

/**
 * Mint a concrete message effect instance from a GM's send request. The id is a
 * fresh UUID and createdAt is stamped now (ISO-8601). autoDismissMs is carried
 * through only when supplied, so the emitted shape matches the contract's
 * optional field exactly (never an explicit `undefined`).
 */
export function buildMessageEffect(req: SendMessageRequest): MessageEffect {
  const effect: MessageEffect = {
    id: randomUUID(),
    kind: "message",
    body: req.body,
    mode: req.mode,
    createdAt: new Date().toISOString(),
  };
  if (req.autoDismissMs !== undefined) {
    effect.autoDismissMs = req.autoDismissMs;
  }
  return effect;
}

/**
 * Resolve a target spec against the players currently present into the concrete
 * set of recipient playerIds:
 *  - broadcast → every present player.
 *  - players   → the requested ids intersected with who is present (requested
 *    ids that are absent are silently dropped; order/uniqueness follows the
 *    present roster).
 */
export function resolveTargets(
  target: Target,
  presentPlayerIds: string[],
): string[] {
  if (target.kind === "broadcast") {
    return [...presentPlayerIds];
  }
  const requested = new Set(target.playerIds);
  return presentPlayerIds.filter((id) => requested.has(id));
}
