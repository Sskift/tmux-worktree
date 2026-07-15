export type FeishuReplyCardTone = "answer" | "status";

export type FeishuReplyCard = Record<string, unknown>;

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
