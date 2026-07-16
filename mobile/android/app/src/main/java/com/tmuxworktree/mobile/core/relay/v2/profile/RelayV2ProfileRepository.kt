package com.tmuxworktree.mobile.core.relay.v2.profile

import java.security.MessageDigest
import java.util.Base64
import java.util.UUID
import kotlin.math.max
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

internal sealed interface RelayV2ProfileSwitchState {
    data object Idle : RelayV2ProfileSwitchState
    data class Draining(
        val previous: RelayActiveProfileIdentity,
        val barrierId: String,
    ) : RelayV2ProfileSwitchState
    data class Isolating(val receipt: RelayProfileDisconnectReceipt) : RelayV2ProfileSwitchState
    data class Activating(val targetProfileId: String) : RelayV2ProfileSwitchState
    data class Active(val identity: RelayActiveProfileIdentity) : RelayV2ProfileSwitchState
}

internal data class RelayProfileCallbackScope(
    val profileId: String,
    val activationGeneration: Long,
)

/** Serializes profile replacement and fences callbacks from the disconnected identity. */
internal class RelayV2ProfileSwitchStateMachine(
    private val profileStore: RelayV2ProfileStore,
    private val disconnectBarrier: RelayProfileDisconnectBarrier,
    private val isolationBoundary: RelayProfileIsolationBoundary,
    private val newId: () -> String = { UUID.randomUUID().toString() },
) {
    private val mutex = Mutex()

    @Volatile
    var state: RelayV2ProfileSwitchState = RelayV2ProfileSwitchState.Idle
        private set

    suspend fun switchTo(
        profile: RelayV2Profile,
        expectedPrevious: RelayActiveProfileIdentity?,
        authorizeActivation: () -> Boolean,
    ): RelayV2Profile? = mutex.withLock {
        val previous = profileStore.activeProfileIdentity()
        if (previous != expectedPrevious || !authorizeActivation()) {
            return@withLock null
        }
        val previousV2 = profileStore.activeRelayV2Profile()
        if (previousV2 != null &&
            previousV2.profileId == profile.profileId &&
            previousV2.credentialReference == profile.credentialReference
        ) {
            require(previousV2.issuerUrl == profile.issuerUrl &&
                previousV2.relayUrl == profile.relayUrl &&
                previousV2.hostId == profile.hostId &&
                previousV2.principalId == profile.principalId &&
                previousV2.grantId == profile.grantId &&
                previousV2.clientInstanceId == profile.clientInstanceId
            ) { "Active Relay v2 profile binding conflicts with the target" }
            val restored = if (profile.credentialVersion > previousV2.credentialVersion) {
                val updated = profileStore.updateRelayV2CredentialVersion(
                    profileId = previousV2.profileId,
                    credentialReference = previousV2.credentialReference,
                    expectedActivationGeneration = previousV2.activationGeneration,
                    expectedVersion = previousV2.credentialVersion,
                    newVersion = profile.credentialVersion,
                )
                if (updated) previousV2.copy(credentialVersion = profile.credentialVersion) else {
                    val concurrent = profileStore.activeRelayV2Profile()
                        ?: error("Active Relay v2 profile disappeared during reconciliation")
                    require(concurrent.profileId == profile.profileId &&
                        concurrent.credentialReference == profile.credentialReference &&
                        concurrent.activationGeneration == previousV2.activationGeneration &&
                        concurrent.issuerUrl == profile.issuerUrl &&
                        concurrent.relayUrl == profile.relayUrl &&
                        concurrent.hostId == profile.hostId &&
                        concurrent.principalId == profile.principalId &&
                        concurrent.grantId == profile.grantId &&
                        concurrent.clientInstanceId == profile.clientInstanceId
                    ) { "Active Relay v2 profile changed during reconciliation" }
                    check(concurrent.credentialVersion >= profile.credentialVersion) {
                        "Active Relay v2 credential version did not reach the target"
                    }
                    concurrent
                }
            } else {
                previousV2
            }
            // Re-confirming the exact target is a recovery/no-op path. It must not invoke the
            // isolation boundary because that boundary owns deletion of the previous credential.
            state = RelayV2ProfileSwitchState.Active(restored.identity)
            return@withLock restored
        }
        val nextGeneration = max(
            previous?.activationGeneration ?: 0,
            (state as? RelayV2ProfileSwitchState.Active)?.identity?.activationGeneration ?: 0,
        ) + 1
        val activated = profile.copy(activationGeneration = nextGeneration)

        if (previous != null) {
            val barrierId = "profile-v2-${newId()}"
            state = RelayV2ProfileSwitchState.Draining(previous, barrierId)
            val receipt = disconnectBarrier.disconnectAndDrain(previous, barrierId)
            check(receipt.profile == previous && receipt.barrierId == barrierId) {
                "Disconnect barrier did not drain the expected profile"
            }
            state = RelayV2ProfileSwitchState.Isolating(receipt)
            isolationBoundary.clearAfterDisconnect(receipt)
        }

        state = RelayV2ProfileSwitchState.Activating(activated.profileId)
        if (!profileStore.activateRelayV2Profile(previous, activated)) {
            state = RelayV2ProfileSwitchState.Idle
            return@withLock null
        }
        state = RelayV2ProfileSwitchState.Active(activated.identity)
        activated
    }

    fun accepts(callback: RelayProfileCallbackScope): Boolean {
        val active = (state as? RelayV2ProfileSwitchState.Active)?.identity ?: return false
        return callback.profileId == active.profileId &&
            callback.activationGeneration == active.activationGeneration
    }
}

