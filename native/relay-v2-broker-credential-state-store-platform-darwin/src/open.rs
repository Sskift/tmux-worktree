use crate::acl::validate_acl;
use crate::sys::{
    c_component, Credentials, DarwinSyscalls, DurabilityEvidence, FileMetadata, LockRequest,
    NativeDarwinSyscalls, SyscallError, CREATE_CONTAINER_OPEN_FLAGS, DIRECTORY_OPEN_FLAGS,
    EXISTING_CONTAINER_OPEN_FLAGS, SYNC_VOLUME_FULLSYNC, SYNC_VOLUME_WAIT,
};
use relay_v2_broker_credential_state_store_platform_common::{
    container_spec, reserve_process_store, ContainerSpec, DescriptorOperationFence,
    FinalCloseOperationFence, NativeStoreErrorCode, PlatformStoreFailure, ProcessBoundStateStore,
    ProcessLifecycleToken, SoleContainer, VerifiedHomeIdentity,
};
use std::ffi::{CString, OsStr};
use std::os::fd::RawFd;
use std::os::unix::ffi::OsStrExt;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

/// Attempts the frozen Darwin open with the production qualification policy.
///
/// Revision 2 has no qualified durability records, so every call returns
/// `DURABILITY_UNSUPPORTED` after read-only account/home/filesystem evidence
/// collection and before process-registry reservation or filesystem mutation.
pub fn open(
    lifecycle: &ProcessLifecycleToken,
    trusted_home: &Path,
    max_state_bytes: usize,
) -> Result<ProcessBoundStateStore<impl SoleContainer>, NativeStoreErrorCode> {
    open_with(
        lifecycle,
        trusted_home,
        max_state_bytes,
        Arc::new(NativeDarwinSyscalls),
        ProductionQualification,
    )
}

trait QualificationPolicy {
    fn qualify(
        &self,
        evidence: Result<DurabilityEvidence, SyscallError>,
    ) -> Result<(), PlatformStoreFailure>;
}

struct ProductionQualification;

impl QualificationPolicy for ProductionQualification {
    fn qualify(
        &self,
        evidence: Result<DurabilityEvidence, SyscallError>,
    ) -> Result<(), PlatformStoreFailure> {
        // Evidence collection is attempted, but neither observed nor
        // unobservable evidence can instantiate a record: revision 2 defines
        // no item schema, qualified item, or wildcard.
        if let Ok(evidence) = evidence {
            let _observed = (
                evidence.filesystem_name,
                evidence.mount_flags,
                evidence.source_name,
            );
        }
        Err(PlatformStoreFailure::DurabilityUnsupported)
    }
}

#[cfg(test)]
#[derive(Clone, Copy)]
struct TestQualified;

#[cfg(test)]
impl QualificationPolicy for TestQualified {
    fn qualify(
        &self,
        evidence: Result<DurabilityEvidence, SyscallError>,
    ) -> Result<(), PlatformStoreFailure> {
        evidence.map(|_| ()).map_err(|_| PlatformStoreFailure::Io)
    }
}

