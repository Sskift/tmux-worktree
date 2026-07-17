#![cfg_attr(test, allow(dead_code))]

mod port;
mod state;

use crate::port::{erase_process_store, PortPublishOutcome, PortSnapshot, StorePort};
use crate::state::{
    same_transaction, AdmissionState, NativeCompletion, NativeCompletionResult,
    TransactionIdentity, TransactionState,
};
use napi::bindgen_prelude::{
    Array, FnArgs, FromNapiValue, Function, FunctionCallContext, FunctionRef, JsObjectValue,
    Object, ToNapiValue, TypeName, Uint8Array, Unknown,
};
use napi::{sys, Env, Error, JsDeferred, JsValue, Property, Result, Status, ValueType};
use napi_derive::napi;
use relay_v2_broker_credential_state_store_platform_common::{
    initialize_process_lifecycle, NativeStoreErrorCode, ProcessLifecycleToken,
};
use std::path::{Path, PathBuf};
use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, MutexGuard, OnceLock, Weak};

const MAX_STATE_BYTES: usize = 67_108_864;
const FEATURES: [&str; 6] = [
    "process_wide_kernel_lock_v1",
    "exclusive_transaction_v1",
    "opaque_transaction_revision_v1",
    "compare_and_publish_v1",
    "close_barrier_v1",
    "dual_slot_binary_v1",
];

static PROCESS_LIFECYCLE: OnceLock<
    std::result::Result<ProcessLifecycleToken, NativeStoreErrorCode>,
> = OnceLock::new();

#[derive(Clone, Copy)]
struct RawValue(sys::napi_value);

impl ToNapiValue for RawValue {
    unsafe fn to_napi_value(_env: sys::napi_env, value: Self) -> Result<sys::napi_value> {
        Ok(value.0)
    }
}

impl FromNapiValue for RawValue {
    unsafe fn from_napi_value(_env: sys::napi_env, value: sys::napi_value) -> Result<Self> {
        Ok(Self(value))
    }
}

impl TypeName for RawValue {
    fn type_name() -> &'static str {
        "unknown"
    }

    fn value_type() -> ValueType {
        ValueType::Unknown
    }
}

type RawFunctionRef = FunctionRef<RawValue, RawValue>;
type RawThenRef = FunctionRef<FnArgs<(RawValue, RawValue)>, RawValue>;
type DeferredResolver = Box<dyn FnOnce(Env) -> Result<RawValue> + Send>;
type BindingDeferred = JsDeferred<RawValue, DeferredResolver>;

struct Intrinsics {
    own_keys: RawFunctionRef,
    get_own_property_descriptors: RawFunctionRef,
    promise_constructor: FunctionRef<(), RawValue>,
    promise_resolve: RawFunctionRef,
    promise_then: RawThenRef,
}

impl Intrinsics {
    fn capture(env: &Env) -> Result<Self> {
        let global = env.get_global()?;
        let reflect: Object<'_> = global.get_named_property("Reflect")?;
        let object: Function<'_, (), RawValue> = global.get_named_property("Object")?;
        let promise_constructor: Function<'_, (), RawValue> =
            global.get_named_property("Promise")?;
        let own_keys: Function<'_, RawValue, RawValue> = reflect
            .get("ownKeys")?
            .ok_or_else(|| napi_failure("Reflect.ownKeys is unavailable"))?;
        let get_descriptors: Function<'_, RawValue, RawValue> =
            object.get_named_property("getOwnPropertyDescriptors")?;
        let promise_resolve: Function<'_, RawValue, RawValue> =
            promise_constructor.get_named_property("resolve")?;
        let promise_prototype: Object<'_> = promise_constructor.get_named_property("prototype")?;
        let promise_then: Function<'_, FnArgs<(RawValue, RawValue)>, RawValue> = promise_prototype
            .get("then")?
            .ok_or_else(|| napi_failure("Promise.prototype.then is unavailable"))?;
        Ok(Self {
            own_keys: own_keys.create_ref()?,
            get_own_property_descriptors: get_descriptors.create_ref()?,
            promise_constructor: promise_constructor.create_ref()?,
            promise_resolve: promise_resolve.create_ref()?,
            promise_then: promise_then.create_ref()?,
        })
    }

