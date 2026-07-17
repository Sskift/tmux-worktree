use super::*;
use crate::sys::{AclEntry, AclPrincipal};
use relay_v2_broker_credential_state_store_platform_common::{
    initialize_process_lifecycle, ProcessBoundPublishOutcome,
};
use std::collections::BTreeMap;
use std::ffi::{CStr, OsString};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

const ROOT_FD: RawFd = 10;
const USERS_FD: RawFd = 11;
const HOME_FD: RawFd = 12;
const PRIVATE_FD: RawFd = 13;
const CONTAINER_FD: RawFd = 14;

static NEXT_HOME_INODE: AtomicU64 = AtomicU64::new(10_000);

#[derive(Clone, Debug, PartialEq, Eq)]
enum Event {
    Credentials,
    AccountHome(u32),
    OpenRoot(i32),
    OpenAt {
        parent: RawFd,
        component: Vec<u8>,
        flags: i32,
        mode: u32,
    },
    MkdirAt {
        parent: RawFd,
        component: Vec<u8>,
        mode: u32,
    },
    Chmod(RawFd, u32),
    Truncate(RawFd, u64),
    Stat(RawFd),
    StatAt {
        parent: RawFd,
        component: Vec<u8>,
    },
    DurabilityProbe(RawFd),
    GetFdFlags(RawFd),
    SetLock(RawFd, LockRequest),
    Pread {
        fd: RawFd,
        offset: u64,
        requested: usize,
    },
    Pwrite {
        fd: RawFd,
        offset: u64,
        requested: usize,
    },
    FullSync(RawFd),
    Sync(RawFd),
    SyncVolume(RawFd, i32),
    Close(RawFd),
}

#[derive(Clone, Copy)]
enum ContainerPreflight {
    Missing,
    Metadata(FileMetadata),
}

struct FakeState {
    events: Vec<Event>,
    credentials: Credentials,
    account_home: OsString,
    home_inode: u64,
    private_exists: bool,
    container_preflight: ContainerPreflight,
    container_exists: bool,
    container_mode: u32,
    container_size: u64,
    bytes: BTreeMap<u64, u8>,
    acl: Vec<AclEntry>,
    inject_pread_eintr: bool,
    inject_pread_short: bool,
    inject_pwrite_eintr: bool,
    inject_pwrite_short: bool,
    inject_durability_probe_error: bool,
    fail_stat_fd: Option<RawFd>,
    fail_acl_fd: Option<RawFd>,
    invalid_acl_fd: Option<RawFd>,
    forced_private_mode: Option<u32>,
}

struct FakeSyscalls {
    state: Mutex<FakeState>,
}

impl FakeSyscalls {
    fn new(private_exists: bool, container_preflight: ContainerPreflight) -> Arc<Self> {
        let home_inode = NEXT_HOME_INODE.fetch_add(1, Ordering::Relaxed);
        Arc::new(Self {
            state: Mutex::new(FakeState {
                events: Vec::new(),
                credentials: Credentials {
                    real_uid: 501,
                    effective_uid: 501,
                    real_gid: 20,
                    effective_gid: 20,
                },
                account_home: OsString::from("/Users/alice"),
                home_inode,
                private_exists,
                container_preflight,
                container_exists: !matches!(container_preflight, ContainerPreflight::Missing),
                container_mode: u32::from(libc::S_IFREG) | 0o600,
                container_size: container_spec().file_length(),
                bytes: BTreeMap::new(),
                acl: Vec::new(),
                inject_pread_eintr: false,
                inject_pread_short: false,
                inject_pwrite_eintr: false,
                inject_pwrite_short: false,
                inject_durability_probe_error: false,
                fail_stat_fd: None,
                fail_acl_fd: None,
                invalid_acl_fd: None,
                forced_private_mode: None,
            }),
        })
    }

    fn events(&self) -> Vec<Event> {
        self.state.lock().expect("fake state").events.clone()
    }

