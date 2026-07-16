//! Owned admission, transaction lease, publication, poison, and close core.

use crate::binary_contract::{GENERATION_MAX, MAX_STATE_BYTES};
use crate::format::{
    encode_header, publication_target, select_container, AbsoluteRangeReader, ContainerSelection,
};
use crate::{CoreError, OperationError};
use sha2::{Digest, Sha256};
use std::cell::Cell;
use std::collections::VecDeque;
use std::fmt;
use std::marker::PhantomData;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};

static NEXT_STORE_ID: AtomicU64 = AtomicU64::new(1);

/// The complete ordered publication vocabulary exposed to a platform adapter.
///
/// Each write is an absolute range on the adapter's already-open single
/// container. A successful write action proves the complete slice was written;
/// the adapter owns short-write/interruption handling. The final barrier must
/// prove the header and any required container metadata durable.
pub enum PublicationAction<'a> {
    WritePayload {
        absolute_offset: u64,
        bytes: &'a [u8],
    },
    PayloadDurabilityBarrier,
    WriteHeader {
        absolute_offset: u64,
        bytes: &'a [u8],
    },
    HeaderAndContainerDurabilityBarrier,
}

/// Adapter seam for one already-open, exclusively owned single container.
///
/// Secure open, descriptor identity, kernel locking, and the OS implementation
/// of the durability actions are deliberately outside this crate.
pub trait PublicationAdapter: AbsoluteRangeReader {
    fn apply(&mut self, action: PublicationAction<'_>) -> Result<(), Self::Error>;

    /// Final native resource/lock action used by the core close barrier.
    fn close(&mut self) -> Result<(), Self::Error>;
}

#[derive(Clone, PartialEq, Eq)]
enum Observation {
    Missing,
    Present {
        generation: u64,
        payload_digest: [u8; 32],
    },
}

/// Opaque revision issued by one transaction lease. Its representation,
/// generation, and store identity are intentionally unavailable to callers.
#[derive(Clone)]
pub struct Revision {
    store_id: u64,
    transaction_id: u64,
    observation: Observation,
}

impl fmt::Debug for Revision {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Revision(<opaque>)")
    }
}

#[derive(Clone)]
pub struct PresentSnapshot {
    revision: Revision,
    bytes: Vec<u8>,
}

impl PresentSnapshot {
    pub fn revision(&self) -> &Revision {
        &self.revision
    }

    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
}

impl fmt::Debug for PresentSnapshot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PresentSnapshot")
            .field("revision", &self.revision)
            .field("byte_length", &self.bytes.len())
            .finish()
    }
}

#[derive(Clone, Debug)]
pub enum Snapshot {
    Missing { revision: Revision },
    Present(PresentSnapshot),
}

impl Snapshot {
    pub fn revision(&self) -> &Revision {
        match self {
            Self::Missing { revision } => revision,
            Self::Present(current) => current.revision(),
        }
    }

    pub fn bytes(&self) -> Option<&[u8]> {
        match self {
            Self::Missing { .. } => None,
            Self::Present(current) => Some(current.bytes()),
        }
    }
}

#[derive(Clone, Debug)]
pub enum PublishOutcome {
    Swapped(PresentSnapshot),
    AlreadySame(PresentSnapshot),
    Conflict(Snapshot),
    Uncertain,
}

enum ClosePhase<AdapterError> {
    Open,
    Closing,
    Closed(Result<(), AdapterError>),
}

struct Lifecycle<AdapterError> {
    accepting: bool,
    terminal_poisoned: bool,
    admitted: usize,
    next_ticket: u64,
    queued: VecDeque<u64>,
    active: Option<u64>,
    close_phase: ClosePhase<AdapterError>,
}

struct Inner<I: PublicationAdapter> {
    store_id: u64,
    lifecycle: Mutex<Lifecycle<I::Error>>,
    lifecycle_changed: Condvar,
    adapter: Mutex<I>,
}

/// Cloneable handle to one adapter/store instance. Clones share ticket order,
/// poison, serialization, and the final close barrier.
pub struct StateStore<I: PublicationAdapter> {
    inner: Arc<Inner<I>>,
}

impl<I: PublicationAdapter> Clone for StateStore<I> {
    fn clone(&self) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
        }
    }
}

