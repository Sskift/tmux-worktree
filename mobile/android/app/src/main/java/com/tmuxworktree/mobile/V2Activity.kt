package com.tmuxworktree.mobile

import android.Manifest
import android.content.Intent
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.tmuxworktree.mobile.app.AppContainer
import com.tmuxworktree.mobile.app.V2App
import com.tmuxworktree.mobile.app.V2ViewModel
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AndroidAgentTranscriptLifecycleNotificationPermission
import com.tmuxworktree.mobile.feature.pairing.PairingQrScanner
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch

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
    private val notificationPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) {
        viewModel.updateNotificationPermission(
            AndroidAgentTranscriptLifecycleNotificationPermission.isGranted(this),
        )
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
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                viewModel.notificationPermissionRequests.collect {
                    requestNotificationPermission()
                }
            }
        }
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

    override fun onResume() {
        super.onResume()
        viewModel.updateNotificationPermission(
            AndroidAgentTranscriptLifecycleNotificationPermission.isGranted(this),
        )
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        consumePairingIntent(intent)
    }

    private fun consumePairingIntent(intent: Intent) {
        val rawData = intent.dataString
        PairingIntentConsumer.scrub(intent)
        when (pairingPayloadRoute(rawData)) {
            PairingPayloadRoute.RELAY_V2_ENROLLMENT -> {
                viewModel.offerRelayV2Enrollment(rawData.orEmpty())
                return
            }
            PairingPayloadRoute.UNKNOWN -> if (rawData != null) {
                PairingIntentConsumer.scrub(intent)
                viewModel.reportPairingError("This enrollment or pairing link is invalid")
                return
            }
        }
    }

    private fun scanPairingQr() {
        scannerVisible = true
    }

    private fun requestNotificationPermission() {
        if (!AndroidAgentTranscriptLifecycleNotificationPermission.requiresRuntimeRequest()) {
            viewModel.updateNotificationPermission(true)
            return
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    private fun consumeScannedQr(rawValue: String) {
        scannerVisible = false
        when (pairingPayloadRoute(rawValue)) {
            PairingPayloadRoute.RELAY_V2_ENROLLMENT ->
                viewModel.offerRelayV2Enrollment(rawValue)
            PairingPayloadRoute.UNKNOWN -> viewModel.reportPairingError(
                "This QR code does not contain a valid Relay v2 enrollment",
            )
        }
    }

    companion object {
        const val EXTRA_DEMO_MODE = "demoMode"
        const val EXTRA_DEMO_RECOVERING = "demoRecovering"
    }
}

internal enum class PairingPayloadRoute {
    RELAY_V2_ENROLLMENT,
    UNKNOWN,
}

/** Routes the only supported external enrollment authority. */
internal fun pairingPayloadRoute(rawValue: String?): PairingPayloadRoute {
    val raw = rawValue ?: return PairingPayloadRoute.UNKNOWN
    if (raw.length > MAX_PAIRING_ROUTE_PAYLOAD_LENGTH) return PairingPayloadRoute.UNKNOWN
    val value = raw.trim()
    val schemeEnd = value.indexOf("://")
    if (schemeEnd <= 0 || !value.substring(0, schemeEnd).equals(
            "tmuxworktree",
            ignoreCase = true,
        )
    ) return PairingPayloadRoute.UNKNOWN
    val authorityStart = schemeEnd + 3
    val authorityEnd = value.indexOfAny(charArrayOf('/', '?', '#'), authorityStart)
        .takeIf { it >= 0 }
        ?: value.length
    val authority = value.substring(authorityStart, authorityEnd)
    return when {
        authority.equals("enroll", ignoreCase = true) ->
            PairingPayloadRoute.RELAY_V2_ENROLLMENT
        else -> PairingPayloadRoute.UNKNOWN
    }
}

private const val MAX_PAIRING_ROUTE_PAYLOAD_LENGTH = 8_192

/**
 * Pairing links and credentials are launch capabilities, not durable Activity state.
 * Reading and scrubbing them in one operation makes re-delivery and configuration
 * changes harmless while preserving unrelated launch flags such as demoMode.
 */
internal object PairingIntentConsumer {
    fun scrub(intent: Intent) {
        intent.data = null
        SENSITIVE_PAIRING_EXTRAS.forEach(intent::removeExtra)
    }

    private val SENSITIVE_PAIRING_EXTRAS = setOf(
        "relayUrl",
        "relaySecret",
        "hostId",
        "autoConnect",
        "url",
        "relay",
        "token",
        "secret",
        "host",
        "relayToken",
        "auto_connect",
    )
}
