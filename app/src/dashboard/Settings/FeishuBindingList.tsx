import type { FeishuBinding } from "../../platform";

type Props = {
  bindings: FeishuBinding[];
  disabled: boolean;
  unlinkingBindingId: string | null;
  onUnlink(binding: FeishuBinding): void;
};

export function FeishuBindingList({
  bindings,
  disabled,
  unlinkingBindingId,
  onUnlink,
}: Props) {
  return (
    <div className="feishu-integration-settings__binding-list" role="list">
      {bindings.map((binding) => {
        const unlinking = unlinkingBindingId === binding.id;
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
