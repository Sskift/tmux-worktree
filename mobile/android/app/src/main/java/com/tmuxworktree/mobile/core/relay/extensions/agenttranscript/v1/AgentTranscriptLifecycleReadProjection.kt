package com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1

import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StorageException
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StorageFailure
import kotlinx.coroutines.CancellationException

internal const val AGENT_TRANSCRIPT_LIFECYCLE_READ_PAGE_LIMIT = 256

/** The selected transport dialect is supplied by future composition; this foundation selects none. */
internal enum class AgentTranscriptLifecycleReadDialect {
    RELAY_V1,
    RELAY_V2,
}

/**
 * Capability and active-lineage facts supplied by a future composition boundary.
 *
 * This value does not negotiate or advertise the extension. It only prevents a durable read when
 * the caller cannot prove that the exact selected namespace is the active negotiated v2 namespace.
 */
internal data class AgentTranscriptLifecycleReadAccess(
    val dialect: AgentTranscriptLifecycleReadDialect,
    val negotiatedCapabilities: Set<String>,
    val support: AgentExtensionSupport,
    val activeNamespace: AgentTranscriptLifecycleDurableNamespace?,
)

internal enum class AgentTranscriptLifecycleReadRecordKind(val storageValue: String) {
    ENTRY("ENTRY"),
    LIFECYCLE("LIFECYCLE"),
}

/** Closed current-source facts captured from the same durable parent cut as the revision. */
internal sealed interface AgentTranscriptLifecycleReadSourceCut {
    data object Unavailable : AgentTranscriptLifecycleReadSourceCut

    data class Available(
        val liveSource: AgentLiveSourceState,
        val activeSourceEpoch: String,
        val currentSourceAttested: Boolean,
    ) : AgentTranscriptLifecycleReadSourceCut {
        init {
            require(
                liveSource == AgentLiveSourceState.CONNECTED ||
                    liveSource == AgentLiveSourceState.INTERRUPTED,
            ) { "Read source cut has no readable source" }
            requireReadOpaqueId(activeSourceEpoch, "Read source epoch")
        }
    }
}

/** Exact durable cut that every continuation must match before any materialized row is read. */
internal data class AgentTranscriptLifecycleReadRevision(
    val namespace: AgentTranscriptLifecycleDurableNamespace,
    val parentPayloadSha256: String,
    val localGeneration: String,
    val materializedThroughAgentSeq: String,
    val sourceCut: AgentTranscriptLifecycleReadSourceCut,
) {
    init {
        require(namespace.timelineEpoch != null) { "Read revision requires a timeline lineage" }
        require(READ_SHA256.matches(parentPayloadSha256)) { "Read revision hash is malformed" }
        readCounterOrderKey(localGeneration, positive = false)
        readCounterOrderKey(materializedThroughAgentSeq, positive = false)
    }
}

/** A continuation is bound to the complete nine-field namespace and its audited durable cut. */
internal data class AgentTranscriptLifecycleReadCursor(
    val revision: AgentTranscriptLifecycleReadRevision,
    val agentEventSeq: String,
    val recordKind: AgentTranscriptLifecycleReadRecordKind,
    val stableIdentity: String,
) {
    init {
        readCounterOrderKey(agentEventSeq, positive = true)
        requireReadOpaqueId(stableIdentity, "Read cursor stable identity")
    }

    val namespace: AgentTranscriptLifecycleDurableNamespace
        get() = revision.namespace
}

internal data class AgentTranscriptLifecycleReadRequest(
    val selectedNamespace: AgentTranscriptLifecycleDurableNamespace?,
    val access: AgentTranscriptLifecycleReadAccess,
    val cursor: AgentTranscriptLifecycleReadCursor? = null,
    val limit: Int,
) {
    init {
        require(limit in 1..AGENT_TRANSCRIPT_LIFECYCLE_READ_PAGE_LIMIT) {
            "Agent transcript/lifecycle read limit is out of bounds"
        }
    }
}

