package br.com.ia4tube.app.core.notifications

internal object FcmActivationPolicy {
    private const val ANDROID_13_API = 33

    fun shouldRequestPermission(
        fcmRegistrationEnabled: Boolean,
        notificationsEnabled: Boolean,
        sdkInt: Int,
        permissionGranted: Boolean
    ): Boolean {
        return fcmRegistrationEnabled &&
            notificationsEnabled &&
            sdkInt >= ANDROID_13_API &&
            !permissionGranted
    }

    fun shouldActivate(
        fcmRegistrationEnabled: Boolean,
        notificationsEnabled: Boolean,
        sdkInt: Int,
        permissionGranted: Boolean
    ): Boolean {
        return fcmRegistrationEnabled &&
            notificationsEnabled &&
            (sdkInt < ANDROID_13_API || permissionGranted)
    }
}
