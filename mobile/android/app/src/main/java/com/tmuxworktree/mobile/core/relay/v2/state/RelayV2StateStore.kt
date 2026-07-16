package com.tmuxworktree.mobile.core.relay.v2.state

internal enum class RelayV2StoredSyncPhase {
    LIVE,
    RESYNCING,
}

internal data class RelayV2StoredAuthority(
    val namespace: RelayV2StateNamespace,
    val cursorEventSeq: String?,
    val requiredThroughEventSeq: String,
    val scopesRevision: String?,
    val phase: RelayV2StoredSyncPhase,
    val cacheRecordCount: Long,
    val cacheCanonicalBytes: Long,
)

internal data class RelayV2StoredScope(
    val namespace: RelayV2StateNamespace,
    val item: RelayV2ScopeResource,
    val sessionsRevision: String,
    val scopeRecordCanonicalJson: String,
    val sessionsScopeRecordCanonicalJson: String,
) {
    val canonicalBytes: Long
        get() = scopeRecordCanonicalJson.toByteArray(Charsets.UTF_8).size.toLong() +
            sessionsScopeRecordCanonicalJson.toByteArray(Charsets.UTF_8).size
}

internal data class RelayV2StoredSession(
    val namespace: RelayV2StateNamespace,
    val item: RelayV2SessionResource,
    val recordCanonicalJson: String,
) {
    val canonicalBytes: Long
        get() = recordCanonicalJson.toByteArray(Charsets.UTF_8).size.toLong()
}

internal data class RelayV2StoredSnapshot(
    val namespace: RelayV2StateNamespace,
    val snapshotRequestId: String,
    val snapshotId: String,
    val snapshotCreatedAtMs: Long,
    val snapshotLeaseExpiresAtMs: Long,
    val snapshotAbsoluteExpiresAtMs: Long,
    val throughEventSeq: String,
    val scopesRevision: String,
    val totalRecords: Long,
    val totalCanonicalBytes: Long,
    val cutDigest: String,
    val nextChunkIndex: Long,
    val nextCursor: String?,
    val receivedRecords: Long,
    val receivedRecordCanonicalBytes: Long,
    val receivedRawUtf8Bytes: Long,
    val lastScopeId: String?,
    val lastRecordKind: String?,
    val lastSessionId: String?,
    val complete: Boolean,
) {
    fun releaseDirective(): RelayV2SnapshotReleaseDirective = RelayV2SnapshotReleaseDirective(
        namespace = namespace,
        snapshotRequestId = snapshotRequestId,
        snapshotId = snapshotId,
    )
}

internal data class RelayV2StoredSnapshotRecord(
    val namespace: RelayV2StateNamespace,
    val snapshotId: String,
    val recordIndex: Long,
    val chunkIndex: Long,
    val record: RelayV2SnapshotRecord,
    val canonicalJson: String,
)

internal data class RelayV2StoredEvent(
    val event: RelayV2StateEvent,
    val eventSeqOrder: String,
    val canonicalJson: String,
)

internal data class RelayV2StoredSessionStats(
    val count: Long,
    val canonicalBytes: Long,
)

/**
 * Minimal transaction surface owned by the state-sync reducer.
 *
 * Implementations must make one [transaction] block atomic. The production implementation maps
 * this boundary to one Room transaction; JVM tests use an isolated copy-on-write store.
 */
internal interface RelayV2StateStore {
    suspend fun <T> transaction(block: RelayV2StateTransaction.() -> T): T
}

internal interface RelayV2StateTransaction {
    fun authority(namespace: RelayV2StateNamespace): RelayV2StoredAuthority?
    fun putAuthority(authority: RelayV2StoredAuthority)

    /** Deletes all six v2 state categories for this exact namespace, never v1 or credentials. */
    fun deleteNamespaceState(namespace: RelayV2StateNamespace)

    /**
     * Deletes all six state-sync categories plus every activation-scoped Outbox and terminal row
     * for this profile, never v1 rows or credentials.
     */
    fun deleteProfileState(profileId: String)

    fun scope(namespace: RelayV2StateNamespace, scopeId: String): RelayV2StoredScope?
    fun putScope(scope: RelayV2StoredScope)
    fun deleteScope(namespace: RelayV2StateNamespace, scopeId: String)
    fun deleteScopes(namespace: RelayV2StateNamespace)

    fun session(
        namespace: RelayV2StateNamespace,
        scopeId: String,
        sessionId: String,
    ): RelayV2StoredSession?

    fun putSession(session: RelayV2StoredSession)
    fun deleteSession(namespace: RelayV2StateNamespace, scopeId: String, sessionId: String)
    fun sessionStats(namespace: RelayV2StateNamespace, scopeId: String): RelayV2StoredSessionStats
    fun deleteSessionsForScope(namespace: RelayV2StateNamespace, scopeId: String)
    fun deleteSessions(namespace: RelayV2StateNamespace)

    fun snapshot(namespace: RelayV2StateNamespace): RelayV2StoredSnapshot?
    fun putSnapshot(snapshot: RelayV2StoredSnapshot)
    fun deleteSnapshot(namespace: RelayV2StateNamespace)
    fun putSnapshotRecords(records: List<RelayV2StoredSnapshotRecord>)
    fun visitSnapshotRecords(
        namespace: RelayV2StateNamespace,
        snapshotId: String,
        visitor: (RelayV2StoredSnapshotRecord) -> Unit,
    )

    fun stagedScope(
        namespace: RelayV2StateNamespace,
        snapshotId: String,
        scopeId: String,
    ): RelayV2StoredScope?

    fun stagedSession(
        namespace: RelayV2StateNamespace,
        snapshotId: String,
        scopeId: String,
        sessionId: String,
    ): RelayV2StoredSession?

    fun stagedSessionStats(
        namespace: RelayV2StateNamespace,
        snapshotId: String,
        scopeId: String,
    ): RelayV2StoredSessionStats

    fun stagedSessionsRevision(
        namespace: RelayV2StateNamespace,
        snapshotId: String,
        scopeId: String,
    ): String?

    fun bufferedEvent(namespace: RelayV2StateNamespace, eventSeq: String): RelayV2StoredEvent?
    fun putBufferedEvent(event: RelayV2StoredEvent)
    fun bufferedEvents(namespace: RelayV2StateNamespace): List<RelayV2StoredEvent>
    fun bufferedEventCount(namespace: RelayV2StateNamespace): Long
    fun bufferedEventRawBytes(namespace: RelayV2StateNamespace): Long
    fun deleteBufferedEvents(namespace: RelayV2StateNamespace)
}