fn open_with<S: DarwinSyscalls, Q: QualificationPolicy>(
    lifecycle: &ProcessLifecycleToken,
    trusted_home: &Path,
    max_state_bytes: usize,
    sys: Arc<S>,
    qualification: Q,
) -> Result<ProcessBoundStateStore<DarwinContainer<S>>, NativeStoreErrorCode> {
    let spec = container_spec();
    if max_state_bytes != spec.max_state_bytes() {
        return Err(NativeStoreErrorCode::InvalidArgument);
    }
    let credentials = sys.credentials();
    validate_credentials(credentials).map_err(NativeStoreErrorCode::from)?;
    let account_home = PathBuf::from(
        sys.account_home(credentials.effective_uid)
            .map_err(NativeStoreErrorCode::from)?,
    );
    let caller_components =
        absolute_components(trusted_home).map_err(NativeStoreErrorCode::from)?;
    let account_components =
        absolute_components(&account_home).map_err(NativeStoreErrorCode::from)?;
    if caller_components != account_components {
        return Err(NativeStoreErrorCode::StorePermissionInvalid);
    }

    let (leaf, private_components) =
        manifest_components(spec).map_err(NativeStoreErrorCode::from)?;
    let mut context = verify_home(
        Arc::clone(&sys),
        &caller_components,
        credentials.effective_uid,
        credentials.effective_gid,
    )
    .map_err(NativeStoreErrorCode::from)?;
    inspect_private_path(&mut context, &private_components).map_err(NativeStoreErrorCode::from)?;

    let target_fd = if context.first_missing_private.is_none() {
        context.parent_fd
    } else {
        context.home_fd
    };
    let target_before = sys
        .stat(target_fd)
        .map_err(|_| NativeStoreErrorCode::StoreIo)?;
    let evidence = sys.durability_evidence(target_fd);
    // This is the production stop point for the empty allowlist. No registry
    // call or mutating syscall is reachable before this exact decision.
    qualification
        .qualify(evidence)
        .map_err(NativeStoreErrorCode::from)?;

    let reservation = reserve_process_store(
        lifecycle,
        VerifiedHomeIdentity::new(context.home_metadata.device, context.home_metadata.inode),
    )
    .map_err(NativeStoreErrorCode::from)?;
    let target_after = match sys.stat(target_fd) {
        Ok(metadata) => metadata,
        Err(_) => {
            let _ = reservation.release_proven_no_descriptor();
            return Err(NativeStoreErrorCode::StoreIo);
        }
    };
    if target_before != target_after {
        let _ = reservation.release_proven_no_descriptor();
        return Err(NativeStoreErrorCode::StoreIdentityUncertain);
    }

    let admission = reservation
        .begin_descriptor_open()
        .map_err(NativeStoreErrorCode::from)?;
    if let Err(error) = create_missing_private_path(&mut context, &private_components) {
        let _ = admission.release_proven_no_descriptor();
        return Err(error.into());
    }

    let preflight = match sys.stat_at(context.parent_fd, &leaf, libc::AT_SYMLINK_NOFOLLOW) {
        Ok(metadata) => {
            match validate_existing_container_preflight(metadata, credentials, spec.file_length()) {
                Ok(()) => Some(metadata),
                Err(error) => {
                    let _ = admission.release_proven_no_descriptor();
                    return Err(error);
                }
            }
        }
        Err(error) if error.is(libc::ENOENT) => None,
        Err(error) if error.is(libc::ELOOP) || error.is(libc::ENOTDIR) => {
            let _ = admission.release_proven_no_descriptor();
            return Err(NativeStoreErrorCode::StoreIdentityUncertain);
        }
        Err(_) => {
            let _ = admission.release_proven_no_descriptor();
            return Err(NativeStoreErrorCode::StoreIo);
        }
    };
    let created = preflight.is_none();
    let flags = if created {
        CREATE_CONTAINER_OPEN_FLAGS
    } else {
        EXISTING_CONTAINER_OPEN_FLAGS
    };
    debug_assert_eq!(flags & (libc::O_TRUNC | libc::O_EXLOCK), 0);
    let container_fd = match sys.open_at(context.parent_fd, &leaf, flags, 0o600) {
        Ok(fd) => fd,
        Err(error) => {
            let _ = admission.release_proven_no_descriptor();
            return Err(map_open_error(error, created));
        }
    };

    let (home_fd, parent_fd) = context.take_directories();
    let container = DarwinContainer {
        sys,
        container_fd: Some(container_fd),
        context: Some(ContainerOpenContext {
            home_fd,
            parent_fd,
            leaf,
            credentials,
            preflight,
            created_container: created,
            created_private_directory: context.created_private_directory,
        }),
    };
    admission
        .attach(container)
        .map_err(NativeStoreErrorCode::from)?
        .finish()
}

fn validate_credentials(credentials: Credentials) -> Result<(), PlatformStoreFailure> {
    if credentials.real_uid != credentials.effective_uid
        || credentials.real_gid != credentials.effective_gid
        || credentials.real_uid == 0
        || credentials.effective_uid == 0
    {
        Err(PlatformStoreFailure::PermissionInvalid)
    } else {
        Ok(())
    }
}

