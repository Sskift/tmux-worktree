package com.tmuxworktree.mobile.app

import com.tmuxworktree.mobile.core.data.AndroidKeystoreCredentialStore
import com.tmuxworktree.mobile.core.data.PreferencesRelayV2ProfileStore
import com.tmuxworktree.mobile.core.data.PreferencesStore
import com.tmuxworktree.mobile.core.data.TwRepository
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecyclePostedNotificationCancellationResult
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayActiveProfileIdentity
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayProfileDialect
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayProfileDisconnectBarrier
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayProfileDisconnectReceipt
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayProfileIsolationBoundary
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2ConfirmedEnrollment
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2CredentialExchange
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2CredentialStore
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2CredentialReconciliationResult
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2EnrollmentResult
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2ProfileRepository
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2Profile
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2ProfileSwitchStateMachine
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2RefreshApplyResult
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2RefreshCoordinator
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2SelfRevokeExchange
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2SelfRevokePhase
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2SelfRevokeResult
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2StartupAdmissionResult
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2StartupCredentialUnavailableReason
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2CredentialRolloverPort
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2CredentialRolloverResult
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StateRepository
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalResumeCredentialStore

internal data class RelayStartupAdmission(
    val state: RelayStartupAdmissionState,
    val message: String? = null,
    val relayV2Profile: RelayV2Profile? = null,
    val selfRevokePhase: RelayV2SelfRevokePhase? = null,
) {
    init {
        require((state == RelayStartupAdmissionState.RELAY_V2) == (relayV2Profile != null)) {
            "Only a verified Relay v2 startup admission may carry its profile"
        }
        require(
            (state == RelayStartupAdmissionState.RELAY_V2_SELF_REVOKE_QUARANTINED) ==
                (selfRevokePhase != null),
        ) { "Only self-revoke quarantine admission may carry its phase" }
    }

    val allowsRelayV1: Boolean
        get() = state == RelayStartupAdmissionState.RELAY_V1
}

/**
 * Canonical production composition for the Android Relay v2 profile and credential owner.
 *
 * Startup admission remains network-free. HTTPS is reachable only through an already-confirmed
 * enrollment or an explicit refresh call; neither operation starts a socket or advertises a
 * capability.
 */
