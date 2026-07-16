package com.tmuxworktree.mobile.core.relay.v2.state

import java.math.BigInteger
import java.security.MessageDigest
import java.util.Base64

internal object RelayV2StateLimits {
    const val MAX_ID_UTF8_BYTES = 128
    const val MAX_CURSOR_UTF8_BYTES = 1_024
    const val MAX_PUBLIC_FRAME_BYTES = 1_048_576
    const val MAX_SNAPSHOT_CHUNK_CANONICAL_BYTES = 524_288
    const val MAX_SNAPSHOT_CHUNK_RECORDS = 256
    const val MAX_SNAPSHOT_CANONICAL_BYTES = 268_435_456L
    const val MAX_SNAPSHOT_RECORDS = 100_000
    const val MAX_STAGED_RAW_UTF8_BYTES = 536_870_912L
    const val MAX_BUFFERED_STATE_EVENTS = 4_096
    const val MAX_BUFFERED_STATE_EVENT_BYTES = 16_777_216L
}

internal data class RelayV2StateNamespace(
    val profileId: String,
    val principalId: String,
    val clientInstanceId: String,
    val hostId: String,
    val hostEpoch: String,
) {
    init {
        listOf(profileId, principalId, clientInstanceId, hostId, hostEpoch).forEach {
            requireRelayV2Id(it)
        }
    }
}

internal data class RelayV2AppliedCursor(
    val hostEpoch: String,
    val eventSeq: String,
) {
    init {
        requireRelayV2Id(hostEpoch)
        requireRelayV2Counter(eventSeq)
    }
}

internal data class RelayV2StateConnectIdentity(
    val profileId: String,
    val principalId: String,
    val clientInstanceId: String,
    val hostId: String,
) {
    init {
        listOf(profileId, principalId, clientInstanceId, hostId).forEach(::requireRelayV2Id)
    }
}

internal enum class RelayV2StateConnectRecovery {
    EMPTY,
    LIVE,
    RESYNCING,
    RELEASE_PENDING,
}

/** Room-owned unique durable resume selection for one activated profile/host authority. */
internal data class RelayV2StateConnectPlan(
    val identity: RelayV2StateConnectIdentity,
    val resume: RelayV2AppliedCursor?,
    val recovery: RelayV2StateConnectRecovery,
    val durableHostEpoch: String?,
    val requiredThroughEventSeq: String?,
    val snapshotRequestId: String? = null,
    val snapshotId: String? = null,
    val snapshotNextCursor: String? = null,
    val snapshotNextChunkIndex: Long? = null,
    val snapshotComplete: Boolean? = null,
    val releaseObligationToken: String? = null,
) {
    init {
        durableHostEpoch?.let(::requireRelayV2Id)
        requiredThroughEventSeq?.let(::requireRelayV2Counter)
        snapshotRequestId?.let(::requireRelayV2Id)
        snapshotId?.let(::requireRelayV2Id)
        snapshotNextCursor?.let {
            require(it.toByteArray(Charsets.UTF_8).size <= RelayV2StateLimits.MAX_CURSOR_UTF8_BYTES)
        }
        snapshotNextChunkIndex?.let { require(it in 1..MAX_JSON_INTEGER) }
        when (recovery) {
            RelayV2StateConnectRecovery.EMPTY -> require(
                resume == null && durableHostEpoch == null &&
                    requiredThroughEventSeq == null && snapshotRequestId == null &&
                    releaseObligationToken == null,
            )
            RelayV2StateConnectRecovery.LIVE -> require(
                resume != null && durableHostEpoch == resume.hostEpoch &&
                    requiredThroughEventSeq != null && snapshotRequestId == null &&
                    releaseObligationToken == null,
            )
            RelayV2StateConnectRecovery.RESYNCING -> require(
                durableHostEpoch != null && requiredThroughEventSeq != null &&
                    releaseObligationToken == null,
            )
            RelayV2StateConnectRecovery.RELEASE_PENDING -> require(
                durableHostEpoch != null && requiredThroughEventSeq != null &&
                    releaseObligationToken != null && snapshotRequestId == null,
            )
        }
        require(resume == null || resume.hostEpoch == durableHostEpoch)
        val hasSnapshot = snapshotRequestId != null
        require((snapshotId != null) == hasSnapshot)
        require((snapshotNextChunkIndex != null) == hasSnapshot)
        require((snapshotComplete != null) == hasSnapshot)
        require(!hasSnapshot || recovery == RelayV2StateConnectRecovery.RESYNCING)
        require(!hasSnapshot || (snapshotComplete == true) == (snapshotNextCursor == null))
        require(snapshotNextCursor == null || snapshotNextCursor.isNotEmpty())
        require(hasSnapshot || snapshotNextCursor == null)
    }
}