fn absolute_components(path: &Path) -> Result<Vec<CString>, PlatformStoreFailure> {
    let mut components = path.components();
    if !matches!(components.next(), Some(Component::RootDir)) {
        return Err(PlatformStoreFailure::PermissionInvalid);
    }
    let mut result = Vec::new();
    for component in components {
        let Component::Normal(value) = component else {
            return Err(PlatformStoreFailure::PermissionInvalid);
        };
        result.push(c_os_component(value)?);
    }
    if result.is_empty() {
        return Err(PlatformStoreFailure::PermissionInvalid);
    }
    Ok(result)
}

fn c_os_component(component: &OsStr) -> Result<CString, PlatformStoreFailure> {
    if component.as_bytes().is_empty() {
        return Err(PlatformStoreFailure::IdentityUncertain);
    }
    CString::new(component.as_bytes()).map_err(|_| PlatformStoreFailure::IdentityUncertain)
}

fn manifest_components(
    spec: &ContainerSpec,
) -> Result<(CString, Vec<CString>), PlatformStoreFailure> {
    let (leaf, parents) = spec
        .relative_components()
        .split_last()
        .ok_or(PlatformStoreFailure::IdentityUncertain)?;
    let leaf = c_component(leaf)?;
    let parents = parents
        .iter()
        .map(|component| c_component(component))
        .collect::<Result<Vec<_>, _>>()?;
    Ok((leaf, parents))
}

struct PreOpenContext<S: DarwinSyscalls> {
    sys: Arc<S>,
    home_fd: RawFd,
    parent_fd: RawFd,
    home_metadata: FileMetadata,
    effective_uid: u32,
    effective_gid: u32,
    first_missing_private: Option<usize>,
    created_private_directory: bool,
}

impl<S: DarwinSyscalls> PreOpenContext<S> {
    fn replace_parent(&mut self, next: RawFd) -> Result<(), PlatformStoreFailure> {
        let old = self.parent_fd;
        if old != self.home_fd {
            // A failed raw close is uncertain and must never be retried by
            // Drop. Keep `next` outside this context until the old owner has
            // been retired successfully.
            self.parent_fd = -1;
            self.sys.close(old).map_err(|_| PlatformStoreFailure::Io)?;
        }
        self.parent_fd = next;
        Ok(())
    }

    fn take_directories(&mut self) -> (RawFd, RawFd) {
        let directories = (self.home_fd, self.parent_fd);
        self.home_fd = -1;
        self.parent_fd = -1;
        directories
    }
}

/// Exactly-once owner for a directory descriptor before it is transferred to
/// `PreOpenContext`. Every early return makes one close attempt; explicit close
/// makes the guard inert before the syscall so an uncertain failure is never
/// retried.
struct OwnedDirectoryFd<S: DarwinSyscalls> {
    sys: Arc<S>,
    fd: Option<RawFd>,
}

impl<S: DarwinSyscalls> OwnedDirectoryFd<S> {
    fn new(sys: &Arc<S>, fd: RawFd) -> Self {
        Self {
            sys: Arc::clone(sys),
            fd: Some(fd),
        }
    }

    fn fd(&self) -> RawFd {
        self.fd.expect("owned directory descriptor")
    }

    fn close(mut self) -> Result<(), PlatformStoreFailure> {
        let fd = self.fd.take().expect("owned directory descriptor");
        self.sys.close(fd).map_err(|_| PlatformStoreFailure::Io)
    }

    fn disarm(mut self) -> RawFd {
        self.fd.take().expect("owned directory descriptor")
    }
}

impl<S: DarwinSyscalls> Drop for OwnedDirectoryFd<S> {
    fn drop(&mut self) {
        if let Some(fd) = self.fd.take() {
            let _ = self.sys.close(fd);
        }
    }
}

impl<S: DarwinSyscalls> Drop for PreOpenContext<S> {
    fn drop(&mut self) {
        if self.parent_fd >= 0 && self.parent_fd != self.home_fd {
            let _ = self.sys.close(self.parent_fd);
        }
        if self.home_fd >= 0 {
            let _ = self.sys.close(self.home_fd);
        }
    }
}

