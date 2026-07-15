package com.tmuxworktree.mobile.app

import com.tmuxworktree.mobile.core.relay.runtime.RelayV1ConnectionConfig
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2CredentialBlob
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2EnrollmentExchangeResponse
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2EnrollmentReviewDraft
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SensitivePairingDataTest {
    @Test
    fun `pairing and connection objects redact secrets when stringified`() {
        val secret = "relay-secret-for-redaction-test"
        val payload = PairingPayload(
            relayUrl = "wss://user:$secret@relay.example.com?token=$secret",
            token = secret,
            hostId = "mac-admin",
        )
        val state = V2UiState(
            pairingRelayUrl = payload.relayUrl,
            pairingToken = secret,
            pairingHostId = payload.hostId,
        )
        val config = RelayV1ConnectionConfig(
            relayUrl = "wss://relay.example.com",
            bearerToken = secret,
            preferredHostId = "mac-admin",
        )
        val enrollment = RelayV2EnrollmentReviewDraft(
            issuerUrl = "https://relay.example.com",
            relayUrl = "wss://relay.example.com/client",
            hostId = "mac-admin",
            enrollmentId = "enrollment-1",
            enrollmentCode = secret,
        )
        val credential = RelayV2CredentialBlob(
            credentialVersion = 1,
            issuerUrl = enrollment.issuerUrl,
            relayUrl = enrollment.relayUrl,
            hostId = enrollment.hostId,
            clientInstanceId = "android-install",
            principalId = "principal-1",
            grantId = "grant-1",
            accessToken = "twcap2.$secret",
            accessExpiresAtMs = 2_000,
            refreshToken = "twref2.$secret",
            refreshExpiresAtMs = 3_000,
        )
        val exchangeResponse = RelayV2EnrollmentExchangeResponse(
            exchangeAttemptId = "attempt-1",
            principalId = "principal-1",
            grantId = "grant-1",
            hostId = enrollment.hostId,
            relayUrl = enrollment.relayUrl,
            accessToken = "twcap2.$secret",
            accessExpiresAtMs = 2_000,
            refreshToken = "twref2.$secret",
            refreshExpiresAtMs = 3_000,
        )

        listOf(
            payload.toString(),
            state.toString(),
            config.toString(),
            enrollment.toString(),
            credential.toString(),
            exchangeResponse.toString(),
        ).forEach { rendered ->
            assertFalse(rendered, rendered.contains(secret))
            assertTrue(rendered, rendered.contains("redacted"))
        }
    }
}
