//! Raw N-API binding foundation for the Relay v2 Host credential atomic file
//! cell. The module eagerly captures the platform-common process lifecycle
//! exactly once at init and exposes only the frozen synchronous `open` method.
//! This revision has no open seam: after closed request validation, compile
//! target admission, and lifecycle capture, the production durability
//! qualification gate is deny-by-default, so every open fails closed before any
//! registry reservation, descriptor, filesystem, path, HOME, environment, or
//! credential mutation. It is not wired to any production composition.

use napi::bindgen_prelude::{
    Array, FromNapiValue, Function, FunctionCallContext, FunctionRef, JsObjectValue, Object,
    ToNapiValue, TypeName, Unknown,
};
use napi::{sys, Env, Error, JsValue, Property, Result, Status, ValueType};
use napi_derive::napi;
use relay_v2_host_credential_atomic_file_cell_platform_common::{
    initialize_process_lifecycle, production_durability_qualification, CellErrorCode,
    ProcessLifecycleToken,
};
use std::ptr;
use std::sync::{Arc, OnceLock};

static PROCESS_LIFECYCLE: OnceLock<std::result::Result<ProcessLifecycleToken, CellErrorCode>> =
    OnceLock::new();

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

struct Intrinsics {
    own_keys: RawFunctionRef,
    get_own_property_descriptors: RawFunctionRef,
}

impl Intrinsics {
    fn capture(env: &Env) -> Result<Self> {
        let global = env.get_global()?;
        let reflect: Object<'_> = global.get_named_property("Reflect")?;
        let object: Function<'_, (), RawValue> = global.get_named_property("Object")?;
        let own_keys: Function<'_, RawValue, RawValue> = reflect
            .get("ownKeys")?
            .ok_or_else(|| napi_failure("Reflect.ownKeys is unavailable"))?;
        let get_descriptors: Function<'_, RawValue, RawValue> =
            object.get_named_property("getOwnPropertyDescriptors")?;
        Ok(Self {
            own_keys: own_keys.create_ref()?,
            get_own_property_descriptors: get_descriptors.create_ref()?,
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
}

fn supported_target() -> bool {
    cfg!(all(
        any(target_os = "macos", target_os = "linux"),
        any(target_arch = "aarch64", target_arch = "x86_64")
    ))
}

fn lifecycle() -> &'static std::result::Result<ProcessLifecycleToken, CellErrorCode> {
    PROCESS_LIFECYCLE.get_or_init(initialize_process_lifecycle)
}

fn napi_failure(message: &'static str) -> Error {
    Error::new(Status::GenericFailure, message)
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

fn clear_pending_exception(env: &Env) {
    let mut pending = false;
    let status = unsafe { sys::napi_is_exception_pending(env.raw(), &mut pending) };
    if status == sys::Status::napi_ok && pending {
        let mut ignored = ptr::null_mut();
        let _ = unsafe { sys::napi_get_and_clear_last_exception(env.raw(), &mut ignored) };
    }
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OpenRequestDecode {
    Valid,
    InvalidArgument,
    NativeInterfaceInvalid,
}

fn decode_open_request(
    env: &Env,
    intrinsics: &Intrinsics,
    input: Unknown<'_>,
) -> Result<OpenRequestDecode> {
    if input.get_type()? != ValueType::Object {
        return Ok(OpenRequestDecode::InvalidArgument);
    }
    let (descriptors, keys) = match intrinsics.snapshot_descriptors(env, input) {
        Ok(snapshot) => snapshot,
        Err(_) => {
            clear_pending_exception(env);
            return Ok(OpenRequestDecode::NativeInterfaceInvalid);
        }
    };
    if !exact_string_keys(&keys, &["abiVersion", "operation"])? {
        return Ok(OpenRequestDecode::InvalidArgument);
    }
    let Some(abi_version) = data_descriptor_value(&descriptors, "abiVersion")? else {
        return Ok(OpenRequestDecode::InvalidArgument);
    };
    if abi_version.get_type()? != ValueType::Number {
        return Ok(OpenRequestDecode::InvalidArgument);
    }
    if f64::from_unknown(abi_version)? != 1.0 {
        return Ok(OpenRequestDecode::InvalidArgument);
    }
    let Some(operation) = data_descriptor_value(&descriptors, "operation")? else {
        return Ok(OpenRequestDecode::InvalidArgument);
    };
    if operation.get_type()? != ValueType::String {
        return Ok(OpenRequestDecode::InvalidArgument);
    }
    if String::from_unknown(operation)? != "open" {
        return Ok(OpenRequestDecode::InvalidArgument);
    }
    Ok(OpenRequestDecode::Valid)
}

/// Closed gate order: compile target first, then the eagerly captured
/// lifecycle, then the deny-by-default production durability qualification. A
/// future qualified record would still fail closed here because this revision
/// has no open seam to receive one.
fn open_gate_code(
    target_supported: bool,
    lifecycle: &std::result::Result<ProcessLifecycleToken, CellErrorCode>,
) -> CellErrorCode {
    if !target_supported {
        return CellErrorCode::NativeInterfaceInvalid;
    }
    if let Err(code) = lifecycle {
        return *code;
    }
    match production_durability_qualification() {
        Ok(_) => CellErrorCode::NativeInterfaceInvalid,
        Err(code) => code,
    }
}

fn create_error_object<'env>(env: &'env Env, code: CellErrorCode) -> Result<Object<'env>> {
    let mut error = Object::new(env)?;
    define_own_data(env, &mut error, "code", code.as_contract_code())?;
    Ok(error)
}

fn create_open_error_result<'env>(env: &'env Env, code: CellErrorCode) -> Result<Object<'env>> {
    let mut result = Object::new(env)?;
    define_own_data(env, &mut result, "abiVersion", 1_u32)?;
    define_own_data(env, &mut result, "operation", "open")?;
    define_own_data(env, &mut result, "outcome", "error")?;
    define_own_data(env, &mut result, "error", create_error_object(env, code)?)?;
    Ok(result)
}

