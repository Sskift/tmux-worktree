package com.tmuxworktree.mobile.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RelayV2EnrollmentDeviceLabelTest {
    @Test
    fun `Android model becomes a stable bounded enrollment label`() {
        assertEquals("Pixel 9 Pro", normalizedRelayV2EnrollmentDeviceLabel("  Pixel 9 Pro  "))
        assertEquals("设备", normalizedRelayV2EnrollmentDeviceLabel("设备"))
    }

    @Test
    fun `unusable Android models use a fixed schema-safe fallback`() {
        listOf(
            "",
            "   ",
            "Pixel\u0000Debug",
            "Pixel\rDebug",
            "Pixel\nDebug",
            "界".repeat(43),
        ).forEach { model ->
            assertEquals(model, "Android device", normalizedRelayV2EnrollmentDeviceLabel(model))
        }

        val fallback = normalizedRelayV2EnrollmentDeviceLabel("")
        assertTrue(fallback.toByteArray(Charsets.UTF_8).size <= 128)
        assertFalse(fallback.any { it == '\u0000' || it == '\r' || it == '\n' })
    }
}
