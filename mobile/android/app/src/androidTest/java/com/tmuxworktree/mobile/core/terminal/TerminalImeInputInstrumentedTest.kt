package com.tmuxworktree.mobile.core.terminal

import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class TerminalImeInputInstrumentedTest {
    @get:Rule
    val composeRule = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun android229InputBeforeKeydownIsForwardedExactlyOnce() {
        val harness = launchTerminalHarness()
        evaluateJavascript(
            harness.webView,
            """
            (async () => {
              const textarea = document.querySelector('#terminal textarea');
              if (!textarea) return false;
              const marker = 'reply amber';
              const key229 = (type, character) => {
                const event = new KeyboardEvent(type, {
                  bubbles: true,
                  cancelable: true,
                  key: character,
                  code: character === ' ' ? 'Space' : `Key${'$'}{character.toUpperCase()}`,
                });
                Object.defineProperty(event, 'keyCode', { get: () => 229 });
                Object.defineProperty(event, 'which', { get: () => 229 });
                Object.defineProperty(event, 'isComposing', { get: () => false });
                return event;
              };
              for (const character of marker) {
                textarea.value += character;
                textarea.dispatchEvent(new InputEvent('input', {
                  bubbles: true,
                  cancelable: true,
                  composed: true,
                  data: character,
                  inputType: 'insertText',
                }));
                textarea.dispatchEvent(key229('keydown', character));
                await new Promise(resolve => setTimeout(resolve, 8));
              }
              textarea.dispatchEvent(key229('keyup', marker.at(-1)));
              return true;
            })()
            """.trimIndent(),
        )

        assertEventuallyExact(harness.forwarded, "reply amber")
    }

    @Test
    fun compositionFinalizeAndLateInputEmitOnlyOnce() {
        val harness = launchTerminalHarness()
        evaluateJavascript(
            harness.webView,
            """
            (async () => {
              const textarea = document.querySelector('#terminal textarea');
              if (!textarea) return false;
              textarea.dispatchEvent(new CompositionEvent('compositionstart', {
                bubbles: true,
                data: '',
              }));
              textarea.value = '你';
              textarea.dispatchEvent(new CompositionEvent('compositionupdate', {
                bubbles: true,
                data: '你',
              }));
              textarea.dispatchEvent(new CompositionEvent('compositionend', {
                bubbles: true,
                data: '你',
              }));
              await new Promise(resolve => setTimeout(resolve, 8));
              textarea.dispatchEvent(new InputEvent('input', {
                bubbles: true,
                cancelable: true,
                composed: true,
                data: '你',
                inputType: 'insertCompositionText',
              }));
              return true;
            })()
            """.trimIndent(),
        )

        assertEventuallyExact(harness.forwarded, "你")
    }

    private fun launchTerminalHarness(): TerminalHarness {
        val controller = TerminalWebViewController()
        val ready = AtomicBoolean(false)
        val forwarded = mutableStateListOf<String>()
        composeRule.setContent {
            TerminalWebView(
                controller = controller,
                onReady = { _, _, _ -> ready.set(true) },
                onViewLoss = {},
                onFailure = { error("Terminal WebView failed: $it") },
                onInput = { forwarded += it },
                onResize = { _, _ -> },
                modifier = Modifier.fillMaxSize(),
            )
        }
        composeRule.waitUntil(timeoutMillis = 10_000) { ready.get() }
        val webView = requireNotNull(
            composeRule.activity
                .findViewById<ViewGroup>(android.R.id.content)
                .findDescendantWebView(),
        ) { "Terminal WebView was not attached" }
        return TerminalHarness(webView, forwarded)
    }

    private fun evaluateJavascript(webView: WebView, script: String) {
        val submitted = CountDownLatch(1)
        composeRule.activity.runOnUiThread {
            webView.evaluateJavascript(script) { submitted.countDown() }
        }
        assertTrue("Timed out submitting IME regression sequence", submitted.await(5, TimeUnit.SECONDS))
    }

    private fun assertEventuallyExact(forwarded: List<String>, expected: String) {
        composeRule.waitUntil(timeoutMillis = 5_000) {
            forwarded.joinToString("").length >= expected.length
        }
        SystemClock.sleep(50)
        assertEquals(expected, forwarded.joinToString(""))
    }

    private data class TerminalHarness(
        val webView: WebView,
        val forwarded: List<String>,
    )

    private fun View.findDescendantWebView(): WebView? {
        if (this is WebView) return this
        if (this !is ViewGroup) return null
        for (index in 0 until childCount) {
            getChildAt(index).findDescendantWebView()?.let { return it }
        }
        return null
    }
}
