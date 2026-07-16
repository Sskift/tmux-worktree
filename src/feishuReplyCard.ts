export type FeishuReplyCardTone = "answer" | "status";

export type FeishuReplyCard = Record<string, unknown>;

export type FeishuBindingLifecycleCardKind =
  | "linked"
  | "manual-unlink"
  | "session-deleted"
  | "target-ended"
  | "target-replaced";

export interface FeishuBindingLifecycleCardInput {
  kind: FeishuBindingLifecycleCardKind;
  sessionName: string;
  controlTargetId: string;
  sessionKind?: "worktree" | "terminal";
  sessionSummary?: string;
}

function neutralizeCardMentions(value: string): string {
  return value.replace(/<\/?at\b/gi, (tag) => `<\u200b${tag.slice(1)}`);
}

/**
 * Build the final, non-streaming Card JSON 2.0 payload used by the Bridge.
 * Agent text is kept inside one markdown element and cannot create a real
 * Feishu <at> mention as a side effect.
 */
export function buildFeishuReplyCard(
  text: string,
  tone: FeishuReplyCardTone = "answer",
): FeishuReplyCard {
  const status = tone === "status";
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      compact_width: false,
      enable_forward: true,
      streaming_mode: false,
      summary: { content: status ? "TW Agent 状态" : "TW Agent 回复" },
    },
    header: {
      template: status ? "orange" : "blue",
      title: {
        tag: "plain_text",
        content: status ? "TW Agent 状态" : "TW Agent",
        text_align: "left",
      },
    },
    body: {
      direction: "vertical",
      horizontal_spacing: "8px",
      vertical_spacing: "8px",
      horizontal_align: "left",
      vertical_align: "top",
      padding: "16px 20px 16px 20px",
      elements: [{
        tag: "markdown",
        content: neutralizeCardMentions(text),
        text_align: "left",
        text_size: "normal",
      }],
    },
  };
}

function lifecyclePresentation(kind: FeishuBindingLifecycleCardKind): {
  title: string;
  summary: string;
  template: "green" | "grey" | "red";
  tag: string;
} {
  switch (kind) {
    case "linked":
      return {
        title: "TW 群聊连接已建立",
        summary: "TW 已绑定到本群",
        template: "green",
        tag: "已连接",
      };
    case "manual-unlink":
      return {
        title: "TW 群聊连接已解除",
        summary: "TW 群聊连接已解除",
        template: "grey",
        tag: "已解绑",
      };
    case "session-deleted":
    case "target-ended":
    case "target-replaced":
      return {
        title: "TW 群聊连接已失效",
        summary: "TW 群聊连接已失效",
        template: "red",
        tag: "已失效",
      };
  }
}

function lifecycleReason(kind: Exclude<FeishuBindingLifecycleCardKind, "linked">): {
  reason: string;
  action: string;
} {
  switch (kind) {
    case "manual-unlink":
      return {
        reason: "用户主动解除绑定",
        action: "群内消息不再转发到此 TW 会话。",
      };
    case "session-deleted":
      return {
        reason: "绑定的 TW / tmux 会话已被删除",
        action: "请先创建或选择仍然存在的 TW 会话，再重新绑定本群。",
      };
    case "target-ended":
      return {
        reason: "原 TW 会话的精确生命周期已结束",
        action: "无法确认名称是否已被复用；连接不会自动迁移，请确认目标后重新绑定。",
      };
    case "target-replaced":
      return {
        reason: "原 TW 会话的精确生命周期已结束或被同名会话替换",
        action: "连接不会自动指向同名的新会话；请确认目标后重新绑定。",
      };
  }
}

/** Build a top-level, non-interactive Card JSON 2.0 lifecycle notice. */
export function buildFeishuBindingLifecycleCard(
  input: FeishuBindingLifecycleCardInput,
): FeishuReplyCard {
  const presentation = lifecyclePresentation(input.kind);
  const linked = input.kind === "linked";
  const detail = input.kind === "linked" ? undefined : lifecycleReason(input.kind);
  const sessionKind = input.sessionKind === "worktree"
    ? "Worktree"
    : input.sessionKind === "terminal"
      ? "Terminal"
      : "Managed session";
  const elements: Record<string, unknown>[] = [{
    tag: "div",
    text: {
      tag: "plain_text",
      content: linked ? "本群已绑定到以下终端" : "原连接信息",
      text_align: "left",
    },
    fields: [
      {
        is_short: true,
        text: {
          tag: "plain_text",
          content: `tmux 会话名\n${input.sessionName}`,
          text_align: "left",
        },
      },
      {
        is_short: true,
        text: {
          tag: "plain_text",
          content: `TW 类型\n${sessionKind}`,
          text_align: "left",
        },
      },
    ],
  }, {
    tag: "div",
    text: {
      tag: "plain_text",
      content: `生命周期 ID\n${input.controlTargetId}`,
      text_align: "left",
      lines: 2,
    },
  }, {
    tag: "hr",
  }];
  if (linked) {
    elements.push({
      tag: "div",
      text: {
        tag: "plain_text",
        content: `会话概览\n${input.sessionSummary || input.sessionName}`,
        text_align: "left",
        lines: 4,
      },
    }, {
      tag: "div",
      text_size: "notation",
      text: {
        tag: "plain_text",
        content: "群内 @Bot 的消息会发送到该会话，Agent 会在原消息话题中回复。",
        text_align: "left",
        text_color: "grey",
        lines: 2,
      },
    });
  } else {
    elements.push({
      tag: "div",
      text: {
        tag: "plain_text",
        content: `失效原因\n${detail!.reason}`,
        text_align: "left",
        lines: 3,
      },
    }, {
      tag: "div",
      text_size: "notation",
      text: {
        tag: "plain_text",
        content: detail!.action,
        text_align: "left",
        text_color: "grey",
        lines: 3,
      },
    });
  }
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      compact_width: false,
      enable_forward: true,
      streaming_mode: false,
      summary: { content: presentation.summary },
    },
    header: {
      template: presentation.template,
      title: {
        tag: "plain_text",
        content: presentation.title,
        text_align: "left",
      },
      icon: {
        tag: "standard_icon",
        token: "connect_outlined",
        color: presentation.template,
      },
      text_tag_list: [{
        tag: "text_tag",
        text: { tag: "plain_text", content: presentation.tag, text_align: "left" },
        color: presentation.template === "grey" ? "neutral" : presentation.template,
      }],
    },
    body: {
      direction: "vertical",
      horizontal_spacing: "8px",
      vertical_spacing: "8px",
      horizontal_align: "left",
      vertical_align: "top",
      padding: "16px 20px 16px 20px",
      elements,
    },
  };
}