fn verify_home<S: DarwinSyscalls>(
    sys: Arc<S>,
    components: &[CString],
    effective_uid: u32,
    effective_gid: u32,
) -> Result<PreOpenContext<S>, PlatformStoreFailure> {
    let root = sys
        .open_root(DIRECTORY_OPEN_FLAGS)
        .map_err(|_| PlatformStoreFailure::Io)?;
    let mut current = OwnedDirectoryFd::new(&sys, root);
    let root_metadata = sys
        .stat(current.fd())
        .map_err(|_| PlatformStoreFailure::Io)?;
    validate_namespace_directory(&sys, current.fd(), root_metadata, effective_uid)?;
    for component in components {
        let before = sys
            .stat_at(current.fd(), component, libc::AT_SYMLINK_NOFOLLOW)
            .map_err(|_| PlatformStoreFailure::IdentityUncertain)?;
        if before.file_type() != u32::from(libc::S_IFDIR) {
            return Err(PlatformStoreFailure::IdentityUncertain);
        }
        let next_fd = sys
            .open_at(current.fd(), component, DIRECTORY_OPEN_FLAGS, 0)
            .map_err(|_| PlatformStoreFailure::IdentityUncertain)?;
        let next = OwnedDirectoryFd::new(&sys, next_fd);
        let after = sys.stat(next.fd()).map_err(|_| PlatformStoreFailure::Io)?;
        if !stable_path_security(before, after) {
            return Err(PlatformStoreFailure::IdentityUncertain);
        }
        validate_namespace_directory(&sys, next.fd(), after, effective_uid)?;
        current.close()?;
        current = next;
    }

    let metadata = sys
        .stat(current.fd())
        .map_err(|_| PlatformStoreFailure::Io)?;
    if metadata.file_type() != u32::from(libc::S_IFDIR)
        || metadata.uid != effective_uid
        || metadata.permission_mode() & 0o022 != 0
    {
        return Err(PlatformStoreFailure::PermissionInvalid);
    }
    let acl = sys.acl(current.fd())?;
    validate_acl(&metadata, &acl)?;
    let home_fd = current.disarm();
    Ok(PreOpenContext {
        sys,
        home_fd,
        parent_fd: home_fd,
        home_metadata: metadata,
        effective_uid,
        effective_gid,
        first_missing_private: None,
        created_private_directory: false,
    })
}

fn inspect_private_path<S: DarwinSyscalls>(
    context: &mut PreOpenContext<S>,
    components: &[CString],
) -> Result<(), PlatformStoreFailure> {
    for (index, component) in components.iter().enumerate() {
        let before =
            match context
                .sys
                .stat_at(context.parent_fd, component, libc::AT_SYMLINK_NOFOLLOW)
            {
                Ok(metadata) => metadata,
                Err(error) if error.is(libc::ENOENT) => {
                    context.first_missing_private = Some(index);
                    return Ok(());
                }
                Err(_) => return Err(PlatformStoreFailure::Io),
            };
        validate_private_directory(before, context.effective_uid, context.effective_gid)?;
        let next = context
            .sys
            .open_at(context.parent_fd, component, DIRECTORY_OPEN_FLAGS, 0)
            .map_err(|_| PlatformStoreFailure::IdentityUncertain)?;
        let pending = OwnedDirectoryFd::new(&context.sys, next);
        let after = context
            .sys
            .stat(pending.fd())
            .map_err(|_| PlatformStoreFailure::Io)?;
        if !stable_path_security(before, after) {
            return Err(PlatformStoreFailure::IdentityUncertain);
        }
        let acl = context.sys.acl(pending.fd())?;
        validate_acl(&after, &acl)?;
        context.replace_parent(pending.fd())?;
        let _ = pending.disarm();
    }
    Ok(())
}

fn validate_namespace_directory<S: DarwinSyscalls>(
    sys: &Arc<S>,
    fd: RawFd,
    metadata: FileMetadata,
    effective_uid: u32,
) -> Result<(), PlatformStoreFailure> {
    if metadata.file_type() != u32::from(libc::S_IFDIR) {
        return Err(PlatformStoreFailure::IdentityUncertain);
    }
    if (metadata.uid != 0 && metadata.uid != effective_uid)
        || metadata.permission_mode() & 0o022 != 0
    {
        return Err(PlatformStoreFailure::PermissionInvalid);
    }
    let acl = sys.acl(fd)?;
    validate_acl(&metadata, &acl)
}

