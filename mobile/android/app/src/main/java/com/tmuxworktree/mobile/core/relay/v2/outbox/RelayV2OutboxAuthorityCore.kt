package com.tmuxworktree.mobile.core.relay.v2.outbox

import java.security.MessageDigest
import java.util.Base64
import java.util.Collections

internal object RelayV2OutboxLimits {
    const val MAX_ENTRIES = 4_096
    const val MAX_ATTEMPTS_PER_ENTRY = 64
    const val MAX_ARGUMENTS_CANONICAL_BYTES = 131_072
    const val MAX_ENTRY_CANONICAL_BYTES = 262_144
    const val MAX_STATE_CANONICAL_BYTES = 16_777_216
}

internal data class RelayV2OutboxCapacity(
    val maxEntries: Int = RelayV2OutboxLimits.MAX_ENTRIES,
    val maxAttemptsPerEntry: Int = RelayV2OutboxLimits.MAX_ATTEMPTS_PER_ENTRY,
    val maxArgumentsCanonicalBytes: Int = RelayV2OutboxLimits.MAX_ARGUMENTS_CANONICAL_BYTES,
    val maxEntryCanonicalBytes: Int = RelayV2OutboxLimits.MAX_ENTRY_CANONICAL_BYTES,
    val maxStateCanonicalBytes: Int = RelayV2OutboxLimits.MAX_STATE_CANONICAL_BYTES,
) {
    init {
        require(maxEntries in 1..RelayV2OutboxLimits.MAX_ENTRIES)
        require(maxAttemptsPerEntry in 1..RelayV2OutboxLimits.MAX_ATTEMPTS_PER_ENTRY)
        require(maxArgumentsCanonicalBytes in 1..RelayV2OutboxLimits.MAX_ARGUMENTS_CANONICAL_BYTES)
        require(maxEntryCanonicalBytes in 1..RelayV2OutboxLimits.MAX_ENTRY_CANONICAL_BYTES)
        require(maxStateCanonicalBytes in 1..RelayV2OutboxLimits.MAX_STATE_CANONICAL_BYTES)
    }
}

internal enum class RelayV2OutboxOperation(val wireValue: String) {
    CREATE_WORKTREE("create_worktree"),
    CREATE_TERMINAL("create_terminal"),
    SEND_AGENT_MESSAGE("send_agent_message"),
    KILL_SESSION("kill_session"),
}

internal sealed interface RelayV2OutboxArguments {
    val operation: RelayV2OutboxOperation

    fun canonicalMap(): Map<String, Any?>

    data class CreateWorktree(
        val project: String?,
        val path: String?,
        val name: String?,
        val branch: String?,
        val aiCommand: String,
    ) : RelayV2OutboxArguments {
        override val operation: RelayV2OutboxOperation = RelayV2OutboxOperation.CREATE_WORKTREE

        init {
            require(project != null || path != null) { "project or path is required" }
            project?.let { requireOutboxString(it, 128) }
            path?.let { requireOutboxString(it, 4_096) }
            name?.let {
                requireOutboxString(it, 128)
                require(it.codePointCount(0, it.length) in 1..20) { "name is too long" }
            }
            branch?.let { requireOutboxString(it, 255) }
            requireOutboxString(aiCommand, 4_096)
        }

        override fun canonicalMap(): Map<String, Any?> = buildMap {
            project?.let { put("project", it) }
            path?.let { put("path", it) }
            name?.let { put("name", it) }
            branch?.let { put("branch", it) }
            put("aiCommand", aiCommand)
        }
    }

    data class CreateTerminal(
        val cwd: String,
        val label: String?,
    ) : RelayV2OutboxArguments {
        override val operation: RelayV2OutboxOperation = RelayV2OutboxOperation.CREATE_TERMINAL

        init {
            requireOutboxString(cwd, 4_096)
            label?.let { requireOutboxString(it, 128) }
        }

        override fun canonicalMap(): Map<String, Any?> = buildMap {
            put("cwd", cwd)
            label?.let { put("label", it) }
        }
    }

    data class SendAgentMessage(
        val pane: Int,
        val message: String,
        val submit: Boolean,
    ) : RelayV2OutboxArguments {
        override val operation: RelayV2OutboxOperation = RelayV2OutboxOperation.SEND_AGENT_MESSAGE

        init {
            require(pane in 0..65_535) { "pane is out of range" }
            require(message == normalizeRelayV2Message(message)) { "message is not normalized" }
            require(message.toByteArray(Charsets.UTF_8).size <= 65_536) { "message is too large" }
            require(message.isNotEmpty() || submit) { "empty message must submit" }
        }

        override fun canonicalMap(): Map<String, Any?> = mapOf(
            "pane" to pane,
            "message" to message,
            "submit" to submit,
        )
    }

    data object KillSession : RelayV2OutboxArguments {
        override val operation: RelayV2OutboxOperation = RelayV2OutboxOperation.KILL_SESSION

        override fun canonicalMap(): Map<String, Any?> = emptyMap()
    }

    companion object {
        fun createWorktree(
            project: String? = null,
            path: String? = null,
            name: String? = null,
            branch: String? = null,
            aiCommand: String,
        ): RelayV2OutboxArguments = CreateWorktree(project, path, name, branch, aiCommand)

        fun createTerminal(cwd: String, label: String? = null): RelayV2OutboxArguments =
            CreateTerminal(cwd, label)

        fun sendAgentMessage(
            pane: Int,
            message: String,
            submit: Boolean,
        ): RelayV2OutboxArguments = SendAgentMessage(
            pane = pane,
            message = normalizeRelayV2Message(message),
            submit = submit,
        )

        fun killSession(): RelayV2OutboxArguments = KillSession
    }
}

internal data class RelayV2CanonicalRequestArguments(
    val value: RelayV2OutboxArguments,
    val canonicalJson: String,
) {
    val utf8ByteCount: Int = canonicalJson.toByteArray(Charsets.UTF_8).size

    fun utf8Bytes(): ByteArray = canonicalJson.toByteArray(Charsets.UTF_8)

    companion object {
        fun from(value: RelayV2OutboxArguments): RelayV2CanonicalRequestArguments =
            RelayV2CanonicalRequestArguments(
                value = value,
                canonicalJson = RelayV2OutboxCanonicalJson.stringify(value.canonicalMap()),
            )
    }
}

internal data class RelayV2RequestFingerprint(
    val schemaVersion: Int,
    val sha256Base64Url: String,
    val canonicalRequestByteCount: Int,
) {
    init {
        require(schemaVersion == SCHEMA_VERSION) { "unsupported request fingerprint schema" }
        require(SHA256_BASE64URL.matches(sha256Base64Url)) { "invalid request fingerprint" }
        require(canonicalRequestByteCount > 0)
    }

    companion object {
        const val SCHEMA_VERSION = 1
        private val SHA256_BASE64URL = Regex("^[A-Za-z0-9_-]{43}$")
    }
}

internal data class RelayV2OutboxEntryId(
    val profileId: String,
    val principalId: String,
    val hostId: String,
    val expectedHostEpoch: String,
    val commandId: String,
) {
    init {
        listOf(profileId, principalId, hostId, expectedHostEpoch, commandId).forEach(::requireOutboxId)
    }
}

