package br.com.ia4tube.app.feature.orders

import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import br.com.ia4tube.app.R
import br.com.ia4tube.app.data.models.OrderSummary
import br.com.ia4tube.app.ui.components.ScreenScaffold
import br.com.ia4tube.app.ui.text.asString
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.TimeZone

@Composable
fun OrdersScreen(
    viewModel: OrdersViewModel,
    initialFilter: OrderListFilter,
    onBack: () -> Unit,
    onOpenOrder: (String) -> Unit,
    onOpenMonthlyPlanning: (String) -> Unit = {}
) {
    val state by viewModel.uiState.collectAsState()
    val listState = rememberLazyListState()
    var pullDistance by remember { mutableStateOf(0f) }
    var selectedFilter by remember(initialFilter) { mutableStateOf(initialFilter) }
    val filteredOrders = selectedFilter.apply(state.pedidos)

    ScreenScaffold {
        Column(modifier = Modifier.fillMaxSize()) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(stringResource(R.string.orders_title), style = MaterialTheme.typography.headlineSmall)
                Row {
                    OutlinedButton(
                        enabled = !state.loading && !state.refreshing,
                        onClick = viewModel::refreshManual
                    ) {
                        Text(stringResource(R.string.common_update))
                    }
                    OutlinedButton(onClick = onBack) {
                        Text(stringResource(R.string.common_back))
                    }
                }
            }

            Spacer(modifier = Modifier.height(16.dp))
            FilterChips(
                selectedFilter = selectedFilter,
                onSelect = { selectedFilter = it }
            )
            Spacer(modifier = Modifier.height(12.dp))

            when {
                state.loading -> CircularProgressIndicator()
                state.error != null && state.pedidos.isEmpty() -> {
                    state.error?.let { error ->
                        ErrorState(
                            message = error.asString(),
                            onRetry = viewModel::refreshManual
                        )
                    }
                }
                else -> Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .pointerInput(state.refreshing, state.loading, listState.firstVisibleItemIndex) {
                            detectVerticalDragGestures(
                                onDragEnd = {
                                    if (
                                        pullDistance > 120f &&
                                        listState.firstVisibleItemIndex == 0 &&
                                        !state.refreshing &&
                                        !state.loading
                                    ) {
                                        viewModel.refreshManual()
                                    }
                                    pullDistance = 0f
                                },
                                onDragCancel = { pullDistance = 0f },
                                onVerticalDrag = { _, dragAmount ->
                                    if (listState.firstVisibleItemIndex == 0 && dragAmount > 0f) {
                                        pullDistance += dragAmount
                                    }
                                }
                            )
                        }
                ) {
                    if (state.refreshing) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            CircularProgressIndicator()
                            Spacer(modifier = Modifier.width(10.dp))
                            Text(stringResource(R.string.orders_updating))
                        }
                        Spacer(modifier = Modifier.height(12.dp))
                    }

                    when {
                        filteredOrders.isEmpty() -> EmptyState(message = stringResource(selectedFilter.emptyMessageRes))
                        else -> LazyColumn(
                            state = listState,
                            verticalArrangement = Arrangement.spacedBy(12.dp)
                        ) {
                            state.error?.let { error ->
                                item {
                                    Text(error.asString(), color = MaterialTheme.colorScheme.error)
                                }
                            }
                            items(filteredOrders, key = { it.id }) { pedido ->
                                OrderSummaryCard(
                                    pedido = pedido,
                                    onClick = {
                                        if (pedido.isMonthlyPlanning) {
                                            onOpenMonthlyPlanning(pedido.planningId.ifBlank { pedido.id })
                                        } else {
                                            onOpenOrder(pedido.id)
                                        }
                                    }
                                )
                            }
                            item {
                                Spacer(modifier = Modifier.height(24.dp))
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun FilterChips(
    selectedFilter: OrderListFilter,
    onSelect: (OrderListFilter) -> Unit
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
    ) {
        OrderListFilter.entries.forEach { filter ->
            FilterChip(
                selected = filter == selectedFilter,
                onClick = { onSelect(filter) }
                ,
                label = { Text(stringResource(filter.labelRes)) },
                colors = FilterChipDefaults.filterChipColors(
                    selectedContainerColor = MaterialTheme.colorScheme.primaryContainer,
                    selectedLabelColor = MaterialTheme.colorScheme.onPrimaryContainer
                )
            )
            Spacer(modifier = Modifier.width(8.dp))
        }
    }
}

@Composable
private fun EmptyState(message: String) {
    Column(modifier = Modifier.fillMaxSize()) {
        Text(
            text = message,
            style = MaterialTheme.typography.titleMedium
        )
    }
}

@Composable
private fun ErrorState(
    message: String,
    onRetry: () -> Unit
) {
    Column(modifier = Modifier.fillMaxWidth()) {
        Text(message, color = MaterialTheme.colorScheme.error)
        Spacer(modifier = Modifier.height(10.dp))
        OutlinedButton(onClick = onRetry) {
            Text(stringResource(R.string.common_retry))
        }
    }
}

@Composable
private fun OrderSummaryCard(
    pedido: OrderSummary,
    onClick: () -> Unit
) {
    if (pedido.isMonthlyPlanning) {
        MonthlyPlanningSummaryCard(pedido = pedido, onClick = onClick)
        return
    }

    val orderDateLabel = remember(pedido.id, pedido.createdAt) {
        formatOrderDateLabel(pedido.createdAt, pedido.id)
    }

    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp)
        ) {
            if (orderDateLabel == null) {
                Text(stringResource(R.string.orders_id, pedido.id), style = MaterialTheme.typography.titleMedium)
                StatusBadgesRow(badges = pedido.statusBadges())
                Spacer(modifier = Modifier.height(8.dp))
                Text(stringResource(R.string.orders_product, pedido.tipo.ifBlank { stringResource(R.string.orders_default_type) }))
                Text(stringResource(R.string.orders_status, pedido.status.ifBlank { stringResource(R.string.orders_default_status) }))
                Text(stringResource(R.string.orders_image_ready, yesNo(pedido.imagemPronta)))
                Text(stringResource(R.string.orders_payment_pending, yesNo(pedido.pagamentoPendente)))
            } else {
                val tipo = pedido.tipo.ifBlank { stringResource(R.string.orders_default_type) }
                val status = pedido.status.ifBlank { stringResource(R.string.orders_default_status) }

                Text(orderDateLabel, style = MaterialTheme.typography.titleMedium)
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    text = "$tipo • $status",
                    style = MaterialTheme.typography.bodyMedium
                )
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    text = "Pedido #${pedido.id}",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.labelMedium
                )
                StatusBadgesRow(badges = pedido.statusBadges())
            }
        }
    }
}

