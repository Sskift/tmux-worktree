use relay_v2_broker_credential_state_store_platform_common::PlatformStoreFailure;
use std::ffi::{CStr, CString, OsString};
use std::io;
use std::mem;
use std::os::fd::RawFd;
use std::os::unix::ffi::OsStringExt;
use std::ptr;

pub(crate) const DIRECTORY_OPEN_FLAGS: i32 =
    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
pub(crate) const EXISTING_CONTAINER_OPEN_FLAGS: i32 =
    libc::O_RDWR | libc::O_NOFOLLOW | libc::O_CLOEXEC;
pub(crate) const CREATE_CONTAINER_OPEN_FLAGS: i32 =
    EXISTING_CONTAINER_OPEN_FLAGS | libc::O_CREAT | libc::O_EXCL;
pub(crate) const SYNC_VOLUME_FULLSYNC: i32 = 0x01;
pub(crate) const SYNC_VOLUME_WAIT: i32 = 0x02;

const ACL_TYPE_EXTENDED: i32 = 0x0000_0100;
const ACL_FIRST_ENTRY: i32 = 0;
const ACL_NEXT_ENTRY: i32 = -1;
const ACL_EXTENDED_ALLOW: i32 = 1;
const ACL_EXTENDED_DENY: i32 = 2;
const ID_TYPE_UID: i32 = 0;
const ID_TYPE_GID: i32 = 1;

type Acl = *mut libc::c_void;
type AclEntryPointer = *mut libc::c_void;

