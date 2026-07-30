//! Trusted native capability factory for the Relay v2 Host credential atomic
//! file cell (contract revision 7, trusted factory v1).
//!
//! The raw factory rides as an additive own-data entry on the raw `open`
//! function; its only production driver is the fixed trusted loader, and no
//! visibility isolation is claimed. It is driven exactly once per process
//! with no arguments, and it never accepts a path, descriptor, HOME,
//! environment, or credential from JavaScript. The native producer (the
//! target-selected platform adapter) proves the process credential snapshot
//! and the native account-database home, then securely opens the
//! contract-fixed private cell directory; this module mints the unforgeable
//! capability around that sole owned descriptor. The one-shot binder consumes
//! the capability and returns the final module, whose exact own-data surface
//! is only the frozen v1 `open` method; the factory never rides the final
//! object. Rollback, replay, PID-fork, and final close all fail closed, the
//! descriptor is raw-closed exactly once with no dup or reopen, and the empty
//! durability qualification still stops every open at the existing gate
//! before registry, descriptor adoption, or credential mutation. Once a
//! future frozen qualification is actually available, the final module alone
//! transfers the exact descriptor into platform-common and publishes its
//! read/CAS/close handle.

use napi::bindgen_prelude::{FunctionCallContext, Object, Unknown};
use napi::{Env, JsValue, Result as NapiResult};
use relay_v2_host_credential_atomic_file_cell_platform_common::{
    adopt_prebound_directory, adopt_prebound_directory_for_self_hosted_darwin_arm64,
    issue_self_hosted_darwin_arm64_admission_policy, CellErrorCode, DescriptorRelativePlatform,
    ProcessLifecycleToken, SelfHostedDarwinArm64AdmissionPolicy,
};
use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use crate::{
    create_open_error_result, decode_open_request, define_own_data, lifecycle, native_cell,
    production_open_gate, supported_target, Intrinsics, OpenRequestDecode, RawValue,
};

pub(crate) const TRUSTED_FACTORY_METHOD: &str =
    "createRelayV2HostCredentialAtomicFileCellTrustedFactoryV1";
pub(crate) const SELF_HOSTED_DARWIN_ARM64_FACTORY_METHOD: &str =
    "createRelayV2HostCredentialAtomicFileCellSelfHostedDarwinArm64FactoryV1";

#[cfg(target_os = "macos")]
pub(crate) mod cell_platform {
    #[cfg(test)]
    pub(crate) use relay_v2_host_credential_atomic_file_cell_platform_darwin::prebound_directory_from_owned_raw_fd;
    pub(crate) use relay_v2_host_credential_atomic_file_cell_platform_darwin::{
        produce_trusted_cell_directory as produce, DarwinDescriptor as Descriptor,
        DarwinDescriptorRelativePlatform as Platform, PreboundDirectory,
    };
}

#[cfg(target_os = "linux")]
pub(crate) mod cell_platform {
    #[cfg(test)]
    pub(crate) use relay_v2_host_credential_atomic_file_cell_platform_linux::prebound_directory_from_owned_raw_fd;
    pub(crate) use relay_v2_host_credential_atomic_file_cell_platform_linux::{
        produce_trusted_cell_directory as produce, LinuxDescriptor as Descriptor,
        LinuxDescriptorRelativePlatform as Platform, PreboundDirectory,
    };
}

/// Process-origin pin captured eagerly at module init, mirroring the
/// platform-common lifecycle fence. A fork child inherits the pinned parent
/// pid, so every capability operation on this module fails closed there and
/// never closes an inherited descriptor.
static PROCESS_ORIGIN_PID: OnceLock<u32> = OnceLock::new();

pub(crate) fn pin_process_origin() {
    let _ = PROCESS_ORIGIN_PID.set(std::process::id());
}

fn check_origin_process() -> Result<(), CellErrorCode> {
    let origin = PROCESS_ORIGIN_PID.get_or_init(std::process::id);
    if *origin == std::process::id() {
        Ok(())
    } else {
        Err(CellErrorCode::CellClosed)
    }
}

/// Exactly-once process claim for the raw factory call. A replayed call is a
/// closed `CELL_CLOSED` result; a fork child inherits the consumed claim.
struct TrustedFactoryOnce {
    taken: AtomicBool,
}

impl TrustedFactoryOnce {
    const fn new() -> Self {
        Self {
            taken: AtomicBool::new(false),
        }
    }

    fn claim(&self) -> Result<(), CellErrorCode> {
        if self.taken.swap(true, Ordering::AcqRel) {
            Err(CellErrorCode::CellClosed)
        } else {
            Ok(())
        }
    }
}

static TRUSTED_FACTORY_ONCE: TrustedFactoryOnce = TrustedFactoryOnce::new();

