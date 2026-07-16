package com.tmuxworktree.mobile.core.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.MutablePreferences
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.tmuxworktree.mobile.core.model.RelayProfile
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayActiveProfileIdentity
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayProfileDialect
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2CredentialReference
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2ProfileActivationAuthority
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2Profile
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2ProfileStore
import java.io.IOException
import java.util.UUID
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.first
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
    val activeProfileDialect = stringPreferencesKey("relay_active_profile_dialect")
    val activeCredentialKind = stringPreferencesKey("relay_active_credential_kind")
    val relayV2SchemaVersion = intPreferencesKey("relay_v2_profile_schema_version")
    val relayV2ProfileId = stringPreferencesKey("relay_v2_profile_id")
    val relayV2IssuerUrl = stringPreferencesKey("relay_v2_profile_issuer_url")
    val relayV2RelayUrl = stringPreferencesKey("relay_v2_profile_relay_url")
    val relayV2HostId = stringPreferencesKey("relay_v2_profile_host_id")
    val relayV2PrincipalId = stringPreferencesKey("relay_v2_profile_principal_id")
    val relayV2GrantId = stringPreferencesKey("relay_v2_profile_grant_id")
    val relayV2ClientInstanceId = stringPreferencesKey("relay_v2_profile_client_instance_id")
    val relayV2CredentialReference = stringPreferencesKey("relay_v2_profile_credential_reference")
    val relayV2CredentialVersion = longPreferencesKey("relay_v2_profile_credential_version")
    val relayV2ActivationGeneration = longPreferencesKey("relay_v2_profile_activation_generation")
    val relayV2AutoConnect = booleanPreferencesKey("relay_v2_profile_auto_connect")
    val relayV2InstallClientInstanceId = stringPreferencesKey("relay_v2_install_client_instance_id")
}

/**
 * The on-disk active-profile discriminator used by the real DataStore owner.
 *
 * These strings are frozen disk tags. They deliberately do not use enum names or ordinals.
 * The only untagged state accepted is a pre-v2 Relay v1 profile with a non-empty relay URL.
 */
internal object RelayProfilePreferencesCodec {
    private const val DIALECT_V1_TAG = "tw-relay.v1"
    private const val DIALECT_V2_TAG = "tw-relay.v2"
    private const val CREDENTIAL_V1_TAG = "legacy_shared_secret"
    private const val CREDENTIAL_V2_TAG = "twcap2_grant"

    fun activeProfileIdentity(preferences: Preferences): RelayActiveProfileIdentity? =
        when (val active = decodeActive(preferences)) {
            ActiveProfile.None -> null
            ActiveProfile.LegacyV1,
            ActiveProfile.TaggedV1,
            -> RelayActiveProfileIdentity(
                profileId = LEGACY_V1_PROFILE_ID,
                dialect = RelayProfileDialect.V1,
                activationGeneration = 0,
            )
            is ActiveProfile.V2 -> active.profile.identity
        }

    fun toRelayV2Profile(preferences: Preferences): RelayV2Profile? =
        (decodeActive(preferences) as? ActiveProfile.V2)?.profile

    fun activateRelayV2Profile(
        preferences: MutablePreferences,
        profile: RelayV2Profile,
    ) {
        preferences.remove(Keys.relayUrl)
        preferences.remove(Keys.hostId)
        preferences.remove(Keys.scopeId)
        preferences[Keys.autoConnect] = false
        preferences.removeRelayV2Profile()
        preferences[Keys.activeProfileDialect] = DIALECT_V2_TAG
        preferences[Keys.activeCredentialKind] = CREDENTIAL_V2_TAG
        preferences[Keys.relayV2SchemaVersion] = RelayV2Profile.SCHEMA_VERSION
        preferences[Keys.relayV2ProfileId] = profile.profileId
        preferences[Keys.relayV2IssuerUrl] = profile.issuerUrl
        preferences[Keys.relayV2RelayUrl] = profile.relayUrl
        preferences[Keys.relayV2HostId] = profile.hostId
        preferences[Keys.relayV2PrincipalId] = profile.principalId
        preferences[Keys.relayV2GrantId] = profile.grantId
        preferences[Keys.relayV2ClientInstanceId] = profile.clientInstanceId
        preferences[Keys.relayV2CredentialReference] = profile.credentialReference.value
        preferences[Keys.relayV2CredentialVersion] = profile.credentialVersion
        preferences[Keys.relayV2ActivationGeneration] = profile.activationGeneration
        preferences[Keys.relayV2AutoConnect] = profile.autoConnect
    }

