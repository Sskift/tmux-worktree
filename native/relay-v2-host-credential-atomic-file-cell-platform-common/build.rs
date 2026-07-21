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
    let mutation_path = format!("{contract_dir}/credential-mutation-cases-v1.json");
    println!("cargo:rerun-if-changed={manifest_path}");
    println!("cargo:rerun-if-changed={journal_path}");
    println!("cargo:rerun-if-changed={mutation_path}");

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
        4
    );
    assert_eq!(member(&manifest, "status"), "frozen");
    assert_eq!(
        unsigned(
            member(&manifest, "fixtureFormatVersion"),
            "fixtureFormatVersion"
        ),
        1
    );
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
        "contract revision 4 must remain deny-by-default"
    );

    let mutation_manifest = member(&manifest, "credentialMutation");
    assert_eq!(
        unsigned(
            member(mutation_manifest, "contractVersion"),
            "credentialMutation.contractVersion"
        ),
        1
    );
    assert_eq!(
        unsigned(
            member(mutation_manifest, "fixtureFormatVersion"),
            "credentialMutation.fixtureFormatVersion"
        ),
        1
    );
    assert_eq!(
        member(mutation_manifest, "fixture"),
        "credential-mutation-cases-v1.json"
    );
    assert_eq!(member(mutation_manifest, "status"), "platform-common-only");
    assert_eq!(
        member(mutation_manifest, "implementation"),
        "platform-common-only"
    );
    assert_eq!(
        unsigned(
            member(mutation_manifest, "platformResourceContractVersion"),
            "credentialMutation.platformResourceContractVersion"
        ),
        1
    );
    assert_eq!(
        unsigned(
            member(mutation_manifest, "claimJournalFormatVersion"),
            "credentialMutation.claimJournalFormatVersion"
        ),
        1
    );
    assert_eq!(
        member(mutation_manifest, "claimJournalRole"),
        "admission-proof-only-not-mutation-journal"
    );
    assert_eq!(
        member(mutation_manifest, "implementedInPlatformCommon"),
        true
    );
    assert_eq!(
        member(mutation_manifest, "implementedInDarwinAdapter"),
        false
    );
    assert_eq!(
        member(mutation_manifest, "implementedInLinuxAdapter"),
        false
    );
    assert_eq!(member(mutation_manifest, "fullAdmissionValidated"), false);
    assert_eq!(member(mutation_manifest, "durabilityQualified"), false);
    assert_eq!(member(mutation_manifest, "productionWired"), false);
    assert_eq!(
        member(mutation_manifest, "productionCapabilityEffect"),
        "none"
    );
    let mutation_maximum_bytes = unsigned(
        member(mutation_manifest, "maximumCredentialBytes"),
        "credentialMutation.maximumCredentialBytes",
    );
    let mutation_temporary = member(mutation_manifest, "temporary");
    let mutation_temporary_name = member(mutation_temporary, "name");
    let mutation_temporary_prefix = relative_component(
        member(mutation_temporary_name, "prefix"),
        "credentialMutation.temporary.name.prefix",
    );
    let mutation_temporary_entropy_bytes = unsigned(
        member(mutation_temporary_name, "entropyBytes"),
        "credentialMutation.temporary.name.entropyBytes",
    );
    let mutation_temporary_suffix_encoding = string(
        member(mutation_temporary_name, "suffixEncoding"),
        "credentialMutation.temporary.name.suffixEncoding",
    );
    let mutation_temporary_suffix_characters = unsigned(
        member(mutation_temporary_name, "suffixCharacters"),
        "credentialMutation.temporary.name.suffixCharacters",
    );
    let mutation_temporary_attempts = unsigned(
        member(member(mutation_temporary, "create"), "maximumAttempts"),
        "credentialMutation.temporary.create.maximumAttempts",
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

    let mutation_fixture: Value = serde_json::from_slice(
        &fs::read(&mutation_path).expect("read credential mutation fixture"),
    )
    .expect("parse credential mutation fixture");
    assert_eq!(
        unsigned(
            member(&mutation_fixture, "fixtureFormatVersion"),
            "credential mutation fixture version"
        ),
        1
    );
    assert_eq!(
        unsigned(
            member(&mutation_fixture, "credentialMutationContractVersion"),
            "credential mutation contract version"
        ),
        1
    );
    assert_eq!(
        unsigned(
            member(&mutation_fixture, "platformResourceContractVersion"),
            "credential mutation platform resource version"
        ),
        1
    );
    assert_eq!(
        unsigned(
            member(&mutation_fixture, "claimJournalFormatVersion"),
            "credential mutation claim journal version"
        ),
        1
    );
    assert_eq!(
        member(&mutation_fixture, "implementationStatus"),
        "platform-common-only"
    );
    let mutation_constants = member(&mutation_fixture, "constants");
    assert_eq!(
        unsigned(
            member(mutation_constants, "credentialMaximumBytes"),
            "credential mutation credentialMaximumBytes",
        ),
        mutation_maximum_bytes
    );
    assert_eq!(
        relative_component(
            member(mutation_constants, "temporaryPrefix"),
            "credential mutation temporaryPrefix",
        ),
        mutation_temporary_prefix
    );
    assert_eq!(
        unsigned(
            member(mutation_constants, "temporaryEntropyBytes"),
            "credential mutation temporaryEntropyBytes",
        ),
        mutation_temporary_entropy_bytes
    );
    assert_eq!(
        string(
            member(mutation_constants, "temporarySuffixEncoding"),
            "credential mutation temporarySuffixEncoding",
        ),
        mutation_temporary_suffix_encoding
    );
    assert_eq!(
        unsigned(
            member(mutation_constants, "temporarySuffixCharacters"),
            "credential mutation temporarySuffixCharacters",
        ),
        mutation_temporary_suffix_characters
    );
    assert_eq!(
        unsigned(
            member(mutation_constants, "temporaryCreateAttempts"),
            "credential mutation temporaryCreateAttempts",
        ),
        mutation_temporary_attempts
    );
    assert!(
        mutation_maximum_bytes > 0,
        "credential mutation maximum bytes must be nonzero"
    );
    assert!(
        mutation_temporary_entropy_bytes > 0,
        "credential mutation temporary entropy must be nonzero"
    );
    assert!(
        mutation_temporary_attempts > 0,
        "credential mutation temporary attempts must be nonzero"
    );
    assert_eq!(
        mutation_temporary_suffix_encoding, "lowercase-hex",
        "credential mutation temporary suffix encoding must remain lowercase hex"
    );
    assert_eq!(
        mutation_temporary_suffix_characters,
        mutation_temporary_entropy_bytes
            .checked_mul(2)
            .expect("credential mutation lowercase hex length overflow"),
        "credential mutation lowercase hex must encode two characters per entropy byte"
    );
    let mutation_maximum_bytes = usize::try_from(mutation_maximum_bytes)
        .expect("credential mutation maximum bytes fit usize");
    let mutation_temporary_entropy_bytes = usize::try_from(mutation_temporary_entropy_bytes)
        .expect("credential mutation temporary entropy bytes fit usize");
    let mutation_temporary_suffix_characters =
        usize::try_from(mutation_temporary_suffix_characters)
            .expect("credential mutation temporary suffix characters fit usize");
    let mutation_temporary_attempts = usize::try_from(mutation_temporary_attempts)
        .expect("credential mutation temporary attempts fit usize");
    let mutation_qualification = member(&mutation_fixture, "qualification");
    assert!(
        member(mutation_qualification, "qualifiedRecords")
            .as_array()
            .expect("credential mutation qualifiedRecords array")
            .is_empty(),
        "contract revision 4 credential mutation must remain deny-by-default"
    );
    assert_eq!(
        member(mutation_qualification, "productionProofConstructible"),
        false
    );
    assert_eq!(
        member(mutation_qualification, "fullAdmissionValidated"),
        false
    );
    assert_eq!(member(mutation_qualification, "durabilityQualified"), false);
    assert_eq!(member(mutation_qualification, "productionWired"), false);
    assert_eq!(
        member(mutation_qualification, "productionCapabilityEffect"),
        "none"
    );

    let mut generated = String::new();
    writeln!(generated, "pub(super) const CONTRACT_REVISION: u32 = 4;").unwrap();
    writeln!(
        generated,
        "pub(super) const RESOURCE_CONTRACT_VERSION: u32 = 1;"
    )
    .unwrap();
    writeln!(
        generated,
        "#[cfg(test)]\npub(super) const CREDENTIAL_MUTATION_CONTRACT_VERSION: u32 = 1;"
    )
    .unwrap();
    writeln!(
        generated,
        "#[cfg(test)]\npub(super) const CREDENTIAL_MUTATION_IMPLEMENTED: bool = true;"
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
    writeln!(
        generated,
        "pub const CREDENTIAL_MAXIMUM_BYTES: usize = {mutation_maximum_bytes};"
    )
    .unwrap();
    writeln!(
        generated,
        "pub const TEMPORARY_PREFIX: &str = {mutation_temporary_prefix:?};"
    )
    .unwrap();
    writeln!(
        generated,
        "pub const TEMPORARY_ENTROPY_BYTES: usize = {mutation_temporary_entropy_bytes};"
    )
    .unwrap();
    writeln!(
        generated,
        "pub(crate) const TEMPORARY_SUFFIX_CHARACTERS: usize = {mutation_temporary_suffix_characters};"
    )
    .unwrap();
    writeln!(
        generated,
        "pub(crate) const TEMPORARY_LOWERCASE_HEX_ALPHABET: &[u8; 16] = b\"0123456789abcdef\";"
    )
    .unwrap();
    writeln!(
        generated,
        "pub const TEMPORARY_CREATE_ATTEMPTS: usize = {mutation_temporary_attempts};"
    )
    .unwrap();

    let output = format!("{}/contract_spec.rs", env::var("OUT_DIR").expect("OUT_DIR"));
    fs::write(output, generated).expect("write generated Host contract spec");
}
