package com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1

/** Narrow platform boundary reached only with post-commit durable claim authority. */
internal fun interface AgentTranscriptLifecycleNotificationPlatformPort {
    fun post(
        ticket: AgentTranscriptLifecycleNotificationExecutionTicket,
    ): AgentTranscriptLifecycleNotificationPlatformResult
}

internal enum class AgentTranscriptLifecycleNotificationSuppressionReason {
    PERMISSION_DENIED,
    NOTIFICATIONS_DISABLED,
    CHANNEL_DISABLED,
    UNSUPPORTED_LIFECYCLE_STATE,
}

internal enum class AgentTranscriptLifecycleNotificationPlatformFailureReason {
    PLATFORM_STATE_CHECK_FAILED,
    CHANNEL_SETUP_FAILED,
    NOTIFICATION_BUILD_FAILED,
    NOTIFY_FAILED,
}

/** Closed platform result. No variant carries notification content or exception text. */
internal sealed interface AgentTranscriptLifecycleNotificationPlatformResult {
    data object Posted : AgentTranscriptLifecycleNotificationPlatformResult

    data class Suppressed(
        val reason: AgentTranscriptLifecycleNotificationSuppressionReason,
    ) : AgentTranscriptLifecycleNotificationPlatformResult

    data class Failed(
        val reason: AgentTranscriptLifecycleNotificationPlatformFailureReason,
    ) : AgentTranscriptLifecycleNotificationPlatformResult
}

internal object AgentTranscriptLifecycleDisabledNotificationPlatform :
    AgentTranscriptLifecycleNotificationPlatformPort {
    override fun post(
        ticket: AgentTranscriptLifecycleNotificationExecutionTicket,
    ): AgentTranscriptLifecycleNotificationPlatformResult =
        AgentTranscriptLifecycleNotificationPlatformResult.Suppressed(
            AgentTranscriptLifecycleNotificationSuppressionReason.NOTIFICATIONS_DISABLED,
        )
}

internal enum class AgentTranscriptLifecycleNotificationExecutionFailureReason {
    PLATFORM_CALL_FAILED,
}

/**
 * Terminal result for one already-consumed claim attempt.
 *
 * Suppression and failure are intentionally not retry instructions: the durable claim remains the
 * sole one-shot owner, including when Android permission or notification policy changes.
 */
internal sealed interface AgentTranscriptLifecycleNotificationExecutionResult {
    data class NotExecutable(
        val reason: AgentTranscriptLifecycleNotificationNotExecutableReason,
    ) : AgentTranscriptLifecycleNotificationExecutionResult

    data class Platform(
        val result: AgentTranscriptLifecycleNotificationPlatformResult,
    ) : AgentTranscriptLifecycleNotificationExecutionResult

    data class Failed(
        val reason: AgentTranscriptLifecycleNotificationExecutionFailureReason,
    ) : AgentTranscriptLifecycleNotificationExecutionResult
}

/**
 * Converts durable claim results into at most one platform call.
 *
 * This class owns no dedupe state. In particular, [NotExecutable] never reaches the platform, and
 * an unexpected platform exception is closed without exposing its message or the ticket.
 */
internal class AgentTranscriptLifecycleNotificationExecutor(
    private val platform: AgentTranscriptLifecycleNotificationPlatformPort,
) {
    fun execute(
        claimResult: AgentTranscriptLifecycleNotificationClaimResult,
    ): AgentTranscriptLifecycleNotificationExecutionResult = when (claimResult) {
        is AgentTranscriptLifecycleNotificationClaimResult.NotExecutable ->
            AgentTranscriptLifecycleNotificationExecutionResult.NotExecutable(claimResult.reason)

        is AgentTranscriptLifecycleNotificationClaimResult.Claimed -> try {
            AgentTranscriptLifecycleNotificationExecutionResult.Platform(
                platform.post(claimResult.ticket),
            )
        } catch (_: RuntimeException) {
            AgentTranscriptLifecycleNotificationExecutionResult.Failed(
                AgentTranscriptLifecycleNotificationExecutionFailureReason.PLATFORM_CALL_FAILED,
            )
        }
    }
}