internal data class RelayV2OutboxLaneKey(
    val profileId: String,
    val principalId: String,
    val hostId: String,
    val expectedHostEpoch: String,
    val scopeId: String,
    val sessionId: String?,
    val createOperation: RelayV2OutboxOperation?,
) {
    init {
        listOf(profileId, principalId, hostId, expectedHostEpoch, scopeId).forEach(::requireOutboxId)
        sessionId?.let(::requireOutboxId)
        require((sessionId == null) == (createOperation != null)) { "invalid outbox lane" }
        require(
            createOperation == null ||
                createOperation == RelayV2OutboxOperation.CREATE_WORKTREE ||
                createOperation == RelayV2OutboxOperation.CREATE_TERMINAL,
        ) { "session mutation cannot use a create lane" }
    }
}

internal data class RelayV2OutboxDraft(
    val profileId: String,
    val principalId: String,
    val hostId: String,
    val expectedHostEpoch: String,
    val dedupeWindowId: String,
    val commandId: String,
    val scopeId: String,
    val sessionId: String?,
    val arguments: RelayV2OutboxArguments,
    val requestFingerprintSchemaVersion: Int = RelayV2RequestFingerprint.SCHEMA_VERSION,
) {
    val operation: RelayV2OutboxOperation = arguments.operation

    init {
        listOf(
            profileId,
            principalId,
            hostId,
            expectedHostEpoch,
            dedupeWindowId,
            commandId,
            scopeId,
        ).forEach(::requireOutboxId)
        sessionId?.let(::requireOutboxId)
        require(requestFingerprintSchemaVersion == RelayV2RequestFingerprint.SCHEMA_VERSION)
        requireTargetShape(operation, sessionId)
    }
}

internal enum class RelayV2OutboxStateTag(val persistedTag: Int) {
    QUEUED(0),
    SENDING(1),
    ACCEPTED(2),
    CONFIRMING(3),
    SUCCEEDED(4),
    FAILED_FINAL(5),
    AMBIGUOUS(6),
    REISSUED(7),
}

internal enum class RelayV2OutboxAcceptanceEvidence(val persistedTag: Int) {
    NONE(0),
    DURABLE(1),
}

internal enum class RelayV2OutboxAttemptKind(val persistedTag: Int) {
    EXECUTE(0),
    QUERY(1),
}

internal data class RelayV2OutboxAttempt(
    val requestId: String,
    val kind: RelayV2OutboxAttemptKind,
    val ordinal: Int,
) {
    init {
        requireOutboxId(requestId)
        require(ordinal > 0)
    }
}

internal data class RelayV2QueuedTargetRevalidation(
    val observedHostEpoch: String,
    val dedupeWindowId: String,
) {
    init {
        requireOutboxId(observedHostEpoch)
        requireOutboxId(dedupeWindowId)
    }
}

internal data class RelayV2OutboxEntry(
    val profileId: String,
    val principalId: String,
    val hostId: String,
    val expectedHostEpoch: String,
    val dedupeWindowId: String,
    val commandId: String,
    val operation: RelayV2OutboxOperation,
    val scopeId: String,
    val sessionId: String?,
    val canonicalRequestArguments: RelayV2CanonicalRequestArguments,
    val requestFingerprint: RelayV2RequestFingerprint,
    val state: RelayV2OutboxStateTag,
    val acceptanceEvidence: RelayV2OutboxAcceptanceEvidence,
    val attempts: List<RelayV2OutboxAttempt>,
    val createdOrder: Long,
    val createdAtMillis: Long,
    val replacementCommandId: String? = null,
    val reissuedFromCommandId: String? = null,
    val targetRevalidation: RelayV2QueuedTargetRevalidation? = null,
) {
    val id: RelayV2OutboxEntryId = RelayV2OutboxEntryId(
        profileId,
        principalId,
        hostId,
        expectedHostEpoch,
        commandId,
    )
    val laneKey: RelayV2OutboxLaneKey = RelayV2OutboxLaneKey(
        profileId = profileId,
        principalId = principalId,
        hostId = hostId,
        expectedHostEpoch = expectedHostEpoch,
        scopeId = scopeId,
        sessionId = sessionId,
        createOperation = operation.takeIf { sessionId == null },
    )
    val canonicalJson: String = canonicalEntryJson()
    val canonicalByteCount: Int = canonicalJson.toByteArray(Charsets.UTF_8).size

    init {
        listOf(
            profileId,
            principalId,
            hostId,
            expectedHostEpoch,
            dedupeWindowId,
            commandId,
            scopeId,
        ).forEach(::requireOutboxId)
        sessionId?.let(::requireOutboxId)
        replacementCommandId?.let(::requireOutboxId)
        reissuedFromCommandId?.let(::requireOutboxId)
        requireTargetShape(operation, sessionId)
        require(canonicalRequestArguments.value.operation == operation)
        require(
            canonicalRequestArguments ==
                RelayV2CanonicalRequestArguments.from(canonicalRequestArguments.value),
        ) { "request arguments are not canonical" }
        require(
            requestFingerprint == calculateRequestFingerprint(
                requestFingerprint.schemaVersion,
                operation,
                dedupeWindowId,
                expectedHostEpoch,
                hostId,
                scopeId,
                sessionId,
                canonicalRequestArguments,
            ),
        ) { "request fingerprint does not match the entry" }
        require(createdOrder >= 0)
        require(createdAtMillis in 0..MAX_JSON_INTEGER)
        require(attempts.map { it.requestId }.toSet().size == attempts.size)
        attempts.forEachIndexed { index, attempt -> require(attempt.ordinal == index + 1) }
        when (state) {
            RelayV2OutboxStateTag.QUEUED -> {
                require(attempts.isEmpty())
                require(acceptanceEvidence == RelayV2OutboxAcceptanceEvidence.NONE)
                require(replacementCommandId == null)
            }
            RelayV2OutboxStateTag.SENDING -> {
                require(attempts.lastOrNull()?.kind == RelayV2OutboxAttemptKind.EXECUTE)
                require(acceptanceEvidence == RelayV2OutboxAcceptanceEvidence.NONE)
                require(replacementCommandId == null)
            }
            RelayV2OutboxStateTag.ACCEPTED -> {
                require(attempts.isNotEmpty())
                require(acceptanceEvidence == RelayV2OutboxAcceptanceEvidence.DURABLE)
                require(replacementCommandId == null)
            }
            RelayV2OutboxStateTag.CONFIRMING,
            RelayV2OutboxStateTag.AMBIGUOUS,
            -> {
                require(attempts.isNotEmpty())
                require(replacementCommandId == null)
            }
            RelayV2OutboxStateTag.SUCCEEDED,
            RelayV2OutboxStateTag.FAILED_FINAL,
            -> {
                require(attempts.isNotEmpty())
                require(acceptanceEvidence == RelayV2OutboxAcceptanceEvidence.DURABLE)
                require(replacementCommandId == null)
            }
            RelayV2OutboxStateTag.REISSUED -> {
                require(attempts.isNotEmpty())
                require(acceptanceEvidence == RelayV2OutboxAcceptanceEvidence.NONE)
                require(replacementCommandId != null)
            }
        }
        require(targetRevalidation == null || state == RelayV2OutboxStateTag.QUEUED)
    }

    private fun canonicalEntryJson(): String = RelayV2OutboxCanonicalJson.stringify(
        mapOf(
            "acceptanceEvidence" to acceptanceEvidence.persistedTag,
            "arguments" to canonicalRequestArguments.value.canonicalMap(),
            "attempts" to attempts.map {
                mapOf(
                    "kind" to it.kind.persistedTag,
                    "ordinal" to it.ordinal,
                    "requestId" to it.requestId,
                )
            },
            "commandId" to commandId,
            "createdAtMillis" to createdAtMillis,
            "createdOrder" to createdOrder,
            "dedupeWindowId" to dedupeWindowId,
            "expectedHostEpoch" to expectedHostEpoch,
            "hostId" to hostId,
            "operation" to operation.wireValue,
            "principalId" to principalId,
            "profileId" to profileId,
            "reissuedFromCommandId" to reissuedFromCommandId,
            "replacementCommandId" to replacementCommandId,
            "requestFingerprint" to requestFingerprint.sha256Base64Url,
            "requestFingerprintSchemaVersion" to requestFingerprint.schemaVersion,
            "scopeId" to scopeId,
            "sessionId" to sessionId,
            "state" to state.persistedTag,
            "targetRevalidation" to targetRevalidation?.let {
                mapOf(
                    "dedupeWindowId" to it.dedupeWindowId,
                    "observedHostEpoch" to it.observedHostEpoch,
                )
            },
        ),
    )
}