internal class RelayV2ProfileRuntimeAdapter(
    preferencesStore: PreferencesStore,
    legacyRepository: TwRepository,
    legacyCredentialStore: AndroidKeystoreCredentialStore,
    relayV2CredentialStore: RelayV2CredentialStore,
    relayV2StateRepository: () -> RelayV2StateRepository,
    terminalResumeCredentialStore: RelayV2TerminalResumeCredentialStore,
    clientInstanceId: String,
    credentialExchange: RelayV2CredentialExchange,
    selfRevokeExchange: RelayV2SelfRevokeExchange,
    refreshCoordinator: RelayV2RefreshCoordinator,
    private val profileMutationCoordinator: ProfileMutationCoordinator,
    disconnectBarrier: RelayProfileDisconnectBarrier,
    cancelAgentNotificationsAfterDisconnect: suspend (
        RelayActiveProfileIdentity,
    ) -> AgentTranscriptLifecyclePostedNotificationCancellationResult,
    clearEphemeralAfterDisconnect: suspend (RelayProfileDisconnectReceipt) -> Unit,
) : RelayV2CredentialRolloverPort {
    private val repository: RelayV2ProfileRepository

    init {
        val profileStore = PreferencesRelayV2ProfileStore(preferencesStore)
        val isolationBoundary = RelayProfileIsolationBoundary { receipt, previousCredentialReference ->
            when (receipt.profile.dialect) {
                RelayProfileDialect.V1 -> {
                    check(previousCredentialReference == null) {
                        "Relay v1 isolation must not receive a Relay v2 credential reference"
                    }
                    legacyRepository.clearProfileData()
                    clearEphemeralAfterDisconnect(receipt)
                    legacyCredentialStore.clear()
                }

                RelayProfileDialect.V2 -> {
                    val credentialReference = requireNotNull(previousCredentialReference) {
                        "Relay v2 isolation requires its exact credential reference"
                    }
                    // The receipt proves admission/effect fencing and actor-lease drain. Published
                    // notification identities must be consumed before Room profile cleanup.
                    when (val cancellation = cancelAgentNotificationsAfterDisconnect(
                        receipt.profile,
                    )) {
                        AgentTranscriptLifecyclePostedNotificationCancellationResult
                            .DurableUnavailable -> error(
                            "Posted notification cancellation durability is unavailable",
                        )
                        is AgentTranscriptLifecyclePostedNotificationCancellationResult
                            .Completed -> check(cancellation.failed == 0) {
                            "Posted notification cancellation did not complete"
                        }
                    }
                    terminalResumeCredentialStore.clearProfile(
                        receipt.profile.profileId,
                        receipt.profile.activationGeneration,
                    )
                    relayV2StateRepository().clearProfileAfterDisconnect(receipt)
                    clearEphemeralAfterDisconnect(receipt)
                    relayV2CredentialStore.clear(credentialReference)
                }
            }
        }
        repository = RelayV2ProfileRepository(
            profileStore = profileStore,
            selfRevokeJournalStore = profileStore,
            credentialStore = relayV2CredentialStore,
            exchange = credentialExchange,
            selfRevokeExchange = selfRevokeExchange,
            refreshCoordinator = refreshCoordinator,
            profileSwitch = RelayV2ProfileSwitchStateMachine(
                profileStore = profileStore,
                disconnectBarrier = disconnectBarrier,
                isolationBoundary = isolationBoundary,
            ),
            clientInstanceId = clientInstanceId,
        )
    }

    suspend fun admitStartup(): RelayStartupAdmission = profileMutationCoordinator.mutate {
        when (val result = repository.admitStartup()) {
            RelayV2StartupAdmissionResult.NoActiveProfile -> RelayStartupAdmission(
                state = RelayStartupAdmissionState.RELAY_V1,
            )

            is RelayV2StartupAdmissionResult.Ready -> RelayStartupAdmission(
                state = RelayStartupAdmissionState.RELAY_V2,
                relayV2Profile = result.profile,
            )

            is RelayV2StartupAdmissionResult.ReenrollmentRequired -> RelayStartupAdmission(
                state = RelayStartupAdmissionState.RELAY_V2_REENROLLMENT_REQUIRED,
                message = "Relay v2 re-enrollment is required; Relay v1 fallback is disabled.",
            )

            is RelayV2StartupAdmissionResult.RecoveryRequired -> RelayStartupAdmission(
                state = RelayStartupAdmissionState.RELAY_V2_RECOVERY_REQUIRED,
                message = "Relay v2 profile recovery is required; Relay v1 fallback is disabled.",
            )

            is RelayV2StartupAdmissionResult.CredentialUnavailable -> RelayStartupAdmission(
                state = credentialUnavailableState(result.reason),
                message = "Relay v2 credential is unavailable; Relay v1 fallback is disabled.",
            )

            is RelayV2StartupAdmissionResult.SelfRevokeQuarantined ->
                selfRevokeQuarantineAdmission(result.phase)
        }
    }

    suspend fun confirmEnrollment(
        confirmed: RelayV2ConfirmedEnrollment,
    ): RelayV2EnrollmentResult = profileMutationCoordinator.mutate {
        repository.confirmEnrollment(confirmed)
    }

    suspend fun refreshCredential(): RelayV2RefreshApplyResult = profileMutationCoordinator.mutate {
        repository.refreshActiveCredential()
    }

    /** Exact-profile connect consent; never starts a socket by itself. */
    suspend fun consentAutoConnect(
        expectedProfile: RelayV2Profile,
    ): RelayV2Profile? = profileMutationCoordinator.mutate {
        repository.consentAutoConnect(expectedProfile)
    }

    suspend fun selfRevokeActiveProfile(): RelayV2SelfRevokeResult =
        profileMutationCoordinator.mutate {
            repository.selfRevokeActiveProfile()
        }

    override suspend fun rollover(
        expectedProfile: RelayV2Profile,
    ): RelayV2CredentialRolloverResult = profileMutationCoordinator.mutate {
        val before = repository.reconcileActiveCredential().reconciledProfile()
        if (before != expectedProfile || expectedProfile.credentialVersion == Long.MAX_VALUE) {
            return@mutate RelayV2CredentialRolloverResult.Unavailable
        }
        val applied = repository.refreshActiveCredential()
            as? RelayV2RefreshApplyResult.Applied
            ?: return@mutate RelayV2CredentialRolloverResult.Unavailable
        val refreshed = repository.reconcileActiveCredential().reconciledProfile()
            ?: return@mutate RelayV2CredentialRolloverResult.Unavailable
        val expectedVersion = expectedProfile.credentialVersion + 1
        if (applied.credentialVersion != expectedVersion ||
            refreshed != expectedProfile.copy(credentialVersion = expectedVersion)
        ) {
            return@mutate RelayV2CredentialRolloverResult.Unavailable
        }
        RelayV2CredentialRolloverResult.Refreshed(refreshed)
    }
}

