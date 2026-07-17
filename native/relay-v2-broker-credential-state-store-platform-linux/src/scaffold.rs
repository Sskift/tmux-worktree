use relay_v2_broker_credential_state_store_platform_common::{
    container_spec, reserve_process_store, ContainerSpec, DescriptorOperationFence,
    FinalCloseOperationFence, NativeStoreErrorCode, PlatformStoreFailure, ProcessBoundStateStore,
    ProcessLifecycleToken, SoleContainer, VerifiedHomeIdentity,
};
use std::collections::HashSet;
use std::ffi::{OsStr, OsString};
use std::os::unix::ffi::OsStrExt;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

pub(crate) const O_RDONLY: i32 = 0;
pub(crate) const O_RDWR: i32 = 2;
pub(crate) const O_CREAT: i32 = 0o100;
pub(crate) const O_EXCL: i32 = 0o200;
pub(crate) const O_CLOEXEC: i32 = 0o2_000_000;
pub(crate) const O_NOFOLLOW: i32 = 0o4_000_00;
pub(crate) const O_DIRECTORY: i32 = 0o2_000_00;
pub(crate) const FD_CLOEXEC: i32 = 1;

const DIRECTORY_FLAGS: i32 = O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC;
const EXISTING_FILE_FLAGS: i32 = O_RDWR | O_NOFOLLOW | O_CLOEXEC;
const CREATE_FILE_FLAGS: i32 = EXISTING_FILE_FLAGS | O_CREAT | O_EXCL;
const PRIVATE_DIRECTORY_MODE: u32 = 0o700;
const CONTAINER_MODE: u32 = 0o600;
const ACL_XATTR_VERSION: u32 = 0x0002;
const ACL_USER_OBJ: u16 = 0x0001;
const ACL_USER: u16 = 0x0002;
const ACL_GROUP_OBJ: u16 = 0x0004;
const ACL_GROUP: u16 = 0x0008;
const ACL_MASK: u16 = 0x0010;
const ACL_OTHER: u16 = 0x0020;
const ACL_WRITE: u8 = 0b010;
const MAX_ACL_XATTR: usize = 64 * 1024;

