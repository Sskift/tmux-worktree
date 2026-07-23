package com.tmuxworktree.mobile.core.terminal

import android.annotation.SuppressLint
import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject

@Stable
class TerminalWebViewController internal constructor() {
    private val lock = Any()
    private val parserCallbackHandler = Handler(Looper.getMainLooper())
    private var webView: WebView? = null
    private val pendingScripts = ArrayDeque<String>()
    private var pendingScriptBytes = 0
    private val pendingTerminalOutput = StringBuilder()
    private var terminalWriteInFlight = false
    private var terminalOutputGeneration = 0L
    private var parserMutation: PendingParserMutation? = null
    @Volatile
    var isReady: Boolean = false
        private set

    internal fun bind(view: WebView) {
        synchronized(lock) { webView = view }
    }

    internal fun markReady() {
        val (view, scripts, outputGeneration) = synchronized(lock) {
            isReady = true
            val bound = webView ?: return
            val queued = pendingScripts.toList()
            pendingScripts.clear()
            pendingScriptBytes = 0
            val shouldDrain = pendingTerminalOutput.isNotEmpty() && !terminalWriteInFlight
            if (shouldDrain) terminalWriteInFlight = true
            Triple(bound, queued, terminalOutputGeneration.takeIf { shouldDrain })
        }
        view.post {
            scripts.forEach { view.evaluateJavascript(it, null) }
            outputGeneration?.let { drainTerminalOutput(view, it) }
        }
    }

    internal fun unbind(view: WebView) {
        val parserMutation = synchronized(lock) {
            if (webView === view) webView = null
            isReady = false
            pendingScripts.clear()
            pendingScriptBytes = 0
            pendingTerminalOutput.clear()
            terminalWriteInFlight = false
            terminalOutputGeneration += 1
            parserMutation.also { parserMutation = null }
        }
        settleParserMutation(parserMutation, applied = false)
    }

    internal fun writeBytesWithAck(
        callbackId: String,
        bytes: ByteArray,
        completion: (applied: Boolean) -> Unit,
    ): Boolean {
        if (bytes.isEmpty() || bytes.size > MAX_ACKED_PARSER_BYTES) return false
        val encoded = Base64.encodeToString(bytes, Base64.NO_WRAP)
        return registerParserMutation(
            callbackId = callbackId,
            script = "window.twWriteBytesWithAck&&window.twWriteBytesWithAck(" +
                "${JSONObject.quote(callbackId)},${JSONObject.quote(encoded)});",
            completion = completion,
        )
    }

    internal fun resetWithAck(
        callbackId: String,
        completion: (applied: Boolean) -> Unit,
    ): Boolean = registerParserMutation(
        callbackId = callbackId,
        script = "window.twResetWithAck&&window.twResetWithAck(${JSONObject.quote(callbackId)});",
        completion = completion,
    )

    internal fun completeParserMutation(callbackId: String, applied: Boolean) {
        val mutation = synchronized(lock) {
            parserMutation?.takeIf { it.callbackId == callbackId }
                .also { if (it != null) parserMutation = null }
        }
        settleParserMutation(mutation, applied)
    }

    fun write(data: String) {
        if (data.isEmpty()) return
        val scheduled: Pair<WebView, Long>? = synchronized(lock) {
            appendTerminalOutput(data)
            val readyView = webView?.takeIf { isReady }
            if (readyView == null || terminalWriteInFlight) {
                null
            } else {
                terminalWriteInFlight = true
                readyView to terminalOutputGeneration
            }
        }
        scheduled?.let { (view, generation) ->
            view.post { drainTerminalOutput(view, generation) }
        }
    }

    fun reset(message: String = "") {
        val parserMutation = synchronized(lock) {
            pendingTerminalOutput.clear()
            terminalWriteInFlight = false
            terminalOutputGeneration += 1
            parserMutation.also { parserMutation = null }
        }
        settleParserMutation(parserMutation, applied = false)
        evaluate("window.twReset&&window.twReset(${JSONObject.quote(message)});")
    }

    fun sendKey(data: String) =
        evaluate("window.twSendKey&&window.twSendKey(${JSONObject.quote(data)});")

    fun setReadOnly(readOnly: Boolean) =
        evaluate("window.twSetReadOnly&&window.twSetReadOnly($readOnly);")

    fun setFontSize(size: Int) =
        evaluate("window.twSetFontSize&&window.twSetFontSize(${size.coerceIn(10, 24)});")

    fun fit() = evaluate("window.twFit&&window.twFit();")

    fun focus() = evaluate("window.twFocus&&window.twFocus();")

    fun blur() = evaluate("window.twBlur&&window.twBlur();")

