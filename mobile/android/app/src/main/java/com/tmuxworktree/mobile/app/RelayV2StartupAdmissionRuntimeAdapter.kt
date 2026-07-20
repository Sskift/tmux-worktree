package com.tmuxworktree.mobile.app

import com.tmuxworktree.mobile.core.data.AndroidKeystoreCredentialStore
import com.tmuxworktree.mobile.core.data.PreferencesRelayV2ProfileStore
import com.tmuxworktree.mobile.core.data.PreferencesStore
import com.tmuxworktree.mobile.core.data.TwRepository
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayProfileDialect
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayProfileDisconnectBarrier
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayProfileDisconnectReceipt
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayProfileIsolationBoundary
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2CredentialExchange
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2CredentialStore
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2EnrollmentExchangeRequest
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2EnrollmentExchangeResponse
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2ProfileRepository
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2ProfileSwitchStateMachine
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2RefreshRequest
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2RefreshResponse
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2StartupAdmissionResult
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2StartupCredentialUnavailableReason
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StateRepository

internal data class RelayStartupAdmission(
    val state: RelayStartupAdmissionState,
    val message: String? = null,
) {
    val allowsRelayV1: Boolean
        get() = state == RelayStartupAdmissionState.RELAY_V1
}

/**
 * Cold-start-only composition around the profile repository. It deliberately has no HTTP,
 * WebSocket, actor, hello, or capability dependency.
 */
internal class RelayV2StartupAdmissionRuntimeAdapter(
    preferencesStore: PreferencesStore,
    legacyRepository: TwRepository,
    legacyCredentialStore: AndroidKeystoreCredentialStore,
    relayV2CredentialStore: RelayV2CredentialStore,
    relayV2StateRepository: () -> RelayV2StateRepository,
    clientInstanceId: String,
    disconnectBarrier: RelayProfileDisconnectBarrier,
    clearEphemeralAfterDisconnect: suspend (RelayProfileDisconnectReceipt) -> Unit,
) {
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
                    relayV2StateRepository().clearProfileAfterDisconnect(receipt)
                    clearEphemeralAfterDisconnect(receipt)
                    relayV2CredentialStore.clear(credentialReference)
                }
            }
        }
        repository = RelayV2ProfileRepository(
            profileStore = profileStore,
            credentialStore = relayV2CredentialStore,
            exchange = StartupNetworkForbiddenCredentialExchange,
            profileSwitch = RelayV2ProfileSwitchStateMachine(
                profileStore = profileStore,
                disconnectBarrier = disconnectBarrier,
                isolationBoundary = isolationBoundary,
            ),
            clientInstanceId = clientInstanceId,
        )
    }

    suspend fun admitStartup(): RelayStartupAdmission =
        when (val result = repository.admitStartup()) {
            RelayV2StartupAdmissionResult.NoActiveProfile -> RelayStartupAdmission(
                state = RelayStartupAdmissionState.RELAY_V1,
            )

            is RelayV2StartupAdmissionResult.Ready -> RelayStartupAdmission(
                state = RelayStartupAdmissionState.RELAY_V2_RUNTIME_UNAVAILABLE,
                message = "Relay v2 profile verified, but the base Relay v2 runtime is not enabled yet.",
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
        }
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

private object StartupNetworkForbiddenCredentialExchange : RelayV2CredentialExchange {
    override suspend fun redeem(request: RelayV2EnrollmentExchangeRequest): RelayV2EnrollmentExchangeResponse =
        error("cold-start Relay v2 admission must not redeem credentials")

    override suspend fun refresh(request: RelayV2RefreshRequest): RelayV2RefreshResponse =
        error("cold-start Relay v2 admission must not refresh credentials")
}
