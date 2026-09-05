package br.com.ia4tube.app.feature.instagram

import org.junit.Assert.*
import org.junit.Test
import java.net.URLEncoder

class InstagramPoliciesTest {
    @Test fun productionOriginCannotFallBackToStagingOrCleartext() {
        assertTrue(InstagramPolicies.isOfficialApiBase(InstagramPolicies.OFFICIAL_API_ORIGIN))
        listOf("http://ia4tube-api.onrender.com", "https://ia4tube-api-staging-checkpoint-a.onrender.com",
            "https://ia4tube-api.onrender.com.evil.example", "https://user@ia4tube-api.onrender.com",
            "https://ia4tube-api.onrender.com/path", "https://ia4tube-api.onrender.com?x=1",
            "https://ia4tube-api.onrender.com#fragment", "https://ia4tube-api.onrender.com:443")
            .forEach { assertFalse(it, InstagramPolicies.isOfficialApiBase(it)) }
    }

    @Test fun officialAuthorizationRequiresExactScopesAndProductionCallback() {
        assertTrue(InstagramPolicies.isOfficialAuthorizationUrl(authorizationUrl()))
        val callback = InstagramPolicies.OFFICIAL_API_ORIGIN + "/v1/social/oauth/callback"
        listOf(
            authorizationUrl().replace("www.instagram.com", "www.instagram.com.evil.example"),
            authorizationUrl().replace("https://www", "http://www"),
            authorizationUrl().replace("https://www", "https://user@www"),
            authorizationUrl() + "#access_token=secret",
            authorizationUrl() + "&scope=instagram_business_basic",
            authorizationUrl().replace("instagram_business_content_publish", "extra_scope"),
            authorizationUrl().replace("instagram_business_content_publish", "instagram_business_basic"),
            authorizationUrl().replace(encode(callback), encode(callback.replace("ia4tube-api.", "ia4tube-api-staging-checkpoint-a."))),
            authorizationUrl().replace(encode(callback), encode("https://evil.example/callback")),
            authorizationUrl().replace("state=" + "x".repeat(40), "state=short")
        ).forEach { assertFalse(it, InstagramPolicies.isOfficialAuthorizationUrl(it)) }
    }

    @Test fun onlyCanonicalInstagramPublicationLinksCanBeOpened() {
        assertTrue(InstagramPolicies.isOfficialPermalink("https://www.instagram.com/p/AbCdE_123/"))
        assertTrue(InstagramPolicies.isOfficialPermalink("https://www.instagram.com/p/AbC/"))
        assertTrue(InstagramPolicies.isOfficialPermalink("https://www.instagram.com/p/${"a".repeat(100)}/"))
        assertFalse(InstagramPolicies.isOfficialPermalink("https://www.instagram.com/p/Ab/"))
        assertFalse(InstagramPolicies.isOfficialPermalink("https://www.instagram.com/p/${"a".repeat(101)}/"))
        listOf("https://www.instagram.com/p/AbCdE_123/?redirect=bad", "https://instagram.com/p/AbCdE_123/",
            "https://user@www.instagram.com/p/AbCdE_123/", "https://www.instagram.com/p/AbCdE_123/#x",
            "http://www.instagram.com/p/AbCdE_123/", "https://www.instagram.com.evil.example/p/AbCdE_123/")
            .forEach { assertFalse(InstagramPolicies.isOfficialPermalink(it)) }
    }

    @Test fun captionsPreserveServerMarkerSpaceAndRejectControlsOrUntrimmedInput() {
        assertTrue(InstagramPolicies.validCaption("Legenda\nSegunda linha"))
        assertTrue(InstagramPolicies.validCaption("a".repeat(2150)))
        listOf("", " ", " legenda", "legenda ", "a\u0000b", "a".repeat(2151))
            .forEach { assertFalse(InstagramPolicies.validCaption(it)) }
    }

    @Test fun jpegEnvelopeRequiresExactDimensionsScanAndEndWithoutTrailingData() {
        val jpeg = jpegEnvelope()
        assertTrue(InstagramPolicies.validateJpeg(jpeg))
        assertFalse(InstagramPolicies.validateJpeg(jpegEnvelope(width = 1079)))
        assertFalse(InstagramPolicies.validateJpeg(jpegEnvelope(height = 1079)))
        assertFalse(InstagramPolicies.validateJpeg(jpeg.copyOf(jpeg.size - 1)))
        assertFalse(InstagramPolicies.validateJpeg(jpeg + byteArrayOf(0)))
        assertFalse(InstagramPolicies.validateJpeg(jpeg.copyOfRange(0, 21) + byteArrayOf(0xff.toByte(), 0xd9.toByte())))
        assertFalse(InstagramPolicies.validateJpeg(ByteArray(InstagramPolicies.MAX_JPEG_BYTES + 1)))
        assertFalse(InstagramPolicies.validateJpeg(byteArrayOf(1, 2, 3)))
    }

    @Test fun sessionPartitionIsOpaqueAndChangesWhenSessionChanges() {
        val key = InstagramPolicies.sessionKey("session-one")
        assertEquals(64, key.length)
        assertEquals(key, InstagramPolicies.sessionKey("session-one"))
        assertNotEquals(key, InstagramPolicies.sessionKey("session-two"))
        assertEquals("", InstagramPolicies.sessionKey(""))
        assertFalse(key.contains("session-one"))
    }

    companion object {
        internal fun authorizationUrl(): String = "https://www.instagram.com/oauth/authorize?" +
            "client_id=12345678&enable_fb_login=0&redirect_uri=" +
            encode(InstagramPolicies.OFFICIAL_API_ORIGIN + "/v1/social/oauth/callback") +
            "&response_type=code&scope=instagram_business_basic,instagram_business_content_publish&state=" + "x".repeat(40)

        private fun encode(value: String) = URLEncoder.encode(value, "UTF-8")

        // Structural fixture only; the screen also decodes the user's image before upload.
        internal fun jpegEnvelope(width: Int = 1080, height: Int = 1080): ByteArray = byteArrayOf(
            0xff.toByte(), 0xd8.toByte(), 0xff.toByte(), 0xc0.toByte(), 0, 17, 8,
            (height shr 8).toByte(), height.toByte(), (width shr 8).toByte(), width.toByte(), 3,
            1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0,
            0xff.toByte(), 0xda.toByte(), 0, 12, 3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0,
            1, 0xff.toByte(), 0xd9.toByte()
        )
    }
}
