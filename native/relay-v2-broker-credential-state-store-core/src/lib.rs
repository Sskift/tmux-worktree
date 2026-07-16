//! Pure Relay v2 broker credential state-store core.
//!
//! This crate consumes the frozen binary-v1 manifest at build time. It owns
//! only container selection/encoding and the in-process transaction/publication
//! state machine. Platform secure-open, descriptor identity, kernel locking,
//! stable-storage durability, N-API, credential schema, and external continuity
//! remain adapter/authority responsibilities.

mod binary_contract {
    include!(concat!(env!("OUT_DIR"), "/binary_contract.rs"));
}

mod format;
mod store;

pub use format::AbsoluteRangeReader;
pub use store::{
    AdmissionTicket, PresentSnapshot, PublicationAction, PublicationAdapter, PublishOutcome,
    Revision, Snapshot, StateStore, TransactionLease,
};

/// The complete error vocabulary owned by the pure N1 core. Platform access,
/// secure-open, identity, lock, durability-support, N-API, and loader failures
/// remain adapter errors and are not represented here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoreError {
    Corrupt,
    FormatUnsupported,
    Closed,
    InvalidArgument,
    InvalidRevision,
    StateTooLarge,
    GenerationExhausted,
}

impl std::fmt::Display for CoreError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Corrupt => "corrupt binary container",
            Self::FormatUnsupported => "unsupported binary format",
            Self::Closed => "store is closed",
            Self::InvalidArgument => "invalid core argument",
            Self::InvalidRevision => "invalid transaction revision",
            Self::StateTooLarge => "state exceeds the frozen payload limit",
            Self::GenerationExhausted => "storage generation is exhausted",
        })
    }
}

impl std::error::Error for CoreError {}

/// Core validation failures stay distinct from adapter range-access failures.
/// A future platform adapter owns the mapping of `Adapter` into its frozen
/// native error union.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OperationError<AdapterError> {
    Core(CoreError),
    Adapter(AdapterError),
}

impl<AdapterError> From<CoreError> for OperationError<AdapterError> {
    fn from(error: CoreError) -> Self {
        Self::Core(error)
    }
}
