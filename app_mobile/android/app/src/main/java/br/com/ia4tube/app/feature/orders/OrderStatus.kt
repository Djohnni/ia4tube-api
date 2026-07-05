package br.com.ia4tube.app.feature.orders

import br.com.ia4tube.app.data.models.OrderSummary

enum class OrderStatusBadge {
    Production,
    Ready,
    PaymentPending,
    Error
}

fun OrderSummary.isInProduction(): Boolean {
    if (isMonthlyPlanning) {
        return totalPosts > 0 && readyPosts < totalPosts && !hasErrorStatus()
    }
    return !imagemPronta && !hasErrorStatus()
}

fun OrderSummary.hasErrorStatus(): Boolean {
    if (isMonthlyPlanning) return errorPosts > 0
    return status.equals("erro", ignoreCase = true)
}

fun OrderSummary.statusBadges(): List<OrderStatusBadge> {
    return buildList {
        if (isMonthlyPlanning) {
            if (errorPosts > 0) add(OrderStatusBadge.Error)
            if (productionPosts > 0 || plannedPosts > 0) add(OrderStatusBadge.Production)
            if (readyPosts > 0) add(OrderStatusBadge.Ready)
        } else {
            if (hasErrorStatus()) add(OrderStatusBadge.Error)
            if (isInProduction()) add(OrderStatusBadge.Production)
            if (imagemPronta) add(OrderStatusBadge.Ready)
            if (pagamentoPendente) add(OrderStatusBadge.PaymentPending)
        }
    }
}
