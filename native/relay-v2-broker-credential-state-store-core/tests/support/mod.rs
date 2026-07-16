#![allow(dead_code)]

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use relay_v2_broker_credential_state_store_core::{
    AbsoluteRangeReader, PublicationAction, PublicationAdapter,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

pub fn contract_file(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../contracts/relay/v2/broker-credential-state-store-v1")
        .join(name)
}

pub fn json_file(name: &str) -> Value {
    serde_json::from_slice(&fs::read(contract_file(name)).expect("read frozen fixture"))
        .expect("parse frozen fixture")
}

pub fn binary_manifest() -> Value {
    json_file("manifest.json")["binaryStorage"].clone()
}

pub fn named<'a>(items: &'a Value, name: &str) -> &'a Value {
    items
        .as_array()
        .expect("manifest named list")
        .iter()
        .find(|item| item["name"].as_str() == Some(name))
        .expect("manifest named entry")
}

pub fn header_field_offset(name: &str) -> u64 {
    named(&binary_manifest()["headerLayout"], name)["offset"]
        .as_u64()
        .expect("header field offset")
}

pub fn checksum_cover() -> (u64, usize) {
    let binary = binary_manifest();
    let covers = &named(&binary["headerLayout"], "headerChecksum")["covers"];
    (
        covers["offset"].as_u64().expect("checksum cover offset"),
        usize::try_from(covers["length"].as_u64().expect("checksum cover length"))
            .expect("checksum cover length fits usize"),
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FixtureError {
    InvalidJson,
    NonCanonicalBase64,
    SegmentOutOfBounds,
    SegmentsOutOfOrder,
    SegmentOverlap,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SparseReadError {
    RangeOutOfBounds,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SparseSegment {
    offset: u64,
    bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SparseContainer {
    file_length: u64,
    segments: Vec<SparseSegment>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SparseFixture {
    Absent,
    Container(SparseContainer),
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct SparseContainerWire {
    #[serde(rename = "fileLength")]
    file_length: u64,
    segments: Vec<SparseSegmentWire>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct SparseSegmentWire {
    offset: u64,
    #[serde(rename = "bytesBase64")]
    bytes_base64: String,
}

impl SparseContainer {
    pub fn new(file_length: u64, segments: Vec<SparseSegment>) -> Result<Self, FixtureError> {
        let mut prior_end = 0_u64;
        let mut prior_offset = None;
        for segment in &segments {
            let end = segment
                .offset
                .checked_add(segment.bytes.len() as u64)
                .ok_or(FixtureError::SegmentOutOfBounds)?;
            if end > file_length {
                return Err(FixtureError::SegmentOutOfBounds);
            }
            if prior_offset.is_some_and(|offset| segment.offset < offset) {
                return Err(FixtureError::SegmentsOutOfOrder);
            }
            if segment.offset < prior_end {
                return Err(FixtureError::SegmentOverlap);
            }
            prior_offset = Some(segment.offset);
            prior_end = end;
        }
        Ok(Self {
            file_length,
            segments,
        })
    }

    pub fn file_length_value(&self) -> u64 {
        self.file_length
    }

    pub fn zero(file_length: u64) -> Self {
        Self {
            file_length,
            segments: Vec::new(),
        }
    }
}

impl PublicationAdapter for SparseContainer {
    fn apply(&mut self, _action: PublicationAction<'_>) -> Result<(), Self::Error> {
        panic!("read-only fixture adapter cannot publish")
    }

    fn close(&mut self) -> Result<(), Self::Error> {
        Ok(())
    }
}

impl SparseFixture {
    pub fn parse_json(json: &str) -> Result<Self, FixtureError> {
        let wire: Option<SparseContainerWire> =
            serde_json::from_str(json).map_err(|_| FixtureError::InvalidJson)?;
        let Some(wire) = wire else {
            return Ok(Self::Absent);
        };
        let mut segments = Vec::with_capacity(wire.segments.len());
        for segment in wire.segments {
            let bytes = STANDARD
                .decode(&segment.bytes_base64)
                .map_err(|_| FixtureError::NonCanonicalBase64)?;
            if STANDARD.encode(&bytes) != segment.bytes_base64 {
                return Err(FixtureError::NonCanonicalBase64);
            }
            segments.push(SparseSegment {
                offset: segment.offset,
                bytes,
            });
        }
        Ok(Self::Container(SparseContainer::new(
            wire.file_length,
            segments,
        )?))
    }

    pub fn encode_json(&self) -> String {
        let wire = match self {
            Self::Absent => None,
            Self::Container(container) => Some(SparseContainerWire {
                file_length: container.file_length,
                segments: container
                    .segments
                    .iter()
                    .map(|segment| SparseSegmentWire {
                        offset: segment.offset,
                        bytes_base64: STANDARD.encode(&segment.bytes),
                    })
                    .collect(),
            }),
        };
        serde_json::to_string(&wire).expect("sparse fixture wire is serializable")
    }

    pub fn container(&self) -> Option<&SparseContainer> {
        match self {
            Self::Absent => None,
            Self::Container(container) => Some(container),
        }
    }
}

impl AbsoluteRangeReader for SparseContainer {
    type Error = SparseReadError;

    fn file_length(&self) -> Result<u64, Self::Error> {
        Ok(self.file_length)
    }

    fn read_exact_at(&self, absolute_offset: u64, output: &mut [u8]) -> Result<(), Self::Error> {
        let end = absolute_offset
            .checked_add(output.len() as u64)
            .ok_or(SparseReadError::RangeOutOfBounds)?;
        if end > self.file_length {
            return Err(SparseReadError::RangeOutOfBounds);
        }
        output.fill(0);
        for segment in &self.segments {
            let segment_end = segment.offset + segment.bytes.len() as u64;
            let start = absolute_offset.max(segment.offset);
            let overlap_end = end.min(segment_end);
            if start >= overlap_end {
                continue;
            }
            let output_start = usize::try_from(start - absolute_offset).expect("output offset");
            let segment_start = usize::try_from(start - segment.offset).expect("segment offset");
            let count = usize::try_from(overlap_end - start).expect("overlap length");
            output[output_start..output_start + count]
                .copy_from_slice(&segment.bytes[segment_start..segment_start + count]);
        }
        Ok(())
    }
}

#[derive(Clone)]
pub struct OverlayReader {
    base: SparseContainer,
    file_length: u64,
    overlays: Vec<(u64, Vec<u8>)>,
    max_requested: Arc<AtomicUsize>,
}

impl OverlayReader {
    pub fn new(base: SparseContainer) -> Self {
        let file_length = base.file_length_value();
        Self {
            base,
            file_length,
            overlays: Vec::new(),
            max_requested: Arc::new(AtomicUsize::new(0)),
        }
    }

    pub fn write(&mut self, offset: u64, bytes: Vec<u8>) {
        self.overlays.push((offset, bytes));
    }

    pub fn read_vec(&self, offset: u64, length: usize) -> Vec<u8> {
        let mut bytes = vec![0_u8; length];
        self.read_exact_at(offset, &mut bytes)
            .expect("mutation read is in bounds");
        bytes
    }

    pub fn max_requested(&self) -> usize {
        self.max_requested.load(Ordering::Relaxed)
    }

    pub fn apply(&mut self, mutation: &Value) {
        let kind = mutation["kind"].as_str().expect("mutation kind");
        match kind {
            "set-file-length" => {
                self.file_length = mutation["value"].as_u64().expect("file length");
            }
            "write-byte" => self.write(
                mutation["offset"].as_u64().expect("offset"),
                vec![u8::try_from(mutation["value"].as_u64().expect("byte")).expect("u8")],
            ),
            "write-u16-le" => self.write(
                mutation["offset"].as_u64().expect("offset"),
                u16::try_from(mutation["value"].as_u64().expect("u16"))
                    .expect("u16")
                    .to_le_bytes()
                    .to_vec(),
            ),
            "write-u32-le" => self.write(
                mutation["offset"].as_u64().expect("offset"),
                u32::try_from(mutation["value"].as_u64().expect("u32"))
                    .expect("u32")
                    .to_le_bytes()
                    .to_vec(),
            ),
            "write-u64-le" => self.write(
                mutation["offset"].as_u64().expect("offset"),
                mutation["value"]
                    .as_str()
                    .expect("decimal u64")
                    .parse::<u64>()
                    .expect("u64")
                    .to_le_bytes()
                    .to_vec(),
            ),
            "xor-byte" => {
                let offset = mutation["offset"].as_u64().expect("offset");
                let mut byte = self.read_vec(offset, 1);
                byte[0] ^= u8::try_from(mutation["value"].as_u64().expect("xor byte")).expect("u8");
                self.write(offset, byte);
            }
            "zero-range" => self.write(
                mutation["offset"].as_u64().expect("offset"),
                vec![
                    0_u8;
                    usize::try_from(mutation["length"].as_u64().expect("length")).expect("usize")
                ],
            ),
            "write-bytes" => self.write(
                mutation["offset"].as_u64().expect("offset"),
                STANDARD
                    .decode(mutation["bytesBase64"].as_str().expect("base64"))
                    .expect("canonical fixture Base64"),
            ),
            "recompute-header-checksum" => {
                let header_offset = mutation["headerOffset"].as_u64().expect("header offset");
                let (cover_offset, cover_length) = checksum_cover();
                let covered = self.read_vec(header_offset + cover_offset, cover_length);
                self.write(
                    header_offset + header_field_offset("headerChecksum"),
                    Sha256::digest(covered).to_vec(),
                );
            }
            other => panic!("unknown frozen mutation {other}"),
        }
    }
}

impl AbsoluteRangeReader for OverlayReader {
    type Error = SparseReadError;

    fn file_length(&self) -> Result<u64, Self::Error> {
        Ok(self.file_length)
    }

    fn read_exact_at(&self, absolute_offset: u64, output: &mut [u8]) -> Result<(), Self::Error> {
        self.max_requested
            .fetch_max(output.len(), Ordering::Relaxed);
        self.base.read_exact_at(absolute_offset, output)?;
        let end = absolute_offset
            .checked_add(output.len() as u64)
            .ok_or(SparseReadError::RangeOutOfBounds)?;
        for (offset, bytes) in &self.overlays {
            let overlay_end = offset + bytes.len() as u64;
            let start = absolute_offset.max(*offset);
            let overlap_end = end.min(overlay_end);
            if start >= overlap_end {
                continue;
            }
            let output_start = usize::try_from(start - absolute_offset).expect("output offset");
            let source_start = usize::try_from(start - offset).expect("overlay offset");
            let count = usize::try_from(overlap_end - start).expect("overlap length");
            output[output_start..output_start + count]
                .copy_from_slice(&bytes[source_start..source_start + count]);
        }
        Ok(())
    }
}

impl PublicationAdapter for OverlayReader {
    fn apply(&mut self, _action: PublicationAction<'_>) -> Result<(), Self::Error> {
        panic!("read-only fixture adapter cannot publish")
    }

    fn close(&mut self) -> Result<(), Self::Error> {
        Ok(())
    }
}
