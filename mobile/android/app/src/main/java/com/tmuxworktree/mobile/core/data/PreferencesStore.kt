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
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2CompletedCredentialProof
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2CredentialReference
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2Profile
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2ProfileActivationJournal
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2ProfileActivationPhase
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2ProfileStore
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2SelfRevokeFailureCode
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2SelfRevokeJournal
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2SelfRevokeJournalStore
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2SelfRevokePhase
import java.util.UUID
import kotlinx.coroutines.flow.Flow
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
    val relayV2ActivationJournalSchemaVersion = intPreferencesKey(
        "relay_v2_activation_journal_schema_version",
    )
    val relayV2ActivationJournalId = stringPreferencesKey("relay_v2_activation_journal_id")
    val relayV2ActivationJournalPhase = stringPreferencesKey("relay_v2_activation_journal_phase")
    val relayV2ActivationPreviousProfileId = stringPreferencesKey(
        "relay_v2_activation_previous_profile_id",
    )
    val relayV2ActivationPreviousDialect = stringPreferencesKey(
        "relay_v2_activation_previous_dialect",
    )
    val relayV2ActivationPreviousGeneration = longPreferencesKey(
        "relay_v2_activation_previous_generation",
    )
    val relayV2ActivationBarrierId = stringPreferencesKey("relay_v2_activation_barrier_id")
    val relayV2ActivationPreviousCredentialReference = stringPreferencesKey(
        "relay_v2_activation_previous_credential_reference",
    )
    val relayV2ActivationTargetProfileId = stringPreferencesKey(
        "relay_v2_activation_target_profile_id",
    )
    val relayV2ActivationTargetCredentialReference = stringPreferencesKey(
        "relay_v2_activation_target_credential_reference",
    )
    val relayV2ActivationTargetCredentialVersion = longPreferencesKey(
        "relay_v2_activation_target_credential_version",
    )
    val relayV2ActivationTargetBindingDigest = stringPreferencesKey(
        "relay_v2_activation_target_binding_digest",
    )
    val relayV2ActivationTargetCredentialAttemptId = stringPreferencesKey(
        "relay_v2_activation_target_credential_attempt_id",
    )
    val relayV2ActivationTargetCredentialSecretReference = stringPreferencesKey(
        "relay_v2_activation_target_credential_secret_reference",
    )
    val relayV2ActivationTargetGeneration = longPreferencesKey(
        "relay_v2_activation_target_generation",
    )
    val relayV2ActiveSwitchOperationId = stringPreferencesKey(
        "relay_v2_active_switch_operation_id",
    )
    val relayV2SelfRevokeSchemaVersion = intPreferencesKey(
        "relay_v2_self_revoke_schema_version",
    )
    val relayV2SelfRevokeOperationId = stringPreferencesKey(
        "relay_v2_self_revoke_operation_id",
    )
    val relayV2SelfRevokeProfileId = stringPreferencesKey(
        "relay_v2_self_revoke_profile_id",
    )
    val relayV2SelfRevokeActivationGeneration = longPreferencesKey(
        "relay_v2_self_revoke_activation_generation",
    )
    val relayV2SelfRevokeCredentialReference = stringPreferencesKey(
        "relay_v2_self_revoke_credential_reference",
    )
    val relayV2SelfRevokeCredentialVersion = longPreferencesKey(
        "relay_v2_self_revoke_credential_version",
    )
    val relayV2SelfRevokeGrantId = stringPreferencesKey(
        "relay_v2_self_revoke_grant_id",
    )
    val relayV2SelfRevokePhase = stringPreferencesKey("relay_v2_self_revoke_phase")
    val relayV2SelfRevokeRevokedAtMs = longPreferencesKey(
        "relay_v2_self_revoke_revoked_at_ms",
    )
    val relayV2SelfRevokeFailureCode = stringPreferencesKey(
        "relay_v2_self_revoke_failure_code",
    )
}

