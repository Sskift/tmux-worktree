use super::*;
use crate::claim_journal::{issue_claim_id_with_for_test, ClaimJournal};
use crate::process_lifecycle::{
    poison_registry_after_begin_close_for_test, poison_registry_for_test,
    process_lifecycle_for_test, registry_poison_flag_for_test, remove_registry_entry_for_test,
};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

const PID: u32 = 4242;
const UID: u32 = 501;
const GID: u32 = 20;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum FakeDescriptor {
    Directory(u32),
    Lock,
    Claim,
    Credential,
    Temporary,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FakeRename {
    Succeed,
    ErrorNoCommit,
    ErrorAfterCommit,
    SucceedWithPublishedIdentityMismatch,
}

#[derive(Debug)]
struct FakeState {
    events: Vec<String>,
    fail_event: Option<String>,
    close_counts: HashMap<FakeDescriptor, usize>,
    directory: ObjectMetadata,
    lock: ObjectMetadata,
    claim: ObjectMetadata,
    lock_exists: bool,
    claim_exists: bool,
    claim_bytes: Vec<u8>,
    lock_busy: bool,
    claim_create_race: Option<ObjectMetadata>,
    poison_registry_on_event: Option<(String, Arc<AtomicBool>)>,
    credential_exists: bool,
    credential: ObjectMetadata,
    credential_bytes: Vec<u8>,
    open_credential: Option<(ObjectMetadata, Vec<u8>)>,
    credential_lookup_count: usize,
    credential_lookup_error: bool,
    credential_open_not_found: bool,
    change_credential_on_lookup: Option<usize>,
    credential_path_identity_mismatch_on_lookup: Option<usize>,
    temporary_name: Option<String>,
    temporary_exists: bool,
    temporary: ObjectMetadata,
    temporary_bytes: Vec<u8>,
    temporary_lookup_count: usize,
    temporary_path_identity_mismatch_on_lookup: Option<usize>,
    temporary_collisions_remaining: usize,
    poison_registry_after_temporary_collision: Option<Arc<AtomicBool>>,
    temporary_create_count: usize,
    temporary_unlink_failure: bool,
    rename: FakeRename,
    claim_read_count: usize,
    poison_registry_after_claim_read: Option<(usize, Arc<AtomicBool>)>,
}

impl FakeState {
    fn new() -> Self {
        Self {
            events: Vec::new(),
            fail_event: None,
            close_counts: HashMap::new(),
            directory: metadata(ObjectKind::Directory, 11, 12, 0o700, 1, 0),
            lock: metadata(ObjectKind::RegularFile, 21, 22, 0o600, 1, 0),
            claim: metadata(
                ObjectKind::RegularFile,
                31,
                32,
                0o600,
                1,
                CLAIM_JOURNAL_LENGTH as u64,
            ),
            lock_exists: true,
            claim_exists: false,
            claim_bytes: Vec::new(),
            lock_busy: false,
            claim_create_race: None,
            poison_registry_on_event: None,
            credential_exists: false,
            credential: metadata(ObjectKind::RegularFile, 41, 42, 0o600, 1, 0),
            credential_bytes: Vec::new(),
            open_credential: None,
            credential_lookup_count: 0,
            credential_lookup_error: false,
            credential_open_not_found: false,
            change_credential_on_lookup: None,
            credential_path_identity_mismatch_on_lookup: None,
            temporary_name: None,
            temporary_exists: false,
            temporary: metadata(ObjectKind::RegularFile, 51, 52, 0o600, 1, 0),
            temporary_bytes: Vec::new(),
            temporary_lookup_count: 0,
            temporary_path_identity_mismatch_on_lookup: None,
            temporary_collisions_remaining: 0,
            poison_registry_after_temporary_collision: None,
            temporary_create_count: 0,
            temporary_unlink_failure: false,
            rename: FakeRename::Succeed,
            claim_read_count: 0,
            poison_registry_after_claim_read: None,
        }
    }
}

fn metadata(
    kind: ObjectKind,
    device: u64,
    inode: u64,
    mode: u32,
    link_count: u64,
    size_bytes: u64,
) -> ObjectMetadata {
    ObjectMetadata {
        identity: ObjectIdentity { device, inode },
        kind,
        owner_uid: UID,
        owner_gid: GID,
        mode,
        link_count,
        size_bytes,
    }
}

#[derive(Clone)]
struct FakePlatform {
    state: Arc<Mutex<FakeState>>,
}

impl FakePlatform {
    fn new(state: Arc<Mutex<FakeState>>) -> Self {
        Self { state }
    }

    fn event(&self, event: impl Into<String>) -> Result<(), PlatformFailure> {
        let event = event.into();
        let mut state = self.state.lock().expect("fake state");
        state.events.push(event.clone());
        let poison = state
            .poison_registry_on_event
            .as_ref()
            .filter(|(target, _)| target == &event)
            .map(|(_, flag)| Arc::clone(flag));
        let failed = state.fail_event.as_deref() == Some(event.as_str());
        drop(state);
        if let Some(poison) = poison {
            poison.store(true, Ordering::Release);
        }
        if failed {
            Err(PlatformFailure::Io)
        } else {
            Ok(())
        }
    }
}

impl DescriptorRelativePlatform for FakePlatform {
    type Descriptor = FakeDescriptor;

    fn effective_identity(&mut self) -> Result<EffectiveIdentity, PlatformFailure> {
        self.event("identity:effective")?;
        Ok(EffectiveIdentity {
            effective_uid: UID,
            effective_gid: GID,
        })
    }

    fn fstat(&mut self, descriptor: &Self::Descriptor) -> Result<ObjectMetadata, PlatformFailure> {
        self.event(format!("fstat:{}", descriptor_name(*descriptor)))?;
        let state = self.state.lock().expect("fake state");
        Ok(match descriptor {
            FakeDescriptor::Directory(_) => state.directory,
            FakeDescriptor::Lock => state.lock,
            FakeDescriptor::Claim => {
                let mut claim = state.claim;
                claim.size_bytes = state.claim_bytes.len() as u64;
                claim
            }
            FakeDescriptor::Credential => state
                .open_credential
                .as_ref()
                .map(|(metadata, _)| *metadata)
                .unwrap_or(state.credential),
            FakeDescriptor::Temporary => state.temporary,
        })
    }

    fn descriptor_has_cloexec(
        &mut self,
        descriptor: &Self::Descriptor,
    ) -> Result<bool, PlatformFailure> {
        self.event(format!("cloexec:{}", descriptor_name(*descriptor)))?;
        Ok(true)
    }

    fn fstatat_nofollow(
        &mut self,
        _directory: &Self::Descriptor,
        resource: RelativeResource,
    ) -> Result<Lookup, PlatformFailure> {
        self.event(format!("fstatat:{}:nofollow", resource_name(resource)))?;
        let state = self.state.lock().expect("fake state");
        Ok(match resource {
            RelativeResource::Lock if state.lock_exists => Lookup::Present(state.lock),
            RelativeResource::Claim if state.claim_exists => {
                let mut claim = state.claim;
                claim.size_bytes = state.claim_bytes.len() as u64;
                Lookup::Present(claim)
            }
            _ => Lookup::Absent,
        })
    }

    fn open_lock_existing(
        &mut self,
        _directory: &Self::Descriptor,
    ) -> Result<Self::Descriptor, PlatformFailure> {
        self.event("open:lock:existing-rdwr-nofollow-cloexec")?;
        Ok(FakeDescriptor::Lock)
    }

    fn create_lock_exclusive(
        &mut self,
        _directory: &Self::Descriptor,
    ) -> Result<Self::Descriptor, PlatformFailure> {
        self.event("open:lock:create-exclusive-rdwr-nofollow-cloexec-0600")?;
        let mut state = self.state.lock().expect("fake state");
        if state.lock_exists {
            return Err(PlatformFailure::AlreadyExists);
        }
        state.lock_exists = true;
        Ok(FakeDescriptor::Lock)
    }

    fn try_lock_whole_file_nonblocking(
        &mut self,
        _lock: &Self::Descriptor,
    ) -> Result<(), PlatformFailure> {
        self.event("fcntl:F_SETLK:F_WRLCK:SEEK_SET:0:0:nonblocking")?;
        if self.state.lock().expect("fake state").lock_busy {
            Err(PlatformFailure::Busy)
        } else {
            Ok(())
        }
    }

    fn create_claim_exclusive(
        &mut self,
        _directory: &Self::Descriptor,
    ) -> Result<Self::Descriptor, PlatformFailure> {
        self.event("open:claim:rdwr-creat-excl-nofollow-cloexec-0600")?;
        let mut state = self.state.lock().expect("fake state");
        if state.claim_exists {
            state.claim_exists = true;
            return Err(PlatformFailure::AlreadyExists);
        }
        if let Some(observation) = state.claim_create_race {
            state.claim_exists = true;
            state.claim = observation;
            state.claim_bytes = vec![0x5a; observation.size_bytes as usize];
            return Err(PlatformFailure::AlreadyExists);
        }
        state.claim_exists = true;
        state.claim_bytes.clear();
        Ok(FakeDescriptor::Claim)
    }

    fn write_claim_from_start(
        &mut self,
        _claim: &Self::Descriptor,
        bytes: &[u8],
    ) -> Result<(), PlatformFailure> {
        self.event("write:claim:offset-0:fixed")?;
        self.state.lock().expect("fake state").claim_bytes = bytes.to_vec();
        Ok(())
    }

    fn read_claim_exact(
        &mut self,
        _claim: &Self::Descriptor,
        output: &mut [u8],
    ) -> Result<(), PlatformFailure> {
        self.event("read:claim:offset-0:exact")?;
        let mut state = self.state.lock().expect("fake state");
        if state.claim_bytes.len() != output.len() {
            return Err(PlatformFailure::Io);
        }
        output.copy_from_slice(&state.claim_bytes);
        state.claim_read_count += 1;
        let poison = state
            .poison_registry_after_claim_read
            .as_ref()
            .filter(|(target, _)| *target == state.claim_read_count)
            .map(|(_, flag)| Arc::clone(flag));
        drop(state);
        if let Some(poison) = poison {
            poison.store(true, Ordering::Release);
        }
        Ok(())
    }

    fn fsync_claim(&mut self, _claim: &Self::Descriptor) -> Result<(), PlatformFailure> {
        self.event("fsync:claim")
    }

    fn fsync_directory(&mut self, _directory: &Self::Descriptor) -> Result<(), PlatformFailure> {
        self.event("fsync:directory")
    }

    fn unlink_claim(&mut self, _directory: &Self::Descriptor) -> Result<(), PlatformFailure> {
        self.event("unlinkat:claim")?;
        let mut state = self.state.lock().expect("fake state");
        if !state.claim_exists {
            return Err(PlatformFailure::NotFound);
        }
        state.claim_exists = false;
        Ok(())
    }

    fn raw_close(&mut self, descriptor: Self::Descriptor) -> Result<(), PlatformFailure> {
        let event = format!("raw-close:{}", descriptor_name(descriptor));
        let mut state = self.state.lock().expect("fake state");
        state.events.push(event.clone());
        *state.close_counts.entry(descriptor).or_default() += 1;
        if descriptor == FakeDescriptor::Credential {
            state.open_credential = None;
        }
        if state.fail_event.as_deref() == Some(event.as_str()) {
            Err(PlatformFailure::Io)
        } else {
            Ok(())
        }
    }
}

impl CredentialMutationPlatform for FakePlatform {
    fn fstatat_credential_nofollow(
        &mut self,
        _directory: &Self::Descriptor,
    ) -> Result<Lookup, PlatformFailure> {
        self.event("fstatat:credential:nofollow")?;
        let mut state = self.state.lock().expect("fake state");
        state.credential_lookup_count += 1;
        let count = state.credential_lookup_count;
        if state.credential_lookup_error && count == 1 {
            return Err(PlatformFailure::Io);
        }
        if state.change_credential_on_lookup == Some(count) {
            state.credential_exists = true;
            state.credential = metadata(ObjectKind::RegularFile, 61, 62, 0o600, 1, 3);
            state.credential_bytes = vec![9, 8, 7];
        }
        if !state.credential_exists {
            return Ok(Lookup::Absent);
        }
        let mut observed = state.credential;
        if state.credential_path_identity_mismatch_on_lookup == Some(count) {
            observed.identity.inode += 1;
        }
        Ok(Lookup::Present(observed))
    }

    fn open_credential_readonly(
        &mut self,
        _directory: &Self::Descriptor,
    ) -> Result<Self::Descriptor, PlatformFailure> {
        self.event("open:credential:readonly-nofollow-cloexec")?;
        let mut state = self.state.lock().expect("fake state");
        if state.credential_open_not_found || !state.credential_exists {
            return Err(PlatformFailure::NotFound);
        }
        state.open_credential = Some((state.credential, state.credential_bytes.clone()));
        Ok(FakeDescriptor::Credential)
    }

    fn read_file_exact(
        &mut self,
        descriptor: &Self::Descriptor,
        output: &mut [u8],
    ) -> Result<(), PlatformFailure> {
        self.event(format!("read-file:{}:exact", descriptor_name(*descriptor)))?;
        let state = self.state.lock().expect("fake state");
        let bytes = match descriptor {
            FakeDescriptor::Credential => state
                .open_credential
                .as_ref()
                .map(|(_, bytes)| bytes.as_slice())
                .ok_or(PlatformFailure::IdentityUncertain)?,
            FakeDescriptor::Temporary => state.temporary_bytes.as_slice(),
            _ => return Err(PlatformFailure::IdentityUncertain),
        };
        if bytes.len() != output.len() {
            return Err(PlatformFailure::Io);
        }
        output.copy_from_slice(bytes);
        Ok(())
    }

    fn fstatat_temporary_nofollow(
        &mut self,
        _directory: &Self::Descriptor,
        temporary_name: &str,
    ) -> Result<Lookup, PlatformFailure> {
        self.event(format!("fstatat:temporary:{temporary_name}:nofollow"))?;
        let mut state = self.state.lock().expect("fake state");
        state.temporary_lookup_count += 1;
        if !state.temporary_exists || state.temporary_name.as_deref() != Some(temporary_name) {
            return Ok(Lookup::Absent);
        }
        let mut observed = state.temporary;
        if state.temporary_path_identity_mismatch_on_lookup == Some(state.temporary_lookup_count) {
            observed.identity.inode += 1;
        }
        Ok(Lookup::Present(observed))
    }

    fn create_temporary_exclusive(
        &mut self,
        _directory: &Self::Descriptor,
        temporary_name: &str,
    ) -> Result<Self::Descriptor, PlatformFailure> {
        self.event(format!("open:temporary:{temporary_name}:exclusive-0600"))?;
        let mut state = self.state.lock().expect("fake state");
        state.temporary_create_count += 1;
        if state.temporary_collisions_remaining > 0 {
            state.temporary_collisions_remaining -= 1;
            if let Some(poison) = state.poison_registry_after_temporary_collision.take() {
                poison.store(true, Ordering::Release);
            }
            return Err(PlatformFailure::AlreadyExists);
        }
        if state.temporary_exists {
            return Err(PlatformFailure::AlreadyExists);
        }
        state.temporary_name = Some(temporary_name.to_string());
        state.temporary_exists = true;
        state.temporary = metadata(
            ObjectKind::RegularFile,
            51,
            100 + state.temporary_create_count as u64,
            0o600,
            1,
            0,
        );
        state.temporary_bytes.clear();
        Ok(FakeDescriptor::Temporary)
    }

    fn write_temporary_from_start(
        &mut self,
        _temporary: &Self::Descriptor,
        bytes: &[u8],
    ) -> Result<(), PlatformFailure> {
        self.event("write:temporary:offset-0:exact")?;
        let mut state = self.state.lock().expect("fake state");
        state.temporary_bytes = bytes.to_vec();
        state.temporary.size_bytes = bytes.len() as u64;
        Ok(())
    }

    fn fsync_temporary(&mut self, _temporary: &Self::Descriptor) -> Result<(), PlatformFailure> {
        self.event("fsync:temporary")
    }

    fn unlink_temporary(
        &mut self,
        _directory: &Self::Descriptor,
        temporary_name: &str,
    ) -> Result<(), PlatformFailure> {
        self.event(format!("unlinkat:temporary:{temporary_name}"))?;
        let mut state = self.state.lock().expect("fake state");
        if state.temporary_unlink_failure {
            return Err(PlatformFailure::Io);
        }
        if !state.temporary_exists || state.temporary_name.as_deref() != Some(temporary_name) {
            return Err(PlatformFailure::NotFound);
        }
        state.temporary_exists = false;
        Ok(())
    }

    fn rename_temporary_to_credential(
        &mut self,
        _directory: &Self::Descriptor,
        temporary_name: &str,
    ) -> Result<(), PlatformFailure> {
        self.event(format!("renameat:{temporary_name}:credential"))?;
        let mut state = self.state.lock().expect("fake state");
        if !state.temporary_exists || state.temporary_name.as_deref() != Some(temporary_name) {
            return Err(PlatformFailure::NotFound);
        }
        let disposition = state.rename;
        if disposition == FakeRename::ErrorNoCommit {
            return Err(PlatformFailure::Io);
        }
        state.credential_exists = true;
        state.credential = state.temporary;
        state.credential_bytes = state.temporary_bytes.clone();
        state.temporary_exists = false;
        if disposition == FakeRename::SucceedWithPublishedIdentityMismatch {
            state.credential.identity.inode += 1;
        }
        if disposition == FakeRename::ErrorAfterCommit {
            Err(PlatformFailure::Io)
        } else {
            Ok(())
        }
    }
}

fn descriptor_name(descriptor: FakeDescriptor) -> &'static str {
    match descriptor {
        FakeDescriptor::Directory(_) => "directory",
        FakeDescriptor::Lock => "lock",
        FakeDescriptor::Claim => "claim",
        FakeDescriptor::Credential => "credential",
        FakeDescriptor::Temporary => "temporary",
    }
}

