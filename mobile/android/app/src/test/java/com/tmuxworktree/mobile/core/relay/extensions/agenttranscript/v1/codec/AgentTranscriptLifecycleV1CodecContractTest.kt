package com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec

import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2JsonLimits
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2StrictJson
import java.nio.charset.StandardCharsets
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
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
                    "invalid-lifecycle-scope" -> "lifecycle-binding"
                    "snapshot-page-shape" -> "page-shape"
                    "agent-command-correlation" -> "agent-command-correlation"
                    else -> error("Unmapped invalid category " + fixture.category)
                },
                error.failureClass,
            )
        }
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
        appendMirrorConflict.replayEvents()[1].mutation().entry()["createdAgentSeq"] = "9"
        assertRejected(appendMirrorConflict, "entry-event-binding")
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
private fun MutableMap<String, Any?>.replayEvents(): MutableList<MutableMap<String, Any?>> =
    payload().getValue("events") as MutableList<MutableMap<String, Any?>>

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
