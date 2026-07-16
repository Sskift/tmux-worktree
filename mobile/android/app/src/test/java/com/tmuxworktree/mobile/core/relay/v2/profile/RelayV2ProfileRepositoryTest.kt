package com.tmuxworktree.mobile.core.relay.v2.profile

import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.mutablePreferencesOf
import androidx.datastore.preferences.core.stringPreferencesKey
import com.tmuxworktree.mobile.core.data.RelayProfilePreferencesCodec
import com.tmuxworktree.mobile.core.data.RelayV2CredentialBlobCodec
import java.io.ByteArrayInputStream
import java.io.DataInputStream
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class RelayV2ProfileRepositoryTest {
    @Test
    fun `profile preferences persist stable tags and v1 owner cannot replace active v2`() {
        val empty = mutablePreferencesOf()
        assertTrue(
            runCatching {
                RelayProfilePreferencesCodec.saveRelayV1Profile(
                    preferences = empty,
                    relayUrl = "  ",
                    hostId = "legacy-host",
                    autoConnect = true,
                )
            }.isFailure,
        )
        assertTrue(empty.asMap().isEmpty())

        val preferences = mutablePreferencesOf()
        preferences[stringPreferencesKey("relay_url")] = "wss://legacy.example.com/client"

        assertEquals(
            RelayProfileDialect.V1,
            RelayProfilePreferencesCodec.activeProfileIdentity(preferences)?.dialect,
        )
        assertEquals(null, RelayProfilePreferencesCodec.toRelayV2Profile(preferences))

        RelayProfilePreferencesCodec.saveRelayV1Profile(
            preferences = preferences,
            relayUrl = "wss://legacy.example.com/client/",
            hostId = "legacy-host",
            autoConnect = true,
        )
        assertEquals(
            "tw-relay.v1",
            preferences.valueNamed("relay_active_profile_dialect"),
        )
        assertEquals(
            "legacy_shared_secret",
            preferences.valueNamed("relay_active_credential_kind"),
        )

        val v2Profile = relayV2Profile()
        RelayProfilePreferencesCodec.activateRelayV2Profile(preferences, v2Profile)
        assertEquals(
            "tw-relay.v2",
            preferences.valueNamed("relay_active_profile_dialect"),
        )
        assertEquals(
            "twcap2_grant",
            preferences.valueNamed("relay_active_credential_kind"),
        )
        assertEquals(
            v2Profile.identity,
            RelayProfilePreferencesCodec.activeProfileIdentity(preferences),
        )
        assertEquals(v2Profile, RelayProfilePreferencesCodec.toRelayV2Profile(preferences))

        val activeV2Snapshot = preferences.namedValues()
        assertTrue(
            runCatching {
                RelayProfilePreferencesCodec.saveRelayV1Profile(
                    preferences,
                    "wss://replacement.example.com/client",
                    "replacement-host",
                    false,
                )
            }.isFailure,
        )
        assertTrue(
            runCatching { RelayProfilePreferencesCodec.clearRelayV1Profile(preferences) }.isFailure,
        )
        assertEquals(activeV2Snapshot, preferences.namedValues())

        preferences[stringPreferencesKey("relay_active_profile_dialect")] = "tw-relay.future"
        assertTrue(
            runCatching {
                RelayProfilePreferencesCodec.activeProfileIdentity(preferences)
            }.isFailure,
        )
        assertTrue(
            runCatching { RelayProfilePreferencesCodec.toRelayV2Profile(preferences) }.isFailure,
        )
        preferences[stringPreferencesKey("relay_active_profile_dialect")] = "tw-relay.v2"
        preferences[stringPreferencesKey("relay_active_credential_kind")] = "credential.future"
        assertTrue(
            runCatching { RelayProfilePreferencesCodec.toRelayV2Profile(preferences) }.isFailure,
        )
    }

    @Test
    fun `credential blob codec uses frozen pending tags and rejects unknown tag`() {
        val exchangeBlob = RelayV2CredentialBlob(
            credentialVersion = 0,
            issuerUrl = "https://relay.example.com",
            relayUrl = "wss://relay.example.com/client",
            hostId = "mac-admin",
            clientInstanceId = "android-install-1",
            pendingAttempt = RelayV2PendingCredentialAttempt(
                kind = RelayV2CredentialAttemptKind.ENROLLMENT_EXCHANGE,
                attemptId = "exchange-1",
                oldCredentialVersion = 0,
                secretReference = "enrollment-secret-1",
                secret = ENROLLMENT_CODE,
                enrollmentId = "enrollment-1",
            ),
        )
        val refreshBlob = RelayV2CredentialBlob(
            credentialVersion = 1,
            issuerUrl = "https://relay.example.com",
            relayUrl = "wss://relay.example.com/client",
            hostId = "mac-admin",
            clientInstanceId = "android-install-1",
            principalId = "principal-1",
            grantId = "grant-1",
            accessToken = ACCESS_TOKEN_1,
            accessExpiresAtMs = 2_000,
            refreshToken = REFRESH_TOKEN_1,
            refreshExpiresAtMs = 3_000,
            pendingAttempt = RelayV2PendingCredentialAttempt(
                kind = RelayV2CredentialAttemptKind.REFRESH,
                attemptId = "refresh-1",
                oldCredentialVersion = 1,
                secretReference = "refresh-secret-1",
                secret = REFRESH_TOKEN_1,
            ),
        )

        val exchangeBytes = RelayV2CredentialBlobCodec.encode(exchangeBlob)
        val refreshBytes = RelayV2CredentialBlobCodec.encode(refreshBlob)
        assertEquals(1, readPendingKindTag(exchangeBytes))
        assertEquals(2, readPendingKindTag(refreshBytes))
        assertEquals(
            RelayV2CredentialAttemptKind.ENROLLMENT_EXCHANGE,
            RelayV2CredentialBlobCodec.decode(exchangeBytes).pendingAttempt?.kind,
        )
        assertEquals(
            RelayV2CredentialAttemptKind.REFRESH,
            RelayV2CredentialBlobCodec.decode(refreshBytes).pendingAttempt?.kind,
        )

        val unknownTag = exchangeBytes.copyOf()
        ByteBuffer.wrap(unknownTag).putInt(pendingKindOffset(unknownTag), 99)
        assertTrue(runCatching { RelayV2CredentialBlobCodec.decode(unknownTag) }.isFailure)
    }

    @Test
    fun `enrollment is review only until confirmation and activation waits for disconnect barrier`() =
        runBlocking {
            val harness = Harness(blockDisconnect = true)
            val draft = enrollmentDraft()

            assertEquals(0, harness.exchange.redeemCalls)
            assertEquals(RelayProfileDialect.V1, harness.profiles.activeIdentity?.dialect)
            assertTrue(harness.credentials.isEmpty())

            val activation = async {
                harness.repository.confirmEnrollment(draft.confirm(deviceLabel = "Pixel"))
            }
            harness.barrier.started.await()

            assertEquals(1, harness.exchange.redeemCalls)
            assertEquals(RelayProfileDialect.V1, harness.profiles.activeIdentity?.dialect)
            assertEquals(0, harness.profiles.activationCount)
            assertFalse(harness.credentials.values().single().hasCredentialMaterial)

            harness.barrier.release.complete(Unit)
            val result = activation.await() as RelayV2EnrollmentResult.Activated
            val profile = result.profile

            assertEquals(RelayV2CredentialKind.TW_CAP2_GRANT, profile.credentialKind)
            assertEquals(RelayV2Profile.RELAY_V2_SUBPROTOCOL, profile.offeredSubprotocol)
            assertFalse(profile.autoConnect)
            assertEquals(
                listOf("exchange", "disconnect:start", "disconnect:end", "clear", "activate"),
                harness.events,
            )
            assertSame(harness.barrier.returnedReceipt, harness.isolationReceipts.single())

            val nonSensitivePersistence = harness.profiles.persistedValues.values.joinToString("|")
            assertFalse(nonSensitivePersistence.contains(ENROLLMENT_CODE))
            assertFalse(nonSensitivePersistence.contains(ACCESS_TOKEN_1))
            assertFalse(nonSensitivePersistence.contains(REFRESH_TOKEN_1))
            val secureBlob = harness.credentials.read(profile.credentialReference)
            assertEquals(ACCESS_TOKEN_1, secureBlob?.accessToken)
            assertEquals(REFRESH_TOKEN_1, secureBlob?.refreshToken)
        }

    @Test
    fun `disconnect receipt must match exactly and the validated proof reaches isolation unchanged`() =
        runBlocking {
            val mismatches = listOf<(
                RelayActiveProfileIdentity,
                String,
            ) -> RelayProfileDisconnectReceipt>(
                { profile, barrierId ->
                    RelayProfileDisconnectReceipt(
                        profile.copy(activationGeneration = profile.activationGeneration + 1),
                        barrierId,
                    )
                },
                { profile, barrierId ->
                    RelayProfileDisconnectReceipt(profile, "$barrierId-wrong")
                },
            )

            mismatches.forEach { mismatch ->
                val harness = Harness(disconnectReceipt = mismatch)

                assertTrue(
                    runCatching {
                        harness.repository.confirmEnrollment(
                            enrollmentDraft().confirm(deviceLabel = "Pixel"),
                        )
                    }.isFailure,
                )
                assertEquals(0, harness.isolationCalls)
                assertTrue(harness.isolationReceipts.isEmpty())
                assertEquals(0, harness.profiles.activationCount)
                assertEquals(RelayProfileDialect.V1, harness.profiles.activeIdentity?.dialect)
            }
        }

    @Test
    fun `newer confirmation immediately supersedes older activation in either response order`() =
        runBlocking {
            EnrollmentResponseOrder.entries.forEach { responseOrder ->
                val firstResponseArrivesFirst = responseOrder == EnrollmentResponseOrder.A_FIRST
                val harness = Harness()
                val firstGate = harness.exchange.deferEnrollment("enrollment-a")
                val secondGate = harness.exchange.deferEnrollment("enrollment-b")
                val first = async {
                    harness.repository.confirmEnrollment(
                        enrollmentDraft("enrollment-a", "twenroll2.code-a")
                            .confirm(deviceLabel = "Pixel A"),
                    )
                }
                val firstRequest = firstGate.request.await()
                val profileReadGate = if (firstResponseArrivesFirst) {
                    harness.profiles.blockNextActiveProfileRead()
                } else {
                    null
                }
                val second = async {
                    harness.repository.confirmEnrollment(
                        enrollmentDraft("enrollment-b", "twenroll2.code-b")
                            .confirm(deviceLabel = "Pixel B"),
                    )
                }
                profileReadGate?.started?.await()

                val (olderResult, winningProfile) = if (firstResponseArrivesFirst) {
                    firstGate.response.complete(enrollmentResponse(firstRequest, "a"))
                    val older = first.await()
                    assertTrue(older is RelayV2EnrollmentResult.Superseded)
                    assertEquals(0, harness.isolationCalls)
                    assertEquals(0, harness.profiles.activationCount)
                    requireNotNull(profileReadGate).release.complete(Unit)
                    val secondRequest = secondGate.request.await()
                    secondGate.response.complete(enrollmentResponse(secondRequest, "b"))
                    older to (second.await() as RelayV2EnrollmentResult.Activated).profile
                } else {
                    val secondRequest = secondGate.request.await()
                    secondGate.response.complete(enrollmentResponse(secondRequest, "b"))
                    val winner = (second.await() as RelayV2EnrollmentResult.Activated).profile
                    firstGate.response.complete(enrollmentResponse(firstRequest, "a"))
                    first.await() to winner
                }

                assertTrue(olderResult is RelayV2EnrollmentResult.Superseded)
                assertEquals(winningProfile, harness.profiles.activeV2)
                assertEquals(1, harness.barrier.calls)
                assertEquals(1, harness.isolationCalls)
                assertEquals(1, harness.profiles.activationCount)
                val winner = requireNotNull(
                    harness.credentials.read(winningProfile.credentialReference),
                )
                assertEquals("twcap2.access-b", winner.accessToken)
                assertEquals("twref2.refresh-b", winner.refreshToken)
                val loser = harness.credentials.values().single { !it.hasCredentialMaterial }
                assertEquals(0L, loser.credentialVersion)
                assertNotNull(loser.pendingAttempt)
            }

            val switched = Harness()
            val switchedGate = switched.exchange.deferEnrollment("enrollment-switch")
            val lateAfterSwitch = async {
                switched.repository.confirmEnrollment(
                    enrollmentDraft("enrollment-switch", "twenroll2.code-switch")
                        .confirm(deviceLabel = "Pixel"),
                )
            }
            val switchedRequest = switchedGate.request.await()
            val replacement = relayV2Profile().copy(profileId = "replacement-profile")
            assertEquals(
                replacement,
                switched.profiles.activateRelayV2Profile(
                    switched.profiles.activeIdentity,
                    replacement,
                    RelayV2ProfileActivationAuthority { activate ->
                        activate(RelayV2ProfileActivationCommit { true })
                    },
                ),
            )
            switchedGate.response.complete(enrollmentResponse(switchedRequest, "switched-late"))
            assertEquals(
                RelayV2EnrollmentResult.Superseded(replacement.identity),
                lateAfterSwitch.await(),
            )
            assertEquals(0, switched.barrier.calls)
            assertTrue(switched.credentials.values().single().hasCredentialMaterial.not())

            val cancelled = Harness()
            val cancelledGate = cancelled.exchange.deferEnrollment("enrollment-cancel")
            val cancelledConfirmation = enrollmentDraft(
                enrollmentId = "enrollment-cancel",
                enrollmentCode = "twenroll2.code-cancel",
            ).confirm(deviceLabel = "Pixel")
            val lateAfterCancel = async {
                cancelled.repository.confirmEnrollment(cancelledConfirmation)
            }
            val cancelledRequest = cancelledGate.request.await()
            assertTrue(cancelled.repository.cancelPendingEnrollment(cancelledConfirmation))
            assertFalse(cancelled.repository.cancelPendingEnrollment(cancelledConfirmation))
            cancelledGate.response.complete(
                enrollmentResponse(cancelledRequest, identitySuffix = "cancelled-late"),
            )
            assertEquals(
                RelayV2EnrollmentResult.Superseded(cancelled.profiles.activeIdentity),
                lateAfterCancel.await(),
            )
            assertEquals(RelayProfileDialect.V1, cancelled.profiles.activeIdentity?.dialect)
            assertEquals(0, cancelled.barrier.calls)
            assertEquals(0, cancelled.isolationCalls)
            assertEquals(0, cancelled.profiles.activationCount)
            assertTrue(cancelled.credentials.values().single().hasCredentialMaterial.not())
        }

    @Test
    fun `new confirmation supersedes response blocked in disconnect before isolation`() =
        runBlocking {
            val harness = Harness(blockDisconnect = true)
            val olderConfirmation = enrollmentDraft(
                "enrollment-disconnect-a",
                "twenroll2.code-disconnect-a",
            ).confirm(deviceLabel = "Pixel A")
            val newerGate = harness.exchange.deferEnrollment("enrollment-disconnect-b")
            val older = async { harness.repository.confirmEnrollment(olderConfirmation) }
            harness.barrier.started.await()
            assertFalse(harness.credentials.values().single().hasCredentialMaterial)

            val newer = async {
                harness.repository.confirmEnrollment(
                    enrollmentDraft(
                        "enrollment-disconnect-b",
                        "twenroll2.code-disconnect-b",
                    ).confirm(deviceLabel = "Pixel B"),
                )
            }
            val newerRequest = newerGate.request.await()
            assertFalse(harness.credentials.values().single {
                it.pendingAttempt?.enrollmentId == "enrollment-disconnect-a"
            }.hasCredentialMaterial)
            harness.barrier.release.complete(Unit)

            assertTrue(older.await() is RelayV2EnrollmentResult.Superseded)
            assertEquals(0, harness.isolationCalls)
            assertEquals(0, harness.profiles.activationCount)
            assertFalse(harness.credentials.values().single {
                it.pendingAttempt?.enrollmentId == "enrollment-disconnect-a"
            }.hasCredentialMaterial)

            newerGate.response.complete(enrollmentResponse(newerRequest, "disconnect-b"))
            val winner = (newer.await() as RelayV2EnrollmentResult.Activated).profile
            assertEquals(winner, harness.profiles.activeV2)
            assertEquals(1, harness.isolationCalls)
            assertEquals(1, harness.profiles.activationCount)
            assertSameReferenceRetryRedeems(
                harness = harness,
                confirmed = olderConfirmation,
                enrollmentId = "enrollment-disconnect-a",
                expectedActive = winner.identity,
            )
        }

    @Test
    fun `cancelled response blocked in disconnect leaves only its pending attempt`() =
        runBlocking {
            val harness = Harness(blockDisconnect = true)
            val confirmed = enrollmentDraft(
                "enrollment-disconnect-cancel",
                "twenroll2.code-disconnect-cancel",
            ).confirm(deviceLabel = "Pixel A")
            val pending = async { harness.repository.confirmEnrollment(confirmed) }
            harness.barrier.started.await()
            assertFalse(harness.credentials.values().single().hasCredentialMaterial)

            assertTrue(harness.repository.cancelPendingEnrollment(confirmed))
            harness.barrier.release.complete(Unit)

            assertTrue(pending.await() is RelayV2EnrollmentResult.Superseded)
            assertEquals(0, harness.isolationCalls)
            assertEquals(0, harness.profiles.activationCount)
            assertFalse(harness.credentials.values().single().hasCredentialMaterial)
            assertSameReferenceRetryRedeems(
                harness = harness,
                confirmed = confirmed,
                enrollmentId = "enrollment-disconnect-cancel",
                expectedActive = harness.profiles.activeIdentity,
            )
        }

    @Test
    fun `intent change at activation commit gate drops late credential material`() = runBlocking {
        CredentialCasInterleaving.entries.forEach { interleaving ->
            val harness = Harness()
            val commitGate = harness.profiles.blockNextActivationCommit()
            val olderConfirmation = enrollmentDraft(
                "enrollment-cas-a",
                "twenroll2.code-cas-a",
            ).confirm(deviceLabel = "Pixel A")
            val older = async { harness.repository.confirmEnrollment(olderConfirmation) }
            commitGate.started.await()

            val newer = when (interleaving) {
                CredentialCasInterleaving.CONFIRM_NEWER -> {
                    val newerGate = harness.exchange.deferEnrollment("enrollment-cas-b")
                    val pending = async {
                        harness.repository.confirmEnrollment(
                            enrollmentDraft(
                                "enrollment-cas-b",
                                "twenroll2.code-cas-b",
                            ).confirm(deviceLabel = "Pixel B"),
                        )
                    }
                    val newerRequest = newerGate.request.await()
                    assertFalse(harness.repository.cancelPendingEnrollment(olderConfirmation))
                    Pair(pending, newerGate to newerRequest)
                }
                CredentialCasInterleaving.CANCEL_OLDER -> {
                    assertTrue(harness.repository.cancelPendingEnrollment(olderConfirmation))
                    assertFalse(harness.repository.cancelPendingEnrollment(olderConfirmation))
                    null
                }
            }

            commitGate.release.complete(Unit)
            assertTrue(older.await() is RelayV2EnrollmentResult.Superseded)
            val olderBlob = harness.credentials.values().single {
                it.pendingAttempt?.enrollmentId == "enrollment-cas-a"
            }
            assertEquals(0L, olderBlob.credentialVersion)
            assertFalse(olderBlob.hasCredentialMaterial)
            assertEquals(null, olderBlob.accessToken)
            assertEquals(null, olderBlob.refreshToken)

            if (newer != null) {
                val (pending, exchange) = newer
                val (newerGate, newerRequest) = exchange
                newerGate.response.complete(enrollmentResponse(newerRequest, "cas-b"))
                val winner = (pending.await() as RelayV2EnrollmentResult.Activated).profile
                assertEquals(winner, harness.profiles.activeV2)
                assertEquals(
                    "twcap2.access-cas-b",
                    harness.credentials.read(winner.credentialReference)?.accessToken,
                )
            } else {
                assertEquals(RelayProfileDialect.V1, harness.profiles.activeIdentity?.dialect)
                assertEquals(0, harness.profiles.activationCount)
            }
        }
    }

    @Test
    fun `activation failure after credential CAS compensates the exact completed blob`() =
        runBlocking {
            val harness = Harness()
            val confirmed = enrollmentDraft(
                "enrollment-compensate",
                "twenroll2.code-compensate",
            ).confirm(deviceLabel = "Pixel")
            harness.profiles.failNextActivationAfterCredentialCommit = true

            assertTrue(runCatching {
                harness.repository.confirmEnrollment(confirmed)
            }.isFailure)
            assertTrue(harness.credentials.isEmpty())
            assertEquals(RelayProfileDialect.V1, harness.profiles.activeIdentity?.dialect)
            assertEquals(0, harness.profiles.activationCount)

            val recovered = harness.repository.confirmEnrollment(confirmed)
                as RelayV2EnrollmentResult.Activated
            assertEquals(2, harness.exchange.redeemCalls)
            assertEquals(recovered.profile, harness.profiles.activeV2)
            assertTrue(harness.credentials.values().single().hasCredentialMaterial)
        }

    @Test
    fun `same reference and pending attempt exact replay has one credential and activation winner`() =
        runBlocking {
            val harness = Harness()
            val gate = harness.exchange.deferEnrollment("enrollment-replay")
            val confirmed = enrollmentDraft(
                "enrollment-replay",
                "twenroll2.code-replay",
            ).confirm(deviceLabel = "Pixel")
            val first = async { harness.repository.confirmEnrollment(confirmed) }
            val firstRequest = gate.request.await()
            val replay = async { harness.repository.confirmEnrollment(confirmed) }
            val replayRequest = gate.replayRequest.await()

            assertEquals(firstRequest, replayRequest)
            gate.response.complete(enrollmentResponse(firstRequest, "replay"))
            val results = listOf(first.await(), replay.await())

            assertEquals(1, results.count { it is RelayV2EnrollmentResult.Activated })
            assertEquals(1, results.count { it is RelayV2EnrollmentResult.StaleCredentialResponse })
            assertFalse(results.any { it is RelayV2EnrollmentResult.Superseded })
            assertEquals(2, harness.exchange.redeemCalls)
            assertEquals(1, harness.profiles.activationCount)
            assertEquals(1L, harness.credentials.values().single().credentialVersion)
        }

    @Test
    fun `late refresh response cannot roll credential version or tokens back`() = runBlocking {
        val harness = Harness()
        val activated = harness.repository.confirmEnrollment(
            enrollmentDraft().confirm(deviceLabel = "Pixel"),
        ) as RelayV2EnrollmentResult.Activated

        val first = harness.repository.prepareRefresh(activated.profile)
        val firstResponse = refreshResponse(first, version = 2)
        assertEquals(
            RelayV2RefreshApplyResult.Applied(2, repairedProfileVersion = true),
            harness.repository.applyRefreshResponse(first, firstResponse),
        )

        val profileAtVersionTwo = requireNotNull(harness.profiles.activeV2)
        val second = harness.repository.prepareRefresh(profileAtVersionTwo)
        val secondResponse = refreshResponse(second, version = 3)
        assertEquals(
            RelayV2RefreshApplyResult.Applied(3, repairedProfileVersion = true),
            harness.repository.applyRefreshResponse(second, secondResponse),
        )

        assertEquals(
            RelayV2RefreshApplyResult.StaleCredentialResponse(3),
            harness.repository.applyRefreshResponse(first, firstResponse),
        )
        val winner = harness.credentials.read(activated.profile.credentialReference)
        assertEquals(3L, winner?.credentialVersion)
        assertEquals("twcap2.access-3", winner?.accessToken)
        assertEquals("twref2.refresh-3", winner?.refreshToken)
        assertEquals(3L, harness.profiles.activeV2?.credentialVersion)
    }

    @Test
    fun `credential reconciliation repairs ahead blob and fails closed on invalid monotonic state`() =
        runBlocking {
            val ahead = Harness()
            val activated = ahead.repository.confirmEnrollment(
                enrollmentDraft().confirm(deviceLabel = "Pixel"),
            ) as RelayV2EnrollmentResult.Activated
            val versionOneBlob = requireNotNull(
                ahead.credentials.read(activated.profile.credentialReference),
            )
            assertEquals(
                RelayV2CredentialCasResult.Updated(2),
                ahead.credentials.compareAndSet(
                    activated.profile.credentialReference,
                    versionOneBlob.expectation(),
                    versionOneBlob.copy(credentialVersion = 2),
                ),
            )

            assertEquals(
                RelayV2CredentialReconciliationResult.Repaired(
                    activated.profile.copy(credentialVersion = 2),
                ),
                ahead.repository.reconcileActiveCredential(),
            )
            assertEquals(
                RelayV2CredentialReconciliationResult.InSync(
                    activated.profile.copy(credentialVersion = 2),
                ),
                ahead.repository.reconcileActiveCredential(),
            )

            assertTrue(
                ahead.profiles.updateRelayV2CredentialVersion(
                    profileId = activated.profile.profileId,
                    credentialReference = activated.profile.credentialReference,
                    expectedActivationGeneration = activated.profile.activationGeneration,
                    expectedVersion = 2,
                    newVersion = 3,
                ),
            )
            val behind = ahead.repository.reconcileActiveCredential()
                as RelayV2CredentialReconciliationResult.Failed
            assertEquals(
                RelayV2CredentialReconciliationFailure.CREDENTIAL_BLOB_BEHIND_PROFILE,
                behind.failure,
            )

            val mismatched = Harness()
            val mismatchedActivation = mismatched.repository.confirmEnrollment(
                enrollmentDraft().confirm(deviceLabel = "Pixel"),
            ) as RelayV2EnrollmentResult.Activated
            val boundBlob = requireNotNull(
                mismatched.credentials.read(mismatchedActivation.profile.credentialReference),
            )
            assertEquals(
                RelayV2CredentialCasResult.Updated(1),
                mismatched.credentials.compareAndSet(
                    mismatchedActivation.profile.credentialReference,
                    boundBlob.expectation(),
                    boundBlob.copy(hostId = "different-host"),
                ),
            )
            val bindingFailure = mismatched.repository.reconcileActiveCredential()
                as RelayV2CredentialReconciliationResult.Failed
            assertEquals(
                RelayV2CredentialReconciliationFailure.BINDING_MISMATCH,
                bindingFailure.failure,
            )
        }

    @Test
    fun `refresh reports metadata failure and fences the same target at a new generation`() =
        runBlocking {
            val rejected = Harness()
            val rejectedActivation = rejected.repository.confirmEnrollment(
                enrollmentDraft().confirm(deviceLabel = "Pixel"),
            ) as RelayV2EnrollmentResult.Activated
            val rejectedRefresh = rejected.repository.prepareRefresh(rejectedActivation.profile)
            rejected.profiles.failNextCredentialVersionUpdate = true

            val rejectedResult = rejected.repository.applyRefreshResponse(
                rejectedRefresh,
                refreshResponse(rejectedRefresh, version = 2),
            ) as RelayV2RefreshApplyResult.ProfileReconciliationFailed
            assertEquals(2L, rejectedResult.credentialVersion)
            assertEquals(
                RelayV2CredentialReconciliationFailure.PROFILE_VERSION_UPDATE_REJECTED,
                rejectedResult.failure.failure,
            )
            assertEquals(1L, rejected.profiles.activeV2?.credentialVersion)

            val switched = Harness()
            val oldActivation = switched.repository.confirmEnrollment(
                enrollmentDraft().confirm(deviceLabel = "Pixel"),
            ) as RelayV2EnrollmentResult.Activated
            val lateRefresh = switched.repository.prepareRefresh(oldActivation.profile)
            val replacement = oldActivation.profile.copy(
                activationGeneration = oldActivation.profile.activationGeneration + 1,
            )
            assertEquals(oldActivation.profile.profileId, replacement.profileId)
            assertEquals(
                oldActivation.profile.credentialReference,
                replacement.credentialReference,
            )
            assertEquals(
                replacement,
                switched.profiles.activateRelayV2Profile(
                    expectedActiveProfile = oldActivation.profile.identity,
                    profile = replacement,
                    authority = RelayV2ProfileActivationAuthority { activate ->
                        activate(RelayV2ProfileActivationCommit { true })
                    },
                ),
            )
            val activationCountBeforeResponse = switched.profiles.activationCount

            assertEquals(
                RelayV2RefreshApplyResult.ActiveProfileChanged(
                    credentialVersion = null,
                    activeProfile = replacement.identity,
                ),
                switched.repository.applyRefreshResponse(
                    lateRefresh,
                    refreshResponse(lateRefresh, version = 2),
                ),
            )
            assertEquals(replacement, switched.profiles.activeV2)
            assertEquals(activationCountBeforeResponse, switched.profiles.activationCount)
            assertEquals(
                1L,
                switched.credentials.read(oldActivation.profile.credentialReference)?.credentialVersion,
            )
        }

    @Test
    fun `reconfirming same profile and credential is a no-op that keeps callback fence`() =
        runBlocking {
            val harness = Harness()
            val confirmed = enrollmentDraft().confirm(deviceLabel = "Pixel")
            val first = harness.repository.confirmEnrollment(confirmed) as RelayV2EnrollmentResult.Activated
            val firstIdentity = first.profile.identity
            val barrierCalls = harness.barrier.calls
            val isolationCalls = harness.isolationCalls
            val activationCalls = harness.profiles.activationCount

            val repeated = harness.repository.confirmEnrollment(confirmed) as RelayV2EnrollmentResult.Activated

            assertEquals(1, harness.exchange.redeemCalls)
            assertEquals(barrierCalls, harness.barrier.calls)
            assertEquals(isolationCalls, harness.isolationCalls)
            assertEquals(activationCalls, harness.profiles.activationCount)
            assertEquals(firstIdentity, repeated.profile.identity)
            assertNotNull(harness.credentials.read(first.profile.credentialReference))
            assertTrue(
                harness.profileSwitch.accepts(
                    RelayProfileCallbackScope(
                        profileId = firstIdentity.profileId,
                        activationGeneration = firstIdentity.activationGeneration,
                    ),
                ),
            )
            assertFalse(
                harness.profileSwitch.accepts(
                    RelayProfileCallbackScope(
                        profileId = firstIdentity.profileId,
                        activationGeneration = firstIdentity.activationGeneration - 1,
                    ),
                ),
            )
            assertFalse(
                harness.profileSwitch.accepts(
                    RelayProfileCallbackScope(
                        profileId = "legacy-v1",
                        activationGeneration = 0,
                    ),
                ),
            )

            val currentBlob = requireNotNull(
                harness.credentials.read(first.profile.credentialReference),
            )
            assertEquals(
                RelayV2CredentialCasResult.Updated(2),
                harness.credentials.compareAndSet(
                    first.profile.credentialReference,
                    RelayV2CredentialCasExpectation(
                        credentialVersion = 1,
                        pendingAttemptId = null,
                        pendingSecretReference = null,
                    ),
                    currentBlob.copy(credentialVersion = 2),
                ),
            )
            harness.profiles.failNextCredentialVersionUpdate = true
            assertTrue(runCatching { harness.repository.confirmEnrollment(confirmed) }.isFailure)
            assertEquals(1L, harness.profiles.activeV2?.credentialVersion)
            assertNotNull(harness.credentials.read(first.profile.credentialReference))
            assertEquals(isolationCalls, harness.isolationCalls)
        }

    private class Harness(
        blockDisconnect: Boolean = false,
        disconnectReceipt: ((RelayActiveProfileIdentity, String) -> RelayProfileDisconnectReceipt)? = null,
    ) {
        val events = mutableListOf<String>()
        val credentials = MemoryCredentialStore()
        val profiles = MemoryProfileStore(events)
        val barrier = RecordingDisconnectBarrier(events, blockDisconnect, disconnectReceipt)
        var isolationCalls = 0
        val isolationReceipts = mutableListOf<RelayProfileDisconnectReceipt>()
        private val ids = AtomicInteger()
        private val idFactory = { "test-${ids.incrementAndGet()}" }
        val exchange = FakeCredentialExchange(events)
        val profileSwitch = RelayV2ProfileSwitchStateMachine(
            profileStore = profiles,
            disconnectBarrier = barrier,
            isolationBoundary = RelayProfileIsolationBoundary { receipt ->
                isolationCalls += 1
                isolationReceipts += receipt
                events += "clear"
                // Model the real boundary's credential deletion responsibility. If the state
                // machine calls this for the same target, this deliberately removes that target.
                profiles.activeV2
                    ?.takeIf { it.identity == receipt.profile }
                    ?.let { credentials.clear(it.credentialReference) }
            },
            newId = idFactory,
        )
        val repository = RelayV2ProfileRepository(
            credentialStore = credentials,
            profileStore = profiles,
            profileSwitch = profileSwitch,
            exchange = exchange,
            clientInstanceId = "android-install-1",
            newId = idFactory,
        )
    }

    private class MemoryCredentialStore : RelayV2CredentialStore {
        private val blobs = linkedMapOf<RelayV2CredentialReference, RelayV2CredentialBlob>()

        @Synchronized
        override fun read(reference: RelayV2CredentialReference): RelayV2CredentialBlob? =
            blobs[reference]

        @Synchronized
        override fun create(
            reference: RelayV2CredentialReference,
            blob: RelayV2CredentialBlob,
        ): Boolean {
            if (reference in blobs) return false
            blobs[reference] = blob
            return true
        }

        @Synchronized
        override fun compareAndSet(
            reference: RelayV2CredentialReference,
            expectation: RelayV2CredentialCasExpectation,
            replacement: RelayV2CredentialBlob,
        ): RelayV2CredentialCasResult = compareAndSetLocked(reference, expectation, replacement)

        @Synchronized
        override fun clearIfUnchanged(
            reference: RelayV2CredentialReference,
            expected: RelayV2CredentialBlob,
        ): Boolean {
            if (blobs[reference] != expected) return false
            blobs.remove(reference)
            return true
        }

        private fun compareAndSetLocked(
            reference: RelayV2CredentialReference,
            expectation: RelayV2CredentialCasExpectation,
            replacement: RelayV2CredentialBlob,
        ): RelayV2CredentialCasResult {
            val current = blobs[reference]
                ?: return RelayV2CredentialCasResult.Stale(null)
            if (!current.matchesExpectation(expectation)) {
                return RelayV2CredentialCasResult.Stale(current.credentialVersion)
            }
            require(replacement.credentialVersion >= current.credentialVersion)
            blobs[reference] = replacement
            return RelayV2CredentialCasResult.Updated(replacement.credentialVersion)
        }

        private fun RelayV2CredentialBlob.matchesExpectation(
            expectation: RelayV2CredentialCasExpectation,
        ): Boolean = credentialVersion == expectation.credentialVersion &&
            pendingAttempt?.attemptId == expectation.pendingAttemptId &&
            pendingAttempt?.secretReference == expectation.pendingSecretReference

        @Synchronized
        override fun clear(reference: RelayV2CredentialReference) {
            blobs.remove(reference)
        }

        fun isEmpty(): Boolean = blobs.isEmpty()
        @Synchronized
        fun values(): List<RelayV2CredentialBlob> = blobs.values.toList()
    }

    private class MemoryProfileStore(
        private val events: MutableList<String>,
    ) : RelayV2ProfileStore {
        var activeIdentity: RelayActiveProfileIdentity? = RelayActiveProfileIdentity(
            profileId = "legacy-v1",
            dialect = RelayProfileDialect.V1,
            activationGeneration = 0,
        )
        var activeV2: RelayV2Profile? = null
        var activationCount = 0
        var failNextCredentialVersionUpdate = false
        var failNextActivationAfterCredentialCommit = false
        var persistedValues: Map<String, Any> = emptyMap()
        private var nextActiveProfileReadGate: SuspensionGate? = null
        private var nextActivationCommitGate: SuspensionGate? = null

        fun blockNextActiveProfileRead(): SuspensionGate = SuspensionGate().also {
            check(nextActiveProfileReadGate == null)
            nextActiveProfileReadGate = it
        }

        fun blockNextActivationCommit(): SuspensionGate = SuspensionGate().also {
            check(nextActivationCommitGate == null)
            nextActivationCommitGate = it
        }

        override suspend fun activeProfileIdentity(): RelayActiveProfileIdentity? {
            nextActiveProfileReadGate?.also {
                nextActiveProfileReadGate = null
                it.started.complete(Unit)
                it.release.await()
            }
            return activeIdentity
        }

        override suspend fun activeRelayV2Profile(): RelayV2Profile? = activeV2

        override suspend fun activateRelayV2Profile(
            expectedActiveProfile: RelayActiveProfileIdentity?,
            profile: RelayV2Profile,
            authority: RelayV2ProfileActivationAuthority,
        ): RelayV2Profile? {
            nextActivationCommitGate?.also {
                nextActivationCommitGate = null
                it.started.complete(Unit)
                it.release.await()
            }
            return authority.commitIfCurrent { commit ->
                if (activeIdentity != expectedActiveProfile) return@commitIfCurrent null
                val current = activeV2
                val sameActivation = current?.identity == profile.identity &&
                    current.credentialReference == profile.credentialReference
                if (current != null &&
                    sameActivation &&
                    profile.credentialVersion > current.credentialVersion &&
                    failNextCredentialVersionUpdate
                ) {
                    failNextCredentialVersionUpdate = false
                    error("Relay v2 credential version update was rejected")
                }
                val resolved = if (sameActivation) {
                    requireNotNull(current).copy(
                        credentialVersion = maxOf(
                            current.credentialVersion,
                            profile.credentialVersion,
                        ),
                    )
                } else {
                    profile
                }
                if (!commit.commitCredential()) return@commitIfCurrent null
                if (failNextActivationAfterCredentialCommit) {
                    failNextActivationAfterCredentialCommit = false
                    error("Relay v2 profile activation failed after credential commit")
                }
                if (!sameActivation) {
                    activationCount += 1
                    events += "activate"
                }
                activeV2 = resolved
                activeIdentity = resolved.identity
                persistedValues = mapOf(
                    "profileId" to resolved.profileId,
                    "issuerUrl" to resolved.issuerUrl,
                    "relayUrl" to resolved.relayUrl,
                    "hostId" to resolved.hostId,
                    "principalId" to resolved.principalId,
                    "grantId" to resolved.grantId,
                    "clientInstanceId" to resolved.clientInstanceId,
                    "credentialReference" to resolved.credentialReference.value,
                    "credentialVersion" to resolved.credentialVersion,
                    "activationGeneration" to resolved.activationGeneration,
                    "credentialKind" to "twcap2_grant",
                    "offeredSubprotocol" to resolved.offeredSubprotocol,
                )
                resolved
            }
        }

        override suspend fun updateRelayV2CredentialVersion(
            profileId: String,
            credentialReference: RelayV2CredentialReference,
            expectedActivationGeneration: Long,
            expectedVersion: Long,
            newVersion: Long,
        ): Boolean {
            if (failNextCredentialVersionUpdate) {
                failNextCredentialVersionUpdate = false
                return false
            }
            val current = activeV2 ?: return false
            if (current.profileId != profileId ||
                current.credentialReference != credentialReference ||
                current.activationGeneration != expectedActivationGeneration ||
                current.credentialVersion != expectedVersion
            ) return false
            val updated = current.copy(credentialVersion = newVersion)
            activeV2 = updated
            activeIdentity = updated.identity
            persistedValues = persistedValues + ("credentialVersion" to newVersion)
            return true
        }
    }

    private class RecordingDisconnectBarrier(
        private val events: MutableList<String>,
        blocked: Boolean,
        private val receiptFactory: ((
            RelayActiveProfileIdentity,
            String,
        ) -> RelayProfileDisconnectReceipt)?,
    ) : RelayProfileDisconnectBarrier {
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        var calls = 0
        var returnedReceipt: RelayProfileDisconnectReceipt? = null

        init {
            if (!blocked) release.complete(Unit)
        }

        override suspend fun disconnectAndDrain(
            profile: RelayActiveProfileIdentity,
            barrierId: String,
        ): RelayProfileDisconnectReceipt {
            calls += 1
            events += "disconnect:start"
            started.complete(Unit)
            release.await()
            events += "disconnect:end"
            return (receiptFactory?.invoke(profile, barrierId)
                ?: RelayProfileDisconnectReceipt(profile, barrierId)).also {
                returnedReceipt = it
            }
        }
    }

    private class FakeCredentialExchange(
        private val events: MutableList<String>,
    ) : RelayV2CredentialExchange {
        var redeemCalls = 0
        private val deferredRedeems = linkedMapOf<String, DeferredRedeem>()

        fun deferEnrollment(enrollmentId: String): DeferredRedeem = DeferredRedeem().also {
            check(deferredRedeems.put(enrollmentId, it) == null)
        }

        override suspend fun redeem(
            request: RelayV2EnrollmentExchangeRequest,
        ): RelayV2EnrollmentExchangeResponse {
            redeemCalls += 1
            events += "exchange"
            deferredRedeems[request.enrollmentId]?.let { deferred ->
                deferred.record(request)
                return deferred.response.await()
            }
            return RelayV2EnrollmentExchangeResponse(
                exchangeAttemptId = request.exchangeAttemptId,
                principalId = "principal-1",
                grantId = "grant-1",
                hostId = "mac-admin",
                relayUrl = "wss://relay.example.com/client",
                accessToken = ACCESS_TOKEN_1,
                accessExpiresAtMs = 2_000,
                refreshToken = REFRESH_TOKEN_1,
                refreshExpiresAtMs = 3_000,
            )
        }

        override suspend fun refresh(request: RelayV2RefreshRequest): RelayV2RefreshResponse =
            error("No production or fake refresh call is needed by these state-machine cases")
    }

    private class DeferredRedeem {
        val request = CompletableDeferred<RelayV2EnrollmentExchangeRequest>()
        val replayRequest = CompletableDeferred<RelayV2EnrollmentExchangeRequest>()
        val response = CompletableDeferred<RelayV2EnrollmentExchangeResponse>()

        fun record(value: RelayV2EnrollmentExchangeRequest) {
            if (!request.complete(value)) replayRequest.complete(value)
        }
    }

    private class SuspensionGate {
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
    }

    private suspend fun assertSameReferenceRetryRedeems(
        harness: Harness,
        confirmed: RelayV2ConfirmedEnrollment,
        enrollmentId: String,
        expectedActive: RelayActiveProfileIdentity?,
    ) = coroutineScope {
        val pendingBeforeRetry = harness.credentials.values().single {
            it.pendingAttempt?.enrollmentId == enrollmentId
        }
        val redeemCallsBeforeRetry = harness.exchange.redeemCalls
        val retryGate = harness.exchange.deferEnrollment(enrollmentId)
        val retry = async { harness.repository.confirmEnrollment(confirmed) }
        val retryRequest = withTimeout(1_000) { retryGate.request.await() }

        assertEquals(redeemCallsBeforeRetry + 1, harness.exchange.redeemCalls)
        assertEquals(pendingBeforeRetry.pendingAttempt?.attemptId, retryRequest.exchangeAttemptId)
        assertTrue(harness.repository.cancelPendingEnrollment(confirmed))
        retryGate.response.complete(enrollmentResponse(retryRequest, "cancelled-retry"))
        assertTrue(retry.await() is RelayV2EnrollmentResult.Superseded)
        assertEquals(pendingBeforeRetry, harness.credentials.values().single {
            it.pendingAttempt?.enrollmentId == enrollmentId
        })
        assertFalse(pendingBeforeRetry.hasCredentialMaterial)
        assertEquals(expectedActive, harness.profiles.activeIdentity)
    }

    private enum class EnrollmentResponseOrder {
        A_FIRST,
        B_FIRST,
    }

    private enum class CredentialCasInterleaving {
        CONFIRM_NEWER,
        CANCEL_OLDER,
    }

    private fun relayV2Profile(): RelayV2Profile = RelayV2Profile(
        profileId = "relay-v2-profile-1",
        issuerUrl = "https://relay.example.com",
        relayUrl = "wss://relay.example.com/client",
        hostId = "mac-admin",
        principalId = "principal-1",
        grantId = "grant-1",
        clientInstanceId = "android-install-1",
        credentialReference = RelayV2CredentialReference("credential-reference-1"),
        credentialVersion = 4,
        activationGeneration = 7,
    )

    private fun Preferences.valueNamed(name: String): Any? =
        asMap().entries.singleOrNull { it.key.name == name }?.value

    private fun Preferences.namedValues(): Map<String, Any> =
        asMap().entries.associate { it.key.name to it.value }

    private fun RelayV2CredentialBlob.expectation(): RelayV2CredentialCasExpectation =
        RelayV2CredentialCasExpectation(
            credentialVersion = credentialVersion,
            pendingAttemptId = pendingAttempt?.attemptId,
            pendingSecretReference = pendingAttempt?.secretReference,
        )

    private fun enrollmentDraft(
        enrollmentId: String = "enrollment-1",
        enrollmentCode: String = ENROLLMENT_CODE,
    ): RelayV2EnrollmentReviewDraft =
        requireNotNull(
            RelayV2EnrollmentReviewParser.parse(
                "tmuxworktree://enroll?v=2" +
                    "&issuerUrl=https%3A%2F%2Frelay.example.com" +
                    "&relayUrl=wss%3A%2F%2Frelay.example.com%2Fclient" +
                    "&hostId=mac-admin" +
                    "&enrollmentId=$enrollmentId" +
                    "&enrollmentCode=$enrollmentCode",
            ),
        )

    private fun enrollmentResponse(
        request: RelayV2EnrollmentExchangeRequest,
        identitySuffix: String,
    ): RelayV2EnrollmentExchangeResponse = RelayV2EnrollmentExchangeResponse(
        exchangeAttemptId = request.exchangeAttemptId,
        principalId = "principal-$identitySuffix",
        grantId = "grant-$identitySuffix",
        hostId = "mac-admin",
        relayUrl = "wss://relay.example.com/client",
        accessToken = "twcap2.access-$identitySuffix",
        accessExpiresAtMs = 2_000,
        refreshToken = "twref2.refresh-$identitySuffix",
        refreshExpiresAtMs = 3_000,
    )

    private fun refreshResponse(
        prepared: RelayV2PreparedRefresh,
        version: Int,
    ): RelayV2RefreshResponse = RelayV2RefreshResponse(
        refreshAttemptId = prepared.request.refreshAttemptId,
        principalId = "principal-1",
        grantId = "grant-1",
        hostId = "mac-admin",
        relayUrl = "wss://relay.example.com/client",
        accessToken = "twcap2.access-$version",
        accessExpiresAtMs = 2_000L + version,
        refreshToken = "twref2.refresh-$version",
        refreshExpiresAtMs = 3_000L + version,
    )

    private fun readPendingKindTag(bytes: ByteArray): Int {
        val input = ByteArrayInputStream(bytes)
        val data = DataInputStream(input)
        skipCredentialPrefix(data)
        return data.readInt()
    }

    private fun pendingKindOffset(bytes: ByteArray): Int {
        val input = ByteArrayInputStream(bytes)
        skipCredentialPrefix(DataInputStream(input))
        return bytes.size - input.available()
    }

    private fun skipCredentialPrefix(data: DataInputStream) {
        data.readInt()
        data.readLong()
        repeat(4) { data.skipBoundedString() }
        repeat(3) { data.skipNullableString() }
        data.skipNullableLong()
        data.skipNullableString()
        data.skipNullableLong()
        assertTrue(data.readBoolean())
    }

    private fun DataInputStream.skipBoundedString() {
        val size = readInt()
        assertEquals(size, skipBytes(size))
    }

    private fun DataInputStream.skipNullableString() {
        if (readBoolean()) skipBoundedString()
    }

    private fun DataInputStream.skipNullableLong() {
        if (readBoolean()) readLong()
    }

    private companion object {
        const val ENROLLMENT_CODE = "twenroll2.one-time-code"
        const val ACCESS_TOKEN_1 = "twcap2.access-1"
        const val REFRESH_TOKEN_1 = "twref2.refresh-1"
    }
}
