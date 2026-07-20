package com.tmuxworktree.mobile.app

import com.tmuxworktree.mobile.core.data.AppPreferences
import com.tmuxworktree.mobile.core.model.AgentState
import com.tmuxworktree.mobile.core.model.ConnectionHealth
import com.tmuxworktree.mobile.core.model.RelayHost
import com.tmuxworktree.mobile.core.model.RelayScope
import com.tmuxworktree.mobile.core.model.RelaySession
import com.tmuxworktree.mobile.core.model.TerminalStreamState
import com.tmuxworktree.mobile.core.model.TimelineEvent

enum class RelayStartupAdmissionState {
    CHECKING,
    RELAY_V1,
    RELAY_V2,
    RELAY_V2_REENROLLMENT_REQUIRED,
    RELAY_V2_RECOVERY_REQUIRED,
    RELAY_V2_CREDENTIAL_MISSING,
    RELAY_V2_CREDENTIAL_BINDING_MISMATCH,
    RELAY_V2_CREDENTIAL_BLOB_BEHIND,
    RELAY_V2_CREDENTIAL_REPAIR_CONFLICT,
    RELAY_V2_ADMISSION_FAILED,
}

/** Explicit Relay v2 profile connection state; this is not product readiness or a capability. */
enum class RelayV2ProfileConnectionState {
    STOPPED,
    CONNECTING,
    RESYNCING,
    ONLINE,
    FAILED,
}

data class V2UiState(
    val relayStartupAdmission: RelayStartupAdmissionState = RelayStartupAdmissionState.CHECKING,
    val relayV2ProfileConnection: RelayV2ProfileConnectionState =
        RelayV2ProfileConnectionState.STOPPED,
    val relayV2ProfileFailureCode: String? = null,
    val initialized: Boolean = false,
    val demoMode: Boolean = false,
    val networkAvailable: Boolean = true,
    val paired: Boolean = false,
    val pairingRequired: Boolean = false,
    val pairingRelayUrl: String = "",
    val pairingToken: String = "",
    val pairingHostId: String = "",
    val pairingRelayUrlError: String? = null,
    val pairingError: String? = null,
    val confirmProfileSwitch: Boolean = false,
    val isConnecting: Boolean = false,
    val preferences: AppPreferences = AppPreferences(),
    val hosts: List<RelayHost> = emptyList(),
    val scopes: List<RelayScope> = emptyList(),
    val sessions: List<RelaySession> = emptyList(),
    val health: ConnectionHealth = ConnectionHealth(),
    val terminal: TerminalStreamState = TerminalStreamState(),
    val drafts: Map<String, String> = emptyMap(),
    val selectedScopeId: String? = null,
    val creatingWorktree: Boolean = false,
    val creatingTerminal: Boolean = false,
    val actionError: String? = null,
    val demoTimelines: Map<String, List<TimelineEvent>> = emptyMap(),
) {
    val activeHostId: String
        get() {
            val preferred = preferences.preferredHostId
            return hosts.firstOrNull { it.hostId == preferred }?.hostId
                ?: hosts.firstOrNull()?.hostId
                // Keep the saved identity while the cache is still loading. As
                // soon as a non-empty host snapshot arrives, a missing saved host
                // falls back to a real row instead of filtering every screen empty.
                ?: preferred
        }

    val activeSessions: List<RelaySession>
        get() = activeHostId.takeIf(String::isNotBlank)?.let { hostId ->
            sessions.filter { it.hostId == hostId }
        } ?: sessions

    val attentionCount: Int
        get() = activeSessions.count {
            it.agentState == AgentState.WAITING_FOR_USER || it.agentState == AgentState.FAILED
        }

    val hasStoredProfile: Boolean
        get() = preferences.relayUrl.isNotBlank() || hosts.isNotEmpty() ||
            scopes.isNotEmpty() || sessions.isNotEmpty()

    fun session(stableId: String): RelaySession? = sessions.firstOrNull { it.stableId == stableId }

    // State may be captured by a crash reporter or debugger through toString().
    // Never include the in-memory review token or the unvalidated imported URL.
    override fun toString(): String =
        "V2UiState(" +
            "initialized=$initialized, demoMode=$demoMode, networkAvailable=$networkAvailable, " +
            "paired=$paired, pairingRequired=$pairingRequired, pairingInput=<redacted>, " +
            "relayV2ProfileConnection=$relayV2ProfileConnection, " +
            "isConnecting=$isConnecting, hosts=${hosts.size}, scopes=${scopes.size}, " +
            "sessions=${sessions.size}, health=$health)"
}

data class NewWorktreeRequest(
    val hostId: String,
    val scopeId: String,
    val project: String,
    val path: String,
    val name: String,
    val branch: String,
    val aiCommand: String,
)

sealed interface V2UiEffect {
    data class NavigateToSession(val sessionId: String) : V2UiEffect
    data class NavigateToTerminal(val sessionId: String) : V2UiEffect
    data class TerminalReset(val message: String = "") : V2UiEffect
    data class TerminalWrite(val data: String) : V2UiEffect
    data object ProfileCleared : V2UiEffect
    data class Notice(val message: String) : V2UiEffect
}
