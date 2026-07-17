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
use napi::{sys, Env, Error, JsValue, Property, Result, Status, ValueType};
use napi_derive::napi;
use relay_v2_broker_credential_state_store_platform_common::{
    initialize_process_lifecycle, NativeStoreErrorCode, ProcessLifecycleToken,
};
use std::path::{Path, PathBuf};
use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, MutexGuard, OnceLock};
use std::thread;

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

trait MainThreadTask: Send {
    fn run(&mut self, env: Env);
    fn dispatch_failed(&mut self);
}

struct MainThreadDispatcher {
    raw: sys::napi_threadsafe_function,
}

unsafe impl Send for MainThreadDispatcher {}

impl MainThreadDispatcher {
    fn new(env: &Env) -> Result<Self> {
        let mut resource_name = ptr::null_mut();
        let name = b"relay_v2_broker_credential_state_store_dispatch";
        let status = unsafe {
            sys::napi_create_string_utf8(
                env.raw(),
                name.as_ptr().cast(),
                name.len() as isize,
                &mut resource_name,
            )
        };
        if status != sys::Status::napi_ok {
            return Err(napi_failure("failed to create dispatch resource name"));
        }

        let mut raw = ptr::null_mut();
        let status = unsafe {
            sys::napi_create_threadsafe_function(
                env.raw(),
                ptr::null_mut(),
                ptr::null_mut(),
                resource_name,
                0,
                1,
                ptr::null_mut(),
                None,
                ptr::null_mut(),
                Some(run_main_thread_task),
                &mut raw,
            )
        };
        if status != sys::Status::napi_ok {
            return Err(napi_failure("failed to create main-thread dispatcher"));
        }
        Ok(Self { raw })
    }

    fn dispatch(self, task: Box<dyn MainThreadTask>) -> bool {
        let task = Box::into_raw(Box::new(task));
        let status = unsafe {
            sys::napi_call_threadsafe_function(
                self.raw,
                task.cast(),
                sys::ThreadsafeFunctionCallMode::blocking,
            )
        };
        if status == sys::Status::napi_ok {
            true
        } else {
            let mut task = unsafe { *Box::from_raw(task) };
            task.dispatch_failed();
            false
        }
    }
}

impl Drop for MainThreadDispatcher {
    fn drop(&mut self) {
        let _ = unsafe {
            sys::napi_release_threadsafe_function(
                self.raw,
                sys::ThreadsafeFunctionReleaseMode::release,
            )
        };
    }
}

unsafe extern "C" fn run_main_thread_task(
    raw_env: sys::napi_env,
    _callback: sys::napi_value,
    _context: *mut std::ffi::c_void,
    data: *mut std::ffi::c_void,
) {
    if data.is_null() {
        return;
    }
    let mut task = *Box::<Box<dyn MainThreadTask>>::from_raw(data.cast());
    if raw_env.is_null() {
        task.dispatch_failed();
        return;
    }
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        task.run(Env::from_raw(raw_env));
    }));
    if outcome.is_err() {
        task.dispatch_failed();
    }
}

struct BindingDeferred {
    raw: usize,
    dispatcher: MainThreadDispatcher,
}

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
    let mut deferred = ptr::null_mut();
    let mut promise = ptr::null_mut();
    let status = unsafe { sys::napi_create_promise(env.raw(), &mut deferred, &mut promise) };
    if status != sys::Status::napi_ok {
        return Err(napi_failure("failed to create binding promise"));
    }
    Ok((
        BindingDeferred {
            raw: deferred as usize,
            dispatcher: MainThreadDispatcher::new(env)?,
        },
        RawValue(promise),
    ))
}

struct CompleteDeferredTask {
    deferred: usize,
    outcome: std::result::Result<(), NativeStoreErrorCode>,
}

