use crate::PlatformStoreFailure;
use std::collections::HashMap;
use std::fmt;
use std::ops::{Deref, DerefMut};
#[cfg(test)]
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

const OPENING: u8 = 1;
const OPEN: u8 = 2;
const CLOSING: u8 = 3;
const CLOSE_UNCERTAIN: u8 = 4;
const CLOSED_PROVEN: u8 = 5;

static PROCESS_ORIGIN_PID: AtomicU32 = AtomicU32::new(0);
static PROCESS_REGISTRY: OnceLock<Arc<ProcessRegistry>> = OnceLock::new();

type PidSource = Arc<dyn Fn() -> u32 + Send + Sync>;

/// Identity of the already verified native account-home directory.
///
/// Construction does not perform verification. A future platform adapter may
/// construct this token only after completing the contract's native account,
/// no-follow traversal, owner, mode, ACL, and stable-identity proof.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct VerifiedHomeIdentity {
    device: u64,
    inode: u64,
}

impl VerifiedHomeIdentity {
    pub const fn new(device: u64, inode: u64) -> Self {
        Self { device, inode }
    }

    pub const fn device(&self) -> u64 {
        self.device
    }

    pub const fn inode(&self) -> u64 {
        self.inode
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum LogicalStoreKind {
    RelayV2BrokerCredentialStateStoreV1,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct RegistryKey {
    home: VerifiedHomeIdentity,
    kind: LogicalStoreKind,
}

#[derive(Clone)]
struct ProcessFence {
    opener_pid: u32,
    current_pid: PidSource,
}

impl ProcessFence {
    fn check(&self) -> Result<(), PlatformStoreFailure> {
        if (self.current_pid)() == self.opener_pid {
            Ok(())
        } else {
            Err(PlatformStoreFailure::Closed)
        }
    }
}

struct EntryFence {
    process: ProcessFence,
    registry_poisoned: Arc<AtomicBool>,
    phase: AtomicU8,
}

impl EntryFence {
    fn check_process(&self) -> Result<(), PlatformStoreFailure> {
        self.process.check()
    }

    fn check_operational(&self) -> Result<(), PlatformStoreFailure> {
        self.check_process()?;
        if self.registry_poisoned.load(Ordering::Acquire) {
            return Err(PlatformStoreFailure::Closed);
        }
        match self.phase.load(Ordering::Acquire) {
            OPENING | OPEN | CLOSING => Ok(()),
            CLOSE_UNCERTAIN | CLOSED_PROVEN | _ => Err(PlatformStoreFailure::Closed),
        }
    }

    fn set_phase(&self, phase: u8) {
        self.phase.store(phase, Ordering::Release);
    }
}

/// Lock-free process/phase fence passed to the sole descriptor owner.
///
/// Platform code must call [`Self::check`] immediately before every descriptor
/// syscall. Platform-common also checks it before and after every N1-initiated
/// descriptor operation, so this token is an additional platform-side fence,
/// not the only one.
#[derive(Clone)]
pub struct DescriptorOperationFence {
    inner: Arc<EntryFence>,
}

impl DescriptorOperationFence {
    pub fn check(&self) -> Result<(), PlatformStoreFailure> {
        self.inner.check_operational()
    }
}

impl fmt::Debug for DescriptorOperationFence {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("DescriptorOperationFence(<opaque>)")
    }
}

/// Typed fence for the one common-owned final-close attempt.
///
/// Registry poison must stop every further data operation, but it must not
/// prevent the parent process from attempting to release its sole descriptor
/// and process-owned kernel lock. Only platform-common can construct this
/// token, after it has stopped admission and entered its close path. Platform
/// code must check it immediately before the raw close syscall.
pub struct FinalCloseOperationFence {
    process: ProcessFence,
}

impl FinalCloseOperationFence {
    pub fn check(&self) -> Result<(), PlatformStoreFailure> {
        self.process.check()
    }
}

impl fmt::Debug for FinalCloseOperationFence {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("FinalCloseOperationFence(<opaque>)")
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RegistryPhase {
    Opening,
    Open,
    Closing,
    CloseUncertain,
}

struct RegistryEntry {
    token: u64,
    opener_pid: u32,
    phase: RegistryPhase,
    fence: Arc<EntryFence>,
}

struct ProcessRegistry {
    entries: Mutex<HashMap<RegistryKey, RegistryEntry>>,
    poisoned: Arc<AtomicBool>,
    next_token: AtomicU64,
    #[cfg(test)]
    boundary_entries: AtomicUsize,
}

struct RegistryGuard<'a> {
    guard: MutexGuard<'a, HashMap<RegistryKey, RegistryEntry>>,
    poisoned: &'a AtomicBool,
    panicking_at_acquire: bool,
}

impl Deref for RegistryGuard<'_> {
    type Target = HashMap<RegistryKey, RegistryEntry>;

    fn deref(&self) -> &Self::Target {
        &self.guard
    }
}

impl DerefMut for RegistryGuard<'_> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.guard
    }
}

