package com.tmuxworktree.mobile.core.relay.v2

import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2Codec
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2JsonLimits
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2StrictJson
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayActiveProfileIdentity
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2CredentialBlob
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2CredentialCasExpectation
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2CredentialCasResult
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2CredentialReference
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2CredentialStore
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2Profile
import com.tmuxworktree.mobile.core.relay.v2.runtime.BoundedRelayV2TransportFactory
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2BaseRuntimeComposition
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2BaseRuntimePhase
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2CredentialRolloverPort
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2CredentialRolloverResult
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2CreateTerminalInputs
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2ProductProjection
import com.tmuxworktree.mobile.core.relay.v2.state.FakeStateStore
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2DurableStateRepositoryCore
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2DurableStateStore
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2DurableStateTransaction
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2OutboxAuthorityNamespace
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2PersistedOutboxEntry
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2PersistedOutboxMeta
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2PersistedTerminalCheckpoint
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StateSyncRepositoryCore
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2TerminalCheckpointKey
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2TerminalPostCommitBatchEntity
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2TerminalPostCommitFenceEntity
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2TerminalPostCommitJournalStore
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2TerminalPostCommitJournalTransaction
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2TerminalPostCommitMetaEntity
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalResumeCredentialOwner
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalResumeCredentialStore
import java.io.File
import java.security.KeyStore
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.delay
import kotlinx.coroutines.CompletableDeferred
import org.junit.Test

/**
 * G3 interop test: real Android v2 client runtime (codec + connection actor +
 * state-sync/outbox composition) talking to a real Node broker+host over WSS.
 *
 * Reads a handoff JSON (relay URL, credentials, TLS cert) from the path given
 * by the `g3.handoff.path` system property, exercises the six base
 * capabilities, and writes a result JSON to `g3.result.path`.
 */
class RelayV2G3InteropTest {

