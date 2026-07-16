package com.tmuxworktree.mobile.core.relay.v2.state

import android.content.Context
import androidx.room.Room
import androidx.room.testing.MigrationTestHelper
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
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

    @Test
    fun migration2To3PreservesLegacyAuthorityWithEmptyReleaseJournal() {
        migration.createDatabase(DATABASE_NAME, 2).apply {
            insertLegacyAuthority()
            close()
        }

        migration.runMigrationsAndValidate(
            DATABASE_NAME,
            3,
            true,
            RelayV2StateDatabase.MIGRATION_2_3,
        ).use { migrated ->
            migrated.query(
                """
                SELECT pendingReleaseSnapshotRequestId, pendingReleaseSnapshotId,
                    pendingReleaseCursorEventSeq, pendingReleaseReason, pendingReleasePhase
                FROM relay_v2_authority
                """.trimIndent(),
            ).use { cursor ->
                assertTrue(cursor.moveToFirst())
                repeat(5) { index -> assertNull(cursor.getString(index)) }
            }
        }
    }

    @Test
    fun migratedReleaseJournalCorruptionFailsClosedOnReopen() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        migration.createDatabase(DATABASE_NAME, 2).apply {
            insertLegacyAuthority()
            close()
        }
        migration.runMigrationsAndValidate(
            DATABASE_NAME,
            3,
            true,
            RelayV2StateDatabase.MIGRATION_2_3,
        ).close()
        fun openDatabase() = Room.databaseBuilder(
            context,
            RelayV2StateDatabase::class.java,
            DATABASE_NAME,
        ).addMigrations(
            RelayV2StateDatabase.MIGRATION_1_2,
            RelayV2StateDatabase.MIGRATION_2_3,
        ).build()
        val corruptions = listOf(
            "pendingReleaseSnapshotRequestId='request-only'",
            "pendingReleaseCursorEventSeq='7'",
            journal("UNKNOWN_REASON", "RESTART_SNAPSHOT", "7"),
            journal("SNAPSHOT_RESTART_REQUIRED", "UNKNOWN_PHASE", "7"),
            journal("SNAPSHOT_RESTART_REQUIRED", "RESTART_SNAPSHOT", "01"),
        )
        corruptions.forEach { assignment ->
            val writer = openDatabase()
            try {
                writer.openHelper.writableDatabase.execSQL(
                    "UPDATE relay_v2_authority SET $assignment",
                )
            } finally {
                writer.close()
            }
            val reopened = openDatabase()
            try {
                val failure = runCatching {
                    runBlocking(Dispatchers.IO) {
                        RelayV2StateRepository(reopened).applyHelloUnderApplyLease(
                            RelayV2StateHello(
                                RelayV2StateNamespace(
                                    "profile-v2",
                                    "principal-v2",
                                    "android-install-v2",
                                    "host-a",
                                    "epoch-a",
                                ),
                                "7",
                                null,
                                RelayV2StateHelloDisposition.FRESH,
                            ),
                        )
                    }
                }.exceptionOrNull()
                assertTrue("Corrupt release journal must fail closed: $assignment", failure != null)
                reopened.openHelper.writableDatabase.execSQL(
                    """
                    UPDATE relay_v2_authority SET
                        pendingReleaseSnapshotRequestId=NULL,
                        pendingReleaseSnapshotId=NULL,
                        pendingReleaseCursorEventSeq=NULL,
                        pendingReleaseReason=NULL,
                        pendingReleasePhase=NULL
                    """.trimIndent(),
                )
            } finally {
                reopened.close()
            }
        }
    }

    private fun androidx.sqlite.db.SupportSQLiteDatabase.insertLegacyAuthority() {
        execSQL(
            """
            INSERT INTO relay_v2_authority (
                profileId, principalId, clientInstanceId, hostId, hostEpoch,
                cursorEventSeq, requiredThroughEventSeq, scopesRevision, phase,
                cacheRecordCount, cacheCanonicalBytes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """.trimIndent(),
            arrayOf<Any?>(
                "profile-v2", "principal-v2", "android-install-v2", "host-a", "epoch-a",
                "7", "7", "3", "LIVE", 0, 2,
            ),
        )
    }

    private fun journal(reason: String, phase: String, cursor: String): String =
        """
        pendingReleaseSnapshotRequestId='snapshot-request',
        pendingReleaseSnapshotId='snapshot-id',
        pendingReleaseCursorEventSeq='$cursor',
        pendingReleaseReason='$reason',
        pendingReleasePhase='$phase'
        """.trimIndent()

    private fun androidx.sqlite.db.SupportSQLiteDatabase.count(table: String): Int =
        query("SELECT COUNT(*) FROM `$table`").use { cursor ->
            check(cursor.moveToFirst())
            cursor.getInt(0)
        }

    private companion object {
        const val DATABASE_NAME = "relay-v2-migration-test.db"
    }
}