    fn clear_events(&self) {
        self.state.lock().expect("fake state").events.clear();
    }

    fn set_credentials(&self, credentials: Credentials) {
        self.state.lock().expect("fake state").credentials = credentials;
    }

    fn set_account_home(&self, path: &str) {
        self.state.lock().expect("fake state").account_home = OsString::from(path);
    }

    fn inject_short_and_interrupted_io(&self) {
        let mut state = self.state.lock().expect("fake state");
        state.inject_pread_eintr = true;
        state.inject_pread_short = true;
        state.inject_pwrite_eintr = true;
        state.inject_pwrite_short = true;
    }

    fn inject_durability_probe_error(&self) {
        self.state
            .lock()
            .expect("fake state")
            .inject_durability_probe_error = true;
    }

    fn fail_stat_for(&self, fd: RawFd) {
        self.state.lock().expect("fake state").fail_stat_fd = Some(fd);
    }

    fn fail_acl_for(&self, fd: RawFd) {
        self.state.lock().expect("fake state").fail_acl_fd = Some(fd);
    }

    fn invalidate_acl_for(&self, fd: RawFd) {
        self.state.lock().expect("fake state").invalid_acl_fd = Some(fd);
    }

    fn force_private_mode(&self, mode: u32) {
        self.state.lock().expect("fake state").forced_private_mode = Some(mode);
    }

    fn make_existing_valid(&self) {
        let mut state = self.state.lock().expect("fake state");
        let metadata = FileMetadata {
            device: 1,
            inode: state.home_inode + 2,
            mode: u32::from(libc::S_IFREG) | 0o600,
            uid: 501,
            gid: 20,
            nlink: 1,
            size: container_spec().file_length(),
        };
        state.container_preflight = ContainerPreflight::Metadata(metadata);
        state.container_exists = true;
        state.container_mode = metadata.mode;
        state.container_size = metadata.size;
    }

    fn private_component() -> Vec<u8> {
        container_spec().relative_components()[0]
            .as_bytes()
            .to_vec()
    }

    fn leaf_component() -> Vec<u8> {
        container_spec()
            .relative_components()
            .last()
            .expect("manifest leaf")
            .as_bytes()
            .to_vec()
    }

    fn directory_metadata(fd: RawFd, state: &FakeState) -> FileMetadata {
        match fd {
            ROOT_FD => metadata(1, 1, libc::S_IFDIR, 0o755, 0, 0, 0),
            USERS_FD => metadata(1, 2, libc::S_IFDIR, 0o755, 0, 0, 0),
            HOME_FD => metadata(1, state.home_inode, libc::S_IFDIR, 0o755, 501, 20, 0),
            PRIVATE_FD => metadata(
                1,
                state.home_inode + 1,
                libc::S_IFDIR,
                state.forced_private_mode.unwrap_or(0o700),
                501,
                20,
                0,
            ),
            _ => panic!("unexpected directory fd {fd}"),
        }
    }
}

impl DarwinSyscalls for FakeSyscalls {
    fn credentials(&self) -> Credentials {
        let mut state = self.state.lock().expect("fake state");
        state.events.push(Event::Credentials);
        state.credentials
    }

    fn account_home(&self, uid: u32) -> Result<OsString, PlatformStoreFailure> {
        let mut state = self.state.lock().expect("fake state");
        state.events.push(Event::AccountHome(uid));
        Ok(state.account_home.clone())
    }

    fn open_root(&self, flags: i32) -> Result<RawFd, SyscallError> {
        self.state
            .lock()
            .expect("fake state")
            .events
            .push(Event::OpenRoot(flags));
        Ok(ROOT_FD)
    }

