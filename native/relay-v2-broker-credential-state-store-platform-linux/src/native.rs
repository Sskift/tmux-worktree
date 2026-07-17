use crate::scaffold::{
    classify_acl_xattr_errno, open_with_policy, AclXattrKind, Credentials, DurabilityEvidence,
    EmptyQualificationAllowlist, FileKind, LinuxContainerCore, LinuxSyscalls, Metadata, SysError,
    TraditionalRecordLock,
};
use relay_v2_broker_credential_state_store_platform_common::{
    ContainerSpec, DescriptorOperationFence, FinalCloseOperationFence, NativeStoreErrorCode,
    PlatformStoreFailure, ProcessBoundStateStore, ProcessLifecycleToken, SoleContainer,
};
use std::ffi::{c_char, c_int, c_long, c_short, c_void, CStr, CString, OsStr};
use std::mem::MaybeUninit;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::ptr;
use std::sync::Arc;

#[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
compile_error!("the frozen loader exposes Linux artifacts only for x64 and arm64");

const AT_SYMLINK_NOFOLLOW: c_int = 0x100;
const F_GETFD: c_int = 1;
const F_SETLK: c_int = 6;
const F_WRLCK: c_short = 1;
const SEEK_SET: c_short = 0;
const S_IFMT: u32 = 0o170000;
const S_IFREG: u32 = 0o100000;
const S_IFDIR: u32 = 0o040000;
const S_IFLNK: u32 = 0o120000;
const EINTR: i32 = 4;
const ENOENT: i32 = 2;
const EACCES: i32 = 13;
const EAGAIN: i32 = 11;
const EEXIST: i32 = 17;
const ENOTDIR: i32 = 20;
const EISDIR: i32 = 21;
const ERANGE: i32 = 34;
const ELOOP: i32 = 40;
const ENODATA: i32 = 61;
const MAX_ACCOUNT_BUFFER: usize = 1024 * 1024;

#[cfg(target_arch = "x86_64")]
#[repr(C)]
struct LinuxStat {
    st_dev: u64,
    st_ino: u64,
    st_nlink: u64,
    st_mode: u32,
    st_uid: u32,
    st_gid: u32,
    __pad0: i32,
    st_rdev: u64,
    st_size: i64,
    st_blksize: i64,
    st_blocks: i64,
    st_atime: i64,
    st_atime_nsec: i64,
    st_mtime: i64,
    st_mtime_nsec: i64,
    st_ctime: i64,
    st_ctime_nsec: i64,
    __unused: [i64; 3],
}

#[cfg(target_arch = "aarch64")]
#[repr(C)]
struct LinuxStat {
    st_dev: u64,
    st_ino: u64,
    st_mode: u32,
    st_nlink: u32,
    st_uid: u32,
    st_gid: u32,
    st_rdev: u64,
    __pad1: u64,
    st_size: i64,
    st_blksize: i32,
    __pad2: i32,
    st_blocks: i64,
    st_atime: i64,
    st_atime_nsec: i64,
    st_mtime: i64,
    st_mtime_nsec: i64,
    st_ctime: i64,
    st_ctime_nsec: i64,
    __unused4: u32,
    __unused5: u32,
}

#[repr(C)]
struct LinuxStatFs {
    f_type: c_long,
    f_bsize: c_long,
    f_blocks: u64,
    f_bfree: u64,
    f_bavail: u64,
    f_files: u64,
    f_ffree: u64,
    f_fsid: [c_int; 2],
    f_namelen: c_long,
    f_frsize: c_long,
    f_flags: c_long,
    f_spare: [c_long; 4],
}

#[repr(C)]
struct Passwd {
    pw_name: *mut c_char,
    pw_passwd: *mut c_char,
    pw_uid: u32,
    pw_gid: u32,
    pw_gecos: *mut c_char,
    pw_dir: *mut c_char,
    pw_shell: *mut c_char,
}

#[repr(C)]
struct Flock {
    l_type: c_short,
    l_whence: c_short,
    l_start: i64,
    l_len: i64,
    l_pid: i32,
}

