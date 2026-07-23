package com.tmuxworktree.mobile.core.relay.v2.state

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

@Database(
    entities = [
        RelayV2AuthorityEntity::class,
        RelayV2ScopeEntity::class,
        RelayV2SessionEntity::class,
        RelayV2SnapshotStagingEntity::class,
        RelayV2SnapshotRecordEntity::class,
        RelayV2StateEventEntity::class,
        RelayV2OutboxMetaEntity::class,
        RelayV2OutboxEntryEntity::class,
        RelayV2TerminalCheckpointEntity::class,
        RelayV2TerminalPostCommitBatchEntity::class,
        RelayV2TerminalPostCommitFenceEntity::class,
        RelayV2TerminalPostCommitMetaEntity::class,
        RelayV2AgentTranscriptLifecycleStateEntity::class,
        RelayV2AgentTranscriptLifecycleNotificationClaimEntity::class,
        RelayV2AgentTranscriptEntryEntity::class,
        RelayV2AgentTranscriptSnapshotStagingEntity::class,
        RelayV2AgentTranscriptSnapshotRecordEntity::class,
        RelayV2AgentTranscriptPendingEventEntity::class,
        RelayV2AgentLifecycleCurrentEntity::class,
        RelayV2AgentLifecycleEventWitnessEntity::class,
        RelayV2AgentRecentEventEvidenceEntity::class,
        RelayV2AgentNotificationLedgerEntity::class,
    ],
    version = 6,
    exportSchema = true,
)
internal abstract class RelayV2StateDatabase : RoomDatabase() {
    abstract fun stateDao(): RelayV2StateDao
    abstract fun agentLifecycleDao(): RelayV2AgentLifecycleDao
    abstract fun terminalPostCommitJournalDao(): RelayV2TerminalPostCommitJournalDao

