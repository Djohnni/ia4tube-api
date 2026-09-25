package br.com.ia4tube.app.feature.monthly_planning

import org.junit.Assert.assertEquals
import org.junit.Test

class MonthlyPlanningSubmissionQuantityTest {
    @Test
    fun zeroMonthlyArtsStillSubmitsOneActiveArtToTheServer() {
        val state = MonthlyPlanningUiState(
            currentFreeArts = 0,
            photos = listOf(MonthlyPlanningPhotoDraft(id = "one", number = 1, objetivo = "Divulgar produto"))
        )

        assertEquals(1, state.submissionQuantity)
    }

    @Test
    fun submissionQuantityTracksActiveArtsInsteadOfMonthlyBalance() {
        val state = MonthlyPlanningUiState(
            currentFreeArts = 1,
            photos = listOf(
                MonthlyPlanningPhotoDraft(id = "one", number = 1, objetivo = "Produto A"),
                MonthlyPlanningPhotoDraft(id = "two", number = 2, objetivo = "Produto B")
            )
        )

        assertEquals(2, state.submissionQuantity)
    }

    @Test
    fun emptyDraftDoesNotBecomeAChargedArt() {
        val state = MonthlyPlanningUiState(currentFreeArts = 0)

        assertEquals(0, state.submissionQuantity)
    }
}