impl MainThreadTask for CompleteDeferredTask {
    fn run(&mut self, env: Env) {
        let deferred = self.deferred as sys::napi_deferred;
        let status = match self.outcome {
            Ok(()) => raw_undefined(&env).and_then(|value| {
                let status = unsafe { sys::napi_resolve_deferred(env.raw(), deferred, value.0) };
                if status == sys::Status::napi_ok {
                    Ok(())
                } else {
                    Err(napi_failure("failed to resolve binding promise"))
                }
            }),
            Err(code) => create_error_object(&env, code).and_then(|error| {
                let status = unsafe { sys::napi_reject_deferred(env.raw(), deferred, error.raw()) };
                if status == sys::Status::napi_ok {
                    Ok(())
                } else {
                    Err(napi_failure("failed to reject binding promise"))
                }
            }),
        };
        if status.is_err() {
            clear_pending_exception(&env);
        }
    }

    fn dispatch_failed(&mut self) {}
}

fn complete_deferred(
    deferred: BindingDeferred,
    outcome: std::result::Result<(), NativeStoreErrorCode>,
) -> bool {
    let task = CompleteDeferredTask {
        deferred: deferred.raw,
        outcome,
    };
    deferred.dispatcher.dispatch(Box::new(task))
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

fn data_descriptor_value<'env>(
    descriptors: &Object<'env>,
    name: &str,
) -> Result<Option<Unknown<'env>>> {
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
    let Some(trusted_home) = data_descriptor_value(&descriptors, "trustedHome")? else {
        return Ok(None);
    };
    if trusted_home.get_type()? != ValueType::String {
        return Ok(None);
    }
    let trusted_home = String::from_unknown(trusted_home)?;
    let Some(max_state_bytes) = data_descriptor_value(&descriptors, "maxStateBytes")? else {
        return Ok(None);
    };
    if max_state_bytes.get_type()? != ValueType::Number {
        return Ok(None);
    }
    let max_state_bytes = f64::from_unknown(max_state_bytes)?;
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
    store: Arc<NapiStoreState>,
    admission: AdmissionState,
    callback: FunctionRef<RawValue, RawValue>,
    outer: BindingDeferred,
    dispatch: MainThreadDispatcher,
}

enum StoreWorkerCommand {
    Run(RunCommand),
    CloseAfterWorkerFailure(Arc<NapiStoreState>),
}

struct NapiStoreState {
    port: Arc<dyn StorePort>,
    terminal: Arc<AtomicBool>,
    state: Mutex<BindingState<BindingDeferred>>,
    run_sender: mpsc::Sender<StoreWorkerCommand>,
    close_sender: mpsc::Sender<Arc<NapiStoreState>>,
    intrinsics: Arc<Intrinsics>,
}

struct CreatedStore<'env> {
    object: Object<'env>,
    state: Arc<NapiStoreState>,
}

fn finish_native_close(
    store: &Arc<NapiStoreState>,
    outcome: std::result::Result<(), NativeStoreErrorCode>,
) {
    if outcome.is_err() {
        store.terminal.store(true, Ordering::Release);
    }
    let waiters = { lock_recover(&store.state).finish_close(outcome) };
    for waiter in waiters {
        let _ = complete_deferred(waiter, outcome);
    }
}

fn close_port_safely(store: &Arc<NapiStoreState>) -> std::result::Result<(), NativeStoreErrorCode> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| store.port.close()))
        .unwrap_or(Err(NativeStoreErrorCode::NativeInterfaceInvalid))
}

fn run_close_worker(receiver: mpsc::Receiver<Arc<NapiStoreState>>) {
    while let Ok(store) = receiver.recv() {
        let outcome = close_port_safely(&store);
        finish_native_close(&store, outcome);
    }
}

fn finish_failed_close_dispatch(store: Arc<NapiStoreState>) {
    store.terminal.store(true, Ordering::Release);
    finish_native_close(&store, Err(NativeStoreErrorCode::NativeInterfaceInvalid));
    let cleanup = StoreWorkerCommand::CloseAfterWorkerFailure(Arc::clone(&store));
    if store.run_sender.send(cleanup).is_err() {
        // A disconnected serial worker cannot own an entered transaction. The
        // synchronous fallback is therefore safe and still releases the common
        // ProcessBound descriptor after both worker channels have failed.
        let _ = close_port_safely(&store);
    }
}

