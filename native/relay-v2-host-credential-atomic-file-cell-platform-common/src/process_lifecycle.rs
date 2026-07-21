use crate::CellErrorCode;
use std::collections::HashMap;
use std::fmt;
#[cfg(test)]
use std::sync::atomic::AtomicU32;
use std::sync::atomic::{AtomicBool, AtomicU32 as ProcessAtomicU32, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

const OPENING: u8 = 1;
const OPEN: u8 = 2;
const CLOSING: u8 = 3;
const CLOSE_UNCERTAIN: u8 = 4;
const CLOSED: u8 = 5;

static PROCESS_ORIGIN_PID: ProcessAtomicU32 = ProcessAtomicU32::new(0);
static PROCESS_REGISTRY: OnceLock<Arc<ProcessRegistry>> = OnceLock::new();

type PidSource = Arc<dyn Fn() -> u32 + Send + Sync>;

#[derive(Clone)]
struct ProcessFence {
    opener_pid: u32,
    current_pid: PidSource,
}

impl ProcessFence {
    fn check(&self) -> Result<(), CellErrorCode> {
        if (self.current_pid)() == self.opener_pid {
            Ok(())
        } else {
            Err(CellErrorCode::CellClosed)
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) struct DirectoryIdentity {
    pub(crate) device: u64,
    pub(crate) inode: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum HostAdmissionKind {
    RelayV2HostCredentialAtomicFileCellAdmissionV1,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct RegistryKey {
    directory: DirectoryIdentity,
    kind: HostAdmissionKind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RegistryPhase {
    Opening,
    Open,
    Closing,
    CloseUncertain,
}

struct EntryFence {
    process: ProcessFence,
    registry_poisoned: Arc<AtomicBool>,
    phase: AtomicU8,
}

impl EntryFence {
    fn check_parent_process(&self) -> Result<(), CellErrorCode> {
        self.process.check()
    }

    fn check_operation(&self) -> Result<(), CellErrorCode> {
        self.check_parent_process()?;
        if self.registry_poisoned.load(Ordering::Acquire) {
            return Err(CellErrorCode::CellClosed);
        }
        match self.phase.load(Ordering::Acquire) {
            OPENING | OPEN | CLOSING => Ok(()),
            CLOSE_UNCERTAIN | CLOSED | _ => Err(CellErrorCode::CellClosed),
        }
    }

    fn check_mutation_open(&self) -> Result<(), CellErrorCode> {
        self.check_parent_process()?;
        if self.registry_poisoned.load(Ordering::Acquire)
            || self.phase.load(Ordering::Acquire) != OPEN
        {
            return Err(CellErrorCode::CellClosed);
        }
        Ok(())
    }

    fn set_phase(&self, phase: u8) {
        self.phase.store(phase, Ordering::Release);
    }
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
    poison_after_begin_close: AtomicBool,
}

impl ProcessRegistry {
    fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            poisoned: Arc::new(AtomicBool::new(false)),
            next_token: AtomicU64::new(1),
            #[cfg(test)]
            poison_after_begin_close: AtomicBool::new(false),
        }
    }

    fn with_entries<T>(
        &self,
        operation: impl FnOnce(&mut HashMap<RegistryKey, RegistryEntry>) -> Result<T, CellErrorCode>,
    ) -> Result<T, CellErrorCode> {
        if self.poisoned.load(Ordering::Acquire) {
            return Err(CellErrorCode::CellClosed);
        }
        let mut entries = match self.entries.lock() {
            Ok(entries) => entries,
            Err(_) => {
                self.poisoned.store(true, Ordering::Release);
                return Err(CellErrorCode::CellClosed);
            }
        };
        operation(&mut entries)
    }

    fn reserve(
        self: &Arc<Self>,
        directory: DirectoryIdentity,
        process: ProcessFence,
    ) -> Result<LifecycleHandle, CellErrorCode> {
        process.check()?;
        let key = RegistryKey {
            directory,
            kind: HostAdmissionKind::RelayV2HostCredentialAtomicFileCellAdmissionV1,
        };
        self.with_entries(|entries| {
            if let Some(entry) = entries.get(&key) {
                return match entry.phase {
                    RegistryPhase::Opening | RegistryPhase::Open | RegistryPhase::Closing => {
                        Err(CellErrorCode::CellBusy)
                    }
                    RegistryPhase::CloseUncertain => Err(CellErrorCode::CellClosed),
                };
            }
            let token = self.next_token.fetch_add(1, Ordering::Relaxed);
            if token == 0 {
                self.poisoned.store(true, Ordering::Release);
                return Err(CellErrorCode::CellClosed);
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
            Ok(LifecycleHandle {
                registry: Arc::clone(self),
                key,
                token,
                fence,
            })
        })
    }
}

/// Opaque proof that platform composition captured the process epoch before
/// adopting any Host credential admission descriptors.
pub struct ProcessLifecycleToken {
    process: ProcessFence,
    registry: Arc<ProcessRegistry>,
}

impl ProcessLifecycleToken {
    pub(crate) fn check_parent_process(&self) -> Result<(), CellErrorCode> {
        self.process.check()
    }
}

impl fmt::Debug for ProcessLifecycleToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ProcessLifecycleToken(<host-admission-opaque>)")
    }
}

fn current_process_id() -> u32 {
    std::process::id()
}

/// Captures the sole production process epoch. A child that inherits an
/// initialized parent cannot rebind this token or use inherited owners.
pub fn initialize_process_lifecycle() -> Result<ProcessLifecycleToken, CellErrorCode> {
    let current = current_process_id();
    let mut observed = PROCESS_ORIGIN_PID.load(Ordering::Acquire);
    loop {
        if observed == current {
            break;
        }
        if observed != 0 {
            return Err(CellErrorCode::CellClosed);
        }
        match PROCESS_ORIGIN_PID.compare_exchange(0, current, Ordering::AcqRel, Ordering::Acquire) {
            Ok(_) => break,
            Err(next) => observed = next,
        }
    }
    let process = ProcessFence {
        opener_pid: current,
        current_pid: Arc::new(current_process_id),
    };
    let registry = Arc::clone(PROCESS_REGISTRY.get_or_init(|| Arc::new(ProcessRegistry::new())));
    Ok(ProcessLifecycleToken { process, registry })
}

pub(crate) struct LifecycleHandle {
    registry: Arc<ProcessRegistry>,
    key: RegistryKey,
    token: u64,
    fence: Arc<EntryFence>,
}

pub(crate) struct MutationOwnerBinding {
    token: u64,
    opener_pid: u32,
    fence: Arc<EntryFence>,
}

impl LifecycleHandle {
    pub(crate) fn check_parent_process(&self) -> Result<(), CellErrorCode> {
        self.fence.check_parent_process()
    }

    pub(crate) fn check_operation(&self) -> Result<(), CellErrorCode> {
        self.fence.check_operation()
    }

    pub(crate) fn check_mutation_open(&self) -> Result<(), CellErrorCode> {
        self.fence.check_mutation_open()?;
        self.registry.with_entries(|entries| {
            let entry = entries.get(&self.key).ok_or(CellErrorCode::CellClosed)?;
            if !Self::matching(entry, self.token, self.opener_pid())
                || entry.phase != RegistryPhase::Open
                || !Arc::ptr_eq(&entry.fence, &self.fence)
            {
                return Err(CellErrorCode::CellClosed);
            }
            entry.fence.check_mutation_open()
        })
    }

    pub(crate) fn mutation_owner_binding(&self) -> Result<MutationOwnerBinding, CellErrorCode> {
        self.check_mutation_open()?;
        Ok(MutationOwnerBinding {
            token: self.token,
            opener_pid: self.opener_pid(),
            fence: Arc::clone(&self.fence),
        })
    }

    pub(crate) fn matches_mutation_owner_binding(&self, binding: &MutationOwnerBinding) -> bool {
        self.token == binding.token
            && self.opener_pid() == binding.opener_pid
            && Arc::ptr_eq(&self.fence, &binding.fence)
    }

    pub(crate) fn opener_pid(&self) -> u32 {
        self.fence.process.opener_pid
    }

    fn matching(entry: &RegistryEntry, token: u64, opener_pid: u32) -> bool {
        entry.token == token && entry.opener_pid == opener_pid
    }

    pub(crate) fn mark_open(&self) -> Result<(), CellErrorCode> {
        self.check_operation()?;
        self.registry.with_entries(|entries| {
            let entry = entries
                .get_mut(&self.key)
                .ok_or(CellErrorCode::CellClosed)?;
            if !Self::matching(entry, self.token, self.opener_pid())
                || entry.phase != RegistryPhase::Opening
            {
                return Err(CellErrorCode::CellClosed);
            }
            entry.phase = RegistryPhase::Open;
            entry.fence.set_phase(OPEN);
            Ok(())
        })
    }

    pub(crate) fn release_opening(&self) -> Result<(), CellErrorCode> {
        self.check_parent_process()?;
        self.registry.with_entries(|entries| {
            let removable = entries.get(&self.key).is_some_and(|entry| {
                Self::matching(entry, self.token, self.opener_pid())
                    && entry.phase == RegistryPhase::Opening
            });
            if !removable {
                return Err(CellErrorCode::CellClosed);
            }
            entries.remove(&self.key);
            self.fence.set_phase(CLOSED);
            Ok(())
        })
    }

    pub(crate) fn begin_close(&self) -> Result<(), CellErrorCode> {
        self.check_parent_process()?;
        let result = self.registry.with_entries(|entries| {
            let entry = entries
                .get_mut(&self.key)
                .ok_or(CellErrorCode::CellClosed)?;
            if !Self::matching(entry, self.token, self.opener_pid()) {
                return Err(CellErrorCode::CellClosed);
            }
            match entry.phase {
                RegistryPhase::Open => {
                    entry.phase = RegistryPhase::Closing;
                    entry.fence.set_phase(CLOSING);
                    Ok(())
                }
                RegistryPhase::Closing => Ok(()),
                RegistryPhase::Opening | RegistryPhase::CloseUncertain => {
                    Err(CellErrorCode::CellClosed)
                }
            }
        });
        #[cfg(test)]
        if result.is_ok()
            && self
                .registry
                .poison_after_begin_close
                .swap(false, Ordering::AcqRel)
        {
            self.registry.poisoned.store(true, Ordering::Release);
        }
        result
    }

    pub(crate) fn finish_close_success(&self) -> Result<(), CellErrorCode> {
        self.check_parent_process()?;
        self.registry.with_entries(|entries| {
            let removable = entries.get(&self.key).is_some_and(|entry| {
                Self::matching(entry, self.token, self.opener_pid())
                    && entry.phase == RegistryPhase::Closing
            });
            if !removable {
                return Err(CellErrorCode::CellClosed);
            }
            entries.remove(&self.key);
            self.fence.set_phase(CLOSED);
            Ok(())
        })
    }

    pub(crate) fn mark_close_uncertain(&self) {
        if self.check_parent_process().is_err() {
            return;
        }
        self.fence.set_phase(CLOSE_UNCERTAIN);
        let marked = self.registry.with_entries(|entries| {
            let Some(entry) = entries.get_mut(&self.key) else {
                return Err(CellErrorCode::CellClosed);
            };
            if !Self::matching(entry, self.token, self.opener_pid()) {
                return Err(CellErrorCode::CellClosed);
            }
            entry.phase = RegistryPhase::CloseUncertain;
            entry.fence.set_phase(CLOSE_UNCERTAIN);
            Ok(())
        });
        if marked.is_err() {
            self.registry.poisoned.store(true, Ordering::Release);
        }
    }
}

pub(crate) fn reserve_directory(
    token: &ProcessLifecycleToken,
    directory: DirectoryIdentity,
) -> Result<LifecycleHandle, CellErrorCode> {
    token.check_parent_process()?;
    token.registry.reserve(directory, token.process.clone())
}

#[cfg(test)]
pub(crate) fn process_lifecycle_for_test(
    opener_pid: u32,
    current_pid: Arc<AtomicU32>,
) -> ProcessLifecycleToken {
    let source = Arc::clone(&current_pid);
    ProcessLifecycleToken {
        process: ProcessFence {
            opener_pid,
            current_pid: Arc::new(move || source.load(Ordering::Acquire)),
        },
        registry: Arc::new(ProcessRegistry::new()),
    }
}

#[cfg(test)]
pub(crate) fn poison_registry_for_test(handle: &LifecycleHandle) {
    handle.registry.poisoned.store(true, Ordering::Release);
}

#[cfg(test)]
pub(crate) fn poison_registry_after_begin_close_for_test(handle: &LifecycleHandle) {
    handle
        .registry
        .poison_after_begin_close
        .store(true, Ordering::Release);
}

#[cfg(test)]
pub(crate) fn registry_poison_flag_for_test(token: &ProcessLifecycleToken) -> Arc<AtomicBool> {
    Arc::clone(&token.registry.poisoned)
}

#[cfg(test)]
pub(crate) fn remove_registry_entry_for_test(handle: &LifecycleHandle) {
    handle
        .registry
        .entries
        .lock()
        .expect("test registry")
        .remove(&handle.key);
}
