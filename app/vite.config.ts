import { defineConfig } from "vite";

// Served from https://zldqms6.github.io/outage-cover-app/ (GitHub Pages project site).
export default defineConfig({
  base: "/outage-cover-app/",
  build: { target: "es2020", chunkSizeWarningLimit: 1500 },
});
