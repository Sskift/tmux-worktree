package com.tmuxworktree.mobile.core.relay

import com.tmuxworktree.mobile.core.model.ConnectionStatus
import com.tmuxworktree.mobile.core.model.RelayHost
import com.tmuxworktree.mobile.core.model.RelayScope
import com.tmuxworktree.mobile.core.model.RelaySession

data class RelaySnapshotState(
    val hostsById: Map<String, RelayHost> = emptyMap(),
    val sessionsById: Map<String, RelaySession> = emptyMap(),
    val scopesById: Map<String, RelayScope> = emptyMap(),
    val selectedHostId: String = "",
    val updatedAtMillis: Long = 0,
    val revision: Long = 0,
) {
    val hosts: List<RelayHost> get() = hostsById.values.toList()
    val sessions: List<RelaySession> get() = sessionsById.values.toList()
    val scopes: List<RelayScope> get() = scopesById.values.toList()
}

sealed interface RelaySnapshotMutation {
    data class ReplaceHosts(
        val hosts: List<RelayV1Host>,
        val preferredHostId: String,
        val nowMillis: Long,
    ) : RelaySnapshotMutation

    data class ReplaceSessions(
        val hostId: String,
        val sessions: List<RelayV1Session>,
        val nowMillis: Long,
    ) : RelaySnapshotMutation

    data class ReplaceScopes(
        val hostId: String,
        val scopes: List<RelayV1ScopeStatus>,
        val nowMillis: Long,
    ) : RelaySnapshotMutation

    data class AddSession(
        val hostId: String,
        val session: RelayV1Session,
        val nowMillis: Long,
    ) : RelaySnapshotMutation

    data class RemoveSession(
        val hostId: String,
        val sessionName: String,
        val nowMillis: Long,
    ) : RelaySnapshotMutation
}

object RelaySnapshotReducer {
    fun reduce(state: RelaySnapshotState, mutation: RelaySnapshotMutation): RelaySnapshotState = when (mutation) {
        is RelaySnapshotMutation.ReplaceHosts -> replaceHosts(state, mutation)
        is RelaySnapshotMutation.ReplaceSessions -> replaceSessions(state, mutation)
        is RelaySnapshotMutation.ReplaceScopes -> replaceScopes(state, mutation)
        is RelaySnapshotMutation.AddSession -> addSession(state, mutation)
        is RelaySnapshotMutation.RemoveSession -> removeSession(state, mutation)
    }

    private fun replaceHosts(
        state: RelaySnapshotState,
        mutation: RelaySnapshotMutation.ReplaceHosts,
    ): RelaySnapshotState {
        val hosts = linkedMapOf<String, RelayHost>()
        mutation.hosts.forEach { host ->
            if (host.hostId.isBlank()) return@forEach
            hosts[host.hostId] = RelayHost(
                hostId = host.hostId,
                displayName = host.displayName.ifBlank { host.hostId },
                clients = host.clients,
                status = ConnectionStatus.ONLINE,
                lastSeenAtMillis = mutation.nowMillis,
            )
        }
        val selected = chooseHost(hosts.values.toList(), mutation.preferredHostId, state.selectedHostId)
        val retainedHostIds = hosts.keys
        return commitIfChanged(
            state,
            state.copy(
                hostsById = hosts,
                sessionsById = state.sessionsById.filterValues { it.hostId in retainedHostIds },
                scopesById = state.scopesById.filterValues { it.hostId in retainedHostIds },
                selectedHostId = selected,
                updatedAtMillis = mutation.nowMillis,
            ),
        )
    }

    private fun replaceSessions(
        state: RelaySnapshotState,
        mutation: RelaySnapshotMutation.ReplaceSessions,
    ): RelaySnapshotState {
        val sessions = LinkedHashMap(state.sessionsById.filterValues { it.hostId != mutation.hostId })
        mutation.sessions.forEach { wire ->
            val session = wire.toDomain(mutation.hostId, state.hostName(mutation.hostId))
            if (session.name.isNotBlank()) sessions[session.stableId] = session
        }
        return commitIfChanged(
            state,
            state.copy(sessionsById = sessions, updatedAtMillis = mutation.nowMillis),
        )
    }

