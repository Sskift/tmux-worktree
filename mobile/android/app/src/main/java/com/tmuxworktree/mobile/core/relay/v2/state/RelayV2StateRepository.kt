package com.tmuxworktree.mobile.core.relay.v2.state

import androidx.room.withTransaction
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayProfileDisconnectReceipt

/**
 * Unwired Room-backed Relay v2 state synchronization repository.
 *
 * Every generation-scoped method must be called while the caller holds the actor apply lease. The
 * method then keeps the complete reducer operation inside one Room transaction. No method consults
 * `matchesGeneration`, connects a socket, touches the v1 database, or clears credentials.
 */
internal class RelayV2StateRepository(
    database: RelayV2StateDatabase,
) {
    private val core = RelayV2StateSyncRepositoryCore(RoomRelayV2StateStore(database))

    suspend fun applyHelloUnderApplyLease(hello: RelayV2StateHello): RelayV2StateSyncResult =
        core.applyHelloUnderApplyLease(hello)

    suspend fun stageSnapshotChunkUnderApplyLease(
        chunk: RelayV2SnapshotChunk,
    ): RelayV2StateSyncResult = core.stageSnapshotChunkUnderApplyLease(chunk)

    suspend fun applyStateEventUnderApplyLease(
        event: RelayV2StateEvent,
    ): RelayV2StateSyncResult = core.applyStateEventUnderApplyLease(event)

    suspend fun commitSnapshotUnderApplyLease(
        namespace: RelayV2StateNamespace,
        snapshotId: String,
    ): RelayV2StateSyncResult = core.commitSnapshotUnderApplyLease(namespace, snapshotId)

    suspend fun discardSnapshotUnderApplyLease(
        namespace: RelayV2StateNamespace,
    ): RelayV2SnapshotReleaseDirective? = core.discardSnapshotUnderApplyLease(namespace)

    suspend fun clearProfileAfterDisconnect(receipt: RelayProfileDisconnectReceipt) =
        core.clearProfileAfterDisconnect(receipt)
}

private class RoomRelayV2StateStore(
    private val database: RelayV2StateDatabase,
) : RelayV2StateStore {
    private val dao = database.stateDao()

    override suspend fun <T> transaction(block: RelayV2StateTransaction.() -> T): T =
        database.withTransaction { RoomTransaction(dao).block() }
}