internal fun selfRevokeQuarantineAdmission(
    phase: RelayV2SelfRevokePhase,
): RelayStartupAdmission = RelayStartupAdmission(
    state = RelayStartupAdmissionState.RELAY_V2_SELF_REVOKE_QUARANTINED,
    message = when (phase) {
        RelayV2SelfRevokePhase.PREPARED ->
            "Self-revoke is prepared; confirm Forget again to continue. " +
                "Relay v1 fallback is disabled."
        RelayV2SelfRevokePhase.MAY_HAVE_COMMITTED ->
            "Self-revoke may have committed; the profile remains quarantined. " +
                "Relay v1 fallback is disabled."
        RelayV2SelfRevokePhase.REJECTED ->
            "Self-revoke was rejected; the profile remains quarantined. " +
                "Relay v1 fallback is disabled."
        RelayV2SelfRevokePhase.CONFIRMED ->
            "Self-revoke is confirmed but local cleanup is incomplete. " +
                "Relay v1 fallback is disabled."
    },
    selfRevokePhase = phase,
)

private fun RelayV2CredentialReconciliationResult.reconciledProfile(): RelayV2Profile? =
    when (this) {
        is RelayV2CredentialReconciliationResult.InSync -> profile
        is RelayV2CredentialReconciliationResult.Repaired -> profile
        is RelayV2CredentialReconciliationResult.ActiveProfileChanged,
        is RelayV2CredentialReconciliationResult.Failed,
        RelayV2CredentialReconciliationResult.NoActiveV2Profile,
        -> null
    }

private fun credentialUnavailableState(
    reason: RelayV2StartupCredentialUnavailableReason,
): RelayStartupAdmissionState =
    when (reason) {
        RelayV2StartupCredentialUnavailableReason.CREDENTIAL_MISSING ->
            RelayStartupAdmissionState.RELAY_V2_CREDENTIAL_MISSING
        RelayV2StartupCredentialUnavailableReason.BINDING_MISMATCH ->
            RelayStartupAdmissionState.RELAY_V2_CREDENTIAL_BINDING_MISMATCH
        RelayV2StartupCredentialUnavailableReason.CREDENTIAL_BLOB_BEHIND_PROFILE ->
            RelayStartupAdmissionState.RELAY_V2_CREDENTIAL_BLOB_BEHIND
        RelayV2StartupCredentialUnavailableReason.REPAIR_CONFLICT ->
            RelayStartupAdmissionState.RELAY_V2_CREDENTIAL_REPAIR_CONFLICT
    }
