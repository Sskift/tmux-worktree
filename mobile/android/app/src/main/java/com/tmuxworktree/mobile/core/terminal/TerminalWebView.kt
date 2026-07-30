package com.tmuxworktree.mobile.core.terminal

import android.annotation.SuppressLint
import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.webkit.WebViewAssetLoader
import java.util.Collections
import java.util.WeakHashMap
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONObject

internal class TerminalWebViewParserBinding private constructor(
    private val controller: TerminalWebViewController,
    internal val owner: TerminalWebViewOwnership,
    internal val generation: Long,
) {
    internal fun writeBytesWithAck(
        callbackId: String,
        bytes: ByteArray,
        completion: (Boolean) -> Unit,
    ): Boolean = controller.writeBytesWithAck(this, callbackId, bytes, completion)

    internal fun resetWithAck(
        callbackId: String,
        completion: (Boolean) -> Unit,
    ): Boolean = controller.resetWithAck(this, callbackId, completion)

    internal fun isCurrent(): Boolean = controller.owns(this)

    companion object {
        internal fun issue(
            controller: TerminalWebViewController,
            owner: TerminalWebViewOwnership,
            generation: Long,
        ) = TerminalWebViewParserBinding(controller, owner, generation)
    }
}

internal enum class TerminalWebViewLossKind {
    RENDERER_GONE,
    VIEW_DISPOSED,
}

internal class TerminalWebViewRendererLoss internal constructor(
    internal val owner: TerminalWebViewOwnership,
    internal val generation: Long,
    val kind: TerminalWebViewLossKind,
    val didCrash: Boolean,
    internal val allowAutomaticRebuild: Boolean,
) {
    /** Call only after the exact Relay v2 terminal attachment has been fenced and detached. */
    internal fun completeAfterAttachmentDetach(): Boolean = owner.completeRendererLoss(this)

    internal fun fences(binding: TerminalWebViewParserBinding): Boolean =
        owner === binding.owner && generation == binding.generation

    internal val isRendererLoss: Boolean
        get() = kind == TerminalWebViewLossKind.RENDERER_GONE
}

/**
 * Exact in-process owner for one bound WebView generation.
 *
 * View loss removes the dead view immediately, blocks a successor bind, and holds the old parser
 * settlement until the upper attachment owner proves detach. It contains no Relay/session
 * authority and is used only by [TerminalWebViewController].
 */
internal class TerminalWebViewOwnership {
    private data class Bound(
        val view: Any,
        val generation: Long,
    )

    private data class PendingLoss(
        val receipt: TerminalWebViewRendererLoss,
        val settleParserFailure: () -> Unit,
        var completionClaimed: Boolean = false,
    )

    private val lock = Any()
    private var nextGeneration = 0L
    private var bound: Bound? = null
    private var pendingLoss: PendingLoss? = null
    private val deadViews = Collections.newSetFromMap(WeakHashMap<Any, Boolean>())
    private val _rebuildGeneration = MutableStateFlow(0L)
    val rebuildGeneration = _rebuildGeneration.asStateFlow()

    fun bind(view: Any): Boolean = synchronized(lock) {
        if (pendingLoss != null) return@synchronized false
        if (view in deadViews) return@synchronized false
        if (bound?.view === view) return@synchronized true
        nextGeneration += 1
        bound = Bound(view, nextGeneration)
        true
    }

    fun currentView(): Any? = synchronized(lock) { bound?.view }

    fun currentBinding(
        controller: TerminalWebViewController,
        expectedView: Any? = null,
    ): TerminalWebViewParserBinding? = synchronized(lock) {
        val current = bound ?: return@synchronized null
        if (expectedView != null && current.view !== expectedView) return@synchronized null
        TerminalWebViewParserBinding.issue(controller, this, current.generation)
    }

    fun owns(binding: TerminalWebViewParserBinding): Boolean = synchronized(lock) {
        binding.owner === this && bound?.generation == binding.generation
    }