private class RoomTransaction(
    private val dao: RelayV2StateDao,
) : RelayV2StateTransaction {
    override fun authority(namespace: RelayV2StateNamespace): RelayV2StoredAuthority? =
        dao.authority(
            namespace.profileId,
            namespace.principalId,
            namespace.clientInstanceId,
            namespace.hostId,
            namespace.hostEpoch,
        )?.toStored()

    override fun putAuthority(authority: RelayV2StoredAuthority) {
        dao.putAuthority(authority.toEntity())
    }

    override fun deleteNamespaceState(namespace: RelayV2StateNamespace) {
        deleteBufferedEvents(namespace)
        dao.deleteSnapshotRecords(
            namespace.profileId,
            namespace.principalId,
            namespace.clientInstanceId,
            namespace.hostId,
            namespace.hostEpoch,
        )
        dao.deleteSnapshot(
            namespace.profileId,
            namespace.principalId,
            namespace.clientInstanceId,
            namespace.hostId,
            namespace.hostEpoch,
        )
        deleteSessions(namespace)
        deleteScopes(namespace)
        dao.deleteNamespaceAuthority(
            namespace.profileId,
            namespace.principalId,
            namespace.clientInstanceId,
            namespace.hostId,
            namespace.hostEpoch,
        )
    }

    override fun deleteProfileState(profileId: String) {
        dao.deleteProfileEvents(profileId)
        dao.deleteProfileSnapshotRecords(profileId)
        dao.deleteProfileSnapshots(profileId)
        dao.deleteProfileSessions(profileId)
        dao.deleteProfileScopes(profileId)
        dao.deleteProfileAuthorities(profileId)
    }

    override fun scope(namespace: RelayV2StateNamespace, scopeId: String): RelayV2StoredScope? =
        dao.scope(
            namespace.profileId,
            namespace.principalId,
            namespace.clientInstanceId,
            namespace.hostId,
            namespace.hostEpoch,
            scopeId,
        )?.toStored()

    override fun putScope(scope: RelayV2StoredScope) {
        dao.putScope(scope.toEntity())
    }

    override fun deleteScope(namespace: RelayV2StateNamespace, scopeId: String) {
        dao.deleteScope(
            namespace.profileId,
            namespace.principalId,
            namespace.clientInstanceId,
            namespace.hostId,
            namespace.hostEpoch,
            scopeId,
        )
    }

    override fun deleteScopes(namespace: RelayV2StateNamespace) {
        dao.deleteScopes(
            namespace.profileId,
            namespace.principalId,
            namespace.clientInstanceId,
            namespace.hostId,
            namespace.hostEpoch,
        )
    }

    override fun session(
        namespace: RelayV2StateNamespace,
        scopeId: String,
        sessionId: String,
    ): RelayV2StoredSession? = dao.session(
        namespace.profileId,
        namespace.principalId,
        namespace.clientInstanceId,
        namespace.hostId,
        namespace.hostEpoch,
        scopeId,
        sessionId,
    )?.toStored()

    override fun putSession(session: RelayV2StoredSession) {
        dao.putSession(session.toEntity())
    }

    override fun deleteSession(
        namespace: RelayV2StateNamespace,
        scopeId: String,
        sessionId: String,
    ) {
        dao.deleteSession(
            namespace.profileId,
            namespace.principalId,
            namespace.clientInstanceId,
            namespace.hostId,
            namespace.hostEpoch,
            scopeId,
            sessionId,
        )
    }

    override fun sessionStats(
        namespace: RelayV2StateNamespace,
        scopeId: String,
    ): RelayV2StoredSessionStats = dao.sessionStats(
        namespace.profileId,
        namespace.principalId,
        namespace.clientInstanceId,
        namespace.hostId,
        namespace.hostEpoch,
        scopeId,
    ).toStoredStats()

    override fun deleteSessionsForScope(namespace: RelayV2StateNamespace, scopeId: String) {
        dao.deleteSessionsForScope(
            namespace.profileId,
            namespace.principalId,
            namespace.clientInstanceId,
            namespace.hostId,
            namespace.hostEpoch,
            scopeId,
        )
    }

    override fun deleteSessions(namespace: RelayV2StateNamespace) {
        dao.deleteSessions(
            namespace.profileId,
            namespace.principalId,
            namespace.clientInstanceId,
            namespace.hostId,
            namespace.hostEpoch,
        )
    }

    override fun snapshot(namespace: RelayV2StateNamespace): RelayV2StoredSnapshot? =
        dao.snapshot(
            namespace.profileId,
            namespace.principalId,
            namespace.clientInstanceId,
            namespace.hostId,
            namespace.hostEpoch,
        )?.toStored()

    override fun putSnapshot(snapshot: RelayV2StoredSnapshot) {
        dao.putSnapshot(snapshot.toEntity())
    }

    override fun deleteSnapshot(namespace: RelayV2StateNamespace) {
        dao.deleteSnapshotRecords(
            namespace.profileId,
            namespace.principalId,
            namespace.clientInstanceId,
            namespace.hostId,
            namespace.hostEpoch,
        )
        dao.deleteSnapshot(
            namespace.profileId,
            namespace.principalId,
            namespace.clientInstanceId,
            namespace.hostId,
            namespace.hostEpoch,
        )
    }

    override fun putSnapshotRecords(records: List<RelayV2StoredSnapshotRecord>) {
        if (records.isNotEmpty()) dao.putSnapshotRecords(records.map(RelayV2StoredSnapshotRecord::toEntity))
    }

    override fun visitSnapshotRecords(
        namespace: RelayV2StateNamespace,
        snapshotId: String,
        visitor: (RelayV2StoredSnapshotRecord) -> Unit,
    ) {
        var offset = 0L
        do {
            val page = dao.snapshotRecordPage(
                namespace.profileId,
                namespace.principalId,
                namespace.clientInstanceId,
                namespace.hostId,
                namespace.hostEpoch,
                snapshotId,
                RECORD_PAGE_SIZE,
                offset,
            )
            page.forEach { visitor(it.toStored(namespace)) }
            offset += page.size
        } while (page.size == RECORD_PAGE_SIZE)
    }

    override fun stagedScope(
        namespace: RelayV2StateNamespace,
        snapshotId: String,
        scopeId: String,
    ): RelayV2StoredScope? {
        val scope = dao.stagedRecord(
            namespace.profileId,
            namespace.principalId,
            namespace.clientInstanceId,
            namespace.hostId,
            namespace.hostEpoch,
            snapshotId,
            scopeId,
            "scope",
        ) ?: return null
        val sessionsScope = dao.stagedRecord(
            namespace.profileId,
            namespace.principalId,
            namespace.clientInstanceId,
            namespace.hostId,
            namespace.hostEpoch,
            snapshotId,
            scopeId,
            "sessions_scope",
        ) ?: return null
        return RelayV2StoredScope(
            namespace = namespace,
            item = scope.toScopeResource(),
            sessionsRevision = requireNotNull(sessionsScope.revision),
            scopeRecordCanonicalJson = scope.canonicalJson,
            sessionsScopeRecordCanonicalJson = sessionsScope.canonicalJson,
        )
    }

    override fun stagedSession(
        namespace: RelayV2StateNamespace,
        snapshotId: String,
        scopeId: String,
        sessionId: String,
    ): RelayV2StoredSession? = dao.stagedSessionRecord(
        namespace.profileId,
        namespace.principalId,
        namespace.clientInstanceId,
        namespace.hostId,
        namespace.hostEpoch,
        snapshotId,
        scopeId,
        sessionId,
    )?.let {
        RelayV2StoredSession(namespace, it.toSessionResource(), it.canonicalJson)
    }

    override fun stagedSessionStats(
        namespace: RelayV2StateNamespace,
        snapshotId: String,
        scopeId: String,
    ): RelayV2StoredSessionStats = dao.stagedSessionStats(
        namespace.profileId,
        namespace.principalId,
        namespace.clientInstanceId,
        namespace.hostId,
        namespace.hostEpoch,
        snapshotId,
        scopeId,
    ).toStoredStats()

    override fun stagedSessionsRevision(
        namespace: RelayV2StateNamespace,
        snapshotId: String,
        scopeId: String,
    ): String? = dao.stagedRecord(
        namespace.profileId,
        namespace.principalId,
        namespace.clientInstanceId,
        namespace.hostId,
        namespace.hostEpoch,
        snapshotId,
        scopeId,
        "sessions_scope",
    )?.revision

    override fun bufferedEvent(
        namespace: RelayV2StateNamespace,
        eventSeq: String,
    ): RelayV2StoredEvent? = dao.bufferedEvent(
        namespace.profileId,
        namespace.principalId,
        namespace.clientInstanceId,
        namespace.hostId,
        namespace.hostEpoch,
        eventSeq,
    )?.toStored(namespace)

    override fun putBufferedEvent(event: RelayV2StoredEvent) {
        dao.putBufferedEvent(event.toEntity())
    }

    override fun bufferedEvents(namespace: RelayV2StateNamespace): List<RelayV2StoredEvent> =
        dao.bufferedEvents(
            namespace.profileId,
            namespace.principalId,
            namespace.clientInstanceId,
            namespace.hostId,
            namespace.hostEpoch,
        )
            .map { it.toStored(namespace) }

    override fun bufferedEventCount(namespace: RelayV2StateNamespace): Long =
        dao.bufferedEventStats(
            namespace.profileId,
            namespace.principalId,
            namespace.clientInstanceId,
            namespace.hostId,
            namespace.hostEpoch,
        ).itemCount

    override fun bufferedEventRawBytes(namespace: RelayV2StateNamespace): Long =
        dao.bufferedEventStats(
            namespace.profileId,
            namespace.principalId,
            namespace.clientInstanceId,
            namespace.hostId,
            namespace.hostEpoch,
        ).byteCount

    override fun deleteBufferedEvents(namespace: RelayV2StateNamespace) {
        dao.deleteBufferedEvents(
            namespace.profileId,
            namespace.principalId,
            namespace.clientInstanceId,
            namespace.hostId,
            namespace.hostEpoch,
        )
    }

    private companion object {
        const val RECORD_PAGE_SIZE = 256
    }
}

