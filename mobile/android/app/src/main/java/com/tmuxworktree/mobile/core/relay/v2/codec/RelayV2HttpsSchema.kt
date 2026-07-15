package com.tmuxworktree.mobile.core.relay.v2.codec

internal fun validateRelayV2HttpsBody(
    schema: RelayV2HttpsSchema,
    body: RelayV2JsonObject,
): RelayV2NormalizedHttpsBody {
    when (schema) {
        RelayV2HttpsSchema.ENROLLMENT_REDEEM_REQUEST -> {
            exactKeys(
                body,
                listOf(
                    "exchangeAttemptId",
                    "enrollmentId",
                    "enrollmentCode",
                    "clientInstanceId",
                    "deviceLabel",
                ),
            )
            jsonId(required(body, "exchangeAttemptId"))
            jsonId(required(body, "enrollmentId"))
            jsonSecret(required(body, "enrollmentCode"))
            jsonId(required(body, "clientInstanceId"))
            jsonString(
                required(body, "deviceLabel"),
                allowOuterWhitespace = true,
                maxBytes = 128,
            )
        }
        RelayV2HttpsSchema.ENROLLMENT_REDEEM_RESPONSE ->
            validateClientCredentialResponse(body, "exchangeAttemptId")
        RelayV2HttpsSchema.TOKEN_REFRESH_CLIENT_REQUEST -> {
            exactKeys(
                body,
                listOf("refreshAttemptId", "grantId", "clientInstanceId", "refreshToken"),
            )
            jsonId(required(body, "refreshAttemptId"))
            jsonId(required(body, "grantId"))
            jsonId(required(body, "clientInstanceId"))
            jsonSecret(required(body, "refreshToken"))
        }
        RelayV2HttpsSchema.TOKEN_REFRESH_CLIENT_RESPONSE ->
            validateClientCredentialResponse(body, "refreshAttemptId")
        RelayV2HttpsSchema.GRANT_SELF_REVOKE_REQUEST -> {
            exactKeys(body, listOf("reason"))
            jsonLiteral(required(body, "reason"), "user_revoked")
        }
        RelayV2HttpsSchema.GRANT_SELF_REVOKE_RESPONSE -> {
            exactKeys(body, listOf("grantId", "revokedAtMs", "alreadyRevoked"))
            jsonId(required(body, "grantId"))
            jsonInteger(required(body, "revokedAtMs"))
            jsonBoolean(required(body, "alreadyRevoked"))
        }
        RelayV2HttpsSchema.HOST_BOOTSTRAP_REQUEST -> {
            exactKeys(
                body,
                listOf(
                    "bootstrapAttemptId",
                    "bootstrapToken",
                    "hostId",
                    "hostEpoch",
                    "hostInstanceId",
                ),
            )
            jsonId(required(body, "bootstrapAttemptId"))
            jsonSecret(required(body, "bootstrapToken"))
            jsonId(required(body, "hostId"))
            jsonId(required(body, "hostEpoch"))
            jsonId(required(body, "hostInstanceId"))
        }
        RelayV2HttpsSchema.HOST_BOOTSTRAP_RESPONSE ->
            validateHostCredentialResponse(body, "bootstrapAttemptId")
        RelayV2HttpsSchema.TOKEN_REFRESH_HOST_REQUEST -> {
            exactKeys(
                body,
                listOf("refreshAttemptId", "grantId", "hostInstanceId", "refreshToken"),
            )
            jsonId(required(body, "refreshAttemptId"))
            jsonId(required(body, "grantId"))
            jsonId(required(body, "hostInstanceId"))
            jsonSecret(required(body, "refreshToken"))
        }
        RelayV2HttpsSchema.TOKEN_REFRESH_HOST_RESPONSE ->
            validateHostCredentialResponse(body, "refreshAttemptId")
        RelayV2HttpsSchema.ERROR_RESPONSE -> {
            exactKeys(body, listOf("error"))
            validateStructuredError(required(body, "error"))
        }
    }
    return RelayV2NormalizedHttpsBody(schema)
}

private fun validateClientCredentialResponse(
    body: RelayV2JsonObject,
    attemptField: String,
) {
    exactKeys(
        body,
        listOf(
            attemptField,
            "principalId",
            "grantId",
            "hostId",
            "relayUrl",
            "accessToken",
            "accessExpiresAtMs",
            "refreshToken",
            "refreshExpiresAtMs",
        ),
    )
    jsonId(required(body, attemptField))
    jsonId(required(body, "principalId"))
    jsonId(required(body, "grantId"))
    jsonId(required(body, "hostId"))
    jsonWssUrl(required(body, "relayUrl"))
    jsonSecret(required(body, "accessToken"))
    jsonInteger(required(body, "accessExpiresAtMs"))
    jsonSecret(required(body, "refreshToken"))
    jsonInteger(required(body, "refreshExpiresAtMs"))
}

private fun validateHostCredentialResponse(
    body: RelayV2JsonObject,
    attemptField: String,
) {
    exactKeys(
        body,
        listOf(
            attemptField,
            "principalId",
            "grantId",
            "hostId",
            "accessToken",
            "accessExpiresAtMs",
            "refreshToken",
            "refreshExpiresAtMs",
        ),
    )
    jsonId(required(body, attemptField))
    jsonId(required(body, "principalId"))
    jsonId(required(body, "grantId"))
    jsonId(required(body, "hostId"))
    jsonSecret(required(body, "accessToken"))
    jsonInteger(required(body, "accessExpiresAtMs"))
    jsonSecret(required(body, "refreshToken"))
    jsonInteger(required(body, "refreshExpiresAtMs"))
}
