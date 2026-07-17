//! Unwired Linux secure-open scaffold for the Relay v2 broker credential store.
//!
//! This crate owns only Linux account-home, path, ACL, descriptor, record-lock,
//! and durability primitive adaptation. The shared process registry, PID fence,
//! N1 bridge, transaction lifecycle, and exactly-once final close remain owned
//! by `relay-v2-broker-credential-state-store-platform-common`.
//!
//! The frozen durability qualification allowlist is empty. Consequently the
//! production Linux entry point can collect read-only qualification evidence,
//! but cannot reserve the process registry, mutate the filesystem, or open a
//! container descriptor. Tests exercise the later scaffold through a private,
//! production-unreachable qualification policy.

#[cfg(target_os = "linux")]
mod native;
#[cfg(any(target_os = "linux", test))]
mod scaffold;

use relay_v2_broker_credential_state_store_platform_common::{
    NativeStoreErrorCode, ProcessBoundStateStore, ProcessLifecycleToken, SoleContainer,
};
use std::path::Path;

/// Pre-open target support remains distinct from a store-invalid result.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinuxOpenError {
    TargetUnsupported,
    Store(NativeStoreErrorCode),
}

/// Opaque Linux container owner. Its descriptor and native primitives never
/// enter the public surface.
#[cfg(target_os = "linux")]
pub use native::LinuxSoleContainer;

/// Uninhabited non-Linux stand-in used only to keep the public result type
/// stable while the target stub returns before any platform or common work.
#[cfg(not(target_os = "linux"))]
pub struct LinuxSoleContainer {
    _private: std::convert::Infallible,
}

#[cfg(not(target_os = "linux"))]
impl SoleContainer for LinuxSoleContainer {
    fn complete_platform_open(
        &mut self,
        _fence: &relay_v2_broker_credential_state_store_platform_common::DescriptorOperationFence,
        _spec: &relay_v2_broker_credential_state_store_platform_common::ContainerSpec,
    ) -> Result<(), relay_v2_broker_credential_state_store_platform_common::PlatformStoreFailure>
    {
        match self._private {}
    }

    fn file_length(
        &self,
        _fence: &relay_v2_broker_credential_state_store_platform_common::DescriptorOperationFence,
    ) -> Result<u64, relay_v2_broker_credential_state_store_platform_common::PlatformStoreFailure>
    {
        match self._private {}
    }

    fn read_exact_at(
        &self,
        _fence: &relay_v2_broker_credential_state_store_platform_common::DescriptorOperationFence,
        _absolute_offset: u64,
        _output: &mut [u8],
    ) -> Result<(), relay_v2_broker_credential_state_store_platform_common::PlatformStoreFailure>
    {
        match self._private {}
    }

    fn write_all_at(
        &mut self,
        _fence: &relay_v2_broker_credential_state_store_platform_common::DescriptorOperationFence,
        _absolute_offset: u64,
        _bytes: &[u8],
    ) -> Result<(), relay_v2_broker_credential_state_store_platform_common::PlatformStoreFailure>
    {
        match self._private {}
    }

    fn payload_durability_barrier(
        &mut self,
        _fence: &relay_v2_broker_credential_state_store_platform_common::DescriptorOperationFence,
    ) -> Result<(), relay_v2_broker_credential_state_store_platform_common::PlatformStoreFailure>
    {
        match self._private {}
    }

    fn header_and_container_durability_barrier(
        &mut self,
        _fence: &relay_v2_broker_credential_state_store_platform_common::DescriptorOperationFence,
    ) -> Result<(), relay_v2_broker_credential_state_store_platform_common::PlatformStoreFailure>
    {
        match self._private {}
    }

    fn final_close(
        &mut self,
        _fence: &relay_v2_broker_credential_state_store_platform_common::FinalCloseOperationFence,
    ) -> Result<(), relay_v2_broker_credential_state_store_platform_common::PlatformStoreFailure>
    {
        match self._private {}
    }
}

pub type LinuxStateStore = ProcessBoundStateStore<LinuxSoleContainer>;

/// Opens the canonical Linux container through platform-common.
///
/// On Linux, the current frozen empty qualification allowlist makes every
/// otherwise-valid production call return `DURABILITY_UNSUPPORTED` before the
/// process registry or any mutation. On other targets this is a pre-open
/// `TargetUnsupported` result and does not inspect `trusted_home`.
pub fn open_linux_state_store(
    lifecycle: &ProcessLifecycleToken,
    trusted_home: &Path,
) -> Result<LinuxStateStore, LinuxOpenError> {
    #[cfg(target_os = "linux")]
    {
        native::open(lifecycle, trusted_home).map_err(LinuxOpenError::Store)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (lifecycle, trusted_home);
        Err(LinuxOpenError::TargetUnsupported)
    }
}