impl Drop for RegistryGuard<'_> {
    fn drop(&mut self) {
        // Publish the permanent fail-closed signal while the registry mutex is
        // still held. Descriptor/public fences therefore close immediately on
        // unwind, without waiting for a later lock attempt to observe poison.
        if !self.panicking_at_acquire && std::thread::panicking() {
            self.poisoned.store(true, Ordering::Release);
        }
    }
}

impl ProcessRegistry {
    fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            poisoned: Arc::new(AtomicBool::new(false)),
            next_token: AtomicU64::new(1),
            #[cfg(test)]
            boundary_entries: AtomicUsize::new(0),
        }
    }

    fn lock_entries(&self) -> Result<RegistryGuard<'_>, PlatformStoreFailure> {
        #[cfg(test)]
        self.boundary_entries.fetch_add(1, Ordering::Relaxed);
        if self.poisoned.load(Ordering::Acquire) {
            return Err(PlatformStoreFailure::Closed);
        }
        let panicking_at_acquire = std::thread::panicking();
        match self.entries.lock() {
            Ok(entries) => Ok(RegistryGuard {
                guard: entries,
                poisoned: &self.poisoned,
                panicking_at_acquire,
            }),
            Err(_) => {
                self.poisoned.store(true, Ordering::Release);
                Err(PlatformStoreFailure::Closed)
            }
        }
    }

    fn reserve(
        self: &Arc<Self>,
        home: VerifiedHomeIdentity,
        process: ProcessFence,
    ) -> Result<LifecycleHandle, PlatformStoreFailure> {
        process.check()?;
        let key = RegistryKey {
            home,
            kind: LogicalStoreKind::RelayV2BrokerCredentialStateStoreV1,
        };
        let mut entries = self.lock_entries()?;
        if let Some(entry) = entries.get(&key) {
            return match entry.phase {
                RegistryPhase::Opening | RegistryPhase::Open | RegistryPhase::Closing => {
                    Err(PlatformStoreFailure::Busy)
                }
                RegistryPhase::CloseUncertain => Err(PlatformStoreFailure::Closed),
            };
        }

        let token = self.next_token.fetch_add(1, Ordering::Relaxed);
        if token == 0 {
            self.poisoned.store(true, Ordering::Release);
            return Err(PlatformStoreFailure::Closed);
        }
        let fence = Arc::new(EntryFence {
            process: process.clone(),
            registry_poisoned: Arc::clone(&self.poisoned),
            phase: AtomicU8::new(OPENING),
        });
        entries.insert(
            key,
            RegistryEntry {
                token,
                opener_pid: process.opener_pid,
                phase: RegistryPhase::Opening,
                fence: Arc::clone(&fence),
            },
        );
        drop(entries);
        Ok(LifecycleHandle {
            registry: Arc::clone(self),
            key,
            token,
            fence,
        })
    }
}

/// Unique registry lease shared only inside platform-common's typestates and
/// opaque wrappers. The token prevents an old finalizer from changing a newer
/// entry after a proven successful close and reopen.
#[derive(Clone)]
pub(crate) struct LifecycleHandle {
    registry: Arc<ProcessRegistry>,
    key: RegistryKey,
    token: u64,
    fence: Arc<EntryFence>,
}

impl LifecycleHandle {
    pub(crate) fn descriptor_fence(&self) -> DescriptorOperationFence {
        DescriptorOperationFence {
            inner: Arc::clone(&self.fence),
        }
    }

    pub(crate) fn final_close_fence(&self) -> FinalCloseOperationFence {
        FinalCloseOperationFence {
            process: self.fence.process.clone(),
        }
    }

