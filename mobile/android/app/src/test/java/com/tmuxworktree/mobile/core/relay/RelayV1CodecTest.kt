package com.tmuxworktree.mobile.core.relay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RelayV1CodecTest {
    private val codec = RelayV1Codec()

    @Test
    fun `encodes all eleven v1 client messages as golden fixtures`() {
        val fixtures = listOf(
            RelayV1Command.ListHosts("hosts-1") to
                "{\"type\":\"list_hosts\",\"requestId\":\"hosts-1\"}",
            RelayV1Command.ListSessions("mac-admin", "sessions-1") to
                "{\"type\":\"list_sessions\",\"hostId\":\"mac-admin\",\"requestId\":\"sessions-1\"}",
            RelayV1Command.ListScopeStatuses("mac-admin", "scopes-1") to
                "{\"type\":\"list_scope_statuses\",\"hostId\":\"mac-admin\",\"requestId\":\"scopes-1\"}",
            RelayV1Command.CreateWorktree(
                hostId = "mac-admin",
                requestId = "create-wt-1",
                scopeId = "local",
                project = "demo",
                name = "fix",
                branch = "main",
                aiCommand = "codex",
            ) to "{\"type\":\"create_worktree\",\"hostId\":\"mac-admin\",\"requestId\":\"create-wt-1\",\"scopeId\":\"local\",\"project\":\"demo\",\"name\":\"fix\",\"branch\":\"main\",\"aiCommand\":\"codex\"}",
            RelayV1Command.CreateTerminal(
                hostId = "mac-admin",
                requestId = "create-term-1",
                scopeId = "mew-dev",
                cwd = "/repo/demo",
                label = "demo",
            ) to "{\"type\":\"create_terminal\",\"hostId\":\"mac-admin\",\"requestId\":\"create-term-1\",\"scopeId\":\"mew-dev\",\"cwd\":\"/repo/demo\",\"label\":\"demo\"}",
            RelayV1Command.OpenTerminal(
                hostId = "mac-admin",
                streamId = "stream-1",
                session = "local:demo",
                pane = RelayV1Pane.Number(2),
            ) to "{\"type\":\"open_terminal\",\"hostId\":\"mac-admin\",\"streamId\":\"stream-1\",\"session\":\"local:demo\",\"pane\":2}",
            RelayV1Command.SendAgentMessage(
                hostId = "mac-admin",
                requestId = "agent-1",
                session = "local:demo",
                pane = RelayV1Pane.Text("1"),
                message = "run\nnow",
                submit = true,
            ) to "{\"type\":\"send_agent_message\",\"hostId\":\"mac-admin\",\"requestId\":\"agent-1\",\"session\":\"local:demo\",\"pane\":\"1\",\"message\":\"run\\nnow\",\"submit\":true}",
            RelayV1Command.KillSession("mac-admin", "kill-1", "local:demo") to
                "{\"type\":\"kill_session\",\"hostId\":\"mac-admin\",\"requestId\":\"kill-1\",\"session\":\"local:demo\"}",
            RelayV1Command.TerminalInput("stream-1", "\u001b[A") to
                "{\"type\":\"terminal_input\",\"streamId\":\"stream-1\",\"data\":\"\\u001b[A\"}",
            RelayV1Command.Resize("stream-1", 120, 40) to
                "{\"type\":\"resize\",\"streamId\":\"stream-1\",\"cols\":120,\"rows\":40}",
            RelayV1Command.CloseTerminal("stream-1") to
                "{\"type\":\"close_terminal\",\"streamId\":\"stream-1\"}",
        )

        fixtures.forEach { (command, fixture) -> assertEquals(command.type, fixture, codec.encode(command)) }
    }

    @Test
    fun `decodes all eleven v1 server messages as golden fixtures`() {
        val session = RelayV1Session(
            name = "local:demo",
            rawName = "demo",
            scopeId = "local",
            scopeLabel = "local",
            kind = "worktree",
            project = "demo",
            label = "Demo",
            cwd = "/repo/demo",
            attached = true,
            windows = 2,
            created = 10,
            activity = 20,
        )
        val fixtures = listOf(
            "{\"type\":\"ready\",\"clientId\":\"client-1\",\"hostId\":\"mac-admin\"}" to
                RelayV1Event.Ready("client-1", "mac-admin"),
            "{\"type\":\"hosts\",\"requestId\":\"hosts-1\",\"hosts\":[{\"hostId\":\"mac-admin\",\"displayName\":\"Mac\",\"connectedAt\":123,\"clients\":1}]}" to
                RelayV1Event.Hosts("hosts-1", listOf(RelayV1Host("mac-admin", "Mac", 123, 1))),
            "{\"type\":\"sessions\",\"requestId\":\"sessions-1\",\"sessions\":[${sessionJson()}]}" to
                RelayV1Event.Sessions("sessions-1", listOf(session)),
            "{\"type\":\"scope_statuses\",\"requestId\":\"scopes-1\",\"scopes\":[{\"scopeId\":\"mew-dev\",\"scopeLabel\":\"Mew\",\"kind\":\"ssh\",\"reachable\":false,\"sessionCount\":0,\"error\":\"offline\"}]}" to
                RelayV1Event.ScopeStatuses(
                    "scopes-1",
                    listOf(RelayV1ScopeStatus("mew-dev", "Mew", "ssh", false, 0, "offline")),
                ),
            "{\"type\":\"worktree_created\",\"requestId\":\"create-wt-1\",\"session\":${sessionJson()}}" to
                RelayV1Event.WorktreeCreated("create-wt-1", session),
            "{\"type\":\"terminal_created\",\"requestId\":\"create-term-1\",\"session\":${sessionJson()}}" to
                RelayV1Event.TerminalCreated("create-term-1", session),
            "{\"type\":\"agent_message_sent\",\"requestId\":\"agent-1\",\"session\":\"local:demo\",\"pane\":2}" to
                RelayV1Event.AgentMessageSent("agent-1", "local:demo", RelayV1Pane.Number(2)),
            "{\"type\":\"session_killed\",\"requestId\":\"kill-1\",\"session\":\"local:demo\"}" to
                RelayV1Event.SessionKilled("kill-1", "local:demo"),
            "{\"type\":\"terminal_data\",\"streamId\":\"stream-1\",\"data\":\"hello\\r\\n\"}" to
                RelayV1Event.TerminalData("stream-1", "hello\r\n"),
            "{\"type\":\"terminal_exit\",\"streamId\":\"stream-1\",\"code\":7}" to
                RelayV1Event.TerminalExit("stream-1", 7),
            "{\"type\":\"error\",\"requestId\":\"kill-1\",\"streamId\":\"stream-1\",\"message\":\"failed\"}" to
                RelayV1Event.Error("kill-1", "stream-1", "failed"),
        )

        fixtures.forEach { (fixture, event) ->
            assertEquals(event.type, RelayV1DecodeResult.Message(event), codec.decode(fixture))
        }
    }

    @Test
    fun `missing request ids remain omitted on requests and nullable on responses`() {
        val requests = listOf(
            RelayV1Command.ListHosts(),
            RelayV1Command.ListSessions(hostId = "mac-admin"),
            RelayV1Command.ListScopeStatuses(hostId = "mac-admin"),
            RelayV1Command.CreateWorktree(hostId = "mac-admin", scopeId = "local"),
            RelayV1Command.CreateTerminal(hostId = "mac-admin", scopeId = "local", cwd = "/tmp"),
            RelayV1Command.SendAgentMessage(
                hostId = "mac-admin",
                session = "local:demo",
                message = "status",
            ),
            RelayV1Command.KillSession(hostId = "mac-admin", session = "local:demo"),
        )
        requests.forEach { command ->
            assertFalse(command.type, TinyJson.parseObject(codec.encode(command)).containsKey("requestId"))
        }

        val responses = listOf(
            "{\"type\":\"hosts\",\"hosts\":[]}",
            "{\"type\":\"sessions\",\"sessions\":[]}",
            "{\"type\":\"scope_statuses\",\"scopes\":[]}",
            "{\"type\":\"worktree_created\",\"session\":{\"name\":\"local:demo\"}}",
            "{\"type\":\"terminal_created\",\"session\":{\"name\":\"local:demo\"}}",
            "{\"type\":\"agent_message_sent\",\"session\":\"local:demo\"}",
            "{\"type\":\"session_killed\",\"session\":\"local:demo\"}",
            "{\"type\":\"error\",\"message\":\"failed\"}",
        )
        responses.forEach { fixture ->
            val event = (codec.decode(fixture) as RelayV1DecodeResult.Message).event
            assertNull(event.type, event.requestId())
        }
    }

    @Test
    fun `pane preserves number and string wire representations`() {
        val numericOpen = RelayV1Command.OpenTerminal(
            hostId = "mac-admin",
            streamId = "stream-number",
            session = "local:demo",
            pane = RelayV1Pane.Number(2),
        )
        val textOpen = numericOpen.copy(
            streamId = "stream-text",
            pane = RelayV1Pane.Text("%2"),
        )
        assertEquals(
            "{\"type\":\"open_terminal\",\"hostId\":\"mac-admin\",\"streamId\":\"stream-number\",\"session\":\"local:demo\",\"pane\":2}",
            codec.encode(numericOpen),
        )
        assertEquals(
            "{\"type\":\"open_terminal\",\"hostId\":\"mac-admin\",\"streamId\":\"stream-text\",\"session\":\"local:demo\",\"pane\":\"%2\"}",
            codec.encode(textOpen),
        )

        assertEquals(
            RelayV1Pane.Number(2),
            codec.agentMessagePane(
                "{\"type\":\"agent_message_sent\",\"session\":\"local:demo\",\"pane\":2}",
            ),
        )
        assertEquals(
            RelayV1Pane.Text("%2"),
            codec.agentMessagePane(
                "{\"type\":\"agent_message_sent\",\"session\":\"local:demo\",\"pane\":\"%2\"}",
            ),
        )
    }

    @Test
    fun `terminal events preserve stream ownership fields without inventing defaults`() {
        assertEquals(
            RelayV1Event.TerminalData("stream-1", "tail"),
            codec.message("{\"type\":\"terminal_data\",\"streamId\":\"stream-1\",\"data\":\"tail\"}"),
        )
        assertEquals(
            RelayV1Event.TerminalExit("stream-1", 0),
            codec.message("{\"type\":\"terminal_exit\",\"streamId\":\"stream-1\",\"code\":0}"),
        )
        assertEquals(
            RelayV1Event.TerminalData(null, "unowned"),
            codec.message("{\"type\":\"terminal_data\",\"data\":\"unowned\"}"),
        )
        assertEquals(
            RelayV1Event.TerminalExit(null, 0),
            codec.message("{\"type\":\"terminal_exit\",\"code\":0}"),
        )
    }

    @Test
    fun `unknown and malformed messages remain non fatal`() {
        assertTrue(codec.decode("{\"type\":\"future_event\",\"value\":1}") is RelayV1DecodeResult.Unknown)
        assertTrue(codec.decode("{not-json") is RelayV1DecodeResult.Malformed)
    }

    private fun sessionJson(): String =
        "{\"name\":\"local:demo\",\"rawName\":\"demo\",\"scopeId\":\"local\",\"scopeLabel\":\"local\",\"kind\":\"worktree\",\"project\":\"demo\",\"label\":\"Demo\",\"cwd\":\"/repo/demo\",\"attached\":true,\"windows\":2,\"created\":10,\"activity\":20}"

    private fun RelayV1Event.requestId(): String? = when (this) {
        is RelayV1Event.Hosts -> requestId
        is RelayV1Event.Sessions -> requestId
        is RelayV1Event.ScopeStatuses -> requestId
        is RelayV1Event.WorktreeCreated -> requestId
        is RelayV1Event.TerminalCreated -> requestId
        is RelayV1Event.AgentMessageSent -> requestId
        is RelayV1Event.SessionKilled -> requestId
        is RelayV1Event.Error -> requestId
        is RelayV1Event.Ready,
        is RelayV1Event.TerminalData,
        is RelayV1Event.TerminalExit,
        -> error("${this::class.java.simpleName} has no requestId")
    }

    private fun RelayV1Codec.message(raw: String): RelayV1Event =
        (decode(raw) as RelayV1DecodeResult.Message).event

    private fun RelayV1Codec.agentMessagePane(raw: String): RelayV1Pane? =
        (message(raw) as RelayV1Event.AgentMessageSent).pane
}
