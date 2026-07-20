//! Host-only platform-common admission lifecycle for the Relay v2 credential
//! atomic file cell.
//!
//! This default-off crate adopts one pre-bound directory descriptor and owns
//! the Host-specific process registry, traditional record-lock descriptor,
//! fixed claim journal, and exactly-once final close chain. All filesystem
//! operations are supplied through [`DescriptorRelativePlatform`]. No path,
//! HOME, environment, broker N0 type, real syscall, N-API, Vault, Authority,
//! credential mutation, recovery, loader, readiness, or production
//! composition exists here.

mod claim_journal;
mod process_lifecycle;

#[cfg(test)]
mod tests;

pub use claim_journal::{
    ClaimId, CLAIM_ID_LENGTH, CLAIM_JOURNAL_FORMAT_VERSION, CLAIM_JOURNAL_LENGTH,
    CLAIM_JOURNAL_STATE_ADMISSION_HELD_NO_CREDENTIAL_MUTATION,
};
pub use process_lifecycle::{initialize_process_lifecycle, ProcessLifecycleToken};

use claim_journal::ClaimJournal;
use process_lifecycle::{reserve_directory, DirectoryIdentity, LifecycleHandle};
use std::fmt;
use std::mem::ManuallyDrop;

mod generated {
    include!(concat!(env!("OUT_DIR"), "/contract_spec.rs"));
}

/// Contract-derived descriptor-relative resource names. Fields remain private
/// so an adapter cannot replace one component or introduce a lookup fallback.
#[derive(Debug, PartialEq, Eq)]
pub struct PlatformResourceSpec {
    credential_name: &'static str,
    lock_name: &'static str,
    claim_name: &'static str,
}

impl PlatformResourceSpec {
    pub const fn contract_revision(&self) -> u32 {
        generated::CONTRACT_REVISION
    }

    pub const fn resource_contract_version(&self) -> u32 {
        generated::RESOURCE_CONTRACT_VERSION
    }

    pub const fn credential_name(&self) -> &'static str {
        self.credential_name
    }

    pub const fn lock_name(&self) -> &'static str {
        self.lock_name
    }

    pub const fn claim_name(&self) -> &'static str {
        self.claim_name
    }

    pub const fn claim_journal_length(&self) -> usize {
        generated::CLAIM_JOURNAL_LENGTH
    }
}

static PLATFORM_RESOURCE_SPEC: PlatformResourceSpec = PlatformResourceSpec {
    credential_name: generated::CREDENTIAL_NAME,
    lock_name: generated::LOCK_NAME,
    claim_name: generated::CLAIM_NAME,
};

pub fn platform_resource_spec() -> &'static PlatformResourceSpec {
    &PLATFORM_RESOURCE_SPEC
}

/// Exact closed errors shared with the frozen raw Host cell ABI.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CellErrorCode {
    NativeInterfaceInvalid,
    CellBusy,
    CellClosed,
    CellCorrupt,
    CellIdentityUncertain,
    CellIo,
    CellPermissionInvalid,
    CellDurabilityUnsupported,
    CellRecoveryRequired,
    InvalidArgument,
    InvalidRevision,
    ValueTooLarge,
}

impl CellErrorCode {
    pub const fn as_contract_code(self) -> &'static str {
        match self {
            Self::NativeInterfaceInvalid => "NATIVE_INTERFACE_INVALID",
            Self::CellBusy => "CELL_BUSY",
            Self::CellClosed => "CELL_CLOSED",
            Self::CellCorrupt => "CELL_CORRUPT",
            Self::CellIdentityUncertain => "CELL_IDENTITY_UNCERTAIN",
            Self::CellIo => "CELL_IO",
            Self::CellPermissionInvalid => "CELL_PERMISSION_INVALID",
            Self::CellDurabilityUnsupported => "CELL_DURABILITY_UNSUPPORTED",
            Self::CellRecoveryRequired => "CELL_RECOVERY_REQUIRED",
            Self::InvalidArgument => "INVALID_ARGUMENT",
            Self::InvalidRevision => "INVALID_REVISION",
            Self::ValueTooLarge => "VALUE_TOO_LARGE",
        }
    }
}