    fun view(binding: TerminalWebViewParserBinding): Any? = synchronized(lock) {
        bound?.takeIf {
            binding.owner === this && it.generation == binding.generation
        }?.view
    }

    fun unbind(view: Any): Boolean = synchronized(lock) {
        if (bound?.view !== view) return@synchronized false
        bound = null
        true
    }

    fun beginViewLoss(
        view: Any,
        kind: TerminalWebViewLossKind,
        didCrash: Boolean,
        allowAutomaticRebuild: Boolean,
        settleParserFailure: () -> Unit,
    ): TerminalWebViewRendererLoss? = synchronized(lock) {
        if (pendingLoss != null) return@synchronized null
        val current = bound?.takeIf { it.view === view } ?: return@synchronized null
        bound = null
        deadViews.add(view)
        val receipt = TerminalWebViewRendererLoss(
            this,
            current.generation,
            kind,
            didCrash,
            allowAutomaticRebuild,
        )
        pendingLoss = PendingLoss(receipt, settleParserFailure)
        receipt
    }

    internal fun completeRendererLoss(loss: TerminalWebViewRendererLoss): Boolean {
        val settlement = synchronized(lock) {
            val pending = pendingLoss
                ?.takeIf { it.receipt === loss && !it.completionClaimed }
                ?: return false
            pending.completionClaimed = true
            pending.settleParserFailure
        }
        try {
            settlement()
        } finally {
            synchronized(lock) {
                val pending = pendingLoss
                if (pending?.receipt === loss) {
                    pendingLoss = null
                    if (loss.allowAutomaticRebuild ||
                        loss.kind == TerminalWebViewLossKind.VIEW_DISPOSED
                    ) {
                        _rebuildGeneration.value += 1
                    }
                }
            }
        }
        return loss.allowAutomaticRebuild
    }
}

@Stable
class TerminalWebViewController internal constructor() {
    private val lock = Any()
    private val parserCallbackHandler = Handler(Looper.getMainLooper())
    private val ownership = TerminalWebViewOwnership()
    private val pendingScripts = ArrayDeque<String>()
    private var pendingScriptBytes = 0
    private val pendingTerminalOutput = StringBuilder()
    private var terminalWriteInFlight = false
    private var terminalOutputGeneration = 0L
    private var parserMutation: PendingParserMutation? = null
    private val controlledOutput = ControlledTerminalOutputFilter()
    @Volatile
    var isReady: Boolean = false
        private set

    internal fun bind(view: WebView): Boolean = synchronized(lock) {
        val alreadyBound = ownership.currentView() === view
        if (!ownership.bind(view)) return@synchronized false
        if (!alreadyBound) isReady = false
        true
    }

    internal fun markReady(view: WebView): TerminalWebViewParserBinding? {
        val ready = synchronized(lock) {
            val binding = ownership.currentBinding(this, view) ?: return null
            isReady = true
            val queued = pendingScripts.toList()
            pendingScripts.clear()
            pendingScriptBytes = 0
            val shouldDrain = pendingTerminalOutput.isNotEmpty() && !terminalWriteInFlight
            if (shouldDrain) terminalWriteInFlight = true
            ReadyWebView(
                view,
                binding,
                queued,
                terminalOutputGeneration.takeIf { shouldDrain },
            )
        }
        val posted = postToView(ready.view) {
            if (!ownsReadyView(ready.view, ready.binding)) return@postToView
            for (script in ready.scripts) {
                if (!ownsReadyView(ready.view, ready.binding)) return@postToView
                if (runCatching {
                        ready.view.evaluateJavascript(script, null)
                    }.isFailure
                ) return@postToView
            }
            ready.outputGeneration?.let {
                drainTerminalOutput(
                    TerminalDrainTarget(ready.view, ready.binding, it),
                )
            }
        }
        if (!posted) releaseTerminalDrain(ready.binding, ready.outputGeneration)
        return ready.binding
    }

