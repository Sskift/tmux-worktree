package com.tmuxworktree.mobile.core.data

import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PreferencesAndCredentialInstrumentedTest {
    private val context: Context
        get() = InstrumentationRegistry.getInstrumentation().targetContext

    @Test
    fun preferencesRoundTripProfileScopeAndNotificationChoices() = runTest {
        val store = PreferencesStore(context)
        store.clearProfile()

        store.saveProfile(
            relayUrl = "wss://relay.example.com/",
            hostId = "mac-admin",
            autoConnect = true,
        )
        store.setPreferredScope("mew-dev")
        store.setNotificationPreference(NotificationKind.COMPLETED, true)
        store.setDarkThemeEnabled(false)

        val saved = store.values.first()
        assertEquals("wss://relay.example.com", saved.relayUrl)
        assertEquals("mac-admin", saved.preferredHostId)
        assertEquals("mew-dev", saved.preferredScopeId)
        assertTrue(saved.autoConnect)
        assertTrue(saved.completedNotifications)
        assertFalse(saved.darkThemeEnabled)

        store.clearProfile()
        val cleared = store.values.first()
        assertEquals("", cleared.relayUrl)
        assertEquals("", cleared.preferredHostId)
        assertEquals("local", cleared.preferredScopeId)
        assertFalse(cleared.autoConnect)
        assertFalse(cleared.darkThemeEnabled)
        store.setDarkThemeEnabled(true)
    }

    @Test
    fun credentialRoundTripUsesCiphertextOnlyAndClearRemovesKeyMaterial() {
        val store = AndroidKeystoreCredentialStore(context)
        val securePreferences = context.getSharedPreferences(
            "tw_mobile_v2_secure",
            Context.MODE_PRIVATE,
        )
        val secret = "relay-secret-that-must-not-be-plaintext"
        store.clear()

        assertFalse(store.hasCredential())
        assertNull(store.read())

        store.write(secret)

        assertTrue(store.hasCredential())
        assertEquals(secret, store.read())
        assertTrue(securePreferences.contains("ciphertext"))
        assertTrue(securePreferences.contains("iv"))
        assertFalse(securePreferences.all.values.any { it == secret })
        assertFalse(securePreferences.contains("relaySecret"))
        val securePreferencesFile = File(
            context.applicationInfo.dataDir,
            "shared_prefs/tw_mobile_v2_secure.xml",
        )
        assertFalse(securePreferencesFile.readText().contains(secret))

        store.clear()
        assertFalse(store.hasCredential())
        assertNull(store.read())
        assertTrue(securePreferences.all.isEmpty())
    }

    @Test
    fun legacyIdentityMigrationMovesCredentialAndSynchronouslyRemovesPlaintext() = runTest {
        val preferences = PreferencesStore(context)
        val credentials = AndroidKeystoreCredentialStore(context)
        val legacy = context.getSharedPreferences("identity", Context.MODE_PRIVATE)

        preferences.clearProfile()
        preferences.setLegacyIdentityMigrated(false)
        credentials.clear()
        assertTrue(
            legacy.edit()
                .clear()
                .putString("relayUrl", "wss://relay.example.com")
                .putString("relaySecret", "legacy-plaintext-token")
                .putString("hostId", "mac-admin")
                .putBoolean("autoConnect", true)
                .commit(),
        )

        val imported = LegacyIdentityImporter(context, preferences, credentials).importIfNeeded()

        assertTrue(imported)
        assertEquals("legacy-plaintext-token", credentials.read())
        assertFalse(legacy.contains("relaySecret"))
        val migrated = preferences.values.first()
        assertTrue(migrated.legacyIdentityMigrated)
        assertEquals("wss://relay.example.com", migrated.relayUrl)
        assertEquals("mac-admin", migrated.preferredHostId)
        assertTrue(migrated.autoConnect)

        credentials.clear()
        assertTrue(legacy.edit().clear().commit())
        preferences.clearProfile()
        preferences.setLegacyIdentityMigrated(false)
    }

    @Test
    fun legacyIdentityMigrationDoesNotMarkCompleteWhenPlaintextCommitFails() = runTest {
        val preferences = PreferencesStore(context)
        val credentials = AndroidKeystoreCredentialStore(context)
        val legacy = context.getSharedPreferences("identity", Context.MODE_PRIVATE)

        preferences.clearProfile()
        preferences.setLegacyIdentityMigrated(false)
        credentials.clear()
        assertTrue(
            legacy.edit()
                .clear()
                .putString("relayUrl", "wss://relay.example.com")
                .putString("relaySecret", "legacy-plaintext-token")
                .putString("hostId", "mac-admin")
                .commit(),
        )

        try {
            val error = runCatching {
                LegacyIdentityImporter(
                    context = context,
                    preferencesStore = preferences,
                    credentialStore = credentials,
                    removeLegacySecret = { false },
                ).importIfNeeded()
            }.exceptionOrNull()

            assertTrue(error is IllegalStateException)
            assertTrue(legacy.contains("relaySecret"))
            assertFalse(preferences.values.first().legacyIdentityMigrated)
            assertEquals("legacy-plaintext-token", credentials.read())
        } finally {
            credentials.clear()
            assertTrue(legacy.edit().clear().commit())
            preferences.clearProfile()
            preferences.setLegacyIdentityMigrated(false)
        }
    }

    @Test
    fun completedLegacyMigrationStillScrubsLingeringPlaintext() = runTest {
        val preferences = PreferencesStore(context)
        val credentials = AndroidKeystoreCredentialStore(context)
        val legacy = context.getSharedPreferences("identity", Context.MODE_PRIVATE)

        preferences.setLegacyIdentityMigrated(true)
        assertTrue(
            legacy.edit()
                .clear()
                .putString("relaySecret", "left-behind-by-interrupted-apply")
                .commit(),
        )

        try {
            val imported = LegacyIdentityImporter(context, preferences, credentials).importIfNeeded()

            assertFalse(imported)
            assertFalse(legacy.contains("relaySecret"))
            assertTrue(preferences.values.first().legacyIdentityMigrated)
        } finally {
            credentials.clear()
            assertTrue(legacy.edit().clear().commit())
            preferences.clearProfile()
            preferences.setLegacyIdentityMigrated(false)
        }
    }

    @Test
    fun incompleteLegacyProfileScrubsPlaintextBeforeMarkingMigrationComplete() = runTest {
        val preferences = PreferencesStore(context)
        val credentials = AndroidKeystoreCredentialStore(context)
        val legacy = context.getSharedPreferences("identity", Context.MODE_PRIVATE)

        preferences.setLegacyIdentityMigrated(false)
        credentials.clear()
        assertTrue(
            legacy.edit()
                .clear()
                .putString("relaySecret", "orphaned-plaintext-token")
                .commit(),
        )

        try {
            val imported = LegacyIdentityImporter(context, preferences, credentials).importIfNeeded()

            assertFalse(imported)
            assertFalse(legacy.contains("relaySecret"))
            assertTrue(preferences.values.first().legacyIdentityMigrated)
            assertNull(credentials.read())
        } finally {
            credentials.clear()
            assertTrue(legacy.edit().clear().commit())
            preferences.clearProfile()
            preferences.setLegacyIdentityMigrated(false)
        }
    }
}
