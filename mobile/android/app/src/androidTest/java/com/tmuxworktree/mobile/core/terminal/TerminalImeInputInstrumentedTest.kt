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
    fun rapidAndroid229TextareaChangesAreForwardedExactlyOnce() {
        val marker = "echo E2E_TERM_IME_A"
        val controller = TerminalWebViewController()
        val ready = AtomicBoolean(false)
        val forwarded = mutableStateListOf<String>()

        composeRule.setContent {
            TerminalWebView(
                controller = controller,
                onReady = { ready.set(true) },
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
        val submitted = CountDownLatch(1)
        composeRule.activity.runOnUiThread {
            webView.evaluateJavascript(
                """
                (() => {
                  const textarea = document.querySelector('#terminal textarea');
                  if (!textarea) return false;
                  const key229 = type => {
                    const event = new KeyboardEvent(type, { bubbles: true, cancelable: true });
                    Object.defineProperty(event, 'keyCode', { get: () => 229 });
                    Object.defineProperty(event, 'which', { get: () => 229 });
                    return event;
                  };
                  for (const character of ${jsonString(marker)}) {
                    textarea.dispatchEvent(key229('keydown'));
                    textarea.value += character;
                    textarea.dispatchEvent(key229('keyup'));
                  }
                  return true;
                })()
                """.trimIndent(),
            ) {
                submitted.countDown()
            }
        }

        assertTrue("Timed out submitting Android IME events", submitted.await(5, TimeUnit.SECONDS))
        composeRule.waitUntil(timeoutMillis = 5_000) { forwarded.joinToString("") == marker }
        SystemClock.sleep(50)
        assertEquals(marker, forwarded.joinToString(""))
    }

    @Test
    fun inputBeforeAndroid229KeydownAcrossEventTurnsIsForwardedExactlyOnce() {
        val marker = "reply amber"
        val controller = TerminalWebViewController()
        val ready = AtomicBoolean(false)
        val forwarded = mutableStateListOf<String>()

        composeRule.setContent {
            TerminalWebView(
                controller = controller,
                onReady = { ready.set(true) },
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
        val submitted = CountDownLatch(1)
        composeRule.activity.runOnUiThread {
            webView.evaluateJavascript(
                """
                (async () => {
                  const textarea = document.querySelector('#terminal textarea');
                  if (!textarea) return false;
                  const delayPastTextareaFallback = () =>
                    new Promise(resolve => setTimeout(resolve, 8));
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
                  for (const character of ${jsonString(marker)}) {
                    textarea.value += character;
                    textarea.dispatchEvent(new InputEvent('input', {
                      bubbles: true,
                      cancelable: true,
                      composed: true,
                      data: character,
                      inputType: 'insertText',
                    }));
                    textarea.dispatchEvent(key229('keydown', character));
                    // Reproduce xtermjs/xterm.js#5887: the 229 textarea fallback settles before
                    // the next input, while keyup has not reset _keyDownSeen yet.
                    await delayPastTextareaFallback();
                  }
                  textarea.dispatchEvent(key229('keyup', marker.at(-1)));
                  return true;
                })()
                """.trimIndent(),
            ) {
                submitted.countDown()
            }
        }

        assertTrue("Timed out submitting reversed IME events", submitted.await(5, TimeUnit.SECONDS))
        composeRule.waitUntil(timeoutMillis = 5_000) { forwarded.joinToString("") == marker }
        SystemClock.sleep(50)
        assertEquals(marker, forwarded.joinToString(""))
    }

    @Test
    fun android229KeydownBeforeInputDoesNotDuplicateTextareaFallback() {
        val marker = "xy"
        val controller = TerminalWebViewController()
        val ready = AtomicBoolean(false)
        val forwarded = mutableStateListOf<String>()

        composeRule.setContent {
            TerminalWebView(
                controller = controller,
                onReady = { ready.set(true) },
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
        val submitted = CountDownLatch(1)
        composeRule.activity.runOnUiThread {
            webView.evaluateJavascript(
                """
                (async () => {
                  const textarea = document.querySelector('#terminal textarea');
                  if (!textarea) return false;
                  const key229 = (type, character) => {
                    const event = new KeyboardEvent(type, {
                      bubbles: true,
                      cancelable: true,
                      key: character,
                      code: `Key${'$'}{character.toUpperCase()}`,
                    });
                    Object.defineProperty(event, 'keyCode', { get: () => 229 });
                    Object.defineProperty(event, 'which', { get: () => 229 });
                    Object.defineProperty(event, 'isComposing', { get: () => false });
                    return event;
                  };
                  for (const character of ${jsonString(marker)}) {
                    textarea.dispatchEvent(key229('keydown', character));
                    textarea.value += character;
                    textarea.dispatchEvent(new InputEvent('input', {
                      bubbles: true,
                      cancelable: true,
                      composed: true,
                      data: character,
                      inputType: 'insertText',
                    }));
                    textarea.dispatchEvent(key229('keyup', character));
                    await new Promise(resolve => setTimeout(resolve, 8));
                  }
                  return true;
                })()
                """.trimIndent(),
            ) {
                submitted.countDown()
            }
        }

        assertTrue("Timed out submitting ordered IME events", submitted.await(5, TimeUnit.SECONDS))
        composeRule.waitUntil(timeoutMillis = 5_000) { forwarded.joinToString("") == marker }
        SystemClock.sleep(50)
        assertEquals(marker, forwarded.joinToString(""))
    }

    @Test
    fun inputArrivingAfterAndroid229FallbackWasSentIsConsumedExactlyOnce() {
        val marker = "x"
        val controller = TerminalWebViewController()
        val ready = AtomicBoolean(false)
        val forwarded = mutableStateListOf<String>()

        composeRule.setContent {
            TerminalWebView(
                controller = controller,
                onReady = { ready.set(true) },
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
        val submitted = CountDownLatch(1)
        composeRule.activity.runOnUiThread {
            webView.evaluateJavascript(
                """
                (async () => {
                  const textarea = document.querySelector('#terminal textarea');
                  if (!textarea) return false;
                  const key229 = type => {
                    const event = new KeyboardEvent(type, {
                      bubbles: true,
                      cancelable: true,
                      key: 'x',
                      code: 'KeyX',
                    });
                    Object.defineProperty(event, 'keyCode', { get: () => 229 });
                    Object.defineProperty(event, 'which', { get: () => 229 });
                    Object.defineProperty(event, 'isComposing', { get: () => false });
                    return event;
                  };
                  textarea.dispatchEvent(key229('keydown'));
                  textarea.value += 'x';
                  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
                  // Let CompositionHelper's 229 fallback observe the textarea mutation and emit x.
                  await new Promise(resolve => setTimeout(resolve, 8));
                  // Chromium may deliver the authoritative input notification in a later task,
                  // after the fallback already emitted the same mutation.
                  textarea.dispatchEvent(new InputEvent('input', {
                    bubbles: true,
                    cancelable: true,
                    composed: true,
                    data: 'x',
                    inputType: 'insertText',
                  }));
                  textarea.dispatchEvent(key229('keyup'));
                  return true;
                })()
                """.trimIndent(),
            ) {
                submitted.countDown()
            }
        }

        assertTrue("Timed out submitting late fallback input", submitted.await(5, TimeUnit.SECONDS))
        composeRule.waitUntil(timeoutMillis = 5_000) { forwarded.isNotEmpty() }
        SystemClock.sleep(50)
        assertEquals(marker, forwarded.joinToString(""))
    }

    @Test
    fun finalInputArrivingAfterCompositionFinalizeWasSentIsConsumedExactlyOnce() {
        val marker = "你"
        val controller = TerminalWebViewController()
        val ready = AtomicBoolean(false)
        val forwarded = mutableStateListOf<String>()

        composeRule.setContent {
            TerminalWebView(
                controller = controller,
                onReady = { ready.set(true) },
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
        val submitted = CountDownLatch(1)
        composeRule.activity.runOnUiThread {
            webView.evaluateJavascript(
                """
                (async () => {
                  const textarea = document.querySelector('#terminal textarea');
                  if (!textarea) return false;
                  textarea.dispatchEvent(new CompositionEvent('compositionstart', {
                    bubbles: true,
                    cancelable: true,
                    data: '',
                  }));
                  textarea.value = '你';
                  textarea.setSelectionRange(1, 1);
                  textarea.dispatchEvent(new CompositionEvent('compositionupdate', {
                    bubbles: true,
                    cancelable: true,
                    data: '你',
                  }));
                  // Let CompositionHelper persist the updated composition selection.
                  await new Promise(resolve => setTimeout(resolve, 8));
                  textarea.dispatchEvent(new CompositionEvent('compositionend', {
                    bubbles: true,
                    cancelable: true,
                    data: '你',
                  }));
                  // Let the composition finalize timer emit the committed text first.
                  await new Promise(resolve => setTimeout(resolve, 8));
                  textarea.dispatchEvent(new InputEvent('input', {
                    bubbles: true,
                    cancelable: true,
                    composed: true,
                    data: '你',
                    inputType: 'insertText',
                  }));
                  return true;
                })()
                """.trimIndent(),
            ) {
                submitted.countDown()
            }
        }

        assertTrue("Timed out submitting late composition input", submitted.await(5, TimeUnit.SECONDS))
        composeRule.waitUntil(timeoutMillis = 5_000) { forwarded.isNotEmpty() }
        SystemClock.sleep(50)
        assertEquals(marker, forwarded.joinToString(""))
    }

    @Test
    fun mergedAndroid229FallbackIsConsumedByFragmentedLateInputs() {
        val harness = launchTerminalHarness()
        evaluateJavascript(
            harness.webView,
            """
            (async () => {
              const textarea = document.querySelector('#terminal textarea');
              if (!textarea) return false;
              const key229 = type => {
                const event = new KeyboardEvent(type, {
                  bubbles: true,
                  cancelable: true,
                  key: 'e',
                  code: 'KeyE',
                });
                Object.defineProperty(event, 'keyCode', { get: () => 229 });
                Object.defineProperty(event, 'which', { get: () => 229 });
                Object.defineProperty(event, 'isComposing', { get: () => false });
                return event;
              };
              textarea.dispatchEvent(key229('keydown'));
              textarea.value += 'e';
              // d034164 keeps one fallback timer while another 229 keydown overlaps it.
              textarea.dispatchEvent(key229('keydown'));
              textarea.value += 'e';
              textarea.setSelectionRange(2, 2);
              await new Promise(resolve => setTimeout(resolve, 8));
              for (let index = 0; index < 2; index += 1) {
                textarea.dispatchEvent(new InputEvent('input', {
                  bubbles: true,
                  cancelable: true,
                  composed: true,
                  data: 'e',
                  inputType: 'insertText',
                }));
              }
              textarea.dispatchEvent(key229('keyup'));
              return true;
            })()
            """.trimIndent(),
        )

        assertEventuallyExact(harness.forwarded, "ee")
    }

    @Test
    fun independentlySentFallbacksAggregateBeforeFragmentedLateInputs() {
        val harness = launchTerminalHarness()
        evaluateJavascript(
            harness.webView,
            """
            (async () => {
              const textarea = document.querySelector('#terminal textarea');
              if (!textarea) return false;
              const key229 = type => {
                const event = new KeyboardEvent(type, {
                  bubbles: true,
                  cancelable: true,
                  key: 'e',
                  code: 'KeyE',
                });
                Object.defineProperty(event, 'keyCode', { get: () => 229 });
                Object.defineProperty(event, 'which', { get: () => 229 });
                Object.defineProperty(event, 'isComposing', { get: () => false });
                return event;
              };
              textarea.dispatchEvent(key229('keydown'));
              textarea.value = 'e';
              textarea.setSelectionRange(1, 1);
              await new Promise(resolve => setTimeout(resolve, 8));
              // A second independent fallback sends before either input notification arrives.
              textarea.dispatchEvent(key229('keydown'));
              textarea.value = 'ee';
              textarea.setSelectionRange(2, 2);
              await new Promise(resolve => setTimeout(resolve, 8));
              for (let index = 0; index < 2; index += 1) {
                textarea.dispatchEvent(new InputEvent('input', {
                  bubbles: true,
                  cancelable: true,
                  composed: true,
                  data: 'e',
                  inputType: 'insertText',
                }));
              }
              textarea.dispatchEvent(key229('keyup'));
              return true;
            })()
            """.trimIndent(),
        )

        assertEventuallyExact(harness.forwarded, "ee")
    }

    @Test
    fun consumedLateFallbackInputCannotCancelNextGenerationFallback() {
        val harness = launchTerminalHarness()
        evaluateJavascript(
            harness.webView,
            """
            (async () => {
              const textarea = document.querySelector('#terminal textarea');
              if (!textarea) return false;
              const key229 = (type, key) => {
                const event = new KeyboardEvent(type, {
                  bubbles: true,
                  cancelable: true,
                  key,
                  code: `Key${'$'}{key.toUpperCase()}`,
                });
                Object.defineProperty(event, 'keyCode', { get: () => 229 });
                Object.defineProperty(event, 'which', { get: () => 229 });
                Object.defineProperty(event, 'isComposing', { get: () => false });
                return event;
              };

              textarea.dispatchEvent(key229('keydown', 'a'));
              textarea.value = 'a';
              textarea.setSelectionRange(1, 1);
              await new Promise(resolve => setTimeout(resolve, 8));

              // k1 fallback has sent a and left a source-generation receipt. k2 now owns a new
              // fallback ticket. The late k1 input must consume only k1's receipt, not cancel k2.
              textarea.dispatchEvent(key229('keydown', 'b'));
              textarea.dispatchEvent(new InputEvent('input', {
                bubbles: true,
                cancelable: true,
                composed: true,
                data: 'a',
                inputType: 'insertText',
              }));
              textarea.value = 'ab';
              textarea.setSelectionRange(2, 2);
              // Deliberately omit k2's input notification; its fallback must still send b.
              await new Promise(resolve => setTimeout(resolve, 8));
              textarea.dispatchEvent(key229('keyup', 'b'));
              return true;
            })()
            """.trimIndent(),
        )

        assertEventuallyExact(harness.forwarded, "ab")
    }

    @Test
    fun fragmentedAuthoritativeInputsCoverCrossGenerationTimerWithoutReplay() {
        val harness = launchTerminalHarness()
        evaluateJavascript(
            harness.webView,
            """
            (async () => {
              const textarea = document.querySelector('#terminal textarea');
              if (!textarea) return false;
              const key229 = (type, key) => {
                const event = new KeyboardEvent(type, {
                  bubbles: true,
                  cancelable: true,
                  key,
                  code: `Key${'$'}{key.toUpperCase()}`,
                });
                Object.defineProperty(event, 'keyCode', { get: () => 229 });
                Object.defineProperty(event, 'which', { get: () => 229 });
                Object.defineProperty(event, 'isComposing', { get: () => false });
                return event;
              };

              textarea.dispatchEvent(key229('keydown', 'a'));
              // k2 arrives before k1's zero-delay timer; one transition ticket spans both rounds.
              textarea.dispatchEvent(key229('keydown', 'b'));
              textarea.value = 'ab';
              textarea.setSelectionRange(2, 2);
              for (const data of ['a', 'b']) {
                textarea.dispatchEvent(new InputEvent('input', {
                  bubbles: true,
                  cancelable: true,
                  composed: true,
                  data,
                  inputType: 'insertText',
                }));
              }
              await new Promise(resolve => setTimeout(resolve, 8));
              textarea.dispatchEvent(key229('keyup', 'b'));
              return true;
            })()
            """.trimIndent(),
        )

        assertEventuallyExact(harness.forwarded, "ab")
    }

    @Test
    fun partiallyCoveredCrossGenerationTimerSendsOnlyUncoveredSuffix() {
        val harness = launchTerminalHarness()
        evaluateJavascript(
            harness.webView,
            """
            (async () => {
              const textarea = document.querySelector('#terminal textarea');
              if (!textarea) return false;
              const key229 = (type, key) => {
                const event = new KeyboardEvent(type, {
                  bubbles: true,
                  cancelable: true,
                  key,
                  code: `Key${'$'}{key.toUpperCase()}`,
                });
                Object.defineProperty(event, 'keyCode', { get: () => 229 });
                Object.defineProperty(event, 'which', { get: () => 229 });
                Object.defineProperty(event, 'isComposing', { get: () => false });
                return event;
              };

              textarea.dispatchEvent(key229('keydown', 'a'));
              textarea.dispatchEvent(key229('keydown', 'b'));
              textarea.value = 'ab';
              textarea.setSelectionRange(2, 2);
              textarea.dispatchEvent(new InputEvent('input', {
                bubbles: true,
                cancelable: true,
                composed: true,
                data: 'a',
                inputType: 'insertText',
              }));
              // The timer must subtract authoritative a and fallback only the uncovered b.
              await new Promise(resolve => setTimeout(resolve, 8));
              textarea.dispatchEvent(key229('keyup', 'b'));
              return true;
            })()
            """.trimIndent(),
        )

        assertEventuallyExact(harness.forwarded, "ab")
    }

    @Test
    fun pending229FallbackSettlesBeforeNon229Keypress() {
        val harness = launchTerminalHarness()
        evaluateJavascript(
            harness.webView,
            """
            (async () => {
              const textarea = document.querySelector('#terminal textarea');
              if (!textarea) return false;
              const keyboardEvent = (type, key, keyCode, charCode) => {
                const event = new KeyboardEvent(type, {
                  bubbles: true,
                  cancelable: true,
                  key,
                  code: key === 'Enter' ? 'Enter' : `Key${'$'}{key.toUpperCase()}`,
                });
                Object.defineProperty(event, 'keyCode', { get: () => keyCode });
                Object.defineProperty(event, 'which', { get: () => charCode || keyCode });
                Object.defineProperty(event, 'charCode', { get: () => charCode });
                Object.defineProperty(event, 'isComposing', { get: () => false });
                return event;
              };

              textarea.dispatchEvent(keyboardEvent('keydown', 'a', 229, 0));
              textarea.value = 'a';
              textarea.setSelectionRange(1, 1);
              // Do not yield: k1's timer is still pending when a normal k2 starts.
              textarea.dispatchEvent(keyboardEvent('keydown', 'b', 66, 0));
              textarea.dispatchEvent(keyboardEvent('keypress', 'b', 98, 98));
              textarea.value = 'ab';
              textarea.setSelectionRange(2, 2);
              textarea.dispatchEvent(new InputEvent('input', {
                bubbles: true,
                cancelable: true,
                composed: true,
                data: 'b',
                inputType: 'insertText',
              }));
              await new Promise(resolve => setTimeout(resolve, 8));
              textarea.dispatchEvent(keyboardEvent('keyup', 'b', 66, 0));
              return true;
            })()
            """.trimIndent(),
        )

        assertEventuallyExact(harness.forwarded, "ab")
    }

    @Test
    fun pending229FallbackSettlesBeforeCarriageReturn() {
        val harness = launchTerminalHarness()
        evaluateJavascript(
            harness.webView,
            """
            (async () => {
              const textarea = document.querySelector('#terminal textarea');
              if (!textarea) return false;
              const keyboardEvent = (type, key, keyCode) => {
                const event = new KeyboardEvent(type, {
                  bubbles: true,
                  cancelable: true,
                  key,
                  code: key === 'Enter' ? 'Enter' : `Key${'$'}{key.toUpperCase()}`,
                });
                Object.defineProperty(event, 'keyCode', { get: () => keyCode });
                Object.defineProperty(event, 'which', { get: () => keyCode });
                Object.defineProperty(event, 'charCode', { get: () => 0 });
                Object.defineProperty(event, 'isComposing', { get: () => false });
                return event;
              };

              textarea.dispatchEvent(keyboardEvent('keydown', 'a', 229));
              textarea.value = 'a';
              textarea.setSelectionRange(1, 1);
              textarea.dispatchEvent(keyboardEvent('keydown', 'Enter', 13));
              await new Promise(resolve => setTimeout(resolve, 8));
              textarea.dispatchEvent(keyboardEvent('keyup', 'Enter', 13));
              return true;
            })()
            """.trimIndent(),
        )

        assertEventuallyExact(harness.forwarded, "a\r")
    }

    @Test
    fun terminalResetSettlesPending229FallbackBeforeClearingTextarea() {
        val harness = launchTerminalHarness()
        evaluateJavascript(
            harness.webView,
            """
            (async () => {
              const textarea = document.querySelector('#terminal textarea');
              if (!textarea || typeof window.twReset !== 'function') return false;
              const event = new KeyboardEvent('keydown', {
                bubbles: true,
                cancelable: true,
                key: 'a',
                code: 'KeyA',
              });
              Object.defineProperty(event, 'keyCode', { get: () => 229 });
              Object.defineProperty(event, 'which', { get: () => 229 });
              Object.defineProperty(event, 'isComposing', { get: () => false });
              textarea.dispatchEvent(event);
              textarea.value = 'a';
              textarea.setSelectionRange(1, 1);
              window.twReset('');
              await new Promise(resolve => setTimeout(resolve, 8));
              return true;
            })()
            """.trimIndent(),
        )

        assertEventuallyExact(harness.forwarded, "a")
    }

    @Test
    fun deleteInputBefore229KeydownEmitsOneDelWithoutFallbackReplay() {
        val harness = launchTerminalHarness()
        evaluateJavascript(
            harness.webView,
            """
            (async () => {
              const textarea = document.querySelector('#terminal textarea');
              if (!textarea) return false;
              const key229 = type => {
                const event = new KeyboardEvent(type, {
                  bubbles: true,
                  cancelable: true,
                  key: 'Backspace',
                  code: 'Backspace',
                });
                Object.defineProperty(event, 'keyCode', { get: () => 229 });
                Object.defineProperty(event, 'which', { get: () => 229 });
                Object.defineProperty(event, 'isComposing', { get: () => false });
                return event;
              };

              textarea.value = 'a';
              textarea.setSelectionRange(1, 1);
              textarea.value = '';
              textarea.setSelectionRange(0, 0);
              textarea.dispatchEvent(new InputEvent('input', {
                bubbles: true,
                cancelable: true,
                composed: true,
                data: null,
                inputType: 'deleteContentBackward',
              }));
              // Chromium may deliver the 229 keydown after the authoritative delete input.
              textarea.dispatchEvent(key229('keydown'));
              await new Promise(resolve => setTimeout(resolve, 8));
              textarea.dispatchEvent(key229('keyup'));
              return true;
            })()
            """.trimIndent(),
        )

        assertEventuallyExact(harness.forwarded, "\u007f")
    }

    @Test
    fun delete229KeydownBeforeInputEmitsOneDelWithoutFallbackReplay() {
        val harness = launchTerminalHarness()
        evaluateJavascript(
            harness.webView,
            """
            (async () => {
              const textarea = document.querySelector('#terminal textarea');
              if (!textarea) return false;
              const event = new KeyboardEvent('keydown', {
                bubbles: true,
                cancelable: true,
                key: 'Backspace',
                code: 'Backspace',
              });
              Object.defineProperty(event, 'keyCode', { get: () => 229 });
              Object.defineProperty(event, 'which', { get: () => 229 });
              Object.defineProperty(event, 'isComposing', { get: () => false });
              textarea.value = 'a';
              textarea.setSelectionRange(1, 1);
              textarea.dispatchEvent(event);
              textarea.value = '';
              textarea.setSelectionRange(0, 0);
              textarea.dispatchEvent(new InputEvent('input', {
                bubbles: true,
                cancelable: true,
                composed: true,
                data: null,
                inputType: 'deleteContentBackward',
              }));
              await new Promise(resolve => setTimeout(resolve, 8));
              return true;
            })()
            """.trimIndent(),
        )

        assertEventuallyExact(harness.forwarded, "\u007f")
    }

    @Test
    fun twoPending229BackspacesFallbackToTwoDelEvents() {
        val harness = launchTerminalHarness()
        evaluateJavascript(
            harness.webView,
            """
            (async () => {
              const textarea = document.querySelector('#terminal textarea');
              if (!textarea) return false;
              const key229 = () => {
                const event = new KeyboardEvent('keydown', {
                  bubbles: true,
                  cancelable: true,
                  key: 'Backspace',
                  code: 'Backspace',
                });
                Object.defineProperty(event, 'keyCode', { get: () => 229 });
                Object.defineProperty(event, 'which', { get: () => 229 });
                Object.defineProperty(event, 'isComposing', { get: () => false });
                return event;
              };

              textarea.value = 'ab';
              textarea.setSelectionRange(2, 2);
              textarea.dispatchEvent(key229());
              textarea.dispatchEvent(key229());
              textarea.value = '';
              textarea.setSelectionRange(0, 0);
              await new Promise(resolve => setTimeout(resolve, 8));
              return true;
            })()
            """.trimIndent(),
        )

        assertEventuallyExact(harness.forwarded, "\u007f\u007f")
    }

    @Test
    fun lateDeleteInputConsumesFallbackDelReceiptExactlyOnce() {
        val harness = launchTerminalHarness()
        evaluateJavascript(
            harness.webView,
            """
            (async () => {
              const textarea = document.querySelector('#terminal textarea');
              if (!textarea) return false;
              const event = new KeyboardEvent('keydown', {
                bubbles: true,
                cancelable: true,
                key: 'Backspace',
                code: 'Backspace',
              });
              Object.defineProperty(event, 'keyCode', { get: () => 229 });
              Object.defineProperty(event, 'which', { get: () => 229 });
              Object.defineProperty(event, 'isComposing', { get: () => false });
              textarea.value = 'a';
              textarea.setSelectionRange(1, 1);
              textarea.dispatchEvent(event);
              textarea.value = '';
              textarea.setSelectionRange(0, 0);
              await new Promise(resolve => setTimeout(resolve, 8));
              textarea.dispatchEvent(new InputEvent('input', {
                bubbles: true,
                cancelable: true,
                composed: true,
                data: null,
                inputType: 'deleteContentBackward',
              }));
              return true;
            })()
            """.trimIndent(),
        )

        assertEventuallyExact(harness.forwarded, "\u007f")
    }

    @Test
    fun pendingInsertThenTwoDeletesReduceToOneNetDel() {
        val harness = launchTerminalHarness()
        evaluateJavascript(
            harness.webView,
            """
            (async () => {
              const textarea = document.querySelector('#terminal textarea');
              if (!textarea) return false;
              const key229 = (key, code) => {
                const event = new KeyboardEvent('keydown', {
                  bubbles: true,
                  cancelable: true,
                  key,
                  code,
                });
                Object.defineProperty(event, 'keyCode', { get: () => 229 });
                Object.defineProperty(event, 'which', { get: () => 229 });
                Object.defineProperty(event, 'isComposing', { get: () => false });
                return event;
              };

              textarea.value = 'a';
              textarea.setSelectionRange(1, 1);
              textarea.dispatchEvent(key229('b', 'KeyB'));
              textarea.value = 'ab';
              textarea.setSelectionRange(2, 2);
              textarea.dispatchEvent(key229('Backspace', 'Backspace'));
              textarea.value = 'a';
              textarea.setSelectionRange(1, 1);
              textarea.dispatchEvent(key229('Backspace', 'Backspace'));
              textarea.value = '';
              textarea.setSelectionRange(0, 0);
              await new Promise(resolve => setTimeout(resolve, 8));
              return true;
            })()
            """.trimIndent(),
        )

        assertEventuallyExact(harness.forwarded, "\u007f")
    }

    @Test
    fun pendingInsertThenDeleteReduceToNoOp() {
        val harness = launchTerminalHarness()
        evaluateJavascript(
            harness.webView,
            """
            (async () => {
              const textarea = document.querySelector('#terminal textarea');
              if (!textarea) return false;
              const key229 = (key, code) => {
                const event = new KeyboardEvent('keydown', {
                  bubbles: true,
                  cancelable: true,
                  key,
                  code,
                });
                Object.defineProperty(event, 'keyCode', { get: () => 229 });
                Object.defineProperty(event, 'which', { get: () => 229 });
                Object.defineProperty(event, 'isComposing', { get: () => false });
                return event;
              };

              textarea.value = 'a';
              textarea.setSelectionRange(1, 1);
              textarea.dispatchEvent(key229('b', 'KeyB'));
              textarea.value = 'ab';
              textarea.setSelectionRange(2, 2);
              textarea.dispatchEvent(key229('Backspace', 'Backspace'));
              textarea.value = 'a';
              textarea.setSelectionRange(1, 1);
              await new Promise(resolve => setTimeout(resolve, 8));
              return true;
            })()
            """.trimIndent(),
        )

        assertEventuallyExact(harness.forwarded, "")
    }

    @Test
    fun batchedDomAfterInsertAndTwoDeletesReducesToOneNetDel() {
        val harness = launchTerminalHarness()
        evaluateJavascript(
            harness.webView,
            """
            (async () => {
              const textarea = document.querySelector('#terminal textarea');
              if (!textarea) return false;
              const key229 = (key, code) => {
                const event = new KeyboardEvent('keydown', {
                  bubbles: true,
                  cancelable: true,
                  key,
                  code,
                });
                Object.defineProperty(event, 'keyCode', { get: () => 229 });
                Object.defineProperty(event, 'which', { get: () => 229 });
                Object.defineProperty(event, 'isComposing', { get: () => false });
                return event;
              };

              textarea.value = 'a';
              textarea.setSelectionRange(1, 1);
              // Gboard can publish all key evidence first while keeping the textarea snapshot
              // unchanged, then commit the batch's final DOM value in one mutation.
              textarea.dispatchEvent(key229('b', 'KeyB'));
              textarea.dispatchEvent(key229('Backspace', 'Backspace'));
              textarea.dispatchEvent(key229('Backspace', 'Backspace'));
              textarea.value = '';
              textarea.setSelectionRange(0, 0);
              await new Promise(resolve => setTimeout(resolve, 8));
              return true;
            })()
            """.trimIndent(),
        )

        assertEventuallyExact(harness.forwarded, "\u007f")
    }

    @Test
    fun authoritativeDeleteConfirmsCanceledPendingInsertWithoutExtraDel() {
        val harness = launchTerminalHarness()
        evaluateJavascript(
            harness.webView,
            """
            (async () => {
              const textarea = document.querySelector('#terminal textarea');
              if (!textarea) return false;
              const key229 = (key, code) => {
                const event = new KeyboardEvent('keydown', {
                  bubbles: true,
                  cancelable: true,
                  key,
                  code,
                });
                Object.defineProperty(event, 'keyCode', { get: () => 229 });
                Object.defineProperty(event, 'which', { get: () => 229 });
                Object.defineProperty(event, 'isComposing', { get: () => false });
                return event;
              };

              textarea.value = 'a';
              textarea.setSelectionRange(1, 1);
              textarea.dispatchEvent(key229('b', 'KeyB'));
              textarea.value = 'ab';
              textarea.setSelectionRange(2, 2);
              textarea.dispatchEvent(key229('Backspace', 'Backspace'));
              textarea.value = 'a';
              textarea.setSelectionRange(1, 1);
              // This event confirms the already-reduced +b/-b transition. It is not an
              // additional terminal Backspace and therefore must not fail open to DEL.
              textarea.dispatchEvent(new InputEvent('input', {
                bubbles: true,
                cancelable: true,
                composed: true,
                data: null,
                inputType: 'deleteContentBackward',
              }));
              await new Promise(resolve => setTimeout(resolve, 8));
              return true;
            })()
            """.trimIndent(),
        )

        assertEventuallyExact(harness.forwarded, "")
    }

    @Test
    fun lateDeleteAfterNoOpFallbackConsumesPersistedConfirmation() {
        val harness = launchTerminalHarness()
        evaluateJavascript(
            harness.webView,
            """
            (async () => {
              const textarea = document.querySelector('#terminal textarea');
              if (!textarea) return false;
              const key229 = (key, code) => {
                const event = new KeyboardEvent('keydown', {
                  bubbles: true,
                  cancelable: true,
                  key,
                  code,
                });
                Object.defineProperty(event, 'keyCode', { get: () => 229 });
                Object.defineProperty(event, 'which', { get: () => 229 });
                Object.defineProperty(event, 'isComposing', { get: () => false });
                return event;
              };

              textarea.value = 'a';
              textarea.setSelectionRange(1, 1);
              textarea.dispatchEvent(key229('b', 'KeyB'));
              textarea.value = 'ab';
              textarea.setSelectionRange(2, 2);
              textarea.dispatchEvent(key229('Backspace', 'Backspace'));
              textarea.value = 'a';
              textarea.setSelectionRange(1, 1);
              // Let fallback settle +b/-b to no output before Chromium reports the delete.
              await new Promise(resolve => setTimeout(resolve, 8));
              textarea.dispatchEvent(new InputEvent('input', {
                bubbles: true,
                cancelable: true,
                composed: true,
                data: null,
                inputType: 'deleteContentBackward',
              }));
              await new Promise(resolve => setTimeout(resolve, 8));
              return true;
            })()
            """.trimIndent(),
        )

        assertEventuallyExact(harness.forwarded, "")
    }

    @Test
    fun lateDeletesAfterMixedFallbackDoNotReplayNetDel() {
        val harness = launchTerminalHarness()
        evaluateJavascript(
            harness.webView,
            """
            (async () => {
              const textarea = document.querySelector('#terminal textarea');
              if (!textarea) return false;
              const key229 = (key, code) => {
                const event = new KeyboardEvent('keydown', {
                  bubbles: true,
                  cancelable: true,
                  key,
                  code,
                });
                Object.defineProperty(event, 'keyCode', { get: () => 229 });
                Object.defineProperty(event, 'which', { get: () => 229 });
                Object.defineProperty(event, 'isComposing', { get: () => false });
                return event;
              };
              const deleteInput = () => textarea.dispatchEvent(new InputEvent('input', {
                bubbles: true,
                cancelable: true,
                composed: true,
                data: null,
                inputType: 'deleteContentBackward',
              }));

              textarea.value = 'a';
              textarea.setSelectionRange(1, 1);
              textarea.dispatchEvent(key229('b', 'KeyB'));
              textarea.value = 'ab';
              textarea.setSelectionRange(2, 2);
              textarea.dispatchEvent(key229('Backspace', 'Backspace'));
              textarea.value = 'a';
              textarea.setSelectionRange(1, 1);
              textarea.dispatchEvent(key229('Backspace', 'Backspace'));
              textarea.value = '';
              textarea.setSelectionRange(0, 0);
              // Fallback emits the one unmatched delete. Both later InputEvents are only
              // confirmations: one canceled +b, the other was already emitted by fallback.
              await new Promise(resolve => setTimeout(resolve, 8));
              deleteInput();
              deleteInput();
              await new Promise(resolve => setTimeout(resolve, 8));
              return true;
            })()
            """.trimIndent(),
        )

        assertEventuallyExact(harness.forwarded, "\u007f")
    }

    @Test
    fun oldNoOpDeleteReceiptDoesNotSwallowNextSameValueDeleteRound() {
        val harness = launchTerminalHarness()
        evaluateJavascript(
            harness.webView,
            """
            (async () => {
              const textarea = document.querySelector('#terminal textarea');
              if (!textarea) return false;
              const key229 = (key, code) => {
                const event = new KeyboardEvent('keydown', {
                  bubbles: true,
                  cancelable: true,
                  key,
                  code,
                });
                Object.defineProperty(event, 'keyCode', { get: () => 229 });
                Object.defineProperty(event, 'which', { get: () => 229 });
                Object.defineProperty(event, 'isComposing', { get: () => false });
                return event;
              };

              textarea.value = 'a';
              textarea.setSelectionRange(1, 1);
              textarea.dispatchEvent(key229('b', 'KeyB'));
              textarea.value = 'ab';
              textarea.setSelectionRange(2, 2);
              textarea.dispatchEvent(key229('Backspace', 'Backspace'));
              textarea.value = 'a';
              textarea.setSelectionRange(1, 1);
              await new Promise(resolve => setTimeout(resolve, 8));

              // A new round begins at the exact old receipt snapshot. Its current ticket must
              // win over the old late receipt so this real deletion is not swallowed.
              textarea.dispatchEvent(key229('Backspace', 'Backspace'));
              textarea.value = '';
              textarea.setSelectionRange(0, 0);
              textarea.dispatchEvent(new InputEvent('input', {
                bubbles: true,
                cancelable: true,
                composed: true,
                data: null,
                inputType: 'deleteContentBackward',
              }));
              // The older round's notification can arrive after the current one. It must consume
              // only the persisted old confirmation and must not replay another DEL.
              textarea.dispatchEvent(new InputEvent('input', {
                bubbles: true,
                cancelable: true,
                composed: true,
                data: null,
                inputType: 'deleteContentBackward',
              }));
              await new Promise(resolve => setTimeout(resolve, 8));
              return true;
            })()
            """.trimIndent(),
        )

        assertEventuallyExact(harness.forwarded, "\u007f")
    }

    @Test
    fun oldLateDeleteBeforeCurrentDomMutationDoesNotClaimCurrentTicket() {
        val harness = launchTerminalHarness()
        evaluateJavascript(
            harness.webView,
            """
            (async () => {
              const textarea = document.querySelector('#terminal textarea');
              if (!textarea) return false;
              const key229 = (key, code) => {
                const event = new KeyboardEvent('keydown', {
                  bubbles: true,
                  cancelable: true,
                  key,
                  code,
                });
                Object.defineProperty(event, 'keyCode', { get: () => 229 });
                Object.defineProperty(event, 'which', { get: () => 229 });
                Object.defineProperty(event, 'isComposing', { get: () => false });
                return event;
              };
              const deleteInput = () => textarea.dispatchEvent(new InputEvent('input', {
                bubbles: true,
                cancelable: true,
                composed: true,
                data: null,
                inputType: 'deleteContentBackward',
              }));

              textarea.value = 'a';
              textarea.setSelectionRange(1, 1);
              textarea.dispatchEvent(key229('b', 'KeyB'));
              textarea.value = 'ab';
              textarea.setSelectionRange(2, 2);
              textarea.dispatchEvent(key229('Backspace', 'Backspace'));
              textarea.value = 'a';
              textarea.setSelectionRange(1, 1);
              await new Promise(resolve => setTimeout(resolve, 8));

              textarea.dispatchEvent(key229('Backspace', 'Backspace'));
              // The old round reports its delete while the current round has key evidence only;
              // current DOM is still exactly its baseline. This must consume the old source.
              deleteInput();
              textarea.value = '';
              textarea.setSelectionRange(0, 0);
              deleteInput();
              await new Promise(resolve => setTimeout(resolve, 8));
              return true;
            })()
            """.trimIndent(),
        )

        assertEventuallyExact(harness.forwarded, "\u007f")
    }

    @Test
    fun oldLateDeleteBeforeCurrentMixedShrinkKeepsInsertDeleteNoOp() {
        val harness = launchTerminalHarness()
        evaluateJavascript(
            harness.webView,
            """
            (async () => {
              const textarea = document.querySelector('#terminal textarea');
              if (!textarea) return false;
              const key229 = (key, code) => {
                const event = new KeyboardEvent('keydown', {
                  bubbles: true,
                  cancelable: true,
                  key,
                  code,
                });
                Object.defineProperty(event, 'keyCode', { get: () => 229 });
                Object.defineProperty(event, 'which', { get: () => 229 });
                Object.defineProperty(event, 'isComposing', { get: () => false });
                return event;
              };
              const deleteInput = () => textarea.dispatchEvent(new InputEvent('input', {
                bubbles: true,
                cancelable: true,
                composed: true,
                data: null,
                inputType: 'deleteContentBackward',
              }));

              textarea.value = 'a';
              textarea.setSelectionRange(1, 1);
              textarea.dispatchEvent(key229('b', 'KeyB'));
              textarea.value = 'ab';
              textarea.setSelectionRange(2, 2);
              textarea.dispatchEvent(key229('Backspace', 'Backspace'));
              textarea.value = 'a';
              textarea.setSelectionRange(1, 1);
              await new Promise(resolve => setTimeout(resolve, 8));

              textarea.dispatchEvent(key229('b', 'KeyB'));
              textarea.value = 'ab';
              textarea.setSelectionRange(2, 2);
              textarea.dispatchEvent(key229('Backspace', 'Backspace'));
              // The current delete has key evidence but no DOM shrink yet. FIFO must confirm the
              // older settled no-op without touching the current ticket or its timer.
              deleteInput();
              textarea.value = 'a';
              textarea.setSelectionRange(1, 1);
              deleteInput();
              await new Promise(resolve => setTimeout(resolve, 8));
              return true;
            })()
            """.trimIndent(),
        )

        assertEventuallyExact(harness.forwarded, "")
    }

    @Test
    fun currentDeleteBeforeOldLateDeleteStillKeepsMixedTransitionNoOp() {
        val harness = launchTerminalHarness()
        evaluateJavascript(
            harness.webView,
            """
            (async () => {
              const textarea = document.querySelector('#terminal textarea');
              if (!textarea) return false;
              const key229 = (key, code) => {
                const event = new KeyboardEvent('keydown', {
                  bubbles: true,
                  cancelable: true,
                  key,
                  code,
                });
                Object.defineProperty(event, 'keyCode', { get: () => 229 });
                Object.defineProperty(event, 'which', { get: () => 229 });
                Object.defineProperty(event, 'isComposing', { get: () => false });
                return event;
              };
              const deleteInput = () => textarea.dispatchEvent(new InputEvent('input', {
                bubbles: true,
                cancelable: true,
                composed: true,
                data: null,
                inputType: 'deleteContentBackward',
              }));

              textarea.value = 'a';
              textarea.setSelectionRange(1, 1);
              textarea.dispatchEvent(key229('b', 'KeyB'));
              textarea.value = 'ab';
              textarea.setSelectionRange(2, 2);
              textarea.dispatchEvent(key229('Backspace', 'Backspace'));
              textarea.value = 'a';
              textarea.setSelectionRange(1, 1);
              await new Promise(resolve => setTimeout(resolve, 8));

              textarea.dispatchEvent(key229('b', 'KeyB'));
              textarea.value = 'ab';
              textarea.setSelectionRange(2, 2);
              textarea.dispatchEvent(key229('Backspace', 'Backspace'));
              textarea.value = 'a';
              textarea.setSelectionRange(1, 1);
              // Even if this is physically the current notification, FIFO may confirm the old
              // entry first; the preserved current timer/ledger then settles the same net no-op.
              deleteInput();
              deleteInput();
              await new Promise(resolve => setTimeout(resolve, 8));
              return true;
            })()
            """.trimIndent(),
        )

        assertEventuallyExact(harness.forwarded, "")
    }

    @Test
    fun pendingKnownDeleteWithoutDomMutationCancelsUnsentInsertAtFallback() {
        val harness = launchTerminalHarness()
        evaluateJavascript(
            harness.webView,
            """
            (async () => {
              const textarea = document.querySelector('#terminal textarea');
              if (!textarea) return false;
              const key229 = (key, code) => {
                const event = new KeyboardEvent('keydown', {
                  bubbles: true,
                  cancelable: true,
                  key,
                  code,
                });
                Object.defineProperty(event, 'keyCode', { get: () => 229 });
                Object.defineProperty(event, 'which', { get: () => 229 });
                Object.defineProperty(event, 'isComposing', { get: () => false });
                return event;
              };

              textarea.value = 'a';
              textarea.setSelectionRange(1, 1);
              textarea.dispatchEvent(key229('b', 'KeyB'));
              textarea.value = 'ab';
              textarea.setSelectionRange(2, 2);
              textarea.dispatchEvent(key229('Backspace', 'Backspace'));
              // Neither DOM shrink nor InputEvent arrives. Timer must still settle the explicit
              // Backspace evidence by canceling the unsent b, not clear the ticket and leak b.
              await new Promise(resolve => setTimeout(resolve, 8));
              return true;
            })()
            """.trimIndent(),
        )

        assertEventuallyExact(harness.forwarded, "")
    }

    @Test
    fun knownBackspaceWithoutDomMutationFallsBackOnceButGeneric229DoesNotInventDelete() {
        val harness = launchTerminalHarness()
        evaluateJavascript(
            harness.webView,
            """
            (async () => {
              const textarea = document.querySelector('#terminal textarea');
              if (!textarea) return false;
              const key229 = (key, code) => {
                const event = new KeyboardEvent('keydown', {
                  bubbles: true,
                  cancelable: true,
                  key,
                  code,
                });
                Object.defineProperty(event, 'keyCode', { get: () => 229 });
                Object.defineProperty(event, 'which', { get: () => 229 });
                Object.defineProperty(event, 'isComposing', { get: () => false });
                return event;
              };

              textarea.value = 'a';
              textarea.setSelectionRange(1, 1);
              textarea.dispatchEvent(key229('Backspace', 'Backspace'));
              await new Promise(resolve => setTimeout(resolve, 8));
              // A generic/unknown 229 is insertion-like evidence. With no DOM data it must not be
              // guessed as another deletion merely because Android used keyCode 229.
              textarea.dispatchEvent(key229('Unidentified', ''));
              await new Promise(resolve => setTimeout(resolve, 8));
              return true;
            })()
            """.trimIndent(),
        )

        assertEventuallyExact(harness.forwarded, "\u007f")
    }

    @Test
    fun oldFifoConfirmationDoesNotClearCurrentNoMutationDeleteFallback() {
        val harness = launchTerminalHarness()
        evaluateJavascript(
            harness.webView,
            """
            (async () => {
              const textarea = document.querySelector('#terminal textarea');
              if (!textarea) return false;
              const key229 = (key, code) => {
                const event = new KeyboardEvent('keydown', {
                  bubbles: true,
                  cancelable: true,
                  key,
                  code,
                });
                Object.defineProperty(event, 'keyCode', { get: () => 229 });
                Object.defineProperty(event, 'which', { get: () => 229 });
                Object.defineProperty(event, 'isComposing', { get: () => false });
                return event;
              };

              textarea.value = 'a';
              textarea.setSelectionRange(1, 1);
              textarea.dispatchEvent(key229('b', 'KeyB'));
              textarea.value = 'ab';
              textarea.setSelectionRange(2, 2);
              textarea.dispatchEvent(key229('Backspace', 'Backspace'));
              textarea.value = 'a';
              textarea.setSelectionRange(1, 1);
              await new Promise(resolve => setTimeout(resolve, 8));

              textarea.dispatchEvent(key229('Backspace', 'Backspace'));
              // This is the older no-op confirmation. Consuming it must leave the current known
              // Backspace ticket alive so its no-DOM fallback still emits exactly one DEL.
              textarea.dispatchEvent(new InputEvent('input', {
                bubbles: true,
                cancelable: true,
                composed: true,
                data: null,
                inputType: 'deleteContentBackward',
              }));
              await new Promise(resolve => setTimeout(resolve, 8));
              return true;
            })()
            """.trimIndent(),
        )

        assertEventuallyExact(harness.forwarded, "\u007f")
    }

    @Test
    fun oldLateDeleteDuringCurrentInsertMutationDoesNotBreakCurrentInsert() {
        val harness = launchTerminalHarness()
        evaluateJavascript(
            harness.webView,
            """
            (async () => {
              const textarea = document.querySelector('#terminal textarea');
              if (!textarea) return false;
              const key229 = (key, code) => {
                const event = new KeyboardEvent('keydown', {
                  bubbles: true,
                  cancelable: true,
                  key,
                  code,
                });
                Object.defineProperty(event, 'keyCode', { get: () => 229 });
                Object.defineProperty(event, 'which', { get: () => 229 });
                Object.defineProperty(event, 'isComposing', { get: () => false });
                return event;
              };

              textarea.value = 'a';
              textarea.setSelectionRange(1, 1);
              textarea.dispatchEvent(key229('b', 'KeyB'));
              textarea.value = 'ab';
              textarea.setSelectionRange(2, 2);
              textarea.dispatchEvent(key229('Backspace', 'Backspace'));
              textarea.value = 'a';
              textarea.setSelectionRange(1, 1);
              await new Promise(resolve => setTimeout(resolve, 8));

              textarea.dispatchEvent(key229('b', 'KeyB'));
              textarea.value = 'ab';
              textarea.setSelectionRange(2, 2);
              // DOM proves the current ticket is an insertion, so this delete can only belong to
              // the older source even though the old receipt snapshot predates current DOM.
              textarea.dispatchEvent(new InputEvent('input', {
                bubbles: true,
                cancelable: true,
                composed: true,
                data: null,
                inputType: 'deleteContentBackward',
              }));
              textarea.dispatchEvent(new InputEvent('input', {
                bubbles: true,
                cancelable: true,
                composed: true,
                data: 'b',
                inputType: 'insertText',
              }));
              await new Promise(resolve => setTimeout(resolve, 8));
              return true;
            })()
            """.trimIndent(),
        )

        assertEventuallyExact(harness.forwarded, "b")
    }

    @Test
    fun currentInsertInputBeforeOldLateDeleteKeepsBothGenerationsExact() {
        val harness = launchTerminalHarness()
        evaluateJavascript(
            harness.webView,
            """
            (async () => {
              const textarea = document.querySelector('#terminal textarea');
              if (!textarea) return false;
              const key229 = (key, code) => {
                const event = new KeyboardEvent('keydown', {
                  bubbles: true,
                  cancelable: true,
                  key,
                  code,
                });
                Object.defineProperty(event, 'keyCode', { get: () => 229 });
                Object.defineProperty(event, 'which', { get: () => 229 });
                Object.defineProperty(event, 'isComposing', { get: () => false });
                return event;
              };

              textarea.value = 'a';
              textarea.setSelectionRange(1, 1);
              textarea.dispatchEvent(key229('b', 'KeyB'));
              textarea.value = 'ab';
              textarea.setSelectionRange(2, 2);
              textarea.dispatchEvent(key229('Backspace', 'Backspace'));
              textarea.value = 'a';
              textarea.setSelectionRange(1, 1);
              await new Promise(resolve => setTimeout(resolve, 8));

              textarea.dispatchEvent(key229('b', 'KeyB'));
              textarea.value = 'ab';
              textarea.setSelectionRange(2, 2);
              textarea.dispatchEvent(new InputEvent('input', {
                bubbles: true,
                cancelable: true,
                composed: true,
                data: 'b',
                inputType: 'insertText',
              }));
              // Current insert has settled first and advanced the old receipt snapshot. The old
              // delete confirmation must now be consumed without disturbing the emitted b.
              textarea.dispatchEvent(new InputEvent('input', {
                bubbles: true,
                cancelable: true,
                composed: true,
                data: null,
                inputType: 'deleteContentBackward',
              }));
              await new Promise(resolve => setTimeout(resolve, 8));
              return true;
            })()
            """.trimIndent(),
        )

        assertEventuallyExact(harness.forwarded, "b")
    }

    @Test
    fun blurClearsLateNoOpDeleteReceipt() {
        val harness = launchTerminalHarness()
        evaluateJavascript(
            harness.webView,
            """
            (async () => {
              const textarea = document.querySelector('#terminal textarea');
              if (!textarea) return false;
              const key229 = (key, code) => {
                const event = new KeyboardEvent('keydown', {
                  bubbles: true,
                  cancelable: true,
                  key,
                  code,
                });
                Object.defineProperty(event, 'keyCode', { get: () => 229 });
                Object.defineProperty(event, 'which', { get: () => 229 });
                Object.defineProperty(event, 'isComposing', { get: () => false });
                return event;
              };

              textarea.value = 'a';
              textarea.setSelectionRange(1, 1);
              textarea.dispatchEvent(key229('b', 'KeyB'));
              textarea.value = 'ab';
              textarea.setSelectionRange(2, 2);
              textarea.dispatchEvent(key229('Backspace', 'Backspace'));
              textarea.value = 'a';
              textarea.setSelectionRange(1, 1);
              await new Promise(resolve => setTimeout(resolve, 8));
              textarea.dispatchEvent(new FocusEvent('blur', { bubbles: false }));

              // Recreate the same snapshot after the boundary. The old canceled-delete receipt
              // must be gone, so this authoritative delete is legal and fails open once.
              textarea.value = 'a';
              textarea.setSelectionRange(1, 1);
              textarea.dispatchEvent(new InputEvent('input', {
                bubbles: true,
                cancelable: true,
                composed: true,
                data: null,
                inputType: 'deleteContentBackward',
              }));
              await new Promise(resolve => setTimeout(resolve, 8));
              return true;
            })()
            """.trimIndent(),
        )

        assertEventuallyExact(harness.forwarded, "\u007f")
    }

    @Test
    fun deleteDuringCompositionDoesNotEmitDelAndFinalizeSendsOnlyFinalText() {
        val harness = launchTerminalHarness()
        evaluateJavascript(
            harness.webView,
            """
            (async () => {
              const textarea = document.querySelector('#terminal textarea');
              if (!textarea) return false;
              textarea.dispatchEvent(new CompositionEvent('compositionstart', {
                bubbles: true,
                cancelable: true,
                data: '',
              }));
              textarea.value = '你';
              textarea.setSelectionRange(1, 1);
              textarea.dispatchEvent(new CompositionEvent('compositionupdate', {
                bubbles: true,
                cancelable: true,
                data: '你',
              }));
              textarea.value = '';
              textarea.setSelectionRange(0, 0);
              textarea.dispatchEvent(new InputEvent('input', {
                bubbles: true,
                cancelable: true,
                composed: true,
                data: null,
                inputType: 'deleteContentBackward',
              }));
              textarea.value = '好';
              textarea.setSelectionRange(1, 1);
              textarea.dispatchEvent(new CompositionEvent('compositionupdate', {
                bubbles: true,
                cancelable: true,
                data: '好',
              }));
              await new Promise(resolve => setTimeout(resolve, 8));
              textarea.dispatchEvent(new CompositionEvent('compositionend', {
                bubbles: true,
                cancelable: true,
                data: '好',
              }));
              await new Promise(resolve => setTimeout(resolve, 8));
              textarea.dispatchEvent(new InputEvent('input', {
                bubbles: true,
                cancelable: true,
                composed: true,
                data: '好',
                inputType: 'insertText',
              }));
              return true;
            })()
            """.trimIndent(),
        )

        assertEventuallyExact(harness.forwarded, "好")
    }

    @Test
    fun unprovenReplacementDeleteFailsOpenOnceWithoutFallbackDelete() {
        val harness = launchTerminalHarness()
        evaluateJavascript(
            harness.webView,
            """
            (async () => {
              const textarea = document.querySelector('#terminal textarea');
              if (!textarea) return false;
              const event = new KeyboardEvent('keydown', {
                bubbles: true,
                cancelable: true,
                key: 'Backspace',
                code: 'Backspace',
              });
              Object.defineProperty(event, 'keyCode', { get: () => 229 });
              Object.defineProperty(event, 'which', { get: () => 229 });
              Object.defineProperty(event, 'isComposing', { get: () => false });
              textarea.value = 'ab';
              textarea.setSelectionRange(1, 2);
              textarea.dispatchEvent(event);
              // Equal-length/non-prefix replacement cannot prove a suffix deletion.
              textarea.value = 'x';
              textarea.setSelectionRange(1, 1);
              textarea.dispatchEvent(new InputEvent('input', {
                bubbles: true,
                cancelable: true,
                composed: true,
                data: null,
                inputType: 'deleteContentBackward',
              }));
              await new Promise(resolve => setTimeout(resolve, 8));
              return true;
            })()
            """.trimIndent(),
        )

        assertEventuallyExact(harness.forwarded, "\u007f")
    }

    @Test
    fun oversizedReceiptFailsOpenAndNeverSwallowsNextInput() {
        val harness = launchTerminalHarness()
        evaluateJavascript(
            harness.webView,
            """
            (async () => {
              const textarea = document.querySelector('#terminal textarea');
              if (!textarea) return false;
              const key229 = type => {
                const event = new KeyboardEvent(type, {
                  bubbles: true,
                  cancelable: true,
                  key: 'x',
                  code: 'KeyX',
                });
                Object.defineProperty(event, 'keyCode', { get: () => 229 });
                Object.defineProperty(event, 'which', { get: () => 229 });
                Object.defineProperty(event, 'isComposing', { get: () => false });
                return event;
              };
              textarea.dispatchEvent(key229('keydown'));
              const oversized = 'x'.repeat(4097);
              textarea.value = oversized;
              textarea.setSelectionRange(oversized.length, oversized.length);
              await new Promise(resolve => setTimeout(resolve, 8));
              // The receipt is deliberately abandoned once it exceeds 4096 UTF-16 code units.
              // A subsequent authoritative input must fail open rather than be mistaken for an
              // old fallback notification and swallowed.
              textarea.dispatchEvent(new InputEvent('input', {
                bubbles: true,
                cancelable: true,
                composed: true,
                data: 'z',
                inputType: 'insertText',
              }));
              textarea.dispatchEvent(key229('keyup'));
              return true;
            })()
            """.trimIndent(),
        )

        assertEventuallyExact(harness.forwarded, "x".repeat(4097) + "z")
    }

    @Test
    fun nextAndroid229KeydownDoesNotDiscardPriorLateInputReceipt() {
        val harness = launchTerminalHarness()
        evaluateJavascript(
            harness.webView,
            """
            (async () => {
              const textarea = document.querySelector('#terminal textarea');
              if (!textarea) return false;
              const key229 = type => {
                const event = new KeyboardEvent(type, {
                  bubbles: true,
                  cancelable: true,
                  key: 'e',
                  code: 'KeyE',
                });
                Object.defineProperty(event, 'keyCode', { get: () => 229 });
                Object.defineProperty(event, 'which', { get: () => 229 });
                Object.defineProperty(event, 'isComposing', { get: () => false });
                return event;
              };
              textarea.dispatchEvent(key229('keydown'));
              textarea.value = 'e';
              textarea.setSelectionRange(1, 1);
              await new Promise(resolve => setTimeout(resolve, 8));
              // k2 begins before Chromium delivers k1's input notification.
              textarea.dispatchEvent(key229('keydown'));
              textarea.dispatchEvent(new InputEvent('input', {
                bubbles: true,
                cancelable: true,
                composed: true,
                data: 'e',
                inputType: 'insertText',
              }));
              textarea.value = 'ee';
              textarea.setSelectionRange(2, 2);
              textarea.dispatchEvent(new InputEvent('input', {
                bubbles: true,
                cancelable: true,
                composed: true,
                data: 'e',
                inputType: 'insertText',
              }));
              textarea.dispatchEvent(key229('keyup'));
              return true;
            })()
            """.trimIndent(),
        )

        assertEventuallyExact(harness.forwarded, "ee")
    }

    @Test
    fun blurClearsReceiptSoLaterSameValueInputIsLegal() {
        val harness = launchTerminalHarness()
        evaluateJavascript(
            harness.webView,
            """
            (async () => {
              const textarea = document.querySelector('#terminal textarea');
              if (!textarea) return false;
              const key229 = type => {
                const event = new KeyboardEvent(type, {
                  bubbles: true,
                  cancelable: true,
                  key: 'e',
                  code: 'KeyE',
                });
                Object.defineProperty(event, 'keyCode', { get: () => 229 });
                Object.defineProperty(event, 'which', { get: () => 229 });
                Object.defineProperty(event, 'isComposing', { get: () => false });
                return event;
              };
              textarea.dispatchEvent(key229('keydown'));
              textarea.value = 'e';
              textarea.setSelectionRange(1, 1);
              await new Promise(resolve => setTimeout(resolve, 8));
              textarea.dispatchEvent(new FocusEvent('blur', { bubbles: false }));
              textarea.value = 'e';
              textarea.setSelectionRange(1, 1);
              textarea.dispatchEvent(new InputEvent('input', {
                bubbles: true,
                cancelable: true,
                composed: true,
                data: 'e',
                inputType: 'insertText',
              }));
              textarea.dispatchEvent(key229('keyup'));
              return true;
            })()
            """.trimIndent(),
        )

        assertEventuallyExact(harness.forwarded, "ee")
    }

    @Test
    fun repeatedSameCompositionRoundsAndLateFinalInputsAreExactOnce() {
        val harness = launchTerminalHarness()
        evaluateJavascript(
            harness.webView,
            """
            (async () => {
              const textarea = document.querySelector('#terminal textarea');
              if (!textarea) return false;
              const commit = async value => {
                textarea.dispatchEvent(new CompositionEvent('compositionstart', {
                  bubbles: true,
                  cancelable: true,
                  data: '',
                }));
                textarea.value += value;
                textarea.setSelectionRange(textarea.value.length, textarea.value.length);
                textarea.dispatchEvent(new CompositionEvent('compositionupdate', {
                  bubbles: true,
                  cancelable: true,
                  data: value,
                }));
                await new Promise(resolve => setTimeout(resolve, 8));
                textarea.dispatchEvent(new CompositionEvent('compositionend', {
                  bubbles: true,
                  cancelable: true,
                  data: value,
                }));
                await new Promise(resolve => setTimeout(resolve, 8));
                textarea.dispatchEvent(new InputEvent('input', {
                  bubbles: true,
                  cancelable: true,
                  composed: true,
                  data: value,
                  inputType: 'insertText',
                }));
              };
              await commit('你');
              await commit('你');
              return true;
            })()
            """.trimIndent(),
        )

        assertEventuallyExact(harness.forwarded, "你你")
    }

    @Test
    fun android229KeypressAndFollowingInputCancelTextareaFallback() {
        val harness = launchTerminalHarness()
        evaluateJavascript(
            harness.webView,
            """
            (async () => {
              const textarea = document.querySelector('#terminal textarea');
              if (!textarea) return false;
              const keyboardEvent = (type, keyCode, charCode) => {
                const event = new KeyboardEvent(type, {
                  bubbles: true,
                  cancelable: true,
                  key: 'e',
                  code: 'KeyE',
                });
                Object.defineProperty(event, 'keyCode', { get: () => keyCode });
                Object.defineProperty(event, 'which', { get: () => charCode || keyCode });
                Object.defineProperty(event, 'charCode', { get: () => charCode });
                Object.defineProperty(event, 'isComposing', { get: () => false });
                return event;
              };
              textarea.dispatchEvent(keyboardEvent('keydown', 229, 0));
              // 229 keypress is signal-only; authoritative input remains the sole sender.
              textarea.dispatchEvent(keyboardEvent('keypress', 101, 101));
              textarea.value = 'e';
              textarea.setSelectionRange(1, 1);
              textarea.dispatchEvent(new InputEvent('input', {
                bubbles: true,
                cancelable: true,
                composed: true,
                data: 'e',
                inputType: 'insertText',
              }));
              // The authoritative input settles the transition, so the fallback must stay silent.
              await new Promise(resolve => setTimeout(resolve, 8));
              textarea.dispatchEvent(keyboardEvent('keyup', 229, 0));
              return true;
            })()
            """.trimIndent(),
        )

        assertEventuallyExact(harness.forwarded, "e")
    }

    @Test
    fun android229KeypressWithoutInputFallsBackExactlyOnce() {
        val harness = launchTerminalHarness()
        evaluateJavascript(
            harness.webView,
            """
            (async () => {
              const textarea = document.querySelector('#terminal textarea');
              if (!textarea) return false;
              const keyboardEvent = (type, keyCode, charCode) => {
                const event = new KeyboardEvent(type, {
                  bubbles: true,
                  cancelable: true,
                  key: 'e',
                  code: 'KeyE',
                });
                Object.defineProperty(event, 'keyCode', { get: () => keyCode });
                Object.defineProperty(event, 'which', { get: () => charCode || keyCode });
                Object.defineProperty(event, 'charCode', { get: () => charCode });
                Object.defineProperty(event, 'isComposing', { get: () => false });
                return event;
              };
              textarea.dispatchEvent(keyboardEvent('keydown', 229, 0));
              // 229 keypress is only a signal; it must not race the textarea fallback sender.
              textarea.dispatchEvent(keyboardEvent('keypress', 101, 101));
              textarea.value = 'e';
              textarea.setSelectionRange(1, 1);
              // Deliberately omit input. The fallback remains the sole sender.
              await new Promise(resolve => setTimeout(resolve, 8));
              textarea.dispatchEvent(keyboardEvent('keyup', 229, 0));
              return true;
            })()
            """.trimIndent(),
        )

        assertEventuallyExact(harness.forwarded, "e")
    }

    @Test
    fun missingKeyupCannotSwallowNext229Generation() {
        val harness = launchTerminalHarness()
        evaluateJavascript(
            harness.webView,
            """
            (async () => {
              const textarea = document.querySelector('#terminal textarea');
              if (!textarea) return false;
              const keyboardEvent = (type, key, keyCode, charCode) => {
                const event = new KeyboardEvent(type, {
                  bubbles: true,
                  cancelable: true,
                  key,
                  code: `Key${'$'}{key.toUpperCase()}`,
                });
                Object.defineProperty(event, 'keyCode', { get: () => keyCode });
                Object.defineProperty(event, 'which', { get: () => charCode || keyCode });
                Object.defineProperty(event, 'charCode', { get: () => charCode });
                Object.defineProperty(event, 'isComposing', { get: () => false });
                return event;
              };

              textarea.dispatchEvent(keyboardEvent('keydown', 'a', 229, 0));
              textarea.dispatchEvent(keyboardEvent('keypress', 'a', 97, 97));
              textarea.value = 'a';
              textarea.setSelectionRange(1, 1);
              textarea.dispatchEvent(new InputEvent('input', {
                bubbles: true,
                cancelable: true,
                composed: true,
                data: 'a',
                inputType: 'insertText',
              }));

              // Deliberately omit keyup for k1. k2 must still own a fresh transition and accept
              // its authoritative input.
              textarea.dispatchEvent(keyboardEvent('keydown', 'b', 229, 0));
              textarea.value = 'ab';
              textarea.setSelectionRange(2, 2);
              textarea.dispatchEvent(new InputEvent('input', {
                bubbles: true,
                cancelable: true,
                composed: true,
                data: 'b',
                inputType: 'insertText',
              }));
              await new Promise(resolve => setTimeout(resolve, 8));
              textarea.dispatchEvent(keyboardEvent('keyup', 'b', 229, 0));
              return true;
            })()
            """.trimIndent(),
        )

        assertEventuallyExact(harness.forwarded, "ab")
    }

    @Test
    fun ordinaryKeypressAndFollowingInputStillEmitExactlyOnce() {
        val harness = launchTerminalHarness()
        evaluateJavascript(
            harness.webView,
            """
            (() => {
              const textarea = document.querySelector('#terminal textarea');
              if (!textarea) return false;
              const keyboardEvent = (type, keyCode, charCode) => {
                const event = new KeyboardEvent(type, {
                  bubbles: true,
                  cancelable: true,
                  key: 'e',
                  code: 'KeyE',
                });
                Object.defineProperty(event, 'keyCode', { get: () => keyCode });
                Object.defineProperty(event, 'which', { get: () => charCode || keyCode });
                Object.defineProperty(event, 'charCode', { get: () => charCode });
                return event;
              };
              textarea.dispatchEvent(keyboardEvent('keydown', 69, 0));
              textarea.dispatchEvent(keyboardEvent('keypress', 101, 101));
              textarea.value += 'e';
              textarea.setSelectionRange(1, 1);
              textarea.dispatchEvent(new InputEvent('input', {
                bubbles: true,
                cancelable: true,
                composed: true,
                data: 'e',
                inputType: 'insertText',
              }));
              textarea.dispatchEvent(keyboardEvent('keyup', 69, 0));
              return true;
            })()
            """.trimIndent(),
        )

        assertEventuallyExact(harness.forwarded, "e")
    }

    private fun launchTerminalHarness(): TerminalHarness {
        val controller = TerminalWebViewController()
        val ready = AtomicBoolean(false)
        val forwarded = mutableStateListOf<String>()
        composeRule.setContent {
            TerminalWebView(
                controller = controller,
                onReady = { ready.set(true) },
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

    private fun jsonString(value: String): String = buildString {
        append('"')
        value.forEach { character ->
            when (character) {
                '\\' -> append("\\\\")
                '"' -> append("\\\"")
                '\n' -> append("\\n")
                '\r' -> append("\\r")
                '\t' -> append("\\t")
                else -> append(character)
            }
        }
        append('"')
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
