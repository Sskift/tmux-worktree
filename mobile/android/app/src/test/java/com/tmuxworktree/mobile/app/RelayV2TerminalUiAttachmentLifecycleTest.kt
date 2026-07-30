package com.tmuxworktree.mobile.app

import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class RelayV2TerminalUiAttachmentLifecycleTest {
    @Test
    fun `opening detach waits for exact late attachment`() = runBlocking {
        val lifecycle = RelayV2TerminalUiAttachmentLifecycle<Any>()
        val attachment = Any()

        assertSame(RelayV2TerminalAttachmentDetach.Await, lifecycle.requestDetach())
        val detached = async { lifecycle.awaitDetached() }
        assertFalse(detached.isCompleted)

        val install = lifecycle.install(attachment)
        assertTrue(install is RelayV2TerminalAttachmentInstall.Detach)
        assertSame(
            attachment,
            (install as RelayV2TerminalAttachmentInstall.Detach).attachment,
        )
        lifecycle.completeDetach(attachment)

        detached.await()
        assertTrue(detached.isCompleted)
    }

    @Test
    fun `attached detach has one exact owner and followers await`() = runBlocking {
        val lifecycle = RelayV2TerminalUiAttachmentLifecycle<Any>()
        val attachment = Any()
        assertSame(
            RelayV2TerminalAttachmentInstall.Current,
            lifecycle.install(attachment),
        )

        val first = lifecycle.requestDetach()
        assertTrue(first is RelayV2TerminalAttachmentDetach.Detach)
        assertSame(
            attachment,
            (first as RelayV2TerminalAttachmentDetach.Detach).attachment,
        )
        assertSame(RelayV2TerminalAttachmentDetach.Await, lifecycle.requestDetach())

        lifecycle.completeDetach(attachment)
        lifecycle.awaitDetached()
        assertSame(RelayV2TerminalAttachmentDetach.Detached, lifecycle.requestDetach())
    }

    @Test
    fun `failed exact detach never publishes a detached receipt`() = runBlocking {
        val lifecycle = RelayV2TerminalUiAttachmentLifecycle<Any>()
        val attachment = Any()
        lifecycle.install(attachment)
        lifecycle.requestDetach()
        val failure = IllegalStateException("detach failed")

        lifecycle.failDetach(attachment, failure)

        val observed = runCatching { lifecycle.awaitDetached() }.exceptionOrNull()
        assertTrue(observed is IllegalStateException)
        assertEquals(failure.message, observed?.message)
        assertSame(RelayV2TerminalAttachmentDetach.Await, lifecycle.requestDetach())
        assertNull(lifecycle.attached())
    }
}
