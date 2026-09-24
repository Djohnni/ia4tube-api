package br.com.ia4tube.app.feature.home

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HomeFirstFreeArtModeTest {
    private val freeOffer = HomeUiState(
        firstFreeArtActive = true,
        firstFreeArtAvailable = true,
        firstFreeArtUsed = false
    )

    @Test fun activePlanDoesNotLockHomeEvenWhenMonthlyBalanceIsEmpty() {
        assertFalse(freeOffer.copy(planoStatus = "active", planoNome = "Profissional")
            .firstFreeArtMode(isLoggedIn = true))
        assertFalse(freeOffer.copy(planoStatus = "Ativo")
            .firstFreeArtMode(isLoggedIn = true))
    }

    @Test fun courtesyStandaloneCreditsDoNotLockHome() {
        assertFalse(freeOffer.copy(artesAvulsasRestantes = 40)
            .firstFreeArtMode(isLoggedIn = true))
    }

    @Test fun monthlyCreditsDoNotLockHomeWithoutPlanMetadata() {
        assertFalse(freeOffer.copy(artesMensaisRestantes = 1)
            .firstFreeArtMode(isLoggedIn = true))
    }

    @Test fun visitorStillUsesFirstFreeArtMode() {
        assertTrue(HomeUiState().firstFreeArtMode(isLoggedIn = false))
    }

    @Test fun genuinelyNewEligibleAccountStillUsesFirstFreeArtMode() {
        assertTrue(freeOffer.firstFreeArtMode(isLoggedIn = true))
    }

    @Test fun unavailableOrUsedFreeOfferDoesNotLockLoggedInAccount() {
        assertFalse(freeOffer.copy(firstFreeArtAvailable = false)
            .firstFreeArtMode(isLoggedIn = true))
        assertFalse(freeOffer.copy(firstFreeArtUsed = true)
            .firstFreeArtMode(isLoggedIn = true))
    }
}