    companion object {
        const val DATABASE_NAME = "tw_mobile_relay_v2_state.db"

        /** Builds the independent v2 state database without wiring it into the app runtime. */
        fun build(context: Context): RelayV2StateDatabase = Room.databaseBuilder(
            context.applicationContext,
            RelayV2StateDatabase::class.java,
            DATABASE_NAME,
        ).addMigrations(
            MIGRATION_1_2,
            MIGRATION_2_3,
            MIGRATION_3_4,
            MIGRATION_4_5,
            MIGRATION_5_6,
        ).build()

        /**
         * Additive storage-owner migration. Existing v2 state-sync rows remain byte-for-byte
         * untouched; there is deliberately no migration from the v1 production database.
         */
        val MIGRATION_1_2: Migration = object : Migration(1, 2) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    """
                    CREATE TABLE IF NOT EXISTS `relay_v2_outbox_meta` (
                        `profileId` TEXT NOT NULL,
                        `profileActivationGeneration` INTEGER NOT NULL,
                        `principalId` TEXT NOT NULL,
                        `clientInstanceId` TEXT NOT NULL,
                        `nextCreationOrder` INTEGER NOT NULL,
                        `codecVersion` INTEGER NOT NULL,
                        `payloadUtf8Bytes` INTEGER NOT NULL,
                        `payloadCanonicalJson` TEXT NOT NULL,
                        `payloadSha256` TEXT NOT NULL,
                        PRIMARY KEY(
                            `profileId`, `profileActivationGeneration`, `principalId`,
                            `clientInstanceId`
                        )
                    )
                    """.trimIndent(),
                )
                db.execSQL(
                    """
                    CREATE TABLE IF NOT EXISTS `relay_v2_outbox_entries` (
                        `profileId` TEXT NOT NULL,
                        `profileActivationGeneration` INTEGER NOT NULL,
                        `principalId` TEXT NOT NULL,
                        `clientInstanceId` TEXT NOT NULL,
                        `hostId` TEXT NOT NULL,
                        `expectedHostEpoch` TEXT NOT NULL,
                        `commandId` TEXT NOT NULL,
                        `createdOrder` INTEGER NOT NULL,
                        `codecVersion` INTEGER NOT NULL,
                        `payloadUtf8Bytes` INTEGER NOT NULL,
                        `payloadCanonicalJson` TEXT NOT NULL,
                        `payloadSha256` TEXT NOT NULL,
                        PRIMARY KEY(
                            `profileId`, `profileActivationGeneration`, `principalId`,
                            `clientInstanceId`, `hostId`, `expectedHostEpoch`, `commandId`
                        )
                    )
                    """.trimIndent(),
                )
                db.execSQL(
                    """
                    CREATE UNIQUE INDEX IF NOT EXISTS
                        `index_relay_v2_outbox_entries_profileId_profileActivationGeneration_principalId_clientInstanceId_createdOrder`
                    ON `relay_v2_outbox_entries` (
                        `profileId`, `profileActivationGeneration`, `principalId`,
                        `clientInstanceId`, `createdOrder`
                    )
                    """.trimIndent(),
                )
                db.execSQL(
                    """
                    CREATE TABLE IF NOT EXISTS `relay_v2_terminal_checkpoints` (
                        `profileId` TEXT NOT NULL,
                        `profileActivationGeneration` INTEGER NOT NULL,
                        `principalId` TEXT NOT NULL,
                        `clientInstanceId` TEXT NOT NULL,
                        `hostId` TEXT NOT NULL,
                        `hostEpoch` TEXT NOT NULL,
                        `scopeId` TEXT NOT NULL,
                        `sessionId` TEXT NOT NULL,
                        `streamId` TEXT NOT NULL,
                        `pane` INTEGER NOT NULL,
                        `checkpointKind` TEXT NOT NULL,
                        `codecVersion` INTEGER NOT NULL,
                        `payloadUtf8Bytes` INTEGER NOT NULL,
                        `payloadCanonicalJson` TEXT NOT NULL,
                        `payloadSha256` TEXT NOT NULL,
                        PRIMARY KEY(
                            `profileId`, `profileActivationGeneration`, `principalId`,
                            `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                            `streamId`, `pane`
                        )
                    )
                    """.trimIndent(),
                )
            }
        }

        val MIGRATION_2_3: Migration = object : Migration(2, 3) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    "ALTER TABLE `relay_v2_authority` " +
                        "ADD COLUMN `pendingReleaseSnapshotRequestId` TEXT",
                )
                db.execSQL(
                    "ALTER TABLE `relay_v2_authority` " +
                        "ADD COLUMN `pendingReleaseSnapshotId` TEXT",
                )
                db.execSQL(
                    "ALTER TABLE `relay_v2_authority` " +
                        "ADD COLUMN `pendingReleaseCursorEventSeq` TEXT",
                )
                db.execSQL(
                    "ALTER TABLE `relay_v2_authority` " +
                        "ADD COLUMN `pendingReleaseReason` TEXT",
                )
                db.execSQL(
                    "ALTER TABLE `relay_v2_authority` " +
                        "ADD COLUMN `pendingReleasePhase` TEXT",
                )
            }
        }

        /** Adds the isolated optional Agent extension consumer without reading or lifting v1. */
        val MIGRATION_3_4: Migration = object : Migration(3, 4) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    """
                    CREATE TABLE IF NOT EXISTS `relay_v2_agent_transcript_lifecycle_states` (
                        `profileId` TEXT NOT NULL,
                        `profileActivationGeneration` INTEGER NOT NULL,
                        `principalId` TEXT NOT NULL,
                        `clientInstanceId` TEXT NOT NULL,
                        `hostId` TEXT NOT NULL,
                        `hostEpoch` TEXT NOT NULL,
                        `scopeId` TEXT NOT NULL,
                        `sessionId` TEXT NOT NULL,
                        `timelineEpochKey` TEXT NOT NULL,
                        `codecVersion` INTEGER NOT NULL,
                        `payloadUtf8Bytes` INTEGER NOT NULL,
                        `payloadCanonicalJson` TEXT NOT NULL,
                        `payloadSha256` TEXT NOT NULL,
                        PRIMARY KEY(
                            `profileId`, `profileActivationGeneration`, `principalId`,
                            `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                            `timelineEpochKey`
                        )
                    )
                    """.trimIndent(),
                )
                db.execSQL(
                    """
                    CREATE UNIQUE INDEX IF NOT EXISTS
                        `index_relay_v2_agent_transcript_lifecycle_states_profileId_profileActivationGeneration_principalId_clientInstanceId_hostId_hostEpoch_scopeId_sessionId`
                    ON `relay_v2_agent_transcript_lifecycle_states` (
                        `profileId`, `profileActivationGeneration`, `principalId`,
                        `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`
                    )
                    """.trimIndent(),
                )
                db.execSQL(
                    """
                    CREATE TABLE IF NOT EXISTS
                        `relay_v2_agent_transcript_lifecycle_notification_claims` (
                        `profileId` TEXT NOT NULL,
                        `profileActivationGeneration` INTEGER NOT NULL,
                        `principalId` TEXT NOT NULL,
                        `clientInstanceId` TEXT NOT NULL,
                        `hostId` TEXT NOT NULL,
                        `hostEpoch` TEXT NOT NULL,
                        `scopeId` TEXT NOT NULL,
                        `sessionId` TEXT NOT NULL,
                        `timelineEpoch` TEXT NOT NULL,
                        `lifecycleEventId` TEXT NOT NULL,
                        `lifecycleState` TEXT NOT NULL,
                        `claimedLocalGeneration` TEXT NOT NULL,
                        `codecVersion` INTEGER NOT NULL,
                        `payloadUtf8Bytes` INTEGER NOT NULL,
                        `payloadCanonicalJson` TEXT NOT NULL,
                        `payloadSha256` TEXT NOT NULL,
                        PRIMARY KEY(
                            `profileId`, `profileActivationGeneration`, `principalId`,
                            `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                            `timelineEpoch`, `lifecycleEventId`
                        )
                    )
                    """.trimIndent(),
                )
            }
        }

        /**
         * Adds row-oriented Agent transcript materialization, lifecycle current/permanent/recent
         * evidence, notification ledger, snapshot staging, and the bounded durable LIVE buffer.
         * Existing version 4 payloads remain opaque and byte-for-byte untouched; no timeline is
         * read, lifted, or fabricated during this migration.
         */
        val MIGRATION_4_5: Migration = object : Migration(4, 5) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    """
                    CREATE TABLE IF NOT EXISTS `relay_v2_agent_transcript_entries` (
                        `profileId` TEXT NOT NULL,
                        `profileActivationGeneration` INTEGER NOT NULL,
                        `principalId` TEXT NOT NULL,
                        `clientInstanceId` TEXT NOT NULL,
                        `hostId` TEXT NOT NULL,
                        `hostEpoch` TEXT NOT NULL,
                        `scopeId` TEXT NOT NULL,
                        `sessionId` TEXT NOT NULL,
                        `timelineEpoch` TEXT NOT NULL,
                        `entryId` TEXT NOT NULL,
                        `runId` TEXT NOT NULL,
                        `turnId` TEXT NOT NULL,
                        `role` TEXT NOT NULL,
                        `commandId` TEXT,
                        `createdAtMs` INTEGER NOT NULL,
                        `createdAgentSeq` TEXT NOT NULL,
                        `createdAgentSeqOrder` TEXT NOT NULL,
                        `lastModifiedAgentSeq` TEXT NOT NULL,
                        `lastModifiedAgentSeqOrder` TEXT NOT NULL,
                        `entryState` TEXT NOT NULL,
                        `text` TEXT,
                        `redactionReason` TEXT,
                        `tombstoneOrigin` TEXT,
                        `tombstoneEvidenceThroughAgentSeq` TEXT,
                        `tombstoneEvidenceThroughAgentSeqOrder` TEXT,
                        `payloadCanonicalJson` TEXT NOT NULL,
                        `payloadUtf8Bytes` INTEGER NOT NULL,
                        `payloadSha256` TEXT NOT NULL,
                        PRIMARY KEY(
                            `profileId`, `profileActivationGeneration`, `principalId`,
                            `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                            `timelineEpoch`, `entryId`
                        ),
                        FOREIGN KEY(
                            `profileId`, `profileActivationGeneration`, `principalId`,
                            `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                            `timelineEpoch`
                        ) REFERENCES `relay_v2_agent_transcript_lifecycle_states` (
                            `profileId`, `profileActivationGeneration`, `principalId`,
                            `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                            `timelineEpochKey`
                        ) ON UPDATE NO ACTION ON DELETE CASCADE
                    )
                    """.trimIndent(),
                )
                db.execSQL(
                    """
                    CREATE INDEX IF NOT EXISTS `index_agent_transcript_entries_authority`
                    ON `relay_v2_agent_transcript_entries` (
                        `profileId`, `profileActivationGeneration`, `principalId`,
                        `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                        `timelineEpoch`
                        )
                    """.trimIndent(),
                )
                db.execSQL(
                    """
                    CREATE UNIQUE INDEX IF NOT EXISTS
                        `index_agent_transcript_entries_namespace_created_seq`
                    ON `relay_v2_agent_transcript_entries` (
                        `profileId`, `profileActivationGeneration`, `principalId`,
                        `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                        `timelineEpoch`, `createdAgentSeq`
                    )
                    """.trimIndent(),
                )
                db.execSQL(
                    """
                    CREATE INDEX IF NOT EXISTS
                        `index_agent_transcript_entries_namespace_created_order`
                    ON `relay_v2_agent_transcript_entries` (
                        `profileId`, `profileActivationGeneration`, `principalId`,
                        `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                        `timelineEpoch`, `createdAgentSeqOrder`
                    )
                    """.trimIndent(),
                )
                db.execSQL(
                    """
                    CREATE INDEX IF NOT EXISTS
                        `index_agent_transcript_entries_namespace_last_modified_order`
                    ON `relay_v2_agent_transcript_entries` (
                        `profileId`, `profileActivationGeneration`, `principalId`,
                        `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                        `timelineEpoch`, `lastModifiedAgentSeqOrder`, `entryId`
                    )
                    """.trimIndent(),
                )
                db.execSQL(
                    """
                    CREATE TABLE IF NOT EXISTS `relay_v2_agent_transcript_snapshot_staging` (
                        `profileId` TEXT NOT NULL,
                        `profileActivationGeneration` INTEGER NOT NULL,
                        `principalId` TEXT NOT NULL,
                        `clientInstanceId` TEXT NOT NULL,
                        `hostId` TEXT NOT NULL,
                        `hostEpoch` TEXT NOT NULL,
                        `scopeId` TEXT NOT NULL,
                        `sessionId` TEXT NOT NULL,
                        `timelineEpoch` TEXT NOT NULL,
                        `snapshotRequestId` TEXT NOT NULL,
                        `requestLocalGeneration` TEXT NOT NULL,
                        `requestNetworkToken` TEXT NOT NULL,
                        `snapshotId` TEXT NOT NULL,
                        `nextPageIndex` INTEGER NOT NULL,
                        `nextCursor` TEXT,
                        `throughAgentSeq` TEXT NOT NULL,
                        `throughAgentSeqOrder` TEXT NOT NULL,
                        `earliestRetainedSeq` TEXT NOT NULL,
                        `earliestRetainedSeqOrder` TEXT NOT NULL,
                        `receivedRecordCount` INTEGER NOT NULL,
                        `receivedCanonicalBytes` INTEGER NOT NULL,
                        `receivedRawUtf8Bytes` INTEGER NOT NULL,
                        `lastAgentSeq` TEXT,
                        `lastAgentSeqOrder` TEXT,
                        `lastRecordKind` TEXT,
                        `lastStableIdentity` TEXT,
                        `complete` INTEGER NOT NULL,
                        PRIMARY KEY(
                            `profileId`, `profileActivationGeneration`, `principalId`,
                            `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                            `timelineEpoch`, `snapshotId`
                        ),
                        FOREIGN KEY(
                            `profileId`, `profileActivationGeneration`, `principalId`,
                            `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                            `timelineEpoch`
                        ) REFERENCES `relay_v2_agent_transcript_lifecycle_states` (
                            `profileId`, `profileActivationGeneration`, `principalId`,
                            `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                            `timelineEpochKey`
                        ) ON UPDATE NO ACTION ON DELETE CASCADE
                    )
                    """.trimIndent(),
                )
                db.execSQL(
                    """
                    CREATE UNIQUE INDEX IF NOT EXISTS
                        `index_agent_transcript_snapshot_staging_active_namespace`
                    ON `relay_v2_agent_transcript_snapshot_staging` (
                        `profileId`, `profileActivationGeneration`, `principalId`,
                        `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                        `timelineEpoch`
                    )
                    """.trimIndent(),
                )
                db.execSQL(
                    """
                    CREATE TABLE IF NOT EXISTS `relay_v2_agent_transcript_snapshot_records` (
                        `profileId` TEXT NOT NULL,
                        `profileActivationGeneration` INTEGER NOT NULL,
                        `principalId` TEXT NOT NULL,
                        `clientInstanceId` TEXT NOT NULL,
                        `hostId` TEXT NOT NULL,
                        `hostEpoch` TEXT NOT NULL,
                        `scopeId` TEXT NOT NULL,
                        `sessionId` TEXT NOT NULL,
                        `timelineEpoch` TEXT NOT NULL,
                        `snapshotId` TEXT NOT NULL,
                        `pageIndex` INTEGER NOT NULL,
                        `recordIndex` INTEGER NOT NULL,
                        `recordKind` TEXT NOT NULL,
                        `stableIdentity` TEXT NOT NULL,
                        `agentEventSeq` TEXT NOT NULL,
                        `agentEventSeqOrder` TEXT NOT NULL,
                        `payloadCanonicalJson` TEXT NOT NULL,
                        `payloadRawUtf8Bytes` INTEGER NOT NULL,
                        `payloadSha256` TEXT NOT NULL,
                        PRIMARY KEY(
                            `profileId`, `profileActivationGeneration`, `principalId`,
                            `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                            `timelineEpoch`, `snapshotId`, `recordIndex`
                        ),
                        FOREIGN KEY(
                            `profileId`, `profileActivationGeneration`, `principalId`,
                            `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                            `timelineEpoch`, `snapshotId`
                        ) REFERENCES `relay_v2_agent_transcript_snapshot_staging` (
                            `profileId`, `profileActivationGeneration`, `principalId`,
                            `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                            `timelineEpoch`, `snapshotId`
                        ) ON UPDATE NO ACTION ON DELETE CASCADE
                    )
                    """.trimIndent(),
                )
                db.execSQL(
                    """
                    CREATE INDEX IF NOT EXISTS `index_agent_transcript_snapshot_records_header`
                    ON `relay_v2_agent_transcript_snapshot_records` (
                        `profileId`, `profileActivationGeneration`, `principalId`,
                        `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                        `timelineEpoch`, `snapshotId`
                    )
                    """.trimIndent(),
                )
                db.execSQL(
                    """
                    CREATE UNIQUE INDEX IF NOT EXISTS
                        `index_agent_transcript_snapshot_records_stable`
                    ON `relay_v2_agent_transcript_snapshot_records` (
                        `profileId`, `profileActivationGeneration`, `principalId`,
                        `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                        `timelineEpoch`, `snapshotId`, `recordKind`, `stableIdentity`
                    )
                    """.trimIndent(),
                )
                db.execSQL(
                    """
                    CREATE UNIQUE INDEX IF NOT EXISTS
                        `index_agent_transcript_snapshot_records_order`
                    ON `relay_v2_agent_transcript_snapshot_records` (
                        `profileId`, `profileActivationGeneration`, `principalId`,
                        `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                        `timelineEpoch`, `snapshotId`, `agentEventSeqOrder`, `stableIdentity`
                    )
                    """.trimIndent(),
                )
                db.execSQL(
                    """
                    CREATE TABLE IF NOT EXISTS `relay_v2_agent_transcript_pending_events` (
                        `profileId` TEXT NOT NULL,
                        `profileActivationGeneration` INTEGER NOT NULL,
                        `principalId` TEXT NOT NULL,
                        `clientInstanceId` TEXT NOT NULL,
                        `hostId` TEXT NOT NULL,
                        `hostEpoch` TEXT NOT NULL,
                        `scopeId` TEXT NOT NULL,
                        `sessionId` TEXT NOT NULL,
                        `timelineEpoch` TEXT NOT NULL,
                        `agentEventSeq` TEXT NOT NULL,
                        `agentEventSeqOrder` TEXT NOT NULL,
                        `eventId` TEXT NOT NULL,
                        `closedEventDigest` TEXT NOT NULL,
                        `trustedProvenance` TEXT NOT NULL,
                        `eventCanonicalJson` TEXT NOT NULL,
                        `eventRawUtf8Bytes` INTEGER NOT NULL,
                        PRIMARY KEY(
                            `profileId`, `profileActivationGeneration`, `principalId`,
                            `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                            `timelineEpoch`, `agentEventSeq`
                        ),
                        FOREIGN KEY(
                            `profileId`, `profileActivationGeneration`, `principalId`,
                            `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                            `timelineEpoch`
                        ) REFERENCES `relay_v2_agent_transcript_lifecycle_states` (
                            `profileId`, `profileActivationGeneration`, `principalId`,
                            `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                            `timelineEpochKey`
                        ) ON UPDATE NO ACTION ON DELETE CASCADE
                    )
                    """.trimIndent(),
                )
                db.execSQL(
                    """
                    CREATE INDEX IF NOT EXISTS `index_agent_transcript_pending_events_authority`
                    ON `relay_v2_agent_transcript_pending_events` (
                        `profileId`, `profileActivationGeneration`, `principalId`,
                        `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                        `timelineEpoch`
                    )
                    """.trimIndent(),
                )
                db.execSQL(
                    """
                    CREATE UNIQUE INDEX IF NOT EXISTS
                        `index_agent_transcript_pending_events_event_id`
                    ON `relay_v2_agent_transcript_pending_events` (
                        `profileId`, `profileActivationGeneration`, `principalId`,
                        `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                        `timelineEpoch`, `eventId`
                    )
                    """.trimIndent(),
                )
                db.execSQL(
                    """
                    CREATE INDEX IF NOT EXISTS `index_agent_transcript_pending_events_order`
                    ON `relay_v2_agent_transcript_pending_events` (
                        `profileId`, `profileActivationGeneration`, `principalId`,
                        `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                        `timelineEpoch`, `agentEventSeqOrder`
                    )
                    """.trimIndent(),
                )
                db.execSQL(
                    """
                    CREATE TABLE IF NOT EXISTS `relay_v2_agent_lifecycle_current` (
                        `profileId` TEXT NOT NULL,
                        `profileActivationGeneration` INTEGER NOT NULL,
                        `principalId` TEXT NOT NULL,
                        `clientInstanceId` TEXT NOT NULL,
                        `hostId` TEXT NOT NULL,
                        `hostEpoch` TEXT NOT NULL,
                        `scopeId` TEXT NOT NULL,
                        `sessionId` TEXT NOT NULL,
                        `timelineEpoch` TEXT NOT NULL,
                        `lifecycleScope` TEXT NOT NULL,
                        `runId` TEXT NOT NULL,
                        `turnIdKey` TEXT NOT NULL,
                        `lifecycleEventId` TEXT NOT NULL,
                        `agentEventSeq` TEXT NOT NULL,
                        `agentEventSeqOrder` TEXT NOT NULL,
                        PRIMARY KEY(
                            `profileId`, `profileActivationGeneration`, `principalId`,
                            `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                            `timelineEpoch`, `lifecycleScope`, `runId`, `turnIdKey`
                        ),
                        FOREIGN KEY(
                            `profileId`, `profileActivationGeneration`, `principalId`,
                            `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                            `timelineEpoch`
                        ) REFERENCES `relay_v2_agent_transcript_lifecycle_states` (
                            `profileId`, `profileActivationGeneration`, `principalId`,
                            `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                            `timelineEpochKey`
                        ) ON UPDATE NO ACTION ON DELETE CASCADE,
                        FOREIGN KEY(
                            `profileId`, `profileActivationGeneration`, `principalId`,
                            `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                            `timelineEpoch`, `lifecycleEventId`, `agentEventSeq`,
                            `agentEventSeqOrder`, `lifecycleScope`, `runId`, `turnIdKey`
                        ) REFERENCES `relay_v2_agent_lifecycle_event_witnesses` (
                            `profileId`, `profileActivationGeneration`, `principalId`,
                            `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                            `timelineEpoch`, `eventId`, `agentEventSeq`, `agentEventSeqOrder`,
                            `lifecycleScope`, `runId`, `turnIdKey`
                        ) ON UPDATE NO ACTION ON DELETE CASCADE
                    )
                    """.trimIndent(),
                )
                db.execSQL(
                    """
                    CREATE INDEX IF NOT EXISTS `index_agent_lifecycle_current_authority`
                    ON `relay_v2_agent_lifecycle_current` (
                        `profileId`, `profileActivationGeneration`, `principalId`,
                        `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                        `timelineEpoch`
                    )
                    """.trimIndent(),
                )
                db.execSQL(
                    """
                    CREATE UNIQUE INDEX IF NOT EXISTS `index_agent_lifecycle_current_event`
                    ON `relay_v2_agent_lifecycle_current` (
                        `profileId`, `profileActivationGeneration`, `principalId`,
                        `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                        `timelineEpoch`, `lifecycleEventId`
                    )
                    """.trimIndent(),
                )
                db.execSQL(
                    """
                    CREATE UNIQUE INDEX IF NOT EXISTS `index_agent_lifecycle_current_seq`
                    ON `relay_v2_agent_lifecycle_current` (
                        `profileId`, `profileActivationGeneration`, `principalId`,
                        `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                        `timelineEpoch`, `agentEventSeq`
                    )
                    """.trimIndent(),
                )
                db.execSQL(
                    """
                    CREATE UNIQUE INDEX IF NOT EXISTS `index_agent_lifecycle_current_order`
                    ON `relay_v2_agent_lifecycle_current` (
                        `profileId`, `profileActivationGeneration`, `principalId`,
                        `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                        `timelineEpoch`, `agentEventSeqOrder`, `lifecycleEventId`
                    )
                    """.trimIndent(),
                )
                db.execSQL(
                    """
                    CREATE INDEX IF NOT EXISTS `index_agent_lifecycle_current_witness`
                    ON `relay_v2_agent_lifecycle_current` (
                        `profileId`, `profileActivationGeneration`, `principalId`,
                        `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                        `timelineEpoch`, `lifecycleEventId`, `agentEventSeq`,
                        `agentEventSeqOrder`, `lifecycleScope`, `runId`, `turnIdKey`
                    )
                    """.trimIndent(),
                )
                db.execSQL(
                    """
                    CREATE UNIQUE INDEX IF NOT EXISTS `index_agent_lifecycle_current_run_turn`
                    ON `relay_v2_agent_lifecycle_current` (
                        `profileId`, `profileActivationGeneration`, `principalId`,
                        `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                        `timelineEpoch`, `runId`, `lifecycleScope`, `turnIdKey`
                    )
                    """.trimIndent(),
                )
                db.execSQL(
                    """
                    CREATE TABLE IF NOT EXISTS `relay_v2_agent_lifecycle_event_witnesses` (
                        `profileId` TEXT NOT NULL,
                        `profileActivationGeneration` INTEGER NOT NULL,
                        `principalId` TEXT NOT NULL,
                        `clientInstanceId` TEXT NOT NULL,
                        `hostId` TEXT NOT NULL,
                        `hostEpoch` TEXT NOT NULL,
                        `scopeId` TEXT NOT NULL,
                        `sessionId` TEXT NOT NULL,
                        `timelineEpoch` TEXT NOT NULL,
                        `eventId` TEXT NOT NULL,
                        `agentEventSeq` TEXT NOT NULL,
                        `agentEventSeqOrder` TEXT NOT NULL,
                        `lifecycleScope` TEXT NOT NULL,
                        `runId` TEXT NOT NULL,
                        `turnIdKey` TEXT NOT NULL,
                        `sourceEpoch` TEXT NOT NULL,
                        `lifecycleState` TEXT NOT NULL,
                        `failureCode` TEXT,
                        `failureSummary` TEXT,
                        `occurredAtMs` INTEGER NOT NULL,
                        `closedEventDigest` TEXT,
                        `witnessCanonicalJson` TEXT NOT NULL,
                        `witnessCanonicalUtf8Bytes` INTEGER NOT NULL,
                        `witnessSha256` TEXT NOT NULL,
                        PRIMARY KEY(
                            `profileId`, `profileActivationGeneration`, `principalId`,
                            `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                            `timelineEpoch`, `eventId`
                        ),
                        FOREIGN KEY(
                            `profileId`, `profileActivationGeneration`, `principalId`,
                            `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                            `timelineEpoch`
                        ) REFERENCES `relay_v2_agent_transcript_lifecycle_states` (
                            `profileId`, `profileActivationGeneration`, `principalId`,
                            `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                            `timelineEpochKey`
                        ) ON UPDATE NO ACTION ON DELETE CASCADE
                    )
                    """.trimIndent(),
                )
                db.execSQL(
                    """
                    CREATE INDEX IF NOT EXISTS `index_agent_lifecycle_witnesses_authority`
                    ON `relay_v2_agent_lifecycle_event_witnesses` (
                        `profileId`, `profileActivationGeneration`, `principalId`,
                        `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                        `timelineEpoch`
                    )
                    """.trimIndent(),
                )
                db.execSQL(
                    """
                    CREATE UNIQUE INDEX IF NOT EXISTS `index_agent_lifecycle_witnesses_seq`
                    ON `relay_v2_agent_lifecycle_event_witnesses` (
                        `profileId`, `profileActivationGeneration`, `principalId`,
                        `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                        `timelineEpoch`, `agentEventSeq`
                    )
                    """.trimIndent(),
                )
                db.execSQL(
                    """
                    CREATE UNIQUE INDEX IF NOT EXISTS `index_agent_lifecycle_witnesses_order`
                    ON `relay_v2_agent_lifecycle_event_witnesses` (
                        `profileId`, `profileActivationGeneration`, `principalId`,
                        `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                        `timelineEpoch`, `agentEventSeqOrder`, `eventId`
                    )
                    """.trimIndent(),
                )
                db.execSQL(
                    """
                    CREATE UNIQUE INDEX IF NOT EXISTS
                        `index_agent_lifecycle_witnesses_current_binding`
                    ON `relay_v2_agent_lifecycle_event_witnesses` (
                        `profileId`, `profileActivationGeneration`, `principalId`,
                        `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                        `timelineEpoch`, `eventId`, `agentEventSeq`, `agentEventSeqOrder`,
                        `lifecycleScope`, `runId`, `turnIdKey`
                    )
                    """.trimIndent(),
                )
                db.execSQL(
                    """
                    CREATE UNIQUE INDEX IF NOT EXISTS
                        `index_agent_lifecycle_witnesses_notification_binding`
                    ON `relay_v2_agent_lifecycle_event_witnesses` (
                        `profileId`, `profileActivationGeneration`, `principalId`,
                        `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                        `timelineEpoch`, `eventId`, `agentEventSeq`, `agentEventSeqOrder`,
                        `lifecycleState`
                    )
                    """.trimIndent(),
                )
                db.execSQL(
                    """
                    CREATE INDEX IF NOT EXISTS
                        `index_agent_lifecycle_witnesses_run_turn_history`
                    ON `relay_v2_agent_lifecycle_event_witnesses` (
                        `profileId`, `profileActivationGeneration`, `principalId`,
                        `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                        `timelineEpoch`, `lifecycleScope`, `runId`, `turnIdKey`,
                        `agentEventSeqOrder`, `eventId`
                    )
                    """.trimIndent(),
                )
                db.execSQL(
                    """
                    CREATE TABLE IF NOT EXISTS `relay_v2_agent_recent_event_evidence` (
                        `profileId` TEXT NOT NULL,
                        `profileActivationGeneration` INTEGER NOT NULL,
                        `principalId` TEXT NOT NULL,
                        `clientInstanceId` TEXT NOT NULL,
                        `hostId` TEXT NOT NULL,
                        `hostEpoch` TEXT NOT NULL,
                        `scopeId` TEXT NOT NULL,
                        `sessionId` TEXT NOT NULL,
                        `timelineEpoch` TEXT NOT NULL,
                        `agentEventSeq` TEXT NOT NULL,
                        `agentEventSeqOrder` TEXT NOT NULL,
                        `eventId` TEXT NOT NULL,
                        `closedEventDigest` TEXT NOT NULL,
                        `evidenceCanonicalJson` TEXT NOT NULL,
                        `evidenceCanonicalUtf8Bytes` INTEGER NOT NULL,
                        `evidenceSha256` TEXT NOT NULL,
                        PRIMARY KEY(
                            `profileId`, `profileActivationGeneration`, `principalId`,
                            `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                            `timelineEpoch`, `agentEventSeq`
                        ),
                        FOREIGN KEY(
                            `profileId`, `profileActivationGeneration`, `principalId`,
                            `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                            `timelineEpoch`
                        ) REFERENCES `relay_v2_agent_transcript_lifecycle_states` (
                            `profileId`, `profileActivationGeneration`, `principalId`,
                            `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                            `timelineEpochKey`
                        ) ON UPDATE NO ACTION ON DELETE CASCADE
                    )
                    """.trimIndent(),
                )
                db.execSQL(
                    """
                    CREATE INDEX IF NOT EXISTS `index_agent_recent_evidence_authority`
                    ON `relay_v2_agent_recent_event_evidence` (
                        `profileId`, `profileActivationGeneration`, `principalId`,
                        `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                        `timelineEpoch`
                    )
                    """.trimIndent(),
                )
                db.execSQL(
                    """
                    CREATE UNIQUE INDEX IF NOT EXISTS `index_agent_recent_evidence_event`
                    ON `relay_v2_agent_recent_event_evidence` (
                        `profileId`, `profileActivationGeneration`, `principalId`,
                        `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                        `timelineEpoch`, `eventId`
                    )
                    """.trimIndent(),
                )
                db.execSQL(
                    """
                    CREATE UNIQUE INDEX IF NOT EXISTS `index_agent_recent_evidence_order`
                    ON `relay_v2_agent_recent_event_evidence` (
                        `profileId`, `profileActivationGeneration`, `principalId`,
                        `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                        `timelineEpoch`, `agentEventSeqOrder`, `eventId`
                    )
                    """.trimIndent(),
                )
                db.execSQL(
                    """
                    CREATE TABLE IF NOT EXISTS `relay_v2_agent_notification_ledger` (
                        `profileId` TEXT NOT NULL,
                        `profileActivationGeneration` INTEGER NOT NULL,
                        `principalId` TEXT NOT NULL,
                        `clientInstanceId` TEXT NOT NULL,
                        `hostId` TEXT NOT NULL,
                        `hostEpoch` TEXT NOT NULL,
                        `scopeId` TEXT NOT NULL,
                        `sessionId` TEXT NOT NULL,
                        `timelineEpoch` TEXT NOT NULL,
                        `lifecycleEventId` TEXT NOT NULL,
                        `lifecycleState` TEXT NOT NULL,
                        `agentEventSeq` TEXT NOT NULL,
                        `agentEventSeqOrder` TEXT NOT NULL,
                        `disposition` TEXT NOT NULL,
                        `localGeneration` TEXT NOT NULL,
                        `ledgerCanonicalJson` TEXT NOT NULL,
                        `ledgerCanonicalUtf8Bytes` INTEGER NOT NULL,
                        `ledgerSha256` TEXT NOT NULL,
                        PRIMARY KEY(
                            `profileId`, `profileActivationGeneration`, `principalId`,
                            `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                            `timelineEpoch`, `lifecycleEventId`, `lifecycleState`
                        ),
                        FOREIGN KEY(
                            `profileId`, `profileActivationGeneration`, `principalId`,
                            `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                            `timelineEpoch`
                        ) REFERENCES `relay_v2_agent_transcript_lifecycle_states` (
                            `profileId`, `profileActivationGeneration`, `principalId`,
                            `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                            `timelineEpochKey`
                        ) ON UPDATE NO ACTION ON DELETE CASCADE,
                        FOREIGN KEY(
                            `profileId`, `profileActivationGeneration`, `principalId`,
                            `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                            `timelineEpoch`, `lifecycleEventId`, `agentEventSeq`,
                            `agentEventSeqOrder`, `lifecycleState`
                        ) REFERENCES `relay_v2_agent_lifecycle_event_witnesses` (
                            `profileId`, `profileActivationGeneration`, `principalId`,
                            `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                            `timelineEpoch`, `eventId`, `agentEventSeq`, `agentEventSeqOrder`,
                            `lifecycleState`
                        ) ON UPDATE NO ACTION ON DELETE CASCADE
                    )
                    """.trimIndent(),
                )
                db.execSQL(
                    """
                    CREATE INDEX IF NOT EXISTS `index_agent_notification_ledger_authority`
                    ON `relay_v2_agent_notification_ledger` (
                        `profileId`, `profileActivationGeneration`, `principalId`,
                        `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                        `timelineEpoch`
                    )
                    """.trimIndent(),
                )
                db.execSQL(
                    """
                    CREATE UNIQUE INDEX IF NOT EXISTS `index_agent_notification_ledger_event`
                    ON `relay_v2_agent_notification_ledger` (
                        `profileId`, `profileActivationGeneration`, `principalId`,
                        `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                        `timelineEpoch`, `lifecycleEventId`
                    )
                    """.trimIndent(),
                )
                db.execSQL(
                    """
                    CREATE UNIQUE INDEX IF NOT EXISTS `index_agent_notification_ledger_seq`
                    ON `relay_v2_agent_notification_ledger` (
                        `profileId`, `profileActivationGeneration`, `principalId`,
                        `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                        `timelineEpoch`, `agentEventSeq`
                    )
                    """.trimIndent(),
                )
                db.execSQL(
                    """
                    CREATE INDEX IF NOT EXISTS `index_agent_notification_ledger_witness`
                    ON `relay_v2_agent_notification_ledger` (
                        `profileId`, `profileActivationGeneration`, `principalId`,
                        `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                        `timelineEpoch`, `lifecycleEventId`, `agentEventSeq`,
                        `agentEventSeqOrder`, `lifecycleState`
                    )
                    """.trimIndent(),
                )
                db.execSQL(
                    """
                    CREATE UNIQUE INDEX IF NOT EXISTS
                        `index_agent_notification_ledger_pending_order`
                    ON `relay_v2_agent_notification_ledger` (
                        `profileId`, `profileActivationGeneration`, `principalId`,
                        `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                        `timelineEpoch`, `disposition`, `agentEventSeqOrder`,
                        `lifecycleEventId`, `lifecycleState`
                    )
                    """.trimIndent(),
                )
                db.execSQL(
                    """
                    CREATE INDEX IF NOT EXISTS `index_agent_notification_ledger_audit_order`
                    ON `relay_v2_agent_notification_ledger` (
                        `profileId`, `profileActivationGeneration`, `principalId`,
                        `clientInstanceId`, `hostId`, `hostEpoch`, `scopeId`, `sessionId`,
                        `timelineEpoch`, `agentEventSeqOrder`, `lifecycleEventId`, `lifecycleState`
                    )
                    """.trimIndent(),
                )
            }
        }

        /** Adds the isolated terminal post-commit journal; existing terminal rows are untouched. */
        val MIGRATION_5_6: Migration = object : Migration(5, 6) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    """
                    CREATE TABLE IF NOT EXISTS `relay_v2_terminal_post_commit_batches` (
                        `journalOrder` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
                        `reservationId` TEXT NOT NULL,
                        `ownerIncarnation` TEXT NOT NULL,
                        `authorityFingerprint` TEXT NOT NULL,
                        `profileId` TEXT NOT NULL,
                        `profileActivationGeneration` INTEGER NOT NULL,
                        `connectionGeneration` INTEGER NOT NULL,
                        `principalId` TEXT NOT NULL,
                        `clientInstanceId` TEXT NOT NULL,
                        `hostId` TEXT NOT NULL,
                        `hostEpoch` TEXT NOT NULL,
                        `scopeId` TEXT NOT NULL,
                        `sessionId` TEXT NOT NULL,
                        `streamId` TEXT NOT NULL,
                        `pane` INTEGER NOT NULL,
                        `batchFingerprint` TEXT NOT NULL,
                        `callbackOperationId` TEXT NOT NULL,
                        `effectCount` INTEGER NOT NULL,
                        `nextEffectIndex` INTEGER NOT NULL,
                        `runningEffectIndex` INTEGER,
                        `state` TEXT NOT NULL,
                        `codecVersion` INTEGER NOT NULL,
                        `payloadUtf8Bytes` INTEGER NOT NULL,
                        `payloadCanonicalJson` TEXT NOT NULL,
                        `payloadSha256` TEXT NOT NULL
                    )
                    """.trimIndent(),
                )
                db.execSQL(
                    """
                    CREATE UNIQUE INDEX IF NOT EXISTS
                        `index_relay_v2_terminal_post_commit_batches_reservationId`
                    ON `relay_v2_terminal_post_commit_batches` (`reservationId`)
                    """.trimIndent(),
                )
                db.execSQL(
                    """
                    CREATE INDEX IF NOT EXISTS
                        `index_relay_v2_terminal_post_commit_batches_authorityFingerprint_journalOrder`
                    ON `relay_v2_terminal_post_commit_batches` (
                        `authorityFingerprint`, `journalOrder`
                    )
                    """.trimIndent(),
                )
                db.execSQL(
                    """
                    CREATE TABLE IF NOT EXISTS `relay_v2_terminal_post_commit_fences` (
                        `authorityFingerprint` TEXT NOT NULL,
                        `profileId` TEXT NOT NULL,
                        `profileActivationGeneration` INTEGER NOT NULL,
                        `connectionGeneration` INTEGER NOT NULL,
                        `principalId` TEXT NOT NULL,
                        `clientInstanceId` TEXT NOT NULL,
                        `hostId` TEXT NOT NULL,
                        `hostEpoch` TEXT NOT NULL,
                        `scopeId` TEXT NOT NULL,
                        `sessionId` TEXT NOT NULL,
                        `streamId` TEXT NOT NULL,
                        `pane` INTEGER NOT NULL,
                        PRIMARY KEY(`authorityFingerprint`)
                    )
                    """.trimIndent(),
                )
                db.execSQL(
                    """
                    CREATE TABLE IF NOT EXISTS `relay_v2_terminal_post_commit_meta` (
                        `singletonId` INTEGER NOT NULL,
                        `globallyClosed` INTEGER NOT NULL,
                        PRIMARY KEY(`singletonId`)
                    )
                    """.trimIndent(),
                )
            }
        }
    }
}
