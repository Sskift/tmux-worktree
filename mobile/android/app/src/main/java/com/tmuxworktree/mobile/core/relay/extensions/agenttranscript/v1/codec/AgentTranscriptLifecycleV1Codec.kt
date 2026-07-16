package com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec

import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2JsonException
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2JsonLimits
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2JsonObject
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2SchemaException
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2StrictJson
import com.tmuxworktree.mobile.core.relay.v2.codec.exactKeys
import com.tmuxworktree.mobile.core.relay.v2.codec.jsonArray
import com.tmuxworktree.mobile.core.relay.v2.codec.jsonBoolean
import com.tmuxworktree.mobile.core.relay.v2.codec.jsonCounter
import com.tmuxworktree.mobile.core.relay.v2.codec.jsonInteger
import com.tmuxworktree.mobile.core.relay.v2.codec.jsonLiteral
import com.tmuxworktree.mobile.core.relay.v2.codec.jsonNull
import com.tmuxworktree.mobile.core.relay.v2.codec.jsonObject
import com.tmuxworktree.mobile.core.relay.v2.codec.jsonOneOf
import com.tmuxworktree.mobile.core.relay.v2.codec.required
import com.tmuxworktree.mobile.core.relay.v2.codec.schemaFailure
import java.math.BigInteger
import java.nio.CharBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets

class AgentTranscriptLifecycleV1CodecException(
    val code: String,
    val failureClass: String,
) : IllegalArgumentException(
    if (code == "PROTOCOL_UNSUPPORTED") {
        "Agent transcript/lifecycle transport encoding is unsupported"
    } else {
        "Agent transcript/lifecycle public frame is invalid"
    },
)

/**
 * Strict codec for the optional public `agent.transcript-lifecycle.v1` wire only.
 *
 * This codec does not negotiate the capability and does not consume base command, terminal, or
 * host-event frames. Its DTOs carry only structure explicitly frozen by the extension contract.
 */
class AgentTranscriptLifecycleV1Codec {
    fun decodePublicFrame(
        bytes: ByteArray,
        metadata: AgentTranscriptLifecycleV1FrameMetadata =
            AgentTranscriptLifecycleV1FrameMetadata(),
    ): AgentTranscriptLifecycleV1Frame = mapCodecFailures {
        if (metadata.opcode != "text") {
            throw AgentTranscriptLifecycleV1CodecException(
                code = "INVALID_ENVELOPE",
                failureClass = "binary-frame",
            )
        }
        if (metadata.compressed) {
            throw AgentTranscriptLifecycleV1CodecException(
                code = "PROTOCOL_UNSUPPORTED",
                failureClass = "compression-not-allowed",
            )
        }
        if (bytes.size > MAX_PUBLIC_FRAME_BYTES) {
            throw AgentTranscriptLifecycleV1CodecException(
                code = "INVALID_ENVELOPE",
                failureClass = "frame-limit",
            )
        }

        val source = RelayV2StrictJson.decodeUtf8(bytes)
        val inspection = RelayV2StrictJson.inspect(source, PAGED_JSON_LIMITS)
        val limits = if (
            inspection.rootIsObject &&
            inspection.rootType in PAGED_MESSAGE_TYPES
        ) {
            PAGED_JSON_LIMITS
        } else {
            STANDARD_JSON_LIMITS
        }
        decodeFrame(RelayV2StrictJson.parseObject(source, limits))
    }

    fun encodePublicFrame(frame: AgentTranscriptLifecycleV1Frame): ByteArray = mapCodecFailures {
        val wireObject = frame.toWireObject()
        decodeFrame(wireObject)
        val bytes = RelayV2StrictJson.stringify(wireObject).toByteArray(StandardCharsets.UTF_8)
        if (bytes.size > MAX_PUBLIC_FRAME_BYTES) {
            throw AgentTranscriptLifecycleV1CodecException(
                code = "INVALID_ENVELOPE",
                failureClass = "frame-limit",
            )
        }
        // Re-enter the bounded parser so programmatic DTO encoding obeys the same key/node budget.
        decodePublicFrame(bytes)
        bytes
    }

    private fun decodeFrame(frame: RelayV2JsonObject): AgentTranscriptLifecycleV1Frame {
        val type = extensionString(required(frame, "type"), maxBytes = MAX_ID_BYTES)
        return when (type) {
            "agent.timeline.status.get" -> decodeStatusGet(frame)
            "agent.timeline.status" -> decodeStatus(frame)
            "agent.timeline.snapshot.get" -> decodeSnapshotGet(frame)
            "agent.timeline.snapshot.page" -> decodeSnapshotPage(frame)
            "agent.timeline.replay.get" -> decodeReplayGet(frame)
            "agent.timeline.replay.page" -> decodeReplayPage(frame)
            "agent.timeline.event" -> decodeTimelineEvent(frame)
            "agent.timeline.reset" -> decodeTimelineReset(frame)
            else -> schemaFailure("unknown-message-type")
        }
    }

    private fun decodeStatusGet(frame: RelayV2JsonObject): AgentTimelineStatusGetFrame {
        requestRoot(frame, "agent.timeline.status.get")
        exactKeys(jsonObject(required(frame, "payload")), emptyList())
        return AgentTimelineStatusGetFrame(
            requestId = opaqueId(frame["requestId"]),
            hostId = opaqueId(frame["hostId"]),
            expectedHostEpoch = opaqueId(frame["expectedHostEpoch"]),
            scopeId = opaqueId(frame["scopeId"]),
            sessionId = opaqueId(frame["sessionId"]),
        )
    }

