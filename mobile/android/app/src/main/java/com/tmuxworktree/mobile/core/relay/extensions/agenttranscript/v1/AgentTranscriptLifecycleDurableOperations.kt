package com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1

import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineEntryDeletedMutation
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineEntryRedactedMutation
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineEntryRole as PublicEntryRole
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineEventRecord
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineLifecycleChangedMutation
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineLifecycleRecord
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineLifecycleScope as PublicLifecycleScope
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineLifecycleState as PublicLifecycleState
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineRedactedTextEntryRecord
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineRedactionReason as PublicRedactionReason
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineSnapshotRecord
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineSourceAvailabilityMutation
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineSourceAvailabilityReason as PublicSourceReason
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineSourceAvailabilityState as PublicSourceState
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineTextEntryAppendedMutation
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineTextEntryMetadata
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineVisibleTextEntryRecord
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTranscriptLifecycleV1Codec
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StateLimits
import com.tmuxworktree.mobile.core.relay.v2.state.canonicalArrayBytes
import java.math.BigInteger
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.Base64

/** Exact eight-column authority plus the selected ninth-column timeline namespace. */
internal data class AgentTranscriptLifecycleDurableOperationFence(
    val authority: AgentTranscriptLifecycleDurableConsumerIdentity,
    val expectedNamespace: AgentTranscriptLifecycleDurableNamespace,
) {
    init {
        require(authority == expectedNamespace.consumer) {
            "Durable operation authority does not match its exact consumer namespace"
        }
    }
}

/** Only payload-free reducer inputs are admitted by the control transaction. */
internal data class AgentTranscriptLifecycleDurableControlCommand(
    val fence: AgentTranscriptLifecycleDurableOperationFence,
    val input: AgentTranscriptLifecycleControlInput,
)

/**
 * One closed event whose typed domain value and canonical bytes have a single codec owner.
 * Construction is private so a caller cannot pair DTO A with canonical bytes B.
 */
internal data class AgentTranscriptLifecycleDurableClosedEvent private constructor(
    val input: AgentTranscriptLifecycleClientInput.AgentEvent,
    val occurredAtMs: Long,
    val canonicalJson: String,
    val canonicalUtf8Bytes: Int,
    val rawUtf8Bytes: Int,
) {
    companion object {
        fun closeWithPublicCodec(
            codec: AgentTranscriptLifecycleV1Codec,
            lineage: AgentTimelineLineage,
            provenance: AgentEventProvenance,
            canonicalBytes: ByteArray,
            rawUtf8Bytes: Int,
        ): AgentTranscriptLifecycleDurableClosedEvent {
            val immutableBytes = canonicalBytes.copyOf()
            requireCanonicalArtifactBounds(immutableBytes, rawUtf8Bytes)
            val decoded = codec.decodeCanonicalEventRecord(immutableBytes)
            require(
                MessageDigest.isEqual(codec.encodeCanonicalEventRecord(decoded), immutableBytes),
            ) { "Event bytes are not the public codec's fixed-order canonical form" }
            return AgentTranscriptLifecycleDurableClosedEvent(
                input = AgentTranscriptLifecycleClientInput.AgentEvent(
                    lineage = lineage,
                    agentEventSeq = decoded.agentEventSeq,
                    eventId = decoded.eventId,
                    closedEventDigest = AgentClosedEventDigest(digestBase64Url(immutableBytes)),
                    mutation = decoded.toDomainMutation(),
                    provenance = provenance,
                ),
                occurredAtMs = decoded.occurredAtMs,
                canonicalJson = strictOperationUtf8String(immutableBytes),
                canonicalUtf8Bytes = immutableBytes.size,
                rawUtf8Bytes = rawUtf8Bytes,
            )
        }
    }
}

/** Snapshot text metadata after the transport DTO has been discarded. */
internal data class AgentTranscriptLifecycleSnapshotTextMetadata(
    val entryId: String,
    val runId: String,
    val turnId: String,
    val role: AgentTimelineEntryRole,
    val commandId: String?,
    val createdAtMs: Long,
    val createdAgentSeq: String,
    val lastModifiedAgentSeq: String,
)

/** Durable snapshot union used by C/final materialization, not a second wire codec. */
internal sealed interface AgentTranscriptLifecycleDurableSnapshotRecord {
    val stableIdentity: String
    val orderingAgentSeq: String

    data class Visible(
        val entry: AgentTimelineVisibleEntry,
    ) : AgentTranscriptLifecycleDurableSnapshotRecord {
        override val stableIdentity: String = entry.entryId
        override val orderingAgentSeq: String = entry.createdAgentSeq
    }

    data class Redacted(
        val metadata: AgentTranscriptLifecycleSnapshotTextMetadata,
        val reason: AgentTimelineRedactionReason,
    ) : AgentTranscriptLifecycleDurableSnapshotRecord {
        override val stableIdentity: String = metadata.entryId
        override val orderingAgentSeq: String = metadata.createdAgentSeq
    }

