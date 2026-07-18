package com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec

import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2JsonLimits
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2StrictJson
import java.nio.charset.StandardCharsets
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class AgentTranscriptLifecycleV1CodecContractTest {
    private val codec = AgentTranscriptLifecycleV1Codec()
    private val fixtures = AgentTranscriptLifecycleV1Fixtures()

    @Test
    fun everySharedGoldenFrameHasAStableTypedRoundTrip() {
        val decodedTypes = linkedSetOf<String>()
        fixtures.golden.forEach { fixture ->
            val bytes = fixture.wire.toByteArray(StandardCharsets.UTF_8)
            val decoded = codec.decodePublicFrame(bytes)
            decodedTypes += decoded.type
            assertEquals(fixture.name, fixture.type, decoded.type)
            assertArrayEquals(fixture.name, bytes, codec.encodePublicFrame(decoded))
            assertEquals(fixture.name, decoded, codec.decodePublicFrame(codec.encodePublicFrame(decoded)))
        }

        assertEquals(
            fixtures.manifestWireTypes,
            decodedTypes,
        )
        assertTrue(
            codec.decodePublicFrame(fixtures.wire("status-get")) is AgentTimelineStatusGetFrame,
        )
        assertTrue(
            codec.decodePublicFrame(fixtures.wire("status-available")) is AgentTimelineStatusFrame,
        )
        assertTrue(
            codec.decodePublicFrame(fixtures.wire("snapshot-page-materialized"))
                is AgentTimelineSnapshotPageFrame,
        )
        assertTrue(
            codec.decodePublicFrame(fixtures.wire("replay-page-lifecycle-and-entry"))
                is AgentTimelineReplayPageFrame,
        )
        assertTrue(
            codec.decodePublicFrame(fixtures.wire("live-entry-redacted"))
                is AgentTimelineEventFrame,
        )
        assertTrue(
            codec.decodePublicFrame(fixtures.wire("timeline-deleted-reset"))
                is AgentTimelineResetFrame,
        )
    }

    @Test
    fun everySharedInvalidFrameFailsForItsContractCategory() {
        assertEquals(
            fixtures.manifestRequiredInvalidCategories,
            fixtures.invalid.map { it.category }.toSet(),
        )
        fixtures.invalid.forEach { fixture ->
            val error = assertThrows(
                fixture.name,
                AgentTranscriptLifecycleV1CodecException::class.java,
            ) {
                codec.decodePublicFrame(fixture.wire.toByteArray(StandardCharsets.UTF_8))
            }
            assertEquals(fixture.name, fixture.expectedError, error.code)
            assertEquals(
                fixture.name,
                when (fixture.category) {
                    "unknown-field",
                    "raw-terminal-transcript",
                    "tool-call-body",
                    "attachment",
                    -> "unknown-field"
                    "noncanonical-counter" -> "non-canonical-counter"
                    "nonpositive-agent-event-sequence",
                    "nonpositive-available-cut-sequence",
                    -> "invalid-argument"
                    "timeline-reset-lineage-rotation" -> "reset-shape"
                    "replay-page-continuation" -> "replay-page-shape"
                    "invalid-lifecycle-scope" -> "lifecycle-binding"
                    "snapshot-page-shape" -> "page-shape"
                    "snapshot-watermark" -> "snapshot-watermark"
                    "host-epoch-error-details" -> "missing-field"
                    "agent-command-correlation" -> "agent-command-correlation"
                    else -> error("Unmapped invalid category " + fixture.category)
                },
                error.failureClass,
            )
        }
    }

    @Test
    fun correlatedExtensionErrorsDecodeToTheFrozenClosedCodeSet() {
        val decodedCodes = fixtures.manifestExtensionErrorCodes.map { wireCode ->
            val frame = correlatedErrorFrame(wireCode)
            val bytes = RelayV2StrictJson.stringify(frame).toByteArray(StandardCharsets.UTF_8)
            val decoded = codec.decodePublicFrame(bytes) as AgentTimelineErrorFrame

            assertEquals("request-agent-timeline", decoded.requestId)
            assertEquals("mac-admin", decoded.hostId)
            assertEquals("host-epoch-1", decoded.hostEpoch)
            assertEquals("scope-local", decoded.scopeId)
            assertEquals("session-1", decoded.sessionId)
            assertEquals(wireCode, decoded.error.code.wireValue)
            assertEquals(
                AgentTimelineErrorCommandDisposition.NOT_APPLICABLE,
                decoded.error.commandDisposition,
            )
            assertArrayEquals(bytes, codec.encodePublicFrame(decoded))
            assertEquals(decoded, codec.decodePublicFrame(codec.encodePublicFrame(decoded)))
            decoded.error.code.wireValue
        }.toSet()

        assertEquals(fixtures.manifestExtensionErrorCodes, decodedCodes)
        assertEquals(
            fixtures.manifestExtensionErrorCodes + "HOST_EPOCH_MISMATCH",
            AgentTimelineErrorCode.entries.map { it.wireValue }.toSet(),
        )

        val hostEpochMismatch = correlatedErrorFrame(
            code = "HOST_EPOCH_MISMATCH",
            message = "",
            details = linkedMapOf(
                "expectedHostEpoch" to "host-epoch-1",
                "actualHostEpoch" to "host-epoch-2",
            ),
        )
        hostEpochMismatch["hostEpoch"] = "host-epoch-2"
        val decodedHostEpochMismatch = decode(hostEpochMismatch) as AgentTimelineErrorFrame
        assertEquals(AgentTimelineErrorCode.HOST_EPOCH_MISMATCH, decodedHostEpochMismatch.error.code)
        assertEquals("", decodedHostEpochMismatch.error.message)
        assertEquals(
            AgentTimelineHostEpochMismatchDetails(
                expectedHostEpoch = "host-epoch-1",
                actualHostEpoch = "host-epoch-2",
            ),
            decodedHostEpochMismatch.error.details,
        )
        assertArrayEquals(
            RelayV2StrictJson.stringify(hostEpochMismatch).toByteArray(StandardCharsets.UTF_8),
            codec.encodePublicFrame(decodedHostEpochMismatch),
        )

        val retryable = correlatedErrorFrame(
            code = "AGENT_TIMELINE_UNAVAILABLE",
            retryAfterMs = 250L,
        )
        val decodedRetryable = decode(retryable) as AgentTimelineErrorFrame
        assertEquals(true, decodedRetryable.error.retryable)
        assertEquals(250L, decodedRetryable.error.retryAfterMs)

        val baseErrorCode = correlatedErrorFrame("EVENT_CURSOR_AHEAD")
        assertRejected(baseErrorCode, "schema-mismatch")

        val machineDisposition = correlatedErrorFrame("AGENT_CURSOR_EXPIRED")
        machineDisposition.structuredError()["commandDisposition"] = "gap_resync"
        assertRejected(machineDisposition, "schema-mismatch")

        val uncorrelated = correlatedErrorFrame("AGENT_CURSOR_AHEAD")
        uncorrelated.remove("requestId")
        assertRejected(uncorrelated, "missing-field")

        val missingTarget = correlatedErrorFrame("AGENT_TIMELINE_EPOCH_MISMATCH")
        missingTarget.remove("sessionId")
        assertRejected(missingTarget, "missing-field")

        val details = correlatedErrorFrame("AGENT_SNAPSHOT_EXPIRED")
        details.structuredError()["details"] = linkedMapOf("text" to "must-not-pass")
        assertRejected(details, "schema-mismatch")
    }

    @Test
    fun framingIsOneMiBStrictUtf8DuplicateSafeAndTextOnly() {
        assertRejected(
            ByteArray(AgentTranscriptLifecycleV1Codec.MAX_PUBLIC_FRAME_BYTES + 1),
            expectedFailure = "frame-limit",
        )
        assertRejected(
            byteArrayOf(0xC3.toByte(), 0x28),
            expectedFailure = "invalid-utf8",
        )

        val duplicate = fixtures.golden.single { it.name == "status-get" }.wire.replace(
            "\"type\":\"agent.timeline.status.get\"",
            "\"type\":\"agent.timeline.status.get\",\"type\":\"agent.timeline.status.get\"",
        )
        assertRejected(
            duplicate.toByteArray(StandardCharsets.UTF_8),
            expectedFailure = "duplicate-key",
        )

        val frame = fixtures.wire("status-get")
        assertRejected(
            frame,
            metadata = AgentTranscriptLifecycleV1FrameMetadata(opcode = "binary"),
            expectedFailure = "binary-frame",
        )
        val compressed = assertRejected(
            frame,
            metadata = AgentTranscriptLifecycleV1FrameMetadata(compressed = true),
            expectedCode = "PROTOCOL_UNSUPPORTED",
            expectedFailure = "compression-not-allowed",
        )
        assertEquals("PROTOCOL_UNSUPPORTED", compressed.code)
    }

    @Test
    fun publicDecoderAcceptsSemanticWhitespaceKeyOrderAndEscapes() {
        val canonical = fixtures.golden.single { it.name == "status-get" }.wire
        val expected = codec.decodePublicFrame(canonical.toByteArray(StandardCharsets.UTF_8))
        listOf(
            " $canonical",
            canonical.replace(
                "{\"protocolVersion\":2,\"kind\":\"request\"",
                "{\"kind\":\"request\",\"protocolVersion\":2",
            ),
            canonical.replace("\"mac-admin\"", "\"\\u006d\\u0061c-admin\""),
        ).forEach { variant ->
            assertEquals(
                expected,
                codec.decodePublicFrame(variant.toByteArray(StandardCharsets.UTF_8)),
            )
        }
    }

    @Test
    fun codecIssuedPageArtifactsBindTheCompleteTypedFrameToActualRawByteCount() {
        val replayFrame = fixtures.frame("replay-page-lifecycle-and-entry")
        replayFrame.payload().apply {
            this["replayThroughAgentSeq"] = "12"
            this["isLast"] = false
            this["nextCursor"] = "cursor-page-2"
        }
        val replayRaw = RelayV2StrictJson.stringify(replayFrame)
            .toByteArray(StandardCharsets.UTF_8)
        val replay = codec.decodePublicFrameArtifact(replayRaw)
            as AgentTimelineReplayPagePublicFrameArtifact

        assertEquals(replayRaw.size, replay.rawUtf8ByteCount)
        assertEquals(2, replay.protocolVersion)
        assertEquals(AgentTranscriptLifecycleV1FrameKind.RESPONSE, replay.kind)
        assertEquals("agent.timeline.replay.page", replay.type)
        assertEquals("agent.transcript-lifecycle.v1", replay.capability)
        assertEquals("agent-replay-1", replay.requestId)
        assertEquals("mac-admin", replay.hostId)
        assertEquals("host-epoch-1", replay.hostEpoch)
        assertEquals("scope-local", replay.scopeId)
        assertEquals("session-1", replay.sessionId)
        assertSame(replay.frame.page, replay.payload)
        assertEquals("timeline-1", replay.timelineEpoch)
        assertEquals("8", replay.afterAgentSeq)
        assertEquals("12", replay.replayThroughAgentSeq)
        assertEquals(false, replay.isLast)
        assertEquals("cursor-page-2", replay.nextCursor)
        assertSame(replay.frame.page.events, replay.events)
        assertEquals(replay.frame, codec.decodePublicFrame(replayRaw))
        val replayEventsBeforeMutation = replay.events.toList()
        val mutableReplayEvents = replay.events as MutableList<AgentTimelineEventRecord>
        assertThrows(UnsupportedOperationException::class.java) {
            mutableReplayEvents.clear()
        }
        assertEquals(replayEventsBeforeMutation, replay.events)
        assertSame(replay.frame.page.events, replay.events)

        val canonicalSnapshotRaw = fixtures.wire("snapshot-page-materialized")
        val nonCanonicalSnapshotRaw = fixtures.golden
            .single { it.name == "snapshot-page-materialized" }
            .wire
            .replace(
                "{\"protocolVersion\":2,\"kind\":\"response\"",
                "{\n  \"kind\": \"response\", \"protocolVersion\": 2",
            )
            .replace("\"mac-admin\"", "\"\\u006d\\u0061c-admin\"")
            .toByteArray(StandardCharsets.UTF_8)
        val canonicalSnapshot = codec.decodePublicFrameArtifact(canonicalSnapshotRaw)
            as AgentTimelineSnapshotPagePublicFrameArtifact
        val snapshot = codec.decodePublicFrameArtifact(nonCanonicalSnapshotRaw)
            as AgentTimelineSnapshotPagePublicFrameArtifact

        assertEquals(canonicalSnapshot.frame, snapshot.frame)
        assertTrue(canonicalSnapshot.rawUtf8ByteCount != snapshot.rawUtf8ByteCount)
        assertEquals(canonicalSnapshotRaw.size, canonicalSnapshot.rawUtf8ByteCount)
        assertEquals(nonCanonicalSnapshotRaw.size, snapshot.rawUtf8ByteCount)
        assertEquals(2, snapshot.protocolVersion)
        assertEquals(AgentTranscriptLifecycleV1FrameKind.RESPONSE, snapshot.kind)
        assertEquals("agent.timeline.snapshot.page", snapshot.type)
        assertEquals("agent.transcript-lifecycle.v1", snapshot.capability)
        assertEquals("agent-snapshot-attempt-1", snapshot.requestId)
        assertEquals("mac-admin", snapshot.hostId)
        assertEquals("host-epoch-1", snapshot.hostEpoch)
        assertEquals("scope-local", snapshot.scopeId)
        assertEquals("session-1", snapshot.sessionId)
        assertSame(snapshot.frame.page, snapshot.payload)
        assertEquals("timeline-1", snapshot.timelineEpoch)
        assertEquals("agent-snapshot-logical-1", snapshot.snapshotRequestId)
        assertEquals("agent-snapshot-cut-1", snapshot.snapshotId)
        assertEquals(0L, snapshot.pageIndex)
        assertEquals(true, snapshot.isLast)
        assertEquals(null, snapshot.nextCursor)
        assertEquals("8", snapshot.throughAgentSeq)
        assertEquals("1", snapshot.earliestRetainedSeq)
        assertSame(snapshot.frame.page.records, snapshot.records)
        val snapshotRecordsBeforeMutation = snapshot.records.toList()
        val mutableSnapshotRecords =
            snapshot.records as MutableList<AgentTimelineSnapshotRecord>
        assertThrows(UnsupportedOperationException::class.java) {
            mutableSnapshotRecords.clear()
        }
        assertEquals(snapshotRecordsBeforeMutation, snapshot.records)
        assertSame(snapshot.frame.page.records, snapshot.records)
    }

    @Test
    fun canonicalPublicRecordSeamsRequireFixedOrderExactBytes() {
        val replay = codec.decodePublicFrame(
            fixtures.wire("replay-page-lifecycle-and-entry"),
        ) as AgentTimelineReplayPageFrame
        val event = replay.page.events.first()
        val eventBytes = codec.encodeCanonicalPublicEventRecord(event)
        assertEquals(event, codec.decodeCanonicalPublicEventRecord(eventBytes))
        listOf(
            " " + eventBytes.toString(StandardCharsets.UTF_8),
            eventBytes.toString(StandardCharsets.UTF_8).replace(
                "{\"agentEventSeq\":\"9\",\"eventId\":\"event-9\"",
                "{\"eventId\":\"event-9\",\"agentEventSeq\":\"9\"",
            ),
            eventBytes.toString(StandardCharsets.UTF_8)
                .replace("\"event-9\"", "\"\\u0065vent-9\""),
        ).forEach { variant ->
            val error = assertThrows(AgentTranscriptLifecycleV1CodecException::class.java) {
                codec.decodeCanonicalPublicEventRecord(
                    variant.toByteArray(StandardCharsets.UTF_8),
                )
            }
            assertEquals("non-canonical-record", error.failureClass)
        }

        val snapshot = codec.decodePublicFrame(
            fixtures.wire("snapshot-page-materialized"),
        ) as AgentTimelineSnapshotPageFrame
        val record = snapshot.page.records.first()
        val recordBytes = codec.encodeCanonicalPublicSnapshotRecord(record)
        assertEquals(record, codec.decodeCanonicalPublicSnapshotRecord(recordBytes))
        val reorderedRecord = recordBytes.toString(StandardCharsets.UTF_8).replace(
            "{\"recordType\":\"lifecycle\",\"lifecycleEventId\":\"event-2\"",
            "{\"lifecycleEventId\":\"event-2\",\"recordType\":\"lifecycle\"",
        )
        val recordError = assertThrows(AgentTranscriptLifecycleV1CodecException::class.java) {
            codec.decodeCanonicalPublicSnapshotRecord(
                reorderedRecord.toByteArray(StandardCharsets.UTF_8),
            )
        }
        assertEquals("non-canonical-record", recordError.failureClass)
    }

    @Test
    fun opaqueIdsAndCanonicalUint64CountersStayOpaqueAndBounded() {
        val arbitraryId = fixtures.frame("live-entry-redacted")
        arbitraryId["hostId"] = "__proto__/not-a-uuid"
        decode(arbitraryId)

        val maximumId = fixtures.frame("live-entry-redacted")
        maximumId["hostId"] = "x".repeat(128)
        decode(maximumId)

        val oversizedId = fixtures.frame("live-entry-redacted")
        oversizedId["hostId"] = "x".repeat(129)
        assertRejected(oversizedId, "id-byte-limit")

        val exactCursor = "é".repeat(512)
        assertEquals(1_024, exactCursor.toByteArray(StandardCharsets.UTF_8).size)
        val cursorAtLimit = fixtures.frame("replay-get")
        cursorAtLimit.payload()["cursor"] = exactCursor
        decode(cursorAtLimit)

        val oversizedCursor = exactCursor + "x"
        assertEquals(1_025, oversizedCursor.toByteArray(StandardCharsets.UTF_8).size)
        val cursorOverLimit = fixtures.frame("replay-get")
        cursorOverLimit.payload()["cursor"] = oversizedCursor
        assertRejected(cursorOverLimit, "id-byte-limit")

        val paddedId = fixtures.frame("live-entry-redacted")
        paddedId["hostId"] = " host"
        assertRejected(paddedId, "invalid-argument")

        val escapedSurrogate = fixtures.golden.single { it.name == "live-entry-redacted" }.wire
            .replace("\"hostId\":\"mac-admin\"", "\"hostId\":\"\\uD800\"")
        assertRejected(
            escapedSurrogate.toByteArray(StandardCharsets.UTF_8),
            expectedFailure = "invalid-unicode",
        )

        val maximumCounter = fixtures.frame("live-entry-redacted")
        maximumCounter.payload()["agentEventSeq"] = "18446744073709551615"
        val decoded = decode(maximumCounter) as AgentTimelineEventFrame
        assertEquals("18446744073709551615", decoded.event.agentEventSeq)

        val overflow = fixtures.frame("live-entry-redacted")
        overflow.payload()["agentEventSeq"] = "18446744073709551616"
        assertRejected(overflow, "counter-overflow")

        val leadingZero = fixtures.frame("live-entry-redacted")
        leadingZero.payload()["agentEventSeq"] = "01"
        assertRejected(leadingZero, "non-canonical-counter")

        val zeroEvent = fixtures.frame("live-entry-redacted")
        zeroEvent.payload()["agentEventSeq"] = "0"
        assertRejected(zeroEvent, "invalid-argument")

        val fractionalProtocolVersion = fixtures.frame("status-get")
        fractionalProtocolVersion["protocolVersion"] = 2.5
        assertRejected(fractionalProtocolVersion, "type-coercion")

        val fractionalPageIndex = fixtures.frame("snapshot-get-first-page")
        fractionalPageIndex.payload()["nextPageIndex"] = 0.0
        assertRejected(fractionalPageIndex, "type-coercion")

        val validDto = codec.decodePublicFrame(
            fixtures.wire("live-entry-redacted"),
        ) as AgentTimelineEventFrame
        val invalidDto = validDto.copy(event = validDto.event.copy(agentEventSeq = "01"))
        val encodeError = assertThrows(AgentTranscriptLifecycleV1CodecException::class.java) {
            codec.encodePublicFrame(invalidDto)
        }
        assertEquals("INVALID_ENVELOPE", encodeError.code)
        assertEquals("non-canonical-counter", encodeError.failureClass)
    }

    @Test
    fun textAndFailureSummaryLimitsCountStrictUtf8Bytes() {
        val exactText = "€".repeat(21_845) + "a"
        assertEquals(65_536, exactText.toByteArray(StandardCharsets.UTF_8).size)
        val textAtLimit = fixtures.frame("replay-page-lifecycle-and-entry")
        textAtLimit.replayEvents()[1].mutation().entry()["text"] = exactText
        decode(textAtLimit)

        val textOverLimit = fixtures.frame("replay-page-lifecycle-and-entry")
        textOverLimit.replayEvents()[1].mutation().entry()["text"] = exactText + "a"
        assertRejected(textOverLimit, "text-byte-limit")

        val summaryAtLimit = fixtures.frame("live-run-failed")
        summaryAtLimit.lifecycleMutation().failure()["summary"] = "é".repeat(512)
        decode(summaryAtLimit)

        val summaryOverLimit = fixtures.frame("live-run-failed")
        summaryOverLimit.lifecycleMutation().failure()["summary"] = "é".repeat(513)
        assertRejected(summaryOverLimit, "summary-byte-limit")
    }

    @Test
    fun availableStatusAndSnapshotWatermarksUseFrozenPositiveLimits() {
        listOf(
            "maxTextUtf8Bytes" to 65_535L,
            "maxPageRecords" to 255L,
            "snapshotLeaseMs" to 299_999L,
        ).forEach { (field, value) ->
            val status = fixtures.frame("status-available")
            status.payload().mapValue("limits")[field] = value
            assertRejected(status, "schema-mismatch")
        }

        val statusWatermark = fixtures.frame("status-available")
        statusWatermark.payload()["currentAgentSeq"] = "7"
        statusWatermark.payload()["earliestReplaySeq"] = "8"
        assertRejected(statusWatermark, "status-watermark")

        val snapshotWatermark = fixtures.frame("snapshot-page-materialized")
        snapshotWatermark.payload()["throughAgentSeq"] = "7"
        snapshotWatermark.payload()["earliestRetainedSeq"] = "8"
        assertRejected(snapshotWatermark, "snapshot-watermark")
    }

    @Test
    fun snapshotAndReplayPagesAcceptAtMost256TypedItems() {
        val snapshotAtLimit = fixtures.frame("snapshot-page-materialized")
        snapshotAtLimit.payload()["throughAgentSeq"] = "256"
        snapshotAtLimit.payload()["records"] = List(256) { index ->
            lifecycleRecord((index + 1).toString())
        }.toMutableList()
        val snapshot = decode(snapshotAtLimit) as AgentTimelineSnapshotPageFrame
        assertEquals(256, snapshot.page.records.size)

        val snapshotOverLimit = fixtures.frame("snapshot-page-materialized")
        snapshotOverLimit.payload()["throughAgentSeq"] = "257"
        snapshotOverLimit.payload()["records"] = List(257) { index ->
            lifecycleRecord((index + 1).toString())
        }.toMutableList()
        assertRejected(snapshotOverLimit, "invalid-argument")

        val replayAtLimit = fixtures.frame("replay-page-lifecycle-and-entry")
        replayAtLimit.payload()["afterAgentSeq"] = "0"
        replayAtLimit.payload()["replayThroughAgentSeq"] = "256"
        replayAtLimit.payload()["events"] = List(256) { index ->
            deletionEvent((index + 1).toString())
        }.toMutableList()
        val replay = decode(replayAtLimit) as AgentTimelineReplayPageFrame
        assertEquals(256, replay.page.events.size)

        val replayOverLimit = fixtures.frame("replay-page-lifecycle-and-entry")
        replayOverLimit.payload()["afterAgentSeq"] = "0"
        replayOverLimit.payload()["replayThroughAgentSeq"] = "257"
        replayOverLimit.payload()["events"] = List(257) { index ->
            deletionEvent((index + 1).toString())
        }.toMutableList()
        assertRejected(replayOverLimit, "invalid-argument")
    }

    @Test
    fun snapshotRecordsAreGloballyOrderedWithinThePinnedPage() {
        val outOfOrder = fixtures.frame("snapshot-page-materialized")
        val records = outOfOrder.snapshotRecords()
        val first = records.removeAt(0)
        records.add(1, first)
        assertRejected(outOfOrder, "snapshot-record-order")
    }

    @Test
    fun replayPagesAreContinuousAndTerminateExactlyAtThePinnedCut() {
        val laterContinuation = fixtures.frame("replay-page-lifecycle-and-entry")
        laterContinuation.replayEvents().removeAt(0)
        val decodedContinuation = decode(laterContinuation) as AgentTimelineReplayPageFrame
        assertEquals("10", decodedContinuation.page.events.first().agentEventSeq)

        val gapWithinPage = fixtures.frame("replay-page-lifecycle-and-entry")
        gapWithinPage.replayEvents().removeAt(1)
        assertRejected(gapWithinPage, "replay-sequence")

        val afterAhead = fixtures.frame("replay-page-lifecycle-and-entry")
        afterAhead.payload()["afterAgentSeq"] = "12"
        assertRejected(afterAhead, "replay-watermark")

        val validContinuation = fixtures.frame("replay-page-lifecycle-and-entry")
        validContinuation.payload()["replayThroughAgentSeq"] = "12"
        validContinuation.payload()["isLast"] = false
        validContinuation.payload()["nextCursor"] = "cursor-page-2"
        decode(validContinuation)

        val finalStopsEarly = fixtures.frame("replay-page-lifecycle-and-entry")
        finalStopsEarly.payload()["replayThroughAgentSeq"] = "12"
        assertRejected(finalStopsEarly, "replay-page-shape")

        val invalidEmpty = fixtures.frame("replay-page-empty-genesis-cut")
        invalidEmpty.payload()["replayThroughAgentSeq"] = "1"
        assertRejected(invalidEmpty, "replay-page-shape")

        val genesis = codec.decodePublicFrame(
            fixtures.wire("replay-page-empty-genesis-cut"),
        ) as AgentTimelineReplayPageFrame
        assertEquals("0", genesis.page.afterAgentSeq)
        assertEquals("0", genesis.page.replayThroughAgentSeq)
        assertTrue(genesis.page.events.isEmpty())
    }

    @Test
    fun entryContentAndLifecycleBindingsAreClosed() {
        val replay = codec.decodePublicFrame(
            fixtures.wire("replay-page-lifecycle-and-entry"),
        ) as AgentTimelineReplayPageFrame
        val agentAppend = replay.page.events[1].mutation as AgentTimelineTextEntryAppendedMutation
        assertEquals(AgentTimelineEntryRole.AGENT, agentAppend.entry.metadata.role)
        assertEquals(null, agentAppend.entry.metadata.commandId)

        val agentCommand = fixtures.frame("replay-page-lifecycle-and-entry")
        agentCommand.replayEvents()[1].mutation().entry()["commandId"] = "command-claim"
        assertRejected(agentCommand, "agent-command-correlation")

        val modifiedVisibleSnapshotEntry = fixtures.frame("snapshot-page-materialized")
        modifiedVisibleSnapshotEntry.snapshotRecords()[1]["lastModifiedAgentSeq"] = "4"
        assertRejected(modifiedVisibleSnapshotEntry, "entry-sequence-binding")

        val unmodifiedRedactedSnapshotEntry = fixtures.frame("snapshot-page-materialized")
        unmodifiedRedactedSnapshotEntry.snapshotRecords()[2]["lastModifiedAgentSeq"] = "5"
        assertRejected(unmodifiedRedactedSnapshotEntry, "entry-sequence-binding")

        listOf("live-entry-redacted", "live-entry-deleted").forEach { fixtureName ->
            val bodyLeak = fixtures.frame(fixtureName)
            bodyLeak.payload().mutation()["text"] = "must-not-survive"
            assertRejected(bodyLeak, "unknown-field")
        }

        val turnWithoutTurnId = fixtures.frame("replay-page-lifecycle-and-entry")
        turnWithoutTurnId.replayEvents()[0].mutation().lifecycle()["turnId"] = null
        assertRejected(turnWithoutTurnId, "lifecycle-binding")

        val runningWithFailure = fixtures.frame("replay-page-lifecycle-and-entry")
        runningWithFailure.replayEvents()[0].mutation().lifecycle()["failure"] = linkedMapOf(
            "code" to "fabricated",
            "summary" to null,
        )
        assertRejected(runningWithFailure, "schema-mismatch")

        val failedWithoutFailure = fixtures.frame("live-run-failed")
        failedWithoutFailure.lifecycleMutation()["failure"] = null
        assertRejected(failedWithoutFailure, "forbidden-null")

        val lifecycleMirrorConflict = fixtures.frame("live-run-failed")
        lifecycleMirrorConflict.lifecycleMutation()["lifecycleEventId"] = "different-event"
        assertRejected(lifecycleMirrorConflict, "lifecycle-event-binding")

        val appendMirrorConflict = fixtures.frame("replay-page-lifecycle-and-entry")
        appendMirrorConflict.replayEvents()[1].mutation().entry().apply {
            this["createdAgentSeq"] = "9"
            this["lastModifiedAgentSeq"] = "9"
        }
        assertRejected(appendMirrorConflict, "entry-event-binding")

        val appendTimeConflict = fixtures.frame("replay-page-lifecycle-and-entry")
        appendTimeConflict.replayEvents()[1].mutation().entry()["createdAtMs"] =
            1_783_700_500_001L
        assertRejected(appendTimeConflict, "entry-event-binding")

        val interruptedWithoutReason = fixtures.frame("replay-page-lifecycle-and-entry")
        interruptedWithoutReason.replayEvents()[2].mutation()["reason"] = null
        assertRejected(interruptedWithoutReason, "source-availability-binding")

        val connectedAfterRestart = fixtures.frame("replay-page-lifecycle-and-entry")
        connectedAfterRestart.replayEvents()[2].mutation().apply {
            this["state"] = "connected"
            this["reason"] = "source_restarted"
        }
        decode(connectedAfterRestart)
    }

    @Test
    fun timelineResetReasonClosesTheNewEpochShape() {
        val repeatedEpoch = fixtures.frame("timeline-deleted-reset")
        repeatedEpoch.payload()["newTimelineEpoch"] =
            repeatedEpoch.payload().getValue("previousTimelineEpoch")
        assertRejected(repeatedEpoch, "reset-shape")

        val emptyEpoch = fixtures.frame("timeline-deleted-reset")
        emptyEpoch.payload()["newTimelineEpoch"] = ""
        assertRejected(emptyEpoch, "invalid-argument")

        val storeReset = codec.decodePublicFrame(
            fixtures.wire("timeline-store-reset-unavailable"),
        ) as AgentTimelineResetFrame
        assertEquals(AgentTimelineResetReason.STORE_RESET, storeReset.reason)
        assertEquals(null, storeReset.newTimelineEpoch)

        val storeResetWithEpoch = fixtures.frame("timeline-store-reset-unavailable")
        storeResetWithEpoch.payload()["newTimelineEpoch"] = "timeline-after-store-reset"
        assertRejected(storeResetWithEpoch, "reset-shape")
    }

    @Test
    fun terminalAckAndTimeSignalsCannotBecomeAgentState() {
        val baseTerminalFrame = linkedMapOf<String, Any?>(
            "protocolVersion" to 2L,
            "kind" to "event",
            "type" to "terminal.output_ack",
            "streamId" to "stream-1",
            "payload" to linkedMapOf(
                "generation" to "generation-1",
                "nextOffset" to "1",
            ),
        )
        assertRejected(baseTerminalFrame, "unknown-message-type")

        listOf(
            "terminalOutput" to "done",
            "commandAck" to true,
            "idleForMs" to 10_000L,
            "processExited" to true,
        ).forEach { (field, value) ->
            val inferred = fixtures.frame("live-run-failed")
            inferred.payload().mutation()[field] = value
            assertRejected(inferred, "unknown-field")
        }
    }

    private fun decode(frame: Map<String, Any?>): AgentTranscriptLifecycleV1Frame =
        codec.decodePublicFrame(
            RelayV2StrictJson.stringify(frame).toByteArray(StandardCharsets.UTF_8),
        )

    private fun assertRejected(
        frame: Map<String, Any?>,
        expectedFailure: String,
    ): AgentTranscriptLifecycleV1CodecException = assertRejected(
        RelayV2StrictJson.stringify(frame).toByteArray(StandardCharsets.UTF_8),
        expectedFailure = expectedFailure,
    )

    private fun assertRejected(
        bytes: ByteArray,
        metadata: AgentTranscriptLifecycleV1FrameMetadata =
            AgentTranscriptLifecycleV1FrameMetadata(),
        expectedCode: String = "INVALID_ENVELOPE",
        expectedFailure: String,
    ): AgentTranscriptLifecycleV1CodecException {
        val error = assertThrows(AgentTranscriptLifecycleV1CodecException::class.java) {
            codec.decodePublicFrame(bytes, metadata)
        }
        assertEquals(expectedCode, error.code)
        assertEquals(expectedFailure, error.failureClass)
        return error
    }
}

