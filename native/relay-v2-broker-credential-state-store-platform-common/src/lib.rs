//! Shared lifecycle and native seam for the future Darwin and Linux adapters.
//!
//! This unwired crate is the only intended production consumer of the N1 pure
//! core. It owns the manifest-derived container spec, process-wide registry,
//! process-origin and descriptor fences, exactly-once final close, the private
//! adapter bridge, and opaque process-bound transaction wrappers. Future N2,
//! N3, and N-API crates implement [`SoleContainer`] or consume these wrappers;
//! they must not depend on or expose N1 types and must not duplicate this
//! lifecycle.
//!
//! This crate still does not accept `trustedHome`, construct paths, issue OS
//! syscalls, qualify durability, implement a real kernel lock, or expose N-API.
//! The frozen durability allowlist is empty, so no real platform open can yet
//! reach this seam in production.

mod process_lifecycle;

pub use process_lifecycle::{
    initialize_process_lifecycle, DescriptorOperationFence, FinalCloseOperationFence,
    ProcessLifecycleToken, VerifiedHomeIdentity,
};

use process_lifecycle::{reserve_process_store as reserve_lifecycle, LifecycleHandle};
use relay_v2_broker_credential_state_store_core::{
    AbsoluteRangeReader, AdmissionTicket, CoreError, OperationError, PublicationAction,
    PublicationAdapter, PublishOutcome, Revision, Snapshot, StateStore, TransactionLease,
};
use std::fmt;
use std::mem;
use std::panic::{catch_unwind, AssertUnwindSafe};

/// Frozen container facts shared by both future platform adapters.
///
/// Fields and construction stay private so callers can neither replace the
/// canonical location nor fabricate a divergent container shape.
#[derive(Debug, PartialEq, Eq)]
pub struct ContainerSpec {
    relative_components: &'static [&'static str],
    file_length: u64,
    max_state_bytes: usize,
}

impl ContainerSpec {
    pub fn relative_components(&self) -> &'static [&'static str] {
        self.relative_components
    }

    pub const fn file_length(&self) -> u64 {
        self.file_length
    }

    pub const fn max_state_bytes(&self) -> usize {
        self.max_state_bytes
    }
}

mod generated {
    use super::ContainerSpec;

    include!(concat!(env!("OUT_DIR"), "/container_spec.rs"));
}

pub fn container_spec() -> &'static ContainerSpec {
    &generated::CONTAINER_SPEC
}

/// Failures owned by process lifecycle and future secure-open/platform code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlatformStoreFailure {
    Busy,
    Closed,
    IdentityUncertain,
    Io,
    PermissionInvalid,
    DurabilityUnsupported,
}

/// Exact frozen native state-store contract codes.
///
/// `NativeInterfaceInvalid` is reserved for the future N-API binding decoder;
/// no core or platform mapping below can produce it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeStoreErrorCode {
    NativeInterfaceInvalid,
    StoreBusy,
    StoreClosed,
    StoreCorrupt,
    StoreFormatUnsupported,
    StoreIdentityUncertain,
    StoreIo,
    StorePermissionInvalid,
    DurabilityUnsupported,
    InvalidArgument,
    InvalidRevision,
    StateTooLarge,
    GenerationExhausted,
}

impl NativeStoreErrorCode {
    pub const fn as_contract_code(self) -> &'static str {
        match self {
            Self::NativeInterfaceInvalid => "NATIVE_INTERFACE_INVALID",
            Self::StoreBusy => "STORE_BUSY",
            Self::StoreClosed => "STORE_CLOSED",
            Self::StoreCorrupt => "STORE_CORRUPT",
            Self::StoreFormatUnsupported => "STORE_FORMAT_UNSUPPORTED",
            Self::StoreIdentityUncertain => "STORE_IDENTITY_UNCERTAIN",
            Self::StoreIo => "STORE_IO",
            Self::StorePermissionInvalid => "STORE_PERMISSION_INVALID",
            Self::DurabilityUnsupported => "DURABILITY_UNSUPPORTED",
            Self::InvalidArgument => "INVALID_ARGUMENT",
            Self::InvalidRevision => "INVALID_REVISION",
            Self::StateTooLarge => "STATE_TOO_LARGE",
            Self::GenerationExhausted => "GENERATION_EXHAUSTED",
        }
    }
}

impl From<PlatformStoreFailure> for NativeStoreErrorCode {
    fn from(error: PlatformStoreFailure) -> Self {
        match error {
            PlatformStoreFailure::Busy => Self::StoreBusy,
            PlatformStoreFailure::Closed => Self::StoreClosed,
            PlatformStoreFailure::IdentityUncertain => Self::StoreIdentityUncertain,
            PlatformStoreFailure::Io => Self::StoreIo,
            PlatformStoreFailure::PermissionInvalid => Self::StorePermissionInvalid,
            PlatformStoreFailure::DurabilityUnsupported => Self::DurabilityUnsupported,
        }
    }
}

fn map_core_error(error: CoreError) -> NativeStoreErrorCode {
    match error {
        CoreError::Corrupt => NativeStoreErrorCode::StoreCorrupt,
        CoreError::FormatUnsupported => NativeStoreErrorCode::StoreFormatUnsupported,
        CoreError::Closed => NativeStoreErrorCode::StoreClosed,
        CoreError::InvalidArgument => NativeStoreErrorCode::InvalidArgument,
        CoreError::InvalidRevision => NativeStoreErrorCode::InvalidRevision,
        CoreError::StateTooLarge => NativeStoreErrorCode::StateTooLarge,
        CoreError::GenerationExhausted => NativeStoreErrorCode::GenerationExhausted,
    }
}