    private fun decodeStatus(frame: RelayV2JsonObject): AgentTimelineStatusFrame {
        responseRoot(frame, "agent.timeline.status")
        val payload = jsonObject(required(frame, "payload"))
        exactKeys(
            payload,
            listOf(
                "capability",
                "support",
                "reason",
                "liveSource",
                "activeSourceEpoch",
                "timelineEpoch",
                "currentAgentSeq",
                "earliestReplaySeq",
                "limits",
            ),
        )
        jsonLiteral(required(payload, "capability"), CAPABILITY)
        val status = when (
            jsonOneOf(required(payload, "support"), setOf("available", "unavailable"))
        ) {
            "available" -> decodeAvailableStatus(payload)
            "unavailable" -> decodeUnavailableStatus(payload)
            else -> schemaFailure("schema-mismatch")
        }
        return AgentTimelineStatusFrame(
            requestId = opaqueId(frame["requestId"]),
            hostId = opaqueId(frame["hostId"]),
            hostEpoch = opaqueId(frame["hostEpoch"]),
            scopeId = opaqueId(frame["scopeId"]),
            sessionId = opaqueId(frame["sessionId"]),
            status = status,
        )
    }

    private fun decodeAvailableStatus(payload: RelayV2JsonObject): AgentTimelineAvailableStatus {
        jsonNull(required(payload, "reason"))
        val liveSource = when (
            jsonOneOf(required(payload, "liveSource"), setOf("connected", "interrupted"))
        ) {
            "connected" -> AgentTimelineActiveSourceState.CONNECTED
            "interrupted" -> AgentTimelineActiveSourceState.INTERRUPTED
            else -> schemaFailure("schema-mismatch")
        }
        return AgentTimelineAvailableStatus(
            liveSource = liveSource,
            activeSourceEpoch = opaqueId(required(payload, "activeSourceEpoch")),
            timelineEpoch = opaqueId(required(payload, "timelineEpoch")),
            currentAgentSeq = canonicalCounter(required(payload, "currentAgentSeq")),
            earliestReplaySeq = canonicalCounter(required(payload, "earliestReplaySeq")),
            limits = decodeLimits(required(payload, "limits")),
        )
    }

    private fun decodeUnavailableStatus(payload: RelayV2JsonObject): AgentTimelineUnavailableStatus {
        jsonLiteral(required(payload, "liveSource"), "absent")
        listOf(
            "activeSourceEpoch",
            "timelineEpoch",
            "currentAgentSeq",
            "earliestReplaySeq",
            "limits",
        ).forEach { jsonNull(required(payload, it)) }
        val reason = when (
            jsonOneOf(
                required(payload, "reason"),
                AgentTimelineUnavailableReason.entries.map { it.wireValue }.toSet(),
            )
        ) {
            "agent_unsupported" -> AgentTimelineUnavailableReason.AGENT_UNSUPPORTED
            "session_not_agent_managed" ->
                AgentTimelineUnavailableReason.SESSION_NOT_AGENT_MANAGED
            "adapter_unavailable" -> AgentTimelineUnavailableReason.ADAPTER_UNAVAILABLE
            "store_unavailable" -> AgentTimelineUnavailableReason.STORE_UNAVAILABLE
            else -> schemaFailure("schema-mismatch")
        }
        return AgentTimelineUnavailableStatus(reason)
    }

    private fun decodeLimits(value: Any?): AgentTimelineLimits {
        val limits = jsonObject(value)
        exactKeys(
            limits,
            listOf(
                "maxTextUtf8Bytes",
                "maxPageRecords",
                "eventReplayRetentionMs",
                "snapshotLeaseMs",
            ),
        )
        return AgentTimelineLimits(
            maxTextUtf8Bytes = strictInteger(
                required(limits, "maxTextUtf8Bytes"),
                minimum = 1,
                maximum = MAX_TEXT_UTF8_BYTES.toLong(),
            ),
            maxPageRecords = strictInteger(
                required(limits, "maxPageRecords"),
                minimum = 1,
                maximum = MAX_PAGE_RECORDS.toLong(),
            ),
            eventReplayRetentionMs = strictInteger(
                required(limits, "eventReplayRetentionMs"),
                minimum = MIN_EVENT_REPLAY_RETENTION_MS,
            ),
            snapshotLeaseMs = strictInteger(
                required(limits, "snapshotLeaseMs"),
                minimum = 1,
            ),
        )
    }

    private fun decodeSnapshotGet(frame: RelayV2JsonObject): AgentTimelineSnapshotGetFrame {
        requestRoot(frame, "agent.timeline.snapshot.get")
        val payload = jsonObject(required(frame, "payload"))
        exactKeys(
            payload,
            listOf("snapshotRequestId", "snapshotId", "cursor", "nextPageIndex"),
        )
        val snapshotId = nullableOpaqueId(required(payload, "snapshotId"))
        val cursor = nullableCursor(required(payload, "cursor"))
        val nextPageIndex = strictInteger(required(payload, "nextPageIndex"))
        val initial = snapshotId == null && cursor == null && nextPageIndex == 0L
        val continuation = snapshotId != null && cursor != null && nextPageIndex > 0L
        if (!initial && !continuation) schemaFailure("page-shape")
        return AgentTimelineSnapshotGetFrame(
            requestId = opaqueId(frame["requestId"]),
            hostId = opaqueId(frame["hostId"]),
            expectedHostEpoch = opaqueId(frame["expectedHostEpoch"]),
            scopeId = opaqueId(frame["scopeId"]),
            sessionId = opaqueId(frame["sessionId"]),
            request = AgentTimelineSnapshotRequest(
                snapshotRequestId = opaqueId(required(payload, "snapshotRequestId")),
                snapshotId = snapshotId,
                cursor = cursor,
                nextPageIndex = nextPageIndex,
            ),
        )
    }

