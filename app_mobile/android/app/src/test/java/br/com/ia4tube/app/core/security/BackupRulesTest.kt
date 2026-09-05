package br.com.ia4tube.app.core.security

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element

/** Static regression checks only: never invokes backup, restore or device storage. */
class BackupRulesTest {
    @Test fun manifestKeepsBackupDisabledAndReferencesBothRuleFormats() {
        val manifest = readXml("AndroidManifest.xml")
        val application = manifest.getElementsByTagName("application").item(0) as Element
        val androidNamespace = "http://schemas.android.com/apk/res/android"

        assertEquals("false", application.getAttributeNS(androidNamespace, "allowBackup"))
        assertEquals("@xml/backup_rules", application.getAttributeNS(androidNamespace, "fullBackupContent"))
        assertEquals("@xml/data_extraction_rules", application.getAttributeNS(androidNamespace, "dataExtractionRules"))
    }

    @Test fun legacyRulesExcludeEveryLocalStorageDomain() {
        val rules = readXml("res/xml/backup_rules.xml")
        assertEquals("full-backup-content", rules.tagName)
        assertAllDomainsExcluded(rules)
    }

    @Test fun android12RulesExcludeEveryDomainFromCloudAndDeviceTransferSeparately() {
        val rules = readXml("res/xml/data_extraction_rules.xml")
        assertEquals("data-extraction-rules", rules.tagName)
        val sections = childElements(rules)
        assertEquals(setOf("cloud-backup", "device-transfer"), sections.map { it.tagName }.toSet())
        assertEquals(2, sections.size)
        sections.forEach(::assertAllDomainsExcluded)
    }

    private fun assertAllDomainsExcluded(section: Element) {
        val exclusions = childElements(section)
        assertEquals(DOMAINS.size, exclusions.size)
        assertTrue(exclusions.all { it.tagName == "exclude" })
        assertTrue(exclusions.all { it.getAttribute("path") == "." })
        assertEquals(DOMAINS, exclusions.map { it.getAttribute("domain") }.toSet())
    }

    private fun childElements(parent: Element): List<Element> =
        (0 until parent.childNodes.length).mapNotNull { parent.childNodes.item(it) as? Element }

    private fun readXml(relativePath: String): Element {
        val file = File("src/main", relativePath)
        assertTrue("Missing source configuration: $relativePath", file.isFile)
        val factory = DocumentBuilderFactory.newInstance().apply {
            isNamespaceAware = true
            setFeature("http://apache.org/xml/features/disallow-doctype-decl", true)
            setFeature("http://xml.org/sax/features/external-general-entities", false)
            setFeature("http://xml.org/sax/features/external-parameter-entities", false)
        }
        return factory.newDocumentBuilder().parse(file).documentElement
    }

    private companion object {
        val DOMAINS = setOf(
            "root", "file", "database", "sharedpref", "external",
            "device_root", "device_file", "device_database", "device_sharedpref"
        )
    }
}