enum AdmissionPolicy {
    Production,
    SelfHostedDarwinArm64(SelfHostedDarwinArm64AdmissionPolicy),
}

#[derive(Clone, Copy)]
enum AdmissionKind {
    Production,
    SelfHostedDarwinArm64,
}

/// Unforgeable native capability: sole ownership of the pre-bound cell
/// directory descriptor plus its adapter, bound to the producing process. It
/// is never exposed to JavaScript as a value and never reveals a raw
/// descriptor number. Final close is one raw close attempt in the origin
/// process only; a fork child marks the capability closed without touching
/// the inherited descriptor.
pub(crate) struct TrustedCellCapability {
    platform: Option<cell_platform::Platform>,
    directory: Option<cell_platform::Descriptor>,
    admission_policy: Option<AdmissionPolicy>,
    pid: u32,
    closed: bool,
}

impl TrustedCellCapability {
    fn from_prebound(
        prebound: cell_platform::PreboundDirectory,
        admission_policy: AdmissionPolicy,
    ) -> Self {
        let (platform, directory) = prebound.into_platform_parts();
        Self {
            platform: Some(platform),
            directory: Some(directory),
            admission_policy: Some(admission_policy),
            pid: std::process::id(),
            closed: false,
        }
    }

    #[cfg(test)]
    fn for_test(
        platform: cell_platform::Platform,
        directory: cell_platform::Descriptor,
        pid: u32,
    ) -> Self {
        Self {
            platform: Some(platform),
            directory: Some(directory),
            admission_policy: Some(AdmissionPolicy::Production),
            pid,
            closed: false,
        }
    }

    /// Synchronous process fence for every capability operation. A fork child
    /// inherits a capability whose origin pid is the parent, so it is only
    /// ever refused here; the inherited descriptor is never read, adopted, or
    /// closed on this path.
    fn check_origin(&self) -> Result<(), CellErrorCode> {
        if std::process::id() == self.pid {
            Ok(())
        } else {
            Err(CellErrorCode::CellClosed)
        }
    }

    fn admission_kind(&self) -> AdmissionKind {
        match self.admission_policy.as_ref() {
            Some(AdmissionPolicy::Production) => AdmissionKind::Production,
            Some(AdmissionPolicy::SelfHostedDarwinArm64(_)) => AdmissionKind::SelfHostedDarwinArm64,
            None => AdmissionKind::Production,
        }
    }

    /// One-shot ownership transfer into platform-common. From this point the
    /// common adoption attempt owns descriptor cleanup on every outcome.
    fn take_admission_parts(
        &mut self,
    ) -> Result<
        (
            cell_platform::Platform,
            cell_platform::Descriptor,
            AdmissionPolicy,
        ),
        CellErrorCode,
    > {
        self.check_origin()?;
        if self.closed
            || self.platform.is_none()
            || self.directory.is_none()
            || self.admission_policy.is_none()
        {
            return Err(CellErrorCode::CellClosed);
        }
        self.closed = true;
        Ok((
            self.platform.take().ok_or(CellErrorCode::CellClosed)?,
            self.directory.take().ok_or(CellErrorCode::CellClosed)?,
            self.admission_policy
                .take()
                .ok_or(CellErrorCode::CellClosed)?,
        ))
    }

    /// One raw close attempt, exactly once, in the origin process only.
    fn close_once(&mut self) {
        if self.closed {
            return;
        }
        self.closed = true;
        if self.check_origin().is_err() {
            return;
        }
        if let (Some(mut platform), Some(directory)) = (self.platform.take(), self.directory.take())
        {
            let _ = platform.raw_close(directory);
        }
    }
}

/// The final module's one-shot open authority. Qualification and exact
/// request validation happen before this mutex is entered; a successful take
/// permanently transfers descriptor ownership to platform-common.
struct BoundCellOpener {
    origin_pid: u32,
    admission_kind: AdmissionKind,
    capability: Mutex<Option<TrustedCellCapability>>,
}

impl BoundCellOpener {
    fn new(capability: TrustedCellCapability) -> Self {
        Self {
            origin_pid: capability.pid,
            admission_kind: capability.admission_kind(),
            capability: Mutex::new(Some(capability)),
        }
    }

    fn check_origin(&self) -> Result<(), CellErrorCode> {
        if std::process::id() == self.origin_pid {
            Ok(())
        } else {
            Err(CellErrorCode::CellClosed)
        }
    }

    fn take_capability(&self) -> Result<TrustedCellCapability, CellErrorCode> {
        self.check_origin()?;
        self.capability
            .lock()
            .map_err(|_| CellErrorCode::CellClosed)?
            .take()
            .ok_or(CellErrorCode::CellClosed)
    }
}