    private fun decodeSnapshotPage(frame: RelayV2JsonObject): AgentTimelineSnapshotPageFrame {
        responseRoot(frame, "agent.timeline.snapshot.page")
        val payload = jsonObject(required(frame, "payload"))
        exactKeys(
            payload,
            listOf(
                "capability",
                "timelineEpoch",
                "snapshotRequestId",
                "snapshotId",
                "pageIndex",
                "isLast",
                "nextCursor",
                "throughAgentSeq",
                "earliestRetainedSeq",
                "records",
            ),
        )
        jsonLiteral(required(payload, "capability"), CAPABILITY)
        val isLast = jsonBoolean(required(payload, "isLast"))
        val nextCursor = nullableCursor(required(payload, "nextCursor"))
        validatePageCursor(isLast, nextCursor)
        val records = jsonArray(required(payload, "records"), maximum = MAX_PAGE_RECORDS) {}
            .map(::decodeSnapshotRecord)
        return AgentTimelineSnapshotPageFrame(
            requestId = opaqueId(frame["requestId"]),
            hostId = opaqueId(frame["hostId"]),
            hostEpoch = opaqueId(frame["hostEpoch"]),
            scopeId = opaqueId(frame["scopeId"]),
            sessionId = opaqueId(frame["sessionId"]),
            page = AgentTimelineSnapshotPage(
                timelineEpoch = opaqueId(required(payload, "timelineEpoch")),
                snapshotRequestId = opaqueId(required(payload, "snapshotRequestId")),
                snapshotId = opaqueId(required(payload, "snapshotId")),
                pageIndex = strictInteger(required(payload, "pageIndex")),
                isLast = isLast,
                nextCursor = nextCursor,
                throughAgentSeq = canonicalCounter(required(payload, "throughAgentSeq")),
                earliestRetainedSeq = canonicalCounter(
                    required(payload, "earliestRetainedSeq"),
                ),
                records = records,
            ),
        )
    }

    private fun decodeReplayGet(frame: RelayV2JsonObject): AgentTimelineReplayGetFrame {
        requestRoot(frame, "agent.timeline.replay.get")
        val payload = jsonObject(required(frame, "payload"))
        exactKeys(payload, listOf("timelineEpoch", "afterAgentSeq", "cursor", "limit"))
        return AgentTimelineReplayGetFrame(
            requestId = opaqueId(frame["requestId"]),
            hostId = opaqueId(frame["hostId"]),
            expectedHostEpoch = opaqueId(frame["expectedHostEpoch"]),
            scopeId = opaqueId(frame["scopeId"]),
            sessionId = opaqueId(frame["sessionId"]),
            request = AgentTimelineReplayRequest(
                timelineEpoch = opaqueId(required(payload, "timelineEpoch")),
                afterAgentSeq = canonicalCounter(required(payload, "afterAgentSeq")),
                cursor = nullableCursor(required(payload, "cursor")),
                limit = strictInteger(
                    required(payload, "limit"),
                    minimum = 1,
                    maximum = MAX_PAGE_RECORDS.toLong(),
                ),
            ),
        )
    }

    private fun decodeReplayPage(frame: RelayV2JsonObject): AgentTimelineReplayPageFrame {
        responseRoot(frame, "agent.timeline.replay.page")
        val payload = jsonObject(required(frame, "payload"))
        exactKeys(
            payload,
            listOf(
                "capability",
                "timelineEpoch",
                "afterAgentSeq",
                "replayThroughAgentSeq",
                "isLast",
                "nextCursor",
                "events",
            ),
        )
        jsonLiteral(required(payload, "capability"), CAPABILITY)
        val isLast = jsonBoolean(required(payload, "isLast"))
        val nextCursor = nullableCursor(required(payload, "nextCursor"))
        validatePageCursor(isLast, nextCursor)
        val events = jsonArray(required(payload, "events"), maximum = MAX_PAGE_RECORDS) {}
            .map(::decodeEventRecord)
        return AgentTimelineReplayPageFrame(
            requestId = opaqueId(frame["requestId"]),
            hostId = opaqueId(frame["hostId"]),
            hostEpoch = opaqueId(frame["hostEpoch"]),
            scopeId = opaqueId(frame["scopeId"]),
            sessionId = opaqueId(frame["sessionId"]),
            page = AgentTimelineReplayPage(
                timelineEpoch = opaqueId(required(payload, "timelineEpoch")),
                afterAgentSeq = canonicalCounter(required(payload, "afterAgentSeq")),
                replayThroughAgentSeq = canonicalCounter(
                    required(payload, "replayThroughAgentSeq"),
                ),
                isLast = isLast,
                nextCursor = nextCursor,
                events = events,
            ),
        )
    }

    private fun decodeTimelineEvent(frame: RelayV2JsonObject): AgentTimelineEventFrame {
        eventRoot(frame, "agent.timeline.event")
        val payload = jsonObject(required(frame, "payload"))
        exactKeys(
            payload,
            listOf(
                "capability",
                "timelineEpoch",
                "agentEventSeq",
                "eventId",
                "occurredAtMs",
                "mutation",
            ),
        )
        jsonLiteral(required(payload, "capability"), CAPABILITY)
        return AgentTimelineEventFrame(
            hostId = opaqueId(frame["hostId"]),
            hostEpoch = opaqueId(frame["hostEpoch"]),
            scopeId = opaqueId(frame["scopeId"]),
            sessionId = opaqueId(frame["sessionId"]),
            timelineEpoch = opaqueId(required(payload, "timelineEpoch")),
            event = decodeEventRecordFields(payload),
        )
    }

    private fun decodeTimelineReset(frame: RelayV2JsonObject): AgentTimelineResetFrame {
        eventRoot(frame, "agent.timeline.reset")
        val payload = jsonObject(required(frame, "payload"))
        exactKeys(
            payload,
            listOf("capability", "previousTimelineEpoch", "newTimelineEpoch", "reason"),
        )
        jsonLiteral(required(payload, "capability"), CAPABILITY)
        val reason = when (
            jsonOneOf(required(payload, "reason"), setOf("deleted", "store_reset"))
        ) {
            "deleted" -> AgentTimelineResetReason.DELETED
            "store_reset" -> AgentTimelineResetReason.STORE_RESET
            else -> schemaFailure("schema-mismatch")
        }
        val newTimelineEpoch = nullableOpaqueId(required(payload, "newTimelineEpoch"))
        if (
            (reason == AgentTimelineResetReason.DELETED && newTimelineEpoch == null) ||
            (reason == AgentTimelineResetReason.STORE_RESET && newTimelineEpoch != null)
        ) {
            schemaFailure("reset-shape")
        }
        return AgentTimelineResetFrame(
            hostId = opaqueId(frame["hostId"]),
            hostEpoch = opaqueId(frame["hostEpoch"]),
            scopeId = opaqueId(frame["scopeId"]),
            sessionId = opaqueId(frame["sessionId"]),
            previousTimelineEpoch = opaqueId(required(payload, "previousTimelineEpoch")),
            newTimelineEpoch = newTimelineEpoch,
            reason = reason,
        )
    }

