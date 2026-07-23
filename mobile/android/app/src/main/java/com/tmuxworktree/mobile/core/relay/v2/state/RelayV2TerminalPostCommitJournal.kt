package com.tmuxworktree.mobile.core.relay.v2.state

import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Update
import androidx.room.withTransaction
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2JsonLimits
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2RepositoryEffectAuthority
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2TerminalPostCommitEffectBatch
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalAuthorityFence
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalBytes
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalEffect
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalEffectFence
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalOpenFence
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalOpenResume
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalParserCallbackToken
import java.util.Base64

internal enum class RelayV2TerminalPostCommitJournalState {
    RESERVED,
    RUNNING,
    ACCEPTED,
    REJECTED,
    UNKNOWN,
}

/** One complete immutable batch or terminal receipt retained through the checkpoint barrier. */
@Entity(
    tableName = "relay_v2_terminal_post_commit_batches",
    indices = [
        Index(value = ["reservationId"], unique = true),
        Index(value = ["authorityFingerprint", "journalOrder"]),
    ],
)
internal data class RelayV2TerminalPostCommitBatchEntity(
    @PrimaryKey(autoGenerate = true)
    val journalOrder: Long = 0,
    val reservationId: String,
    val ownerIncarnation: String,
    val authorityFingerprint: String,
    val profileId: String,
    val profileActivationGeneration: Long,
    val connectionGeneration: Long,
    val principalId: String,
    val clientInstanceId: String,
    val hostId: String,
    val hostEpoch: String,
    val scopeId: String,
    val sessionId: String,
    val streamId: String,
    val pane: Int,
    val batchFingerprint: String,
    val callbackOperationId: String,
    val effectCount: Int,
    val nextEffectIndex: Int,
    val runningEffectIndex: Int?,
    val state: String,
    val codecVersion: Int,
    val payloadUtf8Bytes: Int,
    val payloadCanonicalJson: String,
    val payloadSha256: String,
)

/** Permanent exact-generation/key fence. It contains no token or terminal byte material. */
@Entity(tableName = "relay_v2_terminal_post_commit_fences")
internal data class RelayV2TerminalPostCommitFenceEntity(
    @PrimaryKey
    val authorityFingerprint: String,
    val profileId: String,
    val profileActivationGeneration: Long,
    val connectionGeneration: Long,
    val principalId: String,
    val clientInstanceId: String,
    val hostId: String,
    val hostEpoch: String,
    val scopeId: String,
    val sessionId: String,
    val streamId: String,
    val pane: Int,
)

/** A capacity/corruption failure closes admission across process restart. */
@Entity(tableName = "relay_v2_terminal_post_commit_meta")
internal data class RelayV2TerminalPostCommitMetaEntity(
    @PrimaryKey
    val singletonId: Int = SINGLETON_ID,
    val globallyClosed: Boolean,
) {
    companion object {
        const val SINGLETON_ID = 1
    }
}

@Dao
internal interface RelayV2TerminalPostCommitJournalDao {
    @Query(
        "SELECT * FROM relay_v2_terminal_post_commit_batches " +
            "WHERE state IN ('RESERVED', 'RUNNING') " +
            "ORDER BY journalOrder ASC",
    )
    fun unsettledBatches(): List<RelayV2TerminalPostCommitBatchEntity>

    @Query(
        "SELECT * FROM relay_v2_terminal_post_commit_batches " +
            "ORDER BY journalOrder ASC",
    )
    fun allBatches(): List<RelayV2TerminalPostCommitBatchEntity>

    @Query(
        "SELECT * FROM relay_v2_terminal_post_commit_batches " +
            "WHERE reservationId = :reservationId LIMIT 1",
    )
    fun batch(reservationId: String): RelayV2TerminalPostCommitBatchEntity?

