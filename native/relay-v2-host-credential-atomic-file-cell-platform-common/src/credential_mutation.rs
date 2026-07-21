use crate::claim_journal::{ClaimJournal, CLAIM_JOURNAL_LENGTH};
use crate::process_lifecycle::MutationOwnerBinding;
use crate::{
    map_platform_failure, recheck_directory, stable_file_proof, AdmissionOwner, CellErrorCode,
    DescriptorRelativePlatform, DescriptorSlot, Lookup, ObjectIdentity, ObjectKind, ObjectMetadata,
    PlatformFailure, RelativeResource,
};
use sha2::{Digest, Sha256};
use std::fmt;

pub use crate::generated::{
    CREDENTIAL_MAXIMUM_BYTES, TEMPORARY_CREATE_ATTEMPTS, TEMPORARY_ENTROPY_BYTES, TEMPORARY_PREFIX,
};
use crate::generated::{TEMPORARY_LOWERCASE_HEX_ALPHABET, TEMPORARY_SUFFIX_CHARACTERS};

const _: [(); TEMPORARY_SUFFIX_CHARACTERS] = [(); TEMPORARY_ENTROPY_BYTES * 2];

/// Additive descriptor-relative mutation seam. Existing admission adapters do
/// not implement this subtrait and remain unchanged. A future target adapter
/// must supply these exact operations before credential mutation is reachable.
pub trait CredentialMutationPlatform: DescriptorRelativePlatform {
    fn fstatat_credential_nofollow(
        &mut self,
        directory: &Self::Descriptor,
    ) -> Result<Lookup, PlatformFailure>;

    /// Exact openat: O_RDONLY|O_NOFOLLOW|O_CLOEXEC.
    fn open_credential_readonly(
        &mut self,
        directory: &Self::Descriptor,
    ) -> Result<Self::Descriptor, PlatformFailure>;

    /// Reads exactly `output.len()` bytes from offset zero and proves EOF at
    /// that boundary. It must not allocate, reopen, or follow a path.
    fn read_file_exact(
        &mut self,
        descriptor: &Self::Descriptor,
        output: &mut [u8],
    ) -> Result<(), PlatformFailure>;

    fn fstatat_temporary_nofollow(
        &mut self,
        directory: &Self::Descriptor,
        temporary_name: &str,
    ) -> Result<Lookup, PlatformFailure>;

    /// Exact openat: O_RDWR|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC, 0600.
    fn create_temporary_exclusive(
        &mut self,
        directory: &Self::Descriptor,
        temporary_name: &str,
    ) -> Result<Self::Descriptor, PlatformFailure>;

    fn write_temporary_from_start(
        &mut self,
        temporary: &Self::Descriptor,
        bytes: &[u8],
    ) -> Result<(), PlatformFailure>;

    fn fsync_temporary(&mut self, temporary: &Self::Descriptor) -> Result<(), PlatformFailure>;

    fn unlink_temporary(
        &mut self,
        directory: &Self::Descriptor,
        temporary_name: &str,
    ) -> Result<(), PlatformFailure>;

    /// The only credential publication commit point.
    fn rename_temporary_to_credential(
        &mut self,
        directory: &Self::Descriptor,
        temporary_name: &str,
    ) -> Result<(), PlatformFailure>;
}

/// Opaque, one-shot revision. Its fields intentionally remain private and the
/// type is neither `Clone` nor `Copy`.
pub struct CredentialRevision {
    owner_binding: MutationOwnerBinding,
    issuance_generation: u64,
    state: CurrentState,
    digest: [u8; 32],
    identity: Option<ObjectIdentity>,
}

impl fmt::Debug for CredentialRevision {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("CredentialRevision(<opaque>)")
    }
}

/// Credential bytes observed at one exact revision. Debug output never
/// reflects credential material.
pub enum CredentialCurrent {
    Absent {
        revision: CredentialRevision,
    },
    Present {
        revision: CredentialRevision,
        bytes: Vec<u8>,
    },
}

impl fmt::Debug for CredentialCurrent {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Absent { .. } => formatter.write_str("CredentialCurrent::Absent(<opaque>)"),
            Self::Present { .. } => {
                formatter.write_str("CredentialCurrent::Present(<redacted>, <opaque>)")
            }
        }
    }
}

pub enum CredentialCompareAndSwapOutcome {
    Swapped,
    Conflict(CredentialCurrent),
    Uncertain,
}

