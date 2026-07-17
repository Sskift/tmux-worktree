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
        RelayV2AgentTranscriptLifecycleStateEntity::class,
    ],
    version = 4,
    exportSchema = true,
)
internal abstract class RelayV2StateDatabase : RoomDatabase() {
    abstract fun stateDao(): RelayV2StateDao

    companion object {
        const val DATABASE_NAME = "tw_mobile_relay_v2_state.db"

        /** Builds the independent v2 state database without wiring it into the app runtime. */
        fun build(context: Context): RelayV2StateDatabase = Room.databaseBuilder(
            context.applicationContext,
            RelayV2StateDatabase::class.java,
            DATABASE_NAME,
        ).addMigrations(MIGRATION_1_2, MIGRATION_2_3, MIGRATION_3_4).build()

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
            }
        }
    }
}
