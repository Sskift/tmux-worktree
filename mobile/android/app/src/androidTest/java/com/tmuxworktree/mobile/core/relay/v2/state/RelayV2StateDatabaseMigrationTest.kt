package com.tmuxworktree.mobile.core.relay.v2.state

import android.content.Context
import androidx.room.testing.MigrationTestHelper
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class RelayV2StateDatabaseMigrationTest {
    @get:Rule
    val migration = MigrationTestHelper(
        InstrumentationRegistry.getInstrumentation(),
        RelayV2StateDatabase::class.java,
    )

    @After
    fun tearDown() {
        ApplicationProvider.getApplicationContext<Context>().deleteDatabase(DATABASE_NAME)
    }

    @Test
    fun migration1To2PreservesStateSyncAndAddsEmptyDurableTables() {
        migration.createDatabase(DATABASE_NAME, 1).apply {
            execSQL(
                """
                INSERT INTO relay_v2_authority (
                    profileId, principalId, clientInstanceId, hostId, hostEpoch,
                    cursorEventSeq, requiredThroughEventSeq, scopesRevision, phase,
                    cacheRecordCount, cacheCanonicalBytes
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """.trimIndent(),
                arrayOf<Any?>(
                    "profile-v2",
                    "principal-v2",
                    "android-install-v2",
                    "host-a",
                    "epoch-a",
                    "7",
                    "7",
                    "3",
                    "LIVE",
                    0,
                    2,
                ),
            )
            execSQL(
                """
                INSERT INTO relay_v2_scopes (
                    profileId, principalId, clientInstanceId, hostId, hostEpoch,
                    scopeId, displayName, kind, reachability, sessionsRevision,
                    scopeRecordCanonicalJson, sessionsScopeRecordCanonicalJson
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """.trimIndent(),
                arrayOf<Any?>(
                    "profile-v2", "principal-v2", "android-install-v2", "host-a", "epoch-a",
                    "scope-a", "Scope A", "local", "online", "3", "{}", "{}",
                ),
            )
            execSQL(
                """
                INSERT INTO relay_v2_sessions (
                    profileId, principalId, clientInstanceId, hostId, hostEpoch,
                    scopeId, sessionId, kind, displayName, attached, windowCount,
                    createdAtMs, activityAtMs, recordCanonicalJson
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """.trimIndent(),
                arrayOf<Any?>(
                    "profile-v2", "principal-v2", "android-install-v2", "host-a", "epoch-a",
                    "scope-a", "session-a", "worktree", "Session A", 0, 1, 1, 2, "{}",
                ),
            )
            execSQL(
                """
                INSERT INTO relay_v2_snapshot_staging (
                    profileId, principalId, clientInstanceId, hostId, hostEpoch,
                    snapshotRequestId, snapshotId, snapshotCreatedAtMs,
                    snapshotLeaseExpiresAtMs, snapshotAbsoluteExpiresAtMs, throughEventSeq,
                    scopesRevision, totalRecords, totalCanonicalBytes, cutDigest,
                    nextChunkIndex, receivedRecords, receivedRecordCanonicalBytes,
                    receivedRawUtf8Bytes, complete
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """.trimIndent(),
                arrayOf<Any?>(
                    "profile-v2", "principal-v2", "android-install-v2", "host-a", "epoch-a",
                    "snapshot-request-a", "snapshot-a", 1, 2, 3, "7", "3", 1, 2,
                    "digest-a", 1, 1, 2, 2, 1,
                ),
            )
            execSQL(
                """
                INSERT INTO relay_v2_snapshot_records (
                    profileId, principalId, clientInstanceId, hostId, hostEpoch,
                    snapshotId, recordIndex, chunkIndex, recordType, scopeId, canonicalJson
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """.trimIndent(),
                arrayOf<Any?>(
                    "profile-v2", "principal-v2", "android-install-v2", "host-a", "epoch-a",
                    "snapshot-a", 0, 0, "scope", "scope-a", "{}",
                ),
            )
            execSQL(
                """
                INSERT INTO relay_v2_state_event_buffer (
                    profileId, principalId, clientInstanceId, hostId, hostEpoch,
                    eventSeq, eventSeqOrder, resultingRevision, changeType, scopeId,
                    rawUtf8Bytes, canonicalJson
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """.trimIndent(),
                arrayOf<Any?>(
                    "profile-v2", "principal-v2", "android-install-v2", "host-a", "epoch-a",
                    "8", "00000000000000000008", "4", "scope_delete", "scope-a", 2, "{}",
                ),
            )
            close()
        }

        migration.runMigrationsAndValidate(
            DATABASE_NAME,
            2,
            true,
            RelayV2StateDatabase.MIGRATION_1_2,
        ).use { migrated ->
            assertEquals(1, migrated.count("relay_v2_authority"))
            assertEquals(1, migrated.count("relay_v2_scopes"))
            assertEquals(1, migrated.count("relay_v2_sessions"))
            assertEquals(1, migrated.count("relay_v2_snapshot_staging"))
            assertEquals(1, migrated.count("relay_v2_snapshot_records"))
            assertEquals(1, migrated.count("relay_v2_state_event_buffer"))
            assertEquals(0, migrated.count("relay_v2_outbox_meta"))
            assertEquals(0, migrated.count("relay_v2_outbox_entries"))
            assertEquals(0, migrated.count("relay_v2_terminal_checkpoints"))
        }
    }

    private fun androidx.sqlite.db.SupportSQLiteDatabase.count(table: String): Int =
        query("SELECT COUNT(*) FROM `$table`").use { cursor ->
            check(cursor.moveToFirst())
            cursor.getInt(0)
        }

    private companion object {
        const val DATABASE_NAME = "relay-v2-migration-test.db"
    }
}
