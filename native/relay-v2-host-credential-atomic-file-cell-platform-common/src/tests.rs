use super::*;
use crate::claim_journal::ClaimJournal;
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
        let state = self.state.lock().expect("fake state");
        if state.claim_bytes.len() != output.len() {
            return Err(PlatformFailure::Io);
        }
        output.copy_from_slice(&state.claim_bytes);
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
        if state.fail_event.as_deref() == Some(event.as_str()) {
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
    }
}

fn resource_name(resource: RelativeResource) -> &'static str {
    match resource {
        RelativeResource::Lock => "lock",
        RelativeResource::Claim => "claim",
    }
}

fn claim_id() -> ClaimId {
    let mut bytes = [0_u8; CLAIM_ID_LENGTH];
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte = index as u8;
    }
    ClaimId::from_bytes(bytes).expect("claim id")
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
        claim_id(),
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
        _ => panic!("unknown contract fixture {name}"),
    };
    serde_json::from_str(source).expect("parse contract JSON")
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
    assert_eq!(ClaimJournal::decode(&encoded), Ok(journal));

    for offset in [0, 8, 12, 16, 20, 116, 160, 191] {
        let mut corrupt = encoded;
        corrupt[offset] ^= 0x01;
        assert_eq!(
            ClaimJournal::decode(&corrupt),
            Err(CellErrorCode::CellCorrupt),
            "offset {offset}"
        );
    }
    assert_eq!(
        ClaimJournal::decode(&encoded[..encoded.len() - 1]),
        Err(CellErrorCode::CellCorrupt)
    );
}

#[test]
fn production_qualification_is_empty_and_resources_are_host_specific() {
    assert!(matches!(
        production_durability_qualification(),
        Err(CellErrorCode::CellDurabilityUnsupported)
    ));
    let spec = platform_resource_spec();
    assert_eq!(spec.contract_revision(), 2);
    assert_eq!(spec.resource_contract_version(), 1);
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
