package com.tmuxworktree.mobile.core.relay.v2.runtime

import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2Codec
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2DecodedMessage
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2WebSocketChannel
import com.tmuxworktree.mobile.core.relay.v2.outbox.*
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayActiveProfileIdentity
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayProfileDialect
import com.tmuxworktree.mobile.core.relay.v2.state.*
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class RelayV2OutboxRecoveryAdapterTest {
    @Test
    fun `mixed statuses commit state and expose only post-commit retry effect`() = runBlocking {
        val fixture = Fixture(ids = ArrayDeque(listOf("retry-attempt")))
        val commands = fixture.seed("succeeded", "retry", "doubt")
        val effect = fixture.effect(
            commands,
            listOf(
                status(commands[0], "succeeded"),
                status(commands[1], "not_accepted"),
                status(commands[2], "in_doubt"),
            ),
        )

        val committed = fixture.apply(effect)

        requireNotNull(committed)
        assertEquals(effect.recovery, committed.receipt.binding)
        assertEquals(commands.map { it.pending }, committed.receipt.appliedCommands)
        val retry = committed.effects.single() as RelayV2OutboxEffect.ExecuteCommand
        assertEquals("retry", retry.command.entryId.commandId)
        assertEquals("retry-attempt", retry.attempt.requestId)
        assertEquals(0L, retry.retryAfterMs)
        val state = fixture.repository.loadOutbox(fixture.namespace)
        assertEquals(RelayV2OutboxStateTag.SUCCEEDED, state.command("succeeded").state)
        assertEquals(RelayV2OutboxStateTag.SENDING, state.command("retry").state)
        assertEquals("retry-attempt", state.command("retry").attempts.last().requestId)
        assertEquals(RelayV2OutboxStateTag.AMBIGUOUS, state.command("doubt").state)
    }

    @Test
    fun `status batch freezes expected command order before the durable transaction`() =
        runBlocking {
            val fixture = Fixture()
            val commands = fixture.seed("snapshot-first", "snapshot-second")
            val actorExpected = commands.mapTo(ArrayList()) { it.pending }
            val originalExpected = actorExpected.map { it.copy() }
            val replacement = RelayV2PendingCommand("replacement", "replacement-window")
            val effect = fixture.effect(
                commands,
                commands.map { status(it, "accepted") },
            ).copy(expectedCommands = actorExpected)
            val creationCursor = fixture.repository.loadOutbox(fixture.namespace)
                .nextCreationOrder
            fixture.store.beforeNextTransaction = {
                actorExpected.removeAt(0)
                actorExpected[0] = replacement
            }

            val committed = fixture.apply(effect)

            requireNotNull(committed)
            assertEquals(listOf(replacement), actorExpected)
            assertEquals(originalExpected, committed.receipt.appliedCommands)
            assertTrue(committed.effects.isEmpty())
            val state = fixture.repository.loadOutbox(fixture.namespace)
            assertEquals(RelayV2OutboxStateTag.CONFIRMING, state.command("snapshot-first").state)
            assertEquals(RelayV2OutboxStateTag.CONFIRMING, state.command("snapshot-second").state)
            assertEquals(creationCursor, state.nextCreationOrder)

            val receiptMutation = runCatching {
                (committed.receipt.appliedCommands as MutableList<RelayV2PendingCommand>)
                    .removeAt(0)
            }
            assertTrue(receiptMutation.isFailure)
            assertEquals(originalExpected, committed.receipt.appliedCommands)
            assertEquals(
                creationCursor,
                fixture.repository.loadOutbox(fixture.namespace).nextCreationOrder,
            )
        }

    @Test
    fun `all non retry query states map to exact existing evidence without effects`() =
        runBlocking {
            val fixture = Fixture()
            val names = listOf(
                "accepted",
                "running",
                "succeeded",
                "failed",
                "in_doubt",
                "expired",
                "unknown",
            )
            val commands = fixture.seed(*names.toTypedArray())
            val effect = fixture.effect(
                commands,
                commands.zip(names).map { (command, state) -> status(command, state) },
            )

            val committed = fixture.apply(effect)

            requireNotNull(committed)
            assertTrue(committed.effects.isEmpty())
            assertEquals(commands.map { it.pending }, committed.receipt.appliedCommands)
            val state = fixture.repository.loadOutbox(fixture.namespace)
            assertEquals(RelayV2OutboxStateTag.CONFIRMING, state.command("accepted").state)
            assertEquals(
                RelayV2OutboxAcceptanceEvidence.DURABLE,
                state.command("accepted").acceptanceEvidence,
            )
            assertEquals(RelayV2OutboxStateTag.CONFIRMING, state.command("running").state)
            assertEquals(RelayV2OutboxStateTag.SUCCEEDED, state.command("succeeded").state)
            assertEquals(RelayV2OutboxStateTag.FAILED_FINAL, state.command("failed").state)
            assertEquals(RelayV2OutboxStateTag.AMBIGUOUS, state.command("in_doubt").state)
            assertEquals(RelayV2OutboxStateTag.AMBIGUOUS, state.command("expired").state)
            assertEquals(RelayV2OutboxStateTag.AMBIGUOUS, state.command("unknown").state)
        }

    @Test
    fun `direct status and result evidence use the durable transition matrix`() = runBlocking {
        data class Case(
            val name: String,
            val type: String,
            val wireState: String,
            val expectedState: RelayV2OutboxStateTag,
            val expectedSource: RelayV2CommandStatusSource,
        )

        listOf(
            Case(
                "accepted",
                "command.status",
                "accepted",
                RelayV2OutboxStateTag.ACCEPTED,
                RelayV2CommandStatusSource.EXECUTE_RESPONSE,
            ),
            Case(
                "running",
                "command.status",
                "running",
                RelayV2OutboxStateTag.CONFIRMING,
                RelayV2CommandStatusSource.EXECUTE_RESPONSE,
            ),
            Case(
                "succeeded",
                "command.status",
                "succeeded",
                RelayV2OutboxStateTag.SUCCEEDED,
                RelayV2CommandStatusSource.EXECUTE_RESPONSE,
            ),
            Case(
                "failed",
                "command.result",
                "failed",
                RelayV2OutboxStateTag.FAILED_FINAL,
                RelayV2CommandStatusSource.RESULT_EVENT,
            ),
            Case(
                "in-doubt",
                "command.result",
                "in_doubt",
                RelayV2OutboxStateTag.AMBIGUOUS,
                RelayV2CommandStatusSource.RESULT_EVENT,
            ),
        ).forEach { case ->
            val fixture = Fixture()
            val command = fixture.seedSending(case.name).single()
            val effect = fixture.evidenceEffect(
                decodeEvidence(fixture.context, command, case.type, case.wireState),
            )

            val result = fixture.handle(effect)

            val commit = (result as RelayV2OutboxRecoveryApplyResult.Committed).commit
            assertTrue(commit.effects.isEmpty())
            val receipt = (commit as RelayV2OutboxRecoveryCommit.CommandEvidence).receipt
            assertEquals(case.expectedSource, receipt.source)
            assertEquals(case.expectedState, fixture.repository.loadOutbox(fixture.namespace)
                .command(case.name).state)
            assertEquals(
                RelayV2OutboxAcceptanceEvidence.DURABLE,
                fixture.repository.loadOutbox(fixture.namespace)
                    .command(case.name).acceptanceEvidence,
            )
            assertEquals(
                if (case.type == "command.status") "execute-${case.name}" else null,
                receipt.attemptRequestId,
            )
        }
    }

    @Test
    fun `late result without request id converges an ambiguous command`() = runBlocking {
        val fixture = Fixture()
        val command = fixture.seedSending("late-final").single()
        val inDoubt = fixture.evidenceEffect(
            decodeEvidence(fixture.context, command, "command.result", "in_doubt"),
        )
        val ambiguous = fixture.handle(inDoubt)
        assertTrue(ambiguous is RelayV2OutboxRecoveryApplyResult.Committed)
        assertEquals(
            RelayV2OutboxStateTag.AMBIGUOUS,
            fixture.repository.loadOutbox(fixture.namespace).command("late-final").state,
        )

        val succeeded = fixture.evidenceEffect(
            decodeEvidence(fixture.context, command, "command.result", "succeeded"),
        )
        val converged = fixture.handle(succeeded)

        val commit = (converged as RelayV2OutboxRecoveryApplyResult.Committed).commit
        assertTrue(commit.effects.isEmpty())
        val receipt = (commit as RelayV2OutboxRecoveryCommit.CommandEvidence).receipt
        assertNull(receipt.attemptRequestId)
        assertEquals(RelayV2CommandStatusSource.RESULT_EVENT, receipt.source)
        assertEquals(
            RelayV2OutboxStateTag.SUCCEEDED,
            fixture.repository.loadOutbox(fixture.namespace).command("late-final").state,
        )
    }

    @Test
    fun `mutable decoded frame before handle cannot change canonical evidence ownership`() =
        runBlocking {
            val fixture = Fixture()
            val command = fixture.seedSending("pre-handle-snapshot").single()
            val message = decodeEvidence(
                fixture.context,
                command,
                "command.status",
                "accepted",
            )
            val mutableFrame = message.mutableFrame()
            mutableFrame["type"] = "host.presence"
            message.mutablePayload()["state"] = "failed"
            message.mutablePayload()["dedupeWindowId"] = "mutated-window"

            val result = fixture.handle(fixture.evidenceEffect(message))

            val commit = (result as RelayV2OutboxRecoveryApplyResult.Committed).commit
                as RelayV2OutboxRecoveryCommit.CommandEvidence
            assertEquals(RelayV2CommandStatusState.ACCEPTED, commit.receipt.state)
            assertEquals(command.pending.dedupeWindowId, commit.receipt.dedupeWindowId)
            val persisted = fixture.repository.loadOutbox(fixture.namespace)
                .command(command.pending.commandId)
            assertEquals(RelayV2OutboxStateTag.ACCEPTED, persisted.state)
            assertEquals(RelayV2OutboxAcceptanceEvidence.DURABLE, persisted.acceptanceEvidence)
        }

    @Test
    fun `mutable decoded frame during transaction cannot change canonical evidence`() =
        runBlocking {
            val fixture = Fixture()
            val command = fixture.seedSending("transaction-snapshot").single()
            val message = decodeEvidence(
                fixture.context,
                command,
                "command.status",
                "accepted",
            )
            fixture.store.beforeNextTransaction = {
                message.mutableFrame()["type"] = "command.result"
                message.mutablePayload()["state"] = "failed"
                message.mutablePayload()["dedupeWindowId"] = "mutated-window"
            }

            val result = fixture.handle(fixture.evidenceEffect(message))

            val commit = (result as RelayV2OutboxRecoveryApplyResult.Committed).commit
                as RelayV2OutboxRecoveryCommit.CommandEvidence
            assertEquals(RelayV2CommandStatusSource.EXECUTE_RESPONSE, commit.receipt.source)
            assertEquals(RelayV2CommandStatusState.ACCEPTED, commit.receipt.state)
            assertEquals(command.pending.dedupeWindowId, commit.receipt.dedupeWindowId)
            val persisted = fixture.repository.loadOutbox(fixture.namespace)
                .command(command.pending.commandId)
            assertEquals(RelayV2OutboxStateTag.ACCEPTED, persisted.state)
            assertEquals(RelayV2OutboxAcceptanceEvidence.DURABLE, persisted.acceptanceEvidence)
        }

    @Test
    fun `request command and attempt identity mismatches are protocol violations`() = runBlocking {
        val fixture = Fixture()
        val command = fixture.seed("guarded").single()
        val before = fixture.repository.loadOutbox(fixture.namespace)
        val writes = fixture.store.writeCount
        val messages = listOf(
            "wrong requestId" to decodeEvidence(
                fixture.context,
                command,
                "command.status",
                "accepted",
                requestId = "unknown-request",
            ),
            "wrong attempt kind" to decodeEvidence(
                fixture.context,
                command,
                "command.status",
                "accepted",
                requestId = QUERY_ID,
            ),
            "wrong commandId" to decodeEvidence(
                fixture.context,
                command,
                "command.status",
                "accepted",
                commandId = "other-command",
            ),
        )

        messages.forEach { (name, message) ->
            assertEquals(
                name,
                RelayV2OutboxRecoveryApplyResult.ProtocolViolation(
                    RelayV2OutboxRejection.STATUS_IDENTITY_MISMATCH,
                ),
                fixture.handle(fixture.evidenceEffect(message)),
            )
            assertEquals(writes, fixture.store.writeCount)
            val after = fixture.repository.loadOutbox(fixture.namespace)
            assertEquals(before.nextCreationOrder, after.nextCreationOrder)
            assertEquals(before.entries, after.entries)
        }
    }

    @Test
    fun `other direct evidence identity mismatches fail closed without commit`() = runBlocking {
        val fixture = Fixture()
        val command = fixture.seed("guarded-other").single()
        val before = fixture.repository.loadOutbox(fixture.namespace)
        val writes = fixture.store.writeCount
        val wrongOperationResult = linkedMapOf<String, Any?>(
            "pane" to 0L,
            "submit" to true,
            "messageUtf8Bytes" to 1L,
        )
        val messages = listOf(
            decodeEvidence(
                fixture.context,
                command,
                "command.status",
                "accepted",
                hostId = "other-host",
            ),
            decodeEvidence(
                fixture.context,
                command,
                "command.status",
                "accepted",
                hostEpoch = "other-epoch",
            ),
            decodeEvidence(
                fixture.context,
                command,
                "command.status",
                "accepted",
                dedupeWindowId = "other-window",
            ),
            decodeEvidence(
                fixture.context,
                command,
                "command.status",
                "accepted",
                scopeId = "other-scope",
            ),
            decodeEvidence(
                fixture.context,
                command,
                "command.status",
                "accepted",
                sessionId = "other-session",
            ),
            decodeEvidence(
                fixture.context,
                command,
                "command.result",
                "succeeded",
                result = wrongOperationResult,
            ),
        )

        messages.forEach { message ->
            val outcome = runCatching { fixture.handle(fixture.evidenceEffect(message)) }
            assertTrue(
                outcome.isFailure ||
                    outcome.getOrNull() == RelayV2OutboxRecoveryApplyResult.ProtocolViolation(
                        RelayV2OutboxRejection.STATUS_IDENTITY_MISMATCH,
                    ),
            )
            assertEquals(writes, fixture.store.writeCount)
            val after = fixture.repository.loadOutbox(fixture.namespace)
            assertEquals(before.nextCreationOrder, after.nextCreationOrder)
            assertEquals(before.entries, after.entries)
        }
    }

    @Test
    fun `non Outbox effect is returned unchanged without lease or transaction`() = runBlocking {
        val fixture = Fixture()
        val generation = RelayV2EffectGeneration("profile-v2", 7, 1)
        val effect = RelayV2RuntimeEffect.Disconnected(
            fixture.context.profile,
            "not-owned",
            generation,
            generation.connectionGeneration,
        )
        val transactions = fixture.store.transactionCount
        val writes = fixture.store.writeCount

        val result = fixture.handle(effect) as RelayV2OutboxRecoveryApplyResult.NotOwned

        assertSame(effect, result.effect)
        assertEquals(0, fixture.lease.admittedBlocks)
        assertEquals(transactions, fixture.store.transactionCount)
        assertEquals(writes, fixture.store.writeCount)
    }

    @Test
    fun `window-expired proof atomically reissues local command and exposes lineage effect`() =
        runBlocking {
            val fixture = Fixture(ids = ArrayDeque(listOf("replacement-command")))
            val command = fixture.seed("original").single()
            val before = fixture.repository.loadOutbox(fixture.namespace).command("original")
            val effect = fixture.effect(command, status(command, "not_accepted_reissue"))

            val committed = fixture.apply(effect)

            requireNotNull(committed)
            val reissue = committed.effects.single() as RelayV2OutboxEffect.ReissueCreated
            assertEquals("original", reissue.originalEntryId.commandId)
            assertEquals("replacement-command", reissue.replacementEntryId.commandId)
            val state = fixture.repository.loadOutbox(fixture.namespace)
            val original = state.command("original")
            val replacement = state.command("replacement-command")
            assertEquals(RelayV2OutboxStateTag.REISSUED, original.state)
            assertEquals(RelayV2OutboxStateTag.QUEUED, replacement.state)
            assertEquals(fixture.context.commandDedupeWindow.windowId, replacement.dedupeWindowId)
            assertEquals(before.operation, replacement.operation)
            assertEquals(before.scopeId, replacement.scopeId)
            assertEquals(before.sessionId, replacement.sessionId)
            assertEquals(before.canonicalRequestArguments, replacement.canonicalRequestArguments)
            assertEquals(
                before.requestFingerprint.schemaVersion,
                replacement.requestFingerprint.schemaVersion,
            )
            assertEquals(99L, replacement.createdAtMillis)
        }

    @Test
    fun `missing command and dedupe or epoch mismatch expose no commit result`() = runBlocking {
        suspend fun assertRejected(
            fixture: Fixture,
            effect: RelayV2RuntimeEffect.ApplyCommandStatuses,
        ) {
            val writes = fixture.store.writeCount
            assertNull(fixture.apply(effect))
            assertEquals(writes, fixture.store.writeCount)
        }

        val missing = Fixture()
        missing.seed("present")
        val absent = TestCommand(RelayV2PendingCommand("absent", OLD_WINDOW), "session-absent")
        assertRejected(missing, missing.effect(absent, status(absent, "accepted")))

        val dedupe = Fixture()
        val command = dedupe.seed("dedupe").single()
        val wrongWindow = command.copy(
            pending = command.pending.copy(dedupeWindowId = "wrong-window"),
        )
        assertRejected(dedupe, dedupe.effect(wrongWindow, status(wrongWindow, "accepted")))

        val oldEpoch = Fixture(context = context(hostEpoch = "new-epoch"))
        oldEpoch.seed("old", hostEpoch = "old-epoch")
        val newLineage = TestCommand(RelayV2PendingCommand("old", OLD_WINDOW), "session-old")
        assertRejected(oldEpoch, oldEpoch.effect(newLineage, status(newLineage, "accepted")))
    }

    @Test
    fun `storage failure rolls back the batch and exposes no result`() = runBlocking {
        val fixture = Fixture()
        val commands = fixture.seed("first", "second")
        val before = fixture.repository.loadOutbox(fixture.namespace)
        val writes = fixture.store.writeCount
        fixture.store.failNextReplaceCommandId = "second"

        val result = runCatching {
            fixture.apply(
                fixture.effect(
                    commands,
                    commands.map { status(it, "succeeded") },
                ),
            )
        }

        assertTrue(result.isFailure)
        assertEquals(writes, fixture.store.writeCount)
        val after = fixture.repository.loadOutbox(fixture.namespace)
        assertEquals(before.nextCreationOrder, after.nextCreationOrder)
        assertEquals(before.entries, after.entries)
    }

    @Test
    fun `storage failure rolls back direct evidence without post commit output`() = runBlocking {
        val fixture = Fixture()
        val command = fixture.seedSending("direct-storage").single()
        val before = fixture.repository.loadOutbox(fixture.namespace)
        val writes = fixture.store.writeCount
        fixture.store.failNextReplaceCommandId = command.pending.commandId
        val effect = fixture.evidenceEffect(
            decodeEvidence(fixture.context, command, "command.result", "succeeded"),
        )

        val result = runCatching { fixture.handle(effect) }

        assertTrue(result.isFailure)
        assertEquals(writes, fixture.store.writeCount)
        val after = fixture.repository.loadOutbox(fixture.namespace)
        assertEquals(before.nextCreationOrder, after.nextCreationOrder)
        assertEquals(before.entries, after.entries)
    }

    @Test
    fun `repository identity mismatch exposes no receipt effect or write`() = runBlocking {
        val fixture = Fixture()
        val command = fixture.seed("identity").single()
        val effect = fixture.effect(command, status(command, "succeeded"))
        val mismatched = effect.copy(
            repositoryAuthority = effect.repositoryAuthority.copy(hostEpoch = "other-epoch"),
        )
        val writes = fixture.store.writeCount

        val result = runCatching { fixture.apply(mismatched) }

        assertTrue(result.isFailure)
        assertEquals(writes, fixture.store.writeCount)
        assertEquals(
            RelayV2OutboxStateTag.CONFIRMING,
            fixture.repository.loadOutbox(fixture.namespace).command("identity").state,
        )
    }

    @Test
    fun `reducer rejection exposes no receipt effect or write`() = runBlocking {
        val fixture = Fixture()
        val command = fixture.seed("rejected").single()
        val ambiguous = fixture.apply(
            fixture.effect(command, status(command, "unknown")),
        )
        requireNotNull(ambiguous)
        assertTrue(ambiguous.effects.isEmpty())
        val writes = fixture.store.writeCount

        val rejected = fixture.handle(
            fixture.effect(command, status(command, "accepted")),
        )

        assertEquals(
            RelayV2OutboxRecoveryApplyResult.Rejected(
                RelayV2OutboxRejection.STATUS_NOT_AUTHORIZING,
            ),
            rejected,
        )
        assertEquals(writes, fixture.store.writeCount)
        assertEquals(
            RelayV2OutboxStateTag.AMBIGUOUS,
            fixture.repository.loadOutbox(fixture.namespace).command("rejected").state,
        )
    }

    @Test
    fun `stale apply generation never enters repository or exposes effects`() = runBlocking {
        val fixture = Fixture()
        val command = fixture.seed("stale").single()
        val effect = fixture.effect(command, status(command, "succeeded"))
        val transactions = fixture.store.transactionCount
        val writes = fixture.store.writeCount
        fixture.lease.stale = true

        val result = fixture.handle(effect)

        assertEquals(RelayV2OutboxRecoveryApplyResult.Stale, result)
        assertEquals(0, fixture.lease.admittedBlocks)
        assertEquals(transactions, fixture.store.transactionCount)
        assertEquals(writes, fixture.store.writeCount)
        assertEquals(
            RelayV2OutboxStateTag.CONFIRMING,
            fixture.repository.loadOutbox(fixture.namespace).command("stale").state,
        )

        val direct = Fixture()
        val directCommand = direct.seedSending("stale-result").single()
        val directEffect = direct.evidenceEffect(
            decodeEvidence(direct.context, directCommand, "command.result", "succeeded"),
        )
        val directTransactions = direct.store.transactionCount
        val directWrites = direct.store.writeCount
        direct.lease.stale = true

        assertEquals(RelayV2OutboxRecoveryApplyResult.Stale, direct.handle(directEffect))
        assertEquals(0, direct.lease.admittedBlocks)
        assertEquals(directTransactions, direct.store.transactionCount)
        assertEquals(directWrites, direct.store.writeCount)
    }

    @Test
    fun `thirty two items commit but thirty three are rejected before storage`() = runBlocking {
        val fixture = Fixture()
        val commands = fixture.seed(*(1..32).map { "command-$it" }.toTypedArray())
        val statuses = commands.map { status(it, "accepted") }
        val committed = fixture.apply(fixture.effect(commands, statuses))
        requireNotNull(committed)
        assertEquals(32, committed.receipt.appliedCommands.size)
        assertTrue(committed.effects.isEmpty())
        val writes = fixture.store.writeCount

        val extra = TestCommand(RelayV2PendingCommand("command-33", OLD_WINDOW), "session-33")
        val oversized = fixture.effect(
            commands + extra,
            statuses,
        )
        assertTrue(runCatching { fixture.apply(oversized) }.isFailure)
        assertEquals(writes, fixture.store.writeCount)
    }

    private class Fixture(
        val context: RelayV2HandshakeContext = context(),
        ids: ArrayDeque<String> = ArrayDeque(),
    ) {
        val store = MemoryStore()
        val repository = RelayV2DurableStateRepositoryCore(store)
        val namespace = RelayV2OutboxAuthorityNamespace(
            context.profile.profileId,
            context.profile.activationGeneration,
            context.principalId,
            context.clientInstanceId,
        )
        private var fallbackId = 0
        val lease = TestApplyLease()
        val adapter = RelayV2OutboxRecoveryAdapter(
            lease,
            repository,
            newId = {
                ids.removeFirstOrNull() ?: "generated-${++fallbackId}"
            },
            clock = { 99L },
        )

        suspend fun apply(
            effect: RelayV2RuntimeEffect.ApplyCommandStatuses,
        ): RelayV2OutboxRecoveryCommit.CommandStatuses? =
            when (val result = adapter.handle(effect)) {
                is RelayV2OutboxRecoveryApplyResult.Committed ->
                    result.commit as RelayV2OutboxRecoveryCommit.CommandStatuses
                is RelayV2OutboxRecoveryApplyResult.Rejected -> null
                is RelayV2OutboxRecoveryApplyResult.ProtocolViolation ->
                    error("test effect violated protocol: ${result.reason}")
                is RelayV2OutboxRecoveryApplyResult.NotOwned ->
                    error("test effect was unexpectedly not owned")
                RelayV2OutboxRecoveryApplyResult.Stale ->
                    error("test lease unexpectedly rejected effect")
            }

        suspend fun handle(
            effect: RelayV2RuntimeEffect,
        ): RelayV2OutboxRecoveryApplyResult = adapter.handle(effect)

        suspend fun seed(
            vararg commandIds: String,
            hostEpoch: String = context.hostEpoch,
        ): List<TestCommand> = seedCommands(
            commandIds.map { commandId ->
                TestCommand(
                    RelayV2PendingCommand(commandId, OLD_WINDOW),
                    "session-$commandId",
                )
            },
            hostEpoch,
            beginQueries = true,
        )

        suspend fun seedSending(
            vararg commandIds: String,
            hostEpoch: String = context.hostEpoch,
        ): List<TestCommand> = seedCommands(
            commandIds.map { commandId ->
                TestCommand(
                    RelayV2PendingCommand(commandId, OLD_WINDOW),
                    "session-$commandId",
                )
            },
            hostEpoch,
            beginQueries = false,
        )

        private suspend fun seedCommands(
            commands: List<TestCommand>,
            hostEpoch: String,
            beginQueries: Boolean,
        ): List<TestCommand> {
            commands.forEachIndexed { index, command ->
                repository.reduceOutboxUnderApplyLease(
                    namespace,
                    RelayV2OutboxAction.Enqueue(
                        RelayV2OutboxDraft(
                            profileId = namespace.profileId,
                            principalId = namespace.principalId,
                            hostId = context.hostId,
                            expectedHostEpoch = hostEpoch,
                            dedupeWindowId = command.pending.dedupeWindowId,
                            commandId = command.pending.commandId,
                            scopeId = "scope-a",
                            sessionId = command.sessionId,
                            arguments = command.arguments,
                        ),
                        index.toLong() + 1,
                    ),
                ) as RelayV2OutboxResult.Applied
            }
            var entries = repository.loadOutbox(namespace).entries
            repository.reduceOutboxUnderApplyLease(
                namespace,
                RelayV2OutboxAction.DispatchEligible(
                    entries.associate { it.id to "execute-${it.commandId}" },
                    entries.size,
                ),
            ) as RelayV2OutboxResult.Applied
            if (!beginQueries) return commands
            entries = repository.loadOutbox(namespace).entries
            val queryIds = entries.chunked(RelayV2OutboxLimits.MAX_QUERY_ITEMS_PER_BATCH)
                .mapIndexed { index, _ -> if (index == 0) QUERY_ID else "$QUERY_ID-$index" }
            repository.reduceOutboxUnderApplyLease(
                namespace,
                RelayV2OutboxAction.BeginQueries(entries.map { it.id }, queryIds),
            ) as RelayV2OutboxResult.Applied
            return commands
        }

        fun evidenceEffect(
            message: RelayV2DecodedMessage,
        ): RelayV2RuntimeEffect.DeliverPostHandshakeFrame {
            val generation = RelayV2EffectGeneration(
                context.profile.profileId,
                context.profile.activationGeneration,
                1,
            )
            return RelayV2RuntimeEffect.DeliverPostHandshakeFrame(
                context = context,
                message = message,
                rawUtf8Bytes = message.canonicalWire.toByteArray(Charsets.UTF_8).size,
                generation = generation,
            )
        }

        fun effect(
            command: TestCommand,
            item: Map<String, Any?>,
        ): RelayV2RuntimeEffect.ApplyCommandStatuses = effect(listOf(command), listOf(item))

        fun effect(
            commands: List<TestCommand>,
            items: List<Map<String, Any?>>,
        ): RelayV2RuntimeEffect.ApplyCommandStatuses {
            val generation = RelayV2EffectGeneration(
                context.profile.profileId,
                context.profile.activationGeneration,
                1,
            )
            return RelayV2RuntimeEffect.ApplyCommandStatuses(
                context = context,
                message = decodeStatuses(context, items),
                expectedCommands = commands.map { it.pending },
                recovery = RelayV2RecoveryBinding(generation, 1, QUERY_ID),
            )
        }
    }

    private class TestApplyLease : RelayV2RepositoryEffectApplyLeasePort {
        var stale = false
        var admittedBlocks = 0
            private set

        override suspend fun <T> withEffectApplyLease(
            authority: RelayV2RepositoryEffectAuthority,
            block: suspend () -> T,
        ): RelayV2EffectApplyResult<T> {
            if (stale) return RelayV2EffectApplyResult.Stale
            admittedBlocks += 1
            return RelayV2EffectApplyResult.Applied(block())
        }
    }

    private class MemoryStore : RelayV2DurableStateStore, RelayV2DurableStateTransaction {
        private data class EntryKey(
            val namespace: RelayV2OutboxAuthorityNamespace,
            val hostId: String,
            val hostEpoch: String,
            val commandId: String,
        )

        private var metas = linkedMapOf<RelayV2OutboxAuthorityNamespace, RelayV2PersistedOutboxMeta>()
        private var entries = linkedMapOf<EntryKey, RelayV2PersistedOutboxEntry>()
        var failNextReplaceCommandId: String? = null
        var beforeNextTransaction: (() -> Unit)? = null
        var transactionCount = 0
            private set
        var writeCount = 0
            private set

        override suspend fun <T> transaction(block: RelayV2DurableStateTransaction.() -> T): T {
            transactionCount += 1
            beforeNextTransaction?.also {
                beforeNextTransaction = null
                it()
            }
            val metasBefore = LinkedHashMap(metas)
            val entriesBefore = LinkedHashMap(entries)
            val writesBefore = writeCount
            return try {
                block(this)
            } catch (failure: Throwable) {
                metas = metasBefore
                entries = entriesBefore
                writeCount = writesBefore
                throw failure
            }
        }

        override fun outboxMeta(
            namespace: RelayV2OutboxAuthorityNamespace,
        ): RelayV2PersistedOutboxMeta? = metas[namespace]

        override fun outboxEntries(
            namespace: RelayV2OutboxAuthorityNamespace,
        ): List<RelayV2PersistedOutboxEntry> = entries.values
            .filter { it.namespace == namespace }
            .sortedWith(compareBy({ it.createdOrder }, { it.commandId }))

        override fun putOutboxMeta(meta: RelayV2PersistedOutboxMeta) {
            writeCount += 1
            metas[meta.namespace] = meta
        }

        override fun insertOutboxEntry(entry: RelayV2PersistedOutboxEntry) {
            val key = entry.key()
            check(key !in entries)
            writeCount += 1
            entries[key] = entry
        }

        override fun replaceOutboxEntry(
            namespace: RelayV2OutboxAuthorityNamespace,
            previousId: RelayV2OutboxEntryId,
            replacement: RelayV2PersistedOutboxEntry,
        ): Boolean {
            if (failNextReplaceCommandId == previousId.commandId) {
                failNextReplaceCommandId = null
                error("injected replace failure")
            }
            val previousKey = EntryKey(
                namespace,
                previousId.hostId,
                previousId.expectedHostEpoch,
                previousId.commandId,
            )
            val previous = entries.remove(previousKey) ?: return false
            return try {
                insertOutboxEntry(replacement)
                true
            } catch (failure: Throwable) {
                entries[previousKey] = previous
                throw failure
            }
        }

        override fun terminalCheckpoint(
            key: RelayV2TerminalCheckpointKey,
        ): RelayV2PersistedTerminalCheckpoint? = null

        override fun putTerminalCheckpoint(checkpoint: RelayV2PersistedTerminalCheckpoint) =
            error("terminal storage is outside this test")

        private fun RelayV2PersistedOutboxEntry.key() = EntryKey(
            namespace,
            hostId,
            expectedHostEpoch,
            commandId,
        )
    }

    private data class TestCommand(
        val pending: RelayV2PendingCommand,
        val sessionId: String,
        val arguments: RelayV2OutboxArguments = RelayV2OutboxArguments.killSession(),
    )

    private companion object {
        const val OLD_WINDOW = "window-old"
        const val QUERY_ID = "query-a"

        fun context(hostEpoch: String = "epoch-a") = RelayV2HandshakeContext(
            profile = RelayActiveProfileIdentity("profile-v2", RelayProfileDialect.V2, 7),
            principalId = "principal-v2",
            clientInstanceId = "android-install-v2",
            hostId = "host-a",
            brokerEpoch = "broker-a",
            hostEpoch = hostEpoch,
            hostInstanceId = "host-instance-a",
            eventSeq = "10",
            negotiatedCapabilities = emptySet(),
            negotiatedLimits = RelayV2NegotiatedLimits(
                1_048_576,
                1_500_000,
                1_048_576,
                524_288,
                256,
                64,
                32,
                262_144,
                256,
                67_108_864,
                100_000,
                4_194_304,
                16_777_216,
                1_048_576,
                262_144,
                emptyMap(),
            ),
            commandDedupeWindow = RelayV2CommandDedupeWindow(
                "window-current",
                "2",
                1_000,
                2_000,
            ),
        )

        fun decodeEvidence(
            context: RelayV2HandshakeContext,
            command: TestCommand,
            type: String,
            state: String,
            requestId: String = "execute-${command.pending.commandId}",
            hostId: String = context.hostId,
            hostEpoch: String = context.hostEpoch,
            commandId: String = command.pending.commandId,
            dedupeWindowId: String = command.pending.dedupeWindowId,
            scopeId: String = "scope-a",
            sessionId: String = command.sessionId,
            result: Map<String, Any?>? = null,
        ): RelayV2DecodedMessage {
            require(type == "command.status" || type == "command.result")
            require(state in setOf("accepted", "running", "succeeded", "failed", "in_doubt"))
            if (type == "command.result") require(state !in setOf("accepted", "running"))
            val finalResult = if (state == "succeeded") {
                result ?: linkedMapOf(
                    "sessionId" to command.sessionId,
                    "terminated" to true,
                )
            } else {
                null
            }
            val payload = linkedMapOf<String, Any?>(
                "dedupeWindowId" to dedupeWindowId,
                "state" to state,
            ).apply {
                if (type == "command.status") put("deduplicated", false)
                put("updatedAtMs", 50L)
                if (type == "command.status") {
                    put("dedupeUntilMs", if (state in setOf("accepted", "running")) null else 1_000L)
                }
                put("result", finalResult)
            }
            val topLevelError = when (state) {
                "failed" -> error("COMMAND_FAILED", false, "completed")
                "in_doubt" -> error("COMMAND_IN_DOUBT", false, "in_doubt")
                else -> null
            }
            val frame = linkedMapOf<String, Any?>(
                "protocolVersion" to 2,
                "kind" to if (type == "command.status") "response" else "event",
                "type" to type,
            ).apply {
                if (type == "command.status") put("requestId", requestId)
                put("commandId", commandId)
                put("hostId", hostId)
                put("hostEpoch", hostEpoch)
                put("scopeId", scopeId)
                put("sessionId", sessionId)
                put("payload", payload)
                put("error", topLevelError)
            }
            val codec = RelayV2Codec()
            return codec.decodeWebSocketFrame(
                RelayV2WebSocketChannel.PUBLIC,
                codec.encodeWebSocketFrame(RelayV2WebSocketChannel.PUBLIC, frame),
            )
        }

        fun decodeStatuses(
            context: RelayV2HandshakeContext,
            items: List<Map<String, Any?>>,
        ): RelayV2DecodedMessage {
            val frame = linkedMapOf<String, Any?>(
                "protocolVersion" to 2,
                "kind" to "response",
                "type" to "command.statuses",
                "requestId" to QUERY_ID,
                "hostId" to context.hostId,
                "hostEpoch" to context.hostEpoch,
                "payload" to linkedMapOf(
                    "dedupeWatermark" to linkedMapOf(
                        "oldestQueryableWindowSeq" to "1",
                        "newestIssuedWindowSeq" to "2",
                        "observedAtMs" to 50L,
                    ),
                    "items" to items,
                ),
            )
            val codec = RelayV2Codec()
            return codec.decodeWebSocketFrame(
                RelayV2WebSocketChannel.PUBLIC,
                codec.encodeWebSocketFrame(RelayV2WebSocketChannel.PUBLIC, frame),
            )
        }

        fun status(command: TestCommand, state: String): Map<String, Any?> {
            val (wireState, retryable, retryAfter, reissue, dedupeUntil, result, error) =
                when (state) {
                    "accepted", "running" -> StatusFields(state)
                    "succeeded" -> StatusFields(
                        state,
                        dedupeUntilMs = 1_000L,
                        result = linkedMapOf(
                            "sessionId" to command.sessionId,
                            "terminated" to true,
                        ),
                    )
                    "failed" -> StatusFields(
                        state,
                        dedupeUntilMs = 1_000L,
                        error = error("COMMAND_FAILED", false, "completed"),
                    )
                    "in_doubt" -> StatusFields(
                        state,
                        dedupeUntilMs = 1_000L,
                        error = error("COMMAND_IN_DOUBT", false, "in_doubt"),
                    )
                    "expired" -> StatusFields(
                        state,
                        dedupeUntilMs = 1_000L,
                        error = error(
                            "COMMAND_RESULT_EXPIRED",
                            false,
                            "completed",
                            linkedMapOf("finalState" to "succeeded"),
                        ),
                    )
                    "unknown" -> StatusFields(
                        state,
                        error = error("COMMAND_STATUS_UNKNOWN", false, "in_doubt"),
                    )
                    "not_accepted" -> StatusFields(
                        state,
                        retryable = true,
                        retryAfterMs = 0L,
                        error = error("COMMAND_NOT_ACCEPTED", true, "not_accepted"),
                    )
                    "not_accepted_reissue" -> StatusFields(
                        "not_accepted",
                        reissueRequired = true,
                        error = error(
                            "COMMAND_WINDOW_EXPIRED",
                            false,
                            "not_accepted",
                            linkedMapOf("reissueRequired" to true),
                        ),
                    )
                    else -> error("unsupported test state")
                }
            return linkedMapOf(
                "commandId" to command.pending.commandId,
                "dedupeWindowId" to command.pending.dedupeWindowId,
                "state" to wireState,
                "updatedAtMs" to 50L,
                "dedupeUntilMs" to dedupeUntil,
                "retryable" to retryable,
                "retryAfterMs" to retryAfter,
                "reissueRequired" to reissue,
                "result" to result,
                "error" to error,
            )
        }

        fun error(
            code: String,
            retryable: Boolean,
            disposition: String,
            details: Map<String, Any?>? = null,
        ): Map<String, Any?> = linkedMapOf(
            "code" to code,
            "message" to "status evidence",
            "retryable" to retryable,
            "commandDisposition" to disposition,
            "details" to details,
        )

        data class StatusFields(
            val state: String,
            val retryable: Boolean = false,
            val retryAfterMs: Long? = null,
            val reissueRequired: Boolean = false,
            val dedupeUntilMs: Long? = null,
            val result: Map<String, Any?>? = null,
            val error: Map<String, Any?>? = null,
        )

        fun RelayV2OutboxState.command(commandId: String) =
            entries.single { it.commandId == commandId }

        @Suppress("UNCHECKED_CAST")
        fun RelayV2DecodedMessage.mutableFrame(): MutableMap<String, Any?> =
            frame as MutableMap<String, Any?>

        @Suppress("UNCHECKED_CAST")
        fun RelayV2DecodedMessage.mutablePayload(): MutableMap<String, Any?> =
            frame.getValue("payload") as MutableMap<String, Any?>
    }
}
