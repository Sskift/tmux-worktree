package com.tmuxworktree.mobile.core.relay.v2.runtime

import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2Codec
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2DecodedMessage
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2StrictJson
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2WebSocketChannel
import com.tmuxworktree.mobile.core.relay.v2.outbox.*
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayActiveProfileIdentity
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayProfileDialect
import com.tmuxworktree.mobile.core.relay.v2.state.*
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RelayV2OutboxDispatchAdapterTest {
    @Test
    fun `real durable retry commits exact execute wire for every operation`() = runBlocking {
        val cases = listOf(
            CommandSpec(
                "worktree",
                null,
                RelayV2OutboxArguments.createWorktree(
                    project = "demo",
                    aiCommand = "codex",
                ),
            ),
            CommandSpec(
                "terminal",
                null,
                RelayV2OutboxArguments.createTerminal("/repo/demo", "demo shell"),
            ),
            CommandSpec(
                "message",
                "session-message",
                RelayV2OutboxArguments.sendAgentMessage(7, SECRET_MESSAGE, true),
            ),
            CommandSpec(
                "kill",
                "session-kill",
                RelayV2OutboxArguments.killSession(),
            ),
        )

        cases.forEach { spec ->
            val fixture = Fixture(ArrayDeque(listOf("retry-${spec.commandId}")))
            val command = fixture.seed(spec)

            val committed = fixture.handle(command, StatusMode.RETRY)

            val retry = committed.commit.effects.single() as RelayV2OutboxEffect.ExecuteCommand
            assertEquals("retry-${spec.commandId}", retry.attempt.requestId)
            assertEquals(RelayV2OutboxAttemptKind.EXECUTE, retry.attempt.kind)
            assertEquals(0L, retry.retryAfterMs)
            val durable = fixture.repository.loadOutbox(fixture.namespace)
                .entry(spec.commandId)
            assertEquals(RelayV2OutboxStateTag.SENDING, durable.state)
            assertEquals(retry.attempt, durable.attempts.last())

            val capability = committed.singleCapability()
            assertFalse(capability.toString().contains(SECRET_MESSAGE))
            val send = RecordingSendPort(fixture.authority)
            val outcome = fixture.dispatcher(send).dispatch(capability)

            assertTrue(outcome is RelayV2OutboxDispatchOutcome.Submitted)
            val frame = decode(send.frames.single())
            assertEquals("command.execute", frame["type"])
            assertEquals(retry.attempt.requestId, frame["requestId"])
            assertEquals(spec.commandId, frame["commandId"])
            assertEquals(fixture.authority.hostId, frame["hostId"])
            assertEquals(fixture.authority.hostEpoch, frame["expectedHostEpoch"])
            assertEquals(durable.scopeId, frame["scopeId"])
            assertEquals(spec.sessionId, frame["sessionId"])
            val payload = frame.objectValue("payload")
            assertEquals(durable.dedupeWindowId, payload["dedupeWindowId"])
            assertEquals(durable.operation.wireValue, payload["operation"])
            assertEquals(
                durable.canonicalRequestArguments.canonicalJson,
                RelayV2StrictJson.stringify(payload.objectValue("arguments")),
            )
            assertFalse(outcome.toString().contains(SECRET_MESSAGE))
        }
    }

    @Test
    fun `seal snapshots after durable transaction while apply lease is still held`() =
        runBlocking {
            lateinit var fixture: Fixture
            val observations = mutableListOf<Pair<Boolean, Boolean>>()
            val frameEncoder = RelayV2OutboxDispatchFrameEncoder { frame ->
                observations += fixture.lease.active to fixture.store.inTransaction
                strictEncode(frame)
            }
            fixture = Fixture(
                ids = ArrayDeque(listOf("retry-detached")),
                frameEncoder = frameEncoder,
            )
            val command = fixture.seed(CommandSpec("detached"))

            val committed = fixture.handle(command, StatusMode.RETRY)
            val capability = committed.singleCapability()

            assertEquals(listOf(true to false), observations)
            @Suppress("UNCHECKED_CAST")
            (committed.commit.effects as MutableList<RelayV2OutboxEffect>).clear()
            assertTrue(committed.commit.effects.isEmpty())
            val send = RecordingSendPort(fixture.authority)
            assertTrue(
                fixture.dispatcher(send).dispatch(capability) is
                    RelayV2OutboxDispatchOutcome.Submitted,
            )
            assertEquals("retry-detached", decode(send.frames.single())["requestId"])
        }

    @Test
    fun `encoding failure preserves durable recovery and returns typed rejection`() = runBlocking {
        val fixture = Fixture(
            ids = ArrayDeque(listOf("retry-encoding-failure")),
            frameEncoder = RelayV2OutboxDispatchFrameEncoder {
                throw IllegalStateException("injected codec failure")
            },
        )
        val command = fixture.seed(CommandSpec("encoding-failure"))

        val committed = fixture.handle(command, StatusMode.RETRY)

        assertEquals(
            RelayV2OutboxDispatchIssuance.Rejected(
                RelayV2OutboxDispatchIssueFailure.ENCODING_REJECTED,
            ),
            committed.dispatchIssuance,
        )
        val retry = committed.commit.effects.single() as RelayV2OutboxEffect.ExecuteCommand
        assertEquals("retry-encoding-failure", retry.attempt.requestId)
        val durable = fixture.repository.loadOutbox(fixture.namespace)
            .entry(command.pending.commandId)
        assertEquals(RelayV2OutboxStateTag.SENDING, durable.state)
        assertEquals(retry.attempt, durable.attempts.last())
    }

    @Test
    fun `zero and unsupported only durable effects report no dispatch`() = runBlocking {
        val zero = Fixture()
        val accepted = zero.seed(CommandSpec("accepted"))
        val zeroCommitted = zero.handle(accepted, StatusMode.ACCEPTED)
        assertTrue(zeroCommitted.commit.effects.isEmpty())
        assertEquals(
            RelayV2OutboxDispatchIssuance.NoDispatch,
            zeroCommitted.dispatchIssuance,
        )

        val unsupported = Fixture(ArrayDeque(listOf("replacement-command")))
        val expired = unsupported.seed(CommandSpec("expired-window"))
        val unsupportedCommitted = unsupported.handle(expired, StatusMode.REISSUE)
        val reissue = unsupportedCommitted.commit.effects.single()
        assertTrue(reissue is RelayV2OutboxEffect.ReissueCreated)
        assertEquals(
            RelayV2OutboxDispatchIssuance.NoDispatch,
            unsupportedCommitted.dispatchIssuance,
        )
        val durable = unsupported.repository.loadOutbox(unsupported.namespace)
        assertEquals(
            RelayV2OutboxStateTag.REISSUED,
            durable.entry(expired.pending.commandId).state,
        )
        assertEquals(
            RelayV2OutboxStateTag.QUEUED,
            durable.entry("replacement-command").state,
        )
    }

    @Test
    fun `mixed durable batch signs execute only and preserves reissue effect`() = runBlocking {
        val fixture = Fixture(ArrayDeque(listOf("retry-mixed", "replacement-mixed")))
        val commands = fixture.seedBatch(
            listOf(
                CommandSpec("mixed-retry"),
                CommandSpec("mixed-reissue"),
            ),
        )

        val committed = fixture.handle(
            commands,
            listOf(StatusMode.RETRY, StatusMode.REISSUE),
        )

        val execute = committed.commit.effects.filterIsInstance<RelayV2OutboxEffect.ExecuteCommand>()
            .single()
        val reissue = committed.commit.effects.filterIsInstance<RelayV2OutboxEffect.ReissueCreated>()
            .single()
        assertEquals("mixed-retry", execute.command.entryId.commandId)
        assertEquals("retry-mixed", execute.attempt.requestId)
        assertEquals("mixed-reissue", reissue.originalEntryId.commandId)
        assertEquals("replacement-mixed", reissue.replacementEntryId.commandId)
        assertEquals(2, committed.commit.effects.size)

        val issued = committed.dispatchIssuance as RelayV2OutboxDispatchIssuance.Issued
        assertEquals(1, issued.capabilities.size)
        assertEquals("mixed-retry", issued.capabilities.single().identity.commandId)
        assertEquals("retry-mixed", issued.capabilities.single().identity.requestId)

        val durable = fixture.repository.loadOutbox(fixture.namespace)
        assertEquals(RelayV2OutboxStateTag.SENDING, durable.entry("mixed-retry").state)
        assertEquals("retry-mixed", durable.entry("mixed-retry").attempts.last().requestId)
        assertEquals(RelayV2OutboxStateTag.REISSUED, durable.entry("mixed-reissue").state)
        assertEquals(RelayV2OutboxStateTag.QUEUED, durable.entry("replacement-mixed").state)
    }

    @Test
    fun `profile switch socket advance and client rebind are stale before transport`() =
        runBlocking {
            val switches = listOf(
                "client" to { authority: RelayV2RepositoryEffectAuthority ->
                    authority.copy(clientInstanceId = "other-install")
                },
                "profile" to { authority: RelayV2RepositoryEffectAuthority ->
                    authority.copy(
                        generation = authority.generation.copy(
                            profileGeneration = authority.generation.profileGeneration + 1,
                        ),
                        profileActivationGeneration =
                            authority.profileActivationGeneration + 1,
                    )
                },
                "socket" to { authority: RelayV2RepositoryEffectAuthority ->
                    authority.copy(
                        generation = authority.generation.copy(
                            connectionGeneration =
                                authority.generation.connectionGeneration + 1,
                        ),
                    )
                },
            )
            switches.forEach { (name, switch) ->
                val fixture = Fixture(ArrayDeque(listOf("retry-$name")))
                val capability = fixture.handle(
                    fixture.seed(CommandSpec(name)),
                    StatusMode.RETRY,
                ).singleCapability()
                val send = RecordingSendPort(switch(fixture.authority))
                val dispatcher = fixture.dispatcher(send)

                assertTrue(
                    dispatcher.dispatch(capability) is RelayV2OutboxDispatchOutcome.Stale,
                )
                assertTrue(
                    dispatcher.dispatch(capability) is
                        RelayV2OutboxDispatchOutcome.AlreadyDispatched,
                )
                assertEquals(1, send.admissionCalls)
                assertEquals(0, send.transportCalls)
            }
        }

    @Test
    fun `false throw and wrong pair are typed and cannot replay or steal`() = runBlocking {
        suspend fun issued(name: String): Pair<Fixture, RelayV2OutboxDispatchCapability> {
            val fixture = Fixture(ArrayDeque(listOf("retry-$name")))
            val command = fixture.seed(CommandSpec(name))
            return fixture to fixture.handle(command, StatusMode.RETRY).singleCapability()
        }

        val (notSentFixture, notSentCapability) = issued("not-sent")
        val notSentPort = RecordingSendPort(
            notSentFixture.authority,
            result = RelayV2OutboxExactGenerationSendResult.NotSent,
        )
        val notSentDispatcher = notSentFixture.dispatcher(notSentPort)
        val notSent = notSentDispatcher.dispatch(notSentCapability)
            as RelayV2OutboxDispatchOutcome.ConfirmingRequired
        assertEquals(RelayV2OutboxDispatchUncertainty.SEND_RETURNED_FALSE, notSent.uncertainty)
        assertTrue(
            notSentDispatcher.dispatch(notSentCapability) is
                RelayV2OutboxDispatchOutcome.AlreadyDispatched,
        )
        assertEquals(1, notSentPort.transportCalls)

        val (throwFixture, throwCapability) = issued("throw")
        val throwPort = RecordingSendPort(
            throwFixture.authority,
            failure = IllegalStateException(SECRET_MESSAGE),
        )
        val throwDispatcher = throwFixture.dispatcher(throwPort)
        val thrown = throwDispatcher.dispatch(throwCapability)
            as RelayV2OutboxDispatchOutcome.ConfirmingRequired
        assertEquals(RelayV2OutboxDispatchUncertainty.SEND_THROWN, thrown.uncertainty)
        assertFalse(thrown.toString().contains(SECRET_MESSAGE))
        assertTrue(
            throwDispatcher.dispatch(throwCapability) is
                RelayV2OutboxDispatchOutcome.AlreadyDispatched,
        )

        val (owner, foreignCapability) = issued("foreign")
        val foreign = Fixture()
        val foreignPort = RecordingSendPort(owner.authority)
        assertTrue(
            foreign.dispatcher(foreignPort).dispatch(foreignCapability) is
                RelayV2OutboxDispatchOutcome.CapabilityRejected,
        )
        assertEquals(0, foreignPort.admissionCalls)
        val ownerPort = RecordingSendPort(owner.authority)
        assertTrue(
            owner.dispatcher(ownerPort).dispatch(foreignCapability) is
                RelayV2OutboxDispatchOutcome.Submitted,
        )
    }

    @Test
    fun `two thread capability dispatch admits one transport and one replay`() = runBlocking {
        val fixture = Fixture(ArrayDeque(listOf("retry-concurrent")))
        val capability = fixture.handle(
            fixture.seed(CommandSpec("concurrent")),
            StatusMode.RETRY,
        ).singleCapability()
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val send = RecordingSendPort(fixture.authority) {
            entered.countDown()
            assertTrue(release.await(5, TimeUnit.SECONDS))
        }
        val dispatcher = fixture.dispatcher(send)
        val pool = Executors.newFixedThreadPool(2)
        try {
            val first = pool.submit<RelayV2OutboxDispatchOutcome> {
                dispatcher.dispatch(capability)
            }
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            val second = pool.submit<RelayV2OutboxDispatchOutcome> {
                dispatcher.dispatch(capability)
            }

            assertTrue(
                second.get(5, TimeUnit.SECONDS) is
                    RelayV2OutboxDispatchOutcome.AlreadyDispatched,
            )
            release.countDown()
            assertTrue(first.get(5, TimeUnit.SECONDS) is RelayV2OutboxDispatchOutcome.Submitted)
            assertEquals(1, send.transportCalls)
        } finally {
            release.countDown()
            pool.shutdownNow()
        }
    }

    @Test
    fun `direct recovery adapter remains default off`() = runBlocking {
        val fixture = Fixture(ArrayDeque(listOf("retry-disabled")))
        val command = fixture.seed(CommandSpec("disabled"))
        val direct = RelayV2OutboxRecoveryAdapter(
            fixture.lease,
            fixture.repository,
            newId = { "retry-disabled" },
            clock = { 99L },
        )

        val result = direct.handle(fixture.effect(command, StatusMode.RETRY))
            as RelayV2OutboxRecoveryApplyResult.Committed

        assertEquals(RelayV2OutboxDispatchIssuance.Disabled, result.dispatchIssuance)
        assertTrue(result.commit.effects.single() is RelayV2OutboxEffect.ExecuteCommand)
    }

    private class Fixture(
        private val ids: ArrayDeque<String> = ArrayDeque(),
        frameEncoder: RelayV2OutboxDispatchFrameEncoder? = null,
    ) {
        val context = context()
        val authority = context.repositoryEffectAuthority(GENERATION)
        val namespace = RelayV2OutboxAuthorityNamespace(
            authority.profileId,
            authority.profileActivationGeneration,
            authority.principalId,
            authority.clientInstanceId,
        )
        val store = MemoryStore()
        val repository = RelayV2DurableStateRepositoryCore(store)
        val lease = TestApplyLease()
        private var fallbackId = 0
        val composition = if (frameEncoder == null) {
            RelayV2OutboxDispatchAuthority.recoveryComposition(
                lease,
                repository,
                newId = ::nextId,
                clock = { 99L },
            )
        } else {
            RelayV2OutboxDispatchAuthority.recoveryComposition(
                lease,
                repository,
                newId = ::nextId,
                clock = { 99L },
                frameEncoder = frameEncoder,
            )
        }

        suspend fun seed(spec: CommandSpec): TestCommand = seedBatch(listOf(spec)).single()

        suspend fun seedBatch(specs: List<CommandSpec>): List<TestCommand> {
            require(specs.isNotEmpty())
            val commands = specs.map { spec ->
                TestCommand(
                    RelayV2PendingCommand(spec.commandId, spec.dedupeWindowId),
                    spec.sessionId,
                    spec.arguments,
                )
            }
            specs.forEachIndexed { index, spec ->
                repository.reduceOutboxUnderApplyLease(
                    namespace,
                    RelayV2OutboxAction.Enqueue(
                        RelayV2OutboxDraft(
                            profileId = authority.profileId,
                            principalId = authority.principalId,
                            hostId = authority.hostId,
                            expectedHostEpoch = authority.hostEpoch,
                            dedupeWindowId = spec.dedupeWindowId,
                            commandId = spec.commandId,
                            scopeId = "scope-a",
                            sessionId = spec.sessionId,
                            arguments = spec.arguments,
                        ),
                        index.toLong() + 1L,
                    ),
                ) as RelayV2OutboxResult.Applied
            }
            var entries = repository.loadOutbox(namespace).entries
            repository.reduceOutboxUnderApplyLease(
                namespace,
                RelayV2OutboxAction.DispatchEligible(
                    entries.associate { it.id to "initial-${it.commandId}" },
                    entries.size,
                ),
            ) as RelayV2OutboxResult.Applied
            entries = repository.loadOutbox(namespace).entries
            repository.reduceOutboxUnderApplyLease(
                namespace,
                RelayV2OutboxAction.BeginQueries(
                    entries.map { it.id },
                    listOf(QUERY_ID),
                ),
            ) as RelayV2OutboxResult.Applied
            return commands
        }

        fun effect(
            command: TestCommand,
            mode: StatusMode,
        ): RelayV2RuntimeEffect.ApplyCommandStatuses = effect(listOf(command), listOf(mode))

        fun effect(
            commands: List<TestCommand>,
            modes: List<StatusMode>,
        ): RelayV2RuntimeEffect.ApplyCommandStatuses =
            RelayV2RuntimeEffect.ApplyCommandStatuses(
                context = context,
                message = statusesMessage(context, commands, modes),
                expectedCommands = commands.map { it.pending },
                recovery = RelayV2RecoveryBinding(GENERATION, 1, QUERY_ID),
            )

        suspend fun handle(
            command: TestCommand,
            mode: StatusMode,
        ): RelayV2OutboxRecoveryApplyResult.Committed =
            composition.recoveryAdapter.handle(effect(command, mode))
                as RelayV2OutboxRecoveryApplyResult.Committed

        suspend fun handle(
            commands: List<TestCommand>,
            modes: List<StatusMode>,
        ): RelayV2OutboxRecoveryApplyResult.Committed =
            composition.recoveryAdapter.handle(effect(commands, modes))
                as RelayV2OutboxRecoveryApplyResult.Committed

        fun dispatcher(sendPort: RelayV2OutboxExactGenerationSendPort): RelayV2OutboxDispatcher =
            composition.dispatcher(sendPort)

        private fun nextId(): String = ids.removeFirstOrNull() ?: "generated-${++fallbackId}"
    }

    private class TestApplyLease : RelayV2RepositoryEffectApplyLeasePort {
        @Volatile
        var active = false
            private set

        override suspend fun <T> withEffectApplyLease(
            authority: RelayV2RepositoryEffectAuthority,
            block: suspend () -> T,
        ): RelayV2EffectApplyResult<T> {
            assertEquals(AUTHORITY, authority)
            check(!active)
            active = true
            return try {
                RelayV2EffectApplyResult.Applied(block())
            } finally {
                active = false
            }
        }
    }

    private class RecordingSendPort(
        private val currentAuthority: RelayV2RepositoryEffectAuthority,
        private val result: RelayV2OutboxExactGenerationSendResult =
            RelayV2OutboxExactGenerationSendResult.Sent,
        private val failure: Exception? = null,
        private val onTransport: (() -> Unit)? = null,
    ) : RelayV2OutboxExactGenerationSendPort {
        var admissionCalls = 0
            private set
        var transportCalls = 0
            private set
        val frames = mutableListOf<ByteArray>()

        override fun sendIfCurrent(
            authority: RelayV2RepositoryEffectAuthority,
            canonicalWireBytes: ByteArray,
        ): RelayV2OutboxExactGenerationSendResult {
            admissionCalls += 1
            if (authority != currentAuthority) return RelayV2OutboxExactGenerationSendResult.Stale
            transportCalls += 1
            onTransport?.invoke()
            failure?.let { throw it }
            frames += canonicalWireBytes.copyOf()
            return result
        }
    }

    private class MemoryStore : RelayV2DurableStateStore, RelayV2DurableStateTransaction {
        private data class EntryKey(
            val namespace: RelayV2OutboxAuthorityNamespace,
            val hostId: String,
            val hostEpoch: String,
            val commandId: String,
        )

        private var metas = linkedMapOf<RelayV2OutboxAuthorityNamespace, RelayV2PersistedOutboxMeta>()
        private var entries = linkedMapOf<EntryKey, RelayV2PersistedOutboxEntry>()
        @Volatile
        var inTransaction = false
            private set

        override suspend fun <T> transaction(block: RelayV2DurableStateTransaction.() -> T): T {
            check(!inTransaction)
            inTransaction = true
            val metasBefore = LinkedHashMap(metas)
            val entriesBefore = LinkedHashMap(entries)
            return try {
                block(this)
            } catch (failure: Throwable) {
                metas = metasBefore
                entries = entriesBefore
                throw failure
            } finally {
                inTransaction = false
            }
        }

        override fun outboxMeta(
            namespace: RelayV2OutboxAuthorityNamespace,
        ): RelayV2PersistedOutboxMeta? = metas[namespace]

        override fun outboxEntries(
            namespace: RelayV2OutboxAuthorityNamespace,
        ): List<RelayV2PersistedOutboxEntry> = entries.values
            .filter { it.namespace == namespace }
            .sortedWith(compareBy({ it.createdOrder }, { it.commandId }))

        override fun putOutboxMeta(meta: RelayV2PersistedOutboxMeta) {
            metas[meta.namespace] = meta
        }

        override fun insertOutboxEntry(entry: RelayV2PersistedOutboxEntry) {
            val key = entry.key()
            check(key !in entries)
            entries[key] = entry
        }

        override fun replaceOutboxEntry(
            namespace: RelayV2OutboxAuthorityNamespace,
            previousId: RelayV2OutboxEntryId,
            replacement: RelayV2PersistedOutboxEntry,
        ): Boolean {
            val previousKey = EntryKey(
                namespace,
                previousId.hostId,
                previousId.expectedHostEpoch,
                previousId.commandId,
            )
            val previous = entries.remove(previousKey) ?: return false
            return try {
                insertOutboxEntry(replacement)
                true
            } catch (failure: Throwable) {
                entries[previousKey] = previous
                throw failure
            }
        }

        override fun terminalCheckpoint(
            key: RelayV2TerminalCheckpointKey,
        ): RelayV2PersistedTerminalCheckpoint? = null

        override fun putTerminalCheckpoint(checkpoint: RelayV2PersistedTerminalCheckpoint) =
            error("terminal storage is outside this test")

        private fun RelayV2PersistedOutboxEntry.key() = EntryKey(
            namespace,
            hostId,
            expectedHostEpoch,
            commandId,
        )
    }

    private data class CommandSpec(
        val commandId: String,
        val sessionId: String? = "session-$commandId",
        val arguments: RelayV2OutboxArguments = RelayV2OutboxArguments.killSession(),
        val dedupeWindowId: String = "window-$commandId",
    )

    private data class TestCommand(
        val pending: RelayV2PendingCommand,
        val sessionId: String?,
        val arguments: RelayV2OutboxArguments,
    )

    private enum class StatusMode {
        ACCEPTED,
        RETRY,
        REISSUE,
    }

    private companion object {
        const val SECRET_MESSAGE = "do not leak this payload"
        const val QUERY_ID = "query-recovery"

        val CONTEXT = context()
        val GENERATION = RelayV2EffectGeneration(
            CONTEXT.profile.profileId,
            CONTEXT.profile.activationGeneration,
            1,
        )
        val AUTHORITY = CONTEXT.repositoryEffectAuthority(GENERATION)

        fun context() = RelayV2HandshakeContext(
            profile = RelayActiveProfileIdentity("profile-v2", RelayProfileDialect.V2, 7),
            principalId = "principal-v2",
            clientInstanceId = "android-install-v2",
            hostId = "host-a",
            brokerEpoch = "broker-a",
            hostEpoch = "epoch-a",
            hostInstanceId = "host-instance-a",
            eventSeq = "10",
            negotiatedCapabilities = emptySet(),
            negotiatedLimits = RelayV2NegotiatedLimits(
                1_048_576,
                1_500_000,
                1_048_576,
                524_288,
                256,
                64,
                32,
                262_144,
                256,
                67_108_864,
                100_000,
                4_194_304,
                16_777_216,
                1_048_576,
                262_144,
                emptyMap(),
            ),
            commandDedupeWindow = RelayV2CommandDedupeWindow(
                "window-current",
                "2",
                1_000,
                2_000,
            ),
        )

        fun statusesMessage(
            context: RelayV2HandshakeContext,
            commands: List<TestCommand>,
            modes: List<StatusMode>,
        ): RelayV2DecodedMessage {
            require(commands.size == modes.size)
            val items = commands.zip(modes).map { (command, mode) ->
                val status = when (mode) {
                    StatusMode.ACCEPTED -> linkedMapOf(
                        "state" to "accepted",
                        "retryable" to false,
                        "retryAfterMs" to null,
                        "reissueRequired" to false,
                        "error" to null,
                    )
                    StatusMode.RETRY -> linkedMapOf(
                        "state" to "not_accepted",
                        "retryable" to true,
                        "retryAfterMs" to 0L,
                        "reissueRequired" to false,
                        "error" to error("COMMAND_NOT_ACCEPTED", true, "not_accepted"),
                    )
                    StatusMode.REISSUE -> linkedMapOf(
                        "state" to "not_accepted",
                        "retryable" to false,
                        "retryAfterMs" to null,
                        "reissueRequired" to true,
                        "error" to error(
                            "COMMAND_WINDOW_EXPIRED",
                            false,
                            "not_accepted",
                            linkedMapOf("reissueRequired" to true),
                        ),
                    )
                }
                linkedMapOf<String, Any?>(
                    "commandId" to command.pending.commandId,
                    "dedupeWindowId" to command.pending.dedupeWindowId,
                    "state" to status.getValue("state"),
                    "updatedAtMs" to 50L,
                    "dedupeUntilMs" to null,
                    "retryable" to status.getValue("retryable"),
                    "retryAfterMs" to status["retryAfterMs"],
                    "reissueRequired" to status.getValue("reissueRequired"),
                    "result" to null,
                    "error" to status["error"],
                )
            }
            val frame = linkedMapOf<String, Any?>(
                "protocolVersion" to 2L,
                "kind" to "response",
                "type" to "command.statuses",
                "requestId" to QUERY_ID,
                "hostId" to context.hostId,
                "hostEpoch" to context.hostEpoch,
                "payload" to linkedMapOf(
                    "dedupeWatermark" to linkedMapOf(
                        "oldestQueryableWindowSeq" to "1",
                        "newestIssuedWindowSeq" to "2",
                        "observedAtMs" to 50L,
                    ),
                    "items" to items,
                ),
            )
            val codec = RelayV2Codec()
            return codec.decodeWebSocketFrame(
                RelayV2WebSocketChannel.PUBLIC,
                codec.encodeWebSocketFrame(RelayV2WebSocketChannel.PUBLIC, frame),
            )
        }

        fun error(
            code: String,
            retryable: Boolean,
            disposition: String,
            details: Map<String, Any?>? = null,
        ): Map<String, Any?> = linkedMapOf(
            "code" to code,
            "message" to "status evidence",
            "retryable" to retryable,
            "commandDisposition" to disposition,
            "details" to details,
        )

        fun RelayV2OutboxRecoveryApplyResult.Committed.singleCapability():
            RelayV2OutboxDispatchCapability =
            (dispatchIssuance as RelayV2OutboxDispatchIssuance.Issued)
                .capabilities.single()

        fun RelayV2OutboxState.entry(commandId: String): RelayV2OutboxEntry =
            entries.single { it.commandId == commandId }

        fun decode(bytes: ByteArray): Map<String, Any?> =
            RelayV2Codec().decodeWebSocketFrame(
                RelayV2WebSocketChannel.PUBLIC,
                bytes,
            ).frame

        fun strictEncode(frame: Map<String, Any?>): ByteArray =
            RelayV2Codec().encodeWebSocketFrame(RelayV2WebSocketChannel.PUBLIC, frame)

        @Suppress("UNCHECKED_CAST")
        fun Any?.objectValue(): Map<String, Any?> = this as Map<String, Any?>

        fun Map<String, Any?>.objectValue(name: String): Map<String, Any?> =
            getValue(name).objectValue()
    }
}
