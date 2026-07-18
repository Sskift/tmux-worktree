package com.tmuxworktree.mobile.core.relay.v2.profile

import java.security.MessageDigest
import java.util.Base64
import java.util.UUID
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
        targetBindingDigest: String,
        targetCredentialAttemptId: String,
        targetCredentialSecretReference: String,
        expectedPrevious: RelayActiveProfileIdentity?,
        isStillCurrent: () -> Boolean,
        activationAuthority: RelayV2ProfileActivationAuthority,
    ): RelayV2Profile? = mutex.withLock {
        val pendingJournal = profileStore.pendingRelayV2Activation()
        val visiblePrevious = profileStore.activeProfileIdentity()
        if (!isStillCurrent()) return@withLock null
        val previousV2 = profileStore.activeRelayV2Profile()
        val sameActiveTarget = previousV2?.profileId == profile.profileId &&
            previousV2.credentialReference == profile.credentialReference
        if (sameActiveTarget) requireSameProfileBinding(requireNotNull(previousV2), profile)
        val samePendingTarget = pendingJournal?.matchesTarget(
            profile = profile,
            bindingDigest = targetBindingDigest,
            attemptId = targetCredentialAttemptId,
            secretReference = targetCredentialSecretReference,
        ) == true
        if ((!samePendingTarget ||
                pendingJournal?.phase == RelayV2ProfileActivationPhase.PREPARED) &&
            visiblePrevious != expectedPrevious
        ) return@withLock null
        if (pendingJournal != null &&
            pendingJournal.phase == RelayV2ProfileActivationPhase.CREDENTIAL_READY &&
            !samePendingTarget
        ) return@withLock null
        val previous = if (samePendingTarget) {
            pendingJournal!!.previousProfile
        } else {
            visiblePrevious
        }
        val nextGeneration = if (samePendingTarget) {
            pendingJournal!!.targetActivationGeneration
        } else if (sameActiveTarget) {
            requireNotNull(previousV2).activationGeneration
        } else {
            maxOf(
                previous?.activationGeneration ?: 0,
                pendingJournal?.previousProfile?.activationGeneration ?: 0,
                pendingJournal?.targetActivationGeneration ?: 0,
                (state as? RelayV2ProfileSwitchState.Active)
                    ?.identity?.activationGeneration ?: 0,
            ) + 1
        }
        val activated = profile.copy(
            credentialVersion = if (samePendingTarget) {
                maxOf(profile.credentialVersion, pendingJournal!!.targetCredentialVersion)
            } else {
                profile.credentialVersion
            },
            activationGeneration = nextGeneration,
        )
        val requiresIsolation = previous != null && !sameActiveTarget
        val prepared = if (samePendingTarget) {
            requireNotNull(pendingJournal)
        } else {
            val operationId = "activation-v2-${newId()}"
            val barrierId = if (requiresIsolation) "profile-v2-${newId()}" else null
            prepareWithRecovery(
                expectedPrevious = previous,
                operationId = operationId,
                profile = activated,
                targetBindingDigest = targetBindingDigest,
                targetCredentialAttemptId = targetCredentialAttemptId,
                targetCredentialSecretReference = targetCredentialSecretReference,
                barrierId = barrierId,
                previousCredentialReference = if (requiresIsolation) {
                    previousV2?.credentialReference
                } else {
                    null
                },
            ) ?: return@withLock null
        }
        val receipt = if (prepared.barrierId != null) {
            val barrierPrevious = requireNotNull(prepared.previousProfile)
            state = RelayV2ProfileSwitchState.Draining(
                barrierPrevious,
                prepared.barrierId,
            )
            disconnectBarrier.disconnectAndDrain(
                barrierPrevious,
                prepared.barrierId,
            ).also { validated ->
                check(validated.profile == barrierPrevious &&
                    validated.barrierId == prepared.barrierId
                ) { "Disconnect barrier did not drain the expected profile" }
            }
        } else {
            null
        }
        if (!isStillCurrent()) {
            state = RelayV2ProfileSwitchState.Idle
            return@withLock null
        }
        val committed = commitPreparedActivation(
            prepared = prepared,
            profile = activated,
            receipt = receipt,
            activationAuthority = activationAuthority,
        )
        if (committed == null) {
            state = RelayV2ProfileSwitchState.Idle
            return@withLock null
        }
        state = RelayV2ProfileSwitchState.Active(committed.identity)
        committed
    }

    private suspend fun commitPreparedActivation(
        prepared: RelayV2ProfileActivationJournal,
        profile: RelayV2Profile,
        receipt: RelayProfileDisconnectReceipt?,
        activationAuthority: RelayV2ProfileActivationAuthority,
    ): RelayV2Profile? = activationAuthority.commitIfCurrent { commit ->
        var journal = prepared
        val installed = commit.installCredential(journal, profile)
            ?: return@commitIfCurrent null
        check(journal.targetsCredential(installed)) {
            "Installed credential proof does not match the activation journal"
        }
        if (journal.phase == RelayV2ProfileActivationPhase.PREPARED ||
            installed.credentialVersion > journal.targetCredentialVersion
        ) {
            journal = credentialReadyWithRecovery(journal, installed)
                ?: return@commitIfCurrent null
        }
        check(journal.phase == RelayV2ProfileActivationPhase.CREDENTIAL_READY)
        check((receipt == null) == (journal.barrierId == null)) {
            "Activation isolation is missing its validated disconnect receipt"
        }
        receipt?.let { durableReceipt ->
            state = RelayV2ProfileSwitchState.Isolating(durableReceipt)
            isolationBoundary.clearAfterDisconnect(
                durableReceipt,
                journal.previousCredentialReference,
            )
        }
        val readyProfile = profile.copy(credentialVersion = journal.targetCredentialVersion)
        state = RelayV2ProfileSwitchState.Activating(readyProfile.profileId)
        activateWithRecovery(journal, readyProfile)
    }

    private suspend fun prepareWithRecovery(
        expectedPrevious: RelayActiveProfileIdentity?,
        operationId: String,
        profile: RelayV2Profile,
        targetBindingDigest: String,
        targetCredentialAttemptId: String,
        targetCredentialSecretReference: String,
        barrierId: String?,
        previousCredentialReference: RelayV2CredentialReference?,
    ): RelayV2ProfileActivationJournal? = recoverStoreWrite(
        write = {
            profileStore.prepareRelayV2Activation(
                expectedActiveProfile = expectedPrevious,
                operationId = operationId,
                profile = profile,
                targetBindingDigest = targetBindingDigest,
                targetCredentialAttemptId = targetCredentialAttemptId,
                targetCredentialSecretReference = targetCredentialSecretReference,
                barrierId = barrierId,
                previousCredentialReference = previousCredentialReference,
            )
        },
        recover = {
            profileStore.pendingRelayV2Activation()?.takeIf {
                it.operationId == operationId &&
                    it.phase == RelayV2ProfileActivationPhase.PREPARED &&
                    it.previousProfile == expectedPrevious && it.barrierId == barrierId &&
                    it.previousCredentialReference == previousCredentialReference &&
                    it.targetCredentialVersion == profile.credentialVersion &&
                    it.targetActivationGeneration == profile.activationGeneration &&
                    it.matchesTarget(
                        profile,
                        targetBindingDigest,
                        targetCredentialAttemptId,
                        targetCredentialSecretReference,
                    )
            }
        },
    )

    private suspend fun credentialReadyWithRecovery(
        journal: RelayV2ProfileActivationJournal,
        proof: RelayV2CompletedCredentialProof,
    ): RelayV2ProfileActivationJournal? {
        val expected = journal.copy(
            targetCredentialVersion = proof.credentialVersion,
            phase = RelayV2ProfileActivationPhase.CREDENTIAL_READY,
        )
        return recoverStoreWrite(
            write = {
                profileStore.markRelayV2CredentialReady(journal.operationId, proof)
            },
            recover = {
                profileStore.pendingRelayV2Activation()?.takeIf { it == expected }
            },
        )
    }

    private suspend fun activateWithRecovery(
        journal: RelayV2ProfileActivationJournal,
        profile: RelayV2Profile,
    ): RelayV2Profile? = recoverStoreWrite(
        write = { profileStore.activateRelayV2Profile(journal, profile) },
        recover = {
            if (profileStore.pendingRelayV2Activation() != null) {
                null
            } else {
                profileStore.activeRelayV2Profile()?.takeIf {
                    it.sameProfileBinding(profile) &&
                        it.identity == profile.identity &&
                        it.credentialVersion >= profile.credentialVersion
                }
            }
        },
    )

    private suspend fun <T> recoverStoreWrite(
        write: suspend () -> T?,
        recover: suspend () -> T?,
    ): T? = try {
        write()
    } catch (error: Throwable) {
        recover() ?: throw error
    }

    private fun RelayV2ProfileActivationJournal.matchesTarget(
        profile: RelayV2Profile,
        bindingDigest: String,
        attemptId: String,
        secretReference: String,
    ): Boolean = targetProfileId == profile.profileId &&
        targetCredentialReference == profile.credentialReference &&
        targetBindingDigest == bindingDigest &&
        targetCredentialAttemptId == attemptId &&
        targetCredentialSecretReference == secretReference

    private fun requireSameProfileBinding(current: RelayV2Profile, target: RelayV2Profile) {
        require(current.sameProfileBinding(target)) {
            "Active Relay v2 profile binding conflicts with the target"
        }
    }

    private fun RelayV2Profile.sameProfileBinding(other: RelayV2Profile): Boolean =
        profileId == other.profileId &&
            issuerUrl == other.issuerUrl && relayUrl == other.relayUrl &&
            hostId == other.hostId && principalId == other.principalId &&
            grantId == other.grantId && clientInstanceId == other.clientInstanceId &&
            credentialReference == other.credentialReference

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
    /** Retains the incompatible blob; caller must obtain a new enrollment/reference. */
    data class RecoveryRequired(
        val credentialReference: RelayV2CredentialReference,
        val reason: RelayV2CredentialRecoveryReason,
    ) : RelayV2EnrollmentResult
}