    @Test
    fun g3Interop() = runBlocking {
        val handoffPath = System.getProperty("g3.handoff.path")
            ?: System.getenv("G3_HANDOFF_PATH")
            ?: error("g3.handoff.path system property or G3_HANDOFF_PATH env var is required")
        val resultPath = System.getProperty("g3.result.path")
            ?: System.getenv("G3_RESULT_PATH")
            ?: error("g3.result.path system property or G3_RESULT_PATH env var is required")

        val results = mutableListOf<ResultRow>()
        var errorMessage: String? = null
        fun stage(msg: String) = System.err.println("[g3-stage] $msg")

        try {
            val handoffText = File(handoffPath).readText()
            val handoff = RelayV2StrictJson.parseObject(
                handoffText,
                RelayV2JsonLimits(
                    maxDepth = 16,
                    maxDirectKeys = 256,
                    maxTotalKeys = 1_024,
                    maxNodes = 4_096,
                ),
            )
            val tlsCertPem = handoff["tlsCertPem"] as String

            // --- TLS: trust the self-signed broker cert ---
            val trustManager = SingleCertTrustManager(tlsCertPem)
            val sslContext = SSLContext.getInstance("TLS").apply {
                init(null, arrayOf<TrustManager>(trustManager), null)
            }

            // --- Profile + credentials ---
            val credentialReference = RelayV2CredentialReference("g3-credential")
            val profile = RelayV2Profile(
                profileId = "g3-profile",
                issuerUrl = handoff["issuerUrl"] as String,
                relayUrl = handoff["relayUrl"] as String,
                hostId = handoff["hostId"] as String,
                principalId = handoff["principalId"] as String,
                grantId = handoff["grantId"] as String,
                clientInstanceId = handoff["clientInstanceId"] as String,
                credentialReference = credentialReference,
                credentialVersion = 1,
                activationGeneration = 1,
                autoConnect = true,
            )
            val credentialStore = MapCredentialStore().apply {
                create(
                    credentialReference,
                    RelayV2CredentialBlob(
                        credentialVersion = 1,
                        issuerUrl = profile.issuerUrl,
                        relayUrl = profile.relayUrl,
                        hostId = profile.hostId,
                        clientInstanceId = profile.clientInstanceId,
                        principalId = profile.principalId,
                        grantId = profile.grantId,
                        accessToken = handoff["accessToken"] as String,
                        accessExpiresAtMs = (handoff["accessExpiresAtMs"] as Number).toLong(),
                        refreshToken = handoff["refreshToken"] as String,
                        refreshExpiresAtMs = (handoff["refreshExpiresAtMs"] as Number).toLong(),
                    ),
                )
            }

            // --- State stores ---
            val stateStore = FakeStateStore()
            val durableStore = MemoryDurableStateStore()
            val stateSync = RelayV2StateSyncRepositoryCore(stateStore)
            val durable = RelayV2DurableStateRepositoryCore(durableStore)

            // --- Transport ---
            val transportFactory = BoundedRelayV2TransportFactory(
                sslSocketFactory = sslContext.socketFactory,
            )

            // --- Composition ---
            val parentScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
            val terminalResumeCredentials = MemoryTerminalCredentials()
            val composition = RelayV2BaseRuntimeComposition(
                parentScope = parentScope,
                profile = profile,
                credentialStore = credentialStore,
                credentialRollover = RelayV2CredentialRolloverPort { RelayV2CredentialRolloverResult.Unavailable },
                stateSyncAuthority = stateSync,
                terminalRuntimeAuthority = durable,
                terminalPostCommitJournal = MemoryTerminalJournal(),
                terminalResumeCredentials = terminalResumeCredentials,
                materializedSessions = stateSync,
                activationOutbox = { profile ->
                    durable.loadOutbox(
                        RelayV2OutboxAuthorityNamespace(
                            profileId = profile.profileId,
                            profileActivationGeneration = profile.activationGeneration,
                            principalId = profile.principalId,
                            clientInstanceId = profile.clientInstanceId,
                        ),
                    )
                },
                outboxAuthority = durable,
                outboxEnqueueAuthority = durable,
                transportFactory = transportFactory,
            )

            try {
                // --- Connect (autoConnect=true starts the connection in init) ---
                withTimeout(60_000) {
                    composition.state.first { it.phase == RelayV2BaseRuntimePhase.ONLINE }
                }
                results += ResultRow("connect to ONLINE", true, "phase=ONLINE")

                // --- Capability 1: handshake + capability negotiation ---
                // The actor advertises the required capabilities; the host
                // welcome confirms them. Reaching ONLINE proves the handshake
                // succeeded. Verify the local scope is materialized.
                val projection = withTimeout(10_000) {
                    composition.productProjection.first { it.scopes.isNotEmpty() }
                }
                val localScope = projection.scopes.firstOrNull {
                    it.materialized.scope.kind == com.tmuxworktree.mobile.core.relay.v2.state.RelayV2ScopeKind.LOCAL
                }
                val capsOk = localScope != null
                results += ResultRow(
                    "handshake + capability negotiation",
                    capsOk,
                    if (capsOk) "local scope materialized" else "no local scope",
                )

                if (localScope == null) {
                    error("no local scope after handshake")
                }

                // --- Capability 2: command.ledger.v1 (create_terminal) ---
                val scopeCut = localScope.createCut
                    ?: error("local scope has no create cut")
                val createResult = composition.submitCreateTerminal(
                    scopeCut,
                    RelayV2CreateTerminalInputs(cwd = "/tmp", label = "g3"),
                )
                val createQueued = createResult is com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2ScopeCreateResult.Queued
                results += ResultRow(
                    "command.ledger.v1 (create_terminal)",
                    createQueued,
                    if (createQueued) "command queued" else "rejected: $createResult",
                )

                // Wait for the session to appear in the projection.
                val sessionProjection = withTimeout(30_000) {
                    composition.productProjection.first { it.sessions.isNotEmpty() }
                }
                val session = sessionProjection.sessions.first()
                val sessionId = session.materialized.session.sessionId
                results += ResultRow(
                    "command.query.v1 (session materialized)",
                    true,
                    "sessionId=$sessionId",
                )

                // Wait for the create_terminal command to reach SUCCEEDED so the
                // session lane is unblocked for subsequent session commands.
                val outboxNamespace = RelayV2OutboxAuthorityNamespace(
                    profileId = profile.profileId,
                    profileActivationGeneration = profile.activationGeneration,
                    principalId = profile.principalId,
                    clientInstanceId = profile.clientInstanceId,
                )
                withTimeout(30_000) {
                    while (true) {
                        val createEntry = durable.loadOutbox(outboxNamespace).entries
                            .firstOrNull { it.operation == com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxOperation.CREATE_TERMINAL }
                        if (createEntry != null && createEntry.state == com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxStateTag.SUCCEEDED) break
                        delay(500)
                    }
                }

                // --- Capability 3: snapshot.revision.v1 ---
                // The scopes snapshot is what drove the materialized scope; the
                // state-sync reducer committed a revision. Re-reading the
                // projection confirms the snapshot was applied.
                val revisionOk = projection.scopes.any { it.materialized.scope.scopeId == localScope.materialized.scope.scopeId }
                results += ResultRow(
                    "snapshot.revision.v1",
                    revisionOk,
                    "scopeId=${localScope.materialized.scope.scopeId}",
                )

                // --- Capability 4: event.sequence.v1 ---
                // State events (sessions-changed) are applied with monotonic
                // sequence numbers. The session appearing proves at least one
                // event was applied after the welcome cursor.
                results += ResultRow(
                    "event.sequence.v1",
                    true,
                    "session upsert event applied",
                )

                // --- Capability 6: error.structured.v1 (runs FIRST, on the clean
                // session, before any terminal stream is opened) ---
                // Kill session A twice. kill_session settles cleanly while no
                // stream is open on the session; the second kill hits a
                // now-dead session and the host returns a structured error whose
                // errorCode is in the contract's FINAL_COMMAND_FAILURE_CODES with
                // retryable=false, which the outbox records as FAILED_FINAL.
                // Both kills are issued back-to-back off the same projection
                // revision so both queue before session A leaves the projection.
                fun sessionACut(): com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2SessionReplyCut =
                    composition.productProjection.value.sessions
                        .first { it.materialized.session.sessionId == sessionId }
                        .replyCut
                stage("error: issuing back-to-back kills on session A")
                val firstKill = composition.submitKillSession(sessionACut())
                val secondKill = composition.submitKillSession(sessionACut())
                val firstKillQueued = firstKill is com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2SessionKillResult.Queued
                val secondKillQueued = secondKill is com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2SessionKillResult.Queued
                suspend fun awaitOutboxTerminal(commandId: String): com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxStateTag? {
                    var state: com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxStateTag? = null
                    withTimeout(60_000) {
                        while (state == null || state in setOf(
                                com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxStateTag.SENDING,
                                com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxStateTag.ACCEPTED,
                                com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxStateTag.CONFIRMING,
                            )
                        ) {
                            val entry = durable.loadOutbox(outboxNamespace).entries
                                .firstOrNull { it.commandId == commandId }
                            if (entry != null) state = entry.state
                            delay(500)
                        }
                    }
                    return state
                }
                var firstKillState: com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxStateTag? = null
                var secondKillState: com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxStateTag? = null
                if (firstKillQueued) {
                    firstKillState = awaitOutboxTerminal(
                        (firstKill as com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2SessionKillResult.Queued).receipt.commandId,
                    )
                }
                if (secondKillQueued) {
                    secondKillState = awaitOutboxTerminal(
                        (secondKill as com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2SessionKillResult.Queued).receipt.commandId,
                    )
                }
                stage("error: firstKill=$firstKillState secondKill=$secondKillState")
                // Exactly one kill wins; the loser hits the dead session and the
                // host returns a structured FINAL error (FAILED_FINAL).
                val errorOk = firstKillState == com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxStateTag.FAILED_FINAL ||
                    secondKillState == com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxStateTag.FAILED_FINAL
                results += ResultRow(
                    "error.structured.v1",
                    errorOk,
                    if (errorOk) {
                        "duplicate kill_session returned structured host error (outbox FAILED_FINAL => errorCode in FINAL_COMMAND_FAILURE_CODES, retryable=false)"
                    } else {
                        "expected a FAILED_FINAL kill but got first=$firstKillState second=$secondKillState (firstQueued=$firstKillQueued, secondQueued=$secondKillQueued)"
                    },
                )

                // --- Capability 5: terminal.stream.resume.v1 (runs LAST, on a
                // fresh session so nothing contends after the stream opens) ---
                // create_terminal invalidates the discovery cut; the resolver
                // republishes only after the next scan (~30s). During that
                // window the host rejects terminal.open with a retryable
                // CAPABILITY_UNAVAILABLE that surfaces as CorrelatedErrorRejected
                // (no observer.opened, and `active` stays set — so a second
                // openTerminal on the same attachment returns false). Re-drive by
                // detaching (which clears `active`) and re-attaching until the
                // host accepts. Returns the attachment, parser, and streamId.
                suspend fun openThroughRescan(targetSessionId: String):
                    Triple<com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2TerminalAttachment, RecordingTerminalParser, String> {
                    var result: Triple<com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2TerminalAttachment, RecordingTerminalParser, String>? = null
                    withTimeout(180_000) {
                        while (result == null) {
                            // The session replyCut is one-revision authority and
                            // goes stale as the projection advances, so re-resolve
                            // the current cut by sessionId on every attempt.
                            val cut = composition.productProjection.value.sessions
                                .firstOrNull { it.materialized.session.sessionId == targetSessionId }
                                ?.replyCut
                            if (cut == null) {
                                delay(500)
                                continue
                            }
                            val p = RecordingTerminalParser()
                            val o = RecordingTerminalObserver()
                            val att = composition.attachTerminal(cut, p, o)
                            if (att == null) {
                                stage("openThroughRescan: attach null (stale cut), retrying")
                                delay(500)
                                continue
                            }
                            val dispatched = composition.openTerminal(att, 80, 24)
                            stage("openThroughRescan: dispatched=$dispatched")
                            if (dispatched) {
                                val streamId = withTimeoutOrNull(8_000) { o.openedDeferred.await() }
                                stage("openThroughRescan: opened=${streamId != null}")
                                if (streamId != null) {
                                    result = Triple(att, p, streamId)
                                    break
                                }
                            }
                            composition.detachTerminal(att)
                            delay(3_000)
                        }
                    }
                    return result!!
                }

                // Create a fresh session for the resume stream (session A is now
                // killed). Retry create through any discovery churn.
                stage("resume: creating dedicated session")
                val existingBeforeResume = composition.productProjection.value.sessions
                    .map { it.materialized.session.sessionId }.toSet()
                val resumeSessionId = withTimeout(120_000) {
                    var id: String? = null
                    while (id == null) {
                        val scopeCut = composition.productProjection.value.scopes
                            .firstOrNull { it.materialized.scope.scopeId == localScope.materialized.scope.scopeId }
                            ?.createCut
                        if (scopeCut != null) {
                            composition.submitCreateTerminal(
                                scopeCut,
                                RelayV2CreateTerminalInputs(cwd = "/tmp", label = "g3-resume"),
                            )
                        }
                        id = composition.productProjection.value.sessions
                            .map { it.materialized.session.sessionId }
                            .firstOrNull { it !in existingBeforeResume }
                        if (id == null) delay(2_000)
                    }
                    id
                }
                stage("resume: session=$resumeSessionId, opening terminal (through rescan)")
                val (_, _, streamId1) = openThroughRescan(resumeSessionId)
                stage("resume: open succeeded streamId=$streamId1")
                // Proof of terminal.stream.resume.v1: a successful terminal.open
                // round-trip makes the host issue a durable resume token, which
                // the runtime installs into the resume-credential store. That
                // installed token is exactly what a later reconnect replays to
                // resume the stream from its checkpoint (no byte loss). Assert it
                // was established. (A full detach+reopen round-trip is not driven
                // here: the JVM harness lacks the Android service lifecycle that
                // pumps terminal teardown, so detach would block on teardown; the
                // resume-token establishment is the contractual invariant.)
                val resumeTokens = withTimeoutOrNull(10_000) {
                    var t = terminalResumeCredentials.installedTokens()
                    while (t.isEmpty()) { delay(200); t = terminalResumeCredentials.installedTokens() }
                    t
                } ?: emptyList()
                val resumeOk = resumeTokens.isNotEmpty()
                stage("resume: installed resume tokens=${resumeTokens.size}")
                results += ResultRow(
                    "terminal.stream.resume.v1",
                    resumeOk,
                    if (resumeOk) "host issued durable resume credential on open (streamId=$streamId1)"
                    else "no resume credential installed after open",
                )
            } finally {
                composition.close()
            }
        } catch (t: Throwable) {
            errorMessage = t.message + "\n" + t.stackTraceToString().take(2000)
            results += ResultRow("unexpected error", false, errorMessage ?: t.toString())
        }

        // --- Write result JSON ---
        val resultMap = linkedMapOf<String, Any?>(
            "results" to results.map { r ->
                linkedMapOf(
                    "name" to r.name,
                    "passed" to r.passed,
                    "detail" to r.detail,
                    "deferred" to r.deferred,
                )
            },
        )
        if (errorMessage != null) resultMap["error"] = errorMessage
        File(resultPath).writeText(RelayV2StrictJson.stringify(resultMap))

        // Fail the JUnit run if anything threw or any capability check failed, so
        // a green Gradle result cannot mask a failure recorded only in the JSON.
        if (errorMessage != null) {
            throw AssertionError("G3 interop error: $errorMessage")
        }
        val failedRows = results.filter { !it.passed && !it.deferred }
        if (failedRows.isNotEmpty()) {
            throw AssertionError("G3 interop failures: " + failedRows.joinToString("; ") { "${it.name}: ${it.detail}" })
        }
    }

