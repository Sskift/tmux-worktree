package com.tmuxworktree.mobile.core.relay.v2

import java.io.Closeable
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate

internal class RelayV2TlsMockServer : Closeable {
    private val certificate = HeldCertificate.Builder()
        .commonName("localhost")
        .addSubjectAlternativeName("localhost")
        .addSubjectAlternativeName("127.0.0.1")
        .build()
    private val serverCertificates = HandshakeCertificates.Builder()
        .heldCertificate(certificate)
        .build()
    private val clientCertificates = HandshakeCertificates.Builder()
        .addTrustedCertificate(certificate.certificate)
        .build()

    val server = MockWebServer().apply {
        useHttps(serverCertificates.sslSocketFactory(), false)
        start()
    }

    val client: OkHttpClient = OkHttpClient.Builder()
        .sslSocketFactory(
            clientCertificates.sslSocketFactory(),
            clientCertificates.trustManager,
        )
        .retryOnConnectionFailure(false)
        .build()

    val issuerUrl: String
        get() = server.url("/").toString().removeSuffix("/")

    val relayUrl: String
        get() = server.url("/client").toString().replaceFirst("https://", "wss://")

    override fun close() {
        server.shutdown()
        client.dispatcher.executorService.shutdownNow()
        client.connectionPool.evictAll()
    }
}
