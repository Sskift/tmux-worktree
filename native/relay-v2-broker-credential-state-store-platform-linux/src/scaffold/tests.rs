use super::*;
use relay_v2_broker_credential_state_store_platform_common::{
    initialize_process_lifecycle, ProcessBoundPublishOutcome,
};
use std::cell::Cell;
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

static NEXT_HOME_INODE: AtomicU64 = AtomicU64::new(50_000);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Role {
    Root,
    Home,
    Private,
    Container,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Call {
    Credentials,
    AccountHome,
    OpenRoot {
        flags: i32,
    },
    OpenDirectory {
        parent: Role,
        component: OsString,
        flags: i32,
    },
    Mkdir {
        parent: Role,
        component: OsString,
        mode: u32,
    },
    OpenFile {
        flags: i32,
        mode: u32,
    },
    Fstat(Role),
    Fstatat {
        parent: Role,
        component: OsString,
    },
    AclSize {
        role: Role,
        kind: AclXattrKind,
    },
    AclRead {
        role: Role,
        kind: AclXattrKind,
        requested: usize,
    },
    Probe(Role),
    Fchmod {
        role: Role,
        mode: u32,
    },
    Ftruncate {
        role: Role,
        length: u64,
    },
    GetFd(Role),
    SetLk {
        role: Role,
        lock: TraditionalRecordLock,
    },
    Pwrite {
        role: Role,
        offset: u64,
        requested: usize,
    },
    Fsync(Role),
    Close(Role),
}

#[derive(Debug, Clone, Copy)]
enum WriteStep {
    Interrupted,
    Count(usize),
}

struct FakeState {
    calls: Vec<Call>,
    next_fd: i32,
    roles: HashMap<i32, Role>,
    home: Metadata,
    private: Option<Metadata>,
    container: Option<Metadata>,
    home_open_error: Option<SysError>,
    private_open_error: Option<SysError>,
    container_open_error: Option<SysError>,
    home_fstat_steps: VecDeque<Result<Metadata, SysError>>,
    home_close_error: Option<SysError>,
    cloexec: bool,
    lock_error: Option<SysError>,
    access_acl: HashMap<Role, Vec<u8>>,
    default_acl: HashMap<Role, Vec<u8>>,
    acl_size_errors: HashMap<(Role, AclXattrKind), SysError>,
    acl_read_errors: HashMap<(Role, AclXattrKind), SysError>,
    bytes: BTreeMap<u64, u8>,
    write_steps: VecDeque<WriteStep>,
    fsync_steps: VecDeque<Result<(), SysError>>,
    container_close_error: Option<SysError>,
}

struct FakeSyscalls {
    state: Mutex<FakeState>,
}

impl FakeSyscalls {
    fn existing() -> Arc<Self> {
        let home_inode = NEXT_HOME_INODE.fetch_add(10, Ordering::Relaxed);
        Arc::new(Self {
            state: Mutex::new(FakeState {
                calls: Vec::new(),
                next_fd: 10,
                roles: HashMap::new(),
                home: directory_metadata(home_inode, 0o755),
                private: Some(directory_metadata(home_inode + 1, PRIVATE_DIRECTORY_MODE)),
                container: Some(container_metadata(
                    home_inode + 2,
                    container_spec().file_length(),
                )),
                home_open_error: None,
                private_open_error: None,
                container_open_error: None,
                home_fstat_steps: VecDeque::new(),
                home_close_error: None,
                cloexec: true,
                lock_error: None,
                access_acl: HashMap::new(),
                default_acl: HashMap::new(),
                acl_size_errors: HashMap::new(),
                acl_read_errors: HashMap::new(),
                bytes: BTreeMap::new(),
                write_steps: VecDeque::new(),
                fsync_steps: VecDeque::new(),
                container_close_error: None,
            }),
        })
    }

    fn missing() -> Arc<Self> {
        let value = Self::existing();
        {
            let mut state = value.state.lock().expect("fake state");
            state.private = None;
            state.container = None;
        }
        value
    }

    fn calls(&self) -> Vec<Call> {
        self.state.lock().expect("fake state").calls.clone()
    }

    fn clear_calls(&self) {
        self.state.lock().expect("fake state").calls.clear();
    }

    fn mutate(&self, change: impl FnOnce(&mut FakeState)) {
        change(&mut self.state.lock().expect("fake state"));
    }

    fn allocate_role_fd(&self, role: Role) -> i32 {
        let mut state = self.state.lock().expect("fake state");
        Self::allocate_fd(&mut state, role)
    }

    fn allocate_fd(state: &mut FakeState, role: Role) -> i32 {
        let fd = state.next_fd;
        state.next_fd += 1;
        state.roles.insert(fd, role);
        fd
    }

    fn role(state: &FakeState, fd: i32) -> Result<Role, SysError> {
        state.roles.get(&fd).copied().ok_or(SysError::Other)
    }
}

fn directory_metadata(inode: u64, mode: u32) -> Metadata {
    Metadata {
        device: 77,
        inode,
        kind: FileKind::Directory,
        mode,
        uid: 1000,
        gid: 1000,
        links: 1,
        size: 0,
    }
}

fn container_metadata(inode: u64, size: u64) -> Metadata {
    Metadata {
        device: 77,
        inode,
        kind: FileKind::Regular,
        mode: CONTAINER_MODE,
        uid: 1000,
        gid: 1000,
        links: 1,
        size,
    }
}

impl LinuxSyscalls for FakeSyscalls {
    fn credential_snapshot(&self) -> Result<Credentials, SysError> {
        self.state
            .lock()
            .expect("fake state")
            .calls
            .push(Call::Credentials);
        Ok(Credentials {
            real_uid: 1000,
            effective_uid: 1000,
            real_gid: 1000,
            effective_gid: 1000,
        })
    }

    fn account_home(&self, _effective_uid: u32) -> Result<Option<PathBuf>, SysError> {
        self.state
            .lock()
            .expect("fake state")
            .calls
            .push(Call::AccountHome);
        Ok(Some(PathBuf::from("/account")))
    }

    fn open_root(&self, flags: i32) -> Result<i32, SysError> {
        let mut state = self.state.lock().expect("fake state");
        state.calls.push(Call::OpenRoot { flags });
        Ok(Self::allocate_fd(&mut state, Role::Root))
    }

    fn open_directory_at(
        &self,
        parent: i32,
        component: &OsStr,
        flags: i32,
    ) -> Result<i32, SysError> {
        let mut state = self.state.lock().expect("fake state");
        let parent_role = Self::role(&state, parent)?;
        state.calls.push(Call::OpenDirectory {
            parent: parent_role,
            component: component.to_os_string(),
            flags,
        });
        let role = match (parent_role, component) {
            (Role::Root, value) if value == OsStr::new("account") => {
                if let Some(error) = state.home_open_error {
                    return Err(error);
                }
                Role::Home
            }
            (Role::Home, value)
                if value == OsStr::new(container_spec().relative_components()[0]) =>
            {
                if let Some(error) = state.private_open_error {
                    return Err(error);
                }
                if state.private.is_none() {
                    return Err(SysError::NotFound);
                }
                Role::Private
            }
            _ => return Err(SysError::NotFound),
        };
        Ok(Self::allocate_fd(&mut state, role))
    }

    fn mkdir_at(&self, parent: i32, component: &OsStr, mode: u32) -> Result<(), SysError> {
        let mut state = self.state.lock().expect("fake state");
        let parent_role = Self::role(&state, parent)?;
        state.calls.push(Call::Mkdir {
            parent: parent_role,
            component: component.to_os_string(),
            mode,
        });
        if state.private.is_some() {
            return Err(SysError::AlreadyExists);
        }
        state.private = Some(directory_metadata(state.home.inode + 1, mode));
        Ok(())
    }

    fn open_file_at(
        &self,
        parent: i32,
        component: &OsStr,
        flags: i32,
        mode: u32,
    ) -> Result<i32, SysError> {
        let mut state = self.state.lock().expect("fake state");
        if Self::role(&state, parent)? != Role::Private
            || component != OsStr::new(container_spec().relative_components()[1])
        {
            return Err(SysError::NotFound);
        }
        state.calls.push(Call::OpenFile { flags, mode });
        if let Some(error) = state.container_open_error {
            return Err(error);
        }
        if flags & O_CREAT != 0 {
            if state.container.is_some() {
                return Err(SysError::AlreadyExists);
            }
            let inode = state.home.inode + 2;
            state.container = Some(container_metadata(inode, 0));
        } else if state.container.is_none() {
            return Err(SysError::NotFound);
        }
        Ok(Self::allocate_fd(&mut state, Role::Container))
    }

    fn fstat(&self, fd: i32) -> Result<Metadata, SysError> {
        let mut state = self.state.lock().expect("fake state");
        let role = Self::role(&state, fd)?;
        state.calls.push(Call::Fstat(role));
        match role {
            Role::Root => Ok(Metadata {
                device: 77,
                inode: 1,
                kind: FileKind::Directory,
                mode: 0o755,
                uid: 0,
                gid: 0,
                links: 1,
                size: 0,
            }),
            Role::Home => match state.home_fstat_steps.pop_front() {
                Some(result) => result,
                None => Ok(state.home),
            },
            Role::Private => state.private.ok_or(SysError::NotFound),
            Role::Container => state.container.ok_or(SysError::NotFound),
        }
    }

    fn fstatat_nofollow(&self, parent: i32, component: &OsStr) -> Result<Metadata, SysError> {
        let mut state = self.state.lock().expect("fake state");
        let parent_role = Self::role(&state, parent)?;
        state.calls.push(Call::Fstatat {
            parent: parent_role,
            component: component.to_os_string(),
        });
        match (parent_role, component) {
            (Role::Root, value) if value == OsStr::new("account") => Ok(state.home),
            (Role::Home, value)
                if value == OsStr::new(container_spec().relative_components()[0]) =>
            {
                state.private.ok_or(SysError::NotFound)
            }
            (Role::Private, value)
                if value == OsStr::new(container_spec().relative_components()[1]) =>
            {
                state.container.ok_or(SysError::NotFound)
            }
            _ => Err(SysError::NotFound),
        }
    }

    fn acl_xattr_size(&self, fd: i32, kind: AclXattrKind) -> Result<Option<usize>, SysError> {
        let mut state = self.state.lock().expect("fake state");
        let role = Self::role(&state, fd)?;
        state.calls.push(Call::AclSize { role, kind });
        if let Some(error) = state.acl_size_errors.get(&(role, kind)).copied() {
            return Err(error);
        }
        Ok(match kind {
            AclXattrKind::Access => state.access_acl.get(&role).map(Vec::len),
            AclXattrKind::Default => state.default_acl.get(&role).map(Vec::len),
        })
    }

    fn acl_xattr_read(
        &self,
        fd: i32,
        kind: AclXattrKind,
        output: &mut [u8],
    ) -> Result<usize, SysError> {
        let mut state = self.state.lock().expect("fake state");
        let role = Self::role(&state, fd)?;
        state.calls.push(Call::AclRead {
            role,
            kind,
            requested: output.len(),
        });
        if let Some(error) = state.acl_read_errors.get(&(role, kind)).copied() {
            return Err(error);
        }
        let value = match kind {
            AclXattrKind::Access => state.access_acl.get(&role),
            AclXattrKind::Default => state.default_acl.get(&role),
        }
        .ok_or(SysError::NoData)?;
        let count = value.len().min(output.len());
        output[..count].copy_from_slice(&value[..count]);
        Ok(count)
    }

    fn durability_probe(&self, fd: i32) -> Result<DurabilityEvidence, SysError> {
        let mut state = self.state.lock().expect("fake state");
        let role = Self::role(&state, fd)?;
        state.calls.push(Call::Probe(role));
        let target = match role {
            Role::Home => state.home,
            Role::Private => state.private.ok_or(SysError::NotFound)?,
            _ => return Err(SysError::Other),
        };
        Ok(DurabilityEvidence {
            target,
            filesystem_magic: 0xfeed,
            filesystem_flags: 0,
            ordered_storage_evidence_complete: true,
        })
    }

    fn fchmod(&self, fd: i32, mode: u32) -> Result<(), SysError> {
        let mut state = self.state.lock().expect("fake state");
        let role = Self::role(&state, fd)?;
        state.calls.push(Call::Fchmod { role, mode });
        match role {
            Role::Private => state.private.as_mut().ok_or(SysError::NotFound)?.mode = mode,
            Role::Container => state.container.as_mut().ok_or(SysError::NotFound)?.mode = mode,
            _ => return Err(SysError::Other),
        }
        Ok(())
    }

    fn ftruncate(&self, fd: i32, length: u64) -> Result<(), SysError> {
        let mut state = self.state.lock().expect("fake state");
        let role = Self::role(&state, fd)?;
        state.calls.push(Call::Ftruncate { role, length });
        if role != Role::Container {
            return Err(SysError::Other);
        }
        state.container.as_mut().ok_or(SysError::NotFound)?.size = length;
        state.bytes.retain(|offset, _| *offset < length);
        Ok(())
    }

    fn fcntl_getfd(&self, fd: i32) -> Result<i32, SysError> {
        let mut state = self.state.lock().expect("fake state");
        let role = Self::role(&state, fd)?;
        state.calls.push(Call::GetFd(role));
        Ok(if state.cloexec { FD_CLOEXEC } else { 0 })
    }

    fn fcntl_setlk(&self, fd: i32, lock: TraditionalRecordLock) -> Result<(), SysError> {
        let mut state = self.state.lock().expect("fake state");
        let role = Self::role(&state, fd)?;
        state.calls.push(Call::SetLk { role, lock });
        match state.lock_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    fn pread(&self, fd: i32, offset: u64, output: &mut [u8]) -> Result<usize, SysError> {
        let state = self.state.lock().expect("fake state");
        if Self::role(&state, fd)? != Role::Container {
            return Err(SysError::Other);
        }
        let end = offset
            .checked_add(output.len() as u64)
            .ok_or(SysError::Other)?;
        if end > state.container.ok_or(SysError::NotFound)?.size {
            return Err(SysError::Other);
        }
        output.fill(0);
        for (&position, &byte) in state.bytes.range(offset..end) {
            output[usize::try_from(position - offset).expect("bounded fake read")] = byte;
        }
        Ok(output.len())
    }

    fn pwrite(&self, fd: i32, offset: u64, bytes: &[u8]) -> Result<usize, SysError> {
        let mut state = self.state.lock().expect("fake state");
        let role = Self::role(&state, fd)?;
        state.calls.push(Call::Pwrite {
            role,
            offset,
            requested: bytes.len(),
        });
        let count = match state.write_steps.pop_front() {
            Some(WriteStep::Interrupted) => return Err(SysError::Interrupted),
            Some(WriteStep::Count(count)) => count.min(bytes.len()),
            None => bytes.len(),
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

    fn fsync(&self, fd: i32) -> Result<(), SysError> {
        let mut state = self.state.lock().expect("fake state");
        let role = Self::role(&state, fd)?;
        state.calls.push(Call::Fsync(role));
        state.fsync_steps.pop_front().unwrap_or(Ok(()))
    }

    fn close(&self, fd: i32) -> Result<(), SysError> {
        let mut state = self.state.lock().expect("fake state");
        let role = Self::role(&state, fd)?;
        state.calls.push(Call::Close(role));
        state.roles.remove(&fd);
        if role == Role::Home {
            if let Some(error) = state.home_close_error.take() {
                return Err(error);
            }
        }
        if role == Role::Container {
            if let Some(error) = state.container_close_error.take() {
                return Err(error);
            }
        }
        Ok(())
    }
}

fn open_qualified(
    syscalls: Arc<FakeSyscalls>,
) -> Result<ProcessBoundStateStore<LinuxContainerCore<FakeSyscalls>>, NativeStoreErrorCode> {
    let lifecycle = initialize_process_lifecycle().expect("initialize process lifecycle");
    open_with_policy(
        syscalls,
        &lifecycle,
        Path::new("/account"),
        &TestOnlyQualified,
        |core| core,
    )
}

fn access_acl(mode: u32, named: Option<(u8, u8)>) -> Vec<u8> {
    let mut entries = vec![
        (ACL_USER_OBJ, ((mode >> 6) & 7) as u8, u32::MAX),
        (ACL_GROUP_OBJ, ((mode >> 3) & 7) as u8, u32::MAX),
    ];
    if let Some((named_permissions, mask)) = named {
        entries.push((ACL_USER, named_permissions, 42));
        entries.push((ACL_MASK, mask, u32::MAX));
    }
    entries.push((ACL_OTHER, (mode & 7) as u8, u32::MAX));
    acl_bytes(&entries)
}

fn default_acl(named_permissions: u8, mask: u8) -> Vec<u8> {
    acl_bytes(&[
        (ACL_USER_OBJ, 0b111, u32::MAX),
        (ACL_USER, named_permissions, 42),
        (ACL_GROUP_OBJ, 0, u32::MAX),
        (ACL_MASK, mask, u32::MAX),
        (ACL_OTHER, 0, u32::MAX),
    ])
}

fn acl_bytes(entries: &[(u16, u8, u32)]) -> Vec<u8> {
    let mut bytes = ACL_XATTR_VERSION.to_le_bytes().to_vec();
    for (tag, permissions, id) in entries {
        bytes.extend_from_slice(&tag.to_le_bytes());
        bytes.extend_from_slice(&u16::from(*permissions).to_le_bytes());
        bytes.extend_from_slice(&id.to_le_bytes());
    }
    bytes
}

fn close_count(syscalls: &FakeSyscalls, role: Role) -> usize {
    syscalls
        .calls()
        .iter()
        .filter(|call| matches!(call, Call::Close(actual) if *actual == role))
        .count()
}

#[test]
fn empty_allowlist_returns_before_registry_and_every_mutation() {
    let syscalls = FakeSyscalls::existing();
    let lifecycle = initialize_process_lifecycle().expect("initialize process lifecycle");
    let result = open_with_policy(
        Arc::clone(&syscalls),
        &lifecycle,
        Path::new("/account"),
        &EmptyQualificationAllowlist,
        |core| core,
    );
    assert!(matches!(
        result,
        Err(NativeStoreErrorCode::DurabilityUnsupported)
    ));
    let calls = syscalls.calls();
    assert!(calls
        .iter()
        .any(|call| matches!(call, Call::Probe(Role::Private))));
    assert!(!calls.iter().any(|call| matches!(
        call,
        Call::Mkdir { .. }
            | Call::OpenFile { .. }
            | Call::Fchmod { .. }
            | Call::Ftruncate { .. }
            | Call::SetLk { .. }
            | Call::Pwrite { .. }
            | Call::Fsync(_)
    )));

    // The same common registry key remains reservable, which observes that
    // the deny path never entered platform-common's registry.
    syscalls.clear_calls();
    let store = open_qualified(Arc::clone(&syscalls)).expect("test-only qualified reopen");
    store.close().expect("close qualified fake store");
}

#[test]
fn account_home_traversal_enoent_is_identity_uncertain() {
    let syscalls = FakeSyscalls::existing();
    syscalls.mutate(|state| state.home_open_error = Some(SysError::NotFound));
    assert!(matches!(
        open_qualified(syscalls),
        Err(NativeStoreErrorCode::StoreIdentityUncertain)
    ));
}

#[test]
fn verify_account_home_final_failures_close_once_and_preserve_primary() {
    let fstat_failure = FakeSyscalls::existing();
    fstat_failure.mutate(|state| {
        let home = state.home;
        state.home_fstat_steps = VecDeque::from([Ok(home), Ok(home), Err(SysError::Other)]);
    });
    assert!(matches!(
        open_qualified(Arc::clone(&fstat_failure)),
        Err(NativeStoreErrorCode::StoreIo)
    ));
    assert_eq!(close_count(&fstat_failure, Role::Home), 1);

    let metadata_failure = FakeSyscalls::existing();
    metadata_failure.mutate(|state| {
        state.home.mode = 0o777;
        state.home_close_error = Some(SysError::Interrupted);
    });
    assert!(matches!(
        open_qualified(Arc::clone(&metadata_failure)),
        Err(NativeStoreErrorCode::StorePermissionInvalid)
    ));
    assert_eq!(close_count(&metadata_failure, Role::Home), 1);

    let acl_failure = FakeSyscalls::existing();
    acl_failure.mutate(|state| {
        state
            .access_acl
            .insert(Role::Home, access_acl(0o755, Some((ACL_WRITE, 0b111))));
        state.home_close_error = Some(SysError::Interrupted);
    });
    assert!(matches!(
        open_qualified(Arc::clone(&acl_failure)),
        Err(NativeStoreErrorCode::StorePermissionInvalid)
    ));
    assert_eq!(close_count(&acl_failure, Role::Home), 1);
}

#[test]
fn wrong_type_path_and_container_open_races_are_identity_uncertain() {
    let account_home = FakeSyscalls::existing();
    account_home.mutate(|state| state.home_open_error = Some(SysError::WrongType));
    assert!(matches!(
        open_qualified(account_home),
        Err(NativeStoreErrorCode::StoreIdentityUncertain)
    ));

    let private = FakeSyscalls::existing();
    private.mutate(|state| state.private_open_error = Some(SysError::WrongType));
    assert!(matches!(
        open_qualified(private),
        Err(NativeStoreErrorCode::StoreIdentityUncertain)
    ));

    let container = FakeSyscalls::existing();
    container.mutate(|state| state.container_open_error = Some(SysError::WrongType));
    assert!(matches!(
        open_qualified(container),
        Err(NativeStoreErrorCode::StoreIdentityUncertain)
    ));
}

#[test]
fn acl_cannot_prove_is_permission_invalid_but_explicit_io_remains_store_io() {
    // Linux ENOTSUP and EOPNOTSUPP share errno 95.
    assert_eq!(classify_acl_xattr_errno(1), SysError::AclUnprovable);
    assert_eq!(classify_acl_xattr_errno(13), SysError::AclUnprovable);
    assert_eq!(classify_acl_xattr_errno(95), SysError::AclUnprovable);
    assert_eq!(classify_acl_xattr_errno(4), SysError::Interrupted);
    assert_eq!(classify_acl_xattr_errno(34), SysError::AclSizeChanged);
    assert_eq!(classify_acl_xattr_errno(61), SysError::NoData);
    assert_eq!(classify_acl_xattr_errno(5), SysError::AclIo);
    // EBADF, ENOMEM, and an unknown errno remain real syscall/implementation I/O.
    assert_eq!(classify_acl_xattr_errno(9), SysError::AclIo);
    assert_eq!(classify_acl_xattr_errno(12), SysError::AclIo);
    assert_eq!(classify_acl_xattr_errno(12_345), SysError::AclIo);

    for error in [SysError::Access, SysError::AclUnprovable] {
        let syscalls = FakeSyscalls::existing();
        syscalls.mutate(|state| {
            state
                .acl_size_errors
                .insert((Role::Home, AclXattrKind::Access), error);
        });
        assert!(matches!(
            open_qualified(syscalls),
            Err(NativeStoreErrorCode::StorePermissionInvalid)
        ));
    }

    for error in [SysError::AclIo, SysError::Other] {
        let io = FakeSyscalls::existing();
        io.mutate(|state| {
            state.access_acl.insert(Role::Home, access_acl(0o755, None));
            state
                .acl_read_errors
                .insert((Role::Home, AclXattrKind::Access), error);
        });
        assert!(matches!(
            open_qualified(io),
            Err(NativeStoreErrorCode::StoreIo)
        ));
    }
}

#[test]
fn descriptor_acl_checks_before_every_size_read_and_retry_syscall() {
    let access = access_acl(CONTAINER_MODE, None);
    let access_length = access.len();
    for (deny_at, interrupted_size, expected) in [
        (1, false, vec![]),
        (
            2,
            false,
            vec![Call::AclSize {
                role: Role::Container,
                kind: AclXattrKind::Access,
            }],
        ),
        (
            3,
            false,
            vec![
                Call::AclSize {
                    role: Role::Container,
                    kind: AclXattrKind::Access,
                },
                Call::AclRead {
                    role: Role::Container,
                    kind: AclXattrKind::Access,
                    requested: access_length,
                },
            ],
        ),
        (
            2,
            true,
            vec![Call::AclSize {
                role: Role::Container,
                kind: AclXattrKind::Access,
            }],
        ),
    ] {
        let syscalls = FakeSyscalls::existing();
        let fd = syscalls.allocate_role_fd(Role::Container);
        syscalls.mutate(|state| {
            state.access_acl.insert(Role::Container, access.clone());
            if interrupted_size {
                state.acl_size_errors.insert(
                    (Role::Container, AclXattrKind::Access),
                    SysError::Interrupted,
                );
            }
        });
        let checks = Cell::new(0_usize);
        // Injected `Closed` models a common fence observing registry poison.
        // Each denial must happen before the corresponding fake syscall.
        let result = validate_acl_with_syscall_check(
            syscalls.as_ref(),
            fd,
            container_metadata(99, container_spec().file_length()),
            false,
            || {
                let next = checks.get() + 1;
                checks.set(next);
                if next == deny_at {
                    Err(PlatformStoreFailure::Closed.into())
                } else {
                    Ok(())
                }
            },
        );
        assert!(matches!(
            result,
            Err(OpenFailure::Platform(PlatformStoreFailure::Closed))
        ));
        assert_eq!(checks.get(), deny_at);
        let actual: Vec<_> = syscalls
            .calls()
            .into_iter()
            .filter(|call| matches!(call, Call::AclSize { .. } | Call::AclRead { .. }))
            .collect();
        assert_eq!(actual, expected);
    }
}

#[test]
fn unsafe_path_object_mode_and_acl_fail_closed_without_repair() {
    let symlink = FakeSyscalls::existing();
    symlink.mutate(|state| state.private_open_error = Some(SysError::Symlink));
    assert!(matches!(
        open_qualified(symlink),
        Err(NativeStoreErrorCode::StoreIdentityUncertain)
    ));

    let special = FakeSyscalls::existing();
    special.mutate(|state| {
        state.container.as_mut().expect("container").kind = FileKind::Special;
    });
    assert!(matches!(
        open_qualified(special),
        Err(NativeStoreErrorCode::StoreIdentityUncertain)
    ));

    let wrong_mode = FakeSyscalls::existing();
    wrong_mode.mutate(|state| {
        state.private.as_mut().expect("private").mode = 0o750;
    });
    assert!(matches!(
        open_qualified(Arc::clone(&wrong_mode)),
        Err(NativeStoreErrorCode::StorePermissionInvalid)
    ));
    assert!(!wrong_mode
        .calls()
        .iter()
        .any(|call| matches!(call, Call::Fchmod { .. })));

    let wrong_access_acl = FakeSyscalls::existing();
    wrong_access_acl.mutate(|state| {
        state.access_acl.insert(
            Role::Container,
            access_acl(CONTAINER_MODE, Some((ACL_WRITE, ACL_WRITE))),
        );
    });
    assert!(matches!(
        open_qualified(wrong_access_acl),
        Err(NativeStoreErrorCode::StorePermissionInvalid)
    ));

    let wrong_default_acl = FakeSyscalls::existing();
    wrong_default_acl.mutate(|state| {
        state
            .default_acl
            .insert(Role::Private, default_acl(ACL_WRITE, ACL_WRITE));
    });
    assert!(matches!(
        open_qualified(wrong_default_acl),
        Err(NativeStoreErrorCode::StorePermissionInvalid)
    ));
}

#[test]
fn posix_acl_mask_controls_effective_named_permissions() {
    let syscalls = FakeSyscalls::existing();
    syscalls.mutate(|state| {
        state.access_acl.insert(
            Role::Private,
            access_acl(PRIVATE_DIRECTORY_MODE, Some((0b111, 0))),
        );
        state
            .default_acl
            .insert(Role::Private, default_acl(0b111, 0));
    });
    let store = open_qualified(syscalls).expect("zero mask removes named effective access");
    store.close().expect("close store");
}

#[test]
fn existing_open_uses_exact_preflight_flags_lock_and_final_abc_proof() {
    let syscalls = FakeSyscalls::existing();
    let store = open_qualified(Arc::clone(&syscalls)).expect("open existing fake container");
    let calls = syscalls.calls();
    assert!(calls.iter().any(|call| matches!(
        call,
        Call::OpenFile { flags, mode }
            if *flags == EXISTING_FILE_FLAGS
                && *mode == CONTAINER_MODE
                && flags & O_CREAT == 0
                && flags & O_EXCL == 0
    )));
    assert!(calls
        .iter()
        .any(|call| matches!(call, Call::GetFd(Role::Container))));
    assert!(calls.iter().any(|call| matches!(
        call,
        Call::SetLk { role: Role::Container, lock }
            if *lock == TraditionalRecordLock::WHOLE_FILE_WRITE
    )));

    let leaf = OsStr::new(container_spec().relative_components()[1]);
    let final_named = calls
        .iter()
        .rposition(|call| matches!(call, Call::Fstatat { parent: Role::Private, component } if component == leaf))
        .expect("final named proof");
    assert!(matches!(
        calls[final_named - 1],
        Call::Fstat(Role::Container)
    ));
    assert!(matches!(
        calls[final_named + 1],
        Call::Fstat(Role::Container)
    ));
    assert!(matches!(calls[final_named + 2], Call::Close(Role::Private)));
    assert!(matches!(calls[final_named + 3], Call::Close(Role::Home)));
    assert!(!calls.iter().any(|call| matches!(
        call,
        Call::Fchmod {
            role: Role::Container,
            ..
        } | Call::Ftruncate { .. }
    )));
    store.close().expect("close store");
}

#[test]
fn missing_cloexec_fails_identity_and_only_lock_contention_is_busy() {
    let missing_cloexec = FakeSyscalls::existing();
    missing_cloexec.mutate(|state| state.cloexec = false);
    assert!(matches!(
        open_qualified(missing_cloexec),
        Err(NativeStoreErrorCode::StoreIdentityUncertain)
    ));

    for error in [SysError::Access, SysError::Again] {
        let busy = FakeSyscalls::existing();
        busy.mutate(|state| state.lock_error = Some(error));
        assert!(matches!(
            open_qualified(busy),
            Err(NativeStoreErrorCode::StoreBusy)
        ));
    }

    let other = FakeSyscalls::existing();
    other.mutate(|state| state.lock_error = Some(SysError::Other));
    assert!(matches!(
        open_qualified(other),
        Err(NativeStoreErrorCode::StoreIo)
    ));
}

#[test]
fn creation_uses_exact_atomic_flags_and_container_parent_home_fsync_order() {
    let syscalls = FakeSyscalls::missing();
    let store = open_qualified(Arc::clone(&syscalls)).expect("create fake container");
    let calls = syscalls.calls();
    assert!(calls.iter().any(|call| matches!(
        call,
        Call::OpenFile { flags, mode }
            if *flags == CREATE_FILE_FLAGS
                && *mode == CONTAINER_MODE
                && flags & O_CREAT != 0
                && flags & O_EXCL != 0
    )));
    assert!(calls.iter().any(|call| matches!(
        call,
        Call::Ftruncate { role: Role::Container, length }
            if *length == container_spec().file_length()
    )));
    let fsyncs: Vec<_> = calls
        .iter()
        .filter_map(|call| match call {
            Call::Fsync(role) => Some(*role),
            _ => None,
        })
        .collect();
    assert_eq!(fsyncs, [Role::Container, Role::Private, Role::Home]);
    store.close().expect("close created store");
}

#[test]
fn publication_retries_eintr_and_short_writes_then_fsyncs_payload_and_header() {
    let syscalls = FakeSyscalls::existing();
    let store = open_qualified(Arc::clone(&syscalls)).expect("open fake container");
    syscalls.clear_calls();
    syscalls.mutate(|state| {
        state.write_steps = VecDeque::from([WriteStep::Interrupted, WriteStep::Count(2)]);
    });
    let mut transaction = store.admit().expect("admit").enter().expect("transaction");
    let revision = transaction
        .read()
        .expect("read missing")
        .revision()
        .expect("revision");
    assert!(matches!(
        transaction.compare_and_publish(&revision, b"alpha"),
        Ok(ProcessBoundPublishOutcome::Swapped(_))
    ));
    transaction.settle().expect("settle");

    let publication: Vec<_> = syscalls
        .calls()
        .into_iter()
        .filter(|call| matches!(call, Call::Pwrite { .. } | Call::Fsync(_)))
        .collect();
    assert_eq!(
        publication,
        [
            Call::Pwrite {
                role: Role::Container,
                offset: 256,
                requested: 5,
            },
            Call::Pwrite {
                role: Role::Container,
                offset: 256,
                requested: 5,
            },
            Call::Pwrite {
                role: Role::Container,
                offset: 258,
                requested: 3,
            },
            Call::Fsync(Role::Container),
            Call::Pwrite {
                role: Role::Container,
                offset: 0,
                requested: 128,
            },
            Call::Fsync(Role::Container),
        ]
    );
    store.close().expect("close store");
}

#[test]
fn container_close_eintr_is_handed_to_common_once_without_retry() {
    let syscalls = FakeSyscalls::existing();
    let store = open_qualified(Arc::clone(&syscalls)).expect("open fake container");
    syscalls.clear_calls();
    syscalls.mutate(|state| state.container_close_error = Some(SysError::Interrupted));

    assert_eq!(store.close(), Err(NativeStoreErrorCode::StoreIo));
    assert_eq!(store.close(), Err(NativeStoreErrorCode::StoreIo));
    assert_eq!(
        syscalls
            .calls()
            .iter()
            .filter(|call| matches!(call, Call::Close(Role::Container)))
            .count(),
        1
    );
}
