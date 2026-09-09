package br.com.ia4tube.app.navigation

import androidx.navigation.NavBackStackEntry
import androidx.navigation.NavController

/** Only the current Home can open the shortcut; a second queued tap cannot stack galleries. */
internal fun NavController.openPlannedArts(entry: NavBackStackEntry, authenticated: Boolean,
    onAuthRequired: () -> Unit): Boolean {
    if (entry.destination.route != Routes.Home || currentBackStackEntry !== entry) return false
    if (!authenticated) {
        onAuthRequired()
        return false
    }
    navigate(Routes.PlannedArts) { launchSingleTop = true }
    return true
}

/** Repeated or stale gallery Back events cannot pop Home or another destination. */
internal fun NavController.leavePlannedArts(entry: NavBackStackEntry): Boolean {
    if (entry.destination.route != Routes.PlannedArts || currentBackStackEntry !== entry) return false
    return popBackStack()
}
