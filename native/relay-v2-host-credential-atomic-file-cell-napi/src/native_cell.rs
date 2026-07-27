//! Synchronous N-API handle for the sole platform-common `AdmissionOwner`.
//!
//! This module only translates the frozen raw ABI. Descriptor, registry,
//! credential revision, mutation, uncertainty, and close authority remain in
//! the exact `AdmissionOwner` adopted by the trusted factory.

use napi::bindgen_prelude::{FromNapiValue, FunctionCallContext, Object, Uint8Array, Unknown};
use napi::{sys, Env, JsValue, Result as NapiResult, ValueType};
use relay_v2_host_credential_atomic_file_cell_platform_common::{
    AdmissionOwner, CellErrorCode, CredentialCompareAndSwapOutcome, CredentialCurrent,
    CredentialRevision,
};
use std::ffi::c_void;
use std::ptr;
use std::sync::{Arc, Mutex, OnceLock, Weak};

use crate::factory::cell_platform;
use crate::{
    clear_pending_exception, data_descriptor_value, define_own_data, exact_string_keys, Intrinsics,
    RawValue,
};

type Platform = cell_platform::Platform;

#[repr(C)]
struct NapiTypeTag {
    lower: u64,
    upper: u64,
}

static NATIVE_REVISION_TYPE_TAG: NapiTypeTag = NapiTypeTag {
    lower: 0x7e9a_9c14_b426_4fa1,
    upper: 0xb8d5_313f_6d73_94c2,
};

#[cfg(unix)]
extern "C" {
    fn napi_type_tag_object(
        env: sys::napi_env,
        value: sys::napi_value,
        type_tag: *const NapiTypeTag,
    ) -> sys::napi_status;
    fn napi_check_object_type_tag(
        env: sys::napi_env,
        value: sys::napi_value,
        type_tag: *const NapiTypeTag,
        result: *mut bool,
    ) -> sys::napi_status;
}

struct NativeRevision {
    owner: Weak<()>,
    revision: Mutex<Option<CredentialRevision>>,
}

unsafe extern "C" fn finalize_native_revision(
    _env: sys::napi_env,
    finalize_data: *mut c_void,
    _finalize_hint: *mut c_void,
) {
    if !finalize_data.is_null() {
        unsafe {
            drop(Box::from_raw(finalize_data.cast::<NativeRevision>()));
        }
    }
}

fn create_native_revision<'env>(
    env: &'env Env,
    owner_brand: &Arc<()>,
    revision: CredentialRevision,
) -> NapiResult<Object<'env>> {
    let object = Object::new(env)?;
    let tagged = unsafe {
        napi_type_tag_object(env.raw(), object.raw(), &NATIVE_REVISION_TYPE_TAG)
            == sys::Status::napi_ok
    };
    if !tagged {
        return Err(crate::napi_failure(
            "native revision object initialization failed",
        ));
    }
    let native_revision = Box::into_raw(Box::new(NativeRevision {
        owner: Arc::downgrade(owner_brand),
        revision: Mutex::new(Some(revision)),
    }));
    let wrapped = unsafe {
        sys::napi_wrap(
            env.raw(),
            object.raw(),
            native_revision.cast(),
            Some(finalize_native_revision),
            ptr::null_mut(),
            ptr::null_mut(),
        ) == sys::Status::napi_ok
    };
    if !wrapped {
        unsafe {
            drop(Box::from_raw(native_revision));
        }
        return Err(crate::napi_failure(
            "native revision object initialization failed",
        ));
    }
    Ok(object)
}

struct NativeCellState {
    owner_brand: Arc<()>,
    owner: AdmissionOwner<Platform>,
}

/// Construction-time owner for the adopted common owner. N-API callbacks
/// capture only the initially empty slot, so a partial handle/result
/// publication synchronously drops (and therefore closes) the common owner.
struct HandlePublicationOwner {
    pending: Option<Mutex<NativeCellState>>,
    slot: Arc<OnceLock<Mutex<NativeCellState>>>,
}

impl HandlePublicationOwner {
    fn new(owner: AdmissionOwner<Platform>) -> Self {
        Self {
            pending: Some(Mutex::new(NativeCellState {
                owner_brand: Arc::new(()),
                owner,
            })),
            slot: Arc::new(OnceLock::new()),
        }
    }