private const val ACTIVATION_JOURNAL_SCHEMA_VERSION = 2
private const val ACTIVATION_PHASE_PREPARED = "prepared"
private const val ACTIVATION_PHASE_CREDENTIAL_READY = "credential_ready"
private const val SELF_REVOKE_JOURNAL_SCHEMA_VERSION = 1
private const val SELF_REVOKE_PHASE_PREPARED = "prepared"
private const val SELF_REVOKE_PHASE_MAY_HAVE_COMMITTED = "may_have_committed"
private const val SELF_REVOKE_PHASE_CONFIRMED = "confirmed"
private const val SELF_REVOKE_PHASE_REJECTED = "rejected"
private const val SELF_REVOKE_FAILURE_FORBIDDEN = "forbidden"

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

    fun dialectStorageTag(dialect: RelayProfileDialect): String = when (dialect) {
        RelayProfileDialect.V1 -> DIALECT_V1_TAG
        RelayProfileDialect.V2 -> DIALECT_V2_TAG
    }

    fun dialectFromStorageTag(tag: String): RelayProfileDialect = when (tag) {
        DIALECT_V1_TAG -> RelayProfileDialect.V1
        DIALECT_V2_TAG -> RelayProfileDialect.V2
        else -> error("Unknown Relay profile dialect tag")
    }

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

    fun removeExactRelayV2Profile(
        preferences: MutablePreferences,
        expected: RelayV2Profile,
    ): Boolean {
        if (toRelayV2Profile(preferences) != expected) return false
        preferences.removeRelayV2Profile()
        preferences.remove(Keys.activeProfileDialect)
        preferences.remove(Keys.activeCredentialKind)
        return true
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

class PreferencesStore internal constructor(
    private val store: DataStore<Preferences>,
) {
    constructor(context: Context) : this(context.applicationContext.twPreferencesDataStore)

    /** Raw authority is reserved for owner-side saga validation and mutation. */
    private val rawData: Flow<Preferences> = store.data

    /** Connection-visible preferences; a fenced profile is never exposed as reconnectable. */
    val values: Flow<AppPreferences> = rawData.map(::toConnectionVisibleAppPreferences)

    val profile: Flow<RelayProfile> = rawData.map { stored ->
        if (activeProfileIsUsable(stored)) {
            toAppPreferences(stored).let { preferences ->
                RelayProfile(
                    relayUrl = preferences.relayUrl,
                    hostId = preferences.preferredHostId,
                    autoConnect = preferences.autoConnect,
                    hasCredential = false,
                )
            }
        } else {
            RelayProfile()
        }
    }

    /** Independent non-sensitive Relay v2 profile namespace. Tokens are not representable here. */
    internal val relayV2Profile: Flow<RelayV2Profile?> =
        rawData.map { preferences ->
            if (activeProfileIsUsable(preferences)) {
                RelayProfilePreferencesCodec.toRelayV2Profile(preferences)
            } else {
                null
            }
        }

    internal suspend fun activeProfileIdentity(): RelayActiveProfileIdentity? {
        val preferences = rawData.first()
        return if (activeProfileIsUsable(preferences)) {
            RelayProfilePreferencesCodec.activeProfileIdentity(preferences)
        } else {
            null
        }
    }

    internal suspend fun activeRelayV2Profile(): RelayV2Profile? = relayV2Profile.first()

    internal suspend fun pendingRelayV2Activation(): RelayV2ProfileActivationJournal? {
        val preferences = rawData.first()
        val activation = activationJournal(preferences)
        check(activation == null || selfRevokeJournal(preferences) == null) {
            "Relay v2 activation and self-revoke journals cannot coexist"
        }
        return activation
    }

    internal suspend fun readSelfRevokeJournal(): RelayV2SelfRevokeJournal? {
        val preferences = rawData.first()
        val journal = selfRevokeJournal(preferences)
        check(journal == null || activationJournal(preferences) == null) {
            "Relay v2 activation and self-revoke journals cannot coexist"
        }
        return journal
    }

    internal suspend fun prepareSelfRevokeJournal(
        expectedActiveProfile: RelayV2Profile,
        operationId: String,
    ): RelayV2SelfRevokeJournal? {
        require(operationId.isNotBlank()) { "Self-revoke operation ID is required" }
        var prepared: RelayV2SelfRevokeJournal? = null
        store.edit { preferences ->
            if (activationJournal(preferences) != null ||
                selfRevokeJournal(preferences) != null
            ) return@edit
            val active = RelayProfilePreferencesCodec.toRelayV2Profile(preferences)
            if (active != expectedActiveProfile) return@edit
            val journal = RelayV2SelfRevokeJournal(
                operationId = operationId,
                profileId = active.profileId,
                activationGeneration = active.activationGeneration,
                credentialReference = active.credentialReference,
                credentialVersion = active.credentialVersion,
                grantId = active.grantId,
                phase = RelayV2SelfRevokePhase.PREPARED,
            )
            writeSelfRevokeJournal(preferences, journal)
            prepared = journal
        }
        return prepared
    }

    internal suspend fun advanceSelfRevokeJournal(
        expected: RelayV2SelfRevokeJournal,
        phase: RelayV2SelfRevokePhase,
        revokedAtMs: Long?,
        failureCode: RelayV2SelfRevokeFailureCode?,
    ): RelayV2SelfRevokeJournal? {
        require(
            (expected.phase == RelayV2SelfRevokePhase.PREPARED &&
                phase == RelayV2SelfRevokePhase.MAY_HAVE_COMMITTED) ||
                (expected.phase == RelayV2SelfRevokePhase.MAY_HAVE_COMMITTED &&
                    phase in setOf(
                        RelayV2SelfRevokePhase.CONFIRMED,
                        RelayV2SelfRevokePhase.REJECTED,
                    ))
        ) { "Self-revoke journal transition is invalid" }
        val replacement = expected.copy(
            phase = phase,
            revokedAtMs = revokedAtMs,
            failureCode = failureCode,
        )
        var updated: RelayV2SelfRevokeJournal? = null
        store.edit { preferences ->
            if (activationJournal(preferences) != null ||
                selfRevokeJournal(preferences) != expected
            ) return@edit
            val active = RelayProfilePreferencesCodec.toRelayV2Profile(preferences)
            if (active == null || !expected.matches(active)) return@edit
            writeSelfRevokeJournal(preferences, replacement)
            updated = replacement
        }
        return updated
    }

    internal suspend fun commitConfirmedSelfRevokeRemoval(
        expected: RelayV2SelfRevokeJournal,
    ): Boolean {
        require(expected.phase == RelayV2SelfRevokePhase.CONFIRMED) {
            "Only a confirmed self-revoke journal can remove its active profile"
        }
        var committed = false
        store.edit { preferences ->
            if (activationJournal(preferences) != null ||
                selfRevokeJournal(preferences) != expected
            ) return@edit
            val active = RelayProfilePreferencesCodec.toRelayV2Profile(preferences)
            if (active == null || !expected.matches(active)) return@edit
            if (!RelayProfilePreferencesCodec.removeExactRelayV2Profile(
                    preferences,
                    active,
                )
            ) return@edit
            clearSelfRevokeJournal(preferences)
            committed = true
        }
        return committed
    }

    internal suspend fun prepareRelayV2Activation(
        expectedActiveProfile: RelayActiveProfileIdentity?,
        operationId: String,
        profile: RelayV2Profile,
        targetBindingDigest: String,
        targetCredentialAttemptId: String,
        targetCredentialSecretReference: String,
        barrierId: String?,
        previousCredentialReference: RelayV2CredentialReference?,
    ): RelayV2ProfileActivationJournal? {
        var prepared: RelayV2ProfileActivationJournal? = null
        store.edit { preferences ->
            if (selfRevokeJournal(preferences) != null) return@edit
            val rawActive = RelayProfilePreferencesCodec.activeProfileIdentity(preferences)
            if (rawActive != expectedActiveProfile) return@edit
            val current = activationJournal(preferences)
            val journal = RelayV2ProfileActivationJournal(
                operationId = operationId,
                previousProfile = rawActive,
                barrierId = barrierId,
                previousCredentialReference = previousCredentialReference,
                targetProfileId = profile.profileId,
                targetCredentialReference = profile.credentialReference,
                targetCredentialVersion = profile.credentialVersion,
                targetBindingDigest = targetBindingDigest,
                targetCredentialAttemptId = targetCredentialAttemptId,
                targetCredentialSecretReference = targetCredentialSecretReference,
                targetActivationGeneration = profile.activationGeneration,
                phase = RelayV2ProfileActivationPhase.PREPARED,
            )
            when {
                current == null -> {
                    writeActivationJournal(preferences, journal)
                    prepared = journal
                }
                current == journal -> prepared = current
                else -> Unit
            }
        }
        return prepared
    }

    internal suspend fun markRelayV2CredentialReady(
        operationId: String,
        proof: RelayV2CompletedCredentialProof,
    ): RelayV2ProfileActivationJournal? = updateActivationJournal(operationId) {
            preferences, journal ->
        if (RelayProfilePreferencesCodec.activeProfileIdentity(preferences) !=
            journal.previousProfile || !journal.targetsCredential(proof)
        ) return@updateActivationJournal null
        when (journal.phase) {
            RelayV2ProfileActivationPhase.PREPARED -> journal.copy(
                targetCredentialVersion = proof.credentialVersion,
                phase = RelayV2ProfileActivationPhase.CREDENTIAL_READY,
            )
            RelayV2ProfileActivationPhase.CREDENTIAL_READY -> when {
                proof.credentialVersion == journal.targetCredentialVersion -> journal
                else -> journal.copy(targetCredentialVersion = proof.credentialVersion)
            }
        }
    }

    internal suspend fun rollbackPreparedRelayV2Activation(
        journal: RelayV2ProfileActivationJournal,
    ): Boolean {
        var rolledBack = false
        store.edit { preferences ->
            if (selfRevokeJournal(preferences) == null &&
                journal.phase == RelayV2ProfileActivationPhase.PREPARED &&
                activationJournal(preferences) == journal &&
                RelayProfilePreferencesCodec.activeProfileIdentity(preferences) ==
                journal.previousProfile
            ) {
                clearActivationJournal(preferences)
                rolledBack = true
            }
        }
        return rolledBack
    }

    internal suspend fun activateRelayV2Profile(
        journal: RelayV2ProfileActivationJournal,
        profile: RelayV2Profile,
    ): RelayV2Profile? {
        var activated: RelayV2Profile? = null
        store.edit { preferences ->
            val currentJournal = activationJournal(preferences)
            if (selfRevokeJournal(preferences) == null &&
                currentJournal == journal &&
                journal.phase == RelayV2ProfileActivationPhase.CREDENTIAL_READY &&
                journal.targets(profile) &&
                RelayProfilePreferencesCodec.activeProfileIdentity(preferences) ==
                journal.previousProfile
            ) {
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
                RelayProfilePreferencesCodec.activateRelayV2Profile(preferences, resolved)
                clearActivationJournal(preferences)
                activated = resolved
            }
        }
        return activated
    }

    private suspend fun updateActivationJournal(
        operationId: String,
        transform: (
            MutablePreferences,
            RelayV2ProfileActivationJournal,
        ) -> RelayV2ProfileActivationJournal?,
    ): RelayV2ProfileActivationJournal? {
        var updated: RelayV2ProfileActivationJournal? = null
        store.edit { preferences ->
            if (selfRevokeJournal(preferences) != null) return@edit
            val current = activationJournal(preferences)
                ?.takeIf { it.operationId == operationId }
                ?: return@edit
            val replacement = transform(preferences, current) ?: return@edit
            writeActivationJournal(preferences, replacement)
            updated = replacement
        }
        return updated
    }

    private fun activationJournal(
        preferences: Preferences,
    ): RelayV2ProfileActivationJournal? {
        val operationId = preferences[Keys.relayV2ActivationJournalId]
        if (operationId == null) {
            check(preferences[Keys.relayV2ActivationJournalSchemaVersion] == null &&
                preferences[Keys.relayV2ActivationJournalPhase] == null &&
                preferences[Keys.relayV2ActivationPreviousProfileId] == null &&
                preferences[Keys.relayV2ActivationPreviousDialect] == null &&
                preferences[Keys.relayV2ActivationPreviousGeneration] == null &&
                preferences[Keys.relayV2ActivationBarrierId] == null &&
                preferences[Keys.relayV2ActivationPreviousCredentialReference] == null &&
                preferences[Keys.relayV2ActivationTargetProfileId] == null &&
                preferences[Keys.relayV2ActivationTargetCredentialReference] == null &&
                preferences[Keys.relayV2ActivationTargetCredentialVersion] == null &&
                preferences[Keys.relayV2ActivationTargetBindingDigest] == null &&
                preferences[Keys.relayV2ActivationTargetCredentialAttemptId] == null &&
                preferences[Keys.relayV2ActivationTargetCredentialSecretReference] == null &&
                preferences[Keys.relayV2ActivationTargetGeneration] == null &&
                preferences[Keys.relayV2ActiveSwitchOperationId] == null
            ) { "Relay v2 activation journal is incomplete" }
            return null
        }
        require(operationId.isNotBlank()) { "Relay v2 activation journal ID is invalid" }
        require(
            preferences[Keys.relayV2ActivationJournalSchemaVersion] ==
                ACTIVATION_JOURNAL_SCHEMA_VERSION,
        ) { "Unsupported Relay v2 activation journal schema" }
        val previousProfileId = preferences[Keys.relayV2ActivationPreviousProfileId]
        val previousDialect = preferences[Keys.relayV2ActivationPreviousDialect]
        val previousGeneration = preferences[Keys.relayV2ActivationPreviousGeneration]
        require(
            listOf(previousProfileId, previousDialect, previousGeneration).all { it == null } ||
                listOf(previousProfileId, previousDialect, previousGeneration).all { it != null },
        ) { "Relay v2 activation previous profile is incomplete" }
        val previous = if (previousProfileId == null) {
            null
        } else {
            RelayActiveProfileIdentity(
                profileId = previousProfileId,
                dialect = RelayProfilePreferencesCodec.dialectFromStorageTag(previousDialect!!),
                activationGeneration = previousGeneration!!,
            )
        }
        val barrierId = preferences[Keys.relayV2ActivationBarrierId]
        require(barrierId == null || previous != null) {
            "Relay v2 activation barrier has no previous profile"
        }
        val phase = when (preferences[Keys.relayV2ActivationJournalPhase]) {
            ACTIVATION_PHASE_PREPARED -> RelayV2ProfileActivationPhase.PREPARED
            ACTIVATION_PHASE_CREDENTIAL_READY ->
                RelayV2ProfileActivationPhase.CREDENTIAL_READY
            else -> error("Unknown Relay v2 activation journal phase")
        }
        val switchingOperationId = preferences[Keys.relayV2ActiveSwitchOperationId]
        require(
            (phase == RelayV2ProfileActivationPhase.PREPARED &&
                switchingOperationId == null) ||
                (phase == RelayV2ProfileActivationPhase.CREDENTIAL_READY &&
                    switchingOperationId == operationId),
        ) { "Relay v2 active usability does not match the activation journal" }
        val previousCredentialReference =
            preferences[Keys.relayV2ActivationPreviousCredentialReference]?.let(
                ::RelayV2CredentialReference,
            )
        require(previousCredentialReference == null || previous != null) {
            "Relay v2 previous credential reference has no profile"
        }
        return RelayV2ProfileActivationJournal(
            operationId = operationId,
            previousProfile = previous,
            barrierId = barrierId,
            previousCredentialReference = previousCredentialReference,
            targetProfileId = requireNotNull(
                preferences[Keys.relayV2ActivationTargetProfileId],
            ),
            targetCredentialReference = RelayV2CredentialReference(
                requireNotNull(
                    preferences[Keys.relayV2ActivationTargetCredentialReference],
                ),
            ),
            targetCredentialVersion = requireNotNull(
                preferences[Keys.relayV2ActivationTargetCredentialVersion],
            ),
            targetBindingDigest = requireNotNull(
                preferences[Keys.relayV2ActivationTargetBindingDigest],
            ),
            targetCredentialAttemptId = requireNotNull(
                preferences[Keys.relayV2ActivationTargetCredentialAttemptId],
            ),
            targetCredentialSecretReference = requireNotNull(
                preferences[Keys.relayV2ActivationTargetCredentialSecretReference],
            ),
            targetActivationGeneration = requireNotNull(
                preferences[Keys.relayV2ActivationTargetGeneration],
            ),
            phase = phase,
        )
    }

    private fun writeActivationJournal(
        preferences: MutablePreferences,
        journal: RelayV2ProfileActivationJournal,
    ) {
        clearActivationJournal(preferences)
        preferences[Keys.relayV2ActivationJournalSchemaVersion] =
            ACTIVATION_JOURNAL_SCHEMA_VERSION
        preferences[Keys.relayV2ActivationJournalId] = journal.operationId
        preferences[Keys.relayV2ActivationJournalPhase] = when (journal.phase) {
            RelayV2ProfileActivationPhase.PREPARED -> ACTIVATION_PHASE_PREPARED
            RelayV2ProfileActivationPhase.CREDENTIAL_READY ->
                ACTIVATION_PHASE_CREDENTIAL_READY
        }
        journal.previousProfile?.let { previous ->
            preferences[Keys.relayV2ActivationPreviousProfileId] = previous.profileId
            preferences[Keys.relayV2ActivationPreviousDialect] =
                RelayProfilePreferencesCodec.dialectStorageTag(previous.dialect)
            preferences[Keys.relayV2ActivationPreviousGeneration] =
                previous.activationGeneration
        }
        journal.barrierId?.let { preferences[Keys.relayV2ActivationBarrierId] = it }
        journal.previousCredentialReference?.let {
            preferences[Keys.relayV2ActivationPreviousCredentialReference] = it.value
        }
        preferences[Keys.relayV2ActivationTargetProfileId] = journal.targetProfileId
        preferences[Keys.relayV2ActivationTargetCredentialReference] =
            journal.targetCredentialReference.value
        preferences[Keys.relayV2ActivationTargetCredentialVersion] =
            journal.targetCredentialVersion
        preferences[Keys.relayV2ActivationTargetBindingDigest] = journal.targetBindingDigest
        preferences[Keys.relayV2ActivationTargetCredentialAttemptId] =
            journal.targetCredentialAttemptId
        preferences[Keys.relayV2ActivationTargetCredentialSecretReference] =
            journal.targetCredentialSecretReference
        preferences[Keys.relayV2ActivationTargetGeneration] =
            journal.targetActivationGeneration
        if (journal.phase != RelayV2ProfileActivationPhase.PREPARED) {
            preferences[Keys.relayV2ActiveSwitchOperationId] = journal.operationId
        }
    }

    private fun clearActivationJournal(preferences: MutablePreferences) {
        preferences.remove(Keys.relayV2ActivationJournalSchemaVersion)
        preferences.remove(Keys.relayV2ActivationJournalId)
        preferences.remove(Keys.relayV2ActivationJournalPhase)
        preferences.remove(Keys.relayV2ActivationPreviousProfileId)
        preferences.remove(Keys.relayV2ActivationPreviousDialect)
        preferences.remove(Keys.relayV2ActivationPreviousGeneration)
        preferences.remove(Keys.relayV2ActivationBarrierId)
        preferences.remove(Keys.relayV2ActivationPreviousCredentialReference)
        preferences.remove(Keys.relayV2ActivationTargetProfileId)
        preferences.remove(Keys.relayV2ActivationTargetCredentialReference)
        preferences.remove(Keys.relayV2ActivationTargetCredentialVersion)
        preferences.remove(Keys.relayV2ActivationTargetBindingDigest)
        preferences.remove(Keys.relayV2ActivationTargetCredentialAttemptId)
        preferences.remove(Keys.relayV2ActivationTargetCredentialSecretReference)
        preferences.remove(Keys.relayV2ActivationTargetGeneration)
        preferences.remove(Keys.relayV2ActiveSwitchOperationId)
    }

    private fun selfRevokeJournal(
        preferences: Preferences,
    ): RelayV2SelfRevokeJournal? {
        val operationId = preferences[Keys.relayV2SelfRevokeOperationId]
        if (operationId == null) {
            check(preferences[Keys.relayV2SelfRevokeSchemaVersion] == null &&
                preferences[Keys.relayV2SelfRevokeProfileId] == null &&
                preferences[Keys.relayV2SelfRevokeActivationGeneration] == null &&
                preferences[Keys.relayV2SelfRevokeCredentialReference] == null &&
                preferences[Keys.relayV2SelfRevokeCredentialVersion] == null &&
                preferences[Keys.relayV2SelfRevokeGrantId] == null &&
                preferences[Keys.relayV2SelfRevokePhase] == null &&
                preferences[Keys.relayV2SelfRevokeRevokedAtMs] == null &&
                preferences[Keys.relayV2SelfRevokeFailureCode] == null
            ) { "Relay v2 self-revoke journal is incomplete" }
            return null
        }
        require(
            preferences[Keys.relayV2SelfRevokeSchemaVersion] ==
                SELF_REVOKE_JOURNAL_SCHEMA_VERSION,
        ) { "Unsupported Relay v2 self-revoke journal schema" }
        check(activationJournal(preferences) == null) {
            "Relay v2 activation and self-revoke journals cannot coexist"
        }
        val phase = when (preferences[Keys.relayV2SelfRevokePhase]) {
            SELF_REVOKE_PHASE_PREPARED -> RelayV2SelfRevokePhase.PREPARED
            SELF_REVOKE_PHASE_MAY_HAVE_COMMITTED ->
                RelayV2SelfRevokePhase.MAY_HAVE_COMMITTED
            SELF_REVOKE_PHASE_CONFIRMED -> RelayV2SelfRevokePhase.CONFIRMED
            SELF_REVOKE_PHASE_REJECTED -> RelayV2SelfRevokePhase.REJECTED
            else -> error("Unknown Relay v2 self-revoke journal phase")
        }
        val journal = RelayV2SelfRevokeJournal(
            operationId = operationId,
            profileId = requireNotNull(preferences[Keys.relayV2SelfRevokeProfileId]) {
                "Relay v2 self-revoke profile ID is missing"
            },
            activationGeneration = requireNotNull(
                preferences[Keys.relayV2SelfRevokeActivationGeneration],
            ) { "Relay v2 self-revoke activation generation is missing" },
            credentialReference = RelayV2CredentialReference(
                requireNotNull(preferences[Keys.relayV2SelfRevokeCredentialReference]) {
                    "Relay v2 self-revoke credential reference is missing"
                },
            ),
            credentialVersion = requireNotNull(
                preferences[Keys.relayV2SelfRevokeCredentialVersion],
            ) { "Relay v2 self-revoke credential version is missing" },
            grantId = requireNotNull(preferences[Keys.relayV2SelfRevokeGrantId]) {
                "Relay v2 self-revoke grant ID is missing"
            },
            phase = phase,
            revokedAtMs = preferences[Keys.relayV2SelfRevokeRevokedAtMs],
            failureCode = when (preferences[Keys.relayV2SelfRevokeFailureCode]) {
                null -> null
                SELF_REVOKE_FAILURE_FORBIDDEN -> RelayV2SelfRevokeFailureCode.FORBIDDEN
                else -> error("Unknown Relay v2 self-revoke failure disposition")
            },
        )
        val active = RelayProfilePreferencesCodec.toRelayV2Profile(preferences)
        check(active != null && journal.matches(active)) {
            "Relay v2 self-revoke journal does not match the active profile"
        }
        return journal
    }

    private fun writeSelfRevokeJournal(
        preferences: MutablePreferences,
        journal: RelayV2SelfRevokeJournal,
    ) {
        clearSelfRevokeJournal(preferences)
        preferences[Keys.relayV2SelfRevokeSchemaVersion] =
            SELF_REVOKE_JOURNAL_SCHEMA_VERSION
        preferences[Keys.relayV2SelfRevokeOperationId] = journal.operationId
        preferences[Keys.relayV2SelfRevokeProfileId] = journal.profileId
        preferences[Keys.relayV2SelfRevokeActivationGeneration] =
            journal.activationGeneration
        preferences[Keys.relayV2SelfRevokeCredentialReference] =
            journal.credentialReference.value
        preferences[Keys.relayV2SelfRevokeCredentialVersion] = journal.credentialVersion
        preferences[Keys.relayV2SelfRevokeGrantId] = journal.grantId
        preferences[Keys.relayV2SelfRevokePhase] = when (journal.phase) {
            RelayV2SelfRevokePhase.PREPARED -> SELF_REVOKE_PHASE_PREPARED
            RelayV2SelfRevokePhase.MAY_HAVE_COMMITTED ->
                SELF_REVOKE_PHASE_MAY_HAVE_COMMITTED
            RelayV2SelfRevokePhase.CONFIRMED -> SELF_REVOKE_PHASE_CONFIRMED
            RelayV2SelfRevokePhase.REJECTED -> SELF_REVOKE_PHASE_REJECTED
        }
        journal.revokedAtMs?.let {
            preferences[Keys.relayV2SelfRevokeRevokedAtMs] = it
        }
        journal.failureCode?.let {
            preferences[Keys.relayV2SelfRevokeFailureCode] = when (it) {
                RelayV2SelfRevokeFailureCode.FORBIDDEN -> SELF_REVOKE_FAILURE_FORBIDDEN
            }
        }
    }

    private fun clearSelfRevokeJournal(preferences: MutablePreferences) {
        preferences.remove(Keys.relayV2SelfRevokeSchemaVersion)
        preferences.remove(Keys.relayV2SelfRevokeOperationId)
        preferences.remove(Keys.relayV2SelfRevokeProfileId)
        preferences.remove(Keys.relayV2SelfRevokeActivationGeneration)
        preferences.remove(Keys.relayV2SelfRevokeCredentialReference)
        preferences.remove(Keys.relayV2SelfRevokeCredentialVersion)
        preferences.remove(Keys.relayV2SelfRevokeGrantId)
        preferences.remove(Keys.relayV2SelfRevokePhase)
        preferences.remove(Keys.relayV2SelfRevokeRevokedAtMs)
        preferences.remove(Keys.relayV2SelfRevokeFailureCode)
    }

    private fun activeProfileIsUsable(preferences: Preferences): Boolean =
        activationJournal(preferences)?.phase?.let {
            it == RelayV2ProfileActivationPhase.PREPARED
        } ?: true

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
            if (selfRevokeJournal(preferences) != null) return@edit
            if (activationJournal(preferences)?.phase?.let {
                    it != RelayV2ProfileActivationPhase.PREPARED
                } == true
            ) return@edit
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

    /**
     * Exact-profile connect consent CAS: flips `autoConnect` to true only when the stored profile
     * still equals [expectedProfile] in every field (including `autoConnect == false`), and
     * returns the consented profile. Any drift — endpoint, host, lineage, or an already-consented
     * profile — leaves the durable value untouched.
     */
    internal suspend fun consentRelayV2AutoConnect(
        expectedProfile: RelayV2Profile,
    ): RelayV2Profile? {
        var consented: RelayV2Profile? = null
        store.edit { preferences ->
            if (selfRevokeJournal(preferences) != null) return@edit
            if (activationJournal(preferences)?.phase?.let {
                    it != RelayV2ProfileActivationPhase.PREPARED
                } == true
            ) return@edit
            val current = RelayProfilePreferencesCodec.toRelayV2Profile(preferences)
            if (current != null && current == expectedProfile && !current.autoConnect) {
                preferences[Keys.relayV2AutoConnect] = true
                consented = current.copy(autoConnect = true)
            }
        }
        return consented
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
            requireNoRelayV2Activation(preferences)
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
            requireNoRelayV2Activation(it)
            RelayProfilePreferencesCodec.requireV1MutationAllowed(it)
            it[Keys.hostId] = hostId
        }
    }

    suspend fun setPreferredHostAndScope(hostId: String, scopeId: String) {
        store.edit {
            requireNoRelayV2Activation(it)
            RelayProfilePreferencesCodec.requireV1MutationAllowed(it)
            it[Keys.hostId] = hostId
            it[Keys.scopeId] = scopeId
        }
    }

    suspend fun setPreferredScope(scopeId: String) {
        store.edit {
            requireNoRelayV2Activation(it)
            RelayProfilePreferencesCodec.requireV1MutationAllowed(it)
            it[Keys.scopeId] = scopeId
        }
    }

    suspend fun setAutoConnect(enabled: Boolean) {
        store.edit {
            requireNoRelayV2Activation(it)
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
            requireNoRelayV2Activation(preferences)
            RelayProfilePreferencesCodec.clearRelayV1Profile(preferences)
        }
    }

    private fun requireNoRelayV2Activation(preferences: Preferences) {
        check(activationJournal(preferences) == null) {
            "Relay profile is immutable while Relay v2 activation is pending"
        }
        check(selfRevokeJournal(preferences) == null) {
            "Relay profile is immutable while Relay v2 self-revoke is pending"
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

    private fun toConnectionVisibleAppPreferences(
        preferences: Preferences,
    ): AppPreferences = toAppPreferences(preferences).let { stored ->
        if (activeProfileIsUsable(preferences)) {
            stored
        } else {
            stored.copy(
                relayUrl = "",
                preferredHostId = "",
                preferredScopeId = "local",
                autoConnect = false,
            )
        }
    }

}

enum class NotificationKind {
    WAITING_FOR_USER,
    FAILED,
    COMPLETED,
}

/** Adapter for the Relay v2 domain; [PreferencesStore] remains the single DataStore owner. */
internal class PreferencesRelayV2ProfileStore(
    private val preferencesStore: PreferencesStore,
) : RelayV2ProfileStore, RelayV2SelfRevokeJournalStore {
    override suspend fun activeProfileIdentity(): RelayActiveProfileIdentity? =
        preferencesStore.activeProfileIdentity()

    override suspend fun activeRelayV2Profile(): RelayV2Profile? =
        preferencesStore.activeRelayV2Profile()

    override suspend fun pendingRelayV2Activation(): RelayV2ProfileActivationJournal? =
        preferencesStore.pendingRelayV2Activation()

    override suspend fun readSelfRevokeJournal(): RelayV2SelfRevokeJournal? =
        preferencesStore.readSelfRevokeJournal()

    override suspend fun prepareSelfRevokeJournal(
        expectedActiveProfile: RelayV2Profile,
        operationId: String,
    ): RelayV2SelfRevokeJournal? = preferencesStore.prepareSelfRevokeJournal(
        expectedActiveProfile,
        operationId,
    )

    override suspend fun advanceSelfRevokeJournal(
        expected: RelayV2SelfRevokeJournal,
        phase: RelayV2SelfRevokePhase,
        revokedAtMs: Long?,
        failureCode: RelayV2SelfRevokeFailureCode?,
    ): RelayV2SelfRevokeJournal? = preferencesStore.advanceSelfRevokeJournal(
        expected,
        phase,
        revokedAtMs,
        failureCode,
    )

    override suspend fun commitConfirmedSelfRevokeRemoval(
        expected: RelayV2SelfRevokeJournal,
    ): Boolean = preferencesStore.commitConfirmedSelfRevokeRemoval(expected)

    override suspend fun prepareRelayV2Activation(
        expectedActiveProfile: RelayActiveProfileIdentity?,
        operationId: String,
        profile: RelayV2Profile,
        targetBindingDigest: String,
        targetCredentialAttemptId: String,
        targetCredentialSecretReference: String,
        barrierId: String?,
        previousCredentialReference: RelayV2CredentialReference?,
    ): RelayV2ProfileActivationJournal? = preferencesStore.prepareRelayV2Activation(
        expectedActiveProfile,
        operationId,
        profile,
        targetBindingDigest,
        targetCredentialAttemptId,
        targetCredentialSecretReference,
        barrierId,
        previousCredentialReference,
    )

    override suspend fun markRelayV2CredentialReady(
        operationId: String,
        proof: RelayV2CompletedCredentialProof,
    ): RelayV2ProfileActivationJournal? = preferencesStore.markRelayV2CredentialReady(
        operationId,
        proof,
    )

    override suspend fun rollbackPreparedRelayV2Activation(
        journal: RelayV2ProfileActivationJournal,
    ): Boolean = preferencesStore.rollbackPreparedRelayV2Activation(journal)

    override suspend fun activateRelayV2Profile(
        journal: RelayV2ProfileActivationJournal,
        profile: RelayV2Profile,
    ): RelayV2Profile? = preferencesStore.activateRelayV2Profile(
        journal,
        profile,
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

    override suspend fun consentRelayV2AutoConnect(
        expectedProfile: RelayV2Profile,
    ): RelayV2Profile? = preferencesStore.consentRelayV2AutoConnect(expectedProfile)
}
