import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@minorillusion/contract": fileURLToPath(
        new URL("../../packages/contract/src/index.ts", import.meta.url),
      ),
      "@minorillusion/design-system": fileURLToPath(
        new URL("../../packages/design-system/src/index.ts", import.meta.url),
      ),
    },
  },
  build: {
    // Ship two entries: the player app (index.html) AND the GM Stage mirror
    // (mirror.html), a real production feature the GM embeds. (preview.html is
    // dev-only and intentionally excluded.)
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL("index.html", import.meta.url)),
        mirror: fileURLToPath(new URL("mirror.html", import.meta.url)),
      },
    },
  },
  server: {
    port: 5174,
  },
});
