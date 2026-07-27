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
  // Keep the default-off relay-host v2 seam on the same canonical dist owner
  // as snapshot-spool H2 recovery instead of bundling a second private registry.
  external: [
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
});