    private fun decodeSnapshotRecord(value: Any?): AgentTimelineSnapshotRecord {
        val record = jsonObject(value)
        return when (
            jsonOneOf(required(record, "recordType"), setOf("text_entry", "lifecycle"))
        ) {
            "text_entry" -> decodeTextEntry(record)
            "lifecycle" -> decodeLifecycle(record)
            else -> schemaFailure("schema-mismatch")
        }
    }

    private fun decodeTextEntry(record: RelayV2JsonObject): AgentTimelineTextEntryRecord {
        exactKeys(
            record,
            listOf(
                "recordType",
                "entryId",
                "runId",
                "turnId",
                "role",
                "state",
                "text",
                "redactionReason",
                "commandId",
                "createdAtMs",
                "createdAgentSeq",
                "lastModifiedAgentSeq",
            ),
        )
        jsonLiteral(required(record, "recordType"), "text_entry")
        val role = when (jsonOneOf(required(record, "role"), setOf("user", "agent"))) {
            "user" -> AgentTimelineEntryRole.USER
            "agent" -> AgentTimelineEntryRole.AGENT
            else -> schemaFailure("schema-mismatch")
        }
        val commandId = nullableOpaqueId(required(record, "commandId"))
        if (role == AgentTimelineEntryRole.AGENT && commandId != null) {
            schemaFailure("agent-command-correlation")
        }
        val createdAgentSeq = positiveCounter(required(record, "createdAgentSeq"))
        val lastModifiedAgentSeq = positiveCounter(required(record, "lastModifiedAgentSeq"))
        if (compareCounters(lastModifiedAgentSeq, createdAgentSeq) < 0) {
            schemaFailure("entry-sequence-order")
        }
        val metadata = AgentTimelineTextEntryMetadata(
            entryId = opaqueId(required(record, "entryId")),
            runId = opaqueId(required(record, "runId")),
            turnId = opaqueId(required(record, "turnId")),
            role = role,
            commandId = commandId,
            createdAtMs = strictInteger(required(record, "createdAtMs")),
            createdAgentSeq = createdAgentSeq,
            lastModifiedAgentSeq = lastModifiedAgentSeq,
        )
        return when (
            jsonOneOf(required(record, "state"), setOf("visible", "redacted"))
        ) {
            "visible" -> {
                jsonNull(required(record, "redactionReason"))
                AgentTimelineVisibleTextEntryRecord(
                    metadata = metadata,
                    text = contentText(required(record, "text"), MAX_TEXT_UTF8_BYTES),
                )
            }
            "redacted" -> {
                jsonNull(required(record, "text"))
                AgentTimelineRedactedTextEntryRecord(
                    metadata = metadata,
                    redactionReason = decodeRedactionReason(
                        required(record, "redactionReason"),
                    ),
                )
            }
            else -> schemaFailure("schema-mismatch")
        }
    }

    private fun decodeLifecycle(record: RelayV2JsonObject): AgentTimelineLifecycleRecord {
        exactKeys(
            record,
            listOf(
                "recordType",
                "lifecycleEventId",
                "sourceEpoch",
                "scope",
                "runId",
                "turnId",
                "state",
                "failure",
                "occurredAtMs",
                "agentEventSeq",
            ),
        )
        jsonLiteral(required(record, "recordType"), "lifecycle")
        val scope = when (jsonOneOf(required(record, "scope"), setOf("run", "turn"))) {
            "run" -> AgentTimelineLifecycleScope.RUN
            "turn" -> AgentTimelineLifecycleScope.TURN
            else -> schemaFailure("schema-mismatch")
        }
        val turnId = nullableOpaqueId(required(record, "turnId"))
        if (
            (scope == AgentTimelineLifecycleScope.RUN && turnId != null) ||
            (scope == AgentTimelineLifecycleScope.TURN && turnId == null)
        ) {
            schemaFailure("lifecycle-binding")
        }
        val state = when (
            jsonOneOf(
                required(record, "state"),
                AgentTimelineLifecycleState.entries.map { it.wireValue }.toSet(),
            )
        ) {
            "running" -> AgentTimelineLifecycleState.RUNNING
            "waiting_for_user" -> AgentTimelineLifecycleState.WAITING_FOR_USER
            "failed" -> AgentTimelineLifecycleState.FAILED
            "completed" -> AgentTimelineLifecycleState.COMPLETED
            else -> schemaFailure("schema-mismatch")
        }
        val failure = if (state == AgentTimelineLifecycleState.FAILED) {
            decodeFailure(required(record, "failure"))
        } else {
            jsonNull(required(record, "failure"))
            null
        }
        return AgentTimelineLifecycleRecord(
            lifecycleEventId = opaqueId(required(record, "lifecycleEventId")),
            sourceEpoch = opaqueId(required(record, "sourceEpoch")),
            scope = scope,
            runId = opaqueId(required(record, "runId")),
            turnId = turnId,
            state = state,
            failure = failure,
            occurredAtMs = strictInteger(required(record, "occurredAtMs")),
            agentEventSeq = positiveCounter(required(record, "agentEventSeq")),
        )
    }

