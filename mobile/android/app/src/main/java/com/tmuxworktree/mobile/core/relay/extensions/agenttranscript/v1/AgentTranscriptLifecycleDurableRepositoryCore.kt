package com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1

import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2EncodedPayload

/** Stable consumer slot before the host-issued Agent timeline lineage is selected. */
internal data class AgentTranscriptLifecycleDurableConsumerIdentity(
    val profileId: String,
    val profileActivationGeneration: Long,
    val principalId: String,
    val clientInstanceId: String,
    val hostId: String,
    val hostEpoch: String,
    val scopeId: String,
    val sessionId: String,
) {
    init {
        require(profileActivationGeneration > 0) { "Profile activation generation must be positive" }
        requireOpaqueId(profileId, "Profile ID")
        requireOpaqueId(principalId, "Principal ID")
        requireOpaqueId(clientInstanceId, "Client instance ID")
        requireOpaqueId(hostId, "Host ID")
        requireOpaqueId(hostEpoch, "Host epoch")
        requireOpaqueId(scopeId, "Scope ID")
        requireOpaqueId(sessionId, "Session ID")
    }

    val sessionIdentity: AgentExtensionSessionIdentity
        get() = AgentExtensionSessionIdentity(profileId, hostId, hostEpoch, scopeId, sessionId)
}

/** Complete durable namespace, including the nullable current Agent timeline lineage. */
internal data class AgentTranscriptLifecycleDurableNamespace(
    val consumer: AgentTranscriptLifecycleDurableConsumerIdentity,
    val timelineEpoch: String?,
) {
    init {
        timelineEpoch?.let { AgentTimelineLineage(consumer.sessionIdentity, it) }
    }

    val timelineEpochKey: String
        get() = timelineEpoch.orEmpty()

    companion object {
        fun from(
            consumer: AgentTranscriptLifecycleDurableConsumerIdentity,
            state: AgentTranscriptLifecycleClientState,
        ): AgentTranscriptLifecycleDurableNamespace {
            require(state.identity == consumer.sessionIdentity) {
                "Agent durable consumer identity does not match reducer state"
            }
            return AgentTranscriptLifecycleDurableNamespace(
                consumer,
                state.extensionLane.timelineEpoch,
            )
        }
    }
}

internal data class AgentTranscriptLifecyclePersistedState(
    val namespace: AgentTranscriptLifecycleDurableNamespace,
    val payload: RelayV2EncodedPayload,
)

internal data class AgentTranscriptLifecycleDurableRecord(
    val namespace: AgentTranscriptLifecycleDurableNamespace,
    val state: AgentTranscriptLifecycleClientState,
)

internal enum class AgentTranscriptLifecycleInitializeDisposition {
    CREATED,
    UNCHANGED,
}

internal data class AgentTranscriptLifecycleInitializeResult(
    val record: AgentTranscriptLifecycleDurableRecord,
    val disposition: AgentTranscriptLifecycleInitializeDisposition,
)

internal class AgentTranscriptLifecyclePersistenceConflictException :
    IllegalStateException("Agent transcript/lifecycle persisted state conflicts")

internal class AgentTranscriptLifecyclePersistenceMissingException :
    IllegalStateException("Agent transcript/lifecycle persisted state is missing")

/** Transaction port implemented by Room in production and copy-on-write memory stores in tests. */
internal interface AgentTranscriptLifecycleDurableStore {
    suspend fun <T> transaction(block: AgentTranscriptLifecycleDurableTransaction.() -> T): T
}

internal interface AgentTranscriptLifecycleDurableTransaction {
    fun states(
        consumer: AgentTranscriptLifecycleDurableConsumerIdentity,
    ): List<AgentTranscriptLifecyclePersistedState>

    fun deleteConsumer(consumer: AgentTranscriptLifecycleDurableConsumerIdentity)

    fun insertState(state: AgentTranscriptLifecyclePersistedState)
}

