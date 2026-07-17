package com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec

/** Transport metadata required by the strict public-frame boundary. */
data class AgentTranscriptLifecycleV1FrameMetadata(
    val opcode: String = "text",
    val compressed: Boolean = false,
)

enum class AgentTranscriptLifecycleV1FrameKind(val wireValue: String) {
    REQUEST("request"),
    RESPONSE("response"),
    EVENT("event"),
}

/** Closed public-wire union for the optional Agent transcript/lifecycle extension. */
sealed interface AgentTranscriptLifecycleV1Frame {
    val kind: AgentTranscriptLifecycleV1FrameKind
    val type: String
}

/** Strictly decoded server-to-client frame bound to one host session identity. */
sealed interface AgentTranscriptLifecycleV1InboundFrame : AgentTranscriptLifecycleV1Frame {
    val hostId: String
    val hostEpoch: String
    val scopeId: String
    val sessionId: String
}

enum class AgentTimelineErrorCode(val wireValue: String) {
    AGENT_TIMELINE_UNAVAILABLE("AGENT_TIMELINE_UNAVAILABLE"),
    AGENT_CURSOR_EXPIRED("AGENT_CURSOR_EXPIRED"),
    AGENT_CURSOR_AHEAD("AGENT_CURSOR_AHEAD"),
    AGENT_SNAPSHOT_EXPIRED("AGENT_SNAPSHOT_EXPIRED"),
    AGENT_TIMELINE_EPOCH_MISMATCH("AGENT_TIMELINE_EPOCH_MISMATCH"),
}

enum class AgentTimelineErrorCommandDisposition(val wireValue: String) {
    NOT_APPLICABLE("not_applicable"),
}

data class AgentTimelineStructuredError(
    val code: AgentTimelineErrorCode,
    val message: String,
    val retryable: Boolean,
    val retryAfterMs: Long? = null,
    val commandDisposition: AgentTimelineErrorCommandDisposition =
        AgentTimelineErrorCommandDisposition.NOT_APPLICABLE,
)

/** Correlated base-v2 error envelope carrying only extension-owned error codes. */
data class AgentTimelineErrorFrame(
    val requestId: String,
    override val hostId: String,
    override val hostEpoch: String,
    override val scopeId: String,
    override val sessionId: String,
    val error: AgentTimelineStructuredError,
) : AgentTranscriptLifecycleV1InboundFrame {
    override val kind: AgentTranscriptLifecycleV1FrameKind =
        AgentTranscriptLifecycleV1FrameKind.RESPONSE
    override val type: String = "error"
}

data class AgentTimelineStatusGetFrame(
    val requestId: String,
    val hostId: String,
    val expectedHostEpoch: String,
    val scopeId: String,
    val sessionId: String,
) : AgentTranscriptLifecycleV1Frame {
    override val kind: AgentTranscriptLifecycleV1FrameKind =
        AgentTranscriptLifecycleV1FrameKind.REQUEST
    override val type: String = "agent.timeline.status.get"
}

data class AgentTimelineStatusFrame(
    val requestId: String,
    override val hostId: String,
    override val hostEpoch: String,
    override val scopeId: String,
    override val sessionId: String,
    val status: AgentTimelineStatus,
) : AgentTranscriptLifecycleV1InboundFrame {
    override val kind: AgentTranscriptLifecycleV1FrameKind =
        AgentTranscriptLifecycleV1FrameKind.RESPONSE
    override val type: String = "agent.timeline.status"
}

sealed interface AgentTimelineStatus

enum class AgentTimelineActiveSourceState(val wireValue: String) {
    CONNECTED("connected"),
    INTERRUPTED("interrupted"),
}

data class AgentTimelineAvailableStatus(
    val liveSource: AgentTimelineActiveSourceState,
    val activeSourceEpoch: String,
    val timelineEpoch: String,
    val currentAgentSeq: String,
    val earliestReplaySeq: String,
    val limits: AgentTimelineLimits,
) : AgentTimelineStatus