impl fmt::Debug for TrustedCellCapability {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("TrustedCellCapability(<host-cell-opaque>)")
    }
}

impl Drop for TrustedCellCapability {
    fn drop(&mut self) {
        self.close_once();
    }
}

/// One-shot binder state. The capability is consumed into the final module at
/// most once; replay or a poisoned state fails closed without producing a
/// second module.
struct TrustedFactoryBinder {
    origin_pid: u32,
    capability: Mutex<Option<TrustedCellCapability>>,
}

impl TrustedFactoryBinder {
    fn new(capability: TrustedCellCapability) -> Self {
        Self {
            origin_pid: capability.pid,
            capability: Mutex::new(Some(capability)),
        }
    }

    /// Lock-free callback-entry fence. This must run before argument
    /// observation or the capability mutex: a fork child cannot inspect the
    /// callback input, wait on an inherited mutex, or take the descriptor.
    fn check_origin(&self) -> Result<(), CellErrorCode> {
        if std::process::id() == self.origin_pid {
            Ok(())
        } else {
            Err(CellErrorCode::CellClosed)
        }
    }

    fn take_capability(&self) -> Result<TrustedCellCapability, CellErrorCode> {
        self.check_origin()?;
        let mut capability = self
            .capability
            .lock()
            .map_err(|_| CellErrorCode::CellClosed)?;
        capability.take().ok_or(CellErrorCode::CellClosed)
    }
}

/// Construction-time owner for a value that may eventually belong to an
/// N-API callback. The callback captures only the initially empty slot, so a
/// failed function/finalizer construction cannot leak the capability even if
/// N-API leaks the callback closure. Every pre-publication return drops and
/// therefore synchronously closes the still-pending value; only a completely
/// constructed result transfers it into the callback slot.
struct CallbackPublicationOwner<T> {
    pending: Option<T>,
    slot: Arc<OnceLock<T>>,
}

impl<T> CallbackPublicationOwner<T> {
    fn new(value: T) -> Self {
        Self {
            pending: Some(value),
            slot: Arc::new(OnceLock::new()),
        }
    }

    fn callback_slot(&self) -> Arc<OnceLock<T>> {
        Arc::clone(&self.slot)
    }

    fn publish(mut self) -> Result<(), ()> {
        let value = self.pending.take().ok_or(())?;
        match self.slot.set(value) {
            Ok(()) => Ok(()),
            Err(value) => {
                drop(value);
                Err(())
            }
        }
    }
}

fn error_object<'env>(env: &'env Env, code: CellErrorCode) -> NapiResult<Object<'env>> {
    let mut error = Object::new(env)?;
    define_own_data(env, &mut error, "code", code.as_contract_code())?;
    Ok(error)
}

fn outcome_error_result<'env>(env: &'env Env, code: CellErrorCode) -> NapiResult<Object<'env>> {
    let mut result = Object::new(env)?;
    define_own_data(env, &mut result, "outcome", "error")?;
    define_own_data(env, &mut result, "error", error_object(env, code)?)?;
    Ok(result)
}

fn produce_capability(
    target_supported: bool,
    lifecycle_token: &std::result::Result<ProcessLifecycleToken, CellErrorCode>,
    admission_policy: AdmissionPolicy,
) -> Result<TrustedCellCapability, CellErrorCode> {
    if !target_supported {
        return Err(CellErrorCode::NativeInterfaceInvalid);
    }
    if let Err(code) = lifecycle_token {
        return Err(*code);
    }
    check_origin_process()?;
    cell_platform::produce()
        .map(|prebound| TrustedCellCapability::from_prebound(prebound, admission_policy))
}

/// Callback-entry precedence shared with the focused tests. The real
/// process-origin fence and exactly-once claim both settle before the closure
/// may observe whether JavaScript supplied an argument. Consequently an
/// invalid first call consumes the claim, and a fork child or replay never
/// observes arguments.
fn trusted_factory_callback_argument_present(
    once: &TrustedFactoryOnce,
    observe_argument: impl FnOnce() -> bool,
) -> Result<bool, CellErrorCode> {
    check_origin_process()?;
    once.claim()?;
    Ok(observe_argument())
}