impl fmt::Debug for CredentialCompareAndSwapOutcome {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Swapped => formatter.write_str("CredentialCompareAndSwapOutcome::Swapped"),
            Self::Conflict(_) => {
                formatter.write_str("CredentialCompareAndSwapOutcome::Conflict(<redacted>)")
            }
            Self::Uncertain => formatter.write_str("CredentialCompareAndSwapOutcome::Uncertain"),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum CurrentState {
    Absent,
    Present,
}

struct CurrentSnapshot {
    state: CurrentState,
    bytes: Vec<u8>,
    digest: [u8; 32],
    identity: Option<ObjectIdentity>,
}

impl CurrentSnapshot {
    fn absent() -> Self {
        Self {
            state: CurrentState::Absent,
            bytes: Vec::new(),
            digest: Sha256::digest([]).into(),
            identity: None,
        }
    }

    fn present(bytes: Vec<u8>, identity: ObjectIdentity) -> Self {
        let digest = Sha256::digest(&bytes).into();
        Self {
            state: CurrentState::Present,
            bytes,
            digest,
            identity: Some(identity),
        }
    }

    fn matches_revision(&self, revision: &CredentialRevision) -> bool {
        self.state == revision.state
            && self.digest == revision.digest
            && self.identity == revision.identity
    }
}

struct ObservationFailure {
    code: CellErrorCode,
    fence: bool,
}

impl ObservationFailure {
    fn transient(code: CellErrorCode) -> Self {
        Self { code, fence: false }
    }

    fn fenced(code: CellErrorCode) -> Self {
        Self { code, fence: true }
    }
}

#[derive(Clone, Copy)]
enum ObservationMode {
    PublicRead,
    CurrentCheck,
}

pub(super) struct TrackedTemporary<D> {
    name: String,
    descriptor: DescriptorSlot<D>,
    identity: Option<ObjectIdentity>,
    expected_size: usize,
}

impl<D> TrackedTemporary<D> {
    fn new(name: String, descriptor: D, expected_size: usize) -> Self {
        Self {
            name,
            descriptor: DescriptorSlot::new(descriptor),
            identity: None,
            expected_size,
        }
    }

    pub(super) fn take_descriptor(&mut self) -> Option<D> {
        self.descriptor.take()
    }
}

fn credential_metadata(
    metadata: ObjectMetadata,
    effective_uid: u32,
    effective_gid: u32,
) -> Result<ObjectIdentity, CellErrorCode> {
    if metadata.kind != ObjectKind::RegularFile || metadata.link_count != 1 {
        return Err(CellErrorCode::CellIdentityUncertain);
    }
    if metadata.owner_uid != effective_uid
        || metadata.owner_gid != effective_gid
        || metadata.mode != 0o600
    {
        return Err(CellErrorCode::CellPermissionInvalid);
    }
    if metadata.size_bytes > CREDENTIAL_MAXIMUM_BYTES as u64 {
        return Err(CellErrorCode::CellCorrupt);
    }
    Ok(metadata.identity)
}

fn temporary_metadata(
    metadata: ObjectMetadata,
    effective_uid: u32,
    effective_gid: u32,
    expected_size: usize,
) -> Result<ObjectIdentity, CellErrorCode> {
    if metadata.kind != ObjectKind::RegularFile || metadata.link_count != 1 {
        return Err(CellErrorCode::CellIdentityUncertain);
    }
    if metadata.owner_uid != effective_uid
        || metadata.owner_gid != effective_gid
        || metadata.mode != 0o600
    {
        return Err(CellErrorCode::CellPermissionInvalid);
    }
    if metadata.size_bytes != expected_size as u64 {
        return Err(CellErrorCode::CellIdentityUncertain);
    }
    Ok(metadata.identity)
}

fn temporary_name() -> Result<String, CellErrorCode> {
    let mut entropy = [0_u8; TEMPORARY_ENTROPY_BYTES];
    getrandom::fill(&mut entropy).map_err(|_| CellErrorCode::CellIo)?;
    let mut name = String::with_capacity(TEMPORARY_PREFIX.len() + TEMPORARY_SUFFIX_CHARACTERS);
    name.push_str(TEMPORARY_PREFIX);
    for byte in entropy {
        name.push(TEMPORARY_LOWERCASE_HEX_ALPHABET[(byte >> 4) as usize] as char);
        name.push(TEMPORARY_LOWERCASE_HEX_ALPHABET[(byte & 0x0f) as usize] as char);
    }
    assert_eq!(
        name.len(),
        TEMPORARY_PREFIX.len() + TEMPORARY_SUFFIX_CHARACTERS
    );
    Ok(name)
}

impl<P: CredentialMutationPlatform> AdmissionOwner<P> {
    fn ensure_mutation_live(&self) -> Result<(), CellErrorCode> {
        if self.mutation_fenced || self.close_result.is_some() {
            Err(CellErrorCode::CellClosed)
        } else {
            Ok(())
        }
    }