    @Query(
        "SELECT * FROM relay_v2_terminal_post_commit_batches " +
            "WHERE state IN ('RESERVED', 'RUNNING') " +
            "ORDER BY journalOrder ASC LIMIT 1",
    )
    fun fifoHead(): RelayV2TerminalPostCommitBatchEntity?

    @Query(
        "SELECT COUNT(*) FROM relay_v2_terminal_post_commit_batches " +
            "WHERE state IN ('RESERVED', 'RUNNING')",
    )
    fun unsettledBatchCount(): Int

    @Query(
        "SELECT COUNT(*) FROM relay_v2_terminal_post_commit_batches " +
            "WHERE state IN ('ACCEPTED', 'REJECTED', 'UNKNOWN')",
    )
    fun terminalOutcomeCount(): Int

    @Insert(onConflict = OnConflictStrategy.ABORT)
    fun insertBatch(batch: RelayV2TerminalPostCommitBatchEntity): Long

    @Update
    fun updateBatch(batch: RelayV2TerminalPostCommitBatchEntity): Int

    @Query(
        "DELETE FROM relay_v2_terminal_post_commit_batches " +
            "WHERE reservationId = :reservationId",
    )
    fun deleteBatch(reservationId: String): Int

    @Query(
        "SELECT * FROM relay_v2_terminal_post_commit_fences " +
            "WHERE authorityFingerprint = :authorityFingerprint LIMIT 1",
    )
    fun fence(authorityFingerprint: String): RelayV2TerminalPostCommitFenceEntity?

    @Query("SELECT COUNT(*) FROM relay_v2_terminal_post_commit_fences")
    fun fenceCount(): Int

    @Insert(onConflict = OnConflictStrategy.ABORT)
    fun insertFence(fence: RelayV2TerminalPostCommitFenceEntity)

    @Query(
        "SELECT * FROM relay_v2_terminal_post_commit_batches " +
            "WHERE authorityFingerprint = :authorityFingerprint ORDER BY journalOrder ASC",
    )
    fun batchesForAuthority(
        authorityFingerprint: String,
    ): List<RelayV2TerminalPostCommitBatchEntity>

    @Query(
        "DELETE FROM relay_v2_terminal_post_commit_batches " +
            "WHERE authorityFingerprint = :authorityFingerprint",
    )
    fun deleteBatchesForAuthority(authorityFingerprint: String): Int

    @Query(
        "SELECT * FROM relay_v2_terminal_post_commit_meta " +
            "WHERE singletonId = ${RelayV2TerminalPostCommitMetaEntity.SINGLETON_ID} LIMIT 1",
    )
    fun meta(): RelayV2TerminalPostCommitMetaEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun putMeta(meta: RelayV2TerminalPostCommitMetaEntity)

    @Query("DELETE FROM relay_v2_terminal_post_commit_batches")
    fun deleteAllBatches(): Int
}

internal interface RelayV2TerminalPostCommitJournalStore {
    suspend fun <T> transaction(block: RelayV2TerminalPostCommitJournalTransaction.() -> T): T
}

internal interface RelayV2TerminalPostCommitJournalTransaction {
    fun unsettledBatches(): List<RelayV2TerminalPostCommitBatchEntity>
    fun allBatches(): List<RelayV2TerminalPostCommitBatchEntity>
    fun batch(reservationId: String): RelayV2TerminalPostCommitBatchEntity?
    fun fifoHead(): RelayV2TerminalPostCommitBatchEntity?
    fun unsettledBatchCount(): Int
    fun terminalOutcomeCount(): Int
    fun insertBatch(batch: RelayV2TerminalPostCommitBatchEntity): RelayV2TerminalPostCommitBatchEntity
    fun updateBatch(batch: RelayV2TerminalPostCommitBatchEntity): Boolean
    fun deleteBatch(reservationId: String): Boolean
    fun fence(authorityFingerprint: String): RelayV2TerminalPostCommitFenceEntity?
    fun fenceCount(): Int
    fun insertFence(fence: RelayV2TerminalPostCommitFenceEntity)
    fun batchesForAuthority(authorityFingerprint: String): List<RelayV2TerminalPostCommitBatchEntity>
    fun deleteBatchesForAuthority(authorityFingerprint: String)
    fun globallyClosed(): Boolean
    fun closeGlobally()
    fun deleteAllBatches()
    fun terminalCheckpoint(key: RelayV2TerminalCheckpointKey): RelayV2TerminalCheckpointEntity?
}

