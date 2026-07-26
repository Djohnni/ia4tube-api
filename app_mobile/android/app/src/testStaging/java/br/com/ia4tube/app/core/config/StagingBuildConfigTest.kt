package br.com.ia4tube.app.core.config

import br.com.ia4tube.app.BuildConfig
import br.com.ia4tube.app.data.api.PreviewUrlBuilder
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class StagingBuildConfigTest {
    @Test
    fun stagingIdentityAndSafetyFlagsAreFixed() {
        assertEquals("com.ia4tube.app.staging", BuildConfig.APPLICATION_ID)
        assertEquals(28, BuildConfig.VERSION_CODE)
        assertEquals("0.2.16-staging", BuildConfig.VERSION_NAME)
        assertEquals(STAGING_BASE, AppConfig.apiBase)
        assertEquals(STAGING_BASE, AppConfig.productDiscoveryApiBase)
        assertTrue(AppConfig.isStaging)
        assertFalse(AppConfig.fcmRegistrationEnabled)
        assertFalse(AppConfig.notificationsEnabled)
        assertFalse(AppConfig.mobileAnalyticsEnabled)
        assertFalse(AppConfig.paymentsEnabled)
        assertFalse(AppConfig.supportEnabled)
        assertFalse(AppConfig.appUpdateEnabled)
        assertTrue(AppConfig.playStoreUrl.isBlank())
        assertTrue(AppConfig.supportUrl.isBlank())
    }

    @Test
    fun previewUrlsCannotCrossFromStagingToProduction() {
        val pedidoId = "synthetic-order"
        assertEquals(
            "$STAGING_BASE/pedidos/$pedidoId/preview",
            PreviewUrlBuilder.build(
                pedidoId,
                "https://ia4tube-api.onrender.com/pedidos/$pedidoId/preview"
            )
        )
        assertEquals(
            "$STAGING_BASE/pedidos/$pedidoId/preview",
            PreviewUrlBuilder.build(
                pedidoId,
                "$STAGING_BASE/pedidos/$pedidoId/preview"
            )
        )
    }

    private companion object {
        const val STAGING_BASE = "https://ia4tube-api-staging-checkpoint-a.onrender.com"
    }
}
