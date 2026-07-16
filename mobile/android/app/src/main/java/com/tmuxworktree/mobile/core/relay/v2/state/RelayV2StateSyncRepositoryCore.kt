package com.tmuxworktree.mobile.core.relay.v2.state

import com.tmuxworktree.mobile.core.relay.v2.profile.RelayProfileDialect
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayProfileDisconnectReceipt
import java.security.MessageDigest
import java.util.Base64
import kotlin.math.max

/**
 * Android-free state-sync transaction/reducer boundary.
 *
 * Generation-scoped calls must be made from inside
 * `RelayV2ConnectionActor.withEffectApplyLease { ... }`. This class deliberately does not inspect
 * the actor's public generation state: the surrounding lease owns that authority, while each
 * method below keeps its complete storage mutation inside one store transaction.
 */
internal class RelayV2StateSyncRepositoryCore(
    private val store: RelayV2StateStore,
) {
    suspend fun applyHelloUnderApplyLease(hello: RelayV2StateHello): RelayV2StateSyncResult =
        store.transaction {
            val namespace = hello.namespace
            val current = authority(namespace)
            if (hello.disposition == RelayV2StateHelloDisposition.EVENT_CURSOR_AHEAD) {
                return@transaction RelayV2StateSyncResult.RotationRequired(
                    namespace,
                    RelayV2RotationReason.EVENT_CURSOR_AHEAD,
                )
            }

            when (hello.disposition) {
                RelayV2StateHelloDisposition.FRESH -> {
                    val release = current?.let { snapshot(it.namespace)?.releaseDirective() }
                    deleteNamespaceState(namespace)
                    putAuthority(newAuthority(namespace, hello.welcomeEventSeq))
                    RelayV2StateSyncResult.ResyncRequired(
                        namespace,
                        RelayV2ResyncReason.FRESH,
                        release,
                    )
                }
                RelayV2StateHelloDisposition.HOST_EPOCH_CHANGED -> {
                    val priorNamespace = namespace.copy(hostEpoch = requireNotNull(hello.resume).hostEpoch)
                    deleteNamespaceState(priorNamespace)
                    deleteNamespaceState(namespace)
                    putAuthority(newAuthority(namespace, hello.welcomeEventSeq))
                    RelayV2StateSyncResult.ResyncRequired(
                        namespace,
                        RelayV2ResyncReason.HOST_EPOCH_CHANGED,
                    )
                }
                RelayV2StateHelloDisposition.MATCHED,
                RelayV2StateHelloDisposition.CURSOR_BEHIND,
                -> applySameEpochWelcome(this, current, hello)
                RelayV2StateHelloDisposition.EVENT_CURSOR_AHEAD -> error("Handled above")
            }
        }

    suspend fun stageSnapshotChunkUnderApplyLease(
        chunk: RelayV2SnapshotChunk,
    ): RelayV2StateSyncResult = store.transaction {
        val authority = authority(chunk.namespace)
            ?: return@transaction unknownEpoch(chunk.namespace)
        if (authority.phase != RelayV2StoredSyncPhase.RESYNCING) {
            return@transaction RelayV2StateSyncResult.ResyncRequired(
                chunk.namespace,
                RelayV2ResyncReason.SNAPSHOT_RESTART_REQUIRED,
            )
        }

        val existing = snapshot(chunk.namespace)
        val release = existing?.releaseDirective() ?: chunk.releaseDirective()
        fun reject(reason: RelayV2ResyncReason): RelayV2StateSyncResult {
            deleteSnapshot(chunk.namespace)
            deleteBufferedEvents(chunk.namespace)
            return RelayV2StateSyncResult.ResyncRequired(chunk.namespace, reason, release)
        }

        val canonicalRecords = chunk.records.map { record ->
            val canonical = record.canonicalJson()
            record to canonical
        }
        val chunkCanonicalBytes = canonicalArrayBytes(canonicalRecords.map { it.second })
        if (chunkCanonicalBytes > RelayV2StateLimits.MAX_SNAPSHOT_CHUNK_CANONICAL_BYTES ||
            chunk.records.size > RelayV2StateLimits.MAX_SNAPSHOT_CHUNK_RECORDS ||
            chunk.totalRecords > RelayV2StateLimits.MAX_SNAPSHOT_RECORDS ||
            chunk.totalCanonicalBytes > RelayV2StateLimits.MAX_SNAPSHOT_CANONICAL_BYTES
        ) {
            return@transaction reject(RelayV2ResyncReason.SNAPSHOT_LIMIT_EXCEEDED)
        }

        val base = if (existing == null) {
            if (chunk.chunkIndex != 0L) {
                return@transaction reject(RelayV2ResyncReason.SNAPSHOT_ORDER_CONFLICT)
            }
            RelayV2StoredSnapshot(
                namespace = chunk.namespace,
                snapshotRequestId = chunk.snapshotRequestId,
                snapshotId = chunk.snapshotId,
                snapshotCreatedAtMs = chunk.snapshotCreatedAtMs,
                snapshotLeaseExpiresAtMs = chunk.snapshotLeaseExpiresAtMs,
                snapshotAbsoluteExpiresAtMs = chunk.snapshotAbsoluteExpiresAtMs,
                throughEventSeq = chunk.throughEventSeq,
                scopesRevision = chunk.scopesRevision,
                totalRecords = chunk.totalRecords,
                totalCanonicalBytes = chunk.totalCanonicalBytes,
                cutDigest = chunk.cutDigest,
                nextChunkIndex = 0,
                nextCursor = null,
                receivedRecords = 0,
                receivedRecordCanonicalBytes = 0,
                receivedRawUtf8Bytes = 0,
                lastScopeId = null,
                lastRecordKind = null,
                lastSessionId = null,
                complete = false,
            )
        } else {
            if (!existing.matchesFixedBinding(chunk) ||
                chunk.snapshotLeaseExpiresAtMs < existing.snapshotLeaseExpiresAtMs ||
                chunk.chunkIndex != existing.nextChunkIndex ||
                chunk.requestedCursor != existing.nextCursor ||
                existing.complete
            ) {
                return@transaction reject(RelayV2ResyncReason.SNAPSHOT_IDENTITY_CONFLICT)
            }
            existing
        }

        var order = SnapshotOrder(
            scopeId = base.lastScopeId,
            recordKind = base.lastRecordKind,
            sessionId = base.lastSessionId,
        )
        canonicalRecords.forEach { (record, _) ->
            order = order.advance(record)
                ?: return@transaction reject(RelayV2ResyncReason.SNAPSHOT_ORDER_CONFLICT)
        }
        if (chunk.isLast && order.recordKind == "scope") {
            return@transaction reject(RelayV2ResyncReason.SNAPSHOT_ORDER_CONFLICT)
        }

        val newRecordCount = base.receivedRecords + canonicalRecords.size
        val newRecordBytes = base.receivedRecordCanonicalBytes + canonicalRecords.sumOf {
            it.second.toByteArray(Charsets.UTF_8).size.toLong()
        }
        val newRawBytes = base.receivedRawUtf8Bytes + chunk.rawUtf8Bytes
        if (newRecordCount > base.totalRecords ||
            newRecordCount > RelayV2StateLimits.MAX_SNAPSHOT_RECORDS ||
            newRawBytes > RelayV2StateLimits.MAX_STAGED_RAW_UTF8_BYTES
        ) {
            return@transaction reject(RelayV2ResyncReason.SNAPSHOT_LIMIT_EXCEEDED)
        }

        val startIndex = base.receivedRecords
        putSnapshotRecords(
            canonicalRecords.mapIndexed { offset, (record, canonical) ->
                RelayV2StoredSnapshotRecord(
                    namespace = chunk.namespace,
                    snapshotId = chunk.snapshotId,
                    recordIndex = startIndex + offset,
                    chunkIndex = chunk.chunkIndex,
                    record = record,
                    canonicalJson = canonical,
                )
            },
        )
        val updated = base.copy(
            snapshotLeaseExpiresAtMs = chunk.snapshotLeaseExpiresAtMs,
            nextChunkIndex = chunk.chunkIndex + 1,
            nextCursor = chunk.nextCursor,
            receivedRecords = newRecordCount,
            receivedRecordCanonicalBytes = newRecordBytes,
            receivedRawUtf8Bytes = newRawBytes,
            lastScopeId = order.scopeId,
            lastRecordKind = order.recordKind,
            lastSessionId = order.sessionId,
            complete = chunk.isLast,
        )
        putSnapshot(updated)
        RelayV2StateSyncResult.SnapshotStaged(
            namespace = chunk.namespace,
            snapshotId = chunk.snapshotId,
            nextChunkIndex = updated.nextChunkIndex,
            nextCursor = updated.nextCursor,
            complete = updated.complete,
        )
    }

    suspend fun applyStateEventUnderApplyLease(
        event: RelayV2StateEvent,
    ): RelayV2StateSyncResult = store.transaction {
        val authority = authority(event.namespace)
            ?: return@transaction unknownEpoch(event.namespace)
        val cursor = authority.cursorEventSeq
        if (cursor != null && compareRelayV2Counters(event.eventSeq, cursor) <= 0) {
            return@transaction RelayV2StateSyncResult.DuplicateEvent
        }

        if (authority.phase == RelayV2StoredSyncPhase.LIVE &&
            cursor != null &&
            event.eventSeq == incrementRelayV2Counter(cursor)
        ) {
            val applied = applyLiveEvent(this, authority, event)
            if (applied != null) {
                putAuthority(applied)
                return@transaction RelayV2StateSyncResult.Live(event.namespace, event.eventSeq)
            }
            putAuthority(authority.copy(phase = RelayV2StoredSyncPhase.RESYNCING))
            return@transaction bufferEventOrRestart(
                transaction = this,
                authority = authority,
                event = event,
                reason = RelayV2ResyncReason.EVENT_REVISION_CONFLICT,
            )
        }

        if (authority.phase == RelayV2StoredSyncPhase.LIVE) {
            putAuthority(authority.copy(phase = RelayV2StoredSyncPhase.RESYNCING))
        }
        bufferEventOrRestart(
            transaction = this,
            authority = authority,
            event = event,
            reason = RelayV2ResyncReason.EVENT_GAP,
        )
    }

    suspend fun commitSnapshotUnderApplyLease(
        namespace: RelayV2StateNamespace,
        snapshotId: String,
    ): RelayV2StateSyncResult = store.transaction {
        val authority = authority(namespace) ?: return@transaction unknownEpoch(namespace)
        val staged = snapshot(namespace)
            ?: return@transaction RelayV2StateSyncResult.ResyncRequired(
                namespace,
                RelayV2ResyncReason.SNAPSHOT_RESTART_REQUIRED,
            )
        if (staged.snapshotId != snapshotId) {
            val release = staged.releaseDirective()
            deleteSnapshot(namespace)
            deleteBufferedEvents(namespace)
            return@transaction RelayV2StateSyncResult.ResyncRequired(
                namespace,
                RelayV2ResyncReason.SNAPSHOT_IDENTITY_CONFLICT,
                release,
            )
        }
        if (!staged.complete) {
            return@transaction RelayV2StateSyncResult.ResyncRequired(
                namespace,
                RelayV2ResyncReason.SNAPSHOT_INCOMPLETE,
            )
        }

        val release = staged.releaseDirective()
        val actual = inspectStagedCut(this, staged)
        if (actual.recordCount != staged.totalRecords ||
            actual.totalCanonicalBytes != staged.totalCanonicalBytes
        ) {
            deleteSnapshot(namespace)
            deleteBufferedEvents(namespace)
            return@transaction RelayV2StateSyncResult.ResyncRequired(
                namespace,
                RelayV2ResyncReason.SNAPSHOT_COUNT_MISMATCH,
                release,
            )
        }
        if (actual.digest != staged.cutDigest) {
            deleteSnapshot(namespace)
            deleteBufferedEvents(namespace)
            return@transaction RelayV2StateSyncResult.ResyncRequired(
                namespace,
                RelayV2ResyncReason.SNAPSHOT_DIGEST_MISMATCH,
                release,
            )
        }

        val buffered = bufferedEvents(namespace)
            .filter { compareRelayV2Counters(it.event.eventSeq, staged.throughEventSeq) > 0 }
        val validation = validateBufferedEvents(this, staged, buffered)
        if (validation.failure != null ||
            compareRelayV2Counters(validation.lastEventSeq, authority.requiredThroughEventSeq) < 0
        ) {
            deleteSnapshot(namespace)
            deleteBufferedEvents(namespace)
            return@transaction RelayV2StateSyncResult.ResyncRequired(
                namespace,
                validation.failure ?: RelayV2ResyncReason.EVENT_GAP,
                release,
            )
        }

        deleteSessions(namespace)
        deleteScopes(namespace)
        var pendingScope: RelayV2SnapshotRecord.Scope? = null
        visitSnapshotRecords(namespace, snapshotId) { record ->
            when (val value = record.record) {
                is RelayV2SnapshotRecord.Scope -> {
                    check(pendingScope == null) { "Snapshot scope is missing sessions_scope" }
                    pendingScope = value
                }
                is RelayV2SnapshotRecord.SessionsScope -> {
                    val scopeRecord = requireNotNull(pendingScope) {
                        "Snapshot sessions_scope has no matching scope"
                    }
                    check(scopeRecord.item.scopeId == value.scopeId) {
                        "Snapshot sessions_scope does not match scope"
                    }
                    putScope(storedScope(namespace, scopeRecord.item, value.revision))
                    pendingScope = null
                }
                is RelayV2SnapshotRecord.Session -> putSession(
                    storedSession(namespace, value.item),
                )
            }
        }
        check(pendingScope == null) { "Snapshot scope is missing sessions_scope" }

        var committedAuthority = authority.copy(
            cursorEventSeq = staged.throughEventSeq,
            scopesRevision = staged.scopesRevision,
            phase = RelayV2StoredSyncPhase.RESYNCING,
            cacheRecordCount = staged.totalRecords,
            cacheCanonicalBytes = staged.totalCanonicalBytes,
        )
        buffered.forEach { storedEvent ->
            committedAuthority = requireNotNull(
                applyLiveEvent(this, committedAuthority, storedEvent.event),
            ) { "Buffered event validation diverged during commit" }
        }
        committedAuthority = committedAuthority.copy(phase = RelayV2StoredSyncPhase.LIVE)
        putAuthority(committedAuthority)
        deleteSnapshot(namespace)
        deleteBufferedEvents(namespace)
        RelayV2StateSyncResult.SnapshotCommitted(
            namespace,
            requireNotNull(committedAuthority.cursorEventSeq),
        )
    }

    suspend fun discardSnapshotUnderApplyLease(
        namespace: RelayV2StateNamespace,
    ): RelayV2SnapshotReleaseDirective? = store.transaction {
        val release = snapshot(namespace)?.releaseDirective()
        deleteSnapshot(namespace)
        deleteBufferedEvents(namespace)
        release
    }

    /**
     * The receipt is the authority to clear after the actor has fenced and drained the profile.
     * This only clears the six v2 state categories in the independent state database.
     */
    suspend fun clearProfileAfterDisconnect(receipt: RelayProfileDisconnectReceipt) {
        require(receipt.profile.dialect == RelayProfileDialect.V2)
        require(receipt.barrierId.isNotBlank())
        store.transaction { deleteProfileState(receipt.profile.profileId) }
    }

    private fun applySameEpochWelcome(
        transaction: RelayV2StateTransaction,
        current: RelayV2StoredAuthority?,
        hello: RelayV2StateHello,
    ): RelayV2StateSyncResult = with(transaction) {
        val namespace = hello.namespace
        if (current == null || current.namespace != namespace ||
            current.cursorEventSeq != hello.resume?.eventSeq
        ) {
            return RelayV2StateSyncResult.RotationRequired(
                namespace,
                RelayV2RotationReason.UNKNOWN_HOST_EPOCH,
            )
        }
        if (compareRelayV2Counters(hello.welcomeEventSeq, current.requiredThroughEventSeq) < 0) {
            return RelayV2StateSyncResult.RotationRequired(
                namespace,
                RelayV2RotationReason.REQUIRED_WATERMARK_REGRESSED,
            )
        }

        val required = maxRelayV2Counter(current.requiredThroughEventSeq, hello.welcomeEventSeq)
        if (hello.disposition == RelayV2StateHelloDisposition.MATCHED) {
            val updated = current.copy(
                requiredThroughEventSeq = required,
                phase = RelayV2StoredSyncPhase.LIVE,
            )
            putAuthority(updated)
            deleteSnapshot(namespace)
            deleteBufferedEvents(namespace)
            return RelayV2StateSyncResult.Live(namespace, requireNotNull(updated.cursorEventSeq))
        }

        val updated = current.copy(
            requiredThroughEventSeq = required,
            phase = RelayV2StoredSyncPhase.RESYNCING,
        )
        putAuthority(updated)
        val staged = snapshot(namespace)
        if (staged != null &&
            compareRelayV2Counters(staged.throughEventSeq, required) < 0 &&
            !bufferCovers(this, namespace, staged.throughEventSeq, required)
        ) {
            deleteSnapshot(namespace)
            return RelayV2StateSyncResult.ResyncRequired(
                namespace,
                RelayV2ResyncReason.SNAPSHOT_RESTART_REQUIRED,
                staged.releaseDirective(),
            )
        }
        return RelayV2StateSyncResult.ResyncRequired(
            namespace,
            RelayV2ResyncReason.CURSOR_BEHIND,
        )
    }

    private fun bufferEventOrRestart(
        transaction: RelayV2StateTransaction,
        authority: RelayV2StoredAuthority,
        event: RelayV2StateEvent,
        reason: RelayV2ResyncReason,
    ): RelayV2StateSyncResult = with(transaction) {
        val canonical = event.canonicalJson()
        val existing = bufferedEvent(event.namespace, event.eventSeq)
        if (existing != null) {
            if (existing.canonicalJson == canonical) return RelayV2StateSyncResult.DuplicateEvent
            val release = snapshot(event.namespace)?.releaseDirective()
            deleteSnapshot(event.namespace)
            deleteBufferedEvents(event.namespace)
            return RelayV2StateSyncResult.ResyncRequired(
                event.namespace,
                RelayV2ResyncReason.EVENT_REVISION_CONFLICT,
                release,
            )
        }
        if (bufferedEventCount(event.namespace) + 1 > RelayV2StateLimits.MAX_BUFFERED_STATE_EVENTS ||
            bufferedEventRawBytes(event.namespace) + event.rawUtf8Bytes >
            RelayV2StateLimits.MAX_BUFFERED_STATE_EVENT_BYTES
        ) {
            val release = snapshot(event.namespace)?.releaseDirective()
            deleteSnapshot(event.namespace)
            deleteBufferedEvents(event.namespace)
            putAuthority(authority.copy(phase = RelayV2StoredSyncPhase.RESYNCING))
            return RelayV2StateSyncResult.ResyncRequired(
                event.namespace,
                RelayV2ResyncReason.EVENT_BUFFER_OVERFLOW,
                release,
            )
        }
        putBufferedEvent(
            RelayV2StoredEvent(
                event = event,
                eventSeqOrder = relayV2CounterOrder(event.eventSeq),
                canonicalJson = canonical,
            ),
        )
        return RelayV2StateSyncResult.ResyncRequired(event.namespace, reason)
    }

    private fun applyLiveEvent(
        transaction: RelayV2StateTransaction,
        authority: RelayV2StoredAuthority,
        event: RelayV2StateEvent,
    ): RelayV2StoredAuthority? = with(transaction) {
        val cursor = authority.cursorEventSeq ?: return null
        if (event.eventSeq != incrementRelayV2Counter(cursor)) return null
        var recordCount = authority.cacheRecordCount
        var jsonBytes = canonicalJsonBytesFromArray(authority.cacheCanonicalBytes, recordCount)
        var scopesRevision = authority.scopesRevision
        lateinit var mutation: () -> Unit

        when (val change = event.change) {
            is RelayV2StateChange.ScopeUpsert -> {
                val expected = scopesRevision?.let(::incrementRelayV2Counter) ?: return null
                if (event.resultingRevision != expected) return null
                val prior = scope(event.namespace, change.scopeId)
                val updated = storedScope(
                    event.namespace,
                    change.item,
                    prior?.sessionsRevision ?: "0",
                )
                if (prior == null) {
                    recordCount += 2
                    jsonBytes += updated.canonicalBytes
                } else {
                    jsonBytes += updated.canonicalBytes - prior.canonicalBytes
                }
                mutation = { putScope(updated) }
                scopesRevision = event.resultingRevision
            }
            is RelayV2StateChange.ScopeDelete -> {
                val expected = scopesRevision?.let(::incrementRelayV2Counter) ?: return null
                if (event.resultingRevision != expected) return null
                val prior = scope(event.namespace, change.scopeId) ?: return null
                val sessions = sessionStats(event.namespace, change.scopeId)
                recordCount -= 2 + sessions.count
                jsonBytes -= prior.canonicalBytes + sessions.canonicalBytes
                mutation = {
                    deleteSessionsForScope(event.namespace, change.scopeId)
                    deleteScope(event.namespace, change.scopeId)
                }
                scopesRevision = event.resultingRevision
            }
            is RelayV2StateChange.SessionUpsert -> {
                val owningScope = scope(event.namespace, change.scopeId) ?: return null
                val expected = incrementRelayV2Counter(owningScope.sessionsRevision)
                if (event.resultingRevision != expected) return null
                val prior = session(event.namespace, change.scopeId, change.item.sessionId)
                val updated = storedSession(event.namespace, change.item)
                if (prior == null) {
                    recordCount += 1
                    jsonBytes += updated.canonicalBytes
                } else {
                    jsonBytes += updated.canonicalBytes - prior.canonicalBytes
                }
                val updatedScope = storedScope(
                    event.namespace,
                    owningScope.item,
                    event.resultingRevision,
                )
                jsonBytes += updatedScope.canonicalBytes - owningScope.canonicalBytes
                mutation = {
                    putSession(updated)
                    putScope(updatedScope)
                }
            }
            is RelayV2StateChange.SessionDelete -> {
                val owningScope = scope(event.namespace, change.scopeId) ?: return null
                val expected = incrementRelayV2Counter(owningScope.sessionsRevision)
                if (event.resultingRevision != expected) return null
                val prior = session(event.namespace, change.scopeId, change.sessionId) ?: return null
                recordCount -= 1
                jsonBytes -= prior.canonicalBytes
                val updatedScope = storedScope(event.namespace, owningScope.item, event.resultingRevision)
                jsonBytes += updatedScope.canonicalBytes - owningScope.canonicalBytes
                mutation = {
                    deleteSession(event.namespace, change.scopeId, change.sessionId)
                    putScope(updatedScope)
                }
            }
        }
        val totalCanonicalBytes = canonicalArrayBytes(recordCount, jsonBytes)
        if (recordCount !in 0..RelayV2StateLimits.MAX_SNAPSHOT_RECORDS.toLong() ||
            totalCanonicalBytes > RelayV2StateLimits.MAX_SNAPSHOT_CANONICAL_BYTES
        ) {
            return null
        }
        mutation()
        authority.copy(
            cursorEventSeq = event.eventSeq,
            scopesRevision = scopesRevision,
            cacheRecordCount = recordCount,
            cacheCanonicalBytes = totalCanonicalBytes,
        )
    }

    private fun inspectStagedCut(
        transaction: RelayV2StateTransaction,
        staged: RelayV2StoredSnapshot,
    ): InspectedCut {
        val digest = MessageDigest.getInstance("SHA-256")
        digest.update("[".toByteArray(Charsets.UTF_8))
        var count = 0L
        var totalBytes = 1L
        transaction.visitSnapshotRecords(staged.namespace, staged.snapshotId) { record ->
            check(record.recordIndex == count) { "Snapshot staging index is not continuous" }
            if (count > 0) {
                digest.update(','.code.toByte())
                totalBytes += 1
            }
            val bytes = record.canonicalJson.toByteArray(Charsets.UTF_8)
            digest.update(bytes)
            totalBytes += bytes.size
            count += 1
        }
        digest.update("]".toByteArray(Charsets.UTF_8))
        totalBytes += 1
        return InspectedCut(
            recordCount = count,
            totalCanonicalBytes = totalBytes,
            digest = Base64.getUrlEncoder().withoutPadding().encodeToString(digest.digest()),
        )
    }

    private fun validateBufferedEvents(
        transaction: RelayV2StateTransaction,
        staged: RelayV2StoredSnapshot,
        events: List<RelayV2StoredEvent>,
    ): BufferedValidation {
        var lastSeq = staged.throughEventSeq
        var scopesRevision = staged.scopesRevision
        var recordCount = staged.totalRecords
        var jsonBytes = canonicalJsonBytesFromArray(staged.totalCanonicalBytes, recordCount)
        val scopes = mutableMapOf<String, SnapshotScopeShadow?>()
        val sessions = mutableMapOf<Pair<String, String>, RelayV2StoredSession?>()

        fun loadScope(scopeId: String): SnapshotScopeShadow? {
            if (scopes.containsKey(scopeId)) return scopes[scopeId]
            val stored = transaction.stagedScope(staged.namespace, staged.snapshotId, scopeId)
                ?: return null.also { scopes[scopeId] = null }
            val stats = transaction.stagedSessionStats(staged.namespace, staged.snapshotId, scopeId)
            return SnapshotScopeShadow(stored, stats.count, stats.canonicalBytes).also {
                scopes[scopeId] = it
            }
        }

        fun loadSession(scopeId: String, sessionId: String): RelayV2StoredSession? {
            val key = scopeId to sessionId
            if (sessions.containsKey(key)) return sessions[key]
            return transaction.stagedSession(
                staged.namespace,
                staged.snapshotId,
                scopeId,
                sessionId,
            ).also { sessions[key] = it }
        }

        for (storedEvent in events) {
            val event = storedEvent.event
            if (event.eventSeq != incrementRelayV2Counter(lastSeq)) {
                return BufferedValidation(lastSeq, RelayV2ResyncReason.EVENT_GAP)
            }
            when (val change = event.change) {
                is RelayV2StateChange.ScopeUpsert -> {
                    if (event.resultingRevision != incrementRelayV2Counter(scopesRevision)) {
                        return BufferedValidation(lastSeq, RelayV2ResyncReason.EVENT_REVISION_CONFLICT)
                    }
                    val prior = loadScope(change.scopeId)
                    val updated = storedScope(
                        staged.namespace,
                        change.item,
                        prior?.stored?.sessionsRevision ?: "0",
                    )
                    if (prior == null) {
                        recordCount += 2
                        jsonBytes += updated.canonicalBytes
                        scopes[change.scopeId] = SnapshotScopeShadow(updated, 0, 0)
                    } else {
                        jsonBytes += updated.canonicalBytes - prior.stored.canonicalBytes
                        prior.stored = updated
                    }
                    scopesRevision = event.resultingRevision
                }
                is RelayV2StateChange.ScopeDelete -> {
                    if (event.resultingRevision != incrementRelayV2Counter(scopesRevision)) {
                        return BufferedValidation(lastSeq, RelayV2ResyncReason.EVENT_REVISION_CONFLICT)
                    }
                    val prior = loadScope(change.scopeId)
                        ?: return BufferedValidation(lastSeq, RelayV2ResyncReason.EVENT_REVISION_CONFLICT)
                    recordCount -= 2 + prior.sessionCount
                    jsonBytes -= prior.stored.canonicalBytes + prior.sessionBytes
                    scopes[change.scopeId] = null
                    sessions.keys.removeAll { it.first == change.scopeId }
                    scopesRevision = event.resultingRevision
                }
                is RelayV2StateChange.SessionUpsert -> {
                    val owningScope = loadScope(change.scopeId)
                        ?: return BufferedValidation(lastSeq, RelayV2ResyncReason.EVENT_REVISION_CONFLICT)
                    if (event.resultingRevision != incrementRelayV2Counter(owningScope.stored.sessionsRevision)) {
                        return BufferedValidation(lastSeq, RelayV2ResyncReason.EVENT_REVISION_CONFLICT)
                    }
                    val prior = loadSession(change.scopeId, change.item.sessionId)
                    val updatedSession = storedSession(staged.namespace, change.item)
                    if (prior == null) {
                        recordCount += 1
                        jsonBytes += updatedSession.canonicalBytes
                        owningScope.sessionCount += 1
                        owningScope.sessionBytes += updatedSession.canonicalBytes
                    } else {
                        jsonBytes += updatedSession.canonicalBytes - prior.canonicalBytes
                        owningScope.sessionBytes += updatedSession.canonicalBytes - prior.canonicalBytes
                    }
                    sessions[change.scopeId to change.item.sessionId] = updatedSession
                    val updatedScope = storedScope(
                        staged.namespace,
                        owningScope.stored.item,
                        event.resultingRevision,
                    )
                    jsonBytes += updatedScope.canonicalBytes - owningScope.stored.canonicalBytes
                    owningScope.stored = updatedScope
                }
                is RelayV2StateChange.SessionDelete -> {
                    val owningScope = loadScope(change.scopeId)
                        ?: return BufferedValidation(lastSeq, RelayV2ResyncReason.EVENT_REVISION_CONFLICT)
                    if (event.resultingRevision != incrementRelayV2Counter(owningScope.stored.sessionsRevision)) {
                        return BufferedValidation(lastSeq, RelayV2ResyncReason.EVENT_REVISION_CONFLICT)
                    }
                    val prior = loadSession(change.scopeId, change.sessionId)
                        ?: return BufferedValidation(lastSeq, RelayV2ResyncReason.EVENT_REVISION_CONFLICT)
                    recordCount -= 1
                    jsonBytes -= prior.canonicalBytes
                    owningScope.sessionCount -= 1
                    owningScope.sessionBytes -= prior.canonicalBytes
                    sessions[change.scopeId to change.sessionId] = null
                    val updatedScope = storedScope(
                        staged.namespace,
                        owningScope.stored.item,
                        event.resultingRevision,
                    )
                    jsonBytes += updatedScope.canonicalBytes - owningScope.stored.canonicalBytes
                    owningScope.stored = updatedScope
                }
            }
            val totalBytes = canonicalArrayBytes(recordCount, jsonBytes)
            if (recordCount !in 0..RelayV2StateLimits.MAX_SNAPSHOT_RECORDS.toLong() ||
                totalBytes > RelayV2StateLimits.MAX_SNAPSHOT_CANONICAL_BYTES
            ) {
                return BufferedValidation(lastSeq, RelayV2ResyncReason.SNAPSHOT_LIMIT_EXCEEDED)
            }
            lastSeq = event.eventSeq
        }
        return BufferedValidation(lastSeq, null)
    }

    private data class SnapshotOrder(
        val scopeId: String?,
        val recordKind: String?,
        val sessionId: String?,
    ) {
        fun advance(record: RelayV2SnapshotRecord): SnapshotOrder? = when (record) {
            is RelayV2SnapshotRecord.Scope -> {
                if (scopeId != null &&
                    (recordKind == "scope" || compareUtf8(record.item.scopeId, scopeId) <= 0)
                ) {
                    null
                } else {
                    SnapshotOrder(record.item.scopeId, "scope", null)
                }
            }
            is RelayV2SnapshotRecord.SessionsScope -> {
                if (scopeId != record.scopeId || recordKind != "scope") null
                else SnapshotOrder(scopeId, "sessions_scope", null)
            }
            is RelayV2SnapshotRecord.Session -> {
                if (scopeId != record.scopeId ||
                    (recordKind != "sessions_scope" && recordKind != "session") ||
                    (sessionId != null && compareUtf8(record.item.sessionId, sessionId) <= 0)
                ) {
                    null
                } else {
                    SnapshotOrder(scopeId, "session", record.item.sessionId)
                }
            }
        }
    }

    private data class InspectedCut(
        val recordCount: Long,
        val totalCanonicalBytes: Long,
        val digest: String,
    )

    private data class BufferedValidation(
        val lastEventSeq: String,
        val failure: RelayV2ResyncReason?,
    )

    private data class SnapshotScopeShadow(
        var stored: RelayV2StoredScope,
        var sessionCount: Long,
        var sessionBytes: Long,
    )
}

