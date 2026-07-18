package com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1

import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2EffectApplyResult
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2EffectGeneration
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2RepositoryEffectApplyLeasePort
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2RepositoryEffectAuthority
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class AgentTranscriptLifecycleNotificationDispatchCoordinatorTest {
    @Test
    fun `claim commits then exact ticket dispatch completes before apply lease release`() =
        runBlocking {
            val fixture = fixture()
            val order = mutableListOf<String>()
            val lease = FakeApplyLease(order)
            val claims = RecordingClaimPort(lease, order) { namespace, intent ->
                AgentTranscriptLifecycleNotificationClaimResult.Claimed(
                    fixture.ticket.copy(namespace = namespace, intent = intent),
                )
            }
            val platform = RecordingPlatform(lease, order) {
                AgentTranscriptLifecycleNotificationPlatformResult.Posted
            }
            val coordinator = coordinator(lease, claims, platform)

            val result = coordinator.dispatch(fixture.request)

            assertEquals(
                AgentTranscriptLifecycleNotificationDispatchResult.Completed(
                    AgentTranscriptLifecycleNotificationExecutionResult.Platform(
                        AgentTranscriptLifecycleNotificationPlatformResult.Posted,
                    ),
                ),
                result,
            )
            assertEquals(
                listOf("lease-enter", "claim-committed", "platform", "lease-release"),
                order,
            )
            assertSame(fixture.authority, lease.observedAuthority)
            assertSame(fixture.namespace, claims.observedNamespace)
            assertSame(fixture.intent, claims.observedIntent)
            assertEquals(fixture.ticket.intent.dedupeKey, platform.tickets.single().intent.dedupeKey)
            assertEquals(fixture.ticket.namespace, platform.tickets.single().namespace)
        }

    @Test
    fun `withdrawn stale switch admission has zero claim and zero platform call`() = runBlocking {
        val fixture = fixture()

        run {
            val lease = FakeApplyLease(mutableListOf(), stale = true)
            val claims = RecordingClaimPort(lease, mutableListOf()) { _, _ ->
                error("withdrawn stale generation must not claim")
            }
            val platform = RecordingPlatform(lease, mutableListOf()) {
                error("withdrawn stale generation must not dispatch")
            }

            assertEquals(
                AgentTranscriptLifecycleNotificationDispatchResult.StaleGeneration,
                coordinator(lease, claims, platform).dispatch(fixture.request),
            )
            assertEquals(0, claims.calls)
            assertEquals(0, platform.calls)
        }

        val staleProfile = "profile-stale"
        val mismatches = listOf(
            "profile" to fixture.request.copy(
                authority = fixture.authority.copy(
                    generation = fixture.authority.generation.copy(profileId = staleProfile),
                    profileId = staleProfile,
                ),
            ),
            "timeline" to fixture.request.copy(
                expectedNamespace = fixture.namespace.copy(timelineEpoch = "timeline-stale"),
            ),
        )
        mismatches.forEach { (label, request) ->
            val lease = FakeApplyLease(mutableListOf())
            val claims = RecordingClaimPort(lease, mutableListOf()) { _, _ ->
                error("$label mismatch must not claim")
            }
            val platform = RecordingPlatform(lease, mutableListOf()) {
                error("$label mismatch must not dispatch")
            }

            assertEquals(
                label,
                AgentTranscriptLifecycleNotificationDispatchResult.Completed(
                    AgentTranscriptLifecycleNotificationExecutionResult.NotExecutable(
                        AgentTranscriptLifecycleNotificationNotExecutableReason.INTENT_NOT_CURRENT,
                    ),
                ),
                coordinator(lease, claims, platform).dispatch(request),
            )
            assertEquals(label, 0, lease.calls)
            assertEquals(label, 0, claims.calls)
            assertEquals(label, 0, platform.calls)
        }
    }

    @Test
    fun `claimed ticket must preserve the complete requested event identity`() = runBlocking {
        val fixture = fixture()
        val lease = FakeApplyLease(mutableListOf())
        val claims = RecordingClaimPort(lease, mutableListOf()) { _, _ ->
            AgentTranscriptLifecycleNotificationClaimResult.Claimed(
                fixture.ticket.copy(
                    intent = fixture.intent.copy(
                        dedupeKey = fixture.intent.dedupeKey.copy(
                            lifecycleEventId = "event-wrong-ticket",
                        ),
                    ),
                ),
            )
        }
        val platform = RecordingPlatform(lease, mutableListOf()) {
            error("a mismatched post-commit ticket must not dispatch")
        }

        val result = coordinator(lease, claims, platform).dispatch(fixture.request)

        assertEquals(
            AgentTranscriptLifecycleNotificationDispatchResult.Failed(
                AgentTranscriptLifecycleNotificationDispatchFailureReason.DURABLE_CLAIM_FAILED,
            ),
            result,
        )
        assertEquals(1, claims.calls)
        assertEquals(0, platform.calls)
    }

    @Test
    fun `not executable claim maps without a platform call`() = runBlocking {
        val fixture = fixture()
        val lease = FakeApplyLease(mutableListOf())
        val reason = AgentTranscriptLifecycleNotificationNotExecutableReason.ALREADY_CLAIMED
        val claims = RecordingClaimPort(lease, mutableListOf()) { _, _ ->
            AgentTranscriptLifecycleNotificationClaimResult.NotExecutable(reason)
        }
        val platform = RecordingPlatform(lease, mutableListOf()) {
            error("not-executable claim must not dispatch")
        }

        assertEquals(
            AgentTranscriptLifecycleNotificationDispatchResult.Completed(
                AgentTranscriptLifecycleNotificationExecutionResult.NotExecutable(reason),
            ),
            coordinator(lease, claims, platform).dispatch(fixture.request),
        )
        assertEquals(1, claims.calls)
        assertEquals(0, platform.calls)
    }

    @Test
    fun `claim exception maps to a content free failure without a platform call`() = runBlocking {
        val forbiddenDetail = "forbidden-claim-commit-entry-session-token"
        val fixture = fixture()
        val lease = FakeApplyLease(mutableListOf())
        val claims = RecordingClaimPort(lease, mutableListOf()) { _, _ ->
            throw IllegalStateException(forbiddenDetail)
        }
        val platform = RecordingPlatform(lease, mutableListOf()) {
            error("failed claim must not dispatch")
        }

        val result = coordinator(lease, claims, platform).dispatch(fixture.request)

        assertEquals(
            AgentTranscriptLifecycleNotificationDispatchResult.Failed(
                AgentTranscriptLifecycleNotificationDispatchFailureReason.DURABLE_CLAIM_FAILED,
            ),
            result,
        )
        assertEquals(0, platform.calls)
        assertFalse(result.toString().contains(forbiddenDetail))
        assertFalse(result.toString().contains(fixture.ticket.claimId))
        assertFalse(result.toString().contains(fixture.namespace.consumer.sessionId))
    }

    private fun coordinator(
        lease: RelayV2RepositoryEffectApplyLeasePort,
        claims: AgentTranscriptLifecycleNotificationClaimPort,
        platform: AgentTranscriptLifecycleNotificationPlatformPort,
    ) = AgentTranscriptLifecycleNotificationDispatchCoordinator(lease, claims, platform)

    private fun fixture(): Fixture {
        val consumer = AgentTranscriptLifecycleDurableConsumerIdentity(
            profileId = "profile-notification-dispatch",
            profileActivationGeneration = 7,
            principalId = "principal-notification-dispatch",
            clientInstanceId = "client-notification-dispatch",
            hostId = "host-notification-dispatch",
            hostEpoch = "host-epoch-notification-dispatch",
            scopeId = "scope-notification-dispatch",
            sessionId = "session-notification-dispatch",
        )
        val namespace = AgentTranscriptLifecycleDurableNamespace(
            consumer,
            "timeline-notification-dispatch",
        )
        val generation = RelayV2EffectGeneration(
            consumer.profileId,
            consumer.profileActivationGeneration,
            connectionGeneration = 11,
        )
        val authority = RelayV2RepositoryEffectAuthority(
            generation,
            consumer.profileId,
            consumer.profileActivationGeneration,
            consumer.principalId,
            consumer.clientInstanceId,
            consumer.hostId,
            consumer.hostEpoch,
        )
        val intent = AgentSystemNotificationIntent(
            AgentNotificationDedupeKey(
                consumer.profileId,
                consumer.hostId,
                consumer.hostEpoch,
                consumer.scopeId,
                consumer.sessionId,
                requireNotNull(namespace.timelineEpoch),
                "event-notification-dispatch",
                AgentLifecycleState.COMPLETED,
            ),
            localGeneration = "19",
        )
        val ticket = AgentTranscriptLifecycleNotificationExecutionTicket(
            claimId = "0123456789abcdef".repeat(4),
            namespace = namespace,
            intent = intent,
        )
        return Fixture(
            authority,
            namespace,
            intent,
            ticket,
            AgentTranscriptLifecycleNotificationDispatchRequest(authority, namespace, intent),
        )
    }

    private data class Fixture(
        val authority: RelayV2RepositoryEffectAuthority,
        val namespace: AgentTranscriptLifecycleDurableNamespace,
        val intent: AgentSystemNotificationIntent,
        val ticket: AgentTranscriptLifecycleNotificationExecutionTicket,
        val request: AgentTranscriptLifecycleNotificationDispatchRequest,
    )

    private class FakeApplyLease(
        private val order: MutableList<String>,
        private val stale: Boolean = false,
    ) : RelayV2RepositoryEffectApplyLeasePort {
        var active = false
            private set
        var calls = 0
            private set
        var observedAuthority: RelayV2RepositoryEffectAuthority? = null
            private set

        override suspend fun <T> withEffectApplyLease(
            authority: RelayV2RepositoryEffectAuthority,
            block: suspend () -> T,
        ): RelayV2EffectApplyResult<T> {
            calls += 1
            observedAuthority = authority
            if (stale) return RelayV2EffectApplyResult.Stale
            check(!active)
            active = true
            order += "lease-enter"
            return try {
                RelayV2EffectApplyResult.Applied(block())
            } finally {
                active = false
                order += "lease-release"
            }
        }
    }

    private class RecordingClaimPort(
        private val lease: FakeApplyLease,
        private val order: MutableList<String>,
        private val result: suspend (
            AgentTranscriptLifecycleDurableNamespace,
            AgentSystemNotificationIntent,
        ) -> AgentTranscriptLifecycleNotificationClaimResult,
    ) : AgentTranscriptLifecycleNotificationClaimPort {
        var calls = 0
            private set
        var observedNamespace: AgentTranscriptLifecycleDurableNamespace? = null
            private set
        var observedIntent: AgentSystemNotificationIntent? = null
            private set

        override suspend fun claimNotificationUnderApplyLease(
            expectedNamespace: AgentTranscriptLifecycleDurableNamespace,
            intent: AgentSystemNotificationIntent,
        ): AgentTranscriptLifecycleNotificationClaimResult {
            check(lease.active)
            calls += 1
            observedNamespace = expectedNamespace
            observedIntent = intent
            return result(expectedNamespace, intent).also {
                order += "claim-committed"
            }
        }
    }

    private class RecordingPlatform(
        private val lease: FakeApplyLease,
        private val order: MutableList<String>,
        private val result: (
            AgentTranscriptLifecycleNotificationExecutionTicket,
        ) -> AgentTranscriptLifecycleNotificationPlatformResult,
    ) : AgentTranscriptLifecycleNotificationPlatformPort {
        val tickets = mutableListOf<AgentTranscriptLifecycleNotificationExecutionTicket>()
        var calls = 0
            private set

        override fun post(
            ticket: AgentTranscriptLifecycleNotificationExecutionTicket,
        ): AgentTranscriptLifecycleNotificationPlatformResult {
            assertTrue("platform call must retain the apply lease", lease.active)
            calls += 1
            tickets += ticket
            order += "platform"
            return result(ticket)
        }
    }
}