    fn callback_slot(&self) -> Arc<OnceLock<Mutex<NativeCellState>>> {
        Arc::clone(&self.slot)
    }

    fn publish(mut self) -> NapiResult<()> {
        let state = self
            .pending
            .take()
            .ok_or_else(|| crate::napi_failure("native cell handle publication failed"))?;
        self.slot
            .set(state)
            .map_err(|_| crate::napi_failure("native cell handle publication failed"))
    }
}

enum Decode<T> {
    Valid(T),
    InvalidArgument,
    NativeInterfaceInvalid,
}

fn snapshot_request<'env>(
    env: &'env Env,
    intrinsics: &Intrinsics,
    input: Unknown<'env>,
    expected_keys: &[&str],
) -> NapiResult<Decode<Object<'env>>> {
    if input.get_type()? != ValueType::Object {
        return Ok(Decode::InvalidArgument);
    }
    let (descriptors, keys) = match intrinsics.snapshot_descriptors(env, input) {
        Ok(snapshot) => snapshot,
        Err(_) => {
            clear_pending_exception(env);
            return Ok(Decode::NativeInterfaceInvalid);
        }
    };
    if !exact_string_keys(&keys, expected_keys)? {
        return Ok(Decode::InvalidArgument);
    }
    let Some(abi_version) = data_descriptor_value(&descriptors, "abiVersion")? else {
        return Ok(Decode::InvalidArgument);
    };
    if abi_version.get_type()? != ValueType::Number || f64::from_unknown(abi_version)? != 1.0 {
        return Ok(Decode::InvalidArgument);
    }
    Ok(Decode::Valid(descriptors))
}

fn decode_simple_request(
    env: &Env,
    intrinsics: &Intrinsics,
    input: Unknown<'_>,
    expected_operation: &str,
) -> NapiResult<Decode<()>> {
    let descriptors = match snapshot_request(env, intrinsics, input, &["abiVersion", "operation"])?
    {
        Decode::Valid(descriptors) => descriptors,
        Decode::InvalidArgument => return Ok(Decode::InvalidArgument),
        Decode::NativeInterfaceInvalid => return Ok(Decode::NativeInterfaceInvalid),
    };
    let Some(operation) = data_descriptor_value(&descriptors, "operation")? else {
        return Ok(Decode::InvalidArgument);
    };
    if operation.get_type()? != ValueType::String
        || String::from_unknown(operation)? != expected_operation
    {
        return Ok(Decode::InvalidArgument);
    }
    Ok(Decode::Valid(()))
}

struct CompareRequest {
    revision: RawValue,
    bytes: Vec<u8>,
    too_large: bool,
}

fn decode_compare_request(
    env: &Env,
    intrinsics: &Intrinsics,
    input: Unknown<'_>,
) -> NapiResult<Decode<CompareRequest>> {
    let descriptors = match snapshot_request(
        env,
        intrinsics,
        input,
        &["abiVersion", "operation", "revision", "bytes"],
    )? {
        Decode::Valid(descriptors) => descriptors,
        Decode::InvalidArgument => return Ok(Decode::InvalidArgument),
        Decode::NativeInterfaceInvalid => return Ok(Decode::NativeInterfaceInvalid),
    };
    let Some(operation) = data_descriptor_value(&descriptors, "operation")? else {
        return Ok(Decode::InvalidArgument);
    };
    if operation.get_type()? != ValueType::String
        || String::from_unknown(operation)? != "compare_and_swap"
    {
        return Ok(Decode::InvalidArgument);
    }
    let Some(revision) = data_descriptor_value(&descriptors, "revision")? else {
        return Ok(Decode::InvalidArgument);
    };
    let Some(bytes) = data_descriptor_value(&descriptors, "bytes")? else {
        return Ok(Decode::InvalidArgument);
    };
    let bytes = match unsafe { Uint8Array::from_napi_value(env.raw(), bytes.raw()) } {
        Ok(bytes) => bytes,
        Err(_) => {
            clear_pending_exception(env);
            return Ok(Decode::InvalidArgument);
        }
    };
    if bytes.len()
        > relay_v2_host_credential_atomic_file_cell_platform_common::CREDENTIAL_MAXIMUM_BYTES
    {
        return Ok(Decode::Valid(CompareRequest {
            revision: RawValue(revision.raw()),
            bytes: Vec::new(),
            too_large: true,
        }));
    }
    Ok(Decode::Valid(CompareRequest {
        revision: RawValue(revision.raw()),
        bytes: bytes.to_vec(),
        too_large: false,
    }))
}

