package com.tmuxworktree.mobile.core.relay.runtime

import com.tmuxworktree.mobile.core.relay.extensions.agentchat.v2.AgentChatImagePart
import com.tmuxworktree.mobile.core.relay.extensions.agentchat.v2.AgentChatMarkdownPart
import com.tmuxworktree.mobile.core.relay.extensions.agentchat.v2.AgentChatTurnView
import java.security.MessageDigest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RelayChatReducerTest {
    @Test
    fun `history result replaces local turns deduplicated by turnId and keeps pending sends`() {
        val session = "local:demo"
        val staleLocalTurn = AgentChatTurnView(
            turnId = "turn-stale",
            session = session,
            userMessage = "old local",
            status = "working",
            sentAt = "2026-01-01T00:00:00Z",
        )
        val state = RelayChatState(
            turnsBySession = mapOf(session to listOf(staleLocalTurn)),
            pendingBySession = mapOf(
                session to listOf(
                    PendingChatSend(
                        requestId = "req-1",
                        session = session,
                        message = "not yet acked",
                        sentAtMillis = 100,
                    ),
                ),
            ),
        )

        val hostTurn1 = AgentChatTurnView(
            turnId = "turn-1",
            session = session,
            userMessage = "hello",
            status = "replied",
            content = listOf(AgentChatMarkdownPart("hi")),
            sentAt = "2026-01-01T00:00:01Z",
        )
        val hostTurn2 = AgentChatTurnView(
            turnId = "turn-2",
            session = session,
            userMessage = "world",
            status = "working",
            sentAt = "2026-01-01T00:00:02Z",
        )
        // Host returns a duplicate turnId to exercise dedup.
        val historyTurns = listOf(hostTurn1, hostTurn2, hostTurn1.copy())

        val reduced = RelayChatReducer.reduce(
            state,
            RelayChatMutation.HistoryResult(session, historyTurns),
        )

        val turns = reduced.turns(session)
        assertEquals(2, turns.size)
        assertEquals(listOf("turn-1", "turn-2"), turns.map { it.turnId })
        // Host authoritative: stale local turn is gone, host turn-1 reply wins.
        assertEquals(
            "hi",
            (turns.first { it.turnId == "turn-1" }.content.single() as AgentChatMarkdownPart).text,
        )
        // Pending sends are retained so the user can still see / retry them.
        assertEquals(1, reduced.pending(session).size)
        assertEquals("req-1", reduced.pending(session).single().requestId)
    }

    @Test
    fun `turn updated upserts by turnId and sorts by sentAt`() {
        val session = "local:demo"
        val imageBytes = "image bytes".toByteArray()
        val imageSha256 = MessageDigest.getInstance("SHA-256")
            .digest(imageBytes)
            .joinToString("") { "%02x".format(it.toInt() and 0xff) }
        val existing = AgentChatTurnView(
            turnId = "turn-1",
            session = session,
            userMessage = "hello",
            status = "working",
            sentAt = "2026-01-01T00:00:01Z",
        )
        val state = RelayChatState(turnsBySession = mapOf(session to listOf(existing)))

        val updated = existing.copy(
            status = "replied",
            content = listOf(
                AgentChatMarkdownPart("hi"),
                AgentChatImagePart(
                    imageId = "image-$imageSha256",
                    mimeType = "image/png",
                    altText = "preview",
                    byteLength = imageBytes.size,
                    sha256 = imageSha256,
                ),
            ),
        )
        val reduced = RelayChatReducer.reduce(
            state,
            RelayChatMutation.TurnUpdated(session, updated),
        )

        val turns = reduced.turns(session)
        assertEquals(1, turns.size)
        assertEquals("replied", turns.single().status)
        assertEquals("hi", (turns.single().content.first() as AgentChatMarkdownPart).text)

        val withImage = RelayChatReducer.reduce(
            reduced,
            RelayChatMutation.ImageChunk(
                session = session,
                imageId = "image-$imageSha256",
                mimeType = "image/png",
                byteLength = imageBytes.size,
                sha256 = imageSha256,
                offset = 0,
                data = imageBytes,
                nextOffset = null,
            ),
        )
        assertTrue(withImage.image("image-$imageSha256")?.complete == true)
        assertArrayEquals(imageBytes, withImage.image("image-$imageSha256")?.bytes)
    }

    @Test
    fun `send failed marks pending as failed and retry clears the flag`() {
        val session = "local:demo"
        val pending = PendingChatSend(
            requestId = "req-1",
            session = session,
            message = "hello",
            sentAtMillis = 100,
        )
        val state = RelayChatState(pendingBySession = mapOf(session to listOf(pending)))

        val failed = RelayChatReducer.reduce(
            state,
            RelayChatMutation.SendFailed("req-1", session, "offline"),
        )
        assertTrue(failed.pending(session).single().failed)
        assertEquals("offline", failed.pending(session).single().error)

        val retried = RelayChatReducer.reduce(
            failed,
            RelayChatMutation.RetryFailed(session),
        )
        val item = retried.pending(session).single()
        assertEquals(false, item.failed)
        assertEquals(null, item.error)
    }
}