fn map_operation_error(error: OperationError<PlatformStoreFailure>) -> NativeStoreErrorCode {
    match error {
        OperationError::Core(error) => map_core_error(error),
        OperationError::Adapter(error) => error.into(),
    }
}

/// One platform-verified, sole container descriptor and its OS operations.
///
/// Implementations must own exactly one container descriptor and must not be
/// `Clone`. They may not duplicate, reopen, lend, or explicitly unlock it. Each
/// implementation must call the supplied descriptor fence immediately before
/// every platform syscall. `final_close` borrows the common-owned container and
/// must issue exactly one raw close attempt with no retry and no explicit
/// unlock. On `Ok`, it must leave any descriptor-owning field inert so ordinary
/// Rust Drop cannot close it again. On `Err` or panic, common forgets the
/// container instead of allowing an implicit destructor close. Implementor
/// Drop must never issue descriptor, unlock, or other native cleanup actions;
/// this method is the sole post-attach native resource release path.
///
/// N1 publication actions are intentionally absent from this public trait.
pub trait SoleContainer: Send + 'static {
    fn complete_platform_open(
        &mut self,
        fence: &DescriptorOperationFence,
        spec: &ContainerSpec,
    ) -> Result<(), PlatformStoreFailure>;

    fn file_length(&self, fence: &DescriptorOperationFence) -> Result<u64, PlatformStoreFailure>;

    fn read_exact_at(
        &self,
        fence: &DescriptorOperationFence,
        absolute_offset: u64,
        output: &mut [u8],
    ) -> Result<(), PlatformStoreFailure>;

    fn write_all_at(
        &mut self,
        fence: &DescriptorOperationFence,
        absolute_offset: u64,
        bytes: &[u8],
    ) -> Result<(), PlatformStoreFailure>;

    fn payload_durability_barrier(
        &mut self,
        fence: &DescriptorOperationFence,
    ) -> Result<(), PlatformStoreFailure>;

    fn header_and_container_durability_barrier(
        &mut self,
        fence: &DescriptorOperationFence,
    ) -> Result<(), PlatformStoreFailure>;

    fn final_close(&mut self, fence: &FinalCloseOperationFence)
        -> Result<(), PlatformStoreFailure>;
}

/// Reserves the fixed logical store before any container descriptor exists.
pub fn reserve_process_store(
    lifecycle: &ProcessLifecycleToken,
    home: VerifiedHomeIdentity,
) -> Result<OpenReservation, PlatformStoreFailure> {
    reserve_lifecycle(lifecycle, home).map(|handle| OpenReservation {
        handle: Some(handle),
    })
}

/// Proven pre-descriptor registry reservation.
pub struct OpenReservation {
    handle: Option<LifecycleHandle>,
}

impl OpenReservation {
    /// Enters the only phase in which a container descriptor may be created or
    /// opened. Dropping the returned admission without a no-descriptor proof
    /// permanently tombstones this process key.
    pub fn begin_descriptor_open(
        mut self,
    ) -> Result<DescriptorOpenAdmission, PlatformStoreFailure> {
        let handle = self.handle.as_ref().expect("reservation handle");
        handle.check_process()?;
        Ok(DescriptorOpenAdmission {
            handle: self.handle.take(),
        })
    }

    pub fn release_proven_no_descriptor(mut self) -> Result<(), PlatformStoreFailure> {
        let handle = self.handle.take().expect("reservation handle");
        handle.release_proven_no_descriptor()
    }
}

impl fmt::Debug for OpenReservation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("OpenReservation(<opaque>)")
    }
}

impl Drop for OpenReservation {
    fn drop(&mut self) {
        let Some(handle) = self.handle.take() else {
            return;
        };
        if handle.check_process().is_ok() {
            let _ = handle.release_proven_no_descriptor();
        }
    }
}

/// Descriptor-open admission. The platform may now have created an fd, so an
/// unproven Drop is terminal even when no descriptor was actually produced.
pub struct DescriptorOpenAdmission {
    handle: Option<LifecycleHandle>,
}

impl DescriptorOpenAdmission {
    pub fn release_proven_no_descriptor(mut self) -> Result<(), PlatformStoreFailure> {
        let handle = self.handle.take().expect("descriptor admission handle");
        handle.release_proven_no_descriptor()
    }

    /// Transfers the sole container owner into common immediately.
    pub fn attach<C: SoleContainer>(
        mut self,
        container: C,
    ) -> Result<OpenedContainer<C>, PlatformStoreFailure> {
        let handle = self.handle.take().expect("descriptor admission handle");
        if let Err(error) = handle.check_process() {
            mem::forget(container);
            return Err(error);
        }
        Ok(OpenedContainer {
            resources: Some(ParentResources {
                container: Some(container),
                handle,
            }),
        })
    }
}

impl fmt::Debug for DescriptorOpenAdmission {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("DescriptorOpenAdmission(<opaque>)")
    }
}

impl Drop for DescriptorOpenAdmission {
    fn drop(&mut self) {
        let Some(handle) = self.handle.take() else {
            return;
        };
        if handle.check_process().is_ok() {
            handle.mark_descriptor_close_uncertain();
        }
    }
}

