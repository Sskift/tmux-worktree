/// Parse a composite session key into (host_id, raw_name).
/// - "hostid:rawname" -> (Some("hostid"), "rawname")
/// - "rawname"        -> (None, "rawname")
pub(crate) fn parse_session_key(key: &str) -> (Option<&str>, &str) {
    match key.split_once(':') {
        Some((host_id, raw_name)) => (Some(host_id), raw_name),
        None => (None, key),
    }
}