impl<I> StateStore<I>
where
    I: PublicationAdapter,
    I::Error: Clone,
{
    /// Validates frozen container selection before admitting transactions.
    /// Platform open/self-check must already have succeeded.
    pub fn from_adapter(mut adapter: I) -> Result<Self, OperationError<I::Error>> {
        if let Err(primary) = select_container(Some(&adapter)) {
            // Ownership has already crossed into core. Close exactly once on
            // every rejected self-check and preserve the primary selection
            // cause even if the cleanup action also reports an error.
            let _ = adapter.close();
            return Err(primary);
        }
        Ok(Self {
            inner: Arc::new(Inner {
                store_id: next_store_id(),
                lifecycle: Mutex::new(Lifecycle {
                    accepting: true,
                    terminal_poisoned: false,
                    admitted: 0,
                    next_ticket: 1,
                    queued: VecDeque::new(),
                    active: None,
                    close_phase: ClosePhase::Open,
                }),
                lifecycle_changed: Condvar::new(),
                adapter: Mutex::new(adapter),
            }),
        })
    }

    /// Registers an owned FIFO admission before an ordinary close barrier can
    /// begin. The returned ticket may cross an event loop or worker boundary.
    pub fn admit(&self) -> Result<AdmissionTicket<I>, CoreError> {
        let mut lifecycle = lock(&self.inner.lifecycle);
        if !lifecycle.accepting {
            return Err(CoreError::Closed);
        }
        let ticket_id = lifecycle.next_ticket;
        lifecycle.next_ticket = lifecycle
            .next_ticket
            .checked_add(1)
            .expect("transaction ticket identity space exhausted");
        lifecycle.admitted = lifecycle
            .admitted
            .checked_add(1)
            .expect("admission count cannot overflow in one process");
        lifecycle.queued.push_back(ticket_id);
        self.inner.lifecycle_changed.notify_all();
        Ok(AdmissionTicket {
            inner: Some(Arc::clone(&self.inner)),
            ticket_id,
            registered: true,
        })
    }

    /// Starts ordinary close, rejects new admission, drains all earlier owned
    /// tickets/leases, then performs exactly one final adapter close. Concurrent
    /// and repeated callers observe the cached result.
    pub fn close(&self) -> Result<(), I::Error> {
        let mut lifecycle = lock(&self.inner.lifecycle);
        loop {
            match &lifecycle.close_phase {
                ClosePhase::Open => {
                    lifecycle.accepting = false;
                    lifecycle.close_phase = ClosePhase::Closing;
                    self.inner.lifecycle_changed.notify_all();
                    while lifecycle.admitted != 0 {
                        lifecycle = wait(&self.inner.lifecycle_changed, lifecycle);
                    }
                    break;
                }
                ClosePhase::Closing => {
                    lifecycle = wait(&self.inner.lifecycle_changed, lifecycle);
                }
                ClosePhase::Closed(result) => return result.clone(),
            }
        }
        drop(lifecycle);

        let result = lock(&self.inner.adapter).close();
        let mut lifecycle = lock(&self.inner.lifecycle);
        lifecycle.close_phase = ClosePhase::Closed(result.clone());
        self.inner.lifecycle_changed.notify_all();
        result
    }
}

/// Owned admission that has not yet entered the exclusive transaction turn.
/// Dropping a queued ticket cancels that admission and unblocks close/next turn.
pub struct AdmissionTicket<I: PublicationAdapter> {
    inner: Option<Arc<Inner<I>>>,
    ticket_id: u64,
    registered: bool,
}

impl<I> fmt::Debug for AdmissionTicket<I>
where
    I: PublicationAdapter,
{
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("AdmissionTicket(<opaque>)")
    }
}

impl<I> AdmissionTicket<I>
where
    I: PublicationAdapter,
    I::Error: Clone,
{
    /// Waits for this FIFO turn without holding the adapter mutex. A future
    /// async binding can run this blocking wait on its worker and retain the
    /// returned owned lease across JS Promise settlement.
    pub fn enter(mut self) -> Result<TransactionLease<I>, CoreError> {
        let inner = Arc::clone(self.inner.as_ref().expect("ticket inner exists"));
        let mut lifecycle = lock(&inner.lifecycle);
        loop {
            if lifecycle.terminal_poisoned {
                if remove_ticket(&mut lifecycle.queued, self.ticket_id) {
                    lifecycle.admitted -= 1;
                }
                self.registered = false;
                inner.lifecycle_changed.notify_all();
                return Err(CoreError::Closed);
            }
            if lifecycle.active.is_none()
                && lifecycle.queued.front().copied() == Some(self.ticket_id)
            {
                lifecycle.queued.pop_front();
                lifecycle.active = Some(self.ticket_id);
                self.registered = false;
                drop(lifecycle);
                return Ok(TransactionLease {
                    inner: self.inner.take().expect("ticket inner exists"),
                    transaction_id: self.ticket_id,
                    settled: false,
                    not_sync: PhantomData,
                });
            }
            lifecycle = wait(&inner.lifecycle_changed, lifecycle);
        }
    }
}

impl<I: PublicationAdapter> Drop for AdmissionTicket<I> {
    fn drop(&mut self) {
        if !self.registered {
            return;
        }
        let Some(inner) = &self.inner else {
            return;
        };
        let mut lifecycle = lock(&inner.lifecycle);
        if remove_ticket(&mut lifecycle.queued, self.ticket_id) {
            lifecycle.admitted -= 1;
            inner.lifecycle_changed.notify_all();
        }
        self.registered = false;
    }
}

