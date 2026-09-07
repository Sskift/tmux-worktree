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
