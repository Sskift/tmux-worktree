use crate::port::{AdmissionPort, PortPublishOutcome, PortSnapshot, TransactionPort};
use relay_v2_broker_credential_state_store_platform_common::NativeStoreErrorCode;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

pub(crate) struct AdmissionState {
    port: Option<Box<dyn AdmissionPort>>,
}

impl AdmissionState {
    pub(crate) fn new(port: Box<dyn AdmissionPort>) -> Self {
        Self { port: Some(port) }
    }

    /// Potentially blocks on the authoritative ProcessBound/N1 FIFO. The
    /// binding calls this only from its per-store dedicated worker.
    pub(crate) fn enter(
        mut self,
        terminal: Arc<AtomicBool>,
    ) -> Result<TransactionState, NativeStoreErrorCode> {
        let port = self
            .port
            .take()
            .ok_or(NativeStoreErrorCode::StoreClosed)?
            .enter()?;
        Ok(TransactionState {
            port: Some(port),
            identity: Arc::new(TransactionIdentity(())),
            terminal,
        })
    }
}

pub(crate) struct TransactionIdentity(());

pub(crate) fn same_transaction(
    current: &Arc<TransactionIdentity>,
    candidate: &Arc<TransactionIdentity>,
) -> bool {
    Arc::ptr_eq(current, candidate)
}

pub(crate) struct TransactionState {
    port: Option<Box<dyn TransactionPort>>,
    identity: Arc<TransactionIdentity>,
    terminal: Arc<AtomicBool>,
}

impl TransactionState {
    pub(crate) fn identity(&self) -> Arc<TransactionIdentity> {
        Arc::clone(&self.identity)
    }

    pub(crate) fn read(&mut self) -> Result<PortSnapshot, NativeStoreErrorCode> {
        self.assert_usable()?;
        self.port
            .as_mut()
            .ok_or(NativeStoreErrorCode::InvalidRevision)?
            .read()
    }

    pub(crate) fn compare_and_publish(
        &mut self,
        revision: u64,
        next: &[u8],
    ) -> Result<PortPublishOutcome, NativeStoreErrorCode> {
        self.assert_usable()?;
        self.port
            .as_mut()
            .ok_or(NativeStoreErrorCode::InvalidRevision)?
            .compare_and_publish(revision, next)
    }

    pub(crate) fn settle(&mut self) -> Result<(), NativeStoreErrorCode> {
        self.port
            .take()
            .ok_or(NativeStoreErrorCode::InvalidRevision)?
            .settle()
    }

    fn assert_usable(&self) -> Result<(), NativeStoreErrorCode> {
        if self.terminal.load(Ordering::Acquire) {
            return Err(NativeStoreErrorCode::StoreClosed);
        }
        if self.port.is_none() {
            Err(NativeStoreErrorCode::InvalidRevision)
        } else {
            Ok(())
        }
    }
}