internal enum class RelayV2StateHelloDisposition {
    FRESH,
    MATCHED,
    CURSOR_BEHIND,
    HOST_EPOCH_CHANGED,
    EVENT_CURSOR_AHEAD,
}

internal data class RelayV2StateHello(
    val namespace: RelayV2StateNamespace,
    val welcomeEventSeq: String,
    val resume: RelayV2AppliedCursor?,
    val disposition: RelayV2StateHelloDisposition,
) {
    init {
        requireRelayV2Counter(welcomeEventSeq)
        when (disposition) {
            RelayV2StateHelloDisposition.FRESH -> require(resume == null)
            RelayV2StateHelloDisposition.MATCHED -> require(
                resume?.hostEpoch == namespace.hostEpoch &&
                    compareRelayV2Counters(resume.eventSeq, welcomeEventSeq) == 0,
            )
            RelayV2StateHelloDisposition.CURSOR_BEHIND -> require(
                resume?.hostEpoch == namespace.hostEpoch &&
                    compareRelayV2Counters(resume.eventSeq, welcomeEventSeq) < 0,
            )
            RelayV2StateHelloDisposition.HOST_EPOCH_CHANGED -> require(
                resume != null && resume.hostEpoch != namespace.hostEpoch,
            )
            RelayV2StateHelloDisposition.EVENT_CURSOR_AHEAD -> require(
                resume?.hostEpoch == namespace.hostEpoch &&
                    compareRelayV2Counters(resume.eventSeq, welcomeEventSeq) > 0,
            )
        }
    }
}

internal enum class RelayV2ScopeKind(val wireValue: String) {
    LOCAL("local"),
    SSH("ssh"),
}

internal enum class RelayV2ScopeReachability(val wireValue: String) {
    ONLINE("online"),
    UNREACHABLE("unreachable"),
}

internal data class RelayV2ScopeResource(
    val scopeId: String,
    val displayName: String,
    val kind: RelayV2ScopeKind,
    val reachability: RelayV2ScopeReachability,
) {
    init {
        requireRelayV2Id(scopeId)
        require(displayName.toByteArray(Charsets.UTF_8).size <= 128)
        require('\u0000' !in displayName)
    }

    fun wireMap(): Map<String, Any?> = mapOf(
        "scopeId" to scopeId,
        "displayName" to displayName,
        "kind" to kind.wireValue,
        "reachability" to reachability.wireValue,
    )
}

internal enum class RelayV2SessionKind(val wireValue: String) {
    WORKTREE("worktree"),
    TERMINAL("terminal"),
}

internal data class RelayV2SessionResource(
    val scopeId: String,
    val sessionId: String,
    val kind: RelayV2SessionKind,
    val displayName: String,
    val project: String?,
    val label: String?,
    val cwd: String?,
    val attached: Boolean,
    val windowCount: Long,
    val createdAtMs: Long,
    val activityAtMs: Long,
) {
    init {
        requireRelayV2Id(scopeId)
        requireRelayV2Id(sessionId)
        require(displayName.toByteArray(Charsets.UTF_8).size <= 128)
        require(windowCount in 0..MAX_JSON_INTEGER)
        require(createdAtMs in 0..MAX_JSON_INTEGER)
        require(activityAtMs in 0..MAX_JSON_INTEGER)
        require(project == null || project.toByteArray(Charsets.UTF_8).size <= 128)
        require(label == null || label.toByteArray(Charsets.UTF_8).size <= 128)
        require(cwd == null || cwd.toByteArray(Charsets.UTF_8).size <= 4_096)
        require(listOfNotNull(displayName, project, label, cwd).none { '\u0000' in it })
        when (kind) {
            RelayV2SessionKind.WORKTREE -> require(!project.isNullOrEmpty() && !cwd.isNullOrEmpty())
            RelayV2SessionKind.TERMINAL -> require(!label.isNullOrEmpty() && !cwd.isNullOrEmpty())
        }
    }

    fun wireMap(): Map<String, Any?> = mapOf(
        "scopeId" to scopeId,
        "sessionId" to sessionId,
        "kind" to kind.wireValue,
        "displayName" to displayName,
        "state" to "running",
        "project" to project,
        "label" to label,
        "cwd" to cwd,
        "attached" to attached,
        "windowCount" to windowCount,
        "createdAtMs" to createdAtMs,
        "activityAtMs" to activityAtMs,
    )
}

