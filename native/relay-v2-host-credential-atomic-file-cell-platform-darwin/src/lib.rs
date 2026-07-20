#![cfg(target_os = "macos")]
#![forbid(unsafe_op_in_unsafe_fn)]

//! Darwin syscall adapter for the Host credential atomic-file-cell admission
//! owner. This crate owns no registry, journal, durability qualification, path
//! lookup, credential mutation, or production composition.

mod sys;

#[cfg(test)]
mod tests;

use relay_v2_host_credential_atomic_file_cell_platform_common::{
    platform_resource_spec, DescriptorRelativePlatform, EffectiveIdentity, Lookup, ObjectIdentity,
    ObjectKind, ObjectMetadata, PlatformFailure, RelativeResource,
};
use std::ffi::CString;
use std::fmt;
use std::os::fd::RawFd;

/// Sole descriptor representation used by the common admission owner.
///
/// It is deliberately neither `Clone` nor `Copy` and has no `Drop`
/// implementation. Common transfers each value exactly once to `raw_close`.
pub struct DarwinDescriptor {
    raw_fd: RawFd,
}

impl fmt::Debug for DarwinDescriptor {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("DarwinDescriptor(<owned-raw-fd>)")
    }
}

/// Stateless descriptor-relative Darwin syscall implementation.
pub struct DarwinDescriptorRelativePlatform {
    _private: (),
}

impl fmt::Debug for DarwinDescriptorRelativePlatform {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("DarwinDescriptorRelativePlatform")
    }
}

/// Explicit ownership-transfer value for a pre-bound directory descriptor.
/// Its fields have no implicit close behavior.
pub struct PreboundDirectory {
    platform: DarwinDescriptorRelativePlatform,
    directory: DarwinDescriptor,
}

impl fmt::Debug for PreboundDirectory {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("PreboundDirectory(<owned-raw-fd>)")
    }
}

impl PreboundDirectory {
    /// Transfers the adapter and sole directory descriptor to platform-common.
    pub fn into_platform_parts(self) -> (DarwinDescriptorRelativePlatform, DarwinDescriptor) {
        (self.platform, self.directory)
    }
}

/// Adopts sole ownership of an already-open directory descriptor.
///
/// # Safety
///
/// `raw_fd` must be a live directory descriptor owned by the caller. Ownership
/// is transferred to the returned value: the caller must not use or close the
/// descriptor afterward. The common owner validates directory identity,
/// ownership, mode, and `FD_CLOEXEC` before namespace mutation.
pub unsafe fn prebound_directory_from_owned_raw_fd(raw_fd: RawFd) -> PreboundDirectory {
    PreboundDirectory {
        platform: DarwinDescriptorRelativePlatform { _private: () },
        directory: DarwinDescriptor { raw_fd },
    }
}

fn resource_name(resource: RelativeResource) -> Result<CString, PlatformFailure> {
    let spec = platform_resource_spec();
    let name = match resource {
        RelativeResource::Lock => spec.lock_name(),
        RelativeResource::Claim => spec.claim_name(),
    };
    CString::new(name.as_bytes()).map_err(|_| PlatformFailure::IdentityUncertain)
}

fn map_errno(errno: libc::c_int) -> PlatformFailure {
    match errno {
        libc::EACCES | libc::EPERM => PlatformFailure::PermissionDenied,
        libc::ENOENT => PlatformFailure::NotFound,
        libc::EEXIST => PlatformFailure::AlreadyExists,
        libc::ELOOP | libc::ENOTDIR | libc::EISDIR | libc::ESTALE => {
            PlatformFailure::IdentityUncertain
        }
        _ => PlatformFailure::Io,
    }
}

fn metadata_from_stat(stat: &libc::stat) -> Result<ObjectMetadata, PlatformFailure> {
    if stat.st_size < 0 {
        return Err(PlatformFailure::IdentityUncertain);
    }
    let file_type = stat.st_mode & libc::S_IFMT;
    let kind = if file_type == libc::S_IFDIR {
        ObjectKind::Directory
    } else if file_type == libc::S_IFREG {
        ObjectKind::RegularFile
    } else if file_type == libc::S_IFLNK {
        ObjectKind::Symlink
    } else {
        ObjectKind::Other
    };
    Ok(ObjectMetadata {
        identity: ObjectIdentity {
            device: stat.st_dev as u64,
            inode: stat.st_ino as u64,
        },
        kind,
        owner_uid: stat.st_uid,
        owner_gid: stat.st_gid,
        mode: u32::from(stat.st_mode) & 0o7777,
        link_count: stat.st_nlink as u64,
        size_bytes: stat.st_size as u64,
    })
}

fn positional_attempt_limit(length: usize) -> usize {
    length.saturating_mul(2).saturating_add(8)
}

impl DescriptorRelativePlatform for DarwinDescriptorRelativePlatform {
    type Descriptor = DarwinDescriptor;

    fn effective_identity(&mut self) -> Result<EffectiveIdentity, PlatformFailure> {
        Ok(EffectiveIdentity {
            effective_uid: sys::effective_uid(),
            effective_gid: sys::effective_gid(),
        })
    }

    fn fstat(&mut self, descriptor: &Self::Descriptor) -> Result<ObjectMetadata, PlatformFailure> {
        let stat = sys::fstat(descriptor.raw_fd).map_err(map_errno)?;
        metadata_from_stat(&stat)
    }

