package com.tmuxworktree.mobile.core.relay.v2.state

import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxEntryId

/**
 * F050: Common outbox CRUD skeleton for in-memory RelayV2DurableStateStore
 * fakes. Subclasses add their own instrumentation (failure injection,
 * transaction counting, re-entry guards) by overriding transaction() and
 * the mutating methods.
 */
internal abstract class RelayV2OutboxMemoryStoreBase :
    RelayV2DurableStateStore,
    RelayV2DurableStateTransaction {

    protected data class EntryKey(
        val namespace: RelayV2OutboxAuthorityNamespace,
        val hostId: String,
        val hostEpoch: String,
        val commandId: String,
    )

    protected var metas =
        linkedMapOf<RelayV2OutboxAuthorityNamespace, RelayV2PersistedOutboxMeta>()
    protected var entries = linkedMapOf<EntryKey, RelayV2PersistedOutboxEntry>()

    override suspend fun <T> transaction(
        block: RelayV2DurableStateTransaction.() -> T,
    ): T {
        val metasBefore = LinkedHashMap(metas)
        val entriesBefore = LinkedHashMap(entries)
        return try {
            block(this)
        } catch (failure: Throwable) {
            metas = metasBefore
            entries = entriesBefore
            throw failure
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

    protected fun RelayV2PersistedOutboxEntry.key() = EntryKey(
        namespace,
        hostId,
        expectedHostEpoch,
        commandId,
    )
}

/**
 * F050: Common terminal CRUD skeleton for in-memory RelayV2DurableStateStore
 * fakes that only serve terminal checkpoints (outbox methods are stubs).
 * Subclasses keep their own transaction() semantics (synchronization,
 * commit-failure injection, write counting) and may override
 * terminalCheckpointsForSession/deleteTerminalCheckpoint.
 */
internal abstract class RelayV2TerminalMemoryStoreBase :
    RelayV2DurableStateStore,
    RelayV2DurableStateTransaction {

    protected var terminals =
        linkedMapOf<RelayV2TerminalCheckpointKey, RelayV2PersistedTerminalCheckpoint>()

    override fun outboxMeta(
        namespace: RelayV2OutboxAuthorityNamespace,
    ): RelayV2PersistedOutboxMeta? = null

    override fun outboxEntries(
        namespace: RelayV2OutboxAuthorityNamespace,
    ): List<RelayV2PersistedOutboxEntry> = emptyList()

    override fun putOutboxMeta(meta: RelayV2PersistedOutboxMeta) =
        error("outbox is outside this test")

    override fun insertOutboxEntry(entry: RelayV2PersistedOutboxEntry) =
        error("outbox is outside this test")

    override fun replaceOutboxEntry(
        namespace: RelayV2OutboxAuthorityNamespace,
        previousId: RelayV2OutboxEntryId,
        replacement: RelayV2PersistedOutboxEntry,
    ): Boolean = error("outbox is outside this test")

    override fun terminalCheckpoint(
        key: RelayV2TerminalCheckpointKey,
    ): RelayV2PersistedTerminalCheckpoint? = terminals[key]

    override fun putTerminalCheckpoint(checkpoint: RelayV2PersistedTerminalCheckpoint) {
        terminals[checkpoint.key] = checkpoint
    }
}
