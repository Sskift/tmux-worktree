use serde_json::Value;
use std::env;
use std::fmt::Write as _;
use std::fs;
use std::path::PathBuf;

fn member<'a>(value: &'a Value, key: &str) -> &'a Value {
    value
        .get(key)
        .unwrap_or_else(|| panic!("frozen binary manifest is missing {key}"))
}

fn unsigned(value: &Value, label: &str) -> u64 {
    value
        .as_u64()
        .unwrap_or_else(|| panic!("frozen binary manifest {label} is not an unsigned integer"))
}

fn decimal(value: &Value, label: &str) -> u64 {
    value
        .as_str()
        .unwrap_or_else(|| panic!("frozen binary manifest {label} is not a decimal string"))
        .parse()
        .unwrap_or_else(|_| panic!("frozen binary manifest {label} is outside u64"))
}

fn text<'a>(value: &'a Value, label: &str) -> &'a str {
    value
        .as_str()
        .unwrap_or_else(|| panic!("frozen binary manifest {label} is not a string"))
}

fn named<'a>(items: &'a Value, name: &str) -> &'a Value {
    items
        .as_array()
        .unwrap_or_else(|| panic!("frozen binary manifest list for {name} is not an array"))
        .iter()
        .find(|item| member(item, "name").as_str() == Some(name))
        .unwrap_or_else(|| panic!("frozen binary manifest is missing named entry {name}"))
}

fn string_list<'a>(value: &'a Value, label: &str) -> Vec<&'a str> {
    value
        .as_array()
        .unwrap_or_else(|| panic!("frozen binary manifest {label} is not an array"))
        .iter()
        .map(|entry| text(entry, label))
        .collect()
}

