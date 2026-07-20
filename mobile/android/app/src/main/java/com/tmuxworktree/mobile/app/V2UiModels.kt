package com.tmuxworktree.mobile.app

import com.tmuxworktree.mobile.core.data.AppPreferences
import com.tmuxworktree.mobile.core.model.AgentState
import com.tmuxworktree.mobile.core.model.ConnectionHealth
import com.tmuxworktree.mobile.core.model.ConnectionStatus
import com.tmuxworktree.mobile.core.model.RelayHost
import com.tmuxworktree.mobile.core.model.RelayScope
import com.tmuxworktree.mobile.core.model.RelaySession
import com.tmuxworktree.mobile.core.model.TerminalStreamState
import com.tmuxworktree.mobile.core.model.TimelineEvent
import com.tmuxworktree.mobile.core.model.TransportPhase
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2BaseRuntimeFailure
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2BaseRuntimePhase
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2BaseRuntimeState

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

/**
 * The UI submits a normalized body but keeps its original draft text. Capture that original text
 * before sending, then remove it only if no byte of the draft changed while Room was committing.
 */
internal fun V2UiState.afterCommittedReply(
    sessionId: String,
    submittedRawDraft: String?,
): V2UiState = copy(
    drafts = if (submittedRawDraft != null && drafts[sessionId] == submittedRawDraft) {
        drafts - sessionId
    } else {
        drafts
    },
    actionError = null,
)

internal data class RelayV2ReplyUiCallbackFence(
    val composition: Any,
    val sessionStableId: String,
    val sessionCut: Any,
)

internal fun RelayV2ReplyUiCallbackFence.isCurrent(
    state: V2UiState,
    currentComposition: Any?,
    currentCuts: Map<String, *>,
): Boolean = state.relayStartupAdmission == RelayStartupAdmissionState.RELAY_V2 &&
    currentComposition === composition &&
    currentCuts[sessionStableId] === sessionCut

internal data class RelayV2ReplyUiMutation(
    val state: V2UiState,
    val applied: Boolean,
)

internal inline fun RelayV2ReplyUiCallbackFence.applyIfCurrent(
    state: V2UiState,
    currentComposition: Any?,
    currentCuts: Map<String, *>,
    update: (V2UiState) -> V2UiState,
): RelayV2ReplyUiMutation = if (isCurrent(state, currentComposition, currentCuts)) {
    RelayV2ReplyUiMutation(update(state), true)
} else {
    RelayV2ReplyUiMutation(state, false)
}

/** Injective local route/list identity; no caller parses it back into Relay wire identity. */
internal fun relayV2SessionUiStableId(vararg opaqueParts: String): String = buildString {
    append("relay-v2-session")
    opaqueParts.forEach { part ->
        append(':')
        append(part.length)
        append(':')
        append(part)
    }
}

internal const val RELAY_V2_TRANSPORT_LABEL = "Relay v2 transport"

internal fun projectRelayV2RuntimeState(
    state: V2UiState,
    runtime: RelayV2BaseRuntimeState,
    nowMillis: Long,
): V2UiState {
    val connection = when (runtime.phase) {
        RelayV2BaseRuntimePhase.STOPPED -> RelayV2ProfileConnectionState.STOPPED
        RelayV2BaseRuntimePhase.CONNECTING -> RelayV2ProfileConnectionState.CONNECTING
        RelayV2BaseRuntimePhase.RESYNCING -> RelayV2ProfileConnectionState.RESYNCING
        RelayV2BaseRuntimePhase.ONLINE -> RelayV2ProfileConnectionState.ONLINE
        RelayV2BaseRuntimePhase.FAILED -> RelayV2ProfileConnectionState.FAILED
    }
    val hostStatus = when (connection) {
        RelayV2ProfileConnectionState.STOPPED,
        RelayV2ProfileConnectionState.FAILED,
        -> ConnectionStatus.OFFLINE
        RelayV2ProfileConnectionState.CONNECTING -> ConnectionStatus.CONNECTING
        RelayV2ProfileConnectionState.RESYNCING -> ConnectionStatus.RECOVERING
        RelayV2ProfileConnectionState.ONLINE -> ConnectionStatus.ONLINE
    }
    val failureCode = when (val failure = runtime.failure) {
        is RelayV2BaseRuntimeFailure.Connection -> failure.failure.code
        is RelayV2BaseRuntimeFailure.RuntimeIncomplete -> failure.code
        null -> ""
    }
    val health = ConnectionHealth(
        phase = when (connection) {
            RelayV2ProfileConnectionState.STOPPED,
            RelayV2ProfileConnectionState.FAILED,
            -> TransportPhase.STOPPED
            RelayV2ProfileConnectionState.CONNECTING -> TransportPhase.CONNECTING
            RelayV2ProfileConnectionState.RESYNCING -> TransportPhase.HANDSHAKING
            RelayV2ProfileConnectionState.ONLINE -> TransportPhase.ONLINE
        },
        overall = hostStatus,
        lastSyncedAtMillis = if (connection == RelayV2ProfileConnectionState.ONLINE) {
            nowMillis
        } else {
            state.health.lastSyncedAtMillis
        },
        errorCode = failureCode,
        errorMessage = if (connection == RelayV2ProfileConnectionState.FAILED) {
            "Relay v2 transport failed; full v2 capability readiness is not advertised"
        } else {
            ""
        },
        protocolLabel = RELAY_V2_TRANSPORT_LABEL,
    )
    return state.copy(
        relayV2ProfileConnection = connection,
        relayV2ProfileFailureCode = failureCode.ifBlank { null },
        isConnecting = connection == RelayV2ProfileConnectionState.CONNECTING,
        pairingError = failureCode.takeIf(String::isNotBlank)?.let { code ->
            "Relay v2 transport failed ($code); Relay v1 fallback is disabled."
        },
        hosts = state.hosts.map { host ->
            host.copy(
                status = hostStatus,
                lastSeenAtMillis = if (hostStatus == ConnectionStatus.ONLINE) {
                    nowMillis
                } else {
                    host.lastSeenAtMillis
                },
            )
        },
        health = health,
    )
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
