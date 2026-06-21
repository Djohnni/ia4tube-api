package br.com.ia4tube.app.feature.orders

import br.com.ia4tube.app.data.models.OrderSummary
import br.com.ia4tube.app.R

enum class OrderListFilter(
    val routeValue: String,
    val labelRes: Int,
    val emptyMessageRes: Int
) {
    All(
        routeValue = "todos",
        labelRes = R.string.orders_filter_all,
        emptyMessageRes = R.string.orders_empty_all
    ),
    Production(
        routeValue = "producao",
        labelRes = R.string.orders_filter_production,
        emptyMessageRes = R.string.orders_empty_production
    ),
    Ready(
        routeValue = "prontas",
        labelRes = R.string.orders_filter_ready,
        emptyMessageRes = R.string.orders_empty_ready
    ),
    PaymentPending(
        routeValue = "pagamento",
        labelRes = R.string.orders_filter_payment_pending,
        emptyMessageRes = R.string.orders_empty_payment_pending
    );

    fun apply(orders: List<OrderSummary>): List<OrderSummary> {
        return when (this) {
            All -> orders
            Production -> orders.filter { it.isInProduction() }
            Ready -> orders.filter { it.imagemPronta }
            PaymentPending -> orders.filter { it.pagamentoPendente }
        }
    }

    companion object {
        fun fromRoute(value: String?): OrderListFilter {
            return entries.firstOrNull { it.routeValue == value } ?: All
        }
    }
}