@Composable
private fun MonthlyPlanningSummaryCard(
    pedido: OrderSummary,
    onClick: () -> Unit
) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.42f))
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            Text(
                text = pedido.title.ifBlank { "Planejamento Mensal" },
                style = MaterialTheme.typography.titleMedium
            )
            Text("${pedido.totalPosts} postagens")
            Text("${pedido.readyPosts} prontas")
            if (pedido.productionPosts > 0) {
                Text("${pedido.productionPosts} em producao")
            }
            if (pedido.plannedPosts > 0) {
                Text("${pedido.plannedPosts} planejadas")
            }
            if (pedido.errorPosts > 0) {
                Text("${pedido.errorPosts} com erro", color = MaterialTheme.colorScheme.error)
            }
            StatusBadgesRow(badges = pedido.statusBadges())
        }
    }
}

@Composable
private fun StatusBadgesRow(badges: List<OrderStatusBadge>) {
    if (badges.isEmpty()) return

    Row(
        modifier = Modifier.horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        badges.forEach { badge ->
            StatusBadge(badge = badge)
        }
    }
}

@Composable
private fun StatusBadge(badge: OrderStatusBadge) {
    val colors = badgeColors(badge)
    Text(
        text = stringResource(badge.labelRes()),
        color = colors.foreground,
        modifier = Modifier
            .background(colors.background, RoundedCornerShape(8.dp))
            .padding(horizontal = 10.dp, vertical = 5.dp),
        style = MaterialTheme.typography.labelMedium
    )
}

