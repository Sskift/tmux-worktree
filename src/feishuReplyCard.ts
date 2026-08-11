export type FeishuReplyCardTone = "answer" | "status";

export type FeishuReplyCard = Record<string, unknown>;

export type FeishuBindingLifecycleCardKind =
  | "linked"
  | "manual-unlink"
  | "session-deleted"
  | "target-ended"
  | "target-replaced";

export type FeishuBindingRemovalOrigin = "dashboard" | "cli" | "unknown-local-client";

export interface FeishuBindingLifecycleCardInput {
  kind: FeishuBindingLifecycleCardKind;
  sessionName: string;
  controlTargetId: string;
  sessionKind?: "worktree" | "terminal";
  sessionSummary?: string;
  removalOrigin?: FeishuBindingRemovalOrigin;
}

export interface FeishuLocalTaskResultCardInput {
  sessionName: string;
  sessionSummary?: string;
  text: string;
  truncated: boolean;
}

function neutralizeCardMentions(value: string): string {
  return value.replace(/<\/?at\b/gi, (tag) => `<\u200b${tag.slice(1)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function jsonObjectEnd(value: string, start: number): number | undefined {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return index + 1;
  }
  return undefined;
}

function neutralizeStructuredCardMentions(value: unknown): unknown {
  if (typeof value === "string") return neutralizeCardMentions(value);
  if (Array.isArray(value)) return value.map(neutralizeStructuredCardMentions);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, neutralizeStructuredCardMentions(item)]),
  );
}

const AGENT_CARD_ACTION_TAGS = new Set([
  "button",
  "checker",
  "date_picker",
  "form",
  "input",
  "multi_select_person",
  "multi_select_static",
  "overflow",
  "picker_datetime",
  "picker_time",
  "select_img",
  "select_person",
  "select_static",
]);

function isReadOnlyCardValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(isReadOnlyCardValue);
  if (!isRecord(value)) return true;
  if ((typeof value.tag === "string" && AGENT_CARD_ACTION_TAGS.has(value.tag))
    || Object.hasOwn(value, "behaviors")
    || Object.hasOwn(value, "card_link")) return false;
  return Object.values(value).every(isReadOnlyCardValue);
}

/** Extract a complete top-level Card 2.0 object from an Agent reply, including fenced JSON. */
export function extractFeishuReplyCard(text: string): FeishuReplyCard | undefined {
  const markers = [...text.matchAll(/"schema"\s*:\s*"2\.0"/g)];
  for (const marker of markers) {
    let start = text.lastIndexOf("{", marker.index);
    while (start >= 0) {
      const end = jsonObjectEnd(text, start);
      if (end !== undefined && end > (marker.index ?? 0)) {
        try {
          const parsed = JSON.parse(text.slice(start, end)) as unknown;
          if (isRecord(parsed)
            && parsed.schema === "2.0"
            && isRecord(parsed.body)
            && Array.isArray(parsed.body.elements)
            && parsed.body.elements.length > 0
            && parsed.body.elements.length <= 200
            && isReadOnlyCardValue(parsed)) {
            const card = neutralizeStructuredCardMentions(parsed) as FeishuReplyCard;
            const config = isRecord(card.config) ? card.config : {};
            card.config = {
              ...config,
              update_multi: true,
              streaming_mode: false,
            };
            return card;
          }
        } catch {
          // Keep walking backwards: prose can contain an unrelated opening brace.
        }
      }
      start = start === 0 ? -1 : text.lastIndexOf("{", start - 1);
    }
  }
  return undefined;
}

function conciseCardContext(value: string): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const characters = [...normalized];
  if (characters.length === 0) return "session";
  if (characters.length <= 48) return normalized;
  return `${characters.slice(0, 47).join("")}…`;
}

/**
 * Build the final, non-streaming Card JSON 2.0 payload used by the Bridge.
 * A complete read-only Agent card is preserved; other text is kept inside one
 * markdown element. Neither path can create a real Feishu <at> mention.
 */
export function buildFeishuReplyCard(
  text: string,
  sessionName: string,
  tone: FeishuReplyCardTone = "answer",
): FeishuReplyCard {
  const status = tone === "status";
  if (!status) {
    const structuredCard = extractFeishuReplyCard(text);
    if (structuredCard) return structuredCard;
  }
  const title = `tw agent on ${conciseCardContext(sessionName)}`;
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      width_mode: "default",
      enable_forward: true,
      streaming_mode: false,
      summary: { content: status ? "TW Agent 状态" : "TW Agent 回复" },
    },
    header: {
      template: status ? "orange" : "blue",
      title: {
        tag: "plain_text",
        content: title,
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

/**
 * Build the top-level result card for a task that was already running when
 * the group binding was created. The text comes from the Agent's structured
 * transcript, never from terminal rendering, composer state, or tool logs.
 */
export function buildFeishuLocalTaskResultCard(
  input: FeishuLocalTaskResultCardInput,
): FeishuReplyCard {
  if (!input.truncated) {
    const structuredCard = extractFeishuReplyCard(input.text);
    if (structuredCard) return structuredCard;
  }
  const titleContext = input.sessionSummary?.trim() || input.sessionName;
  const elements: Record<string, unknown>[] = [{
    tag: "markdown",
    content: neutralizeCardMentions(input.text),
    text_align: "left",
    text_size: "normal",
  }];
  if (input.truncated) {
    elements.push({ tag: "hr" }, {
      tag: "div",
      text: {
        tag: "plain_text",
        content: "最终回答过长，卡片仅展示前半部分；完整内容请在 TW 中查看。",
        text_align: "left",
        text_color: "grey",
        text_size: "notation",
      },
    });
  }
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      width_mode: "default",
      enable_forward: true,
      streaming_mode: false,
      summary: { content: "TW Agent 回复" },
    },
    header: {
      template: "green",
      icon: {
        tag: "standard_icon",
        token: "done_outlined",
        color: "green",
      },
      title: {
        tag: "plain_text",
        content: `tw agent on ${conciseCardContext(titleContext)}`,
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
      elements,
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

function lifecycleReason(
  kind: Exclude<FeishuBindingLifecycleCardKind, "linked">,
  removalOrigin?: FeishuBindingRemovalOrigin,
): {
  reason: string;
  action: string;
} {
  switch (kind) {
    case "manual-unlink":
      return {
        reason: removalOrigin === "dashboard"
          ? "本机 Dashboard 请求解除绑定"
          : removalOrigin === "cli"
            ? "本机 tw CLI 请求解除绑定"
            : "本机管理端请求解除绑定",
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
  const detail = input.kind === "linked"
    ? undefined
    : lifecycleReason(input.kind, input.removalOrigin);
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
      width_mode: "default",
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
