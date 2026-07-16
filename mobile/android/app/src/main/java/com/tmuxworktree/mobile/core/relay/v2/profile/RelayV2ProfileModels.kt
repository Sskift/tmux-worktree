package com.tmuxworktree.mobile.core.relay.v2.profile

internal enum class RelayProfileDialect {
    V1,
    V2,
}

internal enum class RelayV2CredentialKind {
    TW_CAP2_GRANT,
}

internal data class RelayActiveProfileIdentity(
    val profileId: String,
    val dialect: RelayProfileDialect,
    val activationGeneration: Long,
)

/** Non-sensitive metadata. This is the only v2 profile shape allowed into DataStore. */
internal data class RelayV2Profile(
    val profileId: String,
    val issuerUrl: String,
    val relayUrl: String,
    val hostId: String,
    val principalId: String,
    val grantId: String,
    val clientInstanceId: String,
    val credentialReference: RelayV2CredentialReference,
    val credentialVersion: Long,
    val activationGeneration: Long = 0,
    val autoConnect: Boolean = false,
) {
    val credentialKind: RelayV2CredentialKind = RelayV2CredentialKind.TW_CAP2_GRANT
    val offeredSubprotocol: String = RELAY_V2_SUBPROTOCOL

    init {
        require(profileId.isNotBlank()) { "Profile ID is required" }
        require(RelayV2EndpointValidator.isIssuerUrl(issuerUrl)) {
            "Relay v2 issuer endpoint is invalid"
        }
        require(RelayV2EndpointValidator.isRelayUrl(relayUrl)) {
            "Relay v2 profile must use the WSS v2 client endpoint"
        }
        require(hostId.isNotBlank()) { "Host ID is required" }
        require(principalId.isNotBlank()) { "Principal ID is required" }
        require(grantId.isNotBlank()) { "Grant ID is required" }
        require(clientInstanceId.isNotBlank()) { "Client instance ID is required" }
        require(credentialVersion > 0) { "Credential version must be positive" }
        require(activationGeneration >= 0) { "Activation generation cannot be negative" }
    }

    val identity: RelayActiveProfileIdentity
        get() = RelayActiveProfileIdentity(
            profileId = profileId,
            dialect = RelayProfileDialect.V2,
            activationGeneration = activationGeneration,
        )

    companion object {
        const val SCHEMA_VERSION = 1
        const val RELAY_V2_SUBPROTOCOL = "tw-relay.v2"
    }
}

@JvmInline
internal value class RelayV2CredentialReference(val value: String) {
    init {
        require(REFERENCE_PATTERN.matches(value)) { "Invalid credential reference" }
    }

    override fun toString(): String = value

    private companion object {
        val REFERENCE_PATTERN = Regex("[A-Za-z0-9._-]{1,128}")
    }
}

internal enum class RelayV2CredentialAttemptKind {
    ENROLLMENT_EXCHANGE,
    REFRESH,
}

/** This entire object is serialized only inside the Keystore-protected credential blob. */
internal data class RelayV2PendingCredentialAttempt(
    val kind: RelayV2CredentialAttemptKind,
    val attemptId: String,
    val oldCredentialVersion: Long,
    val secretReference: String,
    val secret: String,
    val enrollmentId: String? = null,
    val deviceLabel: String? = null,
) {
    init {
        require(attemptId.isNotBlank()) { "Attempt ID is required" }
        require(oldCredentialVersion >= 0) { "Old credential version cannot be negative" }
        require(secretReference.isNotBlank()) { "Secret reference is required" }
        require(secret.isNotBlank()) { "Pending credential secret is required" }
        when (kind) {
            RelayV2CredentialAttemptKind.ENROLLMENT_EXCHANGE -> {
                require(!enrollmentId.isNullOrBlank()) { "Enrollment ID is required" }
            }
            RelayV2CredentialAttemptKind.REFRESH -> {
                require(enrollmentId == null && deviceLabel == null) {
                    "Refresh attempts cannot contain enrollment fields"
                }
            }
        }
    }

    override fun toString(): String =
        "RelayV2PendingCredentialAttempt(kind=$kind, attemptId=$attemptId, " +
            "oldCredentialVersion=$oldCredentialVersion, secretReference=$secretReference, " +
            "secret=<redacted>, enrollmentId=$enrollmentId, deviceLabel=$deviceLabel)"
}

/**
 * Atomic secure-storage unit for Relay v2 credentials.
 *
 * Access/refresh/enrollment secrets never have a corresponding Room or DataStore model.
 */
