use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::ffi::{CStr, OsStr};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{Manager, State};

use super::management_child::{
    ManagementBootstrapSecretMode, ManagementChildSelection, ManagementError, ManagementLaunchKey,
    ManagementOutcome, ManagementPreparedFileIdentity, ManagementStartError,
};
use super::{
    MobileRelayV2ManagementCommandState, MobileRelayV2ManagementOperation,
    SelfHostedConnectorRepair,
};
use crate::config::find_host;
use crate::features::control_plane::{scp_cli_to_host, scp_directory_to_host};
use crate::remote::{
    remote_tmux_cmd, run_remote_cmd_check_strings, run_remote_cmd_output,
    run_remote_cmd_with_input, HostConfig,
};
use crate::support::{app_home_dir, atomic_write_file, shell_quote};

const CONFIG_CONTRACT: &str = "tmux-worktree-dashboard-relay-v2-self-hosted";
const CONFIG_SCHEMA_VERSION: u32 = 7;
const LEGACY_CONFIG_SCHEMA_VERSION: u32 = 1;
const HOST_PROFILE_CONFIG_SCHEMA_VERSION: u32 = 2;
const ROTATION_PENDING_CONFIG_SCHEMA_VERSION: u32 = 3;
const ROTATION_RECEIPT_CONFIG_SCHEMA_VERSION: u32 = 4;
const BOOTSTRAP_CORRELATION_CONFIG_SCHEMA_VERSION: u32 = 5;
const CONNECTOR_DESIRED_STATE_CONFIG_SCHEMA_VERSION: u32 = 6;
const REMOTE_PROFILE_SCHEMA_VERSION: u32 = 1;
const FEATURE_KIND: &str = "explicit_self_hosted";
const CENTER_SESSION: &str = "tw-relay-v2-center";
const REMOTE_ROOT: &str = ".tmux-worktree/relay-v2-self-hosted";
/// Records the bundle version the live Center process was started from.
/// Written atomically by the center-start script right after the tmux session
/// comes up (the launcher execs `current/cli.cjs`, so this is the code the
/// process actually runs), and removed by the center-stop script. The probe
/// reads it to detect a Center still running an older bundle after a Deploy
/// swapped the `current` symlink.
const REMOTE_CENTER_RUNNING_VERSION_FILE: &str = "center.running-version";
const REMOTE_TLS_KEY: &str = ".tmux-worktree/relay-v2-self-hosted/tls/tls.key";
const REMOTE_TLS_CERTIFICATE: &str = ".tmux-worktree/relay-v2-self-hosted/tls/tls.crt";
const REMOTE_TLS_CA: &str = ".tmux-worktree/relay-v2-self-hosted/tls/ca.pem";
const REMOTE_PROFILE: &str = ".tmux-worktree/relay-v2-self-hosted/deployment-profile-v1.json";
const REMOTE_STATE_DIRECTORY: &str = ".tmux-worktree/relay-v2-self-hosted/state";
const MAX_BOOTSTRAP_RAW_BYTES: usize = 8_193;
const MAX_TLS_FILE_BYTES: u64 = 1024 * 1024;
const LOCAL_NATIVE_CREDENTIAL_DIRECTORY: &str = "relay-v2-host-credential-atomic-file-cell-v1";
const LOCAL_HOST_PROFILE_INPUT: &str = "host-production-profile-input-v1.json";
const LOCAL_HOST_CA_INPUT: &str = "host-tls-ca-input.pem";
const LOCAL_READY_COMMIT_JOURNAL: &str = "management-ready-commit-journal-v1.json";
const READY_COMMIT_JOURNAL_CONTRACT: &str =
    "tmux-worktree-dashboard-relay-v2-management-ready-commit";
const READY_COMMIT_JOURNAL_SCHEMA_VERSION: u32 = 2;
const CONNECTOR_WATCHDOG_INITIAL_DELAY: Duration = Duration::from_secs(1);
const CONNECTOR_WATCHDOG_HEALTHY_INTERVAL: Duration = Duration::from_secs(2);
const CONNECTOR_WATCHDOG_MAX_RETRY_DELAY: Duration = Duration::from_secs(15);
/// A live child whose connector cut stays retryable for this long is given one
/// bounded stall escalation (a forced rebuild) even though its own composition
/// retry loop nominally owns the cut. This is the safety net for an unknown
/// wedge (e.g. the child alive but its rescan loop stuck): rebuilds on
/// consecutive escalations can never land closer together than this.
const CONNECTOR_WATCHDOG_STALL_REBUILD_AFTER: Duration = Duration::from_secs(600);

/// Public trust anchor: the self-signed ISRG Root X1 certificate.
///
/// acme.sh's Let's Encrypt chain served by the devbox (leaf issuer chain
/// YE2 <- Root YE <- ISRG Root X1 cross-signed by ISRG Root X1) omits the
/// self-signed ISRG Root X1 anchor. Because Node's TLS `ca:` option REPLACES
/// the system trust store, the runtime CA file must be a self-contained chain
/// ending in this root; otherwise Node fails with UNABLE_TO_GET_ISSUER_CERT.
/// `ensure_self_contained_ca_chain` appends this anchor at the write site in
/// `verify_external_tls_and_fetch_chain` so every Deploy produces a complete
/// chain. This is public trust-anchor data (from the macOS system roots
/// keychain), NOT a secret — embedding it is intended.
const ISRG_ROOT_X1_PEM: &str = r#"-----BEGIN CERTIFICATE-----
MIIFazCCA1OgAwIBAgIRAIIQz7DSQONZRGPgu2OCiwAwDQYJKoZIhvcNAQELBQAw
TzELMAkGA1UEBhMCVVMxKTAnBgNVBAoTIEludGVybmV0IFNlY3VyaXR5IFJlc2Vh
cmNoIEdyb3VwMRUwEwYDVQQDEwxJU1JHIFJvb3QgWDEwHhcNMTUwNjA0MTEwNDM4
WhcNMzUwNjA0MTEwNDM4WjBPMQswCQYDVQQGEwJVUzEpMCcGA1UEChMgSW50ZXJu
ZXQgU2VjdXJpdHkgUmVzZWFyY2ggR3JvdXAxFTATBgNVBAMTDElTUkcgUm9vdCBY
MTCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBAK3oJHP0FDfzm54rVygc
h77ct984kIxuPOZXoHj3dcKi/vVqbvYATyjb3miGbESTtrFj/RQSa78f0uoxmyF+
0TM8ukj13Xnfs7j/EvEhmkvBioZxaUpmZmyPfjxwv60pIgbz5MDmgK7iS4+3mX6U
A5/TR5d8mUgjU+g4rk8Kb4Mu0UlXjIB0ttov0DiNewNwIRt18jA8+o+u3dpjq+sW
T8KOEUt+zwvo/7V3LvSye0rgTBIlDHCNAymg4VMk7BPZ7hm/ELNKjD+Jo2FR3qyH
B5T0Y3HsLuJvW5iB4YlcNHlsdu87kGJ55tukmi8mxdAQ4Q7e2RCOFvu396j3x+UC
B5iPNgiV5+I3lg02dZ77DnKxHZu8A/lJBdiB3QW0KtZB6awBdpUKD9jf1b0SHzUv
KBds0pjBqAlkd25HN7rOrFleaJ1/ctaJxQZBKT5ZPt0m9STJEadao0xAH0ahmbWn
OlFuhjuefXKnEgV4We0+UXgVCwOPjdAvBbI+e0ocS3MFEvzG6uBQE3xDk3SzynTn
jh8BCNAw1FtxNrQHusEwMFxIt4I7mKZ9YIqioymCzLq9gwQbooMDQaHWBfEbwrbw
qHyGO0aoSCqI3Haadr8faqU9GY/rOPNk3sgrDQoo//fb4hVC1CLQJ13hef4Y53CI
rU7m2Ys6xt0nUW7/vGT1M0NPAgMBAAGjQjBAMA4GA1UdDwEB/wQEAwIBBjAPBgNV
HRMBAf8EBTADAQH/MB0GA1UdDgQWBBR5tFnme7bl5AFzgAiIyBpY9umbbjANBgkq
hkiG9w0BAQsFAAOCAgEAVR9YqbyyqFDQDLHYGmkgJykIrGF1XIpu+ILlaS/V9lZL
ubhzEFnTIZd+50xx+7LSYK05qAvqFyFWhfFQDlnrzuBZ6brJFe+GnY+EgPbk6ZGQ
3BebYhtF8GaV0nxvwuo77x/Py9auJ/GpsMiu/X1+mvoiBOv/2X/qkSsisRcOj/KK
NFtY2PwByVS5uCbMiogziUwthDyC3+6WVwW6LLv3xLfHTjuCvjHIInNzktHCgKQ5
ORAzI4JMPJ+GslWYHb4phowim57iaztXOoJwTdwJx4nLCgdNbOhdjsnvzqvHu7Ur
TkXWStAmzOVyyghqpZXjFaH3pO3JLF+l+/+sKAIuvtd7u+Nxe5AW0wdeRlN8NwdC
jNPElpzVmbUq4JUagEiuTDkHzsxHpFKVK7q4+63SM1N95R1NbdWhscdCb+ZAJzVc
oyi3B43njTOQ5yOf+1CceWxG1bQVs5ZufpsMljq4Ui0/1lvh+wjChP4kqKOJ2qxq
4RgqsahDYVvTH9w7jXbyLeiNdd8XM2w9U/t7y0Ff/9yi0GE44Za4rF2LN9d11TPA
mRGunUHBcnWEvgJBQl9nJEiU0Zsnvgc/ubhPgXRR4Xq37Z0j4r7g1SgEEzwxA57d
emyPxgcYxn/eR44/KJ4EBs+lVDR3veyJm+kXQ99b21/+jh5Xos1AnX5iItreGCc=
-----END CERTIFICATE-----"#;

const REMOTE_SECURITY_FUNCTIONS: &str = r#"LC_ALL=C
export LC_ALL
uid="$(id -u)"
require_linux_x86_64() {
  test "$(uname -s)" = "Linux"
  test "$(uname -m)" = "x86_64"
  mv --version 2>/dev/null | grep -Fq "GNU coreutils"
  test -x /usr/bin/realpath
  /usr/bin/realpath --version 2>/dev/null | grep -Fq "GNU coreutils"
}
require_self_hosted_node() {
  /usr/bin/env node -e '
const [major, minor] = process.versions.node.split(".").map(Number);
if (
  !Number.isInteger(major) ||
  !Number.isInteger(minor) ||
  !(major > 22 || (major === 22 && minor >= 16))
) process.exit(1);
'
}
require_parent_dir() {
  path="$1"
  test ! -L "$path"
  test -d "$path"
  test "$(stat -c %F -- "$path")" = "directory"
  test "$(stat -c %u -- "$path")" = "$uid"
  mode="$(stat -c %a -- "$path")"
  test $((0$mode & 022)) -eq 0
}
require_private_dir() {
  path="$1"
  test ! -L "$path"
  test -d "$path"
  test "$(stat -c %F -- "$path")" = "directory"
  test "$(stat -c %u -- "$path")" = "$uid"
  test "$(stat -c %a -- "$path")" = "700"
}
ensure_parent_dir() {
  path="$1"
  if test -e "$path" || test -L "$path"; then
    require_parent_dir "$path"
  else
    mkdir -- "$path"
    chmod 700 "$path"
    require_parent_dir "$path"
  fi
}
ensure_private_dir() {
  path="$1"
  if test -e "$path" || test -L "$path"; then
    require_private_dir "$path"
  else
    mkdir -- "$path"
    chmod 700 "$path"
    require_private_dir "$path"
  fi
}
require_private_file() {
  path="$1"
  test ! -L "$path"
  test -f "$path"
  test "$(stat -c %F -- "$path")" = "regular file"
  test "$(stat -c %u -- "$path")" = "$uid"
  test "$(stat -c %a -- "$path")" = "600"
  test "$(stat -c %h -- "$path")" = "1"
}
require_private_executable() {
  path="$1"
  test ! -L "$path"
  test -f "$path"
  test "$(stat -c %F -- "$path")" = "regular file"
  test "$(stat -c %u -- "$path")" = "$uid"
  test "$(stat -c %a -- "$path")" = "700"
  test "$(stat -c %h -- "$path")" = "1"
}
ensure_relay_layout() {
  require_linux_x86_64
  require_self_hosted_node
  ensure_parent_dir "$HOME/.tmux-worktree"
  ensure_private_dir "$HOME/.tmux-worktree/relay-v2-self-hosted"
  ensure_private_dir "$HOME/.tmux-worktree/relay-v2-self-hosted/bundles"
  ensure_private_dir "$HOME/.tmux-worktree/relay-v2-self-hosted/tls"
  ensure_private_dir "$HOME/.tmux-worktree/relay-v2-self-hosted/state"
  ensure_private_dir "$HOME/.tmux-worktree/relay-v2-self-hosted/bootstrap"
}
require_relay_layout() {
  require_linux_x86_64
  require_self_hosted_node
  require_parent_dir "$HOME/.tmux-worktree"
  require_private_dir "$HOME/.tmux-worktree/relay-v2-self-hosted"
  require_private_dir "$HOME/.tmux-worktree/relay-v2-self-hosted/bundles"
  require_private_dir "$HOME/.tmux-worktree/relay-v2-self-hosted/tls"
  require_private_dir "$HOME/.tmux-worktree/relay-v2-self-hosted/state"
  require_private_dir "$HOME/.tmux-worktree/relay-v2-self-hosted/bootstrap"
}
require_bundle_tree_shape() {
  tree="$1"
  test ! -L "$tree"
  test -d "$tree"
  test -z "$(find "$tree" -xdev \( -type l -o \( ! -type d ! -type f \) \) -print -quit)"
  test -z "$(find "$tree" -xdev ! -uid "$uid" -print -quit)"
  test -z "$(find "$tree" -xdev -type f -links +1 -print -quit)"
}
normalize_bundle_tree() {
  tree="$1"
  require_bundle_tree_shape "$tree"
  find "$tree" -xdev -type d -exec chmod 700 {} +
  find "$tree" -xdev -type f -exec chmod 600 {} +
}
require_bundle_tree() {
  tree="$1"
  require_bundle_tree_shape "$tree"
  test -z "$(find "$tree" -xdev -type d ! -perm 0700 -print -quit)"
  test -z "$(find "$tree" -xdev -type f ! -perm 0600 -print -quit)"
}
require_current_bundle() {
  root="$HOME/.tmux-worktree/relay-v2-self-hosted"
  current="$root/current"
  test -L "$current"
  test "$(stat -c %u -- "$current")" = "$uid"
  target="$(readlink -- "$current")"
  case "$target" in
    bundles/dashboard-*) ;;
    *) return 1 ;;
  esac
  case "$target" in
    /*|../*|*/../*|*/..) return 1 ;;
  esac
  require_bundle_tree "$root/$target"
  require_private_file "$root/$target/cli.cjs"
  require_private_file "$root/$target/package.json"
}
"#;