internal sealed interface RelayV2EnrollmentResult {
    data class Activated(val profile: RelayV2Profile) : RelayV2EnrollmentResult
    data class StaleCredentialResponse(val currentCredentialVersion: Long?) : RelayV2EnrollmentResult
    data class Superseded(val activeProfile: RelayActiveProfileIdentity?) : RelayV2EnrollmentResult
}

internal data class RelayV2PreparedRefresh(
    val profileIdentity: RelayActiveProfileIdentity,
    val credentialReference: RelayV2CredentialReference,
    val expectation: RelayV2CredentialCasExpectation,
    val request: RelayV2RefreshRequest,
) {
    override fun toString(): String =
        "RelayV2PreparedRefresh(profileIdentity=$profileIdentity, " +
            "credentialReference=$credentialReference, expectation=$expectation, request=$request)"
}

internal enum class RelayV2CredentialReconciliationFailure {
    CREDENTIAL_MISSING,
    BINDING_MISMATCH,
    CREDENTIAL_BLOB_BEHIND_PROFILE,
    PROFILE_VERSION_UPDATE_REJECTED,
}

internal sealed interface RelayV2CredentialReconciliationResult {
    data object NoActiveV2Profile : RelayV2CredentialReconciliationResult

    data class InSync(val profile: RelayV2Profile) : RelayV2CredentialReconciliationResult

    data class Repaired(val profile: RelayV2Profile) : RelayV2CredentialReconciliationResult

    data class ActiveProfileChanged(
        val expectedProfile: RelayActiveProfileIdentity,
        val activeProfile: RelayActiveProfileIdentity?,
    ) : RelayV2CredentialReconciliationResult

    data class Failed(
        val profileId: String,
        val credentialReference: RelayV2CredentialReference,
        val failure: RelayV2CredentialReconciliationFailure,
        val profileCredentialVersion: Long,
        val blobCredentialVersion: Long?,
    ) : RelayV2CredentialReconciliationResult
}

/**
 * Recovery seam for startup and post-refresh reconciliation.
 *
 * Secure credential storage is authoritative for credential material. DataStore may only catch up
 * monotonically for the same active profile/reference/binding; this class never activates a
 * profile, so a late response cannot resurrect an identity that has already been switched out.
 */
