package com.tmuxworktree.mobile.core.data

import androidx.room.withTransaction
import com.tmuxworktree.mobile.core.model.DeliveryState
import com.tmuxworktree.mobile.core.model.OutboxMessage
import com.tmuxworktree.mobile.core.model.RelayHost
import com.tmuxworktree.mobile.core.model.RelayScope
import com.tmuxworktree.mobile.core.model.RelaySession
import com.tmuxworktree.mobile.core.model.TimelineActor
import com.tmuxworktree.mobile.core.model.TimelineEvent
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.withContext

class TwRepository(
    private val database: TwDatabase,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val dao = database.twDao()

    val hosts: Flow<List<RelayHost>> = dao.observeHosts().map { rows -> rows.map(HostEntity::toDomain) }
    val scopes: Flow<List<RelayScope>> = dao.observeScopes().map { rows -> rows.map(ScopeEntity::toDomain) }
    val sessions: Flow<List<RelaySession>> = dao.observeSessions().map { rows -> rows.map(SessionEntity::toDomain) }
    val outbox: Flow<List<OutboxMessage>> = dao.observeOutbox().map { rows -> rows.map(OutboxEntity::toDomain) }

    fun timeline(sessionId: String): Flow<List<TimelineEvent>> =
        dao.observeTimeline(sessionId).map { rows -> rows.map(TimelineEntity::toDomain) }

    suspend fun replaceHosts(hosts: List<RelayHost>) = database.withTransaction {
        if (hosts.isEmpty()) {
            dao.deleteAllSessions()
            dao.deleteAllScopes()
            dao.deleteAllHosts()
        } else {
            val retainedHostIds = hosts.map(RelayHost::hostId).distinct()
            dao.upsertHosts(hosts.map(RelayHost::toEntity))
            dao.deleteSessionsForHostsNotIn(retainedHostIds)
            dao.deleteScopesForHostsNotIn(retainedHostIds)
            dao.deleteHostsNotIn(retainedHostIds)
        }
    }

    suspend fun replaceScopes(hostId: String, scopes: List<RelayScope>) = database.withTransaction {
        dao.deleteScopesForHost(hostId)
        if (scopes.isNotEmpty()) dao.upsertScopes(scopes.map(RelayScope::toEntity))
    }

    suspend fun replaceSessions(hostId: String, sessions: List<RelaySession>) = database.withTransaction {
        dao.deleteSessionsForHost(hostId)
        val cachedAt = clock()
        if (sessions.isNotEmpty()) dao.upsertSessions(sessions.map { it.toEntity(cachedAt) })
    }

    suspend fun upsertSession(session: RelaySession) {
        dao.upsertSession(session.toEntity(clock()))
    }

    suspend fun removeSession(hostId: String, name: String) {
        dao.deleteSession(hostId, name)
    }

    suspend fun enqueueAgentMessage(
        hostId: String,
        sessionName: String,
        body: String,
        ttlMillis: Long = DEFAULT_MESSAGE_TTL_MILLIS,
    ): OutboxMessage {
        require(body.isNotBlank()) { "Message cannot be blank" }
        val now = clock()
        val commandId = UUID.randomUUID().toString()
        val message = OutboxMessage(
            commandId = commandId,
            requestId = "agent-$commandId",
            hostId = hostId,
            sessionName = sessionName,
            body = body,
            createdAtMillis = now,
            expiresAtMillis = now + ttlMillis,
        )
        val timeline = TimelineEvent(
            eventId = "outbox-$commandId",
            sessionId = "$hostId:$sessionName",
            actor = TimelineActor.USER,
            body = body,
            createdAtMillis = now,
            deliveryState = DeliveryState.QUEUED,
        )
        database.withTransaction {
            dao.insertOutbox(message.toEntity())
            dao.upsertTimeline(timeline.toEntity())
        }
        return message
    }

    suspend fun transitionOutbox(
        commandId: String,
        next: DeliveryState,
        error: String = "",
    ): Boolean = database.withTransaction {
        val current = dao.findOutbox(commandId) ?: return@withTransaction false
        val currentState = current.toDomain().state
        require(next in allowedTransitions.getValue(currentState)) {
            "Invalid outbox transition: $currentState -> $next"
        }
        val attempt = current.attemptCount + if (next == DeliveryState.SENDING) 1 else 0
        val updated = dao.updateOutboxState(commandId, next.name, attempt, error) == 1
        if (updated) {
            dao.upsertTimeline(
                TimelineEvent(
                    eventId = "outbox-$commandId",
                    sessionId = "${current.hostId}:${current.sessionName}",
                    actor = TimelineActor.USER,
                    body = current.body,
                    createdAtMillis = current.createdAtMillis,
                    deliveryState = next,
                ).toEntity(),
            )
        }
        updated
    }

    suspend fun pendingOutbox(): List<OutboxMessage> = database.withTransaction {
        val now = clock()
        // Mirror state into the visible timeline in the same transaction so the
        // user never sees a queued message that has already expired.
        dao.expireOutboxTimeline(now)
        dao.expireOutbox(now)
        dao.pendingOutbox(
            states = listOf(
                DeliveryState.QUEUED.name,
                DeliveryState.SENDING.name,
                DeliveryState.ACCEPTED.name,
                DeliveryState.CONFIRMING.name,
                DeliveryState.FAILED_RETRYABLE.name,
                DeliveryState.AMBIGUOUS.name,
            ),
            nowMillis = now,
        ).map(OutboxEntity::toDomain)
    }

    /**
     * Expires messages even while the relay is offline and no send flush runs.
     * The outbox row and user-visible timeline always change atomically.
     */
    suspend fun expireOutboxMessages(): Int = database.withTransaction {
        val now = clock()
        dao.expireOutboxTimeline(now)
        dao.expireOutbox(now)
    }

    /**
     * Cancels local delivery tracking when no write is currently in flight.
     * For AMBIGUOUS/ACCEPTED/CONFIRMING this does not recall a remote command;
     * it only records that the user chose to stop waiting for confirmation.
     */
    suspend fun cancelOutboxMessage(commandId: String): Boolean = database.withTransaction {
        val current = dao.findOutbox(commandId) ?: return@withTransaction false
        val currentState = current.toDomain().state
        if (DeliveryState.CANCELLED !in allowedTransitions.getValue(currentState)) {
            return@withTransaction false
        }
        updateCancelledState(current)
    }

    suspend fun cancelQueuedMessage(commandId: String): Boolean = database.withTransaction {
        val current = dao.findOutbox(commandId) ?: return@withTransaction false
        if (current.state != DeliveryState.QUEUED.name) return@withTransaction false
        updateCancelledState(current)
    }

    suspend fun appendTimeline(event: TimelineEvent) {
        dao.upsertTimeline(event.toEntity())
    }

    suspend fun saveStreamCheckpoint(checkpoint: StreamCheckpointEntity) {
        dao.upsertStreamCheckpoint(checkpoint)
    }

    suspend fun streamCheckpoint(streamId: String): StreamCheckpointEntity? =
        dao.findStreamCheckpoint(streamId)

    /** All cached metadata and queued bodies are scoped to one relay pairing. */
    suspend fun clearProfileData() = withContext(Dispatchers.IO) {
        database.clearAllTables()
    }

    private suspend fun updateCancelledState(current: OutboxEntity): Boolean {
        val updated = dao.updateOutboxState(
            commandId = current.commandId,
            state = DeliveryState.CANCELLED.name,
            attemptCount = current.attemptCount,
            lastError = "",
        ) == 1
        if (updated) {
            dao.upsertTimeline(
                TimelineEvent(
                    eventId = "outbox-${current.commandId}",
                    sessionId = "${current.hostId}:${current.sessionName}",
                    actor = TimelineActor.USER,
                    body = current.body,
                    createdAtMillis = current.createdAtMillis,
                    deliveryState = DeliveryState.CANCELLED,
                ).toEntity(),
            )
        }
        return updated
    }

    companion object {
        const val DEFAULT_MESSAGE_TTL_MILLIS = 15 * 60 * 1000L

        private val allowedTransitions: Map<DeliveryState, Set<DeliveryState>> = mapOf(
            DeliveryState.QUEUED to setOf(DeliveryState.SENDING, DeliveryState.CANCELLED, DeliveryState.EXPIRED),
            DeliveryState.SENDING to setOf(
                DeliveryState.ACCEPTED,
                DeliveryState.SUCCEEDED,
                DeliveryState.FAILED_RETRYABLE,
                DeliveryState.FAILED_FINAL,
                DeliveryState.AMBIGUOUS,
            ),
            DeliveryState.ACCEPTED to setOf(
                DeliveryState.SUCCEEDED,
                DeliveryState.CONFIRMING,
                DeliveryState.FAILED_FINAL,
                DeliveryState.AMBIGUOUS,
                DeliveryState.EXPIRED,
                DeliveryState.CANCELLED,
            ),
            DeliveryState.CONFIRMING to setOf(
                DeliveryState.SUCCEEDED,
                DeliveryState.FAILED_RETRYABLE,
                DeliveryState.FAILED_FINAL,
                DeliveryState.AMBIGUOUS,
                DeliveryState.EXPIRED,
                DeliveryState.CANCELLED,
            ),
            DeliveryState.FAILED_RETRYABLE to setOf(DeliveryState.SENDING, DeliveryState.EXPIRED, DeliveryState.CANCELLED),
            DeliveryState.AMBIGUOUS to setOf(
                DeliveryState.CONFIRMING,
                DeliveryState.SUCCEEDED,
                DeliveryState.FAILED_FINAL,
                DeliveryState.EXPIRED,
                DeliveryState.CANCELLED,
            ),
            DeliveryState.SUCCEEDED to emptySet(),
            DeliveryState.FAILED_FINAL to emptySet(),
            DeliveryState.EXPIRED to emptySet(),
            DeliveryState.CANCELLED to emptySet(),
        )
    }
}