internal sealed interface RelayV2SnapshotRecord {
    data class Scope(val item: RelayV2ScopeResource) : RelayV2SnapshotRecord

    data class SessionsScope(
        val scopeId: String,
        val revision: String,
    ) : RelayV2SnapshotRecord {
        init {
            requireRelayV2Id(scopeId)
            requireRelayV2Counter(revision)
        }
    }

    data class Session(
        val scopeId: String,
        val item: RelayV2SessionResource,
    ) : RelayV2SnapshotRecord {
        init {
            requireRelayV2Id(scopeId)
            require(scopeId == item.scopeId)
        }
    }

    fun canonicalJson(): String = RelayV2CanonicalJson.stringify(
        when (this) {
            is Scope -> mapOf("recordType" to "scope", "item" to item.wireMap())
            is SessionsScope -> mapOf(
                "recordType" to "sessions_scope",
                "scopeId" to scopeId,
                "revision" to revision,
                "completeness" to "complete",
            )
            is Session -> mapOf(
                "recordType" to "session",
                "scopeId" to scopeId,
                "item" to item.wireMap(),
            )
        },
    )
}

internal data class RelayV2SnapshotChunk(
    val namespace: RelayV2StateNamespace,
    val snapshotRequestId: String,
    val snapshotId: String,
    val snapshotCreatedAtMs: Long,
    val snapshotLeaseExpiresAtMs: Long,
    val snapshotAbsoluteExpiresAtMs: Long,
    val chunkIndex: Long,
    /** Opaque cursor used by the correlated request; null only for chunk zero. */
    val requestedCursor: String?,
    val isLast: Boolean,
    val nextCursor: String?,
    val throughEventSeq: String,
    val scopesRevision: String,
    val totalRecords: Long,
    val totalCanonicalBytes: Long,
    val cutDigest: String,
    val records: List<RelayV2SnapshotRecord>,
    val rawUtf8Bytes: Int,
) {
    init {
        requireRelayV2Id(snapshotRequestId)
        requireRelayV2Id(snapshotId)
        require(snapshotCreatedAtMs in 0..MAX_JSON_INTEGER)
        require(snapshotLeaseExpiresAtMs in 0..MAX_JSON_INTEGER)
        require(snapshotAbsoluteExpiresAtMs in 0..MAX_JSON_INTEGER)
        require(snapshotCreatedAtMs <= snapshotLeaseExpiresAtMs)
        require(snapshotLeaseExpiresAtMs <= snapshotAbsoluteExpiresAtMs)
        require(chunkIndex in 0..MAX_JSON_INTEGER)
        require((chunkIndex == 0L) == (requestedCursor == null))
        require(requestedCursor == null || requestedCursor.toByteArray(Charsets.UTF_8).size <= RelayV2StateLimits.MAX_CURSOR_UTF8_BYTES)
        require((isLast && nextCursor == null) || (!isLast && nextCursor != null))
        require(nextCursor == null || nextCursor.toByteArray(Charsets.UTF_8).size <= RelayV2StateLimits.MAX_CURSOR_UTF8_BYTES)
        requireRelayV2Counter(throughEventSeq)
        requireRelayV2Counter(scopesRevision)
        require(totalRecords in 0..RelayV2StateLimits.MAX_SNAPSHOT_RECORDS.toLong())
        require(totalCanonicalBytes in 0..RelayV2StateLimits.MAX_SNAPSHOT_CANONICAL_BYTES)
        require(CANONICAL_SHA256_BASE64URL.matches(cutDigest))
        require(records.size <= RelayV2StateLimits.MAX_SNAPSHOT_CHUNK_RECORDS)
        require(rawUtf8Bytes in 1..RelayV2StateLimits.MAX_PUBLIC_FRAME_BYTES)
    }
}

internal sealed interface RelayV2StateChange {
    val scopeId: String

