import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type FeishuIntegrationStatus,
  type FeishuLarkProfile,
  useDashboardBackend,
} from "../../platform";
import { MenuSelect } from "../../MenuSelect";
import "./FeishuIntegrationSettings.css";

function botName(profile: FeishuLarkProfile): string {
  return profile.displayName?.trim() || profile.appId;
}

function brandName(brand: string): string {
  return brand === "lark" ? "Lark" : "Feishu";
}

export function FeishuIntegrationSettings() {
  const dashboardBackend = useDashboardBackend();
  const [status, setStatus] = useState<FeishuIntegrationStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [addingProfile, setAddingProfile] = useState(false);
  const [newAppId, setNewAppId] = useState("");
  const [newAppSecret, setNewAppSecret] = useState("");
  const [newBrand, setNewBrand] = useState<"feishu" | "lark">("feishu");

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await dashboardBackend.feishu.integrationStatus());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setBusy(false);
    }
  }, [dashboardBackend]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedProfile = status?.selectedProfile ?? "";
  const selected = useMemo(
    () => status?.profiles.find((profile) => profile.name === selectedProfile),
    [selectedProfile, status],
  );
  const overridden = status?.profileSource === "environment";
  const profileOptions = useMemo(() => {
    const profiles = status?.profiles ?? [];
    const options = [
      {
        value: "",
        label: status === null && busy
          ? "Loading bots…"
          : status?.profilesError
            ? "Bots unavailable"
            : profiles.length > 0
              ? "Choose a bot…"
              : "No bots added",
      },
      ...profiles.map((profile) => ({
        value: profile.name,
        label: botName(profile),
        detail: `${brandName(profile.brand)} · ${profile.appId}`,
      })),
    ];
    if (selectedProfile && !profiles.some((profile) => profile.name === selectedProfile)) {
      options.push({
        value: selectedProfile,
        label: "Selected bot unavailable",
        detail: "Check its local credentials",
      });
    }
    return options;
  }, [busy, selectedProfile, status]);

  const closeAddProfile = () => {
    setAddingProfile(false);
    setNewAppId("");
    setNewAppSecret("");
    setNewBrand("feishu");
  };

  const selectProfile = async (profile: string) => {
    if (!profile || profile === selectedProfile || busy || overridden) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    setWarning(null);
    try {
      const next = await dashboardBackend.feishu.selectProfile(profile);
      setStatus(next);
      setNotice("Bot selected.");
    } catch (selectError) {
      setError(selectError instanceof Error ? selectError.message : String(selectError));
    } finally {
      setBusy(false);
    }
  };

  const addProfile = async () => {
    const appId = newAppId.trim();
    if (!appId || !newAppSecret || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    setWarning(null);
    try {
      const result = await dashboardBackend.feishu.addProfile({
        appId,
        appSecret: newAppSecret,
        brand: newBrand,
      });
      let next = result.status;
      let selectionError: string | null = null;
      if (result.status.profileSource !== "environment") {
        try {
          next = await dashboardBackend.feishu.selectProfile(result.addedProfile);
        } catch (selectError) {
          selectionError = selectError instanceof Error ? selectError.message : String(selectError);
        }
      }
      setStatus(next);
      closeAddProfile();
      if (selectionError) {
        setError(selectionError);
        setWarning("Bot added, but the current selection was kept.");
      } else if (result.status.profileSource === "environment") {
        setWarning("Bot added. The environment override still chooses the active bot.");
      } else {
        setNotice("Bot added and selected.");
      }
      if (result.warning) setWarning(result.warning);
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : String(addError));
    } finally {
      setNewAppSecret("");
      setBusy(false);
    }
  };

  const removeProfile = async () => {
    if (!selected || busy || overridden) return;
    const displayName = botName(selected);
    const confirmed = await dashboardBackend.dialog.confirm({
      title: "Delete Feishu bot?",
      message: `Delete ${displayName} from this Mac? Its lark-cli credentials will be removed.`,
    });
    if (!confirmed) return;

    setBusy(true);
    setError(null);
    setNotice(null);
    setWarning(null);
    try {
      setStatus(await dashboardBackend.feishu.removeProfile(selected.name));
      setNotice("Bot deleted.");
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : String(removeError));
      try {
        setStatus(await dashboardBackend.feishu.integrationStatus());
      } catch {
        // Keep the deletion diagnostic; the next settings open retries status.
      }
    } finally {
      setBusy(false);
    }
  };

  const bridgeLabel = status === null
    ? "Loading"
    : status.bridgeRunning
      ? "Running"
      : selectedProfile
        ? "Stopped"
        : "Not selected";

  return (
    <div className="feishu-integration-settings">
      <section className="feishu-integration-settings__manager">
        <header className="feishu-integration-settings__heading">
          <div>
            <strong>Feishu bot</strong>
            <span>Choose the bot used for group bindings.</span>
          </div>
          <span
            className={`feishu-integration-settings__state${status?.bridgeRunning ? " feishu-integration-settings__state--running" : ""}`}
          >
            {bridgeLabel}
          </span>
        </header>

        <div className="feishu-integration-settings__controls">
          <MenuSelect
            ariaLabel="Feishu bot"
            value={selectedProfile}
            options={profileOptions}
            disabled={busy || overridden || Boolean(status?.profilesError)}
            className="feishu-integration-settings__profile"
            onChange={(value) => void selectProfile(value)}
          />
          <button
            className="settings-action-button"
            type="button"
            disabled={busy}
            onClick={() => {
              setAddingProfile((current) => !current);
              setError(null);
              setNotice(null);
              setWarning(null);
              if (addingProfile) closeAddProfile();
            }}
          >
            {addingProfile ? "Cancel" : "Add"}
          </button>
          <button
            className="settings-action-button feishu-integration-settings__delete"
            type="button"
            disabled={busy || overridden || !selected}
            onClick={() => void removeProfile()}
          >
            Delete
          </button>
        </div>
      </section>

      {overridden && (
        <p className="feishu-integration-settings__notice" role="status">
          TW_FEISHU_LARK_PROFILE controls the active bot for this Dashboard process.
        </p>
      )}
      {status?.profilesError && (
        <p className="feishu-integration-settings__error" role="alert">
          Could not load bot profiles: {status.profilesError}
        </p>
      )}
      {error && <p className="feishu-integration-settings__error" role="alert">{error}</p>}
      {warning && <p className="feishu-integration-settings__notice" role="status">{warning}</p>}
      {notice && <p className="feishu-integration-settings__success" role="status">{notice}</p>}

      {addingProfile && (
        <form
          className="feishu-integration-settings__add-form"
          onSubmit={(event) => {
            event.preventDefault();
            void addProfile();
          }}
        >
          <div className="feishu-integration-settings__add-heading">
            <strong>Add bot</strong>
            <span>The secret goes directly to lark-cli and is not stored by Dashboard.</span>
          </div>
          <div className="feishu-integration-settings__fields">
            <label>
              <span>App ID</span>
              <input
                value={newAppId}
                maxLength={256}
                autoComplete="off"
                spellCheck={false}
                placeholder="cli_…"
                onChange={(event) => setNewAppId(event.target.value)}
              />
            </label>
            <label>
              <span>App Secret</span>
              <input
                type="password"
                value={newAppSecret}
                maxLength={4096}
                autoComplete="new-password"
                spellCheck={false}
                onChange={(event) => setNewAppSecret(event.target.value)}
              />
            </label>
            <label>
              <span>Platform</span>
              <MenuSelect
                ariaLabel="Bot platform"
                value={newBrand}
                options={[
                  { value: "feishu", label: "Feishu" },
                  { value: "lark", label: "Lark" },
                ]}
                disabled={busy}
                onChange={(value) => setNewBrand(value === "lark" ? "lark" : "feishu")}
              />
            </label>
          </div>
          <div className="feishu-integration-settings__add-actions">
            <button className="settings-action-button" type="button" disabled={busy} onClick={closeAddProfile}>
              Cancel
            </button>
            <button
              className="settings-action-button feishu-integration-settings__primary"
              type="submit"
              disabled={busy || !newAppId.trim() || !newAppSecret}
            >
              {busy ? "Adding…" : "Add bot"}
            </button>
          </div>
        </form>
      )}

      <p className="feishu-integration-settings__footnote">
        Change or delete the bot after unlinking all Feishu groups.
      </p>
    </div>
  );
}