fn resource_name(resource: RelativeResource) -> &'static str {
    match resource {
        RelativeResource::Lock => "lock",
        RelativeResource::Claim => "claim",
    }
}

fn claim_id() -> ClaimId {
    issue_claim_id_with_for_test(|bytes| {
        for (index, byte) in bytes.iter_mut().enumerate() {
            *byte = index as u8;
        }
        Ok(())
    })
    .expect("claim id")
}

fn context() -> (Arc<AtomicU32>, ProcessLifecycleToken) {
    let current_pid = Arc::new(AtomicU32::new(PID));
    let token = process_lifecycle_for_test(PID, Arc::clone(&current_pid));
    (current_pid, token)
}

fn open(
    token: &ProcessLifecycleToken,
    state: Arc<Mutex<FakeState>>,
    directory_id: u32,
) -> Result<AdmissionOwner<FakePlatform>, CellErrorCode> {
    adopt_prebound_directory(
        token,
        FakePlatform::new(state),
        FakeDescriptor::Directory(directory_id),
        &durability_qualification_for_test(),
    )
}

fn index(events: &[String], event: &str) -> usize {
    events
        .iter()
        .position(|candidate| candidate == event)
        .unwrap_or_else(|| panic!("missing event {event}: {events:?}"))
}

fn decode_hex(input: &str) -> Vec<u8> {
    assert_eq!(input.len() % 2, 0);
    input
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let text = std::str::from_utf8(pair).expect("hex utf8");
            u8::from_str_radix(text, 16).expect("hex byte")
        })
        .collect()
}