internal class RelayV2ProfileCredentialReconciler(
    private val profileStore: RelayV2ProfileStore,
    private val credentialStore: RelayV2CredentialStore,
) {
    suspend fun reconcileActive(): RelayV2CredentialReconciliationResult {
        val active = profileStore.activeRelayV2Profile()
            ?: return RelayV2CredentialReconciliationResult.NoActiveV2Profile
        return reconcile(active)
    }

    suspend fun reconcileExpected(
        profileIdentity: RelayActiveProfileIdentity,
        credentialReference: RelayV2CredentialReference,
    ): RelayV2CredentialReconciliationResult {
        val active = profileStore.activeRelayV2Profile()
        if (active == null ||
            active.identity != profileIdentity ||
            active.credentialReference != credentialReference
        ) {
            return RelayV2CredentialReconciliationResult.ActiveProfileChanged(
                expectedProfile = profileIdentity,
                activeProfile = profileStore.activeProfileIdentity(),
            )
        }
        return reconcile(active)
    }

    private suspend fun reconcile(
        profile: RelayV2Profile,
    ): RelayV2CredentialReconciliationResult {
        val blob = credentialStore.read(profile.credentialReference)
            ?: return profile.failed(
                RelayV2CredentialReconciliationFailure.CREDENTIAL_MISSING,
                blobCredentialVersion = null,
            )
        if (!profile.matchesCredentialBinding(blob)) {
            return profile.failed(
                RelayV2CredentialReconciliationFailure.BINDING_MISMATCH,
                blob.credentialVersion,
            )
        }
        if (blob.credentialVersion < profile.credentialVersion) {
            return profile.failed(
                RelayV2CredentialReconciliationFailure.CREDENTIAL_BLOB_BEHIND_PROFILE,
                blob.credentialVersion,
            )
        }
        if (blob.credentialVersion == profile.credentialVersion) {
            return RelayV2CredentialReconciliationResult.InSync(profile)
        }

        val updated = profileStore.updateRelayV2CredentialVersion(
            profileId = profile.profileId,
            credentialReference = profile.credentialReference,
            expectedActivationGeneration = profile.activationGeneration,
            expectedVersion = profile.credentialVersion,
            newVersion = blob.credentialVersion,
        )
        if (updated) {
            return RelayV2CredentialReconciliationResult.Repaired(
                profile.copy(credentialVersion = blob.credentialVersion),
            )
        }

        val concurrent = profileStore.activeRelayV2Profile()
        if (concurrent == null ||
            concurrent.identity != profile.identity ||
            concurrent.credentialReference != profile.credentialReference
        ) {
            return RelayV2CredentialReconciliationResult.ActiveProfileChanged(
                expectedProfile = profile.identity,
                activeProfile = profileStore.activeProfileIdentity(),
            )
        }
        if (!concurrent.matchesCredentialBinding(blob)) {
            return concurrent.failed(
                RelayV2CredentialReconciliationFailure.BINDING_MISMATCH,
                blob.credentialVersion,
            )
        }
        return when {
            concurrent.credentialVersion == blob.credentialVersion ->
                RelayV2CredentialReconciliationResult.InSync(concurrent)
            concurrent.credentialVersion > blob.credentialVersion -> concurrent.failed(
                RelayV2CredentialReconciliationFailure.CREDENTIAL_BLOB_BEHIND_PROFILE,
                blob.credentialVersion,
            )
            else -> concurrent.failed(
                RelayV2CredentialReconciliationFailure.PROFILE_VERSION_UPDATE_REJECTED,
                blob.credentialVersion,
            )
        }
    }

    private fun RelayV2Profile.failed(
        failure: RelayV2CredentialReconciliationFailure,
        blobCredentialVersion: Long?,
    ): RelayV2CredentialReconciliationResult.Failed =
        RelayV2CredentialReconciliationResult.Failed(
            profileId = profileId,
            credentialReference = credentialReference,
            failure = failure,
            profileCredentialVersion = credentialVersion,
            blobCredentialVersion = blobCredentialVersion,
        )
}

internal sealed interface RelayV2RefreshApplyResult {
    data class Applied(
        val credentialVersion: Long,
        val repairedProfileVersion: Boolean,
    ) : RelayV2RefreshApplyResult

    data class StaleCredentialResponse(
        val currentCredentialVersion: Long?,
    ) : RelayV2RefreshApplyResult

    data class ActiveProfileChanged(
        val credentialVersion: Long?,
        val activeProfile: RelayActiveProfileIdentity?,
    ) : RelayV2RefreshApplyResult

    data class ProfileReconciliationFailed(
        val credentialVersion: Long,
        val failure: RelayV2CredentialReconciliationResult.Failed,
    ) : RelayV2RefreshApplyResult
}

/**
 * Canonical owner for the first Relay v2 profile/credential slice.
 *
 * The injected [exchange] is not selected by production composition. Parsing a QR never reaches
 * this repository; callers must explicitly create [RelayV2ConfirmedEnrollment].
 */
