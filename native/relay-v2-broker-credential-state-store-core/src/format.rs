//! Frozen binary-v1 sparse/range format core.
//!
//! The implementation intentionally has no whole-container buffer type. All
//! selection and publication APIs operate on absolute bounded ranges.

use crate::binary_contract::{
    CONTAINER_FILE_LENGTH, GENERATION_MIN, HEADER0_OFFSET, HEADER1_OFFSET, HEADER_BYTES,
    HEADER_CHECKSUM_COVER_LENGTH, HEADER_CHECKSUM_COVER_OFFSET, HEADER_CHECKSUM_LENGTH,
    HEADER_CHECKSUM_OFFSET, HEADER_DECLARED_LENGTH_LENGTH, HEADER_DECLARED_LENGTH_OFFSET,
    HEADER_FLAGS_LENGTH, HEADER_FLAGS_OFFSET, HEADER_FLAGS_VALUE, HEADER_FORMAT_VERSION_LENGTH,
    HEADER_FORMAT_VERSION_OFFSET, HEADER_GENERATION_LENGTH, HEADER_GENERATION_OFFSET,
    HEADER_LENGTH_VALUE, HEADER_MAGIC, HEADER_MAGIC_LENGTH, HEADER_MAGIC_OFFSET,
    HEADER_PAYLOAD_DIGEST_LENGTH, HEADER_PAYLOAD_DIGEST_OFFSET, HEADER_PAYLOAD_LENGTH_LENGTH,
    HEADER_PAYLOAD_LENGTH_OFFSET, HEADER_RESERVED_LENGTH, HEADER_RESERVED_OFFSET,
    HEADER_SLOT_LENGTH, HEADER_SLOT_OFFSET, MAX_STATE_BYTES, PAYLOAD0_OFFSET, PAYLOAD1_OFFSET,
    PAYLOAD_LENGTH_MAX, PAYLOAD_LENGTH_MIN, STORAGE_FORMAT_VERSION,
};
use crate::{CoreError, OperationError};
use sha2::{Digest, Sha256};

const SHA256_BYTES: usize = 32;
const RANGE_CHUNK_BYTES: usize = 64 * 1024;

/// Reads bounded ranges from one already-open descriptor/image. Offsets are
/// always absolute container offsets; no shared cursor exists in this model.
pub trait AbsoluteRangeReader {
    type Error;

    fn file_length(&self) -> Result<u64, Self::Error>;

    fn read_exact_at(&self, absolute_offset: u64, output: &mut [u8]) -> Result<(), Self::Error>;
}