fn start_native_close(store: Arc<NapiStoreState>) {
    if let Err(error) = store.close_sender.send(Arc::clone(&store)) {
        finish_failed_close_dispatch(error.0);
    }
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
        let _ = complete_deferred(waiter, outcome);
    }
    if start {
        start_native_close(Arc::clone(store));
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
    fn finish(&self, protocol_violation: bool) {
        let callback_error =
            protocol_violation.then_some(NativeStoreErrorCode::NativeInterfaceInvalid);
        // Callback/protocol failures close admission before authoritative
        // settlement. If settlement also fails, the raw callback rejection
        // remains the frozen NATIVE_INTERFACE_INVALID code.
        if protocol_violation {
            terminal_fence(&self.store);
        }
        let outcome = match lock_recover(&self.native).finish(callback_error) {
            NativeCompletionResult::Settled(outcome) => outcome,
            NativeCompletionResult::Duplicate => {
                terminal_fence(&self.store);
                if let Some(outer) = lock_recover(&self.outer).take() {
                    let _ =
                        complete_deferred(outer, Err(NativeStoreErrorCode::NativeInterfaceInvalid));
                }
                if let Some(ack) = lock_recover(&self.worker_ack).take() {
                    let _ = ack.send(());
                }
                return;
            }
        };
        if outcome.is_err() {
            terminal_fence(&self.store);
        }
        if let Some(outer) = lock_recover(&self.outer).take() {
            if !complete_deferred(outer, outcome) {
                terminal_fence(&self.store);
            }
        }
        if let Some(ack) = lock_recover(&self.worker_ack).take() {
            if ack.send(()).is_err() {
                terminal_fence(&self.store);
            }
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

fn encode_read_failure(env: &Env) -> Result<RawValue> {
    clear_pending_exception(env);
    rejected_promise(env, NativeStoreErrorCode::NativeInterfaceInvalid)
}

fn encode_failure_after_publication(env: &Env, store: &Arc<NapiStoreState>) -> Result<RawValue> {
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
                        // Read has no publication ambiguity. JS encoding or
                        // promise completion failure rejects exactly but does
                        // not permanently close an otherwise usable store.
                        Err(_) => encode_read_failure(context.env),
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
                Err(_) => encode_failure_after_publication(context.env, &publish_completion.store),
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
            completion.finish(true);
            return;
        }
    };
    let callback = match callback.borrow_back(env) {
        Ok(callback) => callback,
        Err(_) => {
            completion.finish(true);
            return;
        }
    };
    let callback_result = match callback.call(RawValue(transaction_object.raw())) {
        Ok(value) => value,
        Err(_) => {
            clear_pending_exception(env);
            completion.finish(true);
            return;
        }
    };
    let callback_promise = match store.intrinsics.promise_resolve(env, callback_result) {
        Ok(promise) => promise,
        Err(_) => {
            clear_pending_exception(env);
            completion.finish(true);
            return;
        }
    };

    let fulfilled_completion = Arc::clone(&completion);
    let fulfilled = match env.create_function_from_closure::<(Unknown<'_>,), RawValue, _>(
        "relayV2NativeCallbackFulfilled",
        move |context: FunctionCallContext<'_>| {
            fulfilled_completion.finish(false);
            raw_undefined(context.env)
        },
    ) {
        Ok(value) => value,
        Err(_) => {
            completion.finish(true);
            return;
        }
    };
    let rejected_completion = Arc::clone(&completion);
    let rejected = match env.create_function_from_closure::<(Unknown<'_>,), RawValue, _>(
        "relayV2NativeCallbackRejected",
        move |context: FunctionCallContext<'_>| {
            rejected_completion.finish(true);
            raw_undefined(context.env)
        },
    ) {
        Ok(value) => value,
        Err(_) => {
            completion.finish(true);
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
        completion.finish(true);
    }
}

struct RunCallbackTask {
    store: Arc<NapiStoreState>,
    transaction: Option<TransactionState>,
    callback: Option<FunctionRef<RawValue, RawValue>>,
    outer: Option<BindingDeferred>,
    worker_ack: Option<mpsc::Sender<()>>,
}

