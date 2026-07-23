package com.tmuxworktree.mobile.app

import com.tmuxworktree.mobile.PairingPayloadRoute
import com.tmuxworktree.mobile.pairingPayloadRoute
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2CredentialReference
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2EnrollmentResult
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2Profile
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.fail
import org.junit.Test

class RelayV2EnrollmentReviewSessionTest {
    @Test
    fun `payload routing keeps malformed enrollment separate from Relay v1 pairing`() {
        assertEquals(
            PairingPayloadRoute.RELAY_V2_ENROLLMENT,
            pairingPayloadRoute("tmuxworktree://enroll?v=2&enrollmentCode=%ZZ"),
        )
        assertEquals(
            PairingPayloadRoute.RELAY_V1_PAIRING,
            pairingPayloadRoute(
                "tmuxworktree://pair?relayUrl=wss%3A%2F%2Frelay.example.com&token=legacy",
            ),
        )
        assertEquals(
            PairingPayloadRoute.UNKNOWN,
            pairingPayloadRoute("tmuxworktree://user@enroll?v=2"),
        )
    }

    @Test
    fun `offer and cancel are network free and expose no enrollment code`() = runBlocking {
        val calls = AtomicInteger()
        val session = RelayV2EnrollmentReviewSession {
            calls.incrementAndGet()
            error("confirmation must not run")
        }

        assertEquals(RelayV2EnrollmentOfferResult.ACCEPTED, session.offer(enrollmentPayload()))
        val review = session.state as RelayV2EnrollmentReviewState.Review
        assertEquals(ISSUER_URL, review.facts.issuerUrl)
        assertEquals(RELAY_URL, review.facts.relayUrl)
        assertEquals(HOST_ID, review.facts.hostId)
        assertEquals(ENROLLMENT_ID, review.facts.enrollmentId)
        listOf(review.toString(), session.state.toString(), session.toString()).forEach { rendered ->
            assertFalse(rendered, rendered.contains(ENROLLMENT_CODE))
        }
        assertEquals(0, calls.get())

        assertEquals(RelayV2EnrollmentCancelResult.CLEARED, session.cancel())
        assertEquals(RelayV2EnrollmentReviewState.Idle, session.state)
        assertEquals(0, calls.get())
    }

    @Test
    fun `two concurrent confirmations invoke the port once and reject the second as busy`() =
        runBlocking {
            val calls = AtomicInteger()
            val started = CompletableDeferred<Unit>()
            val release = CompletableDeferred<Unit>()
            val session = RelayV2EnrollmentReviewSession {
                calls.incrementAndGet()
                started.complete(Unit)
                release.await()
                RelayV2EnrollmentResult.Activated(activeProfile())
            }
            assertEquals(RelayV2EnrollmentOfferResult.ACCEPTED, session.offer(enrollmentPayload()))

            val first = async { session.confirm(deviceLabel = "Pixel") }
            started.await()
            assertEquals(RelayV2EnrollmentReviewState.Submitting::class, session.state::class)
            assertEquals(RelayV2EnrollmentConfirmResult.BUSY, session.confirm(deviceLabel = "Pixel"))
            assertEquals(1, calls.get())

            release.complete(Unit)
            assertEquals(RelayV2EnrollmentConfirmResult.COMPLETED, first.await())
            assertEquals(1, calls.get())
            assertEquals(RelayV2EnrollmentReviewState.Completed::class, session.state::class)
        }

    @Test
    fun `confirmed enrollment stays offline until one explicit activation`() = runBlocking {
        val confirmationCalls = AtomicInteger()
        val activationCalls = AtomicInteger()
        val activationStarted = CompletableDeferred<Unit>()
        val releaseActivation = CompletableDeferred<Unit>()
        val expectedProfile = activeProfile()
        val session = RelayV2EnrollmentReviewSession(
            confirmationPort = RelayV2EnrollmentConfirmationPort {
                confirmationCalls.incrementAndGet()
                RelayV2EnrollmentResult.Activated(expectedProfile)
            },
            activationPort = RelayV2EnrollmentActivationPort { profile ->
                assertEquals(expectedProfile, profile)
                activationCalls.incrementAndGet()
                activationStarted.complete(Unit)
                releaseActivation.await()
            },
        )
        assertEquals(RelayV2EnrollmentOfferResult.ACCEPTED, session.offer(enrollmentPayload()))
        assertEquals(RelayV2EnrollmentConfirmResult.COMPLETED, session.confirm())
        assertEquals(1, confirmationCalls.get())
        assertEquals(0, activationCalls.get())
        assertEquals(RelayV2EnrollmentReviewState.Completed::class, session.state::class)

        val first = async { session.activate() }
        activationStarted.await()
        assertEquals(RelayV2EnrollmentReviewState.Activating::class, session.state::class)
        assertEquals(RelayV2EnrollmentActivateResult.BUSY, session.activate())
        assertEquals(1, activationCalls.get())
        releaseActivation.complete(Unit)
        assertEquals(RelayV2EnrollmentActivateResult.ACTIVATED, first.await())
        assertEquals(RelayV2EnrollmentReviewState.Idle, session.state)
    }