internal enum class AgentTranscriptLifecycleReadUnavailableReason {
    NO_SELECTED_LINEAGE,
    RELAY_V1,
    EXTENSION_NOT_NEGOTIATED,
    EXTENSION_UNAVAILABLE,
    LINEAGE_NOT_ACTIVE,
    CURSOR_LINEAGE_CHANGED,
    CURSOR_REVISION_CHANGED,
    MATERIALIZED_STATE_INVALID,
    STORE_UNAVAILABLE,
}

internal sealed interface AgentTranscriptEntryContent {
    data class Visible(val text: String) : AgentTranscriptEntryContent
    data class Redacted(val reason: AgentTimelineRedactionReason) : AgentTranscriptEntryContent
}

/**
 * Immutable Agent transcript entry read only after the durable owner has closed its Room row.
 *
 * [commandCorrelationId] is opaque correlation, never mobile Outbox delivery state.
 */
internal data class AgentTranscriptEntryReadModel(
    val entryId: String,
    val runId: String,
    val turnId: String,
    val role: AgentTimelineEntryRole,
    val commandCorrelationId: String?,
    val createdAtMs: Long,
    val createdAgentSeq: String,
    val lastModifiedAgentSeq: String,
    val content: AgentTranscriptEntryContent,
)

/** Lifecycle status exists only in this extension-owned item and has permanent witness evidence. */
internal sealed interface AgentTranscriptLifecycleReadItem {
    val agentEventSeq: String
    val stableIdentity: String
    val recordKind: AgentTranscriptLifecycleReadRecordKind

    data class TranscriptEntry(
        val entry: AgentTranscriptEntryReadModel,
    ) : AgentTranscriptLifecycleReadItem {
        override val agentEventSeq: String = entry.createdAgentSeq
        override val stableIdentity: String = entry.entryId
        override val recordKind = AgentTranscriptLifecycleReadRecordKind.ENTRY
    }

    data class LifecycleEvidence(
        val lifecycle: AgentLifecycleRecord,
    ) : AgentTranscriptLifecycleReadItem {
        override val agentEventSeq: String = lifecycle.agentEventSeq
        override val stableIdentity: String = lifecycle.lifecycleEventId
        override val recordKind = AgentTranscriptLifecycleReadRecordKind.LIFECYCLE
    }
}

/** Self-contained immutable state; [Unavailable] deliberately has no retained page content. */
internal sealed interface AgentTranscriptLifecycleReadState {
    data class Unavailable(
        val reason: AgentTranscriptLifecycleReadUnavailableReason,
    ) : AgentTranscriptLifecycleReadState

    data class Page(
        val revision: AgentTranscriptLifecycleReadRevision,
        val items: List<AgentTranscriptLifecycleReadItem>,
        val nextCursor: AgentTranscriptLifecycleReadCursor?,
        val endReached: Boolean,
    ) : AgentTranscriptLifecycleReadState {
        init {
            require(revision.sourceCut is AgentTranscriptLifecycleReadSourceCut.Available) {
                "A read page requires available source facts"
            }
        }

        val namespace: AgentTranscriptLifecycleDurableNamespace
            get() = revision.namespace
    }
}

/** Narrow read port owned and transactionally implemented by the durable repository. */
internal fun interface AgentTranscriptLifecycleRevisionPinnedReadPort {
    suspend fun readRevisionPinnedPage(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        cursor: AgentTranscriptLifecycleReadCursor?,
        limit: Int,
    ): AgentTranscriptLifecycleRevisionPinnedReadResult
}

internal sealed interface AgentTranscriptLifecycleRevisionPinnedReadResult {
    data object Missing : AgentTranscriptLifecycleRevisionPinnedReadResult
    data object NamespaceChanged : AgentTranscriptLifecycleRevisionPinnedReadResult
    data object ParentUnavailable : AgentTranscriptLifecycleRevisionPinnedReadResult
    data object CursorRevisionChanged : AgentTranscriptLifecycleRevisionPinnedReadResult

