package com.tmuxworktree.mobile.core.relay

import com.tmuxworktree.mobile.core.model.ConnectionHealth
import com.tmuxworktree.mobile.core.model.ConnectionStatus
import com.tmuxworktree.mobile.core.model.RelaySession
import com.tmuxworktree.mobile.core.model.TerminalStreamState
import com.tmuxworktree.mobile.core.model.TransportPhase
import java.io.Closeable
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExecutorCoroutineDispatcher
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/**
 * Serial connection actor for the legacy relay protocol.
 *
 * All mutable protocol state is owned by [actions]. OkHttp callbacks only enqueue actions, and the
 * captured epoch prevents callbacks from a replaced socket from mutating the active connection.
 */
class RelayV1ConnectionActor(
    parentScope: CoroutineScope,
    private val okHttpClient: OkHttpClient = defaultClient(),
    private val codec: RelayV1Codec = RelayV1Codec(),
    reconnectPolicy: RelayReconnectPolicy = RelayReconnectPolicy(),
    private val clock: () -> Long = System::currentTimeMillis,
    private val streamIdFactory: () -> String = { UUID.randomUUID().toString() },
    private val handshakeTimeoutMillis: Long = DEFAULT_HANDSHAKE_TIMEOUT_MILLIS,
    private val terminalOpenTimeoutMillis: Long = DEFAULT_TERMINAL_OPEN_TIMEOUT_MILLIS,
    private val requestTimeoutPolicy: RelayRequestTimeoutPolicy = RelayRequestTimeoutPolicy(),
) : Closeable {
    private val actorDispatcher: ExecutorCoroutineDispatcher = Executors
        .newSingleThreadExecutor { runnable ->
            Thread(runnable, "tw-relay-v1-actor").apply { isDaemon = true }
        }
        .asCoroutineDispatcher()
    private val scope = CoroutineScope(
        parentScope.coroutineContext +
            actorDispatcher +
            SupervisorJob(parentScope.coroutineContext[Job]),
    )
    private val actions = Channel<Action>(Channel.UNLIMITED)
    private val eventChannel = Channel<RelayClientEvent>(Channel.UNLIMITED)
    private val reducer = RelayConnectionReducer(reconnectPolicy)
    private val requests = RelayRequestRegistry()
    private val streams = RelayStreamRegistry()
    private val requestSequence = AtomicLong()
    private val isClosed = AtomicBoolean(false)
    private val resourcesClosed = AtomicBoolean(false)

    private val _health = MutableStateFlow(RelayTransportState().toConnectionHealth())
    val health: StateFlow<ConnectionHealth> = _health.asStateFlow()

    private val _snapshots = MutableStateFlow(RelaySnapshotState())
    val snapshots: StateFlow<RelaySnapshotState> = _snapshots.asStateFlow()

    private val _terminal = MutableStateFlow(TerminalStreamState())
    val terminal: StateFlow<TerminalStreamState> = _terminal.asStateFlow()

    /**
     * Lossless, single-consumer event stream. Events remain queued while the UI collector is
     * briefly absent or slow instead of being silently discarded by a best-effort emission.
     */
    val events: Flow<RelayClientEvent> = eventChannel.receiveAsFlow()

    private var transport = RelayTransportState()
    private var config: RelayV1ConnectionConfig? = null
    @Volatile
    private var socket: WebSocket? = null
    private var socketEpoch: Long = 0
    private var retryJob: Job? = null
    private var handshakeTimeoutJob: Job? = null
    private var terminalOpenTimeoutJob: Job? = null
    private val requestTimeoutJobs = mutableMapOf<String, Job>()
    private var selectedHostId: String = ""
    private var desiredTerminal: DesiredTerminal? = null
    private var pendingReopenGeneration: Long? = null
    private val terminalOutputBuffer = StringBuilder()
    private var terminalOutputStreamId: String? = null
    private var terminalOutputFlushJob: Job? = null

    init {
        scope.launch {
            for (action in actions) handle(action)
        }
        scope.coroutineContext[Job]?.invokeOnCompletion {
            isClosed.set(true)
            finishResources()
        }
    }

    fun connect(config: RelayV1ConnectionConfig) {
        if (!isClosed.get()) enqueueAction(Action.Connect(config))
    }

    fun disconnect(barrierId: String? = null) {
        if (!isClosed.get()) enqueueAction(Action.Disconnect(barrierId = barrierId))
    }

    suspend fun disconnectAndAwait(barrierId: String? = null) {
        if (isClosed.get()) return
        val completion = CompletableDeferred<Unit>()
        val cancellationHandle = scope.coroutineContext[Job]?.invokeOnCompletion {
            completion.complete(Unit)
        }
        try {
            enqueueAction(Action.Disconnect(completion = completion, barrierId = barrierId))
            completion.await()
        } finally {
            cancellationHandle?.dispose()
        }
    }

    /** Pauses reconnects without forgetting the terminal the user was viewing. */
    fun pauseForNetwork() {
        if (!isClosed.get()) enqueueAction(Action.PauseForNetwork)
    }

    fun refreshHosts(): String {
        val requestId = nextRequestId("hosts")
        enqueue(
            RelayV1Command.ListHosts(requestId),
            request(RelayRequestKind.HOSTS, requestId, latestKey = "hosts"),
        )
        return requestId
    }

    fun refreshSessions(hostId: String): String {
        val requestId = nextRequestId("sessions-$hostId")
        enqueue(
            RelayV1Command.ListSessions(hostId, requestId),
            request(
                RelayRequestKind.SESSIONS,
                requestId,
                hostId = hostId,
                latestKey = "sessions:$hostId",
            ),
        )
        return requestId
    }

    fun refreshScopes(hostId: String): String {
        val requestId = nextRequestId("scopes-$hostId")
        enqueue(
            RelayV1Command.ListScopeStatuses(hostId, requestId),
            request(
                RelayRequestKind.SCOPES,
                requestId,
                hostId = hostId,
                latestKey = "scopes:$hostId",
            ),
        )
        return requestId
    }

    fun createWorktree(
        hostId: String,
        scopeId: String,
        project: String? = null,
        path: String? = null,
        name: String? = null,
        branch: String? = null,
        aiCommand: String,
    ): String {
        val requestId = nextRequestId("create-wt")
        enqueue(
            RelayV1Command.CreateWorktree(
                hostId = hostId,
                requestId = requestId,
                scopeId = scopeId.ifBlank { "local" },
                project = project?.takeIf(String::isNotBlank),
                path = path?.takeIf(String::isNotBlank),
                name = name?.takeIf(String::isNotBlank),
                branch = branch?.takeIf(String::isNotBlank),
                aiCommand = aiCommand,
            ),
            request(RelayRequestKind.CREATE_WORKTREE, requestId, hostId),
        )
        return requestId
    }

    fun createTerminal(
        hostId: String,
        scopeId: String,
        cwd: String,
        label: String? = null,
    ): String {
        val requestId = nextRequestId("create-term")
        enqueue(
            RelayV1Command.CreateTerminal(
                hostId = hostId,
                requestId = requestId,
                scopeId = scopeId.ifBlank { "local" },
                cwd = cwd,
                label = label?.takeIf(String::isNotBlank),
            ),
            request(RelayRequestKind.CREATE_TERMINAL, requestId, hostId),
        )
        return requestId
    }

    fun sendAgentMessage(
        hostId: String,
        sessionName: String,
        message: String,
        pane: RelayV1Pane? = null,
        submit: Boolean = true,
    ): String {
        val requestId = nextRequestId("agent")
        enqueue(
            RelayV1Command.SendAgentMessage(
                hostId = hostId,
                requestId = requestId,
                session = sessionName,
                pane = pane,
                message = message,
                submit = submit,
            ),
            request(RelayRequestKind.SEND_AGENT_MESSAGE, requestId, hostId, sessionName),
        )
        return requestId
    }

    fun killSession(hostId: String, sessionName: String): String {
        val requestId = nextRequestId("kill-$hostId")
        enqueue(
            RelayV1Command.KillSession(hostId, requestId, sessionName),
            request(RelayRequestKind.KILL_SESSION, requestId, hostId, sessionName),
        )
        return requestId
    }

    fun openTerminal(
        hostId: String,
        sessionName: String,
        pane: RelayV1Pane? = null,
        resetDisplay: Boolean = true,
    ): String {
        val streamId = streamIdFactory()
        if (!isClosed.get()) {
            enqueueAction(Action.OpenTerminal(streamId, hostId, sessionName, pane, resetDisplay))
        }
        return streamId
    }

    fun sendTerminalInput(data: String) {
        if (!isClosed.get()) enqueueAction(Action.TerminalInput(data))
    }

    fun resizeTerminal(cols: Int, rows: Int) {
        if (!isClosed.get()) enqueueAction(Action.ResizeTerminal(cols, rows))
    }

    fun closeTerminal() {
        if (!isClosed.get()) enqueueAction(Action.CloseTerminal)
    }

    override fun close() {
        if (!isClosed.compareAndSet(false, true)) return
        if (actions.trySend(Action.Shutdown).isFailure) {
            finishResources()
        }
    }

    private fun enqueue(command: RelayV1Command, context: RelayRequestContext? = null) {
        if (!isClosed.get()) enqueueAction(Action.Send(command, context))
    }

    private fun enqueueAction(action: Action) {
        actions.trySend(action).getOrThrow()
    }

    private fun request(
        kind: RelayRequestKind,
        requestId: String,
        hostId: String = "",
        sessionName: String = "",
        latestKey: String? = null,
    ): RelayRequestContext = RelayRequestContext(
        requestId = requestId,
        kind = kind,
        // Public command methods may run on the main thread. The actor replaces this placeholder
        // with its serially owned transport epoch immediately before writing to the socket.
        epoch = 0,
        hostId = hostId,
        sessionName = sessionName,
        latestKey = latestKey,
    )

    private fun nextRequestId(prefix: String): String =
        "$prefix-${clock()}-${requestSequence.incrementAndGet()}"

    private suspend fun handle(action: Action) {
        when (action) {
            is Action.Connect -> {
                flushTerminalOutput()
                val sameConfig = config == action.config
                cancelHandshakeTimeout()
                cancelTerminalOpenTimeout()
                rejectPendingRequests(
                    "Connection changed before acknowledgement; delivery is ambiguous",
                )
                val active = streams.clear()
                pendingReopenGeneration = null
                if (sameConfig && (desiredTerminal != null || active != null)) {
                    val desired = desiredTerminal
                    _terminal.value = TerminalStreamState(
                        streamId = null,
                        sessionId = desired?.let { "${it.hostId}:${it.sessionName}" }.orEmpty(),
                        status = ConnectionStatus.RECOVERING,
                        generation = active?.generation ?: _terminal.value.generation,
                        resetReason = "connection restarting",
                    )
                } else {
                    desiredTerminal = null
                    _terminal.value = streams.state(ConnectionStatus.OFFLINE)
                }
                config = action.config
                selectedHostId = action.config.preferredHostId
                _snapshots.value = RelaySnapshotState()
                retryJob?.cancel()
                transition(RelayTransportSignal.Start(clock()))
            }
            Action.PauseForNetwork -> {
                flushTerminalOutput()
                cancelHandshakeTimeout()
                cancelTerminalOpenTimeout()
                rejectPendingRequests(
                    "Network became unavailable before acknowledgement; delivery is ambiguous",
                )
                val active = streams.clear()
                pendingReopenGeneration = null
                retryJob?.cancel()
                transition(RelayTransportSignal.PauseForNetwork(clock()))
                val desired = desiredTerminal
                _terminal.value = if (desired != null || active != null) {
                    TerminalStreamState(
                        streamId = null,
                        sessionId = desired?.let { "${it.hostId}:${it.sessionName}" }.orEmpty(),
                        status = ConnectionStatus.PAUSED,
                        generation = active?.generation ?: _terminal.value.generation,
                        resetReason = "waiting for network",
                    )
                } else {
                    streams.state(ConnectionStatus.OFFLINE)
                }
            }
            is Action.Disconnect -> {
                try {
                    flushTerminalOutput()
                    cancelHandshakeTimeout()
                    cancelTerminalOpenTimeout()
                    rejectPendingRequests(
                        "Connection closed before acknowledgement; delivery is ambiguous",
                    )
                    desiredTerminal = null
                    pendingReopenGeneration = null
                    streams.clear()
                    _snapshots.value = RelaySnapshotState()
                    _terminal.value = streams.state(ConnectionStatus.OFFLINE)
                    retryJob?.cancel()
                    transition(RelayTransportSignal.Stop(clock()))
                    emit(RelayClientEvent.Disconnected(action.barrierId))
                } finally {
                    action.completion?.complete(Unit)
                }
            }
            is Action.Send -> sendNow(action.command, action.context)
            is Action.OpenTerminal -> openTerminalNow(
                streamId = action.streamId,
                hostId = action.hostId,
                sessionName = action.sessionName,
                pane = action.pane,
                resetDisplay = action.resetDisplay,
            )
            is Action.TerminalInput -> terminalInputNow(action.data)
            is Action.ResizeTerminal -> streams.current()?.let {
                sendNow(RelayV1Command.Resize(it.streamId, action.cols, action.rows))
            }
            Action.CloseTerminal -> closeTerminalNow()
            is Action.SocketOpened -> socketOpened(action)
            is Action.SocketMessage -> if (action.epoch == transport.epoch) handleWireMessage(action.raw)
            is Action.SocketClosed -> socketClosed(action)
            is Action.SocketFailure -> socketFailed(action)
            is Action.Retry -> transition(RelayTransportSignal.RetryElapsed(action.epoch, clock()))
            is Action.HandshakeTimeout -> handshakeTimedOut(action)
            is Action.TerminalOpenTimeout -> terminalOpenTimedOut(action)
            is Action.RequestTimeout -> requestTimedOut(action)
            is Action.FlushTerminalOutput -> flushTerminalOutput(action.streamId)
            Action.Shutdown -> shutdownFromActor()
            is Action.ReopenTerminal -> reopenTerminalNow(action)
            is Action.DelayedRefresh -> if (action.epoch == transport.epoch) {
                sendSessionsRequest(action.hostId)
                sendScopesRequest(action.hostId)
            }
        }
    }

    private fun transition(signal: RelayTransportSignal): RelayTransportReduction {
        val reduction = reducer.reduce(transport, signal)
        transport = reduction.state
        _health.value = transport.toConnectionHealth()
        if (reduction.accepted) applyEffects(reduction.effects)
        return reduction
    }

    private fun applyEffects(effects: List<RelayTransportEffect>) {
        effects.forEach { effect ->
            when (effect) {
                is RelayTransportEffect.CloseSocket -> {
                    socket?.close(effect.code, effect.reason)
                    socket = null
                }
                is RelayTransportEffect.OpenSocket -> openSocket(effect.epoch)
                is RelayTransportEffect.ScheduleRetry -> {
                    retryJob?.cancel()
                    retryJob = scope.launch {
                        delay(effect.delayMillis)
                        actions.send(Action.Retry(effect.epoch))
                    }
                }
            }
        }
    }

    private fun openSocket(epoch: Long) {
        val activeConfig = config ?: return
        val relay = activeConfig.relayUrl.trim().trimEnd('/')
        if (relay.isBlank() || activeConfig.bearerToken.isBlank()) {
            transition(RelayTransportSignal.InvalidConfiguration(clock(), "Relay URL and token are required"))
            return
        }
        val request = try {
            Request.Builder()
                .url("$relay/client")
                .header("Authorization", "Bearer ${activeConfig.bearerToken}")
                .build()
        } catch (error: IllegalArgumentException) {
            transition(RelayTransportSignal.InvalidConfiguration(clock(), error.message ?: "Invalid relay URL"))
            return
        }

        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                actions.trySend(Action.SocketOpened(epoch, webSocket))
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                actions.trySend(Action.SocketMessage(epoch, text))
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                // OkHttp requires the client to acknowledge the peer close. Do not wait for
                // onClosed before moving the actor into backoff: a peer that never completes the
                // close handshake must not leave the UI stuck ONLINE.
                val acknowledged = runCatching { webSocket.close(code, reason) }.getOrDefault(false)
                if (!acknowledged) webSocket.cancel()
                actions.trySend(Action.SocketClosed(epoch, code, reason))
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                actions.trySend(Action.SocketClosed(epoch, code, reason))
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                actions.trySend(
                    Action.SocketFailure(
                        epoch = epoch,
                        httpCode = response?.code,
                        message = t.message ?: t::class.java.simpleName,
                    ),
                )
            }
        }
        socketEpoch = epoch
        socket = okHttpClient.newWebSocket(request, listener)
        scheduleHandshakeTimeout(epoch)
    }

    private fun socketOpened(action: Action.SocketOpened) {
        val reduction = transition(RelayTransportSignal.SocketOpened(action.epoch, clock()))
        if (!reduction.accepted) {
            action.socket.close(1000, "stale socket")
            return
        }
        socket = action.socket
        socketEpoch = action.epoch
        sendHostsRequest()
    }

    private fun socketClosed(action: Action.SocketClosed) {
        val reduction = transition(
            RelayTransportSignal.SocketClosed(action.epoch, clock(), action.code, action.reason),
        )
        if (!reduction.accepted) return
        cancelHandshakeTimeout()
        if (socketEpoch == action.epoch) socket = null
        prepareTerminalForConnectionRecovery(action.reason.ifBlank { "Connection closed" })
        rejectPendingRequests(
            "Connection closed before acknowledgement; delivery is ambiguous",
        )
    }

    private fun socketFailed(action: Action.SocketFailure) {
        val reduction = transition(
            RelayTransportSignal.SocketFailed(
                epoch = action.epoch,
                nowMillis = clock(),
                httpCode = action.httpCode,
                message = action.message,
            ),
        )
        if (!reduction.accepted) return
        cancelHandshakeTimeout()
        if (socketEpoch == action.epoch) socket = null
        rejectPendingRequests(
            "Connection failed before acknowledgement; delivery is ambiguous",
        )
        if (transport.phase == TransportPhase.AUTH_REQUIRED) {
            flushTerminalOutput()
            cancelTerminalOpenTimeout()
            desiredTerminal = null
            streams.clear()
            _terminal.value = streams.state(ConnectionStatus.AUTH_REQUIRED)
            emit(RelayClientEvent.AuthRequired(action.message.ifBlank { "Authentication required" }))
        } else {
            prepareTerminalForConnectionRecovery(action.message)
        }
    }

    private fun prepareTerminalForConnectionRecovery(reason: String) {
        flushTerminalOutput()
        cancelTerminalOpenTimeout()
        val active = streams.clear()
        pendingReopenGeneration = null
        if (desiredTerminal != null || active != null) {
            val desired = desiredTerminal
            _terminal.value = TerminalStreamState(
                streamId = null,
                sessionId = desired?.let { "${it.hostId}:${it.sessionName}" }.orEmpty(),
                status = ConnectionStatus.RECOVERING,
                generation = active?.generation ?: _terminal.value.generation,
                resetReason = reason,
            )
        }
    }

    private fun sendNow(command: RelayV1Command, context: RelayRequestContext? = null): Boolean {
        val normalizedContext = context?.copy(epoch = transport.epoch)
        val activeSocket = socket
        if (activeSocket == null) {
            emit(
                RelayClientEvent.CommandRejected(
                    type = command.type,
                    reason = "Relay is not connected; command was not written to the socket",
                    request = normalizedContext,
                ),
            )
            return false
        }
        normalizedContext?.let(requests::register)
        val sent = try {
            activeSocket.send(codec.encode(command))
        } catch (error: Throwable) {
            false
        }
        if (!sent) {
            requests.remove(normalizedContext?.requestId)
            emit(
                RelayClientEvent.CommandRejected(
                    type = command.type,
                    reason = "WebSocket rejected the message before it was written",
                    request = normalizedContext,
                ),
            )
        } else if (normalizedContext != null) {
            scheduleRequestTimeout(normalizedContext)
        }
        return sent
    }

    private fun sendHostsRequest() {
        val requestId = nextRequestId("hosts")
        sendNow(
            RelayV1Command.ListHosts(requestId),
            request(RelayRequestKind.HOSTS, requestId, latestKey = "hosts"),
        )
    }

    private fun sendSessionsRequest(hostId: String) {
        val requestId = nextRequestId("sessions-$hostId")
        sendNow(
            RelayV1Command.ListSessions(hostId, requestId),
            request(RelayRequestKind.SESSIONS, requestId, hostId, latestKey = "sessions:$hostId"),
        )
    }

    private fun sendScopesRequest(hostId: String) {
        val requestId = nextRequestId("scopes-$hostId")
        sendNow(
            RelayV1Command.ListScopeStatuses(hostId, requestId),
            request(RelayRequestKind.SCOPES, requestId, hostId, latestKey = "scopes:$hostId"),
        )
    }

    private fun handleWireMessage(raw: String) {
        when (val decoded = codec.decode(raw)) {
            is RelayV1DecodeResult.Malformed -> emit(RelayClientEvent.ProtocolWarning(decoded.reason, decoded.raw))
            is RelayV1DecodeResult.Unknown -> emit(
                RelayClientEvent.ProtocolWarning("Unknown relay message: ${decoded.type}", decoded.raw),
            )
            is RelayV1DecodeResult.Message -> handleEvent(decoded.event)
        }
    }

    private fun handleEvent(event: RelayV1Event) {
        when (event) {
            is RelayV1Event.Ready -> {
                val reduction = transition(RelayTransportSignal.Ready(transport.epoch, clock()))
                if (reduction.accepted) {
                    cancelHandshakeTimeout()
                    emit(RelayClientEvent.Ready(event.clientId, event.hostId))
                }
            }
            is RelayV1Event.Hosts -> handleHosts(event)
            is RelayV1Event.Sessions -> handleSessions(event)
            is RelayV1Event.ScopeStatuses -> handleScopes(event)
            is RelayV1Event.WorktreeCreated -> handleCreated(event.requestId, event.session, worktree = true)
            is RelayV1Event.TerminalCreated -> handleCreated(event.requestId, event.session, worktree = false)
            is RelayV1Event.AgentMessageSent -> handleAgentMessageSent(event)
            is RelayV1Event.SessionKilled -> handleSessionKilled(event)
            is RelayV1Event.TerminalData -> handleTerminalData(event)
            is RelayV1Event.TerminalExit -> handleTerminalExit(event)
            is RelayV1Event.Error -> handleError(event)
        }
    }

    private fun handleHosts(event: RelayV1Event.Hosts) {
        val resolution = resolveCorrelatedRequest(
            requestId = event.requestId,
            expectedKind = RelayRequestKind.HOSTS,
            fallbackLatestKey = "hosts",
            label = "hosts",
        ) ?: return
        if (!resolution.isLatest) {
            emit(RelayClientEvent.ProtocolWarning("Ignored stale hosts response: ${event.requestId}"))
            return
        }
        mutateSnapshots(
            RelaySnapshotMutation.ReplaceHosts(
                hosts = event.hosts,
                preferredHostId = config?.preferredHostId.orEmpty(),
                nowMillis = clock(),
            ),
        )
        selectedHostId = _snapshots.value.selectedHostId
        emit(RelayClientEvent.SnapshotUpdated(RelayRequestKind.HOSTS))
        if (selectedHostId.isNotBlank()) {
            sendSessionsRequest(selectedHostId)
            sendScopesRequest(selectedHostId)
        }
    }

    private fun handleSessions(event: RelayV1Event.Sessions) {
        val resolution = resolveCorrelatedRequest(
            requestId = event.requestId,
            expectedKind = RelayRequestKind.SESSIONS,
            fallbackLatestKey = selectedHostId.takeIf(String::isNotBlank)?.let { "sessions:$it" },
            label = "sessions",
        ) ?: return
        if (!resolution.isLatest) {
            emit(RelayClientEvent.ProtocolWarning("Ignored stale sessions response: ${event.requestId}"))
            return
        }
        val hostId = resolution.context.hostId
        mutateSnapshots(RelaySnapshotMutation.ReplaceSessions(hostId, event.sessions, clock()))
        emit(RelayClientEvent.SnapshotUpdated(RelayRequestKind.SESSIONS, hostId))

        val desired = desiredTerminal
        if (desired != null && desired.hostId == hostId && streams.current() == null) {
            val found = event.sessions.any { it.name == desired.sessionName }
            if (found) {
                openTerminalNow(
                    streamId = streamIdFactory(),
                    hostId = desired.hostId,
                    sessionName = desired.sessionName,
                    pane = desired.pane,
                    resetDisplay = false,
                )
            }
        }
    }

    private fun handleScopes(event: RelayV1Event.ScopeStatuses) {
        val resolution = resolveCorrelatedRequest(
            requestId = event.requestId,
            expectedKind = RelayRequestKind.SCOPES,
            fallbackLatestKey = selectedHostId.takeIf(String::isNotBlank)?.let { "scopes:$it" },
            label = "scope",
        ) ?: return
        if (!resolution.isLatest) {
            emit(RelayClientEvent.ProtocolWarning("Ignored stale scope response: ${event.requestId}"))
            return
        }
        val hostId = resolution.context.hostId.ifBlank { selectedHostId }
        if (hostId.isBlank()) return
        mutateSnapshots(RelaySnapshotMutation.ReplaceScopes(hostId, event.scopes, clock()))
        emit(RelayClientEvent.SnapshotUpdated(RelayRequestKind.SCOPES, hostId))
    }

    private fun handleCreated(requestId: String?, wire: RelayV1Session, worktree: Boolean) {
        val expectedKind = if (worktree) {
            RelayRequestKind.CREATE_WORKTREE
        } else {
            RelayRequestKind.CREATE_TERMINAL
        }
        val resolution = resolveCorrelatedRequest(
            requestId = requestId,
            expectedKind = expectedKind,
            label = if (worktree) "worktree created" else "terminal created",
        ) ?: return
        val hostId = resolution.context.hostId.ifBlank { selectedHostId }
        if (hostId.isBlank()) {
            emit(RelayClientEvent.ProtocolWarning("Created session has no host context"))
            return
        }
        mutateSnapshots(RelaySnapshotMutation.AddSession(hostId, wire, clock()))
        val session = _snapshots.value.sessionsById["$hostId:${wire.name}"] ?: return
        if (worktree) {
            emit(RelayClientEvent.WorktreeCreated(requestId, session))
        } else {
            emit(RelayClientEvent.TerminalCreated(requestId, session))
        }
        scheduleRefresh(hostId, 700)
    }

    private fun handleAgentMessageSent(event: RelayV1Event.AgentMessageSent) {
        val resolution = resolveCorrelatedRequest(
            requestId = event.requestId,
            expectedKind = RelayRequestKind.SEND_AGENT_MESSAGE,
            label = "agent message acknowledgement",
        ) ?: return
        emit(
            RelayClientEvent.AgentMessageSent(
                requestId = event.requestId,
                hostId = resolution.context.hostId,
                sessionName = event.session.ifBlank { resolution.context.sessionName },
                pane = event.pane,
            ),
        )
    }

    private fun handleSessionKilled(event: RelayV1Event.SessionKilled) {
        val resolution = resolveCorrelatedRequest(
            requestId = event.requestId,
            expectedKind = RelayRequestKind.KILL_SESSION,
            label = "session killed",
        ) ?: return
        val hostId = resolution.context.hostId.ifBlank { selectedHostId }
        val sessionName = event.session.ifBlank { resolution.context.sessionName }
        if (hostId.isNotBlank() && sessionName.isNotBlank()) {
            mutateSnapshots(RelaySnapshotMutation.RemoveSession(hostId, sessionName, clock()))
            val desired = desiredTerminal
            if (desired?.hostId == hostId && desired.sessionName == sessionName) {
                flushTerminalOutput()
                cancelTerminalOpenTimeout()
                desiredTerminal = null
                streams.clear()
                _terminal.value = streams.state(ConnectionStatus.OFFLINE)
            }
            scheduleRefresh(hostId, 500)
        }
        emit(RelayClientEvent.SessionKilled(event.requestId, hostId, sessionName))
    }

    private fun handleTerminalData(event: RelayV1Event.TerminalData) {
        if (!streams.accepts(event.streamId)) return
        val active = streams.current() ?: return
        cancelTerminalOpenTimeout()
        streams.markOpen(active.streamId)
        _terminal.value = streams.state(ConnectionStatus.ONLINE)
        if (event.data.isNotEmpty()) queueTerminalOutput(active.streamId, event.data)
    }

    private fun handleTerminalExit(event: RelayV1Event.TerminalExit) {
        if (!streams.accepts(event.streamId)) return
        cancelTerminalOpenTimeout()
        val active = streams.close(event.streamId) ?: return
        flushTerminalOutput(active.streamId)
        _terminal.value = TerminalStreamState(
            streamId = null,
            sessionId = "${active.hostId}:${active.sessionName}",
            status = ConnectionStatus.OFFLINE,
            generation = active.generation,
            resetReason = "stream closed",
        )
        emit(RelayClientEvent.TerminalExit(active.streamId, event.code))
    }

    private fun handleError(event: RelayV1Event.Error) {
        val resolution = when {
            !event.requestId.isNullOrEmpty() -> resolveRequest(event.requestId)
                ?: run {
                    emit(RelayClientEvent.ProtocolWarning("Ignored error with unknown requestId: ${event.requestId}"))
                    return
                }
            !event.streamId.isNullOrEmpty() -> null
            else -> resolveRequest(requestId = null, allowLatestForBlank = true)
        }
        if (resolution != null && !resolution.isLatest) {
            emit(RelayClientEvent.ProtocolWarning("Ignored stale error response: ${event.requestId}"))
            return
        }
        if (!event.streamId.isNullOrEmpty() && !streams.accepts(event.streamId)) return
        val normalized = event.message.lowercase()
        val recoverable = normalized.contains("terminal stream is not open") ||
            normalized.contains("terminal stream closed") ||
            normalized.contains("host reconnected")
        val active = streams.current()
        if (recoverable && active != null && streams.accepts(event.streamId)) {
            flushTerminalOutput(active.streamId)
            cancelTerminalOpenTimeout()
            pendingReopenGeneration = active.generation
            streams.close(active.streamId)
            _terminal.value = TerminalStreamState(
                streamId = null,
                sessionId = "${active.hostId}:${active.sessionName}",
                status = ConnectionStatus.RECOVERING,
                generation = active.generation,
                resetReason = event.message,
            )
            emit(RelayClientEvent.TerminalReconnecting(active.hostId, active.sessionName, event.message))
            scope.launch {
                delay(180)
                actions.send(Action.ReopenTerminal(transport.epoch, active.generation))
            }
            return
        }
        emit(RelayClientEvent.Error(event.message, resolution?.context, event.streamId))
    }

    private fun openTerminalNow(
        streamId: String,
        hostId: String,
        sessionName: String,
        pane: RelayV1Pane?,
        resetDisplay: Boolean,
    ) {
        flushTerminalOutput()
        cancelTerminalOpenTimeout()
        val old = streams.current()
        if (old != null && old.streamId != streamId) {
            sendNow(RelayV1Command.CloseTerminal(old.streamId))
        }
        desiredTerminal = DesiredTerminal(hostId, sessionName, pane)
        pendingReopenGeneration = null
        val stream = streams.open(streamId, hostId, sessionName, pane)
        _terminal.value = streams.state(ConnectionStatus.RECOVERING).copy(
            resetReason = if (resetDisplay) "opening" else "reopening",
        )
        emit(RelayClientEvent.TerminalOpening(streamId, hostId, sessionName, resetDisplay))
        val sent = sendNow(RelayV1Command.OpenTerminal(hostId, streamId, sessionName, pane))
        if (!sent) {
            streams.close(stream.streamId)
            _terminal.value = TerminalStreamState(
                streamId = null,
                sessionId = "$hostId:$sessionName",
                status = ConnectionStatus.RECOVERING,
                generation = stream.generation,
                resetReason = "relay offline",
            )
        } else {
            scheduleTerminalOpenTimeout(transport.epoch, stream)
        }
    }

    private fun reopenTerminalNow(action: Action.ReopenTerminal) {
        if (action.epoch != transport.epoch || pendingReopenGeneration != action.generation) return
        val desired = desiredTerminal ?: return
        openTerminalNow(
            streamIdFactory(),
            desired.hostId,
            desired.sessionName,
            desired.pane,
            resetDisplay = false,
        )
    }

    private fun terminalInputNow(data: String) {
        var active = streams.current()
        if (active == null) {
            val desired = desiredTerminal ?: return
            openTerminalNow(
                streamId = streamIdFactory(),
                hostId = desired.hostId,
                sessionName = desired.sessionName,
                pane = desired.pane,
                resetDisplay = false,
            )
            active = streams.current()
        }
        active?.let { sendNow(RelayV1Command.TerminalInput(it.streamId, data)) }
    }

    private fun closeTerminalNow() {
        flushTerminalOutput()
        cancelTerminalOpenTimeout()
        streams.current()?.let { sendNow(RelayV1Command.CloseTerminal(it.streamId)) }
        streams.clear()
        desiredTerminal = null
        pendingReopenGeneration = null
        _terminal.value = streams.state(ConnectionStatus.OFFLINE)
    }

    private fun scheduleRefresh(hostId: String, delayMillis: Long) {
        val epoch = transport.epoch
        scope.launch {
            delay(delayMillis)
            actions.send(Action.DelayedRefresh(epoch, hostId))
        }
    }

    private fun mutateSnapshots(mutation: RelaySnapshotMutation) {
        _snapshots.value = RelaySnapshotReducer.reduce(_snapshots.value, mutation)
    }

    private fun scheduleHandshakeTimeout(epoch: Long) {
        cancelHandshakeTimeout()
        handshakeTimeoutJob = scope.launch {
            delay(handshakeTimeoutMillis.coerceAtLeast(1))
            actions.send(Action.HandshakeTimeout(epoch))
        }
    }

    private fun cancelHandshakeTimeout() {
        handshakeTimeoutJob?.cancel()
        handshakeTimeoutJob = null
    }

    private fun scheduleTerminalOpenTimeout(epoch: Long, stream: RelayStreamContext) {
        cancelTerminalOpenTimeout()
        terminalOpenTimeoutJob = scope.launch {
            delay(terminalOpenTimeoutMillis.coerceAtLeast(1))
            actions.send(Action.TerminalOpenTimeout(epoch, stream.streamId, stream.generation))
        }
    }

    private fun cancelTerminalOpenTimeout() {
        terminalOpenTimeoutJob?.cancel()
        terminalOpenTimeoutJob = null
    }

    private fun terminalOpenTimedOut(action: Action.TerminalOpenTimeout) {
        if (action.epoch != transport.epoch) return
        val active = streams.current() ?: return
        if (
            active.streamId != action.streamId ||
            active.generation != action.generation ||
            active.phase != RelayStreamPhase.OPENING
        ) {
            return
        }
        cancelTerminalOpenTimeout()
        sendNow(RelayV1Command.CloseTerminal(active.streamId))
        streams.close(active.streamId)
        pendingReopenGeneration = null
        val message = "Terminal did not open within ${terminalOpenTimeoutMillis}ms"
        _terminal.value = TerminalStreamState(
            streamId = null,
            sessionId = "${active.hostId}:${active.sessionName}",
            status = ConnectionStatus.UNKNOWN,
            generation = active.generation,
            resetReason = message,
        )
        emit(RelayClientEvent.Error(message = message, streamId = active.streamId))
    }

    private fun handshakeTimedOut(action: Action.HandshakeTimeout) {
        if (action.epoch != transport.epoch || transport.phase !in setOf(
                TransportPhase.CONNECTING,
                TransportPhase.HANDSHAKING,
            )
        ) {
            return
        }
        cancelHandshakeTimeout()
        socket?.cancel()
        socket = null
        rejectPendingRequests(
            "Handshake timed out before acknowledgement; delivery is ambiguous",
        )
        prepareTerminalForConnectionRecovery("Relay handshake timed out")
        transition(
            RelayTransportSignal.SocketFailed(
                epoch = action.epoch,
                nowMillis = clock(),
                message = "Relay handshake timed out after ${handshakeTimeoutMillis}ms",
            ),
        )
    }

    private fun scheduleRequestTimeout(context: RelayRequestContext) {
        requestTimeoutJobs.remove(context.requestId)?.cancel()
        val timeoutMillis = requestTimeoutPolicy.timeoutMillis(context.kind).coerceAtLeast(1)
        requestTimeoutJobs[context.requestId] = scope.launch {
            delay(timeoutMillis)
            actions.send(Action.RequestTimeout(context.epoch, context.requestId))
        }
    }

    private fun requestTimedOut(action: Action.RequestTimeout) {
        if (action.epoch != transport.epoch) return
        val resolution = resolveRequest(action.requestId) ?: return
        emit(
            RelayClientEvent.CommandRejected(
                type = resolution.context.kind.commandType(),
                reason = "Request timed out before acknowledgement; delivery is ambiguous",
                request = resolution.context,
            ),
        )
    }

    private fun resolveCorrelatedRequest(
        requestId: String?,
        expectedKind: RelayRequestKind,
        fallbackLatestKey: String? = null,
        label: String,
    ): RelayRequestResolution? {
        val resolution = resolveRequest(
            requestId = requestId,
            expectedKind = expectedKind,
            fallbackLatestKey = fallbackLatestKey,
            allowLatestForBlank = true,
        )
        if (resolution == null) {
            val detail = if (requestId.isNullOrEmpty()) {
                "without a matching pending request"
            } else {
                "with unknown requestId: $requestId"
            }
            emit(RelayClientEvent.ProtocolWarning("Ignored $label response $detail"))
        }
        return resolution
    }

    private fun resolveRequest(
        requestId: String?,
        expectedKind: RelayRequestKind? = null,
        fallbackLatestKey: String? = null,
        allowLatestForBlank: Boolean = false,
    ): RelayRequestResolution? {
        val resolution = requests.resolve(
            requestId = requestId,
            expectedKind = expectedKind,
            fallbackLatestKey = fallbackLatestKey,
            allowLatestForBlank = allowLatestForBlank,
        ) ?: return null
        requestTimeoutJobs.remove(resolution.context.requestId)?.cancel()
        return resolution
    }

    private fun rejectPendingRequests(reason: String) {
        requests.drain().forEach { context ->
            requestTimeoutJobs.remove(context.requestId)?.cancel()
            emit(
                RelayClientEvent.CommandRejected(
                    type = context.kind.commandType(),
                    reason = reason,
                    request = context,
                ),
            )
        }
        requestTimeoutJobs.values.forEach(Job::cancel)
        requestTimeoutJobs.clear()
    }

    private fun shutdownFromActor() {
        flushTerminalOutput()
        cancelHandshakeTimeout()
        cancelTerminalOpenTimeout()
        retryJob?.cancel()
        rejectPendingRequests(
            "Connection closed before acknowledgement; delivery is ambiguous",
        )
        socket?.cancel()
        socket = null
        desiredTerminal = null
        pendingReopenGeneration = null
        streams.clear()
        _snapshots.value = RelaySnapshotState()
        _terminal.value = streams.state(ConnectionStatus.OFFLINE)
        transition(RelayTransportSignal.Stop(clock()))
        finishResources()
    }

    private fun finishResources() {
        if (!resourcesClosed.compareAndSet(false, true)) return
        socket?.cancel()
        socket = null
        actions.close()
        eventChannel.close()
        scope.cancel()
        actorDispatcher.close()
    }

    private fun emit(event: RelayClientEvent) {
        eventChannel.trySend(event).getOrThrow()
    }

    private fun queueTerminalOutput(streamId: String, data: String) {
        if (terminalOutputStreamId != null && terminalOutputStreamId != streamId) {
            flushTerminalOutput()
        }
        terminalOutputStreamId = streamId
        terminalOutputBuffer.append(data)
        if (terminalOutputBuffer.length >= MAX_TERMINAL_OUTPUT_BATCH_CHARS) {
            flushTerminalOutput(streamId)
            return
        }
        if (terminalOutputFlushJob == null) {
            terminalOutputFlushJob = scope.launch {
                delay(TERMINAL_OUTPUT_BATCH_MILLIS)
                actions.send(Action.FlushTerminalOutput(streamId))
            }
        }
    }

    private fun flushTerminalOutput(expectedStreamId: String? = null) {
        val streamId = terminalOutputStreamId ?: return
        if (expectedStreamId != null && expectedStreamId != streamId) return
        terminalOutputFlushJob?.cancel()
        terminalOutputFlushJob = null
        if (terminalOutputBuffer.isNotEmpty()) {
            emit(RelayClientEvent.TerminalData(streamId, terminalOutputBuffer.toString()))
        }
        terminalOutputBuffer.clear()
        terminalOutputStreamId = null
    }

    private data class DesiredTerminal(
        val hostId: String,
        val sessionName: String,
        val pane: RelayV1Pane?,
    )

    private sealed interface Action {
        data class Connect(val config: RelayV1ConnectionConfig) : Action
        data object PauseForNetwork : Action
        data class Disconnect(
            val completion: CompletableDeferred<Unit>? = null,
            val barrierId: String? = null,
        ) : Action
        data class Send(val command: RelayV1Command, val context: RelayRequestContext?) : Action
        data class OpenTerminal(
            val streamId: String,
            val hostId: String,
            val sessionName: String,
            val pane: RelayV1Pane?,
            val resetDisplay: Boolean,
        ) : Action
        data class TerminalInput(val data: String) : Action
        data class ResizeTerminal(val cols: Int, val rows: Int) : Action
        data object CloseTerminal : Action
        data class SocketOpened(val epoch: Long, val socket: WebSocket) : Action
        data class SocketMessage(val epoch: Long, val raw: String) : Action
        data class SocketClosed(val epoch: Long, val code: Int, val reason: String) : Action
        data class SocketFailure(val epoch: Long, val httpCode: Int?, val message: String) : Action
        data class Retry(val epoch: Long) : Action
        data class HandshakeTimeout(val epoch: Long) : Action
        data class TerminalOpenTimeout(
            val epoch: Long,
            val streamId: String,
            val generation: Long,
        ) : Action
        data class RequestTimeout(val epoch: Long, val requestId: String) : Action
        data class FlushTerminalOutput(val streamId: String) : Action
        data object Shutdown : Action
        data class ReopenTerminal(val epoch: Long, val generation: Long) : Action
        data class DelayedRefresh(val epoch: Long, val hostId: String) : Action
    }

    companion object {
        const val DEFAULT_HANDSHAKE_TIMEOUT_MILLIS = 10_000L
        const val DEFAULT_TERMINAL_OPEN_TIMEOUT_MILLIS = 10_000L
        private const val TERMINAL_OUTPUT_BATCH_MILLIS = 16L
        private const val MAX_TERMINAL_OUTPUT_BATCH_CHARS = 64 * 1024

        private fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .pingInterval(20, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build()
    }
}

