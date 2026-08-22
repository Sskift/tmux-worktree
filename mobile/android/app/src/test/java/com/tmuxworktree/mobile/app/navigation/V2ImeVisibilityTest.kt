package com.tmuxworktree.mobile.app.navigation

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class V2ImeVisibilityTest {
    @Test
    fun `system bar alone is not mistaken for the keyboard`() {
        assertFalse(isImeVisibleFromVisibleFrame(rootHeight = 2220, visibleBottom = 2154))
    }

    @Test
    fun `keyboard-sized visible frame reduction is detected`() {
        assertTrue(isImeVisibleFromVisibleFrame(rootHeight = 2220, visibleBottom = 1398))
    }
}