    fn open_at(
        &self,
        parent: RawFd,
        component: &CStr,
        flags: i32,
        mode: u32,
    ) -> Result<RawFd, SyscallError> {
        let component = component.to_bytes().to_vec();
        let mut state = self.state.lock().expect("fake state");
        state.events.push(Event::OpenAt {
            parent,
            component: component.clone(),
            flags,
            mode,
        });
        match (parent, component.as_slice()) {
            (ROOT_FD, b"Users") => Ok(USERS_FD),
            (USERS_FD, b"alice") => Ok(HOME_FD),
            (HOME_FD, value) if value == Self::private_component() => {
                if state.private_exists {
                    Ok(PRIVATE_FD)
                } else {
                    Err(SyscallError(libc::ENOENT))
                }
            }
            (PRIVATE_FD, value) if value == Self::leaf_component() => {
                if flags == CREATE_CONTAINER_OPEN_FLAGS {
                    if state.container_exists {
                        Err(SyscallError(libc::EEXIST))
                    } else {
                        state.container_exists = true;
                        state.container_mode = u32::from(libc::S_IFREG) | 0o600;
                        state.container_size = 0;
                        Ok(CONTAINER_FD)
                    }
                } else if state.container_exists {
                    Ok(CONTAINER_FD)
                } else {
                    Err(SyscallError(libc::ENOENT))
                }
            }
            _ => Err(SyscallError(libc::ENOENT)),
        }
    }

    fn mkdir_at(&self, parent: RawFd, component: &CStr, mode: u32) -> Result<(), SyscallError> {
        let component = component.to_bytes().to_vec();
        let mut state = self.state.lock().expect("fake state");
        state.events.push(Event::MkdirAt {
            parent,
            component: component.clone(),
            mode,
        });
        if parent == HOME_FD && component == Self::private_component() && !state.private_exists {
            state.private_exists = true;
            Ok(())
        } else {
            Err(SyscallError(libc::EEXIST))
        }
    }

    fn stat(&self, fd: RawFd) -> Result<FileMetadata, SyscallError> {
        let mut state = self.state.lock().expect("fake state");
        state.events.push(Event::Stat(fd));
        if state.fail_stat_fd == Some(fd) {
            return Err(SyscallError(libc::EIO));
        }
        if fd == CONTAINER_FD {
            Ok(FileMetadata {
                device: 1,
                inode: state.home_inode + 2,
                mode: state.container_mode,
                uid: 501,
                gid: 20,
                nlink: 1,
                size: state.container_size,
            })
        } else {
            Ok(Self::directory_metadata(fd, &state))
        }
    }

    fn stat_at(
        &self,
        parent: RawFd,
        component: &CStr,
        flags: i32,
    ) -> Result<FileMetadata, SyscallError> {
        assert_eq!(flags, libc::AT_SYMLINK_NOFOLLOW);
        let component = component.to_bytes();
        let mut state = self.state.lock().expect("fake state");
        state.events.push(Event::StatAt {
            parent,
            component: component.to_vec(),
        });
        match (parent, component) {
            (ROOT_FD, b"Users") => Ok(Self::directory_metadata(USERS_FD, &state)),
            (USERS_FD, b"alice") => Ok(Self::directory_metadata(HOME_FD, &state)),
            (HOME_FD, value) if value == Self::private_component() => {
                if state.private_exists {
                    Ok(Self::directory_metadata(PRIVATE_FD, &state))
                } else {
                    Err(SyscallError(libc::ENOENT))
                }
            }
            (PRIVATE_FD, value) if value == Self::leaf_component() => {
                if state.container_exists {
                    Ok(match state.container_preflight {
                        ContainerPreflight::Metadata(metadata)
                            if state.container_size == container_spec().file_length() =>
                        {
                            metadata
                        }
                        _ => FileMetadata {
                            device: 1,
                            inode: state.home_inode + 2,
                            mode: state.container_mode,
                            uid: 501,
                            gid: 20,
                            nlink: 1,
                            size: state.container_size,
                        },
                    })
                } else {
                    Err(SyscallError(libc::ENOENT))
                }
            }
            _ => Err(SyscallError(libc::ENOENT)),
        }
    }

