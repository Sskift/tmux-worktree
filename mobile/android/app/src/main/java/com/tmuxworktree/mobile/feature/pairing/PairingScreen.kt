package com.tmuxworktree.mobile.feature.pairing

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material.icons.outlined.Security
import androidx.compose.material.icons.outlined.VpnKey
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.tmuxworktree.mobile.designsystem.TwAccent
import com.tmuxworktree.mobile.designsystem.TwError
import com.tmuxworktree.mobile.designsystem.TwOnAccent
import com.tmuxworktree.mobile.designsystem.TwSurface
import com.tmuxworktree.mobile.designsystem.TwTextPrimary
import com.tmuxworktree.mobile.designsystem.TwTextSecondary

@Composable
internal fun RelayV2EnrollmentReviewScreen(
    issuerUrl: String,
    relayUrl: String,
    hostId: String,
    enrollmentId: String,
    deviceLabel: String,
    submitting: Boolean,
    completed: Boolean,
    activating: Boolean,
    activationFailureMessage: String?,
    failureMessage: String?,
    onConfirm: () -> Unit,
    onActivate: () -> Unit,
    onCancel: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .fillMaxSize()
            .statusBarsPadding()
            .navigationBarsPadding()
            .verticalScroll(rememberScrollState())
            .padding(start = 24.dp, top = 16.dp, end = 24.dp, bottom = 24.dp)
            .testTag("relay_v2_enrollment_review"),
    ) {
        Text(
            text = when {
                activationFailureMessage != null -> "Enrollment saved; connection not started"
                completed -> "Enrollment saved"
                submitting -> "Confirming enrollment…"
                failureMessage != null -> "Enrollment not completed"
                else -> "Review Relay v2 enrollment"
            },
            color = TwTextPrimary,
            style = MaterialTheme.typography.headlineMedium,
            modifier = Modifier.semantics { heading() },
        )
        Spacer(Modifier.height(12.dp))
        Text(
            text = when {
                completed -> activationFailureMessage
                    ?: "The credential is saved with Android Keystore. Connect when ready."
                failureMessage != null -> failureMessage
                else -> "Confirm these endpoints and computer identity before redeeming the one-time enrollment."
            },
            color = if (failureMessage != null || activationFailureMessage != null) {
                TwError
            } else {
                TwTextSecondary
            },
            style = MaterialTheme.typography.bodyLarge,
        )
        Spacer(Modifier.height(28.dp))
        EnrollmentReviewFact("Issuer", issuerUrl)
        EnrollmentReviewFact("Relay", relayUrl)
        EnrollmentReviewFact("Computer", hostId)
        EnrollmentReviewFact("Enrollment", enrollmentId)
        EnrollmentReviewFact("Android device", deviceLabel)

        if (submitting || activating) {
            Spacer(Modifier.height(20.dp))
            CircularProgressIndicator(
                color = TwAccent,
                modifier = Modifier.align(Alignment.CenterHorizontally),
            )
        } else if (completed) {
            Spacer(Modifier.height(20.dp))
            Button(
                onClick = onActivate,
                colors = ButtonDefaults.buttonColors(
                    containerColor = TwAccent,
                    contentColor = TwOnAccent,
                ),
                modifier = Modifier
                    .fillMaxWidth()
                    .height(52.dp)
                    .testTag("relay_v2_enrollment_activate"),
            ) {
                Text("Connect with Relay v2")
            }
        } else if (failureMessage == null) {
            Spacer(Modifier.height(20.dp))
            Button(
                onClick = onConfirm,
                colors = ButtonDefaults.buttonColors(
                    containerColor = TwAccent,
                    contentColor = TwOnAccent,
                ),
                modifier = Modifier
                    .fillMaxWidth()
                    .height(52.dp)
                    .testTag("relay_v2_enrollment_confirm"),
            ) {
                Text("Confirm enrollment")
            }
        }

        if (
            !submitting &&
            !activating &&
            (!completed || activationFailureMessage != null)
        ) {
            Spacer(Modifier.height(12.dp))
            OutlinedButton(
                onClick = onCancel,
                colors = ButtonDefaults.outlinedButtonColors(contentColor = TwAccent),
                modifier = Modifier
                    .fillMaxWidth()
                    .height(52.dp)
                    .testTag("relay_v2_enrollment_cancel"),
            ) {
                Text(
                    if (failureMessage == null && activationFailureMessage == null) {
                        "Cancel"
                    } else {
                        "Dismiss"
                    },
                )
            }
        }
    }
}

@Composable
private fun EnrollmentReviewFact(label: String, value: String) {
    Text(label, color = TwTextSecondary, style = MaterialTheme.typography.labelLarge)
    Spacer(Modifier.height(4.dp))
    Text(value, color = TwTextPrimary, style = MaterialTheme.typography.bodyLarge)
    Spacer(Modifier.height(16.dp))
}

