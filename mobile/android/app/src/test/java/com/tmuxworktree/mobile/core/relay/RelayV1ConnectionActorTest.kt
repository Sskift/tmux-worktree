package com.tmuxworktree.mobile.core.relay

import com.tmuxworktree.mobile.core.model.TransportPhase
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.filterIsInstance
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RelayV1ConnectionActorTest {
    @Test
    fun `request timeout policy maps every request kind independently`() {
        val policy = RelayRequestTimeoutPolicy(
            hostsMillis = 1,
            sessionsMillis = 2,
            scopesMillis = 3,
            createWorktreeMillis = 4,
            createTerminalMillis = 5,
            sendAgentMessageMillis = 6,
            killSessionMillis = 7,
        )

        assertEquals(1L, policy.timeoutMillis(RelayRequestKind.HOSTS))
        assertEquals(2L, policy.timeoutMillis(RelayRequestKind.SESSIONS))
        assertEquals(3L, policy.timeoutMillis(RelayRequestKind.SCOPES))
        assertEquals(4L, policy.timeoutMillis(RelayRequestKind.CREATE_WORKTREE))
        assertEquals(5L, policy.timeoutMillis(RelayRequestKind.CREATE_TERMINAL))
        assertEquals(6L, policy.timeoutMillis(RelayRequestKind.SEND_AGENT_MESSAGE))
        assertEquals(7L, policy.timeoutMillis(RelayRequestKind.KILL_SESSION))
    }

    @Test
    fun `actor authenticates loads snapshots and forwards terminal output`() = runBlocking {
        val commands = CopyOnWriteArrayList<String>()
        val server = MockWebServer()
        server.enqueue(
            MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    webSocket.send("{\"type\":\"ready\",\"clientId\":\"client-1\"}")
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    val payload = TinyJson.parseObject(text)
                    val type = payload.string("type")
                    commands += type
                    when (type) {
                        "list_hosts" -> webSocket.send(
                            "{\"type\":\"hosts\",\"requestId\":\"${payload.string("requestId")}\",\"hosts\":[{\"hostId\":\"mac-admin\",\"displayName\":\"Mac\",\"clients\":1}]}",
                        )
                        "list_sessions" -> webSocket.send(
                            "{\"type\":\"sessions\",\"requestId\":\"${payload.string("requestId")}\",\"sessions\":[{\"name\":\"local:demo\",\"rawName\":\"demo\",\"scopeId\":\"local\",\"scopeLabel\":\"local\",\"kind\":\"worktree\",\"project\":\"demo\",\"windows\":1}]}",
                        )
                        "list_scope_statuses" -> webSocket.send(
                            "{\"type\":\"scope_statuses\",\"requestId\":\"${payload.string("requestId")}\",\"scopes\":[{\"scopeId\":\"local\",\"scopeLabel\":\"local\",\"kind\":\"local\",\"reachable\":true,\"sessionCount\":1}]}",
                        )
                        "open_terminal" -> webSocket.send(
                            "{\"type\":\"terminal_data\",\"streamId\":\"${payload.string("streamId")}\",\"data\":\"hello\"}",
                        )
                    }
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(code, reason)
                }
            }),
        )
        server.start()
        val actorScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val actor = RelayV1ConnectionActor(actorScope)

        try {
            actor.connect(
                RelayV1ConnectionConfig(
                    relayUrl = server.url("/").toString().replaceFirst("http://", "ws://"),
                    bearerToken = "secret",
                    preferredHostId = "mac-admin",
                ),
            )

            val snapshot = withTimeout(5_000) {
                actor.snapshots.first { it.sessions.isNotEmpty() && it.scopes.isNotEmpty() }
            }
            assertEquals("Mac", snapshot.hosts.single().displayName)
            assertEquals("demo", snapshot.sessions.single().project)
            assertEquals("local", snapshot.scopes.single().scopeId)
            assertTrue(commands.containsAll(listOf("list_hosts", "list_sessions", "list_scope_statuses")))

            val output = async(start = CoroutineStart.UNDISPATCHED) {
                withTimeout(5_000) {
                    actor.events.first { it is RelayClientEvent.TerminalData } as RelayClientEvent.TerminalData
                }
            }
            val streamId = actor.openTerminal("mac-admin", "local:demo")
            assertEquals("hello", output.await().data)
            assertEquals(streamId, actor.terminal.value.streamId)

            val upgrade = server.takeRequest(5, TimeUnit.SECONDS)
            assertEquals("Bearer secret", upgrade?.getHeader("Authorization"))
            assertEquals("/client", upgrade?.path)
        } finally {
            actor.close()
            actorScope.cancel()
            server.shutdown()
        }
    }

    @Test
    fun `terminal output is batched in order and flushed before exit`() = runBlocking {
        val commands = CopyOnWriteArrayList<String>()
        val server = MockWebServer()
        server.enqueue(
            MockResponse().withWebSocketUpgrade(
                snapshotListener(commands) { webSocket, payload ->
                    val streamId = payload.string("streamId")
                    webSocket.send(
                        "{\"type\":\"terminal_data\",\"streamId\":\"$streamId\",\"data\":\"hello \"}",
                    )
                    webSocket.send(
                        "{\"type\":\"terminal_data\",\"streamId\":\"$streamId\",\"data\":\"world\"}",
                    )
                    webSocket.send(
                        "{\"type\":\"terminal_exit\",\"streamId\":\"$streamId\",\"code\":0}",
                    )
                },
            ),
        )
        server.start()
        val actorScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val actor = RelayV1ConnectionActor(actorScope)

        try {
            actor.connect(configFor(server))
            withTimeout(5_000) { actor.snapshots.first { it.sessions.isNotEmpty() } }
            val terminalEvents = async(start = CoroutineStart.UNDISPATCHED) {
                withTimeout(5_000) {
                    actor.events
                        .filter {
                            it is RelayClientEvent.TerminalData ||
                                it is RelayClientEvent.TerminalExit
                        }
                        .take(2)
                        .toList()
                }
            }

            val streamId = actor.openTerminal("mac-admin", "local:demo")
            val events = terminalEvents.await()

            val output = events[0] as RelayClientEvent.TerminalData
            val exit = events[1] as RelayClientEvent.TerminalExit
            assertEquals(streamId, output.streamId)
            assertEquals("hello world", output.data)
            assertEquals(streamId, exit.streamId)
            assertEquals(0, exit.code)
        } finally {
            actor.close()
            actorScope.cancel()
            server.shutdown()
        }
    }

    @Test
    fun `actor maps websocket 401 to auth required without retry`() = runBlocking {
        val server = MockWebServer()
        server.enqueue(MockResponse().setResponseCode(401).setBody("unauthorized"))
        server.start()
        val actorScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val actor = RelayV1ConnectionActor(actorScope)
        try {
            actor.connect(
                RelayV1ConnectionConfig(
                    relayUrl = server.url("/").toString().replaceFirst("http://", "ws://"),
                    bearerToken = "bad",
                ),
            )
            val health = withTimeout(5_000) {
                actor.health.first { it.phase == TransportPhase.AUTH_REQUIRED }
            }
            assertEquals("AUTH_REQUIRED", health.errorCode)
            assertEquals(null, health.retryAtMillis)
        } finally {
            actor.close()
            actorScope.cancel()
            server.shutdown()
        }
    }

    @Test
    fun `request rejections are buffered losslessly and retain request context`() = runBlocking {
        val actorScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val actor = RelayV1ConnectionActor(actorScope)
        try {
            val requestIds = (1..300).map { actor.refreshHosts() }.toSet()

            val rejections = withTimeout(5_000) {
                actor.events
                    .filterIsInstance<RelayClientEvent.CommandRejected>()
                    .take(requestIds.size)
                    .toList()
            }

            assertEquals(requestIds.size, rejections.size)
            assertEquals(requestIds, rejections.mapNotNull { it.request?.requestId }.toSet())
            assertTrue(rejections.all { it.request?.kind == RelayRequestKind.HOSTS })
            assertTrue(rejections.all { it.reason.contains("not connected", ignoreCase = true) })
            assertTrue(rejections.none { it.reason.contains("ambiguous", ignoreCase = true) })
        } finally {
            actor.close()
            actorScope.cancel()
        }
    }

    @Test
    fun `actor backs off when relay handshake does not become ready within deadline`() = runBlocking {
        val server = MockWebServer()
        server.enqueue(
            MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(code, reason)
                }
            }),
        )
        server.start()
        val actorScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val actor = RelayV1ConnectionActor(
            parentScope = actorScope,
            handshakeTimeoutMillis = 100,
        )
        try {
            actor.connect(
                RelayV1ConnectionConfig(
                    relayUrl = server.url("/").toString().replaceFirst("http://", "ws://"),
                    bearerToken = "secret",
                ),
            )

            val health = withTimeout(5_000) {
                actor.health.first {
                    it.phase == TransportPhase.BACKING_OFF &&
                        it.errorMessage.contains("handshake timed out", ignoreCase = true)
                }
            }
            assertEquals("CONNECTION_FAILED", health.errorCode)
            assertTrue(health.retryAtMillis != null)
        } finally {
            actor.close()
            actorScope.cancel()
            server.shutdown()
        }
    }

    @Test
    fun `request timeout is reported as ambiguous with its exact context`() = runBlocking {
        val server = MockWebServer()
        server.enqueue(
            MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    webSocket.send("{\"type\":\"ready\",\"clientId\":\"client-timeout\"}")
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(code, reason)
                }
            }),
        )
        server.start()
        val actorScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val actor = RelayV1ConnectionActor(
            parentScope = actorScope,
            requestTimeoutPolicy = RelayRequestTimeoutPolicy(
                hostsMillis = 5_000,
                sendAgentMessageMillis = 100,
            ),
        )
        try {
            actor.connect(
                RelayV1ConnectionConfig(
                    relayUrl = server.url("/").toString().replaceFirst("http://", "ws://"),
                    bearerToken = "secret",
                    preferredHostId = "mac-admin",
                ),
            )
            withTimeout(5_000) {
                actor.health.first { it.phase == TransportPhase.ONLINE }
            }

            val requestId = actor.sendAgentMessage("mac-admin", "session-one", "hello")
            val rejection = withTimeout(5_000) {
                actor.events.filterIsInstance<RelayClientEvent.CommandRejected>().first {
                    it.request?.requestId == requestId
                }
            }

            assertEquals("send_agent_message", rejection.type)
            assertEquals(RelayRequestKind.SEND_AGENT_MESSAGE, rejection.request?.kind)
            assertEquals("mac-admin", rejection.request?.hostId)
            assertEquals("session-one", rejection.request?.sessionName)
            assertTrue(rejection.reason.contains("before acknowledgement", ignoreCase = true))
            assertTrue(rejection.reason.contains("ambiguous", ignoreCase = true))
        } finally {
            actor.close()
            actorScope.cancel()
            server.shutdown()
        }
    }

    @Test
    fun `socket failure rejects only registered commands as ambiguous`() = runBlocking {
        val server = MockWebServer()
        server.enqueue(
            MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    webSocket.send("{\"type\":\"ready\",\"clientId\":\"client-drop\"}")
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    if (TinyJson.parseObject(text).string("type") == "send_agent_message") {
                        webSocket.cancel()
                    }
                }
            }),
        )
        server.start()
        val actorScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val actor = RelayV1ConnectionActor(actorScope)
        try {
            actor.connect(
                RelayV1ConnectionConfig(
                    relayUrl = server.url("/").toString().replaceFirst("http://", "ws://"),
                    bearerToken = "secret",
                    preferredHostId = "mac-admin",
                ),
            )
            withTimeout(5_000) {
                actor.health.first { it.phase == TransportPhase.ONLINE }
            }

            val requestId = actor.sendAgentMessage("mac-admin", "session-drop", "hello")
            val rejection = withTimeout(5_000) {
                actor.events.filterIsInstance<RelayClientEvent.CommandRejected>().first {
                    it.request?.requestId == requestId
                }
            }

            assertEquals(RelayRequestKind.SEND_AGENT_MESSAGE, rejection.request?.kind)
            assertTrue(rejection.reason.contains("before acknowledgement", ignoreCase = true))
            assertTrue(rejection.reason.contains("ambiguous", ignoreCase = true))
        } finally {
            actor.close()
            actorScope.cancel()
            server.shutdown()
        }
    }

    @Test
    fun `disconnect and await is a barrier after ambiguous request rejection and state reset`() = runBlocking {
        val server = MockWebServer()
        server.enqueue(
            MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    webSocket.send("{\"type\":\"ready\",\"clientId\":\"client-barrier\"}")
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(code, reason)
                }
            }),
        )
        server.start()
        val actorScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val actor = RelayV1ConnectionActor(actorScope)
        try {
            actor.connect(
                RelayV1ConnectionConfig(
                    relayUrl = server.url("/").toString().replaceFirst("http://", "ws://"),
                    bearerToken = "secret",
                    preferredHostId = "mac-admin",
                ),
            )
            withTimeout(5_000) {
                actor.health.first { it.phase == TransportPhase.ONLINE }
            }

            val requestId = actor.sendAgentMessage("mac-admin", "session-barrier", "hello")
            val barrierId = "disconnect-barrier"
            actor.disconnectAndAwait(barrierId)

            assertEquals(TransportPhase.STOPPED, actor.health.value.phase)
            assertTrue(actor.snapshots.value.hosts.isEmpty())
            assertEquals(null, actor.terminal.value.streamId)
            val rejection = withTimeout(5_000) {
                actor.events.filterIsInstance<RelayClientEvent.CommandRejected>().first {
                    it.request?.requestId == requestId
                }
            }
            assertTrue(rejection.reason.contains("before acknowledgement", ignoreCase = true))
            assertTrue(rejection.reason.contains("ambiguous", ignoreCase = true))
            val disconnected = withTimeout(5_000) {
                actor.events.filterIsInstance<RelayClientEvent.Disconnected>().first()
            }
            assertEquals(barrierId, disconnected.barrierId)
        } finally {
            actor.close()
            actorScope.cancel()
            server.shutdown()
        }
    }

    @Test
    fun `profile switch rejects pending request with ambiguous context before opening replacement`() = runBlocking {
        val server = MockWebServer()
        server.enqueue(
            MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    webSocket.send("{\"type\":\"ready\",\"clientId\":\"client-switch\"}")
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(code, reason)
                }
            }),
        )
        server.start()
        val actorScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val actor = RelayV1ConnectionActor(actorScope)
        try {
            actor.connect(
                RelayV1ConnectionConfig(
                    relayUrl = server.url("/").toString().replaceFirst("http://", "ws://"),
                    bearerToken = "secret",
                    preferredHostId = "mac-admin",
                ),
            )
            withTimeout(5_000) {
                actor.health.first { it.phase == TransportPhase.ONLINE }
            }

            val requestId = actor.sendAgentMessage("mac-admin", "session-switch", "hello")
            actor.connect(
                RelayV1ConnectionConfig(
                    relayUrl = "not-a-valid-relay-url",
                    bearerToken = "replacement",
                ),
            )

            val rejection = withTimeout(5_000) {
                actor.events.filterIsInstance<RelayClientEvent.CommandRejected>().first {
                    it.request?.requestId == requestId
                }
            }
            assertEquals(RelayRequestKind.SEND_AGENT_MESSAGE, rejection.request?.kind)
            assertTrue(rejection.reason.contains("Connection changed", ignoreCase = true))
            assertTrue(rejection.reason.contains("ambiguous", ignoreCase = true))
        } finally {
            actor.close()
            actorScope.cancel()
            server.shutdown()
        }
    }

    @Test
    fun `peer closing is acknowledged and immediately enters reconnect backoff`() = runBlocking {
        val server = MockWebServer()
        server.enqueue(
            MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    webSocket.send("{\"type\":\"ready\",\"clientId\":\"closing-client\"}")
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    val payload = TinyJson.parseObject(text)
                    if (payload.string("type") == "list_hosts") {
                        webSocket.send(
                            "{\"type\":\"hosts\",\"requestId\":\"${payload.string("requestId")}\",\"hosts\":[]}",
                        )
                        webSocket.close(1012, "relay restart")
                    }
                }
            }),
        )
        server.start()
        val actorScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val actor = RelayV1ConnectionActor(actorScope)
        try {
            actor.connect(configFor(server))

            val health = withTimeout(5_000) {
                actor.health.first { it.phase == TransportPhase.BACKING_OFF }
            }
            assertEquals("CONNECTION_CLOSED", health.errorCode)
            assertTrue(health.errorMessage.contains("relay restart"))
            assertEquals(1, health.attempt)
        } finally {
            actor.close()
            actorScope.cancel()
            server.shutdown()
        }
    }

    @Test
    fun `silent terminal open times out with explicit error and terminal state`() = runBlocking {
        val commands = CopyOnWriteArrayList<String>()
        val server = MockWebServer()
        server.enqueue(MockResponse().withWebSocketUpgrade(snapshotListener(commands)))
        server.start()
        val actorScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val actor = RelayV1ConnectionActor(
            parentScope = actorScope,
            terminalOpenTimeoutMillis = 100,
        )
        try {
            actor.connect(configFor(server))
            withTimeout(5_000) { actor.snapshots.first { it.sessions.isNotEmpty() } }

            val timeoutError = async(start = CoroutineStart.UNDISPATCHED) {
                withTimeout(5_000) {
                    actor.events.filterIsInstance<RelayClientEvent.Error>().first {
                        it.message.contains("did not open")
                    }
                }
            }
            val streamId = actor.openTerminal("mac-admin", "local:demo")
            val error = timeoutError.await()

            assertEquals(streamId, error.streamId)
            assertEquals(com.tmuxworktree.mobile.core.model.ConnectionStatus.UNKNOWN, actor.terminal.value.status)
            assertNull(actor.terminal.value.streamId)
            assertTrue(actor.terminal.value.resetReason.contains("100ms"))
            waitUntil { commands.contains("close_terminal") }
        } finally {
            actor.close()
            actorScope.cancel()
            server.shutdown()
        }
    }

    @Test
    fun `first terminal data cancels open watchdog`() = runBlocking {
        val commands = CopyOnWriteArrayList<String>()
        val server = MockWebServer()
        server.enqueue(
            MockResponse().withWebSocketUpgrade(
                snapshotListener(commands) { webSocket, payload ->
                    webSocket.send(
                        "{\"type\":\"terminal_data\",\"streamId\":\"${payload.string("streamId")}\",\"data\":\"ready\"}",
                    )
                },
            ),
        )
        server.start()
        val actorScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val actor = RelayV1ConnectionActor(
            parentScope = actorScope,
            terminalOpenTimeoutMillis = 75,
        )
        try {
            actor.connect(configFor(server))
            withTimeout(5_000) { actor.snapshots.first { it.sessions.isNotEmpty() } }
            val streamId = actor.openTerminal("mac-admin", "local:demo")
            withTimeout(5_000) {
                actor.terminal.first {
                    it.streamId == streamId &&
                        it.status == com.tmuxworktree.mobile.core.model.ConnectionStatus.ONLINE
                }
            }
            delay(200)

            assertEquals(com.tmuxworktree.mobile.core.model.ConnectionStatus.ONLINE, actor.terminal.value.status)
            assertEquals(streamId, actor.terminal.value.streamId)
            assertFalse(commands.contains("close_terminal"))
        } finally {
            actor.close()
            actorScope.cancel()
            server.shutdown()
        }
    }

    @Test
    fun `same config reconnect and network pause preserve desired terminal while profile change clears it`() = runBlocking {
        val commands = CopyOnWriteArrayList<String>()
        val openedStreams = CopyOnWriteArrayList<String>()
        val server = MockWebServer()
        repeat(3) {
            server.enqueue(
                MockResponse().withWebSocketUpgrade(
                    snapshotListener(commands) { webSocket, payload ->
                        val streamId = payload.string("streamId")
                        openedStreams += streamId
                        webSocket.send(
                            "{\"type\":\"terminal_data\",\"streamId\":\"$streamId\",\"data\":\"connected\"}",
                        )
                    },
                ),
            )
        }
        server.start()
        val actorScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val actor = RelayV1ConnectionActor(actorScope)
        val config = configFor(server)
        try {
            actor.connect(config)
            withTimeout(5_000) { actor.snapshots.first { it.sessions.isNotEmpty() } }
            actor.openTerminal("mac-admin", "local:demo")
            withTimeout(5_000) { actor.terminal.first { it.status.name == "ONLINE" } }
            val firstGeneration = actor.terminal.value.generation

            actor.connect(config)
            waitUntil { openedStreams.size >= 2 && actor.terminal.value.status.name == "ONLINE" }
            assertTrue(actor.terminal.value.generation > firstGeneration)
            assertEquals(2, openedStreams.distinct().size)

            actor.pauseForNetwork()
            withTimeout(5_000) {
                actor.health.first { it.phase == TransportPhase.WAITING_FOR_NETWORK }
            }
            assertEquals(com.tmuxworktree.mobile.core.model.ConnectionStatus.PAUSED, actor.terminal.value.status)
            assertNull(actor.terminal.value.streamId)

            actor.connect(config)
            waitUntil { openedStreams.size >= 3 && actor.terminal.value.status.name == "ONLINE" }
            assertEquals(3, openedStreams.distinct().size)

            actor.connect(
                RelayV1ConnectionConfig(
                    relayUrl = "not-a-valid-relay-url",
                    bearerToken = "replacement",
                ),
            )
            withTimeout(5_000) {
                actor.health.first { it.phase == TransportPhase.INCOMPATIBLE }
            }
            assertEquals(com.tmuxworktree.mobile.core.model.ConnectionStatus.OFFLINE, actor.terminal.value.status)
            assertNull(actor.terminal.value.streamId)
        } finally {
            actor.close()
            actorScope.cancel()
            server.shutdown()
        }
    }

    @Test
    fun `created session is reported without opening terminal in background`() = runBlocking {
        val commands = CopyOnWriteArrayList<String>()
        val server = MockWebServer()
        server.enqueue(
            MockResponse().withWebSocketUpgrade(
                snapshotListener(commands) { _, _ -> Unit }.withCommandHandler { webSocket, payload ->
                    if (payload.string("type") == "create_terminal") {
                        webSocket.send(
                            "{\"type\":\"terminal_created\",\"requestId\":\"${payload.string("requestId")}\",\"session\":${sessionJson("local:created")}}",
                        )
                    }
                },
            ),
        )
        server.start()
        val actorScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val actor = RelayV1ConnectionActor(actorScope)
        try {
            actor.connect(configFor(server))
            withTimeout(5_000) { actor.snapshots.first { it.sessions.isNotEmpty() } }
            val created = async(start = CoroutineStart.UNDISPATCHED) {
                withTimeout(5_000) {
                    actor.events.filterIsInstance<RelayClientEvent.TerminalCreated>().first()
                }
            }
            actor.createTerminal("mac-admin", "local", "/tmp")

            assertEquals("local:created", created.await().session.name)
            delay(250)
            assertEquals(0, commands.count { it == "open_terminal" })
            assertNull(actor.terminal.value.streamId)
        } finally {
            actor.close()
            actorScope.cancel()
            server.shutdown()
        }
    }

    @Test
    fun `unknown nonempty response ids are stale while blank ids use latest compatible request`() = runBlocking {
        val commands = CopyOnWriteArrayList<String>()
        val socketRef = AtomicReference<WebSocket>()
        val scopeRequestCount = AtomicInteger()
        val server = MockWebServer()
        server.enqueue(
            MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    socketRef.set(webSocket)
                    webSocket.send("{\"type\":\"ready\",\"clientId\":\"compat-client\"}")
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    val payload = TinyJson.parseObject(text)
                    val type = payload.string("type")
                    commands += type
                    when (type) {
                        "list_hosts" -> webSocket.send(
                            "{\"type\":\"hosts\",\"requestId\":\"${payload.string("requestId")}\",\"hosts\":[{\"hostId\":\"mac-admin\",\"displayName\":\"Mac\",\"clients\":1}]}",
                        )
                        "list_sessions" -> webSocket.send(
                            "{\"type\":\"sessions\",\"requestId\":\"${payload.string("requestId")}\",\"sessions\":[]}",
                        )
                        "list_scope_statuses" -> if (scopeRequestCount.incrementAndGet() == 1) {
                            webSocket.send(
                                "{\"type\":\"scope_statuses\",\"requestId\":\"${payload.string("requestId")}\",\"scopes\":[]}",
                            )
                        }
                    }
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(code, reason)
                }
            }),
        )
        server.start()
        val actorScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val actor = RelayV1ConnectionActor(actorScope)
        try {
            actor.connect(configFor(server))
            waitUntil { scopeRequestCount.get() == 1 }
            val socket = socketRef.get()

            actor.refreshScopes("mac-admin")
            waitUntil { scopeRequestCount.get() == 2 }
            val scopeWarning = async(start = CoroutineStart.UNDISPATCHED) {
                withTimeout(5_000) {
                    actor.events.filterIsInstance<RelayClientEvent.ProtocolWarning>().first {
                        it.message.contains("unknown requestId") && it.message.contains("scope")
                    }
                }
            }
            socket.send(
                "{\"type\":\"scope_statuses\",\"requestId\":\"unknown-scopes\",\"scopes\":[{\"scopeId\":\"bad\",\"scopeLabel\":\"Bad\",\"kind\":\"local\",\"reachable\":true,\"sessionCount\":1}]}",
            )
            scopeWarning.await()
            assertTrue(actor.snapshots.value.scopes.isEmpty())

            socket.send(
                "{\"type\":\"scope_statuses\",\"scopes\":[{\"scopeId\":\"good\",\"scopeLabel\":\"Good\",\"kind\":\"local\",\"reachable\":true,\"sessionCount\":1}]}",
            )
            withTimeout(5_000) { actor.snapshots.first { it.scopes.singleOrNull()?.scopeId == "good" } }

            val agentRequestId = actor.sendAgentMessage("mac-admin", "local:good", "hello")
            waitUntil { commands.contains("send_agent_message") }
            val errorWarning = async(start = CoroutineStart.UNDISPATCHED) {
                withTimeout(5_000) {
                    actor.events.filterIsInstance<RelayClientEvent.ProtocolWarning>().first {
                        it.message.contains("unknown requestId") && it.message.contains("error")
                    }
                }
            }
            socket.send("{\"type\":\"error\",\"requestId\":\"unknown-error\",\"message\":\"stale error\"}")
            errorWarning.await()
            val latestError = async(start = CoroutineStart.UNDISPATCHED) {
                withTimeout(5_000) { actor.events.filterIsInstance<RelayClientEvent.Error>().first() }
            }
            socket.send("{\"type\":\"error\",\"message\":\"latest error\"}")
            assertEquals(agentRequestId, latestError.await().request?.requestId)

            actor.createTerminal("mac-admin", "local", "/tmp")
            waitUntil { commands.contains("create_terminal") }
            val createdWarning = async(start = CoroutineStart.UNDISPATCHED) {
                withTimeout(5_000) {
                    actor.events.filterIsInstance<RelayClientEvent.ProtocolWarning>().first {
                        it.message.contains("unknown requestId") && it.message.contains("terminal created")
                    }
                }
            }
            socket.send(
                "{\"type\":\"terminal_created\",\"requestId\":\"unknown-created\",\"session\":${sessionJson("local:bad")}}",
            )
            createdWarning.await()
            assertFalse(actor.snapshots.value.sessions.any { it.name == "local:bad" })

            val created = async(start = CoroutineStart.UNDISPATCHED) {
                withTimeout(5_000) { actor.events.filterIsInstance<RelayClientEvent.TerminalCreated>().first() }
            }
            socket.send("{\"type\":\"terminal_created\",\"session\":${sessionJson("local:good")}}")
            created.await()
            assertTrue(actor.snapshots.value.sessions.any { it.name == "local:good" })

            actor.killSession("mac-admin", "local:good")
            waitUntil { commands.contains("kill_session") }
            val killedWarning = async(start = CoroutineStart.UNDISPATCHED) {
                withTimeout(5_000) {
                    actor.events.filterIsInstance<RelayClientEvent.ProtocolWarning>().first {
                        it.message.contains("unknown requestId") && it.message.contains("session killed")
                    }
                }
            }
            socket.send(
                "{\"type\":\"session_killed\",\"requestId\":\"unknown-killed\",\"session\":\"local:good\"}",
            )
            killedWarning.await()
            assertTrue(actor.snapshots.value.sessions.any { it.name == "local:good" })

            val killed = async(start = CoroutineStart.UNDISPATCHED) {
                withTimeout(5_000) { actor.events.filterIsInstance<RelayClientEvent.SessionKilled>().first() }
            }
            socket.send("{\"type\":\"session_killed\",\"session\":\"local:good\"}")
            killed.await()
            assertFalse(actor.snapshots.value.sessions.any { it.name == "local:good" })
        } finally {
            actor.close()
            actorScope.cancel()
            server.shutdown()
        }
    }

    private fun configFor(server: MockWebServer): RelayV1ConnectionConfig = RelayV1ConnectionConfig(
        relayUrl = server.url("/").toString().replaceFirst("http://", "ws://"),
        bearerToken = "secret",
        preferredHostId = "mac-admin",
    )

    private fun snapshotListener(
        commands: MutableList<String>,
        onOpenTerminal: (WebSocket, Map<String, Any?>) -> Unit = { _, _ -> Unit },
    ): WebSocketListener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            webSocket.send("{\"type\":\"ready\",\"clientId\":\"snapshot-client\"}")
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            val payload = TinyJson.parseObject(text)
            val type = payload.string("type")
            commands += type
            when (type) {
                "list_hosts" -> webSocket.send(
                    "{\"type\":\"hosts\",\"requestId\":\"${payload.string("requestId")}\",\"hosts\":[{\"hostId\":\"mac-admin\",\"displayName\":\"Mac\",\"clients\":1}]}",
                )
                "list_sessions" -> webSocket.send(
                    "{\"type\":\"sessions\",\"requestId\":\"${payload.string("requestId")}\",\"sessions\":[${sessionJson("local:demo")}]}",
                )
                "list_scope_statuses" -> webSocket.send(
                    "{\"type\":\"scope_statuses\",\"requestId\":\"${payload.string("requestId")}\",\"scopes\":[{\"scopeId\":\"local\",\"scopeLabel\":\"local\",\"kind\":\"local\",\"reachable\":true,\"sessionCount\":1}]}",
                )
                "open_terminal" -> onOpenTerminal(webSocket, payload)
            }
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(code, reason)
        }
    }

    private fun WebSocketListener.withCommandHandler(
        handler: (WebSocket, Map<String, Any?>) -> Unit,
    ): WebSocketListener {
        val delegate = this
        return object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) = delegate.onOpen(webSocket, response)
            override fun onMessage(webSocket: WebSocket, text: String) {
                delegate.onMessage(webSocket, text)
                handler(webSocket, TinyJson.parseObject(text))
            }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) =
                delegate.onClosing(webSocket, code, reason)
        }
    }

    private fun sessionJson(name: String): String =
        "{\"name\":\"$name\",\"rawName\":\"${name.substringAfter(':')}\",\"scopeId\":\"local\",\"scopeLabel\":\"local\",\"kind\":\"terminal\",\"project\":\"demo\",\"cwd\":\"/tmp\",\"windows\":1}"

    private suspend fun waitUntil(predicate: () -> Boolean) {
        withTimeout(5_000) {
            while (!predicate()) delay(10)
        }
    }
}
