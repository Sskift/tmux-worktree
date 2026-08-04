package com.tmuxworktree.mobile.designsystem

internal fun relativeTimeFromSeconds(timestampSeconds: Long, nowMillis: Long): String {
    if (timestampSeconds <= 0L) return ""
    return relativeTime(timestampSeconds * 1_000L, nowMillis)
}

internal fun relativeTime(timestampMillis: Long, nowMillis: Long): String {
    val seconds = ((nowMillis - timestampMillis).coerceAtLeast(0L) / 1_000L)
    return when {
        seconds < 60L -> "now"
        seconds < 3_600L -> "${seconds / 60L}m"
        seconds < 86_400L -> "${seconds / 3_600L}h"
        else -> "${seconds / 86_400L}d"
    }
}

internal fun relativeTimeDescription(timestampMillis: Long, nowMillis: Long): String {
    val short = relativeTime(timestampMillis, nowMillis)
    return if (short == "now") "just now" else "$short ago"
}

internal fun relativeTimeDescriptionFromSeconds(timestampSeconds: Long, nowMillis: Long): String {
    if (timestampSeconds <= 0L) return "recently"
    return relativeTimeDescription(timestampSeconds * 1_000L, nowMillis)
}
