package br.com.ia4tube.app.feature.calendar.imports

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

/** Synthetic signatures are syntax fixtures only; no Google request is sent. */
internal object ImportGoogleStorageTestData {
    const val bucket = "synthetic-private-bucket"
    const val generation = "1234567890123456"
    fun profile() = JSONObject().put("bucket", bucket).put("objectPrefix", "ready-video/")
    fun signedUrl(now: Long, method: String = "GET", signedHeaders: String =
        if (method == "PUT") "content-md5;content-type;host;x-goog-if-generation-match" else "host"): HttpUrl {
        val date = DateTimeFormatter.ofPattern("uuuuMMdd'T'HHmmss'Z'").withZone(ZoneOffset.UTC).format(Instant.ofEpochMilli(now))
        return "https://storage.googleapis.com/$bucket/ready-video/synthetic/part.bin".toHttpUrl().newBuilder()
            .addQueryParameter("X-Goog-Algorithm", "GOOG4-RSA-SHA256")
            .addQueryParameter("X-Goog-Credential", "synthetic@synthetic-project.iam.gserviceaccount.com/${date.take(8)}/auto/storage/goog4_request")
            .addQueryParameter("X-Goog-Date", date).addQueryParameter("X-Goog-Expires", "60")
            .addQueryParameter("X-Goog-SignedHeaders", signedHeaders).addQueryParameter("X-Goog-Signature", "ab".repeat(256))
            .apply { if (method == "GET") addQueryParameter("generation", generation) }.build()
    }
    fun download(now: Long) = JSONObject().put("url", signedUrl(now).toString()).put("expiresAt", now + 60_000)
        .put("generation", generation)
}

class ImportGoogleStoragePolicyTest {
    private val now = 1_798_400_000_000L
    private val fixture = ImportGoogleStorageTestData
    private val profile = ImportGoogleStoragePolicy.parseProfile(fixture.profile())
    private fun valid(url: HttpUrl, method: String = "GET") = ImportGoogleStoragePolicy.validateSignedUrl(url, profile, now + 60_000, now, method)
    private fun reject(action: () -> Unit) = assertThrows(Exception::class.java, action)

    @Test fun exactPrivateProfileAndFiniteSignedGetAndPutAreAcceptedWithoutExposingTheGrant() {
        valid(fixture.signedUrl(now)); valid(fixture.signedUrl(now, "PUT"), "PUT")
        val grant = ImportGoogleStoragePolicy.parseDownload(fixture.download(now), profile, now)
        assertEquals(fixture.generation, grant.generation)
        assertFalse(grant.toString().contains("X-Goog")); assertFalse(profile.toString().contains(fixture.bucket))
    }
    @Test fun foreignHostsPortsBucketsAndObjectPrefixesNeverBroadenTheProfile() {
        val url = fixture.signedUrl(now)
        val forged = listOf(url.newBuilder().host("storage.googleapis.com.attacker.invalid").build(),
            url.newBuilder().scheme("http").build(), url.newBuilder().port(444).build(),
            url.newBuilder().username("user").build(), url.newBuilder().fragment("fragment").build(),
            url.newBuilder().encodedPath("/other-bucket/ready-video/file.mp4").build(),
            url.newBuilder().encodedPath("/${fixture.bucket}/another-prefix/file.mp4").build(),
            url.newBuilder().encodedPath("/${fixture.bucket}/ready-video/part%2fescape").build())
        forged.forEach { reject { valid(it) } }
        reject { ImportGoogleStoragePolicy.parseProfile(fixture.profile().put("objectPrefix", "")) }
    }
    @Test fun duplicateUnknownQueryFieldsAndInvalidSignaturesAreRejected() {
        val url = fixture.signedUrl(now)
        listOf(url.newBuilder().addQueryParameter("X-Goog-Expires", "60").build(),
            url.newBuilder().addQueryParameter("unexpected", "secret").build(),
            url.newBuilder().setQueryParameter("X-Goog-Signature", "invalid").build(),
            url.newBuilder().setQueryParameter("X-Goog-Algorithm", "GOOG4-HMAC-SHA256").build(),
            url.newBuilder().setQueryParameter("X-Goog-Credential", "foreign/auto/storage/goog4_request").build())
            .forEach { reject { valid(it) } }
    }
    @Test fun expiryMustMatchSignedExpiryAndCannotExceedFifteenMinutes() {
        val url = fixture.signedUrl(now)
        reject { ImportGoogleStoragePolicy.validateSignedUrl(url, profile, now + 120_000, now, "GET") }
        reject { ImportGoogleStoragePolicy.validateSignedUrl(url, profile, now + 60_000, now + 60_001, "GET") }
        reject { valid(url.newBuilder().setQueryParameter("X-Goog-Expires", "901").build()) }
        reject { valid(url.newBuilder().setQueryParameter("X-Goog-Date", "20260230T010000Z").build()) }
    }
    @Test fun uploadsRequireSignedMd5TypeAndAnyRequestedGenerationPrecondition() {
        reject { valid(fixture.signedUrl(now, "PUT", "host"), "PUT") }
        reject { valid(fixture.signedUrl(now, "PUT", "content-md5;content-type;host;authorization"), "PUT") }
        reject { valid(fixture.signedUrl(now, "PUT", "host;content-md5;content-type"), "PUT") }
        reject { ImportGoogleStoragePolicy.validateSignedUrl(fixture.signedUrl(now, "PUT", "content-md5;content-type;host"),
            profile, now + 60_000, now, "PUT", setOf("x-goog-if-generation-match")) }
    }
    @Test fun downloadGenerationMustBeExactAndDoesNotAcceptMissingProfileOrNumericCoercion() {
        reject { ImportGoogleStoragePolicy.parseDownload(fixture.download(now), null, now) }
        reject { ImportGoogleStoragePolicy.parseDownload(fixture.download(now).put("generation", "999"), profile, now) }
        reject { ImportGoogleStoragePolicy.parseDownload(fixture.download(now).put("generation", 1234567890123456L), profile, now) }
        reject { ImportGoogleStoragePolicy.parseDownload(fixture.download(now).put("expiresAt", now + 60_000.5), profile, now) }
        reject { valid(fixture.signedUrl(now, "GET", "content-type;host")) }
    }
    @Test fun invalidUrlParserCannotExposeASignedUrlOrCauseThroughCalendarErrors() {
        val error = reject { ImportGoogleStoragePolicy.parseDownload(fixture.download(now)
            .put("url", "mailto:synthetic?X-Goog-Signature=do-not-leak"), profile, now) }
        assertFalse(error.toString().contains("do-not-leak")); assertFalse(error.toString().contains("X-Goog"))
        assertNull(error.cause)
    }
}