/// Raw factory callback: process origin, then one-shot claim, then argument
/// observation, then production. It returns only the closed result union
/// `{ outcome: "ready", bind } | { outcome: "error", error }`.
pub(crate) fn run_trusted_factory_callback(
    context: FunctionCallContext<'_>,
    intrinsics: &Arc<Intrinsics>,
) -> NapiResult<RawValue> {
    let argument_present =
        match trusted_factory_callback_argument_present(&TRUSTED_FACTORY_ONCE, || {
            context.get::<Unknown<'_>>(0).is_ok()
        }) {
            Ok(argument_present) => argument_present,
            Err(code) => {
                return outcome_error_result(context.env, code).map(|value| RawValue(value.raw()));
            }
        };
    if argument_present {
        return outcome_error_result(context.env, CellErrorCode::InvalidArgument)
            .map(|value| RawValue(value.raw()));
    }
    match produce_capability(supported_target(), lifecycle(), AdmissionPolicy::Production) {
        Ok(capability) => ready_factory_result(context.env, intrinsics, capability),
        Err(code) => outcome_error_result(context.env, code),
    }
    .map(|value| RawValue(value.raw()))
}

/// Independent explicit non-production factory. It shares the raw factory's
/// single process claim, fixed native directory producer, binder, final module,
/// and sole common AdmissionOwner. Its opaque policy can only authorize the
/// frozen Darwin arm64 self-hosted clean-restart lane; it cannot satisfy or
/// bypass the production durability qualification.
pub(crate) fn run_self_hosted_darwin_arm64_factory_callback(
    context: FunctionCallContext<'_>,
    intrinsics: &Arc<Intrinsics>,
) -> NapiResult<RawValue> {
    let argument_present =
        match trusted_factory_callback_argument_present(&TRUSTED_FACTORY_ONCE, || {
            context.get::<Unknown<'_>>(0).is_ok()
        }) {
            Ok(argument_present) => argument_present,
            Err(code) => {
                return outcome_error_result(context.env, code).map(|value| RawValue(value.raw()));
            }
        };
    if argument_present {
        return outcome_error_result(context.env, CellErrorCode::InvalidArgument)
            .map(|value| RawValue(value.raw()));
    }
    let policy = match issue_self_hosted_darwin_arm64_admission_policy() {
        Ok(policy) => policy,
        Err(code) => {
            return outcome_error_result(context.env, code).map(|value| RawValue(value.raw()));
        }
    };
    match produce_capability(
        supported_target(),
        lifecycle(),
        AdmissionPolicy::SelfHostedDarwinArm64(policy),
    ) {
        Ok(capability) => ready_factory_result(context.env, intrinsics, capability),
        Err(code) => outcome_error_result(context.env, code),
    }
    .map(|value| RawValue(value.raw()))
}

fn ready_factory_result<'env>(
    env: &'env Env,
    intrinsics: &Arc<Intrinsics>,
    capability: TrustedCellCapability,
) -> NapiResult<Object<'env>> {
    let publication = CallbackPublicationOwner::new(TrustedFactoryBinder::new(capability));
    let binder_slot = publication.callback_slot();
    let bind_intrinsics = Arc::clone(intrinsics);
    let bind = env.create_function_from_closure::<(Unknown,), RawValue, _>(
        "bind",
        move |context: FunctionCallContext<'_>| {
            let Some(binder) = binder_slot.get() else {
                return outcome_error_result(context.env, CellErrorCode::CellClosed)
                    .map(|value| RawValue(value.raw()));
            };
            run_bind_callback(
                binder,
                || context.get::<Unknown<'_>>(0).is_ok(),
                |code| outcome_error_result(context.env, code).map(|value| RawValue(value.raw())),
                || {
                    bind_trusted_module(context.env, &bind_intrinsics, binder)
                        .map(|value| RawValue(value.raw()))
                },
            )
        },
    )?;
    let mut result = Object::new(env)?;
    define_own_data(env, &mut result, "outcome", "ready")?;
    define_own_data(env, &mut result, "bind", bind)?;
    publication
        .publish()
        .map_err(|()| crate::napi_failure("trusted bind callback publication failed"))?;
    Ok(result)
}

/// Complete binder callback driver shared by the real N-API callback and the
/// libc-fork tests. The binder's immutable origin PID is checked before the
/// boundary may observe a missing or malformed JavaScript argument, encode an
/// argument error, or enter the continuation that takes the capability under
/// its mutex.
fn run_bind_callback<R>(
    binder: &TrustedFactoryBinder,
    observe_argument: impl FnOnce() -> bool,
    encode_error: impl FnOnce(CellErrorCode) -> R,
    bind: impl FnOnce() -> R,
) -> R {
    if let Err(code) = binder.check_origin() {
        return encode_error(code);
    }
    if observe_argument() {
        return encode_error(CellErrorCode::InvalidArgument);
    }
    bind()
}