    fn exact_open_check(&self) -> Result<(), CellErrorCode> {
        self.ensure_mutation_live()?;
        self.lifecycle.check_mutation_open()
    }

    fn full_mutation_gate(&mut self) -> Result<(), CellErrorCode> {
        self.exact_open_check()?;
        recheck_directory(
            &self.lifecycle,
            self.platform.as_mut().expect("platform"),
            self.directory.get(),
            self.effective,
            self.directory_identity,
        )?;
        self.lifecycle.check_mutation_open()?;

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
        self.lifecycle.check_mutation_open()?;

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
        self.lifecycle.check_mutation_open()?;

        let mut bytes = [0_u8; CLAIM_JOURNAL_LENGTH];
        self.platform
            .as_mut()
            .expect("platform")
            .read_claim_exact(self.claim.get(), &mut bytes)
            .map_err(map_platform_failure)?;
        if ClaimJournal::decode(&bytes)? != self.journal {
            return Err(CellErrorCode::CellIdentityUncertain);
        }
        self.lifecycle.check_mutation_open()
    }

    fn fence_mutation(&mut self) {
        self.current_revision_generation = None;
        self.mutation_fenced = true;
        self.lifecycle.mark_close_uncertain();
    }

    fn gate_or_fence(&mut self) -> Result<(), CellErrorCode> {
        match self.full_mutation_gate() {
            Ok(()) => Ok(()),
            Err(error) => {
                self.fence_mutation();
                Err(error)
            }
        }
    }

    fn observation_checkpoint(&mut self, mode: ObservationMode) -> Result<(), ObservationFailure> {
        let result = match mode {
            ObservationMode::PublicRead => self.full_mutation_gate(),
            ObservationMode::CurrentCheck => self.lifecycle.check_mutation_open(),
        };
        result.map_err(ObservationFailure::fenced)
    }

    fn close_observation_descriptor(
        &mut self,
        descriptor: &mut DescriptorSlot<P::Descriptor>,
    ) -> Result<(), ObservationFailure> {
        self.lifecycle
            .check_parent_process()
            .map_err(ObservationFailure::fenced)?;
        let descriptor = descriptor
            .take()
            .expect("credential observation descriptor");
        self.platform
            .as_mut()
            .expect("platform")
            .raw_close(descriptor)
            .map_err(|_| ObservationFailure::fenced(CellErrorCode::CellIo))
    }

    fn fail_observation_with_close(
        &mut self,
        descriptor: &mut DescriptorSlot<P::Descriptor>,
        failure: ObservationFailure,
    ) -> ObservationFailure {
        match self.close_observation_descriptor(descriptor) {
            Ok(()) => failure,
            Err(close_failure) => close_failure,
        }
    }

