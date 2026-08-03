package com.tmuxworktree.mobile.feature.pairing

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.tmuxworktree.mobile.designsystem.TwAccent
import com.tmuxworktree.mobile.designsystem.TwBorder
import com.tmuxworktree.mobile.designsystem.TwSurface
import com.tmuxworktree.mobile.designsystem.TwTextPrimary
import com.tmuxworktree.mobile.designsystem.TwTextSecondary

@Composable
internal fun ManualRelayV2EnrollmentDialog(
    onDismiss: () -> Unit,
    onContinue: (issuerUrl: String, oneTimeEnrollmentToken: String) -> Unit,
) {
    // Enrollment input is deliberately not saveable: process/activity recreation must discard it.
    var issuerUrl by remember { mutableStateOf("") }
    var oneTimeEnrollmentToken by remember { mutableStateOf("") }

    fun clearAndDismiss() {
        issuerUrl = ""
        oneTimeEnrollmentToken = ""
        onDismiss()
    }

    AlertDialog(
        onDismissRequest = ::clearAndDismiss,
        containerColor = TwSurface,
        title = { Text("Manual Relay v2 enrollment", color = TwTextPrimary) },
        text = {
            Column {
                Text(
                    "Enter the issuer shown by your relay and paste the complete one-time " +
                        "tmuxworktree://enroll token. Nothing is redeemed until review confirmation.",
                    color = TwTextSecondary,
                    style = MaterialTheme.typography.bodyMedium,
                )
                Spacer(Modifier.height(16.dp))
                OutlinedTextField(
                    value = issuerUrl,
                    onValueChange = { issuerUrl = it },
                    label = { Text("Relay issuer / base URL") },
                    placeholder = { Text("https://relay.example.com") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                    colors = manualEnrollmentFieldColors(),
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("relay_v2_manual_issuer"),
                )
                Spacer(Modifier.height(12.dp))
                OutlinedTextField(
                    value = oneTimeEnrollmentToken,
                    onValueChange = { oneTimeEnrollmentToken = it },
                    label = { Text("One-time enrollment token") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                    colors = manualEnrollmentFieldColors(),
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("relay_v2_manual_token"),
                )
            }
        },
        confirmButton = {
            TextButton(
                enabled = issuerUrl.isNotBlank() && oneTimeEnrollmentToken.isNotBlank(),
                onClick = {
                    val submittedIssuerUrl = issuerUrl.trim()
                    val submittedToken = oneTimeEnrollmentToken
                    issuerUrl = ""
                    oneTimeEnrollmentToken = ""
                    onContinue(submittedIssuerUrl, submittedToken)
                },
                modifier = Modifier.testTag("relay_v2_manual_continue"),
            ) {
                Text("Review", color = TwAccent)
            }
        },
        dismissButton = {
            TextButton(
                onClick = ::clearAndDismiss,
                modifier = Modifier.testTag("relay_v2_manual_cancel"),
            ) {
                Text("Cancel", color = TwAccent)
            }
        },
    )
}

@Composable
private fun manualEnrollmentFieldColors() = OutlinedTextFieldDefaults.colors(
    focusedTextColor = TwTextPrimary,
    unfocusedTextColor = TwTextPrimary,
    focusedBorderColor = TwAccent,
    unfocusedBorderColor = TwBorder,
    focusedLabelColor = TwAccent,
    unfocusedLabelColor = TwTextSecondary,
    cursorColor = TwAccent,
    focusedContainerColor = Color.Transparent,
    unfocusedContainerColor = Color.Transparent,
)