/// Closed failures a future Darwin/Linux adapter may report to common.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlatformFailure {
    Busy,
    NotFound,
    AlreadyExists,
    PermissionDenied,
    IdentityUncertain,
    Io,
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EffectiveIdentity {
    pub effective_uid: u32,
    pub effective_gid: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ObjectKind {
    Directory,
    RegularFile,
    Symlink,
    Other,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ObjectIdentity {
    pub device: u64,
    pub inode: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ObjectMetadata {
    pub identity: ObjectIdentity,
    pub kind: ObjectKind,
    pub owner_uid: u32,
    pub owner_gid: u32,
    /// Permission bits only, represented as their numeric Unix value.
    pub mode: u32,
    pub link_count: u64,
    pub size_bytes: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lookup {
    Absent,
    Present(ObjectMetadata),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RelativeResource {
    Lock,
    Claim,
}

/// Descriptor-relative filesystem seam. Implementations must perform the
/// exact native operations named by each method and must not use ambient path,
/// HOME, environment, cwd, global lookup, descriptor duplication, reopen, or
/// implicit cleanup. `Descriptor` Drop must be inert: common suppresses Drop
/// and transfers each value exactly once to `raw_close` in the parent process.
pub trait DescriptorRelativePlatform: Send + 'static {
    type Descriptor: Send + 'static;

    fn effective_identity(&mut self) -> Result<EffectiveIdentity, PlatformFailure>;

    fn fstat(&mut self, descriptor: &Self::Descriptor) -> Result<ObjectMetadata, PlatformFailure>;

    fn descriptor_has_cloexec(
        &mut self,
        descriptor: &Self::Descriptor,
    ) -> Result<bool, PlatformFailure>;

    fn fstatat_nofollow(
        &mut self,
        directory: &Self::Descriptor,
        resource: RelativeResource,
    ) -> Result<Lookup, PlatformFailure>;

    /// Exact existing lock open: O_RDWR|O_NOFOLLOW|O_CLOEXEC, never O_TRUNC.
    fn open_lock_existing(
        &mut self,
        directory: &Self::Descriptor,
    ) -> Result<Self::Descriptor, PlatformFailure>;

    /// Exact new lock open: O_RDWR|O_NOFOLLOW|O_CLOEXEC|O_CREAT|O_EXCL, 0600.
    fn create_lock_exclusive(
        &mut self,
        directory: &Self::Descriptor,
    ) -> Result<Self::Descriptor, PlatformFailure>;

    /// Exact nonblocking traditional F_SETLK/F_WRLCK/SEEK_SET/start=0/len=0.
    /// Only native EACCES/EAGAIN may be reported as [`PlatformFailure::Busy`].
    fn try_lock_whole_file_nonblocking(
        &mut self,
        lock: &Self::Descriptor,
    ) -> Result<(), PlatformFailure>;

    /// Exact single openat: O_RDWR|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC, 0600.
    /// F_SETFD is not a substitute; the owner also proves FD_CLOEXEC before
    /// journal mutation.
    fn create_claim_exclusive(
        &mut self,
        directory: &Self::Descriptor,
    ) -> Result<Self::Descriptor, PlatformFailure>;

    fn write_claim_from_start(
        &mut self,
        claim: &Self::Descriptor,
        bytes: &[u8],
    ) -> Result<(), PlatformFailure>;

    fn read_claim_exact(
        &mut self,
        claim: &Self::Descriptor,
        output: &mut [u8],
    ) -> Result<(), PlatformFailure>;

    fn fsync_claim(&mut self, claim: &Self::Descriptor) -> Result<(), PlatformFailure>;

    fn fsync_directory(&mut self, directory: &Self::Descriptor) -> Result<(), PlatformFailure>;

    /// Unlinks only the fixed claim component relative to the adopted dir.
    fn unlink_claim(&mut self, directory: &Self::Descriptor) -> Result<(), PlatformFailure>;

    /// Exactly one raw close attempt. Implementations must not retry EINTR,
    /// explicitly unlock, close any other descriptor, or run close from Drop.
    fn raw_close(&mut self, descriptor: Self::Descriptor) -> Result<(), PlatformFailure>;
}

/// Opaque proof of a release-qualified durability record. Revision 2 has an
/// empty allowlist, so production code cannot construct this value.
pub struct DurabilityQualification {
    _private: (),
}

impl fmt::Debug for DurabilityQualification {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("DurabilityQualification(<opaque>)")
    }
}

/// The only production qualification entry in contract revision 2. It always
/// fails before registry reservation or namespace mutation.
pub fn production_durability_qualification() -> Result<DurabilityQualification, CellErrorCode> {
    Err(CellErrorCode::CellDurabilityUnsupported)
}

#[cfg(test)]
fn durability_qualification_for_test() -> DurabilityQualification {
    DurabilityQualification { _private: () }
}

struct DescriptorSlot<D> {
    value: Option<ManuallyDrop<D>>,
}

impl<D> DescriptorSlot<D> {
    fn new(value: D) -> Self {
        Self {
            value: Some(ManuallyDrop::new(value)),
        }
    }

    fn empty() -> Self {
        Self { value: None }
    }

    fn get(&self) -> &D {
        self.value.as_deref().expect("live descriptor slot")
    }

    fn take(&mut self) -> Option<D> {
        self.value.take().map(ManuallyDrop::into_inner)
    }
}

struct OpenAttempt<'a, P: DescriptorRelativePlatform> {
    token: &'a ProcessLifecycleToken,
    platform: Option<P>,
    directory: DescriptorSlot<P::Descriptor>,
    lock: DescriptorSlot<P::Descriptor>,
    claim: DescriptorSlot<P::Descriptor>,
    lifecycle: Option<LifecycleHandle>,
    claim_created: bool,
    settled: bool,
}

impl<'a, P: DescriptorRelativePlatform> OpenAttempt<'a, P> {
    fn new(token: &'a ProcessLifecycleToken, platform: P, directory: P::Descriptor) -> Self {
        Self {
            token,
            platform: Some(platform),
            directory: DescriptorSlot::new(directory),
            lock: DescriptorSlot::empty(),
            claim: DescriptorSlot::empty(),
            lifecycle: None,
            claim_created: false,
            settled: false,
        }
    }

    fn platform(&mut self) -> &mut P {
        self.platform.as_mut().expect("live platform")
    }

    fn check_parent_process(&self) -> Result<(), CellErrorCode> {
        match &self.lifecycle {
            Some(lifecycle) => lifecycle.check_parent_process(),
            None => self.token.check_parent_process(),
        }
    }

    fn close_resources(&mut self) -> bool {
        if self.check_parent_process().is_err() {
            return false;
        }
        let mut all_closed = true;
        let descriptors = [self.claim.take(), self.lock.take(), self.directory.take()];
        for descriptor in descriptors.into_iter().flatten() {
            if self.check_parent_process().is_err()
                || self.platform().raw_close(descriptor).is_err()
            {
                all_closed = false;
            }
        }
        all_closed
    }

    fn fail(&mut self, error: CellErrorCode, uncertain: bool) -> CellErrorCode {
        if self.settled {
            return error;
        }
        self.settled = true;
        if self.check_parent_process().is_err() {
            return CellErrorCode::CellClosed;
        }
        let all_closed = self.close_resources();
        let must_tombstone = uncertain || self.claim_created || !all_closed;
        if let Some(lifecycle) = &self.lifecycle {
            if must_tombstone {
                lifecycle.mark_close_uncertain();
            } else if lifecycle.release_opening().is_err() {
                lifecycle.mark_close_uncertain();
                return CellErrorCode::CellClosed;
            }
        }
        if !all_closed {
            CellErrorCode::CellIo
        } else {
            error
        }
    }

    fn into_owner(
        mut self,
        effective: EffectiveIdentity,
        directory_identity: ObjectIdentity,
        lock_identity: ObjectIdentity,
        claim_identity: ObjectIdentity,
        journal: ClaimJournal,
    ) -> AdmissionOwner<P> {
        self.settled = true;
        AdmissionOwner {
            platform: self.platform.take(),
            directory: DescriptorSlot::new(self.directory.take().expect("directory descriptor")),
            lock: DescriptorSlot::new(self.lock.take().expect("lock descriptor")),
            claim: DescriptorSlot::new(self.claim.take().expect("claim descriptor")),
            lifecycle: self.lifecycle.take().expect("open lifecycle"),
            effective,
            directory_identity,
            lock_identity,
            claim_identity,
            journal,
            close_result: None,
        }
    }
}

impl<P: DescriptorRelativePlatform> Drop for OpenAttempt<'_, P> {
    fn drop(&mut self) {
        if !self.settled {
            let _ = self.fail(CellErrorCode::CellClosed, true);
        }
    }
}

fn directory_metadata(
    metadata: ObjectMetadata,
    effective: EffectiveIdentity,
) -> Result<ObjectIdentity, CellErrorCode> {
    if metadata.kind != ObjectKind::Directory {
        return Err(CellErrorCode::CellIdentityUncertain);
    }
    if metadata.owner_uid != effective.effective_uid
        || metadata.owner_gid != effective.effective_gid
        || metadata.mode != 0o700
    {
        return Err(CellErrorCode::CellPermissionInvalid);
    }
    Ok(metadata.identity)
}

fn safe_file_metadata(
    metadata: ObjectMetadata,
    effective: EffectiveIdentity,
    expected_size: u64,
    wrong_size: CellErrorCode,
) -> Result<ObjectIdentity, CellErrorCode> {
    if metadata.kind != ObjectKind::RegularFile || metadata.link_count != 1 {
        return Err(CellErrorCode::CellIdentityUncertain);
    }
    if metadata.owner_uid != effective.effective_uid
        || metadata.owner_gid != effective.effective_gid
        || metadata.mode != 0o600
    {
        return Err(CellErrorCode::CellPermissionInvalid);
    }
    if metadata.size_bytes != expected_size {
        return Err(wrong_size);
    }
    Ok(metadata.identity)
}

fn classify_existing_claim(
    metadata: ObjectMetadata,
    effective: EffectiveIdentity,
) -> CellErrorCode {
    safe_file_metadata(
        metadata,
        effective,
        CLAIM_JOURNAL_LENGTH as u64,
        CellErrorCode::CellCorrupt,
    )
    .map(|_| CellErrorCode::CellRecoveryRequired)
    .unwrap_or_else(|error| error)
}

fn initial_directory_proof<P: DescriptorRelativePlatform>(
    token: &ProcessLifecycleToken,
    platform: &mut P,
    directory: &P::Descriptor,
) -> Result<(EffectiveIdentity, ObjectMetadata), CellErrorCode> {
    token.check_parent_process()?;
    let effective = platform
        .effective_identity()
        .map_err(map_platform_failure)?;
    token.check_parent_process()?;
    let metadata = platform.fstat(directory).map_err(map_platform_failure)?;
    directory_metadata(metadata, effective)?;
    token.check_parent_process()?;
    if !platform
        .descriptor_has_cloexec(directory)
        .map_err(map_platform_failure)?
    {
        return Err(CellErrorCode::CellPermissionInvalid);
    }
    Ok((effective, metadata))
}

fn recheck_directory<P: DescriptorRelativePlatform>(
    lifecycle: &LifecycleHandle,
    platform: &mut P,
    directory: &P::Descriptor,
    effective: EffectiveIdentity,
    expected: ObjectIdentity,
) -> Result<(), CellErrorCode> {
    lifecycle.check_operation()?;
    let metadata = platform.fstat(directory).map_err(map_platform_failure)?;
    let identity = directory_metadata(metadata, effective)?;
    if identity != expected {
        return Err(CellErrorCode::CellIdentityUncertain);
    }
    lifecycle.check_operation()?;
    if !platform
        .descriptor_has_cloexec(directory)
        .map_err(map_platform_failure)?
    {
        return Err(CellErrorCode::CellPermissionInvalid);
    }
    Ok(())
}

fn stable_file_proof<P: DescriptorRelativePlatform>(
    lifecycle: &LifecycleHandle,
    platform: &mut P,
    directory: &P::Descriptor,
    descriptor: &P::Descriptor,
    resource: RelativeResource,
    effective: EffectiveIdentity,
    expected_size: u64,
    wrong_size: CellErrorCode,
    preflight_identity: Option<ObjectIdentity>,
) -> Result<ObjectIdentity, CellErrorCode> {
    lifecycle.check_operation()?;
    let a = platform.fstat(descriptor).map_err(map_platform_failure)?;
    lifecycle.check_operation()?;
    let b = match platform
        .fstatat_nofollow(directory, resource)
        .map_err(map_platform_failure)?
    {
        Lookup::Present(metadata) => metadata,
        Lookup::Absent => return Err(CellErrorCode::CellIdentityUncertain),
    };
    lifecycle.check_operation()?;
    let c = platform.fstat(descriptor).map_err(map_platform_failure)?;

    let a_identity = safe_file_metadata(a, effective, expected_size, wrong_size)?;
    let b_identity = safe_file_metadata(b, effective, expected_size, wrong_size)?;
    let c_identity = safe_file_metadata(c, effective, expected_size, wrong_size)?;
    if a != b || b != c || a_identity != b_identity || b_identity != c_identity {
        return Err(CellErrorCode::CellIdentityUncertain);
    }
    if preflight_identity.is_some_and(|identity| identity != a_identity) {
        return Err(CellErrorCode::CellIdentityUncertain);
    }
    lifecycle.check_operation()?;
    if !platform
        .descriptor_has_cloexec(descriptor)
        .map_err(map_platform_failure)?
    {
        return Err(CellErrorCode::CellPermissionInvalid);
    }
    Ok(a_identity)
}

/// Test-reachable core admission seam. Production cannot obtain the required
/// durability proof in contract revision 2.
pub fn adopt_prebound_directory<P: DescriptorRelativePlatform>(
    lifecycle_token: &ProcessLifecycleToken,
    platform: P,
    directory: P::Descriptor,
    claim_id: ClaimId,
    _qualification: &DurabilityQualification,
) -> Result<AdmissionOwner<P>, CellErrorCode> {
    lifecycle_token.check_parent_process()?;
    let mut attempt = OpenAttempt::new(lifecycle_token, platform, directory);

    let initial = {
        let platform = attempt.platform.as_mut().expect("platform");
        initial_directory_proof(lifecycle_token, platform, attempt.directory.get())
    };
    let (effective, directory_metadata) = match initial {
        Ok(value) => value,
        Err(error) => return Err(attempt.fail(error, false)),
    };
    let directory_identity = directory_metadata.identity;

    let reservation = reserve_directory(
        lifecycle_token,
        DirectoryIdentity {
            device: directory_identity.device,
            inode: directory_identity.inode,
        },
    );
    attempt.lifecycle = match reservation {
        Ok(reservation) => Some(reservation),
        Err(error) => return Err(attempt.fail(error, false)),
    };
    let lifecycle = attempt.lifecycle.as_ref().expect("lifecycle");

    let directory_recheck = {
        let platform = attempt.platform.as_mut().expect("platform");
        recheck_directory(
            lifecycle,
            platform,
            attempt.directory.get(),
            effective,
            directory_identity,
        )
    };
    if let Err(error) = directory_recheck {
        return Err(attempt.fail(error, error == CellErrorCode::CellIdentityUncertain));
    }

    lifecycle.check_operation()?;
    let lock_preflight = {
        let platform = attempt.platform.as_mut().expect("platform");
        platform
            .fstatat_nofollow(attempt.directory.get(), RelativeResource::Lock)
            .map_err(map_platform_failure)
    };
    let lock_preflight = match lock_preflight {
        Ok(value) => value,
        Err(error) => {
            return Err(attempt.fail(error, error == CellErrorCode::CellIdentityUncertain))
        }
    };
    let existing_lock_identity = match lock_preflight {
        Lookup::Absent => None,
        Lookup::Present(metadata) => {
            match safe_file_metadata(metadata, effective, 0, CellErrorCode::CellIdentityUncertain) {
                Ok(identity) => Some(identity),
                Err(error) => {
                    return Err(attempt.fail(error, error == CellErrorCode::CellIdentityUncertain))
                }
            }
        }
    };

    lifecycle.check_operation()?;
    let lock_open = {
        let platform = attempt.platform.as_mut().expect("platform");
        if existing_lock_identity.is_some() {
            platform.open_lock_existing(attempt.directory.get())
        } else {
            platform.create_lock_exclusive(attempt.directory.get())
        }
    };
    attempt.lock = match lock_open {
        Ok(lock) => DescriptorSlot::new(lock),
        Err(PlatformFailure::AlreadyExists) if existing_lock_identity.is_none() => {
            let collision = {
                let platform = attempt.platform.as_mut().expect("platform");
                lifecycle.check_operation().and_then(|()| {
                    platform
                        .fstatat_nofollow(attempt.directory.get(), RelativeResource::Lock)
                        .map_err(map_platform_failure)
                })
            };
            let error = match collision {
                Ok(Lookup::Present(metadata)) => {
                    safe_file_metadata(metadata, effective, 0, CellErrorCode::CellIdentityUncertain)
                        .map(|_| CellErrorCode::CellBusy)
                        .unwrap_or_else(|error| error)
                }
                Ok(Lookup::Absent) => CellErrorCode::CellIdentityUncertain,
                Err(error) => error,
            };
            return Err(attempt.fail(error, error == CellErrorCode::CellIdentityUncertain));
        }
        Err(PlatformFailure::NotFound) if existing_lock_identity.is_some() => {
            return Err(attempt.fail(CellErrorCode::CellIdentityUncertain, true));
        }
        Err(error) => {
            let error = map_platform_failure(error);
            return Err(attempt.fail(error, error == CellErrorCode::CellIdentityUncertain));
        }
    };

    let lock_proof = {
        let platform = attempt.platform.as_mut().expect("platform");
        stable_file_proof(
            lifecycle,
            platform,
            attempt.directory.get(),
            attempt.lock.get(),
            RelativeResource::Lock,
            effective,
            0,
            CellErrorCode::CellIdentityUncertain,
            existing_lock_identity,
        )
    };
    let lock_identity = match lock_proof {
        Ok(identity) => identity,
        Err(error) => {
            return Err(attempt.fail(error, error == CellErrorCode::CellIdentityUncertain))
        }
    };

    lifecycle.check_operation()?;
    let lock_result = {
        let platform = attempt.platform.as_mut().expect("platform");
        platform.try_lock_whole_file_nonblocking(attempt.lock.get())
    };
    if let Err(error) = lock_result {
        let error = map_platform_failure(error);
        return Err(attempt.fail(error, error == CellErrorCode::CellIdentityUncertain));
    }

    lifecycle.check_operation()?;
    let claim_preflight = {
        let platform = attempt.platform.as_mut().expect("platform");
        platform
            .fstatat_nofollow(attempt.directory.get(), RelativeResource::Claim)
            .map_err(map_platform_failure)
    };
    match claim_preflight {
        Ok(Lookup::Absent) => {}
        Ok(Lookup::Present(metadata)) => {
            let error = classify_existing_claim(metadata, effective);
            return Err(attempt.fail(error, error == CellErrorCode::CellIdentityUncertain));
        }
        Err(error) => {
            return Err(attempt.fail(error, error == CellErrorCode::CellIdentityUncertain))
        }
    }

    lifecycle.check_operation()?;
    let claim_open = {
        let platform = attempt.platform.as_mut().expect("platform");
        platform.create_claim_exclusive(attempt.directory.get())
    };
    attempt.claim = match claim_open {
        Ok(claim) => {
            attempt.claim_created = true;
            DescriptorSlot::new(claim)
        }
        Err(PlatformFailure::AlreadyExists) => {
            let collision = {
                let platform = attempt.platform.as_mut().expect("platform");
                lifecycle.check_operation().and_then(|()| {
                    platform
                        .fstatat_nofollow(attempt.directory.get(), RelativeResource::Claim)
                        .map_err(map_platform_failure)
                })
            };
            let error = match collision {
                Ok(Lookup::Present(metadata)) => classify_existing_claim(metadata, effective),
                Ok(Lookup::Absent) => CellErrorCode::CellIdentityUncertain,
                Err(error) => error,
            };
            return Err(attempt.fail(error, error == CellErrorCode::CellIdentityUncertain));
        }
        Err(error) => {
            let error = map_platform_failure(error);
            return Err(attempt.fail(error, error == CellErrorCode::CellIdentityUncertain));
        }
    };

    lifecycle.check_operation()?;
    let initial_claim_metadata = {
        let platform = attempt.platform.as_mut().expect("platform");
        platform
            .fstat(attempt.claim.get())
            .map_err(map_platform_failure)
    };
    let initial_claim_identity = match initial_claim_metadata
        .and_then(|metadata| safe_file_metadata(metadata, effective, 0, CellErrorCode::CellCorrupt))
    {
        Ok(identity) => identity,
        Err(error) => {
            return Err(attempt.fail(error, error == CellErrorCode::CellIdentityUncertain))
        }
    };
    lifecycle.check_operation()?;
    let claim_cloexec = {
        let platform = attempt.platform.as_mut().expect("platform");
        platform
            .descriptor_has_cloexec(attempt.claim.get())
            .map_err(map_platform_failure)
    };
    match claim_cloexec {
        Ok(true) => {}
        Ok(false) => return Err(attempt.fail(CellErrorCode::CellPermissionInvalid, false)),
        Err(error) => {
            return Err(attempt.fail(error, error == CellErrorCode::CellIdentityUncertain))
        }
    }

    let journal = ClaimJournal {
        claim_id,
        directory: directory_identity,
        lock: lock_identity,
        claim: initial_claim_identity,
        opener_pid: lifecycle.opener_pid(),
        effective_uid: effective.effective_uid,
        effective_gid: effective.effective_gid,
    };
    let journal_bytes = journal.encode();

    lifecycle.check_operation()?;
    let write_result = {
        let platform = attempt.platform.as_mut().expect("platform");
        platform.write_claim_from_start(attempt.claim.get(), &journal_bytes)
    };
    if let Err(error) = write_result {
        return Err(attempt.fail(map_platform_failure(error), true));
    }
    lifecycle.check_operation()?;
    let claim_sync = {
        let platform = attempt.platform.as_mut().expect("platform");
        platform.fsync_claim(attempt.claim.get())
    };
    if let Err(error) = claim_sync {
        return Err(attempt.fail(map_platform_failure(error), true));
    }

    let claim_proof = {
        let platform = attempt.platform.as_mut().expect("platform");
        stable_file_proof(
            lifecycle,
            platform,
            attempt.directory.get(),
            attempt.claim.get(),
            RelativeResource::Claim,
            effective,
            CLAIM_JOURNAL_LENGTH as u64,
            CellErrorCode::CellCorrupt,
            Some(initial_claim_identity),
        )
    };
    let claim_identity = match claim_proof {
        Ok(identity) => identity,
        Err(error) => return Err(attempt.fail(error, true)),
    };
    if claim_identity != journal.claim {
        return Err(attempt.fail(CellErrorCode::CellIdentityUncertain, true));
    }

    lifecycle.check_operation()?;
    let directory_sync = {
        let platform = attempt.platform.as_mut().expect("platform");
        platform.fsync_directory(attempt.directory.get())
    };
    if let Err(error) = directory_sync {
        return Err(attempt.fail(map_platform_failure(error), true));
    }
    if let Err(error) = lifecycle.mark_open() {
        return Err(attempt.fail(error, true));
    }

    Ok(attempt.into_owner(
        effective,
        directory_identity,
        lock_identity,
        claim_identity,
        journal,
    ))
}

/// Sole Host admission owner. It intentionally exposes no descriptor, journal,
/// registry, unlock, cleanup, credential, mutation, or path operation.
pub struct AdmissionOwner<P: DescriptorRelativePlatform> {
    platform: Option<P>,
    directory: DescriptorSlot<P::Descriptor>,
    lock: DescriptorSlot<P::Descriptor>,
    claim: DescriptorSlot<P::Descriptor>,
    lifecycle: LifecycleHandle,
    effective: EffectiveIdentity,
    directory_identity: ObjectIdentity,
    lock_identity: ObjectIdentity,
    claim_identity: ObjectIdentity,
    journal: ClaimJournal,
    close_result: Option<Result<(), CellErrorCode>>,
}

impl<P: DescriptorRelativePlatform> fmt::Debug for AdmissionOwner<P> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("AdmissionOwner(<host-cell-opaque>)")
    }
}

