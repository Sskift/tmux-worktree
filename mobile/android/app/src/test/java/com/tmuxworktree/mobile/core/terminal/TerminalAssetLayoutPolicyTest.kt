package com.tmuxworktree.mobile.core.terminal

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TerminalAssetLayoutPolicyTest {
    @Test
    fun `terminal renderer stays bottom anchored across viewport and IME resizes`() {
        val html = appProjectDir.resolve("src/main/assets/xterm/index.html").readText()

        assertTrue(html.contains("--tw-terminal-bottom-offset"))
        assertTrue(html.contains("function pinTerminalBottom()"))
        assertTrue(html.contains("const offset = availableHeight - screenHeight"))
        assertTrue(html.contains("terminal.scrollToBottom()"))
        assertTrue(html.contains("Math.abs(offset - lastBottomOffset) < 0.25"))
        assertFalse(html.contains("terminal.onRender(pinTerminalBottom)"))
        assertTrue(html.contains("observer.observe(document.getElementById('terminal'))"))
        assertTrue(html.contains("function fitBurst()"))
    }

    @Test
    fun `printable input is briefly coalesced while submit keys flush immediately`() {
        val html = appProjectDir.resolve("src/main/assets/xterm/index.html").readText()

        assertTrue(html.contains("function queueInput(data)"))
        assertTrue(html.contains("setTimeout(flushInput, 12)"))
        assertTrue(html.contains("/[\\x00-\\x1f\\x7f]/.test(data)"))
        assertTrue(html.contains("window.addEventListener('pagehide', flushInput)"))
        assertTrue(html.contains("if (Boolean(value)) flushInput()"))
    }

    @Test
    fun `vendored xterm keeps the Android physical keyboard race fix`() {
        val bundle = appProjectDir.resolve("src/main/assets/xterm/xterm.js").readText()

        // Backport of xtermjs/xterm.js d034164. Android reports ordinary physical-keyboard
        // input through keyCode 229; allowing one timer per key produces triangular duplicates.
        assertTrue(bundle.contains("if(this._textareaChangeTimer)return"))
        assertTrue(bundle.contains("this._textareaChangeTimer=window.setTimeout"))
        assertTrue(bundle.contains("this._textareaChangeTimer=void 0"))
    }

    @Test
    fun `vendored xterm accepts authoritative input after a 229 keydown without duplication`() {
        val bundle = appProjectDir.resolve("src/main/assets/xterm/xterm.js").readText()

        // Some Android IMEs deliver input before keydown and report keyCode 229 for ordinary
        // Latin characters. The previous keydown left _keyDownSeen set, so xterm 5.5 silently
        // dropped the next authoritative input event (xtermjs/xterm.js#5887). Keep the exemption
        // restricted to a 229 keydown outside a real composition, and cancel the textarea-diff
        // fallback once the input event itself has been accepted so the opposite event order
        // cannot emit the same character twice.
        assertTrue(bundle.contains("this._keyDownSeenWith229=229===e.keyCode"))
        assertTrue(
            bundle.contains(
                "this._keyDownSeenWith229&&!this._compositionHelper.isComposing&&" +
                    "!this._compositionHelper.isSendingComposition",
            ),
        )
        // Android 229 keypress is only a signal: authoritative input or the transition fallback is
        // the sole sender. A normal non-229 keypress keeps its one-shot generation receipt.
        assertTrue(
            bundle.contains(
                "this._keyPressHandled=!1,this._inputGeneration=0," +
                    "this._keyPressHandledGeneration=-1,this._keyPressHandledData=\"\"",
            ),
        )
        assertTrue(bundle.contains("_keyDown(e){if(this._inputGeneration++"))
        assertTrue(bundle.contains("this._compositionHelper.keydown(e,this._inputGeneration)"))
        assertTrue(
            bundle.contains(
                "if(this._keyDownSeenWith229)return!0;return " +
                    "this._compositionHelper.flushPendingTextareaChangeNow()," +
                    "t=String.fromCharCode(t),this._onKey.fire",
            ),
        )
        assertTrue(
            bundle.contains(
                "this._keyDownSeenWith229=229===e.keyCode," +
                    "229!==e.keyCode&&" +
                    "this._compositionHelper.flushPendingTextareaChangeNow()," +
                    "this._customKeyEventHandler",
            ),
        )
        assertTrue(
            bundle.contains(
                "this._compositionHelper.cancelPendingTextareaChange(this._inputGeneration)," +
                    "this._keyPressHandled=!0," +
                    "this._keyPressHandledGeneration=this._inputGeneration",
            ),
        )
        assertTrue(
            bundle.contains(
                "if(this._keyPressHandled&&" +
                    "this._keyPressHandledGeneration===this._inputGeneration&&" +
                    "this._keyPressHandledData===i)",
            ),
        )
        assertTrue(
            bundle.contains(
                "cancelPendingTextareaChange(e){this._textareaChangeTimer&&" +
                    "(void 0===e||this._textareaChangeGeneration===e&&" +
                    "this._textareaChangeLatestGeneration===e)",
            ),
        )
        assertTrue(bundle.contains("keydown(e,t){if(this._isComposing"))
        assertTrue(
            bundle.contains(
                "return 229===e.keyCode?(this._handleAnyTextareaChanges(t," +
                    "\"Backspace\"===e.key||\"Backspace\"===e.code||8===e.keyCode),!1):" +
                    "(this.flushPendingTextareaChangeNow(),!0)",
            ),
        )
        assertTrue(
            bundle.contains(
                "_handleAnyTextareaChanges(e,t){" +
                    "if(t&&this._consumeAuthoritativeTextareaDeleteReceipt())return;" +
                    "const i=t?\"delete\":\"insert\"," +
                    "s={kind:i,generation:e};" +
                    "if(this._textareaChangeTimer)return " +
                    "this._observePendingTextareaTransition()," +
                    "this._textareaChangeLatestGeneration=e," +
                    "this._textareaChangeLatestKind=i," +
                    "this._textareaChangePendingKeys.push(s),void 0",
            ),
        )
        assertTrue(
            bundle.contains(
                "this._textareaChangeGeneration=e," +
                    "this._textareaChangeLatestGeneration=e," +
                    "this._textareaChangeLatestKind=i," +
                    "this._textareaChangeBaseline=r," +
                    "this._textareaChangeLastValue=r," +
                    "this._textareaChangePendingKeys=[s]," +
                    "this._textareaChangeNetEdits=[]," +
                    "this._textareaChangeDeleteConfirmations=[]",
            ),
        )
        assertTrue(
            bundle.contains(
                "this._textareaChangeTimer=window.setTimeout(" +
                    "(()=>this.flushPendingTextareaChangeNow()),0)",
            ),
        )
        assertTrue(
            bundle.contains(
                "flushPendingTextareaChangeNow(){if(!this._textareaChangeTimer)return;" +
                    "this._observePendingTextareaTransition(!0);" +
                    "const e=this._textareaChangeUnproven?\"\":" +
                    "this._pendingTextareaData()," +
                    "t=this._textareaChangeLatestGeneration," +
                    "i=this._textareaChangeDeleteConfirmations.slice()",
            ),
        )
        assertTrue(
            bundle.contains(
                "this._clearPendingTextareaChange(),i.length&&" +
                    "this._rememberLateTextareaDeleteConfirmations(i)",
            ),
        )
        assertTrue(
            bundle.contains(
                "_rearmPendingTextareaChange(e){const t=\"delete\"===" +
                    "this._textareaChangeLatestKind;" +
                    "this._clearPendingTextareaChange()," +
                    "this._handleAnyTextareaChanges(e,t)}",
            ),
        )
        assertTrue(
            bundle.contains(
                "acknowledgePendingTextareaChange(e,t){if(" +
                    "this._updateLateTextareaDeleteConfirmationSnapshot()," +
                    "!this._textareaChangeTimer)return;" +
                    "this._observePendingTextareaTransition();" +
                    "if(this._textareaChangeUnproven)return void(e&&" +
                    "this._rearmPendingTextareaChange(" +
                    "this._textareaChangeLatestGeneration))",
            ),
        )
        assertTrue(
            bundle.contains(
                "_consumePendingTextareaReceipts(e){let t=!1;" +
                    "for(const i of e){const e=i.sourceGeneration;" +
                    "void 0!==e&&e>=this._textareaChangeGeneration&&" +
                    "e<=this._textareaChangeLatestGeneration&&" +
                    "this._consumePendingTextareaData(i.data)&&(t=!0)",
            ),
        )
        assertTrue(
            bundle.contains(
                "if(!this._consumePendingTextareaData(e))return void " +
                    "this._rearmPendingTextareaChange(this._textareaChangeLatestGeneration)",
            ),
        )
        assertTrue(
            bundle.contains(
                "_observePendingTextareaTransition(e=!1){" +
                    "if(!this._textareaChangeTimer)return;" +
                    "const t=this._textarea.value,i=this._textareaChangeLastValue," +
                    "s=this._textareaChangePendingKeys",
            ),
        )
        assertTrue(
            bundle.contains(
                "_reducePendingTextareaKeys(){const e=[],t=[],i=[];" +
                    "for(const s of this._textareaChangePendingKeys)",
            ),
        )
        assertTrue(
            bundle.contains(
                "_recordPendingTextareaDeletes(e,t,i=!1){" +
                    "const s=1===t.length?[e]:Array.from(e).reverse(),r=[]",
            ),
        )
        assertTrue(
            bundle.contains(
                "n&&\"insert\"===n.kind",
            ),
        )
        assertTrue(bundle.contains("n.data.endsWith(t)"))
        assertTrue(
            bundle.contains(
                "if(!i)return this._textareaChangeUnproven=!0,void 0;" +
                    "const e=Array.from(n.data);e.pop(),n.data=e.join(\"\")",
            ),
        )
        assertTrue(bundle.contains("this._appendPendingTextareaDelete()"))
        assertTrue(bundle.contains("remainingInserts:e,externalDeletes:t,deletePlan:i"))
        assertTrue(
            bundle.contains(
                "this._textareaChangeDeleteConfirmations.push(" +
                    "{emits:e,sourceGeneration:i.key.generation})",
            ),
        )
        assertTrue(bundle.contains("e.externalDeletes.length&&e.remainingInserts.length"))
        assertTrue(bundle.contains("this._appendPendingDeleteConfirmations(e.deletePlan,t)"))
        assertTrue(
            bundle.contains(
                "!this._isComposing&&e.length>0&&" +
                    "(this.rememberAlreadySentInput(e,t)," +
                    "this._coreService.triggerDataEvent(e,!0))",
            ),
        )

        // deleteContentBackward is authoritative even with null data. Proven suffix deletions
        // reduce against unsent insert edits in order, and fallback writes DEL receipts so a late
        // delete input can be consumed exactly once.
        assertTrue(bundle.contains("const t=\"deleteContentBackward\"===e.inputType"))
        assertTrue(
            bundle.contains(
                "t?!this._compositionHelper.isComposing&&" +
                    "!this._compositionHelper.isSendingComposition",
            ),
        )
        assertTrue(bundle.contains("consumeAlreadySentInput(D.C0.DEL)"))
        assertTrue(
            bundle.contains(
                "i=this._compositionHelper.acknowledgePendingTextareaDeletion(" +
                    "t.data,t.consumed);return i&&" +
                    "this.coreService.triggerDataEvent(i,!0)",
            ),
        )
        assertTrue(
            bundle.contains(
                "acknowledgePendingTextareaDeletion(e,t){" +
                    "const i=this._consumeOlderLateDeleteBeforeCurrentTicket();" +
                    "if(i)return\"\";" +
                    "if(!this._textareaChangeTimer){const t=" +
                    "this._consumeLateTextareaDeleteConfirmation();" +
                    "return t?\"\":(e&&this._rememberAuthoritativeTextareaDeletion(),e)}" +
                    "this._observePendingTextareaTransition()",
            ),
        )
        assertTrue(bundle.contains("_rememberAuthoritativeTextareaDeletion(){"))
        assertTrue(bundle.contains("_consumeAuthoritativeTextareaDeleteReceipt(){"))
        assertTrue(
            bundle.contains(
                "this._authoritativeDeleteReceiptTimer=window.setTimeout(" +
                    "(()=>this._clearAuthoritativeTextareaDeleteReceipt()),0)",
            ),
        )
        assertTrue(bundle.contains("const s=this._textareaChangeDeleteConfirmations.shift()"))
        assertTrue(bundle.contains("const t=s.emits?e:\"\""))
        assertTrue(bundle.contains("this._settlePendingTextareaChange(s.sourceGeneration)"))
        assertTrue(bundle.contains("_rememberLateTextareaDeleteConfirmations(e){"))
        assertTrue(bundle.contains("_consumeLateTextareaDeleteConfirmation(){"))
        assertTrue(bundle.contains("_consumeOlderLateDeleteBeforeCurrentTicket(){"))
        assertTrue(
            bundle.contains(
                "t.sourceGeneration<this._textareaChangeGeneration)return " +
                    "this._updateLateTextareaDeleteConfirmationSnapshot()," +
                    "this._consumeLateTextareaDeleteConfirmation()",
            ),
        )
        assertFalse(bundle.contains("_textareaChangeObservedMutation"))
        assertTrue(
            bundle.contains(
                "if(n){const t=this._textareaChangeNetEdits[" +
                    "this._textareaChangeNetEdits.length-1];" +
                    "if(t&&\"insert\"===t.kind&&!e)return;" +
                    "o=this._recordPendingTextareaDeletes(\"\",s,e)}",
            ),
        )
        assertTrue(
            bundle.contains(
                "e.value.startsWith(this._textarea.value)&&" +
                    "e.selectionStart===e.value.length&&" +
                    "e.selectionEnd===e.value.length",
            ),
        )
        assertTrue(bundle.contains("confirmations:r,value:t,selectionStart:i,selectionEnd:s"))
        assertTrue(bundle.contains("n.confirmations.length+r.length>4096"))
        assertTrue(bundle.contains("this._lateTextareaDeleteConfirmationsOverflowed=!0"))
        assertTrue(
            bundle.contains(
                "const t=this._lateTextareaDeleteConfirmations;" +
                    "return t.confirmations.shift(),t.confirmations.length||" +
                    "(this._lateTextareaDeleteConfirmations=void 0),e",
            ),
        )
        assertTrue(
            bundle.contains(
                "_pendingTextareaData(){return this._textareaChangeNetEdits.map(" +
                    "(e=>\"insert\"===e.kind?e.data:a.C0.DEL.repeat(e.count)))",
            ),
        )
        assertFalse(bundle.contains("_textareaChangeDeleteCount"))
        assertFalse(bundle.contains("_textareaChangeCoveredDeleteCount"))

        // Fallback/finalize sends aggregate into one bounded receipt whose source segments retain
        // the actual latest generation that emitted each suffix. This lets fragmented late input
        // consume exact prefixes without granting it authority over an unrelated pending ticket.
        assertTrue(
            bundle.contains(
                "resetInputTracking(){this.flushPendingTextareaChangeNow()," +
                    "this._clearAuthoritativeTextareaDeleteReceipt()," +
                    "this._clearLateTextareaDeleteConfirmations()," +
                    "this._alreadySentInput=void 0,this._alreadySentInputOverflowed=!1}",
            ),
        )
        assertTrue(
            bundle.contains(
                "rememberAlreadySentInput(e,t){if(" +
                    "this._updateLateTextareaDeleteConfirmationSnapshot(),!e||" +
                    "this._alreadySentInputOverflowed)return",
            ),
        )
        assertTrue(bundle.contains("segments:[{data:e,sourceGeneration:t}]"))
        assertTrue(bundle.contains("o.sourceGeneration===t?o.data+=e"))
        assertTrue(bundle.contains("consumeAlreadySentInput(e){const t={data:e,consumed:[]}"))
        assertTrue(bundle.contains("sourceGeneration:e.sourceGeneration"))

        // String.length is a UTF-16 code-unit count. Cap the unmatched aggregate at 4096; on
        // overflow fail open (forward the next input) instead of risking a real keystroke loss.
        assertTrue(bundle.contains("n.remainingData.length+e.length>4096"))
        assertTrue(bundle.contains("e.length>4096?this._alreadySentInputOverflowed=!0"))
        assertTrue(
            bundle.contains(
                "if(this._alreadySentInputOverflowed)return " +
                    "this._alreadySentInputOverflowed=!1," +
                    "this._alreadySentInput=void 0,t",
            ),
        )
        assertFalse(bundle.contains("_alreadySentInputs"))
        assertTrue(
            bundle.contains(
                "const s=this._compositionHelper.consumeAlreadySentInput(i);return " +
                    "this._compositionHelper.acknowledgePendingTextareaChange(" +
                    "s.data,s.consumed),s.data&&" +
                    "this.coreService.triggerDataEvent(s.data,!0)",
            ),
        )
        assertFalse(
            bundle.contains(
                "consumeAlreadySentInput(t);return " +
                    "this._compositionHelper.cancelPendingTextareaChange",
            ),
        )
        assertTrue(bundle.contains("compositionstart(){this.resetInputTracking()"))
        assertTrue(bundle.split("resetInputTracking()").size - 1 >= 6)
        assertTrue(
            bundle.contains(
                "_handleTextAreaBlur(){this._compositionHelper.resetInputTracking()," +
                    "this.textarea.value=\"\"",
            ),
        )
        assertTrue(
            bundle.contains(
                "paste(e){this._compositionHelper.resetInputTracking()," +
                    "(0,s.paste)(e,this.textarea",
            ),
        )
        assertTrue(
            bundle.contains(
                "reset(){this._compositionHelper?.resetInputTracking()," +
                    "this.textarea&&(this.textarea.value=\"\")",
            ),
        )
        assertTrue(
            bundle.contains(
                "D.C0.CR||(this._compositionHelper.resetInputTracking()," +
                    "this.textarea.value=\"\")",
            ),
        )
        assertFalse(bundle.contains("keydown(e){this.resetInputTracking()"))
        assertTrue(
            bundle.contains(
                "window.clearTimeout(this._textareaChangeTimer)," +
                    "this._textareaChangeTimer=void 0," +
                    "this._textareaChangeGeneration=void 0",
            ),
        )
        assertFalse(
            bundle.contains(
                "(!e.composed||!this._keyDownSeen)&&" +
                    "!this.optionsService.rawOptions.screenReaderMode",
            ),
        )
    }

    @Test
    fun `terminal parser acknowledgements and deadlines bypass render barriers`() {
        val source = appProjectDir
            .resolve("src/main/java/com/tmuxworktree/mobile/core/terminal/TerminalWebView.kt")
            .readText()

        // Both the controller deadline and the JavaScript bridge delivery are correctness
        // messages. A synchronous main Handler can be starved indefinitely behind a WebView or
        // Compose frame barrier while asynchronous vsync work makes the renderer look alive.
        assertTrue(source.split("HandlerCompat.createAsync(Looper.getMainLooper())").size - 1 >= 2)
        assertTrue(!source.contains("Handler(Looper.getMainLooper())"))
    }

    @Test
    fun `durable parser callback work leaves Main on one bounded IO lane`() {
        val source = appProjectDir
            .resolve(
                "src/main/java/com/tmuxworktree/mobile/core/terminal/" +
                    "RelayV2TerminalWebViewParserAdapter.kt",
            )
            .readText()

        assertTrue(source.contains("Dispatchers.IO.limitedParallelism(1)"))
        assertTrue(source.contains("context = callbackDispatcher"))
    }

    private val appProjectDir: File by lazy {
        val start = File(checkNotNull(System.getProperty("user.dir"))).absoluteFile
        generateSequence(start) { it.parentFile }
            .flatMap { directory ->
                sequenceOf(
                    directory,
                    directory.resolve("app"),
                    directory.resolve("mobile/android/app"),
                )
            }
            .first { candidate ->
                    candidate.resolve("build.gradle.kts").isFile &&
                    candidate.resolve("src/main/assets/xterm/index.html").isFile &&
                    candidate.resolve("src/main/assets/xterm/xterm.js").isFile
            }
    }
}
