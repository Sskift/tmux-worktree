package com.tmuxworktree.mobile.core.data

import android.content.Context
import android.content.SharedPreferences
import kotlinx.coroutines.flow.first

class LegacyIdentityImporter(
    private val context: Context,
    private val preferencesStore: PreferencesStore,
    private val credentialStore: CredentialStore,
    private val removeLegacySecret: (SharedPreferences) -> Boolean = { preferences ->
        preferences.edit().remove("relaySecret").commit()
    },
) {
    suspend fun importIfNeeded(): Boolean {
        val legacy = context.getSharedPreferences(LEGACY_PREFERENCES, Context.MODE_PRIVATE)
        if (preferencesStore.values.first().legacyIdentityMigrated) {
            removeLingeringPlaintext(legacy)
            return false
        }
        val relayUrl = legacy.getString("relayUrl", "").orEmpty()
        val relaySecret = legacy.getString("relaySecret", "").orEmpty()
        val hostId = legacy.getString("hostId", "").orEmpty()
        val autoConnect = legacy.getBoolean("autoConnect", false)

        if (relayUrl.isBlank() || relaySecret.isBlank()) {
            removeLingeringPlaintext(legacy)
            preferencesStore.setLegacyIdentityMigrated()
            return false
        }

        credentialStore.write(relaySecret)
        check(credentialStore.read() == relaySecret) { "Legacy credential migration verification failed" }
        preferencesStore.saveProfile(relayUrl, hostId, autoConnect)

        removeLingeringPlaintext(legacy)
        preferencesStore.setLegacyIdentityMigrated()
        return true
    }

    suspend fun discardForV2Profile() {
        val legacy = context.getSharedPreferences(LEGACY_PREFERENCES, Context.MODE_PRIVATE)
        removeLingeringPlaintext(legacy)
        preferencesStore.setLegacyIdentityMigrated()
    }

    private fun removeLingeringPlaintext(legacy: SharedPreferences) {
        if (!legacy.contains("relaySecret")) return
        val plaintextRemoved = removeLegacySecret(legacy)
        check(plaintextRemoved && !legacy.contains("relaySecret")) {
            "Legacy plaintext credential was not removed"
        }
    }

    private companion object {
        const val LEGACY_PREFERENCES = "identity"
    }
}