fn validate_private_directory(
    metadata: FileMetadata,
    effective_uid: u32,
    effective_gid: u32,
) -> Result<(), PlatformStoreFailure> {
    if metadata.file_type() != u32::from(libc::S_IFDIR) {
        return Err(PlatformStoreFailure::IdentityUncertain);
    }
    if metadata.uid != effective_uid
        || metadata.gid != effective_gid
        || metadata.permission_mode() != 0o700
    {
        return Err(PlatformStoreFailure::PermissionInvalid);
    }
    Ok(())
}

fn validate_created_directory_before_chmod(
    metadata: FileMetadata,
    effective_uid: u32,
    effective_gid: u32,
) -> Result<(), PlatformStoreFailure> {
    if metadata.file_type() != u32::from(libc::S_IFDIR) {
        return Err(PlatformStoreFailure::IdentityUncertain);
    }
    if metadata.uid != effective_uid
        || metadata.gid != effective_gid
        || metadata.permission_mode() & !0o700 != 0
    {
        return Err(PlatformStoreFailure::PermissionInvalid);
    }
    Ok(())
}

fn map_created_named_observation_error(error: SyscallError) -> PlatformStoreFailure {
    if error.is(libc::ENOENT) || error.is(libc::ELOOP) || error.is(libc::ENOTDIR) {
        PlatformStoreFailure::IdentityUncertain
    } else {
        PlatformStoreFailure::Io
    }
}

fn create_missing_private_path<S: DarwinSyscalls>(
    context: &mut PreOpenContext<S>,
    components: &[CString],
) -> Result<(), PlatformStoreFailure> {
    let start = context.first_missing_private.unwrap_or(components.len());
    for component in &components[start..] {
        context
            .sys
            .mkdir_at(context.parent_fd, component, 0o700)
            .map_err(|error| {
                if error.is(libc::EEXIST) {
                    PlatformStoreFailure::IdentityUncertain
                } else {
                    PlatformStoreFailure::Io
                }
            })?;
        context.created_private_directory = true;
        let named_first = context
            .sys
            .stat_at(context.parent_fd, component, libc::AT_SYMLINK_NOFOLLOW)
            .map_err(map_created_named_observation_error)?;
        validate_created_directory_before_chmod(
            named_first,
            context.effective_uid,
            context.effective_gid,
        )?;
        let next = context
            .sys
            .open_at(context.parent_fd, component, DIRECTORY_OPEN_FLAGS, 0)
            .map_err(|_| PlatformStoreFailure::IdentityUncertain)?;
        let pending = OwnedDirectoryFd::new(&context.sys, next);
        let opened = context
            .sys
            .stat(pending.fd())
            .map_err(|_| PlatformStoreFailure::Io)?;
        let named_second = context
            .sys
            .stat_at(context.parent_fd, component, libc::AT_SYMLINK_NOFOLLOW)
            .map_err(map_created_named_observation_error)?;
        if !stable_path_security(named_first, opened) || !stable_path_security(opened, named_second)
        {
            return Err(PlatformStoreFailure::IdentityUncertain);
        }
        if let Err(error) = context.sys.chmod(pending.fd(), 0o700) {
            return Err(if error.is(libc::EPERM) || error.is(libc::EACCES) {
                PlatformStoreFailure::PermissionInvalid
            } else {
                PlatformStoreFailure::Io
            });
        }
        let metadata = context
            .sys
            .stat(pending.fd())
            .map_err(|_| PlatformStoreFailure::Io)?;
        validate_private_directory(metadata, context.effective_uid, context.effective_gid)?;
        let acl = context.sys.acl(pending.fd())?;
        validate_acl(&metadata, &acl)?;
        context.replace_parent(pending.fd())?;
        let _ = pending.disarm();
    }
    Ok(())
}

fn validate_existing_container_preflight(
    metadata: FileMetadata,
    credentials: Credentials,
    file_length: u64,
) -> Result<(), NativeStoreErrorCode> {
    if metadata.file_type() != u32::from(libc::S_IFREG) || metadata.nlink != 1 {
        return Err(NativeStoreErrorCode::StoreIdentityUncertain);
    }
    if metadata.uid != credentials.effective_uid
        || metadata.gid != credentials.effective_gid
        || metadata.permission_mode() != 0o600
    {
        return Err(NativeStoreErrorCode::StorePermissionInvalid);
    }
    if metadata.size != file_length {
        return Err(NativeStoreErrorCode::StoreCorrupt);
    }
    Ok(())
}

