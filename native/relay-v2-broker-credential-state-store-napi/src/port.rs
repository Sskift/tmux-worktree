use relay_v2_broker_credential_state_store_platform_common::{
    NativeStoreErrorCode, ProcessBoundAdmission, ProcessBoundPublishOutcome, ProcessBoundRevision,
    ProcessBoundSnapshot, ProcessBoundStateStore, ProcessBoundTransaction, SoleContainer,
};
use std::collections::HashMap;

#[derive(Debug)]
pub(crate) struct PortSnapshot {
    pub(crate) revision: u64,
    pub(crate) bytes: Option<Vec<u8>>,
}

#[derive(Debug)]
pub(crate) enum PortPublishOutcome {
    Swapped(PortSnapshot),
    AlreadySame(PortSnapshot),
    Conflict(PortSnapshot),
    Uncertain,
}

pub(crate) trait StorePort: Send + Sync {
    fn admit(&self) -> Result<Box<dyn AdmissionPort>, NativeStoreErrorCode>;
    fn close(&self) -> Result<(), NativeStoreErrorCode>;
}

pub(crate) trait AdmissionPort: Send {
    fn enter(self: Box<Self>) -> Result<Box<dyn TransactionPort>, NativeStoreErrorCode>;
}

pub(crate) trait TransactionPort: Send {
    fn read(&mut self) -> Result<PortSnapshot, NativeStoreErrorCode>;

    fn compare_and_publish(
        &mut self,
        expected: u64,
        next: &[u8],
    ) -> Result<PortPublishOutcome, NativeStoreErrorCode>;

    fn settle(self: Box<Self>) -> Result<(), NativeStoreErrorCode>;
}

pub(crate) fn erase_process_store<C>(store: ProcessBoundStateStore<C>) -> Box<dyn StorePort>
where
    C: SoleContainer,
{
    Box::new(ProcessStorePort { inner: store })
}

struct ProcessStorePort<C: SoleContainer> {
    inner: ProcessBoundStateStore<C>,
}

impl<C: SoleContainer> StorePort for ProcessStorePort<C> {
    fn admit(&self) -> Result<Box<dyn AdmissionPort>, NativeStoreErrorCode> {
        self.inner
            .admit()
            .map(|inner| Box::new(ProcessAdmissionPort { inner: Some(inner) }) as Box<_>)
    }

    fn close(&self) -> Result<(), NativeStoreErrorCode> {
        self.inner.close()
    }
}

struct ProcessAdmissionPort<C: SoleContainer> {
    inner: Option<ProcessBoundAdmission<C>>,
}

impl<C: SoleContainer> AdmissionPort for ProcessAdmissionPort<C> {
    fn enter(mut self: Box<Self>) -> Result<Box<dyn TransactionPort>, NativeStoreErrorCode> {
        self.inner
            .take()
            .ok_or(NativeStoreErrorCode::StoreClosed)?
            .enter()
            .map(|inner| {
                Box::new(ProcessTransactionPort {
                    inner: Some(inner),
                    revisions: HashMap::new(),
                    next_revision: 1,
                }) as Box<_>
            })
    }
}

struct ProcessTransactionPort<C: SoleContainer> {
    inner: Option<ProcessBoundTransaction<C>>,
    revisions: HashMap<u64, ProcessBoundRevision>,
    next_revision: u64,
}

impl<C: SoleContainer> ProcessTransactionPort<C> {
    fn snapshot(
        &mut self,
        snapshot: ProcessBoundSnapshot,
    ) -> Result<PortSnapshot, NativeStoreErrorCode> {
        let bytes = snapshot.bytes()?.map(<[u8]>::to_vec);
        let revision = snapshot.revision()?;
        let token = self.next_revision;
        self.next_revision = self
            .next_revision
            .checked_add(1)
            .ok_or(NativeStoreErrorCode::GenerationExhausted)?;
        self.revisions.insert(token, revision);
        Ok(PortSnapshot {
            revision: token,
            bytes,
        })
    }
}

impl<C: SoleContainer> TransactionPort for ProcessTransactionPort<C> {
    fn read(&mut self) -> Result<PortSnapshot, NativeStoreErrorCode> {
        let snapshot = self
            .inner
            .as_mut()
            .ok_or(NativeStoreErrorCode::InvalidRevision)?
            .read()?;
        self.snapshot(snapshot)
    }

    fn compare_and_publish(
        &mut self,
        expected: u64,
        next: &[u8],
    ) -> Result<PortPublishOutcome, NativeStoreErrorCode> {
        let revision = self
            .revisions
            .get(&expected)
            .ok_or(NativeStoreErrorCode::InvalidRevision)?;
        let outcome = self
            .inner
            .as_mut()
            .ok_or(NativeStoreErrorCode::InvalidRevision)?
            .compare_and_publish(revision, next)?;
        match outcome {
            ProcessBoundPublishOutcome::Swapped(snapshot) => {
                self.snapshot(snapshot).map(PortPublishOutcome::Swapped)
            }
            ProcessBoundPublishOutcome::AlreadySame(snapshot) => {
                self.snapshot(snapshot).map(PortPublishOutcome::AlreadySame)
            }
            ProcessBoundPublishOutcome::Conflict(snapshot) => {
                self.snapshot(snapshot).map(PortPublishOutcome::Conflict)
            }
            ProcessBoundPublishOutcome::Uncertain => Ok(PortPublishOutcome::Uncertain),
        }
    }

    fn settle(mut self: Box<Self>) -> Result<(), NativeStoreErrorCode> {
        self.revisions.clear();
        self.inner
            .take()
            .ok_or(NativeStoreErrorCode::InvalidRevision)?
            .settle()
    }
}
