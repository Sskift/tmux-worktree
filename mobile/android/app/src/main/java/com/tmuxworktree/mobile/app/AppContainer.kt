package com.tmuxworktree.mobile.app

import android.content.Context
import com.tmuxworktree.mobile.core.data.AndroidKeystoreCredentialStore
import com.tmuxworktree.mobile.core.data.AndroidKeystoreRelayV2CredentialStore
import com.tmuxworktree.mobile.core.data.LegacyIdentityImporter
import com.tmuxworktree.mobile.core.data.PreferencesStore
import com.tmuxworktree.mobile.core.data.TwDatabase
import com.tmuxworktree.mobile.core.data.TwRepository
import com.tmuxworktree.mobile.core.network.NetworkMonitor
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayProfileDisconnectBarrier
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayProfileDisconnectReceipt
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StateDatabase
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StateRepository

class AppContainer(context: Context) {
    private val appContext = context.applicationContext

    val database: TwDatabase by lazy { TwDatabase.get(appContext) }
    val repository: TwRepository by lazy { TwRepository(database) }
    val preferences: PreferencesStore by lazy { PreferencesStore(appContext) }
    val credentials: AndroidKeystoreCredentialStore by lazy {
        AndroidKeystoreCredentialStore(appContext)
    }
    private val relayV2Credentials: AndroidKeystoreRelayV2CredentialStore by lazy {
        AndroidKeystoreRelayV2CredentialStore(appContext)
    }
    private val relayV2StateRepository: RelayV2StateRepository by lazy {
        RelayV2StateRepository(RelayV2StateDatabase.build(appContext))
    }
    val legacyIdentityImporter: LegacyIdentityImporter by lazy {
        LegacyIdentityImporter(
            context = appContext,
            preferencesStore = preferences,
            credentialStore = credentials,
        )
    }
    val networkMonitor: NetworkMonitor by lazy { NetworkMonitor(appContext) }

    internal suspend fun createRelayV2StartupAdmissionRuntime(
        disconnectBarrier: RelayProfileDisconnectBarrier,
        clearEphemeralAfterDisconnect: suspend (RelayProfileDisconnectReceipt) -> Unit,
    ): RelayV2StartupAdmissionRuntimeAdapter = RelayV2StartupAdmissionRuntimeAdapter(
        preferencesStore = preferences,
        legacyRepository = repository,
        legacyCredentialStore = credentials,
        relayV2CredentialStore = relayV2Credentials,
        relayV2StateRepository = { relayV2StateRepository },
        clientInstanceId = preferences.getOrCreateRelayV2ClientInstanceId(),
        disconnectBarrier = disconnectBarrier,
        clearEphemeralAfterDisconnect = clearEphemeralAfterDisconnect,
    )
}
