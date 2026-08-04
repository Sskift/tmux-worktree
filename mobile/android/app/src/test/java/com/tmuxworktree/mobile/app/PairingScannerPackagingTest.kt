package com.tmuxworktree.mobile.app

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingScannerPackagingTest {
    @Test
    fun `scanner uses an APK bundled model without optional Play services modules`() {
        val appDir = findAppProjectDir()
        val buildScript = appDir.resolve("build.gradle.kts").readText()
        val manifest = appDir.resolve("src/main/AndroidManifest.xml").readText()

        assertTrue(buildScript.contains("com.google.mlkit:barcode-scanning:17.3.0"))
        assertTrue(buildScript.contains("androidx.camera:camera-camera2"))
        assertTrue(buildScript.contains("androidx.camera:camera-lifecycle"))
        assertTrue(buildScript.contains("androidx.camera:camera-view"))
        assertFalse(buildScript.contains("play-services-code-scanner"))
        assertFalse(buildScript.contains("play-services-mlkit-barcode-scanning"))
        assertFalse(manifest.contains("com.google.mlkit.vision.DEPENDENCIES"))
        assertFalse(manifest.contains("barcode_ui"))
        assertNotNull(Class.forName("com.google.mlkit.vision.barcode.BarcodeScanning"))
        assertTrue(
            runCatching {
                Class.forName("com.google.mlkit.vision.codescanner.GmsBarcodeScanning")
            }.isFailure,
        )
    }

    private fun findAppProjectDir(): File {
        val start = File(checkNotNull(System.getProperty("user.dir"))).absoluteFile
        return generateSequence(start) { it.parentFile }
            .flatMap { dir ->
                sequenceOf(
                    dir,
                    dir.resolve("app"),
                    dir.resolve("mobile/android/app"),
                )
            }
            .first { candidate ->
                candidate.resolve("build.gradle.kts").isFile &&
                    candidate.resolve("src/main/AndroidManifest.xml").isFile
            }
    }
}
