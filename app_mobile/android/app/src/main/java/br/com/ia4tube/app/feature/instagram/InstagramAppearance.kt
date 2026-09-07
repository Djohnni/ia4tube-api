package br.com.ia4tube.app.feature.instagram

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.luminance

/** Keep the selected palette when its foreground is readable; otherwise use an opaque fallback. */
internal fun instagramReadableForeground(preferred: Color, background: Color): Color {
    if (instagramContrastRatio(preferred, background) >= 4.5f) return preferred
    return if (instagramContrastRatio(Color.Black, background) >=
        instagramContrastRatio(Color.White, background)) Color.Black else Color.White
}

internal fun instagramContrastRatio(foreground: Color, background: Color): Float {
    val foregroundLuminance = foreground.compositeOver(background).luminance()
    val backgroundLuminance = background.luminance()
    return (maxOf(foregroundLuminance, backgroundLuminance) + 0.05f) /
        (minOf(foregroundLuminance, backgroundLuminance) + 0.05f)
}

internal fun instagramUsesStackedHeader(availableWidthDp: Float, fontScale: Float): Boolean =
    availableWidthDp < 360f || fontScale >= 1.3f