internal class RelayV2ProfileRepository(
    private val credentialStore: RelayV2CredentialStore,
    private val profileStore: RelayV2ProfileStore,
    private val profileSwitch: RelayV2ProfileSwitchStateMachine,
    private val exchange: RelayV2CredentialExchange,
    private val clientInstanceId: String,
    private val newId: () -> String = { UUID.randomUUID().toString() },
    private val credentialReconciler: RelayV2ProfileCredentialReconciler =
        RelayV2ProfileCredentialReconciler(profileStore, credentialStore),
) {
    // The secure blob remains the durable attempt owner. This only linearizes live user
    // confirmations: the same reference joins its existing intent; a different reference fences it.
    private val enrollmentIntentLock = Any()
    private var currentEnrollmentIntent: EnrollmentIntent? = null

    init {
        require(clientInstanceId.isNotBlank()) { "Client instance ID is required" }
    }

    suspend fun confirmEnrollment(
        confirmed: RelayV2ConfirmedEnrollment,
    ): RelayV2EnrollmentResult {
        val prepared = prepareEnrollment(confirmed)
        val intent = registerEnrollmentIntent(
            credentialReference = prepared.credentialReference,
            expectedActiveProfile = profileStore.activeProfileIdentity(),
        )
        val blob = when (prepared) {
            is PreparedEnrollment.Completed -> prepared.blob
            is PreparedEnrollment.Pending -> {
                val response = exchange.redeem(prepared.request)
                enrollmentIntentResult(intent)?.let { return it }
                if (profileStore.activeProfileIdentity() != intent.expectedActiveProfile) {
                    retireEnrollmentIntent(intent)
                    return supersededEnrollment()
                }
                when (val applied = applyEnrollmentResponse(prepared, response)) {
                    is RelayV2CredentialCasResult.Stale -> {
                        enrollmentIntentResult(intent)?.let { return it }
                        return RelayV2EnrollmentResult.StaleCredentialResponse(
                            applied.currentCredentialVersion,
                        )
                    }
                    is RelayV2CredentialCasResult.Updated -> {
                        credentialStore.read(prepared.credentialReference)
                            ?: error("Credential disappeared after enrollment exchange")
                    }
                }
            }
        }
        enrollmentIntentResult(intent)?.let { return it }
        if (profileStore.activeProfileIdentity() != intent.expectedActiveProfile) {
            retireEnrollmentIntent(intent)
            return supersededEnrollment()
        }
        val profile = profileFromCredential(prepared.credentialReference, blob)
        val activated = profileSwitch.switchTo(
            profile = profile,
            expectedPrevious = intent.expectedActiveProfile,
            authorizeActivation = { authorizeEnrollmentActivation(intent) },
        ) ?: return enrollmentIntentResult(intent)
            ?: supersededEnrollment()
        return RelayV2EnrollmentResult.Activated(activated)
    }

    /** Fences a user-cancelled confirmation without consuming or rewriting its persisted attempt. */
    fun cancelPendingEnrollment(): Boolean = synchronized(enrollmentIntentLock) {
        if (currentEnrollmentIntent == null) return@synchronized false
        currentEnrollmentIntent = null
        true
    }

    /** Startup/recovery hook; wiring it into the production actor lifecycle is a later slice. */
    suspend fun reconcileActiveCredential(): RelayV2CredentialReconciliationResult =
        credentialReconciler.reconcileActive()

    fun prepareRefresh(profile: RelayV2Profile): RelayV2PreparedRefresh {
        while (true) {
            val current = credentialStore.read(profile.credentialReference)
                ?: error("Relay v2 credential is unavailable")
            require(current.hasCredentialMaterial) { "Relay v2 credential is incomplete" }
            require(profile.matchesCredentialBinding(current)) {
                "Relay v2 credential binding does not match the profile"
            }

            current.pendingAttempt?.let { pending ->
                require(pending.kind == RelayV2CredentialAttemptKind.REFRESH) {
                    "Enrollment exchange is still pending"
                }
                return preparedRefresh(profile, current, pending)
            }

            val pending = RelayV2PendingCredentialAttempt(
                kind = RelayV2CredentialAttemptKind.REFRESH,
                attemptId = newId(),
                oldCredentialVersion = current.credentialVersion,
                secretReference = "refresh-${newId()}",
                secret = current.refreshToken!!,
            )
            val expectation = current.expectation()
            val replacement = current.copy(pendingAttempt = pending)
            when (credentialStore.compareAndSet(profile.credentialReference, expectation, replacement)) {
                is RelayV2CredentialCasResult.Updated -> {
                    return preparedRefresh(profile, replacement, pending)
                }
                is RelayV2CredentialCasResult.Stale -> Unit
            }
        }
    }

    suspend fun refresh(profile: RelayV2Profile): RelayV2RefreshApplyResult {
        val prepared = prepareRefresh(profile)
        return applyRefreshResponse(prepared, exchange.refresh(prepared.request))
    }

    suspend fun applyRefreshResponse(
        prepared: RelayV2PreparedRefresh,
        response: RelayV2RefreshResponse,
    ): RelayV2RefreshApplyResult {
        activeProfileChange(prepared, credentialVersion = null)?.let { return it }
        val current = credentialStore.read(prepared.credentialReference)
            ?: return activeProfileChange(prepared, credentialVersion = null)
                ?: RelayV2RefreshApplyResult.StaleCredentialResponse(null)
        if (!current.matches(prepared.expectation)) {
            return activeProfileChange(prepared, current.credentialVersion)
                ?: RelayV2RefreshApplyResult.StaleCredentialResponse(current.credentialVersion)
        }
        require(response.refreshAttemptId == prepared.request.refreshAttemptId) {
            "Refresh response attempt does not match"
        }
        require(response.principalId == current.principalId &&
            response.grantId == current.grantId &&
            response.hostId == current.hostId &&
            response.relayUrl == current.relayUrl
        ) { "Refresh response binding does not match" }

        val replacement = current.copy(
            credentialVersion = current.credentialVersion + 1,
            accessToken = response.accessToken,
            accessExpiresAtMs = response.accessExpiresAtMs,
            refreshToken = response.refreshToken,
            refreshExpiresAtMs = response.refreshExpiresAtMs,
            pendingAttempt = null,
        )
        return when (val result = credentialStore.compareAndSet(
            prepared.credentialReference,
            prepared.expectation,
            replacement,
        )) {
            is RelayV2CredentialCasResult.Stale ->
                activeProfileChange(prepared, result.currentCredentialVersion)
                    ?: RelayV2RefreshApplyResult.StaleCredentialResponse(
                        result.currentCredentialVersion,
                    )
            is RelayV2CredentialCasResult.Updated -> when (
                val reconciliation = credentialReconciler.reconcileExpected(
                    profileIdentity = prepared.profileIdentity,
                    credentialReference = prepared.credentialReference,
                )
            ) {
                is RelayV2CredentialReconciliationResult.InSync ->
                    RelayV2RefreshApplyResult.Applied(
                        credentialVersion = result.credentialVersion,
                        repairedProfileVersion = false,
                    )
                is RelayV2CredentialReconciliationResult.Repaired ->
                    RelayV2RefreshApplyResult.Applied(
                        credentialVersion = result.credentialVersion,
                        repairedProfileVersion = true,
                    )
                is RelayV2CredentialReconciliationResult.ActiveProfileChanged ->
                    RelayV2RefreshApplyResult.ActiveProfileChanged(
                        credentialVersion = result.credentialVersion,
                        activeProfile = reconciliation.activeProfile,
                    )
                is RelayV2CredentialReconciliationResult.Failed ->
                    RelayV2RefreshApplyResult.ProfileReconciliationFailed(
                        credentialVersion = result.credentialVersion,
                        failure = reconciliation,
                    )
                RelayV2CredentialReconciliationResult.NoActiveV2Profile ->
                    RelayV2RefreshApplyResult.ActiveProfileChanged(
                        credentialVersion = result.credentialVersion,
                        activeProfile = profileStore.activeProfileIdentity(),
                    )
            }
        }
    }

    private suspend fun activeProfileChange(
        prepared: RelayV2PreparedRefresh,
        credentialVersion: Long?,
    ): RelayV2RefreshApplyResult.ActiveProfileChanged? {
        val active = profileStore.activeRelayV2Profile()
        if (active != null &&
            active.identity == prepared.profileIdentity &&
            active.credentialReference == prepared.credentialReference
        ) return null
        return RelayV2RefreshApplyResult.ActiveProfileChanged(
            credentialVersion = credentialVersion,
            activeProfile = profileStore.activeProfileIdentity(),
        )
    }

    private fun prepareEnrollment(confirmed: RelayV2ConfirmedEnrollment): PreparedEnrollment {
        val draft = confirmed.draft
        val reference = credentialReference(draft)
        while (true) {
            val existing = credentialStore.read(reference)
            if (existing != null) {
                require(existing.issuerUrl == draft.issuerUrl &&
                    existing.relayUrl == draft.relayUrl &&
                    existing.hostId == draft.hostId &&
                    existing.clientInstanceId == clientInstanceId
                ) { "Enrollment reference conflicts with another profile" }
                if (existing.hasCredentialMaterial) {
                    return PreparedEnrollment.Completed(reference, existing)
                }
                val pending = existing.pendingAttempt
                    ?: error("Enrollment credential has no pending attempt")
                require(pending.kind == RelayV2CredentialAttemptKind.ENROLLMENT_EXCHANGE &&
                    pending.enrollmentId == draft.enrollmentId &&
                    pending.deviceLabel == confirmed.deviceLabel &&
                    pending.secret == draft.enrollmentCode
                ) { "Enrollment retry does not match the pending attempt" }
                return PreparedEnrollment.Pending(
                    credentialReference = reference,
                    expectation = existing.expectation(),
                    request = pending.enrollmentRequest(existing.issuerUrl, clientInstanceId),
                )
            }

            val pending = RelayV2PendingCredentialAttempt(
                kind = RelayV2CredentialAttemptKind.ENROLLMENT_EXCHANGE,
                attemptId = newId(),
                oldCredentialVersion = 0,
                secretReference = "enrollment-${newId()}",
                secret = draft.enrollmentCode,
                enrollmentId = draft.enrollmentId,
                deviceLabel = confirmed.deviceLabel,
            )
            val created = RelayV2CredentialBlob(
                credentialVersion = 0,
                issuerUrl = draft.issuerUrl,
                relayUrl = draft.relayUrl,
                hostId = draft.hostId,
                clientInstanceId = clientInstanceId,
                pendingAttempt = pending,
            )
            if (credentialStore.create(reference, created)) {
                return PreparedEnrollment.Pending(
                    credentialReference = reference,
                    expectation = created.expectation(),
                    request = pending.enrollmentRequest(created.issuerUrl, clientInstanceId),
                )
            }
        }
    }

    private fun registerEnrollmentIntent(
        credentialReference: RelayV2CredentialReference,
        expectedActiveProfile: RelayActiveProfileIdentity?,
    ): EnrollmentIntent = synchronized(enrollmentIntentLock) {
        currentEnrollmentIntent
            ?.takeIf { it.credentialReference == credentialReference }
            ?: EnrollmentIntent(
                credentialReference = credentialReference,
                expectedActiveProfile = expectedActiveProfile,
            ).also { currentEnrollmentIntent = it }
    }

    private fun authorizeEnrollmentActivation(intent: EnrollmentIntent): Boolean =
        synchronized(enrollmentIntentLock) {
            if (currentEnrollmentIntent !== intent) return@synchronized false
            intent.activationCommitted = true
            currentEnrollmentIntent = null
            true
        }

    private fun retireEnrollmentIntent(intent: EnrollmentIntent) = synchronized(enrollmentIntentLock) {
        if (currentEnrollmentIntent === intent) currentEnrollmentIntent = null
    }

    private suspend fun enrollmentIntentResult(
        intent: EnrollmentIntent,
    ): RelayV2EnrollmentResult? {
        val activationCommitted = synchronized(enrollmentIntentLock) {
            when {
                currentEnrollmentIntent === intent -> null
                intent.activationCommitted -> true
                else -> false
            }
        }
        return when (activationCommitted) {
            null -> null
            true -> RelayV2EnrollmentResult.StaleCredentialResponse(
                credentialStore.read(intent.credentialReference)?.credentialVersion,
            )
            false -> supersededEnrollment()
        }
    }

    private suspend fun supersededEnrollment(): RelayV2EnrollmentResult.Superseded =
        RelayV2EnrollmentResult.Superseded(profileStore.activeProfileIdentity())

    private fun applyEnrollmentResponse(
        prepared: PreparedEnrollment.Pending,
        response: RelayV2EnrollmentExchangeResponse,
    ): RelayV2CredentialCasResult {
        val current = credentialStore.read(prepared.credentialReference)
            ?: return RelayV2CredentialCasResult.Stale(null)
        if (!current.matches(prepared.expectation)) {
            return RelayV2CredentialCasResult.Stale(current.credentialVersion)
        }
        require(response.exchangeAttemptId == prepared.request.exchangeAttemptId) {
            "Enrollment response attempt does not match"
        }
        require(response.hostId == current.hostId && response.relayUrl == current.relayUrl) {
            "Enrollment response binding does not match"
        }
        require(response.principalId.isNotBlank() && response.grantId.isNotBlank()) {
            "Enrollment response identity is incomplete"
        }

        val replacement = current.copy(
            credentialVersion = current.credentialVersion + 1,
            principalId = response.principalId,
            grantId = response.grantId,
            accessToken = response.accessToken,
            accessExpiresAtMs = response.accessExpiresAtMs,
            refreshToken = response.refreshToken,
            refreshExpiresAtMs = response.refreshExpiresAtMs,
            pendingAttempt = null,
        )
        return credentialStore.compareAndSet(
            prepared.credentialReference,
            prepared.expectation,
            replacement,
        )
    }

    private fun preparedRefresh(
        profile: RelayV2Profile,
        blob: RelayV2CredentialBlob,
        pending: RelayV2PendingCredentialAttempt,
    ): RelayV2PreparedRefresh = RelayV2PreparedRefresh(
        profileIdentity = profile.identity,
        credentialReference = profile.credentialReference,
        expectation = blob.expectation(),
        request = RelayV2RefreshRequest(
            issuerUrl = blob.issuerUrl,
            refreshAttemptId = pending.attemptId,
            grantId = blob.grantId!!,
            clientInstanceId = blob.clientInstanceId,
            refreshToken = pending.secret,
        ),
    )

    private fun profileFromCredential(
        reference: RelayV2CredentialReference,
        blob: RelayV2CredentialBlob,
    ): RelayV2Profile {
        require(blob.hasCredentialMaterial && blob.pendingAttempt == null) {
            "Relay v2 credential is not ready for profile activation"
        }
        return RelayV2Profile(
            profileId = profileId(blob),
            issuerUrl = blob.issuerUrl,
            relayUrl = blob.relayUrl,
            hostId = blob.hostId,
            principalId = blob.principalId!!,
            grantId = blob.grantId!!,
            clientInstanceId = blob.clientInstanceId,
            credentialReference = reference,
            credentialVersion = blob.credentialVersion,
        )
    }

    private fun credentialReference(
        draft: RelayV2EnrollmentReviewDraft,
    ): RelayV2CredentialReference = RelayV2CredentialReference(
        "relay-v2-${digest(
            "${draft.issuerUrl}\u0000${draft.hostId}\u0000${draft.enrollmentId}\u0000$clientInstanceId",
        )}",
    )

    private fun profileId(blob: RelayV2CredentialBlob): String =
        "relay-v2-${digest(
            "${blob.issuerUrl}\u0000${blob.hostId}\u0000${blob.principalId}\u0000${blob.grantId}",
        )}"

    private fun digest(value: String): String = Base64.getUrlEncoder().withoutPadding().encodeToString(
        MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8)),
    )

    private fun RelayV2CredentialBlob.expectation(): RelayV2CredentialCasExpectation =
        RelayV2CredentialCasExpectation(
            credentialVersion = credentialVersion,
            pendingAttemptId = pendingAttempt?.attemptId,
            pendingSecretReference = pendingAttempt?.secretReference,
        )

    private fun RelayV2CredentialBlob.matches(
        expectation: RelayV2CredentialCasExpectation,
    ): Boolean = credentialVersion == expectation.credentialVersion &&
        pendingAttempt?.attemptId == expectation.pendingAttemptId &&
        pendingAttempt?.secretReference == expectation.pendingSecretReference

    private fun RelayV2PendingCredentialAttempt.enrollmentRequest(
        issuerUrl: String,
        clientInstanceId: String,
    ): RelayV2EnrollmentExchangeRequest = RelayV2EnrollmentExchangeRequest(
        issuerUrl = issuerUrl,
        exchangeAttemptId = attemptId,
        enrollmentId = enrollmentId!!,
        enrollmentCode = secret,
        clientInstanceId = clientInstanceId,
        deviceLabel = deviceLabel,
    )

    private sealed interface PreparedEnrollment {
        val credentialReference: RelayV2CredentialReference

        data class Pending(
            override val credentialReference: RelayV2CredentialReference,
            val expectation: RelayV2CredentialCasExpectation,
            val request: RelayV2EnrollmentExchangeRequest,
        ) : PreparedEnrollment

        data class Completed(
            override val credentialReference: RelayV2CredentialReference,
            val blob: RelayV2CredentialBlob,
        ) : PreparedEnrollment
    }

    private class EnrollmentIntent(
        val credentialReference: RelayV2CredentialReference,
        val expectedActiveProfile: RelayActiveProfileIdentity?,
    ) {
        var activationCommitted: Boolean = false
    }
}