    fun saveRelayV1Profile(
        preferences: MutablePreferences,
        relayUrl: String,
        hostId: String,
        autoConnect: Boolean,
    ) {
        val normalizedRelayUrl = relayUrl.trim().removeSuffix("/")
        require(normalizedRelayUrl.isNotBlank()) { "Relay v1 URL is required" }
        requireV1MutationAllowed(preferences)
        preferences[Keys.activeProfileDialect] = DIALECT_V1_TAG
        preferences[Keys.activeCredentialKind] = CREDENTIAL_V1_TAG
        preferences[Keys.relayUrl] = normalizedRelayUrl
        preferences[Keys.hostId] = hostId
        preferences[Keys.autoConnect] = autoConnect
    }

    fun clearRelayV1Profile(preferences: MutablePreferences) {
        requireV1MutationAllowed(preferences)
        preferences.remove(Keys.relayUrl)
        preferences.remove(Keys.hostId)
        preferences.remove(Keys.scopeId)
        preferences[Keys.autoConnect] = false
        preferences.remove(Keys.activeProfileDialect)
        preferences.remove(Keys.activeCredentialKind)
    }

    fun requireV1MutationAllowed(preferences: Preferences) {
        check(decodeActive(preferences) !is ActiveProfile.V2) {
            "Relay v1 profile mutation cannot replace an active Relay v2 profile"
        }
    }

    private fun decodeActive(preferences: Preferences): ActiveProfile {
        val dialectTag = preferences[Keys.activeProfileDialect]
        val credentialTag = preferences[Keys.activeCredentialKind]
        val hasV2State = preferences.asMap().keys.any {
            it.name.startsWith(RELAY_V2_PROFILE_KEY_PREFIX)
        }

        if (dialectTag == null && credentialTag == null) {
            check(!hasV2State) { "Untagged Relay v2 profile state is not supported" }
            return if (preferences[Keys.relayUrl].isNullOrBlank()) {
                ActiveProfile.None
            } else {
                ActiveProfile.LegacyV1
            }
        }
        check(dialectTag != null && credentialTag != null) {
            "Relay active profile tags are incomplete"
        }

        return when (dialectTag) {
            DIALECT_V1_TAG -> {
                check(credentialTag == CREDENTIAL_V1_TAG) {
                    "Relay v1 credential kind tag is invalid"
                }
                check(!hasV2State) { "Relay v1 profile contains Relay v2 state" }
                check(!preferences[Keys.relayUrl].isNullOrBlank()) {
                    "Tagged Relay v1 profile is incomplete"
                }
                ActiveProfile.TaggedV1
            }
            DIALECT_V2_TAG -> {
                check(credentialTag == CREDENTIAL_V2_TAG) {
                    "Relay v2 credential kind tag is invalid"
                }
                check(preferences[Keys.relayUrl].isNullOrBlank() &&
                    preferences[Keys.hostId].isNullOrBlank() &&
                    preferences[Keys.scopeId].isNullOrBlank()
                ) { "Relay v2 profile contains Relay v1 state" }
                ActiveProfile.V2(decodeRelayV2Profile(preferences))
            }
            else -> error("Unknown Relay active profile dialect tag")
        }
    }

    private fun decodeRelayV2Profile(preferences: Preferences): RelayV2Profile {
        check(preferences[Keys.relayV2SchemaVersion] == RelayV2Profile.SCHEMA_VERSION) {
            "Unsupported Relay v2 profile schema"
        }
        return RelayV2Profile(
            profileId = preferences.requireString(Keys.relayV2ProfileId),
            issuerUrl = preferences.requireString(Keys.relayV2IssuerUrl),
            relayUrl = preferences.requireString(Keys.relayV2RelayUrl),
            hostId = preferences.requireString(Keys.relayV2HostId),
            principalId = preferences.requireString(Keys.relayV2PrincipalId),
            grantId = preferences.requireString(Keys.relayV2GrantId),
            clientInstanceId = preferences.requireString(Keys.relayV2ClientInstanceId),
            credentialReference = RelayV2CredentialReference(
                preferences.requireString(Keys.relayV2CredentialReference),
            ),
            credentialVersion = checkNotNull(preferences[Keys.relayV2CredentialVersion]) {
                "Relay v2 credential version is missing"
            },
            activationGeneration = checkNotNull(preferences[Keys.relayV2ActivationGeneration]) {
                "Relay v2 activation generation is missing"
            },
            autoConnect = checkNotNull(preferences[Keys.relayV2AutoConnect]) {
                "Relay v2 auto-connect setting is missing"
            },
        )
    }

