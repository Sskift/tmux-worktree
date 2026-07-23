package com.tmuxworktree.mobile.core.relay.v2.state

import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2JsonLimits
import com.tmuxworktree.mobile.core.relay.v2.outbox.*
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2EffectGeneration
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2RepositoryEffectAuthority
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2TerminalControlCodecBridge
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2TerminalExactGenerationSendPort
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2TerminalExactGenerationSendResult
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2Codec
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2WebSocketChannel
import com.tmuxworktree.mobile.core.relay.v2.terminal.*
import java.security.MessageDigest
import java.util.Base64
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RelayV2DurableStateRepositoryCoreTest {
    @Test
    fun `canonical storage envelope rejects each integrity failure`() {
        val limits = RelayV2JsonLimits(
            maxDepth = 4,
            maxDirectKeys = 4,
            maxTotalKeys = 4,
            maxNodes = 8,
        )
        val payload = RelayV2StorageJson.encode(
            codecVersion = 1,
            value = linkedMapOf("label" to "终端"),
        )
        assertEquals(
            payload.canonicalJson.toByteArray(Charsets.UTF_8).size,
            payload.payloadUtf8Bytes,
        )
        assertEquals(
            mapOf("label" to "终端"),
            RelayV2StorageJson.decode(payload, 1, 1_024, limits),
        )

        assertStorageFailure(RelayV2StorageFailure.LIMIT_EXCEEDED) {
            RelayV2StorageJson.decode(payload, 1, payload.payloadUtf8Bytes - 1, limits)
        }
        assertStorageFailure(RelayV2StorageFailure.MALFORMED) {
            RelayV2StorageJson.decode(
                payload.copy(payloadUtf8Bytes = payload.payloadUtf8Bytes + 1),
                1,
                1_024,
                limits,
            )
        }
        assertStorageFailure(RelayV2StorageFailure.MALFORMED) {
            RelayV2StorageJson.decode(
                payload.copy(sha256 = "0".repeat(64)),
                1,
                1_024,
                limits,
            )
        }

        val nonCanonicalJson = " ${payload.canonicalJson}"
        val nonCanonicalBytes = nonCanonicalJson.toByteArray(Charsets.UTF_8)
        assertStorageFailure(RelayV2StorageFailure.MALFORMED) {
            RelayV2StorageJson.decode(
                payload.copy(
                    payloadUtf8Bytes = nonCanonicalBytes.size,
                    canonicalJson = nonCanonicalJson,
                    sha256 = sha256(nonCanonicalBytes),
                ),
                1,
                1_024,
                limits,
            )
        }
        assertStorageFailure(RelayV2StorageFailure.SCHEMA_INCOMPATIBLE) {
            RelayV2StorageJson.decode(payload.copy(codecVersion = 2), 1, 1_024, limits)
        }
    }

    @Test
    fun `enqueue authority commits exact drafts in creation order before returning receipts`() =
        runBlocking {
            val store = MemoryStore()
            val repository = RelayV2DurableStateRepositoryCore(store)
            val namespace = outboxNamespace()
            val first = outboxDraft(namespace, "command-a", "session-a")
            val second = outboxDraft(namespace, "command-b", "session-b")

            val firstResult = repository.enqueueOutbox(namespace, first, createdAtMillis = 11)
            val secondResult = repository.enqueueOutbox(namespace, second, createdAtMillis = 12)

            assertEquals(
                RelayV2OutboxEnqueueReceipt("host-a", "epoch-a", "command-a", 0),
                (firstResult as RelayV2OutboxEnqueueResult.Committed).receipt,
            )
            assertEquals(
                RelayV2OutboxEnqueueReceipt("host-a", "epoch-a", "command-b", 1),
                (secondResult as RelayV2OutboxEnqueueResult.Committed).receipt,
            )
            val committed = repository.loadOutbox(namespace)
            assertEquals(2L, committed.nextCreationOrder)
            assertEquals(listOf(0L, 1L), committed.entries.map { it.createdOrder })
            assertEquals(listOf("command-a", "command-b"), committed.entries.map { it.commandId })
            assertTrue(committed.entries.all { it.state == RelayV2OutboxStateTag.QUEUED })
            assertEquals(first.scopeId, committed.entries.first().scopeId)
            assertEquals(first.sessionId, committed.entries.first().sessionId)
            assertEquals(first.arguments, committed.entries.first().canonicalRequestArguments.value)
        }

    @Test
    fun `enqueue authority rejects duplicate capacity and foreign activation without writes`() =
        runBlocking {
            val namespace = outboxNamespace()

            val duplicateStore = MemoryStore()
            val duplicateRepository = RelayV2DurableStateRepositoryCore(duplicateStore)
            val duplicateDraft = outboxDraft(namespace, "command-a", "session-a")
            duplicateRepository.enqueueOutbox(namespace, duplicateDraft, createdAtMillis = 1)
            val duplicateWrites = duplicateStore.writeCount
            assertEnqueueRejected(
                RelayV2OutboxEnqueueFailure.DUPLICATE_COMMAND,
                duplicateRepository.enqueueOutbox(namespace, duplicateDraft, createdAtMillis = 2),
            )
            assertEquals(duplicateWrites, duplicateStore.writeCount)
            assertEquals(
                listOf("command-a"),
                duplicateRepository.loadOutbox(namespace).entries.map { it.commandId },
            )

            val capacityStore = MemoryStore()
            val capacityRepository = RelayV2DurableStateRepositoryCore(
                capacityStore,
                RelayV2OutboxAuthorityCore(RelayV2OutboxCapacity(maxEntries = 1)),
            )
            capacityRepository.enqueueOutbox(
                namespace,
                outboxDraft(namespace, "command-a", "session-a"),
                createdAtMillis = 1,
            )
            val capacityWrites = capacityStore.writeCount
            assertEnqueueRejected(
                RelayV2OutboxEnqueueFailure.CAPACITY_EXCEEDED,
                capacityRepository.enqueueOutbox(
                    namespace,
                    outboxDraft(namespace, "command-b", "session-b"),
                    createdAtMillis = 2,
                ),
            )
            assertEquals(capacityWrites, capacityStore.writeCount)
            assertEquals(
                listOf("command-a"),
                capacityRepository.loadOutbox(namespace).entries.map { it.commandId },
            )

            val foreignStore = MemoryStore()
            val foreignRepository = RelayV2DurableStateRepositoryCore(foreignStore)
            foreignRepository.enqueueOutbox(
                namespace,
                outboxDraft(namespace, "command-a", "session-a"),
                createdAtMillis = 1,
            )
            val secondHostResult = foreignRepository.enqueueOutbox(
                namespace,
                outboxDraft(
                    namespace,
                    commandId = "command-b",
                    sessionId = "session-b",
                    hostId = "host-b",
                ),
                createdAtMillis = 2,
            )
            assertEquals(
                RelayV2OutboxEnqueueReceipt("host-b", "epoch-a", "command-b", 1),
                (secondHostResult as RelayV2OutboxEnqueueResult.Committed).receipt,
            )
            val foreignWrites = foreignStore.writeCount
            assertEnqueueRejected(
                RelayV2OutboxEnqueueFailure.FOREIGN_LINEAGE,
                foreignRepository.enqueueOutbox(
                    namespace,
                    outboxDraft(
                        namespace,
                        commandId = "command-c",
                        sessionId = "session-c",
                        profileId = "profile-foreign",
                    ),
                    createdAtMillis = 3,
                ),
            )
            assertEquals(foreignWrites, foreignStore.writeCount)
            assertEquals(
                listOf("host-a" to "command-a", "host-b" to "command-b"),
                foreignRepository.loadOutbox(namespace).entries.map { it.hostId to it.commandId },
            )
        }

    @Test
    fun `enqueue authority returns no receipt for corrupt unknown or failed store commits`() =
        runBlocking {
            val namespace = outboxNamespace()

            val failedStore = MemoryStore().apply { failNextCommit = true }
            val failedRepository = RelayV2DurableStateRepositoryCore(failedStore)
            assertEnqueueRejected(
                RelayV2OutboxEnqueueFailure.STORE_FAILURE,
                failedRepository.enqueueOutbox(
                    namespace,
                    outboxDraft(namespace, "command-a", "session-a"),
                    createdAtMillis = 1,
                ),
            )
            assertTrue(failedRepository.loadOutbox(namespace).entries.isEmpty())

            val corruptStore = MemoryStore()
            val corruptRepository = RelayV2DurableStateRepositoryCore(corruptStore)
            corruptRepository.enqueueOutbox(
                namespace,
                outboxDraft(namespace, "command-a", "session-a"),
                createdAtMillis = 1,
            )
            corruptStore.corruptEntry(namespace, "command-a")
            val corruptWrites = corruptStore.writeCount
            repeat(2) { attempt ->
                assertEnqueueRejected(
                    RelayV2OutboxEnqueueFailure.CORRUPT_STATE,
                    corruptRepository.enqueueOutbox(
                        namespace,
                        outboxDraft(namespace, "command-corrupt-$attempt", "session-corrupt"),
                        createdAtMillis = attempt.toLong() + 2,
                    ),
                )
            }
            assertEquals(corruptWrites, corruptStore.writeCount)

            val unknownStore = MemoryStore()
            val unknownRepository = RelayV2DurableStateRepositoryCore(unknownStore)
            unknownRepository.enqueueOutbox(
                namespace,
                outboxDraft(namespace, "command-a", "session-a"),
                createdAtMillis = 1,
            )
            unknownStore.rewriteMetaCodecVersion(namespace, 2)
            val unknownWrites = unknownStore.writeCount
            repeat(2) { attempt ->
                assertEnqueueRejected(
                    RelayV2OutboxEnqueueFailure.UNKNOWN_STATE,
                    unknownRepository.enqueueOutbox(
                        namespace,
                        outboxDraft(namespace, "command-unknown-$attempt", "session-unknown"),
                        createdAtMillis = attempt.toLong() + 2,
                    ),
                )
            }
            assertEquals(unknownWrites, unknownStore.writeCount)
        }

    @Test
    fun `atomic reissue commits original replacement and creation cursor together`() = runBlocking {
        val store = MemoryStore()
        val repository = RelayV2DurableStateRepositoryCore(store)
        val namespace = outboxNamespace()
        val draft = RelayV2OutboxDraft(
            profileId = namespace.profileId,
            principalId = namespace.principalId,
            hostId = "host-a",
            expectedHostEpoch = "epoch-a",
            dedupeWindowId = "window-a",
            commandId = "command-a",
            scopeId = "scope-a",
            sessionId = "session-a",
            arguments = RelayV2OutboxArguments.sendAgentMessage(0, "continue", true),
        )

        repository.reduceOutboxUnderApplyLease(
            namespace,
            RelayV2OutboxAction.Enqueue(draft, createdAtMillis = 1),
        ) as RelayV2OutboxResult.Applied
        var entry = repository.loadOutbox(namespace).entries.single()
        repository.reduceOutboxUnderApplyLease(
            namespace,
            RelayV2OutboxAction.DispatchEligible(
                mapOf(entry.id to "execute-a"),
                effectBudget = 1,
            ),
        ) as RelayV2OutboxResult.Applied
        entry = repository.loadOutbox(namespace).entries.single()
        repository.reduceOutboxUnderApplyLease(
            namespace,
            RelayV2OutboxAction.AttemptInterrupted(
                entry.id,
                entry.attempts.single().requestId,
                RelayV2AttemptInterruptionCause.DISCONNECTED,
            ),
        ) as RelayV2OutboxResult.Applied
        val confirming = repository.loadOutbox(namespace).entries.single()
        val reissue = RelayV2OutboxAction.ReconcileStatus(
            evidence = reissueRequiredNotAccepted(confirming),
            recovery = RelayV2OutboxRecovery.Reissue(
                replacementCommandId = "command-b",
                newDedupeWindowId = "window-b",
                replacementCreatedAtMillis = 2,
            ),
        )

        store.failNextInsertCommandId = "command-b"
        assertTrue(runCatching {
            repository.reduceOutboxUnderApplyLease(namespace, reissue)
        }.isFailure)
        val rolledBack = repository.loadOutbox(namespace)
        assertEquals(1L, rolledBack.nextCreationOrder)
        assertEquals(RelayV2OutboxStateTag.CONFIRMING, rolledBack.entries.single().state)
        assertFalse(rolledBack.entries.any { it.commandId == "command-b" })

        val commitCountBefore = store.commitCount
        val applied = repository.reduceOutboxUnderApplyLease(namespace, reissue)
            as RelayV2OutboxResult.Applied
        assertTrue(applied.transaction is RelayV2OutboxTransactionPlan.AtomicReissue)
        assertEquals(commitCountBefore + 1, store.commitCount)
        val committed = repository.loadOutbox(namespace)
        assertEquals(2L, committed.nextCreationOrder)
        assertEquals(
            listOf(RelayV2OutboxStateTag.REISSUED, RelayV2OutboxStateTag.QUEUED),
            committed.entries.map { it.state },
        )
        assertEquals(listOf(0L, 1L), committed.entries.map { it.createdOrder })
        assertEquals("command-b", committed.entries.first().replacementCommandId)
        assertEquals("command-a", committed.entries.last().reissuedFromCommandId)

        store.corruptEntry(namespace, "command-b")
        val writesBeforeCorruptLoad = store.writeCount
        val blocked = runCatching { repository.loadOutbox(namespace) }.exceptionOrNull()
        assertTrue(blocked is RelayV2StorageException)
        assertEquals(writesBeforeCorruptLoad, store.writeCount)
    }

    @Test
    fun `batch pre-reduction writes nothing when the second action is rejected`() = runBlocking {
        val store = MemoryStore()
        val repository = RelayV2DurableStateRepositoryCore(store)
        val namespace = outboxNamespace()
        listOf("a", "b").forEachIndexed { index, suffix ->
            repository.reduceOutboxUnderApplyLease(
                namespace,
                RelayV2OutboxAction.Enqueue(
                    RelayV2OutboxDraft(
                        profileId = namespace.profileId,
                        principalId = namespace.principalId,
                        hostId = "host-a",
                        expectedHostEpoch = "epoch-a",
                        dedupeWindowId = "window-a",
                        commandId = "command-$suffix",
                        scopeId = "scope-a",
                        sessionId = "session-$suffix",
                        arguments = RelayV2OutboxArguments.killSession(),
                    ),
                    createdAtMillis = index.toLong() + 1,
                ),
            ) as RelayV2OutboxResult.Applied
        }
        var entries = repository.loadOutbox(namespace).entries
        repository.reduceOutboxUnderApplyLease(
            namespace,
            RelayV2OutboxAction.DispatchEligible(
                entries.associate { it.id to "execute-${it.commandId}" },
                effectBudget = entries.size,
            ),
        ) as RelayV2OutboxResult.Applied
        entries = repository.loadOutbox(namespace).entries
        repository.reduceOutboxUnderApplyLease(
            namespace,
            RelayV2OutboxAction.BeginQueries(entries.map { it.id }, listOf("query-a")),
        ) as RelayV2OutboxResult.Applied
        entries = repository.loadOutbox(namespace).entries
        val writesBefore = store.writeCount

        val result = repository.reduceOutboxBatchUnderApplyLease(namespace) { current ->
            val first = current.entries.single { it.commandId == "command-a" }
            val second = current.entries.single { it.commandId == "command-b" }
            listOf(
                RelayV2OutboxAction.ReconcileStatus(
                    succeededKill(first),
                    RelayV2OutboxRecovery.None,
                ),
                RelayV2OutboxAction.ReconcileStatus(
                    succeededKill(second).copy(scopeId = "wrong-scope"),
                    RelayV2OutboxRecovery.None,
                ),
            )
        }

        assertTrue(result is RelayV2OutboxBatchResult.Rejected)
        assertEquals(writesBefore, store.writeCount)
        assertEquals(entries, repository.loadOutbox(namespace).entries)
    }

    @Test
    fun `terminal pre-open commits before effect and full fences round trip fail closed`() =
        runBlocking {
            val store = MemoryStore()
            val repository = RelayV2DurableStateRepositoryCore(store)
            val identity = terminalIdentity()
            val key = RelayV2TerminalCheckpointKey.from(identity.target())
            val delivery = terminalDelivery()
            val attempt = RelayV2TerminalOpenAttempt("open-a", "open-fingerprint-a")
            val begin = RelayV2TerminalAction.BeginOpenAttempt(
                deliveryToken = delivery,
                requestId = "open-request-a",
                openAttempt = attempt,
                mode = RelayV2TerminalOpenMode.NEW,
                cols = 120,
                rows = 36,
                target = identity.target(),
                parserContinuityId = PARSER_CONTINUITY,
                resume = null,
            )

            val begun = repository.reduceTerminalUnderApplyLease(key, begin)
            assertTrue(begun.effects.single() is RelayV2TerminalEffect.SendOpen)
            assertTrue(store.lastCommittedTerminal(key) is RelayV2TerminalStoredCheckpoint.PreOpen)

            var checkpoint = requireNotNull(
                repository.reduceTerminalUnderApplyLease(
                    key,
                    RelayV2TerminalAction.Opened(
                        identity = identity,
                        requestId = "open-request-a",
                        openAttempt = attempt,
                        deliveryToken = delivery,
                        parserContinuityId = PARSER_CONTINUITY,
                        disposition = RelayV2TerminalOpenDisposition.NEW,
                        cols = 120,
                        rows = 36,
                        replayFromOffset = "0",
                        tailOffset = "0",
                    ),
                ).checkpoint,
            )
            checkpoint = requireNotNull(
                repository.reduceTerminalUnderApplyLease(
                    key,
                    RelayV2TerminalAction.Output(
                        actionFence(checkpoint),
                        "0",
                        RelayV2TerminalBytes.utf8("abc"),
                    ),
                ).checkpoint,
            )
            checkpoint = requireNotNull(
                repository.reduceTerminalUnderApplyLease(
                    key,
                    RelayV2TerminalAction.EnqueueResize(
                        checkpoint.deliveryToken,
                        cols = 132,
                        rows = 40,
                    ),
                ).checkpoint,
            )
            checkpoint = requireNotNull(
                repository.reduceTerminalUnderApplyLease(
                    key,
                    RelayV2TerminalAction.EnqueueInput(
                        checkpoint.deliveryToken,
                        RelayV2TerminalBytes.utf8("input"),
                    ),
                ).checkpoint,
            )
            val queuedControls = repository.loadTerminal(key)
                as RelayV2TerminalStoredCheckpoint.Present
            assertEquals(checkpoint, queuedControls.checkpoint)
            assertNotNull(queuedControls.checkpoint.activeControlDispatchLease)
            assertTrue(queuedControls.checkpoint.pendingInputs.isNotEmpty())
            assertTrue(queuedControls.checkpoint.pendingResizes.isNotEmpty())
            checkpoint = requireNotNull(
                repository.reduceTerminalUnderApplyLease(
                    key,
                    RelayV2TerminalAction.AsyncResetRequired(
                        actionFence(checkpoint),
                        correlationProofId = "reset-proof-a",
                        reason = RelayV2TerminalResetReason.STREAM_LOST,
                        requestedOffset = "0",
                        bufferStartOffset = null,
                        tailOffset = null,
                    ),
                ).checkpoint,
            )
            checkpoint = requireNotNull(
                repository.reduceTerminalUnderApplyLease(
                    key,
                    RelayV2TerminalAction.RequestClose(
                        checkpoint.deliveryToken,
                        RelayV2TerminalCloseAttempt("close-a", "close-fingerprint-a"),
                        "close-request-a",
                    ),
                ).checkpoint,
            )
            val pendingClose = repository.loadTerminal(key)
                as RelayV2TerminalStoredCheckpoint.Present
            assertEquals("close-a", pendingClose.checkpoint.pendingClose?.closeAttempt?.closeId)
            assertTrue("close-request-a" in pendingClose.checkpoint.closeRequestIds)
            checkpoint = requireNotNull(
                repository.reduceTerminalUnderApplyLease(
                    key,
                    RelayV2TerminalAction.Closed(
                        fence = actionFence(checkpoint),
                        finalOffset = "3",
                        replayAvailable = false,
                        bufferStartOffset = null,
                        reason = RelayV2TerminalCloseReason.CLIENT_CLOSED,
                        exitCode = null,
                        closeId = "close-a",
                        requestId = "close-request-a",
                    ),
                ).checkpoint,
            )

            val restarted = RelayV2DurableStateRepositoryCore(store)
            val stored = restarted.loadTerminal(key) as RelayV2TerminalStoredCheckpoint.Present
            assertEquals(checkpoint, stored.checkpoint)
            assertTrue(
                runCatching {
                    restarted.reduceTerminalUnderApplyLease(
                        key,
                        RelayV2TerminalAction.RequestClose(
                            checkpoint.deliveryToken,
                            RelayV2TerminalCloseAttempt("close-b", "close-fingerprint-b"),
                            "close-request-b",
                        ),
                    )
                }.exceptionOrNull() is RelayV2TerminalRestoreRequiredException,
            )
            assertEquals(delivery, stored.checkpoint.deliveryToken)
            assertNotNull(stored.checkpoint.parserInFlightCallbackToken)
            assertTrue(stored.checkpoint.pendingOutput.isNotEmpty())
            assertTrue(
                stored.checkpoint.pendingInputs.isNotEmpty() ||
                    stored.checkpoint.ambiguousInputs.isNotEmpty(),
            )
            assertEquals(RelayV2TerminalResetReason.STREAM_LOST, stored.checkpoint.resetReason)
            assertTrue("close-request-a" in stored.checkpoint.closeRequestIds)
            assertEquals("3", stored.checkpoint.closed?.tombstone?.finalOffset)
            assertEquals(
                "close-a",
                stored.checkpoint.closed?.tombstone?.closeAttempt?.closeId,
            )

            store.corruptTerminal(key)
            val invalid = restarted.loadTerminal(key) as RelayV2TerminalStoredCheckpoint.Invalid
            assertEquals(RelayV2TerminalRestoreInvalidity.CORRUPT_QUEUE, invalid.reason)
            val reset = restarted.restoreTerminalUnderApplyLease(
                key,
                identity,
                attempt,
                delivery,
                PARSER_CONTINUITY,
            )
            assertEquals(
                RelayV2TerminalResetReason.CHECKPOINT_INVALID,
                (reset.outcome as RelayV2TerminalOutcome.ResetRequired).reason,
            )
            assertTrue(reset.effects.single() is RelayV2TerminalEffect.ResetRequired)

            val replacementAttempt = RelayV2TerminalOpenAttempt(
                "open-reset",
                "open-reset-fingerprint",
            )
            val replacement = restarted.reduceTerminalUnderApplyLease(
                key,
                RelayV2TerminalAction.BeginOpenAttempt(
                    deliveryToken = delivery,
                    requestId = "open-reset-request",
                    openAttempt = replacementAttempt,
                    mode = RelayV2TerminalOpenMode.RESET,
                    cols = 120,
                    rows = 36,
                    target = identity.target(),
                    parserContinuityId = "parser-reset",
                    resume = RelayV2TerminalOpenResume(
                        identity.generation,
                        null,
                        identity.resumeTokenCredentialReference,
                        identity.resumeTokenCredentialFingerprint,
                    ),
                ),
            )
            assertNotNull(replacement.preOpenCheckpoint)
            assertTrue(
                restarted.loadTerminal(key) is RelayV2TerminalStoredCheckpoint.PreOpen,
            )
        }

    @Test
    fun `resumable Session claim atomically preserves identity and emits exact RESUME`() =
        runBlocking {
            val store = MemoryStore()
            val repository = RelayV2DurableStateRepositoryCore(store)
            val rawResumeToken = "host-resume-token"
            val identity = terminalIdentity().copy(
                resumeTokenCredentialFingerprint = Base64.getUrlEncoder().withoutPadding()
                    .encodeToString(
                        MessageDigest.getInstance("SHA-256")
                            .digest(rawResumeToken.toByteArray()),
                    ),
            )
            val key = RelayV2TerminalCheckpointKey.from(identity.target())
            val originalDelivery = terminalDelivery()
            val originalAttempt = RelayV2TerminalOpenAttempt(
                "open-original",
                "open-original-fingerprint",
            )
            repository.reduceTerminalUnderApplyLease(
                key,
                RelayV2TerminalAction.BeginOpenAttempt(
                    originalDelivery,
                    "open-original-request",
                    originalAttempt,
                    RelayV2TerminalOpenMode.NEW,
                    120,
                    36,
                    identity.target(),
                    PARSER_CONTINUITY,
                    null,
                ),
            )
            val activeCheckpoint = requireNotNull(repository.reduceTerminalUnderApplyLease(
                key,
                RelayV2TerminalAction.Opened(
                    identity,
                    "open-original-request",
                    originalAttempt,
                    originalDelivery,
                    PARSER_CONTINUITY,
                    RelayV2TerminalOpenDisposition.NEW,
                    120,
                    36,
                    "0",
                    "0",
                ),
            ).checkpoint)
            val finalizedIdentity = identity.copy(
                streamId = "stream-finalized",
                resumeTokenCredentialReference = "resume-reference-finalized",
            )
            val finalizedKey = RelayV2TerminalCheckpointKey.from(finalizedIdentity.target())
            val finalizedAttempt = RelayV2TerminalOpenAttempt(
                "open-finalized",
                "open-finalized-fingerprint",
            )
            repository.reduceTerminalUnderApplyLease(
                finalizedKey,
                RelayV2TerminalAction.BeginOpenAttempt(
                    originalDelivery,
                    "open-finalized-request",
                    finalizedAttempt,
                    RelayV2TerminalOpenMode.NEW,
                    80,
                    24,
                    finalizedIdentity.target(),
                    PARSER_CONTINUITY,
                    null,
                ),
            )
            var finalized = requireNotNull(
                repository.reduceTerminalUnderApplyLease(
                    finalizedKey,
                    RelayV2TerminalAction.Opened(
                        finalizedIdentity,
                        "open-finalized-request",
                        finalizedAttempt,
                        originalDelivery,
                        PARSER_CONTINUITY,
                        RelayV2TerminalOpenDisposition.NEW,
                        80,
                        24,
                        "0",
                        "0",
                    ),
                ).checkpoint,
            )
            finalized = requireNotNull(
                repository.reduceTerminalUnderApplyLease(
                    finalizedKey,
                    RelayV2TerminalAction.RequestClose(
                        finalized.deliveryToken,
                        RelayV2TerminalCloseAttempt(
                            "close-finalized",
                            "close-finalized-fingerprint",
                        ),
                        "close-finalized-request",
                    ),
                ).checkpoint,
            )
            finalized = requireNotNull(
                repository.reduceTerminalUnderApplyLease(
                    finalizedKey,
                    RelayV2TerminalAction.Closed(
                        actionFence(finalized),
                        "0",
                        false,
                        null,
                        RelayV2TerminalCloseReason.CLIENT_CLOSED,
                        null,
                        "close-finalized",
                        "close-finalized-request",
                    ),
                ).checkpoint,
            )
            assertEquals(RelayV2TerminalPhase.FINALIZED, finalized.phase)

            val generation = RelayV2EffectGeneration("profile-v2", 7, 2)
            val authority = RelayV2RepositoryEffectAuthority(
                generation,
                "profile-v2",
                7,
                "principal-v2",
                "android-install-v2",
                "host-a",
                "epoch-a",
            )
            val resumedAttempt = RelayV2TerminalOpenAttempt(
                "open-resume",
                "open-resume-fingerprint",
            )
            val claim = requireNotNull(
                RelayV2DurableStateRepositoryCore(store)
                    .claimResumableTerminalUnderApplyLease(
                        RelayV2TerminalResumeSessionSelector(
                            "profile-v2",
                            7,
                            "principal-v2",
                            "android-install-v2",
                            "host-a",
                            "scope-a",
                            "session-a",
                            0,
                        ),
                        authority,
                        "open-resume-request",
                        resumedAttempt,
                        132,
                        40,
                    ),
            )

            assertEquals(key, claim.key)
            assertEquals(null, store.terminalCheckpoint(finalizedKey))
            val send = claim.reduction.effects
                .filterIsInstance<RelayV2TerminalEffect.SendOpen>()
                .single()
            assertEquals(RelayV2TerminalOpenMode.RESUME, send.mode)
            assertEquals(identity.target(), send.openFence.target)
            assertEquals(generation, send.openFence.deliveryToken.actorGeneration)
            assertEquals(
                originalDelivery.authorityGeneration + 1,
                send.openFence.deliveryToken.authorityGeneration,
            )
            assertEquals(1, send.openFence.deliveryToken.localDispatchToken)
            assertEquals(resumedAttempt, send.openFence.openAttempt)
            assertEquals(identity.generation, send.resume?.generation)
            assertEquals("0", send.resume?.nextOffset)
            assertEquals(identity.resumeTokenCredentialReference,
                send.resume?.resumeTokenCredentialReference)
            assertEquals(identity.resumeTokenCredentialFingerprint,
                send.resume?.resumeTokenCredentialFingerprint)

            var wireBytes: ByteArray? = null
            val wire = RelayV2TerminalControlCodecBridge(
                RelayV2TerminalExactGenerationSendPort { _, bytes ->
                    wireBytes = bytes
                    RelayV2TerminalExactGenerationSendResult.Sent
                },
            )
            val credentials = object : RelayV2TerminalResumeCredentialStore {
                override fun installExact(
                    owner: RelayV2TerminalResumeCredentialOwner,
                    reference: String,
                    resumeToken: String,
                ) = error("unexpected install")
                override fun read(
                    owner: RelayV2TerminalResumeCredentialOwner,
                    reference: String,
                ): String? = if (
                    owner == RelayV2TerminalResumeCredentialOwner("profile-v2", 7) &&
                    reference == identity.resumeTokenCredentialReference
                ) rawResumeToken else null
                override fun clear(
                    owner: RelayV2TerminalResumeCredentialOwner,
                    reference: String,
                ) = Unit
                override fun clearProfile(
                    profileId: String,
                    throughActivationGeneration: Long,
                ) = Unit
            }
            assertEquals(
                RelayV2TerminalExactGenerationSendResult.Sent,
                wire.sendCommittedEffect(authority, send, credentials),
            )
            val decoded = RelayV2Codec().decodeWebSocketFrame(
                RelayV2WebSocketChannel.PUBLIC,
                requireNotNull(wireBytes),
            ).frame
            val payload = decoded["payload"] as Map<*, *>
            val resume = payload["resume"] as Map<*, *>
            assertEquals("resume", payload["mode"])
            assertEquals(rawResumeToken, resume["resumeToken"])

            val duplicateStore = MemoryStore()
            listOf(
                activeCheckpoint,
                activeCheckpoint.copy(
                    identity = activeCheckpoint.identity.copy(streamId = "stream-duplicate"),
                ),
            ).forEach { checkpoint ->
                val duplicateKey = RelayV2TerminalCheckpointKey.from(
                    checkpoint.identity.target(),
                )
                val encoded = RelayV2TerminalCheckpointCodec.encode(
                    duplicateKey,
                    RelayV2TerminalStoredCheckpoint.Present(checkpoint),
                )
                duplicateStore.putTerminalCheckpoint(
                    RelayV2PersistedTerminalCheckpoint(
                        duplicateKey,
                        encoded.kind.name,
                        encoded.payload,
                    ),
                )
            }
            val duplicateFailure = runCatching {
                RelayV2DurableStateRepositoryCore(duplicateStore)
                    .claimResumableTerminalUnderApplyLease(
                        RelayV2TerminalResumeSessionSelector(
                            "profile-v2",
                            7,
                            "principal-v2",
                            "android-install-v2",
                            "host-a",
                            "scope-a",
                            "session-a",
                            0,
                        ),
                        authority,
                        "duplicate-resume-request",
                        RelayV2TerminalOpenAttempt(
                            "duplicate-resume",
                            "duplicate-resume-fingerprint",
                        ),
                        132,
                        40,
                    )
            }.exceptionOrNull()
            assertTrue(duplicateFailure is IllegalStateException)
        }

    @Test
    fun `legacy schema and parser recovery markers normalize through durable round trips`() =
        runBlocking {
            val store = MemoryStore()
            val repository = RelayV2DurableStateRepositoryCore(store)
            val identity = terminalIdentity()
            val key = RelayV2TerminalCheckpointKey.from(identity.target())
            val delivery = terminalDelivery()
            val attempt = RelayV2TerminalOpenAttempt("open-v7", "open-v7-fingerprint")
            repository.reduceTerminalUnderApplyLease(
                key,
                RelayV2TerminalAction.BeginOpenAttempt(
                    delivery,
                    "open-v7-request",
                    attempt,
                    RelayV2TerminalOpenMode.NEW,
                    120,
                    36,
                    identity.target(),
                    PARSER_CONTINUITY,
                    null,
                ),
            )
            store.rewriteTerminalAsLegacyV7(key)
            val preOpen = repository.loadTerminal(key) as RelayV2TerminalStoredCheckpoint.PreOpen
            assertEquals(
                RelayV2TerminalCheckpointLimits.SCHEMA_VERSION,
                preOpen.checkpoint.schemaVersion,
            )
            assertStorageFailure(RelayV2StorageFailure.SCHEMA_INCOMPATIBLE) {
                RelayV2TerminalCheckpointCodec.encode(
                    key,
                    RelayV2TerminalStoredCheckpoint.PreOpen(
                        preOpen.checkpoint.copy(schemaVersion = 7),
                    ),
                )
            }

            var checkpoint = requireNotNull(
                repository.reduceTerminalUnderApplyLease(
                    key,
                    RelayV2TerminalAction.Opened(
                        identity,
                        "open-v7-request",
                        attempt,
                        delivery,
                        PARSER_CONTINUITY,
                        RelayV2TerminalOpenDisposition.NEW,
                        120,
                        36,
                        "0",
                        "0",
                    ),
                ).checkpoint,
            )
            checkpoint = requireNotNull(
                repository.reduceTerminalUnderApplyLease(
                    key,
                    RelayV2TerminalAction.EnqueueInput(
                        checkpoint.deliveryToken,
                        RelayV2TerminalBytes.utf8("legacy-input"),
                    ),
                ).checkpoint,
            )
            checkpoint = requireNotNull(
                repository.reduceTerminalUnderApplyLease(
                    key,
                    RelayV2TerminalAction.EnqueueResize(checkpoint.deliveryToken, 132, 40),
                ).checkpoint,
            )
            store.rewriteTerminalAsLegacyV7(key)

            val present = RelayV2DurableStateRepositoryCore(store).loadTerminal(key)
                as RelayV2TerminalStoredCheckpoint.Present
            assertEquals(
                RelayV2TerminalCheckpointLimits.SCHEMA_VERSION,
                present.checkpoint.schemaVersion,
            )
            assertEquals("1", present.checkpoint.nextControlDispatchAttemptSeq)
            assertEquals(null, present.checkpoint.pendingParserDispatchClaim)
            assertEquals(null, present.checkpoint.pendingParserEffectHandoff)
            assertEquals(null, present.checkpoint.pendingParserEffectHandoffResetReason)
            assertEquals(null, present.checkpoint.pendingParserEffectActivation)
            assertTrue(present.checkpoint.pendingInputs.all { it.dispatchClaim == null })
            assertTrue(present.checkpoint.pendingResizes.all { it.dispatchClaim == null })
            assertEquals(
                checkpoint.pendingInputs.map { it.inputSeq },
                present.checkpoint.pendingInputs.map { it.inputSeq },
            )
            assertStorageFailure(RelayV2StorageFailure.SCHEMA_INCOMPATIBLE) {
                RelayV2TerminalCheckpointCodec.encode(
                    key,
                    RelayV2TerminalStoredCheckpoint.Present(
                        present.checkpoint.copy(schemaVersion = 7),
                    ),
                )
            }

            ParserRecoveryMarker.entries.forEach { marker ->
                listOf(false, true).forEach { freshDelivery ->
                    assertParserRecoveryMarkerRoundTrip(
                        marker = marker,
                        freshDelivery = freshDelivery,
                    )
                }
            }
        }

    private enum class ParserRecoveryMarker {
        CLAIM,
        HANDOFF,
        ACTIVATION,
    }

    private suspend fun assertParserRecoveryMarkerRoundTrip(
        marker: ParserRecoveryMarker,
        freshDelivery: Boolean,
    ) {
        val store = MemoryStore()
        val repository = RelayV2DurableStateRepositoryCore(store)
        val identity = terminalIdentity()
        val key = RelayV2TerminalCheckpointKey.from(identity.target())
        val storedDelivery = terminalDelivery()
        val attempt = RelayV2TerminalOpenAttempt(
            "open-marker-${marker.name}-${freshDelivery}",
            "open-marker-fingerprint-${marker.name}-${freshDelivery}",
        )
        repository.reduceTerminalUnderApplyLease(
            key,
            RelayV2TerminalAction.BeginOpenAttempt(
                storedDelivery,
                "open-marker-request",
                attempt,
                RelayV2TerminalOpenMode.NEW,
                120,
                36,
                identity.target(),
                PARSER_CONTINUITY,
                null,
            ),
        )
        var checkpoint = requireNotNull(
            repository.reduceTerminalUnderApplyLease(
                key,
                RelayV2TerminalAction.Opened(
                    identity,
                    "open-marker-request",
                    attempt,
                    storedDelivery,
                    PARSER_CONTINUITY,
                    RelayV2TerminalOpenDisposition.NEW,
                    120,
                    36,
                    "0",
                    "0",
                ),
            ).checkpoint,
        )
        val write = repository.reduceTerminalUnderApplyLease(
            key,
            RelayV2TerminalAction.Output(
                actionFence(checkpoint),
                "0",
                RelayV2TerminalBytes.utf8("marker"),
            ),
        ).effects.filterIsInstance<RelayV2TerminalEffect.WriteParser>().single()
        val claimed = repository.reduceTerminalUnderApplyLease(
            key,
            RelayV2TerminalAction.ClaimParserDispatch(write),
        )
        val parserClaim = (claimed.outcome as RelayV2TerminalOutcome.ParserDispatchClaimed)
            .claim as RelayV2TerminalParserDispatchClaim.Write
        checkpoint = requireNotNull(claimed.checkpoint)
        when (marker) {
            ParserRecoveryMarker.CLAIM -> {
                assertEquals(parserClaim, checkpoint.pendingParserDispatchClaim)
                assertEquals(null, checkpoint.pendingParserEffectHandoff)
                assertEquals(null, checkpoint.pendingParserEffectActivation)
            }
            ParserRecoveryMarker.HANDOFF,
            ParserRecoveryMarker.ACTIVATION,
            -> checkpoint = requireNotNull(
                repository.reduceTerminalUnderApplyLease(
                    key,
                    RelayV2TerminalAction.ParserApplied(parserClaim),
                ).checkpoint,
            )
        }
        if (marker != ParserRecoveryMarker.CLAIM) {
            val callbackToken = requireNotNull(checkpoint.pendingParserEffectHandoff)
            if (marker == ParserRecoveryMarker.ACTIVATION) {
                checkpoint = requireNotNull(
                    repository.reduceTerminalUnderApplyLease(
                        key,
                        RelayV2TerminalAction.ParserEffectsReserved(
                            RelayV2TerminalParserEffectActivation(
                                callbackToken,
                                "reservation-marker",
                                "batch-marker",
                            ),
                        ),
                    ).checkpoint,
                )
                assertEquals(null, checkpoint.pendingParserEffectHandoff)
                assertNotNull(checkpoint.pendingParserEffectActivation)
            } else {
                assertEquals(callbackToken, checkpoint.pendingParserEffectHandoff)
                assertEquals(null, checkpoint.pendingParserEffectActivation)
            }
        }

        val currentDelivery = if (freshDelivery) {
            storedDelivery.copy(localDispatchToken = storedDelivery.localDispatchToken + 1)
        } else {
            storedDelivery
        }
        val restarted = RelayV2DurableStateRepositoryCore(store)
        val firstRestore = restarted.restoreTerminalUnderApplyLease(
            key,
            identity,
            attempt,
            currentDelivery,
            PARSER_CONTINUITY,
        )
        assertEquals(
            RelayV2TerminalResetReason.STREAM_LOST,
            (firstRestore.outcome as RelayV2TerminalOutcome.ResetRequired).reason,
        )
        val normalized = (restarted.loadTerminal(key) as
            RelayV2TerminalStoredCheckpoint.Present).checkpoint
        assertEquals(RelayV2TerminalPhase.RESET_REQUIRED, normalized.phase)
        assertEquals(RelayV2TerminalResetReason.STREAM_LOST, normalized.resetReason)
        assertEquals(currentDelivery, normalized.deliveryToken)
        assertEquals(null, normalized.parserResetCallbackToken)
        assertEquals(null, normalized.parserInFlightCallbackToken)
        assertEquals(null, normalized.lastAppliedParserCallbackToken)
        assertEquals(null, normalized.pendingParserDispatchClaim)
        assertEquals(null, normalized.pendingParserEffectHandoff)
        assertEquals(null, normalized.pendingParserEffectHandoffResetReason)
        assertEquals(null, normalized.pendingParserEffectActivation)

        val secondRestart = RelayV2DurableStateRepositoryCore(store)
        val secondRestore = secondRestart.restoreTerminalUnderApplyLease(
            key,
            identity,
            attempt,
            currentDelivery,
            PARSER_CONTINUITY,
        )
        assertEquals(
            RelayV2TerminalResetReason.STREAM_LOST,
            (secondRestore.outcome as RelayV2TerminalOutcome.ResetRequired).reason,
        )
        assertEquals(normalized, secondRestore.checkpoint)
    }

    private class MemoryStore : RelayV2DurableStateStore, RelayV2DurableStateTransaction {
        private data class EntryKey(
            val namespace: RelayV2OutboxAuthorityNamespace,
            val hostId: String,
            val expectedHostEpoch: String,
            val commandId: String,
        )

        private var metas = linkedMapOf<RelayV2OutboxAuthorityNamespace, RelayV2PersistedOutboxMeta>()
        private var entries = linkedMapOf<EntryKey, RelayV2PersistedOutboxEntry>()
        private var terminals = linkedMapOf<
            RelayV2TerminalCheckpointKey,
            RelayV2PersistedTerminalCheckpoint
            >()
        var failNextInsertCommandId: String? = null
        var failNextCommit = false
        var commitCount = 0
            private set
        var writeCount = 0
            private set

        override suspend fun <T> transaction(block: RelayV2DurableStateTransaction.() -> T): T {
            val metasBefore = LinkedHashMap(metas)
            val entriesBefore = LinkedHashMap(entries)
            val terminalsBefore = LinkedHashMap(terminals)
            val writesBefore = writeCount
            return try {
                val result = block(this)
                if (failNextCommit) {
                    failNextCommit = false
                    error("injected commit failure")
                }
                commitCount += 1
                result
            } catch (failure: Throwable) {
                metas = metasBefore
                entries = entriesBefore
                terminals = terminalsBefore
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
            if (failNextInsertCommandId == entry.commandId) {
                failNextInsertCommandId = null
                error("injected insert failure")
            }
            val key = entry.key()
            check(key !in entries)
            check(entries.values.none {
                it.namespace == entry.namespace && it.createdOrder == entry.createdOrder
            })
            writeCount += 1
            entries[key] = entry
        }

        override fun replaceOutboxEntry(
            namespace: RelayV2OutboxAuthorityNamespace,
            previousId: RelayV2OutboxEntryId,
            replacement: RelayV2PersistedOutboxEntry,
        ): Boolean {
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
        ): RelayV2PersistedTerminalCheckpoint? = terminals[key]

        override fun terminalCheckpointsForSession(
            selector: RelayV2TerminalResumeSessionSelector,
            hostEpoch: String,
        ): List<RelayV2PersistedTerminalCheckpoint> = terminals.values.filter { row ->
            val key = row.key
            key.profileId == selector.profileId &&
                key.profileActivationGeneration == selector.profileActivationGeneration &&
                key.principalId == selector.principalId &&
                key.clientInstanceId == selector.clientInstanceId &&
                key.hostId == selector.hostId && key.hostEpoch == hostEpoch &&
                key.scopeId == selector.scopeId && key.sessionId == selector.sessionId &&
                key.pane == selector.pane
        }.take(257)

        override fun deleteTerminalCheckpoint(key: RelayV2TerminalCheckpointKey): Boolean =
            terminals.remove(key) != null

        override fun putTerminalCheckpoint(checkpoint: RelayV2PersistedTerminalCheckpoint) {
            writeCount += 1
            terminals[checkpoint.key] = checkpoint
        }

        fun corruptEntry(namespace: RelayV2OutboxAuthorityNamespace, commandId: String) {
            val (key, value) = entries.entries.single {
                it.key.namespace == namespace && it.key.commandId == commandId
            }
            entries[key] = value.copy(
                payload = value.payload.copy(sha256 = "0".repeat(64)),
            )
        }

        fun rewriteMetaCodecVersion(
            namespace: RelayV2OutboxAuthorityNamespace,
            codecVersion: Int,
        ) {
            val value = requireNotNull(metas[namespace])
            metas[namespace] = value.copy(
                payload = value.payload.copy(codecVersion = codecVersion),
            )
        }

        fun corruptTerminal(key: RelayV2TerminalCheckpointKey) {
            val value = requireNotNull(terminals[key])
            terminals[key] = value.copy(
                payload = value.payload.copy(
                    payloadUtf8Bytes = value.payload.payloadUtf8Bytes + 1,
                ),
            )
        }

        @Suppress("UNCHECKED_CAST")
        fun rewriteTerminalAsLegacyV7(key: RelayV2TerminalCheckpointKey) {
            val value = requireNotNull(terminals[key])
            val root = LinkedHashMap(
                RelayV2StorageJson.decode(
                    value.payload,
                    RelayV2TerminalCheckpointCodec.CODEC_VERSION,
                    4 * 1024 * 1024,
                    RelayV2JsonLimits(
                        maxDepth = 32,
                        maxDirectKeys = 128,
                        maxTotalKeys = 300_000,
                        maxNodes = 600_000,
                    ),
                ),
            )
            val checkpoint = LinkedHashMap(root["checkpoint"] as Map<String, Any?>)
            checkpoint["schemaVersion"] = 7
            checkpoint.remove("nextControlDispatchAttemptSeq")
            checkpoint.remove("pendingParserDispatchClaim")
            checkpoint.remove("pendingParserEffectHandoff")
            checkpoint.remove("pendingParserEffectHandoffResetReason")
            checkpoint.remove("pendingParserEffectActivation")
            checkpoint["pendingInputs"]?.let { pendingInputs ->
                checkpoint["pendingInputs"] = (pendingInputs as List<*>).map { item ->
                    LinkedHashMap(item as Map<String, Any?>).apply {
                        remove("dispatchClaim")
                    }
                }
            }
            checkpoint["pendingResizes"]?.let { pendingResizes ->
                checkpoint["pendingResizes"] = (pendingResizes as List<*>).map { item ->
                    LinkedHashMap(item as Map<String, Any?>).apply {
                        remove("dispatchClaim")
                    }
                }
            }
            root["checkpoint"] = checkpoint
            terminals[key] = value.copy(
                payload = RelayV2StorageJson.encode(
                    RelayV2TerminalCheckpointCodec.CODEC_VERSION,
                    root,
                ),
            )
        }

        fun lastCommittedTerminal(
            key: RelayV2TerminalCheckpointKey,
        ): RelayV2TerminalStoredCheckpoint {
            val value = requireNotNull(terminals[key])
            return RelayV2TerminalCheckpointCodec.decode(key, value.kind, value.payload)
        }

        private fun RelayV2PersistedOutboxEntry.key(): EntryKey = EntryKey(
            namespace,
            hostId,
            expectedHostEpoch,
            commandId,
        )
    }

    private fun reissueRequiredNotAccepted(
        entry: RelayV2OutboxEntry,
    ): RelayV2CommandStatusEvidence = RelayV2CommandStatusEvidence(
        entryId = entry.id,
        dedupeWindowId = entry.dedupeWindowId,
        hostEpoch = entry.expectedHostEpoch,
        scopeId = entry.scopeId,
        sessionId = entry.sessionId,
        operation = entry.operation,
        source = RelayV2CommandStatusSource.EXECUTE_RESPONSE,
        attemptKind = RelayV2OutboxAttemptKind.EXECUTE,
        state = RelayV2CommandStatusState.NOT_ACCEPTED,
        attemptRequestId = entry.attempts.last().requestId,
        retryable = false,
        reissueRequired = true,
        errorCode = "COMMAND_WINDOW_EXPIRED",
        commandDisposition = RelayV2CommandDisposition.NOT_ACCEPTED,
        detailsReissueRequired = true,
    )

    private fun succeededKill(entry: RelayV2OutboxEntry) = RelayV2CommandStatusEvidence(
        entryId = entry.id,
        dedupeWindowId = entry.dedupeWindowId,
        hostEpoch = entry.expectedHostEpoch,
        scopeId = entry.scopeId,
        sessionId = entry.sessionId,
        operation = entry.operation,
        source = RelayV2CommandStatusSource.QUERY_RESPONSE,
        attemptKind = RelayV2OutboxAttemptKind.QUERY,
        state = RelayV2CommandStatusState.SUCCEEDED,
        attemptRequestId = "query-a",
        result = RelayV2CommandResult.KilledSession(requireNotNull(entry.sessionId), true),
    )

    private fun outboxNamespace() = RelayV2OutboxAuthorityNamespace(
        profileId = "profile-v2",
        profileActivationGeneration = 7,
        principalId = "principal-v2",
        clientInstanceId = "android-install-v2",
    )

    private fun outboxDraft(
        namespace: RelayV2OutboxAuthorityNamespace,
        commandId: String,
        sessionId: String,
        hostId: String = "host-a",
        profileId: String = namespace.profileId,
    ) = RelayV2OutboxDraft(
        profileId = profileId,
        principalId = namespace.principalId,
        hostId = hostId,
        expectedHostEpoch = "epoch-a",
        dedupeWindowId = "window-a",
        commandId = commandId,
        scopeId = "scope-a",
        sessionId = sessionId,
        arguments = RelayV2OutboxArguments.sendAgentMessage(0, "continue", true),
    )

    private fun terminalIdentity() = RelayV2TerminalIdentity(
        profileId = "profile-v2",
        profileActivationGeneration = 7,
        principalId = "principal-v2",
        clientInstanceId = "android-install-v2",
        hostId = "host-a",
        hostEpoch = "epoch-a",
        hostInstanceId = "host-process-a",
        scopeId = "scope-a",
        sessionId = "session-a",
        streamId = "stream-a",
        generation = "generation-a",
        resumeTokenCredentialReference = "resume-reference-a",
        resumeTokenCredentialFingerprint = "resume-fingerprint-a",
    )

    private fun terminalDelivery() = RelayV2TerminalDeliveryToken(
        RelayV2EffectGeneration("profile-v2", 7, 1),
        authorityGeneration = 1,
        localDispatchToken = 1,
    )

    private fun actionFence(
        checkpoint: RelayV2TerminalCheckpoint,
    ): RelayV2TerminalActionFence = RelayV2TerminalActionFence(
        checkpoint.identity.binding(),
        checkpoint.deliveryToken,
        checkpoint.openAttempt.openId,
    )

    private companion object {
        const val PARSER_CONTINUITY = "parser-a"

        fun assertStorageFailure(
            expected: RelayV2StorageFailure,
            block: () -> Unit,
        ) {
            val failure = runCatching(block).exceptionOrNull()
            assertTrue(failure is RelayV2StorageException)
            assertEquals(expected, (failure as RelayV2StorageException).failure)
        }

        fun assertEnqueueRejected(
            expected: RelayV2OutboxEnqueueFailure,
            result: RelayV2OutboxEnqueueResult,
        ) {
            assertTrue(result is RelayV2OutboxEnqueueResult.Rejected)
            assertEquals(expected, (result as RelayV2OutboxEnqueueResult.Rejected).failure)
        }

        fun sha256(value: ByteArray): String = MessageDigest.getInstance("SHA-256")
            .digest(value)
            .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
    }
}