impl Drop for TransactionState {
    fn drop(&mut self) {
        if self.port.is_some() {
            let _ = self.settle();
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum NativeCompletionResult {
    Settled(Result<(), NativeStoreErrorCode>),
    Duplicate,
}

pub(crate) struct NativeCompletion {
    transaction: Option<TransactionState>,
    completed: bool,
}

impl NativeCompletion {
    pub(crate) fn new(transaction: TransactionState) -> Self {
        Self {
            transaction: Some(transaction),
            completed: false,
        }
    }

    pub(crate) fn finish(
        &mut self,
        callback_error: Option<NativeStoreErrorCode>,
    ) -> NativeCompletionResult {
        if self.completed {
            return NativeCompletionResult::Duplicate;
        }
        self.completed = true;
        let settle_error = self
            .transaction
            .take()
            .and_then(|mut transaction| transaction.settle().err());
        NativeCompletionResult::Settled(settle_error.or(callback_error).map_or(Ok(()), Err))
    }

    pub(crate) fn transaction_mut(
        &mut self,
    ) -> Result<&mut TransactionState, NativeStoreErrorCode> {
        self.transaction
            .as_mut()
            .ok_or(NativeStoreErrorCode::InvalidRevision)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::port::{erase_process_store, PortPublishOutcome};
    use relay_v2_broker_credential_state_store_platform_common::{
        container_spec, initialize_process_lifecycle, reserve_process_store, ContainerSpec,
        DescriptorOperationFence, FinalCloseOperationFence, PlatformStoreFailure, SoleContainer,
        VerifiedHomeIdentity,
    };
    use std::sync::atomic::AtomicU64;
    use std::sync::{mpsc, Mutex};
    use std::thread;
    use std::time::Duration;

    static NEXT_HOME: AtomicU64 = AtomicU64::new(90_000);

    #[derive(Default)]
    struct DescriptorState {
        writes: Vec<(u64, Vec<u8>)>,
        final_close_count: usize,
    }

    struct MemoryContainer {
        state: Arc<Mutex<DescriptorState>>,
        descriptor_live: bool,
    }

    impl SoleContainer for MemoryContainer {
        fn complete_platform_open(
            &mut self,
            fence: &DescriptorOperationFence,
            spec: &ContainerSpec,
        ) -> Result<(), PlatformStoreFailure> {
            fence.check()?;
            assert_eq!(spec.file_length(), container_spec().file_length());
            Ok(())
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
            absolute_offset: u64,
            output: &mut [u8],
        ) -> Result<(), PlatformStoreFailure> {
            fence.check()?;
            output.fill(0);
            let output_end = absolute_offset
                .checked_add(output.len() as u64)
                .ok_or(PlatformStoreFailure::Io)?;
            for (write_offset, bytes) in &self.state.lock().unwrap().writes {
                let write_end = write_offset + bytes.len() as u64;
                let start = absolute_offset.max(*write_offset);
                let end = output_end.min(write_end);
                if start < end {
                    let output_start = (start - absolute_offset) as usize;
                    let write_start = (start - write_offset) as usize;
                    let length = (end - start) as usize;
                    output[output_start..output_start + length]
                        .copy_from_slice(&bytes[write_start..write_start + length]);
                }
            }
            Ok(())
        }

        fn write_all_at(
            &mut self,
            fence: &DescriptorOperationFence,
            absolute_offset: u64,
            bytes: &[u8],
        ) -> Result<(), PlatformStoreFailure> {
            fence.check()?;
            self.state
                .lock()
                .unwrap()
                .writes
                .push((absolute_offset, bytes.to_vec()));
            Ok(())
        }

        fn payload_durability_barrier(
            &mut self,
            fence: &DescriptorOperationFence,
        ) -> Result<(), PlatformStoreFailure> {
            fence.check()
        }

        fn header_and_container_durability_barrier(
            &mut self,
            fence: &DescriptorOperationFence,
        ) -> Result<(), PlatformStoreFailure> {
            fence.check()
        }

        fn final_close(
            &mut self,
            fence: &FinalCloseOperationFence,
        ) -> Result<(), PlatformStoreFailure> {
            fence.check()?;
            let mut state = self.state.lock().unwrap();
            state.final_close_count += 1;
            self.descriptor_live = false;
            Ok(())
        }
    }

    impl Drop for MemoryContainer {
        fn drop(&mut self) {
            assert!(
                !self.descriptor_live,
                "common must own final descriptor close"
            );
        }
    }

    fn process_store() -> (Box<dyn crate::port::StorePort>, Arc<Mutex<DescriptorState>>) {
        let lifecycle = initialize_process_lifecycle().unwrap();
        let home = VerifiedHomeIdentity::new(
            13,
            NEXT_HOME.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
        );
        let descriptor = Arc::new(Mutex::new(DescriptorState::default()));
        let store = reserve_process_store(&lifecycle, home)
            .unwrap()
            .begin_descriptor_open()
            .unwrap()
            .attach(MemoryContainer {
                state: Arc::clone(&descriptor),
                descriptor_live: true,
            })
            .unwrap()
            .finish()
            .unwrap();
        (erase_process_store(store), descriptor)
    }

    #[test]
    fn one_dedicated_worker_serializes_real_process_bound_admissions_and_close_drains() {
        let (store, descriptor) = process_store();
        let store: Arc<dyn crate::port::StorePort> = Arc::from(store);
        let terminal = Arc::new(AtomicBool::new(false));
        let first = AdmissionState::new(store.admit().unwrap());
        let second = AdmissionState::new(store.admit().unwrap());
        let (entered_tx, entered_rx) = mpsc::channel();
        let (ack_tx, ack_rx) = mpsc::channel();

        let admission_worker = thread::spawn(move || {
            let first_transaction = first.enter(Arc::clone(&terminal)).unwrap();
            entered_tx.send((1_u8, first_transaction)).unwrap();
            ack_rx.recv().unwrap();

            let second_transaction = second.enter(terminal).unwrap();
            entered_tx.send((2_u8, second_transaction)).unwrap();
            ack_rx.recv().unwrap();
        });

        let (first_id, mut first_transaction) =
            entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(first_id, 1);
        assert!(entered_rx.recv_timeout(Duration::from_millis(40)).is_err());

        let (close_tx, close_rx) = mpsc::channel();
        let close_store = Arc::clone(&store);
        let close_worker = thread::spawn(move || close_tx.send(close_store.close()).unwrap());
        assert!(close_rx.recv_timeout(Duration::from_millis(40)).is_err());

        first_transaction.settle().unwrap();
        ack_tx.send(()).unwrap();
        let (second_id, mut second_transaction) =
            entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(second_id, 2);
        assert!(close_rx.recv_timeout(Duration::from_millis(40)).is_err());
        second_transaction.settle().unwrap();
        ack_tx.send(()).unwrap();
        assert_eq!(
            close_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
            Ok(())
        );

        admission_worker.join().unwrap();
        close_worker.join().unwrap();
        assert_eq!(descriptor.lock().unwrap().final_close_count, 1);
    }

    #[test]
    fn real_process_bound_tokens_are_transaction_identity_scoped_and_expire_on_settle() {
        let (store, _) = process_store();
        let terminal = Arc::new(AtomicBool::new(false));
        let mut first = AdmissionState::new(store.admit().unwrap())
            .enter(Arc::clone(&terminal))
            .unwrap();
        let first_identity = first.identity();
        let first_revision = first.read().unwrap().revision;
        assert_eq!(first_revision, 1);
        first.settle().unwrap();
        assert_eq!(
            first.read().unwrap_err(),
            NativeStoreErrorCode::InvalidRevision
        );

        let mut second = AdmissionState::new(store.admit().unwrap())
            .enter(terminal)
            .unwrap();
        let second_identity = second.identity();
        let second_revision = second.read().unwrap().revision;
        assert_eq!(
            second_revision, 1,
            "native-local token intentionally repeats"
        );
        assert!(!same_transaction(&second_identity, &first_identity));
        assert!(!same_transaction(
            &second_identity,
            &Arc::new(TransactionIdentity(()))
        ));
        assert_eq!(
            if same_transaction(&second_identity, &first_identity) {
                second.compare_and_publish(first_revision, &[1])
            } else {
                Err(NativeStoreErrorCode::InvalidRevision)
            }
            .unwrap_err(),
            NativeStoreErrorCode::InvalidRevision
        );
        second.settle().unwrap();
        store.close().unwrap();
    }

    #[test]
    fn real_process_bound_port_copies_publish_input_and_returned_bytes() {
        let (store, _) = process_store();
        let mut transaction = AdmissionState::new(store.admit().unwrap())
            .enter(Arc::new(AtomicBool::new(false)))
            .unwrap();
        let revision = transaction.read().unwrap().revision;
        let mut input = vec![7, 8, 9];
        let PortPublishOutcome::Swapped(mut published) =
            transaction.compare_and_publish(revision, &input).unwrap()
        else {
            panic!("expected swapped");
        };
        input.fill(0);
        assert_eq!(published.bytes.as_deref(), Some(&[7, 8, 9][..]));
        published.bytes.as_mut().unwrap().fill(1);

        let reread = transaction.read().unwrap();
        assert_eq!(reread.bytes.as_deref(), Some(&[7, 8, 9][..]));
        transaction.settle().unwrap();
        store.close().unwrap();
    }

    #[test]
    fn callback_completion_settles_one_real_process_bound_transaction_exactly_once() {
        for callback_error in [None, Some(NativeStoreErrorCode::NativeInterfaceInvalid)] {
            let (store, descriptor) = process_store();
            let transaction = AdmissionState::new(store.admit().unwrap())
                .enter(Arc::new(AtomicBool::new(false)))
                .unwrap();
            let mut completion = NativeCompletion::new(transaction);
            assert_eq!(
                completion.finish(callback_error),
                NativeCompletionResult::Settled(callback_error.map_or(Ok(()), Err))
            );
            assert_eq!(
                completion.finish(Some(NativeStoreErrorCode::StoreIo)),
                NativeCompletionResult::Duplicate
            );
            store.close().unwrap();
            assert_eq!(descriptor.lock().unwrap().final_close_count, 1);
        }
    }
}
