package br.com.ia4tube.app.testinfra

import android.app.Application
import android.content.pm.PackageManager
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.util.Properties
import java.util.zip.ZipFile

/** The UI fixture may load resource bytes, but must never boot product components. */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, application = Application::class, sdk = [28])
class LocalUiResourceIsolationTest {
    @Before fun explicitFixtureMode() {
        assumeTrue("Only the dedicated local UI resource fixture is under test",
            java.lang.Boolean.getBoolean("ia4tube.localUiResources"))
    }

    @Test fun applicationAndPackageContainNoProductInitializersOrEntryPoints() {
        val app = RuntimeEnvironment.getApplication()
        assertEquals(Application::class.java, app.javaClass)
        // The package is retained only so compiled R ids keep their original resource namespace.
        assertEquals("com.ia4tube.app", app.packageName)
        val info = app.packageManager.getPackageInfo(app.packageName,
            PackageManager.GET_PROVIDERS or PackageManager.GET_SERVICES or PackageManager.GET_RECEIVERS or
                PackageManager.GET_ACTIVITIES or PackageManager.GET_PERMISSIONS or PackageManager.GET_META_DATA)
        assertTrue(info.providers.isNullOrEmpty())
        assertTrue(info.services.isNullOrEmpty())
        assertTrue(info.receivers.isNullOrEmpty())
        assertTrue(info.activities.isNullOrEmpty())
        assertTrue(info.permissions.isNullOrEmpty())
        assertTrue(info.requestedPermissions.isNullOrEmpty())
        assertNull(info.applicationInfo!!.metaData)
        assertEquals(Application::class.java.name, info.applicationInfo!!.className)
        assertNull(info.applicationInfo!!.appComponentFactory)
    }

    @Test fun composeResourcesExistButTheFixtureHasNoCodeAssetsOrProductManifest() {
        val configs = LocalUiResourceIsolationTest::class.java.classLoader!!
            .getResources("com/android/tools/test_config.properties").asSequence().toList()
        // Robolectric's sandbox and parent enumerate the same URL twice. Require one actual
        // config file, not one classloader reference; a second AGP config must still fail.
        val configFiles = configs.map { java.io.File(it.toURI()).canonicalFile }.toSet()
        assertEquals("There must be no fallback to the AGP product configuration: $configs", 1, configFiles.size)
        assertTrue(configFiles.single().path.contains("local-ui-resource-fixture"))
        val props = Properties().apply {
            LocalUiResourceIsolationTest::class.java.classLoader!!
                .getResourceAsStream("com/android/tools/test_config.properties")!!.use(::load)
        }
        val apk = java.io.File(props.getProperty("android_resource_apk"))
        assertTrue(apk.canonicalPath.contains("local-ui-resource-fixture"))
        assertTrue(props.getProperty("android_merged_manifest").replace('\\', '/')
            .endsWith("src/test/fixtures/ui-resources/AndroidManifest.xml"))
        ZipFile(apk).use { zip ->
            val entries = zip.entries().asSequence().map { it.name }.toList()
            assertTrue(entries.contains("AndroidManifest.xml"))
            assertTrue(entries.contains("resources.arsc"))
            assertTrue(entries.all { it == "AndroidManifest.xml" || it == "resources.arsc" || it.startsWith("res/") })
        }
        assertTrue(RuntimeEnvironment.getApplication().resources
            .getResourceName(androidx.compose.ui.R.id.hide_in_inspector_tag).endsWith(":id/hide_in_inspector_tag"))
    }
}