    fn acl(&self, fd: RawFd) -> Result<Vec<AclEntry>, PlatformStoreFailure> {
        let state = self.state.lock().expect("fake state");
        if state.fail_acl_fd == Some(fd) {
            return Err(PlatformStoreFailure::Io);
        }
        if state.invalid_acl_fd == Some(fd) {
            return Ok(vec![AclEntry {
                allow: true,
                principal: AclPrincipal::Unknown,
                permissions: 1 << 2,
                flags: 0,
            }]);
        }
        Ok(state.acl.clone())
    }

    fn durability_evidence(&self, fd: RawFd) -> Result<DurabilityEvidence, SyscallError> {
        let mut state = self.state.lock().expect("fake state");
        state.events.push(Event::DurabilityProbe(fd));
        if state.inject_durability_probe_error {
            return Err(SyscallError(libc::EIO));
        }
        Ok(DurabilityEvidence {
            filesystem_name: b"fakefs".to_vec(),
            mount_flags: 0,
            source_name: b"fake-device".to_vec(),
        })
    }

    fn chmod(&self, fd: RawFd, mode: u32) -> Result<(), SyscallError> {
        let mut state = self.state.lock().expect("fake state");
        state.events.push(Event::Chmod(fd, mode));
        if fd == CONTAINER_FD {
            state.container_mode = u32::from(libc::S_IFREG) | mode;
        }
        Ok(())
    }

    fn truncate(&self, fd: RawFd, length: u64) -> Result<(), SyscallError> {
        let mut state = self.state.lock().expect("fake state");
        state.events.push(Event::Truncate(fd, length));
        state.container_size = length;
        state.bytes.retain(|offset, _| *offset < length);
        Ok(())
    }

    fn get_fd_flags(&self, fd: RawFd) -> Result<i32, SyscallError> {
        self.state
            .lock()
            .expect("fake state")
            .events
            .push(Event::GetFdFlags(fd));
        Ok(libc::FD_CLOEXEC)
    }

    fn set_lock(&self, fd: RawFd, request: LockRequest) -> Result<(), SyscallError> {
        self.state
            .lock()
            .expect("fake state")
            .events
            .push(Event::SetLock(fd, request));
        Ok(())
    }

    fn pread(&self, fd: RawFd, output: &mut [u8], offset: u64) -> Result<usize, SyscallError> {
        let mut state = self.state.lock().expect("fake state");
        state.events.push(Event::Pread {
            fd,
            offset,
            requested: output.len(),
        });
        if state.inject_pread_eintr {
            state.inject_pread_eintr = false;
            return Err(SyscallError(libc::EINTR));
        }
        let count = if state.inject_pread_short && output.len() > 1 {
            state.inject_pread_short = false;
            output.len() / 2
        } else {
            output.len()
        };
        output[..count].fill(0);
        let end = offset + count as u64;
        for (&position, &byte) in state.bytes.range(offset..end) {
            output[(position - offset) as usize] = byte;
        }
        Ok(count)
    }

    fn pwrite(&self, fd: RawFd, bytes: &[u8], offset: u64) -> Result<usize, SyscallError> {
        let mut state = self.state.lock().expect("fake state");
        state.events.push(Event::Pwrite {
            fd,
            offset,
            requested: bytes.len(),
        });
        if state.inject_pwrite_eintr {
            state.inject_pwrite_eintr = false;
            return Err(SyscallError(libc::EINTR));
        }
        let count = if state.inject_pwrite_short && bytes.len() > 1 {
            state.inject_pwrite_short = false;
            2.min(bytes.len())
        } else {
            bytes.len()
        };
        for (index, byte) in bytes[..count].iter().copied().enumerate() {
            let position = offset + index as u64;
            if byte == 0 {
                state.bytes.remove(&position);
            } else {
                state.bytes.insert(position, byte);
            }
        }
        Ok(count)
    }