internal class RoomRelayV2TerminalPostCommitJournalStore(
    private val database: RelayV2StateDatabase,
) : RelayV2TerminalPostCommitJournalStore {
    private val dao = database.terminalPostCommitJournalDao()
    private val stateDao = database.stateDao()

    override suspend fun <T> transaction(
        block: RelayV2TerminalPostCommitJournalTransaction.() -> T,
    ): T = database.withTransaction {
        RoomRelayV2TerminalPostCommitJournalTransaction(dao, stateDao).block()
    }
}

private class RoomRelayV2TerminalPostCommitJournalTransaction(
    private val dao: RelayV2TerminalPostCommitJournalDao,
    private val stateDao: RelayV2StateDao,
) : RelayV2TerminalPostCommitJournalTransaction {
    override fun unsettledBatches() = dao.unsettledBatches()
    override fun allBatches() = dao.allBatches()
    override fun batch(reservationId: String) = dao.batch(reservationId)
    override fun fifoHead() = dao.fifoHead()
    override fun unsettledBatchCount() = dao.unsettledBatchCount()
    override fun terminalOutcomeCount() = dao.terminalOutcomeCount()

    override fun insertBatch(
        batch: RelayV2TerminalPostCommitBatchEntity,
    ): RelayV2TerminalPostCommitBatchEntity {
        val order = dao.insertBatch(batch)
        return batch.copy(journalOrder = order)
    }

    override fun updateBatch(batch: RelayV2TerminalPostCommitBatchEntity): Boolean =
        dao.updateBatch(batch) == 1

    override fun deleteBatch(reservationId: String): Boolean =
        dao.deleteBatch(reservationId) == 1

    override fun fence(authorityFingerprint: String) = dao.fence(authorityFingerprint)
    override fun fenceCount() = dao.fenceCount()
    override fun insertFence(fence: RelayV2TerminalPostCommitFenceEntity) = dao.insertFence(fence)
    override fun batchesForAuthority(authorityFingerprint: String) =
        dao.batchesForAuthority(authorityFingerprint)

    override fun deleteBatchesForAuthority(authorityFingerprint: String) {
        dao.deleteBatchesForAuthority(authorityFingerprint)
    }

    override fun globallyClosed(): Boolean = dao.meta()?.globallyClosed == true

    override fun closeGlobally() {
        dao.putMeta(RelayV2TerminalPostCommitMetaEntity(globallyClosed = true))
    }

    override fun deleteAllBatches() {
        dao.deleteAllBatches()
    }

    override fun terminalCheckpoint(
        key: RelayV2TerminalCheckpointKey,
    ): RelayV2TerminalCheckpointEntity? = stateDao.terminalCheckpoint(
        key.profileId,
        key.profileActivationGeneration,
        key.principalId,
        key.clientInstanceId,
        key.hostId,
        key.hostEpoch,
        key.scopeId,
        key.sessionId,
        key.streamId,
        key.pane,
    )
}

internal data class RelayV2EncodedTerminalPostCommitBatch(
    val authorityFingerprint: String,
    val payload: RelayV2EncodedPayload,
)

/** Closed storage encoding. It is intentionally not a wire codec and never stores credential bytes. */
internal object RelayV2TerminalPostCommitBatchCodec {
    const val CODEC_VERSION = 1
    const val MAX_PAYLOAD_BYTES = 4 * 1024 * 1024
    private val JSON_LIMITS = RelayV2JsonLimits(
        maxDepth = 24,
        maxDirectKeys = 48,
        maxTotalKeys = 8_192,
        maxNodes = 16_384,
    )