/// One-shot binder: consumes the capability and returns `{ outcome: "bound",
/// module }` where `module` is the final exact own-data v1 module. Replay,
/// PID-fork, or a poisoned binder fails closed; any construction failure
/// rolls the capability back into its exactly-once close.
fn bind_trusted_module<'env>(
    env: &'env Env,
    intrinsics: &Arc<Intrinsics>,
    binder: &TrustedFactoryBinder,
) -> NapiResult<Object<'env>> {
    let capability = match binder.take_capability() {
        Ok(capability) => capability,
        Err(code) => return outcome_error_result(env, code),
    };
    let publication = CallbackPublicationOwner::new(BoundCellOpener::new(capability));
    let opener_slot = publication.callback_slot();
    let open_intrinsics = Arc::clone(intrinsics);
    let open = env.create_function_from_closure::<(Unknown,), RawValue, _>(
        "openRelayV2HostCredentialAtomicFileCellV1",
        move |context: FunctionCallContext<'_>| {
            let Some(opener) = opener_slot.get() else {
                return create_open_error_result(context.env, CellErrorCode::CellClosed)
                    .map(|value| RawValue(value.raw()));
            };
            run_bound_open_callback(
                opener,
                || context.get::<Unknown<'_>>(0).map_err(|_| ()),
                |code| {
                    create_open_error_result(context.env, code).map(|value| RawValue(value.raw()))
                },
                |input| {
                    open_bound_cell(context.env, &open_intrinsics, opener, input)
                        .map(|value| RawValue(value.raw()))
                },
            )
        },
    )?;
    let mut module = Object::new(env)?;
    define_own_data(
        env,
        &mut module,
        "openRelayV2HostCredentialAtomicFileCellV1",
        open,
    )?;
    let mut result = Object::new(env)?;
    define_own_data(env, &mut result, "outcome", "bound")?;
    define_own_data(env, &mut result, "module", module)?;
    publication
        .publish()
        .map_err(|()| crate::napi_failure("trusted open callback publication failed"))?;
    Ok(result)
}

/// Complete final-open callback driver shared by the real N-API callback and
/// the libc-fork tests. The immutable capability origin PID is checked before
/// the boundary may observe/decode the JavaScript request, encode a missing
/// argument, or enter the frozen open continuation.
fn run_bound_open_callback<I, R>(
    opener: &BoundCellOpener,
    observe_input: impl FnOnce() -> Result<I, ()>,
    encode_error: impl FnOnce(CellErrorCode) -> R,
    open: impl FnOnce(I) -> R,
) -> R {
    if let Err(code) = opener.check_origin() {
        return encode_error(code);
    }
    match observe_input() {
        Ok(input) => open(input),
        Err(()) => encode_error(CellErrorCode::InvalidArgument),
    }
}

