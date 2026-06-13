/**
 * Typed Socket.IO client for the GM plane.
 * Uses the contract's event maps so every emit/listen is statically checked.
 */
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from "@minorillusion/contract";
import { io, type Socket } from "socket.io-client";

const SERVER_URL =
  (import.meta.env.VITE_SERVER_URL as string | undefined) ??
  "http://localhost:3001";

// Single shared socket instance for the app lifetime.
export const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(
  SERVER_URL,
  {
    autoConnect: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
  },
);
