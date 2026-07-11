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
import com.tmuxworktree.mobile.ui.TwAccent
import com.tmuxworktree.mobile.ui.TwBackground
import com.tmuxworktree.mobile.ui.TwBorder
import com.tmuxworktree.mobile.ui.TwError
import com.tmuxworktree.mobile.ui.TwOnAccent
import com.tmuxworktree.mobile.ui.TwTextPrimary
import com.tmuxworktree.mobile.ui.TwTextSecondary

@Composable
fun PairingScreen(
    relayUrl: String,
    token: String,
    isConnecting: Boolean,
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
            text = "Open Mobile pairing in tw-dashboard on your Mac, then scan the code or enter the connection details.",
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
            placeholder = { Text("wss://relay.example.com") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
            colors = pairingFieldColors(),
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
            enabled = relayUrl.isNotBlank() && token.isNotBlank() && !isConnecting,
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
            containerColor = com.tmuxworktree.mobile.ui.TwSurface,
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