    pub(crate) fn check_process(&self) -> Result<(), PlatformStoreFailure> {
        self.fence.check_process()
    }

    pub(crate) fn check_operational(&self) -> Result<(), PlatformStoreFailure> {
        self.fence.check_operational()
    }

    pub(crate) fn opener_pid(&self) -> u32 {
        self.fence.process.opener_pid
    }

    pub(crate) fn release_proven_no_descriptor(&self) -> Result<(), PlatformStoreFailure> {
        self.check_process()?;
        let mut entries = self.registry.lock_entries()?;
        let removable = entries.get(&self.key).is_some_and(|entry| {
            entry.token == self.token
                && entry.opener_pid == self.fence.process.opener_pid
                && entry.phase == RegistryPhase::Opening
        });
        if removable {
            entries.remove(&self.key);
            self.fence.set_phase(CLOSED_PROVEN);
            Ok(())
        } else {
            Err(PlatformStoreFailure::Closed)
        }
    }

    pub(crate) fn mark_descriptor_close_uncertain(&self) {
        if self.check_process().is_err() {
            return;
        }
        let Ok(mut entries) = self.registry.lock_entries() else {
            return;
        };
        let Some(entry) = entries.get_mut(&self.key) else {
            return;
        };
        if entry.token != self.token || entry.opener_pid != self.fence.process.opener_pid {
            return;
        }
        entry.phase = RegistryPhase::CloseUncertain;
        entry.fence.set_phase(CLOSE_UNCERTAIN);
    }

    pub(crate) fn mark_open(&self) -> Result<(), PlatformStoreFailure> {
        self.check_process()?;
        let mut entries = self.registry.lock_entries()?;
        let Some(entry) = entries.get_mut(&self.key) else {
            return Err(PlatformStoreFailure::Closed);
        };
        if entry.token != self.token
            || entry.opener_pid != self.fence.process.opener_pid
            || entry.phase != RegistryPhase::Opening
        {
            return Err(PlatformStoreFailure::Closed);
        }
        entry.phase = RegistryPhase::Open;
        entry.fence.set_phase(OPEN);
        Ok(())
    }

    pub(crate) fn begin_close(&self) -> Result<(), PlatformStoreFailure> {
        self.check_process()?;
        let mut entries = self.registry.lock_entries()?;
        let Some(entry) = entries.get_mut(&self.key) else {
            // The matching store has already completed a proven close. N1 owns
            // the cached idempotent result; never touch a newer token here.
            return Ok(());
        };
        if entry.token != self.token || entry.opener_pid != self.fence.process.opener_pid {
            return Ok(());
        }
        match entry.phase {
            RegistryPhase::Opening | RegistryPhase::Open => {
                entry.phase = RegistryPhase::Closing;
                entry.fence.set_phase(CLOSING);
            }
            RegistryPhase::Closing | RegistryPhase::CloseUncertain => {}
        }
        Ok(())
    }

    pub(crate) fn finish_close_success(&self) -> Result<(), PlatformStoreFailure> {
        self.check_process()?;
        let mut entries = self.registry.lock_entries()?;
        let removable = entries.get(&self.key).is_some_and(|entry| {
            entry.token == self.token
                && entry.opener_pid == self.fence.process.opener_pid
                && entry.phase == RegistryPhase::Closing
        });
        if removable {
            entries.remove(&self.key);
            self.fence.set_phase(CLOSED_PROVEN);
            Ok(())
        } else {
            Err(PlatformStoreFailure::Closed)
        }
    }

    pub(crate) fn finish_close_uncertain(&self) {
        self.mark_descriptor_close_uncertain();
    }

    /// Holds the registry mutex while N1 records admission. This is the sole
    /// registry -> N1 lock edge; final adapter close runs after N1 has released
    /// its lifecycle lock and may therefore safely re-enter the registry.
    pub(crate) fn with_open_entry<T>(
        &self,
        admit: impl FnOnce() -> T,
    ) -> Result<T, PlatformStoreFailure> {
        self.check_process()?;
        let entries = self.registry.lock_entries()?;
        let Some(entry) = entries.get(&self.key) else {
            return Err(PlatformStoreFailure::Closed);
        };
        if entry.token != self.token
            || entry.opener_pid != self.fence.process.opener_pid
            || entry.phase != RegistryPhase::Open
        {
            return Err(PlatformStoreFailure::Closed);
        }
        let value = admit();
        drop(entries);
        self.check_process()?;
        Ok(value)
    }
}

