package com.tmuxworktree.mobile.core.data

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.Preferences
import java.io.IOException
import java.nio.file.Files
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class PreferencesStoreAgentNotificationPermissionTest {
    @Test
    fun `automatic permission offer is durable one time and storage failure stays closed`() =
        runBlocking {
            val directory = Files.createTempDirectory("agent-notification-permission")
            val file = directory.resolve("preferences.preferences_pb").toFile()
            try {
                withStore(file) { store ->
                    assertTrue(store.claimAutomaticAgentNotificationPermissionOffer())
                    assertFalse(store.claimAutomaticAgentNotificationPermissionOffer())
                    store.clearProfile()
                }
                withStore(file) { reopened ->
                    assertFalse(reopened.claimAutomaticAgentNotificationPermissionOffer())
                }

                val failure = IOException("durable marker unavailable")
                val failing = PreferencesStore(object : DataStore<Preferences> {
                    override val data: Flow<Preferences> = flow { throw failure }

                    override suspend fun updateData(
                        transform: suspend (t: Preferences) -> Preferences,
                    ): Preferences = throw failure
                })
                assertSame(
                    failure,
                    runCatching {
                        failing.claimAutomaticAgentNotificationPermissionOffer()
                    }.exceptionOrNull(),
                )
            } finally {
                directory.toFile().deleteRecursively()
            }
        }

    private suspend fun <T> withStore(
        file: java.io.File,
        block: suspend (PreferencesStore) -> T,
    ): T {
        val job = SupervisorJob()
        val dataStore = PreferenceDataStoreFactory.create(
            scope = CoroutineScope(job + Dispatchers.IO),
            produceFile = { file },
        )
        return try {
            block(PreferencesStore(dataStore))
        } finally {
            job.cancelAndJoin()
        }
    }
}
