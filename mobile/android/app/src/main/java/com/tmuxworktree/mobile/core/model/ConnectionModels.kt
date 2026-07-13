package com.tmuxworktree.mobile.core.model

enum class ConnectionStatus {
    ONLINE,
    RECOVERING,
    PAUSED,
    OFFLINE,
    CONNECTING,
    AUTH_REQUIRED,
    INCOMPATIBLE,
    UNKNOWN,
}

enum class TransportPhase {
    STOPPED,
    WAITING_FOR_NETWORK,
    CONNECTING,
    HANDSHAKING,
    ONLINE,
    BACKING_OFF,
    AUTH_REQUIRED,
    INCOMPATIBLE,
}

data class RelayProfile(
    val relayUrl: String = "",
    val hostId: String = "",
    val autoConnect: Boolean = false,
    val hasCredential: Boolean = false,
)

data class RelayHost(
    val hostId: String,
    val displayName: String = hostId,
    val clients: Int = 0,
    val status: ConnectionStatus = ConnectionStatus.ONLINE,
    val lastSeenAtMillis: Long = 0,
)

data class RelayScope(
    val hostId: String,
    val scopeId: String,
    val label: String = scopeId,
    val kind: String = "local",
    val reachable: Boolean = true,
    val sessionCount: Int = 0,
    val error: String = "",
) {
    val stableId: String get() = "$hostId:$scopeId"
}

data class HealthLayer(
    val id: String,
    val label: String,
    val status: ConnectionStatus,
    val detail: String,
    val lastSuccessAtMillis: Long = 0,
)

data class ConnectionHealth(
    val phase: TransportPhase = TransportPhase.STOPPED,
    val overall: ConnectionStatus = ConnectionStatus.UNKNOWN,
    val layers: List<HealthLayer> = emptyList(),
    val retryAtMillis: Long? = null,
    val attempt: Int = 0,
    val lastSyncedAtMillis: Long = 0,
    val errorCode: String = "",
    val errorMessage: String = "",
    val protocolLabel: String = "v1 compatibility mode",
)

data class TerminalStreamState(
    val streamId: String? = null,
    val sessionId: String = "",
    val status: ConnectionStatus = ConnectionStatus.OFFLINE,
    val generation: Long = 0,
    val lastOutputSequence: Long = 0,
    val resetReason: String = "",
    val inputReadOnly: Boolean = false,
)
