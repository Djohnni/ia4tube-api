package br.com.ia4tube.app.core.notifications

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FcmActivationPolicyTest {
    @Test
    fun android14RequestsPermissionAndDoesNotActivateBeforeConsent() {
        assertTrue(
            FcmActivationPolicy.shouldRequestPermission(
                fcmRegistrationEnabled = true,
                notificationsEnabled = true,
                sdkInt = 34,
                permissionGranted = false
            )
        )
        assertFalse(
            FcmActivationPolicy.shouldActivate(
                fcmRegistrationEnabled = true,
                notificationsEnabled = true,
                sdkInt = 34,
                permissionGranted = false
            )
        )
    }

    @Test
    fun android14ActivatesOnlyAfterConsent() {
        assertFalse(
            FcmActivationPolicy.shouldRequestPermission(
                fcmRegistrationEnabled = true,
                notificationsEnabled = true,
                sdkInt = 34,
                permissionGranted = true
            )
        )
        assertTrue(
            FcmActivationPolicy.shouldActivate(
                fcmRegistrationEnabled = true,
                notificationsEnabled = true,
                sdkInt = 34,
                permissionGranted = true
            )
        )
    }

    @Test
    fun disabledFlagsAlwaysBlockActivation() {
        assertFalse(
            FcmActivationPolicy.shouldActivate(
                fcmRegistrationEnabled = false,
                notificationsEnabled = true,
                sdkInt = 34,
                permissionGranted = true
            )
        )
        assertFalse(
            FcmActivationPolicy.shouldActivate(
                fcmRegistrationEnabled = true,
                notificationsEnabled = false,
                sdkInt = 34,
                permissionGranted = true
            )
        )
    }
}
