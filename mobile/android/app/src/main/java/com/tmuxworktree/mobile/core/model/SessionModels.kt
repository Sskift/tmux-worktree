package com.tmuxworktree.mobile.core.model

enum class AgentState {
    WAITING_FOR_USER,
    RUNNING,
    FAILED,
    COMPLETED,
    UNKNOWN,
}

data class RelaySession(
    val hostId: String,
    val hostName: String = hostId,
    val name: String,
    val rawName: String = "",
    val scopeId: String = "local",
    val scopeLabel: String = "local",
    val kind: String = "session",
    val project: String = "",
    val label: String = "",
    val cwd: String = "",
    val attached: Boolean = false,
    val windows: Int = 1,
    val createdAtSeconds: Long = 0,
    val activityAtSeconds: Long = 0,
    val agentState: AgentState = AgentState.UNKNOWN,
    val summary: String = "",
    val branch: String = "",
    /** Optional UI-only identity for protocols whose opaque identity is not the v1 host/name pair. */
    val stableIdOverride: String? = null,
) {
    val stableId: String get() = stableIdOverride ?: "$hostId:$name"
    val title: String get() = label.ifBlank { rawName.ifBlank { name } }
    val projectName: String
        get() = project.ifBlank {
            val marker = "/.tmux-worktree/worktrees/"
            val normalized = cwd.trimEnd('/')
            val markerIndex = normalized.indexOf(marker)
            if (markerIndex > 0) {
                normalized.substring(0, markerIndex).substringAfterLast('/')
            } else {
                normalized.substringAfterLast('/').takeIf { it.isNotBlank() } ?: "Workspace"
            }
        }
}
