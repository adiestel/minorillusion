/**
 * Typed Socket.IO client.
 *
 * Uses the event maps from @minorillusion/contract so every emit/on call is
 * fully typed — no hand-written message shapes here.
 *
 * Server URL is read from the Vite env variable VITE_SERVER_URL, falling back
 * to localhost:3001 for local development.
 */

import { io, Socket } from "socket.io-client";
import type {
  ServerToClientEvents,
  ClientToServerEvents,
} from "@minorillusion/contract";

const SERVER_URL =
  (import.meta as ImportMeta & { env: Record<string, string | undefined> }).env
    .VITE_SERVER_URL ?? "http://localhost:3001";

/**
 * The single shared socket for the player app.
 *
 * `autoConnect: false` so we connect only after the user initiates a join —
 * avoids opening a socket on the landing screen. Reconnection is on (and
 * unbounded) so a server restart or network blip auto-recovers; the rejoin
 * listener in main.tsx re-binds and resyncs on each reconnect.
 */
export const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(
  SERVER_URL,
  {
    autoConnect: false,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
  },
);