internal enum class RelayV2CredentialRecoveryReason {
    INCOMPATIBLE_LEGACY_COMPLETED_CREDENTIAL,
    COMPLETION_PROOF_MISSING_OR_MISMATCHED,
}

internal sealed interface RelayV2ActivationRecoveryResult {
    data object NoPendingActivation : RelayV2ActivationRecoveryResult
    data class ReenrollmentRequired(
        val credentialReference: RelayV2CredentialReference,
    ) : RelayV2ActivationRecoveryResult
    data class Incompatible(
        val credentialReference: RelayV2CredentialReference,
        val reason: RelayV2CredentialRecoveryReason,
    ) : RelayV2ActivationRecoveryResult
    data class Activated(val profile: RelayV2Profile) : RelayV2ActivationRecoveryResult
}

internal enum class RelayV2StartupCredentialUnavailableReason {
    CREDENTIAL_MISSING,
    BINDING_MISMATCH,
    CREDENTIAL_BLOB_BEHIND_PROFILE,
    REPAIR_CONFLICT,
}

internal sealed interface RelayV2StartupAdmissionResult {
    data class Ready(val profile: RelayV2Profile) : RelayV2StartupAdmissionResult

    data object NoActiveProfile : RelayV2StartupAdmissionResult

    data class ReenrollmentRequired(
        val credentialReference: RelayV2CredentialReference,
    ) : RelayV2StartupAdmissionResult

