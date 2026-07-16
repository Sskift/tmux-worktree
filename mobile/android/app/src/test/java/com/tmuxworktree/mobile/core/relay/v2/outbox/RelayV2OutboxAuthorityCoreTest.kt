package com.tmuxworktree.mobile.core.relay.v2.outbox

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RelayV2OutboxAuthorityCoreTest {
    private val core = RelayV2OutboxAuthorityCore()

    @Test
    fun `canonical intent binds full identity fingerprint schema and server-independent ordering`() {
        var state = RelayV2OutboxState.empty()
        state = enqueue(
            state,
            draft(
                commandId = "command-later-clock",
                arguments = RelayV2OutboxArguments.sendAgentMessage(
                    pane = 0,
                    message = "first\r\nsecond\rthird",
                    submit = true,
                ),
            ),
            createdAtMillis = 9_000,
        ).state
        state = enqueue(
            state,
            draft(commandId = "command-earlier-clock"),
            createdAtMillis = 1,
        ).state

        val first = state.entries[0]
        val second = state.entries[1]
        assertEquals("command-later-clock", first.commandId)
        assertEquals(0L, first.createdOrder)
        assertEquals(1L, second.createdOrder)
        assertEquals(
            "{\"message\":\"first\\nsecond\\nthird\",\"pane\":0,\"submit\":true}",
            first.canonicalRequestArguments.canonicalJson,
        )
        assertEquals(
            first.canonicalRequestArguments.utf8ByteCount,
            first.canonicalRequestArguments.utf8Bytes().size,
        )
        assertEquals(1, first.requestFingerprint.schemaVersion)
        assertEquals(64, first.requestFingerprint.sha256Hex.length)
        assertEquals("profile-a", first.profileId)
        assertEquals("principal-a", first.principalId)
        assertEquals("host-a", first.hostId)
        assertEquals("epoch-a", first.expectedHostEpoch)
        assertEquals("window-a", first.dedupeWindowId)
        assertEquals("scope-a", first.scopeId)
        assertEquals("session-a", first.sessionId)
        assertTrue(first.canonicalByteCount <= RelayV2OutboxLimits.MAX_ENTRY_CANONICAL_BYTES)
        assertTrue(state.canonicalByteCount <= RelayV2OutboxLimits.MAX_STATE_CANONICAL_BYTES)

        val sameIntentDifferentClientTime = enqueue(
            RelayV2OutboxState.empty(),
            draft(
                commandId = "another-command",
                arguments = RelayV2OutboxArguments.sendAgentMessage(
                    pane = 0,
                    message = "first\nsecond\nthird",
                    submit = true,
                ),
            ),
            createdAtMillis = 0,
        ).state.entries.single()
        assertEquals(
            first.requestFingerprint.sha256Hex,
            sameIntentDifferentClientTime.requestFingerprint.sha256Hex,
        )
    }

    @Test
    fun `frozen legal transitions converge attempted and late ambiguous entries`() {
        listOf(
            RelayV2CommandStatusState.SUCCEEDED to RelayV2OutboxStateTag.SUCCEEDED,
            RelayV2CommandStatusState.FAILED to RelayV2OutboxStateTag.FAILED_FINAL,
        ).forEach { (status, expected) ->
            listOf(
                sourceState(RelayV2OutboxStateTag.SENDING),
                sourceState(RelayV2OutboxStateTag.ACCEPTED),
                sourceState(RelayV2OutboxStateTag.CONFIRMING),
                sourceState(RelayV2OutboxStateTag.AMBIGUOUS),
            ).forEach { source ->
                val entry = source.entries.first { it.commandId == "command-a" }
                val result = applied(
                    core.reduce(
                        source,
                        RelayV2OutboxAction.ReconcileStatus(
                            terminalEvidence(entry, status),
                        ),
                    ),
                )
                assertEquals("$status from ${entry.state}", expected, result.state.entry(entry.id)?.state)
            }
        }

        listOf(
            RelayV2CommandStatusState.IN_DOUBT,
            RelayV2CommandStatusState.EXPIRED,
            RelayV2CommandStatusState.UNKNOWN,
        ).forEach { status ->
            listOf(
                RelayV2OutboxStateTag.SENDING,
                RelayV2OutboxStateTag.ACCEPTED,
                RelayV2OutboxStateTag.CONFIRMING,
            ).forEach { sourceTag ->
                val source = sourceState(sourceTag)
                val entry = source.entries.first { it.commandId == "command-a" }
                val result = applied(
                    core.reduce(
                        source,
                        RelayV2OutboxAction.ReconcileStatus(
                            terminalEvidence(entry, status),
                        ),
                    ),
                )
                assertEquals(
                    "$status from $sourceTag",
                    RelayV2OutboxStateTag.AMBIGUOUS,
                    result.state.entry(entry.id)?.state,
                )
            }
        }

        var sending = sourceState(RelayV2OutboxStateTag.SENDING)
        var entry = sending.entries.first { it.commandId == "command-a" }
        sending = applied(
            core.reduce(
                sending,
                RelayV2OutboxAction.ReconcileStatus(
                    acceptedEvidence(entry, RelayV2CommandStatusState.ACCEPTED),
                ),
            ),
        ).state
        entry = sending.entries.first { it.commandId == "command-a" }
        assertEquals(RelayV2OutboxStateTag.ACCEPTED, entry.state)
        assertEquals(RelayV2OutboxAcceptanceEvidence.DURABLE, entry.acceptanceEvidence)

        val running = applied(
            core.reduce(
                sending,
                RelayV2OutboxAction.ReconcileStatus(
                    acceptedEvidence(entry, RelayV2CommandStatusState.RUNNING),
                ),
            ),
        ).state.entry(entry.id)
        assertEquals(RelayV2OutboxStateTag.CONFIRMING, running?.state)

        val directRunningSource = sourceState(RelayV2OutboxStateTag.SENDING)
        val directRunningEntry = directRunningSource.entries.single()
        val directRunning = applied(
            core.reduce(
                directRunningSource,
                RelayV2OutboxAction.ReconcileStatus(
                    acceptedEvidence(directRunningEntry, RelayV2CommandStatusState.RUNNING),
                ),
            ),
        ).state.entry(directRunningEntry.id)
        assertEquals(RelayV2OutboxStateTag.CONFIRMING, directRunning?.state)
        assertEquals(RelayV2OutboxAcceptanceEvidence.DURABLE, directRunning?.acceptanceEvidence)
    }

    @Test
    fun `illegal transition table leaves queued final reissued and ambiguous authority unchanged`() {
        val illegal = listOf(
            IllegalCase(
                sourceState(RelayV2OutboxStateTag.QUEUED),
                RelayV2CommandStatusState.ACCEPTED,
            ),
            IllegalCase(
                sourceState(RelayV2OutboxStateTag.SUCCEEDED),
                RelayV2CommandStatusState.UNKNOWN,
            ),
            IllegalCase(
                sourceState(RelayV2OutboxStateTag.FAILED_FINAL),
                RelayV2CommandStatusState.SUCCEEDED,
            ),
            IllegalCase(
                sourceState(RelayV2OutboxStateTag.REISSUED),
                RelayV2CommandStatusState.NOT_ACCEPTED,
            ),
            IllegalCase(
                sourceState(RelayV2OutboxStateTag.REISSUED),
                RelayV2CommandStatusState.SUCCEEDED,
            ),
            IllegalCase(
                sourceState(RelayV2OutboxStateTag.AMBIGUOUS),
                RelayV2CommandStatusState.RUNNING,
            ),
        )

        illegal.forEach { case ->
            val entry = case.state.entries.first { it.commandId == "command-a" }
            val evidence = when (case.status) {
                RelayV2CommandStatusState.ACCEPTED,
                RelayV2CommandStatusState.RUNNING,
                -> acceptedEvidence(entry, case.status)
                RelayV2CommandStatusState.NOT_ACCEPTED -> retryableNotAccepted(entry)
                else -> terminalEvidence(entry, case.status)
            }
            val recovery = if (case.status == RelayV2CommandStatusState.NOT_ACCEPTED) {
                RelayV2OutboxRecovery.RetrySameCommand("retry-illegal")
            } else {
                RelayV2OutboxRecovery.None
            }
            val result = rejected(
                core.reduce(
                    case.state,
                    RelayV2OutboxAction.ReconcileStatus(evidence, recovery),
                ),
            )
            assertTrue(
                "${entry.state} accepted illegal ${case.status}",
                result.reason in setOf(
                    RelayV2OutboxRejection.INVALID_TRANSITION,
                    RelayV2OutboxRejection.STATUS_IDENTITY_MISMATCH,
                    RelayV2OutboxRejection.STATUS_NOT_AUTHORIZING,
                ),
            )
            assertTrue(result.state === case.state)
        }
    }

    @Test
    fun `only exact active not accepted evidence automatically retries same command and window`() {
        val source = sourceState(RelayV2OutboxStateTag.CONFIRMING, durableAccepted = false)
        val entry = source.entries.first { it.commandId == "command-a" }
        val evidence = retryableNotAccepted(entry).copy(
            errorMessage = "arbitrary localized text that is never parsed",
        )
        val result = applied(
            core.reduce(
                source,
                RelayV2OutboxAction.ReconcileStatus(
                    evidence,
                    RelayV2OutboxRecovery.RetrySameCommand("attempt-retry"),
                ),
            ),
        )
        val retried = result.state.entry(entry.id)!!
        assertEquals(RelayV2OutboxStateTag.SENDING, retried.state)
        assertEquals(entry.commandId, retried.commandId)
        assertEquals(entry.dedupeWindowId, retried.dedupeWindowId)
        assertEquals(entry.createdAtMillis, retried.createdAtMillis)
        assertEquals(listOf("attempt-command-a", "attempt-retry"), retried.attempts.map { it.requestId })
        val effect = result.effects.single() as RelayV2OutboxEffect.ExecuteCommand
        assertEquals(entry.commandId, effect.command.entryId.commandId)
        assertEquals(entry.dedupeWindowId, effect.command.dedupeWindowId)
        assertEquals(0L, effect.retryAfterMs)
        assertEquals(
            listOf(RelayV2OutboxAttemptKind.EXECUTE, RelayV2OutboxAttemptKind.EXECUTE),
            retried.attempts.map { it.kind },
        )

        val oldAttemptFinal = applied(
            core.reduce(
                result.state,
                RelayV2OutboxAction.ReconcileStatus(
                    terminalEvidence(retried, RelayV2CommandStatusState.SUCCEEDED).copy(
                        attemptRequestId = entry.attempts.single().requestId,
                    ),
                ),
            ),
        )
        assertEquals(
            RelayV2OutboxStateTag.SUCCEEDED,
            oldAttemptFinal.state.entry(entry.id)?.state,
        )

        val misleadingMessage = retryableNotAccepted(entry).copy(
            errorCode = "BUSY",
            errorMessage = "Command was not durably accepted",
        )
        val invalidShapes = listOf(
            misleadingMessage,
            retryableNotAccepted(entry).copy(retryable = false),
            retryableNotAccepted(entry).copy(retryAfterMs = null),
            retryableNotAccepted(entry).copy(reissueRequired = true),
            retryableNotAccepted(entry).copy(
                commandDisposition = RelayV2CommandDisposition.IN_DOUBT,
            ),
            retryableNotAccepted(entry).copy(detailsReissueRequired = true),
        )
        invalidShapes.forEachIndexed { index, invalid ->
            val rejected = rejected(
                core.reduce(
                    source,
                    RelayV2OutboxAction.ReconcileStatus(
                        invalid,
                        RelayV2OutboxRecovery.RetrySameCommand("invalid-retry-$index"),
                    ),
                ),
            )
            assertEquals(RelayV2OutboxRejection.STATUS_NOT_AUTHORIZING, rejected.reason)
            assertTrue(rejected.state === source)
        }

        listOf(
            retryableNotAccepted(entry).copy(dedupeWindowId = "wrong-window"),
            retryableNotAccepted(entry).copy(hostEpoch = "wrong-epoch"),
        ).forEachIndexed { index, wrongIdentity ->
            val rejected = rejected(
                core.reduce(
                    source,
                    RelayV2OutboxAction.ReconcileStatus(
                        wrongIdentity,
                        RelayV2OutboxRecovery.RetrySameCommand("wrong-identity-$index"),
                    ),
                ),
            )
            assertEquals(RelayV2OutboxRejection.STATUS_IDENTITY_MISMATCH, rejected.reason)
            assertTrue(rejected.state === source)
        }
        val wrongState = rejected(
            core.reduce(
                source,
                RelayV2OutboxAction.ReconcileStatus(
                    retryableNotAccepted(entry).copy(state = RelayV2CommandStatusState.ACCEPTED),
                    RelayV2OutboxRecovery.RetrySameCommand("wrong-state"),
                ),
            ),
        )
        assertEquals(RelayV2OutboxRejection.RECOVERY_INPUT_MISMATCH, wrongState.reason)
        assertTrue(wrongState.state === source)
    }

    @Test
    fun `exact inactive window reissues atomically with new command and no partial old mutation`() {
        val source = sourceState(RelayV2OutboxStateTag.CONFIRMING, durableAccepted = false)
        val original = source.entries.first { it.commandId == "command-a" }
        val result = applied(
            core.reduce(
                source,
                RelayV2OutboxAction.ReconcileStatus(
                    reissueRequiredNotAccepted(original),
                    RelayV2OutboxRecovery.Reissue(
                        replacementCommandId = "command-replacement",
                        newDedupeWindowId = "window-b",
                        replacementCreatedAtMillis = 0,
                    ),
                ),
            ),
        )
        val old = result.state.entry(original.id)!!
        val replacement = result.state.entries.single { it.commandId == "command-replacement" }
        assertEquals(RelayV2OutboxStateTag.REISSUED, old.state)
        assertEquals("command-replacement", old.replacementCommandId)
        assertEquals(RelayV2OutboxStateTag.QUEUED, replacement.state)
        assertEquals("command-a", replacement.reissuedFromCommandId)
        assertEquals("window-b", replacement.dedupeWindowId)
        assertEquals(original.canonicalRequestArguments, replacement.canonicalRequestArguments)
        assertNotEquals(
            original.requestFingerprint.sha256Hex,
            replacement.requestFingerprint.sha256Hex,
        )
        assertEquals(2, result.transaction.mutations.size)
        assertTrue(result.transaction is RelayV2OutboxTransactionPlan.AtomicReissue)
        val bundle = result.transaction as RelayV2OutboxTransactionPlan.AtomicReissue
        assertEquals(original.id, bundle.original.previousId)
        assertEquals("command-replacement", bundle.original.entry.replacementCommandId)
        assertEquals("command-a", bundle.replacement.entry.reissuedFromCommandId)
        assertTrue(result.transaction.mutations[0] is RelayV2OutboxMutation.Replace)
        assertTrue(result.transaction.mutations[1] is RelayV2OutboxMutation.Insert)
        assertTrue(result.effects.single() is RelayV2OutboxEffect.ReissueCreated)

        val invalidShapes = listOf(
            reissueRequiredNotAccepted(original).copy(errorCode = "COMMAND_NOT_ACCEPTED"),
            reissueRequiredNotAccepted(original).copy(retryable = true),
            reissueRequiredNotAccepted(original).copy(retryAfterMs = 0),
            reissueRequiredNotAccepted(original).copy(reissueRequired = false),
            reissueRequiredNotAccepted(original).copy(
                commandDisposition = RelayV2CommandDisposition.IN_DOUBT,
            ),
            reissueRequiredNotAccepted(original).copy(detailsReissueRequired = false),
        )
        invalidShapes.forEachIndexed { index, invalid ->
            val rejected = rejected(
                core.reduce(
                    source,
                    RelayV2OutboxAction.ReconcileStatus(
                        invalid,
                        RelayV2OutboxRecovery.Reissue(
                            "invalid-replacement-$index",
                            "invalid-window-$index",
                            index.toLong(),
                        ),
                    ),
                ),
            )
            assertEquals(RelayV2OutboxRejection.STATUS_NOT_AUTHORIZING, rejected.reason)
            assertTrue(rejected.state === source)
        }
        val wrongState = rejected(
            core.reduce(
                source,
                RelayV2OutboxAction.ReconcileStatus(
                    reissueRequiredNotAccepted(original).copy(
                        state = RelayV2CommandStatusState.EXPIRED,
                    ),
                    RelayV2OutboxRecovery.Reissue(
                        "wrong-state-replacement",
                        "wrong-state-window",
                        0,
                    ),
                ),
            ),
        )
        assertEquals(RelayV2OutboxRejection.RECOVERY_INPUT_MISMATCH, wrongState.reason)
        assertTrue(wrongState.state === source)

        var identityScoped = enqueue(
            source,
            draft(commandId = original.commandId, principalId = "principal-b"),
            1,
        ).state
        val otherQueued = identityScoped.entries.single { it.principalId == "principal-b" }
        identityScoped = dispatch(
            identityScoped,
            mapOf(otherQueued.id to "other-identity-attempt"),
        ).state
        val otherAttempted = identityScoped.entry(otherQueued.id)!!
        identityScoped = applied(
            core.reduce(
                identityScoped,
                RelayV2OutboxAction.ReconcileStatus(
                    reissueRequiredNotAccepted(otherAttempted),
                    RelayV2OutboxRecovery.Reissue(
                        "other-identity-replacement",
                        "other-identity-window",
                        2,
                    ),
                ),
            ),
        ).state
        val independentlyReissued = applied(
            core.reduce(
                identityScoped,
                RelayV2OutboxAction.ReconcileStatus(
                    reissueRequiredNotAccepted(identityScoped.entry(original.id)!!),
                    RelayV2OutboxRecovery.Reissue(
                        "original-identity-replacement",
                        "original-identity-window",
                        3,
                    ),
                ),
            ),
        )
        assertEquals(
            RelayV2OutboxStateTag.REISSUED,
            independentlyReissued.state.entry(original.id)?.state,
        )

        val repeated = rejected(
            core.reduce(
                result.state,
                RelayV2OutboxAction.ReconcileStatus(
                    reissueRequiredNotAccepted(old),
                    RelayV2OutboxRecovery.Reissue("command-third", "window-c", 3),
                ),
            ),
        )
        assertEquals(RelayV2OutboxRejection.INVALID_TRANSITION, repeated.reason)
    }

    @Test
    fun `status evidence rejects wrong target source attempt result and unlisted final failure`() {
        val source = sourceState(RelayV2OutboxStateTag.SENDING)
        val entry = source.entries.single()
        val validFinal = terminalEvidence(entry, RelayV2CommandStatusState.SUCCEEDED)

        listOf(
            validFinal.copy(scopeId = "wrong-scope"),
            validFinal.copy(sessionId = "wrong-session"),
            validFinal.copy(operation = RelayV2OutboxOperation.KILL_SESSION),
            validFinal.copy(attemptKind = RelayV2OutboxAttemptKind.QUERY),
            validFinal.copy(
                source = RelayV2CommandStatusSource.QUERY_RESPONSE,
                attemptKind = RelayV2OutboxAttemptKind.QUERY,
            ),
        ).forEach { evidence ->
            val rejected = rejected(
                core.reduce(source, RelayV2OutboxAction.ReconcileStatus(evidence)),
            )
            assertEquals(RelayV2OutboxRejection.STATUS_IDENTITY_MISMATCH, rejected.reason)
            assertTrue(rejected.state === source)
        }

        listOf(
            validFinal.copy(
                result = RelayV2CommandResult.AgentMessage(
                    pane = 1,
                    submit = true,
                    messageUtf8Bytes = 8,
                ),
            ),
            validFinal.copy(
                result = RelayV2CommandResult.KilledSession("session-a", true),
            ),
        ).forEach { evidence ->
            val rejected = rejected(
                core.reduce(source, RelayV2OutboxAction.ReconcileStatus(evidence)),
            )
            assertEquals(RelayV2OutboxRejection.STATUS_NOT_AUTHORIZING, rejected.reason)
            assertTrue(rejected.state === source)
        }

        val arbitraryFailure = terminalEvidence(entry, RelayV2CommandStatusState.FAILED).copy(
            errorCode = "ARBITRARY_COMPLETED_ERROR",
        )
        val failed = rejected(
            core.reduce(source, RelayV2OutboxAction.ReconcileStatus(arbitraryFailure)),
        )
        assertEquals(RelayV2OutboxRejection.STATUS_NOT_AUTHORIZING, failed.reason)

        val missingCorrelation = rejected(
            core.reduce(
                source,
                RelayV2OutboxAction.ReconcileStatus(
                    retryableNotAccepted(entry).copy(attemptRequestId = null),
                    RelayV2OutboxRecovery.RetrySameCommand("retry-without-correlation"),
                ),
            ),
        )
        assertEquals(RelayV2OutboxRejection.STATUS_IDENTITY_MISMATCH, missingCorrelation.reason)
        assertTrue(missingCorrelation.state === source)

        val missingReissueCorrelation = rejected(
            core.reduce(
                source,
                RelayV2OutboxAction.ReconcileStatus(
                    reissueRequiredNotAccepted(entry).copy(attemptRequestId = null),
                    RelayV2OutboxRecovery.Reissue(
                        "reissue-without-correlation",
                        "reissue-without-correlation-window",
                        0,
                    ),
                ),
            ),
        )
        assertEquals(
            RelayV2OutboxRejection.STATUS_IDENTITY_MISMATCH,
            missingReissueCorrelation.reason,
        )
        assertTrue(missingReissueCorrelation.state === source)

        val queryState = applied(
            core.reduce(
                source,
                RelayV2OutboxAction.BeginQueries(
                    entryIds = listOf(entry.id),
                    attemptRequestIds = listOf("query-not-accepted"),
                ),
            ),
        ).state
        val queriedEntry = queryState.entry(entry.id)!!
        val queryPretendingToExecute = rejected(
            core.reduce(
                queryState,
                RelayV2OutboxAction.ReconcileStatus(
                    retryableNotAccepted(queriedEntry),
                    RelayV2OutboxRecovery.RetrySameCommand("query-proof-retry"),
                ),
            ),
        )
        assertEquals(
            RelayV2OutboxRejection.STATUS_NOT_AUTHORIZING,
            queryPretendingToExecute.reason,
        )
        assertTrue(queryPretendingToExecute.state === queryState)
    }

    @Test
    fun `disconnect timeout same epoch transport continuity and host epoch changes fail closed`() {
        listOf(
            RelayV2AttemptInterruptionCause.DISCONNECTED,
            RelayV2AttemptInterruptionCause.TIMEOUT,
        ).forEach { cause ->
            val source = sourceState(RelayV2OutboxStateTag.SENDING)
            val entry = source.entries.first { it.commandId == "command-a" }
            val result = applied(
                core.reduce(
                    source,
                    RelayV2OutboxAction.AttemptInterrupted(
                        entry.id,
                        entry.attempts.last().requestId,
                        cause,
                    ),
                ),
            )
            assertEquals(
                RelayV2OutboxStateTag.CONFIRMING,
                result.state.entry(entry.id)?.state,
            )
        }

        val queryableSource = sourceState(RelayV2OutboxStateTag.SENDING)
        val queryableEntry = queryableSource.entries.single()
        RelayV2NonLineageTransportChange.entries.forEach { change ->
            val sameEpochTransportChange = applied(
                core.reduce(
                    queryableSource,
                    RelayV2OutboxAction.HostContinuityObserved(
                        profileId = queryableEntry.profileId,
                        principalId = queryableEntry.principalId,
                        hostId = queryableEntry.hostId,
                        hostEpoch = queryableEntry.expectedHostEpoch,
                        change = change,
                    ),
                ),
            )
            assertTrue("$change changed Outbox lineage", sameEpochTransportChange.state === queryableSource)
            assertTrue(sameEpochTransportChange.transaction.mutations.isEmpty())
            assertTrue(sameEpochTransportChange.effects.isEmpty())
        }

        val queryable = applied(
            core.reduce(
                queryableSource,
                RelayV2OutboxAction.HostEpochChanged(
                    profileId = queryableEntry.profileId,
                    principalId = queryableEntry.principalId,
                    hostId = queryableEntry.hostId,
                    previousHostEpoch = queryableEntry.expectedHostEpoch,
                    observedHostEpoch = "epoch-b",
                    currentDedupeWindowId = "window-b",
                    oldLineageAvailability = RelayV2OldLineageAvailability.QUERYABLE,
                ),
            ),
        )
        assertEquals(
            RelayV2OutboxStateTag.CONFIRMING,
            queryable.state.entry(queryableEntry.id)?.state,
        )
        assertEquals(
            RelayV2OutboxEffect.ConfirmOldLineage(queryableEntry.id),
            queryable.effects.single(),
        )

        var state = RelayV2OutboxState.empty()
        state = enqueue(state, draft(commandId = "queued", sessionId = "session-q"), 90).state
        state = enqueue(state, draft(commandId = "attempted", sessionId = "session-a"), 1).state
        val attemptedId = state.entries.single { it.commandId == "attempted" }.id
        state = dispatch(state, mapOf(attemptedId to "attempt-old")).state
        val oldAttempted = state.entry(attemptedId)!!

        val changed = applied(
            core.reduce(
                state,
                RelayV2OutboxAction.HostEpochChanged(
                    profileId = "profile-a",
                    principalId = "principal-a",
                    hostId = "host-a",
                    previousHostEpoch = "epoch-a",
                    observedHostEpoch = "epoch-b",
                    currentDedupeWindowId = "window-b",
                    oldLineageAvailability = RelayV2OldLineageAvailability.LOST,
                ),
            ),
        )
        val ambiguous = changed.state.entry(oldAttempted.id)!!
        val queued = changed.state.entries.single { it.commandId == "queued" }
        assertEquals(RelayV2OutboxStateTag.AMBIGUOUS, ambiguous.state)
        assertEquals("epoch-a", ambiguous.expectedHostEpoch)
        assertEquals("epoch-b", queued.targetRevalidation?.observedHostEpoch)
        assertTrue(
            changed.effects.any { it is RelayV2OutboxEffect.RevalidateOpaqueTarget },
        )

        val revalidated = applied(
            core.reduce(
                changed.state,
                RelayV2OutboxAction.ConfirmQueuedTarget(
                    entryId = queued.id,
                    observedHostEpoch = "epoch-b",
                    currentDedupeWindowId = "window-b",
                    verifiedScopeId = "opaque-scope-b",
                    verifiedSessionId = "opaque-session-b",
                ),
            ),
        ).state.entries.single { it.commandId == "queued" }
        assertEquals("epoch-b", revalidated.expectedHostEpoch)
        assertEquals("opaque-session-b", revalidated.sessionId)
        assertEquals(null, revalidated.targetRevalidation)
        assertNotEquals(
            queued.requestFingerprint.sha256Hex,
            revalidated.requestFingerprint.sha256Hex,
        )

        val wrongLineage = rejected(
            core.reduce(
                changed.state,
                RelayV2OutboxAction.ReconcileStatus(
                    terminalEvidence(ambiguous, RelayV2CommandStatusState.SUCCEEDED).copy(
                        hostEpoch = "epoch-b",
                    ),
                ),
            ),
        )
        assertEquals(RelayV2OutboxRejection.STATUS_IDENTITY_MISMATCH, wrongLineage.reason)

        val lateFinal = applied(
            core.reduce(
                changed.state,
                RelayV2OutboxAction.ReconcileStatus(
                    terminalEvidence(ambiguous, RelayV2CommandStatusState.SUCCEEDED),
                ),
            ),
        )
        assertEquals(
            RelayV2OutboxStateTag.SUCCEEDED,
            lateFinal.state.entry(ambiguous.id)?.state,
        )
    }

    @Test
    fun `full identity lanes serialize mutations while other sessions principals and create kinds run`() {
        var state = RelayV2OutboxState.empty()
        val drafts = listOf(
            draft(commandId = "session-a-first", sessionId = "session-a"),
            draft(
                commandId = "session-a-second",
                sessionId = "session-a",
                arguments = RelayV2OutboxArguments.killSession(),
            ),
            draft(commandId = "session-b", sessionId = "session-b"),
            draft(
                commandId = "other-principal",
                principalId = "principal-b",
                sessionId = "session-a",
            ),
            draft(
                commandId = "create-worktree-first",
                sessionId = null,
                arguments = RelayV2OutboxArguments.createWorktree(
                    project = "demo",
                    aiCommand = "codex",
                ),
            ),
            draft(
                commandId = "create-worktree-second",
                sessionId = null,
                arguments = RelayV2OutboxArguments.createWorktree(
                    project = "demo",
                    aiCommand = "codex",
                ),
            ),
            draft(
                commandId = "create-terminal",
                sessionId = null,
                arguments = RelayV2OutboxArguments.createTerminal("/repo/demo"),
            ),
            draft(
                commandId = "create-worktree-other-scope",
                scopeId = "scope-b",
                sessionId = null,
                arguments = RelayV2OutboxArguments.createWorktree(
                    project = "demo",
                    aiCommand = "codex",
                ),
            ),
        )
        drafts.forEachIndexed { index, value -> state = enqueue(state, value, index.toLong()).state }
        val byCommand = state.entries.associateBy { it.commandId }
        val selected = listOf(
            "session-a-first",
            "session-b",
            "other-principal",
            "create-worktree-first",
            "create-terminal",
            "create-worktree-other-scope",
        ).associate { name -> byCommand.getValue(name).id to "attempt-$name" }
        val dispatched = dispatch(state, selected)

        assertEquals(6, dispatched.effects.filterIsInstance<RelayV2OutboxEffect.ExecuteCommand>().size)
        assertEquals(
            RelayV2OutboxStateTag.QUEUED,
            dispatched.state.entries.single { it.commandId == "session-a-second" }.state,
        )
        assertEquals(
            RelayV2OutboxStateTag.QUEUED,
            dispatched.state.entries.single { it.commandId == "create-worktree-second" }.state,
        )
        assertEquals(
            setOf(RelayV2OutboxOperation.CREATE_WORKTREE, RelayV2OutboxOperation.CREATE_TERMINAL),
            dispatched.effects.filterIsInstance<RelayV2OutboxEffect.ExecuteCommand>()
                .map { it.command.operation }
                .filter { it.name.startsWith("CREATE") }
                .toSet(),
        )

        val first = dispatched.state.entries.single { it.commandId == "session-a-first" }
        val ambiguous = applied(
            core.reduce(
                dispatched.state,
                RelayV2OutboxAction.ReconcileStatus(
                    terminalEvidence(first, RelayV2CommandStatusState.UNKNOWN),
                ),
            ),
        ).state
        val sameLane = ambiguous.entries.single { it.commandId == "session-a-second" }
        val blocked = rejected(
            core.reduce(
                ambiguous,
                RelayV2OutboxAction.DispatchEligible(
                    mapOf(sameLane.id to "blocked-attempt"),
                    effectBudget = 1,
                ),
            ),
        )
        assertEquals(RelayV2OutboxRejection.INVALID_TRANSITION, blocked.reason)

        val withIndependent = enqueue(
            ambiguous,
            draft(commandId = "session-c", sessionId = "session-c"),
            0,
        ).state
        val independent = withIndependent.entries.single { it.commandId == "session-c" }
        val parallel = dispatch(withIndependent, mapOf(independent.id to "parallel-attempt"))
        assertEquals(RelayV2OutboxStateTag.SENDING, parallel.state.entry(independent.id)?.state)
    }

    @Test
    fun `query attempts preserve execute history and batch thirty three commands by authority`() {
        var state = RelayV2OutboxState.empty()
        repeat(33) { index ->
            state = enqueue(
                state,
                draft(
                    commandId = "query-command-$index",
                    sessionId = "query-session-$index",
                ),
                index.toLong(),
            ).state
        }
        val executeAttempts = state.entries.associate { entry ->
            entry.id to "execute-${entry.commandId}"
        }
        state = dispatch(state, executeAttempts).state
        val queried = applied(
            core.reduce(
                state,
                RelayV2OutboxAction.BeginQueries(
                    entryIds = state.entries.map { it.id },
                    attemptRequestIds = listOf("query-batch-1", "query-batch-2"),
                ),
            ),
        )

        val batches = queried.effects.filterIsInstance<RelayV2OutboxEffect.QueryCommands>()
        assertEquals(listOf(32, 1), batches.map { it.items.size })
        assertEquals(listOf("query-batch-1", "query-batch-2"), batches.map { it.attemptRequestId })
        assertEquals(1, batches.map { it.authority }.toSet().size)
        queried.state.entries.forEach { entry ->
            assertEquals(RelayV2OutboxStateTag.CONFIRMING, entry.state)
            assertEquals(
                listOf(RelayV2OutboxAttemptKind.EXECUTE, RelayV2OutboxAttemptKind.QUERY),
                entry.attempts.map { it.kind },
            )
            assertEquals("execute-${entry.commandId}", entry.attempts.first().requestId)
            assertTrue(entry.attempts.last().requestId.startsWith("query-batch-"))
        }
    }

    @Test
    fun `execute effect budget dispatches one lane and preserves other eligible rows`() {
        var state = RelayV2OutboxState.empty()
        state = enqueue(state, draft(commandId = "budget-a", sessionId = "budget-session-a"), 0).state
        state = enqueue(state, draft(commandId = "budget-b", sessionId = "budget-session-b"), 1).state
        val attempts = state.entries.associate { it.id to "attempt-${it.commandId}" }
        val result = dispatchWith(core, state, attempts, effectBudget = 1)

        assertEquals(1, result.effects.filterIsInstance<RelayV2OutboxEffect.ExecuteCommand>().size)
        assertEquals(RelayV2OutboxStateTag.SENDING, result.state.entries[0].state)
        assertEquals(RelayV2OutboxStateTag.QUEUED, result.state.entries[1].state)
        assertTrue(result.state.entries[1].attempts.isEmpty())
    }

    @Test
    fun `restore rejects duplicate mixed oversized and cross authority attempt ownership`() {
        var twoCommands = RelayV2OutboxState.empty()
        twoCommands = enqueue(
            twoCommands,
            draft(commandId = "owner-a", sessionId = "owner-session-a"),
            0,
        ).state
        twoCommands = enqueue(
            twoCommands,
            draft(commandId = "owner-b", sessionId = "owner-session-b"),
            1,
        ).state
        val first = twoCommands.entries[0]
        val second = twoCommands.entries[1]
        val duplicateExecute = listOf(first, second).map { entry ->
            entry.copy(
                state = RelayV2OutboxStateTag.SENDING,
                attempts = listOf(
                    RelayV2OutboxAttempt(
                        "duplicate-execute-request",
                        RelayV2OutboxAttemptKind.EXECUTE,
                        1,
                    ),
                ),
            )
        }
        restoreFailure(duplicateExecute, twoCommands.nextCreationOrder)

        val mixedKinds = listOf(
            duplicateExecute[0],
            second.copy(
                state = RelayV2OutboxStateTag.CONFIRMING,
                attempts = listOf(
                    RelayV2OutboxAttempt(
                        "duplicate-execute-request",
                        RelayV2OutboxAttemptKind.QUERY,
                        1,
                    ),
                ),
            ),
        )
        restoreFailure(mixedKinds, twoCommands.nextCreationOrder)

        val crossAuthorityQuery = listOf(
            first.copy(
                state = RelayV2OutboxStateTag.CONFIRMING,
                attempts = listOf(RelayV2OutboxAttempt("cross-query", RelayV2OutboxAttemptKind.QUERY, 1)),
            ),
            second.copy(
                principalId = "principal-b",
                state = RelayV2OutboxStateTag.CONFIRMING,
                attempts = listOf(RelayV2OutboxAttempt("cross-query", RelayV2OutboxAttemptKind.QUERY, 1)),
            ),
        )
        restoreFailure(crossAuthorityQuery, twoCommands.nextCreationOrder)

        var thirtyThree = RelayV2OutboxState.empty()
        repeat(33) { index ->
            thirtyThree = enqueue(
                thirtyThree,
                draft(commandId = "oversized-query-$index", sessionId = "oversized-session-$index"),
                index.toLong(),
            ).state
        }
        val oversizedQuery = thirtyThree.entries.map { entry ->
            entry.copy(
                state = RelayV2OutboxStateTag.CONFIRMING,
                attempts = listOf(
                    RelayV2OutboxAttempt("query-over-32", RelayV2OutboxAttemptKind.QUERY, 1),
                ),
            )
        }
        restoreFailure(oversizedQuery, thirtyThree.nextCreationOrder)
    }

    @Test
    fun `restore rejects orphan mismatched cross authority and cyclic reissue graphs`() {
        val valid = sourceState(RelayV2OutboxStateTag.REISSUED)
        val parent = valid.entries.single { it.commandId == "command-a" }
        val child = valid.entries.single { it.reissuedFromCommandId == parent.commandId }

        restoreFailure(listOf(parent), valid.nextCreationOrder)
        restoreFailure(
            listOf(parent.copy(replacementCommandId = "missing-replacement"), child),
            valid.nextCreationOrder,
        )
        restoreFailure(
            listOf(parent, child.copy(principalId = "another-principal")),
            valid.nextCreationOrder,
        )

        val cyclicParent = parent.copy(reissuedFromCommandId = child.commandId)
        val cyclicChild = child.copy(
            state = RelayV2OutboxStateTag.REISSUED,
            attempts = listOf(
                RelayV2OutboxAttempt("cycle-execute", RelayV2OutboxAttemptKind.EXECUTE, 1),
            ),
            replacementCommandId = parent.commandId,
            reissuedFromCommandId = parent.commandId,
        )
        restoreFailure(listOf(cyclicParent, cyclicChild), valid.nextCreationOrder)
    }

    @Test
    fun `create fingerprint bytes exactly match host canonical omission rules`() {
        val state = enqueue(
            RelayV2OutboxState.empty(),
            draft(
                commandId = "canonical-create",
                sessionId = null,
                arguments = RelayV2OutboxArguments.createWorktree(
                    project = "demo",
                    aiCommand = "codex",
                ),
            ),
            0,
        ).state
        val entry = state.entries.single()
        val canonical = canonicalRelayV2FingerprintRequest(
            entry.requestFingerprint.schemaVersion,
            entry.operation,
            entry.dedupeWindowId,
            entry.expectedHostEpoch,
            entry.hostId,
            entry.scopeId,
            entry.sessionId,
            entry.canonicalRequestArguments,
        )
        assertEquals(
            "{\"arguments\":{\"aiCommand\":\"codex\",\"project\":\"demo\"}," +
                "\"dedupeWindowId\":\"window-a\",\"hostEpoch\":\"epoch-a\"," +
                "\"hostId\":\"host-a\",\"operation\":\"create_worktree\"," +
                "\"schemaVersion\":1,\"scopeId\":\"scope-a\"}",
            canonical,
        )
        assertFalse(canonical.contains("sessionId"))
        assertEquals(188, entry.requestFingerprint.canonicalRequestByteCount)
        assertEquals(
            "deefc813581a3d185c32753e71cc131e9d585a8bcab69d8b30380d44b21b5ce7",
            entry.requestFingerprint.sha256Hex,
        )
    }

    @Test
    fun `durable aggregate snapshots mutable inputs and redacts recursive string forms`() {
        val secret = "TOP-SECRET-agent-payload"
        val draft = draft(
            commandId = "redacted-command",
            arguments = RelayV2OutboxArguments.sendAgentMessage(0, secret, true),
        )
        val queued = enqueue(RelayV2OutboxState.empty(), draft, 0).state
        val sent = dispatch(
            queued,
            mapOf(queued.entries.single().id to "redacted-execute-attempt"),
        )
        val sourceEntry = sent.state.entries.single()
        val mutableAttempts = sourceEntry.attempts.toMutableList()
        val mutableEntries = mutableListOf(sourceEntry.copy(attempts = mutableAttempts))
        val restored = RelayV2OutboxState.restore(
            mutableEntries,
            sent.state.nextCreationOrder,
        )
        val canonicalBefore = restored.entries.single().canonicalJson
        val bytesBefore = restored.canonicalByteCount

        mutableAttempts += RelayV2OutboxAttempt(
            "external-alias-attempt",
            RelayV2OutboxAttemptKind.EXECUTE,
            2,
        )
        mutableEntries.clear()
        val exportedBytes = restored.entries.single().canonicalRequestArguments.utf8Bytes()
        exportedBytes.fill(0)

        assertEquals(1, restored.entries.size)
        assertEquals(1, restored.entries.single().attempts.size)
        assertTrue(restored.entries.single().canonicalJson == canonicalBefore)
        assertEquals(bytesBefore, restored.canonicalByteCount)
        assertTrue(
            sourceEntry.canonicalRequestArguments.canonicalJson ==
                restored.entries.single().canonicalRequestArguments.canonicalJson,
        )

        val recursiveValues = listOf(
            draft.arguments,
            sourceEntry.canonicalRequestArguments,
            draft,
            sourceEntry,
            sent.transaction,
            sent.transaction.mutations.single(),
            sent.effects.single(),
            sent,
        )
        recursiveValues.forEach { value ->
            assertFalse(value.toString().contains(secret))
            assertFalse(value.toString().contains("\"message\""))
        }

        val tooManyAttempts = (1..65).map { ordinal ->
            RelayV2OutboxAttempt(
                requestId = "oversized-attempt-$ordinal",
                kind = RelayV2OutboxAttemptKind.EXECUTE,
                ordinal = ordinal,
            )
        }
        val poisonedCanonical = RelayV2CanonicalRequestArguments(
            sourceEntry.canonicalRequestArguments.value,
            "not-canonical",
        )
        val earlyAttemptFailure = restoreFailure(
            listOf(
                sourceEntry.copy(
                    canonicalRequestArguments = poisonedCanonical,
                    attempts = tooManyAttempts,
                ),
            ),
            sent.state.nextCreationOrder,
        )
        assertTrue(earlyAttemptFailure.message.orEmpty().contains("too many attempts"))

        val tooManyEntries = MutableList(RelayV2OutboxLimits.MAX_ENTRIES + 1) { sourceEntry }
        val earlyEntryFailure = restoreFailure(
            tooManyEntries,
            (RelayV2OutboxLimits.MAX_ENTRIES + 1).toLong(),
        )
        assertTrue(earlyEntryFailure.message.orEmpty().contains("too many Outbox entries"))
    }

    @Test
    fun `capacity rejection preserves existing rows attempts and atomic reissue decision`() {
        val oneEntryCore = RelayV2OutboxAuthorityCore(
            RelayV2OutboxCapacity(maxEntries = 1),
        )
        val first = enqueueWith(
            oneEntryCore,
            RelayV2OutboxState.empty(),
            draft(commandId = "first"),
            1,
        ).state
        val second = rejected(
            oneEntryCore.reduce(
                first,
                RelayV2OutboxAction.Enqueue(draft(commandId = "second"), 2),
            ),
        )
        assertEquals(RelayV2OutboxRejection.CAPACITY_EXCEEDED, second.reason)
        assertTrue(second.state === first)
        assertEquals(listOf("first"), second.state.entries.map { it.commandId })

        val sent = dispatchWith(
            oneEntryCore,
            first,
            mapOf(first.entries.single().id to "first-attempt"),
        ).state
        val sentEntry = sent.entries.single()
        val noPartialReissue = rejected(
            oneEntryCore.reduce(
                sent,
                RelayV2OutboxAction.ReconcileStatus(
                    reissueRequiredNotAccepted(sentEntry),
                    RelayV2OutboxRecovery.Reissue("replacement", "window-b", 0),
                ),
            ),
        )
        assertEquals(RelayV2OutboxRejection.CAPACITY_EXCEEDED, noPartialReissue.reason)
        assertTrue(noPartialReissue.state === sent)
        assertEquals(RelayV2OutboxStateTag.SENDING, noPartialReissue.state.entries.single().state)
        assertEquals(null, noPartialReissue.state.entries.single().replacementCommandId)

        val oneAttemptCore = RelayV2OutboxAuthorityCore(
            RelayV2OutboxCapacity(maxAttemptsPerEntry = 1),
        )
        val retryRejected = rejected(
            oneAttemptCore.reduce(
                sent,
                RelayV2OutboxAction.ReconcileStatus(
                    retryableNotAccepted(sentEntry),
                    RelayV2OutboxRecovery.RetrySameCommand("second-attempt"),
                ),
            ),
        )
        assertEquals(RelayV2OutboxRejection.CAPACITY_EXCEEDED, retryRejected.reason)
        assertEquals(listOf("first-attempt"), retryRejected.state.entries.single().attempts.map { it.requestId })

        val tinyCanonicalCore = RelayV2OutboxAuthorityCore(
            RelayV2OutboxCapacity(
                maxArgumentsCanonicalBytes = 4,
                maxEntryCanonicalBytes = 32,
                maxStateCanonicalBytes = 64,
            ),
        )
        val oversized = rejected(
            tinyCanonicalCore.reduce(
                RelayV2OutboxState.empty(),
                RelayV2OutboxAction.Enqueue(draft(commandId = "canonical-limit"), 0),
            ),
        )
        assertEquals(RelayV2OutboxRejection.CAPACITY_EXCEEDED, oversized.reason)
        assertTrue(oversized.state.entries.isEmpty())
    }

    private fun sourceState(
        target: RelayV2OutboxStateTag,
        durableAccepted: Boolean = true,
    ): RelayV2OutboxState {
        var state = enqueue(
            RelayV2OutboxState.empty(),
            draft(commandId = "command-a"),
            500,
        ).state
        if (target == RelayV2OutboxStateTag.QUEUED) return state
        val queued = state.entries.single()
        state = dispatch(state, mapOf(queued.id to "attempt-command-a")).state
        if (target == RelayV2OutboxStateTag.SENDING) return state
        var entry = state.entries.first { it.commandId == "command-a" }

        if (target == RelayV2OutboxStateTag.ACCEPTED ||
            (target == RelayV2OutboxStateTag.CONFIRMING && durableAccepted)
        ) {
            state = applied(
                core.reduce(
                    state,
                    RelayV2OutboxAction.ReconcileStatus(
                        acceptedEvidence(entry, RelayV2CommandStatusState.ACCEPTED),
                    ),
                ),
            ).state
            if (target == RelayV2OutboxStateTag.ACCEPTED) return state
            entry = state.entries.first { it.commandId == "command-a" }
            return applied(
                core.reduce(
                    state,
                    RelayV2OutboxAction.BeginQueries(
                        entryIds = listOf(entry.id),
                        attemptRequestIds = listOf("query-command-a"),
                    ),
                ),
            ).state
        }
        if (target == RelayV2OutboxStateTag.CONFIRMING) {
            return applied(
                core.reduce(
                    state,
                    RelayV2OutboxAction.AttemptInterrupted(
                        entry.id,
                        entry.attempts.last().requestId,
                        RelayV2AttemptInterruptionCause.DISCONNECTED,
                    ),
                ),
            ).state
        }
        if (target == RelayV2OutboxStateTag.AMBIGUOUS) {
            return applied(
                core.reduce(
                    state,
                    RelayV2OutboxAction.ReconcileStatus(
                        terminalEvidence(entry, RelayV2CommandStatusState.UNKNOWN),
                    ),
                ),
            ).state
        }
        if (target == RelayV2OutboxStateTag.SUCCEEDED || target == RelayV2OutboxStateTag.FAILED_FINAL) {
            val status = if (target == RelayV2OutboxStateTag.SUCCEEDED) {
                RelayV2CommandStatusState.SUCCEEDED
            } else {
                RelayV2CommandStatusState.FAILED
            }
            return applied(
                core.reduce(
                    state,
                    RelayV2OutboxAction.ReconcileStatus(terminalEvidence(entry, status)),
                ),
            ).state
        }
        if (target == RelayV2OutboxStateTag.REISSUED) {
            return applied(
                core.reduce(
                    state,
                    RelayV2OutboxAction.ReconcileStatus(
                        reissueRequiredNotAccepted(entry),
                        RelayV2OutboxRecovery.Reissue("replacement-a", "window-b", 0),
                    ),
                ),
            ).state
        }
        error("unsupported source state $target")
    }

    private fun draft(
        commandId: String,
        profileId: String = "profile-a",
        principalId: String = "principal-a",
        scopeId: String = "scope-a",
        sessionId: String? = "session-a",
        arguments: RelayV2OutboxArguments = RelayV2OutboxArguments.sendAgentMessage(
            pane = 0,
            message = "continue",
            submit = true,
        ),
    ) = RelayV2OutboxDraft(
        profileId = profileId,
        principalId = principalId,
        hostId = "host-a",
        expectedHostEpoch = "epoch-a",
        dedupeWindowId = "window-a",
        commandId = commandId,
        scopeId = scopeId,
        sessionId = sessionId,
        arguments = arguments,
    )

    private fun acceptedEvidence(
        entry: RelayV2OutboxEntry,
        state: RelayV2CommandStatusState,
    ): RelayV2CommandStatusEvidence {
        val attempt = entry.attempts.lastOrNull()
        val source = when (attempt?.kind) {
            RelayV2OutboxAttemptKind.EXECUTE -> RelayV2CommandStatusSource.EXECUTE_RESPONSE
            RelayV2OutboxAttemptKind.QUERY -> RelayV2CommandStatusSource.QUERY_RESPONSE
            null -> RelayV2CommandStatusSource.RESULT_EVENT
        }
        return RelayV2CommandStatusEvidence(
            entryId = entry.id,
            dedupeWindowId = entry.dedupeWindowId,
            hostEpoch = entry.expectedHostEpoch,
            scopeId = entry.scopeId,
            sessionId = entry.sessionId,
            operation = entry.operation,
            source = source,
            attemptKind = attempt?.kind,
            state = state,
            attemptRequestId = attempt?.requestId,
        )
    }

    private fun terminalEvidence(
        entry: RelayV2OutboxEntry,
        state: RelayV2CommandStatusState,
    ): RelayV2CommandStatusEvidence = when (state) {
        RelayV2CommandStatusState.SUCCEEDED -> acceptedEvidence(entry, state).copy(
            result = successfulResult(entry),
        )
        RelayV2CommandStatusState.FAILED -> acceptedEvidence(entry, state).copy(
            errorCode = "COMMAND_FAILED",
            commandDisposition = RelayV2CommandDisposition.COMPLETED,
        )
        RelayV2CommandStatusState.IN_DOUBT -> acceptedEvidence(entry, state).copy(
            errorCode = "COMMAND_IN_DOUBT",
            commandDisposition = RelayV2CommandDisposition.IN_DOUBT,
        )
        RelayV2CommandStatusState.EXPIRED -> acceptedEvidence(entry, state).copy(
            errorCode = "COMMAND_RESULT_EXPIRED",
            commandDisposition = RelayV2CommandDisposition.COMPLETED,
        )
        RelayV2CommandStatusState.UNKNOWN -> acceptedEvidence(entry, state).copy(
            errorCode = "COMMAND_STATUS_UNKNOWN",
            commandDisposition = RelayV2CommandDisposition.IN_DOUBT,
        )
        else -> acceptedEvidence(entry, state)
    }

    private fun successfulResult(entry: RelayV2OutboxEntry): RelayV2CommandResult =
        when (entry.operation) {
            RelayV2OutboxOperation.CREATE_WORKTREE -> RelayV2CommandResult.CreatedSession(
                sessionId = "created-worktree-session",
                scopeId = entry.scopeId,
                kind = RelayV2ResultSessionKind.WORKTREE,
            )
            RelayV2OutboxOperation.CREATE_TERMINAL -> RelayV2CommandResult.CreatedSession(
                sessionId = "created-terminal-session",
                scopeId = entry.scopeId,
                kind = RelayV2ResultSessionKind.TERMINAL,
            )
            RelayV2OutboxOperation.SEND_AGENT_MESSAGE -> {
                val arguments = entry.canonicalRequestArguments.value as
                    RelayV2OutboxArguments.SendAgentMessage
                RelayV2CommandResult.AgentMessage(
                    pane = arguments.pane,
                    submit = arguments.submit,
                    messageUtf8Bytes = arguments.message.toByteArray(Charsets.UTF_8).size,
                )
            }
            RelayV2OutboxOperation.KILL_SESSION -> RelayV2CommandResult.KilledSession(
                sessionId = entry.sessionId!!,
                terminated = true,
            )
        }

    private fun retryableNotAccepted(entry: RelayV2OutboxEntry) =
        acceptedEvidence(entry, RelayV2CommandStatusState.NOT_ACCEPTED).copy(
            retryable = true,
            retryAfterMs = 0,
            errorCode = "COMMAND_NOT_ACCEPTED",
            commandDisposition = RelayV2CommandDisposition.NOT_ACCEPTED,
        )

    private fun reissueRequiredNotAccepted(entry: RelayV2OutboxEntry) =
        acceptedEvidence(entry, RelayV2CommandStatusState.NOT_ACCEPTED).copy(
            retryable = false,
            retryAfterMs = null,
            reissueRequired = true,
            errorCode = "COMMAND_WINDOW_EXPIRED",
            commandDisposition = RelayV2CommandDisposition.NOT_ACCEPTED,
            detailsReissueRequired = true,
        )

    private fun enqueue(
        state: RelayV2OutboxState,
        draft: RelayV2OutboxDraft,
        createdAtMillis: Long,
    ): RelayV2OutboxResult.Applied = enqueueWith(core, state, draft, createdAtMillis)

    private fun enqueueWith(
        targetCore: RelayV2OutboxAuthorityCore,
        state: RelayV2OutboxState,
        draft: RelayV2OutboxDraft,
        createdAtMillis: Long,
    ) = applied(
        targetCore.reduce(state, RelayV2OutboxAction.Enqueue(draft, createdAtMillis)),
    )

    private fun dispatch(
        state: RelayV2OutboxState,
        attempts: Map<RelayV2OutboxEntryId, String>,
    ): RelayV2OutboxResult.Applied = dispatchWith(core, state, attempts)

    private fun dispatchWith(
        targetCore: RelayV2OutboxAuthorityCore,
        state: RelayV2OutboxState,
        attempts: Map<RelayV2OutboxEntryId, String>,
        effectBudget: Int = attempts.size,
    ) = applied(
        targetCore.reduce(
            state,
            RelayV2OutboxAction.DispatchEligible(attempts, effectBudget),
        ),
    )

    private fun applied(result: RelayV2OutboxResult): RelayV2OutboxResult.Applied {
        assertTrue("Expected applied Outbox result", result is RelayV2OutboxResult.Applied)
        return result as RelayV2OutboxResult.Applied
    }

    private fun rejected(result: RelayV2OutboxResult): RelayV2OutboxResult.Rejected {
        assertTrue("Expected rejected Outbox result", result is RelayV2OutboxResult.Rejected)
        return result as RelayV2OutboxResult.Rejected
    }

    private fun restoreFailure(
        entries: List<RelayV2OutboxEntry>,
        nextCreationOrder: Long,
    ): Throwable {
        val failure = runCatching {
            RelayV2OutboxState.restore(entries, nextCreationOrder)
        }.exceptionOrNull()
        assertTrue("Expected corrupt Outbox restore to fail closed", failure != null)
        return failure!!
    }

    private data class IllegalCase(
        val state: RelayV2OutboxState,
        val status: RelayV2CommandStatusState,
    )
}