    fn full_sync(&self, fd: RawFd) -> Result<(), SyscallError> {
        self.state
            .lock()
            .expect("fake state")
            .events
            .push(Event::FullSync(fd));
        Ok(())
    }

    fn sync(&self, fd: RawFd) -> Result<(), SyscallError> {
        self.state
            .lock()
            .expect("fake state")
            .events
            .push(Event::Sync(fd));
        Ok(())
    }

    fn sync_volume(&self, fd: RawFd, flags: i32) -> Result<(), SyscallError> {
        self.state
            .lock()
            .expect("fake state")
            .events
            .push(Event::SyncVolume(fd, flags));
        Ok(())
    }

    fn close(&self, fd: RawFd) -> Result<(), SyscallError> {
        self.state
            .lock()
            .expect("fake state")
            .events
            .push(Event::Close(fd));
        Ok(())
    }
}

fn metadata(
    device: u64,
    inode: u64,
    file_type: libc::mode_t,
    mode: u32,
    uid: u32,
    gid: u32,
    size: u64,
) -> FileMetadata {
    FileMetadata {
        device,
        inode,
        mode: u32::from(file_type) | mode,
        uid,
        gid,
        nlink: 1,
        size,
    }
}

fn open_test_store(
    fake: Arc<FakeSyscalls>,
) -> Result<ProcessBoundStateStore<DarwinContainer<FakeSyscalls>>, NativeStoreErrorCode> {
    let lifecycle = initialize_process_lifecycle().expect("process lifecycle");
    open_with(
        &lifecycle,
        Path::new("/Users/alice"),
        container_spec().max_state_bytes(),
        fake,
        TestQualified,
    )
}

fn publish_once(store: &ProcessBoundStateStore<DarwinContainer<FakeSyscalls>>, bytes: &[u8]) {
    let mut transaction = store.admit().expect("admit").enter().expect("transaction");
    let revision = transaction
        .read()
        .expect("read")
        .revision()
        .expect("revision");
    assert!(matches!(
        transaction.compare_and_publish(&revision, bytes),
        Ok(ProcessBoundPublishOutcome::Swapped(_))
    ));
    transaction.settle().expect("settle");
}

fn assert_no_store_mutation(events: &[Event]) {
    assert!(!events.iter().any(|event| match event {
        Event::MkdirAt { .. }
        | Event::Chmod(_, _)
        | Event::Truncate(_, _)
        | Event::Pwrite { .. }
        | Event::SetLock(_, _) => true,
        Event::OpenAt { flags, .. } => flags & (libc::O_CREAT | libc::O_RDWR) != 0,
        _ => false,
    }));
}

#[test]
fn empty_allowlist_returns_before_registry_and_every_mutation() {
    let fake = FakeSyscalls::new(false, ContainerPreflight::Missing);
    let lifecycle = initialize_process_lifecycle().expect("process lifecycle");
    let result = open_with(
        &lifecycle,
        Path::new("/Users/alice"),
        container_spec().max_state_bytes(),
        Arc::clone(&fake),
        ProductionQualification,
    );
    assert!(matches!(
        result,
        Err(NativeStoreErrorCode::DurabilityUnsupported)
    ));
    let events = fake.events();
    assert!(events
        .iter()
        .any(|event| matches!(event, Event::DurabilityProbe(HOME_FD))));
    assert_no_store_mutation(&events);

    let existing_private = FakeSyscalls::new(true, ContainerPreflight::Missing);
    assert!(matches!(
        open_with(
            &lifecycle,
            Path::new("/Users/alice"),
            container_spec().max_state_bytes(),
            Arc::clone(&existing_private),
            ProductionQualification,
        ),
        Err(NativeStoreErrorCode::DurabilityUnsupported)
    ));
    let existing_private_events = existing_private.events();
    assert!(existing_private_events
        .iter()
        .any(|event| matches!(event, Event::DurabilityProbe(PRIVATE_FD))));
    assert_no_store_mutation(&existing_private_events);

    // A cfg(test)-qualified open on the same home can reserve immediately;
    // production qualification therefore left no Opening registry entry.
    fake.clear_events();
    let store = open_test_store(Arc::clone(&fake)).expect("test-only qualified open");
    assert_eq!(store.close(), Ok(()));

    let unobservable = FakeSyscalls::new(false, ContainerPreflight::Missing);
    unobservable.inject_durability_probe_error();
    assert!(matches!(
        open_with(
            &lifecycle,
            Path::new("/Users/alice"),
            container_spec().max_state_bytes(),
            Arc::clone(&unobservable),
            ProductionQualification,
        ),
        Err(NativeStoreErrorCode::DurabilityUnsupported)
    ));
    assert_no_store_mutation(&unobservable.events());
}