    data class Page(
        val revision: AgentTranscriptLifecycleReadRevision,
        val items: List<AgentTranscriptLifecycleReadItem>,
        val nextCursor: AgentTranscriptLifecycleReadCursor?,
        val endReached: Boolean,
    ) : AgentTranscriptLifecycleRevisionPinnedReadResult {
        init {
            require(revision.sourceCut is AgentTranscriptLifecycleReadSourceCut.Available) {
                "A revision-pinned page requires available source facts"
            }
        }
    }
}

/**
 * Bounded candidate sink used while the durable owner continues its complete batch audit.
 *
 * Each audited domain is supplied in its DAO-verified stable order. Keys at/before the cursor and
 * keys after that domain's limit+1 lookahead are discarded before constructing a read model, so a
 * page retains and materializes at most 2 * (limit+1) candidates regardless of durable row count.
 */
internal class AgentTranscriptLifecycleReadCandidateCollector(
    private val cursor: AgentTranscriptLifecycleReadCursor?,
    private val limit: Int,
) {
    private val perDomainCapacity = limit + 1
    private val cursorKey = cursor?.readKey()
    private val transcriptCandidates = ArrayList<AgentTranscriptLifecycleReadItem>(
        perDomainCapacity,
    )
    private val lifecycleCandidates = ArrayList<AgentTranscriptLifecycleReadItem>(
        perDomainCapacity,
    )
    private var lastTranscriptKey: AgentTranscriptLifecycleReadKey? = null
    private var lastLifecycleKey: AgentTranscriptLifecycleReadKey? = null

    internal var materializedCandidateCount: Int = 0
        private set

    internal val retainedCandidateCount: Int
        get() = transcriptCandidates.size + lifecycleCandidates.size

    internal val retainedCandidateHardLimit: Int
        get() = perDomainCapacity * 2

    init {
        require(limit in 1..AGENT_TRANSCRIPT_LIFECYCLE_READ_PAGE_LIMIT)
    }

    internal inline fun considerTranscript(
        key: AgentTranscriptLifecycleReadKey,
        materialize: () -> AgentTranscriptLifecycleReadItem.TranscriptEntry,
    ) {
        lastTranscriptKey = consider(
            key,
            lastTranscriptKey,
            transcriptCandidates,
            materialize,
        )
    }

    internal inline fun considerLifecycle(
        key: AgentTranscriptLifecycleReadKey,
        materialize: () -> AgentTranscriptLifecycleReadItem.LifecycleEvidence,
    ) {
        lastLifecycleKey = consider(
            key,
            lastLifecycleKey,
            lifecycleCandidates,
            materialize,
        )
    }

    private inline fun <T : AgentTranscriptLifecycleReadItem> consider(
        key: AgentTranscriptLifecycleReadKey,
        previousKey: AgentTranscriptLifecycleReadKey?,
        domainCandidates: MutableList<AgentTranscriptLifecycleReadItem>,
        materialize: () -> T,
    ): AgentTranscriptLifecycleReadKey {
        if (previousKey != null && compareReadKeys(previousKey, key) >= 0) malformedReadStore()
        if (cursorKey != null && compareReadKeys(cursorKey, key) >= 0) return key
        if (domainCandidates.size >= perDomainCapacity) return key
        val item = materialize()
        if (item.readKey() != key) malformedReadStore()
        domainCandidates += item
        materializedCandidateCount++
        return key
    }

    internal fun page(
        revision: AgentTranscriptLifecycleReadRevision,
    ): AgentTranscriptLifecycleRevisionPinnedReadResult {
        if (cursor != null && cursor.revision != revision) {
            return AgentTranscriptLifecycleRevisionPinnedReadResult.CursorRevisionChanged
        }
        val lookahead = (transcriptCandidates + lifecycleCandidates)
            .sortedWith { left, right -> compareReadKeys(left.readKey(), right.readKey()) }
            .take(perDomainCapacity)
        val pageItems = lookahead.take(limit).toList()
        val endReached = lookahead.size <= limit
        val nextCursor = if (!endReached) {
            pageItems.last().let { item ->
                AgentTranscriptLifecycleReadCursor(
                    revision = revision,
                    agentEventSeq = item.agentEventSeq,
                    recordKind = item.recordKind,
                    stableIdentity = item.stableIdentity,
                )
            }
        } else {
            null
        }
        return AgentTranscriptLifecycleRevisionPinnedReadResult.Page(
            revision = revision,
            items = pageItems,
            nextCursor = nextCursor,
            endReached = endReached,
        )
    }
}