    fn snapshot_descriptors<'env>(
        &self,
        env: &'env Env,
        value: Unknown<'env>,
    ) -> Result<(Object<'env>, Array<'env>)> {
        let descriptors = self
            .get_own_property_descriptors
            .borrow_back(env)?
            .call(RawValue(value.raw()))?;
        let descriptors = unsafe { Object::from_napi_value(env.raw(), descriptors.0)? };
        let keys = self
            .own_keys
            .borrow_back(env)?
            .call(RawValue(descriptors.raw()))?;
        let keys = unsafe { Array::from_napi_value(env.raw(), keys.0)? };
        Ok((descriptors, keys))
    }

    fn promise_resolve<'env>(&self, env: &'env Env, value: RawValue) -> Result<RawValue> {
        let constructor = self.promise_constructor.borrow_back(env)?;
        self.promise_resolve
            .borrow_back(env)?
            .apply(constructor, value)
    }

    fn promise_then<'env>(
        &self,
        env: &'env Env,
        promise: RawValue,
        fulfilled: RawValue,
        rejected: RawValue,
    ) -> Result<()> {
        let receiver = unsafe { Object::from_napi_value(env.raw(), promise.0)? };
        self.promise_then
            .borrow_back(env)?
            .apply(receiver, FnArgs::from((fulfilled, rejected)))?;
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CapabilityDecision {
    Supported,
    UnsupportedTarget,
    Invalid(NativeStoreErrorCode),
}

fn supported_target() -> bool {
    cfg!(all(
        any(target_os = "macos", target_os = "linux"),
        any(target_arch = "aarch64", target_arch = "x86_64")
    ))
}

fn capability_decision(
    target_supported: bool,
    lifecycle: &std::result::Result<ProcessLifecycleToken, NativeStoreErrorCode>,
) -> CapabilityDecision {
    if !target_supported {
        CapabilityDecision::UnsupportedTarget
    } else {
        match lifecycle {
            Ok(_) => CapabilityDecision::Supported,
            Err(error) => CapabilityDecision::Invalid(*error),
        }
    }
}

fn lifecycle() -> &'static std::result::Result<ProcessLifecycleToken, NativeStoreErrorCode> {
    PROCESS_LIFECYCLE
        .get_or_init(|| initialize_process_lifecycle().map_err(NativeStoreErrorCode::from))
}

fn napi_failure(message: &'static str) -> Error {
    Error::new(Status::GenericFailure, message)
}

fn lock_recover<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn define_own_data<T: ToNapiValue>(
    env: &Env,
    object: &mut Object<'_>,
    name: &str,
    value: T,
) -> Result<()> {
    let property = Property::new()
        .with_utf8_name(name)?
        .with_napi_value(env, value)?;
    object.define_properties(&[property])
}

fn create_error_object<'env>(env: &'env Env, code: NativeStoreErrorCode) -> Result<Object<'env>> {
    let mut error = Object::new(env)?;
    define_own_data(env, &mut error, "code", code.as_contract_code())?;
    Ok(error)
}

fn create_invalid_open<'env>(env: &'env Env, code: NativeStoreErrorCode) -> Result<Object<'env>> {
    let mut result = Object::new(env)?;
    define_own_data(env, &mut result, "status", "invalid")?;
    define_own_data(env, &mut result, "error", create_error_object(env, code)?)?;
    Ok(result)
}

fn create_unsupported<'env>(env: &'env Env, reason: &str) -> Result<Object<'env>> {
    let mut result = Object::new(env)?;
    define_own_data(env, &mut result, "status", "unsupported")?;
    define_own_data(env, &mut result, "reason", reason)?;
    Ok(result)
}

fn create_capability<'env>(env: &'env Env) -> Result<Object<'env>> {
    match capability_decision(supported_target(), lifecycle()) {
        CapabilityDecision::UnsupportedTarget => create_unsupported(env, "target_unsupported"),
        CapabilityDecision::Invalid(code) => create_invalid_open(env, code),
        CapabilityDecision::Supported => {
            let mut capability = Object::new(env)?;
            define_own_data(env, &mut capability, "status", "supported")?;
            define_own_data(env, &mut capability, "nativeAbi", "napi")?;
            define_own_data(env, &mut capability, "interfaceVersion", 1_u32)?;
            define_own_data(env, &mut capability, "storageFormatVersion", 1_u32)?;
            define_own_data(
                env,
                &mut capability,
                "maxStateBytes",
                MAX_STATE_BYTES as u32,
            )?;
            define_own_data(
                env,
                &mut capability,
                "features",
                Array::from_ref_vec_string(env, &FEATURES.map(str::to_owned))?,
            )?;
            define_own_data(
                env,
                &mut capability,
                "durability",
                "payload_then_header_durable_v1",
            )?;
            Ok(capability)
        }
    }
}

fn clear_pending_exception(env: &Env) {
    let mut pending = false;
    let status = unsafe { sys::napi_is_exception_pending(env.raw(), &mut pending) };
    if status == sys::Status::napi_ok && pending {
        let mut ignored = ptr::null_mut();
        let _ = unsafe { sys::napi_get_and_clear_last_exception(env.raw(), &mut ignored) };
    }
}

fn raw_undefined(env: &Env) -> Result<RawValue> {
    let mut undefined = ptr::null_mut();
    let status = unsafe { sys::napi_get_undefined(env.raw(), &mut undefined) };
    if status == sys::Status::napi_ok {
        Ok(RawValue(undefined))
    } else {
        Err(napi_failure("failed to create undefined"))
    }
}