#[test]
fn root_or_account_home_mismatch_is_rejected_before_path_observation() {
    let root = FakeSyscalls::new(false, ContainerPreflight::Missing);
    root.set_credentials(Credentials {
        real_uid: 0,
        effective_uid: 0,
        real_gid: 0,
        effective_gid: 0,
    });
    assert!(matches!(
        open_test_store(Arc::clone(&root)),
        Err(NativeStoreErrorCode::StorePermissionInvalid)
    ));
    assert_eq!(root.events(), [Event::Credentials]);

    let mismatch = FakeSyscalls::new(false, ContainerPreflight::Missing);
    mismatch.set_account_home("/Users/another");
    assert!(matches!(
        open_test_store(Arc::clone(&mismatch)),
        Err(NativeStoreErrorCode::StorePermissionInvalid)
    ));
    assert!(!mismatch
        .events()
        .iter()
        .any(|event| matches!(event, Event::OpenRoot(_))));
}

#[test]
fn private_directory_failures_close_the_untransferred_fd_exactly_once() {
    #[derive(Clone, Copy)]
    enum Failure {
        InspectStat,
        InspectAclRead,
        InspectAclValidation,
        CreateStat,
        CreateMetadata,
        CreateAclRead,
        CreateAclValidation,
    }

    let cases = [
        (Failure::InspectStat, NativeStoreErrorCode::StoreIo),
        (Failure::InspectAclRead, NativeStoreErrorCode::StoreIo),
        (
            Failure::InspectAclValidation,
            NativeStoreErrorCode::StorePermissionInvalid,
        ),
        (Failure::CreateStat, NativeStoreErrorCode::StoreIo),
        (
            Failure::CreateMetadata,
            NativeStoreErrorCode::StorePermissionInvalid,
        ),
        (Failure::CreateAclRead, NativeStoreErrorCode::StoreIo),
        (
            Failure::CreateAclValidation,
            NativeStoreErrorCode::StorePermissionInvalid,
        ),
    ];

    for (failure, expected) in cases {
        let private_exists = matches!(
            failure,
            Failure::InspectStat | Failure::InspectAclRead | Failure::InspectAclValidation
        );
        let fake = FakeSyscalls::new(private_exists, ContainerPreflight::Missing);
        match failure {
            Failure::InspectStat | Failure::CreateStat => fake.fail_stat_for(PRIVATE_FD),
            Failure::CreateMetadata => fake.force_private_mode(0o755),
            Failure::InspectAclRead | Failure::CreateAclRead => fake.fail_acl_for(PRIVATE_FD),
            Failure::InspectAclValidation | Failure::CreateAclValidation => {
                fake.invalidate_acl_for(PRIVATE_FD)
            }
        }

        assert_eq!(open_test_store(Arc::clone(&fake)).err(), Some(expected));
        let events = fake.events();
        assert_eq!(
            events
                .iter()
                .filter(|event| **event == Event::Close(PRIVATE_FD))
                .count(),
            1
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| **event == Event::Close(HOME_FD))
                .count(),
            1
        );
        assert!(!events
            .iter()
            .any(|event| *event == Event::Close(CONTAINER_FD)));
    }
}