/** Android-free access fence around the durable owner's revision-pinned port. */
internal class AgentTranscriptLifecycleReadProjectionCore(
    private val durableRead: AgentTranscriptLifecycleRevisionPinnedReadPort,
) {
    suspend fun read(request: AgentTranscriptLifecycleReadRequest): AgentTranscriptLifecycleReadState {
        val namespace = request.selectedNamespace
            ?: return unavailable(AgentTranscriptLifecycleReadUnavailableReason.NO_SELECTED_LINEAGE)
        if (namespace.timelineEpoch == null) {
            return unavailable(AgentTranscriptLifecycleReadUnavailableReason.NO_SELECTED_LINEAGE)
        }
        val access = request.access
        if (access.dialect != AgentTranscriptLifecycleReadDialect.RELAY_V2) {
            return unavailable(AgentTranscriptLifecycleReadUnavailableReason.RELAY_V1)
        }
        if (AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY !in access.negotiatedCapabilities ||
            access.support == AgentExtensionSupport.UNNEGOTIATED
        ) {
            return unavailable(
                AgentTranscriptLifecycleReadUnavailableReason.EXTENSION_NOT_NEGOTIATED,
            )
        }
        if (access.support != AgentExtensionSupport.AVAILABLE) {
            return unavailable(AgentTranscriptLifecycleReadUnavailableReason.EXTENSION_UNAVAILABLE)
        }
        if (access.activeNamespace != namespace) {
            return unavailable(AgentTranscriptLifecycleReadUnavailableReason.LINEAGE_NOT_ACTIVE)
        }
        val cursor = request.cursor
        if (cursor != null && cursor.namespace != namespace) {
            return unavailable(
                AgentTranscriptLifecycleReadUnavailableReason.CURSOR_LINEAGE_CHANGED,
            )
        }

        return when (val result = durableRead.readRevisionPinnedPage(
            namespace,
            cursor,
            request.limit,
        )) {
            AgentTranscriptLifecycleRevisionPinnedReadResult.Missing,
            AgentTranscriptLifecycleRevisionPinnedReadResult.NamespaceChanged,
            AgentTranscriptLifecycleRevisionPinnedReadResult.ParentUnavailable,
            -> unavailable(AgentTranscriptLifecycleReadUnavailableReason.EXTENSION_UNAVAILABLE)
            AgentTranscriptLifecycleRevisionPinnedReadResult.CursorRevisionChanged -> unavailable(
                AgentTranscriptLifecycleReadUnavailableReason.CURSOR_REVISION_CHANGED,
            )
            is AgentTranscriptLifecycleRevisionPinnedReadResult.Page ->
                AgentTranscriptLifecycleReadState.Page(
                    revision = result.revision,
                    items = result.items.toList(),
                    nextCursor = result.nextCursor,
                    endReached = result.endReached,
                )
        }
    }

    private fun unavailable(reason: AgentTranscriptLifecycleReadUnavailableReason) =
        AgentTranscriptLifecycleReadState.Unavailable(reason)
}

