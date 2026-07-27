//! Trusted Host credential cell directory producer (contract revision 7,
//! trusted factory v1).
//!
//! This module is the only native producer of the pre-bound Host credential
//! cell directory descriptor capability. It proves the process credential
//! snapshot, resolves the native account-database home for the effective uid
//! (never the HOME environment, a caller path, or a global lookup), appends
//! only the contract-fixed private-location components from platform-common,
//! and opens that exact directory with a no-follow traversal. It never
//! creates, chmods, repairs, or falls back to an alternate candidate: any
//! missing, unsafe, foreign, or racing object fails closed before the
//! capability is minted. The capability itself is only an owned descriptor
//! inside `PreboundDirectory`; admission, registry, lock, claim, mutation, and
//! final close stay with the platform-common `AdmissionOwner`, and the empty
//! durability allowlist still stops every production open before registry or
//! mutation.

use relay_v2_host_credential_atomic_file_cell_platform_common::{
    trusted_cell_private_location_components, CellErrorCode, EffectiveIdentity, ObjectKind,
    ObjectMetadata,
};
use std::ffi::{CString, OsStr};
use std::os::fd::RawFd;
use std::os::unix::ffi::OsStrExt;

use crate::sys;
use crate::{metadata_from_stat, LinuxDescriptor, LinuxDescriptorRelativePlatform};
use crate::{PlatformFailure, PreboundDirectory};

const DIRECTORY_OPEN_FLAGS: libc::c_int =
    libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_DIRECTORY;

fn map_errno(errno: libc::c_int) -> CellErrorCode {
    match errno {
        libc::EACCES | libc::EPERM => CellErrorCode::CellPermissionInvalid,
        libc::ENOENT => CellErrorCode::CellIo,
        libc::ELOOP | libc::ENOTDIR | libc::EISDIR | libc::ESTALE => {
            CellErrorCode::CellIdentityUncertain
        }
        _ => CellErrorCode::CellIo,
    }
}

fn map_platform_failure(failure: PlatformFailure) -> CellErrorCode {
    match failure {
        PlatformFailure::Busy => CellErrorCode::CellBusy,
        PlatformFailure::PermissionDenied => CellErrorCode::CellPermissionInvalid,
        PlatformFailure::IdentityUncertain => CellErrorCode::CellIdentityUncertain,
        PlatformFailure::NotFound | PlatformFailure::AlreadyExists | PlatformFailure::Io => {
            CellErrorCode::CellIo
        }
    }
}

fn fstat_metadata(raw_fd: RawFd) -> Result<ObjectMetadata, CellErrorCode> {
    let stat = sys::fstat(raw_fd).map_err(map_errno)?;
    metadata_from_stat(&stat).map_err(map_platform_failure)
}

/// Frozen credential snapshot: real and effective ids must match and neither
/// uid may be root. Evaluated before any account or path observation.
fn current_effective_identity() -> Result<EffectiveIdentity, CellErrorCode> {
    let real_uid = sys::real_uid();
    let real_gid = sys::real_gid();
    let effective = EffectiveIdentity {
        effective_uid: sys::effective_uid(),
        effective_gid: sys::effective_gid(),
    };
    if real_uid != effective.effective_uid
        || real_gid != effective.effective_gid
        || real_uid == 0
        || effective.effective_uid == 0
    {
        return Err(CellErrorCode::CellPermissionInvalid);
    }
    Ok(effective)
}

/// Exactly-once directory descriptor guard. Every failure path makes one raw
/// close attempt; a consumed guard is inert so an uncertain close is never
/// retried by Drop.
struct OwnedDirectoryFd {
    fd: Option<RawFd>,
}

impl OwnedDirectoryFd {
    fn new(fd: RawFd) -> Self {
        Self { fd: Some(fd) }
    }

    fn fd(&self) -> RawFd {
        self.fd.expect("owned directory descriptor")
    }

    fn close_once(&mut self) -> Result<(), CellErrorCode> {
        let fd = self.fd.take().expect("owned directory descriptor");
        sys::close_once(fd).map_err(map_errno)
    }

    fn disarm(mut self) -> RawFd {
        self.fd.take().expect("owned directory descriptor")
    }
}

impl Drop for OwnedDirectoryFd {
    fn drop(&mut self) {
        if let Some(fd) = self.fd.take() {
            let _ = sys::close_once(fd);
        }
    }
}

