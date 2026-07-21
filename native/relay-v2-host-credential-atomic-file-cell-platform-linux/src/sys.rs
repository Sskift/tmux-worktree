use std::ffi::CStr;
use std::mem::MaybeUninit;

fn errno() -> libc::c_int {
    std::io::Error::last_os_error()
        .raw_os_error()
        .unwrap_or(libc::EIO)
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

/// Performs one close syscall and deliberately does not retry `EINTR`.
pub(crate) fn close_once(raw_fd: libc::c_int) -> Result<(), libc::c_int> {
    if unsafe { libc::close(raw_fd) } == 0 {
        Ok(())
    } else {
        Err(errno())
    }
}
