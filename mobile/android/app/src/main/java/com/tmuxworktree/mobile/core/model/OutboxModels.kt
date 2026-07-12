package com.tmuxworktree.mobile.core.model

enum class DeliveryState {
    QUEUED,
    SENDING,
    ACCEPTED,
    SUCCEEDED,
    CONFIRMING,
    FAILED_RETRYABLE,
    FAILED_FINAL,
    EXPIRED,
    CANCELLED,
    AMBIGUOUS,
}

data class OutboxMessage(
    val commandId: String,
    val requestId: String,
    val hostId: String,
    val sessionName: String,
    val body: String,
    val createdAtMillis: Long,
    val expiresAtMillis: Long,
    val state: DeliveryState = DeliveryState.QUEUED,
    val attemptCount: Int = 0,
    val lastError: String = "",
)
