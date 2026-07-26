package br.com.ia4tube.app.core.config

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Interceptor
import okhttp3.Response
import java.io.IOException

internal class EnvironmentRequestPolicy(
    private val isStaging: Boolean,
    apiBase: String,
    private val fcmRegistrationEnabled: Boolean,
    private val mobileAnalyticsEnabled: Boolean,
    private val paymentsEnabled: Boolean,
    private val supportEnabled: Boolean
) {
    private val allowedOrigin = apiBase.toHttpUrl()

    fun rejectionCode(url: HttpUrl): String? {
        if (!isStaging) return null
        if (
            url.scheme != "https" ||
            url.host != allowedOrigin.host ||
            url.port != allowedOrigin.port
        ) {
            return "STAGING_ORIGIN_BLOCKED"
        }

        val path = url.encodedPath
        return when {
            !fcmRegistrationEnabled && path == "/me/fcm-token" ->
                "STAGING_FCM_BLOCKED"
            !mobileAnalyticsEnabled && path == "/evento" ->
                "STAGING_ANALYTICS_BLOCKED"
            !supportEnabled && path.startsWith("/suporte/") ->
                "STAGING_SUPPORT_BLOCKED"
            !paymentsEnabled && isPaymentPath(path) ->
                "STAGING_PAYMENT_BLOCKED"
            else -> null
        }
    }

    private fun isPaymentPath(path: String): Boolean {
        return path.matches(Regex("^/pedidos/[^/]+/(pagamento-info|gerar-pix|pagar-com-saldo)$")) ||
            path.matches(Regex("^/billing/(saldo|arte-avulsa)/pix$")) ||
            path.matches(Regex("^/billing/planos/[^/]+/pix$"))
    }
}

internal class EnvironmentIsolationInterceptor(
    private val policy: EnvironmentRequestPolicy = EnvironmentRequestPolicy(
        isStaging = AppConfig.isStaging,
        apiBase = AppConfig.apiBase,
        fcmRegistrationEnabled = AppConfig.fcmRegistrationEnabled,
        mobileAnalyticsEnabled = AppConfig.mobileAnalyticsEnabled,
        paymentsEnabled = AppConfig.paymentsEnabled,
        supportEnabled = AppConfig.supportEnabled
    )
) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        val rejectionCode = policy.rejectionCode(request.url)
        if (rejectionCode != null) {
            throw IOException(rejectionCode)
        }
        return chain.proceed(request)
    }
}
