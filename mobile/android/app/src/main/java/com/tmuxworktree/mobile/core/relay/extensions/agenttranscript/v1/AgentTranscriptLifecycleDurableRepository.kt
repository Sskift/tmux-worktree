package com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1

import androidx.room.withTransaction
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2AgentTranscriptLifecycleNotificationClaimEntity
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2AgentTranscriptLifecycleStateEntity
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2EncodedPayload
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StorageException
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StorageFailure
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StateDao
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StateDatabase

/** Room adapter for the optional, still-unwired Agent transcript/lifecycle durable consumer. */
internal class AgentTranscriptLifecycleDurableRepository(
    database: RelayV2StateDatabase,
) {
    private val core = AgentTranscriptLifecycleDurableRepositoryCore(
        RoomAgentTranscriptLifecycleDurableStore(database),
    )

    suspend fun load(
        consumer: AgentTranscriptLifecycleDurableConsumerIdentity,
    ): AgentTranscriptLifecycleDurableRecord? = core.load(consumer)

    suspend fun initializeUnderApplyLease(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        state: AgentTranscriptLifecycleClientState,
    ): AgentTranscriptLifecycleInitializeResult =
        core.initializeUnderApplyLease(namespace, state)

    suspend fun reduceUnderApplyLease(
        expectedNamespace: AgentTranscriptLifecycleDurableNamespace,
        input: AgentTranscriptLifecycleClientInput,
        limits: AgentClientReducerLimits = AgentClientReducerLimits(),
    ): AgentTranscriptLifecycleClientReduction =
        core.reduceUnderApplyLease(expectedNamespace, input, limits)

    suspend fun claimNotificationUnderApplyLease(
        expectedNamespace: AgentTranscriptLifecycleDurableNamespace,
        intent: AgentSystemNotificationIntent,
    ): AgentTranscriptLifecycleNotificationClaimResult =
        core.claimNotificationUnderApplyLease(expectedNamespace, intent)
}

private class RoomAgentTranscriptLifecycleDurableStore(
    private val database: RelayV2StateDatabase,
) : AgentTranscriptLifecycleDurableStore {
    private val dao = database.stateDao()

    override suspend fun <T> transaction(
        block: AgentTranscriptLifecycleDurableTransaction.() -> T,
    ): T = database.withTransaction {
        RoomAgentTranscriptLifecycleDurableTransaction(dao).block()
    }
}

private class RoomAgentTranscriptLifecycleDurableTransaction(
    private val dao: RelayV2StateDao,
) : AgentTranscriptLifecycleDurableTransaction {
    override fun states(
        consumer: AgentTranscriptLifecycleDurableConsumerIdentity,
    ): List<AgentTranscriptLifecyclePersistedState> = dao.agentTranscriptLifecycleStates(
        consumer.profileId,
        consumer.profileActivationGeneration,
        consumer.principalId,
        consumer.clientInstanceId,
        consumer.hostId,
        consumer.hostEpoch,
        consumer.scopeId,
        consumer.sessionId,
    ).map(RelayV2AgentTranscriptLifecycleStateEntity::toPersisted)

    override fun deleteConsumer(consumer: AgentTranscriptLifecycleDurableConsumerIdentity) {
        dao.deleteAgentTranscriptLifecycleConsumer(
            consumer.profileId,
            consumer.profileActivationGeneration,
            consumer.principalId,
            consumer.clientInstanceId,
            consumer.hostId,
            consumer.hostEpoch,
            consumer.scopeId,
            consumer.sessionId,
        )
    }

    override fun insertState(state: AgentTranscriptLifecyclePersistedState) {
        dao.insertAgentTranscriptLifecycleState(state.toEntity())
    }

    override fun notificationClaim(
        key: AgentTranscriptLifecycleNotificationClaimKey,
    ): AgentTranscriptLifecyclePersistedNotificationClaim? =
        dao.agentTranscriptLifecycleNotificationClaim(
            key.consumer.profileId,
            key.consumer.profileActivationGeneration,
            key.consumer.principalId,
            key.consumer.clientInstanceId,
            key.consumer.hostId,
            key.consumer.hostEpoch,
            key.consumer.scopeId,
            key.consumer.sessionId,
            key.timelineEpoch,
            key.lifecycleEventId,
            key.lifecycleState.name,
        )?.toPersisted()

    override fun insertNotificationClaim(
        claim: AgentTranscriptLifecyclePersistedNotificationClaim,
    ) {
        dao.insertAgentTranscriptLifecycleNotificationClaim(claim.toEntity())
    }
}