    data class RecoveryRequired(
        val credentialReference: RelayV2CredentialReference,
        val reason: RelayV2CredentialRecoveryReason,
    ) : RelayV2StartupAdmissionResult

    data class CredentialUnavailable(
        val profile: RelayV2Profile,
        val reason: RelayV2StartupCredentialUnavailableReason,
    ) : RelayV2StartupAdmissionResult
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
    private val enrollmentIntentMutex = Mutex()
    private val credentialMutationMutex = Mutex()
    // A live switch and startup recovery share this lease from journal preparation through publish.
    // Intent registration/cancellation stays outside it so a newer user decision can still fence a
    // confirmation while its disconnect barrier is waiting.
    private val activationOperationMutex = Mutex()

    @Volatile
    private var currentEnrollmentIntent: EnrollmentIntent? = null

    init {
        require(clientInstanceId.isNotBlank()) { "Client instance ID is required" }
    }

    suspend fun confirmEnrollment(
        confirmed: RelayV2ConfirmedEnrollment,
    ): RelayV2EnrollmentResult {
        val confirmedReference = credentialReference(confirmed.draft)
        val intent = beginEnrollmentIntent(confirmedReference)
            ?: return supersededEnrollment()
        while (true) {
            val durableActivation = profileStore.pendingRelayV2Activation()
            if (durableActivation != null) {
                when (val state = activationCredentialState(durableActivation)) {
                    is ActivationCredentialState.ExactCompleted -> {
                        val recovery = recoverDurableActivation(intent)
                        when (recovery) {
                            is RelayV2ActivationRecoveryResult.Activated -> {
                                retireEnrollmentIntent(intent)
                                return if (durableActivation.targetCredentialReference ==
                                    intent.credentialReference
                                ) {
                                    RelayV2EnrollmentResult.Activated(recovery.profile)
                                } else {
                                    RelayV2EnrollmentResult.Superseded(recovery.profile.identity)
                                }
                            }
                            RelayV2ActivationRecoveryResult.NoPendingActivation -> {
                                val recovered = profileStore.activeRelayV2Profile()
                                retireEnrollmentIntent(intent)
                                return if (durableActivation.targetCredentialReference ==
                                    intent.credentialReference &&
                                    recovered?.credentialReference == intent.credentialReference
                                ) {
                                    RelayV2EnrollmentResult.Activated(recovered)
                                } else {
                                    supersededEnrollment()
                                }
                            }
                            is RelayV2ActivationRecoveryResult.Incompatible -> {
                                retireEnrollmentIntent(intent)
                                return RelayV2EnrollmentResult.RecoveryRequired(
                                    recovery.credentialReference,
                                    recovery.reason,
                                )
                            }
                            is RelayV2ActivationRecoveryResult.ReenrollmentRequired -> {
                                retireEnrollmentIntent(intent)
                                return RelayV2EnrollmentResult.RecoveryRequired(
                                    recovery.credentialReference,
                                    RelayV2CredentialRecoveryReason
                                        .COMPLETION_PROOF_MISSING_OR_MISMATCHED,
                                )
                            }
                        }
                    }
                    ActivationCredentialState.ExactPending -> {
                        if (durableActivation.targetCredentialReference != confirmedReference) {
                            if (!rollbackPreparedForSupersedingIntent(
                                    intent,
                                    durableActivation,
                                )
                            ) {
                                val classified = enrollmentIntentResult(intent)
                                retireEnrollmentIntent(intent)
                                return classified ?: supersededEnrollment()
                            }
                        }
                    }
                    is ActivationCredentialState.Incompatible -> {
                        retireEnrollmentIntent(intent)
                        return RelayV2EnrollmentResult.RecoveryRequired(
                            durableActivation.targetCredentialReference,
                            state.reason,
                        )
                    }
                }
            }
            return confirmEnrollment(
                confirmed = confirmed,
                intent = intent,
                durableActivation = profileStore.pendingRelayV2Activation(),
            )
        }
    }