@Composable
private fun badgeColors(badge: OrderStatusBadge): BadgeColors {
    val scheme = MaterialTheme.colorScheme
    return when (badge) {
        OrderStatusBadge.Production -> BadgeColors(scheme.secondaryContainer, scheme.onSecondaryContainer)
        OrderStatusBadge.Ready -> BadgeColors(scheme.primaryContainer, scheme.onPrimaryContainer)
        OrderStatusBadge.PaymentPending -> BadgeColors(scheme.tertiaryContainer, scheme.onTertiaryContainer)
        OrderStatusBadge.Error -> BadgeColors(scheme.errorContainer, scheme.onErrorContainer)
    }
}

private fun OrderStatusBadge.labelRes(): Int {
    return when (this) {
        OrderStatusBadge.Production -> R.string.orders_filter_production
        OrderStatusBadge.Ready -> R.string.orders_badge_ready
        OrderStatusBadge.PaymentPending -> R.string.orders_filter_payment_pending
        OrderStatusBadge.Error -> R.string.orders_badge_error
    }
}

@Composable
private fun yesNo(value: Boolean): String = stringResource(if (value) R.string.common_yes else R.string.common_no)

private data class BadgeColors(
    val background: Color,
    val foreground: Color
)

private val orderIdDateRegex = Regex("""^\d{8}_\d{6}$""")

private fun formatOrderDateLabel(createdAt: String, orderId: String): String? {
    val date = parseCreatedAtDate(createdAt) ?: parseOrderIdDate(orderId) ?: return null
    return formatBrazilDateLabel(date)
}

private fun parseOrderIdDate(orderId: String): Date? {
    if (!orderIdDateRegex.matches(orderId)) return null
    val parser = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).apply {
        isLenient = false
        timeZone = TimeZone.getTimeZone("America/Sao_Paulo")
    }
    return runCatching { parser.parse(orderId) }.getOrNull()
}

private fun parseCreatedAtDate(createdAt: String): Date? {
    val value = createdAt.trim()
    if (value.isBlank()) return null
    val patterns = listOf(
        "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
        "yyyy-MM-dd'T'HH:mm:ss'Z'",
        "yyyy-MM-dd'T'HH:mm:ss.SSSXXX",
        "yyyy-MM-dd'T'HH:mm:ssXXX"
    )
    return patterns.firstNotNullOfOrNull { pattern ->
        runCatching {
            SimpleDateFormat(pattern, Locale.US).apply {
                isLenient = false
                if (pattern.endsWith("'Z'")) {
                    timeZone = TimeZone.getTimeZone("UTC")
                }
            }.parse(value)
        }.getOrNull()
    }
}

private fun formatBrazilDateLabel(date: Date): String {
    val saoPaulo = TimeZone.getTimeZone("America/Sao_Paulo")
    val pedidoCalendar = Calendar.getInstance(saoPaulo).apply { time = date }
    val today = Calendar.getInstance(saoPaulo)
    val yesterday = Calendar.getInstance(saoPaulo).apply {
        add(Calendar.DAY_OF_YEAR, -1)
    }
    val ptBr = Locale("pt", "BR")
    val time = SimpleDateFormat("HH:mm", ptBr).apply {
        timeZone = saoPaulo
    }.format(date)

    return when {
        isSameDay(pedidoCalendar, today) -> "Hoje às $time"
        isSameDay(pedidoCalendar, yesterday) -> "Ontem às $time"
        else -> "${SimpleDateFormat("dd/MM/yyyy", ptBr).apply { timeZone = saoPaulo }.format(date)} às $time"
    }
}

private fun isSameDay(first: Calendar, second: Calendar): Boolean {
    return first.get(Calendar.YEAR) == second.get(Calendar.YEAR) &&
        first.get(Calendar.DAY_OF_YEAR) == second.get(Calendar.DAY_OF_YEAR)
}