unsafe extern "C" {
    fn acl_get_fd_np(fd: libc::c_int, acl_type: libc::c_int) -> Acl;
    fn acl_get_entry(acl: Acl, entry_id: libc::c_int, entry: *mut AclEntryPointer) -> libc::c_int;
    fn acl_get_tag_type(entry: AclEntryPointer, tag: *mut libc::c_int) -> libc::c_int;
    fn acl_get_qualifier(entry: AclEntryPointer) -> *mut libc::c_void;
    fn acl_get_permset_mask_np(entry: AclEntryPointer, mask: *mut u64) -> libc::c_int;
    fn acl_get_flagset_np(
        object: *mut libc::c_void,
        flagset: *mut *mut libc::c_void,
    ) -> libc::c_int;
    fn acl_get_flag_np(flagset: *mut libc::c_void, flag: libc::c_int) -> libc::c_int;
    fn acl_free(object: *mut libc::c_void) -> libc::c_int;
    fn mbr_uuid_to_id(
        uuid: *const u8,
        id: *mut libc::id_t,
        id_type: *mut libc::c_int,
    ) -> libc::c_int;
    fn fsync_volume_np(fd: libc::c_int, flags: libc::c_int) -> libc::c_int;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Credentials {
    pub(crate) real_uid: u32,
    pub(crate) effective_uid: u32,
    pub(crate) real_gid: u32,
    pub(crate) effective_gid: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct FileMetadata {
    pub(crate) device: u64,
    pub(crate) inode: u64,
    pub(crate) mode: u32,
    pub(crate) uid: u32,
    pub(crate) gid: u32,
    pub(crate) nlink: u64,
    pub(crate) size: u64,
}

impl FileMetadata {
    pub(crate) fn file_type(self) -> u32 {
        self.mode & u32::from(libc::S_IFMT)
    }

    pub(crate) fn permission_mode(self) -> u32 {
        self.mode & 0o7777
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum AclPrincipal {
    User(u32),
    Group(u32),
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct AclEntry {
    pub(crate) allow: bool,
    pub(crate) principal: AclPrincipal,
    pub(crate) permissions: u64,
    pub(crate) flags: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DurabilityEvidence {
    pub(crate) filesystem_name: Vec<u8>,
    pub(crate) mount_flags: u32,
    pub(crate) source_name: Vec<u8>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct LockRequest {
    pub(crate) lock_type: i16,
    pub(crate) whence: i16,
    pub(crate) start: i64,
    pub(crate) length: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct SyscallError(pub(crate) i32);

impl SyscallError {
    pub(crate) fn is(self, errno: i32) -> bool {
        self.0 == errno
    }
}

pub(crate) trait DarwinSyscalls: Send + Sync + 'static {
    fn credentials(&self) -> Credentials;
    fn account_home(&self, uid: u32) -> Result<OsString, PlatformStoreFailure>;
    fn open_root(&self, flags: i32) -> Result<RawFd, SyscallError>;
    fn open_at(
        &self,
        parent: RawFd,
        component: &CStr,
        flags: i32,
        mode: u32,
    ) -> Result<RawFd, SyscallError>;
    fn mkdir_at(&self, parent: RawFd, component: &CStr, mode: u32) -> Result<(), SyscallError>;
    fn stat(&self, fd: RawFd) -> Result<FileMetadata, SyscallError>;
    fn stat_at(
        &self,
        parent: RawFd,
        component: &CStr,
        flags: i32,
    ) -> Result<FileMetadata, SyscallError>;
    fn acl(&self, fd: RawFd) -> Result<Vec<AclEntry>, PlatformStoreFailure>;
    fn durability_evidence(&self, fd: RawFd) -> Result<DurabilityEvidence, SyscallError>;
    fn chmod(&self, fd: RawFd, mode: u32) -> Result<(), SyscallError>;
    fn truncate(&self, fd: RawFd, length: u64) -> Result<(), SyscallError>;
    fn get_fd_flags(&self, fd: RawFd) -> Result<i32, SyscallError>;
    fn set_lock(&self, fd: RawFd, request: LockRequest) -> Result<(), SyscallError>;
    fn pread(&self, fd: RawFd, output: &mut [u8], offset: u64) -> Result<usize, SyscallError>;
    fn pwrite(&self, fd: RawFd, bytes: &[u8], offset: u64) -> Result<usize, SyscallError>;
    fn full_sync(&self, fd: RawFd) -> Result<(), SyscallError>;
    fn sync(&self, fd: RawFd) -> Result<(), SyscallError>;
    fn sync_volume(&self, fd: RawFd, flags: i32) -> Result<(), SyscallError>;
    fn close(&self, fd: RawFd) -> Result<(), SyscallError>;
}

#[derive(Debug)]
pub(crate) struct NativeDarwinSyscalls;

impl NativeDarwinSyscalls {
    fn errno() -> SyscallError {
        SyscallError(
            io::Error::last_os_error()
                .raw_os_error()
                .unwrap_or(libc::EIO),
        )
    }
}

impl DarwinSyscalls for NativeDarwinSyscalls {
    fn credentials(&self) -> Credentials {
        Credentials {
            real_uid: unsafe { libc::getuid() },
            effective_uid: unsafe { libc::geteuid() },
            real_gid: unsafe { libc::getgid() },
            effective_gid: unsafe { libc::getegid() },
        }
    }

    fn account_home(&self, uid: u32) -> Result<OsString, PlatformStoreFailure> {
        let mut capacity = 16 * 1024_usize;
        loop {
            let mut record = mem::MaybeUninit::<libc::passwd>::uninit();
            let mut result = ptr::null_mut();
            let mut buffer = vec![0_u8; capacity];
            let status = unsafe {
                libc::getpwuid_r(
                    uid,
                    record.as_mut_ptr(),
                    buffer.as_mut_ptr().cast(),
                    buffer.len(),
                    &mut result,
                )
            };
            if status == libc::ERANGE && capacity < 1024 * 1024 {
                capacity *= 2;
                continue;
            }
            if status != 0 {
                return Err(PlatformStoreFailure::Io);
            }
            if result.is_null() {
                return Err(PlatformStoreFailure::PermissionInvalid);
            }
            let record = unsafe { record.assume_init() };
            if record.pw_dir.is_null() {
                return Err(PlatformStoreFailure::PermissionInvalid);
            }
            let bytes = unsafe { CStr::from_ptr(record.pw_dir) }.to_bytes().to_vec();
            return Ok(OsString::from_vec(bytes));
        }
    }

    fn open_root(&self, flags: i32) -> Result<RawFd, SyscallError> {
        let root = c"/";
        let fd = unsafe { libc::open(root.as_ptr(), flags) };
        if fd < 0 {
            Err(Self::errno())
        } else {
            Ok(fd)
        }
    }

    fn open_at(
        &self,
        parent: RawFd,
        component: &CStr,
        flags: i32,
        mode: u32,
    ) -> Result<RawFd, SyscallError> {
        let fd = unsafe { libc::openat(parent, component.as_ptr(), flags, mode as libc::c_uint) };
        if fd < 0 {
            Err(Self::errno())
        } else {
            Ok(fd)
        }
    }

    fn mkdir_at(&self, parent: RawFd, component: &CStr, mode: u32) -> Result<(), SyscallError> {
        if unsafe { libc::mkdirat(parent, component.as_ptr(), mode as libc::mode_t) } == 0 {
            Ok(())
        } else {
            Err(Self::errno())
        }
    }

    fn stat(&self, fd: RawFd) -> Result<FileMetadata, SyscallError> {
        let mut value = mem::MaybeUninit::<libc::stat>::uninit();
        if unsafe { libc::fstat(fd, value.as_mut_ptr()) } != 0 {
            return Err(Self::errno());
        }
        Ok(metadata(unsafe { value.assume_init() }))
    }

    fn stat_at(
        &self,
        parent: RawFd,
        component: &CStr,
        flags: i32,
    ) -> Result<FileMetadata, SyscallError> {
        let mut value = mem::MaybeUninit::<libc::stat>::uninit();
        if unsafe { libc::fstatat(parent, component.as_ptr(), value.as_mut_ptr(), flags) } != 0 {
            return Err(Self::errno());
        }
        Ok(metadata(unsafe { value.assume_init() }))
    }

    fn acl(&self, fd: RawFd) -> Result<Vec<AclEntry>, PlatformStoreFailure> {
        let acl = unsafe { acl_get_fd_np(fd, ACL_TYPE_EXTENDED) };
        if acl.is_null() {
            return match Self::errno().0 {
                libc::EOPNOTSUPP | libc::EINVAL => Err(PlatformStoreFailure::PermissionInvalid),
                _ => Err(PlatformStoreFailure::Io),
            };
        }
        let result = read_acl(acl);
        let free_status = unsafe { acl_free(acl) };
        if free_status != 0 && result.is_ok() {
            return Err(PlatformStoreFailure::Io);
        }
        result
    }

    fn durability_evidence(&self, fd: RawFd) -> Result<DurabilityEvidence, SyscallError> {
        let mut value = mem::MaybeUninit::<libc::statfs>::uninit();
        if unsafe { libc::fstatfs(fd, value.as_mut_ptr()) } != 0 {
            return Err(Self::errno());
        }
        let value = unsafe { value.assume_init() };
        Ok(DurabilityEvidence {
            filesystem_name: fixed_c_string_bytes(&value.f_fstypename),
            mount_flags: value.f_flags,
            source_name: fixed_c_string_bytes(&value.f_mntfromname),
        })
    }

    fn chmod(&self, fd: RawFd, mode: u32) -> Result<(), SyscallError> {
        if unsafe { libc::fchmod(fd, mode as libc::mode_t) } == 0 {
            Ok(())
        } else {
            Err(Self::errno())
        }
    }

    fn truncate(&self, fd: RawFd, length: u64) -> Result<(), SyscallError> {
        let length = i64::try_from(length).map_err(|_| SyscallError(libc::EOVERFLOW))?;
        if unsafe { libc::ftruncate(fd, length) } == 0 {
            Ok(())
        } else {
            Err(Self::errno())
        }
    }

    fn get_fd_flags(&self, fd: RawFd) -> Result<i32, SyscallError> {
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
        if flags < 0 {
            Err(Self::errno())
        } else {
            Ok(flags)
        }
    }

    fn set_lock(&self, fd: RawFd, request: LockRequest) -> Result<(), SyscallError> {
        let lock = libc::flock {
            l_start: request.start,
            l_len: request.length,
            l_pid: 0,
            l_type: request.lock_type,
            l_whence: request.whence,
        };
        if unsafe { libc::fcntl(fd, libc::F_SETLK, &lock) } == 0 {
            Ok(())
        } else {
            Err(Self::errno())
        }
    }

    fn pread(&self, fd: RawFd, output: &mut [u8], offset: u64) -> Result<usize, SyscallError> {
        let offset = i64::try_from(offset).map_err(|_| SyscallError(libc::EOVERFLOW))?;
        let count = unsafe { libc::pread(fd, output.as_mut_ptr().cast(), output.len(), offset) };
        if count < 0 {
            Err(Self::errno())
        } else {
            Ok(count as usize)
        }
    }

    fn pwrite(&self, fd: RawFd, bytes: &[u8], offset: u64) -> Result<usize, SyscallError> {
        let offset = i64::try_from(offset).map_err(|_| SyscallError(libc::EOVERFLOW))?;
        let count = unsafe { libc::pwrite(fd, bytes.as_ptr().cast(), bytes.len(), offset) };
        if count < 0 {
            Err(Self::errno())
        } else {
            Ok(count as usize)
        }
    }

    fn full_sync(&self, fd: RawFd) -> Result<(), SyscallError> {
        if unsafe { libc::fcntl(fd, libc::F_FULLFSYNC) } == 0 {
            Ok(())
        } else {
            Err(Self::errno())
        }
    }

    fn sync(&self, fd: RawFd) -> Result<(), SyscallError> {
        if unsafe { libc::fsync(fd) } == 0 {
            Ok(())
        } else {
            Err(Self::errno())
        }
    }

    fn sync_volume(&self, fd: RawFd, flags: i32) -> Result<(), SyscallError> {
        let status = unsafe { fsync_volume_np(fd, flags) };
        if status == 0 {
            Ok(())
        } else {
            // Darwin returns the error code directly for this primitive.
            Err(SyscallError(status))
        }
    }

    fn close(&self, fd: RawFd) -> Result<(), SyscallError> {
        if unsafe { libc::close(fd) } == 0 {
            Ok(())
        } else {
            Err(Self::errno())
        }
    }
}

fn metadata(value: libc::stat) -> FileMetadata {
    FileMetadata {
        device: value.st_dev as u64,
        inode: value.st_ino,
        mode: value.st_mode as u32,
        uid: value.st_uid,
        gid: value.st_gid,
        nlink: value.st_nlink as u64,
        size: value.st_size.max(0) as u64,
    }
}

fn fixed_c_string_bytes<const N: usize>(value: &[libc::c_char; N]) -> Vec<u8> {
    let end = value.iter().position(|byte| *byte == 0).unwrap_or(N);
    value[..end].iter().map(|byte| *byte as u8).collect()
}

fn read_acl(acl: Acl) -> Result<Vec<AclEntry>, PlatformStoreFailure> {
    let mut result = Vec::new();
    let mut entry = ptr::null_mut();
    let mut entry_id = ACL_FIRST_ENTRY;
    loop {
        let status = unsafe { acl_get_entry(acl, entry_id, &mut entry) };
        if status == 0 {
            return Ok(result);
        }
        if status < 0 || entry.is_null() {
            return Err(PlatformStoreFailure::Io);
        }
        entry_id = ACL_NEXT_ENTRY;

        let mut tag = 0;
        if unsafe { acl_get_tag_type(entry, &mut tag) } != 0 {
            return Err(PlatformStoreFailure::Io);
        }
        let allow = match tag {
            ACL_EXTENDED_ALLOW => true,
            ACL_EXTENDED_DENY => false,
            _ => return Err(PlatformStoreFailure::PermissionInvalid),
        };
        let qualifier = unsafe { acl_get_qualifier(entry) };
        if qualifier.is_null() {
            return Err(PlatformStoreFailure::PermissionInvalid);
        }
        let principal = resolve_principal(qualifier.cast());
        if unsafe { acl_free(qualifier) } != 0 {
            return Err(PlatformStoreFailure::Io);
        }

        let mut permissions = 0_u64;
        if unsafe { acl_get_permset_mask_np(entry, &mut permissions) } != 0 {
            return Err(PlatformStoreFailure::Io);
        }
        let mut flagset = ptr::null_mut();
        if unsafe { acl_get_flagset_np(entry, &mut flagset) } != 0 || flagset.is_null() {
            return Err(PlatformStoreFailure::Io);
        }
        let mut flags = 0_u32;
        for flag in [1 << 4, 1 << 5, 1 << 6, 1 << 7, 1 << 8] {
            match unsafe { acl_get_flag_np(flagset, flag) } {
                1 => flags |= flag as u32,
                0 => {}
                _ => return Err(PlatformStoreFailure::Io),
            }
        }
        result.push(AclEntry {
            allow,
            principal,
            permissions,
            flags,
        });
    }
}

fn resolve_principal(uuid: *const u8) -> AclPrincipal {
    let mut id = 0;
    let mut id_type = -1;
    if unsafe { mbr_uuid_to_id(uuid, &mut id, &mut id_type) } != 0 {
        return AclPrincipal::Unknown;
    }
    match id_type {
        ID_TYPE_UID => AclPrincipal::User(id),
        ID_TYPE_GID => AclPrincipal::Group(id),
        _ => AclPrincipal::Unknown,
    }
}

pub(crate) fn c_component(component: &str) -> Result<CString, PlatformStoreFailure> {
    if component.is_empty() || component == "." || component == ".." || component.contains('/') {
        return Err(PlatformStoreFailure::IdentityUncertain);
    }
    CString::new(component.as_bytes()).map_err(|_| PlatformStoreFailure::IdentityUncertain)
}
