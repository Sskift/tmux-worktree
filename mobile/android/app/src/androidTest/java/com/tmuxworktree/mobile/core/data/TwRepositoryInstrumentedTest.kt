package com.tmuxworktree.mobile.core.data

import androidx.room.Room
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.tmuxworktree.mobile.core.model.AgentState
import com.tmuxworktree.mobile.core.model.DeliveryState
import com.tmuxworktree.mobile.core.model.RelayHost
import com.tmuxworktree.mobile.core.model.RelayScope
import com.tmuxworktree.mobile.core.model.RelaySession
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class TwRepositoryInstrumentedTest {
    private lateinit var database: TwDatabase
    private var nowMillis = 1_000L
    private lateinit var repository: TwRepository

    @Before
    fun setUp() {
        database = Room.inMemoryDatabaseBuilder(
            InstrumentationRegistry.getInstrumentation().targetContext,
            TwDatabase::class.java,
        ).allowMainThreadQueries().build()
        repository = TwRepository(database) { nowMillis }
    }

    @After
    fun tearDown() {
        database.close()
    }

    @Test
    fun enqueueWritesOutboxAndTimelineAsOneUserVisibleOperation() = runTest {
        val message = repository.enqueueAgentMessage(
            hostId = "mac-admin",
            sessionName = "local:demo",
            body = "Install and verify",
        )

        val stored = repository.outbox.first().single()
        val timeline = repository.timeline("mac-admin:local:demo").first().single()

        assertEquals(message, stored)
        assertEquals("agent-${message.commandId}", stored.requestId)
        assertEquals(DeliveryState.QUEUED, stored.state)
        assertEquals("Install and verify", timeline.body)
        assertEquals(DeliveryState.QUEUED, timeline.deliveryState)
        assertEquals("outbox-${message.commandId}", timeline.eventId)
    }

    @Test
    fun validTransitionsUpdateAttemptErrorAndMatchingTimeline() = runTest {
        val message = repository.enqueueAgentMessage("host", "local:demo", "continue")

        assertTrue(repository.transitionOutbox(message.commandId, DeliveryState.SENDING))
        assertTrue(
            repository.transitionOutbox(
                message.commandId,
                DeliveryState.FAILED_RETRYABLE,
                error = "relay offline",
            ),
        )

        val stored = repository.outbox.first().single()
        val timeline = repository.timeline("host:local:demo").first().single()
        assertEquals(DeliveryState.FAILED_RETRYABLE, stored.state)
        assertEquals(1, stored.attemptCount)
        assertEquals("relay offline", stored.lastError)
        assertEquals(DeliveryState.FAILED_RETRYABLE, timeline.deliveryState)
    }

    @Test
    fun terminalStateCannotTransitionAgain() = runTest {
        val message = repository.enqueueAgentMessage("host", "local:demo", "continue")
        repository.transitionOutbox(message.commandId, DeliveryState.SENDING)
        repository.transitionOutbox(message.commandId, DeliveryState.SUCCEEDED)

        val error = runCatching {
            repository.transitionOutbox(message.commandId, DeliveryState.SENDING)
        }.exceptionOrNull()

        assertTrue(error is IllegalArgumentException)
        assertTrue(error?.message.orEmpty().contains("SUCCEEDED -> SENDING"))
        assertEquals(DeliveryState.SUCCEEDED, repository.outbox.first().single().state)
    }

    @Test
    fun pendingOutboxExpiresStaleQueuedMessagesBeforeReturningWork() = runTest {
        repository.enqueueAgentMessage(
            hostId = "host",
            sessionName = "local:demo",
            body = "time limited",
            ttlMillis = 500,
        )
        nowMillis = 1_501L

        assertTrue(repository.pendingOutbox().isEmpty())
        assertEquals(DeliveryState.EXPIRED, repository.outbox.first().single().state)
        assertEquals(
            DeliveryState.EXPIRED,
            repository.timeline("host:local:demo").first().single().deliveryState,
        )
    }

    @Test
    fun acceptedConfirmingAndAmbiguousMessagesExpireWithTheirTimeline() = runTest {
        val messages = DeliveryState.entries
            .filter { it in setOf(DeliveryState.ACCEPTED, DeliveryState.CONFIRMING, DeliveryState.AMBIGUOUS) }
            .associateWith { state ->
                repository.enqueueAgentMessage(
                    hostId = "host",
                    sessionName = "local:${state.name.lowercase()}",
                    body = "message in $state",
                    ttlMillis = 500,
                ).also { advanceOutboxTo(it.commandId, state) }
            }
        nowMillis = 1_501L

        assertTrue(repository.pendingOutbox().isEmpty())
        val stored = repository.outbox.first().associateBy { it.commandId }
        messages.forEach { (_, message) ->
            assertEquals(DeliveryState.EXPIRED, stored.getValue(message.commandId).state)
            assertEquals(
                DeliveryState.EXPIRED,
                repository.timeline("${message.hostId}:${message.sessionName}")
                    .first()
                    .single()
                    .deliveryState,
            )
        }
    }

    @Test
    fun acceptedConfirmingAndAmbiguousMessagesCanBeCancelledExplicitly() = runTest {
        val targets = listOf(
            DeliveryState.ACCEPTED,
            DeliveryState.CONFIRMING,
            DeliveryState.AMBIGUOUS,
        )
        val messages = targets.associateWith { state ->
            repository.enqueueAgentMessage(
                hostId = "host",
                sessionName = "local:cancel-${state.name.lowercase()}",
                body = "cancel $state",
            ).also { advanceOutboxTo(it.commandId, state) }
        }

        messages.values.forEach { message -> assertTrue(repository.cancelOutboxMessage(message.commandId)) }

        val stored = repository.outbox.first().associateBy { it.commandId }
        messages.values.forEach { message ->
            assertEquals(DeliveryState.CANCELLED, stored.getValue(message.commandId).state)
            assertEquals(
                DeliveryState.CANCELLED,
                repository.timeline("${message.hostId}:${message.sessionName}")
                    .first()
                    .single()
                    .deliveryState,
            )
        }
    }

    @Test
    fun explicitExpiryPassUpdatesOfflineOutboxAndTimelineWithoutAFlush() = runTest {
        val message = repository.enqueueAgentMessage(
            hostId = "host",
            sessionName = "local:offline",
            body = "expire while offline",
            ttlMillis = 500,
        )
        nowMillis = 1_501L

        assertEquals(1, repository.expireOutboxMessages())
        assertEquals(DeliveryState.EXPIRED, repository.outbox.first().single().state)
        assertEquals(
            DeliveryState.EXPIRED,
            repository.timeline("${message.hostId}:${message.sessionName}")
                .first()
                .single()
                .deliveryState,
        )
    }

    @Test
    fun onlyQueuedMessagesCanBeCancelled() = runTest {
        val queued = repository.enqueueAgentMessage("host", "local:one", "queued")
        val sending = repository.enqueueAgentMessage("host", "local:two", "sending")
        repository.transitionOutbox(sending.commandId, DeliveryState.SENDING)

        assertTrue(repository.cancelQueuedMessage(queued.commandId))
        assertFalse(repository.cancelQueuedMessage(sending.commandId))

        val states = repository.outbox.first().associate { it.commandId to it.state }
        assertEquals(DeliveryState.CANCELLED, states.getValue(queued.commandId))
        assertEquals(DeliveryState.SENDING, states.getValue(sending.commandId))
        assertEquals(
            DeliveryState.CANCELLED,
            repository.timeline("host:local:one").first().single().deliveryState,
        )
        assertEquals(
            DeliveryState.SENDING,
            repository.timeline("host:local:two").first().single().deliveryState,
        )
    }

    @Test
    fun clearProfileDataRemovesEveryRecordBoundToPreviousCredentials() = runTest {
        val host = RelayHost(
            hostId = "old-host",
            displayName = "Old computer",
            clients = 1,
        )
        val scope = RelayScope(
            hostId = host.hostId,
            scopeId = "old-scope",
            label = "Old scope",
            sessionCount = 1,
        )
        val session = RelaySession(
            hostId = host.hostId,
            hostName = host.displayName,
            name = "old-scope:secret-session",
            rawName = "secret-session",
            scopeId = scope.scopeId,
            scopeLabel = scope.label,
            project = "private-project",
            agentState = AgentState.WAITING_FOR_USER,
        )
        repository.replaceHosts(listOf(host))
        repository.replaceScopes(host.hostId, listOf(scope))
        repository.replaceSessions(host.hostId, listOf(session))
        repository.enqueueAgentMessage(host.hostId, session.name, "unsent private command")
        repository.saveStreamCheckpoint(
            StreamCheckpointEntity(
                streamId = "old-stream",
                sessionId = session.stableId,
                generation = 7,
                lastOutputSequence = 8,
                lastInputAck = 9,
                updatedAtMillis = nowMillis,
            ),
        )

        assertEquals(listOf(host), repository.hosts.first())
        assertEquals(listOf(scope), repository.scopes.first())
        assertEquals(listOf(session), repository.sessions.first())
        assertTrue(repository.outbox.first().isNotEmpty())
        assertTrue(repository.timeline(session.stableId).first().isNotEmpty())
        assertTrue(repository.streamCheckpoint("old-stream") != null)

        repository.clearProfileData()

        assertTrue(repository.hosts.first().isEmpty())
        assertTrue(repository.scopes.first().isEmpty())
        assertTrue(repository.sessions.first().isEmpty())
        assertTrue(repository.outbox.first().isEmpty())
        assertTrue(repository.timeline(session.stableId).first().isEmpty())
        assertTrue(repository.streamCheckpoint("old-stream") == null)
    }

    @Test
    fun replacingHostsPrunesRemovedHostSessionsAndScopesAndEmptySnapshotClearsAll() = runTest {
        val keep = RelayHost("keep", "Keep")
        val gone = RelayHost("gone", "Gone")
        repository.replaceHosts(listOf(keep, gone))
        listOf(keep, gone).forEach { host ->
            repository.replaceScopes(
                host.hostId,
                listOf(RelayScope(host.hostId, "local", "Local")),
            )
            repository.replaceSessions(
                host.hostId,
                listOf(
                    RelaySession(
                        hostId = host.hostId,
                        hostName = host.displayName,
                        name = "local:${host.hostId}",
                        rawName = host.hostId,
                    ),
                ),
            )
        }

        repository.replaceHosts(listOf(keep))

        assertEquals(listOf(keep), repository.hosts.first())
        assertTrue(repository.sessions.first().all { it.hostId == keep.hostId })
        assertTrue(repository.scopes.first().all { it.hostId == keep.hostId })

        repository.replaceHosts(emptyList())

        assertTrue(repository.hosts.first().isEmpty())
        assertTrue(repository.sessions.first().isEmpty())
        assertTrue(repository.scopes.first().isEmpty())
    }

    private suspend fun advanceOutboxTo(commandId: String, target: DeliveryState) {
        assertTrue(repository.transitionOutbox(commandId, DeliveryState.SENDING))
        when (target) {
            DeliveryState.ACCEPTED -> assertTrue(
                repository.transitionOutbox(commandId, DeliveryState.ACCEPTED),
            )
            DeliveryState.CONFIRMING -> {
                assertTrue(repository.transitionOutbox(commandId, DeliveryState.ACCEPTED))
                assertTrue(repository.transitionOutbox(commandId, DeliveryState.CONFIRMING))
            }
            DeliveryState.AMBIGUOUS -> assertTrue(
                repository.transitionOutbox(commandId, DeliveryState.AMBIGUOUS),
            )
            else -> error("Unsupported test state: $target")
        }
    }
}