const LINUX_EPERM: i32 = 1;
const LINUX_EINTR: i32 = 4;
const LINUX_EIO: i32 = 5;
const LINUX_EACCES: i32 = 13;
const LINUX_ERANGE: i32 = 34;
const LINUX_ENODATA: i32 = 61;
const LINUX_ENOTSUP_OR_EOPNOTSUPP: i32 = 95;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Credentials {
    pub(crate) real_uid: u32,
    pub(crate) effective_uid: u32,
    pub(crate) real_gid: u32,
    pub(crate) effective_gid: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) enum FileKind {
    Directory,
    Regular,
    Symlink,
    Special,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Metadata {
    pub(crate) device: u64,
    pub(crate) inode: u64,
    pub(crate) kind: FileKind,
    pub(crate) mode: u32,
    pub(crate) uid: u32,
    pub(crate) gid: u32,
    pub(crate) links: u64,
    pub(crate) size: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct DurabilityEvidence {
    pub(crate) target: Metadata,
    pub(crate) filesystem_magic: i64,
    pub(crate) filesystem_flags: u64,
    /// No revision-2 record schema exists for the remaining ordered storage
    /// topology, firmware, cache, flush, FUA, PLP, and power-cut evidence.
    pub(crate) ordered_storage_evidence_complete: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) enum SysError {
    NotFound,
    AlreadyExists,
    Symlink,
    WrongType,
    Access,
    Again,
    Interrupted,
    NoData,
    AclSizeChanged,
    AclUnprovable,
    AclIo,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum AclXattrKind {
    Access,
    Default,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TraditionalRecordLock {
    pub(crate) write_lock: bool,
    pub(crate) whence_is_seek_set: bool,
    pub(crate) start: i64,
    pub(crate) length: i64,
}

impl TraditionalRecordLock {
    const WHOLE_FILE_WRITE: Self = Self {
        write_lock: true,
        whence_is_seek_set: true,
        start: 0,
        length: 0,
    };
}

pub(crate) trait LinuxSyscalls: Send + Sync + 'static {
    fn credential_snapshot(&self) -> Result<Credentials, SysError>;
    fn account_home(&self, effective_uid: u32) -> Result<Option<PathBuf>, SysError>;

    fn open_root(&self, flags: i32) -> Result<i32, SysError>;
    fn open_directory_at(
        &self,
        parent: i32,
        component: &OsStr,
        flags: i32,
    ) -> Result<i32, SysError>;
    fn mkdir_at(&self, parent: i32, component: &OsStr, mode: u32) -> Result<(), SysError>;
    fn open_file_at(
        &self,
        parent: i32,
        component: &OsStr,
        flags: i32,
        mode: u32,
    ) -> Result<i32, SysError>;

    fn fstat(&self, fd: i32) -> Result<Metadata, SysError>;
    fn fstatat_nofollow(&self, parent: i32, component: &OsStr) -> Result<Metadata, SysError>;
    /// Executes exactly one size-query `fgetxattr` syscall.
    fn acl_xattr_size(&self, fd: i32, kind: AclXattrKind) -> Result<Option<usize>, SysError>;
    /// Executes exactly one value-read `fgetxattr` syscall.
    fn acl_xattr_read(
        &self,
        fd: i32,
        kind: AclXattrKind,
        output: &mut [u8],
    ) -> Result<usize, SysError>;
    fn durability_probe(&self, fd: i32) -> Result<DurabilityEvidence, SysError>;

    fn fchmod(&self, fd: i32, mode: u32) -> Result<(), SysError>;
    fn ftruncate(&self, fd: i32, length: u64) -> Result<(), SysError>;
    fn fcntl_getfd(&self, fd: i32) -> Result<i32, SysError>;
    /// This seam is intentionally the traditional `F_SETLK` operation. There
    /// is no OFD-lock, blocking-lock, or flock operation in the adapter API.
    fn fcntl_setlk(&self, fd: i32, lock: TraditionalRecordLock) -> Result<(), SysError>;

    fn pread(&self, fd: i32, offset: u64, output: &mut [u8]) -> Result<usize, SysError>;
    fn pwrite(&self, fd: i32, offset: u64, bytes: &[u8]) -> Result<usize, SysError>;
    fn fsync(&self, fd: i32) -> Result<(), SysError>;
    fn close(&self, fd: i32) -> Result<(), SysError>;
}

pub(crate) trait QualificationPolicy {
    fn matches(&self, evidence: &DurabilityEvidence) -> bool;
}

/// Revision 2 has no qualified record item schema and no records. This policy
/// is the only policy used by a production entry point.
pub(crate) struct EmptyQualificationAllowlist;

impl QualificationPolicy for EmptyQualificationAllowlist {
    fn matches(&self, _evidence: &DurabilityEvidence) -> bool {
        false
    }
}

#[cfg(test)]
struct TestOnlyQualified;

#[cfg(test)]
impl QualificationPolicy for TestOnlyQualified {
    fn matches(&self, evidence: &DurabilityEvidence) -> bool {
        evidence.ordered_storage_evidence_complete
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OpenFailure {
    Platform(PlatformStoreFailure),
    Corrupt,
}

impl OpenFailure {
    fn code(self) -> NativeStoreErrorCode {
        match self {
            Self::Platform(error) => error.into(),
            Self::Corrupt => NativeStoreErrorCode::StoreCorrupt,
        }
    }
}

impl From<PlatformStoreFailure> for OpenFailure {
    fn from(error: PlatformStoreFailure) -> Self {
        Self::Platform(error)
    }
}

struct VerifiedHome<S: LinuxSyscalls> {
    syscalls: Arc<S>,
    fd: i32,
    metadata: Metadata,
}

struct PrequalifiedPath<S: LinuxSyscalls> {
    home: VerifiedHome<S>,
    private_fd: Option<i32>,
    evidence: DurabilityEvidence,
}

pub(crate) struct LinuxContainerCore<S: LinuxSyscalls> {
    syscalls: Arc<S>,
    container_fd: Option<i32>,
    parent_fd: Option<i32>,
    trusted_home_fd: Option<i32>,
    leaf: OsString,
    credentials: Credentials,
    created_container: bool,
    created_private_directory: bool,
    platform_open_complete: bool,
}

pub(crate) fn open_with_policy<S, C, Q, W>(
    syscalls: Arc<S>,
    lifecycle: &ProcessLifecycleToken,
    trusted_home: &Path,
    qualification: &Q,
    wrap: W,
) -> Result<ProcessBoundStateStore<C>, NativeStoreErrorCode>
where
    S: LinuxSyscalls,
    C: SoleContainer,
    Q: QualificationPolicy,
    W: FnOnce(LinuxContainerCore<S>) -> C,
{
    let credentials = syscalls
        .credential_snapshot()
        .map_err(|error| map_credential_error(error).code())?;
    validate_credentials(credentials).map_err(|error| error.code())?;
    let account_home = syscalls
        .account_home(credentials.effective_uid)
        .map_err(|error| map_account_error(error).code())?
        .ok_or(NativeStoreErrorCode::StorePermissionInvalid)?;
    let trusted_components = exact_absolute_components(trusted_home)
        .ok_or(NativeStoreErrorCode::StorePermissionInvalid)?;
    let account_components = exact_absolute_components(&account_home)
        .ok_or(NativeStoreErrorCode::StorePermissionInvalid)?;
    if trusted_components != account_components {
        return Err(NativeStoreErrorCode::StorePermissionInvalid);
    }

    let home = verify_account_home(Arc::clone(&syscalls), &trusted_components, credentials)
        .map_err(OpenFailure::code)?;
    let spec = container_spec();
    let [private_component, _leaf] = spec.relative_components() else {
        close_pre_registry(&syscalls, None, home.fd).map_err(OpenFailure::code)?;
        return Err(NativeStoreErrorCode::StoreIdentityUncertain);
    };
    let private_component = OsStr::new(private_component);
    let private_fd =
        match open_existing_private_directory(&syscalls, home.fd, private_component, credentials) {
            Ok(value) => value,
            Err(error) => {
                let _ = close_pre_registry(&syscalls, None, home.fd);
                return Err(error.code());
            }
        };
    let qualification_fd = private_fd.unwrap_or(home.fd);
    let evidence = match syscalls.durability_probe(qualification_fd) {
        Ok(evidence) => evidence,
        Err(error) => {
            let _ = close_pre_registry(&syscalls, private_fd, home.fd);
            return Err(map_io(error).code());
        }
    };
    let mut path = PrequalifiedPath {
        home,
        private_fd,
        evidence,
    };

    // Frozen ordering boundary: this return is before common registry reserve
    // and before mkdir/create/chmod/truncate/write/fsync/lock.
    if !qualification.matches(&path.evidence) {
        close_prequalified_path(&mut path).map_err(OpenFailure::code)?;
        return Err(NativeStoreErrorCode::DurabilityUnsupported);
    }

    let reservation = match reserve_process_store(
        lifecycle,
        VerifiedHomeIdentity::new(path.home.metadata.device, path.home.metadata.inode),
    ) {
        Ok(reservation) => reservation,
        Err(error) => {
            let _ = close_prequalified_path(&mut path);
            return Err(error.into());
        }
    };
    let target_fd = path.private_fd.unwrap_or(path.home.fd);
    let revalidated = match syscalls.fstat(target_fd) {
        Ok(metadata) => metadata,
        Err(error) => {
            let _ = reservation.release_proven_no_descriptor();
            let _ = close_prequalified_path(&mut path);
            return Err(map_io(error).code());
        }
    };
    if revalidated != path.evidence.target {
        let _ = reservation.release_proven_no_descriptor();
        let _ = close_prequalified_path(&mut path);
        return Err(NativeStoreErrorCode::StoreIdentityUncertain);
    }

    let admission = match reservation.begin_descriptor_open() {
        Ok(admission) => admission,
        Err(error) => {
            let _ = close_prequalified_path(&mut path);
            return Err(error.into());
        }
    };

    let mut created_private_directory = false;
    let parent_fd = if let Some(fd) = path.private_fd.take() {
        fd
    } else {
        if let Err(error) =
            syscalls.mkdir_at(path.home.fd, private_component, PRIVATE_DIRECTORY_MODE)
        {
            return fail_before_container(admission, &mut path, map_create_namespace_error(error));
        }
        created_private_directory = true;
        let fd = match syscalls.open_directory_at(path.home.fd, private_component, DIRECTORY_FLAGS)
        {
            Ok(fd) => fd,
            Err(error) => {
                return fail_before_container(admission, &mut path, map_path_open_error(error))
            }
        };
        if let Err(error) = syscalls.fchmod(fd, PRIVATE_DIRECTORY_MODE) {
            let _ = syscalls.close(fd);
            return fail_before_container(admission, &mut path, map_io(error));
        }
        if let Err(error) = verify_private_directory(&syscalls, fd, credentials) {
            let _ = syscalls.close(fd);
            return fail_before_container(admission, &mut path, error);
        }
        fd
    };

    let leaf = OsStr::new(spec.relative_components()[1]);
    let existing = match syscalls.fstatat_nofollow(parent_fd, leaf) {
        Ok(metadata) => {
            if let Err(error) = validate_existing_preflight(metadata, credentials, spec) {
                let _ = syscalls.close(parent_fd);
                return fail_before_container(admission, &mut path, error);
            }
            true
        }
        Err(SysError::NotFound) => false,
        Err(error) => {
            let _ = syscalls.close(parent_fd);
            return fail_before_container(admission, &mut path, map_preflight_error(error));
        }
    };
    let flags = if existing {
        EXISTING_FILE_FLAGS
    } else {
        CREATE_FILE_FLAGS
    };
    let container_fd = match syscalls.open_file_at(parent_fd, leaf, flags, CONTAINER_MODE) {
        Ok(fd) => fd,
        Err(error) => {
            let _ = syscalls.close(parent_fd);
            return fail_before_container(admission, &mut path, map_container_open_error(error));
        }
    };

    let core = LinuxContainerCore {
        syscalls,
        container_fd: Some(container_fd),
        parent_fd: Some(parent_fd),
        trusted_home_fd: Some(path.home.fd),
        leaf: leaf.to_os_string(),
        credentials,
        created_container: !existing,
        created_private_directory,
        platform_open_complete: false,
    };
    admission
        .attach(wrap(core))
        .map_err(NativeStoreErrorCode::from)?
        .finish()
}

fn fail_before_container<C: SoleContainer, S: LinuxSyscalls>(
    admission: relay_v2_broker_credential_state_store_platform_common::DescriptorOpenAdmission,
    path: &mut PrequalifiedPath<S>,
    primary: OpenFailure,
) -> Result<ProcessBoundStateStore<C>, NativeStoreErrorCode> {
    let release = admission.release_proven_no_descriptor();
    let close = close_prequalified_path(path);
    if let Err(error) = release {
        return Err(error.into());
    }
    if let Err(error) = close {
        return Err(error.code());
    }
    Err(primary.code())
}

fn validate_credentials(credentials: Credentials) -> Result<(), OpenFailure> {
    if credentials.real_uid != credentials.effective_uid
        || credentials.real_gid != credentials.effective_gid
        || credentials.real_uid == 0
        || credentials.effective_uid == 0
    {
        return Err(PlatformStoreFailure::PermissionInvalid.into());
    }
    Ok(())
}

fn exact_absolute_components(path: &Path) -> Option<Vec<OsString>> {
    let mut components = path.components();
    if !matches!(components.next(), Some(Component::RootDir)) {
        return None;
    }
    let mut result = Vec::new();
    for component in components {
        match component {
            Component::Normal(value) if !value.as_bytes().is_empty() => {
                result.push(value.to_os_string())
            }
            _ => return None,
        }
    }
    (!result.is_empty()).then_some(result)
}

fn verify_account_home<S: LinuxSyscalls>(
    syscalls: Arc<S>,
    components: &[OsString],
    credentials: Credentials,
) -> Result<VerifiedHome<S>, OpenFailure> {
    let mut current =
        retry_interrupted(|| syscalls.open_root(DIRECTORY_FLAGS)).map_err(map_path_open_error)?;
    for component in components {
        let child = match retry_interrupted(|| {
            syscalls.open_directory_at(current, component, DIRECTORY_FLAGS)
        }) {
            Ok(fd) => fd,
            Err(error) => {
                return fail_pre_registry_directory(&syscalls, current, map_path_open_error(error));
            }
        };
        let stable = stable_directory_entry(syscalls.as_ref(), current, component, child);
        let close_parent = syscalls.close(current);
        if let Err(error) = stable {
            let _ = syscalls.close(child);
            return Err(error);
        }
        if close_parent.is_err() {
            let _ = syscalls.close(child);
            return Err(PlatformStoreFailure::Io.into());
        }
        current = child;
    }
    let metadata = match syscalls.fstat(current) {
        Ok(metadata) => metadata,
        Err(error) => return fail_pre_registry_directory(&syscalls, current, map_io(error)),
    };
    if metadata.kind != FileKind::Directory
        || metadata.uid != credentials.effective_uid
        || metadata.mode & 0o022 != 0
    {
        return fail_pre_registry_directory(
            &syscalls,
            current,
            PlatformStoreFailure::PermissionInvalid.into(),
        );
    }
    if let Err(error) = validate_acl(syscalls.as_ref(), current, metadata, true) {
        return fail_pre_registry_directory(&syscalls, current, error);
    }
    Ok(VerifiedHome {
        syscalls,
        fd: current,
        metadata,
    })
}

fn fail_pre_registry_directory<S: LinuxSyscalls, T>(
    syscalls: &Arc<S>,
    fd: i32,
    primary: OpenFailure,
) -> Result<T, OpenFailure> {
    // Pre-registry cleanup gets one raw close attempt with no EINTR retry.
    // The already-observed primary failure retains precedence over cleanup.
    let _ = syscalls.close(fd);
    Err(primary)
}

fn stable_directory_entry<S: LinuxSyscalls>(
    syscalls: &S,
    parent: i32,
    component: &OsStr,
    child: i32,
) -> Result<Metadata, OpenFailure> {
    let a = syscalls.fstat(child).map_err(map_io)?;
    let b = syscalls
        .fstatat_nofollow(parent, component)
        .map_err(map_entry_observation)?;
    let c = syscalls.fstat(child).map_err(map_io)?;
    if a != b || b != c || a.kind != FileKind::Directory {
        return Err(PlatformStoreFailure::IdentityUncertain.into());
    }
    Ok(a)
}

fn open_existing_private_directory<S: LinuxSyscalls>(
    syscalls: &Arc<S>,
    home_fd: i32,
    component: &OsStr,
    credentials: Credentials,
) -> Result<Option<i32>, OpenFailure> {
    let fd =
        match retry_interrupted(|| syscalls.open_directory_at(home_fd, component, DIRECTORY_FLAGS))
        {
            Ok(fd) => fd,
            Err(SysError::NotFound) => return Ok(None),
            Err(error) => return Err(map_path_open_error(error)),
        };
    let metadata = match stable_directory_entry(syscalls.as_ref(), home_fd, component, fd) {
        Ok(metadata) => metadata,
        Err(error) => {
            let _ = syscalls.close(fd);
            return Err(error);
        }
    };
    if let Err(error) = validate_private_metadata(metadata, credentials) {
        let _ = syscalls.close(fd);
        return Err(error);
    }
    if let Err(error) = validate_acl(syscalls.as_ref(), fd, metadata, true) {
        let _ = syscalls.close(fd);
        return Err(error);
    }
    Ok(Some(fd))
}

fn verify_private_directory<S: LinuxSyscalls>(
    syscalls: &Arc<S>,
    fd: i32,
    credentials: Credentials,
) -> Result<(), OpenFailure> {
    let metadata = syscalls.fstat(fd).map_err(map_io)?;
    validate_private_metadata(metadata, credentials)?;
    validate_acl(syscalls.as_ref(), fd, metadata, true)
}

fn validate_private_metadata(
    metadata: Metadata,
    credentials: Credentials,
) -> Result<(), OpenFailure> {
    if metadata.kind != FileKind::Directory
        || metadata.uid != credentials.effective_uid
        || metadata.gid != credentials.effective_gid
        || metadata.mode != PRIVATE_DIRECTORY_MODE
    {
        return Err(PlatformStoreFailure::PermissionInvalid.into());
    }
    Ok(())
}

fn validate_existing_preflight(
    metadata: Metadata,
    credentials: Credentials,
    spec: &ContainerSpec,
) -> Result<(), OpenFailure> {
    match metadata.kind {
        FileKind::Regular => {}
        FileKind::Symlink | FileKind::Directory | FileKind::Special => {
            return Err(PlatformStoreFailure::IdentityUncertain.into())
        }
    }
    if metadata.links != 1 {
        return Err(PlatformStoreFailure::IdentityUncertain.into());
    }
    if metadata.uid != credentials.effective_uid
        || metadata.gid != credentials.effective_gid
        || metadata.mode != CONTAINER_MODE
    {
        return Err(PlatformStoreFailure::PermissionInvalid.into());
    }
    if metadata.size != spec.file_length() {
        return Err(OpenFailure::Corrupt);
    }
    Ok(())
}

fn close_pre_registry<S: LinuxSyscalls>(
    syscalls: &Arc<S>,
    private_fd: Option<i32>,
    home_fd: i32,
) -> Result<(), OpenFailure> {
    let mut failed = false;
    if let Some(fd) = private_fd {
        failed |= syscalls.close(fd).is_err();
    }
    failed |= syscalls.close(home_fd).is_err();
    if failed {
        Err(PlatformStoreFailure::Io.into())
    } else {
        Ok(())
    }
}

fn close_prequalified_path<S: LinuxSyscalls>(
    path: &mut PrequalifiedPath<S>,
) -> Result<(), OpenFailure> {
    let private_fd = path.private_fd.take();
    close_pre_registry(&path.home.syscalls, private_fd, path.home.fd)
}

impl<S: LinuxSyscalls> LinuxContainerCore<S> {
    fn descriptor(&self) -> Result<i32, PlatformStoreFailure> {
        self.container_fd.ok_or(PlatformStoreFailure::Closed)
    }

    fn complete_open(
        &mut self,
        fence: &DescriptorOperationFence,
        spec: &ContainerSpec,
    ) -> Result<(), PlatformStoreFailure> {
        let fd = self.descriptor()?;
        if self.created_container {
            descriptor_call(fence, || self.syscalls.fchmod(fd, CONTAINER_MODE))?;
        }
        let descriptor_flags = descriptor_call(fence, || self.syscalls.fcntl_getfd(fd))?;
        if descriptor_flags & FD_CLOEXEC == 0 {
            return Err(PlatformStoreFailure::IdentityUncertain);
        }
        fence.check()?;
        match self
            .syscalls
            .fcntl_setlk(fd, TraditionalRecordLock::WHOLE_FILE_WRITE)
        {
            Ok(()) => {}
            Err(SysError::Access | SysError::Again) => return Err(PlatformStoreFailure::Busy),
            Err(_) => return Err(PlatformStoreFailure::Io),
        }

        let initial = descriptor_call(fence, || self.syscalls.fstat(fd))?;
        validate_open_container_metadata(
            initial,
            self.credentials,
            (!self.created_container).then_some(spec.file_length()),
        )?;
        validate_acl_for_descriptor(self.syscalls.as_ref(), fence, fd, initial, false)?;

        if self.created_container {
            retry_descriptor_interrupted(fence, || {
                self.syscalls.ftruncate(fd, spec.file_length())
            })?;
            retry_descriptor_interrupted(fence, || self.syscalls.fsync(fd))?;
            let parent_fd = self.parent_fd.ok_or(PlatformStoreFailure::Closed)?;
            retry_descriptor_interrupted(fence, || self.syscalls.fsync(parent_fd))?;
            if self.created_private_directory {
                let home_fd = self.trusted_home_fd.ok_or(PlatformStoreFailure::Closed)?;
                retry_descriptor_interrupted(fence, || self.syscalls.fsync(home_fd))?;
            }
        }

        self.final_abc_proof(fence, spec)?;
        self.close_directories(fence)?;
        self.platform_open_complete = true;
        Ok(())
    }

    fn final_abc_proof(
        &self,
        fence: &DescriptorOperationFence,
        spec: &ContainerSpec,
    ) -> Result<(), PlatformStoreFailure> {
        let fd = self.descriptor()?;
        let parent_fd = self.parent_fd.ok_or(PlatformStoreFailure::Closed)?;
        let a = descriptor_call(fence, || self.syscalls.fstat(fd))?;
        let b = descriptor_call(fence, || {
            self.syscalls.fstatat_nofollow(parent_fd, &self.leaf)
        })?;
        let c = descriptor_call(fence, || self.syscalls.fstat(fd))?;
        if a != b || b != c {
            return Err(PlatformStoreFailure::IdentityUncertain);
        }
        validate_open_container_metadata(a, self.credentials, Some(spec.file_length()))
    }

    fn close_directories(
        &mut self,
        fence: &DescriptorOperationFence,
    ) -> Result<(), PlatformStoreFailure> {
        let mut failed = false;
        if let Some(parent) = self.parent_fd.take() {
            fence.check()?;
            failed |= self.syscalls.close(parent).is_err();
        }
        if let Some(home) = self.trusted_home_fd.take() {
            fence.check()?;
            failed |= self.syscalls.close(home).is_err();
        }
        if failed {
            Err(PlatformStoreFailure::Io)
        } else {
            Ok(())
        }
    }

    fn close_for_common(
        &mut self,
        fence: &FinalCloseOperationFence,
    ) -> Result<(), PlatformStoreFailure> {
        let mut directory_failure = false;
        if let Some(parent) = self.parent_fd.take() {
            fence.check()?;
            directory_failure |= self.syscalls.close(parent).is_err();
        }
        if let Some(home) = self.trusted_home_fd.take() {
            fence.check()?;
            directory_failure |= self.syscalls.close(home).is_err();
        }
        let fd = self
            .container_fd
            .take()
            .ok_or(PlatformStoreFailure::Closed)?;
        // The sole container close is deliberately the final native action.
        // Its first result, including EINTR, is returned without retry.
        fence.check()?;
        let close_result = self.syscalls.close(fd);
        if directory_failure || close_result.is_err() {
            Err(PlatformStoreFailure::Io)
        } else {
            Ok(())
        }
    }
}

impl<S: LinuxSyscalls> SoleContainer for LinuxContainerCore<S> {
    fn complete_platform_open(
        &mut self,
        fence: &DescriptorOperationFence,
        spec: &ContainerSpec,
    ) -> Result<(), PlatformStoreFailure> {
        self.complete_open(fence, spec)
    }

    fn file_length(&self, fence: &DescriptorOperationFence) -> Result<u64, PlatformStoreFailure> {
        let fd = self.descriptor()?;
        let metadata = descriptor_call(fence, || self.syscalls.fstat(fd))?;
        Ok(metadata.size)
    }

    fn read_exact_at(
        &self,
        fence: &DescriptorOperationFence,
        absolute_offset: u64,
        output: &mut [u8],
    ) -> Result<(), PlatformStoreFailure> {
        let fd = self.descriptor()?;
        let mut completed = 0_usize;
        while completed < output.len() {
            fence.check()?;
            match self.syscalls.pread(
                fd,
                absolute_offset + completed as u64,
                &mut output[completed..],
            ) {
                Ok(0) => return Err(PlatformStoreFailure::Io),
                Ok(count) if count <= output.len() - completed => completed += count,
                Ok(_) => return Err(PlatformStoreFailure::Io),
                Err(SysError::Interrupted) => continue,
                Err(_) => return Err(PlatformStoreFailure::Io),
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
        let fd = self.descriptor()?;
        let mut completed = 0_usize;
        while completed < bytes.len() {
            fence.check()?;
            match self
                .syscalls
                .pwrite(fd, absolute_offset + completed as u64, &bytes[completed..])
            {
                Ok(0) => return Err(PlatformStoreFailure::Io),
                Ok(count) if count <= bytes.len() - completed => completed += count,
                Ok(_) => return Err(PlatformStoreFailure::Io),
                Err(SysError::Interrupted) => continue,
                Err(_) => return Err(PlatformStoreFailure::Io),
            }
        }
        Ok(())
    }

    fn payload_durability_barrier(
        &mut self,
        fence: &DescriptorOperationFence,
    ) -> Result<(), PlatformStoreFailure> {
        let fd = self.descriptor()?;
        retry_descriptor_interrupted(fence, || self.syscalls.fsync(fd))
    }

    fn header_and_container_durability_barrier(
        &mut self,
        fence: &DescriptorOperationFence,
    ) -> Result<(), PlatformStoreFailure> {
        let fd = self.descriptor()?;
        retry_descriptor_interrupted(fence, || self.syscalls.fsync(fd))
    }

    fn final_close(
        &mut self,
        fence: &FinalCloseOperationFence,
    ) -> Result<(), PlatformStoreFailure> {
        self.close_for_common(fence)
    }
}

fn validate_open_container_metadata(
    metadata: Metadata,
    credentials: Credentials,
    exact_size: Option<u64>,
) -> Result<(), PlatformStoreFailure> {
    if metadata.kind != FileKind::Regular || metadata.links != 1 {
        return Err(PlatformStoreFailure::IdentityUncertain);
    }
    if metadata.uid != credentials.effective_uid
        || metadata.gid != credentials.effective_gid
        || metadata.mode != CONTAINER_MODE
    {
        return Err(PlatformStoreFailure::PermissionInvalid);
    }
    if exact_size.is_some_and(|size| metadata.size != size) {
        return Err(PlatformStoreFailure::IdentityUncertain);
    }
    Ok(())
}

fn descriptor_call<T>(
    fence: &DescriptorOperationFence,
    operation: impl FnOnce() -> Result<T, SysError>,
) -> Result<T, PlatformStoreFailure> {
    fence.check()?;
    operation().map_err(map_descriptor_error)
}

fn retry_descriptor_interrupted(
    fence: &DescriptorOperationFence,
    mut operation: impl FnMut() -> Result<(), SysError>,
) -> Result<(), PlatformStoreFailure> {
    loop {
        fence.check()?;
        match operation() {
            Ok(()) => return Ok(()),
            Err(SysError::Interrupted) => continue,
            Err(error) => return Err(map_descriptor_error(error)),
        }
    }
}

fn retry_interrupted<T>(mut operation: impl FnMut() -> Result<T, SysError>) -> Result<T, SysError> {
    loop {
        match operation() {
            Err(SysError::Interrupted) => continue,
            result => return result,
        }
    }
}

fn validate_acl_for_descriptor<S: LinuxSyscalls>(
    syscalls: &S,
    fence: &DescriptorOperationFence,
    fd: i32,
    metadata: Metadata,
    directory: bool,
) -> Result<(), PlatformStoreFailure> {
    validate_acl_with_syscall_check(syscalls, fd, metadata, directory, || {
        fence.check().map_err(OpenFailure::from)
    })
    .map_err(|error| match error {
        OpenFailure::Platform(error) => error,
        OpenFailure::Corrupt => PlatformStoreFailure::PermissionInvalid,
    })
}

fn validate_acl<S: LinuxSyscalls>(
    syscalls: &S,
    fd: i32,
    metadata: Metadata,
    directory: bool,
) -> Result<(), OpenFailure> {
    validate_acl_with_syscall_check(syscalls, fd, metadata, directory, || Ok(()))
}

fn validate_acl_with_syscall_check<S: LinuxSyscalls>(
    syscalls: &S,
    fd: i32,
    metadata: Metadata,
    directory: bool,
    mut before_syscall: impl FnMut() -> Result<(), OpenFailure>,
) -> Result<(), OpenFailure> {
    let access = read_acl_xattr(syscalls, fd, AclXattrKind::Access, &mut before_syscall)?;
    if let Some(bytes) = access {
        let acl = ParsedAcl::parse(&bytes)?;
        acl.prove_access_mode(metadata.mode)?;
    }
    let default = read_acl_xattr(syscalls, fd, AclXattrKind::Default, &mut before_syscall)?;
    if let Some(bytes) = default {
        if !directory {
            return Err(PlatformStoreFailure::PermissionInvalid.into());
        }
        ParsedAcl::parse(&bytes)?.prove_default_does_not_relax_descendants()?;
    }
    Ok(())
}

fn read_acl_xattr<S: LinuxSyscalls>(
    syscalls: &S,
    fd: i32,
    kind: AclXattrKind,
    before_syscall: &mut impl FnMut() -> Result<(), OpenFailure>,
) -> Result<Option<Vec<u8>>, OpenFailure> {
    for _ in 0..3 {
        before_syscall()?;
        let size = match syscalls.acl_xattr_size(fd, kind) {
            Ok(None) | Err(SysError::NoData) => return Ok(None),
            Ok(Some(size)) if size <= MAX_ACL_XATTR => size,
            Ok(Some(_)) => return Err(PlatformStoreFailure::PermissionInvalid.into()),
            Err(SysError::Interrupted | SysError::AclSizeChanged) => continue,
            Err(error) => return Err(map_acl_error(error)),
        };
        let mut value = vec![0_u8; size];
        before_syscall()?;
        match syscalls.acl_xattr_read(fd, kind, &mut value) {
            Ok(read) if read == value.len() => return Ok(Some(value)),
            Ok(_) | Err(SysError::Interrupted | SysError::AclSizeChanged) => continue,
            Err(SysError::NoData) => return Ok(None),
            Err(error) => return Err(map_acl_error(error)),
        }
    }
    Err(PlatformStoreFailure::PermissionInvalid.into())
}

pub(crate) fn classify_acl_xattr_errno(errno: i32) -> SysError {
    match errno {
        LINUX_EINTR => SysError::Interrupted,
        LINUX_ENODATA => SysError::NoData,
        LINUX_ERANGE => SysError::AclSizeChanged,
        LINUX_EIO => SysError::AclIo,
        LINUX_EPERM | LINUX_EACCES | LINUX_ENOTSUP_OR_EOPNOTSUPP => SysError::AclUnprovable,
        _ => SysError::AclIo,
    }
}

#[derive(Default)]
struct ParsedAcl {
    owner: Option<u8>,
    group: Option<u8>,
    mask: Option<u8>,
    other: Option<u8>,
    named_users: Vec<u8>,
    named_groups: Vec<u8>,
}

impl ParsedAcl {
    fn parse(bytes: &[u8]) -> Result<Self, OpenFailure> {
        if bytes.len() < 4 || (bytes.len() - 4) % 8 != 0 {
            return Err(PlatformStoreFailure::PermissionInvalid.into());
        }
        if u32::from_le_bytes(bytes[0..4].try_into().expect("ACL version")) != ACL_XATTR_VERSION {
            return Err(PlatformStoreFailure::PermissionInvalid.into());
        }
        let mut parsed = Self::default();
        let mut named_ids = HashSet::new();
        for entry in bytes[4..].chunks_exact(8) {
            let tag = u16::from_le_bytes(entry[0..2].try_into().expect("ACL tag"));
            let permissions = u16::from_le_bytes(entry[2..4].try_into().expect("ACL perms"));
            let id = u32::from_le_bytes(entry[4..8].try_into().expect("ACL id"));
            if permissions & !0b111 != 0 {
                return Err(PlatformStoreFailure::PermissionInvalid.into());
            }
            let permissions = permissions as u8;
            let slot = match tag {
                ACL_USER_OBJ if id == u32::MAX => Some(&mut parsed.owner),
                ACL_GROUP_OBJ if id == u32::MAX => Some(&mut parsed.group),
                ACL_MASK if id == u32::MAX => Some(&mut parsed.mask),
                ACL_OTHER if id == u32::MAX => Some(&mut parsed.other),
                ACL_USER if id != u32::MAX && named_ids.insert((tag, id)) => {
                    parsed.named_users.push(permissions);
                    None
                }
                ACL_GROUP if id != u32::MAX && named_ids.insert((tag, id)) => {
                    parsed.named_groups.push(permissions);
                    None
                }
                _ => return Err(PlatformStoreFailure::PermissionInvalid.into()),
            };
            if let Some(slot) = slot {
                if slot.replace(permissions).is_some() {
                    return Err(PlatformStoreFailure::PermissionInvalid.into());
                }
            }
        }
        if parsed.owner.is_none() || parsed.group.is_none() || parsed.other.is_none() {
            return Err(PlatformStoreFailure::PermissionInvalid.into());
        }
        if (!parsed.named_users.is_empty() || !parsed.named_groups.is_empty())
            && parsed.mask.is_none()
        {
            return Err(PlatformStoreFailure::PermissionInvalid.into());
        }
        Ok(parsed)
    }

    fn prove_access_mode(&self, mode: u32) -> Result<(), OpenFailure> {
        let owner_mode = ((mode >> 6) & 0b111) as u8;
        let group_mode = ((mode >> 3) & 0b111) as u8;
        let other_mode = (mode & 0b111) as u8;
        if self.owner != Some(owner_mode) || self.other != Some(other_mode) {
            return Err(PlatformStoreFailure::PermissionInvalid.into());
        }
        let effective_mask = self.mask.unwrap_or(0b111);
        if self.mask.is_some_and(|mask| mask != group_mode)
            || self.group.expect("validated group") & effective_mask & !group_mode != 0
            || self
                .named_users
                .iter()
                .chain(&self.named_groups)
                .any(|permissions| permissions & effective_mask & !group_mode != 0)
        {
            return Err(PlatformStoreFailure::PermissionInvalid.into());
        }
        Ok(())
    }

    fn prove_default_does_not_relax_descendants(&self) -> Result<(), OpenFailure> {
        let effective_mask = self.mask.unwrap_or(0b111);
        let non_owner_permissions = self.group.expect("validated group") & effective_mask
            | self.other.expect("validated other")
            | self
                .named_users
                .iter()
                .chain(&self.named_groups)
                .fold(0, |combined, permissions| {
                    combined | permissions & effective_mask
                });
        if non_owner_permissions != 0 {
            return Err(PlatformStoreFailure::PermissionInvalid.into());
        }
        Ok(())
    }
}

fn map_credential_error(error: SysError) -> OpenFailure {
    match error {
        SysError::Access | SysError::AclUnprovable => {
            PlatformStoreFailure::PermissionInvalid.into()
        }
        _ => PlatformStoreFailure::Io.into(),
    }
}

fn map_account_error(error: SysError) -> OpenFailure {
    match error {
        SysError::NotFound => PlatformStoreFailure::PermissionInvalid.into(),
        _ => PlatformStoreFailure::Io.into(),
    }
}

fn map_path_open_error(error: SysError) -> OpenFailure {
    match error {
        SysError::NotFound | SysError::Symlink | SysError::WrongType => {
            PlatformStoreFailure::IdentityUncertain.into()
        }
        SysError::Access | SysError::AclUnprovable => {
            PlatformStoreFailure::PermissionInvalid.into()
        }
        _ => PlatformStoreFailure::Io.into(),
    }
}

fn map_entry_observation(error: SysError) -> OpenFailure {
    match error {
        SysError::NotFound | SysError::Symlink => PlatformStoreFailure::IdentityUncertain.into(),
        _ => map_io(error),
    }
}

fn map_create_namespace_error(error: SysError) -> OpenFailure {
    match error {
        SysError::AlreadyExists | SysError::Symlink => {
            PlatformStoreFailure::IdentityUncertain.into()
        }
        SysError::Access => PlatformStoreFailure::PermissionInvalid.into(),
        _ => PlatformStoreFailure::Io.into(),
    }
}

fn map_preflight_error(error: SysError) -> OpenFailure {
    match error {
        SysError::Symlink => PlatformStoreFailure::IdentityUncertain.into(),
        SysError::Access | SysError::AclUnprovable => {
            PlatformStoreFailure::PermissionInvalid.into()
        }
        _ => PlatformStoreFailure::Io.into(),
    }
}

fn map_container_open_error(error: SysError) -> OpenFailure {
    match error {
        SysError::NotFound | SysError::AlreadyExists | SysError::Symlink | SysError::WrongType => {
            PlatformStoreFailure::IdentityUncertain.into()
        }
        SysError::Access => PlatformStoreFailure::PermissionInvalid.into(),
        _ => PlatformStoreFailure::Io.into(),
    }
}

fn map_acl_error(error: SysError) -> OpenFailure {
    match error {
        SysError::Access | SysError::AclUnprovable => {
            PlatformStoreFailure::PermissionInvalid.into()
        }
        _ => PlatformStoreFailure::Io.into(),
    }
}

fn map_io(_error: SysError) -> OpenFailure {
    PlatformStoreFailure::Io.into()
}

fn map_descriptor_error(error: SysError) -> PlatformStoreFailure {
    match error {
        SysError::AclUnprovable => PlatformStoreFailure::PermissionInvalid,
        SysError::Symlink | SysError::NotFound | SysError::AlreadyExists => {
            PlatformStoreFailure::IdentityUncertain
        }
        _ => PlatformStoreFailure::Io,
    }
}

#[cfg(test)]
mod tests;