    data class ScopeUpsert(val item: RelayV2ScopeResource) : RelayV2StateChange {
        override val scopeId: String = item.scopeId
    }

    data class ScopeDelete(override val scopeId: String) : RelayV2StateChange {
        init {
            requireRelayV2Id(scopeId)
        }
    }

    data class SessionUpsert(val item: RelayV2SessionResource) : RelayV2StateChange {
        override val scopeId: String = item.scopeId
    }

    data class SessionDelete(
        override val scopeId: String,
        val sessionId: String,
    ) : RelayV2StateChange {
        init {
            requireRelayV2Id(scopeId)
            requireRelayV2Id(sessionId)
        }
    }
}

internal data class RelayV2StateEvent(
    val namespace: RelayV2StateNamespace,
    val eventSeq: String,
    val resultingRevision: String,
    val change: RelayV2StateChange,
    val rawUtf8Bytes: Int,
) {
    init {
        requireRelayV2Counter(eventSeq)
        requireRelayV2Counter(resultingRevision)
        require(rawUtf8Bytes in 1..RelayV2StateLimits.MAX_PUBLIC_FRAME_BYTES)
    }

    fun canonicalJson(): String = RelayV2CanonicalJson.stringify(
        mapOf(
            "eventSeq" to eventSeq,
            "resultingRevision" to resultingRevision,
            "change" to when (val value = change) {
                is RelayV2StateChange.ScopeUpsert -> mapOf(
                    "type" to "scope_upsert",
                    "item" to value.item.wireMap(),
                )
                is RelayV2StateChange.ScopeDelete -> mapOf(
                    "type" to "scope_delete",
                    "scopeId" to value.scopeId,
                )
                is RelayV2StateChange.SessionUpsert -> mapOf(
                    "type" to "session_upsert",
                    "item" to value.item.wireMap(),
                )
                is RelayV2StateChange.SessionDelete -> mapOf(
                    "type" to "session_delete",
                    "scopeId" to value.scopeId,
                    "sessionId" to value.sessionId,
                )
            },
        ),
    )
}

internal data class RelayV2SnapshotReleaseDirective(
    val namespace: RelayV2StateNamespace,
    val snapshotRequestId: String,
    val snapshotId: String,
)

internal data class RelayV2StateSnapshotContinuation(
    val snapshotRequestId: String,
    val snapshotId: String,
    val cursor: String,
    val nextChunkIndex: Long,
)

internal enum class RelayV2SnapshotReleaseReason {
    COMPLETED,
    SNAPSHOT_RESTART_REQUIRED,
    SNAPSHOT_IDENTITY_CONFLICT,
    SNAPSHOT_ORDER_CONFLICT,
    SNAPSHOT_LIMIT_EXCEEDED,
    SNAPSHOT_INCOMPLETE,
    SNAPSHOT_COUNT_MISMATCH,
    SNAPSHOT_DIGEST_MISMATCH,
    EVENT_GAP,
    EVENT_REVISION_CONFLICT,
    EVENT_BUFFER_OVERFLOW,
    FRESH,
}

internal enum class RelayV2PostReleasePhase {
    RESTART_SNAPSHOT,
    QUERY_PENDING_COMMANDS,
}

/** Durable authority journal that must be cleared only by an exact host release proof. */
internal data class RelayV2SnapshotReleaseObligation(
    val namespace: RelayV2StateNamespace,
    val snapshotRequestId: String,
    val snapshotId: String,
    val durableCursorEventSeq: String?,
    val reason: RelayV2SnapshotReleaseReason,
) {
    init {
        require(snapshotRequestId.isNotBlank())
        require(snapshotId.isNotBlank())
        durableCursorEventSeq?.let(::requireRelayV2Counter)
    }

    val wireReason: String
        get() = if (reason == RelayV2SnapshotReleaseReason.COMPLETED) {
            "completed"
        } else {
            "abandoned"
        }

    /** Opaque full-identity CAS token; it is recomputed from the durable row after reopen. */
    val opaqueToken: String
        get() {
            val identity = listOf(
                namespace.profileId,
                namespace.principalId,
                namespace.clientInstanceId,
                namespace.hostId,
                namespace.hostEpoch,
                snapshotRequestId,
                snapshotId,
                durableCursorEventSeq ?: "",
                reason.name,
            ).joinToString("\u0000")
            return Base64.getUrlEncoder().withoutPadding().encodeToString(
                MessageDigest.getInstance("SHA-256").digest(identity.toByteArray(Charsets.UTF_8)),
            )
        }
}