    data class Lifecycle(
        val record: AgentLifecycleRecord,
    ) : AgentTranscriptLifecycleDurableSnapshotRecord {
        override val stableIdentity: String = record.lifecycleEventId
        override val orderingAgentSeq: String = record.agentEventSeq
    }
}

internal data class AgentTranscriptLifecycleDurableClosedSnapshotRecord private constructor(
    val record: AgentTranscriptLifecycleDurableSnapshotRecord,
    val canonicalJson: String,
    val canonicalUtf8Bytes: Int,
    val rawUtf8Bytes: Int,
    val sha256: String,
) {
    companion object {
        fun closeWithPublicCodec(
            codec: AgentTranscriptLifecycleV1Codec,
            canonicalBytes: ByteArray,
            rawUtf8Bytes: Int,
        ): AgentTranscriptLifecycleDurableClosedSnapshotRecord {
            val immutableBytes = canonicalBytes.copyOf()
            requireCanonicalArtifactBounds(immutableBytes, rawUtf8Bytes)
            val decoded = codec.decodeCanonicalSnapshotRecord(immutableBytes)
            require(
                MessageDigest.isEqual(codec.encodeCanonicalSnapshotRecord(decoded), immutableBytes),
            ) { "Snapshot record bytes are not the public codec's fixed-order canonical form" }
            return AgentTranscriptLifecycleDurableClosedSnapshotRecord(
                record = decoded.toDurableSnapshotRecord(),
                canonicalJson = strictOperationUtf8String(immutableBytes),
                canonicalUtf8Bytes = immutableBytes.size,
                rawUtf8Bytes = rawUtf8Bytes,
                sha256 = sha256Hex(immutableBytes),
            )
        }
    }
}

/**
 * The sole public-codec-to-durable-domain adapter.
 *
 * Each method strict-decodes the supplied canonical bytes, fixed-order re-encodes them with the
 * same public codec, requires exact byte equality, then adapts that decoded DTO exactly once.
 */
internal class AgentTranscriptLifecycleClosedArtifactFactory(
    private val codec: AgentTranscriptLifecycleV1Codec = AgentTranscriptLifecycleV1Codec(),
) {
    fun closeEvent(
        lineage: AgentTimelineLineage,
        provenance: AgentEventProvenance,
        canonicalBytes: ByteArray,
        rawUtf8Bytes: Int,
    ): AgentTranscriptLifecycleDurableClosedEvent {
        return AgentTranscriptLifecycleDurableClosedEvent.closeWithPublicCodec(
            codec,
            lineage,
            provenance,
            canonicalBytes,
            rawUtf8Bytes,
        )
    }

    fun closeSnapshotRecord(
        canonicalBytes: ByteArray,
        rawUtf8Bytes: Int,
    ): AgentTranscriptLifecycleDurableClosedSnapshotRecord {
        return AgentTranscriptLifecycleDurableClosedSnapshotRecord.closeWithPublicCodec(
            codec,
            canonicalBytes,
            rawUtf8Bytes,
        )
    }
}

internal data class AgentTranscriptLifecycleDurableLiveEventCommand(
    val fence: AgentTranscriptLifecycleDurableOperationFence,
    val event: AgentTranscriptLifecycleDurableClosedEvent,
) {
    init {
        require(event.input.provenance == AgentEventProvenance.LIVE)
        require(event.input.lineage.session == fence.authority.sessionIdentity)
        require(event.input.lineage.timelineEpoch == fence.expectedNamespace.timelineEpoch)
    }
}

internal data class AgentTranscriptLifecycleDurableReplayPage(
    val fence: AgentTranscriptLifecycleDurableOperationFence,
    val lineage: AgentTimelineLineage,
    val pageIndex: Long,
    val requestNetworkToken: String,
    val requestCursor: String?,
    val stableAfterAgentSeq: String,
    val replayThroughAgentSeq: String,
    /** Durable cursor immediately before this page; empty pages leave it unchanged. */
    val pageStartAgentSeq: String,
    val requestLimit: Long,
    val events: List<AgentTranscriptLifecycleDurableClosedEvent>,
    val rawFrameUtf8Bytes: Int,
) {
    init {
        require(lineage.session == fence.authority.sessionIdentity)
        require(lineage.timelineEpoch == fence.expectedNamespace.timelineEpoch)
        require(pageIndex >= 0)
        require((pageIndex == 0L) == (requestCursor == null))
        requireOperationId(requestNetworkToken)
        requestCursor?.let { require(isValidAgentTimelineCursor(it)) }
        require(requestLimit in 1..AgentTranscriptLifecycleDurableCaps.NETWORK_PAGE_RECORDS)
        require(events.size.toLong() <= requestLimit)
        requireCanonicalOperationCounter(stableAfterAgentSeq, allowZero = true)
        requireCanonicalOperationCounter(pageStartAgentSeq, allowZero = true)
        requireCanonicalOperationCounter(replayThroughAgentSeq, allowZero = true)
        require(compareOperationCounters(stableAfterAgentSeq, pageStartAgentSeq) <= 0)
        require(compareOperationCounters(pageStartAgentSeq, replayThroughAgentSeq) <= 0)
        require(pageIndex != 0L || pageStartAgentSeq == stableAfterAgentSeq)
        require(rawFrameUtf8Bytes in 1..RelayV2StateLimits.MAX_PUBLIC_FRAME_BYTES)
        require(rawFrameUtf8Bytes.toLong() >= canonicalRecordsArrayBytes(events))
        var expectedSequence = BigInteger(pageStartAgentSeq)
        events.forEach { event ->
            require(event.input.provenance == AgentEventProvenance.REPLAY)
            require(event.input.lineage == lineage)
            expectedSequence += BigInteger.ONE
            require(BigInteger(event.input.agentEventSeq) == expectedSequence)
            require(compareOperationCounters(event.input.agentEventSeq, replayThroughAgentSeq) <= 0)
        }
    }

    val lastAgentSeq: String
        get() = events.lastOrNull()?.input?.agentEventSeq ?: pageStartAgentSeq
}

