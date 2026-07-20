package com.tmuxworktree.mobile.core.relay.v2.runtime

import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2AttemptInterruptionCause
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxAction
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxArguments
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxAttemptKind
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxAuthorityCore
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxDraft
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxEffect
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxResult
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxState
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxStateTag
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2OutboxAuthorityNamespace
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2OutboxBatchResult
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2OutboxRecoveryAuthority
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RelayV2OutboxQueryAdmissionAdapterTest {
    @Test
    fun `commit registers exact actor query and returns exact receipt only afterwards`() =
        runBlocking {
            val repository = FakeOutboxRecoveryAuthority(queryableState())
            val lease = FakeApplyLease()
            val composition = RelayV2OutboxQueryAdmissionAuthority.composition()
            val adapter = composition.adapter(lease, repository)
            val effect = queryEffect(repository.state)

            val result = adapter.handle(effect)
                as RelayV2OutboxQueryAdmissionApplyResult.Committed

            assertEquals(1, lease.admittedBlocks)
            assertEquals(listOf(effect.repositoryAuthority), lease.authorities)
            assertEquals(effect.recovery, result.receipt.binding)
            assertEquals(effect.hostId, result.receipt.hostId)
            assertEquals(effect.hostEpoch, result.receipt.hostEpoch)
            assertTrue(
                runCatching { composition.adapter(lease, repository) }.isFailure,
            )

            val action = repository.actions.single() as RelayV2OutboxAction.BeginQueries
            assertEquals(listOf(effect.recovery.requestId), action.attemptRequestIds)
            assertEquals(
                effect.commandBatch.commands.map { it.commandId },
                action.entryIds.map { it.commandId },
            )
            val durableQuery = repository.committedEffects.single()
                as RelayV2OutboxEffect.QueryCommands
            assertEquals(effect.recovery.requestId, durableQuery.attemptRequestId)
            assertEquals(effect.hostId, durableQuery.authority.hostId)
            assertEquals(effect.hostEpoch, durableQuery.authority.expectedHostEpoch)
            assertEquals(
                effect.commandBatch.commands,
                durableQuery.items.map {
                    RelayV2PendingCommand(it.entryId.commandId, it.dedupeWindowId)
                },
            )
            assertEquals(
                listOf(RelayV2OutboxStateTag.CONFIRMING, RelayV2OutboxStateTag.AMBIGUOUS),
                repository.state.entries.map { it.state },
            )
            repository.state.entries.forEach { entry ->
                assertEquals(effect.recovery.requestId, entry.attempts.last().requestId)
                assertEquals(
                    RelayV2OutboxAttemptKind.QUERY,
                    entry.attempts.last().kind,
                )
            }
        }

    @Test
    fun `rejection stale lease and repository corruption never produce a receipt`() = runBlocking {
        val state = queryableState()
        val missing = queryEffect(
            state,
            commands = listOf(RelayV2PendingCommand("missing-command", "missing-window")),
        )
        val attemptsBefore = state.entries.map { it.attempts }
        val rejectingRepository = FakeOutboxRecoveryAuthority(state)
        val rejected = RelayV2OutboxQueryAdmissionAuthority.composition().adapter(
            FakeApplyLease(),
            rejectingRepository,
        ).handle(missing)
        assertTrue(rejected is RelayV2OutboxQueryAdmissionApplyResult.Rejected)
        assertEquals(attemptsBefore, rejectingRepository.state.entries.map { it.attempts })
        assertTrue(rejectingRepository.committedEffects.isEmpty())

        val staleRepository = FakeOutboxRecoveryAuthority(queryableState())
        val staleLease = FakeApplyLease(stale = true)
        val stale = RelayV2OutboxQueryAdmissionAuthority.composition()
            .adapter(staleLease, staleRepository)
            .handle(queryEffect(staleRepository.state))
        assertEquals(RelayV2OutboxQueryAdmissionApplyResult.Stale, stale)
        assertEquals(0, staleRepository.transactionCount)

        val corruptRepository = FakeOutboxRecoveryAuthority(queryableState()).apply {
            failure = IllegalStateException("corrupt Outbox state")
        }
        val corruption = runCatching {
            RelayV2OutboxQueryAdmissionAuthority.composition()
                .adapter(FakeApplyLease(), corruptRepository)
                .handle(queryEffect(corruptRepository.state))
        }
        assertTrue(corruption.isFailure)
        assertEquals("corrupt Outbox state", corruption.exceptionOrNull()?.message)
        assertTrue(corruptRepository.committedEffects.isEmpty())
    }

    @Test
    fun `commit without exact query proof leaves recoverable state and returns no receipt`() =
        runBlocking {
            val repository = FakeOutboxRecoveryAuthority(queryableState()).apply {
                replaceCommittedEffects = emptyList()
            }
            val effect = queryEffect(repository.state)
            val result = RelayV2OutboxQueryAdmissionAuthority.composition()
                .adapter(FakeApplyLease(), repository)
                .handle(effect)

            assertEquals(RelayV2OutboxQueryAdmissionApplyResult.CommitProofMismatch, result)
            assertEquals(
                listOf(RelayV2OutboxStateTag.CONFIRMING, RelayV2OutboxStateTag.AMBIGUOUS),
                repository.state.entries.map { it.state },
            )
            assertEquals(
                listOf(effect.recovery.requestId, effect.recovery.requestId),
                repository.state.entries.map { it.attempts.last().requestId },
            )
            assertTrue(
                repository.actualCommittedEffects.single() is RelayV2OutboxEffect.QueryCommands,
            )
            assertFalse(
                repository.actualCommittedEffects.any {
                    it is RelayV2OutboxEffect.ExecuteCommand
                },
            )
        }

    private fun queryEffect(
        state: RelayV2OutboxState,
        commands: List<RelayV2PendingCommand> = state.entries.map {
            RelayV2PendingCommand(it.commandId, it.dedupeWindowId)
        },
    ): RelayV2RuntimeEffect.RegisterCommandQueryAttempt {
        val generation = RelayV2EffectGeneration(PROFILE_ID, 7, 11)
        return RelayV2RuntimeEffect.RegisterCommandQueryAttempt(
            recovery = RelayV2RecoveryBinding(generation, 3, QUERY_REQUEST_ID),
            hostId = HOST_ID,
            hostEpoch = HOST_EPOCH,
            commandBatch = RelayV2CommandQueryBatch(commands),
            repositoryAuthority = RelayV2RepositoryEffectAuthority(
                generation = generation,
                profileId = PROFILE_ID,
                profileActivationGeneration = 7,
                principalId = PRINCIPAL_ID,
                clientInstanceId = CLIENT_INSTANCE_ID,
                hostId = HOST_ID,
                hostEpoch = HOST_EPOCH,
            ),
        )
    }

    private fun queryableState(): RelayV2OutboxState {
        val core = RelayV2OutboxAuthorityCore()
        var state = RelayV2OutboxState.empty()
        listOf("command-confirming", "command-ambiguous").forEachIndexed { index, commandId ->
            state = applied(
                core.reduce(
                    state,
                    RelayV2OutboxAction.Enqueue(
                        RelayV2OutboxDraft(
                            profileId = PROFILE_ID,
                            principalId = PRINCIPAL_ID,
                            hostId = HOST_ID,
                            expectedHostEpoch = HOST_EPOCH,
                            dedupeWindowId = "window-${index + 1}",
                            commandId = commandId,
                            scopeId = "scope-a",
                            sessionId = "session-${index + 1}",
                            arguments = RelayV2OutboxArguments.sendAgentMessage(
                                pane = 0,
                                message = "continue",
                                submit = true,
                            ),
                        ),
                        createdAtMillis = index.toLong() + 1,
                    ),
                ),
            ).state
        }
        state = applied(
            core.reduce(
                state,
                RelayV2OutboxAction.DispatchEligible(
                    attemptRequestIds = state.entries.associate {
                        it.id to "execute-${it.commandId}"
                    },
                    effectBudget = state.entries.size,
                ),
            ),
        ).state
        val confirming = state.entries.first()
        state = applied(
            core.reduce(
                state,
                RelayV2OutboxAction.AttemptInterrupted(
                    entryId = confirming.id,
                    attemptRequestId = confirming.attempts.last().requestId,
                    cause = RelayV2AttemptInterruptionCause.DISCONNECTED,
                ),
            ),
        ).state
        return RelayV2OutboxState.restore(
            entries = state.entries.mapIndexed { index, entry ->
                if (index == 1) entry.copy(state = RelayV2OutboxStateTag.AMBIGUOUS) else entry
            },
            nextCreationOrder = state.nextCreationOrder,
        )
    }

    private fun applied(result: RelayV2OutboxResult): RelayV2OutboxResult.Applied {
        check(result is RelayV2OutboxResult.Applied)
        return result
    }

    private class FakeApplyLease(
        var stale: Boolean = false,
    ) : RelayV2RepositoryEffectApplyLeasePort {
        var admittedBlocks = 0
        val authorities = mutableListOf<RelayV2RepositoryEffectAuthority>()

        override suspend fun <T> withEffectApplyLease(
            authority: RelayV2RepositoryEffectAuthority,
            block: suspend () -> T,
        ): RelayV2EffectApplyResult<T> {
            authorities += authority
            if (stale) return RelayV2EffectApplyResult.Stale
            admittedBlocks += 1
            return RelayV2EffectApplyResult.Applied(block())
        }
    }

    private class FakeOutboxRecoveryAuthority(
        initialState: RelayV2OutboxState,
    ) : RelayV2OutboxRecoveryAuthority {
        private val core = RelayV2OutboxAuthorityCore()
        var state = initialState
            private set
        var transactionCount = 0
            private set
        var failure: Throwable? = null
        var replaceCommittedEffects: List<RelayV2OutboxEffect>? = null
        var actions: List<RelayV2OutboxAction> = emptyList()
            private set
        var actualCommittedEffects: List<RelayV2OutboxEffect> = emptyList()
            private set
        var committedEffects: List<RelayV2OutboxEffect> = emptyList()
            private set

        override suspend fun reduceOutboxBatchUnderApplyLease(
            namespace: RelayV2OutboxAuthorityNamespace,
            actionSource: (RelayV2OutboxState) -> List<RelayV2OutboxAction>?,
        ): RelayV2OutboxBatchResult {
            transactionCount += 1
            failure?.let { throw it }
            check(namespace.profileId == PROFILE_ID)
            check(namespace.profileActivationGeneration == 7L)
            check(namespace.principalId == PRINCIPAL_ID)
            check(namespace.clientInstanceId == CLIENT_INSTANCE_ID)
            val sourced = actionSource(state)
                ?: return RelayV2OutboxBatchResult.Rejected(state, null)
            actions = sourced
            var reduced = state
            val effects = mutableListOf<RelayV2OutboxEffect>()
            sourced.forEach { action ->
                when (val result = core.reduce(reduced, action)) {
                    is RelayV2OutboxResult.Applied -> {
                        reduced = result.state
                        effects += result.effects
                    }
                    is RelayV2OutboxResult.Rejected ->
                        return RelayV2OutboxBatchResult.Rejected(state, result.reason)
                }
            }
            state = reduced
            actualCommittedEffects = effects.toList()
            committedEffects = replaceCommittedEffects ?: actualCommittedEffects
            return RelayV2OutboxBatchResult.Applied(state, committedEffects)
        }
    }

    private companion object {
        const val PROFILE_ID = "profile-a"
        const val PRINCIPAL_ID = "principal-a"
        const val CLIENT_INSTANCE_ID = "client-a"
        const val HOST_ID = "host-a"
        const val HOST_EPOCH = "epoch-a"
        const val QUERY_REQUEST_ID = "query-request-a"
    }
}