fn observed_claim_id(state: &FakeState) -> [u8; CLAIM_ID_LENGTH] {
    state.claim_bytes[24..56]
        .try_into()
        .expect("fixed claim id field")
}

fn contract_json(name: &str) -> Value {
    let source = match name {
        "claim-journal-v1.json" => include_str!(
            "../../../contracts/relay/v2/host-credential-atomic-file-cell-v1/claim-journal-v1.json"
        ),
        "platform-resource-cases.json" => include_str!(
            "../../../contracts/relay/v2/host-credential-atomic-file-cell-v1/platform-resource-cases.json"
        ),
        "manifest.json" => include_str!(
            "../../../contracts/relay/v2/host-credential-atomic-file-cell-v1/manifest.json"
        ),
        "credential-mutation-cases-v1.json" => include_str!(
            "../../../contracts/relay/v2/host-credential-atomic-file-cell-v1/credential-mutation-cases-v1.json"
        ),
        _ => panic!("unknown contract fixture {name}"),
    };
    serde_json::from_str(source).expect("parse contract JSON")
}

fn revision_from(current: CredentialCurrent) -> CredentialRevision {
    match current {
        CredentialCurrent::Absent { revision } | CredentialCurrent::Present { revision, .. } => {
            revision
        }
    }
}

fn current_state(current: &CredentialCurrent) -> &'static str {
    match current {
        CredentialCurrent::Absent { .. } => "absent",
        CredentialCurrent::Present { .. } => "present",
    }
}

fn contract_error(code: &str) -> CellErrorCode {
    match code {
        "CELL_CLOSED" => CellErrorCode::CellClosed,
        "CELL_CORRUPT" => CellErrorCode::CellCorrupt,
        "CELL_IDENTITY_UNCERTAIN" => CellErrorCode::CellIdentityUncertain,
        "CELL_IO" => CellErrorCode::CellIo,
        "CELL_PERMISSION_INVALID" => CellErrorCode::CellPermissionInvalid,
        "CELL_RECOVERY_REQUIRED" => CellErrorCode::CellRecoveryRequired,
        "INVALID_REVISION" => CellErrorCode::InvalidRevision,
        other => panic!("unsupported fixture error {other}"),
    }
}

fn set_present_credential(state: &mut FakeState, bytes: &[u8]) {
    state.credential_exists = true;
    state.credential_bytes = bytes.to_vec();
    state.credential = metadata(
        ObjectKind::RegularFile,
        41,
        42,
        0o600,
        1,
        bytes.len() as u64,
    );
}

fn reset_mutation_observation(state: &mut FakeState) {
    state.credential_lookup_count = 0;
    state.temporary_lookup_count = 0;
    state.claim_read_count = 0;
    state.events.clear();
}

fn assert_fixture_close_bounds(
    state: &FakeState,
    fixture: &Value,
    failure_cut: &str,
    directory_id: u32,
) {
    let expected = fixture["failureCloseBounds"]
        .as_array()
        .expect("failure close bounds")
        .iter()
        .find(|entry| entry["failureCut"].as_str() == Some(failure_cut))
        .unwrap_or_else(|| panic!("missing failure close bound {failure_cut}"));
    for (resource, descriptor) in [
        ("directory", FakeDescriptor::Directory(directory_id)),
        ("lock", FakeDescriptor::Lock),
        ("claim", FakeDescriptor::Claim),
    ] {
        let expected_count = expected[resource].as_u64().expect("expected close count") as usize;
        let observed_count = state.close_counts.get(&descriptor).copied().unwrap_or(0);
        assert_eq!(
            observed_count, expected_count,
            "{failure_cut} {resource}: {state:?}"
        );
    }
    for count in state.close_counts.values() {
        assert!(*count <= 1, "{failure_cut}: {state:?}");
    }
}

