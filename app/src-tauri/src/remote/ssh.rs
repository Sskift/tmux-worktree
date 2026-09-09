use super::{validate_ssh_host_fields, HostConfig};
use crate::support::{
    app_home_dir_or_tmp, remote_path_expr, shell_join, shell_quote, user_bin_path_prefix,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use sha2::{Digest, Sha256};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

/// Hard wall-clock budgets for one-shot remote commands.
///
/// SSH's `ServerAliveInterval`/`ServerAliveCountMax` only detect an sshd that
/// stops answering keepalives; they do NOT bound "host reachable but the
/// command never returns" — a bootstrap blocked on remote fs/tmux, a stalled
/// scp mid-transfer, or a full remote disk. Without a hard wall-clock bound the
/// deployment operation `std::Mutex` parks forever on `.output()` /
/// `wait_with_output()`, and a JS-side invoke timeout cannot release the Rust
/// lock (the only escape is force-killing the Dashboard). Budgets are sized per
/// call class so the normal path is unaffected while a wedged command fails fast
/// with a structured error that propagates to the UI and releases the lock.
///
/// Quick probes / tmux checks / TLS validation / small stdin profile publish:
/// single fast round-trips; 120s is far beyond a healthy devbox round-trip.
pub(crate) const REMOTE_CMD_CHECK_TIMEOUT: Duration = Duration::from_secs(120);
/// scp of the ~10MB CLI bundle (plus package.json) over a slow/high-latency
/// link; 15 minutes is far beyond a healthy transfer but bounds a stall.
pub(crate) const REMOTE_CMD_FILE_TRANSFER_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// Remote git (status/fetch) can walk a large repository on a loaded devbox.
pub(crate) const REMOTE_CMD_REMOTE_GIT_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// Remote worktree `find` scan and `git worktree remove` over a large base.
pub(crate) const REMOTE_CMD_REMOTE_CLEANUP_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// Remote source install of tw (`git clone` + `npm install` + `npm run build`
/// + `npm link`) on a fresh or loaded devbox.
///
/// A cold clone plus the tsup/esbuild dependency tree and a full build
/// routinely take 2–10 minutes, so the 120s probe budget would deterministically
/// kill a slow-but-successful install. 15 minutes matches the other heavy
/// remote-op budgets while still bounding a genuinely wedged install.
pub(crate) const REMOTE_CMD_REMOTE_INSTALL_TIMEOUT: Duration = Duration::from_secs(15 * 60);

fn ssh_control_directory_in(home: &Path, namespace: &str) -> Result<PathBuf, String> {
    let directory = home.join(".tmux-worktree").join(namespace);
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("create SSH control directory: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = std::fs::metadata(&directory)
            .map_err(|error| format!("read SSH control directory permissions: {error}"))?
            .permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(&directory, permissions)
            .map_err(|error| format!("secure SSH control directory: {error}"))?;
    }
    Ok(directory)
}

fn ssh_control_path_in(home: &Path, namespace: &str) -> Result<String, String> {
    Ok(ssh_control_directory_in(home, namespace)?
        .join("%C")
        .to_string_lossy()
        .to_string())
}

fn ssh_control_path(namespace: &str) -> Result<String, String> {
    ssh_control_path_in(&app_home_dir_or_tmp(), namespace)
}

fn apply_ssh_multiplex_options_with_path(command: &mut Command, control_path: &str) {
    command
        .arg("-o")
        .arg("ControlMaster=auto")
        .arg("-o")
        .arg("ControlPersist=600")
        .arg("-o")
        .arg(format!("ControlPath={control_path}"));
}

pub(crate) fn apply_ssh_multiplex_options(command: &mut Command) {
    let Ok(control_path) = ssh_control_path("ssh") else {
        return;
    };
    apply_ssh_multiplex_options_with_path(command, &control_path);
}

fn ssh_command_with_control_path(
    host: &HostConfig,
    remote_cmd: &[&str],
    control_path: Option<&str>,
) -> Result<Command, String> {
    validate_ssh_host_fields(host)?;
    let mut cmd = Command::new("ssh");
    cmd.arg("-o")
        .arg("BatchMode=yes")
        .arg("-o")
        .arg("StrictHostKeyChecking=accept-new")
        .arg("-o")
        .arg("ConnectTimeout=5")
        .arg("-o")
        .arg("ServerAliveInterval=15")
        .arg("-o")
        .arg("ServerAliveCountMax=3");
    if let Some(control_path) = control_path {
        apply_ssh_multiplex_options_with_path(&mut cmd, control_path);
    }
    if let Some(port) = host.port {
        cmd.arg("-p").arg(port.to_string());
    }
    if let Some(key) = &host.identity_file {
        cmd.arg("-i").arg(key);
    }
    if let Some(user) = &host.user {
        cmd.arg("-l").arg(user);
    }
    // End local option parsing before the destination. Validation above is a
    // second line of defence for callers loading hand-edited legacy config.
    cmd.arg("--").arg(&host.host);
    if !remote_cmd.is_empty() {
        cmd.arg(format!(
            "{}; {}",
            user_bin_path_prefix(),
            shell_join(remote_cmd)
        ));
    }
    Ok(cmd)
}

/// Build an SSH command that runs `remote_cmd` on `host` non-interactively.
/// Uses BatchMode=yes to avoid hanging on password prompts.
pub(crate) fn ssh_command(host: &HostConfig, remote_cmd: &[&str]) -> Result<Command, String> {
    let control_path = ssh_control_path("ssh").ok();
    ssh_command_with_control_path(host, remote_cmd, control_path.as_deref())
}

fn terminal_control_ssh_command(host: &HostConfig, remote_cmd: &[&str]) -> Result<Command, String> {
    // Raw input is a per-keystroke RPC, so keep a warm multiplexed connection.
    // This namespace must remain distinct from the interactive PTY master: a
    // full PTY can otherwise head-of-line block the control request that drains it.
    let control_path = terminal_control_ssh_path_in(&app_home_dir_or_tmp(), host)?;
    ssh_command_with_control_path(host, remote_cmd, Some(&control_path))
}

fn terminal_control_ssh_path_in(home: &Path, host: &HostConfig) -> Result<String, String> {
    // OpenSSH appends a temporary suffix while binding a new master. The
    // ordinary ~/.tmux-worktree/ssh-ctl base is too long on macOS once a
    // config fingerprint and %C are both retained, so use a short dedicated
    // namespace under the existing private runtime root.
    let directory = ssh_control_directory_in(home, "c")?;
    let control_path = terminal_control_ssh_path_for_directory(&directory, host);
    if terminal_control_ssh_bind_path_len(&control_path) > 103 {
        return Err("terminal-control SSH control path exceeds the Unix socket limit".to_string());
    }
    Ok(control_path)
}

fn terminal_control_ssh_path_for_directory(directory: &Path, host: &HostConfig) -> String {
    directory
        .join(format!("2-{}-%C", terminal_control_ssh_fingerprint(host)))
        .to_string_lossy()
        .to_string()
}

fn terminal_control_ssh_bind_path_len(control_path: &str) -> usize {
    // OpenSSH expands %C to its 40-character connection hash (including %j).
    // A new master first binds the expanded path plus "." and 16 random
    // characters before atomically moving the socket into place.
    control_path.len() - "%C".len() + 40 + 17
}

fn terminal_control_ssh_digest(host: &HostConfig, domain: &[u8]) -> Vec<u8> {
    fn field(digest: &mut Sha256, name: &str, value: Option<&str>) {
        digest.update(name.as_bytes());
        digest.update([0]);
        match value {
            Some(value) => {
                digest.update([1]);
                digest.update((value.len() as u64).to_be_bytes());
                digest.update(value.as_bytes());
            }
            None => digest.update([0]),
        }
    }

    let mut digest = Sha256::new();
    digest.update(domain);
    field(&mut digest, "id", Some(&host.id));
    field(&mut digest, "host", Some(&host.host));
    field(&mut digest, "user", host.user.as_deref());
    let port = host.port.map(|port| port.to_string());
    field(&mut digest, "port", port.as_deref());
    field(&mut digest, "identityFile", host.identity_file.as_deref());
    field(&mut digest, "twPath", host.tw_path.as_deref());
    field(&mut digest, "tmuxPath", host.tmux_path.as_deref());
    digest.finalize().to_vec()
}

fn terminal_control_ssh_fingerprint(host: &HostConfig) -> String {
    let digest = terminal_control_ssh_digest(host, b"tmux-worktree/ssh-ctl/v2\0");
    URL_SAFE_NO_PAD.encode(&digest[..6])
}

pub(crate) fn remote_tmux_cmd(host: &HostConfig) -> String {
    remote_path_expr(host.tmux_path.as_deref().unwrap_or("tmux"))
}

pub(crate) fn remote_tw_cmd(host: &HostConfig) -> String {
    remote_path_expr(host.tw_path.as_deref().unwrap_or("tw"))
}

fn has_custom_tmux_path(host: &HostConfig) -> bool {
    host.tmux_path
        .as_deref()
        .is_some_and(|path| !path.trim().is_empty())
}

fn has_custom_tw_path(host: &HostConfig) -> bool {
    host.tw_path
        .as_deref()
        .is_some_and(|path| !path.trim().is_empty())
}

/// Short, bounded human description of a spawned command for timeout/error
/// messages. For ssh/scp the actionable part is the trailing remote command or
/// destination; it is truncated so a large deploy script cannot flood the UI.
fn command_summary(command: &Command) -> String {
    let program = command
        .get_program()
        .to_string_lossy()
        .rsplit('/')
        .next()
        .unwrap_or("remote command")
        .to_string();
    if let Some(tail) = command.get_args().last() {
        let tail = tail.to_string_lossy();
        let tail = tail.trim();
        if !tail.is_empty() {
            let chars = tail.chars().count();
            let mut truncated = tail.chars().take(120).collect::<String>();
            if chars > 120 {
                truncated.push('…');
            }
            return format!("{program} … {truncated}");
        }
    }
    program
}

fn format_hard_timeout(timeout: Duration) -> String {
    let secs = timeout.as_secs();
    if secs >= 60 {
        format!("{}m{:02}s", secs / 60, secs % 60)
    } else if secs > 0 {
        format!("{secs}s")
    } else {
        format!("{}ms", timeout.subsec_millis().max(1))
    }
}

/// Wait for an already-spawned child with a hard wall-clock timeout. The child
/// runs in its own process group (configured by the callers); on timeout the
/// whole local group is SIGKILLed (scp forks an ssh child) and the detached
/// waiter thread — which owns the child — reaps it via `wait_with_output()` as
/// soon as it exits, so there is neither a zombie nor a leaked thread.
fn wait_child_bounded(
    child: Child,
    timeout: Duration,
    summary: String,
) -> Result<std::process::Output, String> {
    let pid = child.id() as i32;
    let (result_tx, result_rx) = mpsc::channel();
    // The waiter owns the child and always reaps it: wait_with_output returns as
    // soon as the child exits (including after our SIGKILL on timeout), so the
    // detached thread terminates promptly. We deliberately do not join it — on
    // success it has already sent and is exiting; on timeout it exits once the
    // killed child has been reaped.
    let spawned = thread::Builder::new()
        .name("tw-remote-cmd-wait".to_string())
        .spawn(move || {
            let _ = result_tx.send(child.wait_with_output());
        });
    if let Err(error) = spawned {
        // Practically impossible (thread creation failure); reap by group.
        unsafe {
            libc::kill(-pid, libc::SIGKILL);
        }
        return Err(format!(
            "start remote command waiter for {summary}: {error}"
        ));
    }
    match result_rx.recv_timeout(timeout) {
        Ok(output_result) => output_result.map_err(|error| format!("wait for {summary}: {error}")),
        Err(mpsc::RecvTimeoutError::Timeout) => {
            // The remote-side command may keep running under a ControlPersist
            // mux master after the local client is killed; deploy stages use a
            // unique `.bundle-stage-<uuid>` name plus atomic mv, so a timeout
            // only abandons one stage directory (see package residuals).
            unsafe {
                libc::kill(-pid, libc::SIGKILL);
            }
            Err(format!(
                "remote command hard timeout after {}: {summary}",
                format_hard_timeout(timeout)
            ))
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            unsafe {
                libc::kill(-pid, libc::SIGKILL);
            }
            Err(format!("remote command waiter disconnected: {summary}"))
        }
    }
}

/// Run `command` to completion bounded by `timeout`. The child is placed in a
/// fresh process group so a timeout SIGKILLs the entire local process tree.
/// std-only (no tokio/async); stdout/stderr are piped and stdin is null,
/// matching `Command::output()`.
pub(crate) fn run_bounded(
    mut command: Command,
    timeout: Duration,
) -> Result<std::process::Output, String> {
    command.process_group(0);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let summary = command_summary(&command);
    let child = command
        .spawn()
        .map_err(|error| format!("spawn {summary}: {error}"))?;
    wait_child_bounded(child, timeout, summary)
}

/// Like [`run_bounded`] but pipes stdin and writes `input` before entering the
/// bounded wait. The stdin handle is dropped (EOF) immediately after writing.
pub(crate) fn run_bounded_with_input(
    mut command: Command,
    input: &[u8],
    timeout: Duration,
) -> Result<std::process::Output, String> {
    command.process_group(0);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let summary = command_summary(&command);
    let mut child = command
        .spawn()
        .map_err(|error| format!("spawn {summary}: {error}"))?;
    let write_result = child
        .stdin
        .take()
        .ok_or_else(|| format!("{summary}: stdin unavailable"))
        .and_then(|mut stdin| {
            stdin
                .write_all(input)
                .map_err(|error| format!("write {summary} stdin: {error}"))
        });
    if let Err(error) = write_result {
        let pid = child.id() as i32;
        unsafe {
            libc::kill(-pid, libc::SIGKILL);
        }
        let _ = child.wait();
        return Err(error);
    }
    // The taken stdin handle was dropped at the end of the closure above, so
    // the remote process sees EOF before we wait.
    wait_child_bounded(child, timeout, summary)
}

/// Run a command on a remote host and return stdout, bounded by the default
/// probe/check budget.
pub(crate) fn run_remote_cmd_output(
    host: &HostConfig,
    remote_cmd: &[&str],
) -> Result<std::process::Output, String> {
    run_remote_cmd_output_with_timeout(host, remote_cmd, REMOTE_CMD_CHECK_TIMEOUT)
}

/// Same as [`run_remote_cmd_output`] with an explicit hard-timeout budget for
/// long-running remote operations (remote git, worktree cleanup).
pub(crate) fn run_remote_cmd_output_with_timeout(
    host: &HostConfig,
    remote_cmd: &[&str],
    timeout: Duration,
) -> Result<std::process::Output, String> {
    run_bounded(ssh_command(host, remote_cmd)?, timeout)
}

pub(crate) fn run_remote_cmd_with_input(
    host: &HostConfig,
    remote_cmd: &[&str],
    input: &[u8],
) -> Result<std::process::Output, String> {
    run_bounded_with_input(
        ssh_command(host, remote_cmd)?,
        input,
        REMOTE_CMD_CHECK_TIMEOUT,
    )
}

struct TerminalControlProxyWriteRequest {
    frame: Vec<u8>,
    completion: mpsc::SyncSender<Result<(), String>>,
}

#[derive(Default)]
struct TerminalControlProxyReadState {
    expected_request_id: Option<String>,
    response: Option<Vec<u8>>,
    failure: Option<String>,
}

type SharedTerminalControlProxyReadState = Arc<(Mutex<TerminalControlProxyReadState>, Condvar)>;

fn validate_proxy_request_frame(frame: &[u8], max_frame_bytes: usize) -> Result<(), String> {
    if frame.is_empty()
        || frame.len() > max_frame_bytes
        || !frame.ends_with(b"\n")
        || frame[..frame.len().saturating_sub(1)].contains(&b'\n')
    {
        return Err("terminal-control proxy request is not one bounded JSON line".to_string());
    }
    Ok(())
}

fn proxy_stdin_writer(
    mut stdin: ChildStdin,
    requests: mpsc::Receiver<TerminalControlProxyWriteRequest>,
    max_frame_bytes: usize,
) {
    while let Ok(request) = requests.recv() {
        let result = (|| {
            validate_proxy_request_frame(&request.frame, max_frame_bytes)?;
            stdin
                .write_all(&request.frame)
                .and_then(|_| stdin.flush())
                .map_err(|error| format!("write terminal-control proxy request: {error}"))
        })();
        let failed = result.is_err();
        if request.completion.send(result).is_err() || failed {
            break;
        }
    }
}

fn fail_proxy_read_state(state: &SharedTerminalControlProxyReadState, message: String) {
    let (state, changed) = &**state;
    let mut state = state.lock().unwrap();
    if state.failure.is_none() {
        state.failure = Some(message);
    }
    state.expected_request_id = None;
    // A complete, correlated response already determines the in-flight
    // request. Preserve it if EOF or an extra frame arrives immediately
    // afterwards; the failure poisons the channel for the next request.
    changed.notify_all();
}

fn take_proxy_read_outcome(
    state: &mut TerminalControlProxyReadState,
) -> Option<Result<Vec<u8>, String>> {
    if let Some(response) = state.response.take() {
        return Some(Ok(response));
    }
    state.failure.clone().map(Err)
}

fn proxy_stdout_reader(
    stdout: ChildStdout,
    state: SharedTerminalControlProxyReadState,
    max_frame_bytes: usize,
) {
    let mut stdout = BufReader::new(stdout);
    loop {
        let mut response = Vec::new();
        let read = stdout
            .by_ref()
            .take(max_frame_bytes.saturating_add(1) as u64)
            .read_until(b'\n', &mut response);
        if let Err(error) = read {
            fail_proxy_read_state(
                &state,
                format!("read terminal-control proxy response: {error}"),
            );
            break;
        }
        if response.is_empty() {
            fail_proxy_read_state(
                &state,
                "terminal-control proxy closed without a response".to_string(),
            );
            break;
        }
        if response.len() > max_frame_bytes || !response.ends_with(b"\n") {
            fail_proxy_read_state(
                &state,
                "terminal-control proxy closed or returned an oversized partial frame".to_string(),
            );
            break;
        }
        let request_id = serde_json::from_slice::<serde_json::Value>(&response)
            .ok()
            .and_then(|value| {
                value
                    .get("requestId")
                    .and_then(|request_id| request_id.as_str())
                    .map(str::to_string)
            });
        let Some(request_id) = request_id else {
            fail_proxy_read_state(
                &state,
                "terminal-control proxy returned an invalid response frame".to_string(),
            );
            break;
        };

        let (read_state, changed) = &*state;
        let mut read_state = read_state.lock().unwrap();
        let expected = read_state.expected_request_id.as_deref();
        if expected != Some(request_id.as_str()) {
            let message = if expected.is_some() {
                "terminal-control proxy response requestId mismatch"
            } else {
                "terminal-control proxy returned unsolicited extra output"
            };
            read_state.failure = Some(message.to_string());
            read_state.expected_request_id = None;
            // Do not revoke a complete response for the preceding request.
            // This failure remains as a poison marker for the next preflight.
            changed.notify_all();
            break;
        }
        read_state.expected_request_id = None;
        read_state.response = Some(response);
        changed.notify_all();
    }
}

pub(crate) struct RemoteTerminalControlProxy {
    child: Option<Child>,
    writes: Option<mpsc::Sender<TerminalControlProxyWriteRequest>>,
    writer: Option<JoinHandle<()>>,
    reader: Option<JoinHandle<()>>,
    read_state: SharedTerminalControlProxyReadState,
    max_frame_bytes: usize,
}

impl RemoteTerminalControlProxy {
    fn preflight_failure(&mut self) -> Option<String> {
        let child_failure = match self.child.as_mut() {
            Some(child) => match child.try_wait() {
                Ok(Some(status)) => Some(format!(
                    "terminal-control proxy exited before request: {status}"
                )),
                Ok(None) => None,
                Err(error) => Some(format!("inspect terminal-control proxy: {error}")),
            },
            None => Some("terminal-control proxy is not running".to_string()),
        };
        if child_failure.is_some() {
            return child_failure;
        }
        let (state, _) = &*self.read_state;
        let state = state.lock().unwrap();
        state.failure.clone().or_else(|| {
            (state.expected_request_id.is_some() || state.response.is_some())
                .then(|| "terminal-control proxy response lane is not idle".to_string())
        })
    }

    pub(crate) fn is_usable(&mut self) -> bool {
        if self.preflight_failure().is_none() {
            return true;
        }
        self.terminate();
        false
    }

    pub(crate) fn request(
        &mut self,
        frame: &[u8],
        expected_request_id: &str,
        timeout: Duration,
    ) -> Result<Vec<u8>, String> {
        let deadline = Instant::now() + timeout;
        if let Err(error) = validate_proxy_request_frame(frame, self.max_frame_bytes) {
            self.terminate();
            return Err(error);
        }
        if expected_request_id.is_empty() || expected_request_id.len() > 128 {
            self.terminate();
            return Err("terminal-control proxy expected requestId is invalid".to_string());
        }
        if let Some(error) = self.preflight_failure() {
            self.terminate();
            return Err(error);
        }
        {
            let (state, _) = &*self.read_state;
            let mut state = state.lock().unwrap();
            state.expected_request_id = Some(expected_request_id.to_string());
        }

        let timeout_error = || {
            format!(
                "terminal-control proxy hard timeout after {} ms",
                timeout.as_millis()
            )
        };
        let (completion_tx, completion_rx) = mpsc::sync_channel(1);
        let Some(writes) = self.writes.as_ref() else {
            self.terminate();
            return Err("terminal-control proxy request lane is closed".to_string());
        };
        if writes
            .send(TerminalControlProxyWriteRequest {
                frame: frame.to_vec(),
                completion: completion_tx,
            })
            .is_err()
        {
            self.terminate();
            return Err("terminal-control proxy request lane disconnected".to_string());
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            self.terminate();
            return Err(timeout_error());
        }
        match completion_rx.recv_timeout(remaining) {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                self.terminate();
                return Err(error);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                self.terminate();
                return Err(timeout_error());
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                self.terminate();
                return Err(
                    "terminal-control proxy request completion lane disconnected".to_string(),
                );
            }
        }

        let read_state = Arc::clone(&self.read_state);
        let (state, changed) = &*read_state;
        let mut state = state.lock().unwrap();
        loop {
            if let Some(outcome) = take_proxy_read_outcome(&mut state) {
                drop(state);
                return match outcome {
                    Ok(response) => Ok(response),
                    Err(error) => {
                        self.terminate();
                        Err(error)
                    }
                };
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                drop(state);
                self.terminate();
                return Err(timeout_error());
            }
            let (next_state, wait) = changed.wait_timeout(state, remaining).unwrap();
            state = next_state;
            if wait.timed_out() && state.response.is_none() && state.failure.is_none() {
                drop(state);
                self.terminate();
                return Err(timeout_error());
            }
        }
    }

    pub(crate) fn terminate(&mut self) {
        self.writes.take();
        if let Some(child) = self.child.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        self.child.take();
        if let Some(writer) = self.writer.take() {
            let _ = writer.join();
        }
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }

    #[cfg(test)]
    fn child_id(&self) -> Option<u32> {
        self.child.as_ref().map(Child::id)
    }
}

