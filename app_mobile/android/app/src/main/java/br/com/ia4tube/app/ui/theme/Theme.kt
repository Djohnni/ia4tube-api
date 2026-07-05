package br.com.ia4tube.app.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val LightColors = lightColorScheme(
    primary = Color(0xFF16A34A),
    secondary = Color(0xFF2563EB),
    background = Color(0xFFF8FAFC),
    surface = Color.White,
    onPrimary = Color.White,
    onBackground = Color(0xFF0F172A),
    onSurface = Color(0xFF0F172A)
)

private val DarkColors = darkColorScheme(
    primary = Color(0xFF22C55E),
    secondary = Color(0xFF60A5FA),
    background = Color(0xFF0F172A),
    surface = Color(0xFF111827),
    onPrimary = Color(0xFF052E16),
    onBackground = Color(0xFFE5E7EB),
    onSurface = Color(0xFFE5E7EB)
)

@Composable
fun IA4TubeTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (isSystemInDarkTheme()) DarkColors else LightColors,
        content = content
    )
}