    fn descriptor_has_cloexec(
        &mut self,
        descriptor: &Self::Descriptor,
    ) -> Result<bool, PlatformFailure> {
        let flags = sys::fcntl_getfd(descriptor.raw_fd).map_err(map_errno)?;
        Ok(flags & libc::FD_CLOEXEC != 0)
    }

    fn fstatat_nofollow(
        &mut self,
        directory: &Self::Descriptor,
        resource: RelativeResource,
    ) -> Result<Lookup, PlatformFailure> {
        let name = resource_name(resource)?;
        match sys::fstatat_nofollow(directory.raw_fd, &name) {
            Ok(stat) => metadata_from_stat(&stat).map(Lookup::Present),
            Err(libc::ENOENT) => Ok(Lookup::Absent),
            Err(errno) => Err(map_errno(errno)),
        }
    }

    fn open_lock_existing(
        &mut self,
        directory: &Self::Descriptor,
    ) -> Result<Self::Descriptor, PlatformFailure> {
        let name = resource_name(RelativeResource::Lock)?;
        let raw_fd = sys::openat_existing(
            directory.raw_fd,
            &name,
            libc::O_RDWR | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
        .map_err(map_errno)?;
        Ok(DarwinDescriptor { raw_fd })
    }

    fn create_lock_exclusive(
        &mut self,
        directory: &Self::Descriptor,
    ) -> Result<Self::Descriptor, PlatformFailure> {
        let name = resource_name(RelativeResource::Lock)?;
        let raw_fd = sys::openat_create(
            directory.raw_fd,
            &name,
            libc::O_RDWR | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_CREAT | libc::O_EXCL,
            0o600,
        )
        .map_err(map_errno)?;
        Ok(DarwinDescriptor { raw_fd })
    }

    fn try_lock_whole_file_nonblocking(
        &mut self,
        lock: &Self::Descriptor,
    ) -> Result<(), PlatformFailure> {
        match sys::fcntl_try_write_lock_whole_file(lock.raw_fd) {
            Ok(()) => Ok(()),
            Err(libc::EACCES | libc::EAGAIN) => Err(PlatformFailure::Busy),
            Err(errno) => Err(map_errno(errno)),
        }
    }

    fn create_claim_exclusive(
        &mut self,
        directory: &Self::Descriptor,
    ) -> Result<Self::Descriptor, PlatformFailure> {
        let name = resource_name(RelativeResource::Claim)?;
        let raw_fd = sys::openat_create(
            directory.raw_fd,
            &name,
            libc::O_RDWR | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
        .map_err(map_errno)?;
        Ok(DarwinDescriptor { raw_fd })
    }

    fn write_claim_from_start(
        &mut self,
        claim: &Self::Descriptor,
        bytes: &[u8],
    ) -> Result<(), PlatformFailure> {
        if bytes.len() != platform_resource_spec().claim_journal_length() {
            return Err(PlatformFailure::Io);
        }
        let mut written = 0_usize;
        for _ in 0..positional_attempt_limit(bytes.len()) {
            if written == bytes.len() {
                return Ok(());
            }
            match sys::pwrite(claim.raw_fd, &bytes[written..], written as libc::off_t) {
                Ok(0) => return Err(PlatformFailure::Io),
                Ok(count) if count <= bytes.len() - written => written += count,
                Ok(_) => return Err(PlatformFailure::Io),
                Err(libc::EINTR) => {}
                Err(errno) => return Err(map_errno(errno)),
            }
        }
        Err(PlatformFailure::Io)
    }

    fn read_claim_exact(
        &mut self,
        claim: &Self::Descriptor,
        output: &mut [u8],
    ) -> Result<(), PlatformFailure> {
        if output.len() != platform_resource_spec().claim_journal_length() {
            return Err(PlatformFailure::Io);
        }
        let mut read = 0_usize;
        for _ in 0..positional_attempt_limit(output.len()) {
            if read == output.len() {
                return Ok(());
            }
            match sys::pread(claim.raw_fd, &mut output[read..], read as libc::off_t) {
                Ok(0) => return Err(PlatformFailure::Io),
                Ok(count) if count <= output.len() - read => read += count,
                Ok(_) => return Err(PlatformFailure::Io),
                Err(libc::EINTR) => {}
                Err(errno) => return Err(map_errno(errno)),
            }
        }
        Err(PlatformFailure::Io)
    }

    fn fsync_claim(&mut self, claim: &Self::Descriptor) -> Result<(), PlatformFailure> {
        sys::fsync(claim.raw_fd).map_err(map_errno)
    }

    fn fsync_directory(&mut self, directory: &Self::Descriptor) -> Result<(), PlatformFailure> {
        sys::fsync(directory.raw_fd).map_err(map_errno)
    }

    fn unlink_claim(&mut self, directory: &Self::Descriptor) -> Result<(), PlatformFailure> {
        let name = resource_name(RelativeResource::Claim)?;
        match sys::unlinkat_file(directory.raw_fd, &name) {
            Ok(()) => Ok(()),
            Err(libc::EPERM | libc::EISDIR) => Err(PlatformFailure::IdentityUncertain),
            Err(errno) => Err(map_errno(errno)),
        }
    }

    fn raw_close(&mut self, descriptor: Self::Descriptor) -> Result<(), PlatformFailure> {
        sys::close_once(descriptor.raw_fd).map_err(map_errno)
    }
}
