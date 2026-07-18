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
    fun migration3To4PreservesExistingV2RowsAndAddsEmptyAgentDurableTables() {
        migration.createDatabase(DATABASE_NAME, 3).apply {
            insertLegacyAuthority()
            execSQL(
                """
                INSERT INTO relay_v2_outbox_meta (
                    profileId, profileActivationGeneration, principalId, clientInstanceId,
                    nextCreationOrder, codecVersion, payloadUtf8Bytes,
                    payloadCanonicalJson, payloadSha256
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """.trimIndent(),
                arrayOf<Any?>(
                    "profile-v2", 7, "principal-v2", "android-install-v2",
                    3, 1, 2, "{}", "outbox-digest-before-v4",
                ),
            )
            execSQL(
                """
                INSERT INTO relay_v2_terminal_checkpoints (
                    profileId, profileActivationGeneration, principalId, clientInstanceId,
                    hostId, hostEpoch, scopeId, sessionId, streamId, pane, checkpointKind,
                    codecVersion, payloadUtf8Bytes, payloadCanonicalJson, payloadSha256
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """.trimIndent(),
                arrayOf<Any?>(
                    "profile-v2", 7, "principal-v2", "android-install-v2",
                    "host-a", "epoch-a", "scope-a", "session-a", "stream-a", 0,
                    "PRE_OPEN", 1, 2, "{}", "terminal-digest-before-v4",
                ),
            )
            close()
        }

        migration.runMigrationsAndValidate(
            DATABASE_NAME,
            4,
            true,
            RelayV2StateDatabase.MIGRATION_3_4,
        ).use { migrated ->
            assertEquals(1, migrated.count("relay_v2_authority"))
            assertEquals(1, migrated.count("relay_v2_outbox_meta"))
            assertEquals(1, migrated.count("relay_v2_terminal_checkpoints"))
            assertEquals(0, migrated.count("relay_v2_agent_transcript_lifecycle_states"))
            assertEquals(
                0,
                migrated.count("relay_v2_agent_transcript_lifecycle_notification_claims"),
            )
            val claimPrimaryKey = mutableListOf<Pair<Int, String>>()
            migrated.query(
                "PRAGMA table_info(`relay_v2_agent_transcript_lifecycle_notification_claims`)",
            ).use { cursor ->
                while (cursor.moveToNext()) {
                    val primaryKeyOrder = cursor.getInt(cursor.getColumnIndexOrThrow("pk"))
                    if (primaryKeyOrder > 0) {
                        claimPrimaryKey += primaryKeyOrder to
                            cursor.getString(cursor.getColumnIndexOrThrow("name"))
                    }
                }
            }
            assertEquals(
                listOf(
                    "profileId",
                    "profileActivationGeneration",
                    "principalId",
                    "clientInstanceId",
                    "hostId",
                    "hostEpoch",
                    "scopeId",
                    "sessionId",
                    "timelineEpoch",
                    "lifecycleEventId",
                ),
                claimPrimaryKey.sortedBy { it.first }.map { it.second },
            )
            migrated.query(
                "SELECT nextCreationOrder, payloadSha256 FROM relay_v2_outbox_meta",
            ).use { cursor ->
                assertTrue(cursor.moveToFirst())
                assertEquals(3, cursor.getInt(0))
                assertEquals("outbox-digest-before-v4", cursor.getString(1))
            }
            migrated.query(
                "SELECT checkpointKind, payloadSha256 FROM relay_v2_terminal_checkpoints",
            ).use { cursor ->
                assertTrue(cursor.moveToFirst())
                assertEquals("PRE_OPEN", cursor.getString(0))
                assertEquals("terminal-digest-before-v4", cursor.getString(1))
            }
        }
    }

    @Test
    fun migration4To5PreservesAgentEvidenceAndAddsEmptyRowOrientedTables() {
        migration.createDatabase(DATABASE_NAME, 4).apply {
            insertLegacyAuthority()
            execSQL(
                """
                INSERT INTO relay_v2_agent_transcript_lifecycle_states (
                    profileId, profileActivationGeneration, principalId, clientInstanceId,
                    hostId, hostEpoch, scopeId, sessionId, timelineEpochKey,
                    codecVersion, payloadUtf8Bytes, payloadCanonicalJson, payloadSha256
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """.trimIndent(),
                arrayOf<Any?>(
                    "profile-v2", 7, "principal-v2", "android-install-v2", "host-a", "epoch-a",
                    "scope-a", "session-a", "timeline-a", 1, 26,
                    "{\"agentState\":\"before-v5\"}", "state-digest-before-v5",
                ),
            )
            execSQL(
                """
                INSERT INTO relay_v2_agent_transcript_lifecycle_notification_claims (
                    profileId, profileActivationGeneration, principalId, clientInstanceId,
                    hostId, hostEpoch, scopeId, sessionId, timelineEpoch, lifecycleEventId,
                    lifecycleState, claimedLocalGeneration, codecVersion, payloadUtf8Bytes,
                    payloadCanonicalJson, payloadSha256
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """.trimIndent(),
                arrayOf<Any?>(
                    "profile-v2", 7, "principal-v2", "android-install-v2", "host-a", "epoch-a",
                    "scope-a", "session-a", "timeline-a", "event-a", "WAITING_FOR_USER", "4",
                    1, 27, "{\"agentClaim\":\"before-v5\"}", "claim-digest-before-v5",
                ),
            )
            close()
        }

        migration.runMigrationsAndValidate(
            DATABASE_NAME,
            5,
            true,
            RelayV2StateDatabase.MIGRATION_4_5,
        ).use { migrated ->
            migrated.query("SELECT * FROM relay_v2_authority").use { cursor ->
                assertTrue(cursor.moveToFirst())
                assertEquals("profile-v2", cursor.getString(cursor.getColumnIndexOrThrow("profileId")))
                assertEquals("principal-v2", cursor.getString(cursor.getColumnIndexOrThrow("principalId")))
                assertEquals("android-install-v2", cursor.getString(cursor.getColumnIndexOrThrow("clientInstanceId")))
                assertEquals("host-a", cursor.getString(cursor.getColumnIndexOrThrow("hostId")))
                assertEquals("epoch-a", cursor.getString(cursor.getColumnIndexOrThrow("hostEpoch")))
                assertEquals("7", cursor.getString(cursor.getColumnIndexOrThrow("cursorEventSeq")))
                assertEquals("7", cursor.getString(cursor.getColumnIndexOrThrow("requiredThroughEventSeq")))
                assertEquals("3", cursor.getString(cursor.getColumnIndexOrThrow("scopesRevision")))
                assertEquals("LIVE", cursor.getString(cursor.getColumnIndexOrThrow("phase")))
                assertEquals(0, cursor.getLong(cursor.getColumnIndexOrThrow("cacheRecordCount")))
                assertEquals(2, cursor.getLong(cursor.getColumnIndexOrThrow("cacheCanonicalBytes")))
            }
            migrated.query("SELECT * FROM relay_v2_agent_transcript_lifecycle_states").use { cursor ->
                assertTrue(cursor.moveToFirst())
                assertEquals(
                    listOf(
                        "profile-v2", "7", "principal-v2", "android-install-v2", "host-a",
                        "epoch-a", "scope-a", "session-a", "timeline-a", "1", "26",
                        "{\"agentState\":\"before-v5\"}", "state-digest-before-v5",
                    ),
                    (0 until cursor.columnCount).map(cursor::getString),
                )
            }
            migrated.query(
                "SELECT * FROM relay_v2_agent_transcript_lifecycle_notification_claims",
            ).use { cursor ->
                assertTrue(cursor.moveToFirst())
                assertEquals(
                    listOf(
                        "profile-v2", "7", "principal-v2", "android-install-v2", "host-a",
                        "epoch-a", "scope-a", "session-a", "timeline-a", "event-a",
                        "WAITING_FOR_USER", "4", "1", "27",
                        "{\"agentClaim\":\"before-v5\"}", "claim-digest-before-v5",
                    ),
                    (0 until cursor.columnCount).map(cursor::getString),
                )
            }
            assertEquals(0, migrated.count("relay_v2_agent_transcript_entries"))
            assertEquals(0, migrated.count("relay_v2_agent_transcript_snapshot_staging"))
            assertEquals(0, migrated.count("relay_v2_agent_transcript_snapshot_records"))
            assertEquals(0, migrated.count("relay_v2_agent_transcript_pending_events"))
            assertEquals(0, migrated.count("relay_v2_agent_lifecycle_current"))
            assertEquals(0, migrated.count("relay_v2_agent_lifecycle_event_witnesses"))
            assertEquals(0, migrated.count("relay_v2_agent_recent_event_evidence"))
            assertEquals(0, migrated.count("relay_v2_agent_notification_ledger"))
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
            RelayV2StateDatabase.MIGRATION_3_4,
            RelayV2StateDatabase.MIGRATION_4_5,
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
                        val repository = RelayV2StateRepository(reopened)
                        val identity = RelayV2StateConnectIdentity(
                            "profile-v2",
                            "principal-v2",
                            "android-install-v2",
                            "host-a",
                        )
                        repository.applyHelloUnderApplyLease(
                            repository.loadConnectPlan(identity),
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
