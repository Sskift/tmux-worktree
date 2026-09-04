package com.tmuxworktree.mobile.core.terminal

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TerminalAssetLayoutPolicyTest {
    @Test
    fun `terminal renderer stays bottom anchored without per-frame layout thrash`() {
        val html = asset("xterm/index.html")

        assertTrue(html.contains("function pinTerminalBottom()"))
        assertTrue(html.contains("TwBridge.ready(lastCols || terminal.cols, lastRows || terminal.rows)"))
        assertTrue(html.indexOf("fit();") < html.indexOf("TwBridge.ready(lastCols"))
        assertTrue(html.contains("terminal.scrollToBottom()"))
        assertTrue(html.contains("observer.observe(document.getElementById('terminal'))"))
        assertFalse(html.contains("terminal.onRender(pinTerminalBottom)"))
    }

    @Test
    fun `terminal input queue flushes control keys immediately`() {
        val html = asset("xterm/index.html")

        assertTrue(html.contains("function queueInput(data)"))
        assertTrue(html.contains("setTimeout(flushInput, 12)"))
        assertTrue(html.contains("/[\\x00-\\x1f\\x7f]/.test(data)"))
    }

    @Test
    fun `terminal output starts LF delimited Host rows at column zero`() {
        val html = asset("xterm/index.html")

        assertTrue(html.contains("convertEol: true"))
        val adapter = source("core/terminal/RelayV2TerminalWebViewParserAdapter.kt")
        assertTrue(adapter.contains("LegacyScreenTitleOutputFilter"))
        assertTrue(adapter.contains("LEGACY_TITLE_FINAL_BYTE = 0x6b"))
    }

    @Test
    fun `vendored xterm retains the bounded Android 229 input state machine`() {
        val bundle = asset("xterm/xterm.js")

        assertTrue(bundle.contains("this._keyDownSeenWith229=229===e.keyCode"))
        assertTrue(bundle.contains("flushPendingTextareaChangeNow()"))
        assertTrue(bundle.contains("acknowledgePendingTextareaDeletion"))
        assertTrue(bundle.contains("rememberAlreadySentInput"))
        assertTrue(bundle.contains("resetInputTracking()"))
        assertTrue(bundle.contains("remainingData.length+e.length>4096"))
        assertFalse(bundle.contains("_alreadySentInputs"))
    }

    @Test
    fun `terminal parser control messages bypass render barriers`() {
        val source = source("core/terminal/TerminalWebView.kt")

        assertTrue(source.split("HandlerCompat.createAsync(Looper.getMainLooper())").size - 1 >= 2)
        assertFalse(source.contains("Handler(Looper.getMainLooper())"))
    }

    @Test
    fun `durable parser callbacks use one bounded IO lane`() {
        val source = source("core/terminal/RelayV2TerminalWebViewParserAdapter.kt")

        assertTrue(source.contains("Dispatchers.IO.limitedParallelism(1)"))
        assertTrue(source.contains("context = callbackDispatcher"))
    }

    private fun asset(path: String): String = appProjectDir.resolve("src/main/assets/$path").readText()

    private fun source(path: String): String =
        appProjectDir.resolve("src/main/java/com/tmuxworktree/mobile/$path").readText()

    private val appProjectDir: File by lazy {
        val start = File(checkNotNull(System.getProperty("user.dir"))).absoluteFile
        generateSequence(start) { it.parentFile }
            .flatMap { directory ->
                sequenceOf(directory, directory.resolve("app"), directory.resolve("mobile/android/app"))
            }
            .first { candidate ->
                candidate.resolve("build.gradle.kts").isFile &&
                    candidate.resolve("src/main/assets/xterm/index.html").isFile
            }
    }
}