    private fun decodeFailure(value: Any?): AgentTimelineFailure {
        val failure = jsonObject(value)
        exactKeys(failure, listOf("code", "summary"))
        return AgentTimelineFailure(
            code = opaqueId(required(failure, "code")),
            summary = if (required(failure, "summary") == null) {
                null
            } else {
                contentText(failure["summary"], MAX_FAILURE_SUMMARY_UTF8_BYTES)
            },
        )
    }

    private fun decodeEventRecord(value: Any?): AgentTimelineEventRecord {
        val event = jsonObject(value)
        exactKeys(event, listOf("agentEventSeq", "eventId", "occurredAtMs", "mutation"))
        return decodeEventRecordFields(event)
    }

    private fun decodeEventRecordFields(event: RelayV2JsonObject): AgentTimelineEventRecord {
        val decoded = AgentTimelineEventRecord(
            agentEventSeq = positiveCounter(required(event, "agentEventSeq")),
            eventId = opaqueId(required(event, "eventId")),
            occurredAtMs = strictInteger(required(event, "occurredAtMs")),
            mutation = decodeMutation(required(event, "mutation")),
        )
        validateEventBinding(decoded)
        return decoded
    }

    private fun decodeMutation(value: Any?): AgentTimelineMutation {
        val mutation = jsonObject(value)
        return when (
            jsonOneOf(
                required(mutation, "mutationType"),
                setOf(
                    "text_entry.appended",
                    "entry.redacted",
                    "entry.deleted",
                    "lifecycle.changed",
                    "source.availability",
                ),
            )
        ) {
            "text_entry.appended" -> {
                exactKeys(mutation, listOf("mutationType", "entry"))
                val entry = decodeTextEntry(jsonObject(required(mutation, "entry")))
                if (entry !is AgentTimelineVisibleTextEntryRecord) {
                    schemaFailure("schema-mismatch")
                }
                AgentTimelineTextEntryAppendedMutation(entry)
            }
            "entry.redacted" -> {
                exactKeys(mutation, listOf("mutationType", "entryId", "reason"))
                AgentTimelineEntryRedactedMutation(
                    entryId = opaqueId(required(mutation, "entryId")),
                    reason = decodeRedactionReason(required(mutation, "reason")),
                )
            }
            "entry.deleted" -> {
                exactKeys(mutation, listOf("mutationType", "entryId", "reason"))
                AgentTimelineEntryDeletedMutation(
                    entryId = opaqueId(required(mutation, "entryId")),
                    reason = decodeRedactionReason(required(mutation, "reason")),
                )
            }
            "lifecycle.changed" -> {
                exactKeys(mutation, listOf("mutationType", "lifecycle"))
                AgentTimelineLifecycleChangedMutation(
                    decodeLifecycle(jsonObject(required(mutation, "lifecycle"))),
                )
            }
            "source.availability" -> {
                exactKeys(mutation, listOf("mutationType", "state", "sourceEpoch", "reason"))
                val state = when (
                    jsonOneOf(required(mutation, "state"), setOf("connected", "interrupted"))
                ) {
                    "connected" -> AgentTimelineSourceAvailabilityState.CONNECTED
                    "interrupted" -> AgentTimelineSourceAvailabilityState.INTERRUPTED
                    else -> schemaFailure("schema-mismatch")
                }
                val reason = if (required(mutation, "reason") == null) {
                    null
                } else {
                    when (
                        jsonOneOf(
                            mutation["reason"],
                            setOf("source_disconnected", "source_restarted"),
                        )
                    ) {
                        "source_disconnected" ->
                            AgentTimelineSourceAvailabilityReason.SOURCE_DISCONNECTED
                        "source_restarted" ->
                            AgentTimelineSourceAvailabilityReason.SOURCE_RESTARTED
                        else -> schemaFailure("schema-mismatch")
                    }
                }
                if (
                    (state == AgentTimelineSourceAvailabilityState.CONNECTED &&
                        reason == AgentTimelineSourceAvailabilityReason.SOURCE_DISCONNECTED) ||
                    (state == AgentTimelineSourceAvailabilityState.INTERRUPTED &&
                        reason == AgentTimelineSourceAvailabilityReason.SOURCE_RESTARTED)
                ) {
                    schemaFailure("source-availability-binding")
                }
                AgentTimelineSourceAvailabilityMutation(
                    state = state,
                    sourceEpoch = opaqueId(required(mutation, "sourceEpoch")),
                    reason = reason,
                )
            }
            else -> schemaFailure("schema-mismatch")
        }
    }

    private fun validateEventBinding(event: AgentTimelineEventRecord) {
        when (val mutation = event.mutation) {
            is AgentTimelineTextEntryAppendedMutation -> {
                val metadata = mutation.entry.metadata
                if (
                    metadata.createdAgentSeq != event.agentEventSeq ||
                    metadata.lastModifiedAgentSeq != event.agentEventSeq
                ) {
                    schemaFailure("entry-event-binding")
                }
            }
            is AgentTimelineLifecycleChangedMutation -> {
                val lifecycle = mutation.lifecycle
                if (
                    lifecycle.lifecycleEventId != event.eventId ||
                    lifecycle.agentEventSeq != event.agentEventSeq ||
                    lifecycle.occurredAtMs != event.occurredAtMs
                ) {
                    schemaFailure("lifecycle-event-binding")
                }
            }
            is AgentTimelineEntryRedactedMutation,
            is AgentTimelineEntryDeletedMutation,
            is AgentTimelineSourceAvailabilityMutation,
            -> Unit
        }
    }

    private fun decodeRedactionReason(value: Any?): AgentTimelineRedactionReason =
        when (jsonOneOf(value, setOf("user_request", "policy", "retention"))) {
            "user_request" -> AgentTimelineRedactionReason.USER_REQUEST
            "policy" -> AgentTimelineRedactionReason.POLICY
            "retention" -> AgentTimelineRedactionReason.RETENTION
            else -> schemaFailure("schema-mismatch")
        }

