use relay_v2_broker_credential_state_store_platform_common::{
    container_spec, initialize_process_lifecycle, reserve_process_store, DescriptorOperationFence,
    FinalCloseOperationFence, NativeStoreErrorCode, PlatformStoreFailure, SoleContainer,
    VerifiedHomeIdentity,
};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;

static NEXT_HOME: AtomicU64 = AtomicU64::new(1_000);

#[test]
fn generated_spec_is_the_exact_frozen_platform_invariant_location_and_shape() {
    let spec = container_spec();
    assert_eq!(
        spec.relative_components(),
        [
            ".tmux-worktree",
            "relay-v2-broker-credential-state-store-v1.bin",
        ]
    );
    assert_eq!(spec.file_length(), 134_217_984);
    assert_eq!(spec.max_state_bytes(), 67_108_864);
    assert!(
        std::ptr::eq(spec, container_spec()),
        "one generated static spec"
    );
}

#[test]
fn every_closed_code_and_core_platform_mapping_is_exact() {
    let all_codes = [
        (
            NativeStoreErrorCode::NativeInterfaceInvalid,
            "NATIVE_INTERFACE_INVALID",
        ),
        (NativeStoreErrorCode::StoreBusy, "STORE_BUSY"),
        (NativeStoreErrorCode::StoreClosed, "STORE_CLOSED"),
        (NativeStoreErrorCode::StoreCorrupt, "STORE_CORRUPT"),
        (
            NativeStoreErrorCode::StoreFormatUnsupported,
            "STORE_FORMAT_UNSUPPORTED",
        ),
        (
            NativeStoreErrorCode::StoreIdentityUncertain,
            "STORE_IDENTITY_UNCERTAIN",
        ),
        (NativeStoreErrorCode::StoreIo, "STORE_IO"),
        (
            NativeStoreErrorCode::StorePermissionInvalid,
            "STORE_PERMISSION_INVALID",
        ),
        (
            NativeStoreErrorCode::DurabilityUnsupported,
            "DURABILITY_UNSUPPORTED",
        ),
        (NativeStoreErrorCode::InvalidArgument, "INVALID_ARGUMENT"),
        (NativeStoreErrorCode::InvalidRevision, "INVALID_REVISION"),
        (NativeStoreErrorCode::StateTooLarge, "STATE_TOO_LARGE"),
        (
            NativeStoreErrorCode::GenerationExhausted,
            "GENERATION_EXHAUSTED",
        ),
    ];
    for (code, contract) in all_codes {
        assert_eq!(code.as_contract_code(), contract);
    }

    let platform_cases = [
        (PlatformStoreFailure::Busy, NativeStoreErrorCode::StoreBusy),
        (
            PlatformStoreFailure::Closed,
            NativeStoreErrorCode::StoreClosed,
        ),
        (
            PlatformStoreFailure::IdentityUncertain,
            NativeStoreErrorCode::StoreIdentityUncertain,
        ),
        (PlatformStoreFailure::Io, NativeStoreErrorCode::StoreIo),
        (
            PlatformStoreFailure::PermissionInvalid,
            NativeStoreErrorCode::StorePermissionInvalid,
        ),
        (
            PlatformStoreFailure::DurabilityUnsupported,
            NativeStoreErrorCode::DurabilityUnsupported,
        ),
    ];
    for (input, expected) in platform_cases {
        assert_eq!(NativeStoreErrorCode::from(input), expected);
        assert_ne!(expected, NativeStoreErrorCode::NativeInterfaceInvalid);
    }
}

#[derive(Debug, Clone, Copy)]
enum ReadMode {
    ZeroContainer,
    CorruptHeader,
    ReaderIo,
}

#[derive(Default)]
struct TrackingState {
    complete_open_count: usize,
    read_count: usize,
    close_count: usize,
    implicit_live_drop_count: usize,
}

struct TrackingContainer {
    mode: ReadMode,
    close_error: Option<PlatformStoreFailure>,
    panic_on_close: bool,
    descriptor_live: bool,
    state: Arc<Mutex<TrackingState>>,
}

impl TrackingContainer {
    fn new(
        mode: ReadMode,
        close_error: Option<PlatformStoreFailure>,
    ) -> (Self, Arc<Mutex<TrackingState>>) {
        let state = Arc::new(Mutex::new(TrackingState::default()));
        (
            Self {
                mode,
                close_error,
                panic_on_close: false,
                descriptor_live: true,
                state: Arc::clone(&state),
            },
            state,
        )
    }

    fn panic_on_close(mut self) -> Self {
        self.panic_on_close = true;
        self
    }
}

impl Drop for TrackingContainer {
    fn drop(&mut self) {
        if self.descriptor_live {
            self.state
                .lock()
                .expect("tracking lock")
                .implicit_live_drop_count += 1;
        }
    }
}

impl SoleContainer for TrackingContainer {
    fn complete_platform_open(
        &mut self,
        fence: &DescriptorOperationFence,
        spec: &relay_v2_broker_credential_state_store_platform_common::ContainerSpec,
    ) -> Result<(), PlatformStoreFailure> {
        fence.check()?;
        assert_eq!(spec.file_length(), container_spec().file_length());
        self.state
            .lock()
            .expect("tracking lock")
            .complete_open_count += 1;
        Ok(())
    }