/** Non-final replay page atomically persists the next request token/cursor before returning. */
internal sealed interface AgentTranscriptLifecycleDurableReplayPageCommand {
    val page: AgentTranscriptLifecycleDurableReplayPage

    data class NonFinal(
        override val page: AgentTranscriptLifecycleDurableReplayPage,
        val nextCursor: String,
        val nextRequestNetworkToken: String,
    ) : AgentTranscriptLifecycleDurableReplayPageCommand {
        init {
            require(page.events.isNotEmpty())
            require(isValidAgentTimelineCursor(nextCursor))
            requireOperationId(nextRequestNetworkToken)
            require(nextRequestNetworkToken != page.requestNetworkToken)
            require(compareOperationCounters(page.lastAgentSeq, page.replayThroughAgentSeq) < 0)
        }
    }

    data class Final(
        override val page: AgentTranscriptLifecycleDurableReplayPage,
    ) : AgentTranscriptLifecycleDurableReplayPageCommand {
        init {
            require(page.lastAgentSeq == page.replayThroughAgentSeq)
            if (page.events.isEmpty()) {
                require(page.stableAfterAgentSeq == page.replayThroughAgentSeq)
            }
        }
    }
}

/** Page-zero snapshot request fence persisted before the request is sent; snapshotId is unknown. */
internal data class AgentTranscriptLifecycleDurableSnapshotRequestCommand(
    val fence: AgentTranscriptLifecycleDurableOperationFence,
    val snapshotRequestId: String,
    val pageZeroNetworkToken: String,
) {
    init {
        requireOperationId(snapshotRequestId)
        requireOperationId(pageZeroNetworkToken)
    }
}

internal data class AgentTranscriptLifecycleDurableSnapshotPage(
    val fence: AgentTranscriptLifecycleDurableOperationFence,
    val localGeneration: String,
    val requestNetworkToken: String,
    val requestCursor: String?,
    val snapshotRequestId: String,
    val snapshotId: String,
    val pageIndex: Long,
    val throughAgentSeq: String,
    val earliestRetainedSeq: String,
    val records: List<AgentTranscriptLifecycleDurableClosedSnapshotRecord>,
    val rawFrameUtf8Bytes: Int,
) {
    init {
        requireCanonicalOperationCounter(localGeneration, allowZero = true)
        requireOperationId(requestNetworkToken)
        requireOperationId(snapshotRequestId)
        requireOperationId(snapshotId)
        require(pageIndex >= 0)
        require((pageIndex == 0L) == (requestCursor == null))
        requestCursor?.let { require(isValidAgentTimelineCursor(it)) }
        requireCanonicalOperationCounter(throughAgentSeq, allowZero = false)
        requireCanonicalOperationCounter(earliestRetainedSeq, allowZero = false)
        require(compareOperationCounters(earliestRetainedSeq, throughAgentSeq) <= 0)
        require(records.size <= AgentTranscriptLifecycleDurableCaps.NETWORK_PAGE_RECORDS)
        require(rawFrameUtf8Bytes in 1..RelayV2StateLimits.MAX_PUBLIC_FRAME_BYTES)
        require(rawFrameUtf8Bytes.toLong() >= canonicalSnapshotArrayBytes(records))
        records.forEach { closed ->
            val record = closed.record
            require(compareOperationCounters(record.orderingAgentSeq, throughAgentSeq) <= 0)
            when (record) {
                is AgentTranscriptLifecycleDurableSnapshotRecord.Visible -> {
                    require(
                        compareOperationCounters(
                            record.entry.createdAgentSeq,
                            throughAgentSeq,
                        ) <= 0,
                    )
                    require(
                        compareOperationCounters(
                            record.entry.lastModifiedAgentSeq,
                            throughAgentSeq,
                        ) <= 0,
                    )
                }
                is AgentTranscriptLifecycleDurableSnapshotRecord.Redacted -> {
                    require(
                        compareOperationCounters(
                            record.metadata.createdAgentSeq,
                            throughAgentSeq,
                        ) <= 0,
                    )
                    require(
                        compareOperationCounters(
                            record.metadata.lastModifiedAgentSeq,
                            throughAgentSeq,
                        ) <= 0,
                    )
                }
                is AgentTranscriptLifecycleDurableSnapshotRecord.Lifecycle -> Unit
            }
        }
        records.zipWithNext().forEach { (left, right) ->
            require(compareSnapshotRecords(left.record, right.record) < 0)
        }
    }
}

