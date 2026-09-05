package br.com.ia4tube.app.core.notifications

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FcmActivationPolicyTest {
    @Test
    fun android14RequiresExplicitConsentBeforeSystemPermission() {
        assertFalse(
            FcmActivationPolicy.shouldRequestSystemPermission(
                sdkInt = 34,
                explicitConsentGranted = false,
                permissionGranted = false
            )
        )
        assertTrue(
            FcmActivationPolicy.shouldRequestSystemPermission(
                sdkInt = 34,
                explicitConsentGranted = true,
                permissionGranted = false
            )
        )
    }

    @Test
    fun activationRequiresConsentAndApplicablePermission() {
        assertFalse(
            FcmActivationPolicy.canActivate(
                sdkInt = 34,
                explicitConsentGranted = false,
                permissionGranted = true
            )
        )
        assertFalse(
            FcmActivationPolicy.canActivate(
                sdkInt = 34,
                explicitConsentGranted = true,
                permissionGranted = false
            )
        )
        assertTrue(
            FcmActivationPolicy.canActivate(
                sdkInt = 32,
                explicitConsentGranted = true,
                permissionGranted = false
            )
        )
    }
}