private data class AgentTranscriptLifecycleV1GoldenFixture(
    val name: String,
    val type: String,
    val wire: String,
)

private data class AgentTranscriptLifecycleV1InvalidFixture(
    val name: String,
    val category: String,
    val expectedError: String,
    val wire: String,
)

private class AgentTranscriptLifecycleV1Fixtures {
    private val base = "extensions/agent-transcript-lifecycle/v1"
    private val manifest = readObject("$base/manifest.json")
    private val files = manifest.list("files").map(Any?::fixtureMap)
    private val goldenPath = files.single { it.string("kind") == "wire-golden" }.string("path")
    private val invalidPath = files.single { it.string("kind") == "wire-invalid" }.string("path")

    val manifestWireTypes: Set<String> = manifest.map("wire")
        .list("messageTypes")
        .map { it as? String ?: error("Manifest message type must be a string") }
        .toSet()

    val manifestExtensionErrorCodes: Set<String> = manifest.map("wire")
        .list("extensionErrorCodes")
        .map { it as? String ?: error("Manifest extension error code must be a string") }
        .toSet()

    val manifestRequiredInvalidCategories: Set<String> = manifest
        .list("requiredInvalidCategories")
        .map { it as? String ?: error("Manifest invalid category must be a string") }
        .toSet()

