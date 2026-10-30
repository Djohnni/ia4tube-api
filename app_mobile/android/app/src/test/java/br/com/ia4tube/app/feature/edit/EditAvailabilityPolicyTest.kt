package br.com.ia4tube.app.feature.edit

import br.com.ia4tube.app.BuildConfig
import org.junit.Assert.*
import org.junit.Test
import java.net.URI

class EditAvailabilityPolicyTest {
    private val request = "56336c2f-53a8-4db0-996d-317088f1c827"
    private val nonce = "A".repeat(43)
    private val page = EDIT_URL + "#video/synthetic-model"
    private val callback = EDIT_URL + "app-availability/request?requestId=$request&nonce=$nonce"

    @Test fun exactDocumentMainFrameAndNoncePermitOnlyTheCorrelatedRequest() {
        assertEquals(request, EditAvailabilityPolicy.requestId(callback, page, true, nonce))
        assertEquals(request, EditAvailabilityPolicy.requestId(
            EDIT_URL + "app-availability/request?nonce=$nonce&requestId=$request", page, true, nonce))
        assertEquals(request, EditAvailabilityPolicy.requestId(callback.replace("ia4tube.com", "www.ia4tube.com"),
            page.replace("ia4tube.com", "www.ia4tube.com"), true, nonce))
        assertNull(EditAvailabilityPolicy.requestId(callback, page, false, nonce))
    }

    @Test fun originCredentialsPortsAndOtherDocumentsCannotReadAccountAvailability() {
        for ((target, current) in listOf(
            callback.replace("ia4tube.com", "evil.example") to page,
            callback.replace("ia4tube.com", "www.ia4tube.com") to page,
            callback.replace("https:", "http:") to page,
            callback.replace("ia4tube.com", "user@ia4tube.com") to page,
            callback.replace("ia4tube.com", "ia4tube.com:444") to page,
            callback to "https://evil.example/edit/",
            callback to "https://ia4tube.com/politica-de-privacidade/",
            callback to "https://ia4tube.com/edit/another-document",
            callback.replace("app-availability", "%61pp-availability") to page,
        )) assertNull(target, EditAvailabilityPolicy.requestId(target, current, true, nonce))
    }

    @Test fun queryIsExactBoundedAndCannotReplayAnOldDocumentNonce() {
        for (target in listOf(
            "$callback&nonce=$nonce", "$callback&requestId=$request", "$callback&extra=yes",
            "$callback#fragment", "$callback#", callback.substringBefore('?'),
            callback.replace(nonce, "B".repeat(43)), callback.replace(request, "not-a-request"),
            callback.replace("requestId=", "requestId=%35"), callback.replace("nonce=", "nonce=%41"),
            callback.replace("&nonce=", "&nonce"),
        )) assertNull(target, EditAvailabilityPolicy.requestId(target, page, true, nonce))
        assertNull(EditAvailabilityPolicy.requestId(callback, page, true, "short"))
        assertNull(EditAvailabilityPolicy.requestId(null, page, true, nonce))
    }

    @Test fun availabilityCallbackCannotInterceptTheExistingCalendarCapabilityFlow() {
        val calendar = callback.replace("app-availability", "app-calendar")
        assertTrue(EditAvailabilityPolicy.isCallback(callback))
        assertFalse(EditAvailabilityPolicy.isCallback(calendar))
        assertNull(EditAvailabilityPolicy.requestId(calendar, page, true, nonce))
        assertTrue(EditCalendarPolicy.isCallback(calendar))
        assertFalse(EditCalendarPolicy.isCallback(callback))
        assertEquals(request, EditCalendarPolicy.requestId(calendar, page, true, nonce))
    }

    @Test fun versionedEntryRemainsTheSameTrustedDocumentForBothExistingBridges() {
        val entry = EditAvailabilityPolicy.entryUrl(nonce)
        val parsed = URI(entry)
        assertEquals("https", parsed.scheme)
        assertEquals("ia4tube.com", parsed.host)
        assertEquals("/edit/", parsed.rawPath)
        assertEquals("app_version=${BuildConfig.VERSION_CODE}", parsed.rawQuery)
        assertEquals("app-calendar=$nonce", parsed.rawFragment)
        assertNull(parsed.rawUserInfo)
        assertEquals(EditNavigation.IN_WEBVIEW, EditNavigationPolicy.decide(entry, entry, true, false))
        assertTrue(EditCalendarPolicy.isDocument(entry))
        assertEquals(request, EditAvailabilityPolicy.requestId(callback, entry, true, nonce))
        val calendar = callback.replace("app-availability", "app-calendar")
        assertEquals(request, EditCalendarPolicy.requestId(calendar, entry, true, nonce))
        try { EditAvailabilityPolicy.entryUrl("short&token=synthetic"); fail("Invalid entry nonce accepted") }
        catch (_: IllegalArgumentException) { /* Invalid input must never become URL metadata. */ }
    }
}