    fun encode(batch: RelayV2TerminalPostCommitEffectBatch): RelayV2EncodedTerminalPostCommitBatch {
        val owner = owner(batch.authority, batch.key)
        val payload = RelayV2StorageJson.encode(
            CODEC_VERSION,
            linkedMapOf(
                "codecVersion" to CODEC_VERSION,
                "owner" to owner,
                "callbackToken" to callbackToken(batch.callbackToken),
                "effects" to batch.effects.map(::effect),
            ),
        )
        if (payload.payloadUtf8Bytes !in 1..MAX_PAYLOAD_BYTES) {
            throw RelayV2StorageException(RelayV2StorageFailure.LIMIT_EXCEEDED)
        }
        return RelayV2EncodedTerminalPostCommitBatch(
            authorityFingerprint = ownerFingerprint(batch.authority, batch.key),
            payload = payload,
        )
    }

    fun ownerFingerprint(
        authority: RelayV2RepositoryEffectAuthority,
        key: RelayV2TerminalCheckpointKey,
    ): String = RelayV2StorageJson.encode(CODEC_VERSION, owner(authority, key)).sha256

    fun validate(payload: RelayV2EncodedPayload) {
        val decoded = RelayV2StorageJson.decode(
            payload,
            CODEC_VERSION,
            MAX_PAYLOAD_BYTES,
            JSON_LIMITS,
        )
        RelayV2StorageJson.requireKeys(
            decoded,
            "codecVersion",
            "owner",
            "callbackToken",
            "effects",
        )
        if (RelayV2StorageJson.int(decoded, "codecVersion") != CODEC_VERSION) {
            throw RelayV2StorageException(RelayV2StorageFailure.SCHEMA_INCOMPATIBLE)
        }
        RelayV2StorageJson.objectValue(decoded, "owner")
        RelayV2StorageJson.objectValue(decoded, "callbackToken")
        RelayV2StorageJson.list(
            decoded,
            "effects",
            RelayV2TerminalPostCommitEffectBatch.MAX_EFFECTS,
        )
    }

    private fun owner(
        authority: RelayV2RepositoryEffectAuthority,
        key: RelayV2TerminalCheckpointKey,
    ): Map<String, Any?> = linkedMapOf(
        "profileId" to authority.profileId,
        "profileActivationGeneration" to authority.profileActivationGeneration.toString(),
        "connectionGeneration" to authority.generation.connectionGeneration.toString(),
        "principalId" to authority.principalId,
        "clientInstanceId" to authority.clientInstanceId,
        "hostId" to authority.hostId,
        "hostEpoch" to authority.hostEpoch,
        "scopeId" to key.scopeId,
        "sessionId" to key.sessionId,
        "streamId" to key.streamId,
        "pane" to key.pane,
    )

    private fun callbackToken(value: RelayV2TerminalParserCallbackToken): Map<String, Any?> =
        linkedMapOf(
            "fence" to effectFence(value.fence),
            "parserContinuityId" to value.parserContinuityId,
            "operationId" to value.operationId,
            "startOffset" to value.startOffset,
            "endOffset" to value.endOffset,
        )