    private fun requestRoot(frame: RelayV2JsonObject, type: String) {
        exactKeys(
            frame,
            listOf(
                "protocolVersion",
                "kind",
                "type",
                "requestId",
                "hostId",
                "expectedHostEpoch",
                "scopeId",
                "sessionId",
                "payload",
            ),
        )
        fixedRoot(frame, AgentTranscriptLifecycleV1FrameKind.REQUEST, type)
        listOf("requestId", "hostId", "expectedHostEpoch", "scopeId", "sessionId")
            .forEach { opaqueId(required(frame, it)) }
    }

    private fun responseRoot(frame: RelayV2JsonObject, type: String) {
        exactKeys(
            frame,
            listOf(
                "protocolVersion",
                "kind",
                "type",
                "requestId",
                "hostId",
                "hostEpoch",
                "scopeId",
                "sessionId",
                "payload",
            ),
        )
        fixedRoot(frame, AgentTranscriptLifecycleV1FrameKind.RESPONSE, type)
        listOf("requestId", "hostId", "hostEpoch", "scopeId", "sessionId")
            .forEach { opaqueId(required(frame, it)) }
    }

    private fun eventRoot(frame: RelayV2JsonObject, type: String) {
        exactKeys(
            frame,
            listOf(
                "protocolVersion",
                "kind",
                "type",
                "hostId",
                "hostEpoch",
                "scopeId",
                "sessionId",
                "payload",
            ),
        )
        fixedRoot(frame, AgentTranscriptLifecycleV1FrameKind.EVENT, type)
        listOf("hostId", "hostEpoch", "scopeId", "sessionId")
            .forEach { opaqueId(required(frame, it)) }
    }

    private fun fixedRoot(
        frame: RelayV2JsonObject,
        kind: AgentTranscriptLifecycleV1FrameKind,
        type: String,
    ) {
        strictInteger(required(frame, "protocolVersion"), minimum = 2, maximum = 2)
        jsonLiteral(required(frame, "kind"), kind.wireValue)
        jsonLiteral(required(frame, "type"), type)
    }

    private fun validatePageCursor(isLast: Boolean, nextCursor: String?) {
        if (isLast == (nextCursor != null)) schemaFailure("page-shape")
    }

    private fun canonicalCounter(value: Any?): String = jsonCounter(value)

    private fun strictInteger(
        value: Any?,
        minimum: Long = 0,
        maximum: Long = 9_007_199_254_740_991L,
    ): Long {
        if (value !is Byte && value !is Short && value !is Int && value !is Long) {
            if (value == null) schemaFailure("forbidden-null")
            schemaFailure("type-coercion")
        }
        return jsonInteger(value, minimum, maximum)
    }

    private fun positiveCounter(value: Any?): String = canonicalCounter(value).also {
        if (it == "0") schemaFailure("invalid-argument")
    }

    private fun compareCounters(left: String, right: String): Int =
        BigInteger(left).compareTo(BigInteger(right))

    private fun nullableOpaqueId(value: Any?): String? = value?.let(::opaqueId)

    private fun nullableCursor(value: Any?): String? = value?.let(::opaqueCursor)

    private fun opaqueId(value: Any?): String = extensionString(
        value = value,
        allowEmpty = false,
        allowOuterWhitespace = false,
        maxBytes = MAX_ID_BYTES,
        failureClass = "id-byte-limit",
    )

    private fun opaqueCursor(value: Any?): String = extensionString(
        value = value,
        allowEmpty = false,
        allowOuterWhitespace = false,
        maxBytes = MAX_CURSOR_BYTES,
        failureClass = "id-byte-limit",
    )

    private fun contentText(value: Any?, maxBytes: Int): String = extensionString(
        value = value,
        allowEmpty = true,
        allowOuterWhitespace = true,
        maxBytes = maxBytes,
        failureClass = if (maxBytes == MAX_TEXT_UTF8_BYTES) {
            "text-byte-limit"
        } else {
            "summary-byte-limit"
        },
    )

    private fun extensionString(
        value: Any?,
        allowEmpty: Boolean = false,
        allowOuterWhitespace: Boolean = false,
        maxBytes: Int,
        failureClass: String = "id-byte-limit",
    ): String {
        if (value == null) schemaFailure("forbidden-null")
        if (value !is String) schemaFailure("type-coercion")
        if (!allowEmpty && value.isEmpty()) schemaFailure("invalid-argument")
        if ('\u0000' in value) schemaFailure("invalid-argument")
        if (!allowOuterWhitespace && value.trim() != value) {
            schemaFailure("invalid-argument")
        }
        if (value.length > maxBytes) schemaFailure(failureClass)
        val encodedBytes = try {
            StandardCharsets.UTF_8.newEncoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .encode(CharBuffer.wrap(value))
                .remaining()
        } catch (_: CharacterCodingException) {
            schemaFailure("invalid-unicode")
        }
        if (encodedBytes > maxBytes) schemaFailure(failureClass)
        return value
    }

    private inline fun <T> mapCodecFailures(block: () -> T): T = try {
        block()
    } catch (error: AgentTranscriptLifecycleV1CodecException) {
        throw error
    } catch (error: RelayV2JsonException) {
        throw AgentTranscriptLifecycleV1CodecException(
            code = "INVALID_ENVELOPE",
            failureClass = error.failureClass,
        )
    } catch (error: RelayV2SchemaException) {
        throw AgentTranscriptLifecycleV1CodecException(
            code = "INVALID_ENVELOPE",
            failureClass = error.failureClass,
        )
    }