    fn observe_current_after_initial_gate(
        &mut self,
        mode: ObservationMode,
    ) -> Result<CurrentSnapshot, ObservationFailure> {
        let initial = self
            .platform
            .as_mut()
            .expect("platform")
            .fstatat_credential_nofollow(self.directory.get())
            .map_err(|failure| ObservationFailure::transient(map_platform_failure(failure)))?;
        let preflight = match initial {
            Lookup::Absent => {
                self.observation_checkpoint(mode)?;
                return Ok(CurrentSnapshot::absent());
            }
            Lookup::Present(metadata) => metadata,
        };
        credential_metadata(
            preflight,
            self.effective.effective_uid,
            self.effective.effective_gid,
        )
        .map_err(ObservationFailure::fenced)?;

        self.exact_open_check()
            .map_err(ObservationFailure::fenced)?;
        let descriptor = self
            .platform
            .as_mut()
            .expect("platform")
            .open_credential_readonly(self.directory.get())
            .map_err(|failure| match failure {
                PlatformFailure::NotFound => {
                    ObservationFailure::fenced(CellErrorCode::CellIdentityUncertain)
                }
                other => ObservationFailure::fenced(map_platform_failure(other)),
            })?;
        let mut descriptor = DescriptorSlot::new(descriptor);

        if let Err(failure) = self.observation_checkpoint(mode) {
            return Err(self.fail_observation_with_close(&mut descriptor, failure));
        }
        let a = match self
            .platform
            .as_mut()
            .expect("platform")
            .fstat(descriptor.get())
        {
            Ok(metadata) => metadata,
            Err(failure) => {
                let failure = ObservationFailure::fenced(map_platform_failure(failure));
                return Err(self.fail_observation_with_close(&mut descriptor, failure));
            }
        };
        let a_identity = match credential_metadata(
            a,
            self.effective.effective_uid,
            self.effective.effective_gid,
        ) {
            Ok(identity) => identity,
            Err(error) => {
                return Err(self.fail_observation_with_close(
                    &mut descriptor,
                    ObservationFailure::fenced(error),
                ))
            }
        };
        match self
            .platform
            .as_mut()
            .expect("platform")
            .descriptor_has_cloexec(descriptor.get())
        {
            Ok(true) => {}
            Ok(false) => {
                return Err(self.fail_observation_with_close(
                    &mut descriptor,
                    ObservationFailure::fenced(CellErrorCode::CellPermissionInvalid),
                ))
            }
            Err(failure) => {
                return Err(self.fail_observation_with_close(
                    &mut descriptor,
                    ObservationFailure::fenced(map_platform_failure(failure)),
                ))
            }
        }
        let mut bytes = vec![0_u8; a.size_bytes as usize];
        if let Err(failure) = self
            .platform
            .as_mut()
            .expect("platform")
            .read_file_exact(descriptor.get(), &mut bytes)
        {
            return Err(self.fail_observation_with_close(
                &mut descriptor,
                ObservationFailure::fenced(map_platform_failure(failure)),
            ));
        }

        if let Err(failure) = self.observation_checkpoint(mode) {
            return Err(self.fail_observation_with_close(&mut descriptor, failure));
        }
        let b = match self
            .platform
            .as_mut()
            .expect("platform")
            .fstatat_credential_nofollow(self.directory.get())
        {
            Ok(Lookup::Present(metadata)) => metadata,
            Ok(Lookup::Absent) | Err(PlatformFailure::NotFound) => {
                return Err(self.fail_observation_with_close(
                    &mut descriptor,
                    ObservationFailure::fenced(CellErrorCode::CellIdentityUncertain),
                ))
            }
            Err(failure) => {
                return Err(self.fail_observation_with_close(
                    &mut descriptor,
                    ObservationFailure::fenced(map_platform_failure(failure)),
                ))
            }
        };

        if let Err(failure) = self.observation_checkpoint(mode) {
            return Err(self.fail_observation_with_close(&mut descriptor, failure));
        }
        let c = match self
            .platform
            .as_mut()
            .expect("platform")
            .fstat(descriptor.get())
        {
            Ok(metadata) => metadata,
            Err(failure) => {
                return Err(self.fail_observation_with_close(
                    &mut descriptor,
                    ObservationFailure::fenced(map_platform_failure(failure)),
                ))
            }
        };
        let b_identity = match credential_metadata(
            b,
            self.effective.effective_uid,
            self.effective.effective_gid,
        ) {
            Ok(identity) => identity,
            Err(error) => {
                return Err(self.fail_observation_with_close(
                    &mut descriptor,
                    ObservationFailure::fenced(error),
                ))
            }
        };
        let c_identity = match credential_metadata(
            c,
            self.effective.effective_uid,
            self.effective.effective_gid,
        ) {
            Ok(identity) => identity,
            Err(error) => {
                return Err(self.fail_observation_with_close(
                    &mut descriptor,
                    ObservationFailure::fenced(error),
                ))
            }
        };
        if a != b || b != c || a_identity != b_identity || b_identity != c_identity {
            return Err(self.fail_observation_with_close(
                &mut descriptor,
                ObservationFailure::fenced(CellErrorCode::CellIdentityUncertain),
            ));
        }

        if let Err(failure) = self.observation_checkpoint(mode) {
            return Err(self.fail_observation_with_close(&mut descriptor, failure));
        }
        self.close_observation_descriptor(&mut descriptor)?;
        Ok(CurrentSnapshot::present(bytes, a_identity))
    }

