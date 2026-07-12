package com.tmuxworktree.mobile

import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import com.tmuxworktree.mobile.app.AppContainer
import com.tmuxworktree.mobile.app.PairingPayload
import com.tmuxworktree.mobile.app.PairingPayloadParser
import com.tmuxworktree.mobile.app.V2App
import com.tmuxworktree.mobile.app.V2ViewModel
import com.tmuxworktree.mobile.designsystem.TwTheme

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

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
        )
        if (savedInstanceState == null) {
            consumePairingIntent(intent)
        }
        setContent {
            TwTheme {
                V2App(
                    viewModel = viewModel,
                    onScanQr = ::scanPairingQr,
                )
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
        viewModel.applyPairingPayload(payload, connectImmediately = false)
    }

    private fun scanPairingQr() {
        val options = GmsBarcodeScannerOptions.Builder()
            .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
            .enableAutoZoom()
            .build()
        GmsBarcodeScanning.getClient(this, options)
            .startScan()
            .addOnSuccessListener { barcode ->
                val payload = PairingPayloadParser.parse(barcode.rawValue)
                if (payload == null || payload.relayUrl.isBlank() || payload.token.isBlank()) {
                    viewModel.reportPairingError("This QR code does not contain a valid tw-dashboard connection")
                } else {
                    // Scanning fills the reviewable fields; the user still
                    // confirms the relay URL with the Connect button.
                    viewModel.applyPairingPayload(payload, connectImmediately = false)
                }
            }
            .addOnFailureListener { error ->
                viewModel.reportPairingError(error.message ?: "QR scanner is unavailable")
            }
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
            intent.data = null
            SENSITIVE_PAIRING_EXTRAS.forEach(intent::removeExtra)
        }
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
