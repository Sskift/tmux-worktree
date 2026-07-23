package com.tmuxworktree.mobile.app

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class ProfileMutationCoordinatorTest {
    @Test
    fun `later v1 mutation wins after an earlier v2 response completes`() = runBlocking {
        val coordinator = ProfileMutationCoordinator()
        val earlierV2Caller = ProfileMutationCaller(coordinator)
        val laterV1Caller = ProfileMutationCaller(coordinator)
        val v2Response = CompletableDeferred<Unit>()
        val v2Started = CompletableDeferred<Unit>()
        var durableProfile = "initial"

        val earlierV2 = async {
            earlierV2Caller.mutate {
                v2Started.complete(Unit)
                v2Response.await()
                durableProfile = "v2"
            }
        }
        v2Started.await()
        val laterV1 = async {
            laterV1Caller.mutate {
                durableProfile = "v1"
            }
        }
        yield()

        assertFalse(laterV1.isCompleted)
        v2Response.complete(Unit)
        earlierV2.await()
        laterV1.await()
        assertEquals("v1", durableProfile)
    }

    private class ProfileMutationCaller(
        private val coordinator: ProfileMutationCoordinator,
    ) {
        suspend fun mutate(block: suspend () -> Unit) = coordinator.mutate(block)
    }
}