#[test]
fn existing_symlink_special_and_wrong_mode_preflight_fail_closed_without_container_open() {
    let cases = [
        (
            metadata(
                1,
                200,
                libc::S_IFLNK,
                0o600,
                501,
                20,
                container_spec().file_length(),
            ),
            NativeStoreErrorCode::StoreIdentityUncertain,
        ),
        (
            metadata(
                1,
                201,
                libc::S_IFIFO,
                0o600,
                501,
                20,
                container_spec().file_length(),
            ),
            NativeStoreErrorCode::StoreIdentityUncertain,
        ),
        (
            metadata(
                1,
                202,
                libc::S_IFREG,
                0o640,
                501,
                20,
                container_spec().file_length(),
            ),
            NativeStoreErrorCode::StorePermissionInvalid,
        ),
    ];
    for (preflight, expected) in cases {
        let fake = FakeSyscalls::new(true, ContainerPreflight::Metadata(preflight));
        assert_eq!(open_test_store(Arc::clone(&fake)).err(), Some(expected));
        assert!(!fake.events().iter().any(|event| matches!(
            event,
            Event::OpenAt { parent: PRIVATE_FD, component, flags, .. }
                if component == &FakeSyscalls::leaf_component()
                    && flags & libc::O_RDWR != 0
        )));
    }
}

#[test]
fn exact_container_flags_lock_creation_and_publication_barrier_order_are_preserved() {
    let fake = FakeSyscalls::new(false, ContainerPreflight::Missing);
    let store = open_test_store(Arc::clone(&fake)).expect("open created store");
    let events = fake.events();
    let container_open = events
        .iter()
        .find_map(|event| match event {
            Event::OpenAt {
                parent: PRIVATE_FD,
                component,
                flags,
                mode,
            } if component == &FakeSyscalls::leaf_component() => Some((*flags, *mode)),
            _ => None,
        })
        .expect("container openat");
    assert_eq!(container_open, (CREATE_CONTAINER_OPEN_FLAGS, 0o600));
    assert_eq!(container_open.0 & (libc::O_TRUNC | libc::O_EXLOCK), 0);
    let descriptor_admission = [
        Event::Chmod(CONTAINER_FD, 0o600),
        Event::GetFdFlags(CONTAINER_FD),
        Event::SetLock(
            CONTAINER_FD,
            LockRequest {
                lock_type: libc::F_WRLCK,
                whence: libc::SEEK_SET as i16,
                start: 0,
                length: 0,
            },
        ),
        Event::Stat(CONTAINER_FD),
        Event::Truncate(CONTAINER_FD, container_spec().file_length()),
    ];
    assert!(events
        .windows(descriptor_admission.len())
        .any(|window| window == descriptor_admission));
    let final_proof = [
        Event::Stat(CONTAINER_FD),
        Event::StatAt {
            parent: PRIVATE_FD,
            component: FakeSyscalls::leaf_component(),
        },
        Event::Stat(CONTAINER_FD),
        Event::Close(PRIVATE_FD),
        Event::Close(HOME_FD),
    ];
    assert!(events
        .windows(final_proof.len())
        .any(|window| window == final_proof));
    assert_eq!(
        events
            .iter()
            .filter(|event| **event == Event::Close(PRIVATE_FD))
            .count(),
        1,
        "transferred parent fd is closed only by its context owner"
    );

    let creation = events
        .iter()
        .filter(|event| {
            matches!(
                event,
                Event::Truncate(_, _)
                    | Event::FullSync(_)
                    | Event::Sync(_)
                    | Event::SyncVolume(_, _)
            )
        })
        .cloned()
        .collect::<Vec<_>>();
    assert_eq!(
        creation,
        [
            Event::Truncate(CONTAINER_FD, container_spec().file_length()),
            Event::FullSync(CONTAINER_FD),
            Event::Sync(PRIVATE_FD),
            Event::Sync(HOME_FD),
            Event::SyncVolume(CONTAINER_FD, SYNC_VOLUME_FULLSYNC | SYNC_VOLUME_WAIT),
        ]
    );

    fake.clear_events();
    publish_once(&store, b"next");
    let publication = fake
        .events()
        .into_iter()
        .filter(|event| matches!(event, Event::Pwrite { .. } | Event::FullSync(_)))
        .collect::<Vec<_>>();
    assert!(matches!(
        publication.as_slice(),
        [
            Event::Pwrite {
                fd: CONTAINER_FD,
                ..
            },
            Event::FullSync(CONTAINER_FD),
            Event::Pwrite {
                fd: CONTAINER_FD,
                ..
            },
            Event::FullSync(CONTAINER_FD),
        ]
    ));

    assert_eq!(store.close(), Ok(()));
    assert_eq!(store.close(), Ok(()));
    assert_eq!(
        fake.events()
            .iter()
            .filter(|event| **event == Event::Close(CONTAINER_FD))
            .count(),
        1,
        "only common's cached final-close seam closes the sole container"
    );
}

