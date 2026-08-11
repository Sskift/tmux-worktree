package com.tmuxworktree.mobile.app

import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2ConfirmedEnrollment
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2CredentialExchangeException
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2CredentialExchangeFailureKind
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2EndpointValidator
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2EnrollmentResult
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2EnrollmentReviewDraft
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2EnrollmentReviewParser
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2Profile
import com.tmuxworktree.mobile.core.relay.v2.profile.requireValidRelayV2EnrollmentDeviceLabel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/** Explicit product boundary for the one network-capable enrollment confirmation action. */
internal fun interface RelayV2EnrollmentConfirmationPort {
    suspend fun confirm(enrollment: RelayV2ConfirmedEnrollment): RelayV2EnrollmentResult
}

/** Explicit post-confirmation action; successful return means the admitted runtime owns profile. */
internal fun interface RelayV2EnrollmentActivationPort {
    suspend fun activate(profile: RelayV2Profile)
}

/** Non-sensitive enrollment facts that may be rendered by a future review UI. */
internal data class RelayV2EnrollmentReviewFacts(
    val issuerUrl: String,
    val relayUrl: String,
    val hostId: String,
    val enrollmentId: String,
    val deviceLabel: String,
)

internal sealed interface RelayV2EnrollmentReviewState {
    data object Idle : RelayV2EnrollmentReviewState
    data class Review(val facts: RelayV2EnrollmentReviewFacts) : RelayV2EnrollmentReviewState
    data class Submitting(val facts: RelayV2EnrollmentReviewFacts) : RelayV2EnrollmentReviewState
    data class Completed(val facts: RelayV2EnrollmentReviewFacts) : RelayV2EnrollmentReviewState
    data class Activating(val facts: RelayV2EnrollmentReviewFacts) : RelayV2EnrollmentReviewState
    data class ActivationFailure(
        val facts: RelayV2EnrollmentReviewFacts,
        val cause: String? = null,
    ) : RelayV2EnrollmentReviewState {
        val message: String
            get() = FIXED_ACTIVATION_FAILURE_MESSAGE + boundedCauseSuffix(cause)
    }
    data class Failure(
        val facts: RelayV2EnrollmentReviewFacts,
        val cause: String? = null,
    ) : RelayV2EnrollmentReviewState {
        val message: String
            get() = FIXED_FAILURE_MESSAGE + boundedCauseSuffix(cause)
    }
}

internal enum class RelayV2EnrollmentOfferResult {
    ACCEPTED,
    REJECTED,
    REVIEW_ALREADY_PRESENT,
}

internal enum class RelayV2EnrollmentCancelResult {
    CLEARED,
    ALREADY_IDLE,
    SUBMISSION_IN_PROGRESS,
}

internal enum class RelayV2EnrollmentConfirmResult {
    COMPLETED,
    FAILED,
    BUSY,
    NO_REVIEW,
}

internal enum class RelayV2EnrollmentActivateResult {
    ACTIVATED,
    FAILED,
    BUSY,
    NO_CONFIRMED_PROFILE,
}

/**
 * Default-off, in-memory owner for one Relay v2 enrollment review session.
 *
 * The parsed draft is deliberately private because it contains the enrollment code. Offering a
 * payload never calls [confirmationPort], and this owner has no persistence or connection
 * dependency. A submission consumes the private draft before invoking the port, so a
 * second concurrent confirmation cannot repeat the exchange.
 */