    fn file_length(&self, fence: &DescriptorOperationFence) -> Result<u64, PlatformStoreFailure> {
        fence.check()?;
        self.state.lock().expect("tracking lock").read_count += 1;
        match self.mode {
            ReadMode::ReaderIo => Err(PlatformStoreFailure::Io),
            ReadMode::ZeroContainer | ReadMode::CorruptHeader => Ok(container_spec().file_length()),
        }
    }

    fn read_exact_at(
        &self,
        fence: &DescriptorOperationFence,
        absolute_offset: u64,
        output: &mut [u8],
    ) -> Result<(), PlatformStoreFailure> {
        fence.check()?;
        self.state.lock().expect("tracking lock").read_count += 1;
        if matches!(self.mode, ReadMode::ReaderIo) {
            return Err(PlatformStoreFailure::Io);
        }
        let end = absolute_offset
            .checked_add(output.len() as u64)
            .ok_or(PlatformStoreFailure::Io)?;
        if end > container_spec().file_length() {
            return Err(PlatformStoreFailure::Io);
        }
        output.fill(0);
        if matches!(self.mode, ReadMode::CorruptHeader)
            && absolute_offset == 0
            && !output.is_empty()
        {
            output[0] = 1;
        }
        Ok(())
    }

    fn write_all_at(
        &mut self,
        _fence: &DescriptorOperationFence,
        _absolute_offset: u64,
        _bytes: &[u8],
    ) -> Result<(), PlatformStoreFailure> {
        panic!("lifecycle tests do not publish")
    }

    fn payload_durability_barrier(
        &mut self,
        _fence: &DescriptorOperationFence,
    ) -> Result<(), PlatformStoreFailure> {
        panic!("lifecycle tests do not publish")
    }

    fn header_and_container_durability_barrier(
        &mut self,
        _fence: &DescriptorOperationFence,
    ) -> Result<(), PlatformStoreFailure> {
        panic!("lifecycle tests do not publish")
    }

    fn final_close(
        &mut self,
        fence: &FinalCloseOperationFence,
    ) -> Result<(), PlatformStoreFailure> {
        fence.check()?;
        self.state.lock().expect("tracking lock").close_count += 1;
        if self.panic_on_close {
            panic!("injected final-close panic");
        }
        match self.close_error {
            Some(error) => Err(error),
            None => {
                self.descriptor_live = false;
                Ok(())
            }
        }
    }
}

fn unique_home() -> VerifiedHomeIdentity {
    VerifiedHomeIdentity::new(77, NEXT_HOME.fetch_add(1, Ordering::Relaxed))
}

fn finish_at(
    home: VerifiedHomeIdentity,
    container: TrackingContainer,
) -> Result<
    relay_v2_broker_credential_state_store_platform_common::ProcessBoundStateStore<
        TrackingContainer,
    >,
    NativeStoreErrorCode,
> {
    let lifecycle = initialize_process_lifecycle().expect("eager process lifecycle");
    reserve_process_store(&lifecycle, home)
        .expect("reserve")
        .begin_descriptor_open()
        .expect("descriptor admission")
        .attach(container)
        .expect("attach")
        .finish()
}

fn reserve_at(
    home: VerifiedHomeIdentity,
) -> Result<
    relay_v2_broker_credential_state_store_platform_common::OpenReservation,
    PlatformStoreFailure,
> {
    let lifecycle = initialize_process_lifecycle().expect("eager process lifecycle");
    reserve_process_store(&lifecycle, home)
}

fn close_count(state: &Arc<Mutex<TrackingState>>) -> usize {
    state.lock().expect("tracking lock").close_count
}

fn implicit_live_drop_count(state: &Arc<Mutex<TrackingState>>) -> usize {
    state
        .lock()
        .expect("tracking lock")
        .implicit_live_drop_count
}

#[test]
fn handoff_has_one_close_owner_preserves_primary_failure_and_allows_proven_reopen() {
    let home = unique_home();
    let (container, tracking) = TrackingContainer::new(ReadMode::ZeroContainer, None);
    let store = finish_at(home, container).expect("zero container opens");
    assert_eq!(close_count(&tracking), 0);
    assert_eq!(store.close(), Ok(()));
    assert_eq!(store.close(), Ok(()));
    assert_eq!(close_count(&tracking), 1, "cached close is not retried");

    let (container, reopened_tracking) = TrackingContainer::new(ReadMode::ZeroContainer, None);
    let reopened = finish_at(home, container).expect("proven close permits reopen");
    assert_eq!(reopened.close(), Ok(()));
    assert_eq!(close_count(&reopened_tracking), 1);

    let corrupt_home = unique_home();
    let (container, corrupt_tracking) = TrackingContainer::new(ReadMode::CorruptHeader, None);
    assert!(matches!(
        finish_at(corrupt_home, container),
        Err(NativeStoreErrorCode::StoreCorrupt)
    ));
    assert_eq!(
        close_count(&corrupt_tracking),
        1,
        "N1 rejection is closed exactly once"
    );

    let io_home = unique_home();
    let (container, io_tracking) = TrackingContainer::new(
        ReadMode::ReaderIo,
        Some(PlatformStoreFailure::PermissionInvalid),
    );
    assert!(matches!(
        finish_at(io_home, container),
        Err(NativeStoreErrorCode::StoreIo)
    ));
    assert_eq!(close_count(&io_tracking), 1);
    assert!(matches!(
        reserve_at(io_home),
        Err(PlatformStoreFailure::Closed)
    ));
}

