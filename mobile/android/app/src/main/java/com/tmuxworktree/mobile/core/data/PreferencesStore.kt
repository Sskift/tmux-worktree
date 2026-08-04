package com.tmuxworktree.mobile.core.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.tmuxworktree.mobile.core.model.RelayProfile
import java.io.IOException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.map

private val Context.twPreferencesDataStore: DataStore<Preferences> by preferencesDataStore(
    name = "tw_mobile_v2_preferences",
)

data class AppPreferences(
    val relayUrl: String = "",
    val preferredHostId: String = "",
    val preferredScopeId: String = "local",
    val autoConnect: Boolean = false,
    val legacyIdentityMigrated: Boolean = false,
    val waitingNotifications: Boolean = true,
    val failedNotifications: Boolean = true,
    val completedNotifications: Boolean = false,
    val darkThemeEnabled: Boolean = true,
)

class PreferencesStore(context: Context) {
    private val store = context.applicationContext.twPreferencesDataStore

    val values: Flow<AppPreferences> = store.data
        .catch { error ->
            if (error is IOException) emit(androidx.datastore.preferences.core.emptyPreferences()) else throw error
        }
        .map(::toAppPreferences)

    val profile: Flow<RelayProfile> = values.map { preferences ->
        RelayProfile(
            relayUrl = preferences.relayUrl,
            hostId = preferences.preferredHostId,
            autoConnect = preferences.autoConnect,
            hasCredential = false,
        )
    }

    suspend fun saveProfile(relayUrl: String, hostId: String, autoConnect: Boolean) {
        store.edit { preferences ->
            preferences[Keys.relayUrl] = relayUrl.trim().removeSuffix("/")
            preferences[Keys.hostId] = hostId
            preferences[Keys.autoConnect] = autoConnect
        }
    }

    suspend fun setPreferredHost(hostId: String) {
        store.edit { it[Keys.hostId] = hostId }
    }

    suspend fun setPreferredHostAndScope(hostId: String, scopeId: String) {
        store.edit {
            it[Keys.hostId] = hostId
            it[Keys.scopeId] = scopeId
        }
    }

    suspend fun setPreferredScope(scopeId: String) {
        store.edit { it[Keys.scopeId] = scopeId }
    }

    suspend fun setAutoConnect(enabled: Boolean) {
        store.edit { it[Keys.autoConnect] = enabled }
    }

    suspend fun setLegacyIdentityMigrated(migrated: Boolean = true) {
        store.edit { it[Keys.legacyMigrated] = migrated }
    }

    suspend fun setNotificationPreference(kind: NotificationKind, enabled: Boolean) {
        val key = when (kind) {
            NotificationKind.WAITING_FOR_USER -> Keys.waitingNotifications
            NotificationKind.FAILED -> Keys.failedNotifications
            NotificationKind.COMPLETED -> Keys.completedNotifications
        }
        store.edit { it[key] = enabled }
    }

    suspend fun setDarkThemeEnabled(enabled: Boolean) {
        store.edit { it[Keys.darkThemeEnabled] = enabled }
    }

    suspend fun clearProfile() {
        store.edit { preferences ->
            preferences.remove(Keys.relayUrl)
            preferences.remove(Keys.hostId)
            preferences.remove(Keys.scopeId)
            preferences[Keys.autoConnect] = false
        }
    }

    private fun toAppPreferences(preferences: Preferences) = AppPreferences(
        relayUrl = preferences[Keys.relayUrl].orEmpty(),
        preferredHostId = preferences[Keys.hostId].orEmpty(),
        preferredScopeId = preferences[Keys.scopeId] ?: "local",
        autoConnect = preferences[Keys.autoConnect] ?: false,
        legacyIdentityMigrated = preferences[Keys.legacyMigrated] ?: false,
        waitingNotifications = preferences[Keys.waitingNotifications] ?: true,
        failedNotifications = preferences[Keys.failedNotifications] ?: true,
        completedNotifications = preferences[Keys.completedNotifications] ?: false,
        darkThemeEnabled = preferences[Keys.darkThemeEnabled] ?: true,
    )

    private object Keys {
        val relayUrl = stringPreferencesKey("relay_url")
        val hostId = stringPreferencesKey("preferred_host_id")
        val scopeId = stringPreferencesKey("preferred_scope_id")
        val autoConnect = booleanPreferencesKey("auto_connect")
        val legacyMigrated = booleanPreferencesKey("legacy_identity_migrated")
        val waitingNotifications = booleanPreferencesKey("notify_waiting")
        val failedNotifications = booleanPreferencesKey("notify_failed")
        val completedNotifications = booleanPreferencesKey("notify_completed")
        val darkThemeEnabled = booleanPreferencesKey("dark_theme_enabled")
    }
}

enum class NotificationKind {
    WAITING_FOR_USER,
    FAILED,
    COMPLETED,
}
