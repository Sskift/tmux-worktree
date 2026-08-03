use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const ARTIFACT_HANDLE_PREFIX: &str = "dqart1.";
const MAX_ARTIFACT_LIFETIME_MS: u64 = 5 * 60 * 1_000;
const MAX_PNG_BYTES: usize = 512 * 1_024;
const MAX_COPY_VALUE_BYTES: usize = 8 * 1_024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct EnrollmentArtifactLineage {
    pub(crate) enrollment_id: String,
    pub(crate) host_id: String,
    pub(crate) connector_id: String,
    pub(crate) expires_at_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RendererEnrollmentArtifact {
    pub(crate) kind: &'static str,
    pub(crate) handle: String,
    pub(crate) expires_at_ms: u64,
}

pub(crate) enum EnrollmentArtifactWindowClaim {
    Existing { label: String },
    Fresh { label: String, png: Arc<[u8]> },
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum EnrollmentArtifactCopyField {
    IssuerUrl,
    RelayUrl,
    EnrollmentLink,
}

pub(crate) struct RenderedEnrollmentArtifact {
    pub(crate) issuer_url: String,
    pub(crate) relay_url: String,
    pub(crate) enrollment_link: String,
    pub(crate) png: Vec<u8>,
}

struct ArtifactRecord {
    lineage: EnrollmentArtifactLineage,
    handle: String,
    png: Arc<[u8]>,
    issuer_url: Arc<str>,
    relay_url: Arc<str>,
    enrollment_link: Arc<str>,
    window_label: Option<String>,
}

#[derive(Default)]
struct RegistryState {
    closed: bool,
    record: Option<ArtifactRecord>,
}

type WindowCloser = dyn Fn(&str) + Send + Sync + 'static;

struct RegistryInner {
    state: Mutex<RegistryState>,
    wake: Condvar,
    closer: Arc<WindowCloser>,
    timer: Mutex<Option<JoinHandle<()>>>,
}

#[derive(Clone)]
pub(crate) struct EnrollmentArtifactRegistry {
    inner: Arc<RegistryInner>,
}

impl EnrollmentArtifactRegistry {
    pub(crate) fn new<F>(closer: F) -> Result<Self, ()>
    where
        F: Fn(&str) + Send + Sync + 'static,
    {
        let inner = Arc::new(RegistryInner {
            state: Mutex::new(RegistryState::default()),
            wake: Condvar::new(),
            closer: Arc::new(closer),
            timer: Mutex::new(None),
        });
        let timer_inner = Arc::downgrade(&inner);
        let timer = thread::Builder::new()
            .name("relay-v2-enrollment-artifact-expiry".to_string())
            .spawn(move || expiry_owner(timer_inner))
            .map_err(|_| ())?;
        *inner.timer.lock().unwrap() = Some(timer);
        Ok(Self { inner })
    }

    pub(crate) fn disabled() -> Self {
        Self {
            inner: Arc::new(RegistryInner {
                state: Mutex::new(RegistryState {
                    closed: true,
                    record: None,
                }),
                wake: Condvar::new(),
                closer: Arc::new(|_| {}),
                timer: Mutex::new(None),
            }),
        }
    }

    pub(crate) fn get_or_create<F>(
        &self,
        lineage: EnrollmentArtifactLineage,
        render: F,
    ) -> Result<RendererEnrollmentArtifact, ()>
    where
        F: FnOnce() -> Result<RenderedEnrollmentArtifact, ()>,
    {
        let now_ms = unix_now_ms()?;
        if lineage.expires_at_ms <= now_ms
            || lineage.expires_at_ms - now_ms > MAX_ARTIFACT_LIFETIME_MS
        {
            return Err(());
        }

        let old_window = {
            let mut state = self.inner.state.lock().unwrap();
            if state.closed {
                return Err(());
            }
            if let Some(record) = &state.record {
                if record.lineage == lineage {
                    return Ok(renderer_artifact(record));
                }
            }
            state.record.take().and_then(|record| record.window_label)
        };
        close_window(&self.inner, old_window);

        let rendered = render()?;
        if rendered.png.is_empty()
            || rendered.png.len() > MAX_PNG_BYTES
            || !rendered.png.starts_with(b"\x89PNG\r\n\x1a\n")
            || !valid_copy_value(&rendered.issuer_url)
            || !valid_copy_value(&rendered.relay_url)
            || !valid_copy_value(&rendered.enrollment_link)
            || !rendered
                .enrollment_link
                .starts_with("tmuxworktree://enroll?")
        {
            return Err(());
        }
        let handle = random_handle(ARTIFACT_HANDLE_PREFIX)?;
        let record = ArtifactRecord {
            lineage,
            handle,
            png: Arc::from(rendered.png),
            issuer_url: Arc::from(rendered.issuer_url),
            relay_url: Arc::from(rendered.relay_url),
            enrollment_link: Arc::from(rendered.enrollment_link),
            window_label: None,
        };
        let artifact = renderer_artifact(&record);
        let mut state = self.inner.state.lock().unwrap();
        if state.closed || state.record.is_some() {
            return Err(());
        }
        state.record = Some(record);
        self.inner.wake.notify_all();
        Ok(artifact)
    }

    pub(crate) fn claim_window(&self, handle: &str) -> Result<EnrollmentArtifactWindowClaim, ()> {
        let now_ms = unix_now_ms()?;
        let mut state = self.inner.state.lock().unwrap();
        if state.closed {
            return Err(());
        }
        let record = state.record.as_mut().ok_or(())?;
        if record.handle != handle || record.lineage.expires_at_ms <= now_ms {
            return Err(());
        }
        if let Some(label) = &record.window_label {
            return Ok(EnrollmentArtifactWindowClaim::Existing {
                label: label.clone(),
            });
        }
        let label = format!("relay-v2-enrollment-{}", random_handle("")?);
        record.window_label = Some(label.clone());
        Ok(EnrollmentArtifactWindowClaim::Fresh {
            label,
            png: Arc::clone(&record.png),
        })
    }

    pub(crate) fn claim_copy_value(
        &self,
        handle: &str,
        field: EnrollmentArtifactCopyField,
    ) -> Result<Arc<str>, ()> {
        let now_ms = unix_now_ms()?;
        let state = self.inner.state.lock().unwrap();
        if state.closed {
            return Err(());
        }
        let record = state.record.as_ref().ok_or(())?;
        if record.handle != handle || record.lineage.expires_at_ms <= now_ms {
            return Err(());
        }
        Ok(Arc::clone(match field {
            EnrollmentArtifactCopyField::IssuerUrl => &record.issuer_url,
            EnrollmentArtifactCopyField::RelayUrl => &record.relay_url,
            EnrollmentArtifactCopyField::EnrollmentLink => &record.enrollment_link,
        }))
    }

    pub(crate) fn release_window(&self, handle: &str, label: &str) {
        let mut state = self.inner.state.lock().unwrap();
        if let Some(record) = &mut state.record {
            if record.handle == handle && record.window_label.as_deref() == Some(label) {
                record.window_label = None;
            }
        }
    }

    pub(crate) fn clear_if_window(&self, handle: &str, label: &str) {
        let mut state = self.inner.state.lock().unwrap();
        if state.record.as_ref().is_some_and(|record| {
            record.handle == handle && record.window_label.as_deref() == Some(label)
        }) {
            state.record = None;
            self.inner.wake.notify_all();
        }
    }

    pub(crate) fn clear(&self) {
        let window = {
            let mut state = self.inner.state.lock().unwrap();
            let window = state.record.take().and_then(|record| record.window_label);
            self.inner.wake.notify_all();
            window
        };
        close_window(&self.inner, window);
    }

    pub(crate) fn close(&self) {
        let window = {
            let mut state = self.inner.state.lock().unwrap();
            if state.closed {
                None
            } else {
                state.closed = true;
                let window = state.record.take().and_then(|record| record.window_label);
                self.inner.wake.notify_all();
                window
            }
        };
        close_window(&self.inner, window);
        if let Some(timer) = self.inner.timer.lock().unwrap().take() {
            let _ = timer.join();
        }
    }
}

fn renderer_artifact(record: &ArtifactRecord) -> RendererEnrollmentArtifact {
    RendererEnrollmentArtifact {
        kind: "native_qr_handle",
        handle: record.handle.clone(),
        expires_at_ms: record.lineage.expires_at_ms,
    }
}

fn valid_copy_value(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_COPY_VALUE_BYTES
        && value.trim() == value
        && !value
            .chars()
            .any(|character| matches!(character, '\0' | '\r' | '\n'))
}

fn random_handle(prefix: &str) -> Result<String, ()> {
    let mut bytes = [0u8; 24];
    getrandom::fill(&mut bytes).map_err(|_| ())?;
    Ok(format!("{prefix}{}", URL_SAFE_NO_PAD.encode(bytes)))
}

fn unix_now_ms() -> Result<u64, ()> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| ())?
        .as_millis();
    u64::try_from(millis).map_err(|_| ())
}

