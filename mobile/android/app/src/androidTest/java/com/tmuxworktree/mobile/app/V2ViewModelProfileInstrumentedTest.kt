package com.tmuxworktree.mobile.app

import android.content.Context
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.tmuxworktree.mobile.core.model.RelayHost
import com.tmuxworktree.mobile.core.model.RelayScope
import com.tmuxworktree.mobile.core.model.RelaySession
import java.io.File
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class V2ViewModelProfileInstrumentedTest {
    private val context: Context
        get() = InstrumentationRegistry.getInstrumentation().targetContext

    private lateinit var container: AppContainer
    private lateinit var owner: TestViewModelStoreOwner

    @Before
    fun setUp() = runBlocking {
        container = AppContainer(context)
        owner = TestViewModelStoreOwner()
        resetStorage()
    }

    @After
    fun tearDown() = runBlocking {
        owner.viewModelStore.clear()
        resetStorage()
    }

    @Test
    fun confirmedProfileSwitchCannotRetainOldCredentialBoundRows() = runBlocking {
        seedOldProfile(withReadableCredential = true)
        val viewModel = createViewModel()
        awaitState(viewModel) { it.initialized && it.paired }

        viewModel.applyPairingPayload(
            PairingPayload("wss://new-relay.example.com", "new-secret", "new-host"),
        )
        viewModel.connectPairing()
        assertTrue(awaitState(viewModel) { it.confirmProfileSwitch }.confirmProfileSwitch)
        viewModel.confirmProfileSwitch()

        val switched = awaitState(viewModel) {
            it.paired && it.preferences.relayUrl == "wss://new-relay.example.com"
        }
        assertEquals("new-host", switched.preferences.preferredHostId)
        assertEquals("new-secret", container.credentials.read())
        assertTrue(container.repository.hosts.first().isEmpty())
        assertTrue(container.repository.scopes.first().isEmpty())
        assertTrue(container.repository.sessions.first().isEmpty())
        assertTrue(container.repository.outbox.first().isEmpty())
        assertTrue(container.repository.timeline("old-host:local:old-session").first().isEmpty())
    }

    @Test
    fun unreadableOldCredentialClearsOrphanedCacheBeforeNewPairing() = runBlocking {
        seedOldProfile(withReadableCredential = false)
        val viewModel = createViewModel()

        val recovered = awaitState(viewModel) {
            it.initialized && !it.paired && it.preferences.relayUrl.isBlank() && it.sessions.isEmpty()
        }
        assertTrue(recovered.pairingRequired)
        assertTrue(container.repository.outbox.first().isEmpty())
        assertFalse(container.credentials.hasCredential())

        viewModel.applyPairingPayload(
            PairingPayload("wss://fresh-relay.example.com", "fresh-secret", "fresh-host"),
        )
        viewModel.connectPairing()
        val paired = awaitState(viewModel) {
            it.paired && it.preferences.relayUrl == "wss://fresh-relay.example.com"
        }

        assertEquals("fresh-host", paired.preferences.preferredHostId)
        assertEquals("fresh-secret", container.credentials.read())
        assertTrue(container.repository.outbox.first().isEmpty())
    }

    @Test
    fun storedCleartextRelayProfileReturnsToPairingReview() = runBlocking {
        container.preferences.saveProfile("ws://private-relay.example.com", "old-host", true)
        container.credentials.write("old-secret")
        val viewModel = createViewModel()

        val review = awaitState(viewModel) {
            it.initialized && it.pairingRequired && !it.pairingRelayUrlError.isNullOrBlank()
        }

        assertEquals("ws://private-relay.example.com", review.pairingRelayUrl)
        assertEquals("old-host", review.pairingHostId)
        assertTrue(review.pairingRelayUrlError.orEmpty().contains("Use wss://"))
        assertFalse(review.isConnecting)
    }

    @Test
    fun importedLanCleartextUrlIsRejectedOnReviewBeforeConnect() = runBlocking {
        val viewModel = createViewModel()
        awaitState(viewModel) { it.initialized }
        val secret = "imported-secret-that-must-stay-in-memory"

        viewModel.applyPairingPayload(
            PairingPayload("ws://mac.local:8787", secret, "mac-admin"),
        )
        val review = awaitState(viewModel) {
            it.pairingRequired && it.pairingRelayUrl == "ws://mac.local:8787"
        }

        assertTrue(review.pairingRelayUrlError.orEmpty().contains("limited to emulator or loopback"))
        assertFalse(review.isConnecting)
        assertFalse(review.paired)
        assertEquals("", container.preferences.values.first().relayUrl)
        assertNull(container.credentials.read())
        assertTrue(container.repository.hosts.first().isEmpty())
        assertTrue(container.repository.scopes.first().isEmpty())
        assertTrue(container.repository.sessions.first().isEmpty())
        assertTrue(container.repository.outbox.first().isEmpty())
        assertSecretAbsentFromProfilePersistence(secret)

        viewModel.connectPairing()
        assertTrue(viewModel.uiState.value.pairingRelayUrlError.orEmpty().contains("Use wss://"))
        assertEquals("", container.preferences.values.first().relayUrl)
        assertNull(container.credentials.read())
        assertSecretAbsentFromProfilePersistence(secret)
    }

    @Test
    fun importedValidProfileNeverAutoConnectsOrOverwritesStoredProfile() = runBlocking {
        seedOldProfile(withReadableCredential = true)
        val viewModel = createViewModel()
        awaitState(viewModel) { it.initialized && it.paired }

        viewModel.applyPairingPayload(
            PairingPayload("wss://new-relay.example.com", "new-secret", "new-host"),
        )
        val review = awaitState(viewModel) {
            it.pairingRequired && it.pairingRelayUrl == "wss://new-relay.example.com"
        }

        assertNull(review.pairingRelayUrlError)
        assertFalse(review.confirmProfileSwitch)
        assertEquals("wss://old-relay.example.com", container.preferences.values.first().relayUrl)
        assertEquals("old-secret", container.credentials.read())
        assertTrue(container.repository.sessions.first().any { it.hostId == "old-host" })
        assertSecretAbsentFromProfilePersistence("new-secret")
    }

    private fun createViewModel(): V2ViewModel = ViewModelProvider(
        owner,
        V2ViewModel.factory(container, demoMode = false),
    )[V2ViewModel::class.java]

    private suspend fun seedOldProfile(withReadableCredential: Boolean) {
        container.preferences.saveProfile("wss://old-relay.example.com", "old-host", true)
        if (withReadableCredential) container.credentials.write("old-secret") else container.credentials.clear()
        container.repository.replaceHosts(listOf(RelayHost("old-host", "Old host")))
        container.repository.replaceScopes(
            "old-host",
            listOf(RelayScope("old-host", "local", "local")),
        )
        container.repository.replaceSessions(
            "old-host",
            listOf(
                RelaySession(
                    hostId = "old-host",
                    name = "local:old-session",
                    rawName = "old-session",
                ),
            ),
        )
        container.repository.enqueueAgentMessage(
            "old-host",
            "local:old-session",
            "old queued body",
        )
    }

    private suspend fun resetStorage() {
        container.repository.clearProfileData()
        container.preferences.clearProfile()
        container.credentials.clear()
    }

    private fun assertSecretAbsentFromProfilePersistence(secret: String) {
        val database = context.getDatabasePath("tw_mobile_v2.db")
        listOf(
            database,
            File(database.path + "-wal"),
            File(database.path + "-shm"),
            File(context.filesDir, "datastore/tw_mobile_v2_preferences.preferences_pb"),
            File(context.applicationInfo.dataDir, "shared_prefs/tw_mobile_v2_secure.xml"),
        ).filter(File::isFile).forEach { file ->
            val persisted = file.readBytes().toString(Charsets.ISO_8859_1)
            assertFalse("Secret was persisted in ${file.name}", persisted.contains(secret))
        }
    }

    private suspend fun awaitState(
        viewModel: V2ViewModel,
        predicate: (V2UiState) -> Boolean,
    ): V2UiState = withTimeout(15_000) { viewModel.uiState.first(predicate) }

    private class TestViewModelStoreOwner : ViewModelStoreOwner {
        override val viewModelStore = ViewModelStore()
    }
}
