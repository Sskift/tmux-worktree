package com.tmuxworktree.mobile.core.relay.v2.outbox

import java.security.MessageDigest
import java.util.Collections

internal object RelayV2OutboxLimits {
    const val MAX_ENTRIES = 4_096
    const val MAX_ATTEMPTS_PER_ENTRY = 64
    const val MAX_DISPATCH_ITEMS_PER_BATCH = 32
    const val MAX_QUERY_ITEMS_PER_BATCH = 32
    const val MAX_QUERY_BATCHES =
        (MAX_ENTRIES + MAX_QUERY_ITEMS_PER_BATCH - 1) / MAX_QUERY_ITEMS_PER_BATCH
    const val MAX_TARGET_PROVENANCE_STEPS = 64
    const val MAX_TARGET_PROVENANCE_CANONICAL_BYTES = 65_536
    const val MAX_ARGUMENTS_CANONICAL_BYTES = 131_072
    const val MAX_ENTRY_CANONICAL_BYTES = 262_144
    const val MAX_STATE_CANONICAL_BYTES = 16_777_216
}

internal data class RelayV2OutboxCapacity(
    val maxEntries: Int = RelayV2OutboxLimits.MAX_ENTRIES,
    val maxAttemptsPerEntry: Int = RelayV2OutboxLimits.MAX_ATTEMPTS_PER_ENTRY,
    val maxTargetProvenanceSteps: Int = RelayV2OutboxLimits.MAX_TARGET_PROVENANCE_STEPS,
    val maxTargetProvenanceCanonicalBytes: Int =
        RelayV2OutboxLimits.MAX_TARGET_PROVENANCE_CANONICAL_BYTES,
    val maxArgumentsCanonicalBytes: Int = RelayV2OutboxLimits.MAX_ARGUMENTS_CANONICAL_BYTES,
    val maxEntryCanonicalBytes: Int = RelayV2OutboxLimits.MAX_ENTRY_CANONICAL_BYTES,
    val maxStateCanonicalBytes: Int = RelayV2OutboxLimits.MAX_STATE_CANONICAL_BYTES,
) {
    init {
        require(maxEntries in 1..RelayV2OutboxLimits.MAX_ENTRIES)
        require(maxAttemptsPerEntry in 1..RelayV2OutboxLimits.MAX_ATTEMPTS_PER_ENTRY)
        require(
            maxTargetProvenanceSteps in 1..RelayV2OutboxLimits.MAX_TARGET_PROVENANCE_STEPS,
        )
        require(
            maxTargetProvenanceCanonicalBytes in
                1..RelayV2OutboxLimits.MAX_TARGET_PROVENANCE_CANONICAL_BYTES,
        )
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

        override fun toString(): String = "CreateWorktree(<redacted>)"
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

        override fun toString(): String = "CreateTerminal(<redacted>)"
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
            require(message.length <= 65_536) { "message is too large" }
            require(message.toByteArray(Charsets.UTF_8).size <= 65_536) { "message is too large" }
            require(message.isNotEmpty() || submit) { "empty message must submit" }
        }

        override fun canonicalMap(): Map<String, Any?> = mapOf(
            "pane" to pane,
            "message" to message,
            "submit" to submit,
        )

        override fun toString(): String =
            "SendAgentMessage(pane=$pane, submit=$submit, message=<redacted>)"
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
    init {
        require(canonicalJson.length <= RelayV2OutboxLimits.MAX_ARGUMENTS_CANONICAL_BYTES) {
            "canonical arguments exceed the hard character bound"
        }
    }

    val utf8ByteCount: Int by lazy(LazyThreadSafetyMode.NONE) {
        canonicalJson.toByteArray(Charsets.UTF_8).size
    }

    fun utf8Bytes(): ByteArray = canonicalJson.toByteArray(Charsets.UTF_8)

    override fun toString(): String =
        "RelayV2CanonicalRequestArguments(charCount=${canonicalJson.length}, <redacted>)"

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
    val sha256Hex: String,
    val canonicalRequestByteCount: Int,
) {
    init {
        require(schemaVersion == SCHEMA_VERSION) { "unsupported request fingerprint schema" }
        require(SHA256_HEX.matches(sha256Hex)) { "invalid request fingerprint" }
        require(canonicalRequestByteCount > 0)
    }

    companion object {
        const val SCHEMA_VERSION = 1
        private val SHA256_HEX = Regex("^[0-9a-f]{64}$")
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

    override fun toString(): String =
        "RelayV2OutboxDraft(commandId=$commandId, operation=$operation, <redacted>)"
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
    val proposedTarget: RelayV2ReissueTargetSnapshot,
    val sourceConfirmedTarget: RelayV2ReissueTargetSnapshot,
    val confirmationOrdinal: Long,
) {
    init {
        requireOutboxId(observedHostEpoch)
        requireOutboxId(dedupeWindowId)
        require(proposedTarget.expectedHostEpoch == observedHostEpoch)
        require(proposedTarget.dedupeWindowId == dedupeWindowId)
        require(confirmationOrdinal in 1..MAX_JSON_INTEGER)
    }

    override fun toString(): String = "RelayV2QueuedTargetRevalidation(<redacted>)"
}

internal data class RelayV2ReissueTargetSnapshot(
    val expectedHostEpoch: String,
    val dedupeWindowId: String,
    val scopeId: String,
    val sessionId: String?,
    val requestFingerprint: RelayV2RequestFingerprint,
) {
    init {
        listOf(expectedHostEpoch, dedupeWindowId, scopeId).forEach(::requireOutboxId)
        sessionId?.let(::requireOutboxId)
    }

    override fun toString(): String = "RelayV2ReissueTargetSnapshot(<redacted>)"
}

internal data class RelayV2ConfirmedTargetStep(
    val sourceTarget: RelayV2ReissueTargetSnapshot,
    val confirmedTarget: RelayV2ReissueTargetSnapshot,
    val confirmationOrdinal: Long,
) {
    init {
        require(sourceTarget.expectedHostEpoch != confirmedTarget.expectedHostEpoch)
        require(confirmationOrdinal in 1..MAX_JSON_INTEGER)
    }

    override fun toString(): String = "RelayV2ConfirmedTargetStep(<redacted>)"
}

internal data class RelayV2TargetProvenance(
    val initialTarget: RelayV2ReissueTargetSnapshot,
    val confirmedHistory: List<RelayV2ConfirmedTargetStep>,
) {
    override fun toString(): String =
        "RelayV2TargetProvenance(steps=${confirmedHistory.size}, <redacted>)"
}

internal data class RelayV2ReissueLineageProof(
    val parentProfileId: String,
    val parentPrincipalId: String,
    val parentHostId: String,
    val parentCommandId: String,
    val parentExpectedHostEpoch: String,
    val parentDedupeWindowId: String,
    val parentScopeId: String,
    val parentSessionId: String?,
    val parentRequestFingerprint: RelayV2RequestFingerprint,
    val replacementProfileId: String,
    val replacementPrincipalId: String,
    val replacementHostId: String,
    val replacementCommandId: String,
    val replacementInitialTarget: RelayV2ReissueTargetSnapshot,
) {
    init {
        listOf(
            parentProfileId,
            parentPrincipalId,
            parentHostId,
            parentCommandId,
            parentExpectedHostEpoch,
            parentDedupeWindowId,
            parentScopeId,
            replacementProfileId,
            replacementPrincipalId,
            replacementHostId,
            replacementCommandId,
        ).forEach(::requireOutboxId)
        parentSessionId?.let(::requireOutboxId)
    }

    override fun toString(): String = "RelayV2ReissueLineageProof(<redacted>)"
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
    val reissueLineageProof: RelayV2ReissueLineageProof? = null,
    val targetProvenance: RelayV2TargetProvenance,
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
    val canonicalJson: String by lazy(LazyThreadSafetyMode.NONE) { canonicalEntryJson() }
    val canonicalByteCount: Int by lazy(LazyThreadSafetyMode.NONE) {
        canonicalJson.toByteArray(Charsets.UTF_8).size
    }
    val targetProvenanceCanonicalByteCount: Int by lazy(
        LazyThreadSafetyMode.NONE,
    ) {
        RelayV2OutboxCanonicalJson.stringify(
            targetProvenance.canonicalValue(),
        ).toByteArray(Charsets.UTF_8).size
    }

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
        require(createdOrder >= 0)
        require(createdAtMillis in 0..MAX_JSON_INTEGER)
    }

    internal fun validateForRestore() {
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
        require(
            targetRevalidation == null ||
                targetRevalidation.proposedTarget == reissueTargetSnapshot(),
        )
        require((reissuedFromCommandId == null) == (reissueLineageProof == null))
        require(targetProvenance.isValidFor(this)) { "invalid target provenance" }
    }

    override fun toString(): String =
        "RelayV2OutboxEntry(id=$id, state=$state, attempts=${attempts.size}, <redacted>)"

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
            "reissueLineageProof" to reissueLineageProof?.let {
                mapOf(
                    "parentCommandId" to it.parentCommandId,
                    "parentDedupeWindowId" to it.parentDedupeWindowId,
                    "parentExpectedHostEpoch" to it.parentExpectedHostEpoch,
                    "parentHostId" to it.parentHostId,
                    "parentPrincipalId" to it.parentPrincipalId,
                    "parentProfileId" to it.parentProfileId,
                    "parentRequestFingerprint" to mapOf(
                        "canonicalRequestByteCount" to
                            it.parentRequestFingerprint.canonicalRequestByteCount,
                        "schemaVersion" to it.parentRequestFingerprint.schemaVersion,
                        "sha256Hex" to it.parentRequestFingerprint.sha256Hex,
                    ),
                    "parentScopeId" to it.parentScopeId,
                    "parentSessionId" to it.parentSessionId,
                    "replacementCommandId" to it.replacementCommandId,
                    "replacementHostId" to it.replacementHostId,
                    "replacementInitialTarget" to it.replacementInitialTarget.canonicalMap(),
                    "replacementPrincipalId" to it.replacementPrincipalId,
                    "replacementProfileId" to it.replacementProfileId,
                )
            },
            "targetProvenance" to targetProvenance.canonicalValue(),
            "replacementCommandId" to replacementCommandId,
            "requestFingerprint" to requestFingerprint.sha256Hex,
            "requestFingerprintSchemaVersion" to requestFingerprint.schemaVersion,
            "scopeId" to scopeId,
            "sessionId" to sessionId,
            "state" to state.persistedTag,
            "targetRevalidation" to targetRevalidation?.let {
                mapOf(
                    "confirmationOrdinal" to it.confirmationOrdinal,
                    "dedupeWindowId" to it.dedupeWindowId,
                    "observedHostEpoch" to it.observedHostEpoch,
                    "proposedTarget" to it.proposedTarget.canonicalMap(),
                    "sourceConfirmedTarget" to it.sourceConfirmedTarget.canonicalMap(),
                )
            },
        ),
    )
}

