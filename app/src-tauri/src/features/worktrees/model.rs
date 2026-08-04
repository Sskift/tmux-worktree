#[derive(Clone)]
pub(super) struct RemoteWorktreeTarget {
    pub(super) label: String,
    pub(super) project_dir: String,
    pub(super) branch: Option<String>,
    pub(super) worktree_base: Option<String>,
}
