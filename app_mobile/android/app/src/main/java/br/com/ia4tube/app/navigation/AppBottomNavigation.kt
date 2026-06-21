package br.com.ia4tube.app.navigation

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.AddCircle
import androidx.compose.material.icons.filled.Home
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import br.com.ia4tube.app.R
import br.com.ia4tube.app.feature.orders.OrderListFilter

@Composable
fun AppBottomNavigation(
    currentRoute: String?,
    onNavigate: (String) -> Unit
) {
    if (!shouldShowBottomNavigation(currentRoute)) return

    val selectedColor = MaterialTheme.colorScheme.primary
    val unselectedColor = MaterialTheme.colorScheme.onSurfaceVariant
    val itemColors = NavigationBarItemDefaults.colors(
        selectedIconColor = MaterialTheme.colorScheme.onPrimary,
        selectedTextColor = selectedColor,
        indicatorColor = selectedColor,
        unselectedIconColor = unselectedColor,
        unselectedTextColor = unselectedColor
    )

    NavigationBar(
        containerColor = MaterialTheme.colorScheme.background,
        contentColor = selectedColor,
        tonalElevation = 0.dp
    ) {
        NavigationBarItem(
            selected = currentRoute == Routes.Home,
            onClick = { onNavigate(Routes.Home) },
            colors = itemColors,
            icon = {
                Icon(
                    imageVector = Icons.Filled.Home,
                    contentDescription = stringResource(R.string.nav_home)
                )
            },
            label = { Text(stringResource(R.string.nav_home)) }
        )
        NavigationBarItem(
            selected = currentRoute == Routes.CreateArtEmpresa,
            onClick = { onNavigate(Routes.createArtEmpresa()) },
            colors = itemColors,
            icon = {
                Icon(
                    imageVector = Icons.Filled.AddCircle,
                    contentDescription = stringResource(R.string.nav_create)
                )
            },
            label = { Text(stringResource(R.string.nav_create)) }
        )
        NavigationBarItem(
            selected = currentRoute == Routes.Orders,
            onClick = { onNavigate(Routes.orders(OrderListFilter.All)) },
            colors = itemColors,
            icon = {
                Icon(
                    imageVector = Icons.AutoMirrored.Filled.List,
                    contentDescription = stringResource(R.string.nav_orders)
                )
            },
            label = { Text(stringResource(R.string.nav_orders)) }
        )
    }
}

private fun shouldShowBottomNavigation(route: String?): Boolean {
    return route == Routes.Home ||
        route == Routes.CreateArtEmpresa ||
        route == Routes.Orders
}