    internal fun rendererLost(
        view: WebView,
        didCrash: Boolean,
        allowAutomaticRebuild: Boolean,
    ): TerminalWebViewRendererLoss? = loseView(
        view = view,
        kind = TerminalWebViewLossKind.RENDERER_GONE,
        didCrash = didCrash,
        allowAutomaticRebuild = allowAutomaticRebuild,
    )

    internal fun viewDisposed(view: WebView): TerminalWebViewRendererLoss? = loseView(
        view = view,
        kind = TerminalWebViewLossKind.VIEW_DISPOSED,
        didCrash = false,
        allowAutomaticRebuild = false,
    )

    private fun loseView(
        view: WebView,
        kind: TerminalWebViewLossKind,
        didCrash: Boolean,
        allowAutomaticRebuild: Boolean,
    ): TerminalWebViewRendererLoss? {
        val (loss, mutation) = synchronized(lock) {
            val mutation = parserMutation
            val loss = ownership.beginViewLoss(
                view = view,
                kind = kind,
                didCrash = didCrash,
                allowAutomaticRebuild = allowAutomaticRebuild,
                settleParserFailure = { mutation?.completion?.invoke(false) },
            ) ?: return null
            isReady = false
            pendingScripts.clear()
            pendingScriptBytes = 0
            pendingTerminalOutput.clear()
            terminalWriteInFlight = false
            terminalOutputGeneration += 1
            controlledOutput.reset()
            parserMutation = null
            loss to mutation
        }
        mutation?.let { parserCallbackHandler.removeCallbacks(it.timeout) }
        return loss
    }

    internal val rendererRebuildGeneration = ownership.rebuildGeneration

    internal fun currentParserBinding(): TerminalWebViewParserBinding? = synchronized(lock) {
        if (!isReady) return@synchronized null
        ownership.currentBinding(this)
    }

    internal fun owns(binding: TerminalWebViewParserBinding): Boolean = synchronized(lock) {
        isReady && ownership.owns(binding)
    }

    internal fun acceptsBridgeEvent(view: WebView): Boolean = synchronized(lock) {
        ownership.currentView() === view
    }

    internal fun writeBytesWithAck(
        binding: TerminalWebViewParserBinding,
        callbackId: String,
        bytes: ByteArray,
        completion: (applied: Boolean) -> Unit,
    ): Boolean {
        if (bytes.isEmpty() || bytes.size > MAX_ACKED_PARSER_BYTES) return false
        val encoded = Base64.encodeToString(bytes, Base64.NO_WRAP)
        return registerParserMutation(
            binding = binding,
            callbackId = callbackId,
            script = "window.twWriteBytesWithAck&&window.twWriteBytesWithAck(" +
                "${JSONObject.quote(callbackId)},${JSONObject.quote(encoded)});",
            completion = completion,
        )
    }

    internal fun resetWithAck(
        binding: TerminalWebViewParserBinding,
        callbackId: String,
        completion: (applied: Boolean) -> Unit,
    ): Boolean = registerParserMutation(
        binding = binding,
        callbackId = callbackId,
        script = "window.twResetWithAck&&window.twResetWithAck(${JSONObject.quote(callbackId)});",
        completion = completion,
    )

    internal fun completeParserMutation(
        view: WebView,
        callbackId: String,
        applied: Boolean,
    ) {
        val mutation = synchronized(lock) {
            if (ownership.currentView() !== view) return
            parserMutation?.takeIf { it.callbackId == callbackId }
                .also { if (it != null) parserMutation = null }
        }
        settleParserMutation(mutation, applied)
    }

