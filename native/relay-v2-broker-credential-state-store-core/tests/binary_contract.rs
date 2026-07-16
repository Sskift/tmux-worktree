mod support;

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine as _;
use relay_v2_broker_credential_state_store_core::{
    CoreError, OperationError, PublicationAdapter, StateStore,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use support::{
    binary_manifest, checksum_cover, header_field_offset, json_file, named, FixtureError,
    OverlayReader, SparseContainer, SparseFixture,
};

const MAX_SELECTOR_READ: usize = 64 * 1024;

fn cases(document: &Value) -> &[Value] {
    document["cases"].as_array().expect("fixture cases")
}

fn vectors(document: &Value) -> &[Value] {
    document["vectors"].as_array().expect("fixture vectors")
}

fn fixture_name(value: &Value) -> &str {
    value["name"].as_str().expect("fixture name")
}

fn parse_fixture(value: &Value) -> SparseFixture {
    SparseFixture::parse_json(&serde_json::to_string(value).expect("serialize fixture value"))
        .expect("parse sparse fixture container")
}

fn operation_core<T, E: std::fmt::Debug>(
    result: Result<T, OperationError<E>>,
) -> Result<T, CoreError> {
    match result {
        Ok(value) => Ok(value),
        Err(OperationError::Core(error)) => Err(error),
        Err(OperationError::Adapter(error)) => panic!("unexpected range adapter error: {error:?}"),
    }
}

fn open_and_read<I>(adapter: I) -> Result<Option<Vec<u8>>, CoreError>
where
    I: PublicationAdapter,
    I::Error: Clone + std::fmt::Debug,
{
    let store = operation_core(StateStore::from_adapter(adapter))?;
    let ticket = store.admit()?;
    let mut lease = ticket.enter()?;
    let snapshot = operation_core(lease.read())?;
    let bytes = snapshot.bytes().map(<[u8]>::to_vec);
    lease.settle();
    store.close().expect("close fixture adapter");
    Ok(bytes)
}

fn golden_by_name() -> BTreeMap<String, Value> {
    cases(&json_file("golden-binary.json"))
        .iter()
        .map(|case| (fixture_name(case).to_owned(), case.clone()))
        .collect()
}

fn mutated_reader(vector: &Value, golden: &BTreeMap<String, Value>) -> OverlayReader {
    let source_name = vector["deriveFrom"].as_str().expect("deriveFrom");
    let source = golden.get(source_name).expect("known golden source");
    let SparseFixture::Container(base) = parse_fixture(&source["container"]) else {
        panic!("corrupt vector cannot derive from absent container");
    };
    let mut reader = OverlayReader::new(base);
    for mutation in vector["mutations"].as_array().expect("mutations") {
        reader.apply(mutation);
    }
    reader
}

fn region_offset(name: &str) -> u64 {
    named(&binary_manifest()["container"]["regions"], name)["offset"]
        .as_u64()
        .expect("region offset")
}

fn file_length() -> u64 {
    binary_manifest()["container"]["fileLengthBytes"]
        .as_u64()
        .expect("file length")
}

#[test]
fn sparse_fixture_codec_and_store_self_check_consume_every_golden_case() {
    let document = json_file("golden-binary.json");
    assert_eq!(document["fixtureFormatVersion"], 1);
    assert_eq!(
        document["encoding"],
        "zero-filled-exact-file-with-absolute-segments"
    );

    for case in cases(&document) {
        let name = fixture_name(case);
        let fixture = parse_fixture(&case["container"]);
        let reparsed =
            SparseFixture::parse_json(&fixture.encode_json()).expect("fixture round trip");
        assert_eq!(reparsed, fixture, "{name}: sparse codec round trip");
        let selected = match fixture {
            SparseFixture::Absent => open_and_read(SparseContainer::zero(file_length())),
            SparseFixture::Container(container) => open_and_read(container),
        };
        match case["expected"]["outcome"]
            .as_str()
            .expect("expected outcome")
        {
            "missing" => assert_eq!(selected, Ok(None), "{name}"),
            "present" => {
                let bytes = selected.expect(name).expect("present bytes");
                assert_eq!(
                    STANDARD.encode(&bytes),
                    case["expected"]["payloadBase64"]
                        .as_str()
                        .expect("payload Base64"),
                    "{name}"
                );
                assert_eq!(
                    URL_SAFE_NO_PAD.encode(Sha256::digest(&bytes)),
                    case["expected"]["payloadSha256"]
                        .as_str()
                        .expect("payload digest"),
                    "{name}"
                );
            }
            other => panic!("unknown expected golden outcome {other}"),
        }
    }
}

#[test]
fn sparse_fixture_parser_rejects_unordered_overlapping_and_out_of_bounds_segments() {
    let cases = [
        (
            r#"{"fileLength":16,"segments":[{"offset":8,"bytesBase64":"QQ=="},{"offset":0,"bytesBase64":"Qg=="}]}"#,
            FixtureError::SegmentsOutOfOrder,
        ),
        (
            r#"{"fileLength":16,"segments":[{"offset":0,"bytesBase64":"QUE="},{"offset":1,"bytesBase64":"Qg=="}]}"#,
            FixtureError::SegmentOverlap,
        ),
        (
            r#"{"fileLength":1,"segments":[{"offset":1,"bytesBase64":"QQ=="}]}"#,
            FixtureError::SegmentOutOfBounds,
        ),
    ];
    for (json, expected) in cases {
        assert_eq!(SparseFixture::parse_json(json), Err(expected));
    }
}

#[test]
fn every_corrupt_absolute_offset_vector_and_selector_priority_is_closed() {
    let corrupt = json_file("corrupt-binary.json");
    let golden = golden_by_name();
    assert_eq!(corrupt["fixtureFormatVersion"], 1);
    assert_eq!(corrupt["mutationCoordinates"], "absolute-container-offsets");

    let priority_expectations = BTreeMap::from([
        (
            "initial-payload-without-commit-header",
            Err(CoreError::Corrupt),
        ),
        ("unknown-magic", Err(CoreError::FormatUnsupported)),
        ("unknown-format-version", Err(CoreError::FormatUnsupported)),
        ("unknown-header-flags", Err(CoreError::FormatUnsupported)),
        (
            "lower-inactive-payload-is-incomplete",
            Ok("iZ3Lky08FFBOt-5UoevBMhe1jQbcH48VKg8G17djonQ"),
        ),
        (
            "headerless-inactive-payload-is-never-visible",
            Ok("m25BsxUpAZBVK8NTB2MTpmfhi4Ttp7XAfsTXF4Kt_Pw"),
        ),
    ]);
    let mut observed_priority = BTreeSet::new();

    for vector in vectors(&corrupt) {
        let name = fixture_name(vector);
        let reader = mutated_reader(vector, &golden);
        let selected = open_and_read(reader.clone());
        let expected = &vector["expected"];
        match expected["outcome"].as_str().expect("expected outcome") {
            "reject" => {
                let expected_error = match expected["errorCode"].as_str().expect("error code") {
                    "STORE_CORRUPT" => CoreError::Corrupt,
                    "STORE_FORMAT_UNSUPPORTED" => CoreError::FormatUnsupported,
                    other => panic!("unexpected frozen core error {other}"),
                };
                assert_eq!(selected, Err(expected_error), "{name}");
            }
            "present" => {
                let bytes = selected.clone().expect(name).expect("present bytes");
                assert_eq!(
                    URL_SAFE_NO_PAD.encode(Sha256::digest(bytes)),
                    expected["payloadSha256"].as_str().expect("digest"),
                    "{name}"
                );
            }
            other => panic!("unknown corrupt-vector outcome {other}"),
        }

        if let Some(priority) = priority_expectations.get(name) {
            observed_priority.insert(name.to_owned());
            match priority {
                Err(error) => assert_eq!(selected, Err(*error), "{name}: selector priority"),
                Ok(digest) => {
                    let bytes = selected.expect(name).expect("priority present bytes");
                    assert_eq!(
                        URL_SAFE_NO_PAD.encode(Sha256::digest(bytes)),
                        *digest,
                        "{name}"
                    );
                }
            }
        }
        assert!(
            reader.max_requested() <= MAX_SELECTOR_READ,
            "{name}: selector requested a whole-container-sized range"
        );
    }
    assert_eq!(
        observed_priority,
        priority_expectations
            .keys()
            .map(|name| (*name).to_owned())
            .collect(),
        "all explicit priority gates must be exercised by the frozen corpus"
    );
}

#[test]
fn lower_incomplete_payload_is_not_ignored_without_an_immediate_successor() {
    let golden = golden_by_name();
    let source = golden
        .get("generation-two-slot-one")
        .expect("golden source");
    let SparseFixture::Container(base) = parse_fixture(&source["container"]) else {
        panic!("source is present");
    };
    let mut reader = OverlayReader::new(base);
    let payload0_offset = region_offset("payload0");
    let header1_offset = region_offset("header1");
    reader.write(payload0_offset, vec![b'X']);
    reader.write(
        header1_offset + header_field_offset("generation"),
        4_u64.to_le_bytes().to_vec(),
    );
    recompute_checksum(&mut reader, header1_offset);

    assert_eq!(
        open_and_read(reader.clone()),
        Err(CoreError::Corrupt),
        "a lower incomplete payload is ignorable only under a complete immediate successor"
    );
    assert!(reader.max_requested() <= MAX_SELECTOR_READ);
}

#[test]
fn unknown_format_dominates_other_slot_corruption_in_both_slot_orders() {
    let golden = golden_by_name();
    let source = golden
        .get("generation-two-slot-one")
        .expect("dual-header golden source");
    let SparseFixture::Container(base) = parse_fixture(&source["container"]) else {
        panic!("source is present");
    };
    let headers = [region_offset("header0"), region_offset("header1")];
    let unknowns = [
        ("magic", b"X".to_vec()),
        ("formatVersion", 2_u16.to_le_bytes().to_vec()),
        ("flags", vec![1]),
    ];

    for unknown_slot in 0..=1 {
        for (field, value) in &unknowns {
            let mut reader = OverlayReader::new(base.clone());
            let unknown_header = headers[unknown_slot];
            let corrupt_header = headers[1 - unknown_slot];
            reader.write(unknown_header + header_field_offset(field), value.clone());
            recompute_checksum(&mut reader, unknown_header);
            let checksum_byte = corrupt_header + header_field_offset("headerChecksum");
            let mut torn = reader.read_vec(checksum_byte, 1);
            torn[0] ^= 1;
            reader.write(checksum_byte, torn);

            assert_eq!(
                open_and_read(reader),
                Err(CoreError::FormatUnsupported),
                "checksum-valid unknown {field} in slot {unknown_slot} must dominate other-slot corruption"
            );
        }
    }
}

fn recompute_checksum(reader: &mut OverlayReader, header_offset: u64) {
    let (cover_offset, cover_length) = checksum_cover();
    let covered = reader.read_vec(header_offset + cover_offset, cover_length);
    reader.write(
        header_offset + header_field_offset("headerChecksum"),
        Sha256::digest(covered).to_vec(),
    );
}