fn rejected_promise(env: &Env, code: NativeStoreErrorCode) -> Result<RawValue> {
    let mut deferred = ptr::null_mut();
    let mut promise = ptr::null_mut();
    let status = unsafe { sys::napi_create_promise(env.raw(), &mut deferred, &mut promise) };
    if status != sys::Status::napi_ok {
        return Err(napi_failure("failed to create rejected promise"));
    }
    let error = create_error_object(env, code)?;
    let status = unsafe { sys::napi_reject_deferred(env.raw(), deferred, error.raw()) };
    if status == sys::Status::napi_ok {
        Ok(RawValue(promise))
    } else {
        Err(napi_failure("failed to reject promise"))
    }
}

fn resolved_promise(env: &Env, value: RawValue) -> Result<RawValue> {
    let mut deferred = ptr::null_mut();
    let mut promise = ptr::null_mut();
    let status = unsafe { sys::napi_create_promise(env.raw(), &mut deferred, &mut promise) };
    if status != sys::Status::napi_ok {
        return Err(napi_failure("failed to create resolved promise"));
    }
    let status = unsafe { sys::napi_resolve_deferred(env.raw(), deferred, value.0) };
    if status == sys::Status::napi_ok {
        Ok(RawValue(promise))
    } else {
        Err(napi_failure("failed to resolve promise"))
    }
}

fn create_binding_deferred(env: &Env) -> Result<(BindingDeferred, RawValue)> {
    let (deferred, promise) = env.create_deferred::<RawValue, DeferredResolver>()?;
    Ok((deferred, RawValue(promise.raw())))
}

fn complete_deferred(
    deferred: BindingDeferred,
    outcome: std::result::Result<(), NativeStoreErrorCode>,
) {
    deferred.resolve(Box::new(move |env| match outcome {
        Ok(()) => raw_undefined(&env),
        Err(code) => rejected_promise(&env, code),
    }));
}

fn exact_string_keys(array: &Array<'_>, expected: &[&str]) -> Result<bool> {
    if array.len() as usize != expected.len() {
        return Ok(false);
    }
    let mut found = Vec::with_capacity(expected.len());
    for index in 0..array.len() {
        let Some(value) = array.get::<Unknown<'_>>(index)? else {
            return Ok(false);
        };
        if value.get_type()? != ValueType::String {
            return Ok(false);
        }
        found.push(String::from_unknown(value)?);
    }
    found.sort();
    let mut expected = expected
        .iter()
        .map(|value| (*value).to_owned())
        .collect::<Vec<_>>();
    expected.sort();
    Ok(found == expected)
}

fn data_descriptor_value<'env, T: FromNapiValue>(
    descriptors: &Object<'env>,
    name: &str,
) -> Result<Option<T>> {
    let Some(descriptor) = descriptors.get::<Object<'env>>(name)? else {
        return Ok(None);
    };
    if !descriptor.has_own_property("value")?
        || descriptor.has_own_property("get")?
        || descriptor.has_own_property("set")?
    {
        return Ok(None);
    }
    descriptor.get("value")
}

fn decode_open_options(
    env: &Env,
    intrinsics: &Intrinsics,
    input: Unknown<'_>,
) -> Result<Option<PathBuf>> {
    if input.get_type()? != ValueType::Object {
        return Ok(None);
    }
    let (descriptors, keys) = intrinsics.snapshot_descriptors(env, input)?;
    if !exact_string_keys(&keys, &["trustedHome", "maxStateBytes"])? {
        return Ok(None);
    }
    let Some(trusted_home) = data_descriptor_value::<String>(&descriptors, "trustedHome")? else {
        return Ok(None);
    };
    let Some(max_state_bytes) = data_descriptor_value::<f64>(&descriptors, "maxStateBytes")? else {
        return Ok(None);
    };
    if trusted_home.is_empty()
        || trusted_home.as_bytes().contains(&0)
        || !Path::new(&trusted_home).is_absolute()
        || max_state_bytes != MAX_STATE_BYTES as f64
    {
        return Ok(None);
    }
    Ok(Some(PathBuf::from(trusted_home)))
}

fn open_platform_store(
    lifecycle: &ProcessLifecycleToken,
    trusted_home: &Path,
) -> std::result::Result<Box<dyn StorePort>, NativeStoreErrorCode> {
    #[cfg(target_os = "macos")]
    {
        return relay_v2_broker_credential_state_store_platform_darwin::open(
            lifecycle,
            trusted_home,
            MAX_STATE_BYTES,
        )
        .map(erase_process_store);
    }
    #[cfg(target_os = "linux")]
    {
        use relay_v2_broker_credential_state_store_platform_linux::LinuxOpenError;
        return match relay_v2_broker_credential_state_store_platform_linux::open_linux_state_store(
            lifecycle,
            trusted_home,
        ) {
            Ok(store) => Ok(erase_process_store(store)),
            Err(LinuxOpenError::Store(error)) => Err(error),
            Err(LinuxOpenError::TargetUnsupported) => {
                Err(NativeStoreErrorCode::NativeInterfaceInvalid)
            }
        };
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = (lifecycle, trusted_home);
        Err(NativeStoreErrorCode::NativeInterfaceInvalid)
    }
}