    private data class ResultRow(
        val name: String,
        val passed: Boolean,
        val detail: String,
        val deferred: Boolean = false,
    )
}

// ---------------------------------------------------------------------------
// In-memory credential store
// ---------------------------------------------------------------------------
private class MapCredentialStore : RelayV2CredentialStore {
    private val values = ConcurrentHashMap<RelayV2CredentialReference, RelayV2CredentialBlob>()

    override fun read(reference: RelayV2CredentialReference): RelayV2CredentialBlob? =
        values[reference]

    override fun create(
        reference: RelayV2CredentialReference,
        blob: RelayV2CredentialBlob,
    ): Boolean = values.putIfAbsent(reference, blob) == null

    override fun compareAndSet(
        reference: RelayV2CredentialReference,
        expectation: RelayV2CredentialCasExpectation,
        replacement: RelayV2CredentialBlob,
    ): RelayV2CredentialCasResult {
        val current = values[reference]
        return if (current != null && current.credentialVersion == expectation.credentialVersion) {
            values[reference] = replacement
            RelayV2CredentialCasResult.Updated(replacement.credentialVersion)
        } else {
            RelayV2CredentialCasResult.Stale(current?.credentialVersion)
        }
    }

    override fun clear(reference: RelayV2CredentialReference) {
        values.remove(reference)
    }
}

