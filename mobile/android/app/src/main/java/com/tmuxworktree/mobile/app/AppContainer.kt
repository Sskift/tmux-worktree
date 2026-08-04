package com.tmuxworktree.mobile.app

import android.content.Context
import com.tmuxworktree.mobile.core.data.AndroidKeystoreCredentialStore
import com.tmuxworktree.mobile.core.data.LegacyIdentityImporter
import com.tmuxworktree.mobile.core.data.PreferencesStore
import com.tmuxworktree.mobile.core.data.TwDatabase
import com.tmuxworktree.mobile.core.data.TwRepository
import com.tmuxworktree.mobile.core.network.NetworkMonitor

class AppContainer(context: Context) {
    private val appContext = context.applicationContext

    val database: TwDatabase by lazy { TwDatabase.get(appContext) }
    val repository: TwRepository by lazy { TwRepository(database) }
    val preferences: PreferencesStore by lazy { PreferencesStore(appContext) }
    val credentials: AndroidKeystoreCredentialStore by lazy {
        AndroidKeystoreCredentialStore(appContext)
    }
    val legacyIdentityImporter: LegacyIdentityImporter by lazy {
        LegacyIdentityImporter(
            context = appContext,
            preferencesStore = preferences,
            credentialStore = credentials,
        )
    }
    val networkMonitor: NetworkMonitor by lazy { NetworkMonitor(appContext) }
}