/// Common-owned container that has not yet completed platform proof and N1
/// binary self-check.
pub struct OpenedContainer<C: SoleContainer> {
    resources: Option<ParentResources<C>>,
}

impl<C: SoleContainer> OpenedContainer<C> {
    /// Completes platform proof, transfers the sole owner into the private N1
    /// bridge, runs N1 selection/self-check, then atomically marks the registry
    /// entry Open. Every failure performs one controlled final-close attempt
    /// while preserving the primary open error.
    pub fn finish(mut self) -> Result<ProcessBoundStateStore<C>, NativeStoreErrorCode> {
        let resources = self.resources.take().expect("opened resources");
        if let Err(error) = resources.handle.check_process() {
            forget_parent_resources(resources);
            return Err(error.into());
        }

        let lifecycle = resources.handle.clone();
        let mut adapter = GuardedAdapter::new(resources);
        if let Err(primary) = adapter.complete_platform_open() {
            let _ = adapter.close_once();
            return Err(primary.into());
        }

        let store = StateStore::from_adapter(adapter).map_err(map_operation_error)?;
        if let Err(primary) = lifecycle.mark_open() {
            let _ = store.close();
            return Err(primary.into());
        }
        Ok(ProcessBoundStateStore {
            inner: Some(store),
            lifecycle,
        })
    }
}

impl<C: SoleContainer> fmt::Debug for OpenedContainer<C> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("OpenedContainer(<opaque>)")
    }
}

impl<C: SoleContainer> Drop for OpenedContainer<C> {
    fn drop(&mut self) {
        let Some(resources) = self.resources.take() else {
            return;
        };
        if resources.handle.check_process().is_err() {
            forget_parent_resources(resources);
            return;
        }
        let mut adapter = GuardedAdapter::new(resources);
        let _ = adapter.close_once();
    }
}

struct ParentResources<C: SoleContainer> {
    container: Option<C>,
    handle: LifecycleHandle,
}

fn forget_parent_resources<C: SoleContainer>(mut resources: ParentResources<C>) {
    if let Some(container) = resources.container.take() {
        mem::forget(container);
    }
}

struct GuardedAdapter<C: SoleContainer> {
    resources: Option<ParentResources<C>>,
    cached_close: Option<Result<(), PlatformStoreFailure>>,
}

impl<C: SoleContainer> GuardedAdapter<C> {
    fn new(resources: ParentResources<C>) -> Self {
        Self {
            resources: Some(resources),
            cached_close: None,
        }
    }

    fn complete_platform_open(&mut self) -> Result<(), PlatformStoreFailure> {
        let resources = self
            .resources
            .as_mut()
            .ok_or(PlatformStoreFailure::Closed)?;
        let fence = resources.handle.descriptor_fence();
        fence.check()?;
        let result = catch_unwind(AssertUnwindSafe(|| {
            resources
                .container
                .as_mut()
                .expect("sole container")
                .complete_platform_open(&fence, container_spec())
        }))
        .unwrap_or(Err(PlatformStoreFailure::Io));
        fence.check()?;
        result
    }

    fn with_container_ref<T>(
        &self,
        operation: impl FnOnce(&C, &DescriptorOperationFence) -> Result<T, PlatformStoreFailure>,
    ) -> Result<T, PlatformStoreFailure> {
        let resources = self
            .resources
            .as_ref()
            .ok_or(PlatformStoreFailure::Closed)?;
        let fence = resources.handle.descriptor_fence();
        fence.check()?;
        let result = catch_unwind(AssertUnwindSafe(|| {
            operation(
                resources.container.as_ref().expect("sole container"),
                &fence,
            )
        }))
        .unwrap_or(Err(PlatformStoreFailure::Io));
        fence.check()?;
        result
    }

    fn with_container_mut<T>(
        &mut self,
        operation: impl FnOnce(&mut C, &DescriptorOperationFence) -> Result<T, PlatformStoreFailure>,
    ) -> Result<T, PlatformStoreFailure> {
        let resources = self
            .resources
            .as_mut()
            .ok_or(PlatformStoreFailure::Closed)?;
        let fence = resources.handle.descriptor_fence();
        fence.check()?;
        let result = catch_unwind(AssertUnwindSafe(|| {
            operation(
                resources.container.as_mut().expect("sole container"),
                &fence,
            )
        }))
        .unwrap_or(Err(PlatformStoreFailure::Io));
        fence.check()?;
        result
    }