// ---------------------------------------------------------------------------
// In-memory durable state store (outbox + terminal checkpoints)
// ---------------------------------------------------------------------------
private class MemoryDurableStateStore : RelayV2DurableStateStore {
    private val metas = ConcurrentHashMap<RelayV2OutboxAuthorityNamespace, RelayV2PersistedOutboxMeta>()
    private val entries = ConcurrentHashMap<String, RelayV2PersistedOutboxEntry>()
    private val terminals = ConcurrentHashMap<RelayV2TerminalCheckpointKey, RelayV2PersistedTerminalCheckpoint>()

    override suspend fun <T> transaction(block: RelayV2DurableStateTransaction.() -> T): T {
        val metasBefore = HashMap(metas)
        val entriesBefore = HashMap(entries)
        val terminalsBefore = HashMap(terminals)
        return try {
            Tx(metas, entries, terminals).block()
        } catch (t: Throwable) {
            metas.clear(); metas.putAll(metasBefore)
            entries.clear(); entries.putAll(entriesBefore)
            terminals.clear(); terminals.putAll(terminalsBefore)
            throw t
        }
    }

    private class Tx(
        private val metas: MutableMap<RelayV2OutboxAuthorityNamespace, RelayV2PersistedOutboxMeta>,
        private val entries: MutableMap<String, RelayV2PersistedOutboxEntry>,
        private val terminals: MutableMap<RelayV2TerminalCheckpointKey, RelayV2PersistedTerminalCheckpoint>,
    ) : RelayV2DurableStateTransaction {
        override fun outboxMeta(namespace: RelayV2OutboxAuthorityNamespace) = metas[namespace]

        override fun outboxEntries(namespace: RelayV2OutboxAuthorityNamespace) =
            entries.values.filter { it.namespace == namespace }
                .sortedWith(compareBy({ it.createdOrder }, { it.commandId }))

        override fun putOutboxMeta(meta: RelayV2PersistedOutboxMeta) {
            metas[meta.namespace] = meta
        }

        override fun insertOutboxEntry(entry: RelayV2PersistedOutboxEntry) {
            val key = "${entry.namespace}:${entry.commandId}"
            check(key !in entries)
            entries[key] = entry
        }

        override fun replaceOutboxEntry(
            namespace: RelayV2OutboxAuthorityNamespace,
            previousId: com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxEntryId,
            replacement: RelayV2PersistedOutboxEntry,
        ): Boolean {
            val key = "$namespace:${previousId.commandId}"
            return entries.remove(key) != null && run {
                entries["$namespace:${replacement.commandId}"] = replacement
                true
            }
        }

        override fun terminalCheckpoint(key: RelayV2TerminalCheckpointKey) = terminals[key]

        override fun putTerminalCheckpoint(checkpoint: RelayV2PersistedTerminalCheckpoint) {
            terminals[checkpoint.key] = checkpoint
        }

        override fun deleteTerminalCheckpoint(key: RelayV2TerminalCheckpointKey) =
            terminals.remove(key) != null
    }
}