    fn issue_current(
        &mut self,
        snapshot: CurrentSnapshot,
    ) -> Result<CredentialCurrent, CellErrorCode> {
        let generation = self.next_revision_generation;
        let Some(next_generation) = generation.checked_add(1) else {
            self.fence_mutation();
            return Err(CellErrorCode::CellClosed);
        };
        self.next_revision_generation = next_generation;
        let owner_binding = self.lifecycle.mutation_owner_binding()?;
        self.current_revision_generation = Some(generation);
        let revision = CredentialRevision {
            owner_binding,
            issuance_generation: generation,
            state: snapshot.state,
            digest: snapshot.digest,
            identity: snapshot.identity,
        };
        Ok(match snapshot.state {
            CurrentState::Absent => CredentialCurrent::Absent { revision },
            CurrentState::Present => CredentialCurrent::Present {
                revision,
                bytes: snapshot.bytes,
            },
        })
    }

    fn consume_revision(
        &mut self,
        revision: CredentialRevision,
    ) -> Result<CredentialRevision, CellErrorCode> {
        if self.current_revision_generation != Some(revision.issuance_generation)
            || !self
                .lifecycle
                .matches_mutation_owner_binding(&revision.owner_binding)
        {
            return Err(CellErrorCode::InvalidRevision);
        }
        self.current_revision_generation = None;
        Ok(revision)
    }

    /// Reads the exact credential cell through the sole live admission owner.
    /// A successful read invalidates every previously issued revision.
    pub fn read(&mut self) -> Result<CredentialCurrent, CellErrorCode> {
        self.ensure_mutation_live()?;
        self.gate_or_fence()?;
        match self.observe_current_after_initial_gate(ObservationMode::PublicRead) {
            Ok(snapshot) => self.issue_current(snapshot),
            Err(failure) => {
                if failure.fence {
                    self.fence_mutation();
                }
                Err(failure.code)
            }
        }
    }

    fn prove_temporary(
        &mut self,
        expected_bytes: Option<&[u8]>,
    ) -> Result<ObjectIdentity, CellErrorCode> {
        self.lifecycle.check_mutation_open()?;
        let temporary = self
            .known_temporary
            .as_ref()
            .ok_or(CellErrorCode::CellRecoveryRequired)?;
        let a = self
            .platform
            .as_mut()
            .expect("platform")
            .fstat(temporary.descriptor.get())
            .map_err(map_platform_failure)?;
        self.lifecycle.check_mutation_open()?;
        let b = match self
            .platform
            .as_mut()
            .expect("platform")
            .fstatat_temporary_nofollow(self.directory.get(), &temporary.name)
            .map_err(map_platform_failure)?
        {
            Lookup::Present(metadata) => metadata,
            Lookup::Absent => return Err(CellErrorCode::CellIdentityUncertain),
        };
        self.lifecycle.check_mutation_open()?;
        let c = self
            .platform
            .as_mut()
            .expect("platform")
            .fstat(temporary.descriptor.get())
            .map_err(map_platform_failure)?;
        let a_identity = temporary_metadata(
            a,
            self.effective.effective_uid,
            self.effective.effective_gid,
            temporary.expected_size,
        )?;
        let b_identity = temporary_metadata(
            b,
            self.effective.effective_uid,
            self.effective.effective_gid,
            temporary.expected_size,
        )?;
        let c_identity = temporary_metadata(
            c,
            self.effective.effective_uid,
            self.effective.effective_gid,
            temporary.expected_size,
        )?;
        if a != b || b != c || a_identity != b_identity || b_identity != c_identity {
            return Err(CellErrorCode::CellIdentityUncertain);
        }
        if temporary
            .identity
            .is_some_and(|identity| identity != a_identity)
        {
            return Err(CellErrorCode::CellIdentityUncertain);
        }
        self.lifecycle.check_mutation_open()?;
        if !self
            .platform
            .as_mut()
            .expect("platform")
            .descriptor_has_cloexec(temporary.descriptor.get())
            .map_err(map_platform_failure)?
        {
            return Err(CellErrorCode::CellPermissionInvalid);
        }
        if let Some(expected) = expected_bytes {
            let mut observed = vec![0_u8; expected.len()];
            self.platform
                .as_mut()
                .expect("platform")
                .read_file_exact(temporary.descriptor.get(), &mut observed)
                .map_err(map_platform_failure)?;
            if observed != expected || Sha256::digest(&observed) != Sha256::digest(expected) {
                return Err(CellErrorCode::CellIdentityUncertain);
            }
        }
        self.lifecycle.check_mutation_open()?;
        Ok(a_identity)
    }