unsafe extern "C" {
    fn getuid() -> u32;
    fn geteuid() -> u32;
    fn getgid() -> u32;
    fn getegid() -> u32;
    fn getpwuid_r(
        uid: u32,
        pwd: *mut Passwd,
        buffer: *mut c_char,
        buffer_length: usize,
        result: *mut *mut Passwd,
    ) -> c_int;
    #[link_name = "open"]
    fn c_open(path: *const c_char, flags: c_int, ...) -> c_int;
    #[link_name = "openat"]
    fn c_openat(directory: c_int, path: *const c_char, flags: c_int, ...) -> c_int;
    #[link_name = "mkdirat"]
    fn c_mkdirat(directory: c_int, path: *const c_char, mode: u32) -> c_int;
    #[link_name = "fstat"]
    fn c_fstat(fd: c_int, output: *mut LinuxStat) -> c_int;
    #[link_name = "fstatat"]
    fn c_fstatat(
        directory: c_int,
        path: *const c_char,
        output: *mut LinuxStat,
        flags: c_int,
    ) -> c_int;
    #[link_name = "fstatfs"]
    fn c_fstatfs(fd: c_int, output: *mut LinuxStatFs) -> c_int;
    #[link_name = "fgetxattr"]
    fn c_fgetxattr(fd: c_int, name: *const c_char, value: *mut c_void, size: usize) -> isize;
    #[link_name = "fchmod"]
    fn c_fchmod(fd: c_int, mode: u32) -> c_int;
    #[link_name = "ftruncate"]
    fn c_ftruncate(fd: c_int, length: i64) -> c_int;
    #[link_name = "fcntl"]
    fn c_fcntl(fd: c_int, command: c_int, ...) -> c_int;
    #[link_name = "pread"]
    fn c_pread(fd: c_int, output: *mut c_void, count: usize, offset: i64) -> isize;
    #[link_name = "pwrite"]
    fn c_pwrite(fd: c_int, bytes: *const c_void, count: usize, offset: i64) -> isize;
    #[link_name = "fsync"]
    fn c_fsync(fd: c_int) -> c_int;
    #[link_name = "close"]
    fn c_close(fd: c_int) -> c_int;
}

pub struct LinuxSoleContainer {
    core: LinuxContainerCore<NativeLinuxSyscalls>,
}

impl LinuxSoleContainer {
    fn from_core(core: LinuxContainerCore<NativeLinuxSyscalls>) -> Self {
        Self { core }
    }
}

impl SoleContainer for LinuxSoleContainer {
    fn complete_platform_open(
        &mut self,
        fence: &DescriptorOperationFence,
        spec: &ContainerSpec,
    ) -> Result<(), PlatformStoreFailure> {
        self.core.complete_platform_open(fence, spec)
    }

    fn file_length(&self, fence: &DescriptorOperationFence) -> Result<u64, PlatformStoreFailure> {
        self.core.file_length(fence)
    }

    fn read_exact_at(
        &self,
        fence: &DescriptorOperationFence,
        absolute_offset: u64,
        output: &mut [u8],
    ) -> Result<(), PlatformStoreFailure> {
        self.core.read_exact_at(fence, absolute_offset, output)
    }

    fn write_all_at(
        &mut self,
        fence: &DescriptorOperationFence,
        absolute_offset: u64,
        bytes: &[u8],
    ) -> Result<(), PlatformStoreFailure> {
        self.core.write_all_at(fence, absolute_offset, bytes)
    }

    fn payload_durability_barrier(
        &mut self,
        fence: &DescriptorOperationFence,
    ) -> Result<(), PlatformStoreFailure> {
        self.core.payload_durability_barrier(fence)
    }

    fn header_and_container_durability_barrier(
        &mut self,
        fence: &DescriptorOperationFence,
    ) -> Result<(), PlatformStoreFailure> {
        self.core.header_and_container_durability_barrier(fence)
    }

    fn final_close(
        &mut self,
        fence: &FinalCloseOperationFence,
    ) -> Result<(), PlatformStoreFailure> {
        self.core.final_close(fence)
    }
}

pub(crate) fn open(
    lifecycle: &ProcessLifecycleToken,
    trusted_home: &Path,
) -> Result<ProcessBoundStateStore<LinuxSoleContainer>, NativeStoreErrorCode> {
    open_with_policy(
        Arc::new(NativeLinuxSyscalls),
        lifecycle,
        trusted_home,
        &EmptyQualificationAllowlist,
        LinuxSoleContainer::from_core,
    )
}

pub(crate) struct NativeLinuxSyscalls;

impl LinuxSyscalls for NativeLinuxSyscalls {
    fn credential_snapshot(&self) -> Result<Credentials, SysError> {
        // These native credential calls are deliberately the first operations
        // in the platform entry point, before any path/account observation.
        Ok(Credentials {
            real_uid: unsafe { getuid() },
            effective_uid: unsafe { geteuid() },
            real_gid: unsafe { getgid() },
            effective_gid: unsafe { getegid() },
        })
    }