private fun RelayV2AuthorityEntity.toStored() = RelayV2StoredAuthority(
    namespace = namespace(),
    cursorEventSeq = cursorEventSeq,
    requiredThroughEventSeq = requiredThroughEventSeq,
    scopesRevision = scopesRevision,
    phase = RelayV2StoredSyncPhase.valueOf(phase),
    cacheRecordCount = cacheRecordCount,
    cacheCanonicalBytes = cacheCanonicalBytes,
)

private fun RelayV2StoredAuthority.toEntity() = RelayV2AuthorityEntity(
    profileId = namespace.profileId,
    principalId = namespace.principalId,
    clientInstanceId = namespace.clientInstanceId,
    hostId = namespace.hostId,
    hostEpoch = namespace.hostEpoch,
    cursorEventSeq = cursorEventSeq,
    requiredThroughEventSeq = requiredThroughEventSeq,
    scopesRevision = scopesRevision,
    phase = phase.name,
    cacheRecordCount = cacheRecordCount,
    cacheCanonicalBytes = cacheCanonicalBytes,
)

private fun RelayV2ScopeEntity.toStored() = RelayV2StoredScope(
    namespace = namespace(),
    item = RelayV2ScopeResource(
        scopeId,
        displayName,
        RelayV2ScopeKind.entries.single { it.wireValue == kind },
        RelayV2ScopeReachability.entries.single { it.wireValue == reachability },
    ),
    sessionsRevision = sessionsRevision,
    scopeRecordCanonicalJson = scopeRecordCanonicalJson,
    sessionsScopeRecordCanonicalJson = sessionsScopeRecordCanonicalJson,
)

