package br.com.ia4tube.app.feature.calendar.imports

import android.app.Application
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Android's JSONObject differs from the JVM library; test the actual Android serializer too. */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, application = Application::class, sdk = [28])
class ImportPreparationAndroidJsonTest {
    @Test fun imageMimeSlashMatchesExactServerFingerprintOnAndroid() {
        val record = ImportPreparationProtocol.parseRecord(ImportPreparationTestData.status("ready"))
        assertEquals(ImportPreparationTestData.knownDigest, record.previewDigest)
    }
    @Test fun videoMimeAndSharedTargetsMatchExactServerFingerprintOnAndroid() {
        val record = ImportPreparationProtocol.parseRecord(ImportPreparationTestData.videoStatus())
        assertEquals("48fc62f7a9c7e3df077fc36745ca0259610ad9adea306c846fbebaf6b06e5067", record.previewDigest)
    }
}
