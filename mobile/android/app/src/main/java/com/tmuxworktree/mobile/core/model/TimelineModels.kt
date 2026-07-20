package com.tmuxworktree.mobile.core.model

enum class TimelineActor {
    AGENT,
    USER,
    SYSTEM,
}

enum class AgentEvidenceAvailability {
    AVAILABLE,
    RELAY_V1_UNSUPPORTED,
    RELAY_V2_UNAVAILABLE,
}

data class TimelineEvent(
    val eventId: String,
    val sessionId: String,
    val actor: TimelineActor,
    val body: String,
    val createdAtMillis: Long,
    val code: String = "",
    val deliveryState: DeliveryState? = null,
)

data class SessionTimelineState(
    val events: List<TimelineEvent>,
    val agentEvidenceAvailability: AgentEvidenceAvailability,
)