@Composable
fun PairingScreen(
    isConnecting: Boolean,
    error: String?,
    onScanQr: () -> Unit,
    onManualRelayV2Enrollment: (issuerUrl: String, oneTimeEnrollmentToken: String) -> Unit,
    modifier: Modifier = Modifier,
    onBack: (() -> Unit)? = null,
    onForgetPairing: (() -> Unit)? = null,
) {
    var confirmForgetPairing by rememberSaveable { mutableStateOf(false) }
    var showManualRelayV2Enrollment by remember { mutableStateOf(false) }

    Column(
        modifier = modifier
            .fillMaxSize()
            .statusBarsPadding()
            .navigationBarsPadding()
            .verticalScroll(rememberScrollState())
            .padding(start = 24.dp, top = 12.dp, end = 24.dp, bottom = 24.dp)
            .testTag("pairing_screen"),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (onBack != null) {
                IconButton(
                    onClick = onBack,
                    modifier = Modifier.testTag("pairing_back"),
                ) {
                    Icon(
                        imageVector = Icons.AutoMirrored.Outlined.ArrowBack,
                        contentDescription = "Return to settings",
                        tint = TwTextPrimary,
                    )
                }
                Spacer(Modifier.width(4.dp))
            }
            Text(
                text = "Connect your computer",
                color = TwTextPrimary,
                style = MaterialTheme.typography.headlineMedium,
                modifier = Modifier.semantics { heading() },
            )
        }
        Spacer(Modifier.height(8.dp))
        Text(
            text = "Open Mobile Relay v2 in tw-dashboard on your Mac, create a one-time enrollment, then scan its QR code. This app accepts Relay v2 enrollment only.",
            color = TwTextSecondary,
            style = MaterialTheme.typography.bodyLarge,
        )
        Spacer(Modifier.height(24.dp))

        Button(
            onClick = onScanQr,
            colors = ButtonDefaults.buttonColors(
                containerColor = TwAccent,
                contentColor = TwOnAccent,
            ),
            modifier = Modifier
                .fillMaxWidth()
                .height(52.dp)
                .testTag("pairing_scan_qr"),
        ) {
            Icon(Icons.Outlined.QrCodeScanner, contentDescription = null)
            Spacer(Modifier.width(12.dp))
            Text("Scan QR code")
        }

        Spacer(Modifier.height(12.dp))
        OutlinedButton(
            onClick = { showManualRelayV2Enrollment = true },
            colors = ButtonDefaults.outlinedButtonColors(contentColor = TwAccent),
            modifier = Modifier
                .fillMaxWidth()
                .height(52.dp)
                .testTag("pairing_relay_v2_enrollment"),
        ) {
            Icon(Icons.Outlined.VpnKey, contentDescription = null)
            Spacer(Modifier.width(12.dp))
            Text("Enroll Relay v2")
        }

        if (error != null) {
            Spacer(Modifier.height(16.dp))
            Text(
                text = error,
                color = TwError,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.testTag("pairing_error"),
            )
        } else if (isConnecting) {
            Spacer(Modifier.height(16.dp))
            Text(
                text = "Starting Relay v2…",
                color = TwTextSecondary,
                style = MaterialTheme.typography.bodyMedium,
            )
        }

        Spacer(Modifier.height(20.dp))
        Row(
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.Top,
        ) {
            Icon(
                imageVector = Icons.Outlined.Security,
                contentDescription = null,
                tint = TwAccent,
            )
            Text(
                text = "The enrolled credential is encrypted with Android Keystore. HTTPS and WSS are required so enrollment and terminal content stay encrypted in transit.",
                color = TwTextSecondary,
                style = MaterialTheme.typography.bodyMedium,
            )
        }

        if (onForgetPairing != null) {
            Spacer(Modifier.height(20.dp))
            OutlinedButton(
                onClick = { confirmForgetPairing = true },
                colors = ButtonDefaults.outlinedButtonColors(contentColor = TwError),
                modifier = Modifier
                    .fillMaxWidth()
                    .height(48.dp)
                    .testTag("pairing_forget"),
            ) {
                Text("Forget this pairing")
            }
        }
    }

    if (confirmForgetPairing && onForgetPairing != null) {
        AlertDialog(
            onDismissRequest = { confirmForgetPairing = false },
            containerColor = TwSurface,
            title = { Text("Forget this pairing?", color = TwTextPrimary) },
            text = {
                Text(
                    "Cached sessions and unsent commands for this computer will be removed from this phone.",
                    color = TwTextSecondary,
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirmForgetPairing = false
                        onForgetPairing()
                    },
                    modifier = Modifier.testTag("confirm_forget_pairing"),
                ) {
                    Text("Forget", color = TwError)
                }
            },
            dismissButton = {
                TextButton(
                    onClick = { confirmForgetPairing = false },
                    modifier = Modifier.testTag("cancel_forget_pairing"),
                ) {
                    Text("Keep pairing", color = TwAccent)
                }
            },
        )
    }

    if (showManualRelayV2Enrollment) {
        ManualRelayV2EnrollmentDialog(
            onDismiss = { showManualRelayV2Enrollment = false },
            onContinue = { issuerUrl, oneTimeEnrollmentToken ->
                showManualRelayV2Enrollment = false
                onManualRelayV2Enrollment(issuerUrl, oneTimeEnrollmentToken)
            },
        )
    }
}