/// The final module's `open` keeps the raw v1 request shape and gate order,
/// with the capability's PID fence before request observation. A qualified,
/// valid open transfers the exact bound capability into the sole common
/// owner; a fork child never reads, adopts, or closes the inherited
/// descriptor.
fn open_bound_cell<'env>(
    env: &'env Env,
    intrinsics: &Arc<Intrinsics>,
    opener: &BoundCellOpener,
    input: Unknown<'env>,
) -> NapiResult<Object<'env>> {
    if opener.check_origin().is_err() {
        return create_open_error_result(env, CellErrorCode::CellClosed);
    }
    let decode = match decode_open_request(env, intrinsics, input) {
        Ok(decode) => decode,
        Err(_) => {
            crate::clear_pending_exception(env);
            return create_open_error_result(env, CellErrorCode::NativeInterfaceInvalid);
        }
    };
    match decode {
        OpenRequestDecode::Valid => {}
        OpenRequestDecode::InvalidArgument => {
            return create_open_error_result(env, CellErrorCode::InvalidArgument)
        }
        OpenRequestDecode::NativeInterfaceInvalid => {
            return create_open_error_result(env, CellErrorCode::NativeInterfaceInvalid)
        }
    }
    let (lifecycle_token, production_qualification) = match opener.admission_kind {
        AdmissionKind::Production => match production_open_gate(supported_target(), lifecycle()) {
            Ok((token, qualification)) => (token, Some(qualification)),
            Err(code) => return create_open_error_result(env, code),
        },
        AdmissionKind::SelfHostedDarwinArm64 => match lifecycle().as_ref() {
            Ok(token) => (token, None),
            Err(code) => return create_open_error_result(env, *code),
        },
    };
    let mut capability = match opener.take_capability() {
        Ok(capability) => capability,
        Err(code) => return create_open_error_result(env, code),
    };
    let (platform, directory, admission_policy) = match capability.take_admission_parts() {
        Ok(parts) => parts,
        Err(code) => return create_open_error_result(env, code),
    };
    let owner = match admission_policy {
        AdmissionPolicy::Production => {
            let qualification = production_qualification
                .as_ref()
                .expect("production opener carries production qualification");
            adopt_prebound_directory(lifecycle_token, platform, directory, &qualification)
        }
        AdmissionPolicy::SelfHostedDarwinArm64(policy) => {
            adopt_prebound_directory_for_self_hosted_darwin_arm64(
                lifecycle_token,
                platform,
                directory,
                policy,
            )
        }
    };
    let owner = match owner {
        Ok(owner) => owner,
        Err(code) => return create_open_error_result(env, code),
    };
    native_cell::create_opened_result(env, intrinsics, owner)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::open_gate_code;
    use std::fs;
    use std::os::fd::{IntoRawFd, RawFd};
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};

    static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

    struct TempHome {
        root: PathBuf,
        cell: PathBuf,
    }

    impl TempHome {
        fn create() -> Self {
            let unique = NEXT_TEMP.fetch_add(1, AtomicOrdering::Relaxed);
            let root = std::env::temp_dir().join(format!(
                "tw-relay-v2-host-cell-capability-{}-{unique}",
                std::process::id()
            ));
            let cell = root
                .join(".tmux-worktree")
                .join("relay-v2-host-credential-atomic-file-cell-v1");
            fs::create_dir_all(&cell).expect("create temp cell directory");
            for directory in [&root, &root.join(".tmux-worktree"), &cell] {
                fs::set_permissions(directory, fs::Permissions::from_mode(0o700))
                    .expect("set 0700 on temp directory");
            }
            Self { root, cell }
        }
    }

    impl Drop for TempHome {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn fd_is_open(raw_fd: RawFd) -> bool {
        (unsafe { libc::fcntl(raw_fd, libc::F_GETFD) }) >= 0
    }

    fn bound_open_gate_code(
        capability: &TrustedCellCapability,
        target_supported: bool,
        lifecycle_token: &std::result::Result<ProcessLifecycleToken, CellErrorCode>,
    ) -> CellErrorCode {
        if capability.check_origin().is_err() {
            CellErrorCode::CellClosed
        } else {
            open_gate_code(target_supported, lifecycle_token)
        }
    }

    /// Real descriptor over the real 0700 temp cell directory, adopted through
    /// the adapter's public ownership-transfer seam so the raw descriptor
    /// number stays observable to this test only.
    fn produce_test_capability() -> (TrustedCellCapability, RawFd, TempHome) {
        let home = TempHome::create();
        let file = fs::File::open(&home.cell).expect("open 0700 cell directory");
        let raw_fd = file.into_raw_fd();
        let prebound = unsafe { cell_platform::prebound_directory_from_owned_raw_fd(raw_fd) };
        (
            TrustedCellCapability::from_prebound(prebound, AdmissionPolicy::Production),
            raw_fd,
            home,
        )
    }

    #[derive(Debug, Eq, PartialEq)]
    struct EncodedError {
        code: &'static str,
    }

    #[derive(Debug, Eq, PartialEq)]
    struct EncodedBindErrorResult {
        outcome: &'static str,
        error: EncodedError,
    }

    #[derive(Debug, Eq, PartialEq)]
    struct EncodedOpenErrorResult {
        abi_version: u32,
        operation: &'static str,
        outcome: &'static str,
        error: EncodedError,
    }

    fn encode_bind_error(code: CellErrorCode) -> EncodedBindErrorResult {
        EncodedBindErrorResult {
            outcome: "error",
            error: EncodedError {
                code: code.as_contract_code(),
            },
        }
    }

    fn encode_open_error(code: CellErrorCode) -> EncodedOpenErrorResult {
        EncodedOpenErrorResult {
            abi_version: 1,
            operation: "open",
            outcome: "error",
            error: EncodedError {
                code: code.as_contract_code(),
            },
        }
    }

    fn wait_for_fork_child(child_pid: libc::pid_t, label: &str) {
        let mut status = 0;
        assert_eq!(
            unsafe { libc::waitpid(child_pid, &mut status, 0) },
            child_pid,
            "wait for {label}"
        );
        assert_eq!(status, 0, "{label} failed");
    }

    #[test]
    fn trusted_factory_once_claim_replay_fails_closed() {
        let once = TrustedFactoryOnce::new();
        assert_eq!(once.claim(), Ok(()));
        assert_eq!(once.claim(), Err(CellErrorCode::CellClosed));
        assert_eq!(once.claim(), Err(CellErrorCode::CellClosed));
    }

    #[test]
    fn invalid_first_factory_argument_consumes_the_claim_before_replay() {
        pin_process_origin();
        let once = TrustedFactoryOnce::new();
        assert_eq!(
            trusted_factory_callback_argument_present(&once, || true),
            Ok(true),
            "the first present argument is observed only after the claim"
        );
        let mut replay_observed_argument = false;
        assert_eq!(
            trusted_factory_callback_argument_present(&once, || {
                replay_observed_argument = true;
                false
            }),
            Err(CellErrorCode::CellClosed),
            "replay settles before argument observation"
        );
        assert_eq!(replay_observed_argument, false);
    }

    #[test]
    fn real_0700_descriptor_stays_bound_until_the_durability_gate() {
        let (mut capability, raw_fd, _home) = produce_test_capability();
        assert!(fd_is_open(raw_fd), "produced descriptor is live");
        // The frozen gate chain reaches the deny-by-default durability
        // qualification with the real descriptor still owned and unadopted.
        assert_eq!(
            open_gate_code(supported_target(), lifecycle()),
            CellErrorCode::CellDurabilityUnsupported
        );
        assert!(
            fd_is_open(raw_fd),
            "the gate never adopts or closes the bound descriptor"
        );
        capability.close_once();
        assert!(!fd_is_open(raw_fd), "final close retires the descriptor");
    }

    #[test]
    fn binder_consumes_the_capability_once_and_replay_fails_closed() {
        let (capability, raw_fd, _home) = produce_test_capability();
        let binder = TrustedFactoryBinder::new(capability);
        let consumed = binder.take_capability().expect("first bind consumes");
        assert!(fd_is_open(raw_fd));
        assert!(
            matches!(binder.take_capability(), Err(CellErrorCode::CellClosed)),
            "binder replay fails closed"
        );
        drop(consumed);
        assert!(
            !fd_is_open(raw_fd),
            "module drop closes the descriptor once"
        );
    }

    #[test]
    fn bound_open_transfers_the_descriptor_without_dup_or_capability_close() {
        let (capability, raw_fd, _home) = produce_test_capability();
        let opener = BoundCellOpener::new(capability);
        let mut capability = opener
            .take_capability()
            .expect("final open takes the bound capability once");
        assert!(
            matches!(opener.take_capability(), Err(CellErrorCode::CellClosed)),
            "the final open authority cannot transfer twice"
        );
        let (mut platform, directory, admission_policy) = capability
            .take_admission_parts()
            .expect("capability transfers exact platform and descriptor");
        assert!(matches!(admission_policy, AdmissionPolicy::Production));
        drop(capability);
        assert!(
            fd_is_open(raw_fd),
            "capability drop is disarmed after ownership transfer"
        );
        platform
            .raw_close(directory)
            .expect("the receiving owner closes the transferred descriptor");
        assert!(!fd_is_open(raw_fd));
    }

    #[test]
    fn rollback_without_bind_closes_the_descriptor_exactly_once() {
        let (capability, raw_fd, _home) = produce_test_capability();
        assert!(fd_is_open(raw_fd));
        drop(capability);
        assert!(
            !fd_is_open(raw_fd),
            "an unbound capability rolls back into its exactly-once close"
        );
    }

    #[test]
    fn final_close_is_exactly_once_and_never_retried() {
        let (mut capability, raw_fd, _home) = produce_test_capability();
        capability.close_once();
        assert!(!fd_is_open(raw_fd));
        capability.close_once();
        assert!(
            !fd_is_open(raw_fd),
            "a second close is an inert no-op, never a second raw close"
        );
    }

    #[test]
    fn bound_open_gate_fences_a_foreign_pid_before_any_gate_or_descriptor_touch() {
        let home = TempHome::create();
        let file = fs::File::open(&home.cell).expect("open 0700 cell directory");
        let raw_fd = file.into_raw_fd();
        let prebound = unsafe { cell_platform::prebound_directory_from_owned_raw_fd(raw_fd) };
        let (platform, directory) = prebound.into_platform_parts();
        // Bind-before-fork: the child inherits a capability whose origin pid
        // is the parent. Its bound open is only CELL_CLOSED, never the
        // durability gate, and the inherited descriptor stays untouched.
        let mut capability = TrustedCellCapability::for_test(platform, directory, u32::MAX);
        assert_eq!(
            bound_open_gate_code(&capability, supported_target(), lifecycle()),
            CellErrorCode::CellClosed
        );
        assert!(
            fd_is_open(raw_fd),
            "a foreign-pid bound open never touches the descriptor"
        );
        // The origin-process bound open still reaches the durability gate
        // with the descriptor bound and unadopted.
        let (platform, directory) = (
            capability.platform.take().expect("platform"),
            capability.directory.take().expect("directory"),
        );
        let mut capability =
            TrustedCellCapability::for_test(platform, directory, std::process::id());
        assert_eq!(
            bound_open_gate_code(&capability, supported_target(), lifecycle()),
            CellErrorCode::CellDurabilityUnsupported
        );
        assert!(fd_is_open(raw_fd));
        capability.close_once();
        assert!(!fd_is_open(raw_fd));
    }

    #[test]
    fn fork_child_bind_driver_encodes_closed_before_argument_observation_or_take() {
        // Keep the real N-API module root and its callback chain live in the
        // lib-test build; the fork test below still drives the same production
        // callback driver through its injected boundary.
        let _production_wiring = crate::initialize;

        let (unpublished_capability, unpublished_fd, _unpublished_home) = produce_test_capability();
        let unpublished =
            CallbackPublicationOwner::new(TrustedFactoryBinder::new(unpublished_capability));
        let leaked_callback_slot = unpublished.callback_slot();
        drop(unpublished);
        assert!(
            leaked_callback_slot.get().is_none(),
            "failed bind construction never publishes its capability owner"
        );
        assert!(
            !fd_is_open(unpublished_fd),
            "failed bind construction synchronously rolls the capability back"
        );

        pin_process_origin();
        let (capability, raw_fd, _home) = produce_test_capability();
        let binder = TrustedFactoryBinder::new(capability);

        let child_pid = unsafe { libc::fork() };
        assert!(child_pid >= 0, "fork bind-driver child");
        if child_pid == 0 {
            let mut argument_observations = 0_u8;
            let mut mutex_take_entries = 0_u8;
            let missing = run_bind_callback(
                &binder,
                || {
                    argument_observations |= 0b01;
                    false
                },
                encode_bind_error,
                || {
                    mutex_take_entries |= 0b01;
                    encode_bind_error(CellErrorCode::InvalidArgument)
                },
            );
            let malformed = run_bind_callback(
                &binder,
                || {
                    argument_observations |= 0b10;
                    true
                },
                encode_bind_error,
                || {
                    mutex_take_entries |= 0b10;
                    encode_bind_error(CellErrorCode::InvalidArgument)
                },
            );
            let fully_encoded_closed = encode_bind_error(CellErrorCode::CellClosed);
            unsafe {
                libc::_exit(
                    if missing == fully_encoded_closed
                        && malformed == fully_encoded_closed
                        && argument_observations == 0
                        && mutex_take_entries == 0
                        && fd_is_open(raw_fd)
                    {
                        0
                    } else {
                        1
                    },
                );
            }
        }

        wait_for_fork_child(child_pid, "bind-driver child");
        assert!(fd_is_open(raw_fd), "parent retains the bound descriptor");
        drop(
            binder
                .take_capability()
                .expect("parent can still take the binder capability"),
        );
        assert!(!fd_is_open(raw_fd));
    }

    #[test]
    fn fork_child_bound_open_driver_encodes_closed_before_input_or_open() {
        let (unpublished_capability, unpublished_fd, _unpublished_home) = produce_test_capability();
        let unpublished = CallbackPublicationOwner::new(unpublished_capability);
        let leaked_callback_slot = unpublished.callback_slot();
        drop(unpublished);
        assert!(
            leaked_callback_slot.get().is_none(),
            "failed final-open construction never publishes its capability"
        );
        assert!(
            !fd_is_open(unpublished_fd),
            "failed final-open construction synchronously rolls the capability back"
        );

        pin_process_origin();
        let (capability, raw_fd, _home) = produce_test_capability();
        let opener = BoundCellOpener::new(capability);

        let child_pid = unsafe { libc::fork() };
        assert!(child_pid >= 0, "fork bound-open-driver child");
        if child_pid == 0 {
            let mut input_observations = 0_u8;
            let mut open_entries = 0_u8;
            let missing = run_bound_open_callback(
                &opener,
                || {
                    input_observations |= 0b01;
                    Err(())
                },
                encode_open_error,
                |_: u8| {
                    open_entries |= 0b01;
                    encode_open_error(CellErrorCode::InvalidArgument)
                },
            );
            let malformed = run_bound_open_callback(
                &opener,
                || {
                    input_observations |= 0b10;
                    Ok(0_u8)
                },
                encode_open_error,
                |_: u8| {
                    open_entries |= 0b10;
                    encode_open_error(CellErrorCode::InvalidArgument)
                },
            );
            let fully_encoded_closed = encode_open_error(CellErrorCode::CellClosed);
            unsafe {
                libc::_exit(
                    if missing == fully_encoded_closed
                        && malformed == fully_encoded_closed
                        && input_observations == 0
                        && open_entries == 0
                        && fd_is_open(raw_fd)
                    {
                        0
                    } else {
                        1
                    },
                );
            }
        }

        wait_for_fork_child(child_pid, "bound-open-driver child");
        assert!(
            fd_is_open(raw_fd),
            "parent retains the descriptor after child open probes"
        );
        drop(
            opener
                .take_capability()
                .expect("parent can still take the bound-open capability"),
        );
        assert!(!fd_is_open(raw_fd));
    }
}
