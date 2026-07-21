use super::*;
use relay_v2_host_credential_atomic_file_cell_platform_common::{
    DescriptorRelativePlatform, Lookup, ObjectKind, PlatformFailure, RelativeResource,
};
use std::ffi::CString;
use std::fs;
use std::io::{Read, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(1);
const CHILD_TIMEOUT: Duration = Duration::from_secs(5);

struct TestDirectory {
    path: PathBuf,
}

impl TestDirectory {
    fn new(label: &str) -> Self {
        let root = std::env::temp_dir();
        for _ in 0..128 {
            let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let path = root.join(format!(
                "tw-host-cell-linux-{label}-{}-{sequence}",
                std::process::id()
            ));
            let mut builder = fs::DirBuilder::new();
            builder.mode(0o700);
            match builder.create(&path) {
                Ok(()) => {
                    fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
                        .expect("set isolated directory mode");
                    return Self { path };
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("create isolated directory: {error}"),
            }
        }
        panic!("could not allocate isolated test directory")
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn open_directory_raw(path: &Path) -> RawFd {
    let path = CString::new(path.as_os_str().as_bytes()).expect("test path has no NUL");
    let raw_fd = unsafe {
        libc::open(
            path.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    assert!(
        raw_fd >= 0,
        "open isolated directory: {}",
        std::io::Error::last_os_error()
    );
    raw_fd
}

fn platform_for(path: &Path) -> (LinuxDescriptorRelativePlatform, LinuxDescriptor) {
    let raw_fd = open_directory_raw(path);
    let prebound = unsafe { prebound_directory_from_owned_raw_fd(raw_fd) };
    prebound.into_platform_parts()
}

fn descriptor_identity(
    platform: &mut LinuxDescriptorRelativePlatform,
    descriptor: &LinuxDescriptor,
) -> (u64, u64) {
    let metadata = platform.fstat(descriptor).expect("descriptor metadata");
    (metadata.identity.device, metadata.identity.inode)
}

fn spawn_probe(input: &str) {
    let mut child = Command::new(std::env::current_exe().expect("current test executable"))
        .arg("--ignored")
        .arg("--exact")
        .arg("tests::subprocess_probe")
        .arg("--nocapture")
        .arg("--test-threads=1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn exec probe");
    child
        .stdin
        .take()
        .expect("child stdin")
        .write_all(input.as_bytes())
        .expect("write child probe request");

    let deadline = Instant::now() + CHILD_TIMEOUT;
    loop {
        match child.try_wait().expect("poll child probe") {
            Some(_) => break,
            None if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(10));
            }
            None => {
                let _ = child.kill();
                let output = child.wait_with_output().expect("reap timed-out probe");
                panic!(
                    "subprocess probe timed out\nstdout:\n{}\nstderr:\n{}",
                    String::from_utf8_lossy(&output.stdout),
                    String::from_utf8_lossy(&output.stderr)
                );
            }
        }
    }
    let output = child.wait_with_output().expect("collect child probe");
    assert!(
        output.status.success(),
        "subprocess probe failed: {}\nstdout:\n{}\nstderr:\n{}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn child_lock_probe(path: &Path, expect_busy: bool) {
    let (mut platform, directory) = platform_for(path);
    let lock = platform
        .open_lock_existing(&directory)
        .expect("child opens existing lock");
    let result = platform.try_lock_whole_file_nonblocking(&lock);
    if expect_busy {
        assert_eq!(result, Err(PlatformFailure::Busy));
    } else {
        assert_eq!(result, Ok(()));
    }
    platform.raw_close(lock).expect("child closes lock once");
    platform
        .raw_close(directory)
        .expect("child closes directory once");
}

fn child_assert_descriptors_not_inherited(lines: impl Iterator<Item = String>) {
    for line in lines {
        let mut fields = line.split(' ');
        let raw_fd: RawFd = fields.next().expect("fd").parse().expect("numeric fd");
        let expected_device: u64 = fields
            .next()
            .expect("device")
            .parse()
            .expect("numeric device");
        let expected_inode: u64 = fields
            .next()
            .expect("inode")
            .parse()
            .expect("numeric inode");
        assert!(fields.next().is_none(), "closed descriptor probe fields");
        match sys::fstat(raw_fd) {
            Err(libc::EBADF) => {}
            Ok(stat) => assert_ne!(
                (stat.st_dev as u64, stat.st_ino as u64),
                (expected_device, expected_inode),
                "exec inherited the original descriptor identity at fd {raw_fd}"
            ),
            Err(errno) => panic!("unexpected fstat errno {errno} for fd {raw_fd}"),
        }
    }
}

#[test]
#[ignore = "subprocess/exec helper invoked by the parent tests"]
fn subprocess_probe() {
    let mut input = String::new();
    std::io::stdin()
        .read_to_string(&mut input)
        .expect("read child probe request");
    let mut lines = input.lines().map(str::to_owned);
    match lines.next().as_deref() {
        Some("LOCK_BUSY") => {
            let path = PathBuf::from(lines.next().expect("lock path"));
            assert!(lines.next().is_none());
            child_lock_probe(&path, true);
        }
        Some("LOCK_SUCCESS") => {
            let path = PathBuf::from(lines.next().expect("lock path"));
            assert!(lines.next().is_none());
            child_lock_probe(&path, false);
        }
        Some("NO_INHERIT") => child_assert_descriptors_not_inherited(lines),
        other => panic!("unknown child probe request {other:?}"),
    }
}

#[test]
fn exact_open_flags_modes_nofollow_and_no_truncate_are_kernel_backed() {
    let temporary = TestDirectory::new("flags");
    let (mut platform, directory) = platform_for(&temporary.path);
    let effective = platform.effective_identity().expect("effective identity");
    let directory_metadata = platform.fstat(&directory).expect("directory metadata");
    assert_eq!(directory_metadata.kind, ObjectKind::Directory);
    assert_eq!(directory_metadata.owner_uid, effective.effective_uid);
    assert_eq!(directory_metadata.owner_gid, effective.effective_gid);
    assert_eq!(directory_metadata.mode, 0o700);
    assert!(platform
        .descriptor_has_cloexec(&directory)
        .expect("directory F_GETFD"));

    let spec = platform_resource_spec();
    let target = temporary.path.join("nofollow-target");
    fs::write(&target, b"target").expect("write symlink target");
    let lock_path = temporary.path.join(spec.lock_name());
    std::os::unix::fs::symlink(&target, &lock_path).expect("create lock symlink");
    assert!(matches!(
        platform
            .fstatat_nofollow(&directory, RelativeResource::Lock)
            .expect("nofollow lock lookup"),
        Lookup::Present(metadata) if metadata.kind == ObjectKind::Symlink
    ));
    assert_eq!(
        platform.open_lock_existing(&directory).map(|_| ()),
        Err(PlatformFailure::IdentityUncertain)
    );
    assert_eq!(
        platform.create_lock_exclusive(&directory).map(|_| ()),
        Err(PlatformFailure::AlreadyExists)
    );
    fs::remove_file(&lock_path).expect("remove test lock symlink");
    assert_eq!(
        platform.open_lock_existing(&directory).map(|_| ()),
        Err(PlatformFailure::NotFound)
    );

    let lock = platform
        .create_lock_exclusive(&directory)
        .expect("exclusive lock create");
    let lock_metadata = platform.fstat(&lock).expect("created lock metadata");
    assert_eq!(lock_metadata.kind, ObjectKind::RegularFile);
    assert_eq!(lock_metadata.mode, 0o600);
    assert!(platform
        .descriptor_has_cloexec(&lock)
        .expect("lock F_GETFD"));
    assert_eq!(
        platform.create_lock_exclusive(&directory).map(|_| ()),
        Err(PlatformFailure::AlreadyExists)
    );
    let sentinel = b"existing-lock-is-not-truncated";
    assert_eq!(
        sys::pwrite(lock.raw_fd, sentinel, 0).expect("seed existing lock"),
        sentinel.len()
    );
    platform.raw_close(lock).expect("close created lock");

    let existing = platform
        .open_lock_existing(&directory)
        .expect("open existing lock without truncate");
    assert_eq!(
        platform
            .fstat(&existing)
            .expect("existing lock metadata")
            .size_bytes,
        sentinel.len() as u64
    );
    let mut observed = vec![0_u8; sentinel.len()];
    assert_eq!(
        sys::pread(existing.raw_fd, &mut observed, 0).expect("read existing lock"),
        sentinel.len()
    );
    assert_eq!(observed, sentinel);
    platform.raw_close(existing).expect("close existing lock");

    let claim_path = temporary.path.join(spec.claim_name());
    std::os::unix::fs::symlink(&target, &claim_path).expect("create claim symlink");
    assert!(matches!(
        platform
            .fstatat_nofollow(&directory, RelativeResource::Claim)
            .expect("nofollow claim lookup"),
        Lookup::Present(metadata) if metadata.kind == ObjectKind::Symlink
    ));
    assert_eq!(
        platform.create_claim_exclusive(&directory).map(|_| ()),
        Err(PlatformFailure::AlreadyExists)
    );
    fs::remove_file(&claim_path).expect("remove test claim symlink");
    let claim = platform
        .create_claim_exclusive(&directory)
        .expect("exclusive claim create");
    let claim_metadata = platform.fstat(&claim).expect("created claim metadata");
    assert_eq!(claim_metadata.kind, ObjectKind::RegularFile);
    assert_eq!(claim_metadata.mode, 0o600);
    assert!(platform
        .descriptor_has_cloexec(&claim)
        .expect("claim F_GETFD"));
    assert_eq!(
        platform.create_claim_exclusive(&directory).map(|_| ()),
        Err(PlatformFailure::AlreadyExists)
    );
    fs::remove_file(&claim_path).expect("remove held claim path");
    fs::create_dir(&claim_path).expect("replace held claim path with directory");
    assert_eq!(
        platform.unlink_claim(&directory),
        Err(PlatformFailure::IdentityUncertain)
    );
    fs::remove_dir(&claim_path).expect("remove claim directory replacement");
    platform.raw_close(claim).expect("close claim");

    fs::set_permissions(&temporary.path, fs::Permissions::from_mode(0o500))
        .expect("remove directory write permission");
    assert_eq!(
        platform.create_claim_exclusive(&directory).map(|_| ()),
        Err(PlatformFailure::PermissionDenied)
    );
    fs::set_permissions(&temporary.path, fs::Permissions::from_mode(0o700))
        .expect("restore directory permission");
    platform.raw_close(directory).expect("close directory once");
}

#[test]
fn linux_errno_mapping_keeps_lock_busy_narrow_and_identity_failures_closed() {
    for (errno, expected) in [
        (libc::ENOENT, PlatformFailure::NotFound),
        (libc::EEXIST, PlatformFailure::AlreadyExists),
        (libc::EACCES, PlatformFailure::PermissionDenied),
        (libc::EPERM, PlatformFailure::PermissionDenied),
        (libc::ELOOP, PlatformFailure::IdentityUncertain),
        (libc::ENOTDIR, PlatformFailure::IdentityUncertain),
        (libc::EISDIR, PlatformFailure::IdentityUncertain),
        (libc::ESTALE, PlatformFailure::IdentityUncertain),
        (libc::EAGAIN, PlatformFailure::Io),
        (libc::EIO, PlatformFailure::Io),
    ] {
        assert_eq!(map_errno(errno), expected, "Linux errno {errno}");
    }
    assert_eq!(
        map_unlink_errno(libc::EISDIR),
        PlatformFailure::IdentityUncertain
    );
    assert_eq!(
        map_unlink_errno(libc::EPERM),
        PlatformFailure::PermissionDenied
    );
}

#[test]
fn identity_symlink_type_and_link_races_remain_observable_to_common() {
    let temporary = TestDirectory::new("identity-races");
    let (mut platform, directory) = platform_for(&temporary.path);
    let spec = platform_resource_spec();
    let lock_path = temporary.path.join(spec.lock_name());
    let moved_lock_path = temporary.path.join("moved-lock");
    let hard_link_path = temporary.path.join("lock-hard-link");

    let lock = platform
        .create_lock_exclusive(&directory)
        .expect("create lock for identity checks");
    let original = platform.fstat(&lock).expect("original lock metadata");
    fs::hard_link(&lock_path, &hard_link_path).expect("create hard link race");
    assert!(matches!(
        platform
            .fstatat_nofollow(&directory, RelativeResource::Lock)
            .expect("observe linked lock"),
        Lookup::Present(metadata)
            if metadata.identity == original.identity && metadata.link_count == 2
    ));
    fs::remove_file(&hard_link_path).expect("remove hard link race");

    fs::rename(&lock_path, &moved_lock_path).expect("move held lock identity");
    fs::create_dir(&lock_path).expect("replace lock name with directory");
    let descriptor_after_replace = platform.fstat(&lock).expect("held lock remains regular");
    let path_after_replace = platform
        .fstatat_nofollow(&directory, RelativeResource::Lock)
        .expect("observe replacement type");
    assert_eq!(descriptor_after_replace.identity, original.identity);
    assert!(matches!(
        path_after_replace,
        Lookup::Present(metadata) if metadata.kind == ObjectKind::Directory
    ));
    assert_eq!(
        platform.open_lock_existing(&directory).map(|_| ()),
        Err(PlatformFailure::IdentityUncertain)
    );
    fs::remove_dir(&lock_path).expect("remove replacement directory");
    fs::rename(&moved_lock_path, &lock_path).expect("restore held lock name");

    let claim_path = temporary.path.join(spec.claim_name());
    let claim = platform
        .create_claim_exclusive(&directory)
        .expect("create claim for inode race");
    let held_claim = platform.fstat(&claim).expect("held claim identity");
    fs::remove_file(&claim_path).expect("unlink held claim name");
    fs::write(&claim_path, b"replacement").expect("replace claim with regular file");
    fs::set_permissions(&claim_path, fs::Permissions::from_mode(0o600))
        .expect("set replacement mode");
    let replacement = match platform
        .fstatat_nofollow(&directory, RelativeResource::Claim)
        .expect("observe replacement claim")
    {
        Lookup::Present(metadata) => metadata,
        Lookup::Absent => panic!("replacement claim missing"),
    };
    assert_eq!(held_claim.kind, ObjectKind::RegularFile);
    assert_eq!(replacement.kind, ObjectKind::RegularFile);
    assert_ne!(held_claim.identity, replacement.identity);

    platform
        .raw_close(claim)
        .expect("close unlinked held claim");
    platform.raw_close(lock).expect("close restored lock");
    platform.raw_close(directory).expect("close directory");
}

#[test]
fn claim_positional_io_is_bounded_fsynced_relative_and_never_truncates() {
    let temporary = TestDirectory::new("claim-io");
    let (mut platform, directory) = platform_for(&temporary.path);
    let claim = platform
        .create_claim_exclusive(&directory)
        .expect("create bounded claim");
    let length = platform_resource_spec().claim_journal_length();
    let bytes = (0..length)
        .map(|index| (index % 251) as u8)
        .collect::<Vec<_>>();

    assert_eq!(
        platform.write_claim_from_start(&claim, &bytes[..length - 1]),
        Err(PlatformFailure::Io)
    );
    assert_eq!(
        platform.fstat(&claim).expect("empty claim size").size_bytes,
        0
    );
    let mut eof = vec![0_u8; length];
    assert_eq!(
        platform.read_claim_exact(&claim, &mut eof),
        Err(PlatformFailure::Io)
    );

    platform
        .write_claim_from_start(&claim, &bytes)
        .expect("bounded pwrite");
    let trailing = b"preserved-trailing-bytes";
    assert_eq!(
        sys::pwrite(claim.raw_fd, trailing, length as libc::off_t)
            .expect("append trailing sentinel"),
        trailing.len()
    );
    let replacement = vec![0x5a; length];
    platform
        .write_claim_from_start(&claim, &replacement)
        .expect("rewrite fixed prefix without truncate");
    platform.fsync_claim(&claim).expect("claim fsync");
    assert_eq!(
        platform
            .fstat(&claim)
            .expect("non-truncated claim size")
            .size_bytes,
        (length + trailing.len()) as u64
    );

    let mut short = vec![0_u8; length - 1];
    assert_eq!(
        platform.read_claim_exact(&claim, &mut short),
        Err(PlatformFailure::Io)
    );
    let mut observed = vec![0_u8; length];
    platform
        .read_claim_exact(&claim, &mut observed)
        .expect("bounded pread");
    assert_eq!(observed, replacement);
    let mut observed_trailing = vec![0_u8; trailing.len()];
    assert_eq!(
        sys::pread(claim.raw_fd, &mut observed_trailing, length as libc::off_t,)
            .expect("read preserved suffix"),
        trailing.len()
    );
    assert_eq!(observed_trailing, trailing);

    platform
        .fsync_directory(&directory)
        .expect("directory fsync after create");
    platform
        .unlink_claim(&directory)
        .expect("fixed-name unlinkat");
    platform
        .fsync_directory(&directory)
        .expect("directory fsync after unlink");
    assert_eq!(
        platform
            .fstatat_nofollow(&directory, RelativeResource::Claim)
            .expect("claim absent"),
        Lookup::Absent
    );
    platform.raw_close(claim).expect("close unlinked claim");
    platform.raw_close(directory).expect("close directory");
}

#[test]
fn traditional_nonblocking_process_lock_is_busy_then_raw_close_releases_it() {
    let temporary = TestDirectory::new("process-lock");
    let (mut platform, directory) = platform_for(&temporary.path);
    let lock = platform
        .create_lock_exclusive(&directory)
        .expect("create process lock");
    platform
        .try_lock_whole_file_nonblocking(&lock)
        .expect("parent acquires F_SETLK");

    spawn_probe(&format!("LOCK_BUSY\n{}\n", temporary.path.display()));
    platform
        .raw_close(lock)
        .expect("parent raw close releases process lock");
    spawn_probe(&format!("LOCK_SUCCESS\n{}\n", temporary.path.display()));
    platform.raw_close(directory).expect("close directory");
}

#[test]
fn cloexec_inode_and_close_once_hold_across_exec_and_fd_reuse() {
    let temporary = TestDirectory::new("cloexec-close");
    let (mut platform, directory) = platform_for(&temporary.path);
    let lock = platform
        .create_lock_exclusive(&directory)
        .expect("create lock");
    let claim = platform
        .create_claim_exclusive(&directory)
        .expect("create claim");
    for descriptor in [&directory, &lock, &claim] {
        assert!(platform
            .descriptor_has_cloexec(descriptor)
            .expect("F_GETFD proves FD_CLOEXEC"));
    }

    let mut request = String::from("NO_INHERIT\n");
    for descriptor in [&directory, &lock, &claim] {
        let (device, inode) = descriptor_identity(&mut platform, descriptor);
        request.push_str(&format!("{} {device} {inode}\n", descriptor.raw_fd));
    }
    spawn_probe(&request);

    let claim_fd = claim.raw_fd;
    platform.raw_close(claim).expect("close claim once");
    assert!(matches!(
        sys::fstat(claim_fd),
        Err(errno) if errno == libc::EBADF
    ));
    let null_path = CString::new("/dev/null").expect("static path");
    let reused = unsafe { libc::open(null_path.as_ptr(), libc::O_RDONLY | libc::O_CLOEXEC) };
    assert!(reused >= 0, "open fd reuse probe");
    assert!(sys::fstat(reused).is_ok(), "reused descriptor stays open");
    sys::close_once(reused).expect("close fd reuse probe");

    platform.raw_close(lock).expect("close lock once");
    platform.raw_close(directory).expect("close directory once");
}

#[test]
fn dropping_the_raw_fd_newtype_has_no_implicit_close_side_effect() {
    let temporary = TestDirectory::new("inert-drop");
    let raw_fd = open_directory_raw(&temporary.path);
    let prebound = unsafe { prebound_directory_from_owned_raw_fd(raw_fd) };
    drop(prebound);
    assert!(
        sys::fstat(raw_fd).is_ok(),
        "raw descriptor was closed by Drop"
    );
    sys::close_once(raw_fd).expect("explicit single close after inert Drop");
}
