package com.tmuxworktree.mobile.core.relay.v2.profile

import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2Codec
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2CodecException
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2DecodedMessage
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2HttpsSchema
import java.io.IOException
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Authenticator
import okhttp3.Call
import okhttp3.Callback
import okhttp3.CookieJar
import okhttp3.EventListener
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.Response
import okhttp3.ResponseBody
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okio.Buffer
import okio.BufferedSink

internal enum class RelayV2CredentialExchangeFailureKind {
    CONFIGURATION,
    NETWORK,
    HTTP,
    AUTH,
    SCHEMA,
}

/** A closed, redacted failure that never retains a request, response body, or transport cause. */
internal class RelayV2CredentialExchangeException(
    val kind: RelayV2CredentialExchangeFailureKind,
    val httpStatus: Int? = null,
    val errorCode: String? = null,
    val retryable: Boolean = false,
    val retryAfterMs: Long? = null,
) : IOException(
    "Relay v2 credential exchange failed (${errorCode ?: kind.name})",
)

/**
 * Strict HTTPS redeem/refresh/self-revoke adapter for the existing profile repository seams.
 *
 * Each invocation sends exactly one caller-owned attempt. OkHttp connection retries are disabled;
 * response-loss replay and credential CAS remain repository/broker responsibilities.
 */