    companion object {
        const val MAX_PUBLIC_FRAME_BYTES = 1_048_576
        const val MAX_TEXT_UTF8_BYTES = 65_536
        const val MAX_FAILURE_SUMMARY_UTF8_BYTES = 1_024
        const val MAX_PAGE_RECORDS = 256

        private const val CAPABILITY = "agent.transcript-lifecycle.v1"
        private const val MAX_ID_BYTES = 128
        private const val MAX_CURSOR_BYTES = 1_024
        private const val MIN_EVENT_REPLAY_RETENTION_MS = 86_400_000L

        private val PAGED_MESSAGE_TYPES = setOf(
            "agent.timeline.snapshot.page",
            "agent.timeline.replay.page",
        )
        private val STANDARD_JSON_LIMITS = RelayV2JsonLimits(
            maxDepth = 16,
            maxDirectKeys = 256,
            maxTotalKeys = 1_024,
            maxNodes = 4_096,
        )
        private val PAGED_JSON_LIMITS = RelayV2JsonLimits(
            maxDepth = 16,
            maxDirectKeys = 256,
            maxTotalKeys = 8_192,
            maxNodes = 16_384,
        )
    }
}

private fun AgentTranscriptLifecycleV1Frame.toWireObject(): LinkedHashMap<String, Any?> =
    when (this) {
        is AgentTimelineStatusGetFrame -> requestWire(
            type = type,
            requestId = requestId,
            hostId = hostId,
            expectedHostEpoch = expectedHostEpoch,
            scopeId = scopeId,
            sessionId = sessionId,
            payload = wireObject(),
        )
        is AgentTimelineStatusFrame -> responseWire(
            type = type,
            requestId = requestId,
            hostId = hostId,
            hostEpoch = hostEpoch,
            scopeId = scopeId,
            sessionId = sessionId,
            payload = status.toWireObject(),
        )
        is AgentTimelineSnapshotGetFrame -> requestWire(
            type = type,
            requestId = requestId,
            hostId = hostId,
            expectedHostEpoch = expectedHostEpoch,
            scopeId = scopeId,
            sessionId = sessionId,
            payload = request.toWireObject(),
        )
        is AgentTimelineSnapshotPageFrame -> responseWire(
            type = type,
            requestId = requestId,
            hostId = hostId,
            hostEpoch = hostEpoch,
            scopeId = scopeId,
            sessionId = sessionId,
            payload = page.toWireObject(),
        )
        is AgentTimelineReplayGetFrame -> requestWire(
            type = type,
            requestId = requestId,
            hostId = hostId,
            expectedHostEpoch = expectedHostEpoch,
            scopeId = scopeId,
            sessionId = sessionId,
            payload = request.toWireObject(),
        )
        is AgentTimelineReplayPageFrame -> responseWire(
            type = type,
            requestId = requestId,
            hostId = hostId,
            hostEpoch = hostEpoch,
            scopeId = scopeId,
            sessionId = sessionId,
            payload = page.toWireObject(),
        )
        is AgentTimelineEventFrame -> eventWire(
            type = type,
            hostId = hostId,
            hostEpoch = hostEpoch,
            scopeId = scopeId,
            sessionId = sessionId,
            payload = wireObject(
                "capability" to "agent.transcript-lifecycle.v1",
                "timelineEpoch" to timelineEpoch,
                "agentEventSeq" to event.agentEventSeq,
                "eventId" to event.eventId,
                "occurredAtMs" to event.occurredAtMs,
                "mutation" to event.mutation.toWireObject(),
            ),
        )
        is AgentTimelineResetFrame -> eventWire(
            type = type,
            hostId = hostId,
            hostEpoch = hostEpoch,
            scopeId = scopeId,
            sessionId = sessionId,
            payload = wireObject(
                "capability" to "agent.transcript-lifecycle.v1",
                "previousTimelineEpoch" to previousTimelineEpoch,
                "newTimelineEpoch" to newTimelineEpoch,
                "reason" to reason.wireValue,
            ),
        )
    }

private fun AgentTimelineStatus.toWireObject(): LinkedHashMap<String, Any?> = when (this) {
    is AgentTimelineAvailableStatus -> wireObject(
        "capability" to "agent.transcript-lifecycle.v1",
        "support" to "available",
        "reason" to null,
        "liveSource" to liveSource.wireValue,
        "activeSourceEpoch" to activeSourceEpoch,
        "timelineEpoch" to timelineEpoch,
        "currentAgentSeq" to currentAgentSeq,
        "earliestReplaySeq" to earliestReplaySeq,
        "limits" to limits.toWireObject(),
    )
    is AgentTimelineUnavailableStatus -> wireObject(
        "capability" to "agent.transcript-lifecycle.v1",
        "support" to "unavailable",
        "reason" to reason.wireValue,
        "liveSource" to "absent",
        "activeSourceEpoch" to null,
        "timelineEpoch" to null,
        "currentAgentSeq" to null,
        "earliestReplaySeq" to null,
        "limits" to null,
    )
}

private fun AgentTimelineLimits.toWireObject(): LinkedHashMap<String, Any?> = wireObject(
    "maxTextUtf8Bytes" to maxTextUtf8Bytes,
    "maxPageRecords" to maxPageRecords,
    "eventReplayRetentionMs" to eventReplayRetentionMs,
    "snapshotLeaseMs" to snapshotLeaseMs,
)

private fun AgentTimelineSnapshotRequest.toWireObject(): LinkedHashMap<String, Any?> = wireObject(
    "snapshotRequestId" to snapshotRequestId,
    "snapshotId" to snapshotId,
    "cursor" to cursor,
    "nextPageIndex" to nextPageIndex,
)

private fun AgentTimelineSnapshotPage.toWireObject(): LinkedHashMap<String, Any?> = wireObject(
    "capability" to "agent.transcript-lifecycle.v1",
    "timelineEpoch" to timelineEpoch,
    "snapshotRequestId" to snapshotRequestId,
    "snapshotId" to snapshotId,
    "pageIndex" to pageIndex,
    "isLast" to isLast,
    "nextCursor" to nextCursor,
    "throughAgentSeq" to throughAgentSeq,
    "earliestRetainedSeq" to earliestRetainedSeq,
    "records" to records.map(AgentTimelineSnapshotRecord::toWireObject),
)

private fun AgentTimelineReplayRequest.toWireObject(): LinkedHashMap<String, Any?> = wireObject(
    "timelineEpoch" to timelineEpoch,
    "afterAgentSeq" to afterAgentSeq,
    "cursor" to cursor,
    "limit" to limit,
)