private fun newAuthority(
    namespace: RelayV2StateNamespace,
    requiredThroughEventSeq: String,
): RelayV2StoredAuthority = RelayV2StoredAuthority(
    namespace = namespace,
    cursorEventSeq = null,
    requiredThroughEventSeq = requiredThroughEventSeq,
    scopesRevision = null,
    phase = RelayV2StoredSyncPhase.RESYNCING,
    cacheRecordCount = 0,
    cacheCanonicalBytes = 2,
)

private fun unknownEpoch(namespace: RelayV2StateNamespace) =
    RelayV2StateSyncResult.RotationRequired(
        namespace,
        RelayV2RotationReason.UNKNOWN_HOST_EPOCH,
    )

private fun RelayV2SnapshotChunk.releaseDirective() = RelayV2SnapshotReleaseDirective(
    namespace,
    snapshotRequestId,
    snapshotId,
)

private fun RelayV2StoredSnapshot.matchesFixedBinding(chunk: RelayV2SnapshotChunk): Boolean =
    namespace == chunk.namespace &&
        snapshotRequestId == chunk.snapshotRequestId &&
        snapshotId == chunk.snapshotId &&
        snapshotCreatedAtMs == chunk.snapshotCreatedAtMs &&
        snapshotAbsoluteExpiresAtMs == chunk.snapshotAbsoluteExpiresAtMs &&
        throughEventSeq == chunk.throughEventSeq &&
        scopesRevision == chunk.scopesRevision &&
        totalRecords == chunk.totalRecords &&
        totalCanonicalBytes == chunk.totalCanonicalBytes &&
        cutDigest == chunk.cutDigest

