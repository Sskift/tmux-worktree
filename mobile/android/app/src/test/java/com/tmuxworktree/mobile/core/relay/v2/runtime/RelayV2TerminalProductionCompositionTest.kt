package com.tmuxworktree.mobile.core.relay.v2.runtime

import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2Codec
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2WebSocketChannel
import com.tmuxworktree.mobile.core.relay.v2.state.*
import com.tmuxworktree.mobile.core.relay.v2.terminal.*
import java.security.MessageDigest
import java.util.Base64
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RelayV2TerminalProductionCompositionTest {
    @Test
    fun `detach waits for durable open claim and new stream owns a distinct checkpoint`() = runBlocking {
        val terminal = BlockingTerminalAuthority()
        val sent = mutableListOf<ByteArray>()
        var nextId = 0
        val composition = RelayV2TerminalProductionComposition(
            applyLease = object : RelayV2RepositoryEffectApplyLeasePort {
                override suspend fun <T> withEffectApplyLease(
                    authority: RelayV2RepositoryEffectAuthority,
                    block: suspend () -> T,
                ) = RelayV2EffectApplyResult.Applied(block())
            },
            terminal = terminal,
            journal = EmptyJournal(),
            credentials = EmptyCredentials(),
            sendPort = RelayV2TerminalExactGenerationSendPort { _, bytes ->
                sent += bytes
                RelayV2TerminalExactGenerationSendResult.Sent
            },
            fatalInvalidation = object : RelayV2TerminalFatalInvalidationPort {
                override suspend fun invalidate(
                    authority: RelayV2RepositoryEffectAuthority,
                    key: RelayV2TerminalCheckpointKey,
                    reason: RelayV2TerminalFatalInvalidationReason,
                ) = error("unexpected terminal invalidation")
            },
            newId = { "operation-${++nextId}" },
        )
        val target = RelayV2TerminalAttachmentTarget(
            "profile-a",
            7,
            "principal-a",
            "client-a",
            "host-a",
            "scope-a",
            "session-a",
        )
        val parser = object : RelayV2TerminalParserPort {
            override suspend fun write(
                callbackToken: RelayV2TerminalParserCallbackToken,
                bytes: ByteArray,
                completion: suspend (Boolean) -> Unit,
            ) = false

            override suspend fun reset(
                callbackToken: RelayV2TerminalParserCallbackToken,
                completion: suspend (Boolean) -> Unit,
            ) = false
        }
        val authority = RelayV2RepositoryEffectAuthority(
            RelayV2EffectGeneration("profile-a", 7, 1),
            "profile-a",
            7,
            "principal-a",
            "client-a",
            "host-a",
            "epoch-a",
        )
        val first = composition.attach(target, parser)
        val opening = async { composition.open(first, authority, 120, 36) }
        terminal.claimEntered.await()
        val detaching = async { composition.detach(first) }
        yield()
        assertFalse(detaching.isCompleted)

        terminal.releaseClaim.complete(Unit)
        assertTrue(opening.await())
        detaching.await()
        assertEquals(1, sent.size)

        val second = composition.attach(target, parser)
        assertTrue(composition.open(second, authority, 120, 36))
        assertEquals(listOf(1L, 1L), terminal.beginOpenDeliveries.map { it.localDispatchToken })
        assertEquals(2, terminal.beginOpenKeys.distinct().size)
    }

    @Test
    fun `old credential clear failure preserves committed replacement credential`() = runBlocking {
        val owner = RelayV2TerminalResumeCredentialOwner("profile-a", 7)
        val oldToken = "old-resume-token"
        val newToken = "new-resume-token"
        val terminal = ResumeTerminalAuthority(oldToken)
        val credentials = FailingOldClearCredentials(
            owner,
            terminal.oldReference,
            oldToken,
        )
        var sent: ByteArray? = null
        var nextId = 0
        val composition = RelayV2TerminalProductionComposition(
            applyLease = CurrentApplyLease,
            terminal = terminal,
            journal = EmptyJournal(),
            credentials = credentials,
            sendPort = RelayV2TerminalExactGenerationSendPort { _, bytes ->
                sent = bytes
                RelayV2TerminalExactGenerationSendResult.Sent
            },
            fatalInvalidation = UnexpectedInvalidation,
            newId = { "resume-operation-${++nextId}" },
        )
        val authority = terminal.authority
        val attachment = composition.attach(terminal.attachmentTarget, RejectingParser)
        assertTrue(composition.open(attachment, authority, 120, 36))
        val open = RelayV2Codec().decodeWebSocketFrame(
            RelayV2WebSocketChannel.PUBLIC,
            requireNotNull(sent),
        ).frame
        val openPayload = open["payload"] as Map<*, *>
        val openedBytes = RelayV2Codec().encodeWebSocketFrame(
            RelayV2WebSocketChannel.PUBLIC,
            linkedMapOf(
                "protocolVersion" to 2L,
                "kind" to "response",
                "type" to "terminal.opened",
                "requestId" to open["requestId"],
                "hostId" to open["hostId"],
                "hostEpoch" to open["expectedHostEpoch"],
                "scopeId" to open["scopeId"],
                "sessionId" to open["sessionId"],
                "streamId" to open["streamId"],
                "hostInstanceId" to "host-process-b",
                "payload" to linkedMapOf(
                    "openId" to openPayload["openId"],
                    "deduplicated" to false,
                    "generation" to "generation-b",
                    "resumeToken" to newToken,
                    "disposition" to "new",
                    "replayFromOffset" to "0",
                    "bufferStartOffset" to "0",
                    "tailOffset" to "0",
                    "maxUnackedBytes" to 524_288L,
                    "resetReason" to null,
                ),
            ),
        )
        val opened = RelayV2Codec().decodeWebSocketFrame(
            RelayV2WebSocketChannel.PUBLIC,
            openedBytes,
        )

        val failure = runCatching {
            composition.handlePublicFrame(authority, opened)
        }.exceptionOrNull()

        assertTrue(failure is IllegalStateException)
        val checkpoint = terminal.currentCheckpoint()
        val newReference = checkpoint.identity.resumeTokenCredentialReference
        assertFalse(newReference == terminal.oldReference)
        assertEquals(newToken, credentials.read(owner, newReference))
        assertEquals(oldToken, credentials.read(owner, terminal.oldReference))
        val restored = RelayV2TerminalCheckpointReducer.restore(
            RelayV2TerminalStoredCheckpoint.Present(checkpoint),
            checkpoint.identity,
            checkpoint.openAttempt,
            checkpoint.deliveryToken,
            checkpoint.parserContinuityId,
        )
        assertTrue(restored.outcome is RelayV2TerminalOutcome.Restored)
    }

    @Test
    fun `generic public errors resolve only their exact durable terminal owner`() = runBlocking {
        val codec = RelayV2Codec()
        val terminal = BlockingTerminalAuthority()
        terminal.releaseClaim.complete(Unit)
        var nextId = 0
        val composition = RelayV2TerminalProductionComposition(
            applyLease = CurrentApplyLease,
            terminal = terminal,
            journal = EmptyJournal(),
            credentials = EmptyCredentials(),
            sendPort = RelayV2TerminalExactGenerationSendPort { _, _ ->
                RelayV2TerminalExactGenerationSendResult.Sent
            },
            fatalInvalidation = UnexpectedInvalidation,
            newId = { "correlated-${++nextId}" },
        )
        val target = RelayV2TerminalAttachmentTarget(
            "profile-a",
            7,
            "principal-a",
            "client-a",
            "host-a",
            "scope-a",
            "session-a",
        )
        val authority = RelayV2RepositoryEffectAuthority(
            RelayV2EffectGeneration("profile-a", 7, 1),
            "profile-a",
            7,
            "principal-a",
            "client-a",
            "host-a",
            "epoch-a",
        )
        val attachment = composition.attach(target, RejectingParser)
        assertTrue(composition.open(attachment, authority, 120, 36))
        val key = terminal.beginOpenKeys.single()
        val preOpen = (terminal.stored(key) as RelayV2TerminalStoredCheckpoint.PreOpen).checkpoint
        val initialPendingOpen = requireNotNull(preOpen.pendingOpen)
        val identity = RelayV2TerminalIdentity(
            profileId = preOpen.target.profileId,
            profileActivationGeneration = preOpen.target.profileActivationGeneration,
            principalId = preOpen.target.principalId,
            clientInstanceId = preOpen.target.clientInstanceId,
            hostId = preOpen.target.hostId,
            hostEpoch = preOpen.target.hostEpoch,
            hostInstanceId = "host-instance-a",
            scopeId = preOpen.target.scopeId,
            sessionId = preOpen.target.sessionId,
            streamId = preOpen.target.streamId,
            generation = "generation-a",
            resumeTokenCredentialReference = "resume-reference-a",
            resumeTokenCredentialFingerprint = "resume-fingerprint-a",
            pane = preOpen.target.pane,
        )
        val opened = RelayV2TerminalCheckpointReducer.reduce(
            preOpen,
            RelayV2TerminalAction.Opened(
                identity = identity,
                requestId = initialPendingOpen.requestId,
                openAttempt = initialPendingOpen.openAttempt,
                deliveryToken = initialPendingOpen.deliveryToken,
                parserContinuityId = initialPendingOpen.parserContinuityId,
                disposition = RelayV2TerminalOpenDisposition.NEW,
                cols = initialPendingOpen.cols,
                rows = initialPendingOpen.rows,
                replayFromOffset = "0",
                tailOffset = "0",
            ),
        )
        val present = requireNotNull(opened.checkpoint)
        val resume = RelayV2TerminalOpenResume(
            generation = present.identity.generation,
            nextOffset = present.parserAppliedNextOffset,
            resumeTokenCredentialReference = present.identity.resumeTokenCredentialReference,
            resumeTokenCredentialFingerprint = present.identity.resumeTokenCredentialFingerprint,
        )
        val pendingOpen = requireNotNull(
            RelayV2TerminalCheckpointReducer.reduce(
                present,
                RelayV2TerminalAction.BeginOpenAttempt(
                    deliveryToken = present.deliveryToken,
                    requestId = "present-open-request",
                    openAttempt = RelayV2TerminalOpenAttempt(
                        "present-open-attempt",
                        "present-open-fingerprint",
                    ),
                    mode = RelayV2TerminalOpenMode.RESUME,
                    cols = present.openedCols,
                    rows = present.openedRows,
                    target = present.identity.target(),
                    parserContinuityId = present.parserContinuityId,
                    resume = resume,
                ),
            ).checkpoint,
        )
        val fence = RelayV2TerminalActionFence(
            present.identity.binding(),
            present.deliveryToken,
            present.openAttempt.openId,
        )
        val pendingReplay = requireNotNull(
            RelayV2TerminalCheckpointReducer.reduce(
                present,
                RelayV2TerminalAction.Output(
                    fence,
                    "1",
                    RelayV2TerminalBytes.of(byteArrayOf(1)),
                ),
            ).checkpoint,
        )
        val pendingClose = requireNotNull(
            RelayV2TerminalCheckpointReducer.reduce(
                present,
                RelayV2TerminalAction.RequestClose(
                    present.deliveryToken,
                    RelayV2TerminalCloseAttempt("close-attempt", "close-fingerprint"),
                    "close-request",
                ),
            ).checkpoint,
        )

        fun decodedError(
            requestId: String,
            disposition: String = "not_applicable",
            streamId: String = identity.streamId,
            retryable: Boolean = false,
            message: String = "terminal request rejected",
            retryAfterMs: Long? = null,
        ) = codec.decodeWebSocketFrame(
            RelayV2WebSocketChannel.PUBLIC,
            codec.encodeWebSocketFrame(
                RelayV2WebSocketChannel.PUBLIC,
                linkedMapOf(
                    "protocolVersion" to 2L,
                    "kind" to "response",
                    "type" to "error",
                    "requestId" to requestId,
                    "hostId" to identity.hostId,
                    "hostEpoch" to identity.hostEpoch,
                    "scopeId" to identity.scopeId,
                    "sessionId" to identity.sessionId,
                    "streamId" to streamId,
                    "payload" to null,
                    "error" to linkedMapOf(
                        "code" to "INTERNAL",
                        "message" to message,
                        "retryable" to retryable,
                        "retryAfterMs" to retryAfterMs,
                        "commandDisposition" to disposition,
                        "details" to null,
                    ),
                ),
            ),
        )

        data class ErrorCase(
            val name: String,
            val stored: RelayV2TerminalStoredCheckpoint,
            val requestId: String,
            val expected: RelayV2TerminalFrameResult,
            val disposition: String = "not_applicable",
            val streamId: String = identity.streamId,
            val retryable: Boolean = false,
            val message: String = "terminal request rejected",
            val retryAfterMs: Long? = null,
        )

        val presentOpenStored = RelayV2TerminalStoredCheckpoint.Present(pendingOpen)
        val presentReplayStored = RelayV2TerminalStoredCheckpoint.Present(pendingReplay)
        val presentCloseStored = RelayV2TerminalStoredCheckpoint.Present(pendingClose)
        listOf(
            ErrorCase(
                "pre-open owned",
                RelayV2TerminalStoredCheckpoint.PreOpen(preOpen),
                initialPendingOpen.requestId,
                RelayV2TerminalFrameResult.Applied,
            ),
            ErrorCase(
                "present pending open owned",
                presentOpenStored,
                requireNotNull(pendingOpen.pendingOpen).requestId,
                RelayV2TerminalFrameResult.Applied,
            ),
            ErrorCase(
                "present pending replay owned",
                presentReplayStored,
                requireNotNull(pendingReplay.pendingReplay).requestId,
                RelayV2TerminalFrameResult.Applied,
            ),
            ErrorCase(
                "present pending close owned",
                presentCloseStored,
                requireNotNull(pendingClose.pendingClose).requestId,
                RelayV2TerminalFrameResult.Applied,
            ),
            ErrorCase(
                "foreign bad disposition",
                presentReplayStored,
                "foreign-request",
                RelayV2TerminalFrameResult.NotOwned,
                disposition = "not_accepted",
            ),
            ErrorCase(
                "owned wrong stream",
                presentReplayStored,
                requireNotNull(pendingReplay.pendingReplay).requestId,
                RelayV2TerminalFrameResult.ProtocolViolation,
                streamId = "foreign-stream",
            ),
            ErrorCase(
                "owned bad disposition",
                presentCloseStored,
                requireNotNull(pendingClose.pendingClose).requestId,
                RelayV2TerminalFrameResult.ProtocolViolation,
                disposition = "not_accepted",
            ),
            ErrorCase(
                "owned metadata variant one",
                presentOpenStored,
                requireNotNull(pendingOpen.pendingOpen).requestId,
                RelayV2TerminalFrameResult.Applied,
                retryable = false,
                message = "first public message",
            ),
            ErrorCase(
                "owned metadata variant two",
                presentOpenStored,
                requireNotNull(pendingOpen.pendingOpen).requestId,
                RelayV2TerminalFrameResult.Applied,
                retryable = true,
                message = "different public message",
                retryAfterMs = 25,
            ),
        ).forEach { case ->
            terminal.install(key, case.stored)
            assertEquals(
                case.name,
                case.expected,
                composition.handlePublicFrame(
                    authority,
                    decodedError(
                        requestId = case.requestId,
                        disposition = case.disposition,
                        streamId = case.streamId,
                        retryable = case.retryable,
                        message = case.message,
                        retryAfterMs = case.retryAfterMs,
                    ),
                ),
            )
            assertEquals(case.name, case.stored, terminal.stored(key))
        }

        terminal.install(key, RelayV2TerminalStoredCheckpoint.Present(present))
        val output = codec.decodeWebSocketFrame(
            RelayV2WebSocketChannel.PUBLIC,
            codec.encodeWebSocketFrame(
                RelayV2WebSocketChannel.PUBLIC,
                linkedMapOf(
                    "protocolVersion" to 2L,
                    "kind" to "event",
                    "type" to "terminal.output",
                    "streamId" to identity.streamId,
                    "payload" to linkedMapOf(
                        "generation" to identity.generation,
                        "offset" to "0",
                        "encoding" to "base64",
                        "data" to "eA==",
                    ),
                ),
            ),
        )
        assertEquals(
            RelayV2TerminalFrameResult.EffectRejected,
            composition.handlePublicFrame(authority, output),
        )
    }

    private object CurrentApplyLease : RelayV2RepositoryEffectApplyLeasePort {
        override suspend fun <T> withEffectApplyLease(
            authority: RelayV2RepositoryEffectAuthority,
            block: suspend () -> T,
        ) = RelayV2EffectApplyResult.Applied(block())
    }

    private object UnexpectedInvalidation : RelayV2TerminalFatalInvalidationPort {
        override suspend fun invalidate(
            authority: RelayV2RepositoryEffectAuthority,
            key: RelayV2TerminalCheckpointKey,
            reason: RelayV2TerminalFatalInvalidationReason,
        ) = error("unexpected terminal invalidation")
    }

    private object RejectingParser : RelayV2TerminalParserPort {
        override suspend fun write(
            callbackToken: RelayV2TerminalParserCallbackToken,
            bytes: ByteArray,
            completion: suspend (Boolean) -> Unit,
        ) = false

        override suspend fun reset(
            callbackToken: RelayV2TerminalParserCallbackToken,
            completion: suspend (Boolean) -> Unit,
        ) = false
    }

    private class ResumeTerminalAuthority(oldToken: String) : RelayV2TerminalRecoveryAuthority {
        val authority = RelayV2RepositoryEffectAuthority(
            RelayV2EffectGeneration("profile-a", 7, 2),
            "profile-a",
            7,
            "principal-a",
            "client-a",
            "host-a",
            "epoch-a",
        )
        val attachmentTarget = RelayV2TerminalAttachmentTarget(
            "profile-a",
            7,
            "principal-a",
            "client-a",
            "host-a",
            "scope-a",
            "session-a",
        )
        val oldReference = "old-reference"
        private val key: RelayV2TerminalCheckpointKey
        private var stored: RelayV2TerminalStoredCheckpoint
        private var replacementPreOpen: RelayV2TerminalPreOpenCheckpoint? = null

        init {
            val identity = RelayV2TerminalIdentity(
                profileId = "profile-a",
                profileActivationGeneration = 7,
                principalId = "principal-a",
                clientInstanceId = "client-a",
                hostId = "host-a",
                hostEpoch = "epoch-a",
                hostInstanceId = "host-process-a",
                scopeId = "scope-a",
                sessionId = "session-a",
                streamId = "stream-a",
                generation = "generation-a",
                resumeTokenCredentialReference = oldReference,
                resumeTokenCredentialFingerprint = fingerprint(oldToken),
            )
            key = RelayV2TerminalCheckpointKey.from(identity.target())
            val delivery = RelayV2TerminalDeliveryToken(
                RelayV2EffectGeneration("profile-a", 7, 1),
                1,
                1,
            )
            val attempt = RelayV2TerminalOpenAttempt("open-a", "open-a-fingerprint")
            val preOpen = RelayV2TerminalCheckpointReducer.reduce(
                null,
                RelayV2TerminalAction.BeginOpenAttempt(
                    delivery,
                    "request-a",
                    attempt,
                    RelayV2TerminalOpenMode.NEW,
                    120,
                    36,
                    identity.target(),
                    "parser-a",
                    null,
                ),
            )
            val opened = RelayV2TerminalCheckpointReducer.reduce(
                requireNotNull(preOpen.preOpenCheckpoint),
                RelayV2TerminalAction.Opened(
                    identity,
                    "request-a",
                    attempt,
                    delivery,
                    "parser-a",
                    RelayV2TerminalOpenDisposition.NEW,
                    120,
                    36,
                    "0",
                    "0",
                ),
            )
            stored = RelayV2TerminalStoredCheckpoint.Present(requireNotNull(opened.checkpoint))
        }

        override suspend fun claimResumableTerminalUnderApplyLease(
            selector: RelayV2TerminalResumeSessionSelector,
            authority: RelayV2RepositoryEffectAuthority,
            requestId: String,
            openAttempt: RelayV2TerminalOpenAttempt,
            cols: Int,
            rows: Int,
        ): RelayV2TerminalResumeClaim {
            val checkpoint = (stored as RelayV2TerminalStoredCheckpoint.Present).checkpoint
            val delivery = RelayV2TerminalDeliveryToken(
                authority.generation,
                checkpoint.deliveryToken.authorityGeneration + 1,
                1,
            )
            val reduced = RelayV2TerminalCheckpointReducer.reduce(
                null,
                RelayV2TerminalAction.BeginOpenAttempt(
                    delivery,
                    requestId,
                    openAttempt,
                    RelayV2TerminalOpenMode.NEW,
                    cols,
                    rows,
                    checkpoint.identity.target(),
                    checkpoint.parserContinuityId,
                    null,
                ),
            )
            replacementPreOpen = requireNotNull(reduced.preOpenCheckpoint)
            return RelayV2TerminalResumeClaim(key, reduced)
        }

        override suspend fun loadTerminalUnderApplyLease(key: RelayV2TerminalCheckpointKey) = stored

        override suspend fun reduceTerminalUnderApplyLease(
            key: RelayV2TerminalCheckpointKey,
            action: RelayV2TerminalAction,
        ): RelayV2TerminalReduction {
            replacementPreOpen?.let { pending ->
                val reduced = RelayV2TerminalCheckpointReducer.reduce(pending, action)
                replacementPreOpen = null
                stored = RelayV2TerminalStoredCheckpoint.Present(requireNotNull(reduced.checkpoint))
                return reduced
            }
            val checkpoint = (stored as RelayV2TerminalStoredCheckpoint.Present).checkpoint
            val reduced = RelayV2TerminalCheckpointReducer.reduce(checkpoint, action)
            stored = RelayV2TerminalStoredCheckpoint.Present(requireNotNull(reduced.checkpoint))
            return reduced
        }

        fun currentCheckpoint() = (stored as RelayV2TerminalStoredCheckpoint.Present).checkpoint

        override suspend fun recoverPostCommitUnknown(
            authority: RelayV2RepositoryEffectAuthority,
            key: RelayV2TerminalCheckpointKey,
        ) = null
    }

    private class FailingOldClearCredentials(
        private val owner: RelayV2TerminalResumeCredentialOwner,
        private val oldReference: String,
        oldToken: String,
    ) : RelayV2TerminalResumeCredentialStore {
        private val values = mutableMapOf(oldReference to oldToken)

        override fun installExact(
            owner: RelayV2TerminalResumeCredentialOwner,
            reference: String,
            resumeToken: String,
        ): RelayV2TerminalResumeCredentialInstall? {
            check(owner == this.owner)
            val existing = values[reference]
            if (existing != null && existing != resumeToken) return null
            values[reference] = resumeToken
            return RelayV2TerminalResumeCredentialInstall(
                fingerprint(resumeToken),
                existing == null,
            )
        }

        override fun read(owner: RelayV2TerminalResumeCredentialOwner, reference: String): String? {
            check(owner == this.owner)
            return values[reference]
        }

        override fun clear(owner: RelayV2TerminalResumeCredentialOwner, reference: String) {
            check(owner == this.owner)
            if (reference == oldReference) error("injected old credential clear failure")
            values.remove(reference)
        }

        override fun clearProfile(profileId: String, throughActivationGeneration: Long) = Unit
    }

    private class BlockingTerminalAuthority : RelayV2TerminalRecoveryAuthority {
        val claimEntered = CompletableDeferred<Unit>()
        val releaseClaim = CompletableDeferred<Unit>()
        val beginOpenDeliveries = mutableListOf<RelayV2TerminalDeliveryToken>()
        val beginOpenKeys = mutableListOf<RelayV2TerminalCheckpointKey>()
        private val checkpoints = mutableMapOf<RelayV2TerminalCheckpointKey, RelayV2TerminalStoredCheckpoint>()

        override suspend fun claimResumableTerminalUnderApplyLease(
            selector: RelayV2TerminalResumeSessionSelector,
            authority: RelayV2RepositoryEffectAuthority,
            requestId: String,
            openAttempt: RelayV2TerminalOpenAttempt,
            cols: Int,
            rows: Int,
        ): RelayV2TerminalResumeClaim? {
            claimEntered.complete(Unit)
            releaseClaim.await()
            return null
        }

        override suspend fun loadTerminalUnderApplyLease(
            key: RelayV2TerminalCheckpointKey,
        ) = checkpoints[key] ?: RelayV2TerminalStoredCheckpoint.Missing

        override suspend fun reduceTerminalUnderApplyLease(
            key: RelayV2TerminalCheckpointKey,
            action: RelayV2TerminalAction,
        ): RelayV2TerminalReduction {
            if (action is RelayV2TerminalAction.BeginOpenAttempt) {
                beginOpenDeliveries += action.deliveryToken
                beginOpenKeys += key
            }
            val stored = checkpoints[key] ?: RelayV2TerminalStoredCheckpoint.Missing
            val reduced = when (stored) {
                RelayV2TerminalStoredCheckpoint.Missing ->
                    RelayV2TerminalCheckpointReducer.reduce(null, action)
                is RelayV2TerminalStoredCheckpoint.PreOpen ->
                    RelayV2TerminalCheckpointReducer.reduce(stored.checkpoint, action)
                is RelayV2TerminalStoredCheckpoint.Present ->
                    RelayV2TerminalCheckpointReducer.reduce(stored.checkpoint, action)
                is RelayV2TerminalStoredCheckpoint.Invalid -> error("invalid test checkpoint")
            }
            reduced.preOpenCheckpoint?.let {
                checkpoints[key] = RelayV2TerminalStoredCheckpoint.PreOpen(it)
            }
            reduced.checkpoint?.let {
                checkpoints[key] = RelayV2TerminalStoredCheckpoint.Present(it)
            }
            return reduced
        }

        override suspend fun recoverPostCommitUnknown(
            authority: RelayV2RepositoryEffectAuthority,
            key: RelayV2TerminalCheckpointKey,
        ): RelayV2TerminalReduction? = null

        fun stored(key: RelayV2TerminalCheckpointKey): RelayV2TerminalStoredCheckpoint =
            checkpoints.getValue(key)

        fun install(
            key: RelayV2TerminalCheckpointKey,
            checkpoint: RelayV2TerminalStoredCheckpoint,
        ) {
            checkpoints[key] = checkpoint
        }
    }

    private class EmptyCredentials : RelayV2TerminalResumeCredentialStore {
        override fun installExact(
            owner: RelayV2TerminalResumeCredentialOwner,
            reference: String,
            resumeToken: String,
        ): RelayV2TerminalResumeCredentialInstall? = error("unexpected credential install")

        override fun read(owner: RelayV2TerminalResumeCredentialOwner, reference: String) = null
        override fun clear(owner: RelayV2TerminalResumeCredentialOwner, reference: String) = Unit
        override fun clearProfile(profileId: String, throughActivationGeneration: Long) = Unit
    }

    private class EmptyJournal :
        RelayV2TerminalPostCommitJournalStore,
        RelayV2TerminalPostCommitJournalTransaction {
        private val fences = mutableMapOf<String, RelayV2TerminalPostCommitFenceEntity>()
        override suspend fun <T> transaction(
            block: RelayV2TerminalPostCommitJournalTransaction.() -> T,
        ): T = block(this)
        override fun unsettledBatches() = emptyList<RelayV2TerminalPostCommitBatchEntity>()
        override fun allBatches() = emptyList<RelayV2TerminalPostCommitBatchEntity>()
        override fun batch(reservationId: String) = null
        override fun fifoHead() = null
        override fun unsettledBatchCount() = 0
        override fun terminalOutcomeCount() = 0
        override fun insertBatch(batch: RelayV2TerminalPostCommitBatchEntity) = batch
        override fun updateBatch(batch: RelayV2TerminalPostCommitBatchEntity) = false
        override fun deleteBatch(reservationId: String) = false
        override fun fence(authorityFingerprint: String) = fences[authorityFingerprint]
        override fun fenceCount() = fences.size
        override fun insertFence(fence: RelayV2TerminalPostCommitFenceEntity) {
            fences[fence.authorityFingerprint] = fence
        }
        override fun batchesForAuthority(authorityFingerprint: String) =
            emptyList<RelayV2TerminalPostCommitBatchEntity>()
        override fun deleteBatchesForAuthority(authorityFingerprint: String) = Unit
        override fun globallyClosed() = false
        override fun closeGlobally() = Unit
        override fun deleteAllBatches() = Unit
        override fun terminalCheckpoint(key: RelayV2TerminalCheckpointKey) = null
    }

    private companion object {
        fun fingerprint(token: String): String =
            Base64.getUrlEncoder().withoutPadding().encodeToString(
                MessageDigest.getInstance("SHA-256").digest(token.toByteArray()),
            )
    }
}
