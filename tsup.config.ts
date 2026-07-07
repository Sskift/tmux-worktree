import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts", "src/automation.ts", "src/rpc.ts", "src/session.ts", "src/state.ts"],
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: true,
  splitting: false,
  noExternal: ["ws"],
});
