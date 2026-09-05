package br.com.ia4tube.app.core.notifications

internal object FcmActivationPolicy {
    private const val ANDROID_13_API = 33

    fun shouldRequestSystemPermission(
        sdkInt: Int,
        explicitConsentGranted: Boolean,
        permissionGranted: Boolean
    ): Boolean {
        return explicitConsentGranted &&
            sdkInt >= ANDROID_13_API &&
            !permissionGranted
    }

    fun canActivate(
        sdkInt: Int,
        explicitConsentGranted: Boolean,
        permissionGranted: Boolean
    ): Boolean {
        return explicitConsentGranted &&
            (sdkInt < ANDROID_13_API || permissionGranted)
    }
}