private fun RelayV2StoredScope.toEntity() = RelayV2ScopeEntity(
    profileId = namespace.profileId,
    principalId = namespace.principalId,
    clientInstanceId = namespace.clientInstanceId,
    hostId = namespace.hostId,
    hostEpoch = namespace.hostEpoch,
    scopeId = item.scopeId,
    displayName = item.displayName,
    kind = item.kind.wireValue,
    reachability = item.reachability.wireValue,
    sessionsRevision = sessionsRevision,
    scopeRecordCanonicalJson = scopeRecordCanonicalJson,
    sessionsScopeRecordCanonicalJson = sessionsScopeRecordCanonicalJson,
)

private fun RelayV2SessionEntity.toStored() = RelayV2StoredSession(
    namespace = namespace(),
    item = toSessionResource(),
    recordCanonicalJson = recordCanonicalJson,
)

private fun RelayV2StoredSession.toEntity() = RelayV2SessionEntity(
    profileId = namespace.profileId,
    principalId = namespace.principalId,
    clientInstanceId = namespace.clientInstanceId,
    hostId = namespace.hostId,
    hostEpoch = namespace.hostEpoch,
    scopeId = item.scopeId,
    sessionId = item.sessionId,
    kind = item.kind.wireValue,
    displayName = item.displayName,
    project = item.project,
    label = item.label,
    cwd = item.cwd,
    attached = item.attached,
    windowCount = item.windowCount,
    createdAtMs = item.createdAtMs,
    activityAtMs = item.activityAtMs,
    recordCanonicalJson = recordCanonicalJson,
)

private fun RelayV2SnapshotStagingEntity.toStored() = RelayV2StoredSnapshot(
    namespace = namespace(),
    snapshotRequestId = snapshotRequestId,
    snapshotId = snapshotId,
    snapshotCreatedAtMs = snapshotCreatedAtMs,
    snapshotLeaseExpiresAtMs = snapshotLeaseExpiresAtMs,
    snapshotAbsoluteExpiresAtMs = snapshotAbsoluteExpiresAtMs,
    throughEventSeq = throughEventSeq,
    scopesRevision = scopesRevision,
    totalRecords = totalRecords,
    totalCanonicalBytes = totalCanonicalBytes,
    cutDigest = cutDigest,
    nextChunkIndex = nextChunkIndex,
    nextCursor = nextCursor,
    receivedRecords = receivedRecords,
    receivedRecordCanonicalBytes = receivedRecordCanonicalBytes,
    receivedRawUtf8Bytes = receivedRawUtf8Bytes,
    lastScopeId = lastScopeId,
    lastRecordKind = lastRecordKind,
    lastSessionId = lastSessionId,
    complete = complete,
)