    fun clear() {
        val (readyView, parserMutation) = synchronized(lock) {
            pendingScripts.clear()
            pendingScriptBytes = 0
            pendingTerminalOutput.clear()
            terminalWriteInFlight = false
            terminalOutputGeneration += 1
            val mutation = parserMutation.also { parserMutation = null }
            webView?.takeIf { isReady } to mutation
        }
        settleParserMutation(parserMutation, applied = false)
        readyView?.post {
            readyView.evaluateJavascript("window.twReset&&window.twReset('');", null)
        }
    }

    private fun evaluate(script: String) {
        val readyView = synchronized(lock) {
            val view = webView
            if (view == null || !isReady) {
                enqueuePending(script)
                null
            } else {
                view
            }
        }
        readyView?.post { readyView.evaluateJavascript(script, null) }
    }

    private fun registerParserMutation(
        callbackId: String,
        script: String,
        completion: (Boolean) -> Unit,
    ): Boolean {
        if (
            callbackId.isBlank() ||
            callbackId.length > MAX_CALLBACK_ID_CHARS ||
            script.length > MAX_ACKED_PARSER_SCRIPT_CHARS
        ) return false
        val timeout = Runnable { completeParserMutation(callbackId, applied = false) }
        val view = synchronized(lock) {
            val readyView = webView?.takeIf { isReady } ?: return false
            if (parserMutation != null) return false
            parserMutation = PendingParserMutation(callbackId, completion, timeout)
            readyView
        }
        if (!parserCallbackHandler.postDelayed(timeout, PARSER_CALLBACK_TIMEOUT_MILLIS)) {
            synchronized(lock) {
                if (parserMutation?.callbackId == callbackId) parserMutation = null
            }
            return false
        }
        val posted = view.post {
            val current = synchronized(lock) {
                webView === view && isReady && parserMutation?.callbackId == callbackId
            }
            if (!current) return@post
            runCatching {
                view.evaluateJavascript(script) { result ->
                    if (result != "true") completeParserMutation(callbackId, false)
                }
            }.onFailure {
                completeParserMutation(callbackId, false)
            }
        }
        if (posted) return true
        parserCallbackHandler.removeCallbacks(timeout)
        synchronized(lock) {
            if (parserMutation?.callbackId == callbackId) parserMutation = null
        }
        return false
    }

    private fun settleParserMutation(
        mutation: PendingParserMutation?,
        applied: Boolean,
    ) {
        mutation ?: return
        parserCallbackHandler.removeCallbacks(mutation.timeout)
        mutation.completion(applied)
    }

    private fun enqueuePending(script: String) {
        val bytes = script.length * 2
        if (bytes > MAX_PENDING_SCRIPT_BYTES) {
            pendingScripts.clear()
            pendingScriptBytes = 0
            enqueueTruncationMarker()
            return
        }
        if (pendingScriptBytes + bytes > MAX_PENDING_SCRIPT_BYTES) {
            pendingScripts.clear()
            pendingScriptBytes = 0
            enqueueTruncationMarker()
        }
        pendingScripts.addLast(script)
        pendingScriptBytes += bytes
    }

    private fun enqueueTruncationMarker() {
        val marker = "window.twReset&&window.twReset('Terminal output was truncated while the view loaded.\\r\\n');"
        pendingScripts.addLast(marker)
        pendingScriptBytes += marker.length * 2
    }

    private fun appendTerminalOutput(data: String) {
        if (pendingTerminalOutput.length + data.length > MAX_PENDING_TERMINAL_CHARS) {
            pendingTerminalOutput.clear()
            pendingTerminalOutput.append(TERMINAL_TRUNCATION_MARKER)
        }
        val available = MAX_PENDING_TERMINAL_CHARS - pendingTerminalOutput.length
        if (available <= 0) return
        if (data.length <= available) {
            pendingTerminalOutput.append(data)
        } else {
            pendingTerminalOutput.append(data.takeLast(available))
        }
    }

    private fun drainTerminalOutput(view: WebView, generation: Long) {
        val output = synchronized(lock) {
            if (webView !== view || !isReady || terminalOutputGeneration != generation) return
            if (pendingTerminalOutput.isEmpty()) {
                terminalWriteInFlight = false
                return
            }
            pendingTerminalOutput.toString().also { pendingTerminalOutput.clear() }
        }
        val script = "window.twWrite&&window.twWrite(${JSONObject.quote(output)});"
        val submitted = runCatching {
            view.evaluateJavascript(script) {
                val drainAgain = synchronized(lock) {
                    if (webView !== view || !isReady || terminalOutputGeneration != generation) {
                        false
                    } else if (pendingTerminalOutput.isEmpty()) {
                        terminalWriteInFlight = false
                        false
                    } else {
                        true
                    }
                }
                if (drainAgain) view.post { drainTerminalOutput(view, generation) }
            }
        }.isSuccess
        if (!submitted) {
            synchronized(lock) {
                if (terminalOutputGeneration == generation) terminalWriteInFlight = false
            }
        }
    }

