package com.tmuxworktree.mobile.core.relay.v2.state

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2DurableTerminalPostCommitEffectSink
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2EffectGeneration
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2RepositoryEffectAuthority
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2TerminalPostCommitEffectActivationReceipt
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2TerminalPostCommitEffectBatch
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2TerminalPostCommitEffectReservationResult
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2TerminalSynchronousEffectExecutionReceipt
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2TerminalSynchronousEffectExecutor
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalDeliveryToken
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalEffect
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalEffectFence
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalIdentity
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalOpenAttempt
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalParserCallbackToken
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class RelayV2TerminalPostCommitGenerationInstrumentedTest {
    private lateinit var database: RelayV2StateDatabase

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        database = Room.inMemoryDatabaseBuilder(context, RelayV2StateDatabase::class.java)
            .allowMainThreadQueries()
            .build()
    }

    @After
    fun tearDown() {
        database.close()
    }

    @Test
    fun coldStartUsesFreshGenerationWhileOldOwnerRemainsFenced() = runBlocking {
        val journal = RoomRelayV2TerminalPostCommitJournalStore(database)
        val oldBatch = resetBatch(connectionGeneration = 1)
        val oldOwner = sink(journal)
        oldOwner.teardownAuthority(oldBatch.authority, oldBatch.key)

        assertTrue(
            oldOwner.reserve("late-old-owner", oldBatch) is
                RelayV2TerminalPostCommitEffectReservationResult.Rejected,
        )

        val restarted = sink(journal)
        val recovery = restarted.recover()
        assertEquals(1L, recovery.connectionGenerationFloor)

        val freshBatch = resetBatch(recovery.connectionGenerationFloor + 1)
        val reserved = restarted.reserve("fresh-reset", freshBatch)
            as RelayV2TerminalPostCommitEffectReservationResult.Reserved
        assertEquals(
            RelayV2TerminalPostCommitEffectActivationReceipt.ACCEPTED,
            reserved.reservation.activate(),
        )
    }

    private fun sink(journal: RelayV2TerminalPostCommitJournalStore) =
        RelayV2DurableTerminalPostCommitEffectSink(
            journal = journal,
            executor = RelayV2TerminalSynchronousEffectExecutor {
                RelayV2TerminalSynchronousEffectExecutionReceipt.COMPLETED
            },
            executionContext = Dispatchers.Unconfined,
        )

    private fun resetBatch(connectionGeneration: Long): RelayV2TerminalPostCommitEffectBatch {
        val generation = RelayV2EffectGeneration(PROFILE_ID, ACTIVATION_GENERATION, connectionGeneration)
        val authority = RelayV2RepositoryEffectAuthority(
            generation = generation,
            profileId = PROFILE_ID,
            profileActivationGeneration = ACTIVATION_GENERATION,
            principalId = "principal-a",
            clientInstanceId = "client-a",
            hostId = "host-a",
            hostEpoch = "epoch-a",
        )
        val key = RelayV2TerminalCheckpointKey(
            profileId = PROFILE_ID,
            profileActivationGeneration = ACTIVATION_GENERATION,
            principalId = authority.principalId,
            clientInstanceId = authority.clientInstanceId,
            hostId = authority.hostId,
            hostEpoch = authority.hostEpoch,
            scopeId = "scope-a",
            sessionId = "session-a",
            streamId = "stream-a",
            pane = 0,
        )
        val identity = RelayV2TerminalIdentity(
            profileId = key.profileId,
            profileActivationGeneration = key.profileActivationGeneration,
            principalId = key.principalId,
            clientInstanceId = key.clientInstanceId,
            hostId = key.hostId,
            hostEpoch = key.hostEpoch,
            hostInstanceId = "host-process-a",
            scopeId = key.scopeId,
            sessionId = key.sessionId,
            streamId = key.streamId,
            generation = "terminal-generation-a",
            resumeTokenCredentialReference = "resume-reference-a",
            resumeTokenCredentialFingerprint = "resume-fingerprint-a",
            pane = key.pane,
        )
        val callback = RelayV2TerminalParserCallbackToken(
            fence = RelayV2TerminalEffectFence(
                identity = identity,
                deliveryToken = RelayV2TerminalDeliveryToken(generation, 2, 1),
                openAttempt = RelayV2TerminalOpenAttempt("open-a", "open-fingerprint-a"),
            ),
            parserContinuityId = "parser-a",
            operationId = "reset-a-$connectionGeneration",
            startOffset = "0",
            endOffset = "1",
        )
        return RelayV2TerminalPostCommitEffectBatch(
            authority = authority,
            key = key,
            callbackToken = callback,
            effects = listOf(RelayV2TerminalEffect.ResetParser(callback)),
        )
    }

    private companion object {
        const val PROFILE_ID = "profile-a"
        const val ACTIVATION_GENERATION = 1L
    }
}
