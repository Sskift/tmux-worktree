package com.tmuxworktree.mobile.app

import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2EnrollmentReviewParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PairingPayloadParserTest {
    @Test
    fun `parses canonical percent encoded pairing deep link`() {
        val payload = PairingPayloadParser.parse(
            "tmuxworktree://pair?relayUrl=wss%3A%2F%2Frelay.example.com%2Fmobile" +
                "&token=a%2Bb%3Dc&hostId=mac-admin",
        )

        assertEquals(
            PairingPayload(
                relayUrl = "wss://relay.example.com/mobile",
                token = "a+b=c",
                hostId = "mac-admin",
            ),
            payload,
        )
    }

    @Test
    fun `accepts legacy relay secret and host aliases`() {
        val payload = PairingPayloadParser.parse(
            "tmuxworktree://pair?relay=wss%3A%2F%2Frelay.example.com" +
                "&relaySecret=legacy-token&host=legacy-host",
        )

        assertEquals("wss://relay.example.com", payload?.relayUrl)
        assertEquals("legacy-token", payload?.token)
        assertEquals("legacy-host", payload?.hostId)
    }

    @Test
    fun `returns null for missing or irrelevant payloads`() {
        assertNull(PairingPayloadParser.parse(null))
        assertNull(PairingPayloadParser.parse("  "))
        assertNull(PairingPayloadParser.parse("tmuxworktree://pair"))
        assertNull(PairingPayloadParser.parse("tmuxworktree://pair?hostId=mac-admin"))
    }

    @Test
    fun `malformed query encoding is rejected without crashing intent handling`() {
        listOf(
            "%",
            "%2",
            "%ZZ",
            "%C3%28",
        ).forEach { malformedToken ->
            assertNull(
                malformedToken,
                PairingPayloadParser.parse(
                    "tmuxworktree://pair?relayUrl=wss%3A%2F%2Frelay.example.com" +
                        "&token=$malformedToken",
                ),
            )
        }
        assertNull(
            PairingPayloadParser.parse(
                "tmuxworktree://pair?relayUrl=wss%3A%2F%2Frelay.example.com" +
                    "&token=valid&%ZZ",
            ),
        )
    }

    @Test
    fun `rejects unexpected scheme host and authority decorations`() {
        val query = "?relayUrl=wss%3A%2F%2Frelay.example.com&token=valid"
        listOf(
            "https://pair$query",
            "tmuxworktree://pair.example.com$query",
            "tmuxworktree://not-pair$query",
            "tmuxworktree://user@pair$query",
            "tmuxworktree://pair:443$query",
            "tmuxworktree://pair/unexpected$query",
            "tmuxworktree://pair$query#fragment",
        ).forEach { invalidPayload ->
            assertNull(invalidPayload, PairingPayloadParser.parse(invalidPayload))
        }
    }

    @Test
    fun `rejects decoded fields above their individual limits`() {
        val overlongRelayUrl = "r".repeat(2_049)
        val overlongToken = "t".repeat(4_097)
        val overlongHost = "h".repeat(129)

        assertNull(
            PairingPayloadParser.parse(
                "tmuxworktree://pair?relayUrl=$overlongRelayUrl&token=valid",
            ),
        )
        assertNull(
            PairingPayloadParser.parse(
                "tmuxworktree://pair?relayUrl=wss%3A%2F%2Frelay.example.com&token=$overlongToken",
            ),
        )
        assertNull(
            PairingPayloadParser.parse(
                "tmuxworktree://pair?relayUrl=wss%3A%2F%2Frelay.example.com" +
                    "&token=valid&hostId=$overlongHost",
            ),
        )
    }

    @Test
    fun `v2 enrollment parses only as an explicit review draft`() {
        val raw = "tmuxworktree://enroll?v=2" +
            "&issuerUrl=https%3A%2F%2Frelay.example.com" +
            "&relayUrl=wss%3A%2F%2Frelay.example.com%2Fclient" +
            "&hostId=mac-admin" +
            "&enrollmentId=enrollment-1" +
            "&enrollmentCode=twenroll2.one-time-code"

        val draft = RelayV2EnrollmentReviewParser.parse(raw)

        assertEquals("https://relay.example.com", draft?.issuerUrl)
        assertEquals("wss://relay.example.com/client", draft?.relayUrl)
        assertEquals("mac-admin", draft?.hostId)
        assertEquals("enrollment-1", draft?.enrollmentId)
        assertEquals("twenroll2.one-time-code", draft?.enrollmentCode)
        assertNull(PairingPayloadParser.parse(raw))
    }

    @Test
    fun `v2 enrollment rejects decorated or non-client endpoints`() {
        val invalidEndpoints = listOf(
            "issuerUrl=https%3A%2F%2Fuser%40relay.example.com" +
                "&relayUrl=wss%3A%2F%2Frelay.example.com%2Fclient",
            "issuerUrl=https%3A%2F%2Frelay.example.com%3Fsource%3Dqr" +
                "&relayUrl=wss%3A%2F%2Frelay.example.com%2Fclient",
            "issuerUrl=https%3A%2F%2Frelay.example.com" +
                "&relayUrl=wss%3A%2F%2Frelay.example.com%2Flegacy",
        )

        invalidEndpoints.forEach { endpoints ->
            assertNull(
                RelayV2EnrollmentReviewParser.parse(
                    "tmuxworktree://enroll?v=2&$endpoints" +
                        "&hostId=mac-admin" +
                        "&enrollmentId=enrollment-1" +
                        "&enrollmentCode=twenroll2.one-time-code",
                ),
            )
        }
    }
}