    fn account_home(&self, effective_uid: u32) -> Result<Option<PathBuf>, SysError> {
        let mut size = 16 * 1024;
        loop {
            let mut buffer = vec![0_u8; size];
            let mut pwd = MaybeUninit::<Passwd>::zeroed();
            let mut result = ptr::null_mut();
            let status = unsafe {
                getpwuid_r(
                    effective_uid,
                    pwd.as_mut_ptr(),
                    buffer.as_mut_ptr().cast(),
                    buffer.len(),
                    &mut result,
                )
            };
            if status == ERANGE && size < MAX_ACCOUNT_BUFFER {
                size = (size * 2).min(MAX_ACCOUNT_BUFFER);
                continue;
            }
            if status != 0 {
                return Err(errno_to_sys(status));
            }
            if result.is_null() {
                return Ok(None);
            }
            let pwd = unsafe { pwd.assume_init() };
            if pwd.pw_dir.is_null() {
                return Err(SysError::Other);
            }
            let bytes = unsafe { CStr::from_ptr(pwd.pw_dir) }.to_bytes();
            return Ok(Some(PathBuf::from(OsStr::from_bytes(bytes))));
        }
    }

    fn open_root(&self, flags: i32) -> Result<i32, SysError> {
        let fd = unsafe { c_open(c"/".as_ptr(), flags) };
        cvt_fd(fd)
    }

    fn open_directory_at(
        &self,
        parent: i32,
        component: &OsStr,
        flags: i32,
    ) -> Result<i32, SysError> {
        let component = component_cstring(component)?;
        let fd = unsafe { c_openat(parent, component.as_ptr(), flags) };
        cvt_fd(fd)
    }

    fn mkdir_at(&self, parent: i32, component: &OsStr, mode: u32) -> Result<(), SysError> {
        let component = component_cstring(component)?;
        cvt_zero(unsafe { c_mkdirat(parent, component.as_ptr(), mode) })
    }

    fn open_file_at(
        &self,
        parent: i32,
        component: &OsStr,
        flags: i32,
        mode: u32,
    ) -> Result<i32, SysError> {
        let component = component_cstring(component)?;
        let fd = unsafe { c_openat(parent, component.as_ptr(), flags, mode) };
        cvt_fd(fd)
    }

    fn fstat(&self, fd: i32) -> Result<Metadata, SysError> {
        let mut value = MaybeUninit::<LinuxStat>::zeroed();
        cvt_zero(unsafe { c_fstat(fd, value.as_mut_ptr()) })?;
        metadata_from_stat(unsafe { value.assume_init() })
    }

    fn fstatat_nofollow(&self, parent: i32, component: &OsStr) -> Result<Metadata, SysError> {
        let component = component_cstring(component)?;
        let mut value = MaybeUninit::<LinuxStat>::zeroed();
        cvt_zero(unsafe {
            c_fstatat(
                parent,
                component.as_ptr(),
                value.as_mut_ptr(),
                AT_SYMLINK_NOFOLLOW,
            )
        })?;
        metadata_from_stat(unsafe { value.assume_init() })
    }

    fn acl_xattr_size(&self, fd: i32, kind: AclXattrKind) -> Result<Option<usize>, SysError> {
        let name = acl_xattr_name(kind);
        let size = unsafe { c_fgetxattr(fd, name.as_ptr(), ptr::null_mut(), 0) };
        if size < 0 {
            return match classify_acl_xattr_errno(last_errno()) {
                SysError::NoData => Ok(None),
                error => Err(error),
            };
        }
        usize::try_from(size)
            .map(Some)
            .map_err(|_| SysError::AclUnprovable)
    }

    fn acl_xattr_read(
        &self,
        fd: i32,
        kind: AclXattrKind,
        output: &mut [u8],
    ) -> Result<usize, SysError> {
        let name = acl_xattr_name(kind);
        let read =
            unsafe { c_fgetxattr(fd, name.as_ptr(), output.as_mut_ptr().cast(), output.len()) };
        if read < 0 {
            Err(classify_acl_xattr_errno(last_errno()))
        } else {
            usize::try_from(read).map_err(|_| SysError::AclUnprovable)
        }
    }

    fn durability_probe(&self, fd: i32) -> Result<DurabilityEvidence, SysError> {
        let target = self.fstat(fd)?;
        let mut filesystem = MaybeUninit::<LinuxStatFs>::zeroed();
        cvt_zero(unsafe { c_fstatfs(fd, filesystem.as_mut_ptr()) })?;
        let filesystem = unsafe { filesystem.assume_init() };
        Ok(DurabilityEvidence {
            target,
            filesystem_magic: filesystem.f_type as i64,
            filesystem_flags: filesystem.f_flags as u64,
            ordered_storage_evidence_complete: false,
        })
    }