    fn close_once(&mut self) -> Result<(), PlatformStoreFailure> {
        if let Some(result) = &self.cached_close {
            return *result;
        }
        let Some(mut resources) = self.resources.take() else {
            let result = Err(PlatformStoreFailure::Closed);
            self.cached_close = Some(result);
            return result;
        };

        if let Err(error) = resources.handle.check_process() {
            forget_parent_resources(resources);
            self.cached_close = Some(Err(error));
            return Err(error);
        }

        // Registry poison or an unprovable transition closes every public
        // operation, but the parent must still attempt to release its sole fd
        // and process-owned lock. The typed final-close fence checks only the
        // process epoch and cannot be obtained by platform code elsewhere.
        let begin_result = resources.handle.begin_close();
        let fence = resources.handle.final_close_fence();
        if let Err(error) = fence.check() {
            forget_parent_resources(resources);
            self.cached_close = Some(Err(error));
            return Err(error);
        }

        let mut container = resources.container.take().expect("sole container");
        let native_result = catch_unwind(AssertUnwindSafe(|| container.final_close(&fence)));
        let result = if let Err(error) = resources.handle.check_process() {
            mem::forget(container);
            Err(error)
        } else {
            match native_result {
                Ok(Ok(())) => {
                    // `Ok` contractually means descriptor-owning fields are
                    // inert. Catch an unrelated destructor panic and retain a
                    // conservative tombstone rather than unwinding from Drop.
                    let drop_result = catch_unwind(AssertUnwindSafe(|| drop(container)));
                    if drop_result.is_err() {
                        resources.handle.finish_close_uncertain();
                        Err(PlatformStoreFailure::Io)
                    } else if let Err(error) = begin_result {
                        resources.handle.finish_close_uncertain();
                        Err(error)
                    } else {
                        resources.handle.finish_close_success()
                    }
                }
                Ok(Err(error)) => {
                    mem::forget(container);
                    resources.handle.finish_close_uncertain();
                    Err(begin_result.err().unwrap_or(error))
                }
                Err(_) => {
                    mem::forget(container);
                    resources.handle.finish_close_uncertain();
                    Err(begin_result.err().unwrap_or(PlatformStoreFailure::Io))
                }
            }
        };
        self.cached_close = Some(result);
        result
    }
}

impl<C: SoleContainer> AbsoluteRangeReader for GuardedAdapter<C> {
    type Error = PlatformStoreFailure;

    fn file_length(&self) -> Result<u64, Self::Error> {
        self.with_container_ref(|container, fence| container.file_length(fence))
    }

    fn read_exact_at(&self, absolute_offset: u64, output: &mut [u8]) -> Result<(), Self::Error> {
        self.with_container_ref(|container, fence| {
            container.read_exact_at(fence, absolute_offset, output)
        })
    }
}

impl<C: SoleContainer> PublicationAdapter for GuardedAdapter<C> {
    fn apply(&mut self, action: PublicationAction<'_>) -> Result<(), Self::Error> {
        match action {
            PublicationAction::WritePayload {
                absolute_offset,
                bytes,
            }
            | PublicationAction::WriteHeader {
                absolute_offset,
                bytes,
            } => self.with_container_mut(|container, fence| {
                container.write_all_at(fence, absolute_offset, bytes)
            }),
            PublicationAction::PayloadDurabilityBarrier => self
                .with_container_mut(|container, fence| container.payload_durability_barrier(fence)),
            PublicationAction::HeaderAndContainerDurabilityBarrier => {
                self.with_container_mut(|container, fence| {
                    container.header_and_container_durability_barrier(fence)
                })
            }
        }
    }

    fn close(&mut self) -> Result<(), Self::Error> {
        self.close_once()
    }
}

impl<C: SoleContainer> Drop for GuardedAdapter<C> {
    fn drop(&mut self) {
        let _ = self.close_once();
    }
}

/// Opaque process-bound store. It neither dereferences to nor returns N1.
pub struct ProcessBoundStateStore<C: SoleContainer> {
    inner: Option<StateStore<GuardedAdapter<C>>>,
    lifecycle: LifecycleHandle,
}

impl<C: SoleContainer> ProcessBoundStateStore<C> {
    /// Admission is recorded while holding the registry mutex, before ordinary
    /// close can move Open to Closing. This is the sole registry -> N1 lock
    /// order in common.
    pub fn admit(&self) -> Result<ProcessBoundAdmission<C>, NativeStoreErrorCode> {
        self.lifecycle
            .check_process()
            .map_err(NativeStoreErrorCode::from)?;
        let store = self
            .inner
            .as_ref()
            .ok_or(NativeStoreErrorCode::StoreClosed)?;
        let admitted = self
            .lifecycle
            .with_open_entry(|| store.admit())
            .map_err(NativeStoreErrorCode::from)?
            .map_err(map_core_error)?;
        Ok(ProcessBoundAdmission {
            inner: Some(admitted),
            lifecycle: self.lifecycle.clone(),
        })
    }

    /// Starts the common registry close barrier before N1 rejects new
    /// admission. N1 then drains already-admitted work and invokes the private
    /// exactly-once final-close bridge after releasing its lifecycle lock.
    pub fn close(&self) -> Result<(), NativeStoreErrorCode> {
        self.lifecycle
            .check_process()
            .map_err(NativeStoreErrorCode::from)?;
        let registry_result = self.lifecycle.begin_close();
        let result = self
            .inner
            .as_ref()
            .ok_or(NativeStoreErrorCode::StoreClosed)?
            .close();
        self.lifecycle
            .check_process()
            .map_err(NativeStoreErrorCode::from)?;
        match registry_result {
            Ok(()) => result.map_err(NativeStoreErrorCode::from),
            Err(error) => Err(error.into()),
        }
    }
}

impl<C: SoleContainer> fmt::Debug for ProcessBoundStateStore<C> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ProcessBoundStateStore(<opaque>)")
    }
}

impl<C: SoleContainer> Drop for ProcessBoundStateStore<C> {
    fn drop(&mut self) {
        let Some(inner) = self.inner.take() else {
            return;
        };
        if self.lifecycle.check_process().is_err() {
            mem::forget(inner);
        } else {
            drop(inner);
        }
    }
}

/// Opaque owned admission that may cross a worker boundary.
pub struct ProcessBoundAdmission<C: SoleContainer> {
    inner: Option<AdmissionTicket<GuardedAdapter<C>>>,
    lifecycle: LifecycleHandle,
}

