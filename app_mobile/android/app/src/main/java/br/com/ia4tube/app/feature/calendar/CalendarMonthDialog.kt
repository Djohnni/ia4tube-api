package br.com.ia4tube.app.feature.calendar

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
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
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import java.time.Instant
import java.time.LocalDate
import java.time.YearMonth
import java.time.format.DateTimeFormatter
import java.util.Locale

/** A local overview of the already-loaded calendar; it never submits or changes a publication. */
@Composable
internal fun CalendarMonthDialog(items: List<ScheduledArt>, fresh: Boolean, busy: Boolean,
    onDismiss: () -> Unit) {
    val today = remember { LocalDate.now(CalendarPresentationZone) }
    var month by remember { mutableStateOf(YearMonth.from(today)) }
    var selectedDay by remember { mutableStateOf<LocalDate?>(today) }
    val grouped = remember(items) { calendarMonthItems(items, Instant.now()) }
    val cells = remember(month) { calendarMonthCells(month) }
    val locale = remember { Locale("pt", "BR") }
    val dateFormat = remember { DateTimeFormatter.ofPattern("dd/MM/yyyy", locale) }
    val monthFormat = remember { DateTimeFormatter.ofPattern("MMMM 'de' yyyy", locale) }
    val appearance = calendarAppearance(MaterialTheme.colorScheme)
    val compactWeekdays = LocalDensity.current.fontScale > 1.4f

    CalendarAlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Seu calendário", fontWeight = FontWeight.Bold) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = { month = month.minusMonths(1); selectedDay = null }) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, "Mês anterior", tint = appearance.action)
                    }
                    Text(month.format(monthFormat).replaceFirstChar { it.titlecase(locale) },
                        modifier = Modifier.weight(1f), textAlign = TextAlign.Center,
                        style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                    IconButton(onClick = { month = month.plusMonths(1); selectedDay = null }) {
                        Icon(Icons.AutoMirrored.Filled.ArrowForward, "Próximo mês", tint = appearance.action)
                    }
                }
                Row(Modifier.fillMaxWidth()) {
                    listOf("Domingo", "Segunda-feira", "Terça-feira", "Quarta-feira", "Quinta-feira", "Sexta-feira", "Sábado").forEach { weekday ->
                        Text(if (compactWeekdays) weekday.take(1) else weekday.take(3),
                            modifier = Modifier.weight(1f).semantics { contentDescription = weekday },
                            textAlign = TextAlign.Center, maxLines = 1,
                            style = MaterialTheme.typography.labelSmall, color = appearance.secondary)
                    }
                }
                Column {
                    cells.chunked(7).forEach { week ->
                        Row(Modifier.fillMaxWidth()) {
                            week.forEach { day ->
                                if (day == null) Spacer(Modifier.weight(1f).heightIn(min = 48.dp))
                                else {
                                    val count = grouped[day].orEmpty().size
                                    val selected = selectedDay == day
                                    val ring = if (selected || day == today)
                                        BorderStroke(if (selected) 2.dp else 1.dp, appearance.action) else null
                                    Box(modifier = Modifier.weight(1f).heightIn(min = 48.dp).padding(1.dp)
                                        .then(if (ring != null) Modifier.border(ring, CircleShape) else Modifier)
                                        .selectable(selected = selected, role = Role.Button, onClick = { selectedDay = day })
                                        .semantics(mergeDescendants = true) {
                                            contentDescription = "${day.format(dateFormat)}, $count " +
                                                (if (count == 1) "publicação" else "publicações") +
                                                (if (day == today) ", hoje" else "")
                                        }, contentAlignment = Alignment.Center) {
                                        if (count > 0) Box(Modifier.matchParentSize().padding(4.dp)
                                            .background(appearance.action, CircleShape))
                                        Text(day.dayOfMonth.toString(),
                                            color = if (count > 0) appearance.surface else appearance.content,
                                            fontWeight = if (count > 0) FontWeight.Bold else FontWeight.Normal,
                                            style = MaterialTheme.typography.bodyMedium)
                                    }
                                }
                            }
                        }
                    }
                }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Box(Modifier.size(10.dp).background(appearance.action, CircleShape))
                    Text("Dias com publicações", style = MaterialTheme.typography.bodySmall, color = appearance.secondary)
                }
                if (busy) Text("Atualizando calendário…", style = MaterialTheme.typography.bodySmall,
                    color = appearance.secondary)
                else if (!fresh) Text("Exibindo a última consulta. Atualize para conferir.",
                    style = MaterialTheme.typography.bodySmall, color = appearance.secondary)

                val day = selectedDay
                if (day == null) Text("Toque em um dia.", style = MaterialTheme.typography.bodySmall,
                    color = appearance.secondary)
                else {
                    val selectedItems = grouped[day].orEmpty()
                    Text(day.format(dateFormat), style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.SemiBold)
                    if (selectedItems.isNotEmpty()) {
                        Text("${selectedItems.size} " + if (selectedItems.size == 1) "publicação" else "publicações",
                            style = MaterialTheme.typography.bodySmall, color = appearance.secondary)
                        selectedItems.forEach { item ->
                            val heading = item.caption.lineSequence().firstOrNull { it.isNotBlank() }?.trim()
                                ?: item.title.takeIf { it.isNotBlank() } ?: "Publicação"
                            Column(Modifier.fillMaxWidth().padding(vertical = 4.dp),
                                verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                Text("${item.time} · $heading", fontWeight = FontWeight.SemiBold,
                                    style = MaterialTheme.typography.bodyMedium, maxLines = 2,
                                    overflow = TextOverflow.Ellipsis)
                                if (item.statusLabel.isNotBlank()) Text(item.statusLabel,
                                    style = MaterialTheme.typography.bodySmall, color = appearance.secondary)
                            }
                        }
                    } else Text(when {
                        busy -> "Carregando publicações…"
                        !fresh -> "Atualize para conferir este dia."
                        else -> "Nenhuma publicação neste dia."
                    }, style = MaterialTheme.typography.bodySmall, color = appearance.secondary)
                }
            }
        },
        confirmButton = {
            TextButton(colors = calendarTextButtonColors(), onClick = onDismiss) { Text("Fechar") }
        }
    )
}
