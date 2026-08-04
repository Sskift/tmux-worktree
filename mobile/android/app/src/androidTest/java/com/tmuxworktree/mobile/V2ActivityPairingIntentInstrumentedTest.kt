package com.tmuxworktree.mobile

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.tmuxworktree.mobile.app.PairingPayload
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class V2ActivityPairingIntentInstrumentedTest {
    @Test
    fun pairingIntentConsumerReturnsPayloadThenScrubsSensitiveLaunchState() {
        val intent = pairingIntent()
            .putExtra(V2Activity.EXTRA_RELAY_URL, "wss://extra.example.com")
            .putExtra(V2Activity.EXTRA_RELAY_SECRET, "extra-token")
            .putExtra(V2Activity.EXTRA_HOST_ID, "extra-host")
            .putExtra(V2Activity.EXTRA_AUTO_CONNECT, true)
            .putExtra("token", "legacy-token")
            .putExtra("url", "wss://legacy.example.com")
            .putExtra("host", "legacy-host")
            .putExtra("unrelated", "keep-me")

        assertEquals(
            PairingPayload(
                relayUrl = "wss://extra.example.com",
                token = "extra-token",
                hostId = "extra-host",
            ),
            PairingIntentConsumer.consume(intent),
        )

        assertPairingStateScrubbed(intent)
        assertTrue(intent.getBooleanExtra(V2Activity.EXTRA_DEMO_MODE, false))
        assertEquals("keep-me", intent.getStringExtra("unrelated"))
        assertNull(PairingIntentConsumer.consume(intent))
    }

    @Test
    fun recreatedActivityScrubsPairingStateWithoutApplyingItAgain() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val launchIntent = Intent(context, V2Activity::class.java).apply {
            putExtra(V2Activity.EXTRA_DEMO_MODE, true)
            putExtra(V2Activity.EXTRA_RELAY_URL, "wss://initial.example.com")
            putExtra(V2Activity.EXTRA_RELAY_SECRET, "initial-token")
            putExtra(V2Activity.EXTRA_HOST_ID, "initial-host")
        }

        ActivityScenario.launch<V2Activity>(launchIntent).use { scenario ->
            scenario.onActivity { activity ->
                assertPairingStateScrubbed(activity.intent)
                assertTrue(activity.intent.getBooleanExtra(V2Activity.EXTRA_DEMO_MODE, false))

                // ActivityScenario recreates with this current Intent. A
                // restored Activity must scrub any accidentally retained launch
                // capability without applying it to the ViewModel a second time.
                activity.intent.putExtra(
                    V2Activity.EXTRA_RELAY_URL,
                    "wss://restore-sentinel.example.com",
                )
                activity.intent.putExtra(V2Activity.EXTRA_RELAY_SECRET, "restore-sentinel")
                activity.intent.putExtra(V2Activity.EXTRA_HOST_ID, "restore-sentinel")
            }

            scenario.recreate()

            scenario.onActivity { activity ->
                assertPairingStateScrubbed(activity.intent)
                assertTrue(activity.intent.getBooleanExtra(V2Activity.EXTRA_DEMO_MODE, false))
                assertNull(PairingIntentConsumer.consume(activity.intent))
            }
        }
    }

    @Test
    fun onNewIntentConsumesAndScrubsEachIncomingIntentOnce() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val launchIntent = Intent(context, V2Activity::class.java).apply {
            putExtra(V2Activity.EXTRA_DEMO_MODE, true)
        }

        ActivityScenario.launch<V2Activity>(launchIntent).use { scenario ->
            scenario.onActivity { activity ->
                val incoming = Intent(activity.intent).apply {
                    data = validPairingUri("new-intent-token")
                    putExtra(V2Activity.EXTRA_AUTO_CONNECT, true)
                }

                InstrumentationRegistry.getInstrumentation()
                    .callActivityOnNewIntent(activity, incoming)

                assertSame(incoming, activity.intent)
                assertPairingStateScrubbed(incoming)
                assertTrue(incoming.getBooleanExtra(V2Activity.EXTRA_DEMO_MODE, false))
                assertNull(PairingIntentConsumer.consume(incoming))
            }
        }
    }

    private fun pairingIntent(): Intent = Intent(Intent.ACTION_VIEW).apply {
        putExtra(V2Activity.EXTRA_DEMO_MODE, true)
        data = validPairingUri("deep-link-token")
    }

    private fun validPairingUri(token: String): Uri = Uri.parse(
        "tmuxworktree://pair?relayUrl=wss%3A%2F%2Frelay.example.com" +
            "&token=$token&hostId=mac-admin",
    )

    private fun assertPairingStateScrubbed(intent: Intent) {
        assertNull(intent.data)
        listOf(
            V2Activity.EXTRA_RELAY_URL,
            V2Activity.EXTRA_RELAY_SECRET,
            V2Activity.EXTRA_HOST_ID,
            V2Activity.EXTRA_AUTO_CONNECT,
            "url",
            "relay",
            "token",
            "secret",
            "host",
            "relayToken",
            "auto_connect",
        ).forEach { key -> assertFalse("Expected $key to be removed", intent.hasExtra(key)) }
    }
}