    private suspend fun confirmEnrollment(
        confirmed: RelayV2ConfirmedEnrollment,
        intent: EnrollmentIntent,
        durableActivation: RelayV2ProfileActivationJournal?,
    ): RelayV2EnrollmentResult {
        if (durableActivation?.phase != null &&
            durableActivation.phase != RelayV2ProfileActivationPhase.PREPARED &&
            durableActivation.targetCredentialReference != intent.credentialReference
        ) {
            retireEnrollmentIntent(intent)
            return supersededEnrollment()
        }
        val prepared = prepareEnrollment(
            confirmed = confirmed,
            allowCreate = durableActivation?.targetCredentialReference != intent.credentialReference,
        ) ?: run {
            retireEnrollmentIntent(intent)
            return RelayV2EnrollmentResult.StaleCredentialResponse(null)
        }
        check(prepared.credentialReference == intent.credentialReference)
        val activation = when (prepared) {
            is PreparedEnrollment.Completed -> PreparedEnrollmentActivation(
                blob = prepared.blob,
                credentialCommit = null,
            )
            is PreparedEnrollment.Pending -> {
                val response = exchange.redeem(prepared.request)
                enrollmentIntentResult(intent)?.let { return it }
                when (val preparedResponse = prepareEnrollmentResponse(prepared, response)) {
                    is PreparedEnrollmentResponse.Stale -> {
                        return RelayV2EnrollmentResult.StaleCredentialResponse(
                            preparedResponse.currentCredentialVersion,
                        )
                    }
                    is PreparedEnrollmentResponse.Ready -> PreparedEnrollmentActivation(
                        blob = preparedResponse.commit.replacement,
                        credentialCommit = preparedResponse.commit,
                    )
                }
            }
        }
        enrollmentIntentResult(intent)?.let { return it }
        if (profileStore.activeProfileIdentity() != intent.expectedActiveProfile) {
            retireEnrollmentIntent(intent)
            return supersededEnrollment()
        }
        val profile = profileFromCredential(prepared.credentialReference, activation.blob)
        val completedAttemptId = activation.blob.completedAttemptId
        val completedSecretReference = activation.blob.completedSecretReference
        if (completedAttemptId == null || completedSecretReference == null) {
            retireEnrollmentIntent(intent)
            return RelayV2EnrollmentResult.RecoveryRequired(
                prepared.credentialReference,
                if (activation.blob.schemaVersion ==
                    RelayV2CredentialBlob.LEGACY_SCHEMA_VERSION
                ) {
                    RelayV2CredentialRecoveryReason.INCOMPATIBLE_LEGACY_COMPLETED_CREDENTIAL
                } else {
                    RelayV2CredentialRecoveryReason.COMPLETION_PROOF_MISSING_OR_MISMATCHED
                },
            )
        }
        if (durableActivation?.targetCredentialReference == prepared.credentialReference) {
            require(
                durableActivation.targetProfileId == profile.profileId &&
                    durableActivation.targetsCredential(
                        activation.blob.completedProof(prepared.credentialReference),
                    ),
            ) { "Enrollment result does not match its durable activation journal" }
        }
        val activated = activationOperationMutex.withLock {
            profileSwitch.switchTo(
                profile = profile,
                targetBindingDigest = credentialBindingDigest(activation.blob),
                targetCredentialAttemptId = completedAttemptId,
                targetCredentialSecretReference = completedSecretReference,
                expectedPrevious = intent.expectedActiveProfile,
                isStillCurrent = { currentEnrollmentIntent === intent },
                activationAuthority = enrollmentActivationAuthority(
                    intent,
                    activation.credentialCommit,
                ),
            )
        } ?: run {
            retireEnrollmentIntent(intent)
            return enrollmentIntentResult(intent) ?: supersededEnrollment()
        }
        return RelayV2EnrollmentResult.Activated(activated)
    }

    /** Fences a user-cancelled confirmation without consuming or rewriting its persisted attempt. */
    suspend fun cancelPendingEnrollment(
        confirmed: RelayV2ConfirmedEnrollment,
    ): Boolean {
        val reference = credentialReference(confirmed.draft)
        val journal = profileStore.pendingRelayV2Activation()
        if (journal?.targetCredentialReference == reference &&
            activationCredentialState(journal) is ActivationCredentialState.ExactCompleted
        ) {
            val allowedIntent = enrollmentIntentMutex.withLock { currentEnrollmentIntent }
            if (allowedIntent?.credentialReference?.let { it != reference } == true) return false
            val recovery = recoverDurableActivation(allowedIntent)
            if (recovery !is RelayV2ActivationRecoveryResult.Activated) return false
            enrollmentIntentMutex.withLock {
                if (currentEnrollmentIntent === allowedIntent) currentEnrollmentIntent = null
            }
            return false
        }
        return enrollmentIntentMutex.withLock {
            if (currentEnrollmentIntent?.credentialReference != reference) return@withLock false
            val prepared = profileStore.pendingRelayV2Activation()?.let {
                if (it.targetCredentialReference == reference) {
                    if (activationCredentialState(it) != ActivationCredentialState.ExactPending) {
                        return@withLock false
                    }
                    it
                } else {
                    null
                }
            }
            // The final activation authority must acquire this same mutex before credential CAS.
            // Revoking first also makes the switch's lock-free barrier precheck fail as soon as
            // possible; rollback remains atomically visible to the authoritative locked check.
            currentEnrollmentIntent = null
            prepared?.let {
                when (rollbackExactPreparedActivationLocked(it)) {
                    PreparedActivationRollback.ROLLED_BACK,
                    PreparedActivationRollback.ALREADY_REMOVED,
                    -> Unit
                    PreparedActivationRollback.CHANGED -> return@withLock false
                }
            }
            true
        }
    }

    /**
     * Resumes the durable activation saga without QR, enrollment code, or broker replay.
     *
     * Any future production v2 composition must complete this before restoring a profile actor.
     * Production v2 composition remains disabled and does not currently construct this owner.
     */
    suspend fun recoverPendingActivation(): RelayV2ActivationRecoveryResult =
        recoverDurableActivation(allowedIntent = null)

    /**
     * Closed startup admission for a future explicitly enabled Relay v2 composition.
     *
     * Durable activation recovery and credential reconciliation share the activation lease. This
     * then takes the credential mutation lease through final winner validation; no credential
     * mutation holder acquires the activation lease in reverse. This method performs no exchange
     * or transport work and does not advertise runtime readiness.
     */
    suspend fun admitStartup(): RelayV2StartupAdmissionResult =
        activationOperationMutex.withLock {
            when (val recovery = recoverDurableActivationWithLease(allowedIntent = null)) {
                is RelayV2ActivationRecoveryResult.Activated ->
                    reconcileStartupWinner(recovery.profile)
                RelayV2ActivationRecoveryResult.NoPendingActivation -> {
                    val active = profileStore.activeRelayV2Profile()
                        ?: return@withLock RelayV2StartupAdmissionResult.NoActiveProfile
                    reconcileStartupWinner(active)
                }
                is RelayV2ActivationRecoveryResult.ReenrollmentRequired ->
                    RelayV2StartupAdmissionResult.ReenrollmentRequired(
                        recovery.credentialReference,
                    )
                is RelayV2ActivationRecoveryResult.Incompatible ->
                    RelayV2StartupAdmissionResult.RecoveryRequired(
                        credentialReference = recovery.credentialReference,
                        reason = recovery.reason,
                    )
            }
        }