fn map_open_error(error: SyscallError, creating: bool) -> NativeStoreErrorCode {
    if error.is(libc::ELOOP) || error.is(libc::EEXIST) || (!creating && error.is(libc::ENOENT)) {
        NativeStoreErrorCode::StoreIdentityUncertain
    } else if error.is(libc::EACCES) || error.is(libc::EPERM) {
        NativeStoreErrorCode::StorePermissionInvalid
    } else {
        NativeStoreErrorCode::StoreIo
    }
}

fn stable_identity(left: FileMetadata, right: FileMetadata) -> bool {
    left.device == right.device
        && left.inode == right.inode
        && left.file_type() == right.file_type()
}

fn stable_security(left: FileMetadata, right: FileMetadata) -> bool {
    stable_identity(left, right)
        && left.uid == right.uid
        && left.gid == right.gid
        && left.permission_mode() == right.permission_mode()
        && left.nlink == right.nlink
        && left.size == right.size
}

fn stable_path_security(left: FileMetadata, right: FileMetadata) -> bool {
    stable_identity(left, right)
        && left.uid == right.uid
        && left.gid == right.gid
        && left.permission_mode() == right.permission_mode()
        && left.nlink == right.nlink
}

struct ContainerOpenContext {
    home_fd: RawFd,
    parent_fd: RawFd,
    leaf: CString,
    credentials: Credentials,
    preflight: Option<FileMetadata>,
    created_container: bool,
    created_private_directory: bool,
}

pub(crate) struct DarwinContainer<S: DarwinSyscalls> {
    sys: Arc<S>,
    container_fd: Option<RawFd>,
    context: Option<ContainerOpenContext>,
}

impl<S: DarwinSyscalls> DarwinContainer<S> {
    fn fd(&self) -> Result<RawFd, PlatformStoreFailure> {
        self.container_fd.ok_or(PlatformStoreFailure::Closed)
    }

    fn descriptor_call<T>(
        &self,
        fence: &DescriptorOperationFence,
        operation: impl FnOnce(&S, RawFd) -> Result<T, SyscallError>,
    ) -> Result<T, PlatformStoreFailure> {
        let fd = self.fd()?;
        fence.check()?;
        operation(&self.sys, fd).map_err(|_| PlatformStoreFailure::Io)
    }

    fn complete_open_inner(
        &mut self,
        fence: &DescriptorOperationFence,
        spec: &ContainerSpec,
    ) -> Result<(), PlatformStoreFailure> {
        let fd = self.fd()?;
        let sys = Arc::clone(&self.sys);
        let context = self.context.as_mut().ok_or(PlatformStoreFailure::Closed)?;
        // Keep the context inside `self` while platform proof runs. If a
        // platform call panics, common catches it and final_close can still
        // release every temporary directory descriptor before the sole fd.
        let result = Self::complete_open_with_context(&sys, fd, fence, spec, context);
        let close_directories = close_directories_with_descriptor_fence(&sys, context, fence);
        if result.is_err() {
            result
        } else {
            close_directories
        }
    }