    private fun Preferences.requireString(key: Preferences.Key<String>): String =
        checkNotNull(this[key]?.takeIf(String::isNotBlank)) {
            "Relay v2 profile field ${key.name} is missing"
        }

    private fun MutablePreferences.removeRelayV2Profile() {
        remove(Keys.relayV2SchemaVersion)
        remove(Keys.relayV2ProfileId)
        remove(Keys.relayV2IssuerUrl)
        remove(Keys.relayV2RelayUrl)
        remove(Keys.relayV2HostId)
        remove(Keys.relayV2PrincipalId)
        remove(Keys.relayV2GrantId)
        remove(Keys.relayV2ClientInstanceId)
        remove(Keys.relayV2CredentialReference)
        remove(Keys.relayV2CredentialVersion)
        remove(Keys.relayV2ActivationGeneration)
        remove(Keys.relayV2AutoConnect)
    }

    private sealed interface ActiveProfile {
        data object None : ActiveProfile
        data object LegacyV1 : ActiveProfile
        data object TaggedV1 : ActiveProfile
        data class V2(val profile: RelayV2Profile) : ActiveProfile
    }

    private const val RELAY_V2_PROFILE_KEY_PREFIX = "relay_v2_profile_"
    private const val LEGACY_V1_PROFILE_ID = "legacy-v1-active-profile"
}

class PreferencesStore(context: Context) {
    private val store = context.applicationContext.twPreferencesDataStore

    private val readableData: Flow<Preferences> = store.data
        .catch { error ->
            if (error is IOException) emit(androidx.datastore.preferences.core.emptyPreferences()) else throw error
        }

    val values: Flow<AppPreferences> = readableData.map(::toAppPreferences)

    val profile: Flow<RelayProfile> = values.map { preferences ->
        RelayProfile(
            relayUrl = preferences.relayUrl,
            hostId = preferences.preferredHostId,
            autoConnect = preferences.autoConnect,
            hasCredential = false,
        )
    }

    /** Independent non-sensitive Relay v2 profile namespace. Tokens are not representable here. */
    internal val relayV2Profile: Flow<RelayV2Profile?> =
        readableData.map(RelayProfilePreferencesCodec::toRelayV2Profile)

    internal suspend fun activeProfileIdentity(): RelayActiveProfileIdentity? =
        RelayProfilePreferencesCodec.activeProfileIdentity(readableData.first())

    internal suspend fun activeRelayV2Profile(): RelayV2Profile? = relayV2Profile.first()

    internal suspend fun activateRelayV2Profile(
        expectedActiveProfile: RelayActiveProfileIdentity?,
        profile: RelayV2Profile,
        authority: RelayV2ProfileActivationAuthority,
    ): RelayV2Profile? = authority.commitIfCurrent { commit ->
        var activated: RelayV2Profile? = null
        store.edit { preferences ->
            if (RelayProfilePreferencesCodec.activeProfileIdentity(preferences) == expectedActiveProfile) {
                val current = RelayProfilePreferencesCodec.toRelayV2Profile(preferences)
                val resolved = if (current?.identity == profile.identity) {
                    if (current.credentialReference != profile.credentialReference ||
                        current.issuerUrl != profile.issuerUrl ||
                        current.relayUrl != profile.relayUrl ||
                        current.hostId != profile.hostId ||
                        current.principalId != profile.principalId ||
                        current.grantId != profile.grantId ||
                        current.clientInstanceId != profile.clientInstanceId
                    ) return@edit
                    current.copy(
                        credentialVersion = maxOf(
                            current.credentialVersion,
                            profile.credentialVersion,
                        ),
                    )
                } else {
                    profile
                }
                if (!commit.commitCredential()) return@edit
                RelayProfilePreferencesCodec.activateRelayV2Profile(preferences, resolved)
                activated = resolved
            }
        }
        activated
    }

