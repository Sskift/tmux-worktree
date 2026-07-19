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

/**
 * Capability- and lineage-fenced lifecycle/notification presentation of the optional Agent
 * extension.
 *
 * This reducer-backed mapper remains only for the isolated notification preflight foundation. It
 * is not a Session detail/Inbox read source; future screen state must use the Room-backed
 * [AgentTranscriptLifecyclePresentationMapper] above.
 *
 * [Unavailable] intentionally carries no cached data or reason. A caller that has not negotiated
 * the capability, selected another Session, or moved to another active lineage must not learn
 * anything from a retained reducer state.
 *
 * This model intentionally does not expose transcript items: the current client reducer does not
 * materialize structured text entries, so it cannot prove a transcript.
 */
internal sealed interface AgentLifecycleNotificationPresentation {
    data object Unavailable : AgentLifecycleNotificationPresentation

    data class Available(
        val runLifecycles: List<AgentLifecyclePresentation>,
        val turnLifecycles: List<AgentLifecyclePresentation>,
        val preflightNotificationCandidates: List<AgentNotificationIntentPresentation>,
    ) : AgentLifecycleNotificationPresentation
}

internal data class AgentLifecyclePresentation(
    val identity: AgentLifecycleIdentity,
    val lifecycleEventId: String,
    val sourceEpoch: String,
    val state: AgentLifecycleState,
    val agentEventSeq: String,
    val isCurrentSource: Boolean,
)

/**
 * A safe, content-free notification presentation whose preflight was authorized while mapping.
 *
 * This is not a durable one-shot claim. A future executor must still claim and revalidate the
 * [systemIntent] transactionally before invoking the platform notification API.
 */
internal data class AgentNotificationIntentPresentation(
    val systemIntent: AgentSystemNotificationIntent,
    val lifecycleIdentity: AgentLifecycleIdentity,
    val lifecycleState: AgentLifecycleState,
)

internal object AgentLifecycleNotificationPresentationMapper {
    fun map(
        clientState: AgentTranscriptLifecycleClientState,
        negotiatedCapabilities: Set<String>,
        activeLineage: AgentTimelineLineage?,
        selectedSession: AgentExtensionSessionIdentity?,
    ): AgentLifecycleNotificationPresentation {
        val extension = clientState.extensionLane
        val timelineEpoch = extension.timelineEpoch
            ?: return AgentLifecycleNotificationPresentation.Unavailable
        val expectedLineage = AgentTimelineLineage(clientState.identity, timelineEpoch)
        if (AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY !in negotiatedCapabilities ||
            selectedSession != clientState.identity ||
            activeLineage != expectedLineage ||
            extension.support != AgentExtensionSupport.AVAILABLE ||
            extension.requiresSnapshot ||
            extension.requiresTimelineRotation
        ) {
            return AgentLifecycleNotificationPresentation.Unavailable
        }

        val lifecyclePresentations = extension.lifecycleByIdentity.values
            .map { record ->
                AgentLifecyclePresentation(
                    identity = record.identity,
                    lifecycleEventId = record.lifecycleEventId,
                    sourceEpoch = record.sourceEpoch,
                    state = record.state,
                    agentEventSeq = record.agentEventSeq,
                    isCurrentSource =
                        extension.currentSourceLifecycleOrNull(record.identity) == record,
                )
            }

        val runs = lifecyclePresentations
            .filter { it.identity.scope == AgentLifecycleScope.RUN }
            .sortedWith(compareBy({ it.identity.runId }, { it.lifecycleEventId }))
        val turns = lifecyclePresentations
            .filter { it.identity.scope == AgentLifecycleScope.TURN }
            .sortedWith(
                compareBy(
                    { it.identity.runId },
                    { it.identity.turnId },
                    { it.lifecycleEventId },
                ),
            )
        val preflightNotificationCandidates = extension.notificationLedger.entries
            .mapNotNull { (dedupeKey, ledgerEntry) ->
                if (ledgerEntry.disposition != AgentNotificationDisposition.SHOWN) {
                    return@mapNotNull null
                }
                val systemIntent = AgentSystemNotificationIntent(
                    dedupeKey = dedupeKey,
                    localGeneration = ledgerEntry.localGeneration,
                )
                if (!systemIntent.isPreflightAuthorizedBy(clientState)) {
                    return@mapNotNull null
                }
                AgentNotificationIntentPresentation(
                    systemIntent = systemIntent,
                    lifecycleIdentity = ledgerEntry.eventIdentity.lifecycleIdentity,
                    lifecycleState = ledgerEntry.eventIdentity.state,
                )
            }
            .sortedWith(
                compareBy(
                    { it.lifecycleIdentity.runId },
                    { it.lifecycleIdentity.scope.ordinal },
                    { it.lifecycleIdentity.turnId },
                    { it.systemIntent.dedupeKey.lifecycleEventId },
                ),
            )

        return AgentLifecycleNotificationPresentation.Available(
            runLifecycles = runs,
            turnLifecycles = turns,
            preflightNotificationCandidates = preflightNotificationCandidates,
        )
    }
}