internal class RelayV2OutboxState private constructor(
    entries: List<RelayV2OutboxEntry>,
    val nextCreationOrder: Long,
) {
    val entries: List<RelayV2OutboxEntry> = Collections.unmodifiableList(
        entries.sortedWith(compareBy<RelayV2OutboxEntry> { it.createdOrder }.thenBy { it.commandId }),
    )
    val canonicalByteCount: Int = stateCanonicalByteCount(this.entries, nextCreationOrder)

    init {
        require(nextCreationOrder >= 0)
        require(this.entries.map { it.id }.toSet().size == this.entries.size)
        require(this.entries.map { it.createdOrder }.toSet().size == this.entries.size)
        require(this.entries.all { it.createdOrder < nextCreationOrder })
        require(this.entries.size <= RelayV2OutboxLimits.MAX_ENTRIES)
        require(this.entries.all {
            it.attempts.size <= RelayV2OutboxLimits.MAX_ATTEMPTS_PER_ENTRY &&
                it.canonicalRequestArguments.utf8ByteCount <=
                RelayV2OutboxLimits.MAX_ARGUMENTS_CANONICAL_BYTES &&
                it.canonicalByteCount <= RelayV2OutboxLimits.MAX_ENTRY_CANONICAL_BYTES
        })
        require(canonicalByteCount <= RelayV2OutboxLimits.MAX_STATE_CANONICAL_BYTES)
    }

    fun entry(id: RelayV2OutboxEntryId): RelayV2OutboxEntry? = entries.firstOrNull { it.id == id }

    companion object {
        fun empty(): RelayV2OutboxState = RelayV2OutboxState(emptyList(), 0)

        fun restore(
            entries: List<RelayV2OutboxEntry>,
            nextCreationOrder: Long,
        ): RelayV2OutboxState = RelayV2OutboxState(entries.toList(), nextCreationOrder)
    }
}

internal enum class RelayV2CommandStatusState {
    NOT_ACCEPTED,
    ACCEPTED,
    RUNNING,
    SUCCEEDED,
    FAILED,
    IN_DOUBT,
    EXPIRED,
    UNKNOWN,
}

internal enum class RelayV2CommandDisposition(val wireValue: String) {
    NOT_ACCEPTED("not_accepted"),
    COMPLETED("completed"),
    IN_DOUBT("in_doubt"),
    NOT_APPLICABLE("not_applicable"),
}

/** Already schema-decoded authority evidence. Human-readable message is deliberately inert. */
internal data class RelayV2CommandStatusEvidence(
    val entryId: RelayV2OutboxEntryId,
    val dedupeWindowId: String,
    val hostEpoch: String,
    val state: RelayV2CommandStatusState,
    val attemptRequestId: String? = null,
    val retryable: Boolean = false,
    val retryAfterMs: Long? = null,
    val reissueRequired: Boolean = false,
    val errorCode: String? = null,
    val commandDisposition: RelayV2CommandDisposition? = null,
    val detailsReissueRequired: Boolean? = null,
    val errorMessage: String? = null,
) {
    init {
        requireOutboxId(dedupeWindowId)
        requireOutboxId(hostEpoch)
        attemptRequestId?.let(::requireOutboxId)
        require(retryAfterMs == null || retryAfterMs in 0..MAX_JSON_INTEGER)
        errorCode?.let { requireOutboxString(it, 128) }
        errorMessage?.let { require(it.toByteArray(Charsets.UTF_8).size <= 4_096) }
    }
}

internal sealed interface RelayV2OutboxRecovery {
    data object None : RelayV2OutboxRecovery

    data class RetrySameCommand(val attemptRequestId: String) : RelayV2OutboxRecovery {
        init {
            requireOutboxId(attemptRequestId)
        }
    }

    data class Reissue(
        val replacementCommandId: String,
        val newDedupeWindowId: String,
        val replacementCreatedAtMillis: Long,
    ) : RelayV2OutboxRecovery {
        init {
            requireOutboxId(replacementCommandId)
            requireOutboxId(newDedupeWindowId)
            require(replacementCreatedAtMillis in 0..MAX_JSON_INTEGER)
        }
    }
}

internal enum class RelayV2AttemptInterruptionCause {
    DISCONNECTED,
    TIMEOUT,
}

internal enum class RelayV2OldLineageAvailability {
    QUERYABLE,
    LOST,
}

internal sealed interface RelayV2OutboxAction {
    data class Enqueue(
        val draft: RelayV2OutboxDraft,
        val createdAtMillis: Long,
    ) : RelayV2OutboxAction {
        init {
            require(createdAtMillis in 0..MAX_JSON_INTEGER)
        }
    }

    data class DispatchEligible(
        val attemptRequestIds: Map<RelayV2OutboxEntryId, String>,
    ) : RelayV2OutboxAction

    data class BeginQuery(
        val entryId: RelayV2OutboxEntryId,
        val attemptRequestId: String,
    ) : RelayV2OutboxAction {
        init {
            requireOutboxId(attemptRequestId)
        }
    }

    data class AttemptInterrupted(
        val entryId: RelayV2OutboxEntryId,
        val attemptRequestId: String?,
        val cause: RelayV2AttemptInterruptionCause,
    ) : RelayV2OutboxAction {
        init {
            attemptRequestId?.let(::requireOutboxId)
        }
    }

    data class ReconcileStatus(
        val evidence: RelayV2CommandStatusEvidence,
        val recovery: RelayV2OutboxRecovery = RelayV2OutboxRecovery.None,
    ) : RelayV2OutboxAction