impl<P: DescriptorRelativePlatform> AdmissionOwner<P> {
    fn platform(&mut self) -> &mut P {
        self.platform.as_mut().expect("live platform")
    }

    fn validate_for_close(&mut self) -> Result<(), CellErrorCode> {
        recheck_directory(
            &self.lifecycle,
            self.platform.as_mut().expect("platform"),
            self.directory.get(),
            self.effective,
            self.directory_identity,
        )?;
        let lock_identity = stable_file_proof(
            &self.lifecycle,
            self.platform.as_mut().expect("platform"),
            self.directory.get(),
            self.lock.get(),
            RelativeResource::Lock,
            self.effective,
            0,
            CellErrorCode::CellIdentityUncertain,
            Some(self.lock_identity),
        )?;
        if lock_identity != self.lock_identity {
            return Err(CellErrorCode::CellIdentityUncertain);
        }
        let claim_identity = stable_file_proof(
            &self.lifecycle,
            self.platform.as_mut().expect("platform"),
            self.directory.get(),
            self.claim.get(),
            RelativeResource::Claim,
            self.effective,
            CLAIM_JOURNAL_LENGTH as u64,
            CellErrorCode::CellCorrupt,
            Some(self.claim_identity),
        )?;
        if claim_identity != self.claim_identity {
            return Err(CellErrorCode::CellIdentityUncertain);
        }

        self.lifecycle.check_operation()?;
        let mut bytes = [0_u8; CLAIM_JOURNAL_LENGTH];
        self.platform
            .as_mut()
            .expect("platform")
            .read_claim_exact(self.claim.get(), &mut bytes)
            .map_err(map_platform_failure)?;
        let decoded = ClaimJournal::decode(&bytes)?;
        if decoded != self.journal {
            return Err(CellErrorCode::CellIdentityUncertain);
        }
        Ok(())
    }

