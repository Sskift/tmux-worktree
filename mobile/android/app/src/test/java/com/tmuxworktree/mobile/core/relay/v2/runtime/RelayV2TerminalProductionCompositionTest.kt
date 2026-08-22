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
    fun `authority pressure stays terminal scoped for old host compatibility`() {
        assertEquals(
            RelayV2TerminalControlError.GAP,
            relayV2TerminalControlError("BUSY", retryable = true),
        )
        assertEquals(
            RelayV2TerminalControlError.CONFLICT,
            relayV2TerminalControlError("COMMAND_IN_DOUBT", retryable = false),
        )
        assertEquals(
            RelayV2TerminalControlError.GAP,
            relayV2TerminalControlError("TERMINAL_INPUT_GAP", retryable = false),
        )
    }

    @Test
    fun `pre-open dispose natural close wins pending receipt and allows fresh open`() =
        runBlocking {
            val codec = RelayV2Codec()
            val terminal = BlockingTerminalAuthority(resumeExisting = true).also {
                it.releaseClaim.complete(Unit)
            }
            val credentials = RecordingCredentials()
            val sent = mutableListOf<ByteArray>()
            val invalidated = mutableListOf<Pair<RelayV2RepositoryEffectAuthority, RelayV2TerminalCheckpointKey>>()
            val invalidation = object : RelayV2TerminalFatalInvalidationPort {
                override suspend fun invalidate(
                    authority: RelayV2RepositoryEffectAuthority,
                    key: RelayV2TerminalCheckpointKey,
                    reason: RelayV2TerminalFatalInvalidationReason,
                ) {
                    assertEquals(
                        RelayV2TerminalFatalInvalidationReason.DETACHED_OPEN_RESPONSE,
                        reason,
                    )
                    invalidated += authority to key
                }
            }
            var openedCount = 0
            var resetCount = 0
            var closedCount = 0
            var detachedRetryCount = 0
            val observer = object : RelayV2TerminalAttachmentObserver {
                override fun opened(streamId: String) {
                    openedCount += 1
                }

                override fun reset(reason: RelayV2TerminalResetReason) {
                    resetCount += 1
                }

                override fun closed(reason: RelayV2TerminalCloseReason) {
                    closedCount += 1
                }

                override fun detachedOpenRetryRequired() {
                    detachedRetryCount += 1
                }
            }
            val target = RelayV2TerminalAttachmentTarget(
                "profile-a",
                7,
                "principal-a",
                "client-a",
                "host-a",
                "scope-a",
                "session-a",
            )
            val authority1 = RelayV2RepositoryEffectAuthority(
                RelayV2EffectGeneration("profile-a", 7, 1),
                "profile-a",
                7,
                "principal-a",
                "client-a",
                "host-a",
                "epoch-a",
            )
            var firstId = 0
            val first = RelayV2TerminalProductionComposition(
                applyLease = CurrentApplyLease,
                terminal = terminal,
                journal = EmptyJournal(),
                credentials = credentials,
                sendPort = RelayV2TerminalExactGenerationSendPort { _, bytes ->
                    sent += bytes
                    RelayV2TerminalExactGenerationSendResult.Sent
                },
                fatalInvalidation = invalidation,
                newId = { "dispose-first-${++firstId}" },
            )
            val firstAttachment = first.attach(target, RejectingParser, observer)
            assertTrue(first.open(firstAttachment, authority1, 120, 36))
            assertEquals(0, resetCount)
            val firstOpen = codec.decodeWebSocketFrame(
                RelayV2WebSocketChannel.PUBLIC,
                sent.single(),
            ).frame
            val key = terminal.beginOpenKeys.single()

            // Repeated admission is idempotent and must be durable before local detach returns.
            assertTrue(first.ensureCloseForDetach(firstAttachment, authority1))
            assertTrue(first.ensureCloseForDetach(firstAttachment, authority1))
            val durableClose = (terminal.stored(key) as RelayV2TerminalStoredCheckpoint.PreOpen)
                .checkpoint.pendingClose
            assertTrue(durableClose != null)
            assertEquals(1, sent.size)
            first.detachAfterParserCallbacksDrained(firstAttachment)
            assertTrue(first.ensureCloseForDetach(firstAttachment, authority1))
            assertEquals(1, resetCount)

            val authority2 = authority1.copy(
                generation = RelayV2EffectGeneration("profile-a", 7, 2),
            )
            var secondId = 0
            val restarted = RelayV2TerminalProductionComposition(
                applyLease = CurrentApplyLease,
                terminal = terminal,
                journal = EmptyJournal(),
                credentials = credentials,
                sendPort = RelayV2TerminalExactGenerationSendPort { _, bytes ->
                    sent += bytes
                    RelayV2TerminalExactGenerationSendResult.Sent
                },
                fatalInvalidation = invalidation,
                newId = { "dispose-restarted-${++secondId}" },
            )
            val restartedAttachment = restarted.attach(target, RejectingParser, observer)
            assertTrue(restarted.open(restartedAttachment, authority2, 80, 24))
            assertEquals(2, sent.size)
            assertEquals(1, resetCount)
            val retryOpen = codec.decodeWebSocketFrame(
                RelayV2WebSocketChannel.PUBLIC,
                sent.last(),
            ).frame
            assertEquals("terminal.open", retryOpen["type"])
            assertEquals(
                durableClose,
                (terminal.stored(key) as RelayV2TerminalStoredCheckpoint.PreOpen)
                    .checkpoint.pendingClose,
            )

            fun openedFrame(
                open: Map<String, Any?>,
                suffix: String,
            ): com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2DecodedMessage {
                val payload = open["payload"] as Map<*, *>
                return codec.decodeWebSocketFrame(
                    RelayV2WebSocketChannel.PUBLIC,
                    codec.encodeWebSocketFrame(
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
                            "hostInstanceId" to "dispose-host-$suffix",
                            "payload" to linkedMapOf(
                                "openId" to payload["openId"],
                                "deduplicated" to true,
                                "generation" to "dispose-generation-$suffix",
                                "resumeToken" to "dispose-token-$suffix",
                                "disposition" to "new",
                                "replayFromOffset" to "0",
                                "bufferStartOffset" to "0",
                                "tailOffset" to "0",
                                "maxUnackedBytes" to 524_288L,
                                "resetReason" to null,
                            ),
                        ),
                    ),
                )
            }

            // The predecessor attachment cannot spend the successor's durable close authority.
            assertEquals(
                RelayV2TerminalFrameResult.NotOwned,
                first.handlePublicFrame(authority1, openedFrame(firstOpen, "stale")),
            )
            assertEquals(2, sent.size)

            assertEquals(
                RelayV2TerminalFrameResult.Applied,
                restarted.handlePublicFrame(authority2, openedFrame(retryOpen, "current")),
            )
            assertEquals(3, sent.size)
            val close = codec.decodeWebSocketFrame(
                RelayV2WebSocketChannel.PUBLIC,
                sent.last(),
            ).frame
            assertEquals("terminal.close", close["type"])
            assertEquals(key.streamId, close["streamId"])
            assertEquals(0, openedCount)
            assertEquals(1, resetCount)
            assertEquals(0, closedCount)
            assertEquals(0, detachedRetryCount)
            assertTrue(invalidated.isEmpty())

            // The close-only owner consumes duplicates without parser or UI admission while it
            // waits for the exact terminal.closed receipt.
            assertEquals(
                RelayV2TerminalFrameResult.Applied,
                restarted.handlePublicFrame(authority2, openedFrame(retryOpen, "duplicate")),
            )
            assertEquals(3, sent.size)

            // A crash after durable opened-for-close but before the wire receipt replays the same
            // idempotency identity. Production must not issue a RESUME open or notify presentation.
            val authority3 = authority1.copy(
                generation = RelayV2EffectGeneration("profile-a", 7, 3),
            )
            var cleanupId = 0
            val cleanup = RelayV2TerminalProductionComposition(
                applyLease = CurrentApplyLease,
                terminal = terminal,
                journal = EmptyJournal(),
                credentials = credentials,
                sendPort = RelayV2TerminalExactGenerationSendPort { _, bytes ->
                    sent += bytes
                    RelayV2TerminalExactGenerationSendResult.Sent
                },
                fatalInvalidation = invalidation,
                newId = { "dispose-cleanup-${++cleanupId}" },
            )
            val cleanupAttachment = cleanup.attach(target, RejectingParser, observer)
            assertTrue(cleanup.open(cleanupAttachment, authority3, 80, 24))
            // Crash recovery first replays the durable discard ACK, then the exact close.
            assertEquals(5, sent.size)
            val replayedClose = codec.decodeWebSocketFrame(
                RelayV2WebSocketChannel.PUBLIC,
                sent.last(),
            ).frame
            assertEquals("terminal.close", replayedClose["type"])
            assertEquals(close["requestId"], replayedClose["requestId"])
            assertEquals(
                (close["payload"] as Map<*, *>)["closeId"],
                (replayedClose["payload"] as Map<*, *>)["closeId"],
            )
            assertEquals(0, openedCount)
            assertEquals(1, resetCount)
            assertEquals(0, closedCount)
            assertEquals(0, detachedRetryCount)
            assertTrue(invalidated.isEmpty())

            val closePayload = replayedClose["payload"] as Map<*, *>
            val naturalClosed = codec.decodeWebSocketFrame(
                RelayV2WebSocketChannel.PUBLIC,
                codec.encodeWebSocketFrame(
                    RelayV2WebSocketChannel.PUBLIC,
                    linkedMapOf(
                        "protocolVersion" to 2L,
                        "kind" to "event",
                        "type" to "terminal.closed",
                        "streamId" to replayedClose["streamId"],
                        "payload" to linkedMapOf(
                            "generation" to closePayload["generation"],
                            "finalOffset" to "7",
                            "replayAvailable" to false,
                            "bufferStartOffset" to null,
                            "reason" to "backend_exit",
                            "exitCode" to 0L,
                        ),
                    ),
                ),
            )
            assertEquals(
                RelayV2TerminalFrameResult.Applied,
                cleanup.handlePublicFrame(authority3, naturalClosed),
            )
            assertEquals(1, closedCount)
            val finalized = (terminal.stored(key) as RelayV2TerminalStoredCheckpoint.Present)
                .checkpoint
            assertEquals(RelayV2TerminalPhase.FINALIZED, finalized.phase)
            assertEquals(null, finalized.pendingClose)
            assertEquals("7", finalized.parserAppliedNextOffset)
            assertEquals("7", finalized.networkReceivedThrough)

            val lateCorrelatedClosed = codec.decodeWebSocketFrame(
                RelayV2WebSocketChannel.PUBLIC,
                codec.encodeWebSocketFrame(
                    RelayV2WebSocketChannel.PUBLIC,
                    linkedMapOf(
                        "protocolVersion" to 2L,
                        "kind" to "response",
                        "type" to "terminal.closed",
                        "requestId" to replayedClose["requestId"],
                        "hostId" to replayedClose["hostId"],
                        "hostEpoch" to replayedClose["expectedHostEpoch"],
                        "hostInstanceId" to "dispose-host-current",
                        "scopeId" to replayedClose["scopeId"],
                        "sessionId" to replayedClose["sessionId"],
                        "streamId" to replayedClose["streamId"],
                        "payload" to linkedMapOf(
                            "generation" to closePayload["generation"],
                            "finalOffset" to "7",
                            "replayAvailable" to false,
                            "bufferStartOffset" to null,
                            "reason" to "client_closed",
                            "exitCode" to null,
                            "closeId" to closePayload["closeId"],
                            "deduplicated" to true,
                        ),
                    ),
                ),
            )
            assertEquals(
                // The retained close-only owner consumes the late exact receipt benignly.
                RelayV2TerminalFrameResult.Applied,
                cleanup.handlePublicFrame(authority3, lateCorrelatedClosed),
            )
            assertEquals(1, closedCount)
            assertEquals(
                finalized,
                (terminal.stored(key) as RelayV2TerminalStoredCheckpoint.Present).checkpoint,
            )

            // The exact receipt makes the row prunable; a later claim may create a fresh stream
            // instead of replaying close forever.
            val authority4 = authority1.copy(
                generation = RelayV2EffectGeneration("profile-a", 7, 4),
            )
            var reopenedId = 0
            val reopened = RelayV2TerminalProductionComposition(
                applyLease = CurrentApplyLease,
                terminal = terminal,
                journal = EmptyJournal(),
                credentials = credentials,
                sendPort = RelayV2TerminalExactGenerationSendPort { _, bytes ->
                    sent += bytes
                    RelayV2TerminalExactGenerationSendResult.Sent
                },
                fatalInvalidation = invalidation,
                newId = { "dispose-reopened-${++reopenedId}" },
            )
            val reopenedAttachment = reopened.attach(target, RejectingParser, observer)
            assertTrue(reopened.open(reopenedAttachment, authority4, 80, 24))
            val freshOpen = codec.decodeWebSocketFrame(
                RelayV2WebSocketChannel.PUBLIC,
                sent.last(),
            ).frame
            assertEquals("terminal.open", freshOpen["type"])
            assertFalse(key.streamId == freshOpen["streamId"])
        }

    @Test
    fun `detached opened survives actor teardown and later close consumes exact receipt`() =
        runBlocking {
            val codec = RelayV2Codec()
            val terminal = BlockingTerminalAuthority().also { it.releaseClaim.complete(Unit) }
            val credentials = RecordingCredentials()
            val sent = mutableListOf<ByteArray>()
            var retryCount = 0
            var closedCount = 0
            var nextId = 0
            val composition = RelayV2TerminalProductionComposition(
                CurrentApplyLease,
                terminal,
                EmptyJournal(),
                credentials,
                RelayV2TerminalExactGenerationSendPort { _, bytes ->
                    sent += bytes
                    RelayV2TerminalExactGenerationSendResult.Sent
                },
                UnexpectedInvalidation,
                newId = { "teardown-close-${++nextId}" },
            )
            val target = RelayV2TerminalAttachmentTarget(
                "profile-a", 7, "principal-a", "client-a", "host-a", "scope-a", "session-a",
            )
            val authority1 = RelayV2RepositoryEffectAuthority(
                RelayV2EffectGeneration("profile-a", 7, 1),
                "profile-a", 7, "principal-a", "client-a", "host-a", "epoch-a",
            )
            val attachment = composition.attach(
                target,
                RejectingParser,
                object : RelayV2TerminalAttachmentObserver {
                    override fun opened(streamId: String) = Unit
                    override fun reset(reason: RelayV2TerminalResetReason) = Unit
                    override fun closed(reason: RelayV2TerminalCloseReason) {
                        closedCount += 1
                    }
                    override fun detachedOpenRetryRequired() {
                        retryCount += 1
                    }
                },
            )
            assertTrue(composition.open(attachment, authority1, 80, 24))
            val open = codec.decodeWebSocketFrame(
                RelayV2WebSocketChannel.PUBLIC,
                sent.single(),
            ).frame
            composition.detachAfterParserCallbacksDrained(attachment)
            val openPayload = open["payload"] as Map<*, *>
            val opened = codec.decodeWebSocketFrame(
                RelayV2WebSocketChannel.PUBLIC,
                codec.encodeWebSocketFrame(
                    RelayV2WebSocketChannel.PUBLIC,
                    linkedMapOf(
                        "protocolVersion" to 2L,
                        "kind" to "response",
                        "type" to "terminal.opened",
                        "requestId" to open["requestId"],
                        "hostId" to open["hostId"],
                        "hostEpoch" to open["expectedHostEpoch"],
                        "hostInstanceId" to "teardown-host",
                        "scopeId" to open["scopeId"],
                        "sessionId" to open["sessionId"],
                        "streamId" to open["streamId"],
                        "payload" to linkedMapOf(
                            "openId" to openPayload["openId"],
                            "deduplicated" to false,
                            "generation" to "teardown-generation",
                            "resumeToken" to "teardown-token",
                            "disposition" to "new",
                            "replayFromOffset" to "0",
                            "bufferStartOffset" to "0",
                            "tailOffset" to "0",
                            "maxUnackedBytes" to 524_288L,
                            "resetReason" to null,
                        ),
                    ),
                ),
            )
            assertEquals(RelayV2TerminalFrameResult.Applied, composition.handlePublicFrame(authority1, opened))
            assertEquals(1, retryCount)
            composition.teardownGeneration(authority1.generation)

            val authority2 = authority1.copy(
                generation = RelayV2EffectGeneration("profile-a", 7, 2),
            )
            assertTrue(composition.ensureCloseForDetach(attachment, authority2))
            val close = codec.decodeWebSocketFrame(
                RelayV2WebSocketChannel.PUBLIC,
                sent.last(),
            ).frame
            assertEquals("terminal.close", close["type"])
            val closePayload = close["payload"] as Map<*, *>
            val closed = codec.decodeWebSocketFrame(
                RelayV2WebSocketChannel.PUBLIC,
                codec.encodeWebSocketFrame(
                    RelayV2WebSocketChannel.PUBLIC,
                    linkedMapOf(
                        "protocolVersion" to 2L,
                        "kind" to "response",
                        "type" to "terminal.closed",
                        "requestId" to close["requestId"],
                        "hostId" to close["hostId"],
                        "hostEpoch" to close["expectedHostEpoch"],
                        "hostInstanceId" to "teardown-host",
                        "scopeId" to close["scopeId"],
                        "sessionId" to close["sessionId"],
                        "streamId" to close["streamId"],
                        "payload" to linkedMapOf(
                            "closeId" to closePayload["closeId"],
                            "generation" to closePayload["generation"],
                            "finalOffset" to "4",
                            "replayAvailable" to false,
                            "bufferStartOffset" to null,
                            "reason" to "client_closed",
                            "exitCode" to null,
                            "deduplicated" to true,
                        ),
                    ),
                ),
            )
            assertEquals(RelayV2TerminalFrameResult.Applied, composition.handlePublicFrame(authority2, closed))
            assertEquals(1, closedCount)
            val key = terminal.beginOpenKeys.single()
            assertEquals(
                RelayV2TerminalPhase.FINALIZED,
                (terminal.stored(key) as RelayV2TerminalStoredCheckpoint.Present).checkpoint.phase,
            )
        }

    @Test
    fun `renderer reattach resets acknowledged parser continuity before resume`() = runBlocking {
        val terminal = BlockingTerminalAuthority(resumeExisting = true).also {
            it.releaseClaim.complete(Unit)
        }
        val sent = mutableListOf<ByteArray>()
        val credentials = RecordingCredentials()
        val terminalJournal = EmptyJournal()
        var nextId = 0
        val composition = RelayV2TerminalProductionComposition(
            applyLease = CurrentApplyLease,
            terminal = terminal,
            journal = terminalJournal,
            credentials = credentials,
            sendPort = RelayV2TerminalExactGenerationSendPort { _, bytes ->
                sent += bytes
                RelayV2TerminalExactGenerationSendResult.Sent
            },
            fatalInvalidation = UnexpectedInvalidation,
            newId = { "renderer-operation-${++nextId}" },
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
        val pendingOpen = requireNotNull(preOpen.pendingOpen)
        val resumeToken = "renderer-resume-token"
        val resumeReference = "renderer-resume-reference"
        credentials.installExact(
            RelayV2TerminalResumeCredentialOwner("profile-a", 7),
            resumeReference,
            resumeToken,
        )
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
            resumeTokenCredentialReference = resumeReference,
            resumeTokenCredentialFingerprint = fingerprint(resumeToken),
            pane = preOpen.target.pane,
        )
        var checkpoint = requireNotNull(
            RelayV2TerminalCheckpointReducer.reduce(
                preOpen,
                RelayV2TerminalAction.Opened(
                    identity = identity,
                    requestId = pendingOpen.requestId,
                    openAttempt = pendingOpen.openAttempt,
                    deliveryToken = pendingOpen.deliveryToken,
                    parserContinuityId = pendingOpen.parserContinuityId,
                    disposition = RelayV2TerminalOpenDisposition.NEW,
                    cols = pendingOpen.cols,
                    rows = pendingOpen.rows,
                    replayFromOffset = "0",
                    tailOffset = "0",
                ),
            ).checkpoint,
        )
        val acknowledgedBytes = RelayV2TerminalBytes.utf8("old-screen")
        val queued = RelayV2TerminalCheckpointReducer.reduce(
            checkpoint,
            RelayV2TerminalAction.Output(
                RelayV2TerminalActionFence(
                    checkpoint.identity.binding(),
                    checkpoint.deliveryToken,
                    checkpoint.openAttempt.openId,
                ),
                "0",
                acknowledgedBytes,
            ),
        )
        checkpoint = requireNotNull(queued.checkpoint)
        val write = queued.effects.filterIsInstance<RelayV2TerminalEffect.WriteParser>().single()
        val claimed = RelayV2TerminalCheckpointReducer.reduce(
            checkpoint,
            RelayV2TerminalAction.ClaimParserDispatch(write),
        )
        val parserClaim =
            (claimed.outcome as RelayV2TerminalOutcome.ParserDispatchClaimed).claim as
                RelayV2TerminalParserDispatchClaim.Write
        val applied = RelayV2TerminalCheckpointReducer.reduce(
            requireNotNull(claimed.checkpoint),
            RelayV2TerminalAction.ParserApplied(parserClaim),
        )
        val acknowledgedOffset = acknowledgedBytes.size.toString()
        assertEquals(
            acknowledgedOffset,
            applied.effects.filterIsInstance<RelayV2TerminalEffect.OutputAck>().single().nextOffset,
        )
        checkpoint = requireNotNull(applied.checkpoint)
        val activation = RelayV2TerminalParserEffectActivation(
            callbackToken = write.callbackToken,
            reservationId = "renderer-recreation-reservation",
            batchFingerprint = "renderer-recreation-batch",
        )
        checkpoint = requireNotNull(
            RelayV2TerminalCheckpointReducer.reduce(
                checkpoint,
                RelayV2TerminalAction.ParserEffectsReserved(activation),
            ).checkpoint,
        )
        checkpoint = requireNotNull(
            RelayV2TerminalCheckpointReducer.reduce(
                checkpoint,
                RelayV2TerminalAction.ParserEffectsActivated(activation),
            ).checkpoint,
        )
        assertEquals(RelayV2TerminalPhase.LIVE, checkpoint.phase)
        assertEquals(acknowledgedOffset, checkpoint.parserAppliedNextOffset)
        terminal.install(key, RelayV2TerminalStoredCheckpoint.Present(checkpoint))
        val sentBeforeDetach = sent.size

        composition.detachAfterParserCallbacksDrained(attachment)

        assertEquals(sentBeforeDetach, sent.size)
        assertEquals(0, terminalJournal.fenceCount())
        val replacement = composition.attach(target, RejectingParser)
        assertTrue(composition.open(replacement, authority, 120, 36))

        assertEquals(sentBeforeDetach + 1, sent.size)
        val resetOpen = RelayV2Codec().decodeWebSocketFrame(
            RelayV2WebSocketChannel.PUBLIC,
            sent.last(),
        ).frame
        val resetPayload = resetOpen["payload"] as Map<*, *>
        assertEquals("reset", resetPayload["mode"])
        assertFalse((resetPayload["resume"] as Map<*, *>).containsKey("nextOffset"))
        val resetPending =
            (terminal.stored(key) as RelayV2TerminalStoredCheckpoint.Present).checkpoint
        assertEquals(RelayV2TerminalPhase.RESET_REQUIRED, resetPending.phase)
        assertEquals(
            RelayV2TerminalResetReason.PARSER_CONTINUITY_LOST,
            resetPending.resetReason,
        )
        assertEquals(RelayV2TerminalOpenMode.RESET, resetPending.pendingOpen?.mode)
        assertEquals(null, resetPending.pendingOpen?.resume?.nextOffset)
        assertEquals(acknowledgedOffset, resetPending.parserAppliedNextOffset)
        assertTrue(resetPending.pendingOutput.isEmpty())
    }

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
                    "disposition" to "reset",
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
        assertEquals(
            RelayV2TerminalOutcome.ResetRequired(
                RelayV2TerminalResetReason.PARSER_CONTINUITY_LOST,
            ),
            restored.outcome,
        )
    }

    @Test
    fun `current opened with wrong open id resets without touching predecessor credential`() =
        runBlocking {
            val oldToken = "credential-before-rejected-open"
            val oldReference = "reference-before-rejected-open"
            val identity = RelayV2TerminalIdentity(
                profileId = "profile-a",
                profileActivationGeneration = 7,
                principalId = "principal-a",
                clientInstanceId = "client-a",
                hostId = "host-a",
                hostEpoch = "epoch-a",
                hostInstanceId = "host-process-before-rejected-open",
                scopeId = "scope-a",
                sessionId = "session-a",
                streamId = "stream-before-rejected-open",
                generation = "generation-before-rejected-open",
                resumeTokenCredentialReference = oldReference,
                resumeTokenCredentialFingerprint = fingerprint(oldToken),
            )
            val delivery = RelayV2TerminalDeliveryToken(
                RelayV2EffectGeneration("profile-a", 7, 1),
                authorityGeneration = 1,
                localDispatchToken = 1,
            )
            val initialAttempt = RelayV2TerminalOpenAttempt(
                "open-before-rejected-open",
                "open-before-rejected-open-fingerprint",
            )
            val begun = RelayV2TerminalCheckpointReducer.reduce(
                null,
                RelayV2TerminalAction.BeginOpenAttempt(
                    deliveryToken = delivery,
                    requestId = "request-before-rejected-open",
                    openAttempt = initialAttempt,
                    mode = RelayV2TerminalOpenMode.NEW,
                    cols = 120,
                    rows = 36,
                    target = identity.target(),
                    parserContinuityId = "parser-before-rejected-open",
                    resume = null,
                ),
            )
            val initial = requireNotNull(
                RelayV2TerminalCheckpointReducer.reduce(
                    requireNotNull(begun.preOpenCheckpoint),
                    RelayV2TerminalAction.Opened(
                        identity = identity,
                        requestId = "request-before-rejected-open",
                        openAttempt = initialAttempt,
                        deliveryToken = delivery,
                        parserContinuityId = "parser-before-rejected-open",
                        disposition = RelayV2TerminalOpenDisposition.NEW,
                        cols = 120,
                        rows = 36,
                        replayFromOffset = "0",
                        tailOffset = "0",
                    ),
                ).checkpoint,
            )

            val terminal = BlockingTerminalAuthority(resumeExisting = true).also {
                it.releaseClaim.complete(Unit)
            }
            val key = RelayV2TerminalCheckpointKey.from(identity.target())
            terminal.install(key, RelayV2TerminalStoredCheckpoint.Present(initial))
            val credentials = RecordingCredentials()
            val owner = RelayV2TerminalResumeCredentialOwner("profile-a", 7)
            credentials.installExact(owner, oldReference, oldToken)
            val installCountBeforeRejectedFrame = credentials.installCount
            val sent = mutableListOf<ByteArray>()
            var openedCount = 0
            var observedReset: RelayV2TerminalResetReason? = null
            var nextId = 0
            val composition = RelayV2TerminalProductionComposition(
                applyLease = CurrentApplyLease,
                terminal = terminal,
                journal = EmptyJournal(),
                credentials = credentials,
                sendPort = RelayV2TerminalExactGenerationSendPort { _, bytes ->
                    sent += bytes
                    RelayV2TerminalExactGenerationSendResult.Sent
                },
                fatalInvalidation = UnexpectedInvalidation,
                newId = { "rejected-open-${++nextId}" },
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
                RelayV2EffectGeneration("profile-a", 7, 2),
                "profile-a",
                7,
                "principal-a",
                "client-a",
                "host-a",
                "epoch-a",
            )
            val attachment = composition.attach(
                target,
                RejectingParser,
                object : RelayV2TerminalAttachmentObserver {
                    override fun opened(streamId: String) {
                        openedCount += 1
                    }

                    override fun reset(reason: RelayV2TerminalResetReason) {
                        observedReset = reason
                    }

                    override fun closed(reason: RelayV2TerminalCloseReason) = Unit
                },
            )
            assertTrue(composition.open(attachment, authority, 120, 36))
            val open = RelayV2Codec().decodeWebSocketFrame(
                RelayV2WebSocketChannel.PUBLIC,
                sent.single(),
            ).frame
            val openPayload = open["payload"] as Map<*, *>
            val rejected = RelayV2Codec().decodeWebSocketFrame(
                RelayV2WebSocketChannel.PUBLIC,
                RelayV2Codec().encodeWebSocketFrame(
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
                        "hostInstanceId" to "host-process-unadopted",
                        "payload" to linkedMapOf(
                            "openId" to "wrong-${openPayload["openId"]}",
                            "deduplicated" to false,
                            "generation" to "generation-unadopted",
                            "resumeToken" to "token-unadopted",
                            "disposition" to "resumed",
                            "replayFromOffset" to "0",
                            "bufferStartOffset" to "0",
                            "tailOffset" to "0",
                            "maxUnackedBytes" to 524_288L,
                            "resetReason" to null,
                        ),
                    ),
                ),
            )

            assertEquals(
                RelayV2TerminalFrameResult.Applied,
                composition.handlePublicFrame(authority, rejected),
            )
            val durable = (terminal.stored(key) as RelayV2TerminalStoredCheckpoint.Present)
                .checkpoint
            assertEquals(RelayV2TerminalPhase.RESET_REQUIRED, durable.phase)
            assertEquals(oldReference, durable.identity.resumeTokenCredentialReference)
            assertEquals(oldToken, credentials.read(owner, oldReference))
            assertEquals(installCountBeforeRejectedFrame, credentials.installCount)
            assertEquals(0, openedCount)
            assertEquals(RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT, observedReset)
        }

    @Test
    fun `unknown opened request resets durably without installing credential`() = runBlocking {
        val terminal = BlockingTerminalAuthority().also { it.releaseClaim.complete(Unit) }
        val credentials = RecordingCredentials()
        val sent = mutableListOf<ByteArray>()
        var observedReset: RelayV2TerminalResetReason? = null
        var openedCount = 0
        var nextId = 0
        val composition = RelayV2TerminalProductionComposition(
            applyLease = CurrentApplyLease,
            terminal = terminal,
            journal = EmptyJournal(),
            credentials = credentials,
            sendPort = RelayV2TerminalExactGenerationSendPort { _, bytes ->
                sent += bytes
                RelayV2TerminalExactGenerationSendResult.Sent
            },
            fatalInvalidation = UnexpectedInvalidation,
            newId = { "unknown-open-${++nextId}" },
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
        val attachment = composition.attach(
            target,
            RejectingParser,
            object : RelayV2TerminalAttachmentObserver {
                override fun opened(streamId: String) {
                    openedCount += 1
                }

                override fun reset(reason: RelayV2TerminalResetReason) {
                    observedReset = reason
                }

                override fun closed(reason: RelayV2TerminalCloseReason) = Unit
            },
        )
        assertTrue(composition.open(attachment, authority, 120, 36))
        val open = RelayV2Codec().decodeWebSocketFrame(
            RelayV2WebSocketChannel.PUBLIC,
            sent.single(),
        ).frame
        val openPayload = open["payload"] as Map<*, *>
        val unknown = RelayV2Codec().decodeWebSocketFrame(
            RelayV2WebSocketChannel.PUBLIC,
            RelayV2Codec().encodeWebSocketFrame(
                RelayV2WebSocketChannel.PUBLIC,
                linkedMapOf(
                    "protocolVersion" to 2L,
                    "kind" to "response",
                    "type" to "terminal.opened",
                    "requestId" to "unknown-open-request",
                    "hostId" to open["hostId"],
                    "hostEpoch" to open["expectedHostEpoch"],
                    "scopeId" to open["scopeId"],
                    "sessionId" to open["sessionId"],
                    "streamId" to open["streamId"],
                    "hostInstanceId" to "unknown-open-host",
                    "payload" to linkedMapOf(
                        "openId" to openPayload["openId"],
                        "deduplicated" to false,
                        "generation" to "unknown-open-generation",
                        "resumeToken" to "unknown-open-token",
                        "disposition" to "new",
                        "replayFromOffset" to "0",
                        "bufferStartOffset" to "0",
                        "tailOffset" to "0",
                        "maxUnackedBytes" to 524_288L,
                        "resetReason" to null,
                    ),
                ),
            ),
        )

        assertEquals(
            RelayV2TerminalFrameResult.Applied,
            composition.handlePublicFrame(authority, unknown),
        )
        val key = terminal.beginOpenKeys.single()
        val durable = (terminal.stored(key) as RelayV2TerminalStoredCheckpoint.PreOpen).checkpoint
        assertEquals(RelayV2TerminalPreOpenPhase.RESET_REQUIRED, durable.phase)
        assertEquals(RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT, durable.resetReason)
        assertEquals(0, credentials.installCount)
        assertEquals(0, openedCount)
        assertEquals(RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT, observedReset)
    }

    @Test
    fun `correlated pre-open stream loss durably opens reset without resume`() = runBlocking {
        val codec = RelayV2Codec()
        val terminal = BlockingTerminalAuthority()
        terminal.releaseClaim.complete(Unit)
        val sent = mutableListOf<ByteArray>()
        val credentials = RecordingCredentials()
        var nextId = 0
        val composition = RelayV2TerminalProductionComposition(
            applyLease = CurrentApplyLease,
            terminal = terminal,
            journal = EmptyJournal(),
            credentials = credentials,
            sendPort = RelayV2TerminalExactGenerationSendPort { _, bytes ->
                sent += bytes
                RelayV2TerminalExactGenerationSendResult.Sent
            },
            fatalInvalidation = UnexpectedInvalidation,
            newId = { "pre-open-reset-${++nextId}" },
        )
        val target = RelayV2TerminalAttachmentTarget(
            "profile-a",
            7,
            "principal-a",
            "client-a",
            "host-a",
            "scope-a",
            "session-a",
            pane = 3,
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
        val parser = object : RelayV2TerminalParserPort {
            override suspend fun write(
                callbackToken: RelayV2TerminalParserCallbackToken,
                bytes: ByteArray,
                completion: suspend (Boolean) -> Unit,
            ) = false

            override suspend fun reset(
                callbackToken: RelayV2TerminalParserCallbackToken,
                completion: suspend (Boolean) -> Unit,
            ) = true
        }
        var replacementReset: RelayV2TerminalResetReason? = null
        var retainedSuccessor: Pair<RelayV2TerminalResetReason, RelayV2TerminalResetSuccessor>? =
            null
        var openedCount = 0
        val attachment = composition.attach(
            target,
            parser,
            object : RelayV2TerminalAttachmentObserver {
                override fun opened(streamId: String) {
                    openedCount += 1
                }

                override fun reset(reason: RelayV2TerminalResetReason) {
                    replacementReset = reason
                }

                override fun resetSuccessorIssued(
                    reason: RelayV2TerminalResetReason,
                    successor: RelayV2TerminalResetSuccessor,
                ) {
                    retainedSuccessor = reason to successor
                }

                override fun closed(reason: RelayV2TerminalCloseReason) = Unit
            },
        )
        assertTrue(composition.open(attachment, authority, 143, 47))
        assertEquals(1, sent.size)
        val firstOpen = codec.decodeWebSocketFrame(
            RelayV2WebSocketChannel.PUBLIC,
            sent.single(),
        ).frame
        val firstPayload = firstOpen["payload"] as Map<*, *>
        val key = terminal.beginOpenKeys.single()
        val initialPreOpen = (terminal.stored(key) as RelayV2TerminalStoredCheckpoint.PreOpen)
            .checkpoint
        val initialPending = requireNotNull(initialPreOpen.pendingOpen)

        val resetRequired = codec.decodeWebSocketFrame(
            RelayV2WebSocketChannel.PUBLIC,
            codec.encodeWebSocketFrame(
                RelayV2WebSocketChannel.PUBLIC,
                linkedMapOf(
                    "protocolVersion" to 2L,
                    "kind" to "response",
                    "type" to "terminal.reset_required",
                    "requestId" to firstOpen["requestId"],
                    "hostId" to firstOpen["hostId"],
                    "hostEpoch" to firstOpen["expectedHostEpoch"],
                    "scopeId" to firstOpen["scopeId"],
                    "sessionId" to firstOpen["sessionId"],
                    "streamId" to firstOpen["streamId"],
                    "payload" to linkedMapOf(
                        "origin" to "open",
                        "generation" to null,
                        "reason" to "stream_lost",
                        "requestedOffset" to null,
                        "bufferStartOffset" to null,
                        "tailOffset" to null,
                    ),
                ),
            ),
        )
        assertEquals(
            RelayV2TerminalFrameResult.Applied,
            composition.handlePublicFrame(authority, resetRequired),
        )

        val resetActions = terminal.reducedActions.takeLast(2)
        assertTrue(resetActions[0] is RelayV2TerminalAction.PreOpenResetRequired)
        val beginReset = resetActions[1] as RelayV2TerminalAction.BeginOpenAttempt
        assertEquals(RelayV2TerminalOpenMode.RESET, beginReset.mode)
        assertEquals(null, beginReset.resume)
        val resetStates = terminal.committedStates.takeLast(2)
        val durableReset = (resetStates[0] as RelayV2TerminalStoredCheckpoint.PreOpen).checkpoint
        assertEquals(RelayV2TerminalPreOpenPhase.RESET_REQUIRED, durableReset.phase)
        assertEquals(RelayV2TerminalResetReason.STREAM_LOST, durableReset.resetReason)
        val pendingReset = (resetStates[1] as RelayV2TerminalStoredCheckpoint.PreOpen).checkpoint
        assertEquals(RelayV2TerminalPreOpenPhase.PENDING_OPEN, pendingReset.phase)
        val successorPending = requireNotNull(pendingReset.pendingOpen)
        assertEquals(RelayV2TerminalOpenMode.RESET, successorPending.mode)
        assertEquals(null, successorPending.resume)
        assertEquals(initialPending.target, successorPending.target)
        assertEquals(initialPending.deliveryToken, successorPending.deliveryToken)
        assertEquals(initialPending.parserContinuityId, successorPending.parserContinuityId)
        assertEquals(initialPending.cols, successorPending.cols)
        assertEquals(initialPending.rows, successorPending.rows)
        assertFalse(initialPending.requestId == successorPending.requestId)
        assertFalse(initialPending.openAttempt.openId == successorPending.openAttempt.openId)
        assertFalse(
            initialPending.openAttempt.fingerprint == successorPending.openAttempt.fingerprint,
        )

        assertEquals(2, sent.size)
        val successorOpen = codec.decodeWebSocketFrame(
            RelayV2WebSocketChannel.PUBLIC,
            sent.last(),
        ).frame
        val successorPayload = successorOpen["payload"] as Map<*, *>
        assertEquals("terminal.open", successorOpen["type"])
        assertEquals("reset", successorPayload["mode"])
        assertEquals(null, replacementReset)
        assertEquals(
            RelayV2TerminalResetReason.STREAM_LOST to RelayV2TerminalResetSuccessor(
                requestId = successorOpen["requestId"] as String,
                openId = successorPayload["openId"] as String,
            ),
            retainedSuccessor,
        )
        assertFalse(successorPayload.containsKey("resume"))
        assertEquals(firstOpen["hostId"], successorOpen["hostId"])
        assertEquals(firstOpen["expectedHostEpoch"], successorOpen["expectedHostEpoch"])
        assertEquals(firstOpen["scopeId"], successorOpen["scopeId"])
        assertEquals(firstOpen["sessionId"], successorOpen["sessionId"])
        assertEquals(firstOpen["streamId"], successorOpen["streamId"])
        assertEquals(firstPayload["pane"], successorPayload["pane"])
        assertEquals(firstPayload["cols"], successorPayload["cols"])
        assertEquals(firstPayload["rows"], successorPayload["rows"])
        assertEquals(0, credentials.readCount)

        val lateOpened = codec.decodeWebSocketFrame(
            RelayV2WebSocketChannel.PUBLIC,
            codec.encodeWebSocketFrame(
                RelayV2WebSocketChannel.PUBLIC,
                linkedMapOf(
                    "protocolVersion" to 2L,
                    "kind" to "response",
                    "type" to "terminal.opened",
                    "requestId" to firstOpen["requestId"],
                    "hostId" to firstOpen["hostId"],
                    "hostEpoch" to firstOpen["expectedHostEpoch"],
                    "scopeId" to firstOpen["scopeId"],
                    "sessionId" to firstOpen["sessionId"],
                    "streamId" to firstOpen["streamId"],
                    "hostInstanceId" to "late-host-instance",
                    "payload" to linkedMapOf(
                        "openId" to firstPayload["openId"],
                        "deduplicated" to false,
                        "generation" to "late-generation",
                        "resumeToken" to "late-resume-token",
                        "disposition" to "new",
                        "replayFromOffset" to "0",
                        "bufferStartOffset" to "0",
                        "tailOffset" to "0",
                        "maxUnackedBytes" to 524_288L,
                        "resetReason" to null,
                    ),
                ),
            ),
        )
        assertEquals(
            RelayV2TerminalFrameResult.Applied,
            composition.handlePublicFrame(authority, lateOpened),
        )
        assertEquals(
            RelayV2TerminalStoredCheckpoint.PreOpen(pendingReset),
            terminal.stored(key),
        )
        assertEquals(0, credentials.installCount)
        assertEquals(0, openedCount)
        assertEquals(null, replacementReset)

        val opened = codec.decodeWebSocketFrame(
            RelayV2WebSocketChannel.PUBLIC,
            codec.encodeWebSocketFrame(
                RelayV2WebSocketChannel.PUBLIC,
                linkedMapOf(
                    "protocolVersion" to 2L,
                    "kind" to "response",
                    "type" to "terminal.opened",
                    "requestId" to successorOpen["requestId"],
                    "hostId" to successorOpen["hostId"],
                    "hostEpoch" to successorOpen["expectedHostEpoch"],
                    "scopeId" to successorOpen["scopeId"],
                    "sessionId" to successorOpen["sessionId"],
                    "streamId" to successorOpen["streamId"],
                    "hostInstanceId" to "host-instance-reset",
                    "payload" to linkedMapOf(
                        "openId" to successorPayload["openId"],
                        "deduplicated" to false,
                        "generation" to "generation-reset",
                        "resumeToken" to "resume-token-reset",
                        "disposition" to "reset",
                        "replayFromOffset" to "0",
                        "bufferStartOffset" to "0",
                        "tailOffset" to "0",
                        "maxUnackedBytes" to 524_288L,
                        "resetReason" to "stream_lost",
                    ),
                ),
            ),
        )
        assertEquals(
            RelayV2TerminalFrameResult.Applied,
            composition.handlePublicFrame(authority, opened),
        )
        val active = (terminal.stored(key) as RelayV2TerminalStoredCheckpoint.Present).checkpoint
        assertEquals(successorPending.openAttempt, active.openAttempt)
        assertEquals(RelayV2TerminalOpenDisposition.RESET, active.openResult.disposition)
        assertEquals(successorPending.target, active.identity.target())
        assertEquals(successorPending.deliveryToken, active.deliveryToken)
        assertEquals(successorPending.cols, active.openedCols)
        assertEquals(successorPending.rows, active.openedRows)
        assertEquals(0, credentials.readCount)
        assertEquals(1, credentials.installCount)
        assertEquals(1, openedCount)
    }

    @Test
    fun `pre-open stream loss admission denial keeps durable reset without a second open`() =
        runBlocking {
            val codec = RelayV2Codec()
            val terminal = BlockingTerminalAuthority().also { it.releaseClaim.complete(Unit) }
            val sent = mutableListOf<ByteArray>()
            var nextId = 0
            val composition = RelayV2TerminalProductionComposition(
                applyLease = CurrentApplyLease,
                terminal = terminal,
                journal = EmptyJournal(),
                credentials = RecordingCredentials(),
                sendPort = RelayV2TerminalExactGenerationSendPort { _, bytes ->
                    sent += bytes
                    RelayV2TerminalExactGenerationSendResult.Sent
                },
                fatalInvalidation = UnexpectedInvalidation,
                newId = { "pre-open-denied-${++nextId}" },
            )
            val target = RelayV2TerminalAttachmentTarget(
                "profile-a",
                7,
                "principal-a",
                "client-a",
                "host-a",
                "scope-a",
                "session-a",
                pane = 3,
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
            var admissionCount = 0
            var resetCount = 0
            var successorCount = 0
            val attachment = composition.attach(
                target,
                object : RelayV2TerminalParserPort {
                    override suspend fun write(
                        callbackToken: RelayV2TerminalParserCallbackToken,
                        bytes: ByteArray,
                        completion: suspend (Boolean) -> Unit,
                    ) = false

                    override suspend fun reset(
                        callbackToken: RelayV2TerminalParserCallbackToken,
                        completion: suspend (Boolean) -> Unit,
                    ) = false
                },
                object : RelayV2TerminalAttachmentObserver {
                    override fun opened(streamId: String) = Unit

                    override fun reset(reason: RelayV2TerminalResetReason) {
                        resetCount += 1
                    }

                    override fun admitResetSuccessor(
                        reason: RelayV2TerminalResetReason,
                    ): Boolean {
                        admissionCount += 1
                        assertEquals(RelayV2TerminalResetReason.STREAM_LOST, reason)
                        return false
                    }

                    override fun resetSuccessorIssued(
                        reason: RelayV2TerminalResetReason,
                        successor: RelayV2TerminalResetSuccessor,
                    ) {
                        successorCount += 1
                    }

                    override fun closed(reason: RelayV2TerminalCloseReason) = Unit
                },
            )
            assertTrue(composition.open(attachment, authority, 143, 47))
            val firstOpen = codec.decodeWebSocketFrame(
                RelayV2WebSocketChannel.PUBLIC,
                sent.single(),
            ).frame
            val resetRequired = codec.decodeWebSocketFrame(
                RelayV2WebSocketChannel.PUBLIC,
                codec.encodeWebSocketFrame(
                    RelayV2WebSocketChannel.PUBLIC,
                    linkedMapOf(
                        "protocolVersion" to 2L,
                        "kind" to "response",
                        "type" to "terminal.reset_required",
                        "requestId" to firstOpen["requestId"],
                        "hostId" to firstOpen["hostId"],
                        "hostEpoch" to firstOpen["expectedHostEpoch"],
                        "scopeId" to firstOpen["scopeId"],
                        "sessionId" to firstOpen["sessionId"],
                        "streamId" to firstOpen["streamId"],
                        "payload" to linkedMapOf(
                            "origin" to "open",
                            "generation" to null,
                            "reason" to "stream_lost",
                            "requestedOffset" to null,
                            "bufferStartOffset" to null,
                            "tailOffset" to null,
                        ),
                    ),
                ),
            )

            assertEquals(
                RelayV2TerminalFrameResult.Applied,
                composition.handlePublicFrame(authority, resetRequired),
            )
            assertEquals(1, admissionCount)
            assertEquals(1, sent.size)
            assertEquals(0, resetCount)
            assertEquals(0, successorCount)
            assertEquals(
                1,
                terminal.reducedActions.count {
                    it is RelayV2TerminalAction.BeginOpenAttempt
                },
            )
            val key = terminal.beginOpenKeys.single()
            val durable = (terminal.stored(key) as RelayV2TerminalStoredCheckpoint.PreOpen)
                .checkpoint
            assertEquals(RelayV2TerminalPreOpenPhase.RESET_REQUIRED, durable.phase)
            assertEquals(RelayV2TerminalResetReason.STREAM_LOST, durable.resetReason)
            assertEquals(null, durable.pendingOpen)
        }

    @Test
    fun `generic pre-open capability error delegates one fresh reset to replacement attachment`() =
        runBlocking {
            val codec = RelayV2Codec()
            val terminal = BlockingTerminalAuthority(resumeExisting = true).also {
                it.releaseClaim.complete(Unit)
            }
            val sent = mutableListOf<ByteArray>()
            var nextId = 0
            val composition = RelayV2TerminalProductionComposition(
                applyLease = CurrentApplyLease,
                terminal = terminal,
                journal = EmptyJournal(),
                credentials = EmptyCredentials(),
                sendPort = RelayV2TerminalExactGenerationSendPort { _, bytes ->
                    sent += bytes
                    RelayV2TerminalExactGenerationSendResult.Sent
                },
                fatalInvalidation = UnexpectedInvalidation,
                newId = { "generic-capability-${++nextId}" },
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
            val normalResets = mutableListOf<RelayV2TerminalResetReason>()
            val retainedSuccessors = mutableListOf<RelayV2TerminalResetSuccessor>()
            val rejected = mutableListOf<RelayV2TerminalCorrelatedError>()
            val observer = object : RelayV2TerminalAttachmentObserver {
                override fun opened(streamId: String) = Unit

                override fun reset(reason: RelayV2TerminalResetReason) {
                    normalResets += reason
                }

                override fun resetSuccessorIssued(
                    reason: RelayV2TerminalResetReason,
                    successor: RelayV2TerminalResetSuccessor,
                ) {
                    retainedSuccessors += successor
                }

                override fun closed(reason: RelayV2TerminalCloseReason) = Unit

                override fun openRejected(error: RelayV2TerminalCorrelatedError) {
                    rejected += error
                }
            }
            val firstAttachment = composition.attach(target, RejectingParser, observer)
            assertTrue(composition.open(firstAttachment, authority, 120, 36))
            val firstOpen = codec.decodeWebSocketFrame(
                RelayV2WebSocketChannel.PUBLIC,
                sent.single(),
            ).frame
            val firstPayload = firstOpen["payload"] as Map<*, *>
            val capabilityError = codec.decodeWebSocketFrame(
                RelayV2WebSocketChannel.PUBLIC,
                codec.encodeWebSocketFrame(
                    RelayV2WebSocketChannel.PUBLIC,
                    linkedMapOf(
                        "protocolVersion" to 2L,
                        "kind" to "response",
                        "type" to "error",
                        "requestId" to firstOpen["requestId"],
                        "hostId" to firstOpen["hostId"],
                        "hostEpoch" to firstOpen["expectedHostEpoch"],
                        "scopeId" to firstOpen["scopeId"],
                        "sessionId" to firstOpen["sessionId"],
                        "streamId" to firstOpen["streamId"],
                        "payload" to null,
                        "error" to linkedMapOf(
                            "code" to "CAPABILITY_UNAVAILABLE",
                            "message" to "Relay v2 authority capability is unavailable",
                            "retryable" to false,
                            "retryAfterMs" to null,
                            "commandDisposition" to "not_applicable",
                            "details" to null,
                        ),
                    ),
                ),
            )

            assertEquals(
                RelayV2TerminalFrameResult.Applied,
                composition.handlePublicFrame(authority, capabilityError),
            )
            assertEquals(listOf(RelayV2TerminalResetReason.STREAM_LOST), normalResets)
            assertTrue(retainedSuccessors.isEmpty())
            assertEquals(
                listOf(
                    RelayV2TerminalCorrelatedError(
                        code = "CAPABILITY_UNAVAILABLE",
                        retryable = false,
                        message = "Relay v2 authority capability is unavailable",
                    ),
                ),
                rejected,
            )
            assertEquals(1, sent.size)

            // This is the V2 replacement boundary: the ordinary reset owner drains/detaches the
            // old attachment, and only the new attachment claims durable RESET_REQUIRED.
            composition.detachAfterParserCallbacksDrained(firstAttachment)
            val replacement = composition.attach(target, RejectingParser)
            assertTrue(composition.open(replacement, authority, 120, 36))

            assertEquals(2, sent.size)
            val resetOpen = codec.decodeWebSocketFrame(
                RelayV2WebSocketChannel.PUBLIC,
                sent.last(),
            ).frame
            val resetPayload = resetOpen["payload"] as Map<*, *>
            assertEquals("terminal.open", resetOpen["type"])
            assertEquals("reset", resetPayload["mode"])
            assertFalse(resetPayload.containsKey("resume"))
            assertFalse(firstOpen["requestId"] == resetOpen["requestId"])
            assertFalse(firstPayload["openId"] == resetPayload["openId"])
        }

    @Test
    fun `detached terminal consumes issued errors but reports only current conflict`() = runBlocking {
        val codec = RelayV2Codec()
        val terminal = BlockingTerminalAuthority(resumeExisting = true).also {
            it.releaseClaim.complete(Unit)
        }
        val sent = mutableListOf<ByteArray>()
        var nextId = 0
        val composition = RelayV2TerminalProductionComposition(
            applyLease = CurrentApplyLease,
            terminal = terminal,
            journal = EmptyJournal(),
            credentials = EmptyCredentials(),
            sendPort = RelayV2TerminalExactGenerationSendPort { _, bytes ->
                sent += bytes
                RelayV2TerminalExactGenerationSendResult.Sent
            },
            fatalInvalidation = UnexpectedInvalidation,
            newId = { "detached-error-${++nextId}" },
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
        val detachedRejections = mutableListOf<RelayV2TerminalCorrelatedError>()
        val attachment = composition.attach(
            target,
            RejectingParser,
            object : RelayV2TerminalAttachmentObserver {
                override fun opened(streamId: String) = Unit
                override fun reset(reason: RelayV2TerminalResetReason) = Unit
                override fun closed(reason: RelayV2TerminalCloseReason) = Unit
                override fun detachedOpenRejected(error: RelayV2TerminalCorrelatedError) {
                    detachedRejections += error
                }
            },
        )
        assertTrue(composition.open(attachment, authority, 120, 36))
        val firstOpen = codec.decodeWebSocketFrame(
            RelayV2WebSocketChannel.PUBLIC,
            sent.single(),
        ).frame
        val key = terminal.beginOpenKeys.single()
        val first = (terminal.stored(key) as RelayV2TerminalStoredCheckpoint.PreOpen).checkpoint
        val firstPending = requireNotNull(first.pendingOpen)
        val retryRequestId = "detached-current-request"
        val retried = requireNotNull(
            RelayV2TerminalCheckpointReducer.reduce(
                first,
                RelayV2TerminalAction.BeginOpenAttempt(
                    deliveryToken = firstPending.deliveryToken,
                    requestId = retryRequestId,
                    openAttempt = firstPending.openAttempt,
                    mode = firstPending.mode,
                    cols = firstPending.cols,
                    rows = firstPending.rows,
                    target = firstPending.target,
                    parserContinuityId = firstPending.parserContinuityId,
                    resume = firstPending.resume,
                ),
            ).preOpenCheckpoint,
        )
        terminal.install(key, RelayV2TerminalStoredCheckpoint.PreOpen(retried))
        composition.detachAfterParserCallbacksDrained(attachment)

        fun error(requestId: String, code: String = "INTERNAL") = codec.decodeWebSocketFrame(
            RelayV2WebSocketChannel.PUBLIC,
            codec.encodeWebSocketFrame(
                RelayV2WebSocketChannel.PUBLIC,
                linkedMapOf(
                    "protocolVersion" to 2L,
                    "kind" to "response",
                    "type" to "error",
                    "requestId" to requestId,
                    "hostId" to firstOpen["hostId"],
                    "hostEpoch" to firstOpen["expectedHostEpoch"],
                    "scopeId" to firstOpen["scopeId"],
                    "sessionId" to firstOpen["sessionId"],
                    "streamId" to firstOpen["streamId"],
                    "payload" to null,
                    "error" to linkedMapOf(
                        "code" to code,
                        "message" to "terminal request rejected",
                        "retryable" to false,
                        "retryAfterMs" to null,
                        "commandDisposition" to "not_applicable",
                        "details" to null,
                    ),
                ),
            ),
        )

        assertEquals(
            RelayV2TerminalFrameResult.NotOwned,
            composition.handlePublicFrame(authority, error("unknown-request")),
        )
        assertEquals(
            RelayV2TerminalFrameResult.Applied,
            composition.handlePublicFrame(
                authority,
                error(requireNotNull(firstPending.requestId)),
            ),
        )
        assertTrue(detachedRejections.isEmpty())

        assertEquals(
            RelayV2TerminalFrameResult.Applied,
            composition.handlePublicFrame(
                authority,
                error(retryRequestId, "TERMINAL_STREAM_CONFLICT"),
            ),
        )
        assertEquals(
            listOf(
                RelayV2TerminalCorrelatedError(
                    "TERMINAL_STREAM_CONFLICT",
                    false,
                    "terminal request rejected",
                ),
            ),
            detachedRejections,
        )
        assertEquals(RelayV2TerminalStoredCheckpoint.PreOpen(retried), terminal.stored(key))
        assertEquals(1, sent.size)
    }

    @Test
    fun `pending reset gates controls and detached opened retires before retry`() = runBlocking {
        val codec = RelayV2Codec()
        val terminal = BlockingTerminalAuthority(resumeExisting = true).also {
            it.releaseClaim.complete(Unit)
        }
        val sent = mutableListOf<ByteArray>()
        val invalidations = mutableListOf<RelayV2TerminalFatalInvalidationReason>()
        val credentials = RecordingCredentials()
        var resetCount = 0
        var detachedRetryCount = 0
        var nextId = 0
        val composition = RelayV2TerminalProductionComposition(
            applyLease = CurrentApplyLease,
            terminal = terminal,
            journal = EmptyJournal(),
            credentials = credentials,
            sendPort = RelayV2TerminalExactGenerationSendPort { _, bytes ->
                sent += bytes
                RelayV2TerminalExactGenerationSendResult.Sent
            },
            fatalInvalidation = object : RelayV2TerminalFatalInvalidationPort {
                override suspend fun invalidate(
                    authority: RelayV2RepositoryEffectAuthority,
                    key: RelayV2TerminalCheckpointKey,
                    reason: RelayV2TerminalFatalInvalidationReason,
                ) {
                    invalidations += reason
                }
            },
            newId = { "detached-opened-${++nextId}" },
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
        val attachment = composition.attach(
            target,
            RejectingParser,
            object : RelayV2TerminalAttachmentObserver {
                override fun opened(streamId: String) = Unit
                override fun reset(reason: RelayV2TerminalResetReason) {
                    resetCount += 1
                }
                override fun closed(reason: RelayV2TerminalCloseReason) = Unit
                override fun detachedOpenRetryRequired() {
                    detachedRetryCount += 1
                }
            },
        )
        assertTrue(composition.open(attachment, authority, 120, 36))
        val firstOpen = codec.decodeWebSocketFrame(
            RelayV2WebSocketChannel.PUBLIC,
            sent.single(),
        ).frame
        val key = terminal.beginOpenKeys.single()
        val preOpen = (terminal.stored(key) as RelayV2TerminalStoredCheckpoint.PreOpen).checkpoint
        val firstPending = requireNotNull(preOpen.pendingOpen)
        val predecessor = RelayV2TerminalIdentity(
            profileId = key.profileId,
            profileActivationGeneration = key.profileActivationGeneration,
            principalId = key.principalId,
            clientInstanceId = key.clientInstanceId,
            hostId = key.hostId,
            hostEpoch = key.hostEpoch,
            hostInstanceId = "host-process-before-detach",
            scopeId = key.scopeId,
            sessionId = key.sessionId,
            streamId = key.streamId,
            generation = "generation-before-detach",
            resumeTokenCredentialReference = "credential-before-detach",
            resumeTokenCredentialFingerprint = fingerprint("token-before-detach"),
            pane = key.pane,
        )
        val opened = requireNotNull(
            RelayV2TerminalCheckpointReducer.reduce(
                preOpen,
                RelayV2TerminalAction.Opened(
                    identity = predecessor,
                    requestId = firstPending.requestId,
                    openAttempt = firstPending.openAttempt,
                    deliveryToken = firstPending.deliveryToken,
                    parserContinuityId = firstPending.parserContinuityId,
                    disposition = RelayV2TerminalOpenDisposition.NEW,
                    cols = firstPending.cols,
                    rows = firstPending.rows,
                    replayFromOffset = "0",
                    tailOffset = "0",
                ),
            ).checkpoint,
        )
        val resetRequired = requireNotNull(
            RelayV2TerminalCheckpointReducer.reduce(
                opened,
                RelayV2TerminalAction.AsyncResetRequired(
                    fence = RelayV2TerminalActionFence(
                        opened.identity.binding(),
                        opened.deliveryToken,
                        opened.openAttempt.openId,
                    ),
                    correlationProofId = "detach-before-opened",
                    reason = RelayV2TerminalResetReason.STREAM_LOST,
                    requestedOffset = null,
                    bufferStartOffset = null,
                    tailOffset = null,
                ),
            ).checkpoint,
        )
        val resetAttempt = RelayV2TerminalOpenAttempt(
            "detached-reset-open",
            "detached-reset-open-fingerprint",
        )
        val firstReset = RelayV2TerminalAction.BeginOpenAttempt(
            deliveryToken = resetRequired.deliveryToken,
            requestId = "detached-reset-issued-old",
            openAttempt = resetAttempt,
            mode = RelayV2TerminalOpenMode.RESET,
            cols = 120,
            rows = 36,
            target = resetRequired.identity.target(),
            parserContinuityId = "parser-after-detached-reset",
            resume = RelayV2TerminalOpenResume(
                generation = resetRequired.identity.generation,
                nextOffset = null,
                resumeTokenCredentialReference =
                resetRequired.identity.resumeTokenCredentialReference,
                resumeTokenCredentialFingerprint =
                resetRequired.identity.resumeTokenCredentialFingerprint,
            ),
        )
        val firstResetPending = requireNotNull(
            RelayV2TerminalCheckpointReducer.reduce(resetRequired, firstReset).checkpoint,
        )
        val currentResetRequestId = "detached-reset-current"
        val pending = requireNotNull(
            RelayV2TerminalCheckpointReducer.reduce(
                firstResetPending,
                firstReset.copy(requestId = currentResetRequestId),
            ).checkpoint,
        )
        terminal.install(key, RelayV2TerminalStoredCheckpoint.Present(pending))

        // onReady fit and IME input must not redispatch RESET_REQUIRED while open is pending.
        assertTrue(composition.enqueueResize(attachment, authority, 96, 28))
        assertFalse(composition.enqueueInput(attachment, authority, "x".toByteArray()))
        assertEquals(0, resetCount)
        assertEquals(RelayV2TerminalStoredCheckpoint.Present(pending), terminal.stored(key))
        assertEquals(1, sent.size)

        composition.detachAfterParserCallbacksDrained(attachment)
        assertEquals(1, resetCount)

        fun openedFrame(requestId: String) = codec.decodeWebSocketFrame(
            RelayV2WebSocketChannel.PUBLIC,
            codec.encodeWebSocketFrame(
                RelayV2WebSocketChannel.PUBLIC,
                linkedMapOf(
                    "protocolVersion" to 2L,
                    "kind" to "response",
                    "type" to "terminal.opened",
                    "requestId" to requestId,
                    "hostId" to firstOpen["hostId"],
                    "hostEpoch" to firstOpen["expectedHostEpoch"],
                    "scopeId" to firstOpen["scopeId"],
                    "sessionId" to firstOpen["sessionId"],
                    "streamId" to firstOpen["streamId"],
                    "hostInstanceId" to "host-process-after-detach",
                    "payload" to linkedMapOf(
                        "openId" to resetAttempt.openId,
                        "deduplicated" to true,
                        "generation" to "generation-after-detach",
                        "resumeToken" to "token-after-detach",
                        "disposition" to "reset",
                        "replayFromOffset" to "0",
                        "bufferStartOffset" to "0",
                        "tailOffset" to "0",
                        "maxUnackedBytes" to 524_288L,
                        "resetReason" to "stream_lost",
                    ),
                ),
            ),
        )

        assertEquals(
            RelayV2TerminalFrameResult.ProtocolViolation,
            composition.handlePublicFrame(authority, openedFrame("unknown-opened-request")),
        )
        assertEquals(
            RelayV2TerminalFrameResult.Applied,
            composition.handlePublicFrame(
                authority,
                openedFrame(firstReset.requestId),
            ),
        )
        assertTrue(invalidations.isEmpty())
        assertEquals(0, detachedRetryCount)

        assertEquals(
            RelayV2TerminalFrameResult.Applied,
            composition.handlePublicFrame(
                authority,
                openedFrame(currentResetRequestId),
            ),
        )
        assertTrue(invalidations.isEmpty())
        assertEquals(1, detachedRetryCount)
        assertEquals(1, credentials.installCount)
        val suspended = (terminal.stored(key) as RelayV2TerminalStoredCheckpoint.Present)
            .checkpoint
        assertEquals(RelayV2TerminalPhase.RESET_REQUIRED, suspended.phase)
        assertEquals(RelayV2TerminalResetReason.STREAM_LOST, suspended.resetReason)
        assertEquals(null, suspended.pendingOpen)
    }

    @Test
    fun `handled reset stays applied with exact terminal ownership`() = runBlocking {
        val codec = RelayV2Codec()
        val terminal = BlockingTerminalAuthority()
        terminal.releaseClaim.complete(Unit)
        var observedReset: RelayV2TerminalResetReason? = null
        val observedOpenRejections = mutableListOf<RelayV2TerminalCorrelatedError>()
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
        val attachment = composition.attach(
            target,
            RejectingParser,
            object : RelayV2TerminalAttachmentObserver {
                override fun opened(streamId: String) = Unit

                override fun reset(reason: RelayV2TerminalResetReason) {
                    observedReset = reason
                }

                override fun closed(reason: RelayV2TerminalCloseReason) = Unit

                override fun openRejected(error: RelayV2TerminalCorrelatedError) {
                    observedOpenRejections += error
                }
            },
        )
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
        val firstPresentPendingOpen = requireNotNull(pendingOpen.pendingOpen)
        val retriedPendingOpen = requireNotNull(
            RelayV2TerminalCheckpointReducer.reduce(
                pendingOpen,
                RelayV2TerminalAction.BeginOpenAttempt(
                    deliveryToken = firstPresentPendingOpen.deliveryToken,
                    requestId = "present-open-retry-request",
                    openAttempt = firstPresentPendingOpen.openAttempt,
                    mode = firstPresentPendingOpen.mode,
                    cols = firstPresentPendingOpen.cols,
                    rows = firstPresentPendingOpen.rows,
                    target = firstPresentPendingOpen.target,
                    parserContinuityId = firstPresentPendingOpen.parserContinuityId,
                    resume = firstPresentPendingOpen.resume,
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
            code: String = "INTERNAL",
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
                        "code" to code,
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
            val code: String = "INTERNAL",
            val disposition: String = "not_applicable",
            val streamId: String = identity.streamId,
            val retryable: Boolean = false,
            val message: String = "terminal request rejected",
            val retryAfterMs: Long? = null,
            val notifiesOpenRejected: Boolean = false,
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
                notifiesOpenRejected = true,
            ),
            ErrorCase(
                "present pending open owned",
                presentOpenStored,
                requireNotNull(pendingOpen.pendingOpen).requestId,
                RelayV2TerminalFrameResult.Applied,
                notifiesOpenRejected = true,
            ),
            ErrorCase(
                "present stale issued open request",
                RelayV2TerminalStoredCheckpoint.Present(retriedPendingOpen),
                firstPresentPendingOpen.requestId,
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
                notifiesOpenRejected = true,
            ),
            ErrorCase(
                "owned metadata variant two",
                presentOpenStored,
                requireNotNull(pendingOpen.pendingOpen).requestId,
                RelayV2TerminalFrameResult.Applied,
                retryable = true,
                message = "different public message",
                retryAfterMs = 25,
                notifiesOpenRejected = true,
            ),
            ErrorCase(
                "present terminal stream conflict",
                presentOpenStored,
                requireNotNull(pendingOpen.pendingOpen).requestId,
                RelayV2TerminalFrameResult.Applied,
                code = "TERMINAL_STREAM_CONFLICT",
                message = "Relay v2 terminal stream conflicts with retained state",
                notifiesOpenRejected = true,
            ),
        ).forEach { case ->
            terminal.install(key, case.stored)
            val observedBefore = observedOpenRejections.size
            assertEquals(
                case.name,
                case.expected,
                composition.handlePublicFrame(
                    authority,
                    decodedError(
                        requestId = case.requestId,
                        code = case.code,
                        disposition = case.disposition,
                        streamId = case.streamId,
                        retryable = case.retryable,
                        message = case.message,
                        retryAfterMs = case.retryAfterMs,
                    ),
                ),
            )
            assertEquals(
                case.name,
                observedBefore + if (case.notifiesOpenRejected) 1 else 0,
                observedOpenRejections.size,
            )
            if (case.notifiesOpenRejected) {
                assertEquals(
                    case.name,
                    RelayV2TerminalCorrelatedError(
                        code = case.code,
                        retryable = case.retryable,
                        message = case.message,
                    ),
                    observedOpenRejections.last(),
                )
            }
            if (case.name == "pre-open owned") {
                val rejected = (terminal.stored(key) as RelayV2TerminalStoredCheckpoint.PreOpen)
                    .checkpoint
                assertEquals(
                    RelayV2TerminalPreOpenPhase.RESET_REQUIRED,
                    rejected.phase,
                )
                assertEquals(RelayV2TerminalResetReason.STREAM_LOST, rejected.resetReason)
                assertEquals(null, rejected.pendingOpen)
            } else {
                assertEquals(case.name, case.stored, terminal.stored(key))
            }
        }

        terminal.install(key, RelayV2TerminalStoredCheckpoint.Present(pendingOpen))
        val openResetRequired = codec.decodeWebSocketFrame(
            RelayV2WebSocketChannel.PUBLIC,
            codec.encodeWebSocketFrame(
                RelayV2WebSocketChannel.PUBLIC,
                linkedMapOf(
                    "protocolVersion" to 2L,
                    "kind" to "response",
                    "type" to "terminal.reset_required",
                    "requestId" to requireNotNull(pendingOpen.pendingOpen).requestId,
                    "hostId" to identity.hostId,
                    "hostEpoch" to identity.hostEpoch,
                    "scopeId" to identity.scopeId,
                    "sessionId" to identity.sessionId,
                    "streamId" to identity.streamId,
                    "payload" to linkedMapOf(
                        "origin" to "open",
                        // A correlated RESUME reset is bound to the generation being resumed.
                        "generation" to identity.generation,
                        "reason" to "stream_lost",
                        "requestedOffset" to null,
                        "bufferStartOffset" to null,
                        "tailOffset" to null,
                    ),
                ),
            ),
        )
        assertEquals(
            RelayV2TerminalFrameResult.Applied,
            composition.handlePublicFrame(authority, openResetRequired),
        )
        val openResetCheckpoint =
            (terminal.stored(key) as RelayV2TerminalStoredCheckpoint.Present).checkpoint
        assertEquals(RelayV2TerminalPhase.RESET_REQUIRED, openResetCheckpoint.phase)
        assertEquals(
            RelayV2TerminalResetReason.STREAM_LOST,
            openResetCheckpoint.resetReason,
        )
        assertEquals(RelayV2TerminalResetReason.STREAM_LOST, observedReset)

        terminal.install(key, RelayV2TerminalStoredCheckpoint.Present(present))
        val resetRequired = codec.decodeWebSocketFrame(
            RelayV2WebSocketChannel.PUBLIC,
            codec.encodeWebSocketFrame(
                RelayV2WebSocketChannel.PUBLIC,
                linkedMapOf(
                    "protocolVersion" to 2L,
                    "kind" to "event",
                    "type" to "terminal.reset_required",
                    "streamId" to identity.streamId,
                    "payload" to linkedMapOf(
                        "generation" to identity.generation,
                        "reason" to "stream_lost",
                        "requestedOffset" to null,
                        "bufferStartOffset" to null,
                        "tailOffset" to null,
                    ),
                ),
            ),
        )
        assertEquals(
            RelayV2TerminalFrameResult.Applied,
            composition.handlePublicFrame(authority, resetRequired),
        )
        assertEquals(RelayV2TerminalResetReason.STREAM_LOST, observedReset)

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
            val rebound = requireNotNull(
                RelayV2TerminalCheckpointReducer.restore(
                    RelayV2TerminalStoredCheckpoint.Present(checkpoint),
                    checkpoint.identity,
                    checkpoint.openAttempt,
                    delivery,
                    checkpoint.parserContinuityId,
                ).checkpoint,
            )
            val resume = RelayV2TerminalOpenResume(
                generation = rebound.identity.generation,
                nextOffset = null,
                resumeTokenCredentialReference =
                    rebound.identity.resumeTokenCredentialReference,
                resumeTokenCredentialFingerprint =
                    rebound.identity.resumeTokenCredentialFingerprint,
            )
            val reduced = RelayV2TerminalCheckpointReducer.reduce(
                rebound,
                RelayV2TerminalAction.BeginOpenAttempt(
                    delivery,
                    requestId,
                    openAttempt,
                    RelayV2TerminalOpenMode.RESET,
                    cols,
                    rows,
                    rebound.identity.target(),
                    rebound.parserContinuityId,
                    resume,
                ),
            )
            stored = RelayV2TerminalStoredCheckpoint.Present(requireNotNull(reduced.checkpoint))
            return RelayV2TerminalResumeClaim(key, reduced)
        }

        override suspend fun loadTerminalUnderApplyLease(key: RelayV2TerminalCheckpointKey) = stored

        override suspend fun reduceTerminalUnderApplyLease(
            key: RelayV2TerminalCheckpointKey,
            action: RelayV2TerminalAction,
        ): RelayV2TerminalReduction {
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

    private class BlockingTerminalAuthority(
        private val resumeExisting: Boolean = false,
    ) : RelayV2TerminalRecoveryAuthority {
        val claimEntered = CompletableDeferred<Unit>()
        val releaseClaim = CompletableDeferred<Unit>()
        val beginOpenDeliveries = mutableListOf<RelayV2TerminalDeliveryToken>()
        val beginOpenKeys = mutableListOf<RelayV2TerminalCheckpointKey>()
        val reducedActions = mutableListOf<RelayV2TerminalAction>()
        val committedStates = mutableListOf<RelayV2TerminalStoredCheckpoint>()
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
            if (!resumeExisting) return null
            val candidate = checkpoints.entries.singleOrNull { (key, stored) ->
                (stored is RelayV2TerminalStoredCheckpoint.PreOpen ||
                    stored is RelayV2TerminalStoredCheckpoint.Present) &&
                    key.profileId == selector.profileId &&
                    key.profileActivationGeneration == selector.profileActivationGeneration &&
                    key.principalId == selector.principalId &&
                    key.clientInstanceId == selector.clientInstanceId &&
                    key.hostId == selector.hostId &&
                    key.hostEpoch == authority.hostEpoch &&
                    key.scopeId == selector.scopeId &&
                    key.sessionId == selector.sessionId &&
                    key.pane == selector.pane
            } ?: return null
            val key = candidate.key
            val stored = candidate.value
            if ((stored as? RelayV2TerminalStoredCheckpoint.Present)
                    ?.checkpoint?.phase == RelayV2TerminalPhase.FINALIZED
            ) {
                checkpoints.remove(key)
                return null
            }
            val previousDelivery = when (stored) {
                is RelayV2TerminalStoredCheckpoint.PreOpen -> stored.checkpoint.deliveryToken
                is RelayV2TerminalStoredCheckpoint.Present -> stored.checkpoint.deliveryToken
                else -> error("unexpected resumable test checkpoint")
            }
            val delivery = RelayV2TerminalDeliveryToken(
                authority.generation,
                previousDelivery.authorityGeneration + 1,
                1,
            )
            if (stored is RelayV2TerminalStoredCheckpoint.PreOpen) {
                val checkpoint = stored.checkpoint
                val restored = RelayV2TerminalCheckpointReducer.restorePreOpen(
                    stored = stored,
                    expectedTarget = checkpoint.target,
                    expectedOpenAttempt = checkpoint.pendingOpen?.openAttempt
                        ?: checkpoint.resetFence?.openAttempt
                        ?: openAttempt,
                    currentDeliveryToken = delivery,
                    currentParserContinuityId = checkpoint.parserContinuityId,
                )
                val current = requireNotNull(restored.preOpenCheckpoint)
                val action = if (current.phase == RelayV2TerminalPreOpenPhase.PENDING_OPEN) {
                    val pending = requireNotNull(current.pendingOpen)
                    RelayV2TerminalAction.BeginOpenAttempt(
                        deliveryToken = delivery,
                        requestId = requestId,
                        openAttempt = pending.openAttempt,
                        mode = pending.mode,
                        cols = pending.cols,
                        rows = pending.rows,
                        target = pending.target,
                        parserContinuityId = pending.parserContinuityId,
                        resume = pending.resume,
                    )
                } else {
                    val predecessor = requireNotNull(current.resetFence)
                    RelayV2TerminalAction.BeginOpenAttempt(
                        deliveryToken = predecessor.deliveryToken,
                        requestId = requestId,
                        openAttempt = openAttempt,
                        mode = RelayV2TerminalOpenMode.RESET,
                        cols = predecessor.cols,
                        rows = predecessor.rows,
                        target = predecessor.target,
                        parserContinuityId = predecessor.parserContinuityId,
                        resume = null,
                    )
                }
                val reduced = RelayV2TerminalCheckpointReducer.reduce(current, action)
                checkpoints[key] = RelayV2TerminalStoredCheckpoint.PreOpen(
                    requireNotNull(reduced.preOpenCheckpoint),
                )
                reducedActions += action
                committedStates += checkpoints.getValue(key)
                return RelayV2TerminalResumeClaim(key, reduced)
            }
            val checkpoint =
                (stored as RelayV2TerminalStoredCheckpoint.Present).checkpoint
            val restored = RelayV2TerminalCheckpointReducer.restore(
                RelayV2TerminalStoredCheckpoint.Present(checkpoint),
                checkpoint.identity,
                checkpoint.openAttempt,
                delivery,
                checkpoint.parserContinuityId,
            )
            val current = requireNotNull(restored.checkpoint)
            if (current.pendingClose != null) {
                val reduced = RelayV2TerminalCheckpointReducer.redeliverPendingClose(current)
                checkpoints[key] = RelayV2TerminalStoredCheckpoint.Present(current)
                committedStates += checkpoints.getValue(key)
                return RelayV2TerminalResumeClaim(key, reduced)
            }
            val resume = RelayV2TerminalOpenResume(
                generation = current.identity.generation,
                nextOffset = current.parserAppliedNextOffset,
                resumeTokenCredentialReference = current.identity.resumeTokenCredentialReference,
                resumeTokenCredentialFingerprint =
                    current.identity.resumeTokenCredentialFingerprint,
            )
            val action = RelayV2TerminalAction.BeginOpenAttempt(
                deliveryToken = delivery,
                requestId = requestId,
                openAttempt = openAttempt,
                mode = RelayV2TerminalOpenMode.RESUME,
                cols = cols,
                rows = rows,
                target = current.identity.target(),
                parserContinuityId = current.parserContinuityId,
                resume = resume,
            )
            val reduced = RelayV2TerminalCheckpointReducer.reduce(current, action)
            checkpoints[key] = RelayV2TerminalStoredCheckpoint.Present(
                requireNotNull(reduced.checkpoint),
            )
            reducedActions += action
            committedStates += checkpoints.getValue(key)
            return RelayV2TerminalResumeClaim(key, reduced)
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
            reducedActions += action
            checkpoints[key]?.let(committedStates::add)
            return reduced
        }

        override suspend fun recoverPostCommitUnknown(
            authority: RelayV2RepositoryEffectAuthority,
            key: RelayV2TerminalCheckpointKey,
        ): RelayV2TerminalReduction? = null

        override suspend fun ensureTerminalCloseWhenOpenedUnderApplyLease(
            authority: RelayV2RepositoryEffectAuthority,
            key: RelayV2TerminalCheckpointKey,
            pendingClose: RelayV2TerminalPendingClose,
        ): RelayV2TerminalReduction? {
            val stored = checkpoints[key] as? RelayV2TerminalStoredCheckpoint.PreOpen
                ?: return null
            if (stored.checkpoint.deliveryToken.actorGeneration != authority.generation ||
                stored.checkpoint.target != key.toTarget()
            ) return null
            val reduced = RelayV2TerminalCheckpointReducer.ensureCloseWhenOpened(
                stored.checkpoint,
                pendingClose,
            )
            val checkpoint = reduced.preOpenCheckpoint ?: return null
            checkpoints[key] = RelayV2TerminalStoredCheckpoint.PreOpen(checkpoint)
            committedStates += checkpoints.getValue(key)
            return reduced
        }

        override suspend fun adoptDetachedTerminalOpenedForCloseUnderApplyLease(
            authority: RelayV2RepositoryEffectAuthority,
            key: RelayV2TerminalCheckpointKey,
            action: RelayV2TerminalAction.Opened,
            pendingClose: RelayV2TerminalPendingClose,
        ): RelayV2TerminalReduction? {
            val stored = checkpoints[key] as? RelayV2TerminalStoredCheckpoint.PreOpen
                ?: return null
            if (stored.checkpoint.deliveryToken.actorGeneration != authority.generation ||
                stored.checkpoint.target != key.toTarget()
            ) return null
            val reduced = RelayV2TerminalCheckpointReducer.reduceOpenedForClose(
                stored.checkpoint,
                action,
                pendingClose,
            )
            val checkpoint = reduced.checkpoint ?: return null
            if (reduced.outcome != RelayV2TerminalOutcome.Applied ||
                reduced.effects.singleOrNull() !is RelayV2TerminalEffect.SendClose
            ) return null
            checkpoints[key] = RelayV2TerminalStoredCheckpoint.Present(checkpoint)
            committedStates += checkpoints.getValue(key)
            return reduced
        }

        override suspend fun correlateDetachedTerminalErrorUnderApplyLease(
            authority: RelayV2RepositoryEffectAuthority,
            key: RelayV2TerminalCheckpointKey,
            action: RelayV2TerminalAction.CorrelatedError,
        ): RelayV2DetachedTerminalErrorResult {
            val stored = checkpoints[key] ?: return RelayV2DetachedTerminalErrorResult.NotOwned
            val actorGeneration = when (stored) {
                is RelayV2TerminalStoredCheckpoint.PreOpen ->
                    stored.checkpoint.deliveryToken.actorGeneration
                is RelayV2TerminalStoredCheckpoint.Present ->
                    stored.checkpoint.deliveryToken.actorGeneration
                else -> return RelayV2DetachedTerminalErrorResult.NotOwned
            }
            if (actorGeneration != authority.generation) {
                return RelayV2DetachedTerminalErrorResult.NotOwned
            }
            val currentOpenRequestId = when (stored) {
                is RelayV2TerminalStoredCheckpoint.PreOpen ->
                    stored.checkpoint.pendingOpen?.requestId
                is RelayV2TerminalStoredCheckpoint.Present ->
                    stored.checkpoint.pendingOpen?.requestId
                else -> null
            }
            val reduced = when (stored) {
                is RelayV2TerminalStoredCheckpoint.PreOpen ->
                    RelayV2TerminalCheckpointReducer.reduce(stored.checkpoint, action)
                is RelayV2TerminalStoredCheckpoint.Present ->
                    RelayV2TerminalCheckpointReducer.reduce(stored.checkpoint, action)
                else -> return RelayV2DetachedTerminalErrorResult.NotOwned
            }
            return when (val outcome = reduced.outcome) {
                is RelayV2TerminalOutcome.CorrelatedErrorRejected -> {
                    reduced.preOpenCheckpoint?.let {
                        checkpoints[key] = RelayV2TerminalStoredCheckpoint.PreOpen(it)
                    }
                    reduced.checkpoint?.let {
                        checkpoints[key] = RelayV2TerminalStoredCheckpoint.Present(it)
                    }
                    RelayV2DetachedTerminalErrorResult.Consumed(
                        action.error.takeIf { action.requestId == currentOpenRequestId },
                    )
                }
                is RelayV2TerminalOutcome.ProtocolViolation ->
                    RelayV2DetachedTerminalErrorResult.ProtocolViolation(outcome.code)
                is RelayV2TerminalOutcome.Ignored ->
                    RelayV2DetachedTerminalErrorResult.NotOwned
                else -> RelayV2DetachedTerminalErrorResult.ProtocolViolation("unexpected")
            }
        }

        override suspend fun correlateDetachedTerminalOpenedUnderApplyLease(
            authority: RelayV2RepositoryEffectAuthority,
            key: RelayV2TerminalCheckpointKey,
            action: RelayV2TerminalAction.Opened,
        ): RelayV2DetachedTerminalOpenedResult {
            val stored = checkpoints[key] ?: return RelayV2DetachedTerminalOpenedResult.NotOwned
            val pending = when (stored) {
                is RelayV2TerminalStoredCheckpoint.PreOpen -> stored.checkpoint.pendingOpen
                is RelayV2TerminalStoredCheckpoint.Present -> stored.checkpoint.pendingOpen
                else -> null
            } ?: return RelayV2DetachedTerminalOpenedResult.NotOwned
            val delivery = when (stored) {
                is RelayV2TerminalStoredCheckpoint.PreOpen -> stored.checkpoint.deliveryToken
                is RelayV2TerminalStoredCheckpoint.Present -> stored.checkpoint.deliveryToken
                else -> return RelayV2DetachedTerminalOpenedResult.NotOwned
            }
            if (delivery.actorGeneration != authority.generation) {
                return RelayV2DetachedTerminalOpenedResult.NotOwned
            }
            val reduced = when (stored) {
                is RelayV2TerminalStoredCheckpoint.PreOpen ->
                    RelayV2TerminalCheckpointReducer.reduceDetachedOpened(
                        stored.checkpoint,
                        action,
                    )
                is RelayV2TerminalStoredCheckpoint.Present ->
                    RelayV2TerminalCheckpointReducer.reduceDetachedOpened(
                        stored.checkpoint,
                        action,
                    )
                else -> return RelayV2DetachedTerminalOpenedResult.NotOwned
            }
            return when {
                reduced.outcome == RelayV2TerminalOutcome.ResetRequired(
                    RelayV2TerminalResetReason.STREAM_LOST,
                ) &&
                    action.requestId == pending.requestId ->
                    RelayV2DetachedTerminalOpenedResult.Current.also {
                        checkpoints[key] = RelayV2TerminalStoredCheckpoint.Present(
                            requireNotNull(reduced.checkpoint),
                        )
                    }
                reduced.outcome == RelayV2TerminalOutcome.Ignored(
                    RelayV2TerminalIgnoredReason.STALE_OPEN_RESPONSE,
                ) && action.requestId in pending.issuedRequestIds ->
                    RelayV2DetachedTerminalOpenedResult.IssuedOld
                reduced.outcome is RelayV2TerminalOutcome.ProtocolViolation ->
                    RelayV2DetachedTerminalOpenedResult.ProtocolViolation(
                        (reduced.outcome as RelayV2TerminalOutcome.ProtocolViolation).code,
                    )
                else -> RelayV2DetachedTerminalOpenedResult.ProtocolViolation("unexpected")
            }
        }

        override suspend fun consumeDetachedTerminalClosedUnderApplyLease(
            authority: RelayV2RepositoryEffectAuthority,
            key: RelayV2TerminalCheckpointKey,
            action: RelayV2TerminalAction.Closed,
        ): RelayV2TerminalReduction? {
            val checkpoint = (checkpoints[key] as? RelayV2TerminalStoredCheckpoint.Present)
                ?.checkpoint ?: return null
            if (checkpoint.deliveryToken.actorGeneration != authority.generation) return null
            return RelayV2TerminalCheckpointReducer.reduceDetachedClosed(
                checkpoint,
                action,
            ).also { reduced ->
                if (reduced.outcome == RelayV2TerminalOutcome.ClosedFinalized) {
                    checkpoints[key] = RelayV2TerminalStoredCheckpoint.Present(
                        requireNotNull(reduced.checkpoint),
                    )
                }
            }
        }

        override suspend fun claimTerminalCloseUnderApplyLease(
            authority: RelayV2RepositoryEffectAuthority,
            key: RelayV2TerminalCheckpointKey,
            pendingClose: RelayV2TerminalPendingClose,
        ): RelayV2TerminalResumeClaim? {
            val checkpoint = (checkpoints[key] as? RelayV2TerminalStoredCheckpoint.Present)
                ?.checkpoint ?: return null
            val rebound = if (checkpoint.deliveryToken.actorGeneration == authority.generation) {
                checkpoint
            } else {
                RelayV2TerminalCheckpointReducer.reduce(
                    checkpoint,
                    RelayV2TerminalAction.RebindDelivery(
                        checkpoint.identity,
                        checkpoint.deliveryToken,
                        RelayV2TerminalDeliveryToken(
                            authority.generation,
                            checkpoint.deliveryToken.authorityGeneration + 1,
                            1,
                        ),
                        checkpoint.parserContinuityId,
                    ),
                ).checkpoint ?: return null
            }
            val reduced = RelayV2TerminalCheckpointReducer.requestDetachedClose(
                rebound,
                pendingClose,
            )
            if (reduced.outcome != RelayV2TerminalOutcome.Applied) return null
            checkpoints[key] = RelayV2TerminalStoredCheckpoint.Present(
                requireNotNull(reduced.checkpoint),
            )
            return RelayV2TerminalResumeClaim(key, reduced)
        }

        fun stored(key: RelayV2TerminalCheckpointKey): RelayV2TerminalStoredCheckpoint =
            checkpoints.getValue(key)

        fun install(
            key: RelayV2TerminalCheckpointKey,
            checkpoint: RelayV2TerminalStoredCheckpoint,
        ) {
            checkpoints[key] = checkpoint
        }
    }

    private class RecordingCredentials : RelayV2TerminalResumeCredentialStore {
        private val values = mutableMapOf<String, String>()
        var readCount = 0
            private set
        var installCount = 0
            private set

        override fun installExact(
            owner: RelayV2TerminalResumeCredentialOwner,
            reference: String,
            resumeToken: String,
        ): RelayV2TerminalResumeCredentialInstall? {
            val existing = values[reference]
            if (existing != null && existing != resumeToken) return null
            values[reference] = resumeToken
            installCount += 1
            return RelayV2TerminalResumeCredentialInstall(
                fingerprint(resumeToken),
                existing == null,
            )
        }

        override fun read(
            owner: RelayV2TerminalResumeCredentialOwner,
            reference: String,
        ): String? {
            readCount += 1
            return values[reference]
        }

        override fun clear(
            owner: RelayV2TerminalResumeCredentialOwner,
            reference: String,
        ) {
            values.remove(reference)
        }

        override fun clearProfile(profileId: String, throughActivationGeneration: Long) = Unit
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
        override fun maximumFencedConnectionGeneration() =
            fences.values.maxOfOrNull { it.connectionGeneration }
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