    fn fchmod(&self, fd: i32, mode: u32) -> Result<(), SysError> {
        cvt_zero(unsafe { c_fchmod(fd, mode) })
    }

    fn ftruncate(&self, fd: i32, length: u64) -> Result<(), SysError> {
        let length = i64::try_from(length).map_err(|_| SysError::Other)?;
        cvt_zero(unsafe { c_ftruncate(fd, length) })
    }

    fn fcntl_getfd(&self, fd: i32) -> Result<i32, SysError> {
        let result = unsafe { c_fcntl(fd, F_GETFD) };
        if result < 0 {
            Err(last_error())
        } else {
            Ok(result)
        }
    }

    fn fcntl_setlk(&self, fd: i32, lock: TraditionalRecordLock) -> Result<(), SysError> {
        if !lock.write_lock || !lock.whence_is_seek_set {
            return Err(SysError::Other);
        }
        let mut native = Flock {
            l_type: F_WRLCK,
            l_whence: SEEK_SET,
            l_start: lock.start,
            l_len: lock.length,
            l_pid: 0,
        };
        cvt_zero(unsafe { c_fcntl(fd, F_SETLK, &mut native as *mut Flock) })
    }

    fn pread(&self, fd: i32, offset: u64, output: &mut [u8]) -> Result<usize, SysError> {
        let offset = i64::try_from(offset).map_err(|_| SysError::Other)?;
        let result = unsafe { c_pread(fd, output.as_mut_ptr().cast(), output.len(), offset) };
        cvt_count(result)
    }

    fn pwrite(&self, fd: i32, offset: u64, bytes: &[u8]) -> Result<usize, SysError> {
        let offset = i64::try_from(offset).map_err(|_| SysError::Other)?;
        let result = unsafe { c_pwrite(fd, bytes.as_ptr().cast(), bytes.len(), offset) };
        cvt_count(result)
    }

    fn fsync(&self, fd: i32) -> Result<(), SysError> {
        cvt_zero(unsafe { c_fsync(fd) })
    }

    fn close(&self, fd: i32) -> Result<(), SysError> {
        cvt_zero(unsafe { c_close(fd) })
    }
}

fn component_cstring(component: &OsStr) -> Result<CString, SysError> {
    let bytes = component.as_bytes();
    if bytes.is_empty() || bytes.contains(&b'/') {
        return Err(SysError::Other);
    }
    CString::new(bytes).map_err(|_| SysError::Other)
}

fn metadata_from_stat(value: LinuxStat) -> Result<Metadata, SysError> {
    let kind = match value.st_mode & S_IFMT {
        S_IFDIR => FileKind::Directory,
        S_IFREG => FileKind::Regular,
        S_IFLNK => FileKind::Symlink,
        _ => FileKind::Special,
    };
    Ok(Metadata {
        device: value.st_dev,
        inode: value.st_ino,
        kind,
        mode: value.st_mode & 0o7777,
        uid: value.st_uid,
        gid: value.st_gid,
        links: value.st_nlink as u64,
        size: u64::try_from(value.st_size).map_err(|_| SysError::Other)?,
    })
}

fn acl_xattr_name(kind: AclXattrKind) -> &'static CStr {
    match kind {
        AclXattrKind::Access => c"system.posix_acl_access",
        AclXattrKind::Default => c"system.posix_acl_default",
    }
}

fn cvt_fd(value: c_int) -> Result<i32, SysError> {
    if value < 0 {
        Err(last_error())
    } else {
        Ok(value)
    }
}

fn cvt_zero(value: c_int) -> Result<(), SysError> {
    if value == 0 {
        Ok(())
    } else {
        Err(last_error())
    }
}

fn cvt_count(value: isize) -> Result<usize, SysError> {
    if value < 0 {
        Err(last_error())
    } else {
        usize::try_from(value).map_err(|_| SysError::Other)
    }
}

fn last_errno() -> i32 {
    std::io::Error::last_os_error().raw_os_error().unwrap_or(-1)
}

fn last_error() -> SysError {
    errno_to_sys(last_errno())
}

fn errno_to_sys(errno: i32) -> SysError {
    match errno {
        ENOENT => SysError::NotFound,
        EEXIST => SysError::AlreadyExists,
        ELOOP => SysError::Symlink,
        ENOTDIR | EISDIR => SysError::WrongType,
        EACCES => SysError::Access,
        EAGAIN => SysError::Again,
        EINTR => SysError::Interrupted,
        ENODATA => SysError::NoData,
        _ => SysError::Other,
    }
}