private fun RelayV2StoredSnapshot.toEntity() = RelayV2SnapshotStagingEntity(
    profileId = namespace.profileId,
    principalId = namespace.principalId,
    clientInstanceId = namespace.clientInstanceId,
    hostId = namespace.hostId,
    hostEpoch = namespace.hostEpoch,
    snapshotRequestId = snapshotRequestId,
    snapshotId = snapshotId,
    snapshotCreatedAtMs = snapshotCreatedAtMs,
    snapshotLeaseExpiresAtMs = snapshotLeaseExpiresAtMs,
    snapshotAbsoluteExpiresAtMs = snapshotAbsoluteExpiresAtMs,
    throughEventSeq = throughEventSeq,
    scopesRevision = scopesRevision,
    totalRecords = totalRecords,
    totalCanonicalBytes = totalCanonicalBytes,
    cutDigest = cutDigest,
    nextChunkIndex = nextChunkIndex,
    nextCursor = nextCursor,
    receivedRecords = receivedRecords,
    receivedRecordCanonicalBytes = receivedRecordCanonicalBytes,
    receivedRawUtf8Bytes = receivedRawUtf8Bytes,
    lastScopeId = lastScopeId,
    lastRecordKind = lastRecordKind,
    lastSessionId = lastSessionId,
    complete = complete,
)

private fun RelayV2StoredSnapshotRecord.toEntity(): RelayV2SnapshotRecordEntity {
    val scope = when (val value = record) {
        is RelayV2SnapshotRecord.Scope -> value.item
        is RelayV2SnapshotRecord.SessionsScope -> null
        is RelayV2SnapshotRecord.Session -> null
    }
    val session = (record as? RelayV2SnapshotRecord.Session)?.item
    return RelayV2SnapshotRecordEntity(
        profileId = namespace.profileId,
        principalId = namespace.principalId,
        clientInstanceId = namespace.clientInstanceId,
        hostId = namespace.hostId,
        hostEpoch = namespace.hostEpoch,
        snapshotId = snapshotId,
        recordIndex = recordIndex,
        chunkIndex = chunkIndex,
        recordType = when (record) {
            is RelayV2SnapshotRecord.Scope -> "scope"
            is RelayV2SnapshotRecord.SessionsScope -> "sessions_scope"
            is RelayV2SnapshotRecord.Session -> "session"
        },
        scopeId = when (val value = record) {
            is RelayV2SnapshotRecord.Scope -> value.item.scopeId
            is RelayV2SnapshotRecord.SessionsScope -> value.scopeId
            is RelayV2SnapshotRecord.Session -> value.scopeId
        },
        sessionId = session?.sessionId,
        revision = (record as? RelayV2SnapshotRecord.SessionsScope)?.revision,
        displayName = scope?.displayName ?: session?.displayName,
        kind = scope?.kind?.wireValue ?: session?.kind?.wireValue,
        reachability = scope?.reachability?.wireValue,
        project = session?.project,
        label = session?.label,
        cwd = session?.cwd,
        attached = session?.attached,
        windowCount = session?.windowCount,
        createdAtMs = session?.createdAtMs,
        activityAtMs = session?.activityAtMs,
        canonicalJson = canonicalJson,
    )
}

private fun RelayV2SnapshotRecordEntity.toStored(
    namespace: RelayV2StateNamespace,
): RelayV2StoredSnapshotRecord = RelayV2StoredSnapshotRecord(
    namespace = namespace,
    snapshotId = snapshotId,
    recordIndex = recordIndex,
    chunkIndex = chunkIndex,
    record = when (recordType) {
        "scope" -> RelayV2SnapshotRecord.Scope(toScopeResource())
        "sessions_scope" -> RelayV2SnapshotRecord.SessionsScope(scopeId, requireNotNull(revision))
        "session" -> RelayV2SnapshotRecord.Session(scopeId, toSessionResource())
        else -> error("Unknown staged Relay v2 record type")
    },
    canonicalJson = canonicalJson,
)

private fun RelayV2StoredEvent.toEntity(): RelayV2StateEventEntity {
    val scope = (event.change as? RelayV2StateChange.ScopeUpsert)?.item
    val session = (event.change as? RelayV2StateChange.SessionUpsert)?.item
    return RelayV2StateEventEntity(
        profileId = event.namespace.profileId,
        principalId = event.namespace.principalId,
        clientInstanceId = event.namespace.clientInstanceId,
        hostId = event.namespace.hostId,
        hostEpoch = event.namespace.hostEpoch,
        eventSeq = event.eventSeq,
        eventSeqOrder = eventSeqOrder,
        resultingRevision = event.resultingRevision,
        changeType = when (event.change) {
            is RelayV2StateChange.ScopeUpsert -> "scope_upsert"
            is RelayV2StateChange.ScopeDelete -> "scope_delete"
            is RelayV2StateChange.SessionUpsert -> "session_upsert"
            is RelayV2StateChange.SessionDelete -> "session_delete"
        },
        scopeId = event.change.scopeId,
        sessionId = when (val change = event.change) {
            is RelayV2StateChange.SessionUpsert -> change.item.sessionId
            is RelayV2StateChange.SessionDelete -> change.sessionId
            else -> null
        },
        displayName = scope?.displayName ?: session?.displayName,
        kind = scope?.kind?.wireValue ?: session?.kind?.wireValue,
        reachability = scope?.reachability?.wireValue,
        project = session?.project,
        label = session?.label,
        cwd = session?.cwd,
        attached = session?.attached,
        windowCount = session?.windowCount,
        createdAtMs = session?.createdAtMs,
        activityAtMs = session?.activityAtMs,
        rawUtf8Bytes = event.rawUtf8Bytes,
        canonicalJson = canonicalJson,
    )
}