internal data class RelayV2CredentialBlob(
    val schemaVersion: Int = SCHEMA_VERSION,
    val credentialVersion: Long,
    val issuerUrl: String,
    val relayUrl: String,
    val hostId: String,
    val clientInstanceId: String,
    val principalId: String? = null,
    val grantId: String? = null,
    val accessToken: String? = null,
    val accessExpiresAtMs: Long? = null,
    val refreshToken: String? = null,
    val refreshExpiresAtMs: Long? = null,
    val pendingAttempt: RelayV2PendingCredentialAttempt? = null,
) {
    init {
        require(schemaVersion == SCHEMA_VERSION) { "Unsupported credential schema" }
        require(credentialVersion >= 0) { "Credential version cannot be negative" }
        require(RelayV2EndpointValidator.isIssuerUrl(issuerUrl)) {
            "Relay v2 issuer endpoint is invalid"
        }
        require(RelayV2EndpointValidator.isRelayUrl(relayUrl)) {
            "Relay v2 credential must use the WSS v2 client endpoint"
        }
        require(hostId.isNotBlank() && clientInstanceId.isNotBlank()) {
            "Credential binding is incomplete"
        }
        require(pendingAttempt?.oldCredentialVersion == null ||
            pendingAttempt.oldCredentialVersion == credentialVersion
        ) { "Pending attempt version does not match the credential" }

        val completedFields = listOf(
            principalId,
            grantId,
            accessToken,
            accessExpiresAtMs,
            refreshToken,
            refreshExpiresAtMs,
        )
        require(completedFields.all { it == null } || completedFields.all { it != null }) {
            "Credential material must be absent or complete"
        }
        if (hasCredentialMaterial) {
            require(credentialVersion > 0) { "Completed credentials require a positive version" }
            require(RelayV2CredentialSecretValidator.isAccessToken(accessToken!!)) {
                "Relay v2 access credential is invalid"
            }
            require(RelayV2CredentialSecretValidator.isRefreshToken(refreshToken!!)) {
                "Relay v2 refresh credential is invalid"
            }
            require(accessExpiresAtMs!! >= 0 && refreshExpiresAtMs!! >= 0) {
                "Credential expiry cannot be negative"
            }
        }
        if (pendingAttempt?.kind == RelayV2CredentialAttemptKind.REFRESH) {
            require(hasCredentialMaterial) { "Refresh requires an existing credential" }
            require(pendingAttempt.secret == refreshToken) {
                "Refresh attempt must retain the credential version's refresh secret"
            }
        }
    }

    val hasCredentialMaterial: Boolean
        get() = accessToken != null

    override fun toString(): String =
        "RelayV2CredentialBlob(schemaVersion=$schemaVersion, credentialVersion=$credentialVersion, " +
            "issuerUrl=$issuerUrl, relayUrl=$relayUrl, hostId=$hostId, " +
            "clientInstanceId=$clientInstanceId, principalId=$principalId, grantId=$grantId, " +
            "accessToken=<redacted>, accessExpiresAtMs=$accessExpiresAtMs, " +
            "refreshToken=<redacted>, refreshExpiresAtMs=$refreshExpiresAtMs, " +
            "pendingAttempt=$pendingAttempt)"

    companion object {
        const val SCHEMA_VERSION = 1
    }
}

internal object RelayV2CredentialSecretValidator {
    fun isAccessToken(value: String): Boolean = isSafeSecret(value, "twcap2.")

    fun isRefreshToken(value: String): Boolean = isSafeSecret(value, "twref2.")

    private fun isSafeSecret(value: String, prefix: String): Boolean =
        value.startsWith(prefix) && value.length <= MAX_SECRET_BYTES &&
            value.all { it.code in VISIBLE_ASCII_RANGE }

    private const val MAX_SECRET_BYTES = 8_192
    private val VISIBLE_ASCII_RANGE = 0x21..0x7e
}

internal data class RelayV2CredentialCasExpectation(
    val credentialVersion: Long,
    val pendingAttemptId: String?,
    val pendingSecretReference: String?,
)

internal sealed interface RelayV2CredentialCasResult {
    data class Updated(val credentialVersion: Long) : RelayV2CredentialCasResult
    data class Stale(val currentCredentialVersion: Long?) : RelayV2CredentialCasResult
}

internal interface RelayV2CredentialStore {
    fun read(reference: RelayV2CredentialReference): RelayV2CredentialBlob?

    /** Creates a new isolated blob and never overwrites an existing credential reference. */
    fun create(reference: RelayV2CredentialReference, blob: RelayV2CredentialBlob): Boolean

    /** Atomically compares version and pending-attempt identity before replacing the whole blob. */
    fun compareAndSet(
        reference: RelayV2CredentialReference,
        expectation: RelayV2CredentialCasExpectation,
        replacement: RelayV2CredentialBlob,
    ): RelayV2CredentialCasResult

    fun clear(reference: RelayV2CredentialReference)
}

internal interface RelayV2ProfileStore {
    suspend fun activeProfileIdentity(): RelayActiveProfileIdentity?
    suspend fun activeRelayV2Profile(): RelayV2Profile?

