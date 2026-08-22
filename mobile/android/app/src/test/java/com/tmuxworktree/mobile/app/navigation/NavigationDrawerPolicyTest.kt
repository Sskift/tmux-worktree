package com.tmuxworktree.mobile.app.navigation

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NavigationDrawerPolicyTest {
    @Test
    fun `terminal destinations reserve the left edge instead of opening the device drawer`() {
        assertFalse(deviceDrawerGesturesEnabled(V2Routes.TERMINAL))
        assertFalse(deviceDrawerGesturesEnabled("terminal/host%3Aterminal"))
    }

    @Test
    fun `device drawer gestures remain available on root destinations`() {
        assertTrue(deviceDrawerGesturesEnabled(V2Routes.INBOX))
        assertTrue(deviceDrawerGesturesEnabled(V2Routes.WORKSPACES))
        assertTrue(deviceDrawerGesturesEnabled(V2Routes.SETTINGS))
    }
}
