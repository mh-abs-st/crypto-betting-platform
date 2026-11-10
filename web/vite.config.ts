import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    // The browser verifies bets with the same code the services use.
    alias: {
      "@yuubet/fair": fromRoot("../packages/fair/src/index.ts"),
      "@yuubet/games": fromRoot("../packages/games/src/index.ts"),
    },
  },
  server: {
    port: 5173,
    fs: { allow: [".."] },
    proxy: { "/api": "http://localhost:8080" },
  },
});