#[test]
fn existing_container_uses_the_exact_noncreating_open_without_repair_or_truncate() {
    let fake = FakeSyscalls::new(true, ContainerPreflight::Missing);
    fake.make_existing_valid();
    let store = open_test_store(Arc::clone(&fake)).expect("open existing store");
    let events = fake.events();
    assert!(events.iter().any(|event| matches!(
        event,
        Event::OpenAt {
            parent: PRIVATE_FD,
            component,
            flags: EXISTING_CONTAINER_OPEN_FLAGS,
            mode: 0o600,
        } if component == &FakeSyscalls::leaf_component()
    )));
    assert!(!events.iter().any(|event| matches!(
        event,
        Event::Chmod(CONTAINER_FD, _) | Event::Truncate(CONTAINER_FD, _)
    )));
    assert_eq!(store.close(), Ok(()));
}

#[test]
fn positional_io_retries_eintr_and_advances_after_short_reads_and_writes() {
    let fake = FakeSyscalls::new(false, ContainerPreflight::Missing);
    fake.inject_short_and_interrupted_io();
    let store = open_test_store(Arc::clone(&fake)).expect("short/EINTR reads recover");
    let read_attempts = fake
        .events()
        .into_iter()
        .filter_map(|event| match event {
            Event::Pread {
                offset, requested, ..
            } => Some((offset, requested)),
            _ => None,
        })
        .take(3)
        .collect::<Vec<_>>();
    assert_eq!(read_attempts.len(), 3);
    let (read_start, first_request) = read_attempts[0];
    assert_eq!(read_attempts[1], (read_start, first_request));
    assert_eq!(
        read_attempts[2],
        (read_start + first_request as u64 / 2, first_request / 2)
    );

    fake.clear_events();
    publish_once(&store, b"short-write");
    let writes = fake
        .events()
        .into_iter()
        .filter_map(|event| match event {
            Event::Pwrite {
                offset, requested, ..
            } => Some((offset, requested)),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert!(writes.len() >= 4);
    let (write_start, first_request) = writes[0];
    assert_eq!(writes[1], (write_start, first_request));
    assert_eq!(writes[2], (write_start + 2, first_request - 2));
    assert_eq!(store.close(), Ok(()));
}

#[test]
fn acl_unknown_allow_is_permission_invalid() {
    let fake = FakeSyscalls::new(false, ContainerPreflight::Missing);
    fake.state.lock().expect("fake state").acl = vec![AclEntry {
        allow: true,
        principal: AclPrincipal::Unknown,
        permissions: 1 << 2,
        flags: 0,
    }];
    assert!(matches!(
        open_test_store(fake),
        Err(NativeStoreErrorCode::StorePermissionInvalid)
    ));
}
