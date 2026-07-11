package com.tmuxworktree.mobile.core.terminal

import android.annotation.SuppressLint
import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
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
    private var webView: WebView? = null
    private val pendingScripts = ArrayDeque<String>()
    private var pendingScriptBytes = 0
    @Volatile
    var isReady: Boolean = false
        private set

    internal fun bind(view: WebView) {
        synchronized(lock) { webView = view }
    }

    internal fun markReady() {
        val (view, scripts) = synchronized(lock) {
            isReady = true
            val bound = webView ?: return
            val queued = pendingScripts.toList()
            pendingScripts.clear()
            pendingScriptBytes = 0
            bound to queued
        }
        view.post {
            scripts.forEach { view.evaluateJavascript(it, null) }
        }
    }

    internal fun unbind(view: WebView) {
        synchronized(lock) {
            if (webView === view) webView = null
            isReady = false
            pendingScripts.clear()
            pendingScriptBytes = 0
        }
    }

    fun write(data: String) = evaluate("window.twWrite&&window.twWrite(${JSONObject.quote(data)});")

    fun reset(message: String = "") =
        evaluate("window.twReset&&window.twReset(${JSONObject.quote(message)});")

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
        val readyView = synchronized(lock) {
            pendingScripts.clear()
            pendingScriptBytes = 0
            webView?.takeIf { isReady }
        }
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

    private companion object {
        const val MAX_PENDING_SCRIPT_BYTES = 2 * 1024 * 1024
    }
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
    val bridge = remember {
        TerminalBridge(
            onReady = {
                controller.markReady()
                currentOnReady.value()
            },
            onFailure = { currentOnFailure.value(it) },
            onInput = { currentOnInput.value(it) },
            onResize = { cols, rows -> currentOnResize.value(cols, rows) },
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
}

private const val BRIDGE_NAME = "TwBridge"
private const val TERMINAL_URL =
    "https://${WebViewAssetLoader.DEFAULT_DOMAIN}/assets/xterm/index.html"