/**
 * A non-final response stages B/C and atomically installs the next pending token. A final response
 * never persists B.complete: the same transaction writes its records, validates/streams the full
 * cut, swaps A/current/evidence, merges D, commits state/accounting/ledger, and deletes B/C.
 */
internal sealed interface AgentTranscriptLifecycleDurableSnapshotPageCommand {
    val page: AgentTranscriptLifecycleDurableSnapshotPage

    data class NonFinalStage(
        override val page: AgentTranscriptLifecycleDurableSnapshotPage,
        val nextCursor: String,
        val nextRequestNetworkToken: String,
    ) : AgentTranscriptLifecycleDurableSnapshotPageCommand {
        init {
            require(isValidAgentTimelineCursor(nextCursor))
            requireOperationId(nextRequestNetworkToken)
            require(nextRequestNetworkToken != page.requestNetworkToken)
        }
    }

    data class FinalPageCut(
        override val page: AgentTranscriptLifecycleDurableSnapshotPage,
    ) : AgentTranscriptLifecycleDurableSnapshotPageCommand
}

/** Small result: row-oriented collections never escape through the runtime call. */
internal data class AgentTranscriptLifecycleDurableOperationResult(
    val controlState: AgentTranscriptLifecycleDurableControlState,
    val disposition: AgentClientDisposition,
    val syncDirective: AgentTimelineSyncDirective,
    val notificationDecisions: List<AgentNotificationDecision>,
) {
    init {
        require(
            notificationDecisions.size <=
                AgentTranscriptLifecycleDurableCaps.MAX_PENDING_NOTIFICATION_SCAN,
        )
    }
}

/** State-row projection: no materialized/index Map or unbounded List is present. */
internal data class AgentTranscriptLifecycleDurableControlState(
    val identity: AgentExtensionSessionIdentity,
    val notificationConfig: AgentNotificationConfig,
    val extension: AgentTranscriptLifecycleDurableExtensionControlState,
)

internal data class AgentTranscriptLifecycleDurableExtensionControlState(
    val localGeneration: String,
    val support: AgentExtensionSupport,
    val unavailableReason: AgentExtensionUnavailableReason?,
    val liveSource: AgentLiveSourceState?,
    val activeSourceEpoch: String?,
    val timelineEpoch: String?,
    val lastAgentSeq: String,
    val effectiveHostLimits: AgentTimelineEffectiveLimits?,
    val syncState: AgentTimelineSyncState,
    val notificationBaselineAgentSeq: String?,
    val retiredTimelineEpochs: Set<String>,
    val retiredEpochCompactionGeneration: String?,
    val snapshotCheckpoint: AgentSnapshotCheckpoint?,
    val snapshotNotificationSuppressedThroughAgentSeq: String?,
    val pendingStatusRequest: AgentLocalRequestFence?,
    val pendingSnapshotRequest: AgentSnapshotPreFirstFence?,
    val requiresTimelineRotation: Boolean,
)

/**
 * Future production call graph after S1:
 *
 * public codec -> runtime authority/lineage/ingress fence -> codec-owned closed artifact
 * -> one closed command -> one apply lease -> one operation method -> one withTransaction
 * -> A/D or B/C + exact-namespace row index + small state/accounting/ledger -> commit result.
 *
 * One network page is <=256 records and <=1 MiB raw. Inside that same outer transaction Core may
 * split it into several <=256-record / <=512-KiB-canonical DAO batches. The local batch budget is
 * never a wire-page admission cap. This port intentionally has no production implementation until
 * S1 supplies the row-oriented Room index and every method has a real atomic path.
 */
internal interface AgentTranscriptLifecycleDurableOperationPort {
    suspend fun applyControlUnderApplyLease(
        command: AgentTranscriptLifecycleDurableControlCommand,
        limits: AgentClientReducerLimits = AgentClientReducerLimits(),
    ): AgentTranscriptLifecycleDurableOperationResult

    suspend fun consumeLiveEventUnderApplyLease(
        command: AgentTranscriptLifecycleDurableLiveEventCommand,
        limits: AgentClientReducerLimits = AgentClientReducerLimits(),
    ): AgentTranscriptLifecycleDurableOperationResult

    suspend fun consumeReplayPageUnderApplyLease(
        command: AgentTranscriptLifecycleDurableReplayPageCommand,
        limits: AgentClientReducerLimits = AgentClientReducerLimits(),
    ): AgentTranscriptLifecycleDurableOperationResult

