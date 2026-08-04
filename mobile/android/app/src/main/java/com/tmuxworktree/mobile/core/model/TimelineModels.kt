package com.tmuxworktree.mobile.core.model

enum class TimelineActor {
    AGENT,
    USER,
    SYSTEM,
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
