package br.com.ia4tube.app.feature.calendar.imports

import android.app.Application
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.security.MessageDigest

/** Real backend DTO serializer/policy; only storage/worker are in-memory fakes.
 * Resource emitted 2026-09-23 by production-social-candidate/tests/helpers/
 * android-feed-restore-contract-fixture.js, using API614's unchanged queue/policy.
 * This proves neither real media processing nor the production HTTP response. */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, application = Application::class, sdk = [28])
class ImportOperationalFeedBackendContractTest {
    @Test fun android46ParsesFeedReadyRecordEmittedByBackendQueueWithoutMusicOrSimulation() {
        val bytes = requireNotNull(javaClass.classLoader!!.getResourceAsStream("gallery-import-feed-ready-contract.json")).use { it.readBytes() }
        require(bytes.size < 16384)
        val sha = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        assertEquals("e5b553427ceb7db8d720a0c044493c414fbc7ba228fa6e5d5199b36435b81d01", sha)
        val result = JSONObject(String(bytes, Charsets.UTF_8))
        assertFalse(result.getBoolean("realMedia"))
        val payload = result.getJSONObject("asset")
        val record = ImportPreparationProtocol.parseRecord(payload)
        assertEquals(ImportPreparationPhase.READY, record.phase)
        assertEquals(ImportMediaKind.IMAGE, record.kind)
        assertEquals(setOf(ImportTarget.FEED), record.configuration!!.targets)
        assertEquals(ImportAudioMode.NONE, record.configuration.audioMode)
        assertFalse(record.configuration.shareToFeed)
        assertFalse(record.testOnly)
        assertEquals(1L, record.mediaRevision)
        assertEquals(record.mediaRevision, record.currentRevision)
        assertEquals(payload.getString("previewDigest"), ImportPreparationProtocol.fingerprint(
            record.kind!!, record.configuration, record.testOnly, record.variants))
        assertNull(record.variants.single().durationMs)
        assertFalse(record.variants.single().hasAudio)
    }
}