    data class HostEpochChanged(
        val profileId: String,
        val principalId: String,
        val hostId: String,
        val previousHostEpoch: String,
        val observedHostEpoch: String,
        val currentDedupeWindowId: String,
        val oldLineageAvailability: RelayV2OldLineageAvailability,
    ) : RelayV2OutboxAction {
        init {
            listOf(
                profileId,
                principalId,
                hostId,
                previousHostEpoch,
                observedHostEpoch,
                currentDedupeWindowId,
            ).forEach(::requireOutboxId)
            require(previousHostEpoch != observedHostEpoch)
        }
    }

    /** Result from an opaque-ID authority lookup; there is intentionally no display-name field. */
    data class ConfirmQueuedTarget(
        val entryId: RelayV2OutboxEntryId,
        val observedHostEpoch: String,
        val currentDedupeWindowId: String,
        val verifiedScopeId: String,
        val verifiedSessionId: String?,
    ) : RelayV2OutboxAction {
        init {
            listOf(observedHostEpoch, currentDedupeWindowId, verifiedScopeId).forEach(::requireOutboxId)
            verifiedSessionId?.let(::requireOutboxId)
        }
    }
}

internal sealed interface RelayV2OutboxMutation {
    data class Insert(val entry: RelayV2OutboxEntry) : RelayV2OutboxMutation

    data class Replace(
        val previousId: RelayV2OutboxEntryId,
        val entry: RelayV2OutboxEntry,
    ) : RelayV2OutboxMutation
}

internal data class RelayV2OutboxTransactionPlan(
    val mutations: List<RelayV2OutboxMutation>,
)

internal data class RelayV2OutboxCommand(
    val entryId: RelayV2OutboxEntryId,
    val dedupeWindowId: String,
    val operation: RelayV2OutboxOperation,
    val scopeId: String,
    val sessionId: String?,
    val canonicalRequestArguments: RelayV2CanonicalRequestArguments,
    val requestFingerprint: RelayV2RequestFingerprint,
)

internal sealed interface RelayV2OutboxEffect {
    data class ExecuteCommand(
        val command: RelayV2OutboxCommand,
        val attempt: RelayV2OutboxAttempt,
        val retryAfterMs: Long? = null,
    ) : RelayV2OutboxEffect

    data class QueryCommand(
        val entryId: RelayV2OutboxEntryId,
        val dedupeWindowId: String,
        val attempt: RelayV2OutboxAttempt,
    ) : RelayV2OutboxEffect

    data class RevalidateOpaqueTarget(
        val entryId: RelayV2OutboxEntryId,
        val observedHostEpoch: String,
        val currentDedupeWindowId: String,
        val priorScopeId: String,
        val priorSessionId: String?,
    ) : RelayV2OutboxEffect

    data class ConfirmOldLineage(val entryId: RelayV2OutboxEntryId) : RelayV2OutboxEffect

    data class ReissueCreated(
        val originalEntryId: RelayV2OutboxEntryId,
        val replacementEntryId: RelayV2OutboxEntryId,
    ) : RelayV2OutboxEffect
}

internal enum class RelayV2OutboxRejection {
    ENTRY_NOT_FOUND,
    DUPLICATE_COMMAND,
    DUPLICATE_ATTEMPT_REQUEST_ID,
    INVALID_TRANSITION,
    STATUS_IDENTITY_MISMATCH,
    STATUS_NOT_AUTHORIZING,
    RECOVERY_INPUT_MISMATCH,
    TARGET_REVALIDATION_REQUIRED,
    REPLACEMENT_ALREADY_EXISTS,
    CAPACITY_EXCEEDED,
}

internal sealed interface RelayV2OutboxResult {
    val state: RelayV2OutboxState

    data class Applied(
        override val state: RelayV2OutboxState,
        val transaction: RelayV2OutboxTransactionPlan,
        val effects: List<RelayV2OutboxEffect>,
    ) : RelayV2OutboxResult

    data class Rejected(
        override val state: RelayV2OutboxState,
        val reason: RelayV2OutboxRejection,
    ) : RelayV2OutboxResult
}

