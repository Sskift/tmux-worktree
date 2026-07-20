package com.tmuxworktree.mobile.core.relay.v2.state

import com.tmuxworktree.mobile.core.relay.v2.profile.RelayProfileDialect
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayProfileDisconnectReceipt
import java.security.MessageDigest
import java.util.Base64
import kotlin.math.max

internal data class RelayV2MaterializedSessionReadCut(
    val namespace: RelayV2StateNamespace,
    val cursor: RelayV2AppliedCursor,
    val scopesRevision: String,
    val scope: RelayV2ScopeResource,
    val sessionsRevision: String,
    val session: RelayV2SessionResource,
) {
    init {
        require(cursor.hostEpoch == namespace.hostEpoch)
        requireRelayV2Counter(scopesRevision)
        requireRelayV2Counter(sessionsRevision)
        require(scope.scopeId == session.scopeId)
    }
}

/** Exact committed Session projection consumed only behind an actor-issued current lease. */
internal interface RelayV2MaterializedSessionReadAuthority {
    suspend fun readMaterializedSessionCuts(
        namespace: RelayV2StateNamespace,
    ): List<RelayV2MaterializedSessionReadCut>

    suspend fun readMaterializedSessionCut(
        namespace: RelayV2StateNamespace,
        scopeId: String,
        sessionId: String,
    ): RelayV2MaterializedSessionReadCut?
}

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
) : RelayV2StateSyncAuthority,
    RelayV2MaterializedSessionReadAuthority {
    /** Reads the complete committed Session projection for one exact durable namespace. */
    override suspend fun readMaterializedSessionCuts(
        namespace: RelayV2StateNamespace,
    ): List<RelayV2MaterializedSessionReadCut> = store.transaction {
        val storedAuthority = authority(namespace)
        val storedScopes = scopes(namespace)
        val storedSessions = sessions(namespace)
        if (storedAuthority == null) {
            check(storedScopes.isEmpty() && storedSessions.isEmpty()) {
                "Relay v2 materialized projection exists without authority"
            }
            return@transaction emptyList()
        }
        check(storedAuthority.namespace == namespace) {
            "Relay v2 materialized projection crossed authority namespace"
        }
        storedAuthority.validatedPendingRelease()
        val cursorEventSeq = storedAuthority.cursorEventSeq
        val scopesRevision = storedAuthority.scopesRevision
        check((cursorEventSeq == null) == (scopesRevision == null)) {
            "Relay v2 committed cursor and scopes revision disagree"
        }
        if (cursorEventSeq == null) {
            check(storedAuthority.phase == RelayV2StoredSyncPhase.RESYNCING) {
                "Relay v2 LIVE authority has no committed materialized cut"
            }
            check(storedScopes.isEmpty() && storedSessions.isEmpty()) {
                "Relay v2 materialized projection exists without a committed cut"
            }
            return@transaction emptyList()
        }
        val committedScopesRevision = checkNotNull(scopesRevision)
        requireRelayV2Counter(cursorEventSeq)
        requireRelayV2Counter(committedScopesRevision)
        val scopesById = storedScopes.associateBy { storedScope ->
            check(storedScope.namespace == namespace) {
                "Relay v2 materialized scope crossed its exact namespace"
            }
            requireRelayV2Counter(storedScope.sessionsRevision)
            storedScope.item.scopeId
        }
        check(scopesById.size == storedScopes.size) {
            "Relay v2 materialized projection contains duplicate scopes"
        }
        storedSessions.map { storedSession ->
            check(storedSession.namespace == namespace) {
                "Relay v2 materialized session crossed its exact namespace"
            }
            val exactScope = checkNotNull(scopesById[storedSession.item.scopeId]) {
                "Relay v2 materialized session is orphaned from its scope"
            }
            RelayV2MaterializedSessionReadCut(
                namespace = namespace,
                cursor = RelayV2AppliedCursor(namespace.hostEpoch, cursorEventSeq),
                scopesRevision = committedScopesRevision,
                scope = exactScope.item,
                sessionsRevision = exactScope.sessionsRevision,
                session = storedSession.item,
            )
        }.sortedWith(compareBy({ it.session.scopeId }, { it.session.sessionId }))
    }

    /**
     * Reads one exact committed materialized session cut. A RESYNCING authority may still expose
     * its last committed cut; that is durable cache history, not an attestation that the network
     * source is current. Snapshot staging is deliberately outside this read path.
     */
    override suspend fun readMaterializedSessionCut(
        namespace: RelayV2StateNamespace,
        scopeId: String,
        sessionId: String,
    ): RelayV2MaterializedSessionReadCut? {
        requireRelayV2Id(scopeId)
        requireRelayV2Id(sessionId)
        return store.transaction {
            val storedAuthority = authority(namespace)
            val storedScope = scope(namespace, scopeId)
            val storedSession = session(namespace, scopeId, sessionId)

            if (storedAuthority == null) {
                check(storedScope == null && storedSession == null) {
                    "Relay v2 materialized session exists without authority"
                }
                return@transaction null
            }
            check(storedAuthority.namespace == namespace) {
                "Relay v2 materialized session crossed authority namespace"
            }
            storedAuthority.validatedPendingRelease()
            val cursorEventSeq = storedAuthority.cursorEventSeq
            val scopesRevision = storedAuthority.scopesRevision
            check((cursorEventSeq == null) == (scopesRevision == null)) {
                "Relay v2 committed cursor and scopes revision disagree"
            }
            if (cursorEventSeq == null) {
                check(storedAuthority.phase == RelayV2StoredSyncPhase.RESYNCING) {
                    "Relay v2 LIVE authority has no committed materialized cut"
                }
                check(storedScope == null && storedSession == null) {
                    "Relay v2 materialized session exists without a committed cut"
                }
                return@transaction null
            }
            val committedScopesRevision = checkNotNull(scopesRevision)
            requireRelayV2Counter(cursorEventSeq)
            requireRelayV2Counter(committedScopesRevision)
            check(storedScope != null || storedSession == null) {
                "Relay v2 materialized session is orphaned from its scope"
            }
            val exactScope = storedScope ?: return@transaction null
            check(exactScope.namespace == namespace && exactScope.item.scopeId == scopeId) {
                "Relay v2 materialized scope crossed its exact identity"
            }
            requireRelayV2Counter(exactScope.sessionsRevision)
            val exactSession = storedSession ?: return@transaction null
            check(exactSession.namespace == namespace &&
                exactSession.item.scopeId == scopeId &&
                exactSession.item.sessionId == sessionId &&
                exactSession.item.scopeId == exactScope.item.scopeId
            ) {
                "Relay v2 materialized session crossed its exact scope identity"
            }
            RelayV2MaterializedSessionReadCut(
                namespace = namespace,
                cursor = RelayV2AppliedCursor(namespace.hostEpoch, cursorEventSeq),
                scopesRevision = committedScopesRevision,
                scope = exactScope.item,
                sessionsRevision = exactScope.sessionsRevision,
                session = exactSession.item,
            )
        }
    }

    override suspend fun loadConnectPlan(
        identity: RelayV2StateConnectIdentity,
    ): RelayV2StateConnectPlan = store.transaction {
        val matches = authorities(identity)
        check(matches.size <= 1) {
            "Relay v2 durable resume is ambiguous across host epochs"
        }
        val authority = matches.singleOrNull()
            ?: return@transaction RelayV2StateConnectPlan(
                identity,
                resume = null,
                recovery = RelayV2StateConnectRecovery.EMPTY,
                durableHostEpoch = null,
                requiredThroughEventSeq = null,
            )
        val pendingRelease = authority.validatedPendingRelease()
        check(authority.namespace.profileId == identity.profileId &&
            authority.namespace.principalId == identity.principalId &&
            authority.namespace.clientInstanceId == identity.clientInstanceId &&
            authority.namespace.hostId == identity.hostId
        ) { "Relay v2 durable resume crossed profile authority" }
        if (authority.phase == RelayV2StoredSyncPhase.LIVE) {
            check(authority.cursorEventSeq != null && pendingRelease == null) {
                "Relay v2 LIVE authority has no usable durable cursor"
            }
        }
        val staged = snapshot(authority.namespace)
        check(authority.phase == RelayV2StoredSyncPhase.RESYNCING || staged == null) {
            "Relay v2 LIVE authority retained snapshot staging"
        }
        RelayV2StateConnectPlan(
            identity = identity,
            resume = authority.cursorEventSeq?.let {
                RelayV2AppliedCursor(authority.namespace.hostEpoch, it)
            },
            recovery = when {
                authority.pendingRelease != null -> RelayV2StateConnectRecovery.RELEASE_PENDING
                authority.phase == RelayV2StoredSyncPhase.LIVE -> RelayV2StateConnectRecovery.LIVE
                else -> RelayV2StateConnectRecovery.RESYNCING
            },
            durableHostEpoch = authority.namespace.hostEpoch,
            requiredThroughEventSeq = authority.requiredThroughEventSeq,
            snapshotRequestId = staged?.snapshotRequestId,
            snapshotId = staged?.snapshotId,
            snapshotNextCursor = staged?.nextCursor,
            snapshotNextChunkIndex = staged?.nextChunkIndex,
            snapshotComplete = staged?.complete,
            releaseObligationToken = pendingRelease?.opaqueToken,
        )
    }

    override suspend fun applyHelloUnderApplyLease(
        connectPlan: RelayV2StateConnectPlan,
        hello: RelayV2StateHello,
    ): RelayV2StateSyncResult =
        store.transaction {
            val namespace = hello.namespace
            val current = authority(namespace)
            if (hello.disposition == RelayV2StateHelloDisposition.EVENT_CURSOR_AHEAD) {
                return@transaction RelayV2StateSyncResult.RotationRequired(
                    namespace,
                    RelayV2RotationReason.EVENT_CURSOR_AHEAD,
                )
            }
            check(connectPlan.identity == namespace.connectIdentity() &&
                connectPlan.resume == hello.resume
            ) { "Relay v2 hello crossed its frozen durable connect plan" }
            validateConnectPlan(this, connectPlan)
            if (current != null &&
                compareRelayV2Counters(
                    hello.welcomeEventSeq,
                    current.requiredThroughEventSeq,
                ) < 0
            ) {
                return@transaction RelayV2StateSyncResult.RotationRequired(
                    namespace,
                    RelayV2RotationReason.REQUIRED_WATERMARK_REGRESSED,
                )
            }
            current?.pendingRelease?.let { pending ->
                val required = maxRelayV2Counter(
                    current.requiredThroughEventSeq,
                    hello.welcomeEventSeq,
                )
                val afterRelease = if (
                    current.afterReleasePhase ==
                    RelayV2PostReleasePhase.QUERY_PENDING_COMMANDS &&
                    hello.disposition != RelayV2StateHelloDisposition.FRESH &&
                    hello.disposition != RelayV2StateHelloDisposition.HOST_EPOCH_CHANGED &&
                    pending.durableCursorEventSeq != null &&
                    compareRelayV2Counters(pending.durableCursorEventSeq, required) >= 0
                ) {
                    RelayV2PostReleasePhase.QUERY_PENDING_COMMANDS
                } else {
                    RelayV2PostReleasePhase.RESTART_SNAPSHOT
                }
                putAuthority(current.copy(
                    requiredThroughEventSeq = required,
                    phase = RelayV2StoredSyncPhase.RESYNCING,
                    afterReleasePhase = afterRelease,
                ))
                return@transaction RelayV2StateSyncResult.ReleasePending(
                    namespace,
                    pending,
                    afterRelease,
                )
            }

            when (hello.disposition) {
                RelayV2StateHelloDisposition.FRESH -> {
                    if (connectPlan.recovery == RelayV2StateConnectRecovery.RESYNCING &&
                        connectPlan.durableHostEpoch == namespace.hostEpoch
                    ) {
                        return@transaction applySameEpochWelcome(this, current, hello)
                    }
                    connectPlan.durableHostEpoch
                        ?.takeIf { it != namespace.hostEpoch }
                        ?.let { deleteNamespaceState(namespace.copy(hostEpoch = it)) }
                    val staged = current?.let { snapshot(it.namespace) }
                    deleteNamespaceState(namespace)
                    val authority = newAuthority(namespace, hello.welcomeEventSeq)
                    val release = staged?.let {
                        authority.releaseObligation(
                            it.releaseDirective(),
                            RelayV2SnapshotReleaseReason.FRESH,
                        )
                    }
                    val afterRelease = release?.let {
                        RelayV2PostReleasePhase.RESTART_SNAPSHOT
                    }
                    putAuthority(authority.copy(
                        pendingRelease = release,
                        afterReleasePhase = afterRelease,
                    ))
                    RelayV2StateSyncResult.ResyncRequired(
                        namespace,
                        RelayV2ResyncReason.FRESH,
                        release,
                        afterRelease,
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

    private fun validateConnectPlan(
        transaction: RelayV2StateTransaction,
        plan: RelayV2StateConnectPlan,
    ) = with(transaction) {
        val matches = authorities(plan.identity)
        if (plan.recovery == RelayV2StateConnectRecovery.EMPTY) {
            check(matches.isEmpty()) { "Relay v2 EMPTY connect plan became stale" }
            return@with
        }
        check(matches.size == 1) { "Relay v2 durable connect plan is no longer unique" }
        val authority = matches.single()
        check(authority.namespace.hostEpoch == plan.durableHostEpoch) {
            "Relay v2 durable connect epoch changed after the connection barrier"
        }
        val pending = authority.validatedPendingRelease()
        val actualRecovery = when {
            pending != null -> RelayV2StateConnectRecovery.RELEASE_PENDING
            authority.phase == RelayV2StoredSyncPhase.LIVE -> RelayV2StateConnectRecovery.LIVE
            else -> RelayV2StateConnectRecovery.RESYNCING
        }
        check(actualRecovery == plan.recovery &&
            authority.cursorEventSeq == plan.resume?.eventSeq &&
            authority.requiredThroughEventSeq == plan.requiredThroughEventSeq &&
            pending?.opaqueToken == plan.releaseObligationToken
        ) { "Relay v2 durable connect plan changed after the connection barrier" }
        val staged = snapshot(authority.namespace)
        check(staged?.snapshotRequestId == plan.snapshotRequestId &&
            staged?.snapshotId == plan.snapshotId &&
            staged?.nextCursor == plan.snapshotNextCursor &&
            staged?.nextChunkIndex == plan.snapshotNextChunkIndex &&
            staged?.complete == plan.snapshotComplete
        ) { "Relay v2 snapshot continuation changed after the connection barrier" }
    }

    override suspend fun stageSnapshotChunkUnderApplyLease(
        chunk: RelayV2SnapshotChunk,
    ): RelayV2StateSyncResult = store.transaction {
        val authority = authority(chunk.namespace)
            ?: return@transaction unknownEpoch(chunk.namespace)
        authority.pendingRelease?.let { pending ->
            return@transaction RelayV2StateSyncResult.ReleasePending(
                chunk.namespace,
                pending,
                requireNotNull(authority.afterReleasePhase),
            )
        }
        if (authority.phase != RelayV2StoredSyncPhase.RESYNCING) {
            return@transaction RelayV2StateSyncResult.ResyncRequired(
                chunk.namespace,
                RelayV2ResyncReason.SNAPSHOT_RESTART_REQUIRED,
            )
        }

        val existing = snapshot(chunk.namespace)
        val release = existing?.releaseDirective() ?: chunk.releaseDirective()
        fun reject(reason: RelayV2ResyncReason): RelayV2StateSyncResult {
            val obligation = authority.releaseObligation(
                release,
                RelayV2SnapshotReleaseReason.valueOf(reason.name),
            )
            putAuthority(authority.copy(
                phase = RelayV2StoredSyncPhase.RESYNCING,
                pendingRelease = obligation,
                afterReleasePhase = RelayV2PostReleasePhase.RESTART_SNAPSHOT,
            ))
            deleteSnapshot(chunk.namespace)
            deleteBufferedEvents(chunk.namespace)
            return RelayV2StateSyncResult.ResyncRequired(
                chunk.namespace,
                reason,
                obligation,
                RelayV2PostReleasePhase.RESTART_SNAPSHOT,
            )
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
        val newCanonicalArrayBytes = canonicalArrayBytes(newRecordCount, newRecordBytes)
        val newRawBytes = base.receivedRawUtf8Bytes + chunk.rawUtf8Bytes
        if (newRecordCount > base.totalRecords ||
            newRecordCount > RelayV2StateLimits.MAX_SNAPSHOT_RECORDS ||
            newCanonicalArrayBytes > base.totalCanonicalBytes ||
            newCanonicalArrayBytes > RelayV2StateLimits.MAX_SNAPSHOT_CANONICAL_BYTES ||
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

    override suspend fun applyStateEventUnderApplyLease(
        event: RelayV2StateEvent,
    ): RelayV2StateSyncResult = store.transaction {
        val storedAuthority = authority(event.namespace)
            ?: return@transaction unknownEpoch(event.namespace)
        val cursor = storedAuthority.cursorEventSeq
        if (cursor != null && compareRelayV2Counters(event.eventSeq, cursor) <= 0) {
            return@transaction RelayV2StateSyncResult.DuplicateEvent
        }
        val required = maxRelayV2Counter(
            storedAuthority.requiredThroughEventSeq,
            event.eventSeq,
        )
        val pending = storedAuthority.pendingRelease
        val afterRelease = pending?.let {
            if (storedAuthority.afterReleasePhase ==
                RelayV2PostReleasePhase.QUERY_PENDING_COMMANDS &&
                it.durableCursorEventSeq != null &&
                compareRelayV2Counters(it.durableCursorEventSeq, required) >= 0
            ) {
                RelayV2PostReleasePhase.QUERY_PENDING_COMMANDS
            } else {
                RelayV2PostReleasePhase.RESTART_SNAPSHOT
            }
        }
        val authority = storedAuthority.copy(
            requiredThroughEventSeq = required,
            afterReleasePhase = afterRelease,
            phase = if (pending != null) {
                RelayV2StoredSyncPhase.RESYNCING
            } else {
                storedAuthority.phase
            },
        )
        putAuthority(authority)
        if (pending != null) {
            return@transaction bufferEventWhileReleasePending(
                transaction = this,
                authority = authority,
                event = event,
            )
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

    override suspend fun commitSnapshotUnderApplyLease(
        namespace: RelayV2StateNamespace,
        snapshotId: String,
    ): RelayV2StateSyncResult = store.transaction {
        val authority = authority(namespace) ?: return@transaction unknownEpoch(namespace)
        authority.pendingRelease?.let { pending ->
            return@transaction RelayV2StateSyncResult.ReleasePending(
                namespace,
                pending,
                requireNotNull(authority.afterReleasePhase),
            )
        }
        val staged = snapshot(namespace)
            ?: return@transaction RelayV2StateSyncResult.ResyncRequired(
                namespace,
                RelayV2ResyncReason.SNAPSHOT_RESTART_REQUIRED,
                durableCursorEventSeq = authority.cursorEventSeq,
            )
        if (staged.snapshotId != snapshotId) {
            val release = authority.releaseObligation(
                staged.releaseDirective(),
                RelayV2SnapshotReleaseReason.SNAPSHOT_IDENTITY_CONFLICT,
            )
            putAuthority(authority.copy(
                phase = RelayV2StoredSyncPhase.RESYNCING,
                pendingRelease = release,
                afterReleasePhase = RelayV2PostReleasePhase.RESTART_SNAPSHOT,
            ))
            deleteSnapshot(namespace)
            deleteBufferedEvents(namespace)
            return@transaction RelayV2StateSyncResult.ResyncRequired(
                namespace,
                RelayV2ResyncReason.SNAPSHOT_IDENTITY_CONFLICT,
                release,
                RelayV2PostReleasePhase.RESTART_SNAPSHOT,
            )
        }
        if (!staged.complete) {
            val release = authority.releaseObligation(
                staged.releaseDirective(),
                RelayV2SnapshotReleaseReason.SNAPSHOT_INCOMPLETE,
            )
            putAuthority(authority.copy(
                phase = RelayV2StoredSyncPhase.RESYNCING,
                pendingRelease = release,
                afterReleasePhase = RelayV2PostReleasePhase.RESTART_SNAPSHOT,
            ))
            deleteSnapshot(namespace)
            deleteBufferedEvents(namespace)
            return@transaction RelayV2StateSyncResult.ResyncRequired(
                namespace,
                RelayV2ResyncReason.SNAPSHOT_INCOMPLETE,
                release,
                RelayV2PostReleasePhase.RESTART_SNAPSHOT,
            )
        }

        val actual = inspectStagedCut(this, staged)
        if (actual.recordCount != staged.totalRecords ||
            actual.totalCanonicalBytes != staged.totalCanonicalBytes
        ) {
            val release = authority.releaseObligation(
                staged.releaseDirective(),
                RelayV2SnapshotReleaseReason.SNAPSHOT_COUNT_MISMATCH,
            )
            putAuthority(authority.copy(
                phase = RelayV2StoredSyncPhase.RESYNCING,
                pendingRelease = release,
                afterReleasePhase = RelayV2PostReleasePhase.RESTART_SNAPSHOT,
            ))
            deleteSnapshot(namespace)
            deleteBufferedEvents(namespace)
            return@transaction RelayV2StateSyncResult.ResyncRequired(
                namespace,
                RelayV2ResyncReason.SNAPSHOT_COUNT_MISMATCH,
                release,
                RelayV2PostReleasePhase.RESTART_SNAPSHOT,
            )
        }
        if (actual.digest != staged.cutDigest) {
            val release = authority.releaseObligation(
                staged.releaseDirective(),
                RelayV2SnapshotReleaseReason.SNAPSHOT_DIGEST_MISMATCH,
            )
            putAuthority(authority.copy(
                phase = RelayV2StoredSyncPhase.RESYNCING,
                pendingRelease = release,
                afterReleasePhase = RelayV2PostReleasePhase.RESTART_SNAPSHOT,
            ))
            deleteSnapshot(namespace)
            deleteBufferedEvents(namespace)
            return@transaction RelayV2StateSyncResult.ResyncRequired(
                namespace,
                RelayV2ResyncReason.SNAPSHOT_DIGEST_MISMATCH,
                release,
                RelayV2PostReleasePhase.RESTART_SNAPSHOT,
            )
        }

        val buffered = bufferedEvents(namespace)
            .filter { compareRelayV2Counters(it.event.eventSeq, staged.throughEventSeq) > 0 }
        val validation = validateBufferedEvents(this, staged, buffered)
        if (validation.failure != null ||
            compareRelayV2Counters(validation.lastEventSeq, authority.requiredThroughEventSeq) < 0
        ) {
            val reason = validation.failure ?: RelayV2ResyncReason.EVENT_GAP
            val release = authority.releaseObligation(
                staged.releaseDirective(),
                RelayV2SnapshotReleaseReason.valueOf(reason.name),
            )
            putAuthority(authority.copy(
                phase = RelayV2StoredSyncPhase.RESYNCING,
                pendingRelease = release,
                afterReleasePhase = RelayV2PostReleasePhase.RESTART_SNAPSHOT,
            ))
            deleteSnapshot(namespace)
            deleteBufferedEvents(namespace)
            return@transaction RelayV2StateSyncResult.ResyncRequired(
                namespace,
                reason,
                release,
                RelayV2PostReleasePhase.RESTART_SNAPSHOT,
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
        val release = committedAuthority.releaseObligation(
            staged.releaseDirective(),
            RelayV2SnapshotReleaseReason.COMPLETED,
        )
        committedAuthority = committedAuthority.copy(
            phase = RelayV2StoredSyncPhase.RESYNCING,
            pendingRelease = release,
            afterReleasePhase = RelayV2PostReleasePhase.QUERY_PENDING_COMMANDS,
        )
        putAuthority(committedAuthority)
        deleteSnapshot(namespace)
        deleteBufferedEvents(namespace)
        RelayV2StateSyncResult.SnapshotCommitted(
            namespace,
            requireNotNull(committedAuthority.cursorEventSeq),
            release,
            RelayV2PostReleasePhase.QUERY_PENDING_COMMANDS,
        )
    }

    suspend fun discardSnapshotUnderApplyLease(
        namespace: RelayV2StateNamespace,
    ): RelayV2SnapshotReleaseObligation? = store.transaction {
        val authority = authority(namespace) ?: return@transaction null
        authority.pendingRelease?.let { return@transaction it }
        val release = snapshot(namespace)?.releaseDirective()?.let { directive ->
            authority.releaseObligation(
                directive,
                RelayV2SnapshotReleaseReason.SNAPSHOT_RESTART_REQUIRED,
            )
        }
        if (release != null) {
            putAuthority(authority.copy(
                phase = RelayV2StoredSyncPhase.RESYNCING,
                pendingRelease = release,
                afterReleasePhase = RelayV2PostReleasePhase.RESTART_SNAPSHOT,
            ))
        }
        deleteSnapshot(namespace)
        deleteBufferedEvents(namespace)
        release
    }

    override suspend fun completeSnapshotReleaseUnderApplyLease(
        expected: RelayV2SnapshotReleaseObligation,
    ): RelayV2SnapshotReleaseCompletion? = store.transaction {
        val authority = authority(expected.namespace) ?: return@transaction null
        val pending = authority.validatedPendingRelease()
        if (pending != expected) return@transaction null
        val afterRelease = requireNotNull(authority.afterReleasePhase)
        putAuthority(authority.copy(
            pendingRelease = null,
            afterReleasePhase = null,
            phase = when (afterRelease) {
                RelayV2PostReleasePhase.RESTART_SNAPSHOT -> RelayV2StoredSyncPhase.RESYNCING
                RelayV2PostReleasePhase.QUERY_PENDING_COMMANDS -> RelayV2StoredSyncPhase.LIVE
            },
        ))
        RelayV2SnapshotReleaseCompletion(expected, afterRelease)
    }

    override suspend fun expireSnapshotContinuationUnderApplyLease(
        namespace: RelayV2StateNamespace,
        snapshotRequestId: String,
        snapshotId: String,
    ): RelayV2StateSyncResult = store.transaction {
        val authority = authority(namespace) ?: return@transaction unknownEpoch(namespace)
        authority.pendingRelease?.let { pending ->
            return@transaction RelayV2StateSyncResult.ReleasePending(
                namespace,
                pending,
                requireNotNull(authority.afterReleasePhase),
            )
        }
        val staged = snapshot(namespace)
            ?: return@transaction RelayV2StateSyncResult.ResyncRequired(
                namespace,
                RelayV2ResyncReason.SNAPSHOT_RESTART_REQUIRED,
                durableCursorEventSeq = authority.cursorEventSeq,
            )
        if (staged.snapshotRequestId != snapshotRequestId || staged.snapshotId != snapshotId) {
            return@transaction RelayV2StateSyncResult.RotationRequired(
                namespace,
                RelayV2RotationReason.UNKNOWN_HOST_EPOCH,
            )
        }
        putAuthority(authority.copy(phase = RelayV2StoredSyncPhase.RESYNCING))
        deleteSnapshot(namespace)
        deleteBufferedEvents(namespace)
        RelayV2StateSyncResult.SnapshotExpired(
            namespace,
            snapshotRequestId,
            snapshotId,
            authority.cursorEventSeq,
        )
    }

    /**
     * The receipt is the authority to clear after the actor has fenced and drained the profile.
     * The Room adapter clears every v2 category in the independent state database in this same
     * transaction, including durable Outbox and terminal checkpoints.
     */
    suspend fun clearProfileAfterDisconnect(receipt: RelayProfileDisconnectReceipt) {
        require(receipt.profile.dialect == RelayProfileDialect.V2)
        require(receipt.profile.profileId.isNotBlank())
        require(receipt.profile.activationGeneration > 0)
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
            val staged = snapshot(namespace)
            if (staged != null) {
                val release = updated.releaseObligation(
                    staged.releaseDirective(),
                    RelayV2SnapshotReleaseReason.SNAPSHOT_RESTART_REQUIRED,
                )
                putAuthority(updated.copy(
                    phase = RelayV2StoredSyncPhase.RESYNCING,
                    pendingRelease = release,
                    afterReleasePhase = RelayV2PostReleasePhase.QUERY_PENDING_COMMANDS,
                ))
                deleteSnapshot(namespace)
                deleteBufferedEvents(namespace)
                return RelayV2StateSyncResult.ReleasePending(
                    namespace,
                    release,
                    RelayV2PostReleasePhase.QUERY_PENDING_COMMANDS,
                )
            }
            putAuthority(updated)
            deleteSnapshot(namespace)
            deleteBufferedEvents(namespace)
            return RelayV2StateSyncResult.Live(namespace, requireNotNull(updated.cursorEventSeq))
        }

        val updated = if (hello.disposition == RelayV2StateHelloDisposition.FRESH) {
            // A fresh hello has no durable materialized cursor. Preserve staging long enough to
            // continue or release its pinned host cut below, but reset the exact local cache now.
            deleteSessions(namespace)
            deleteScopes(namespace)
            newAuthority(namespace, required)
        } else {
            current.copy(
                requiredThroughEventSeq = required,
                phase = RelayV2StoredSyncPhase.RESYNCING,
            )
        }
        putAuthority(updated)
        val staged = snapshot(namespace)
        if (staged?.complete == true ||
            (staged != null &&
                compareRelayV2Counters(staged.throughEventSeq, required) < 0 &&
                !bufferCovers(this, namespace, staged.throughEventSeq, required))
        ) {
            val pinned = requireNotNull(staged)
            val release = updated.releaseObligation(
                pinned.releaseDirective(),
                RelayV2SnapshotReleaseReason.SNAPSHOT_RESTART_REQUIRED,
            )
            putAuthority(updated.copy(
                pendingRelease = release,
                afterReleasePhase = RelayV2PostReleasePhase.RESTART_SNAPSHOT,
            ))
            deleteSnapshot(namespace)
            deleteBufferedEvents(namespace)
            return RelayV2StateSyncResult.ResyncRequired(
                namespace,
                RelayV2ResyncReason.SNAPSHOT_RESTART_REQUIRED,
                release,
                RelayV2PostReleasePhase.RESTART_SNAPSHOT,
            )
        }
        val continuation = staged?.takeIf { !it.complete && it.nextCursor != null }?.let {
            RelayV2StateSnapshotContinuation(
                it.snapshotRequestId,
                it.snapshotId,
                requireNotNull(it.nextCursor),
                it.nextChunkIndex,
            )
        }
        return RelayV2StateSyncResult.ResyncRequired(
            namespace,
            RelayV2ResyncReason.CURSOR_BEHIND,
            durableCursorEventSeq = current.cursorEventSeq,
            continuation = continuation,
        )
    }

    private fun bufferEventWhileReleasePending(
        transaction: RelayV2StateTransaction,
        authority: RelayV2StoredAuthority,
        event: RelayV2StateEvent,
    ): RelayV2StateSyncResult = with(transaction) {
        val release = authority.validatedPendingRelease()
            ?: error("Release-pending event lost its durable obligation")
        val restart = RelayV2PostReleasePhase.RESTART_SNAPSHOT
        val updated = authority.copy(
            phase = RelayV2StoredSyncPhase.RESYNCING,
            afterReleasePhase = restart,
        )
        putAuthority(updated)
        val canonical = event.canonicalJson()
        val existing = bufferedEvent(event.namespace, event.eventSeq)
        if (existing != null) {
            if (existing.canonicalJson == canonical) return RelayV2StateSyncResult.DuplicateEvent
            deleteBufferedEvents(event.namespace)
            return RelayV2StateSyncResult.ReleasePending(event.namespace, release, restart)
        }
        if (bufferedEventCount(event.namespace) + 1 >
            RelayV2StateLimits.MAX_BUFFERED_STATE_EVENTS ||
            bufferedEventRawBytes(event.namespace) + event.rawUtf8Bytes >
            RelayV2StateLimits.MAX_BUFFERED_STATE_EVENT_BYTES
        ) {
            deleteBufferedEvents(event.namespace)
            return RelayV2StateSyncResult.ReleasePending(event.namespace, release, restart)
        }
        putBufferedEvent(
            RelayV2StoredEvent(
                event = event,
                eventSeqOrder = relayV2CounterOrder(event.eventSeq),
                canonicalJson = canonical,
            ),
        )
        RelayV2StateSyncResult.EventBuffered(
            namespace = event.namespace,
            eventSeq = event.eventSeq,
            durableCursorEventSeq = updated.cursorEventSeq,
            requiredThroughEventSeq = updated.requiredThroughEventSeq,
            recoveryAction = RelayV2BufferedRecoveryAction.CONTINUE_CURRENT,
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
            val release = snapshot(event.namespace)?.releaseDirective()?.let { directive ->
                authority.releaseObligation(
                    directive,
                    RelayV2SnapshotReleaseReason.EVENT_REVISION_CONFLICT,
                )
            }
            if (release != null) {
                putAuthority(authority.copy(
                    phase = RelayV2StoredSyncPhase.RESYNCING,
                    pendingRelease = release,
                    afterReleasePhase = RelayV2PostReleasePhase.RESTART_SNAPSHOT,
                ))
            }
            deleteSnapshot(event.namespace)
            deleteBufferedEvents(event.namespace)
            return RelayV2StateSyncResult.ResyncRequired(
                event.namespace,
                RelayV2ResyncReason.EVENT_REVISION_CONFLICT,
                release,
                release?.let { RelayV2PostReleasePhase.RESTART_SNAPSHOT },
                durableCursorEventSeq = authority.cursorEventSeq,
                requiredThroughEventSeq = authority.requiredThroughEventSeq,
                supersedesQueryCompletion =
                    authority.phase == RelayV2StoredSyncPhase.LIVE,
            )
        }
        if (bufferedEventCount(event.namespace) + 1 > RelayV2StateLimits.MAX_BUFFERED_STATE_EVENTS ||
            bufferedEventRawBytes(event.namespace) + event.rawUtf8Bytes >
            RelayV2StateLimits.MAX_BUFFERED_STATE_EVENT_BYTES
        ) {
            val release = snapshot(event.namespace)?.releaseDirective()?.let { directive ->
                authority.releaseObligation(
                    directive,
                    RelayV2SnapshotReleaseReason.EVENT_BUFFER_OVERFLOW,
                )
            }
            deleteSnapshot(event.namespace)
            deleteBufferedEvents(event.namespace)
            putAuthority(authority.copy(
                phase = RelayV2StoredSyncPhase.RESYNCING,
                pendingRelease = release,
                afterReleasePhase =
                    release?.let { RelayV2PostReleasePhase.RESTART_SNAPSHOT },
            ))
            return RelayV2StateSyncResult.ResyncRequired(
                event.namespace,
                RelayV2ResyncReason.EVENT_BUFFER_OVERFLOW,
                release,
                release?.let { RelayV2PostReleasePhase.RESTART_SNAPSHOT },
                durableCursorEventSeq = authority.cursorEventSeq,
                requiredThroughEventSeq = authority.requiredThroughEventSeq,
                supersedesQueryCompletion =
                    authority.phase == RelayV2StoredSyncPhase.LIVE,
            )
        }
        putBufferedEvent(
            RelayV2StoredEvent(
                event = event,
                eventSeqOrder = relayV2CounterOrder(event.eventSeq),
                canonicalJson = canonical,
            ),
        )
        return if (reason == RelayV2ResyncReason.EVENT_GAP) {
            RelayV2StateSyncResult.EventBuffered(
                namespace = event.namespace,
                eventSeq = event.eventSeq,
                durableCursorEventSeq = authority.cursorEventSeq,
                requiredThroughEventSeq = authority.requiredThroughEventSeq,
                recoveryAction = if (authority.phase == RelayV2StoredSyncPhase.LIVE) {
                    RelayV2BufferedRecoveryAction.SUPERSEDE_QUERY_COMPLETION
                } else {
                    RelayV2BufferedRecoveryAction.CONTINUE_CURRENT
                },
            )
        } else {
            RelayV2StateSyncResult.ResyncRequired(
                event.namespace,
                reason,
                durableCursorEventSeq = authority.cursorEventSeq,
            )
        }
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

private fun RelayV2StoredAuthority.releaseObligation(
    directive: RelayV2SnapshotReleaseDirective,
    reason: RelayV2SnapshotReleaseReason,
): RelayV2SnapshotReleaseObligation {
    check(namespace == directive.namespace) { "Snapshot release crossed authority namespace" }
    check(pendingRelease == null) { "Snapshot release obligation is already pending" }
    return RelayV2SnapshotReleaseObligation(
        namespace = namespace,
        snapshotRequestId = directive.snapshotRequestId,
        snapshotId = directive.snapshotId,
        durableCursorEventSeq = cursorEventSeq,
        reason = reason,
    )
}

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

private fun RelayV2StateNamespace.connectIdentity() = RelayV2StateConnectIdentity(
    profileId,
    principalId,
    clientInstanceId,
    hostId,
)

private fun canonicalArrayBytes(canonicalRecords: List<String>): Long =
    2L + canonicalRecords.sumOf { it.toByteArray(Charsets.UTF_8).size.toLong() } +
        max(0, canonicalRecords.size - 1)

internal fun canonicalArrayBytes(recordCount: Long, recordJsonBytes: Long): Long =
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