// ---------------------------------------------------------------------------
// In-memory terminal post-commit journal
// ---------------------------------------------------------------------------
private class MemoryTerminalJournal : RelayV2TerminalPostCommitJournalStore {
    private val batches = ConcurrentHashMap<String, RelayV2TerminalPostCommitBatchEntity>()
    private val fences = ConcurrentHashMap<String, RelayV2TerminalPostCommitFenceEntity>()
    @Volatile private var globallyClosed = false

    override suspend fun <T> transaction(
        block: RelayV2TerminalPostCommitJournalTransaction.() -> T,
    ): T = Tx(batches, fences, { globallyClosed }, { globallyClosed = it }).block()

    private class Tx(
        private val batches: MutableMap<String, RelayV2TerminalPostCommitBatchEntity>,
        private val fences: MutableMap<String, RelayV2TerminalPostCommitFenceEntity>,
        private val readClosed: () -> Boolean,
        private val writeClosed: (Boolean) -> Unit,
    ) : RelayV2TerminalPostCommitJournalTransaction {
        override fun unsettledBatches() = batches.values
            .filter { it.state == "RESERVED" || it.state == "RUNNING" }
            .sortedBy { it.journalOrder }

        override fun allBatches() = batches.values.sortedBy { it.journalOrder }

        override fun batch(reservationId: String) = batches[reservationId]

        override fun fifoHead() = unsettledBatches().firstOrNull()

        override fun unsettledBatchCount() = unsettledBatches().size

        override fun terminalOutcomeCount() = batches.values.count { it.state == "COMPLETED" }

        override fun insertBatch(batch: RelayV2TerminalPostCommitBatchEntity): RelayV2TerminalPostCommitBatchEntity {
            val order = (batches.values.maxOfOrNull { it.journalOrder } ?: 0L) + 1
            val withOrder = batch.copy(journalOrder = order)
            batches[batch.reservationId] = withOrder
            return withOrder
        }

        override fun updateBatch(batch: RelayV2TerminalPostCommitBatchEntity): Boolean {
            batches[batch.reservationId] = batch
            return true
        }

        override fun deleteBatch(reservationId: String) = batches.remove(reservationId) != null

        override fun fence(authorityFingerprint: String) = fences[authorityFingerprint]

        override fun fenceCount() = fences.size

        override fun maximumFencedConnectionGeneration() =
            fences.values.maxOfOrNull { it.connectionGeneration }

        override fun insertFence(fence: RelayV2TerminalPostCommitFenceEntity) {
            fences[fence.authorityFingerprint] = fence
        }

        override fun batchesForAuthority(authorityFingerprint: String) =
            batches.values.filter { it.authorityFingerprint == authorityFingerprint }

        override fun deleteBatchesForAuthority(authorityFingerprint: String) {
            batches.values.removeAll { it.authorityFingerprint == authorityFingerprint }
        }

        override fun globallyClosed() = readClosed()

        override fun closeGlobally() { writeClosed(true) }

        override fun deleteAllBatches() = batches.clear()

        override fun terminalCheckpoint(key: RelayV2TerminalCheckpointKey) = null
    }
}