/** Room-backed adapter over the caller-owned durable repository instance. */
internal class AgentTranscriptLifecycleRoomReadProjection(
    durableRead: AgentTranscriptLifecycleRevisionPinnedReadPort,
) {
    private val core = AgentTranscriptLifecycleReadProjectionCore(durableRead)

    suspend fun read(
        request: AgentTranscriptLifecycleReadRequest,
    ): AgentTranscriptLifecycleReadState = try {
        core.read(request)
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (_: RelayV2StorageException) {
        AgentTranscriptLifecycleReadState.Unavailable(
            AgentTranscriptLifecycleReadUnavailableReason.MATERIALIZED_STATE_INVALID,
        )
    } catch (_: AgentTranscriptLifecyclePersistenceConflictException) {
        AgentTranscriptLifecycleReadState.Unavailable(
            AgentTranscriptLifecycleReadUnavailableReason.MATERIALIZED_STATE_INVALID,
        )
    } catch (_: Exception) {
        AgentTranscriptLifecycleReadState.Unavailable(
            AgentTranscriptLifecycleReadUnavailableReason.STORE_UNAVAILABLE,
        )
    }
}

internal data class AgentTranscriptLifecycleReadKey(
    val agentEventSeqOrder: String,
    val projectionKind: String,
    val stableIdentity: String,
)

internal fun AgentTranscriptLifecycleReadItem.readKey() = AgentTranscriptLifecycleReadKey(
    readCounterOrderKey(agentEventSeq, positive = true),
    recordKind.storageValue,
    stableIdentity,
)

internal fun AgentTranscriptLifecycleReadCursor.readKey() = AgentTranscriptLifecycleReadKey(
    readCounterOrderKey(agentEventSeq, positive = true),
    recordKind.storageValue,
    stableIdentity,
)

internal fun compareReadKeys(
    left: AgentTranscriptLifecycleReadKey,
    right: AgentTranscriptLifecycleReadKey,
): Int = compareUtf8Binary(left.agentEventSeqOrder, right.agentEventSeqOrder)
    .takeIf { it != 0 }
    ?: compareUtf8Binary(left.projectionKind, right.projectionKind).takeIf { it != 0 }
    ?: compareUtf8Binary(left.stableIdentity, right.stableIdentity)

private fun compareUtf8Binary(left: String, right: String): Int {
    val leftBytes = left.toByteArray(Charsets.UTF_8)
    val rightBytes = right.toByteArray(Charsets.UTF_8)
    for (index in 0 until minOf(leftBytes.size, rightBytes.size)) {
        val compared = (leftBytes[index].toInt() and 0xff) -
            (rightBytes[index].toInt() and 0xff)
        if (compared != 0) return compared
    }
    return leftBytes.size - rightBytes.size
}

internal fun readCounterOrderKey(counter: String, positive: Boolean): String {
    require(READ_CANONICAL_COUNTER.matches(counter)) { "Read sequence is not canonical" }
    require(!positive || counter != "0") { "Read sequence must be positive" }
    require(
        counter.length < READ_UINT64_MAX.length ||
            (counter.length == READ_UINT64_MAX.length && counter <= READ_UINT64_MAX),
    ) { "Read sequence exceeds uint64" }
    return counter.padStart(READ_UINT64_MAX.length, '0')
}

private fun requireReadOpaqueId(value: String, label: String) {
    require(value.isNotEmpty() && value == value.trim() && !value.contains('\u0000')) {
        "$label is malformed"
    }
    require(value.toByteArray(Charsets.UTF_8).size <= READ_MAX_ID_UTF8_BYTES) {
        "$label exceeds the UTF-8 limit"
    }
}

private fun malformedReadStore(): Nothing =
    throw RelayV2StorageException(RelayV2StorageFailure.MALFORMED)

private val READ_CANONICAL_COUNTER = Regex("0|[1-9][0-9]*")
private val READ_SHA256 = Regex("[0-9a-f]{64}")
private const val READ_UINT64_MAX = "18446744073709551615"
private const val READ_MAX_ID_UTF8_BYTES = 128
