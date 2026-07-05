package br.com.ia4tube.app.navigation

import android.net.Uri
import br.com.ia4tube.app.feature.orders.OrderListFilter

object Routes {
    const val Splash = "splash"
    const val Login = "login"
    const val Register = "register"
    const val AuthRequired = "auth-required"
    const val Home = "home"
    const val Orders = "orders?filter={filter}"
    const val OrderDetail = "orders/{pedidoId}"
    const val CreateArtEmpresa = "create-art/empresa?photoUri={photoUri}"
    const val Carousel = "carousel"
    const val MonthlyPlanning = "monthly-planning"
    const val MonthlyPlanningDetail = "monthly-planning/{planningId}"
    const val CompanyProfile = "company-profile"
    const val Support = "support"
    const val Plans = "plans"

    fun orders(filter: OrderListFilter = OrderListFilter.All): String = "orders?filter=${filter.routeValue}"
    fun orderDetail(pedidoId: String): String = "orders/$pedidoId"
    fun monthlyPlanningDetail(planningId: String): String = "monthly-planning/$planningId"
    fun createArtEmpresa(photoUri: String = ""): String {
        return if (photoUri.isBlank()) {
            "create-art/empresa"
        } else {
            "create-art/empresa?photoUri=${Uri.encode(photoUri)}"
        }
    }
}