    private fun effect(value: RelayV2TerminalEffect): Map<String, Any?> = when (value) {
        is RelayV2TerminalEffect.WriteParser -> linkedMapOf(
            "type" to "WRITE_PARSER",
            "callbackToken" to callbackToken(value.callbackToken),
            "bytes" to bytes(value.bytes),
            "fence" to effectFence(value.fence),
            "priority" to value.priority.name,
        )
        is RelayV2TerminalEffect.ResetParser -> linkedMapOf(
            "type" to "RESET_PARSER",
            "callbackToken" to callbackToken(value.callbackToken),
            "fence" to effectFence(value.fence),
            "priority" to value.priority.name,
        )
        is RelayV2TerminalEffect.OutputAck -> linkedMapOf(
            "type" to "OUTPUT_ACK",
            "fence" to effectFence(value.fence),
            "generation" to value.generation,
            "nextOffset" to value.nextOffset,
            "priority" to value.priority.name,
        )
        is RelayV2TerminalEffect.SendOpen -> linkedMapOf(
            "type" to "SEND_OPEN",
            "openFence" to openFence(value.openFence),
            "requestId" to value.requestId,
            "mode" to value.mode.name,
            "cols" to value.cols,
            "rows" to value.rows,
            "resume" to value.resume?.let(::openResume),
            "fence" to value.fence?.let(::authorityFence),
            "priority" to value.priority.name,
        )
        is RelayV2TerminalEffect.RequestReplay -> linkedMapOf(
            "type" to "REQUEST_REPLAY",
            "fence" to effectFence(value.fence),
            "requestId" to value.requestId,
            "generation" to value.generation,
            "fromOffset" to value.fromOffset,
            "priority" to value.priority.name,
        )
        is RelayV2TerminalEffect.SendInput -> linkedMapOf(
            "type" to "SEND_INPUT",
            "dispatchFence" to effectFence(value.dispatchLease.fence),
            "generation" to value.generation,
            "inputSeq" to value.inputSeq,
            "bytes" to bytes(value.bytes),
            "fence" to effectFence(value.fence),
            "priority" to value.priority.name,
        )
        is RelayV2TerminalEffect.SendResize -> linkedMapOf(
            "type" to "SEND_RESIZE",
            "dispatchFence" to effectFence(value.dispatchLease.fence),
            "generation" to value.generation,
            "resizeSeq" to value.resizeSeq,
            "cols" to value.cols,
            "rows" to value.rows,
            "fence" to effectFence(value.fence),
            "priority" to value.priority.name,
        )
        is RelayV2TerminalEffect.SendClose -> linkedMapOf(
            "type" to "SEND_CLOSE",
            "fence" to effectFence(value.fence),
            "generation" to value.generation,
            "closeId" to value.closeId,
            "requestId" to value.requestId,
            "resumeTokenCredentialReference" to value.resumeTokenCredentialReference,
            "priority" to value.priority.name,
        )
        is RelayV2TerminalEffect.QueryCloseCorrelation -> linkedMapOf(
            "type" to "QUERY_CLOSE_CORRELATION",
            "fence" to effectFence(value.fence),
            "generation" to value.generation,
            "closeId" to value.closeId,
            "requestId" to value.requestId,
            "priority" to value.priority.name,
        )
        is RelayV2TerminalEffect.FinalizeClosed -> linkedMapOf(
            "type" to "FINALIZE_CLOSED",
            "fence" to effectFence(value.fence),
            "generation" to value.generation,
            "finalOffset" to value.finalOffset,
            "reason" to value.reason.name,
            "exitCode" to value.exitCode,
            "priority" to value.priority.name,
        )
        is RelayV2TerminalEffect.DisplayTruncated -> linkedMapOf(
            "type" to "DISPLAY_TRUNCATED",
            "fence" to effectFence(value.fence),
            "parserAppliedNextOffset" to value.parserAppliedNextOffset,
            "finalOffset" to value.finalOffset,
            "priority" to value.priority.name,
        )
        is RelayV2TerminalEffect.ControlsBecameAmbiguous -> linkedMapOf(
            "type" to "CONTROLS_BECAME_AMBIGUOUS",
            "fence" to effectFence(value.fence),
            "inputCount" to value.inputCount,
            "priority" to value.priority.name,
        )
        is RelayV2TerminalEffect.ResetRequired -> linkedMapOf(
            "type" to "RESET_REQUIRED",
            "fence" to value.fence?.let(::authorityFence),
            "reason" to value.reason.name,
            "parserAppliedNextOffset" to value.parserAppliedNextOffset,
            "priority" to value.priority.name,
        )
    }

