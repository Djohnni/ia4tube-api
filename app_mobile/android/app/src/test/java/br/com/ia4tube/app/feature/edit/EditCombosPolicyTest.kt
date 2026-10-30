package br.com.ia4tube.app.feature.edit

import org.junit.Assert.*
import org.junit.Test

class EditCombosPolicyTest {
    private val nonce = "A".repeat(43)
    private val page = EDIT_URL + "?app_version=88#app-calendar=$nonce"
    private val callback = EDIT_URL + "app-combos/open?nonce=$nonce"

    @Test fun aRealMainFrameClickFromTheCurrentExactEditDocumentCanOpenOnlyItsCombosCallback() {
        assertTrue(EditCombosPolicy.canOpen(callback, page, true, true, nonce))
        assertTrue(EditCombosPolicy.canOpen(callback, page.replace("/edit/?", "/edit?"), true, true, nonce))
        assertTrue(EditCombosPolicy.canOpen(callback.replace("ia4tube.com", "www.ia4tube.com"),
            page.replace("ia4tube.com", "www.ia4tube.com"), true, true, nonce))
        assertTrue(EditCombosPolicy.canOpen(callback.replace("ia4tube.com", "ia4tube.com:443"), page, true, true, nonce))
    }

    @Test fun framesAndScriptNavigationsWithoutAUserGestureNeverOpenNativePlans() {
        assertFalse(EditCombosPolicy.canOpen(callback, page, false, true, nonce))
        assertFalse(EditCombosPolicy.canOpen(callback, page, true, false, nonce))
        assertFalse(EditCombosPolicy.canOpen(callback, page, false, false, nonce))
    }

    @Test fun untrustedOriginsOtherDocumentsAndCrossHostAliasesCannotUseTheCallback() {
        for ((target, current) in listOf(
            callback.replace("ia4tube.com", "evil.example") to page,
            callback.replace("ia4tube.com", "ia4tube.com.attacker.test") to page,
            callback.replace("ia4tube.com", "www.ia4tube.com") to page,
            callback.replace("https:", "http:") to page,
            callback.replace("ia4tube.com", "user@ia4tube.com") to page,
            callback.replace("ia4tube.com", "ia4tube.com:444") to page,
            callback to "https://evil.example/edit/",
            callback to "https://ia4tube.com/",
            callback to "https://ia4tube.com/edit/index.html",
            callback to "https://ia4tube.com/edit/another-document",
            callback to callback,
            callback.replace("app-combos", "%61pp-combos") to page,
        )) assertFalse(target + " from " + current, EditCombosPolicy.canOpen(target, current, true, true, nonce))
    }

    @Test fun theOnlyQueryIsTheExactCurrentNonceWithoutEncodingExtrasOrAFragment() {
        for (target in listOf(
            callback.substringBefore('?'), "$callback&nonce=$nonce", "$callback&route=plans", "$callback&requestId=other",
            "$callback#fragment", "$callback#", callback.replace("nonce=", "nonce=%41"),
            callback.replace("nonce=", "%6eonce="), callback.replace(nonce, "B".repeat(43)),
            callback.replace(nonce, "A".repeat(42)), callback.replace("?nonce=", "?nonce"),
        )) assertFalse(target, EditCombosPolicy.canOpen(target, page, true, true, nonce))
        assertFalse(EditCombosPolicy.canOpen(null, page, true, true, nonce))
        assertFalse(EditCombosPolicy.canOpen(callback, null, true, true, nonce))
        assertFalse(EditCombosPolicy.canOpen(callback, page, true, true, "short"))
    }

    @Test fun aPreviousAccountOrDocumentNonceCannotBeReplayedAfterTheNativeOwnerChanges() {
        val currentNonce = "B".repeat(43)
        assertFalse(EditCombosPolicy.canOpen(callback, page, true, true, currentNonce))
        assertTrue(EditCombosPolicy.canOpen(callback.replace(nonce, currentNonce),
            page.replace(nonce, currentNonce), true, true, currentNonce))
    }

    @Test fun combosNavigationDoesNotInterceptCalendarOrAvailabilityCapabilities() {
        val calendar = EDIT_URL + "app-calendar/request?requestId=56336c2f-53a8-4db0-996d-317088f1c827&nonce=$nonce"
        val availability = calendar.replace("app-calendar", "app-availability")
        assertTrue(EditCombosPolicy.isCallback(callback))
        assertFalse(EditCombosPolicy.isCallback(calendar)); assertFalse(EditCombosPolicy.isCallback(availability))
        assertFalse(EditCalendarPolicy.isCallback(callback)); assertFalse(EditAvailabilityPolicy.isCallback(callback))
        assertFalse(EditCombosPolicy.canOpen(calendar, page, true, true, nonce))
        assertFalse(EditCombosPolicy.canOpen(availability, page, true, true, nonce))
        assertNotNull(EditCalendarPolicy.requestId(calendar, page, true, nonce))
        assertNotNull(EditAvailabilityPolicy.requestId(availability, page, true, nonce))
        assertEquals(EditNavigation.BLOCK, EditNavigationPolicy.decide("ia4tube://plans", page, true, true))
    }
}
