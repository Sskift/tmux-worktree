package com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1

internal const val AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY =
    "agent.transcript-lifecycle.v1"

/**
 * Immutable UI-domain foundation for a future ViewModel.
 *
 * This is intentionally not wired to Compose and does not determine capability availability. It
 * can expose content only when the Room read projection has already returned an exact-lineage
 * page. Mobile Outbox delivery remains the separate base-command domain; a transcript command ID
 * below is correlation only, while Waiting/Failed/Completed can occur only on [Lifecycle].
 * Current-source presentation is derived only from the source attestation carried by that same
 * audited durable read cut.
 */
internal sealed interface AgentTranscriptLifecyclePresentation {
    data object Unavailable : AgentTranscriptLifecyclePresentation

    data class Page(
        val revision: AgentTranscriptLifecycleReadRevision,
        val items: List<AgentTranscriptLifecyclePresentationItem>,
        val nextCursor: AgentTranscriptLifecycleReadCursor?,
        val endReached: Boolean,
    ) : AgentTranscriptLifecyclePresentation {
        val namespace: AgentTranscriptLifecycleDurableNamespace
            get() = revision.namespace
    }
}

internal sealed interface AgentTranscriptLifecyclePresentationItem {
    data class Transcript(
        val entryId: String,
        val runId: String,
        val turnId: String,
        val role: AgentTimelineEntryRole,
        val commandCorrelationId: String?,
        val createdAtMs: Long,
        val createdAgentSeq: String,
        val lastModifiedAgentSeq: String,
        val content: AgentTranscriptEntryContent,
    ) : AgentTranscriptLifecyclePresentationItem

    data class Lifecycle(
        val identity: AgentLifecycleIdentity,
        val lifecycleEventId: String,
        val sourceEpoch: String,
        val state: AgentLifecycleState,
        val failure: AgentLifecycleFailure?,
        val occurredAtMs: Long,
        val agentEventSeq: String,
        val isCurrentSource: Boolean,
    ) : AgentTranscriptLifecyclePresentationItem
}

internal object AgentTranscriptLifecyclePresentationMapper {
    fun map(
        state: AgentTranscriptLifecycleReadState,
    ): AgentTranscriptLifecyclePresentation = when (state) {
        is AgentTranscriptLifecycleReadState.Unavailable ->
            AgentTranscriptLifecyclePresentation.Unavailable
        is AgentTranscriptLifecycleReadState.Page -> {
            val sourceCut = state.revision.sourceCut
            AgentTranscriptLifecyclePresentation.Page(
                revision = state.revision,
                items = state.items.map { item ->
                    when (item) {
                        is AgentTranscriptLifecycleReadItem.TranscriptEntry -> {
                            val entry = item.entry
                            AgentTranscriptLifecyclePresentationItem.Transcript(
                                entryId = entry.entryId,
                                runId = entry.runId,
                                turnId = entry.turnId,
                                role = entry.role,
                                commandCorrelationId = entry.commandCorrelationId,
                                createdAtMs = entry.createdAtMs,
                                createdAgentSeq = entry.createdAgentSeq,
                                lastModifiedAgentSeq = entry.lastModifiedAgentSeq,
                                content = entry.content,
                            )
                        }
                        is AgentTranscriptLifecycleReadItem.LifecycleEvidence -> {
                            val lifecycle = item.lifecycle
                            AgentTranscriptLifecyclePresentationItem.Lifecycle(
                                identity = lifecycle.identity,
                                lifecycleEventId = lifecycle.lifecycleEventId,
                                sourceEpoch = lifecycle.sourceEpoch,
                                state = lifecycle.state,
                                failure = lifecycle.failure,
                                occurredAtMs = lifecycle.occurredAtMs,
                                agentEventSeq = lifecycle.agentEventSeq,
                                isCurrentSource =
                                    sourceCut is AgentTranscriptLifecycleReadSourceCut.Available &&
                                        sourceCut.currentSourceAttested &&
                                        sourceCut.liveSource == AgentLiveSourceState.CONNECTED &&
                                        lifecycle.sourceEpoch == sourceCut.activeSourceEpoch,
                            )
                        }
                    }
                }.toList(),
                nextCursor = state.nextCursor,
                endReached = state.endReached,
            )
        }
    }
}