    private fun authorityFence(value: RelayV2TerminalAuthorityFence): Map<String, Any?> =
        when (value) {
            is RelayV2TerminalEffectFence -> linkedMapOf(
                "type" to "EFFECT",
                "value" to effectFence(value),
            )
            is RelayV2TerminalOpenFence -> linkedMapOf(
                "type" to "OPEN",
                "value" to openFence(value),
            )
        }

    private fun effectFence(value: RelayV2TerminalEffectFence): Map<String, Any?> = linkedMapOf(
        "identity" to linkedMapOf(
            "identityVersion" to value.identity.identityVersion,
            "profileId" to value.identity.profileId,
            "profileActivationGeneration" to
                value.identity.profileActivationGeneration.toString(),
            "principalId" to value.identity.principalId,
            "clientInstanceId" to value.identity.clientInstanceId,
            "hostId" to value.identity.hostId,
            "hostEpoch" to value.identity.hostEpoch,
            "hostInstanceId" to value.identity.hostInstanceId,
            "scopeId" to value.identity.scopeId,
            "sessionId" to value.identity.sessionId,
            "streamId" to value.identity.streamId,
            "generation" to value.identity.generation,
            "resumeTokenCredentialReference" to
                value.identity.resumeTokenCredentialReference,
            "resumeTokenCredentialFingerprint" to
                value.identity.resumeTokenCredentialFingerprint,
            "pane" to value.identity.pane,
        ),
        "deliveryToken" to deliveryToken(value.deliveryToken),
        "openAttempt" to linkedMapOf(
            "openId" to value.openAttempt.openId,
            "fingerprint" to value.openAttempt.fingerprint,
        ),
    )

    private fun openFence(value: RelayV2TerminalOpenFence): Map<String, Any?> = linkedMapOf(
        "target" to linkedMapOf(
            "profileId" to value.target.profileId,
            "profileActivationGeneration" to value.target.profileActivationGeneration.toString(),
            "principalId" to value.target.principalId,
            "clientInstanceId" to value.target.clientInstanceId,
            "hostId" to value.target.hostId,
            "hostEpoch" to value.target.hostEpoch,
            "scopeId" to value.target.scopeId,
            "sessionId" to value.target.sessionId,
            "streamId" to value.target.streamId,
            "pane" to value.target.pane,
        ),
        "deliveryToken" to deliveryToken(value.deliveryToken),
        "openAttempt" to linkedMapOf(
            "openId" to value.openAttempt.openId,
            "fingerprint" to value.openAttempt.fingerprint,
        ),
        "parserContinuityId" to value.parserContinuityId,
        "mode" to value.mode.name,
        "cols" to value.cols,
        "rows" to value.rows,
        "resume" to value.resume?.let(::openResume),
    )

    private fun deliveryToken(
        value: com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalDeliveryToken,
    ): Map<String, Any?> = linkedMapOf(
        "actorProfileId" to value.actorGeneration.profileId,
        "actorProfileGeneration" to value.actorGeneration.profileGeneration.toString(),
        "actorConnectionGeneration" to value.actorGeneration.connectionGeneration.toString(),
        "authorityGeneration" to value.authorityGeneration.toString(),
        "localDispatchToken" to value.localDispatchToken.toString(),
    )

    private fun openResume(value: RelayV2TerminalOpenResume): Map<String, Any?> = linkedMapOf(
        "generation" to value.generation,
        "nextOffset" to value.nextOffset,
        "resumeTokenCredentialReference" to value.resumeTokenCredentialReference,
        "resumeTokenCredentialFingerprint" to value.resumeTokenCredentialFingerprint,
    )

    private fun bytes(value: RelayV2TerminalBytes): String =
        Base64.getEncoder().encodeToString(value.copyBytes())
}