impl Drop for RemoteTerminalControlProxy {
    fn drop(&mut self) {
        self.terminate();
    }
}

fn spawn_terminal_control_proxy(
    mut command: Command,
    max_frame_bytes: usize,
) -> Result<RemoteTerminalControlProxy, String> {
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        // Proxy stderr is intentionally bounded to zero. Inheriting or piping
        // it could either leak remote diagnostics or block a long-lived child
        // once an unread pipe fills.
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("spawn terminal-control proxy: {error}"))?;
    let stdin = child.stdin.take().ok_or_else(|| {
        let _ = child.kill();
        let _ = child.wait();
        "terminal-control proxy stdin unavailable".to_string()
    })?;
    let stdout = child.stdout.take().ok_or_else(|| {
        let _ = child.kill();
        let _ = child.wait();
        "terminal-control proxy stdout unavailable".to_string()
    })?;
    let (writes_tx, writes_rx) = mpsc::channel();
    let writer = thread::Builder::new()
        .name("tw-ssh-control-proxy-writer".to_string())
        .spawn(move || proxy_stdin_writer(stdin, writes_rx, max_frame_bytes))
        .map_err(|error| {
            let _ = child.kill();
            let _ = child.wait();
            format!("start terminal-control proxy writer: {error}")
        })?;
    let read_state = Arc::new((
        Mutex::new(TerminalControlProxyReadState::default()),
        Condvar::new(),
    ));
    let reader_state = Arc::clone(&read_state);
    let reader = match thread::Builder::new()
        .name("tw-ssh-control-proxy-reader".to_string())
        .spawn(move || proxy_stdout_reader(stdout, reader_state, max_frame_bytes))
    {
        Ok(reader) => reader,
        Err(error) => {
            drop(writes_tx);
            let _ = child.kill();
            let _ = child.wait();
            let _ = writer.join();
            return Err(format!("start terminal-control proxy reader: {error}"));
        }
    };
    Ok(RemoteTerminalControlProxy {
        child: Some(child),
        writes: Some(writes_tx),
        writer: Some(writer),
        reader: Some(reader),
        read_state,
        max_frame_bytes,
    })
}

