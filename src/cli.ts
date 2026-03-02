#!/usr/bin/env node

const sub = process.argv[2];

if (sub === "status") {
  const { run } = await import("./status.js");
  await run();
} else {
  const { run } = await import("./dev.js");
  await run();
}
