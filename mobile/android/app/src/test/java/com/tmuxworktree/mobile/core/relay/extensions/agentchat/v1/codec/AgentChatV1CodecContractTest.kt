package com.tmuxworktree.mobile.core.relay.extensions.agentchat.v1.codec

import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2JsonLimits
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2StrictJson
import java.nio.charset.StandardCharsets
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class AgentChatV1CodecContractTest {
    private val codec = AgentChatV1Codec()

    @Test
    fun `send request round trips`() {
        val frame = AgentChatV1SendRequest(
            session = "scope-1:project",
            message = "hello agent",
            requestId = "agent-chat-request-1",
            hostId = "host-1",
            expectedHostEpoch = "epoch-1",
            scopeId = "scope-1",
            sessionId = "scope-1:project",
        )
        val bytes = codec.encodePublicFrame(frame)
        val decoded = codec.decodePublicFrame(bytes)
        assertEquals(frame, decoded)
        assertArrayEquals(bytes, codec.encodePublicFrame(decoded))
    }

    @Test
    fun `history request round trips with and without limit`() {
        val withoutLimit = AgentChatV1HistoryRequest(
            session = "scope-1:project",
            limit = null,
            requestId = "agent-chat-history-1",
            hostId = "host-1",
            expectedHostEpoch = "epoch-1",
            scopeId = "scope-1",
            sessionId = "scope-1:project",
        )
        val withoutBytes = codec.encodePublicFrame(withoutLimit)
        assertEquals(withoutLimit, codec.decodePublicFrame(withoutBytes))
        assertNull((codec.decodePublicFrame(withoutBytes) as AgentChatV1HistoryRequest).limit)

        val withLimit = withoutLimit.copy(limit = 12)
        val withBytes = codec.encodePublicFrame(withLimit)
        assertEquals(withLimit, codec.decodePublicFrame(withBytes))
    }

    @Test
    fun `sent response round trips`() {
        val frame = AgentChatV1Sent(
            session = "scope-1:project",
            turnId = "turn-1",
            requestId = "agent-chat-request-1",
            hostId = "host-1",
            hostEpoch = "epoch-1",
            scopeId = "scope-1",
            sessionId = "scope-1:project",
        )
        val decoded = codec.decodePublicFrame(codec.encodePublicFrame(frame))
        assertEquals(frame, decoded)
    }

    @Test
    fun `event round trips and toView normalizes status-derived fields`() {
        val repliedTurn = AgentChatV1Turn(
            turnId = "turn-1",
            session = "scope-1:project",
            userMessage = "hello",
            status = "replied",
            reply = "hi there",
            sentAt = "2026-08-06T00:00:00Z",
            completedAt = "2026-08-06T00:00:01Z",
            steeredMessages = listOf(
                AgentChatV1SteeredMessage("steer a", "2026-08-06T00:00:00Z"),
            ),
        )
        val frame = AgentChatV1Event(
            session = "scope-1:project",
            turn = repliedTurn,
            hostId = "host-1",
            hostEpoch = "epoch-1",
            scopeId = "scope-1",
            sessionId = "scope-1:project",
        )
        val decoded = codec.decodePublicFrame(codec.encodePublicFrame(frame))
        assertEquals(frame, decoded)

        val view = (decoded as AgentChatV1Event).turn.toView()
        assertEquals("turn-1", view.turnId)
        assertEquals("replied", view.status)
        assertEquals("hi there", view.reply)
        assertEquals("2026-08-06T00:00:01Z", view.completedAt)
        assertEquals(1, view.steeredMessages.size)

        val workingTurn = repliedTurn.copy(
            status = "working",
            reply = null,
            completedAt = null,
            steeredMessages = emptyList(),
        )
        val workingView = codec.decodePublicFrame(
            codec.encodePublicFrame(frame.copy(turn = workingTurn)),
        ).let { (it as AgentChatV1Event).turn.toView() }
        assertNull(workingView.reply)
        assertNull(workingView.completedAt)
    }

    @Test
    fun `history result round trips`() {
        val turns = listOf(
            AgentChatV1Turn(
                turnId = "turn-1",
                session = "scope-1:project",
                userMessage = "hello",
                status = "replied",
                reply = "hi",
                sentAt = "2026-08-06T00:00:00Z",
                completedAt = "2026-08-06T00:00:01Z",
            ),
            AgentChatV1Turn(
                turnId = "turn-2",
                session = "scope-1:project",
                userMessage = "again",
                status = "working",
                sentAt = "2026-08-06T00:00:02Z",
            ),
        )
        val frame = AgentChatV1HistoryResult(
            session = "scope-1:project",
            turns = turns,
            requestId = "agent-chat-history-1",
            hostId = "host-1",
            hostEpoch = "epoch-1",
            scopeId = "scope-1",
            sessionId = "scope-1:project",
        )
        val decoded = codec.decodePublicFrame(codec.encodePublicFrame(frame))
        assertEquals(frame, decoded)
    }

    @Test
    fun `unavailable error decodes as chat error frame`() {
        val bytes = codec.encodePublicFrame(
            AgentChatV1Error(
                requestId = "agent-chat-request-1",
                hostId = "host-1",
                hostEpoch = "epoch-1",
                scopeId = "scope-1",
                sessionId = "scope-1:project",
                code = "AGENT_CHAT_UNAVAILABLE",
                message = "Relay Agent chat is unavailable",
                retryable = true,
            ),
        )
        val decoded = codec.decodePublicFrame(bytes)
        assertTrue(decoded is AgentChatV1Error)
        assertEquals("AGENT_CHAT_UNAVAILABLE", (decoded as AgentChatV1Error).code)
        assertTrue(decoded.retryable)
    }

    @Test
    fun `working turn with reply is rejected`() {
        val invalid = AgentChatV1Turn(
            turnId = "turn-1",
            session = "scope-1:project",
            userMessage = "hello",
            status = "working",
            reply = "should-not-be-here",
            sentAt = "2026-08-06T00:00:00Z",
        )
        val frame = AgentChatV1Event(
            session = "scope-1:project",
            turn = invalid,
            hostId = "host-1",
            hostEpoch = "epoch-1",
            scopeId = "scope-1",
            sessionId = "scope-1:project",
        )
        assertThrows(AgentChatV1CodecException::class.java) {
            codec.encodePublicFrame(frame)
        }
    }

    @Test
    fun `unknown message type is rejected`() {
        val wire = linkedMapOf<String, Any?>(
            "protocolVersion" to 2,
            "kind" to "event",
            "type" to "agent.chat.nope",
            "hostId" to "host-1",
            "hostEpoch" to "epoch-1",
            "scopeId" to "scope-1",
            "sessionId" to "scope-1:project",
            "payload" to linkedMapOf<String, Any?>("session" to "scope-1:project"),
        )
        val bytes = RelayV2StrictJson.stringify(wire).toByteArray(StandardCharsets.UTF_8)
        assertThrows(AgentChatV1CodecException::class.java) {
            codec.decodePublicFrame(bytes)
        }
    }

    @Test
    fun `binary opcode and compression are rejected`() {
        val frame = AgentChatV1SendRequest(
            session = "scope-1:project",
            message = "hello",
            requestId = "agent-chat-request-1",
            hostId = "host-1",
            expectedHostEpoch = "epoch-1",
            scopeId = "scope-1",
            sessionId = "scope-1:project",
        )
        val bytes = codec.encodePublicFrame(frame)
        assertThrows(AgentChatV1CodecException::class.java) {
            codec.decodePublicFrame(bytes, AgentChatV1FrameMetadata(opcode = "binary"))
        }
        assertThrows(AgentChatV1CodecException::class.java) {
            codec.decodePublicFrame(bytes, AgentChatV1FrameMetadata(compressed = true))
        }
    }

    @Test
    fun `capability constant matches contract`() {
        assertEquals("agent.chat.v1", AGENT_CHAT_V1_CAPABILITY)
    }

    @Test
    fun `host epoch mismatch error requires details`() {
        val invalid = AgentChatV1Error(
            requestId = "agent-chat-request-1",
            hostId = "host-1",
            hostEpoch = "epoch-1",
            scopeId = "scope-1",
            sessionId = "scope-1:project",
            code = "HOST_EPOCH_MISMATCH",
            message = "host epoch mismatch",
            retryable = true,
        )
        assertThrows(AgentChatV1CodecException::class.java) {
            codec.encodePublicFrame(invalid)
        }
    }

    @Test
    fun `turn limit is enforced on history result`() {
        val turns = List(257) { index ->
            AgentChatV1Turn(
                turnId = "turn-$index",
                session = "scope-1:project",
                userMessage = "msg-$index",
                status = "working",
                sentAt = "2026-08-06T00:00:00Z",
            )
        }
        val frame = AgentChatV1HistoryResult(
            session = "scope-1:project",
            turns = turns,
            requestId = "agent-chat-history-1",
            hostId = "host-1",
            hostEpoch = "epoch-1",
            scopeId = "scope-1",
            sessionId = "scope-1:project",
        )
        assertThrows(AgentChatV1CodecException::class.java) {
            codec.encodePublicFrame(frame)
        }
    }
}
