import { MenuSelect } from "../../MenuSelect";
import type { FeishuBinding, FeishuReplyMode } from "../../platform";

const REPLY_MODE_OPTIONS = [
  { value: "topic", label: "Topic reply" },
  { value: "direct", label: "Direct reply" },
];

type Props = {
  bindings: FeishuBinding[];
  disabled: boolean;
  unlinkingBindingId: string | null;
  updatingBindingId: string | null;
  onUnlink(binding: FeishuBinding): void;
  onReplyModeChange(binding: FeishuBinding, replyMode: FeishuReplyMode): void;
};

export function FeishuBindingList({
  bindings,
  disabled,
  unlinkingBindingId,
  updatingBindingId,
  onUnlink,
  onReplyModeChange,
}: Props) {
  return (
    <div className="feishu-integration-settings__binding-list" role="list">
      {bindings.map((binding) => {
        const unlinking = unlinkingBindingId === binding.id;
        const updating = updatingBindingId === binding.id;
        const replyMode = binding.options.replyMode ?? "topic";
        return (
          <div className="feishu-integration-settings__binding" role="listitem" key={binding.id}>
            <span className="feishu-integration-settings__binding-session" title={binding.sessionName}>
              {binding.sessionName}
            </span>
            <span className="feishu-integration-settings__binding-arrow" aria-hidden="true">→</span>
            <span className="feishu-integration-settings__binding-group" title={binding.chatName}>
              {binding.chatName}
            </span>
            <span className={`feishu-integration-settings__binding-status feishu-integration-settings__binding-status--${binding.status}`}>
              {binding.status}
            </span>
            <div className="feishu-integration-settings__binding-reply-mode">
              <MenuSelect
                ariaLabel={`Reply placement for ${binding.chatName}`}
                value={replyMode}
                options={REPLY_MODE_OPTIONS}
                disabled={disabled || updating}
                onChange={(value) => {
                  const next = value === "direct" ? "direct" : "topic";
                  if (next !== replyMode) onReplyModeChange(binding, next);
                }}
              />
              {updating && <span role="status">Saving…</span>}
            </div>
            <button
              className="settings-action-button feishu-integration-settings__binding-unlink"
              type="button"
              disabled={disabled}
              aria-label={`Unlink ${binding.chatName} from ${binding.sessionName}`}
              onClick={() => onUnlink(binding)}
            >
              {unlinking ? "Unlinking…" : "Unlink"}
            </button>
          </div>
        );
      })}
    </div>
  );
}
