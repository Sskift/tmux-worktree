import {
  AlertCircle,
  Bot,
  Check,
  LoaderCircle,
  RefreshCw,
  Save,
  Server,
  Terminal,
  X,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { MenuSelect } from "../../MenuSelect";
import { createLatestRequestGate, requestSourceKey } from "../../latestRequestGate";
import type { AgentProbeResult, HostConfig } from "../../platform";
import { useDashboardBackend } from "../../platform";
import "../design/tokens.css";
import "./AgentsSettings.css";
import {
  LOCAL_AGENT_TARGET_KEY,
  agentProbeTargetKey,
  buildAgentProbeTargetOptions,
  resolveAgentProbeTarget,
} from "./agentsSettingsModel";

export interface AgentsSettingsProps {
  hosts: readonly HostConfig[];
  defaultAgentCommand: string;
  onDefaultAgentCommandChange: (command: string) => void | Promise<void>;
}

type SaveNotice = { tone: "success" | "error"; message: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function AgentsSettings({
  hosts,
  defaultAgentCommand,
  onDefaultAgentCommandChange,
}: AgentsSettingsProps) {
  const dashboardBackend = useDashboardBackend();
  const requestGateRef = useRef(createLatestRequestGate());
  const [selectedTargetKey, setSelectedTargetKey] = useState(LOCAL_AGENT_TARGET_KEY);
  const [probeRevision, setProbeRevision] = useState(0);
  const [probeResults, setProbeResults] = useState<AgentProbeResult[]>([]);
  const [probing, setProbing] = useState(true);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [commandDraft, setCommandDraft] = useState(defaultAgentCommand);
  const [commandDirty, setCommandDirty] = useState(false);
  const [savingCommand, setSavingCommand] = useState(false);
  const [saveNotice, setSaveNotice] = useState<SaveNotice | null>(null);

  const targetOptions = useMemo(
    () => buildAgentProbeTargetOptions(hosts),
    [hosts],
  );
  const selectedTarget = useMemo(
    () => resolveAgentProbeTarget(selectedTargetKey, hosts),
    [hosts, selectedTargetKey],
  );
  const selectedTargetRequestKey = requestSourceKey(
    "agent-probe",
    selectedTarget.kind,
    selectedTarget.kind === "host" ? selectedTarget.hostId : null,
  );

  useEffect(() => {
    if (
      selectedTargetKey !== LOCAL_AGENT_TARGET_KEY
      && selectedTarget.kind === "local"
    ) {
      setSelectedTargetKey(LOCAL_AGENT_TARGET_KEY);
    }
  }, [selectedTarget.kind, selectedTargetKey]);

  useEffect(() => {
    setCommandDraft(defaultAgentCommand);
    setCommandDirty(false);
    setSaveNotice(null);
  }, [defaultAgentCommand]);

  useEffect(() => {
    const request = requestGateRef.current.issue(
      requestSourceKey(selectedTargetRequestKey, probeRevision),
    );
    setProbing(true);
    setProbeResults([]);
    setProbeError(null);

    void dashboardBackend.agents.probe(selectedTarget).then(
      (results) => {
        if (!requestGateRef.current.isCurrent(request)) return;
        setProbeResults(results);
        setProbing(false);
      },
      (error) => {
        if (!requestGateRef.current.isCurrent(request)) return;
        setProbeError(errorMessage(error));
        setProbing(false);
      },
    );

    return () => requestGateRef.current.cancel(request);
  }, [dashboardBackend, probeRevision, selectedTargetRequestKey]);

  const saveDefaultCommand = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const command = commandDraft.trim();
    if (!command) {
      setSaveNotice({ tone: "error", message: "Enter a default agent command." });
      return;
    }

    setSavingCommand(true);
    setSaveNotice(null);
    try {
      await onDefaultAgentCommandChange(command);
      setCommandDraft(command);
      setCommandDirty(false);
      setSaveNotice({ tone: "success", message: "Default command saved." });
    } catch (error) {
      setSaveNotice({ tone: "error", message: errorMessage(error) });
    } finally {
      setSavingCommand(false);
    }
  };

  const useAgent = (agent: AgentProbeResult) => {
    setCommandDraft(agent.command);
    setCommandDirty(agent.command !== defaultAgentCommand.trim());
    setSaveNotice(null);
  };

  const selectedTargetLabel = selectedTarget.kind === "host"
    ? hosts.find((host) => host.id === selectedTarget.hostId)?.label || selectedTarget.hostId
    : "This Mac";

  return (
    <div className="agents-settings">
      <section className="agents-card" aria-labelledby="agents-default-heading">
        <div className="agents-card__heading">
          <span className="agents-card__icon" aria-hidden="true"><Terminal size={16} /></span>
          <div>
            <h3 id="agents-default-heading">Default agent command</h3>
            <p>Automations use this command by default. New worktrees prefer the matching agent when it is available on the selected host.</p>
          </div>
        </div>

        <form className="agents-command-form" onSubmit={saveDefaultCommand}>
          <label htmlFor="settings-default-agent-command">Command</label>
          <div className="agents-command-form__row">
            <input
              id="settings-default-agent-command"
              type="text"
              spellCheck={false}
              autoComplete="off"
              value={commandDraft}
              aria-describedby="settings-default-agent-command-hint"
              onChange={(event) => {
                setCommandDraft(event.target.value);
                setCommandDirty(event.target.value !== defaultAgentCommand);
                setSaveNotice(null);
              }}
            />
            <button
              type="submit"
              className="agents-button agents-button--primary"
              disabled={savingCommand || !commandDirty}
            >
              {savingCommand
                ? <LoaderCircle className="agents-spin" aria-hidden="true" size={14} />
                : <Save aria-hidden="true" size={14} />}
              Save
            </button>
          </div>
          <p id="settings-default-agent-command-hint" className="agents-field-hint">
            Worktree creation accepts only a supported agent detected on the selected machine;
            detection never runs this full command.
          </p>
          {saveNotice ? (
            <p
              className={`agents-notice agents-notice--${saveNotice.tone}`}
              role={saveNotice.tone === "error" ? "alert" : "status"}
            >
              {saveNotice.tone === "success"
                ? <Check aria-hidden="true" size={14} />
                : <AlertCircle aria-hidden="true" size={14} />}
              {saveNotice.message}
            </p>
          ) : null}
        </form>
      </section>

      <section className="agents-card" aria-labelledby="agents-detection-heading">
        <div className="agents-card__header">
          <div className="agents-card__heading">
            <span className="agents-card__icon" aria-hidden="true"><Bot size={16} /></span>
            <div>
              <h3 id="agents-detection-heading">Detected agents</h3>
              <p>Checks a fixed list of supported executables without starting them.</p>
            </div>
          </div>
          <button
            type="button"
            className="agents-button"
            disabled={probing}
            onClick={() => setProbeRevision((revision) => revision + 1)}
          >
            <RefreshCw className={probing ? "agents-spin" : undefined} aria-hidden="true" size={14} />
            {probing ? "Scanning" : "Rescan"}
          </button>
        </div>

        <div className="agents-target-field">
          <label id="agents-probe-target-label">Scan target</label>
          <MenuSelect
            id="agents-probe-target"
            className="agents-menu-select"
            ariaLabel="Scan target"
            ariaDescribedBy="agents-probe-target-label"
            value={agentProbeTargetKey(selectedTarget)}
            options={targetOptions}
            onChange={setSelectedTargetKey}
          />
        </div>

        <div className="agents-probe-status" aria-live="polite">
          {probing ? (
            <p><LoaderCircle className="agents-spin" aria-hidden="true" size={15} /> Scanning {selectedTargetLabel}…</p>
          ) : probeError ? (
            <p className="agents-probe-status--error" role="alert">
              <AlertCircle aria-hidden="true" size={15} />
              Could not scan {selectedTargetLabel}: {probeError}
            </p>
          ) : (
            <p>
              <Server aria-hidden="true" size={15} />
              {probeResults.filter((agent) => agent.available).length} of {probeResults.length} available on {selectedTargetLabel}
            </p>
          )}
        </div>

        {!probing && !probeError ? (
          <ul className="agents-list" aria-label={`Agents detected on ${selectedTargetLabel}`}>
            {probeResults.map((agent) => (
              <li className="agents-list__item" key={agent.id}>
                <span
                  className={`agents-list__state agents-list__state--${agent.available ? "available" : "missing"}`}
                  aria-label={agent.available ? "Available" : "Not found"}
                >
                  {agent.available
                    ? <Check aria-hidden="true" size={14} />
                    : <X aria-hidden="true" size={14} />}
                </span>
                <div className="agents-list__copy">
                  <strong>{agent.label}</strong>
                  <code>{agent.command}</code>
                  <small>
                    {agent.error || agent.executablePath || `Not found on ${selectedTargetLabel}`}
                  </small>
                </div>
                <button
                  type="button"
                  className="agents-button agents-button--quiet"
                  disabled={!agent.available}
                  onClick={() => useAgent(agent)}
                >
                  Use as default
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        <p className="agents-safety-note">
          Detection confirms only that the executable is on PATH. Agent sessions still run in a raw terminal; structured events and tool-call controls are not available.
        </p>
      </section>
    </div>
  );
}