internal class RelayV2OutboxState private constructor(
    val entries: List<RelayV2OutboxEntry>,
    val nextCreationOrder: Long,
    val canonicalByteCount: Int,
) {
    fun entry(id: RelayV2OutboxEntryId): RelayV2OutboxEntry? = entries.firstOrNull { it.id == id }

    override fun toString(): String =
        "RelayV2OutboxState(entries=${entries.size}, canonicalByteCount=$canonicalByteCount, <redacted>)"

    companion object {
        fun empty(): RelayV2OutboxState = restore(emptyList(), 0)

        fun restore(
            entries: List<RelayV2OutboxEntry>,
            nextCreationOrder: Long,
        ): RelayV2OutboxState {
            require(nextCreationOrder >= 0) { "invalid next creation order" }
            requireOutboxCapacity(
                entries.size <= RelayV2OutboxLimits.MAX_ENTRIES,
                "too many Outbox entries",
            )

            var cheapStateLowerBound = 0L
            entries.forEach { entry ->
                requireOutboxCapacity(
                    entry.targetProvenance.confirmedHistory.size <=
                        RelayV2OutboxLimits.MAX_TARGET_PROVENANCE_STEPS,
                    "too many target provenance steps",
                )
                requireOutboxCapacity(
                    entry.attempts.size <= RelayV2OutboxLimits.MAX_ATTEMPTS_PER_ENTRY,
                    "too many attempts",
                )
                requireOutboxCapacity(
                    entry.canonicalRequestArguments.canonicalJson.length <=
                        RelayV2OutboxLimits.MAX_ARGUMENTS_CANONICAL_BYTES,
                    "canonical arguments exceed the hard bound",
                )
                cheapStateLowerBound += entry.cheapCanonicalLowerBound()
                requireOutboxCapacity(
                    cheapStateLowerBound <= RelayV2OutboxLimits.MAX_STATE_CANONICAL_BYTES,
                    "Outbox state exceeds the cheap hard bound",
                )
            }

            val snapshots = entries.map { entry ->
                entry.copy(
                    attempts = immutableListSnapshot(entry.attempts),
                    targetProvenance = entry.targetProvenance.copy(
                        confirmedHistory = immutableListSnapshot(
                            entry.targetProvenance.confirmedHistory,
                        ),
                    ),
                )
            }
            require(snapshots.map { it.id }.toSet().size == snapshots.size) {
                "duplicate command identity"
            }
            require(snapshots.map { it.createdOrder }.toSet().size == snapshots.size) {
                "duplicate creation order"
            }
            require(snapshots.all { it.createdOrder < nextCreationOrder }) {
                "invalid creation order"
            }

            var canonicalEntriesBytes = 0L
            snapshots.forEachIndexed { index, entry ->
                requireOutboxCapacity(
                    entry.targetProvenanceCanonicalByteCount <=
                        RelayV2OutboxLimits.MAX_TARGET_PROVENANCE_CANONICAL_BYTES,
                    "target provenance exceeds the canonical hard bound",
                )
                entry.validateForRestore()
                requireOutboxCapacity(
                    entry.canonicalRequestArguments.utf8ByteCount <=
                        RelayV2OutboxLimits.MAX_ARGUMENTS_CANONICAL_BYTES,
                    "canonical arguments exceed the UTF-8 hard bound",
                )
                requireOutboxCapacity(
                    entry.canonicalByteCount <= RelayV2OutboxLimits.MAX_ENTRY_CANONICAL_BYTES,
                    "Outbox entry exceeds the canonical hard bound",
                )
                canonicalEntriesBytes += entry.canonicalByteCount
                if (index > 0) canonicalEntriesBytes += 1
                requireOutboxCapacity(
                    canonicalEntriesBytes + stateCanonicalFixedBytes(nextCreationOrder) <=
                        RelayV2OutboxLimits.MAX_STATE_CANONICAL_BYTES,
                    "Outbox state exceeds the canonical hard bound",
                )
            }
            validateAttemptOwnership(snapshots)
            validateReissueGraph(snapshots)

            val sorted = snapshots.sortedWith(
                compareBy<RelayV2OutboxEntry> { it.createdOrder }.thenBy { it.commandId },
            )
            val canonicalByteCount = (
                stateCanonicalFixedBytes(nextCreationOrder) + canonicalEntriesBytes
            ).toInt()
            return RelayV2OutboxState(
                entries = immutableListSnapshot(sorted),
                nextCreationOrder = nextCreationOrder,
                canonicalByteCount = canonicalByteCount,
            )
        }
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

internal enum class RelayV2ExpiredFinalState(val wireValue: String) {
    SUCCEEDED("succeeded"),
    FAILED("failed"),
    IN_DOUBT("in_doubt"),
    ;

    companion object {
        fun fromWireValue(value: String): RelayV2ExpiredFinalState? =
            entries.singleOrNull { it.wireValue == value }
    }
}

internal enum class RelayV2CommandStatusSource(val attemptKind: RelayV2OutboxAttemptKind?) {
    EXECUTE_RESPONSE(RelayV2OutboxAttemptKind.EXECUTE),
    QUERY_RESPONSE(RelayV2OutboxAttemptKind.QUERY),
    RESULT_EVENT(null),
}

internal enum class RelayV2ResultSessionKind {
    WORKTREE,
    TERMINAL,
}

internal sealed interface RelayV2CommandResult {
    data class CreatedSession(
        val sessionId: String,
        val scopeId: String,
        val kind: RelayV2ResultSessionKind,
    ) : RelayV2CommandResult {
        init {
            requireOutboxId(sessionId)
            requireOutboxId(scopeId)
        }
    }

    data class AgentMessage(
        val pane: Int,
        val submit: Boolean,
        val messageUtf8Bytes: Int,
    ) : RelayV2CommandResult {
        init {
            require(pane in 0..65_535)
            require(messageUtf8Bytes in 0..65_536)
        }
    }

    data class KilledSession(
        val sessionId: String,
        val terminated: Boolean,
    ) : RelayV2CommandResult {
        init {
            requireOutboxId(sessionId)
        }
    }
}

/** Already schema-decoded authority evidence. Human-readable message is deliberately inert. */
internal data class RelayV2CommandStatusEvidence(
    val entryId: RelayV2OutboxEntryId,
    val dedupeWindowId: String,
    val hostEpoch: String,
    val scopeId: String,
    val sessionId: String?,
    val operation: RelayV2OutboxOperation,
    val source: RelayV2CommandStatusSource,
    val attemptKind: RelayV2OutboxAttemptKind?,
    val state: RelayV2CommandStatusState,
    val attemptRequestId: String? = null,
    val result: RelayV2CommandResult? = null,
    val retryable: Boolean = false,
    val retryAfterMs: Long? = null,
    val reissueRequired: Boolean = false,
    val errorCode: String? = null,
    val commandDisposition: RelayV2CommandDisposition? = null,
    val detailsReissueRequired: Boolean? = null,
    val expiredFinalState: RelayV2ExpiredFinalState? = null,
    val errorMessage: String? = null,
) {
    init {
        requireOutboxId(dedupeWindowId)
        requireOutboxId(hostEpoch)
        requireOutboxId(scopeId)
        sessionId?.let(::requireOutboxId)
        attemptRequestId?.let(::requireOutboxId)
        require(retryAfterMs == null || retryAfterMs in 0..MAX_JSON_INTEGER)
        errorCode?.let { requireOutboxString(it, 128) }
        errorMessage?.let {
            require(it.length <= 4_096)
            require(it.toByteArray(Charsets.UTF_8).size <= 4_096)
        }
    }

    override fun toString(): String =
        "RelayV2CommandStatusEvidence(entryId=$entryId, state=$state, source=$source, <redacted>)"
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

internal enum class RelayV2NonLineageTransportChange {
    HOST_INSTANCE_CHANGED,
    BROKER_EPOCH_CHANGED,
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

    class DispatchEligible(
        attemptRequestIds: Map<RelayV2OutboxEntryId, String>,
        val effectBudget: Int,
    ) : RelayV2OutboxAction {
        val attemptRequestIds: Map<RelayV2OutboxEntryId, String> = boundedImmutableMapSnapshot(
            attemptRequestIds,
            RelayV2OutboxLimits.MAX_ENTRIES,
            "too many dispatch attempts",
        )

        init {
            require(effectBudget in 0..RelayV2OutboxLimits.MAX_ENTRIES)
        }

        override fun toString(): String =
            "DispatchEligible(attempts=${attemptRequestIds.size}, effectBudget=$effectBudget)"
    }

    class BeginQueries(
        entryIds: List<RelayV2OutboxEntryId>,
        attemptRequestIds: List<String>,
    ) : RelayV2OutboxAction {
        val entryIds: List<RelayV2OutboxEntryId> = boundedImmutableListSnapshot(
            entryIds,
            RelayV2OutboxLimits.MAX_ENTRIES,
            "too many query entries",
        )
        val attemptRequestIds: List<String> = boundedImmutableListSnapshot(
            attemptRequestIds,
            RelayV2OutboxLimits.MAX_QUERY_BATCHES,
            "too many query batches",
        )

        init {
            require(this.entryIds.isNotEmpty())
            require(this.entryIds.toSet().size == this.entryIds.size)
            require(this.attemptRequestIds.isNotEmpty())
            this.attemptRequestIds.forEach(::requireOutboxId)
        }

        override fun toString(): String =
            "BeginQueries(entries=${entryIds.size}, batches=${attemptRequestIds.size})"
    }

    /**
     * A transport adapter uses this only after observing the same authority epoch. Broker and
     * host-instance generations are intentionally absent because neither is command lineage.
     */
    data class HostContinuityObserved(
        val profileId: String,
        val principalId: String,
        val hostId: String,
        val hostEpoch: String,
        val change: RelayV2NonLineageTransportChange,
    ) : RelayV2OutboxAction {
        init {
            listOf(profileId, principalId, hostId, hostEpoch).forEach(::requireOutboxId)
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
    data class Insert(val entry: RelayV2OutboxEntry) : RelayV2OutboxMutation {
        override fun toString(): String = "Insert(entryId=${entry.id}, <redacted>)"
    }

    data class Replace(
        val previousId: RelayV2OutboxEntryId,
        val entry: RelayV2OutboxEntry,
    ) : RelayV2OutboxMutation {
        override fun toString(): String =
            "Replace(previousId=$previousId, entryId=${entry.id}, <redacted>)"
    }
}

internal sealed interface RelayV2OutboxTransactionPlan {
    val mutations: List<RelayV2OutboxMutation>

    data class MutationSet(
        override val mutations: List<RelayV2OutboxMutation>,
    ) : RelayV2OutboxTransactionPlan {
        override fun toString(): String = "MutationSet(size=${mutations.size}, <redacted>)"
    }

    data class AtomicReissue(
        val original: RelayV2OutboxMutation.Replace,
        val replacement: RelayV2OutboxMutation.Insert,
    ) : RelayV2OutboxTransactionPlan {
        override val mutations: List<RelayV2OutboxMutation> =
            immutableListSnapshot(listOf(original, replacement))

        init {
            require(original.entry.id == original.previousId)
            require(original.entry.state == RelayV2OutboxStateTag.REISSUED)
            require(replacement.entry.state == RelayV2OutboxStateTag.QUEUED)
            require(original.entry.replacementCommandId == replacement.entry.commandId)
            require(replacement.entry.reissuedFromCommandId == original.previousId.commandId)
            require(
                original.previousId ==
                    replacement.entry.id.copy(commandId = original.previousId.commandId),
            )
            require(original.entry.dedupeWindowId != replacement.entry.dedupeWindowId)
            require(original.entry.operation == replacement.entry.operation)
            require(original.entry.scopeId == replacement.entry.scopeId)
            require(original.entry.sessionId == replacement.entry.sessionId)
            require(
                original.entry.canonicalRequestArguments ==
                    replacement.entry.canonicalRequestArguments,
            )
        }

        override fun toString(): String =
            "AtomicReissue(original=${original.previousId}, " +
                "replacement=${replacement.entry.id}, <redacted>)"
    }
}

internal data class RelayV2OutboxCommand(
    val entryId: RelayV2OutboxEntryId,
    val dedupeWindowId: String,
    val operation: RelayV2OutboxOperation,
    val scopeId: String,
    val sessionId: String?,
    val canonicalRequestArguments: RelayV2CanonicalRequestArguments,
    val requestFingerprint: RelayV2RequestFingerprint,
) {
    override fun toString(): String =
        "RelayV2OutboxCommand(entryId=$entryId, operation=$operation, <redacted>)"
}

internal data class RelayV2OutboxQueryAuthority(
    val profileId: String,
    val principalId: String,
    val hostId: String,
    val expectedHostEpoch: String,
) {
    init {
        listOf(profileId, principalId, hostId, expectedHostEpoch).forEach(::requireOutboxId)
    }
}

internal data class RelayV2OutboxQueryItem(
    val entryId: RelayV2OutboxEntryId,
    val dedupeWindowId: String,
) {
    init {
        requireOutboxId(dedupeWindowId)
    }
}

internal sealed interface RelayV2OutboxEffect {
    data class ExecuteCommand(
        val command: RelayV2OutboxCommand,
        val attempt: RelayV2OutboxAttempt,
        val retryAfterMs: Long? = null,
    ) : RelayV2OutboxEffect {
        override fun toString(): String =
            "ExecuteCommand(entryId=${command.entryId}, attempt=${attempt.requestId}, <redacted>)"
    }

    data class QueryCommands(
        val authority: RelayV2OutboxQueryAuthority,
        val attemptRequestId: String,
        val items: List<RelayV2OutboxQueryItem>,
    ) : RelayV2OutboxEffect {
        init {
            requireOutboxId(attemptRequestId)
            require(items.size in 1..RelayV2OutboxLimits.MAX_QUERY_ITEMS_PER_BATCH)
            require(items.map { it.entryId }.toSet().size == items.size)
            require(items.all {
                it.entryId.profileId == authority.profileId &&
                    it.entryId.principalId == authority.principalId &&
                    it.entryId.hostId == authority.hostId &&
                    it.entryId.expectedHostEpoch == authority.expectedHostEpoch
            })
        }

        override fun toString(): String =
            "QueryCommands(authority=$authority, items=${items.size}, <redacted>)"
    }

    data class RevalidateOpaqueTarget(
        val entryId: RelayV2OutboxEntryId,
        val observedHostEpoch: String,
        val currentDedupeWindowId: String,
        val priorScopeId: String,
        val priorSessionId: String?,
    ) : RelayV2OutboxEffect {
        override fun toString(): String =
            "RevalidateOpaqueTarget(entryId=$entryId, <redacted>)"
    }

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
    INVARIANT_VIOLATION,
    CAPACITY_EXCEEDED,
}

internal sealed interface RelayV2OutboxResult {
    val state: RelayV2OutboxState

    data class Applied(
        override val state: RelayV2OutboxState,
        val transaction: RelayV2OutboxTransactionPlan,
        val effects: List<RelayV2OutboxEffect>,
    ) : RelayV2OutboxResult {
        override fun toString(): String =
            "Applied(state=$state, mutations=${transaction.mutations.size}, " +
                "effects=${effects.size}, <redacted>)"
    }

    data class Rejected(
        override val state: RelayV2OutboxState,
        val reason: RelayV2OutboxRejection,
    ) : RelayV2OutboxResult {
        override fun toString(): String = "Rejected(reason=$reason, state=$state, <redacted>)"
    }
}

/** Pure, deterministic authority reducer. It performs no clock, UUID, Room, actor, or network IO. */
internal class RelayV2OutboxAuthorityCore(
    private val capacity: RelayV2OutboxCapacity = RelayV2OutboxCapacity(),
) {
    /**
     * Returns the next creation-ordered fresh dispatch cut selected by this authority.
     *
     * The durable repository calls this only from inside its transaction, then feeds the exact
     * selected ids back through [RelayV2OutboxAction.DispatchEligible] in that same transaction.
     */
    fun dispatchEligibleEntryIds(
        state: RelayV2OutboxState,
        effectBudget: Int,
    ): List<RelayV2OutboxEntryId> {
        require(effectBudget in 1..RelayV2OutboxLimits.MAX_DISPATCH_ITEMS_PER_BATCH)
        return immutableListSnapshot(
            dispatchEligibleEntries(state).take(effectBudget).map { it.id },
        )
    }

    fun reduce(
        state: RelayV2OutboxState,
        action: RelayV2OutboxAction,
    ): RelayV2OutboxResult = when (action) {
        is RelayV2OutboxAction.Enqueue -> enqueue(state, action)
        is RelayV2OutboxAction.DispatchEligible -> dispatchEligible(state, action)
        is RelayV2OutboxAction.BeginQueries -> beginQueries(state, action)
        is RelayV2OutboxAction.HostContinuityObserved -> hostContinuityObserved(state, action)
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

        val eligible = dispatchEligibleEntries(state)
        if (!eligible.map { it.id }.toSet().containsAll(action.attemptRequestIds.keys)) {
            return state.reject(RelayV2OutboxRejection.INVALID_TRANSITION)
        }

        val mutations = mutableListOf<RelayV2OutboxMutation>()
        val effects = mutableListOf<RelayV2OutboxEffect>()
        eligible.forEach { entry ->
            if (effects.size >= action.effectBudget) return@forEach
            val requestId = action.attemptRequestIds[entry.id] ?: return@forEach
            val updated = entry.appendAttempt(
                requestId,
                RelayV2OutboxAttemptKind.EXECUTE,
                RelayV2OutboxStateTag.SENDING,
            )
            val attempt = updated.attempts.last()
            mutations += RelayV2OutboxMutation.Replace(entry.id, updated)
            effects += RelayV2OutboxEffect.ExecuteCommand(updated.command(), attempt)
        }
        return apply(state, mutations, effects)
    }

    private fun dispatchEligibleEntries(
        state: RelayV2OutboxState,
    ): List<RelayV2OutboxEntry> {
        val blocked = mutableSetOf<RelayV2OutboxLaneKey>()
        val eligible = mutableListOf<RelayV2OutboxEntry>()
        state.entries.forEach { entry ->
            when (entry.state) {
                RelayV2OutboxStateTag.SENDING,
                RelayV2OutboxStateTag.ACCEPTED,
                RelayV2OutboxStateTag.CONFIRMING,
                RelayV2OutboxStateTag.AMBIGUOUS,
                -> blocked += entry.laneKey
                RelayV2OutboxStateTag.QUEUED -> {
                    if (blocked.add(entry.laneKey) && !entry.requiresTargetRevalidation()) {
                        eligible += entry
                    }
                }
                RelayV2OutboxStateTag.SUCCEEDED,
                RelayV2OutboxStateTag.FAILED_FINAL,
                RelayV2OutboxStateTag.REISSUED,
                -> Unit
            }
        }
        return eligible
    }

    private fun beginQueries(
        state: RelayV2OutboxState,
        action: RelayV2OutboxAction.BeginQueries,
    ): RelayV2OutboxResult {
        if (action.attemptRequestIds.toSet().size != action.attemptRequestIds.size ||
            action.attemptRequestIds.any { state.hasAttemptRequestId(it) }
        ) {
            return state.reject(RelayV2OutboxRejection.DUPLICATE_ATTEMPT_REQUEST_ID)
        }
        val selectedIds = action.entryIds.toSet()
        val entries = state.entries.filter { it.id in selectedIds }
        if (entries.size != selectedIds.size) {
            return state.reject(RelayV2OutboxRejection.ENTRY_NOT_FOUND)
        }
        if (entries.any { it.state !in QUERYABLE_STATES }) {
            return state.reject(RelayV2OutboxRejection.INVALID_TRANSITION)
        }

        val groups = linkedMapOf<RelayV2OutboxQueryAuthority, MutableList<RelayV2OutboxEntry>>()
        entries.forEach { entry ->
            groups.getOrPut(entry.queryAuthority()) { mutableListOf() } += entry
        }
        val batches = groups.flatMap { (authority, authorityEntries) ->
            authorityEntries.chunked(RelayV2OutboxLimits.MAX_QUERY_ITEMS_PER_BATCH).map {
                authority to it
            }
        }
        if (batches.size != action.attemptRequestIds.size) {
            return state.reject(RelayV2OutboxRejection.RECOVERY_INPUT_MISMATCH)
        }

        val mutations = mutableListOf<RelayV2OutboxMutation>()
        val effects = mutableListOf<RelayV2OutboxEffect>()
        batches.forEachIndexed { index, (authority, batchEntries) ->
            val requestId = action.attemptRequestIds[index]
            val items = batchEntries.map { entry ->
                val queryState = if (entry.state == RelayV2OutboxStateTag.AMBIGUOUS) {
                    RelayV2OutboxStateTag.AMBIGUOUS
                } else {
                    RelayV2OutboxStateTag.CONFIRMING
                }
                val updated = entry.appendAttempt(
                    requestId,
                    RelayV2OutboxAttemptKind.QUERY,
                    queryState,
                )
                mutations += RelayV2OutboxMutation.Replace(entry.id, updated)
                RelayV2OutboxQueryItem(updated.id, updated.dedupeWindowId)
            }
            effects += RelayV2OutboxEffect.QueryCommands(
                authority,
                requestId,
                immutableListSnapshot(items),
            )
        }
        return apply(state, mutations, effects)
    }

    private fun hostContinuityObserved(
        state: RelayV2OutboxState,
        action: RelayV2OutboxAction.HostContinuityObserved,
    ): RelayV2OutboxResult {
        val matches = state.entries.any {
            it.profileId == action.profileId &&
                it.principalId == action.principalId &&
                it.hostId == action.hostId &&
                it.expectedHostEpoch == action.hostEpoch
        }
        if (!matches) return state.reject(RelayV2OutboxRejection.ENTRY_NOT_FOUND)
        return apply(state, emptyList())
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
            evidence.scopeId != entry.scopeId ||
            evidence.sessionId != entry.sessionId ||
            evidence.operation != entry.operation ||
            !evidence.hasValidCorrelation(entry)
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
        if ((evidence.state == RelayV2CommandStatusState.EXPIRED) !=
            (evidence.expiredFinalState != null)
        ) {
            return state.reject(RelayV2OutboxRejection.STATUS_NOT_AUTHORIZING)
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
            RelayV2CommandStatusState.SUCCEEDED ->
                evidence.hasNoErrorMetadata() && evidence.result.matches(entry)
            RelayV2CommandStatusState.FAILED ->
                !evidence.retryable &&
                    evidence.retryAfterMs == null &&
                    !evidence.reissueRequired &&
                    evidence.errorCode in FINAL_COMMAND_FAILURE_CODES &&
                    evidence.commandDisposition == RelayV2CommandDisposition.COMPLETED &&
                    evidence.detailsReissueRequired == null &&
                    evidence.result == null
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
            RelayV2CommandStatusState.EXPIRED -> evidence.isValidExpiredFailure()
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
        val proofKind = evidence.source.attemptKind
            ?: return state.reject(RelayV2OutboxRejection.STATUS_NOT_AUTHORIZING)
        val proofRequestId = evidence.attemptRequestId
            ?: return state.reject(RelayV2OutboxRejection.STATUS_NOT_AUTHORIZING)
        if (evidence.attemptKind != proofKind) {
            return state.reject(RelayV2OutboxRejection.STATUS_NOT_AUTHORIZING)
        }
        val proofAttempt = entry.attempts.firstOrNull {
            it.requestId == proofRequestId && it.kind == proofKind
        }
            ?: return state.reject(RelayV2OutboxRejection.STATUS_IDENTITY_MISMATCH)
        if (entry.attempts.any {
                it.kind == RelayV2OutboxAttemptKind.EXECUTE &&
                    it.ordinal > proofAttempt.ordinal
            }
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
            val replacementBase = entryFromDraft(
                replacementDraft,
                createdOrder = state.nextCreationOrder,
                createdAtMillis = reissue.replacementCreatedAtMillis,
                reissuedFromCommandId = entry.commandId,
            )
            val replacement = replacementBase.copy(
                reissueLineageProof = RelayV2ReissueLineageProof(
                    parentProfileId = entry.profileId,
                    parentPrincipalId = entry.principalId,
                    parentHostId = entry.hostId,
                    parentCommandId = entry.commandId,
                    parentExpectedHostEpoch = entry.expectedHostEpoch,
                    parentDedupeWindowId = entry.dedupeWindowId,
                    parentScopeId = entry.scopeId,
                    parentSessionId = entry.sessionId,
                    parentRequestFingerprint = entry.requestFingerprint,
                    replacementProfileId = replacementBase.profileId,
                    replacementPrincipalId = replacementBase.principalId,
                    replacementHostId = replacementBase.hostId,
                    replacementCommandId = replacementBase.commandId,
                    replacementInitialTarget = replacementBase.targetProvenance.initialTarget,
                ),
            )
            if (state.entry(replacement.id) != null) {
                return state.reject(RelayV2OutboxRejection.DUPLICATE_COMMAND)
            }
            val original = entry.copy(
                state = RelayV2OutboxStateTag.REISSUED,
                replacementCommandId = replacement.commandId,
            )
            val transaction = RelayV2OutboxTransactionPlan.AtomicReissue(
                original = RelayV2OutboxMutation.Replace(entry.id, original),
                replacement = RelayV2OutboxMutation.Insert(replacement),
            )
            return apply(
                state,
                mutations = transaction.mutations,
                effects = listOf(
                    RelayV2OutboxEffect.ReissueCreated(entry.id, replacement.id),
                ),
                nextCreationOrder = state.nextCreationOrder + 1,
                transactionPlan = transaction,
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
                    val existingPending = entry.targetRevalidation
                    val sourceConfirmedTarget = existingPending?.sourceConfirmedTarget
                        ?: entry.targetProvenance.confirmedHistory.lastOrNull()?.confirmedTarget
                        ?: entry.targetProvenance.initialTarget
                    val confirmationOrdinal = existingPending?.confirmationOrdinal
                        ?: (entry.targetProvenance.confirmedHistory.size + 1).toLong()
                    val proposedTarget = RelayV2ReissueTargetSnapshot(
                        expectedHostEpoch = action.observedHostEpoch,
                        dedupeWindowId = action.currentDedupeWindowId,
                        scopeId = entry.scopeId,
                        sessionId = entry.sessionId,
                        requestFingerprint = calculateRequestFingerprint(
                            entry.requestFingerprint.schemaVersion,
                            entry.operation,
                            action.currentDedupeWindowId,
                            action.observedHostEpoch,
                            entry.hostId,
                            entry.scopeId,
                            entry.sessionId,
                            entry.canonicalRequestArguments,
                        ),
                    )
                    val revalidation = RelayV2QueuedTargetRevalidation(
                        action.observedHostEpoch,
                        action.currentDedupeWindowId,
                        proposedTarget,
                        sourceConfirmedTarget,
                        confirmationOrdinal,
                    )
                    val updated = entry.copy(
                        expectedHostEpoch = proposedTarget.expectedHostEpoch,
                        dedupeWindowId = proposedTarget.dedupeWindowId,
                        requestFingerprint = proposedTarget.requestFingerprint,
                        targetRevalidation = revalidation,
                    )
                    mutations += RelayV2OutboxMutation.Replace(entry.id, updated)
                    effects += RelayV2OutboxEffect.RevalidateOpaqueTarget(
                        updated.id,
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
            pending.dedupeWindowId != action.currentDedupeWindowId ||
            entry.expectedHostEpoch != action.observedHostEpoch ||
            entry.dedupeWindowId != action.currentDedupeWindowId
        ) {
            return state.reject(RelayV2OutboxRejection.STATUS_IDENTITY_MISMATCH)
        }
        if (runCatching { requireTargetShape(entry.operation, action.verifiedSessionId) }.isFailure) {
            return state.reject(RelayV2OutboxRejection.INVALID_TRANSITION)
        }
        if (entry.reissuedFromCommandId != null && entry.reissueLineageProof == null) {
            return state.reject(RelayV2OutboxRejection.INVARIANT_VIOLATION)
        }
        val confirmedTarget = pending.proposedTarget
        if (confirmedTarget != entry.reissueTargetSnapshot() ||
            action.verifiedScopeId != confirmedTarget.scopeId ||
            action.verifiedSessionId != confirmedTarget.sessionId
        ) {
            return state.reject(RelayV2OutboxRejection.STATUS_IDENTITY_MISMATCH)
        }
        val confirmedHistory = entry.targetProvenance.confirmedHistory
        val expectedSource = confirmedHistory.lastOrNull()?.confirmedTarget
            ?: entry.targetProvenance.initialTarget
        val expectedOrdinal = (confirmedHistory.size + 1).toLong()
        if (pending.sourceConfirmedTarget != expectedSource ||
            pending.confirmationOrdinal != expectedOrdinal
        ) {
            return state.reject(RelayV2OutboxRejection.INVARIANT_VIOLATION)
        }
        if (confirmedHistory.size >= capacity.maxTargetProvenanceSteps) {
            return state.reject(RelayV2OutboxRejection.CAPACITY_EXCEEDED)
        }
        val step = RelayV2ConfirmedTargetStep(
            sourceTarget = pending.sourceConfirmedTarget,
            confirmedTarget = confirmedTarget,
            confirmationOrdinal = pending.confirmationOrdinal,
        )
        val updatedProvenance = entry.targetProvenance.copy(
            confirmedHistory = immutableListSnapshot(confirmedHistory + step),
        )
        val updated = entry.copy(
            expectedHostEpoch = confirmedTarget.expectedHostEpoch,
            dedupeWindowId = confirmedTarget.dedupeWindowId,
            scopeId = confirmedTarget.scopeId,
            sessionId = confirmedTarget.sessionId,
            requestFingerprint = confirmedTarget.requestFingerprint,
            targetRevalidation = null,
            targetProvenance = updatedProvenance,
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
        transactionPlan: RelayV2OutboxTransactionPlan =
            RelayV2OutboxTransactionPlan.MutationSet(immutableListSnapshot(mutations)),
    ): RelayV2OutboxResult {
        require(transactionPlan.mutations == mutations)
        if (mutations.isEmpty()) {
            return RelayV2OutboxResult.Applied(
                state,
                transactionPlan,
                immutableListSnapshot(effects),
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
        val candidate = try {
            RelayV2OutboxState.restore(entries, nextCreationOrder)
        } catch (_: RelayV2OutboxCapacityExceededException) {
            return state.reject(RelayV2OutboxRejection.CAPACITY_EXCEEDED)
        } catch (_: IllegalArgumentException) {
            return state.reject(RelayV2OutboxRejection.INVARIANT_VIOLATION)
        } catch (_: IllegalStateException) {
            return state.reject(RelayV2OutboxRejection.INVARIANT_VIOLATION)
        }
        if (!withinCapacity(candidate)) {
            return state.reject(RelayV2OutboxRejection.CAPACITY_EXCEEDED)
        }
        return RelayV2OutboxResult.Applied(
            state = candidate,
            transaction = transactionPlan,
            effects = immutableListSnapshot(effects),
        )
    }

    private fun withinCapacity(state: RelayV2OutboxState): Boolean =
        state.entries.size <= capacity.maxEntries &&
            state.canonicalByteCount <= capacity.maxStateCanonicalBytes &&
            state.entries.all {
                it.attempts.size <= capacity.maxAttemptsPerEntry &&
                    it.targetProvenance.confirmedHistory.size <=
                    capacity.maxTargetProvenanceSteps &&
                    it.targetProvenanceCanonicalByteCount <=
                    capacity.maxTargetProvenanceCanonicalBytes &&
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
    val requestFingerprint = calculateRequestFingerprint(
        draft.requestFingerprintSchemaVersion,
        draft.operation,
        draft.dedupeWindowId,
        draft.expectedHostEpoch,
        draft.hostId,
        draft.scopeId,
        draft.sessionId,
        canonical,
    )
    val initialTarget = RelayV2ReissueTargetSnapshot(
        expectedHostEpoch = draft.expectedHostEpoch,
        dedupeWindowId = draft.dedupeWindowId,
        scopeId = draft.scopeId,
        sessionId = draft.sessionId,
        requestFingerprint = requestFingerprint,
    )
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
        requestFingerprint = requestFingerprint,
        state = RelayV2OutboxStateTag.QUEUED,
        acceptanceEvidence = RelayV2OutboxAcceptanceEvidence.NONE,
        attempts = emptyList(),
        createdOrder = createdOrder,
        createdAtMillis = createdAtMillis,
        reissuedFromCommandId = reissuedFromCommandId,
        targetProvenance = RelayV2TargetProvenance(initialTarget, emptyList()),
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

private fun RelayV2OutboxEntry.reissueTargetSnapshot(): RelayV2ReissueTargetSnapshot =
    RelayV2ReissueTargetSnapshot(
        expectedHostEpoch = expectedHostEpoch,
        dedupeWindowId = dedupeWindowId,
        scopeId = scopeId,
        sessionId = sessionId,
        requestFingerprint = requestFingerprint,
    )

private fun RelayV2ReissueTargetSnapshot.canonicalMap(): Map<String, Any?> = mapOf(
    "dedupeWindowId" to dedupeWindowId,
    "expectedHostEpoch" to expectedHostEpoch,
    "requestFingerprint" to mapOf(
        "canonicalRequestByteCount" to requestFingerprint.canonicalRequestByteCount,
        "schemaVersion" to requestFingerprint.schemaVersion,
        "sha256Hex" to requestFingerprint.sha256Hex,
    ),
    "scopeId" to scopeId,
    "sessionId" to sessionId,
)

private fun List<RelayV2ConfirmedTargetStep>.canonicalValue(): List<Map<String, Any?>> =
    map { step ->
        mapOf(
            "confirmationOrdinal" to step.confirmationOrdinal,
            "confirmedTarget" to step.confirmedTarget.canonicalMap(),
            "sourceTarget" to step.sourceTarget.canonicalMap(),
        )
    }

private fun RelayV2TargetProvenance.canonicalValue(): Map<String, Any?> = mapOf(
    "confirmedHistory" to confirmedHistory.canonicalValue(),
    "initialTarget" to initialTarget.canonicalMap(),
)

private fun RelayV2OutboxEntry.requiresTargetRevalidation(): Boolean =
    targetRevalidation != null

private fun RelayV2OutboxEntry.command(): RelayV2OutboxCommand = RelayV2OutboxCommand(
    entryId = id,
    dedupeWindowId = dedupeWindowId,
    operation = operation,
    scopeId = scopeId,
    sessionId = sessionId,
    canonicalRequestArguments = canonicalRequestArguments,
    requestFingerprint = requestFingerprint,
)

private fun RelayV2OutboxEntry.queryAuthority(): RelayV2OutboxQueryAuthority =
    RelayV2OutboxQueryAuthority(
        profileId = profileId,
        principalId = principalId,
        hostId = hostId,
        expectedHostEpoch = expectedHostEpoch,
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

private fun RelayV2CommandStatusEvidence.hasNoErrorMetadata(): Boolean =
    !retryable &&
        retryAfterMs == null &&
        !reissueRequired &&
        errorCode == null &&
        commandDisposition == null &&
        detailsReissueRequired == null &&
        expiredFinalState == null

private fun RelayV2CommandStatusEvidence.isNonFailureStatus(): Boolean =
    hasNoErrorMetadata() && result == null

private fun RelayV2CommandStatusEvidence.hasValidCorrelation(entry: RelayV2OutboxEntry): Boolean =
    when (source) {
        RelayV2CommandStatusSource.RESULT_EVENT ->
            attemptRequestId == null &&
                attemptKind == null &&
                state in setOf(
                    RelayV2CommandStatusState.SUCCEEDED,
                    RelayV2CommandStatusState.FAILED,
                    RelayV2CommandStatusState.IN_DOUBT,
                )
        RelayV2CommandStatusSource.EXECUTE_RESPONSE,
        RelayV2CommandStatusSource.QUERY_RESPONSE,
        -> {
            val requestId = attemptRequestId ?: return false
            val expectedKind = source.attemptKind ?: return false
            attemptKind == expectedKind &&
                entry.attempts.any { it.requestId == requestId && it.kind == expectedKind }
        }
    }

private fun RelayV2CommandResult?.matches(entry: RelayV2OutboxEntry): Boolean =
    when (entry.operation) {
        RelayV2OutboxOperation.CREATE_WORKTREE ->
            this is RelayV2CommandResult.CreatedSession &&
                scopeId == entry.scopeId &&
                kind == RelayV2ResultSessionKind.WORKTREE
        RelayV2OutboxOperation.CREATE_TERMINAL ->
            this is RelayV2CommandResult.CreatedSession &&
                scopeId == entry.scopeId &&
                kind == RelayV2ResultSessionKind.TERMINAL
        RelayV2OutboxOperation.SEND_AGENT_MESSAGE -> {
            val arguments = entry.canonicalRequestArguments.value as?
                RelayV2OutboxArguments.SendAgentMessage
            this is RelayV2CommandResult.AgentMessage &&
                arguments != null &&
                pane == arguments.pane &&
                submit == arguments.submit &&
                messageUtf8Bytes == arguments.message.toByteArray(Charsets.UTF_8).size
        }
        RelayV2OutboxOperation.KILL_SESSION ->
            this is RelayV2CommandResult.KilledSession &&
                sessionId == entry.sessionId &&
                terminated
    }

private fun RelayV2CommandStatusEvidence.isFixedFailure(
    code: String,
    disposition: RelayV2CommandDisposition?,
): Boolean = !retryable &&
    retryAfterMs == null &&
    !reissueRequired &&
    errorCode == code &&
    commandDisposition == disposition &&
    detailsReissueRequired == null &&
    expiredFinalState == null &&
    result == null

private fun RelayV2CommandStatusEvidence.isValidExpiredFailure(): Boolean {
    val requiredDisposition = when (expiredFinalState) {
        RelayV2ExpiredFinalState.SUCCEEDED,
        RelayV2ExpiredFinalState.FAILED,
        -> RelayV2CommandDisposition.COMPLETED
        RelayV2ExpiredFinalState.IN_DOUBT -> RelayV2CommandDisposition.IN_DOUBT
        null -> return false
    }
    return !retryable &&
        retryAfterMs == null &&
        !reissueRequired &&
        errorCode == "COMMAND_RESULT_EXPIRED" &&
        commandDisposition == requiredDisposition &&
        detailsReissueRequired == null &&
        result == null
}

private fun RelayV2CommandStatusEvidence.isRetryableNotAccepted(): Boolean =
    retryable &&
        retryAfterMs != null &&
        !reissueRequired &&
        errorCode == "COMMAND_NOT_ACCEPTED" &&
        commandDisposition == RelayV2CommandDisposition.NOT_ACCEPTED &&
        detailsReissueRequired == null &&
        expiredFinalState == null &&
        result == null

private fun RelayV2CommandStatusEvidence.isReissueRequiredNotAccepted(): Boolean =
    !retryable &&
        retryAfterMs == null &&
        reissueRequired &&
        errorCode == "COMMAND_WINDOW_EXPIRED" &&
        commandDisposition == RelayV2CommandDisposition.NOT_ACCEPTED &&
        detailsReissueRequired == true &&
        expiredFinalState == null &&
        result == null

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
    val canonicalRequest = canonicalRelayV2FingerprintRequest(
        schemaVersion,
        operation,
        dedupeWindowId,
        hostEpoch,
        hostId,
        scopeId,
        sessionId,
        arguments,
    )
    val bytes = canonicalRequest.toByteArray(Charsets.UTF_8)
    val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
    return RelayV2RequestFingerprint(
        schemaVersion,
        digest.joinToString(separator = "") { byte ->
            (byte.toInt() and 0xff).toString(16).padStart(2, '0')
        },
        bytes.size,
    )
}

internal fun canonicalRelayV2FingerprintRequest(
    schemaVersion: Int,
    operation: RelayV2OutboxOperation,
    dedupeWindowId: String,
    hostEpoch: String,
    hostId: String,
    scopeId: String,
    sessionId: String?,
    arguments: RelayV2CanonicalRequestArguments,
): String = RelayV2OutboxCanonicalJson.stringify(
    buildMap {
        put("arguments", arguments.value.canonicalMap())
        put("dedupeWindowId", dedupeWindowId)
        put("hostEpoch", hostEpoch)
        put("hostId", hostId)
        put("operation", operation.wireValue)
        put("schemaVersion", schemaVersion)
        put("scopeId", scopeId)
        sessionId?.let { put("sessionId", it) }
    },
)

private fun stateCanonicalFixedBytes(nextCreationOrder: Long): Long =
    "{\"entries\":[".toByteArray(Charsets.UTF_8).size.toLong() +
        "],\"nextCreationOrder\":$nextCreationOrder}".toByteArray(Charsets.UTF_8).size

private class RelayV2OutboxCapacityExceededException(message: String) :
    IllegalArgumentException(message)

private fun requireOutboxCapacity(condition: Boolean, message: String) {
    if (!condition) throw RelayV2OutboxCapacityExceededException(message)
}

private fun RelayV2ReissueTargetSnapshot.cheapCanonicalLowerBound(): Long =
    expectedHostEpoch.length.toLong() +
        dedupeWindowId.length +
        scopeId.length +
        (sessionId?.length ?: 0) +
        requestFingerprint.sha256Hex.length

private fun RelayV2OutboxEntry.cheapCanonicalLowerBound(): Long =
    canonicalRequestArguments.canonicalJson.length.toLong() +
        profileId.length +
        principalId.length +
        hostId.length +
        expectedHostEpoch.length +
        dedupeWindowId.length +
        commandId.length +
        scopeId.length +
        (sessionId?.length ?: 0) +
        (targetRevalidation?.observedHostEpoch?.length ?: 0) +
        (targetRevalidation?.dedupeWindowId?.length ?: 0) +
        (reissueLineageProof?.parentProfileId?.length ?: 0) +
        (reissueLineageProof?.parentPrincipalId?.length ?: 0) +
        (reissueLineageProof?.parentHostId?.length ?: 0) +
        (reissueLineageProof?.parentCommandId?.length ?: 0) +
        (reissueLineageProof?.parentExpectedHostEpoch?.length ?: 0) +
        (reissueLineageProof?.parentDedupeWindowId?.length ?: 0) +
        (reissueLineageProof?.parentScopeId?.length ?: 0) +
        (reissueLineageProof?.parentSessionId?.length ?: 0) +
        (reissueLineageProof?.parentRequestFingerprint?.sha256Hex?.length ?: 0) +
        (reissueLineageProof?.replacementProfileId?.length ?: 0) +
        (reissueLineageProof?.replacementPrincipalId?.length ?: 0) +
        (reissueLineageProof?.replacementHostId?.length ?: 0) +
        (reissueLineageProof?.replacementCommandId?.length ?: 0) +
        (reissueLineageProof?.replacementInitialTarget?.cheapCanonicalLowerBound() ?: 0L) +
        targetProvenance.initialTarget.cheapCanonicalLowerBound() +
        targetProvenance.confirmedHistory.sumOf { step ->
            step.sourceTarget.cheapCanonicalLowerBound() +
                step.confirmedTarget.cheapCanonicalLowerBound()
        } +
        (targetRevalidation?.proposedTarget?.cheapCanonicalLowerBound() ?: 0L) +
        (targetRevalidation?.sourceConfirmedTarget?.cheapCanonicalLowerBound() ?: 0L) +
        attempts.sumOf { it.requestId.length.toLong() }

private fun <T> immutableListSnapshot(values: List<T>): List<T> =
    Collections.unmodifiableList(values.toList())

private fun <T> boundedImmutableListSnapshot(
    values: List<T>,
    maximumSize: Int,
    failureMessage: String,
): List<T> {
    require(values.size <= maximumSize) { failureMessage }
    return immutableListSnapshot(values)
}

private fun <K, V> boundedImmutableMapSnapshot(
    values: Map<K, V>,
    maximumSize: Int,
    failureMessage: String,
): Map<K, V> {
    require(values.size <= maximumSize) { failureMessage }
    return Collections.unmodifiableMap(LinkedHashMap(values))
}

private fun validateAttemptOwnership(entries: List<RelayV2OutboxEntry>) {
    val ownership = mutableMapOf<String, MutableList<Pair<RelayV2OutboxEntry, RelayV2OutboxAttempt>>>()
    entries.forEach { entry ->
        entry.attempts.forEach { attempt ->
            ownership.getOrPut(attempt.requestId) { mutableListOf() } += entry to attempt
        }
    }
    ownership.forEach { (requestId, owners) ->
        val kinds = owners.map { it.second.kind }.toSet()
        require(kinds.size == 1) { "attempt requestId $requestId mixes EXECUTE and QUERY" }
        when (kinds.single()) {
            RelayV2OutboxAttemptKind.EXECUTE ->
                require(owners.size == 1) { "EXECUTE requestId has multiple command owners" }
            RelayV2OutboxAttemptKind.QUERY -> {
                require(owners.size <= RelayV2OutboxLimits.MAX_QUERY_ITEMS_PER_BATCH) {
                    "QUERY requestId exceeds its batch bound"
                }
                require(owners.map { it.first.queryAuthority() }.toSet().size == 1) {
                    "QUERY requestId crosses authority"
                }
            }
        }
    }
}

private data class RelayV2ReissueLineageKey(
    val profileId: String,
    val principalId: String,
    val hostId: String,
    val commandId: String,
)

private fun RelayV2OutboxEntry.reissueLineageKey(
    commandId: String = this.commandId,
): RelayV2ReissueLineageKey = RelayV2ReissueLineageKey(
    profileId,
    principalId,
    hostId,
    commandId,
)

private fun validateReissueGraph(entries: List<RelayV2OutboxEntry>) {
    val entriesByKey = HashMap<RelayV2ReissueLineageKey, RelayV2OutboxEntry>(entries.size)
    entries.forEach { entry ->
        require(entriesByKey.put(entry.reissueLineageKey(), entry) == null) {
            "duplicate stable reissue lineage key"
        }
    }

    val parentToChild =
        HashMap<RelayV2ReissueLineageKey, RelayV2ReissueLineageKey>(entries.size)
    val childToParent =
        HashMap<RelayV2ReissueLineageKey, RelayV2ReissueLineageKey>(entries.size)
    entries.forEach { child ->
        val parentCommandId = child.reissuedFromCommandId ?: return@forEach
        val childKey = child.reissueLineageKey()
        val parentKey = child.reissueLineageKey(parentCommandId)
        require(parentToChild.put(parentKey, childKey) == null) {
            "reissue parent has multiple replacements"
        }
        require(childToParent.put(childKey, parentKey) == null) {
            "reissue replacement has multiple parents"
        }
    }

    childToParent.forEach { (childKey, parentKey) ->
        val child = entriesByKey.getValue(childKey)
        val parent = entriesByKey[parentKey]
            ?: error("reissue replacement is orphaned")
        require(parent.state == RelayV2OutboxStateTag.REISSUED) {
            "reissue parent is not REISSUED"
        }
        require(parent.replacementCommandId == child.commandId) {
            "reissue reverse pointer mismatch"
        }
        require(parent.hasSameReissueIntent(child)) { "reissue intent or authority mismatch" }
    }
    entries.forEach { parent ->
        if (parent.state != RelayV2OutboxStateTag.REISSUED) return@forEach
        val parentKey = parent.reissueLineageKey()
        val replacementCommandId = parent.replacementCommandId
            ?: error("REISSUED entry lacks replacement pointer")
        val expectedChildKey = parent.reissueLineageKey(replacementCommandId)
        val childKey = parentToChild[parentKey]
            ?: error("REISSUED entry lacks replacement")
        require(childKey == expectedChildKey && childToParent[childKey] == parentKey) {
            "reissue forward pointer mismatch"
        }
        val child = entriesByKey[childKey]
            ?: error("REISSUED entry lacks replacement")
        require(parent.hasSameReissueIntent(child)) { "reissue intent or authority mismatch" }
    }

    // Each indexed link is followed once: a key moves from unseen to visiting to done only once.
    val colors = HashMap<RelayV2ReissueLineageKey, Int>(entries.size)
    entriesByKey.keys.forEach { start ->
        if (colors[start] == REISSUE_GRAPH_DONE) return@forEach
        val path = mutableListOf<RelayV2ReissueLineageKey>()
        var current: RelayV2ReissueLineageKey? = start
        while (current != null && colors[current] == null) {
            colors[current] = REISSUE_GRAPH_VISITING
            path += current
            current = parentToChild[current]
        }
        require(current == null || colors[current] != REISSUE_GRAPH_VISITING) {
            "reissue graph contains a cycle"
        }
        path.forEach { colors[it] = REISSUE_GRAPH_DONE }
    }
}

private const val REISSUE_GRAPH_VISITING = 1
private const val REISSUE_GRAPH_DONE = 2

private fun RelayV2ReissueTargetSnapshot.matchesFingerprint(
    entry: RelayV2OutboxEntry,
): Boolean {
    if (runCatching { requireTargetShape(entry.operation, sessionId) }.isFailure) return false
    return requestFingerprint == calculateRequestFingerprint(
        requestFingerprint.schemaVersion,
        entry.operation,
        dedupeWindowId,
        expectedHostEpoch,
        entry.hostId,
        scopeId,
        sessionId,
        entry.canonicalRequestArguments,
    )
}

private fun RelayV2TargetProvenance.isValidFor(entry: RelayV2OutboxEntry): Boolean {
    if (!initialTarget.matchesFingerprint(entry)) return false
    var historyIsValid = true
    var historyTail = initialTarget
    confirmedHistory.forEachIndexed { index, step ->
        if (step.confirmationOrdinal != (index + 1).toLong() ||
            step.sourceTarget != historyTail ||
            step.sourceTarget == step.confirmedTarget ||
            step.confirmedTarget.scopeId != step.sourceTarget.scopeId ||
            step.confirmedTarget.sessionId != step.sourceTarget.sessionId ||
            !step.sourceTarget.matchesFingerprint(entry) ||
            !step.confirmedTarget.matchesFingerprint(entry)
        ) {
            historyIsValid = false
        }
        historyTail = step.confirmedTarget
    }
    if (!historyIsValid) return false
    val currentTarget = entry.reissueTargetSnapshot()
    val pending = entry.targetRevalidation
    return if (pending == null) {
        currentTarget == historyTail
    } else {
        pending.proposedTarget == currentTarget &&
            pending.sourceConfirmedTarget == historyTail &&
            pending.confirmationOrdinal == (confirmedHistory.size + 1).toLong() &&
            currentTarget.matchesFingerprint(entry) &&
            currentTarget != historyTail &&
            currentTarget.scopeId == historyTail.scopeId &&
            currentTarget.sessionId == historyTail.sessionId
    }
}

private fun RelayV2OutboxEntry.hasSameReissueIntent(other: RelayV2OutboxEntry): Boolean {
    val lineageProof = other.reissueLineageProof ?: return false
    val lineageProofMatchesParent = lineageProof.parentProfileId == profileId &&
        lineageProof.parentPrincipalId == principalId &&
        lineageProof.parentHostId == hostId &&
        lineageProof.parentCommandId == commandId &&
        lineageProof.parentExpectedHostEpoch == expectedHostEpoch &&
        lineageProof.parentDedupeWindowId == dedupeWindowId &&
        lineageProof.parentScopeId == scopeId &&
        lineageProof.parentSessionId == sessionId &&
        lineageProof.parentRequestFingerprint == requestFingerprint
    val initialTarget = lineageProof.replacementInitialTarget
    val lineageProofMatchesReplacement =
        lineageProof.replacementProfileId == other.profileId &&
            lineageProof.replacementPrincipalId == other.principalId &&
            lineageProof.replacementHostId == other.hostId &&
            lineageProof.replacementCommandId == other.commandId &&
            initialTarget.expectedHostEpoch == expectedHostEpoch &&
            initialTarget.dedupeWindowId != dedupeWindowId &&
            initialTarget.scopeId == scopeId &&
            initialTarget.sessionId == sessionId &&
            initialTarget.matchesFingerprint(other) &&
            initialTarget == other.targetProvenance.initialTarget
    return profileId == other.profileId &&
        principalId == other.principalId &&
        hostId == other.hostId &&
        operation == other.operation &&
        canonicalRequestArguments == other.canonicalRequestArguments &&
        lineageProofMatchesParent &&
        lineageProofMatchesReplacement
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
    require(value.length <= maxUtf8Bytes) { "string exceeds the hard character bound" }
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
private val FINAL_COMMAND_FAILURE_CODES = setOf(
    "COMMAND_FAILED",
    "SCOPE_NOT_FOUND",
    "PROJECT_NOT_FOUND",
    "SESSION_NOT_FOUND",
    "PANE_NOT_FOUND",
)
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