/** Exact release CAS result paired with the latest mutable plan observed in that transaction. */
internal data class RelayV2SnapshotReleaseCompletion(
    val release: RelayV2SnapshotReleaseObligation,
    val afterReleasePhase: RelayV2PostReleasePhase,
)

internal enum class RelayV2ResyncReason {
    FRESH,
    CURSOR_BEHIND,
    HOST_EPOCH_CHANGED,
    EVENT_GAP,
    EVENT_REVISION_CONFLICT,
    EVENT_BUFFER_OVERFLOW,
    SNAPSHOT_RESTART_REQUIRED,
    SNAPSHOT_IDENTITY_CONFLICT,
    SNAPSHOT_ORDER_CONFLICT,
    SNAPSHOT_LIMIT_EXCEEDED,
    SNAPSHOT_INCOMPLETE,
    SNAPSHOT_COUNT_MISMATCH,
    SNAPSHOT_DIGEST_MISMATCH,
}

internal enum class RelayV2BufferedRecoveryAction {
    CONTINUE_CURRENT,
    SUPERSEDE_QUERY_COMPLETION,
}

internal enum class RelayV2RotationReason {
    EVENT_CURSOR_AHEAD,
    REQUIRED_WATERMARK_REGRESSED,
    UNKNOWN_HOST_EPOCH,
}

internal sealed interface RelayV2StateSyncResult {
    data class Live(
        val namespace: RelayV2StateNamespace,
        val cursorEventSeq: String,
    ) : RelayV2StateSyncResult

    data class ResyncRequired(
        val namespace: RelayV2StateNamespace,
        val reason: RelayV2ResyncReason,
        val release: RelayV2SnapshotReleaseObligation? = null,
        val afterReleasePhase: RelayV2PostReleasePhase? = null,
        val durableCursorEventSeq: String? = release?.durableCursorEventSeq,
        val requiredThroughEventSeq: String? = null,
        val continuation: RelayV2StateSnapshotContinuation? = null,
        val supersedesQueryCompletion: Boolean = false,
    ) : RelayV2StateSyncResult {
        init {
            require((release == null) == (afterReleasePhase == null))
            requiredThroughEventSeq?.let(::requireRelayV2Counter)
            if (supersedesQueryCompletion) {
                val required = requireNotNull(requiredThroughEventSeq) {
                    "A query completion can only be superseded by a durable watermark"
                }
                require(
                    durableCursorEventSeq == null ||
                        compareRelayV2Counters(required, durableCursorEventSeq) > 0
                ) { "The superseding watermark must be later than the durable cursor" }
            }
        }
    }

    /** A gap event was durably retained while the existing recovery cut remains authoritative. */
    data class EventBuffered(
        val namespace: RelayV2StateNamespace,
        val eventSeq: String,
        val durableCursorEventSeq: String?,
        val requiredThroughEventSeq: String,
        val recoveryAction: RelayV2BufferedRecoveryAction,
    ) : RelayV2StateSyncResult {
        init {
            requireRelayV2Counter(eventSeq)
            durableCursorEventSeq?.let(::requireRelayV2Counter)
            requireRelayV2Counter(requiredThroughEventSeq)
            require(compareRelayV2Counters(requiredThroughEventSeq, eventSeq) >= 0)
        }
    }

    data class ReleasePending(
        val namespace: RelayV2StateNamespace,
        val release: RelayV2SnapshotReleaseObligation,
        val afterReleasePhase: RelayV2PostReleasePhase,
    ) : RelayV2StateSyncResult

    data class RotationRequired(
        val namespace: RelayV2StateNamespace,
        val reason: RelayV2RotationReason,
    ) : RelayV2StateSyncResult

    data class SnapshotStaged(
        val namespace: RelayV2StateNamespace,
        val snapshotId: String,
        val nextChunkIndex: Long,
        val nextCursor: String?,
        val complete: Boolean,
    ) : RelayV2StateSyncResult

    data class SnapshotCommitted(
        val namespace: RelayV2StateNamespace,
        val cursorEventSeq: String,
        val release: RelayV2SnapshotReleaseObligation,
        val afterReleasePhase: RelayV2PostReleasePhase,
    ) : RelayV2StateSyncResult

