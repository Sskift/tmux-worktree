package com.tmuxworktree.mobile

import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.tmuxworktree.mobile.app.AppContainer
import com.tmuxworktree.mobile.app.PairingPayload
import com.tmuxworktree.mobile.app.PairingPayloadParser
import com.tmuxworktree.mobile.app.V2App
import com.tmuxworktree.mobile.app.V2ViewModel
import com.tmuxworktree.mobile.feature.pairing.PairingQrScanner

class V2Activity : ComponentActivity() {
    private val appContainer by lazy { AppContainer(applicationContext) }
    private val demoMode: Boolean by lazy {
        BuildConfig.DEBUG && intent.getBooleanExtra(EXTRA_DEMO_MODE, false)
    }
    private val demoRecovering: Boolean by lazy {
        BuildConfig.DEBUG && intent.getBooleanExtra(EXTRA_DEMO_RECOVERING, false)
    }
    private val viewModel: V2ViewModel by viewModels {
        V2ViewModel.factory(appContainer, demoMode, demoRecovering)
    }
    private var scannerVisible by mutableStateOf(false)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
        )
        if (savedInstanceState == null) consumePairingIntent(intent)
        else PairingIntentConsumer.scrub(intent)
        setContent {
            V2App(
                viewModel = viewModel,
                onScanQr = ::scanPairingQr,
            ) {
                if (scannerVisible) {
                    PairingQrScanner(
                        onQrCode = ::consumeScannedQr,
                        onDismiss = { scannerVisible = false },
                        onError = { message ->
                            scannerVisible = false
                            viewModel.reportPairingError(message)
                        },
                    )
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        consumePairingIntent(intent)
    }

    private fun consumePairingIntent(intent: Intent) {
        val payload = PairingIntentConsumer.consume(intent) ?: return
        // Exported launcher/deep-link inputs are untrusted. They may prefill
        // the review screen, but never replace a pairing without a tap.
        viewModel.applyPairingPayload(payload)
    }

    private fun scanPairingQr() {
        scannerVisible = true
    }

    private fun consumeScannedQr(rawValue: String) {
        scannerVisible = false
        val payload = PairingPayloadParser.parse(rawValue)
        if (payload == null) {
            viewModel.reportPairingError(
                "This QR code does not contain a valid Relay v1 pairing profile",
            )
            return
        }
        // Scanning only fills the reviewable fields. The user must still tap
        // Connect after reviewing the Relay URL.
        viewModel.applyPairingPayload(payload)
    }

    companion object {
        const val EXTRA_DEMO_MODE = "demoMode"
        const val EXTRA_DEMO_RECOVERING = "demoRecovering"
        const val EXTRA_RELAY_URL = "relayUrl"
        const val EXTRA_RELAY_SECRET = "relaySecret"
        const val EXTRA_HOST_ID = "hostId"
        const val EXTRA_AUTO_CONNECT = "autoConnect"
    }
}

/**
 * Pairing links and credentials are launch capabilities, not durable Activity state.
 * Reading and scrubbing them in one operation makes re-delivery and configuration
 * changes harmless while preserving unrelated launch flags such as demoMode.
 */
internal object PairingIntentConsumer {
    fun consume(intent: Intent): PairingPayload? {
        return try {
            val extraPayload = PairingPayload(
                relayUrl = intent.getStringExtra(V2Activity.EXTRA_RELAY_URL).orEmpty(),
                token = intent.getStringExtra(V2Activity.EXTRA_RELAY_SECRET).orEmpty(),
                hostId = intent.getStringExtra(V2Activity.EXTRA_HOST_ID).orEmpty(),
            ).takeIf { it.relayUrl.isNotBlank() || it.token.isNotBlank() }
            extraPayload ?: PairingPayloadParser.parse(intent.dataString)
        } finally {
            scrub(intent)
        }
    }

    fun scrub(intent: Intent) {
        intent.data = null
        SENSITIVE_PAIRING_EXTRAS.forEach(intent::removeExtra)
    }

    private val SENSITIVE_PAIRING_EXTRAS = setOf(
        V2Activity.EXTRA_RELAY_URL,
        V2Activity.EXTRA_RELAY_SECRET,
        V2Activity.EXTRA_HOST_ID,
        V2Activity.EXTRA_AUTO_CONNECT,
        // Historical and third-party launcher aliases are never consumed as
        // extras, but should not remain attached to the Activity Intent.
        "url",
        "relay",
        "token",
        "secret",
        "host",
        "relayToken",
        "auto_connect",
    )
}
