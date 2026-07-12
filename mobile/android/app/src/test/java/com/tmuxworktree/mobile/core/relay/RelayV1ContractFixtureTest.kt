package com.tmuxworktree.mobile.core.relay

import java.nio.charset.StandardCharsets
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RelayV1ContractFixtureTest {
    private val codec = RelayV1Codec()

    @Test
    fun `client contract fixtures encode exactly through the Android codec`() {
        val fixtures = contractFixtures("client-messages.json")
        assertTrue("client relay v1 fixtures must not be empty", fixtures.isNotEmpty())

        fixtures.forEach { fixture ->
            assertEquals(fixture.name, fixture.wireText, codec.encode(fixture.toCommand()))
        }
    }

    @Test
    fun `server contract fixtures decode as their declared Android event types`() {
        val fixtures = contractFixtures("server-messages.json")
        assertTrue("server relay v1 fixtures must not be empty", fixtures.isNotEmpty())

        fixtures.forEach { fixture ->
            val decoded = codec.decode(fixture.wireText)
            assertTrue(fixture.name, decoded is RelayV1DecodeResult.Message)
            assertEquals(
                fixture.name,
                fixture.type,
                (decoded as RelayV1DecodeResult.Message).event.type,
            )
        }
    }

    private fun contractFixtures(resourceName: String): List<ContractFixture> {
        val raw = requireNotNull(javaClass.classLoader?.getResourceAsStream(resourceName)) {
            "Missing required repo-root contracts/relay/v1/$resourceName fixture resource"
        }.bufferedReader(StandardCharsets.UTF_8).use { it.readText() }
        val wrapper = TinyJson.parseObject("{\"fixtures\":$raw}")
        val fixtures = wrapper["fixtures"] as? List<*>
            ?: error("$resourceName must contain a top-level JSON array")
        val decoded = fixtures.mapIndexed { index, value ->
            @Suppress("UNCHECKED_CAST")
            val fixture = value as? Map<String, Any?>
                ?: error("$resourceName fixture $index must be an object")
            val name = fixture.string("name")
            val type = fixture.string("type")
            require(name.isNotBlank()) { "$resourceName fixture $index has no name" }
            require(type.isNotBlank()) { "$resourceName fixture $name has no type" }
            require(fixture.containsKey("normalized")) {
                "$resourceName fixture $name has no normalized value"
            }
            val wireText = fixture["wire"] as? String
                ?: error("$resourceName fixture $name wire must be a minified JSON string")
            require(wireText.isNotBlank()) { "$resourceName fixture $name has blank wire" }
            val wire = TinyJson.parseObject(wireText)
            require(TinyJson.stringify(wire) == wireText) {
                "$resourceName fixture $name wire is not canonical minified JSON"
            }
            require(wire.string("type") == type) {
                "$resourceName fixture $name declares $type but wire has ${wire.string("type")}"
            }
            ContractFixture(name = name, type = type, wireText = wireText, wire = wire)
        }
        require(decoded.map(ContractFixture::name).distinct().size == decoded.size) {
            "$resourceName fixture names must be unique"
        }
        return decoded
    }

    private data class ContractFixture(
        val name: String,
        val type: String,
        val wireText: String,
        val wire: Map<String, Any?>,
    ) {
        fun toCommand(): RelayV1Command = when (type) {
            "list_hosts" -> RelayV1Command.ListHosts(wire.nullableString("requestId"))
            "list_sessions" -> RelayV1Command.ListSessions(
                hostId = wire.nullableString("hostId"),
                requestId = wire.nullableString("requestId"),
            )
            "list_scope_statuses" -> RelayV1Command.ListScopeStatuses(
                hostId = wire.nullableString("hostId"),
                requestId = wire.nullableString("requestId"),
            )
            "create_worktree" -> RelayV1Command.CreateWorktree(
                hostId = wire.nullableString("hostId"),
                requestId = wire.nullableString("requestId"),
                scopeId = wire.nullableString("scopeId"),
                project = wire.nullableString("project"),
                path = wire.nullableString("path"),
                name = wire.nullableString("name"),
                branch = wire.nullableString("branch"),
                aiCommand = wire.nullableString("aiCommand"),
                aiCmd = wire.nullableString("aiCmd"),
            )
            "create_terminal" -> RelayV1Command.CreateTerminal(
                hostId = wire.nullableString("hostId"),
                requestId = wire.nullableString("requestId"),
                scopeId = wire.nullableString("scopeId"),
                cwd = wire.string("cwd"),
                label = wire.nullableString("label"),
            )
            "open_terminal" -> RelayV1Command.OpenTerminal(
                hostId = wire.nullableString("hostId"),
                streamId = wire.string("streamId"),
                session = wire.string("session"),
                pane = wire.pane("pane"),
            )
            "send_agent_message" -> RelayV1Command.SendAgentMessage(
                hostId = wire.nullableString("hostId"),
                requestId = wire.nullableString("requestId"),
                session = wire.string("session"),
                pane = wire.pane("pane"),
                message = wire.string("message"),
                submit = wire.optionalBoolean("submit"),
            )
            "kill_session" -> RelayV1Command.KillSession(
                hostId = wire.nullableString("hostId"),
                requestId = wire.nullableString("requestId"),
                session = wire.string("session"),
            )
            "terminal_input" -> RelayV1Command.TerminalInput(
                streamId = wire.string("streamId"),
                data = wire.string("data"),
            )
            "resize" -> RelayV1Command.Resize(
                streamId = wire.string("streamId"),
                cols = wire.int("cols"),
                rows = wire.int("rows"),
            )
            "close_terminal" -> RelayV1Command.CloseTerminal(wire.string("streamId"))
            else -> error("Unsupported Android relay v1 client fixture type $type ($name)")
        }
    }
}

private fun Map<String, Any?>.pane(name: String): RelayV1Pane? = when (val value = this[name]) {
    null -> null
    is Number -> RelayV1Pane.Number(value.toInt())
    is String -> RelayV1Pane.Text(value)
    else -> error("$name must be a number or string")
}

private fun Map<String, Any?>.optionalBoolean(name: String): Boolean? =
    if (containsKey(name) && this[name] != null) boolean(name) else null