/** Pure, deterministic authority reducer. It performs no clock, UUID, Room, actor, or network IO. */
internal class RelayV2OutboxAuthorityCore(
    private val capacity: RelayV2OutboxCapacity = RelayV2OutboxCapacity(),
) {
    fun reduce(
        state: RelayV2OutboxState,
        action: RelayV2OutboxAction,
    ): RelayV2OutboxResult = when (action) {
        is RelayV2OutboxAction.Enqueue -> enqueue(state, action)
        is RelayV2OutboxAction.DispatchEligible -> dispatchEligible(state, action)
        is RelayV2OutboxAction.BeginQuery -> beginQuery(state, action)
        is RelayV2OutboxAction.AttemptInterrupted -> interruptAttempt(state, action)
        is RelayV2OutboxAction.ReconcileStatus -> reconcileStatus(state, action)
        is RelayV2OutboxAction.HostEpochChanged -> hostEpochChanged(state, action)
        is RelayV2OutboxAction.ConfirmQueuedTarget -> confirmQueuedTarget(state, action)
    }

    private fun enqueue(
        state: RelayV2OutboxState,
        action: RelayV2OutboxAction.Enqueue,
    ): RelayV2OutboxResult {
        val entry = entryFromDraft(
            action.draft,
            createdOrder = state.nextCreationOrder,
            createdAtMillis = action.createdAtMillis,
        )
        if (state.entry(entry.id) != null) return state.reject(RelayV2OutboxRejection.DUPLICATE_COMMAND)
        return apply(
            state,
            mutations = listOf(RelayV2OutboxMutation.Insert(entry)),
            nextCreationOrder = state.nextCreationOrder + 1,
        )
    }

    private fun dispatchEligible(
        state: RelayV2OutboxState,
        action: RelayV2OutboxAction.DispatchEligible,
    ): RelayV2OutboxResult {
        if (action.attemptRequestIds.values.any { value ->
                runCatching { requireOutboxId(value) }.isFailure
            }
        ) {
            return state.reject(RelayV2OutboxRejection.RECOVERY_INPUT_MISMATCH)
        }
        if (action.attemptRequestIds.values.toSet().size != action.attemptRequestIds.size ||
            action.attemptRequestIds.values.any { state.hasAttemptRequestId(it) }
        ) {
            return state.reject(RelayV2OutboxRejection.DUPLICATE_ATTEMPT_REQUEST_ID)
        }

        val blocked = mutableSetOf<RelayV2OutboxLaneKey>()
        val mutations = mutableListOf<RelayV2OutboxMutation>()
        val effects = mutableListOf<RelayV2OutboxEffect>()
        val consumed = mutableSetOf<RelayV2OutboxEntryId>()
        state.entries.forEach { entry ->
            when (entry.state) {
                RelayV2OutboxStateTag.SENDING,
                RelayV2OutboxStateTag.ACCEPTED,
                RelayV2OutboxStateTag.CONFIRMING,
                RelayV2OutboxStateTag.AMBIGUOUS,
                -> blocked += entry.laneKey
                RelayV2OutboxStateTag.QUEUED -> {
                    if (!blocked.add(entry.laneKey)) return@forEach
                    if (entry.targetRevalidation != null) return@forEach
                    val requestId = action.attemptRequestIds[entry.id] ?: return@forEach
                    val updated = entry.appendAttempt(
                        requestId,
                        RelayV2OutboxAttemptKind.EXECUTE,
                        RelayV2OutboxStateTag.SENDING,
                    )
                    val attempt = updated.attempts.last()
                    mutations += RelayV2OutboxMutation.Replace(entry.id, updated)
                    effects += RelayV2OutboxEffect.ExecuteCommand(updated.command(), attempt)
                    consumed += entry.id
                }
                RelayV2OutboxStateTag.SUCCEEDED,
                RelayV2OutboxStateTag.FAILED_FINAL,
                RelayV2OutboxStateTag.REISSUED,
                -> Unit
            }
        }
        if (consumed != action.attemptRequestIds.keys) {
            return state.reject(RelayV2OutboxRejection.INVALID_TRANSITION)
        }
        return apply(state, mutations, effects)
    }

    private fun beginQuery(
        state: RelayV2OutboxState,
        action: RelayV2OutboxAction.BeginQuery,
    ): RelayV2OutboxResult {
        val entry = state.entry(action.entryId)
            ?: return state.reject(RelayV2OutboxRejection.ENTRY_NOT_FOUND)
        if (state.hasAttemptRequestId(action.attemptRequestId)) {
            return state.reject(RelayV2OutboxRejection.DUPLICATE_ATTEMPT_REQUEST_ID)
        }
        if (entry.state !in QUERYABLE_STATES) {
            return state.reject(RelayV2OutboxRejection.INVALID_TRANSITION)
        }
        val queryState = if (entry.state == RelayV2OutboxStateTag.AMBIGUOUS) {
            RelayV2OutboxStateTag.AMBIGUOUS
        } else {
            RelayV2OutboxStateTag.CONFIRMING
        }
        val updated = entry.appendAttempt(
            action.attemptRequestId,
            RelayV2OutboxAttemptKind.QUERY,
            queryState,
        )
        val attempt = updated.attempts.last()
        return apply(
            state,
            listOf(RelayV2OutboxMutation.Replace(entry.id, updated)),
            listOf(RelayV2OutboxEffect.QueryCommand(updated.id, updated.dedupeWindowId, attempt)),
        )
    }

    private fun interruptAttempt(
        state: RelayV2OutboxState,
        action: RelayV2OutboxAction.AttemptInterrupted,
    ): RelayV2OutboxResult {
        val entry = state.entry(action.entryId)
            ?: return state.reject(RelayV2OutboxRejection.ENTRY_NOT_FOUND)
        if (action.attemptRequestId != null &&
            entry.attempts.none { it.requestId == action.attemptRequestId }
        ) {
            return state.reject(RelayV2OutboxRejection.STATUS_IDENTITY_MISMATCH)
        }
        if (entry.state !in INTERRUPTIBLE_STATES) {
            return state.reject(RelayV2OutboxRejection.INVALID_TRANSITION)
        }
        val updated = entry.copy(state = RelayV2OutboxStateTag.CONFIRMING)
        return apply(state, listOf(RelayV2OutboxMutation.Replace(entry.id, updated)))
    }

    private fun reconcileStatus(
        state: RelayV2OutboxState,
        action: RelayV2OutboxAction.ReconcileStatus,
    ): RelayV2OutboxResult {
        val evidence = action.evidence
        val entry = state.entry(evidence.entryId)
            ?: return state.reject(RelayV2OutboxRejection.ENTRY_NOT_FOUND)
        if (evidence.hostEpoch != entry.expectedHostEpoch ||
            evidence.dedupeWindowId != entry.dedupeWindowId ||
            evidence.attemptRequestId?.let { request ->
                entry.attempts.none { it.requestId == request }
            } == true
        ) {
            return state.reject(RelayV2OutboxRejection.STATUS_IDENTITY_MISMATCH)
        }
        if (entry.state == RelayV2OutboxStateTag.QUEUED ||
            entry.state == RelayV2OutboxStateTag.REISSUED ||
            entry.state == RelayV2OutboxStateTag.SUCCEEDED ||
            entry.state == RelayV2OutboxStateTag.FAILED_FINAL
        ) {
            return state.reject(RelayV2OutboxRejection.INVALID_TRANSITION)
        }
        if (evidence.state != RelayV2CommandStatusState.NOT_ACCEPTED &&
            action.recovery != RelayV2OutboxRecovery.None
        ) {
            return state.reject(RelayV2OutboxRejection.RECOVERY_INPUT_MISMATCH)
        }

        return when (evidence.state) {
            RelayV2CommandStatusState.ACCEPTED -> reconcileAccepted(state, entry, evidence)
            RelayV2CommandStatusState.RUNNING -> reconcileRunning(state, entry, evidence)
            RelayV2CommandStatusState.SUCCEEDED -> reconcileFinal(
                state,
                entry,
                evidence,
                RelayV2OutboxStateTag.SUCCEEDED,
            )
            RelayV2CommandStatusState.FAILED -> reconcileFinal(
                state,
                entry,
                evidence,
                RelayV2OutboxStateTag.FAILED_FINAL,
            )
            RelayV2CommandStatusState.IN_DOUBT,
            RelayV2CommandStatusState.EXPIRED,
            RelayV2CommandStatusState.UNKNOWN,
            -> reconcileAmbiguous(state, entry, evidence)
            RelayV2CommandStatusState.NOT_ACCEPTED -> reconcileNotAccepted(
                state,
                entry,
                evidence,
                action.recovery,
            )
        }
    }

    private fun reconcileAccepted(
        state: RelayV2OutboxState,
        entry: RelayV2OutboxEntry,
        evidence: RelayV2CommandStatusEvidence,
    ): RelayV2OutboxResult {
        if (!evidence.isNonFailureStatus() || entry.state == RelayV2OutboxStateTag.AMBIGUOUS) {
            return state.reject(RelayV2OutboxRejection.STATUS_NOT_AUTHORIZING)
        }
        val nextState = if (entry.state == RelayV2OutboxStateTag.SENDING) {
            RelayV2OutboxStateTag.ACCEPTED
        } else {
            entry.state
        }
        val updated = entry.copy(
            state = nextState,
            acceptanceEvidence = RelayV2OutboxAcceptanceEvidence.DURABLE,
        )
        return apply(state, listOf(RelayV2OutboxMutation.Replace(entry.id, updated)))
    }

    private fun reconcileRunning(
        state: RelayV2OutboxState,
        entry: RelayV2OutboxEntry,
        evidence: RelayV2CommandStatusEvidence,
    ): RelayV2OutboxResult {
        if (!evidence.isNonFailureStatus() || entry.state == RelayV2OutboxStateTag.AMBIGUOUS) {
            return state.reject(RelayV2OutboxRejection.STATUS_NOT_AUTHORIZING)
        }
        val updated = entry.copy(
            state = RelayV2OutboxStateTag.CONFIRMING,
            acceptanceEvidence = RelayV2OutboxAcceptanceEvidence.DURABLE,
        )
        return apply(state, listOf(RelayV2OutboxMutation.Replace(entry.id, updated)))
    }

    private fun reconcileFinal(
        state: RelayV2OutboxState,
        entry: RelayV2OutboxEntry,
        evidence: RelayV2CommandStatusEvidence,
        finalState: RelayV2OutboxStateTag,
    ): RelayV2OutboxResult {
        val valid = when (evidence.state) {
            RelayV2CommandStatusState.SUCCEEDED -> evidence.isNonFailureStatus()
            RelayV2CommandStatusState.FAILED ->
                !evidence.retryable &&
                    evidence.retryAfterMs == null &&
                    !evidence.reissueRequired &&
                    evidence.errorCode != null &&
                    evidence.commandDisposition == RelayV2CommandDisposition.COMPLETED &&
                    evidence.detailsReissueRequired == null
            else -> false
        }
        if (!valid) return state.reject(RelayV2OutboxRejection.STATUS_NOT_AUTHORIZING)
        val updated = entry.copy(
            state = finalState,
            acceptanceEvidence = RelayV2OutboxAcceptanceEvidence.DURABLE,
        )
        return apply(state, listOf(RelayV2OutboxMutation.Replace(entry.id, updated)))
    }

    private fun reconcileAmbiguous(
        state: RelayV2OutboxState,
        entry: RelayV2OutboxEntry,
        evidence: RelayV2CommandStatusEvidence,
    ): RelayV2OutboxResult {
        val valid = when (evidence.state) {
            RelayV2CommandStatusState.IN_DOUBT ->
                evidence.isFixedFailure("COMMAND_IN_DOUBT", RelayV2CommandDisposition.IN_DOUBT)
            RelayV2CommandStatusState.EXPIRED ->
                evidence.isFixedFailure(
                    "COMMAND_RESULT_EXPIRED",
                    evidence.commandDisposition,
                ) && evidence.commandDisposition in setOf(
                    RelayV2CommandDisposition.COMPLETED,
                    RelayV2CommandDisposition.IN_DOUBT,
                )
            RelayV2CommandStatusState.UNKNOWN ->
                evidence.isFixedFailure("COMMAND_STATUS_UNKNOWN", RelayV2CommandDisposition.IN_DOUBT)
            else -> false
        }
        if (!valid) return state.reject(RelayV2OutboxRejection.STATUS_NOT_AUTHORIZING)
        val durable = when (evidence.state) {
            RelayV2CommandStatusState.IN_DOUBT,
            RelayV2CommandStatusState.EXPIRED,
            -> RelayV2OutboxAcceptanceEvidence.DURABLE
            RelayV2CommandStatusState.UNKNOWN -> entry.acceptanceEvidence
            else -> error("not an ambiguous status")
        }
        val updated = entry.copy(
            state = RelayV2OutboxStateTag.AMBIGUOUS,
            acceptanceEvidence = durable,
        )
        return apply(state, listOf(RelayV2OutboxMutation.Replace(entry.id, updated)))
    }

    private fun reconcileNotAccepted(
        state: RelayV2OutboxState,
        entry: RelayV2OutboxEntry,
        evidence: RelayV2CommandStatusEvidence,
        recovery: RelayV2OutboxRecovery,
    ): RelayV2OutboxResult {
        if (entry.state == RelayV2OutboxStateTag.AMBIGUOUS ||
            entry.acceptanceEvidence != RelayV2OutboxAcceptanceEvidence.NONE
        ) {
            return state.reject(RelayV2OutboxRejection.STATUS_NOT_AUTHORIZING)
        }
        if (evidence.isRetryableNotAccepted()) {
            val retry = recovery as? RelayV2OutboxRecovery.RetrySameCommand
                ?: return state.reject(RelayV2OutboxRejection.RECOVERY_INPUT_MISMATCH)
            if (state.hasAttemptRequestId(retry.attemptRequestId)) {
                return state.reject(RelayV2OutboxRejection.DUPLICATE_ATTEMPT_REQUEST_ID)
            }
            val updated = entry.appendAttempt(
                retry.attemptRequestId,
                RelayV2OutboxAttemptKind.EXECUTE,
                RelayV2OutboxStateTag.SENDING,
            )
            val attempt = updated.attempts.last()
            return apply(
                state,
                listOf(RelayV2OutboxMutation.Replace(entry.id, updated)),
                listOf(
                    RelayV2OutboxEffect.ExecuteCommand(
                        updated.command(),
                        attempt,
                        evidence.retryAfterMs,
                    ),
                ),
            )
        }
        if (evidence.isReissueRequiredNotAccepted()) {
            val reissue = recovery as? RelayV2OutboxRecovery.Reissue
                ?: return state.reject(RelayV2OutboxRejection.RECOVERY_INPUT_MISMATCH)
            if (entry.replacementCommandId != null ||
                state.hasReplacementFor(entry)
            ) {
                return state.reject(RelayV2OutboxRejection.REPLACEMENT_ALREADY_EXISTS)
            }
            if (reissue.replacementCommandId == entry.commandId ||
                reissue.newDedupeWindowId == entry.dedupeWindowId
            ) {
                return state.reject(RelayV2OutboxRejection.RECOVERY_INPUT_MISMATCH)
            }
            val replacementDraft = RelayV2OutboxDraft(
                profileId = entry.profileId,
                principalId = entry.principalId,
                hostId = entry.hostId,
                expectedHostEpoch = entry.expectedHostEpoch,
                dedupeWindowId = reissue.newDedupeWindowId,
                commandId = reissue.replacementCommandId,
                scopeId = entry.scopeId,
                sessionId = entry.sessionId,
                arguments = entry.canonicalRequestArguments.value,
                requestFingerprintSchemaVersion = entry.requestFingerprint.schemaVersion,
            )
            val replacement = entryFromDraft(
                replacementDraft,
                createdOrder = state.nextCreationOrder,
                createdAtMillis = reissue.replacementCreatedAtMillis,
                reissuedFromCommandId = entry.commandId,
            )
            if (state.entry(replacement.id) != null) {
                return state.reject(RelayV2OutboxRejection.DUPLICATE_COMMAND)
            }
            val original = entry.copy(
                state = RelayV2OutboxStateTag.REISSUED,
                replacementCommandId = replacement.commandId,
            )
            return apply(
                state,
                mutations = listOf(
                    RelayV2OutboxMutation.Replace(entry.id, original),
                    RelayV2OutboxMutation.Insert(replacement),
                ),
                effects = listOf(
                    RelayV2OutboxEffect.ReissueCreated(entry.id, replacement.id),
                ),
                nextCreationOrder = state.nextCreationOrder + 1,
            )
        }
        return state.reject(RelayV2OutboxRejection.STATUS_NOT_AUTHORIZING)
    }

    private fun hostEpochChanged(
        state: RelayV2OutboxState,
        action: RelayV2OutboxAction.HostEpochChanged,
    ): RelayV2OutboxResult {
        val matching = state.entries.filter {
            it.profileId == action.profileId &&
                it.principalId == action.principalId &&
                it.hostId == action.hostId &&
                it.expectedHostEpoch == action.previousHostEpoch
        }
        if (matching.isEmpty()) return state.reject(RelayV2OutboxRejection.ENTRY_NOT_FOUND)
        val mutations = mutableListOf<RelayV2OutboxMutation>()
        val effects = mutableListOf<RelayV2OutboxEffect>()
        matching.forEach { entry ->
            when (entry.state) {
                RelayV2OutboxStateTag.QUEUED -> {
                    val revalidation = RelayV2QueuedTargetRevalidation(
                        action.observedHostEpoch,
                        action.currentDedupeWindowId,
                    )
                    val updated = entry.copy(targetRevalidation = revalidation)
                    mutations += RelayV2OutboxMutation.Replace(entry.id, updated)
                    effects += RelayV2OutboxEffect.RevalidateOpaqueTarget(
                        entry.id,
                        action.observedHostEpoch,
                        action.currentDedupeWindowId,
                        entry.scopeId,
                        entry.sessionId,
                    )
                }
                RelayV2OutboxStateTag.SENDING,
                RelayV2OutboxStateTag.ACCEPTED,
                RelayV2OutboxStateTag.CONFIRMING,
                -> {
                    val updated = entry.copy(
                        state = if (
                            action.oldLineageAvailability == RelayV2OldLineageAvailability.LOST
                        ) {
                            RelayV2OutboxStateTag.AMBIGUOUS
                        } else {
                            RelayV2OutboxStateTag.CONFIRMING
                        },
                    )
                    mutations += RelayV2OutboxMutation.Replace(entry.id, updated)
                    if (action.oldLineageAvailability == RelayV2OldLineageAvailability.QUERYABLE) {
                        effects += RelayV2OutboxEffect.ConfirmOldLineage(entry.id)
                    }
                }
                RelayV2OutboxStateTag.AMBIGUOUS,
                RelayV2OutboxStateTag.SUCCEEDED,
                RelayV2OutboxStateTag.FAILED_FINAL,
                RelayV2OutboxStateTag.REISSUED,
                -> Unit
            }
        }
        return apply(state, mutations, effects)
    }

    private fun confirmQueuedTarget(
        state: RelayV2OutboxState,
        action: RelayV2OutboxAction.ConfirmQueuedTarget,
    ): RelayV2OutboxResult {
        val entry = state.entry(action.entryId)
            ?: return state.reject(RelayV2OutboxRejection.ENTRY_NOT_FOUND)
        val pending = entry.targetRevalidation
            ?: return state.reject(RelayV2OutboxRejection.TARGET_REVALIDATION_REQUIRED)
        if (entry.state != RelayV2OutboxStateTag.QUEUED ||
            pending.observedHostEpoch != action.observedHostEpoch ||
            pending.dedupeWindowId != action.currentDedupeWindowId
        ) {
            return state.reject(RelayV2OutboxRejection.STATUS_IDENTITY_MISMATCH)
        }
        if (runCatching { requireTargetShape(entry.operation, action.verifiedSessionId) }.isFailure) {
            return state.reject(RelayV2OutboxRejection.INVALID_TRANSITION)
        }
        val canonical = entry.canonicalRequestArguments
        val updated = entry.copy(
            expectedHostEpoch = action.observedHostEpoch,
            dedupeWindowId = action.currentDedupeWindowId,
            scopeId = action.verifiedScopeId,
            sessionId = action.verifiedSessionId,
            requestFingerprint = calculateRequestFingerprint(
                entry.requestFingerprint.schemaVersion,
                entry.operation,
                action.currentDedupeWindowId,
                action.observedHostEpoch,
                entry.hostId,
                action.verifiedScopeId,
                action.verifiedSessionId,
                canonical,
            ),
            targetRevalidation = null,
        )
        if (state.entries.any { it.id == updated.id && it.id != entry.id }) {
            return state.reject(RelayV2OutboxRejection.DUPLICATE_COMMAND)
        }
        return apply(
            state,
            listOf(RelayV2OutboxMutation.Replace(entry.id, updated)),
        )
    }

    private fun apply(
        state: RelayV2OutboxState,
        mutations: List<RelayV2OutboxMutation>,
        effects: List<RelayV2OutboxEffect> = emptyList(),
        nextCreationOrder: Long = state.nextCreationOrder,
    ): RelayV2OutboxResult {
        if (mutations.isEmpty()) {
            return RelayV2OutboxResult.Applied(
                state,
                RelayV2OutboxTransactionPlan(emptyList()),
                effects.toList(),
            )
        }
        val entries = state.entries.toMutableList()
        for (mutation in mutations) {
            when (mutation) {
                is RelayV2OutboxMutation.Insert -> {
                    if (entries.any { it.id == mutation.entry.id }) {
                        return state.reject(RelayV2OutboxRejection.DUPLICATE_COMMAND)
                    }
                    entries += mutation.entry
                }
                is RelayV2OutboxMutation.Replace -> {
                    val index = entries.indexOfFirst { it.id == mutation.previousId }
                    if (index < 0) return state.reject(RelayV2OutboxRejection.ENTRY_NOT_FOUND)
                    if (entries.withIndex().any { (otherIndex, value) ->
                            otherIndex != index && value.id == mutation.entry.id
                        }
                    ) {
                        return state.reject(RelayV2OutboxRejection.DUPLICATE_COMMAND)
                    }
                    entries[index] = mutation.entry
                }
            }
        }
        val candidate = runCatching {
            RelayV2OutboxState.restore(entries, nextCreationOrder)
        }.getOrElse {
            return state.reject(RelayV2OutboxRejection.CAPACITY_EXCEEDED)
        }
        if (!withinCapacity(candidate)) {
            return state.reject(RelayV2OutboxRejection.CAPACITY_EXCEEDED)
        }
        return RelayV2OutboxResult.Applied(
            state = candidate,
            transaction = RelayV2OutboxTransactionPlan(mutations.toList()),
            effects = effects.toList(),
        )
    }

    private fun withinCapacity(state: RelayV2OutboxState): Boolean =
        state.entries.size <= capacity.maxEntries &&
            state.canonicalByteCount <= capacity.maxStateCanonicalBytes &&
            state.entries.all {
                it.attempts.size <= capacity.maxAttemptsPerEntry &&
                    it.canonicalRequestArguments.utf8ByteCount <=
                    capacity.maxArgumentsCanonicalBytes &&
                    it.canonicalByteCount <= capacity.maxEntryCanonicalBytes
            }
}

