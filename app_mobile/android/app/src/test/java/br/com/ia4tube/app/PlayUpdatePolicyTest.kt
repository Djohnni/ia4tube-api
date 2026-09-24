package br.com.ia4tube.app

import br.com.ia4tube.app.data.models.AppVersionInfo
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PlayUpdatePolicyTest {
    private fun backend(latest: Int, minimum: Int, required: Boolean = false) = AppVersionInfo(
        latestVersionCode = latest,
        minimumVersionCode = minimum,
        latestVersionName = "",
        updateRequired = required,
        title = "",
        message = "",
        playStoreUrl = ""
    )

    @Test fun staleBackendCodeDoesNotSuppressRealPlayUpdate() {
        assertTrue(shouldOfferPlayUpdate(true, true, 55, 54, 0))
        assertFalse(backendRequiresPlayUpdate(backend(5, 1), 54, 55))
    }

    @Test fun playEligibilityAndDismissalControlOptionalPrompt() {
        assertFalse(shouldOfferPlayUpdate(false, true, 55, 54, 0))
        assertFalse(shouldOfferPlayUpdate(true, false, 55, 54, 0))
        assertFalse(shouldOfferPlayUpdate(true, true, 54, 54, 0))
        assertFalse(shouldOfferPlayUpdate(true, true, 55, 54, 55))
        assertTrue(shouldOfferPlayUpdate(true, true, 56, 54, 55))
    }

    @Test fun internalOnlyMinimumDoesNotBlockPublicVersion() {
        assertFalse(backendRequiresPlayUpdate(backend(57, 57), 54, 55))
        assertTrue(backendRequiresPlayUpdate(backend(57, 57), 54, 57))
        assertFalse(backendRequiresPlayUpdate(backend(57, 57), 54, 57, 57))
        assertTrue(backendRequiresPlayUpdate(backend(58, 58), 54, 58, 57))
        assertFalse(backendRequiresPlayUpdate(backend(57, 1, required = true), 54, 55))
        assertTrue(backendRequiresPlayUpdate(backend(57, 1, required = true), 54, 57))
    }
}