private fun storedScope(
    namespace: RelayV2StateNamespace,
    item: RelayV2ScopeResource,
    sessionsRevision: String,
): RelayV2StoredScope = RelayV2StoredScope(
    namespace = namespace,
    item = item,
    sessionsRevision = sessionsRevision,
    scopeRecordCanonicalJson = RelayV2SnapshotRecord.Scope(item).canonicalJson(),
    sessionsScopeRecordCanonicalJson = RelayV2SnapshotRecord.SessionsScope(
        item.scopeId,
        sessionsRevision,
    ).canonicalJson(),
)

private fun storedSession(
    namespace: RelayV2StateNamespace,
    item: RelayV2SessionResource,
): RelayV2StoredSession = RelayV2StoredSession(
    namespace = namespace,
    item = item,
    recordCanonicalJson = RelayV2SnapshotRecord.Session(item.scopeId, item).canonicalJson(),
)

private fun bufferCovers(
    transaction: RelayV2StateTransaction,
    namespace: RelayV2StateNamespace,
    fromExclusive: String,
    throughInclusive: String,
): Boolean {
    var expected = incrementRelayV2Counter(fromExclusive)
    transaction.bufferedEvents(namespace).forEach { stored ->
        val seq = stored.event.eventSeq
        if (compareRelayV2Counters(seq, fromExclusive) <= 0) return@forEach
        if (compareRelayV2Counters(seq, throughInclusive) > 0) return@forEach
        if (seq != expected) return false
        if (seq == throughInclusive) return true
        expected = incrementRelayV2Counter(expected)
    }
    return compareRelayV2Counters(fromExclusive, throughInclusive) >= 0
}

private fun maxRelayV2Counter(left: String, right: String): String =
    if (compareRelayV2Counters(left, right) >= 0) left else right

private fun canonicalArrayBytes(canonicalRecords: List<String>): Long =
    2L + canonicalRecords.sumOf { it.toByteArray(Charsets.UTF_8).size.toLong() } +
        max(0, canonicalRecords.size - 1)

private fun canonicalArrayBytes(recordCount: Long, recordJsonBytes: Long): Long =
    2L + recordJsonBytes + max(0L, recordCount - 1)

private fun canonicalJsonBytesFromArray(totalCanonicalBytes: Long, recordCount: Long): Long =
    totalCanonicalBytes - 2L - max(0L, recordCount - 1)

private fun compareUtf8(left: String, right: String): Int {
    val leftBytes = left.toByteArray(Charsets.UTF_8)
    val rightBytes = right.toByteArray(Charsets.UTF_8)
    val common = minOf(leftBytes.size, rightBytes.size)
    for (index in 0 until common) {
        val comparison = (leftBytes[index].toInt() and 0xff).compareTo(
            rightBytes[index].toInt() and 0xff,
        )
        if (comparison != 0) return comparison
    }
    return leftBytes.size.compareTo(rightBytes.size)
}