private fun entryFromDraft(
    draft: RelayV2OutboxDraft,
    createdOrder: Long,
    createdAtMillis: Long,
    reissuedFromCommandId: String? = null,
): RelayV2OutboxEntry {
    val canonical = RelayV2CanonicalRequestArguments.from(draft.arguments)
    return RelayV2OutboxEntry(
        profileId = draft.profileId,
        principalId = draft.principalId,
        hostId = draft.hostId,
        expectedHostEpoch = draft.expectedHostEpoch,
        dedupeWindowId = draft.dedupeWindowId,
        commandId = draft.commandId,
        operation = draft.operation,
        scopeId = draft.scopeId,
        sessionId = draft.sessionId,
        canonicalRequestArguments = canonical,
        requestFingerprint = calculateRequestFingerprint(
            draft.requestFingerprintSchemaVersion,
            draft.operation,
            draft.dedupeWindowId,
            draft.expectedHostEpoch,
            draft.hostId,
            draft.scopeId,
            draft.sessionId,
            canonical,
        ),
        state = RelayV2OutboxStateTag.QUEUED,
        acceptanceEvidence = RelayV2OutboxAcceptanceEvidence.NONE,
        attempts = emptyList(),
        createdOrder = createdOrder,
        createdAtMillis = createdAtMillis,
        reissuedFromCommandId = reissuedFromCommandId,
    )
}