private fun RelayV2AgentTranscriptLifecycleStateEntity.toPersisted():
    AgentTranscriptLifecyclePersistedState {
    val consumer = AgentTranscriptLifecycleDurableConsumerIdentity(
        profileId,
        profileActivationGeneration,
        principalId,
        clientInstanceId,
        hostId,
        hostEpoch,
        scopeId,
        sessionId,
    )
    return AgentTranscriptLifecyclePersistedState(
        AgentTranscriptLifecycleDurableNamespace(
            consumer,
            timelineEpochKey.takeIf(String::isNotEmpty),
        ),
        RelayV2EncodedPayload(
            codecVersion,
            payloadUtf8Bytes,
            payloadCanonicalJson,
            payloadSha256,
        ),
    )
}

private fun AgentTranscriptLifecyclePersistedState.toEntity():
    RelayV2AgentTranscriptLifecycleStateEntity {
    val consumer = namespace.consumer
    return RelayV2AgentTranscriptLifecycleStateEntity(
        profileId = consumer.profileId,
        profileActivationGeneration = consumer.profileActivationGeneration,
        principalId = consumer.principalId,
        clientInstanceId = consumer.clientInstanceId,
        hostId = consumer.hostId,
        hostEpoch = consumer.hostEpoch,
        scopeId = consumer.scopeId,
        sessionId = consumer.sessionId,
        timelineEpochKey = namespace.timelineEpochKey,
        codecVersion = payload.codecVersion,
        payloadUtf8Bytes = payload.payloadUtf8Bytes,
        payloadCanonicalJson = payload.canonicalJson,
        payloadSha256 = payload.sha256,
    )
}

private fun RelayV2AgentTranscriptLifecycleNotificationClaimEntity.toPersisted():
    AgentTranscriptLifecyclePersistedNotificationClaim = try {
        AgentTranscriptLifecyclePersistedNotificationClaim(
            AgentTranscriptLifecycleNotificationClaimKey(
                AgentTranscriptLifecycleDurableConsumerIdentity(
                    profileId,
                    profileActivationGeneration,
                    principalId,
                    clientInstanceId,
                    hostId,
                    hostEpoch,
                    scopeId,
                    sessionId,
                ),
                timelineEpoch,
                lifecycleEventId,
                AgentLifecycleState.valueOf(lifecycleState),
            ),
            claimedLocalGeneration,
            RelayV2EncodedPayload(
                codecVersion,
                payloadUtf8Bytes,
                payloadCanonicalJson,
                payloadSha256,
            ),
        )
    } catch (error: RelayV2StorageException) {
        throw error
    } catch (_: IllegalArgumentException) {
        throw RelayV2StorageException(RelayV2StorageFailure.MALFORMED)
    } catch (_: IllegalStateException) {
        throw RelayV2StorageException(RelayV2StorageFailure.MALFORMED)
    }

private fun AgentTranscriptLifecyclePersistedNotificationClaim.toEntity():
    RelayV2AgentTranscriptLifecycleNotificationClaimEntity {
    val consumer = key.consumer
    return RelayV2AgentTranscriptLifecycleNotificationClaimEntity(
        profileId = consumer.profileId,
        profileActivationGeneration = consumer.profileActivationGeneration,
        principalId = consumer.principalId,
        clientInstanceId = consumer.clientInstanceId,
        hostId = consumer.hostId,
        hostEpoch = consumer.hostEpoch,
        scopeId = consumer.scopeId,
        sessionId = consumer.sessionId,
        timelineEpoch = key.timelineEpoch,
        lifecycleEventId = key.lifecycleEventId,
        lifecycleState = key.lifecycleState.name,
        claimedLocalGeneration = claimedLocalGeneration,
        codecVersion = payload.codecVersion,
        payloadUtf8Bytes = payload.payloadUtf8Bytes,
        payloadCanonicalJson = payload.canonicalJson,
        payloadSha256 = payload.sha256,
    )
}
