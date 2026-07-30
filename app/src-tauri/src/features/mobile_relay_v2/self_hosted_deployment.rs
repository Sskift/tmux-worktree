use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::ffi::{CStr, OsStr};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{Manager, State};

use super::management_child::{
    ManagementChildSelection, ManagementPreparedFileIdentity, ManagementStartError,
};
use super::MobileRelayV2ManagementCommandState;
use crate::config::find_host;
use crate::features::control_plane::{scp_cli_to_host, scp_directory_to_host};
use crate::remote::{
    remote_tmux_cmd, run_remote_cmd_check_strings, run_remote_cmd_output,
    run_remote_cmd_with_input, HostConfig,
};
use crate::support::{app_home_dir, atomic_write_file, shell_quote};

const CONFIG_CONTRACT: &str = "tmux-worktree-dashboard-relay-v2-self-hosted";
const CONFIG_SCHEMA_VERSION: u32 = 2;
const LEGACY_CONFIG_SCHEMA_VERSION: u32 = 1;
const REMOTE_PROFILE_SCHEMA_VERSION: u32 = 1;
const FEATURE_KIND: &str = "explicit_self_hosted";
const CENTER_SESSION: &str = "tw-relay-v2-center";
const REMOTE_ROOT: &str = ".tmux-worktree/relay-v2-self-hosted";
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