#[test]
fn claim_codec_consumes_the_v1_golden_and_rejects_corruption() {
    let fixture = contract_json("claim-journal-v1.json");
    let golden = &fixture["golden"];
    let journal = ClaimJournal {
        claim_id: claim_id(),
        directory: ObjectIdentity {
            device: golden["directory"]["device"]
                .as_str()
                .expect("dir device")
                .parse()
                .expect("dir device number"),
            inode: golden["directory"]["inode"]
                .as_str()
                .expect("dir inode")
                .parse()
                .expect("dir inode number"),
        },
        lock: ObjectIdentity {
            device: 21,
            inode: 22,
        },
        claim: ObjectIdentity {
            device: 31,
            inode: 32,
        },
        opener_pid: golden["openerPid"].as_u64().expect("pid") as u32,
        effective_uid: golden["effectiveUid"].as_u64().expect("uid") as u32,
        effective_gid: golden["effectiveGid"].as_u64().expect("gid") as u32,
    };
    let encoded = journal.encode();
    assert_eq!(
        encoded.as_slice(),
        decode_hex(golden["bytesHex"].as_str().expect("golden bytes"))
    );
    assert!(ClaimJournal::decode(&encoded) == Ok(journal));

    for offset in [0, 8, 12, 16, 20, 116, 160, 191] {
        let mut corrupt = encoded;
        corrupt[offset] ^= 0x01;
        assert!(
            ClaimJournal::decode(&corrupt) == Err(CellErrorCode::CellCorrupt),
            "offset {offset}"
        );
    }
    assert!(ClaimJournal::decode(&encoded[..encoded.len() - 1]) == Err(CellErrorCode::CellCorrupt));
}

#[test]
fn production_qualification_is_empty_and_resources_are_host_specific() {
    assert!(matches!(
        production_durability_qualification(),
        Err(CellErrorCode::CellDurabilityUnsupported)
    ));
    let spec = platform_resource_spec();
    assert_eq!(spec.contract_revision(), 6);
    assert_eq!(spec.resource_contract_version(), 1);
    assert_eq!(generated::CREDENTIAL_MUTATION_CONTRACT_VERSION, 1);
    assert!(generated::CREDENTIAL_MUTATION_IMPLEMENTED);
    assert_eq!(CLAIM_JOURNAL_FORMAT_VERSION, 1);
    assert_eq!(CLAIM_JOURNAL_STATE_ADMISSION_HELD_NO_CREDENTIAL_MUTATION, 1);
    assert_eq!(spec.claim_journal_length(), CLAIM_JOURNAL_LENGTH);
    for component in [spec.credential_name(), spec.lock_name(), spec.claim_name()] {
        assert!(!component.to_ascii_lowercase().contains("broker"));
        assert!(!component.contains('/'));
    }
}

#[test]
fn admission_and_normal_close_follow_the_locked_durable_owner_chain() {
    let (_current_pid, token) = context();
    let state = Arc::new(Mutex::new(FakeState::new()));
    let mut owner = open(&token, Arc::clone(&state), 1).expect("open owner");

    {
        let state = state.lock().expect("fake state");
        assert!(state.claim_exists);
        assert_eq!(state.claim_bytes.len(), CLAIM_JOURNAL_LENGTH);
        assert!(observed_claim_id(&state).iter().any(|byte| *byte != 0));
        let events = &state.events;
        assert!(index(events, "fstat:directory") < index(events, "fstatat:lock:nofollow"));
        assert!(
            index(events, "fstatat:lock:nofollow")
                < index(events, "open:lock:existing-rdwr-nofollow-cloexec")
        );
        assert!(
            index(events, "open:lock:existing-rdwr-nofollow-cloexec")
                < index(events, "fcntl:F_SETLK:F_WRLCK:SEEK_SET:0:0:nonblocking")
        );
        assert!(
            index(events, "fcntl:F_SETLK:F_WRLCK:SEEK_SET:0:0:nonblocking")
                < index(events, "fstatat:claim:nofollow")
        );
        assert!(
            index(events, "fstatat:claim:nofollow")
                < index(events, "open:claim:rdwr-creat-excl-nofollow-cloexec-0600",)
        );
        assert!(
            index(events, "open:claim:rdwr-creat-excl-nofollow-cloexec-0600",)
                < index(events, "cloexec:claim")
        );
        assert!(index(events, "cloexec:claim") < index(events, "write:claim:offset-0:fixed"));
        assert!(index(events, "write:claim:offset-0:fixed") < index(events, "fsync:claim"));
        assert!(index(events, "fsync:claim") < index(events, "fsync:directory"));
    }

    assert_eq!(owner.close(), Ok(()));
    assert_eq!(owner.close(), Ok(()));
    let state = state.lock().expect("fake state");
    assert!(
        index(&state.events, "read:claim:offset-0:exact") < index(&state.events, "unlinkat:claim")
    );
    assert!(!state.claim_exists);
    assert_fixture_close_bounds(
        &state,
        &contract_json("platform-resource-cases.json"),
        "normal-close",
        1,
    );
    assert_eq!(
        state
            .events
            .iter()
            .filter(|event| event.as_str() == "unlinkat:claim")
            .count(),
        1
    );
}

#[test]
fn operating_system_entropy_issues_nonzero_distinct_claim_ids() {
    let (_current_pid, token) = context();
    let mut issued = Vec::new();

    for directory_id in [1, 2] {
        let state = Arc::new(Mutex::new(FakeState::new()));
        let mut owner = open(&token, Arc::clone(&state), directory_id).expect("open owner");
        let claim_id = observed_claim_id(&state.lock().expect("fake state"));
        assert!(claim_id.iter().any(|byte| *byte != 0));
        issued.push(claim_id);
        owner.close().expect("close owner");
    }

    assert_ne!(issued[0], issued[1]);
}

#[test]
fn entropy_error_and_all_zero_fail_before_mutation_and_close_directory_once() {
    fn assert_failure(fill: impl FnOnce(&mut [u8; CLAIM_ID_LENGTH]) -> Result<(), ()>) {
        let (_current_pid, token) = context();
        let state = Arc::new(Mutex::new(FakeState::new()));
        let result = adopt_prebound_directory_with_entropy_for_test(
            &token,
            FakePlatform::new(Arc::clone(&state)),
            FakeDescriptor::Directory(1),
            &durability_qualification_for_test(),
            fill,
        )
        .map(|_| ());
        assert_eq!(result, Err(CellErrorCode::CellIo));

        let state = state.lock().expect("fake state");
        assert_eq!(state.events, ["raw-close:directory"]);
        assert_eq!(
            state.close_counts.get(&FakeDescriptor::Directory(1)),
            Some(&1)
        );
        assert_eq!(state.close_counts.get(&FakeDescriptor::Lock), None);
        assert_eq!(state.close_counts.get(&FakeDescriptor::Claim), None);
        assert!(!state.claim_exists);
    }

    assert_failure(|_| Err(()));
    assert_failure(|_| Ok(()));
}

#[test]
fn same_process_duplicate_is_busy_before_a_second_lock_descriptor() {
    let (_current_pid, token) = context();
    let state = Arc::new(Mutex::new(FakeState::new()));
    let mut first = open(&token, Arc::clone(&state), 1).expect("first owner");
    let before = state.lock().expect("fake state").events.len();

    assert!(matches!(
        open(&token, Arc::clone(&state), 2),
        Err(CellErrorCode::CellBusy)
    ));
    let state_guard = state.lock().expect("fake state");
    let duplicate_events = &state_guard.events[before..];
    assert!(!duplicate_events
        .iter()
        .any(|event| event.starts_with("open:lock:")));
    assert_eq!(
        state_guard.close_counts.get(&FakeDescriptor::Directory(2)),
        Some(&1)
    );
    drop(state_guard);
    first.close().expect("close first");
}