fn error_object<'env>(env: &'env Env, code: CellErrorCode) -> NapiResult<Object<'env>> {
    let mut error = Object::new(env)?;
    define_own_data(env, &mut error, "code", code.as_contract_code())?;
    Ok(error)
}

fn operation_result<'env>(
    env: &'env Env,
    operation: &str,
    outcome: &str,
) -> NapiResult<Object<'env>> {
    let mut result = Object::new(env)?;
    define_own_data(env, &mut result, "abiVersion", 1_u32)?;
    define_own_data(env, &mut result, "operation", operation)?;
    define_own_data(env, &mut result, "outcome", outcome)?;
    Ok(result)
}

fn operation_error_result<'env>(
    env: &'env Env,
    operation: &str,
    code: CellErrorCode,
) -> NapiResult<Object<'env>> {
    let mut result = operation_result(env, operation, "error")?;
    define_own_data(env, &mut result, "error", error_object(env, code)?)?;
    Ok(result)
}

fn decoded_error<'env, T>(
    env: &'env Env,
    operation: &str,
    decoded: Decode<T>,
) -> Option<NapiResult<Object<'env>>> {
    match decoded {
        Decode::Valid(_) => None,
        Decode::InvalidArgument => Some(operation_error_result(
            env,
            operation,
            CellErrorCode::InvalidArgument,
        )),
        Decode::NativeInterfaceInvalid => Some(operation_error_result(
            env,
            operation,
            CellErrorCode::NativeInterfaceInvalid,
        )),
    }
}

fn encode_current<'env>(
    env: &'env Env,
    owner_brand: &Arc<()>,
    current: CredentialCurrent,
) -> NapiResult<Object<'env>> {
    let (state, revision, bytes) = match current {
        CredentialCurrent::Absent { revision } => ("empty", revision, None),
        CredentialCurrent::Present { revision, bytes } => ("present", revision, Some(bytes)),
    };
    let native_revision = create_native_revision(env, owner_brand, revision)?;
    let mut result = Object::new(env)?;
    define_own_data(env, &mut result, "state", state)?;
    define_own_data(
        env,
        &mut result,
        "revision",
        RawValue(native_revision.raw()),
    )?;
    if let Some(bytes) = bytes {
        define_own_data(env, &mut result, "bytes", Uint8Array::from(bytes))?;
    }
    Ok(result)
}

fn with_state<'env>(
    env: &'env Env,
    operation: &str,
    slot: &OnceLock<Mutex<NativeCellState>>,
    action: impl FnOnce(&mut NativeCellState) -> NapiResult<Object<'env>>,
) -> NapiResult<Object<'env>> {
    let Some(state) = slot.get() else {
        return operation_error_result(env, operation, CellErrorCode::CellClosed);
    };
    let mut state = match state.lock() {
        Ok(state) => state,
        Err(_) => {
            return operation_error_result(env, operation, CellErrorCode::NativeInterfaceInvalid)
        }
    };
    action(&mut state)
}

fn read_cell<'env>(
    env: &'env Env,
    intrinsics: &Intrinsics,
    slot: &OnceLock<Mutex<NativeCellState>>,
    input: Unknown<'env>,
) -> NapiResult<Object<'env>> {
    let decoded = decode_simple_request(env, intrinsics, input, "read")?;
    if let Some(error) = decoded_error(env, "read", decoded) {
        return error;
    }
    with_state(env, "read", slot, |state| match state.owner.read() {
        Ok(current) => {
            let current = encode_current(env, &state.owner_brand, current)?;
            let mut result = operation_result(env, "read", "ok")?;
            define_own_data(env, &mut result, "current", current)?;
            Ok(result)
        }
        Err(code) => operation_error_result(env, "read", code),
    })
}

fn checked_revision_pointer_with(
    value: RawValue,
    check_type_tag: impl FnOnce(RawValue) -> Result<bool, CellErrorCode>,
    unwrap: impl FnOnce(RawValue) -> Result<*mut c_void, CellErrorCode>,
) -> Result<*mut NativeRevision, CellErrorCode> {
    if !check_type_tag(value)? {
        return Err(CellErrorCode::InvalidRevision);
    }
    let native_revision = unwrap(value)?;
    if native_revision.is_null() {
        return Err(CellErrorCode::InvalidRevision);
    }
    Ok(native_revision.cast())
}