    fn close_resources(&mut self) -> bool {
        let mut all_closed = true;
        let descriptors = [self.claim.take(), self.lock.take(), self.directory.take()];
        for descriptor in descriptors.into_iter().flatten() {
            if self.lifecycle.check_parent_process().is_err()
                || self.platform().raw_close(descriptor).is_err()
            {
                all_closed = false;
            }
        }
        all_closed
    }

    fn tombstone_then_close_resources(
        &mut self,
        error: CellErrorCode,
    ) -> Result<(), CellErrorCode> {
        let result = Err(error);
        self.close_result = Some(result);
        self.lifecycle.mark_close_uncertain();
        let _ = self.close_resources();
        result
    }

    /// Stable, idempotent close result. The three raw descriptors are each
    /// transferred to `raw_close` at most once and are never explicitly
    /// unlocked. A failed result is cached and never retried.
    pub fn close(&mut self) -> Result<(), CellErrorCode> {
        if let Some(result) = self.close_result {
            return result;
        }
        if let Err(error) = self.lifecycle.check_parent_process() {
            let result = Err(error);
            self.close_result = Some(result);
            self.lifecycle.mark_close_uncertain();
            return result;
        }
        if let Err(error) = self.lifecycle.begin_close() {
            return self.tombstone_then_close_resources(error);
        }

        if let Err(error) = self.validate_for_close() {
            return self.tombstone_then_close_resources(error);
        }
        if let Err(error) = self.lifecycle.check_operation() {
            return self.tombstone_then_close_resources(error);
        }
        if let Err(failure) = self
            .platform
            .as_mut()
            .expect("platform")
            .unlink_claim(self.directory.get())
        {
            return self.tombstone_then_close_resources(map_platform_failure(failure));
        }
        if let Err(error) = self.lifecycle.check_operation() {
            return self.tombstone_then_close_resources(error);
        }
        if let Err(failure) = self
            .platform
            .as_mut()
            .expect("platform")
            .fsync_directory(self.directory.get())
        {
            return self.tombstone_then_close_resources(map_platform_failure(failure));
        }

        if !self.close_resources() {
            let result = Err(CellErrorCode::CellIo);
            self.close_result = Some(result);
            self.lifecycle.mark_close_uncertain();
            return result;
        }
        if let Err(error) = self.lifecycle.finish_close_success() {
            let result = Err(error);
            self.close_result = Some(result);
            self.lifecycle.mark_close_uncertain();
            return result;
        }
        let result = Ok(());
        self.close_result = Some(result);
        result
    }
}

impl<P: DescriptorRelativePlatform> Drop for AdmissionOwner<P> {
    fn drop(&mut self) {
        if self.close_result.is_none() {
            let _ = self.close();
        }
    }
}
