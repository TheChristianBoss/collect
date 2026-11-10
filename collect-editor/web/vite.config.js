import {defineConfig} from "vite";

export default defineConfig({
  base: "./",
  build: {
    target: "esnext",
    outDir: "dist",
    assetsInlineLimit: 0,
    emptyOutDir: true,
  },
});