    suspend fun persistSnapshotRequestUnderApplyLease(
        command: AgentTranscriptLifecycleDurableSnapshotRequestCommand,
    ): AgentTranscriptLifecycleDurableOperationResult

    suspend fun consumeSnapshotPageUnderApplyLease(
        command: AgentTranscriptLifecycleDurableSnapshotPageCommand,
        limits: AgentClientReducerLimits = AgentClientReducerLimits(),
    ): AgentTranscriptLifecycleDurableOperationResult
}

/** Exact per-family row/byte counters stored beside the small control state. */
internal data class AgentTranscriptLifecycleDurableIndexAccounting(
    val currentLifecycleCount: Long,
    val currentLifecycleCanonicalUtf8Bytes: Long,
    val permanentLifecycleEvidenceCount: Long,
    val permanentLifecycleEvidenceCanonicalUtf8Bytes: Long,
    val appliedEventCount: Long,
    val appliedEventCanonicalUtf8Bytes: Long,
    val notificationLedgerCount: Long,
    val notificationLedgerCanonicalUtf8Bytes: Long,
)

internal data class AgentTranscriptLifecycleDurableCurrentLifecycleRow(
    val record: AgentLifecycleRecord,
    val establishedBySnapshot: Boolean,
    val canonicalUtf8Bytes: Int,
) {
    init {
        require(canonicalUtf8Bytes in 1..RelayV2StateLimits.MAX_PUBLIC_FRAME_BYTES)
    }
}

internal data class AgentTranscriptLifecycleDurablePermanentEvidenceRow(
    val witness: AgentLifecycleEventIdentityWitness,
    val canonicalUtf8Bytes: Int,
) {
    init {
        require(canonicalUtf8Bytes in 1..RelayV2StateLimits.MAX_PUBLIC_FRAME_BYTES)
    }
}

internal data class AgentTranscriptLifecycleDurableAppliedEventRow(
    val agentEventSeq: String,
    val evidence: AgentAppliedEventEvidence,
    val canonicalUtf8Bytes: Int,
) {
    init {
        require(canonicalUtf8Bytes in 1..RelayV2StateLimits.MAX_PUBLIC_FRAME_BYTES)
    }
}

internal data class AgentTranscriptLifecycleDurableNotificationRow(
    val key: AgentNotificationDedupeKey,
    val entry: AgentNotificationLedgerEntry,
    val canonicalUtf8Bytes: Int,
) {
    init {
        require(canonicalUtf8Bytes in 1..RelayV2StateLimits.MAX_PUBLIC_FRAME_BYTES)
        require(entry.eventIdentity.eventId == key.lifecycleEventId)
        require(entry.eventIdentity.state == key.state)
    }
}

internal data class AgentTranscriptLifecycleDurableCurrentAuditCursor(
    val agentEventSeqOrder: String,
    val lifecycleEventId: String,
)

internal data class AgentTranscriptLifecycleDurableEvidenceAuditCursor(
    val lifecycleScope: AgentLifecycleScope,
    val runId: String,
    val turnId: String?,
    val agentEventSeqOrder: String,
    val eventId: String,
)

internal data class AgentTranscriptLifecycleDurableAppliedAuditCursor(
    val agentEventSeqOrder: String,
    val eventId: String,
)

internal data class AgentTranscriptLifecycleDurableLedgerAuditCursor(
    val lifecycleEventId: String,
    val lifecycleState: AgentLifecycleState,
)

internal data class AgentTranscriptLifecycleDurablePendingNotificationCursor(
    val agentEventSeqOrder: String,
    val lifecycleEventId: String,
    val lifecycleState: AgentLifecycleState,
)

/** Transaction opens one handle already bound to an exact nine-column namespace. */
internal interface AgentTranscriptLifecycleDurableIndexTransaction {
    fun openAgentTranscriptLifecycleIndex(
        namespace: AgentTranscriptLifecycleDurableNamespace,
    ): AgentTranscriptLifecycleDurableIndexHandle
}

/**
 * Row-oriented lifecycle/evidence/ledger owner. Counts are checked before global keyset audits;
 * ordinary operations point-read and increment accounting instead of rescanning all rows.
 */
internal interface AgentTranscriptLifecycleDurableIndexHandle {
    val namespace: AgentTranscriptLifecycleDurableNamespace

    fun accounting(): AgentTranscriptLifecycleDurableIndexAccounting

    fun currentLifecycle(identity: AgentLifecycleIdentity):
        AgentTranscriptLifecycleDurableCurrentLifecycleRow?

    fun currentLifecycleByEventId(lifecycleEventId: String):
        AgentTranscriptLifecycleDurableCurrentLifecycleRow?

    fun currentRunLifecycle(runId: String): AgentTranscriptLifecycleDurableCurrentLifecycleRow?

