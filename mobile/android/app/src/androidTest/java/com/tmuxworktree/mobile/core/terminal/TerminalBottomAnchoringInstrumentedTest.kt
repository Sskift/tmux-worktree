package com.tmuxworktree.mobile.core.terminal

import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class TerminalBottomAnchoringInstrumentedTest {
    @get:Rule
    val composeRule = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun rendererBottomTracksAViewportShrinkLikeTheIme() {
        val controller = TerminalWebViewController()
        val ready = AtomicBoolean(false)
        var viewportHeight by mutableStateOf(600.dp)

        composeRule.setContent {
            Box(
                modifier = Modifier
                    .width(320.dp)
                    .height(viewportHeight),
            ) {
                TerminalWebView(
                    controller = controller,
                    onReady = {
                        controller.write(
                            (1..80).joinToString(separator = "\r\n") { line ->
                                "terminal bottom anchor line $line"
                            },
                        )
                        controller.fit()
                        ready.set(true)
                    },
                    onViewLoss = {},
                    onFailure = { error("Terminal WebView failed: $it") },
                    onInput = {},
                    onResize = { _, _ -> },
                    modifier = Modifier.fillMaxSize(),
                )
            }
        }

        composeRule.waitUntil(timeoutMillis = 10_000) { ready.get() }
        SystemClock.sleep(500)
        assertBottomGapBelowOnePixel()

        composeRule.runOnIdle { viewportHeight = 260.dp }
        SystemClock.sleep(500)
        assertBottomGapBelowOnePixel()
    }

    private fun assertBottomGapBelowOnePixel() {
        val webView = composeRule.activity
            .findViewById<ViewGroup>(android.R.id.content)
            .findDescendantWebView()
        requireNotNull(webView) { "Terminal WebView was not attached" }
        val result = arrayOfNulls<String>(1)
        val latch = CountDownLatch(1)
        composeRule.activity.runOnUiThread {
            webView.evaluateJavascript(
                """
                (() => {
                  const xterm = document.querySelector('#terminal .xterm');
                  const screen = document.querySelector('#terminal .xterm-screen');
                  if (!xterm || !screen) return 9999;
                  const paddingBottom = Number.parseFloat(getComputedStyle(xterm).paddingBottom) || 0;
                  const terminalBottom = xterm.getBoundingClientRect().bottom - paddingBottom;
                  return Math.abs(terminalBottom - screen.getBoundingClientRect().bottom);
                })()
                """.trimIndent(),
            ) {
                result[0] = it
                latch.countDown()
            }
        }
        assertTrue("Timed out reading terminal geometry", latch.await(5, TimeUnit.SECONDS))
        val gap = requireNotNull(result[0]).toDouble()
        assertTrue("Terminal bottom gap was $gap px", gap < 1.0)
    }

    private fun View.findDescendantWebView(): WebView? {
        if (this is WebView) return this
        if (this !is ViewGroup) return null
        for (index in 0 until childCount) {
            getChildAt(index).findDescendantWebView()?.let { return it }
        }
        return null
    }
}