#[test]
fn existing_claim_and_claim_create_race_are_reobserved_classified_and_preserved() {
    for (case, kind, mode, link_count, size_bytes, expected) in [
        (
            "race-safe-fixed-length",
            ObjectKind::RegularFile,
            0o600,
            1,
            CLAIM_JOURNAL_LENGTH as u64,
            CellErrorCode::CellRecoveryRequired,
        ),
        (
            "race-zero-byte",
            ObjectKind::RegularFile,
            0o600,
            1,
            0,
            CellErrorCode::CellCorrupt,
        ),
        (
            "race-wrong-fixed-length",
            ObjectKind::RegularFile,
            0o600,
            1,
            CLAIM_JOURNAL_LENGTH as u64 - 1,
            CellErrorCode::CellCorrupt,
        ),
        (
            "race-symlink",
            ObjectKind::Symlink,
            0o600,
            1,
            CLAIM_JOURNAL_LENGTH as u64,
            CellErrorCode::CellIdentityUncertain,
        ),
        (
            "race-nlink",
            ObjectKind::RegularFile,
            0o600,
            2,
            CLAIM_JOURNAL_LENGTH as u64,
            CellErrorCode::CellIdentityUncertain,
        ),
        (
            "race-wrong-mode",
            ObjectKind::RegularFile,
            0o640,
            1,
            CLAIM_JOURNAL_LENGTH as u64,
            CellErrorCode::CellPermissionInvalid,
        ),
        (
            "race-foreign-owner",
            ObjectKind::RegularFile,
            0o600,
            1,
            CLAIM_JOURNAL_LENGTH as u64,
            CellErrorCode::CellPermissionInvalid,
        ),
    ] {
        let (_current_pid, token) = context();
        let mut fake = FakeState::new();
        let mut race_observation = metadata(kind, 31, 32, mode, link_count, size_bytes);
        if case == "race-foreign-owner" {
            race_observation.owner_uid = UID + 1;
        }
        fake.claim_create_race = Some(race_observation);
        let state = Arc::new(Mutex::new(fake));
        assert_eq!(
            open(&token, Arc::clone(&state), 1).map(|_| ()),
            Err(expected),
            "{case}"
        );
        let state = state.lock().expect("fake state");
        assert!(state.claim_exists);
        assert!(!state.events.iter().any(|event| event == "unlinkat:claim"));
        assert_eq!(state.close_counts.get(&FakeDescriptor::Lock), Some(&1));
        assert_eq!(
            state.close_counts.get(&FakeDescriptor::Directory(1)),
            Some(&1)
        );
        assert_eq!(state.close_counts.get(&FakeDescriptor::Claim), None);
        assert_eq!(state.claim, race_observation, "{case} was not repaired");
        let observations = state
            .events
            .iter()
            .enumerate()
            .filter_map(|(position, event)| (event == "fstatat:claim:nofollow").then_some(position))
            .collect::<Vec<_>>();
        let create = index(
            &state.events,
            "open:claim:rdwr-creat-excl-nofollow-cloexec-0600",
        );
        assert_eq!(observations.len(), 2, "{case}");
        assert!(
            observations[0] < create && create < observations[1],
            "{case}"
        );
    }
}

#[test]
fn lock_contention_is_busy_and_never_explicitly_unlocks() {
    let (_current_pid, token) = context();
    let mut fake = FakeState::new();
    fake.lock_busy = true;
    let state = Arc::new(Mutex::new(fake));
    assert!(matches!(
        open(&token, Arc::clone(&state), 1),
        Err(CellErrorCode::CellBusy)
    ));
    let state = state.lock().expect("fake state");
    assert!(state
        .events
        .iter()
        .any(|event| event == "fcntl:F_SETLK:F_WRLCK:SEEK_SET:0:0:nonblocking"));
    assert!(!state
        .events
        .iter()
        .any(|event| event.to_ascii_lowercase().contains("unlock")));
}

#[test]
fn unsafe_directory_lock_and_claim_observations_map_closed_and_preserve_objects() {
    let cases = [
        ("directory-mode", CellErrorCode::CellPermissionInvalid),
        ("lock-symlink", CellErrorCode::CellIdentityUncertain),
        ("lock-link", CellErrorCode::CellIdentityUncertain),
        ("claim-mode", CellErrorCode::CellPermissionInvalid),
        ("claim-length", CellErrorCode::CellCorrupt),
    ];
    for (case, expected) in cases {
        let (_current_pid, token) = context();
        let mut fake = FakeState::new();
        match case {
            "directory-mode" => fake.directory.mode = 0o755,
            "lock-symlink" => fake.lock.kind = ObjectKind::Symlink,
            "lock-link" => fake.lock.link_count = 2,
            "claim-mode" => {
                fake.claim_exists = true;
                fake.claim.mode = 0o644;
                fake.claim_bytes = vec![0; CLAIM_JOURNAL_LENGTH];
            }
            "claim-length" => {
                fake.claim_exists = true;
                fake.claim_bytes = vec![0; CLAIM_JOURNAL_LENGTH - 1];
            }
            _ => unreachable!(),
        }
        let state = Arc::new(Mutex::new(fake));
        assert!(matches!(open(&token, Arc::clone(&state), 1), Err(error) if error == expected));
        let state = state.lock().expect("fake state");
        assert!(!state.events.iter().any(|event| event == "unlinkat:claim"));
    }
}

#[test]
fn post_claim_failure_preserves_claim_and_tombstones_the_process_key() {
    let (_current_pid, token) = context();
    let mut fake = FakeState::new();
    fake.fail_event = Some("fsync:directory".to_string());
    let state = Arc::new(Mutex::new(fake));
    assert!(matches!(
        open(&token, Arc::clone(&state), 1),
        Err(CellErrorCode::CellIo)
    ));
    assert!(state.lock().expect("fake state").claim_exists);
    assert!(matches!(
        open(&token, Arc::clone(&state), 2),
        Err(CellErrorCode::CellClosed)
    ));
    let state = state.lock().expect("fake state");
    assert!(!state.events.iter().any(|event| event == "unlinkat:claim"));
}

#[test]
fn close_check_and_raw_close_fault_table_is_cached_and_tombstones_registry() {
    for (cut, expected) in [
        ("owner-open-registry-poison", CellErrorCode::CellClosed),
        ("owner-open-entry-missing", CellErrorCode::CellClosed),
        ("post-begin-close-gate", CellErrorCode::CellClosed),
        (
            "lock-identity-and-raw-close-lock",
            CellErrorCode::CellIdentityUncertain,
        ),
        ("read-claim", CellErrorCode::CellIo),
        ("raw-close-lock", CellErrorCode::CellIo),
    ] {
        let (_current_pid, token) = context();
        let state = Arc::new(Mutex::new(FakeState::new()));
        let mut owner = open(&token, Arc::clone(&state), 1).expect("owner");
        match cut {
            "owner-open-registry-poison" => poison_registry_for_test(&owner.lifecycle),
            "owner-open-entry-missing" => remove_registry_entry_for_test(&owner.lifecycle),
            "post-begin-close-gate" => {
                poison_registry_after_begin_close_for_test(&owner.lifecycle);
            }
            "lock-identity-and-raw-close-lock" => {
                let mut state = state.lock().expect("fake state");
                state.lock.identity.inode += 1;
                state.fail_event = Some("raw-close:lock".to_string());
            }
            "read-claim" => {
                state.lock().expect("fake state").fail_event =
                    Some("read:claim:offset-0:exact".to_string());
            }
            "raw-close-lock" => {
                state.lock().expect("fake state").fail_event = Some("raw-close:lock".to_string());
            }
            _ => unreachable!(),
        }
        let first = owner.close();
        assert_eq!(first, Err(expected), "{cut}");
        assert_eq!(owner.close(), first, "cached close result for {cut}");
        let before = state.lock().expect("fake state").events.len();
        assert!(matches!(
            open(&token, Arc::clone(&state), 2),
            Err(CellErrorCode::CellClosed)
        ));
        let state = state.lock().expect("fake state");
        let duplicate = &state.events[before..];
        assert!(!duplicate
            .iter()
            .any(|event| event.starts_with("open:lock:")));
        assert_eq!(
            state.close_counts.get(&FakeDescriptor::Claim),
            Some(&1),
            "{cut}"
        );
        assert_eq!(
            state.close_counts.get(&FakeDescriptor::Lock),
            Some(&1),
            "{cut}"
        );
        assert_eq!(
            state.close_counts.get(&FakeDescriptor::Directory(1)),
            Some(&1),
            "{cut}"
        );
        assert_eq!(state.claim_exists, cut != "raw-close-lock", "{cut}");
        assert_eq!(
            owner.lifecycle.check_operation(),
            Err(CellErrorCode::CellClosed),
            "{cut} tombstone"
        );
    }
}