impl<C: SoleContainer> ProcessBoundAdmission<C> {
    pub fn enter(mut self) -> Result<ProcessBoundTransaction<C>, NativeStoreErrorCode> {
        if let Err(error) = self.lifecycle.check_process() {
            if let Some(ticket) = self.inner.take() {
                mem::forget(ticket);
            }
            return Err(error.into());
        }
        self.lifecycle
            .check_operational()
            .map_err(NativeStoreErrorCode::from)?;
        let ticket = self.inner.take().expect("admission ticket");
        let entered = ticket.enter();
        if let Err(error) = self.lifecycle.check_process() {
            if let Ok(lease) = entered {
                mem::forget(lease);
            }
            return Err(error.into());
        }
        if let Err(error) = self.lifecycle.check_operational() {
            if let Ok(lease) = entered {
                drop(lease);
            }
            return Err(error.into());
        }
        entered
            .map(|lease| ProcessBoundTransaction {
                inner: Some(lease),
                lifecycle: self.lifecycle.clone(),
            })
            .map_err(map_core_error)
    }
}

impl<C: SoleContainer> fmt::Debug for ProcessBoundAdmission<C> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ProcessBoundAdmission(<opaque>)")
    }
}

impl<C: SoleContainer> Drop for ProcessBoundAdmission<C> {
    fn drop(&mut self) {
        let Some(ticket) = self.inner.take() else {
            return;
        };
        if self.lifecycle.check_process().is_err() {
            mem::forget(ticket);
        } else {
            drop(ticket);
        }
    }
}

/// Opaque exclusive transaction. It is movable but follows N1's non-Sync
/// single-actor discipline through the private lease it owns.
pub struct ProcessBoundTransaction<C: SoleContainer> {
    inner: Option<TransactionLease<GuardedAdapter<C>>>,
    lifecycle: LifecycleHandle,
}

impl<C: SoleContainer> ProcessBoundTransaction<C> {
    pub fn read(&mut self) -> Result<ProcessBoundSnapshot, NativeStoreErrorCode> {
        self.lifecycle
            .check_operational()
            .map_err(NativeStoreErrorCode::from)?;
        let result = self
            .inner
            .as_mut()
            .ok_or(NativeStoreErrorCode::StoreClosed)?
            .read();
        self.lifecycle
            .check_operational()
            .map_err(NativeStoreErrorCode::from)?;
        result
            .map(|snapshot| ProcessBoundSnapshot {
                inner: snapshot,
                opener_pid: self.lifecycle.opener_pid(),
            })
            .map_err(map_operation_error)
    }

    pub fn compare_and_publish(
        &mut self,
        expected: &ProcessBoundRevision,
        next_bytes: &[u8],
    ) -> Result<ProcessBoundPublishOutcome, NativeStoreErrorCode> {
        self.lifecycle
            .check_operational()
            .map_err(NativeStoreErrorCode::from)?;
        expected.check_current()?;
        let result = self
            .inner
            .as_mut()
            .ok_or(NativeStoreErrorCode::StoreClosed)?
            .compare_and_publish(&expected.inner, next_bytes);
        // A forked child must never inherit an N1 result. In the same process,
        // however, N1 Uncertain is the dominant publication-boundary outcome:
        // registry poison may be why an adapter action became unprovable and
        // must not rewrite that result to STORE_CLOSED.
        self.lifecycle
            .check_process()
            .map_err(NativeStoreErrorCode::from)?;
        if matches!(result, Ok(PublishOutcome::Uncertain)) {
            return Ok(ProcessBoundPublishOutcome::Uncertain);
        }
        self.lifecycle
            .check_operational()
            .map_err(NativeStoreErrorCode::from)?;
        result
            .map(|outcome| {
                ProcessBoundPublishOutcome::from_core(outcome, self.lifecycle.opener_pid())
            })
            .map_err(map_operation_error)
    }

    pub fn settle(mut self) -> Result<(), NativeStoreErrorCode> {
        if let Err(error) = self.lifecycle.check_process() {
            if let Some(lease) = self.inner.take() {
                mem::forget(lease);
            }
            return Err(error.into());
        }
        self.inner.take().expect("transaction lease").settle();
        self.lifecycle
            .check_process()
            .map_err(NativeStoreErrorCode::from)
    }
}

impl<C: SoleContainer> fmt::Debug for ProcessBoundTransaction<C> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ProcessBoundTransaction(<opaque>)")
    }
}

impl<C: SoleContainer> Drop for ProcessBoundTransaction<C> {
    fn drop(&mut self) {
        let Some(lease) = self.inner.take() else {
            return;
        };
        if self.lifecycle.check_process().is_err() {
            mem::forget(lease);
        } else {
            drop(lease);
        }
    }
}

/// Memory-only snapshot wrapper. The raw N1 snapshot and revision never escape.
pub struct ProcessBoundSnapshot {
    inner: Snapshot,
    opener_pid: u32,
}

impl ProcessBoundSnapshot {
    pub fn is_present(&self) -> Result<bool, NativeStoreErrorCode> {
        self.check_current()?;
        Ok(self.inner.bytes().is_some())
    }

    pub fn bytes(&self) -> Result<Option<&[u8]>, NativeStoreErrorCode> {
        self.check_current()?;
        Ok(self.inner.bytes())
    }