fn main() {
    let crate_dir = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("manifest dir"));
    let manifest_path =
        crate_dir.join("../../contracts/relay/v2/broker-credential-state-store-v1/manifest.json");
    println!("cargo:rerun-if-changed={}", manifest_path.display());

    let manifest: Value = serde_json::from_slice(
        &fs::read(&manifest_path).expect("read frozen broker credential binary manifest"),
    )
    .expect("parse frozen broker credential binary manifest");
    assert_eq!(
        member(&manifest, "contract"),
        "tmux-worktree-relay-v2-broker-credential-state-store"
    );
    assert_eq!(
        unsigned(member(&manifest, "contractVersion"), "contractVersion"),
        1
    );
    assert_eq!(member(&manifest, "status"), "frozen");

    // N1 consumes only the frozen binary/publication section. Native interface,
    // N-API, loader capability, secure-open, and platform error unions are not
    // inputs to this crate and deliberately never enter its generated API.
    let binary = member(&manifest, "binaryStorage");
    let container = member(binary, "container");
    let regions = member(container, "regions");
    let layout = member(binary, "headerLayout");

    let header0 = named(regions, "header0");
    let header1 = named(regions, "header1");
    let payload0 = named(regions, "payload0");
    let payload1 = named(regions, "payload1");
    let magic = named(layout, "magic");
    let format_version = named(layout, "formatVersion");
    let slot = named(layout, "slot");
    let flags = named(layout, "flags");
    let header_length = named(layout, "headerLength");
    let generation = named(layout, "generation");
    let payload_length = named(layout, "payloadLength");
    let payload_digest = named(layout, "payloadDigest");
    let reserved = named(layout, "reserved");
    let header_checksum = named(layout, "headerChecksum");
    let checksum_cover = member(header_checksum, "covers");
    assert_eq!(
        unsigned(
            member(binary, "formatVersion"),
            "binaryStorage.formatVersion"
        ),
        1
    );
    assert_eq!(
        unsigned(member(format_version, "value"), "formatVersion.value"),
        1
    );
    assert_eq!(
        string_list(member(binary, "publication"), "publication"),
        [
            "hold-the-exclusive-transaction-and-single-open-descriptor",
            "select-the-inactive-fixed-payload-range-and-next-generation",
            "positionally-write-the-complete-copied-payload-to-its-absolute-offset-without-a-shared-cursor",
            "pass-the-payload-durability-barrier-before-any-header-write",
            "positionally-write-the-complete-matching-header-to-its-absolute-offset-without-a-shared-cursor",
            "pass-the-header-durability-barrier",
            "prove-any-required-container-metadata-durable",
            "return-swapped-with-a-fresh-current-snapshot-only-after-all-durability-steps-are-proven",
        ]
    );

    let alignment = unsigned(
        member(container, "layoutAlignmentBytes"),
        "layoutAlignmentBytes",
    );
    assert_eq!(
        unsigned(member(container, "fileLengthBytes"), "fileLengthBytes") % alignment,
        0
    );
    for region in [header0, header1, payload0, payload1] {
        assert_eq!(
            unsigned(member(region, "offset"), "region.offset") % alignment,
            0
        );
        assert_eq!(
            unsigned(member(region, "capacity"), "region.capacity") % alignment,
            0
        );
    }

    let mut generated = String::new();
    writeln!(
        generated,
        "pub(crate) const STORAGE_FORMAT_VERSION: u16 = {};",
        unsigned(member(format_version, "value"), "formatVersion.value")
    )
    .unwrap();
    writeln!(
        generated,
        "pub(crate) const CONTAINER_FILE_LENGTH: u64 = {};",
        unsigned(member(container, "fileLengthBytes"), "fileLengthBytes")
    )
    .unwrap();
    writeln!(
        generated,
        "pub(crate) const HEADER_BYTES: usize = {};",
        unsigned(member(binary, "headerBytes"), "headerBytes")
    )
    .unwrap();
    writeln!(
        generated,
        "pub(crate) const MAX_STATE_BYTES: usize = {};",
        unsigned(member(binary, "maxPayloadBytes"), "maxPayloadBytes")
    )
    .unwrap();
    for (constant, region) in [
        ("HEADER0", header0),
        ("HEADER1", header1),
        ("PAYLOAD0", payload0),
        ("PAYLOAD1", payload1),
    ] {
        writeln!(
            generated,
            "pub(crate) const {constant}_OFFSET: u64 = {};",
            unsigned(member(region, "offset"), &format!("{constant}.offset"))
        )
        .unwrap();
    }
    writeln!(
        generated,
        "pub(crate) const HEADER_MAGIC: [u8; {}] = *b{:?};",
        unsigned(member(magic, "length"), "magic.length"),
        text(member(magic, "valueAscii"), "magic.valueAscii")
    )
    .unwrap();
    for (constant, field) in [
        ("MAGIC", magic),
        ("FORMAT_VERSION", format_version),
        ("SLOT", slot),
        ("FLAGS", flags),
        ("DECLARED_LENGTH", header_length),
        ("GENERATION", generation),
        ("PAYLOAD_LENGTH", payload_length),
        ("PAYLOAD_DIGEST", payload_digest),
        ("RESERVED", reserved),
        ("CHECKSUM", header_checksum),
    ] {
        writeln!(
            generated,
            "pub(crate) const HEADER_{constant}_OFFSET: usize = {};",
            unsigned(member(field, "offset"), &format!("{constant}.offset"))
        )
        .unwrap();
        writeln!(
            generated,
            "pub(crate) const HEADER_{constant}_LENGTH: usize = {};",
            unsigned(member(field, "length"), &format!("{constant}.length"))
        )
        .unwrap();
    }
    writeln!(
        generated,
        "pub(crate) const HEADER_FLAGS_VALUE: u8 = {};",
        unsigned(member(flags, "value"), "flags.value")
    )
    .unwrap();
    writeln!(
        generated,
        "pub(crate) const HEADER_LENGTH_VALUE: u32 = {};",
        unsigned(member(header_length, "value"), "headerLength.value")
    )
    .unwrap();
    writeln!(
        generated,
        "pub(crate) const GENERATION_MIN: u64 = {};",
        decimal(member(generation, "minimum"), "generation.minimum")
    )
    .unwrap();
    writeln!(
        generated,
        "pub(crate) const GENERATION_MAX: u64 = {};",
        decimal(member(generation, "maximum"), "generation.maximum")
    )
    .unwrap();
    writeln!(
        generated,
        "pub(crate) const PAYLOAD_LENGTH_MIN: u64 = {};",
        decimal(member(payload_length, "minimum"), "payloadLength.minimum")
    )
    .unwrap();
    writeln!(
        generated,
        "pub(crate) const PAYLOAD_LENGTH_MAX: u64 = {};",
        decimal(member(payload_length, "maximum"), "payloadLength.maximum")
    )
    .unwrap();
    writeln!(
        generated,
        "pub(crate) const HEADER_CHECKSUM_COVER_OFFSET: usize = {};",
        unsigned(
            member(checksum_cover, "offset"),
            "headerChecksum.covers.offset"
        )
    )
    .unwrap();
    writeln!(
        generated,
        "pub(crate) const HEADER_CHECKSUM_COVER_LENGTH: usize = {};",
        unsigned(
            member(checksum_cover, "length"),
            "headerChecksum.covers.length"
        )
    )
    .unwrap();

    let output = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR")).join("binary_contract.rs");
    fs::write(&output, generated).expect("write generated frozen binary constants");
}