    fun currentNonTerminalLifecycle(identity: AgentLifecycleIdentity):
        AgentTranscriptLifecycleDurableCurrentLifecycleRow?

    fun terminalSourceFence(
        identity: AgentLifecycleIdentity,
        sourceEpoch: String,
    ): AgentTranscriptLifecycleDurablePermanentEvidenceRow?

    fun currentAuditBatch(
        after: AgentTranscriptLifecycleDurableCurrentAuditCursor?,
        limit: Int,
    ): List<AgentTranscriptLifecycleDurableCurrentLifecycleRow>

    fun insertCurrent(row: AgentTranscriptLifecycleDurableCurrentLifecycleRow)

    fun compareAndSetCurrent(
        expected: AgentTranscriptLifecycleDurableCurrentLifecycleRow,
        next: AgentTranscriptLifecycleDurableCurrentLifecycleRow,
    ): Int

    fun deleteCurrent(expected: AgentTranscriptLifecycleDurableCurrentLifecycleRow): Int

    fun permanentEvidenceByEventId(eventId: String):
        AgentTranscriptLifecycleDurablePermanentEvidenceRow?

    fun permanentEvidenceBySeq(agentEventSeq: String):
        AgentTranscriptLifecycleDurablePermanentEvidenceRow?

    /** Snapshot-established null digests can never satisfy this exact-event duplicate predicate. */
    fun hasExactPermanentEventEvidence(
        agentEventSeq: String,
        eventId: String,
        closedEventDigest: AgentClosedEventDigest,
    ): Boolean {
        val evidence = permanentEvidenceByEventId(eventId) ?: return false
        return evidence.witness.agentEventSeq == agentEventSeq &&
            evidence.witness.closedEventDigest != null &&
            evidence.witness.closedEventDigest == closedEventDigest &&
            permanentEvidenceBySeq(agentEventSeq) == evidence
    }

    fun highestPermanentEvidence(identity: AgentLifecycleIdentity):
        AgentTranscriptLifecycleDurablePermanentEvidenceRow?

    /** Derived index query; there is no independently writable run-with-turn marker authority. */
    fun hasPermanentTurnEvidenceForRun(runId: String): Boolean

    fun permanentEvidenceForIdentityBatch(
        identity: AgentLifecycleIdentity,
        afterAgentEventSeqOrder: String?,
        limit: Int,
    ): List<AgentTranscriptLifecycleDurablePermanentEvidenceRow>

    /** Global, uncapped keyset enumeration used by full restore/final-cut chain audits. */
    fun permanentEvidenceAuditBatch(
        after: AgentTranscriptLifecycleDurableEvidenceAuditCursor?,
        limit: Int,
    ): List<AgentTranscriptLifecycleDurablePermanentEvidenceRow>

    /** INSERT ABORT. A null digest is snapshot-established evidence, never exact-event proof. */
    fun insertPermanentEvidence(row: AgentTranscriptLifecycleDurablePermanentEvidenceRow)

    fun appliedEventBySeq(agentEventSeq: String): AgentTranscriptLifecycleDurableAppliedEventRow?

    fun appliedEventByEventId(eventId: String): AgentTranscriptLifecycleDurableAppliedEventRow?

    fun appliedEventAuditBatch(
        after: AgentTranscriptLifecycleDurableAppliedAuditCursor?,
        limit: Int,
    ): List<AgentTranscriptLifecycleDurableAppliedEventRow>

    fun insertAppliedEvent(row: AgentTranscriptLifecycleDurableAppliedEventRow)

    /** Exact per-row CAS delete used for snapshot compaction and replay-floor pruning. */
    fun deleteAppliedEvent(expected: AgentTranscriptLifecycleDurableAppliedEventRow): Int

    fun notificationLedgerEntry(key: AgentNotificationDedupeKey): AgentNotificationLedgerEntry?

    fun notificationLedgerEntryByLifecycleEventId(
        lifecycleEventId: String,
    ): AgentTranscriptLifecycleDurableNotificationRow?

    fun notificationLedgerAuditBatch(
        after: AgentTranscriptLifecycleDurableLedgerAuditCursor?,
        limit: Int,
    ): List<AgentTranscriptLifecycleDurableNotificationRow>

    fun insertNotificationLedgerEntry(row: AgentTranscriptLifecycleDurableNotificationRow)

    /** Exact row CAS delete for destructive-cut suppression/retirement. */
    fun deleteNotificationLedgerEntry(
        expected: AgentTranscriptLifecycleDurableNotificationRow,
    ): Int

    /** At most 64 unclaimed SHOWN decisions, in canonical seq/UTF-8 identity order. */
    fun pendingNotificationBatch(
        after: AgentTranscriptLifecycleDurablePendingNotificationCursor?,
        limit: Int,
    ): List<AgentTranscriptLifecycleDurableNotificationRow>

    /** Exact timeline retirement; implementation must prove all affected family counts. */
    fun deleteIndexedTimeline(
        expectedAccounting: AgentTranscriptLifecycleDurableIndexAccounting,
    ): AgentTranscriptLifecycleDurableIndexAccounting
}

