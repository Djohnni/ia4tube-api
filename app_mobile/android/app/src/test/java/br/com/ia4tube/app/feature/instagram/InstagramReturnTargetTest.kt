package br.com.ia4tube.app.feature.instagram

import org.junit.Assert.*
import org.junit.Test

class InstagramReturnTargetTest {
    @Test fun exactViewLinkCreatesOnlyANavigationEvent() {
        val first = parseInstagramReturnTarget("android.intent.action.VIEW", INSTAGRAM_RETURN_URI)
        val second = parseInstagramReturnTarget("android.intent.action.VIEW", INSTAGRAM_RETURN_URI)
        assertNotNull(first)
        assertNotNull(second)
        assertTrue(InstagramPolicies.validUuid(first!!.nonce))
        assertNotEquals(first.nonce, second!!.nonce)
    }

    @Test fun otherActionsAndMissingValuesCannotCreateAReturnEvent() {
        for (action in listOf(null, "", "android.intent.action.MAIN", "android.intent.action.SEND",
            "br.com.ia4tube.app.OPEN_ART_READY", "android.intent.action.VIEW ")) {
            assertNull(parseInstagramReturnTarget(action, INSTAGRAM_RETURN_URI))
        }
        assertNull(parseInstagramReturnTarget("android.intent.action.VIEW", null))
    }

    @Test fun noAuthorizationMaterialOrResultCanBeCarriedByTheLink() {
        for (suffix in listOf("?", "#", "?code=synthetic", "?state=synthetic", "?token=synthetic",
            "?success=true", "?status=authorization_completed", "?account=another", "#success", "/", "/extra")) {
            assertNull(suffix, parseInstagramReturnTarget("android.intent.action.VIEW", INSTAGRAM_RETURN_URI + suffix))
        }
    }

    @Test fun otherHostsSchemesEncodingsAndAmbiguousUrisAreRejected() {
        for (uri in listOf("", " ia4tube://instagram/oauth-return", "ia4tube://instagram/oauth-return\n",
            "IA4TUBE://instagram/oauth-return", "ia4tube://INSTAGRAM/oauth-return",
            "https://instagram/oauth-return", "ia4tube://instagram.example/oauth-return",
            "ia4tube://user@instagram/oauth-return", "ia4tube://instagram:443/oauth-return",
            "ia4tube://instagram//oauth-return", "ia4tube://instagram/%6fauth-return",
            "ia4tube://instagram/path/../oauth-return", "ia4tube:instagram/oauth-return",
            "ia4tube://instagram\\oauth-return", "ia4tube://instagram/oauth-return%3Fcode%3Dsynthetic")) {
            assertNull(uri, parseInstagramReturnTarget("android.intent.action.VIEW", uri))
        }
    }
}
