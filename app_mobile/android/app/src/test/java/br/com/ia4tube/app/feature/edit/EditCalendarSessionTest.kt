package br.com.ia4tube.app.feature.edit

import org.junit.Assert.*
import org.junit.Test
import java.time.LocalDate

class EditCalendarSessionTest {
    @Test fun accountReplacementInvalidatesTheDocumentNonceScheduleAndAnyPendingReply() {
        val state = EditCalendarViewModel()
        state.synchronizeSession("first-account-token")
        state.chooseSchedule(EditCalendarSchedule(LocalDate.now().plusDays(1).toString(), "18:00"), "first-account-token")
        val originalNonce = state.nonce
        assertNotNull(state.schedule)
        assertFalse(state.synchronizeSession("first-account-token"))
        assertEquals(originalNonce, state.nonce)
        assertTrue(state.synchronizeSession("second-account-token"))
        assertNotEquals(originalNonce, state.nonce)
        assertNull(state.schedule)
        assertNull(state.reply)
        assertFalse(state.busy)
    }

    @Test fun unauthenticatedOrderIsReturnedToNativeLoginWithoutCreatingCalendarContext() {
        val state = EditCalendarViewModel()
        state.synchronizeSession("")
        state.request("56336c2f-53a8-4db0-996d-317088f1c827", "")
        val failure = requireNotNull(state.reply)
        assertEquals("auth_required", failure.error)
        assertNull(failure.ticket)
        assertTrue(state.canDeliver(failure, ""))
        assertFalse(state.canDeliver(failure, "other-account-token"))
        assertFalse(state.busy)
        state.delivered(failure)
        assertNull(state.reply)
    }

    @Test fun dismissingDateSelectionPreservesFormAndReturnsCorrelatedCancellation() {
        val state = EditCalendarViewModel()
        state.synchronizeSession("local-test-token")
        val request = "56336c2f-53a8-4db0-996d-317088f1c827"
        state.request(request, "local-test-token")
        assertTrue(state.choosingSchedule)
        assertFalse(state.busy)
        state.cancelSchedule()
        assertEquals(request, state.reply?.requestId)
        assertEquals("cancelled", state.reply?.error)
        assertFalse(state.choosingSchedule)
    }
}