    val golden: List<AgentTranscriptLifecycleV1GoldenFixture> =
        readArray("$base/$goldenPath").map {
            AgentTranscriptLifecycleV1GoldenFixture(
                name = it.string("name"),
                type = it.string("type"),
                wire = it.string("wire"),
            )
        }

    val invalid: List<AgentTranscriptLifecycleV1InvalidFixture> =
        readArray("$base/$invalidPath").map {
            AgentTranscriptLifecycleV1InvalidFixture(
                name = it.string("name"),
                category = it.string("category"),
                expectedError = it.string("expectedError"),
                wire = it.string("wire"),
            )
        }

    fun wire(name: String): ByteArray = golden.single { it.name == name }.wire
        .toByteArray(StandardCharsets.UTF_8)

    fun frame(name: String): LinkedHashMap<String, Any?> = RelayV2StrictJson.parseObject(
        golden.single { it.name == name }.wire,
        FIXTURE_JSON_LIMITS,
    )

    private fun readObject(path: String): Map<String, Any?> = RelayV2StrictJson.parseObject(
        readResource(path),
        FIXTURE_JSON_LIMITS,
    )

    private fun readArray(path: String): List<Map<String, Any?>> {
        val wrapper = RelayV2StrictJson.parseObject(
            "{\"fixtures\":" + readResource(path) + "}",
            FIXTURE_JSON_LIMITS,
        )
        return wrapper.list("fixtures").map(Any?::fixtureMap)
    }

