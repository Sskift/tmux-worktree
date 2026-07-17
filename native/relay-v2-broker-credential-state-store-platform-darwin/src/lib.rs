//! Unwired Darwin secure-open and durability scaffold for the Relay v2 broker
//! credential state store.
//!
//! The frozen durability allowlist is empty. Consequently [`open`] performs
//! only native account/home and read-only qualification observations before it
//! returns `DURABILITY_UNSUPPORTED`; it cannot reserve the process registry or
//! mutate the filesystem. The remaining scaffold is reachable only from this
//! crate's `cfg(test)` qualification seam.
//!
//! Platform-common remains the sole lifecycle owner and the only production
//! consumer of the N1 core. This crate consumes only its public container spec,
//! typestates, opaque store, and [`SoleContainer`] seam.

#![cfg(target_os = "macos")]

mod acl;
mod open;
mod sys;

pub use open::open;
