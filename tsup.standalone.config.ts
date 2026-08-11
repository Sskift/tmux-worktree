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
  // Keep the default-off Relay v2 shipping seams on their canonical ESM dist
  // owners instead of bundling second private registries into the CJS CLI.
  external: [
    "./relay/v2/brokerShippingRoot.js",
    "./relay/v2/brokerShippingDeploymentSource.js",
    "./relay/v2/hostRuntimeComposition.js",
    "./relay/v2/hostCanonicalProductionComposition.js",
    "./relay/v2/hostShippingRoot.js",
    "./relay/v2/hostShippingDeploymentSource.js",
    // The hidden Dashboard management child stays on the same canonical dist
    // owners as the Host shipping chain instead of bundling second private
    // registries. Dashboard packages the canonical ESM sibling tree alongside
    // cli.cjs so this entry is present without changing owner identity.
    "./relay/v2/relayV2DashboardManagementChildRuntime.js",
  ],
  noExternal: ["ws"],
  loader: {
    ".md": "text",
    ".yaml": "text",
  },
});