enum ClosePhase<W> {
    Open,
    Running(Vec<W>),
    Finished(std::result::Result<(), NativeStoreErrorCode>),
}

struct BindingState<W> {
    admission_closed: bool,
    close: ClosePhase<W>,
}

impl<W> BindingState<W> {
    fn begin_close(
        &mut self,
        waiter: Option<W>,
    ) -> (
        bool,
        Option<(W, std::result::Result<(), NativeStoreErrorCode>)>,
    ) {
        self.admission_closed = true;
        match &mut self.close {
            ClosePhase::Open => {
                self.close = ClosePhase::Running(waiter.into_iter().collect());
                (true, None)
            }
            ClosePhase::Running(waiters) => {
                if let Some(waiter) = waiter {
                    waiters.push(waiter);
                }
                (false, None)
            }
            ClosePhase::Finished(outcome) => (false, waiter.map(|waiter| (waiter, *outcome))),
        }
    }

    fn finish_close(&mut self, outcome: std::result::Result<(), NativeStoreErrorCode>) -> Vec<W> {
        match std::mem::replace(&mut self.close, ClosePhase::Finished(outcome)) {
            ClosePhase::Running(waiters) => waiters,
            ClosePhase::Open => Vec::new(),
            ClosePhase::Finished(previous) => {
                self.close = ClosePhase::Finished(previous);
                Vec::new()
            }
        }
    }
}

struct RunCommand {
    admission: AdmissionState,
    callback: FunctionRef<RawValue, RawValue>,
    outer: BindingDeferred,
    dispatch: BindingDeferred,
}

struct NapiStoreState {
    port: Arc<dyn StorePort>,
    terminal: Arc<AtomicBool>,
    state: Mutex<BindingState<BindingDeferred>>,
    run_sender: mpsc::Sender<RunCommand>,
    intrinsics: Arc<Intrinsics>,
}

fn finish_native_close(
    store: &Arc<NapiStoreState>,
    outcome: std::result::Result<(), NativeStoreErrorCode>,
) {
    let waiters = { lock_recover(&store.state).finish_close(outcome) };
    for waiter in waiters {
        complete_deferred(waiter, outcome);
    }
}

fn start_native_close_worker(store: Arc<NapiStoreState>) {
    let port = Arc::clone(&store.port);
    std::thread::spawn(move || {
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| port.close()))
            .unwrap_or(Err(NativeStoreErrorCode::NativeInterfaceInvalid));
        finish_native_close(&store, outcome);
    });
}

fn request_close(store: &Arc<NapiStoreState>, waiter: Option<BindingDeferred>, terminal: bool) {
    let (start, cached) = {
        let mut state = lock_recover(&store.state);
        if terminal {
            store.terminal.store(true, Ordering::Release);
        }
        state.begin_close(waiter)
    };
    if let Some((waiter, outcome)) = cached {
        complete_deferred(waiter, outcome);
    }
    if start {
        start_native_close_worker(Arc::clone(store));
    }
}

fn terminal_fence(store: &Arc<NapiStoreState>) {
    request_close(store, None, true);
}

struct RevisionHandle {
    identity: Arc<TransactionIdentity>,
    revision: u64,
}

struct CallbackCompletion {
    native: Mutex<NativeCompletion>,
    outer: Mutex<Option<BindingDeferred>>,
    worker_ack: Mutex<Option<mpsc::Sender<()>>>,
    store: Arc<NapiStoreState>,
}

impl CallbackCompletion {
    fn finish(&self, callback_error: Option<NativeStoreErrorCode>) {
        let outcome = match lock_recover(&self.native).finish(callback_error) {
            NativeCompletionResult::Settled(outcome) => outcome,
            NativeCompletionResult::Duplicate => {
                terminal_fence(&self.store);
                return;
            }
        };
        if outcome.is_err() {
            terminal_fence(&self.store);
        }
        if let Some(outer) = lock_recover(&self.outer).take() {
            complete_deferred(outer, outcome);
        }
        if let Some(ack) = lock_recover(&self.worker_ack).take() {
            let _ = ack.send(());
        }
    }
}

fn create_revision<'env>(
    env: &'env Env,
    identity: Arc<TransactionIdentity>,
    revision: u64,
) -> Result<Object<'env>> {
    // Identity and token exist only in napi_wrap. There are no JS own fields to
    // copy, and a serialized/reparsed object cannot reproduce the native tag.
    let mut opaque = Object::new(env)?;
    opaque.wrap(RevisionHandle { identity, revision }, None)?;
    opaque.freeze()?;
    Ok(opaque)
}