/// Owned exclusive turn. It holds no adapter `MutexGuard` or callback borrow;
/// each operation locks the adapter only for its synchronous range/action work.
pub struct TransactionLease<I: PublicationAdapter> {
    inner: Arc<Inner<I>>,
    transaction_id: u64,
    settled: bool,
    // A transaction is an owned serial actor. It may move to a worker, but a
    // binding must not share one lease across concurrent worker operations.
    not_sync: PhantomData<Cell<()>>,
}

impl<I> fmt::Debug for TransactionLease<I>
where
    I: PublicationAdapter,
{
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("TransactionLease(<opaque>)")
    }
}

impl<I> TransactionLease<I>
where
    I: PublicationAdapter,
    I::Error: Clone,
{
    pub fn read(&mut self) -> Result<Snapshot, OperationError<I::Error>> {
        self.ensure_usable()?;
        let adapter = lock(&self.inner.adapter);
        self.ensure_usable()?;
        let snapshot = self.read_fresh(&*adapter)?;
        self.ensure_usable()?;
        Ok(snapshot)
    }

    pub fn compare_and_publish(
        &mut self,
        expected: &Revision,
        next_bytes: &[u8],
    ) -> Result<PublishOutcome, OperationError<I::Error>> {
        self.ensure_usable()?;
        self.validate_revision_scope(expected)?;
        if next_bytes.is_empty() {
            return Err(CoreError::InvalidArgument.into());
        }
        if next_bytes.len() > MAX_STATE_BYTES {
            return Err(CoreError::StateTooLarge.into());
        }
        // Complete before the first range read or publication action.
        let copied = next_bytes.to_vec();
        let mut adapter = lock(&self.inner.adapter);
        self.ensure_usable()?;
        let current = self.read_fresh(&*adapter)?;

        // Frozen precedence: equal current bytes converge even when the
        // supplied transaction-local revision is stale.
        if current.bytes() == Some(copied.as_slice()) {
            let Snapshot::Present(current) = current else {
                unreachable!("equal non-empty bytes require present current state");
            };
            return Ok(PublishOutcome::AlreadySame(current));
        }
        if expected.observation != current.revision().observation {
            return Ok(PublishOutcome::Conflict(current));
        }

        let next_generation = match &current {
            Snapshot::Missing { .. } => 1,
            Snapshot::Present(current) => {
                let Observation::Present { generation, .. } = current.revision.observation else {
                    unreachable!("present snapshot has present observation");
                };
                if generation == GENERATION_MAX {
                    return Err(CoreError::GenerationExhausted.into());
                }
                generation + 1
            }
        };
        let target = publication_target(next_generation)?;
        let header = encode_header(next_generation, &copied)?;
        let actions = [
            PublicationAction::WritePayload {
                absolute_offset: target.payload_offset,
                bytes: &copied,
            },
            PublicationAction::PayloadDurabilityBarrier,
            PublicationAction::WriteHeader {
                absolute_offset: target.header_offset,
                bytes: &header,
            },
            PublicationAction::HeaderAndContainerDurabilityBarrier,
        ];
        for action in actions {
            if adapter.apply(action).is_err() {
                self.poison();
                return Ok(PublishOutcome::Uncertain);
            }
        }

        // Swapped requires a fresh selector proof after all durability actions.
        match self.read_fresh(&*adapter) {
            Ok(Snapshot::Present(current))
                if current.bytes() == copied.as_slice()
                    && matches!(
                        current.revision.observation,
                        Observation::Present { generation, .. } if generation == next_generation
                    ) =>
            {
                Ok(PublishOutcome::Swapped(current))
            }
            Ok(_) | Err(_) => {
                self.poison();
                Ok(PublishOutcome::Uncertain)
            }
        }
    }

    /// Explicit Promise/callback settlement. Drop has identical semantics.
    pub fn settle(mut self) {
        self.release();
    }

    fn read_fresh(&self, adapter: &I) -> Result<Snapshot, OperationError<I::Error>> {
        let selection = select_container(Some(adapter))?;
        Ok(match selection {
            ContainerSelection::Missing => Snapshot::Missing {
                revision: self.revision(Observation::Missing),
            },
            ContainerSelection::Present(state) => {
                let (generation, bytes) = state.into_parts();
                let payload_digest = Sha256::digest(&bytes).into();
                Snapshot::Present(PresentSnapshot {
                    revision: self.revision(Observation::Present {
                        generation,
                        payload_digest,
                    }),
                    bytes,
                })
            }
        })
    }

    fn revision(&self, observation: Observation) -> Revision {
        Revision {
            store_id: self.inner.store_id,
            transaction_id: self.transaction_id,
            observation,
        }
    }

    fn validate_revision_scope(&self, revision: &Revision) -> Result<(), CoreError> {
        if revision.store_id != self.inner.store_id
            || revision.transaction_id != self.transaction_id
        {
            return Err(CoreError::InvalidRevision);
        }
        Ok(())
    }

    fn ensure_usable(&self) -> Result<(), CoreError> {
        let lifecycle = lock(&self.inner.lifecycle);
        if lifecycle.terminal_poisoned
            || lifecycle.active != Some(self.transaction_id)
            || self.settled
        {
            return Err(CoreError::Closed);
        }
        Ok(())
    }

    fn poison(&self) {
        let mut lifecycle = lock(&self.inner.lifecycle);
        if lifecycle.terminal_poisoned {
            return;
        }
        lifecycle.terminal_poisoned = true;
        lifecycle.accepting = false;
        let cancelled = lifecycle.queued.len();
        lifecycle.queued.clear();
        lifecycle.admitted -= cancelled;
        self.inner.lifecycle_changed.notify_all();
    }
}