private fun AgentTimelineReplayPage.toWireObject(): LinkedHashMap<String, Any?> = wireObject(
    "capability" to "agent.transcript-lifecycle.v1",
    "timelineEpoch" to timelineEpoch,
    "afterAgentSeq" to afterAgentSeq,
    "replayThroughAgentSeq" to replayThroughAgentSeq,
    "isLast" to isLast,
    "nextCursor" to nextCursor,
    "events" to events.map(AgentTimelineEventRecord::toWireObject),
)

private fun AgentTimelineEventRecord.toWireObject(): LinkedHashMap<String, Any?> = wireObject(
    "agentEventSeq" to agentEventSeq,
    "eventId" to eventId,
    "occurredAtMs" to occurredAtMs,
    "mutation" to mutation.toWireObject(),
)

private fun AgentTimelineSnapshotRecord.toWireObject(): LinkedHashMap<String, Any?> = when (this) {
    is AgentTimelineVisibleTextEntryRecord -> textEntryWire(
        metadata = metadata,
        state = "visible",
        text = text,
        redactionReason = null,
    )
    is AgentTimelineRedactedTextEntryRecord -> textEntryWire(
        metadata = metadata,
        state = "redacted",
        text = null,
        redactionReason = redactionReason.wireValue,
    )
    is AgentTimelineLifecycleRecord -> wireObject(
        "recordType" to "lifecycle",
        "lifecycleEventId" to lifecycleEventId,
        "sourceEpoch" to sourceEpoch,
        "scope" to scope.wireValue,
        "runId" to runId,
        "turnId" to turnId,
        "state" to state.wireValue,
        "failure" to failure?.toWireObject(),
        "occurredAtMs" to occurredAtMs,
        "agentEventSeq" to agentEventSeq,
    )
}

private fun AgentTimelineFailure.toWireObject(): LinkedHashMap<String, Any?> = wireObject(
    "code" to code,
    "summary" to summary,
)

private fun AgentTimelineMutation.toWireObject(): LinkedHashMap<String, Any?> = when (this) {
    is AgentTimelineTextEntryAppendedMutation -> wireObject(
        "mutationType" to "text_entry.appended",
        "entry" to entry.toWireObject(),
    )
    is AgentTimelineEntryRedactedMutation -> wireObject(
        "mutationType" to "entry.redacted",
        "entryId" to entryId,
        "reason" to reason.wireValue,
    )
    is AgentTimelineEntryDeletedMutation -> wireObject(
        "mutationType" to "entry.deleted",
        "entryId" to entryId,
        "reason" to reason.wireValue,
    )
    is AgentTimelineLifecycleChangedMutation -> wireObject(
        "mutationType" to "lifecycle.changed",
        "lifecycle" to lifecycle.toWireObject(),
    )
    is AgentTimelineSourceAvailabilityMutation -> wireObject(
        "mutationType" to "source.availability",
        "state" to state.wireValue,
        "sourceEpoch" to sourceEpoch,
        "reason" to reason?.wireValue,
    )
}

private fun AgentTimelineVisibleTextEntryRecord.toWireObject(): LinkedHashMap<String, Any?> =
    textEntryWire(
        metadata = metadata,
        state = "visible",
        text = text,
        redactionReason = null,
    )

private fun AgentTimelineLifecycleRecord.toWireObject(): LinkedHashMap<String, Any?> =
    (this as AgentTimelineSnapshotRecord).toWireObject()

private fun textEntryWire(
    metadata: AgentTimelineTextEntryMetadata,
    state: String,
    text: String?,
    redactionReason: String?,
): LinkedHashMap<String, Any?> = wireObject(
    "recordType" to "text_entry",
    "entryId" to metadata.entryId,
    "runId" to metadata.runId,
    "turnId" to metadata.turnId,
    "role" to metadata.role.wireValue,
    "state" to state,
    "text" to text,
    "redactionReason" to redactionReason,
    "commandId" to metadata.commandId,
    "createdAtMs" to metadata.createdAtMs,
    "createdAgentSeq" to metadata.createdAgentSeq,
    "lastModifiedAgentSeq" to metadata.lastModifiedAgentSeq,
)

private fun requestWire(
    type: String,
    requestId: String,
    hostId: String,
    expectedHostEpoch: String,
    scopeId: String,
    sessionId: String,
    payload: Map<String, Any?>,
): LinkedHashMap<String, Any?> = wireObject(
    "protocolVersion" to 2L,
    "kind" to "request",
    "type" to type,
    "requestId" to requestId,
    "hostId" to hostId,
    "expectedHostEpoch" to expectedHostEpoch,
    "scopeId" to scopeId,
    "sessionId" to sessionId,
    "payload" to payload,
)

private fun responseWire(
    type: String,
    requestId: String,
    hostId: String,
    hostEpoch: String,
    scopeId: String,
    sessionId: String,
    payload: Map<String, Any?>,
): LinkedHashMap<String, Any?> = wireObject(
    "protocolVersion" to 2L,
    "kind" to "response",
    "type" to type,
    "requestId" to requestId,
    "hostId" to hostId,
    "hostEpoch" to hostEpoch,
    "scopeId" to scopeId,
    "sessionId" to sessionId,
    "payload" to payload,
)

private fun eventWire(
    type: String,
    hostId: String,
    hostEpoch: String,
    scopeId: String,
    sessionId: String,
    payload: Map<String, Any?>,
): LinkedHashMap<String, Any?> = wireObject(
    "protocolVersion" to 2L,
    "kind" to "event",
    "type" to type,
    "hostId" to hostId,
    "hostEpoch" to hostEpoch,
    "scopeId" to scopeId,
    "sessionId" to sessionId,
    "payload" to payload,
)

private fun wireObject(vararg fields: Pair<String, Any?>): LinkedHashMap<String, Any?> =
    linkedMapOf(*fields)
