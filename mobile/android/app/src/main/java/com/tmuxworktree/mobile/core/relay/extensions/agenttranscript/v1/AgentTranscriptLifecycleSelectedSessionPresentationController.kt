package com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1

import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2MaterializedSessionReadCut
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** Closed page state for one exact selected Relay v2 Session. */
internal sealed interface AgentTranscriptLifecycleSelectedSessionPresentationState {
    data object Disabled : AgentTranscriptLifecycleSelectedSessionPresentationState
    data object Unavailable : AgentTranscriptLifecycleSelectedSessionPresentationState
    data object Stale : AgentTranscriptLifecycleSelectedSessionPresentationState

    /**
     * Structured Agent transcript/lifecycle rows from one revision-pinned durable namespace.
     *
     * Command delivery remains owned by the base command/Outbox domain. This state does not merge
     * it into transcript rows or infer a Session-wide Agent status from lifecycle evidence.
     */
    data class Content(
        val materializedSession: RelayV2MaterializedSessionReadCut,
        val presentation: AgentTranscriptLifecyclePresentation.Page,
    ) : AgentTranscriptLifecycleSelectedSessionPresentationState
}

/** Narrow lower-owner port used to isolate pagination state from actor and Room read mechanics. */
internal fun interface AgentTranscriptLifecycleSelectedSessionPresentationReadPort {
    suspend fun read(
        intent: AgentTranscriptLifecycleSessionSelectionIntent,
        cursor: AgentTranscriptLifecycleReadCursor?,
        limit: Int,
    ): AgentTranscriptLifecycleSelectedSessionReadResult
}

/**
 * Serial owner of the currently presented selected-Session page chain.
 *
 * The first read always starts at a null cursor. Continuations use only the exact cursor retained
 * from the preceding page. The lower selected-Session read controller continues to own actor read
 * leases, durable access and presentation mapping; this owner only validates and aggregates one
 * continuous immutable page chain.
 */
internal class AgentTranscriptLifecycleSelectedSessionPresentationController(
    private val readOwner: AgentTranscriptLifecycleSelectedSessionPresentationReadPort,
    private val pageLimit: Int = AGENT_TRANSCRIPT_LIFECYCLE_READ_PAGE_LIMIT,
) {
    constructor(
        readController: AgentTranscriptLifecycleSelectedSessionReadController,
        pageLimit: Int = AGENT_TRANSCRIPT_LIFECYCLE_READ_PAGE_LIMIT,
    ) : this(
        readOwner = AgentTranscriptLifecycleSelectedSessionPresentationReadPort { intent, cursor, limit ->
            readController.read(intent, cursor, limit)
        },
        pageLimit = pageLimit,
    )

    private val mutex = Mutex()
    private var active: ActivePresentation? = null

    @Volatile
    var state: AgentTranscriptLifecycleSelectedSessionPresentationState =
        AgentTranscriptLifecycleSelectedSessionPresentationState.Unavailable
        private set

    init {
        require(pageLimit in 1..AGENT_TRANSCRIPT_LIFECYCLE_READ_PAGE_LIMIT) {
            "Agent selected-Session presentation page limit is out of bounds"
        }
    }

    suspend fun read(
        intent: AgentTranscriptLifecycleSessionSelectionIntent,
    ): AgentTranscriptLifecycleSelectedSessionPresentationState = mutex.withLock {
        // A fresh selection/read cannot expose the preceding Session while its new owner read is
        // suspended or cancelled.
        clear(AgentTranscriptLifecycleSelectedSessionPresentationState.Unavailable)
        try {
            publishInitial(
                intent,
                readOwner.read(intent, cursor = null, limit = pageLimit),
            )
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            clear(AgentTranscriptLifecycleSelectedSessionPresentationState.Unavailable)
        }
    }

    suspend fun loadMore(): AgentTranscriptLifecycleSelectedSessionPresentationState =
        mutex.withLock {
            val current = active ?: return@withLock state
            val content = current.content
            if (content.presentation.endReached) return@withLock content
            val cursor = content.presentation.nextCursor
                ?: return@withLock clear(
                    AgentTranscriptLifecycleSelectedSessionPresentationState.Unavailable,
                )

            try {
                publishContinuation(
                    current,
                    cursor,
                    readOwner.read(current.intent, cursor, pageLimit),
                )
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                clear(AgentTranscriptLifecycleSelectedSessionPresentationState.Unavailable)
            }
        }

    private fun publishInitial(
        intent: AgentTranscriptLifecycleSessionSelectionIntent,
        result: AgentTranscriptLifecycleSelectedSessionReadResult,
    ): AgentTranscriptLifecycleSelectedSessionPresentationState = when (result) {
        AgentTranscriptLifecycleSelectedSessionReadResult.Disabled ->
            clear(AgentTranscriptLifecycleSelectedSessionPresentationState.Disabled)
        AgentTranscriptLifecycleSelectedSessionReadResult.Unavailable ->
            clear(AgentTranscriptLifecycleSelectedSessionPresentationState.Unavailable)
        AgentTranscriptLifecycleSelectedSessionReadResult.Stale ->
            clear(AgentTranscriptLifecycleSelectedSessionPresentationState.Stale)
        is AgentTranscriptLifecycleSelectedSessionReadResult.Page -> {
            val validated = validatePage(
                page = result.presentation,
                requestedCursor = null,
                existingItemIdentities = emptySet(),
            )
            publish(
                ActivePresentation(
                    intent = intent,
                    content = AgentTranscriptLifecycleSelectedSessionPresentationState.Content(
                        materializedSession = result.materializedSession,
                        presentation = validated.page,
                    ),
                    itemIdentities = validated.itemIdentities,
                ),
            )
        }
    }

    private fun publishContinuation(
        current: ActivePresentation,
        requestedCursor: AgentTranscriptLifecycleReadCursor,
        result: AgentTranscriptLifecycleSelectedSessionReadResult,
    ): AgentTranscriptLifecycleSelectedSessionPresentationState = when (result) {
        AgentTranscriptLifecycleSelectedSessionReadResult.Disabled ->
            clear(AgentTranscriptLifecycleSelectedSessionPresentationState.Disabled)
        AgentTranscriptLifecycleSelectedSessionReadResult.Unavailable ->
            clear(AgentTranscriptLifecycleSelectedSessionPresentationState.Unavailable)
        AgentTranscriptLifecycleSelectedSessionReadResult.Stale ->
            clear(AgentTranscriptLifecycleSelectedSessionPresentationState.Stale)
        is AgentTranscriptLifecycleSelectedSessionReadResult.Page -> {
            val previous = current.content.presentation
            if (result.presentation.namespace != previous.namespace ||
                result.presentation.revision != previous.revision
            ) {
                clear(AgentTranscriptLifecycleSelectedSessionPresentationState.Unavailable)
            } else {
                val validated = validatePage(
                    page = result.presentation,
                    requestedCursor = requestedCursor,
                    existingItemIdentities = current.itemIdentities,
                )
                val combined = validated.page.copy(
                    items = (previous.items + validated.page.items).toList(),
                )
                publish(
                    ActivePresentation(
                        intent = current.intent,
                        content = AgentTranscriptLifecycleSelectedSessionPresentationState.Content(
                            materializedSession = result.materializedSession,
                            presentation = combined,
                        ),
                        itemIdentities = validated.itemIdentities,
                    ),
                )
            }
        }
    }

    private fun validatePage(
        page: AgentTranscriptLifecyclePresentation.Page,
        requestedCursor: AgentTranscriptLifecycleReadCursor?,
        existingItemIdentities: Set<PresentationItemIdentity>,
    ): ValidatedPage {
        if (requestedCursor != null && requestedCursor.revision != page.revision) invalidPage()
        val nextCursor = page.nextCursor
        if (page.endReached != (nextCursor == null)) invalidPage()
        if (nextCursor != null && nextCursor.revision != page.revision) invalidPage()

        val items = page.items.toList()
        if (requestedCursor != null && items.isEmpty()) invalidPage()
        val identities = existingItemIdentities.toMutableSet()
        var previousKey = requestedCursor?.readKey()
        items.forEach { item ->
            val key = item.readKey()
            if (previousKey != null && compareReadKeys(requireNotNull(previousKey), key) >= 0) {
                invalidPage()
            }
            if (!identities.add(item.identity())) invalidPage()
            previousKey = key
        }

        if (nextCursor != null) {
            val nextKey = nextCursor.readKey()
            if (previousKey == null || compareReadKeys(requireNotNull(previousKey), nextKey) != 0) {
                invalidPage()
            }
            if (requestedCursor != null &&
                compareReadKeys(requestedCursor.readKey(), nextKey) >= 0
            ) {
                invalidPage()
            }
        }

        return ValidatedPage(
            page = page.copy(items = items),
            itemIdentities = identities.toSet(),
        )
    }

    private fun publish(
        next: ActivePresentation,
    ): AgentTranscriptLifecycleSelectedSessionPresentationState.Content {
        active = next
        state = next.content
        return next.content
    }

    private fun clear(
        next: AgentTranscriptLifecycleSelectedSessionPresentationState,
    ): AgentTranscriptLifecycleSelectedSessionPresentationState {
        active = null
        state = next
        return next
    }
}

