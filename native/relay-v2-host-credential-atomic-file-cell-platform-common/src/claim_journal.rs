use crate::{CellErrorCode, ObjectIdentity};
use sha2::{Digest, Sha256};

pub const CLAIM_JOURNAL_FORMAT_VERSION: u32 = 1;
pub const CLAIM_JOURNAL_STATE_ADMISSION_HELD_NO_CREDENTIAL_MUTATION: u32 = 1;
pub const CLAIM_ID_LENGTH: usize = 32;
pub const CLAIM_JOURNAL_LENGTH: usize = 192;
const INTEGRITY_OFFSET: usize = 160;
const MAGIC: &[u8; 8] = b"TWV2HAC1";

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) struct ClaimId([u8; CLAIM_ID_LENGTH]);

impl ClaimId {
    fn from_bytes(bytes: [u8; CLAIM_ID_LENGTH]) -> Option<Self> {
        if bytes.iter().all(|byte| *byte == 0) {
            return None;
        }
        Some(Self(bytes))
    }

    pub(crate) fn as_bytes(&self) -> &[u8; CLAIM_ID_LENGTH] {
        &self.0
    }
}

pub(super) fn issue_claim_id() -> Result<ClaimId, CellErrorCode> {
    let mut bytes = [0_u8; CLAIM_ID_LENGTH];
    getrandom::fill(&mut bytes).map_err(|_| CellErrorCode::CellIo)?;
    ClaimId::from_bytes(bytes).ok_or(CellErrorCode::CellIo)
}

#[cfg(test)]
pub(super) fn issue_claim_id_with_for_test(
    fill: impl FnOnce(&mut [u8; CLAIM_ID_LENGTH]) -> Result<(), ()>,
) -> Result<ClaimId, CellErrorCode> {
    let mut bytes = [0_u8; CLAIM_ID_LENGTH];
    fill(&mut bytes).map_err(|()| CellErrorCode::CellIo)?;
    ClaimId::from_bytes(bytes).ok_or(CellErrorCode::CellIo)
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) struct ClaimJournal {
    pub(crate) claim_id: ClaimId,
    pub(crate) directory: ObjectIdentity,
    pub(crate) lock: ObjectIdentity,
    pub(crate) claim: ObjectIdentity,
    pub(crate) opener_pid: u32,
    pub(crate) effective_uid: u32,
    pub(crate) effective_gid: u32,
}

impl ClaimJournal {
    pub(crate) fn encode(self) -> [u8; CLAIM_JOURNAL_LENGTH] {
        let mut bytes = [0_u8; CLAIM_JOURNAL_LENGTH];
        bytes[0..8].copy_from_slice(MAGIC);
        put_u32(&mut bytes, 8, CLAIM_JOURNAL_FORMAT_VERSION);
        put_u32(&mut bytes, 12, CLAIM_JOURNAL_LENGTH as u32);
        put_u32(
            &mut bytes,
            16,
            CLAIM_JOURNAL_STATE_ADMISSION_HELD_NO_CREDENTIAL_MUTATION,
        );
        bytes[24..56].copy_from_slice(self.claim_id.as_bytes());
        put_identity(&mut bytes, 56, self.directory);
        put_identity(&mut bytes, 72, self.lock);
        put_identity(&mut bytes, 88, self.claim);
        put_u32(&mut bytes, 104, self.opener_pid);
        put_u32(&mut bytes, 108, self.effective_uid);
        put_u32(&mut bytes, 112, self.effective_gid);
        let digest = Sha256::digest(&bytes[..INTEGRITY_OFFSET]);
        bytes[INTEGRITY_OFFSET..].copy_from_slice(&digest);
        bytes
    }

    pub(crate) fn decode(bytes: &[u8]) -> Result<Self, CellErrorCode> {
        if bytes.len() != CLAIM_JOURNAL_LENGTH
            || &bytes[0..8] != MAGIC
            || get_u32(bytes, 8) != CLAIM_JOURNAL_FORMAT_VERSION
            || get_u32(bytes, 12) != CLAIM_JOURNAL_LENGTH as u32
            || get_u32(bytes, 16) != CLAIM_JOURNAL_STATE_ADMISSION_HELD_NO_CREDENTIAL_MUTATION
            || bytes[20..24].iter().any(|byte| *byte != 0)
            || bytes[116..160].iter().any(|byte| *byte != 0)
        {
            return Err(CellErrorCode::CellCorrupt);
        }
        let expected = Sha256::digest(&bytes[..INTEGRITY_OFFSET]);
        if bytes[INTEGRITY_OFFSET..] != expected[..] {
            return Err(CellErrorCode::CellCorrupt);
        }
        let mut claim_id = [0_u8; CLAIM_ID_LENGTH];
        claim_id.copy_from_slice(&bytes[24..56]);
        Ok(Self {
            claim_id: ClaimId::from_bytes(claim_id).ok_or(CellErrorCode::CellCorrupt)?,
            directory: get_identity(bytes, 56),
            lock: get_identity(bytes, 72),
            claim: get_identity(bytes, 88),
            opener_pid: get_u32(bytes, 104),
            effective_uid: get_u32(bytes, 108),
            effective_gid: get_u32(bytes, 112),
        })
    }
}

fn put_u32(bytes: &mut [u8], offset: usize, value: u32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn put_u64(bytes: &mut [u8], offset: usize, value: u64) {
    bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
}

fn get_u32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().expect("u32 field"))
}

fn get_u64(bytes: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(bytes[offset..offset + 8].try_into().expect("u64 field"))
}

fn put_identity(bytes: &mut [u8], offset: usize, identity: ObjectIdentity) {
    put_u64(bytes, offset, identity.device);
    put_u64(bytes, offset + 8, identity.inode);
}

fn get_identity(bytes: &[u8], offset: usize) -> ObjectIdentity {
    ObjectIdentity {
        device: get_u64(bytes, offset),
        inode: get_u64(bytes, offset + 8),
    }
}