    fn complete_open_with_context(
        sys: &Arc<S>,
        fd: RawFd,
        fence: &DescriptorOperationFence,
        spec: &ContainerSpec,
        context: &mut ContainerOpenContext,
    ) -> Result<(), PlatformStoreFailure> {
        if context.created_container {
            descriptor_call(sys, fd, fence, |sys, fd| sys.chmod(fd, 0o600))?;
        }
        let descriptor_flags = descriptor_call(sys, fd, fence, |sys, fd| sys.get_fd_flags(fd))?;
        if descriptor_flags & libc::FD_CLOEXEC == 0 {
            return Err(PlatformStoreFailure::IdentityUncertain);
        }

        let lock = LockRequest {
            lock_type: libc::F_WRLCK,
            whence: libc::SEEK_SET as i16,
            start: 0,
            length: 0,
        };
        fence.check()?;
        if let Err(error) = sys.set_lock(fd, lock) {
            return Err(if error.is(libc::EACCES) || error.is(libc::EAGAIN) {
                PlatformStoreFailure::Busy
            } else {
                PlatformStoreFailure::Io
            });
        }

        let initial = descriptor_call(sys, fd, fence, |sys, fd| sys.stat(fd))?;
        if let Some(preflight) = context.preflight {
            if !stable_security(preflight, initial) {
                return Err(PlatformStoreFailure::IdentityUncertain);
            }
        }
        validate_open_container(
            initial,
            context.credentials,
            context.created_container,
            spec,
        )?;
        fence.check()?;
        let acl = sys.acl(fd)?;
        validate_acl(&initial, &acl)?;

        if context.created_container {
            descriptor_call(sys, fd, fence, |sys, fd| {
                sys.truncate(fd, spec.file_length())
            })?;
            descriptor_call(sys, fd, fence, |sys, fd| sys.full_sync(fd))?;
            fence.check()?;
            sys.sync(context.parent_fd)
                .map_err(|_| PlatformStoreFailure::Io)?;
            if context.created_private_directory {
                fence.check()?;
                sys.sync(context.home_fd)
                    .map_err(|_| PlatformStoreFailure::Io)?;
            }
            descriptor_call(sys, fd, fence, |sys, fd| {
                sys.sync_volume(fd, SYNC_VOLUME_FULLSYNC | SYNC_VOLUME_WAIT)
            })?;
        }

        let first = descriptor_call(sys, fd, fence, |sys, fd| sys.stat(fd))?;
        fence.check()?;
        let named = sys
            .stat_at(context.parent_fd, &context.leaf, libc::AT_SYMLINK_NOFOLLOW)
            .map_err(|_| PlatformStoreFailure::IdentityUncertain)?;
        let second = descriptor_call(sys, fd, fence, |sys, fd| sys.stat(fd))?;
        if !stable_security(first, named)
            || !stable_security(named, second)
            || first.size != spec.file_length()
            || first.file_type() != u32::from(libc::S_IFREG)
            || first.uid != context.credentials.effective_uid
            || first.gid != context.credentials.effective_gid
            || first.permission_mode() != 0o600
            || first.nlink != 1
        {
            return Err(PlatformStoreFailure::IdentityUncertain);
        }
        Ok(())
    }

    fn close_remaining_directories(
        &mut self,
        fence: &FinalCloseOperationFence,
    ) -> Result<(), PlatformStoreFailure> {
        let Some(mut context) = self.context.take() else {
            return Ok(());
        };
        close_directories_with_final_fence(&self.sys, &mut context, fence)
    }
}

impl<S: DarwinSyscalls> SoleContainer for DarwinContainer<S> {
    fn complete_platform_open(
        &mut self,
        fence: &DescriptorOperationFence,
        spec: &ContainerSpec,
    ) -> Result<(), PlatformStoreFailure> {
        self.complete_open_inner(fence, spec)
    }

    fn file_length(&self, fence: &DescriptorOperationFence) -> Result<u64, PlatformStoreFailure> {
        self.descriptor_call(fence, |sys, fd| sys.stat(fd).map(|metadata| metadata.size))
    }