private data class ActivePresentation(
    val intent: AgentTranscriptLifecycleSessionSelectionIntent,
    val content: AgentTranscriptLifecycleSelectedSessionPresentationState.Content,
    val itemIdentities: Set<PresentationItemIdentity>,
)

private data class ValidatedPage(
    val page: AgentTranscriptLifecyclePresentation.Page,
    val itemIdentities: Set<PresentationItemIdentity>,
)

private data class PresentationItemIdentity(
    val kind: AgentTranscriptLifecycleReadRecordKind,
    val stableIdentity: String,
)

private fun AgentTranscriptLifecyclePresentationItem.identity(): PresentationItemIdentity =
    when (this) {
        is AgentTranscriptLifecyclePresentationItem.Transcript -> PresentationItemIdentity(
            AgentTranscriptLifecycleReadRecordKind.ENTRY,
            entryId,
        )
        is AgentTranscriptLifecyclePresentationItem.Lifecycle -> PresentationItemIdentity(
            AgentTranscriptLifecycleReadRecordKind.LIFECYCLE,
            lifecycleEventId,
        )
    }

private fun AgentTranscriptLifecyclePresentationItem.readKey(): AgentTranscriptLifecycleReadKey =
    when (this) {
        is AgentTranscriptLifecyclePresentationItem.Transcript -> AgentTranscriptLifecycleReadKey(
            agentEventSeqOrder = readCounterOrderKey(createdAgentSeq, positive = true),
            projectionKind = AgentTranscriptLifecycleReadRecordKind.ENTRY.storageValue,
            stableIdentity = entryId,
        )
        is AgentTranscriptLifecyclePresentationItem.Lifecycle -> AgentTranscriptLifecycleReadKey(
            agentEventSeqOrder = readCounterOrderKey(agentEventSeq, positive = true),
            projectionKind = AgentTranscriptLifecycleReadRecordKind.LIFECYCLE.storageValue,
            stableIdentity = lifecycleEventId,
        )
    }

private fun invalidPage(): Nothing =
    throw IllegalStateException("Selected-Session presentation page is not continuous")