/**
 * Atomic persistence owner for the optional Agent reducer.
 *
 * The caller must hold the future actor apply lease. This core deliberately has no actor, socket,
 * notification executor, or capability-advertisement dependency.
 */
internal class AgentTranscriptLifecycleDurableRepositoryCore(
    private val store: AgentTranscriptLifecycleDurableStore,
) {
    suspend fun load(
        consumer: AgentTranscriptLifecycleDurableConsumerIdentity,
    ): AgentTranscriptLifecycleDurableRecord? = store.transaction {
        loadSingle(consumer)
    }

    suspend fun initializeUnderApplyLease(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        state: AgentTranscriptLifecycleClientState,
    ): AgentTranscriptLifecycleInitializeResult = store.transaction {
        requireNamespaceState(namespace, state)
        val existing = loadSingle(namespace.consumer)
        if (existing != null) {
            if (existing.namespace == namespace && existing.state == state) {
                return@transaction AgentTranscriptLifecycleInitializeResult(
                    existing,
                    AgentTranscriptLifecycleInitializeDisposition.UNCHANGED,
                )
            }
            throw AgentTranscriptLifecyclePersistenceConflictException()
        }
        val persisted = AgentTranscriptLifecyclePersistedState(
            namespace,
            AgentTranscriptLifecycleDurableStateCodec.encode(namespace, state),
        )
        insertState(persisted)
        AgentTranscriptLifecycleInitializeResult(
            AgentTranscriptLifecycleDurableRecord(namespace, state),
            AgentTranscriptLifecycleInitializeDisposition.CREATED,
        )
    }

    suspend fun reduceUnderApplyLease(
        expectedNamespace: AgentTranscriptLifecycleDurableNamespace,
        input: AgentTranscriptLifecycleClientInput,
        limits: AgentClientReducerLimits = AgentClientReducerLimits(),
    ): AgentTranscriptLifecycleClientReduction = store.transaction {
        val current = loadSingle(expectedNamespace.consumer)
            ?: throw AgentTranscriptLifecyclePersistenceMissingException()
        if (current.namespace != expectedNamespace) {
            throw AgentTranscriptLifecyclePersistenceConflictException()
        }

        val reduction = AgentTranscriptLifecycleClientReducer.reduce(current.state, input, limits)
        val nextNamespace = AgentTranscriptLifecycleDurableNamespace.from(
            expectedNamespace.consumer,
            reduction.state,
        )
        requireNamespaceState(nextNamespace, reduction.state)
        if (current.namespace == nextNamespace && current.state == reduction.state) {
            return@transaction reduction
        }

        val replacement = AgentTranscriptLifecyclePersistedState(
            nextNamespace,
            AgentTranscriptLifecycleDurableStateCodec.encode(nextNamespace, reduction.state),
        )
        // Timeline rotation changes the physical primary key. Delete+insert remains one transaction.
        deleteConsumer(expectedNamespace.consumer)
        insertState(replacement)
        reduction
    }

    private fun AgentTranscriptLifecycleDurableTransaction.loadSingle(
        consumer: AgentTranscriptLifecycleDurableConsumerIdentity,
    ): AgentTranscriptLifecycleDurableRecord? {
        val rows = states(consumer)
        if (rows.size > 1) throw AgentTranscriptLifecyclePersistenceConflictException()
        val row = rows.singleOrNull() ?: return null
        if (row.namespace.consumer != consumer) {
            throw AgentTranscriptLifecyclePersistenceConflictException()
        }
        val state = AgentTranscriptLifecycleDurableStateCodec.decode(row.namespace, row.payload)
        requireNamespaceState(row.namespace, state)
        return AgentTranscriptLifecycleDurableRecord(row.namespace, state)
    }

    private fun requireNamespaceState(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        state: AgentTranscriptLifecycleClientState,
    ) {
        if (state.identity != namespace.consumer.sessionIdentity ||
            state.extensionLane.timelineEpoch != namespace.timelineEpoch
        ) {
            throw AgentTranscriptLifecyclePersistenceConflictException()
        }
    }
}