enum class AgentTimelineUnavailableReason(val wireValue: String) {
    AGENT_UNSUPPORTED("agent_unsupported"),
    SESSION_NOT_AGENT_MANAGED("session_not_agent_managed"),
    ADAPTER_UNAVAILABLE("adapter_unavailable"),
    STORE_UNAVAILABLE("store_unavailable"),
}

data class AgentTimelineUnavailableStatus(
    val reason: AgentTimelineUnavailableReason,
) : AgentTimelineStatus

data class AgentTimelineLimits(
    val maxTextUtf8Bytes: Long,
    val maxPageRecords: Long,
    val eventReplayRetentionMs: Long,
    val snapshotLeaseMs: Long,
)

data class AgentTimelineSnapshotGetFrame(
    val requestId: String,
    val hostId: String,
    val expectedHostEpoch: String,
    val scopeId: String,
    val sessionId: String,
    val request: AgentTimelineSnapshotRequest,
) : AgentTranscriptLifecycleV1Frame {
    override val kind: AgentTranscriptLifecycleV1FrameKind =
        AgentTranscriptLifecycleV1FrameKind.REQUEST
    override val type: String = "agent.timeline.snapshot.get"
}

data class AgentTimelineSnapshotRequest(
    val snapshotRequestId: String,
    val snapshotId: String?,
    val cursor: String?,
    val nextPageIndex: Long,
)

data class AgentTimelineSnapshotPageFrame(
    val requestId: String,
    override val hostId: String,
    override val hostEpoch: String,
    override val scopeId: String,
    override val sessionId: String,
    val page: AgentTimelineSnapshotPage,
) : AgentTranscriptLifecycleV1InboundFrame {
    override val kind: AgentTranscriptLifecycleV1FrameKind =
        AgentTranscriptLifecycleV1FrameKind.RESPONSE
    override val type: String = "agent.timeline.snapshot.page"
}

data class AgentTimelineSnapshotPage(
    val timelineEpoch: String,
    val snapshotRequestId: String,
    val snapshotId: String,
    val pageIndex: Long,
    val isLast: Boolean,
    val nextCursor: String?,
    val throughAgentSeq: String,
    val earliestRetainedSeq: String,
    val records: List<AgentTimelineSnapshotRecord>,
)

data class AgentTimelineReplayGetFrame(
    val requestId: String,
    val hostId: String,
    val expectedHostEpoch: String,
    val scopeId: String,
    val sessionId: String,
    val request: AgentTimelineReplayRequest,
) : AgentTranscriptLifecycleV1Frame {
    override val kind: AgentTranscriptLifecycleV1FrameKind =
        AgentTranscriptLifecycleV1FrameKind.REQUEST
    override val type: String = "agent.timeline.replay.get"
}

data class AgentTimelineReplayRequest(
    val timelineEpoch: String,
    val afterAgentSeq: String,
    val cursor: String?,
    val limit: Long,
)

data class AgentTimelineReplayPageFrame(
    val requestId: String,
    override val hostId: String,
    override val hostEpoch: String,
    override val scopeId: String,
    override val sessionId: String,
    val page: AgentTimelineReplayPage,
) : AgentTranscriptLifecycleV1InboundFrame {
    override val kind: AgentTranscriptLifecycleV1FrameKind =
        AgentTranscriptLifecycleV1FrameKind.RESPONSE
    override val type: String = "agent.timeline.replay.page"
}

data class AgentTimelineReplayPage(
    val timelineEpoch: String,
    val afterAgentSeq: String,
    val replayThroughAgentSeq: String,
    val isLast: Boolean,
    val nextCursor: String?,
    val events: List<AgentTimelineEventRecord>,
)

data class AgentTimelineEventFrame(
    override val hostId: String,
    override val hostEpoch: String,
    override val scopeId: String,
    override val sessionId: String,
    val timelineEpoch: String,
    val event: AgentTimelineEventRecord,
) : AgentTranscriptLifecycleV1InboundFrame {
    override val kind: AgentTranscriptLifecycleV1FrameKind =
        AgentTranscriptLifecycleV1FrameKind.EVENT
    override val type: String = "agent.timeline.event"
}