data class RelayRequestTimeoutPolicy(
    val hostsMillis: Long = 10_000,
    val sessionsMillis: Long = 10_000,
    val scopesMillis: Long = 10_000,
    val createWorktreeMillis: Long = 60_000,
    val createTerminalMillis: Long = 30_000,
    val sendAgentMessageMillis: Long = 20_000,
    val killSessionMillis: Long = 15_000,
) {
    fun timeoutMillis(kind: RelayRequestKind): Long = when (kind) {
        RelayRequestKind.HOSTS -> hostsMillis
        RelayRequestKind.SESSIONS -> sessionsMillis
        RelayRequestKind.SCOPES -> scopesMillis
        RelayRequestKind.CREATE_WORKTREE -> createWorktreeMillis
        RelayRequestKind.CREATE_TERMINAL -> createTerminalMillis
        RelayRequestKind.SEND_AGENT_MESSAGE -> sendAgentMessageMillis
        RelayRequestKind.KILL_SESSION -> killSessionMillis
    }
}

private fun RelayRequestKind.commandType(): String = when (this) {
    RelayRequestKind.HOSTS -> "list_hosts"
    RelayRequestKind.SESSIONS -> "list_sessions"
    RelayRequestKind.SCOPES -> "list_scope_statuses"
    RelayRequestKind.CREATE_WORKTREE -> "create_worktree"
    RelayRequestKind.CREATE_TERMINAL -> "create_terminal"
    RelayRequestKind.SEND_AGENT_MESSAGE -> "send_agent_message"
    RelayRequestKind.KILL_SESSION -> "kill_session"
}