    data class SnapshotExpired(
        val namespace: RelayV2StateNamespace,
        val snapshotRequestId: String,
        val snapshotId: String,
        val durableCursorEventSeq: String?,
    ) : RelayV2StateSyncResult

    data object DuplicateEvent : RelayV2StateSyncResult
}

internal fun canonicalSnapshotDigest(records: List<RelayV2SnapshotRecord>): Pair<Long, String> {
    val digest = MessageDigest.getInstance("SHA-256")
    var totalBytes = 0L
    fun update(value: String) {
        val bytes = value.toByteArray(Charsets.UTF_8)
        digest.update(bytes)
        totalBytes += bytes.size
    }
    update("[")
    records.forEachIndexed { index, record ->
        if (index > 0) update(",")
        update(record.canonicalJson())
    }
    update("]")
    return totalBytes to Base64.getUrlEncoder().withoutPadding().encodeToString(digest.digest())
}

internal fun requireRelayV2Id(value: String) {
    require(value.isNotBlank())
    require(value.trim() == value)
    require('\u0000' !in value)
    require(value.toByteArray(Charsets.UTF_8).size <= RelayV2StateLimits.MAX_ID_UTF8_BYTES)
}

internal fun requireRelayV2Counter(value: String) {
    require(CANONICAL_COUNTER.matches(value))
    require(BigInteger(value) <= UNSIGNED_COUNTER_MAX)
}

internal fun compareRelayV2Counters(left: String, right: String): Int {
    requireRelayV2Counter(left)
    requireRelayV2Counter(right)
    return BigInteger(left).compareTo(BigInteger(right))
}

internal fun incrementRelayV2Counter(value: String): String {
    requireRelayV2Counter(value)
    val incremented = BigInteger(value) + BigInteger.ONE
    require(incremented <= UNSIGNED_COUNTER_MAX)
    return incremented.toString()
}

internal fun relayV2CounterOrder(value: String): String {
    requireRelayV2Counter(value)
    return value.padStart(20, '0')
}

private object RelayV2CanonicalJson {
    fun stringify(value: Any?): String = buildString { appendValue(value) }

    private fun StringBuilder.appendValue(value: Any?) {
        when (value) {
            null -> append("null")
            is Boolean -> append(if (value) "true" else "false")
            is Byte, is Short, is Int, is Long -> append((value as Number).toLong())
            is String -> appendString(value)
            is List<*> -> {
                append('[')
                value.forEachIndexed { index, item ->
                    if (index > 0) append(',')
                    appendValue(item)
                }
                append(']')
            }
            is Map<*, *> -> {
                val entries = value.entries.map {
                    require(it.key is String)
                    (it.key as String) to it.value
                }.sortedBy { it.first }
                append('{')
                entries.forEachIndexed { index, (key, item) ->
                    if (index > 0) append(',')
                    appendString(key)
                    append(':')
                    appendValue(item)
                }
                append('}')
            }
            else -> error("Unsupported canonical JSON value")
        }
    }

    private fun StringBuilder.appendString(value: String) {
        append('"')
        var index = 0
        while (index < value.length) {
            val character = value[index]
            when (character) {
                '"' -> append("\\\"")
                '\\' -> append("\\\\")
                '\b' -> append("\\b")
                '\t' -> append("\\t")
                '\n' -> append("\\n")
                '\u000C' -> append("\\f")
                '\r' -> append("\\r")
                else -> when {
                    character.code < 0x20 -> append("\\u" + character.code.toString(16).padStart(4, '0'))
                    character.isHighSurrogate() -> {
                        require(index + 1 < value.length && value[index + 1].isLowSurrogate())
                        append(character)
                        append(value[index + 1])
                        index += 1
                    }
                    character.isLowSurrogate() -> error("Unpaired low surrogate")
                    else -> append(character)
                }
            }
            index += 1
        }
        append('"')
    }
}

private const val MAX_JSON_INTEGER = 9_007_199_254_740_991L
private val CANONICAL_COUNTER = Regex("^(?:0|[1-9][0-9]*)$")
private val UNSIGNED_COUNTER_MAX = BigInteger("18446744073709551615")
private val CANONICAL_SHA256_BASE64URL = Regex("^[A-Za-z0-9_-]{43}$")
