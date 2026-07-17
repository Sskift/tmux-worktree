package com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AndroidAgentTranscriptLifecycleNotificationPlatformTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()

    @Test
    fun postsPrivateContentFreeFixedTitlesWithStableTagsAndOneChannel() {
        val system = FakeNotificationSystem()
        val platform = AndroidAgentTranscriptLifecycleNotificationPlatform(context, system)
        val cases = listOf(
            AgentLifecycleState.WAITING_FOR_USER to "Agent is waiting for you",
            AgentLifecycleState.FAILED to "Agent failed",
            AgentLifecycleState.COMPLETED to "Agent completed",
        )

        cases.forEachIndexed { index, (state, expectedTitle) ->
            val ticket = ticket(state, claimId = "claim-${index + 1}")

            assertEquals(
                AgentTranscriptLifecycleNotificationPlatformResult.Posted,
                platform.post(ticket),
            )

            val posted = system.postedNotifications.last()
            assertEquals(ticket.claimId, posted.tag)
            assertEquals(expectedTitle, posted.notification.extras.getCharSequence(
                Notification.EXTRA_TITLE,
            ).toString())
            assertEquals(Notification.VISIBILITY_PRIVATE, posted.notification.visibility)
            assertEquals(Notification.CATEGORY_STATUS, posted.notification.category)
            assertNull(posted.notification.extras.getCharSequence(Notification.EXTRA_TEXT))
            assertNull(posted.notification.extras.getCharSequence(Notification.EXTRA_BIG_TEXT))
            assertNull(posted.notification.extras.getCharSequence(Notification.EXTRA_SUB_TEXT))
            assertNull(posted.notification.extras.getCharSequence(Notification.EXTRA_INFO_TEXT))
            assertNull(posted.notification.extras.getCharSequence(Notification.EXTRA_SUMMARY_TEXT))
            assertNull(posted.notification.tickerText)
            assertNull(posted.notification.publicVersion)
            assertNull(posted.notification.fullScreenIntent)
            assertNotNull(posted.notification.contentIntent)
            assertTrue(posted.notification.actions.isNullOrEmpty())
            assertFalse(posted.notification.extras.toString().contains(SENSITIVE_SENTINEL))
        }

        assertEquals(
            listOf("claim-1", "claim-2", "claim-3"),
            system.postedNotifications.map(PostedNotification::tag),
        )
        assertEquals(1, system.createChannelCalls)
        assertEquals(1, system.channels.size)
        val channel = system.channels.values.single()
        assertEquals(Notification.VISIBILITY_PRIVATE, channel.lockscreenVisibility)
        assertEquals(NotificationManager.IMPORTANCE_DEFAULT, channel.importance)
    }

    @Test
    fun permissionAndNotificationPolicyChangesFailClosedBeforeNotify() {
        val deniedSystem = FakeNotificationSystem(permissionGranted = false)
        val denied = AndroidAgentTranscriptLifecycleNotificationPlatform(context, deniedSystem)
            .post(ticket(AgentLifecycleState.WAITING_FOR_USER, "claim-permission"))
        assertEquals(
            AgentTranscriptLifecycleNotificationPlatformResult.Suppressed(
                AgentTranscriptLifecycleNotificationSuppressionReason.PERMISSION_DENIED,
            ),
            denied,
        )
        assertEquals(0, deniedSystem.notifyCalls)
        assertEquals(0, deniedSystem.createChannelCalls)

        val disabledSystem = FakeNotificationSystem(notificationsEnabled = false)
        val disabled = AndroidAgentTranscriptLifecycleNotificationPlatform(context, disabledSystem)
            .post(ticket(AgentLifecycleState.FAILED, "claim-disabled"))
        assertEquals(
            AgentTranscriptLifecycleNotificationPlatformResult.Suppressed(
                AgentTranscriptLifecycleNotificationSuppressionReason.NOTIFICATIONS_DISABLED,
            ),
            disabled,
        )
        assertEquals(0, disabledSystem.notifyCalls)
        assertEquals(0, disabledSystem.createChannelCalls)

        val channelDisabledSystem = FakeNotificationSystem().apply {
            channels[CHANNEL_ID] = NotificationChannel(
                CHANNEL_ID,
                "Agent lifecycle",
                NotificationManager.IMPORTANCE_NONE,
            )
        }
        val channelDisabled = AndroidAgentTranscriptLifecycleNotificationPlatform(
            context,
            channelDisabledSystem,
        ).post(ticket(AgentLifecycleState.FAILED, "claim-channel-disabled"))
        assertEquals(
            AgentTranscriptLifecycleNotificationPlatformResult.Suppressed(
                AgentTranscriptLifecycleNotificationSuppressionReason.CHANNEL_DISABLED,
            ),
            channelDisabled,
        )
        assertEquals(0, channelDisabledSystem.notifyCalls)
        assertEquals(0, channelDisabledSystem.createChannelCalls)

        val changedSystem = FakeNotificationSystem(
            enabledCheckResults = mutableListOf(true, false),
        )
        val changed = AndroidAgentTranscriptLifecycleNotificationPlatform(context, changedSystem)
            .post(ticket(AgentLifecycleState.COMPLETED, "claim-policy-changed"))
        assertEquals(
            AgentTranscriptLifecycleNotificationPlatformResult.Suppressed(
                AgentTranscriptLifecycleNotificationSuppressionReason.NOTIFICATIONS_DISABLED,
            ),
            changed,
        )
        assertEquals(0, changedSystem.notifyCalls)
        assertEquals(1, changedSystem.createChannelCalls)

        val unsupportedSystem = FakeNotificationSystem()
        val unsupported = AndroidAgentTranscriptLifecycleNotificationPlatform(
            context,
            unsupportedSystem,
        ).post(ticket(AgentLifecycleState.RUNNING, "claim-running"))
        assertEquals(
            AgentTranscriptLifecycleNotificationPlatformResult.Suppressed(
                AgentTranscriptLifecycleNotificationSuppressionReason
                    .UNSUPPORTED_LIFECYCLE_STATE,
            ),
            unsupported,
        )
        assertEquals(0, unsupportedSystem.notifyCalls)
        assertEquals(0, unsupportedSystem.createChannelCalls)
    }

    @Test
    fun notifyFailureIsExplicitClosedAndDoesNotExposeTicketOrExceptionContent() {
        val failureText = "entry-text-failure-summary-cwd-terminal-bytes"
        val system = FakeNotificationSystem(notifyFailure = IllegalStateException(failureText))
        val ticket = ticket(AgentLifecycleState.FAILED, "claim-failed-post")

        val result = AndroidAgentTranscriptLifecycleNotificationPlatform(context, system)
            .post(ticket)

        assertEquals(
            AgentTranscriptLifecycleNotificationPlatformResult.Failed(
                AgentTranscriptLifecycleNotificationPlatformFailureReason.NOTIFY_FAILED,
            ),
            result,
        )
        assertEquals(1, system.notifyCalls)
        assertTrue(system.postedNotifications.isEmpty())
        assertFalse(result.toString().contains(failureText))
        assertFalse(result.toString().contains(ticket.claimId))
        assertFalse(result.toString().contains(ticket.namespace.consumer.sessionId))
    }

    private fun ticket(
        state: AgentLifecycleState,
        claimId: String,
    ): AgentTranscriptLifecycleNotificationExecutionTicket {
        val consumer = AgentTranscriptLifecycleDurableConsumerIdentity(
            profileId = "profile-$SENSITIVE_SENTINEL",
            profileActivationGeneration = 1,
            principalId = "principal-$SENSITIVE_SENTINEL",
            clientInstanceId = "client-$SENSITIVE_SENTINEL",
            hostId = "host-$SENSITIVE_SENTINEL",
            hostEpoch = "host-epoch-$SENSITIVE_SENTINEL",
            scopeId = "scope-$SENSITIVE_SENTINEL",
            sessionId = "session-$SENSITIVE_SENTINEL",
        )
        val timelineEpoch = "timeline-$SENSITIVE_SENTINEL"
        return AgentTranscriptLifecycleNotificationExecutionTicket(
            claimId = claimId,
            namespace = AgentTranscriptLifecycleDurableNamespace(consumer, timelineEpoch),
            intent = AgentSystemNotificationIntent(
                AgentNotificationDedupeKey(
                    profileId = consumer.profileId,
                    hostId = consumer.hostId,
                    hostEpoch = consumer.hostEpoch,
                    scopeId = consumer.scopeId,
                    sessionId = consumer.sessionId,
                    timelineEpoch = timelineEpoch,
                    lifecycleEventId = "event-$state-$SENSITIVE_SENTINEL",
                    state = state,
                ),
                localGeneration = "1",
            ),
        )
    }

    private class FakeNotificationSystem(
        var permissionGranted: Boolean = true,
        var notificationsEnabled: Boolean = true,
        private val enabledCheckResults: MutableList<Boolean> = mutableListOf(),
        private val notifyFailure: RuntimeException? = null,
    ) : AndroidAgentTranscriptLifecycleNotificationSystem {
        val channels = linkedMapOf<String, NotificationChannel>()
        val postedNotifications = mutableListOf<PostedNotification>()
        var createChannelCalls = 0
            private set
        var notifyCalls = 0
            private set

        override fun hasPostNotificationsPermission(): Boolean = permissionGranted

        override fun areNotificationsEnabled(): Boolean =
            if (enabledCheckResults.isNotEmpty()) {
                enabledCheckResults.removeAt(0)
            } else {
                notificationsEnabled
            }

        override fun getNotificationChannel(channelId: String): NotificationChannel? =
            channels[channelId]

        override fun createNotificationChannel(channel: NotificationChannel) {
            createChannelCalls += 1
            channels.putIfAbsent(channel.id, channel)
        }

        override fun notify(tag: String, notificationId: Int, notification: Notification) {
            notifyCalls += 1
            notifyFailure?.let { throw it }
            postedNotifications += PostedNotification(tag, notificationId, notification)
        }
    }

    private data class PostedNotification(
        val tag: String,
        val notificationId: Int,
        val notification: Notification,
    )

    private companion object {
        const val CHANNEL_ID = "agent_transcript_lifecycle_v1"
        const val SENSITIVE_SENTINEL = "DO_NOT_LEAK_WIRE_CONTENT"
    }
}