    fn prepare_temporary(&mut self, replacement: &[u8]) -> Result<(), CellErrorCode> {
        let mut created = None;
        for _ in 0..TEMPORARY_CREATE_ATTEMPTS {
            let name = temporary_name()?;
            self.gate_or_fence()?;
            match self
                .platform
                .as_mut()
                .expect("platform")
                .create_temporary_exclusive(self.directory.get(), &name)
            {
                Ok(descriptor) => {
                    created = Some((name, descriptor));
                    break;
                }
                Err(PlatformFailure::AlreadyExists) => continue,
                Err(failure) => return Err(map_platform_failure(failure)),
            }
        }
        let (name, descriptor) = created.ok_or(CellErrorCode::CellIo)?;
        self.known_temporary = Some(TrackedTemporary::new(name, descriptor, 0));
        let identity = self.prove_temporary(Some(&[]))?;
        let temporary = self.known_temporary.as_mut().expect("tracked temporary");
        temporary.identity = Some(identity);
        temporary.expected_size = replacement.len();
        Ok(())
    }

    fn cleanup_temporary(&mut self) -> Result<(), CellErrorCode> {
        let gate = self.full_mutation_gate();
        if let Err(error) = gate {
            let error = if error == CellErrorCode::CellIdentityUncertain {
                CellErrorCode::CellIdentityUncertain
            } else {
                CellErrorCode::CellRecoveryRequired
            };
            self.fence_mutation();
            return Err(error);
        }
        let Some(identity) = self
            .known_temporary
            .as_ref()
            .and_then(|temporary| temporary.identity)
        else {
            self.fence_mutation();
            return Err(CellErrorCode::CellIdentityUncertain);
        };
        match self.prove_temporary_for_cleanup() {
            Ok(observed) if observed == identity => {}
            _ => {
                self.fence_mutation();
                return Err(CellErrorCode::CellIdentityUncertain);
            }
        }
        let name = self
            .known_temporary
            .as_ref()
            .expect("tracked temporary")
            .name
            .clone();
        if self
            .platform
            .as_mut()
            .expect("platform")
            .unlink_temporary(self.directory.get(), &name)
            .is_err()
        {
            self.fence_mutation();
            return Err(CellErrorCode::CellRecoveryRequired);
        }
        match self
            .platform
            .as_mut()
            .expect("platform")
            .fstatat_temporary_nofollow(self.directory.get(), &name)
        {
            Ok(Lookup::Absent) => {}
            _ => {
                self.fence_mutation();
                return Err(CellErrorCode::CellRecoveryRequired);
            }
        }
        if self
            .platform
            .as_mut()
            .expect("platform")
            .fsync_directory(self.directory.get())
            .is_err()
        {
            self.fence_mutation();
            return Err(CellErrorCode::CellRecoveryRequired);
        }
        if self.lifecycle.check_parent_process().is_err() {
            self.fence_mutation();
            return Err(CellErrorCode::CellRecoveryRequired);
        }
        let descriptor = self
            .known_temporary
            .as_mut()
            .expect("tracked temporary")
            .take_descriptor()
            .expect("temporary descriptor");
        if self
            .platform
            .as_mut()
            .expect("platform")
            .raw_close(descriptor)
            .is_err()
        {
            self.fence_mutation();
            return Err(CellErrorCode::CellRecoveryRequired);
        }
        self.known_temporary = None;
        Ok(())
    }

    fn prove_temporary_for_cleanup(&mut self) -> Result<ObjectIdentity, CellErrorCode> {
        self.lifecycle.check_mutation_open()?;
        let temporary = self
            .known_temporary
            .as_ref()
            .ok_or(CellErrorCode::CellRecoveryRequired)?;
        let a = self
            .platform
            .as_mut()
            .expect("platform")
            .fstat(temporary.descriptor.get())
            .map_err(map_platform_failure)?;
        self.lifecycle.check_mutation_open()?;
        let b = match self
            .platform
            .as_mut()
            .expect("platform")
            .fstatat_temporary_nofollow(self.directory.get(), &temporary.name)
            .map_err(map_platform_failure)?
        {
            Lookup::Present(metadata) => metadata,
            Lookup::Absent => return Err(CellErrorCode::CellIdentityUncertain),
        };
        self.lifecycle.check_mutation_open()?;
        let c = self
            .platform
            .as_mut()
            .expect("platform")
            .fstat(temporary.descriptor.get())
            .map_err(map_platform_failure)?;
        for metadata in [a, b, c] {
            if metadata.kind != ObjectKind::RegularFile || metadata.link_count != 1 {
                return Err(CellErrorCode::CellIdentityUncertain);
            }
            if metadata.owner_uid != self.effective.effective_uid
                || metadata.owner_gid != self.effective.effective_gid
                || metadata.mode != 0o600
            {
                return Err(CellErrorCode::CellIdentityUncertain);
            }
        }
        if a != b || b != c {
            return Err(CellErrorCode::CellIdentityUncertain);
        }
        if !self
            .platform
            .as_mut()
            .expect("platform")
            .descriptor_has_cloexec(temporary.descriptor.get())
            .map_err(map_platform_failure)?
        {
            return Err(CellErrorCode::CellIdentityUncertain);
        }
        self.lifecycle.check_mutation_open()?;
        Ok(a.identity)
    }

