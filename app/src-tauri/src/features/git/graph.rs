use super::model::{
    GitGraphCommit, GitGraphPreset, GitGraphQuery, GitGraphRef, GitGraphRefKind, GitGraphRefs,
    GitGraphResult,
};
use super::runner::{run_git_output, run_git_quiet};
use std::collections::{HashMap, HashSet};

#[derive(Debug)]
struct GitGraphCatalog {
    response: GitGraphRefs,
    head_target: Option<String>,
    /// Full commit object id by canonical ref name. Annotated tags are peeled.
    targets: HashMap<String, String>,
}

fn git_graph_ref_kind(name: &str) -> Option<GitGraphRefKind> {
    if name.starts_with("refs/heads/") {
        Some(GitGraphRefKind::Local)
    } else if name.starts_with("refs/remotes/") {
        Some(GitGraphRefKind::Remote)
    } else if name.starts_with("refs/tags/") {
        Some(GitGraphRefKind::Tag)
    } else {
        None
    }
}

fn git_output_string(host_id: Option<&str>, git_args: &[&str]) -> Result<Option<String>, String> {
    let output = run_git_output(host_id, git_args)?;
    if !output.status.success() {
        return Ok(None);
    }
    Ok(Some(
        String::from_utf8_lossy(&output.stdout).trim().to_string(),
    ))
}

fn trim_record_newlines(mut record: &[u8]) -> &[u8] {
    while record
        .first()
        .is_some_and(|byte| matches!(byte, b'\n' | b'\r'))
    {
        record = &record[1..];
    }
    while record
        .last()
        .is_some_and(|byte| matches!(byte, b'\n' | b'\r'))
    {
        record = &record[..record.len() - 1];
    }
    record
}

fn bytes_to_string(value: &[u8]) -> String {
    String::from_utf8_lossy(value).into_owned()
}