    fun write(data: String) {
        if (data.isEmpty()) return
        val scheduled: TerminalDrainTarget? = synchronized(lock) {
            val output = controlledOutput.push(data)
            if (output.isEmpty()) return@synchronized null
            appendTerminalOutput(output)
            val readyView = (ownership.currentView() as? WebView)?.takeIf { isReady }
            val binding = ownership.currentBinding(this)?.takeIf { readyView != null }
            if (readyView == null || terminalWriteInFlight) {
                null
            } else {
                checkNotNull(binding)
                terminalWriteInFlight = true
                TerminalDrainTarget(readyView, binding, terminalOutputGeneration)
            }
        }
        scheduled?.let(::postTerminalDrain)
    }

    fun reset(message: String = "") {
        val parserMutation = synchronized(lock) {
            pendingTerminalOutput.clear()
            terminalWriteInFlight = false
            terminalOutputGeneration += 1
            controlledOutput.reset()
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
            controlledOutput.reset()
            val mutation = parserMutation.also { parserMutation = null }
            val view = (ownership.currentView() as? WebView)?.takeIf { isReady }
            val binding = ownership.currentBinding(this)?.takeIf { view != null }
            view?.let { BoundWebView(it, checkNotNull(binding)) } to mutation
        }
        settleParserMutation(parserMutation, applied = false)
        readyView?.let { target ->
            postToView(target.view) {
                if (!ownsReadyView(target.view, target.binding)) return@postToView
                runCatching {
                    target.view.evaluateJavascript("window.twReset&&window.twReset('');", null)
                }
            }
        }
    }

    private fun evaluate(script: String) {
        val readyView = synchronized(lock) {
            val view = ownership.currentView() as? WebView
            if (view == null || !isReady) {
                enqueuePending(script)
                null
            } else {
                val binding = ownership.currentBinding(this) ?: return@synchronized null
                BoundWebView(view, binding)
            }
        }
        readyView?.let { target ->
            postToView(target.view) {
                if (!ownsReadyView(target.view, target.binding)) return@postToView
                runCatching { target.view.evaluateJavascript(script, null) }
            }
        }
    }

    private fun registerParserMutation(
        binding: TerminalWebViewParserBinding,
        callbackId: String,
        script: String,
        completion: (Boolean) -> Unit,
    ): Boolean {
        if (
            callbackId.isBlank() ||
            callbackId.length > MAX_CALLBACK_ID_CHARS ||
            script.length > MAX_ACKED_PARSER_SCRIPT_CHARS
        ) return false
        val view = synchronized(lock) {
            val readyView = (ownership.view(binding) as? WebView)?.takeIf { isReady }
                ?: return false
            if (parserMutation != null) return false
            val timeout = Runnable {
                completeParserMutation(binding, callbackId, applied = false)
            }
            parserMutation = PendingParserMutation(callbackId, completion, timeout)
            readyView
        }
        val timeout = synchronized(lock) {
            parserMutation?.takeIf { it.callbackId == callbackId }?.timeout
        } ?: return false
        if (!parserCallbackHandler.postDelayed(timeout, PARSER_CALLBACK_TIMEOUT_MILLIS)) {
            synchronized(lock) {
                if (parserMutation?.callbackId == callbackId) parserMutation = null
            }
            return false
        }
        val posted = postToView(view) {
            val current = synchronized(lock) {
                ownership.view(binding) === view &&
                    isReady &&
                    parserMutation?.callbackId == callbackId
            }
            if (!current) return@postToView
            // evaluateJavascript submission failure is not itself a parser settlement. Keep the
            // exact mutation pending until TwBridge ACK, the existing bounded timeout, or a view
            // loss cut that takes and holds its false.
            runCatching {
                view.evaluateJavascript(script) { _ ->
                    // Submission result is not the parser ACK. TwBridge or timeout settles it.
                }
            }
        }
        if (posted) return true
        // The main-handler timeout remains the bounded fail-closed owner. A renderer-loss callback
        // already queued by Chromium can therefore publish its synchronous cut before ordinary
        // false settlement, independent of main-queue callback ordering.
        return true
    }