impl MainThreadTask for RunCallbackTask {
    fn run(&mut self, env: Env) {
        let Some(transaction) = self.transaction.take() else {
            self.dispatch_failed();
            return;
        };
        let Some(callback) = self.callback.take() else {
            self.transaction = Some(transaction);
            self.dispatch_failed();
            return;
        };
        let Some(outer) = self.outer.take() else {
            self.transaction = Some(transaction);
            self.callback = Some(callback);
            self.dispatch_failed();
            return;
        };
        let Some(worker_ack) = self.worker_ack.take() else {
            self.transaction = Some(transaction);
            self.callback = Some(callback);
            self.outer = Some(outer);
            self.dispatch_failed();
            return;
        };
        start_callback(
            &env,
            Arc::clone(&self.store),
            transaction,
            callback,
            outer,
            worker_ack,
        );
    }

    fn dispatch_failed(&mut self) {
        terminal_fence(&self.store);
        if let Some(mut transaction) = self.transaction.take() {
            let _ = transaction.settle();
        }
        if let Some(outer) = self.outer.take() {
            let _ = complete_deferred(outer, Err(NativeStoreErrorCode::NativeInterfaceInvalid));
        }
        if let Some(ack) = self.worker_ack.take() {
            let _ = ack.send(());
        }
        self.callback.take();
    }
}

fn reject_unstarted(command: RunCommand, code: NativeStoreErrorCode) -> bool {
    complete_deferred(command.outer, Err(code))
}

fn drain_store_worker(receiver: &mpsc::Receiver<StoreWorkerCommand>) {
    while let Ok(command) = receiver.try_recv() {
        match command {
            StoreWorkerCommand::Run(command) => {
                let _ = reject_unstarted(command, NativeStoreErrorCode::StoreClosed);
            }
            StoreWorkerCommand::CloseAfterWorkerFailure(store) => {
                let _ = close_port_safely(&store);
            }
        }
    }
}

fn run_store_worker(receiver: mpsc::Receiver<StoreWorkerCommand>) {
    while let Ok(worker_command) = receiver.recv() {
        let command = match worker_command {
            StoreWorkerCommand::Run(command) => command,
            StoreWorkerCommand::CloseAfterWorkerFailure(store) => {
                let _ = close_port_safely(&store);
                continue;
            }
        };
        let store = Arc::clone(&command.store);
        if store.terminal.load(Ordering::Acquire) {
            if !reject_unstarted(command, NativeStoreErrorCode::StoreClosed) {
                drain_store_worker(&receiver);
                return;
            }
            continue;
        }

        let RunCommand {
            store: command_store,
            admission,
            callback,
            outer,
            dispatch,
        } = command;
        let transaction = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            admission.enter(Arc::clone(&store.terminal))
        }))
        .unwrap_or(Err(NativeStoreErrorCode::NativeInterfaceInvalid))
        {
            Ok(transaction) => transaction,
            Err(code) => {
                terminal_fence(&store);
                let _ = complete_deferred(outer, Err(code));
                drop((callback, dispatch, command_store));
                drain_store_worker(&receiver);
                return;
            }
        };

        let (ack_sender, ack_receiver) = mpsc::channel();
        let task = RunCallbackTask {
            store: command_store,
            transaction: Some(transaction),
            callback: Some(callback),
            outer: Some(outer),
            worker_ack: Some(ack_sender),
        };
        if !dispatch.dispatch(Box::new(task)) {
            drain_store_worker(&receiver);
            return;
        }
        // Exactly one transaction can be entered or waiting on its callback per
        // store. Queued admissions consume no libuv worker threads.
        if ack_receiver.recv().is_err() {
            terminal_fence(&store);
            drain_store_worker(&receiver);
            return;
        }
    }
}

