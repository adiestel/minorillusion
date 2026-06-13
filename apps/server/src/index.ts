import cors from "@fastify/cors";
import Fastify from "fastify";
import { DEFAULT_SERVER_PORT } from "@minorillusion/contract";
import { CircleService, DrizzleCirclesStore } from "./circles.js";
import { runMigrations } from "./db/migrate.js";
import { createSocketServer } from "./socket.js";

// M0 realtime core entrypoint: Fastify (/health) + Socket.IO (circle:create /
// circle:open / circle:join) over Drizzle/Postgres, with presence broadcast.

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });

app.get("/health", async () => ({ status: "ok" }));

// Apply pending migrations before listening so a fresh DB works immediately.
await runMigrations();

// Wire the typed Socket.IO server onto Fastify's underlying http server.
const service = new CircleService(new DrizzleCirclesStore());
const io = createSocketServer(app, { service });

app.addHook("onClose", async () => {
  await io.close();
});

const port = Number(process.env.SERVER_PORT ?? DEFAULT_SERVER_PORT);
await app.listen({ port, host: "0.0.0.0" });
