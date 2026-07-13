package com.tmuxworktree.mobile.app

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SensitivePairingPolicyTest {
    @Test
    fun `pairing intake path has no application logging calls`() {
        val appDir = findAppProjectDir()
        val sensitiveSources = listOf(
            "src/main/java/com/tmuxworktree/mobile/MainActivity.java",
            "src/main/java/com/tmuxworktree/mobile/V2Activity.kt",
            "src/main/java/com/tmuxworktree/mobile/app/PairingPayload.kt",
            "src/main/java/com/tmuxworktree/mobile/app/V2ViewModel.kt",
        ).joinToString("\n") { appDir.resolve(it).readText() }
        val forbiddenLogging = listOf(
            "android.util.Log",
            "Log.",
            "println(",
            "printStackTrace(",
            "Timber.",
            "Crashlytics",
            "Sentry",
        )

        forbiddenLogging.forEach { call ->
            assertFalse("Pairing intake must not log via $call", sensitiveSources.contains(call))
        }
    }

    @Test
    fun `Room schema and DataStore keys have no relay credential column`() {
        val appDir = findAppProjectDir()
        val roomSchema = appDir.resolve(
            "schemas/com.tmuxworktree.mobile.core.data.TwDatabase/1.json",
        ).readText()
        val persistedRoomFields = Regex("\\\"fieldPath\\\"\\s*:\\s*\\\"([^\\\"]+)\\\"")
            .findAll(roomSchema)
            .map { it.groupValues[1].lowercase() }
            .toList()
        val preferencesSource = appDir.resolve(
            "src/main/java/com/tmuxworktree/mobile/core/data/PreferencesStore.kt",
        ).readText()
        val persistedPreferenceKeys = Regex("[A-Za-z]*PreferencesKey\\(\\\"([^\\\"]+)\\\"\\)")
            .findAll(preferencesSource)
            .map { it.groupValues[1].lowercase() }
            .toList()

        assertTrue("Expected Room fields in the checked schema", persistedRoomFields.isNotEmpty())
        assertTrue("Expected DataStore keys in PreferencesStore", persistedPreferenceKeys.isNotEmpty())
        (persistedRoomFields + persistedPreferenceKeys).forEach { field ->
            assertFalse("Credential-like persistent field: $field", field.contains("secret"))
            assertFalse("Credential-like persistent field: $field", field.contains("token"))
            assertFalse("Credential-like persistent field: $field", field.contains("credential"))
        }
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