fn create_read_result<'env>(
    env: &'env Env,
    identity: Arc<TransactionIdentity>,
    snapshot: PortSnapshot,
) -> Result<Object<'env>> {
    let mut result = Object::new(env)?;
    match snapshot.bytes {
        Some(bytes) => {
            define_own_data(env, &mut result, "outcome", "present")?;
            define_own_data(
                env,
                &mut result,
                "revision",
                create_revision(env, identity, snapshot.revision)?,
            )?;
            define_own_data(env, &mut result, "bytes", Uint8Array::new(bytes))?;
        }
        None => {
            define_own_data(env, &mut result, "outcome", "missing")?;
            define_own_data(
                env,
                &mut result,
                "revision",
                create_revision(env, identity, snapshot.revision)?,
            )?;
        }
    }
    Ok(result)
}

fn create_publish_result<'env>(
    env: &'env Env,
    identity: Arc<TransactionIdentity>,
    outcome: PortPublishOutcome,
) -> Result<Object<'env>> {
    let mut result = Object::new(env)?;
    match outcome {
        PortPublishOutcome::Swapped(current) => {
            define_own_data(env, &mut result, "outcome", "swapped")?;
            define_own_data(
                env,
                &mut result,
                "current",
                create_read_result(env, identity, current)?,
            )?;
        }
        PortPublishOutcome::AlreadySame(current) => {
            define_own_data(env, &mut result, "outcome", "already_same")?;
            define_own_data(
                env,
                &mut result,
                "current",
                create_read_result(env, identity, current)?,
            )?;
        }
        PortPublishOutcome::Conflict(current) => {
            define_own_data(env, &mut result, "outcome", "conflict")?;
            define_own_data(
                env,
                &mut result,
                "current",
                create_read_result(env, identity, current)?,
            )?;
        }
        PortPublishOutcome::Uncertain => {
            define_own_data(env, &mut result, "outcome", "uncertain")?;
        }
    }
    Ok(result)
}

fn is_proven_no_commit(code: NativeStoreErrorCode) -> bool {
    matches!(
        code,
        NativeStoreErrorCode::InvalidArgument
            | NativeStoreErrorCode::InvalidRevision
            | NativeStoreErrorCode::StateTooLarge
            | NativeStoreErrorCode::GenerationExhausted
    )
}

fn encode_failure_after_operation(env: &Env, store: &Arc<NapiStoreState>) -> Result<RawValue> {
    terminal_fence(store);
    clear_pending_exception(env);
    rejected_promise(env, NativeStoreErrorCode::NativeInterfaceInvalid)
}