    fn precommit_gate_or_fence(&mut self) -> Result<(), CellErrorCode> {
        match self.full_mutation_gate() {
            Ok(()) => Ok(()),
            Err(CellErrorCode::CellIdentityUncertain) => {
                self.fence_mutation();
                Err(CellErrorCode::CellIdentityUncertain)
            }
            Err(_) => {
                self.fence_mutation();
                Err(CellErrorCode::CellRecoveryRequired)
            }
        }
    }

    fn precommit_failure(
        &mut self,
        failure: ObservationFailure,
    ) -> Result<CredentialCompareAndSwapOutcome, CellErrorCode> {
        self.cleanup_temporary()?;
        if failure.fence {
            self.fence_mutation();
        }
        Err(failure.code)
    }

    fn uncertain(&mut self) -> Result<CredentialCompareAndSwapOutcome, CellErrorCode> {
        self.fence_mutation();
        Ok(CredentialCompareAndSwapOutcome::Uncertain)
    }

    fn prove_published(&mut self, replacement: &[u8]) -> Result<(), CellErrorCode> {
        let temporary = self
            .known_temporary
            .as_ref()
            .ok_or(CellErrorCode::CellRecoveryRequired)?;
        match self
            .platform
            .as_mut()
            .expect("platform")
            .fstatat_temporary_nofollow(self.directory.get(), &temporary.name)
            .map_err(map_platform_failure)?
        {
            Lookup::Absent => {}
            Lookup::Present(_) => return Err(CellErrorCode::CellIdentityUncertain),
        }
        let a = self
            .platform
            .as_mut()
            .expect("platform")
            .fstat(temporary.descriptor.get())
            .map_err(map_platform_failure)?;
        let b = match self
            .platform
            .as_mut()
            .expect("platform")
            .fstatat_credential_nofollow(self.directory.get())
            .map_err(map_platform_failure)?
        {
            Lookup::Present(metadata) => metadata,
            Lookup::Absent => return Err(CellErrorCode::CellIdentityUncertain),
        };
        let c = self
            .platform
            .as_mut()
            .expect("platform")
            .fstat(temporary.descriptor.get())
            .map_err(map_platform_failure)?;
        let a_identity = temporary_metadata(
            a,
            self.effective.effective_uid,
            self.effective.effective_gid,
            replacement.len(),
        )?;
        let b_identity = temporary_metadata(
            b,
            self.effective.effective_uid,
            self.effective.effective_gid,
            replacement.len(),
        )?;
        let c_identity = temporary_metadata(
            c,
            self.effective.effective_uid,
            self.effective.effective_gid,
            replacement.len(),
        )?;
        if a != b || b != c || a_identity != b_identity || b_identity != c_identity {
            return Err(CellErrorCode::CellIdentityUncertain);
        }
        if temporary.identity != Some(a_identity) {
            return Err(CellErrorCode::CellIdentityUncertain);
        }
        let mut observed = vec![0_u8; replacement.len()];
        self.platform
            .as_mut()
            .expect("platform")
            .read_file_exact(temporary.descriptor.get(), &mut observed)
            .map_err(map_platform_failure)?;
        if observed != replacement || Sha256::digest(&observed) != Sha256::digest(replacement) {
            return Err(CellErrorCode::CellIdentityUncertain);
        }
        Ok(())
    }

