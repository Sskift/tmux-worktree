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
    updatingBindingId: null,
    onUnlink() {},
    onReplyModeChange() {},
  }));
  assert.match(ready, /aria-label="Unlink Release room from tmux-release"/);
  assert.match(ready, />Unlink<\/button>/);
  assert.match(ready, /aria-label="Reply placement for Release room"/);
  assert.match(ready, /automation-menu-select__label">Topic reply<\/span>/);

  const saving = renderToStaticMarkup(createElement(FeishuBindingList, {
    bindings: [{
      ...binding,
      options: { ...binding.options, replyMode: "direct" },
    }],
    disabled: false,
    unlinkingBindingId: null,
    updatingBindingId: binding.id,
    onUnlink() {},
    onReplyModeChange() {},
  }));
  assert.match(saving, /aria-label="Reply placement for Release room"[^>]*disabled=""/);
  assert.match(saving, /automation-menu-select__label">Direct reply<\/span>/);
  assert.match(saving, />Saving…<\/span>/);

  const unlinking = renderToStaticMarkup(createElement(FeishuBindingList, {
    bindings: [binding],
    disabled: true,
    unlinkingBindingId: binding.id,
    updatingBindingId: null,
    onUnlink() {},
    onReplyModeChange() {},
  }));
  assert.match(unlinking, />Unlinking…<\/button>/);
});
