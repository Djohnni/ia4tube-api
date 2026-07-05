package br.com.ia4tube.app.feature.monthly_planning

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException
import java.time.format.TextStyle
import java.util.Locale

private const val GENERAL_CALENDAR_DAYS = 30
private val CalendarLocale = Locale("pt", "BR")
private val CalendarDateFormatter: DateTimeFormatter = DateTimeFormatter.ofPattern("dd/MM/yyyy", CalendarLocale)

data class MonthlyPlanningCalendarListItem(
    val key: String,
    val planningId: String = "",
    val planejamentoItemId: String = "",
    val date: String,
    val time: String,
    val dateLabel: String,
    val status: String,
    val title: String,
    val pedidoId: String,
    val imageReady: Boolean,
    val sortKey: String
)

@Composable
internal fun MonthlyPlanningCalendarList(
    title: String,
    items: List<MonthlyPlanningCalendarListItem>,
    loading: Boolean,
    emptyText: String,
    onOpenOrder: (String) -> Unit,
    onRemove: ((MonthlyPlanningCalendarListItem) -> Unit)? = null,
    onReschedule: ((MonthlyPlanningCalendarListItem, String) -> Unit)? = null,
    showNextThirtyDays: Boolean = false
) {
    var pendingRescheduleItem by remember { mutableStateOf<MonthlyPlanningCalendarListItem?>(null) }

    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(
            text = title,
            style = MaterialTheme.typography.titleLarge,
            fontWeight = FontWeight.ExtraBold
        )
        if (loading) {
            CircularProgressIndicator()
        }
        if (!loading && items.isEmpty() && !showNextThirtyDays) {
            Text(
                text = emptyText,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
        if (showNextThirtyDays) {
            buildNextThirtyCalendarDays(items).forEach { day ->
                MonthlyPlanningCalendarDayCard(
                    day = day,
                    onOpenOrder = onOpenOrder,
                    onRemove = onRemove,
                    onReschedule = if (onReschedule != null) {
                        { item: MonthlyPlanningCalendarListItem -> pendingRescheduleItem = item }
                    } else {
                        null
                    }
                )
            }
        } else {
            items.forEach { item ->
                MonthlyPlanningCalendarListCard(
                    item = item,
                    onOpenOrder = onOpenOrder,
                    onRemove = onRemove
                )
            }
        }
    }

    pendingRescheduleItem?.let { item ->
        MonthlyPlanningRescheduleDialog(
            item = item,
            onDismiss = { pendingRescheduleItem = null },
            onDateSelected = { newDate ->
                pendingRescheduleItem = null
                onReschedule?.invoke(item, newDate)
            }
        )
    }
}

private data class MonthlyPlanningCalendarDay(
    val dateLabel: String,
    val weekDayLabel: String,
    val posts: List<MonthlyPlanningCalendarListItem>
)

@Composable
private fun MonthlyPlanningCalendarDayCard(
    day: MonthlyPlanningCalendarDay,
    onOpenOrder: (String) -> Unit,
    onRemove: ((MonthlyPlanningCalendarListItem) -> Unit)?,
    onReschedule: ((MonthlyPlanningCalendarListItem) -> Unit)?
) {
    val hasPosts = day.posts.isNotEmpty()
    val shape = RoundedCornerShape(16.dp)
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .then(
                if (hasPosts) {
                    Modifier
                } else {
                    Modifier.border(
                        width = 1.dp,
                        color = MaterialTheme.colorScheme.outline.copy(alpha = 0.18f),
                        shape = shape
                    )
                }
            ),
        shape = shape,
        colors = CardDefaults.cardColors(
            containerColor = if (hasPosts) {
                MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.55f)
            } else {
                MaterialTheme.colorScheme.surface
            }
        )
    ) {
        Column(
            modifier = Modifier.padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column(
                    modifier = Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(2.dp)
                ) {
                    Text(
                        text = day.dateLabel,
                        style = MaterialTheme.typography.labelLarge,
                        fontWeight = FontWeight.Bold,
                        color = MaterialTheme.colorScheme.onSurface
                    )
                    Text(
                        text = day.weekDayLabel,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }

            if (!hasPosts) {
                Text(
                    text = "Sem arte planejada",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            } else {
                day.posts.forEachIndexed { index, item ->
                    if (index > 0) {
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(1.dp)
                                .clip(RoundedCornerShape(999.dp))
                                .background(MaterialTheme.colorScheme.outline.copy(alpha = 0.16f))
                        )
                    }
                    MonthlyPlanningCalendarDayPost(
                        item = item,
                        onOpenOrder = onOpenOrder,
                        onRemove = onRemove,
                        onReschedule = onReschedule
                    )
                }
            }
        }
    }
}