fn validate_home(
    metadata: &ObjectMetadata,
    effective: &EffectiveIdentity,
) -> Result<(), CellErrorCode> {
    if metadata.kind != ObjectKind::Directory {
        return Err(CellErrorCode::CellIdentityUncertain);
    }
    if metadata.owner_uid != effective.effective_uid || metadata.mode & 0o022 != 0 {
        return Err(CellErrorCode::CellPermissionInvalid);
    }
    Ok(())
}

fn validate_derived_component(
    metadata: &ObjectMetadata,
    effective: &EffectiveIdentity,
) -> Result<(), CellErrorCode> {
    if metadata.kind != ObjectKind::Directory {
        return Err(CellErrorCode::CellIdentityUncertain);
    }
    if metadata.owner_uid != effective.effective_uid
        || metadata.owner_gid != effective.effective_gid
        || metadata.mode != 0o700
    {
        return Err(CellErrorCode::CellPermissionInvalid);
    }
    Ok(())
}

/// Opens one derived component with the frozen observe-then-open-then-prove
/// order. The returned guard owns the new descriptor; the caller closes the
/// parent exactly once after each successful step.
fn open_derived_component(
    parent: RawFd,
    name: &CString,
    effective: &EffectiveIdentity,
) -> Result<OwnedDirectoryFd, CellErrorCode> {
    let before = {
        let stat = sys::fstatat_nofollow(parent, name).map_err(map_errno)?;
        metadata_from_stat(&stat).map_err(map_platform_failure)?
    };
    if before.kind != ObjectKind::Directory {
        return Err(CellErrorCode::CellIdentityUncertain);
    }
    let next = OwnedDirectoryFd::new(
        sys::openat_existing(parent, name, DIRECTORY_OPEN_FLAGS).map_err(map_errno)?,
    );
    let after = fstat_metadata(next.fd())?;
    if after.kind != ObjectKind::Directory || before.identity != after.identity {
        return Err(CellErrorCode::CellIdentityUncertain);
    }
    validate_derived_component(&after, effective)?;
    let flags = sys::fcntl_getfd(next.fd()).map_err(map_errno)?;
    if flags & libc::FD_CLOEXEC == 0 {
        return Err(CellErrorCode::CellPermissionInvalid);
    }
    Ok(next)
}

/// Securely opens the contract-fixed Host credential cell private directory
/// under an already-proven account home. This is the native-internal seam the
/// production producer reaches only after the account-database home proof; it
/// performs no account lookup of its own and accepts no JavaScript input.
pub fn secure_open_trusted_cell_directory(
    account_home: &OsStr,
    effective: EffectiveIdentity,
) -> Result<PreboundDirectory, CellErrorCode> {
    let home_bytes = account_home.as_bytes();
    if home_bytes.is_empty() || home_bytes[0] != b'/' {
        return Err(CellErrorCode::CellPermissionInvalid);
    }
    let home_name = CString::new(home_bytes).map_err(|_| CellErrorCode::CellPermissionInvalid)?;
    let mut current = OwnedDirectoryFd::new(
        sys::openat_existing(libc::AT_FDCWD, &home_name, DIRECTORY_OPEN_FLAGS)
            .map_err(map_errno)?,
    );
    let home_metadata = fstat_metadata(current.fd())?;
    validate_home(&home_metadata, &effective)?;

    for component in trusted_cell_private_location_components() {
        let name = CString::new(*component).map_err(|_| CellErrorCode::CellIdentityUncertain)?;
        let next = open_derived_component(current.fd(), &name, &effective)?;
        current.close_once()?;
        current = next;
    }
    let raw_fd = current.disarm();
    Ok(PreboundDirectory {
        platform: LinuxDescriptorRelativePlatform { _private: () },
        directory: LinuxDescriptor { raw_fd },
    })
}

