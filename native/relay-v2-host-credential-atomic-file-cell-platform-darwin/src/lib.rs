#![cfg(target_os = "macos")]
#![forbid(unsafe_op_in_unsafe_fn)]

//! Darwin syscall adapter for the Host credential atomic-file-cell admission
//! and mutation owner. This crate owns no registry, journal, mutation state,
//! durability qualification, path lookup, or production composition.

mod sys;

#[cfg(test)]
mod tests;

use relay_v2_host_credential_atomic_file_cell_platform_common::{
    platform_resource_spec, CredentialMutationPlatform, DescriptorRelativePlatform,
    EffectiveIdentity, Lookup, ObjectIdentity, ObjectKind, ObjectMetadata, PlatformFailure,
    RelativeResource, TEMPORARY_ENTROPY_BYTES, TEMPORARY_PREFIX,
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

fn credential_name() -> Result<CString, PlatformFailure> {
    CString::new(platform_resource_spec().credential_name().as_bytes())
        .map_err(|_| PlatformFailure::IdentityUncertain)
}

fn temporary_name(name: &str) -> Result<CString, PlatformFailure> {
    let suffix_length = TEMPORARY_ENTROPY_BYTES
        .checked_mul(2)
        .ok_or(PlatformFailure::IdentityUncertain)?;
    let expected_length = TEMPORARY_PREFIX
        .len()
        .checked_add(suffix_length)
        .ok_or(PlatformFailure::IdentityUncertain)?;
    let bytes = name.as_bytes();
    if bytes.len() != expected_length || !bytes.starts_with(TEMPORARY_PREFIX.as_bytes()) {
        return Err(PlatformFailure::IdentityUncertain);
    }
    if !bytes[TEMPORARY_PREFIX.len()..]
        .iter()
        .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        return Err(PlatformFailure::IdentityUncertain);
    }
    CString::new(bytes).map_err(|_| PlatformFailure::IdentityUncertain)
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

fn positional_offset(offset: usize) -> Result<libc::off_t, PlatformFailure> {
    libc::off_t::try_from(offset).map_err(|_| PlatformFailure::Io)
}

fn positional_write_all(raw_fd: RawFd, bytes: &[u8]) -> Result<(), PlatformFailure> {
    let mut written = 0_usize;
    for _ in 0..positional_attempt_limit(bytes.len()) {
        if written == bytes.len() {
            return Ok(());
        }
        let offset = positional_offset(written)?;
        match sys::pwrite(raw_fd, &bytes[written..], offset) {
            Ok(0) => return Err(PlatformFailure::Io),
            Ok(count) if count <= bytes.len() - written => written += count,
            Ok(_) => return Err(PlatformFailure::Io),
            Err(libc::EINTR) => {}
            Err(errno) => return Err(map_errno(errno)),
        }
    }
    Err(PlatformFailure::Io)
}

fn positional_read_exact(
    raw_fd: RawFd,
    output: &mut [u8],
    prove_eof: bool,
) -> Result<(), PlatformFailure> {
    let mut read = 0_usize;
    let eof_attempt = if prove_eof { 1 } else { 0 };
    let attempt_limit = positional_attempt_limit(output.len().saturating_add(eof_attempt));
    let mut attempts = 0_usize;
    while read < output.len() && attempts < attempt_limit {
        attempts += 1;
        let offset = positional_offset(read)?;
        match sys::pread(raw_fd, &mut output[read..], offset) {
            Ok(0) => return Err(PlatformFailure::Io),
            Ok(count) if count <= output.len() - read => read += count,
            Ok(_) => return Err(PlatformFailure::Io),
            Err(libc::EINTR) => {}
            Err(errno) => return Err(map_errno(errno)),
        }
    }
    if read != output.len() {
        return Err(PlatformFailure::Io);
    }
    if !prove_eof {
        return Ok(());
    }

    let mut trailing = [0_u8; 1];
    while attempts < attempt_limit {
        attempts += 1;
        let offset = positional_offset(output.len())?;
        match sys::pread(raw_fd, &mut trailing, offset) {
            Ok(0) => return Ok(()),
            Ok(_) => return Err(PlatformFailure::Io),
            Err(libc::EINTR) => {}
            Err(errno) => return Err(map_errno(errno)),
        }
    }
    Err(PlatformFailure::Io)
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
        positional_write_all(claim.raw_fd, bytes)
    }

    fn read_claim_exact(
        &mut self,
        claim: &Self::Descriptor,
        output: &mut [u8],
    ) -> Result<(), PlatformFailure> {
        if output.len() != platform_resource_spec().claim_journal_length() {
            return Err(PlatformFailure::Io);
        }
        positional_read_exact(claim.raw_fd, output, false)
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

impl CredentialMutationPlatform for DarwinDescriptorRelativePlatform {
    fn fstatat_credential_nofollow(
        &mut self,
        directory: &Self::Descriptor,
    ) -> Result<Lookup, PlatformFailure> {
        let name = credential_name()?;
        match sys::fstatat_nofollow(directory.raw_fd, &name) {
            Ok(stat) => metadata_from_stat(&stat).map(Lookup::Present),
            Err(libc::ENOENT) => Ok(Lookup::Absent),
            Err(errno) => Err(map_errno(errno)),
        }
    }

    fn open_credential_readonly(
        &mut self,
        directory: &Self::Descriptor,
    ) -> Result<Self::Descriptor, PlatformFailure> {
        let name = credential_name()?;
        let raw_fd = sys::openat_existing(
            directory.raw_fd,
            &name,
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
        .map_err(map_errno)?;
        Ok(DarwinDescriptor { raw_fd })
    }

    fn read_file_exact(
        &mut self,
        descriptor: &Self::Descriptor,
        output: &mut [u8],
    ) -> Result<(), PlatformFailure> {
        positional_read_exact(descriptor.raw_fd, output, true)
    }

    fn fstatat_temporary_nofollow(
        &mut self,
        directory: &Self::Descriptor,
        temporary_name_value: &str,
    ) -> Result<Lookup, PlatformFailure> {
        let name = temporary_name(temporary_name_value)?;
        match sys::fstatat_nofollow(directory.raw_fd, &name) {
            Ok(stat) => metadata_from_stat(&stat).map(Lookup::Present),
            Err(libc::ENOENT) => Ok(Lookup::Absent),
            Err(errno) => Err(map_errno(errno)),
        }
    }

    fn create_temporary_exclusive(
        &mut self,
        directory: &Self::Descriptor,
        temporary_name_value: &str,
    ) -> Result<Self::Descriptor, PlatformFailure> {
        let name = temporary_name(temporary_name_value)?;
        let raw_fd = sys::openat_create(
            directory.raw_fd,
            &name,
            libc::O_RDWR | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
        .map_err(map_errno)?;
        Ok(DarwinDescriptor { raw_fd })
    }

    fn write_temporary_from_start(
        &mut self,
        temporary: &Self::Descriptor,
        bytes: &[u8],
    ) -> Result<(), PlatformFailure> {
        positional_write_all(temporary.raw_fd, bytes)
    }

    fn fsync_temporary(&mut self, temporary: &Self::Descriptor) -> Result<(), PlatformFailure> {
        sys::fsync(temporary.raw_fd).map_err(map_errno)
    }

    fn unlink_temporary(
        &mut self,
        directory: &Self::Descriptor,
        temporary_name_value: &str,
    ) -> Result<(), PlatformFailure> {
        let name = temporary_name(temporary_name_value)?;
        match sys::unlinkat_file(directory.raw_fd, &name) {
            Ok(()) => Ok(()),
            Err(libc::EPERM | libc::EISDIR) => Err(PlatformFailure::IdentityUncertain),
            Err(errno) => Err(map_errno(errno)),
        }
    }

    fn rename_temporary_to_credential(
        &mut self,
        directory: &Self::Descriptor,
        temporary_name_value: &str,
    ) -> Result<(), PlatformFailure> {
        let temporary = temporary_name(temporary_name_value)?;
        let credential = credential_name()?;
        sys::renameat_same_directory(directory.raw_fd, &temporary, &credential).map_err(map_errno)
    }
}