fn create_transaction_object<'env>(
    env: &'env Env,
    completion: Arc<CallbackCompletion>,
) -> Result<Object<'env>> {
    let mut object = Object::new(env)?;
    let read_completion = Arc::clone(&completion);
    let read = env.create_function_from_closure::<(), RawValue, _>(
        "read",
        move |context: FunctionCallContext<'_>| {
            let result = {
                let mut native = lock_recover(&read_completion.native);
                let transaction = native.transaction_mut();
                transaction.and_then(|transaction| {
                    let identity = transaction.identity();
                    transaction.read().map(|snapshot| (identity, snapshot))
                })
            };
            match result {
                Ok((identity, snapshot)) => {
                    match create_read_result(context.env, identity, snapshot)
                        .and_then(|value| resolved_promise(context.env, RawValue(value.raw())))
                    {
                        Ok(promise) => Ok(promise),
                        Err(_) => {
                            encode_failure_after_operation(context.env, &read_completion.store)
                        }
                    }
                }
                // Read is not a publication boundary; preserve the native
                // closed code without reusing post-publish terminal rules.
                Err(code) => rejected_promise(context.env, code),
            }
        },
    )?;
    define_own_data(env, &mut object, "read", read)?;

    let publish_completion = Arc::clone(&completion);
    let publish = env.create_function_from_closure::<(Unknown<'_>, Unknown<'_>), RawValue, _>(
        "compareAndPublish",
        move |context: FunctionCallContext<'_>| {
            let prepared = (|| -> std::result::Result<_, NativeStoreErrorCode> {
                let expected = context
                    .get::<Unknown<'_>>(0)
                    .map_err(|_| NativeStoreErrorCode::InvalidRevision)?;
                let expected = Object::from_unknown(expected)
                    .map_err(|_| NativeStoreErrorCode::InvalidRevision)?;
                let handle = expected
                    .unwrap::<RevisionHandle>()
                    .map_err(|_| NativeStoreErrorCode::InvalidRevision)?;
                let expected_identity = Arc::clone(&handle.identity);
                let expected_revision = handle.revision;
                let next = context
                    .get::<Unknown<'_>>(1)
                    .map_err(|_| NativeStoreErrorCode::InvalidArgument)?;
                let next = Uint8Array::from_unknown(next)
                    .map_err(|_| NativeStoreErrorCode::InvalidArgument)?;
                if next.is_empty() {
                    return Err(NativeStoreErrorCode::InvalidArgument);
                }
                if next.len() > MAX_STATE_BYTES {
                    return Err(NativeStoreErrorCode::StateTooLarge);
                }
                // The JS ArrayBuffer is copied before any await, worker, or
                // native I/O can observe caller mutation.
                Ok((expected_identity, expected_revision, next.to_vec()))
            })();
            let (expected_identity, expected_revision, next) = match prepared {
                Ok(prepared) => prepared,
                Err(code) => return rejected_promise(context.env, code),
            };

            let result = {
                let mut native = lock_recover(&publish_completion.native);
                let transaction = native.transaction_mut();
                transaction.and_then(|transaction| {
                    let identity = transaction.identity();
                    if !same_transaction(&identity, &expected_identity) {
                        return Err(NativeStoreErrorCode::InvalidRevision);
                    }
                    transaction
                        .compare_and_publish(expected_revision, &next)
                        .map(|outcome| (identity, outcome))
                })
            };
            let (identity, outcome) = match result {
                Ok(result) => result,
                Err(code) => {
                    if !is_proven_no_commit(code) {
                        terminal_fence(&publish_completion.store);
                    }
                    return rejected_promise(context.env, code);
                }
            };

            // Uncertain is terminal before the result can become visible, and
            // the shared atomic immediately closes this transaction's methods.
            if matches!(outcome, PortPublishOutcome::Uncertain) {
                terminal_fence(&publish_completion.store);
            }
            match create_publish_result(context.env, identity, outcome)
                .and_then(|value| resolved_promise(context.env, RawValue(value.raw())))
            {
                Ok(promise) => Ok(promise),
                // Native publication already returned. Encoding/completion
                // failure is unproven-to-JS and therefore terminal.
                Err(_) => encode_failure_after_operation(context.env, &publish_completion.store),
            }
        },
    )?;
    define_own_data(env, &mut object, "compareAndPublish", publish)?;
    Ok(object)
}

fn start_callback(
    env: &Env,
    store: Arc<NapiStoreState>,
    transaction: TransactionState,
    callback: FunctionRef<RawValue, RawValue>,
    outer: BindingDeferred,
    worker_ack: mpsc::Sender<()>,
) {
    let completion = Arc::new(CallbackCompletion {
        native: Mutex::new(NativeCompletion::new(transaction)),
        outer: Mutex::new(Some(outer)),
        worker_ack: Mutex::new(Some(worker_ack)),
        store: Arc::clone(&store),
    });
    let transaction_object = match create_transaction_object(env, Arc::clone(&completion)) {
        Ok(value) => value,
        Err(_) => {
            completion.finish(Some(NativeStoreErrorCode::NativeInterfaceInvalid));
            return;
        }
    };
    let callback = match callback.borrow_back(env) {
        Ok(callback) => callback,
        Err(_) => {
            completion.finish(Some(NativeStoreErrorCode::NativeInterfaceInvalid));
            return;
        }
    };
    let callback_result = match callback.call(RawValue(transaction_object.raw())) {
        Ok(value) => value,
        Err(_) => {
            clear_pending_exception(env);
            completion.finish(Some(NativeStoreErrorCode::NativeInterfaceInvalid));
            return;
        }
    };
    let callback_promise = match store.intrinsics.promise_resolve(env, callback_result) {
        Ok(promise) => promise,
        Err(_) => {
            clear_pending_exception(env);
            completion.finish(Some(NativeStoreErrorCode::NativeInterfaceInvalid));
            return;
        }
    };

    let fulfilled_completion = Arc::clone(&completion);
    let fulfilled = match env.create_function_from_closure::<(Unknown<'_>,), RawValue, _>(
        "relayV2NativeCallbackFulfilled",
        move |context: FunctionCallContext<'_>| {
            fulfilled_completion.finish(None);
            raw_undefined(context.env)
        },
    ) {
        Ok(value) => value,
        Err(_) => {
            completion.finish(Some(NativeStoreErrorCode::NativeInterfaceInvalid));
            return;
        }
    };
    let rejected_completion = Arc::clone(&completion);
    let rejected = match env.create_function_from_closure::<(Unknown<'_>,), RawValue, _>(
        "relayV2NativeCallbackRejected",
        move |context: FunctionCallContext<'_>| {
            rejected_completion.finish(Some(NativeStoreErrorCode::NativeInterfaceInvalid));
            raw_undefined(context.env)
        },
    ) {
        Ok(value) => value,
        Err(_) => {
            completion.finish(Some(NativeStoreErrorCode::NativeInterfaceInvalid));
            return;
        }
    };

    // One captured intrinsic call installs both branches; there is no sibling
    // catch chain and both handlers share the same atomic completion owner.
    if store
        .intrinsics
        .promise_then(
            env,
            callback_promise,
            RawValue(fulfilled.raw()),
            RawValue(rejected.raw()),
        )
        .is_err()
    {
        clear_pending_exception(env);
        completion.finish(Some(NativeStoreErrorCode::NativeInterfaceInvalid));
    }
}