private fun RelayV2OutboxEntry.appendAttempt(
    requestId: String,
    kind: RelayV2OutboxAttemptKind,
    nextState: RelayV2OutboxStateTag,
): RelayV2OutboxEntry = copy(
    attempts = attempts + RelayV2OutboxAttempt(requestId, kind, attempts.size + 1),
    state = nextState,
)

private fun RelayV2OutboxEntry.command(): RelayV2OutboxCommand = RelayV2OutboxCommand(
    entryId = id,
    dedupeWindowId = dedupeWindowId,
    operation = operation,
    scopeId = scopeId,
    sessionId = sessionId,
    canonicalRequestArguments = canonicalRequestArguments,
    requestFingerprint = requestFingerprint,
)

private fun RelayV2OutboxState.hasAttemptRequestId(requestId: String): Boolean =
    entries.any { entry -> entry.attempts.any { it.requestId == requestId } }

private fun RelayV2OutboxState.hasReplacementFor(entry: RelayV2OutboxEntry): Boolean =
    entries.any { candidate ->
        candidate.profileId == entry.profileId &&
            candidate.principalId == entry.principalId &&
            candidate.hostId == entry.hostId &&
            candidate.expectedHostEpoch == entry.expectedHostEpoch &&
            candidate.reissuedFromCommandId == entry.commandId
    }

