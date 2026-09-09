package br.com.ia4tube.app.core.art_cache

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

/** The local expiry guard is not signature validation; the server still authenticates. */
class PrivateArtSessionTest {
    @Test fun futureExpiryAllowsTheLocalCacheGuard() {
        assertTrue(unexpiredSessionToken(token("{\"exp\":${NOW + 60}}"), NOW))
    }

    @Test fun expiryAtTheBoundaryOrEarlierIsRejected() {
        listOf(NOW, NOW - 1, 0L, -1L).forEach { expiry ->
            assertFalse("Expiry $expiry must be rejected", unexpiredSessionToken(token("{\"exp\":$expiry}"), NOW))
        }
    }

    @Test fun missingOrBlankTokenSegmentsAreRejected() {
        listOf("", " ", "one", "one.two", "one.two.three.four", ".payload.signature",
            "header..signature", "header.payload.", "header. .signature").forEach {
            assertFalse(unexpiredSessionToken(it, NOW))
        }
    }

    @Test fun invalidEncodingAndNonJsonPayloadsAreRejected() {
        listOf("header.%%%.signature", "header.A.signature", token("not-json"), token("[1,2]"),
            token("{\"exp\":"), token("")).forEach {
            assertFalse(unexpiredSessionToken(it, NOW))
        }
    }

    @Test fun absentOrNonNumericExpiryIsRejected() {
        listOf("{}", "{\"exp\":null}", "{\"exp\":false}", "{\"exp\":\"not-a-number\"}",
            "{\"exp\":{}}", "{\"exp\":[]}").forEach {
            assertFalse(unexpiredSessionToken(token(it), NOW))
        }
    }

    @Test fun oversizedTokensAreRejectedEvenWithAFutureExpiry() {
        val oversized = "h".repeat(16_384) + "." + encode("{\"exp\":${NOW + 60}}") + ".signature"
        assertFalse(unexpiredSessionToken(oversized, NOW))
    }

    private fun token(claims: String) = encode("{\"alg\":\"HS256\",\"typ\":\"JWT\"}") +
        "." + encode(claims) + "." + encode("synthetic-test-signature")

    private fun encode(value: String) = Base64.getUrlEncoder().withoutPadding()
        .encodeToString(value.toByteArray(Charsets.UTF_8))

    private companion object { const val NOW = 1_700_000_000L }
}