    /// Consumes one exact current revision, checks current twice, and publishes
    /// only through same-directory rename. No same-bytes shortcut exists.
    pub fn compare_and_swap(
        &mut self,
        revision: CredentialRevision,
        replacement: &[u8],
    ) -> Result<CredentialCompareAndSwapOutcome, CellErrorCode> {
        self.ensure_mutation_live()?;
        if replacement.len() > CREDENTIAL_MAXIMUM_BYTES {
            return Err(CellErrorCode::ValueTooLarge);
        }

        self.gate_or_fence()?;
        let revision = self.consume_revision(revision)?;

        self.gate_or_fence()?;
        let first = match self.observe_current_after_initial_gate(ObservationMode::CurrentCheck) {
            Ok(snapshot) => snapshot,
            Err(failure) => {
                if failure.fence {
                    self.fence_mutation();
                }
                return Err(failure.code);
            }
        };
        if !first.matches_revision(&revision) {
            return self
                .issue_current(first)
                .map(CredentialCompareAndSwapOutcome::Conflict);
        }

        if let Err(error) = self.prepare_temporary(replacement) {
            if self.known_temporary.is_some() {
                return self.precommit_failure(ObservationFailure::transient(error));
            }
            return Err(error);
        }

        if let Err(error) = self.precommit_gate_or_fence() {
            return Err(error);
        }
        let write_result = {
            let temporary = self.known_temporary.as_ref().expect("tracked temporary");
            self.platform
                .as_mut()
                .expect("platform")
                .write_temporary_from_start(temporary.descriptor.get(), replacement)
        };
        if let Err(failure) = write_result {
            return self
                .precommit_failure(ObservationFailure::transient(map_platform_failure(failure)));
        }

        if let Err(error) = self.precommit_gate_or_fence() {
            return Err(error);
        }
        let sync_result = {
            let temporary = self.known_temporary.as_ref().expect("tracked temporary");
            self.platform
                .as_mut()
                .expect("platform")
                .fsync_temporary(temporary.descriptor.get())
        };
        if let Err(failure) = sync_result {
            return self
                .precommit_failure(ObservationFailure::transient(map_platform_failure(failure)));
        }

        if let Err(error) = self.precommit_gate_or_fence() {
            return Err(error);
        }
        if let Err(error) = self.prove_temporary(Some(replacement)) {
            return self.precommit_failure(ObservationFailure::fenced(error));
        }

        if let Err(error) = self.precommit_gate_or_fence() {
            return Err(error);
        }
        let second = match self.observe_current_after_initial_gate(ObservationMode::CurrentCheck) {
            Ok(snapshot) => snapshot,
            Err(failure) => return self.precommit_failure(failure),
        };
        if !second.matches_revision(&revision) {
            self.cleanup_temporary()?;
            return self
                .issue_current(second)
                .map(CredentialCompareAndSwapOutcome::Conflict);
        }

        if let Err(error) = self.precommit_gate_or_fence() {
            return Err(error);
        }
        if let Err(error) = self.prove_temporary(Some(replacement)) {
            return self.precommit_failure(ObservationFailure::fenced(error));
        }
        let temporary_name = self
            .known_temporary
            .as_ref()
            .expect("tracked temporary")
            .name
            .clone();
        let rename_result = self
            .platform
            .as_mut()
            .expect("platform")
            .rename_temporary_to_credential(self.directory.get(), &temporary_name);
        if rename_result.is_err() {
            if self.full_mutation_gate().is_err() {
                return self.uncertain();
            }
            let old = match self.observe_current_after_initial_gate(ObservationMode::CurrentCheck) {
                Ok(snapshot) => snapshot,
                Err(_) => return self.uncertain(),
            };
            if !old.matches_revision(&revision) || self.prove_temporary(Some(replacement)).is_err()
            {
                return self.uncertain();
            }
            self.cleanup_temporary()?;
            return Err(CellErrorCode::CellIo);
        }
        if self.full_mutation_gate().is_err() || self.prove_published(replacement).is_err() {
            return self.uncertain();
        }
        if self.full_mutation_gate().is_err()
            || self
                .platform
                .as_mut()
                .expect("platform")
                .fsync_directory(self.directory.get())
                .is_err()
        {
            return self.uncertain();
        }
        if self.full_mutation_gate().is_err() {
            return self.uncertain();
        }
        let descriptor = self
            .known_temporary
            .as_mut()
            .expect("tracked temporary")
            .take_descriptor()
            .expect("published descriptor");
        if self
            .platform
            .as_mut()
            .expect("platform")
            .raw_close(descriptor)
            .is_err()
        {
            return self.uncertain();
        }
        self.known_temporary = None;
        Ok(CredentialCompareAndSwapOutcome::Swapped)
    }
}