fn take_revision(
    env: &Env,
    owner_brand: &Arc<()>,
    value: RawValue,
) -> Result<CredentialRevision, CellErrorCode> {
    let native_revision = checked_revision_pointer_with(
        value,
        |value| {
            let mut matches = false;
            let status = unsafe {
                napi_check_object_type_tag(
                    env.raw(),
                    value.0,
                    &NATIVE_REVISION_TYPE_TAG,
                    &mut matches,
                )
            };
            if status == sys::Status::napi_ok {
                Ok(matches)
            } else {
                Err(CellErrorCode::InvalidRevision)
            }
        },
        |value| {
            let mut native_revision = ptr::null_mut();
            let status = unsafe { sys::napi_unwrap(env.raw(), value.0, &mut native_revision) };
            if status == sys::Status::napi_ok {
                Ok(native_revision)
            } else {
                Err(CellErrorCode::InvalidRevision)
            }
        },
    )?;
    let revision = unsafe { &*native_revision };
    let Some(token_owner) = revision.owner.upgrade() else {
        return Err(CellErrorCode::InvalidRevision);
    };
    if !Arc::ptr_eq(owner_brand, &token_owner) {
        return Err(CellErrorCode::InvalidRevision);
    }
    revision
        .revision
        .lock()
        .map_err(|_| CellErrorCode::InvalidRevision)?
        .take()
        .ok_or(CellErrorCode::InvalidRevision)
}

fn compare_and_swap_cell<'env>(
    env: &'env Env,
    intrinsics: &Intrinsics,
    slot: &OnceLock<Mutex<NativeCellState>>,
    input: Unknown<'env>,
) -> NapiResult<Object<'env>> {
    let request = match decode_compare_request(env, intrinsics, input)? {
        Decode::Valid(request) => request,
        Decode::InvalidArgument => {
            return operation_error_result(env, "compare_and_swap", CellErrorCode::InvalidArgument)
        }
        Decode::NativeInterfaceInvalid => {
            return operation_error_result(
                env,
                "compare_and_swap",
                CellErrorCode::NativeInterfaceInvalid,
            )
        }
    };
    if request.too_large {
        return operation_error_result(env, "compare_and_swap", CellErrorCode::ValueTooLarge);
    }
    with_state(env, "compare_and_swap", slot, |state| {
        let revision = match take_revision(env, &state.owner_brand, request.revision) {
            Ok(revision) => revision,
            Err(code) => return operation_error_result(env, "compare_and_swap", code),
        };
        match state.owner.compare_and_swap(revision, &request.bytes) {
            Ok(CredentialCompareAndSwapOutcome::Swapped) => {
                operation_result(env, "compare_and_swap", "swapped")
            }
            Ok(CredentialCompareAndSwapOutcome::Conflict(current)) => {
                let current = encode_current(env, &state.owner_brand, current)?;
                let mut result = operation_result(env, "compare_and_swap", "conflict")?;
                define_own_data(env, &mut result, "current", current)?;
                Ok(result)
            }
            Ok(CredentialCompareAndSwapOutcome::Uncertain) => {
                operation_result(env, "compare_and_swap", "uncertain")
            }
            Err(code) => operation_error_result(env, "compare_and_swap", code),
        }
    })
}

fn close_cell<'env>(
    env: &'env Env,
    intrinsics: &Intrinsics,
    slot: &OnceLock<Mutex<NativeCellState>>,
    input: Unknown<'env>,
) -> NapiResult<Object<'env>> {
    let decoded = decode_simple_request(env, intrinsics, input, "close")?;
    if let Some(error) = decoded_error(env, "close", decoded) {
        return error;
    }
    with_state(env, "close", slot, |state| match state.owner.close() {
        Ok(()) => operation_result(env, "close", "closed"),
        Err(code) => operation_error_result(env, "close", code),
    })
}

