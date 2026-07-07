import { useEffect, useMemo, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { MenuSelect, type MenuOption } from "./MenuSelect";

type HostConfig = {
  id: string;
  label: string;
  host: string;
  user?: string | null;
  port?: number | null;
  identityFile?: string | null;
};

type HostStatus = {
  id: string;
  label: string;
  reachable: boolean;
  latencyMs?: number;
  error?: string;
  twAvailable?: boolean;
  twVersion?: string;
  twError?: string;
};

type Props = {
  existingIds: string[];
  sshHosts: HostConfig[];
  onClose: () => void;
  onAdded: (hosts: HostConfig[]) => void;
};

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 20);

export function AddHostModal({ existingIds, sshHosts, onClose, onAdded }: Props) {
  const [selectedHost, setSelectedHost] = useState("");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<HostStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectableHosts = useMemo(
    () => sshHosts.filter((candidate) => !existingIds.includes(slugify(candidate.id))),
    [existingIds, sshHosts],
  );
  const hostOptions: MenuOption[] = useMemo(
    () => selectableHosts.map((candidate) => ({
      value: candidate.id,
      label: candidate.label || candidate.id,
      detail: candidate.user ? `${candidate.user}@${candidate.host}` : candidate.host,
    })),
    [selectableHosts],
  );
  const selectedCandidate = selectableHosts.find((item) => item.id === selectedHost) ?? null;
  const selectedPort = typeof selectedCandidate?.port === "number" ? selectedCandidate.port : undefined;
  const displayPort = selectedPort ?? 22;

  useEffect(() => {
    if (!hostOptions.length) {
      if (selectedHost) setSelectedHost("");
      return;
    }
    if (!hostOptions.some((option) => option.value === selectedHost)) {
      setSelectedHost(hostOptions[0].value);
    }
  }, [hostOptions, selectedHost]);

  const applySshHostCandidate = (value: string) => {
    setSelectedHost(value);
    setTestResult(null);
    setError(null);
  };

  const buildArgs = () => {
    if (!selectedCandidate) return null;
    const args: HostConfig = {
      id: slugify(selectedCandidate.id),
      label: (selectedCandidate.label || selectedCandidate.id).trim(),
      host: (selectedCandidate.host || selectedCandidate.id).trim(),
    };
    if (selectedCandidate.user?.trim()) {
      args.user = selectedCandidate.user.trim();
    }
    if (typeof selectedCandidate.port === "number") {
      args.port = selectedCandidate.port;
    }
    if (selectedCandidate.identityFile?.trim()) {
      args.identityFile = selectedCandidate.identityFile.trim();
    }
    return args;
  };

  const testConnection = async () => {
    const args = buildArgs();
    if (!args) {
      setError("Select an SSH config host first");
      return;
    }
    if (!args.id || !args.label || !args.host) {
      setError("Selected SSH config host is missing label, ID, or host");
      return;
    }
    if (args.id.includes(":")) {
      setError("ID cannot contain ':'");
      return;
    }
    setTesting(true);
    setError(null);
    setTestResult(null);
    try {
      const result = await invoke<HostStatus>("test_host", { args });
      setTestResult(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setTesting(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const args = buildArgs();
    if (!args) {
      setError("Select an SSH config host first");
      return;
    }
    if (!args.label) {
      setError("Label is required");
      return;
    }
    if (!args.id) {
      setError("ID is required");
      return;
    }
    if (!args.host) {
      setError("Host is required");
      return;
    }
    if (args.id.includes(":")) {
      setError("ID cannot contain ':'");
      return;
    }
    if (existingIds.includes(args.id)) {
      setError(`Host ID "${args.id}" already exists`);
      return;
    }
    if (typeof args.port === "number" && (args.port < 1 || args.port > 65535)) {
      setError("Port must be between 1 and 65535");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const hosts = await invoke<HostConfig[]>("add_host", { args });
      onAdded(hosts);
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="modal__title">add ssh host</div>
        <p className="modal__hint">
          Choose a host from your SSH config. To add a new target, add it to
          <code>~/.ssh/config</code> first.
        </p>

        <label className="field">
          <span className="field__label">ssh config</span>
          <MenuSelect
            ariaLabel="SSH host"
            value={selectedHost}
            options={hostOptions}
            onChange={applySshHostCandidate}
            disabled={busy || hostOptions.length === 0}
          />
        </label>

        {selectedCandidate ? (
          <div className="modal__hint">
            <div>ID: <code>{slugify(selectedCandidate.id)}</code></div>
            <div>Host: <code>{selectedCandidate.host || selectedCandidate.id}</code></div>
            {selectedCandidate.user && <div>User: <code>{selectedCandidate.user}</code></div>}
            <div>
              Port: <code>{displayPort}</code>
              {selectedPort === undefined && <span> (default)</span>}
            </div>
            {selectedCandidate.identityFile && (
              <div>Identity: <code>{selectedCandidate.identityFile}</code></div>
            )}
          </div>
        ) : (
          <div className="modal__hint modal__hint--error">
            No new SSH config hosts found. Add a host to <code>~/.ssh/config</code> first.
          </div>
        )}

        {testResult && (
          <div className={`modal__hint ${testResult.reachable ? "modal__hint--success" : "modal__hint--error"}`}>
            {testResult.reachable
              ? `Connected in ${testResult.latencyMs}ms`
              : `Failed: ${testResult.error ?? "Connection failed"}`}
            {testResult.reachable && (
              <div>
                Remote TW: {testResult.twAvailable ? `tw ${testResult.twVersion ?? "ok"}` : "not installed"}
              </div>
            )}
          </div>
        )}

        {error && <div className="modal__error">{error}</div>}

        <div className="modal__actions">
          <button
            type="button"
            className="btn btn--ghost"
            onClick={testConnection}
            disabled={busy || testing || !selectedCandidate}
          >
            {testing ? "testing..." : "test connection"}
          </button>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            className="btn btn--ghost"
            onClick={onClose}
            disabled={busy}
          >
            cancel
          </button>
          <button
            type="submit"
            className="btn btn--accent"
            disabled={busy || !selectedCandidate}
          >
            add host
          </button>
        </div>
      </form>
    </div>
  );
}