/// Start one long-lived terminal-control channel over the dedicated SSH master.
/// Requests are framed and serialized by `RemoteTerminalControlProxy`; callers
/// must discard it after any timeout, EOF, or invalid response and never replay.
pub(crate) fn spawn_remote_terminal_control_proxy(
    host: &HostConfig,
    remote_cmd: &[&str],
    max_frame_bytes: usize,
) -> Result<RemoteTerminalControlProxy, String> {
    let command = terminal_control_ssh_command(host, remote_cmd)?;
    spawn_terminal_control_proxy(command, max_frame_bytes)
}

pub(crate) fn run_remote_cmd_check(
    host: &HostConfig,
    remote_cmd: &[&str],
) -> Result<String, String> {
    run_remote_cmd_check_with_timeout(host, remote_cmd, REMOTE_CMD_CHECK_TIMEOUT)
}

/// Same as [`run_remote_cmd_check`] with an explicit hard-timeout budget for
/// long-running remote operations (e.g. source install: clone + npm install +
/// build).
pub(crate) fn run_remote_cmd_check_with_timeout(
    host: &HostConfig,
    remote_cmd: &[&str],
    timeout: Duration,
) -> Result<String, String> {
    let output = run_remote_cmd_output_with_timeout(host, remote_cmd, timeout)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ssh on {} failed: {}", host.label, stderr.trim()));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

pub(crate) fn run_remote_cmd_check_strings(
    host: &HostConfig,
    remote_cmd: &[String],
) -> Result<String, String> {
    let refs = remote_cmd.iter().map(String::as_str).collect::<Vec<_>>();
    run_remote_cmd_check(host, &refs)
}

/// Run a tw subcommand on a remote host and return stdout.
pub(crate) fn run_remote_tw_check(host: &HostConfig, tw_args: &[&str]) -> Result<String, String> {
    if !has_custom_tmux_path(host) && !has_custom_tw_path(host) {
        let mut full_args = Vec::with_capacity(tw_args.len() + 1);
        full_args.push("tw");
        full_args.extend_from_slice(tw_args);
        return run_remote_cmd_check(host, &full_args);
    }

    let mut command = String::new();
    if has_custom_tmux_path(host) {
        command.push_str("TW_TMUX=");
        command.push_str(&remote_tmux_cmd(host));
        command.push(' ');
    }
    command.push_str(&remote_tw_cmd(host));
    for arg in tw_args {
        command.push(' ');
        command.push_str(&shell_quote(arg));
    }
    run_remote_cmd_check(host, &["sh", "-c", &command])
}

/// Run a tmux subcommand on a remote host and return stdout.
pub(crate) fn run_remote_tmux_check(
    host: &HostConfig,
    tmux_args: &[&str],
) -> Result<String, String> {
    if !has_custom_tmux_path(host) {
        let mut full_args = Vec::with_capacity(tmux_args.len() + 1);
        full_args.push("tmux");
        full_args.extend_from_slice(tmux_args);
        return run_remote_cmd_check(host, &full_args);
    }

    let mut command = remote_tmux_cmd(host);
    for arg in tmux_args {
        command.push(' ');
        command.push_str(&shell_quote(arg));
    }
    run_remote_cmd_check(host, &["sh", "-c", &command])
}

pub(crate) fn run_remote_tmux_output(
    host: &HostConfig,
    tmux_args: &[&str],
) -> Result<std::process::Output, String> {
    if !has_custom_tmux_path(host) {
        let mut full_args = Vec::with_capacity(tmux_args.len() + 1);
        full_args.push("tmux");
        full_args.extend_from_slice(tmux_args);
        return run_remote_cmd_output(host, &full_args);
    }

    let mut command = remote_tmux_cmd(host);
    for arg in tmux_args {
        command.push(' ');
        command.push_str(&shell_quote(arg));
    }
    run_remote_cmd_output(host, &["sh", "-c", &command])
}

/// Quiet variant that returns None on failure.
pub(crate) fn run_remote_tmux_quiet(host: &HostConfig, tmux_args: &[&str]) -> Option<String> {
    run_remote_tmux_check(host, tmux_args).ok()
}

pub(crate) fn remote_home_dir_for_host(host: &HostConfig) -> Result<String, String> {
    let home = run_remote_cmd_check(
        host,
        &[
            "sh",
            "-c",
            "cd \"${HOME:-.}\" 2>/dev/null && pwd -P || printf %s \"${HOME:-/}\"",
        ],
    )
    .map_err(|error| format!("read remote home on {}: {error}", host.label))?;
    let home = home.trim();
    if home.is_empty() {
        return Err(format!("remote home on {} is empty", host.label));
    }
    Ok(home.to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        run_bounded, run_bounded_with_input, spawn_terminal_control_proxy,
        ssh_command_with_control_path, ssh_control_path_in, take_proxy_read_outcome,
        terminal_control_ssh_bind_path_len, terminal_control_ssh_digest,
        terminal_control_ssh_fingerprint, terminal_control_ssh_path_for_directory,
        terminal_control_ssh_path_in, TerminalControlProxyReadState, REMOTE_CMD_CHECK_TIMEOUT,
        REMOTE_CMD_REMOTE_INSTALL_TIMEOUT,
    };
    use crate::remote::HostConfig;
    use std::os::unix::net::UnixListener;
    use std::path::Path;
    use std::process::Command;
    use std::time::{Duration, Instant};

    fn host() -> HostConfig {
        HostConfig {
            id: "dev".to_string(),
            label: "Dev".to_string(),
            host: "devbox".to_string(),
            user: Some("alice".to_string()),
            port: None,
            identity_file: None,
            worktree_base: None,
            tmux_path: None,
            tw_path: None,
        }
    }

    fn proxy_frame(request_id: &str) -> Vec<u8> {
        let mut frame = serde_json::to_vec(&serde_json::json!({
            "requestId": request_id,
            "payload": "test",
        }))
        .expect("encode proxy frame");
        frame.push(b'\n');
        frame
    }

    #[test]
    fn terminal_control_uses_a_distinct_persistent_multiplex_namespace() {
        let temp = tempfile::Builder::new()
            .prefix("twc")
            .tempdir_in("/tmp")
            .expect("short tempdir");
        let interactive = ssh_control_path_in(temp.path(), "ssh").expect("interactive path");
        let control = terminal_control_ssh_path_in(temp.path(), &host()).expect("control path");
        assert_ne!(interactive, control);
        assert!(interactive.ends_with("/.tmux-worktree/ssh/%C"));
        assert!(control.contains("/.tmux-worktree/c/"));
        assert!(control.ends_with(&format!(
            "/2-{}-%C",
            terminal_control_ssh_fingerprint(&host())
        )));
        assert_eq!(terminal_control_ssh_fingerprint(&host()).len(), 8);

        let mut other_identity = host();
        other_identity.identity_file = Some("~/.ssh/another-key".to_string());
        assert_ne!(
            terminal_control_ssh_fingerprint(&host()),
            terminal_control_ssh_fingerprint(&other_identity),
            "identity changes must not reuse an authenticated control master"
        );

        let command = ssh_command_with_control_path(&host(), &["true"], Some(&control))
            .expect("control ssh command");
        let args = command
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect::<Vec<_>>();
        assert!(args.iter().any(|arg| arg == "ControlMaster=auto"));
        assert!(args.iter().any(|arg| arg == "ControlPersist=600"));
        assert!(args
            .iter()
            .any(|arg| arg == &format!("ControlPath={control}")));
        assert!(!args.iter().any(|arg| arg == "ControlMaster=no"));
    }

    #[test]
    fn terminal_control_path_avoids_legacy_directory_and_fits_real_home() {
        // Other tests mutate HOME for the duration of their assertions; take
        // the shared env lock so dirs::home_dir() observes the restored value.
        let _guard = crate::tests::test_env_lock().lock().expect("test env lock");
        let temp = tempfile::Builder::new()
            .prefix("twc")
            .tempdir_in("/tmp")
            .expect("short tempdir");
        let legacy_directory_root = temp.path().join(".tmux-worktree").join("ssh-ctl");
        let legacy_fingerprint =
            terminal_control_ssh_digest(&host(), b"tmux-worktree/ssh-ctl/v1\0")
                .iter()
                .take(16)
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>();
        let legacy_directory = legacy_directory_root.join(legacy_fingerprint);
        std::fs::create_dir_all(&legacy_directory).expect("legacy control directory");

        let control = terminal_control_ssh_path_in(temp.path(), &host()).expect("v2 control path");
        assert!(control.contains("/.tmux-worktree/c/2-"));
        assert!(!Path::new(&control).starts_with(&legacy_directory));
        let temporary_bind_path = format!(
            "{}.{}",
            control.replace("%C", &"c".repeat(40)),
            "r".repeat(16)
        );
        let listener = UnixListener::bind(&temporary_bind_path)
            .expect("legacy directory must not prevent opening the v2 control socket");
        drop(listener);

        let actual_directory = dirs::home_dir()
            .expect("home dir for control path length test")
            .join(".tmux-worktree")
            .join("c");
        let actual = terminal_control_ssh_path_for_directory(&actual_directory, &host());
        assert!(
            terminal_control_ssh_bind_path_len(&actual) <= 103,
            "temporary ControlPath bind is too long for the actual home: {actual}"
        );
    }

    #[test]
    fn terminal_control_proxy_complete_response_wins_over_later_failure() {
        let response = b"{\"requestId\":\"first-request\",\"ok\":true}\n".to_vec();
        let mut state = TerminalControlProxyReadState {
            expected_request_id: None,
            response: Some(response.clone()),
            failure: Some("terminal-control proxy closed without a response".to_string()),
        };
        assert_eq!(take_proxy_read_outcome(&mut state), Some(Ok(response)));
        assert_eq!(
            take_proxy_read_outcome(&mut state),
            Some(Err(
                "terminal-control proxy closed without a response".to_string()
            ))
        );
    }

    #[test]
    fn terminal_control_proxy_reuses_one_child_for_multiple_frames() {
        let command = Command::new("/bin/cat");
        let mut proxy = spawn_terminal_control_proxy(command, 1024).expect("spawn proxy");
        let child_id = proxy.child_id().expect("proxy child");
        let first = proxy_frame("first-request");
        assert_eq!(
            proxy
                .request(&first, "first-request", Duration::from_secs(1))
                .expect("first response"),
            first
        );
        let second = proxy_frame("second-request");
        assert_eq!(
            proxy
                .request(&second, "second-request", Duration::from_secs(1))
                .expect("second response"),
            second
        );
        assert_eq!(proxy.child_id(), Some(child_id));
    }

    #[test]
    fn terminal_control_proxy_timeout_terminates_the_channel_without_replay() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "IFS= read -r first; IFS= read -r second"]);
        let mut proxy = spawn_terminal_control_proxy(command, 1024).expect("spawn proxy");
        let started = Instant::now();
        let request = proxy_frame("timeout-request");
        let error = proxy
            .request(&request, "timeout-request", Duration::from_millis(50))
            .expect_err("proxy must time out");
        assert!(error.contains("hard timeout after 50 ms"), "{error}");
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_eq!(proxy.child_id(), None);
        let replay = proxy_frame("must-not-replay");
        assert!(proxy
            .request(&replay, "must-not-replay", Duration::from_millis(50))
            .unwrap_err()
            .contains("not running"));
    }

    #[test]
    fn terminal_control_proxy_eof_invalidates_the_channel() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "exit 0"]);
        let mut proxy = spawn_terminal_control_proxy(command, 1024).expect("spawn proxy");
        let request = proxy_frame("eof-request");
        let error = proxy
            .request(&request, "eof-request", Duration::from_secs(1))
            .expect_err("closed proxy must fail");
        assert!(
            error.contains("closed")
                || error.contains("exited")
                || error.contains("write terminal-control proxy"),
            "{error}"
        );
        assert_eq!(proxy.child_id(), None);
    }

    #[test]
    fn terminal_control_proxy_rejects_delayed_extra_output_before_the_next_write() {
        let temp = tempfile::tempdir().expect("tempdir");
        let marker = temp.path().join("second-request-written");
        let mut command = Command::new("/bin/sh");
        command.args([
            "-c",
            "IFS= read -r first; printf '{\"requestId\":\"first-request\",\"ok\":true}\\n'; sleep 0.05; printf '{\"requestId\":\"stale-extra\",\"ok\":true}\\n'; if IFS= read -r second; then printf written > \"$1\"; fi",
            "proxy-extra-test",
            marker.to_str().expect("marker path"),
        ]);
        let mut proxy = spawn_terminal_control_proxy(command, 1024).expect("spawn proxy");
        let first = proxy_frame("first-request");
        assert_eq!(
            proxy
                .request(&first, "first-request", Duration::from_secs(1))
                .expect("correlated response before delayed extra output"),
            b"{\"requestId\":\"first-request\",\"ok\":true}\n"
        );
        std::thread::sleep(Duration::from_millis(100));
        let second = proxy_frame("second-request");
        let error = proxy
            .request(&second, "second-request", Duration::from_secs(1))
            .expect_err("delayed extra output must invalidate the proxy before another write");
        assert!(error.contains("unsolicited extra output"), "{error}");
        assert_eq!(proxy.child_id(), None);
        assert!(
            !marker.exists(),
            "the second request reached the poisoned child"
        );
    }

    #[test]
    fn terminal_control_proxy_does_not_reuse_a_child_after_response_then_eof() {
        let mut command = Command::new("/bin/sh");
        command.args([
            "-c",
            "IFS= read -r first; printf '{\"requestId\":\"first-request\",\"ok\":true}\\n'",
        ]);
        let mut proxy = spawn_terminal_control_proxy(command, 1024).expect("spawn proxy");
        let first = proxy_frame("first-request");
        assert_eq!(
            proxy
                .request(&first, "first-request", Duration::from_secs(1))
                .expect("complete response must win over the following EOF"),
            b"{\"requestId\":\"first-request\",\"ok\":true}\n"
        );
        std::thread::sleep(Duration::from_millis(50));
        let second = proxy_frame("second-request");
        let error = proxy
            .request(&second, "second-request", Duration::from_secs(1))
            .expect_err("idle EOF must poison the proxy before the next request");
        assert!(
            error.contains("closed") || error.contains("exited"),
            "{error}"
        );
        assert_eq!(proxy.child_id(), None);
    }

    #[test]
    fn terminal_control_proxy_stderr_cannot_apply_pipe_backpressure() {
        let mut command = Command::new("/bin/sh");
        command.args([
            "-c",
            "IFS= read -r request; i=0; while [ $i -lt 10000 ]; do printf 'bounded-stderr-padding-0123456789\\n' >&2; i=$((i + 1)); done; printf '{\"requestId\":\"stderr-request\",\"ok\":true}\\n'",
        ]);
        let mut proxy = spawn_terminal_control_proxy(command, 1024).expect("spawn proxy");
        let request = proxy_frame("stderr-request");
        assert_eq!(
            proxy
                .request(&request, "stderr-request", Duration::from_secs(2))
                .expect("discarded stderr must not block the response"),
            b"{\"requestId\":\"stderr-request\",\"ok\":true}\n"
        );
    }

    #[test]
    fn run_bounded_hard_timeout_kills_the_child_process_group() {
        // The command records its own pid (group leader) then execs a long
        // sleep. A 200ms budget must return a hard-timeout error promptly and
        // SIGKILL the whole process group — verifiable because the leader is
        // reaped (kill -0 -> ESRCH) shortly afterwards.
        let temp = tempfile::tempdir().expect("tempdir");
        let pid_file = temp.path().join("child.pid");
        let mut command = Command::new("/bin/sh");
        command.args([
            "-c",
            "echo $$ > \"$1\"; exec sleep 1000",
            "sh",
            pid_file.to_str().expect("pid file path"),
        ]);
        let started = Instant::now();
        let error = run_bounded(command, Duration::from_millis(200))
            .expect_err("a wedged remote command must time out");
        let elapsed = started.elapsed();
        assert!(error.contains("hard timeout"), "{error}");
        assert!(
            elapsed < Duration::from_secs(2),
            "timeout did not fire near the budget: {elapsed:?}"
        );

        let pid: i32 = std::fs::read_to_string(&pid_file)
            .expect("pid file written before sleep")
            .trim()
            .parse()
            .expect("numeric pid");
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let gone = unsafe { libc::kill(pid, 0) } != 0;
            if gone {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "timed-out child process group {pid} was not killed and reaped"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn run_bounded_returns_output_for_a_fast_command() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "echo hello-bounded"]);
        let output = run_bounded(command, Duration::from_secs(5)).expect("echo must succeed");
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8_lossy(&output.stdout).trim(),
            "hello-bounded"
        );
    }

    #[test]
    fn run_bounded_with_input_writes_stdin_then_returns_output() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "cat"]);
        let output = run_bounded_with_input(command, b"piped-bytes", Duration::from_secs(5))
            .expect("cat must succeed");
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8_lossy(&output.stdout).trim(),
            "piped-bytes"
        );
    }

    #[test]
    fn remote_source_install_budget_dwarfs_the_probe_default() {
        // install_host_tw_from_source runs git clone + npm install + npm run
        // build on the remote host (2-10 min cold/loaded); it must never ride
        // the 120s probe/check default or a slow-but-successful install is
        // killed deterministically.
        assert!(
            REMOTE_CMD_REMOTE_INSTALL_TIMEOUT >= Duration::from_secs(10 * 60),
            "remote source-install budget must be minutes, got {:?}",
            REMOTE_CMD_REMOTE_INSTALL_TIMEOUT
        );
        assert!(REMOTE_CMD_REMOTE_INSTALL_TIMEOUT > REMOTE_CMD_CHECK_TIMEOUT);
    }
}
