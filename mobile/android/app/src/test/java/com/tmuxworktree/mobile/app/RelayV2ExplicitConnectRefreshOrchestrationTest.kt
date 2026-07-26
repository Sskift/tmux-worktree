package com.tmuxworktree.mobile.app

import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2CredentialReference
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2Profile
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2RefreshApplyResult
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2StartupAdmissionResult
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RelayV2ExplicitConnectRefreshOrchestrationTest {
    private val profileA = RelayV2Profile(
        profileId = "relay-v2-profile-a",
        issuerUrl = "https://relay.example.com",
        relayUrl = "wss://relay.example.com/client",
        hostId = "mac-admin",
        principalId = "principal-1",
        grantId = "grant-1",
        clientInstanceId = "android-install-1",
        credentialReference = RelayV2CredentialReference("credential-reference-a"),
        credentialVersion = 1,
        activationGeneration = 3,
    )
    private val profileB = profileA.copy(
        profileId = "relay-v2-profile-b",
        credentialReference = RelayV2CredentialReference("credential-reference-b"),
        activationGeneration = 4,
    )

    @Test
    fun `normal exact profile settles refresh admission consent and install in order`() =
        runBlocking {
            val calls = mutableListOf<String>()
            val refreshed = profileA.copy(credentialVersion = 2)
            val consented = refreshed.copy(autoConnect = true)

            val outcome = explicitConnectRefreshOrchestration(
                expectedProfile = profileA,
                refreshActiveCredential = { expected ->
                    assertEquals(profileA, expected)
                    calls += "refresh"
                    RelayV2RefreshApplyResult.Applied(2, repairedProfileVersion = true)
                },
                admitStartup = {
                    calls += "admit"
                    RelayV2StartupAdmissionResult.Ready(refreshed)
                },
                consentAutoConnect = { exact ->
                    assertEquals(refreshed, exact)
                    calls += "consent"
                    consented
                },
                installExact = { exact ->
                    assertEquals(consented, exact)
                    calls += "install"
                    true
                },
            )

            assertEquals(
                RelayV2ExplicitConnectRefreshResult.SuccessorInstalled(consented),
                outcome,
            )
            assertEquals(listOf("refresh", "admit", "consent", "install"), calls)
        }

    @Test
    fun `drift is detected before any downstream consent install or exchange`() =
        runBlocking {
            var downstreamCalls = 0

            // The refresh owner rejects the switched active profile before anything downstream.
            val refreshDrift = explicitConnectRefreshOrchestration(
                expectedProfile = profileA,
                refreshActiveCredential = {
                    RelayV2RefreshApplyResult.ActiveProfileChanged(1, profileB.identity)
                },
                admitStartup = {
                    downstreamCalls += 1
                    RelayV2StartupAdmissionResult.Ready(profileA.copy(credentialVersion = 2))
                },
                consentAutoConnect = {
                    downstreamCalls += 1
                    profileA.copy(credentialVersion = 2, autoConnect = true)
                },
                installExact = {
                    downstreamCalls += 1
                    true
                },
            )
            assertTrue(refreshDrift is RelayV2ExplicitConnectRefreshResult.ActiveProfileChanged)
            assertEquals(0, downstreamCalls)

            // A re-admission that returns the switched profile drifts before consent/install.
            val admissionDrift = explicitConnectRefreshOrchestration(
                expectedProfile = profileA,
                refreshActiveCredential = {
                    RelayV2RefreshApplyResult.Applied(2, repairedProfileVersion = true)
                },
                admitStartup = { RelayV2StartupAdmissionResult.Ready(profileB) },
                consentAutoConnect = {
                    downstreamCalls += 1
                    profileB.copy(autoConnect = true)
                },
                installExact = {
                    downstreamCalls += 1
                    true
                },
            )
            assertTrue(admissionDrift is RelayV2ExplicitConnectRefreshResult.ActiveProfileChanged)
            assertEquals(0, downstreamCalls)

            // A re-admission that did not advance the credential version is drift as well.
            val staleAdmission = explicitConnectRefreshOrchestration(
                expectedProfile = profileA,
                refreshActiveCredential = {
                    RelayV2RefreshApplyResult.StaleCredentialResponse(2)
                },
                admitStartup = { RelayV2StartupAdmissionResult.Ready(profileA) },
                consentAutoConnect = {
                    downstreamCalls += 1
                    profileA.copy(autoConnect = true)
                },
                installExact = {
                    downstreamCalls += 1
                    true
                },
            )
            assertTrue(staleAdmission is RelayV2ExplicitConnectRefreshResult.ActiveProfileChanged)
            assertEquals(0, downstreamCalls)

            // A typed non-ready admission settles on its own surface, never consented/installed.
            val settled = explicitConnectRefreshOrchestration(
                expectedProfile = profileA,
                refreshActiveCredential = {
                    RelayV2RefreshApplyResult.Applied(2, repairedProfileVersion = true)
                },
                admitStartup = { RelayV2StartupAdmissionResult.NoActiveProfile },
                consentAutoConnect = {
                    downstreamCalls += 1
                    profileA.copy(autoConnect = true)
                },
                installExact = {
                    downstreamCalls += 1
                    true
                },
            )
            assertEquals(
                RelayV2ExplicitConnectRefreshResult.AdmissionSettled(
                    RelayV2StartupAdmissionResult.NoActiveProfile,
                ),
                settled,
            )
            assertEquals(0, downstreamCalls)

            // A rejected install is reported as drift, never as a started successor.
            val rejectedInstall = explicitConnectRefreshOrchestration(
                expectedProfile = profileA,
                refreshActiveCredential = {
                    RelayV2RefreshApplyResult.Applied(2, repairedProfileVersion = true)
                },
                admitStartup = {
                    RelayV2StartupAdmissionResult.Ready(profileA.copy(credentialVersion = 2))
                },
                consentAutoConnect = { profileA.copy(credentialVersion = 2, autoConnect = true) },
                installExact = { false },
            )
            assertTrue(
                rejectedInstall is RelayV2ExplicitConnectRefreshResult.ActiveProfileChanged,
            )
        }
}
