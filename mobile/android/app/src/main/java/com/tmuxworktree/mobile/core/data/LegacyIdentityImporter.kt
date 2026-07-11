package com.tmuxworktree.mobile.core.data

import android.content.Context
import kotlinx.coroutines.flow.first

class LegacyIdentityImporter(
    private val context: Context,
    private val preferencesStore: PreferencesStore,
    private val credentialStore: CredentialStore,
) {
    suspend fun importIfNeeded(): Boolean {
        if (preferencesStore.values.first().legacyIdentityMigrated) return false

        val legacy = context.getSharedPreferences(LEGACY_PREFERENCES, Context.MODE_PRIVATE)
        val relayUrl = legacy.getString("relayUrl", "").orEmpty()
        val relaySecret = legacy.getString("relaySecret", "").orEmpty()
        val hostId = legacy.getString("hostId", "").orEmpty()
        val autoConnect = legacy.getBoolean("autoConnect", false)

        if (relayUrl.isBlank() || relaySecret.isBlank()) {
            preferencesStore.setLegacyIdentityMigrated()
            return false
        }

        credentialStore.write(relaySecret)
        check(credentialStore.read() == relaySecret) { "Legacy credential migration verification failed" }
        preferencesStore.saveProfile(relayUrl, hostId, autoConnect)

        legacy.edit().remove("relaySecret").apply()
        check(!legacy.contains("relaySecret")) { "Legacy plaintext credential was not removed" }
        preferencesStore.setLegacyIdentityMigrated()
        return true
    }

    private companion object {
        const val LEGACY_PREFERENCES = "identity"
    }
}