pub(crate) fn create_opened_result<'env>(
    env: &'env Env,
    intrinsics: &Arc<Intrinsics>,
    owner: AdmissionOwner<Platform>,
) -> NapiResult<Object<'env>> {
    let publication = HandlePublicationOwner::new(owner);
    let read_slot = publication.callback_slot();
    let read_intrinsics = Arc::clone(intrinsics);
    let read = env.create_function_from_closure::<(Unknown,), RawValue, _>(
        "read",
        move |context: FunctionCallContext<'_>| {
            let input = match context.get::<Unknown<'_>>(0) {
                Ok(input) => input,
                Err(_) => {
                    return operation_error_result(
                        context.env,
                        "read",
                        CellErrorCode::InvalidArgument,
                    )
                    .map(|value| RawValue(value.raw()))
                }
            };
            read_cell(context.env, &read_intrinsics, &read_slot, input)
                .map(|value| RawValue(value.raw()))
        },
    )?;

    let compare_slot = publication.callback_slot();
    let compare_intrinsics = Arc::clone(intrinsics);
    let compare = env.create_function_from_closure::<(Unknown,), RawValue, _>(
        "compareAndSwap",
        move |context: FunctionCallContext<'_>| {
            let input = match context.get::<Unknown<'_>>(0) {
                Ok(input) => input,
                Err(_) => {
                    return operation_error_result(
                        context.env,
                        "compare_and_swap",
                        CellErrorCode::InvalidArgument,
                    )
                    .map(|value| RawValue(value.raw()))
                }
            };
            compare_and_swap_cell(context.env, &compare_intrinsics, &compare_slot, input)
                .map(|value| RawValue(value.raw()))
        },
    )?;

    let close_slot = publication.callback_slot();
    let close_intrinsics = Arc::clone(intrinsics);
    let close = env.create_function_from_closure::<(Unknown,), RawValue, _>(
        "close",
        move |context: FunctionCallContext<'_>| {
            let input = match context.get::<Unknown<'_>>(0) {
                Ok(input) => input,
                Err(_) => {
                    return operation_error_result(
                        context.env,
                        "close",
                        CellErrorCode::InvalidArgument,
                    )
                    .map(|value| RawValue(value.raw()))
                }
            };
            close_cell(context.env, &close_intrinsics, &close_slot, input)
                .map(|value| RawValue(value.raw()))
        },
    )?;

    let mut handle = Object::new(env)?;
    define_own_data(env, &mut handle, "read", read)?;
    define_own_data(env, &mut handle, "compareAndSwap", compare)?;
    define_own_data(env, &mut handle, "close", close)?;
    let mut result = operation_result(env, "open", "opened")?;
    define_own_data(env, &mut result, "handle", handle)?;
    publication.publish()?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn arbitrary_value() -> RawValue {
        RawValue(ptr::null_mut())
    }

    #[test]
    fn foreign_external_ordinary_object_and_proxy_never_reach_unwrap() {
        for _case in ["foreign napi_external", "ordinary object", "Proxy"] {
            let unwrapped = Cell::new(false);
            let result = checked_revision_pointer_with(
                arbitrary_value(),
                |_| Ok(false),
                |_| {
                    unwrapped.set(true);
                    Ok(ptr::null_mut())
                },
            );

            assert_eq!(result.unwrap_err(), CellErrorCode::InvalidRevision);
            assert!(!unwrapped.get());
        }
    }

    #[test]
    fn type_tag_failure_never_reaches_unwrap() {
        let unwrapped = Cell::new(false);
        let result = checked_revision_pointer_with(
            arbitrary_value(),
            |_| Err(CellErrorCode::InvalidRevision),
            |_| {
                unwrapped.set(true);
                Ok(ptr::null_mut())
            },
        );

        assert_eq!(result.unwrap_err(), CellErrorCode::InvalidRevision);
        assert!(!unwrapped.get());
    }

    #[test]
    fn matched_type_tag_requires_non_null_unwrap() {
        let null_result =
            checked_revision_pointer_with(arbitrary_value(), |_| Ok(true), |_| Ok(ptr::null_mut()));
        assert_eq!(null_result.unwrap_err(), CellErrorCode::InvalidRevision);

        let pointer = ptr::NonNull::<NativeRevision>::dangling().as_ptr();
        let matched_result =
            checked_revision_pointer_with(arbitrary_value(), |_| Ok(true), |_| Ok(pointer.cast()));
        assert_eq!(matched_result.unwrap(), pointer);
    }
}
