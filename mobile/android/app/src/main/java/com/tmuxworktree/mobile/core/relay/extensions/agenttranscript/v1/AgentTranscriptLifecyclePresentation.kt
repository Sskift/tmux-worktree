package com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1

internal const val AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY =
    "agent.transcript-lifecycle.v1"

/**
 * Capability- and lineage-fenced lifecycle/notification presentation of the optional Agent
 * extension.
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
        val authorizedNotificationIntents: List<AgentNotificationIntentPresentation>,
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
        val notificationIntents = extension.notificationLedger.entries
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
            authorizedNotificationIntents = notificationIntents,
        )
    }
}