internal class RelayV2EnrollmentReviewSession(
    private val confirmationPort: RelayV2EnrollmentConfirmationPort,
    private val activationPort: RelayV2EnrollmentActivationPort,
    private val deviceLabel: String,
) {
    constructor(
        deviceLabel: String,
        confirmationPort: RelayV2EnrollmentConfirmationPort,
    ) : this(
        confirmationPort,
        RelayV2EnrollmentActivationPort {
            error("Relay v2 enrollment activation port is unavailable")
        },
        deviceLabel,
    )

    private val mutex = Mutex()

    init {
        requireValidRelayV2EnrollmentDeviceLabel(deviceLabel)
    }

    @Volatile
    private var currentState: RelayV2EnrollmentReviewState = RelayV2EnrollmentReviewState.Idle
    private var privateDraft: RelayV2EnrollmentReviewDraft? = null
    private var privateConfirmedProfile: RelayV2Profile? = null

    val state: RelayV2EnrollmentReviewState
        get() = currentState

    suspend fun offer(rawPayload: String?): RelayV2EnrollmentOfferResult {
        val parsed = RelayV2EnrollmentReviewParser.parse(rawPayload)
            ?: return RelayV2EnrollmentOfferResult.REJECTED
        return offerParsed(parsed)
    }

    /**
     * Settings-only manual ingress for the same canonical enrollment token accepted by QR/Intent.
     *
     * The separately entered issuer is an exact review fence: it is never used to rewrite the
     * token, and a mismatch is rejected before the private draft is installed. The token remains
     * private to this in-memory owner and reaches no persisted UI state.
     */
    suspend fun offerManual(
        issuerUrl: String?,
        oneTimeEnrollmentToken: String?,
    ): RelayV2EnrollmentOfferResult {
        val expectedIssuerUrl = issuerUrl?.trim().orEmpty()
        if (!RelayV2EndpointValidator.isIssuerUrl(expectedIssuerUrl)) {
            return RelayV2EnrollmentOfferResult.REJECTED
        }
        val exactToken = oneTimeEnrollmentToken
            ?: return RelayV2EnrollmentOfferResult.REJECTED
        if (exactToken != exactToken.trim()) {
            return RelayV2EnrollmentOfferResult.REJECTED
        }
        val parsed = RelayV2EnrollmentReviewParser.parse(exactToken)
            ?: return RelayV2EnrollmentOfferResult.REJECTED
        if (parsed.issuerUrl != expectedIssuerUrl) {
            return RelayV2EnrollmentOfferResult.REJECTED
        }
        return offerParsed(parsed)
    }

    private suspend fun offerParsed(
        parsed: RelayV2EnrollmentReviewDraft,
    ): RelayV2EnrollmentOfferResult {
        return mutex.withLock {
            if (currentState != RelayV2EnrollmentReviewState.Idle) {
                return@withLock RelayV2EnrollmentOfferResult.REVIEW_ALREADY_PRESENT
            }
            privateDraft = parsed
            currentState = RelayV2EnrollmentReviewState.Review(
                parsed.toReviewFacts(deviceLabel),
            )
            RelayV2EnrollmentOfferResult.ACCEPTED
        }
    }

    suspend fun cancel(): RelayV2EnrollmentCancelResult = mutex.withLock {
        when (currentState) {
            is RelayV2EnrollmentReviewState.Submitting ->
                RelayV2EnrollmentCancelResult.SUBMISSION_IN_PROGRESS
            is RelayV2EnrollmentReviewState.Activating ->
                RelayV2EnrollmentCancelResult.SUBMISSION_IN_PROGRESS
            RelayV2EnrollmentReviewState.Idle -> RelayV2EnrollmentCancelResult.ALREADY_IDLE
            else -> {
                privateDraft = null
                privateConfirmedProfile = null
                currentState = RelayV2EnrollmentReviewState.Idle
                RelayV2EnrollmentCancelResult.CLEARED
            }
        }
    }

    suspend fun confirm(): RelayV2EnrollmentConfirmResult {
        val submission = mutex.withLock {
            when (val observed = currentState) {
                is RelayV2EnrollmentReviewState.Submitting ->
                    return RelayV2EnrollmentConfirmResult.BUSY
                !is RelayV2EnrollmentReviewState.Review ->
                    return RelayV2EnrollmentConfirmResult.NO_REVIEW
                else -> {
                    val draft = privateDraft
                        ?: return@withLock SubmissionPreparation.Failed(observed.facts)
                    privateDraft = null
                    currentState = RelayV2EnrollmentReviewState.Submitting(observed.facts)
                    try {
                        SubmissionPreparation.Ready(observed.facts, draft.confirm(deviceLabel))
                    } catch (cancelled: CancellationException) {
                        currentState = RelayV2EnrollmentReviewState.Failure(observed.facts)
                        throw cancelled
                    } catch (failure: IllegalArgumentException) {
                        SubmissionPreparation.Failed(
                            observed.facts,
                            failure.toBoundedFailureCause(),
                        )
                    }
                }
            }
        }

        if (submission is SubmissionPreparation.Failed) {
            return mutex.withLock {
                currentState = RelayV2EnrollmentReviewState.Failure(
                    submission.facts,
                    submission.cause,
                )
                RelayV2EnrollmentConfirmResult.FAILED
            }
        }
        submission as SubmissionPreparation.Ready
        var failureCause: String? = null
        val activatedProfile = try {
            (confirmationPort.confirm(submission.confirmed) as? RelayV2EnrollmentResult.Activated)
                ?.profile
        } catch (cancelled: CancellationException) {
            withContext(NonCancellable) {
                mutex.withLock {
                    currentState = RelayV2EnrollmentReviewState.Failure(submission.facts)
                }
            }
            throw cancelled
        } catch (failure: Exception) {
            failureCause = failure.toBoundedFailureCause()
            null
        }
        val settled = withContext(NonCancellable) {
            mutex.withLock {
                privateConfirmedProfile = activatedProfile
                currentState = if (activatedProfile != null) {
                    RelayV2EnrollmentReviewState.Completed(submission.facts)
                } else {
                    RelayV2EnrollmentReviewState.Failure(submission.facts, failureCause)
                }
                if (activatedProfile != null) {
                    RelayV2EnrollmentConfirmResult.COMPLETED
                } else {
                    RelayV2EnrollmentConfirmResult.FAILED
                }
            }
        }
        currentCoroutineContext().ensureActive()
        return settled
    }

    suspend fun activate(): RelayV2EnrollmentActivateResult {
        val activation = mutex.withLock {
            when (val observed = currentState) {
                is RelayV2EnrollmentReviewState.Submitting,
                is RelayV2EnrollmentReviewState.Activating,
                -> return RelayV2EnrollmentActivateResult.BUSY
                is RelayV2EnrollmentReviewState.Completed -> observed.facts
                is RelayV2EnrollmentReviewState.ActivationFailure -> observed.facts
                else -> return RelayV2EnrollmentActivateResult.NO_CONFIRMED_PROFILE
            }.let { facts ->
                val profile = privateConfirmedProfile
                    ?: return@withLock ActivationPreparation.Failed(facts)
                currentState = RelayV2EnrollmentReviewState.Activating(facts)
                ActivationPreparation.Ready(facts, profile)
            }
        }
        if (activation is ActivationPreparation.Failed) {
            return mutex.withLock {
                currentState = RelayV2EnrollmentReviewState.ActivationFailure(activation.facts)
                RelayV2EnrollmentActivateResult.FAILED
            }
        }
        activation as ActivationPreparation.Ready
        var failureCause: String? = null
        val activated = try {
            activationPort.activate(activation.profile)
            true
        } catch (cancelled: CancellationException) {
            withContext(NonCancellable) {
                mutex.withLock {
                    currentState = RelayV2EnrollmentReviewState.ActivationFailure(
                        activation.facts,
                    )
                }
            }
            throw cancelled
        } catch (failure: Exception) {
            failureCause = failure.toBoundedFailureCause()
            false
        }
        val settled = withContext(NonCancellable) {
            mutex.withLock {
                if (activated) {
                    privateConfirmedProfile = null
                    currentState = RelayV2EnrollmentReviewState.Idle
                    RelayV2EnrollmentActivateResult.ACTIVATED
                } else {
                    currentState = RelayV2EnrollmentReviewState.ActivationFailure(
                        activation.facts,
                        cause = failureCause,
                    )
                    RelayV2EnrollmentActivateResult.FAILED
                }
            }
        }
        currentCoroutineContext().ensureActive()
        return settled
    }

    override fun toString(): String = "RelayV2EnrollmentReviewSession(state=$currentState)"

    private sealed interface SubmissionPreparation {
        data class Ready(
            val facts: RelayV2EnrollmentReviewFacts,
            val confirmed: RelayV2ConfirmedEnrollment,
        ) : SubmissionPreparation

        data class Failed(
            val facts: RelayV2EnrollmentReviewFacts,
            val cause: String? = null,
        ) : SubmissionPreparation
    }

    private sealed interface ActivationPreparation {
        data class Ready(
            val facts: RelayV2EnrollmentReviewFacts,
            val profile: RelayV2Profile,
        ) : ActivationPreparation

        data class Failed(val facts: RelayV2EnrollmentReviewFacts) : ActivationPreparation
    }
}