    /// Produces a new opaque revision wrapper only after a process-origin
    /// check. There is deliberately no infallible public `Clone`.
    pub fn revision(&self) -> Result<ProcessBoundRevision, NativeStoreErrorCode> {
        self.check_current()?;
        Ok(ProcessBoundRevision {
            inner: self.inner.revision().clone(),
            opener_pid: self.opener_pid,
        })
    }

    fn check_current(&self) -> Result<(), NativeStoreErrorCode> {
        if std::process::id() == self.opener_pid {
            Ok(())
        } else {
            Err(NativeStoreErrorCode::StoreClosed)
        }
    }
}

impl fmt::Debug for ProcessBoundSnapshot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ProcessBoundSnapshot(<opaque>)")
    }
}

/// Memory-only opaque revision wrapper.
pub struct ProcessBoundRevision {
    inner: Revision,
    opener_pid: u32,
}

impl ProcessBoundRevision {
    fn check_current(&self) -> Result<(), NativeStoreErrorCode> {
        if std::process::id() == self.opener_pid {
            Ok(())
        } else {
            Err(NativeStoreErrorCode::StoreClosed)
        }
    }
}

impl fmt::Debug for ProcessBoundRevision {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ProcessBoundRevision(<opaque>)")
    }
}

/// Closed publication result wrapper with no raw N1 types.
pub enum ProcessBoundPublishOutcome {
    Swapped(ProcessBoundSnapshot),
    AlreadySame(ProcessBoundSnapshot),
    Conflict(ProcessBoundSnapshot),
    Uncertain,
}

impl ProcessBoundPublishOutcome {
    fn from_core(outcome: PublishOutcome, opener_pid: u32) -> Self {
        match outcome {
            PublishOutcome::Swapped(current) => Self::Swapped(ProcessBoundSnapshot {
                inner: Snapshot::Present(current),
                opener_pid,
            }),
            PublishOutcome::AlreadySame(current) => Self::AlreadySame(ProcessBoundSnapshot {
                inner: Snapshot::Present(current),
                opener_pid,
            }),
            PublishOutcome::Conflict(current) => Self::Conflict(ProcessBoundSnapshot {
                inner: current,
                opener_pid,
            }),
            PublishOutcome::Uncertain => Self::Uncertain,
        }
    }
}