data class AgentTimelineEventRecord(
    val agentEventSeq: String,
    val eventId: String,
    val occurredAtMs: Long,
    val mutation: AgentTimelineMutation,
)

sealed interface AgentTimelineSnapshotRecord

data class AgentTimelineTextEntryMetadata(
    val entryId: String,
    val runId: String,
    val turnId: String,
    val role: AgentTimelineEntryRole,
    val commandId: String?,
    val createdAtMs: Long,
    val createdAgentSeq: String,
    val lastModifiedAgentSeq: String,
)

sealed interface AgentTimelineTextEntryRecord : AgentTimelineSnapshotRecord {
    val metadata: AgentTimelineTextEntryMetadata
}

data class AgentTimelineVisibleTextEntryRecord(
    override val metadata: AgentTimelineTextEntryMetadata,
    val text: String,
) : AgentTimelineTextEntryRecord

data class AgentTimelineRedactedTextEntryRecord(
    override val metadata: AgentTimelineTextEntryMetadata,
    val redactionReason: AgentTimelineRedactionReason,
) : AgentTimelineTextEntryRecord

enum class AgentTimelineEntryRole(val wireValue: String) {
    USER("user"),
    AGENT("agent"),
}

enum class AgentTimelineRedactionReason(val wireValue: String) {
    USER_REQUEST("user_request"),
    POLICY("policy"),
    RETENTION("retention"),
}

enum class AgentTimelineLifecycleScope(val wireValue: String) {
    RUN("run"),
    TURN("turn"),
}

enum class AgentTimelineLifecycleState(val wireValue: String) {
    RUNNING("running"),
    WAITING_FOR_USER("waiting_for_user"),
    FAILED("failed"),
    COMPLETED("completed"),
}

data class AgentTimelineFailure(
    val code: String,
    val summary: String?,
)

data class AgentTimelineLifecycleRecord(
    val lifecycleEventId: String,
    val sourceEpoch: String,
    val scope: AgentTimelineLifecycleScope,
    val runId: String,
    val turnId: String?,
    val state: AgentTimelineLifecycleState,
    val failure: AgentTimelineFailure?,
    val occurredAtMs: Long,
    val agentEventSeq: String,
) : AgentTimelineSnapshotRecord

sealed interface AgentTimelineMutation

data class AgentTimelineTextEntryAppendedMutation(
    val entry: AgentTimelineVisibleTextEntryRecord,
) : AgentTimelineMutation

data class AgentTimelineEntryRedactedMutation(
    val entryId: String,
    val reason: AgentTimelineRedactionReason,
) : AgentTimelineMutation

data class AgentTimelineEntryDeletedMutation(
    val entryId: String,
    val reason: AgentTimelineRedactionReason,
) : AgentTimelineMutation

data class AgentTimelineLifecycleChangedMutation(
    val lifecycle: AgentTimelineLifecycleRecord,
) : AgentTimelineMutation

enum class AgentTimelineSourceAvailabilityState(val wireValue: String) {
    CONNECTED("connected"),
    INTERRUPTED("interrupted"),
}

enum class AgentTimelineSourceAvailabilityReason(val wireValue: String) {
    SOURCE_DISCONNECTED("source_disconnected"),
    SOURCE_RESTARTED("source_restarted"),
}

data class AgentTimelineSourceAvailabilityMutation(
    val state: AgentTimelineSourceAvailabilityState,
    val sourceEpoch: String,
    val reason: AgentTimelineSourceAvailabilityReason?,
) : AgentTimelineMutation

enum class AgentTimelineResetReason(val wireValue: String) {
    DELETED("deleted"),
    STORE_RESET("store_reset"),
}

data class AgentTimelineResetFrame(
    override val hostId: String,
    override val hostEpoch: String,
    override val scopeId: String,
    override val sessionId: String,
    val previousTimelineEpoch: String,
    val newTimelineEpoch: String?,
    val reason: AgentTimelineResetReason,
) : AgentTranscriptLifecycleV1InboundFrame {
    override val kind: AgentTranscriptLifecycleV1FrameKind =
        AgentTranscriptLifecycleV1FrameKind.EVENT
    override val type: String = "agent.timeline.reset"
}