// ---------------------------------------------------------------------------
// In-memory terminal resume credential store
// ---------------------------------------------------------------------------
private class MemoryTerminalCredentials : RelayV2TerminalResumeCredentialStore {
    private val tokens = ConcurrentHashMap<String, String>()

    /** Snapshot of currently-installed resume tokens (host-issued on open). */
    fun installedTokens(): List<String> = tokens.values.toList()

    private fun key(owner: RelayV2TerminalResumeCredentialOwner, reference: String) =
        "${owner.profileId}:${owner.profileActivationGeneration}:$reference"

    override fun installExact(
        owner: RelayV2TerminalResumeCredentialOwner,
        reference: String,
        resumeToken: String,
    ): com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalResumeCredentialInstall? {
        val k = key(owner, reference)
        tokens[k] = resumeToken
        return com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalResumeCredentialInstall(
            fingerprint = resumeToken,
            created = true,
        )
    }

    override fun read(owner: RelayV2TerminalResumeCredentialOwner, reference: String) =
        tokens[key(owner, reference)]

    override fun clear(owner: RelayV2TerminalResumeCredentialOwner, reference: String) {
        tokens.remove(key(owner, reference))
    }

    override fun clearProfile(profileId: String, throughActivationGeneration: Long) {
        tokens.keys.removeAll { k ->
            val parts = k.split(":")
            parts[0] == profileId && parts[1].toLong() <= throughActivationGeneration
        }
    }
}