#[cfg(test)]
pub(crate) fn tests_now_ms() -> u64 {
    unix_now_ms().unwrap()
}

fn close_window(inner: &RegistryInner, label: Option<String>) {
    if let Some(label) = label {
        (inner.closer)(&label);
    }
}

fn expiry_owner(weak: std::sync::Weak<RegistryInner>) {
    loop {
        let Some(inner) = weak.upgrade() else {
            return;
        };
        let mut state = inner.state.lock().unwrap();
        loop {
            if state.closed {
                return;
            }
            let Some(expires_at_ms) = state
                .record
                .as_ref()
                .map(|record| record.lineage.expires_at_ms)
            else {
                state = inner.wake.wait(state).unwrap();
                continue;
            };
            let now_ms = unix_now_ms().unwrap_or(u64::MAX);
            if expires_at_ms <= now_ms {
                let window = state.record.take().and_then(|record| record.window_label);
                drop(state);
                close_window(&inner, window);
                break;
            }
            let wait = Duration::from_millis(expires_at_ms - now_ms);
            let (next, _) = inner.wake.wait_timeout(state, wait).unwrap();
            state = next;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn lineage(expires_at_ms: u64) -> EnrollmentArtifactLineage {
        EnrollmentArtifactLineage {
            enrollment_id: "enrollment-1".to_string(),
            host_id: "mac-admin".to_string(),
            connector_id: "connector-1".to_string(),
            expires_at_ms,
        }
    }

    fn rendered() -> RenderedEnrollmentArtifact {
        RenderedEnrollmentArtifact {
            issuer_url: "https://relay.example.com".to_string(),
            relay_url: "wss://relay.example.com/client".to_string(),
            enrollment_link: "tmuxworktree://enroll?v=2&enrollmentCode=twenroll2.opaque"
                .to_string(),
            png: b"\x89PNG\r\n\x1a\nartifact".to_vec(),
        }
    }

    #[test]
    fn same_lineage_reuses_only_the_opaque_handle_and_clear_revokes_it() {
        let closes = Arc::new(AtomicUsize::new(0));
        let close_count = Arc::clone(&closes);
        let registry = EnrollmentArtifactRegistry::new(move |_| {
            close_count.fetch_add(1, Ordering::SeqCst);
        })
        .unwrap();
        let expires_at_ms = unix_now_ms().unwrap() + 60_000;
        let first = registry
            .get_or_create(lineage(expires_at_ms), || Ok(rendered()))
            .unwrap();
        let second = registry
            .get_or_create(lineage(expires_at_ms), || panic!("must reuse"))
            .unwrap();
        assert_eq!(first, second);
        assert_eq!(first.kind, "native_qr_handle");
        assert!(first.handle.starts_with(ARTIFACT_HANDLE_PREFIX));
        assert!(!first.handle.contains("enrollment-1"));
        assert_eq!(
            registry
                .claim_copy_value(&first.handle, EnrollmentArtifactCopyField::IssuerUrl)
                .unwrap()
                .as_ref(),
            "https://relay.example.com"
        );

        let claim = registry.claim_window(&first.handle).unwrap();
        let EnrollmentArtifactWindowClaim::Fresh { label, .. } = claim else {
            panic!("expected fresh native window claim");
        };
        registry.clear();
        assert_eq!(closes.load(Ordering::SeqCst), 1);
        assert!(registry.claim_window(&first.handle).is_err());
        assert!(registry
            .claim_copy_value(&first.handle, EnrollmentArtifactCopyField::EnrollmentLink)
            .is_err());
        assert!(label.starts_with("relay-v2-enrollment-"));
        registry.close();
    }

    #[test]
    fn expired_or_overlong_artifacts_are_never_admitted() {
        let registry = EnrollmentArtifactRegistry::new(|_| {}).unwrap();
        let now = unix_now_ms().unwrap();
        assert!(registry
            .get_or_create(lineage(now), || Ok(rendered()))
            .is_err());
        assert!(registry
            .get_or_create(lineage(now + MAX_ARTIFACT_LIFETIME_MS + 1), || {
                Ok(rendered())
            })
            .is_err());
        registry.close();
    }

    #[test]
    fn disabled_owner_is_closed_without_a_timer_or_artifact() {
        let registry = EnrollmentArtifactRegistry::disabled();
        let expires_at_ms = unix_now_ms().unwrap() + 60_000;
        assert!(registry
            .get_or_create(lineage(expires_at_ms), || Ok(rendered()))
            .is_err());
        assert!(registry.claim_window("dqart1.invalid").is_err());
        registry.close();
    }

    #[test]
    fn expiry_owner_destroys_the_native_window_and_revokes_the_handle() {
        let (closed_sender, closed_receiver) = std::sync::mpsc::sync_channel(1);
        let registry = EnrollmentArtifactRegistry::new(move |label| {
            let _ = closed_sender.send(label.to_string());
        })
        .unwrap();
        let artifact = registry
            .get_or_create(lineage(unix_now_ms().unwrap() + 50), || Ok(rendered()))
            .unwrap();
        let EnrollmentArtifactWindowClaim::Fresh { label, .. } = registry
            .claim_window(&artifact.handle)
            .expect("current handle claims its native window")
        else {
            panic!("expected a fresh native window claim");
        };

        assert_eq!(
            closed_receiver
                .recv_timeout(Duration::from_secs(2))
                .expect("expiry closes the claimed native window"),
            label
        );
        assert!(registry.claim_window(&artifact.handle).is_err());
        registry.close();
    }

    #[test]
    fn lineage_replacement_closes_the_old_window_and_invalidates_its_handle() {
        let closes = Arc::new(AtomicUsize::new(0));
        let close_count = Arc::clone(&closes);
        let registry = EnrollmentArtifactRegistry::new(move |_| {
            close_count.fetch_add(1, Ordering::SeqCst);
        })
        .unwrap();
        let expires_at_ms = unix_now_ms().unwrap() + 60_000;
        let first = registry
            .get_or_create(lineage(expires_at_ms), || Ok(rendered()))
            .unwrap();
        registry.claim_window(&first.handle).unwrap();
        let mut replacement_lineage = lineage(expires_at_ms);
        replacement_lineage.connector_id = "connector-2".to_string();
        let replacement = registry
            .get_or_create(replacement_lineage, || Ok(rendered()))
            .unwrap();

        assert_ne!(first.handle, replacement.handle);
        assert_eq!(closes.load(Ordering::SeqCst), 1);
        assert!(registry.claim_window(&first.handle).is_err());
        registry.claim_window(&replacement.handle).unwrap();
        registry.close();
    }
}