    private fun replaceScopes(
        state: RelaySnapshotState,
        mutation: RelaySnapshotMutation.ReplaceScopes,
    ): RelaySnapshotState {
        val scopes = LinkedHashMap(state.scopesById.filterValues { it.hostId != mutation.hostId })
        mutation.scopes.forEach { wire ->
            if (wire.scopeId.isBlank()) return@forEach
            val scope = RelayScope(
                hostId = mutation.hostId,
                scopeId = wire.scopeId,
                label = wire.scopeLabel.ifBlank { wire.scopeId },
                kind = wire.kind.ifBlank { "local" },
                reachable = wire.reachable,
                sessionCount = wire.sessionCount,
                error = wire.error,
            )
            scopes[scope.stableId] = scope
        }
        return commitIfChanged(
            state,
            state.copy(scopesById = scopes, updatedAtMillis = mutation.nowMillis),
        )
    }

    private fun addSession(
        state: RelaySnapshotState,
        mutation: RelaySnapshotMutation.AddSession,
    ): RelaySnapshotState {
        val session = mutation.session.toDomain(mutation.hostId, state.hostName(mutation.hostId))
        if (session.name.isBlank()) return state
        return commitIfChanged(
            state,
            state.copy(
                sessionsById = LinkedHashMap(state.sessionsById).apply { put(session.stableId, session) },
                selectedHostId = mutation.hostId,
                updatedAtMillis = mutation.nowMillis,
            ),
        )
    }

    private fun removeSession(
        state: RelaySnapshotState,
        mutation: RelaySnapshotMutation.RemoveSession,
    ): RelaySnapshotState = commitIfChanged(
        state,
        state.copy(
            sessionsById = state.sessionsById.filterValues {
                it.hostId != mutation.hostId || it.name != mutation.sessionName
            },
            updatedAtMillis = mutation.nowMillis,
        ),
    )

    private fun commitIfChanged(
        previous: RelaySnapshotState,
        candidate: RelaySnapshotState,
    ): RelaySnapshotState {
        val changed = previous.hostsById != candidate.hostsById ||
            previous.sessionsById != candidate.sessionsById ||
            previous.scopesById != candidate.scopesById ||
            previous.selectedHostId != candidate.selectedHostId
        return if (changed) candidate.copy(revision = previous.revision + 1) else previous
    }

    private fun chooseHost(hosts: List<RelayHost>, preferred: String, current: String): String {
        hosts.firstOrNull { it.hostId == preferred }?.let { return it.hostId }
        hosts.firstOrNull { it.hostId == current }?.let { return it.hostId }
        hosts.firstOrNull { it.hostId == "mac-admin" }?.let { return it.hostId }
        hosts.firstOrNull {
            it.hostId.contains("admin", ignoreCase = true) ||
                it.displayName.contains("admin", ignoreCase = true)
        }?.let { return it.hostId }
        return hosts.firstOrNull()?.hostId.orEmpty()
    }

    private fun RelaySnapshotState.hostName(hostId: String): String =
        hostsById[hostId]?.displayName?.ifBlank { hostId } ?: hostId

    private fun RelayV1Session.toDomain(hostId: String, hostName: String): RelaySession = RelaySession(
        hostId = hostId,
        hostName = hostName,
        name = name,
        rawName = rawName,
        scopeId = scopeId.ifBlank { "local" },
        scopeLabel = scopeLabel.ifBlank { scopeId.ifBlank { "local" } },
        kind = kind.ifBlank { "session" },
        project = project,
        label = label,
        cwd = cwd,
        attached = attached,
        windows = windows,
        createdAtSeconds = created,
        activityAtSeconds = activity,
    )
}