    private suspend fun reconcileStartupWinner(
        winner: RelayV2Profile,
    ): RelayV2StartupAdmissionResult = credentialMutationMutex.withLock {
        val reconciliation = credentialReconciler.reconcileExpected(
            profileIdentity = winner.identity,
            credentialReference = winner.credentialReference,
        )
        val candidate = when (reconciliation) {
            is RelayV2CredentialReconciliationResult.InSync ->
                reconciliation.profile.takeIf { it == winner }
            is RelayV2CredentialReconciliationResult.Repaired ->
                reconciliation.profile.takeIf {
                    it.identity == winner.identity &&
                        it.credentialReference == winner.credentialReference &&
                        it.credentialVersion > winner.credentialVersion
                }
            is RelayV2CredentialReconciliationResult.Failed -> {
                return@withLock RelayV2StartupAdmissionResult.CredentialUnavailable(
                    profile = winner,
                    reason = reconciliation.failure.toStartupUnavailableReason(),
                )
            }
            is RelayV2CredentialReconciliationResult.ActiveProfileChanged,
            RelayV2CredentialReconciliationResult.NoActiveV2Profile,
            -> null
        } ?: return@withLock RelayV2StartupAdmissionResult.CredentialUnavailable(
            profile = winner,
            reason = RelayV2StartupCredentialUnavailableReason.REPAIR_CONFLICT,
        )

        if (profileStore.activeRelayV2Profile() == candidate) {
            RelayV2StartupAdmissionResult.Ready(candidate)
        } else {
            RelayV2StartupAdmissionResult.CredentialUnavailable(
                profile = winner,
                reason = RelayV2StartupCredentialUnavailableReason.REPAIR_CONFLICT,
            )
        }
    }

    private fun RelayV2CredentialReconciliationFailure.toStartupUnavailableReason():
        RelayV2StartupCredentialUnavailableReason = when (this) {
        RelayV2CredentialReconciliationFailure.CREDENTIAL_MISSING ->
            RelayV2StartupCredentialUnavailableReason.CREDENTIAL_MISSING
        RelayV2CredentialReconciliationFailure.BINDING_MISMATCH ->
            RelayV2StartupCredentialUnavailableReason.BINDING_MISMATCH
        RelayV2CredentialReconciliationFailure.CREDENTIAL_BLOB_BEHIND_PROFILE ->
            RelayV2StartupCredentialUnavailableReason.CREDENTIAL_BLOB_BEHIND_PROFILE
        RelayV2CredentialReconciliationFailure.PROFILE_VERSION_UPDATE_REJECTED ->
            RelayV2StartupCredentialUnavailableReason.REPAIR_CONFLICT
    }

    private suspend fun recoverDurableActivation(
        allowedIntent: EnrollmentIntent?,
    ): RelayV2ActivationRecoveryResult =
        activationOperationMutex.withLock {
            recoverDurableActivationWithLease(allowedIntent)
        }

    private suspend fun recoverDurableActivationWithLease(
        allowedIntent: EnrollmentIntent?,
    ): RelayV2ActivationRecoveryResult {
        val journal = profileStore.pendingRelayV2Activation()
            ?: return RelayV2ActivationRecoveryResult.NoPendingActivation
        val profile = when (val state = activationCredentialState(journal)) {
            is ActivationCredentialState.ExactCompleted -> state.profile
            ActivationCredentialState.ExactPending -> {
                return when (enrollmentIntentMutex.withLock {
                    rollbackExactPreparedActivationLocked(journal)
                }) {
                    PreparedActivationRollback.ROLLED_BACK ->
                        RelayV2ActivationRecoveryResult.ReenrollmentRequired(
                            journal.targetCredentialReference,
                        )
                    PreparedActivationRollback.ALREADY_REMOVED ->
                        RelayV2ActivationRecoveryResult.NoPendingActivation
                    PreparedActivationRollback.CHANGED ->
                        RelayV2ActivationRecoveryResult.Incompatible(
                            journal.targetCredentialReference,
                            RelayV2CredentialRecoveryReason
                                .COMPLETION_PROOF_MISSING_OR_MISMATCHED,
                        )
                }
            }
            is ActivationCredentialState.Incompatible ->
                return RelayV2ActivationRecoveryResult.Incompatible(
                    journal.targetCredentialReference,
                    state.reason,
                )
        }
        val recovered = profileSwitch.switchTo(
            profile = profile,
            targetBindingDigest = journal.targetBindingDigest,
            targetCredentialAttemptId = journal.targetCredentialAttemptId,
            targetCredentialSecretReference = journal.targetCredentialSecretReference,
            expectedPrevious = profileStore.activeProfileIdentity(),
            isStillCurrent = { true },
            activationAuthority = recoveryActivationAuthority(
                operationId = journal.operationId,
                allowedIntent = allowedIntent,
            ),
        ) ?: error("Durable Relay v2 activation lost recovery authority")
        return RelayV2ActivationRecoveryResult.Activated(recovered)
    }

    /** Startup/recovery hook for an already-published active credential. */
    suspend fun reconcileActiveCredential(): RelayV2CredentialReconciliationResult =
        credentialReconciler.reconcileActive()

