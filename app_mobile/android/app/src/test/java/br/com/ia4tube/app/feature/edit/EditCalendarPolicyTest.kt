package br.com.ia4tube.app.feature.edit

import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

class EditCalendarPolicyTest {
    private val request = "56336c2f-53a8-4db0-996d-317088f1c827"
    private val nonce = "A".repeat(43)
    private val page = EDIT_URL + "#video/example"
    private val callback = EDIT_URL + "app-calendar/request?requestId=$request&nonce=$nonce"

    @Test fun onlyExactSameOriginMainFrameAndCurrentNonceCanRequestCalendar() {
        assertEquals(request, EditCalendarPolicy.requestId(callback, page, true, nonce))
        for ((target, current) in listOf(
            callback.replace("ia4tube.com", "evil.example") to page,
            callback.replace("ia4tube.com", "www.ia4tube.com") to page,
            callback.replace("https:", "http:") to page,
            callback.replace("ia4tube.com", "user@ia4tube.com") to page,
            callback.replace("ia4tube.com", "ia4tube.com:444") to page,
            "$callback&nonce=$nonce" to page,
            "$callback&extra=yes" to page,
            "$callback#fragment" to page,
            callback.replace(nonce, "B".repeat(43)) to page,
            callback.replace(request, "not-a-request") to page,
            callback to "https://evil.example/edit/",
            callback to "https://ia4tube.com/politica-de-privacidade/",
            callback to "https://ia4tube.com/edit/another-document",
        )) assertNull(target, EditCalendarPolicy.requestId(target, current, true, nonce))
        assertNull(EditCalendarPolicy.requestId(callback, page, false, nonce))
    }

    @Test fun scheduleUsesBrasiliaAndRejectsPastDatesAndMalformedInput() {
        val now = Instant.parse("2026-10-28T19:00:00Z") // 16:00 Brasília.
        assertTrue(EditCalendarSchedule("2026-10-28", "16:01").isFuture(now))
        assertFalse(EditCalendarSchedule("2026-10-28", "16:00").isFuture(now))
        assertFalse(EditCalendarSchedule("2026-10-28", "15:59").isFuture(now))
        assertFalse(EditCalendarSchedule("2026-02-30", "18:00").isFuture(now))
        assertFalse(EditCalendarSchedule("2026-10-29", "25:00").isFuture(now))
        assertFalse(EditCalendarSchedule("2026-10-29", "1:00").isFuture(now))
    }

    @Test fun ticketIsBoundedOpaqueCapabilityNotAnArbitraryUrlOrScript() {
        assertTrue(EditCalendarPolicy.validTicket("$request.${"b".repeat(43)}"))
        assertFalse(EditCalendarPolicy.validTicket("https://example.test/$request"))
        assertFalse(EditCalendarPolicy.validTicket("$request.${"b".repeat(44)}"))
        assertFalse(EditCalendarPolicy.validTicket("$request.';alert(1)//"))
    }
}
