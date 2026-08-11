package com.tmuxworktree.mobile.app

import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2EnrollmentReviewParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class RelayV2EnrollmentReviewParserTest {
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