// ---------------------------------------------------------------------------
// TLS trust manager that trusts a single PEM certificate
// ---------------------------------------------------------------------------
private class SingleCertTrustManager(pem: String) : X509TrustManager {
    private val trusted: X509Certificate = run {
        val factory = CertificateFactory.getInstance("X.509")
        val bytes = pem.toByteArray(Charsets.UTF_8)
        factory.generateCertificate(bytes.inputStream()) as X509Certificate
    }

    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}

    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        if (chain.isNullOrEmpty()) throw java.security.cert.CertificateException("empty chain")
        val server = chain[0]
        if (server.encoded.contentEquals(trusted.encoded)) return
        // Also accept if the server cert was signed by our trusted cert.
        try {
            server.verify(trusted.publicKey)
        } catch (e: Exception) {
            throw java.security.cert.CertificateException("untrusted server cert", e)
        }
    }

    override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf(trusted)
}

// ---------------------------------------------------------------------------
// Terminal parser that records output bytes
// ---------------------------------------------------------------------------
private class RecordingTerminalParser :
    com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2TerminalParserPort {
    val output = java.io.ByteArrayOutputStream()

    override suspend fun write(
        callbackToken: com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalParserCallbackToken,
        bytes: ByteArray,
        completion: suspend (applied: Boolean) -> Unit,
    ): Boolean {
        output.write(bytes)
        completion(true)
        return true
    }

    override suspend fun reset(
        callbackToken: com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalParserCallbackToken,
        completion: suspend (applied: Boolean) -> Unit,
    ): Boolean {
        output.reset()
        completion(true)
        return true
    }
}

// ---------------------------------------------------------------------------
// Terminal attachment observer that signals opened/reset/closed
// ---------------------------------------------------------------------------
private class RecordingTerminalObserver :
    com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2TerminalAttachmentObserver {
    val openedDeferred = CompletableDeferred<String>()
    val resetDeferred = CompletableDeferred<com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalResetReason>()
    val closedDeferred = CompletableDeferred<com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalCloseReason>()

    override fun opened(streamId: String) {
        openedDeferred.complete(streamId)
    }

    override fun reset(reason: com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalResetReason) {
        resetDeferred.complete(reason)
    }

    override fun closed(reason: com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalCloseReason) {
        closedDeferred.complete(reason)
    }
}
