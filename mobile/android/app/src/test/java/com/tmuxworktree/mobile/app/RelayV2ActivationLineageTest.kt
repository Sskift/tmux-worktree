package com.tmuxworktree.mobile.app

import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2CredentialReference
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2Profile
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The confirmed-enrollment profile and the durable admitted profile may differ only through
 * benign reconciliation repair (a bumped credential version) or prior connect consent
 * (autoConnect == true). Every identity/lineage-bearing field difference must refuse activation.
 */
class RelayV2ActivationLineageTest {
    @Test
    fun `benign credential-version and consent repair shares the activation lineage`() {
        val base = profile()
        assertTrue(base.sharesActivationLineageWith(base))
        assertTrue(base.sharesActivationLineageWith(base.copy(credentialVersion = 2)))
        assertTrue(
            base.sharesActivationLineageWith(
                base.copy(credentialVersion = 2, autoConnect = true),
            ),
        )
    }

    @Test
    fun `identity-bearing endpoint and host drift breaks the activation lineage`() {
        val base = profile()
        assertFalse(base.sharesActivationLineageWith(base.copy(hostId = "drifted-host")))
        assertFalse(
            base.sharesActivationLineageWith(
                base.copy(relayUrl = "wss://drifted.example.com/client"),
            ),
        )
        assertFalse(
            base.sharesActivationLineageWith(
                base.copy(issuerUrl = "https://drifted.example.com"),
            ),
        )
        assertFalse(
            base.sharesActivationLineageWith(
                base.copy(clientInstanceId = "another-install"),
            ),
        )
    }

    @Test
    fun `lineage-bearing profile activation generation and credential reference drift breaks lineage`() {
        val base = profile()
        assertFalse(base.sharesActivationLineageWith(base.copy(profileId = "relay-v2-other")))
        assertFalse(base.sharesActivationLineageWith(base.copy(activationGeneration = 1)))
        assertFalse(
            base.sharesActivationLineageWith(
                base.copy(credentialReference = RelayV2CredentialReference("credential-2")),
            ),
        )
    }

    private fun profile(): RelayV2Profile = RelayV2Profile(
        profileId = "relay-v2-profile",
        issuerUrl = "https://relay.example.com",
        relayUrl = "wss://relay.example.com/client",
        hostId = "mac-admin",
        principalId = "principal-1",
        grantId = "grant-1",
        clientInstanceId = "android-install-1",
        credentialReference = RelayV2CredentialReference("credential-1"),
        credentialVersion = 1,
    )
}