private fun RelayV2StateEventEntity.toStored(namespace: RelayV2StateNamespace): RelayV2StoredEvent {
    val change = when (changeType) {
        "scope_upsert" -> RelayV2StateChange.ScopeUpsert(toScopeResource())
        "scope_delete" -> RelayV2StateChange.ScopeDelete(scopeId)
        "session_upsert" -> RelayV2StateChange.SessionUpsert(toSessionResource())
        "session_delete" -> RelayV2StateChange.SessionDelete(scopeId, requireNotNull(sessionId))
        else -> error("Unknown buffered Relay v2 event type")
    }
    return RelayV2StoredEvent(
        event = RelayV2StateEvent(
            namespace,
            eventSeq,
            resultingRevision,
            change,
            rawUtf8Bytes,
        ),
        eventSeqOrder = eventSeqOrder,
        canonicalJson = canonicalJson,
    )
}

private fun RelayV2SnapshotRecordEntity.toScopeResource() = RelayV2ScopeResource(
    scopeId,
    requireNotNull(displayName),
    RelayV2ScopeKind.entries.single { it.wireValue == kind },
    RelayV2ScopeReachability.entries.single { it.wireValue == reachability },
)

private fun RelayV2StateEventEntity.toScopeResource() = RelayV2ScopeResource(
    scopeId,
    requireNotNull(displayName),
    RelayV2ScopeKind.entries.single { it.wireValue == kind },
    RelayV2ScopeReachability.entries.single { it.wireValue == reachability },
)

private fun RelayV2SnapshotRecordEntity.toSessionResource() = RelayV2SessionResource(
    scopeId,
    requireNotNull(sessionId),
    RelayV2SessionKind.entries.single { it.wireValue == kind },
    requireNotNull(displayName),
    project,
    label,
    cwd,
    requireNotNull(attached),
    requireNotNull(windowCount),
    requireNotNull(createdAtMs),
    requireNotNull(activityAtMs),
)

private fun RelayV2SessionEntity.toSessionResource() = RelayV2SessionResource(
    scopeId,
    sessionId,
    RelayV2SessionKind.entries.single { it.wireValue == kind },
    displayName,
    project,
    label,
    cwd,
    attached,
    windowCount,
    createdAtMs,
    activityAtMs,
)

private fun RelayV2StateEventEntity.toSessionResource() = RelayV2SessionResource(
    scopeId,
    requireNotNull(sessionId),
    RelayV2SessionKind.entries.single { it.wireValue == kind },
    requireNotNull(displayName),
    project,
    label,
    cwd,
    requireNotNull(attached),
    requireNotNull(windowCount),
    requireNotNull(createdAtMs),
    requireNotNull(activityAtMs),
)

private fun RelayV2SqlStats.toStoredStats() = RelayV2StoredSessionStats(itemCount, byteCount)

private fun RelayV2AuthorityEntity.namespace() = RelayV2StateNamespace(
    profileId,
    principalId,
    clientInstanceId,
    hostId,
    hostEpoch,
)

private fun RelayV2ScopeEntity.namespace() = RelayV2StateNamespace(
    profileId,
    principalId,
    clientInstanceId,
    hostId,
    hostEpoch,
)

private fun RelayV2SessionEntity.namespace() = RelayV2StateNamespace(
    profileId,
    principalId,
    clientInstanceId,
    hostId,
    hostEpoch,
)

private fun RelayV2SnapshotStagingEntity.namespace() = RelayV2StateNamespace(
    profileId,
    principalId,
    clientInstanceId,
    hostId,
    hostEpoch,
)
