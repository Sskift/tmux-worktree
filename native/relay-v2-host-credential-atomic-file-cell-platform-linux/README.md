# Relay v2 Host credential atomic file cell: Linux platform adapter

This default-off crate implements the Linux descriptor-relative syscall seams
required by the Host-only
`relay-v2-host-credential-atomic-file-cell-platform-common` admission and
credential-mutation owner. It accepts ownership of one already-bound directory
descriptor through an explicit unsafe constructor and implements the common
crate's stateless `DescriptorRelativePlatform` and
`CredentialMutationPlatform` operations.

The adapter uses contract-derived relative names from
`platform_resource_spec()`. It does not accept or discover HOME, cwd,
environment, or a filesystem path, and it does not duplicate or reopen an
adopted descriptor. Locking is a nonblocking traditional whole-file
`F_SETLK` write lock. Descriptor release is one raw `close` attempt with no
explicit unlock and no retry after `EINTR`. Credential mutation uses only the
contract-derived fixed credential name and validates common-generated dynamic
temporary names before exact `*at` operations; same-directory `renameat` is the
only publication syscall exposed by this adapter.

Platform-common remains the sole owner of admission, revision/CAS state,
CSPRNG and temporary-name generation, retry/gating/cleanup, commit and
uncertainty decisions, fencing, and recovery policy. This crate does not
construct `DurabilityQualification`, open the complete admission owner,
implement orphan recovery, or connect N-API, a loader, Vault, Authority,
`relay-host`, production composition, readiness, or capability advertisement.
It has no dependency on the broker credential native crates and provides no
fallback.

The shared contract still records empty durability qualification and incomplete
production/qualification gates. This local adapter seam therefore remains
default-off and does not establish a production capability. The current native
validation scope is Linux x86_64 only; it does not establish Linux arm64,
Darwin x86_64, full admission, filesystem/power-loss durability qualification,
or production wiring.