    private companion object {
        const val MAX_PENDING_SCRIPT_BYTES = 2 * 1024 * 1024
        const val MAX_PENDING_TERMINAL_CHARS = 1024 * 1024
        const val MAX_ACKED_PARSER_BYTES = 65_536
        const val MAX_CALLBACK_ID_CHARS = 256
        const val MAX_ACKED_PARSER_SCRIPT_CHARS = 96 * 1024
        const val PARSER_CALLBACK_TIMEOUT_MILLIS = 5_000L
        const val TERMINAL_TRUNCATION_MARKER =
            "\r\n[Terminal output truncated: client buffer limit reached]\r\n"
    }

    private data class PendingParserMutation(
        val callbackId: String,
        val completion: (Boolean) -> Unit,
        val timeout: Runnable,
    )
}

@Composable
fun rememberTerminalWebViewController(): TerminalWebViewController = remember {
    TerminalWebViewController()
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun TerminalWebView(
    controller: TerminalWebViewController,
    onReady: () -> Unit,
    onFailure: (String) -> Unit,
    onInput: (String) -> Unit,
    onResize: (cols: Int, rows: Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val currentOnReady = rememberUpdatedState(onReady)
    val currentOnFailure = rememberUpdatedState(onFailure)
    val currentOnInput = rememberUpdatedState(onInput)
    val currentOnResize = rememberUpdatedState(onResize)
    val bridge = remember(controller) {
        TerminalBridge(
            onReady = {
                controller.markReady()
                currentOnReady.value()
            },
            onFailure = { currentOnFailure.value(it) },
            onInput = { currentOnInput.value(it) },
            onResize = { cols, rows -> currentOnResize.value(cols, rows) },
            onParserMutationApplied = controller::completeParserMutation,
        )
    }

    val boundView = remember { arrayOfNulls<WebView>(1) }
    AndroidView(
        // WebView can retain its IME-expanded hardware layer for a frame after
        // the keyboard closes. Clip at the AndroidView boundary so it can never
        // draw over the Compose terminal app bar or controls.
        modifier = modifier.clipToBounds(),
        factory = {
            createTerminalWebView(context, bridge).also { view ->
                boundView[0] = view
                controller.bind(view)
            }
        },
        update = { view ->
            boundView[0] = view
            controller.bind(view)
        },
    )

    DisposableEffect(controller) {
        onDispose {
            boundView[0]?.let { view ->
                controller.unbind(view)
                view.removeJavascriptInterface(BRIDGE_NAME)
                view.stopLoading()
                view.destroy()
            }
            boundView[0] = null
        }
    }
}

@SuppressLint("SetJavaScriptEnabled")
private fun createTerminalWebView(context: Context, bridge: TerminalBridge): WebView {
    val assetLoader = WebViewAssetLoader.Builder()
        .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(context))
        .build()
    return WebView(context).apply {
        layoutParams = ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT,
        )
        setBackgroundColor(android.graphics.Color.rgb(2, 5, 9))
        contentDescription = "Remote terminal"
        isFocusable = true
        isFocusableInTouchMode = true
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = false
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        settings.cacheMode = WebSettings.LOAD_NO_CACHE
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        settings.setSupportZoom(false)
        settings.builtInZoomControls = false
        settings.displayZoomControls = false
        addJavascriptInterface(bridge, BRIDGE_NAME)
        webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest,
            ): WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)

            @Deprecated("Deprecated in Android")
            override fun shouldInterceptRequest(view: WebView, url: String): WebResourceResponse? =
                assetLoader.shouldInterceptRequest(Uri.parse(url))

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                request.url.host != WebViewAssetLoader.DEFAULT_DOMAIN
        }
        loadUrl(TERMINAL_URL)
    }
}

private class TerminalBridge(
    private val onReady: () -> Unit,
    private val onFailure: (String) -> Unit,
    private val onInput: (String) -> Unit,
    private val onResize: (Int, Int) -> Unit,
    private val onParserMutationApplied: (String, Boolean) -> Unit,
) {
    private val mainHandler = Handler(Looper.getMainLooper())

    @JavascriptInterface
    fun ready() {
        mainHandler.post { onReady() }
    }

    @JavascriptInterface
    fun failed(message: String) {
        mainHandler.post { onFailure(message) }
    }

    @JavascriptInterface
    fun input(data: String) {
        mainHandler.post { onInput(data) }
    }

    @JavascriptInterface
    fun resize(cols: Int, rows: Int) {
        mainHandler.post { onResize(cols, rows) }
    }

    @JavascriptInterface
    fun parserMutationApplied(callbackId: String, applied: Boolean) {
        mainHandler.post { onParserMutationApplied(callbackId, applied) }
    }
}

private const val BRIDGE_NAME = "TwBridge"
private const val TERMINAL_URL =
    "https://${WebViewAssetLoader.DEFAULT_DOMAIN}/assets/xterm/index.html"
