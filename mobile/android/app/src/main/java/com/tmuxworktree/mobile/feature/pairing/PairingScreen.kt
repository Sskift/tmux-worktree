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
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material.icons.outlined.Security
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.tmuxworktree.mobile.designsystem.TwAccent
import com.tmuxworktree.mobile.designsystem.TwBackground
import com.tmuxworktree.mobile.designsystem.TwBorder
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
            .padding(horizontal = 24.dp, vertical = 32.dp)
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
    relayUrl: String,
    token: String,
    isConnecting: Boolean,
    relayUrlError: String?,
    error: String?,
    onRelayUrlChange: (String) -> Unit,
    onTokenChange: (String) -> Unit,
    onScanQr: () -> Unit,
    onConnect: () -> Unit,
    modifier: Modifier = Modifier,
    onBack: (() -> Unit)? = null,
    onForgetPairing: (() -> Unit)? = null,
) {
    var confirmForgetPairing by rememberSaveable { mutableStateOf(false) }

    Column(
        modifier = modifier
            .fillMaxSize()
            .statusBarsPadding()
            .navigationBarsPadding()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 24.dp, vertical = 32.dp)
            .testTag("pairing_screen"),
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
            Spacer(Modifier.height(12.dp))
        } else {
            Spacer(Modifier.height(28.dp))
        }
        Text(
            text = "Connect your computer",
            color = TwTextPrimary,
            style = MaterialTheme.typography.headlineMedium,
            modifier = Modifier.semantics { heading() },
        )
        Spacer(Modifier.height(12.dp))
        Text(
            text = "Open Mobile pairing in tw-dashboard on your Mac, then scan the Relay v1 profile or enter the connection details.",
            color = TwTextSecondary,
            style = MaterialTheme.typography.bodyLarge,
        )
        Spacer(Modifier.height(32.dp))

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

        Spacer(Modifier.height(28.dp))
        Text(
            text = "Manual connection",
            color = TwTextPrimary,
            style = MaterialTheme.typography.titleMedium,
            modifier = Modifier.semantics { heading() },
        )
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(
            value = relayUrl,
            onValueChange = onRelayUrlChange,
            label = { Text("Relay URL") },
            placeholder = { Text("wss://devbox.example.net") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
            colors = pairingFieldColors(),
            supportingText = relayUrlError?.let { message ->
                { Text(message, color = MaterialTheme.colorScheme.error) }
            },
            isError = relayUrlError != null,
            modifier = Modifier
                .fillMaxWidth()
                .testTag("pairing_relay_url"),
        )
        Spacer(Modifier.height(16.dp))
        OutlinedTextField(
            value = token,
            onValueChange = onTokenChange,
            label = { Text("Pairing token") },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            colors = pairingFieldColors(),
            supportingText = error?.let { message ->
                { Text(message, color = MaterialTheme.colorScheme.error) }
            },
            isError = error != null,
            modifier = Modifier
                .fillMaxWidth()
                .testTag("pairing_token"),
        )
        Spacer(Modifier.height(20.dp))
        OutlinedButton(
            onClick = onConnect,
            enabled = relayUrl.isNotBlank() && token.isNotBlank() &&
                relayUrlError == null && !isConnecting,
            colors = ButtonDefaults.outlinedButtonColors(contentColor = TwAccent),
            modifier = Modifier
                .fillMaxWidth()
                .height(52.dp)
                .testTag("pairing_connect"),
        ) {
            Text(if (isConnecting) "Connecting…" else "Connect")
        }

        Spacer(Modifier.height(28.dp))
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
                text = "Your credential is encrypted with Android Keystore. WSS is required so the token and terminal content stay encrypted in transit.",
                color = TwTextSecondary,
                style = MaterialTheme.typography.bodyMedium,
            )
        }

        if (onForgetPairing != null) {
            Spacer(Modifier.height(28.dp))
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
                    "Cached sessions, drafts, and unsent messages for this computer will be removed from this phone.",
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
}

@Composable
private fun pairingFieldColors() = OutlinedTextFieldDefaults.colors(
    focusedTextColor = TwTextPrimary,
    unfocusedTextColor = TwTextPrimary,
    focusedBorderColor = TwAccent,
    unfocusedBorderColor = TwBorder,
    focusedLabelColor = TwAccent,
    unfocusedLabelColor = TwTextSecondary,
    cursorColor = TwAccent,
    focusedContainerColor = Color.Transparent,
    unfocusedContainerColor = TwBackground,
)
