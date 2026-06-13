import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Alias the internal TS packages to their source so Vite transpiles them
// directly (no build step for shared packages in dev).
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
  server: {
    port: 5173,
  },
});