@Composable
private fun MonthlyPlanningCalendarDayPost(
    item: MonthlyPlanningCalendarListItem,
    onOpenOrder: (String) -> Unit,
    onRemove: ((MonthlyPlanningCalendarListItem) -> Unit)?,
    onReschedule: ((MonthlyPlanningCalendarListItem) -> Unit)?
) {
    val canOpenOrder = item.imageReady && item.pedidoId.isNotBlank()
    val rowModifier = if (canOpenOrder) {
        Modifier
            .fillMaxWidth()
            .clickable { onOpenOrder(item.pedidoId) }
    } else {
        Modifier.fillMaxWidth()
    }

    Column(
        modifier = rowModifier,
        verticalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = item.time.ifBlank { "Horario nao definido" },
                style = MaterialTheme.typography.labelLarge,
                fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.primary
            )
            Text(
                text = "Pronta",
                style = MaterialTheme.typography.bodySmall,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.primary
            )
        }
        Text(
            text = item.title,
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.SemiBold,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            color = MaterialTheme.colorScheme.onSurface
        )
        if (onReschedule != null || onRemove != null) {
            Row(
                modifier = Modifier.align(Alignment.End),
                horizontalArrangement = Arrangement.spacedBy(4.dp)
            ) {
                onReschedule?.let { reschedule ->
                    TextButton(onClick = { reschedule(item) }) {
                        Text("Alterar data")
                    }
                }
                onRemove?.let { remove ->
                    TextButton(onClick = { remove(item) }) {
                        Text("Remover")
                    }
                }
            }
        }
    }
}

@Composable
private fun MonthlyPlanningCalendarListCard(
    item: MonthlyPlanningCalendarListItem,
    onOpenOrder: (String) -> Unit,
    onRemove: ((MonthlyPlanningCalendarListItem) -> Unit)?
) {
    val canOpenOrder = item.imageReady && item.pedidoId.isNotBlank()
    val cardModifier = if (canOpenOrder) {
        Modifier
            .fillMaxWidth()
            .clickable { onOpenOrder(item.pedidoId) }
    } else {
        Modifier.fillMaxWidth()
    }

    Card(
        modifier = cardModifier,
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.55f))
    ) {
        Column(
            modifier = Modifier.padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = item.dateLabel.ifBlank { "Data não definida" },
                    style = MaterialTheme.typography.labelLarge,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.onSurface
                )
                Text(
                    text = item.status.ifBlank { "Planejada" },
                    style = MaterialTheme.typography.bodySmall,
                    fontWeight = FontWeight.SemiBold,
                    color = if (item.status.equals("Pronta", ignoreCase = true)) {
                        MaterialTheme.colorScheme.primary
                    } else {
                        MaterialTheme.colorScheme.onSurfaceVariant
                    }
                )
            }
            Text(
                text = item.title,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.SemiBold,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                color = MaterialTheme.colorScheme.onSurface
            )
            onRemove?.let { remove ->
                TextButton(
                    modifier = Modifier.align(Alignment.End),
                    onClick = { remove(item) }
                ) {
                    Text("Remover")
                }
            }
        }
    }
}

