use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::ffi::{OsStr, OsString};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tauri::Manager;

use super::management_protocol_v2;
use crate::features::control_plane::node_bin;

const CONTRACT: &str = "tmux-worktree-dashboard-relay-v2-management-ipc";
const PROTOCOL_VERSION_V1: u32 = 1;
const MAX_FRAME_PAYLOAD_BYTES: usize = 16_384;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
const OPERATION_TIMEOUT: Duration = Duration::from_secs(5);
// The Node Host owns a bounded five-second WSS drain before it can close the
// native credential cell and remove its exact admission claim. Keep the
// supervisor deadline strictly outside that owner deadline so ordinary
// Dashboard shutdown cannot turn a clean close into a SIGKILL/crash cut.
const CLEAN_CLOSE_TIMEOUT: Duration = Duration::from_secs(15);
const REQUEST_ID_PREFIX_V1: &str = "dmgmt1.";
const SUPERSEDED_EXIT_CODE: i32 = 78;
const HIDDEN_MANAGEMENT_ENTRY: &str = "__relay-v2-dashboard-management-stdio";
const SUPERVISOR_POLL_INTERVAL: Duration = Duration::from_millis(2);
const STDOUT_OBSERVATION_CAPACITY: usize = 4;
const STDOUT_DRAIN_BYTES: usize = (MAX_FRAME_PAYLOAD_BYTES + 1) * 2;
const MANAGEMENT_CHILD_ENVIRONMENT_ALLOWLIST: [&str; 6] =
    ["HOME", "PATH", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE"];

#[derive(Clone, Debug, PartialEq, Eq)]
struct BundledManagementArtifact {
    path: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ManagementPreparedFileIdentity {
    pub(crate) device: u64,
    pub(crate) inode: u64,
    pub(crate) length: u64,
    pub(crate) mode: u32,
    pub(crate) uid: u32,
    pub(crate) links: u64,
    pub(crate) sha256: [u8; 32],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ManagementPreparedFileMarker {
    path: PathBuf,
    device: u64,
    inode: u64,
    length: u64,
    mode: u32,
    uid: u32,
    links: u64,
}

impl ManagementPreparedFileMarker {
    fn from_prepared(path: &Path, identity: &ManagementPreparedFileIdentity) -> Self {
        Self {
            path: path.to_path_buf(),
            device: identity.device,
            inode: identity.inode,
            length: identity.length,
            mode: identity.mode,
            uid: identity.uid,
            links: identity.links,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ManagementBootstrapSecretMode {
    ReplacePending,
}

impl ManagementBootstrapSecretMode {
    fn as_argument(&self) -> &'static str {
        match self {
            Self::ReplacePending => "replace-pending",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ManagementChildSelection {
    DefaultProduction,
    SelfHostedDarwinArm64 {
        account_home: PathBuf,
        credential_https_ca_input: PathBuf,
        carrier_wss_ca_input: PathBuf,
        credential_https_ca_identity: ManagementPreparedFileIdentity,
        carrier_wss_ca_identity: ManagementPreparedFileIdentity,
        profile_lineage: String,
        provision_profile_input: Option<(PathBuf, ManagementPreparedFileIdentity)>,
        bootstrap_secret_input: Option<(PathBuf, ManagementPreparedFileIdentity)>,
        bootstrap_secret_mode: Option<ManagementBootstrapSecretMode>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ManagementLaunchKey {
    DefaultProduction,
    SelfHostedDarwinArm64 {
        account_home: PathBuf,
        credential_https_ca_input: PathBuf,
        carrier_wss_ca_input: PathBuf,
        credential_https_ca_identity: ManagementPreparedFileIdentity,
        carrier_wss_ca_identity: ManagementPreparedFileIdentity,
        profile_lineage: String,
        provision_profile_input: Option<ManagementPreparedFileMarker>,
        bootstrap_secret_input: Option<ManagementPreparedFileMarker>,
        bootstrap_secret_mode: Option<ManagementBootstrapSecretMode>,
    },
}

impl ManagementChildSelection {
    pub(crate) fn self_hosted_darwin_arm64(
        account_home: PathBuf,
        credential_https_ca_input: PathBuf,
        carrier_wss_ca_input: PathBuf,
        credential_https_ca_identity: ManagementPreparedFileIdentity,
        carrier_wss_ca_identity: ManagementPreparedFileIdentity,
        profile_lineage: String,
        provision_profile_input: Option<(PathBuf, ManagementPreparedFileIdentity)>,
        bootstrap_secret_input: Option<(PathBuf, ManagementPreparedFileIdentity)>,
        bootstrap_secret_mode: Option<ManagementBootstrapSecretMode>,
    ) -> Result<Self, ManagementStartError> {
        if !account_home.is_absolute()
            || !credential_https_ca_input.is_absolute()
            || !carrier_wss_ca_input.is_absolute()
            || credential_https_ca_identity.mode != 0o600
            || carrier_wss_ca_identity.mode != 0o600
            || credential_https_ca_identity.links != 1
            || carrier_wss_ca_identity.links != 1
            || credential_https_ca_identity.length == 0
            || carrier_wss_ca_identity.length == 0
            || provision_profile_input
                .as_ref()
                .is_some_and(|(path, identity)| {
                    !path.is_absolute()
                        || identity.mode != 0o600
                        || identity.links != 1
                        || identity.length == 0
                })
            || bootstrap_secret_input
                .as_ref()
                .is_some_and(|(path, identity)| {
                    !path.is_absolute()
                        || identity.mode != 0o600
                        || identity.links != 1
                        || identity.length == 0
                })
            || (bootstrap_secret_mode.is_some() && bootstrap_secret_input.is_none())
            || profile_lineage.len() != 32
            || !profile_lineage.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(ManagementStartError::Unavailable);
        }
        Ok(Self::SelfHostedDarwinArm64 {
            account_home,
            credential_https_ca_input,
            carrier_wss_ca_input,
            credential_https_ca_identity,
            carrier_wss_ca_identity,
            profile_lineage,
            provision_profile_input,
            bootstrap_secret_input,
            bootstrap_secret_mode,
        })
    }

    pub(crate) fn launch_key(&self) -> ManagementLaunchKey {
        match self {
            Self::DefaultProduction => ManagementLaunchKey::DefaultProduction,
            Self::SelfHostedDarwinArm64 {
                account_home,
                credential_https_ca_input,
                carrier_wss_ca_input,
                credential_https_ca_identity,
                carrier_wss_ca_identity,
                profile_lineage,
                provision_profile_input,
                bootstrap_secret_input,
                bootstrap_secret_mode,
            } => ManagementLaunchKey::SelfHostedDarwinArm64 {
                account_home: account_home.clone(),
                credential_https_ca_input: credential_https_ca_input.clone(),
                carrier_wss_ca_input: carrier_wss_ca_input.clone(),
                credential_https_ca_identity: credential_https_ca_identity.clone(),
                carrier_wss_ca_identity: carrier_wss_ca_identity.clone(),
                profile_lineage: profile_lineage.clone(),
                provision_profile_input: provision_profile_input.as_ref().map(
                    |(path, identity)| ManagementPreparedFileMarker::from_prepared(path, identity),
                ),
                bootstrap_secret_input: bootstrap_secret_input.as_ref().map(|(path, identity)| {
                    ManagementPreparedFileMarker::from_prepared(path, identity)
                }),
                bootstrap_secret_mode: bootstrap_secret_mode.clone(),
            },
        }
    }

    pub(crate) fn steady_launch_key(&self) -> ManagementLaunchKey {
        match self.launch_key() {
            ManagementLaunchKey::SelfHostedDarwinArm64 {
                account_home,
                credential_https_ca_input,
                carrier_wss_ca_input,
                credential_https_ca_identity,
                carrier_wss_ca_identity,
                profile_lineage,
                ..
            } => ManagementLaunchKey::SelfHostedDarwinArm64 {
                account_home,
                credential_https_ca_input,
                carrier_wss_ca_input,
                credential_https_ca_identity,
                carrier_wss_ca_identity,
                profile_lineage,
                provision_profile_input: None,
                bootstrap_secret_input: None,
                bootstrap_secret_mode: None,
            },
            ManagementLaunchKey::DefaultProduction => ManagementLaunchKey::DefaultProduction,
        }
    }

    fn append_fixed_arguments(&self, command: &mut Command) {
        match self {
            Self::DefaultProduction => {}
            Self::SelfHostedDarwinArm64 {
                credential_https_ca_input,
                carrier_wss_ca_input,
                provision_profile_input,
                bootstrap_secret_input,
                bootstrap_secret_mode,
                ..
            } => {
                command
                    .arg("--self-hosted")
                    .arg("--credential-https-ca-input")
                    .arg(credential_https_ca_input)
                    .arg("--carrier-wss-ca-input")
                    .arg(carrier_wss_ca_input);
                if let Some((path, _)) = provision_profile_input {
                    command.arg("--provision-profile-input").arg(path);
                }
                if let Some((path, _)) = bootstrap_secret_input {
                    command.arg("--bootstrap-secret-input").arg(path);
                }
                if let Some(mode) = bootstrap_secret_mode {
                    command
                        .arg("--bootstrap-secret-mode")
                        .arg(mode.as_argument());
                }
            }
        }
    }

    fn account_home_override(&self) -> Option<&Path> {
        match self {
            Self::DefaultProduction => None,
            Self::SelfHostedDarwinArm64 { account_home, .. } => Some(account_home),
        }
    }
}

impl BundledManagementArtifact {
    fn path(&self) -> &Path {
        &self.path
    }
}

fn bundled_management_artifact_in(
    resource_dir: Option<PathBuf>,
) -> Result<BundledManagementArtifact, ManagementStartError> {
    let resource_dir = resource_dir.ok_or(ManagementStartError::Unavailable)?;
    if !resource_dir.is_absolute() {
        return Err(ManagementStartError::Unavailable);
    }
    let path = resource_dir.join("tw-cli").join("cli.cjs");
    let metadata =
        std::fs::symlink_metadata(&path).map_err(|_| ManagementStartError::Unavailable)?;
    if !path.is_absolute() || !metadata.file_type().is_file() {
        return Err(ManagementStartError::Unavailable);
    }
    Ok(BundledManagementArtifact { path })
}

fn resolve_bundled_management_artifact(
    app: &tauri::AppHandle,
) -> Result<BundledManagementArtifact, ManagementStartError> {
    bundled_management_artifact_in(app.path().resource_dir().ok())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ChildExit {
    code: Option<i32>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum ChildRead {
    Bytes(Vec<u8>),
    Eof,
    Exited(ChildExit),
    TimedOut,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ChildPoll {
    Pending,
    Output,
    Eof,
    Exited(ChildExit),
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ChildWrite {
    Written(usize),
    Exited(ChildExit),
    TimedOut,
    Failed,
}

trait ChildLifecycle: Send + Sync {
    fn kill_if_live(&self);
    fn wait_and_reap(&self) -> ChildExit;
    fn wait_until(&self, deadline: Instant) -> Option<ChildExit>;
}

trait ManagementChildProcess: ChildLifecycle {
    fn close_stdin(&self);
    fn write_stdin_once(&self, frame: &[u8], deadline: Instant) -> ChildWrite;
    fn read_stdout(&self, deadline: Instant) -> ChildRead;
    fn poll_stdout(&self) -> ChildPoll;
    fn poll_health(&self, deadline: Instant) -> ChildPoll;
    fn poll_after_response(&self, deadline: Instant) -> ChildPoll;
}

enum SpawnAttempt {
    Ready(Arc<dyn ManagementChildProcess>),
    FailedBeforeChild,
    FailedAfterChild(Arc<dyn ChildLifecycle>),
}

trait ChildFactory: Send + Sync {
    fn spawn(&self, artifact: &BundledManagementArtifact) -> SpawnAttempt;
}

struct ExactChildState {
    child: Child,
    exit: Option<ChildExit>,
}

struct ExactChildAuthority {
    state: Mutex<ExactChildState>,
}

impl ExactChildAuthority {
    fn new(child: Child) -> Self {
        Self {
            state: Mutex::new(ExactChildState { child, exit: None }),
        }
    }

    fn take_stdio(&self) -> (Option<ChildStdin>, Option<ChildStdout>) {
        let mut state = self.state.lock().unwrap();
        (state.child.stdin.take(), state.child.stdout.take())
    }

    fn try_exit(&self) -> Result<Option<ChildExit>, ()> {
        let mut state = self.state.lock().unwrap();
        if let Some(exit) = state.exit {
            return Ok(Some(exit));
        }
        match state.child.try_wait().map_err(|_| ())? {
            Some(status) => {
                let exit = child_exit(status);
                state.exit = Some(exit);
                Ok(Some(exit))
            }
            None => Ok(None),
        }
    }
}

impl ChildLifecycle for ExactChildAuthority {
    fn kill_if_live(&self) {
        let mut state = self.state.lock().unwrap();
        if state.exit.is_some() {
            return;
        }
        match state.child.try_wait() {
            Ok(Some(status)) => state.exit = Some(child_exit(status)),
            Ok(None) | Err(_) => {
                let _ = state.child.kill();
            }
        }
    }

    fn wait_and_reap(&self) -> ChildExit {
        let mut state = self.state.lock().unwrap();
        if let Some(exit) = state.exit {
            return exit;
        }
        let exit = loop {
            match state.child.wait() {
                Ok(status) => break child_exit(status),
                Err(_) => {
                    let _ = state.child.kill();
                    thread::yield_now();
                }
            }
        };
        state.exit = Some(exit);
        exit
    }

    fn wait_until(&self, deadline: Instant) -> Option<ChildExit> {
        loop {
            match self.try_exit() {
                Ok(Some(exit)) => return Some(exit),
                Ok(None) if Instant::now() < deadline => {
                    thread::sleep(SUPERVISOR_POLL_INTERVAL);
                }
                Ok(None) | Err(()) => return None,
            }
        }
    }
}

fn child_exit(status: ExitStatus) -> ChildExit {
    ChildExit {
        code: status.code(),
    }
}

enum StdoutEvent {
    Frame(Vec<u8>),
    Violation,
    Eof,
    Exited(ChildExit),
    Failed,
}

struct ObservationState {
    events: VecDeque<StdoutEvent>,
    partial: bool,
    drain_started_generation: u64,
    drain_ack_generation: u64,
    requested_drain_generation: u64,
    #[cfg(test)]
    pause_unsolicited_drains: bool,
    discarded: bool,
}

struct BoundedObservationQueue {
    state: Mutex<ObservationState>,
    changed: Condvar,
}

impl BoundedObservationQueue {
    fn new() -> Self {
        Self {
            state: Mutex::new(ObservationState {
                events: VecDeque::new(),
                partial: false,
                drain_started_generation: 0,
                drain_ack_generation: 0,
                requested_drain_generation: 0,
                #[cfg(test)]
                pause_unsolicited_drains: false,
                discarded: false,
            }),
            changed: Condvar::new(),
        }
    }

    fn push(&self, event: StdoutEvent) -> bool {
        let mut state = self.state.lock().unwrap();
        while state.events.len() >= STDOUT_OBSERVATION_CAPACITY && !state.discarded {
            state = self.changed.wait(state).unwrap();
        }
        if state.discarded {
            return false;
        }
        state.events.push_back(event);
        self.changed.notify_all();
        true
    }

    fn set_partial(&self, partial: bool) -> bool {
        let mut state = self.state.lock().unwrap();
        if state.discarded {
            return false;
        }
        state.partial = partial;
        self.changed.notify_all();
        true
    }

    fn begin_drain(&self) -> Option<u64> {
        let mut state = self.state.lock().unwrap();
        loop {
            if state.discarded {
                return None;
            }
            #[cfg(test)]
            if state.pause_unsolicited_drains
                && state.requested_drain_generation <= state.drain_started_generation
            {
                state = self.changed.wait(state).unwrap();
                continue;
            }
            let generation = state.drain_started_generation.checked_add(1)?;
            state.drain_started_generation = generation;
            return Some(generation);
        }
    }

    fn end_drain(&self, generation: u64) {
        let mut state = self.state.lock().unwrap();
        state.drain_ack_generation = state.drain_ack_generation.max(generation);
        self.changed.notify_all();
    }

    fn wait_for_next_drain(&self) -> bool {
        #[allow(unused_mut)]
        let mut state = self.state.lock().unwrap();
        loop {
            if state.discarded {
                return false;
            }
            if state.requested_drain_generation > state.drain_started_generation {
                return true;
            }
            #[cfg(test)]
            if state.pause_unsolicited_drains {
                state = self.changed.wait(state).unwrap();
                continue;
            }
            let (next, _) = self
                .changed
                .wait_timeout(state, SUPERVISOR_POLL_INTERVAL)
                .unwrap();
            return !next.discarded;
        }
    }

    fn recv_until(&self, deadline: Instant) -> Option<StdoutEvent> {
        let mut state = self.state.lock().unwrap();
        loop {
            if let Some(event) = state.events.pop_front() {
                self.changed.notify_all();
                return Some(event);
            }
            if state.discarded {
                return None;
            }
            let remaining = deadline.checked_duration_since(Instant::now())?;
            let (next, timeout) = self.changed.wait_timeout(state, remaining).unwrap();
            state = next;
            if timeout.timed_out() {
                return None;
            }
        }
    }

    fn poll_idle(&self) -> ChildPoll {
        let mut state = self.state.lock().unwrap();
        if state.discarded {
            return ChildPoll::Failed;
        }
        if state.partial {
            return ChildPoll::Output;
        }
        let Some(event) = state.events.pop_front() else {
            return ChildPoll::Pending;
        };
        self.changed.notify_all();
        match event {
            StdoutEvent::Frame(_) | StdoutEvent::Violation => ChildPoll::Output,
            StdoutEvent::Eof => ChildPoll::Eof,
            StdoutEvent::Exited(exit) => ChildPoll::Exited(exit),
            StdoutEvent::Failed => ChildPoll::Failed,
        }
    }

    fn poll_protocol_after_response(&self, deadline: Instant) -> ChildPoll {
        let mut state = self.state.lock().unwrap();
        let Some(required_generation) = state.drain_started_generation.checked_add(1) else {
            return ChildPoll::Failed;
        };
        state.requested_drain_generation =
            state.requested_drain_generation.max(required_generation);
        self.changed.notify_all();
        loop {
            if state.discarded {
                return ChildPoll::Failed;
            }
            if state.partial {
                return ChildPoll::Output;
            }
            match state.events.front() {
                Some(StdoutEvent::Frame(_) | StdoutEvent::Violation | StdoutEvent::Failed) => {
                    return ChildPoll::Output;
                }
                // A terminal observation was produced only after the stdout
                // owner drained the exact pipe to EOF (and, for Exited,
                // reaped the exact child). It is itself stronger evidence
                // than a later empty-drain acknowledgement.
                Some(StdoutEvent::Eof | StdoutEvent::Exited(_)) => {
                    return ChildPoll::Pending;
                }
                None if state.drain_ack_generation >= required_generation => {
                    return ChildPoll::Pending;
                }
                None => {}
            }
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                return ChildPoll::Failed;
            };
            let (next, timeout) = self.changed.wait_timeout(state, remaining).unwrap();
            state = next;
            if timeout.timed_out() {
                return ChildPoll::Failed;
            }
        }
    }

    fn poll_health(&self, deadline: Instant) -> ChildPoll {
        let mut state = self.state.lock().unwrap();
        let Some(required_generation) = state.drain_started_generation.checked_add(1) else {
            return ChildPoll::Failed;
        };
        state.requested_drain_generation =
            state.requested_drain_generation.max(required_generation);
        self.changed.notify_all();
        loop {
            if state.discarded {
                return ChildPoll::Failed;
            }
            if state.partial {
                return ChildPoll::Output;
            }
            if let Some(event) = state.events.pop_front() {
                self.changed.notify_all();
                return match event {
                    StdoutEvent::Frame(_) | StdoutEvent::Violation => ChildPoll::Output,
                    StdoutEvent::Eof => ChildPoll::Eof,
                    StdoutEvent::Exited(exit) => ChildPoll::Exited(exit),
                    StdoutEvent::Failed => ChildPoll::Failed,
                };
            }
            if state.drain_ack_generation >= required_generation {
                return ChildPoll::Pending;
            }
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                return ChildPoll::Failed;
            };
            let (next, timeout) = self.changed.wait_timeout(state, remaining).unwrap();
            state = next;
            if timeout.timed_out() {
                return ChildPoll::Failed;
            }
        }
    }

    fn discard(&self) {
        let mut state = self.state.lock().unwrap();
        state.discarded = true;
        state.partial = false;
        state.events.clear();
        self.changed.notify_all();
    }

    #[cfg(test)]
    fn pause_unsolicited_drains_after_current_ack(&self, deadline: Instant) -> bool {
        let mut state = self.state.lock().unwrap();
        state.pause_unsolicited_drains = true;
        loop {
            if state.discarded {
                return false;
            }
            if state.drain_started_generation == state.drain_ack_generation {
                return true;
            }
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                return false;
            };
            let (next, timeout) = self.changed.wait_timeout(state, remaining).unwrap();
            state = next;
            if timeout.timed_out() {
                return false;
            }
        }
    }
}

struct OneWriteResult<W> {
    writer: Option<W>,
    outcome: ChildWrite,
}

struct WriteWorkerState {
    closed: bool,
    workers: Vec<JoinHandle<()>>,
}

struct WriteWorkerBarrier {
    state: Mutex<WriteWorkerState>,
}

impl WriteWorkerBarrier {
    fn new() -> Self {
        Self {
            state: Mutex::new(WriteWorkerState {
                closed: false,
                workers: Vec::new(),
            }),
        }
    }

    fn restore_if_open(&self, restore: impl FnOnce()) {
        let state = self.state.lock().unwrap();
        if !state.closed {
            restore();
        }
    }

    fn join_completed(&self) {
        let workers = std::mem::take(&mut self.state.lock().unwrap().workers);
        for worker in workers {
            let _ = worker.join();
        }
    }

    fn close_and_join(&self) {
        let workers = {
            let mut state = self.state.lock().unwrap();
            state.closed = true;
            std::mem::take(&mut state.workers)
        };
        for worker in workers {
            let _ = worker.join();
        }
    }
}

fn write_once_before_deadline<W: Write + Send + 'static>(
    mut writer: W,
    frame: Vec<u8>,
    deadline: Instant,
    workers: &WriteWorkerBarrier,
) -> OneWriteResult<W> {
    let (result_tx, result_rx) = mpsc::sync_channel(1);
    {
        let mut state = workers.state.lock().unwrap();
        if state.closed {
            return OneWriteResult {
                writer: None,
                outcome: ChildWrite::Failed,
            };
        }
        let worker = match thread::Builder::new()
            .name("relay-v2-management-stdin".to_string())
            .spawn(move || {
                let outcome = writer
                    .write(&frame)
                    .map(ChildWrite::Written)
                    .unwrap_or(ChildWrite::Failed);
                let _ = result_tx.send((writer, outcome));
            }) {
            Ok(worker) => worker,
            Err(_) => {
                return OneWriteResult {
                    writer: None,
                    outcome: ChildWrite::Failed,
                }
            }
        };
        state.workers.push(worker);
    }
    let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
        return OneWriteResult {
            writer: None,
            outcome: ChildWrite::TimedOut,
        };
    };
    match result_rx.recv_timeout(remaining) {
        Ok((writer, outcome)) => {
            workers.join_completed();
            OneWriteResult {
                writer: Some(writer),
                outcome,
            }
        }
        Err(RecvTimeoutError::Timeout) => OneWriteResult {
            writer: None,
            outcome: ChildWrite::TimedOut,
        },
        Err(RecvTimeoutError::Disconnected) => {
            workers.join_completed();
            OneWriteResult {
                writer: None,
                outcome: ChildWrite::Failed,
            }
        }
    }
}

struct ExactExitProbe {
    authority: Arc<ExactChildAuthority>,
}

impl ExactExitProbe {
    fn try_exit(&self) -> Result<Option<ChildExit>, ()> {
        self.authority.try_exit()
    }
}

#[cfg(unix)]
fn set_stdout_nonblocking(stdout: &ChildStdout) -> std::io::Result<()> {
    use std::os::fd::AsRawFd;
    use std::os::raw::c_int;

    unsafe extern "C" {
        fn fcntl(fd: c_int, command: c_int, ...) -> c_int;
    }

    const F_GETFL: c_int = 3;
    const F_SETFL: c_int = 4;
    #[cfg(any(target_os = "linux", target_os = "android"))]
    const O_NONBLOCK: c_int = 0x800;
    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    const O_NONBLOCK: c_int = 0x4;

    let fd = stdout.as_raw_fd();
    let flags = unsafe { fcntl(fd, F_GETFL) };
    if flags < 0 || unsafe { fcntl(fd, F_SETFL, flags | O_NONBLOCK) } < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(unix))]
fn set_stdout_nonblocking(_stdout: &ChildStdout) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "management child requires nonblocking stdout",
    ))
}

fn bounded_exit_probe(probe: &ExactExitProbe) -> Result<Option<ChildExit>, ()> {
    let deadline = Instant::now() + Duration::from_millis(10);
    loop {
        if let Some(exit) = probe.try_exit()? {
            return Ok(Some(exit));
        }
        if Instant::now() >= deadline {
            return Ok(None);
        }
        thread::sleep(Duration::from_millis(1));
    }
}

fn run_stdout_owner(
    mut stdout: ChildStdout,
    probe: ExactExitProbe,
    observations: Arc<BoundedObservationQueue>,
) {
    let mut frame = Vec::with_capacity(MAX_FRAME_PAYLOAD_BYTES.min(1_024));
    let mut read_buffer = [0u8; 4_096];
    loop {
        let Some(drain_generation) = observations.begin_drain() else {
            return;
        };
        let mut drained = 0usize;
        let reached_would_block = loop {
            if drained >= STDOUT_DRAIN_BYTES {
                break false;
            }
            match stdout.read(&mut read_buffer) {
                Ok(0) => {
                    if !frame.is_empty() {
                        observations.set_partial(false);
                        observations.push(StdoutEvent::Violation);
                    } else {
                        match bounded_exit_probe(&probe) {
                            Ok(Some(exit)) => {
                                observations.push(StdoutEvent::Exited(exit));
                            }
                            Ok(None) => {
                                observations.push(StdoutEvent::Eof);
                            }
                            Err(()) => {
                                observations.push(StdoutEvent::Failed);
                            }
                        }
                    }
                    observations.end_drain(drain_generation);
                    return;
                }
                Ok(read) => {
                    drained = drained.saturating_add(read);
                    for byte in &read_buffer[..read] {
                        if *byte == b'\n' {
                            observations.set_partial(false);
                            if !observations.push(StdoutEvent::Frame(std::mem::take(&mut frame))) {
                                return;
                            }
                        } else if frame.len() == MAX_FRAME_PAYLOAD_BYTES {
                            observations.set_partial(false);
                            observations.push(StdoutEvent::Violation);
                            observations.end_drain(drain_generation);
                            return;
                        } else {
                            frame.push(*byte);
                        }
                    }
                    if !observations.set_partial(!frame.is_empty()) {
                        return;
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break true,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => {
                    observations.set_partial(false);
                    observations.push(StdoutEvent::Failed);
                    observations.end_drain(drain_generation);
                    return;
                }
            }
        };
        if !reached_would_block {
            observations.end_drain(drain_generation);
            continue;
        }
        match probe.try_exit() {
            Ok(Some(exit)) => {
                if !frame.is_empty() {
                    observations.set_partial(false);
                    observations.push(StdoutEvent::Violation);
                } else {
                    observations.push(StdoutEvent::Exited(exit));
                }
                observations.end_drain(drain_generation);
                return;
            }
            Ok(None) => {
                observations.end_drain(drain_generation);
                if !observations.wait_for_next_drain() {
                    return;
                }
            }
            Err(()) => {
                observations.set_partial(false);
                observations.push(StdoutEvent::Failed);
                observations.end_drain(drain_generation);
                return;
            }
        }
    }
}

struct ProductionProcess {
    authority: Arc<ExactChildAuthority>,
    stdin: Mutex<Option<ChildStdin>>,
    observations: Arc<BoundedObservationQueue>,
    stdout_worker: Mutex<Option<JoinHandle<()>>>,
    write_workers: WriteWorkerBarrier,
}

impl ProductionProcess {
    fn new(
        authority: Arc<ExactChildAuthority>,
        stdin: ChildStdin,
        stdout: ChildStdout,
    ) -> Result<Self, Arc<ExactChildAuthority>> {
        if set_stdout_nonblocking(&stdout).is_err() {
            return Err(authority);
        }
        let observations = Arc::new(BoundedObservationQueue::new());
        let worker_observations = observations.clone();
        let probe = ExactExitProbe {
            authority: authority.clone(),
        };
        let stdout_worker = thread::Builder::new()
            .name("relay-v2-management-stdout".to_string())
            .spawn(move || run_stdout_owner(stdout, probe, worker_observations))
            .map_err(|_| authority.clone())?;
        Ok(Self {
            authority,
            stdin: Mutex::new(Some(stdin)),
            observations,
            stdout_worker: Mutex::new(Some(stdout_worker)),
            write_workers: WriteWorkerBarrier::new(),
        })
    }

    fn map_stdout_event(&self, event: StdoutEvent) -> ChildRead {
        match event {
            StdoutEvent::Frame(mut payload) => {
                payload.push(b'\n');
                ChildRead::Bytes(payload)
            }
            StdoutEvent::Violation | StdoutEvent::Failed => ChildRead::Failed,
            StdoutEvent::Eof => ChildRead::Eof,
            StdoutEvent::Exited(exit) => ChildRead::Exited(exit),
        }
    }

    fn finish_io(&self) {
        self.observations.discard();
        self.write_workers.close_and_join();
        self.stdin.lock().unwrap().take();
        let stdout_worker = self.stdout_worker.lock().unwrap().take();
        if let Some(worker) = stdout_worker {
            let _ = worker.join();
        }
    }
}

impl ChildLifecycle for ProductionProcess {
    fn kill_if_live(&self) {
        self.authority.kill_if_live();
    }

    fn wait_and_reap(&self) -> ChildExit {
        let exit = self.authority.wait_and_reap();
        self.finish_io();
        exit
    }

    fn wait_until(&self, deadline: Instant) -> Option<ChildExit> {
        self.authority.wait_until(deadline)
    }
}

impl ManagementChildProcess for ProductionProcess {
    fn close_stdin(&self) {
        self.write_workers.close_and_join();
        self.stdin.lock().unwrap().take();
    }

    fn write_stdin_once(&self, frame: &[u8], deadline: Instant) -> ChildWrite {
        let Some(stdin) = self.stdin.lock().unwrap().take() else {
            return ChildWrite::Failed;
        };
        let result =
            write_once_before_deadline(stdin, frame.to_vec(), deadline, &self.write_workers);
        if let Some(stdin) = result.writer {
            self.write_workers.restore_if_open(|| {
                *self.stdin.lock().unwrap() = Some(stdin);
            });
        }
        result.outcome
    }

    fn read_stdout(&self, deadline: Instant) -> ChildRead {
        self.observations
            .recv_until(deadline)
            .map(|event| self.map_stdout_event(event))
            .unwrap_or(ChildRead::TimedOut)
    }

    fn poll_stdout(&self) -> ChildPoll {
        self.observations.poll_idle()
    }

    fn poll_health(&self, deadline: Instant) -> ChildPoll {
        self.observations.poll_health(deadline)
    }

    fn poll_after_response(&self, deadline: Instant) -> ChildPoll {
        self.observations.poll_protocol_after_response(deadline)
    }
}

impl Drop for ProductionProcess {
    fn drop(&mut self) {
        self.authority.kill_if_live();
        self.authority.wait_and_reap();
        self.finish_io();
    }
}

struct ProductionFactory {
    node: PathBuf,
    selection: ManagementChildSelection,
}

impl ChildFactory for ProductionFactory {
    fn spawn(&self, artifact: &BundledManagementArtifact) -> SpawnAttempt {
        let child = match production_command(&self.node, artifact, &self.selection)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(child) => child,
            Err(_) => return SpawnAttempt::FailedBeforeChild,
        };
        let authority = Arc::new(ExactChildAuthority::new(child));
        let (stdin, stdout) = authority.take_stdio();
        let (Some(stdin), Some(stdout)) = (stdin, stdout) else {
            return SpawnAttempt::FailedAfterChild(authority);
        };
        match ProductionProcess::new(authority.clone(), stdin, stdout) {
            Ok(process) => SpawnAttempt::Ready(Arc::new(process)),
            Err(authority) => SpawnAttempt::FailedAfterChild(authority),
        }
    }
}

fn production_command(
    node: &Path,
    artifact: &BundledManagementArtifact,
    selection: &ManagementChildSelection,
) -> Command {
    production_command_with_environment(node, artifact, selection, std::env::vars_os())
}

fn production_command_with_environment(
    node: &Path,
    artifact: &BundledManagementArtifact,
    selection: &ManagementChildSelection,
    inherited_environment: impl IntoIterator<Item = (OsString, OsString)>,
) -> Command {
    let mut command = Command::new(node);
    configure_management_child_environment(&mut command, inherited_environment);
    command.arg(artifact.path()).arg(HIDDEN_MANAGEMENT_ENTRY);
    selection.append_fixed_arguments(&mut command);
    if let Some(account_home) = selection.account_home_override() {
        command.env("HOME", account_home);
    }
    command
}

fn configure_management_child_environment(
    command: &mut Command,
    inherited_environment: impl IntoIterator<Item = (OsString, OsString)>,
) {
    command.env_clear();
    for (key, value) in inherited_environment {
        if MANAGEMENT_CHILD_ENVIRONMENT_ALLOWLIST
            .iter()
            .any(|allowed| key == OsStr::new(allowed))
            && !value.as_os_str().is_empty()
        {
            command.env(key, value);
        }
    }
}

fn cleanup_spawn_attempt(attempt: SpawnAttempt) {
    match attempt {
        SpawnAttempt::Ready(child) => {
            child.kill_if_live();
            child.wait_and_reap();
        }
        SpawnAttempt::FailedAfterChild(child) => {
            child.kill_if_live();
            child.wait_and_reap();
        }
        SpawnAttempt::FailedBeforeChild => {}
    }
}

fn cleanup_timed_out_start(child: &dyn ManagementChildProcess) -> ManagementStartError {
    // The self-hosted child may already own its crash-intolerant native
    // credential claim before it can publish the ready frame. Closing stdin
    // lets that exact child finish startup, observe EOF, and drain the claim;
    // only a child that cannot settle within the independent close budget is
    // killed and classified as requiring operator recovery.
    child.close_stdin();
    let deadline = Instant::now() + CLEAN_CLOSE_TIMEOUT;
    match child.wait_until(deadline) {
        Some(_) => {
            let exit = child.wait_and_reap();
            if exit.code == Some(0) {
                ManagementStartError::ChannelClosed
            } else {
                ManagementStartError::RecoveryRequired
            }
        }
        None => {
            child.kill_if_live();
            child.wait_and_reap();
            ManagementStartError::RecoveryRequired
        }
    }
}

fn spawn_before_deadline(
    factory: Arc<dyn ChildFactory>,
    artifact: BundledManagementArtifact,
    deadline: Instant,
) -> Result<Arc<dyn ManagementChildProcess>, ManagementStartError> {
    let attempt = factory.spawn(&artifact);
    if Instant::now() >= deadline {
        return Err(match attempt {
            SpawnAttempt::Ready(child) => cleanup_timed_out_start(child.as_ref()),
            failed => {
                cleanup_spawn_attempt(failed);
                ManagementStartError::ChannelClosed
            }
        });
    }
    match attempt {
        SpawnAttempt::Ready(child) => Ok(child),
        failed => {
            cleanup_spawn_attempt(failed);
            Err(ManagementStartError::ChannelClosed)
        }
    }
}

trait RequestIdGenerator: Send + Sync {
    fn fill(&self, bytes: &mut [u8; 16]) -> Result<(), ()>;
}

struct OsRequestIdGenerator;

impl RequestIdGenerator for OsRequestIdGenerator {
    fn fill(&self, bytes: &mut [u8; 16]) -> Result<(), ()> {
        getrandom::fill(bytes).map_err(|_| ())
    }
}

#[cfg(all(test, unix))]
struct CommandRegressionScriptFactory {
    script: String,
}

#[cfg(all(test, unix))]
impl ChildFactory for CommandRegressionScriptFactory {
    fn spawn(&self, _artifact: &BundledManagementArtifact) -> SpawnAttempt {
        let child = match Command::new("/bin/sh")
            .arg("-c")
            .arg(&self.script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(child) => child,
            Err(_) => return SpawnAttempt::FailedBeforeChild,
        };
        let authority = Arc::new(ExactChildAuthority::new(child));
        let (stdin, stdout) = authority.take_stdio();
        let (Some(stdin), Some(stdout)) = (stdin, stdout) else {
            return SpawnAttempt::FailedAfterChild(authority);
        };
        match ProductionProcess::new(authority.clone(), stdin, stdout) {
            Ok(process) => SpawnAttempt::Ready(Arc::new(process)),
            Err(authority) => SpawnAttempt::FailedAfterChild(authority),
        }
    }
}

#[cfg(all(test, unix))]
struct CommandRegressionRequestId(Mutex<VecDeque<[u8; 16]>>);

#[cfg(all(test, unix))]
impl RequestIdGenerator for CommandRegressionRequestId {
    fn fill(&self, bytes: &mut [u8; 16]) -> Result<(), ()> {
        *bytes = self.0.lock().unwrap().pop_front().ok_or(())?;
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ManagementOperation {
    Status,
    BootstrapHost,
    RefreshHost,
    StartConnector,
    StopConnector,
    CreateEnrollment,
    RevokeClientGrant,
}

impl ManagementOperation {
    fn is_status(self) -> bool {
        self == Self::Status
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ManagementProtocol {
    #[cfg_attr(not(test), allow(dead_code))]
    V1,
    V2,
}

impl ManagementProtocol {
    fn version(self) -> u32 {
        match self {
            Self::V1 => PROTOCOL_VERSION_V1,
            Self::V2 => management_protocol_v2::PROTOCOL_VERSION,
        }
    }

    fn request_id_prefix(self) -> &'static str {
        match self {
            Self::V1 => REQUEST_ID_PREFIX_V1,
            Self::V2 => management_protocol_v2::REQUEST_ID_PREFIX,
        }
    }
}

const PRODUCTION_EXPECTED_PROTOCOL: ManagementProtocol = ManagementProtocol::V2;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ManagementInput {
    None,
    CreateEnrollment { device_label: Option<String> },
    RevokeClientGrant { grant_id: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct RequestFrameV1<'a> {
    protocol_version: u32,
    request_id: &'a str,
    operation: ManagementOperation,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StartupReady {
    contract: String,
    protocol_version: u32,
    runtime_version: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DefaultOffStatus {
    pub(crate) availability: String,
    pub(crate) capabilities: Vec<String>,
    pub(crate) reason: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ManagementError {
    pub(crate) code: String,
    pub(crate) message: String,
    pub(crate) retryable: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ManagementOutcome {
    pub(crate) protocol_version: u32,
    pub(crate) request_id: String,
    pub(crate) ok: bool,
    pub(crate) result: Option<serde_json::Value>,
    pub(crate) error: Option<ManagementError>,
}

struct ManagementOutcomeWire {
    protocol_version: u32,
    request_id: String,
    ok: bool,
    result: Option<DefaultOffStatus>,
    error: Option<ManagementError>,
}

impl<'de> Deserialize<'de> for ManagementOutcomeWire {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct OutcomeVisitor;

        impl<'de> serde::de::Visitor<'de> for OutcomeVisitor {
            type Value = ManagementOutcomeWire;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("the exact closed management outcome object")
            }

            fn visit_map<M>(self, mut map: M) -> Result<Self::Value, M::Error>
            where
                M: serde::de::MapAccess<'de>,
            {
                let mut protocol_version = None;
                let mut request_id = None;
                let mut ok = None;
                let mut result: Option<Option<DefaultOffStatus>> = None;
                let mut error: Option<Option<ManagementError>> = None;
                while let Some(key) = map.next_key::<String>()? {
                    match key.as_str() {
                        "protocolVersion" => {
                            if protocol_version.is_some() {
                                return Err(serde::de::Error::duplicate_field("protocolVersion"));
                            }
                            protocol_version = Some(map.next_value()?);
                        }
                        "requestId" => {
                            if request_id.is_some() {
                                return Err(serde::de::Error::duplicate_field("requestId"));
                            }
                            request_id = Some(map.next_value()?);
                        }
                        "ok" => {
                            if ok.is_some() {
                                return Err(serde::de::Error::duplicate_field("ok"));
                            }
                            ok = Some(map.next_value()?);
                        }
                        "result" => {
                            if result.is_some() {
                                return Err(serde::de::Error::duplicate_field("result"));
                            }
                            result = Some(map.next_value::<Option<DefaultOffStatus>>()?);
                        }
                        "error" => {
                            if error.is_some() {
                                return Err(serde::de::Error::duplicate_field("error"));
                            }
                            error = Some(map.next_value::<Option<ManagementError>>()?);
                        }
                        _ => {
                            return Err(serde::de::Error::unknown_field(
                                &key,
                                &["protocolVersion", "requestId", "ok", "result", "error"],
                            ));
                        }
                    }
                }
                Ok(ManagementOutcomeWire {
                    protocol_version: protocol_version
                        .ok_or_else(|| serde::de::Error::missing_field("protocolVersion"))?,
                    request_id: request_id
                        .ok_or_else(|| serde::de::Error::missing_field("requestId"))?,
                    ok: ok.ok_or_else(|| serde::de::Error::missing_field("ok"))?,
                    result: result.ok_or_else(|| serde::de::Error::missing_field("result"))?,
                    error: error.ok_or_else(|| serde::de::Error::missing_field("error"))?,
                })
            }
        }

        deserializer.deserialize_map(OutcomeVisitor)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ManagementStartError {
    Unavailable,
    ChannelClosed,
    RecoveryRequired,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ManagementCallError {
    ChannelClosed,
    Superseded,
    RequestIdUnavailable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LifecycleKind {
    Ready,
    Poisoned,
    Superseded,
    Closed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ManagementCleanupOutcome {
    Clean,
    RecoveryRequired,
}

struct LifecycleState {
    kind: LifecycleKind,
    reaping: bool,
    reaped: bool,
    cleanup: Option<ManagementCleanupOutcome>,
}

struct LifecycleBarrier {
    state: Mutex<LifecycleState>,
    changed: Condvar,
}

impl LifecycleBarrier {
    fn ready() -> Self {
        Self {
            state: Mutex::new(LifecycleState {
                kind: LifecycleKind::Ready,
                reaping: false,
                reaped: false,
                cleanup: None,
            }),
            changed: Condvar::new(),
        }
    }
}

pub(crate) struct ManagementChildManager {
    inner: Arc<ManagerInner>,
    supervisor: Mutex<Option<JoinHandle<()>>>,
}

struct ManagerInner {
    artifact: BundledManagementArtifact,
    child: Arc<dyn ManagementChildProcess>,
    protocol: ManagementProtocol,
    request_ids: Arc<dyn RequestIdGenerator>,
    in_flight: AtomicBool,
    observation: Mutex<()>,
    lifecycle: LifecycleBarrier,
    supervisor_stop: AtomicBool,
    operation_timeout: Duration,
}

struct InFlightGuard<'a>(&'a AtomicBool);

impl Drop for InFlightGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

impl ManagementChildManager {
    pub(crate) fn start(app: &tauri::AppHandle) -> Result<Self, ManagementStartError> {
        Self::start_selected(app, ManagementChildSelection::DefaultProduction)
    }

    pub(crate) fn start_selected(
        app: &tauri::AppHandle,
        selection: ManagementChildSelection,
    ) -> Result<Self, ManagementStartError> {
        let artifact = resolve_bundled_management_artifact(app)?;
        let node = node_bin()
            .map(PathBuf::from)
            .ok_or(ManagementStartError::Unavailable)?;
        Self::start_with_factory(
            artifact,
            Arc::new(ProductionFactory { node, selection }),
            Arc::new(OsRequestIdGenerator),
            PRODUCTION_EXPECTED_PROTOCOL,
            env!("CARGO_PKG_VERSION"),
            STARTUP_TIMEOUT,
            OPERATION_TIMEOUT,
        )
    }

    #[cfg(all(test, unix))]
    pub(crate) fn start_v2_command_regression_script(
        script: String,
        request_id: [u8; 16],
    ) -> Result<Self, ManagementStartError> {
        Self::start_v2_command_regression_script_with_request_ids(script, vec![request_id])
    }

    #[cfg(all(test, unix))]
    pub(crate) fn start_v2_command_regression_script_with_request_ids(
        script: String,
        request_ids: Vec<[u8; 16]>,
    ) -> Result<Self, ManagementStartError> {
        Self::start_with_factory(
            BundledManagementArtifact {
                path: PathBuf::from("/test/tw-cli/cli.cjs"),
            },
            Arc::new(CommandRegressionScriptFactory { script }),
            Arc::new(CommandRegressionRequestId(Mutex::new(request_ids.into()))),
            ManagementProtocol::V2,
            "1.2.3",
            Duration::from_secs(2),
            Duration::from_secs(2),
        )
    }

    fn start_with_factory(
        artifact: BundledManagementArtifact,
        factory: Arc<dyn ChildFactory>,
        request_ids: Arc<dyn RequestIdGenerator>,
        expected_protocol: ManagementProtocol,
        expected_version: &str,
        startup_timeout: Duration,
        operation_timeout: Duration,
    ) -> Result<Self, ManagementStartError> {
        let deadline = Instant::now() + startup_timeout;
        let child = spawn_before_deadline(factory, artifact.clone(), deadline)?;
        let ready = if Instant::now() < deadline {
            read_frame(child.as_ref(), deadline)
        } else {
            Err(FrameFailure::TimedOut)
        };
        match ready {
            Ok(payload)
                if decode_startup_ready(&payload, expected_version, expected_protocol).is_ok() =>
            {
                if Instant::now() >= deadline {
                    return Err(cleanup_timed_out_start(child.as_ref()));
                }
            }
            Err(FrameFailure::TimedOut) => {
                return Err(cleanup_timed_out_start(child.as_ref()));
            }
            Ok(_) | Err(FrameFailure::Invalid | FrameFailure::Exited(_)) => {
                child.kill_if_live();
                child.wait_and_reap();
                return Err(ManagementStartError::ChannelClosed);
            }
        }
        let inner = Arc::new(ManagerInner {
            artifact,
            child,
            protocol: expected_protocol,
            request_ids,
            in_flight: AtomicBool::new(false),
            observation: Mutex::new(()),
            lifecycle: LifecycleBarrier::ready(),
            supervisor_stop: AtomicBool::new(false),
            operation_timeout,
        });
        let weak = Arc::downgrade(&inner);
        let supervisor = match thread::Builder::new()
            .name("relay-v2-management-supervisor".to_string())
            .spawn(move || supervise_child(weak))
        {
            Ok(supervisor) => supervisor,
            Err(_) => {
                inner.terminalize(LifecycleKind::Poisoned, true);
                return Err(ManagementStartError::ChannelClosed);
            }
        };
        Ok(Self {
            inner,
            supervisor: Mutex::new(Some(supervisor)),
        })
    }

    pub(crate) fn artifact_path(&self) -> &Path {
        self.inner.artifact.path()
    }

    pub(crate) fn is_reusable_after_observation(&self) -> bool {
        if self.inner.supervisor_stop.load(Ordering::Acquire) {
            return false;
        }
        // The same observation barrier serializes every request, the
        // supervisor, and this same-key reuse decision. Poll the exact child
        // here instead of trusting the supervisor's next 2 ms pass.
        let _observation = self.inner.observation.lock().unwrap();
        if self.inner.lifecycle_kind_after_barrier() != LifecycleKind::Ready {
            return false;
        }
        if self.inner.observe_idle_child().is_some() {
            return false;
        }
        let deadline = Instant::now() + self.inner.operation_timeout;
        self.inner
            .observe_child_poll(self.inner.child.poll_health(deadline))
            .is_none()
            && self.inner.lifecycle_kind_now() == LifecycleKind::Ready
    }

    pub(crate) fn request(
        &self,
        operation: ManagementOperation,
    ) -> Result<ManagementOutcome, ManagementCallError> {
        self.request_with_input(operation, ManagementInput::None)
    }

    pub(crate) fn request_with_input(
        &self,
        operation: ManagementOperation,
        input: ManagementInput,
    ) -> Result<ManagementOutcome, ManagementCallError> {
        if self
            .inner
            .in_flight
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            self.inner.terminalize(LifecycleKind::Poisoned, true);
            return Err(ManagementCallError::ChannelClosed);
        }
        let _in_flight = InFlightGuard(&self.inner.in_flight);
        let _observation = self.inner.observation.lock().unwrap();

        match self.inner.lifecycle_kind_after_barrier() {
            LifecycleKind::Ready => {}
            LifecycleKind::Superseded => return Err(ManagementCallError::Superseded),
            LifecycleKind::Poisoned | LifecycleKind::Closed => {
                return Err(ManagementCallError::ChannelClosed)
            }
        }

        if let Some(kind) = self.inner.observe_idle_child() {
            return Err(call_error_for(kind));
        }

        let request_id = match self.inner.generate_request_id() {
            Ok(request_id) => request_id,
            Err(()) => {
                self.inner.terminalize(LifecycleKind::Poisoned, true);
                return Err(ManagementCallError::RequestIdUnavailable);
            }
        };
        let frame =
            encode_request(self.inner.protocol, &request_id, operation, &input).map_err(|_| {
                self.inner.terminalize(LifecycleKind::Poisoned, true);
                ManagementCallError::ChannelClosed
            })?;

        // This is the only operation deadline. It begins immediately before
        // the sole stdin write attempt and is never reset.
        let deadline = Instant::now() + self.inner.operation_timeout;
        match self.inner.child.write_stdin_once(&frame, deadline) {
            ChildWrite::Written(written) if written == frame.len() => {}
            ChildWrite::Exited(exit) => {
                let kind = self.inner.classify_post_handshake_exit(exit);
                return Ok(local_terminal_outcome(
                    self.inner.protocol,
                    request_id,
                    kind,
                ));
            }
            ChildWrite::Written(_) | ChildWrite::TimedOut | ChildWrite::Failed => {
                self.inner.terminalize(LifecycleKind::Poisoned, true);
                return Ok(channel_closed_outcome(self.inner.protocol, request_id));
            }
        }
        if Instant::now() >= deadline {
            self.inner.terminalize(LifecycleKind::Poisoned, true);
            return Ok(channel_closed_outcome(self.inner.protocol, request_id));
        }

        let payload = match read_frame(self.inner.child.as_ref(), deadline) {
            Ok(payload) => payload,
            Err(FrameFailure::Exited(exit)) => {
                let kind = self.inner.classify_post_handshake_exit(exit);
                return Ok(local_terminal_outcome(
                    self.inner.protocol,
                    request_id,
                    kind,
                ));
            }
            Err(_) => {
                self.inner.terminalize(LifecycleKind::Poisoned, true);
                return Ok(channel_closed_outcome(self.inner.protocol, request_id));
            }
        };
        let response = match decode_response(self.inner.protocol, &payload, &request_id, operation)
        {
            Ok(response) if Instant::now() < deadline => response,
            _ => {
                self.inner.terminalize(LifecycleKind::Poisoned, true);
                return Ok(channel_closed_outcome(self.inner.protocol, request_id));
            }
        };
        match self.inner.child.poll_after_response(deadline) {
            ChildPoll::Output | ChildPoll::Failed => {
                self.inner.terminalize(LifecycleKind::Poisoned, true);
                return Ok(channel_closed_outcome(self.inner.protocol, request_id));
            }
            ChildPoll::Pending | ChildPoll::Eof | ChildPoll::Exited(_) => {}
        }
        match self.inner.lifecycle_kind_after_barrier() {
            LifecycleKind::Ready => Ok(response),
            kind => Ok(local_terminal_outcome(
                self.inner.protocol,
                request_id,
                kind,
            )),
        }
    }

    pub(crate) fn dispose(&self) -> ManagementCleanupOutcome {
        self.inner.supervisor_stop.store(true, Ordering::Release);
        let cleanup = self.inner.close_and_drain(CLEAN_CLOSE_TIMEOUT);
        if let Some(supervisor) = self.supervisor.lock().unwrap().take() {
            let _ = supervisor.join();
        }
        cleanup
    }
}

impl ManagerInner {
    fn generate_request_id(&self) -> Result<String, ()> {
        let mut bytes = [0u8; 16];
        self.request_ids.fill(&mut bytes)?;
        Ok(format!(
            "{}{}",
            self.protocol.request_id_prefix(),
            URL_SAFE_NO_PAD.encode(bytes)
        ))
    }

    fn classify_post_handshake_exit(&self, exit: ChildExit) -> LifecycleKind {
        let kind = if exit.code == Some(SUPERSEDED_EXIT_CODE) {
            LifecycleKind::Superseded
        } else {
            LifecycleKind::Poisoned
        };
        let cleanup = if matches!(exit.code, Some(0) | Some(SUPERSEDED_EXIT_CODE)) {
            ManagementCleanupOutcome::Clean
        } else {
            ManagementCleanupOutcome::RecoveryRequired
        };
        self.terminalize_with_cleanup(kind, false, cleanup)
    }

    fn observe_idle_child(&self) -> Option<LifecycleKind> {
        self.observe_child_poll(self.child.poll_stdout())
    }

    fn observe_child_poll(&self, poll: ChildPoll) -> Option<LifecycleKind> {
        match poll {
            ChildPoll::Pending => None,
            ChildPoll::Exited(exit) => Some(self.classify_post_handshake_exit(exit)),
            ChildPoll::Output | ChildPoll::Eof | ChildPoll::Failed => {
                Some(self.terminalize(LifecycleKind::Poisoned, true))
            }
        }
    }

    fn terminalize(&self, requested: LifecycleKind, kill: bool) -> LifecycleKind {
        self.terminalize_with_cleanup(
            requested,
            kill,
            if kill {
                ManagementCleanupOutcome::RecoveryRequired
            } else {
                ManagementCleanupOutcome::Clean
            },
        )
    }

    fn terminalize_with_cleanup(
        &self,
        requested: LifecycleKind,
        kill: bool,
        cleanup: ManagementCleanupOutcome,
    ) -> LifecycleKind {
        let leader;
        {
            let mut state = self.lifecycle.state.lock().unwrap();
            if requested == LifecycleKind::Closed || state.kind == LifecycleKind::Ready {
                state.kind = requested;
            }
            if state.reaped {
                return state.kind;
            }
            if state.reaping {
                while !state.reaped {
                    state = self.lifecycle.changed.wait(state).unwrap();
                }
                return state.kind;
            }
            state.reaping = true;
            leader = true;
        }
        if leader {
            if kill {
                self.child.kill_if_live();
            }
            self.child.wait_and_reap();
            let mut state = self.lifecycle.state.lock().unwrap();
            state.reaping = false;
            state.reaped = true;
            state.cleanup = Some(cleanup);
            let kind = state.kind;
            self.lifecycle.changed.notify_all();
            kind
        } else {
            unreachable!()
        }
    }

    fn close_and_drain(&self, timeout: Duration) -> ManagementCleanupOutcome {
        {
            let mut state = self.lifecycle.state.lock().unwrap();
            state.kind = LifecycleKind::Closed;
            if state.reaped {
                return state
                    .cleanup
                    .unwrap_or(ManagementCleanupOutcome::RecoveryRequired);
            }
            self.lifecycle.changed.notify_all();
        }

        // Every request and the supervisor observe stdout only while holding
        // this same barrier. Once acquired, no admitted request can still own
        // child stdin and every later request sees the Closed fence.
        let _request_barrier = self.observation.lock().unwrap();
        {
            let mut state = self.lifecycle.state.lock().unwrap();
            while state.reaping && !state.reaped {
                state = self.lifecycle.changed.wait(state).unwrap();
            }
            if state.reaped {
                return state
                    .cleanup
                    .unwrap_or(ManagementCleanupOutcome::RecoveryRequired);
            }
            state.reaping = true;
        }

        self.child.close_stdin();
        let deadline = Instant::now() + timeout;
        let (exit, cleanup) = match self.child.wait_until(deadline) {
            Some(exit) => {
                let cleanup = if matches!(exit.code, Some(0) | Some(SUPERSEDED_EXIT_CODE)) {
                    ManagementCleanupOutcome::Clean
                } else {
                    ManagementCleanupOutcome::RecoveryRequired
                };
                (self.child.wait_and_reap(), cleanup)
            }
            None => {
                self.child.kill_if_live();
                (
                    self.child.wait_and_reap(),
                    ManagementCleanupOutcome::RecoveryRequired,
                )
            }
        };
        let _ = exit;
        let mut state = self.lifecycle.state.lock().unwrap();
        state.reaping = false;
        state.reaped = true;
        state.cleanup = Some(cleanup);
        self.lifecycle.changed.notify_all();
        cleanup
    }

    fn lifecycle_kind_after_barrier(&self) -> LifecycleKind {
        let mut state = self.lifecycle.state.lock().unwrap();
        while state.reaping {
            state = self.lifecycle.changed.wait(state).unwrap();
        }
        state.kind
    }

    fn lifecycle_kind_now(&self) -> LifecycleKind {
        self.lifecycle.state.lock().unwrap().kind
    }
}

fn supervise_child(manager: std::sync::Weak<ManagerInner>) {
    loop {
        let Some(manager) = manager.upgrade() else {
            return;
        };
        if manager.supervisor_stop.load(Ordering::Acquire)
            || manager.lifecycle_kind_now() != LifecycleKind::Ready
        {
            return;
        }
        if !manager.in_flight.load(Ordering::Acquire) {
            if let Ok(_observation) = manager.observation.try_lock() {
                if !manager.in_flight.load(Ordering::Acquire) {
                    if manager.observe_idle_child().is_some() {
                        return;
                    }
                }
            }
        }
        drop(manager);
        thread::sleep(SUPERVISOR_POLL_INTERVAL);
    }
}

impl Drop for ManagementChildManager {
    fn drop(&mut self) {
        self.dispose();
    }
}

#[derive(Debug)]
enum FrameFailure {
    Invalid,
    Exited(ChildExit),
    TimedOut,
}

fn read_frame(
    child: &dyn ManagementChildProcess,
    deadline: Instant,
) -> Result<Vec<u8>, FrameFailure> {
    let mut payload = Vec::new();
    loop {
        if Instant::now() >= deadline {
            return Err(FrameFailure::TimedOut);
        }
        match child.read_stdout(deadline) {
            ChildRead::Bytes(bytes) if !bytes.is_empty() => {
                if let Some(lf) = bytes.iter().position(|byte| *byte == b'\n') {
                    if lf + 1 != bytes.len() {
                        return Err(FrameFailure::Invalid);
                    }
                    if payload.len().saturating_add(lf) > MAX_FRAME_PAYLOAD_BYTES {
                        return Err(FrameFailure::Invalid);
                    }
                    payload.extend_from_slice(&bytes[..lf]);
                    if payload.is_empty() || payload.last() == Some(&b'\r') {
                        return Err(FrameFailure::Invalid);
                    }
                    return Ok(payload);
                }
                if payload.len().saturating_add(bytes.len()) > MAX_FRAME_PAYLOAD_BYTES {
                    return Err(FrameFailure::Invalid);
                }
                payload.extend_from_slice(&bytes);
            }
            ChildRead::Exited(exit) if payload.is_empty() => {
                return Err(FrameFailure::Exited(exit));
            }
            ChildRead::Exited(_) => return Err(FrameFailure::Invalid),
            ChildRead::TimedOut => return Err(FrameFailure::TimedOut),
            ChildRead::Bytes(_) | ChildRead::Eof | ChildRead::Failed => {
                return Err(FrameFailure::Invalid)
            }
        }
    }
}

fn closed_object_payload(payload: &[u8]) -> Result<(), ()> {
    let text = std::str::from_utf8(payload).map_err(|_| ())?;
    if !text.starts_with('{') || !text.ends_with('}') || text.starts_with('\u{feff}') {
        return Err(());
    }
    Ok(())
}

fn decode_startup_ready(
    payload: &[u8],
    expected_version: &str,
    expected_protocol: ManagementProtocol,
) -> Result<(), ()> {
    closed_object_payload(payload)?;
    let ready: StartupReady = serde_json::from_slice(payload).map_err(|_| ())?;
    if ready.contract != CONTRACT
        || !valid_ascii_semver(&ready.runtime_version)
        || ready.runtime_version.as_bytes() != expected_version.as_bytes()
        || ready.protocol_version != expected_protocol.version()
    {
        return Err(());
    }
    Ok(())
}

fn encode_request(
    protocol: ManagementProtocol,
    request_id: &str,
    operation: ManagementOperation,
    input: &ManagementInput,
) -> Result<Vec<u8>, ()> {
    if !valid_request_id(protocol, request_id) {
        return Err(());
    }
    let mut frame = match protocol {
        ManagementProtocol::V1 => serde_json::to_vec(&RequestFrameV1 {
            protocol_version: PROTOCOL_VERSION_V1,
            request_id,
            operation,
        })
        .map_err(|_| ())?,
        ManagementProtocol::V2 => {
            management_protocol_v2::encode_request(request_id, operation, input)?
        }
    };
    if frame.len() > MAX_FRAME_PAYLOAD_BYTES {
        return Err(());
    }
    frame.push(b'\n');
    Ok(frame)
}

fn decode_response(
    protocol: ManagementProtocol,
    payload: &[u8],
    expected_request_id: &str,
    operation: ManagementOperation,
) -> Result<ManagementOutcome, ()> {
    closed_object_payload(payload)?;
    match protocol {
        ManagementProtocol::V1 => decode_v1_response(payload, expected_request_id, operation),
        ManagementProtocol::V2 => decode_v2_response(payload, expected_request_id, operation),
    }
}

fn decode_v1_response(
    payload: &[u8],
    expected_request_id: &str,
    operation: ManagementOperation,
) -> Result<ManagementOutcome, ()> {
    let wire: ManagementOutcomeWire = serde_json::from_slice(payload).map_err(|_| ())?;
    if wire.protocol_version != PROTOCOL_VERSION_V1
        || !valid_request_id(ManagementProtocol::V1, &wire.request_id)
        || wire.request_id.as_bytes() != expected_request_id.as_bytes()
    {
        return Err(());
    }
    if operation.is_status() {
        let result = wire.result.as_ref().ok_or(())?;
        if !wire.ok
            || wire.error.is_some()
            || result.availability != "unavailable"
            || !result.capabilities.is_empty()
            || result.reason != "default_off"
        {
            return Err(());
        }
    } else {
        let error = wire.error.as_ref().ok_or(())?;
        if wire.ok
            || wire.result.is_some()
            || error.code != "UNAVAILABLE"
            || error.message != "Relay v2 management is unavailable"
            || error.retryable
        {
            return Err(());
        }
    }
    let response = ManagementOutcome {
        protocol_version: wire.protocol_version,
        request_id: wire.request_id,
        ok: wire.ok,
        result: wire
            .result
            .map(|result| serde_json::to_value(result).map_err(|_| ()))
            .transpose()?,
        error: wire.error,
    };
    Ok(response)
}

fn decode_v2_response(
    payload: &[u8],
    expected_request_id: &str,
    operation: ManagementOperation,
) -> Result<ManagementOutcome, ()> {
    let response =
        management_protocol_v2::decode_response(payload, expected_request_id, operation)?;
    Ok(ManagementOutcome {
        protocol_version: management_protocol_v2::PROTOCOL_VERSION,
        request_id: expected_request_id.to_string(),
        ok: response.result.is_some(),
        result: response
            .result
            .map(|result| serde_json::to_value(result).map_err(|_| ()))
            .transpose()?,
        error: response.error.map(|error| ManagementError {
            code: error.code,
            message: error.message,
            retryable: error.retryable,
        }),
    })
}

fn valid_request_id(protocol: ManagementProtocol, value: &str) -> bool {
    let Some(suffix) = value.strip_prefix(protocol.request_id_prefix()) else {
        return false;
    };
    if value.len() != 29
        || !suffix
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return false;
    }
    let Ok(decoded) = URL_SAFE_NO_PAD.decode(suffix) else {
        return false;
    };
    decoded.len() == 16 && URL_SAFE_NO_PAD.encode(decoded) == suffix
}

fn valid_ascii_semver(value: &str) -> bool {
    if value.len() < 5 || value.len() > 128 || !value.is_ascii() {
        return false;
    }
    let (core_and_pre, build) = match value.split_once('+') {
        Some((left, right)) if !right.is_empty() && !right.contains('+') => (left, Some(right)),
        Some(_) => return false,
        None => (value, None),
    };
    let (core, pre) = match core_and_pre.split_once('-') {
        Some((left, right)) if !right.is_empty() => (left, Some(right)),
        Some(_) => return false,
        None => (core_and_pre, None),
    };
    let mut core_parts = core.split('.');
    let valid_core = (0..3).all(|_| core_parts.next().is_some_and(valid_numeric_identifier))
        && core_parts.next().is_none();
    if !valid_core {
        return false;
    }
    if pre.is_some_and(|value| !valid_dot_identifiers(value, true)) {
        return false;
    }
    if build.is_some_and(|value| !valid_dot_identifiers(value, false)) {
        return false;
    }
    true
}

fn valid_numeric_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.bytes().all(|byte| byte.is_ascii_digit())
        && (value == "0" || !value.starts_with('0'))
}

fn valid_dot_identifiers(value: &str, reject_numeric_leading_zero: bool) -> bool {
    value.split('.').all(|part| {
        !part.is_empty()
            && part
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            && (!reject_numeric_leading_zero
                || !part.bytes().all(|byte| byte.is_ascii_digit())
                || valid_numeric_identifier(part))
    })
}

fn fixed_error(code: &str, message: &str) -> ManagementError {
    ManagementError {
        code: code.to_string(),
        message: message.to_string(),
        retryable: false,
    }
}

fn channel_closed_outcome(protocol: ManagementProtocol, request_id: String) -> ManagementOutcome {
    ManagementOutcome {
        protocol_version: protocol.version(),
        request_id,
        ok: false,
        result: None,
        error: Some(fixed_error(
            "CHANNEL_CLOSED",
            "Relay v2 management channel closed",
        )),
    }
}

fn superseded_outcome(protocol: ManagementProtocol, request_id: String) -> ManagementOutcome {
    ManagementOutcome {
        protocol_version: protocol.version(),
        request_id,
        ok: false,
        result: None,
        error: Some(fixed_error(
            "SUPERSEDED",
            "Relay v2 management owner was superseded",
        )),
    }
}

fn local_terminal_outcome(
    protocol: ManagementProtocol,
    request_id: String,
    kind: LifecycleKind,
) -> ManagementOutcome {
    if kind == LifecycleKind::Superseded {
        superseded_outcome(protocol, request_id)
    } else {
        channel_closed_outcome(protocol, request_id)
    }
}

fn call_error_for(kind: LifecycleKind) -> ManagementCallError {
    if kind == LifecycleKind::Superseded {
        ManagementCallError::Superseded
    } else {
        ManagementCallError::ChannelClosed
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD;
    use serde_json::Value;
    use std::collections::VecDeque;
    use std::fs;
    use std::sync::mpsc;
    use std::thread;

    const CASES: &str =
        include_str!("../../../../../contracts/dashboard-relay-v2-management/v1/cases.json");
    const CASES_V2: &str =
        include_str!("../../../../../contracts/dashboard-relay-v2-management/v2/cases.json");

    #[derive(Clone, Copy)]
    enum WriteAction {
        Full,
        Partial(usize),
        Block,
    }

    struct SequencedRead {
        after_writes: usize,
        read: ChildRead,
    }

    struct BlockingWriter {
        gate: Arc<(Mutex<bool>, Condvar)>,
    }

    impl Write for BlockingWriter {
        fn write(&mut self, _buffer: &[u8]) -> std::io::Result<usize> {
            let (killed, changed) = &*self.gate;
            let mut killed = killed.lock().unwrap();
            while !*killed {
                killed = changed.wait(killed).unwrap();
            }
            Err(std::io::Error::from(std::io::ErrorKind::BrokenPipe))
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    struct FakeState {
        reads: VecDeque<SequencedRead>,
        writes: Vec<Vec<u8>>,
        write_actions: VecDeque<WriteAction>,
        blocked: bool,
        killed: bool,
        stdin_closed: bool,
        exit_after_stdin_close: bool,
        reaped: bool,
        health_poll: ChildPoll,
        events: Vec<&'static str>,
    }

    struct FakeChild {
        state: Mutex<FakeState>,
        changed: Condvar,
        blocking_writer: Arc<(Mutex<bool>, Condvar)>,
        write_workers: WriteWorkerBarrier,
    }

    impl FakeChild {
        fn sequenced(reads: Vec<(usize, ChildRead)>) -> Arc<Self> {
            assert!(reads
                .iter()
                .all(|(_, read)| !matches!(read, ChildRead::Exited(_))));
            Arc::new(Self {
                state: Mutex::new(FakeState {
                    reads: reads
                        .into_iter()
                        .map(|(after_writes, read)| SequencedRead { after_writes, read })
                        .collect(),
                    writes: Vec::new(),
                    write_actions: VecDeque::from([WriteAction::Full]),
                    blocked: false,
                    killed: false,
                    stdin_closed: false,
                    exit_after_stdin_close: true,
                    reaped: false,
                    health_poll: ChildPoll::Pending,
                    events: Vec::new(),
                }),
                changed: Condvar::new(),
                blocking_writer: Arc::new((Mutex::new(false), Condvar::new())),
                write_workers: WriteWorkerBarrier::new(),
            })
        }

        fn ready_then(version: &str, reads: Vec<ChildRead>) -> Arc<Self> {
            let mut sequence = vec![(0, ChildRead::Bytes(ready_frame(version)))];
            sequence.extend(reads.into_iter().map(|read| (1, read)));
            Self::sequenced(sequence)
        }

        fn set_write_action(&self, action: WriteAction) {
            self.state.lock().unwrap().write_actions = VecDeque::from([action]);
        }

        fn set_health_poll(&self, poll: ChildPoll) {
            self.state.lock().unwrap().health_poll = poll;
        }

        fn set_exit_after_stdin_close(&self, exit_after_stdin_close: bool) {
            self.state.lock().unwrap().exit_after_stdin_close = exit_after_stdin_close;
        }

        fn push_read(&self, after_writes: usize, read: ChildRead) {
            assert!(!matches!(&read, ChildRead::Exited(_)));
            self.state
                .lock()
                .unwrap()
                .reads
                .push_back(SequencedRead { after_writes, read });
            self.changed.notify_all();
        }

        fn wait_until_blocked(&self) {
            let mut state = self.state.lock().unwrap();
            while !state.blocked {
                state = self.changed.wait(state).unwrap();
            }
        }

        fn wait_until_reaped(&self) {
            let mut state = self.state.lock().unwrap();
            while !state.reaped {
                state = self.changed.wait(state).unwrap();
            }
        }
    }

    impl ChildLifecycle for FakeChild {
        fn kill_if_live(&self) {
            let mut state = self.state.lock().unwrap();
            state.events.push("kill-if-live");
            state.killed = true;
            self.changed.notify_all();
            let (killed, changed) = &*self.blocking_writer;
            *killed.lock().unwrap() = true;
            changed.notify_all();
        }

        fn wait_and_reap(&self) -> ChildExit {
            let mut state = self.state.lock().unwrap();
            state.events.push("wait-and-reap");
            drop(state);
            self.write_workers.close_and_join();
            let mut state = self.state.lock().unwrap();
            state.reaped = true;
            self.changed.notify_all();
            ChildExit { code: Some(0) }
        }

        fn wait_until(&self, deadline: Instant) -> Option<ChildExit> {
            let mut state = self.state.lock().unwrap();
            loop {
                if state.killed || state.reaped {
                    return Some(ChildExit { code: Some(0) });
                }
                if state.stdin_closed {
                    return state
                        .exit_after_stdin_close
                        .then_some(ChildExit { code: Some(0) });
                }
                let remaining = deadline.checked_duration_since(Instant::now())?;
                let (next, timeout) = self.changed.wait_timeout(state, remaining).unwrap();
                state = next;
                if timeout.timed_out() {
                    return None;
                }
            }
        }
    }

    impl ManagementChildProcess for FakeChild {
        fn close_stdin(&self) {
            let mut state = self.state.lock().unwrap();
            state.events.push("close-stdin");
            state.stdin_closed = true;
            self.changed.notify_all();
        }

        fn write_stdin_once(&self, frame: &[u8], deadline: Instant) -> ChildWrite {
            let mut state = self.state.lock().unwrap();
            state.events.push("write");
            state.writes.push(frame.to_vec());
            match state.write_actions.pop_front().unwrap_or(WriteAction::Full) {
                WriteAction::Full => ChildWrite::Written(frame.len()),
                WriteAction::Partial(bytes) => ChildWrite::Written(bytes),
                WriteAction::Block => {
                    state.blocked = true;
                    self.changed.notify_all();
                    drop(state);
                    write_once_before_deadline(
                        BlockingWriter {
                            gate: self.blocking_writer.clone(),
                        },
                        frame.to_vec(),
                        deadline,
                        &self.write_workers,
                    )
                    .outcome
                }
            }
        }

        fn read_stdout(&self, deadline: Instant) -> ChildRead {
            let mut state = self.state.lock().unwrap();
            let read = loop {
                let writes = state.writes.len();
                if state
                    .reads
                    .front()
                    .is_some_and(|read| read.after_writes <= writes)
                {
                    break state.reads.pop_front().unwrap().read;
                }
                if state.killed {
                    break ChildRead::Failed;
                }
                let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                    break ChildRead::TimedOut;
                };
                let (next, timeout) = self.changed.wait_timeout(state, remaining).unwrap();
                state = next;
                if timeout.timed_out() {
                    break ChildRead::TimedOut;
                }
            };
            read
        }

        fn poll_stdout(&self) -> ChildPoll {
            let mut state = self.state.lock().unwrap();
            let writes = state.writes.len();
            let Some(read) = state
                .reads
                .front()
                .filter(|read| read.after_writes <= writes)
            else {
                return ChildPoll::Pending;
            };
            let poll = match &read.read {
                ChildRead::Bytes(_) => ChildPoll::Output,
                ChildRead::Eof => ChildPoll::Eof,
                ChildRead::Exited(_) => panic!("fake exit injection is forbidden"),
                ChildRead::Failed => ChildPoll::Failed,
                ChildRead::TimedOut => return ChildPoll::Pending,
            };
            state.reads.pop_front();
            poll
        }

        fn poll_health(&self, _deadline: Instant) -> ChildPoll {
            match self.poll_stdout() {
                ChildPoll::Pending => self.state.lock().unwrap().health_poll,
                observed => observed,
            }
        }

        fn poll_after_response(&self, _deadline: Instant) -> ChildPoll {
            let state = self.state.lock().unwrap();
            let writes = state.writes.len();
            let Some(read) = state
                .reads
                .front()
                .filter(|read| read.after_writes <= writes)
            else {
                return ChildPoll::Pending;
            };
            match &read.read {
                ChildRead::Bytes(_) | ChildRead::Failed => ChildPoll::Output,
                ChildRead::Eof | ChildRead::TimedOut => ChildPoll::Pending,
                ChildRead::Exited(_) => panic!("fake exit injection is forbidden"),
            }
        }
    }

    #[derive(Clone, Copy)]
    enum FakeSpawnAction {
        Ready,
        FailedAfterChild,
        BlockUntilReleased,
    }

    struct FakeFactoryState {
        entered: bool,
        released: bool,
    }

    struct FakeFactory {
        child: Arc<FakeChild>,
        paths: Mutex<Vec<PathBuf>>,
        action: FakeSpawnAction,
        state: Mutex<FakeFactoryState>,
        changed: Condvar,
    }

    impl FakeFactory {
        fn new(child: Arc<FakeChild>, action: FakeSpawnAction) -> Arc<Self> {
            Arc::new(Self {
                child,
                paths: Mutex::new(Vec::new()),
                action,
                state: Mutex::new(FakeFactoryState {
                    entered: false,
                    released: false,
                }),
                changed: Condvar::new(),
            })
        }

        fn wait_until_entered(&self) {
            let mut state = self.state.lock().unwrap();
            while !state.entered {
                state = self.changed.wait(state).unwrap();
            }
        }

        fn release(&self) {
            let mut state = self.state.lock().unwrap();
            state.released = true;
            self.changed.notify_all();
        }
    }

    impl ChildFactory for FakeFactory {
        fn spawn(&self, artifact: &BundledManagementArtifact) -> SpawnAttempt {
            self.paths.lock().unwrap().push(artifact.path.clone());
            match self.action {
                FakeSpawnAction::Ready => SpawnAttempt::Ready(self.child.clone()),
                FakeSpawnAction::FailedAfterChild => {
                    SpawnAttempt::FailedAfterChild(self.child.clone())
                }
                FakeSpawnAction::BlockUntilReleased => {
                    let mut state = self.state.lock().unwrap();
                    state.entered = true;
                    self.changed.notify_all();
                    while !state.released {
                        state = self.changed.wait(state).unwrap();
                    }
                    SpawnAttempt::Ready(self.child.clone())
                }
            }
        }
    }

    #[cfg(unix)]
    struct ScriptFactory {
        script: String,
    }

    #[cfg(unix)]
    impl ChildFactory for ScriptFactory {
        fn spawn(&self, _artifact: &BundledManagementArtifact) -> SpawnAttempt {
            spawn_script_attempt(&self.script)
        }
    }

    #[cfg(unix)]
    fn spawn_script_attempt(script: &str) -> SpawnAttempt {
        let child = match Command::new("/bin/sh")
            .arg("-c")
            .arg(script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(child) => child,
            Err(_) => return SpawnAttempt::FailedBeforeChild,
        };
        let authority = Arc::new(ExactChildAuthority::new(child));
        let (stdin, stdout) = authority.take_stdio();
        let (Some(stdin), Some(stdout)) = (stdin, stdout) else {
            return SpawnAttempt::FailedAfterChild(authority);
        };
        match ProductionProcess::new(authority.clone(), stdin, stdout) {
            Ok(process) => SpawnAttempt::Ready(Arc::new(process)),
            Err(authority) => SpawnAttempt::FailedAfterChild(authority),
        }
    }

    #[cfg(unix)]
    fn script_process(script: &str) -> Arc<dyn ManagementChildProcess> {
        match spawn_script_attempt(script) {
            SpawnAttempt::Ready(process) => process,
            SpawnAttempt::FailedAfterChild(child) => {
                child.kill_if_live();
                child.wait_and_reap();
                panic!("script child setup failed")
            }
            SpawnAttempt::FailedBeforeChild => panic!("script child spawn failed"),
        }
    }

    #[cfg(unix)]
    fn production_script_process(script: &str) -> Arc<ProductionProcess> {
        let mut child = Command::new("/bin/sh")
            .arg("-c")
            .arg(script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let authority = Arc::new(ExactChildAuthority::new(child));
        match ProductionProcess::new(authority.clone(), stdin, stdout) {
            Ok(process) => Arc::new(process),
            Err(_) => {
                authority.kill_if_live();
                authority.wait_and_reap();
                panic!("script child setup failed")
            }
        }
    }

    #[cfg(unix)]
    fn start_script(
        script: impl Into<String>,
        ids: Vec<[u8; 16]>,
    ) -> Result<ManagementChildManager, ManagementStartError> {
        ManagementChildManager::start_with_factory(
            artifact(),
            Arc::new(ScriptFactory {
                script: script.into(),
            }),
            Arc::new(FixedIds(Mutex::new(ids.into()))),
            ManagementProtocol::V1,
            "1.2.3",
            Duration::from_secs(2),
            Duration::from_secs(2),
        )
    }

    #[cfg(unix)]
    fn wait_until_terminal(manager: &ManagementChildManager) -> LifecycleKind {
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut state = manager.inner.lifecycle.state.lock().unwrap();
        while state.kind == LifecycleKind::Ready {
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .expect("manager did not terminalize");
            let (next, timeout) = manager
                .inner
                .lifecycle
                .changed
                .wait_timeout(state, remaining)
                .unwrap();
            state = next;
            assert!(!timeout.timed_out(), "manager did not terminalize");
        }
        state.kind
    }

    struct FixedIds(Mutex<VecDeque<[u8; 16]>>);

    impl RequestIdGenerator for FixedIds {
        fn fill(&self, bytes: &mut [u8; 16]) -> Result<(), ()> {
            *bytes = self.0.lock().unwrap().pop_front().ok_or(())?;
            Ok(())
        }
    }

    struct CountingIds(Mutex<usize>);

    impl RequestIdGenerator for CountingIds {
        fn fill(&self, bytes: &mut [u8; 16]) -> Result<(), ()> {
            *self.0.lock().unwrap() += 1;
            bytes.fill(0);
            Ok(())
        }
    }

    fn fixture() -> Value {
        serde_json::from_str(CASES).expect("management fixture")
    }

    fn ready_frame(version: &str) -> Vec<u8> {
        format!(
            "{{\"contract\":\"{CONTRACT}\",\"protocolVersion\":1,\"runtimeVersion\":\"{version}\"}}\n"
        )
        .into_bytes()
    }

    fn ready_frame_v2(version: &str) -> Vec<u8> {
        format!(
            "{{\"contract\":\"{CONTRACT}\",\"protocolVersion\":2,\"runtimeVersion\":\"{version}\"}}\n"
        )
        .into_bytes()
    }

    fn artifact() -> BundledManagementArtifact {
        BundledManagementArtifact {
            path: PathBuf::from(
                "/Applications/Tmux Worktree.app/Contents/Resources/tw-cli/cli.cjs",
            ),
        }
    }

    fn prepared_identity(marker: u8) -> ManagementPreparedFileIdentity {
        ManagementPreparedFileIdentity {
            device: marker as u64 + 1,
            inode: marker as u64 + 10,
            length: marker as u64 + 20,
            mode: 0o600,
            uid: 501,
            links: 1,
            sha256: [marker; 32],
        }
    }

    fn id_bytes(request_id: &str) -> [u8; 16] {
        let decoded = URL_SAFE_NO_PAD
            .decode(request_id.split_once('.').unwrap().1)
            .unwrap();
        decoded.try_into().unwrap()
    }

    fn operation(value: &str) -> ManagementOperation {
        match value {
            "status" => ManagementOperation::Status,
            "bootstrap_host" => ManagementOperation::BootstrapHost,
            "refresh_host" => ManagementOperation::RefreshHost,
            "start_connector" => ManagementOperation::StartConnector,
            "stop_connector" => ManagementOperation::StopConnector,
            "create_enrollment" => ManagementOperation::CreateEnrollment,
            "revoke_client_grant" => ManagementOperation::RevokeClientGrant,
            _ => panic!("unknown fixture operation"),
        }
    }

    fn start_fake(
        child: Arc<FakeChild>,
        ids: Vec<[u8; 16]>,
        expected_version: &str,
    ) -> ManagementChildManager {
        start_fake_for_protocol(child, ids, expected_version, ManagementProtocol::V1)
    }

    fn start_fake_for_protocol(
        child: Arc<FakeChild>,
        ids: Vec<[u8; 16]>,
        expected_version: &str,
        expected_protocol: ManagementProtocol,
    ) -> ManagementChildManager {
        ManagementChildManager::start_with_factory(
            artifact(),
            FakeFactory::new(child, FakeSpawnAction::Ready),
            Arc::new(FixedIds(Mutex::new(ids.into()))),
            expected_protocol,
            expected_version,
            Duration::from_millis(100),
            Duration::from_millis(100),
        )
        .expect("start fake management child")
    }

    fn start_fake_with_timeouts(
        child: Arc<FakeChild>,
        ids: Vec<[u8; 16]>,
        expected_version: &str,
        startup_timeout: Duration,
        operation_timeout: Duration,
    ) -> ManagementChildManager {
        ManagementChildManager::start_with_factory(
            artifact(),
            FakeFactory::new(child, FakeSpawnAction::Ready),
            Arc::new(FixedIds(Mutex::new(ids.into()))),
            ManagementProtocol::V1,
            expected_version,
            startup_timeout,
            operation_timeout,
        )
        .expect("start fake management child")
    }

    fn fixture_input(input: &Value) -> Vec<u8> {
        match input["kind"].as_str().unwrap() {
            "utf8" => input["value"].as_str().unwrap().as_bytes().to_vec(),
            "base64" => STANDARD.decode(input["value"].as_str().unwrap()).unwrap(),
            "repeat-ascii" => {
                let mut value = vec![
                    input["ascii"].as_str().unwrap().as_bytes()[0];
                    input["count"].as_u64().unwrap() as usize
                ];
                if input["terminator"].as_str() == Some("LF") {
                    value.push(b'\n');
                }
                value
            }
            _ => panic!("unsupported fixture input"),
        }
    }

    #[test]
    fn artifact_selection_accepts_only_the_absolute_regular_bundled_resource() {
        let temp = tempfile::tempdir().unwrap();
        let resource = temp.path().join("Resources");
        fs::create_dir_all(resource.join("tw-cli")).unwrap();
        fs::write(resource.join("tw-cli/cli.cjs"), b"fixture").unwrap();
        let selected = bundled_management_artifact_in(Some(resource.clone())).unwrap();
        assert_eq!(selected.path(), resource.join("tw-cli/cli.cjs"));
        assert!(bundled_management_artifact_in(Some(PathBuf::from("relative"))).is_err());
        assert!(bundled_management_artifact_in(Some(resource.join("missing"))).is_err());
    }

    #[test]
    fn pending_one_shot_inputs_force_admission_then_converge_to_one_steady_key() {
        let selection = |provision, bootstrap, mode| {
            ManagementChildSelection::self_hosted_darwin_arm64(
                PathBuf::from("/Users/fixture"),
                PathBuf::from("/Users/fixture/credential-ca.pem"),
                PathBuf::from("/Users/fixture/carrier-ca.pem"),
                prepared_identity(1),
                prepared_identity(2),
                "00112233445566778899aabbccddeeff".to_string(),
                provision,
                bootstrap,
                mode,
            )
            .unwrap()
        };
        let steady = selection(None, None, None);
        let provision = selection(
            Some((
                PathBuf::from("/Users/fixture/profile.json"),
                prepared_identity(3),
            )),
            None,
            None,
        );
        let bootstrap = selection(
            None,
            Some((
                PathBuf::from("/Users/fixture/bootstrap.twhostboot2"),
                prepared_identity(4),
            )),
            None,
        );
        let rotated_bootstrap = selection(
            None,
            Some((
                PathBuf::from("/Users/fixture/bootstrap.twhostboot2"),
                prepared_identity(4),
            )),
            Some(ManagementBootstrapSecretMode::ReplacePending),
        );

        assert_eq!(steady.launch_key(), steady.steady_launch_key());
        assert_ne!(provision.launch_key(), provision.steady_launch_key());
        assert_ne!(bootstrap.launch_key(), bootstrap.steady_launch_key());
        assert_ne!(
            rotated_bootstrap.launch_key(),
            rotated_bootstrap.steady_launch_key()
        );
        assert_ne!(provision.launch_key(), bootstrap.launch_key());
        assert_ne!(bootstrap.launch_key(), rotated_bootstrap.launch_key());
        assert_eq!(provision.steady_launch_key(), steady.launch_key());
        assert_eq!(bootstrap.steady_launch_key(), steady.launch_key());
        assert_eq!(rotated_bootstrap.steady_launch_key(), steady.launch_key());
    }

    #[test]
    fn rotated_bootstrap_launch_uses_exact_non_secret_replace_pending_mode() {
        let artifact = artifact();
        let selection = ManagementChildSelection::self_hosted_darwin_arm64(
            PathBuf::from("/Users/fixture"),
            PathBuf::from("/Users/fixture/credential-ca.pem"),
            PathBuf::from("/Users/fixture/carrier-ca.pem"),
            prepared_identity(1),
            prepared_identity(2),
            "00112233445566778899aabbccddeeff".to_string(),
            None,
            Some((
                PathBuf::from("/Users/fixture/bootstrap.twhostboot2"),
                prepared_identity(4),
            )),
            Some(ManagementBootstrapSecretMode::ReplacePending),
        )
        .unwrap();
        let command = production_command_with_environment(
            Path::new("/fixed/node"),
            &artifact,
            &selection,
            std::iter::empty::<(OsString, OsString)>(),
        );
        let arguments = command.get_args().collect::<Vec<_>>();
        assert!(arguments.windows(2).any(|pair| {
            pair == [
                std::ffi::OsStr::new("--bootstrap-secret-mode"),
                std::ffi::OsStr::new("replace-pending"),
            ]
        }));
    }

    #[test]
    fn production_launch_uses_only_artifact_fixed_entry_and_allowlisted_environment() {
        let artifact = artifact();
        let command = production_command_with_environment(
            Path::new("/fixed/node"),
            &artifact,
            &ManagementChildSelection::DefaultProduction,
            [
                (OsString::from("HOME"), OsString::from("/Users/fixture")),
                (OsString::from("PATH"), OsString::from("/usr/bin:/bin")),
                (
                    OsString::from("TW_RELAY_BOOTSTRAP_SECRET"),
                    OsString::from("must-not-cross"),
                ),
                (
                    OsString::from("NODE_OPTIONS"),
                    OsString::from("--require=/untrusted/injection.cjs"),
                ),
            ],
        );
        assert_eq!(command.get_program(), std::ffi::OsStr::new("/fixed/node"));
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            vec![
                artifact.path().as_os_str(),
                std::ffi::OsStr::new(HIDDEN_MANAGEMENT_ENTRY)
            ]
        );
        let child_environment = command.get_envs().collect::<Vec<_>>();
        assert_eq!(child_environment.len(), 2);
        assert!(child_environment.contains(&(
            std::ffi::OsStr::new("HOME"),
            Some(std::ffi::OsStr::new("/Users/fixture"))
        )));
        assert!(child_environment.contains(&(
            std::ffi::OsStr::new("PATH"),
            Some(std::ffi::OsStr::new("/usr/bin:/bin"))
        )));

        let mut preconfigured = Command::new("/fixed/node");
        preconfigured.env("TW_RELAY_BOOTSTRAP_SECRET", "must-be-cleared");
        configure_management_child_environment(
            &mut preconfigured,
            [(OsString::from("HOME"), OsString::from("/Users/fixture"))],
        );
        assert_eq!(
            preconfigured.get_envs().collect::<Vec<_>>(),
            vec![(
                std::ffi::OsStr::new("HOME"),
                Some(std::ffi::OsStr::new("/Users/fixture"))
            )]
        );
    }

    #[test]
    fn startup_and_all_golden_exchanges_conform_to_the_shared_fixture() {
        let fixture = fixture();
        let version = fixture["constants"]["expectedVersion"].as_str().unwrap();
        let ready = fixture["startupHandshakeCases"][0]["input"]["firstStdoutFrame"]
            .as_str()
            .unwrap();
        decode_startup_ready(
            ready.trim_end_matches('\n').as_bytes(),
            version,
            ManagementProtocol::V1,
        )
        .unwrap();

        for exchange in fixture["goldenExchanges"].as_array().unwrap() {
            let request_id = exchange["normalizedRequest"]["requestId"].as_str().unwrap();
            let child = FakeChild::sequenced(vec![
                (0, ChildRead::Bytes(ready.as_bytes().to_vec())),
                (
                    1,
                    ChildRead::Bytes(
                        exchange["responseFrame"]
                            .as_str()
                            .unwrap()
                            .as_bytes()
                            .to_vec(),
                    ),
                ),
            ]);
            let manager = start_fake(child.clone(), vec![id_bytes(request_id)], version);
            let outcome = manager
                .request(operation(exchange["operation"].as_str().unwrap()))
                .unwrap();
            assert_eq!(
                serde_json::to_value(outcome).unwrap(),
                exchange["normalizedResponse"]
            );
            assert_eq!(
                child.state.lock().unwrap().writes,
                vec![exchange["requestFrame"]
                    .as_str()
                    .unwrap()
                    .as_bytes()
                    .to_vec()]
            );
        }
    }

    #[test]
    fn private_expected_v2_accepts_v2_and_all_successes_cross_the_supervisor() {
        let fixture: Value = serde_json::from_str(CASES_V2).unwrap();
        let version = fixture["constants"]["expectedVersion"].as_str().unwrap();
        let ready = fixture["startupReadyFrame"].as_str().unwrap();
        decode_startup_ready(
            ready.trim_end_matches('\n').as_bytes(),
            version,
            ManagementProtocol::V2,
        )
        .unwrap();

        for exchange in fixture["goldenExchanges"].as_array().unwrap() {
            let request_id = exchange["normalizedRequest"]["requestId"].as_str().unwrap();
            let child = FakeChild::sequenced(vec![
                (0, ChildRead::Bytes(ready.as_bytes().to_vec())),
                (
                    1,
                    ChildRead::Bytes(
                        exchange["responseFrame"]
                            .as_str()
                            .unwrap()
                            .as_bytes()
                            .to_vec(),
                    ),
                ),
            ]);
            let manager = start_fake_for_protocol(
                child.clone(),
                vec![id_bytes(request_id)],
                version,
                ManagementProtocol::V2,
            );
            let operation = operation(exchange["operation"].as_str().unwrap());
            let outcome = manager
                .request_with_input(
                    operation,
                    management_input(&exchange["normalizedRequest"]["input"]),
                )
                .unwrap();
            let expected: Value =
                serde_json::from_str(exchange["responseFrame"].as_str().unwrap()).unwrap();
            assert_eq!(serde_json::to_value(outcome).unwrap(), expected);
            assert_eq!(
                child.state.lock().unwrap().writes,
                vec![exchange["requestFrame"]
                    .as_str()
                    .unwrap()
                    .as_bytes()
                    .to_vec()]
            );
        }
    }

    #[test]
    fn protocol_mismatch_kills_and_reaps_before_request_id_or_stdin_write() {
        for (name, expected_protocol, ready) in [
            (
                "expected-v1-child-v2",
                ManagementProtocol::V1,
                ready_frame_v2("1.2.3"),
            ),
            (
                "expected-v2-child-v1",
                ManagementProtocol::V2,
                ready_frame("1.2.3"),
            ),
        ] {
            let child = FakeChild::sequenced(vec![(0, ChildRead::Bytes(ready))]);
            let request_ids = Arc::new(CountingIds(Mutex::new(0)));
            let result = ManagementChildManager::start_with_factory(
                artifact(),
                FakeFactory::new(child.clone(), FakeSpawnAction::Ready),
                request_ids.clone(),
                expected_protocol,
                "1.2.3",
                Duration::from_millis(100),
                Duration::from_millis(100),
            );
            assert_eq!(
                result.err(),
                Some(ManagementStartError::ChannelClosed),
                "{name}"
            );
            assert_eq!(*request_ids.0.lock().unwrap(), 0, "{name}");
            let state = child.state.lock().unwrap();
            assert!(state.writes.is_empty(), "{name}");
            assert_eq!(state.events, ["kill-if-live", "wait-and-reap"], "{name}");
        }
    }

    #[test]
    fn dashboard_management_v2_real_v1_selection_stays_default_off_and_drops_v2_inputs() {
        let fixture = fixture();
        let exchange = fixture["goldenExchanges"]
            .as_array()
            .unwrap()
            .iter()
            .find(|exchange| exchange["operation"] == "create_enrollment")
            .unwrap();
        let request_id = exchange["normalizedRequest"]["requestId"].as_str().unwrap();
        let child = FakeChild::ready_then(
            "1.2.3",
            vec![ChildRead::Bytes(
                exchange["responseFrame"]
                    .as_str()
                    .unwrap()
                    .as_bytes()
                    .to_vec(),
            )],
        );
        let manager = start_fake(child.clone(), vec![id_bytes(request_id)], "1.2.3");
        let outcome = manager
            .request_with_input(
                ManagementOperation::CreateEnrollment,
                ManagementInput::CreateEnrollment {
                    device_label: Some("Pixel".to_string()),
                },
            )
            .unwrap();
        assert_eq!(outcome.protocol_version, 1);
        assert_eq!(outcome.error.unwrap().code, "UNAVAILABLE");
        assert_eq!(
            child.state.lock().unwrap().writes,
            vec![exchange["requestFrame"]
                .as_str()
                .unwrap()
                .as_bytes()
                .to_vec()]
        );
    }

    #[test]
    fn dashboard_management_v2_invalid_or_forged_stdout_poisons_without_switching_protocol() {
        let fixture: Value = serde_json::from_str(CASES_V2).unwrap();
        let version = fixture["constants"]["expectedVersion"].as_str().unwrap();

        for (name, ready) in [
            ("v1-ready", ready_frame(version)),
            ("wrong-runtime", ready_frame_v2("9.9.9")),
        ] {
            let child = FakeChild::sequenced(vec![(0, ChildRead::Bytes(ready))]);
            let request_ids = Arc::new(CountingIds(Mutex::new(0)));
            let result = ManagementChildManager::start_with_factory(
                artifact(),
                FakeFactory::new(child.clone(), FakeSpawnAction::Ready),
                request_ids.clone(),
                PRODUCTION_EXPECTED_PROTOCOL,
                version,
                Duration::from_millis(100),
                Duration::from_millis(100),
            );
            assert_eq!(
                result.err(),
                Some(ManagementStartError::ChannelClosed),
                "{name}"
            );
            assert_eq!(*request_ids.0.lock().unwrap(), 0, "{name}");
            let state = child.state.lock().unwrap();
            assert!(state.writes.is_empty(), "{name}");
            assert_eq!(state.events, ["kill-if-live", "wait-and-reap"], "{name}");
        }

        for case in fixture["invalidResponseFrameCases"].as_array().unwrap() {
            let request_id = case["expectedRequestId"].as_str().unwrap();
            let mut response = case["frame"].as_str().unwrap().as_bytes().to_vec();
            response.push(b'\n');
            let child = FakeChild::sequenced(vec![
                (0, ChildRead::Bytes(ready_frame_v2(version))),
                (1, ChildRead::Bytes(response)),
            ]);
            let manager = start_fake_for_protocol(
                child.clone(),
                vec![id_bytes(request_id)],
                version,
                PRODUCTION_EXPECTED_PROTOCOL,
            );
            let outcome = manager
                .request(operation(case["operation"].as_str().unwrap()))
                .unwrap();
            assert_eq!(outcome.protocol_version, 2, "{}", case["name"]);
            assert_eq!(
                outcome.error.unwrap().code,
                "CHANNEL_CLOSED",
                "{}",
                case["name"]
            );
            let state = child.state.lock().unwrap();
            assert_eq!(state.writes.len(), 1, "{}", case["name"]);
            assert_eq!(
                state.events,
                ["write", "kill-if-live", "wait-and-reap"],
                "{}",
                case["name"]
            );
            assert!(state.writes[0].starts_with(b"{\"protocolVersion\":2"));
        }
    }

    #[test]
    fn dashboard_management_v2_extra_stdout_frame_poisons_and_clears_the_channel() {
        let fixture: Value = serde_json::from_str(CASES_V2).unwrap();
        let exchange = &fixture["goldenExchanges"][0];
        let version = fixture["constants"]["expectedVersion"].as_str().unwrap();
        let request_id = exchange["normalizedRequest"]["requestId"].as_str().unwrap();
        let child = FakeChild::sequenced(vec![
            (0, ChildRead::Bytes(ready_frame_v2(version))),
            (
                1,
                ChildRead::Bytes(
                    exchange["responseFrame"]
                        .as_str()
                        .unwrap()
                        .as_bytes()
                        .to_vec(),
                ),
            ),
            (1, ChildRead::Bytes(b"{}\n".to_vec())),
        ]);
        let manager = start_fake_for_protocol(
            child.clone(),
            vec![id_bytes(request_id)],
            version,
            ManagementProtocol::V2,
        );
        let outcome = manager.request(ManagementOperation::Status).unwrap();
        assert_eq!(outcome.protocol_version, 2);
        assert_eq!(outcome.error.unwrap().code, "CHANNEL_CLOSED");
        assert_eq!(
            child.state.lock().unwrap().events,
            ["write", "kill-if-live", "wait-and-reap"]
        );
    }

    fn management_input(value: &Value) -> ManagementInput {
        match value {
            Value::Null => ManagementInput::None,
            Value::Object(object) if object.contains_key("deviceLabel") => {
                ManagementInput::CreateEnrollment {
                    device_label: object["deviceLabel"].as_str().map(str::to_string),
                }
            }
            Value::Object(object) => ManagementInput::RevokeClientGrant {
                grant_id: object["grantId"].as_str().unwrap().to_string(),
            },
            _ => panic!("unknown management input"),
        }
    }

    #[test]
    fn two_valid_requests_are_serialized_on_the_same_child() {
        let fixture = fixture();
        let version = fixture["constants"]["expectedVersion"].as_str().unwrap();
        let exchanges = fixture["goldenExchanges"].as_array().unwrap();
        let status = exchanges
            .iter()
            .find(|exchange| exchange["operation"] == "status")
            .unwrap();
        let stop = exchanges
            .iter()
            .find(|exchange| exchange["operation"] == "stop_connector")
            .unwrap();
        let status_id = status["normalizedRequest"]["requestId"].as_str().unwrap();
        let stop_id = stop["normalizedRequest"]["requestId"].as_str().unwrap();
        let child = FakeChild::sequenced(vec![
            (0, ChildRead::Bytes(ready_frame(version))),
            (
                1,
                ChildRead::Bytes(
                    status["responseFrame"]
                        .as_str()
                        .unwrap()
                        .as_bytes()
                        .to_vec(),
                ),
            ),
            (
                2,
                ChildRead::Bytes(stop["responseFrame"].as_str().unwrap().as_bytes().to_vec()),
            ),
        ]);
        let manager = start_fake(
            child.clone(),
            vec![id_bytes(status_id), id_bytes(stop_id)],
            version,
        );
        assert_eq!(
            serde_json::to_value(manager.request(ManagementOperation::Status).unwrap()).unwrap(),
            status["normalizedResponse"]
        );
        assert_eq!(
            serde_json::to_value(manager.request(ManagementOperation::StopConnector).unwrap())
                .unwrap(),
            stop["normalizedResponse"]
        );
        let state = child.state.lock().unwrap();
        assert_eq!(state.writes.len(), 2);
        assert_eq!(state.events, ["write", "write"]);
    }

    #[test]
    fn startup_timeout_drains_but_bad_ready_fixtures_kill_before_returning() {
        let fixture = fixture();
        let version = fixture["constants"]["expectedVersion"].as_str().unwrap();
        for case in fixture["startupHandshakeCases"]
            .as_array()
            .unwrap()
            .iter()
            .skip(1)
        {
            let startup = match &case["input"] {
                Value::Object(input) => vec![ChildRead::Bytes(
                    input["firstStdoutFrame"]
                        .as_str()
                        .unwrap()
                        .as_bytes()
                        .to_vec(),
                )],
                Value::Null if case["name"] == "startup-eof-before-ready-poisons" => {
                    vec![ChildRead::Eof]
                }
                Value::Null => vec![ChildRead::TimedOut],
                _ => panic!("unsupported startup fixture"),
            };
            let child = FakeChild::sequenced(startup.into_iter().map(|read| (0, read)).collect());
            assert_eq!(
                ManagementChildManager::start_with_factory(
                    artifact(),
                    FakeFactory::new(child.clone(), FakeSpawnAction::Ready),
                    Arc::new(FixedIds(Mutex::new(VecDeque::new()))),
                    ManagementProtocol::V1,
                    version,
                    Duration::from_millis(100),
                    Duration::from_millis(100),
                )
                .err(),
                Some(ManagementStartError::ChannelClosed),
                "{}",
                case["name"]
            );
            assert_eq!(
                child.state.lock().unwrap().events,
                if case["name"] == "startup-handshake-timeout-covers-spawn-through-validated-ready"
                {
                    vec!["close-stdin", "wait-and-reap"]
                } else {
                    vec!["kill-if-live", "wait-and-reap"]
                },
                "{}",
                case["name"]
            );
        }
    }

    #[test]
    fn startup_timeout_kills_only_after_graceful_drain_does_not_settle() {
        let child = FakeChild::sequenced(vec![(0, ChildRead::TimedOut)]);
        child.set_exit_after_stdin_close(false);
        let result = ManagementChildManager::start_with_factory(
            artifact(),
            FakeFactory::new(child.clone(), FakeSpawnAction::Ready),
            Arc::new(FixedIds(Mutex::new(VecDeque::new()))),
            ManagementProtocol::V1,
            "1.2.3",
            Duration::from_millis(10),
            Duration::from_millis(100),
        );

        assert_eq!(result.err(), Some(ManagementStartError::RecoveryRequired));
        assert_eq!(
            child.state.lock().unwrap().events,
            ["close-stdin", "kill-if-live", "wait-and-reap"]
        );
    }

    #[test]
    fn blocking_spawn_cannot_return_before_the_exact_attempt_is_cleaned_up() {
        let child = FakeChild::ready_then("1.2.3", Vec::new());
        let factory = FakeFactory::new(child.clone(), FakeSpawnAction::BlockUntilReleased);
        let start_factory = factory.clone();
        let (sent, received) = mpsc::channel();
        let start = thread::spawn(move || {
            let result = ManagementChildManager::start_with_factory(
                artifact(),
                start_factory,
                Arc::new(FixedIds(Mutex::new(VecDeque::new()))),
                ManagementProtocol::V1,
                "1.2.3",
                Duration::ZERO,
                Duration::from_millis(100),
            );
            sent.send(result.err()).unwrap();
        });
        factory.wait_until_entered();
        assert!(received.try_recv().is_err());
        factory.release();
        assert_eq!(
            received.recv().unwrap(),
            Some(ManagementStartError::ChannelClosed)
        );
        start.join().unwrap();
        let state = child.state.lock().unwrap();
        assert!(state.reaped);
        assert_eq!(state.events, ["close-stdin", "wait-and-reap"]);
    }

    #[test]
    fn setup_failure_after_spawn_kills_and_reaps_the_exact_child() {
        let child = FakeChild::ready_then("1.2.3", Vec::new());
        let result = ManagementChildManager::start_with_factory(
            artifact(),
            FakeFactory::new(child.clone(), FakeSpawnAction::FailedAfterChild),
            Arc::new(FixedIds(Mutex::new(VecDeque::new()))),
            ManagementProtocol::V1,
            "1.2.3",
            Duration::from_millis(100),
            Duration::from_millis(100),
        );
        assert_eq!(result.err(), Some(ManagementStartError::ChannelClosed));
        assert_eq!(
            child.state.lock().unwrap().events,
            ["kill-if-live", "wait-and-reap"]
        );
    }

    #[test]
    fn request_id_generation_failure_poisons_before_any_write() {
        let child = FakeChild::ready_then("1.2.3", Vec::new());
        let manager = start_fake(child.clone(), Vec::new(), "1.2.3");
        assert_eq!(
            manager.request(ManagementOperation::Status),
            Err(ManagementCallError::RequestIdUnavailable)
        );
        let state = child.state.lock().unwrap();
        assert!(state.writes.is_empty());
        assert_eq!(state.events, ["kill-if-live", "wait-and-reap"]);
    }

    #[cfg(unix)]
    #[test]
    fn production_stdout_owner_orders_frames_before_the_exact_exit() {
        let process = script_process("printf 'one\\ntwo\\n'; exit 78");
        let deadline = Instant::now() + Duration::from_secs(1);
        assert_eq!(
            process.read_stdout(deadline),
            ChildRead::Bytes(b"one\n".to_vec())
        );
        assert_eq!(
            process.read_stdout(deadline),
            ChildRead::Bytes(b"two\n".to_vec())
        );
        assert_eq!(
            process.read_stdout(deadline),
            ChildRead::Exited(ChildExit { code: Some(78) })
        );
        assert_eq!(process.wait_and_reap().code, Some(78));
    }

    #[cfg(unix)]
    #[test]
    fn production_health_cut_requests_a_drain_for_an_exit_in_the_idle_gap() {
        let directory = tempfile::tempdir().unwrap();
        let marker = directory.path().join("child-exited");
        let process = production_script_process(&format!(
            "IFS= read -r signal; : > '{}'; exit 0",
            marker.display()
        ));
        let deadline = Instant::now() + Duration::from_secs(2);
        assert!(process
            .observations
            .pause_unsolicited_drains_after_current_ack(deadline));
        assert_eq!(
            process.write_stdin_once(b"exit\n", deadline),
            ChildWrite::Written(5)
        );
        while !marker.is_file() {
            assert!(Instant::now() < deadline, "child did not reach exit");
            thread::sleep(Duration::from_millis(1));
        }
        loop {
            match process.authority.try_exit() {
                Ok(Some(exit)) => {
                    assert_eq!(exit.code, Some(0));
                    break;
                }
                Ok(None) if Instant::now() < deadline => {
                    thread::sleep(Duration::from_millis(1));
                }
                _ => panic!("exact child did not exit"),
            }
        }

        assert_eq!(process.poll_stdout(), ChildPoll::Pending);
        assert_eq!(
            process.poll_health(deadline),
            ChildPoll::Exited(ChildExit { code: Some(0) })
        );
        assert_eq!(process.wait_and_reap().code, Some(0));
    }

    #[cfg(unix)]
    #[test]
    fn production_stdout_owner_latches_payload_overflow() {
        let process = script_process(
            "i=0; while [ \"$i\" -lt 16385 ]; do printf x; i=$((i + 1)); done; printf '\\n'",
        );
        assert_eq!(
            process.read_stdout(Instant::now() + Duration::from_secs(2)),
            ChildRead::Failed
        );
        process.kill_if_live();
        process.wait_and_reap();
    }

    #[cfg(unix)]
    #[test]
    fn dashboard_management_v2_production_post_response_requires_a_fresh_drain_ack() {
        let directory = tempfile::tempdir().unwrap();
        let marker = directory.path().join("extra-written");
        let script = format!(
            "printf 'response\\n'; IFS= read -r signal; printf 'extra\\n'; : > '{}'; IFS= read -r hold",
            marker.display()
        );
        let process = production_script_process(&script);
        let deadline = Instant::now() + Duration::from_secs(2);
        assert_eq!(
            process.read_stdout(deadline),
            ChildRead::Bytes(b"response\n".to_vec())
        );
        assert!(process
            .observations
            .pause_unsolicited_drains_after_current_ack(deadline));
        assert_eq!(
            process.write_stdin_once(b"continue\n", deadline),
            ChildWrite::Written(b"continue\n".len())
        );
        while !marker.is_file() {
            assert!(
                Instant::now() < deadline,
                "child did not write the extra frame"
            );
            thread::sleep(Duration::from_millis(1));
        }

        assert_eq!(process.poll_after_response(deadline), ChildPoll::Output);
        process.kill_if_live();
        process.wait_and_reap();
    }

    #[cfg(unix)]
    #[test]
    fn buffered_output_takes_priority_over_simultaneous_exit_78() {
        let manager = start_script(
            "printf '%s\\n' '{\"contract\":\"tmux-worktree-dashboard-relay-v2-management-ipc\",\"protocolVersion\":1,\"runtimeVersion\":\"1.2.3\"}'; printf 'unexpected\\n'; exit 78",
            vec![[6; 16]],
        )
        .unwrap();
        assert_eq!(
            manager.request(ManagementOperation::Status),
            Err(ManagementCallError::ChannelClosed)
        );
    }

    #[test]
    fn valid_response_followed_by_an_extra_frame_returns_channel_closed() {
        let fixture = fixture();
        let exchange = fixture["goldenExchanges"]
            .as_array()
            .unwrap()
            .iter()
            .find(|exchange| exchange["operation"] == "status")
            .unwrap();
        let version = fixture["constants"]["expectedVersion"].as_str().unwrap();
        let request_id = exchange["normalizedRequest"]["requestId"].as_str().unwrap();
        let child = FakeChild::sequenced(vec![
            (0, ChildRead::Bytes(ready_frame(version))),
            (
                1,
                ChildRead::Bytes(
                    exchange["responseFrame"]
                        .as_str()
                        .unwrap()
                        .as_bytes()
                        .to_vec(),
                ),
            ),
            (1, ChildRead::Bytes(b"{}\n".to_vec())),
        ]);
        let manager = start_fake(child.clone(), vec![id_bytes(request_id)], version);
        let outcome = manager.request(ManagementOperation::Status).unwrap();
        assert_eq!(outcome.error.unwrap().code, "CHANNEL_CLOSED");
        assert_eq!(
            child.state.lock().unwrap().events,
            ["write", "kill-if-live", "wait-and-reap"]
        );
    }

    #[cfg(unix)]
    #[test]
    fn correlated_response_finishes_before_a_following_exit_78_terminalizes_the_manager() {
        let fixture = fixture();
        let exchange = fixture["goldenExchanges"]
            .as_array()
            .unwrap()
            .iter()
            .find(|exchange| exchange["operation"] == "status")
            .unwrap();
        let request_id = exchange["normalizedRequest"]["requestId"].as_str().unwrap();
        let response = exchange["responseFrame"]
            .as_str()
            .unwrap()
            .trim_end_matches('\n');
        assert!(!response.contains('\''));
        let script = format!(
            "printf '%s\\n' '{{\"contract\":\"tmux-worktree-dashboard-relay-v2-management-ipc\",\"protocolVersion\":1,\"runtimeVersion\":\"1.2.3\"}}'; IFS= read -r request; printf '%s\\n' '{response}'; exit 78"
        );
        let manager = start_script(script, vec![id_bytes(request_id)]).unwrap();
        assert_eq!(
            serde_json::to_value(manager.request(ManagementOperation::Status).unwrap()).unwrap(),
            exchange["normalizedResponse"]
        );
        assert_eq!(wait_until_terminal(&manager), LifecycleKind::Superseded);
        assert_eq!(
            manager.request(ManagementOperation::Status),
            Err(ManagementCallError::Superseded)
        );
    }

    #[test]
    fn late_extra_frame_is_supervised_without_a_followup_request() {
        let fixture = fixture();
        let exchange = fixture["goldenExchanges"]
            .as_array()
            .unwrap()
            .iter()
            .find(|exchange| exchange["operation"] == "status")
            .unwrap();
        let version = fixture["constants"]["expectedVersion"].as_str().unwrap();
        let request_id = exchange["normalizedRequest"]["requestId"].as_str().unwrap();
        let child = FakeChild::ready_then(
            version,
            vec![ChildRead::Bytes(
                exchange["responseFrame"]
                    .as_str()
                    .unwrap()
                    .as_bytes()
                    .to_vec(),
            )],
        );
        let manager = start_fake(child.clone(), vec![id_bytes(request_id)], version);
        assert!(manager.request(ManagementOperation::Status).unwrap().ok);
        child.push_read(1, ChildRead::Bytes(b"{}\n".to_vec()));
        child.wait_until_reaped();
        assert_eq!(
            child.state.lock().unwrap().events,
            ["write", "kill-if-live", "wait-and-reap"]
        );
    }

    #[cfg(unix)]
    #[test]
    fn idle_exit_78_is_supervised_without_waiting_for_another_request() {
        let manager = start_script(
            "printf '%s\\n' '{\"contract\":\"tmux-worktree-dashboard-relay-v2-management-ipc\",\"protocolVersion\":1,\"runtimeVersion\":\"1.2.3\"}'; (sleep 1) & exit 78",
            vec![[4; 16]],
        )
        .unwrap();
        assert_eq!(wait_until_terminal(&manager), LifecycleKind::Superseded);
        assert_eq!(
            manager.request(ManagementOperation::Status),
            Err(ManagementCallError::Superseded)
        );
    }

    #[test]
    fn idle_eof_is_supervised_as_channel_poison() {
        let child = FakeChild::sequenced(vec![
            (0, ChildRead::Bytes(ready_frame("1.2.3"))),
            (0, ChildRead::Eof),
        ]);
        let _manager = start_fake(child.clone(), vec![[11; 16]], "1.2.3");
        child.wait_until_reaped();
        assert_eq!(
            child.state.lock().unwrap().events,
            ["kill-if-live", "wait-and-reap"]
        );
    }

    #[test]
    fn same_key_health_cut_rejects_exit_between_stdout_drains() {
        let child = FakeChild::ready_then("1.2.3", Vec::new());
        let manager = start_fake(child.clone(), vec![[12; 16]], "1.2.3");
        // The observation queue is empty, matching the production gap after
        // one acknowledged would-block drain and before the stdout owner has
        // published the exact process exit on its next pass.
        child.set_health_poll(ChildPoll::Exited(ChildExit { code: Some(0) }));

        assert!(!manager.is_reusable_after_observation());
        assert_eq!(manager.dispose(), ManagementCleanupOutcome::Clean);
        assert_eq!(child.state.lock().unwrap().events, ["wait-and-reap"]);
    }

    #[test]
    fn missing_required_nullable_response_root_keys_poison_the_channel() {
        let fixture = fixture();
        let version = fixture["constants"]["expectedVersion"].as_str().unwrap();
        for (operation_name, missing_key) in [("status", "error"), ("stop_connector", "result")] {
            let exchange = fixture["goldenExchanges"]
                .as_array()
                .unwrap()
                .iter()
                .find(|exchange| exchange["operation"] == operation_name)
                .unwrap();
            let request_id = exchange["normalizedRequest"]["requestId"].as_str().unwrap();
            let mut response: Value =
                serde_json::from_str(exchange["responseFrame"].as_str().unwrap()).unwrap();
            response.as_object_mut().unwrap().remove(missing_key);
            let mut response_frame = serde_json::to_vec(&response).unwrap();
            response_frame.push(b'\n');
            let child = FakeChild::ready_then(version, vec![ChildRead::Bytes(response_frame)]);
            let manager = start_fake(child.clone(), vec![id_bytes(request_id)], version);
            let outcome = manager
                .request(operation(operation_name))
                .expect("local channel outcome");
            assert_eq!(outcome.error.unwrap().code, "CHANNEL_CLOSED");
            let state = child.state.lock().unwrap();
            assert_eq!(state.writes.len(), 1);
            assert_eq!(state.events, ["write", "kill-if-live", "wait-and-reap"]);
        }
    }

    #[test]
    fn every_invalid_response_fixture_poisons_kills_and_reaps_without_replay() {
        let fixture = fixture();
        let version = fixture["constants"]["expectedVersion"].as_str().unwrap();
        for case in fixture["invalidResponseFrameCases"].as_array().unwrap() {
            let request_id = case["inFlightRequestId"].as_str().unwrap();
            let child = FakeChild::ready_then(
                version,
                vec![ChildRead::Bytes(fixture_input(&case["input"]))],
            );
            let manager = start_fake(child.clone(), vec![id_bytes(request_id)], version);
            let outcome = manager
                .request(operation(case["operation"].as_str().unwrap()))
                .unwrap();
            assert_eq!(
                outcome.error.unwrap().code,
                "CHANNEL_CLOSED",
                "{}",
                case["name"]
            );
            let state = child.state.lock().unwrap();
            assert_eq!(state.writes.len(), 1, "{}", case["name"]);
            assert_eq!(
                state.events,
                ["write", "kill-if-live", "wait-and-reap"],
                "{}",
                case["name"]
            );
        }
    }

    #[test]
    fn partial_write_uses_one_write_then_poisons_and_reaps() {
        let child = FakeChild::ready_then("1.2.3", Vec::new());
        child.set_write_action(WriteAction::Partial(17));
        let manager = start_fake(child.clone(), vec![[7; 16]], "1.2.3");
        let outcome = manager.request(ManagementOperation::Status).unwrap();
        assert_eq!(outcome.error.unwrap().code, "CHANNEL_CLOSED");
        assert_eq!(
            child.state.lock().unwrap().events,
            ["write", "kill-if-live", "wait-and-reap"]
        );
    }

    #[test]
    fn blocking_first_write_uses_owner_deadline_then_kills_and_reaps() {
        let child = FakeChild::ready_then("1.2.3", Vec::new());
        child.set_write_action(WriteAction::Block);
        let manager = start_fake_with_timeouts(
            child.clone(),
            vec![[3; 16]],
            "1.2.3",
            Duration::from_millis(100),
            Duration::from_millis(10),
        );
        let outcome = manager.request(ManagementOperation::Status).unwrap();
        assert_eq!(outcome.error.unwrap().code, "CHANNEL_CLOSED");
        assert_eq!(
            child.state.lock().unwrap().events,
            ["write", "kill-if-live", "wait-and-reap"]
        );
    }

    #[test]
    fn blocking_response_read_uses_the_same_owner_deadline() {
        let child = FakeChild::ready_then("1.2.3", Vec::new());
        let manager = start_fake_with_timeouts(
            child.clone(),
            vec![[12; 16]],
            "1.2.3",
            Duration::from_millis(100),
            Duration::from_millis(10),
        );
        let outcome = manager.request(ManagementOperation::Status).unwrap();
        assert_eq!(outcome.error.unwrap().code, "CHANNEL_CLOSED");
        assert_eq!(
            child.state.lock().unwrap().events,
            ["write", "kill-if-live", "wait-and-reap"]
        );
    }

    #[cfg(unix)]
    #[test]
    fn ordinary_and_signal_exits_wait_then_return_channel_closed() {
        for script in [
            "printf '%s\\n' '{\"contract\":\"tmux-worktree-dashboard-relay-v2-management-ipc\",\"protocolVersion\":1,\"runtimeVersion\":\"1.2.3\"}'; IFS= read -r request; exit 1",
            "printf '%s\\n' '{\"contract\":\"tmux-worktree-dashboard-relay-v2-management-ipc\",\"protocolVersion\":1,\"runtimeVersion\":\"1.2.3\"}'; IFS= read -r request; kill -TERM $$",
        ] {
            let manager = start_script(script, vec![[2; 16]]).unwrap();
            let outcome = manager.request(ManagementOperation::Status).unwrap();
            assert_eq!(outcome.error.unwrap().code, "CHANNEL_CLOSED");
        }
    }

    #[cfg(unix)]
    #[test]
    fn partial_frame_then_exit_78_is_protocol_poison_not_superseded() {
        let manager = start_script(
            "printf '%s\\n' '{\"contract\":\"tmux-worktree-dashboard-relay-v2-management-ipc\",\"protocolVersion\":1,\"runtimeVersion\":\"1.2.3\"}'; IFS= read -r request; printf '{\"protocolVersion\":1'; exit 78",
            vec![[1; 16]],
        )
        .unwrap();
        let outcome = manager.request(ManagementOperation::Status).unwrap();
        assert_eq!(outcome.error.unwrap().code, "CHANNEL_CLOSED");
    }

    #[cfg(unix)]
    #[test]
    fn post_handshake_exit_78_is_superseded_only_after_wait_without_kill() {
        let manager = start_script(
            "printf '%s\\n' '{\"contract\":\"tmux-worktree-dashboard-relay-v2-management-ipc\",\"protocolVersion\":1,\"runtimeVersion\":\"1.2.3\"}'; IFS= read -r request; exit 78",
            vec![[8; 16]],
        )
        .unwrap();
        let outcome = manager.request(ManagementOperation::Status).unwrap();
        assert_eq!(outcome.error.unwrap().code, "SUPERSEDED");

        assert_eq!(
            start_script("exit 78", Vec::new()).err(),
            Some(ManagementStartError::ChannelClosed)
        );
    }

    #[test]
    fn a_second_concurrent_request_immediately_poisons_instead_of_queueing() {
        let child = FakeChild::ready_then("1.2.3", Vec::new());
        child.set_write_action(WriteAction::Block);
        let manager = Arc::new(start_fake(child.clone(), vec![[9; 16]], "1.2.3"));
        let first_manager = manager.clone();
        let (sent, received) = mpsc::channel();
        thread::spawn(move || {
            sent.send(first_manager.request(ManagementOperation::Status))
                .unwrap();
        });
        child.wait_until_blocked();
        assert_eq!(
            manager.request(ManagementOperation::StopConnector),
            Err(ManagementCallError::ChannelClosed)
        );
        let first = received.recv().unwrap().unwrap();
        assert_eq!(first.error.unwrap().code, "CHANNEL_CLOSED");
        let state = child.state.lock().unwrap();
        assert_eq!(state.writes.len(), 1);
        assert_eq!(state.events, ["write", "kill-if-live", "wait-and-reap"]);
    }

    #[cfg(unix)]
    #[test]
    fn dispose_closed_wins_over_idle_exit_and_protocol_poison_classifiers() {
        for script in [
            "printf '%s\\n' '{\"contract\":\"tmux-worktree-dashboard-relay-v2-management-ipc\",\"protocolVersion\":1,\"runtimeVersion\":\"1.2.3\"}'; (sleep 1) & exit 78",
            "printf '%s\\n' '{\"contract\":\"tmux-worktree-dashboard-relay-v2-management-ipc\",\"protocolVersion\":1,\"runtimeVersion\":\"1.2.3\"}'; printf 'unexpected\\n'; sleep 1",
        ] {
            let manager = Arc::new(start_script(script, vec![[13; 16]]).unwrap());
            let dispose_manager = manager.clone();
            let dispose = thread::spawn(move || dispose_manager.dispose());
            dispose.join().unwrap();
            assert_eq!(manager.inner.lifecycle_kind_after_barrier(), LifecycleKind::Closed);
            assert_eq!(
                manager.request(ManagementOperation::Status),
                Err(ManagementCallError::ChannelClosed)
            );
        }
    }

    #[test]
    fn dispose_waits_for_the_active_request_write_barrier() {
        let child = FakeChild::ready_then("1.2.3", Vec::new());
        child.set_write_action(WriteAction::Block);
        let manager = Arc::new(start_fake_with_timeouts(
            child.clone(),
            vec![[5; 16]],
            "1.2.3",
            Duration::from_millis(100),
            Duration::from_secs(1),
        ));
        let request_manager = manager.clone();
        let (sent, received) = mpsc::channel();
        thread::spawn(move || {
            sent.send(request_manager.request(ManagementOperation::Status))
                .unwrap();
        });
        child.wait_until_blocked();
        manager.dispose();
        assert!(child.state.lock().unwrap().reaped);
        assert_eq!(
            manager.inner.lifecycle_kind_after_barrier(),
            LifecycleKind::Closed
        );
        let outcome = received.recv().unwrap().unwrap();
        assert_eq!(outcome.error.unwrap().code, "CHANNEL_CLOSED");
        assert_eq!(
            child.state.lock().unwrap().events,
            ["write", "kill-if-live", "wait-and-reap"]
        );
    }
}
