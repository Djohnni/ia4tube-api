package br.com.ia4tube.app.core.config

import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class EnvironmentRequestPolicyTest {
    private val policy = EnvironmentRequestPolicy(
        isStaging = true,
        apiBase = STAGING_BASE,
        fcmRegistrationEnabled = false,
        mobileAnalyticsEnabled = false,
        paymentsEnabled = false,
        supportEnabled = false
    )

    @Test
    fun acceptsOrdinaryHttpsRequestsToStagingOnly() {
        assertNull(policy.rejectionCode("$STAGING_BASE/health".toHttpUrl()))
        assertEquals(
            "STAGING_ORIGIN_BLOCKED",
            policy.rejectionCode("https://ia4tube-api.onrender.com/health".toHttpUrl())
        )
        assertEquals(
            "STAGING_ORIGIN_BLOCKED",
            policy.rejectionCode("http://ia4tube-api-staging-checkpoint-a.onrender.com/health".toHttpUrl())
        )
    }

    @Test
    fun blocksAutomaticAndExternallyEffectiveRoutes() {
        val blocked = mapOf(
            "/me/fcm-token" to "STAGING_FCM_BLOCKED",
            "/evento" to "STAGING_ANALYTICS_BLOCKED",
            "/suporte/chat" to "STAGING_SUPPORT_BLOCKED",
            "/pedidos/synthetic-1/pagamento-info" to "STAGING_PAYMENT_BLOCKED",
            "/pedidos/synthetic-1/gerar-pix" to "STAGING_PAYMENT_BLOCKED",
            "/pedidos/synthetic-1/pagar-com-saldo" to "STAGING_PAYMENT_BLOCKED",
            "/billing/saldo/pix" to "STAGING_PAYMENT_BLOCKED",
            "/billing/arte-avulsa/pix" to "STAGING_PAYMENT_BLOCKED",
            "/billing/planos/synthetic/pix" to "STAGING_PAYMENT_BLOCKED"
        )

        blocked.forEach { (path, expected) ->
            assertEquals(expected, policy.rejectionCode("$STAGING_BASE$path".toHttpUrl()))
        }
    }

    @Test
    fun productionPolicyDoesNotChangeExistingNetworkBehavior() {
        val productionPolicy = EnvironmentRequestPolicy(
            isStaging = false,
            apiBase = "https://ia4tube-api.onrender.com",
            fcmRegistrationEnabled = true,
            mobileAnalyticsEnabled = true,
            paymentsEnabled = true,
            supportEnabled = true
        )

        assertNull(
            productionPolicy.rejectionCode(
                "https://ia4tube-api.onrender.com/billing/planos/pro/pix".toHttpUrl()
            )
        )
    }

    private companion object {
        const val STAGING_BASE = "https://ia4tube-api-staging-checkpoint-a.onrender.com"
    }
}