    private fun completeParserMutation(
        binding: TerminalWebViewParserBinding,
        callbackId: String,
        applied: Boolean,
    ) {
        val mutation = synchronized(lock) {
            if (!ownership.owns(binding)) return
            parserMutation?.takeIf { it.callbackId == callbackId }
                .also { if (it != null) parserMutation = null }
        }
        settleParserMutation(mutation, applied)
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

    private fun ownsReadyView(
        view: WebView,
        binding: TerminalWebViewParserBinding,
    ): Boolean = synchronized(lock) {
        isReady && ownership.view(binding) === view
    }

    private fun postTerminalDrain(target: TerminalDrainTarget) {
        if (!postToView(target.view) { drainTerminalOutput(target) }) {
            releaseTerminalDrain(target.binding, target.outputGeneration)
        }
    }

    private fun postToView(view: WebView, block: () -> Unit): Boolean =
        runCatching { view.post(block) }.getOrDefault(false)

    private fun releaseTerminalDrain(
        binding: TerminalWebViewParserBinding,
        generation: Long?,
    ) {
        if (generation == null) return
        synchronized(lock) {
            if (ownership.owns(binding) && terminalOutputGeneration == generation) {
                terminalWriteInFlight = false
            }
        }
    }

    private fun drainTerminalOutput(target: TerminalDrainTarget) {
        val output = synchronized(lock) {
            if (ownership.view(target.binding) !== target.view ||
                !isReady ||
                terminalOutputGeneration != target.outputGeneration
            ) return
            if (pendingTerminalOutput.isEmpty()) {
                terminalWriteInFlight = false
                return
            }
            pendingTerminalOutput.toString().also { pendingTerminalOutput.clear() }
        }
        val script = "window.twWrite&&window.twWrite(${JSONObject.quote(output)});"
        val submitted = runCatching {
            target.view.evaluateJavascript(script) {
                val drainAgain = synchronized(lock) {
                    if (ownership.view(target.binding) !== target.view ||
                        !isReady ||
                        terminalOutputGeneration != target.outputGeneration
                    ) {
                        false
                    } else if (pendingTerminalOutput.isEmpty()) {
                        terminalWriteInFlight = false
                        false
                    } else {
                        true
                    }
                }
                if (drainAgain) postTerminalDrain(target)
            }
        }.isSuccess
        if (!submitted) {
            releaseTerminalDrain(target.binding, target.outputGeneration)
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

    private data class ReadyWebView(
        val view: WebView,
        val binding: TerminalWebViewParserBinding,
        val scripts: List<String>,
        val outputGeneration: Long?,
    )

    private data class BoundWebView(
        val view: WebView,
        val binding: TerminalWebViewParserBinding,
    )

    private data class TerminalDrainTarget(
        val view: WebView,
        val binding: TerminalWebViewParserBinding,
        val outputGeneration: Long,
    )
}

@Composable
fun rememberTerminalWebViewController(): TerminalWebViewController = remember {
    TerminalWebViewController()
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
internal fun TerminalWebView(
    controller: TerminalWebViewController,
    onReady: (TerminalWebViewParserBinding) -> Unit,
    onViewLoss: (TerminalWebViewRendererLoss) -> Unit,
    onFailure: (String) -> Unit,
    onInput: (String) -> Unit,
    onResize: (cols: Int, rows: Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val currentOnReady = rememberUpdatedState(onReady)
    val currentOnViewLoss = rememberUpdatedState(onViewLoss)
    val currentOnFailure = rememberUpdatedState(onFailure)
    val currentOnInput = rememberUpdatedState(onInput)
    val currentOnResize = rememberUpdatedState(onResize)
    val rendererGeneration by controller.rendererRebuildGeneration.collectAsState()
    var automaticRendererRecoveries by remember(controller) { mutableIntStateOf(0) }

    key(rendererGeneration) {
        val createdView = remember(controller, rendererGeneration) { arrayOfNulls<WebView>(1) }
        val boundView = remember(controller, rendererGeneration) { arrayOfNulls<WebView>(1) }
        AndroidView(
            // WebView can retain its IME-expanded hardware layer for a frame after
            // the keyboard closes. Clip at the AndroidView boundary so it can never
            // draw over the Compose terminal app bar or controls.
            modifier = modifier.clipToBounds(),
            factory = {
                lateinit var view: WebView
                val bridge = TerminalBridge(
                    onReady = {
                        controller.markReady(view)?.let { currentOnReady.value(it) }
                    },
                    onFailure = {
                        if (controller.acceptsBridgeEvent(view)) currentOnFailure.value(it)
                    },
                    onInput = {
                        if (controller.acceptsBridgeEvent(view)) currentOnInput.value(it)
                    },
                    onResize = { cols, rows ->
                        if (controller.acceptsBridgeEvent(view)) {
                            currentOnResize.value(cols, rows)
                        }
                    },
                    onParserMutationApplied = { callbackId, applied ->
                        controller.completeParserMutation(view, callbackId, applied)
                    },
                )
                view = createTerminalWebView(
                    context = context,
                    bridge = bridge,
                    onRendererGone = { rendererView, didCrash ->
                        val allowAutomaticRebuild =
                            automaticRendererRecoveries < MAX_AUTOMATIC_RENDERER_RECOVERIES
                        val loss = controller.rendererLost(
                            rendererView,
                            didCrash,
                            allowAutomaticRebuild,
                        )
                        if (loss != null && allowAutomaticRebuild) {
                            automaticRendererRecoveries += 1
                        }
                        // Publish the exact attachment callback fence synchronously before any
                        // WebView cleanup can run or throw.
                        if (loss != null) currentOnViewLoss.value(loss)
                        if (boundView[0] === rendererView) boundView[0] = null
                        if (createdView[0] === rendererView) createdView[0] = null
                        disposeTerminalWebView(rendererView)
                        // Every terminal WebView owns renderer-loss cleanup. Even a late callback
                        // from an already fenced view is handled so Android keeps the app process.
                        true
                    },
                )
                createdView[0] = view
                // Route re-entry can create this AndroidView while the prior route's exact
                // attachment detach is still pending. Leave it inert; the detach receipt
                // publishes a new generation and replaces it without a main-thread exception.
                if (controller.bind(view)) {
                    boundView[0] = view
                    runCatching { view.loadUrl(TERMINAL_URL) }
                        .onFailure { currentOnFailure.value("Terminal view could not load") }
                }
                view
            },
            // Factory is the sole bind owner. Updates never re-admit an inert or dead view.
            update = {},
        )

        DisposableEffect(controller, rendererGeneration) {
            onDispose {
                val view = createdView[0]
                createdView[0] = null
                if (view != null) {
                    if (boundView[0] === view) {
                        val loss = controller.viewDisposed(view)
                        boundView[0] = null
                        if (loss != null) currentOnViewLoss.value(loss)
                    }
                    // Includes factory-created views whose bind was intentionally rejected while
                    // the prior exact detach barrier was pending.
                    disposeTerminalWebView(view)
                }
            }
        }
    }
}

private fun disposeTerminalWebView(view: WebView) {
    runCatching { view.removeJavascriptInterface(BRIDGE_NAME) }
    runCatching { view.stopLoading() }
    runCatching { view.destroy() }
}

@SuppressLint("SetJavaScriptEnabled")
private fun createTerminalWebView(
    context: Context,
    bridge: TerminalBridge,
    onRendererGone: (WebView, Boolean) -> Boolean,
): WebView {
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

            override fun onRenderProcessGone(
                view: WebView,
                detail: RenderProcessGoneDetail,
            ): Boolean = onRendererGone(view, detail.didCrash())
        }
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
private const val MAX_AUTOMATIC_RENDERER_RECOVERIES = 1
private const val TERMINAL_URL =
    "https://${WebViewAssetLoader.DEFAULT_DOMAIN}/assets/xterm/index.html"
