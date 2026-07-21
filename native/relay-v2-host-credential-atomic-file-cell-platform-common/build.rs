use serde_json::Value;
use std::env;
use std::fmt::Write as _;
use std::fs;

fn member<'a>(value: &'a Value, key: &str) -> &'a Value {
    value
        .get(key)
        .unwrap_or_else(|| panic!("host credential cell manifest is missing {key}"))
}

fn unsigned(value: &Value, label: &str) -> u64 {
    value
        .as_u64()
        .unwrap_or_else(|| panic!("host credential cell manifest {label} is not unsigned"))
}

fn string<'a>(value: &'a Value, label: &str) -> &'a str {
    value
        .as_str()
        .unwrap_or_else(|| panic!("host credential cell manifest {label} is not a string"))
}

fn relative_component<'a>(value: &'a Value, label: &str) -> &'a str {
    let component = string(value, label);
    assert!(!component.is_empty(), "{label} must not be empty");
    assert!(
        !component.contains('/') && !component.contains('\\') && !component.contains('\0'),
        "{label} must be one descriptor-relative component"
    );
    assert!(
        !component.to_ascii_lowercase().contains("broker"),
        "{label} must not reuse the broker namespace"
    );
    component
}

fn main() {
    let crate_dir = env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    let contract_dir =
        format!("{crate_dir}/../../contracts/relay/v2/host-credential-atomic-file-cell-v1");
    let manifest_path = format!("{contract_dir}/manifest.json");
    let journal_path = format!("{contract_dir}/claim-journal-v1.json");
    println!("cargo:rerun-if-changed={manifest_path}");
    println!("cargo:rerun-if-changed={journal_path}");

    let manifest: Value = serde_json::from_slice(
        &fs::read(&manifest_path).expect("read host credential cell manifest"),
    )
    .expect("parse host credential cell manifest");
    assert_eq!(
        member(&manifest, "contract"),
        "tmux-worktree-relay-v2-host-credential-atomic-file-cell"
    );
    assert_eq!(
        unsigned(member(&manifest, "contractVersion"), "contractVersion"),
        2
    );
    assert_eq!(member(&manifest, "status"), "frozen");
    assert_eq!(
        unsigned(
            member(member(&manifest, "nativeInterface"), "abiVersion"),
            "nativeInterface.abiVersion"
        ),
        1
    );

    let platform = member(&manifest, "platformResources");
    assert_eq!(
        unsigned(
            member(platform, "contractVersion"),
            "platformResources.contractVersion"
        ),
        1
    );
    assert_eq!(
        member(platform, "fileOperations"),
        "injected-descriptor-relative-trait-only"
    );
    let names = member(platform, "relativeNames");
    assert_eq!(member(names, "singleComponentsOnly"), true);
    assert_eq!(member(names, "callerOverrideAllowed"), false);
    let credential = relative_component(member(names, "credential"), "relativeNames.credential");
    let lock = relative_component(member(names, "lock"), "relativeNames.lock");
    let claim = relative_component(member(names, "claim"), "relativeNames.claim");
    assert_ne!(credential, lock);
    assert_ne!(credential, claim);
    assert_ne!(lock, claim);

    let durability = member(platform, "durabilityQualification");
    assert_eq!(
        unsigned(
            member(durability, "policyVersion"),
            "durability policyVersion"
        ),
        1
    );
    assert_eq!(member(durability, "productionProofConstructible"), false);
    assert_eq!(
        member(durability, "runtimeProbeCreatesQualification"),
        false
    );
    assert!(
        member(durability, "qualifiedRecords")
            .as_array()
            .expect("qualifiedRecords array")
            .is_empty(),
        "contract revision 2 must remain deny-by-default"
    );

    let claim_manifest = member(platform, "claimJournal");
    assert_eq!(
        unsigned(
            member(claim_manifest, "formatVersion"),
            "claim formatVersion"
        ),
        1
    );
    assert_eq!(member(claim_manifest, "magicAscii"), "TWV2HAC1");
    assert_eq!(
        member(claim_manifest, "state"),
        "ADMISSION_HELD_NO_CREDENTIAL_MUTATION"
    );
    assert_eq!(
        unsigned(member(claim_manifest, "claimIdBytes"), "claimIdBytes"),
        32
    );
    let journal_length = unsigned(member(claim_manifest, "byteLength"), "claim byteLength");
    assert_eq!(journal_length, 192);
    usize::try_from(journal_length).expect("journal length fits usize");

    let journal: Value =
        serde_json::from_slice(&fs::read(&journal_path).expect("read claim journal fixture"))
            .expect("parse claim journal fixture");
    assert_eq!(
        unsigned(
            member(&journal, "fixtureFormatVersion"),
            "journal fixture version"
        ),
        1
    );
    assert_eq!(
        unsigned(
            member(&journal, "journalFormatVersion"),
            "journal format version"
        ),
        1
    );
    assert_eq!(
        unsigned(member(&journal, "byteLength"), "journal byteLength"),
        journal_length
    );
    assert_eq!(
        unsigned(
            member(&journal, "integrityCoveredBytes"),
            "integrityCoveredBytes"
        ),
        160
    );

    let mut generated = String::new();
    writeln!(generated, "pub(super) const CONTRACT_REVISION: u32 = 2;").unwrap();
    writeln!(
        generated,
        "pub(super) const RESOURCE_CONTRACT_VERSION: u32 = 1;"
    )
    .unwrap();
    writeln!(
        generated,
        "pub(super) const CREDENTIAL_NAME: &str = {credential:?};"
    )
    .unwrap();
    writeln!(generated, "pub(super) const LOCK_NAME: &str = {lock:?};").unwrap();
    writeln!(generated, "pub(super) const CLAIM_NAME: &str = {claim:?};").unwrap();
    writeln!(
        generated,
        "pub(super) const CLAIM_JOURNAL_LENGTH: usize = {journal_length};"
    )
    .unwrap();

    let output = format!("{}/contract_spec.rs", env::var("OUT_DIR").expect("OUT_DIR"));
    fs::write(output, generated).expect("write generated Host contract spec");
}