#[test]
fn typestate_distinguishes_proven_no_descriptor_from_unknown_drop() {
    let released_home = unique_home();
    reserve_at(released_home)
        .expect("reserve")
        .begin_descriptor_open()
        .expect("admission")
        .release_proven_no_descriptor()
        .expect("proven no fd");
    reserve_at(released_home)
        .expect("proof permits another reservation")
        .release_proven_no_descriptor()
        .expect("release second reservation");

    let uncertain_home = unique_home();
    drop(
        reserve_at(uncertain_home)
            .expect("reserve")
            .begin_descriptor_open()
            .expect("admission"),
    );
    assert!(matches!(
        reserve_at(uncertain_home),
        Err(PlatformStoreFailure::Closed)
    ));
}

#[test]
fn ordinary_close_rejects_new_admission_but_drains_owned_ticket() {
    let (container, tracking) = TrackingContainer::new(ReadMode::ZeroContainer, None);
    let store = Arc::new(finish_at(unique_home(), container).expect("open"));
    let admitted = store.admit().expect("admitted before close");
    let closer = Arc::clone(&store);
    let (done_tx, done_rx) = mpsc::channel();
    let close_thread = thread::spawn(move || {
        done_tx.send(closer.close()).expect("send close result");
    });

    loop {
        match store.admit() {
            Err(NativeStoreErrorCode::StoreClosed) => break,
            Ok(ticket) => drop(ticket),
            Err(other) => panic!("unexpected admission result: {other:?}"),
        }
        thread::yield_now();
    }
    assert!(matches!(done_rx.try_recv(), Err(mpsc::TryRecvError::Empty)));

    let mut transaction = admitted
        .enter()
        .expect("owned ticket enters during Closing");
    let snapshot = transaction.read().expect("admitted read remains usable");
    assert!(!snapshot.is_present().expect("snapshot process fence"));
    transaction.settle().expect("settle");

    assert_eq!(done_rx.recv().expect("close result"), Ok(()));
    close_thread.join().expect("close thread");
    assert_eq!(close_count(&tracking), 1);
}

#[test]
fn uncertain_final_close_is_cached_and_permanently_tombstones_reopen() {
    let home = unique_home();
    let (container, tracking) =
        TrackingContainer::new(ReadMode::ZeroContainer, Some(PlatformStoreFailure::Io));
    let store = finish_at(home, container).expect("open");
    assert_eq!(store.close(), Err(NativeStoreErrorCode::StoreIo));
    assert_eq!(store.close(), Err(NativeStoreErrorCode::StoreIo));
    assert_eq!(close_count(&tracking), 1, "failed close is never retried");
    assert!(matches!(
        reserve_at(home),
        Err(PlatformStoreFailure::Closed)
    ));
    assert_eq!(implicit_live_drop_count(&tracking), 0);
}

#[test]
fn final_close_panic_is_one_attempt_without_implicit_drop_and_tombstones() {
    let home = unique_home();
    let (container, tracking) = TrackingContainer::new(ReadMode::ZeroContainer, None);
    let store = finish_at(home, container.panic_on_close()).expect("open");

    assert_eq!(store.close(), Err(NativeStoreErrorCode::StoreIo));
    assert_eq!(store.close(), Err(NativeStoreErrorCode::StoreIo));
    assert_eq!(close_count(&tracking), 1, "panic is never retried");
    assert_eq!(
        implicit_live_drop_count(&tracking),
        0,
        "common forgets a possibly live descriptor owner after panic"
    );
    assert!(matches!(
        reserve_at(home),
        Err(PlatformStoreFailure::Closed)
    ));
}

#[test]
fn parent_store_drop_waits_for_last_ticket_or_lease_arc_then_closes_once() {
    for retained_kind in ["ticket", "lease"] {
        let (container, tracking) = TrackingContainer::new(ReadMode::ZeroContainer, None);
        let store = finish_at(unique_home(), container).expect("open");
        match retained_kind {
            "ticket" => {
                let ticket = store.admit().expect("owned admission");
                drop(store);
                assert_eq!(close_count(&tracking), 0);
                drop(ticket);
            }
            "lease" => {
                let lease = store
                    .admit()
                    .expect("owned admission")
                    .enter()
                    .expect("owned transaction");
                drop(store);
                assert_eq!(close_count(&tracking), 0);
                drop(lease);
            }
            _ => unreachable!(),
        }
        assert_eq!(
            close_count(&tracking),
            1,
            "the last private N1 Arc performs one controlled final close"
        );
        assert_eq!(implicit_live_drop_count(&tracking), 0);
    }
}