#[test]
fn child_pid_cannot_use_or_cleanup_inherited_owner() {
    let (current_pid, token) = context();
    let state = Arc::new(Mutex::new(FakeState::new()));
    let mut owner = open(&token, Arc::clone(&state), 1).expect("owner");
    let before = state.lock().expect("fake state").events.len();
    current_pid.store(PID + 1, Ordering::Release);
    assert_eq!(owner.close(), Err(CellErrorCode::CellClosed));
    assert_eq!(owner.close(), Err(CellErrorCode::CellClosed));
    drop(owner);
    let state = state.lock().expect("fake state");
    assert_eq!(state.events.len(), before);
    assert!(state.claim_exists);
    assert!(state.close_counts.is_empty());
}

#[test]
fn failure_cut_close_counts_match_fixture_and_never_exceed_once() {
    let fixture = contract_json("platform-resource-cases.json");
    for (failure, failure_cut) in [
        ("fstat:directory", "before-registry-reservation"),
        (
            "open:lock:existing-rdwr-nofollow-cloexec",
            "after-registry-before-lock-descriptor",
        ),
        (
            "registry-poison-after-lock-open",
            "after-lock-descriptor-before-claim-descriptor",
        ),
        (
            "cloexec:lock",
            "after-lock-descriptor-before-claim-descriptor",
        ),
        ("write:claim:offset-0:fixed", "after-claim-descriptor"),
        ("fsync:claim", "after-claim-descriptor"),
    ] {
        let (_current_pid, token) = context();
        let mut fake = FakeState::new();
        if failure == "registry-poison-after-lock-open" {
            fake.poison_registry_on_event = Some((
                "open:lock:existing-rdwr-nofollow-cloexec".to_string(),
                registry_poison_flag_for_test(&token),
            ));
        } else {
            fake.fail_event = Some(failure.to_string());
        }
        let state = Arc::new(Mutex::new(fake));
        let result = open(&token, Arc::clone(&state), 1).map(|_| ());
        assert!(result.is_err(), "{failure}");
        let state_guard = state.lock().expect("fake state");
        assert_fixture_close_bounds(&state_guard, &fixture, failure_cut, 1);
        if failure == "registry-poison-after-lock-open" {
            assert_eq!(result, Err(CellErrorCode::CellClosed));
            assert_eq!(
                state_guard.close_counts.get(&FakeDescriptor::Lock),
                Some(&1)
            );
            assert_eq!(
                state_guard.close_counts.get(&FakeDescriptor::Directory(1)),
                Some(&1)
            );
            assert_eq!(state_guard.close_counts.get(&FakeDescriptor::Claim), None);
            let before = state_guard.events.len();
            drop(state_guard);
            assert_eq!(
                open(&token, Arc::clone(&state), 2).map(|_| ()),
                Err(CellErrorCode::CellClosed)
            );
            let state_guard = state.lock().expect("fake state");
            assert!(!state_guard.events[before..]
                .iter()
                .any(|event| event.starts_with("open:lock:")));
            for count in state_guard.close_counts.values() {
                assert!(*count <= 1, "{failure}: {state_guard:?}");
            }
        }
    }
}

#[test]
fn all_platform_error_codes_stay_inside_the_frozen_raw_union() {
    let fixture = contract_json("platform-resource-cases.json");
    let manifest = contract_json("manifest.json");
    let raw_codes = manifest["rawErrorUnion"]["codes"]
        .as_array()
        .expect("raw error codes")
        .iter()
        .map(|value| value.as_str().expect("raw error string"))
        .collect::<Vec<_>>();
    for case in fixture["errorMapping"]
        .as_array()
        .expect("platform error cases")
    {
        assert!(raw_codes.contains(&case["code"].as_str().expect("platform code")));
    }
    for code in [
        CellErrorCode::CellBusy,
        CellErrorCode::CellClosed,
        CellErrorCode::CellCorrupt,
        CellErrorCode::CellIdentityUncertain,
        CellErrorCode::CellIo,
        CellErrorCode::CellPermissionInvalid,
        CellErrorCode::CellDurabilityUnsupported,
        CellErrorCode::CellRecoveryRequired,
    ] {
        assert!(raw_codes.contains(&code.as_contract_code()));
    }
}

#[test]
fn credential_mutation_read_cases_and_exact_open_phase_gates_follow_fixture() {
    let fixture = contract_json("credential-mutation-cases-v1.json");
    let cases = fixture["readCases"].as_array().expect("read cases");
    assert_eq!(cases.len(), 8);

    for case in cases {
        let name = case["name"].as_str().expect("read case name");
        let (_current_pid, token) = context();
        let mut fake = FakeState::new();
        match name {
            "initial-enoent-is-absent" => {}
            "safe-present-is-read-and-bound" => set_present_credential(&mut fake, &[1, 2, 3]),
            "non-enoent-lookup-error-is-not-absent" => {
                fake.credential_lookup_error = true;
            }
            "post-present-enoent-is-an-identity-race" => {
                set_present_credential(&mut fake, &[1]);
                fake.credential_open_not_found = true;
            }
            "present-type-link-or-stable-identity-failure-fences" => {
                set_present_credential(&mut fake, &[1]);
                fake.credential.link_count = 2;
            }
            "present-owner-or-mode-invalid-fences" => {
                set_present_credential(&mut fake, &[1]);
                fake.credential.mode = 0o640;
            }
            "present-size-over-limit-fences" => {
                set_present_credential(&mut fake, &vec![0x5a; CREDENTIAL_MAXIMUM_BYTES + 1]);
            }
            "read-descriptor-close-failure-does-not-issue-revision" => {
                set_present_credential(&mut fake, &[1]);
                fake.fail_event = Some("raw-close:credential".to_string());
            }
            _ => panic!("unknown read fixture case {name}"),
        }
        let state = Arc::new(Mutex::new(fake));
        let mut owner = open(&token, Arc::clone(&state), 1).expect("admission owner");
        let result = owner.read();
        if let Some(expected) = case["expectedState"].as_str() {
            let current = result.unwrap_or_else(|error| panic!("{name}: {error:?}"));
            assert_eq!(current_state(&current), expected, "{name}");
            assert!(case["revisionIssued"].as_bool().expect("revision issued"));
        } else {
            let expected = contract_error(case["errorCode"].as_str().expect("read error"));
            assert!(matches!(result, Err(error) if error == expected), "{name}");
        }
        let fenced = case["fenced"].as_bool().expect("fenced");
        if fenced {
            assert_eq!(
                owner.read().map(|_| ()),
                Err(CellErrorCode::CellClosed),
                "{name}"
            );
            assert_eq!(
                owner.close(),
                Err(CellErrorCode::CellRecoveryRequired),
                "{name}"
            );
            assert!(state.lock().expect("fake state").claim_exists, "{name}");
        } else {
            assert_eq!(owner.close(), Ok(()), "{name}");
        }
        let state = state.lock().expect("fake state");
        assert!(
            state
                .close_counts
                .get(&FakeDescriptor::Credential)
                .copied()
                .unwrap_or(0)
                <= 1,
            "{name}: {state:?}"
        );
    }

    let phases = fixture["phaseRevalidation"]["phases"]
        .as_array()
        .expect("phase list");
    assert_eq!(
        phases[..5]
            .iter()
            .map(Value::as_str)
            .collect::<Option<Vec<_>>>(),
        Some(vec![
            "read-before-credential-observation",
            "read-after-open-before-A-proof",
            "read-after-bytes-before-B-proof",
            "read-before-C-proof",
            "read-before-close-and-revision-issue",
        ])
    );
    for (index, phase) in phases[..5].iter().enumerate() {
        let (_current_pid, token) = context();
        let mut fake = FakeState::new();
        set_present_credential(&mut fake, &[1, 2, 3]);
        let state = Arc::new(Mutex::new(fake));
        let mut owner = open(&token, Arc::clone(&state), 1).expect("phase owner");
        let poison = registry_poison_flag_for_test(&token);
        state
            .lock()
            .expect("fake state")
            .poison_registry_after_claim_read = Some((index + 1, poison));
        assert_eq!(
            owner.read().map(|_| ()),
            Err(CellErrorCode::CellClosed),
            "{}",
            phase.as_str().expect("phase")
        );
        assert_eq!(
            state.lock().expect("fake state").claim_read_count,
            index + 1,
            "{}",
            phase.as_str().expect("phase")
        );
        assert_eq!(owner.close(), Err(CellErrorCode::CellRecoveryRequired));
        let state = state.lock().expect("fake state");
        assert!(state.claim_exists);
        for descriptor in [
            FakeDescriptor::Credential,
            FakeDescriptor::Claim,
            FakeDescriptor::Lock,
            FakeDescriptor::Directory(1),
        ] {
            assert!(state.close_counts.get(&descriptor).copied().unwrap_or(0) <= 1);
        }
    }
}