    private fun readResource(path: String): String =
        requireNotNull(javaClass.classLoader?.getResourceAsStream(path)) {
            "Missing shared Agent transcript/lifecycle fixture $path"
        }.bufferedReader(StandardCharsets.UTF_8).use { it.readText() }

    companion object {
        private val FIXTURE_JSON_LIMITS = RelayV2JsonLimits(
            maxDepth = 64,
            maxDirectKeys = 1_024,
            maxTotalKeys = 100_000,
            maxNodes = 200_000,
        )
    }
}

private fun lifecycleRecord(sequence: String): LinkedHashMap<String, Any?> = linkedMapOf(
    "recordType" to "lifecycle",
    "lifecycleEventId" to "lifecycle-$sequence",
    "sourceEpoch" to "source-$sequence",
    "scope" to "run",
    "runId" to "run-$sequence",
    "turnId" to null,
    "state" to "running",
    "failure" to null,
    "occurredAtMs" to sequence.toLong(),
    "agentEventSeq" to sequence,
)

private fun deletionEvent(sequence: String): LinkedHashMap<String, Any?> = linkedMapOf(
    "agentEventSeq" to sequence,
    "eventId" to "event-$sequence",
    "occurredAtMs" to sequence.toLong(),
    "mutation" to linkedMapOf(
        "mutationType" to "entry.deleted",
        "entryId" to "entry-$sequence",
        "reason" to "retention",
    ),
)