fn build_remote_state_directory_launcher_preflight() -> String {
    format!(
        r#"relay_v2_state_alias="$HOME/{REMOTE_STATE_DIRECTORY}"
require_private_dir "$relay_v2_state_alias"
relay_v2_state_directory="$(/usr/bin/realpath -e -- "$relay_v2_state_alias")"
case "$relay_v2_state_directory" in
  /*) ;;
  *) exit 1 ;;
esac
test "$(/usr/bin/realpath -e -- "$relay_v2_state_directory")" = "$relay_v2_state_directory"
require_private_dir "$relay_v2_state_directory"
test "$(stat -c %d:%i -- "$relay_v2_state_alias")" = "$(stat -c %d:%i -- "$relay_v2_state_directory")"
"#
    )
}

// Node >=22 delegates fs.openSync to libuv, which always applies close-on-exec
// to returned descriptors. The helper adds O_NOFOLLOW itself and performs both
// validation passes plus the bounded read against that single descriptor.
const REMOTE_BOOTSTRAP_FD_READER: &str = r#"const fs = require("node:fs");
const [major, minor] = process.versions.node.split(".").map(Number);
if (
  !Number.isInteger(major) ||
  !Number.isInteger(minor) ||
  !(major > 22 || (major === 22 && minor >= 16))
) throw new Error("NODE_22_16_REQUIRED");
const path = process.argv[2];
const maximum = Number(process.argv[3]);
if (!path || !Number.isSafeInteger(maximum) || maximum < 1) throw new Error("INVALID_INPUT");
const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;
let fd;
try {
  fd = fs.openSync(path, flags);
  const before = fs.fstatSync(fd, { bigint: true });
  const uid = BigInt(process.getuid());
  const valid = (value) =>
    value.isFile() &&
    value.uid === uid &&
    value.nlink === 1n &&
    (value.mode & 0o7777n) === 0o600n &&
    value.size > 0n &&
    value.size <= BigInt(maximum);
  if (!valid(before)) throw new Error("UNSAFE_BOOTSTRAP");
  const output = Buffer.alloc(Number(before.size));
  let offset = 0;
  while (offset < output.length) {
    const count = fs.readSync(fd, output, offset, output.length - offset, offset);
    if (count === 0) throw new Error("SHORT_BOOTSTRAP");
    offset += count;
  }
  const after = fs.fstatSync(fd, { bigint: true });
  if (
    !valid(after) ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mode !== after.mode ||
    before.uid !== after.uid ||
    before.nlink !== after.nlink
  ) throw new Error("CHANGED_BOOTSTRAP");
  fs.writeSync(1, output);
} finally {
  if (fd !== undefined) fs.closeSync(fd);
}
"#;

// Keep every Broker-branch-owned CLI spelling in this block. The renderer and
// the deployment lifecycle never assemble Relay arguments independently.
const SELF_HOSTED_FLAG: &str = "--v2-single-node-self-hosted";
const AGENT_TRANSCRIPT_LIFECYCLE_FLAG: &str = "--v2-agent-transcript-lifecycle-v1";
const AGENT_CHAT_FLAG: &str = "--v2-agent-chat-v2";
const LARK_BINDINGS_FLAG: &str = "--v2-lark-bindings-v2";
const ADVERTISED_ORIGIN_FLAG: &str = "--v2-dev-advertised-origin";
const TLS_KEY_FLAG: &str = "--v2-dev-tls-key";
const TLS_CERTIFICATE_FLAG: &str = "--v2-dev-tls-cert";
const STATE_DIRECTORY_FLAG: &str = "--v2-self-hosted-state-dir";
const BOOTSTRAP_CORRELATION_FLAG: &str = "--v2-self-hosted-bootstrap-correlation";

pub(crate) struct MobileRelayV2SelfHostedDeploymentState {
    operation: Mutex<SelfHostedDeploymentOperationOwner>,
}

#[derive(Default)]
struct SelfHostedDeploymentOperationOwner {
    active_management: Option<SelfHostedManagementBinding>,
    startup_restore_error: Option<String>,
}

impl Default for MobileRelayV2SelfHostedDeploymentState {
    fn default() -> Self {
        Self {
            operation: Mutex::new(SelfHostedDeploymentOperationOwner::default()),
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MobileRelayV2SelfHostedConfigInput {
    enabled: bool,
    broker_host_id: String,
    issuer_url: String,
    listen_host: String,
    listen_port: u16,
    tls_key_path: String,
    tls_certificate_path: String,
    tls_ca_path: String,
    #[serde(default)]
    external_tls_management: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedSelfHostedConfig {
    contract: String,
    schema_version: u32,
    enabled: bool,
    broker_host_id: String,
    issuer_url: String,
    listen_host: String,
    listen_port: u16,
    tls_key_path: String,
    tls_certificate_path: String,
    tls_ca_path: String,
    #[serde(default)]
    external_tls_management: bool,
    #[serde(default)]
    host_profile_identity: String,
    #[serde(default)]
    profile_provisioned: bool,
    #[serde(default)]
    host_credential_provisioned: bool,
    #[serde(default)]
    connector_desired_running: bool,
    #[serde(default)]
    management_recovery_required: bool,
    #[serde(default)]
    bootstrap_rotation_pending: bool,
    #[serde(default)]
    bootstrap_rotation_request_phase: Option<BootstrapRotationRequestPhase>,
    #[serde(default)]
    bootstrap_rotation_transfer_receipt: Option<BootstrapRotationTransferReceipt>,
    bootstrap_file_name: Option<String>,
    #[serde(default)]
    bootstrap_publication_correlation: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BootstrapRotationTransferReceipt {
    profile_lineage: String,
    bootstrap_file_name: String,
    #[serde(default)]
    bootstrap_publication_correlation: String,
    local_identity: LocalPrivateFileIdentity,
    phase: BootstrapRotationTransferPhase,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum BootstrapRotationTransferPhase {
    RemoteCleanupPending,
    Ready,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum BootstrapRotationRequestPhase {
    UnverifiedLegacy,
    Requested,
    CenterStopped,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MobileRelayV2SelfHostedConfigProjection {
    enabled: bool,
    broker_host_id: String,
    issuer_url: String,
    listen_host: String,
    listen_port: u16,
    tls_key_path: String,
    tls_certificate_path: String,
    tls_ca_path: String,
    external_tls_management: bool,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum DeploymentProbeStatus {
    Missing,
    Ready,
    Running,
    Stopped,
    Unknown,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MobileRelayV2SelfHostedStatus {
    feature: String,
    configured: bool,
    config: Option<MobileRelayV2SelfHostedConfigProjection>,
    bundle_status: DeploymentProbeStatus,
    tls_status: DeploymentProbeStatus,
    center_status: DeploymentProbeStatus,
    host_bootstrap_available: bool,
    host_bootstrap_pending: bool,
    host_credential_provisioned: bool,
    profile_provisioned: bool,
    connector_desired_running: bool,
    effective: bool,
    bootstrap_rotation_pending: bool,
    remote_tls_key_path: String,
    remote_tls_certificate_path: String,
    remote_tls_ca_path: String,
    remote_profile_path: String,
    remote_state_directory: String,
    /// Bundle version the live remote Center process was started from, read
    /// from `center.running-version` during the probe. `None` for a stopped
    /// center or one started by an older Dashboard that never wrote the file.
    running_bundle_version: Option<String>,
    /// True while a running Center is not on this Dashboard's bundle version
    /// (including a Center started before version tracking existed): Deploy
    /// restarts it onto the new code.
    center_version_stale: bool,
    /// The bundle version this Dashboard ships and deploys.
    dashboard_bundle_version: String,
    error: Option<String>,
}

struct CanonicalBundleSource {
    directory: PathBuf,
    package_json: PathBuf,
}

struct LocalPrivateFile {
    path: PathBuf,
    bytes: Vec<u8>,
    identity: LocalPrivateFileIdentity,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
struct LocalPrivateFileIdentity {
    device: u64,
    inode: u64,
    length: u64,
    mode: u32,
    uid: u32,
    links: u64,
    sha256: [u8; 32],
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadyCommitJournal {
    contract: String,
    schema_version: u32,
    profile_lineage: String,
    bootstrap_file_name: Option<String>,
    #[serde(default)]
    bootstrap_publication_correlation: Option<String>,
    bootstrap_identity: Option<LocalPrivateFileIdentity>,
    provision_profile_identity: Option<LocalPrivateFileIdentity>,
}

impl From<LocalPrivateFileIdentity> for ManagementPreparedFileIdentity {
    fn from(identity: LocalPrivateFileIdentity) -> Self {
        Self {
            device: identity.device,
            inode: identity.inode,
            length: identity.length,
            mode: identity.mode,
            uid: identity.uid,
            links: identity.links,
            sha256: identity.sha256,
        }
    }
}

pub(crate) struct PreparedSelfHostedManagementLaunch {
    config: PersistedSelfHostedConfig,
    selection: ManagementChildSelection,
    bootstrap_identity: Option<LocalPrivateFileIdentity>,
    provision_profile_identity: Option<LocalPrivateFileIdentity>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SelfHostedManagementBinding {
    persisted_config_identity: [u8; 32],
    steady_launch_key: ManagementLaunchKey,
}

impl PreparedSelfHostedManagementLaunch {
    pub(crate) fn selection(&self) -> ManagementChildSelection {
        self.selection.clone()
    }

    pub(crate) fn management_binding(&self) -> Result<SelfHostedManagementBinding, String> {
        let mut expected = self.config.clone();
        if self.bootstrap_identity.is_some() {
            let bootstrap_file_name = expected.bootstrap_file_name.clone();
            let bootstrap_publication_correlation =
                expected.bootstrap_publication_correlation.clone();
            commit_bootstrap_ready_state(
                &mut expected,
                &bootstrap_file_name,
                &bootstrap_publication_correlation,
            )?;
        }
        if self.provision_profile_identity.is_some() {
            expected.profile_provisioned = true;
        }
        expected.management_recovery_required = false;
        Ok(SelfHostedManagementBinding {
            persisted_config_identity: persisted_management_config_identity(&expected)?,
            steady_launch_key: self.selection.steady_launch_key(),
        })
    }

    pub(crate) fn commit_ready(mut self) -> Result<(), String> {
        let journal = ReadyCommitJournal {
            contract: READY_COMMIT_JOURNAL_CONTRACT.to_string(),
            schema_version: READY_COMMIT_JOURNAL_SCHEMA_VERSION,
            profile_lineage: self.config.host_profile_identity.clone(),
            bootstrap_file_name: self.config.bootstrap_file_name.clone(),
            bootstrap_publication_correlation: self
                .config
                .bootstrap_publication_correlation
                .clone(),
            bootstrap_identity: self.bootstrap_identity.clone(),
            provision_profile_identity: self.provision_profile_identity.clone(),
        };
        let journal_identity = match write_ready_commit_journal(&journal) {
            Ok(identity) => identity,
            Err(error) => {
                self.config.management_recovery_required = true;
                save_config(&self.config)?;
                return Err(error);
            }
        };
        self.config.management_recovery_required = true;
        save_config(&self.config)?;
        if let Some(expected) = self.bootstrap_identity.take() {
            consume_local_private_file(
                &local_bootstrap_path(&self.config)?,
                &expected,
                MAX_BOOTSTRAP_RAW_BYTES as u64,
                "Relay v2 Host bootstrap input",
            )?;
            commit_bootstrap_ready_state(
                &mut self.config,
                &journal.bootstrap_file_name,
                &journal.bootstrap_publication_correlation,
            )?;
        }
        if let Some(expected) = self.provision_profile_identity.take() {
            consume_local_private_file(
                &local_host_profile_input_path()?,
                &expected,
                16 * 1024,
                "Relay v2 Host provision profile input",
            )?;
            self.config.profile_provisioned = true;
        }
        self.config.management_recovery_required = false;
        save_config(&self.config)?;
        consume_local_private_file(
            &local_ready_commit_journal_path()?,
            &journal_identity,
            16 * 1024,
            "Relay v2 management ready commit journal",
        )?;
        Ok(())
    }
}

impl SelfHostedManagementBinding {
    fn matches_config(&self, config: &PersistedSelfHostedConfig) -> bool {
        persisted_management_config_identity(config)
            .is_ok_and(|identity| identity == self.persisted_config_identity)
    }
}

fn revalidate_current_management_binding(
    expected: &SelfHostedManagementBinding,
) -> Result<PersistedSelfHostedConfig, String> {
    let prepared = prepare_relay_v2_self_hosted_management_prerequisites()?
        .ok_or("Relay v2 self-hosted management configuration disappeared")?;
    if prepared.management_binding()? != *expected {
        return Err("Relay v2 self-hosted management binding changed".to_string());
    }
    let config =
        load_config()?.ok_or("Relay v2 self-hosted management configuration disappeared")?;
    if !expected.matches_config(&config) {
        return Err("Relay v2 self-hosted management binding changed".to_string());
    }
    Ok(config)
}

impl MobileRelayV2SelfHostedDeploymentState {
    pub(crate) fn publish_self_hosted_management_binding(
        &self,
        binding: SelfHostedManagementBinding,
    ) -> Result<(), String> {
        let mut owner = self
            .operation
            .lock()
            .map_err(|_| "Relay v2 deployment owner is unavailable".to_string())?;
        owner.active_management = Some(binding);
        owner.startup_restore_error = None;
        Ok(())
    }
}

trait AccountHomeResolver {
    fn resolve(&self, uid: u32) -> Result<PathBuf, String>;
}

struct SystemAccountHomeResolver;

#[cfg(unix)]
impl AccountHomeResolver for SystemAccountHomeResolver {
    fn resolve(&self, uid: u32) -> Result<PathBuf, String> {
        let initial = unsafe { libc::sysconf(libc::_SC_GETPW_R_SIZE_MAX) };
        let mut capacity = if initial > 0 {
            usize::try_from(initial).unwrap_or(16 * 1024)
        } else {
            16 * 1024
        }
        .clamp(1024, 1024 * 1024);
        loop {
            let mut entry = std::mem::MaybeUninit::<libc::passwd>::zeroed();
            let mut result = std::ptr::null_mut();
            let mut buffer = vec![0_u8; capacity];
            // SAFETY: entry and buffer remain live for the call, result is an
            // out pointer, and uid is the already-validated real account uid.
            let status = unsafe {
                libc::getpwuid_r(
                    uid,
                    entry.as_mut_ptr(),
                    buffer.as_mut_ptr().cast(),
                    buffer.len(),
                    &mut result,
                )
            };
            if status == libc::ERANGE && capacity < 1024 * 1024 {
                capacity = (capacity * 2).min(1024 * 1024);
                continue;
            }
            if status != 0 || result.is_null() {
                return Err("Dashboard account home is unavailable".to_string());
            }
            // SAFETY: getpwuid_r succeeded and its returned fields point into
            // the still-live buffer.
            let entry = unsafe { entry.assume_init() };
            if entry.pw_dir.is_null() {
                return Err("Dashboard account home is unavailable".to_string());
            }
            // SAFETY: POSIX passwd string fields are NUL-terminated.
            let bytes = unsafe { CStr::from_ptr(entry.pw_dir) }.to_bytes();
            if bytes.is_empty() || bytes.contains(&0) {
                return Err("Dashboard account home is unavailable".to_string());
            }
            use std::os::unix::ffi::OsStrExt;
            return Ok(PathBuf::from(OsStr::from_bytes(bytes)));
        }
    }
}

#[cfg(not(unix))]
impl AccountHomeResolver for SystemAccountHomeResolver {
    fn resolve(&self, _uid: u32) -> Result<PathBuf, String> {
        Err("Relay v2 self-hosted setup is unsupported on this platform".to_string())
    }
}

fn self_hosted_account_home_with(
    resolver: &dyn AccountHomeResolver,
    inherited_home: Option<&OsStr>,
) -> Result<PathBuf, String> {
    let (uid, _) = current_account_ids()?;
    let raw = resolver.resolve(uid)?;
    if !raw.is_absolute() {
        return Err("Dashboard account home is unsafe".to_string());
    }
    let canonical = std::fs::canonicalize(&raw)
        .map_err(|_| "Dashboard account home is unavailable".to_string())?;
    validate_account_home(&canonical)?;
    if let Some(inherited) = inherited_home.filter(|value| !value.is_empty()) {
        let inherited = std::fs::canonicalize(PathBuf::from(inherited))
            .map_err(|_| "HOME does not match the current account home".to_string())?;
        if inherited != canonical {
            return Err("HOME does not match the current account home".to_string());
        }
    }
    Ok(canonical)
}

fn self_hosted_account_home() -> Result<PathBuf, String> {
    let inherited = std::env::var_os("HOME");
    self_hosted_account_home_with(&SystemAccountHomeResolver, inherited.as_deref())
}

fn dashboard_config_home() -> Result<PathBuf, String> {
    app_home_dir().ok_or_else(|| "Dashboard configuration home is unavailable".to_string())
}

fn config_path() -> Result<PathBuf, String> {
    Ok(dashboard_config_home()?
        .join(".tmux-worktree")
        .join("relay-v2-self-hosted")
        .join("dashboard-config-v1.json"))
}

fn local_bootstrap_directory() -> Result<PathBuf, String> {
    Ok(self_hosted_account_home()?
        .join(".tmux-worktree")
        .join("relay-v2-self-hosted")
        .join("private"))
}

fn local_native_credential_directory() -> Result<PathBuf, String> {
    Ok(self_hosted_account_home()?
        .join(".tmux-worktree")
        .join(LOCAL_NATIVE_CREDENTIAL_DIRECTORY))
}

fn local_host_profile_input_path() -> Result<PathBuf, String> {
    Ok(local_bootstrap_directory()?.join(LOCAL_HOST_PROFILE_INPUT))
}

fn local_host_ca_input_path() -> Result<PathBuf, String> {
    Ok(local_bootstrap_directory()?.join(LOCAL_HOST_CA_INPUT))
}

fn local_ready_commit_journal_path() -> Result<PathBuf, String> {
    Ok(local_bootstrap_directory()?.join(LOCAL_READY_COMMIT_JOURNAL))
}

fn local_bootstrap_path(config: &PersistedSelfHostedConfig) -> Result<PathBuf, String> {
    let name = config
        .bootstrap_file_name
        .as_deref()
        .ok_or("Relay v2 Host bootstrap has not been requested")?;
    Ok(local_bootstrap_directory()?.join(name))
}

fn validate_owned_directory(path: &Path, exact_mode: u32) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("inspect private directory: {error}"))?;
    if !metadata.file_type().is_dir() {
        return Err("Relay v2 private directory is unsafe".to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let (expected_uid, expected_gid) = current_account_ids()?;
        if metadata.uid() != expected_uid
            || metadata.gid() != expected_gid
            || metadata.mode() & 0o7777 != exact_mode
        {
            return Err("Relay v2 private directory is unsafe".to_string());
        }
    }
    Ok(())
}

fn ensure_owned_directory(path: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => validate_owned_directory(path, 0o700),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                let mut builder = std::fs::DirBuilder::new();
                builder.mode(0o700);
                builder
                    .create(path)
                    .map_err(|error| format!("create Relay v2 private directory: {error}"))?;
            }
            #[cfg(not(unix))]
            {
                std::fs::create_dir(path)
                    .map_err(|error| format!("create Relay v2 private directory: {error}"))?;
            }
            validate_owned_directory(path, 0o700)
        }
        Err(error) => Err(format!("inspect Relay v2 private directory: {error}")),
    }
}

fn ensure_dashboard_config_private_tree() -> Result<(), String> {
    let home = dashboard_config_home()?;
    validate_account_home(&home)?;
    let root = home.join(".tmux-worktree");
    ensure_owned_directory(&root)?;
    let deployment = root.join("relay-v2-self-hosted");
    ensure_owned_directory(&deployment)
}

fn ensure_local_host_private_tree() -> Result<(), String> {
    let home = self_hosted_account_home()?;
    validate_account_home(&home)?;
    let root = home.join(".tmux-worktree");
    ensure_owned_directory(&root)?;
    let deployment = root.join("relay-v2-self-hosted");
    ensure_owned_directory(&deployment)?;
    ensure_owned_directory(&deployment.join("private"))
}

fn ensure_local_native_credential_directory() -> Result<(), String> {
    let home = self_hosted_account_home()?;
    validate_account_home(&home)?;
    let root = home.join(".tmux-worktree");
    ensure_owned_directory(&root)?;
    ensure_owned_directory(&local_native_credential_directory()?)
}

fn secure_bootstrap_file(path: &Path) -> bool {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return false;
    };
    if !metadata.file_type().is_file()
        || metadata.len() == 0
        || metadata.len() > MAX_BOOTSTRAP_RAW_BYTES as u64
    {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let Ok((expected_uid, expected_gid)) = current_account_ids() else {
            return false;
        };
        if metadata.uid() != expected_uid
            || metadata.gid() != expected_gid
            || metadata.mode() & 0o7777 != 0o600
            || metadata.nlink() != 1
        {
            return false;
        }
    }
    true
}

#[cfg(unix)]
fn current_account_ids() -> Result<(u32, u32), String> {
    // SAFETY: these libc accessors have no preconditions and do not mutate
    // process state.
    let (uid, effective_uid, gid, effective_gid) = unsafe {
        (
            libc::getuid(),
            libc::geteuid(),
            libc::getgid(),
            libc::getegid(),
        )
    };
    if uid == 0 || uid != effective_uid || gid != effective_gid {
        return Err("Relay v2 self-hosted setup requires an unprivileged current user".to_string());
    }
    Ok((effective_uid, effective_gid))
}

#[cfg(not(unix))]
fn current_account_ids() -> Result<(u32, u32), String> {
    Err("Relay v2 self-hosted setup is unsupported on this platform".to_string())
}

fn validate_account_home(path: &Path) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|_| "Dashboard account home is unavailable".to_string())?;
    if !metadata.file_type().is_dir() {
        return Err("Dashboard account home is unsafe".to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let (expected_uid, expected_gid) = current_account_ids()?;
        if metadata.uid() != expected_uid
            || metadata.gid() != expected_gid
            || metadata.mode() & 0o022 != 0
        {
            return Err("Dashboard account home is unsafe".to_string());
        }
    }
    Ok(())
}

fn validate_bootstrap_bytes(bytes: &[u8]) -> Result<(), String> {
    if bytes.is_empty() || bytes.len() > MAX_BOOTSTRAP_RAW_BYTES {
        return Err("Relay v2 Host bootstrap transfer was invalid".to_string());
    }
    let payload = bytes.strip_suffix(b"\n").unwrap_or(bytes);
    if payload.is_empty()
        || payload.len() > MAX_BOOTSTRAP_RAW_BYTES - 1
        || !payload.starts_with(b"twhostboot2.")
        || payload.iter().any(|byte| !matches!(*byte, 0x21..=0x7e))
    {
        return Err("Relay v2 Host bootstrap transfer was invalid".to_string());
    }
    Ok(())
}

fn normalize_issuer_url(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    let parsed =
        tauri::Url::parse(trimmed).map_err(|_| "Enter a valid HTTPS Relay URL".to_string())?;
    let authority = trimmed
        .split_once("://")
        .map(|(_, remainder)| remainder)
        .unwrap_or(trimmed)
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default();
    if parsed.scheme() != "https"
        || parsed.host_str().is_none()
        || parsed.port() == Some(0)
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || authority.contains('@')
        || parsed.path() != "/"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(
            "Use a root https:// Relay URL without credentials, path, query, or fragment"
                .to_string(),
        );
    }
    Ok(parsed.to_string())
}

fn relay_url_from_issuer(issuer_url: &str) -> Result<String, String> {
    let mut relay =
        tauri::Url::parse(issuer_url).map_err(|_| "saved Relay URL is invalid".to_string())?;
    relay
        .set_scheme("wss")
        .map_err(|_| "saved Relay URL cannot be converted to WSS".to_string())?;
    Ok(relay.to_string())
}

fn validate_listen_host(value: &str) -> Result<String, String> {
    let value = value.trim();
    let address = value.parse::<std::net::Ipv4Addr>().map_err(|_| {
        "Enter the devbox private IPv4 address; 0.0.0.0 requires explicit input".to_string()
    })?;
    let octets = address.octets();
    let private = octets[0] == 10
        || (octets[0] == 172 && (16..=31).contains(&octets[1]))
        || (octets[0] == 192 && octets[1] == 168);
    if !private && !address.is_unspecified() {
        return Err("Relay v2 bind address must be a private IPv4 or explicit 0.0.0.0".to_string());
    }
    Ok(address.to_string())
}

fn read_local_private_file(
    value: &str,
    label: &str,
    maximum_bytes: u64,
) -> Result<LocalPrivateFile, String> {
    let path = PathBuf::from(value.trim());
    if !path.is_absolute() {
        return Err(format!("{label} must be an absolute path"));
    }
    let before =
        std::fs::symlink_metadata(&path).map_err(|error| format!("read {label}: {error}"))?;
    if !before.file_type().is_file() || before.len() == 0 || before.len() > maximum_bytes {
        return Err(format!(
            "{label} must be a non-empty regular file within the size limit"
        ));
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    let mut file = options
        .open(&path)
        .map_err(|_| format!("{label} could not be opened safely"))?;
    let opened = file
        .metadata()
        .map_err(|_| format!("{label} could not be inspected safely"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let (expected_uid, expected_gid) = current_account_ids()?;
        if before.uid() != expected_uid
            || opened.uid() != expected_uid
            || before.gid() != expected_gid
            || opened.gid() != expected_gid
            || before.mode() & 0o7777 != 0o600
            || opened.mode() & 0o7777 != 0o600
            || before.nlink() != 1
            || opened.nlink() != 1
            || before.dev() != opened.dev()
            || before.ino() != opened.ino()
            || !opened.file_type().is_file()
            || opened.len() == 0
            || opened.len() > maximum_bytes
        {
            return Err(format!(
                "{label} must be current-user-owned, single-link, and exact 0600"
            ));
        }
    }
    let mut bytes = Vec::with_capacity(opened.len() as usize);
    Read::by_ref(&mut file)
        .take(maximum_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| format!("{label} could not be read safely"))?;
    let after = file
        .metadata()
        .map_err(|_| format!("{label} could not be rechecked safely"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if opened.dev() != after.dev()
            || opened.ino() != after.ino()
            || opened.len() != after.len()
            || opened.mode() != after.mode()
            || opened.uid() != after.uid()
            || opened.gid() != after.gid()
            || opened.nlink() != after.nlink()
        {
            return Err(format!("{label} changed while it was read"));
        }
    }
    if bytes.is_empty() || bytes.len() as u64 > maximum_bytes || bytes.len() as u64 != opened.len()
    {
        return Err(format!("{label} changed while it was read"));
    }
    #[cfg(unix)]
    let identity = {
        use std::os::unix::fs::MetadataExt;
        LocalPrivateFileIdentity {
            device: after.dev(),
            inode: after.ino(),
            length: after.len(),
            mode: after.mode() & 0o7777,
            uid: after.uid(),
            links: after.nlink(),
            sha256: Sha256::digest(&bytes).into(),
        }
    };
    #[cfg(not(unix))]
    return Err(format!("{label} is unsupported on this platform"));
    Ok(LocalPrivateFile {
        path,
        bytes,
        identity,
    })
}

fn validate_local_tls_file(value: &str, label: &str) -> Result<String, String> {
    Ok(read_local_private_file(value, label, MAX_TLS_FILE_BYTES)?
        .path
        .to_string_lossy()
        .to_string())
}

fn validated_config(
    input: MobileRelayV2SelfHostedConfigInput,
    bootstrap_file_name: Option<String>,
    bootstrap_publication_correlation: Option<String>,
    inspect_tls: bool,
) -> Result<PersistedSelfHostedConfig, String> {
    if !input.enabled {
        return Err("Relay v2 self-hosted deployment requires explicit feature opt-in".to_string());
    }
    let broker_host_id = input.broker_host_id.trim();
    if broker_host_id.is_empty() {
        return Err("Select an SSH devbox for the Relay v2 center".to_string());
    }
    find_host(broker_host_id)?;
    if input.listen_port == 0 {
        return Err("Relay v2 listen port must be between 1 and 65535".to_string());
    }
    let external_tls_management = input.external_tls_management;
    let tls_key_path = if inspect_tls && !external_tls_management {
        validate_local_tls_file(&input.tls_key_path, "TLS private key")?
    } else {
        input.tls_key_path.trim().to_string()
    };
    let tls_certificate_path = if inspect_tls && !external_tls_management {
        validate_local_tls_file(&input.tls_certificate_path, "TLS certificate")?
    } else {
        input.tls_certificate_path.trim().to_string()
    };
    let tls_ca_path = if inspect_tls && !external_tls_management {
        validate_local_tls_file(&input.tls_ca_path, "TLS CA certificate")?
    } else {
        input.tls_ca_path.trim().to_string()
    };
    if !external_tls_management
        && (tls_key_path.is_empty()
            || tls_certificate_path.is_empty()
            || tls_ca_path.is_empty()
            || !Path::new(&tls_key_path).is_absolute()
            || !Path::new(&tls_certificate_path).is_absolute()
            || !Path::new(&tls_ca_path).is_absolute())
    {
        return Err(
            "Select absolute local TLS key, leaf certificate, and CA certificate paths".to_string(),
        );
    }
    if !external_tls_management
        && (tls_key_path == tls_certificate_path
            || tls_key_path == tls_ca_path
            || tls_certificate_path == tls_ca_path)
    {
        return Err(
            "TLS key, leaf certificate, and CA certificate must be distinct files".to_string(),
        );
    }
    Ok(PersistedSelfHostedConfig {
        contract: CONFIG_CONTRACT.to_string(),
        schema_version: CONFIG_SCHEMA_VERSION,
        enabled: true,
        broker_host_id: broker_host_id.to_string(),
        issuer_url: normalize_issuer_url(&input.issuer_url)?,
        listen_host: validate_listen_host(&input.listen_host)?,
        listen_port: input.listen_port,
        tls_key_path,
        tls_certificate_path,
        tls_ca_path,
        external_tls_management,
        host_profile_identity: String::new(),
        profile_provisioned: false,
        host_credential_provisioned: false,
        connector_desired_running: false,
        management_recovery_required: false,
        bootstrap_rotation_pending: false,
        bootstrap_rotation_request_phase: None,
        bootstrap_rotation_transfer_receipt: None,
        bootstrap_file_name,
        bootstrap_publication_correlation,
    })
}

fn validated_config_with_persisted_state(
    input: MobileRelayV2SelfHostedConfigInput,
    inspect_tls: bool,
) -> Result<(Option<PersistedSelfHostedConfig>, PersistedSelfHostedConfig), String> {
    let mut current = load_config()?;
    let mut config = validated_config(input, None, None, inspect_tls)?;
    if let Some(persisted) = current.as_mut() {
        ensure_host_profile_identity(persisted)?;
        let same_host_lineage = persisted.broker_host_id == config.broker_host_id
            && persisted.issuer_url == config.issuer_url;
        if persisted.bootstrap_file_name.is_some() && !same_host_lineage {
            return Err(
                "Finish the pending Relay v2 Host bootstrap before changing its devbox or URL"
                    .to_string(),
            );
        }
        if persisted.profile_provisioned && persisted.issuer_url != config.issuer_url {
            return Err(
                "The persisted Relay v2 Host profile cannot be changed to another Relay URL"
                    .to_string(),
            );
        }
        config.host_profile_identity = persisted.host_profile_identity.clone();
        config.profile_provisioned = persisted.profile_provisioned;
        config.host_credential_provisioned = persisted.host_credential_provisioned;
        config.connector_desired_running = persisted.connector_desired_running;
        config.management_recovery_required = persisted.management_recovery_required;
        config.bootstrap_rotation_pending = persisted.bootstrap_rotation_pending;
        config.bootstrap_rotation_request_phase = persisted.bootstrap_rotation_request_phase;
        config.bootstrap_rotation_transfer_receipt =
            persisted.bootstrap_rotation_transfer_receipt.clone();
        config.bootstrap_file_name = persisted.bootstrap_file_name.clone();
        config.bootstrap_publication_correlation =
            persisted.bootstrap_publication_correlation.clone();
    } else {
        config.host_profile_identity = fresh_host_profile_identity()?;
    }
    Ok((current, config))
}

fn valid_bootstrap_rotation_transfer_receipt(config: &PersistedSelfHostedConfig) -> bool {
    match &config.bootstrap_rotation_transfer_receipt {
        None => true,
        Some(receipt) => {
            config.bootstrap_rotation_pending
                && !config.host_credential_provisioned
                && receipt.profile_lineage == config.host_profile_identity
                && config.bootstrap_file_name.as_deref()
                    == Some(receipt.bootstrap_file_name.as_str())
                && config.bootstrap_publication_correlation.as_deref()
                    == Some(receipt.bootstrap_publication_correlation.as_str())
                && receipt.local_identity.mode == 0o600
                && receipt.local_identity.links == 1
                && receipt.local_identity.length > 0
                && receipt.local_identity.length <= MAX_BOOTSTRAP_RAW_BYTES as u64
        }
    }
}

fn valid_bootstrap_publication_correlation(correlation: &str) -> bool {
    !correlation.is_empty()
        && correlation.len() <= 128
        && correlation.trim() == correlation
        && !correlation
            .bytes()
            .any(|byte| matches!(byte, b'\0' | b'\r' | b'\n'))
}

fn valid_bootstrap_publication_attempt(
    config: &PersistedSelfHostedConfig,
    allow_legacy_missing_correlation: bool,
) -> bool {
    match (
        config.bootstrap_file_name.as_deref(),
        config.bootstrap_publication_correlation.as_deref(),
    ) {
        (None, None) => true,
        (Some(_), Some(correlation)) => valid_bootstrap_publication_correlation(correlation),
        (Some(_), None) => {
            allow_legacy_missing_correlation
                && config.schema_version < BOOTSTRAP_CORRELATION_CONFIG_SCHEMA_VERSION
        }
        (None, Some(_)) => false,
    }
}

fn valid_bootstrap_rotation_state(config: &PersistedSelfHostedConfig) -> bool {
    if !config.bootstrap_rotation_pending {
        return config.bootstrap_rotation_request_phase.is_none()
            && config.bootstrap_rotation_transfer_receipt.is_none();
    }
    match (
        config.bootstrap_rotation_request_phase,
        config.bootstrap_rotation_transfer_receipt.as_ref(),
    ) {
        (Some(_), None) => true,
        (None, Some(_)) => valid_bootstrap_rotation_transfer_receipt(config),
        (None, None) => config.schema_version < BOOTSTRAP_CORRELATION_CONFIG_SCHEMA_VERSION,
        (Some(_), Some(_)) => false,
    }
}

fn ready_rotation_transfer_identity(
    config: &PersistedSelfHostedConfig,
) -> Result<Option<&LocalPrivateFileIdentity>, String> {
    if !config.bootstrap_rotation_pending {
        return Ok(None);
    }
    if !valid_bootstrap_rotation_transfer_receipt(config) {
        return Err("Relay v2 Host bootstrap transfer receipt does not match config".to_string());
    }
    let receipt = config
        .bootstrap_rotation_transfer_receipt
        .as_ref()
        .filter(|receipt| receipt.phase == BootstrapRotationTransferPhase::Ready)
        .ok_or(
            "Relay v2 Host bootstrap rotation has not completed its verified transfer".to_string(),
        )?;
    Ok(Some(&receipt.local_identity))
}

fn verify_rotation_transfer_identity(
    config: &PersistedSelfHostedConfig,
    actual: &LocalPrivateFileIdentity,
) -> Result<(), String> {
    if !valid_bootstrap_rotation_transfer_receipt(config)
        || config
            .bootstrap_rotation_transfer_receipt
            .as_ref()
            .is_none_or(|receipt| &receipt.local_identity != actual)
    {
        return Err(
            "Relay v2 Host bootstrap replacement does not match its transfer receipt".to_string(),
        );
    }
    Ok(())
}

fn normalize_legacy_connector_desired_state(config: &mut PersistedSelfHostedConfig) {
    // Connector desired state became durable in schema 6. Schemas older than
    // that are conservatively reset to stopped; schema 6 and above preserve it.
    if config.schema_version < CONNECTOR_DESIRED_STATE_CONFIG_SCHEMA_VERSION {
        config.connector_desired_running = false;
    }
}

fn load_config() -> Result<Option<PersistedSelfHostedConfig>, String> {
    let path = config_path()?;
    match std::fs::symlink_metadata(&path) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("read {}: {error}", path.display())),
    }
    ensure_dashboard_config_private_tree()?;
    let contents = read_local_private_file(
        &path.to_string_lossy(),
        "Relay v2 self-hosted configuration",
        16 * 1024,
    )?;
    let mut config: PersistedSelfHostedConfig = serde_json::from_slice(&contents.bytes)
        .map_err(|_| "Relay v2 self-hosted configuration is invalid".to_string())?;
    normalize_legacy_connector_desired_state(&mut config);
    if config.contract != CONFIG_CONTRACT
        || !matches!(
            config.schema_version,
            LEGACY_CONFIG_SCHEMA_VERSION
                | HOST_PROFILE_CONFIG_SCHEMA_VERSION
                | ROTATION_PENDING_CONFIG_SCHEMA_VERSION
                | ROTATION_RECEIPT_CONFIG_SCHEMA_VERSION
                | BOOTSTRAP_CORRELATION_CONFIG_SCHEMA_VERSION
                | CONNECTOR_DESIRED_STATE_CONFIG_SCHEMA_VERSION
                | CONFIG_SCHEMA_VERSION
        )
        || !config.enabled
        || config.broker_host_id.trim() != config.broker_host_id
        || config.broker_host_id.is_empty()
        || normalize_issuer_url(&config.issuer_url)? != config.issuer_url
        || validate_listen_host(&config.listen_host)? != config.listen_host
        || config.listen_port == 0
        || (!config.external_tls_management
            && (config.tls_key_path.is_empty()
                || config.tls_certificate_path.is_empty()
                || config.tls_ca_path.is_empty()
                || !Path::new(&config.tls_key_path).is_absolute()
                || !Path::new(&config.tls_certificate_path).is_absolute()
                || !Path::new(&config.tls_ca_path).is_absolute()))
        || (config.schema_version != LEGACY_CONFIG_SCHEMA_VERSION
            && !valid_host_profile_identity(&config.host_profile_identity))
        || config.host_credential_provisioned && !config.profile_provisioned
        || config.host_credential_provisioned
            && (config.bootstrap_file_name.is_some()
                || config.bootstrap_publication_correlation.is_some())
        || config.bootstrap_rotation_pending && config.host_credential_provisioned
        || config.bootstrap_rotation_pending && config.bootstrap_file_name.is_none()
        || config.bootstrap_rotation_pending
            && config.schema_version >= BOOTSTRAP_CORRELATION_CONFIG_SCHEMA_VERSION
            && config.bootstrap_publication_correlation.is_none()
        || !valid_bootstrap_publication_attempt(&config, true)
        || !valid_bootstrap_rotation_state(&config)
        || config.bootstrap_file_name.as_deref().is_some_and(|name| {
            !name.starts_with("host-bootstrap-")
                || !name.ends_with(".twhostboot2")
                || name
                    .bytes()
                    .any(|byte| !(byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.')))
        })
    {
        return Err("Relay v2 self-hosted configuration is invalid".to_string());
    }
    Ok(Some(config))
}

fn save_config(config: &PersistedSelfHostedConfig) -> Result<(), String> {
    if config.schema_version != CONFIG_SCHEMA_VERSION
        || !valid_host_profile_identity(&config.host_profile_identity)
        || config.host_credential_provisioned && !config.profile_provisioned
        || config.host_credential_provisioned
            && (config.bootstrap_file_name.is_some()
                || config.bootstrap_publication_correlation.is_some())
        || config.bootstrap_rotation_pending && config.host_credential_provisioned
        || config.bootstrap_rotation_pending && config.bootstrap_file_name.is_none()
        || config.bootstrap_rotation_pending && config.bootstrap_publication_correlation.is_none()
        || !valid_bootstrap_publication_attempt(config, false)
        || !valid_bootstrap_rotation_state(config)
    {
        return Err("Relay v2 self-hosted configuration is invalid".to_string());
    }
    let path = config_path()?;
    ensure_dashboard_config_private_tree()?;
    let mut contents = serde_json::to_vec_pretty(config)
        .map_err(|error| format!("serialize Relay v2 self-hosted config: {error}"))?;
    contents.push(b'\n');
    atomic_write_file(&path, &contents)
}

fn projection(config: &PersistedSelfHostedConfig) -> MobileRelayV2SelfHostedConfigProjection {
    MobileRelayV2SelfHostedConfigProjection {
        enabled: true,
        broker_host_id: config.broker_host_id.clone(),
        issuer_url: config.issuer_url.clone(),
        listen_host: config.listen_host.clone(),
        listen_port: config.listen_port,
        tls_key_path: config.tls_key_path.clone(),
        tls_certificate_path: config.tls_certificate_path.clone(),
        tls_ca_path: config.tls_ca_path.clone(),
        external_tls_management: config.external_tls_management,
    }
}

fn deployment_fingerprint(config: &PersistedSelfHostedConfig) -> String {
    // Keep the private-mode fingerprint byte-for-byte stable across the schema 7
    // upgrade: only externally managed deployments add the new key.
    let input = if config.external_tls_management {
        serde_json::json!({
            "brokerHostId": config.broker_host_id,
            "issuerUrl": config.issuer_url,
            "listenHost": config.listen_host,
            "listenPort": config.listen_port,
            "tlsKeyPath": config.tls_key_path,
            "tlsCertificatePath": config.tls_certificate_path,
            "tlsCaPath": config.tls_ca_path,
            "externalTlsManagement": true,
        })
    } else {
        serde_json::json!({
            "brokerHostId": config.broker_host_id,
            "issuerUrl": config.issuer_url,
            "listenHost": config.listen_host,
            "listenPort": config.listen_port,
            "tlsKeyPath": config.tls_key_path,
            "tlsCertificatePath": config.tls_certificate_path,
            "tlsCaPath": config.tls_ca_path,
        })
    };
    let bytes = serde_json::to_vec(&input).expect("fixed deployment fingerprint schema serializes");
    format!("{:x}", Sha256::digest(bytes))
}

fn persisted_management_config_identity(
    config: &PersistedSelfHostedConfig,
) -> Result<[u8; 32], String> {
    let mut identity_config = config.clone();
    identity_config.connector_desired_running = false;
    let bytes = serde_json::to_vec(&identity_config)
        .map_err(|_| "Relay v2 self-hosted configuration identity failed".to_string())?;
    let digest = Sha256::digest(bytes);
    let mut identity = [0_u8; 32];
    identity.copy_from_slice(&digest);
    Ok(identity)
}

fn management_config_identity_changed(
    previous: Option<&PersistedSelfHostedConfig>,
    next: &PersistedSelfHostedConfig,
) -> Result<bool, String> {
    let Some(previous) = previous else {
        return Ok(false);
    };
    Ok(persisted_management_config_identity(previous)?
        != persisted_management_config_identity(next)?)
}

fn prepared_management_ca_would_change(
    config: &PersistedSelfHostedConfig,
    binding: &SelfHostedManagementBinding,
) -> Result<bool, String> {
    let source_path = if config.external_tls_management {
        local_host_ca_input_path()?
    } else {
        PathBuf::from(&config.tls_ca_path)
    };
    let source = read_local_private_file(
        &source_path.to_string_lossy(),
        if config.external_tls_management {
            "external TLS chain certificate"
        } else {
            "TLS CA certificate"
        },
        MAX_TLS_FILE_BYTES,
    )?;
    let prepared_path = local_host_ca_input_path()?;
    match std::fs::symlink_metadata(&prepared_path) {
        Ok(_) => {
            let prepared = read_local_private_file(
                &prepared_path.to_string_lossy(),
                "prepared TLS CA certificate",
                MAX_TLS_FILE_BYTES,
            )?;
            if prepared.bytes != source.bytes {
                return Ok(true);
            }
            let identity: ManagementPreparedFileIdentity = prepared.identity.into();
            Ok(!matches!(
                &binding.steady_launch_key,
                ManagementLaunchKey::SelfHostedDarwinArm64 {
                    credential_https_ca_input,
                    carrier_wss_ca_input,
                    credential_https_ca_identity,
                    carrier_wss_ca_identity,
                    ..
                } if credential_https_ca_input == &prepared_path
                    && carrier_wss_ca_input == &prepared_path
                    && credential_https_ca_identity == &identity
                    && carrier_wss_ca_identity == &identity
            ))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(_) => Err("inspect prepared TLS CA certificate failed".to_string()),
    }
}

fn commit_config_replacement_with_barrier<Drain, Persist>(
    owner: &mut SelfHostedDeploymentOperationOwner,
    previous: Option<PersistedSelfHostedConfig>,
    mut next: PersistedSelfHostedConfig,
    steady_launch_identity_changed: bool,
    mut drain: Drain,
    mut persist: Persist,
) -> Result<PersistedSelfHostedConfig, String>
where
    Drain: FnMut(&ManagementLaunchKey) -> Result<(), String>,
    Persist: FnMut(&PersistedSelfHostedConfig) -> Result<(), String>,
{
    let config_identity_changed = management_config_identity_changed(previous.as_ref(), &next)?;
    if !config_identity_changed && !steady_launch_identity_changed {
        persist(&next)?;
        return Ok(next);
    }

    let mut stopped =
        previous.ok_or("Relay v2 self-hosted configuration replacement lost its current state")?;
    stopped.connector_desired_running = false;
    persist(&stopped)?;
    next.connector_desired_running = false;

    if let Some(binding) = owner.active_management.clone() {
        drain(&binding.steady_launch_key)?;
        owner.active_management = None;
    }

    persist(&next)?;
    owner.startup_restore_error = None;
    Ok(next)
}

fn save_config_replacement_after_management_barrier(
    owner: &mut SelfHostedDeploymentOperationOwner,
    management: &MobileRelayV2ManagementCommandState,
    previous: Option<PersistedSelfHostedConfig>,
    next: PersistedSelfHostedConfig,
) -> Result<PersistedSelfHostedConfig, String> {
    let config_identity_changed = management_config_identity_changed(previous.as_ref(), &next)?;
    let steady_launch_identity_changed = match owner.active_management.as_ref() {
        Some(binding) if config_identity_changed || !binding.matches_config(&next) => true,
        Some(binding) => prepared_management_ca_would_change(&next, binding)?,
        None => false,
    };
    commit_config_replacement_with_barrier(
        owner,
        previous,
        next,
        steady_launch_identity_changed,
        |launch_key| {
            if management
                .stop_self_hosted_connector_for_launch_key(Some(launch_key))
                .is_ok()
            {
                return Ok(());
            }
            // The connector stop failed (slow devbox, a poisoned child, or a
            // connector that never returned to exact stopped). The old child is
            // unusable, but the terminal dispose() would latch the process-level
            // `disposed` fence and permanently brick every later call, replace
            // and watchdog restart until the Dashboard restarts. Instead mark
            // the owner recoverable (StartFailed(ChannelClosed), never
            // RecoveryRequired) without touching `disposed`; the next Start
            // Center / watchdog replace rebuilds a fresh child. The config save
            // still fails this attempt so the persisted desired state stays
            // consistent with the drained child.
            management.abandon_self_hosted_owner_after_failed_stop(launch_key);
            Err(
                "Relay v2 self-hosted Host could not be stopped before replacing configuration"
                    .to_string(),
            )
        },
        save_config,
    )
}

fn same_deployment_config(
    left: &PersistedSelfHostedConfig,
    right: &PersistedSelfHostedConfig,
) -> bool {
    deployment_fingerprint(left) == deployment_fingerprint(right)
}

fn valid_host_profile_identity(identity: &str) -> bool {
    identity.len() == 32 && identity.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn fresh_host_profile_identity() -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes)
        .map_err(|_| "generate Relay v2 Host profile identity failed".to_string())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn fresh_bootstrap_publication_correlation() -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| {
        "generate Relay v2 Host bootstrap publication correlation failed".to_string()
    })?;
    Ok(format!(
        "dashboard-bootstrap-publication-{}",
        bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    ))
}

fn ensure_host_profile_identity(config: &mut PersistedSelfHostedConfig) -> Result<(), String> {
    normalize_legacy_connector_desired_state(config);
    if config.schema_version == LEGACY_CONFIG_SCHEMA_VERSION
        && config.host_profile_identity.is_empty()
    {
        config.host_profile_identity = fresh_host_profile_identity()?;
    }
    if !valid_host_profile_identity(&config.host_profile_identity) {
        return Err("Relay v2 Host profile identity is invalid".to_string());
    }
    if config.schema_version < BOOTSTRAP_CORRELATION_CONFIG_SCHEMA_VERSION
        && config.bootstrap_file_name.is_some()
        && config.bootstrap_publication_correlation.is_none()
    {
        return Err(
            "Pending Relay v2 Host bootstrap predates publication correlations and cannot be resumed"
                .to_string(),
        );
    }
    if !valid_bootstrap_publication_attempt(config, false) {
        return Err("Relay v2 Host bootstrap publication attempt is invalid".to_string());
    }
    if config.schema_version < BOOTSTRAP_CORRELATION_CONFIG_SCHEMA_VERSION
        && config.bootstrap_rotation_pending
        && config.bootstrap_rotation_request_phase.is_none()
        && config.bootstrap_rotation_transfer_receipt.is_none()
    {
        // Schema 3 did not distinguish an old expired local input from a
        // replacement whose remote copy was already removed. Never infer
        // either state or remint during migration.
        config.bootstrap_rotation_request_phase =
            Some(BootstrapRotationRequestPhase::UnverifiedLegacy);
    }
    if matches!(
        config.schema_version,
        LEGACY_CONFIG_SCHEMA_VERSION
            | HOST_PROFILE_CONFIG_SCHEMA_VERSION
            | ROTATION_PENDING_CONFIG_SCHEMA_VERSION
            | ROTATION_RECEIPT_CONFIG_SCHEMA_VERSION
            | BOOTSTRAP_CORRELATION_CONFIG_SCHEMA_VERSION
            | CONNECTOR_DESIRED_STATE_CONFIG_SCHEMA_VERSION
    ) {
        config.schema_version = CONFIG_SCHEMA_VERSION;
    }
    Ok(())
}

fn create_local_private_file_once(
    path: &Path,
    bytes: &[u8],
    label: &str,
    maximum_bytes: u64,
) -> Result<LocalPrivateFile, String> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => {
            let existing = read_local_private_file(&path.to_string_lossy(), label, maximum_bytes)?;
            if existing.bytes != bytes {
                return Err(format!(
                    "{label} does not match the persisted Host identity"
                ));
            }
            Ok(existing)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options
                    .mode(0o600)
                    .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
            }
            let result = (|| {
                let mut file = options
                    .open(path)
                    .map_err(|_| format!("create {label} failed"))?;
                file.write_all(bytes)
                    .and_then(|_| file.sync_all())
                    .map_err(|_| format!("write {label} failed"))?;
                fsync_parent(path)?;
                read_local_private_file(&path.to_string_lossy(), label, maximum_bytes)
            })();
            if result.is_err() {
                let _ = std::fs::remove_file(path);
            }
            result
        }
        Err(_) => Err(format!("inspect {label} failed")),
    }
}

fn fsync_parent(path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Relay v2 private file has no parent".to_string())?;
    let directory = std::fs::File::open(parent)
        .map_err(|_| "open Relay v2 private directory failed".to_string())?;
    directory
        .sync_all()
        .map_err(|_| "sync Relay v2 private directory failed".to_string())
}

fn consumed_local_private_file_path(path: &Path, label: &str) -> Result<PathBuf, String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("{label} has no private parent"))?;
    let file_name = path
        .file_name()
        .ok_or_else(|| format!("{label} has no file name"))?;
    Ok(parent.join(format!(".{}.consumed", file_name.to_string_lossy())))
}

fn consume_local_private_file(
    path: &Path,
    expected: &LocalPrivateFileIdentity,
    maximum_bytes: u64,
    label: &str,
) -> Result<(), String> {
    let current = read_local_private_file(&path.to_string_lossy(), label, maximum_bytes)?;
    if &current.identity != expected {
        return Err(format!("{label} identity changed before consumption"));
    }
    let tombstone = consumed_local_private_file_path(path, label)?;
    if std::fs::symlink_metadata(&tombstone).is_ok() {
        return Err(format!("{label} cleanup collision"));
    }
    std::fs::rename(path, &tombstone).map_err(|_| format!("{label} could not be fenced"))?;
    fsync_parent(&tombstone)?;
    let moved = read_local_private_file(&tombstone.to_string_lossy(), label, maximum_bytes)?;
    if moved.identity != *expected {
        return Err(format!("{label} identity changed while it was fenced"));
    }
    std::fs::remove_file(&tombstone).map_err(|_| format!("{label} could not be removed"))?;
    fsync_parent(&tombstone)
}

fn write_ready_commit_journal(
    journal: &ReadyCommitJournal,
) -> Result<LocalPrivateFileIdentity, String> {
    ensure_local_host_private_tree()?;
    let path = local_ready_commit_journal_path()?;
    if std::fs::symlink_metadata(&path).is_ok() {
        return Err("Relay v2 management ready commit journal already exists".to_string());
    }
    let mut bytes = serde_json::to_vec(journal)
        .map_err(|_| "serialize Relay v2 management ready commit journal failed".to_string())?;
    bytes.push(b'\n');
    atomic_write_file(&path, &bytes)?;
    Ok(read_local_private_file(
        &path.to_string_lossy(),
        "Relay v2 management ready commit journal",
        16 * 1024,
    )?
    .identity)
}

fn load_ready_commit_journal(
) -> Result<Option<(ReadyCommitJournal, LocalPrivateFileIdentity)>, String> {
    let path = local_ready_commit_journal_path()?;
    load_ready_commit_journal_at(&path)
}

fn load_ready_commit_journal_at(
    path: &Path,
) -> Result<Option<(ReadyCommitJournal, LocalPrivateFileIdentity)>, String> {
    let tombstone =
        consumed_local_private_file_path(path, "Relay v2 management ready commit journal")?;
    let present = |candidate: &Path| match std::fs::symlink_metadata(candidate) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err("inspect Relay v2 management ready commit journal failed".to_string()),
    };
    let live_present = present(path)?;
    let consumed_present = present(&tombstone)?;
    if live_present && consumed_present {
        return Err("Relay v2 management ready commit journal cleanup collision".to_string());
    }
    let selected = match (live_present, consumed_present) {
        (true, false) => path,
        (false, true) => tombstone.as_path(),
        (false, false) => return Ok(None),
        (true, true) => unreachable!(),
    };
    let file = read_local_private_file(
        &selected.to_string_lossy(),
        "Relay v2 management ready commit journal",
        16 * 1024,
    )?;
    let journal: ReadyCommitJournal = serde_json::from_slice(&file.bytes)
        .map_err(|_| "Relay v2 management ready commit journal is invalid".to_string())?;
    if journal.contract != READY_COMMIT_JOURNAL_CONTRACT
        || !matches!(
            journal.schema_version,
            1 | READY_COMMIT_JOURNAL_SCHEMA_VERSION
        )
        || !valid_host_profile_identity(&journal.profile_lineage)
        || journal.schema_version == READY_COMMIT_JOURNAL_SCHEMA_VERSION
            && (journal.bootstrap_file_name.is_some()
                != journal.bootstrap_publication_correlation.is_some()
                || journal.bootstrap_identity.is_some()
                    != journal.bootstrap_publication_correlation.is_some())
        || journal
            .bootstrap_publication_correlation
            .as_deref()
            .is_some_and(|correlation| !valid_bootstrap_publication_correlation(correlation))
    {
        return Err("Relay v2 management ready commit journal is invalid".to_string());
    }
    Ok(Some((journal, file.identity)))
}

fn finish_consuming_if_present(
    path: &Path,
    expected: &LocalPrivateFileIdentity,
    maximum_bytes: u64,
    label: &str,
) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Ok(_) => consume_local_private_file(path, expected, maximum_bytes, label),
        Err(_) => Err(format!("inspect {label} failed")),
    }?;
    let tombstone = consumed_local_private_file_path(path, label)?;
    match std::fs::symlink_metadata(&tombstone) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Ok(_) => {
            let moved =
                read_local_private_file(&tombstone.to_string_lossy(), label, maximum_bytes)?;
            if &moved.identity != expected {
                return Err(format!("{label} fenced identity is invalid"));
            }
            std::fs::remove_file(&tombstone)
                .map_err(|_| format!("{label} fenced file could not be removed"))?;
            fsync_parent(&tombstone)
        }
        Err(_) => Err(format!("inspect fenced {label} failed")),
    }
}

fn commit_bootstrap_ready_state(
    config: &mut PersistedSelfHostedConfig,
    journal_file_name: &Option<String>,
    journal_correlation: &Option<String>,
) -> Result<(), String> {
    if config.bootstrap_file_name == *journal_file_name
        && config.bootstrap_publication_correlation == *journal_correlation
        && journal_file_name.is_some()
        && journal_correlation.is_some()
    {
        config.bootstrap_file_name = None;
        config.bootstrap_publication_correlation = None;
        config.host_credential_provisioned = true;
        config.bootstrap_rotation_pending = false;
        config.bootstrap_rotation_request_phase = None;
        config.bootstrap_rotation_transfer_receipt = None;
    } else if config.bootstrap_file_name.is_some()
        || config.bootstrap_publication_correlation.is_some()
        || !config.host_credential_provisioned
    {
        return Err("Relay v2 management ready commit journal does not match config".to_string());
    } else {
        // The config commit may have completed before the journal tombstone was
        // finalized. Replaying the same ready record is idempotent.
        config.bootstrap_rotation_pending = false;
        config.bootstrap_rotation_request_phase = None;
        config.bootstrap_rotation_transfer_receipt = None;
    }
    Ok(())
}

fn recover_ready_commit(
    config: &mut PersistedSelfHostedConfig,
    journal: ReadyCommitJournal,
    journal_identity: &LocalPrivateFileIdentity,
) -> Result<(), String> {
    if journal.profile_lineage != config.host_profile_identity
        || journal.bootstrap_identity.is_some() != journal.bootstrap_file_name.is_some()
        || journal.bootstrap_identity.is_some()
            != journal.bootstrap_publication_correlation.is_some()
    {
        return Err("Relay v2 management ready commit journal does not match config".to_string());
    }
    if let Some(expected) = &journal.bootstrap_identity {
        if config.bootstrap_file_name == journal.bootstrap_file_name
            && config.bootstrap_publication_correlation == journal.bootstrap_publication_correlation
        {
            finish_consuming_if_present(
                &local_bootstrap_path(config)?,
                expected,
                MAX_BOOTSTRAP_RAW_BYTES as u64,
                "Relay v2 Host bootstrap input",
            )?;
        }
        commit_bootstrap_ready_state(
            config,
            &journal.bootstrap_file_name,
            &journal.bootstrap_publication_correlation,
        )?;
    }
    if let Some(expected) = &journal.provision_profile_identity {
        if !config.profile_provisioned {
            finish_consuming_if_present(
                &local_host_profile_input_path()?,
                expected,
                16 * 1024,
                "Relay v2 Host provision profile input",
            )?;
            config.profile_provisioned = true;
        }
    }
    config.management_recovery_required = false;
    save_config(config)?;
    finish_consuming_if_present(
        &local_ready_commit_journal_path()?,
        journal_identity,
        16 * 1024,
        "Relay v2 management ready commit journal",
    )
}

fn prepare_local_host_prerequisites_for(
    config: &PersistedSelfHostedConfig,
) -> Result<
    (
        LocalPrivateFile,
        Option<LocalPrivateFile>,
        Option<LocalPrivateFile>,
    ),
    String,
> {
    let expected_rotation_identity = ready_rotation_transfer_identity(config)?;
    ensure_local_host_private_tree()?;
    ensure_local_native_credential_directory()?;

    let ca = if config.external_tls_management {
        // Externally managed TLS: the Host trust cut is the public chain pulled
        // back from the devbox into the same local CA input cell that private
        // mode stages. A missing local chain means the external deploy (which
        // fetches it) has not run yet.
        let ca_input = local_host_ca_input_path()?;
        read_local_private_file(
            &ca_input.to_string_lossy(),
            "external TLS chain certificate",
            MAX_TLS_FILE_BYTES,
        )
        .map_err(|_| {
            "External TLS chain is not available locally; run Deploy to fetch the Let's Encrypt chain from the devbox"
                .to_string()
        })?
    } else {
        read_local_private_file(
            &config.tls_ca_path,
            "TLS CA certificate",
            MAX_TLS_FILE_BYTES,
        )?
    };
    let ca_input = local_host_ca_input_path()?;
    let ca_input_string = ca_input.to_string_lossy().to_string();
    let ca = match std::fs::symlink_metadata(&ca_input) {
        Ok(_) => {
            let existing = read_local_private_file(
                &ca_input_string,
                "prepared TLS CA certificate",
                MAX_TLS_FILE_BYTES,
            )?;
            if existing.bytes == ca.bytes {
                existing
            } else {
                atomic_write_file(&ca_input, &ca.bytes)?;
                read_local_private_file(
                    &ca_input_string,
                    "prepared TLS CA certificate",
                    MAX_TLS_FILE_BYTES,
                )?
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            atomic_write_file(&ca_input, &ca.bytes)?;
            read_local_private_file(
                &ca_input_string,
                "prepared TLS CA certificate",
                MAX_TLS_FILE_BYTES,
            )?
        }
        Err(_) => return Err("inspect prepared TLS CA certificate failed".to_string()),
    };

    let identity = &config.host_profile_identity;
    let host_id = format!("dashboard-{identity}");
    let profile = serde_json::json!({
        "contract": "tmux-worktree-relay-v2-host-production-profile",
        "schemaVersion": 1,
        "hostId": host_id,
        "relayUrl": relay_url_from_issuer(&config.issuer_url)?,
        "credentialIssuerUrl": config.issuer_url,
        "credentialReference": format!("relay-v2-host-credential-ref:{host_id}"),
        "bootstrapSecretReference": format!("dashboard-bootstrap-{identity}"),
        "refreshSecretReference": format!("dashboard-refresh-{identity}"),
    });
    let mut profile_bytes = serde_json::to_vec_pretty(&profile)
        .map_err(|_| "prepare Relay v2 Host profile input failed".to_string())?;
    profile_bytes.push(b'\n');
    let profile_input = local_host_profile_input_path()?;
    let profile = if config.profile_provisioned {
        None
    } else {
        Some(create_local_private_file_once(
            &profile_input,
            &profile_bytes,
            "prepared Relay v2 Host profile input",
            16 * 1024,
        )?)
    };

    let bootstrap = if config.host_credential_provisioned {
        None
    } else if config.bootstrap_file_name.is_some() {
        Some(read_local_private_file(
            &local_bootstrap_path(config)?.to_string_lossy(),
            "Relay v2 Host bootstrap input",
            MAX_BOOTSTRAP_RAW_BYTES as u64,
        )?)
    } else {
        None
    };
    if let Some(expected) = expected_rotation_identity {
        let actual = bootstrap
            .as_ref()
            .map(|file| &file.identity)
            .ok_or("Relay v2 Host bootstrap replacement is unavailable".to_string())?;
        verify_rotation_transfer_identity(config, actual)?;
        if actual != expected {
            return Err(
                "Relay v2 Host bootstrap replacement does not match its transfer receipt"
                    .to_string(),
            );
        }
    }
    Ok((ca, profile, bootstrap))
}

pub(crate) fn prepare_relay_v2_self_hosted_management_prerequisites(
) -> Result<Option<PreparedSelfHostedManagementLaunch>, String> {
    let Some(mut config) = load_config()? else {
        return Ok(None);
    };
    ensure_host_profile_identity(&mut config)?;
    save_config(&config)?;
    ensure_local_host_private_tree()?;
    if let Some((journal, identity)) = load_ready_commit_journal()? {
        recover_ready_commit(&mut config, journal, &identity)?;
    } else if config.management_recovery_required {
        return Err(
            "Relay v2 Host management requires recovery before it can be started".to_string(),
        );
    }
    let account_home = self_hosted_account_home()?;
    let (ca, profile, bootstrap) = prepare_local_host_prerequisites_for(&config)?;
    let selection = ManagementChildSelection::self_hosted_darwin_arm64(
        account_home,
        ca.path.clone(),
        ca.path,
        ca.identity.clone().into(),
        ca.identity.into(),
        config.host_profile_identity.clone(),
        profile
            .as_ref()
            .map(|file| (file.path.clone(), file.identity.clone().into())),
        bootstrap
            .as_ref()
            .map(|file| (file.path.clone(), file.identity.clone().into())),
        config
            .bootstrap_rotation_transfer_receipt
            .as_ref()
            .is_some_and(|receipt| receipt.phase == BootstrapRotationTransferPhase::Ready)
            .then_some(ManagementBootstrapSecretMode::ReplacePending),
    )
    .map_err(|_| "Relay v2 self-hosted Host launch inputs are invalid".to_string())?;
    Ok(Some(PreparedSelfHostedManagementLaunch {
        config,
        selection,
        bootstrap_identity: bootstrap.map(|file| file.identity),
        provision_profile_identity: profile.map(|file| file.identity),
    }))
}

fn base_status(
    config: Option<&PersistedSelfHostedConfig>,
    error: Option<String>,
) -> MobileRelayV2SelfHostedStatus {
    MobileRelayV2SelfHostedStatus {
        feature: FEATURE_KIND.to_string(),
        configured: config.is_some(),
        config: config.map(projection),
        bundle_status: if config.is_some() {
            DeploymentProbeStatus::Unknown
        } else {
            DeploymentProbeStatus::Missing
        },
        tls_status: if config.is_some() {
            DeploymentProbeStatus::Unknown
        } else {
            DeploymentProbeStatus::Missing
        },
        center_status: if config.is_some() {
            DeploymentProbeStatus::Unknown
        } else {
            DeploymentProbeStatus::Stopped
        },
        host_bootstrap_available: false,
        host_bootstrap_pending: config.is_some_and(|config| {
            !config.host_credential_provisioned && config.bootstrap_file_name.is_some()
        }),
        host_credential_provisioned: config
            .is_some_and(|config| config.host_credential_provisioned),
        profile_provisioned: config.is_some_and(|config| config.profile_provisioned),
        connector_desired_running: config.is_some_and(|config| config.connector_desired_running),
        effective: config.is_some_and(self_hosted_connector_prerequisites_are_complete),
        bootstrap_rotation_pending: config.is_some_and(|config| config.bootstrap_rotation_pending),
        remote_tls_key_path: format!("~/{REMOTE_TLS_KEY}"),
        remote_tls_certificate_path: format!("~/{REMOTE_TLS_CERTIFICATE}"),
        remote_tls_ca_path: format!("~/{REMOTE_TLS_CA}"),
        remote_profile_path: format!("~/{REMOTE_PROFILE}"),
        remote_state_directory: format!("~/{REMOTE_STATE_DIRECTORY}"),
        running_bundle_version: None,
        center_version_stale: false,
        dashboard_bundle_version: env!("CARGO_PKG_VERSION").to_string(),
        error,
    }
}

fn probe_status(config: &PersistedSelfHostedConfig) -> MobileRelayV2SelfHostedStatus {
    let mut status = base_status(Some(config), None);
    status.host_bootstrap_available =
        local_bootstrap_path(config).is_ok_and(|path| secure_bootstrap_file(&path));
    let host = match find_host(&config.broker_host_id) {
        Ok(host) => host,
        Err(error) => {
            status.error = Some(error);
            return status;
        }
    };
    let fingerprint = deployment_fingerprint(config);
    let tls_probe = if config.external_tls_management {
        let hostname = match issuer_hostname(&config.issuer_url) {
            Ok(hostname) => hostname,
            Err(error) => {
                status.error = Some(error);
                return status;
            }
        };
        format!(
            r#"tls_external=0
if test -e "$HOME/{REMOTE_TLS_KEY}" || test -L "$HOME/{REMOTE_TLS_KEY}"; then
  if require_private_file "$HOME/{REMOTE_TLS_KEY}"; then
    if test -e "$HOME/{REMOTE_TLS_CERTIFICATE}" || test -L "$HOME/{REMOTE_TLS_CERTIFICATE}"; then
      if require_private_file "$HOME/{REMOTE_TLS_CERTIFICATE}"; then
        san="$(openssl x509 -in "$HOME/{REMOTE_TLS_CERTIFICATE}" -noout -ext subjectAltName 2>/dev/null || true)"
        case "$san" in
          *"DNS:{hostname}"*) tls_external=1 ;;
          *) printf 'external-tls-san-mismatch\n' ;;
        esac
      fi
    fi
  fi
fi
if test "$tls_external" -eq 1; then
  if grep -Fq '"deploymentFingerprint": "{fingerprint}"' "$HOME/{REMOTE_PROFILE}"; then
    printf 'tls=ready\n'
    if ! openssl x509 -in "$HOME/{REMOTE_TLS_CERTIFICATE}" -noout -checkend 2592000 >/dev/null 2>&1; then
      printf 'tls-expiring-soon\n'
    fi
  else
    printf 'tls=missing\n'
  fi
else
  printf 'tls=missing\n'
fi
"#,
        )
    } else {
        format!(
            r#"tls_present=0
for file in "$HOME/{REMOTE_TLS_KEY}" "$HOME/{REMOTE_TLS_CERTIFICATE}" "$HOME/{REMOTE_TLS_CA}" "$HOME/{REMOTE_PROFILE}"; do
  if test -e "$file" || test -L "$file"; then
    require_private_file "$file"
    tls_present=$((tls_present + 1))
  fi
done
if test "$tls_present" -eq 4 && grep -Fq '"deploymentFingerprint": "{fingerprint}"' "$HOME/{REMOTE_PROFILE}"; then
  printf 'tls=ready\n'
else
  printf 'tls=missing\n'
fi
"#
        )
    };
    let script = format!(
        r#"{REMOTE_SECURITY_FUNCTIONS}
set -u
account_root="$HOME/.tmux-worktree"
root="$HOME/{REMOTE_ROOT}"
if test ! -e "$account_root" && test ! -L "$account_root"; then
  printf 'bundle=missing\ntls=missing\ncenter=stopped\n'
  exit 0
fi
require_parent_dir "$account_root"
if test ! -e "$root" && test ! -L "$root"; then
  printf 'bundle=missing\ntls=missing\ncenter=stopped\n'
  exit 0
fi
require_relay_layout
if test -e "$root/current" || test -L "$root/current"; then
  require_current_bundle
  printf 'bundle=ready\n'
else
  printf 'bundle=missing\n'
fi
{tls_probe}
{center_probe}
"#,
        center_probe = build_remote_center_status_probe_snippet(&remote_tmux_cmd(&host)),
    );
    match run_remote_cmd_check_strings(&host, &["sh".into(), "-lc".into(), script]) {
        Ok(output) => {
            for line in output.lines() {
                match line {
                    "bundle=ready" => status.bundle_status = DeploymentProbeStatus::Ready,
                    "bundle=missing" => status.bundle_status = DeploymentProbeStatus::Missing,
                    "tls=ready" => status.tls_status = DeploymentProbeStatus::Ready,
                    "tls=missing" => status.tls_status = DeploymentProbeStatus::Missing,
                    "tls-expiring-soon"
                        if status.tls_status == DeploymentProbeStatus::Ready
                            && status.error.is_none() =>
                    {
                        status.error = Some(
                                "Relay v2 TLS certificate expires within 30 days; Let's Encrypt renewal should refresh it automatically"
                                    .to_string(),
                            );
                    }
                    "external-tls-san-mismatch"
                        if status.tls_status != DeploymentProbeStatus::Ready =>
                    {
                        status.error = Some(
                                "Relay v2 TLS certificate SAN does not match the advertised origin hostname"
                                    .to_string(),
                            );
                    }
                    "center=running" => status.center_status = DeploymentProbeStatus::Running,
                    "center=stopped" => status.center_status = DeploymentProbeStatus::Stopped,
                    _ => {
                        if let Some(version) = line.strip_prefix("center-version=") {
                            let version = version.trim();
                            if valid_center_running_version(version) {
                                status.running_bundle_version = Some(version.to_string());
                            }
                        }
                    }
                }
            }
        }
        Err(error) => status.error = Some(error),
    }
    status.center_version_stale = center_running_version_is_stale(
        status.center_status,
        status.running_bundle_version.as_deref(),
    );
    if config.external_tls_management && status.tls_status == DeploymentProbeStatus::Ready {
        let chain_ready = local_host_ca_input_path().is_ok_and(|path| {
            read_local_private_file(
                &path.to_string_lossy(),
                "external TLS chain certificate",
                MAX_TLS_FILE_BYTES,
            )
            .is_ok()
        });
        if !chain_ready {
            status.tls_status = DeploymentProbeStatus::Missing;
            status.error = Some(
                "External TLS chain is not available locally; run Deploy to fetch the Let's Encrypt chain from the devbox"
                    .to_string(),
            );
        }
    }
    status
}

fn self_hosted_connector_prerequisites_are_complete(config: &PersistedSelfHostedConfig) -> bool {
    config.schema_version == CONFIG_SCHEMA_VERSION
        && config.enabled
        && config.profile_provisioned
        && config.host_credential_provisioned
        && !config.management_recovery_required
        && !config.bootstrap_rotation_pending
        && config.bootstrap_rotation_request_phase.is_none()
        && config.bootstrap_rotation_transfer_receipt.is_none()
        && config.bootstrap_file_name.is_none()
        && config.bootstrap_publication_correlation.is_none()
}

fn self_hosted_connector_should_be_running(
    config: &PersistedSelfHostedConfig,
    status: &MobileRelayV2SelfHostedStatus,
) -> bool {
    self_hosted_connector_prerequisites_are_complete(config)
        && config.connector_desired_running
        && status.error.is_none()
        && status.configured
        && status.bundle_status == DeploymentProbeStatus::Ready
        && status.tls_status == DeploymentProbeStatus::Ready
        && status.center_status == DeploymentProbeStatus::Running
}

fn self_hosted_connector_should_survive_dashboard_window_close(
    config: &PersistedSelfHostedConfig,
) -> bool {
    config.connector_desired_running
}

pub(crate) fn relay_v2_connector_should_survive_dashboard_window_close() -> bool {
    load_config()
        .ok()
        .flatten()
        .is_some_and(|config| self_hosted_connector_should_survive_dashboard_window_close(&config))
}

pub(crate) fn restore_relay_v2_self_hosted_connector_desired_state(
    state: &MobileRelayV2SelfHostedDeploymentState,
    management: &MobileRelayV2ManagementCommandState,
    expected_binding: &SelfHostedManagementBinding,
) -> Result<(), String> {
    let mut owner = state
        .operation
        .lock()
        .map_err(|_| "Relay v2 deployment owner is unavailable".to_string())?;
    let result = (|| {
        if owner.active_management.as_ref() != Some(expected_binding) {
            return Err("Relay v2 self-hosted management binding changed".to_string());
        }
        let Some(config) = load_config()? else {
            return Err("Relay v2 self-hosted configuration disappeared".to_string());
        };
        if !config.connector_desired_running {
            return Ok(());
        }
        let config = revalidate_current_management_binding(expected_binding)?;
        if !self_hosted_connector_prerequisites_are_complete(&config) {
            return Err("Relay v2 self-hosted management prerequisites changed".to_string());
        }
        let status = probe_status(&config);
        if !self_hosted_connector_should_be_running(&config, &status) {
            return Err("Relay v2 self-hosted restore prerequisites are not ready".to_string());
        }
        management
            .restore_self_hosted_connector_desired_state(&expected_binding.steady_launch_key)
            .map_err(|_| {
                "Relay v2 self-hosted Host desired state could not be restored".to_string()
            })
    })();
    owner.startup_restore_error = result
        .as_ref()
        .err()
        .map(|_| "Relay v2 self-hosted Host startup restore failed".to_string());
    result
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ConnectorWatchdogReconcileOutcome {
    Healthy,
    /// The child is ALIVE and its connector cut is retryable (e.g. the relay
    /// center or a configured SSH scope is unreachable; Kerberos expired). The
    /// child's own composition retry loop owns the backoff and the 30s rescan,
    /// so the watchdog neither rebuilds nor writes config: it only backs off.
    /// Rebuilding here would reset the very rescan timer that recovers the cut.
    Deferred,
    Retry,
    Superseded,
}

fn next_connector_watchdog_retry_delay(current: Duration) -> Duration {
    current
        .checked_mul(2)
        .unwrap_or(CONNECTOR_WATCHDOG_MAX_RETRY_DELAY)
        .min(CONNECTOR_WATCHDOG_MAX_RETRY_DELAY)
}

/// Map the in-lock repair classification taken at the top of a watchdog tick.
/// `None` means "fall through to the lock-free remote probe and the bounded
/// rebuild path". Pure so the decision table is unit-testable without an
/// AppHandle or a management child.
fn initial_watchdog_repair_outcome(
    repair: SelfHostedConnectorRepair,
    escalate_stall: bool,
) -> Option<ConnectorWatchdogReconcileOutcome> {
    match repair {
        SelfHostedConnectorRepair::Accepted => Some(ConnectorWatchdogReconcileOutcome::Healthy),
        // Without stall escalation a retrying child owns its own recovery; with
        // escalation armed the bounded 10-minute safety net deliberately takes
        // the probe/rebuild path even for a retryable cut.
        SelfHostedConnectorRepair::ChildRetrying if !escalate_stall => {
            Some(ConnectorWatchdogReconcileOutcome::Deferred)
        }
        SelfHostedConnectorRepair::ChildRetrying | SelfHostedConnectorRepair::RebuildRequired => {
            None
        }
    }
}

/// Map the repair classification observed AFTER this tick committed a rebuild.
/// A replacement whose cut is already retrying is still alive and owns its next
/// attempt: report Deferred rather than immediately scheduling another rebuild.
fn post_rebuild_watchdog_outcome(
    repair: SelfHostedConnectorRepair,
) -> ConnectorWatchdogReconcileOutcome {
    match repair {
        SelfHostedConnectorRepair::Accepted => ConnectorWatchdogReconcileOutcome::Healthy,
        SelfHostedConnectorRepair::ChildRetrying => ConnectorWatchdogReconcileOutcome::Deferred,
        SelfHostedConnectorRepair::RebuildRequired => ConnectorWatchdogReconcileOutcome::Retry,
    }
}

/// Resolution of Start Center's bounded base-readiness wait, evaluated only
/// AFTER `connector_desired_running=true` is durable and `active_management`
/// is published. There is deliberately no "abort before the watchdog is
/// armed" variant: every failure observed here leaves a binding whose
/// persisted desired state says "running", so in-session supervision must own
/// it from this point. Returning the wait error with `?` here used to skip
/// the arm: a first Start during a relay-center/SSH outage surfaced the soft
/// "retrying automatically" notice while leaving dead-child rebuild,
/// remote-center reboot repair, and the 600s stall escalation unstarted until
/// the Dashboard was relaunched.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CommittedStartReadiness {
    /// Base readiness reached: the command returns the live probed status.
    Ready,
    /// The connector cut was still Failed{retryable:true} at the deadline; the
    /// child's own composition retry owns the next attempt. Surface the
    /// reachability notice after arming the watchdog.
    Retrying,
    /// Any other wait failure (a terminal cut reached mid-wait, or a transport
    /// error such as the child dying during the wait). Surface the failure
    /// after arming; the watchdog's probe/rebuild path owns recovery.
    NotReady,
}

impl CommittedStartReadiness {
    /// The renderer-facing error for this outcome, or `None` when Start Center
    /// should return the probed status. The caller arms the watchdog BEFORE
    /// acting on this, so a surfaced message never implies "unsupervised".
    fn surfaced_error(self) -> Option<&'static str> {
        match self {
            CommittedStartReadiness::Ready => None,
            CommittedStartReadiness::Retrying => Some(
                "Relay v2 self-hosted Host is retrying its relay connection automatically; the relay center or a configured SSH host is not reachable yet",
            ),
            CommittedStartReadiness::NotReady => Some(
                "Relay v2 self-hosted Host did not register with all six required capabilities",
            ),
        }
    }
}

fn committed_start_readiness_outcome(
    wait_result: Result<(), ManagementError>,
) -> CommittedStartReadiness {
    match wait_result {
        Ok(()) => CommittedStartReadiness::Ready,
        Err(ref error)
            if MobileRelayV2ManagementCommandState::management_error_is_connector_retrying(
                error,
            ) =>
        {
            CommittedStartReadiness::Retrying
        }
        Err(_) => CommittedStartReadiness::NotReady,
    }
}

/// Pure watchdog backoff/stall state, split out of the watchdog thread so the
/// doubling retry backoff and the 10-minute stall escalation are testable
/// without threads or sleeps. `observe` records the outcome of the reconcile
/// that just ran and returns `(delay_before_the_next_reconcile,
/// escalate_the_next_reconcile)`; the thread owns only the sleep and passing
/// the escalation flag back into the next reconcile call.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ConnectorWatchdogSchedule {
    /// Doubling Deferred/Retry backoff, capped at
    /// CONNECTOR_WATCHDOG_MAX_RETRY_DELAY; reset to the initial delay by any
    /// Healthy observation (Deferred backs off exactly like Retry).
    retry_delay: Duration,
    /// Wall-clock instant of the first Deferred in the current unhealthy run.
    /// Kept across consecutive Deferred/Retry ticks and cleared by Healthy; it
    /// is also reset to None the moment a stall escalation is armed, so two
    /// escalations cannot land less than
    /// CONNECTOR_WATCHDOG_STALL_REBUILD_AFTER apart even when the escalated
    /// rebuild itself comes back Deferred.
    deferred_since: Option<Instant>,
}

impl ConnectorWatchdogSchedule {
    fn new() -> Self {
        Self {
            retry_delay: CONNECTOR_WATCHDOG_INITIAL_DELAY,
            deferred_since: None,
        }
    }

    fn observe(
        &mut self,
        outcome: ConnectorWatchdogReconcileOutcome,
        now: Instant,
    ) -> (Duration, bool) {
        match outcome {
            ConnectorWatchdogReconcileOutcome::Healthy => {
                self.retry_delay = CONNECTOR_WATCHDOG_INITIAL_DELAY;
                self.deferred_since = None;
                (CONNECTOR_WATCHDOG_HEALTHY_INTERVAL, false)
            }
            ConnectorWatchdogReconcileOutcome::Retry => {
                // Retry belongs to the same unhealthy run as the Deferred ticks
                // around it: keep the stall timer, never arm an escalation, and
                // share the doubling backoff.
                let delay = self.retry_delay;
                self.retry_delay = next_connector_watchdog_retry_delay(self.retry_delay);
                (delay, false)
            }
            ConnectorWatchdogReconcileOutcome::Deferred => {
                let run_started = self.deferred_since.unwrap_or(now);
                let delay = self.retry_delay;
                self.retry_delay = next_connector_watchdog_retry_delay(self.retry_delay);
                if now.duration_since(run_started) >= CONNECTOR_WATCHDOG_STALL_REBUILD_AFTER {
                    // Arm the one-shot escalation for the NEXT reconcile and
                    // restart the stall timer immediately afterwards.
                    self.deferred_since = None;
                    (delay, true)
                } else {
                    self.deferred_since = Some(run_started);
                    (delay, false)
                }
            }
            // The watchdog thread exits on Superseded without another tick;
            // leave the state frozen and never ask for an escalation.
            ConnectorWatchdogReconcileOutcome::Superseded => (self.retry_delay, false),
        }
    }
}

fn reconcile_relay_v2_self_hosted_connector_desired_state(
    app: &tauri::AppHandle,
    state: &MobileRelayV2SelfHostedDeploymentState,
    management: &MobileRelayV2ManagementCommandState,
    expected_binding: &SelfHostedManagementBinding,
    escalate_stall: bool,
) -> ConnectorWatchdogReconcileOutcome {
    // Decision table (all fencing unchanged; only the repair classification is
    // new):
    //
    //   Accepted (cut Ready/Starting) ....................... Healthy
    //   ChildRetrying, !escalate_stall (cut failed{retryable},
    //     stopped/starting-without-host, credential not ready,
    //     or any other ALIVE projection after a non-transport error) . Deferred
    //   ChildRetrying, escalate_stall (>=10 min deferred) .... probe/rebuild
    //   RebuildRequired (terminal cut: failed non-retryable /
    //     superseded / malformed projection / dead channel) .. probe/rebuild
    //
    // A retryable cut means the child PROCESS is alive and its composition
    // retry loop already owns the next start attempt (it rescans SSH scope
    // coverage every 30s). Rebuilding would drain that child and reset the very
    // rescan timer that would recover it — observed in production as 1699 churn
    // spawns during a Kerberos outage — so Deferred returns from inside Phase 1
    // with NO lock-free probe, NO prepare_prerequisites and NO save_config. The
    // one bounded exception is the 10-minute stall escalation
    // (CONNECTOR_WATCHDOG_STALL_REBUILD_AFTER): the safety net for an unknown
    // wedge where the child is alive but its retry loop is not progressing.
    //
    // The deployment owner mutex serializes management mutations (start, stop,
    // replacement) with the watchdog: a user-requested stop cannot race with a
    // stale watchdog decision and be undone after the stop returns. The mutex
    // is std::sync (not reentrant). The dominant black-hole stall — the
    // read-only remote probe_status (SSH ServerAlive rounds ≈45s on an
    // unreachable devbox), which previously ran every tick WHILE the lock was
    // held — is performed lock-free (Phase 2). Start_center and the local
    // child replacement re-acquire the lock (Phase 3) and operate on a FRESH
    // config so their full-struct save_config is fenced and cannot clobber a
    // concurrent Save/Deploy; only a deterministic Stopped reading ever reaches
    // start_center, so the lock is never held across SSH against an
    // unreachable devbox.
    let config_snapshot = {
        let Ok(owner) = state.operation.lock() else {
            return ConnectorWatchdogReconcileOutcome::Retry;
        };
        if owner.active_management.as_ref() != Some(expected_binding) {
            return ConnectorWatchdogReconcileOutcome::Superseded;
        }
        let Ok(Some(config)) = load_config() else {
            return ConnectorWatchdogReconcileOutcome::Retry;
        };
        if !expected_binding.matches_config(&config) {
            return ConnectorWatchdogReconcileOutcome::Superseded;
        }
        if !config.connector_desired_running {
            return ConnectorWatchdogReconcileOutcome::Healthy;
        }
        if !self_hosted_connector_prerequisites_are_complete(&config) {
            return ConnectorWatchdogReconcileOutcome::Retry;
        }
        // Local management IPC (no network): stays in the fenced critical
        // section. Accepted → Healthy; a live retrying child → Deferred without
        // any probe or disk write; only a terminal/dead cut (or an armed stall
        // escalation) falls through to the lock-free probe + rebuild path.
        let repair =
            management.classify_self_hosted_connector_repair(&expected_binding.steady_launch_key);
        if let Some(outcome) = initial_watchdog_repair_outcome(repair, escalate_stall) {
            return outcome;
        }
        config
    };

    // The connector reaches the remote relay-center over WSS. If the devbox
    // rebooted (or its tmux server was killed), the remote center session is
    // gone and rebuilding the local management child cannot help — every ensure
    // would keep failing and the watchdog would churn-spawn a fresh child each
    // tick. Re-probe the remote center before any local rebuild.
    //
    // Network phase (read-only): probe_status runs WITHOUT the deployment lock
    // so a black-holed devbox never parks Stop/Deploy/Save (which take the same
    // lock) for ~45s every tick. Only a DETERMINISTIC Stopped reading (the probe
    // script ran and tmux has-session failed) triggers a remote start; Unknown
    // (a black-holed devbox / SSH failure, the base default) falls through to
    // the bounded local-rebuild + Retry backoff instead of hammering
    // start_center.
    let center_status = Some(probe_status(&config_snapshot).center_status);
    let remote_action = remote_center_repair_action(center_status);

    // Phase 3: re-acquire the deployment lock and re-validate every fence from a
    // FRESH config before any mutation. A Stop/Deploy/Save that landed during
    // the lock-free probe must Supersede this reconcile so the watchdog never
    // undoes it. start_center (which finishes with a full-struct save_config)
    // and restart_self_hosted (spawn + readiness IPC, bounded by
    // STARTUP_TIMEOUT) both run INSIDE the lock on that fresh config: they are
    // the desired-state management fence, and start_center is only reached on a
    // deterministic Stopped reading, so the lock is never held across SSH to an
    // unreachable devbox.
    {
        let Ok(owner) = state.operation.lock() else {
            return ConnectorWatchdogReconcileOutcome::Retry;
        };
        if owner.active_management.as_ref() != Some(expected_binding) {
            return ConnectorWatchdogReconcileOutcome::Superseded;
        }
        let Ok(Some(mut config)) = load_config() else {
            return ConnectorWatchdogReconcileOutcome::Retry;
        };
        if !expected_binding.matches_config(&config) {
            return ConnectorWatchdogReconcileOutcome::Superseded;
        }
        if !config.connector_desired_running {
            return ConnectorWatchdogReconcileOutcome::Healthy;
        }
        if !self_hosted_connector_prerequisites_are_complete(&config) {
            return ConnectorWatchdogReconcileOutcome::Retry;
        }
        if remote_action == RemoteCenterRepairAction::StartRemote {
            // Freshly load → mutate → save under the lock; a Save/Deploy that
            // landed during the probe is fenced off above.
            if start_center(&mut config).is_err() {
                return ConnectorWatchdogReconcileOutcome::Retry;
            }
            // The remote center came up; the next tick drives ensure against it.
            return ConnectorWatchdogReconcileOutcome::Retry;
        }

        // Rebuild that exact child only after the durable binding and
        // desired-state fences above have both been revalidated.
        let Ok(Some(prepared)) = prepare_relay_v2_self_hosted_management_prerequisites() else {
            return ConnectorWatchdogReconcileOutcome::Retry;
        };
        let Ok(replacement_binding) = prepared.management_binding() else {
            return ConnectorWatchdogReconcileOutcome::Retry;
        };
        if replacement_binding != *expected_binding {
            return ConnectorWatchdogReconcileOutcome::Superseded;
        }
        let selection = prepared.selection();
        if management
            .restart_self_hosted(app, selection, move || prepared.commit_ready())
            .is_err()
        {
            return ConnectorWatchdogReconcileOutcome::Retry;
        }
        // Re-classify rather than a bare ensure: when the freshly committed
        // replacement is alive but its cut is still retryable (the relay center
        // or an SSH scope is still unreachable), its own retry loop owns the
        // next attempt and the tick is Deferred instead of scheduling another
        // rebuild on the following tick.
        let repair =
            management.classify_self_hosted_connector_repair(&expected_binding.steady_launch_key);
        post_rebuild_watchdog_outcome(repair)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RemoteCenterRepairAction {
    /// The remote tmux center is down and must be (idempotently) started
    /// before rebuilding the local management child is worthwhile.
    StartRemote,
    /// The remote center is already running; rebuild the local child.
    RebuildLocal,
}

/// Decide the watchdog's repair action for an unhealthy connector from the
/// observed remote center status (None when prerequisites are incomplete or
/// the probe could not be run). Pure and unit-testable: this is the remote
/// supervision that previously did not exist — a devbox reboot / tmux kill left
/// the center down permanently because only a manual Start Center brought it
/// back and restarting the Dashboard did not either.
///
/// Only a *deterministic* Stopped reading (the probe script ran and
/// `tmux has-session` failed) triggers a remote start. Unknown means the SSH
/// probe never ran — a black-holed devbox / SSH failure leaves center_status at
/// its default Unknown with only `status.error` set — so treating it as
/// StartRemote would run a full bootstrap (scp + many SSH round-trips) on every
/// watchdog tick while holding the deployment lock, re-introducing the
/// hold-lock stall this supervision was meant to remove. Unknown/Ready/Missing
/// and None are uncertain: fall back to the local rebuild + bounded Retry
/// backoff so a deterministic black hole waits in backoff instead of hammering
/// start_center.
fn remote_center_repair_action(
    center_status: Option<DeploymentProbeStatus>,
) -> RemoteCenterRepairAction {
    match center_status {
        Some(DeploymentProbeStatus::Running) => RemoteCenterRepairAction::RebuildLocal,
        Some(DeploymentProbeStatus::Stopped) => RemoteCenterRepairAction::StartRemote,
        Some(DeploymentProbeStatus::Unknown)
        | Some(DeploymentProbeStatus::Ready)
        | Some(DeploymentProbeStatus::Missing)
        | None => RemoteCenterRepairAction::RebuildLocal,
    }
}

pub(crate) fn start_relay_v2_self_hosted_connector_desired_state_watchdog(
    app: tauri::AppHandle,
    state: Weak<MobileRelayV2SelfHostedDeploymentState>,
    management: Weak<MobileRelayV2ManagementCommandState>,
    expected_binding: SelfHostedManagementBinding,
) {
    arm_connector_desired_state_watchdog(&app, &state, &management, expected_binding);
}

/// Spawn a connector desired-state watchdog for a freshly published binding.
/// This is shared by the app-startup restore path (lib.rs) and the Start
/// Center / rotate commands: before this, a watchdog was only armed at startup,
/// so an in-app first Deploy+Start (or a rotate) left the management child
/// unsupervised and it stayed dead until the Dashboard was restarted.
pub(crate) fn arm_connector_desired_state_watchdog(
    app: &tauri::AppHandle,
    state: &Weak<MobileRelayV2SelfHostedDeploymentState>,
    management: &Weak<MobileRelayV2ManagementCommandState>,
    expected_binding: SelfHostedManagementBinding,
) {
    let _ = thread::Builder::new()
        .name("relay-v2-host-watchdog".to_string())
        .spawn({
            let app = app.clone();
            let state = state.clone();
            let management = management.clone();
            move || {
                // Backoff and stall-escalation bookkeeping lives in the pure
                // ConnectorWatchdogSchedule so it is covered by unit tests; this
                // thread only sleeps the returned delay and forwards the
                // one-shot escalation flag into the next reconcile.
                let mut schedule = ConnectorWatchdogSchedule::new();
                let mut next_delay = CONNECTOR_WATCHDOG_INITIAL_DELAY;
                let mut escalate_stall = false;
                loop {
                    thread::sleep(next_delay);
                    let (Some(state), Some(management)) = (state.upgrade(), management.upgrade())
                    else {
                        return;
                    };
                    let outcome = reconcile_relay_v2_self_hosted_connector_desired_state(
                        &app,
                        state.as_ref(),
                        management.as_ref(),
                        &expected_binding,
                        escalate_stall,
                    );
                    match outcome {
                        ConnectorWatchdogReconcileOutcome::Superseded => return,
                        outcome => {
                            let (scheduled_delay, escalate_next) =
                                schedule.observe(outcome, Instant::now());
                            next_delay = scheduled_delay;
                            // Consumed one-shot: observe() decides whether the
                            // NEXT reconcile must escalate, so a rebuild that
                            // came back Retry/Healthy never escalates twice.
                            escalate_stall = escalate_next;
                        }
                    }
                }
            }
        });
}

fn management_operation_failed_error() -> ManagementError {
    ManagementError {
        code: "OPERATION_FAILED".to_string(),
        message: "Relay v2 management operation failed".to_string(),
        retryable: false,
    }
}

fn persist_connector_desired_running(
    config: &mut PersistedSelfHostedConfig,
    desired_running: bool,
) -> Result<(), String> {
    if config.connector_desired_running == desired_running {
        return Ok(());
    }
    config.connector_desired_running = desired_running;
    save_config(config)
}

pub(crate) fn call_relay_v2_self_hosted_connector_operation(
    state: &MobileRelayV2SelfHostedDeploymentState,
    management: &MobileRelayV2ManagementCommandState,
    operation: MobileRelayV2ManagementOperation,
) -> Option<Result<ManagementOutcome, ManagementError>> {
    if !matches!(
        operation,
        MobileRelayV2ManagementOperation::StartConnector
            | MobileRelayV2ManagementOperation::StopConnector
    ) {
        return None;
    }
    let mut owner = match state.operation.lock() {
        Ok(owner) => owner,
        Err(_) => return Some(Err(management_operation_failed_error())),
    };
    let mut config = match load_config() {
        Ok(Some(config)) => config,
        Ok(None) => return None,
        Err(_) => return Some(Err(management_operation_failed_error())),
    };
    if ensure_host_profile_identity(&mut config).is_err() {
        return Some(Err(management_operation_failed_error()));
    }
    let result = match operation {
        MobileRelayV2ManagementOperation::StartConnector => {
            let Some(binding) = owner.active_management.clone() else {
                return Some(Err(management_operation_failed_error()));
            };
            config = match revalidate_current_management_binding(&binding) {
                Ok(config) => config,
                Err(_) => return Some(Err(management_operation_failed_error())),
            };
            if !self_hosted_connector_prerequisites_are_complete(&config) {
                return Some(Err(management_operation_failed_error()));
            }
            let outcome = match management.start_self_hosted_connector(&binding.steady_launch_key) {
                Ok(outcome) => outcome,
                Err(error) => return Some(Err(error)),
            };
            if persist_connector_desired_running(&mut config, true).is_err() {
                let _ = management
                    .stop_self_hosted_connector_for_launch_key(Some(&binding.steady_launch_key));
                return Some(Err(management_operation_failed_error()));
            }
            Ok(outcome)
        }
        MobileRelayV2ManagementOperation::StopConnector => {
            if persist_connector_desired_running(&mut config, false).is_err() {
                return Some(Err(management_operation_failed_error()));
            }
            owner.startup_restore_error = None;
            let launch_key = owner
                .active_management
                .as_ref()
                .map(|binding| binding.steady_launch_key.clone());
            management.stop_self_hosted_connector_for_launch_key(launch_key.as_ref())
        }
        _ => unreachable!("connector operation was closed above"),
    };
    if result.is_ok() {
        owner.startup_restore_error = None;
    }
    Some(result)
}

fn current_status() -> MobileRelayV2SelfHostedStatus {
    match load_config() {
        Ok(Some(config)) => probe_status(&config),
        Ok(None) => base_status(None, None),
        Err(error) => base_status(None, Some(error)),
    }
}

fn validate_local_bundle_tree(root: &Path) -> Result<(), String> {
    let mut pending = vec![root.to_path_buf()];
    while let Some(path) = pending.pop() {
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|_| "canonical tw-cli bundle is unavailable".to_string())?;
        if metadata.file_type().is_dir() {
            for entry in std::fs::read_dir(&path)
                .map_err(|_| "canonical tw-cli bundle is unavailable".to_string())?
            {
                pending.push(
                    entry
                        .map_err(|_| "canonical tw-cli bundle is unavailable".to_string())?
                        .path(),
                );
            }
        } else if !metadata.file_type().is_file() {
            return Err("canonical tw-cli bundle contains an unsafe entry".to_string());
        }
    }
    Ok(())
}

fn canonical_bundle_source(app: &tauri::AppHandle) -> Result<CanonicalBundleSource, String> {
    let mut candidates = Vec::new();
    if let Ok(resources) = app.path().resource_dir() {
        candidates.push(resources.join("tw-cli"));
    }
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../dist"));
    for directory in candidates {
        if !directory.is_dir() || !directory.join("cli.cjs").is_file() {
            continue;
        }
        let is_regular = |path: &Path| {
            std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_file())
        };
        let package_json = if is_regular(&directory.join("package.json")) {
            directory.join("package.json")
        } else {
            match directory
                .parent()
                .map(|parent| parent.join("package.json"))
                .filter(|path| is_regular(path))
            {
                Some(path) => path,
                None => continue,
            }
        };
        validate_local_bundle_tree(&directory)?;
        return Ok(CanonicalBundleSource {
            directory,
            package_json,
        });
    }
    Err("bundled canonical tw-cli directory and package boundary not found".to_string())
}

fn publish_remote_private_bytes(
    host: &HostConfig,
    contents: &[u8],
    remote_path: &str,
) -> Result<(), String> {
    let stage = format!("{remote_path}.stage-{}", uuid::Uuid::new_v4().simple());
    let script = format!(
        r#"{REMOTE_SECURITY_FUNCTIONS}
set -eu
umask 077
ensure_relay_layout
target="$HOME/{remote_path}"
stage="$HOME/{stage}"
if test -e "$target" || test -L "$target"; then require_private_file "$target"; fi
test ! -e "$stage"
test ! -L "$stage"
trap 'rm -f -- "$stage"' EXIT HUP INT TERM
set -C
cat > "$stage"
set +C
chmod 600 "$stage"
require_private_file "$stage"
mv -Tf "$stage" "$target"
require_private_file "$target"
trap - EXIT HUP INT TERM
"#
    );
    let output = run_remote_cmd_with_input(host, &["sh", "-lc", &script], contents)?;
    if !output.status.success() {
        return Err(format!(
            "publish Relay v2 private file on {} failed",
            host.label
        ));
    }
    Ok(())
}

fn publish_remote_profile(
    host: &HostConfig,
    config: &PersistedSelfHostedConfig,
) -> Result<(), String> {
    let profile = serde_json::json!({
        "contract": CONFIG_CONTRACT,
        "schemaVersion": REMOTE_PROFILE_SCHEMA_VERSION,
        "deploymentFingerprint": deployment_fingerprint(config),
        "issuerUrl": config.issuer_url,
        "listenHost": config.listen_host,
        "listenPort": config.listen_port,
        "tlsKeyPath": format!("~/{REMOTE_TLS_KEY}"),
        "tlsCertificatePath": format!("~/{REMOTE_TLS_CERTIFICATE}"),
        "tlsCaPath": format!("~/{REMOTE_TLS_CA}"),
        "stateDirectory": format!("~/{REMOTE_STATE_DIRECTORY}"),
    });
    let mut bytes = serde_json::to_vec_pretty(&profile)
        .map_err(|error| format!("serialize remote Relay v2 profile: {error}"))?;
    bytes.push(b'\n');
    publish_remote_private_bytes(host, &bytes, REMOTE_PROFILE)
}

fn build_remote_bundle_stage_validation_script(remote_stage: &str) -> String {
    format!(
        r#"{REMOTE_SECURITY_FUNCTIONS}
set -eu
require_relay_layout
stage="$HOME/{remote_stage}"
normalize_bundle_tree "$stage"
require_bundle_tree "$stage"
require_private_file "$stage/cli.cjs"
require_private_file "$stage/package.json"
"#
    )
}

fn build_remote_bundle_publish_script(
    remote_stage: &str,
    bundle_name: &str,
    deployment_id: &str,
    version: &str,
) -> String {
    format!(
        r#"{REMOTE_SECURITY_FUNCTIONS}
set -eu
require_relay_layout
root="$HOME/{REMOTE_ROOT}"
stage="$HOME/{remote_stage}"
require_bundle_tree "$stage"
require_private_file "$stage/cli.cjs"
require_private_file "$stage/package.json"
test "$(/usr/bin/env node "$stage/cli.cjs" version)" = {version}
target="$root/bundles/{bundle_name}"
test ! -e "$target"
test ! -L "$target"
mv "$stage" "$target"
require_bundle_tree "$target"
next="$root/.current-{deployment_id}"
test ! -e "$next"
test ! -L "$next"
ln -s "bundles/{bundle_name}" "$next"
mv -Tf "$next" "$root/current"
require_current_bundle
"#,
        version = shell_quote(version),
    )
}

fn deploy_bundle(app: &tauri::AppHandle, config: &PersistedSelfHostedConfig) -> Result<(), String> {
    let host = find_host(&config.broker_host_id)?;
    let source = canonical_bundle_source(app)?;
    let deployment_id = uuid::Uuid::new_v4().simple().to_string();
    let remote_stage = format!("{REMOTE_ROOT}/.bundle-stage-{deployment_id}");
    run_remote_cmd_check_strings(
        &host,
        &[
            "sh".into(),
            "-lc".into(),
            format!(
                r#"{REMOTE_SECURITY_FUNCTIONS}
set -eu
umask 077
ensure_relay_layout
require_relay_layout
test ! -e "$HOME/{remote_stage}"
test ! -L "$HOME/{remote_stage}"
"#
            ),
        ],
    )?;
    scp_directory_to_host(&host, &source.directory, &remote_stage)?;
    scp_cli_to_host(
        &host,
        &source.package_json,
        &format!("{remote_stage}/package.json"),
    )?;
    run_remote_cmd_check_strings(
        &host,
        &[
            "sh".into(),
            "-lc".into(),
            build_remote_bundle_stage_validation_script(&remote_stage),
        ],
    )?;
    let version = env!("CARGO_PKG_VERSION");
    let bundle_name = format!("dashboard-{version}-{deployment_id}");
    let publish_script =
        build_remote_bundle_publish_script(&remote_stage, &bundle_name, &deployment_id, version);
    run_remote_cmd_check_strings(&host, &["sh".into(), "-lc".into(), publish_script])?;
    if config.external_tls_management {
        // Externally managed TLS: never generate or overwrite the remote
        // tls.key/tls.crt/ca.pem. Validate the Let's Encrypt cert in place and
        // pull the public chain back so the Mac-side management child trusts it.
        verify_external_tls_and_fetch_chain(&host, config)?;
    } else {
        let tls_key =
            read_local_private_file(&config.tls_key_path, "TLS private key", MAX_TLS_FILE_BYTES)?;
        let tls_certificate = read_local_private_file(
            &config.tls_certificate_path,
            "TLS leaf certificate",
            MAX_TLS_FILE_BYTES,
        )?;
        let tls_ca = read_local_private_file(
            &config.tls_ca_path,
            "TLS CA certificate",
            MAX_TLS_FILE_BYTES,
        )?;
        if tls_certificate.bytes == tls_ca.bytes {
            return Err("TLS CA certificate must not be the Broker leaf certificate".to_string());
        }
        publish_remote_private_bytes(&host, &tls_key.bytes, REMOTE_TLS_KEY)?;
        publish_remote_private_bytes(&host, &tls_certificate.bytes, REMOTE_TLS_CERTIFICATE)?;
        publish_remote_private_bytes(&host, &tls_ca.bytes, REMOTE_TLS_CA)?;
    }
    publish_remote_profile(&host, config)
}

fn issuer_hostname(issuer_url: &str) -> Result<String, String> {
    let parsed =
        tauri::Url::parse(issuer_url).map_err(|_| "saved Relay URL is invalid".to_string())?;
    parsed
        .host_str()
        .map(str::to_string)
        .ok_or_else(|| "saved Relay URL has no hostname".to_string())
}

fn build_remote_external_tls_validation_script(hostname: &str) -> String {
    format!(
        r#"{REMOTE_SECURITY_FUNCTIONS}
set -eu
require_relay_layout
require_private_file "$HOME/{REMOTE_TLS_KEY}"
require_private_file "$HOME/{REMOTE_TLS_CERTIFICATE}"
if ! command -v openssl >/dev/null 2>&1; then
  printf 'external-tls-error: openssl is required on the devbox\n'
  exit 1
fi
san="$(openssl x509 -in "$HOME/{REMOTE_TLS_CERTIFICATE}" -noout -ext subjectAltName 2>/dev/null || true)"
case "$san" in
  *"DNS:{hostname}"*) ;;
  *)
    printf 'external-tls-error: certificate SAN does not match {hostname}\n'
    exit 1
    ;;
esac
if ! openssl x509 -in "$HOME/{REMOTE_TLS_CERTIFICATE}" -noout -checkend 0 >/dev/null 2>&1; then
  printf 'external-tls-error: certificate has expired\n'
  exit 1
fi
require_private_file "$HOME/{REMOTE_TLS_CA}"
node - "$HOME/{REMOTE_TLS_CA}" "{MAX_TLS_FILE_BYTES}" <<'TW_RELAY_V2_EXTERNAL_TLS_CHAIN_READER'
{REMOTE_BOOTSTRAP_FD_READER}
TW_RELAY_V2_EXTERNAL_TLS_CHAIN_READER
"#
    )
}

/// Node's TLS `ca:` option treats the whole file as one CA entry with a 16 KiB
/// per-entry cap (see src/relay/v2/hostTlsTrustMaterial.ts
/// RELAY_V2_HOST_TLS_CA_MAX_ENTRY_BYTES = 16_384). The LE chain plus the ISRG
/// Root X1 anchor is ~5.5 KiB, but if a future chain plus the anchor would
/// exceed this cap, skip appending and keep the original bytes so the
/// Node-side trust material capture keeps working.
const NODE_TLS_CA_MAX_ENTRY_BYTES: usize = 16_384;

/// Strips all ASCII whitespace from a PEM base64 body so that line-wrapping
/// differences do not defeat certificate comparisons.
fn normalized_pem_body(body: &str) -> String {
    body.chars().filter(|c| !c.is_ascii_whitespace()).collect()
}

/// Returns the whitespace-normalized base64 bodies of every CERTIFICATE block
/// in `pem`.
fn certificate_bodies(pem: &str) -> Vec<String> {
    let mut bodies = Vec::new();
    for block in pem.split("-----BEGIN CERTIFICATE-----").skip(1) {
        if let Some(end) = block.find("-----END CERTIFICATE-----") {
            bodies.push(normalized_pem_body(&block[..end]));
        }
    }
    bodies
}

fn bundle_contains_isrg_root_x1(bundle: &[u8]) -> bool {
    let text = std::str::from_utf8(bundle).unwrap_or("");
    let Some(needle) = certificate_bodies(ISRG_ROOT_X1_PEM).into_iter().next() else {
        return false;
    };
    certificate_bodies(text).iter().any(|body| body == &needle)
}

/// Makes a pulled CA bundle self-contained for Node's TLS `ca:` option (which
/// replaces the system trust store): if the bundle does not already contain the
/// ISRG Root X1 self-signed anchor, append it separated by exactly one newline.
///
/// Guard rails: if the bundle already contains the root, or if appending would
/// exceed `MAX_TLS_FILE_BYTES` or Node's 16 KiB per-entry cap
/// (`NODE_TLS_CA_MAX_ENTRY_BYTES`), the original bytes are returned unchanged
/// so a Deploy never fails for this.
fn ensure_self_contained_ca_chain(bundle: &[u8]) -> Vec<u8> {
    if bundle_contains_isrg_root_x1(bundle) {
        return bundle.to_vec();
    }
    let mut merged = Vec::with_capacity(bundle.len() + ISRG_ROOT_X1_PEM.len() + 2);
    merged.extend_from_slice(bundle);
    if merged.last() != Some(&b'\n') {
        merged.push(b'\n');
    }
    merged.extend_from_slice(ISRG_ROOT_X1_PEM.as_bytes());
    if merged.last() != Some(&b'\n') {
        merged.push(b'\n');
    }
    if merged.len() as u64 > MAX_TLS_FILE_BYTES || merged.len() > NODE_TLS_CA_MAX_ENTRY_BYTES {
        return bundle.to_vec();
    }
    merged
}

fn verify_external_tls_and_fetch_chain(
    host: &HostConfig,
    config: &PersistedSelfHostedConfig,
) -> Result<(), String> {
    let hostname = issuer_hostname(&config.issuer_url)?;
    let script = build_remote_external_tls_validation_script(&hostname);
    let output = run_remote_cmd_output(host, &["sh", "-lc", &script])?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let detail = if stdout.trim().is_empty() {
            stderr.trim().to_string()
        } else {
            stdout.trim().to_string()
        };
        return Err(format!(
            "External TLS validation on the devbox failed: {detail}"
        ));
    }
    if output.stdout.is_empty() || output.stdout.len() as u64 > MAX_TLS_FILE_BYTES {
        return Err("External TLS chain pulled from the devbox is invalid".to_string());
    }
    ensure_local_host_private_tree()?;
    let local = local_host_ca_input_path()?;
    atomic_write_file(&local, &ensure_self_contained_ca_chain(&output.stdout))?;
    read_local_private_file(
        &local.to_string_lossy(),
        "external TLS chain certificate",
        MAX_TLS_FILE_BYTES,
    )
    .map(|_| ())
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct BootstrapPublicationAttempt {
    file_name: String,
    correlation: String,
}

fn bootstrap_publication_attempt(
    config: &PersistedSelfHostedConfig,
) -> Result<Option<BootstrapPublicationAttempt>, String> {
    match (
        config.bootstrap_file_name.as_deref(),
        config.bootstrap_publication_correlation.as_deref(),
    ) {
        (None, None) => Ok(None),
        (Some(file_name), Some(correlation))
            if valid_bootstrap_publication_correlation(correlation) =>
        {
            Ok(Some(BootstrapPublicationAttempt {
                file_name: file_name.to_string(),
                correlation: correlation.to_string(),
            }))
        }
        _ => Err("Relay v2 Host bootstrap publication attempt is invalid".to_string()),
    }
}

fn build_remote_relay_v2_center_command(
    config: &PersistedSelfHostedConfig,
    bootstrap_attempt: Option<&BootstrapPublicationAttempt>,
) -> String {
    let mut arguments = vec![
        "/usr/bin/env".to_string(),
        "node".to_string(),
        format!("\"$HOME/{REMOTE_ROOT}/current/cli.cjs\""),
        "relay-server".to_string(),
        SELF_HOSTED_FLAG.to_string(),
        AGENT_TRANSCRIPT_LIFECYCLE_FLAG.to_string(),
        AGENT_CHAT_FLAG.to_string(),
        LARK_BINDINGS_FLAG.to_string(),
        "--host".to_string(),
        shell_quote(&config.listen_host),
        "--port".to_string(),
        config.listen_port.to_string(),
        ADVERTISED_ORIGIN_FLAG.to_string(),
        shell_quote(&config.issuer_url),
        TLS_KEY_FLAG.to_string(),
        format!("\"$HOME/{REMOTE_TLS_KEY}\""),
        TLS_CERTIFICATE_FLAG.to_string(),
        format!("\"$HOME/{REMOTE_TLS_CERTIFICATE}\""),
        STATE_DIRECTORY_FLAG.to_string(),
        "\"$relay_v2_state_directory\"".to_string(),
    ];
    if let Some(bootstrap_attempt) = bootstrap_attempt {
        arguments.push("--host-bootstrap-output".to_string());
        arguments.push(format!(
            "\"$HOME/{REMOTE_ROOT}/bootstrap/{}\"",
            bootstrap_attempt.file_name
        ));
        arguments.push(BOOTSTRAP_CORRELATION_FLAG.to_string());
        arguments.push(shell_quote(&bootstrap_attempt.correlation));
    }
    arguments.join(" ")
}

fn center_is_running(host: &HostConfig) -> Result<bool, String> {
    let output = run_remote_cmd_check_strings(
        host,
        &[
            "sh".into(),
            "-lc".into(),
            format!(
                r#"{REMOTE_SECURITY_FUNCTIONS}
set -eu
require_relay_layout
if {} has-session -t {CENTER_SESSION} 2>/dev/null; then printf running; else printf stopped; fi
"#,
                remote_tmux_cmd(host)
            ),
        ],
    )?;
    Ok(output == "running")
}

/// Probe snippet (runs with the probe script's `set -u`, inside the relay
/// layout where `$root` is defined): reports the tmux session state and, when
/// the Center is running, the bundle version its process was started from. The
/// version file is written by the start script and removed by the stop script;
/// a running Center without it predates version tracking. The version is
/// whitelisted to `[0-9A-Za-z._-]` so the probe output line can never carry
/// injected characters.
fn build_remote_center_status_probe_snippet(tmux: &str) -> String {
    format!(
        r#"if {tmux} has-session -t {CENTER_SESSION} 2>/dev/null; then
  printf 'center=running\n'
  running_version_file="$root/{REMOTE_CENTER_RUNNING_VERSION_FILE}"
  if test -f "$running_version_file"; then
    center_running_version="$(head -n 1 "$running_version_file" 2>/dev/null | tr -d '\r\n')"
    case "$center_running_version" in
      '' | *[!0-9A-Za-z._-]*) ;;
      *) printf 'center-version=%s\n' "$center_running_version" ;;
    esac
  fi
else
  printf 'center=stopped\n'
fi
"#
    )
}

/// A running Center is stale (running old broker code) when its recorded
/// version differs from this Dashboard's bundle version. A running Center with
/// no version file was started by an older Dashboard that never recorded one,
/// so it cannot be on the current bundle either; a stopped/unknown Center is
/// never stale (nothing is running).
fn center_running_version_is_stale(
    center_status: DeploymentProbeStatus,
    running_version: Option<&str>,
) -> bool {
    center_status == DeploymentProbeStatus::Running
        && running_version != Some(env!("CARGO_PKG_VERSION"))
}

/// Mirror of the probe script's whitelist: accept only non-empty version
/// strings made of `[0-9A-Za-z._-]`.
fn valid_center_running_version(version: &str) -> bool {
    !version.is_empty()
        && version
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn remote_bootstrap_is_available(
    host: &HostConfig,
    config: &PersistedSelfHostedConfig,
) -> Result<bool, String> {
    let file_name = config
        .bootstrap_file_name
        .as_deref()
        .ok_or("Relay v2 Host bootstrap has not been requested")?;
    let output = run_remote_cmd_check_strings(
        host,
        &[
            "sh".into(),
            "-lc".into(),
            format!(
                r#"{REMOTE_SECURITY_FUNCTIONS}
set -eu
require_relay_layout
file="$HOME/{REMOTE_ROOT}/bootstrap/{file_name}"
if test -e "$file" || test -L "$file"; then
  require_private_file "$file"
  printf ready
else
  printf missing
fi
"#
            ),
        ],
    )?;
    match output.as_str() {
        "ready" => Ok(true),
        "missing" => Ok(false),
        _ => Err("Relay v2 Host bootstrap probe was invalid".to_string()),
    }
}

fn transfer_remote_bootstrap(
    host: &HostConfig,
    config: &PersistedSelfHostedConfig,
) -> Result<(), String> {
    let local_file = write_remote_bootstrap_to_local(host, config)?;
    if cleanup_remote_bootstrap(host, config).is_err() {
        let _ = std::fs::remove_file(&local_file.path);
        return Err("Relay v2 Host bootstrap remote cleanup failed".to_string());
    }
    Ok(())
}

fn write_remote_bootstrap_to_local(
    host: &HostConfig,
    config: &PersistedSelfHostedConfig,
) -> Result<LocalPrivateFile, String> {
    let output = read_remote_bootstrap_bytes(host, config)?;
    ensure_local_host_private_tree()?;
    let local_file = local_bootstrap_path(config)?;
    atomic_write_file(&local_file, &output)?;
    if !secure_bootstrap_file(&local_file) {
        return Err("Relay v2 Host bootstrap local file is unsafe".to_string());
    }
    read_local_private_file(
        &local_file.to_string_lossy(),
        "Relay v2 Host bootstrap input",
        MAX_BOOTSTRAP_RAW_BYTES as u64,
    )
}

fn read_remote_bootstrap_bytes(
    host: &HostConfig,
    config: &PersistedSelfHostedConfig,
) -> Result<Vec<u8>, String> {
    let file_name = config
        .bootstrap_file_name
        .as_deref()
        .ok_or("Relay v2 Host bootstrap has not been requested")?;
    let remote_file = format!("$HOME/{REMOTE_ROOT}/bootstrap/{file_name}");
    let script = build_remote_bootstrap_read_script(&remote_file);
    let output = run_remote_cmd_output(host, &["sh", "-lc", &script])?;
    if !output.status.success() {
        return Err("Relay v2 Host bootstrap transfer is not available".to_string());
    }
    validate_bootstrap_bytes(&output.stdout)?;
    Ok(output.stdout)
}

fn cleanup_remote_bootstrap(
    host: &HostConfig,
    config: &PersistedSelfHostedConfig,
) -> Result<(), String> {
    let file_name = config
        .bootstrap_file_name
        .as_deref()
        .ok_or("Relay v2 Host bootstrap has not been requested")?;
    let remote_file = format!("$HOME/{REMOTE_ROOT}/bootstrap/{file_name}");
    run_remote_cmd_check_strings(
        host,
        &[
            "sh".into(),
            "-lc".into(),
            format!(
                r#"{REMOTE_SECURITY_FUNCTIONS}
set -eu
require_relay_layout
require_private_file "{remote_file}"
rm -f -- "{remote_file}"
"#
            ),
        ],
    )
    .map(|_| ())
}

fn transfer_rotated_remote_bootstrap(
    host: &HostConfig,
    config: &mut PersistedSelfHostedConfig,
) -> Result<(), String> {
    let local_file = write_remote_bootstrap_to_local(host, config)?;
    let file_name = config
        .bootstrap_file_name
        .clone()
        .ok_or("Relay v2 Host bootstrap has not been requested")?;
    let publication_correlation = config
        .bootstrap_publication_correlation
        .clone()
        .ok_or("Relay v2 Host bootstrap publication correlation is missing")?;
    config.bootstrap_rotation_transfer_receipt = Some(BootstrapRotationTransferReceipt {
        profile_lineage: config.host_profile_identity.clone(),
        bootstrap_file_name: file_name,
        bootstrap_publication_correlation: publication_correlation,
        local_identity: local_file.identity,
        phase: BootstrapRotationTransferPhase::RemoteCleanupPending,
    });
    config.bootstrap_rotation_request_phase = None;
    // The receipt is durable before the remote copy is removed. A crash on
    // either side of cleanup can therefore reuse this exact local identity.
    save_config(config)?;
    cleanup_remote_bootstrap(host, config)
        .map_err(|_| "Relay v2 Host bootstrap remote cleanup failed".to_string())?;
    let receipt = config
        .bootstrap_rotation_transfer_receipt
        .as_mut()
        .ok_or("Relay v2 Host bootstrap transfer receipt disappeared")?;
    receipt.phase = BootstrapRotationTransferPhase::Ready;
    save_config(config)
}

fn build_remote_bootstrap_read_script(remote_file: &str) -> String {
    format!(
        r#"{REMOTE_SECURITY_FUNCTIONS}
set -eu
require_relay_layout
file="{remote_file}"
attempt=0
while test ! -f "$file" && test "$attempt" -lt 50; do
  attempt=$((attempt + 1))
  sleep 0.1
done
node - "$file" "{MAX_BOOTSTRAP_RAW_BYTES}" <<'TW_RELAY_V2_BOOTSTRAP_FD_READER'
{REMOTE_BOOTSTRAP_FD_READER}
TW_RELAY_V2_BOOTSTRAP_FD_READER
"#
    )
}

fn cleanup_matching_republished_bootstrap(
    host: &HostConfig,
    config: &PersistedSelfHostedConfig,
) -> Result<(), String> {
    if !remote_bootstrap_is_available(host, config)? {
        return Ok(());
    }
    cleanup_matching_remote_bootstrap(host, config, None)
}

fn cleanup_matching_remote_bootstrap(
    host: &HostConfig,
    config: &PersistedSelfHostedConfig,
    expected_local_identity: Option<&LocalPrivateFileIdentity>,
) -> Result<(), String> {
    let local = read_local_private_file(
        &local_bootstrap_path(config)?.to_string_lossy(),
        "Relay v2 Host bootstrap input",
        MAX_BOOTSTRAP_RAW_BYTES as u64,
    )?;
    if expected_local_identity.is_some_and(|expected| expected != &local.identity) {
        return Err(
            "Relay v2 Host bootstrap replacement does not match its transfer receipt".to_string(),
        );
    }
    let remote = read_remote_bootstrap_bytes(host, config)?;
    if !bootstrap_bytes_match_local_identity(&remote, &local.identity) {
        return Err(
            "Relay v2 Host bootstrap output does not match its persisted publication attempt"
                .to_string(),
        );
    }
    cleanup_remote_bootstrap(host, config)
        .map_err(|_| "Relay v2 Host bootstrap remote cleanup failed".to_string())
}

fn bootstrap_bytes_match_local_identity(
    remote: &[u8],
    local_identity: &LocalPrivateFileIdentity,
) -> bool {
    remote.len() as u64 == local_identity.length
        && <[u8; 32]>::from(Sha256::digest(remote)) == local_identity.sha256
}

fn start_center_with_pending_rotation_output(
    config: &mut PersistedSelfHostedConfig,
    require_replacement_output: bool,
) -> Result<(), String> {
    bootstrap_publication_attempt(config)?;
    let host = find_host(&config.broker_host_id)?;
    if center_is_running(&host)? {
        if !config.host_credential_provisioned && config.bootstrap_file_name.is_some() {
            if !local_bootstrap_path(config).is_ok_and(|path| secure_bootstrap_file(&path)) {
                if config.bootstrap_rotation_pending {
                    transfer_rotated_remote_bootstrap(&host, config)?;
                } else {
                    transfer_remote_bootstrap(&host, config)?;
                }
            } else {
                cleanup_matching_republished_bootstrap(&host, config)?;
            }
        }
        return Ok(());
    }

    let mut transfer_after_start = require_replacement_output;
    if config.host_credential_provisioned {
        transfer_after_start = false;
    } else if config.bootstrap_file_name.is_none() {
        if config.bootstrap_rotation_pending {
            return Err("Relay v2 Host bootstrap rotation attempt is missing".to_string());
        }
        let name = format!(
            "host-bootstrap-{}.twhostboot2",
            uuid::Uuid::new_v4().simple()
        );
        let correlation = fresh_bootstrap_publication_correlation()?;
        config.bootstrap_file_name = Some(name);
        config.bootstrap_publication_correlation = Some(correlation);
        // The output path and independent non-secret publication correlation
        // are durable before any remote action.
        save_config(config)?;
        transfer_after_start = true;
    } else if !local_bootstrap_path(config).is_ok_and(|path| secure_bootstrap_file(&path)) {
        if remote_bootstrap_is_available(&host, config)? {
            if config.bootstrap_rotation_pending {
                transfer_rotated_remote_bootstrap(&host, config)?;
            } else {
                transfer_remote_bootstrap(&host, config)?;
            }
            transfer_after_start = false;
        } else {
            // Reinvoke the exact attempt. If the Broker already acknowledged
            // it but the output was lost, the transfer below fails closed;
            // this owner never substitutes a new correlation.
            transfer_after_start = true;
        }
    } else if !transfer_after_start {
        // A prior invocation can leave both the durable local input and its
        // remote publication after crashing before cleanup/ack. Remove only
        // an exact byte match before the launcher's no-output-file guard.
        cleanup_matching_republished_bootstrap(&host, config)?;
    }
    let bootstrap_attempt = bootstrap_publication_attempt(config)?;
    if transfer_after_start && bootstrap_attempt.is_none() {
        return Err("Relay v2 Host bootstrap publication attempt is missing".to_string());
    }
    let command = build_remote_relay_v2_center_command(config, bootstrap_attempt.as_ref());
    let fingerprint = deployment_fingerprint(config);
    let launcher = format!("$HOME/{REMOTE_ROOT}/relay-v2-center.sh");
    let launcher_stage = format!(
        "$HOME/{REMOTE_ROOT}/.relay-v2-center-{}.stage",
        uuid::Uuid::new_v4().simple()
    );
    let tmux = remote_tmux_cmd(&host);
    let state_directory_preflight = build_remote_state_directory_launcher_preflight();
    let center_version = env!("CARGO_PKG_VERSION");
    let script = format!(
        r#"{REMOTE_SECURITY_FUNCTIONS}
set -eu
require_relay_layout
{state_directory_preflight}
require_current_bundle
root="$HOME/{REMOTE_ROOT}"
require_private_file "$HOME/{REMOTE_TLS_KEY}"
require_private_file "$HOME/{REMOTE_TLS_CERTIFICATE}"
require_private_file "$HOME/{REMOTE_TLS_CA}"
require_private_file "$HOME/{REMOTE_PROFILE}"
grep -Fq '"deploymentFingerprint": "{fingerprint}"' "$HOME/{REMOTE_PROFILE}"
{bootstrap_output_guard}
if test -e "{launcher}" || test -L "{launcher}"; then require_private_executable "{launcher}"; fi
test ! -e "{launcher_stage}"
test ! -L "{launcher_stage}"
trap 'rm -f -- "{launcher_stage}"' EXIT HUP INT TERM
set -C
cat > "{launcher_stage}" <<'EOF'
#!/bin/sh
set -eu
umask 077
{launcher_security_functions}
require_relay_layout
{state_directory_preflight}
exec {command}
EOF
set +C
chmod 700 "{launcher_stage}"
require_private_executable "{launcher_stage}"
mv -Tf "{launcher_stage}" "{launcher}"
require_private_executable "{launcher}"
trap - EXIT HUP INT TERM
if {tmux} has-session -t {CENTER_SESSION} 2>/dev/null; then exit 0; fi
{tmux} new-session -d -s {CENTER_SESSION} "\"{launcher}\""
sleep 1
{tmux} has-session -t {CENTER_SESSION}
# Record the bundle version the live Center process exec'd (the launcher runs
# "$root/current/cli.cjs"). Only reached after the session postcondition above,
# so a failed start never refreshes the record of a previously running process.
{running_version_publish}
"#,
        running_version_publish = build_remote_center_running_version_publish(center_version),
        launcher_security_functions = REMOTE_SECURITY_FUNCTIONS,
        bootstrap_output_guard = bootstrap_attempt
            .as_ref()
            .map(|attempt| {
                format!(
                    "test ! -e \"$root/bootstrap/{name}\"\ntest ! -L \"$root/bootstrap/{name}\"",
                    name = attempt.file_name
                )
            })
            .unwrap_or_else(|| ":".to_string()),
    );
    run_remote_cmd_check_strings(&host, &["sh".into(), "-lc".into(), script])?;
    if transfer_after_start {
        if config.bootstrap_rotation_pending {
            transfer_rotated_remote_bootstrap(&host, config)?;
        } else {
            transfer_remote_bootstrap(&host, config)?;
        }
    } else if bootstrap_attempt.is_some() {
        // A crash after the Broker's durable output but before its
        // acknowledgement can republish the same correlation. Preserve the
        // exact local identity and only remove a byte-identical duplicate.
        cleanup_matching_republished_bootstrap(&host, config)?;
    }
    save_config(config)?;
    Ok(())
}

fn ensure_ordinary_center_start_allowed(config: &PersistedSelfHostedConfig) -> Result<(), String> {
    if config.bootstrap_rotation_pending {
        return Err(
            "Relay v2 Host bootstrap rotation must be completed with the explicit rotate action"
                .to_string(),
        );
    }
    Ok(())
}

fn start_center(config: &mut PersistedSelfHostedConfig) -> Result<(), String> {
    ensure_ordinary_center_start_allowed(config)?;
    start_center_with_pending_rotation_output(config, false)
}

/// Shell fragment (runs inside the center-start script, where `$root` is
/// defined) that best-effort publishes the bundle version the live Center
/// process exec'd, after the tmux session postcondition already held. This is
/// observability only — the Center's liveness is the `has-session` check above
/// — so a marker write failure must never turn a successful start into an
/// error: the probe conservatively reads a missing marker (a Center started
/// before version tracking) as stale instead.
fn build_remote_center_running_version_publish(version: &str) -> String {
    format!(
        r#"running_version_stage="$root/.{REMOTE_CENTER_RUNNING_VERSION_FILE}.$$"
if printf '%s\n' {version} > "$running_version_stage" 2>/dev/null \
   && chmod 600 "$running_version_stage" 2>/dev/null \
   && mv -Tf "$running_version_stage" "$root/{REMOTE_CENTER_RUNNING_VERSION_FILE}" 2>/dev/null; then
  :
else
  rm -f -- "$running_version_stage" 2>/dev/null || true
fi
"#,
        version = shell_quote(version),
    )
}

/// Restart the remote Center onto the freshly published bundle. The publish
/// only atomically swaps the `current` symlink; a live Center keeps exec'ing
/// the old bundle's `cli.cjs`, so without this every broker-side fix shipped
/// by Deploy stayed silently inactive until a manual Stop + Start.
///
/// - No Center running → nothing happens (Deploy never starts a stopped
///   Center; that is the explicit Start action / watchdog path).
/// - Center running → stop the tmux session and start it again from the new
///   `current`. Phone WSS connections drop briefly and self-heal via the
///   mobile relay reconnect path.
///
/// Desired-state semantics: `connector_desired_running=true` is latched BEFORE
/// the stop, so if the stop succeeds but the start fails, the Center is stopped
/// but wanted and the D020 watchdog (deterministic Stopped → StartRemote)
/// retries the remote start with bounded backoff. A user-initiated Stop always
/// persists desired=false first, so this latch can never revive an
/// intentionally stopped Center. Deterministic start refusals (a pending
/// bootstrap rotation) are checked BEFORE the stop so a running Center is never
/// killed when the restart could not have been attempted.
///
/// Returns `true` when a Center was actually restarted. The closures mirror the
/// real functions so the ordering and desired-state latch are unit-testable
/// without SSH.
fn restart_running_center_after_deploy_with<
    IsRunning,
    EnsureStartAllowed,
    PersistDesired,
    Stop,
    Start,
>(
    config: &mut PersistedSelfHostedConfig,
    mut is_running: IsRunning,
    mut ensure_start_allowed: EnsureStartAllowed,
    mut persist_desired_running: PersistDesired,
    mut stop_center: Stop,
    mut start_center: Start,
) -> Result<bool, String>
where
    IsRunning: FnMut() -> Result<bool, String>,
    EnsureStartAllowed: FnMut(&PersistedSelfHostedConfig) -> Result<(), String>,
    PersistDesired: FnMut(&mut PersistedSelfHostedConfig, bool) -> Result<(), String>,
    Stop: FnMut(&PersistedSelfHostedConfig) -> Result<(), String>,
    Start: FnMut(&mut PersistedSelfHostedConfig) -> Result<(), String>,
{
    if !is_running()? {
        return Ok(false);
    }
    if let Err(error) = ensure_start_allowed(config) {
        // Deterministic refusal (a pending bootstrap rotation): leave the
        // running Center on the old bundle rather than killing it ahead of a
        // start that could not run; the explicit rotate / Start flow recovers.
        return Err(format!(
            "Relay v2 bundle deployed, but the running Center was left untouched: {error}"
        ));
    }
    persist_desired_running(config, true)?;
    stop_center(config)?;
    if let Err(error) = start_center(config) {
        return Err(format!(
            "Relay v2 bundle deployed; the running Center was stopped to load it but could not be \
             restarted: {error}. The Center stays marked as wanted and its start is retried \
             automatically (or press Start v2 Relay Center)."
        ));
    }
    Ok(true)
}

fn restart_running_center_after_deploy(
    host: &HostConfig,
    config: &mut PersistedSelfHostedConfig,
) -> Result<bool, String> {
    restart_running_center_after_deploy_with(
        config,
        || center_is_running(host),
        ensure_ordinary_center_start_allowed,
        persist_connector_desired_running,
        stop_center,
        start_center,
    )
}

fn build_remote_center_stop_script(tmux: &str) -> String {
    format!(
        r#"{REMOTE_SECURITY_FUNCTIONS}
set -eu
require_relay_layout
{tmux} kill-session -t {CENTER_SESSION} 2>/dev/null || true
if {tmux} has-session -t {CENTER_SESSION} 2>/dev/null; then
  exit 1
else
  center_has_session_status=$?
fi
test "$center_has_session_status" -eq 1
# The session is provably gone, so no process is running this bundle anymore;
# drop the running-version record so the probe never reports a live version
# for a stopped Center.
rm -f -- "$HOME/{REMOTE_ROOT}/{REMOTE_CENTER_RUNNING_VERSION_FILE}"
"#,
    )
}

fn stop_center(config: &PersistedSelfHostedConfig) -> Result<(), String> {
    let host = find_host(&config.broker_host_id)
        .map_err(|_| "Relay v2 Center did not reach the stopped state".to_string())?;
    run_remote_cmd_check_strings(
        &host,
        &[
            "sh".into(),
            "-lc".into(),
            build_remote_center_stop_script(&remote_tmux_cmd(&host)),
        ],
    )
    .map(|_| ())
    .map_err(|_| "Relay v2 Center did not reach the stopped state".to_string())
}

fn stop_center_and_active_connector<StopCenter, StopConnector>(
    active_management: Option<&SelfHostedManagementBinding>,
    mut stop_center: StopCenter,
    mut stop_connector: StopConnector,
) -> Result<(), String>
where
    StopCenter: FnMut() -> Result<(), String>,
    StopConnector: FnMut(&ManagementLaunchKey) -> Result<(), String>,
{
    let center_stop = stop_center();
    let connector_stop = match active_management {
        Some(binding) => stop_connector(&binding.steady_launch_key),
        None => Ok(()),
    };
    center_stop?;
    connector_stop
}

fn validate_expired_bootstrap_rotation_candidate(
    config: &PersistedSelfHostedConfig,
) -> Result<(), String> {
    if config.host_credential_provisioned
        || config.bootstrap_file_name.is_none()
        || config.bootstrap_publication_correlation.is_none()
    {
        return Err(
            "Host bootstrap rotation is only available for an expired version-zero pending bootstrap"
                .to_string(),
        );
    }
    Ok(())
}

fn record_expired_bootstrap_rotation_intent(
    config: &mut PersistedSelfHostedConfig,
    replacement_correlation_after_previous_cleanup: Option<String>,
) -> Result<bool, String> {
    validate_expired_bootstrap_rotation_candidate(config)?;
    let retry = config.bootstrap_rotation_pending;
    if !retry {
        let replacement_correlation = replacement_correlation_after_previous_cleanup.ok_or(
            "Relay v2 Host bootstrap previous publication cleanup is not confirmed".to_string(),
        )?;
        if !valid_bootstrap_publication_correlation(&replacement_correlation)
            || config.bootstrap_publication_correlation.as_deref()
                == Some(replacement_correlation.as_str())
        {
            return Err(
                "Relay v2 Host bootstrap replacement publication correlation is invalid"
                    .to_string(),
            );
        }
        // Explicit operator intent begins one new publication attempt for the
        // replacement. All later retries retain this independently generated
        // correlation and the existing output filename.
        config.bootstrap_publication_correlation = Some(replacement_correlation);
        config.bootstrap_rotation_request_phase = Some(BootstrapRotationRequestPhase::Requested);
        config.bootstrap_rotation_transfer_receipt = None;
    } else if replacement_correlation_after_previous_cleanup.is_some() {
        return Err(
            "Relay v2 Host bootstrap replacement publication attempt is already durable"
                .to_string(),
        );
    }
    config.bootstrap_rotation_pending = true;
    Ok(retry)
}

fn begin_expired_bootstrap_rotation(
    config: &mut PersistedSelfHostedConfig,
) -> Result<bool, String> {
    validate_expired_bootstrap_rotation_candidate(config)?;
    let replacement_correlation_after_previous_cleanup = if config.bootstrap_rotation_pending {
        None
    } else {
        let host = find_host(&config.broker_host_id)?;
        let previous_local = read_local_private_file(
            &local_bootstrap_path(config)?.to_string_lossy(),
            "Relay v2 Host bootstrap input",
            MAX_BOOTSTRAP_RAW_BYTES as u64,
        )?;
        if remote_bootstrap_is_available(&host, config)? {
            cleanup_matching_remote_bootstrap(&host, config, Some(&previous_local.identity))?;
        }
        if remote_bootstrap_is_available(&host, config)? {
            return Err(
                "Relay v2 Host bootstrap previous publication cleanup is uncertain".to_string(),
            );
        }
        // The Broker sink writes synchronously before acknowledgement, and an
        // acknowledged correlation never invokes the sink again. Until the
        // atomic config save below, A remains the only durable attempt, so a
        // crash can only retry this same exact cleanup.
        Some(fresh_bootstrap_publication_correlation()?)
    };
    let retry = record_expired_bootstrap_rotation_intent(
        config,
        replacement_correlation_after_previous_cleanup,
    )?;
    save_config(config)?;
    Ok(retry)
}

fn verify_rotation_transfer_receipt_local(
    config: &PersistedSelfHostedConfig,
) -> Result<(), String> {
    verify_rotation_transfer_receipt_local_at(config, &local_bootstrap_path(config)?)
}

fn verify_rotation_transfer_receipt_local_at(
    config: &PersistedSelfHostedConfig,
    path: &Path,
) -> Result<(), String> {
    if config.bootstrap_rotation_transfer_receipt.is_none() {
        return Err("Relay v2 Host bootstrap transfer receipt is missing".to_string());
    }
    let local = read_local_private_file(
        &path.to_string_lossy(),
        "Relay v2 Host bootstrap replacement",
        MAX_BOOTSTRAP_RAW_BYTES as u64,
    )
    .map_err(|_| {
        "Relay v2 Host bootstrap replacement does not match its transfer receipt".to_string()
    })?;
    verify_rotation_transfer_identity(config, &local.identity)
}

fn finish_rotation_remote_cleanup(
    host: &HostConfig,
    config: &mut PersistedSelfHostedConfig,
    remote_available: bool,
) -> Result<(), String> {
    verify_rotation_transfer_receipt_local(config)?;
    let receipt_identity = config
        .bootstrap_rotation_transfer_receipt
        .as_ref()
        .map(|receipt| receipt.local_identity.clone())
        .ok_or("Relay v2 Host bootstrap transfer receipt disappeared")?;
    if remote_available {
        // RemoteCleanupPending can be replayed only when the still-published
        // bytes match the receipt-bound local replacement exactly.
        cleanup_matching_remote_bootstrap(host, config, Some(&receipt_identity))?;
    }
    let receipt = config
        .bootstrap_rotation_transfer_receipt
        .as_mut()
        .ok_or("Relay v2 Host bootstrap transfer receipt disappeared")?;
    if receipt.phase != BootstrapRotationTransferPhase::Ready {
        receipt.phase = BootstrapRotationTransferPhase::Ready;
        save_config(config)?;
    }
    Ok(())
}

fn rotate_expired_host_bootstrap(config: &mut PersistedSelfHostedConfig) -> Result<(), String> {
    let retry = begin_expired_bootstrap_rotation(config)?;
    let host = find_host(&config.broker_host_id)?;

    if retry {
        if config.bootstrap_rotation_transfer_receipt.is_some() {
            verify_rotation_transfer_receipt_local(config)?;
            let remote_available = remote_bootstrap_is_available(&host, config)?;
            finish_rotation_remote_cleanup(&host, config, remote_available)?;
            if !center_is_running(&host)? {
                start_center_with_pending_rotation_output(config, false)?;
            }
            return Ok(());
        }
        let remote_available = remote_bootstrap_is_available(&host, config)?;
        // A crash before the receipt commit leaves the same replacement on
        // the remote output path. Re-read that token, persist its exact local
        // identity, and never mint a successor.
        if remote_available {
            transfer_rotated_remote_bootstrap(&host, config)?;
            if !center_is_running(&host)? {
                start_center_with_pending_rotation_output(config, false)?;
            }
            return Ok(());
        }
    }

    match config.bootstrap_rotation_request_phase {
        Some(BootstrapRotationRequestPhase::UnverifiedLegacy) => {
            return Err(
                "Relay v2 Host bootstrap rotation predates verified transfer receipts".to_string(),
            );
        }
        Some(BootstrapRotationRequestPhase::Requested) => {
            // This is the only process stopped by rotation. The dedicated
            // SQLite state directory, native Host cell, and correlation stay.
            stop_center(config)?;
            if center_is_running(&host)? {
                return Err(
                    "Relay v2 Center could not be stopped for Host bootstrap rotation".to_string(),
                );
            }
            config.bootstrap_rotation_request_phase =
                Some(BootstrapRotationRequestPhase::CenterStopped);
            save_config(config)?;
        }
        Some(BootstrapRotationRequestPhase::CenterStopped) => {
            if center_is_running(&host)? {
                // The prior launch may still be publishing its exact output.
                // Never stop it and mint a successor while transfer is absent.
                return Err(
                    "Relay v2 Host bootstrap replacement has not reached verified transfer"
                        .to_string(),
                );
            }
        }
        None => {
            return Err(
                "Relay v2 Host bootstrap rotation transfer state is inconsistent".to_string(),
            );
        }
    }
    start_center_with_pending_rotation_output(config, true)
}

#[tauri::command]
pub(crate) async fn mobile_relay_v2_self_hosted_status(
    state: State<'_, Arc<MobileRelayV2SelfHostedDeploymentState>>,
) -> Result<MobileRelayV2SelfHostedStatus, String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        // Status is a pure read: it probes the remote center over SSH and reads
        // the persisted config; the only owner field it consumes is the
        // startup-restore error. Take that snapshot WITHOUT holding the
        // deployment lock across the SSH round trip (a black-holed devbox can
        // stall ~50s on ServerAlive keepalives, and Deploy holds this lock for
        // minutes). try_lock lets a concurrent Deploy/Start/Stop own the mutex;
        // the one-shot restore error is simply omitted that poll and reappears
        // on the next refresh. The probe itself never touches the owner, so it
        // runs entirely outside the desired-state fence.
        let startup_restore_error = state
            .operation
            .try_lock()
            .ok()
            .and_then(|owner| owner.startup_restore_error.clone());
        let mut status = current_status();
        if status.error.is_none() {
            status.error = startup_restore_error;
        }
        Ok(status)
    })
    .await
    .map_err(|error| format!("Relay v2 status task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn mobile_relay_v2_self_hosted_save_config(
    args: MobileRelayV2SelfHostedConfigInput,
    state: State<'_, Arc<MobileRelayV2SelfHostedDeploymentState>>,
    management: State<'_, Arc<MobileRelayV2ManagementCommandState>>,
) -> Result<MobileRelayV2SelfHostedStatus, String> {
    let state = Arc::clone(state.inner());
    let management = Arc::clone(management.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let mut owner = state
            .operation
            .lock()
            .map_err(|_| "Relay v2 deployment owner is unavailable".to_string())?;
        let (previous, config) = validated_config_with_persisted_state(args, false)?;
        let config = save_config_replacement_after_management_barrier(
            &mut owner,
            management.as_ref(),
            previous,
            config,
        )?;
        owner.startup_restore_error = None;
        // Externally managed TLS has no local chain yet at save time; it is
        // fetched from the devbox during Deploy. Skip the staging preflight so
        // saving the external-mode settings does not require a prior deploy.
        if !config.external_tls_management {
            prepare_local_host_prerequisites_for(&config)?;
        }
        Ok(probe_status(&config))
    })
    .await
    .map_err(|error| format!("Relay v2 save task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn mobile_relay_v2_self_hosted_deploy(
    app: tauri::AppHandle,
    args: MobileRelayV2SelfHostedConfigInput,
    state: State<'_, Arc<MobileRelayV2SelfHostedDeploymentState>>,
    management: State<'_, Arc<MobileRelayV2ManagementCommandState>>,
) -> Result<MobileRelayV2SelfHostedStatus, String> {
    let state = Arc::clone(state.inner());
    let management = Arc::clone(management.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let mut owner = state
            .operation
            .lock()
            .map_err(|_| "Relay v2 deployment owner is unavailable".to_string())?;
        let (previous, config) = validated_config_with_persisted_state(args, true)?;
        let mut config = save_config_replacement_after_management_barrier(
            &mut owner,
            management.as_ref(),
            previous,
            config,
        )?;
        owner.startup_restore_error = None;
        // Deploy first: external mode pulls the public chain back during TLS
        // validation, so the local Host prerequisites are only staged after
        // the chain is available.
        deploy_bundle(&app, &config)?;
        prepare_local_host_prerequisites_for(&config)?;
        // Publish only swaps the `current` symlink: a live Center keeps running
        // the old bundle until it is restarted. Restart it under the operation
        // lock so the new code actually takes effect; no restart happens when no
        // Center is running. On stop-success/start-failure the error surfaces
        // here and the persisted desired=true lets the watchdog retry.
        restart_running_center_after_deploy(&find_host(&config.broker_host_id)?, &mut config)?;
        Ok(probe_status(&config))
    })
    .await
    .map_err(|error| format!("Relay v2 deploy task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn mobile_relay_v2_self_hosted_start_center(
    app: tauri::AppHandle,
    args: MobileRelayV2SelfHostedConfigInput,
    state: State<'_, Arc<MobileRelayV2SelfHostedDeploymentState>>,
    management: State<'_, Arc<MobileRelayV2ManagementCommandState>>,
) -> Result<MobileRelayV2SelfHostedStatus, String> {
    let state = Arc::clone(state.inner());
    let management = Arc::clone(management.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let (committed, binding, previously_supervised, readiness_outcome) = {
            let mut owner = state
                .operation
                .lock()
                .map_err(|_| "Relay v2 deployment owner is unavailable".to_string())?;
            let saved = load_config()?
                .ok_or("Save and deploy the Relay v2 self-hosted configuration first")?;
            let requested = validated_config(
                args,
                saved.bootstrap_file_name.clone(),
                saved.bootstrap_publication_correlation.clone(),
                false,
            )?;
            if !same_deployment_config(&saved, &requested) {
                return Err(
                    "Save and deploy the current Relay v2 configuration before starting"
                        .to_string(),
                );
            }
            let mut previous = saved;
            ensure_host_profile_identity(&mut previous)?;
            let config = previous.clone();
            ensure_ordinary_center_start_allowed(&config)?;
            let mut config = save_config_replacement_after_management_barrier(
                &mut owner,
                management.as_ref(),
                Some(previous),
                config,
            )?;
            prepare_local_host_prerequisites_for(&config)?;
            start_center(&mut config)?;
            let prepared = prepare_relay_v2_self_hosted_management_prerequisites()?
                .ok_or("Relay v2 self-hosted management configuration disappeared")?;
            let selection = prepared.selection();
            let binding = prepared.management_binding()?;
            management.reset_recovery();
            management
                .restart_self_hosted(&app, selection, move || prepared.commit_ready())
                .map_err(|error| match error {
                    ManagementStartError::RecoveryRequired => {
                        "Relay v2 Host cleanup is uncertain; operator recovery is required"
                            .to_string()
                    }
                    ManagementStartError::Unavailable | ManagementStartError::ChannelClosed => {
                        "Relay v2 self-hosted Host could not become ready".to_string()
                    }
                })?;
            let previously_supervised = owner.active_management.is_some();
            owner.active_management = Some(binding.clone());
            let mut committed = revalidate_current_management_binding(&binding)?;
            let readiness = management
                .ensure_self_hosted_connector_start_accepted(&binding.steady_launch_key)
                .map_err(|_| "Relay v2 self-hosted Host start was not accepted".to_string())?;
            if persist_connector_desired_running(&mut committed, true).is_err() {
                let _ = management
                    .stop_self_hosted_connector_for_launch_key(Some(&binding.steady_launch_key));
                return Err("Relay v2 self-hosted Host desired state was not saved".to_string());
            }
            owner.startup_restore_error = None;
            // Network registration remains controller-owned. Once the accepted
            // desired state is durable and active_management is published, the
            // bounded readiness wait must NOT abort Start Center via `?` before
            // the watchdog is armed. Capture how it ended and surface the
            // renderer notice only after supervision owns the binding: a cut
            // still retrying at the deadline is not a start failure, and a
            // child that dies during the wait is a supervised rebuild rather
            // than an unsupervised binding for the rest of the session.
            let readiness_outcome = committed_start_readiness_outcome(
                management.wait_for_self_hosted_connector_base_readiness(
                    &binding.steady_launch_key,
                    readiness,
                ),
            );
            (
                committed,
                binding,
                previously_supervised,
                readiness_outcome,
            )
        };
        // Arm a desired-state watchdog after the deployment lock is released
        // (std::sync::Mutex is not reentrant) and only when this Start created a
        // new supervised binding — an already-supervised binding is covered by a
        // watchdog that will Supersede itself on mismatch. Before this, an in-app
        // first Deploy+Start left the management child unsupervised until the
        // Dashboard was restarted. The arm runs for EVERY committed wait
        // outcome, including a retrying-deadline Start: the soft "retrying
        // automatically" notice must never leave a freshly published binding
        // unsupervised (no dead-child rebuild, no remote-center reboot repair,
        // no 600s stall escalation) for the rest of the session.
        if !previously_supervised {
            arm_connector_desired_state_watchdog(
                &app,
                &Arc::downgrade(&state),
                &Arc::downgrade(&management),
                binding,
            );
        }
        match readiness_outcome.surfaced_error() {
            Some(message) => Err(message.to_string()),
            None => Ok(probe_status(&committed)),
        }
    })
    .await
    .map_err(|error| format!("Relay v2 start task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn mobile_relay_v2_self_hosted_rotate_expired_host_bootstrap(
    app: tauri::AppHandle,
    state: State<'_, Arc<MobileRelayV2SelfHostedDeploymentState>>,
    management: State<'_, Arc<MobileRelayV2ManagementCommandState>>,
) -> Result<MobileRelayV2SelfHostedStatus, String> {
    let state = Arc::clone(state.inner());
    let management = Arc::clone(management.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let (committed, binding, arm_watchdog) = {
            let mut owner = state
                .operation
                .lock()
                .map_err(|_| "Relay v2 deployment owner is unavailable".to_string())?;
            let mut config =
                load_config()?.ok_or("Relay v2 self-hosted deployment is not configured")?;
            ensure_host_profile_identity(&mut config)?;
            rotate_expired_host_bootstrap(&mut config)?;
            let prepared = prepare_relay_v2_self_hosted_management_prerequisites()?
                .ok_or("Relay v2 self-hosted management configuration disappeared")?;
            let selection = prepared.selection();
            let binding = prepared.management_binding()?;
            management
                .replace_self_hosted(&app, selection, move || prepared.commit_ready())
                .map_err(|error| match error {
                    ManagementStartError::RecoveryRequired => {
                        "Relay v2 Host cleanup is uncertain; operator recovery is required"
                            .to_string()
                    }
                    ManagementStartError::Unavailable | ManagementStartError::ChannelClosed => {
                        "Rotated Relay v2 self-hosted Host could not become ready".to_string()
                    }
                })?;
            let committed = revalidate_current_management_binding(&binding)?;
            owner.active_management = Some(binding.clone());
            if committed.connector_desired_running {
                let status = probe_status(&committed);
                if !self_hosted_connector_should_be_running(&committed, &status) {
                    return Err(
                        "Relay v2 self-hosted restore prerequisites are not ready".to_string()
                    );
                }
                management
                    .restore_self_hosted_connector_desired_state(&binding.steady_launch_key)
                    .map_err(|_| {
                        "Relay v2 self-hosted Host desired state could not be restored".to_string()
                    })?;
            }
            owner.startup_restore_error = None;
            (
                committed,
                binding.clone(),
                owner.active_management.is_some(),
            )
        };
        // Arm a watchdog for the rotated binding after releasing the deployment
        // lock (std::sync::Mutex is not reentrant). The prior watchdog (armed for
        // the pre-rotation binding) Supersedes itself on the binding mismatch.
        if arm_watchdog && committed.connector_desired_running {
            arm_connector_desired_state_watchdog(
                &app,
                &Arc::downgrade(&state),
                &Arc::downgrade(&management),
                binding,
            );
        }
        Ok(probe_status(&committed))
    })
    .await
    .map_err(|error| format!("Relay v2 Host bootstrap rotation task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn mobile_relay_v2_self_hosted_stop_center(
    state: State<'_, Arc<MobileRelayV2SelfHostedDeploymentState>>,
    management: State<'_, Arc<MobileRelayV2ManagementCommandState>>,
) -> Result<MobileRelayV2SelfHostedStatus, String> {
    let state = Arc::clone(state.inner());
    let management = Arc::clone(management.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let mut owner = state
            .operation
            .lock()
            .map_err(|_| "Relay v2 deployment owner is unavailable".to_string())?;
        let mut config =
            load_config()?.ok_or("Relay v2 self-hosted deployment is not configured")?;
        ensure_host_profile_identity(&mut config)?;
        persist_connector_desired_running(&mut config, false)?;
        owner.startup_restore_error = None;
        stop_center_and_active_connector(
            owner.active_management.as_ref(),
            || stop_center(&config),
            |launch_key| {
                management
                    .stop_self_hosted_connector_for_launch_key(Some(launch_key))
                    .map(|_| ())
                    .map_err(|_| {
                        "Relay v2 self-hosted Host could not be stopped cleanly".to_string()
                    })
            },
        )?;
        Ok(probe_status(&config))
    })
    .await
    .map_err(|error| format!("Relay v2 stop task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::super::management_child::{ManagementError, ManagementLaunchKey};
    use super::{
        base_status, bootstrap_bytes_match_local_identity, bootstrap_publication_attempt,
        build_remote_bootstrap_read_script, build_remote_bundle_publish_script,
        build_remote_bundle_stage_validation_script, build_remote_center_running_version_publish,
        build_remote_center_status_probe_snippet, build_remote_center_stop_script,
        build_remote_relay_v2_center_command, build_remote_state_directory_launcher_preflight,
        center_running_version_is_stale, certificate_bodies, commit_bootstrap_ready_state,
        commit_config_replacement_with_barrier, committed_start_readiness_outcome,
        consumed_local_private_file_path, deployment_fingerprint, ensure_host_profile_identity,
        ensure_ordinary_center_start_allowed, ensure_self_contained_ca_chain,
        finish_consuming_if_present, fresh_bootstrap_publication_correlation,
        initial_watchdog_repair_outcome, load_ready_commit_journal_at,
        management_operation_failed_error, next_connector_watchdog_retry_delay,
        normalize_issuer_url, persisted_management_config_identity,
        post_rebuild_watchdog_outcome, read_local_private_file,
        ready_rotation_transfer_identity, record_expired_bootstrap_rotation_intent,
        relay_url_from_issuer, remote_center_repair_action,
        restart_running_center_after_deploy_with, self_hosted_connector_should_be_running,
        self_hosted_connector_should_survive_dashboard_window_close,
        stop_center_and_active_connector, valid_bootstrap_publication_correlation,
        valid_center_running_version, validate_bootstrap_bytes, validate_listen_host,
        verify_rotation_transfer_identity, verify_rotation_transfer_receipt_local_at,
        BootstrapRotationRequestPhase, BootstrapRotationTransferPhase,
        BootstrapRotationTransferReceipt, CommittedStartReadiness,
        ConnectorWatchdogReconcileOutcome, ConnectorWatchdogSchedule, DeploymentProbeStatus,
        LocalPrivateFileIdentity, MobileRelayV2ManagementCommandState, PersistedSelfHostedConfig,
        ReadyCommitJournal, RemoteCenterRepairAction, SelfHostedConnectorRepair,
        SelfHostedDeploymentOperationOwner, SelfHostedManagementBinding,
        BOOTSTRAP_CORRELATION_CONFIG_SCHEMA_VERSION, CONFIG_CONTRACT, CONFIG_SCHEMA_VERSION,
        CONNECTOR_DESIRED_STATE_CONFIG_SCHEMA_VERSION, CONNECTOR_WATCHDOG_HEALTHY_INTERVAL,
        CONNECTOR_WATCHDOG_INITIAL_DELAY, CONNECTOR_WATCHDOG_MAX_RETRY_DELAY,
        CONNECTOR_WATCHDOG_STALL_REBUILD_AFTER, HOST_PROFILE_CONFIG_SCHEMA_VERSION,
        ISRG_ROOT_X1_PEM, NODE_TLS_CA_MAX_ENTRY_BYTES, READY_COMMIT_JOURNAL_CONTRACT,
        READY_COMMIT_JOURNAL_SCHEMA_VERSION, REMOTE_BOOTSTRAP_FD_READER,
        REMOTE_CENTER_RUNNING_VERSION_FILE, ROTATION_PENDING_CONFIG_SCHEMA_VERSION,
        ROTATION_RECEIPT_CONFIG_SCHEMA_VERSION,
    };
    use std::cell::RefCell;
    use std::time::{Duration, Instant};

    #[test]
    fn connector_watchdog_retry_delay_is_bounded() {
        assert_eq!(
            next_connector_watchdog_retry_delay(Duration::from_secs(1)),
            Duration::from_secs(2),
        );
        assert_eq!(
            next_connector_watchdog_retry_delay(Duration::from_secs(8)),
            CONNECTOR_WATCHDOG_MAX_RETRY_DELAY,
        );
        assert_eq!(
            next_connector_watchdog_retry_delay(CONNECTOR_WATCHDOG_MAX_RETRY_DELAY),
            CONNECTOR_WATCHDOG_MAX_RETRY_DELAY,
        );
    }

    #[test]
    fn connector_watchdog_starts_remote_only_for_a_deterministic_stopped_center() {
        // A devbox reboot / tmux kill-server leaves the remote center stopped;
        // the probe script runs and `tmux has-session` fails. Rebuilding the
        // local management child cannot fix that, so the watchdog starts the
        // remote center and only rebuilds locally once the center is observed
        // running again.
        assert_eq!(
            remote_center_repair_action(Some(DeploymentProbeStatus::Stopped)),
            RemoteCenterRepairAction::StartRemote
        );
        assert_eq!(
            remote_center_repair_action(Some(DeploymentProbeStatus::Running)),
            RemoteCenterRepairAction::RebuildLocal
        );
        // Review D020: Unknown is the DEFAULT base_status and what a
        // black-holed devbox / SSH failure leaves behind (the script never
        // runs; only status.error is set). It must NOT trigger start_center —
        // that would run a scp bootstrap + many SSH round-trips every watchdog
        // tick. Unknown / Ready / Missing / None are all uncertain and fall
        // back to the bounded local-rebuild + Retry backoff.
        assert_eq!(
            remote_center_repair_action(Some(DeploymentProbeStatus::Unknown)),
            RemoteCenterRepairAction::RebuildLocal,
            "a black-holed devbox (Unknown) must not repeatedly run start_center"
        );
        assert_eq!(
            remote_center_repair_action(Some(DeploymentProbeStatus::Missing)),
            RemoteCenterRepairAction::RebuildLocal
        );
        assert_eq!(
            remote_center_repair_action(Some(DeploymentProbeStatus::Ready)),
            RemoteCenterRepairAction::RebuildLocal
        );
        // No probe result (incomplete prerequisites / unprobed) falls back to
        // the prior behaviour: rebuild the local child.
        assert_eq!(
            remote_center_repair_action(None),
            RemoteCenterRepairAction::RebuildLocal
        );
    }

    #[test]
    fn connector_watchdog_deferred_never_escalates_before_the_stall_timeout() {
        // Drive the pure schedule with Deferred observations at the same
        // wall-clock spacing the real thread uses (the returned delay). Every
        // observation strictly before 600s must stay non-escalating, and
        // Deferred must share the exact Retry doubling: 1s, 2s, 4s, 8s, 15s…
        let t0 = Instant::now();
        let mut schedule = ConnectorWatchdogSchedule::new();
        let mut elapsed = Duration::ZERO;
        let mut expected_delay = CONNECTOR_WATCHDOG_INITIAL_DELAY;
        while elapsed < CONNECTOR_WATCHDOG_STALL_REBUILD_AFTER {
            let (delay, escalate) =
                schedule.observe(ConnectorWatchdogReconcileOutcome::Deferred, t0 + elapsed);
            assert!(!escalate, "no stall escalation before 600s (at {elapsed:?})");
            assert_eq!(delay, expected_delay, "Deferred backs off exactly like Retry");
            elapsed += delay;
            expected_delay = next_connector_watchdog_retry_delay(expected_delay);
        }
        // The doubled sequence lands exactly on the 600s boundary; observing AT
        // it is the escalation case covered by the next test.
        assert_eq!(elapsed, CONNECTOR_WATCHDOG_STALL_REBUILD_AFTER);
        assert_eq!(expected_delay, CONNECTOR_WATCHDOG_MAX_RETRY_DELAY);
    }

    #[test]
    fn connector_watchdog_deferred_escalates_once_at_the_stall_timeout_then_restarts() {
        let t0 = Instant::now();
        let mut schedule = ConnectorWatchdogSchedule::new();

        // Approach the boundary with only non-escalating Deferred ticks.
        let mut elapsed = Duration::ZERO;
        while elapsed < CONNECTOR_WATCHDOG_STALL_REBUILD_AFTER {
            let (delay, escalate) =
                schedule.observe(ConnectorWatchdogReconcileOutcome::Deferred, t0 + elapsed);
            assert!(!escalate);
            elapsed += delay;
        }
        // At exactly 600s a single one-shot rebuild escalation fires.
        let (delay, escalate) =
            schedule.observe(ConnectorWatchdogReconcileOutcome::Deferred, t0 + elapsed);
        assert!(escalate, "the 600s stall arms exactly one rebuild escalation");
        assert_eq!(delay, CONNECTOR_WATCHDOG_MAX_RETRY_DELAY);

        // The stall timer restarted immediately: every Deferred observation in
        // the following 600s window stays non-escalating…
        elapsed += delay;
        let restarted_boundary = elapsed + CONNECTOR_WATCHDOG_STALL_REBUILD_AFTER;
        while elapsed < restarted_boundary {
            let (next_delay, escalate_again) =
                schedule.observe(ConnectorWatchdogReconcileOutcome::Deferred, t0 + elapsed);
            assert!(
                !escalate_again,
                "no second escalation inside the restarted window (at {elapsed:?})"
            );
            elapsed += next_delay;
        }
        assert_eq!(elapsed, restarted_boundary);
        // …and it escalates again only at the restarted run's own boundary.
        let (_, escalate_again) =
            schedule.observe(ConnectorWatchdogReconcileOutcome::Deferred, t0 + elapsed);
        assert!(escalate_again, "the restarted timer escalates again at its own 600s");
    }

    #[test]
    fn connector_watchdog_healthy_clears_the_stall_timer_and_backoff() {
        let t0 = Instant::now();
        let mut schedule = ConnectorWatchdogSchedule::new();
        let (_, escalate) =
            schedule.observe(ConnectorWatchdogReconcileOutcome::Deferred, t0);
        assert!(!escalate);
        let (_, escalate) = schedule.observe(
            ConnectorWatchdogReconcileOutcome::Deferred,
            t0 + CONNECTOR_WATCHDOG_STALL_REBUILD_AFTER - Duration::from_secs(1),
        );
        assert!(!escalate);
        // A Healthy tick at the would-be escalation boundary clears the run.
        let (healthy_delay, escalate) = schedule.observe(
            ConnectorWatchdogReconcileOutcome::Healthy,
            t0 + CONNECTOR_WATCHDOG_STALL_REBUILD_AFTER,
        );
        assert!(!escalate);
        assert_eq!(healthy_delay, CONNECTOR_WATCHDOG_HEALTHY_INTERVAL);
        // Far beyond 600s after the ORIGINAL run started, the fresh Deferred run
        // neither escalates nor inherits the doubled backoff.
        let later = t0 + 100 * CONNECTOR_WATCHDOG_STALL_REBUILD_AFTER;
        let (delay, escalate) =
            schedule.observe(ConnectorWatchdogReconcileOutcome::Deferred, later);
        assert!(!escalate, "Healthy must clear the deferred-since timer");
        assert_eq!(
            delay,
            CONNECTOR_WATCHDOG_INITIAL_DELAY,
            "Healthy must reset the doubling backoff"
        );
        // The fresh run escalates only at its own 600s boundary.
        let (_, escalate) = schedule.observe(
            ConnectorWatchdogReconcileOutcome::Deferred,
            later + CONNECTOR_WATCHDOG_STALL_REBUILD_AFTER - Duration::from_secs(1),
        );
        assert!(!escalate);
        let (_, escalate) = schedule.observe(
            ConnectorWatchdogReconcileOutcome::Deferred,
            later + CONNECTOR_WATCHDOG_STALL_REBUILD_AFTER,
        );
        assert!(escalate);
    }

    #[test]
    fn connector_watchdog_retry_keeps_the_doubling_bound_and_never_escalates() {
        let t0 = Instant::now();
        let mut schedule = ConnectorWatchdogSchedule::new();
        let mut expected_delay = CONNECTOR_WATCHDOG_INITIAL_DELAY;
        for _ in 0..8 {
            let (delay, escalate) =
                schedule.observe(ConnectorWatchdogReconcileOutcome::Retry, t0);
            assert!(!escalate, "Retry alone must never arm a stall escalation");
            assert_eq!(delay, expected_delay);
            expected_delay = next_connector_watchdog_retry_delay(expected_delay);
        }
        assert_eq!(expected_delay, CONNECTOR_WATCHDOG_MAX_RETRY_DELAY);
        // A Retry-only run, even an arbitrarily old one, never starts the stall
        // timer: the timer measures Deferred (live-retrying) runs.
        let (_, escalate) = schedule.observe(
            ConnectorWatchdogReconcileOutcome::Retry,
            t0 + Duration::from_secs(60 * 60 * 24),
        );
        assert!(!escalate);
    }

    #[test]
    fn connector_watchdog_stall_timer_is_kept_across_retry_ticks() {
        let t0 = Instant::now();
        let mut schedule = ConnectorWatchdogSchedule::new();
        let (_, escalate) =
            schedule.observe(ConnectorWatchdogReconcileOutcome::Deferred, t0);
        assert!(!escalate);
        // An interleaved Retry tick (remote-start path or a failed rebuild)
        // belongs to the same unhealthy run and must not restart the timer.
        let (_, escalate) = schedule.observe(
            ConnectorWatchdogReconcileOutcome::Retry,
            t0 + Duration::from_secs(300),
        );
        assert!(!escalate);
        let (_, escalate) = schedule.observe(
            ConnectorWatchdogReconcileOutcome::Deferred,
            t0 + CONNECTOR_WATCHDOG_STALL_REBUILD_AFTER,
        );
        assert!(
            escalate,
            "the stall timer measures the whole consecutive Deferred/Retry run"
        );
    }

    #[test]
    fn connector_watchdog_initial_repair_mapping_defers_a_live_retrying_child() {
        use ConnectorWatchdogReconcileOutcome as Outcome;
        assert_eq!(
            initial_watchdog_repair_outcome(SelfHostedConnectorRepair::Accepted, false),
            Some(Outcome::Healthy)
        );
        assert_eq!(
            initial_watchdog_repair_outcome(SelfHostedConnectorRepair::Accepted, true),
            Some(Outcome::Healthy)
        );
        assert_eq!(
            initial_watchdog_repair_outcome(SelfHostedConnectorRepair::ChildRetrying, false),
            Some(Outcome::Deferred)
        );
        // An armed stall escalation deliberately takes the probe/rebuild path
        // even for a retryable cut.
        assert_eq!(
            initial_watchdog_repair_outcome(SelfHostedConnectorRepair::ChildRetrying, true),
            None
        );
        assert_eq!(
            initial_watchdog_repair_outcome(SelfHostedConnectorRepair::RebuildRequired, false),
            None
        );
        assert_eq!(
            initial_watchdog_repair_outcome(SelfHostedConnectorRepair::RebuildRequired, true),
            None
        );
    }

    #[test]
    fn connector_watchdog_post_rebuild_mapping_defers_a_retrying_replacement() {
        use ConnectorWatchdogReconcileOutcome as Outcome;
        assert_eq!(
            post_rebuild_watchdog_outcome(SelfHostedConnectorRepair::Accepted),
            Outcome::Healthy
        );
        assert_eq!(
            post_rebuild_watchdog_outcome(SelfHostedConnectorRepair::ChildRetrying),
            Outcome::Deferred
        );
        assert_eq!(
            post_rebuild_watchdog_outcome(SelfHostedConnectorRepair::RebuildRequired),
            Outcome::Retry
        );
    }

    #[test]
    fn committed_start_arms_supervision_for_every_readiness_wait_outcome() {
        // Regression for the first-Save+Deploy+Start-during-an-outage gap:
        // once desired=true is durable and active_management is published, a
        // readiness wait that deadlines on a retrying cut (or hits a terminal
        // cut / transport error) used to return through `?` BEFORE the only
        // in-session watchdog arm, so dead-child rebuild, remote-center reboot
        // repair, and the 600s stall escalation never ran until relaunch while
        // the UI said recovery was automatic. The committed resolution has no
        // abort-before-arm variant: every failure is only a renderer message,
        // surfaced by the command AFTER arming.
        assert_eq!(
            committed_start_readiness_outcome(Ok(())),
            CommittedStartReadiness::Ready
        );
        assert_eq!(
            committed_start_readiness_outcome(Err(
                MobileRelayV2ManagementCommandState::connector_retrying_error()
            )),
            CommittedStartReadiness::Retrying,
            "a retrying-deadline wait is a committed supervised state, not an abort"
        );
        assert_eq!(
            committed_start_readiness_outcome(Err(management_operation_failed_error())),
            CommittedStartReadiness::NotReady,
            "a terminal cut observed during the wait is rebuilt by the armed watchdog"
        );
        assert_eq!(
            committed_start_readiness_outcome(Err(ManagementError {
                code: "CHANNEL_CLOSED".to_string(),
                message: "Relay v2 management channel closed".to_string(),
                retryable: false,
            })),
            CommittedStartReadiness::NotReady,
            "the child dying during the wait is a supervised rebuild, not an abort"
        );

        // Ready returns the probed status; the failure variants surface their
        // fixed renderer messages, and the two messages must never be swapped.
        assert_eq!(CommittedStartReadiness::Ready.surfaced_error(), None);
        let retrying_message = CommittedStartReadiness::Retrying
            .surfaced_error()
            .expect("the retrying deadline must surface the reachability notice");
        assert!(retrying_message.contains("retrying its relay connection automatically"));
        assert!(retrying_message.contains("SSH host is not reachable"));
        let not_ready_message = CommittedStartReadiness::NotReady
            .surfaced_error()
            .expect("a non-retrying wait failure still surfaces a renderer message");
        assert!(not_ready_message.contains("six required capabilities"));
        assert_ne!(retrying_message, not_ready_message);
    }

    fn config() -> PersistedSelfHostedConfig {
        PersistedSelfHostedConfig {
            contract: CONFIG_CONTRACT.to_string(),
            schema_version: CONFIG_SCHEMA_VERSION,
            enabled: true,
            broker_host_id: "devbox".to_string(),
            issuer_url: "https://relay.company.test/".to_string(),
            listen_host: "0.0.0.0".to_string(),
            listen_port: 443,
            tls_key_path: "/private/tls.key".to_string(),
            tls_certificate_path: "/private/tls.crt".to_string(),
            tls_ca_path: "/private/ca.pem".to_string(),
            external_tls_management: false,
            host_profile_identity: "00112233445566778899aabbccddeeff".to_string(),
            profile_provisioned: false,
            host_credential_provisioned: false,
            connector_desired_running: false,
            management_recovery_required: false,
            bootstrap_rotation_pending: false,
            bootstrap_rotation_request_phase: None,
            bootstrap_rotation_transfer_receipt: None,
            bootstrap_file_name: None,
            bootstrap_publication_correlation: None,
        }
    }

    fn local_identity(inode: u64) -> LocalPrivateFileIdentity {
        LocalPrivateFileIdentity {
            device: 7,
            inode,
            length: 32,
            mode: 0o600,
            uid: 501,
            links: 1,
            sha256: [9; 32],
        }
    }

    #[test]
    fn self_hosted_url_is_an_https_root_without_secret_bearing_components() {
        assert_eq!(
            normalize_issuer_url(" https://relay.company.test "),
            Ok("https://relay.company.test/".to_string())
        );
        for invalid in [
            "http://relay.company.test/",
            "https://user@relay.company.test/",
            "https://relay.company.test/v2",
            "https://relay.company.test/?token=secret",
            "https://relay.company.test/#fragment",
            "https://relay.company.test:0/",
        ] {
            assert!(normalize_issuer_url(invalid).is_err(), "{invalid}");
        }
        assert_eq!(
            relay_url_from_issuer("https://relay.company.test/"),
            Ok("wss://relay.company.test/".to_string())
        );
    }

    #[test]
    fn listen_host_requires_an_explicit_private_ipv4_or_wildcard() {
        for accepted in ["10.2.3.4", "172.31.9.8", "192.168.1.7", "0.0.0.0"] {
            assert_eq!(validate_listen_host(accepted), Ok(accepted.to_string()));
        }
        for rejected in [
            "",
            "relay.internal",
            "172.32.1.1",
            "203.0.113.8",
            "2001:db8::1",
        ] {
            assert!(validate_listen_host(rejected).is_err(), "{rejected}");
        }
    }

    #[test]
    fn restart_restore_requires_complete_prerequisites_and_a_running_exact_deployment() {
        let mut ready = config();
        ready.profile_provisioned = true;
        ready.host_credential_provisioned = true;
        let mut status = base_status(Some(&ready), None);
        status.bundle_status = DeploymentProbeStatus::Ready;
        status.tls_status = DeploymentProbeStatus::Ready;
        status.center_status = DeploymentProbeStatus::Running;

        assert!(!self_hosted_connector_should_be_running(&ready, &status));
        ready.connector_desired_running = true;
        assert!(self_hosted_connector_should_be_running(&ready, &status));

        let mut stopped = status.clone();
        stopped.center_status = DeploymentProbeStatus::Stopped;
        assert!(!self_hosted_connector_should_be_running(&ready, &stopped));

        let mut incomplete = ready.clone();
        incomplete.host_credential_provisioned = false;
        assert!(!self_hosted_connector_should_be_running(
            &incomplete,
            &status
        ));
        incomplete = ready.clone();
        incomplete.profile_provisioned = false;
        assert!(!self_hosted_connector_should_be_running(
            &incomplete,
            &status
        ));
        incomplete = ready.clone();
        incomplete.management_recovery_required = true;
        assert!(!self_hosted_connector_should_be_running(
            &incomplete,
            &status
        ));

        let mut mismatched = status.clone();
        mismatched.tls_status = DeploymentProbeStatus::Missing;
        assert!(!self_hosted_connector_should_be_running(
            &ready,
            &mismatched
        ));
        mismatched = status;
        mismatched.error = Some("redacted probe failure".to_string());
        assert!(!self_hosted_connector_should_be_running(
            &ready,
            &mismatched
        ));
    }

    #[test]
    fn dashboard_close_preserves_a_desired_connector_during_transient_recovery() {
        let mut persisted = config();
        assert!(!self_hosted_connector_should_survive_dashboard_window_close(&persisted));

        persisted.connector_desired_running = true;
        assert!(self_hosted_connector_should_survive_dashboard_window_close(
            &persisted
        ));

        persisted.management_recovery_required = true;
        assert!(self_hosted_connector_should_survive_dashboard_window_close(
            &persisted
        ));
    }

    #[test]
    fn status_projection_exposes_the_v2_primary_flip_condition() {
        let unprovisioned = base_status(Some(&config()), None);
        assert!(unprovisioned.configured);
        assert!(!unprovisioned.profile_provisioned);
        assert!(!unprovisioned.connector_desired_running);
        assert!(!unprovisioned.effective);

        let mut provisioned = config();
        provisioned.profile_provisioned = true;
        provisioned.host_credential_provisioned = true;
        provisioned.connector_desired_running = true;
        let projected = base_status(Some(&provisioned), None);
        assert!(projected.profile_provisioned);
        assert!(projected.connector_desired_running);
        assert!(projected.effective);

        let mut disabled = provisioned.clone();
        disabled.enabled = false;
        assert!(!base_status(Some(&disabled), None).effective);

        let mut incomplete = provisioned.clone();
        incomplete.host_credential_provisioned = false;
        assert!(!base_status(Some(&incomplete), None).effective);

        let mut rotating = provisioned.clone();
        rotating.bootstrap_rotation_pending = true;
        assert!(!base_status(Some(&rotating), None).effective);

        let absent = base_status(None, None);
        assert!(!absent.configured);
        assert!(!absent.profile_provisioned);
        assert!(!absent.connector_desired_running);
        assert!(!absent.effective);
    }

    #[test]
    fn schema_five_migrates_connector_desired_state_to_conservative_stopped() {
        let mut value = serde_json::to_value(config()).unwrap();
        value["schemaVersion"] = serde_json::json!(BOOTSTRAP_CORRELATION_CONFIG_SCHEMA_VERSION);
        value
            .as_object_mut()
            .unwrap()
            .remove("connectorDesiredRunning");

        let mut migrated: PersistedSelfHostedConfig = serde_json::from_value(value).unwrap();
        assert!(!migrated.connector_desired_running);
        ensure_host_profile_identity(&mut migrated).unwrap();
        assert_eq!(migrated.schema_version, CONFIG_SCHEMA_VERSION);
        assert!(!migrated.connector_desired_running);
    }

    #[test]
    fn old_schema_explicit_running_is_unconditionally_migrated_to_stopped() {
        let mut value = serde_json::to_value(config()).unwrap();
        value["schemaVersion"] = serde_json::json!(BOOTSTRAP_CORRELATION_CONFIG_SCHEMA_VERSION);
        value["connectorDesiredRunning"] = serde_json::json!(true);

        let mut migrated: PersistedSelfHostedConfig = serde_json::from_value(value).unwrap();
        assert!(migrated.connector_desired_running);
        ensure_host_profile_identity(&mut migrated).unwrap();
        assert_eq!(migrated.schema_version, CONFIG_SCHEMA_VERSION);
        assert!(!migrated.connector_desired_running);
    }

    #[test]
    fn schema_six_migrates_to_external_tls_schema_preserving_connector_desired_state() {
        // A schema-6 config (the pre-external-TLS current schema) must load
        // without the new field and migrate to schema 7 while preserving the
        // already-durable connector desired state.
        let mut value = serde_json::to_value(config()).unwrap();
        value["schemaVersion"] = serde_json::json!(CONNECTOR_DESIRED_STATE_CONFIG_SCHEMA_VERSION);
        value["connectorDesiredRunning"] = serde_json::json!(true);
        value
            .as_object_mut()
            .unwrap()
            .remove("externalTlsManagement");

        let migrated: PersistedSelfHostedConfig = serde_json::from_value(value).unwrap();
        assert!(!migrated.external_tls_management);
        assert!(migrated.connector_desired_running);
        let mut migrated = migrated;
        ensure_host_profile_identity(&mut migrated).unwrap();
        assert_eq!(migrated.schema_version, CONFIG_SCHEMA_VERSION);
        assert!(migrated.connector_desired_running);
        assert!(!migrated.external_tls_management);
    }

    #[test]
    fn external_tls_management_round_trips_and_defaults_to_false() {
        let mut external = config();
        external.external_tls_management = true;
        external.tls_key_path = String::new();
        external.tls_certificate_path = String::new();
        external.tls_ca_path = String::new();
        let serialized = serde_json::to_value(&external).unwrap();
        assert_eq!(serialized["externalTlsManagement"], serde_json::json!(true));
        let restored: PersistedSelfHostedConfig = serde_json::from_value(serialized).unwrap();
        assert!(restored.external_tls_management);

        let mut legacy = serde_json::to_value(config()).unwrap();
        legacy
            .as_object_mut()
            .unwrap()
            .remove("externalTlsManagement");
        let legacy_restored: PersistedSelfHostedConfig = serde_json::from_value(legacy).unwrap();
        assert!(!legacy_restored.external_tls_management);
    }

    #[test]
    fn external_tls_fingerprint_differs_but_private_fingerprint_stays_stable() {
        let private = config();
        let private_fingerprint = deployment_fingerprint(&private);

        let mut external = private.clone();
        external.external_tls_management = true;
        external.tls_key_path = String::new();
        external.tls_certificate_path = String::new();
        external.tls_ca_path = String::new();
        assert_ne!(deployment_fingerprint(&external), private_fingerprint);

        // The private-mode fingerprint must remain byte-for-byte stable across
        // the schema 7 upgrade so existing remote profiles stay valid.
        let serialized = serde_json::to_value(&private).unwrap();
        let restored: PersistedSelfHostedConfig = serde_json::from_value(serialized).unwrap();
        assert_eq!(deployment_fingerprint(&restored), private_fingerprint);
    }

    #[test]
    fn management_binding_requires_the_exact_persisted_config_except_desired_state() {
        let original = config();
        let binding = SelfHostedManagementBinding {
            persisted_config_identity: persisted_management_config_identity(&original).unwrap(),
            steady_launch_key: ManagementLaunchKey::DefaultProduction,
        };
        assert!(binding.matches_config(&original));

        let mut desired_running = original.clone();
        desired_running.connector_desired_running = true;
        assert!(binding.matches_config(&desired_running));

        let mut different_origin = original.clone();
        different_origin.issuer_url = "https://rotated.company.test/".to_string();
        assert!(!binding.matches_config(&different_origin));

        let mut rotation_started = original;
        rotation_started.bootstrap_rotation_pending = true;
        rotation_started.bootstrap_rotation_request_phase =
            Some(BootstrapRotationRequestPhase::Requested);
        rotation_started.bootstrap_file_name =
            Some("host-bootstrap-rotation.twhostboot2".to_string());
        rotation_started.bootstrap_publication_correlation =
            Some("dashboard-bootstrap-publication-rotation".to_string());
        assert!(!binding.matches_config(&rotation_started));
    }

    #[test]
    fn config_replacement_persists_stopped_then_drains_before_new_commit() {
        use std::cell::RefCell;

        let mut previous = config();
        previous.connector_desired_running = true;
        let mut next = previous.clone();
        next.listen_port = 444;
        let binding = SelfHostedManagementBinding {
            persisted_config_identity: persisted_management_config_identity(&previous).unwrap(),
            steady_launch_key: ManagementLaunchKey::DefaultProduction,
        };
        let mut owner = SelfHostedDeploymentOperationOwner {
            active_management: Some(binding),
            startup_restore_error: Some("old restore error".to_string()),
        };
        let events = RefCell::new(Vec::new());

        let committed = commit_config_replacement_with_barrier(
            &mut owner,
            Some(previous),
            next,
            false,
            |launch_key| {
                assert_eq!(launch_key, &ManagementLaunchKey::DefaultProduction);
                events.borrow_mut().push("drain".to_string());
                Ok(())
            },
            |config| {
                events.borrow_mut().push(format!(
                    "persist:{}:{}",
                    config.listen_port, config.connector_desired_running
                ));
                Ok(())
            },
        )
        .unwrap();

        assert!(!committed.connector_desired_running);
        assert!(owner.active_management.is_none());
        assert_eq!(
            events.into_inner(),
            [
                "persist:443:false".to_string(),
                "drain".to_string(),
                "persist:444:false".to_string(),
            ]
        );
    }

    #[test]
    fn config_replacement_drain_failure_keeps_old_stopped_and_blocks_new_commit() {
        use std::cell::RefCell;

        let mut previous = config();
        previous.connector_desired_running = true;
        let mut next = previous.clone();
        next.listen_port = 444;
        let binding = SelfHostedManagementBinding {
            persisted_config_identity: persisted_management_config_identity(&previous).unwrap(),
            steady_launch_key: ManagementLaunchKey::DefaultProduction,
        };
        let mut owner = SelfHostedDeploymentOperationOwner {
            active_management: Some(binding),
            startup_restore_error: None,
        };
        let events = RefCell::new(Vec::new());

        assert!(commit_config_replacement_with_barrier(
            &mut owner,
            Some(previous),
            next,
            false,
            |_| {
                events.borrow_mut().push("drain".to_string());
                Err("redacted drain failure".to_string())
            },
            |config| {
                events.borrow_mut().push(format!(
                    "persist:{}:{}",
                    config.listen_port, config.connector_desired_running
                ));
                Ok(())
            },
        )
        .is_err());

        assert!(owner.active_management.is_some());
        assert_eq!(
            events.into_inner(),
            ["persist:443:false".to_string(), "drain".to_string()]
        );
    }

    #[test]
    fn center_stop_requires_the_exact_absent_session_postcondition() {
        let script = build_remote_center_stop_script("/usr/bin/tmux");
        let kill = script
            .find("/usr/bin/tmux kill-session -t tw-relay-v2-center")
            .unwrap();
        let postcondition = script
            .find("if /usr/bin/tmux has-session -t tw-relay-v2-center")
            .unwrap();

        assert!(kill < postcondition);
        assert!(script[postcondition..].contains("center_has_session_status=$?"));
        assert!(script[postcondition..].contains("test \"$center_has_session_status\" -eq 1"));
        assert!(!script[postcondition..].contains("|| true"));
    }

    #[test]
    fn center_stop_without_an_active_management_child_still_runs_the_remote_barrier() {
        let events = RefCell::new(Vec::new());
        stop_center_and_active_connector(
            None,
            || {
                events.borrow_mut().push("remote_absence_barrier");
                Ok(())
            },
            |_| {
                events.borrow_mut().push("connector_drain");
                Ok(())
            },
        )
        .unwrap();

        assert_eq!(events.into_inner(), ["remote_absence_barrier"]);
    }

    #[test]
    fn deploy_restarts_a_running_center_and_ends_with_desired_running_true() {
        let events = RefCell::new(Vec::<&str>::new());
        let mut config = config();
        config.connector_desired_running = false;

        let restarted = restart_running_center_after_deploy_with(
            &mut config,
            || {
                events.borrow_mut().push("is_running:yes");
                Ok(true)
            },
            |_| {
                events.borrow_mut().push("ensure_start_allowed:ok");
                Ok(())
            },
            |config, desired| {
                events.borrow_mut().push("persist_desired:true");
                assert!(desired);
                config.connector_desired_running = desired;
                Ok(())
            },
            |_| {
                events.borrow_mut().push("stop_center");
                Ok(())
            },
            |_| {
                events.borrow_mut().push("start_center");
                Ok(())
            },
        )
        .unwrap();

        assert!(restarted);
        assert_eq!(
            events.into_inner(),
            [
                "is_running:yes",
                "ensure_start_allowed:ok",
                "persist_desired:true",
                "stop_center",
                "start_center",
            ]
        );
        // The latch is durable on the config so the watchdog treats the center
        // as wanted even though it was briefly stopped during the restart.
        assert!(config.connector_desired_running);
    }

    #[test]
    fn deploy_stop_success_start_failure_returns_err_and_keeps_the_center_wanted() {
        let events = RefCell::new(Vec::new());
        let mut config = config();
        config.connector_desired_running = false;

        let result = restart_running_center_after_deploy_with(
            &mut config,
            || Ok(true),
            |_| Ok(()),
            |config, desired| {
                config.connector_desired_running = desired;
                Ok(())
            },
            |_| {
                events.borrow_mut().push("stop_center");
                Ok(())
            },
            |_| {
                events.borrow_mut().push("start_center");
                Err("remote tmux new-session failed".to_string())
            },
        );

        let error = result.unwrap_err();
        assert!(
            error.contains("could not be restarted"),
            "unexpected error: {error}"
        );
        assert!(
            error.contains("marked as wanted"),
            "error must tell the operator the watchdog will retry: {error}"
        );
        assert_eq!(events.into_inner(), ["stop_center", "start_center"]);
        // stop succeeded and start failed: the Center is down but desired=true
        // must be latched so D020 (Stopped -> StartRemote) retries the start.
        assert!(
            config.connector_desired_running,
            "desired must remain true after a stop-success/start-failure restart"
        );
    }

    #[test]
    fn deploy_does_not_touch_a_center_that_is_not_running() {
        let events = RefCell::new(Vec::<&str>::new());
        let mut config = config();
        config.connector_desired_running = false;

        let restarted = restart_running_center_after_deploy_with(
            &mut config,
            || {
                events.borrow_mut().push("is_running:no");
                Ok(false)
            },
            |_| {
                events.borrow_mut().push("ensure_start_allowed");
                Ok(())
            },
            |_, _desired| {
                events.borrow_mut().push("persist_desired");
                Ok(())
            },
            |_| {
                events.borrow_mut().push("stop_center");
                Ok(())
            },
            |_| {
                events.borrow_mut().push("start_center");
                Ok(())
            },
        )
        .unwrap();

        assert!(!restarted);
        assert_eq!(events.into_inner(), ["is_running:no"]);
        // A stopped center is never started or latched by Deploy.
        assert!(!config.connector_desired_running);
    }

    #[test]
    fn deploy_leaves_a_running_center_untouched_when_the_restart_start_is_refused() {
        let events = RefCell::new(Vec::<&str>::new());
        let mut config = config();
        config.bootstrap_rotation_pending = true;
        config.connector_desired_running = true;

        let result = restart_running_center_after_deploy_with(
            &mut config,
            || Ok(true),
            |_| Err("Relay v2 Host bootstrap rotation must be completed".to_string()),
            |_, _desired| {
                events.borrow_mut().push("persist_desired");
                Ok(())
            },
            |_| {
                events.borrow_mut().push("stop_center");
                Ok(())
            },
            |_| {
                events.borrow_mut().push("start_center");
                Ok(())
            },
        );

        let error = result.unwrap_err();
        assert!(error.contains("was left untouched"), "{error}");
        // The deterministic refusal happens before any mutation: never kill a
        // running center ahead of a start that could not have run.
        assert!(events.into_inner().is_empty());
        assert!(config.connector_desired_running);
    }

    #[test]
    fn center_status_probe_reports_the_running_version_through_a_whitelist() {
        let snippet = build_remote_center_status_probe_snippet("/usr/bin/tmux");
        assert!(snippet.contains("has-session -t tw-relay-v2-center"));
        assert!(snippet.contains("printf 'center=running\\n'"));
        assert!(snippet.contains("printf 'center=stopped\\n'"));
        assert!(snippet.contains(REMOTE_CENTER_RUNNING_VERSION_FILE));
        // The version line is only emitted after a whitelist case, so a hostile
        // version file can never inject probe output.
        assert!(snippet.contains("printf 'center-version=%s\\n'"));
        assert!(snippet.contains("*[!0-9A-Za-z._-]*"));
    }

    #[test]
    fn center_start_publishes_the_running_version_and_stop_removes_it() {
        let publish = build_remote_center_running_version_publish("1.0.24");
        assert!(publish.contains("printf '%s\\n' '1.0.24'"));
        assert!(publish.contains("chmod 600"));
        assert!(publish.contains(REMOTE_CENTER_RUNNING_VERSION_FILE));
        // Atomic rename: never leave a partial version the probe could read.
        assert!(publish.contains("mv -Tf"));

        let stop = build_remote_center_stop_script("/usr/bin/tmux");
        let postcondition = stop
            .find("test \"$center_has_session_status\" -eq 1")
            .unwrap();
        // The version record is removed only AFTER the absent-session
        // postcondition, so a still-alive center never loses its record.
        assert!(stop[postcondition..]
            .contains(&format!("rm -f -- \"$HOME/.tmux-worktree/relay-v2-self-hosted/{REMOTE_CENTER_RUNNING_VERSION_FILE}\"")));
    }

    #[test]
    fn center_running_version_stale_logic_matches_the_deploy_semantics() {
        // Running + different version -> stale.
        assert!(center_running_version_is_stale(
            DeploymentProbeStatus::Running,
            Some("1.0.23"),
        ));
        // Running + current version -> fresh.
        assert!(!center_running_version_is_stale(
            DeploymentProbeStatus::Running,
            Some(env!("CARGO_PKG_VERSION")),
        ));
        // Running with no recorded version (started by an older Dashboard that
        // never wrote one) is conservatively stale: a Deploy restart is the
        // only way to know it runs the current bundle.
        assert!(center_running_version_is_stale(
            DeploymentProbeStatus::Running,
            None,
        ));
        // Nothing running -> never stale.
        assert!(!center_running_version_is_stale(
            DeploymentProbeStatus::Stopped,
            None,
        ));
        assert!(!center_running_version_is_stale(
            DeploymentProbeStatus::Unknown,
            Some("0.0.1"),
        ));
    }

    #[test]
    fn center_running_version_validation_mirrors_the_shell_whitelist() {
        for valid in ["1.0.24", "1.0.24-rc.1", "2.0.0_beta-3"] {
            assert!(valid_center_running_version(valid), "{valid}");
        }
        for invalid in [
            "",
            "1.0.24\ncenter=running",
            "1.0 24",
            "v1;rm -rf /",
            "v1/2",
        ] {
            assert!(!valid_center_running_version(invalid), "{invalid}");
        }
    }

    #[test]
    fn one_builder_owns_the_canonical_self_hosted_cli_seam_without_secret_values() {
        let mut pending = config();
        pending.bootstrap_file_name = Some("host-bootstrap-output-path.twhostboot2".to_string());
        pending.bootstrap_publication_correlation =
            Some("dashboard-bootstrap-publication-attempt".to_string());
        let attempt = bootstrap_publication_attempt(&pending).unwrap().unwrap();
        let command = build_remote_relay_v2_center_command(&pending, Some(&attempt));
        assert!(command.contains("--v2-single-node-self-hosted"));
        assert!(command.contains("--v2-agent-transcript-lifecycle-v1"));
        assert!(command.contains("--v2-agent-chat-v2"));
        assert!(command.contains("--v2-lark-bindings-v2"));
        assert!(command.contains("--host '0.0.0.0' --port 443"));
        assert!(command.contains("--v2-dev-advertised-origin 'https://relay.company.test/'"));
        assert!(command.contains("--v2-dev-tls-key"));
        assert!(command.contains("--v2-dev-tls-cert"));
        assert!(command.contains("--v2-self-hosted-state-dir"));
        assert!(command.contains("--v2-self-hosted-state-dir \"$relay_v2_state_directory\""));
        assert!(!command.contains(
            "--v2-self-hosted-state-dir \"$HOME/.tmux-worktree/relay-v2-self-hosted/state\""
        ));
        assert!(command.contains(
            "--host-bootstrap-output \"$HOME/.tmux-worktree/relay-v2-self-hosted/bootstrap/host-bootstrap-output-path.twhostboot2\" --v2-self-hosted-bootstrap-correlation 'dashboard-bootstrap-publication-attempt'"
        ));
        for forbidden in [
            "twcap2.",
            "twref2.",
            "twhostboot2.",
            "shared-secret",
            "/private/tls.key",
            "/private/tls.crt",
            "/private/ca.pem",
        ] {
            assert!(!command.contains(forbidden), "{forbidden}");
        }

        let restart = build_remote_relay_v2_center_command(&config(), None);
        assert!(!restart.contains("--host-bootstrap-output"));
        assert!(!restart.contains("--v2-self-hosted-bootstrap-correlation"));
        assert!(!restart.contains("host-bootstrap-"));
    }

    #[test]
    fn publication_correlation_is_opaque_bounded_and_independent_of_the_filename() {
        let correlation = fresh_bootstrap_publication_correlation().unwrap();
        assert!(valid_bootstrap_publication_correlation(&correlation));
        assert!(correlation.len() <= 128);
        assert!(!correlation.contains("twhostboot2"));
        for invalid in [
            "",
            " leading",
            "trailing ",
            "line\nbreak",
            "carriage\rreturn",
            "nul\0byte",
        ] {
            assert!(
                !valid_bootstrap_publication_correlation(invalid),
                "{invalid:?}"
            );
        }
        assert!(!valid_bootstrap_publication_correlation(&"x".repeat(129)));
    }

    #[test]
    fn explicit_rotation_creates_one_replacement_attempt_then_reuses_it_on_retry() {
        let mut pending = config();
        pending.bootstrap_file_name = Some("host-bootstrap-stable-output.twhostboot2".to_string());
        pending.bootstrap_publication_correlation =
            Some("dashboard-bootstrap-publication-expired".to_string());
        let original_correlation = pending.bootstrap_publication_correlation.clone();
        let original_file_name = pending.bootstrap_file_name.clone();

        let mut before_previous_cleanup = pending.clone();
        assert!(
            record_expired_bootstrap_rotation_intent(&mut before_previous_cleanup, None).is_err()
        );
        assert_eq!(before_previous_cleanup, pending);

        assert!(!record_expired_bootstrap_rotation_intent(
            &mut pending,
            Some("dashboard-bootstrap-publication-replacement".to_string())
        )
        .unwrap());
        let replacement_correlation = pending.bootstrap_publication_correlation.clone();
        assert_ne!(replacement_correlation, original_correlation);
        assert_eq!(pending.bootstrap_file_name, original_file_name);
        assert_eq!(
            pending.bootstrap_rotation_request_phase,
            Some(BootstrapRotationRequestPhase::Requested)
        );

        assert!(record_expired_bootstrap_rotation_intent(&mut pending, None).unwrap());
        assert_eq!(
            pending.bootstrap_publication_correlation,
            replacement_correlation
        );
        assert_eq!(pending.bootstrap_file_name, original_file_name);
    }

    #[test]
    fn old_pending_schema_without_publication_correlation_fails_closed() {
        let mut value = serde_json::to_value(config()).unwrap();
        value["schemaVersion"] = serde_json::json!(HOST_PROFILE_CONFIG_SCHEMA_VERSION);
        value
            .as_object_mut()
            .unwrap()
            .remove("bootstrapRotationPending");
        value
            .as_object_mut()
            .unwrap()
            .remove("bootstrapRotationRequestPhase");
        value
            .as_object_mut()
            .unwrap()
            .remove("bootstrapRotationTransferReceipt");
        value
            .as_object_mut()
            .unwrap()
            .remove("bootstrapPublicationCorrelation");
        let mut migrated: PersistedSelfHostedConfig = serde_json::from_value(value).unwrap();
        assert!(!migrated.bootstrap_rotation_pending);
        assert!(migrated.bootstrap_rotation_request_phase.is_none());
        assert!(migrated.bootstrap_rotation_transfer_receipt.is_none());
        ensure_host_profile_identity(&mut migrated).unwrap();
        assert_eq!(migrated.schema_version, CONFIG_SCHEMA_VERSION);

        migrated.schema_version = ROTATION_PENDING_CONFIG_SCHEMA_VERSION;
        migrated.bootstrap_rotation_pending = true;
        migrated.bootstrap_file_name =
            Some("host-bootstrap-migrated-correlation.twhostboot2".to_string());
        assert!(ensure_host_profile_identity(&mut migrated).is_err());
        assert_eq!(
            migrated.schema_version,
            ROTATION_PENDING_CONFIG_SCHEMA_VERSION
        );

        migrated.schema_version = ROTATION_RECEIPT_CONFIG_SCHEMA_VERSION;
        assert!(ensure_host_profile_identity(&mut migrated).is_err());
    }

    #[test]
    fn pending_rotation_reuses_filename_and_ready_recovery_clears_intent() {
        let mut pending = config();
        assert!(ensure_ordinary_center_start_allowed(&pending).is_ok());
        pending.profile_provisioned = true;
        pending.bootstrap_file_name = Some("host-bootstrap-same-output.twhostboot2".to_string());
        pending.bootstrap_publication_correlation =
            Some("dashboard-bootstrap-publication-replacement".to_string());
        pending.bootstrap_rotation_pending = true;
        pending.bootstrap_rotation_request_phase = Some(BootstrapRotationRequestPhase::Requested);
        let file_name = pending.bootstrap_file_name.clone();
        let publication_correlation = pending.bootstrap_publication_correlation.clone();

        // Startup and ordinary Start must not feed the old local input to a
        // Host child before a verified replacement receipt exists.
        assert!(ensure_ordinary_center_start_allowed(&pending).is_err());
        assert!(ready_rotation_transfer_identity(&pending).is_err());
        assert_ne!(
            pending.bootstrap_file_name,
            pending.bootstrap_publication_correlation
        );
        let attempt = bootstrap_publication_attempt(&pending).unwrap().unwrap();
        let first_restart = build_remote_relay_v2_center_command(&pending, Some(&attempt));
        let crash_retry = build_remote_relay_v2_center_command(&pending, Some(&attempt));
        assert_eq!(crash_retry, first_restart);
        assert!(crash_retry.contains("host-bootstrap-same-output.twhostboot2"));
        assert!(crash_retry.contains(
            "--v2-self-hosted-bootstrap-correlation 'dashboard-bootstrap-publication-replacement'"
        ));

        let replacement_identity = local_identity(11);
        pending.bootstrap_rotation_request_phase = None;
        pending.bootstrap_rotation_transfer_receipt = Some(BootstrapRotationTransferReceipt {
            profile_lineage: pending.host_profile_identity.clone(),
            bootstrap_file_name: file_name.clone().unwrap(),
            bootstrap_publication_correlation: publication_correlation.clone().unwrap(),
            local_identity: replacement_identity.clone(),
            phase: BootstrapRotationTransferPhase::RemoteCleanupPending,
        });
        assert!(ready_rotation_transfer_identity(&pending).is_err());
        pending
            .bootstrap_rotation_transfer_receipt
            .as_mut()
            .unwrap()
            .phase = BootstrapRotationTransferPhase::Ready;
        assert_eq!(
            ready_rotation_transfer_identity(&pending).unwrap(),
            Some(&replacement_identity)
        );
        assert!(ensure_ordinary_center_start_allowed(&pending).is_err());
        assert!(verify_rotation_transfer_identity(&pending, &replacement_identity).is_ok());
        assert!(verify_rotation_transfer_identity(&pending, &local_identity(12)).is_err());
        let mut wrong_lineage = pending.clone();
        wrong_lineage
            .bootstrap_rotation_transfer_receipt
            .as_mut()
            .unwrap()
            .profile_lineage = "ffeeddccbbaa99887766554433221100".to_string();
        assert!(ready_rotation_transfer_identity(&wrong_lineage).is_err());
        let mut wrong_correlation = pending.clone();
        wrong_correlation
            .bootstrap_rotation_transfer_receipt
            .as_mut()
            .unwrap()
            .bootstrap_publication_correlation =
            "dashboard-bootstrap-publication-other".to_string();
        assert!(ready_rotation_transfer_identity(&wrong_correlation).is_err());

        let wrong_ready_correlation = Some("dashboard-bootstrap-publication-other".to_string());
        assert!(commit_bootstrap_ready_state(
            &mut pending.clone(),
            &file_name,
            &wrong_ready_correlation
        )
        .is_err());
        commit_bootstrap_ready_state(&mut pending, &file_name, &publication_correlation).unwrap();
        assert!(pending.host_credential_provisioned);
        assert!(!pending.bootstrap_rotation_pending);
        assert!(pending.bootstrap_rotation_request_phase.is_none());
        assert!(pending.bootstrap_rotation_transfer_receipt.is_none());
        assert!(pending.bootstrap_file_name.is_none());
        assert!(pending.bootstrap_publication_correlation.is_none());

        // Replaying the ready journal after a crash between config commit and
        // journal cleanup is idempotent.
        commit_bootstrap_ready_state(&mut pending, &file_name, &publication_correlation).unwrap();
        assert!(pending.host_credential_provisioned);
        assert!(!pending.bootstrap_rotation_pending);
    }

    #[cfg(unix)]
    #[test]
    fn rotation_receipt_requires_the_exact_fd_bound_local_replacement_identity() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let path = directory
            .path()
            .join("host-bootstrap-replacement.twhostboot2");
        std::fs::write(&path, b"twhostboot2.replacement-one\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        let replacement = read_local_private_file(
            &path.to_string_lossy(),
            "Relay v2 Host bootstrap replacement",
            8_193,
        )
        .unwrap();
        assert!(bootstrap_bytes_match_local_identity(
            b"twhostboot2.replacement-one\n",
            &replacement.identity
        ));
        assert!(!bootstrap_bytes_match_local_identity(
            b"twhostboot2.replacement-other\n",
            &replacement.identity
        ));
        let mut pending = config();
        pending.bootstrap_rotation_pending = true;
        pending.bootstrap_file_name = Some("host-bootstrap-replacement.twhostboot2".to_string());
        pending.bootstrap_publication_correlation =
            Some("dashboard-bootstrap-publication-replacement".to_string());
        pending.bootstrap_rotation_transfer_receipt = Some(BootstrapRotationTransferReceipt {
            profile_lineage: pending.host_profile_identity.clone(),
            bootstrap_file_name: pending.bootstrap_file_name.clone().unwrap(),
            bootstrap_publication_correlation: pending
                .bootstrap_publication_correlation
                .clone()
                .unwrap(),
            local_identity: replacement.identity,
            phase: BootstrapRotationTransferPhase::RemoteCleanupPending,
        });

        assert!(ready_rotation_transfer_identity(&pending).is_err());
        verify_rotation_transfer_receipt_local_at(&pending, &path).unwrap();
        std::fs::write(&path, b"twhostboot2.replacement-two\n").unwrap();
        assert!(verify_rotation_transfer_receipt_local_at(&pending, &path).is_err());
    }

    #[test]
    fn launcher_resolves_home_alias_to_one_revalidated_canonical_state_argument() {
        let preflight = build_remote_state_directory_launcher_preflight();
        assert!(preflight
            .contains("relay_v2_state_alias=\"$HOME/.tmux-worktree/relay-v2-self-hosted/state\""));
        assert!(preflight.contains(
            "relay_v2_state_directory=\"$(/usr/bin/realpath -e -- \"$relay_v2_state_alias\")\""
        ));
        assert!(preflight.contains("case \"$relay_v2_state_directory\" in"));
        assert!(preflight.contains(
            "test \"$(/usr/bin/realpath -e -- \"$relay_v2_state_directory\")\" = \"$relay_v2_state_directory\""
        ));
        assert!(preflight.contains("require_private_dir \"$relay_v2_state_alias\""));
        assert!(preflight.contains("require_private_dir \"$relay_v2_state_directory\""));
        assert!(preflight.contains("stat -c %d:%i -- \"$relay_v2_state_alias\""));
        assert!(preflight.contains("stat -c %d:%i -- \"$relay_v2_state_directory\""));
        assert!(!preflight.contains("eval"));
    }

    #[test]
    fn linux_current_symlink_publish_uses_no_follow_atomic_replacement() {
        let script = build_remote_bundle_publish_script(
            ".tmux-worktree/relay-v2-self-hosted/.bundle-stage-test",
            "dashboard-test",
            "deployment-test",
            "1.2.3",
        );
        assert!(script.contains("ln -s \"bundles/dashboard-test\" \"$next\""));
        assert!(script.contains("mv -Tf \"$next\" \"$root/current\""));
        assert!(!script.contains("mv -f \"$next\" \"$root/current\""));
        assert!(!script.contains("then require_current_bundle"));
        assert!(script.contains("require_current_bundle"));
        assert!(script.contains("require_bundle_tree \"$target\""));
    }

    #[test]
    fn remote_bundle_stage_rejects_links_then_converges_private_modes() {
        let script = build_remote_bundle_stage_validation_script(
            ".tmux-worktree/relay-v2-self-hosted/.bundle-stage-test",
        );
        assert!(script.contains("test \"$(uname -s)\" = \"Linux\""));
        assert!(script.contains("test \"$(uname -m)\" = \"x86_64\""));
        assert!(script.contains("mv --version"));
        assert!(script.contains("-type l"));
        assert!(script.contains("! -type d ! -type f"));
        assert!(script.contains("! -uid \"$uid\""));
        assert!(script.contains("-type d -exec chmod 700"));
        assert!(script.contains("-type f -exec chmod 600"));
        assert!(script.contains("-type f ! -perm 0600"));
        assert!(script.contains("major === 22 && minor >= 16"));
    }

    #[cfg(unix)]
    #[test]
    fn consumed_ready_journal_is_validated_and_finalized_on_next_prepare() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let journal_path = directory
            .path()
            .join("management-ready-commit-journal-v1.json");
        let consumed = consumed_local_private_file_path(
            &journal_path,
            "Relay v2 management ready commit journal",
        )
        .unwrap();
        let journal = ReadyCommitJournal {
            contract: READY_COMMIT_JOURNAL_CONTRACT.to_string(),
            schema_version: READY_COMMIT_JOURNAL_SCHEMA_VERSION,
            profile_lineage: "00112233445566778899aabbccddeeff".to_string(),
            bootstrap_file_name: None,
            bootstrap_publication_correlation: None,
            bootstrap_identity: None,
            provision_profile_identity: None,
        };
        let mut bytes = serde_json::to_vec(&journal).unwrap();
        bytes.push(b'\n');
        std::fs::write(&consumed, bytes).unwrap();
        std::fs::set_permissions(&consumed, std::fs::Permissions::from_mode(0o600)).unwrap();

        let (_, identity) = load_ready_commit_journal_at(&journal_path)
            .unwrap()
            .expect("consumed journal remains a recoverable commit record");
        finish_consuming_if_present(
            &journal_path,
            &identity,
            16 * 1024,
            "Relay v2 management ready commit journal",
        )
        .unwrap();
        assert!(!consumed.exists());
        assert!(load_ready_commit_journal_at(&journal_path)
            .unwrap()
            .is_none());
    }

    #[cfg(unix)]
    #[test]
    fn local_private_file_read_is_no_follow_single_link_and_fd_bound() {
        use std::os::unix::fs::{symlink, PermissionsExt};

        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source.pem");
        std::fs::write(&source, b"private input").unwrap();
        std::fs::set_permissions(&source, std::fs::Permissions::from_mode(0o600)).unwrap();
        let opened =
            read_local_private_file(&source.to_string_lossy(), "test input", 1024).unwrap();
        assert_eq!(opened.bytes, b"private input");

        let link = directory.path().join("link.pem");
        symlink(&source, &link).unwrap();
        assert!(read_local_private_file(&link.to_string_lossy(), "test input", 1024).is_err());

        let hard_link = directory.path().join("hard.pem");
        std::fs::hard_link(&source, &hard_link).unwrap();
        assert!(read_local_private_file(&source.to_string_lossy(), "test input", 1024).is_err());
    }

    #[test]
    fn bootstrap_transfer_accepts_only_one_bounded_private_record() {
        assert!(validate_bootstrap_bytes(b"twhostboot2.selector.secret\n").is_ok());
        for invalid in [
            b"".as_slice(),
            b"twcap2.not-a-bootstrap\n",
            b"twhostboot2.selector.secret\nextra",
            b"twhostboot2.selector.secret\r\n",
        ] {
            assert!(validate_bootstrap_bytes(invalid).is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn remote_bootstrap_reader_uses_one_no_follow_fd_and_rechecks_identity() {
        use std::io::Write;
        use std::os::unix::fs::{symlink, PermissionsExt};
        use std::process::{Command, Stdio};

        let shell = build_remote_bootstrap_read_script("$HOME/private/bootstrap");
        assert!(shell.contains("node - \"$file\""));
        assert!(!shell.contains("cat \"$file\""));
        assert!(REMOTE_BOOTSTRAP_FD_READER.contains("O_NOFOLLOW"));
        assert_eq!(REMOTE_BOOTSTRAP_FD_READER.matches("fstatSync").count(), 2);
        assert!(REMOTE_BOOTSTRAP_FD_READER.contains("readSync(fd"));

        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("bootstrap");
        std::fs::write(&source, b"twhostboot2.fd-bound\n").unwrap();
        std::fs::set_permissions(&source, std::fs::Permissions::from_mode(0o600)).unwrap();
        let run = |path: &std::path::Path| {
            let mut child = Command::new("node")
                .arg("-")
                .arg(path)
                .arg("8193")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            child
                .stdin
                .take()
                .unwrap()
                .write_all(REMOTE_BOOTSTRAP_FD_READER.as_bytes())
                .unwrap();
            child.wait_with_output().unwrap()
        };
        let output = run(&source);
        assert!(output.status.success());
        assert_eq!(output.stdout, b"twhostboot2.fd-bound\n");

        let link = directory.path().join("bootstrap-link");
        symlink(&source, &link).unwrap();
        assert!(!run(&link).status.success());
    }

    #[test]
    fn ensure_self_contained_ca_chain_appends_root_when_missing() {
        // Bundle already ends with a newline: root appended after exactly one newline.
        let leaf_chain = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n";
        let result =
            String::from_utf8(ensure_self_contained_ca_chain(leaf_chain.as_bytes())).unwrap();
        assert_eq!(result, format!("{leaf_chain}{ISRG_ROOT_X1_PEM}\n"));
        // Bundle with no trailing newline: a single newline is inserted before the root.
        let leaf_chain_no_nl = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----";
        let result_no_nl =
            String::from_utf8(ensure_self_contained_ca_chain(leaf_chain_no_nl.as_bytes())).unwrap();
        assert_eq!(
            result_no_nl,
            format!("{leaf_chain_no_nl}\n{ISRG_ROOT_X1_PEM}\n")
        );
        // Ends with exactly the root PEM (plus one trailing newline) in both
        // cases, appearing exactly once.
        for out in [&result, &result_no_nl] {
            assert!(out.ends_with(&format!("{ISRG_ROOT_X1_PEM}\n")));
            assert_eq!(
                out.matches(&ISRG_ROOT_X1_PEM.to_string()).count(),
                1,
                "root PEM should appear exactly once"
            );
        }
    }

    #[test]
    fn ensure_self_contained_ca_chain_unchanged_when_root_present_differently_wrapped() {
        // The same ISRG Root X1 cert, but with the base64 body on a single line
        // so line-wrapping differs from ISRG_ROOT_X1_PEM.
        let body = certificate_bodies(ISRG_ROOT_X1_PEM)
            .into_iter()
            .next()
            .unwrap();
        let single_line_root =
            format!("-----BEGIN CERTIFICATE-----\n{body}\n-----END CERTIFICATE-----\n");
        let bundle = format!(
            "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n{single_line_root}"
        );
        let result = ensure_self_contained_ca_chain(bundle.as_bytes());
        assert_eq!(result, bundle.as_bytes());
    }

    #[test]
    fn ensure_self_contained_ca_chain_unchanged_when_node_entry_cap_exceeded() {
        // A bundle that alone fits the 1 MiB local cap but, with the root
        // appended, would exceed Node's 16 KiB per-entry CA cap.
        let oversized = vec![b'A'; NODE_TLS_CA_MAX_ENTRY_BYTES];
        let result = ensure_self_contained_ca_chain(&oversized);
        assert_eq!(result, oversized);
    }

    #[test]
    fn ensure_self_contained_ca_chain_unchanged_when_local_size_cap_exceeded() {
        // Appending the root to a near-1MiB bundle would exceed MAX_TLS_FILE_BYTES.
        let oversized = vec![b'B'; (1024 * 1024) - 32];
        let result = ensure_self_contained_ca_chain(&oversized);
        assert_eq!(result, oversized);
    }

    #[test]
    fn ensure_self_contained_ca_chain_is_idempotent() {
        let leaf_chain = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n";
        let once = ensure_self_contained_ca_chain(leaf_chain.as_bytes());
        let twice = ensure_self_contained_ca_chain(&once);
        assert_eq!(once, twice);
    }
}
