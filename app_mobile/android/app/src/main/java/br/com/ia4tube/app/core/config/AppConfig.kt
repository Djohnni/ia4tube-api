package br.com.ia4tube.app.core.config

import br.com.ia4tube.app.BuildConfig

object AppConfig {
    val apiBase: String = BuildConfig.API_BASE.trimEnd('/')
    val productDiscoveryApiBase: String = BuildConfig.PRODUCT_DISCOVERY_API_BASE.trimEnd('/')
    val playStoreUrl: String = BuildConfig.PLAY_STORE_URL
    val supportUrl: String = BuildConfig.SUPPORT_URL
    val isStaging: Boolean = BuildConfig.IS_STAGING
    val fcmRegistrationEnabled: Boolean = BuildConfig.FCM_REGISTRATION_ENABLED
    val notificationsEnabled: Boolean = BuildConfig.NOTIFICATIONS_ENABLED
    val mobileAnalyticsEnabled: Boolean = BuildConfig.MOBILE_ANALYTICS_ENABLED
    val paymentsEnabled: Boolean = BuildConfig.PAYMENTS_ENABLED
    val supportEnabled: Boolean = BuildConfig.SUPPORT_ENABLED
    val appUpdateEnabled: Boolean = BuildConfig.APP_UPDATE_ENABLED
}
