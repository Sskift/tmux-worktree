#[cfg(not(target_os = "linux"))]
#[test]
fn non_linux_target_stops_before_platform_open() {
    use relay_v2_broker_credential_state_store_platform_common::initialize_process_lifecycle;
    use relay_v2_broker_credential_state_store_platform_linux::{
        open_linux_state_store, LinuxOpenError,
    };
    use std::path::Path;

    let lifecycle = initialize_process_lifecycle().expect("initialize common process epoch");
    assert!(matches!(
        open_linux_state_store(&lifecycle, Path::new("relative-input-is-never-inspected")),
        Err(LinuxOpenError::TargetUnsupported)
    ));
}