/** Current Node owner composite bounds; storage admission sources, never wire fields. */
internal object AgentTranscriptLifecycleDurableCaps {
    const val NETWORK_PAGE_RECORDS = 256
    const val NETWORK_PAGE_RAW_UTF8_BYTES = 1_048_576
    const val DAO_BATCH_RECORDS = 256
    const val DAO_BATCH_CANONICAL_UTF8_BYTES = 524_288
    const val MAX_PENDING_NOTIFICATION_SCAN = 64

    const val NODE_MAX_RUN_LIFECYCLE_RECORDS = 50_000L
    const val NODE_MAX_TURN_LIFECYCLE_RECORDS = 100_000L
    const val NODE_MAX_ACTIVE_TEXT_ENTRIES = 50_000L
    const val NODE_MAX_DELETE_TOMBSTONES = 100_000L
    const val MAX_SNAPSHOT_CUT_RECORDS =
        NODE_MAX_RUN_LIFECYCLE_RECORDS +
            NODE_MAX_TURN_LIFECYCLE_RECORDS +
            NODE_MAX_ACTIVE_TEXT_ENTRIES
    const val MAX_MATERIALIZED_TEXT_ROWS =
        NODE_MAX_ACTIVE_TEXT_ENTRIES + NODE_MAX_DELETE_TOMBSTONES
}

private fun AgentTimelineEventRecord.toDomainMutation(): AgentTimelineMutation = when (
    val value = mutation
) {
    is AgentTimelineTextEntryAppendedMutation -> AgentTimelineMutation.Append(
        value.entry.toDomainVisibleEntry(),
    )
    is AgentTimelineEntryRedactedMutation -> AgentTimelineMutation.Redact(
        value.entryId,
        value.reason.toDomainReason(),
    )
    is AgentTimelineEntryDeletedMutation -> AgentTimelineMutation.Delete(
        value.entryId,
        value.reason.toDomainReason(),
    )
    is AgentTimelineLifecycleChangedMutation -> AgentTimelineMutation.Lifecycle(
        value.lifecycle.toDomainLifecycle(),
    )
    is AgentTimelineSourceAvailabilityMutation -> AgentTimelineMutation.SourceAvailability(
        state = when (value.state) {
            PublicSourceState.CONNECTED -> AgentLiveSourceState.CONNECTED
            PublicSourceState.INTERRUPTED -> AgentLiveSourceState.INTERRUPTED
        },
        sourceEpoch = value.sourceEpoch,
        reason = when (value.reason) {
            null -> null
            PublicSourceReason.SOURCE_DISCONNECTED ->
                AgentSourceAvailabilityReason.SOURCE_DISCONNECTED
            PublicSourceReason.SOURCE_RESTARTED -> AgentSourceAvailabilityReason.SOURCE_RESTARTED
        },
    )
}

private fun AgentTimelineSnapshotRecord.toDurableSnapshotRecord():
    AgentTranscriptLifecycleDurableSnapshotRecord = when (this) {
    is AgentTimelineVisibleTextEntryRecord ->
        AgentTranscriptLifecycleDurableSnapshotRecord.Visible(toDomainVisibleEntry())
    is AgentTimelineRedactedTextEntryRecord ->
        AgentTranscriptLifecycleDurableSnapshotRecord.Redacted(
            metadata.toDomainTextMetadata(),
            redactionReason.toDomainReason(),
        )
    is AgentTimelineLifecycleRecord ->
        AgentTranscriptLifecycleDurableSnapshotRecord.Lifecycle(toDomainLifecycle())
}

private fun AgentTimelineVisibleTextEntryRecord.toDomainVisibleEntry() = AgentTimelineVisibleEntry(
    entryId = metadata.entryId,
    runId = metadata.runId,
    turnId = metadata.turnId,
    role = metadata.role.toDomainRole(),
    commandId = metadata.commandId,
    createdAtMs = metadata.createdAtMs,
    createdAgentSeq = metadata.createdAgentSeq,
    lastModifiedAgentSeq = metadata.lastModifiedAgentSeq,
    text = text,
)

private fun AgentTimelineTextEntryMetadata.toDomainTextMetadata() =
    AgentTranscriptLifecycleSnapshotTextMetadata(
        entryId = entryId,
        runId = runId,
        turnId = turnId,
        role = role.toDomainRole(),
        commandId = commandId,
        createdAtMs = createdAtMs,
        createdAgentSeq = createdAgentSeq,
        lastModifiedAgentSeq = lastModifiedAgentSeq,
    )

