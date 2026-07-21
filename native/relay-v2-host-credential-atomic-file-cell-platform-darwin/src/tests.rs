use super::*;
use relay_v2_host_credential_atomic_file_cell_platform_common::{
    CredentialMutationPlatform, DescriptorRelativePlatform, Lookup, ObjectKind, PlatformFailure,
    RelativeResource, TEMPORARY_ENTROPY_BYTES, TEMPORARY_PREFIX,
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
                "tw-host-cell-darwin-{label}-{}-{sequence}",
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

fn platform_for(path: &Path) -> (DarwinDescriptorRelativePlatform, DarwinDescriptor) {
    let raw_fd = open_directory_raw(path);
    let prebound = unsafe { prebound_directory_from_owned_raw_fd(raw_fd) };
    prebound.into_platform_parts()
}

fn descriptor_identity(
    platform: &mut DarwinDescriptorRelativePlatform,
    descriptor: &DarwinDescriptor,
) -> (u64, u64) {
    let metadata = platform.fstat(descriptor).expect("descriptor metadata");
    (metadata.identity.device, metadata.identity.inode)
}

fn contract_temporary_name(hex_digit: u8) -> String {
    assert!(hex_digit.is_ascii_digit() || matches!(hex_digit, b'a'..=b'f'));
    format!(
        "{TEMPORARY_PREFIX}{}",
        char::from(hex_digit)
            .to_string()
            .repeat(TEMPORARY_ENTROPY_BYTES * 2)
    )
}

fn assert_raw_fd_closed(raw_fd: RawFd) {
    assert!(matches!(sys::fstat(raw_fd), Err(libc::EBADF)));
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
fn effective_identity_fstat_exact_flags_and_nofollow_are_real() {
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
    assert!(matches!(
        platform.open_lock_existing(&directory),
        Err(PlatformFailure::IdentityUncertain)
    ));
    assert!(matches!(
        platform.create_lock_exclusive(&directory),
        Err(PlatformFailure::AlreadyExists)
    ));
    fs::remove_file(&lock_path).expect("remove test lock symlink");

    fs::create_dir(&lock_path).expect("create lock directory replacement");
    match platform.open_lock_existing(&directory) {
        Err(PlatformFailure::IdentityUncertain) => {}
        Ok(unexpected) => {
            platform
                .raw_close(unexpected)
                .expect("close unexpected lock descriptor");
            panic!("lock directory replacement unexpectedly opened");
        }
        Err(other) => panic!("lock directory replacement mapped to {other:?}"),
    }
    fs::remove_dir(&lock_path).expect("remove lock directory replacement");

    let lock = platform
        .create_lock_exclusive(&directory)
        .expect("exclusive lock create");
    let lock_metadata = platform.fstat(&lock).expect("created lock metadata");
    assert_eq!(lock_metadata.kind, ObjectKind::RegularFile);
    assert_eq!(lock_metadata.mode, 0o600);
    assert!(platform
        .descriptor_has_cloexec(&lock)
        .expect("lock F_GETFD"));
    assert!(matches!(
        platform.create_lock_exclusive(&directory),
        Err(PlatformFailure::AlreadyExists)
    ));
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
    assert!(matches!(
        platform.create_claim_exclusive(&directory),
        Err(PlatformFailure::AlreadyExists)
    ));
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
    assert!(matches!(
        platform.create_claim_exclusive(&directory),
        Err(PlatformFailure::AlreadyExists)
    ));
    fs::remove_file(&claim_path).expect("remove held claim path");
    fs::create_dir(&claim_path).expect("replace held claim path with directory");
    assert_eq!(
        platform.unlink_claim(&directory),
        Err(PlatformFailure::IdentityUncertain)
    );
    fs::remove_dir(&claim_path).expect("remove claim directory replacement");
    platform.raw_close(claim).expect("close claim");
    platform
        .raw_close(directory)
        .expect("close directory exactly once");
}

#[test]
fn claim_positional_io_is_bounded_fsynced_and_unlinked_relative_to_directory() {
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
    platform
        .write_claim_from_start(&claim, &bytes)
        .expect("bounded pwrite");
    platform.fsync_claim(&claim).expect("claim fsync");
    assert_eq!(
        platform
            .fstat(&claim)
            .expect("written claim size")
            .size_bytes,
        length as u64
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
    assert_eq!(observed, bytes);
    platform
        .fsync_directory(&directory)
        .expect("directory fsync after create");
    assert!(matches!(
        platform
            .fstatat_nofollow(&directory, RelativeResource::Claim)
            .expect("claim exists"),
        Lookup::Present(metadata) if metadata.size_bytes == length as u64
    ));

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
fn directory_lock_and_claim_descriptors_do_not_cross_exec_even_if_fd_is_reused() {
    let temporary = TestDirectory::new("cloexec");
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

    platform.raw_close(claim).expect("close claim once");
    platform.raw_close(lock).expect("close lock once");
    platform.raw_close(directory).expect("close directory once");
}

#[test]
fn credential_mutation_syscalls_follow_the_contract_success_chain() {
    let temporary = TestDirectory::new("credential-mutation-success");
    let (mut platform, directory) = platform_for(&temporary.path);
    assert_eq!(
        platform
            .fstatat_credential_nofollow(&directory)
            .expect("credential absent lookup"),
        Lookup::Absent
    );

    let temporary_name = contract_temporary_name(b'a');
    let temporary_descriptor = platform
        .create_temporary_exclusive(&directory, &temporary_name)
        .expect("exclusive contract temporary create");
    let created = platform
        .fstat(&temporary_descriptor)
        .expect("created temporary metadata");
    assert_eq!(created.kind, ObjectKind::RegularFile);
    assert_eq!(created.mode, 0o600);
    assert_eq!(created.link_count, 1);
    assert_eq!(created.size_bytes, 0);
    assert!(platform
        .descriptor_has_cloexec(&temporary_descriptor)
        .expect("temporary FD_CLOEXEC"));
    assert!(matches!(
        platform.create_temporary_exclusive(&directory, &temporary_name),
        Err(PlatformFailure::AlreadyExists)
    ));

    let replacement = b"darwin-descriptor-relative-credential";
    assert_eq!(
        unsafe { libc::lseek(temporary_descriptor.raw_fd, 7, libc::SEEK_SET) },
        7
    );
    platform
        .write_temporary_from_start(&temporary_descriptor, replacement)
        .expect("full positional temporary write");
    assert_eq!(
        unsafe { libc::lseek(temporary_descriptor.raw_fd, 0, libc::SEEK_CUR) },
        7,
        "pwrite changed the shared descriptor cursor"
    );
    platform
        .fsync_temporary(&temporary_descriptor)
        .expect("temporary file fsync");
    let prepared = platform
        .fstat(&temporary_descriptor)
        .expect("prepared temporary metadata");
    assert_eq!(prepared.size_bytes, replacement.len() as u64);
    let by_name = match platform
        .fstatat_temporary_nofollow(&directory, &temporary_name)
        .expect("prepared temporary lookup")
    {
        Lookup::Present(metadata) => metadata,
        Lookup::Absent => panic!("prepared temporary disappeared"),
    };
    assert_eq!(by_name.identity, prepared.identity);

    let mut before_rename = vec![0_u8; replacement.len()];
    platform
        .read_file_exact(&temporary_descriptor, &mut before_rename)
        .expect("exact temporary bytes plus EOF proof");
    assert_eq!(before_rename, replacement);
    assert_eq!(
        unsafe { libc::lseek(temporary_descriptor.raw_fd, 0, libc::SEEK_CUR) },
        7,
        "pread changed the shared descriptor cursor"
    );

    platform
        .rename_temporary_to_credential(&directory, &temporary_name)
        .expect("same-directory renameat publication");
    assert_eq!(
        platform
            .fstatat_temporary_nofollow(&directory, &temporary_name)
            .expect("published temporary absence"),
        Lookup::Absent
    );
    let published = match platform
        .fstatat_credential_nofollow(&directory)
        .expect("published credential lookup")
    {
        Lookup::Present(metadata) => metadata,
        Lookup::Absent => panic!("published credential absent"),
    };
    assert_eq!(published.identity, prepared.identity);
    assert_eq!(published.mode, 0o600);
    assert_eq!(published.link_count, 1);
    assert_eq!(published.size_bytes, replacement.len() as u64);
    let mut through_published_descriptor = vec![0_u8; replacement.len()];
    platform
        .read_file_exact(&temporary_descriptor, &mut through_published_descriptor)
        .expect("published descriptor readback");
    assert_eq!(through_published_descriptor, replacement);
    platform
        .fsync_directory(&directory)
        .expect("publication directory fsync");

    let published_raw_fd = temporary_descriptor.raw_fd;
    platform
        .raw_close(temporary_descriptor)
        .expect("close published temporary descriptor once");
    assert_raw_fd_closed(published_raw_fd);

    let credential = platform
        .open_credential_readonly(&directory)
        .expect("safe credential readonly open");
    assert!(platform
        .descriptor_has_cloexec(&credential)
        .expect("credential FD_CLOEXEC"));
    assert_eq!(
        platform
            .fstat(&credential)
            .expect("credential fstat")
            .identity,
        published.identity
    );
    assert_eq!(
        unsafe { libc::lseek(credential.raw_fd, 3, libc::SEEK_SET) },
        3
    );
    let mut readback = vec![0_u8; replacement.len()];
    platform
        .read_file_exact(&credential, &mut readback)
        .expect("safe present credential exact readback");
    assert_eq!(readback, replacement);
    assert_eq!(
        unsafe { libc::lseek(credential.raw_fd, 0, libc::SEEK_CUR) },
        3
    );
    let credential_raw_fd = credential.raw_fd;
    platform
        .raw_close(credential)
        .expect("close credential descriptor once");
    assert_raw_fd_closed(credential_raw_fd);

    let directory_raw_fd = directory.raw_fd;
    platform
        .raw_close(directory)
        .expect("close directory descriptor once");
    assert_raw_fd_closed(directory_raw_fd);
}

#[test]
fn credential_mutation_syscall_races_fail_closed_and_preserve_foreign_objects() {
    let temporary = TestDirectory::new("credential-mutation-races");
    let (mut platform, directory) = platform_for(&temporary.path);
    let spec = platform_resource_spec();

    let credential_target = temporary.path.join("credential-symlink-target");
    fs::write(&credential_target, b"foreign-credential-target").expect("write symlink target");
    let credential_path = temporary.path.join(spec.credential_name());
    std::os::unix::fs::symlink(&credential_target, &credential_path)
        .expect("create credential symlink");
    assert!(matches!(
        platform
            .fstatat_credential_nofollow(&directory)
            .expect("credential symlink nofollow lookup"),
        Lookup::Present(metadata) if metadata.kind == ObjectKind::Symlink
    ));
    assert!(matches!(
        platform.open_credential_readonly(&directory),
        Err(PlatformFailure::IdentityUncertain)
    ));
    assert_eq!(
        fs::read(&credential_target).expect("credential target preserved"),
        b"foreign-credential-target"
    );
    fs::remove_file(&credential_path).expect("remove credential symlink fixture");
    fs::remove_file(&credential_target).expect("remove credential target fixture");

    let collision_name = contract_temporary_name(b'0');
    let collision_path = temporary.path.join(&collision_name);
    fs::write(&collision_path, b"foreign-collision").expect("seed temp collision");
    fs::set_permissions(&collision_path, fs::Permissions::from_mode(0o600))
        .expect("set collision mode");
    assert!(matches!(
        platform.create_temporary_exclusive(&directory, &collision_name),
        Err(PlatformFailure::AlreadyExists)
    ));
    assert_eq!(
        fs::read(&collision_path).expect("collision preserved"),
        b"foreign-collision"
    );
    fs::remove_file(&collision_path).expect("remove collision fixture");

    let hardlink_name = contract_temporary_name(b'1');
    let hardlink_path = temporary.path.join(&hardlink_name);
    let hardlink_alias = temporary.path.join("tracked-temp-hardlink-alias");
    let hardlink_descriptor = platform
        .create_temporary_exclusive(&directory, &hardlink_name)
        .expect("create hardlink-race temporary");
    fs::hard_link(&hardlink_path, &hardlink_alias).expect("add temporary hardlink");
    assert!(matches!(
        platform
            .fstatat_temporary_nofollow(&directory, &hardlink_name)
            .expect("hardlinked temp lookup"),
        Lookup::Present(metadata) if metadata.link_count == 2
    ));
    fs::remove_file(&hardlink_alias).expect("remove hardlink alias");
    platform
        .unlink_temporary(&directory, &hardlink_name)
        .expect("unlink restored single-link temporary");
    platform
        .raw_close(hardlink_descriptor)
        .expect("close hardlink-race descriptor once");

    let replacement_name = contract_temporary_name(b'2');
    let replacement_path = temporary.path.join(&replacement_name);
    let replacement_descriptor = platform
        .create_temporary_exclusive(&directory, &replacement_name)
        .expect("create replacement-race temporary");
    let original_identity = platform
        .fstat(&replacement_descriptor)
        .expect("original replacement-race identity")
        .identity;
    fs::remove_file(&replacement_path).expect("unlink tracked temp name");
    fs::write(&replacement_path, b"foreign-replacement").expect("install foreign replacement");
    fs::set_permissions(&replacement_path, fs::Permissions::from_mode(0o600))
        .expect("set replacement mode");
    let replacement_identity = match platform
        .fstatat_temporary_nofollow(&directory, &replacement_name)
        .expect("replacement lookup")
    {
        Lookup::Present(metadata) => metadata.identity,
        Lookup::Absent => panic!("replacement disappeared"),
    };
    assert_ne!(replacement_identity, original_identity);
    assert_eq!(
        platform
            .fstat(&replacement_descriptor)
            .expect("held original descriptor identity")
            .identity,
        original_identity
    );
    fs::remove_file(&replacement_path).expect("preserve then remove replacement fixture");
    platform
        .raw_close(replacement_descriptor)
        .expect("close replacement-race descriptor once");

    let type_race_name = contract_temporary_name(b'3');
    let type_race_path = temporary.path.join(&type_race_name);
    let type_race_descriptor = platform
        .create_temporary_exclusive(&directory, &type_race_name)
        .expect("create unlink-type-race temporary");
    fs::remove_file(&type_race_path).expect("unlink type-race temp name");
    fs::create_dir(&type_race_path).expect("replace type-race name with directory");
    assert_eq!(
        platform.unlink_temporary(&directory, &type_race_name),
        Err(PlatformFailure::IdentityUncertain)
    );
    assert!(type_race_path.is_dir(), "unlinkat removed a directory race");
    fs::remove_dir(&type_race_path).expect("remove type-race fixture");
    platform
        .raw_close(type_race_descriptor)
        .expect("close type-race descriptor once");

    let missing_name = contract_temporary_name(b'4');
    assert_eq!(
        platform.rename_temporary_to_credential(&directory, &missing_name),
        Err(PlatformFailure::NotFound)
    );
    assert_eq!(
        platform
            .fstatat_credential_nofollow(&directory)
            .expect("missing-source rename leaves credential absent"),
        Lookup::Absent
    );

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