private fun RelayV2OutboxState.reject(reason: RelayV2OutboxRejection) =
    RelayV2OutboxResult.Rejected(this, reason)

private fun RelayV2CommandStatusEvidence.isNonFailureStatus(): Boolean =
    !retryable &&
        retryAfterMs == null &&
        !reissueRequired &&
        errorCode == null &&
        commandDisposition == null &&
        detailsReissueRequired == null

private fun RelayV2CommandStatusEvidence.isFixedFailure(
    code: String,
    disposition: RelayV2CommandDisposition?,
): Boolean = !retryable &&
    retryAfterMs == null &&
    !reissueRequired &&
    errorCode == code &&
    commandDisposition == disposition &&
    detailsReissueRequired == null

private fun RelayV2CommandStatusEvidence.isRetryableNotAccepted(): Boolean =
    retryable &&
        retryAfterMs != null &&
        !reissueRequired &&
        errorCode == "COMMAND_NOT_ACCEPTED" &&
        commandDisposition == RelayV2CommandDisposition.NOT_ACCEPTED &&
        detailsReissueRequired == null

private fun RelayV2CommandStatusEvidence.isReissueRequiredNotAccepted(): Boolean =
    !retryable &&
        retryAfterMs == null &&
        reissueRequired &&
        errorCode == "COMMAND_WINDOW_EXPIRED" &&
        commandDisposition == RelayV2CommandDisposition.NOT_ACCEPTED &&
        detailsReissueRequired == true

private fun calculateRequestFingerprint(
    schemaVersion: Int,
    operation: RelayV2OutboxOperation,
    dedupeWindowId: String,
    hostEpoch: String,
    hostId: String,
    scopeId: String,
    sessionId: String?,
    arguments: RelayV2CanonicalRequestArguments,
): RelayV2RequestFingerprint {
    require(schemaVersion == RelayV2RequestFingerprint.SCHEMA_VERSION)
    val canonicalRequest = RelayV2OutboxCanonicalJson.stringify(
        mapOf(
            "arguments" to arguments.value.canonicalMap(),
            "dedupeWindowId" to dedupeWindowId,
            "hostEpoch" to hostEpoch,
            "hostId" to hostId,
            "operation" to operation.wireValue,
            "schemaVersion" to schemaVersion,
            "scopeId" to scopeId,
            "sessionId" to sessionId,
        ),
    )
    val bytes = canonicalRequest.toByteArray(Charsets.UTF_8)
    val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
    return RelayV2RequestFingerprint(
        schemaVersion,
        Base64.getUrlEncoder().withoutPadding().encodeToString(digest),
        bytes.size,
    )
}

private fun stateCanonicalByteCount(
    entries: List<RelayV2OutboxEntry>,
    nextCreationOrder: Long,
): Int {
    val fixed = "{\"entries\":[".toByteArray().size +
        "],\"nextCreationOrder\":$nextCreationOrder}".toByteArray().size
    val entriesBytes = entries.sumOf { it.canonicalByteCount.toLong() } +
        maxOf(0, entries.size - 1)
    return (fixed + entriesBytes).toInt()
}

private fun requireTargetShape(operation: RelayV2OutboxOperation, sessionId: String?) {
    when (operation) {
        RelayV2OutboxOperation.CREATE_WORKTREE,
        RelayV2OutboxOperation.CREATE_TERMINAL,
        -> require(sessionId == null) { "create target must omit sessionId" }
        RelayV2OutboxOperation.SEND_AGENT_MESSAGE,
        RelayV2OutboxOperation.KILL_SESSION,
        -> require(sessionId != null) { "session mutation requires sessionId" }
    }
}

private fun requireOutboxId(value: String) {
    requireOutboxString(value, 128)
}

private fun requireOutboxString(value: String, maxUtf8Bytes: Int) {
    require(value.isNotEmpty())
    require(value.trim() == value)
    require('\u0000' !in value)
    require(value.toByteArray(Charsets.UTF_8).size <= maxUtf8Bytes)
}

private fun normalizeRelayV2Message(value: String): String = value
    .replace("\r\n", "\n")
    .replace('\r', '\n')

private object RelayV2OutboxCanonicalJson {
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
            else -> error("unsupported canonical JSON value")
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
                    character.code < 0x20 -> append(
                        "\\u" + character.code.toString(16).padStart(4, '0'),
                    )
                    character.isHighSurrogate() -> {
                        require(index + 1 < value.length && value[index + 1].isLowSurrogate())
                        append(character)
                        append(value[index + 1])
                        index += 1
                    }
                    character.isLowSurrogate() -> error("unpaired low surrogate")
                    else -> append(character)
                }
            }
            index += 1
        }
        append('"')
    }
}

private const val MAX_JSON_INTEGER = 9_007_199_254_740_991L
private val QUERYABLE_STATES = setOf(
    RelayV2OutboxStateTag.SENDING,
    RelayV2OutboxStateTag.ACCEPTED,
    RelayV2OutboxStateTag.CONFIRMING,
    RelayV2OutboxStateTag.AMBIGUOUS,
)
private val INTERRUPTIBLE_STATES = setOf(
    RelayV2OutboxStateTag.SENDING,
    RelayV2OutboxStateTag.ACCEPTED,
    RelayV2OutboxStateTag.CONFIRMING,
)