const REMOTE_SECURITY_FUNCTIONS: &str = r#"LC_ALL=C
export LC_ALL
uid="$(id -u)"
require_linux_x86_64() {
  test "$(uname -s)" = "Linux"
  test "$(uname -m)" = "x86_64"
  mv --version 2>/dev/null | grep -Fq "GNU coreutils"
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
  ensure_parent_dir "$HOME/.tmux-worktree"
  ensure_private_dir "$HOME/.tmux-worktree/relay-v2-self-hosted"
  ensure_private_dir "$HOME/.tmux-worktree/relay-v2-self-hosted/bundles"
  ensure_private_dir "$HOME/.tmux-worktree/relay-v2-self-hosted/tls"
  ensure_private_dir "$HOME/.tmux-worktree/relay-v2-self-hosted/state"
  ensure_private_dir "$HOME/.tmux-worktree/relay-v2-self-hosted/bootstrap"
}
require_relay_layout() {
  require_linux_x86_64
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

// Node >=22 delegates fs.openSync to libuv, which always applies close-on-exec
// to returned descriptors. The helper adds O_NOFOLLOW itself and performs both
// validation passes plus the bounded read against that single descriptor.
const REMOTE_BOOTSTRAP_FD_READER: &str = r#"const fs = require("node:fs");
const major = Number(process.versions.node.split(".")[0]);
if (!Number.isInteger(major) || major < 22) throw new Error("NODE_22_REQUIRED");
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
const ADVERTISED_ORIGIN_FLAG: &str = "--v2-dev-advertised-origin";
const TLS_KEY_FLAG: &str = "--v2-dev-tls-key";
const TLS_CERTIFICATE_FLAG: &str = "--v2-dev-tls-cert";
const STATE_DIRECTORY_FLAG: &str = "--v2-self-hosted-state-dir";

#[derive(Default)]
pub(crate) struct MobileRelayV2SelfHostedDeploymentState {
    operation: Mutex<()>,
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
    host_profile_identity: String,
    #[serde(default)]
    profile_provisioned: bool,
    #[serde(default)]
    host_credential_provisioned: bool,
    #[serde(default)]
    management_recovery_required: bool,
    bootstrap_file_name: Option<String>,
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
    remote_tls_key_path: String,
    remote_tls_certificate_path: String,
    remote_tls_ca_path: String,
    remote_profile_path: String,
    remote_state_directory: String,
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

impl PreparedSelfHostedManagementLaunch {
    pub(crate) fn selection(&self) -> ManagementChildSelection {
        self.selection.clone()
    }

    pub(crate) fn commit_ready(mut self) -> Result<(), String> {
        let journal = ReadyCommitJournal {
            contract: READY_COMMIT_JOURNAL_CONTRACT.to_string(),
            schema_version: 1,
            profile_lineage: self.config.host_profile_identity.clone(),
            bootstrap_file_name: self.config.bootstrap_file_name.clone(),
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
            self.config.bootstrap_file_name = None;
            self.config.host_credential_provisioned = true;
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
    let tls_key_path = if inspect_tls {
        validate_local_tls_file(&input.tls_key_path, "TLS private key")?
    } else {
        input.tls_key_path.trim().to_string()
    };
    let tls_certificate_path = if inspect_tls {
        validate_local_tls_file(&input.tls_certificate_path, "TLS certificate")?
    } else {
        input.tls_certificate_path.trim().to_string()
    };
    let tls_ca_path = if inspect_tls {
        validate_local_tls_file(&input.tls_ca_path, "TLS CA certificate")?
    } else {
        input.tls_ca_path.trim().to_string()
    };
    if tls_key_path.is_empty()
        || tls_certificate_path.is_empty()
        || tls_ca_path.is_empty()
        || !Path::new(&tls_key_path).is_absolute()
        || !Path::new(&tls_certificate_path).is_absolute()
        || !Path::new(&tls_ca_path).is_absolute()
    {
        return Err(
            "Select absolute local TLS key, leaf certificate, and CA certificate paths".to_string(),
        );
    }
    if tls_key_path == tls_certificate_path
        || tls_key_path == tls_ca_path
        || tls_certificate_path == tls_ca_path
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
        host_profile_identity: String::new(),
        profile_provisioned: false,
        host_credential_provisioned: false,
        management_recovery_required: false,
        bootstrap_file_name,
    })
}

fn validated_config_with_persisted_state(
    input: MobileRelayV2SelfHostedConfigInput,
    inspect_tls: bool,
) -> Result<PersistedSelfHostedConfig, String> {
    let current = load_config()?;
    let mut config = validated_config(input, None, inspect_tls)?;
    if let Some(mut current) = current {
        ensure_host_profile_identity(&mut current)?;
        let same_host_lineage = current.broker_host_id == config.broker_host_id
            && current.issuer_url == config.issuer_url;
        if current.bootstrap_file_name.is_some() && !same_host_lineage {
            return Err(
                "Finish the pending Relay v2 Host bootstrap before changing its devbox or URL"
                    .to_string(),
            );
        }
        if current.profile_provisioned && current.issuer_url != config.issuer_url {
            return Err(
                "The persisted Relay v2 Host profile cannot be changed to another Relay URL"
                    .to_string(),
            );
        }
        config.host_profile_identity = current.host_profile_identity;
        config.profile_provisioned = current.profile_provisioned;
        config.host_credential_provisioned = current.host_credential_provisioned;
        config.management_recovery_required = current.management_recovery_required;
        config.bootstrap_file_name = current.bootstrap_file_name;
    } else {
        config.host_profile_identity = fresh_host_profile_identity()?;
    }
    Ok(config)
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
    let config: PersistedSelfHostedConfig = serde_json::from_slice(&contents.bytes)
        .map_err(|_| "Relay v2 self-hosted configuration is invalid".to_string())?;
    if config.contract != CONFIG_CONTRACT
        || !matches!(
            config.schema_version,
            LEGACY_CONFIG_SCHEMA_VERSION | CONFIG_SCHEMA_VERSION
        )
        || !config.enabled
        || config.broker_host_id.trim() != config.broker_host_id
        || config.broker_host_id.is_empty()
        || normalize_issuer_url(&config.issuer_url)? != config.issuer_url
        || validate_listen_host(&config.listen_host)? != config.listen_host
        || config.listen_port == 0
        || config.tls_key_path.is_empty()
        || config.tls_certificate_path.is_empty()
        || config.tls_ca_path.is_empty()
        || !Path::new(&config.tls_key_path).is_absolute()
        || !Path::new(&config.tls_certificate_path).is_absolute()
        || !Path::new(&config.tls_ca_path).is_absolute()
        || (config.schema_version == CONFIG_SCHEMA_VERSION
            && !valid_host_profile_identity(&config.host_profile_identity))
        || config.host_credential_provisioned && !config.profile_provisioned
        || config.host_credential_provisioned && config.bootstrap_file_name.is_some()
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
    }
}

fn deployment_fingerprint(config: &PersistedSelfHostedConfig) -> String {
    let input = serde_json::json!({
        "brokerHostId": config.broker_host_id,
        "issuerUrl": config.issuer_url,
        "listenHost": config.listen_host,
        "listenPort": config.listen_port,
        "tlsKeyPath": config.tls_key_path,
        "tlsCertificatePath": config.tls_certificate_path,
        "tlsCaPath": config.tls_ca_path,
    });
    let bytes = serde_json::to_vec(&input).expect("fixed deployment fingerprint schema serializes");
    format!("{:x}", Sha256::digest(bytes))
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

fn ensure_host_profile_identity(config: &mut PersistedSelfHostedConfig) -> Result<(), String> {
    if config.schema_version == LEGACY_CONFIG_SCHEMA_VERSION
        && config.host_profile_identity.is_empty()
    {
        config.host_profile_identity = fresh_host_profile_identity()?;
        config.schema_version = CONFIG_SCHEMA_VERSION;
    }
    if !valid_host_profile_identity(&config.host_profile_identity) {
        return Err("Relay v2 Host profile identity is invalid".to_string());
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
    let parent = path
        .parent()
        .ok_or_else(|| format!("{label} has no private parent"))?;
    let file_name = path
        .file_name()
        .ok_or_else(|| format!("{label} has no file name"))?;
    let tombstone = parent.join(format!(".{}.consumed", file_name.to_string_lossy()));
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
    match std::fs::symlink_metadata(&path) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("inspect Relay v2 management ready commit journal failed".to_string()),
    }
    let file = read_local_private_file(
        &path.to_string_lossy(),
        "Relay v2 management ready commit journal",
        16 * 1024,
    )?;
    let journal: ReadyCommitJournal = serde_json::from_slice(&file.bytes)
        .map_err(|_| "Relay v2 management ready commit journal is invalid".to_string())?;
    if journal.contract != READY_COMMIT_JOURNAL_CONTRACT
        || journal.schema_version != 1
        || !valid_host_profile_identity(&journal.profile_lineage)
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
    let parent = path
        .parent()
        .ok_or_else(|| format!("{label} has no private parent"))?;
    let file_name = path
        .file_name()
        .ok_or_else(|| format!("{label} has no file name"))?;
    let tombstone = parent.join(format!(".{}.consumed", file_name.to_string_lossy()));
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

fn recover_ready_commit(
    config: &mut PersistedSelfHostedConfig,
    journal: ReadyCommitJournal,
    journal_identity: &LocalPrivateFileIdentity,
) -> Result<(), String> {
    if journal.profile_lineage != config.host_profile_identity
        || journal.bootstrap_identity.is_some() != journal.bootstrap_file_name.is_some()
    {
        return Err("Relay v2 management ready commit journal does not match config".to_string());
    }
    if let Some(expected) = &journal.bootstrap_identity {
        if config.bootstrap_file_name == journal.bootstrap_file_name {
            finish_consuming_if_present(
                &local_bootstrap_path(config)?,
                expected,
                MAX_BOOTSTRAP_RAW_BYTES as u64,
                "Relay v2 Host bootstrap input",
            )?;
            config.bootstrap_file_name = None;
            config.host_credential_provisioned = true;
        } else if config.bootstrap_file_name.is_some() || !config.host_credential_provisioned {
            return Err(
                "Relay v2 management ready commit journal does not match config".to_string(),
            );
        }
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
    consume_local_private_file(
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
    ensure_local_host_private_tree()?;
    ensure_local_native_credential_directory()?;

    let ca = read_local_private_file(
        &config.tls_ca_path,
        "TLS CA certificate",
        MAX_TLS_FILE_BYTES,
    )?;
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
        profile.as_ref().map(|file| file.path.clone()),
        bootstrap.as_ref().map(|file| file.path.clone()),
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
        remote_tls_key_path: format!("~/{REMOTE_TLS_KEY}"),
        remote_tls_certificate_path: format!("~/{REMOTE_TLS_CERTIFICATE}"),
        remote_tls_ca_path: format!("~/{REMOTE_TLS_CA}"),
        remote_profile_path: format!("~/{REMOTE_PROFILE}"),
        remote_state_directory: format!("~/{REMOTE_STATE_DIRECTORY}"),
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
tls_present=0
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
if {} has-session -t {CENTER_SESSION} 2>/dev/null; then printf 'center=running\n'; else printf 'center=stopped\n'; fi
"#,
        remote_tmux_cmd(&host),
    );
    match run_remote_cmd_check_strings(&host, &["sh".into(), "-lc".into(), script]) {
        Ok(output) => {
            for line in output.lines() {
                match line {
                    "bundle=ready" => status.bundle_status = DeploymentProbeStatus::Ready,
                    "bundle=missing" => status.bundle_status = DeploymentProbeStatus::Missing,
                    "tls=ready" => status.tls_status = DeploymentProbeStatus::Ready,
                    "tls=missing" => status.tls_status = DeploymentProbeStatus::Missing,
                    "center=running" => status.center_status = DeploymentProbeStatus::Running,
                    "center=stopped" => status.center_status = DeploymentProbeStatus::Stopped,
                    _ => {}
                }
            }
        }
        Err(error) => status.error = Some(error),
    }
    status
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
if test -e "$root/current" || test -L "$root/current"; then require_current_bundle; fi
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
    publish_remote_profile(&host, config)
}

fn build_remote_relay_v2_center_command(
    config: &PersistedSelfHostedConfig,
    bootstrap_file_name: Option<&str>,
) -> String {
    let mut arguments = vec![
        "/usr/bin/env".to_string(),
        "node".to_string(),
        format!("\"$HOME/{REMOTE_ROOT}/current/cli.cjs\""),
        "relay-server".to_string(),
        SELF_HOSTED_FLAG.to_string(),
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
        format!("\"$HOME/{REMOTE_STATE_DIRECTORY}\""),
    ];
    if let Some(bootstrap_file_name) = bootstrap_file_name {
        arguments.push("--host-bootstrap-output".to_string());
        arguments.push(format!(
            "\"$HOME/{REMOTE_ROOT}/bootstrap/{bootstrap_file_name}\""
        ));
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
    ensure_local_host_private_tree()?;
    let local_file = local_bootstrap_path(config)?;
    atomic_write_file(&local_file, &output.stdout)?;
    if !secure_bootstrap_file(&local_file) {
        return Err("Relay v2 Host bootstrap local file is unsafe".to_string());
    }
    let cleanup = run_remote_cmd_check_strings(
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
    );
    if cleanup.is_err() {
        let _ = std::fs::remove_file(&local_file);
        return Err("Relay v2 Host bootstrap remote cleanup failed".to_string());
    }
    Ok(())
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

fn start_center(config: &mut PersistedSelfHostedConfig) -> Result<(), String> {
    let host = find_host(&config.broker_host_id)?;
    if center_is_running(&host)? {
        if !config.host_credential_provisioned
            && config.bootstrap_file_name.is_some()
            && !local_bootstrap_path(config).is_ok_and(|path| secure_bootstrap_file(&path))
        {
            transfer_remote_bootstrap(&host, config)?;
        }
        return Ok(());
    }

    let bootstrap_output = if config.host_credential_provisioned {
        None
    } else if config.bootstrap_file_name.is_none() {
        let name = format!(
            "host-bootstrap-{}.twhostboot2",
            uuid::Uuid::new_v4().simple()
        );
        config.bootstrap_file_name = Some(name.clone());
        // Persist the non-secret correlation before launch so a failed local
        // transfer can repair from the same remote output without minting a
        // second bootstrap.
        save_config(config)?;
        Some(name)
    } else if !local_bootstrap_path(config).is_ok_and(|path| secure_bootstrap_file(&path)) {
        if remote_bootstrap_is_available(&host, config)? {
            transfer_remote_bootstrap(&host, config)?;
            None
        } else {
            // This is still the same pending first-Host bootstrap. Reuse its
            // persisted output path so repair never mints a second
            // correlation; the Broker remains the credential authority.
            config.bootstrap_file_name.clone()
        }
    } else {
        None
    };
    let command = build_remote_relay_v2_center_command(config, bootstrap_output.as_deref());
    let fingerprint = deployment_fingerprint(config);
    let launcher = format!("$HOME/{REMOTE_ROOT}/relay-v2-center.sh");
    let launcher_stage = format!(
        "$HOME/{REMOTE_ROOT}/.relay-v2-center-{}.stage",
        uuid::Uuid::new_v4().simple()
    );
    let tmux = remote_tmux_cmd(&host);
    let script = format!(
        r#"{REMOTE_SECURITY_FUNCTIONS}
set -eu
require_relay_layout
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
"#,
        bootstrap_output_guard = bootstrap_output
            .as_deref()
            .map(|name| {
                format!(
                    "test ! -e \"$root/bootstrap/{name}\"\ntest ! -L \"$root/bootstrap/{name}\""
                )
            })
            .unwrap_or_else(|| ":".to_string()),
    );
    run_remote_cmd_check_strings(&host, &["sh".into(), "-lc".into(), script])?;
    if bootstrap_output.is_some() {
        transfer_remote_bootstrap(&host, config)?;
    }
    save_config(config)?;
    Ok(())
}

fn stop_center(config: &PersistedSelfHostedConfig) -> Result<(), String> {
    let host = find_host(&config.broker_host_id)?;
    run_remote_cmd_check_strings(
        &host,
        &[
            "sh".into(),
            "-lc".into(),
            format!(
                r#"{REMOTE_SECURITY_FUNCTIONS}
set -eu
require_relay_layout
{} kill-session -t {} 2>/dev/null || true
"#,
                remote_tmux_cmd(&host),
                CENTER_SESSION
            ),
        ],
    )
    .map(|_| ())
}

#[tauri::command]
pub(crate) async fn mobile_relay_v2_self_hosted_status(
    state: State<'_, Arc<MobileRelayV2SelfHostedDeploymentState>>,
) -> Result<MobileRelayV2SelfHostedStatus, String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = state
            .operation
            .lock()
            .map_err(|_| "Relay v2 deployment owner is unavailable".to_string())?;
        Ok(current_status())
    })
    .await
    .map_err(|error| format!("Relay v2 status task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn mobile_relay_v2_self_hosted_save_config(
    args: MobileRelayV2SelfHostedConfigInput,
    state: State<'_, Arc<MobileRelayV2SelfHostedDeploymentState>>,
) -> Result<MobileRelayV2SelfHostedStatus, String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = state
            .operation
            .lock()
            .map_err(|_| "Relay v2 deployment owner is unavailable".to_string())?;
        let config = validated_config_with_persisted_state(args, false)?;
        save_config(&config)?;
        prepare_local_host_prerequisites_for(&config)?;
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
) -> Result<MobileRelayV2SelfHostedStatus, String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = state
            .operation
            .lock()
            .map_err(|_| "Relay v2 deployment owner is unavailable".to_string())?;
        let config = validated_config_with_persisted_state(args, true)?;
        save_config(&config)?;
        prepare_local_host_prerequisites_for(&config)?;
        deploy_bundle(&app, &config)?;
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
        let _guard = state
            .operation
            .lock()
            .map_err(|_| "Relay v2 deployment owner is unavailable".to_string())?;
        let saved =
            load_config()?.ok_or("Save and deploy the Relay v2 self-hosted configuration first")?;
        let requested = validated_config(args, saved.bootstrap_file_name.clone(), false)?;
        if !same_deployment_config(&saved, &requested) {
            return Err(
                "Save and deploy the current Relay v2 configuration before starting".to_string(),
            );
        }
        let mut config = saved;
        prepare_local_host_prerequisites_for(&config)?;
        start_center(&mut config)?;
        let prepared = prepare_relay_v2_self_hosted_management_prerequisites()?
            .ok_or("Relay v2 self-hosted management configuration disappeared")?;
        let selection = prepared.selection();
        management
            .replace_self_hosted(&app, selection, move || prepared.commit_ready())
            .map_err(|error| match error {
                ManagementStartError::RecoveryRequired => {
                    "Relay v2 Host cleanup is uncertain; operator recovery is required".to_string()
                }
                ManagementStartError::Unavailable | ManagementStartError::ChannelClosed => {
                    "Relay v2 self-hosted Host could not become ready".to_string()
                }
            })?;
        let committed =
            load_config()?.ok_or("Relay v2 self-hosted management configuration disappeared")?;
        Ok(probe_status(&committed))
    })
    .await
    .map_err(|error| format!("Relay v2 start task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn mobile_relay_v2_self_hosted_stop_center(
    state: State<'_, Arc<MobileRelayV2SelfHostedDeploymentState>>,
) -> Result<MobileRelayV2SelfHostedStatus, String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = state
            .operation
            .lock()
            .map_err(|_| "Relay v2 deployment owner is unavailable".to_string())?;
        let config = load_config()?.ok_or("Relay v2 self-hosted deployment is not configured")?;
        stop_center(&config)?;
        Ok(probe_status(&config))
    })
    .await
    .map_err(|error| format!("Relay v2 stop task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::{
        build_remote_bootstrap_read_script, build_remote_bundle_publish_script,
        build_remote_bundle_stage_validation_script, build_remote_relay_v2_center_command,
        normalize_issuer_url, read_local_private_file, relay_url_from_issuer,
        validate_bootstrap_bytes, validate_listen_host, PersistedSelfHostedConfig, CONFIG_CONTRACT,
        CONFIG_SCHEMA_VERSION, REMOTE_BOOTSTRAP_FD_READER,
    };

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
            host_profile_identity: "00112233445566778899aabbccddeeff".to_string(),
            profile_provisioned: false,
            host_credential_provisioned: false,
            management_recovery_required: false,
            bootstrap_file_name: None,
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
    fn one_builder_owns_the_canonical_self_hosted_cli_seam_without_secret_values() {
        let command = build_remote_relay_v2_center_command(
            &config(),
            Some("host-bootstrap-correlation.twhostboot2"),
        );
        assert!(command.contains("--v2-single-node-self-hosted"));
        assert!(command.contains("--host '0.0.0.0' --port 443"));
        assert!(command.contains("--v2-dev-advertised-origin 'https://relay.company.test/'"));
        assert!(command.contains("--v2-dev-tls-key"));
        assert!(command.contains("--v2-dev-tls-cert"));
        assert!(command.contains("--v2-self-hosted-state-dir"));
        assert!(command.contains("--host-bootstrap-output"));
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
        assert!(!restart.contains("host-bootstrap-"));
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
}
