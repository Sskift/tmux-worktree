use serde_json::{json, Value};
use std::env;
use std::fmt::Write as _;
use std::fs;

fn member<'a>(value: &'a Value, key: &str) -> &'a Value {
    value
        .get(key)
        .unwrap_or_else(|| panic!("frozen state-store manifest is missing {key}"))
}

fn unsigned(value: &Value, label: &str) -> u64 {
    value
        .as_u64()
        .unwrap_or_else(|| panic!("frozen state-store manifest {label} is not an unsigned integer"))
}

fn main() {
    let crate_dir = env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    let manifest_path = format!(
        "{crate_dir}/../../contracts/relay/v2/broker-credential-state-store-v1/manifest.json"
    );
    println!("cargo:rerun-if-changed={manifest_path}");

    let manifest: Value = serde_json::from_slice(
        &fs::read(&manifest_path).expect("read frozen broker credential state-store manifest"),
    )
    .expect("parse frozen broker credential state-store manifest");
    assert_eq!(
        member(&manifest, "contract"),
        "tmux-worktree-relay-v2-broker-credential-state-store"
    );
    assert_eq!(
        unsigned(member(&manifest, "contractVersion"), "contractVersion"),
        2
    );
    assert_eq!(member(&manifest, "status"), "frozen");

    let binary = member(&manifest, "binaryStorage");
    assert_eq!(
        unsigned(
            member(binary, "formatVersion"),
            "binaryStorage.formatVersion"
        ),
        1
    );
    let container = member(binary, "container");
    let private_location = member(container, "privateLocation");
    assert_eq!(
        private_location,
        &json!({
            "derivationVersion": 1,
            "base": "trustedHome",
            "relativeComponents": [
                ".tmux-worktree",
                "relay-v2-broker-credential-state-store-v1.bin"
            ],
            "platformInvariant": true,
            "callerOverrideAllowed": false,
            "alternateCandidateLookupAllowed": false
        }),
        "privateLocation must remain the exact frozen N0.1 definition"
    );

    let file_length = unsigned(member(container, "fileLengthBytes"), "fileLengthBytes");
    assert_eq!(file_length, 134_217_984);
    let max_state_bytes = unsigned(member(binary, "maxPayloadBytes"), "maxPayloadBytes");
    assert_eq!(max_state_bytes, 67_108_864);
    let open_arguments = member(member(&manifest, "nativeInterface"), "openArguments")
        .as_array()
        .expect("nativeInterface.openArguments must be an array");
    assert_eq!(open_arguments.len(), 1);
    let frozen_max = member(&open_arguments[0], "maxStateBytes");
    assert_eq!(member(frozen_max, "mustEqualFrozenValue"), true);
    assert_eq!(member(frozen_max, "callerConfigurable"), false);
    assert_eq!(
        max_state_bytes,
        unsigned(
            member(frozen_max, "value"),
            "native open maxStateBytes.value"
        ),
        "binary max payload and native open admission maximum must remain identical"
    );
    usize::try_from(max_state_bytes).expect("frozen maxStateBytes must fit usize");

    let components = member(private_location, "relativeComponents")
        .as_array()
        .expect("privateLocation.relativeComponents must be an array");
    let mut generated = String::new();
    writeln!(
        generated,
        "pub(super) static CONTAINER_SPEC: ContainerSpec = ContainerSpec {{"
    )
    .unwrap();
    writeln!(generated, "    relative_components: &[").unwrap();
    for component in components {
        writeln!(
            generated,
            "        {:?},",
            component
                .as_str()
                .expect("privateLocation relative component must be a string")
        )
        .unwrap();
    }
    writeln!(generated, "    ],").unwrap();
    writeln!(generated, "    file_length: {file_length},").unwrap();
    writeln!(generated, "    max_state_bytes: {max_state_bytes},").unwrap();
    writeln!(generated, "}};").unwrap();

    let output = format!(
        "{}/container_spec.rs",
        env::var("OUT_DIR").expect("OUT_DIR")
    );
    fs::write(output, generated).expect("write generated container spec");
}