fn reject_unstarted(command: RunCommand, code: NativeStoreErrorCode) {
    complete_deferred(command.outer, Err(code));
    complete_deferred(command.dispatch, Ok(()));
}

fn run_store_worker(store: Weak<NapiStoreState>, receiver: mpsc::Receiver<RunCommand>) {
    while let Ok(command) = receiver.recv() {
        let Some(store) = store.upgrade() else {
            reject_unstarted(command, NativeStoreErrorCode::StoreClosed);
            break;
        };
        if store.terminal.load(Ordering::Acquire) {
            reject_unstarted(command, NativeStoreErrorCode::StoreClosed);
            continue;
        }
        let transaction = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            command.admission.enter(Arc::clone(&store.terminal))
        }))
        .unwrap_or(Err(NativeStoreErrorCode::NativeInterfaceInvalid))
        {
            Ok(transaction) => transaction,
            Err(code) => {
                terminal_fence(&store);
                complete_deferred(command.outer, Err(code));
                complete_deferred(command.dispatch, Ok(()));
                continue;
            }
        };

        let (ack_sender, ack_receiver) = mpsc::channel();
        let callback_store = Arc::clone(&store);
        command.dispatch.resolve(Box::new(move |env| {
            start_callback(
                &env,
                callback_store,
                transaction,
                command.callback,
                command.outer,
                ack_sender,
            );
            raw_undefined(&env)
        }));
        // Exactly one transaction can be entered or waiting on its callback per
        // store. Queued admissions consume no libuv worker threads.
        if ack_receiver.recv().is_err() {
            terminal_fence(&store);
            break;
        }
    }
}

fn run_exclusive(
    env: &Env,
    store: Arc<NapiStoreState>,
    callback_value: Unknown<'_>,
) -> Result<RawValue> {
    let (outer, promise) = create_binding_deferred(env)?;
    let (dispatch, _dispatch_promise) = create_binding_deferred(env)?;
    let callback = match Function::<RawValue, RawValue>::from_unknown(callback_value)
        .and_then(|callback| callback.create_ref())
    {
        Ok(callback) => callback,
        Err(_) => {
            complete_deferred(outer, Err(NativeStoreErrorCode::NativeInterfaceInvalid));
            complete_deferred(dispatch, Ok(()));
            return Ok(promise);
        }
    };

    let state = lock_recover(&store.state);
    if state.admission_closed {
        drop(state);
        complete_deferred(outer, Err(NativeStoreErrorCode::StoreClosed));
        complete_deferred(dispatch, Ok(()));
        return Ok(promise);
    }
    let admission = match store.port.admit() {
        Ok(admission) => AdmissionState::new(admission),
        Err(code) => {
            drop(state);
            terminal_fence(&store);
            complete_deferred(outer, Err(code));
            complete_deferred(dispatch, Ok(()));
            return Ok(promise);
        }
    };
    let command = RunCommand {
        admission,
        callback,
        outer,
        dispatch,
    };
    if let Err(error) = store.run_sender.send(command) {
        drop(state);
        terminal_fence(&store);
        reject_unstarted(error.0, NativeStoreErrorCode::NativeInterfaceInvalid);
    }
    Ok(promise)
}

fn close_store(env: &Env, store: Arc<NapiStoreState>) -> Result<RawValue> {
    let (waiter, promise) = create_binding_deferred(env)?;
    request_close(&store, Some(waiter), false);
    Ok(promise)
}

fn create_store_object<'env>(
    env: &'env Env,
    port: Box<dyn StorePort>,
    intrinsics: Arc<Intrinsics>,
) -> Result<Object<'env>> {
    let (run_sender, run_receiver) = mpsc::channel();
    let store = Arc::new(NapiStoreState {
        port: Arc::from(port),
        terminal: Arc::new(AtomicBool::new(false)),
        state: Mutex::new(BindingState {
            admission_closed: false,
            close: ClosePhase::Open,
        }),
        run_sender,
        intrinsics,
    });
    let worker_store = Arc::downgrade(&store);
    std::thread::spawn(move || run_store_worker(worker_store, run_receiver));

    let mut object = Object::new(env)?;
    let run_store = Arc::clone(&store);
    let run = env.create_function_from_closure::<(Unknown<'_>,), RawValue, _>(
        "runExclusive",
        move |context: FunctionCallContext<'_>| {
            let callback = match context.get::<Unknown<'_>>(0) {
                Ok(value) => value,
                Err(_) => {
                    return rejected_promise(
                        context.env,
                        NativeStoreErrorCode::NativeInterfaceInvalid,
                    );
                }
            };
            run_exclusive(context.env, Arc::clone(&run_store), callback)
        },
    )?;
    define_own_data(env, &mut object, "runExclusive", run)?;

    let close_store_state = Arc::clone(&store);
    let close = env.create_function_from_closure::<(), RawValue, _>(
        "close",
        move |context: FunctionCallContext<'_>| {
            close_store(context.env, Arc::clone(&close_store_state))
        },
    )?;
    define_own_data(env, &mut object, "close", close)?;
    Ok(object)
}