fn open_cell<'env>(
    env: &'env Env,
    intrinsics: &Intrinsics,
    input: Unknown<'env>,
) -> Result<Object<'env>> {
    let decode = match decode_open_request(env, intrinsics, input) {
        Ok(decode) => decode,
        Err(_) => {
            clear_pending_exception(env);
            return create_open_error_result(env, CellErrorCode::NativeInterfaceInvalid);
        }
    };
    match decode {
        OpenRequestDecode::Valid => {}
        OpenRequestDecode::InvalidArgument => {
            return create_open_error_result(env, CellErrorCode::InvalidArgument);
        }
        OpenRequestDecode::NativeInterfaceInvalid => {
            return create_open_error_result(env, CellErrorCode::NativeInterfaceInvalid);
        }
    }
    create_open_error_result(env, open_gate_code(supported_target(), lifecycle()))
}

#[napi(module_exports)]
fn initialize(mut exports: Object<'_>, env: Env) -> Result<()> {
    // Eager, exactly once, immutable after failure or fork.
    let _ = lifecycle();
    let intrinsics = Arc::new(Intrinsics::capture(&env)?);

    let open = env.create_function_from_closure::<(Unknown<'_>,), RawValue, _>(
        "openRelayV2HostCredentialAtomicFileCellV1",
        move |context: FunctionCallContext<'_>| {
            let input = match context.get::<Unknown<'_>>(0) {
                Ok(value) => value,
                Err(_) => {
                    return create_open_error_result(context.env, CellErrorCode::InvalidArgument)
                        .map(|value| RawValue(value.raw()));
                }
            };
            open_cell(context.env, &intrinsics, input).map(|value| RawValue(value.raw()))
        },
    )?;
    define_own_data(
        &env,
        &mut exports,
        "openRelayV2HostCredentialAtomicFileCellV1",
        open,
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsupported_compile_target_is_closed_invalid_before_any_lifecycle_code() {
        let failed: std::result::Result<ProcessLifecycleToken, CellErrorCode> =
            Err(CellErrorCode::CellClosed);
        assert_eq!(
            open_gate_code(false, &failed),
            CellErrorCode::NativeInterfaceInvalid
        );
    }

    #[test]
    fn lifecycle_capture_failure_maps_to_its_closed_code() {
        let failed: std::result::Result<ProcessLifecycleToken, CellErrorCode> =
            Err(CellErrorCode::CellClosed);
        assert_eq!(open_gate_code(true, &failed), CellErrorCode::CellClosed);
    }

    #[test]
    fn empty_qualification_allowlist_keeps_every_production_open_closed() {
        // The qualification gate itself cannot construct a proof in this
        // revision, so a supported target with a captured lifecycle still
        // resolves to the frozen closed code before registry or mutation.
        assert_eq!(
            production_durability_qualification().unwrap_err(),
            CellErrorCode::CellDurabilityUnsupported
        );
    }
}