impl fmt::Debug for ProcessBoundPublishOutcome {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Swapped(_) => {
                formatter.write_str("ProcessBoundPublishOutcome::Swapped(<opaque>)")
            }
            Self::AlreadySame(_) => {
                formatter.write_str("ProcessBoundPublishOutcome::AlreadySame(<opaque>)")
            }
            Self::Conflict(_) => {
                formatter.write_str("ProcessBoundPublishOutcome::Conflict(<opaque>)")
            }
            Self::Uncertain => formatter.write_str("ProcessBoundPublishOutcome::Uncertain"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::process_lifecycle::{
        registry_boundary_entries_for_test, reserve_process_store_for_test,
        reserve_process_store_pair_for_test,
    };
    use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
    use std::sync::Arc;

    struct ForeignPidContainer {
        descriptor_operations: Arc<AtomicUsize>,
        final_closes: Arc<AtomicUsize>,
    }

    struct PoisonOnWriteContainer {
        poison_key: LifecycleHandle,
        writes: Arc<AtomicUsize>,
        final_closes: Arc<AtomicUsize>,
    }

    impl SoleContainer for PoisonOnWriteContainer {
        fn complete_platform_open(
            &mut self,
            fence: &DescriptorOperationFence,
            _spec: &ContainerSpec,
        ) -> Result<(), PlatformStoreFailure> {
            fence.check()
        }

        fn file_length(
            &self,
            fence: &DescriptorOperationFence,
        ) -> Result<u64, PlatformStoreFailure> {
            fence.check()?;
            Ok(container_spec().file_length())
        }

        fn read_exact_at(
            &self,
            fence: &DescriptorOperationFence,
            _absolute_offset: u64,
            output: &mut [u8],
        ) -> Result<(), PlatformStoreFailure> {
            fence.check()?;
            output.fill(0);
            Ok(())
        }

        fn write_all_at(
            &mut self,
            fence: &DescriptorOperationFence,
            _absolute_offset: u64,
            _bytes: &[u8],
        ) -> Result<(), PlatformStoreFailure> {
            fence.check()?;
            self.writes.fetch_add(1, Ordering::Relaxed);
            let poisoned = catch_unwind(AssertUnwindSafe(|| {
                let _: Result<(), PlatformStoreFailure> = self
                    .poison_key
                    .with_open_entry(|| panic!("poison another store key"));
            }));
            assert!(poisoned.is_err());
            Ok(())
        }

        fn payload_durability_barrier(
            &mut self,
            _fence: &DescriptorOperationFence,
        ) -> Result<(), PlatformStoreFailure> {
            panic!("post-write poison must stop before payload barrier")
        }

        fn header_and_container_durability_barrier(
            &mut self,
            _fence: &DescriptorOperationFence,
        ) -> Result<(), PlatformStoreFailure> {
            panic!("post-write poison must stop before final barrier")
        }

        fn final_close(
            &mut self,
            fence: &FinalCloseOperationFence,
        ) -> Result<(), PlatformStoreFailure> {
            fence.check()?;
            self.final_closes.fetch_add(1, Ordering::Relaxed);
            Ok(())
        }
    }

    impl SoleContainer for ForeignPidContainer {
        fn complete_platform_open(
            &mut self,
            fence: &DescriptorOperationFence,
            _spec: &ContainerSpec,
        ) -> Result<(), PlatformStoreFailure> {
            fence.check()?;
            self.descriptor_operations.fetch_add(1, Ordering::Relaxed);
            Ok(())
        }

        fn file_length(
            &self,
            fence: &DescriptorOperationFence,
        ) -> Result<u64, PlatformStoreFailure> {
            fence.check()?;
            self.descriptor_operations.fetch_add(1, Ordering::Relaxed);
            Ok(container_spec().file_length())
        }

        fn read_exact_at(
            &self,
            fence: &DescriptorOperationFence,
            _absolute_offset: u64,
            output: &mut [u8],
        ) -> Result<(), PlatformStoreFailure> {
            fence.check()?;
            self.descriptor_operations.fetch_add(1, Ordering::Relaxed);
            output.fill(0);
            Ok(())
        }

        fn write_all_at(
            &mut self,
            _fence: &DescriptorOperationFence,
            _absolute_offset: u64,
            _bytes: &[u8],
        ) -> Result<(), PlatformStoreFailure> {
            panic!("foreign-PID tests do not publish")
        }

        fn payload_durability_barrier(
            &mut self,
            _fence: &DescriptorOperationFence,
        ) -> Result<(), PlatformStoreFailure> {
            panic!("foreign-PID tests do not publish")
        }

        fn header_and_container_durability_barrier(
            &mut self,
            _fence: &DescriptorOperationFence,
        ) -> Result<(), PlatformStoreFailure> {
            panic!("foreign-PID tests do not publish")
        }

        fn final_close(
            &mut self,
            fence: &FinalCloseOperationFence,
        ) -> Result<(), PlatformStoreFailure> {
            fence.check()?;
            self.final_closes.fetch_add(1, Ordering::Relaxed);
            Ok(())
        }
    }

    fn fake_store(
        home_inode: u64,
        current_pid: Arc<AtomicU32>,
        descriptor_operations: Arc<AtomicUsize>,
        final_closes: Arc<AtomicUsize>,
    ) -> ProcessBoundStateStore<ForeignPidContainer> {
        let handle = reserve_process_store_for_test(
            VerifiedHomeIdentity::new(91, home_inode),
            700,
            current_pid,
        )
        .expect("test reservation");
        OpenReservation {
            handle: Some(handle),
        }
        .begin_descriptor_open()
        .expect("descriptor admission")
        .attach(ForeignPidContainer {
            descriptor_operations,
            final_closes,
        })
        .expect("attach")
        .finish()
        .expect("open zero container")
    }

    #[test]
    fn foreign_pid_public_use_is_closed_without_descriptor_io_and_drops_retain_n1_ownership() {
        for scenario in 0..5 {
            let current_pid = Arc::new(AtomicU32::new(700));
            let descriptor_operations = Arc::new(AtomicUsize::new(0));
            let final_closes = Arc::new(AtomicUsize::new(0));
            let store = fake_store(
                10_000 + scenario,
                Arc::clone(&current_pid),
                Arc::clone(&descriptor_operations),
                Arc::clone(&final_closes),
            );

            match scenario {
                0 => {
                    let before = descriptor_operations.load(Ordering::Relaxed);
                    let boundary_before = registry_boundary_entries_for_test(&store.lifecycle);
                    current_pid.store(701, Ordering::Release);
                    assert!(matches!(
                        store.admit(),
                        Err(NativeStoreErrorCode::StoreClosed)
                    ));
                    assert_eq!(descriptor_operations.load(Ordering::Relaxed), before);
                    assert_eq!(
                        registry_boundary_entries_for_test(&store.lifecycle),
                        boundary_before,
                        "foreign store use does not cross the registry/N1 admission boundary"
                    );
                }
                1 => {
                    let ticket = store.admit().expect("parent admission");
                    let before = descriptor_operations.load(Ordering::Relaxed);
                    current_pid.store(701, Ordering::Release);
                    assert!(matches!(
                        ticket.enter(),
                        Err(NativeStoreErrorCode::StoreClosed)
                    ));
                    assert_eq!(descriptor_operations.load(Ordering::Relaxed), before);
                }
                2 => {
                    let ticket = store.admit().expect("parent admission");
                    let before = descriptor_operations.load(Ordering::Relaxed);
                    current_pid.store(701, Ordering::Release);
                    drop(ticket);
                    assert_eq!(descriptor_operations.load(Ordering::Relaxed), before);
                }
                3 => {
                    let mut transaction = store
                        .admit()
                        .expect("parent admission")
                        .enter()
                        .expect("parent transaction");
                    let before = descriptor_operations.load(Ordering::Relaxed);
                    current_pid.store(701, Ordering::Release);
                    assert!(matches!(
                        transaction.read(),
                        Err(NativeStoreErrorCode::StoreClosed)
                    ));
                    assert!(matches!(
                        transaction.settle(),
                        Err(NativeStoreErrorCode::StoreClosed)
                    ));
                    assert_eq!(descriptor_operations.load(Ordering::Relaxed), before);
                }
                4 => {
                    let transaction = store
                        .admit()
                        .expect("parent admission")
                        .enter()
                        .expect("parent transaction");
                    let before = descriptor_operations.load(Ordering::Relaxed);
                    current_pid.store(701, Ordering::Release);
                    drop(transaction);
                    assert_eq!(descriptor_operations.load(Ordering::Relaxed), before);
                }
                _ => unreachable!(),
            }

            if scenario != 0 {
                // A foreign ticket/lease must retain its raw N1 Arc rather than
                // run N1 Drop/settle. Returning to the fake parent only makes
                // that ownership observable: dropping Store must not become
                // the final Arc and therefore must not close the container.
                current_pid.store(700, Ordering::Release);
            }
            drop(store);
            assert_eq!(final_closes.load(Ordering::Relaxed), 0);
        }
    }

    fn poison_store_registry<C: SoleContainer>(store: &ProcessBoundStateStore<C>) {
        let poisoned = catch_unwind(AssertUnwindSafe(|| {
            let _: Result<(), PlatformStoreFailure> = store
                .lifecycle
                .with_open_entry(|| panic!("poison registry"));
        }));
        assert!(poisoned.is_err());
        assert_eq!(
            store.lifecycle.check_operational(),
            Err(PlatformStoreFailure::Closed),
            "panic guard closes the fence immediately"
        );
    }

    #[test]
    fn same_pid_registry_poison_closes_public_use_but_releases_store_ticket_and_lease() {
        for scenario in 0..3 {
            let current_pid = Arc::new(AtomicU32::new(700));
            let descriptor_operations = Arc::new(AtomicUsize::new(0));
            let final_closes = Arc::new(AtomicUsize::new(0));
            let store = fake_store(
                20_000 + scenario,
                current_pid,
                descriptor_operations,
                Arc::clone(&final_closes),
            );

            match scenario {
                0 => {
                    poison_store_registry(&store);
                    assert!(matches!(
                        store.admit(),
                        Err(NativeStoreErrorCode::StoreClosed)
                    ));
                    drop(store);
                }
                1 => {
                    let ticket = store.admit().expect("parent admission");
                    poison_store_registry(&store);
                    assert!(matches!(
                        ticket.enter(),
                        Err(NativeStoreErrorCode::StoreClosed)
                    ));
                    assert_eq!(store.close(), Err(NativeStoreErrorCode::StoreClosed));
                    drop(store);
                }
                2 => {
                    let mut transaction = store
                        .admit()
                        .expect("parent admission")
                        .enter()
                        .expect("parent transaction");
                    poison_store_registry(&store);
                    assert!(matches!(
                        transaction.read(),
                        Err(NativeStoreErrorCode::StoreClosed)
                    ));
                    assert_eq!(transaction.settle(), Ok(()));
                    assert_eq!(store.close(), Err(NativeStoreErrorCode::StoreClosed));
                    drop(store);
                }
                _ => unreachable!(),
            }

            assert_eq!(
                final_closes.load(Ordering::Relaxed),
                1,
                "parent poison still attempts final close once"
            );
        }
    }

    #[test]
    fn publication_uncertain_survives_same_pid_registry_poison_postcheck() {
        let pid = std::process::id();
        let current_pid = Arc::new(AtomicU32::new(pid));
        let (store_handle, poison_handle) = reserve_process_store_pair_for_test(
            VerifiedHomeIdentity::new(92, 30_001),
            VerifiedHomeIdentity::new(92, 30_002),
            pid,
            current_pid,
        )
        .expect("paired reservations");
        poison_handle.mark_open().expect("open poison key");
        let writes = Arc::new(AtomicUsize::new(0));
        let final_closes = Arc::new(AtomicUsize::new(0));
        let store = OpenReservation {
            handle: Some(store_handle),
        }
        .begin_descriptor_open()
        .expect("descriptor admission")
        .attach(PoisonOnWriteContainer {
            poison_key: poison_handle,
            writes: Arc::clone(&writes),
            final_closes: Arc::clone(&final_closes),
        })
        .expect("attach")
        .finish()
        .expect("open zero container");

        let mut transaction = store
            .admit()
            .expect("admission")
            .enter()
            .expect("transaction");
        let revision = transaction
            .read()
            .expect("initial read")
            .revision()
            .expect("revision");
        assert!(matches!(
            transaction.compare_and_publish(&revision, b"next"),
            Ok(ProcessBoundPublishOutcome::Uncertain)
        ));
        assert_eq!(writes.load(Ordering::Relaxed), 1);
        transaction.settle().expect("settle terminal transaction");
        drop(store);
        assert_eq!(final_closes.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn all_private_core_error_mappings_remain_closed() {
        let cases = [
            (CoreError::Corrupt, NativeStoreErrorCode::StoreCorrupt),
            (
                CoreError::FormatUnsupported,
                NativeStoreErrorCode::StoreFormatUnsupported,
            ),
            (CoreError::Closed, NativeStoreErrorCode::StoreClosed),
            (
                CoreError::InvalidArgument,
                NativeStoreErrorCode::InvalidArgument,
            ),
            (
                CoreError::InvalidRevision,
                NativeStoreErrorCode::InvalidRevision,
            ),
            (
                CoreError::StateTooLarge,
                NativeStoreErrorCode::StateTooLarge,
            ),
            (
                CoreError::GenerationExhausted,
                NativeStoreErrorCode::GenerationExhausted,
            ),
        ];
        for (input, expected) in cases {
            assert_eq!(map_core_error(input), expected);
            assert_eq!(map_operation_error(OperationError::Core(input)), expected);
            assert_ne!(expected, NativeStoreErrorCode::NativeInterfaceInvalid);
        }
    }
}
