package com.tmuxworktree.mobile.feature.pairing

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.OptIn as AndroidxOptIn
import androidx.camera.core.CameraSelector
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.common.InputImage
import com.tmuxworktree.mobile.designsystem.TwAccent
import com.tmuxworktree.mobile.designsystem.TwBackground
import com.tmuxworktree.mobile.designsystem.TwOnAccent
import com.tmuxworktree.mobile.designsystem.TwTextPrimary
import com.tmuxworktree.mobile.designsystem.TwTextSecondary
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * In-app Relay v1 QR scanner backed by CameraX and ML Kit's APK-bundled model.
 * No Google Play services optional scanner or recognition module is used here.
 */
@Composable
fun PairingQrScanner(
    onQrCode: (String) -> Unit,
    onDismiss: () -> Unit,
    onError: (String) -> Unit,
) {
    val context = LocalContext.current
    var permissionGranted by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
                PackageManager.PERMISSION_GRANTED,
        )
    }
    var permissionRequested by rememberSaveable { mutableStateOf(false) }
    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted -> permissionGranted = granted }

    LaunchedEffect(permissionGranted, permissionRequested) {
        if (!permissionGranted && !permissionRequested) {
            permissionRequested = true
            permissionLauncher.launch(Manifest.permission.CAMERA)
        }
    }

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(
            usePlatformDefaultWidth = false,
            decorFitsSystemWindows = false,
        ),
    ) {
        Surface(
            color = TwBackground,
            modifier = Modifier.fillMaxSize().testTag("pairing_qr_scanner"),
        ) {
            if (permissionGranted) {
                ScannerPreview(
                    onQrCode = onQrCode,
                    onError = onError,
                    onDismiss = onDismiss,
                )
            } else {
                CameraPermissionRequired(
                    onRequestPermission = {
                        permissionRequested = true
                        permissionLauncher.launch(Manifest.permission.CAMERA)
                    },
                    onDismiss = onDismiss,
                )
            }
        }
    }
}

