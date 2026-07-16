package com.tmuxworktree.mobile.core.relay.v2.state

import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2JsonLimits
import com.tmuxworktree.mobile.core.relay.v2.outbox.*
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2EffectGeneration
import com.tmuxworktree.mobile.core.relay.v2.terminal.*
import java.security.MessageDigest
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
                block(this).also { commitCount += 1 }
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

        fun corruptTerminal(key: RelayV2TerminalCheckpointKey) {
            val value = requireNotNull(terminals[key])
            terminals[key] = value.copy(
                payload = value.payload.copy(
                    payloadUtf8Bytes = value.payload.payloadUtf8Bytes + 1,
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

    private fun outboxNamespace() = RelayV2OutboxAuthorityNamespace(
        profileId = "profile-v2",
        profileActivationGeneration = 7,
        principalId = "principal-v2",
        clientInstanceId = "android-install-v2",
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

        fun sha256(value: ByteArray): String = MessageDigest.getInstance("SHA-256")
            .digest(value)
            .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
    }
}
