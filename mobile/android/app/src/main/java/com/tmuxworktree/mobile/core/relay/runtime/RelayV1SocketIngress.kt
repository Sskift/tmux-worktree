package com.tmuxworktree.mobile.core.relay.runtime

import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/**
 * Serializes callbacks produced by one OkHttp WebSocket before they enter the connection actor.
 * Every callback stays non-blocking; socket acknowledgement and overload handling run outside the
 * ingress lock.
 */
internal class RelayV1SocketIngress(
    private val acceptOpen: (WebSocket) -> Boolean,
    private val acceptMessage: (String) -> Boolean,
    private val acceptClose: (Int, String) -> Boolean,
    private val acceptFailure: (Throwable, Response?) -> Boolean,
    private val reject: (WebSocket) -> Unit,
) : WebSocketListener() {
    private val callbackIngressLock = Any()

    override fun onOpen(webSocket: WebSocket, response: Response) {
        val accepted = synchronized(callbackIngressLock) {
            acceptOpen(webSocket)
        }
        if (!accepted) reject(webSocket)
    }

    override fun onMessage(webSocket: WebSocket, text: String) {
        val accepted = synchronized(callbackIngressLock) {
            acceptMessage(text)
        }
        if (!accepted) reject(webSocket)
    }

    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
        val accepted = synchronized(callbackIngressLock) {
            acceptClose(code, reason)
        }
        // OkHttp requires the client to acknowledge the peer close. Do not wait for onClosed
        // before moving the actor into backoff: a peer that never completes the close handshake
        // must not leave the UI stuck ONLINE.
        val acknowledged = runCatching { webSocket.close(code, reason) }.getOrDefault(false)
        if (!acknowledged) webSocket.cancel()
        if (!accepted) reject(webSocket)
    }

    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
        val accepted = synchronized(callbackIngressLock) {
            acceptClose(code, reason)
        }
        if (!accepted) reject(webSocket)
    }

    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
        val accepted = synchronized(callbackIngressLock) {
            acceptFailure(t, response)
        }
        if (!accepted) reject(webSocket)
    }
}
