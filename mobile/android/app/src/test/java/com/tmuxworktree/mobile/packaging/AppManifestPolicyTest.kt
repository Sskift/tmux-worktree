package com.tmuxworktree.mobile.packaging

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Document
import org.w3c.dom.Element

class AppManifestPolicyTest {
    @Test
    fun `V2Activity owns the launcher and the legacy activity remains internal`() {
        val manifest = parseXml(appProjectDir.resolve("src/main/AndroidManifest.xml"))
        val application = manifest.elements("application").single()
        val activities = application.elements("activity")
        val v2Activity = activities.single { it.androidAttribute("name") == ".V2Activity" }
        val legacyActivity = activities.single { it.androidAttribute("name") == ".MainActivity" }

        assertEquals("true", v2Activity.androidAttribute("exported"))
        assertEquals("singleTask", v2Activity.androidAttribute("launchMode"))
        assertTrue(v2Activity.intentActions().contains(ACTION_MAIN))
        assertTrue(v2Activity.intentCategories().contains(CATEGORY_LAUNCHER))

        assertEquals("false", legacyActivity.androidAttribute("exported"))
        assertFalse(legacyActivity.intentActions().contains(ACTION_MAIN))

        val launcherActivities = activities.filter {
            it.intentActions().contains(ACTION_MAIN) &&
                it.intentCategories().contains(CATEGORY_LAUNCHER)
        }
        assertEquals(listOf(".V2Activity"), launcherActivities.map { it.androidAttribute("name") })
    }

    @Test
    fun `backup and device transfer exclude all private app state`() {
        val manifest = parseXml(appProjectDir.resolve("src/main/AndroidManifest.xml"))
        val application = manifest.elements("application").single()

        assertEquals("false", application.androidAttribute("allowBackup"))
        assertEquals("@xml/backup_rules", application.androidAttribute("fullBackupContent"))
        assertEquals(
            "@xml/data_extraction_rules",
            application.androidAttribute("dataExtractionRules"),
        )

        val legacyRules = parseXml(appProjectDir.resolve("src/main/res/xml/backup_rules.xml"))
        val extractionRules = parseXml(
            appProjectDir.resolve("src/main/res/xml/data_extraction_rules.xml"),
        )

        assertEquals("full-backup-content", legacyRules.documentElement.tagName)
        assertRequiredExclusions(legacyRules.documentElement, "legacy backup")

        val extractionRoot = extractionRules.documentElement
        assertEquals("data-extraction-rules", extractionRoot.tagName)
        assertRequiredExclusions(extractionRoot.directElement("cloud-backup"), "cloud backup")
        assertRequiredExclusions(extractionRoot.directElement("device-transfer"), "device transfer")
    }

    private fun assertRequiredExclusions(container: Element, label: String) {
        val exclusions = container.elements("exclude").map {
            it.getAttribute("domain") to it.getAttribute("path")
        }.toSet()

        PRIVATE_STORAGE_DOMAINS.forEach { domain ->
            assertTrue("$label must exclude $domain", exclusions.contains(domain to "."))
        }
    }

    private fun parseXml(file: File): Document {
        assertTrue("missing Android packaging input: $file", file.isFile)
        return DocumentBuilderFactory.newInstance().apply {
            isNamespaceAware = true
            isExpandEntityReferences = false
            setFeature("http://apache.org/xml/features/disallow-doctype-decl", true)
        }.newDocumentBuilder().parse(file)
    }

    private fun Document.elements(tagName: String): List<Element> =
        documentElement.elements(tagName)

    private fun Element.elements(tagName: String): List<Element> {
        val nodes = getElementsByTagName(tagName)
        return (0 until nodes.length).map { nodes.item(it) as Element }
    }

    private fun Element.directElement(tagName: String): Element =
        (0 until childNodes.length)
            .map { childNodes.item(it) }
            .filterIsInstance<Element>()
            .single { it.tagName == tagName }

    private fun Element.androidAttribute(name: String): String =
        getAttributeNS(ANDROID_NAMESPACE, name)

    private fun Element.intentActions(): Set<String> =
        elements("action").map { it.androidAttribute("name") }.toSet()

    private fun Element.intentCategories(): Set<String> =
        elements("category").map { it.androidAttribute("name") }.toSet()

    private val appProjectDir: File by lazy {
        val start = File(checkNotNull(System.getProperty("user.dir"))).absoluteFile
        generateSequence(start) { it.parentFile }
            .flatMap { directory ->
                sequenceOf(
                    directory,
                    directory.resolve("app"),
                    directory.resolve("mobile/android/app"),
                )
            }
            .first { candidate ->
                candidate.resolve("build.gradle.kts").isFile &&
                    candidate.resolve("src/main/AndroidManifest.xml").isFile
            }
    }

    private companion object {
        const val ANDROID_NAMESPACE = "http://schemas.android.com/apk/res/android"
        const val ACTION_MAIN = "android.intent.action.MAIN"
        const val CATEGORY_LAUNCHER = "android.intent.category.LAUNCHER"

        val PRIVATE_STORAGE_DOMAINS = setOf(
            "root",
            "file",
            "database",
            "sharedpref",
            "external",
            "device_root",
            "device_file",
            "device_database",
            "device_sharedpref",
        )
    }
}