private fun RelayV2EnrollmentReviewDraft.toReviewFacts(
    deviceLabel: String,
): RelayV2EnrollmentReviewFacts =
    RelayV2EnrollmentReviewFacts(
        issuerUrl = issuerUrl,
        relayUrl = relayUrl,
        hostId = hostId,
        enrollmentId = enrollmentId,
        deviceLabel = deviceLabel,
    )

private const val FIXED_FAILURE_MESSAGE = "Relay v2 enrollment confirmation failed"
private const val FIXED_ACTIVATION_FAILURE_MESSAGE = "Relay v2 connection could not be started"

/** Bounded, single-line suffix appended to the fixed failure message; blank causes add nothing. */
private fun boundedCauseSuffix(cause: String?): String {
    val trimmed = cause?.takeIf(String::isNotBlank) ?: return ""
    return ": $trimmed"
}

/**
 * Single-line, bounded cause captured from the activation/confirmation port.
 *
 * The messages thrown along the activation path are static English (admission, consent, and
 * composition guards); credential-exchange failures are already redacted by design
 * ([RelayV2CredentialExchangeException] retains no request/response body). The cause is truncated
 * so a hostile or oversized message can never blow up the UI.
 */
private fun Throwable.toBoundedFailureCause(): String? {
    val raw = when (this) {
        is RelayV2CredentialExchangeException -> when (kind) {
            RelayV2CredentialExchangeFailureKind.NETWORK ->
                "This phone cannot reach the Relay issuer. Check Wi-Fi or VPN and make sure the HTTPS endpoint is reachable from the phone."
            RelayV2CredentialExchangeFailureKind.AUTH ->
                "The one-time enrollment was rejected or expired. Create a new Relay v2 QR on the Mac."
            RelayV2CredentialExchangeFailureKind.HTTP ->
                "The Relay issuer returned HTTP ${httpStatus ?: "error"}. Check the Relay center and try a new enrollment."
            RelayV2CredentialExchangeFailureKind.CONFIGURATION ->
                "The Relay v2 endpoint configuration is invalid. Review the issuer and Relay URLs on the Mac."
            RelayV2CredentialExchangeFailureKind.SCHEMA ->
                "The Relay response is incompatible with this app. Update the Dashboard and Android app together."
        }
        else -> message?.takeIf(String::isNotBlank)
    }
        ?: this::class.simpleName?.takeIf(String::isNotBlank)
        ?: return null
    return raw.replace('\n', ' ').replace('\r', ' ').trim().take(MAX_CAUSE_LENGTH)
}

private const val MAX_CAUSE_LENGTH = 200
