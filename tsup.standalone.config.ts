import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/cli.ts" },
  format: ["cjs"],
  target: "node20",
  platform: "node",
  bundle: true,
  outDir: "dist",
  outExtension: () => ({ js: ".cjs" }),
  clean: false,
  splitting: false,
  noExternal: ["ws"],
});