impl<I: PublicationAdapter> TransactionLease<I> {
    fn release(&mut self) {
        if self.settled {
            return;
        }
        let mut lifecycle = lock(&self.inner.lifecycle);
        if lifecycle.active == Some(self.transaction_id) {
            lifecycle.active = None;
            lifecycle.admitted -= 1;
            self.inner.lifecycle_changed.notify_all();
        }
        self.settled = true;
    }
}

impl<I: PublicationAdapter> Drop for TransactionLease<I> {
    fn drop(&mut self) {
        self.release();
    }
}

fn remove_ticket(queue: &mut VecDeque<u64>, ticket_id: u64) -> bool {
    let Some(position) = queue.iter().position(|queued| *queued == ticket_id) else {
        return false;
    };
    queue.remove(position);
    true
}

fn next_store_id() -> u64 {
    let value = NEXT_STORE_ID.fetch_add(1, Ordering::Relaxed);
    assert_ne!(value, 0, "opaque store identity space exhausted");
    value
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn wait<'a, T>(condvar: &Condvar, guard: MutexGuard<'a, T>) -> MutexGuard<'a, T> {
    condvar
        .wait(guard)
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::binary_contract::{
        CONTAINER_FILE_LENGTH, GENERATION_MAX, HEADER0_OFFSET, HEADER1_OFFSET, HEADER_BYTES,
        HEADER_CHECKSUM_COVER_LENGTH, HEADER_CHECKSUM_COVER_OFFSET, HEADER_CHECKSUM_LENGTH,
        HEADER_CHECKSUM_OFFSET, HEADER_MAGIC_OFFSET, PAYLOAD0_OFFSET, PAYLOAD1_OFFSET,
    };
    use std::collections::BTreeMap;
    use std::sync::mpsc;
    use std::thread;

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum MemoryError {
        Injected,
        Range,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum WriteCut {
        Before,
        Partial,
        After,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum FaultPoint {
        PayloadWrite(WriteCut),
        PayloadBarrier,
        HeaderWrite(WriteCut),
        FinalBarrier,
        VerifyRead,
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    enum RecordedAction {
        PayloadWrite { offset: u64, length: usize },
        PayloadBarrier,
        HeaderWrite { offset: u64, length: usize },
        FinalBarrier,
    }

    struct MemoryState {
        bytes: BTreeMap<u64, u8>,
        actions: Vec<RecordedAction>,
        fault: Option<FaultPoint>,
        fail_reads: bool,
        close_count: usize,
    }

    #[derive(Clone)]
    struct MemoryAdapter {
        state: Arc<Mutex<MemoryState>>,
    }

    impl MemoryAdapter {
        fn empty() -> Self {
            Self {
                state: Arc::new(Mutex::new(MemoryState {
                    bytes: BTreeMap::new(),
                    actions: Vec::new(),
                    fault: None,
                    fail_reads: false,
                    close_count: 0,
                })),
            }
        }

        fn set_fault(&self, fault: FaultPoint) {
            lock(&self.state).fault = Some(fault);
        }

        fn fail_reads(&self) {
            lock(&self.state).fail_reads = true;
        }

        fn clear_actions(&self) {
            lock(&self.state).actions.clear();
        }

        fn actions(&self) -> Vec<RecordedAction> {
            lock(&self.state).actions.clone()
        }

        fn close_count(&self) -> usize {
            lock(&self.state).close_count
        }

        fn seed_generation(&self, generation: u64, payload: &[u8]) {
            let target = publication_target(generation).expect("valid seed generation");
            let header = encode_header(generation, payload).expect("valid seed header");
            let mut state = lock(&self.state);
            write_range(
                &mut state.bytes,
                target.payload_offset,
                payload,
                payload.len(),
            );
            write_range(
                &mut state.bytes,
                target.header_offset,
                &header,
                header.len(),
            );
        }

        fn seed_initial_residue(&self) {
            lock(&self.state).bytes.insert(PAYLOAD0_OFFSET, 1);
        }

        fn seed_unknown_format(&self) {
            let payload = b"state";
            let mut header = encode_header(1, payload).expect("seed header");
            header[HEADER_MAGIC_OFFSET] ^= 1;
            let checksum = Sha256::digest(
                &header[HEADER_CHECKSUM_COVER_OFFSET
                    ..HEADER_CHECKSUM_COVER_OFFSET + HEADER_CHECKSUM_COVER_LENGTH],
            );
            header[HEADER_CHECKSUM_OFFSET..HEADER_CHECKSUM_OFFSET + HEADER_CHECKSUM_LENGTH]
                .copy_from_slice(&checksum);
            let mut state = lock(&self.state);
            write_range(&mut state.bytes, PAYLOAD0_OFFSET, payload, payload.len());
            write_range(&mut state.bytes, HEADER0_OFFSET, &header, header.len());
        }
    }

    impl AbsoluteRangeReader for MemoryAdapter {
        type Error = MemoryError;

        fn file_length(&self) -> Result<u64, Self::Error> {
            Ok(CONTAINER_FILE_LENGTH)
        }

        fn read_exact_at(
            &self,
            absolute_offset: u64,
            output: &mut [u8],
        ) -> Result<(), Self::Error> {
            let end = absolute_offset
                .checked_add(output.len() as u64)
                .ok_or(MemoryError::Range)?;
            if end > CONTAINER_FILE_LENGTH {
                return Err(MemoryError::Range);
            }
            let mut state = lock(&self.state);
            if state.fail_reads {
                return Err(MemoryError::Injected);
            }
            if state.fault == Some(FaultPoint::VerifyRead) && state.actions.len() == 4 {
                state.fault = None;
                return Err(MemoryError::Injected);
            }
            output.fill(0);
            for (&offset, &byte) in state.bytes.range(absolute_offset..end) {
                output[usize::try_from(offset - absolute_offset).expect("bounded range")] = byte;
            }
            Ok(())
        }
    }

    impl PublicationAdapter for MemoryAdapter {
        fn apply(&mut self, action: PublicationAction<'_>) -> Result<(), Self::Error> {
            let mut state = lock(&self.state);
            match action {
                PublicationAction::WritePayload {
                    absolute_offset,
                    bytes,
                } => {
                    state.actions.push(RecordedAction::PayloadWrite {
                        offset: absolute_offset,
                        length: bytes.len(),
                    });
                    let fault = match state.fault {
                        Some(FaultPoint::PayloadWrite(cut)) => Some(cut),
                        _ => None,
                    };
                    let count = write_count(fault, bytes.len());
                    write_range(&mut state.bytes, absolute_offset, bytes, count);
                    if fault.is_some() {
                        state.fault = None;
                        return Err(MemoryError::Injected);
                    }
                }
                PublicationAction::PayloadDurabilityBarrier => {
                    state.actions.push(RecordedAction::PayloadBarrier);
                    if state.fault == Some(FaultPoint::PayloadBarrier) {
                        state.fault = None;
                        return Err(MemoryError::Injected);
                    }
                }
                PublicationAction::WriteHeader {
                    absolute_offset,
                    bytes,
                } => {
                    state.actions.push(RecordedAction::HeaderWrite {
                        offset: absolute_offset,
                        length: bytes.len(),
                    });
                    let fault = match state.fault {
                        Some(FaultPoint::HeaderWrite(cut)) => Some(cut),
                        _ => None,
                    };
                    let count = write_count(fault, bytes.len());
                    write_range(&mut state.bytes, absolute_offset, bytes, count);
                    if fault.is_some() {
                        state.fault = None;
                        return Err(MemoryError::Injected);
                    }
                }
                PublicationAction::HeaderAndContainerDurabilityBarrier => {
                    state.actions.push(RecordedAction::FinalBarrier);
                    if state.fault == Some(FaultPoint::FinalBarrier) {
                        state.fault = None;
                        return Err(MemoryError::Injected);
                    }
                }
            }
            Ok(())
        }

        fn close(&mut self) -> Result<(), Self::Error> {
            lock(&self.state).close_count += 1;
            Ok(())
        }
    }

    fn write_count(fault: Option<WriteCut>, length: usize) -> usize {
        match fault {
            Some(WriteCut::Before) => 0,
            Some(WriteCut::Partial) => (length / 2).max(1),
            Some(WriteCut::After) | None => length,
        }
    }

    fn write_range(destination: &mut BTreeMap<u64, u8>, offset: u64, bytes: &[u8], count: usize) {
        for (index, byte) in bytes[..count].iter().copied().enumerate() {
            let position = offset + index as u64;
            if byte == 0 {
                destination.remove(&position);
            } else {
                destination.insert(position, byte);
            }
        }
    }

    fn operation_core<T>(result: Result<T, OperationError<MemoryError>>) -> Result<T, CoreError> {
        match result {
            Ok(value) => Ok(value),
            Err(OperationError::Core(error)) => Err(error),
            Err(OperationError::Adapter(error)) => panic!("unexpected memory error: {error:?}"),
        }
    }

    fn selected_core(adapter: &MemoryAdapter) -> Result<ContainerSelection, CoreError> {
        operation_core(select_container(Some(adapter)))
    }

    fn expect_present(selection: Result<ContainerSelection, CoreError>) -> (u64, Vec<u8>) {
        let ContainerSelection::Present(current) = selection.expect("valid present container")
        else {
            panic!("expected present container");
        };
        current.into_parts()
    }

    fn new_store() -> (StateStore<MemoryAdapter>, MemoryAdapter) {
        let adapter = MemoryAdapter::empty();
        let store = StateStore::from_adapter(adapter.clone()).expect("valid empty container");
        (store, adapter)
    }

    fn enter(store: &StateStore<MemoryAdapter>) -> TransactionLease<MemoryAdapter> {
        store
            .admit()
            .expect("admit transaction")
            .enter()
            .expect("enter transaction")
    }

    #[test]
    fn rejected_self_checks_close_owned_adapter_once_and_preserve_primary_cause() {
        let corrupt = MemoryAdapter::empty();
        corrupt.seed_initial_residue();
        match StateStore::from_adapter(corrupt.clone()) {
            Err(OperationError::Core(CoreError::Corrupt)) => {}
            _ => panic!("corrupt self-check must preserve its primary cause"),
        }
        assert_eq!(corrupt.close_count(), 1);

        let unsupported = MemoryAdapter::empty();
        unsupported.seed_unknown_format();
        match StateStore::from_adapter(unsupported.clone()) {
            Err(OperationError::Core(CoreError::FormatUnsupported)) => {}
            _ => panic!("unknown format must preserve its primary cause"),
        }
        assert_eq!(unsupported.close_count(), 1);

        let unreadable = MemoryAdapter::empty();
        unreadable.fail_reads();
        match StateStore::from_adapter(unreadable.clone()) {
            Err(OperationError::Adapter(MemoryError::Injected)) => {}
            _ => panic!("adapter read failure must remain the primary cause"),
        }
        assert_eq!(unreadable.close_count(), 1);
    }

    #[test]
    fn publications_emit_only_the_frozen_absolute_action_order() {
        let (store, adapter) = new_store();
        let mut lease = enter(&store);
        let missing = lease.read().expect("read missing");
        let first = lease
            .compare_and_publish(missing.revision(), b"alpha")
            .expect("publish generation one");
        let PublishOutcome::Swapped(first) = first else {
            panic!("first publication must swap");
        };
        let second = lease
            .compare_and_publish(first.revision(), b"beta")
            .expect("publish generation two");
        assert!(matches!(second, PublishOutcome::Swapped(_)));
        lease.settle();

        assert_eq!(
            adapter.actions(),
            [
                RecordedAction::PayloadWrite {
                    offset: PAYLOAD0_OFFSET,
                    length: 5,
                },
                RecordedAction::PayloadBarrier,
                RecordedAction::HeaderWrite {
                    offset: HEADER0_OFFSET,
                    length: HEADER_BYTES,
                },
                RecordedAction::FinalBarrier,
                RecordedAction::PayloadWrite {
                    offset: PAYLOAD1_OFFSET,
                    length: 4,
                },
                RecordedAction::PayloadBarrier,
                RecordedAction::HeaderWrite {
                    offset: HEADER1_OFFSET,
                    length: HEADER_BYTES,
                },
                RecordedAction::FinalBarrier,
            ]
        );
        assert_eq!(
            expect_present(selected_core(&adapter)),
            (2, b"beta".to_vec())
        );
        store.close().expect("close store");
    }

    #[test]
    fn same_bytes_precede_conflict_and_fresh_conflict_revision_converges() {
        let (store, _) = new_store();
        let mut lease = enter(&store);
        let missing = lease.read().expect("read missing");
        let stale = missing.revision().clone();
        assert!(matches!(
            lease
                .compare_and_publish(&stale, b"alpha")
                .expect("first publication"),
            PublishOutcome::Swapped(_)
        ));

        let same = lease
            .compare_and_publish(&stale, b"alpha")
            .expect("same bytes converge before stale conflict");
        let PublishOutcome::AlreadySame(current) = same else {
            panic!("same bytes must win over revision conflict");
        };
        assert_eq!(current.bytes(), b"alpha");

        let conflict = lease
            .compare_and_publish(&stale, b"beta")
            .expect("stale changed bytes conflict");
        let PublishOutcome::Conflict(current) = conflict else {
            panic!("changed bytes with stale revision must conflict");
        };
        assert_eq!(current.bytes(), Some(b"alpha".as_slice()));
        assert!(matches!(
            lease
                .compare_and_publish(current.revision(), b"beta")
                .expect("fresh conflict revision can converge"),
            PublishOutcome::Swapped(_)
        ));
        lease.settle();
        store.close().expect("close store");
    }

    #[test]
    fn revisions_are_valid_only_in_the_issuing_lease_and_store() {
        let (store, adapter) = new_store();
        let mut lease = enter(&store);
        let escaped = lease.read().expect("read").revision().clone();
        lease.settle();
        adapter.clear_actions();

        let mut next = enter(&store);
        assert!(matches!(
            operation_core(next.compare_and_publish(&escaped, b"alpha")),
            Err(CoreError::InvalidRevision)
        ));
        next.settle();

        let (other_store, _) = new_store();
        let mut other = enter(&other_store);
        assert!(matches!(
            operation_core(other.compare_and_publish(&escaped, b"alpha")),
            Err(CoreError::InvalidRevision)
        ));
        other.settle();
        assert!(adapter.actions().is_empty());
        store.close().expect("close first store");
        other_store.close().expect("close other store");
    }

    #[test]
    fn same_bytes_still_converge_at_generation_max_before_exhaustion() {
        let adapter = MemoryAdapter::empty();
        adapter.seed_generation(GENERATION_MAX - 1, b"previous");
        adapter.seed_generation(GENERATION_MAX, b"maximum");
        let store = StateStore::from_adapter(adapter.clone()).expect("valid maximum generations");
        adapter.clear_actions();
        let mut lease = enter(&store);
        let current = lease.read().expect("read maximum");
        assert!(matches!(
            lease
                .compare_and_publish(current.revision(), b"maximum")
                .expect("same bytes do not need a generation"),
            PublishOutcome::AlreadySame(_)
        ));
        assert!(matches!(
            operation_core(lease.compare_and_publish(current.revision(), b"next")),
            Err(CoreError::GenerationExhausted)
        ));
        lease.settle();
        assert!(adapter.actions().is_empty());
        store.close().expect("close store");
    }

    #[derive(Debug, Clone, Copy)]
    enum CrashSelection {
        Missing,
        Corrupt,
        Previous,
        Next,
    }

    #[test]
    fn every_two_stage_publication_breakpoint_has_a_sparse_crash_semantic() {
        let cases = [
            (
                FaultPoint::PayloadWrite(WriteCut::Before),
                CrashSelection::Missing,
                CrashSelection::Previous,
            ),
            (
                FaultPoint::PayloadWrite(WriteCut::Partial),
                CrashSelection::Corrupt,
                CrashSelection::Previous,
            ),
            (
                FaultPoint::PayloadWrite(WriteCut::After),
                CrashSelection::Corrupt,
                CrashSelection::Previous,
            ),
            (
                FaultPoint::PayloadBarrier,
                CrashSelection::Corrupt,
                CrashSelection::Previous,
            ),
            (
                FaultPoint::HeaderWrite(WriteCut::Before),
                CrashSelection::Corrupt,
                CrashSelection::Previous,
            ),
            (
                FaultPoint::HeaderWrite(WriteCut::Partial),
                CrashSelection::Corrupt,
                CrashSelection::Corrupt,
            ),
            (
                FaultPoint::HeaderWrite(WriteCut::After),
                CrashSelection::Next,
                CrashSelection::Next,
            ),
            (
                FaultPoint::FinalBarrier,
                CrashSelection::Next,
                CrashSelection::Next,
            ),
            (
                FaultPoint::VerifyRead,
                CrashSelection::Next,
                CrashSelection::Next,
            ),
        ];

        for (fault, initial_expected, successor_expected) in cases {
            let (store, adapter) = new_store();
            adapter.set_fault(fault);
            let mut lease = enter(&store);
            let current = lease.read().expect("initial read");
            let outcome = lease
                .compare_and_publish(current.revision(), b"next")
                .expect("fault is represented as uncertain");
            assert!(matches!(outcome, PublishOutcome::Uncertain), "{fault:?}");
            lease.settle();
            assert_crash_selection(&adapter, initial_expected, b"", b"next", fault);
            store.close().expect("close poisoned initial store");

            let (store, adapter) = new_store();
            let mut lease = enter(&store);
            let current = lease.read().expect("initial read");
            assert!(matches!(
                lease
                    .compare_and_publish(current.revision(), b"previous")
                    .expect("seed previous"),
                PublishOutcome::Swapped(_)
            ));
            lease.settle();
            adapter.clear_actions();
            adapter.set_fault(fault);
            let mut lease = enter(&store);
            let current = lease.read().expect("read previous");
            let outcome = lease
                .compare_and_publish(current.revision(), b"next")
                .expect("fault is represented as uncertain");
            assert!(matches!(outcome, PublishOutcome::Uncertain), "{fault:?}");
            lease.settle();
            assert_crash_selection(&adapter, successor_expected, b"previous", b"next", fault);
            store.close().expect("close poisoned successor store");
        }
    }

    fn assert_crash_selection(
        adapter: &MemoryAdapter,
        expected: CrashSelection,
        previous: &[u8],
        next: &[u8],
        fault: FaultPoint,
    ) {
        match expected {
            CrashSelection::Missing => assert_eq!(
                selected_core(adapter),
                Ok(ContainerSelection::Missing),
                "{fault:?}"
            ),
            CrashSelection::Corrupt => {
                assert_eq!(selected_core(adapter), Err(CoreError::Corrupt), "{fault:?}")
            }
            CrashSelection::Previous => assert_eq!(
                expect_present(selected_core(adapter)).1,
                previous,
                "{fault:?}"
            ),
            CrashSelection::Next => {
                assert_eq!(expect_present(selected_core(adapter)).1, next, "{fault:?}")
            }
        }
    }

    #[test]
    fn uncertain_poisons_active_operations_and_cancels_queued_tickets() {
        let (store, adapter) = new_store();
        let mut lease = enter(&store);
        let queued = store.admit().expect("queued admission before poison");
        adapter.set_fault(FaultPoint::FinalBarrier);
        let current = lease.read().expect("read initial");
        assert!(matches!(
            lease
                .compare_and_publish(current.revision(), b"next")
                .expect("closed uncertain outcome"),
            PublishOutcome::Uncertain
        ));
        assert!(matches!(
            operation_core(lease.read()),
            Err(CoreError::Closed)
        ));
        assert_eq!(queued.enter().err(), Some(CoreError::Closed));
        assert!(matches!(store.admit(), Err(CoreError::Closed)));
        lease.settle();
        store.close().expect("explicit close after poison");
        assert_eq!(adapter.close_count(), 1);
    }

    #[test]
    fn fifo_owned_leases_and_close_barrier_drain_preexisting_tickets_once() {
        let (store, adapter) = new_store();
        let mut first = enter(&store);
        let second_ticket = store.admit().expect("second queued admission");
        let third_ticket = store.admit().expect("third queued admission");

        let (second_entered_tx, second_entered_rx) = mpsc::channel();
        let (release_second_tx, release_second_rx) = mpsc::channel();
        let second = thread::spawn(move || {
            let mut lease = second_ticket.enter().expect("second enters FIFO turn");
            second_entered_tx.send(()).expect("signal second entered");
            release_second_rx.recv().expect("release second lease");
            let current = lease.read().expect("read during ordinary close");
            assert!(matches!(
                lease
                    .compare_and_publish(current.revision(), b"after-barrier")
                    .expect("publish during ordinary close"),
                PublishOutcome::Swapped(_)
            ));
            lease.settle();
        });

        let (third_entered_tx, third_entered_rx) = mpsc::channel();
        let third = thread::spawn(move || {
            let mut lease = third_ticket.enter().expect("third enters FIFO turn");
            third_entered_tx.send(()).expect("signal third entered");
            lease.read().expect("third remains usable during close");
            lease.settle();
        });
        assert!(second_entered_rx.try_recv().is_err());
        assert!(third_entered_rx.try_recv().is_err());

        let close_one_store = store.clone();
        let close_one = thread::spawn(move || close_one_store.close());
        wait_for_admission_barrier(&store);
        let close_two_store = store.clone();
        let close_two = thread::spawn(move || close_two_store.close());
        assert!(matches!(store.admit(), Err(CoreError::Closed)));

        first
            .read()
            .expect("ordinary close does not poison active lease");
        first.settle();
        second_entered_rx.recv().expect("second turn entered");
        assert!(
            third_entered_rx.try_recv().is_err(),
            "third cannot overlap second"
        );
        release_second_tx.send(()).expect("release second turn");
        second.join().expect("second thread");
        third_entered_rx.recv().expect("third turn entered");
        third.join().expect("third thread");

        assert_eq!(close_one.join().expect("first close"), Ok(()));
        assert_eq!(close_two.join().expect("second close"), Ok(()));
        assert_eq!(store.close(), Ok(()));
        assert_eq!(adapter.close_count(), 1, "final close action is idempotent");
        assert_eq!(expect_present(selected_core(&adapter)).1, b"after-barrier");
    }

    fn wait_for_admission_barrier(store: &StateStore<MemoryAdapter>) {
        let mut lifecycle = lock(&store.inner.lifecycle);
        while lifecycle.accepting {
            lifecycle = wait(&store.inner.lifecycle_changed, lifecycle);
        }
    }
}
