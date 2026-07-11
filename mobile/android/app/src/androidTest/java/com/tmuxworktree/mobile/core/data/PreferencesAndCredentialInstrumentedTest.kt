package com.tmuxworktree.mobile.core.data

import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
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
            relayUrl = "wss://relay.example.com///",
            hostId = "mac-admin",
            autoConnect = true,
        )
        store.setPreferredScope("mew-dev")
        store.setNotificationPreference(NotificationKind.COMPLETED, true)

        val saved = store.values.first()
        assertEquals("wss://relay.example.com", saved.relayUrl)
        assertEquals("mac-admin", saved.preferredHostId)
        assertEquals("mew-dev", saved.preferredScopeId)
        assertTrue(saved.autoConnect)
        assertTrue(saved.completedNotifications)

        store.clearProfile()
        val cleared = store.values.first()
        assertEquals("", cleared.relayUrl)
        assertEquals("", cleared.preferredHostId)
        assertEquals("local", cleared.preferredScopeId)
        assertFalse(cleared.autoConnect)
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

        store.clear()
        assertFalse(store.hasCredential())
        assertNull(store.read())
        assertTrue(securePreferences.all.isEmpty())
    }
}
