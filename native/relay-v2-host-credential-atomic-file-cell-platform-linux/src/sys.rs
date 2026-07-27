use std::ffi::CStr;
use std::mem::MaybeUninit;

fn errno() -> libc::c_int {
    std::io::Error::last_os_error()
        .raw_os_error()
        .unwrap_or(libc::EIO)
}

pub(crate) fn real_uid() -> u32 {
    unsafe { libc::getuid() }
}

pub(crate) fn real_gid() -> u32 {
    unsafe { libc::getgid() }
}

/// Closed account-database lookup failures for the trusted cell factory.
/// `Missing` means the effective uid has no account entry or no home; `Io`
/// means the account database itself could not be read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AccountHomeError {
    Missing,
    Io,
}

/// Native account-database home for `uid` (getpwuid family only; never the
/// HOME environment variable, a caller path, or a global lookup).
pub(crate) fn account_home(uid: u32) -> Result<Vec<u8>, AccountHomeError> {
    let mut capacity = 16 * 1024_usize;
    loop {
        let mut record = MaybeUninit::<libc::passwd>::uninit();
        let mut result = std::ptr::null_mut();
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
            return Err(AccountHomeError::Io);
        }
        if result.is_null() {
            return Err(AccountHomeError::Missing);
        }
        let record = unsafe { record.assume_init() };
        if record.pw_dir.is_null() {
            return Err(AccountHomeError::Missing);
        }
        return Ok(unsafe { CStr::from_ptr(record.pw_dir) }.to_bytes().to_vec());
    }
}

pub(crate) fn effective_uid() -> u32 {
    unsafe { libc::geteuid() }
}

pub(crate) fn effective_gid() -> u32 {
    unsafe { libc::getegid() }
}

pub(crate) fn fstat(raw_fd: libc::c_int) -> Result<libc::stat, libc::c_int> {
    let mut output = MaybeUninit::<libc::stat>::uninit();
    if unsafe { libc::fstat(raw_fd, output.as_mut_ptr()) } == 0 {
        Ok(unsafe { output.assume_init() })
    } else {
        Err(errno())
    }
}

pub(crate) fn fstatat_nofollow(
    directory_fd: libc::c_int,
    name: &CStr,
) -> Result<libc::stat, libc::c_int> {
    let mut output = MaybeUninit::<libc::stat>::uninit();
    if unsafe {
        libc::fstatat(
            directory_fd,
            name.as_ptr(),
            output.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } == 0
    {
        Ok(unsafe { output.assume_init() })
    } else {
        Err(errno())
    }
}

pub(crate) fn fcntl_getfd(raw_fd: libc::c_int) -> Result<libc::c_int, libc::c_int> {
    let result = unsafe { libc::fcntl(raw_fd, libc::F_GETFD) };
    if result >= 0 {
        Ok(result)
    } else {
        Err(errno())
    }
}

pub(crate) fn openat_existing(
    directory_fd: libc::c_int,
    name: &CStr,
    flags: libc::c_int,
) -> Result<libc::c_int, libc::c_int> {
    let result = unsafe { libc::openat(directory_fd, name.as_ptr(), flags) };
    if result >= 0 {
        Ok(result)
    } else {
        Err(errno())
    }
}

pub(crate) fn openat_create(
    directory_fd: libc::c_int,
    name: &CStr,
    flags: libc::c_int,
    mode: libc::mode_t,
) -> Result<libc::c_int, libc::c_int> {
    let result = unsafe { libc::openat(directory_fd, name.as_ptr(), flags, mode) };
    if result >= 0 {
        Ok(result)
    } else {
        Err(errno())
    }
}

pub(crate) fn fcntl_try_write_lock_whole_file(raw_fd: libc::c_int) -> Result<(), libc::c_int> {
    let mut lock = unsafe { std::mem::zeroed::<libc::flock>() };
    lock.l_type = libc::F_WRLCK as libc::c_short;
    lock.l_whence = libc::SEEK_SET as libc::c_short;
    lock.l_start = 0;
    lock.l_len = 0;
    let result = unsafe { libc::fcntl(raw_fd, libc::F_SETLK, &lock) };
    if result == 0 {
        Ok(())
    } else {
        Err(errno())
    }
}

pub(crate) fn pwrite(
    raw_fd: libc::c_int,
    bytes: &[u8],
    offset: libc::off_t,
) -> Result<usize, libc::c_int> {
    let result = unsafe {
        libc::pwrite(
            raw_fd,
            bytes.as_ptr().cast::<libc::c_void>(),
            bytes.len(),
            offset,
        )
    };
    if result >= 0 {
        Ok(result as usize)
    } else {
        Err(errno())
    }
}

pub(crate) fn pread(
    raw_fd: libc::c_int,
    output: &mut [u8],
    offset: libc::off_t,
) -> Result<usize, libc::c_int> {
    let result = unsafe {
        libc::pread(
            raw_fd,
            output.as_mut_ptr().cast::<libc::c_void>(),
            output.len(),
            offset,
        )
    };
    if result >= 0 {
        Ok(result as usize)
    } else {
        Err(errno())
    }
}

pub(crate) fn fsync(raw_fd: libc::c_int) -> Result<(), libc::c_int> {
    if unsafe { libc::fsync(raw_fd) } == 0 {
        Ok(())
    } else {
        Err(errno())
    }
}

pub(crate) fn unlinkat_file(directory_fd: libc::c_int, name: &CStr) -> Result<(), libc::c_int> {
    if unsafe { libc::unlinkat(directory_fd, name.as_ptr(), 0) } == 0 {
        Ok(())
    } else {
        Err(errno())
    }
}

pub(crate) fn renameat_same_directory(
    directory_fd: libc::c_int,
    source: &CStr,
    destination: &CStr,
) -> Result<(), libc::c_int> {
    if unsafe {
        libc::renameat(
            directory_fd,
            source.as_ptr(),
            directory_fd,
            destination.as_ptr(),
        )
    } == 0
    {
        Ok(())
    } else {
        Err(errno())
    }
}

/// Performs one close syscall and deliberately does not retry `EINTR`.
pub(crate) fn close_once(raw_fd: libc::c_int) -> Result<(), libc::c_int> {
    if unsafe { libc::close(raw_fd) } == 0 {
        Ok(())
    } else {
        Err(errno())
    }
}
