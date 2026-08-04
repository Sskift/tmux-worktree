package com.tmuxworktree.mobile.app

import com.tmuxworktree.mobile.core.relay.runtime.RelayV1ConnectionConfig
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

        listOf(payload.toString(), state.toString(), config.toString()).forEach { rendered ->
            assertFalse(rendered, rendered.contains(secret))
            assertTrue(rendered, rendered.contains("redacted"))
        }
    }
}