internal class OkHttpRelayV2CredentialExchange(
    client: OkHttpClient = defaultClient(),
    private val codec: RelayV2Codec = RelayV2Codec(),
) : RelayV2CredentialExchange, RelayV2SelfRevokeExchange {
    private val client = singleAttemptClient(client)

    override suspend fun redeem(
        request: RelayV2EnrollmentExchangeRequest,
    ): RelayV2EnrollmentExchangeResponse {
        val body = linkedMapOf<String, Any?>(
            "exchangeAttemptId" to request.exchangeAttemptId,
            "enrollmentId" to request.enrollmentId,
            "enrollmentCode" to request.enrollmentCode,
            "clientInstanceId" to request.clientInstanceId,
            "deviceLabel" to request.deviceLabel,
        )
        val response = execute(
            issuerUrl = request.issuerUrl,
            pathname = ENROLLMENT_REDEEM_PATH,
            requestSchema = RelayV2HttpsSchema.ENROLLMENT_REDEEM_REQUEST,
            responseSchema = RelayV2HttpsSchema.ENROLLMENT_REDEEM_RESPONSE,
            body = body,
        )
        return response.toEnrollmentResponse()
    }

    override suspend fun refresh(request: RelayV2RefreshRequest): RelayV2RefreshResponse {
        val body = linkedMapOf<String, Any?>(
            "refreshAttemptId" to request.refreshAttemptId,
            "grantId" to request.grantId,
            "clientInstanceId" to request.clientInstanceId,
            "refreshToken" to request.refreshToken,
        )
        val response = execute(
            issuerUrl = request.issuerUrl,
            pathname = CLIENT_REFRESH_PATH,
            requestSchema = RelayV2HttpsSchema.TOKEN_REFRESH_CLIENT_REQUEST,
            responseSchema = RelayV2HttpsSchema.TOKEN_REFRESH_CLIENT_RESPONSE,
            body = body,
        )
        return response.toRefreshResponse()
    }

    override suspend fun revoke(
        request: RelayV2SelfRevokeRequest,
        onPreparedForNetworkHandoff: suspend () -> Unit,
    ): RelayV2SelfRevokeExchangeResult {
        val call = createSelfRevokeCall(request)
        try {
            onPreparedForNetworkHandoff()
        } catch (error: RelayV2CredentialExchangeException) {
            throw error
        } catch (_: Throwable) {
            throw failure(RelayV2CredentialExchangeFailureKind.CONFIGURATION)
        }
        return executeSelfRevoke(call)
    }

    private fun createSelfRevokeCall(request: RelayV2SelfRevokeRequest): Call {
        val url = exactEndpoint(request.issuerUrl, SELF_REVOKE_PATH)
        val encoded = try {
            codec.encodeHttpsBody(
                RelayV2HttpsSchema.GRANT_SELF_REVOKE_REQUEST,
                linkedMapOf("reason" to SELF_REVOKE_REASON),
            )
        } catch (_: RelayV2CodecException) {
            throw failure(RelayV2CredentialExchangeFailureKind.SCHEMA)
        } catch (_: Throwable) {
            throw failure(RelayV2CredentialExchangeFailureKind.SCHEMA)
        }
        val httpRequest = try {
            Request.Builder()
                .url(url)
                .post(SingleAttemptJsonRequestBody(encoded))
                .header("Authorization", "Bearer ${request.accessToken}")
                .header("Cache-Control", "no-store")
                .header("Accept-Encoding", "identity")
                .build()
        } catch (_: Throwable) {
            throw failure(RelayV2CredentialExchangeFailureKind.CONFIGURATION)
        }
        return try {
            client.newCall(httpRequest)
        } catch (_: Throwable) {
            throw failure(RelayV2CredentialExchangeFailureKind.CONFIGURATION)
        }
    }

    private suspend fun executeSelfRevoke(
        call: Call,
    ): RelayV2SelfRevokeExchangeResult = try {
        suspendCancellableCoroutine { continuation ->
            continuation.invokeOnCancellation { call.cancel() }
            if (!continuation.isActive) return@suspendCancellableCoroutine
            try {
                call.enqueue(object : Callback {
                    override fun onFailure(call: Call, e: IOException) {
                        if (continuation.isActive) {
                            continuation.resumeWith(
                                Result.success(
                                    RelayV2SelfRevokeExchangeResult.MayHaveCommitted,
                                ),
                            )
                        }
                    }

                    override fun onResponse(call: Call, response: Response) {
                        val result = try {
                            response.use(::decodeSelfRevokeResponse)
                        } catch (_: Throwable) {
                            RelayV2SelfRevokeExchangeResult.MayHaveCommitted
                        }
                        if (continuation.isActive) {
                            continuation.resumeWith(Result.success(result))
                        }
                    }
                })
            } catch (_: Throwable) {
                if (continuation.isActive) {
                    continuation.resumeWith(
                        Result.success(RelayV2SelfRevokeExchangeResult.MayHaveCommitted),
                    )
                }
            }
        }
    } catch (_: Throwable) {
        RelayV2SelfRevokeExchangeResult.MayHaveCommitted
    }

    private fun decodeSelfRevokeResponse(
        response: Response,
    ): RelayV2SelfRevokeExchangeResult {
        if (response.code != 200 && response.code != 403) {
            return RelayV2SelfRevokeExchangeResult.MayHaveCommitted
        }
        if (!response.cacheControl.noStore) {
            throw failure(
                RelayV2CredentialExchangeFailureKind.SCHEMA,
                httpStatus = response.code,
            )
        }
        val encodings = response.headers.values("Content-Encoding")
        if (encodings.size > 1) {
            throw failure(
                RelayV2CredentialExchangeFailureKind.SCHEMA,
                httpStatus = response.code,
            )
        }
        val bytes = boundedBody(response.body, response.code)
        val schema = if (response.code == 200) {
            RelayV2HttpsSchema.GRANT_SELF_REVOKE_RESPONSE
        } else {
            RelayV2HttpsSchema.ERROR_RESPONSE
        }
        val decoded = codec.decodeHttpsBody(schema, bytes, encodings.singleOrNull())
        if (response.code == 403) {
            return RelayV2SelfRevokeExchangeResult.Rejected(
                RelayV2SelfRevokeFailureCode.FORBIDDEN,
            )
        }
        return RelayV2SelfRevokeExchangeResult.Confirmed(
            grantId = decoded.frame.string("grantId"),
            revokedAtMs = decoded.frame.long("revokedAtMs"),
            alreadyRevoked = decoded.frame.boolean("alreadyRevoked"),
        )
    }

    private suspend fun execute(
        issuerUrl: String,
        pathname: String,
        requestSchema: RelayV2HttpsSchema,
        responseSchema: RelayV2HttpsSchema,
        body: Map<String, Any?>,
    ): RelayV2DecodedMessage {
        val url = exactEndpoint(issuerUrl, pathname)
        val encoded = try {
            codec.encodeHttpsBody(requestSchema, body)
        } catch (_: RelayV2CodecException) {
            throw failure(RelayV2CredentialExchangeFailureKind.SCHEMA)
        } catch (_: Throwable) {
            throw failure(RelayV2CredentialExchangeFailureKind.SCHEMA)
        }
        val httpRequest = Request.Builder()
            .url(url)
            .post(SingleAttemptJsonRequestBody(encoded))
            .header("Cache-Control", "no-store")
            .header("Accept-Encoding", "identity")
            .build()
        val call = client.newCall(httpRequest)
        return suspendCancellableCoroutine { continuation ->
            continuation.invokeOnCancellation { call.cancel() }
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    if (continuation.isActive) {
                        continuation.resumeWithException(
                            failure(RelayV2CredentialExchangeFailureKind.NETWORK),
                        )
                    }
                }

                override fun onResponse(call: Call, response: Response) {
                    val result = runCatching {
                        response.use { decodeResponse(it, responseSchema) }
                    }.recoverCatching { error ->
                        if (error is RelayV2CredentialExchangeException) throw error
                        throw failure(
                            RelayV2CredentialExchangeFailureKind.SCHEMA,
                            httpStatus = response.code,
                        )
                    }
                    if (continuation.isActive) continuation.resumeWith(result)
                }
            })
        }
    }

    private fun decodeResponse(
        response: Response,
        successSchema: RelayV2HttpsSchema,
    ): RelayV2DecodedMessage {
        if (!response.cacheControl.noStore) {
            throw failure(
                RelayV2CredentialExchangeFailureKind.SCHEMA,
                httpStatus = response.code,
            )
        }
        val encodings = response.headers.values("Content-Encoding")
        if (encodings.size > 1) {
            throw failure(
                RelayV2CredentialExchangeFailureKind.SCHEMA,
                httpStatus = response.code,
            )
        }
        val bytes = boundedBody(response.body, response.code)
        val schema = if (response.isSuccessful) successSchema else RelayV2HttpsSchema.ERROR_RESPONSE
        val decoded = try {
            codec.decodeHttpsBody(schema, bytes, encodings.singleOrNull())
        } catch (_: RelayV2CodecException) {
            throw failure(
                RelayV2CredentialExchangeFailureKind.SCHEMA,
                httpStatus = response.code,
            )
        }
        if (response.isSuccessful) return decoded

        val error = decoded.frame["error"] as Map<*, *>
        val errorCode = error["code"] as String
        val retryable = error["retryable"] as Boolean
        val retryAfterMs = error["retryAfterMs"] as? Long
        val kind = if (response.code == 401 || response.code == 403 || errorCode in AUTH_ERROR_CODES) {
            RelayV2CredentialExchangeFailureKind.AUTH
        } else {
            RelayV2CredentialExchangeFailureKind.HTTP
        }
        throw failure(
            kind = kind,
            httpStatus = response.code,
            errorCode = errorCode,
            retryable = retryable,
            retryAfterMs = retryAfterMs,
        )
    }

    private fun boundedBody(body: ResponseBody?, httpStatus: Int): ByteArray {
        val responseBody = body ?: throw failure(
            RelayV2CredentialExchangeFailureKind.SCHEMA,
            httpStatus = httpStatus,
        )
        val declared = responseBody.contentLength()
        if (declared > RelayV2Codec.HTTPS_BODY_BYTES) {
            throw failure(
                RelayV2CredentialExchangeFailureKind.SCHEMA,
                httpStatus = httpStatus,
                errorCode = "INVALID_ENVELOPE",
            )
        }
        val source = responseBody.source()
        val buffer = Buffer()
        var total = 0L
        val maximum = RelayV2Codec.HTTPS_BODY_BYTES.toLong()
        while (total <= maximum) {
            val read = source.read(buffer, minOf(8_192L, maximum + 1 - total))
            if (read == -1L) return buffer.readByteArray()
            total += read
            if (total > maximum) {
                throw failure(
                    RelayV2CredentialExchangeFailureKind.SCHEMA,
                    httpStatus = httpStatus,
                    errorCode = "INVALID_ENVELOPE",
                )
            }
        }
        throw failure(
            RelayV2CredentialExchangeFailureKind.SCHEMA,
            httpStatus = httpStatus,
            errorCode = "INVALID_ENVELOPE",
        )
    }

    private fun exactEndpoint(issuerUrl: String, pathname: String): HttpUrl {
        if (!RelayV2EndpointValidator.isIssuerUrl(issuerUrl)) {
            throw failure(RelayV2CredentialExchangeFailureKind.CONFIGURATION)
        }
        val base = issuerUrl.toHttpUrlOrNull()
            ?: throw failure(RelayV2CredentialExchangeFailureKind.CONFIGURATION)
        return base.newBuilder()
            .encodedPath(pathname)
            .query(null)
            .fragment(null)
            .build()
    }

    private fun RelayV2DecodedMessage.toEnrollmentResponse(): RelayV2EnrollmentExchangeResponse {
        val response = credentialResponseFields()
        return RelayV2EnrollmentExchangeResponse(
            exchangeAttemptId = frame.string("exchangeAttemptId"),
            principalId = response.principalId,
            grantId = response.grantId,
            hostId = response.hostId,
            relayUrl = response.relayUrl,
            accessToken = response.accessToken,
            accessExpiresAtMs = response.accessExpiresAtMs,
            refreshToken = response.refreshToken,
            refreshExpiresAtMs = response.refreshExpiresAtMs,
        )
    }

    private fun RelayV2DecodedMessage.toRefreshResponse(): RelayV2RefreshResponse {
        val response = credentialResponseFields()
        return RelayV2RefreshResponse(
            refreshAttemptId = frame.string("refreshAttemptId"),
            principalId = response.principalId,
            grantId = response.grantId,
            hostId = response.hostId,
            relayUrl = response.relayUrl,
            accessToken = response.accessToken,
            accessExpiresAtMs = response.accessExpiresAtMs,
            refreshToken = response.refreshToken,
            refreshExpiresAtMs = response.refreshExpiresAtMs,
        )
    }

    private fun RelayV2DecodedMessage.credentialResponseFields(): CredentialResponseFields {
        val relayUrl = frame.string("relayUrl")
        val accessToken = frame.string("accessToken")
        val refreshToken = frame.string("refreshToken")
        if (!RelayV2EndpointValidator.isRelayUrl(relayUrl) ||
            !RelayV2CredentialSecretValidator.isAccessToken(accessToken) ||
            !RelayV2CredentialSecretValidator.isRefreshToken(refreshToken)
        ) {
            throw failure(RelayV2CredentialExchangeFailureKind.SCHEMA)
        }
        return CredentialResponseFields(
            principalId = frame.string("principalId"),
            grantId = frame.string("grantId"),
            hostId = frame.string("hostId"),
            relayUrl = relayUrl,
            accessToken = accessToken,
            accessExpiresAtMs = frame.long("accessExpiresAtMs"),
            refreshToken = refreshToken,
            refreshExpiresAtMs = frame.long("refreshExpiresAtMs"),
        )
    }

    private data class CredentialResponseFields(
        val principalId: String,
        val grantId: String,
        val hostId: String,
        val relayUrl: String,
        val accessToken: String,
        val accessExpiresAtMs: Long,
        val refreshToken: String,
        val refreshExpiresAtMs: Long,
    )

    private companion object {
        const val ENROLLMENT_REDEEM_PATH = "/v2/enrollments/redeem"
        const val CLIENT_REFRESH_PATH = "/v2/tokens/refresh"
        const val SELF_REVOKE_PATH = "/v2/grants/self/revoke"
        const val SELF_REVOKE_REASON = "user_revoked"
        val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
        val AUTH_ERROR_CODES = setOf(
            "AUTH_REQUIRED",
            "AUTH_INVALID",
            "PERMISSION_DENIED",
            "GRANT_NOT_FOUND",
            "ROLE_MISMATCH",
        )

        fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .retryOnConnectionFailure(false)
            .followRedirects(false)
            .followSslRedirects(false)
            .protocols(listOf(Protocol.HTTP_1_1))
            .build()

        /**
         * Retains only connection/TLS policy from an injected client. Credential-bearing calls do
         * not inherit application hooks or any OkHttp follow-up authority. The one-shot request
         * body is the final guard against status follow-ups such as 503 Retry-After: 0.
         */
        fun singleAttemptClient(source: OkHttpClient): OkHttpClient {
            val builder = source.newBuilder()
            builder.interceptors().clear()
            builder.networkInterceptors().clear()
            return builder
                .authenticator(Authenticator.NONE)
                .proxyAuthenticator(Authenticator.NONE)
                .cookieJar(CookieJar.NO_COOKIES)
                .eventListener(EventListener.NONE)
                .cache(null)
                .protocols(listOf(Protocol.HTTP_1_1))
                .retryOnConnectionFailure(false)
                .followRedirects(false)
                .followSslRedirects(false)
                .build()
        }

        fun failure(
            kind: RelayV2CredentialExchangeFailureKind,
            httpStatus: Int? = null,
            errorCode: String? = null,
            retryable: Boolean = false,
            retryAfterMs: Long? = null,
        ): RelayV2CredentialExchangeException = RelayV2CredentialExchangeException(
            kind = kind,
            httpStatus = httpStatus,
            errorCode = errorCode,
            retryable = retryable,
            retryAfterMs = retryAfterMs,
        )
    }

    private class SingleAttemptJsonRequestBody(
        private val bytes: ByteArray,
    ) : RequestBody() {
        override fun contentType() = JSON_MEDIA_TYPE

        override fun contentLength(): Long = bytes.size.toLong()

        override fun isOneShot(): Boolean = true

        override fun writeTo(sink: BufferedSink) {
            sink.write(bytes)
        }

        override fun toString(): String = "RelayV2CredentialRequestBody(<redacted>)"
    }
}

private fun Map<String, Any?>.string(name: String): String = getValue(name) as String

private fun Map<String, Any?>.long(name: String): Long = (getValue(name) as Number).toLong()

private fun Map<String, Any?>.boolean(name: String): Boolean = getValue(name) as Boolean