fn run_exclusive(
    env: &Env,
    store: Arc<NapiStoreState>,
    callback_value: Unknown<'_>,
) -> Result<RawValue> {
    let (outer, promise) = create_binding_deferred(env)?;
    let dispatch = match MainThreadDispatcher::new(env) {
        Ok(dispatch) => dispatch,
        Err(_) => {
            let _ = complete_deferred(outer, Err(NativeStoreErrorCode::NativeInterfaceInvalid));
            return Ok(promise);
        }
    };
    let callback = match Function::<RawValue, RawValue>::from_unknown(callback_value)
        .and_then(|callback| callback.create_ref())
    {
        Ok(callback) => callback,
        Err(_) => {
            let _ = complete_deferred(outer, Err(NativeStoreErrorCode::NativeInterfaceInvalid));
            return Ok(promise);
        }
    };

    let state = lock_recover(&store.state);
    if state.admission_closed {
        drop(state);
        let _ = complete_deferred(outer, Err(NativeStoreErrorCode::StoreClosed));
        return Ok(promise);
    }
    let admission = match store.port.admit() {
        Ok(admission) => AdmissionState::new(admission),
        Err(code) => {
            drop(state);
            terminal_fence(&store);
            let _ = complete_deferred(outer, Err(code));
            return Ok(promise);
        }
    };
    let command = RunCommand {
        store: Arc::clone(&store),
        admission,
        callback,
        outer,
        dispatch,
    };
    if let Err(error) = store.run_sender.send(StoreWorkerCommand::Run(command)) {
        drop(state);
        terminal_fence(&store);
        if let StoreWorkerCommand::Run(command) = error.0 {
            let _ = reject_unstarted(command, NativeStoreErrorCode::NativeInterfaceInvalid);
        }
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
) -> Result<Option<CreatedStore<'env>>> {
    let (run_sender, run_receiver) = mpsc::channel();
    let (close_sender, close_receiver) = mpsc::channel();
    let store = Arc::new(NapiStoreState {
        port: Arc::from(port),
        terminal: Arc::new(AtomicBool::new(false)),
        state: Mutex::new(BindingState {
            admission_closed: false,
            close: ClosePhase::Open,
        }),
        run_sender,
        close_sender,
        intrinsics,
    });
    if thread::Builder::new()
        .name("relay-v2-state-store-serial".to_owned())
        .spawn(move || run_store_worker(run_receiver))
        .is_err()
    {
        store.terminal.store(true, Ordering::Release);
        lock_recover(&store.state).begin_close(None);
        let _ = close_port_safely(&store);
        finish_native_close(&store, Err(NativeStoreErrorCode::NativeInterfaceInvalid));
        return Ok(None);
    }
    if thread::Builder::new()
        .name("relay-v2-state-store-close".to_owned())
        .spawn(move || run_close_worker(close_receiver))
        .is_err()
    {
        store.terminal.store(true, Ordering::Release);
        lock_recover(&store.state).begin_close(None);
        let _ = close_port_safely(&store);
        finish_native_close(&store, Err(NativeStoreErrorCode::NativeInterfaceInvalid));
        return Ok(None);
    }

    let result = (|| -> Result<Object<'env>> {
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
    })();
    if result.is_err() {
        terminal_fence(&store);
    }
    result.map(|object| {
        Some(CreatedStore {
            object,
            state: store,
        })
    })
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
    let trusted_home = match decode_open_options(env, &intrinsics, input) {
        Ok(Some(value)) => value,
        Ok(None) => return create_invalid_open(env, NativeStoreErrorCode::InvalidArgument),
        Err(_) => {
            clear_pending_exception(env);
            return create_invalid_open(env, NativeStoreErrorCode::NativeInterfaceInvalid);
        }
    };
    match open_platform_store(lifecycle, &trusted_home) {
        Ok(port) => {
            let created = match create_store_object(env, port, intrinsics)? {
                Some(store) => store,
                None => {
                    return create_invalid_open(env, NativeStoreErrorCode::NativeInterfaceInvalid);
                }
            };
            let state = Arc::clone(&created.state);
            let result = (|| -> Result<Object<'env>> {
                let mut result = Object::new(env)?;
                define_own_data(env, &mut result, "status", "opened")?;
                define_own_data(env, &mut result, "selfCheck", "passed")?;
                define_own_data(env, &mut result, "store", created.object)?;
                Ok(result)
            })();
            if result.is_err() {
                terminal_fence(&state);
            }
            result
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
