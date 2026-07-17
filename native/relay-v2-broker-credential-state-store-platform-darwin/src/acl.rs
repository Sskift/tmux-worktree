use crate::sys::{AclEntry, AclPrincipal, FileMetadata};
use relay_v2_broker_credential_state_store_platform_common::PlatformStoreFailure;
use std::collections::BTreeMap;

const ACL_READ_DATA: u64 = 1 << 1;
const ACL_WRITE_DATA: u64 = 1 << 2;
const ACL_EXECUTE: u64 = 1 << 3;
const ACL_APPEND_DATA: u64 = 1 << 5;

const ACL_ENTRY_FILE_INHERIT: u32 = 1 << 5;
const ACL_ENTRY_DIRECTORY_INHERIT: u32 = 1 << 6;
const ACL_ENTRY_LIMIT_INHERIT: u32 = 1 << 7;
const ACL_ENTRY_ONLY_INHERIT: u32 = 1 << 8;
const INHERITANCE_FLAGS: u32 = ACL_ENTRY_FILE_INHERIT
    | ACL_ENTRY_DIRECTORY_INHERIT
    | ACL_ENTRY_LIMIT_INHERIT
    | ACL_ENTRY_ONLY_INHERIT;

const BASIC_PERMISSIONS: u64 = ACL_READ_DATA | ACL_WRITE_DATA | ACL_APPEND_DATA | ACL_EXECUTE;

#[derive(Default)]
struct EffectivePermissions {
    denied: u64,
    allowed: u64,
    inheritable_allowed: u64,
}

/// Conservatively proves that Darwin extended ACLs do not expand a non-owner
/// beyond the object's mode bits. Unknown principals and cross-principal deny
/// interactions are rejected rather than guessed.
pub(crate) fn validate_acl(
    metadata: &FileMetadata,
    entries: &[AclEntry],
) -> Result<(), PlatformStoreFailure> {
    let mut effective = BTreeMap::<AclPrincipal, EffectivePermissions>::new();
    for entry in entries {
        if entry.principal == AclPrincipal::Unknown
            && entry.allow
            && (entry.permissions != 0 || entry.flags & INHERITANCE_FLAGS != 0)
        {
            // Unknown identities are not a shared principal. Reject before
            // aggregation so one unresolved identity's DENY cannot mask a
            // different unresolved identity's ALLOW.
            return Err(PlatformStoreFailure::PermissionInvalid);
        }
        let state = effective.entry(entry.principal).or_default();
        if entry.allow {
            let newly_allowed = entry.permissions & !state.denied;
            state.allowed |= newly_allowed;
            if entry.flags & INHERITANCE_FLAGS != 0 {
                // Any non-owner inheritable ALLOW is forbidden even when an
                // earlier DENY masks its permissions on the current object.
                state.inheritable_allowed |= entry.permissions;
            }
        } else {
            state.denied |= entry.permissions;
        }
    }

    for (principal, permissions) in effective {
        if principal == AclPrincipal::User(metadata.uid) {
            continue;
        }
        if principal == AclPrincipal::Unknown
            && (permissions.allowed != 0 || permissions.inheritable_allowed != 0)
        {
            return Err(PlatformStoreFailure::PermissionInvalid);
        }

        let class_bits = match principal {
            AclPrincipal::Group(gid) if gid == metadata.gid => (metadata.mode >> 3) & 0o7,
            _ => metadata.mode & 0o7,
        };
        let mut permitted = 0_u64;
        if class_bits & 0o4 != 0 {
            permitted |= ACL_READ_DATA;
        }
        if class_bits & 0o2 != 0 {
            permitted |= ACL_WRITE_DATA | ACL_APPEND_DATA;
        }
        if class_bits & 0o1 != 0 {
            permitted |= ACL_EXECUTE;
        }

        if permissions.allowed & !BASIC_PERMISSIONS != 0
            || permissions.allowed & BASIC_PERMISSIONS & !permitted != 0
            || permissions.inheritable_allowed != 0
        {
            return Err(PlatformStoreFailure::PermissionInvalid);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn metadata(mode: u32) -> FileMetadata {
        FileMetadata {
            device: 1,
            inode: 2,
            mode,
            uid: 501,
            gid: 20,
            nlink: 1,
            size: 0,
        }
    }

    #[test]
    fn non_owner_acl_expansion_and_inheritance_fail_closed() {
        let group_write = AclEntry {
            allow: true,
            principal: AclPrincipal::Group(20),
            permissions: ACL_WRITE_DATA,
            flags: 0,
        };
        assert_eq!(
            validate_acl(&metadata(u32::from(libc::S_IFDIR) | 0o755), &[group_write]),
            Err(PlatformStoreFailure::PermissionInvalid)
        );

        let inherited_other_read = AclEntry {
            allow: true,
            principal: AclPrincipal::User(777),
            permissions: ACL_READ_DATA,
            flags: ACL_ENTRY_FILE_INHERIT,
        };
        let deny_other_read = AclEntry {
            allow: false,
            principal: AclPrincipal::User(777),
            permissions: ACL_READ_DATA,
            flags: 0,
        };
        assert_eq!(
            validate_acl(
                &metadata(u32::from(libc::S_IFDIR) | 0o755),
                &[deny_other_read, inherited_other_read]
            ),
            Err(PlatformStoreFailure::PermissionInvalid)
        );
    }

    #[test]
    fn unknown_allow_cannot_be_masked_by_another_unknown_deny() {
        let unknown_deny = AclEntry {
            allow: false,
            principal: AclPrincipal::Unknown,
            permissions: ACL_WRITE_DATA,
            flags: 0,
        };
        let different_unknown_allow = AclEntry {
            allow: true,
            principal: AclPrincipal::Unknown,
            permissions: ACL_WRITE_DATA,
            flags: 0,
        };
        assert_eq!(
            validate_acl(
                &metadata(u32::from(libc::S_IFDIR) | 0o777),
                &[unknown_deny, different_unknown_allow]
            ),
            Err(PlatformStoreFailure::PermissionInvalid)
        );

        let empty_inheritable_unknown_allow = AclEntry {
            allow: true,
            principal: AclPrincipal::Unknown,
            permissions: 0,
            flags: ACL_ENTRY_FILE_INHERIT,
        };
        assert_eq!(
            validate_acl(
                &metadata(u32::from(libc::S_IFDIR) | 0o777),
                &[empty_inheritable_unknown_allow]
            ),
            Err(PlatformStoreFailure::PermissionInvalid)
        );
    }
}