    internal suspend fun updateRelayV2CredentialVersion(
        profileId: String,
        credentialReference: RelayV2CredentialReference,
        expectedActivationGeneration: Long,
        expectedVersion: Long,
        newVersion: Long,
    ): Boolean {
        require(newVersion > expectedVersion) { "Credential version must advance" }
        var updated = false
        store.edit { preferences ->
            val current = RelayProfilePreferencesCodec.toRelayV2Profile(preferences)
            if (current?.profileId == profileId &&
                current.credentialReference == credentialReference &&
                current.activationGeneration == expectedActivationGeneration &&
                current.credentialVersion == expectedVersion
            ) {
                preferences[Keys.relayV2CredentialVersion] = newVersion
                updated = true
            }
        }
        return updated
    }

    suspend fun getOrCreateRelayV2ClientInstanceId(): String {
        var resolved = ""
        store.edit { preferences ->
            resolved = preferences[Keys.relayV2InstallClientInstanceId]
                ?.takeIf(String::isNotBlank)
                ?: UUID.randomUUID().toString().also {
                    preferences[Keys.relayV2InstallClientInstanceId] = it
                }
        }
        return resolved
    }

    suspend fun saveProfile(relayUrl: String, hostId: String, autoConnect: Boolean) {
        store.edit { preferences ->
            RelayProfilePreferencesCodec.saveRelayV1Profile(
                preferences = preferences,
                relayUrl = relayUrl,
                hostId = hostId,
                autoConnect = autoConnect,
            )
        }
    }

    suspend fun setPreferredHost(hostId: String) {
        store.edit {
            RelayProfilePreferencesCodec.requireV1MutationAllowed(it)
            it[Keys.hostId] = hostId
        }
    }

    suspend fun setPreferredHostAndScope(hostId: String, scopeId: String) {
        store.edit {
            RelayProfilePreferencesCodec.requireV1MutationAllowed(it)
            it[Keys.hostId] = hostId
            it[Keys.scopeId] = scopeId
        }
    }

    suspend fun setPreferredScope(scopeId: String) {
        store.edit {
            RelayProfilePreferencesCodec.requireV1MutationAllowed(it)
            it[Keys.scopeId] = scopeId
        }
    }

    suspend fun setAutoConnect(enabled: Boolean) {
        store.edit {
            RelayProfilePreferencesCodec.requireV1MutationAllowed(it)
            it[Keys.autoConnect] = enabled
        }
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
            RelayProfilePreferencesCodec.clearRelayV1Profile(preferences)
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

}

enum class NotificationKind {
    WAITING_FOR_USER,
    FAILED,
    COMPLETED,
}

/** Adapter for the Relay v2 domain; [PreferencesStore] remains the single DataStore owner. */
internal class PreferencesRelayV2ProfileStore(
    private val preferencesStore: PreferencesStore,
) : RelayV2ProfileStore {
    override suspend fun activeProfileIdentity(): RelayActiveProfileIdentity? =
        preferencesStore.activeProfileIdentity()

    override suspend fun activeRelayV2Profile(): RelayV2Profile? =
        preferencesStore.activeRelayV2Profile()

    override suspend fun activateRelayV2Profile(
        expectedActiveProfile: RelayActiveProfileIdentity?,
        profile: RelayV2Profile,
        authority: RelayV2ProfileActivationAuthority,
    ): RelayV2Profile? = preferencesStore.activateRelayV2Profile(
        expectedActiveProfile,
        profile,
        authority,
    )

    override suspend fun updateRelayV2CredentialVersion(
        profileId: String,
        credentialReference: RelayV2CredentialReference,
        expectedActivationGeneration: Long,
        expectedVersion: Long,
        newVersion: Long,
    ): Boolean = preferencesStore.updateRelayV2CredentialVersion(
        profileId = profileId,
        credentialReference = credentialReference,
        expectedActivationGeneration = expectedActivationGeneration,
        expectedVersion = expectedVersion,
        newVersion = newVersion,
    )
}