private fun correlatedErrorFrame(
    code: String,
    retryAfterMs: Long? = null,
    message: String = "Agent timeline request failed",
    details: Map<String, Any?>? = null,
): LinkedHashMap<String, Any?> {
    val error = linkedMapOf<String, Any?>(
        "code" to code,
        "message" to message,
        "retryable" to (retryAfterMs != null),
    )
    retryAfterMs?.let { error["retryAfterMs"] = it }
    error["commandDisposition"] = "not_applicable"
    details?.let { error["details"] = it }
    return linkedMapOf(
        "protocolVersion" to 2L,
        "kind" to "response",
        "type" to "error",
        "requestId" to "request-agent-timeline",
        "hostId" to "mac-admin",
        "hostEpoch" to "host-epoch-1",
        "scopeId" to "scope-local",
        "sessionId" to "session-1",
        "payload" to null,
        "error" to error,
    )
}

@Suppress("UNCHECKED_CAST")
private fun MutableMap<String, Any?>.payload(): MutableMap<String, Any?> =
    getValue("payload") as MutableMap<String, Any?>

@Suppress("UNCHECKED_CAST")
private fun MutableMap<String, Any?>.mutation(): MutableMap<String, Any?> =
    getValue("mutation") as MutableMap<String, Any?>

@Suppress("UNCHECKED_CAST")
private fun MutableMap<String, Any?>.entry(): MutableMap<String, Any?> =
    getValue("entry") as MutableMap<String, Any?>