    /** Atomically activates [profile] only while the exact previous identity is still active. */
    suspend fun activateRelayV2Profile(
        expectedActiveProfile: RelayActiveProfileIdentity?,
        profile: RelayV2Profile,
    ): Boolean

    suspend fun updateRelayV2CredentialVersion(
        profileId: String,
        credentialReference: RelayV2CredentialReference,
        expectedActivationGeneration: Long,
        expectedVersion: Long,
        newVersion: Long,
    ): Boolean
}

internal interface RelayProfileDisconnectBarrier {
    suspend fun disconnectAndDrain(
        profile: RelayActiveProfileIdentity,
        barrierId: String,
    ): RelayProfileDisconnectReceipt
}

internal data class RelayProfileDisconnectReceipt(
    val profile: RelayActiveProfileIdentity,
    val barrierId: String,
)

/** Clears the old profile's Room cache, Outbox, drafts, terminal queue, and credential. */
internal fun interface RelayProfileIsolationBoundary {
    suspend fun clearAfterDisconnect(receipt: RelayProfileDisconnectReceipt)
}

internal data class RelayV2EnrollmentExchangeRequest(
    val issuerUrl: String,
    val exchangeAttemptId: String,
    val enrollmentId: String,
    val enrollmentCode: String,
    val clientInstanceId: String,
    val deviceLabel: String?,
) {
    init {
        require(RelayV2EndpointValidator.isIssuerUrl(issuerUrl)) {
            "Relay v2 issuer endpoint is invalid"
        }
    }

    override fun toString(): String =
        "RelayV2EnrollmentExchangeRequest(issuerUrl=$issuerUrl, " +
            "exchangeAttemptId=$exchangeAttemptId, " +
            "enrollmentId=$enrollmentId, enrollmentCode=<redacted>, " +
            "clientInstanceId=$clientInstanceId, deviceLabel=$deviceLabel)"
}

internal data class RelayV2EnrollmentExchangeResponse(
    val exchangeAttemptId: String,
    val principalId: String,
    val grantId: String,
    val hostId: String,
    val relayUrl: String,
    val accessToken: String,
    val accessExpiresAtMs: Long,
    val refreshToken: String,
    val refreshExpiresAtMs: Long,
) {
    override fun toString(): String =
        "RelayV2EnrollmentExchangeResponse(exchangeAttemptId=$exchangeAttemptId, " +
            "principalId=$principalId, grantId=$grantId, hostId=$hostId, relayUrl=$relayUrl, " +
            "accessToken=<redacted>, accessExpiresAtMs=$accessExpiresAtMs, " +
            "refreshToken=<redacted>, refreshExpiresAtMs=$refreshExpiresAtMs)"
}

internal data class RelayV2RefreshRequest(
    val issuerUrl: String,
    val refreshAttemptId: String,
    val grantId: String,
    val clientInstanceId: String,
    val refreshToken: String,
) {
    init {
        require(RelayV2EndpointValidator.isIssuerUrl(issuerUrl)) {
            "Relay v2 issuer endpoint is invalid"
        }
    }

    override fun toString(): String =
        "RelayV2RefreshRequest(issuerUrl=$issuerUrl, refreshAttemptId=$refreshAttemptId, " +
            "grantId=$grantId, " +
            "clientInstanceId=$clientInstanceId, refreshToken=<redacted>)"
}

internal data class RelayV2RefreshResponse(
    val refreshAttemptId: String,
    val principalId: String,
    val grantId: String,
    val hostId: String,
    val relayUrl: String,
    val accessToken: String,
    val accessExpiresAtMs: Long,
    val refreshToken: String,
    val refreshExpiresAtMs: Long,
) {
    override fun toString(): String =
        "RelayV2RefreshResponse(refreshAttemptId=$refreshAttemptId, principalId=$principalId, " +
            "grantId=$grantId, hostId=$hostId, relayUrl=$relayUrl, accessToken=<redacted>, " +
            "accessExpiresAtMs=$accessExpiresAtMs, refreshToken=<redacted>, " +
            "refreshExpiresAtMs=$refreshExpiresAtMs)"
}

/** Exchange seam; the OkHttp implementation remains outside production composition. */
internal interface RelayV2CredentialExchange {
    suspend fun redeem(request: RelayV2EnrollmentExchangeRequest): RelayV2EnrollmentExchangeResponse
    suspend fun refresh(request: RelayV2RefreshRequest): RelayV2RefreshResponse
}

internal fun RelayV2Profile.matchesCredentialBinding(blob: RelayV2CredentialBlob): Boolean =
    blob.hasCredentialMaterial &&
        issuerUrl == blob.issuerUrl &&
        relayUrl == blob.relayUrl &&
        hostId == blob.hostId &&
        principalId == blob.principalId &&
        grantId == blob.grantId &&
        clientInstanceId == blob.clientInstanceId
