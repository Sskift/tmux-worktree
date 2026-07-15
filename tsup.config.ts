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
    "src/relay/v2/hostState.ts",
    "src/relay/v2/token.ts",
    "src/relay/v2/issuer.ts",
    "src/relay/v2/auth.ts",
    "src/relay/v2/codec.ts",
    "src/terminalControl/index.ts",
    "src/canonicalTerminalControlClient.ts",
    "src/larkCliBridge.ts",
    "src/feishuBridgeStorage.ts",
    "src/feishuBridge.ts",
    "src/feishuBridgeServer.ts",
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
