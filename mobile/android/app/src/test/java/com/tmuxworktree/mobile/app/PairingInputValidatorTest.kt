package com.tmuxworktree.mobile.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingInputValidatorTest {
    @Test
    fun `release accepts wss and rejects every cleartext host`() {
        assertNull(validateUrl("wss://relay.example.com", debug = false))
        assertNull(validateUrl("wss://mac.local:8787", debug = false))

        listOf(
            "ws://10.0.2.2:8787",
            "ws://127.0.0.1:8787",
            "ws://localhost:8787",
            "ws://mac.local:8787",
            "ws://192.168.1.20:8787",
        ).forEach { url ->
            assertEquals(
                url,
                "Use wss:// to protect the pairing token and terminal content",
                validateUrl(url, debug = false),
            )
        }
    }

    @Test
    fun `debug cleartext exception is limited to emulator and loopback`() {
        listOf(
            "ws://10.0.2.2:8787",
            "ws://127.0.0.1:8787",
            "ws://localhost:8787",
        ).forEach { url -> assertNull(url, validateUrl(url, debug = true)) }

        listOf(
            "ws://[::1]:8787",
            "ws://mac.local:8787",
            "ws://192.168.1.20:8787",
            "ws://10.0.0.5:8787",
            "ws://relay.example.com",
        ).forEach { url ->
            val error = validateUrl(url, debug = true).orEmpty()
            assertTrue(url, error.contains("limited to emulator or loopback"))
            assertTrue(url, error.contains("Use wss://"))
        }
    }

    @Test
    fun `relay URL validation rejects credential and routing decorations`() {
        assertEquals("Relay URL is required", validateUrl("", debug = false))
        assertEquals(
            "Relay URL must start with wss://",
            validateUrl("relay.example.com", debug = false),
        )
        assertEquals(
            "Relay URL must not include credentials, a query, or a fragment",
            validateUrl("wss://user:secret@relay.example.com", debug = false),
        )
        assertEquals(
            "Relay URL must not include credentials, a query, or a fragment",
            validateUrl("wss://relay.example.com?token=secret", debug = false),
        )
        assertEquals(
            "Relay URL must not include a path",
            validateUrl("wss://relay.example.com/client", debug = false),
        )
        assertEquals(
            "Relay URL must not include a path",
            validateUrl("wss://relay.example.com//", debug = false),
        )
        assertEquals(
            "Relay URL must not include a path",
            validateUrl("wss://relay.example.com///", debug = false),
        )
        assertEquals(
            "Relay URL includes an invalid port",
            validateUrl("wss://relay.example.com:0", debug = false),
        )
    }

    @Test
    fun `credential validation never includes the credential in its error`() {
        val secret = "secret\nthat-must-not-appear"
        val error = PairingInputValidator.credentialError(secret, "mac-admin").orEmpty()

        assertEquals("Pairing token contains invalid characters", error)
        assertTrue(secret !in error)
    }

    private fun validateUrl(value: String, debug: Boolean): String? =
        PairingInputValidator.relayUrlError(
            value.trim(),
            allowDebugLoopbackCleartext = debug,
        )
}