@Composable
@AndroidxOptIn(markerClass = [ExperimentalGetImage::class])
private fun ScannerPreview(
    onQrCode: (String) -> Unit,
    onError: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val currentOnQrCode by rememberUpdatedState(onQrCode)
    val currentOnError by rememberUpdatedState(onError)
    val previewView = remember {
        PreviewView(context).apply {
            implementationMode = PreviewView.ImplementationMode.COMPATIBLE
            scaleType = PreviewView.ScaleType.FILL_CENTER
        }
    }

    DisposableEffect(context, lifecycleOwner, previewView) {
        val mainExecutor = ContextCompat.getMainExecutor(context)
        val analysisExecutor = Executors.newSingleThreadExecutor { runnable ->
            Thread(runnable, "tw-relay-v1-qr-scanner").apply { isDaemon = true }
        }
        val scanner = BarcodeScanning.getClient(
            BarcodeScannerOptions.Builder()
                .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
                .build(),
        )
        val providerFuture = ProcessCameraProvider.getInstance(context)
        val disposed = AtomicBoolean(false)
        val completed = AtomicBoolean(false)
        val consecutiveFailures = AtomicInteger(0)
        var provider: ProcessCameraProvider? = null
        var preview: Preview? = null
        var analysis: ImageAnalysis? = null

        providerFuture.addListener(
            {
                if (disposed.get()) return@addListener
                try {
                    provider = providerFuture.get()
                    preview = Preview.Builder().build().also {
                        it.surfaceProvider = previewView.surfaceProvider
                    }
                    analysis = ImageAnalysis.Builder()
                        .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                        .build()
                        .also { useCase ->
                            useCase.setAnalyzer(analysisExecutor) { imageProxy ->
                                val mediaImage = imageProxy.image
                                if (mediaImage == null || completed.get() || disposed.get()) {
                                    imageProxy.close()
                                    return@setAnalyzer
                                }
                                val inputImage = InputImage.fromMediaImage(
                                    mediaImage,
                                    imageProxy.imageInfo.rotationDegrees,
                                )
                                scanner.process(inputImage)
                                    .addOnSuccessListener(mainExecutor) { barcodes ->
                                        consecutiveFailures.set(0)
                                        val rawValue = barcodes.firstNotNullOfOrNull { it.rawValue }
                                        if (!disposed.get() && rawValue != null &&
                                            completed.compareAndSet(false, true)
                                        ) {
                                            currentOnQrCode(rawValue)
                                        }
                                    }
                                    .addOnFailureListener(mainExecutor) {
                                        if (!disposed.get() &&
                                            consecutiveFailures.incrementAndGet() >= 3 &&
                                            completed.compareAndSet(false, true)
                                        ) {
                                            currentOnError(
                                                "The camera opened, but the QR reader could not start. " +
                                                    "Enter the Relay v1 connection details manually.",
                                            )
                                        }
                                    }
                                    .addOnCompleteListener(mainExecutor) { imageProxy.close() }
                            }
                        }
                    provider?.unbindAll()
                    provider?.bindToLifecycle(
                        lifecycleOwner,
                        CameraSelector.DEFAULT_BACK_CAMERA,
                        preview,
                        analysis,
                    )
                } catch (_: Exception) {
                    if (!disposed.get() && completed.compareAndSet(false, true)) {
                        mainExecutor.execute {
                            currentOnError(
                                "The camera is unavailable. Enter the Relay v1 connection details manually.",
                            )
                        }
                    }
                }
            },
            mainExecutor,
        )

        onDispose {
            disposed.set(true)
            analysis?.clearAnalyzer()
            val activeUseCases = listOfNotNull(preview, analysis).toTypedArray()
            if (activeUseCases.isNotEmpty()) provider?.unbind(*activeUseCases)
            scanner.close()
            analysisExecutor.shutdownNow()
        }
    }

    Box(Modifier.fillMaxSize()) {
        AndroidView(
            factory = { previewView },
            modifier = Modifier.fillMaxSize().testTag("pairing_qr_preview"),
        )
        Box(
            modifier = Modifier
                .align(Alignment.Center)
                .size(260.dp)
                .border(3.dp, TwAccent, MaterialTheme.shapes.large),
        )
        Column(
            modifier = Modifier
                .align(Alignment.TopCenter)
                .fillMaxWidth()
                .background(Color.Black.copy(alpha = 0.58f))
                .padding(horizontal = 16.dp, vertical = 28.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = "Scan Relay v1 profile",
                    color = Color.White,
                    style = MaterialTheme.typography.titleLarge,
                )
                IconButton(onClick = onDismiss, modifier = Modifier.testTag("pairing_qr_close")) {
                    Icon(Icons.Outlined.Close, contentDescription = "Close scanner", tint = Color.White)
                }
            }
            Text(
                text = "Keep the Dashboard QR code inside the frame.",
                color = Color.White.copy(alpha = 0.82f),
                style = MaterialTheme.typography.bodyMedium,
            )
        }
    }
}

@Composable
private fun CameraPermissionRequired(
    onRequestPermission: () -> Unit,
    onDismiss: () -> Unit,
) {
    Column(
        modifier = Modifier.fillMaxSize().padding(horizontal = 28.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = "Camera access is needed to scan the Relay v1 profile",
            color = TwTextPrimary,
            style = MaterialTheme.typography.headlineSmall,
        )
        Spacer(Modifier.height(12.dp))
        Text(
            text = "You can still close the scanner and enter the connection details manually.",
            color = TwTextSecondary,
            style = MaterialTheme.typography.bodyLarge,
        )
        Spacer(Modifier.height(28.dp))
        Button(
            onClick = onRequestPermission,
            colors = ButtonDefaults.buttonColors(
                containerColor = TwAccent,
                contentColor = TwOnAccent,
            ),
            modifier = Modifier.fillMaxWidth().testTag("pairing_qr_request_camera"),
        ) {
            Text("Grant camera access")
        }
        Spacer(Modifier.height(12.dp))
        Button(
            onClick = onDismiss,
            colors = ButtonDefaults.buttonColors(
                containerColor = Color.Transparent,
                contentColor = TwAccent,
            ),
            modifier = Modifier.fillMaxWidth().testTag("pairing_qr_cancel"),
        ) {
            Text("Enter details manually")
        }
    }
}
