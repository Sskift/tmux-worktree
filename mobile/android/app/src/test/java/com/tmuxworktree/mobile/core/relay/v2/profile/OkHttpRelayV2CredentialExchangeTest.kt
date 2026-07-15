package com.tmuxworktree.mobile.core.relay.v2.profile

import com.tmuxworktree.mobile.core.relay.v2.RelayV2TlsMockServer
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2Codec
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2HttpsSchema
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class OkHttpRelayV2CredentialExchangeTest {
    private val codec = RelayV2Codec()

    @Test
    fun `redeem and refresh use exact HTTPS paths and caller attempt bodies`() = runBlocking {
        RelayV2TlsMockServer().use { tls ->
            val redeemResponse = clientCredentialResponse(
                attemptField = "exchangeAttemptId",
                attemptId = EXCHANGE_ATTEMPT,
                relayUrl = tls.relayUrl,
            )
            tls.server.enqueue(jsonResponse(redeemResponse))
            tls.server.enqueue(jsonResponse(redeemResponse))
            tls.server.enqueue(
                jsonResponse(
                    clientCredentialResponse(
                        attemptField = "refreshAttemptId",
                        attemptId = REFRESH_ATTEMPT,
                        relayUrl = tls.relayUrl,
                        accessToken = ACCESS_TOKEN_2,
                        refreshToken = REFRESH_TOKEN_2,
                    ),
                ),
            )
            val exchange = OkHttpRelayV2CredentialExchange(tls.client)
            val redeemRequest = enrollmentRequest(tls.issuerUrl)

            val first = exchange.redeem(redeemRequest)
            val replay = exchange.redeem(redeemRequest)
            val refreshed = exchange.refresh(refreshRequest(tls.issuerUrl))

            assertEquals(EXCHANGE_ATTEMPT, first.exchangeAttemptId)
            assertEquals(first, replay)
            assertEquals(REFRESH_ATTEMPT, refreshed.refreshAttemptId)
            assertEquals(ACCESS_TOKEN_2, refreshed.accessToken)
            assertEquals(REFRESH_TOKEN_2, refreshed.refreshToken)

            val firstRedeem = tls.recordedRequest()
            val replayRedeem = tls.recordedRequest()
            val refresh = tls.recordedRequest()
            assertRequestSecurity(firstRedeem, "/v2/enrollments/redeem")
            assertRequestSecurity(replayRedeem, "/v2/enrollments/redeem")
            assertRequestSecurity(refresh, "/v2/tokens/refresh")
            assertEquals(firstRedeem.body.snapshot(), replayRedeem.body.snapshot())

            val redeemFrame = codec.decodeHttpsBody(
                RelayV2HttpsSchema.ENROLLMENT_REDEEM_REQUEST,
                firstRedeem.body.readByteArray(),
            ).frame
            assertEquals(
                linkedMapOf(
                    "exchangeAttemptId" to EXCHANGE_ATTEMPT,
                    "enrollmentId" to ENROLLMENT_ID,
                    "enrollmentCode" to ENROLLMENT_CODE,
                    "clientInstanceId" to CLIENT_INSTANCE_ID,
                    "deviceLabel" to "Pixel",
                ),
                redeemFrame,
            )
            assertFalse(redeemFrame.containsKey("issuerUrl"))

            val refreshFrame = codec.decodeHttpsBody(
                RelayV2HttpsSchema.TOKEN_REFRESH_CLIENT_REQUEST,
                refresh.body.readByteArray(),
            ).frame
            assertEquals(
                linkedMapOf(
                    "refreshAttemptId" to REFRESH_ATTEMPT,
                    "grantId" to GRANT_ID,
                    "clientInstanceId" to CLIENT_INSTANCE_ID,
                    "refreshToken" to REFRESH_TOKEN_1,
                ),
                refreshFrame,
            )

            val diagnostics = listOf(redeemRequest.toString(), refreshRequest(tls.issuerUrl).toString())
            diagnostics.forEach { diagnostic ->
                assertFalse(diagnostic.contains(ENROLLMENT_CODE))
                assertFalse(diagnostic.contains(ACCESS_TOKEN_1))
                assertFalse(diagnostic.contains(REFRESH_TOKEN_1))
            }
        }
    }

    @Test
    fun `HTTP auth and server failures expose only closed diagnostics`() = runBlocking {
        RelayV2TlsMockServer().use { tls ->
            val leakedMessage = "$ENROLLMENT_CODE $ACCESS_TOKEN_1 $REFRESH_TOKEN_1"
            tls.server.enqueue(jsonResponse(errorBody("AUTH_INVALID", leakedMessage), status = 401))
            tls.server.enqueue(jsonResponse(errorBody("INTERNAL", leakedMessage), status = 500))
            val exchange = OkHttpRelayV2CredentialExchange(tls.client)

            val auth = captureExchangeFailure { exchange.redeem(enrollmentRequest(tls.issuerUrl)) }
            assertEquals(RelayV2CredentialExchangeFailureKind.AUTH, auth.kind)
            assertEquals(401, auth.httpStatus)
            assertEquals("AUTH_INVALID", auth.errorCode)

            val http = captureExchangeFailure { exchange.refresh(refreshRequest(tls.issuerUrl)) }
            assertEquals(RelayV2CredentialExchangeFailureKind.HTTP, http.kind)
            assertEquals(500, http.httpStatus)
            assertEquals("INTERNAL", http.errorCode)

            listOf(auth, http).forEach(::assertSecretsRedacted)
            assertFalse(auth.toString().contains(leakedMessage))
            assertFalse(http.toString().contains(leakedMessage))
        }
    }

    @Test
    fun `malformed oversized and noncanonical Relay responses fail closed without secret echo`() =
        runBlocking {
            RelayV2TlsMockServer().use { tls ->
                val malformed = "{\"unexpected\":\"$ENROLLMENT_CODE $ACCESS_TOKEN_1 $REFRESH_TOKEN_1\"}"
                tls.server.enqueue(jsonResponse(malformed))
                tls.server.enqueue(
                    jsonResponse("x".repeat(RelayV2Codec.HTTPS_BODY_BYTES + 1)),
                )
                tls.server.enqueue(
                    jsonResponse(
                        clientCredentialResponse(
                            attemptField = "exchangeAttemptId",
                            attemptId = EXCHANGE_ATTEMPT,
                            relayUrl = "${tls.relayUrl}?accessToken=$ACCESS_TOKEN_1",
                        ),
                    ),
                )
                val exchange = OkHttpRelayV2CredentialExchange(tls.client)

                repeat(3) {
                    val failure = captureExchangeFailure {
                        exchange.redeem(enrollmentRequest(tls.issuerUrl))
                    }
                    assertEquals(RelayV2CredentialExchangeFailureKind.SCHEMA, failure.kind)
                    assertSecretsRedacted(failure)
                }
            }
        }

    @Test
    fun `network failure and invalid issuer diagnostics do not retain credential input`() = runBlocking {
        val tls = RelayV2TlsMockServer()
        val issuerUrl = tls.issuerUrl
        val exchange = OkHttpRelayV2CredentialExchange(tls.client)
        tls.server.shutdown()
        try {
            val network = captureExchangeFailure { exchange.refresh(refreshRequest(issuerUrl)) }
            assertEquals(RelayV2CredentialExchangeFailureKind.NETWORK, network.kind)
            assertSecretsRedacted(network)

            val invalidIssuer = runCatching {
                enrollmentRequest("http://relay.invalid")
            }.exceptionOrNull() ?: error("Cleartext issuer URL was accepted")
            assertSecretsRedacted(invalidIssuer)
        } finally {
            tls.client.dispatcher.executorService.shutdownNow()
            tls.client.connectionPool.evictAll()
        }
    }

    private fun enrollmentRequest(issuerUrl: String) = RelayV2EnrollmentExchangeRequest(
        issuerUrl = issuerUrl,
        exchangeAttemptId = EXCHANGE_ATTEMPT,
        enrollmentId = ENROLLMENT_ID,
        enrollmentCode = ENROLLMENT_CODE,
        clientInstanceId = CLIENT_INSTANCE_ID,
        deviceLabel = "Pixel",
    )

    private fun refreshRequest(issuerUrl: String) = RelayV2RefreshRequest(
        issuerUrl = issuerUrl,
        refreshAttemptId = REFRESH_ATTEMPT,
        grantId = GRANT_ID,
        clientInstanceId = CLIENT_INSTANCE_ID,
        refreshToken = REFRESH_TOKEN_1,
    )

    private fun assertRequestSecurity(request: RecordedRequest, path: String) {
        assertEquals("POST", request.method)
        assertEquals(path, request.requestUrl?.encodedPath)
        assertNull(request.requestUrl?.encodedQuery)
        assertNull(request.getHeader("Authorization"))
        assertEquals("no-store", request.getHeader("Cache-Control"))
        assertEquals("identity", request.getHeader("Accept-Encoding"))
        assertTrue(request.getHeader("Content-Type")?.startsWith("application/json") == true)
        val url = request.requestUrl.toString()
        assertFalse(url.contains(ENROLLMENT_CODE))
        assertFalse(url.contains(ACCESS_TOKEN_1))
        assertFalse(url.contains(REFRESH_TOKEN_1))
    }

    private fun RelayV2TlsMockServer.recordedRequest(): RecordedRequest =
        server.takeRequest(TIMEOUT_SECONDS, TimeUnit.SECONDS)
            ?: error("HTTPS request was not recorded")

    private suspend fun captureExchangeFailure(
        block: suspend () -> Unit,
    ): RelayV2CredentialExchangeException {
        val error = runCatching { block() }.exceptionOrNull()
            ?: error("Credential exchange unexpectedly succeeded")
        return error as? RelayV2CredentialExchangeException
            ?: throw AssertionError("Unexpected credential exchange failure", error)
    }

    private fun assertSecretsRedacted(error: Throwable) {
        val diagnostic = error.toString()
        assertFalse(diagnostic.contains(ENROLLMENT_CODE))
        assertFalse(diagnostic.contains(ACCESS_TOKEN_1))
        assertFalse(diagnostic.contains(REFRESH_TOKEN_1))
    }

    private fun jsonResponse(body: String, status: Int = 200): MockResponse = MockResponse()
        .setResponseCode(status)
        .addHeader("Content-Type", "application/json")
        .addHeader("Cache-Control", "no-store")
        .setBody(body)

    private fun clientCredentialResponse(
        attemptField: String,
        attemptId: String,
        relayUrl: String,
        accessToken: String = ACCESS_TOKEN_1,
        refreshToken: String = REFRESH_TOKEN_1,
    ): String =
        """{"$attemptField":"$attemptId","principalId":"principal-opaque-id","grantId":"$GRANT_ID","hostId":"mac-admin","relayUrl":"$relayUrl","accessToken":"$accessToken","accessExpiresAtMs":1783703600000,"refreshToken":"$refreshToken","refreshExpiresAtMs":1786292000000}"""

    private fun errorBody(code: String, message: String): String =
        """{"error":{"code":"$code","message":"$message","retryable":false,"retryAfterMs":null,"commandDisposition":"not_applicable","details":null}}"""

    private companion object {
        const val TIMEOUT_SECONDS = 5L
        const val EXCHANGE_ATTEMPT = "enrollment-exchange-uuid"
        const val REFRESH_ATTEMPT = "refresh-attempt-uuid"
        const val ENROLLMENT_ID = "enrollment-uuid"
        const val CLIENT_INSTANCE_ID = "android-install-uuid"
        const val GRANT_ID = "grant-uuid"
        const val ENROLLMENT_CODE = "twenroll2.opaque"
        const val ACCESS_TOKEN_1 = "twcap2.payload.mac"
        const val ACCESS_TOKEN_2 = "twcap2.payload-2.mac-2"
        const val REFRESH_TOKEN_1 = "twref2.opaque"
        const val REFRESH_TOKEN_2 = "twref2.rotated"
    }
}