/// Production producer entry for the trusted factory. It proves the frozen
/// credential snapshot and the native account-database home before any path
/// observation, then opens the contract-derived cell directory. No path,
/// HOME, environment, or JavaScript argument is accepted anywhere on this
/// path, and a missing or unsafe directory fails closed without creation,
/// repair, or an alternate candidate.
pub fn produce_trusted_cell_directory() -> Result<PreboundDirectory, CellErrorCode> {
    let effective = current_effective_identity()?;
    let home = sys::account_home(effective.effective_uid).map_err(|error| match error {
        sys::AccountHomeError::Missing => CellErrorCode::CellPermissionInvalid,
        sys::AccountHomeError::Io => CellErrorCode::CellIo,
    })?;
    secure_open_trusted_cell_directory(OsStr::from_bytes(&home), effective)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::DescriptorRelativePlatform;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

    struct TempHome {
        root: PathBuf,
        cell: PathBuf,
    }

    impl TempHome {
        fn create() -> Self {
            let unique = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!(
                "tw-relay-v2-host-cell-factory-{}-{unique}",
                std::process::id()
            ));
            let cell = root
                .join(".tmux-worktree")
                .join("relay-v2-host-credential-atomic-file-cell-v1");
            fs::create_dir_all(&cell).expect("create temp cell directory");
            for directory in [&root, &root.join(".tmux-worktree"), &cell] {
                fs::set_permissions(directory, fs::Permissions::from_mode(0o700))
                    .expect("set 0700 on temp directory");
            }
            Self { root, cell }
        }

        fn effective() -> EffectiveIdentity {
            EffectiveIdentity {
                effective_uid: sys::effective_uid(),
                effective_gid: sys::effective_gid(),
            }
        }

        fn produce(&self) -> Result<PreboundDirectory, CellErrorCode> {
            secure_open_trusted_cell_directory(self.root.as_os_str(), Self::effective())
        }
    }

    impl Drop for TempHome {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn real_0700_directory_produces_a_working_prebound_descriptor() {
        let home = TempHome::create();
        let prebound = home.produce().expect("0700 cell directory must produce");
        let (mut platform, directory) = prebound.into_platform_parts();
        let metadata = platform
            .fstat(&directory)
            .expect("fstat produced descriptor");
        assert_eq!(metadata.kind, ObjectKind::Directory);
        assert_eq!(metadata.mode, 0o700);
        assert_eq!(metadata.owner_uid, TempHome::effective().effective_uid);
        assert_eq!(metadata.owner_gid, TempHome::effective().effective_gid);
        assert!(platform
            .descriptor_has_cloexec(&directory)
            .expect("cloexec"));
        platform
            .raw_close(directory)
            .expect("produced descriptor closes exactly once");
    }

    #[test]
    fn missing_cell_directory_fails_closed_without_creation() {
        let unique = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "tw-relay-v2-host-cell-factory-missing-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(root.join(".tmux-worktree")).expect("create namespace directory");
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).expect("home mode");
        fs::set_permissions(
            root.join(".tmux-worktree"),
            fs::Permissions::from_mode(0o700),
        )
        .expect("namespace mode");
        let result = secure_open_trusted_cell_directory(root.as_os_str(), TempHome::effective());
        assert_eq!(result.unwrap_err(), CellErrorCode::CellIo);
        assert_eq!(
            root.join(".tmux-worktree")
                .join("relay-v2-host-credential-atomic-file-cell-v1")
                .exists(),
            false,
            "a missing cell directory is never created"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn non_0700_cell_directory_fails_permission_invalid() {
        let home = TempHome::create();
        fs::set_permissions(&home.cell, fs::Permissions::from_mode(0o755))
            .expect("relax cell directory mode");
        assert_eq!(
            home.produce().unwrap_err(),
            CellErrorCode::CellPermissionInvalid
        );
    }

    #[test]
    fn symlink_cell_component_fails_identity_uncertain() {
        let home = TempHome::create();
        fs::remove_dir(&home.cell).expect("remove real cell directory");
        let target = home.root.join("elsewhere");
        fs::create_dir(&target).expect("create symlink target");
        fs::set_permissions(&target, fs::Permissions::from_mode(0o700)).expect("target mode");
        std::os::unix::fs::symlink(&target, &home.cell).expect("symlink cell component");
        assert_eq!(
            home.produce().unwrap_err(),
            CellErrorCode::CellIdentityUncertain
        );
    }

    #[test]
    fn regular_file_cell_component_fails_identity_uncertain() {
        let home = TempHome::create();
        fs::remove_dir(&home.cell).expect("remove real cell directory");
        fs::write(&home.cell, b"not-a-directory").expect("write file at cell path");
        assert_eq!(
            home.produce().unwrap_err(),
            CellErrorCode::CellIdentityUncertain
        );
    }

    #[test]
    fn group_writable_home_fails_permission_invalid() {
        let home = TempHome::create();
        fs::set_permissions(&home.root, fs::Permissions::from_mode(0o770))
            .expect("make home group writable");
        assert_eq!(
            home.produce().unwrap_err(),
            CellErrorCode::CellPermissionInvalid
        );
    }
}