fn current_process_id() -> u32 {
    std::process::id()
}

fn capture_production_process() -> Result<ProcessFence, PlatformStoreFailure> {
    let current = current_process_id();
    let mut observed = PROCESS_ORIGIN_PID.load(Ordering::Acquire);
    loop {
        if observed == current {
            break;
        }
        if observed != 0 {
            return Err(PlatformStoreFailure::Closed);
        }
        match PROCESS_ORIGIN_PID.compare_exchange(0, current, Ordering::AcqRel, Ordering::Acquire) {
            Ok(_) => break,
            Err(next) => observed = next,
        }
    }
    Ok(ProcessFence {
        opener_pid: current,
        current_pid: Arc::new(current_process_id),
    })
}

/// Opaque proof that composition eagerly captured this process epoch before
/// any store open. Future N-API module initialization must retain one token and
/// pass it to every reserve call. A child inheriting an initialized parent can
/// neither use this token nor initialize a replacement.
pub struct ProcessLifecycleToken {
    process: ProcessFence,
    registry: Arc<ProcessRegistry>,
}

impl ProcessLifecycleToken {
    fn check(&self) -> Result<(), PlatformStoreFailure> {
        self.process.check()
    }
}

impl fmt::Debug for ProcessLifecycleToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ProcessLifecycleToken(<opaque>)")
    }
}

pub fn initialize_process_lifecycle() -> Result<ProcessLifecycleToken, PlatformStoreFailure> {
    // The PID epoch is captured and checked before touching the OnceLock. A
    // parent that initialized before fork therefore cannot be rebound by its
    // child. If no code loaded/initialized common before fork, process ancestry
    // is unobservable; eager composition initialization is the precondition.
    let process = capture_production_process()?;
    let registry = Arc::clone(PROCESS_REGISTRY.get_or_init(|| Arc::new(ProcessRegistry::new())));
    Ok(ProcessLifecycleToken { process, registry })
}

pub(crate) fn reserve_process_store(
    token: &ProcessLifecycleToken,
    home: VerifiedHomeIdentity,
) -> Result<LifecycleHandle, PlatformStoreFailure> {
    token.check()?;
    token.registry.reserve(home, token.process.clone())
}

#[cfg(test)]
pub(crate) fn reserve_process_store_for_test(
    home: VerifiedHomeIdentity,
    opener_pid: u32,
    current_pid: Arc<AtomicU32>,
) -> Result<LifecycleHandle, PlatformStoreFailure> {
    let source = Arc::clone(&current_pid);
    Arc::new(ProcessRegistry::new()).reserve(
        home,
        ProcessFence {
            opener_pid,
            current_pid: Arc::new(move || source.load(Ordering::Acquire)),
        },
    )
}

#[cfg(test)]
pub(crate) fn reserve_process_store_pair_for_test(
    first_home: VerifiedHomeIdentity,
    second_home: VerifiedHomeIdentity,
    opener_pid: u32,
    current_pid: Arc<AtomicU32>,
) -> Result<(LifecycleHandle, LifecycleHandle), PlatformStoreFailure> {
    let registry = Arc::new(ProcessRegistry::new());
    let source = Arc::clone(&current_pid);
    let process = ProcessFence {
        opener_pid,
        current_pid: Arc::new(move || source.load(Ordering::Acquire)),
    };
    let first = registry.reserve(first_home, process.clone())?;
    let second = registry.reserve(second_home, process)?;
    Ok((first, second))
}