fn collect_git_graph_catalog(cwd: &str, host_id: Option<&str>) -> Result<GitGraphCatalog, String> {
    let current = git_output_string(host_id, &["-C", cwd, "symbolic-ref", "--quiet", "HEAD"])?
        .filter(|value| value.starts_with("refs/heads/"));
    let head_target = git_output_string(
        host_id,
        &["-C", cwd, "rev-parse", "--verify", "HEAD^{commit}"],
    )?;

    // for-each-ref is the sole source of user-selectable refs. The NUL record
    // separator avoids branch/tag names ever becoming command-line structure.
    let format = "%(refname)%1f%(refname:short)%1f%(objectname)%1f%(*objectname)%1f%(upstream)%1f%(symref)%1f%(objecttype)%1f%(*objecttype)%00";
    let format_arg = format!("--format={format}");
    let output = run_git_output(
        host_id,
        &[
            "-C",
            cwd,
            "for-each-ref",
            "--sort=refname",
            &format_arg,
            "refs/heads",
            "refs/remotes",
            "refs/tags",
        ],
    )?;
    if !output.status.success() {
        return Err(format!(
            "git for-each-ref failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    struct ParsedRef {
        name: String,
        short_name: String,
        kind: GitGraphRefKind,
        target: String,
        configured_upstream: Option<String>,
    }

    let mut parsed_refs = Vec::new();
    for raw_record in output.stdout.split(|byte| *byte == 0) {
        let record = trim_record_newlines(raw_record);
        if record.is_empty() {
            continue;
        }
        let fields = record.splitn(8, |byte| *byte == 0x1f).collect::<Vec<_>>();
        if fields.len() != 8 {
            return Err("git for-each-ref returned a malformed record".to_string());
        }

        let name = bytes_to_string(fields[0]);
        let Some(kind) = git_graph_ref_kind(&name) else {
            continue;
        };
        // refs/remotes/<remote>/HEAD is a symbolic alias rather than a branch
        // users can meaningfully add to the graph.
        if !fields[5].is_empty() {
            continue;
        }

        let object_type = bytes_to_string(fields[6]);
        let peeled_type = bytes_to_string(fields[7]);
        let target = if peeled_type == "commit" {
            bytes_to_string(fields[3])
        } else if object_type == "commit" {
            bytes_to_string(fields[2])
        } else {
            // A tag may legally point to a blob/tree. It has no place in a
            // commit graph and is deliberately not made selectable.
            continue;
        };
        let configured_upstream = if fields[4].is_empty() {
            None
        } else {
            Some(bytes_to_string(fields[4]))
        };
        parsed_refs.push(ParsedRef {
            name,
            short_name: bytes_to_string(fields[1]),
            kind,
            target,
            configured_upstream,
        });
    }

    let upstream = current.as_ref().and_then(|current_name| {
        parsed_refs
            .iter()
            .find(|reference| reference.name == *current_name)
            .and_then(|reference| reference.configured_upstream.clone())
    });
    let mut targets = HashMap::new();
    let refs = parsed_refs
        .into_iter()
        .map(|reference| {
            targets.insert(reference.name.clone(), reference.target);
            GitGraphRef {
                current: current.as_deref() == Some(reference.name.as_str()),
                upstream: reference.configured_upstream,
                name: reference.name,
                short_name: reference.short_name,
                kind: reference.kind,
            }
        })
        .collect();

    Ok(GitGraphCatalog {
        response: GitGraphRefs {
            refs,
            current,
            upstream,
        },
        head_target,
        targets,
    })
}

fn empty_git_graph_result() -> GitGraphResult {
    GitGraphResult {
        commits: Vec::new(),
        refs: Vec::new(),
        current: None,
        upstream: None,
        has_more: false,
    }
}

pub(crate) fn git_graph_refs_for(cwd: &str, host_id: Option<&str>) -> Result<GitGraphRefs, String> {
    let inside = run_git_quiet(host_id, &["-C", cwd, "rev-parse", "--is-inside-work-tree"]);
    if inside.as_deref() != Some("true") {
        return Ok(GitGraphRefs {
            refs: Vec::new(),
            current: None,
            upstream: None,
        });
    }
    Ok(collect_git_graph_catalog(cwd, host_id)?.response)
}

#[tauri::command]
pub(crate) async fn git_graph_refs(
    cwd: String,
    host_id: Option<String>,
) -> Result<GitGraphRefs, String> {
    tauri::async_runtime::spawn_blocking(move || git_graph_refs_for(&cwd, host_id.as_deref()))
        .await
        .map_err(|error| format!("git graph refs task failed: {error}"))?
}

fn validated_selected_git_graph_refs(
    selected_refs: &[String],
    refs: &[GitGraphRef],
) -> Result<Vec<String>, String> {
    let allowed = refs
        .iter()
        .map(|reference| reference.name.as_str())
        .collect::<HashSet<_>>();
    let mut selected = Vec::new();
    let mut seen = HashSet::new();
    for requested in selected_refs {
        if requested.starts_with('-') {
            return Err(format!("invalid git ref: {requested}"));
        }
        // Exact matching intentionally rejects short names, whitespace-padded
        // values and every ref namespace not returned by for-each-ref above.
        if !allowed.contains(requested.as_str()) {
            return Err(format!("unknown git ref: {requested}"));
        }
        if seen.insert(requested.as_str()) {
            selected.push(requested.clone());
        }
    }
    Ok(selected)
}

fn graph_decorations(catalog: &GitGraphCatalog) -> HashMap<String, Vec<GitGraphRef>> {
    let mut by_commit: HashMap<String, Vec<GitGraphRef>> = HashMap::new();
    if let Some(head_target) = &catalog.head_target {
        by_commit
            .entry(head_target.clone())
            .or_default()
            .push(GitGraphRef {
                name: "HEAD".to_string(),
                short_name: "HEAD".to_string(),
                kind: GitGraphRefKind::Head,
                current: true,
                upstream: None,
            });
    }
    for reference in &catalog.response.refs {
        let Some(target) = catalog.targets.get(&reference.name) else {
            continue;
        };
        by_commit
            .entry(target.clone())
            .or_default()
            .push(reference.clone());
    }
    by_commit
}

pub(crate) fn git_graph_for(
    cwd: &str,
    host_id: Option<&str>,
    query: GitGraphQuery,
) -> Result<GitGraphResult, String> {
    let inside = run_git_quiet(host_id, &["-C", cwd, "rev-parse", "--is-inside-work-tree"]);
    if inside.as_deref() != Some("true") {
        return Ok(empty_git_graph_result());
    }

    let catalog = collect_git_graph_catalog(cwd, host_id)?;
    let selected = validated_selected_git_graph_refs(&query.selected_refs, &catalog.response.refs)?;
    let limit = query.limit.unwrap_or(120).clamp(1, 2_000) as usize;
    let fetch_count = (limit + 1).to_string();
    // Git identities and commit subjects may legally contain every control
    // character except NUL. Use fixed-count NUL fields instead of a textual
    // delimiter so unusual but valid history cannot shift the protocol.
    let pretty = "--pretty=format:%H%x00%h%x00%P%x00%s%x00%an%x00%ar%x00%aI";

    let mut args = vec![
        "-C".to_string(),
        cwd.to_string(),
        "log".to_string(),
        "--topo-order".to_string(),
        "--no-color".to_string(),
        "-z".to_string(),
        "-n".to_string(),
        fetch_count,
        pretty.to_string(),
    ];
    // Resolve every graph root from the catalog snapshot. This keeps the log
    // and its decorations coherent when a background fetch moves or prunes a
    // ref between catalog collection and `git log` execution.
    let mut roots = Vec::new();
    let mut seen_roots = HashSet::new();
    let mut add_root = |target: Option<&String>| {
        if let Some(target) = target {
            if seen_roots.insert(target.clone()) {
                roots.push(target.clone());
            }
        }
    };
    match query.preset {
        GitGraphPreset::All => {
            // Product "All" means every selectable local/remote branch and
            // commit tag plus a detached HEAD, not internal refs such as stash
            // or pull refs.
            add_root(catalog.head_target.as_ref());
            for reference in &catalog.response.refs {
                add_root(catalog.targets.get(&reference.name));
            }
        }
        GitGraphPreset::Head | GitGraphPreset::Current => {
            add_root(catalog.head_target.as_ref());
            if query.preset == GitGraphPreset::Current {
                add_root(
                    catalog
                        .response
                        .upstream
                        .as_ref()
                        .and_then(|upstream| catalog.targets.get(upstream)),
                );
            }
            for selected_ref in selected {
                add_root(catalog.targets.get(&selected_ref));
            }
        }
    }
    if roots.is_empty() {
        return Ok(GitGraphResult {
            commits: Vec::new(),
            refs: catalog.response.refs,
            current: catalog.response.current,
            upstream: catalog.response.upstream,
            has_more: false,
        });
    }
    args.extend(roots);
    // End revision parsing explicitly. Selected values are already exact
    // allowlist matches, and `--` supplies a second line of defence.
    args.push("--".to_string());
    let arg_refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    let output = run_git_output(host_id, &arg_refs)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("does not have any commits yet") {
            return Ok(GitGraphResult {
                commits: Vec::new(),
                refs: catalog.response.refs,
                current: catalog.response.current,
                upstream: catalog.response.upstream,
                has_more: false,
            });
        }
        return Err(format!("git graph failed: {}", stderr.trim()));
    }

    let decorations = graph_decorations(&catalog);
    let mut commits = Vec::new();
    // `format:` plus `-z` produces a flat stream of exactly seven NUL-separated
    // fields per commit. The final authored-at field has no trailing NUL, so an
    // empty stdout is the only special case.
    let fields = output.stdout.split(|byte| *byte == 0).collect::<Vec<_>>();
    if !output.stdout.is_empty() && fields.len() % 7 != 0 {
        return Err("git log returned a malformed graph record".to_string());
    }
    for record in fields.chunks_exact(7) {
        let hash = bytes_to_string(record[0]);
        let parents = if record[2].is_empty() {
            Vec::new()
        } else {
            bytes_to_string(record[2])
                .split_whitespace()
                .map(str::to_string)
                .collect()
        };
        commits.push(GitGraphCommit {
            short: bytes_to_string(record[1]),
            parents,
            subject: bytes_to_string(record[3]),
            author: bytes_to_string(record[4]),
            rel_time: bytes_to_string(record[5]),
            authored_at: bytes_to_string(record[6]),
            decorations: decorations.get(&hash).cloned().unwrap_or_default(),
            hash,
        });
    }
    let has_more = commits.len() > limit;
    commits.truncate(limit);

    Ok(GitGraphResult {
        commits,
        refs: catalog.response.refs,
        current: catalog.response.current,
        upstream: catalog.response.upstream,
        has_more,
    })
}

#[tauri::command]
pub(crate) async fn git_graph(
    cwd: String,
    host_id: Option<String>,
    query: GitGraphQuery,
) -> Result<GitGraphResult, String> {
    tauri::async_runtime::spawn_blocking(move || git_graph_for(&cwd, host_id.as_deref(), query))
        .await
        .map_err(|error| format!("git graph task failed: {error}"))?
}
