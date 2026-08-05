package com.tmuxworktree.mobile.core.relay.v1

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RelayV1AgentChatCodecTest {
    private val codec = RelayV1Codec()

    @Test
    fun `encodes agent chat send and history commands with optional fields omitted when null`() {
        val send = RelayV1Command.AgentChatSend(
            hostId = "mac-admin",
            requestId = "chat-1",
            session = "local:demo",
            message = "hello",
        )
        assertEquals(
            "{\"type\":\"agent_chat_send\",\"hostId\":\"mac-admin\",\"requestId\":\"chat-1\",\"session\":\"local:demo\",\"message\":\"hello\"}",
            codec.encode(send),
        )

        val history = RelayV1Command.AgentChatHistory(
            hostId = "mac-admin",
            requestId = "hist-1",
            session = "local:demo",
            limit = 50,
        )
        assertEquals(
            "{\"type\":\"agent_chat_history\",\"hostId\":\"mac-admin\",\"requestId\":\"hist-1\",\"session\":\"local:demo\",\"limit\":50}",
            codec.encode(history),
        )

        // Optional fields are omitted when null.
        val minimalSend = RelayV1Command.AgentChatSend(
            session = "local:demo",
            message = "hi",
        )
        val encoded = TinyJson.parseObject(codec.encode(minimalSend))
        assertEquals("agent_chat_send", encoded["type"])
        assertEquals("local:demo", encoded["session"])
        assertEquals("hi", encoded["message"])
        assertTrue(!encoded.containsKey("hostId"))
        assertTrue(!encoded.containsKey("requestId"))
    }

    @Test
    fun `decodes agent chat sent event and history result with turn view tolerating unknown fields`() {
        val sentRaw =
            "{\"type\":\"agent_chat_sent\",\"clientId\":\"client-1\",\"requestId\":\"chat-1\",\"session\":\"local:demo\",\"turnId\":\"turn-1\"}"
        val sent = codec.message(sentRaw) as RelayV1Event.AgentChatSent
        assertEquals("chat-1", sent.requestId)
        assertEquals("local:demo", sent.session)
        assertEquals("turn-1", sent.turnId)

        val turn = AgentChatTurnView(
            turnId = "turn-1",
            session = "local:demo",
            userMessage = "hello",
            status = "replied",
            reply = "hi there",
            error = null,
            sentAt = "2026-01-01T00:00:00Z",
            completedAt = "2026-01-01T00:00:01Z",
            steeredMessages = listOf(
                AgentChatSteeredMessage("more", "2026-01-01T00:00:02Z"),
            ),
        )
        val eventRaw = buildString {
            append("{\"type\":\"agent_chat_event\",\"clientId\":\"client-1\",\"session\":\"local:demo\"")
            append(",\"turn\":{")
            append("\"turnId\":\"").append(turn.turnId).append("\"")
            append(",\"session\":\"").append(turn.session).append("\"")
            append(",\"userMessage\":\"").append(turn.userMessage).append("\"")
            append(",\"status\":\"").append(turn.status).append("\"")
            append(",\"reply\":\"").append(turn.reply).append("\"")
            append(",\"sentAt\":\"").append(turn.sentAt).append("\"")
            append(",\"completedAt\":\"").append(turn.completedAt).append("\"")
            append(",\"steeredMessages\":[{\"message\":\"more\",\"sentAt\":\"2026-01-01T00:00:02Z\"}]")
            append(",\"unknownField\":\"ignored\"")
            append("}}")
        }
        val event = codec.message(eventRaw) as RelayV1Event.AgentChatEvent
        assertEquals("local:demo", event.session)
        assertEquals(turn, event.turn)

        val historyRaw = buildString {
            append("{\"type\":\"agent_chat_history_result\",\"clientId\":\"client-1\",\"requestId\":\"hist-1\"")
            append(",\"session\":\"local:demo\"")
            append(",\"turns\":[{")
            append("\"turnId\":\"turn-1\",\"session\":\"local:demo\",\"userMessage\":\"hello\"")
            append(",\"status\":\"working\",\"sentAt\":\"2026-01-01T00:00:00Z\"")
            append("}]}")
        }
        val history = codec.message(historyRaw) as RelayV1Event.AgentChatHistoryResult
        assertEquals("hist-1", history.requestId)
        assertEquals("local:demo", history.session)
        assertEquals(1, history.turns.size)
        assertEquals("turn-1", history.turns[0].turnId)
        assertEquals("working", history.turns[0].status)
    }

    private fun RelayV1Codec.message(raw: String): RelayV1Event =
        (decode(raw) as RelayV1DecodeResult.Message).event
}
