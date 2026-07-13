import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/config.ts",
    "src/automation.ts",
    "src/hosts.ts",
    "src/rpc.ts",
    "src/session.ts",
    "src/state.ts",
    "src/relayHost.ts",
    "src/relayServer.ts",
    "src/terminalControl/index.ts",
  ],
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: true,
  splitting: false,
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
  noExternal: ["ws"],
});
