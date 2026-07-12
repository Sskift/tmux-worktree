use serde::{Deserialize, Serialize};

#[derive(Serialize, Clone)]
pub(crate) struct GitStatus {
    pub(crate) branch: String,
    pub(crate) upstream: Option<String>,
    pub(crate) ahead: u32,
    pub(crate) behind: u32,
    pub(crate) staged: u32,
    pub(crate) unstaged: u32,
    pub(crate) untracked: u32,
    pub(crate) conflicts: u32,
    pub(crate) files: Vec<GitFile>,
}

#[derive(Serialize, Clone)]
pub(crate) struct GitFile {
    pub(crate) code: String,
    pub(crate) path: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum GitGraphRefKind {
    Head,
    Local,
    Remote,
    Tag,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitGraphRef {
    /// Canonical, fully-qualified ref name (for example `refs/heads/main`).
    pub(crate) name: String,
    pub(crate) short_name: String,
    pub(crate) kind: GitGraphRefKind,
    pub(crate) current: bool,
    /// Canonical upstream ref configured for a local branch, when present.
    pub(crate) upstream: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitGraphRefs {
    pub(crate) refs: Vec<GitGraphRef>,
    pub(crate) current: Option<String>,
    pub(crate) upstream: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitGraphCommit {
    pub(crate) hash: String,
    pub(crate) short: String,
    /// Full parent object ids in Git's topology order.
    pub(crate) parents: Vec<String>,
    pub(crate) subject: String,
    pub(crate) author: String,
    pub(crate) rel_time: String,
    pub(crate) authored_at: String,
    pub(crate) decorations: Vec<GitGraphRef>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitGraphResult {
    pub(crate) commits: Vec<GitGraphCommit>,
    pub(crate) refs: Vec<GitGraphRef>,
    pub(crate) current: Option<String>,
    pub(crate) upstream: Option<String>,
    pub(crate) has_more: bool,
}

#[derive(Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum GitGraphPreset {
    Head,
    #[default]
    Current,
    All,
}

#[derive(Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitGraphQuery {
    #[serde(default)]
    pub(crate) preset: GitGraphPreset,
    #[serde(default)]
    pub(crate) selected_refs: Vec<String>,
    pub(crate) limit: Option<u32>,
}