    fn read_exact_at(
        &self,
        fence: &DescriptorOperationFence,
        absolute_offset: u64,
        output: &mut [u8],
    ) -> Result<(), PlatformStoreFailure> {
        let mut completed = 0_usize;
        while completed < output.len() {
            let offset = absolute_offset
                .checked_add(completed as u64)
                .ok_or(PlatformStoreFailure::Io)?;
            let fd = self.fd()?;
            fence.check()?;
            match self.sys.pread(fd, &mut output[completed..], offset) {
                Ok(0) => return Err(PlatformStoreFailure::Io),
                Ok(count) if count <= output.len() - completed => completed += count,
                Ok(_) => return Err(PlatformStoreFailure::Io),
                Err(error) if error.is(libc::EINTR) => {}
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
        let mut completed = 0_usize;
        while completed < bytes.len() {
            let offset = absolute_offset
                .checked_add(completed as u64)
                .ok_or(PlatformStoreFailure::Io)?;
            let fd = self.fd()?;
            fence.check()?;
            match self.sys.pwrite(fd, &bytes[completed..], offset) {
                Ok(0) => return Err(PlatformStoreFailure::Io),
                Ok(count) if count <= bytes.len() - completed => completed += count,
                Ok(_) => return Err(PlatformStoreFailure::Io),
                Err(error) if error.is(libc::EINTR) => {}
                Err(_) => return Err(PlatformStoreFailure::Io),
            }
        }
        Ok(())
    }

    fn payload_durability_barrier(
        &mut self,
        fence: &DescriptorOperationFence,
    ) -> Result<(), PlatformStoreFailure> {
        self.descriptor_call(fence, |sys, fd| sys.full_sync(fd))
    }

    fn header_and_container_durability_barrier(
        &mut self,
        fence: &DescriptorOperationFence,
    ) -> Result<(), PlatformStoreFailure> {
        self.descriptor_call(fence, |sys, fd| sys.full_sync(fd))
    }

    fn final_close(
        &mut self,
        fence: &FinalCloseOperationFence,
    ) -> Result<(), PlatformStoreFailure> {
        let directory_result = self.close_remaining_directories(fence);
        let fd = self.container_fd.ok_or(PlatformStoreFailure::Closed)?;
        fence.check()?;
        let close_result = self.sys.close(fd).map_err(|_| PlatformStoreFailure::Io);
        if close_result.is_ok() {
            self.container_fd = None;
        }
        directory_result.and(close_result)
    }
}

fn validate_open_container(
    metadata: FileMetadata,
    credentials: Credentials,
    created: bool,
    spec: &ContainerSpec,
) -> Result<(), PlatformStoreFailure> {
    if metadata.file_type() != u32::from(libc::S_IFREG) || metadata.nlink != 1 {
        return Err(PlatformStoreFailure::IdentityUncertain);
    }
    if metadata.uid != credentials.effective_uid
        || metadata.gid != credentials.effective_gid
        || metadata.permission_mode() != 0o600
    {
        return Err(PlatformStoreFailure::PermissionInvalid);
    }
    if !created && metadata.size != spec.file_length() {
        return Err(PlatformStoreFailure::IdentityUncertain);
    }
    Ok(())
}

fn descriptor_call<S: DarwinSyscalls, T>(
    sys: &Arc<S>,
    fd: RawFd,
    fence: &DescriptorOperationFence,
    operation: impl FnOnce(&S, RawFd) -> Result<T, SyscallError>,
) -> Result<T, PlatformStoreFailure> {
    fence.check()?;
    operation(sys, fd).map_err(|_| PlatformStoreFailure::Io)
}

fn close_directories_with_descriptor_fence<S: DarwinSyscalls>(
    sys: &Arc<S>,
    context: &mut ContainerOpenContext,
    fence: &DescriptorOperationFence,
) -> Result<(), PlatformStoreFailure> {
    let mut result = Ok(());
    if context.parent_fd >= 0 && context.parent_fd != context.home_fd {
        if fence.check().is_err() {
            result = Err(PlatformStoreFailure::Io);
        } else {
            if sys.close(context.parent_fd).is_err() {
                result = Err(PlatformStoreFailure::Io);
            }
            // A failed raw close is uncertain and must never be retried.
            context.parent_fd = -1;
        }
    }
    if context.home_fd >= 0 {
        if fence.check().is_err() {
            result = Err(PlatformStoreFailure::Io);
        } else {
            if sys.close(context.home_fd).is_err() {
                result = Err(PlatformStoreFailure::Io);
            }
            context.home_fd = -1;
        }
    }
    result
}

fn close_directories_with_final_fence<S: DarwinSyscalls>(
    sys: &Arc<S>,
    context: &mut ContainerOpenContext,
    fence: &FinalCloseOperationFence,
) -> Result<(), PlatformStoreFailure> {
    let mut result = Ok(());
    if context.parent_fd >= 0 && context.parent_fd != context.home_fd {
        if fence.check().is_err() {
            result = Err(PlatformStoreFailure::Io);
        } else {
            if sys.close(context.parent_fd).is_err() {
                result = Err(PlatformStoreFailure::Io);
            }
            context.parent_fd = -1;
        }
    }
    if context.home_fd >= 0 {
        if fence.check().is_err() {
            result = Err(PlatformStoreFailure::Io);
        } else {
            if sys.close(context.home_fd).is_err() {
                result = Err(PlatformStoreFailure::Io);
            }
            context.home_fd = -1;
        }
    }
    result
}

#[cfg(test)]
mod tests;