#[cfg(test)]
pub(crate) fn registry_boundary_entries_for_test(handle: &LifecycleHandle) -> usize {
    handle.registry.boundary_entries.load(Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::panic::{catch_unwind, AssertUnwindSafe};
    use std::sync::atomic::AtomicUsize;
    use std::thread;

    struct RegistryTouchOnDrop {
        handle: LifecycleHandle,
    }

    impl Drop for RegistryTouchOnDrop {
        fn drop(&mut self) {
            let _ = self.handle.with_open_entry(|| ());
        }
    }

    fn context(opener_pid: u32, current: Arc<AtomicU32>) -> (Arc<ProcessRegistry>, ProcessFence) {
        let registry = Arc::new(ProcessRegistry::new());
        let source = Arc::clone(&current);
        (
            registry,
            ProcessFence {
                opener_pid,
                current_pid: Arc::new(move || source.load(Ordering::Acquire)),
            },
        )
    }

    #[test]
    fn collision_is_decided_before_any_open_hook_and_close_uncertain_is_terminal() {
        let current = Arc::new(AtomicU32::new(41));
        let (registry, process) = context(41, current);
        let home = VerifiedHomeIdentity::new(7, 11);
        let first = registry
            .reserve(home, process.clone())
            .expect("first reservation");
        let open_hook = AtomicUsize::new(0);

        let result = registry.reserve(home, process.clone()).map(|_| {
            open_hook.fetch_add(1, Ordering::Relaxed);
        });
        assert_eq!(result, Err(PlatformStoreFailure::Busy));
        assert_eq!(open_hook.load(Ordering::Relaxed), 0);

        first.mark_descriptor_close_uncertain();
        assert!(matches!(
            registry.reserve(home, process),
            Err(PlatformStoreFailure::Closed)
        ));
    }

    #[test]
    fn proven_pre_descriptor_failure_releases_but_unknown_admission_tombstones() {
        let current = Arc::new(AtomicU32::new(42));
        let (registry, process) = context(42, current);
        let home = VerifiedHomeIdentity::new(8, 12);
        let first = registry
            .reserve(home, process.clone())
            .expect("first reservation");
        first
            .release_proven_no_descriptor()
            .expect("proof removes opening entry");

        let second = registry
            .reserve(home, process.clone())
            .expect("reopen after proven no descriptor");
        second.mark_descriptor_close_uncertain();
        assert!(matches!(
            registry.reserve(home, process),
            Err(PlatformStoreFailure::Closed)
        ));
    }

    #[test]
    fn foreign_pid_fails_before_registry_and_poison_is_permanent() {
        let current = Arc::new(AtomicU32::new(43));
        let (registry, process) = context(43, Arc::clone(&current));
        let home = VerifiedHomeIdentity::new(9, 13);
        let handle = registry
            .reserve(home, process.clone())
            .expect("reservation");

        current.store(44, Ordering::Release);
        assert_eq!(
            handle.check_operational(),
            Err(PlatformStoreFailure::Closed)
        );
        assert!(matches!(
            registry.reserve(VerifiedHomeIdentity::new(10, 14), process.clone()),
            Err(PlatformStoreFailure::Closed)
        ));

        current.store(43, Ordering::Release);
        handle.mark_open().expect("mark open for guarded poison");
        let handle_for_panic = handle.clone();
        let _ = thread::spawn(move || {
            let _: Result<(), PlatformStoreFailure> = handle_for_panic.with_open_entry(|| {
                panic!("intentional registry poison");
            });
        })
        .join();
        assert!(
            registry.poisoned.load(Ordering::Acquire),
            "panic guard publishes poison during unwind"
        );
        assert_eq!(
            handle.check_operational(),
            Err(PlatformStoreFailure::Closed),
            "descriptor fence closes before another registry lock attempt"
        );
        assert!(matches!(
            registry.reserve(VerifiedHomeIdentity::new(10, 14), process.clone()),
            Err(PlatformStoreFailure::Closed)
        ));
        assert!(matches!(
            registry.reserve(VerifiedHomeIdentity::new(15, 16), process),
            Err(PlatformStoreFailure::Closed)
        ));
    }

    #[test]
    fn normal_registry_use_entered_during_an_existing_unwind_does_not_poison() {
        let current = Arc::new(AtomicU32::new(45));
        let (registry, process) = context(45, current);
        let handle = registry
            .reserve(VerifiedHomeIdentity::new(17, 18), process)
            .expect("reservation");
        handle.mark_open().expect("mark open");

        let unwind = catch_unwind(AssertUnwindSafe(|| {
            let _touch = RegistryTouchOnDrop {
                handle: handle.clone(),
            };
            panic!("unrelated outer panic");
        }));
        assert!(unwind.is_err());
        assert!(!registry.poisoned.load(Ordering::Acquire));
        assert_eq!(handle.check_operational(), Ok(()));

        handle.begin_close().expect("begin cleanup close");
        handle.finish_close_success().expect("remove test entry");
    }
}