@Suppress("UNCHECKED_CAST")
private fun MutableMap<String, Any?>.lifecycle(): MutableMap<String, Any?> =
    getValue("lifecycle") as MutableMap<String, Any?>

@Suppress("UNCHECKED_CAST")
private fun MutableMap<String, Any?>.failure(): MutableMap<String, Any?> =
    getValue("failure") as MutableMap<String, Any?>

@Suppress("UNCHECKED_CAST")
private fun MutableMap<String, Any?>.mapValue(name: String): MutableMap<String, Any?> =
    getValue(name) as MutableMap<String, Any?>

@Suppress("UNCHECKED_CAST")
private fun MutableMap<String, Any?>.structuredError(): MutableMap<String, Any?> =
    getValue("error") as MutableMap<String, Any?>

@Suppress("UNCHECKED_CAST")
private fun MutableMap<String, Any?>.replayEvents(): MutableList<MutableMap<String, Any?>> =
    payload().getValue("events") as MutableList<MutableMap<String, Any?>>

@Suppress("UNCHECKED_CAST")
private fun MutableMap<String, Any?>.snapshotRecords(): MutableList<MutableMap<String, Any?>> =
    payload().getValue("records") as MutableList<MutableMap<String, Any?>>

private fun MutableMap<String, Any?>.lifecycleMutation(): MutableMap<String, Any?> =
    payload().mutation().lifecycle()

private fun Any?.fixtureMap(): Map<String, Any?> {
    @Suppress("UNCHECKED_CAST")
    return this as? Map<String, Any?> ?: error("Fixture value must be an object")
}

private fun Map<String, Any?>.map(name: String): Map<String, Any?> =
    this[name].fixtureMap()

private fun Map<String, Any?>.list(name: String): List<Any?> =
    this[name] as? List<*> ?: error("Fixture field must be an array: $name")

private fun Map<String, Any?>.string(name: String): String =
    this[name] as? String ?: error("Fixture field must be a string: $name")