private fun AgentTimelineLifecycleRecord.toDomainLifecycle() = AgentLifecycleRecord(
    lifecycleEventId = lifecycleEventId,
    sourceEpoch = sourceEpoch,
    identity = AgentLifecycleIdentity(
        scope = when (scope) {
            PublicLifecycleScope.RUN -> AgentLifecycleScope.RUN
            PublicLifecycleScope.TURN -> AgentLifecycleScope.TURN
        },
        runId = runId,
        turnId = turnId,
    ),
    state = when (state) {
        PublicLifecycleState.RUNNING -> AgentLifecycleState.RUNNING
        PublicLifecycleState.WAITING_FOR_USER -> AgentLifecycleState.WAITING_FOR_USER
        PublicLifecycleState.FAILED -> AgentLifecycleState.FAILED
        PublicLifecycleState.COMPLETED -> AgentLifecycleState.COMPLETED
    },
    failure = failure?.let { AgentLifecycleFailure(it.code, it.summary) },
    occurredAtMs = occurredAtMs,
    agentEventSeq = agentEventSeq,
)

private fun PublicEntryRole.toDomainRole(): AgentTimelineEntryRole = when (this) {
    PublicEntryRole.USER -> AgentTimelineEntryRole.USER
    PublicEntryRole.AGENT -> AgentTimelineEntryRole.AGENT
}

private fun PublicRedactionReason.toDomainReason(): AgentTimelineRedactionReason = when (this) {
    PublicRedactionReason.USER_REQUEST -> AgentTimelineRedactionReason.USER_REQUEST
    PublicRedactionReason.POLICY -> AgentTimelineRedactionReason.POLICY
    PublicRedactionReason.RETENTION -> AgentTimelineRedactionReason.RETENTION
}

private fun canonicalRecordsArrayBytes(
    events: List<AgentTranscriptLifecycleDurableClosedEvent>,
): Long = canonicalArrayBytes(events.size.toLong(), events.sumOf { it.canonicalUtf8Bytes.toLong() })

private fun canonicalSnapshotArrayBytes(
    records: List<AgentTranscriptLifecycleDurableClosedSnapshotRecord>,
): Long = canonicalArrayBytes(
    records.size.toLong(),
    records.sumOf { it.canonicalUtf8Bytes.toLong() },
)

private fun compareSnapshotRecords(
    left: AgentTranscriptLifecycleDurableSnapshotRecord,
    right: AgentTranscriptLifecycleDurableSnapshotRecord,
): Int {
    val sequence = compareOperationCounters(left.orderingAgentSeq, right.orderingAgentSeq)
    return if (sequence != 0) sequence else compareOperationUtf8(
        left.stableIdentity,
        right.stableIdentity,
    )
}

private fun requireCanonicalArtifactBounds(canonicalBytes: ByteArray, rawUtf8Bytes: Int) {
    require(canonicalBytes.isNotEmpty())
    require(canonicalBytes.size <= RelayV2StateLimits.MAX_PUBLIC_FRAME_BYTES)
    require(rawUtf8Bytes in canonicalBytes.size..RelayV2StateLimits.MAX_PUBLIC_FRAME_BYTES)
    strictOperationUtf8String(canonicalBytes)
}

private fun requireOperationId(value: String) {
    require(value.isNotBlank())
    require(value == value.trim())
    require('\u0000' !in value)
    require(strictOperationUtf8(value).size <= 128)
}

private fun requireCanonicalOperationCounter(value: String, allowZero: Boolean) {
    require(value == "0" || value.firstOrNull() in '1'..'9' && value.all(Char::isDigit))
    require(BigInteger(value).bitLength() <= 64)
    require(allowZero || value != "0")
}

private fun compareOperationCounters(left: String, right: String): Int =
    BigInteger(left).compareTo(BigInteger(right))

private fun compareOperationUtf8(left: String, right: String): Int {
    val leftBytes = strictOperationUtf8(left)
    val rightBytes = strictOperationUtf8(right)
    val shared = minOf(leftBytes.size, rightBytes.size)
    for (index in 0 until shared) {
        val comparison = (leftBytes[index].toInt() and 0xff)
            .compareTo(rightBytes[index].toInt() and 0xff)
        if (comparison != 0) return comparison
    }
    return leftBytes.size.compareTo(rightBytes.size)
}

private fun strictOperationUtf8(value: String): ByteArray = try {
    val encoded = StandardCharsets.UTF_8.newEncoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
        .encode(java.nio.CharBuffer.wrap(value))
    ByteArray(encoded.remaining()).also(encoded::get)
} catch (_: java.nio.charset.CharacterCodingException) {
    throw IllegalArgumentException("Value is not well-formed UTF-8")
}

private fun strictOperationUtf8String(value: ByteArray): String = try {
    StandardCharsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
        .decode(java.nio.ByteBuffer.wrap(value))
        .toString()
} catch (_: java.nio.charset.CharacterCodingException) {
    throw IllegalArgumentException("Canonical bytes are not well-formed UTF-8")
}

private fun sha256Hex(value: ByteArray): String = MessageDigest.getInstance("SHA-256")
    .digest(value)
    .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }

private fun digestBase64Url(value: ByteArray): String = Base64.getUrlEncoder()
    .withoutPadding()
    .encodeToString(MessageDigest.getInstance("SHA-256").digest(value))
