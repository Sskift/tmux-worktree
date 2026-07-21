# Relay v2 Host credential atomic file cell: Darwin platform adapter

This default-off crate implements the macOS descriptor-relative syscall seam
required by the Host-only
`relay-v2-host-credential-atomic-file-cell-platform-common` admission owner.
It accepts ownership of one already-bound directory descriptor through an
explicit unsafe constructor and implements the common crate's
`DescriptorRelativePlatform` and additive `CredentialMutationPlatform`
operations. The mutation adapter is stateless: platform-common remains the
only owner of admission, revisions, CSPRNG/temp-name generation, CAS gates,
cleanup, uncertainty, fencing, and recovery policy.

The adapter uses contract-derived relative names from
`platform_resource_spec()`. It does not accept or discover HOME, cwd,
environment, or a filesystem path, and it does not duplicate or reopen an
adopted descriptor. Locking is a nonblocking traditional whole-file
`F_SETLK` write lock. Descriptor release is one raw `close` attempt with no
explicit unlock and no retry after `EINTR`. Credential/temp lookup, open,
positional I/O, fsync, unlink, and the single same-directory `renameat` commit
primitive remain descriptor-relative; the adapter only validates dynamic temp
names against the contract-derived prefix and lowercase-hex length supplied by
platform-common.

This local adapter seam does not change the frozen shared contract's
`implementedInDarwinAdapter=false`, empty qualification records, or
`fullAdmissionValidated=false`. It does not construct
`DurabilityQualification`, open the complete admission owner, implement orphan
recovery, or connect N-API, a loader, Vault, Authority, `relay-host`, production
composition, readiness, or capability advertisement. It remains default-off,
has no dependency on the broker credential native crates, and provides no
fallback.

The current native validation scope is Darwin arm64 only. It does not establish
Darwin x86_64 support or filesystem/power-loss durability qualification.