fn open_binding<'env>(
    env: &'env Env,
    intrinsics: Arc<Intrinsics>,
    input: Unknown<'env>,
) -> Result<Object<'env>> {
    if !supported_target() {
        return create_unsupported(env, "target_unsupported");
    }
    let lifecycle = match lifecycle() {
        Ok(lifecycle) => lifecycle,
        Err(code) => return create_invalid_open(env, *code),
    };
    let trusted_home = match decode_open_options(env, &intrinsics, input)? {
        Some(value) => value,
        None => return create_invalid_open(env, NativeStoreErrorCode::InvalidArgument),
    };
    match open_platform_store(lifecycle, &trusted_home) {
        Ok(port) => {
            let mut result = Object::new(env)?;
            define_own_data(env, &mut result, "status", "opened")?;
            define_own_data(env, &mut result, "selfCheck", "passed")?;
            define_own_data(
                env,
                &mut result,
                "store",
                create_store_object(env, port, intrinsics)?,
            )?;
            Ok(result)
        }
        Err(code) => create_invalid_open(env, code),
    }
}

#[napi(module_exports)]
fn initialize(mut exports: Object<'_>, env: Env) -> Result<()> {
    // Eager, exactly once, immutable after failure or fork.
    let _ = lifecycle();
    let intrinsics = Arc::new(Intrinsics::capture(&env)?);

    let capability = env.create_function_from_closure::<(), RawValue, _>(
        "relayV2BrokerCredentialStateCapability",
        move |context: FunctionCallContext<'_>| {
            create_capability(context.env).map(|value| RawValue(value.raw()))
        },
    )?;
    define_own_data(
        &env,
        &mut exports,
        "relayV2BrokerCredentialStateCapability",
        capability,
    )?;

    let open_intrinsics = Arc::clone(&intrinsics);
    let open = env.create_function_from_closure::<(Unknown<'_>,), RawValue, _>(
        "openRelayV2BrokerCredentialStateStore",
        move |context: FunctionCallContext<'_>| {
            let input = match context.get::<Unknown<'_>>(0) {
                Ok(value) => value,
                Err(_) => {
                    return create_invalid_open(context.env, NativeStoreErrorCode::InvalidArgument)
                        .map(|value| RawValue(value.raw()));
                }
            };
            open_binding(context.env, Arc::clone(&open_intrinsics), input)
                .map(|value| RawValue(value.raw()))
        },
    )?;
    define_own_data(
        &env,
        &mut exports,
        "openRelayV2BrokerCredentialStateStore",
        open,
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn eager_lifecycle_failure_is_closed_invalid() {
        let failed: std::result::Result<ProcessLifecycleToken, NativeStoreErrorCode> =
            Err(NativeStoreErrorCode::StoreClosed);
        assert_eq!(
            capability_decision(true, &failed),
            CapabilityDecision::Invalid(NativeStoreErrorCode::StoreClosed)
        );
    }

    #[test]
    fn post_publish_proven_no_commit_classification_includes_generation_exhaustion() {
        for code in [
            NativeStoreErrorCode::InvalidArgument,
            NativeStoreErrorCode::InvalidRevision,
            NativeStoreErrorCode::StateTooLarge,
            NativeStoreErrorCode::GenerationExhausted,
        ] {
            assert!(is_proven_no_commit(code));
        }
        assert!(!is_proven_no_commit(NativeStoreErrorCode::StoreIo));
        assert!(!is_proven_no_commit(
            NativeStoreErrorCode::NativeInterfaceInvalid
        ));
    }

    #[test]
    fn close_waiter_registration_and_cached_completion_share_one_state_transition() {
        let mut state = BindingState {
            admission_closed: false,
            close: ClosePhase::Open,
        };
        let (start, cached) = state.begin_close(Some(1_u8));
        assert!(start);
        assert!(cached.is_none());
        assert_eq!(state.finish_close(Ok(())), vec![1]);

        // A waiter arriving after completion cannot be pushed into a drained
        // list: the same transition returns the cached result immediately.
        let (start, cached) = state.begin_close(Some(2_u8));
        assert!(!start);
        assert_eq!(cached, Some((2, Ok(()))));
        assert!(state.finish_close(Ok(())).is_empty());
    }
}
