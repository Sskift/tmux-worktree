package com.tmuxworktree.mobile.core.terminal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class TerminalWebViewOwnershipTest {
    @Test
    fun `each ready document owns a fresh parser generation`() {
        val owner = TerminalWebViewOwnership()
        val view = Any()
        assertTrue(owner.bind(view))

        val firstReadyGeneration = requireNotNull(owner.renewContentGeneration(view))
        val reloadedDocumentGeneration = requireNotNull(owner.renewContentGeneration(view))

        assertTrue(reloadedDocumentGeneration > firstReadyGeneration)
        assertNull(owner.renewContentGeneration(Any()))
        assertSame(view, owner.currentView())
    }

    @Test
    fun `renderer loss blocks replacement until detach then settles false and rebuilds once`() {
        val owner = TerminalWebViewOwnership()
        val deadView = Any()
        val replacementView = Any()
        val parserSettlements = mutableListOf<Boolean>()
        assertTrue(owner.bind(deadView))

        assertNull(
            owner.beginViewLoss(
                view = Any(),
                kind = TerminalWebViewLossKind.RENDERER_GONE,
                didCrash = true,
                allowAutomaticRebuild = true,
            ) { parserSettlements += false },
        )
        val loss = requireNotNull(
            owner.beginViewLoss(
                view = deadView,
                kind = TerminalWebViewLossKind.RENDERER_GONE,
                didCrash = true,
                allowAutomaticRebuild = true,
            ) { parserSettlements += false },
        )

        assertTrue(loss.didCrash)
        assertNull(owner.currentView())
        assertFalse(owner.bind(replacementView))
        assertTrue(parserSettlements.isEmpty())
        assertEquals(0L, owner.rebuildGeneration.value)

        assertTrue(loss.completeAfterAttachmentDetach())
        assertEquals(listOf(false), parserSettlements)
        assertEquals(1L, owner.rebuildGeneration.value)
        assertTrue(owner.bind(replacementView))
        assertSame(replacementView, owner.currentView())

        assertFalse(loss.completeAfterAttachmentDetach())
        assertEquals(listOf(false), parserSettlements)
        assertEquals(1L, owner.rebuildGeneration.value)
    }

    @Test
    fun `normal dispose stays false and only releases replacement after detach`() {
        val owner = TerminalWebViewOwnership()
        val disposedView = Any()
        val replacementView = Any()
        val parserSettlements = mutableListOf<Boolean>()
        assertTrue(owner.bind(disposedView))

        val loss = requireNotNull(
            owner.beginViewLoss(
                view = disposedView,
                kind = TerminalWebViewLossKind.VIEW_DISPOSED,
                didCrash = false,
                allowAutomaticRebuild = false,
            ) { parserSettlements += false },
        )

        assertFalse(owner.bind(disposedView))
        assertFalse(owner.bind(replacementView))
        assertTrue(parserSettlements.isEmpty())
        assertFalse(loss.completeAfterAttachmentDetach())
        assertEquals(listOf(false), parserSettlements)
        assertEquals(1L, owner.rebuildGeneration.value)
        assertFalse(owner.bind(disposedView))
        assertTrue(owner.bind(replacementView))
    }

    @Test
    fun `repeated renderer loss can settle without scheduling another rebuild`() {
        val owner = TerminalWebViewOwnership()
        val deadView = Any()
        val parserSettlements = mutableListOf<Boolean>()
        assertTrue(owner.bind(deadView))

        val loss = requireNotNull(
            owner.beginViewLoss(
                view = deadView,
                kind = TerminalWebViewLossKind.RENDERER_GONE,
                didCrash = true,
                allowAutomaticRebuild = false,
            ) { parserSettlements += false },
        )

        assertFalse(loss.completeAfterAttachmentDetach())
        assertEquals(listOf(false), parserSettlements)
        assertEquals(0L, owner.rebuildGeneration.value)
    }

    @Test
    fun `manual reconnect rebuilds after automatic renderer recovery is exhausted`() {
        val owner = TerminalWebViewOwnership()
        val deadView = Any()
        val replacementView = Any()
        assertTrue(owner.bind(deadView))

        val loss = requireNotNull(
            owner.beginViewLoss(
                view = deadView,
                kind = TerminalWebViewLossKind.RENDERER_GONE,
                didCrash = true,
                allowAutomaticRebuild = false,
                settleParserFailure = {},
            ),
        )
        assertFalse(loss.completeAfterAttachmentDetach())
        assertEquals(0L, owner.rebuildGeneration.value)

        assertTrue(owner.requestRendererRebuild())
        assertEquals(1L, owner.rebuildGeneration.value)
        assertTrue(owner.bind(replacementView))
        assertFalse(owner.requestRendererRebuild())
    }

    @Test
    fun `manual reconnect waits for exact attachment detach before rebuilding`() {
        val owner = TerminalWebViewOwnership()
        val deadView = Any()
        val replacementView = Any()
        assertTrue(owner.bind(deadView))

        val loss = requireNotNull(
            owner.beginViewLoss(
                view = deadView,
                kind = TerminalWebViewLossKind.RENDERER_GONE,
                didCrash = true,
                allowAutomaticRebuild = false,
                settleParserFailure = {},
            ),
        )
        assertTrue(owner.requestRendererRebuild())
        assertEquals(0L, owner.rebuildGeneration.value)
        assertFalse(owner.bind(replacementView))

        assertFalse(loss.completeAfterAttachmentDetach())
        assertEquals(1L, owner.rebuildGeneration.value)
        assertTrue(owner.bind(replacementView))
    }

    @Test
    fun `manual reconnect replaces a bound renderer that never became ready`() {
        val owner = TerminalWebViewOwnership()
        val stuckView = Any()

        assertTrue(owner.bind(stuckView))
        assertFalse(owner.requestRendererRebuild())
        assertTrue(owner.requestRendererRebuild(replaceUnreadyBoundView = true))
        assertEquals(1L, owner.rebuildGeneration.value)
        assertFalse(owner.bind(stuckView))

        val replacementView = Any()
        assertTrue(owner.bind(replacementView))
        assertSame(replacementView, owner.currentView())
    }

    @Test
    fun `stale WebView unbind cannot detach the current generation`() {
        val owner = TerminalWebViewOwnership()
        val staleView = Any()
        val currentView = Any()
        assertTrue(owner.bind(staleView))
        assertTrue(owner.unbind(staleView))
        assertTrue(owner.bind(currentView))

        assertFalse(owner.unbind(staleView))
        assertSame(currentView, owner.currentView())
    }
}
