package com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import com.tmuxworktree.mobile.R
import com.tmuxworktree.mobile.V2Activity
import java.util.concurrent.CancellationException

/** Android system-notification adapter for post-commit Agent lifecycle claim tickets. */
internal class AndroidAgentTranscriptLifecycleNotificationPlatform(
    context: Context,
    private val system: AndroidAgentTranscriptLifecycleNotificationSystem =
        AndroidAgentTranscriptLifecycleNotificationSystemAdapter(context.applicationContext),
) : AgentTranscriptLifecycleNotificationPlatformPort {
    private val applicationContext = context.applicationContext

    override fun post(
        ticket: AgentTranscriptLifecycleNotificationExecutionTicket,
    ): AgentTranscriptLifecycleNotificationPlatformResult = try {
        postChecked(ticket)
    } catch (_: SecurityException) {
        suppressed(AgentTranscriptLifecycleNotificationSuppressionReason.PERMISSION_DENIED)
    } catch (_: RuntimeException) {
        failed(
            AgentTranscriptLifecycleNotificationPlatformFailureReason.PLATFORM_STATE_CHECK_FAILED,
        )
    }

    override fun cancel(
        identity: AgentTranscriptLifecyclePostedNotificationIdentity,
    ): AgentTranscriptLifecycleNotificationCancellationPlatformResult = try {
        system.cancel(identity.claimId, NOTIFICATION_ID)
        AgentTranscriptLifecycleNotificationCancellationPlatformResult.Cancelled
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (_: SecurityException) {
        AgentTranscriptLifecycleNotificationCancellationPlatformResult.Failed
    } catch (_: RuntimeException) {
        AgentTranscriptLifecycleNotificationCancellationPlatformResult.Failed
    }

    private fun postChecked(
        ticket: AgentTranscriptLifecycleNotificationExecutionTicket,
    ): AgentTranscriptLifecycleNotificationPlatformResult {
        val title = titleFor(ticket.intent.dedupeKey.state)
            ?: return suppressed(
                AgentTranscriptLifecycleNotificationSuppressionReason
                    .UNSUPPORTED_LIFECYCLE_STATE,
            )
        if (!system.hasPostNotificationsPermission()) {
            return suppressed(
                AgentTranscriptLifecycleNotificationSuppressionReason.PERMISSION_DENIED,
            )
        }
        if (!system.areNotificationsEnabled()) {
            return suppressed(
                AgentTranscriptLifecycleNotificationSuppressionReason.NOTIFICATIONS_DISABLED,
            )
        }

        val channel = try {
            ensureChannel()
        } catch (_: SecurityException) {
            return suppressed(
                AgentTranscriptLifecycleNotificationSuppressionReason.PERMISSION_DENIED,
            )
        } catch (_: RuntimeException) {
            return failed(
                AgentTranscriptLifecycleNotificationPlatformFailureReason.CHANNEL_SETUP_FAILED,
            )
        }
        if (channel.importance == NotificationManager.IMPORTANCE_NONE) {
            return suppressed(
                AgentTranscriptLifecycleNotificationSuppressionReason.CHANNEL_DISABLED,
            )
        }

        // Recheck immediately before building/posting so a runtime policy change consumes the
        // durable claim without accidentally posting or creating a retry lane.
        if (!system.hasPostNotificationsPermission()) {
            return suppressed(
                AgentTranscriptLifecycleNotificationSuppressionReason.PERMISSION_DENIED,
            )
        }
        if (!system.areNotificationsEnabled()) {
            return suppressed(
                AgentTranscriptLifecycleNotificationSuppressionReason.NOTIFICATIONS_DISABLED,
            )
        }

        val notification = try {
            buildNotification(title)
        } catch (_: RuntimeException) {
            return failed(
                AgentTranscriptLifecycleNotificationPlatformFailureReason.NOTIFICATION_BUILD_FAILED,
            )
        }
        return try {
            system.notify(ticket.claimId, NOTIFICATION_ID, notification)
            AgentTranscriptLifecycleNotificationPlatformResult.Posted
        } catch (_: SecurityException) {
            suppressed(
                AgentTranscriptLifecycleNotificationSuppressionReason.PERMISSION_DENIED,
            )
        } catch (_: RuntimeException) {
            failed(AgentTranscriptLifecycleNotificationPlatformFailureReason.NOTIFY_FAILED)
        }
    }

    private fun ensureChannel(): NotificationChannel {
        system.getNotificationChannel(CHANNEL_ID)?.let { return it }
        val requested = NotificationChannel(
            CHANNEL_ID,
            applicationContext.getString(R.string.agent_lifecycle_notification_channel_name),
            NotificationManager.IMPORTANCE_DEFAULT,
        ).apply {
            description = applicationContext.getString(
                R.string.agent_lifecycle_notification_channel_description,
            )
            lockscreenVisibility = Notification.VISIBILITY_PRIVATE
        }
        system.createNotificationChannel(requested)
        return system.getNotificationChannel(CHANNEL_ID)
            ?: throw IllegalStateException("Agent lifecycle notification channel was not created")
    }

    private fun buildNotification(title: String): Notification = Notification.Builder(
        applicationContext,
        CHANNEL_ID,
    )
        .setSmallIcon(R.drawable.ic_agent_lifecycle_notification)
        .setContentTitle(title)
        .setContentIntent(contentIntent())
        .setCategory(Notification.CATEGORY_STATUS)
        .setVisibility(Notification.VISIBILITY_PRIVATE)
        .setAutoCancel(true)
        .setOnlyAlertOnce(true)
        .build()

    private fun contentIntent(): PendingIntent {
        val launchIntent = Intent(applicationContext, V2Activity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        return PendingIntent.getActivity(
            applicationContext,
            CONTENT_INTENT_REQUEST_CODE,
            launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun titleFor(state: AgentLifecycleState): String? = when (state) {
        AgentLifecycleState.WAITING_FOR_USER -> applicationContext.getString(
            R.string.agent_lifecycle_notification_waiting_title,
        )
        AgentLifecycleState.FAILED -> applicationContext.getString(
            R.string.agent_lifecycle_notification_failed_title,
        )
        AgentLifecycleState.COMPLETED -> applicationContext.getString(
            R.string.agent_lifecycle_notification_completed_title,
        )
        AgentLifecycleState.RUNNING -> null
    }

    private fun suppressed(
        reason: AgentTranscriptLifecycleNotificationSuppressionReason,
    ) = AgentTranscriptLifecycleNotificationPlatformResult.Suppressed(reason)

    private fun failed(
        reason: AgentTranscriptLifecycleNotificationPlatformFailureReason,
    ) = AgentTranscriptLifecycleNotificationPlatformResult.Failed(reason)

    private companion object {
        const val CHANNEL_ID = "agent_transcript_lifecycle_v1"
        const val NOTIFICATION_ID = 1
        const val CONTENT_INTENT_REQUEST_CODE = 0
    }
}

/** Small injectable surface around the Android APIs, used only to verify the adapter boundary. */
internal interface AndroidAgentTranscriptLifecycleNotificationSystem {
    fun hasPostNotificationsPermission(): Boolean

    fun areNotificationsEnabled(): Boolean

    fun getNotificationChannel(channelId: String): NotificationChannel?

    fun createNotificationChannel(channel: NotificationChannel)

    fun notify(tag: String, notificationId: Int, notification: Notification)

    fun cancel(tag: String, notificationId: Int) {
        throw UnsupportedOperationException("Notification cancellation is not installed")
    }
}

/** Canonical platform interpretation of the POST_NOTIFICATIONS runtime permission. */
internal object AndroidAgentTranscriptLifecycleNotificationPermission {
    fun isGranted(context: Context): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED

    fun requiresRuntimeRequest(): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
}

private class AndroidAgentTranscriptLifecycleNotificationSystemAdapter(
    private val context: Context,
) : AndroidAgentTranscriptLifecycleNotificationSystem {
    private val manager = context.getSystemService(NotificationManager::class.java)

    override fun hasPostNotificationsPermission(): Boolean =
        AndroidAgentTranscriptLifecycleNotificationPermission.isGranted(context)

    override fun areNotificationsEnabled(): Boolean = manager.areNotificationsEnabled()

    override fun getNotificationChannel(channelId: String): NotificationChannel? =
        manager.getNotificationChannel(channelId)

    override fun createNotificationChannel(channel: NotificationChannel) {
        manager.createNotificationChannel(channel)
    }

    override fun notify(tag: String, notificationId: Int, notification: Notification) {
        manager.notify(tag, notificationId, notification)
    }

    override fun cancel(tag: String, notificationId: Int) {
        manager.cancel(tag, notificationId)
    }
}
