package br.com.ia4tube.app.feature.calendar

import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.unit.dp

/** Local presentation only: do not change the app palette or calendar permissions. */
internal data class CalendarAppearance(
    val surface: Color,
    val content: Color,
    val secondary: Color,
    val action: Color,
    val error: Color
)

internal fun calendarContrastRatio(foreground: Color, background: Color): Float {
    val front = foreground.compositeOver(background).luminance()
    val back = background.luminance()
    return (maxOf(front, back) + 0.05f) / (minOf(front, back) + 0.05f)
}

private fun readableCalendarColor(preferred: Color, background: Color): Color {
    if (calendarContrastRatio(preferred, background) >= 4.5f) return preferred
    return if (calendarContrastRatio(Color.Black, background) >= calendarContrastRatio(Color.White, background))
        Color.Black else Color.White
}

internal fun calendarAppearance(colors: ColorScheme): CalendarAppearance = CalendarAppearance(
    surface = colors.surface,
    content = readableCalendarColor(colors.onSurface, colors.surface),
    secondary = readableCalendarColor(colors.onSurfaceVariant, colors.surface),
    action = readableCalendarColor(colors.primary, colors.surface),
    error = readableCalendarColor(colors.error, colors.surface)
)

@Composable
internal fun calendarTextButtonColors() = calendarAppearance(MaterialTheme.colorScheme).let {
    ButtonDefaults.textButtonColors(contentColor = it.action, disabledContentColor = it.secondary)
}

@Composable
internal fun calendarOutlinedButtonColors() = calendarAppearance(MaterialTheme.colorScheme).let {
    ButtonDefaults.outlinedButtonColors(contentColor = it.action, disabledContentColor = it.secondary)
}

@Composable
internal fun calendarTextFieldColors() = calendarAppearance(MaterialTheme.colorScheme).let {
    OutlinedTextFieldDefaults.colors(
        focusedTextColor = it.content, unfocusedTextColor = it.content, disabledTextColor = it.secondary,
        focusedLabelColor = it.action, unfocusedLabelColor = it.secondary, disabledLabelColor = it.secondary,
        focusedBorderColor = it.action, unfocusedBorderColor = it.secondary, disabledBorderColor = it.secondary,
        cursorColor = it.action,
        focusedContainerColor = it.surface, unfocusedContainerColor = it.surface, disabledContainerColor = it.surface
    )
}

@Composable
internal fun CalendarAlertDialog(
    onDismissRequest: () -> Unit,
    title: @Composable () -> Unit,
    text: @Composable () -> Unit,
    confirmButton: @Composable () -> Unit,
    dismissButton: (@Composable () -> Unit)? = null
) {
    val appearance = calendarAppearance(MaterialTheme.colorScheme)
    AlertDialog(
        onDismissRequest = onDismissRequest,
        containerColor = appearance.surface,
        titleContentColor = appearance.content,
        textContentColor = appearance.content,
        tonalElevation = 0.dp,
        title = title, text = text, confirmButton = confirmButton, dismissButton = dismissButton
    )
}
