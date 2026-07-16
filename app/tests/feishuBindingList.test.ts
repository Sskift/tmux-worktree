import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FeishuBindingList } from "../src/dashboard/Settings/FeishuBindingList.tsx";
import type { FeishuBinding } from "../src/platform/domainTypes.ts";

const binding: FeishuBinding = {
  version: 1,
  id: "binding-1",
  chatId: "chat-1",
  chatName: "Release room",
  controlTargetId: "managed-session-1",
  sessionName: "tmux-release",
  status: "stale",
  options: {
    mentionOnly: true,
    replyAsCard: true,
    includeQuotedContext: true,
  },
  allowedSenderIds: [],
  createdAt: "2026-07-16T09:00:00.000Z",
  createdBy: "dashboard",
};

test("group bindings expose an unlink action and its pending state", () => {
  const ready = renderToStaticMarkup(createElement(FeishuBindingList, {
    bindings: [binding],
    disabled: false,
    unlinkingBindingId: null,
    onUnlink() {},
  }));
  assert.match(ready, /aria-label="Unlink Release room from tmux-release"/);
  assert.match(ready, />Unlink<\/button>/);

  const pending = renderToStaticMarkup(createElement(FeishuBindingList, {
    bindings: [binding],
    disabled: true,
    unlinkingBindingId: binding.id,
    onUnlink() {},
  }));
  assert.match(pending, /disabled=""/);
  assert.match(pending, />Unlinking…<\/button>/);
});