#[test]
fn credential_mutation_cas_cases_revisions_gates_and_publication_follow_fixture() {
    let fixture = contract_json("credential-mutation-cases-v1.json");
    let cases = fixture["compareAndSwapCases"]
        .as_array()
        .expect("compare-and-swap cases");
    assert_eq!(cases.len(), 12);
    let replacement = [7_u8, 8, 9];

    for case in cases {
        let name = case["name"].as_str().expect("CAS case name");
        let (_current_pid, token) = context();
        let state = Arc::new(Mutex::new(FakeState::new()));
        let mut owner = open(&token, Arc::clone(&state), 1).expect("admission owner");
        let revision = revision_from(owner.read().expect("initial revision"));
        let revision = if name == "invalid-revision-stops-before-current-check" {
            let _new_current = owner.read().expect("replacement revision");
            revision
        } else {
            revision
        };
        {
            let mut fake = state.lock().expect("fake state");
            reset_mutation_observation(&mut fake);
            match name {
                "invalid-revision-stops-before-current-check" => {}
                "first-current-mismatch-conflicts-before-temp" => {
                    set_present_credential(&mut fake, &[4]);
                }
                "eight-temp-name-collisions-exhaust" => {
                    fake.temporary_collisions_remaining = TEMPORARY_CREATE_ATTEMPTS;
                }
                "second-current-mismatch-cleans-owned-temp-then-conflicts" => {
                    fake.change_credential_on_lookup = Some(2);
                }
                "precommit-cleanup-identity-mismatch-fences" => {
                    fake.change_credential_on_lookup = Some(2);
                    fake.temporary_path_identity_mismatch_on_lookup = Some(3);
                }
                "precommit-cleanup-durability-uncertain-fences" => {
                    fake.change_credential_on_lookup = Some(2);
                    fake.fail_event = Some("fsync:directory".to_string());
                }
                "rename-error-with-old-and-temp-proof-is-definite" => {
                    fake.rename = FakeRename::ErrorNoCommit;
                }
                "rename-error-without-old-value-proof-is-uncertain" => {
                    fake.rename = FakeRename::ErrorAfterCommit;
                }
                "post-rename-published-proof-failure-is-uncertain" => {
                    fake.rename = FakeRename::SucceedWithPublishedIdentityMismatch;
                }
                "post-rename-directory-fsync-failure-is-uncertain" => {
                    fake.fail_event = Some("fsync:directory".to_string());
                }
                "post-rename-close-failure-is-uncertain" => {
                    fake.fail_event = Some("raw-close:temporary".to_string());
                }
                "complete-publication-swaps" => {}
                _ => panic!("unknown CAS fixture case {name}"),
            }
        }

        let result = owner.compare_and_swap(revision, &replacement);
        match case["expectedOutcome"].as_str().expect("expected outcome") {
            "error" => {
                let expected = contract_error(case["errorCode"].as_str().expect("CAS error"));
                assert!(matches!(result, Err(error) if error == expected), "{name}");
            }
            "conflict" => {
                let conflict = match result.unwrap_or_else(|error| panic!("{name}: {error:?}")) {
                    CredentialCompareAndSwapOutcome::Conflict(current) => current,
                    other => panic!("{name}: {other:?}"),
                };
                assert!(case["freshRevisionIssued"]
                    .as_bool()
                    .expect("fresh revision"));
                if name == "first-current-mismatch-conflicts-before-temp" {
                    let fresh = revision_from(conflict);
                    assert!(matches!(
                        owner.compare_and_swap(fresh, &replacement),
                        Ok(CredentialCompareAndSwapOutcome::Swapped)
                    ));
                }
            }
            "uncertain" => assert!(
                matches!(result, Ok(CredentialCompareAndSwapOutcome::Uncertain)),
                "{name}"
            ),
            "swapped" => assert!(
                matches!(result, Ok(CredentialCompareAndSwapOutcome::Swapped)),
                "{name}"
            ),
            other => panic!("unknown expected CAS outcome {other}"),
        }

        let fenced = case["fenced"].as_bool().expect("CAS fenced");
        if fenced {
            assert_eq!(
                owner.read().map(|_| ()),
                Err(CellErrorCode::CellClosed),
                "{name}"
            );
            assert_eq!(
                owner.close(),
                Err(CellErrorCode::CellRecoveryRequired),
                "{name}"
            );
        } else {
            assert_eq!(owner.close(), Ok(()), "{name}");
        }
        let fake = state.lock().expect("fake state");
        if name == "invalid-revision-stops-before-current-check" {
            assert_eq!(fake.credential_lookup_count, 0);
            assert_eq!(fake.temporary_create_count, 0);
        }
        if name == "eight-temp-name-collisions-exhaust" {
            assert_eq!(fake.temporary_create_count, TEMPORARY_CREATE_ATTEMPTS);
            let names = fake
                .events
                .iter()
                .filter_map(|event| {
                    event
                        .strip_prefix("open:temporary:")
                        .and_then(|value| value.strip_suffix(":exclusive-0600"))
                })
                .collect::<Vec<_>>();
            assert_eq!(names.len(), TEMPORARY_CREATE_ATTEMPTS);
            assert_eq!(
                names
                    .iter()
                    .copied()
                    .collect::<std::collections::HashSet<_>>()
                    .len(),
                names.len()
            );
            assert!(names.iter().all(|name| {
                name.starts_with(TEMPORARY_PREFIX)
                    && name.len() == TEMPORARY_PREFIX.len() + TEMPORARY_ENTROPY_BYTES * 2
                    && name[TEMPORARY_PREFIX.len()..]
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            }));
            assert!(!fake
                .events
                .iter()
                .any(|event| event.starts_with("unlinkat:temporary:")));
        }
        if name == "complete-publication-swaps" {
            assert_eq!(
                fake.credential_lookup_count, 3,
                "two current checks plus published proof"
            );
            assert_eq!(fake.credential_bytes, replacement);
        }
        if fenced {
            assert!(fake.claim_exists, "{name}");
        }
    }

    let (_current_pid, token) = context();
    let owner_a_state = Arc::new(Mutex::new(FakeState::new()));
    let mut owner_b_fake = FakeState::new();
    owner_b_fake.directory.identity.inode += 100;
    let owner_b_state = Arc::new(Mutex::new(owner_b_fake));
    let mut owner_a = open(&token, Arc::clone(&owner_a_state), 1).expect("live owner A");
    let mut owner_b = open(&token, owner_b_state, 2).expect("live owner B");
    let owner_a_revision = revision_from(owner_a.read().expect("owner A revision"));
    let owner_b_revision = revision_from(owner_b.read().expect("owner B revision"));
    reset_mutation_observation(&mut owner_a_state.lock().expect("owner A state"));
    assert_eq!(
        owner_a
            .compare_and_swap(owner_b_revision, &replacement)
            .map(|_| ()),
        Err(CellErrorCode::InvalidRevision)
    );
    {
        let owner_a_state = owner_a_state.lock().expect("owner A state");
        assert_eq!(owner_a_state.credential_lookup_count, 0);
        assert_eq!(owner_a_state.temporary_create_count, 0);
    }
    assert!(matches!(
        owner_a.compare_and_swap(owner_a_revision, &replacement),
        Ok(CredentialCompareAndSwapOutcome::Swapped)
    ));
    owner_a.close().expect("owner A close");
    owner_b.close().expect("owner B close");

    let (_current_pid, token) = context();
    let state = Arc::new(Mutex::new(FakeState::new()));
    let mut owner = open(&token, Arc::clone(&state), 1).expect("collision gate owner");
    let revision = revision_from(owner.read().expect("collision gate revision"));
    let poison = registry_poison_flag_for_test(&token);
    {
        let mut fake = state.lock().expect("fake state");
        reset_mutation_observation(&mut fake);
        fake.temporary_collisions_remaining = 1;
        fake.poison_registry_after_temporary_collision = Some(poison);
    }
    assert_eq!(
        owner.compare_and_swap(revision, &replacement).map(|_| ()),
        Err(CellErrorCode::CellClosed),
        "collision successor attempt must stop at its full owner gate"
    );
    assert_eq!(owner.read().map(|_| ()), Err(CellErrorCode::CellClosed));
    assert_eq!(owner.close(), Err(CellErrorCode::CellRecoveryRequired));
    {
        let fake = state.lock().expect("fake state");
        assert_eq!(fake.temporary_create_count, 1);
        assert!(!fake.temporary_exists);
        assert!(!fake
            .events
            .iter()
            .any(|event| event.starts_with("unlinkat:temporary:")));
        assert!(fake.claim_exists);
    }

    let (_current_pid, token) = context();
    let mut same_fake = FakeState::new();
    set_present_credential(&mut same_fake, &replacement);
    let same_state = Arc::new(Mutex::new(same_fake));
    let mut same_owner = open(&token, Arc::clone(&same_state), 1).expect("same-bytes owner");
    let same_revision = revision_from(same_owner.read().expect("same-bytes revision"));
    reset_mutation_observation(&mut same_state.lock().expect("fake state"));
    assert!(matches!(
        same_owner.compare_and_swap(same_revision, &replacement),
        Ok(CredentialCompareAndSwapOutcome::Swapped)
    ));
    assert!(same_state
        .lock()
        .expect("fake state")
        .events
        .iter()
        .any(|event| event.starts_with("renameat:")));
    same_owner.close().expect("same-bytes close");

    let phases = fixture["phaseRevalidation"]["phases"]
        .as_array()
        .expect("phase list");
    let cas_phases = &phases[5..16];
    assert_eq!(cas_phases.len(), 11);
    for (index, phase) in cas_phases.iter().enumerate() {
        let (_current_pid, token) = context();
        let state = Arc::new(Mutex::new(FakeState::new()));
        let mut owner = open(&token, Arc::clone(&state), 1).expect("CAS phase owner");
        let revision = revision_from(owner.read().expect("CAS phase revision"));
        let poison = registry_poison_flag_for_test(&token);
        {
            let mut fake = state.lock().expect("fake state");
            reset_mutation_observation(&mut fake);
            fake.poison_registry_after_claim_read = Some((index + 1, poison));
        }
        let result = owner.compare_and_swap(revision, &replacement);
        assert!(
            !matches!(result, Ok(CredentialCompareAndSwapOutcome::Swapped)),
            "{}",
            phase.as_str().expect("phase")
        );
        assert_eq!(owner.read().map(|_| ()), Err(CellErrorCode::CellClosed));
        assert_eq!(owner.close(), Err(CellErrorCode::CellRecoveryRequired));
        let fake = state.lock().expect("fake state");
        assert_eq!(
            fake.claim_read_count,
            index + 1,
            "{}",
            phase.as_str().expect("phase")
        );
        assert!(fake.claim_exists);
    }

    let cleanup_phase = phases[16].as_str().expect("cleanup phase");
    assert_eq!(cleanup_phase, "precommit-cleanup");
    let (_current_pid, token) = context();
    let state = Arc::new(Mutex::new(FakeState::new()));
    let mut owner = open(&token, Arc::clone(&state), 1).expect("cleanup phase owner");
    let revision = revision_from(owner.read().expect("cleanup phase revision"));
    let poison = registry_poison_flag_for_test(&token);
    {
        let mut fake = state.lock().expect("fake state");
        reset_mutation_observation(&mut fake);
        fake.change_credential_on_lookup = Some(2);
        fake.poison_registry_after_claim_read = Some((8, poison));
    }
    assert_eq!(
        owner.compare_and_swap(revision, &replacement).map(|_| ()),
        Err(CellErrorCode::CellRecoveryRequired),
        "{cleanup_phase}"
    );
    assert_eq!(owner.close(), Err(CellErrorCode::CellRecoveryRequired));
    let fake = state.lock().expect("fake state");
    assert!(fake.temporary_exists);
    assert!(!fake
        .events
        .iter()
        .any(|event| event.starts_with("unlinkat:temporary:")));
}

