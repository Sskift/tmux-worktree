import type { LatestRequestGate, LatestRequestToken } from "../../latestRequestGate";
import { createLatestRequestGate } from "../../latestRequestGate";
import type { MobileRelayV2SelfHostedDeploymentPort } from "../../platform/dashboardBackend";
import type { MobileRelayV2SelfHostedStatus } from "../../platform/domainTypes";
import {
  createRelayV2SelfHostedDraft,
  selfHostedStatusToDraft,
  validateRelayV2SelfHostedDraft,
  type RelayV2SelfHostedDraft,
  type RelayV2SelfHostedDraftErrors,
} from "./relayV2SelfHostedModel";

export type RelayV2SelfHostedOperation =
  | "save"
  | "deploy"
  | "start"
  | "stop"
  | "rotate"
  | null;

/**
 * The one-shot mount status() probe runs over SSH and can take seconds; a
 * user keystroke or a completed run() must supersede it before it returns.
 * Runs and the mount probe each issue a token on the same gate; a user edit
 * invalidates the in-flight mount probe because its draft backfill would
 * otherwise clobber unsaved input. Only the newest request may publish its
 * status/draft — the same latest-request fence used by connectionsAsyncCoordinator.
 */
export type RelayV2SelfHostedRequestGate = {
  request(): LatestRequestToken;
  userEdited(): void;
  canPublish(token: LatestRequestToken): boolean;
};

export function createRelayV2SelfHostedRequestGate(): RelayV2SelfHostedRequestGate {
  const gate: LatestRequestGate = createLatestRequestGate();
  return {
    request: () => gate.issue("relay-v2-self-hosted"),
    userEdited: () => gate.invalidate(),
    canPublish: (token) => gate.isCurrent(token),
  };
}

export type RelayV2SelfHostedPanelState = {
  draft: RelayV2SelfHostedDraft;
  status: MobileRelayV2SelfHostedStatus | null;
  errors: RelayV2SelfHostedDraftErrors;
  operation: RelayV2SelfHostedOperation;
  notice: string | null;
};

/**
 * The panel's async wiring, extracted out of the React component so the
 * exact fence logic the component relies on (mount probe issues a token,
 * edits invalidate it, run() supersedes it, every publish checks the token)
 * can be driven under node:test without jsdom or react-test-renderer. The
 * component is a thin shell: it forwards mount/unmount/update/run calls here
 * and mirrors every state change into React state via onState.
 */
export type RelayV2SelfHostedPanelController = {
  readonly state: RelayV2SelfHostedPanelState;
  /** Issues the one-shot mount status() probe. */
  mount(): void;
  /** Cancels the mount probe so a late response never publishes. */
  unmount(): void;
  /** Applies a user edit; invalidates the in-flight mount probe. */
  update<K extends keyof RelayV2SelfHostedDraft>(
    field: K,
    value: RelayV2SelfHostedDraft[K],
  ): void;
  /** Runs a save/deploy/start/stop/rotate operation behind the gate. */
  run(kind: Exclude<RelayV2SelfHostedOperation, null>): Promise<void>;
};

export function createRelayV2SelfHostedPanelController(
  deployment: MobileRelayV2SelfHostedDeploymentPort,
  onState: (state: RelayV2SelfHostedPanelState) => void,
  gate: RelayV2SelfHostedRequestGate = createRelayV2SelfHostedRequestGate(),
): RelayV2SelfHostedPanelController {
  let state: RelayV2SelfHostedPanelState = {
    draft: createRelayV2SelfHostedDraft(),
    status: null,
    errors: {},
    operation: null,
    notice: null,
  };
  let mounted = false;

  const publish = (patch: Partial<RelayV2SelfHostedPanelState>) => {
    state = { ...state, ...patch };
    onState(state);
  };

  const successNotice = (
    kind: Exclude<RelayV2SelfHostedOperation, null>,
    draft: RelayV2SelfHostedDraft,
  ): string =>
    kind === "save"
      ? "Self-hosted Relay v2 settings saved."
      : kind === "deploy"
        ? draft.externalTlsManagement
          ? "Canonical tw bundle and deployment profile published; external TLS validated in place."
          : "Canonical tw bundle, TLS files, and deployment profile published."
        : kind === "start"
          ? "Relay v2 Center started on the selected devbox."
          : kind === "rotate"
            ? "Expired version-zero Host bootstrap rotated with the same persisted correlation."
            : "Relay v2 Center stopped; persisted broker state was preserved.";

  return {
    get state() {
      return state;
    },

    mount() {
      if (mounted) return;
      mounted = true;
      const request = gate.request();
      void deployment.status().then((next) => {
        if (!mounted || !gate.canPublish(request)) return;
        publish({ status: next, draft: selfHostedStatusToDraft(next) });
      }).catch((error: unknown) => {
        if (mounted && gate.canPublish(request)) {
          publish({ notice: error instanceof Error ? error.message : String(error) });
        }
      });
    },

    unmount() {
      mounted = false;
    },

    update(field, value) {
      gate.userEdited();
      publish({
        draft: { ...state.draft, [field]: value },
        errors: { ...state.errors, [field]: undefined },
        notice: null,
      });
    },

    async run(kind) {
      if (state.operation) return;
      const draftAtIssue = state.draft;
      publish({ notice: null, operation: kind });
      let request: LatestRequestToken | null = null;
      try {
        let next: MobileRelayV2SelfHostedStatus;
        if (kind === "stop") {
          request = gate.request();
          next = await deployment.stopCenter();
        } else if (kind === "rotate") {
          request = gate.request();
          next = await deployment.rotateExpiredHostBootstrap();
        } else {
          const validation = validateRelayV2SelfHostedDraft(state.draft);
          publish({ errors: validation.errors });
          if (!validation.valid) {
            publish({
              notice: "Review the highlighted Relay v2 deployment fields.",
            });
            return;
          }
          request = gate.request();
          next = kind === "save"
            ? await deployment.saveConfig(validation.value)
            : kind === "deploy"
              ? await deployment.deploy(validation.value)
              : await deployment.startCenter(validation.value);
        }
        if (!request || !gate.canPublish(request)) return;
        publish({
          status: next,
          draft: selfHostedStatusToDraft(next),
          notice: successNotice(kind, draftAtIssue),
        });
      } catch (error) {
        if (!request || gate.canPublish(request)) {
          publish({
            notice: error instanceof Error ? error.message : String(error),
          });
        }
      } finally {
        // Mirrors the component's finally { setOperation(null) }: the
        // operation indicator clears on every settle, fenced or not.
        publish({ operation: null });
      }
    },
  };
}