    suspend fun prepareRefresh(
        profile: RelayV2Profile,
    ): RelayV2PreparedRefresh = credentialMutationMutex.withLock {
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
                return@withLock preparedRefresh(profile, current, pending)
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
                    return@withLock preparedRefresh(profile, replacement, pending)
                }
                is RelayV2CredentialCasResult.Stale -> Unit
            }
        }
        error("Credential preparation loop terminated unexpectedly")
    }

    suspend fun refresh(profile: RelayV2Profile): RelayV2RefreshApplyResult {
        val prepared = prepareRefresh(profile)
        return applyRefreshResponse(prepared, exchange.refresh(prepared.request))
    }

    suspend fun applyRefreshResponse(
        prepared: RelayV2PreparedRefresh,
        response: RelayV2RefreshResponse,
    ): RelayV2RefreshApplyResult = credentialMutationMutex.withLock {
        activeProfileChange(prepared, credentialVersion = null)?.let { return@withLock it }
        val current = credentialStore.read(prepared.credentialReference)
            ?: return@withLock activeProfileChange(prepared, credentialVersion = null)
                ?: RelayV2RefreshApplyResult.StaleCredentialResponse(null)
        if (!current.matches(prepared.expectation)) {
            return@withLock activeProfileChange(prepared, current.credentialVersion)
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
            schemaVersion = RelayV2CredentialBlob.SCHEMA_VERSION,
            credentialVersion = current.credentialVersion + 1,
            accessToken = response.accessToken,
            accessExpiresAtMs = response.accessExpiresAtMs,
            refreshToken = response.refreshToken,
            refreshExpiresAtMs = response.refreshExpiresAtMs,
            pendingAttempt = null,
        )
        return@withLock when (val result = credentialStore.compareAndSet(
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

    private fun prepareEnrollment(
        confirmed: RelayV2ConfirmedEnrollment,
        allowCreate: Boolean,
    ): PreparedEnrollment? {
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

            if (!allowCreate) return null
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

    private suspend fun beginEnrollmentIntent(
        credentialReference: RelayV2CredentialReference,
    ): EnrollmentIntent? {
        // Registration is deliberately the first action before the profile read can suspend.
        val intent = enrollmentIntentMutex.withLock {
            currentEnrollmentIntent
                ?.takeIf { it.credentialReference == credentialReference }
                ?: EnrollmentIntent(credentialReference).also { currentEnrollmentIntent = it }
        }
        val observedActiveProfile = profileStore.activeProfileIdentity()
        return enrollmentIntentMutex.withLock {
            if (currentEnrollmentIntent !== intent) return@withLock null
            if (!intent.expectedActiveProfileBound) {
                intent.expectedActiveProfile = observedActiveProfile
                intent.expectedActiveProfileBound = true
            } else if (intent.expectedActiveProfile != observedActiveProfile) {
                currentEnrollmentIntent = null
                return@withLock null
            }
            intent
        }
    }

    private suspend fun rollbackPreparedForSupersedingIntent(
        intent: EnrollmentIntent,
        journal: RelayV2ProfileActivationJournal,
    ): Boolean = enrollmentIntentMutex.withLock {
        if (currentEnrollmentIntent !== intent) return@withLock false
        when (rollbackExactPreparedActivationLocked(journal)) {
            PreparedActivationRollback.ROLLED_BACK -> true
            PreparedActivationRollback.ALREADY_REMOVED,
            PreparedActivationRollback.CHANGED,
            -> false
        }
    }

    /** Caller holds [enrollmentIntentMutex]; false CAS outcomes are re-read, never asserted. */
    private suspend fun rollbackExactPreparedActivationLocked(
        expected: RelayV2ProfileActivationJournal,
    ): PreparedActivationRollback {
        val current = profileStore.pendingRelayV2Activation()
            ?: return PreparedActivationRollback.ALREADY_REMOVED
        if (current != expected ||
            activationCredentialState(current) != ActivationCredentialState.ExactPending
        ) return PreparedActivationRollback.CHANGED
        if (profileStore.rollbackPreparedRelayV2Activation(current)) {
            return PreparedActivationRollback.ROLLED_BACK
        }
        return if (profileStore.pendingRelayV2Activation() == null) {
            PreparedActivationRollback.ALREADY_REMOVED
        } else {
            PreparedActivationRollback.CHANGED
        }
    }

    private fun enrollmentActivationAuthority(
        intent: EnrollmentIntent,
        credentialCommit: PreparedEnrollmentCredentialCommit?,
    ): RelayV2ProfileActivationAuthority = RelayV2ProfileActivationAuthority { activate ->
        enrollmentIntentMutex.withLock {
            if (currentEnrollmentIntent !== intent) return@withLock null
            val activated = try {
                credentialMutationMutex.withLock {
                    activate(
                        RelayV2ProfileActivationCommit { journal, profile ->
                            installEnrollmentCredential(
                                intent = intent,
                                journal = journal,
                                profile = profile,
                                credentialCommit = credentialCommit,
                            )
                        },
                    )
                }
            } catch (error: Throwable) {
                if (currentEnrollmentIntent === intent) currentEnrollmentIntent = null
                throw error
            }
            if (activated == null) {
                if (currentEnrollmentIntent === intent) currentEnrollmentIntent = null
                return@withLock null
            }
            intent.activationCommitted = true
            currentEnrollmentIntent = null
            activated
        }
    }

    private fun recoveryActivationAuthority(
        operationId: String,
        allowedIntent: EnrollmentIntent?,
    ): RelayV2ProfileActivationAuthority = RelayV2ProfileActivationAuthority { activate ->
        enrollmentIntentMutex.withLock {
            val currentJournal = profileStore.pendingRelayV2Activation()
                ?.takeIf { it.operationId == operationId }
                ?: return@withLock null
            val activated = credentialMutationMutex.withLock {
                activate(
                    RelayV2ProfileActivationCommit { journal, profile ->
                        if (journal.operationId != currentJournal.operationId) {
                            return@RelayV2ProfileActivationCommit null
                        }
                        credentialStore.read(journal.targetCredentialReference)
                            ?.takeIf { it.isExactInstalledCredential(journal, profile) }
                            ?.completedProof(journal.targetCredentialReference)
                    },
                )
            }
            if (activated != null && allowedIntent != null &&
                currentEnrollmentIntent === allowedIntent
            ) {
                currentEnrollmentIntent = null
            }
            activated
        }
    }

    private fun installEnrollmentCredential(
        intent: EnrollmentIntent,
        journal: RelayV2ProfileActivationJournal,
        profile: RelayV2Profile,
        credentialCommit: PreparedEnrollmentCredentialCommit?,
    ): RelayV2CompletedCredentialProof? {
        val current = credentialStore.read(journal.targetCredentialReference)
        if (current != null && journal.targetsProfile(profile) &&
            current.isExactInstalledCredential(journal, profile)
        ) return current.completedProof(journal.targetCredentialReference)
        if (credentialCommit == null ||
            credentialCommit.credentialReference != journal.targetCredentialReference ||
            credentialCommit.replacement.credentialVersion != journal.targetCredentialVersion ||
            credentialCommit.expectation.pendingAttemptId !=
            journal.targetCredentialAttemptId ||
            credentialCommit.replacement.completedAttemptId !=
            journal.targetCredentialAttemptId ||
            credentialCommit.expectation.pendingSecretReference !=
            credentialCommit.replacement.completedSecretReference ||
            credentialCommit.replacement.completedSecretReference !=
            journal.targetCredentialSecretReference ||
            journal.targetBindingDigest != credentialBindingDigest(credentialCommit.replacement) ||
            !profile.matchesCredentialBinding(credentialCommit.replacement)
        ) {
            intent.terminalResult = RelayV2EnrollmentResult.StaleCredentialResponse(
                current?.credentialVersion,
            )
            return null
        }
        var lastResult: RelayV2CredentialCasResult? = null
        repeat(2) { attempt ->
            try {
                lastResult = credentialStore.compareAndSet(
                    credentialCommit.credentialReference,
                    credentialCommit.expectation,
                    credentialCommit.replacement,
                )
            } catch (error: Throwable) {
                val observed = credentialStore.read(credentialCommit.credentialReference)
                if (observed.isExactInstalledCredential(journal, profile)) {
                    return observed!!.completedProof(credentialCommit.credentialReference)
                }
                if (attempt == 0 && observed?.matches(credentialCommit.expectation) == true) {
                    return@repeat
                }
                throw error
            }
            val observed = credentialStore.read(credentialCommit.credentialReference)
            if (observed.isExactInstalledCredential(journal, profile)) {
                return observed!!.completedProof(credentialCommit.credentialReference)
            }
            if (lastResult is RelayV2CredentialCasResult.Stale) return@repeat
        }
        val installed = credentialStore.read(credentialCommit.credentialReference)
        if (installed.isExactInstalledCredential(journal, profile)) {
            return installed!!.completedProof(credentialCommit.credentialReference)
        }
        intent.terminalResult = RelayV2EnrollmentResult.StaleCredentialResponse(
            when (val result = lastResult) {
                is RelayV2CredentialCasResult.Stale -> result.currentCredentialVersion
                is RelayV2CredentialCasResult.Updated -> installed?.credentialVersion
                null -> installed?.credentialVersion
            },
        )
        return null
    }

    private fun RelayV2CredentialBlob?.isExactInstalledCredential(
        journal: RelayV2ProfileActivationJournal,
        profile: RelayV2Profile,
    ): Boolean = this != null &&
        pendingAttempt?.kind != RelayV2CredentialAttemptKind.ENROLLMENT_EXCHANGE &&
        journal.targetsProfile(profile) &&
        profile.matchesCredentialBinding(this) &&
        journal.targetsCredential(completedProof(journal.targetCredentialReference))

    private fun RelayV2CredentialBlob.completedProof(
        reference: RelayV2CredentialReference,
    ): RelayV2CompletedCredentialProof = RelayV2CompletedCredentialProof(
        credentialReference = reference,
        credentialVersion = credentialVersion,
        bindingDigest = credentialBindingDigest(this),
        completedAttemptId = requireNotNull(completedAttemptId),
        completedSecretReference = requireNotNull(completedSecretReference),
    )

    private fun activationCredentialState(
        journal: RelayV2ProfileActivationJournal,
    ): ActivationCredentialState {
        val credential = credentialStore.read(journal.targetCredentialReference)
            ?: return ActivationCredentialState.Incompatible(
                RelayV2CredentialRecoveryReason.COMPLETION_PROOF_MISSING_OR_MISMATCHED,
            )
        if (credential.hasCredentialMaterial) {
            if (credential.schemaVersion == RelayV2CredentialBlob.LEGACY_SCHEMA_VERSION ||
                credential.completedAttemptId == null ||
                credential.completedSecretReference == null
            ) {
                return ActivationCredentialState.Incompatible(
                    if (credential.schemaVersion == RelayV2CredentialBlob.LEGACY_SCHEMA_VERSION) {
                        RelayV2CredentialRecoveryReason.INCOMPATIBLE_LEGACY_COMPLETED_CREDENTIAL
                    } else {
                        RelayV2CredentialRecoveryReason.COMPLETION_PROOF_MISSING_OR_MISMATCHED
                    },
                )
            }
            val profile = profileFromCredential(journal.targetCredentialReference, credential)
                .copy(activationGeneration = journal.targetActivationGeneration)
            return if (credential.isExactInstalledCredential(journal, profile)) {
                ActivationCredentialState.ExactCompleted(profile)
            } else {
                ActivationCredentialState.Incompatible(
                    RelayV2CredentialRecoveryReason.COMPLETION_PROOF_MISSING_OR_MISMATCHED,
                )
            }
        }
        val pending = credential.pendingAttempt
        return if (journal.phase == RelayV2ProfileActivationPhase.PREPARED &&
            credential.credentialVersion < journal.targetCredentialVersion &&
            pending?.kind == RelayV2CredentialAttemptKind.ENROLLMENT_EXCHANGE &&
            pending.attemptId == journal.targetCredentialAttemptId &&
            pending.secretReference == journal.targetCredentialSecretReference
        ) {
            ActivationCredentialState.ExactPending
        } else {
            ActivationCredentialState.Incompatible(
                RelayV2CredentialRecoveryReason.COMPLETION_PROOF_MISSING_OR_MISMATCHED,
            )
        }
    }

    private fun RelayV2ProfileActivationJournal.targetsProfile(
        profile: RelayV2Profile,
    ): Boolean = targetProfileId == profile.profileId &&
        targetCredentialReference == profile.credentialReference &&
        profile.credentialVersion >= targetCredentialVersion &&
        targetActivationGeneration == profile.activationGeneration

    private suspend fun retireEnrollmentIntent(intent: EnrollmentIntent) =
        enrollmentIntentMutex.withLock {
            if (currentEnrollmentIntent === intent) currentEnrollmentIntent = null
        }

    private suspend fun enrollmentIntentResult(
        intent: EnrollmentIntent,
    ): RelayV2EnrollmentResult? {
        val (activationCommitted, terminalResult) = enrollmentIntentMutex.withLock {
            Pair(
                when {
                    currentEnrollmentIntent === intent -> null
                    intent.activationCommitted -> true
                    else -> false
                },
                intent.terminalResult,
            )
        }
        terminalResult?.let { return it }
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

    private fun prepareEnrollmentResponse(
        prepared: PreparedEnrollment.Pending,
        response: RelayV2EnrollmentExchangeResponse,
    ): PreparedEnrollmentResponse {
        val current = credentialStore.read(prepared.credentialReference)
            ?: return PreparedEnrollmentResponse.Stale(null)
        if (!current.matches(prepared.expectation)) {
            return PreparedEnrollmentResponse.Stale(current.credentialVersion)
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
            schemaVersion = RelayV2CredentialBlob.SCHEMA_VERSION,
            credentialVersion = current.credentialVersion + 1,
            principalId = response.principalId,
            grantId = response.grantId,
            accessToken = response.accessToken,
            accessExpiresAtMs = response.accessExpiresAtMs,
            refreshToken = response.refreshToken,
            refreshExpiresAtMs = response.refreshExpiresAtMs,
            pendingAttempt = null,
            completedAttemptId = prepared.expectation.pendingAttemptId,
            completedSecretReference = prepared.expectation.pendingSecretReference,
        )
        return PreparedEnrollmentResponse.Ready(
            PreparedEnrollmentCredentialCommit(
                credentialReference = prepared.credentialReference,
                expectation = prepared.expectation,
                replacement = replacement,
            ),
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
        require(blob.hasCredentialMaterial &&
            blob.pendingAttempt?.kind != RelayV2CredentialAttemptKind.ENROLLMENT_EXCHANGE
        ) {
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

    private fun credentialBindingDigest(blob: RelayV2CredentialBlob): String = digest(
        listOf(
            blob.issuerUrl,
            blob.relayUrl,
            blob.hostId,
            blob.clientInstanceId,
            blob.principalId,
            blob.grantId,
        ).joinToString("\u0000"),
    )

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

    private data class PreparedEnrollmentActivation(
        val blob: RelayV2CredentialBlob,
        val credentialCommit: PreparedEnrollmentCredentialCommit?,
    )

    private data class PreparedEnrollmentCredentialCommit(
        val credentialReference: RelayV2CredentialReference,
        val expectation: RelayV2CredentialCasExpectation,
        val replacement: RelayV2CredentialBlob,
    )

    private sealed interface PreparedEnrollmentResponse {
        data class Ready(
            val commit: PreparedEnrollmentCredentialCommit,
        ) : PreparedEnrollmentResponse

        data class Stale(
            val currentCredentialVersion: Long?,
        ) : PreparedEnrollmentResponse
    }

    private class EnrollmentIntent(
        val credentialReference: RelayV2CredentialReference,
    ) {
        var expectedActiveProfile: RelayActiveProfileIdentity? = null
        var expectedActiveProfileBound: Boolean = false
        var activationCommitted: Boolean = false
        var terminalResult: RelayV2EnrollmentResult.StaleCredentialResponse? = null
    }

    private sealed interface ActivationCredentialState {
        data class ExactCompleted(val profile: RelayV2Profile) : ActivationCredentialState
        data object ExactPending : ActivationCredentialState
        data class Incompatible(
            val reason: RelayV2CredentialRecoveryReason,
        ) : ActivationCredentialState
    }

    private enum class PreparedActivationRollback {
        ROLLED_BACK,
        ALREADY_REMOVED,
        CHANGED,
    }
}