    @Test
    fun `cancelled confirmation propagates and leaves a fixed failure state`() = runBlocking {
        val calls = AtomicInteger()
        val started = CompletableDeferred<Unit>()
        val neverCompletes = CompletableDeferred<Unit>()
        val session = RelayV2EnrollmentReviewSession {
            calls.incrementAndGet()
            started.complete(Unit)
            neverCompletes.await()
            error("unreachable")
        }
        assertEquals(RelayV2EnrollmentOfferResult.ACCEPTED, session.offer(enrollmentPayload()))

        val confirmation = async { session.confirm() }
        started.await()
        confirmation.cancel(CancellationException("test cancellation"))
        try {
            confirmation.await()
            fail("CancellationException must propagate")
        } catch (_: CancellationException) {
            // Expected: the owner records only a fixed failure and preserves cancellation.
        }

        val failure = session.state as RelayV2EnrollmentReviewState.Failure
        assertEquals("Relay v2 enrollment confirmation failed", failure.message)
        assertFalse(session.toString().contains(ENROLLMENT_CODE))
        assertEquals(1, calls.get())
    }

    @Test
    fun `cancellation after a successful port return settles state before propagating`() =
        runBlocking {
            val calls = AtomicInteger()
            val session = RelayV2EnrollmentReviewSession {
                calls.incrementAndGet()
                currentCoroutineContext()[Job]!!.cancel(
                    CancellationException("cancel after side effect"),
                )
                RelayV2EnrollmentResult.Activated(activeProfile())
            }
            assertEquals(RelayV2EnrollmentOfferResult.ACCEPTED, session.offer(enrollmentPayload()))

            val confirmation = async { session.confirm() }
            try {
                confirmation.await()
                fail("CancellationException must propagate")
            } catch (_: CancellationException) {
                // Expected after the non-cancellable final state settlement.
            }

            assertEquals(RelayV2EnrollmentReviewState.Completed::class, session.state::class)
            assertEquals(1, calls.get())
        }

    @Test
    fun `pair malformed and replacement payloads cannot overwrite an existing review`() =
        runBlocking {
            val session = RelayV2EnrollmentReviewSession {
                error("confirmation must not run")
            }
            assertEquals(RelayV2EnrollmentOfferResult.ACCEPTED, session.offer(enrollmentPayload()))
            val original = session.state

            assertEquals(
                RelayV2EnrollmentOfferResult.REJECTED,
                session.offer(
                    "tmuxworktree://pair?relayUrl=wss%3A%2F%2Frelay.example.com&token=legacy",
                ),
            )
            assertEquals(
                RelayV2EnrollmentOfferResult.REJECTED,
                session.offer("tmuxworktree://enroll?v=2&enrollmentCode=$ENROLLMENT_CODE"),
            )
            assertEquals(
                RelayV2EnrollmentOfferResult.REVIEW_ALREADY_PRESENT,
                session.offer(enrollmentPayload(enrollmentId = "replacement-enrollment")),
            )
            assertEquals(original, session.state)
        }

    private fun enrollmentPayload(enrollmentId: String = ENROLLMENT_ID): String =
        "tmuxworktree://enroll?v=2" +
            "&issuerUrl=https%3A%2F%2Frelay.example.com" +
            "&relayUrl=wss%3A%2F%2Frelay.example.com%2Fclient" +
            "&hostId=$HOST_ID" +
            "&enrollmentId=$enrollmentId" +
            "&enrollmentCode=$ENROLLMENT_CODE"

    private fun activeProfile(): RelayV2Profile = RelayV2Profile(
        profileId = "relay-v2-profile",
        issuerUrl = ISSUER_URL,
        relayUrl = RELAY_URL,
        hostId = HOST_ID,
        principalId = "principal-1",
        grantId = "grant-1",
        clientInstanceId = "android-install-1",
        credentialReference = RelayV2CredentialReference("credential-1"),
        credentialVersion = 1,
    )

    private companion object {
        const val ISSUER_URL = "https://relay.example.com"
        const val RELAY_URL = "wss://relay.example.com/client"
        const val HOST_ID = "mac-admin"
        const val ENROLLMENT_ID = "enrollment-1"
        const val ENROLLMENT_CODE = "twenroll2.one-time-code"
    }
}