#[test]
fn credential_mutation_recovery_cases_fence_and_preserve_owned_artifacts() {
    let fixture = contract_json("credential-mutation-cases-v1.json");
    let recovery = fixture["recoveryCases"].as_array().expect("recovery cases");
    assert_eq!(recovery.len(), 2);
    assert_eq!(
        recovery[0]["name"].as_str(),
        Some("existing-admission-claim-remains-recovery-required")
    );
    assert_eq!(
        recovery[1]["name"].as_str(),
        Some("known-leftover-temp-remains-recovery-required")
    );

    let (_current_pid, token) = context();
    let mut existing = FakeState::new();
    existing.claim_exists = true;
    existing.claim_bytes = vec![0x5a; CLAIM_JOURNAL_LENGTH];
    let existing_state = Arc::new(Mutex::new(existing));
    assert_eq!(
        open(&token, Arc::clone(&existing_state), 1).map(|_| ()),
        Err(contract_error(
            recovery[0]["expectedErrorCode"]
                .as_str()
                .expect("existing claim error")
        ))
    );
    let existing = existing_state.lock().expect("fake state");
    assert!(existing.claim_exists);
    assert!(!existing
        .events
        .iter()
        .any(|event| event == "unlinkat:claim"));
    assert_eq!(existing.close_counts.get(&FakeDescriptor::Lock), Some(&1));
    assert_eq!(
        existing.close_counts.get(&FakeDescriptor::Directory(1)),
        Some(&1)
    );
    drop(existing);

    let (_current_pid, token) = context();
    let state = Arc::new(Mutex::new(FakeState::new()));
    let mut owner = open(&token, Arc::clone(&state), 1).expect("recovery owner");
    let revision = revision_from(owner.read().expect("recovery revision"));
    {
        let mut fake = state.lock().expect("fake state");
        reset_mutation_observation(&mut fake);
        fake.change_credential_on_lookup = Some(2);
        fake.temporary_unlink_failure = true;
    }
    assert_eq!(
        owner.compare_and_swap(revision, &[4, 5, 6]).map(|_| ()),
        Err(contract_error(
            recovery[1]["expectedErrorCode"]
                .as_str()
                .expect("known temp error")
        ))
    );
    assert_eq!(owner.read().map(|_| ()), Err(CellErrorCode::CellClosed));

    let first_close = owner.close();
    assert_eq!(first_close, Err(CellErrorCode::CellRecoveryRequired));
    assert_eq!(owner.close(), first_close);
    let fake = state.lock().expect("fake state");
    assert!(fake.claim_exists);
    assert!(fake.temporary_exists);
    assert!(!fake.events.iter().any(|event| event == "unlinkat:claim"));
    for descriptor in [
        FakeDescriptor::Temporary,
        FakeDescriptor::Claim,
        FakeDescriptor::Lock,
        FakeDescriptor::Directory(1),
    ] {
        assert_eq!(
            fake.close_counts.get(&descriptor).copied().unwrap_or(0),
            1,
            "{descriptor:?}: {fake:?}"
        );
    }
}