fn any_non_zero<R: AbsoluteRangeReader + ?Sized>(
    reader: &R,
    absolute_offset: u64,
    length: u64,
) -> Result<bool, R::Error> {
    let mut remaining = length;
    let mut offset = absolute_offset;
    let mut chunk = vec![0_u8; RANGE_CHUNK_BYTES];
    while remaining > 0 {
        let count =
            usize::try_from(remaining.min(RANGE_CHUNK_BYTES as u64)).expect("bounded chunk length");
        reader.read_exact_at(offset, &mut chunk[..count])?;
        if chunk[..count].iter().any(|byte| *byte != 0) {
            return Ok(true);
        }
        offset += count as u64;
        remaining -= count as u64;
    }
    Ok(false)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub(crate) enum Slot {
    Zero = 0,
    One = 1,
}

impl Slot {
    pub(crate) fn for_generation(generation: u64) -> Result<Self, CoreError> {
        if generation < GENERATION_MIN {
            return Err(CoreError::InvalidArgument);
        }
        Ok(if (generation - 1) % 2 == 0 {
            Self::Zero
        } else {
            Self::One
        })
    }

    pub(crate) fn payload_offset(self) -> u64 {
        match self {
            Self::Zero => PAYLOAD0_OFFSET,
            Self::One => PAYLOAD1_OFFSET,
        }
    }

    pub(crate) fn header_offset(self) -> u64 {
        match self {
            Self::Zero => HEADER0_OFFSET,
            Self::One => HEADER1_OFFSET,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct PublicationTarget {
    pub(crate) generation: u64,
    pub(crate) slot: Slot,
    pub(crate) payload_offset: u64,
    pub(crate) header_offset: u64,
}

pub(crate) fn publication_target(generation: u64) -> Result<PublicationTarget, CoreError> {
    let slot = Slot::for_generation(generation)?;
    Ok(PublicationTarget {
        generation,
        slot,
        payload_offset: slot.payload_offset(),
        header_offset: slot.header_offset(),
    })
}

pub(crate) fn encode_header(
    generation: u64,
    payload: &[u8],
) -> Result<[u8; HEADER_BYTES], CoreError> {
    if generation < GENERATION_MIN || payload.is_empty() {
        return Err(CoreError::InvalidArgument);
    }
    if payload.len() > MAX_STATE_BYTES {
        return Err(CoreError::StateTooLarge);
    }
    let target = publication_target(generation)?;
    let mut header = [0_u8; HEADER_BYTES];
    header[HEADER_MAGIC_OFFSET..HEADER_MAGIC_OFFSET + HEADER_MAGIC_LENGTH]
        .copy_from_slice(&HEADER_MAGIC);
    header
        [HEADER_FORMAT_VERSION_OFFSET..HEADER_FORMAT_VERSION_OFFSET + HEADER_FORMAT_VERSION_LENGTH]
        .copy_from_slice(&STORAGE_FORMAT_VERSION.to_le_bytes());
    debug_assert_eq!(HEADER_SLOT_LENGTH, 1);
    header[HEADER_SLOT_OFFSET] = target.slot as u8;
    debug_assert_eq!(HEADER_FLAGS_LENGTH, 1);
    header[HEADER_FLAGS_OFFSET] = HEADER_FLAGS_VALUE;
    header[HEADER_DECLARED_LENGTH_OFFSET
        ..HEADER_DECLARED_LENGTH_OFFSET + HEADER_DECLARED_LENGTH_LENGTH]
        .copy_from_slice(&HEADER_LENGTH_VALUE.to_le_bytes());
    header[HEADER_GENERATION_OFFSET..HEADER_GENERATION_OFFSET + HEADER_GENERATION_LENGTH]
        .copy_from_slice(&generation.to_le_bytes());
    header
        [HEADER_PAYLOAD_LENGTH_OFFSET..HEADER_PAYLOAD_LENGTH_OFFSET + HEADER_PAYLOAD_LENGTH_LENGTH]
        .copy_from_slice(&(payload.len() as u64).to_le_bytes());
    let digest = Sha256::digest(payload);
    header
        [HEADER_PAYLOAD_DIGEST_OFFSET..HEADER_PAYLOAD_DIGEST_OFFSET + HEADER_PAYLOAD_DIGEST_LENGTH]
        .copy_from_slice(&digest);
    let checksum = Sha256::digest(
        &header[HEADER_CHECKSUM_COVER_OFFSET
            ..HEADER_CHECKSUM_COVER_OFFSET + HEADER_CHECKSUM_COVER_LENGTH],
    );
    header[HEADER_CHECKSUM_OFFSET..HEADER_CHECKSUM_OFFSET + HEADER_CHECKSUM_LENGTH]
        .copy_from_slice(&checksum);
    Ok(header)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SelectedState {
    generation: u64,
    slot: Slot,
    bytes: Vec<u8>,
}

impl SelectedState {
    pub(crate) fn into_parts(self) -> (u64, Vec<u8>) {
        (self.generation, self.bytes)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ContainerSelection {
    Missing,
    Present(SelectedState),
}

#[derive(Debug, Clone)]
struct ParsedHeader {
    generation: u64,
    slot: Slot,
    payload_length: usize,
    payload_digest: [u8; SHA256_BYTES],
}

fn parse_header(
    bytes: &[u8; HEADER_BYTES],
    expected_slot: Slot,
) -> Result<Option<ParsedHeader>, CoreError> {
    if bytes.iter().all(|byte| *byte == 0) {
        return Ok(None);
    }
    let checksum = Sha256::digest(
        &bytes[HEADER_CHECKSUM_COVER_OFFSET
            ..HEADER_CHECKSUM_COVER_OFFSET + HEADER_CHECKSUM_COVER_LENGTH],
    );
    if checksum.as_slice()
        != &bytes[HEADER_CHECKSUM_OFFSET..HEADER_CHECKSUM_OFFSET + HEADER_CHECKSUM_LENGTH]
    {
        return Err(CoreError::Corrupt);
    }

    let format_version = u16::from_le_bytes(
        bytes[HEADER_FORMAT_VERSION_OFFSET
            ..HEADER_FORMAT_VERSION_OFFSET + HEADER_FORMAT_VERSION_LENGTH]
            .try_into()
            .expect("frozen u16 field"),
    );
    if bytes[HEADER_MAGIC_OFFSET..HEADER_MAGIC_OFFSET + HEADER_MAGIC_LENGTH] != HEADER_MAGIC
        || format_version != STORAGE_FORMAT_VERSION
        || bytes[HEADER_FLAGS_OFFSET] != HEADER_FLAGS_VALUE
    {
        return Err(CoreError::FormatUnsupported);
    }

    let header_length = u32::from_le_bytes(
        bytes[HEADER_DECLARED_LENGTH_OFFSET
            ..HEADER_DECLARED_LENGTH_OFFSET + HEADER_DECLARED_LENGTH_LENGTH]
            .try_into()
            .expect("frozen u32 field"),
    );
    let generation = u64::from_le_bytes(
        bytes[HEADER_GENERATION_OFFSET..HEADER_GENERATION_OFFSET + HEADER_GENERATION_LENGTH]
            .try_into()
            .expect("frozen u64 field"),
    );
    let payload_length = u64::from_le_bytes(
        bytes[HEADER_PAYLOAD_LENGTH_OFFSET
            ..HEADER_PAYLOAD_LENGTH_OFFSET + HEADER_PAYLOAD_LENGTH_LENGTH]
            .try_into()
            .expect("frozen u64 field"),
    );
    if bytes[HEADER_SLOT_OFFSET] != expected_slot as u8
        || header_length != HEADER_LENGTH_VALUE
        || generation < GENERATION_MIN
        || Slot::for_generation(generation).ok() != Some(expected_slot)
        || !(PAYLOAD_LENGTH_MIN..=PAYLOAD_LENGTH_MAX).contains(&payload_length)
        || bytes[HEADER_RESERVED_OFFSET..HEADER_RESERVED_OFFSET + HEADER_RESERVED_LENGTH]
            .iter()
            .any(|byte| *byte != 0)
    {
        return Err(CoreError::Corrupt);
    }
    let mut payload_digest = [0_u8; SHA256_BYTES];
    payload_digest.copy_from_slice(
        &bytes[HEADER_PAYLOAD_DIGEST_OFFSET
            ..HEADER_PAYLOAD_DIGEST_OFFSET + HEADER_PAYLOAD_DIGEST_LENGTH],
    );
    Ok(Some(ParsedHeader {
        generation,
        slot: expected_slot,
        payload_length: usize::try_from(payload_length).expect("frozen payload limit fits usize"),
        payload_digest,
    }))
}

fn read_header_bytes<R: AbsoluteRangeReader + ?Sized>(
    reader: &R,
    slot: Slot,
) -> Result<[u8; HEADER_BYTES], R::Error> {
    let mut bytes = [0_u8; HEADER_BYTES];
    reader.read_exact_at(slot.header_offset(), &mut bytes)?;
    Ok(bytes)
}

fn read_complete_payload<R: AbsoluteRangeReader + ?Sized>(
    reader: &R,
    header: &ParsedHeader,
) -> Result<Option<Vec<u8>>, R::Error> {
    let mut payload = Vec::with_capacity(header.payload_length);
    let mut hasher = Sha256::new();
    let mut offset = 0_usize;
    let mut chunk = vec![0_u8; RANGE_CHUNK_BYTES.min(header.payload_length)];
    while offset < header.payload_length {
        let count = chunk.len().min(header.payload_length - offset);
        reader.read_exact_at(
            header.slot.payload_offset() + offset as u64,
            &mut chunk[..count],
        )?;
        hasher.update(&chunk[..count]);
        payload.extend_from_slice(&chunk[..count]);
        offset += count;
    }
    Ok((hasher.finalize().as_slice() == header.payload_digest).then_some(payload))
}

pub(crate) fn select_container<R: AbsoluteRangeReader + ?Sized>(
    reader: Option<&R>,
) -> Result<ContainerSelection, OperationError<R::Error>> {
    let Some(reader) = reader else {
        return Ok(ContainerSelection::Missing);
    };
    if reader.file_length().map_err(OperationError::Adapter)? != CONTAINER_FILE_LENGTH {
        return Err(OperationError::Core(CoreError::Corrupt));
    }
    // Read both fixed header ranges before classifying either. Core error
    // precedence must not depend on slot order: a checksum-valid unknown
    // format in either slot dominates corruption in the other.
    let raw_headers = [
        read_header_bytes(reader, Slot::Zero).map_err(OperationError::Adapter)?,
        read_header_bytes(reader, Slot::One).map_err(OperationError::Adapter)?,
    ];
    let parsed = [
        parse_header(&raw_headers[0], Slot::Zero),
        parse_header(&raw_headers[1], Slot::One),
    ];
    if parsed
        .iter()
        .any(|result| matches!(result, Err(CoreError::FormatUnsupported)))
    {
        return Err(OperationError::Core(CoreError::FormatUnsupported));
    }
    if parsed.iter().any(Result::is_err) {
        return Err(OperationError::Core(CoreError::Corrupt));
    }
    let headers = [
        parsed[0].clone().expect("classified header zero"),
        parsed[1].clone().expect("classified header one"),
    ];
    match (&headers[0], &headers[1]) {
        (None, None) => {
            let payload0_non_zero = any_non_zero(reader, PAYLOAD0_OFFSET, MAX_STATE_BYTES as u64)
                .map_err(OperationError::Adapter)?;
            let payload1_non_zero = any_non_zero(reader, PAYLOAD1_OFFSET, MAX_STATE_BYTES as u64)
                .map_err(OperationError::Adapter)?;
            if payload0_non_zero || payload1_non_zero {
                return Err(OperationError::Core(CoreError::Corrupt));
            }
            Ok(ContainerSelection::Missing)
        }
        (Some(header), None) => {
            if header.slot != Slot::Zero || header.generation != GENERATION_MIN {
                return Err(OperationError::Core(CoreError::Corrupt));
            }
            let payload = read_complete_payload(reader, header)
                .map_err(OperationError::Adapter)?
                .ok_or(OperationError::Core(CoreError::Corrupt))?;
            Ok(ContainerSelection::Present(SelectedState {
                generation: header.generation,
                slot: header.slot,
                bytes: payload,
            }))
        }
        (None, Some(_)) => Err(OperationError::Core(CoreError::Corrupt)),
        (Some(left), Some(right)) => {
            let delta = left.generation.abs_diff(right.generation);
            if delta != 1 {
                return Err(OperationError::Core(CoreError::Corrupt));
            }
            let higher = if left.generation > right.generation {
                left
            } else {
                right
            };
            // The lower payload is intentionally not read here. It is allowed
            // to be incomplete only because the structurally valid headers
            // prove that `higher` is its immediate successor; the selected
            // higher payload must still be complete.
            let payload = read_complete_payload(reader, higher)
                .map_err(OperationError::Adapter)?
                .ok_or(OperationError::Core(CoreError::Corrupt))?;
            Ok(ContainerSelection::Present(SelectedState {
                generation: higher.generation,
                slot: higher.slot,
                bytes: payload,
            }))
        }
    }
}
