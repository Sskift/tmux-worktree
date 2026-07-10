import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import {
  DashboardBackendProvider,
  useDashboardBackend,
} from "../src/platform/DashboardBackendContext.tsx";
import { createFakeDashboardBackend } from "../src/platform/fakeBackend.ts";

function BackendProbe() {
  const backend = useDashboardBackend();
  return createElement("span", null, backend.files.assetUrl("/tmp/probe.txt"));
}

test("a FakeDashboardBackend can drive a real React component through the provider", () => {
  const { backend } = createFakeDashboardBackend();
  const markup = renderToStaticMarkup(
    createElement(
      DashboardBackendProvider,
      { backend },
      createElement(BackendProbe),
    ),
  );

  assert.equal(markup, "<span>fake-asset://%2Ftmp%2Fprobe.txt</span>");
});

test("dashboard components fail clearly when the backend provider is missing", () => {
  assert.throws(
    () => renderToStaticMarkup(createElement(BackendProbe)),
    /DashboardBackendProvider is missing/,
  );
});