internal fun MonthlyPlanningPost.toCalendarListItem(planningId: String = ""): MonthlyPlanningCalendarListItem {
    val effectivePlanningId = planningId.ifBlank { this.planningId }
    val effectiveItemId = planejamentoItemId.ifBlank { itemId }.ifBlank { pedidoId }.ifBlank { number.toString() }
    val key = listOf(effectivePlanningId, effectiveItemId)
        .filter { it.isNotBlank() }
        .joinToString(":")
        .ifBlank { itemId.ifBlank { number.toString() } }
    return MonthlyPlanningCalendarListItem(
        key = key,
        planningId = effectivePlanningId,
        planejamentoItemId = planejamentoItemId.ifBlank { itemId },
        date = date,
        time = time,
        dateLabel = dateLabel,
        status = status,
        title = calendarPostTitle(number, imageText, theme, objective),
        pedidoId = pedidoId,
        imageReady = imageReady,
        sortKey = listOf(date, time, number.toString().padStart(4, '0')).joinToString("|")
    )
}

@Composable
private fun MonthlyPlanningRescheduleDialog(
    item: MonthlyPlanningCalendarListItem,
    onDismiss: () -> Unit,
    onDateSelected: (String) -> Unit
) {
    val days = remember { buildNextThirtyCalendarDateOptions() }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text(
                text = "Alterar data",
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.ExtraBold
            )
        },
        text = {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(max = 380.dp)
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(4.dp)
            ) {
                Text(
                    text = item.title,
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    color = MaterialTheme.colorScheme.onSurface
                )
                days.forEach { date ->
                    val selected = date.toString() == item.date
                    TextButton(
                        modifier = Modifier.fillMaxWidth(),
                        onClick = { onDateSelected(date.toString()) }
                    ) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Text(
                                text = date.format(CalendarDateFormatter),
                                fontWeight = if (selected) FontWeight.Bold else FontWeight.Medium
                            )
                            Text(
                                text = date.dayOfWeek.getDisplayName(TextStyle.FULL, CalendarLocale),
                                style = MaterialTheme.typography.bodySmall
                            )
                        }
                    }
                }
            }
        },
        confirmButton = {},
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("Cancelar")
            }
        }
    )
}

private fun calendarPostTitle(
    number: Int,
    imageText: String,
    theme: String,
    objective: String
): String {
    val source = imageText
        .ifBlank { theme }
        .ifBlank { objective }
        .ifBlank { "Postagem $number" }
    return firstWords(stripImageTextPrefix(source), 6).ifBlank { "Postagem $number" }
}

private fun stripImageTextPrefix(value: String): String {
    val marker = "Escrita que deve aparecer na imagem:"
    return value.trim().substringAfter(marker, value).trim()
}

private fun firstWords(value: String, maxWords: Int): String {
    return value
        .trim()
        .split(Regex("\\s+"))
        .filter { it.isNotBlank() }
        .take(maxWords)
        .joinToString(" ")
}

private fun buildNextThirtyCalendarDays(
    items: List<MonthlyPlanningCalendarListItem>
): List<MonthlyPlanningCalendarDay> {
    val today = LocalDate.now()
    val days = buildNextThirtyCalendarDateOptions(today)
    val itemsByDate = items
        .mapNotNull { item -> item.toDatedCalendarItem() }
        .filter { (date, _) -> !date.isBefore(today) && date.isBefore(today.plusDays(GENERAL_CALENDAR_DAYS.toLong())) }
        .groupBy(
            keySelector = { it.first },
            valueTransform = { it.second }
        )

    return days.map { date ->
        MonthlyPlanningCalendarDay(
            dateLabel = date.format(CalendarDateFormatter),
            weekDayLabel = date.dayOfWeek.getDisplayName(TextStyle.FULL, CalendarLocale),
            posts = itemsByDate[date]
                .orEmpty()
                .sortedWith(compareBy<MonthlyPlanningCalendarListItem> { it.time.ifBlank { "99:99" } }.thenBy { it.title })
        )
    }
}

private fun buildNextThirtyCalendarDateOptions(today: LocalDate = LocalDate.now()): List<LocalDate> {
    return (0 until GENERAL_CALENDAR_DAYS).map { today.plusDays(it.toLong()) }
}

private fun MonthlyPlanningCalendarListItem.toDatedCalendarItem(): Pair<LocalDate, MonthlyPlanningCalendarListItem>? {
    return try {
        LocalDate.parse(date) to this
    } catch (_: DateTimeParseException) {
        null
    }
}
